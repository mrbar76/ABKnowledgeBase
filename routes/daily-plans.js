const express = require('express');
const { query, logActivity } = require('../db');
const { pushPlanToHevy, syncHevyWorkouts } = require('./hevy');
const { buildSegmentsFromExercises, inferLoggingTarget } = require('../utils/exerciseTaxonomy');
const router = express.Router();

// Fire-and-forget Hevy push on plan create/update. Never blocks the
// response. Silently no-ops when HEVY_API_KEY isn't set, when
// workout_type isn't pushable, or when no resolvable exercises exist.
function autoPushToHevy(planRow) {
  if (!planRow) return;
  Promise.resolve()
    .then(() => pushPlanToHevy(planRow))
    .then(r => {
      if (r?.ok) console.log(`[auto-hevy-push] plan ${planRow.id} → routine ${r.hevy_routine?.id || r.hevy_routine?.routine?.id || 'updated'}`);
      else if (r?.skipped) console.log(`[auto-hevy-push] plan ${planRow.id} skipped: ${r.skipped}`);
    })
    .catch(err => console.error(`[auto-hevy-push] plan ${planRow.id} failed: ${err.message}`));
}

// Segment writable fields. The Coach (or UI) can supply these directly
// inside the `segments` array on POST/PUT; we also auto-derive from
// flat planned_exercises for backwards compatibility.
const SEGMENT_FIELDS = [
  'block_order', 'block_label', 'logging_target', 'planned_exercises',
  'target_duration_min', 'target_effort', 'time_window_start', 'time_window_end',
  'hevy_routine_id', 'status', 'notes',
];
const SEGMENT_JSONB = new Set(['planned_exercises']);

