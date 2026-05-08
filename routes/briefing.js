// routes/briefing.js
//
// Curated Today-screen briefing. Replaces the legacy "dump everything"
// shape (19 overdue + 46 stale + 13 waiting-on listed inline) with:
//
//   - greeting (time-aware label + date kicker)
//   - glance (recovery, next race, overdue counts — never full lists)
//   - coach_read (deterministic three-sentence read from lib/voice)
//   - coach_read_signals (structured signals behind the sentences, so a
//     future LLM rewrite layer can be bolted on without changing this
//     contract)
//   - focus (capped at 3, pillar-diverse, anchor-takes-hero)
//   - changed_since_yesterday (delta surfacing — what moved, not what's
//     stale)
//   - metadata (state flags for the frontend: shabbat, between phases)
//
// Recovery score is sourced from lib/recovery.js — same function that
// backs /api/recovery/score. No more 70-vs-67 divergence.
//
// Markdown variant deleted; only ?format=json is served.

const express = require('express');
const { query } = require('../db');
const { cleanForUI, composeCoachRead } = require('../lib/voice');
const { composeCoachReadLLM } = require('../lib/coach-voice');
const { rankFocus, daysBetween } = require('../lib/focus-ranker');
const { computeRecoveryScore } = require('../lib/recovery');
const { shabbatStatus } = require('../lib/shabbat');

const router = express.Router();

// ─── Helpers ───────────────────────────────────────────────────────────

function buildGreeting(now) {
  const hour = now.getHours();
  const label = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const kicker = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
  return { label, kicker };
}

async function detectBetweenPhases(today) {
  try {
    const r = await query(
      `SELECT
         (SELECT 1 FROM goal_phases WHERE start_date <= $1 AND end_date >= $1 LIMIT 1) AS has_active,
         (SELECT 1 FROM goal_phases WHERE start_date > $1 ORDER BY start_date ASC LIMIT 1) AS has_next`,
      [today],
    );
    const row = r.rows[0] || {};
    return !row.has_active && !!row.has_next;
  } catch {
    return false;
  }
}

// ─── Glance counts ─────────────────────────────────────────────────────

function isOverdue(task, todayISO) {
  if (!task.due_date) return false;
  return daysBetween(todayISO, task.due_date) > 0;
}

function isHotOverdue(task, todayISO) {
  if (!isOverdue(task, todayISO)) return task.priority === 'urgent';
  if (task.priority === 'urgent') return true;
  return daysBetween(todayISO, task.due_date) > 7;
}

