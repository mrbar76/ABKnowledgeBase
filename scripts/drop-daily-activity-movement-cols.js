#!/usr/bin/env node
// Drop the 7 movement + energy columns from daily_activity, AFTER the
// consolidation script has backfilled them into daily_vitals_cache.
//
// This is the second half of v3.34 #2 (selective absorb of
// daily_activity → daily_vitals_cache). It frees those 7 attribute
// slots from daily_activity ahead of the Aug 5, 2026 full-table drop,
// and makes daily_vitals_cache the single source of truth for movement
// + energy data.
//
// Pre-flight check: for every (date, column) pair where daily_activity
// has a non-null value, daily_vitals_cache must also have a non-null
// value for that date+column. If ANY pair fails this check, the script
// aborts without touching schema. Operator must run
//   scripts/consolidate-daily-activity-to-vitals.js --apply
// first.
//
// Usage:
//   node scripts/drop-daily-activity-movement-cols.js          # dry run
//   node scripts/drop-daily-activity-movement-cols.js --apply  # commit
//
// Idempotent: once dropped, the columns are gone from
// information_schema and the pre-flight check passes trivially (0
// non-null source rows).

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool, withTransaction } = require('../db');

const COLUMNS_TO_DROP = [
  'steps',
  'distance_mi',
  'exercise_minutes',
  'flights_climbed',
  'workout_count',
  'active_energy_kcal',
  'basal_energy_kcal',
];

async function colExists(client, table, col) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, col]
  );
  return r.rows.length > 0;
}

async function run(apply) {
  const log = { dry_run: !apply, started_at: new Date().toISOString(), columns: COLUMNS_TO_DROP };

  await withTransaction(async (client) => {
    // Idempotency: if none of the columns exist anymore, this is a no-op.
    const stillPresent = [];
    for (const col of COLUMNS_TO_DROP) {
      if (await colExists(client, 'daily_activity', col)) stillPresent.push(col);
    }
    log.columns_present_in_daily_activity = stillPresent;
    if (stillPresent.length === 0) {
      log.verdict = 'NO-OP: none of the target columns exist on daily_activity. Already dropped.';
      throw new Error('__NO_OP__');
    }

    // Pre-flight: for each present column, every non-null source must
    // have a non-null counterpart in daily_vitals_cache. Otherwise the
    // drop loses data.
    const unbacked = {};
    for (const col of stillPresent) {
      const r = await client.query(`
        SELECT COUNT(*)::int AS n
        FROM daily_activity da
        LEFT JOIN daily_vitals_cache c ON da.activity_date = c.date
        WHERE da.${col} IS NOT NULL
          AND (c.${col} IS NULL OR c.date IS NULL)
      `);
      const n = r.rows[0]?.n || 0;
      if (n > 0) unbacked[col] = n;
    }
    log.unbacked_rows_by_column = unbacked;

    if (Object.keys(unbacked).length > 0) {
      log.verdict =
        `BLOCKED: ${Object.keys(unbacked).length} column(s) have data not yet in daily_vitals_cache. ` +
        `Run scripts/consolidate-daily-activity-to-vitals.js --apply first, then retry. Rolling back.`;
      throw new Error('unbacked_data_present');
    }

    if (!apply) {
      log.verdict =
        `DRY RUN: pre-flight passed. Would DROP ${stillPresent.length} column(s) from daily_activity: ` +
        `${stillPresent.join(', ')}. Rolling back.`;
      throw new Error('__DRY_RUN__');
    }

    // Drop each column. IF EXISTS for resilience (between pre-flight
    // and DROP, nothing should have changed, but the guard is cheap).
    const dropped = [];
    for (const col of stillPresent) {
      await client.query(`ALTER TABLE daily_activity DROP COLUMN IF EXISTS ${col}`);
      dropped.push(col);
    }
    log.dropped = dropped;

    // Verify post-state — none of the dropped columns should exist.
    for (const col of dropped) {
      if (await colExists(client, 'daily_activity', col)) {
        log.verdict = `FAIL: ${col} still exists after DROP — possible trigger dependency. Rolling back.`;
        throw new Error('post_drop_verification');
      }
    }

    log.verdict = `OK: dropped ${dropped.length} columns from daily_activity. Movement + energy data now live exclusively in daily_vitals_cache.`;
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
