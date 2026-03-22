const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const DAY_TYPES = ['rest', 'strength', 'run', 'hill', 'hybrid', 'race', 'travel'];

function num(val) { if (val == null || val === '') return null; const n = Number(val); return isNaN(n) ? null : n; }
function int(val) { if (val == null || val === '') return null; const n = Number(val); return isNaN(n) ? null : Math.round(n); }

function validateContext(b) {
  const errors = [];
  if (!b.date) errors.push('date is required');
  if (b.day_type && !DAY_TYPES.includes(b.day_type)) errors.push(`day_type must be one of: ${DAY_TYPES.join(', ')}`);
  for (const f of ['energy_rating', 'hunger_rating']) {
    if (b[f] != null && b[f] !== '') {
      const v = Number(b[f]);
      if (!Number.isInteger(v) || v < 1 || v > 10) errors.push(`${f} must be an integer 1-10`);
    }
  }
  if (b.hydration_liters != null && b.hydration_liters !== '' && (isNaN(Number(b.hydration_liters)) || Number(b.hydration_liters) < 0)) {
    errors.push('hydration_liters must be a non-negative number');
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
      const result = await query('SELECT * FROM daily_nutrition_context WHERE date = $1', [date]);
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
    const countResult = await query(`SELECT COUNT(*) as total FROM daily_nutrition_context ${whereClause}`, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM daily_nutrition_context ${whereClause} ORDER BY date DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, contexts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single context by ID ────────────────────────────────
router.get('/daily-context/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM daily_nutrition_context WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create daily context ────────────────────────────────────
router.post('/daily-context', async (req, res) => {
  try {
    const b = req.body;
    const errors = validateContext(b);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const result = await query(
      `INSERT INTO daily_nutrition_context (
        date, day_type, hydration_liters, energy_rating, hunger_rating,
        cravings, digestion, notes, tags
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        b.date,
        b.day_type || null,
        num(b.hydration_liters),
        int(b.energy_rating),
        int(b.hunger_rating),
        b.cravings || null,
        b.digestion || null,
        b.notes || null,
        JSON.stringify(b.tags || []),
      ]
    );

    await logActivity('create', 'daily_nutrition_context', result.rows[0].id, 'manual', `Daily context: ${b.date}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    // Handle unique constraint on date
    if (err.code === '23505') {
      return res.status(409).json({ error: `Daily context for ${req.body.date} already exists. Use PATCH to update.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── Update daily context ────────────────────────────────────
router.patch('/daily-context/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'date', 'day_type', 'hydration_liters', 'energy_rating', 'hunger_rating',
      'cravings', 'digestion', 'notes', 'tags',
    ];
    const numericFields = ['hydration_liters'];
    const intFields = ['energy_rating', 'hunger_rating'];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (key === 'tags') {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else if (numericFields.includes(key)) {
          fields.push(`${key} = $${i++}`);
          params.push(num(b[key]));
        } else if (intFields.includes(key)) {
          fields.push(`${key} = $${i++}`);
          params.push(int(b[key]));
        } else {
          fields.push(`${key} = $${i++}`);
          params.push(b[key]);
        }
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE daily_nutrition_context SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'daily_nutrition_context', req.params.id, 'manual', 'Updated daily context');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete daily context ────────────────────────────────────
router.delete('/daily-context/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM daily_nutrition_context WHERE id = $1 RETURNING id, date', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'daily_nutrition_context', req.params.id, 'manual', `Deleted context: ${result.rows[0].date}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// DAILY SUMMARY — computed from meals, merged with context
// ═══════════════════════════════════════════════════════════════

async function buildDailySummary(targetDate) {
  const [mealsResult, contextResult] = await Promise.all([
    query(
      `SELECT * FROM meals WHERE meal_date = $1 ORDER BY meal_time ASC NULLS LAST, created_at ASC`,
      [targetDate]
    ),
    query(
      `SELECT * FROM daily_nutrition_context WHERE date = $1`,
      [targetDate]
    ),
  ]);

  const meals = mealsResult.rows;
  const context = contextResult.rows[0] || null;

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
    context: context ? {
      id: context.id,
      day_type: context.day_type,
      hydration_liters: context.hydration_liters,
      energy_rating: context.energy_rating,
      hunger_rating: context.hunger_rating,
      cravings: context.cravings,
      digestion: context.digestion,
      notes: context.notes,
      tags: context.tags,
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
        SELECT date as d FROM daily_nutrition_context WHERE date >= $1 AND date < $2
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
