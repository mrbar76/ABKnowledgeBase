const express = require('express');
const {
  queryDatabase, createPage, getPage,
  pageToHealthMetric, pageToWorkout, richText, dateOrNull, selectOrNull, logActivity
} = require('../notion');
const router = express.Router();

// ===== HEALTH METRICS =====

// Get health metrics
router.get('/metrics', async (req, res) => {
  try {
    const { type, from, to, limit = 100 } = req.query;
    const filters = [];

    if (type) {
      filters.push({ property: 'Metric Type', select: { equals: type } });
    }
    if (from) {
      filters.push({ property: 'Recorded At', date: { on_or_after: from } });
    }
    if (to) {
      filters.push({ property: 'Recorded At', date: { on_or_before: to } });
    }

    const filter = filters.length > 1 ? { and: filters }
      : filters.length === 1 ? filters[0] : undefined;

    const result = await queryDatabase('health_metrics', filter,
      [{ property: 'Recorded At', direction: 'descending' }],
      Number(limit));

    const metrics = result.results.map(pageToHealthMetric);
    res.json({ count: metrics.length, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Metric types summary
router.get('/metrics/types', async (req, res) => {
  try {
    const result = await queryDatabase('health_metrics', undefined, undefined, 100);
    const metrics = result.results.map(pageToHealthMetric);

    const byType = {};
    for (const m of metrics) {
      if (!byType[m.metric_type]) {
        byType[m.metric_type] = { metric_type: m.metric_type, unit: m.unit, values: [] };
      }
      byType[m.metric_type].values.push(m.value);
    }

    const summary = Object.values(byType).map(t => ({
      metric_type: t.metric_type,
      unit: t.unit,
      count: t.values.length,
      avg_value: +(t.values.reduce((a, b) => a + b, 0) / t.values.length).toFixed(2),
    }));

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Store health metric(s)
router.post('/metrics', async (req, res) => {
  try {
    const { metrics } = req.body;
    const items = Array.isArray(metrics) ? metrics : [req.body];
    const ids = [];

    for (const m of items) {
      if (!m.metric_type || m.value === undefined || !m.unit || !m.recorded_at) continue;

      const now = new Date().toISOString();
      const page = await createPage('health_metrics', {
        Title: { title: richText(`${m.metric_type}: ${m.value} ${m.unit}`) },
        'Metric Type': { select: selectOrNull(m.metric_type) },
        Value: { number: Number(m.value) },
        Unit: { rich_text: richText(m.unit) },
        'Source Name': { rich_text: richText(m.source_name || 'apple_health') },
        'Recorded At': { date: dateOrNull(m.recorded_at) },
        'Created At': { date: dateOrNull(now) },
      });
      ids.push(page.id);
    }

    if (ids.length) {
      await logActivity('create', 'health_metric', ids[0], 'apple_health', `Stored ${ids.length} health metric(s)`);
    }

    res.status(201).json({ count: ids.length, ids, message: 'Health metrics stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WORKOUTS =====

// List workouts
router.get('/workouts', async (req, res) => {
  try {
    const { type, from, to, limit = 50 } = req.query;
    const filters = [];

    if (type) {
      filters.push({ property: 'Workout Type', select: { equals: type } });
    }
    if (from) {
      filters.push({ property: 'Started At', date: { on_or_after: from } });
    }
    if (to) {
      filters.push({ property: 'Started At', date: { on_or_before: to } });
    }

    const filter = filters.length > 1 ? { and: filters }
      : filters.length === 1 ? filters[0] : undefined;

    const result = await queryDatabase('workouts', filter,
      [{ property: 'Started At', direction: 'descending' }],
      Number(limit));

    const workouts = result.results.map(pageToWorkout);
    res.json({ count: workouts.length, workouts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Workout types summary
router.get('/workouts/types', async (req, res) => {
  try {
    const result = await queryDatabase('workouts', undefined, undefined, 100);
    const workouts = result.results.map(pageToWorkout);

    const byType = {};
    for (const w of workouts) {
      if (!byType[w.workout_type]) {
        byType[w.workout_type] = { workout_type: w.workout_type, items: [] };
      }
      byType[w.workout_type].items.push(w);
    }

    const summary = Object.values(byType).map(t => ({
      workout_type: t.workout_type,
      count: t.items.length,
      avg_duration: +(t.items.reduce((a, b) => a + (b.duration_minutes || 0), 0) / t.items.length).toFixed(1),
      total_calories: Math.round(t.items.reduce((a, b) => a + (b.calories_burned || 0), 0)),
      total_distance: +(t.items.reduce((a, b) => a + (b.distance_km || 0), 0)).toFixed(2),
    }));

    res.json(summary);
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

      const now = new Date().toISOString();
      const page = await createPage('workouts', {
        Title: { title: richText(`${w.workout_type} — ${new Date(w.started_at).toLocaleDateString()}`) },
        'Workout Type': { select: selectOrNull(w.workout_type) },
        'Duration (min)': { number: w.duration_minutes || null },
        'Calories Burned': { number: w.calories_burned || null },
        'Distance (km)': { number: w.distance_km || null },
        'Avg Heart Rate': { number: w.avg_heart_rate || null },
        'Max Heart Rate': { number: w.max_heart_rate || null },
        'Source Name': { rich_text: richText(w.source_name || 'apple_health') },
        'Started At': { date: dateOrNull(w.started_at) },
        'Ended At': { date: dateOrNull(w.ended_at) },
        'Created At': { date: dateOrNull(now) },
      });
      ids.push(page.id);
    }

    if (ids.length) {
      await logActivity('create', 'workout', ids[0], 'apple_health', `Stored ${ids.length} workout(s)`);
    }

    res.status(201).json({ count: ids.length, ids, message: 'Workouts stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single workout
router.get('/workouts/:id', async (req, res) => {
  try {
    const page = await getPage(req.params.id);
    if (page.archived) return res.status(404).json({ error: 'Not found' });
    res.json(pageToWorkout(page));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
