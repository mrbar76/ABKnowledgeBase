// Static safety guards for scripts/drop-daily-activity-movement-cols.js
// (v3.34 #2 part B — drop the 7 movement + energy columns from
// daily_activity AFTER the consolidate script backfills them into
// daily_vitals_cache).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../scripts/drop-daily-activity-movement-cols.js'), 'utf8');

test('drop-movement-cols: default is dry run (apply must be explicit)', () => {
  assert.ok(/const apply = process\.argv\.includes\(['"]--apply['"]\)/.test(src),
    'apply flag must be read from argv');
  assert.ok(/__DRY_RUN__/.test(src),
    'dry-run path must throw a __DRY_RUN__ sentinel to force rollback');
});

test('drop-movement-cols: targets ONLY the 7 movement + energy columns', () => {
  const m = src.match(/const COLUMNS_TO_DROP = \[([\s\S]*?)\];/);
  assert.ok(m, 'COLUMNS_TO_DROP list present');
  const list = m[1];
  const required = [
    'steps', 'distance_mi', 'exercise_minutes', 'flights_climbed',
    'workout_count', 'active_energy_kcal', 'basal_energy_kcal',
  ];
  for (const col of required) {
    assert.ok(new RegExp(`['"]${col}['"]`).test(list),
      `COLUMNS_TO_DROP must include '${col}' (v3.34 #2 selective absorb scope)`);
  }
  // Must NOT include sleep-phase or walking/mobility columns —
  // they stay on daily_activity until the whole table drops on Aug 5.
  for (const col of ['sleep_deep_min', 'sleep_rem_min', 'sleep_core_min',
                     'sleep_awake_min', 'sleep_efficiency_pct',
                     'vo2_max', 'walking_hr_avg_bpm', 'walking_speed_mph',
                     'walking_steadiness_pct', 'walking_asymmetry_pct',
                     'walking_step_length_in', 'stand_hours', 'stand_minutes']) {
    assert.ok(!new RegExp(`['"]${col}['"]`).test(list),
      `COLUMNS_TO_DROP must NOT include '${col}' (stays until Aug 5 table drop)`);
  }
});

test('drop-movement-cols: pre-flight blocks when consolidation incomplete', () => {
  // The script must refuse to drop columns whose source data isn't yet
  // mirrored in daily_vitals_cache. Otherwise the DROP loses data.
  assert.ok(/da\.\$\{col\} IS NOT NULL/.test(src),
    'pre-flight must check rows where daily_activity column is non-null');
  assert.ok(/c\.\$\{col\} IS NULL OR c\.date IS NULL/.test(src),
    'pre-flight must require non-null daily_vitals_cache counterpart');
  assert.ok(/unbacked_data_present/.test(src),
    'pre-flight failure must throw unbacked_data_present to roll back');
  assert.ok(/BLOCKED:[\s\S]*?consolidate-daily-activity-to-vitals\.js --apply/.test(src),
    'block message must name the prerequisite script');
});

test('drop-movement-cols: entire flow wrapped in withTransaction', () => {
  assert.ok(/await withTransaction\(async \(client\) => \{/.test(src),
    'must use withTransaction wrapper');
  // DROP must use client.query so it stays inside the transaction.
  assert.ok(/client\.query\(`ALTER TABLE daily_activity DROP COLUMN IF EXISTS/.test(src),
    'DROP must use client.query (transactional)');
});

test('drop-movement-cols: post-drop verification', () => {
  // After the DROP loop, the script must re-check information_schema
  // for each dropped column. A surviving column = silent failure (likely
  // a trigger dependency we missed) and must roll back.
  assert.ok(/post_drop_verification/.test(src),
    'must throw post_drop_verification if a dropped column still exists');
});

test('drop-movement-cols: no-op when columns already gone (idempotent)', () => {
  assert.ok(/stillPresent\.length === 0/.test(src),
    'must detect zero present columns and exit early');
  assert.ok(/__NO_OP__/.test(src),
    'no-op path must throw a sentinel so the transaction rolls back without side effects');
});

test('db.js: daily_vitals_cache schema gained the 7 absorb columns', () => {
  // The consolidate script targets these; if db.js didn't add them via
  // ALTER TABLE, the UPSERT will fail on first run with "column does
  // not exist". This is the structural invariant.
  const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  for (const col of ['steps', 'distance_mi', 'exercise_minutes',
                     'flights_climbed', 'workout_count',
                     'active_energy_kcal', 'basal_energy_kcal']) {
    // Match the safeQuery label, which has format: `'daily_vitals_cache +<col>'`
    // (the +<col> token is followed by the closing quote of the label).
    assert.ok(new RegExp(`'daily_vitals_cache \\+${col}'`).test(dbSrc),
      `db.js must have a "daily_vitals_cache +${col}" ADD COLUMN migration`);
  }
});
