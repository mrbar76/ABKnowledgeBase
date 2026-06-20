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

test('consolidate: only the 4 overlap fields are migrated', () => {
  // If someone adds a daily_activity column to this list that has no
  // daily_vitals_cache home, the UPSERT will 500. Pin the exact mapping.
  const m = src.match(/const VITALS_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'VITALS_FIELDS mapping present');
  const list = m[1];

  const expectedPairs = [
    ['hrv_sdnn_ms', 'hrv_ms'],
    ['resting_hr_bpm', 'rhr_bpm'],
    ['sleep_total_min', 'sleep_total_min'],
    ['respiratory_rate_avg', 'respiratory_rate_bpm'],
  ];
  for (const [src_col, dst_col] of expectedPairs) {
    assert.ok(new RegExp(`\\['${src_col}',\\s*'${dst_col}'\\]`).test(list),
      `VITALS_FIELDS must map daily_activity.${src_col} → daily_vitals_cache.${dst_col}`);
  }
  // Non-overlap columns must not be in this list — those need a separate
  // migration path because daily_vitals_cache has no home for them.
  for (const col of ['steps', 'distance_mi', 'exercise_minutes',
                     'sleep_deep_min', 'sleep_rem_min', 'sleep_core_min',
                     'sleep_awake_min', 'sleep_efficiency_pct',
                     'active_energy_kcal', 'basal_energy_kcal',
                     'vo2_max', 'walking_hr_avg_bpm']) {
    assert.ok(!new RegExp(`'${col}'`).test(list),
      `VITALS_FIELDS must NOT include '${col}' (no daily_vitals_cache target)`);
  }
});

test('consolidate: ON CONFLICT preserves existing cache values via COALESCE', () => {
  // The UPSERT must never overwrite a non-null cache value with a
  // daily_activity value (cache always wins on overlap — Shortcut data
  // is canonical). Pin the COALESCE pattern.
  const conflict = src.match(/ON CONFLICT \(date\) DO UPDATE SET[\s\S]*?updated_at = NOW\(\)/);
  assert.ok(conflict, 'ON CONFLICT block present');
  const cols = ['hrv_ms', 'rhr_bpm', 'sleep_total_min', 'respiratory_rate_bpm'];
  for (const c of cols) {
    assert.ok(new RegExp(`${c} = COALESCE\\(daily_vitals_cache\\.${c}, EXCLUDED\\.${c}\\)`).test(conflict[0]),
      `${c} must use COALESCE(daily_vitals_cache.${c}, EXCLUDED.${c}) — cache wins on overlap`);
  }
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
  // and roll back if any decreased.
  assert.ok(/if \(after\.rows\[0\]\[f\] < before\.rows\[0\]\[f\]\)/.test(src),
    'after-state must assert no field count regressed');
  assert.ok(/throw new Error\(['"]regression_detected['"]\)/.test(src),
    'regression must throw to roll back the transaction');
});
