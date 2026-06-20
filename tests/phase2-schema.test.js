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

test('workouts: WORKOUT_TEXT_FIELDS does not list dropped cols', () => {
  // Lists drive cleanFields/cleanRows over SELECT results. Dropped columns
  // won't be on rows but listing them invites future copy-paste regressions.
  const src = readRoute('workouts');
  const m = src.match(/const WORKOUT_TEXT_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'WORKOUT_TEXT_FIELDS declared');
  const list = m[1];
  for (const col of ['adjustment', 'splits', 'pace_avg', 'cadence_avg']) {
    assert.ok(!new RegExp(`['"]${col}['"]`).test(list),
      `${col} must not be in WORKOUT_TEXT_FIELDS (dropped in v1.9.4)`);
  }
});

// ─── routes/health.js: Apple Health ingest SQL — the production-bug surface ──
test('health.js: Apple Health UPSERT does not reference dropped cols', () => {
  // routes/health.js held the actual runtime bug: every Apple Health workout
  // INSERT/UPSERT failed silently (caught + logged, never surfaced) because
  // the SQL referenced pace_avg after db.js dropped the column.
  //
  // Anchor on the backtick template-literal boundary so the match stays
  // inside one SQL statement instead of spilling across surrounding JS
  // (in-memory objects like `{ pace_avg: ... }` are intentional payload
  // shapes and shouldn't trip the assertion).
  const src = readRoute('health');
  // Apple-health merge UPDATE: the one whose body starts with time_duration.
  const updateMatch = src.match(/`UPDATE workouts SET\s+time_duration[\s\S]*?WHERE id = \$1`/);
  assert.ok(updateMatch, 'merge UPDATE statement present');
  // Apple-health INSERT...ON CONFLICT: confined to its own template literal.
  const insertMatch = src.match(/`\s*INSERT INTO workouts \([\s\S]*?RETURNING[^`]*`/);
  assert.ok(insertMatch, 'apple_health INSERT ... ON CONFLICT statement present');
  for (const sql of [updateMatch[0], insertMatch[0]]) {
    for (const col of ['pace_avg', 'splits', 'cadence_avg']) {
      assert.ok(!new RegExp(`\\b${col}\\b`).test(sql),
        `${col} must not appear in apple_health ingest SQL (dropped in v1.9.4)`);
    }
  }
});

test('health.js: SENSOR_FIELDS used by dedupe scoring omits dropped cols', () => {
  // SENSOR_FIELDS drives pickSurvivor() during cross-source dedupe. Listing
  // dropped columns here makes the score function always 0 for them, which
  // is harmless on read but misleading documentation.
  const src = readRoute('health');
  const m = src.match(/const SENSOR_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'SENSOR_FIELDS declared');
  const list = m[1];
  for (const col of ['pace_avg', 'splits', 'cadence_avg', 'adjustment']) {
    assert.ok(!new RegExp(`['"]${col}['"]`).test(list),
      `${col} must not be in SENSOR_FIELDS (dropped in v1.9.4)`);
  }
});

test('health.js: dedupe SELECT does not request dropped cols', () => {
  const src = readRoute('health');
  // The candidates SELECT inside dedupeAppleWorkouts pulls workout rows
  // for parent-overlap scoring. Same dropped-col risk.
  const selectMatch = src.match(/SELECT id, started_at, ended_at,[\s\S]*?FROM workouts/);
  assert.ok(selectMatch, 'dedupe candidates SELECT present');
  for (const col of ['pace_avg', 'splits', 'cadence_avg']) {
    assert.ok(!new RegExp(`\\b${col}\\b`).test(selectMatch[0]),
      `${col} must not appear in dedupe SELECT`);
  }
});

// ─── routes/coach.js: SELECTs no longer ask for dropped cols ─────────
test('coach.js: cleanFields/cleanRows do not reference dropped cols', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/coach.js'), 'utf8');
  // The coach endpoint passes column lists to cleanFields/cleanRows over
  // workout rows. If those rows came from a SELECT that asked for dropped
  // columns, the SELECT would 500 first; defensively also keep the list
  // accurate.
  const calls = src.match(/clean(Fields|Rows)\([^)]*\)/g) || [];
  for (const call of calls) {
    assert.ok(!/['"]adjustment['"]/.test(call),
      `adjustment must not appear in coach.js clean call: ${call.slice(0, 80)}`);
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
  // v1.10.3: is_stale GENERATED column dropped (NOW() not immutable for STORED).
  // Replaced with inline derivation in coach.js queries.
  assert.ok(/daily_vitals_cache -is_stale/.test(src),
    'is_stale must be dropped (GENERATED + NOW() incompatible)');
  assert.ok(!/daily_vitals_cache \+is_stale/.test(src),
    'must NOT attempt to add is_stale as a generated column');
});

