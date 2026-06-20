#!/usr/bin/env node
// Backfill daily_vitals_cache rows from daily_activity for the overlapping
// vitals fields (hrv, rhr, sleep_total, respiratory_rate). The Aug 5,
// 2026 deprecation plan for daily_activity assumes daily_vitals_cache has
// every date covered by then; this script makes that true for historical
// dates that pre-date the Shortcut-based ingest.
//
// Column-name mapping (daily_activity → daily_vitals_cache):
//
//   activity_date         → date
//   hrv_sdnn_ms           → hrv_ms
//   resting_hr_bpm        → rhr_bpm
//   sleep_total_min       → sleep_total_min
//   respiratory_rate_avg  → respiratory_rate_bpm
//
// Strategy: per row in daily_activity, UPSERT into daily_vitals_cache.
// Only writes fields that are non-null in daily_activity AND null in
// daily_vitals_cache for that date. Cache values from the Shortcut are
// always preferred when they exist.
//
// NOT migrated (intentional): steps, distance_mi, exercise_minutes,
// flights_climbed, active_energy_kcal, basal_energy_kcal, workout_count,
// sleep_deep_min, sleep_rem_min, sleep_core_min, sleep_awake_min,
// sleep_efficiency_pct, walking_hr_avg_bpm, vo2_max, walking_*.
// These have no home in daily_vitals_cache. If the Aug 5 drop should
// preserve them, daily_vitals_cache needs to gain columns first — see
// docs/SCHEMA.md "daily-namespace overlap" section.
//
// Usage:
//   node scripts/consolidate-daily-activity-to-vitals.js          # dry run
//   node scripts/consolidate-daily-activity-to-vitals.js --apply  # write
//
// Idempotent: re-running after writes only touches rows that have
// daily_activity values but null daily_vitals_cache columns (so no
// double-writes).

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool, query, withTransaction } = require('../db');

const VITALS_FIELDS = [
  // [daily_activity column, daily_vitals_cache column]
  ['hrv_sdnn_ms', 'hrv_ms'],
  ['resting_hr_bpm', 'rhr_bpm'],
  ['sleep_total_min', 'sleep_total_min'],
  ['respiratory_rate_avg', 'respiratory_rate_bpm'],
];

async function run(apply) {
  const log = { dry_run: !apply, started_at: new Date().toISOString() };

  await withTransaction(async (client) => {
    // Snapshot the pre-state so we can verify writes against expectations.
    const before = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE hrv_ms IS NOT NULL)::int            AS cache_with_hrv,
        COUNT(*) FILTER (WHERE rhr_bpm IS NOT NULL)::int           AS cache_with_rhr,
        COUNT(*) FILTER (WHERE sleep_total_min IS NOT NULL)::int   AS cache_with_sleep,
        COUNT(*) FILTER (WHERE respiratory_rate_bpm IS NOT NULL)::int AS cache_with_resp,
        COUNT(*)::int AS cache_total
      FROM daily_vitals_cache
    `);
    log.before = before.rows[0];

    const activity = await client.query(`
      SELECT activity_date, hrv_sdnn_ms, resting_hr_bpm,
             sleep_total_min, respiratory_rate_avg
      FROM daily_activity
      WHERE activity_date <= CURRENT_DATE
      ORDER BY activity_date ASC
    `);
    log.activity_rows_scanned = activity.rows.length;

    // For each (date, field) where activity has a value and cache doesn't,
    // upsert into daily_vitals_cache. Single UPSERT per date covers all
    // four fields; COALESCE in DO UPDATE keeps existing cache values.
    let writes = 0;
    const updatesByField = { hrv_ms: 0, rhr_bpm: 0, sleep_total_min: 0, respiratory_rate_bpm: 0 };
    for (const row of activity.rows) {
      const date = row.activity_date instanceof Date
        ? row.activity_date.toISOString().slice(0, 10)
        : String(row.activity_date).slice(0, 10);

      // Look up current cache row to compute what we'd actually write.
      const cacheRow = await client.query(
        `SELECT hrv_ms, rhr_bpm, sleep_total_min, respiratory_rate_bpm
           FROM daily_vitals_cache WHERE date = $1`,
        [date]
      );
      const current = cacheRow.rows[0] || {};

      const writeMap = {};
      for (const [srcCol, dstCol] of VITALS_FIELDS) {
        if (row[srcCol] != null && current[dstCol] == null) {
          writeMap[dstCol] = row[srcCol];
        }
      }
      if (Object.keys(writeMap).length === 0) continue;

      writes++;
      for (const f of Object.keys(writeMap)) updatesByField[f]++;

      // UPSERT — preserves any cache values not in writeMap via COALESCE.
      await client.query(
        `INSERT INTO daily_vitals_cache
           (date, hrv_ms, rhr_bpm, sleep_total_min, respiratory_rate_bpm, recorded_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (date) DO UPDATE SET
           hrv_ms = COALESCE(daily_vitals_cache.hrv_ms, EXCLUDED.hrv_ms),
           rhr_bpm = COALESCE(daily_vitals_cache.rhr_bpm, EXCLUDED.rhr_bpm),
           sleep_total_min = COALESCE(daily_vitals_cache.sleep_total_min, EXCLUDED.sleep_total_min),
           respiratory_rate_bpm = COALESCE(daily_vitals_cache.respiratory_rate_bpm, EXCLUDED.respiratory_rate_bpm),
           updated_at = NOW()`,
        [
          date,
          writeMap.hrv_ms ?? null,
          writeMap.rhr_bpm ?? null,
          writeMap.sleep_total_min ?? null,
          writeMap.respiratory_rate_bpm ?? null,
        ]
      );
    }

    log.writes_planned = writes;
    log.fields_updated = updatesByField;

    if (!apply) {
      log.verdict = `DRY RUN: would upsert ${writes} daily_vitals_cache row(s) — rolling back.`;
      throw new Error('__DRY_RUN__');
    }

    // Verify the after-state — counts should be strictly >= before.
    const after = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE hrv_ms IS NOT NULL)::int            AS cache_with_hrv,
        COUNT(*) FILTER (WHERE rhr_bpm IS NOT NULL)::int           AS cache_with_rhr,
        COUNT(*) FILTER (WHERE sleep_total_min IS NOT NULL)::int   AS cache_with_sleep,
        COUNT(*) FILTER (WHERE respiratory_rate_bpm IS NOT NULL)::int AS cache_with_resp,
        COUNT(*)::int AS cache_total
      FROM daily_vitals_cache
    `);
    log.after = after.rows[0];

    for (const f of ['cache_with_hrv', 'cache_with_rhr', 'cache_with_sleep', 'cache_with_resp']) {
      if (after.rows[0][f] < before.rows[0][f]) {
        log.verdict = `FAIL: ${f} regressed (${before.rows[0][f]} → ${after.rows[0][f]}). Rolling back.`;
        throw new Error('regression_detected');
      }
    }

    log.verdict = `OK: backfilled ${writes} row(s), preserved every prior non-null cache value.`;
  }).catch((err) => {
    if (err.message === '__DRY_RUN__') return;
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
