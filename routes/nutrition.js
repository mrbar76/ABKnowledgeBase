const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

function num(val) { if (val == null || val === '') return null; const n = Number(val); return isNaN(n) ? null : n; }
function int(val) { if (val == null || val === '') return null; const n = Number(val); return isNaN(n) ? null : Math.round(n); }

// Column registry: kind drives parsing + validation. Subjective 1-10 fields
// were added in M.2 to support the morning-check-in Skill.
const DC_COLS = {
  date:               { kind: 'text', required: true },
  sleep_hours:        { kind: 'num', range: [0, 24] },
  sleep_quality:      { kind: 'int', range: [1, 10] },
  hydration_liters:   { kind: 'num', range: [0, 20] },
  mood:               { kind: 'int', range: [1, 10] },
  motivation:         { kind: 'int', range: [1, 10] },
  soreness_overall:   { kind: 'int', range: [1, 10] },
  soreness_areas:     { kind: 'json' },
  life_stress:        { kind: 'int', range: [1, 10] },
  illness_flag:       { kind: 'enum', values: ['none','onset','active','resolving'] },
  travel_status:      { kind: 'text' },
  bedtime_self_report:{ kind: 'text' },
  notes:              { kind: 'text' },
};

function castDc(key, val) {
  const spec = DC_COLS[key];
  if (!spec) return undefined;
  if (val == null || val === '') return null;
  if (spec.kind === 'num') return num(val);
  if (spec.kind === 'int') return int(val);
  if (spec.kind === 'json') return JSON.stringify(val);
  if (spec.kind === 'enum') return spec.values.includes(val) ? val : null;
  return val;
}

function validateContext(b) {
  const errors = [];
  if (!b.date) errors.push('date is required');
  for (const [key, spec] of Object.entries(DC_COLS)) {
    if (b[key] == null || b[key] === '') continue;
    if (spec.kind === 'num' || spec.kind === 'int') {
      const v = Number(b[key]);
      if (isNaN(v)) { errors.push(`${key} must be numeric`); continue; }
      if (spec.kind === 'int' && !Number.isInteger(v)) errors.push(`${key} must be an integer`);
      if (spec.range && (v < spec.range[0] || v > spec.range[1])) errors.push(`${key} must be ${spec.range[0]}-${spec.range[1]}`);
    } else if (spec.kind === 'enum' && !spec.values.includes(b[key])) {
      errors.push(`${key} must be one of: ${spec.values.join(', ')}`);
    }
  }
  return errors;
}

// ═══════════════════════════════════════════════════════════════
// DAILY CONTEXT — non-meal day-level data
// ═══════════════════════════════════════════════════════════════

