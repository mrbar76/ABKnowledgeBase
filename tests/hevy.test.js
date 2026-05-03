// Regression tests for the AB Brain ↔ Hevy integration.
//
// These are pure-function tests — no Hevy network calls, no DB. Run with:
//   node --test tests/hevy.test.js
//
// What's covered (per spec §7):
//   1. The body sent to Hevy contains `folder_id`, NOT `routine_folder_id`
//      (the production bug fixed in commit 7ccef38).
//   2. `formatPlanDate` produces "May 3" instead of the GMT garbage from
//      `new Date(...).toString()`.
//   3. lb→kg conversions for body measurements round to 2 decimals.
//   4. `mapHevyWorkoutToAB` produces a row shape that matches the
//      `workouts` table columns we INSERT into.

const test = require('node:test');
const assert = require('node:assert/strict');

// Set HEVY_API_KEY so the route module loads without warnings.
process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test-key';
const { _test } = require('../routes/hevy');
const { mapSegmentToHevyRoutine, formatPlanDate, lbToKg, abMetricsToHevy, mapHevyWorkoutToAB } = _test;

test('routine payload uses folder_id, not routine_folder_id (regression: commit 7ccef38)', () => {
  const plan = {
    plan_date: '2026-05-03',
    workout_type: 'strength',
    title: null,
    hevy_routine_title: null,
    goal: 'PR top set',
  };
  const segment = { block_label: 'strength', notes: '' };
  const exercises = [
    { hevy_exercise_template_id: '06745E58', name: 'Squat',
      sets: [{ weight_lb: 225, reps: 5 }] },
  ];

  const r = mapSegmentToHevyRoutine(plan, segment, exercises, 2804154);

  assert.equal(r.folder_id, 2804154, 'folder_id must be present');
  assert.ok(!('routine_folder_id' in r), 'routine_folder_id must NOT be in payload');
});

test('routine payload uses HEVY_ROUTINE_FOLDER_ID env fallback when folder_id omitted', () => {
  const prev = process.env.HEVY_ROUTINE_FOLDER_ID;
  process.env.HEVY_ROUTINE_FOLDER_ID = '9999999';
  try {
    const r = mapSegmentToHevyRoutine(
      { plan_date: '2026-05-03', workout_type: 'strength' },
      { block_label: 'strength' },
      [{ hevy_exercise_template_id: 'X', sets: [{ reps: 1 }] }],
      undefined  // no explicit folder_id
    );
    assert.equal(r.folder_id, '9999999');
  } finally {
    if (prev === undefined) delete process.env.HEVY_ROUTINE_FOLDER_ID;
    else process.env.HEVY_ROUTINE_FOLDER_ID = prev;
  }
});

test('routine title is clean — no GMT timezone string, no emoji', () => {
  const r = mapSegmentToHevyRoutine(
    { plan_date: '2026-05-03', workout_type: 'hybrid' },
    { block_label: 'hybrid' },
    [{ hevy_exercise_template_id: 'X', sets: [{ reps: 1 }] }],
    1
  );
  assert.ok(!/GMT/.test(r.title), `title leaked GMT: ${r.title}`);
  assert.ok(!/Coordinated Universal/.test(r.title), `title leaked timezone string: ${r.title}`);
  // The bug from May 3 was: "🔥 Hybrid Sun May 03 2026 00:00:00 GMT+0000 (Coordinated Universal Time)".
  // Our cleaned output should be short ("May 3 — Hybrid (Hybrid)" or similar).
  assert.ok(r.title.length < 60, `title too long: ${r.title}`);
});

test('hevy_routine_title overrides everything', () => {
  const r = mapSegmentToHevyRoutine(
    { plan_date: '2026-05-03', workout_type: 'hybrid', hevy_routine_title: 'Custom Title' },
    { block_label: 'hybrid' },
    [{ hevy_exercise_template_id: 'X', sets: [{ reps: 1 }] }],
    1
  );
  assert.equal(r.title, 'Custom Title');
});

