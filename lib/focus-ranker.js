// lib/focus-ranker.js
//
// Pillar-diverse focus ranker. Replaces the (overdue, priority) sort that
// produced single-pillar focus lists in the legacy /briefing endpoint.
//
// Hero precedence (top to bottom — first applicable wins):
//   1. Today's planned workout if flagged anchor.
//   2. The single highest-scored hot task (urgent OR 7+ days overdue).
//   3. The single highest-scored task across all pillars.
//
// Slots 2-3:
//   - Prefer the highest-scored task in a pillar not yet represented.
//   - Empty-pillar threshold: never force-fill from a pillar with zero
//     focus-eligible items. Better to show 2 work + 1 family than 1 work
//     + 1 family + 1 invented training nag.
//   - Hot items always rank above non-hot. Hot items not yet in focus can
//     evict the lowest-scored non-hot item (never the hero).
//
// Tie-breaking is stable: equal scores fall back to id ASC. This makes
// the ranker deterministic across DBs and consistent across reloads.
//
// All date math uses local-midnight anchors via the daysBetween helper
// below, which sidesteps audit calc bugs #6 and #11 (timezone drift in
// the legacy ranker code).

'use strict';

const { cleanForUI } = require('./voice');

const PRIORITY_SCORE = { urgent: 30, high: 15, medium: 5, low: 0 };

// ─── Local-midnight date helpers ───────────────────────────────────────

// Robust against three input shapes:
//   - ISO string "2026-05-08" or "2026-05-08T..."
//   - JS Date object (Postgres DATE columns deserialize as Date)
//   - other Date-coercible values
// Anchors at local midnight to avoid timezone/DST drift.
function toLocalMidnight(d) {
  if (d instanceof Date) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(day)) {
    return new Date(y, m - 1, day);
  }
  // Last-resort: parse and strip time.
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function daysBetween(dateA, dateB) {
  const a = toLocalMidnight(dateA);
  const b = toLocalMidnight(dateB);
  if (!a || !b) return 0;
  return Math.round((a - b) / 86400000);
}

function isSameDay(a, b) {
  const ma = toLocalMidnight(a);
  const mb = toLocalMidnight(b);
  if (!ma || !mb) return false;
  return ma.getTime() === mb.getTime();
}

// ─── Eligibility + classification ──────────────────────────────────────

function isFocusEligible(task) {
  if (!task) return false;
  if (['done', 'archived', 'cancelled'].includes(task.status)) return false;
  if (task.deleted_at) return false;
  return true;
}

function isHot(task, todayISO) {
  if (task.priority === 'urgent') return true;
  const overdue = task.due_date ? daysBetween(todayISO, task.due_date) : 0;
  return overdue > 7;
}

function normalizePillar(context) {
  if (context === 'health' || context === 'training') return 'training';
  if (context === 'personal' || context === 'family') return 'personal';
  return 'work';
}

// ─── Scoring ───────────────────────────────────────────────────────────

function scoreSingle(task, todayISO) {
  let score = 0;

  // Overdue (capped to prevent very-stale items from dominating).
  const overdueDays = task.due_date ? Math.max(0, daysBetween(todayISO, task.due_date)) : 0;
  score += Math.min(overdueDays * 5, 50);

  // Priority.
  score += PRIORITY_SCORE[task.priority] || 0;

  // Recency boost.
  if (task.updated_at) {
    const hoursSinceUpdate = (Date.now() - new Date(task.updated_at).getTime()) / 36e5;
    if (hoursSinceUpdate < 24) score += 8;
    if (hoursSinceUpdate > 14 * 24) score -= 5;
  }

  // In-progress boost.
  if (task.status === 'in_progress') score += 12;

  // Waiting-on penalty unless hot.
  const isWaiting = task.status === 'waiting_on' || task.waiting_on;
  if (isWaiting && task.priority !== 'urgent' && overdueDays < 7) {
    score -= 10;
  }

  // Due-today boost.
  if (task.due_date && isSameDay(task.due_date, todayISO)) score += 10;

  return score;
}

// Stable comparator: score DESC, then id ASC.
function compareTasks(todayISO) {
  return (a, b) => {
    const sa = scoreSingle(a, todayISO);
    const sb = scoreSingle(b, todayISO);
    if (sb !== sa) return sb - sa;
    return String(a.id || '').localeCompare(String(b.id || ''));
  };
}

// ─── Item builders ─────────────────────────────────────────────────────

function buildMetaString(task, todayISO) {
  if (task.waiting_on) {
    const days = task.updated_at
      ? Math.max(0, Math.floor((Date.now() - new Date(task.updated_at).getTime()) / 864e5))
      : 0;
    return days > 0 ? `${days} ${days === 1 ? 'day' : 'days'} waiting` : 'just sent';
  }
  if (task.due_date) {
    const days = daysBetween(todayISO, task.due_date);
    if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'} overdue`;
    if (days === 0) return 'due today';
    if (days === -1) return 'due tomorrow';
    if (days >= -7) return `due in ${-days} days`;
    return `due ${formatShortDate(task.due_date)}`;
  }
  if (task.priority === 'urgent') return 'urgent';
  if (task.priority === 'high') return 'high priority';
  return '';
}

function buildPlanMeta(plan) {
  const parts = [];
  if (plan.target_duration_min) parts.push(`${plan.target_duration_min} min`);
  if (plan.target_effort) parts.push(`effort ${plan.target_effort}/10`);
  return parts.join(' · ');
}

