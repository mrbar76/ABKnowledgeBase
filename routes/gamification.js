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

  // Milestone: Tasks (keep for backward compat)
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

  // Streak: Fuel (nutrition targets)
  { key: 'streak_fuel_7', name: 'Fuel Master', icon: '🥩', description: '7-day nutrition target streak', category: 'streak', check: s => s.streak_fuel >= 7 },
  { key: 'streak_fuel_30', name: 'Diet Discipline', icon: '🎯', description: '30-day nutrition target streak', category: 'streak', check: s => s.streak_fuel >= 30 },
  // Keep old execute badges for backward compat (they still unlock if already earned)
  { key: 'streak_execute_7', name: '7-Day Streak', icon: '⚡', description: '7-day task completion streak', category: 'streak', check: s => s.streak_execute >= 7 },
  { key: 'streak_execute_30', name: 'Relentless', icon: '🎯', description: '30-day task completion streak', category: 'streak', check: s => s.streak_execute >= 30 },

  // Streak: Recover
  { key: 'streak_recover_7', name: 'Recovery Pro', icon: '🌿', description: '7-day recovery quality streak', category: 'streak', check: s => s.streak_recover >= 7 },
  { key: 'streak_recover_30', name: 'Body Aware', icon: '🧘', description: '30-day recovery quality streak', category: 'streak', check: s => s.streak_recover >= 30 },

  // Streak: Perfect day (all 3 rings closed)
  { key: 'streak_perfect_3', name: 'Hat Trick', icon: '🎩', description: '3 perfect ring days in a row', category: 'streak', check: s => s.streak_perfect >= 3 },
  { key: 'streak_perfect_7', name: 'Perfect Week', icon: '💎', description: '7 perfect ring days in a row', category: 'streak', check: s => s.streak_perfect >= 7 },
  { key: 'streak_perfect_30', name: 'Legendary', icon: '👑', description: '30 perfect ring days in a row', category: 'streak', check: s => s.streak_perfect >= 30 },

  // Milestone: Daily Plans
  { key: 'first_plan', name: 'Game Plan', icon: '📋', description: 'Create your first daily plan', category: 'milestone', check: s => s.daily_plans >= 1 },
  { key: 'plans_30', name: 'Planner', icon: '🗓️', description: 'Create 30 daily plans', category: 'milestone', check: s => s.daily_plans >= 30 },

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

  weigh_in: `
    WITH dates AS (SELECT DISTINCT measurement_date AS d FROM body_metrics WHERE measurement_date <= CURRENT_DATE ORDER BY d DESC),
    numbered AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d DESC))::int AS grp FROM dates)
    SELECT COALESCE((SELECT COUNT(*)::int FROM numbered WHERE grp = (SELECT grp FROM numbered WHERE d = CURRENT_DATE LIMIT 1)), 0) AS streak`,
};

// Fuel streak: consecutive days where fuel ring >= 80%
// Recover streak: consecutive days where recover ring >= 80%
// Uses proportional model (average of sub-criteria ratios)
async function computeFuelStreak(settings) {
  const proteinTarget = parseFloat(settings.default_protein_target) || 150;
  const calMin = parseFloat(settings.default_calorie_min) || 2000;
  const calMax = parseFloat(settings.default_calorie_max) || 2800;
  const calMid = (calMin + calMax) / 2;
  const hydrationTarget = parseFloat(settings.default_hydration_target) || 2.5;

  const { rows } = await query(`
    WITH day_data AS (
      SELECT d::date AS d,
        COALESCE((SELECT SUM(protein_g) FROM meals WHERE meal_date = d), 0) AS protein,
        COALESCE((SELECT SUM(calories) FROM meals WHERE meal_date = d), 0) AS cal,
        COALESCE((SELECT hydration_liters FROM daily_context WHERE date = d), 0) AS hydration
      FROM generate_series(CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE, '1 day'::interval) AS d
      ORDER BY d DESC
    )
    SELECT d, protein, cal, hydration FROM day_data
  `);

  let streak = 0;
  for (const row of rows) {
    const pProg = Math.min(1, parseFloat(row.protein) / proteinTarget);
    const c = parseFloat(row.cal);
    const cProg = c <= 0 ? 0 : (c >= calMin && c <= calMax) ? 1 : Math.min(1, c / calMid);
    const hProg = hydrationTarget > 0 ? Math.min(1, parseFloat(row.hydration) / hydrationTarget) : 0;
    const fuelPct = ((pProg + cProg + hProg) / 3) * 100;
    if (fuelPct >= 80) streak++;
    else break;
  }
  return streak;
}