test('plan.title is used when no override', () => {
  const r = mapSegmentToHevyRoutine(
    { plan_date: '2026-05-03', workout_type: 'strength', title: 'PR Day' },
    { block_label: 'strength' },
    [{ hevy_exercise_template_id: 'X', sets: [{ reps: 1 }] }],
    1
  );
  assert.equal(r.title, 'PR Day (Strength)');
});

test('formatPlanDate returns "May 3" not GMT garbage', () => {
  assert.equal(formatPlanDate('2026-05-03'), 'May 3');
  assert.equal(formatPlanDate('2026-01-15'), 'Jan 15');
  assert.equal(formatPlanDate('2026-12-31'), 'Dec 31');
  assert.equal(formatPlanDate(null), '');
});

test('lb→kg conversion rounds to 2 decimals', () => {
  assert.equal(lbToKg(220), 99.79);     // 220 × 0.453592 = 99.79024
  assert.equal(lbToKg(180), 81.65);     // 180 × 0.453592 = 81.64656
  assert.equal(lbToKg(null), null);
  assert.equal(lbToKg(0), 0);
});

test('weight_lb in routine sets converts to weight_kg', () => {
  const r = mapSegmentToHevyRoutine(
    { plan_date: '2026-05-03', workout_type: 'strength' },
    { block_label: 'strength' },
    [{ hevy_exercise_template_id: 'X', sets: [{ weight_lb: 225, reps: 5 }] }],
    1
  );
  assert.equal(r.exercises[0].sets[0].weight_kg, 102.06);  // 225 × 0.453592 = 102.0582
  assert.equal(r.exercises[0].sets[0].reps, 5);
});

test('abMetricsToHevy converts all known fields', () => {
  const out = abMetricsToHevy({
    weight_lb: 200,
    body_fat_pct: 18.5,
    muscle_mass_lb: 165,
    bone_mass_lb: 8,
    body_water_pct: 55,
    bmi: 24.1,
    bmr_kcal: 1800,
    visceral_fat: 7,
  });
  assert.equal(out.weight_kg, 90.72);
  assert.equal(out.fat_percent, 18.5);
  assert.equal(out.muscle_mass_kg, 74.84);
  assert.equal(out.bone_mass_kg, 3.63);
  assert.equal(out.water_percent, 55);
  assert.equal(out.bmi, 24.1);
  assert.equal(out.bmr_kcal, 1800);
  assert.equal(out.visceral_fat_rating, 7);
});

test('mapHevyWorkoutToAB produces row with hevy_id, source=hevy, total_volume_lb', () => {
  const hw = {
    id: 'hevy-abc-123',
    title: 'Push day',
    description: 'Felt strong',
    start_time: '2026-05-03T10:00:00Z',
    end_time: '2026-05-03T11:00:00Z',
    exercises: [
      { sets: [{ weight_kg: 100, reps: 5 }, { weight_kg: 100, reps: 5 }] },
    ],
  };
  const row = mapHevyWorkoutToAB(hw);
  assert.equal(row.hevy_id, 'hevy-abc-123');
  assert.equal(row.source, 'hevy');
  assert.equal(row.workout_date, '2026-05-03');
  assert.equal(row.total_sets, 2);
  // 100 kg × 5 reps × 2 sets × 2.2046 = ~2204.6
  assert.ok(row.total_volume_lb > 2200 && row.total_volume_lb < 2210, `volume off: ${row.total_volume_lb}`);
  assert.equal(row.workout_type, 'strength');
});

test('mapSegmentToHevyRoutine drops exercises without template id', () => {
  const r = mapSegmentToHevyRoutine(
    { plan_date: '2026-05-03', workout_type: 'strength' },
    { block_label: 'strength' },
    [
      { hevy_exercise_template_id: 'X', sets: [{ reps: 5 }] },
      { name: 'Unmappable', sets: [{ reps: 5 }] }, // no template id
    ],
    1
  );
  assert.equal(r.exercises.length, 1);
  assert.equal(r.exercises[0].exercise_template_id, 'X');
});
