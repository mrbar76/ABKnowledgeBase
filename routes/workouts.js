const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// Canonical writable fields (matches read schema)
const WRITABLE_FIELDS = [
  'title', 'workout_date', 'workout_type', 'location', 'elevation', 'focus',
  'warmup', 'main_sets', 'carries', 'exercises',
  'time_duration', 'distance', 'elevation_gain',
  'heart_rate_avg', 'heart_rate_max', 'pace_avg', 'splits', 'cadence_avg',
  'active_calories', 'total_calories',
  'effort', 'body_notes', 'adjustment',
  'slowdown_notes', 'failure_first',
  'grip_feedback', 'legs_feedback', 'cardio_feedback', 'shoulder_feedback',
  'tags', 'source', 'ai_source', 'metadata',
];

const JSONB_FIELDS = new Set(['exercises', 'tags', 'metadata', 'splits']);

// ─── List / Search Workouts ──────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { q, workout_type, tag, since, before, limit = 50, offset = 0, sort } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || coalesce(focus,'') || ' ' || coalesce(main_sets,'') || ' ' || coalesce(body_notes,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (workout_type) { where.push(`workout_type = $${i++}`); params.push(workout_type); }
    if (tag) { where.push(`tags @> $${i++}::jsonb`); params.push(JSON.stringify([tag])); }
    if (since) { where.push(`workout_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`workout_date < $${i++}`); params.push(before); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let orderBy = 'workout_date DESC, created_at DESC';
    if (sort === 'oldest') orderBy = 'workout_date ASC, created_at ASC';
    else if (sort === 'effort_high') orderBy = 'effort DESC NULLS LAST';
    else if (sort === 'effort_low') orderBy = 'effort ASC NULLS LAST';

    params.push(Number(limit), Number(offset));

    const countResult = await query(
      `SELECT COUNT(*) as total FROM workouts ${whereClause}`, params.slice(0, -2)
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM workouts ${whereClause}
       ORDER BY ${orderBy} LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, workouts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Workout ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM workouts WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Workout ──────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const title = b.title || `Workout – ${b.workout_date || req.getToday()} – ${(b.workout_type || 'hybrid').toUpperCase()}`;

    const result = await query(
      `INSERT INTO workouts (
        title, workout_date, workout_type, location, elevation, focus,
        warmup, main_sets, carries, exercises,
        time_duration, distance, elevation_gain,
        heart_rate_avg, heart_rate_max, pace_avg, splits, cadence_avg,
        active_calories, total_calories,
        effort, body_notes, adjustment,
        slowdown_notes, failure_first,
        grip_feedback, legs_feedback, cardio_feedback, shoulder_feedback,
        tags, source, ai_source, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16, $17, $18,
        $19, $20,
        $21, $22, $23,
        $24, $25,
        $26, $27, $28, $29,
        $30, $31, $32, $33
      ) RETURNING *`,
      [
        title,
        b.workout_date || req.getToday(),
        b.workout_type || 'hybrid',
        b.location || null,
        b.elevation || null,
        b.focus || null,
        b.warmup || null,
        b.main_sets || null,
        b.carries || null,
        JSON.stringify(b.exercises || []),
        b.time_duration || b.time || null,
        b.distance || null,
        b.elevation_gain || null,
        b.heart_rate_avg || null,
        b.heart_rate_max || null,
        b.pace_avg || null,
        b.splits ? JSON.stringify(b.splits) : null,
        b.cadence_avg || null,
        b.active_calories || null,
        b.total_calories || null,
        b.effort ? parseInt(b.effort, 10) : null,
        b.body_notes || b.notes || null,
        b.adjustment || b.adjustment_next_time || null,
        b.slowdown_notes || null,
        b.failure_first || null,
        b.grip_feedback || null,
        b.legs_feedback || null,
        b.cardio_feedback || null,
        b.shoulder_feedback || null,
        JSON.stringify(b.tags || []),
        b.source || 'manual',
        b.ai_source || null,
        JSON.stringify(b.metadata || {}),
      ]
    );

    await logActivity('create', 'workout', result.rows[0].id, b.ai_source || b.source || 'manual', `Workout: ${title}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Import Workouts ───────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { workouts } = req.body;
    if (!Array.isArray(workouts) || !workouts.length) {
      return res.status(400).json({ error: 'workouts array is required' });
    }
    if (workouts.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 workouts per request' });
    }

    const results = [];
    let imported = 0;
    let errors = 0;

    for (const b of workouts) {
      try {
        const title = b.title || `Workout – ${b.workout_date || req.getToday()} – ${(b.workout_type || 'hybrid').toUpperCase()}`;

        const result = await query(
          `INSERT INTO workouts (
            title, workout_date, workout_type, location, elevation, focus,
            warmup, main_sets, carries, exercises,
            time_duration, distance, elevation_gain,
            heart_rate_avg, heart_rate_max, pace_avg, splits, cadence_avg,
            active_calories, total_calories,
            effort, body_notes, adjustment,
            slowdown_notes, failure_first,
            grip_feedback, legs_feedback, cardio_feedback, shoulder_feedback,
            tags, source, ai_source, metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13,
            $14, $15, $16, $17, $18,
            $19, $20,
            $21, $22, $23,
            $24, $25,
            $26, $27, $28, $29,
            $30, $31, $32, $33
          ) RETURNING id, title, workout_date, workout_type`,
          [
            title,
            b.workout_date || req.getToday(),
            b.workout_type || 'hybrid',
            b.location || null,
            b.elevation || null,
            b.focus || null,
            b.warmup || null,
            b.main_sets || null,
            b.carries || null,
            JSON.stringify(b.exercises || []),
            b.time_duration || b.time || null,
            b.distance || null,
            b.elevation_gain || null,
            b.heart_rate_avg || null,
            b.heart_rate_max || null,
            b.pace_avg || null,
            b.splits ? JSON.stringify(b.splits) : null,
            b.cadence_avg || null,
            b.active_calories || null,
            b.total_calories || null,
            b.effort ? parseInt(b.effort, 10) : null,
            b.body_notes || b.notes || null,
            b.adjustment || b.adjustment_next_time || null,
            b.slowdown_notes || null,
            b.failure_first || null,
            b.grip_feedback || null,
            b.legs_feedback || null,
            b.cardio_feedback || null,
            b.shoulder_feedback || null,
            JSON.stringify(b.tags || []),
            b.source || 'import',
            b.ai_source || null,
            JSON.stringify(b.metadata || {}),
          ]
        );

        results.push({ id: result.rows[0].id, title: result.rows[0].title, workout_date: result.rows[0].workout_date });
        imported++;
      } catch (itemErr) {
        results.push({ error: itemErr.message, workout_date: b.workout_date, title: b.title });
        errors++;
      }
    }

    await logActivity('create', 'workout', 'bulk', 'import', `Bulk imported ${imported} workouts (${errors} errors)`);
    res.status(201).json({ message: `Imported ${imported} workouts`, imported, errors, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Workout ──────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    for (const key of WRITABLE_FIELDS) {
      if (b[key] !== undefined) {
        if (JSONB_FIELDS.has(key)) {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else if (key === 'effort') {
          fields.push(`effort = $${i++}`);
          params.push(b.effort ? parseInt(b.effort, 10) : null);
        } else {
          fields.push(`${key} = $${i++}`);
          params.push(b[key]);
        }
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE workouts SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'workout', req.params.id, b.ai_source || 'manual', `Updated workout`);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Workout ──────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM workouts WHERE id = $1 RETURNING id, title', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'workout', req.params.id, 'manual', `Deleted: ${result.rows[0].title}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats / Summary ─────────────────────────────────────────
router.get('/stats/summary', async (req, res) => {
  try {
    const [totals, byType, avgEffort, recent] = await Promise.all([
      query('SELECT COUNT(*)::int as total FROM workouts'),
      query('SELECT workout_type, COUNT(*)::int as count FROM workouts GROUP BY workout_type ORDER BY count DESC'),
      query('SELECT ROUND(AVG(effort), 1)::text as avg_effort FROM workouts WHERE effort IS NOT NULL'),
      query('SELECT workout_date, title, workout_type, effort FROM workouts ORDER BY workout_date DESC LIMIT 5'),
    ]);

    res.json({
      total: totals.rows[0]?.total || 0,
      by_type: byType.rows,
      avg_effort: avgEffort.rows[0]?.avg_effort || null,
      recent: recent.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
