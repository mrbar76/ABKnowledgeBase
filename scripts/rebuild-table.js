#!/usr/bin/env node
// Generalized tombstone-reclamation table rebuild.
//
// Same transactional pattern as scripts/rebuild-daily-context.js but
// parameterized on the table name. Auto-discovers live columns,
// indexes, and triggers from the live DB — no hardcoded shape, so
// drift between db.js intent and DB reality can't cause it to lose data.
//
// Strategy (inside one transaction):
//   1. Detect: bail out if the table has zero tombstones
//   2. Snapshot OLD: count + md5 checksum across all live columns
//   3. CREATE TABLE <name>_v2 (LIKE <name> INCLUDING ALL EXCLUDING
//      INDEXES) — preserves defaults, NOT NULL, CHECK constraints, and
//      the PRIMARY KEY. Drops only the tombstoned columns
//      (CREATE TABLE LIKE skips them — they're physical artifacts in
//      pg_attribute, not part of the logical schema).
//   4. INSERT INTO _v2 SELECT live cols FROM <name>
//   5. Snapshot NEW: same count + checksum
//   6. Assert match → otherwise throw → rollback
//   7. Dry-run path: throw __DRY_RUN__ to clean-rollback before swap
//   8. Apply path: DROP old (cascades indexes + triggers), RENAME _v2
//      to <name>, recreate indexes from pg_indexes snapshot, recreate
//      triggers from pg_get_triggerdef snapshot
//   9. Verify tombstones_after === 0
//
// Usage:
//   node scripts/rebuild-table.js --table=<name>            # dry run
//   node scripts/rebuild-table.js --table=<name> --apply    # commit
//
// Safety: every destructive step happens inside withTransaction. Any
// throw rolls back the entire operation; the old table is untouched.

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool, withTransaction } = require('../db');

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

async function getTombstoneCount(client, table) {
  const r = await client.query(`
    SELECT count(*)::int AS n
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = $1 AND a.attisdropped = TRUE
  `, [table]);
  return r.rows[0]?.n || 0;
}

async function getLiveColumns(client, table) {
  const r = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return r.rows.map(row => row.column_name);
}

