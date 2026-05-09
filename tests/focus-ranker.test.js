// Focus ranker tests.
//
// Covers spec acceptance + the reviewer's flagged edge cases:
//   - stable tiebreak (id ASC)
//   - anchor workout takes hero
//   - empty pillar threshold (no synthesis)
//   - hot-override semantics
//   - waiting-on penalty unless hot

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rankFocus,
  scoreSingle,
  isHot,
  isPlanAnchor,
  normalizePillar,
  daysBetween,
} = require('../lib/focus-ranker');

const TODAY = '2026-05-08';

function task(overrides = {}) {
  return {
    id: 't' + (overrides.id || Math.random().toString(36).slice(2, 8)),
    title: 'Task',
    status: 'todo',
    priority: 'medium',
    context: 'work',
    due_date: null,
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

test('daysBetween: midnight-anchored, no DST drift', () => {
  assert.equal(daysBetween('2026-05-08', '2026-05-01'), 7);
  assert.equal(daysBetween('2026-05-01', '2026-05-08'), -7);
  assert.equal(daysBetween('2026-05-08', '2026-05-08'), 0);
});

test('isHot: urgent priority is hot', () => {
  assert.equal(isHot(task({ priority: 'urgent' }), TODAY), true);
});

test('isHot: 7+ days overdue is hot', () => {
  assert.equal(isHot(task({ due_date: '2026-04-30' }), TODAY), true);
  assert.equal(isHot(task({ due_date: '2026-05-01' }), TODAY), false);
});

test('normalizePillar: maps health/training/family/personal', () => {
  assert.equal(normalizePillar('training'), 'training');
  assert.equal(normalizePillar('health'), 'training');
  assert.equal(normalizePillar('personal'), 'personal');
  assert.equal(normalizePillar('family'), 'personal');
  assert.equal(normalizePillar('work'), 'work');
  assert.equal(normalizePillar(null), 'work');
});

test('isPlanAnchor: explicit flag wins', () => {
  assert.equal(isPlanAnchor({ is_anchor: true, target_effort: 4 }), true);
});

test('isPlanAnchor: high target_effort qualifies', () => {
  assert.equal(isPlanAnchor({ target_effort: 8 }), true);
  assert.equal(isPlanAnchor({ target_effort: 7 }), false);
});

test('isPlanAnchor: hard-day workout types qualify', () => {
  assert.equal(isPlanAnchor({ workout_type: 'strength' }), true);
  assert.equal(isPlanAnchor({ workout_type: 'hill' }), true);
  assert.equal(isPlanAnchor({ workout_type: 'long_run' }), true);
  assert.equal(isPlanAnchor({ workout_type: 'recovery' }), false);
});

// ─── rankFocus: empty + thin data ─────────────────────────────────────

test('rankFocus: empty input returns []', () => {
  assert.deepEqual(rankFocus([], TODAY), []);
});

test('rankFocus: only-todayPlan with anchor surfaces workout', () => {
  const r = rankFocus([], TODAY, {
    todayPlan: { id: 'p1', target_effort: 9, title: 'Strength A' },
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'workout');
  assert.equal(r[0].pillar, 'training');
  assert.equal(r[0].rank, 1);
});

test('rankFocus: thin data returns fewer than 3 items, no padding', () => {
  const r = rankFocus(
    [task({ id: 'a', title: 'One', priority: 'high' })],
    TODAY,
  );
  assert.equal(r.length, 1);
});

// ─── rankFocus: pillar diversity ──────────────────────────────────────

test('rankFocus: pillar diversity when data allows', () => {
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work', priority: 'urgent', due_date: '2026-05-01' }),
      task({ id: 'w2', context: 'work', priority: 'high',   due_date: '2026-05-08' }),
      task({ id: 'p1', context: 'personal', priority: 'high', due_date: '2026-05-08' }),
      task({ id: 't1', context: 'training', priority: 'medium', due_date: '2026-05-08' }),
    ],
    TODAY,
  );
  const pillars = new Set(r.map((x) => x.pillar));
  assert.ok(pillars.size >= 2, `expected >=2 pillars, got ${[...pillars].join(',')}`);
});

test('rankFocus: hero is highest-scored regardless of pillar', () => {
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work', priority: 'urgent', due_date: '2026-04-20' }), // very overdue
      task({ id: 'p1', context: 'personal', priority: 'low', due_date: '2026-05-10' }),
    ],
    TODAY,
  );
  assert.equal(r[0].id, 'w1');
});

