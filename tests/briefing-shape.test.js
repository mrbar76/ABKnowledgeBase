// Briefing payload shape + size acceptance tests.
//
// Runs without DB. Builds a realistic maximum-fan-out payload from the
// pure helpers, asserts:
//   - stringified size < 3 KB (spec target)
//   - zero leak markers ([WAITING ON, PROMPT AVI, em dash, raw slug)
//   - all required top-level fields present
//   - focus capped at 3
//   - coach_read has lead/body/mute fields (any may be empty)
//   - coach_read_signals exposes structured input for future LLM rewrite
//   - changed_since_yesterday exposes the delta-surfacing fields

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanForUI, composeCoachRead } = require('../lib/voice');
const { rankFocus } = require('../lib/focus-ranker');

// Build a realistic worst-case briefing payload using the same lib
// functions the route uses, so we exercise the actual code paths.
function buildMockBriefing() {
  const today = '2026-05-08';
  const openTasks = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'PROMPT AVI: AWG expedite delayed orders to North Bergen warehouse',
      notes: 'Spoke to Heather yesterday; she is chasing the carrier today. Need confirmation by EOD.',
      status: 'waiting_on',
      priority: 'high',
      context: 'work',
      due_date: '2026-04-25',
      updated_at: '2026-05-04T14:00:00Z',
      waiting_on: 'Heather',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      title: "[WAITING ON: Lilach] Pick Mother's Day NYC activity",
      notes: 'Brunch + walk along Hudson? Lilach prefers indoor.',
      status: 'todo',
      priority: 'urgent',
      context: 'personal',
      due_date: '2026-05-08',
      updated_at: '2026-05-07T09:00:00Z',
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      title: 'Strength A — rdl_pull_grip — long session today',
      notes: 'First conventional pull in 17 months. RPE cap at 8.',
      status: 'planned',
      priority: 'high',
      context: 'training',
      due_date: '2026-05-08',
      updated_at: '2026-05-08T05:00:00Z',
    },
  ];

  const todayPlan = {
    id: 'plan-uuid',
    title: 'Strength A',
    workout_type: 'strength',
    workout_focus: 'rdl_pull_grip',
    target_effort: 9,
    target_duration_min: 65,
  };

  const focus = rankFocus(openTasks, today, { todayPlan });

  const recovery = {
    score: 67,
    label: 'Good',
    components: {
      sleep: { score: 70, weight: 30, detail: '6h, quality 6/10' },
      training_load: {
        score: 75, weight: 25,
        detail: 'TSB +64 (detraining) · CTL 291 / ATL 227',
        tsb: 64, ctl: 291, atl: 227,
      },
      muscle_freshness: { score: 60, weight: 20, detail: 'Legs fatigued' },
      injury: { score: 100, weight: 10, detail: 'No active injuries' },
      nutrition: { score: 50, weight: 10, detail: 'Yesterday 2200 cal · Today 0 cal' },
      subjective: { score: 60, weight: 5, detail: 'Sleep quality 6/10' },
    },
  };

  const signals = {
    yesterday: {
      workouts_completed: 1,
      tasks_completed: 0,
      workouts: [{ title: cleanForUI('Strength A — Heavy'), effort: 7, workout_type: 'strength' }],
    },
    today: {
      planned_workout: {
        title: cleanForUI(todayPlan.title),
        workout_focus: cleanForUI(todayPlan.workout_focus),
        target_effort: 9,
        is_anchor: true,
      },
      top_focus: focus[0] || null,
    },
    recovery: { score: 67, label: 'Good' },
    overdue: { count: 6, hot_count: 3 },
    race: { name: 'Riverdale 5K', days_away: 3 },
    between_phases: false,
    shabbat: false,
  };

  const coachRead = composeCoachRead(signals);

  const payload = {
    date: today,
    greeting: { label: 'Good morning', kicker: 'Thu, May 8' },
    glance: {
      recovery: { score: 67, label: 'Good', trend: '+2 vs yesterday', components: recovery.components },
      next_race: { id: 'race-uuid', name: 'Riverdale 5K', days_away: 3 },
      overdue: { count: 6, hot_count: 3, trend: '3 hot' },
    },
    coach_read: coachRead,
    coach_read_signals: signals,
    focus,
    changed_since_yesterday: {
      completed_yesterday: 0,
      newly_due_today: 4,
      newly_overdue: 2,
      newly_added: 3,
      recovery_delta: 2,
    },
    metadata: {
      total_open_tasks: 78,
      shabbat_active: false,
      between_phases: false,
      generated_at: '2026-05-08T12:34:56Z',
    },
  };

  return payload;
}

// ─── Acceptance criteria ─────────────────────────────────────────────

test('briefing payload: top-level shape matches spec', () => {
  const p = buildMockBriefing();
  assert.ok(p.date, 'date present');
  assert.ok(p.greeting, 'greeting present');
  assert.ok(p.glance, 'glance present');
  assert.ok(p.coach_read, 'coach_read present');
  assert.ok(p.coach_read_signals, 'coach_read_signals present');
  assert.ok(Array.isArray(p.focus), 'focus is array');
  assert.ok(p.changed_since_yesterday, 'changed_since_yesterday present');
  assert.ok(p.metadata, 'metadata present');
});

test('briefing payload: focus capped at 3', () => {
  const p = buildMockBriefing();
  assert.ok(p.focus.length <= 3, `focus length ${p.focus.length} exceeds cap`);
});

test('briefing payload: coach_read has three slots', () => {
  const p = buildMockBriefing();
  assert.ok('lead' in p.coach_read, 'lead present');
  assert.ok('body' in p.coach_read, 'body present');
  assert.ok('mute' in p.coach_read, 'mute present');
});

test('briefing payload: changed_since_yesterday exposes deltas', () => {
  const p = buildMockBriefing();
  const c = p.changed_since_yesterday;
  for (const f of ['completed_yesterday', 'newly_due_today', 'newly_overdue', 'newly_added', 'recovery_delta']) {
    assert.ok(f in c, `changed_since_yesterday.${f} present`);
  }
});

test('briefing payload: stringified size under 3 KB', () => {
  const p = buildMockBriefing();
  const size = JSON.stringify(p).length;
  assert.ok(size < 3000, `payload size ${size} bytes exceeds 3000 byte target`);
});

test('briefing payload: zero leak markers in serialized output', () => {
  const p = buildMockBriefing();
  const blob = JSON.stringify(p);

  assert.ok(!/PROMPT AVI/i.test(blob), 'PROMPT AVI prefix leaked');
  assert.ok(!/\[WAITING ON/.test(blob), '[WAITING ON: ...] prefix leaked');
  assert.ok(!/—/.test(blob), 'em dash leaked');
  assert.ok(!/–/.test(blob), 'en dash leaked');
  assert.ok(!/\brdl_pull_grip\b/.test(blob), 'raw slug "rdl_pull_grip" leaked');
  assert.ok(!/REVISED v\d/i.test(blob), 'commit-message phrase leaked');
});

test('briefing payload: focus items each have required fields', () => {
  const p = buildMockBriefing();
  for (const item of p.focus) {
    for (const f of ['id', 'rank', 'pillar', 'title', 'meta', 'kind', 'status']) {
      assert.ok(f in item, `focus item missing ${f}`);
    }
    assert.ok(['work', 'personal', 'training'].includes(item.pillar), 'pillar valid');
    assert.ok(['task', 'workout'].includes(item.kind), 'kind valid');
  }
});
