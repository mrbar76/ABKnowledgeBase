// lib/voice.js
//
// Single source of truth for user-facing string voice rules.
// Backend strips first; frontend strips defensively. Both layers run cleanForUI.
// Idempotent: cleanForUI(cleanForUI(x)) === cleanForUI(x).
//
// composeCoachRead builds the three-sentence Today coach read deterministically
// from structured signals. No LLM.

'use strict';

// Workout focus slugs that appear in `workouts.workout_focus` and `daily_plans.workout_focus`.
// Keep this map up to date as new slugs appear in the data. The defensive
// fallback (underscores → spaces) catches anything we haven't mapped yet.
const SLUG_MAP = {
  rdl_pull_grip: 'Deadlift, pull, grip',
  strength_a: 'Strength A',
  strength_b: 'Strength B',
  strength_c: 'Strength C',
  hill_intervals: 'Hill intervals',
  hill_repeats: 'Hill repeats',
  tempo_run: 'Tempo run',
  easy_run: 'Easy run',
  long_run: 'Long run',
  recovery_walk: 'Recovery walk',
  z2_walk: 'Z2 walk',
  z3_walk: 'Z3 walk',
  z2_run: 'Z2 run',
  z3_run: 'Z3 run',
  mobility: 'Mobility',
  farmers_walk: "Farmer's walk",
  stair_climber: 'Stair climber',
  pull_grip: 'Pull and grip',
  squat_press: 'Squat and press',
  bench_row: 'Bench and row',
  upper_push: 'Upper push',
  upper_pull: 'Upper pull',
  full_body: 'Full body',
};

const FORBIDDEN_PREFIXES = [
  /^\[WAITING ON:[^\]]*\]\s*/i,
  /^PROMPT AVI[:\s]+/i,
  /^TODO:\s*/i,
  /^DEV:\s*/i,
  /^DRAFT:\s*/i,
  /^\[INTERNAL\]\s*/i,
];

const FORBIDDEN_SUBSTRINGS = [
  /REVISED v\d+[^.]*\.?/gi,
  /\bper spec section[^.]*\.?/gi,
  /\bworkout [a-f0-9]{8}\b/gi,
  /\bGoal \d+ (was|is) being\b[^.]*\.?/gi,
];

// Detects a probable slug: lowercase tokens joined by underscores. Used as the
// fallback display when SLUG_MAP doesn't have an entry.
const SLUG_LIKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Cleans a string for user-facing display.
 * Idempotent — safe to call multiple times.
 */
function cleanForUI(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') return String(raw);

  let s = raw;

  for (const re of FORBIDDEN_PREFIXES) {
    s = s.replace(re, '');
  }

  s = s.replace(/[—–]/g, '-');

  // Map known slugs. Word-boundary match so "rdl_pull_grip" inside a sentence
  // becomes "Deadlift, pull, grip" without touching surrounding words.
  for (const [slug, display] of Object.entries(SLUG_MAP)) {
    s = s.replace(new RegExp(`\\b${slug}\\b`, 'g'), display);
  }

  // Defensive fallback for any unmapped slug-shaped token.
  s = s.replace(SLUG_LIKE, (match) => match.replace(/_/g, ' '));

  for (const re of FORBIDDEN_SUBSTRINGS) {
    s = s.replace(re, '');
  }

  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\[\(]\s*/, '').replace(/\s*[\]\)]$/, '');

  return s;
}

/**
 * Cleans an array of strings, dropping empties.
 */
function cleanAllForUI(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(cleanForUI).filter(Boolean);
}

/**
 * Builds the three-sentence coach read for the Today screen.
 * Deterministic — no LLM. Pure function of structured signals.
 *
 * Returns: { lead, body, mute } — any may be empty string (frontend hides).
 *
 * Signals shape:
 *   yesterday: { workouts_completed, tasks_completed, workouts: [{title, ...}] }
 *   today:     { planned_workout: { display_title, title, is_anchor }, top_focus }
 *   recovery:  { score, label }
 *   overdue:   { count, hot_count }
 *   race:      { name, days_away } | null
 *   between_phases: boolean
 *   shabbat:   boolean
 */
