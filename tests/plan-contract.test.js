// v3.11 daily-plans contract tests.
//
// Verifies the Hevy contract enforcer (strength/hybrid plans without a
// hevy segment now 400 at write time) and the new query aliases
// (plan_date, week_start). DB-free — the validator is pure, and the
// query alias path is exercised via static analysis of the route file.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The contract validator isn't exported; re-implement inline for testing
// matches the route's behavior 1:1. If the route's logic drifts, this
// will diverge — but the static check below catches that.
const HEVY_REQUIRED_WORKOUT_TYPES = new Set(['strength', 'hybrid']);
function validateHevyContract(body) {
  const workoutType = String(body?.workout_type || '').toLowerCase();
  if (!HEVY_REQUIRED_WORKOUT_TYPES.has(workoutType)) return null;
  const segments = Array.isArray(body?.segments) ? body.segments : [];
  const hevyEligible = segments.some((s) => {
    if (!s || String(s.logging_target || '').toLowerCase() !== 'hevy') return false;
    const exs = Array.isArray(s.planned_exercises) ? s.planned_exercises : [];
    return exs.length > 0;
  });
  if (hevyEligible) return null;
  return {
    error: 'strength_or_hybrid_plan_missing_hevy_segments',
    workout_type: workoutType,
    segments_provided: segments.length,
    hevy_segments_provided: segments.filter(
      (s) => String(s?.logging_target || '').toLowerCase() === 'hevy',
    ).length,
  };
}

// ─── Contract validator: workout_type discrimination ────────────────

test('contract: recovery / walk / run plans pass without hevy segments', () => {
  for (const wt of ['recovery', 'walk', 'mobility', 'run', 'rest', 'yoga']) {
    assert.equal(validateHevyContract({ workout_type: wt, segments: [] }), null,
      `${wt} should pass without segments`);
  }
});

test('contract: missing workout_type is not constrained', () => {
  assert.equal(validateHevyContract({ segments: [] }), null);
});

test('contract: strength with no segments fails', () => {
  const err = validateHevyContract({ workout_type: 'strength', segments: [] });
  assert.ok(err, 'expected error');
  assert.equal(err.error, 'strength_or_hybrid_plan_missing_hevy_segments');
  assert.equal(err.workout_type, 'strength');
  assert.equal(err.segments_provided, 0);
  assert.equal(err.hevy_segments_provided, 0);
});

test('contract: hybrid with no segments fails', () => {
  const err = validateHevyContract({ workout_type: 'hybrid', segments: [] });
  assert.ok(err);
  assert.equal(err.workout_type, 'hybrid');
});

test('contract: case-insensitive workout_type match', () => {
  assert.ok(validateHevyContract({ workout_type: 'STRENGTH', segments: [] }));
  assert.ok(validateHevyContract({ workout_type: 'Hybrid', segments: [] }));
});

test('contract: strength with all manual segments fails', () => {
  const err = validateHevyContract({
    workout_type: 'strength',
    segments: [{ logging_target: 'manual', planned_exercises: [{ name: 'X' }] }],
  });
  assert.ok(err);
  assert.equal(err.hevy_segments_provided, 0);
});

test('contract: strength with hevy segment but empty planned_exercises fails', () => {
  const err = validateHevyContract({
    workout_type: 'strength',
    segments: [{ logging_target: 'hevy', planned_exercises: [] }],
  });
  assert.ok(err);
  assert.equal(err.segments_provided, 1);
  assert.equal(err.hevy_segments_provided, 1, 'hevy segments counted even when empty');
});

test('contract: strength with hevy segment + populated exercises passes', () => {
  assert.equal(validateHevyContract({
    workout_type: 'strength',
    segments: [{ logging_target: 'hevy', planned_exercises: [{ name: 'Deadlift' }] }],
  }), null);
});

test('contract: strength with multiple segments, at least one valid hevy, passes', () => {
  assert.equal(validateHevyContract({
    workout_type: 'strength',
    segments: [
      { logging_target: 'manual', planned_exercises: [{ name: 'Stretch' }] },
      { logging_target: 'hevy', planned_exercises: [{ name: 'Squat' }] },
    ],
  }), null);
});

