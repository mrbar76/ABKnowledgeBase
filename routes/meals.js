const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'pre-workout', 'post-workout', 'drink', 'supplement', 'meal'];

function validateMeal(b) {
  const errors = [];
  if (!b.title) errors.push('title is required');
  if (!b.meal_date) errors.push('meal_date is required');
  if (b.calories != null && (isNaN(Number(b.calories)) || Number(b.calories) < 0)) errors.push('calories must be a non-negative number');
  for (const f of ['protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g']) {
    if (b[f] != null && b[f] !== '' && (isNaN(Number(b[f])) || Number(b[f]) < 0)) errors.push(`${f} must be a non-negative number`);
  }
  if (b.sodium_mg != null && b.sodium_mg !== '' && (isNaN(Number(b.sodium_mg)) || Number(b.sodium_mg) < 0)) errors.push('sodium_mg must be a non-negative number');
  for (const f of ['hunger_before', 'fullness_after', 'energy_after']) {
    if (b[f] != null && b[f] !== '') {
      const v = Number(b[f]);
      if (!Number.isInteger(v) || v < 1 || v > 10) errors.push(`${f} must be an integer 1-10`);
    }
  }
  if (b.meal_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(b.meal_time)) {
    errors.push('meal_time must be HH:MM or HH:MM:SS');
  }
  return errors;
}

function num(val) { if (val == null || val === '') return null; const n = Number(val); return isNaN(n) ? null : n; }
function int(val) { if (val == null || val === '') return null; const n = Number(val); return isNaN(n) ? null : Math.round(n); }

function buildInsertParams(b) {
  return [
    b.meal_date,
    b.meal_time || null,
    b.meal_type || 'meal',
    b.title,
    num(b.calories),
    num(b.protein_g),
    num(b.carbs_g),
    num(b.fat_g),
    num(b.fiber_g),
    num(b.sugar_g),
    num(b.sodium_mg),
    b.serving_size || null,
    int(b.hunger_before),
    int(b.fullness_after),
    int(b.energy_after),
    b.notes || null,
    JSON.stringify(b.tags || []),
    b.source || 'manual',
    b.ai_source || null,
    JSON.stringify(b.metadata || {}),
  ];
}

const INSERT_SQL = `INSERT INTO meals (
  meal_date, meal_time, meal_type, title,
  calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
  serving_size, hunger_before, fullness_after, energy_after,
  notes, tags, source, ai_source, metadata
) VALUES (
  $1, $2, $3, $4,
  $5, $6, $7, $8, $9, $10, $11,
  $12, $13, $14, $15,
  $16, $17, $18, $19, $20
)`;

// ─── List / Search Meals ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { q, meal_type, date, since, before, limit = 50, offset = 0, sort } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || coalesce(notes,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (meal_type) { where.push(`meal_type = $${i++}`); params.push(meal_type); }
    if (date) { where.push(`meal_date = $${i++}`); params.push(date); }
    if (since) { where.push(`meal_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`meal_date < $${i++}`); params.push(before); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let orderBy = 'meal_date DESC, meal_time DESC NULLS LAST, created_at DESC';
    if (sort === 'oldest') orderBy = 'meal_date ASC, meal_time ASC NULLS LAST, created_at ASC';
    if (sort === 'chronological') orderBy = 'meal_date ASC, meal_time ASC NULLS LAST';

    params.push(Number(limit), Number(offset));

    const countResult = await query(
      `SELECT COUNT(*) as total FROM meals ${whereClause}`, params.slice(0, -2)
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM meals ${whereClause}
       ORDER BY ${orderBy} LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, meals: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Meal ─────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM meals WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Meal ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const errors = validateMeal(b);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const result = await query(`${INSERT_SQL} RETURNING *`, buildInsertParams(b));

    await logActivity('create', 'meal', result.rows[0].id,
      b.ai_source || b.source || 'manual',
      `Meal: ${b.title} on ${b.meal_date}`
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Import Meals ───────────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { meals } = req.body;
    if (!Array.isArray(meals) || !meals.length) {
      return res.status(400).json({ error: 'meals array is required' });
    }
    if (meals.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 meals per request' });
    }

    const results = [];
    let imported = 0;
    let errorCount = 0;

    for (const b of meals) {
      try {
        const errors = validateMeal(b);
        if (errors.length) {
          results.push({ error: errors.join('; '), title: b.title, meal_date: b.meal_date });
          errorCount++;
          continue;
        }
        const result = await query(
          `${INSERT_SQL} RETURNING id, title, meal_date, meal_type`,
          buildInsertParams(b)
        );
        results.push({ id: result.rows[0].id, title: result.rows[0].title, meal_date: result.rows[0].meal_date });
        imported++;
      } catch (itemErr) {
        results.push({ error: itemErr.message, title: b.title, meal_date: b.meal_date });
        errorCount++;
      }
    }

    await logActivity('create', 'meal', 'bulk', 'import', `Bulk imported ${imported} meals (${errorCount} errors)`);
    res.status(201).json({ message: `Imported ${imported} meals`, imported, errors: errorCount, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Meal ─────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'meal_date', 'meal_time', 'meal_type', 'title',
      'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg',
      'serving_size', 'hunger_before', 'fullness_after', 'energy_after',
      'notes', 'tags', 'source', 'ai_source', 'metadata',
    ];

    const numericFields = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];
    const intFields = ['hunger_before', 'fullness_after', 'energy_after'];
    const jsonFields = ['tags', 'metadata'];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (jsonFields.includes(key)) {
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
      `UPDATE meals SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'meal', req.params.id, b.ai_source || 'manual', 'Updated meal');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Meal ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM meals WHERE id = $1 RETURNING id, title', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'meal', req.params.id, 'manual', `Deleted: ${result.rows[0].title}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
