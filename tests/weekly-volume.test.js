// v3.35 Feature 2 — weekly working-set volume per muscle bucket.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countWorkingSets, tallyVolume, resolveWeekStart, mondayOf,
  etWeekWindowUTC, etDateOf, buildResolver,
} = require('../lib/weekly-volume');
const { bucketForMuscle, BUCKETS } = require('../lib/muscle-buckets');

// ─── set counting: warmups excluded, working types only ──────────
test('countWorkingSets: excludes warmups, counts normal/failure/dropset', () => {
  const sets = [
    { set_type: 'warmup', warmup: true },
    { set_type: 'normal' },
    { set_type: 'normal' },
    { set_type: 'failure' },
    { set_type: 'dropset' },
    { set_type: 'warmup' },        // warmup by type, no flag
  ];
  assert.equal(countWorkingSets(sets), 4); // 2 normal + 1 failure + 1 dropset
});

test('countWorkingSets: missing type defaults to normal (counts)', () => {
  assert.equal(countWorkingSets([{}, {}, { warmup: true }]), 2);
});

test('countWorkingSets: unknown types excluded (strict per spec)', () => {
  assert.equal(countWorkingSets([{ set_type: 'rest_pause' }, { set_type: 'normal' }]), 1);
});

// ─── bucket mapping ──────────────────────────────────────────────
test('bucketForMuscle: program bucket mapping', () => {
  assert.equal(bucketForMuscle('shoulders'), 'delts');
  assert.equal(bucketForMuscle('chest'), 'chest');
  assert.equal(bucketForMuscle('lats'), 'back');
  assert.equal(bucketForMuscle('traps'), 'back');
  assert.equal(bucketForMuscle('biceps'), 'arms');
  assert.equal(bucketForMuscle('triceps'), 'arms');
  assert.equal(bucketForMuscle('forearms'), 'arms');
  assert.equal(bucketForMuscle('quadriceps'), 'quads');
  assert.equal(bucketForMuscle('hamstrings'), 'hinge');
  assert.equal(bucketForMuscle('glutes'), 'hinge');
  assert.equal(bucketForMuscle('calves'), 'calves');
  assert.equal(bucketForMuscle('abdominals'), 'core');
  // intentionally unbucketed
  assert.equal(bucketForMuscle('cardio'), null);
  assert.equal(bucketForMuscle('neck'), null);
  assert.equal(bucketForMuscle('abductors'), null);
});

// ─── tally: primary 1.0, secondary 0.5, status vs targets ────────
test('tallyVolume: primary full + secondary half, status bands', () => {
  const workouts = [{
    exercises: [
      // Bench: chest primary, triceps+shoulders secondary. 3 working sets + 1 warmup.
      { name: 'Bench Press', sets: [
        { set_type: 'warmup', warmup: true }, { set_type: 'normal' }, { set_type: 'normal' }, { set_type: 'normal' },
      ] },
      // Squat: quads primary, glutes secondary. 4 working sets.
      { name: 'Back Squat', sets: [ {}, {}, {}, {} ] },
    ],
  }];
  const resolve = (ex) => ({
    'Bench Press': { primary: 'chest', secondary: ['triceps', 'shoulders'] },
    'Back Squat': { primary: 'quadriceps', secondary: ['glutes'] },
  }[ex.name] || { primary: null, secondary: [], unmapped: true });

  const targets = { chest: { target_min: 8, target_max: 10 }, quads: { target_min: 8, target_max: 10 } };
  const r = tallyVolume(workouts, resolve, targets);
  const by = Object.fromEntries(r.buckets.map(b => [b.bucket, b]));

  // chest: 3 primary sets
  assert.equal(by.chest.primary_sets, 3);
  assert.equal(by.chest.secondary_sets, 0);
  assert.equal(by.chest.total, 3);
  assert.equal(by.chest.status, 'under'); // 3 < 8

  // arms (triceps secondary of bench): 3 sets × 0.5 = 1.5
  assert.equal(by.arms.secondary_sets, 1.5);
  assert.equal(by.arms.primary_sets, 0);

  // delts (shoulders secondary of bench): 1.5
  assert.equal(by.delts.secondary_sets, 1.5);

  // quads: 4 primary
  assert.equal(by.quads.primary_sets, 4);
  assert.equal(by.quads.status, 'under'); // 4 < 8

  // hinge (glutes secondary of squat): 4 × 0.5 = 2.0
  assert.equal(by.hinge.secondary_sets, 2.0);

  assert.equal(r.working_set_total, 7); // 3 + 4
});

test('tallyVolume: status in / over', () => {
  const workouts = [{ exercises: [{ name: 'X', sets: Array.from({ length: 11 }, () => ({})) }] }];
  const resolve = () => ({ primary: 'shoulders', secondary: [] });
  const r = tallyVolume(workouts, resolve, { delts: { target_min: 10, target_max: 12 } });
  const delts = r.buckets.find(b => b.bucket === 'delts');
  assert.equal(delts.total, 11);
  assert.equal(delts.status, 'in'); // 10 ≤ 11 ≤ 12

  const r2 = tallyVolume([{ exercises: [{ name: 'X', sets: Array.from({ length: 15 }, () => ({})) }] }],
    resolve, { delts: { target_min: 10, target_max: 12 } });
  assert.equal(r2.buckets.find(b => b.bucket === 'delts').status, 'over');
});

