// Voice layer tests — cleanForUI + composeCoachRead.
//
// Pure unit tests, no DB. Runs via `node --test tests/voice.test.js`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanForUI, cleanAllForUI, cleanFields, cleanRows, composeCoachRead } = require('../lib/voice');

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

test('composeCoachRead: shabbat overrides everything', () => {
  const r = composeCoachRead({ shabbat: true });
  assert.equal(r.lead, 'Shabbat.');
  assert.equal(r.body, 'The system is resting too.');
  assert.equal(r.mute, 'See you Saturday night.');
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

test('composeCoachRead: waiting-on follow-up rendered when hot', () => {
  const r = composeCoachRead({
    today: {
      top_focus: {
        title: 'AWG expedite delayed orders',
        status: 'waiting_on',
        days_waiting: 11,
      },
    },
    overdue: { hot_count: 3 },
  });
  assert.equal(r.mute, 'Then awg expedite delayed orders. 11 days sitting.');
});

// ─── Voice rule sanity: leak detector on composed output ─────────────

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