function composeCoachRead(signals) {
  const safe = signals || {};
  const {
    yesterday = {},
    today = {},
    recovery = {},
    overdue = {},
    race = null,
    between_phases = false,
    shabbat = false,
    shabbat_status = null,
  } = safe;

  // Shabbat: don't blank the screen. Personal + training stay live.
  // Work is filtered upstream by the briefing route. Coach read notes
  // the candle lighting / havdalah times when available.
  if (shabbat) {
    const hav = shabbat_status && shabbat_status.havdalah_time_label;
    return {
      lead: 'Shabbat.',
      body: 'Work is paused. Personal and training stay live.',
      mute: hav ? `Havdalah at ${hav}.` : 'See you Saturday night.',
    };
  }

  let lead = '';
  let body = '';
  let mute = '';

  // === LEAD: react to yesterday ===
  const yWorkouts = Array.isArray(yesterday.workouts) ? yesterday.workouts : [];
  const hasYesterdayData =
    yesterday.workouts_completed != null || yesterday.tasks_completed != null;
  if (yesterday.workouts_completed > 0 && yWorkouts[0]) {
    const w = yWorkouts[0];
    const title = cleanForUI(w.display_title || w.title || 'session');
    lead = `Yesterday's ${title.toLowerCase()} landed.`;
  } else if (
    hasYesterdayData &&
    (yesterday.tasks_completed || 0) === 0 &&
    (yesterday.workouts_completed || 0) === 0
  ) {
    lead = 'Yesterday was quiet.';
  } else if (yesterday.tasks_completed > 0) {
    const n = yesterday.tasks_completed;
    lead = `Yesterday: ${n} ${n === 1 ? 'thing' : 'things'} done.`;
  }

  // === BODY: name today's main thing ===
  if (today.planned_workout) {
    const w = today.planned_workout;
    const title = cleanForUI(w.display_title || w.title || 'training');
    body = w.is_anchor ? `Today: ${title}. Anchor session.` : `Today: ${title}.`;
  } else if (race && race.days_away != null && race.days_away <= 3) {
    body = `${cleanForUI(race.name)} in ${race.days_away} ${race.days_away === 1 ? 'day' : 'days'}. Taper.`;
  } else if (today.top_focus) {
    const title = cleanForUI(today.top_focus.title);
    body = `Today: ${title}.`;
  } else if (between_phases) {
    body = 'Between phases. Plan the next block.';
  }

  // === MUTE: secondary note, follow-up, or warning ===
  // Type-defended: top_focus may be a task OR a workout. Status check is
  // only meaningful on tasks (kind='task'). Workouts don't have
  // waiting_on semantics.
  const tf = today.top_focus;
  const tfIsWaitingTask =
    tf &&
    tf.kind === 'task' &&
    tf.status === 'waiting_on' &&
    tf.days_waiting > 0;
  if (overdue.hot_count > 0 && tfIsWaitingTask) {
    const title = cleanForUI(tf.title);
    mute = `Then ${title.toLowerCase()}. ${tf.days_waiting} days sitting.`;
  } else if (recovery.score != null && recovery.score < 50) {
    mute = 'Recovery low. Cap effort at RPE 7.';
  } else if (overdue.hot_count > 0) {
    mute = `${overdue.hot_count} ${overdue.hot_count === 1 ? 'hot item' : 'hot items'} overdue.`;
  } else if (between_phases) {
    mute = 'Easy week before next block.';
  } else if (
    shabbat_status &&
    shabbat_status.is_friday &&
    !shabbat &&
    shabbat_status.candle_lighting_time_label
  ) {
    // Friday before candle lighting: quiet heads-up.
    mute = `Candle lighting at ${shabbat_status.candle_lighting_time_label}.`;
  }

  return { lead, body, mute };
}

/**
 * Returns a copy of `row` with each named field run through cleanForUI.
 * Unknown fields are left untouched. Null rows pass through.
 */
function cleanFields(row, fieldNames) {
  if (!row || typeof row !== 'object') return row;
  if (!Array.isArray(fieldNames) || fieldNames.length === 0) return row;
  const out = { ...row };
  for (const f of fieldNames) {
    if (out[f] != null) out[f] = cleanForUI(out[f]);
  }
  return out;
}

/**
 * Maps cleanFields over an array of rows.
 */
function cleanRows(rows, fieldNames) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => cleanFields(r, fieldNames));
}

module.exports = {
  cleanForUI,
  cleanAllForUI,
  cleanFields,
  cleanRows,
  composeCoachRead,
  SLUG_MAP,
};
