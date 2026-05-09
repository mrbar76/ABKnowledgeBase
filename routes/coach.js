// Composite "coach context" endpoints. Each one bundles the data a
// specific coaching skill needs into a single round-trip.
//
// Design rules:
//   1. Every endpoint returns in <500ms p95. We achieve this via
//      Promise.all of independent SQL queries — no sequential awaits.
//   2. Every endpoint is read-only (GET).
//   3. Every endpoint replaces a fan-out of 3-7 calls the skills used
//      to make. The skill should hit /api/coach/<scenario> ONCE, then
//      escalate context only if the conversation goes deeper.
//   4. is_stale flags on vitals tell the skill when to fall back to
//      subjective Q&A or re-prompt the user to run the morning Shortcut.

const express = require('express');
const { query } = require('../db');
const { cleanFields, cleanRows } = require('../lib/voice');

// Coach response sub-objects clean their own narrative-bearing fields
// before leaving the server. Coverage is intentionally targeted, not
// recursive — most coach surface area routes through /briefing or the
// standard CRUD endpoints (also voice-cleaned). Frontend runs a
// defensive cleanForUI pass at render time as belt-and-suspenders.
const COACHING_SESSION_FIELDS = [
  'title', 'summary', 'injury_notes', 'nutrition_notes',
  'recovery_notes', 'mental_notes', 'next_steps',
];
const INJURY_FIELDS = [
  'title', 'symptoms', 'treatment', 'notes', 'mechanism',
  'modifications', 'aggravating_movements', 'relieving_factors',
];
const PLAN_TEXT_FIELDS = [
  'title', 'goal', 'workout_focus', 'workout_notes',
  'recovery_notes', 'coaching_notes', 'rationale', 'completion_notes',
];
const router = express.Router();

// ─── small helpers ─────────────────────────────────────────────────
// v3.4: was returning UTC date. For users west of UTC after 8pm local
// the returned date was tomorrow's, shifting week boundaries off by a
// day (audit bug #12). Use the canonical local-date helper.
const { todayLocalISO } = require('../lib/date-helpers');
const todayISO = () => todayLocalISO();
const yesterdayISO = () => new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const daysAgoISO = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

function dateOnly(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// Latest non-null reading from rows[] for a column. Walks back by date.
function mostRecentNonNull(rows, field) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][field] != null) {
      return { value: Number(rows[i][field]), as_of: dateOnly(rows[i].activity_date) };
    }
  }
  return { value: null, as_of: null };
}

// Same merged-source query the /insights endpoints use post-v1.9.4. Cache
// values win on overlap; daily_activity fills historical baselines until
// Phase 8 (~Aug 5, 2026).
async function loadMergedVitals(lookbackDays = 30) {
  const startDate = daysAgoISO(lookbackDays);
  // is_stale derived inline (NOW() can't live in a STORED generated column).
  // Threshold: cache row > 6h old means we should re-prompt the Shortcut or
  // fall back to subjective Q&A.
  const r = await query(
    `SELECT
       COALESCE(c.date, da.activity_date)              AS activity_date,
       COALESCE(c.hrv_ms, da.hrv_sdnn_ms)              AS hrv_sdnn_ms,
       COALESCE(c.rhr_bpm, da.resting_hr_bpm)          AS resting_hr_bpm,
       COALESCE(c.sleep_total_min, da.sleep_total_min) AS sleep_total_min,
       da.sleep_efficiency_pct,
       c.respiratory_rate_bpm,
       (c.updated_at < NOW() - INTERVAL '6 hours') AS cache_is_stale,
       c.updated_at AS cache_updated_at
     FROM daily_vitals_cache c
     FULL OUTER JOIN daily_activity da ON c.date = da.activity_date
     WHERE COALESCE(c.date, da.activity_date) >= $1
     ORDER BY activity_date ASC`,
    [startDate]
  );
  return r.rows;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }
function lastNValues(rows, field, n) {
  const values = [];
  for (let i = rows.length - 1; i >= 0 && values.length < n; i--) {
    if (rows[i][field] != null) values.push(Number(rows[i][field]));
  }
  return values.reverse();
}

