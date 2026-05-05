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

test('workouts: TEXT_JSON_FIELDS handles splits stringification', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/workouts.js'), 'utf8');
  assert.ok(/TEXT_JSON_FIELDS\s*=\s*new Set\([^)]*['"]splits['"]/.test(src),
    'TEXT_JSON_FIELDS must include splits so PUT/PATCH stringifies it into a TEXT column');
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
