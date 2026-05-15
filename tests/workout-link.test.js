// Pure-function tests for lib/workout-link.js — the consolidated
// auto-link helper. Verifies the precedence rules and fallback
// observability that fix the 5/14 mis-routing bug.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { linkWorkoutToPlan, targetPrefFromSource } = require('../lib/workout-link');

// ─── targetPrefFromSource ────────────────────────────────────────────

test('targetPrefFromSource: apple_health source → apple_health target', () => {
  assert.equal(targetPrefFromSource('apple_health'), 'apple_health');
});

test('targetPrefFromSource: hevy source → hevy target', () => {
  assert.equal(targetPrefFromSource('hevy'), 'hevy');
});

test('targetPrefFromSource: manual / null / unknown → manual', () => {
  assert.equal(targetPrefFromSource('manual'), 'manual');
  assert.equal(targetPrefFromSource(null), 'manual');
  assert.equal(targetPrefFromSource('import'), 'manual');
});

// ─── linkWorkoutToPlan: precedence ───────────────────────────────────

function fakeQuery(handlers) {
  let i = 0;
  return async (sql, params) => {
    const h = handlers[i++];
    if (!h) {
      throw new Error(`unexpected query #${i}: ${String(sql).slice(0, 80)}`);
    }
    const rows = await h(sql, params);
    return { rows: rows || [] };
  };
}

test('precedence: planId+segmentId pre-supplied with force=false → no lookup, just status update', async () => {
  const calls = [];
  const q = async (sql, params) => {
    calls.push({ sql: String(sql).trim().split('\n')[0], params });
    return { rows: [] };
  };
  const r = await linkWorkoutToPlan({
    workoutId: 'W1',
    workoutDate: '2026-05-14',
    source: 'manual',
    planSegmentId: 'S1',
    dailyPlanId: 'P1',
  }, q);
  assert.equal(r.linked, true);
  assert.equal(r.already_linked, true);
  // Only one query — the segment status update. NO lookup query.
  assert.equal(calls.length, 1);
  assert.ok(/UPDATE plan_segments/.test(calls[0].sql));
});

test('precedence: planSegmentId only → derives daily_plan_id from segment FK', async () => {
  const q = fakeQuery([
    // 1) Derive plan_id from segment
    () => [{ daily_plan_id: 'P-derived', logging_target: 'hevy' }],
    // 2) UPDATE workouts
    () => [{ id: 'W1' }],
    // 3) UPDATE plan_segments status
    () => [],
  ]);
  const r = await linkWorkoutToPlan({
    workoutId: 'W1',
    workoutDate: '2026-05-14',
    source: 'manual',
    planSegmentId: 'S1',
    force: true,
  }, q);
  assert.equal(r.linked, true);
  assert.equal(r.plan_id, 'P-derived');
  assert.equal(r.plan_segment_id, 'S1');
});

test('precedence: nothing pre-supplied → looks up by date+source, finds preferred', async () => {
  const q = fakeQuery([
    () => [{
      plan_id: 'P1',
      preferred_segment_id: 'S-apple',
      preferred_target: 'apple_health',
      first_segment_id: 'S-hevy',
      first_target: 'hevy',
    }],
    () => [{ id: 'W1' }],   // UPDATE workouts
    () => [],               // UPDATE plan_segments
  ]);
  const r = await linkWorkoutToPlan({
    workoutId: 'W1',
    workoutDate: '2026-05-14',
    source: 'apple_health',
  }, q);
  assert.equal(r.linked, true);
  assert.equal(r.plan_id, 'P1');
  assert.equal(r.plan_segment_id, 'S-apple');
  assert.equal(r.via_fallback, false);
});

// ─── linkWorkoutToPlan: fallback observability ───────────────────────

test('fallback: no preferred segment → uses first segment AND emits warning', async () => {
  const q = fakeQuery([
    () => [{
      plan_id: 'P1',
      preferred_segment_id: null,        // no match for source='manual'
      preferred_target: null,
      first_segment_id: 'S-hevy',        // segment 1 is hevy
      first_target: 'hevy',
    }],
    () => [{ id: 'W1' }],
    () => [],
  ]);
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(msg);
  try {
    const r = await linkWorkoutToPlan({
      workoutId: 'W1-stair',
      workoutDate: '2026-05-14',
      source: 'manual',
      aiSource: 'claude',
    }, q);
    assert.equal(r.via_fallback, true);
    assert.equal(r.plan_segment_id, 'S-hevy');
    assert.equal(warns.length, 1, 'fallback should emit exactly one warning');
    // Warning must name the workout, the source, and the ai_source so
    // misroutes are diagnosable from logs alone.
    assert.ok(/W1-stair/.test(warns[0]), 'warning must include workout id');
    assert.ok(/source='manual'/.test(warns[0]), 'warning must include source');
    assert.ok(/ai_source='claude'/.test(warns[0]), 'warning must include ai_source');
    assert.ok(/FALLBACK/.test(warns[0]), 'warning must mention FALLBACK explicitly');
  } finally {
    console.warn = originalWarn;
  }
});