test('coach.js: is_stale derived inline (not from a column)', () => {
  const coachSrc = fs.readFileSync(path.join(__dirname, '../routes/coach.js'), 'utf8');
  // The cache_is_stale alias must be derived from updated_at, not selected
  // from a non-existent column.
  assert.ok(/\(c\.updated_at < NOW\(\) - INTERVAL '6 hours'\)\s+AS\s+cache_is_stale/i.test(coachSrc),
    'coach.js must derive cache_is_stale inline from updated_at');
  assert.ok(!/c\.is_stale\s+AS/i.test(coachSrc),
    'coach.js must not select c.is_stale as a column (does not exist)');
});

// ─── Phase B: workouts.adjustment fully excised from the schema ─────
test('db.js: workouts CREATE TABLE no longer declares adjustment column', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  // Match the CREATE TABLE IF NOT EXISTS workouts (...) block. The column
  // list ends at the closing paren before the index/trigger statements.
  const m = src.match(/CREATE TABLE IF NOT EXISTS workouts \(([\s\S]*?)\n\s*\)/);
  assert.ok(m, 'workouts CREATE TABLE block present');
  assert.ok(!/\badjustment\b/.test(m[1]),
    'adjustment must not be in the workouts CREATE TABLE column list');
});

test('db.js: no ADD COLUMN ... adjustment (no resurrection)', () => {
  // The add-then-drop shuttle was the original sin. Removing the ADD
  // closes that loop and protects the slot budget.
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  assert.ok(!/ALTER TABLE workouts ADD COLUMN IF NOT EXISTS adjustment\b/i.test(src),
    'workouts.adjustment must not have an ADD COLUMN migration anymore');
});

test('db.js: update_workouts_search trigger does not reference adjustment', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  const fnMatch = src.match(/CREATE OR REPLACE FUNCTION update_workouts_search[\s\S]*?\$\$ LANGUAGE plpgsql/);
  assert.ok(fnMatch, 'update_workouts_search function present');
  assert.ok(!/NEW\.adjustment/.test(fnMatch[0]),
    'trigger function must not reference NEW.adjustment (blocks the DROP)');
  const triggerMatch = src.match(/CREATE TRIGGER trg_workouts_search[\s\S]*?update_workouts_search\(\)/);
  assert.ok(triggerMatch, 'trg_workouts_search DDL present');
  assert.ok(!/\badjustment\b/.test(triggerMatch[0]),
    'trigger DDL must not list adjustment in UPDATE OF columns');
});

test('db.js: search_vector backfill for workouts does not reference adjustment', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  const m = src.match(/backfill workouts search[\s\S]*?WHERE search_vector IS NULL`/);
  assert.ok(m, 'backfill workouts search statement present');
  assert.ok(!/\badjustment\b/.test(m[0]),
    'workouts search backfill must not reference adjustment');
});

test('db.js: adjustment snapshot migration runs before the DROP', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  // The snapshot copies the column value into metadata.legacy_adjustment
  // so the irreversible DROP doesn't lose user-typed text. Two conditions:
  // (1) the snapshot tag exists and uses information_schema gating;
  // (2) it appears before the DROP COLUMN statement in source order.
  const snapshotIdx = src.indexOf("safeQuery('workouts adjustment snapshot'");
  const dropIdx = src.indexOf("safeQuery('workouts -adjustment'");
  assert.ok(snapshotIdx > 0, 'snapshot migration must exist');
  assert.ok(dropIdx > 0, 'DROP COLUMN migration must still exist');
  assert.ok(snapshotIdx < dropIdx,
    'snapshot must run BEFORE the DROP (otherwise the column data is lost)');
  // Idempotency gate
  const snapshotBlock = src.slice(snapshotIdx, dropIdx);
  assert.ok(/information_schema\.columns/.test(snapshotBlock),
    'snapshot must gate on information_schema so post-drop boots no-op');
  assert.ok(/legacy_adjustment/.test(snapshotBlock),
    'snapshot must write metadata.legacy_adjustment');
  assert.ok(/NOT \(COALESCE\(metadata.*?\) \? 'legacy_adjustment'\)/.test(snapshotBlock),
    'snapshot must skip rows already snapshotted (idempotent for repeat boots)');
});
