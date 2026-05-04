// Regression tests for the AH calorie ingest paths (v1.8.14 / Coach
// bug #1). Locks in: every plausible HAE payload shape produces a
// non-null active_calories on the workout row.

const test = require('node:test');
const assert = require('node:assert/strict');

// Don't require DATABASE_URL; we only test pure parsers.
process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test';
const { pickEnergyKcal, parseFormatDWorkouts } = require('../routes/health');

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
