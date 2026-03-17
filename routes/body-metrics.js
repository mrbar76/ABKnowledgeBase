const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// All numeric metric fields
const METRIC_FIELDS = [
  'weight_lb', 'bmi', 'body_fat_pct', 'skeletal_muscle_pct', 'fat_free_mass_lb',
  'subcutaneous_fat_pct', 'visceral_fat', 'body_water_pct', 'muscle_mass_lb',
  'bone_mass_lb', 'protein_pct', 'bmr_kcal', 'metabolic_age',
];

// Integer-only metric fields
const INT_FIELDS = ['visceral_fat', 'bmr_kcal', 'metabolic_age'];

// Percentage fields (must be 0-100)
const PCT_FIELDS = ['body_fat_pct', 'skeletal_muscle_pct', 'subcutaneous_fat_pct', 'body_water_pct', 'protein_pct'];

function validateBody(b) {
  const errors = [];
  if (!b.measurement_date) errors.push('measurement_date is required');
  if (b.weight_lb == null || b.weight_lb === '') errors.push('weight_lb is required');
  else if (typeof b.weight_lb !== 'number' || b.weight_lb <= 0) errors.push('weight_lb must be a positive number');

  for (const f of METRIC_FIELDS) {
    if (b[f] != null && b[f] !== '') {
      const v = Number(b[f]);
      if (isNaN(v)) { errors.push(`${f} must be a number`); continue; }
      if (v < 0) errors.push(`${f} must be >= 0`);
      if (PCT_FIELDS.includes(f) && v > 100) errors.push(`${f} must be <= 100`);
    }
  }

  if (b.measurement_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(b.measurement_time)) {
    errors.push('measurement_time must be HH:MM or HH:MM:SS');
  }

  return errors;
}

function parseNumeric(val, isInt) {
  if (val == null || val === '') return null;
  const n = Number(val);
  if (isNaN(n)) return null;
  return isInt ? Math.round(n) : n;
}

function buildInsertParams(b) {
  return [
    b.measurement_date,
    b.measurement_time || null,
    b.source || 'RENPHO',
    b.source_type || 'smart_scale',
    parseNumeric(b.weight_lb, false),
    parseNumeric(b.bmi, false),
    parseNumeric(b.body_fat_pct, false),
    parseNumeric(b.skeletal_muscle_pct, false),
    parseNumeric(b.fat_free_mass_lb, false),
    parseNumeric(b.subcutaneous_fat_pct, false),
    parseNumeric(b.visceral_fat, true),
    parseNumeric(b.body_water_pct, false),
    parseNumeric(b.muscle_mass_lb, false),
    parseNumeric(b.bone_mass_lb, false),
    parseNumeric(b.protein_pct, false),
    parseNumeric(b.bmr_kcal, true),
    parseNumeric(b.metabolic_age, true),
    b.measurement_context || null,
    b.vendor_user_mode || null,
    b.notes || null,
    JSON.stringify(b.tags || []),
    b.is_manual_entry === true,
    b.raw_payload ? JSON.stringify(b.raw_payload) : null,
  ];
}

const INSERT_SQL = `INSERT INTO body_metrics (
  measurement_date, measurement_time, source, source_type,
  weight_lb, bmi, body_fat_pct, skeletal_muscle_pct, fat_free_mass_lb,
  subcutaneous_fat_pct, visceral_fat, body_water_pct, muscle_mass_lb,
  bone_mass_lb, protein_pct, bmr_kcal, metabolic_age,
  measurement_context, vendor_user_mode,
  notes, tags, is_manual_entry, raw_payload
) VALUES (
  $1, $2, $3, $4,
  $5, $6, $7, $8, $9,
  $10, $11, $12, $13,
  $14, $15, $16, $17,
  $18, $19,
  $20, $21, $22, $23
)`;

