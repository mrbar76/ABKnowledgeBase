const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  SCORING ENGINE — 7 System Scorers
// ══════════════════════════════════════════════════════════════════

// Each scorer queries live DB data and returns { score: 0-100, detail: {} }

const SYSTEM_SCORERS = {
  async strength(profile, date) {
    // Score based on recent workout volume, effort, and consistency
    const { rows } = await query(`
      SELECT COUNT(*)::int AS count,
             COALESCE(AVG(effort), 0) AS avg_effort,
             COALESCE(SUM(duration_minutes), 0) AS total_minutes,
             COALESCE(AVG(duration_minutes), 0) AS avg_duration
      FROM workouts
      WHERE workout_date BETWEEN ($1::date - INTERVAL '14 days') AND $1::date
    `, [date]);
    const s = rows[0];
    const targets = profile.targets?.strength || { sessions_per_week: 4, min_effort: 7 };
    const expectedSessions = (targets.sessions_per_week || 4) * 2; // 2-week window
    const sessionScore = Math.min(100, (s.count / expectedSessions) * 100);
    const effortScore = Math.min(100, (parseFloat(s.avg_effort) / (targets.min_effort || 7)) * 100);
    const score = Math.round(sessionScore * 0.6 + effortScore * 0.4);
    return {
      score: Math.min(100, score),
      detail: { sessions_14d: s.count, avg_effort: +parseFloat(s.avg_effort).toFixed(1), total_minutes: +s.total_minutes, expected: expectedSessions }
    };
  },

  async nutrition(profile, date) {
    // Score based on meal logging consistency and nutrition context
    const [mealsR, ctxR] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count, COUNT(DISTINCT meal_date)::int AS days
             FROM meals WHERE meal_date BETWEEN ($1::date - INTERVAL '7 days') AND $1::date`, [date]),
      query(`SELECT COUNT(*)::int AS count FROM daily_nutrition_context
             WHERE date BETWEEN ($1::date - INTERVAL '7 days') AND $1::date`, [date]),
    ]);
    const meals = mealsR.rows[0];
    const ctx = ctxR.rows[0];
    const targets = profile.targets?.nutrition || { meals_per_day: 3, context_days: 7 };
    const expectedMeals = (targets.meals_per_day || 3) * 7;
    const mealScore = Math.min(100, (meals.count / expectedMeals) * 100);
    const contextScore = Math.min(100, (ctx.count / (targets.context_days || 7)) * 100);
    const consistencyScore = Math.min(100, (meals.days / 7) * 100);
    const score = Math.round(mealScore * 0.4 + contextScore * 0.3 + consistencyScore * 0.3);
    return {
      score: Math.min(100, score),
      detail: { meals_7d: meals.count, days_logged: meals.days, context_entries: ctx.count }
    };
  },

  async recovery(profile, date) {
    // Score based on body metrics recency, rest days, and nutrition context recovery data
    const [metricsR, restR, sleepR] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count,
             MAX(measurement_date) AS latest
             FROM body_metrics
             WHERE measurement_date >= ($1::date - INTERVAL '7 days')`, [date]),
      query(`SELECT COUNT(*)::int AS training_days FROM (
               SELECT workout_date FROM workouts
               WHERE workout_date BETWEEN ($1::date - INTERVAL '7 days') AND $1::date
               GROUP BY workout_date
             ) w`, [date]),
      query(`SELECT COUNT(*)::int AS count, COALESCE(AVG(sleep_hours), 0) AS avg_sleep,
             COALESCE(AVG(recovery_rating), 0) AS avg_recovery
             FROM daily_nutrition_context
             WHERE date BETWEEN ($1::date - INTERVAL '7 days') AND $1::date
               AND (sleep_hours IS NOT NULL OR recovery_rating IS NOT NULL)`, [date]),
    ]);
    const metrics = metricsR.rows[0];
    const trainingDays = restR.rows[0].training_days;
    const restDays = 7 - trainingDays;
    const sleep = sleepR.rows[0];
    const targets = profile.targets?.recovery || { min_rest_days: 2, metrics_per_week: 2 };
    const restScore = restDays >= (targets.min_rest_days || 2) ? 100 : (restDays / (targets.min_rest_days || 2)) * 100;
    const metricsScore = Math.min(100, (metrics.count / (targets.metrics_per_week || 2)) * 100);
    const sleepScore = sleep.count > 0 ? Math.min(100, (parseFloat(sleep.avg_sleep) / 7.5) * 100) : 0;
    // Weight: rest 40%, metrics 30%, sleep 30% (if sleep data exists, else rest 50% metrics 50%)
    let score;
    if (sleep.count > 0) {
      score = Math.round(restScore * 0.4 + metricsScore * 0.3 + sleepScore * 0.3);
    } else {
      score = Math.round(restScore * 0.5 + metricsScore * 0.5);
    }
    return {
      score: Math.min(100, score),
      detail: {
        rest_days: restDays, training_days: trainingDays,
        body_metrics_7d: metrics.count, latest_metric: metrics.latest,
        avg_sleep: sleep.count > 0 ? +parseFloat(sleep.avg_sleep).toFixed(1) : null,
        avg_recovery_rating: sleep.count > 0 ? +parseFloat(sleep.avg_recovery).toFixed(1) : null,
        target_rest_days: targets.min_rest_days || 2, target_metrics: targets.metrics_per_week || 2
      }
    };
  },

  async execution(profile, date) {
    // Score based on task completion rate
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'done' AND updated_at::date BETWEEN ($1::date - INTERVAL '7 days') AND $1::date)::int AS completed,
        COUNT(*) FILTER (WHERE status IN ('todo','in_progress') AND (due_date IS NULL OR due_date <= $1::date))::int AS pending,
        COUNT(*) FILTER (WHERE status = 'done' AND updated_at::date = $1::date)::int AS today_done
      FROM tasks
    `, [date]);
    const t = rows[0];
    const targets = profile.targets?.execution || { daily_tasks: 3 };
    const dailyScore = Math.min(100, (t.today_done / (targets.daily_tasks || 3)) * 100);
    const weeklyRate = t.completed + t.pending > 0 ? (t.completed / (t.completed + t.pending)) * 100 : 50;
    const score = Math.round(dailyScore * 0.5 + Math.min(100, weeklyRate) * 0.5);
    return {
      score: Math.min(100, score),
      detail: { completed_7d: t.completed, pending: t.pending, today_done: t.today_done }
    };
  },

  async consistency(profile, date) {
    // Score based on streaks from gamification data
    const { rows } = await query(`
      SELECT ring_train_goal, ring_execute_goal, ring_recover_goal
      FROM gamification_settings WHERE id = 1
    `);
    if (!rows.length) return { score: 50, detail: { note: 'no gamification settings' } };
    const gs = rows[0];

    // Count days in last 14 where rings were closed
    const { rows: days } = await query(`
      SELECT d::date AS day,
        (SELECT COUNT(*)::int FROM workouts WHERE workout_date = d::date) AS train,
        (SELECT COUNT(*)::int FROM tasks WHERE status = 'done' AND updated_at::date = d::date) AS execute,
        (SELECT COUNT(*)::int FROM meals WHERE meal_date = d::date) +
        (SELECT COUNT(*)::int FROM daily_nutrition_context WHERE date = d::date) AS recover
      FROM generate_series(($1::date - INTERVAL '13 days'), $1::date, '1 day') d
    `, [date]);

    let trainDays = 0, execDays = 0, recoverDays = 0, perfectDays = 0;
    for (const d of days) {
      const tOk = d.train >= (gs.ring_train_goal || 1);
      const eOk = d.execute >= (gs.ring_execute_goal || 1);
      const rOk = d.recover >= (gs.ring_recover_goal || 1);
      if (tOk) trainDays++;
      if (eOk) execDays++;
      if (rOk) recoverDays++;
      if (tOk && eOk && rOk) perfectDays++;
    }
    const score = Math.round(((trainDays + execDays + recoverDays) / 42) * 100); // 14*3=42 max
    return {
      score: Math.min(100, score),
      detail: { train_days: trainDays, exec_days: execDays, recover_days: recoverDays, perfect_days: perfectDays, window: 14 }
    };
  },

  async body_composition(profile, date) {
    // Score based on trend toward body comp targets (uses weight_lb from body_metrics)
    const { rows } = await query(`
      SELECT weight_lb, body_fat_pct, skeletal_muscle_pct, measurement_date
      FROM body_metrics
      WHERE measurement_date >= ($1::date - INTERVAL '30 days')
      ORDER BY measurement_date DESC LIMIT 10
    `, [date]);
    if (!rows.length) return { score: 0, detail: { note: 'No weigh-ins in the last 30 days. Log a weigh-in under the Body tab.' } };

    const latest = rows[0];
    const targets = profile.targets?.body_composition || {};
    let score = 60; // baseline if data exists but no targets set

    // Score against weight target (in lbs)
    if (targets.weight_lb && latest.weight_lb) {
      const dist = Math.abs(parseFloat(latest.weight_lb) - targets.weight_lb);
      const maxDist = targets.weight_lb * 0.15;
      score = Math.round(Math.max(0, 100 - (dist / maxDist) * 100));
    }
    // Score against body fat target
    if (targets.body_fat_pct && latest.body_fat_pct) {
      const dist = Math.abs(parseFloat(latest.body_fat_pct) - targets.body_fat_pct);
      const bfScore = Math.round(Math.max(0, 100 - (dist / 10) * 100));
      score = targets.weight_lb ? Math.round(score * 0.5 + bfScore * 0.5) : bfScore;
    }

    // Trend bonus: are we moving in the right direction?
    if (rows.length >= 3 && latest.weight_lb) {
      const oldest = rows[rows.length - 1];
      if (targets.weight_lb && oldest.weight_lb) {
        const direction = targets.weight_lb < parseFloat(oldest.weight_lb) ? -1 : 1;
        const moved = (parseFloat(latest.weight_lb) - parseFloat(oldest.weight_lb)) * direction;
        if (moved > 0) score = Math.min(100, score + 10);
      }
    }

    // Data frequency bonus: reward consistent tracking
    const trackingScore = Math.min(100, (rows.length / 4) * 100); // 4 weigh-ins/month = 100
    if (!targets.weight_lb && !targets.body_fat_pct) {
      // No targets set — score purely on tracking consistency
      score = trackingScore;
    }

    return {
      score: Math.min(100, Math.max(0, score)),
      detail: {
        latest_weight_lb: latest.weight_lb ? +parseFloat(latest.weight_lb).toFixed(1) : null,
        latest_bf: latest.body_fat_pct ? +parseFloat(latest.body_fat_pct).toFixed(1) : null,
        latest_muscle: latest.skeletal_muscle_pct ? +parseFloat(latest.skeletal_muscle_pct).toFixed(1) : null,
        data_points: rows.length,
        latest_date: latest.measurement_date,
        target_weight_lb: targets.weight_lb || null,
        target_bf: targets.body_fat_pct || null
      }
    };
  },

  async knowledge(profile, date) {
    // Score based on knowledge base growth and learning activity
    const [kbR, convR] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count FROM knowledge
             WHERE created_at >= ($1::date - INTERVAL '7 days')`, [date]),
      query(`SELECT COUNT(*)::int AS count FROM conversations
             WHERE created_at >= ($1::date - INTERVAL '7 days')`, [date]),
    ]);
    const targets = profile.targets?.knowledge || { entries_per_week: 5, conversations_per_week: 3 };
    const kbScore = Math.min(100, (kbR.rows[0].count / (targets.entries_per_week || 5)) * 100);
    const convScore = Math.min(100, (convR.rows[0].count / (targets.conversations_per_week || 3)) * 100);
    const score = Math.round(kbScore * 0.6 + convScore * 0.4);
    return {
      score: Math.min(100, score),
      detail: { kb_entries_7d: kbR.rows[0].count, conversations_7d: convR.rows[0].count }
    };
  },
};