// ─── linkWorkoutToPlan: force flag ───────────────────────────────────

test('force=true: UPDATE statement overwrites existing routing (no COALESCE)', async () => {
  let updateSql = null;
  const q = async (sql, params) => {
    if (/UPDATE workouts/.test(String(sql))) {
      updateSql = String(sql);
      return { rows: [{ id: params[2] }] };
    }
    return { rows: [{ daily_plan_id: 'P1', logging_target: 'apple_health' }] };
  };
  await linkWorkoutToPlan({
    workoutId: 'W1',
    workoutDate: '2026-05-14',
    source: 'apple_health',
    planSegmentId: 'S-apple',
    force: true,
  }, q);
  assert.ok(updateSql, 'UPDATE workouts must have been called');
  assert.ok(!/COALESCE/.test(updateSql), 'force=true must NOT use COALESCE');
});

test('force=false (default): UPDATE statement uses COALESCE to preserve existing routing', async () => {
  let updateSql = null;
  const q = async (sql, params) => {
    if (/UPDATE workouts/.test(String(sql))) {
      updateSql = String(sql);
      return { rows: [{ id: params[2] }] };
    }
    if (/FROM plan_segments WHERE id = \$1/.test(String(sql))) {
      return { rows: [{ daily_plan_id: 'P1', logging_target: 'apple_health' }] };
    }
    return { rows: [] };
  };
  await linkWorkoutToPlan({
    workoutId: 'W1',
    workoutDate: '2026-05-14',
    source: 'apple_health',
    planSegmentId: 'S-apple',
  }, q);
  assert.ok(updateSql, 'UPDATE workouts must have been called');
  assert.ok(/COALESCE/.test(updateSql), 'force=false must use COALESCE');
});

// ─── linkWorkoutToPlan: failure paths ────────────────────────────────

test('returns missing_workout_id when workoutId is omitted', async () => {
  const r = await linkWorkoutToPlan({ workoutDate: '2026-05-14' }, async () => ({ rows: [] }));
  assert.equal(r.linked, false);
  assert.equal(r.reason, 'missing_workout_id');
});

test('returns no_plan_for_date when no plan exists', async () => {
  const q = fakeQuery([
    () => [],  // no plan
  ]);
  const r = await linkWorkoutToPlan({
    workoutId: 'W1',
    workoutDate: '2026-05-14',
    source: 'apple_health',
  }, q);
  assert.equal(r.linked, false);
  assert.equal(r.reason, 'no_plan_for_date');
});

test('returns plan_segment_id_not_found when explicit segment id is invalid', async () => {
  const q = fakeQuery([
    () => [],  // segment lookup empty
  ]);
  const r = await linkWorkoutToPlan({
    workoutId: 'W1',
    workoutDate: '2026-05-14',
    source: 'manual',
    planSegmentId: 'S-invalid',
    force: true,
  }, q);
  assert.equal(r.linked, false);
  assert.equal(r.reason, 'plan_segment_id_not_found');
});

// ─── 5/14 regression scenario ────────────────────────────────────────
//
// The stair workout on 2026-05-14 was posted with source='manual',
// ai_source='claude'. The plan had two segments:
//   - segment 1: logging_target=hevy (warmup with hangs)
//   - segment 2: logging_target=apple_health (stair master)
//
// Pre-fix: source='manual' → targetPref='manual' → no manual segment
// → fallback to first (hevy) → wrong. The fix surfaces this exact
// case as a structured warning so it's visible in logs.

test('5/14 regression: manual-sourced cardio workout fires fallback warning naming claude as ai_source', async () => {
  const q = fakeQuery([
    () => [{
      plan_id: 'P-may14',
      preferred_segment_id: null,
      preferred_target: null,
      first_segment_id: 'S-hevy',
      first_target: 'hevy',
    }],
    () => [{ id: 'd824d82b' }],
    () => [],
  ]);
  const warns = [];
  console.warn = (m) => warns.push(m);
  try {
    const r = await linkWorkoutToPlan({
      workoutId: 'd824d82b',
      workoutDate: '2026-05-14',
      source: 'manual',
      aiSource: 'claude',
    }, q);
    assert.equal(r.via_fallback, true);
    assert.equal(r.plan_segment_id, 'S-hevy');  // misrouted to wrong segment
    assert.ok(
      warns[0] && /d824d82b/.test(warns[0]) && /ai_source='claude'/.test(warns[0]),
      'fallback warning must surface the workout id + ai_source for triage'
    );
  } finally {
    console.warn = console.warn.constructor === Function ? require('node:console').warn : console.warn;
  }
});
