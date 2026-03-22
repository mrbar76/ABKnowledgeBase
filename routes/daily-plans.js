const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// Writable fields for daily_plans
const WRITABLE_FIELDS = [
  'plan_date', 'status', 'title', 'goal',
  'workout_type', 'workout_focus', 'target_effort', 'target_duration_min', 'workout_notes',
  'target_calories', 'target_protein_g', 'target_carbs_g', 'target_fat_g', 'target_hydration_liters',
  'target_sleep_hours', 'recovery_notes',
  'coaching_notes', 'rationale', 'tags', 'ai_source', 'metadata',
];

// ══════════════════════════════════════════════════════════════════
//  LIST / SEARCH DAILY PLANS
// ══════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  try {
    const { date, from, to, status: st, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (date) { where.push(`plan_date = $${i++}`); params.push(date); }
    if (from) { where.push(`plan_date >= $${i++}`); params.push(from); }
    if (to) { where.push(`plan_date <= $${i++}`); params.push(to); }
    if (st) { where.push(`status = $${i++}`); params.push(st); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const countResult = await query(`SELECT COUNT(*) as total FROM daily_plans ${whereClause}`, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total, 10);

    const { rows } = await query(
      `SELECT * FROM daily_plans ${whereClause} ORDER BY plan_date DESC LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    res.json({ total, limit: Number(limit), offset: Number(offset), results: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  GET DAILY PLAN BY DATE — with actual data + comparison + rings
// ══════════════════════════════════════════════════════════════════

router.get('/by-date/:date', async (req, res) => {
  try {
    const { date } = req.params;

    // Fetch plan + actual data in parallel
    const [planR, workoutsR, mealsR, ctxR, metricsR, settingsR] = await Promise.all([
      query('SELECT * FROM daily_plans WHERE plan_date = $1', [date]),
      query('SELECT * FROM workouts WHERE workout_date = $1 ORDER BY created_at', [date]),
      query('SELECT * FROM meals WHERE meal_date = $1 ORDER BY meal_time ASC NULLS LAST', [date]),
      query('SELECT * FROM daily_context WHERE date = $1', [date]),
      query('SELECT * FROM body_metrics WHERE measurement_date = $1 ORDER BY measurement_time ASC NULLS LAST', [date]),
      query('SELECT * FROM gamification_settings WHERE id = 1'),
    ]);

    const plan = planR.rows[0] || null;
    const workouts = workoutsR.rows;
    const meals = mealsR.rows;
    const ctx = ctxR.rows[0] || {};
    const settings = settingsR.rows[0] || {};

    // Compute totals
    const totalCal = meals.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
    const totalProtein = meals.reduce((s, m) => s + (parseFloat(m.protein_g) || 0), 0);
    const totalCarbs = meals.reduce((s, m) => s + (parseFloat(m.carbs_g) || 0), 0);
    const totalFat = meals.reduce((s, m) => s + (parseFloat(m.fat_g) || 0), 0);
    const maxEffort = Math.max(0, ...workouts.map(w => w.effort || 0));
    const hydration = parseFloat(ctx.hydration_liters) || 0;
    const sleepHours = parseFloat(ctx.sleep_hours) || 0;
    const sleepQuality = parseInt(ctx.sleep_quality) || 0;
    const recoveryRating = parseInt(ctx.recovery_rating) || 0;
    const energyRating = parseInt(ctx.energy_rating) || 0;

    // Targets: daily plan → gamification_settings defaults
    const targetEffort = plan?.target_effort || settings.default_effort_target || 6;
    const targetProtein = parseFloat(plan?.target_protein_g) || parseFloat(settings.default_protein_target) || 150;
    const targetCalories = parseFloat(plan?.target_calories) || null;
    const calMin = targetCalories ? targetCalories * 0.9 : (parseFloat(settings.default_calorie_min) || 2000);
    const calMax = targetCalories ? targetCalories * 1.1 : (parseFloat(settings.default_calorie_max) || 2800);
    const targetHydration = parseFloat(plan?.target_hydration_liters) || parseFloat(settings.default_hydration_target) || 2.5;
    const targetSleep = parseFloat(plan?.target_sleep_hours) || parseFloat(settings.default_sleep_target) || 7.0;
    const sleepQualThreshold = settings.default_sleep_quality_threshold || 6;
    const recoveryThreshold = settings.default_recovery_threshold || 6;

    // Ring progress: Train (weighted effort)
    let trainPercent;
    if (plan && plan.status === 'rest') {
      trainPercent = 100;
    } else if (workouts.length > 0) {
      trainPercent = Math.min(100, Math.round((maxEffort / targetEffort) * 100));
    } else {
      trainPercent = 0;
    }

    // Ring progress: Fuel (protein + calories + hydration)
    const proteinHit = totalProtein >= targetProtein;
    const caloriesHit = totalCal >= calMin && totalCal <= calMax;
    const hydrationHit = hydration >= targetHydration;
    const fuelCount = (proteinHit ? 1 : 0) + (caloriesHit ? 1 : 0) + (hydrationHit ? 1 : 0);
    const fuelPercent = Math.min(100, Math.round((fuelCount / 3) * 100));

    // Ring progress: Recover (sleep hours + sleep quality + recovery rating)
    const sleepHoursHit = sleepHours >= targetSleep;
    const sleepQualHit = sleepQuality >= sleepQualThreshold;
    const recoveryHit = recoveryRating >= recoveryThreshold || energyRating >= recoveryThreshold;
    const recoverCount = (sleepHoursHit ? 1 : 0) + (sleepQualHit ? 1 : 0) + (recoveryHit ? 1 : 0);
    const recoverPercent = Math.min(100, Math.round((recoverCount / 3) * 100));

    res.json({
      plan,
      actual: {
        workouts,
        meals,
        nutrition_context: ctx,
        body_metrics: metricsR.rows,
      },
      comparison: {
        effort_actual: maxEffort,
        effort_target: targetEffort,
        effort_percent: trainPercent,
        calories_actual: Math.round(totalCal),
        calories_target: targetCalories || Math.round((calMin + calMax) / 2),
        calories_min: Math.round(calMin),
        calories_max: Math.round(calMax),
        protein_actual: Math.round(totalProtein),
        protein_target: Math.round(targetProtein),
        carbs_actual: Math.round(totalCarbs),
        fat_actual: Math.round(totalFat),
        hydration_actual: hydration,
        hydration_target: targetHydration,
        sleep_actual: sleepHours,
        sleep_target: targetSleep,
        sleep_quality_actual: sleepQuality,
        sleep_quality_threshold: sleepQualThreshold,
        recovery_actual: recoveryRating,
        recovery_threshold: recoveryThreshold,
      },
      ring_progress: {
        train: { percent: trainPercent, effort_actual: maxEffort, effort_target: targetEffort },
        fuel: { percent: fuelPercent, count: fuelCount, protein_hit: proteinHit, calories_hit: caloriesHit, hydration_hit: hydrationHit },
        recover: { percent: recoverPercent, count: recoverCount, sleep_hit: sleepHoursHit, quality_hit: sleepQualHit, recovery_hit: recoveryHit },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  GET DAILY PLAN BY ID
// ══════════════════════════════════════════════════════════════════

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM daily_plans WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Daily plan not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  GET PLAN-VS-ACTUAL REVIEW (for coaching)
// ══════════════════════════════════════════════════════════════════

router.get('/:id/review', async (req, res) => {
  try {
    const { rows: planRows } = await query('SELECT * FROM daily_plans WHERE id = $1', [req.params.id]);
    if (!planRows.length) return res.status(404).json({ error: 'Daily plan not found' });

    const plan = planRows[0];
    const date = plan.plan_date;

    const [workoutsR, mealsR, ctxR, coachingR, injuriesR] = await Promise.all([
      query('SELECT * FROM workouts WHERE workout_date = $1 ORDER BY created_at', [date]),
      query('SELECT * FROM meals WHERE meal_date = $1 ORDER BY meal_time ASC NULLS LAST', [date]),
      query('SELECT * FROM daily_context WHERE date = $1', [date]),
      query('SELECT * FROM coaching_sessions WHERE (session_date = $1 OR daily_plan_id = $2) ORDER BY created_at DESC', [date, plan.id]),
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') AND (onset_date IS NULL OR onset_date <= $1) AND (resolved_date IS NULL OR resolved_date >= $1)`, [date]),
    ]);

    const workouts = workoutsR.rows;
    const meals = mealsR.rows;
    const ctx = ctxR.rows[0] || {};
    const maxEffort = Math.max(0, ...workouts.map(w => w.effort || 0));
    const totalCal = meals.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
    const totalProtein = meals.reduce((s, m) => s + (parseFloat(m.protein_g) || 0), 0);

    res.json({
      plan,
      actual: {
        workouts,
        meals,
        nutrition_context: ctx,
        active_injuries: injuriesR.rows,
      },
      summary: {
        workout_completed: workouts.length > 0,
        workout_type_match: workouts.some(w => w.workout_type === plan.workout_type),
        effort_actual: maxEffort,
        effort_target: plan.target_effort,
        effort_percent: plan.target_effort ? Math.min(100, Math.round((maxEffort / plan.target_effort) * 100)) : null,
        calories_actual: Math.round(totalCal),
        calories_target: plan.target_calories ? parseFloat(plan.target_calories) : null,
        protein_actual: Math.round(totalProtein),
        protein_target: plan.target_protein_g ? parseFloat(plan.target_protein_g) : null,
        hydration_actual: parseFloat(ctx.hydration_liters) || 0,
        hydration_target: plan.target_hydration_liters ? parseFloat(plan.target_hydration_liters) : null,
        sleep_actual: parseFloat(ctx.sleep_hours) || 0,
        sleep_target: plan.target_sleep_hours ? parseFloat(plan.target_sleep_hours) : null,
        sleep_quality: parseInt(ctx.sleep_quality) || null,
        recovery_rating: parseInt(ctx.recovery_rating) || null,
        energy_rating: parseInt(ctx.energy_rating) || null,
      },
      coaching_sessions: coachingR.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  CREATE SINGLE DAILY PLAN
// ══════════════════════════════════════════════════════════════════

router.post('/', async (req, res) => {
  try {
    if (!req.body.plan_date) return res.status(400).json({ error: 'plan_date is required' });

    const cols = [];
    const vals = [];
    const placeholders = [];
    let i = 1;

    for (const field of WRITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        cols.push(field);
        vals.push(field === 'tags' || field === 'metadata' ? JSON.stringify(req.body[field]) : req.body[field]);
        placeholders.push(`$${i++}`);
      }
    }

    const { rows } = await query(
      `INSERT INTO daily_plans (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals
    );

    await logActivity('daily_plan_created', 'daily_plan', rows[0].id, null,
      `Daily plan for ${rows[0].plan_date}: ${rows[0].workout_type || rows[0].status || 'planned'}`);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A daily plan already exists for this date. Use PUT to amend it.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  CREATE WEEKLY PLANS (7 daily plans at once)
// ══════════════════════════════════════════════════════════════════

router.post('/week', async (req, res) => {
  try {
    const { start_date, days } = req.body;
    if (!start_date) return res.status(400).json({ error: 'start_date is required' });
    if (!days || !Array.isArray(days) || days.length < 1 || days.length > 7) {
      return res.status(400).json({ error: 'days must be an array of 1-7 daily plan objects' });
    }

    const results = [];
    const errors = [];

    for (let d = 0; d < days.length; d++) {
      const dayDate = new Date(start_date);
      dayDate.setDate(dayDate.getDate() + d);
      const dateStr = dayDate.toISOString().split('T')[0];

      const dayPlan = { ...days[d], plan_date: dateStr };
      const cols = [];
      const vals = [];
      const placeholders = [];
      let i = 1;

      for (const field of WRITABLE_FIELDS) {
        if (dayPlan[field] !== undefined) {
          cols.push(field);
          vals.push(field === 'tags' || field === 'metadata' ? JSON.stringify(dayPlan[field]) : dayPlan[field]);
          placeholders.push(`$${i++}`);
        }
      }

      try {
        const { rows } = await query(
          `INSERT INTO daily_plans (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
           ON CONFLICT (plan_date) DO UPDATE SET ${cols.map((c, idx) => `${c} = $${idx + 1}`).join(', ')}, updated_at = NOW()
           RETURNING *`,
          vals
        );
        results.push(rows[0]);
      } catch (e) {
        errors.push({ date: dateStr, error: e.message });
      }
    }

    await logActivity('weekly_plan_created', 'daily_plan', null, null,
      `Weekly plan: ${start_date} to ${results[results.length - 1]?.plan_date || 'N/A'} (${results.length} days)`);

    res.status(201).json({ created: results.length, errors: errors.length, plans: results, errors_detail: errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  UPDATE (AMEND) DAILY PLAN
// ══════════════════════════════════════════════════════════════════

router.put('/:id', async (req, res) => {
  try {
    const fields = [];
    const vals = [];
    let i = 1;

    for (const field of WRITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = $${i++}`);
        vals.push(field === 'tags' || field === 'metadata' ? JSON.stringify(req.body[field]) : req.body[field]);
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    fields.push('updated_at = NOW()');
    vals.push(req.params.id);

    const { rows } = await query(
      `UPDATE daily_plans SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );

    if (!rows.length) return res.status(404).json({ error: 'Daily plan not found' });

    await logActivity('daily_plan_updated', 'daily_plan', rows[0].id, null,
      `Amended plan for ${rows[0].plan_date}`);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  DELETE DAILY PLAN
// ══════════════════════════════════════════════════════════════════

router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await query('DELETE FROM daily_plans WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Daily plan not found' });

    await logActivity('daily_plan_deleted', 'daily_plan', rows[0].id, null,
      `Deleted plan for ${rows[0].plan_date}`);

    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (migrate-from-training-plans route removed — training_plans table dropped)

module.exports = router;