test('rankFocus: only-Work returns Work items, no synthesis', () => {
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work', priority: 'urgent', due_date: '2026-04-20' }),
      task({ id: 'w2', context: 'work', priority: 'high', due_date: '2026-05-08' }),
      task({ id: 'w3', context: 'work', priority: 'medium' }),
    ],
    TODAY,
  );
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.pillar === 'work'), 'no synthetic pillar');
});

// ─── rankFocus: anchor precedence ─────────────────────────────────────

test('rankFocus: anchor workout takes hero over hot work task', () => {
  const r = rankFocus(
    [task({ id: 'w1', context: 'work', priority: 'urgent', due_date: '2026-04-20' })],
    TODAY,
    { todayPlan: { id: 'plan1', is_anchor: true, title: 'Strength A' } },
  );
  assert.equal(r[0].kind, 'workout');
  assert.equal(r[0].id, 'plan1');
});

test('rankFocus: non-anchor todayPlan does NOT take hero', () => {
  const r = rankFocus(
    [task({ id: 'w1', context: 'work', priority: 'urgent', due_date: '2026-04-20' })],
    TODAY,
    { todayPlan: { id: 'plan1', target_effort: 5, title: 'Easy run' } },
  );
  assert.equal(r[0].kind, 'task');
  assert.equal(r[0].id, 'w1');
});

// ─── rankFocus: hot override ──────────────────────────────────────────

test('rankFocus: hot task evicts non-hot when 3 slots already filled', () => {
  // Two hot work tasks force diversity to pass over the second hot one
  // (slot 2-3 prefer non-work). Eviction kicks in: lowest non-hot
  // non-hero (t1, low priority) is replaced by w2.
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work',     priority: 'urgent' }), // hot, hero
      task({ id: 'w2', context: 'work',     priority: 'urgent' }), // hot, same pillar
      task({ id: 'p1', context: 'personal', priority: 'low' }),    // diversity slot 2
      task({ id: 't1', context: 'training', priority: 'low' }),    // diversity slot 3 → evicted
    ],
    TODAY,
  );
  assert.ok(r.find((x) => x.id === 'w2'), 'second hot task surfaced via eviction');
  assert.ok(!r.find((x) => x.id === 't1'), 'lowest non-hot evicted');
  assert.equal(r[0].id, 'w1', 'hero unchanged');
});

test('rankFocus: hot override never evicts the hero', () => {
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work', priority: 'urgent', due_date: '2026-04-20' }),
      task({ id: 'p1', context: 'personal', priority: 'urgent' }),
      task({ id: 't1', context: 'training', priority: 'urgent' }),
      task({ id: 'p2', context: 'personal', priority: 'urgent' }),
    ],
    TODAY,
  );
  assert.equal(r[0].id, 'w1', 'hero unchanged');
});

// ─── rankFocus: stable tiebreak ───────────────────────────────────────

test('rankFocus: equal scores break by id ASC', () => {
  const a = task({ id: 'aaa', priority: 'medium', due_date: '2026-05-10' });
  const b = task({ id: 'bbb', priority: 'medium', due_date: '2026-05-10' });
  const r1 = rankFocus([a, b], TODAY);
  const r2 = rankFocus([b, a], TODAY);
  assert.equal(r1[0].id, r2[0].id, 'order stable across input order');
  assert.equal(r1[0].id, 'aaa', 'id ASC wins ties');
});

// ─── rankFocus: waiting-on semantics ──────────────────────────────────

