const express = require('express');
const router = express.Router();
const { query, logActivity } = require('../db');

// ══════════════════════════════════════════════════════════════════
// Badge definitions — static, checked against live DB counts
// ══════════════════════════════════════════════════════════════════

const BADGES = [
  // Milestone: Workouts
  { key: 'first_workout', name: 'First Sweat', icon: '💧', description: 'Log your first workout', category: 'milestone', check: s => s.workouts >= 1 },
  { key: 'workouts_10', name: '10 Strong', icon: '💪', description: 'Log 10 workouts', category: 'milestone', check: s => s.workouts >= 10 },
  { key: 'workouts_50', name: 'Half Century', icon: '🏋️', description: 'Log 50 workouts', category: 'milestone', check: s => s.workouts >= 50 },
  { key: 'workouts_100', name: 'Century Club', icon: '🏆', description: 'Log 100 workouts', category: 'milestone', check: s => s.workouts >= 100 },
  { key: 'workouts_250', name: 'Iron Will', icon: '⚔️', description: 'Log 250 workouts', category: 'milestone', check: s => s.workouts >= 250 },

  // Milestone: Tasks
  { key: 'first_task', name: 'First Win', icon: '✅', description: 'Complete your first task', category: 'milestone', check: s => s.tasks_done >= 1 },
  { key: 'tasks_25', name: 'Executor', icon: '⚡', description: 'Complete 25 tasks', category: 'milestone', check: s => s.tasks_done >= 25 },
  { key: 'tasks_100', name: 'Machine', icon: '🤖', description: 'Complete 100 tasks', category: 'milestone', check: s => s.tasks_done >= 100 },
  { key: 'tasks_500', name: 'Unstoppable', icon: '🚀', description: 'Complete 500 tasks', category: 'milestone', check: s => s.tasks_done >= 500 },

  // Milestone: Meals
  { key: 'first_meal', name: 'First Bite', icon: '🍎', description: 'Log your first meal', category: 'milestone', check: s => s.meals >= 1 },
  { key: 'meals_50', name: 'Consistent Eater', icon: '🥗', description: 'Log 50 meals', category: 'milestone', check: s => s.meals >= 50 },
  { key: 'meals_200', name: 'Nutrition Master', icon: '🧬', description: 'Log 200 meals', category: 'milestone', check: s => s.meals >= 200 },

  // Milestone: Body
  { key: 'first_weigh_in', name: 'First Check-In', icon: '📊', description: 'Log your first body metric', category: 'milestone', check: s => s.body_metrics >= 1 },

  // Streak: Train
  { key: 'streak_train_7', name: '7-Day Warrior', icon: '🔥', description: '7-day workout streak', category: 'streak', check: s => s.streak_train >= 7 },
  { key: 'streak_train_30', name: '30-Day Beast', icon: '🐉', description: '30-day workout streak', category: 'streak', check: s => s.streak_train >= 30 },

  // Streak: Execute
  { key: 'streak_execute_7', name: '7-Day Streak', icon: '⚡', description: '7-day task completion streak', category: 'streak', check: s => s.streak_execute >= 7 },
  { key: 'streak_execute_30', name: 'Relentless', icon: '🎯', description: '30-day task completion streak', category: 'streak', check: s => s.streak_execute >= 30 },

  // Streak: Recover
  { key: 'streak_recover_7', name: 'Recovery Pro', icon: '🌿', description: '7-day recovery tracking streak', category: 'streak', check: s => s.streak_recover >= 7 },
  { key: 'streak_recover_30', name: 'Body Aware', icon: '🧘', description: '30-day recovery tracking streak', category: 'streak', check: s => s.streak_recover >= 30 },

  // Streak: Perfect day (all 3 rings closed)
  { key: 'streak_perfect_3', name: 'Hat Trick', icon: '🎩', description: '3 perfect ring days in a row', category: 'streak', check: s => s.streak_perfect >= 3 },
  { key: 'streak_perfect_7', name: 'Perfect Week', icon: '💎', description: '7 perfect ring days in a row', category: 'streak', check: s => s.streak_perfect >= 7 },
  { key: 'streak_perfect_30', name: 'Legendary', icon: '👑', description: '30 perfect ring days in a row', category: 'streak', check: s => s.streak_perfect >= 30 },

  // Variety
  { key: 'workout_variety_5', name: 'All-Rounder', icon: '🎯', description: 'Log 5 different workout types', category: 'variety', check: s => s.workout_types >= 5 },
  { key: 'effort_10', name: 'Max Effort', icon: '🔴', description: 'Log a workout with effort 10', category: 'variety', check: s => s.max_effort >= 10 },
  { key: 'data_complete', name: 'Full Stack', icon: '📦', description: 'Have entries in workouts, tasks, meals, body metrics, and knowledge', category: 'variety', check: s => s.workouts > 0 && s.tasks_done > 0 && s.meals > 0 && s.body_metrics > 0 && s.knowledge > 0 },
];

