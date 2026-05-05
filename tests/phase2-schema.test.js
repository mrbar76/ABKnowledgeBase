// Phase 2 schema cleanup regression tests.
//
// We can't run the migration against a live DB from CI, so instead we
// statically assert that route INSERT statements no longer reference the
// dropped columns. If they did, INSERT would 500 against the migrated
// schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readRoute(name) {
  return fs.readFileSync(path.join(__dirname, `../routes/${name}.js`), 'utf8');
}

// ─── workouts: cadence_avg, splits, pace_avg, adjustment dropped ──
test('workouts: WRITABLE_FIELDS does not include dropped cols', () => {
  const src = readRoute('workouts');
  const m = src.match(/const WRITABLE_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'WRITABLE_FIELDS declared');
  const list = m[1];
  assert.ok(!/['"]pace_avg['"]/.test(list), "pace_avg must not be in WRITABLE_FIELDS");
  assert.ok(!/['"]splits['"]/.test(list), "splits must not be in WRITABLE_FIELDS");
  assert.ok(!/['"]cadence_avg['"]/.test(list), "cadence_avg must not be in WRITABLE_FIELDS");
  assert.ok(!/['"]adjustment['"]/.test(list), "adjustment must not be in WRITABLE_FIELDS");
});

test('workouts: POST INSERT does not reference dropped cols', () => {
  const src = readRoute('workouts');
  // Find the INSERT INTO workouts block
  const insertMatch = src.match(/INSERT INTO workouts \(([\s\S]*?)\) VALUES/g);
  assert.ok(insertMatch && insertMatch.length >= 2,
    'expected at least 2 INSERT INTO workouts statements (POST + bulk)');
  for (const block of insertMatch) {
    assert.ok(!/\bpace_avg\b/.test(block), `pace_avg must not appear in: ${block.slice(0,50)}...`);
    assert.ok(!/\bsplits\b/.test(block), `splits must not appear in: ${block.slice(0,50)}...`);
    assert.ok(!/\bcadence_avg\b/.test(block), `cadence_avg must not appear in: ${block.slice(0,50)}...`);
    assert.ok(!/\badjustment\b/.test(block), `adjustment must not appear in: ${block.slice(0,50)}...`);
  }
});

// ─── meals: fiber_g, sugar_g, sodium_mg, serving_size dropped ──────
test('meals: INSERT_SQL does not reference dropped cols', () => {
  const src = readRoute('meals');
  const m = src.match(/const INSERT_SQL = `([\s\S]*?)`/);
  assert.ok(m, 'INSERT_SQL declared');
  const sql = m[1];
  for (const col of ['fiber_g', 'sugar_g', 'sodium_mg', 'serving_size']) {
    assert.ok(!new RegExp(`\\b${col}\\b`).test(sql), `${col} must not appear in INSERT_SQL`);
  }
});

test('meals: PATCH allowed list omits dropped cols', () => {
  const src = readRoute('meals');
  // The validateMeal function and PATCH allowed list both filter input.
  // After v1.9.4, dropped fields silently fall off — old clients sending
  // them won't error.
  const validateBlock = src.match(/function validateMeal[\s\S]*?return errors;\s*\}/);
  assert.ok(validateBlock, 'validateMeal function present');
  const macroLoop = validateBlock[0].match(/for \(const f of \[([^\]]+)\]\)/);
  assert.ok(macroLoop, 'macro validation loop present');
  for (const col of ['fiber_g', 'sugar_g']) {
    assert.ok(!new RegExp(`['"]${col}['"]`).test(macroLoop[1]),
      `${col} must not be in macro validation loop`);
  }
});

// ─── injuries: treatment, tags dropped ─────────────────────────────
test('injuries: INSERT does not reference dropped cols', () => {
  const src = readRoute('training');
  const insertMatch = src.match(/INSERT INTO injuries \(([\s\S]*?)\)/);
  assert.ok(insertMatch, 'INSERT INTO injuries found');
  const cols = insertMatch[1];
  assert.ok(!/\btreatment\b/.test(cols), 'treatment must not be in injuries INSERT');
  assert.ok(!/\btags\b/.test(cols), 'tags must not be in injuries INSERT');
});

// ─── races: expected_weather, goal_process dropped ─────────────────
test('races: RACE_FIELDS does not include dropped cols', () => {
  const src = readRoute('races');
  const m = src.match(/const RACE_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'RACE_FIELDS declared');
  const list = m[1];
  assert.ok(!/['"]expected_weather['"]/.test(list), 'expected_weather must not be in RACE_FIELDS');
  assert.ok(!/['"]goal_process['"]/.test(list), 'goal_process must not be in RACE_FIELDS');
});

// ─── daily_vitals_cache: sleep stages, wrist temp, SpO2, source_device dropped ──
test('daily_vitals_cache: v2-vitals.js INSERT has only Series-3 fields', () => {
  const src = readRoute('v2-vitals');
  // Find the INSERT statement in the SQL template literal — multi-line
  // template, closing `)` and `VALUES` separated by whitespace + newlines.
  const insertMatch = src.match(/INSERT INTO daily_vitals_cache \(([\s\S]*?)\)\s*VALUES/);
  assert.ok(insertMatch, 'INSERT INTO daily_vitals_cache found');
  const cols = insertMatch[1];
  for (const col of [
    'sleep_deep_min', 'sleep_rem_min', 'sleep_core_min', 'sleep_awake_min',
    'wrist_temp_c', 'spo2_pct', 'source_device',
  ]) {
    assert.ok(!new RegExp(`\\b${col}\\b`).test(cols),
      `${col} must not appear in daily_vitals_cache INSERT`);
  }
  // Sanity: kept fields are still there
  for (const col of ['hrv_ms', 'rhr_bpm', 'sleep_total_min', 'respiratory_rate_bpm']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(cols),
      `${col} must remain in daily_vitals_cache INSERT`);
  }
});

// ─── db.js: migration uses ADD/DROP COLUMN IF (NOT) EXISTS ─────────
test('db.js: Phase 2 migrations are idempotent (IF EXISTS / IF NOT EXISTS)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  // Sample of dropped cols — assert each has IF EXISTS guard
  const droppedCols = [
    'workouts -cadence_avg', 'workouts -splits', 'workouts -pace_avg', 'workouts -adjustment',
    'meals -fiber_g', 'meals -sugar_g', 'meals -sodium_mg', 'meals -serving_size',
    'injuries -treatment', 'injuries -tags',
    'races -expected_weather', 'races -goal_process',
    'daily_vitals_cache -sleep_deep_min', 'daily_vitals_cache -sleep_rem_min',
    'daily_vitals_cache -sleep_core_min', 'daily_vitals_cache -sleep_awake_min',
    'daily_vitals_cache -source_device',
  ];
  for (const op of droppedCols) {
    const tag = op.replace(/[+-]/g, '\\$&');
    assert.ok(new RegExp(`safeQuery\\(['"]${tag}['"]`).test(src),
      `migration tag "${op}" must be present in db.js`);
  }
  // Body_metrics RENPHO BIA columns must NOT have a DROP guard — they're kept per Avi's override
  assert.ok(!/body_metrics -bmi/.test(src), 'body_metrics.bmi must not be dropped');
  assert.ok(!/body_metrics -visceral_fat/.test(src), 'body_metrics.visceral_fat must not be dropped');
  assert.ok(!/body_metrics -metabolic_age/.test(src), 'body_metrics.metabolic_age must not be dropped');
  // is_stale generated column added
  assert.ok(/daily_vitals_cache \+is_stale/.test(src), 'is_stale generated column must be added');
});