// ─── List / Search Body Metrics ──────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { q, source, since, before, latest, limit = 50, offset = 0, sort } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR coalesce(notes,'') ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (source) { where.push(`source = $${i++}`); params.push(source); }
    if (since) { where.push(`measurement_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`measurement_date < $${i++}`); params.push(before); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // If latest=true, return only the most recent entry
    if (latest === 'true') {
      const result = await query(
        `SELECT * FROM body_metrics ${whereClause} ORDER BY measurement_date DESC, measurement_time DESC NULLS LAST LIMIT 1`,
        params
      );
      return res.json(result.rows[0] || null);
    }

    let orderBy = 'measurement_date DESC, measurement_time DESC NULLS LAST';
    if (sort === 'oldest') orderBy = 'measurement_date ASC, measurement_time ASC NULLS LAST';

    params.push(Number(limit), Number(offset));

    const countResult = await query(
      `SELECT COUNT(*) as total FROM body_metrics ${whereClause}`, params.slice(0, -2)
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM body_metrics ${whereClause}
       ORDER BY ${orderBy} LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, body_metrics: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Body Metric ─────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM body_metrics WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Body Metric ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const errors = validateBody(b);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const result = await query(`${INSERT_SQL} RETURNING *`, buildInsertParams(b));

    await logActivity('create', 'body_metric', result.rows[0].id,
      b.source || 'RENPHO',
      `Body metric: ${b.weight_lb}lb on ${b.measurement_date}`
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Import Body Metrics ────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { body_metrics: entries } = req.body;
    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ error: 'body_metrics array is required' });
    }
    if (entries.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 entries per request' });
    }

    const results = [];
    let imported = 0;
    let errorCount = 0;

    for (const b of entries) {
      try {
        const errors = validateBody(b);
        if (errors.length) {
          results.push({ error: errors.join('; '), measurement_date: b.measurement_date });
          errorCount++;
          continue;
        }

        const result = await query(
          `${INSERT_SQL} RETURNING id, measurement_date, weight_lb`,
          buildInsertParams(b)
        );
        results.push({ id: result.rows[0].id, measurement_date: result.rows[0].measurement_date, weight_lb: result.rows[0].weight_lb });
        imported++;
      } catch (itemErr) {
        results.push({ error: itemErr.message, measurement_date: b.measurement_date });
        errorCount++;
      }
    }

    await logActivity('create', 'body_metric', 'bulk', 'import', `Bulk imported ${imported} body metrics (${errorCount} errors)`);
    res.status(201).json({ message: `Imported ${imported} body metrics`, imported, errors: errorCount, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Body Metric ─────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'measurement_date', 'measurement_time', 'source', 'source_type',
      ...METRIC_FIELDS,
      'measurement_context', 'vendor_user_mode',
      'notes', 'tags', 'is_manual_entry', 'raw_payload',
    ];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (key === 'tags') {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else if (key === 'raw_payload') {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(b[key] ? JSON.stringify(b[key]) : null);
        } else if (METRIC_FIELDS.includes(key)) {
          fields.push(`${key} = $${i++}`);
          params.push(parseNumeric(b[key], INT_FIELDS.includes(key)));
        } else if (key === 'is_manual_entry') {
          fields.push(`${key} = $${i++}`);
          params.push(b[key] === true);
        } else {
          fields.push(`${key} = $${i++}`);
          params.push(b[key]);
        }
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE body_metrics SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'body_metric', req.params.id, b.source || 'manual', 'Updated body metric');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Body Metric ─────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM body_metrics WHERE id = $1 RETURNING id, measurement_date', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'body_metric', req.params.id, 'manual', `Deleted: ${result.rows[0].measurement_date}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats / Trends ─────────────────────────────────────────
router.get('/stats/summary', async (req, res) => {
  try {
    const [totals, latest, avgWeight, sources] = await Promise.all([
      query('SELECT COUNT(*)::int as total FROM body_metrics'),
      query('SELECT * FROM body_metrics ORDER BY measurement_date DESC, measurement_time DESC NULLS LAST LIMIT 1'),
      query('SELECT ROUND(AVG(weight_lb)::numeric, 1)::text as avg_weight FROM body_metrics'),
      query('SELECT source, COUNT(*)::int as count FROM body_metrics GROUP BY source ORDER BY count DESC'),
    ]);

    res.json({
      total: totals.rows[0]?.total || 0,
      latest: latest.rows[0] || null,
      avg_weight_lb: avgWeight.rows[0]?.avg_weight || null,
      by_source: sources.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
