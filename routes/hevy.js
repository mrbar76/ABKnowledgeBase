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
      // Hevy expects the literal `api-key` header (no x- prefix).
      // Confirmed from the OpenAPI spec parameter definitions:
      //   { "name": "api-key", "in": "header" }
      // The CORS allowlist on api.hevyapp.com lists both `api-key` and
      // `x-api-key`, but only the former is the real auth header.
      // (Earlier commit 675e22a flipped this to x-api-key based on the
      // CORS list and produced 401: InvalidApiKey for valid Pro keys.)
      'api-key': HEVY_API_KEY,
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

// Best-effort mapping of an AB Brain workout_type / block_label to a
// Hevy routine title prefix. Hevy doesn't categorize routines by
// modality; the title is the only place this surfaces.
const TYPE_PREFIX = {
  hill: '🏔 Hill',
  strength: '🏋 Strength',
  run: '🏃 Run',
  hybrid: '🔥 Hybrid',
  recovery: '🧘 Recovery',
  ruck: '🎒 Ruck',
  warmup: '🧘 Warmup',
  cardio: '🏃 Cardio',
  mobility: '🧘 Mobility',
  cooldown: '🧘 Cooldown',
};

// Map a plan + segment + its planned_exercises into a Hevy routine
// payload. Hevy routine shape (per docs): { title, folder_id?, notes?,
// exercises: [{ exercise_template_id, sets: [{ type, weight_kg, reps,
// distance_meters?, duration_seconds? }], notes? }] }.
//
// Caller provides exercises with `hevy_exercise_template_id` already
// resolved (see /api/hevy/exercise-templates search). Exercises without
// a template id are skipped — Hevy can't store them as routine entries.
function mapSegmentToHevyRoutine(plan, segment, planned_exercises, folder_id) {
  const prefix = TYPE_PREFIX[segment?.block_label] || TYPE_PREFIX[plan.workout_type] || '';
  const goalLine = plan.goal ? plan.goal : '';
  const rationaleLine = plan.rationale ? `Why: ${plan.rationale}` : '';
  const intentLine = plan.intent_type ? `Intent: ${plan.intent_type}` : '';
  const segmentLabel = segment?.block_label ? segment.block_label.charAt(0).toUpperCase() + segment.block_label.slice(1) : '';
  const titleParts = [prefix, plan.plan_date, segmentLabel ? `(${segmentLabel})` : ''].filter(Boolean);
  const notes = [intentLine, goalLine, rationaleLine, segment?.notes].filter(Boolean).join('\n');

  const routine = {
    title: titleParts.join(' ').trim(),
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

  // Hevy POST /routines requires a folder_id. Caller passes folder_id;
  // fall back to env var HEVY_ROUTINE_FOLDER_ID if set. Field name is
  // strictly `folder_id` — Hevy rejects `routine_folder_id`.
  const fid = folder_id || process.env.HEVY_ROUTINE_FOLDER_ID;
  if (fid) routine.folder_id = fid;

  return routine;
}

// Legacy wrapper kept for the explicit /push-plan body shape that
// pre-dates segments. Synth a one-segment payload.
function mapPlanToHevyRoutine(plan, planned_exercises, folder_id) {
  const fakeSegment = { block_label: plan.workout_type, notes: '' };
  return mapSegmentToHevyRoutine(plan, fakeSegment, planned_exercises, folder_id);
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
      // Hevy's max pageSize is 10 (verified via Coach dry-run May 3 2026
      // — pageSize=20+ returns validation error). Catalog has hundreds of
      // exercises, so we need many pages. Cap at page 200 to prevent
      // runaway loops if Hevy returns non-empty pages forever.
      while (page < 200) {
        const resp = await hevyFetch(`/exercise_templates?page=${page}&pageSize=10`);
        // Hevy's actual response key is `results` (verified 2026-05-03).
        // Keeping the other fallbacks for forward-compat.
        const items = resp.results || resp.exercise_templates || resp.data || resp;
        if (!Array.isArray(items) || !items.length) break;
        all.push(...items);
        if (items.length < 10) break;
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

// Push one segment's prescribed exercises as a Hevy routine. The
// segment's hevy_routine_id is updated in place. Returns
// { ok, hevy_routine, segment_id, error }.
async function pushSegmentToHevy(planRow, segment, folderId) {
  if (!HEVY_API_KEY) return { ok: false, skipped: 'no_api_key' };
  const exercises = segment?.planned_exercises || [];
  const routine = mapSegmentToHevyRoutine(planRow, segment, exercises, folderId);
  if (!routine.exercises.length) {
    return { ok: false, segment_id: segment?.id, skipped: 'no_resolvable_exercises' };
  }
  if (!routine.folder_id) {
    return { ok: false, segment_id: segment?.id, error: 'no folder_id (set HEVY_ROUTINE_FOLDER_ID env var or pass folder_id in body)' };
  }

  let hevyRoutine;
  if (segment?.hevy_routine_id) {
    hevyRoutine = await hevyFetch(`/routines/${segment.hevy_routine_id}`, {
      method: 'PUT',
      body: JSON.stringify({ routine }),
    });
  } else {
    hevyRoutine = await hevyFetch('/routines', {
      method: 'POST',
      body: JSON.stringify({ routine }),
    });
    const newId = hevyRoutine.id || hevyRoutine.routine?.id || hevyRoutine.routine_id;
    if (newId && segment?.id) {
      await query(
        `UPDATE plan_segments SET hevy_routine_id = $1, updated_at = NOW() WHERE id = $2`,
        [newId, segment.id]
      );
      // Mirror onto daily_plans.hevy_routine_id for the first hevy
      // segment so legacy clients (Today card badge) keep working.
      if (segment.block_order === 0 || segment.block_order == null) {
        await query(
          `UPDATE daily_plans SET hevy_routine_id = $1, updated_at = NOW() WHERE id = $2`,
          [newId, planRow.id]
        );
      }
    }
  }

  return { ok: true, segment_id: segment?.id, hevy_routine: hevyRoutine };
}

// Reusable helper: push a daily_plan to Hevy. With the segments model
// we walk plan_segments where logging_target='hevy' and push each as
// its own routine. The legacy single-routine flow is preserved as a
// fallback when no segments exist (e.g., pre-migration plans).
//
// Returns { ok, segments_pushed, results, error } when segments were
// found, or { ok, hevy_routine, error } for the legacy single-routine
// path. Silent no-op when HEVY_API_KEY is missing or no segment routes
// to Hevy.
async function pushPlanToHevy(planRow, suppliedExercises, folderId) {
  if (!HEVY_API_KEY) return { ok: false, skipped: 'no_api_key' };
  if (!planRow) return { ok: false, error: 'plan not found' };

  // Prefer segment-aware push: load segments and push each Hevy-target
  // segment. If no segments exist (pre-migration plan), fall back to
  // the legacy flat-exercises payload.
  const segR = await query(
    `SELECT * FROM plan_segments WHERE daily_plan_id = $1 ORDER BY block_order`,
    [planRow.id]
  );
  const hevySegments = segR.rows.filter(s => s.logging_target === 'hevy');

  if (hevySegments.length > 0) {
    const results = [];
    for (const seg of hevySegments) {
      try {
        const r = await pushSegmentToHevy(planRow, seg, folderId);
        results.push(r);
      } catch (err) {
        results.push({ ok: false, segment_id: seg.id, error: err.message });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    if (typeof logActivity === 'function') {
      try { await logActivity('hevy_push', 'daily_plan', planRow.id, null, `Pushed ${okCount}/${hevySegments.length} segments for ${planRow.plan_date}`); } catch (_) {}
    }
    return {
      ok: okCount > 0,
      segments_pushed: okCount,
      total_hevy_segments: hevySegments.length,
      results,
    };
  }

  // Legacy fallback: only pushable workout_types, single routine.
  const PUSHABLE_TYPES = new Set(['strength', 'hybrid', 'hill']);
  if (!PUSHABLE_TYPES.has(planRow.workout_type)) {
    return { ok: false, skipped: 'workout_type_not_pushable' };
  }
  const exercises = suppliedExercises || planRow.planned_exercises || [];
  const routine = mapPlanToHevyRoutine(planRow, exercises, folderId);
  if (!routine.exercises.length) return { ok: false, skipped: 'no_resolvable_exercises' };
  if (!routine.folder_id) return { ok: false, error: 'no folder_id (set HEVY_ROUTINE_FOLDER_ID env var or pass folder_id in body)' };

  let hevyRoutine;
  if (planRow.hevy_routine_id) {
    hevyRoutine = await hevyFetch(`/routines/${planRow.hevy_routine_id}`, {
      method: 'PUT',
      body: JSON.stringify({ routine }),
    });
  } else {
    hevyRoutine = await hevyFetch('/routines', {
      method: 'POST',
      body: JSON.stringify({ routine }),
    });
    const newId = hevyRoutine.id || hevyRoutine.routine?.id || hevyRoutine.routine_id;
    if (newId) {
      await query(
        `UPDATE daily_plans SET hevy_routine_id = $1, updated_at = NOW() WHERE id = $2`,
        [newId, planRow.id]
      );
    }
  }

  if (typeof logActivity === 'function') {
    try { await logActivity('hevy_push', 'daily_plan', planRow.id, null, `Routine pushed for ${planRow.plan_date}`); } catch (_) {}
  }

  return { ok: true, hevy_routine: hevyRoutine };
}

// ─── POST /api/hevy/push-plan ────────────────────────────────
// Coach calls this after writing a daily_plan. Pushes the plan as a
// Hevy routine so user opens Hevy at the gym and follows it.
//
// Body: { plan_id, planned_exercises: [...] }
// where each planned_exercise has hevy_exercise_template_id + sets[].
router.post('/push-plan', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const { plan_id, planned_exercises, folder_id, routine_folder_id } = req.body || {};
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });

    const planRes = await query(`SELECT * FROM daily_plans WHERE id = $1`, [plan_id]);
    const plan = planRes.rows[0];
    if (!plan) return res.status(404).json({ error: 'plan not found' });

    const result = await pushPlanToHevy(plan, planned_exercises, folder_id || routine_folder_id);
    if (!result.ok) {
      return res.status(result.skipped ? 200 : 400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error(`[hevy/push-plan] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/hevy/routine-folders ────────────────────────────
// List user's existing folders so client can pick one. Hevy POST /routines
// rejects without a folder_id — this endpoint solves the chicken-and-egg.
router.get('/routine-folders', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const data = await hevyFetch('/routine_folders?page=1&pageSize=10');
    const items = data.routine_folders || data.results || data.data || data;
    res.json({ count: Array.isArray(items) ? items.length : 0, folders: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/hevy/routine-folders ───────────────────────────
// Create a folder if needed. Body: { title }. Returns the new folder
// including its id. Useful for first-time setup ("AB Brain Plans").
router.post('/routine-folders', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const title = req.body?.title || 'AB Brain Plans';
    const data = await hevyFetch('/routine_folders', {
      method: 'POST',
      body: JSON.stringify({ routine_folder: { title } }),
    });
    res.json({ ok: true, folder: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reusable helper. Pulls Hevy workouts since a date and upserts them
// into AB Brain `workouts`, deduped by hevy_id. After each upsert,
// auto-links the row to the daily_plan + hevy-target plan_segment for
// the workout's date. Returns { ok, inserted, skipped, linked, since }.
async function syncHevyWorkouts(since) {
  if (!HEVY_API_KEY) return { ok: false, skipped: 'no_api_key', inserted: 0 };
  const sinceDate = since || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const sinceMs = new Date(sinceDate + 'T00:00:00Z').getTime();

  let inserted = 0;
  let skipped = 0;
  let linked = 0;
  let page = 1;
  let kept_going = true;
  while (kept_going && page < 20) {
    const resp = await hevyFetch(`/workouts?page=${page}&pageSize=10`);
    const items = resp.results || resp.workouts || resp.data || resp;
    if (!Array.isArray(items) || !items.length) break;

    for (const hw of items) {
      const startMs = hw.start_time ? new Date(hw.start_time).getTime() : 0;
      if (startMs < sinceMs) { kept_going = false; break; }
      const row = mapHevyWorkoutToAB(hw);
      if (!row.hevy_id) { skipped++; continue; }
      try {
        // Build column list from the row keys. All of these are now
        // real columns on `workouts` (total_volume_lb, total_sets, and
        // ended_at were added in the Phase N migration; before that
        // INSERT was silently dropping them).
        const cols = Object.keys(row).filter(k => k !== 'metadata');
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const values = cols.map(c => row[c]);
        values.push(JSON.stringify(row.metadata));
        const upsert = await query(
          `INSERT INTO workouts (${cols.join(', ')}, metadata)
           VALUES (${placeholders.join(', ')}, $${cols.length + 1}::jsonb)
           ON CONFLICT (hevy_id) WHERE hevy_id IS NOT NULL DO UPDATE SET
             title = EXCLUDED.title,
             time_duration = COALESCE(EXCLUDED.time_duration, workouts.time_duration),
             started_at = COALESCE(EXCLUDED.started_at, workouts.started_at),
             ended_at = COALESCE(EXCLUDED.ended_at, workouts.ended_at),
             body_notes = COALESCE(EXCLUDED.body_notes, workouts.body_notes),
             total_volume_lb = COALESCE(EXCLUDED.total_volume_lb, workouts.total_volume_lb),
             total_sets = COALESCE(EXCLUDED.total_sets, workouts.total_sets),
             metadata = workouts.metadata || EXCLUDED.metadata,
             updated_at = NOW()
           RETURNING id`,
          values
        );
        inserted++;

        // Auto-link to today's plan + hevy segment.
        const wid = upsert.rows[0]?.id;
        if (wid && row.workout_date) {
          const linkR = await query(
            `SELECT dp.id AS plan_id, ps.id AS segment_id
             FROM daily_plans dp
             LEFT JOIN plan_segments ps
               ON ps.daily_plan_id = dp.id AND ps.logging_target = 'hevy'
             WHERE dp.plan_date = $1
             ORDER BY ps.block_order NULLS LAST
             LIMIT 1`,
            [row.workout_date]
          );
          if (linkR.rows[0]?.plan_id) {
            await query(
              `UPDATE workouts
               SET daily_plan_id = $1,
                   plan_segment_id = COALESCE(plan_segment_id, $2),
                   updated_at = NOW()
               WHERE id = $3 AND daily_plan_id IS NULL`,
              [linkR.rows[0].plan_id, linkR.rows[0].segment_id, wid]
            );
            if (linkR.rows[0].segment_id) {
              await query(
                `UPDATE plan_segments SET status = 'completed', updated_at = NOW()
                 WHERE id = $1 AND status IN ('planned','in_progress')`,
                [linkR.rows[0].segment_id]
              );
              linked++;
            }
          }
        }
      } catch (err) {
        console.error(`[hevy/sync] failed for ${hw.id}: ${err.message}`);
        skipped++;
      }
    }
    if (items.length < 10) break;
    page++;
  }

  return { ok: true, inserted, skipped, linked, since: sinceDate };
}

// ─── POST /api/hevy/sync ──────────────────────────────────────
// Pull recent Hevy workouts into AB Brain workouts table. Idempotent
// via the hevy_id partial unique index. Auto-links each pulled workout
// to today's plan + hevy segment for clean plan-vs-actual rollups.
//
// Query: ?since=YYYY-MM-DD (default = 30 days back)
router.post('/sync', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const result = await syncHevyWorkouts(req.query.since);
    res.json(result);
  } catch (err) {
    console.error(`[hevy/sync] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/hevy/exercise-templates ─────────────────────────
// Add a custom exercise to the user's Hevy library. Body: { title,
// muscle_group?, equipment?, notes? }. Used by the morning-check-in
// skill when the Coach hits a prescribed exercise that Hevy's catalog
// doesn't already contain (e.g., "Cat Cow", "Ankle Alphabet"). The user
// confirms in the morning brief; this proxy POSTs to Hevy.
router.post('/exercise-templates', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const { title, muscle_group, equipment, notes } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const payload = {
      exercise_template: {
        title,
        primary_muscle_group: muscle_group || 'other',
        equipment: equipment || 'none',
        notes: notes || '',
      },
    };
    const data = await hevyFetch('/exercise_templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // Bust the catalog cache so the new template appears in subsequent
    // searches without restarting the process.
    if (global._hevyTemplateCache) global._hevyTemplateCache = null;
    res.json({ ok: true, template: data });
  } catch (err) {
    console.error(`[hevy/exercise-templates] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/hevy/routines ──────────────────────────────────
// List user's Hevy routines (so the Coach can avoid duplicating).
router.get('/routines', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const data = await hevyFetch('/routines?page=1&pageSize=10');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.pushPlanToHevy = pushPlanToHevy;
module.exports.pushSegmentToHevy = pushSegmentToHevy;
module.exports.syncHevyWorkouts = syncHevyWorkouts;
