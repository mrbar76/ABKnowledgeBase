// v3.9 hevy push payload tests.
//
// Verifies workoutRowToHevyPayload converts AB Brain workout rows into
// the Hevy POST /v1/workouts shape. Pure unit tests; no DB, no fetch.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test-key-for-load';

const hevy = require('../routes/hevy');
const { workoutRowToHevyPayload } = hevy;

function row(overrides = {}) {
  return {
    id: 'w-1',
    workout_date: '2026-05-09',
    started_at: null,
    ended_at: null,
    duration_minutes: 60,
    title: 'Strength A',
    workout_type: 'strength',
    body_notes: 'felt strong',
    exercises: [],
    ...overrides,
  };
}

test('workoutRowToHevyPayload: builds wrapper with workout key', () => {
  const p = workoutRowToHevyPayload(row(), []);
  assert.ok(p.workout, 'top-level workout key present');
  assert.equal(p.workout.title, 'Strength A');
});

test('workoutRowToHevyPayload: title falls back to workout_type when empty', () => {
  const p = workoutRowToHevyPayload(row({ title: null }), []);
  assert.match(p.workout.title, /strength/i);
});

test('workoutRowToHevyPayload: title falls back to "Workout" when both empty', () => {
  const p = workoutRowToHevyPayload(row({ title: null, workout_type: null }), []);
  assert.equal(p.workout.title, 'Workout');
});

test('workoutRowToHevyPayload: end_time derived from duration when ended_at missing', () => {
  const p = workoutRowToHevyPayload(row({ duration_minutes: 90 }), []);
  const start = new Date(p.workout.start_time).getTime();
  const end = new Date(p.workout.end_time).getTime();
  assert.equal(end - start, 90 * 60 * 1000);
});

test('workoutRowToHevyPayload: weight_lb converts to weight_kg', () => {
  const r = row();
  const resolved = [{
    name: 'Deadlift',
    hevy_exercise_template_id: 'tpl-1',
    sets: [{ weight_lb: 175, reps: 5 }],
  }];
  const p = workoutRowToHevyPayload(r, resolved);
  assert.equal(p.workout.exercises[0].sets[0].reps, 5);
  // 175 lb = 79.379 kg, rounded to 2 decimals.
  assert.equal(p.workout.exercises[0].sets[0].weight_kg, 79.38);
});

test('workoutRowToHevyPayload: weight_kg passes through unchanged', () => {
  const r = row();
  const resolved = [{
    name: 'Squat',
    hevy_exercise_template_id: 'tpl-2',
    sets: [{ weight_kg: 100, reps: 3 }],
  }];
  const p = workoutRowToHevyPayload(r, resolved);
  assert.equal(p.workout.exercises[0].sets[0].weight_kg, 100);
});

test('workoutRowToHevyPayload: missing weight becomes null (bodyweight)', () => {
  const r = row();
  const resolved = [{
    name: 'Pull-up',
    hevy_exercise_template_id: 'tpl-3',
    sets: [{ reps: 10 }],
  }];
  const p = workoutRowToHevyPayload(r, resolved);
  assert.equal(p.workout.exercises[0].sets[0].weight_kg, null);
  assert.equal(p.workout.exercises[0].sets[0].reps, 10);
});

test('workoutRowToHevyPayload: each exercise gets sequential index', () => {
  const r = row();
  const resolved = [
    { name: 'A', hevy_exercise_template_id: 't1', sets: [{ reps: 5 }] },
    { name: 'B', hevy_exercise_template_id: 't2', sets: [{ reps: 5 }] },
    { name: 'C', hevy_exercise_template_id: 't3', sets: [{ reps: 5 }] },
  ];
  const p = workoutRowToHevyPayload(r, resolved);
  assert.deepEqual(p.workout.exercises.map(e => e.index), [0, 1, 2]);
});

test('workoutRowToHevyPayload: optional fields (rpe, distance, duration) included only when present', () => {
  const r = row();
  const resolved = [{
    name: 'Run',
    hevy_exercise_template_id: 'tpl-run',
    sets: [
      { reps: 0, distance_meters: 5000, duration_seconds: 1800, rpe: 7 },
      { reps: 5 },
    ],
  }];
  const p = workoutRowToHevyPayload(r, resolved);
  assert.equal(p.workout.exercises[0].sets[0].distance_meters, 5000);
  assert.equal(p.workout.exercises[0].sets[0].rpe, 7);
  assert.equal('rpe' in p.workout.exercises[0].sets[1], false);
});

test('workoutRowToHevyPayload: title truncated to 80 chars', () => {
  const longTitle = 'a'.repeat(120);
  const p = workoutRowToHevyPayload(row({ title: longTitle }), []);
  assert.ok(p.workout.title.length <= 80);
});

test('workoutRowToHevyPayload: description truncated to 600 chars', () => {
  const longNotes = 'b'.repeat(800);
  const p = workoutRowToHevyPayload(row({ body_notes: longNotes }), []);
  assert.ok(p.workout.description.length <= 600);
});
