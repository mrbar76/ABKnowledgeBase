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
const {
  mapSegmentToHevyRoutine,
  formatPlanDate,
  lbToKg,
  abMetricsToHevy,
  mapHevyWorkoutToAB,
  lookupHevyTemplateByName,
  searchHevyTemplates,
} = _test;

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

test('abMetricsToHevy maps to real Hevy schema (3 fields, no invented ones)', () => {
  // Hevy's actual body_measurements schema (verified from
  // api.hevyapp.com OAS, May 2026): only weight_kg, lean_mass_kg,
  // fat_percent are numeric metrics — the rest are tape measurements
  // we don't track in RENPHO. Sending invented fields (bmi,
  // visceral_fat_rating, etc.) would 400 from Hevy's strict validator.
  const out = abMetricsToHevy({
    weight_lb: 200,
    fat_free_mass_lb: 165,
    body_fat_pct: 18.5,
  });
  assert.equal(out.weight_kg, 90.72);
  assert.equal(out.lean_mass_kg, 74.84);
  assert.equal(out.fat_percent, 18.5);
  // Negative assertions — invented fields must NOT be present.
  assert.ok(!('muscle_mass_kg' in out));
  assert.ok(!('bone_mass_kg' in out));
  assert.ok(!('water_percent' in out));
  assert.ok(!('bmi' in out));
  assert.ok(!('bmr_kcal' in out));
  assert.ok(!('visceral_fat_rating' in out));
});

