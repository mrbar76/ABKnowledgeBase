// Voice layer tests — cleanForUI + composeCoachRead.
//
// Pure unit tests, no DB. Runs via `node --test tests/voice.test.js`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanForUI, cleanAllForUI, cleanFields, cleanRows, composeCoachRead, SLUG_MAP } = require('../lib/voice');

// ─── cleanForUI: spec acceptance cases ───────────────────────────────

test('cleanForUI strips PROMPT AVI prefix', () => {
  assert.equal(cleanForUI("PROMPT AVI: Pick Mother's Day"), "Pick Mother's Day");
});

test('cleanForUI strips [WAITING ON: Name] prefix', () => {
  assert.equal(
    cleanForUI('[WAITING ON: Heather] AWG expedite delayed orders'),
    'AWG expedite delayed orders'
  );
});

test('cleanForUI replaces em dashes with hyphens', () => {
  assert.equal(
    cleanForUI('Strength A — Deadlift Re-entry'),
    'Strength A - Deadlift Re-entry'
  );
});

test('cleanForUI replaces en dashes with hyphens', () => {
  assert.equal(cleanForUI('Strength A – Deadlift'), 'Strength A - Deadlift');
});

test('cleanForUI maps known slug to display', () => {
  assert.equal(cleanForUI('rdl_pull_grip'), 'Deadlift, pull, grip');
});

test('cleanForUI maps slug embedded in sentence', () => {
  assert.equal(
    cleanForUI('Today: rdl_pull_grip session.'),
    'Today: Deadlift, pull, grip session.'
  );
});

test('cleanForUI fallback: unmapped slug becomes spaces', () => {
  assert.equal(cleanForUI('kettlebell_swing'), 'kettlebell swing');
  assert.equal(cleanForUI('box_jump_combo'), 'box jump combo');
});

test('cleanForUI strips REVISED commit-message phrases', () => {
  const result = cleanForUI('REVISED v3 after Avi pushback. Goal 2 was missing.');
  assert.ok(!/REVISED v\d/i.test(result), 'REVISED v3 phrase removed');
  assert.ok(result.includes('Goal 2 was missing'), 'rest of sentence preserved');
});

test('cleanForUI strips per-spec-section references', () => {
  const result = cleanForUI('Working set 3 = 175x5 RPE 8 clean. Per spec section 6.');
  assert.ok(!/per spec section/i.test(result));
});

test('cleanForUI strips bare workout UUIDs', () => {
  const result = cleanForUI('Per workout ac0407a7, working set 3 was clean.');
  assert.ok(!/workout [a-f0-9]{8}/i.test(result));
});

test('cleanForUI returns empty string for null/undefined', () => {
  assert.equal(cleanForUI(null), '');
  assert.equal(cleanForUI(undefined), '');
  assert.equal(cleanForUI(''), '');
});

test('cleanForUI coerces non-string input', () => {
  assert.equal(cleanForUI(42), '42');
});

test('cleanForUI is idempotent', () => {
  const inputs = [
    'PROMPT AVI: Test',
    '[WAITING ON: Heather] AWG expedite',
    'Strength A — rdl_pull_grip',
    "REVISED v3 after Avi pushback. Real content.",
  ];
  for (const input of inputs) {
    const once = cleanForUI(input);
    const twice = cleanForUI(once);
    assert.equal(once, twice, `not idempotent for: ${input}`);
  }
});

test('cleanFields cleans named fields, leaves others alone', () => {
  const row = {
    id: 'abc',
    title: 'PROMPT AVI: Pick something',
    notes: 'Strength A — Heavy',
    priority: 'high',
    raw_text: 'leave me alone — em dash stays',
  };
  const out = cleanFields(row, ['title', 'notes']);
  assert.equal(out.title, 'Pick something');
  assert.equal(out.notes, 'Strength A - Heavy');
  assert.equal(out.priority, 'high');
  assert.equal(out.raw_text, 'leave me alone — em dash stays');
  assert.equal(out.id, 'abc');
});

test('cleanFields handles null row', () => {
  assert.equal(cleanFields(null, ['title']), null);
});

test('cleanFields handles null/undefined fields', () => {
  const row = { title: null, notes: undefined };
  const out = cleanFields(row, ['title', 'notes']);
  assert.equal(out.title, null);
  assert.equal(out.notes, undefined);
});

test('cleanRows maps over an array of rows', () => {
  const rows = [
    { title: 'PROMPT AVI: One', priority: 'high' },
    { title: '[WAITING ON: X] Two', priority: 'low' },
  ];
  const out = cleanRows(rows, ['title']);
  assert.equal(out[0].title, 'One');
  assert.equal(out[1].title, 'Two');
  assert.equal(out[0].priority, 'high');
});