async function computeRecoverStreak(settings) {
  const sleepTarget = parseFloat(settings.default_sleep_target) || 7.0;
  const sleepQualThreshold = settings.default_sleep_quality_threshold || 6;
  const recoveryThreshold = settings.default_recovery_threshold || 6;

  const { rows } = await query(`
    WITH day_data AS (
      SELECT d::date AS d,
        COALESCE((SELECT sleep_hours FROM daily_context WHERE date = d), 0) AS sleep_hours,
        COALESCE((SELECT sleep_quality FROM daily_context WHERE date = d), 0) AS sleep_quality,
        COALESCE((SELECT recovery_rating FROM daily_context WHERE date = d), 0) AS recovery_rating,
        COALESCE((SELECT energy_rating FROM daily_context WHERE date = d), 0) AS energy_rating
      FROM generate_series(CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE, '1 day'::interval) AS d
      ORDER BY d DESC
    )
    SELECT d, sleep_hours, sleep_quality, recovery_rating, energy_rating FROM day_data
  `);

  let streak = 0;
  for (const row of rows) {
    const sProg = sleepTarget > 0 ? Math.min(1, parseFloat(row.sleep_hours) / sleepTarget) : 0;
    const qProg = sleepQualThreshold > 0 ? Math.min(1, parseInt(row.sleep_quality) / sleepQualThreshold) : 0;
    const best = Math.max(parseInt(row.recovery_rating) || 0, parseInt(row.energy_rating) || 0);
    const rProg = recoveryThreshold > 0 ? Math.min(1, best / recoveryThreshold) : 0;
    const recPct = ((sProg + qProg + rProg) / 3) * 100;
    if (recPct >= 80) streak++;
    else break;
  }
  return streak;
}