// ══════════════════════════════════════════════════════════════════
//  COMPUTE COMPOSITE SCORE
// ══════════════════════════════════════════════════════════════════

async function computeReadiness(profile, date) {
  const enabledSystems = profile.systems || Object.keys(SYSTEM_SCORERS);
  const weights = profile.weights || {};
  const systemScores = {};
  const systemDetails = {};
  let totalWeight = 0;
  let weightedSum = 0;

  for (const sys of enabledSystems) {
    const scorer = SYSTEM_SCORERS[sys];
    if (!scorer) continue;
    try {
      const result = await scorer(profile, date);
      systemScores[sys] = result.score;
      systemDetails[sys] = result.detail;
      const w = weights[sys] || 1;
      weightedSum += result.score * w;
      totalWeight += w;
    } catch (err) {
      systemScores[sys] = 0;
      systemDetails[sys] = { error: err.message };
    }
  }

  const composite = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // Compute gaps (systems below threshold)
  const thresholds = profile.thresholds || {};
  const defaultThreshold = thresholds.default || 70;
  const gaps = {};
  for (const sys of enabledSystems) {
    const threshold = thresholds[sys] || defaultThreshold;
    if ((systemScores[sys] || 0) < threshold) {
      gaps[sys] = {
        score: systemScores[sys] || 0,
        threshold,
        deficit: threshold - (systemScores[sys] || 0),
      };
    }
  }

  // Determine current phase
  let phase = null;
  if (profile.phases?.length && profile.start_date) {
    const daysSinceStart = Math.floor((new Date(date) - new Date(profile.start_date)) / 86400000);
    let accumulated = 0;
    for (const p of profile.phases) {
      accumulated += (p.weeks || 4) * 7;
      if (daysSinceStart < accumulated) { phase = p.name; break; }
    }
    if (!phase) phase = profile.phases[profile.phases.length - 1]?.name;
  }

  // Data confidence
  const systemCount = enabledSystems.length;
  const scoredCount = Object.keys(systemScores).filter(s => systemScores[s] > 0).length;
  const dataConfidence = systemCount > 0 ? +(scoredCount / systemCount).toFixed(2) : 0;

  return { composite, systemScores, systemDetails, gaps, phase, dataConfidence };
}

