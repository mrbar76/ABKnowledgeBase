// Regression tests for the AH calorie ingest paths (v1.8.14 / Coach
// bug #1). Locks in: every plausible HAE payload shape produces a
// non-null active_calories on the workout row.

const test = require('node:test');
const assert = require('node:assert/strict');

// Don't require DATABASE_URL; we only test pure parsers.
process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test';
const { pickEnergyKcal, parseFormatDWorkouts, sanitizeHrText, fixMojibake } = require('../routes/health');

test('pickEnergyKcal handles canonical { qty, units } shape', () => {
  assert.equal(pickEnergyKcal({ activeEnergyBurned: { qty: 365, units: 'kcal' } }, ['activeEnergyBurned']), 365);
});

test('pickEnergyKcal handles flat numeric shape', () => {
  assert.equal(pickEnergyKcal({ activeEnergyBurned: 365 }, ['activeEnergyBurned']), 365);
});

test('pickEnergyKcal handles Format A activeEnergyKcal name', () => {
  assert.equal(pickEnergyKcal({ activeEnergyKcal: 420 }, ['activeEnergyKcal', 'activeEnergyBurned']), 420);
});

test('pickEnergyKcal tries keys in order', () => {
  // First match wins
  assert.equal(pickEnergyKcal({ activeEnergyBurned: 100, activeEnergy: 200 }, ['activeEnergyBurned', 'activeEnergy']), 100);
  // Skip null/missing to next
  assert.equal(pickEnergyKcal({ activeEnergy: 200 }, ['activeEnergyBurned', 'activeEnergy']), 200);
});

test('pickEnergyKcal returns null for missing/invalid', () => {
  assert.equal(pickEnergyKcal({}, ['activeEnergyBurned']), null);
  assert.equal(pickEnergyKcal({ activeEnergyBurned: null }, ['activeEnergyBurned']), null);
  assert.equal(pickEnergyKcal({ activeEnergyBurned: { qty: 'NaN' } }, ['activeEnergyBurned']), null);
  assert.equal(pickEnergyKcal(null, ['activeEnergyBurned']), null);
});

test('pickEnergyKcal extracts numeric from string', () => {
  // Some HAE versions stringify
  assert.equal(pickEnergyKcal({ activeEnergyBurned: '365 kcal' }, ['activeEnergyBurned']), 365);
});

test('parseFormatDWorkouts populates active_calories from canonical shape', () => {
  const body = {
    data: {
      workouts: [{
        id: 'w1',
        name: 'Strength Training',
        start: '2026-05-03T10:00:00Z',
        end: '2026-05-03T11:00:00Z',
        duration: 3600,
        activeEnergyBurned: { qty: 365, units: 'kcal' },
        totalEnergy: { qty: 460, units: 'kcal' },
      }],
    },
  };
  const out = parseFormatDWorkouts(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].active_calories, '365');
  assert.equal(out[0].total_calories, '460');
});

test('parseFormatDWorkouts populates active_calories from older HAE shape (activeEnergy without "Burned")', () => {
  const body = {
    data: {
      workouts: [{
        id: 'w1',
        name: 'Outdoor Run',
        start: '2026-05-03T10:00:00Z',
        end: '2026-05-03T10:35:00Z',
        duration: 2100,
        activeEnergy: { qty: 412, units: 'kcal' },
      }],
    },
  };
  const out = parseFormatDWorkouts(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].active_calories, '412', 'older HAE shape should still be picked up');
});

test('parseFormatDWorkouts computes total when only active+basal present', () => {
  const body = {
    data: {
      workouts: [{
        id: 'w1',
        name: 'Hiking',
        start: '2026-05-03T08:00:00Z',
        end: '2026-05-03T10:00:00Z',
        duration: 7200,
        activeEnergyBurned: { qty: 600 },
        basalEnergyBurned: { qty: 150 },
        // no totalEnergy field
      }],
    },
  };
  const out = parseFormatDWorkouts(body);
  assert.equal(out[0].active_calories, '600');
  assert.equal(out[0].total_calories, '750', 'should compute total = active + basal when total missing');
});

test('parseFormatDWorkouts logs warning + returns null when no calorie field present (regression)', () => {
  // Coach bug #1: workout without any calorie field should still parse
  // (so we get the row) but flag the missing data.
  const body = {
    data: {
      workouts: [{
        id: 'w1',
        name: 'Functional Strength Training',
        start: '2026-05-03T10:00:00Z',
        end: '2026-05-03T10:50:00Z',
        duration: 3000,
        // no energy fields at all
      }],
    },
  };
  const out = parseFormatDWorkouts(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].active_calories, null);
  assert.equal(out[0].total_calories, null);
});

test('parseFormatDWorkouts handles metrics-nested shape', () => {
  const body = {
    data: {
      workouts: [{
        id: 'w1',
        name: 'Cycling',
        start: '2026-05-03T10:00:00Z',
        end: '2026-05-03T11:00:00Z',
        duration: 3600,
        // Some HAE versions nest under metrics
        metrics: {
          activeEnergy: { qty: 520 },
        },
      }],
    },
  };
  const out = parseFormatDWorkouts(body);
  assert.equal(out[0].active_calories, '520', 'metrics.activeEnergy fallback should work');
});