// Build readiness object with deviation_sd and is_stale flags.
function readinessFromRows(rows, today) {
  const hrvL = mostRecentNonNull(rows, 'hrv_sdnn_ms');
  const rhrL = mostRecentNonNull(rows, 'resting_hr_bpm');
  const sleepL = mostRecentNonNull(rows, 'sleep_total_min');
  const respL = mostRecentNonNull(rows, 'respiratory_rate_bpm');

  // Use 30-day baselines for deviation math
  const hrvHistory = lastNValues(rows, 'hrv_sdnn_ms', 30);
  const rhrHistory = lastNValues(rows, 'resting_hr_bpm', 30);

  const hrvBase = mean(hrvHistory);
  const hrvSd = stddev(hrvHistory);
  const rhrBase = mean(rhrHistory);
  const rhrSd = stddev(rhrHistory);

  const hrvDev = (hrvL.value != null && hrvBase != null && hrvSd) ? (hrvL.value - hrvBase) / hrvSd : null;
  const rhrDev = (rhrL.value != null && rhrBase != null && rhrSd) ? (rhrL.value - rhrBase) / rhrSd : null;

  // is_stale = the latest value is from a date before today
  const hrvStale = hrvL.as_of !== today;
  const rhrStale = rhrL.as_of !== today;
  const sleepStale = sleepL.as_of !== today;
  const respStale = respL.as_of !== today;

  return {
    hrv: {
      value: hrvL.value,
      as_of: hrvL.as_of,
      deviation_sd: round1(hrvDev),
      baseline: round1(hrvBase),
      is_stale: hrvStale,
    },
    rhr: {
      value: rhrL.value,
      as_of: rhrL.as_of,
      deviation_sd: round1(rhrDev),
      baseline: round1(rhrBase),
      is_stale: rhrStale,
    },
    sleep: {
      total_min: sleepL.value,
      as_of: sleepL.as_of,
      is_stale: sleepStale,
    },
    respiratory_rate: {
      value: round1(respL.value),
      as_of: respL.as_of,
      is_stale: respStale,
    },
  };
}

// ─── Coaching alerts (high-severity only for the morning composite) ─
// Mirrors the rule logic in /insights/morning but kept local to coach.js
// so this endpoint is independent of insights.js's evolution.
async function highSeverityAlerts() {
  const recent = await query(
    `SELECT workout_date, effort FROM workouts
     WHERE workout_date >= CURRENT_DATE - INTERVAL '14 days'
       AND effort IS NOT NULL
     ORDER BY workout_date ASC`
  );
  const rows = recent.rows;
  const alerts = [];

  // Density: 3+ consecutive hard days (effort >= 7)
  let consec = 0;
  for (const r of rows) {
    if (Number(r.effort) >= 7) consec++; else consec = 0;
    if (consec >= 3) {
      alerts.push({
        rule: 'density',
        severity: 'high',
        reason: `${consec} consecutive hard days (effort ≥ 7) — forced rest`,
      });
      break;
    }
  }

  // Chronic load: 5+ effort 8+ days in last 14
  const veryHard = rows.filter(r => Number(r.effort) >= 8).length;
  if (veryHard >= 5) {
    alerts.push({
      rule: 'chronic_load',
      severity: 'high',
      reason: `${veryHard} effort 8+ sessions in last 14d — forced deload`,
    });
  }

  return alerts;
}