// ══════════════════════════════════════════════════════════════════
//  SPARTAN SPRINT SEED PROFILE
// ══════════════════════════════════════════════════════════════════

const SPARTAN_SPRINT_SEED = {
  title: 'Spartan Sprint Readiness',
  profile_type: 'spartan_sprint',
  systems: ['strength', 'nutrition', 'recovery', 'execution', 'consistency', 'body_composition'],
  weights: { strength: 2, nutrition: 1.5, recovery: 1.5, execution: 1, consistency: 1.5, body_composition: 1 },
  targets: {
    strength: { sessions_per_week: 5, min_effort: 7 },
    nutrition: { meals_per_day: 3, context_days: 5 },
    recovery: { min_rest_days: 2, metrics_per_week: 3 },
    execution: { daily_tasks: 3 },
    body_composition: { weight_lb: null, body_fat_pct: null }, // user fills in
  },
  phases: [
    { name: 'Base Building', weeks: 4 },
    { name: 'Strength Phase', weeks: 4 },
    { name: 'Race Prep', weeks: 3 },
    { name: 'Taper', weeks: 1 },
  ],
  thresholds: { default: 70, strength: 75, nutrition: 65 },
  scoring_rules: {},
  coaching_config: { enable_ai: true, gap_focus: true },
};

