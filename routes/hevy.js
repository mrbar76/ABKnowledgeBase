// Hevy integration. Two-way sync between AB Brain and Hevy
// (https://hevy.com), the strength-training app.
//
//   PUSH: Coach generates today's daily_plan → POST /api/hevy/push-plan
//         creates a Hevy routine the user opens at the gym.
//   PULL: After workout, /api/hevy/sync pulls completed Hevy workouts
//         into AB Brain workouts table, deduped by hevy_id. Apple Watch
//         HR data flows in via the existing HAE pipeline; the
//         dedupeAppleWorkouts() pass merges the two by started_at
//         window.
//
// Auth: HEVY_API_KEY env var, sent as `x-api-key` header (confirmed
// via api.hevyapp.com CORS allowlist).
//
// **Hevy Pro required.** Per the spec preamble: "Currently, this API is
// only available to Hevy Pro users." Generate the key at:
//   https://hevy.com/settings?developer
//
// Endpoint inventory (verified from api.hevyapp.com/docs spec, May 2026):
//   GET  /v1/user/info
//   GET  /v1/workouts?page=N&pageSize=M
//   GET  /v1/workouts/count
//   GET  /v1/workouts/events  (deltas since timestamp)
//   GET  /v1/workouts/{id}
//   POST /v1/workouts
//   PUT  /v1/workouts/{id}
//   GET  /v1/routines
//   GET  /v1/routines/{id}
//   POST /v1/routines
//   PUT  /v1/routines/{id}
//   GET  /v1/exercise_templates?page=N&pageSize=M
//   GET  /v1/exercise_templates/{id}
//   POST /v1/exercise_templates  (create custom)
//   GET  /v1/exercise_history/{exerciseTemplateId}
//   GET  /v1/routine_folders
//   POST /v1/routine_folders
//   GET  /v1/body_measurements
//   POST /v1/body_measurements
//   PUT  /v1/body_measurements/{date}
//
// Workout schema: id, title, routine_id, description, start_time,
// end_time, exercises:[{ index, title, notes, exercise_template_id,
// supersets_id, sets:[{ index, type, weight_kg, reps, distance_meters,
// duration_seconds, rpe, custom_metric }] }]
//
// Routine schema: id, title, folder_id, exercises:[{ index, title,
// rest_seconds, notes, exercise_template_id, supersets_id, sets:[{
// index, type, weight_kg, reps, rep_range:{start,end}, distance_meters,
// duration_seconds, rpe, custom_metric }] }]

const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const HEVY_BASE = 'https://api.hevyapp.com/v1';
const HEVY_API_KEY = process.env.HEVY_API_KEY;

// ─── Helpers ────────────────────────────────────────────────────

function requireKey(res) {
  if (!HEVY_API_KEY) {
    res.status(500).json({ error: 'HEVY_API_KEY env var not set on the server' });
    return false;
  }
  return true;
}

