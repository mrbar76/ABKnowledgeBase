// Phase 1 regression tests.
//
// Three production endpoints returned 500 in coaching sessions. Tests below
// cover the discovered root causes via DB-free unit checks (validators,
// route module loading, and the SQL-shape sanity that triggered the
// original failures).
//
// We can't hit Postgres from CI without setup, so DB-touching paths are
// verified by static analysis: read the route file, assert the bug pattern
// is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test';

// ─── Workouts route: PUT/PATCH JSONB cast bug ─────────────────────
test('workouts route loads', () => {
  const router = require('../routes/workouts');
  assert.equal(typeof router, 'function');
});

test('workouts: splits is NOT in JSONB_FIELDS (column is TEXT)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/workouts.js'), 'utf8');
  // Bug: splits in JSONB_FIELDS produced `splits = $N::jsonb` against TEXT column → 500
  const jsonbFieldsLine = src.match(/const JSONB_FIELDS = new Set\((\[[^\]]+\])\)/);
  assert.ok(jsonbFieldsLine, 'JSONB_FIELDS declaration found');
  const list = jsonbFieldsLine[1];
  assert.ok(!list.includes("'splits'"), 'splits must not be in JSONB_FIELDS — column is TEXT');
  assert.ok(!list.includes('"splits"'), 'splits must not be in JSONB_FIELDS — column is TEXT');
});

test('workouts: splits column is no longer referenced (Phase 2 dropped it)', () => {
  // v1.9.3 added TEXT_JSON_FIELDS to handle splits as TEXT-with-JSON.
  // v1.9.4 dropped the splits column entirely from workouts. If a future
  // refactor accidentally re-adds splits to WRITABLE_FIELDS or INSERT
  // statements, that's a regression — splits no longer exists.
  const src = fs.readFileSync(path.join(__dirname, '../routes/workouts.js'), 'utf8');
  // Allow comments mentioning the historical v1.9.3 fix; check INSERT/UPDATE only.
  const writable = src.match(/const WRITABLE_FIELDS = \[([\s\S]*?)\]/);
  assert.ok(writable && !/['"]splits['"]/.test(writable[1]),
    'splits must not be in WRITABLE_FIELDS (column dropped in v1.9.4)');
});

test('workouts: PATCH /:id is registered alongside PUT', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/workouts.js'), 'utf8');
  assert.ok(src.includes("router.patch('/:id'"), 'PATCH /:id route must be registered');
  assert.ok(src.includes("router.put('/:id'"), 'PUT /:id route must remain registered');
});

// ─── Transcripts route: GET /speakers endpoint ────────────────────
test('transcripts route loads', () => {
  const router = require('../routes/transcripts');
  assert.equal(typeof router, 'function');
});

test("transcripts: GET /speakers endpoint is registered", () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/transcripts.js'), 'utf8');
  assert.ok(src.includes("router.get('/speakers'"), 'GET /speakers must be registered');
  // Aggregation shape Phase 4 people layer expects
  assert.ok(src.includes('transcript_count'), 'must aggregate transcript_count');
  assert.ok(src.includes('last_seen'), 'must surface last_seen');
  assert.ok(src.includes('alias_matched'), 'must surface alias_matched per row');
  assert.ok(src.includes('contact_id'), 'must join to contacts and surface contact_id');
});

// ─── Insights route: /trends ReferenceError + monotony NaN ────────
test('insights route loads', () => {
  const router = require('../routes/insights');
  assert.equal(typeof router, 'function');
});

test('insights /trends: todayWorkoutActive is defined before use', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/insights.js'), 'utf8');
  // The bug: todayWorkoutActive was referenced without being declared,
  // throwing ReferenceError on every today-without-daily_activity-row case
  // (which is now permanent post-HAE-retirement, so 100% of /trends calls).
  const idx = src.indexOf('todayWorkoutActive > 0');
  assert.ok(idx > 0, 'todayWorkoutActive usage line must still exist');
  // Walk back ~500 chars and ensure todayWorkoutActive is declared
  const preceding = src.slice(Math.max(0, idx - 500), idx);
  assert.ok(/const\s+todayWorkoutActive\s*=/.test(preceding),
    'todayWorkoutActive must be declared (const) before its use');
});

test('insights /trends: monotony null-guards meanLast7', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/insights.js'), 'utf8');
  // Guard prevents 0/0 = NaN when all rest days
  assert.ok(/meanLast7\s*!=\s*null\s*&&\s*meanLast7\s*>\s*0/.test(src),
    'monotony calculation must guard against meanLast7 = 0 / null');
});

// ─── Bug A (v1.11.8): no alias-column collision in PUT/PATCH ──────
test('workouts PUT/PATCH: NUMERIC_FIELDS handles dual columns inline (no third loop)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/workouts.js'), 'utf8');
  // The bug was a third loop that re-wrote duration_minutes/hr_avg/etc.
  // even though WRITABLE_FIELDS already covered them, producing
  // "multiple assignments to same column" Postgres errors. v1.11.8 moved
  // numeric coercion into the first loop via NUMERIC_FIELDS Set.
  assert.ok(/const NUMERIC_FIELDS = new Set\(/.test(src),
    'NUMERIC_FIELDS Set must declare numeric duals for inline coercion');
  for (const col of ['duration_minutes', 'hr_avg', 'hr_max', 'cal_active', 'cadence']) {
    const re = new RegExp(`'${col}'`);
    assert.ok(re.test(src), `NUMERIC_FIELDS must include ${col}`);
  }
  // The redundant third loop should be gone — was iterating these same
  // numeric columns and pushing duplicate SET clauses.
  assert.ok(!/Allow direct numeric field updates/.test(src),
    'redundant "Allow direct numeric field updates" loop must be removed');
});