test('abMetricsToHevy returns nulls for missing inputs', () => {
  const out = abMetricsToHevy({ weight_lb: 180 });
  assert.equal(out.weight_kg, 81.65);
  assert.equal(out.lean_mass_kg, null);
  assert.equal(out.fat_percent, null);
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

// ─── Resolver: exact-only push path (regression for duplicate-exercises bug) ───
//
// lookupHevyTemplateByName used to fall back to a 0.35-threshold
// trigram fuzzy match against hevy_template_cache as Tier 3. Production
// docs claimed "no fuzzy match in production push path" — but the code
// silently mapped near-misses to whichever template won the trigram
// race, baking the wrong template_id into hevy_routine_id and
// propagating duplicates through logged workouts. The fuzzy tier was
// removed; fuzzy is now only available via the discovery-only
// searchHevyTemplates() helper for explicit confirmation.

function fakeQuery(handlers) {
  // handlers: array of (sql, params) -> rows | null, run in order. The
  // first handler whose return value is not undefined wins. Throws if
  // an unexpected query lands.
  let i = 0;
  return async (sql, params) => {
    const h = handlers[i++];
    if (!h) throw new Error(`unexpected query #${i}: ${sql.slice(0, 80)}`);
    const result = await h(sql, params);
    return { rows: result || [] };
  };
}

test('resolver: returns map hit (Tier 1)', async () => {
  const q = fakeQuery([
    () => [{ id: 'T1', title: 'Bench Press', type: 'weight_reps' }],
  ]);
  const r = await lookupHevyTemplateByName('Bench Press', q);
  assert.equal(r.id, 'T1');
  assert.equal(r.source, 'map');
});

test('resolver: falls through to cache exact when map misses (Tier 2)', async () => {
  const q = fakeQuery([
    () => [], // map miss
    () => [{ id: 'T2', title: 'Bench Press', type: 'weight_reps' }], // cache exact
  ]);
  const r = await lookupHevyTemplateByName('Bench Press', q);
  assert.equal(r.id, 'T2');
  assert.equal(r.source, 'cache_exact');
});

test('resolver: returns null when both map and cache exact miss — no fuzzy fallback', async () => {
  const calls = [];
  const q = async (sql) => {
    calls.push(sql);
    return { rows: [] }; // both queries miss
  };
  const r = await lookupHevyTemplateByName('Bulgarian Split Squat', q);
  assert.equal(r, null);
  // Critical: only TWO queries — no fuzzy fallback. Previously the
  // resolver would run a third trigram-similarity query and accept
  // any result with sim > 0.35.
  assert.equal(calls.length, 2, `resolver ran ${calls.length} queries; expected 2 (no fuzzy)`);
  assert.ok(/hevy_exercise_map/.test(calls[0]));
  assert.ok(/hevy_template_cache/.test(calls[1]));
  assert.ok(!/similarity/.test(calls[0] + calls[1]), 'resolver must not run a similarity query');
});

test('searchHevyTemplates: filters by minSimilarity', async () => {
  const q = async () => ({
    rows: [
      { id: 'A', title: 'Bench Press', type: 'weight_reps', is_custom: false, similarity: 0.95 },
      { id: 'B', title: 'Bench Press (Smith)', type: 'weight_reps', is_custom: false, similarity: 0.7 },
      { id: 'C', title: 'Overhead Press', type: 'weight_reps', is_custom: false, similarity: 0.35 },
    ],
  });
  const r = await searchHevyTemplates('Bench Press', { minSimilarity: 0.5 }, q);
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 'A');
  assert.equal(r[1].id, 'B');
});

test('searchHevyTemplates: empty name returns []', async () => {
  // Note: also verifies the queryFn is not even called for empty names.
  const q = async () => { throw new Error('should not query for empty name'); };
  const r = await searchHevyTemplates('', {}, q);
  assert.deepEqual(r, []);
});

test('searchHevyTemplates: respects custom limit and minSimilarity defaults', async () => {
  let receivedLimit = null;
  const q = async (_sql, params) => {
    receivedLimit = params[1];
    return { rows: [{ id: 'A', title: 'X', similarity: 0.6 }] };
  };
  await searchHevyTemplates('X', { limit: 10 }, q);
  assert.equal(receivedLimit, 10);
});

// ─── Regression guards: source-grep checks against re-introducing the bug ───
//
// The duplicate-exercises bug had two causes (PR #39):
//   1. lookupHevyTemplateByName running a Tier 3 trigram fuzzy match
//      on the production push path — silently mapping near-misses to
//      the wrong Hevy template.
//   2. /exercise-map/auto-populate accepting an `auto_create_custom`
//      flag that POSTed to Hevy /exercise_templates, accumulating
//      duplicate customs in the user's library.
//
// These tests fail loudly if either pattern slips back in. Brittle by
// design — the failure message tells the next reader exactly which
// bug they're about to recreate and which PR explains why it was
// removed.

test('regression guard: lookupHevyTemplateByName has no similarity() call', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'hevy.js'),
    'utf8'
  );
  const fn = src.match(/async function lookupHevyTemplateByName[\s\S]*?\n\}\n/);
  assert.ok(fn, 'lookupHevyTemplateByName not found in routes/hevy.js');
  assert.ok(
    !/similarity\(/.test(fn[0]),
    'Tier 3 fuzzy similarity() was reintroduced into the production push resolver. ' +
    'See PR #39 — the 0.35-threshold trigram match was the root cause of the ' +
    'duplicate-exercises bug. If discovery-by-similarity is needed, use the ' +
    'separate searchHevyTemplates() helper, which is never called from the push path.'
  );
});

test('regression guard: auto_create_custom flag is fully removed from code', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = [
    'routes/hevy.js',
    'public/app.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    // Strip line and block comments — the route handler comment legitimately
    // mentions the flag in past tense ("was removed"). Code references would
    // recreate the bug.
    const stripped = src
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(
      !/auto_create_custom/.test(stripped),
      `auto_create_custom referenced in ${rel} (outside comments). ` +
      'See PR #39 — silently minting custom Hevy templates on resolver miss ' +
      'was the second root cause of the duplicate-exercises bug. To create a ' +
      'custom now: user creates it in Hevy, POST /api/hevy/templates/refresh, ' +
      'then POST /api/hevy/exercise-map.'
    );
  }
});