async function getIndexDefs(client, table) {
  // pg_get_indexdef-equivalent output via pg_indexes.indexdef. Excludes
  // the implicit PK index (we get the PK from INCLUDING ALL).
  const r = await client.query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = $1
    ORDER BY indexname
  `, [table]);
  return r.rows;
}

async function getTriggerDefs(client, table) {
  const r = await client.query(`
    SELECT t.tgname, pg_get_triggerdef(t.oid, true) AS def
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = $1 AND NOT t.tgisinternal
    ORDER BY t.tgname
  `, [table]);
  return r.rows;
}

function buildChecksumSql(target, cols) {
  // Concatenate every live column as text with a delimiter, md5, sum
  // the first 8 hex chars cast to bigint. Same shape as
  // rebuild-daily-context.js so verdicts are comparable.
  const concat = cols.map(c => `coalesce("${c}"::text, '')`).join(` || '|' || `);
  return `
    SELECT
      count(*)::bigint AS row_count,
      COALESCE(SUM(('x' || substr(md5(${concat}), 1, 8))::bit(32)::bigint), 0) AS checksum
    FROM "${target}"
  `;
}

function fmtBig(n) {
  return typeof n === 'bigint' ? n.toString() : String(n);
}

async function run(table, apply) {
  const log = {
    table,
    dry_run: !apply,
    started_at: new Date().toISOString(),
  };

  await withTransaction(async (client) => {
    log.tombstones_before = await getTombstoneCount(client, table);
    if (log.tombstones_before === 0) {
      log.verdict = `NO-OP: "${table}" has zero tombstones; nothing to reclaim.`;
      throw new Error('__NO_OP__');
    }

    const cols = await getLiveColumns(client, table);
    if (cols.length === 0) {
      log.verdict = `FAIL: "${table}" has no live columns visible — does the table exist?`;
      throw new Error('table_not_found_or_empty_schema');
    }
    log.live_columns_discovered = cols.length;

    const indexes = await getIndexDefs(client, table);
    const triggers = await getTriggerDefs(client, table);
    log.indexes_discovered = indexes.length;
    log.triggers_discovered = triggers.length;

    // Snapshot OLD
    const oldStats = (await client.query(buildChecksumSql(table, cols))).rows[0];
    log.old = { row_count: fmtBig(oldStats.row_count), checksum: fmtBig(oldStats.checksum) };

    // Build the v2 table. LIKE INCLUDING ALL EXCLUDING INDEXES brings
    // defaults, NOT NULL, CHECK constraints, and the PRIMARY KEY.
    // Tombstoned columns are skipped automatically (CREATE TABLE LIKE
    // reads from the logical schema, not pg_attribute).
    await client.query(`DROP TABLE IF EXISTS "${table}_v2"`);
    await client.query(`CREATE TABLE "${table}_v2" (LIKE "${table}" INCLUDING ALL EXCLUDING INDEXES)`);

    const colList = cols.map(c => `"${c}"`).join(', ');
    await client.query(`INSERT INTO "${table}_v2" (${colList}) SELECT ${colList} FROM "${table}"`);

    // Snapshot NEW
    const newStats = (await client.query(buildChecksumSql(`${table}_v2`, cols))).rows[0];
    log.new = { row_count: fmtBig(newStats.row_count), checksum: fmtBig(newStats.checksum) };

    if (oldStats.row_count !== newStats.row_count) {
      log.verdict = `FAIL: row count mismatch (${log.old.row_count} → ${log.new.row_count}). Rolling back.`;
      throw new Error('row_count_mismatch');
    }
    if (oldStats.checksum !== newStats.checksum) {
      log.verdict = `FAIL: checksum mismatch (${log.old.checksum} vs ${log.new.checksum}). Rolling back.`;
      throw new Error('checksum_mismatch');
    }

    if (!apply) {
      log.verdict = `DRY RUN: would swap ${log.old.row_count} rows in "${table}", reclaiming ${log.tombstones_before} tombstones. Rolling back v2 table.`;
      throw new Error('__DRY_RUN__');
    }

    // Live swap. DROP cascades indexes + triggers attached to the old
    // table; we recreate them from snapshot after rename. If anything
    // outside this script FK-depends on the old table, DROP fails and
    // the entire transaction rolls back (table untouched).
    await client.query(`DROP TABLE "${table}"`);
    await client.query(`ALTER TABLE "${table}_v2" RENAME TO "${table}"`);

    // Recreate indexes. The pg_indexes.indexdef text uses the original
    // table name — after rename, "${table}" IS the new table, so the
    // DDL works as-is. Skip the implicit PK index (LIKE INCLUDING ALL
    // already created it via the PRIMARY KEY constraint).
    let idxRecreated = 0;
    for (const idx of indexes) {
      if (idx.indexname === `${table}_pkey`) continue;
      await client.query(idx.indexdef);
      idxRecreated++;
    }
    log.indexes_recreated = idxRecreated;

    // Recreate triggers (LIKE INCLUDING ALL does NOT include triggers).
    // pg_get_triggerdef returns a self-contained CREATE TRIGGER stmt
    // referring to "${table}" by name — works after rename.
    let trgRecreated = 0;
    for (const trg of triggers) {
      await client.query(trg.def);
      trgRecreated++;
    }
    log.triggers_recreated = trgRecreated;

    log.tombstones_after = await getTombstoneCount(client, table);
    log.verdict = log.tombstones_after === 0
      ? `OK: swap committed. ${log.old.row_count} rows preserved, ${log.tombstones_before} tombstones reclaimed, ${idxRecreated} index(es) + ${trgRecreated} trigger(s) recreated.`
      : `WARNING: swap committed but tombstones_after=${log.tombstones_after} (expected 0). Investigate.`;
  }).catch((err) => {
    if (err.message === '__NO_OP__' || err.message === '__DRY_RUN__') return;
    log.error = err.message;
    throw err;
  });

  log.finished_at = new Date().toISOString();
  console.log(JSON.stringify(log, null, 2));
  if (log.error) process.exitCode = 1;
}

// ─── arg parse ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tableArg = args.find(a => a.startsWith('--table='));
if (!tableArg) {
  console.error('Usage: node scripts/rebuild-table.js --table=<name> [--apply]');
  console.error('Examples:');
  console.error('  node scripts/rebuild-table.js --table=workouts');
  console.error('  node scripts/rebuild-table.js --table=meals --apply');
  process.exit(2);
}
const table = tableArg.slice('--table='.length);
if (!SAFE_IDENT.test(table)) {
  console.error(`Invalid table name: ${JSON.stringify(table)}. Must match /^[a-z_][a-z0-9_]*$/`);
  process.exit(2);
}

run(table, apply)
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
