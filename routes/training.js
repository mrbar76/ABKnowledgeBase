const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// (training_plans CRUD removed — table dropped, all planning uses daily_plans)

// ══════════════════════════════════════════════════════════════════
//  COACHING SESSIONS
// ══════════════════════════════════════════════════════════════════

// ─── List / Search Coaching Sessions ─────────────────────────
router.get('/coaching', async (req, res) => {
  try {
    const { q, since, before, training_plan_id, tag, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(injury_notes,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (since) { where.push(`session_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`session_date < $${i++}`); params.push(before); }
    if (training_plan_id) { where.push(`training_plan_id = $${i++}`); params.push(training_plan_id); }
    if (tag) { where.push(`tags @> $${i++}::jsonb`); params.push(JSON.stringify([tag])); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const countResult = await query(`SELECT COUNT(*) as total FROM coaching_sessions ${whereClause}`, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM coaching_sessions ${whereClause} ORDER BY session_date DESC, created_at DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Session ──────────────────────────────────────
router.get('/coaching/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM coaching_sessions WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Session ──────────────────────────────────────────
router.post('/coaching', async (req, res) => {
  try {
    const b = req.body;
    if (!b.title || !b.summary) return res.status(400).json({ error: 'title and summary are required' });

    const result = await query(
      `INSERT INTO coaching_sessions (
        session_date, title, summary, key_decisions, adjustments,
        injury_notes, nutrition_notes, recovery_notes, mental_notes, next_steps,
        data_reviewed, training_plan_id, conversation_id, ai_source, tags, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        b.session_date || req.getToday(),
        b.title,
        b.summary,
        JSON.stringify(b.key_decisions || []),
        JSON.stringify(b.adjustments || []),
        b.injury_notes || null,
        b.nutrition_notes || null,
        b.recovery_notes || null,
        b.mental_notes || null,
        b.next_steps || null,
        JSON.stringify(b.data_reviewed || {}),
        b.training_plan_id || null,
        b.conversation_id || null,
        b.ai_source || 'chatgpt',
        JSON.stringify(b.tags || []),
        JSON.stringify(b.metadata || {}),
      ]
    );

    await logActivity('create', 'coaching_session', result.rows[0].id, b.ai_source || 'chatgpt', `Session: ${b.title}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Session ──────────────────────────────────────────
router.put('/coaching/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'session_date', 'title', 'summary', 'key_decisions', 'adjustments',
      'injury_notes', 'nutrition_notes', 'recovery_notes', 'mental_notes', 'next_steps',
      'data_reviewed', 'training_plan_id', 'conversation_id', 'ai_source', 'tags', 'metadata',
    ];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (['key_decisions', 'adjustments', 'data_reviewed', 'tags', 'metadata'].includes(key)) {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else {
          fields.push(`${key} = $${i++}`);
          params.push(b[key]);
        }
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE coaching_sessions SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'coaching_session', req.params.id, b.ai_source || 'manual', 'Updated coaching session');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Session ──────────────────────────────────────────
router.delete('/coaching/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM coaching_sessions WHERE id = $1 RETURNING id, title', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'coaching_session', req.params.id, 'manual', `Deleted: ${result.rows[0].title}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  INJURIES
// ══════════════════════════════════════════════════════════════════

// ─── List / Search Injuries ──────────────────────────────────
router.get('/injuries', async (req, res) => {
  try {
    const { q, status, body_area, tag, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (coalesce(title,'') || ' ' || coalesce(body_area,'') || ' ' || coalesce(symptoms,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (body_area) { where.push(`body_area ILIKE $${i++}`); params.push(body_area); }
    if (tag) { where.push(`tags @> $${i++}::jsonb`); params.push(JSON.stringify([tag])); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const countResult = await query(`SELECT COUNT(*) as total FROM injuries ${whereClause}`, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM injuries ${whereClause} ORDER BY onset_date DESC NULLS LAST, created_at DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, injuries: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Injury ───────────────────────────────────────
router.get('/injuries/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM injuries WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Injury ───────────────────────────────────────────
router.post('/injuries', async (req, res) => {
  try {
    const b = req.body;
    if (!b.title || !b.body_area) return res.status(400).json({ error: 'title and body_area are required' });

    const result = await query(
      `INSERT INTO injuries (
        title, body_area, side, injury_type, severity, status,
        onset_date, resolved_date, symptoms, treatment, notes,
        mechanism, aggravating_movements, relieving_factors, modifications, prevention_notes,
        tags, ai_source, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        b.title,
        b.body_area,
        b.side || null,
        b.injury_type || 'strain',
        b.severity ? parseInt(b.severity, 10) : null,
        b.status || 'active',
        b.onset_date || null,
        b.resolved_date || null,
        b.symptoms || null,
        b.treatment || null,
        b.notes || null,
        b.mechanism || null,
        b.aggravating_movements || null,
        b.relieving_factors || null,
        b.modifications || null,
        b.prevention_notes || null,
        JSON.stringify(b.tags || []),
        b.ai_source || null,
        JSON.stringify(b.metadata || {}),
      ]
    );

    await logActivity('create', 'injury', result.rows[0].id, b.ai_source || 'manual', `Injury: ${b.title}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Injury ───────────────────────────────────────────
router.put('/injuries/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'title', 'body_area', 'side', 'injury_type', 'severity', 'status',
      'onset_date', 'resolved_date', 'symptoms', 'treatment', 'notes',
      'mechanism', 'aggravating_movements', 'relieving_factors', 'modifications', 'prevention_notes',
      'tags', 'ai_source', 'metadata',
    ];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (['tags', 'metadata'].includes(key)) {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else if (key === 'severity') {
          fields.push(`severity = $${i++}`);
          params.push(b.severity ? parseInt(b.severity, 10) : null);
        } else {
          fields.push(`${key} = $${i++}`);
          params.push(b[key]);
        }
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE injuries SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'injury', req.params.id, b.ai_source || 'manual', 'Updated injury');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Injury ───────────────────────────────────────────
router.delete('/injuries/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM injuries WHERE id = $1 RETURNING id, title', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'injury', req.params.id, 'manual', `Deleted: ${result.rows[0].title}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  TRAINING DAY VIEW — cross-reference all fitness data for a date
// ══════════════════════════════════════════════════════════════════

router.get('/day/:date', async (req, res) => {
  try {
    const date = req.params.date; // YYYY-MM-DD

    const [workouts, meals, nutrition, bodyMetrics, coaching, activeInjuries, dailyPlan] = await Promise.all([
      query('SELECT * FROM workouts WHERE workout_date = $1 ORDER BY created_at', [date]),
      query('SELECT * FROM meals WHERE meal_date = $1 ORDER BY meal_time ASC NULLS LAST', [date]),
      query('SELECT * FROM daily_context WHERE date = $1', [date]),
      query('SELECT * FROM body_metrics WHERE measurement_date = $1 ORDER BY measurement_time ASC NULLS LAST', [date]),
      query('SELECT * FROM coaching_sessions WHERE session_date = $1 ORDER BY created_at DESC', [date]),
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') AND (onset_date IS NULL OR onset_date <= $1) AND (resolved_date IS NULL OR resolved_date >= $1) ORDER BY severity DESC NULLS LAST`, [date]),
      query('SELECT * FROM daily_plans WHERE plan_date = $1', [date]),
    ]);

    // Attach segments (with each segment's logged workouts) so the
    // frontend can render the unified Today card without a second
    // round trip.
    let plan = dailyPlan.rows[0] || null;
    if (plan) {
      const segR = await query(
        `SELECT ps.*, COALESCE(
           (SELECT json_agg(w.* ORDER BY w.started_at NULLS LAST, w.created_at)
            FROM workouts w WHERE w.plan_segment_id = ps.id), '[]'::json
         ) AS workouts
         FROM plan_segments ps
         WHERE ps.daily_plan_id = $1
         ORDER BY ps.block_order`,
        [plan.id]
      ).catch(() => ({ rows: [] }));
      plan.segments = segR.rows;

      // For Hevy segments, enrich each planned exercise with
      // `hevy_resolved_title` (and back-fill `hevy_exercise_template_id`
      // when missing) so the Today card chip shows green "→ Hevy:
      // Deadlift (Barbell)" instead of amber "⚠ unresolved".
      //
      // Two passes:
      //   1. ID-based: look up titles for exercises that already have
      //      hevy_exercise_template_id.
      //   2. Name-based fallback: for exercises without an ID, try the
      //      sticky map (hevy_exercise_map) and the cache. This covers
      //      pre-v1.8.6 segments where Coach wrote name-only and the
      //      resolver fills at push time but never persists back.
      //      Display-only — does NOT save back to DB; v1.8.6 push path
      //      handles persistence after a real push completes.
      try {
        const ids = new Set();
        const namesNeedingLookup = new Set();
        for (const s of plan.segments) {
          if (s.logging_target !== 'hevy') continue;
          for (const e of (s.planned_exercises || [])) {
            if (e.hevy_exercise_template_id) {
              ids.add(e.hevy_exercise_template_id);
            } else {
              const name = e.name || e.exercise_name || e.title;
              if (name) namesNeedingLookup.add(name.toLowerCase());
            }
          }
        }
        const idToTitle = new Map();
        if (ids.size) {
          const titlesR = await query(
            `SELECT hevy_id, title FROM hevy_template_cache WHERE hevy_id = ANY($1::text[])`,
            [Array.from(ids)]
          );
          for (const r of titlesR.rows) idToTitle.set(r.hevy_id, r.title);
        }
        const nameToHit = new Map();
        if (namesNeedingLookup.size) {
          const names = Array.from(namesNeedingLookup);
          // Sticky map first (Coach-confirmed mappings), then cache exact.
          const mapR = await query(
            `SELECT lower(ab_brain_exercise_name) AS lname,
                    hevy_exercise_template_id AS id, hevy_title AS title
             FROM hevy_exercise_map WHERE lower(ab_brain_exercise_name) = ANY($1::text[])`,
            [names]
          );
          for (const r of mapR.rows) nameToHit.set(r.lname, { id: r.id, title: r.title });
          const stillMissing = names.filter(n => !nameToHit.has(n));
          if (stillMissing.length) {
            const cacheR = await query(
              `SELECT lower(title) AS lname, hevy_id AS id, title
               FROM hevy_template_cache WHERE lower(title) = ANY($1::text[])`,
              [stillMissing]
            );
            for (const r of cacheR.rows) nameToHit.set(r.lname, { id: r.id, title: r.title });
          }
        }
        for (const s of plan.segments) {
          if (s.logging_target !== 'hevy') continue;
          for (const e of (s.planned_exercises || [])) {
            if (e.hevy_exercise_template_id && idToTitle.has(e.hevy_exercise_template_id)) {
              e.hevy_resolved_title = idToTitle.get(e.hevy_exercise_template_id);
            } else if (!e.hevy_exercise_template_id) {
              const name = (e.name || e.exercise_name || e.title || '').toLowerCase();
              const hit = nameToHit.get(name);
              if (hit) {
                e.hevy_exercise_template_id = hit.id;
                e.hevy_resolved_title = hit.title;
              }
            }
          }
        }
      } catch (_) { /* cache/map may not exist on first deploy; chip falls back to id-only */ }
    }

    // Strip deprecated daily_plans columns (planned_exercises,
    // actual_exercises, hevy_routine_id) so Coach + the Today UI never
    // see the legacy fields. Real exercise data lives on
    // plan.segments[].planned_exercises and plan.segments[].hevy_routine_id.
    if (plan) {
      delete plan.planned_exercises;
      delete plan.actual_exercises;
      delete plan.hevy_routine_id;
    }

    res.json({
      date,
      daily_plan: plan,
      workouts: workouts.rows,
      meals: meals.rows,
      nutrition_context: nutrition.rows[0] || null,
      body_metrics: bodyMetrics.rows,
      coaching_sessions: coaching.rows,
      active_injuries: activeInjuries.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ACTIVE INJURIES SUMMARY (for ChatGPT context)
// ══════════════════════════════════════════════════════════════════

router.get('/injuries/active/summary', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, title, body_area, side, injury_type, severity, status, onset_date, symptoms, notes
       FROM injuries WHERE status IN ('active','monitoring')
       ORDER BY severity DESC NULLS LAST, onset_date DESC NULLS LAST`
    );
    res.json({ count: result.rows.length, injuries: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