// Perfect day streak: all 3 rings closed
async function computePerfectStreak(settings) {
  const proteinTarget = parseFloat(settings.default_protein_target) || 150;
  const calMin = parseFloat(settings.default_calorie_min) || 2000;
  const calMax = parseFloat(settings.default_calorie_max) || 2800;
  const hydrationTarget = parseFloat(settings.default_hydration_target) || 2.5;
  const sleepTarget = parseFloat(settings.default_sleep_target) || 7.0;
  const sleepQualThreshold = settings.default_sleep_quality_threshold || 6;
  const recoveryThreshold = settings.default_recovery_threshold || 6;
  const defaultEffort = settings.default_effort_target || 6;

  const { rows } = await query(`
    WITH day_data AS (
      SELECT d::date AS d,
        COALESCE((SELECT MAX(effort) FROM workouts WHERE workout_date = d), 0) AS max_effort,
        (SELECT COUNT(*)::int FROM workouts WHERE workout_date = d) AS workout_count,
        (SELECT status FROM daily_plans WHERE plan_date = d) AS plan_status,
        (SELECT target_effort FROM daily_plans WHERE plan_date = d) AS plan_effort,
        COALESCE((SELECT SUM(protein_g) FROM meals WHERE meal_date = d), 0) AS protein,
        COALESCE((SELECT SUM(calories) FROM meals WHERE meal_date = d), 0) AS cal,
        COALESCE((SELECT hydration_liters FROM daily_context WHERE date = d), 0) AS hydration,
        COALESCE((SELECT sleep_hours FROM daily_context WHERE date = d), 0) AS sleep_hours,
        COALESCE((SELECT sleep_quality FROM daily_context WHERE date = d), 0) AS sleep_quality,
        COALESCE((SELECT recovery_rating FROM daily_context WHERE date = d), 0) AS recovery_rating,
        COALESCE((SELECT energy_rating FROM daily_context WHERE date = d), 0) AS energy_rating
      FROM generate_series(CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE, '1 day'::interval) AS d
      ORDER BY d DESC
    )
    SELECT * FROM day_data
  `);

  let streak = 0;
  for (const row of rows) {
    // Train: weighted effort >= 100%
    const targetEffort = row.plan_effort || defaultEffort;
    const trainOk = row.plan_status === 'rest' || (row.workout_count > 0 && row.max_effort >= targetEffort);

    // Fuel: proportional >= 80%
    const calMid = (calMin + calMax) / 2;
    const pProg = Math.min(1, parseFloat(row.protein) / proteinTarget);
    const c = parseFloat(row.cal);
    const cProg = c <= 0 ? 0 : (c >= calMin && c <= calMax) ? 1 : Math.min(1, c / calMid);
    const hProg = hydrationTarget > 0 ? Math.min(1, parseFloat(row.hydration) / hydrationTarget) : 0;
    const fuelOk = ((pProg + cProg + hProg) / 3) * 100 >= 80;

    // Recover: proportional >= 80%
    const sProg = sleepTarget > 0 ? Math.min(1, parseFloat(row.sleep_hours) / sleepTarget) : 0;
    const qProg = sleepQualThreshold > 0 ? Math.min(1, parseInt(row.sleep_quality) / sleepQualThreshold) : 0;
    const bestRec = Math.max(parseInt(row.recovery_rating) || 0, parseInt(row.energy_rating) || 0);
    const rProg = recoveryThreshold > 0 ? Math.min(1, bestRec / recoveryThreshold) : 0;
    const recoverOk = ((sProg + qProg + rProg) / 3) * 100 >= 80;

    if (trainOk && fuelOk && recoverOk) streak++;
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
    const s = settings || {};

    // ── Achievement-based ring data for today ──
    const [workoutsR, mealTotalsR, ctxR, dailyPlanR] = await Promise.all([
      query(`SELECT effort FROM workouts WHERE workout_date = CURRENT_DATE`),
      query(`SELECT COALESCE(SUM(calories), 0)::numeric AS cal, COALESCE(SUM(protein_g), 0)::numeric AS protein FROM meals WHERE meal_date = CURRENT_DATE`),
      query(`SELECT sleep_hours, sleep_quality, hydration_liters, recovery_rating, energy_rating FROM daily_context WHERE date = CURRENT_DATE`),
      query(`SELECT status, target_effort, target_calories, target_protein_g, target_hydration_liters, target_sleep_hours FROM daily_plans WHERE plan_date = CURRENT_DATE`),
    ]);

    const workouts = workoutsR.rows;
    const maxEffort = Math.max(0, ...workouts.map(w => w.effort || 0));
    const { cal, protein } = mealTotalsR.rows[0];
    const ctxRow = ctxR.rows[0] || {};
    const plan = dailyPlanR.rows[0] || null;

    // Targets: daily plan → settings defaults
    const targetEffort = plan?.target_effort || s.default_effort_target || 6;
    const targetProtein = parseFloat(plan?.target_protein_g) || parseFloat(s.default_protein_target) || 150;
    const targetCalories = parseFloat(plan?.target_calories) || null;
    const calMin = targetCalories ? targetCalories * 0.9 : (parseFloat(s.default_calorie_min) || 2000);
    const calMax = targetCalories ? targetCalories * 1.1 : (parseFloat(s.default_calorie_max) || 2800);
    const targetHydration = parseFloat(plan?.target_hydration_liters) || parseFloat(s.default_hydration_target) || 2.5;
    const targetSleep = parseFloat(plan?.target_sleep_hours) || parseFloat(s.default_sleep_target) || 7.0;
    const sleepQualThreshold = s.default_sleep_quality_threshold || 6;
    const recoveryThreshold = s.default_recovery_threshold || 6;
    const hydration = parseFloat(ctxRow.hydration_liters) || 0;
    const sleepHours = parseFloat(ctxRow.sleep_hours) || 0;
    const sleepQuality = parseInt(ctxRow.sleep_quality) || 0;
    const recoveryRating = parseInt(ctxRow.recovery_rating) || 0;
    const energyRating = parseInt(ctxRow.energy_rating) || 0;

    // ── TRAIN ring: weighted effort score ──
    let trainPercent;
    if (plan && plan.status === 'rest') {
      trainPercent = 100;
    } else if (workouts.length > 0) {
      trainPercent = Math.min(100, Math.round((maxEffort / targetEffort) * 100));
    } else {
      trainPercent = 0;
    }

    // ── FUEL ring: proportional progress across protein + calories + hydration ──
    const proteinActual = parseFloat(protein) || 0;
    const caloriesActual = parseFloat(cal) || 0;
    const proteinHit = proteinActual >= targetProtein;
    const caloriesHit = caloriesActual >= calMin && caloriesActual <= calMax;
    const hydrationHit = hydration >= targetHydration;
    const proteinProgress = Math.min(1, proteinActual / targetProtein);
    const calMid = (calMin + calMax) / 2;
    const caloriesProgress = caloriesActual <= 0 ? 0 : caloriesActual >= calMin && caloriesActual <= calMax ? 1 : Math.min(1, caloriesActual / calMid);
    const hydrationProgress = targetHydration > 0 ? Math.min(1, hydration / targetHydration) : 0;
    const fuelPercent = Math.min(100, Math.round(((proteinProgress + caloriesProgress + hydrationProgress) / 3) * 100));

    // ── RECOVER ring: proportional progress across sleep + quality + recovery ──
    const sleepHoursHit = sleepHours >= targetSleep;
    const sleepQualHit = sleepQuality >= sleepQualThreshold;
    const recoveryHit = recoveryRating >= recoveryThreshold || energyRating >= recoveryThreshold;
    const sleepProgress = targetSleep > 0 ? Math.min(1, sleepHours / targetSleep) : 0;
    const sleepQualProgress = sleepQualThreshold > 0 ? Math.min(1, sleepQuality / sleepQualThreshold) : 0;
    const bestRecovery = Math.max(recoveryRating, energyRating);
    const recoveryProgress = recoveryThreshold > 0 ? Math.min(1, bestRecovery / recoveryThreshold) : 0;
    const recoverPercent = Math.min(100, Math.round(((sleepProgress + sleepQualProgress + recoveryProgress) / 3) * 100));

    const rings = {
      train: {
        current: maxEffort, goal: targetEffort, percent: trainPercent,
        is_rest_day: plan?.status === 'rest',
        has_plan: !!plan,
      },
      fuel: {
        percent: fuelPercent,
        protein_hit: proteinHit, calories_hit: caloriesHit, hydration_hit: hydrationHit,
        protein_actual: Math.round(proteinActual), protein_target: Math.round(targetProtein), protein_progress: Math.round(proteinProgress * 100),
        calories_actual: Math.round(caloriesActual), calories_min: Math.round(calMin), calories_max: Math.round(calMax), calories_progress: Math.round(caloriesProgress * 100),
        hydration_actual: hydration, hydration_target: targetHydration, hydration_progress: Math.round(hydrationProgress * 100),
      },
      recover: {
        percent: recoverPercent,
        sleep_hit: sleepHoursHit, quality_hit: sleepQualHit, recovery_hit: recoveryHit,
        sleep_actual: sleepHours, sleep_target: targetSleep, sleep_progress: Math.round(sleepProgress * 100),
        sleep_quality_actual: sleepQuality, sleep_quality_threshold: sleepQualThreshold, quality_progress: Math.round(sleepQualProgress * 100),
        recovery_actual: bestRecovery, recovery_threshold: recoveryThreshold, recovery_progress: Math.round(recoveryProgress * 100),
      },
    };

    // ── Streaks ──
    const [streakTrain, streakExecute, streakWeighIn] = await Promise.all(
      ['train', 'execute', 'weigh_in'].map(k => query(STREAK_SQL[k]).then(r => r.rows[0]?.streak || 0))
    );
    const [streakFuel, streakRecover, streakPerfect] = await Promise.all([
      computeFuelStreak(s),
      computeRecoverStreak(s),
      computePerfectStreak(s),
    ]);

    const streaks = {
      train: streakTrain,
      fuel: streakFuel,
      execute: streakExecute,
      recover: streakRecover,
      perfect_day: streakPerfect,
      weigh_in: streakWeighIn,
    };

    // ── Badge check ──
    const [totalWorkouts, totalTasksDone, totalMeals, totalBody, totalKnowledge, workoutTypes, maxEffortAll, totalPlans] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM workouts`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'done'`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM meals`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM body_metrics`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM knowledge`).then(r => r.rows[0].n),
      query(`SELECT COUNT(DISTINCT workout_type)::int AS n FROM workouts`).then(r => r.rows[0].n),
      query(`SELECT COALESCE(MAX(effort), 0)::int AS n FROM workouts`).then(r => r.rows[0].n),
      query(`SELECT COUNT(*)::int AS n FROM daily_plans`).then(r => r.rows[0].n),
    ]);

    const badgeStats = {
      workouts: totalWorkouts, tasks_done: totalTasksDone, meals: totalMeals,
      body_metrics: totalBody, knowledge: totalKnowledge,
      workout_types: workoutTypes, max_effort: maxEffortAll,
      daily_plans: totalPlans,
      streak_train: streakTrain, streak_fuel: streakFuel,
      streak_execute: streakExecute, streak_recover: streakRecover,
      streak_perfect: streakPerfect,
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

    // ── Nudges — achievement-based guidance ──
    const nudges = [];
    if (rings.train.percent < 100) {
      if (plan && plan.status !== 'rest') {
        const remaining = targetEffort - maxEffort;
        nudges.push({ type: 'warning', ring: 'train', message: workouts.length === 0 ? `Planned: ${plan?.workout_type || 'workout'} at effort ${targetEffort}` : `Effort ${maxEffort}/${targetEffort} — push harder to close Train` });
      } else if (!plan) {
        nudges.push({ type: 'info', ring: 'train', message: workouts.length === 0 ? 'No plan today — log a workout at effort 6+ to close Train' : `Effort ${maxEffort}/${targetEffort} — needs more intensity` });
      }
    }
    if (rings.fuel.percent < 100) {
      const missing = [];
      if (!proteinHit) missing.push(`${Math.round(targetProtein - parseFloat(protein))}g more protein`);
      if (!caloriesHit) {
        if (parseFloat(cal) < calMin) missing.push(`${Math.round(calMin - parseFloat(cal))} more calories`);
        else missing.push(`over calorie target by ${Math.round(parseFloat(cal) - calMax)}`);
      }
      if (!hydrationHit) missing.push(`${(targetHydration - hydration).toFixed(1)}L more water`);
      nudges.push({ type: 'warning', ring: 'fuel', message: `Fuel: ${missing.join(', ')}` });
    }
    if (rings.recover.percent < 100) {
      const missing = [];
      if (!sleepHoursHit) missing.push(`sleep was ${sleepHours || '?'}h (target ${targetSleep}h)`);
      if (!sleepQualHit) missing.push(`sleep quality ${sleepQuality || '?'}/10 (need ${sleepQualThreshold}+)`);
      if (!recoveryHit) missing.push(`recovery ${Math.max(recoveryRating, energyRating) || '?'}/10 (need ${recoveryThreshold}+)`);
      nudges.push({ type: 'warning', ring: 'recover', message: `Recover: ${missing.join(', ')}` });
    }
    if (trainPercent >= 100 && fuelPercent >= 100 && recoverPercent >= 100) {
      nudges.push({ type: 'success', message: 'All rings closed! Perfect day.' });
    }

    // ── Weekly summary (fitness-focused) ──
    let weekly = {};
    try {
      const wData = await query(`
        WITH days AS (
          SELECT d::date AS d,
            (SELECT COUNT(*)::int FROM workouts WHERE workout_date = d) AS workouts,
            COALESCE((SELECT MAX(effort) FROM workouts WHERE workout_date = d), 0) AS max_effort,
            COALESCE((SELECT SUM(protein_g) FROM meals WHERE meal_date = d), 0) AS protein,
            COALESCE((SELECT SUM(calories) FROM meals WHERE meal_date = d), 0) AS cal,
            COALESCE((SELECT hydration_liters FROM daily_context WHERE date = d), 0) AS hydration,
            COALESCE((SELECT sleep_hours FROM daily_context WHERE date = d), 0) AS sleep_hours,
            COALESCE((SELECT sleep_quality FROM daily_context WHERE date = d), 0) AS sleep_quality,
            COALESCE((SELECT recovery_rating FROM daily_context WHERE date = d), 0) AS recovery_rating,
            COALESCE((SELECT energy_rating FROM daily_context WHERE date = d), 0) AS energy_rating,
            (SELECT status FROM daily_plans WHERE plan_date = d) AS plan_status,
            (SELECT target_effort FROM daily_plans WHERE plan_date = d) AS plan_effort
          FROM generate_series(date_trunc('week', CURRENT_DATE)::date, CURRENT_DATE, '1 day') d
        )
        SELECT * FROM days ORDER BY d
      `);

      let trainDays = 0, fuelDays = 0, recoverDays = 0, perfectDays = 0;
      const dayDetails = [];

      for (const row of wData.rows) {
        const te = row.plan_effort || s.default_effort_target || 6;
        const tOk = row.plan_status === 'rest' || (row.workouts > 0 && row.max_effort >= te);
        const wProteinTarget = parseFloat(s.default_protein_target) || 150;
        const wCalMin = parseFloat(s.default_calorie_min) || 2000;
        const wCalMax = parseFloat(s.default_calorie_max) || 2800;
        const wCalMid = (wCalMin + wCalMax) / 2;
        const wHydTarget = parseFloat(s.default_hydration_target) || 2.5;
        const wPProg = Math.min(1, parseFloat(row.protein) / wProteinTarget);
        const wC = parseFloat(row.cal);
        const wCProg = wC <= 0 ? 0 : (wC >= wCalMin && wC <= wCalMax) ? 1 : Math.min(1, wC / wCalMid);
        const wHProg = wHydTarget > 0 ? Math.min(1, parseFloat(row.hydration) / wHydTarget) : 0;
        const fOk = ((wPProg + wCProg + wHProg) / 3) * 100 >= 80;

        const wSleepTarget = parseFloat(s.default_sleep_target) || 7;
        const wSQThresh = s.default_sleep_quality_threshold || 6;
        const wRThresh = s.default_recovery_threshold || 6;
        const wSProg = wSleepTarget > 0 ? Math.min(1, parseFloat(row.sleep_hours) / wSleepTarget) : 0;
        const wQProg = wSQThresh > 0 ? Math.min(1, parseInt(row.sleep_quality) / wSQThresh) : 0;
        const wBest = Math.max(parseInt(row.recovery_rating) || 0, parseInt(row.energy_rating) || 0);
        const wRProg = wRThresh > 0 ? Math.min(1, wBest / wRThresh) : 0;
        const recOk = ((wSProg + wQProg + wRProg) / 3) * 100 >= 80;

        if (tOk) trainDays++;
        if (fOk) fuelDays++;
        if (recOk) recoverDays++;
        if (tOk && fOk && recOk) perfectDays++;

        dayDetails.push({ date: row.d, train_closed: tOk, fuel_closed: fOk, recover_closed: recOk });
      }

      const dayOfWeek = new Date().getDay() || 7;
      weekly = {
        day_of_week: dayOfWeek,
        train: { days_closed: trainDays, target_days: 5 },
        fuel: { days_closed: fuelDays, target_days: 5 },
        recover: { days_closed: recoverDays, target_days: 5 },
        perfect_days: perfectDays,
        days: dayDetails,
      };
    } catch (e) {
      console.warn('[gamification] Weekly computation failed:', e.message);
    }

    // ── Today's plan summary ──
    let today_plan = null;
    if (plan) {
      today_plan = {
        status: plan.status,
        workout_type: plan.workout_type || null,
        workout_focus: plan.workout_focus || null,
        target_effort: plan.target_effort || null,
      };
    }

    res.json({
      rings, streaks, badges, nudges, weekly, today_plan,
      settings: {
        ring_train_goal: 1,
        ring_fuel_goal: 3,
        ring_recover_goal: 3,
        default_effort_target: s.default_effort_target || 6,
        default_protein_target: parseFloat(s.default_protein_target) || 150,
        default_calorie_min: parseFloat(s.default_calorie_min) || 2000,
        default_calorie_max: parseFloat(s.default_calorie_max) || 2800,
        default_hydration_target: parseFloat(s.default_hydration_target) || 2.5,
        default_sleep_target: parseFloat(s.default_sleep_target) || 7.0,
        default_sleep_quality_threshold: s.default_sleep_quality_threshold || 6,
        default_recovery_threshold: s.default_recovery_threshold || 6,
        notification_enabled: s.notification_enabled,
      },
    });
  } catch (err) {
    console.error('[gamification] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// PUT /api/gamification/settings — update ring thresholds + prefs
// ══════════════════════════════════════════════════════════════════

const SETTINGS_FIELDS = [
  'ring_train_goal', 'ring_execute_goal', 'ring_recover_goal',
  'default_protein_target', 'default_calorie_min', 'default_calorie_max',
  'default_hydration_target', 'default_sleep_target',
  'default_sleep_quality_threshold', 'default_recovery_threshold', 'default_effort_target',
  'notification_enabled',
];

router.put('/settings', async (req, res) => {
  try {
    const fields = [];
    const vals = [];
    let i = 1;

    for (const field of SETTINGS_FIELDS) {
      if (req.body[field] != null) {
        fields.push(`${field} = $${i++}`);
        vals.push(req.body[field]);
      }
    }
    if (req.body.notification_schedule != null) {
      fields.push(`notification_schedule = $${i++}`);
      vals.push(JSON.stringify(req.body.notification_schedule));
    }
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
