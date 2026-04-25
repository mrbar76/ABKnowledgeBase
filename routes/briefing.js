const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  SMART-RANK SCORING
// ══════════════════════════════════════════════════════════════════

const PRIORITY_SCORE = { urgent: 40, high: 30, medium: 20, low: 10 };

function computeTaskScore(task, today) {
  let score = 0;

  // Priority
  score += PRIORITY_SCORE[task.priority] || 20;

  // Due date
  if (task.due_date) {
    const due = new Date(task.due_date + 'T00:00:00');
    const now = new Date(today + 'T00:00:00');
    const diffDays = Math.round((due - now) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) score += 50;        // overdue
    else if (diffDays === 0) score += 30;  // today
    else if (diffDays <= 7) score += 15;   // this week
    else score += 5;
  } else {
    score += 5; // no date
  }

  // Staleness
  if (task.updated_at) {
    const updated = new Date(task.updated_at);
    const now = new Date(today + 'T00:00:00');
    const staleDays = Math.round((now - updated) / (1000 * 60 * 60 * 24));
    if (staleDays > 14) score += 15;
    else if (staleDays > 7) score += 10;
  }

  // Waiting too long
  if (task.status === 'waiting_on' && task.updated_at) {
    const updated = new Date(task.updated_at);
    const now = new Date(today + 'T00:00:00');
    const waitDays = Math.round((now - updated) / (1000 * 60 * 60 * 24));
    if (waitDays > 5) score += 10;
    else if (waitDays > 3) score += 5;
  }

  return score;
}

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function fmtDate(d) {
  if (!d) return null;
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return s;
}

