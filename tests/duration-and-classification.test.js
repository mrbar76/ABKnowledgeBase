// Regression tests for v1.8.16:
//   Bug #2 — parseDurationMin treating mm:ss as h:mm
//   Bug #5 — normalizeWorkoutType tagging PT/Mobility as strength

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test';
const { parseDurationMin } = require('../routes/workouts');
const { normalizeWorkoutType } = require('../routes/health');

// ─── parseDurationMin ──────────────────────────────────────────────

test('parseDurationMin: mm:ss is minutes:seconds, not h:mm (regression: 5:54 walk → 354 min bug)', () => {
  // Critical regression. formatDuration writes "5:54" for a 354-second walk.
  // Old parseDurationMin matched the same "h:mm" regex and returned 354
  // minutes, so a 6-min walk got logged as 5h 54m (~6h).
  assert.equal(parseDurationMin('5:54'), 6, '"5:54" mm:ss should round to 6 min, not 354');
  assert.equal(parseDurationMin('23:45'), 24, '"23:45" mm:ss → 24 min');
  assert.equal(parseDurationMin('0:30'), 1, '"0:30" mm:ss → 1 min (rounded up from 0.5)');
});

test('parseDurationMin: h:mm:ss is hours:minutes:seconds', () => {
  assert.equal(parseDurationMin('1:30:00'), 90, '"1:30:00" → 90 min');
  assert.equal(parseDurationMin('2:15:30'), 136, '"2:15:30" → 135 + 1 (rounded) = 136');
  assert.equal(parseDurationMin('0:45:00'), 45, '"0:45:00" → 45 min');
});

test('parseDurationMin: word-form durations', () => {
  assert.equal(parseDurationMin('45 min'), 45);
  assert.equal(parseDurationMin('1.5 hours'), 90);
  assert.equal(parseDurationMin('2 hr'), 120);
  assert.equal(parseDurationMin('90'), 90, 'raw number is minutes');
});

test('parseDurationMin: returns null for empty/junk', () => {
  assert.equal(parseDurationMin(null), null);
  assert.equal(parseDurationMin(''), null);
  assert.equal(parseDurationMin('???'), null);
});

// ─── normalizeWorkoutType ──────────────────────────────────────────

test('normalizeWorkoutType: PT/Mobility blocks → mobility (regression: was tagged strength)', () => {
  // Coach bug #5: "PT/Mobility Block (Cascade Prophylaxis + Forearm Rebuild)"
  // was getting workout_type='strength' because no earlier branch matched
  // and the loose 'strength' substring caught nothing — fell through to
  // 'other'. Worse: title containing words like "weight" hit strength.
  assert.equal(normalizeWorkoutType('PT/Mobility Block'), 'mobility');
  assert.equal(normalizeWorkoutType('Mobility Block (Cascade Prophylaxis)'), 'mobility');
  assert.equal(normalizeWorkoutType('PT - shoulder mobility'), 'mobility');
  assert.equal(normalizeWorkoutType('Yoga'), 'mobility');
  assert.equal(normalizeWorkoutType('Stretch routine'), 'mobility');
  assert.equal(normalizeWorkoutType('Foam Rolling'), 'mobility');
  assert.equal(normalizeWorkoutType('Prehab'), 'mobility');
});

test('normalizeWorkoutType: strength still classifies correctly', () => {
  assert.equal(normalizeWorkoutType('Traditional Strength Training'), 'strength');
  assert.equal(normalizeWorkoutType('Functional Strength Training'), 'strength');
  assert.equal(normalizeWorkoutType('Weightlifting'), 'strength');
});

test('normalizeWorkoutType: cardio types', () => {
  assert.equal(normalizeWorkoutType('Outdoor Run'), 'running');
  assert.equal(normalizeWorkoutType('Indoor Walk'), 'walking');
  assert.equal(normalizeWorkoutType('Hiking'), 'hiking');
  assert.equal(normalizeWorkoutType('Cycling'), 'cycling');
  assert.equal(normalizeWorkoutType('Rowing'), 'rowing');
});

test('normalizeWorkoutType: warmup / cooldown classified separately from strength', () => {
  assert.equal(normalizeWorkoutType('Warm Up'), 'warmup');
  assert.equal(normalizeWorkoutType('Cool Down Walk'), 'cooldown');
});
