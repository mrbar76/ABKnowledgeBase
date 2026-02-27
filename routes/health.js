const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ===== HEALTH METRICS =====

// Get health metrics
// GET /api/health/metrics?type=heart_rate&from=2024-01-01&to=2024-12-31&limit=100
router.get('/metrics', async (req, res) => {
  try {
    const { type, from, to, limit = 100, offset = 0 } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    if (type) { where.push(`metric_type = $${idx++}`); params.push(type); }
    if (from) { where.push(`recorded_at >= $${idx++}`); params.push(from); }
    if (to) { where.push(`recorded_at <= $${idx++}`); params.push(to); }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await query(`
      SELECT * FROM health_metrics ${clause}
      ORDER BY recorded_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, Number(limit), Number(offset)]);

    res.json({ count: result.rows.length, metrics: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get metric types summary
router.get('/metrics/types', async (req, res) => {
  try {
    const result = await query(`
      SELECT metric_type, unit, COUNT(*)::int as count,
             MIN(recorded_at) as earliest, MAX(recorded_at) as latest,
             ROUND(AVG(value)::numeric, 2) as avg_value
      FROM health_metrics
      GROUP BY metric_type, unit
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Store health metric(s)
// POST /api/health/metrics — single or batch
router.post('/metrics', async (req, res) => {
  try {
    const { metrics } = req.body;
    const items = Array.isArray(metrics) ? metrics : [req.body];
    const ids = [];

    for (const m of items) {
      if (!m.metric_type || m.value === undefined || !m.unit || !m.recorded_at) continue;

      const result = await query(`
        INSERT INTO health_metrics (metric_type, value, unit, source_name, recorded_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [m.metric_type, m.value, m.unit, m.source_name || 'apple_health', m.recorded_at, JSON.stringify(m.metadata || {})]);

      ids.push(result.rows[0].id);
    }

    if (ids.length) {
      await query(`
        INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
        VALUES ('create', 'health_metric', $1, 'apple_health', $2)
      `, [ids[0], `Stored ${ids.length} health metric(s)`]);
    }

    res.status(201).json({ count: ids.length, ids, message: 'Health metrics stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WORKOUTS =====

// List workouts
// GET /api/health/workouts?type=running&from=2024-01-01&limit=50
router.get('/workouts', async (req, res) => {
  try {
    const { type, from, to, limit = 50, offset = 0 } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    if (type) { where.push(`workout_type = $${idx++}`); params.push(type); }
    if (from) { where.push(`started_at >= $${idx++}`); params.push(from); }
    if (to) { where.push(`started_at <= $${idx++}`); params.push(to); }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await query(`
      SELECT * FROM workouts ${clause}
      ORDER BY started_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, Number(limit), Number(offset)]);

    res.json({ count: result.rows.length, workouts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get workout types summary
router.get('/workouts/types', async (req, res) => {
  try {
    const result = await query(`
      SELECT workout_type, COUNT(*)::int as count,
             ROUND(AVG(duration_minutes)::numeric, 1) as avg_duration,
             ROUND(SUM(calories_burned)::numeric, 0) as total_calories,
             ROUND(SUM(distance_km)::numeric, 2) as total_distance
      FROM workouts
      GROUP BY workout_type ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Store workout(s)
router.post('/workouts', async (req, res) => {
  try {
    const { workouts } = req.body;
    const items = Array.isArray(workouts) ? workouts : [req.body];
    const ids = [];

    for (const w of items) {
      if (!w.workout_type || !w.started_at) continue;

      const result = await query(`
        INSERT INTO workouts (workout_type, duration_minutes, calories_burned, distance_km,
                             avg_heart_rate, max_heart_rate, source_name, started_at, ended_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
      `, [
        w.workout_type, w.duration_minutes || null, w.calories_burned || null,
        w.distance_km || null, w.avg_heart_rate || null, w.max_heart_rate || null,
        w.source_name || 'apple_health', w.started_at, w.ended_at || null,
        JSON.stringify(w.metadata || {})
      ]);

      ids.push(result.rows[0].id);
    }

    if (ids.length) {
      await query(`
        INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
        VALUES ('create', 'workout', $1, 'apple_health', $2)
      `, [ids[0], `Stored ${ids.length} workout(s)`]);
    }

    res.status(201).json({ count: ids.length, ids, message: 'Workouts stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single workout
router.get('/workouts/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM workouts WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