function daysSince(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(fmtDate(dateStr) + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  return Math.round((t - d) / (1000 * 60 * 60 * 24));
}

function formatDatePretty(d) {
  if (!d) return 'no date';
  const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T12:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ══════════════════════════════════════════════════════════════════
//  GET /  — Morning Briefing (markdown)
// ══════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  try {
    const today = req.query.date || req.getToday();
    const yesterday = new Date(today + 'T12:00:00');
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    // ── Parallel queries ──
    const [
      openTasksR,
      completedYesterdayR,
      dailyPlanR,
      yesterdayCtxR,
      yesterdayMealsR,
      yesterdayWorkoutR,
      staleTasksR,
      sleepCtxR,
      workoutsForRecoveryR,
      injuriesR,
      gamSettingsR,
      streakTrainR,
      streakExecuteR,
    ] = await Promise.all([
      // All open tasks
      query(`SELECT * FROM tasks WHERE status != 'done' ORDER BY due_date ASC NULLS LAST, updated_at DESC`),
      // Tasks completed yesterday
      query(`SELECT * FROM tasks WHERE status = 'done' AND completed_at >= $1::date AND completed_at < $1::date + INTERVAL '1 day'`, [yesterdayStr]),
      // Today's daily plan
      query(`SELECT * FROM daily_plans WHERE plan_date = $1`, [today]),
      // Yesterday's daily context (sleep)
      query(`SELECT sleep_hours, sleep_quality FROM daily_context WHERE date = $1`, [yesterdayStr]),
      // Yesterday's meals aggregate
      query(`SELECT COALESCE(SUM(calories), 0)::numeric AS total_cal, COALESCE(SUM(protein_g), 0)::numeric AS total_protein, COUNT(*)::int AS meal_count FROM meals WHERE meal_date = $1`, [yesterdayStr]),
      // Yesterday's workout
      query(`SELECT title, effort, workout_type FROM workouts WHERE workout_date = $1 ORDER BY effort DESC NULLS LAST LIMIT 1`, [yesterdayStr]),
      // Stale tasks: open + not updated in 7+ days
      query(`SELECT * FROM tasks WHERE status != 'done' AND updated_at < NOW() - INTERVAL '7 days' ORDER BY updated_at ASC`),
      // Today's sleep context (for recovery)
      query(`SELECT sleep_hours, sleep_quality FROM daily_context WHERE date = $1`, [today]),
      // Recent workouts for simple recovery context
      query(`SELECT workout_date, effort, workout_type FROM workouts WHERE workout_date >= $1::date - INTERVAL '3 days' AND workout_date <= $1 ORDER BY workout_date DESC`, [today]),
      // Active injuries
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') AND (onset_date IS NULL OR onset_date <= $1) AND (resolved_date IS NULL OR resolved_date >= $1)`, [today]),
      // Gamification settings
      query(`SELECT * FROM gamification_settings WHERE id = 1`),
      // Train streak
      query(`WITH dates AS (SELECT DISTINCT workout_date AS d FROM workouts WHERE workout_date <= $1::date ORDER BY d DESC),
             numbered AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d DESC))::int AS grp FROM dates)
             SELECT COALESCE((SELECT COUNT(*)::int FROM numbered WHERE grp = (SELECT grp FROM numbered WHERE d = $1::date LIMIT 1)), 0) AS streak`, [today]),
      // Execute streak
      query(`WITH dates AS (SELECT DISTINCT updated_at::date AS d FROM tasks WHERE status = 'done' AND updated_at::date <= $1::date ORDER BY d DESC),
             numbered AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d DESC))::int AS grp FROM dates)
             SELECT COALESCE((SELECT COUNT(*)::int FROM numbered WHERE grp = (SELECT grp FROM numbered WHERE d = $1::date LIMIT 1)), 0) AS streak`, [today]),
    ]);

    const openTasks = openTasksR.rows;
    const completedYesterday = completedYesterdayR.rows;
    const dailyPlan = dailyPlanR.rows[0] || null;
    const yesterdayCtx = yesterdayCtxR.rows[0] || null;
    const yesterdayMeals = yesterdayMealsR.rows[0] || {};
    const yesterdayWorkout = yesterdayWorkoutR.rows[0] || null;
    const staleTasks = staleTasksR.rows;
    const sleepCtx = sleepCtxR.rows[0] || null;
    const recentWorkouts = workoutsForRecoveryR.rows;
    const injuries = injuriesR.rows;
    const gamSettings = gamSettingsR.rows[0] || {};
    const streakTrain = streakTrainR.rows[0]?.streak || 0;
    const streakExecute = streakExecuteR.rows[0]?.streak || 0;

    // ── Compute recover streak (simplified — from sleep data) ──
    let streakRecover = 0;
    const sleepTarget = parseFloat(gamSettings.default_sleep_target) || 7.0;
    const sleepQualThreshold = gamSettings.default_sleep_quality_threshold || 6;
    // Quick recover streak: check last 90 days
    try {
      const recR = await query(`
        WITH day_data AS (
          SELECT d::date AS d,
            COALESCE((SELECT sleep_hours FROM daily_context WHERE date = d), 0) AS sleep_hours,
            COALESCE((SELECT sleep_quality FROM daily_context WHERE date = d), 0) AS sleep_quality
          FROM generate_series($1::date - INTERVAL '90 days', $1::date, '1 day'::interval) AS d
          ORDER BY d DESC
        )
        SELECT d, sleep_hours, sleep_quality FROM day_data
      `, [today]);
      for (const row of recR.rows) {
        const sProg = sleepTarget > 0 ? Math.min(1, parseFloat(row.sleep_hours) / sleepTarget) : 0;
        const qProg = sleepQualThreshold > 0 ? Math.min(1, parseInt(row.sleep_quality) / sleepQualThreshold) : 0;
        const recPct = ((sProg + qProg) / 2) * 100;
        if (recPct >= 80) streakRecover++;
        else break;
      }
    } catch { /* ignore */ }

    // ── Score & rank open tasks ──
    const scored = openTasks.map(t => ({ ...t, _score: computeTaskScore(t, today) }));
    scored.sort((a, b) => b._score - a._score);
    const top3 = scored.slice(0, 3);

    // ── Categorize tasks ──
    const overdue = openTasks.filter(t => t.due_date && fmtDate(t.due_date) < today);
    const dueToday = openTasks.filter(t => t.due_date && fmtDate(t.due_date) === today);
    const inProgress = openTasks.filter(t => t.status === 'in_progress');
    const waiting = openTasks.filter(t => t.status === 'waiting_on');

    // ── Recovery: simple approach (sleep + yesterday workout + injuries) ──
    let recoveryScore = null;
    let recoveryLabel = 'Insufficient data';
    let recoveryRecommendation = 'Log sleep and workout data for recovery insights';

    const sleepData = sleepCtx || yesterdayCtx;
    if (sleepData && sleepData.sleep_hours != null) {
      const hrs = Number(sleepData.sleep_hours);
      const qual = sleepData.sleep_quality ? Number(sleepData.sleep_quality) : 5;

      // Sleep component (0-50)
      const sleepScore = Math.min(50, Math.round((hrs / 8) * 25 + (qual / 10) * 25));

      // Workout fatigue component (0-30): rest = 30, low effort = 25, high effort = 10
      let workoutScore = 30;
      if (recentWorkouts.length > 0) {
        const latestEffort = Number(recentWorkouts[0].effort) || 5;
        workoutScore = Math.max(10, 30 - (latestEffort * 2));
      }

      // Injury component (0-20)
      const injuryScore = Math.max(0, 20 - (injuries.length * 5));

      recoveryScore = Math.min(100, sleepScore + workoutScore + injuryScore);
      recoveryLabel = recoveryScore >= 81 ? 'Peak' : recoveryScore >= 61 ? 'Good' : recoveryScore >= 31 ? 'Moderate' : 'Low';

      if (recoveryScore >= 81) recoveryRecommendation = 'All systems go — ready for a hard session';
      else if (recoveryScore >= 61) recoveryRecommendation = 'Good to train — moderate intensity recommended';
      else if (recoveryScore >= 31) recoveryRecommendation = 'Consider a lighter session or active recovery';
      else recoveryRecommendation = 'Rest day recommended — focus on recovery';
    }

    // ── Format date header ──
    const headerDate = new Date(today + 'T12:00:00');
    const dayName = headerDate.toLocaleDateString('en-US', { weekday: 'long' });
    const monthName = headerDate.toLocaleDateString('en-US', { month: 'long' });
    const dayNum = headerDate.getDate();
    const year = headerDate.getFullYear();

    // ── Build markdown ──
    const lines = [];

    lines.push(`# Morning Briefing — ${dayName}, ${monthName} ${dayNum}, ${year}`);
    lines.push('');

    // Top 3 Focus
    lines.push('## Top 3 Focus');
    if (top3.length === 0) {
      lines.push('None — no open tasks');
    } else {
      top3.forEach((t, i) => {
        const dueStr = t.due_date ? `due ${formatDatePretty(t.due_date)}` : 'no date';
        lines.push(`${i + 1}. **${t.title}** — ${t.priority || 'medium'} — ${dueStr}`);
      });
    }
    lines.push('');

    // Overdue
    lines.push(`## Overdue (${overdue.length})`);
    if (overdue.length === 0) {
      lines.push('None');
    } else {
      for (const t of overdue) {
        const days = daysSince(t.due_date, today);
        lines.push(`- ${t.title} — ${days} day${days !== 1 ? 's' : ''} overdue — ${t.priority || 'medium'}`);
      }
    }
    lines.push('');

    // Due Today
    lines.push(`## Due Today (${dueToday.length})`);
    if (dueToday.length === 0) {
      lines.push('None');
    } else {
      for (const t of dueToday) {
        lines.push(`- ${t.title} — ${t.priority || 'medium'}`);
      }
    }
    lines.push('');

    // In Progress
    lines.push(`## In Progress (${inProgress.length})`);
    if (inProgress.length === 0) {
      lines.push('None');
    } else {
      for (const t of inProgress) {
        const started = t.updated_at ? formatDatePretty(t.updated_at) : 'unknown';
        lines.push(`- ${t.title} — started ${started}`);
      }
    }
    lines.push('');

    // Waiting On Others
    lines.push(`## Waiting On Others (${waiting.length})`);
    if (waiting.length === 0) {
      lines.push('None');
    } else {
      for (const t of waiting) {
        const waitDays = t.updated_at ? daysSince(t.updated_at, today) : 0;
        const person = t.waiting_on || 'someone';
        lines.push(`- ${t.title} — waiting on ${person} for ${waitDays} day${waitDays !== 1 ? 's' : ''}`);
      }
    }
    lines.push('');

    // Stale Tasks
    lines.push(`## Stale Tasks (${staleTasks.length} not touched in 7+ days)`);
    if (staleTasks.length === 0) {
      lines.push('None');
    } else {
      for (const t of staleTasks) {
        const updatedStr = t.updated_at ? formatDatePretty(t.updated_at) : 'unknown';
        lines.push(`- ${t.title} — last updated ${updatedStr} — consider snoozing or archiving`);
      }
    }
    lines.push('');

    // Yesterday
    lines.push('## Yesterday');
    lines.push(`- **Completed:** ${completedYesterday.length} task${completedYesterday.length !== 1 ? 's' : ''}`);
    if (yesterdayWorkout) {
      lines.push(`- **Workout:** ${yesterdayWorkout.title || yesterdayWorkout.workout_type || 'Workout'} (effort ${yesterdayWorkout.effort || '?'}/10)`);
    } else {
      lines.push('- **Workout:** Rest day');
    }
    const cal = Math.round(parseFloat(yesterdayMeals.total_cal) || 0);
    const protein = Math.round(parseFloat(yesterdayMeals.total_protein) || 0);
    const mealCount = yesterdayMeals.meal_count || 0;
    lines.push(`- **Nutrition:** ${cal} cal, ${protein}g protein, ${mealCount} meals`);
    lines.push('');

    // Recovery & Readiness
    lines.push('## Recovery & Readiness');
    if (sleepData && sleepData.sleep_hours != null) {
      const hrs = Number(sleepData.sleep_hours);
      const qual = sleepData.sleep_quality ? Number(sleepData.sleep_quality) : null;
      lines.push(`- **Sleep:** ${hrs}h${qual != null ? ` (quality ${qual}/10)` : ''}`);
    } else {
      lines.push('- **Sleep:** Not logged');
    }
    if (recoveryScore != null) {
      lines.push(`- **Recovery Score:** ${recoveryScore}/100 (${recoveryLabel})`);
    } else {
      lines.push('- **Recovery Score:** Insufficient data');
    }
    lines.push(`- **Recommendation:** ${recoveryRecommendation}`);
    lines.push('');

    // Rings & Streaks
    lines.push('## Rings & Streaks');
    lines.push(`- Train: ${streakTrain}d | Execute: ${streakExecute}d | Recover: ${streakRecover}d`);
    lines.push('');

    // Today's Plan
    lines.push("## Today's Plan");
    if (dailyPlan) {
      const parts = [];
      if (dailyPlan.title) parts.push(`**${dailyPlan.title}**`);
      if (dailyPlan.goal) parts.push(dailyPlan.goal);
      if (dailyPlan.workout_type) parts.push(`Workout: ${dailyPlan.workout_type}${dailyPlan.workout_focus ? ` (${dailyPlan.workout_focus})` : ''}`);
      if (dailyPlan.target_effort) parts.push(`Target effort: ${dailyPlan.target_effort}/10`);
      if (dailyPlan.target_calories) parts.push(`Target calories: ${dailyPlan.target_calories}`);
      if (dailyPlan.target_protein_g) parts.push(`Target protein: ${dailyPlan.target_protein_g}g`);
      if (dailyPlan.coaching_notes) parts.push(dailyPlan.coaching_notes);
      if (dailyPlan.rationale) parts.push(`_${dailyPlan.rationale}_`);
      if (parts.length > 0) {
        lines.push(parts.join('\n'));
      } else {
        lines.push(`Plan set (status: ${dailyPlan.status || 'planned'})`);
      }
    } else {
      lines.push('No plan set for today');
    }
    lines.push('');

    res.set('Content-Type', 'text/markdown');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