test('tallyVolume: unmapped exercises surfaced, never dropped', () => {
  const workouts = [{ exercises: [
    { name: 'Mystery Machine', hevy_exercise_template_id: 'abc', sets: [{}, {}] },
    { name: 'Assault Bike', sets: [{}] }, // cardio → muscle_not_in_any_bucket
  ] }];
  const resolve = (ex) => ex.name === 'Assault Bike'
    ? { primary: 'cardio', secondary: [] }
    : { primary: null, secondary: [], unmapped: true };
  const r = tallyVolume(workouts, resolve, {});
  assert.equal(r.unmapped_exercises.length, 2);
  const byName = Object.fromEntries(r.unmapped_exercises.map(u => [u.name, u]));
  assert.equal(byName['Mystery Machine'].reason, 'no_muscle_data');
  assert.equal(byName['Mystery Machine'].working_sets, 2);
  assert.equal(byName['Assault Bike'].reason, 'muscle_not_in_any_bucket');
});

test('tallyVolume: calves/core show no_target status', () => {
  const workouts = [{ exercises: [{ name: 'Calf Raise', sets: [{}, {}, {}] }] }];
  const resolve = () => ({ primary: 'calves', secondary: [] });
  const r = tallyVolume(workouts, resolve, {}); // no targets seeded for calves
  const calves = r.buckets.find(b => b.bucket === 'calves');
  assert.equal(calves.total, 3);
  assert.equal(calves.status, 'no_target');
  assert.equal(calves.target_min, null);
});

// ─── ET week boundaries (the known UTC-rollover bug) ─────────────
test('mondayOf: snaps any date to its Monday', () => {
  assert.equal(mondayOf('2026-09-07'), '2026-09-07'); // Sep 7 2026 is a Monday
  assert.equal(mondayOf('2026-09-10'), '2026-09-07'); // Thu → same Monday
  assert.equal(mondayOf('2026-09-13'), '2026-09-07'); // Sun → same Monday
  assert.equal(mondayOf('2026-09-14'), '2026-09-14'); // next Monday
});

test('resolveWeekStart: default uses current ET week Monday', () => {
  // A fixed "now" at 2026-09-09T02:00:00Z = Sep 8 10pm ET (Tuesday) →
  // week Monday is Sep 7.
  const now = new Date('2026-09-09T02:00:00Z');
  assert.equal(resolveWeekStart(undefined, now), '2026-09-07');
});

test('etWeekWindowUTC: EDT week is 04:00Z..04:00Z', () => {
  const { startUTC, endUTC } = etWeekWindowUTC('2026-09-07');
  // September = EDT (UTC-4) → ET midnight is 04:00 UTC.
  assert.equal(startUTC.toISOString(), '2026-09-07T04:00:00.000Z');
  assert.equal(endUTC.toISOString(), '2026-09-14T04:00:00.000Z');
});

test('ET boundary bug: Sunday-evening ET session stays in its ET week', () => {
  const { startUTC, endUTC } = etWeekWindowUTC('2026-09-07');
  // Sun Sep 13, 9pm ET = Mon Sep 14 01:00 UTC. By UTC *date* it's the 14th
  // (next week); by ET wall time it's still Sunday of THIS week. Must be IN.
  const sundayNight = new Date('2026-09-14T01:00:00Z');
  assert.ok(sundayNight >= startUTC && sundayNight < endUTC,
    'Sun 9pm ET session must fall inside its ET week window');
  assert.equal(etDateOf(sundayNight), '2026-09-13'); // confirms it's ET Sunday

  // Mon Sep 14, 1am ET = 05:00 UTC → genuinely next week, must be OUT.
  const mondayEarly = new Date('2026-09-14T05:00:00Z');
  assert.ok(mondayEarly >= endUTC, 'Mon 1am ET session belongs to the next week');
});

// ─── buildResolver: template-id preferred, map fallback + override ─
test('buildResolver: template cache by id wins; map override respected', () => {
  const templates = [{ hevy_id: 'tpl1', primary_muscle_group: 'chest', secondary_muscle_groups: ['triceps'] }];
  const maps = [
    { name: 'custom sled', hevy_exercise_template_id: 'tplX', hevy_primary_muscle_group: null,
      hevy_secondary_muscle_groups: null, manual_muscle_override: 'quadriceps', muscle_unmapped: false },
  ];
  const resolve = buildResolver(templates, maps);
  // by template id
  assert.deepEqual(resolve({ hevy_exercise_template_id: 'tpl1', name: 'Bench' }),
    { primary: 'chest', secondary: ['triceps'] });
  // by name → manual override
  const r = resolve({ hevy_exercise_template_id: 'tplX', name: 'Custom Sled' });
  assert.equal(r.primary, 'quadriceps');
  // unknown → unmapped
  assert.equal(resolve({ name: 'Nothing', hevy_exercise_template_id: 'zzz' }).unmapped, true);
});