// ─── 3a. GET /api/coach/morning ───────────────────────────────────
// Replaces: /insights/morning + /recovery/score + /injuries?status=active
// + /injuries?status=recovering + /daily-plans?date=today
// + /workouts?since=yesterday + /training/coaching?since=2d
router.get('/morning', async (req, res) => {
  try {
    const today = todayISO();
    const yesterday = yesterdayISO();

    const [vitalsRows, alertsArr, injuries, planRow, yesterdayWorkouts, recentCoaching] =
      await Promise.all([
        loadMergedVitals(30),
        highSeverityAlerts(),
        query(
          `SELECT id, title, body_area, side, severity, status, modifications
           FROM injuries
           WHERE status IN ('active','recovering','monitoring')
           ORDER BY severity DESC NULLS LAST LIMIT 10`
        ),
        query(`SELECT * FROM daily_plans WHERE plan_date = $1`, [today]),
        query(
          `SELECT id, title, workout_date, workout_type, effort, duration_minutes
           FROM workouts
           WHERE workout_date = $1 AND deleted_at IS NULL
           ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT 5`,
          [yesterday]
        ),
        // v1.10.4: truncate summary at 200 chars. Full text still queryable
        // via GET /api/training/coaching/:id when the skill needs to dive in.
        // Was inflating /coach/morning to 160KB on cold start.
        query(
          `SELECT id, session_date, title,
                  LEFT(summary, 200) AS summary,
                  LENGTH(summary) > 200 AS summary_truncated,
                  key_decisions, next_steps, tags
           FROM coaching_sessions
           WHERE session_date >= $1
           ORDER BY session_date DESC, created_at DESC LIMIT 2`,
          [daysAgoISO(2)]
        ),
      ]);

    // Attach plan segments if a plan exists. v1.10.4: select narrow workout
    // columns + truncated body_notes per segment instead of w.* — was
    // returning 1500+ char prescriptions per workout.
    let todayPlan = planRow.rows[0] || null;
    if (todayPlan) {
      const segR = await query(
        `SELECT ps.id, ps.block_order, ps.block_label, ps.title_suffix,
                ps.logging_target, ps.target_duration_min, ps.target_effort,
                ps.status, ps.planned_exercises,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                     'id', w.id, 'title', w.title, 'effort', w.effort,
                     'duration_minutes', w.duration_minutes,
                     'workout_type', w.workout_type,
                     'body_notes', LEFT(w.body_notes, 200),
                     'body_notes_truncated', LENGTH(w.body_notes) > 200
                   ) ORDER BY w.started_at NULLS LAST, w.created_at)
                   FROM workouts w
                   WHERE w.plan_segment_id = ps.id AND w.deleted_at IS NULL),
                  '[]'::json
                ) AS workouts
         FROM plan_segments ps
         WHERE ps.daily_plan_id = $1
         ORDER BY ps.block_order`,
        [todayPlan.id]
      ).catch(() => ({ rows: [] }));
      todayPlan.segments = segR.rows;
    }

    const yWorkout = yesterdayWorkouts.rows[0];
    const yesterday_summary = yWorkout ? {
      workout_title: yWorkout.title,
      workout_type: yWorkout.workout_type,
      effort: yWorkout.effort,
      duration_min: yWorkout.duration_minutes,
    } : null;

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      today_plan: cleanFields(todayPlan, PLAN_TEXT_FIELDS),
      readiness: readinessFromRows(vitalsRows, today),
      alerts: alertsArr,
      active_injuries: cleanRows(injuries.rows, INJURY_FIELDS),
      yesterday_summary,
      recent_coaching: cleanRows(recentCoaching.rows, COACHING_SESSION_FIELDS),
    });
  } catch (err) {
    console.error('[GET /coach/morning]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3b. GET /api/coach/midday-amend ──────────────────────────────
// Replaces: /insights/today + /recovery/score + /training/day/today
// + /daily-plans?date=today + /injuries
router.get('/midday-amend', async (req, res) => {
  try {
    const today = todayISO();

    const [vitalsRows, alertsArr, injuries, planRow, todaySession] =
      await Promise.all([
        loadMergedVitals(30),
        highSeverityAlerts(),
        query(
          `SELECT id, title, body_area, side, severity, status, modifications
           FROM injuries
           WHERE status IN ('active','recovering','monitoring')
           ORDER BY severity DESC NULLS LAST LIMIT 10`
        ),
        query(`SELECT * FROM daily_plans WHERE plan_date = $1`, [today]),
        query(
          `SELECT id, title, summary, key_decisions, next_steps, tags
           FROM coaching_sessions
           WHERE session_date = $1
           ORDER BY created_at DESC LIMIT 1`,
          [today]
        ),
      ]);

    let todayPlan = planRow.rows[0] || null;
    if (todayPlan) {
      // v1.10.4: narrow columns + truncated body_notes (perf).
      const segR = await query(
        `SELECT ps.id, ps.block_order, ps.block_label, ps.title_suffix,
                ps.logging_target, ps.target_duration_min, ps.target_effort,
                ps.status, ps.planned_exercises,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                     'id', w.id, 'title', w.title, 'effort', w.effort,
                     'duration_minutes', w.duration_minutes,
                     'workout_type', w.workout_type,
                     'body_notes', LEFT(w.body_notes, 200),
                     'body_notes_truncated', LENGTH(w.body_notes) > 200
                   ) ORDER BY w.started_at NULLS LAST, w.created_at)
                   FROM workouts w
                   WHERE w.plan_segment_id = ps.id AND w.deleted_at IS NULL),
                  '[]'::json
                ) AS workouts
         FROM plan_segments ps
         WHERE ps.daily_plan_id = $1
         ORDER BY ps.block_order`,
        [todayPlan.id]
      ).catch(() => ({ rows: [] }));
      todayPlan.segments = segR.rows;
    }

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      today_plan: cleanFields(todayPlan, PLAN_TEXT_FIELDS),
      readiness: readinessFromRows(vitalsRows, today),
      alerts: alertsArr,
      active_injuries: cleanRows(injuries.rows, INJURY_FIELDS),
      today_session: todaySession.rows[0] || null,
    });
  } catch (err) {
    console.error('[GET /coach/midday-amend]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3c. GET /api/coach/preworkout?in_minutes=90 ──────────────────
// Replaces: /daily-plans?date=today + /body-metrics?limit=1
// + /meals?date=today + /races/fueling/list?limit=1
router.get('/preworkout', async (req, res) => {
  try {
    const today = todayISO();
    const inMin = Math.max(0, Math.min(Number(req.query.in_minutes) || 90, 360));

    const [planRow, latestWeight, todayMeals, lastFueling] = await Promise.all([
      query(`SELECT * FROM daily_plans WHERE plan_date = $1`, [today]),
      query(
        `SELECT weight_lb, body_fat_pct, measurement_date
         FROM body_metrics ORDER BY measurement_date DESC LIMIT 1`
      ),
      query(
        `SELECT title, calories, protein_g, carbs_g, fat_g, meal_time
         FROM meals WHERE meal_date = $1 ORDER BY meal_time NULLS LAST`,
        [today]
      ),
      query(
        `SELECT id, rehearsal_date, race_id, kcal_per_hour, carbs_per_hour,
                gut_response, energy_response, notes
         FROM fueling_rehearsals
         ORDER BY rehearsal_date DESC, created_at DESC LIMIT 1`
      ).catch(() => ({ rows: [] })),
    ]);

    const totalKcal = todayMeals.rows.reduce((s, m) => s + (Number(m.calories) || 0), 0);
    const totalProtein = todayMeals.rows.reduce((s, m) => s + (Number(m.protein_g) || 0), 0);

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      in_minutes: inMin,
      today_plan: cleanFields(planRow.rows[0] || null, PLAN_TEXT_FIELDS),
      latest_body: latestWeight.rows[0] || null,
      today_macros: {
        meal_count: todayMeals.rows.length,
        kcal_consumed: Math.round(totalKcal),
        protein_g_consumed: Math.round(totalProtein * 10) / 10,
        meals: todayMeals.rows,
      },
      last_fueling_rehearsal: lastFueling.rows[0] || null,
    });
  } catch (err) {
    console.error('[GET /coach/preworkout]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3d. GET /api/coach/postworkout ───────────────────────────────
// Replaces: /workouts?limit=1 + /meals?date=today + /daily-context?date=today
router.get('/postworkout', async (req, res) => {
  try {
    const today = todayISO();

    const [latestWorkout, todayMeals, todayContext, todayPlan] = await Promise.all([
      query(
        `SELECT id, title, workout_date, workout_type, effort, duration_minutes,
                hr_avg, hr_max, cal_active, distance_value, body_notes
         FROM workouts
         WHERE deleted_at IS NULL
         ORDER BY workout_date DESC, started_at DESC NULLS LAST, created_at DESC LIMIT 1`
      ),
      query(
        `SELECT title, calories, protein_g, carbs_g, fat_g, meal_time
         FROM meals WHERE meal_date = $1 ORDER BY meal_time NULLS LAST`,
        [today]
      ),
      query(`SELECT * FROM daily_context WHERE date = $1`, [today]),
      query(
        `SELECT target_calories, target_protein_g, target_hydration_liters
         FROM daily_plans WHERE plan_date = $1`, [today]
      ),
    ]);

    const totalKcal = todayMeals.rows.reduce((s, m) => s + (Number(m.calories) || 0), 0);
    const totalProtein = todayMeals.rows.reduce((s, m) => s + (Number(m.protein_g) || 0), 0);
    const target = todayPlan.rows[0] || {};

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      latest_workout: cleanFields(latestWorkout.rows[0] || null, ['title', 'focus', 'workout_focus', 'body_notes', 'adjustment']),
      macros: {
        kcal_consumed: Math.round(totalKcal),
        kcal_target: target.target_calories || null,
        protein_g_consumed: Math.round(totalProtein * 10) / 10,
        protein_g_target: target.target_protein_g || null,
        meal_count: todayMeals.rows.length,
      },
      hydration: {
        liters_so_far: todayContext.rows[0]?.hydration_liters ?? null,
        target_liters: target.target_hydration_liters ?? null,
      },
      today_context: todayContext.rows[0] || null,
    });
  } catch (err) {
    console.error('[GET /coach/postworkout]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3e. GET /api/coach/end-of-day ────────────────────────────────
// Replaces: /daily-plans/by-date/today + /nutrition/daily-summary?date=today
// + /daily-context?date=today + /workouts?date=today
//
// v1.10.4: adds explicit plan_vs_actual diff (per-segment status, unplanned
// workouts, macro deltas, effort delta). Truncates body_notes to 200 chars
// in the response — full text is queryable via GET /workouts/:id when the
// skill needs it.
router.get('/end-of-day', async (req, res) => {
  try {
    const today = todayISO();

    const [planRow, todayWorkouts, todayMeals, todayContext] = await Promise.all([
      query(`SELECT * FROM daily_plans WHERE plan_date = $1`, [today]),
      query(
        `SELECT id, title, workout_type, effort, duration_minutes,
                hr_avg, cal_active, LEFT(body_notes, 200) AS body_notes,
                LENGTH(body_notes) > 200 AS body_notes_truncated,
                plan_segment_id
         FROM workouts
         WHERE workout_date = $1 AND deleted_at IS NULL
         ORDER BY started_at NULLS LAST, created_at`,
        [today]
      ),
      query(
        `SELECT meal_type, title, calories, protein_g, carbs_g, fat_g, meal_time
         FROM meals WHERE meal_date = $1 ORDER BY meal_time NULLS LAST`,
        [today]
      ),
      query(`SELECT * FROM daily_context WHERE date = $1`, [today]),
    ]);

    let todayPlan = planRow.rows[0] || null;
    let segments = [];
    if (todayPlan) {
      const segR = await query(
        `SELECT ps.id, ps.block_order, ps.block_label, ps.title_suffix,
                ps.logging_target, ps.target_duration_min, ps.target_effort,
                ps.status, ps.planned_exercises,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                     'id', w.id, 'title', w.title, 'effort', w.effort,
                     'duration_minutes', w.duration_minutes,
                     'workout_type', w.workout_type
                   ) ORDER BY w.started_at NULLS LAST, w.created_at)
                   FROM workouts w WHERE w.plan_segment_id = ps.id AND w.deleted_at IS NULL),
                  '[]'::json
                ) AS workouts
         FROM plan_segments ps
         WHERE ps.daily_plan_id = $1
         ORDER BY ps.block_order`,
        [todayPlan.id]
      ).catch(() => ({ rows: [] }));
      segments = segR.rows;
      todayPlan.segments = segments;
    }

    const totalKcal = todayMeals.rows.reduce((s, m) => s + (Number(m.calories) || 0), 0);
    const totalProtein = todayMeals.rows.reduce((s, m) => s + (Number(m.protein_g) || 0), 0);
    const totalCarbs = todayMeals.rows.reduce((s, m) => s + (Number(m.carbs_g) || 0), 0);
    const totalFat = todayMeals.rows.reduce((s, m) => s + (Number(m.fat_g) || 0), 0);
    const totalEffortMin = todayWorkouts.rows.reduce((s, w) => s + (Number(w.duration_minutes) || 0), 0);
    const maxActualEffort = todayWorkouts.rows.reduce((m, w) => Math.max(m, Number(w.effort) || 0), 0);

    // v1.10.4: explicit plan_vs_actual diff. Coach was composing this manually
    // from the plan + workouts arrays; now it's computed once server-side.
    const plannedSegmentIds = new Set(segments.map(s => s.id));
    const segmentsStatus = segments.map(s => {
      const linkedWorkouts = Array.isArray(s.workouts) ? s.workouts : [];
      const completed = linkedWorkouts.length > 0;
      const actualEffort = linkedWorkouts.reduce((m, w) => Math.max(m, Number(w.effort) || 0), 0);
      const actualDuration = linkedWorkouts.reduce((sum, w) => sum + (Number(w.duration_minutes) || 0), 0);
      return {
        segment_id: s.id,
        block_label: s.block_label,
        title_suffix: s.title_suffix,
        logging_target: s.logging_target,
        target_duration_min: s.target_duration_min,
        target_effort: s.target_effort,
        actual_duration_min: actualDuration || null,
        actual_effort: actualEffort || null,
        completed,
        workout_count: linkedWorkouts.length,
      };
    });
    const unplannedWorkouts = todayWorkouts.rows.filter(w =>
      !w.plan_segment_id || !plannedSegmentIds.has(w.plan_segment_id)
    ).map(w => ({
      id: w.id,
      title: w.title,
      workout_type: w.workout_type,
      effort: w.effort,
      duration_minutes: w.duration_minutes,
    }));

    const planVsActual = {
      segments: segmentsStatus,
      segments_completed: segmentsStatus.filter(s => s.completed).length,
      segments_total: segmentsStatus.length,
      unplanned_workouts: unplannedWorkouts,
      // v3.4: was rounding consumed to integer before subtracting from
      // target. Made the delta inconsistent with nutrition_summary which
      // exposes 1-decimal precision (audit bug #5). Round to 1 decimal
      // throughout for consistency.
      macros_delta: {
        kcal: todayPlan?.target_calories != null
          ? Math.round((totalKcal - todayPlan.target_calories)) : null,
        protein_g: todayPlan?.target_protein_g != null
          ? Math.round((totalProtein - todayPlan.target_protein_g) * 10) / 10 : null,
      },
      effort_delta: todayPlan?.target_effort != null
        ? maxActualEffort - todayPlan.target_effort : null,
    };

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      today_plan: cleanFields(todayPlan, PLAN_TEXT_FIELDS),
      today_workouts: cleanRows(todayWorkouts.rows, ['title', 'focus', 'workout_focus', 'body_notes', 'adjustment']),
      nutrition_summary: {
        meal_count: todayMeals.rows.length,
        kcal_consumed: Math.round(totalKcal),
        kcal_target: todayPlan?.target_calories ?? null,
        protein_g: Math.round(totalProtein * 10) / 10,
        protein_target_g: todayPlan?.target_protein_g ?? null,
        carbs_g: Math.round(totalCarbs * 10) / 10,
        fat_g: Math.round(totalFat * 10) / 10,
        meals: todayMeals.rows,
      },
      subjective_context: todayContext.rows[0] || null,
      effort_total: {
        total_minutes: totalEffortMin,
        workout_count: todayWorkouts.rows.length,
        max_effort: maxActualEffort || null,
      },
      plan_vs_actual: planVsActual,
    });
  } catch (err) {
    console.error('[GET /coach/end-of-day]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3f. GET /api/coach/weekly ────────────────────────────────────
// Replaces: /insights/weekly-review + /targets + /races/upcoming
// + /races/blocks/current
router.get('/weekly', async (req, res) => {
  try {
    const today = todayISO();
    const weekStart = daysAgoISO(7);

    const [weeklyWorkouts, weeklyMeals, targets, upcomingRace, currentBlock, weeklyCoaching] =
      await Promise.all([
        query(
          `SELECT workout_date, workout_type, effort, duration_minutes,
                  cal_active, hr_avg, distance_value
           FROM workouts
           WHERE workout_date >= $1 AND deleted_at IS NULL
           ORDER BY workout_date ASC`,
          [weekStart]
        ),
        query(
          `SELECT meal_date, COUNT(*)::int AS meal_count,
                  COALESCE(SUM(calories), 0) AS kcal,
                  COALESCE(SUM(protein_g), 0) AS protein_g
           FROM meals WHERE meal_date >= $1
           GROUP BY meal_date ORDER BY meal_date ASC`,
          [weekStart]
        ),
        query(
          `SELECT metric, target_value, target_value_max, comparison
           FROM user_targets
           WHERE effective_to IS NULL OR effective_to >= CURRENT_DATE`
        ).catch(() => ({ rows: [] })),
        query(
          `SELECT id, race_date, name, discipline, priority,
                  (race_date - CURRENT_DATE) AS days_to_race
           FROM races
           WHERE status = 'scheduled' AND race_date >= CURRENT_DATE
           ORDER BY race_date ASC LIMIT 1`
        ).catch(() => ({ rows: [] })),
        query(
          `SELECT b.*, r.name AS target_race_name
           FROM training_blocks b
           LEFT JOIN races r ON r.id = b.target_race_id
           WHERE b.start_date <= CURRENT_DATE AND b.end_date >= CURRENT_DATE
           ORDER BY b.start_date DESC LIMIT 1`
        ).catch(() => ({ rows: [] })),
        query(
          `SELECT session_date, title, summary, tags
           FROM coaching_sessions
           WHERE session_date >= $1
           ORDER BY session_date DESC LIMIT 14`,
          [weekStart]
        ),
      ]);

    // Aggregate weekly totals
    const totalEffortMin = weeklyWorkouts.rows.reduce((s, w) => s + (Number(w.duration_minutes) || 0), 0);
    const totalCalActive = weeklyWorkouts.rows.reduce((s, w) => s + (Number(w.cal_active) || 0), 0);
    const totalDistance = weeklyWorkouts.rows.reduce((s, w) => s + (Number(w.distance_value) || 0), 0);
    const workoutsByType = {};
    for (const w of weeklyWorkouts.rows) {
      workoutsByType[w.workout_type || 'other'] = (workoutsByType[w.workout_type || 'other'] || 0) + 1;
    }

    // Compliance: meal logging rate
    const daysWithMeals = weeklyMeals.rows.length;
    const mealLoggingRatePct = Math.round((daysWithMeals / 7) * 100);

    res.json({
      generated_at: new Date().toISOString(),
      week_start: weekStart,
      week_end: today,
      training: {
        workout_count: weeklyWorkouts.rows.length,
        total_minutes: totalEffortMin,
        total_active_kcal: Math.round(totalCalActive),
        total_distance: Math.round(totalDistance * 10) / 10,
        by_type: workoutsByType,
      },
      nutrition: {
        days_logged: daysWithMeals,
        meal_logging_rate_pct: mealLoggingRatePct,
        days: weeklyMeals.rows,
      },
      targets: targets.rows,
      upcoming_race: cleanFields(upcomingRace.rows[0] || null, ['name']),
      current_block: currentBlock.rows[0] || null,
      week_coaching_sessions: cleanRows(weeklyCoaching.rows, COACHING_SESSION_FIELDS),
    });
  } catch (err) {
    console.error('[GET /coach/weekly]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3g. GET /api/coach/race-pulse?race_id=X ──────────────────────
// Race-week + race-debrief context. v1.10.4 adds derived taper_phase,
// recommendation, and last_28d_build_summary so the skill doesn't need
// to compute these from raw queries.
//
// race_id is OPTIONAL. If omitted, defaults to the next upcoming
// scheduled race.

// Derive taper phase from days-to-race. Standard endurance periodization
// from Friel/Galpin/Seiler: pre-taper at T-21, sharpen at T-14, taper at
// T-7, race-week at T-3, race-day at T-0, recovery after.
function taperPhaseFor(daysToRace) {
  if (daysToRace == null) return null;
  if (daysToRace < 0) return 'recovery';
  if (daysToRace === 0) return 'race-day';
  if (daysToRace <= 3) return 'race-week';
  if (daysToRace <= 7) return 'taper';
  if (daysToRace <= 14) return 'sharpen';
  if (daysToRace <= 21) return 'pre-taper';
  return 'base';
}

const TAPER_RECOMMENDATIONS = {
  'recovery':  'Race recovery: 7-10 days easy aerobic + mobility. No intensity until soreness clears + HRV returns to baseline.',
  'race-day':  'Race day. Pre-fuel per rehearsed plan. Trust taper. No new gear.',
  'race-week': 'Race-week opener at race intensity 3 days out. Then 2 short shakeouts. Full rest day before. Carbs +20%.',
  'taper':     'Volume −20% week-over-week, intensity preserved. Last hard session 5-7 days out.',
  'sharpen':   'Volume hold, sharpen with 1-2 race-pace efforts. Trim recovery work, keep mobility.',
  'pre-taper': 'Last build week. Hardest session of the block 18-21 days out. Then taper begins.',
  'base':      'Standard block work — no race-specific adjustment yet.',
};

router.get('/race-pulse', async (req, res) => {
  try {
    let raceId = req.query.race_id;

    // No race_id → resolve to next upcoming scheduled race
    if (!raceId) {
      const upcoming = await query(
        `SELECT id FROM races
         WHERE status = 'scheduled' AND race_date >= CURRENT_DATE
         ORDER BY race_date ASC LIMIT 1`
      );
      if (!upcoming.rows.length) {
        return res.status(404).json({
          error: 'No race_id provided and no upcoming scheduled race found.',
          hint: 'POST /api/races to schedule the next race, or pass ?race_id=<id>.',
        });
      }
      raceId = upcoming.rows[0].id;
    }

    const [race, fuelingRehearsals, currentBlock, last28dBuild] = await Promise.all([
      query(
        `SELECT *, (race_date - CURRENT_DATE) AS days_to_race
         FROM races WHERE id = $1`,
        [raceId]
      ),
      query(
        `SELECT id, rehearsal_date, kcal_per_hour, carbs_per_hour,
                gut_response, energy_response, notes
         FROM fueling_rehearsals
         WHERE race_id = $1
         ORDER BY rehearsal_date DESC LIMIT 5`,
        [raceId]
      ).catch(() => ({ rows: [] })),
      query(
        `SELECT * FROM training_blocks
         WHERE target_race_id = $1
         ORDER BY start_date DESC LIMIT 1`,
        [raceId]
      ).catch(() => ({ rows: [] })),
      // last_28d_build_summary: aggregate the prior 4 weeks so the skill can
      // assess whether the build had enough race-specific load before taper.
      query(
        `SELECT
           COUNT(*)::int                                       AS workout_count,
           COALESCE(SUM(duration_minutes), 0)::int             AS total_minutes,
           COALESCE(SUM(cal_active), 0)::int                   AS total_active_kcal,
           COUNT(*) FILTER (WHERE effort >= 7)::int            AS hard_session_count,
           COUNT(*) FILTER (WHERE effort >= 5 AND effort < 7)::int AS moderate_session_count,
           COUNT(*) FILTER (WHERE effort < 5 OR effort IS NULL)::int AS easy_session_count,
           ROUND(AVG(NULLIF(effort, 0))::numeric, 2)           AS avg_effort,
           MAX(effort)                                         AS hardest_effort,
           MAX(duration_minutes)                               AS longest_minutes,
           ROUND(SUM(distance_value)::numeric, 1)              AS total_distance
         FROM workouts
         WHERE workout_date >= CURRENT_DATE - INTERVAL '28 days'
           AND workout_date < CURRENT_DATE
           AND deleted_at IS NULL`
      ).catch(() => ({ rows: [{}] })),
    ]);

    if (!race.rows.length) return res.status(404).json({ error: 'Race not found' });

    const raceRow = race.rows[0];
    const daysToRace = raceRow.days_to_race != null ? Number(raceRow.days_to_race) : null;
    const phase = taperPhaseFor(daysToRace);

    res.json({
      generated_at: new Date().toISOString(),
      resolved_via: req.query.race_id ? 'race_id' : 'upcoming',
      race: cleanFields(raceRow, ['name', 'location', 'notes']),
      taper_phase: phase,
      recommendation: phase ? TAPER_RECOMMENDATIONS[phase] : null,
      fueling_rehearsals: fuelingRehearsals.rows,
      // v3.4: was using Date.now() vs raw date string, creating a
      // boundary that flipped rehearsals in/out of the window by hours
      // (audit bugs #3, #7). Anchor both at local midnight.
      fueling_rehearsal_count_28d: fuelingRehearsals.rows.filter(f => {
        const { daysBetween: db, todayLocalISO: today } = require('../lib/date-helpers');
        return db(f.rehearsal_date, today()) <= 28;
      }).length,
      training_block: currentBlock.rows[0] || null,
      last_28d_build_summary: last28dBuild.rows[0] || null,
    });
  } catch (err) {
    console.error('[GET /coach/race-pulse]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
