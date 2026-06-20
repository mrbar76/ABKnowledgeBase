#!/usr/bin/env node
// Rebuild daily_context to reclaim 8 tombstoned attribute slots.
//
// Why: the table went through an add → drop → re-add design shuttle
// (day_type, energy_rating, hunger_rating, recovery_rating,
// body_weight_lb, cravings, digestion, tags), each leaving a permanent
// Postgres attribute-slot tombstone against the 1600-column ceiling.
// The only way to actually reclaim them is to rebuild the table.
//
// Strategy: inside one transaction, CREATE a parallel daily_context_v2
// with only the live columns, INSERT every row from the old table,
// assert row count + checksum match, DROP the old table, RENAME the new
// one in, then recreate the search trigger.
//
// If any assertion fails or any step errors, the transaction rolls back
// and the old table is intact. The script is idempotent: re-running it
// after a successful rebuild is a no-op (zero tombstones → bail out
// with a friendly message).
//
// Usage:
//   node scripts/rebuild-daily-context.js              # dry run (default)
//   node scripts/rebuild-daily-context.js --apply      # commit the swap
//
// Output: structured JSON with snapshot counts/checksums, the planned
// CREATE/INSERT SQL, and (in --apply mode) the post-swap counts.

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool, withTransaction } = require('../db');

