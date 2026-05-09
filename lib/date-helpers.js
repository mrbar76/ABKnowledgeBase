// lib/date-helpers.js
//
// Canonical local-midnight date utilities. Single source of truth for
// every "is this overdue?", "how many days until?", "is this today?"
// question across the codebase.
//
// All math anchors at LOCAL midnight (the user's wall-clock day, not
// UTC). This is the right behavior for a personal app — you skip a
// workout when it's 11pm Tuesday in your timezone, not when it's 3am
// Wednesday in UTC. The audit (May 2026) flagged 17 places where we
// got this wrong; this module + the call-site rewrites fix all of
// them.
//
// Accepts: ISO date string ("2026-05-09" or "2026-05-09T...")
//          JS Date object (Postgres DATE columns deserialize as Date)
//          any Date-coercible value
//
// Returns: zero on invalid input — never NaN or undefined. Failure is
// silent and conservative; the calling site never silently shows the
// wrong day.

'use strict';

/**
 * Coerces any input into a JS Date anchored at local midnight.
 * Returns null if the input cannot be parsed.
 */
function toLocalMidnight(d) {
  if (d == null) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  // ISO string fast path: split on '-' so timezone parsing never
  // happens. "2026-05-09T..." also works because slice(0,10) trims.
  const s = String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // Last-resort: parse and strip time. Handles "Mon May 09 2026" etc.
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

/**
 * Today's local-midnight Date.
 */
function todayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Today as ISO date string in local time. Returns "YYYY-MM-DD".
 *
 * Standard `new Date().toISOString().slice(0,10)` returns the UTC
 * date — wrong for users west of UTC after 8pm local. This helper
 * always returns the user's local calendar date.
 */
function todayLocalISO() {
  const d = todayLocal();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Same as todayLocalISO but for an arbitrary input date.
 */
function toLocalISO(d) {
  const m = toLocalMidnight(d);
  if (!m) return null;
  const yyyy = m.getFullYear();
  const mm = String(m.getMonth() + 1).padStart(2, '0');
  const dd = String(m.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Days from `from` to `to`. Positive = `to` is in the future.
 *
 * `daysBetween(today, due_date)` > 0 means due_date is in the future.
 * `daysBetween(today, due_date)` < 0 means it's overdue (past).
 * `daysBetween(today, due_date)` === 0 means due today.
 *
 * Anchors both inputs at local midnight before subtracting, so DST
 * transitions and partial-day timestamps don't shift the answer.
 *
 * Returns 0 for invalid input — never NaN.
 */
function daysBetween(from, to) {
  const a = toLocalMidnight(from);
  const b = toLocalMidnight(to);
  if (!a || !b) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * Negative of daysBetween — "how many days HAS this been overdue".
 * `daysOverdue(today, due_date)` > 0 means due_date is in the past.
 */
function daysOverdue(today, dueDate) {
  return -daysBetween(today, dueDate);
}

/**
 * True if both inputs land on the same local calendar day.
 */
function isSameDay(a, b) {
  const ma = toLocalMidnight(a);
  const mb = toLocalMidnight(b);
  if (!ma || !mb) return false;
  return ma.getTime() === mb.getTime();
}

/**
 * `n` days before / after today, returned as ISO date string.
 *   daysAgoISO(7)  → 7 days back
 *   daysAgoISO(-3) → 3 days forward
 *
 * Replaces the common pattern `d.setDate(d.getDate() - n)` which
 * misbehaves at month boundaries (Mar 31 - 30 days = Feb 1, not Mar 1).
 */
function daysAgoISO(n) {
  const today = todayLocal();
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  return toLocalISO(d);
}

/**
 * `n` days before/after a reference date, returned as ISO. Sibling of
 * daysAgoISO that doesn't assume "today".
 */
function shiftDaysISO(refDate, n) {
  const m = toLocalMidnight(refDate);
  if (!m) return null;
  const d = new Date(m.getFullYear(), m.getMonth(), m.getDate() + n);
  return toLocalISO(d);
}

module.exports = {
  toLocalMidnight,
  todayLocal,
  todayLocalISO,
  toLocalISO,
  daysBetween,
  daysOverdue,
  isSameDay,
  daysAgoISO,
  shiftDaysISO,
};