async function hevyFetch(path, opts = {}) {
  const url = `${HEVY_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      // Hevy expects the lowercase `x-api-key` header (confirmed via
      // CORS allowlist on api.hevyapp.com).
      'x-api-key': HEVY_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hevy ${opts.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Best-effort mapping of an AB Brain workout_type to a Hevy routine
// title prefix. Hevy doesn't categorize routines by modality; the
// title is the only place this surfaces.
const TYPE_PREFIX = {
  hill: '🏔 Hill',
  strength: '🏋 Strength',
  run: '🏃 Run',
  hybrid: '🔥 Hybrid',
  recovery: '🧘 Recovery',
  ruck: '🎒 Ruck',
};

// Map a daily_plans row + its planned_exercises into a Hevy routine
// payload. Hevy routine shape (per docs): { title, folder_id?, notes?,
// exercises: [{ exercise_template_id, sets: [{ type, weight_kg, reps,
// distance_meters?, duration_seconds? }], notes? }] }.
//
// AB Brain stores planned_exercises as JSONB with a flexible shape;
// caller provides them already resolved. exercise_template_id is the
// Hevy ID — caller must look up via /api/hevy/exercise-templates first.
function mapPlanToHevyRoutine(plan, planned_exercises) {
  const prefix = TYPE_PREFIX[plan.workout_type] || '';
  const goalLine = plan.goal ? plan.goal : '';
  const rationaleLine = plan.rationale ? `Why: ${plan.rationale}` : '';
  const intentLine = plan.intent_type ? `Intent: ${plan.intent_type}` : '';
  const notes = [intentLine, goalLine, rationaleLine].filter(Boolean).join('\n');

  return {
    title: `${prefix} ${plan.plan_date}`.trim(),
    notes,
    exercises: (planned_exercises || []).map(e => ({
      exercise_template_id: e.hevy_exercise_template_id,
      notes: e.notes || '',
      sets: (e.sets || []).map(s => ({
        type: s.type || 'normal',
        weight_kg: s.weight_lb ? Math.round(s.weight_lb * 0.453592 * 100) / 100 : null,
        reps: s.reps ?? null,
        distance_meters: s.distance_meters ?? null,
        duration_seconds: s.duration_seconds ?? null,
      })),
    })).filter(e => e.exercise_template_id),
  };
}

// Map a Hevy completed workout into an AB Brain workouts row.
// Hevy workout shape (assumed): { id, title, description, start_time,
// end_time, exercises: [{ exercise_template_id, title, sets: [...] }] }.
function mapHevyWorkoutToAB(hw) {
  const startedAt = hw.start_time || hw.start_date || null;
  const endedAt = hw.end_time || hw.end_date || null;
  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  const endMs = endedAt ? new Date(endedAt).getTime() : null;
  const durSec = (startMs && endMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
  const durStr = durSec != null ? new Date(durSec * 1000).toISOString().substring(11, 19) : null;

  // Compute total volume (sum of weight_kg × reps) so coach has a
  // strength-load proxy. Convert weight_kg → lb for AB Brain consistency.
  let totalVolumeLb = 0;
  let totalSets = 0;
  for (const ex of (hw.exercises || [])) {
    for (const s of (ex.sets || [])) {
      if (s.weight_kg != null && s.reps != null) {
        totalVolumeLb += (Number(s.weight_kg) * 2.2046226218) * Number(s.reps);
        totalSets++;
      }
    }
  }

  return {
    hevy_id: hw.id,
    workout_date: startedAt ? String(startedAt).slice(0, 10) : null,
    started_at: startedAt,
    ended_at: endedAt,
    title: hw.title || 'Hevy workout',
    workout_type: 'strength',
    time_duration: durStr,
    body_notes: hw.description || null,
    total_volume_lb: Math.round(totalVolumeLb),
    total_sets: totalSets,
    source: 'hevy',
    ai_source: null,
    metadata: {
      hevy: {
        id: hw.id,
        exercise_count: (hw.exercises || []).length,
        raw_exercises: hw.exercises,
      },
    },
  };
}

// ─── GET /api/hevy/test ───────────────────────────────────────
// Sanity check the API key without doing anything destructive.
router.get('/test', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const data = await hevyFetch('/exercise_templates?page=1&pageSize=1');
    res.json({ ok: true, sample: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/hevy/exercise-templates?q=squat ────────────────
// Search Hevy's exercise catalog. Coach uses this to resolve AB Brain
// exercise names → Hevy exercise_template_id when pushing a routine.
router.get('/exercise-templates', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    // Hevy's API doesn't seem to expose search server-side, so we
    // page through and filter client-side. Cache in-memory for the
    // process lifetime to avoid re-fetching the catalog on every call.
    if (!global._hevyTemplateCache) {
      const all = [];
      let page = 1;
      while (page < 20) {
        const resp = await hevyFetch(`/exercise_templates?page=${page}&pageSize=100`);
        const items = resp.exercise_templates || resp.data || resp;
        if (!Array.isArray(items) || !items.length) break;
        all.push(...items);
        if (items.length < 100) break;
        page++;
      }
      global._hevyTemplateCache = all;
    }
    const all = global._hevyTemplateCache;
    const filtered = q
      ? all.filter(t => String(t.title || t.name || '').toLowerCase().includes(q))
      : all;
    res.json({
      total: all.length,
      matched: filtered.length,
      results: filtered.slice(0, limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/hevy/push-plan ────────────────────────────────
// Coach calls this after writing a daily_plan. Pushes the plan as a
// Hevy routine so user opens Hevy at the gym and follows it.
//
// Body: { plan_id, planned_exercises: [...] }
// where each planned_exercise has hevy_exercise_template_id + sets[].
router.post('/push-plan', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const { plan_id, planned_exercises } = req.body || {};
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });

    const planRes = await query(`SELECT * FROM daily_plans WHERE id = $1`, [plan_id]);
    const plan = planRes.rows[0];
    if (!plan) return res.status(404).json({ error: 'plan not found' });

    const routine = mapPlanToHevyRoutine(plan, planned_exercises || plan.planned_exercises || []);
    if (!routine.exercises.length) {
      return res.status(400).json({ error: 'no resolvable exercises (need hevy_exercise_template_id on each)' });
    }

    // If plan already has a hevy_routine_id, update; else create.
    let hevyRoutine;
    if (plan.hevy_routine_id) {
      hevyRoutine = await hevyFetch(`/routines/${plan.hevy_routine_id}`, {
        method: 'PUT',
        body: JSON.stringify({ routine }),
      });
    } else {
      hevyRoutine = await hevyFetch('/routines', {
        method: 'POST',
        body: JSON.stringify({ routine }),
      });
      // Hevy returns the created routine; persist its id back to AB Brain.
      const newId = hevyRoutine.id || hevyRoutine.routine?.id || hevyRoutine.routine_id;
      if (newId) {
        await query(
          `UPDATE daily_plans SET hevy_routine_id = $1, updated_at = NOW() WHERE id = $2`,
          [newId, plan_id]
        );
      }
    }

    if (typeof logActivity === 'function') {
      try { await logActivity('hevy_push', `Routine pushed for ${plan.plan_date}`, { plan_id, hevy_routine: hevyRoutine }); } catch (_) {}
    }

    res.json({ ok: true, hevy_routine: hevyRoutine });
  } catch (err) {
    console.error(`[hevy/push-plan] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/hevy/sync ──────────────────────────────────────
// Pull recent Hevy workouts into AB Brain workouts table. Idempotent
// via the hevy_id partial unique index.
//
// Query: ?since=YYYY-MM-DD (default = 30 days back)
router.post('/sync', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const sinceDate = req.query.since || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const sinceMs = new Date(sinceDate + 'T00:00:00Z').getTime();

    let inserted = 0;
    let skipped = 0;
    let page = 1;
    let kept_going = true;
    while (kept_going && page < 20) {
      const resp = await hevyFetch(`/workouts?page=${page}&pageSize=10`);
      const items = resp.workouts || resp.data || resp;
      if (!Array.isArray(items) || !items.length) break;

      for (const hw of items) {
        const startMs = hw.start_time ? new Date(hw.start_time).getTime() : 0;
        if (startMs < sinceMs) { kept_going = false; break; }
        const row = mapHevyWorkoutToAB(hw);
        if (!row.hevy_id) { skipped++; continue; }
        try {
          // Insert; conflict on hevy_id = update.
          const cols = Object.keys(row).filter(k => k !== 'metadata');
          const placeholders = cols.map((_, i) => `$${i + 1}`);
          const values = cols.map(c => row[c]);
          values.push(JSON.stringify(row.metadata));
          await query(
            `INSERT INTO workouts (${cols.join(', ')}, metadata)
             VALUES (${placeholders.join(', ')}, $${cols.length + 1}::jsonb)
             ON CONFLICT (hevy_id) WHERE hevy_id IS NOT NULL DO UPDATE SET
               title = EXCLUDED.title,
               time_duration = COALESCE(EXCLUDED.time_duration, workouts.time_duration),
               ended_at = COALESCE(EXCLUDED.ended_at, workouts.ended_at),
               body_notes = COALESCE(EXCLUDED.body_notes, workouts.body_notes),
               metadata = workouts.metadata || EXCLUDED.metadata,
               updated_at = NOW()`,
            values
          );
          inserted++;
        } catch (err) {
          console.error(`[hevy/sync] failed for ${hw.id}: ${err.message}`);
          skipped++;
        }
      }
      if (items.length < 10) break;
      page++;
    }

    res.json({ ok: true, inserted, skipped, since: sinceDate });
  } catch (err) {
    console.error(`[hevy/sync] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/hevy/routines ──────────────────────────────────
// List user's Hevy routines (so the Coach can avoid duplicating).
router.get('/routines', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const data = await hevyFetch('/routines?page=1&pageSize=20');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