// Canonical column list after rebuild. Mirrors the live shape of
// daily_context as of v3.33 (see docs/SCHEMA.md). Adding or removing a
// column here changes the post-rebuild schema — update SCHEMA.md too.
const NEW_TABLE_SQL = `
  CREATE TABLE daily_context_v2 (
    id UUID PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    hydration_liters NUMERIC(4,2),
    notes TEXT,
    sleep_hours NUMERIC(3,1),
    sleep_quality INTEGER CHECK(sleep_quality >= 1 AND sleep_quality <= 10),
    mood INTEGER CHECK(mood >= 1 AND mood <= 10),
    motivation INTEGER CHECK(motivation >= 1 AND motivation <= 10),
    soreness_overall INTEGER CHECK(soreness_overall >= 1 AND soreness_overall <= 10),
    soreness_areas JSONB DEFAULT '[]'::jsonb,
    life_stress INTEGER CHECK(life_stress >= 1 AND life_stress <= 10),
    illness_flag TEXT CHECK(illness_flag IN ('none','onset','active','resolving')),
    travel_status TEXT,
    bedtime_self_report TIME,
    alcohol_units NUMERIC(4,1),
    supplement_change_note TEXT,
    search_vector TSVECTOR,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;

const COPY_COLUMNS = [
  'id', 'date', 'hydration_liters', 'notes',
  'sleep_hours', 'sleep_quality',
  'mood', 'motivation', 'soreness_overall', 'soreness_areas',
  'life_stress', 'illness_flag', 'travel_status', 'bedtime_self_report',
  'alcohol_units', 'supplement_change_note',
  'search_vector', 'created_at', 'updated_at',
];

// Checksum function. Plain row count is necessary but not sufficient —
// a same-count copy could still be wrong (mis-aligned columns, lossy
// cast). The checksum hashes the live columns row-by-row and sums.
// md5 is fine for integrity (not security).
const CHECKSUM_SQL = `
  SELECT
    COUNT(*)::bigint AS row_count,
    COALESCE(SUM(('x' || substr(md5(
      coalesce(date::text,'') || '|' ||
      coalesce(hydration_liters::text,'') || '|' ||
      coalesce(notes,'') || '|' ||
      coalesce(sleep_hours::text,'') || '|' ||
      coalesce(sleep_quality::text,'') || '|' ||
      coalesce(mood::text,'') || '|' ||
      coalesce(motivation::text,'') || '|' ||
      coalesce(soreness_overall::text,'') || '|' ||
      coalesce(soreness_areas::text,'') || '|' ||
      coalesce(life_stress::text,'') || '|' ||
      coalesce(illness_flag,'') || '|' ||
      coalesce(travel_status,'') || '|' ||
      coalesce(bedtime_self_report::text,'') || '|' ||
      coalesce(alcohol_units::text,'') || '|' ||
      coalesce(supplement_change_note,'')
    ), 1, 8))::bit(32)::bigint), 0) AS checksum
  FROM `;

function fmt(n) {
  return typeof n === 'bigint' ? n.toString() : String(n);
}

async function colExists(client, table, col) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, col]
  );
  return r.rows.length > 0;
}

async function countTombstones(client) {
  // pg_attribute carries dropped-but-not-vacuumed columns as
  // attisdropped=true rows. This is the canonical signal for "are we
  // actually leaking slots". A pristine rebuild reports 0.
  const r = await client.query(`
    SELECT COUNT(*)::int AS n
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    WHERE c.relname = 'daily_context'
      AND a.attisdropped = TRUE
  `);
  return r.rows[0]?.n || 0;
}

async function run(apply) {
  const log = { dry_run: !apply, started_at: new Date().toISOString() };

  await withTransaction(async (client) => {
    log.tombstones_before = await countTombstones(client);
    if (log.tombstones_before === 0) {
      log.verdict = 'NO-OP: daily_context has zero tombstones; nothing to reclaim. Exiting.';
      throw new Error('__NO_OP__'); // forces a clean rollback, no side effects
    }

    // Snapshot OLD table
    const oldStats = await client.query(CHECKSUM_SQL + 'daily_context');
    log.old = {
      row_count: fmt(oldStats.rows[0].row_count),
      checksum: fmt(oldStats.rows[0].checksum),
    };

    // Build NEW table + copy
    await client.query(`DROP TABLE IF EXISTS daily_context_v2`);
    await client.query(NEW_TABLE_SQL);
    const copySql = `
      INSERT INTO daily_context_v2 (${COPY_COLUMNS.join(', ')})
      SELECT ${COPY_COLUMNS.join(', ')} FROM daily_context
    `;
    await client.query(copySql);

    // Snapshot NEW table
    const newStats = await client.query(CHECKSUM_SQL + 'daily_context_v2');
    log.new = {
      row_count: fmt(newStats.rows[0].row_count),
      checksum: fmt(newStats.rows[0].checksum),
    };

    // Hard assertion — if either disagrees, throw (rolls back).
    if (oldStats.rows[0].row_count !== newStats.rows[0].row_count) {
      log.verdict = `FAIL: row count mismatch (${log.old.row_count} → ${log.new.row_count}). Rolling back.`;
      throw new Error('row_count_mismatch');
    }
    if (oldStats.rows[0].checksum !== newStats.rows[0].checksum) {
      log.verdict = `FAIL: checksum mismatch (${log.old.checksum} vs ${log.new.checksum}). Rolling back.`;
      throw new Error('checksum_mismatch');
    }

    if (!apply) {
      log.verdict = `DRY RUN: would swap ${log.old.row_count} rows, reclaiming ${log.tombstones_before} tombstones. Rolling back temporary v2 table.`;
      throw new Error('__DRY_RUN__');
    }

    // Live swap. DROP first (CASCADE not used — nothing should FK to
    // daily_context.id; if something does, the DROP fails and the whole
    // transaction rolls back).
    await client.query(`DROP TABLE daily_context`);
    await client.query(`ALTER TABLE daily_context_v2 RENAME TO daily_context`);

    // Recreate indexes (CREATE TABLE only made the implicit PK +
    // UNIQUE; the explicit indexes in db.js need recreating).
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dc_date ON daily_context(date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dc_search ON daily_context USING gin(search_vector)`);

    // Recreate trigger (the original was dropped with the old table).
    // Function update_dc_search() is unchanged and survives at the
    // schema level.
    await client.query(`
      CREATE TRIGGER trg_dc_search BEFORE INSERT OR UPDATE OF notes ON daily_context
      FOR EACH ROW EXECUTE FUNCTION update_dc_search()
    `);

    log.tombstones_after = await countTombstones(client);
    log.verdict = log.tombstones_after === 0
      ? `OK: swap committed. ${log.old.row_count} rows preserved, ${log.tombstones_before} tombstones reclaimed.`
      : `WARNING: swap committed but tombstones_after=${log.tombstones_after} (expected 0). Investigate before declaring success.`;
  }).catch((err) => {
    if (err.message === '__NO_OP__' || err.message === '__DRY_RUN__') return;
    log.error = err.message;
    throw err;
  });

  log.finished_at = new Date().toISOString();
  console.log(JSON.stringify(log, null, 2));
  if (log.error) process.exitCode = 1;
}

const apply = process.argv.includes('--apply');
run(apply)
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