// ─── Bug B (v1.11.8): merge-on-undefined semantics, regression test ───
test('workouts PUT/PATCH: merge semantics — only present keys land in SET clause', () => {
  // Static check: handler iterates WRITABLE_FIELDS guarded by
  // `b[key] !== undefined`. Keys not in body are skipped, leaving the
  // existing column value intact. Documents the contract — if Coach saw
  // fields wiping, the request body was sending null/empty-string for
  // those keys (explicit clear, by design).
  const src = fs.readFileSync(path.join(__dirname, '../routes/workouts.js'), 'utf8');
  assert.ok(/b\[key\]\s*!==\s*undefined/.test(src),
    'handler must guard SET clause with b[key] !== undefined for merge-on-undefined');
  assert.ok(/Merge semantics/.test(src),
    'merge contract should be documented in handler comment block');
});

// ─── v1.11.8 dashboard adds last_attempt + is_at_baseline + next_phase ───
test('goals dashboard: emits last_attempt, is_at_baseline, current_value_date_iso, next_phase', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/goals.js'), 'utf8');
  assert.ok(/is_at_baseline:/.test(src), 'decorate() must emit is_at_baseline');
  assert.ok(/current_value_date_iso:/.test(src), 'decorate() must emit current_value_date_iso for client-TZ rendering');
  // last_attempt attached via property assignment (decorated.last_attempt = ...)
  assert.ok(/decorated\.last_attempt\s*=\s*await\s*lastAttemptFor/.test(src),
    'decorate flow must attach last_attempt from lastAttemptFor');
  assert.ok(/next_phase:/.test(src), 'dashboard response must include next_phase for between-phases header');
  assert.ok(/async function lastAttemptFor/.test(src), 'lastAttemptFor helper must exist');
});

// ─── v1.11.8 STATUS_URGENCY new sort order ────────────────────────
test('goals STATUS_URGENCY: at_risk → behind → on_track → pending → ahead', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/goals.js'), 'utf8');
  // Coach wants on_track before pending — most-needs-attention floats up,
  // pending falls below since it's awaiting first data point not stalled.
  const m = src.match(/at_risk:\s*0,\s*behind:\s*1,\s*on_track:\s*2,\s*pending:\s*3,\s*ahead:\s*4/);
  assert.ok(m, 'STATUS_URGENCY must order: at_risk(0) → behind(1) → on_track(2) → pending(3) → ahead(4)');
});

test('app.js: renderGoalRow surfaces baseline marker + last-attempt line', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.ok(/BASELINE SET/.test(src), 'progress bar must render baseline marker when is_at_baseline');
  assert.ok(/last attempt:/.test(src), 'renderGoalRow must include last-attempt line for sub-anchor sessions');
  assert.ok(/relativeDateLabel/.test(src), 'must define client-side relativeDateLabel for local-TZ rendering');
  assert.ok(/statusLabelFor/.test(src), 'must define dynamic statusLabelFor (Baseline vs No data)');
});

// ─── v1.11.9: Hevy sync exercises[] transform (Bug C) ─────────────
test('hevy: transformHevyExercises maps Hevy → AB Brain shape', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  assert.ok(/function transformHevyExercises/.test(src),
    'transformHevyExercises helper must exist');
  // Must convert weight_kg → weight_lbs
  assert.ok(/weight_lbs/.test(src), 'transform must produce weight_lbs');
  assert.ok(/2\.2046226218/.test(src), 'kg → lb conversion factor must be applied');
  // Must distinguish warmup sets so goal-compute can skip them
  assert.ok(/type === 'warmup'/.test(src) || /set_type === 'warmup'/.test(src),
    'must detect warmup set type');
});

test('hevy: sync INSERT writes exercises[] as JSONB + ON CONFLICT updates it', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  // Insert column list must include exercises (was metadata-only before)
  assert.ok(/JSONB_COLS = new Set\(\[['"]exercises['"], ?['"]metadata['"]\]\)/.test(src),
    'JSONB_COLS Set must include both exercises and metadata');
  // ON CONFLICT must refresh exercises so re-syncs of the same workout
  // get the latest set data
  assert.ok(/exercises = EXCLUDED\.exercises/.test(src),
    'ON CONFLICT must update exercises on re-sync');
});

test('hevy: POST /backfill-exercises endpoint exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  assert.ok(src.includes("router.post('/backfill-exercises'"),
    'POST /backfill-exercises must be registered for Bug C recovery');
  // Must skip rows that already have exercises
  assert.ok(/jsonb_array_length\(exercises\) = 0/.test(src),
    'backfill must filter to rows with empty exercises[]');
  // Must trigger goal recompute after to update Goals 1, 2, etc.
  assert.ok(/recomputeAllGoals/.test(src),
    'backfill must trigger goal recompute after rebuilding exercises');
});

test('hevy: mapHevyWorkoutToAB now populates exercises field', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  // The function should call transformHevyExercises and put result on
  // the row object that gets inserted.
  const fnBody = src.split('function mapHevyWorkoutToAB')[1].split('// ─── GET')[0];
  assert.ok(/exercises:\s*transformHevyExercises\(hw\.exercises\)/.test(fnBody),
    'mapHevyWorkoutToAB must populate exercises via transformHevyExercises');
  // Also writes duration_minutes (numeric dual)
  assert.ok(/duration_minutes:\s*durMin/.test(fnBody),
    'mapHevyWorkoutToAB should write duration_minutes for trends + goals');
});