test('cleanAllForUI cleans an array and drops empties', () => {
  const result = cleanAllForUI([
    'PROMPT AVI: Task one',
    null,
    '[WAITING ON: X] Task two',
    '',
    'Task three',
  ]);
  assert.deepEqual(result, ['Task one', 'Task two', 'Task three']);
});

// ─── composeCoachRead: spec acceptance cases ─────────────────────────

test('composeCoachRead: shabbat keeps personal + training live, only pauses work', () => {
  // v3 hotfix: shabbat used to blank the screen with "The system is
  // resting too." That was wrong — only work pauses. Personal +
  // training stay live (filtered upstream in briefing.js).
  const r = composeCoachRead({ shabbat: true });
  assert.equal(r.lead, 'Shabbat.');
  assert.match(r.body, /work is paused/i);
  assert.match(r.body, /personal and training stay live/i);
});

test('composeCoachRead: shabbat shows havdalah time when available', () => {
  const r = composeCoachRead({
    shabbat: true,
    shabbat_status: { havdalah_time_label: '8:24 PM' },
  });
  assert.equal(r.mute, 'Havdalah at 8:24 PM.');
});

test('composeCoachRead: Friday before candle lighting shows the time', () => {
  const r = composeCoachRead({
    yesterday: { workouts_completed: 0, tasks_completed: 0 },
    shabbat: false,
    shabbat_status: {
      is_friday: true,
      candle_lighting_time_label: '7:42 PM',
    },
  });
  assert.equal(r.mute, 'Candle lighting at 7:42 PM.');
});

test('composeCoachRead: yesterday quiet when no completion', () => {
  const r = composeCoachRead({
    yesterday: { workouts_completed: 0, tasks_completed: 0 },
    today: {},
  });
  assert.equal(r.lead, 'Yesterday was quiet.');
});

