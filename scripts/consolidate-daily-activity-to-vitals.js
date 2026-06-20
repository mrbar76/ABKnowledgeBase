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
//   hrv_sdnn_ms           → hrv_ms                      (vitals)
//   resting_hr_bpm        → rhr_bpm                     (vitals)
//   sleep_total_min       → sleep_total_min             (vitals)
//   respiratory_rate_avg  → respiratory_rate_bpm        (vitals)
//   steps                 → steps                       (movement, v3.34 #2)
//   distance_mi           → distance_mi                 (movement, v3.34 #2)
//   exercise_minutes      → exercise_minutes            (movement, v3.34 #2)
//   flights_climbed       → flights_climbed             (movement, v3.34 #2)
//   workout_count         → workout_count               (movement, v3.34 #2)
//   active_energy_kcal    → active_energy_kcal          (energy, v3.34 #2)
//   basal_energy_kcal     → basal_energy_kcal           (energy, v3.34 #2)
//
// Strategy: per row in daily_activity, UPSERT into daily_vitals_cache.
// Only writes fields that are non-null in daily_activity AND null in
// daily_vitals_cache for that date. Cache values from the Shortcut are
// always preferred when they exist.
//
// NOT migrated (intentional): sleep_deep_min, sleep_rem_min,
// sleep_core_min, sleep_awake_min, sleep_efficiency_pct,
// walking_hr_avg_bpm, vo2_max, walking_speed_mph,
// walking_steadiness_pct, walking_asymmetry_pct, walking_step_length_in,
// stand_hours, stand_minutes. Per operator decision (option 2 selective):
// Series 3 watch can't supply sleep-phases or mobility metrics, so they're
// null going forward and not worth preserving on the Aug 5 drop.
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
  // ── Recovery vitals ─────────────────────────────────
  ['hrv_sdnn_ms', 'hrv_ms'],
  ['resting_hr_bpm', 'rhr_bpm'],
  ['sleep_total_min', 'sleep_total_min'],
  ['respiratory_rate_avg', 'respiratory_rate_bpm'],
  // ── Movement (v3.34 #2, name-identical) ─────────────
  ['steps', 'steps'],
  ['distance_mi', 'distance_mi'],
  ['exercise_minutes', 'exercise_minutes'],
  ['flights_climbed', 'flights_climbed'],
  ['workout_count', 'workout_count'],
  // ── Energy (v3.34 #2, name-identical) ───────────────
  ['active_energy_kcal', 'active_energy_kcal'],
  ['basal_energy_kcal', 'basal_energy_kcal'],
];

async function run(apply) {
  const log = { dry_run: !apply, started_at: new Date().toISOString() };

  // Build the snapshot SQL dynamically from VITALS_FIELDS — keeps the
  // count list in lockstep with the mapping list, so adding a 12th
  // field to VITALS_FIELDS automatically extends the assertions.
  const snapshotSql = `
    SELECT
      ${VITALS_FIELDS.map(([, dst]) =>
        `COUNT(*) FILTER (WHERE ${dst} IS NOT NULL)::int AS count_${dst}`
      ).join(',\n      ')},
      COUNT(*)::int AS cache_total
    FROM daily_vitals_cache
  `;
  const dstCols = VITALS_FIELDS.map(([, dst]) => dst);
  const srcCols = VITALS_FIELDS.map(([src]) => src);

  await withTransaction(async (client) => {
    const before = await client.query(snapshotSql);
    log.before = before.rows[0];

    const activity = await client.query(`
      SELECT activity_date, ${srcCols.join(', ')}
      FROM daily_activity
      WHERE activity_date <= CURRENT_DATE
      ORDER BY activity_date ASC
    `);
    log.activity_rows_scanned = activity.rows.length;

    // For each (date, field) where activity has a value and cache doesn't,
    // UPSERT into daily_vitals_cache. Single UPSERT per date covers every
    // mapped field; COALESCE in DO UPDATE keeps existing cache values.
    let writes = 0;
    const updatesByField = Object.fromEntries(dstCols.map(c => [c, 0]));
    for (const row of activity.rows) {
      const date = row.activity_date instanceof Date
        ? row.activity_date.toISOString().slice(0, 10)
        : String(row.activity_date).slice(0, 10);

      const cacheRow = await client.query(
        `SELECT ${dstCols.join(', ')} FROM daily_vitals_cache WHERE date = $1`,
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

      // Build dynamic INSERT params: $1=date, then one per dstCol.
      const params = [date, ...dstCols.map(c => writeMap[c] ?? null)];
      const placeholders = dstCols.map((_, i) => `$${i + 2}`).join(', ');
      const upsertCols = dstCols.map(c =>
        `${c} = COALESCE(daily_vitals_cache.${c}, EXCLUDED.${c})`
      ).join(',\n           ');
      await client.query(
        `INSERT INTO daily_vitals_cache
           (date, ${dstCols.join(', ')}, recorded_at, updated_at)
         VALUES ($1, ${placeholders}, NOW(), NOW())
         ON CONFLICT (date) DO UPDATE SET
           ${upsertCols},
           updated_at = NOW()`,
        params
      );
    }

    log.writes_planned = writes;
    log.fields_updated = updatesByField;

    if (!apply) {
      log.verdict = `DRY RUN: would upsert ${writes} daily_vitals_cache row(s) — rolling back.`;
      throw new Error('__DRY_RUN__');
    }

    // Verify the after-state — counts should be strictly >= before.
    const after = await client.query(snapshotSql);
    log.after = after.rows[0];

    for (const dst of dstCols) {
      const key = `count_${dst}`;
      if (after.rows[0][key] < before.rows[0][key]) {
        log.verdict = `FAIL: ${key} regressed (${before.rows[0][key]} → ${after.rows[0][key]}). Rolling back.`;
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