// ─── Main handler ──────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  // Markdown variant retired — see header comment.
  if (req.query.format && req.query.format !== 'json') {
    return res.status(410).json({
      error: 'markdown_format_retired',
      message: 'Briefing markdown is no longer supported. Use ?format=json.',
    });
  }

  try {
    const today = req.query.date || req.getToday();
    const yesterday = (() => {
      const d = new Date(today + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    // ── Parallel data pulls ──
    const [
      openTasksR,
      completedYesterdayR,
      newlyAddedR,
      todayPlanR,
      yesterdayWorkoutR,
      racesR,
      recoveryToday,
      recoveryYesterday,
      betweenPhases,
    ] = await Promise.all([
      query("SELECT * FROM tasks WHERE status NOT IN ('done','archived','cancelled')"),
      query('SELECT * FROM tasks WHERE status = $1 AND completed_at >= $2::date AND completed_at < $2::date + INTERVAL \'1 day\'', ['done', yesterday]),
      query("SELECT id FROM tasks WHERE created_at >= NOW() - INTERVAL '24 hours' AND status NOT IN ('done','archived','cancelled')"),
      query('SELECT * FROM daily_plans WHERE plan_date = $1 LIMIT 1', [today]),
      query('SELECT id, title, workout_type, focus, effort, duration_minutes FROM workouts WHERE workout_date = $1 AND deleted_at IS NULL ORDER BY effort DESC NULLS LAST LIMIT 1', [yesterday]),
      query("SELECT id, name, race_date FROM races WHERE race_date >= $1 ORDER BY race_date ASC LIMIT 1", [today]),
      computeRecoveryScore({ date: today, query }).catch(() => null),
      computeRecoveryScore({ date: yesterday, query }).catch(() => null),
      detectBetweenPhases(today),
    ]);

    const openTasks = openTasksR.rows;
    const todayPlan = todayPlanR.rows[0] || null;
    const yesterdayWorkout = yesterdayWorkoutR.rows[0] || null;
    const nextRace = racesR.rows[0] || null;

    // ── Glance counts ──
    const overdueCount = openTasks.filter((t) => isOverdue(t, today)).length;
    const hotOverdueCount = openTasks.filter((t) => isHotOverdue(t, today)).length;
    const dueTodayCount = openTasks.filter((t) => t.due_date && daysBetween(today, t.due_date) === 0).length;
    const newlyOverdueCount = openTasks.filter((t) => {
      if (!t.due_date) return false;
      const d = daysBetween(today, t.due_date);
      return d === 1; // slipped yesterday
    }).length;

    // ── State flags ──
    // Optional lat/lon override from query for accurate Shabbat times.
    const lat = req.query.lat != null ? Number(req.query.lat) : undefined;
    const lon = req.query.lon != null ? Number(req.query.lon) : undefined;
    const sb = shabbatStatus(
      new Date(),
      Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {},
    );
    const shabbat = sb.in_shabbat;

    // ── Focus ranking (Fix 2) ──
    // Shabbat behavior: keep personal + training surfaces live, drop work.
    // The screen does NOT go quiet — only work tasks are filtered out.
    const tasksForRanking = shabbat
      ? openTasks.filter((t) => {
          const ctx = String(t.context || '').toLowerCase();
          return ctx === 'personal' || ctx === 'family' || ctx === 'training' || ctx === 'health';
        })
      : openTasks;
    const focus = rankFocus(tasksForRanking, today, { todayPlan });

    // ── Coach read signals (also exposed in payload) ──
    const signals = {
      yesterday: {
        workouts_completed: yesterdayWorkout ? 1 : 0,
        tasks_completed: completedYesterdayR.rows.length,
        workouts: yesterdayWorkout
          ? [{
              title: cleanForUI(yesterdayWorkout.title || yesterdayWorkout.workout_type || 'session'),
              effort: yesterdayWorkout.effort,
              workout_type: yesterdayWorkout.workout_type,
            }]
          : [],
      },
      today: {
        planned_workout: todayPlan
          ? {
              title: cleanForUI(todayPlan.title || todayPlan.workout_focus || "Today's session"),
              workout_focus: cleanForUI(todayPlan.workout_focus),
              target_effort: todayPlan.target_effort,
              is_anchor: (todayPlan.target_effort || 0) >= 8 ||
                ['strength', 'hill', 'long_run'].includes(String(todayPlan.workout_type || '').toLowerCase()) ||
                todayPlan.is_anchor === true,
            }
          : null,
        top_focus: focus[0] || null,
      },
      recovery: recoveryToday
        ? { score: recoveryToday.score, label: recoveryToday.label }
        : { score: null, label: 'Insufficient data' },
      overdue: { count: overdueCount, hot_count: hotOverdueCount },
      race: nextRace
        ? { name: cleanForUI(nextRace.name), days_away: daysBetween(nextRace.race_date, today) }
        : null,
      between_phases: betweenPhases,
      shabbat,
      shabbat_status: sb,
    };

    const coachRead = await composeCoachReadLLM(signals);

    // ── Delta surfacing: changed_since_yesterday ──
    const recoveryDelta =
      recoveryToday && recoveryYesterday && recoveryYesterday.score != null
        ? recoveryToday.score - recoveryYesterday.score
        : null;

    const changed = {
      completed_yesterday: completedYesterdayR.rows.length,
      newly_due_today: dueTodayCount,
      newly_overdue: newlyOverdueCount,
      newly_added: newlyAddedR.rows.length,
      recovery_delta: recoveryDelta,
    };

    // ── Glance ──
    const overdueTrend =
      hotOverdueCount > 0
        ? `${hotOverdueCount} hot`
        : overdueCount > 0
          ? 'all medium-low'
          : 'all clear';

    const glance = {
      recovery: recoveryToday
        ? {
            score: recoveryToday.score,
            label: recoveryToday.label,
            trend: recoveryDelta != null ? `${recoveryDelta >= 0 ? '+' : ''}${recoveryDelta} vs yesterday` : '',
            components: recoveryToday.components,
          }
        : { score: null, label: 'Insufficient data', trend: '', components: null },
      next_race: nextRace
        ? {
            id: nextRace.id,
            name: cleanForUI(nextRace.name),
            days_away: daysBetween(nextRace.race_date, today),
          }
        : null,
      overdue: { count: overdueCount, hot_count: hotOverdueCount, trend: overdueTrend },
    };

    // ── Final payload ──
    const payload = {
      date: today,
      greeting: buildGreeting(new Date()),
      glance,
      coach_read: coachRead,
      coach_read_signals: signals,
      focus,
      changed_since_yesterday: changed,
      metadata: {
        total_open_tasks: openTasks.length,
        shabbat_active: shabbat,
        shabbat_status: sb,
        between_phases: betweenPhases,
        generated_at: new Date().toISOString(),
      },
    };

    res.json(payload);
  } catch (err) {
    console.error('[GET /briefing]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