// ══════════════════════════════════════════════════════════════════
//  API ROUTES — Goal Profiles
// ══════════════════════════════════════════════════════════════════

// ─── Seed Spartan Sprint profile (must be before :id routes) ────
router.post('/profiles/seed/spartan-sprint', async (req, res) => {
  try {
    // Check if one already exists
    const existing = await query(`SELECT id FROM goal_profiles WHERE profile_type = 'spartan_sprint' AND status = 'active' LIMIT 1`);
    if (existing.rows.length) {
      return res.json({ message: 'Active Spartan Sprint profile already exists', profile_id: existing.rows[0].id });
    }

    const seed = { ...SPARTAN_SPRINT_SEED };
    // Merge any overrides from request
    if (req.body.goal_date) seed.goal_date = req.body.goal_date;
    if (req.body.targets) seed.targets = { ...seed.targets, ...req.body.targets };

    const { rows } = await query(
      `INSERT INTO goal_profiles (title, profile_type, systems, weights, targets, phases, thresholds, scoring_rules, coaching_config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        seed.title, seed.profile_type,
        JSON.stringify(seed.systems), JSON.stringify(seed.weights),
        JSON.stringify(seed.targets), JSON.stringify(seed.phases),
        JSON.stringify(seed.thresholds), JSON.stringify(seed.scoring_rules),
        JSON.stringify(seed.coaching_config),
      ]
    );
    logActivity('readiness', 'seed_profile', { type: 'spartan_sprint' });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── List profiles ──────────────────────────────────────────────
router.get('/profiles', async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const { rows } = await query(`SELECT * FROM goal_profiles ${where} ORDER BY created_at DESC`, params);
    res.json({ profiles: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single profile ─────────────────────────────────────────
router.get('/profiles/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM goal_profiles WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create profile ─────────────────────────────────────────────
router.post('/profiles', async (req, res) => {
  try {
    const b = req.body;
    if (!b.title || !b.profile_type) return res.status(400).json({ error: 'title and profile_type required' });

    const { rows } = await query(
      `INSERT INTO goal_profiles (title, profile_type, status, goal_date, start_date, systems, weights, targets, phases, thresholds, scoring_rules, coaching_config, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        b.title, b.profile_type, b.status || 'active',
        b.goal_date || null, b.start_date || new Date().toISOString().slice(0, 10),
        JSON.stringify(b.systems || []), JSON.stringify(b.weights || {}),
        JSON.stringify(b.targets || {}), JSON.stringify(b.phases || []),
        JSON.stringify(b.thresholds || {}), JSON.stringify(b.scoring_rules || {}),
        JSON.stringify(b.coaching_config || {}), JSON.stringify(b.metadata || {}),
      ]
    );
    logActivity('readiness', 'create_profile', { title: b.title, type: b.profile_type });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update profile ─────────────────────────────────────────────
router.put('/profiles/:id', async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const params = [];
    let i = 1;

    for (const field of ['title', 'profile_type', 'status', 'goal_date', 'start_date']) {
      if (b[field] !== undefined) { sets.push(`${field} = $${i++}`); params.push(b[field]); }
    }
    for (const jsonField of ['systems', 'weights', 'targets', 'phases', 'thresholds', 'scoring_rules', 'coaching_config', 'metadata']) {
      if (b[jsonField] !== undefined) { sets.push(`${jsonField} = $${i++}`); params.push(JSON.stringify(b[jsonField])); }
    }

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);

    const { rows } = await query(`UPDATE goal_profiles SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete profile ─────────────────────────────────────────────
router.delete('/profiles/:id', async (req, res) => {
  try {
    const { rowCount } = await query('DELETE FROM goal_profiles WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  API ROUTES — Readiness Snapshots
// ══════════════════════════════════════════════════════════════════

// ─── Compute readiness for a profile (today or specific date) ───
router.post('/compute/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;
    const date = req.body.date || new Date().toISOString().slice(0, 10);

    const profileResult = await query('SELECT * FROM goal_profiles WHERE id = $1', [profileId]);
    if (!profileResult.rows.length) return res.status(404).json({ error: 'Profile not found' });
    const profile = profileResult.rows[0];

    const result = await computeReadiness(profile, date);

    // Upsert snapshot
    const { rows } = await query(
      `INSERT INTO readiness_snapshots (profile_id, snapshot_date, composite_score, system_scores, system_details, gaps, phase, data_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (profile_id, snapshot_date) DO UPDATE SET
         composite_score = EXCLUDED.composite_score,
         system_scores = EXCLUDED.system_scores,
         system_details = EXCLUDED.system_details,
         gaps = EXCLUDED.gaps,
         phase = EXCLUDED.phase,
         data_confidence = EXCLUDED.data_confidence,
         computed_at = NOW()
       RETURNING *`,
      [
        profileId, date, result.composite,
        JSON.stringify(result.systemScores), JSON.stringify(result.systemDetails),
        JSON.stringify(result.gaps), result.phase, result.dataConfidence,
      ]
    );

    logActivity('readiness', 'compute', { profile_id: profileId, score: result.composite, date });
    res.json({ snapshot: rows[0], profile_title: profile.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get latest snapshot for a profile ──────────────────────────
router.get('/snapshots/:profileId/latest', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT s.*, p.title AS profile_title, p.profile_type
       FROM readiness_snapshots s JOIN goal_profiles p ON s.profile_id = p.id
       WHERE s.profile_id = $1 ORDER BY s.snapshot_date DESC LIMIT 1`,
      [req.params.profileId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No snapshots found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get snapshot history (for charts) ──────────────────────────
router.get('/snapshots/:profileId/history', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { rows } = await query(
      `SELECT snapshot_date, composite_score, system_scores, phase, data_confidence
       FROM readiness_snapshots
       WHERE profile_id = $1 AND snapshot_date >= (CURRENT_DATE - $2::int * INTERVAL '1 day')
       ORDER BY snapshot_date ASC`,
      [req.params.profileId, days]
    );
    res.json({ history: rows, days: +days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard: active profiles + latest scores ─────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const { rows: profiles } = await query(
      `SELECT id, title, profile_type, status, goal_date, start_date, systems, weights, thresholds
       FROM goal_profiles WHERE status = 'active' ORDER BY created_at DESC`
    );

    const dashboard = [];
    for (const p of profiles) {
      const { rows: snaps } = await query(
        `SELECT snapshot_date, composite_score, system_scores, gaps, phase, data_confidence
         FROM readiness_snapshots WHERE profile_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
        [p.id]
      );
      dashboard.push({
        profile: p,
        latest: snaps[0] || null,
        days_to_goal: p.goal_date ? Math.ceil((new Date(p.goal_date) - new Date()) / 86400000) : null,
      });
    }

    res.json({ dashboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI Coaching: generate coaching text for gaps ───────────────
router.post('/coaching/:profileId', async (req, res) => {
  try {
    const { profileId } = req.params;

    // Get latest snapshot
    const { rows: snaps } = await query(
      `SELECT * FROM readiness_snapshots WHERE profile_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [profileId]
    );
    if (!snaps.length) return res.status(404).json({ error: 'No snapshot found — compute readiness first' });

    const snapshot = snaps[0];
    const { rows: profiles } = await query('SELECT * FROM goal_profiles WHERE id = $1', [profileId]);
    if (!profiles.length) return res.status(404).json({ error: 'Profile not found' });
    const profile = profiles[0];

    const gaps = snapshot.gaps || {};
    const gapSystems = Object.keys(gaps);

    if (!gapSystems.length) {
      return res.json({
        coaching: { summary: 'All systems are above threshold. Keep it up!', recommendations: [], gaps: {} },
        snapshot_date: snapshot.snapshot_date,
      });
    }

    // Build coaching recommendations without AI (rule-based)
    const recommendations = [];
    for (const sys of gapSystems) {
      const gap = gaps[sys];
      const detail = snapshot.system_details?.[sys] || {};
      let rec = '';
      switch (sys) {
        case 'strength':
          rec = `Strength score is ${gap.score}/${gap.threshold}. ` +
            (detail.sessions_14d < 6 ? `Only ${detail.sessions_14d} sessions in 14 days — increase frequency.` :
            `Effort averaging ${detail.avg_effort} — push intensity above ${profile.targets?.strength?.min_effort || 7}.`);
          break;
        case 'nutrition':
          rec = `Nutrition score is ${gap.score}/${gap.threshold}. ` +
            (detail.days_logged < 5 ? `Only ${detail.days_logged}/7 days logged — track meals daily.` :
            `Add daily nutrition context for better scoring.`);
          break;
        case 'recovery':
          rec = `Recovery score is ${gap.score}/${gap.threshold}. ` +
            (detail.rest_days < 2 ? `Only ${detail.rest_days} rest days — schedule recovery.` :
            `Log body metrics more frequently for better tracking.`);
          break;
        case 'execution':
          rec = `Execution score is ${gap.score}/${gap.threshold}. ` +
            `${detail.today_done || 0} tasks done today, ${detail.pending || 0} pending. Focus on clearing the backlog.`;
          break;
        case 'consistency':
          rec = `Consistency score is ${gap.score}/${gap.threshold}. ` +
            `${detail.perfect_days || 0}/14 perfect ring days. Close all three rings daily.`;
          break;
        case 'body_composition':
          rec = `Body composition score is ${gap.score}/${gap.threshold}. ` +
            (detail.data_points < 3 ? `Only ${detail.data_points} data points — weigh in more often.` :
            `Current weight: ${detail.latest_weight}kg. Stay consistent with nutrition and training.`);
          break;
        case 'knowledge':
          rec = `Knowledge score is ${gap.score}/${gap.threshold}. ` +
            `${detail.kb_entries_7d || 0} entries this week. Document learnings and insights.`;
          break;
        default:
          rec = `${sys} score is ${gap.score}/${gap.threshold}. Needs attention.`;
      }
      recommendations.push({ system: sys, recommendation: rec, deficit: gap.deficit });
    }

    // Sort by biggest deficit first
    recommendations.sort((a, b) => b.deficit - a.deficit);

    const coaching = {
      summary: `${gapSystems.length} system${gapSystems.length > 1 ? 's' : ''} below threshold. Focus on: ${recommendations.slice(0, 3).map(r => r.system).join(', ')}.`,
      recommendations,
      gaps,
      composite_score: +snapshot.composite_score,
      phase: snapshot.phase,
    };

    // Save coaching text to snapshot
    await query(
      `UPDATE readiness_snapshots SET coaching_text = $1 WHERE id = $2`,
      [JSON.stringify(coaching), snapshot.id]
    );

    res.json({ coaching, snapshot_date: snapshot.snapshot_date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