// ─── Get daily context (by date or list) ─────────────────────
router.get('/daily-context', async (req, res) => {
  try {
    const { date, since, before, limit = 50, offset = 0 } = req.query;

    // Single date lookup
    if (date) {
      const result = await query('SELECT * FROM daily_context WHERE date = $1', [date]);
      return res.json(result.rows[0] || null);
    }

    // List with optional date range
    const params = [];
    const where = [];
    let i = 1;
    if (since) { where.push(`date >= $${i++}`); params.push(since); }
    if (before) { where.push(`date < $${i++}`); params.push(before); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(Number(limit), Number(offset));
    const countResult = await query(`SELECT COUNT(*) as total FROM daily_context ${whereClause}`, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM daily_context ${whereClause} ORDER BY date DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, contexts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single context by ID ────────────────────────────────
router.get('/daily-context/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM daily_context WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upsert daily context ────────────────────────────────────
// POST is upsert-on-date: morning-check-in Skill calls this repeatedly as
// the user answers questions. Each call only writes the keys that were
// passed; existing values for other keys are preserved via COALESCE.
router.post('/daily-context', async (req, res) => {
  try {
    const b = req.body;
    const errors = validateContext(b);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const cols = ['date'];
    const values = [b.date];
    for (const key of Object.keys(DC_COLS)) {
      if (key === 'date') continue;
      if (b[key] === undefined) continue;
      cols.push(key);
      values.push(castDc(key, b[key]));
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updateClauses = cols
      .filter(c => c !== 'date')
      .map(c => `${c} = COALESCE(EXCLUDED.${c}, daily_context.${c})`)
      .concat(['updated_at = NOW()']);

    const sql = `
      INSERT INTO daily_context (${cols.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (date) DO UPDATE SET ${updateClauses.join(', ')}
      RETURNING *`;

    const result = await query(sql, values);
    await logActivity('upsert', 'daily_context', result.rows[0].id, 'manual', `Daily context: ${b.date}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH daily context (by id) ─────────────────────────────
router.patch('/daily-context/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    for (const key of Object.keys(DC_COLS)) {
      if (b[key] === undefined) continue;
      const val = castDc(key, b[key]);
      fields.push(`${key} = $${i++}`);
      params.push(val);
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE daily_context SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'daily_context', req.params.id, 'manual', 'Updated daily context');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete daily context ────────────────────────────────────
router.delete('/daily-context/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM daily_context WHERE id = $1 RETURNING id, date', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'daily_context', req.params.id, 'manual', `Deleted context: ${result.rows[0].date}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DAILY SUMMARY — computed from meals, merged with context
// ═══════════════════════════════════════════════════════════════

const HARD_TYPES = new Set(['hill','hybrid','ruck','hiit','crossfit','boxing','race']);
const MOD_TYPES  = new Set(['strength','run','cycling','swim','rowing','class','hike']);

function classifyWorkoutType(type) {
  const t = (type || '').toLowerCase().trim();
  if (HARD_TYPES.has(t)) return 'hard';
  if (MOD_TYPES.has(t)) return 'moderate';
  return 'rest';
}

const TIER_RANK = { hard: 3, moderate: 2, rest: 1 };

function classifyIntensity(dayType, workouts, planStructure, targetDate) {
  // Priority 1: actual workouts logged
  if (workouts && workouts.length > 0) {
    let best = 'rest';
    for (const w of workouts) {
      const tier = classifyWorkoutType(w.workout_type);
      if (TIER_RANK[tier] > TIER_RANK[best]) best = tier;
    }
    return { intensity_tier: best, intensity_source: 'workout', planned_type: workouts[0].workout_type };
  }

  // Priority 2: training plan weekly_structure
  if (planStructure && planStructure.length > 0) {
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dow = dayNames[new Date(targetDate + 'T12:00:00').getDay()].toLowerCase();
    const match = planStructure.find(d => (d.day || d.name || '').toLowerCase().startsWith(dow));
    if (match && match.type) {
      const tier = classifyWorkoutType(match.type);
      return { intensity_tier: tier, intensity_source: 'plan', planned_type: match.type };
    }
  }

  // Priority 3: manual day_type from context
  if (dayType) {
    const tier = classifyWorkoutType(dayType);
    return { intensity_tier: tier, intensity_source: 'context', planned_type: dayType };
  }

  // Default
  return { intensity_tier: 'moderate', intensity_source: 'default', planned_type: null };
}

async function buildDailySummary(targetDate) {
  const [mealsResult, contextResult, workoutsResult] = await Promise.all([
    query(
      `SELECT * FROM meals WHERE meal_date = $1 ORDER BY meal_time ASC NULLS LAST, created_at ASC`,
      [targetDate]
    ),
    query(
      `SELECT * FROM daily_context WHERE date = $1`,
      [targetDate]
    ),
    query(
      `SELECT workout_type, effort FROM workouts WHERE workout_date = $1`,
      [targetDate]
    ),
  ]);

  const meals = mealsResult.rows;
  const context = contextResult.rows[0] || null;
  const workouts = workoutsResult.rows;

  const intensity = classifyIntensity(
    null, // day_type removed
    workouts,
    null,
    targetDate
  );

  // Aggregate macros from meals
  const totals = {
    total_meals: meals.length,
    total_calories: 0,
    total_protein_g: 0,
    total_carbs_g: 0,
    total_fat_g: 0,
    total_fiber_g: 0,
    total_sugar_g: 0,
    total_sodium_mg: 0,
  };

  for (const m of meals) {
    if (m.calories) totals.total_calories += Number(m.calories);
    if (m.protein_g) totals.total_protein_g += Number(m.protein_g);
    if (m.carbs_g) totals.total_carbs_g += Number(m.carbs_g);
    if (m.fat_g) totals.total_fat_g += Number(m.fat_g);
    if (m.fiber_g) totals.total_fiber_g += Number(m.fiber_g);
    if (m.sugar_g) totals.total_sugar_g += Number(m.sugar_g);
    if (m.sodium_mg) totals.total_sodium_mg += Number(m.sodium_mg);
  }

  // Round totals
  for (const k of Object.keys(totals)) {
    if (k !== 'total_meals') totals[k] = Math.round(totals[k] * 10) / 10;
  }

  return {
    date: targetDate,
    ...totals,
    ...intensity,
    workouts_today: workouts,
    context: context ? {
      id: context.id,
      sleep_hours: context.sleep_hours,
      sleep_quality: context.sleep_quality,
      hydration_liters: context.hydration_liters,
      notes: context.notes,
    } : null,
    meals,
  };
}

// ─── Daily summary for a single date ─────────────────────────
router.get('/daily-summary', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date parameter is required' });
    const summary = await buildDailySummary(date);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Daily summary for a date range ──────────────────────────
router.get('/daily-summary/range', async (req, res) => {
  try {
    const { since, before } = req.query;
    if (!since || !before) return res.status(400).json({ error: 'since and before parameters are required' });

    // Get all distinct dates that have meals or context in the range
    const datesResult = await query(
      `SELECT DISTINCT d::date as date FROM (
        SELECT meal_date as d FROM meals WHERE meal_date >= $1 AND meal_date < $2
        UNION
        SELECT date as d FROM daily_context WHERE date >= $1 AND date < $2
      ) sub ORDER BY date ASC`,
      [since, before]
    );

    const summaries = [];
    for (const row of datesResult.rows) {
      summaries.push(await buildDailySummary(row.date.toISOString().slice(0, 10)));
    }

    // Compute range totals
    const rangeTotals = {
      days: summaries.length,
      total_calories: 0,
      total_protein_g: 0,
      total_carbs_g: 0,
      total_fat_g: 0,
      total_meals: 0,
    };
    for (const s of summaries) {
      rangeTotals.total_calories += s.total_calories;
      rangeTotals.total_protein_g += s.total_protein_g;
      rangeTotals.total_carbs_g += s.total_carbs_g;
      rangeTotals.total_fat_g += s.total_fat_g;
      rangeTotals.total_meals += s.total_meals;
    }
    if (rangeTotals.days > 0) {
      rangeTotals.avg_daily_calories = Math.round(rangeTotals.total_calories / rangeTotals.days);
      rangeTotals.avg_daily_protein_g = Math.round(rangeTotals.total_protein_g / rangeTotals.days * 10) / 10;
    }

    res.json({ since, before, range_totals: rangeTotals, daily: summaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