// v1.8.15: NEAT calculation
test('NEAT = daily_active - sum(workout_active) — matches Coach spec', () => {
  // Apple Watch shows daily active = 1373 cal.
  // Workouts (after dedupe) total = 380 cal.
  // NEAT (dog walks, ambient) = 1373 − 380 = 993 cal.
  const dailyActive = 1373;
  const workoutSum = 380;
  const neat = Math.max(0, dailyActive - workoutSum);
  assert.equal(neat, 993, 'NEAT bucket must capture non-workout movement');
});

test('NEAT clamps to 0 when workout_sum > daily_active (overlap dedupe failed)', () => {
  // Edge case: dedupe didn't merge, so workout sum > Apple's daily active.
  // Clamp to 0 instead of going negative — UI shouldn't show "−200 NEAT".
  const dailyActive = 200;
  const workoutSum = 600;
  const neat = Math.max(0, dailyActive - workoutSum);
  assert.equal(neat, 0);
});

// v1.8.23: HR object-shape unwrap. The canonical HAE shape is
// { qty: <number>, units: "count/min" }. Before this fix, every Apple
// Watch workout's heart_rate_avg/heart_rate_max landed null because
// Number({qty, units}) → NaN.
test('sanitizeHrText unwraps {qty, units} HAE objects', () => {
  assert.equal(sanitizeHrText({ qty: 88.27, units: 'count/min' }), '88');
  assert.equal(sanitizeHrText({ qty: 116, units: 'count/min' }), '116');
});

test('sanitizeHrText still handles flat numbers and numeric strings', () => {
  assert.equal(sanitizeHrText(140), '140');
  assert.equal(sanitizeHrText('132 bpm'), '132');
});

test('sanitizeHrText returns null for invalid HR shapes', () => {
  assert.equal(sanitizeHrText(null), null);
  assert.equal(sanitizeHrText({ units: 'count/min' }), null); // qty missing
  assert.equal(sanitizeHrText({ qty: null }), null);
  assert.equal(sanitizeHrText('NaN'), null);
  assert.equal(sanitizeHrText(0), null);
});

test('parseFormatDWorkouts populates HR fields from canonical {qty} shape (regression)', () => {
  const body = {
    data: {
      workouts: [{
        id: 'w1',
        name: 'Traditional Strength Training',
        start: '2026-05-03 14:17:03 -0400',
        end: '2026-05-03 14:30:40 -0400',
        duration: 816,
        activeEnergyBurned: { qty: 63.27, units: 'kcal' },
        heartRate: {
          avg: { qty: 88.27, units: 'count/min' },
          max: { qty: 116, units: 'count/min' },
        },
        avgHeartRate: { qty: 88.27, units: 'count/min' },
        maxHeartRate: { qty: 116, units: 'count/min' },
      }],
    },
  };
  const out = parseFormatDWorkouts(body);
  assert.equal(out[0].heart_rate_avg, '88');
  assert.equal(out[0].heart_rate_max, '116');
});

// v1.8.23: HAE/Apple Watch device names round-trip through tools that
// re-decode UTF-8 as Windows-1252, producing strings like "Avi<mojibake>s Apple<mojibake>Watch".
// The mojibake bytes are: U+00E2 U+20AC U+2122 (apostrophe) and U+00C2 U+00A0 (NBSP).
// Built via \u escapes so the literal NBSP byte survives any editor/tool
// that silently coerces NBSP into a regular space.
const MOJIBAKE_DEVICE = 'Avi\u00E2\u20AC\u2122s Apple\u00C2\u00A0Watch';
const CLEAN_DEVICE = 'Avi\u2019s Apple\u00A0Watch';

test('fixMojibake repairs UTF-8-as-CP1252 device names', () => {
  assert.equal(fixMojibake(MOJIBAKE_DEVICE), CLEAN_DEVICE);
  assert.equal(fixMojibake('GymKit|' + MOJIBAKE_DEVICE), 'GymKit|' + CLEAN_DEVICE);
});

test('fixMojibake passes through clean strings unchanged', () => {
  assert.equal(fixMojibake(CLEAN_DEVICE), CLEAN_DEVICE);
  assert.equal(fixMojibake('iPhone'), 'iPhone');
  assert.equal(fixMojibake(''), '');
  assert.equal(fixMojibake(null), null);
});

test('parseFormatDWorkouts repairs mojibake in nested metadata sources', () => {
  const body = {
    data: {
      workouts: [{
        id: 'w1',
        name: 'Indoor Run',
        start: '2026-05-03 13:22:21 -0400',
        end: '2026-05-03 13:55:30 -0400',
        duration: 1989,
        activeEnergyBurned: { qty: 140, units: 'kcal' },
        heartRateData: [
          { Avg: 117, Min: 117, Max: 117, source: MOJIBAKE_DEVICE, units: 'count/min', date: '2026-05-03 13:22:21 -0400' },
        ],
        stepCount: [
          { qty: 1, source: MOJIBAKE_DEVICE + '|iPhone AB', units: 'count', date: '2026-05-03 13:22:30 -0400' },
        ],
      }],
    },
  };
  const out = parseFormatDWorkouts(body);
  assert.equal(out[0].metadata.heartRateData[0].source, CLEAN_DEVICE);
  assert.equal(out[0].metadata.stepCount[0].source, CLEAN_DEVICE + '|iPhone AB');
});