test('composeCoachRead: yesterday workout landed', () => {
  const r = composeCoachRead({
    yesterday: {
      workouts_completed: 1,
      workouts: [{ title: 'Strength A — Pull', effort: 8 }],
    },
  });
  assert.match(r.lead, /yesterday's strength a - pull landed\./i);
});

test('composeCoachRead: yesterday tasks done counts', () => {
  const r1 = composeCoachRead({
    yesterday: { workouts_completed: 0, tasks_completed: 1 },
  });
  assert.equal(r1.lead, 'Yesterday: 1 thing done.');

  const r3 = composeCoachRead({
    yesterday: { workouts_completed: 0, tasks_completed: 3 },
  });
  assert.equal(r3.lead, 'Yesterday: 3 things done.');
});

test('composeCoachRead: today anchor session', () => {
  const r = composeCoachRead({
    today: {
      planned_workout: { display_title: 'Strength A', is_anchor: true },
    },
  });
  assert.equal(r.body, 'Today: Strength A. Anchor session.');
});

test('composeCoachRead: today workout slug gets cleaned', () => {
  const r = composeCoachRead({
    today: {
      planned_workout: { title: 'rdl_pull_grip', is_anchor: false },
    },
  });
  assert.equal(r.body, 'Today: Deadlift, pull, grip.');
});

test('composeCoachRead: race within 3 days triggers taper', () => {
  const r = composeCoachRead({
    today: {},
    race: { name: 'Riverdale 5K', days_away: 2 },
  });
  assert.equal(r.body, 'Riverdale 5K in 2 days. Taper.');
});

test('composeCoachRead: race day singular', () => {
  const r = composeCoachRead({
    today: {},
    race: { name: 'Riverdale 5K', days_away: 1 },
  });
  assert.equal(r.body, 'Riverdale 5K in 1 day. Taper.');
});

test('composeCoachRead: low recovery warning in mute', () => {
  const r = composeCoachRead({ recovery: { score: 35 } });
  assert.equal(r.mute, 'Recovery low. Cap effort at RPE 7.');
});

test('composeCoachRead: hot overdue count when no waiting follow-up', () => {
  const r = composeCoachRead({
    today: {},
    overdue: { count: 5, hot_count: 2 },
  });
  assert.equal(r.mute, '2 hot items overdue.');
});

test('composeCoachRead: between phases when no other body', () => {
  const r = composeCoachRead({
    today: {},
    between_phases: true,
  });
  assert.equal(r.body, 'Between phases. Plan the next block.');
});

test('composeCoachRead: empty signals yields empty strings', () => {
  const r = composeCoachRead({});
  assert.equal(r.lead, '');
  assert.equal(r.body, '');
  assert.equal(r.mute, '');
});

test('composeCoachRead: undefined signals does not throw', () => {
  const r = composeCoachRead();
  assert.equal(r.lead, '');
});

test('composeCoachRead: waiting-on follow-up rendered when hot (task)', () => {
  const r = composeCoachRead({
    today: {
      top_focus: {
        kind: 'task',
        title: 'AWG expedite delayed orders',
        status: 'waiting_on',
        days_waiting: 11,
      },
    },
    overdue: { hot_count: 3 },
  });
  assert.equal(r.mute, 'Then awg expedite delayed orders. 11 days sitting.');
});

test('composeCoachRead: workout-typed top_focus does not trigger waiting mute', () => {
  // top_focus is a workout (no waiting_on semantics). Even with hot
  // overdue items, the waiting follow-up branch must not fire.
  const r = composeCoachRead({
    today: {
      top_focus: {
        kind: 'workout',
        title: 'Strength A',
        status: 'planned',
      },
    },
    overdue: { hot_count: 3 },
  });
  // Falls through to hot-overdue mute.
  assert.equal(r.mute, '3 hot items overdue.');
});

// ─── Voice rule sanity: leak detector on composed output ─────────────

// ─── SLUG_MAP drift detector ──────────────────────────────────────────
//
// Reviewer concern: SLUG_MAP is hand-maintained; new slugs added to the
// DB will silently fall through to the underscore-stripper. These tests
// assert the known slug set is present and that the fallback regex
// catches any slug-shaped string not in the map (so leaks are bounded).

test('SLUG_MAP: known workout/plan slugs are present', () => {
  // Add to this list whenever a new workout_focus or workout_type slug
  // appears in production data. Drift = visible leak otherwise.
  const REQUIRED_SLUGS = [
    'rdl_pull_grip',
    'strength_a', 'strength_b', 'strength_c',
    'hill_intervals', 'hill_repeats',
    'tempo_run', 'easy_run', 'long_run',
    'recovery_walk', 'z2_walk', 'z3_walk', 'z2_run', 'z3_run',
    'farmers_walk', 'stair_climber',
    'pull_grip', 'squat_press', 'bench_row',
    'upper_push', 'upper_pull', 'full_body',
  ];
  for (const slug of REQUIRED_SLUGS) {
    assert.ok(SLUG_MAP[slug], `SLUG_MAP missing required slug: ${slug}`);
  }
});

test('SLUG_MAP: every entry maps to a non-slug-shaped display string', () => {
  // Display strings should not themselves look like slugs (would defeat
  // the purpose). Each value must contain a space OR be capitalized.
  for (const [slug, display] of Object.entries(SLUG_MAP)) {
    const looksLikeSlug = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(display);
    assert.ok(!looksLikeSlug, `SLUG_MAP[${slug}] display value "${display}" still looks like a slug`);
  }
});

test('SLUG_MAP: cleanForUI never returns a string with underscore-joined lowercase tokens', () => {
  // Defensive check on the SLUG_LIKE fallback. Any slug-shaped input
  // either maps via SLUG_MAP OR falls through the underscore-stripper —
  // either way the output should not contain the original slug.
  const samples = [
    'rdl_pull_grip',
    'kettlebell_swing',  // unmapped — fallback path
    'box_jump_combo',    // unmapped — fallback path
    'snatch_grip_high_pull', // multi-token unmapped
    'mixed CONTENT with rdl_pull_grip embedded',
  ];
  for (const s of samples) {
    const cleaned = cleanForUI(s);
    assert.ok(
      !/[a-z][a-z0-9]*(_[a-z0-9]+)+/.test(cleaned),
      `cleanForUI("${s}") leaked a slug: "${cleaned}"`,
    );
  }
});

test('composeCoachRead output contains no leak markers (combined run)', () => {
  const signals = {
    yesterday: {
      workouts_completed: 1,
      workouts: [{ title: '[WAITING ON: Heather] PROMPT AVI: Strength A — rdl_pull_grip' }],
    },
    today: {
      planned_workout: { title: 'rdl_pull_grip', is_anchor: true },
    },
    recovery: { score: 70 },
    overdue: { count: 3, hot_count: 1 },
  };
  const r = composeCoachRead(signals);
  const blob = `${r.lead} ${r.body} ${r.mute}`;
  assert.ok(!/PROMPT AVI/i.test(blob), `lead leaks: ${blob}`);
  assert.ok(!/\[WAITING ON/.test(blob), `waiting prefix leaks: ${blob}`);
  assert.ok(!/—/.test(blob), `em dash leaks: ${blob}`);
  assert.ok(!/rdl_pull_grip/.test(blob), `slug leaks: ${blob}`);
});
