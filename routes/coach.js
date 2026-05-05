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
const router = express.Router();

// ─── small helpers ─────────────────────────────────────────────────
const todayISO = () => new Date().toISOString().slice(0, 10);
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
  const r = await query(
    `SELECT
       COALESCE(c.date, da.activity_date)              AS activity_date,
       COALESCE(c.hrv_ms, da.hrv_sdnn_ms)              AS hrv_sdnn_ms,
       COALESCE(c.rhr_bpm, da.resting_hr_bpm)          AS resting_hr_bpm,
       COALESCE(c.sleep_total_min, da.sleep_total_min) AS sleep_total_min,
       da.sleep_efficiency_pct,
       c.respiratory_rate_bpm,
       c.is_stale AS cache_is_stale,
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
        query(
          `SELECT id, session_date, title, summary, key_decisions, next_steps, tags
           FROM coaching_sessions
           WHERE session_date >= $1
           ORDER BY session_date DESC, created_at DESC LIMIT 2`,
          [daysAgoISO(2)]
        ),
      ]);

    // Attach plan segments if a plan exists
    let todayPlan = planRow.rows[0] || null;
    if (todayPlan) {
      const segR = await query(
        `SELECT ps.*, COALESCE(
           (SELECT json_agg(w.* ORDER BY w.started_at NULLS LAST, w.created_at)
            FROM workouts w WHERE w.plan_segment_id = ps.id), '[]'::json
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
      today_plan: todayPlan,
      readiness: readinessFromRows(vitalsRows, today),
      alerts: alertsArr,
      active_injuries: injuries.rows,
      yesterday_summary,
      recent_coaching: recentCoaching.rows,
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
      const segR = await query(
        `SELECT ps.*, COALESCE(
           (SELECT json_agg(w.* ORDER BY w.started_at NULLS LAST, w.created_at)
            FROM workouts w WHERE w.plan_segment_id = ps.id), '[]'::json
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
      today_plan: todayPlan,
      readiness: readinessFromRows(vitalsRows, today),
      alerts: alertsArr,
      active_injuries: injuries.rows,
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
      today_plan: planRow.rows[0] || null,
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
      latest_workout: latestWorkout.rows[0] || null,
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
router.get('/end-of-day', async (req, res) => {
  try {
    const today = todayISO();

    const [planRow, todayWorkouts, todayMeals, todayContext] = await Promise.all([
      query(`SELECT * FROM daily_plans WHERE plan_date = $1`, [today]),
      query(
        `SELECT id, title, workout_type, effort, duration_minutes,
                hr_avg, cal_active, body_notes, plan_segment_id
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
    if (todayPlan) {
      const segR = await query(
        `SELECT ps.*, COALESCE(
           (SELECT json_agg(w.* ORDER BY w.started_at NULLS LAST, w.created_at)
            FROM workouts w WHERE w.plan_segment_id = ps.id), '[]'::json
         ) AS workouts
         FROM plan_segments ps
         WHERE ps.daily_plan_id = $1
         ORDER BY ps.block_order`,
        [todayPlan.id]
      ).catch(() => ({ rows: [] }));
      todayPlan.segments = segR.rows;
    }

    const totalKcal = todayMeals.rows.reduce((s, m) => s + (Number(m.calories) || 0), 0);
    const totalProtein = todayMeals.rows.reduce((s, m) => s + (Number(m.protein_g) || 0), 0);
    const totalCarbs = todayMeals.rows.reduce((s, m) => s + (Number(m.carbs_g) || 0), 0);
    const totalFat = todayMeals.rows.reduce((s, m) => s + (Number(m.fat_g) || 0), 0);
    const totalEffortMin = todayWorkouts.rows.reduce((s, w) => s + (Number(w.duration_minutes) || 0), 0);

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      today_plan: todayPlan,
      today_workouts: todayWorkouts.rows,
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
      },
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
      upcoming_race: upcomingRace.rows[0] || null,
      current_block: currentBlock.rows[0] || null,
      week_coaching_sessions: weeklyCoaching.rows,
    });
  } catch (err) {
    console.error('[GET /coach/weekly]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3g. GET /api/coach/race-pulse?race_id=X ──────────────────────
// Thin alias to /api/health/insights/race for canonical naming. Coach
// calls /api/coach/race-pulse for race-week + race-debrief scenarios.
// Returns the same payload as /insights/race plus the latest fueling
// rehearsal for that race so race-week prep doesn't need a 2nd call.
router.get('/race-pulse', async (req, res) => {
  try {
    const raceId = req.query.race_id;
    if (!raceId) return res.status(400).json({ error: 'race_id is required' });

    const [race, fuelingRehearsals, currentBlock] = await Promise.all([
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
    ]);

    if (!race.rows.length) return res.status(404).json({ error: 'Race not found' });

    res.json({
      generated_at: new Date().toISOString(),
      race: race.rows[0],
      fueling_rehearsals: fuelingRehearsals.rows,
      training_block: currentBlock.rows[0] || null,
    });
  } catch (err) {
    console.error('[GET /coach/race-pulse]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