function formatShortDate(iso) {
  return new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

function prepFocusItem(task, rank, todayISO) {
  const overdueDays = task.due_date ? Math.max(0, daysBetween(todayISO, task.due_date)) : 0;
  const daysWaiting = task.updated_at
    ? Math.max(0, Math.floor((Date.now() - new Date(task.updated_at).getTime()) / 864e5))
    : 0;
  return {
    id: task.id,
    rank,
    pillar: normalizePillar(task.context),
    title: cleanForUI(task.title),
    body: task.notes ? cleanForUI(task.notes).slice(0, 140) : '',
    meta: buildMetaString(task, todayISO),
    waiting_on_person: task.waiting_on || null,
    days_waiting: daysWaiting,
    overdue_days: overdueDays,
    is_hot: isHot(task, todayISO),
    status: task.status,
    kind: 'task',
  };
}

function planAsFocusItem(plan, rank) {
  return {
    id: plan.id,
    rank,
    pillar: 'training',
    title: cleanForUI(plan.title || plan.workout_focus || "Today's session"),
    body: plan.workout_notes ? cleanForUI(plan.workout_notes).slice(0, 140) : '',
    meta: buildPlanMeta(plan),
    waiting_on_person: null,
    days_waiting: 0,
    overdue_days: 0,
    is_hot: false,
    status: plan.status || 'planned',
    kind: 'workout',
  };
}

// Plan is anchor when explicitly flagged or when its target_effort is high
// or workout_type is in the hard-day set. The DB doesn't have an
// is_anchor column today; this is the heuristic agreed in v3 planning.
function isPlanAnchor(plan) {
  if (!plan) return false;
  if (plan.is_anchor === true) return true;
  if ((plan.target_effort || 0) >= 8) return true;
  const t = String(plan.workout_type || '').toLowerCase();
  return t === 'strength' || t === 'hill' || t === 'long_run';
}

// ─── Main ranker ───────────────────────────────────────────────────────

/**
 * Returns up to 3 focus items with pillar diversity applied.
 *
 * @param {Array<object>} allOpenTasks   All open tasks for the user.
 * @param {string} todayISO              Local date string YYYY-MM-DD.
 * @param {object} options
 * @param {object} [options.todayPlan]   Today's daily_plan row, if any.
 */
function rankFocus(allOpenTasks, todayISO, options = {}) {
  const todayPlan = options.todayPlan || null;
  const eligible = (allOpenTasks || []).filter(isFocusEligible);
  const ranked = eligible.slice().sort(compareTasks(todayISO));

  const focus = [];

  // ─── Hero (slot 1) ──────────────────────────────────────────────────
  if (isPlanAnchor(todayPlan)) {
    focus.push(planAsFocusItem(todayPlan, 1));
  } else if (ranked.length > 0) {
    focus.push(prepFocusItem(ranked[0], 1, todayISO));
  } else if (todayPlan) {
    focus.push(planAsFocusItem(todayPlan, 1));
  }

  if (focus.length === 0) return [];

  const heroPillar = focus[0].pillar;
  const heroTaskId = focus[0].kind === 'task' ? focus[0].id : null;

  // Bucket eligible tasks by pillar, ranked, hero excluded.
  const byPillar = { work: [], personal: [], training: [] };
  for (const t of ranked) {
    if (t.id === heroTaskId) continue;
    const p = normalizePillar(t.context);
    byPillar[p].push(t);
  }

  // ─── Slots 2-3: prefer non-hero pillars ─────────────────────────────
  const nonHeroPillars = ['work', 'personal', 'training'].filter((p) => p !== heroPillar);
  for (const pillar of nonHeroPillars) {
    if (focus.length >= 3) break;
    const candidate = byPillar[pillar][0];
    if (candidate) {
      focus.push(prepFocusItem(candidate, focus.length + 1, todayISO));
      byPillar[pillar].shift();
    }
  }

  // ─── Fallback: fill remaining slots from any pillar ────────────────
  if (focus.length < 3) {
    const claimedIds = new Set(focus.map((f) => f.id));
    for (const t of ranked) {
      if (focus.length >= 3) break;
      if (claimedIds.has(t.id)) continue;
      focus.push(prepFocusItem(t, focus.length + 1, todayISO));
      claimedIds.add(t.id);
    }
  }

  // ─── Hot override: any hot task not yet in focus must show up ──────
  // Hot evicts the lowest-scored non-hot item below the hero. The hero
  // is never replaced by this rule (anchor precedence + score precedence
  // already ran).
  const hot = ranked.filter((t) => isHot(t, todayISO));
  for (const ht of hot) {
    if (focus.find((f) => f.id === ht.id)) continue;
    if (focus.length < 3) {
      focus.push(prepFocusItem(ht, focus.length + 1, todayISO));
      continue;
    }
    // Find the lowest-scored non-hot, non-hero item to evict.
    let evictIdx = -1;
    for (let i = focus.length - 1; i >= 1; i--) {
      if (!focus[i].is_hot) { evictIdx = i; break; }
    }
    if (evictIdx > 0) focus[evictIdx] = prepFocusItem(ht, evictIdx + 1, todayISO);
  }

  return focus.slice(0, 3).map((item, i) => ({ ...item, rank: i + 1 }));
}

module.exports = {
  rankFocus,
  // Helpers exported for unit tests.
  scoreSingle,
  isFocusEligible,
  isHot,
  isPlanAnchor,
  normalizePillar,
  daysBetween,
  PRIORITY_SCORE,
};
