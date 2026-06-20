// Static safety guards for scripts/consolidate-daily-activity-to-vitals.js.
//
// The script writes to daily_vitals_cache. Without a live DB in CI we
// can't end-to-end test, but we can pin a few invariants the script
// must hold to avoid data corruption.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../scripts/consolidate-daily-activity-to-vitals.js'), 'utf8');

test('consolidate: default is dry run (apply must be explicit)', () => {
  assert.ok(/const apply = process\.argv\.includes\(['"]--apply['"]\)/.test(src),
    'apply flag must be read from argv');
  assert.ok(/__DRY_RUN__/.test(src),
    'dry-run path must throw a __DRY_RUN__ sentinel to force rollback');
});

test('consolidate: entire flow wrapped in withTransaction', () => {
  assert.ok(/await withTransaction\(async \(client\) => \{/.test(src),
    'must use withTransaction wrapper');
});

test('consolidate: v3.34 #2 expanded — vitals + movement + energy migrated, sleep-phase + mobility excluded', () => {
  const m = src.match(/const VITALS_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'VITALS_FIELDS mapping present');
  const list = m[1];

  // Pairs we MUST migrate (v3.34 #2 selective absorb).
  const expectedPairs = [
    // Recovery vitals (original 4)
    ['hrv_sdnn_ms', 'hrv_ms'],
    ['resting_hr_bpm', 'rhr_bpm'],
    ['sleep_total_min', 'sleep_total_min'],
    ['respiratory_rate_avg', 'respiratory_rate_bpm'],
    // Movement (v3.34 #2)
    ['steps', 'steps'],
    ['distance_mi', 'distance_mi'],
    ['exercise_minutes', 'exercise_minutes'],
    ['flights_climbed', 'flights_climbed'],
    ['workout_count', 'workout_count'],
    // Energy (v3.34 #2)
    ['active_energy_kcal', 'active_energy_kcal'],
    ['basal_energy_kcal', 'basal_energy_kcal'],
  ];
  for (const [src_col, dst_col] of expectedPairs) {
    assert.ok(new RegExp(`\\['${src_col}',\\s*'${dst_col}'\\]`).test(list),
      `VITALS_FIELDS must map daily_activity.${src_col} → daily_vitals_cache.${dst_col}`);
  }

  // Per operator decision (option 2 selective): sleep-phase + walking +
  // mobility cluster columns explicitly stay daily_activity-only. They
  // get dropped with the table on Aug 5; not worth a daily_vitals_cache
  // home since Series 3 watch produces null for all of them going forward.
  for (const col of ['sleep_deep_min', 'sleep_rem_min', 'sleep_core_min',
                     'sleep_awake_min', 'sleep_efficiency_pct',
                     'vo2_max', 'walking_hr_avg_bpm',
                     'walking_speed_mph', 'walking_steadiness_pct',
                     'walking_asymmetry_pct', 'walking_step_length_in',
                     'stand_hours', 'stand_minutes']) {
    assert.ok(!new RegExp(`'${col}'`).test(list),
      `VITALS_FIELDS must NOT include '${col}' (Series-3 can't supply; not worth preserving)`);
  }
});

test('consolidate: ON CONFLICT preserves existing cache values via COALESCE (dynamic across all VITALS_FIELDS)', () => {
  // The UPSERT pattern: for EVERY destination column in VITALS_FIELDS,
  // ON CONFLICT must use COALESCE(daily_vitals_cache.col, EXCLUDED.col).
  // The script builds this dynamically; we assert the produced pattern
  // is structurally correct.
  assert.ok(/COALESCE\(daily_vitals_cache\.\$\{c\}, EXCLUDED\.\$\{c\}\)/.test(src),
    'upsertCols template must use COALESCE(daily_vitals_cache.<col>, EXCLUDED.<col>)');
  // Sanity: the dynamic template must enumerate dstCols (no hardcoded
  // shortlist that could drift from VITALS_FIELDS).
  assert.ok(/dstCols\.map\(c =>/.test(src),
    'upsert COALESCE list must iterate dstCols, not a hardcoded list');
});

test('consolidate: per-row skip when nothing would change', () => {
  // The inner loop must skip the UPSERT entirely when there's nothing
  // to write. Otherwise we'd burn one INSERT per scanned row, even
  // when every cache value is already populated — idempotent re-runs
  // would touch every row's updated_at.
  assert.ok(/if \(Object\.keys\(writeMap\)\.length === 0\) continue/.test(src),
    'must skip the UPSERT when writeMap is empty');
});

test('consolidate: after-state assertion catches regressions', () => {
  // Some safeguard against an UPSERT that accidentally NULLs an
  // existing value. We compare per-field non-null counts before/after
  // and roll back if any decreased. v3.34 #2: refactored to iterate
  // dstCols (key = `count_${dst}`) so the assertion auto-grows with
  // VITALS_FIELDS.
  assert.ok(/if \(after\.rows\[0\]\[key\] < before\.rows\[0\]\[key\]\)/.test(src),
    'after-state must assert no field count regressed (via dstCols loop)');
  assert.ok(/throw new Error\(['"]regression_detected['"]\)/.test(src),
    'regression must throw to roll back the transaction');
});