// ══════════════════════════════════════════════════════════════════
// Streak computation — consecutive days backward from today
// ══════════════════════════════════════════════════════════════════

const STREAK_SQL = {
  train: `
    WITH dates AS (SELECT DISTINCT workout_date AS d FROM workouts WHERE workout_date <= CURRENT_DATE ORDER BY d DESC),
    numbered AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d DESC))::int AS grp FROM dates)
    SELECT COALESCE((SELECT COUNT(*)::int FROM numbered WHERE grp = (SELECT grp FROM numbered WHERE d = CURRENT_DATE LIMIT 1)), 0) AS streak`,

  execute: `
    WITH dates AS (SELECT DISTINCT updated_at::date AS d FROM tasks WHERE status = 'done' AND updated_at::date <= CURRENT_DATE ORDER BY d DESC),
    numbered AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d DESC))::int AS grp FROM dates)
    SELECT COALESCE((SELECT COUNT(*)::int FROM numbered WHERE grp = (SELECT grp FROM numbered WHERE d = CURRENT_DATE LIMIT 1)), 0) AS streak`,

  recover: `
    WITH meal_dates AS (SELECT DISTINCT meal_date AS d FROM meals WHERE meal_date <= CURRENT_DATE),
    ctx_dates AS (SELECT DISTINCT date AS d FROM daily_nutrition_context WHERE date <= CURRENT_DATE),
    dates AS (SELECT d FROM meal_dates INTERSECT SELECT d FROM ctx_dates ORDER BY d DESC),
    numbered AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d DESC))::int AS grp FROM dates)
    SELECT COALESCE((SELECT COUNT(*)::int FROM numbered WHERE grp = (SELECT grp FROM numbered WHERE d = CURRENT_DATE LIMIT 1)), 0) AS streak`,

  weigh_in: `
    WITH dates AS (SELECT DISTINCT measurement_date AS d FROM body_metrics WHERE measurement_date <= CURRENT_DATE ORDER BY d DESC),
    numbered AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d DESC))::int AS grp FROM dates)
    SELECT COALESCE((SELECT COUNT(*)::int FROM numbered WHERE grp = (SELECT grp FROM numbered WHERE d = CURRENT_DATE LIMIT 1)), 0) AS streak`,
};

// Perfect day streak needs ring goals, computed in JS
async function computePerfectStreak(goals) {
  const { rows } = await query(`
    WITH day_data AS (
      SELECT d,
        (SELECT COUNT(*)::int FROM workouts WHERE workout_date = d) AS train,
        (SELECT COUNT(*)::int FROM tasks WHERE status = 'done' AND updated_at::date = d) AS execute,
        (SELECT COUNT(*)::int FROM meals WHERE meal_date = d) AS meals,
        (SELECT COUNT(*)::int FROM daily_nutrition_context WHERE date = d) AS ctx
      FROM generate_series(CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE, '1 day'::interval) AS d
      ORDER BY d DESC
    )
    SELECT d, train, execute, meals, ctx FROM day_data
  `);

  let streak = 0;
  for (const row of rows) {
    const trainOk = row.train >= goals.ring_train_goal;
    const execOk = row.execute >= goals.ring_execute_goal;
    const recoverOk = row.meals >= Math.max(1, goals.ring_recover_goal - 1) && row.ctx >= 1;
    if (trainOk && execOk && recoverOk) streak++;
    else break;
  }
  return streak;
}