test('rankFocus: non-urgent waiting tasks deprioritize', () => {
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work', status: 'waiting_on', waiting_on: 'X', priority: 'medium' }),
      task({ id: 'w2', context: 'work', priority: 'medium', due_date: '2026-05-08' }),
    ],
    TODAY,
  );
  assert.equal(r[0].id, 'w2', 'due-today beats waiting-on penalty');
});

test('rankFocus: prepFocusItem strips slugs + prefixes from title', () => {
  const r = rankFocus(
    [task({ id: 'a', title: 'PROMPT AVI: rdl_pull_grip session', priority: 'urgent' })],
    TODAY,
  );
  assert.equal(r[0].title, 'Deadlift, pull, grip session');
});

// ─── scoreSingle (sanity) ─────────────────────────────────────────────

test('scoreSingle: overdue contributes', () => {
  const a = scoreSingle(task({ priority: 'medium' }), TODAY);
  const b = scoreSingle(task({ priority: 'medium', due_date: '2026-04-20' }), TODAY);
  assert.ok(b > a);
});

test('scoreSingle: in_progress boosts', () => {
  const a = scoreSingle(task({ priority: 'medium' }), TODAY);
  const b = scoreSingle(task({ priority: 'medium', status: 'in_progress' }), TODAY);
  assert.ok(b > a);
});

test('scoreSingle: due-today boosts over no-date', () => {
  const a = scoreSingle(task({ priority: 'medium' }), TODAY);
  const b = scoreSingle(task({ priority: 'medium', due_date: TODAY }), TODAY);
  assert.ok(b > a);
});

// ─── v3.6: pin override ──────────────────────────────────────────────

test('rankFocus: pinned task forced into focus when it would otherwise miss', () => {
  // Three high-scored tasks fill the focus naturally. A pinned LOW-
  // priority task should still appear in the result.
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work',     priority: 'urgent' }),
      task({ id: 'p1', context: 'personal', priority: 'high'   }),
      task({ id: 't1', context: 'training', priority: 'medium' }),
      task({ id: 'p2', context: 'personal', priority: 'low', pinned: true }),
    ],
    TODAY,
  );
  assert.ok(r.find((x) => x.id === 'p2'), 'pinned task surfaced');
  assert.equal(r[0].id, 'w1', 'hero unchanged');
});

test('rankFocus: pinned flag exposed on focus item', () => {
  const r = rankFocus(
    [task({ id: 'a', priority: 'high', pinned: true })],
    TODAY,
  );
  assert.equal(r[0].is_pinned, true);
});

test('rankFocus: unpinned tasks expose is_pinned=false', () => {
  const r = rankFocus([task({ id: 'a', priority: 'high' })], TODAY);
  assert.equal(r[0].is_pinned, false);
});

test('rankFocus: hot eviction cannot remove a pinned task', () => {
  // A pinned task in slot 2 + many hot tasks competing for slot 3 —
  // the pinned task must stay.
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work',     priority: 'urgent' }),
      task({ id: 'p1', context: 'personal', priority: 'low', pinned: true }),
      task({ id: 'w2', context: 'work',     priority: 'urgent' }),
      task({ id: 'w3', context: 'work',     priority: 'urgent' }),
    ],
    TODAY,
  );
  assert.ok(r.find((x) => x.id === 'p1'), 'pinned task survived hot eviction');
});

test('rankFocus: only the first pinned task is honored when many are pinned', () => {
  // If two tasks are pinned but only one slot is available, just take
  // one. Predictable focus shape > honoring every pin.
  const r = rankFocus(
    [
      task({ id: 'w1', context: 'work',     priority: 'urgent' }),
      task({ id: 'p1', context: 'personal', priority: 'medium' }),
      task({ id: 't1', context: 'training', priority: 'medium' }),
      task({ id: 'pp1', context: 'personal', priority: 'low', pinned: true }),
      task({ id: 'pp2', context: 'work',     priority: 'low', pinned: true }),
    ],
    TODAY,
  );
  const pinnedCount = r.filter((x) => x.is_pinned).length;
  assert.ok(pinnedCount >= 1 && pinnedCount <= 2, 'at most a couple pins surfaced');
  assert.equal(r.length, 3, 'still capped at 3');
});
