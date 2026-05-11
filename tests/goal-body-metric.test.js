// v3.17 body-metric goal driver tests.
//
// Tests the new latest_body_value driver that pulls from body_metrics
// rows instead of workouts. Plus regression tests for the
// computeValueForGoal dispatch.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const compute = require('../lib/goal-compute');

function metric(overrides = {}) {
  return {
    id: 'bm-' + Math.random().toString(36).slice(2, 8),
    measurement_date: '2026-05-10',
    weight_lb: null,
    body_fat_pct: null,
    lean_mass_lb: null,
    skeletal_muscle_pct: null,
    bmi: null,
    ...overrides,
  };
}

function goal(overrides = {}) {
  return {
    id: 'g-1',
    compute_method: 'latest_body_value',
    metric: 'weight_lb',
    ...overrides,
  };
}

// ─── Driver behavior ────────────────────────────────────────────────

test('latest_body_value: returns null when no metrics provided', () => {
  const r = compute._drivers.latest_body_value(goal(), []);
  assert.equal(r.value, null);
  assert.equal(r.source_workout, null);
});

test('latest_body_value: returns null when metrics provided but column null', () => {
  const r = compute._drivers.latest_body_value(goal({ metric: 'weight_lb' }), [
    metric({ measurement_date: '2026-05-10', weight_lb: null }),
  ]);
  assert.equal(r.value, null);
});

test('latest_body_value: returns latest non-null weight_lb', () => {
  // bodyMetrics sorted DESC by measurement_date — newest first.
  const r = compute._drivers.latest_body_value(goal({ metric: 'weight_lb' }), [
    metric({ id: 'm-3', measurement_date: '2026-05-10', weight_lb: 175.2 }),
    metric({ id: 'm-2', measurement_date: '2026-05-09', weight_lb: 175.8 }),
    metric({ id: 'm-1', measurement_date: '2026-05-08', weight_lb: 176.4 }),
  ]);
  assert.equal(r.value, 175.2);
  assert.equal(r.source_body_metric_id, 'm-3');
  assert.equal(r.source_date, '2026-05-10');
  assert.equal(r.source_workout, null);
});

test('latest_body_value: skips most-recent row when target column is null', () => {
  // RENPHO sometimes reports body fat but not skeletal muscle, etc.
  // The driver should walk past nulls to find the latest populated
  // reading for the requested column.
  const r = compute._drivers.latest_body_value(goal({ metric: 'body_fat_pct' }), [
    metric({ id: 'm-3', measurement_date: '2026-05-10', weight_lb: 175.2, body_fat_pct: null }),
    metric({ id: 'm-2', measurement_date: '2026-05-09', body_fat_pct: 17.3 }),
    metric({ id: 'm-1', measurement_date: '2026-05-08', body_fat_pct: 17.8 }),
  ]);
  assert.equal(r.value, 17.3);
  assert.equal(r.source_body_metric_id, 'm-2');
});

test('latest_body_value: handles lean_mass_lb', () => {
  const r = compute._drivers.latest_body_value(goal({ metric: 'lean_mass_lb' }), [
    metric({ measurement_date: '2026-05-10', lean_mass_lb: 145.3 }),
  ]);
  assert.equal(r.value, 145.3);
});

test('latest_body_value: handles skeletal_muscle_pct + bmi', () => {
  assert.equal(
    compute._drivers.latest_body_value(goal({ metric: 'skeletal_muscle_pct' }), [
      metric({ skeletal_muscle_pct: 42.1 }),
    ]).value,
    42.1,
  );
  assert.equal(
    compute._drivers.latest_body_value(goal({ metric: 'bmi' }), [
      metric({ bmi: 24.5 }),
    ]).value,
    24.5,
  );
});

test('latest_body_value: bf_pct alias maps to body_fat_pct column', () => {
  const r = compute._drivers.latest_body_value(goal({ metric: 'bf_pct' }), [
    metric({ body_fat_pct: 17.5 }),
  ]);
  assert.equal(r.value, 17.5);
});

test('latest_body_value: unknown metric returns null', () => {
  const r = compute._drivers.latest_body_value(goal({ metric: 'something_unknown' }), [
    metric({ weight_lb: 175 }),
  ]);
  assert.equal(r.value, null);
});

test('latest_body_value: invalid value (NaN/string) is skipped', () => {
  const r = compute._drivers.latest_body_value(goal({ metric: 'weight_lb' }), [
    metric({ id: 'bad', weight_lb: 'heavy' }),
    metric({ id: 'good', weight_lb: 175 }),
  ]);
  assert.equal(r.value, 175);
  assert.equal(r.source_body_metric_id, 'good');
});

// ─── Dispatch routing ───────────────────────────────────────────────

test('computeValueForGoal: body-metric goal reads from bodyMetrics, not workouts', () => {
  const r = compute.computeValueForGoal(
    goal({ compute_method: 'latest_body_value', metric: 'weight_lb' }),
    [{ workout_date: '2026-05-10', workout_type: 'strength' }], // workouts — ignored
    [metric({ weight_lb: 175 })],
  );
  assert.equal(r.value, 175);
});

test('computeValueForGoal: workout-driver goal ignores bodyMetrics', () => {
  // A strength goal with empty workouts should return null even if
  // bodyMetrics is non-empty — the driver dispatch must route by
  // compute_method, not by available data.
  const r = compute.computeValueForGoal(
    goal({ compute_method: 'max_weight', metric: 'weight_lb', linked_exercise_names: ['Deadlift'] }),
    [], // workouts empty
    [metric({ weight_lb: 175 })], // body metrics present — should be ignored
  );
  assert.equal(r.value, null);
});

test('computeValueForGoal: manual goals return null regardless of data', () => {
  const r = compute.computeValueForGoal(
    goal({ compute_method: 'manual' }),
    [],
    [metric({ weight_lb: 175 })],
  );
  assert.equal(r.value, null);
});

// ─── Exports + hook wiring ──────────────────────────────────────────

test('lib exports BODY_METRIC_COMPUTE_METHODS set', () => {
  assert.ok(compute.BODY_METRIC_COMPUTE_METHODS instanceof Set);
  assert.ok(compute.BODY_METRIC_COMPUTE_METHODS.has('latest_body_value'));
});

test('lib exports BODY_METRIC_COLUMNS map', () => {
  assert.equal(typeof compute.BODY_METRIC_COLUMNS, 'object');
  assert.equal(compute.BODY_METRIC_COLUMNS.weight_lb, 'weight_lb');
  assert.equal(compute.BODY_METRIC_COLUMNS.bf_pct, 'body_fat_pct');
});

test('routes/body-metrics.js POST hooks goal recompute', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/body-metrics.js'), 'utf8');
  assert.match(src, /require\('\.\/goals'\)/, 'must require goals route');
  assert.match(src, /recomputeForBodyMetric/, 'must reference the new hook');
});

test('routes/goals.js exports recomputeForBodyMetric', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/goals.js'), 'utf8');
  assert.match(
    src,
    /module\.exports\.recomputeForBodyMetric = recomputeForBodyMetric/,
    'goals route must export the new hook',
  );
});

test('routes/goals.js recomputeOneGoal branches on BODY_METRIC_COMPUTE_METHODS', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/goals.js'), 'utf8');
  assert.match(
    src,
    /BODY_METRIC_COMPUTE_METHODS\.has\(goal\.compute_method\)/,
    'recomputeOneGoal must dispatch on compute_method',
  );
});