// ══════════════════════════════════════════════════════════════════
// GET /api/gamification — main endpoint
// ══════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  try {
    // Load settings
    const { rows: [settings] } = await query(`SELECT * FROM gamification_settings WHERE id = 1`);
    const goals = settings || { ring_train_goal: 1, ring_execute_goal: 3, ring_recover_goal: 3 };

    // Ring counts for today — parallel queries
    const [trainR, executeR, mealsR, ctxR] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM workouts WHERE workout_date = CURRENT_DATE`),
      query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'done' AND updated_at::date = CURRENT_DATE`),
      query(`SELECT COUNT(*)::int AS n FROM meals WHERE meal_date = CURRENT_DATE`),
      query(`SELECT COUNT(*)::int AS n FROM daily_nutrition_context WHERE date = CURRENT_DATE`),
    ]);

    const trainCount = trainR.rows[0].n;
    const executeCount = executeR.rows[0].n;
    const mealsCount = mealsR.rows[0].n;
    const ctxCount = ctxR.rows[0].n;
    // Recover: meals logged + context filled. Goal is e.g. 3 = at least 2 meals + context, or 3 meals + context
    const recoverCount = mealsCount + ctxCount;

    const rings = {
      train: { current: trainCount, goal: goals.ring_train_goal, percent: Math.min(100, Math.round((trainCount / Math.max(1, goals.ring_train_goal)) * 100)) },
      execute: { current: executeCount, goal: goals.ring_execute_goal, percent: Math.min(100, Math.round((executeCount / Math.max(1, goals.ring_execute_goal)) * 100)) },
      recover: { current: recoverCount, goal: goals.ring_recover_goal, percent: Math.min(100, Math.round((recoverCount / Math.max(1, goals.ring_recover_goal)) * 100)) },
    };

    // Streaks — parallel
    const [streakTrain, streakExecute, streakRecover, streakWeighIn] = await Promise.all(
      ['train', 'execute', 'recover', 'weigh_in'].map(k => query(STREAK_SQL[k]).then(r => r.rows[0]?.streak || 0))
    );
    const streakPerfect = await computePerfectStreak(goals);

    const streaks = {
      train: streakTrain,
      execute: streakExecute,
      recover: streakRecover,
      perfect_day: streakPerfect,
      weigh_in: streakWeighIn,
    };

    // Badge check — gather stats
    const [totalWorkouts, totalTasksDone, totalMeals, totalBody, totalKnowledge, workoutTypes, maxEffort] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM workouts`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'done'`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM meals`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM body_metrics`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM knowledge`).then(r => r.rows[0].n),
      query(`SELECT COUNT(DISTINCT workout_type)::int AS n FROM workouts`).then(r => r.rows[0].n),
      query(`SELECT COALESCE(MAX(effort), 0)::int AS n FROM workouts`).then(r => r.rows[0].n),
    ]);

    const badgeStats = {
      workouts: totalWorkouts, tasks_done: totalTasksDone, meals: totalMeals,
      body_metrics: totalBody, knowledge: totalKnowledge,
      workout_types: workoutTypes, max_effort: maxEffort,
      streak_train: streakTrain, streak_execute: streakExecute,
      streak_recover: streakRecover, streak_perfect: streakPerfect,
    };

    // Load already-unlocked badges
    const { rows: unlockedRows } = await query(`SELECT badge_key, unlocked_at FROM badges`);
    const unlockedSet = new Set(unlockedRows.map(r => r.badge_key));
    const unlockedMap = Object.fromEntries(unlockedRows.map(r => [r.badge_key, r.unlocked_at]));

    // Check for newly unlocked
    const newlyUnlocked = [];
    for (const badge of BADGES) {
      if (!unlockedSet.has(badge.key) && badge.check(badgeStats)) {
        await query(`INSERT INTO badges (badge_key, metadata) VALUES ($1, $2) ON CONFLICT (badge_key) DO NOTHING`, [badge.key, JSON.stringify({ stats: badgeStats })]);
        newlyUnlocked.push({ key: badge.key, name: badge.name, icon: badge.icon, description: badge.description });
        unlockedSet.add(badge.key);
        await logActivity('badge_unlocked', 'badge', badge.key, null, badge.name);
      }
    }

    const badges = {
      unlocked: BADGES.filter(b => unlockedSet.has(b.key)).map(b => ({
        key: b.key, name: b.name, icon: b.icon, description: b.description, category: b.category,
        unlocked_at: unlockedMap[b.key] || new Date().toISOString(),
      })),
      locked: BADGES.filter(b => !unlockedSet.has(b.key)).map(b => ({
        key: b.key, name: b.name, icon: b.icon, description: b.description, category: b.category,
      })),
      newly_unlocked: newlyUnlocked,
      total_unlocked: unlockedSet.size,
      total_available: BADGES.length,
    };

    // Nudges — what's incomplete today
    const nudges = [];
    if (rings.train.percent < 100) {
      nudges.push({ type: 'warning', ring: 'train', message: streaks.train > 0 ? `Your ${streaks.train}-day train streak ends today — log a workout` : 'No workout logged today' });
    }
    if (rings.execute.percent < 100) {
      nudges.push({ type: 'info', ring: 'execute', message: `${executeCount}/${goals.ring_execute_goal} tasks completed today` });
    }
    if (rings.recover.percent < 100) {
      const missing = [];
      if (mealsCount === 0) missing.push('meals');
      else if (mealsCount < 3) missing.push(`only ${mealsCount} meal${mealsCount > 1 ? 's' : ''} logged`);
      if (ctxCount === 0) missing.push('daily context');
      nudges.push({ type: 'warning', ring: 'recover', message: missing.length ? `Missing: ${missing.join(', ')}` : `Recovery ${recoverCount}/${goals.ring_recover_goal}` });
    }
    if (rings.train.percent >= 100 && rings.execute.percent >= 100 && rings.recover.percent >= 100) {
      nudges.push({ type: 'success', message: 'All rings closed! Perfect day.' });
    }

    res.json({ rings, streaks, badges, nudges, settings: { ring_train_goal: goals.ring_train_goal, ring_execute_goal: goals.ring_execute_goal, ring_recover_goal: goals.ring_recover_goal, notification_enabled: goals.notification_enabled } });
  } catch (err) {
    console.error('[gamification] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// PUT /api/gamification/settings — update ring goals + prefs
// ══════════════════════════════════════════════════════════════════

router.put('/settings', async (req, res) => {
  try {
    const { ring_train_goal, ring_execute_goal, ring_recover_goal, notification_enabled, notification_schedule } = req.body;
    const fields = [];
    const vals = [];
    let i = 1;
    if (ring_train_goal != null) { fields.push(`ring_train_goal = $${i++}`); vals.push(ring_train_goal); }
    if (ring_execute_goal != null) { fields.push(`ring_execute_goal = $${i++}`); vals.push(ring_execute_goal); }
    if (ring_recover_goal != null) { fields.push(`ring_recover_goal = $${i++}`); vals.push(ring_recover_goal); }
    if (notification_enabled != null) { fields.push(`notification_enabled = $${i++}`); vals.push(notification_enabled); }
    if (notification_schedule != null) { fields.push(`notification_schedule = $${i++}`); vals.push(JSON.stringify(notification_schedule)); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    fields.push(`updated_at = NOW()`);
    await query(`UPDATE gamification_settings SET ${fields.join(', ')} WHERE id = 1`, vals);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// Push notification subscription management
// ══════════════════════════════════════════════════════════════════

router.post('/notifications/subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Missing subscription' });
    await query(`UPDATE gamification_settings SET push_subscription = $1, updated_at = NOW() WHERE id = 1`, [JSON.stringify(subscription)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/unsubscribe', async (req, res) => {
  try {
    await query(`UPDATE gamification_settings SET push_subscription = NULL, updated_at = NOW() WHERE id = 1`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/notifications/vapid-public-key', async (req, res) => {
  try {
    const { rows: [settings] } = await query(`SELECT vapid_public_key FROM gamification_settings WHERE id = 1`);
    res.json({ key: settings?.vapid_public_key || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a test notification
router.post('/notifications/test', async (req, res) => {
  try {
    const webpush = require('web-push');
    const { rows: [settings] } = await query(`SELECT * FROM gamification_settings WHERE id = 1`);
    if (!settings?.push_subscription) return res.status(400).json({ error: 'No push subscription registered' });
    if (!settings.vapid_public_key) return res.status(400).json({ error: 'VAPID keys not configured' });

    webpush.setVapidDetails('mailto:avi@abbrain.app', settings.vapid_public_key, settings.vapid_private_key);
    await webpush.sendNotification(settings.push_subscription, JSON.stringify({
      title: 'AB Brain',
      body: 'Push notifications are working!',
      icon: '/icons/brand/icon-app-180.png',
      badge: '/icons/brand/icon-app-64.png',
      url: '/',
    }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Badge definitions for frontend
router.get('/badges', (req, res) => {
  res.json(BADGES.map(b => ({ key: b.key, name: b.name, icon: b.icon, description: b.description, category: b.category })));
});

module.exports = router;
