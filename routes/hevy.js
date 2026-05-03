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
//
// Plain ASCII labels — emoji ran into Hevy's title rendering issues
// (the GMT timezone string + emoji combo from the May 3 push test was
// the trigger for the cleanup).
const TYPE_PREFIX = {
  hill: 'Hill',
  strength: 'Strength',
  run: 'Run',
  hybrid: 'Hybrid',
  recovery: 'Recovery',
  ruck: 'Ruck',
  warmup: 'Warmup',
  cardio: 'Cardio',
  mobility: 'Mobility',
  cooldown: 'Cooldown',
};

// Format a plan_date (YYYY-MM-DD or Date) into a clean "May 3" label
// for routine titles. Avoids the GMT timezone garbage from
// `new Date(...).toString()` that produced titles like
// "🔥 Hybrid Sun May 03 2026 00:00:00 GMT+0000 (Coordinated Universal Time)".
function formatPlanDate(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  if (!y || !m || !day) return s;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${day}`;
}

// Map a plan + segment + its planned_exercises into a Hevy routine
// payload. Hevy routine shape (per docs): { title, folder_id?, notes?,
// exercises: [{ exercise_template_id, sets: [{ type, weight_kg, reps,
// distance_meters?, duration_seconds? }], notes? }] }.
//
// Resolve `hevy_exercise_template_id` for each exercise. Caller may
// have already filled it in (Coach can pass it directly); otherwise we
// look up via hevy_exercise_map → hevy_template_cache. Mutates the
// passed exercises array in place; returns the same array for chaining.
async function resolveTemplateIds(exercises) {
  for (const e of (exercises || [])) {
    if (e.hevy_exercise_template_id) continue;
    const name = e.name || e.exercise_name || e.title;
    if (!name) continue;
    const hit = await lookupHevyTemplateByName(name);
    if (hit) {
      e.hevy_exercise_template_id = hit.id;
      e._resolved_via = hit.source;
    }
  }
  return exercises;
}

// Caller provides exercises with `hevy_exercise_template_id` already
// resolved OR with a `name` field that we resolve via mapping table.
// Exercises that can't be resolved are dropped from the routine — Hevy
// can't store them.
function mapSegmentToHevyRoutine(plan, segment, planned_exercises, folder_id) {
  // Title precedence (per spec §4.4):
  //   1. daily_plans.hevy_routine_title (explicit override Coach sets)
  //   2. daily_plans.title (the human label Coach already wrote)
  //   3. Generated: "May 3 — Strength (Top)"
  const prefix = TYPE_PREFIX[segment?.block_label] || TYPE_PREFIX[plan.workout_type] || '';
  const goalLine = plan.goal ? plan.goal : '';
  const rationaleLine = plan.rationale ? `Why: ${plan.rationale}` : '';
  const intentLine = plan.intent_type ? `Intent: ${plan.intent_type}` : '';
  const segmentLabel = segment?.block_label ? segment.block_label.charAt(0).toUpperCase() + segment.block_label.slice(1) : '';
  const dateLabel = formatPlanDate(plan.plan_date);
  let title;
  if (plan.hevy_routine_title) {
    title = plan.hevy_routine_title;
  } else if (plan.title) {
    title = segmentLabel ? `${plan.title} (${segmentLabel})` : plan.title;
  } else {
    const generatedParts = [dateLabel, prefix && `— ${prefix}`, segmentLabel && `(${segmentLabel})`].filter(Boolean);
    title = generatedParts.join(' ').replace(/\s+/g, ' ').trim();
  }
  const notes = [intentLine, goalLine, rationaleLine, segment?.notes].filter(Boolean).join('\n');

  const routine = {
    title,
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

// ─── Template cache (postgres-backed) ─────────────────────────
//
// Hevy's catalog is ~4,300 entries across 433 pages at pageSize=10. We
// mirror it locally so /exercise-templates?q= is instant and consistent
// across deploys. The cache is refreshed manually via
// POST /api/hevy/templates/refresh and (optionally) on a weekly cron.
async function fetchAllHevyTemplates() {
  const all = [];
  let page = 1;
  // Cap at 600 pages (~6,000 exercises) to prevent runaway loops if
  // Hevy ever returns non-empty pages forever.
  while (page < 600) {
    const resp = await hevyFetch(`/exercise_templates?page=${page}&pageSize=10`);
    const items = resp.results || resp.exercise_templates || resp.data || resp;
    if (!Array.isArray(items) || !items.length) break;
    all.push(...items);
    if (items.length < 10) break;
    page++;
  }
  return all;
}

async function refreshTemplateCache() {
  const templates = await fetchAllHevyTemplates();
  // Wipe-and-rewrite. Hevy may delete templates (custom-made by us or
  // others), so an upsert-only approach would leave stale rows.
  await query(`TRUNCATE hevy_template_cache`);
  for (const t of templates) {
    await query(
      `INSERT INTO hevy_template_cache (
         hevy_id, title, type, primary_muscle_group,
         secondary_muscle_groups, equipment, is_custom, raw, cached_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (hevy_id) DO UPDATE SET
         title = EXCLUDED.title,
         type = EXCLUDED.type,
         primary_muscle_group = EXCLUDED.primary_muscle_group,
         secondary_muscle_groups = EXCLUDED.secondary_muscle_groups,
         equipment = EXCLUDED.equipment,
         is_custom = EXCLUDED.is_custom,
         raw = EXCLUDED.raw,
         cached_at = NOW()`,
      [
        t.id || t.exercise_template_id,
        t.title || t.name || '',
        t.type || t.exercise_type || 'weight_reps',
        t.primary_muscle_group || null,
        Array.isArray(t.secondary_muscle_groups) ? t.secondary_muscle_groups : null,
        t.equipment || null,
        Boolean(t.is_custom),
        JSON.stringify(t),
      ]
    );
  }
  return templates.length;
}

// ─── GET /api/hevy/exercise-templates?q=squat ────────────────
// Reads from the postgres cache first. If empty, lazy-refreshes once.
router.get('/exercise-templates', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    const limit = Math.min(Number(req.query.limit) || 25, 100);

    let { rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM hevy_template_cache`);
    if (!countRows[0].n) {
      await refreshTemplateCache();
      ({ rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM hevy_template_cache`));
    }
    const total = countRows[0].n;

    let rows;
    if (q) {
      ({ rows } = await query(
        `SELECT hevy_id AS id, title, type, primary_muscle_group, secondary_muscle_groups,
                equipment, is_custom, raw
           FROM hevy_template_cache
          WHERE lower(title) LIKE $1
          ORDER BY length(title) ASC, title ASC
          LIMIT $2`,
        [`%${q}%`, limit]
      ));
    } else {
      ({ rows } = await query(
        `SELECT hevy_id AS id, title, type, primary_muscle_group, secondary_muscle_groups,
                equipment, is_custom, raw
           FROM hevy_template_cache
          ORDER BY title ASC
          LIMIT $1`,
        [limit]
      ));
    }

    res.json({ total, matched: rows.length, results: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/hevy/templates/refresh ─────────────────────────
// Wipe + re-fetch the entire Hevy template catalog. Call after any
// custom-template POST to make the cache reflect reality.
router.post('/templates/refresh', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const cached = await refreshTemplateCache();
    res.json({ ok: true, cached });
  } catch (err) {
    console.error(`[hevy/templates/refresh] ${err.stack}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/hevy/health ─────────────────────────────────────
// Verifies the API key is valid by hitting /v1/user/info. Used by the
// frontend Settings page to show a green/red dot.
router.get('/health', async (req, res) => {
  if (!HEVY_API_KEY) {
    return res.status(200).json({ ok: false, error: 'HEVY_API_KEY not set' });
  }
  try {
    const info = await hevyFetch('/user/info');
    res.json({ ok: true, user: info });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ─── Exercise mapping (sticky AB-name → Hevy template) ────────
//
// Why this exists: Coach's per-call /exercise-templates?q= search picks
// the best title match each time, but "Standing Calf Raise" might match
// 3 templates and the rank can shuffle. A persistent map locks the
// chosen template so logs stay comparable across sessions.

async function lookupHevyTemplateByName(name) {
  // 1) hevy_exercise_map (manual or previously auto-populated)
  const mapR = await query(
    `SELECT hevy_exercise_template_id AS id, hevy_title AS title, hevy_type AS type
       FROM hevy_exercise_map
      WHERE lower(ab_brain_exercise_name) = lower($1)
      LIMIT 1`,
    [name]
  );
  if (mapR.rows.length) return { ...mapR.rows[0], source: 'map' };

  // 2) hevy_template_cache exact title match
  const exactR = await query(
    `SELECT hevy_id AS id, title, type
       FROM hevy_template_cache
      WHERE lower(title) = lower($1)
      LIMIT 1`,
    [name]
  );
  if (exactR.rows.length) return { ...exactR.rows[0], source: 'cache_exact' };

  // 3) hevy_template_cache trigram fuzzy
  const fuzzyR = await query(
    `SELECT hevy_id AS id, title, type, similarity(title, $1) AS sim
       FROM hevy_template_cache
      WHERE title % $1
      ORDER BY sim DESC
      LIMIT 1`,
    [name]
  );
  if (fuzzyR.rows.length && Number(fuzzyR.rows[0].sim) > 0.35) {
    return { ...fuzzyR.rows[0], source: 'cache_fuzzy' };
  }

  return null;
}

// GET /api/hevy/exercise-map — list all mappings
router.get('/exercise-map', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM hevy_exercise_map ORDER BY ab_brain_exercise_name ASC`);
    res.json({ count: rows.length, mappings: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hevy/exercise-map — upsert a mapping
router.post('/exercise-map', async (req, res) => {
  try {
    const {
      ab_brain_exercise_name,
      ab_brain_exercise_id,
      hevy_exercise_template_id,
      hevy_title,
      hevy_type,
      hevy_primary_muscle_group,
      hevy_equipment,
      is_custom,
      confidence,
      notes,
    } = req.body || {};
    if (!ab_brain_exercise_name || !hevy_exercise_template_id) {
      return res.status(400).json({ error: 'ab_brain_exercise_name and hevy_exercise_template_id required' });
    }
    // If hevy_title/type omitted, fill from cache.
    let title = hevy_title, type = hevy_type;
    if (!title || !type) {
      const { rows } = await query(
        `SELECT title, type FROM hevy_template_cache WHERE hevy_id = $1`,
        [hevy_exercise_template_id]
      );
      if (rows[0]) { title = title || rows[0].title; type = type || rows[0].type; }
    }
    if (!title || !type) {
      return res.status(400).json({ error: 'hevy_title/hevy_type required (or refresh template cache first)' });
    }

    const { rows } = await query(
      `INSERT INTO hevy_exercise_map (
         ab_brain_exercise_name, ab_brain_exercise_id, hevy_exercise_template_id,
         hevy_title, hevy_type, hevy_primary_muscle_group, hevy_equipment,
         is_custom, confidence, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (lower(ab_brain_exercise_name)) DO UPDATE SET
         hevy_exercise_template_id = EXCLUDED.hevy_exercise_template_id,
         hevy_title = EXCLUDED.hevy_title,
         hevy_type = EXCLUDED.hevy_type,
         hevy_primary_muscle_group = EXCLUDED.hevy_primary_muscle_group,
         hevy_equipment = EXCLUDED.hevy_equipment,
         is_custom = EXCLUDED.is_custom,
         confidence = EXCLUDED.confidence,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [
        ab_brain_exercise_name,
        ab_brain_exercise_id || null,
        hevy_exercise_template_id,
        title,
        type,
        hevy_primary_muscle_group || null,
        hevy_equipment || null,
        Boolean(is_custom),
        confidence || 'manual',
        notes || null,
      ]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/hevy/exercise-map/:id — partial update
router.put('/exercise-map/:id', async (req, res) => {
  try {
    const allowed = ['ab_brain_exercise_name','ab_brain_exercise_id','hevy_exercise_template_id','hevy_title','hevy_type','hevy_primary_muscle_group','hevy_equipment','is_custom','confidence','notes'];
    const fields = [];
    const vals = [];
    let i = 1;
    for (const f of allowed) {
      if (req.body[f] === undefined) continue;
      fields.push(`${f} = $${i++}`);
      vals.push(req.body[f]);
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = NOW()');
    vals.push(req.params.id);
    const { rows } = await query(
      `UPDATE hevy_exercise_map SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/hevy/exercise-map/:id
router.delete('/exercise-map/:id', async (req, res) => {
  try {
    const { rows } = await query(`DELETE FROM hevy_exercise_map WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hevy/exercise-map/auto-populate
//
// For every distinct exercise name referenced in plan_segments
// .planned_exercises[].name (or daily_plans.planned_exercises) that
// isn't already mapped, look up a Hevy template via the cache. Three
// outcome buckets:
//   mapped:    confident match auto-inserted
//   ambiguous: multiple cache hits, awaiting manual review
//   unmapped:  no match — Coach should propose creating a custom template
router.post('/exercise-map/auto-populate', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    // Ensure cache has data — auto-populate is useless without it.
    const { rows: cacheCount } = await query(`SELECT COUNT(*)::int AS n FROM hevy_template_cache`);
    if (!cacheCount[0].n) await refreshTemplateCache();

    // Gather distinct names from segments + plans.
    const { rows: nameRows } = await query(`
      SELECT DISTINCT lower(coalesce(e->>'name', e->>'exercise_name', e->>'title')) AS name
      FROM (
        SELECT jsonb_array_elements(planned_exercises) AS e FROM plan_segments
        UNION ALL
        SELECT jsonb_array_elements(planned_exercises) AS e FROM daily_plans
      ) sub
      WHERE coalesce(e->>'name', e->>'exercise_name', e->>'title') IS NOT NULL
    `);
    const names = nameRows.map(r => r.name).filter(Boolean);

    const { rows: existing } = await query(`SELECT lower(ab_brain_exercise_name) AS n FROM hevy_exercise_map`);
    const have = new Set(existing.map(r => r.n));

    const mapped = [];
    const ambiguous = [];
    const unmapped = [];

    for (const name of names) {
      if (have.has(name)) continue;
      const hit = await lookupHevyTemplateByName(name);
      if (!hit) { unmapped.push(name); continue; }
      if (hit.source === 'cache_fuzzy') {
        // Don't auto-commit fuzzy. Surface for review.
        ambiguous.push({ name, suggestion: hit });
        continue;
      }
      // Exact cache match — confident enough to auto-insert.
      await query(
        `INSERT INTO hevy_exercise_map (
           ab_brain_exercise_name, hevy_exercise_template_id, hevy_title, hevy_type, confidence
         ) VALUES ($1, $2, $3, $4, 'auto')
         ON CONFLICT (lower(ab_brain_exercise_name)) DO NOTHING`,
        [name, hit.id, hit.title, hit.type]
      );
      mapped.push({ name, hevy_id: hit.id, hevy_title: hit.title });
    }

    res.json({
      mapped: mapped.length,
      ambiguous: ambiguous.length,
      unmapped: unmapped.length,
      details: { mapped, ambiguous, unmapped },
    });
  } catch (err) {
    console.error(`[hevy/exercise-map/auto-populate] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// Push one segment's prescribed exercises as a Hevy routine. The
// segment's hevy_routine_id is updated in place. Returns
// { ok, hevy_routine, segment_id, error }.
async function pushSegmentToHevy(planRow, segment, folderId) {
  if (!HEVY_API_KEY) return { ok: false, skipped: 'no_api_key' };
  const exercises = segment?.planned_exercises || [];
  await resolveTemplateIds(exercises);
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
  await resolveTemplateIds(exercises);
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
//
// Cursor: if `since` is omitted, we read the durable cursor from
// sync_state(source='hevy_workouts'). After a successful pass, we
// persist the latest start_time we saw so the next call advances. This
// survives restarts.
async function syncHevyWorkouts(since) {
  if (!HEVY_API_KEY) return { ok: false, skipped: 'no_api_key', inserted: 0 };

  // Resolve effective `since`:
  //   1. Explicit param (caller override)
  //   2. sync_state.cursor for 'hevy_workouts'
  //   3. 30 days back (first-ever run)
  let sinceDate = since;
  if (!sinceDate) {
    const { rows } = await query(`SELECT cursor FROM sync_state WHERE source = 'hevy_workouts'`);
    if (rows[0]?.cursor) sinceDate = String(rows[0].cursor).slice(0, 10);
  }
  if (!sinceDate) {
    sinceDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  }
  const sinceMs = new Date(sinceDate + 'T00:00:00Z').getTime();
  let latestSeenMs = sinceMs;

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
      if (startMs > latestSeenMs) latestSeenMs = startMs;
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

  // Advance the durable cursor. We push it forward by 1ms past the
  // newest workout we saw so the next call doesn't re-fetch the same
  // top row. If no new workouts, the cursor stays put.
  if (latestSeenMs > sinceMs) {
    const nextCursor = new Date(latestSeenMs + 1).toISOString();
    await query(
      `INSERT INTO sync_state (source, cursor, last_synced_at, stats, updated_at)
       VALUES ('hevy_workouts', $1, NOW(), $2::jsonb, NOW())
       ON CONFLICT (source) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         last_synced_at = NOW(),
         stats = EXCLUDED.stats,
         updated_at = NOW()`,
      [nextCursor, JSON.stringify({ inserted, skipped, linked })]
    );
  }

  return { ok: true, inserted, skipped, linked, since: sinceDate, cursor_advanced_to: latestSeenMs > sinceMs ? new Date(latestSeenMs).toISOString() : null };
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

// ─── POST /api/hevy/body-measurements/sync ────────────────────
//
// Push AB Brain body_metrics rows up to Hevy as body_measurements.
// Hevy's PUT /v1/body_measurements/{date} is upsert — but it
// OVERWRITES every field and sets omitted fields to null. So for any
// given date we:
//   1. GET the existing Hevy record (if any)
//   2. Merge our AB-Brain numbers on top
//   3. PUT the merged result
//
// Body: { since: 'YYYY-MM-DD' } (default = 30 days back)
//
// Conversions:
//   weight_lb     → weight_kg            (lb × 0.453592)
//   muscle_mass_lb → muscle_mass_kg
//   bone_mass_lb  → bone_mass_kg
//   body_fat_pct  → fat_percent
//   body_water_pct → water_percent
function lbToKg(lb) {
  if (lb == null) return null;
  return Math.round(Number(lb) * 0.453592 * 100) / 100;
}

function abMetricsToHevy(row) {
  return {
    weight_kg: lbToKg(row.weight_lb),
    fat_percent: row.body_fat_pct != null ? Number(row.body_fat_pct) : null,
    muscle_mass_kg: lbToKg(row.muscle_mass_lb),
    bone_mass_kg: lbToKg(row.bone_mass_lb),
    water_percent: row.body_water_pct != null ? Number(row.body_water_pct) : null,
    bmi: row.bmi != null ? Number(row.bmi) : null,
    bmr_kcal: row.bmr_kcal != null ? Number(row.bmr_kcal) : null,
    visceral_fat_rating: row.visceral_fat != null ? Number(row.visceral_fat) : null,
  };
}

async function getHevyMeasurement(date) {
  // Hevy returns 404 when no measurement exists for the date.
  try {
    return await hevyFetch(`/body_measurements/${date}`);
  } catch (err) {
    if (/→ 404/.test(err.message)) return null;
    throw err;
  }
}

router.post('/body-measurements/sync', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const since = req.body?.since || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    // One row per date — pick the latest measurement of the day so
    // morning + evening RENPHO scans collapse cleanly.
    const { rows } = await query(
      `SELECT DISTINCT ON (measurement_date)
              measurement_date, weight_lb, body_fat_pct, muscle_mass_lb,
              bone_mass_lb, body_water_pct, bmi, bmr_kcal, visceral_fat
         FROM body_metrics
        WHERE measurement_date >= $1
        ORDER BY measurement_date DESC, measurement_time DESC NULLS LAST, created_at DESC`,
      [since]
    );

    let pushed = 0;
    let merged = 0;
    let skipped = 0;
    const errors = [];

    for (const row of rows) {
      const date = String(row.measurement_date).slice(0, 10);
      const ab = abMetricsToHevy(row);

      // Skip if every AB field is null — nothing to push.
      if (!Object.values(ab).some(v => v != null)) { skipped++; continue; }

      // Merge with existing Hevy record so PUT doesn't null fields we
      // didn't supply but Hevy already had (e.g. user edited fat % on
      // their phone).
      let payload = ab;
      try {
        const existing = await getHevyMeasurement(date);
        if (existing) {
          merged++;
          payload = { ...existing, ...Object.fromEntries(Object.entries(ab).filter(([_, v]) => v != null)) };
          // Strip server-managed fields Hevy will reject on PUT.
          delete payload.id;
          delete payload.date;
          delete payload.created_at;
          delete payload.updated_at;
        }
      } catch (err) {
        errors.push({ date, phase: 'get', error: err.message });
        continue;
      }

      try {
        await hevyFetch(`/body_measurements/${date}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        pushed++;
      } catch (err) {
        errors.push({ date, phase: 'put', error: err.message });
      }
    }

    if (typeof logActivity === 'function') {
      try { await logActivity('hevy_body_sync', null, null, null, `Pushed ${pushed} body measurements (${merged} merged, ${skipped} empty)`); } catch (_) {}
    }

    res.json({ ok: true, considered: rows.length, pushed, merged, skipped, errors });
  } catch (err) {
    console.error(`[hevy/body-measurements/sync] ${err.stack}`);
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
// Exposed for unit tests in tests/hevy.test.js. Don't import these
// elsewhere — they're internal helpers.
module.exports._test = {
  mapSegmentToHevyRoutine,
  mapPlanToHevyRoutine,
  mapHevyWorkoutToAB,
  formatPlanDate,
  abMetricsToHevy,
  lbToKg,
  TYPE_PREFIX,
};