// Replace all segments for a plan with the supplied list. Idempotent.
// Each segment in the input may carry an `id` to preserve identity (so
// hevy_routine_id stays attached on update). If `segments` is empty
// and `legacyPlannedExercises` is non-empty, synth segments via the
// taxonomy helper so legacy callers still work.
async function syncSegmentsForPlan(planId, segments, legacyPlannedExercises, defaultWorkoutType) {
  let working = Array.isArray(segments) && segments.length > 0
    ? segments
    : (Array.isArray(legacyPlannedExercises) && legacyPlannedExercises.length > 0
        ? buildSegmentsFromExercises(legacyPlannedExercises, defaultWorkoutType)
        : []);

  if (working.length === 0) {
    // Nothing to write; leave existing segments alone (callers update
    // metadata only). Return current state.
    const { rows } = await query(
      `SELECT * FROM plan_segments WHERE daily_plan_id = $1 ORDER BY block_order`,
      [planId]
    );
    return rows;
  }

  // Normalize: assign block_order if missing, fill logging_target.
  working = working.map((seg, idx) => {
    const block_label = String(seg.block_label || 'strength').toLowerCase();
    const logging_target = seg.logging_target ||
      (Array.isArray(seg.planned_exercises) && seg.planned_exercises[0]
        ? inferLoggingTarget(seg.planned_exercises[0].name || seg.planned_exercises[0].title || '', block_label)
        : 'manual');
    return {
      ...seg,
      block_label,
      logging_target,
      block_order: seg.block_order ?? idx,
      status: seg.status || 'planned',
    };
  });

  // Strategy: fetch existing segments, match by id when supplied or by
  // (block_order, block_label) when not. Insert new, update matched,
  // delete unmatched. Preserves hevy_routine_id when block_order +
  // block_label survive across updates.
  const existingR = await query(
    `SELECT * FROM plan_segments WHERE daily_plan_id = $1`,
    [planId]
  );
  const existing = existingR.rows;
  const seenIds = new Set();
  const written = [];

  for (const seg of working) {
    let match = null;
    if (seg.id) match = existing.find(e => e.id === seg.id);
    if (!match) match = existing.find(e =>
      e.block_order === seg.block_order && e.block_label === seg.block_label && !seenIds.has(e.id)
    );

    if (match) {
      seenIds.add(match.id);
      const fields = [];
      const vals = [];
      let i = 1;
      for (const field of SEGMENT_FIELDS) {
        if (seg[field] === undefined) continue;
        fields.push(SEGMENT_JSONB.has(field) ? `${field} = $${i++}::jsonb` : `${field} = $${i++}`);
        vals.push(SEGMENT_JSONB.has(field) ? JSON.stringify(seg[field]) : seg[field]);
      }
      if (fields.length === 0) {
        written.push(match);
        continue;
      }
      fields.push('updated_at = NOW()');
      vals.push(match.id);
      const { rows } = await query(
        `UPDATE plan_segments SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        vals
      );
      written.push(rows[0]);
    } else {
      const cols = ['daily_plan_id'];
      const vals = [planId];
      const placeholders = ['$1'];
      let i = 2;
      for (const field of SEGMENT_FIELDS) {
        if (seg[field] === undefined) continue;
        cols.push(field);
        vals.push(SEGMENT_JSONB.has(field) ? JSON.stringify(seg[field]) : seg[field]);
        placeholders.push(SEGMENT_JSONB.has(field) ? `$${i++}::jsonb` : `$${i++}`);
      }
      const { rows } = await query(
        `INSERT INTO plan_segments (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        vals
      );
      written.push(rows[0]);
    }
  }

  // Delete segments that weren't kept.
  const writtenIds = new Set(written.map(s => s.id));
  for (const ex of existing) {
    if (!writtenIds.has(ex.id)) {
      await query(`DELETE FROM plan_segments WHERE id = $1`, [ex.id]);
    }
  }

  return written.sort((a, b) => a.block_order - b.block_order);
}

async function loadSegments(planId) {
  const { rows } = await query(
    `SELECT ps.*, COALESCE(
       (SELECT json_agg(w.* ORDER BY w.started_at NULLS LAST, w.created_at)
        FROM workouts w WHERE w.plan_segment_id = ps.id), '[]'::json
     ) AS workouts
     FROM plan_segments ps
     WHERE ps.daily_plan_id = $1
     ORDER BY ps.block_order`,
    [planId]
  );
  return rows;
}

// Writable fields for daily_plans
const WRITABLE_FIELDS = [
  'plan_date', 'status', 'title', 'goal',
  'workout_type', 'workout_focus', 'target_effort', 'target_duration_min', 'workout_notes',
  'planned_exercises', 'actual_exercises', 'completion_notes',
  'target_calories', 'target_protein_g', 'target_carbs_g', 'target_fat_g', 'target_hydration_liters',
  'target_sleep_hours', 'recovery_notes',
  'coaching_notes', 'rationale', 'tags', 'ai_source', 'metadata',
];

const JSONB_FIELDS = new Set(['planned_exercises', 'actual_exercises', 'tags', 'metadata']);

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
    const segments = plan ? await loadSegments(plan.id) : [];
    if (plan) plan.segments = segments;
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
    const plan = rows[0];
    plan.segments = await loadSegments(plan.id);
    res.json(plan);
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

    // Workouts: prefer FK match (daily_plan_id) and fall back to date
    // for legacy rows that haven't been backfilled. Coaching sessions
    // already use FK with date fallback.
    const [workoutsR, mealsR, ctxR, coachingR, injuriesR] = await Promise.all([
      query(
        `SELECT * FROM workouts
         WHERE daily_plan_id = $1
            OR (daily_plan_id IS NULL AND workout_date = $2)
         ORDER BY started_at NULLS LAST, created_at`,
        [plan.id, date]
      ),
      query('SELECT * FROM meals WHERE meal_date = $1 ORDER BY meal_time ASC NULLS LAST', [date]),
      query('SELECT * FROM daily_context WHERE date = $1', [date]),
      query('SELECT * FROM coaching_sessions WHERE (session_date = $1 OR daily_plan_id = $2) ORDER BY created_at DESC', [date, plan.id]),
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') AND (onset_date IS NULL OR onset_date <= $1) AND (resolved_date IS NULL OR resolved_date >= $1)`, [date]),
    ]);

    const segments = await loadSegments(plan.id);
    plan.segments = segments;

    const workouts = workoutsR.rows;
    const meals = mealsR.rows;
    const ctx = ctxR.rows[0] || {};
    const maxEffort = Math.max(0, ...workouts.map(w => w.effort || 0));
    const totalCal = meals.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
    const totalProtein = meals.reduce((s, m) => s + (parseFloat(m.protein_g) || 0), 0);

    // Per-segment plan-vs-actual: which segments have logged workouts,
    // which are still 'planned'. Built from segments + workouts, so it
    // survives cross-day moves and multi-session days cleanly.
    const segmentDiffs = segments.map(seg => {
      const segWorkouts = (seg.workouts || []).filter(Boolean);
      const completed = segWorkouts.length > 0 || seg.status === 'completed';
      const segEffort = Math.max(0, ...segWorkouts.map(w => w.effort || 0));
      const segDuration = segWorkouts.reduce((s, w) => {
        if (!w.time_duration) return s;
        const parts = String(w.time_duration).split(':').map(n => Number(n) || 0);
        const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : Number(w.time_duration) || 0;
        return s + secs;
      }, 0);
      return {
        segment_id: seg.id,
        block_label: seg.block_label,
        logging_target: seg.logging_target,
        status: completed ? 'completed' : (seg.status === 'skipped' ? 'skipped' : 'planned'),
        target_effort: seg.target_effort,
        target_duration_min: seg.target_duration_min,
        actual_effort: segEffort || null,
        actual_duration_min: segDuration ? Math.round(segDuration / 60) : null,
        workout_count: segWorkouts.length,
        workouts: segWorkouts.map(w => ({
          id: w.id, title: w.title, source: w.source,
          effort: w.effort, time_duration: w.time_duration,
          distance: w.distance, hr_avg: w.hr_avg, body_notes: w.body_notes,
        })),
      };
    });

    res.json({
      plan,
      actual: {
        workouts,
        meals,
        nutrition_context: ctx,
        active_injuries: injuriesR.rows,
      },
      segment_diffs: segmentDiffs,
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
        vals.push(JSONB_FIELDS.has(field) ? JSON.stringify(req.body[field]) : req.body[field]);
        placeholders.push(JSONB_FIELDS.has(field) ? `$${i++}::jsonb` : `$${i++}`);
      }
    }

    const { rows } = await query(
      `INSERT INTO daily_plans (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals
    );

    const plan = rows[0];
    plan.segments = await syncSegmentsForPlan(
      plan.id,
      req.body.segments,
      req.body.planned_exercises,
      plan.workout_type
    );

    await logActivity('daily_plan_created', 'daily_plan', plan.id, null,
      `Daily plan for ${plan.plan_date}: ${plan.workout_type || plan.status || 'planned'}`);

    autoPushToHevy(plan);
    res.status(201).json(plan);
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
          vals.push(JSONB_FIELDS.has(field) ? JSON.stringify(dayPlan[field]) : dayPlan[field]);
          placeholders.push(JSONB_FIELDS.has(field) ? `$${i++}::jsonb` : `$${i++}`);
        }
      }

      try {
        const { rows } = await query(
          `INSERT INTO daily_plans (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
           ON CONFLICT (plan_date) DO UPDATE SET ${cols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = NOW()
           RETURNING *`,
          vals
        );
        const planRow = rows[0];
        planRow.segments = await syncSegmentsForPlan(
          planRow.id,
          dayPlan.segments,
          dayPlan.planned_exercises,
          planRow.workout_type
        );
        results.push(planRow);
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
        fields.push(JSONB_FIELDS.has(field) ? `${field} = $${i++}::jsonb` : `${field} = $${i++}`);
        vals.push(JSONB_FIELDS.has(field) ? JSON.stringify(req.body[field]) : req.body[field]);
      }
    }

    const segmentsSupplied = req.body.segments !== undefined || req.body.planned_exercises !== undefined;
    if (!fields.length && !segmentsSupplied) return res.status(400).json({ error: 'No fields to update' });

    let plan;
    if (fields.length) {
      fields.push('updated_at = NOW()');
      vals.push(req.params.id);
      const { rows } = await query(
        `UPDATE daily_plans SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        vals
      );
      if (!rows.length) return res.status(404).json({ error: 'Daily plan not found' });
      plan = rows[0];
    } else {
      const { rows } = await query(`SELECT * FROM daily_plans WHERE id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Daily plan not found' });
      plan = rows[0];
    }

    if (segmentsSupplied) {
      plan.segments = await syncSegmentsForPlan(
        plan.id,
        req.body.segments,
        req.body.planned_exercises,
        plan.workout_type
      );
    } else {
      plan.segments = await loadSegments(plan.id);
    }

    await logActivity('daily_plan_updated', 'daily_plan', plan.id, null,
      `Amended plan for ${plan.plan_date}`);

    autoPushToHevy(plan);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  WRAP DAY — sync Hevy, auto-link actuals, flip status to completed
// ══════════════════════════════════════════════════════════════════
//
// Idempotent. Safe to call from the "Wrap Day" UI button AND the
// end-of-day-review skill. Returns the unified payload (plan + segments
// with actuals + summary) for the client to render the diff.

router.post('/:id/wrap', async (req, res) => {
  try {
    const { rows: planRows } = await query('SELECT * FROM daily_plans WHERE id = $1', [req.params.id]);
    if (!planRows.length) return res.status(404).json({ error: 'Daily plan not found' });
    const plan = planRows[0];

    // Step 1: pull recent Hevy workouts so anything logged at the gym
    // lands in `workouts` before we mark up the day. Best-effort — if
    // Hevy is down we still wrap. Returns { ok, inserted, skipped }.
    let hevySync = null;
    try {
      if (typeof syncHevyWorkouts === 'function') {
        const since = new Date(plan.plan_date);
        since.setDate(since.getDate() - 1);
        hevySync = await syncHevyWorkouts(since.toISOString().slice(0, 10));
      }
    } catch (err) {
      hevySync = { ok: false, error: err.message };
    }

    // Step 2: auto-link any same-date workouts that don't have a
    // daily_plan_id yet (manual or HAE rows that arrived before this
    // plan existed). Then attach to the first segment of the right
    // logging_target so per-segment status rolls up.
    await query(
      `UPDATE workouts SET daily_plan_id = $1
       WHERE workout_date = $2 AND daily_plan_id IS NULL`,
      [plan.id, plan.plan_date]
    );

    // For each segment, link orphan workouts of the matching source.
    const { rows: segs } = await query(
      `SELECT * FROM plan_segments WHERE daily_plan_id = $1 ORDER BY block_order`,
      [plan.id]
    );
    for (const seg of segs) {
      const sourceMatch = seg.logging_target === 'hevy' ? 'hevy'
        : seg.logging_target === 'apple_health' ? 'apple_health'
        : 'manual';
      await query(
        `UPDATE workouts
         SET plan_segment_id = $1
         WHERE daily_plan_id = $2
           AND plan_segment_id IS NULL
           AND (source = $3 OR source IS NULL)`,
        [seg.id, plan.id, sourceMatch]
      );
    }

    // Step 3: roll up segment statuses. Any segment with at least one
    // linked workout → completed. Anything left 'planned' → 'skipped'.
    await query(
      `UPDATE plan_segments ps
       SET status = 'completed', updated_at = NOW()
       WHERE ps.daily_plan_id = $1
         AND EXISTS (SELECT 1 FROM workouts w WHERE w.plan_segment_id = ps.id)
         AND ps.status IN ('planned','in_progress')`,
      [plan.id]
    );
    await query(
      `UPDATE plan_segments
       SET status = 'skipped', updated_at = NOW()
       WHERE daily_plan_id = $1
         AND status IN ('planned','in_progress')`,
      [plan.id]
    );

    // Step 4: flip the plan's status. Idempotent — only flips if not
    // already 'completed'.
    await query(
      `UPDATE daily_plans SET status = 'completed', updated_at = NOW() WHERE id = $1 AND status <> 'completed'`,
      [plan.id]
    );

    await logActivity('daily_plan_wrapped', 'daily_plan', plan.id, null,
      `Day wrapped for ${plan.plan_date}`);

    // Step 5: return the same shape as /:id/review so the client renders
    // the diff in one card.
    const reviewReq = { params: { id: plan.id } };
    let reviewBody = null;
    const captureRes = {
      json: (b) => { reviewBody = b; },
      status: () => captureRes,
    };
    // Reuse the review handler logic by re-querying directly here so
    // we don't recursively invoke the route.
    const refreshed = (await query('SELECT * FROM daily_plans WHERE id = $1', [plan.id])).rows[0];
    refreshed.segments = await loadSegments(refreshed.id);
    res.json({
      ok: true,
      plan: refreshed,
      hevy_sync: hevySync,
    });
  } catch (err) {
    console.error(`[daily-plans/wrap] ${err.stack}`);
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