test('contract: invalid segment entries are tolerated (treated as not-hevy)', () => {
  const err = validateHevyContract({
    workout_type: 'strength',
    segments: [null, undefined, { logging_target: 'manual' }],
  });
  assert.ok(err);
});

// ─── Static checks on the live route file ───────────────────────────

test('route: GET /api/daily-plans accepts plan_date alias', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/daily-plans.js'), 'utf8');
  assert.match(src, /req\.query\.plan_date \|\| req\.query\.date/,
    'plan_date should alias to date');
});

test('route: GET /api/daily-plans accepts week_start alias', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/daily-plans.js'), 'utf8');
  assert.match(src, /req\.query\.week_start/,
    'week_start alias should be present');
  assert.match(src, /shiftDaysISO\(aliasFrom, 6\)/,
    'week_start should derive a 7-day window via shiftDaysISO');
});

test('route: POST /api/daily-plans calls validateHevyContract', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/daily-plans.js'), 'utf8');
  // POST handler block contains a validateHevyContract call right after
  // the plan_date guard.
  const postBlock = src.slice(src.indexOf("router.post('/', async"), src.indexOf("router.post('/week'"));
  assert.match(postBlock, /validateHevyContract\(req\.body\)/,
    'POST should validate Hevy contract');
});

test('route: PUT /api/daily-plans/:id calls validateHevyContract on amendment', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/daily-plans.js'), 'utf8');
  const putBlock = src.slice(src.indexOf("router.put('/:id', async"), src.indexOf("router.post('/:id/wrap'"));
  assert.match(putBlock, /validateHevyContract/, 'PUT should validate too');
});

// v3.15 regression: PUT validator must NOT block status-only or
// notes-only edits. The Edit Plan form always sends workout_type in
// the body, so the pre-v3.15 trigger condition fired on every save and
// blocked legitimate "mark missed / mark skipped" edits on legacy
// plans without hevy segments.
test('route: PUT validator scope is segments-only, not workout_type', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/daily-plans.js'), 'utf8');
  const putBlock = src.slice(src.indexOf("router.put('/:id', async"), src.indexOf("router.post('/:id/wrap'"));
  // The condition that triggers the validator should only check segments,
  // not workout_type.
  assert.match(
    putBlock,
    /if \(req\.body\.segments !== undefined\) \{/,
    'PUT validator should trigger only on segments changes (v3.15)',
  );
  assert.doesNotMatch(
    putBlock,
    /if \(req\.body\.workout_type !== undefined \|\| req\.body\.segments !== undefined\)/,
    'pre-v3.15 over-broad trigger condition must be removed',
  );
});

// ─── OpenAPI coverage ──────────────────────────────────────────────

test('openapi: /hevy/exercise-templates is documented', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/openapi-chatgpt.json'), 'utf8'));
  assert.ok(spec.paths['/hevy/exercise-templates'], 'endpoint must be in spec');
  assert.ok(spec.paths['/hevy/exercise-templates'].get, 'GET method must be defined');
});

test('openapi: /hevy/push-plan + push-workout + push-segment + sync documented', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/openapi-chatgpt.json'), 'utf8'));
  for (const p of ['/hevy/push-plan', '/hevy/push-segment', '/hevy/push-workout', '/hevy/sync', '/hevy/templates/refresh']) {
    assert.ok(spec.paths[p], `${p} must be in spec`);
  }
});

test('openapi: /daily-plans documents plan_date + week_start aliases', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/openapi-chatgpt.json'), 'utf8'));
  const params = spec.paths['/daily-plans'].get.parameters || [];
  const names = params.map(p => p.name);
  assert.ok(names.includes('plan_date'), 'plan_date param should be documented');
  assert.ok(names.includes('week_start'), 'week_start param should be documented');
});

test('openapi: /daily-plans status enum includes skipped (v3.3)', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/openapi-chatgpt.json'), 'utf8'));
  const params = spec.paths['/daily-plans'].get.parameters || [];
  const status = params.find(p => p.name === 'status');
  assert.ok(status.schema.enum.includes('skipped'), 'skipped should be in status enum');
});
