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
const { query, withTransaction, logActivity } = require('../db');
const router = express.Router();

const HEVY_BASE = 'https://api.hevyapp.com/v1';
const HEVY_API_KEY = process.env.HEVY_API_KEY;

// v3.13: hardcoded fallback for the AB Brain "Plans" routine folder.
// Single-user app, single Hevy account, single landing folder for
// auto-pushed plan routines. Pre-v3.13, leaving HEVY_ROUTINE_FOLDER_ID
// unset on deploy caused every push to fail with `no folder_id`. This
// fallback eliminates that whole failure mode while preserving the env
// var override for any future change of folder.
const DEFAULT_HEVY_ROUTINE_FOLDER_ID = 2804154;

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
  // Title precedence:
  //   1. daily_plans.hevy_routine_title       (full override, rare)
  //   2. plan.title + segment.title_suffix    ("Strength A · Main Lift")
  //   3. plan.title + Capitalized(block_label)("Strength A (Strength)")
  //   4. Generated from date + workout_type   ("May 3 — Strength")
  //
  // title_suffix (added in v1.8.4) is the canonical disambiguator.
  // Coach sets it when two segments share a block_label (e.g. "Main
  // Lift" vs "Grip" both block_label='strength'). When set, it
  // replaces the "(Strength)" parenthetical with " · Main Lift" — a
  // bullet rather than parens to make it clear it's a custom suffix.
  // When omitted and a collision exists, fall back to block_order so
  // titles stay unique even without Coach intervention.
  const prefix = TYPE_PREFIX[segment?.block_label] || TYPE_PREFIX[plan.workout_type] || '';
  const goalLine = plan.goal ? plan.goal : '';
  const rationaleLine = plan.rationale ? `Why: ${plan.rationale}` : '';
  const intentLine = plan.intent_type ? `Intent: ${plan.intent_type}` : '';
  const segmentLabel = segment?.block_label ? segment.block_label.charAt(0).toUpperCase() + segment.block_label.slice(1) : '';
  const dateLabel = formatPlanDate(plan.plan_date);
  // Coach-supplied suffix wins. Otherwise use the capitalized
  // block_label (e.g. "Strength").
  const suffix = segment?.title_suffix
    ? String(segment.title_suffix).trim()
    : segmentLabel;
  let title;
  if (plan.hevy_routine_title) {
    title = plan.hevy_routine_title;
  } else if (plan.title) {
    if (segment?.title_suffix) {
      title = `${plan.title} · ${suffix}`;
    } else if (segmentLabel) {
      title = `${plan.title} (${segmentLabel})`;
    } else {
      title = plan.title;
    }
  } else {
    const sep = segment?.title_suffix ? `· ${suffix}` : (suffix && `(${suffix})`);
    const generatedParts = [dateLabel, prefix && `— ${prefix}`, sep].filter(Boolean);
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

  // Hevy POST /routines requires a folder_id. Resolution order:
  //   1. folder_id passed in the request body (per-call override)
  //   2. HEVY_ROUTINE_FOLDER_ID env var (deploy config)
  //   3. DEFAULT_HEVY_ROUTINE_FOLDER_ID hardcoded fallback (this file)
  //
  // The hardcoded fallback (v3.13) eliminates the silent "no folder_id"
  // failure for the single-user-single-folder default case. If you ever
  // create a second routine folder in Hevy and want plans to land
  // there, set HEVY_ROUTINE_FOLDER_ID in the deploy env or pass
  // folder_id in the body.
  //
  // Field name is strictly `folder_id` — Hevy rejects
  // `routine_folder_id`.
  const fid = folder_id || process.env.HEVY_ROUTINE_FOLDER_ID || DEFAULT_HEVY_ROUTINE_FOLDER_ID;
  if (fid) routine.folder_id = fid;

  return routine;
}

// v1.11.9: Hevy raw exercise shape → AB Brain canonical exercises[] shape.
// Hevy: { exercise_template_id, title, sets: [{ weight_kg, reps, type, ... }] }
// AB Brain: { name, sets: [{ weight_lbs, reps, warmup }] }
//
// Why: lib/goal-compute.js drivers (max_weight, max_reps_single_set, etc.)
// scan workouts.exercises to recompute goals on each insert. Without this
// transform, Hevy-synced workouts had empty `exercises` and Goals 1+2
// (pull-ups, deadlift) silently never auto-updated. The data was sitting
// in metadata.hevy.raw_exercises but nothing read it.
function transformHevyExercises(hevyExercises) {
  if (!Array.isArray(hevyExercises)) return [];
  return hevyExercises.map(ex => {
    const name = ex.title || ex.exercise_template_id || 'Unknown';
    const sets = (Array.isArray(ex.sets) ? ex.sets : []).map(s => {
      const weight_kg = s.weight_kg != null ? Number(s.weight_kg) : null;
      const weight_lbs = weight_kg != null
        ? Math.round(weight_kg * 2.2046226218 * 10) / 10
        : null;
      const reps = s.reps != null ? Number(s.reps) : null;
      const isWarmup = s.type === 'warmup' || s.set_type === 'warmup';
      return {
        reps,
        weight_lbs,
        weight_kg,
        warmup: isWarmup || undefined,
        rpe: s.rpe ?? undefined,
        // Preserve set_type so Coach can distinguish failure / dropset / normal
        set_type: s.type || s.set_type || 'normal',
        distance_meters: s.distance_meters ?? undefined,
        duration_seconds: s.duration_seconds ?? undefined,
      };
    });
    return {
      name,
      hevy_exercise_template_id: ex.exercise_template_id || null,
      sets,
      notes: ex.notes || undefined,
    };
  });
}

// Map a Hevy completed workout into an AB Brain workouts row.
// Hevy workout shape: { id, title, description, start_time, end_time,
// exercises: [{ exercise_template_id, title, sets: [...] }] }.
function mapHevyWorkoutToAB(hw) {
  const startedAt = hw.start_time || hw.start_date || null;
  const endedAt = hw.end_time || hw.end_date || null;
  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  const endMs = endedAt ? new Date(endedAt).getTime() : null;
  const durSec = (startMs && endMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
  const durStr = durSec != null ? new Date(durSec * 1000).toISOString().substring(11, 19) : null;
  const durMin = durSec != null ? Math.round(durSec / 60) : null;

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
    duration_minutes: durMin,  // numeric dual so /trends + goals see it
    body_notes: hw.description || null,
    // v1.11.9: populate exercises[] from Hevy's structured set data.
    exercises: transformHevyExercises(hw.exercises),
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
// Hevy's catalog is ~4,300 entries. exercise_templates is special:
// pageSize max is 100 (not 10 like other endpoints), per the OAS. So
// ~43 calls instead of 433. Mirror locally so /exercise-templates?q=
// is instant and consistent across deploys. Refreshed manually via
// POST /api/hevy/templates/refresh or auto when cache > 7 days old.
async function fetchAllHevyTemplates() {
  const all = [];
  let page = 1;
  // Cap at 100 pages (~10,000 exercises at pageSize=100).
  while (page < 100) {
    const resp = await hevyFetch(`/exercise_templates?page=${page}&pageSize=100`);
    // OAS field is `exercise_templates`. Keep `results`/`data` fallbacks
    // for resilience.
    const items = resp.exercise_templates || resp.results || resp.data || resp;
    if (!Array.isArray(items) || !items.length) break;
    all.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

async function refreshTemplateCache() {
  const templates = await fetchAllHevyTemplates();
  // Wipe-and-rewrite inside a transaction. Hevy may delete templates
  // (custom-made by us or others), so an upsert-only approach would
  // leave stale rows. Batch the INSERT in chunks of ~200 to avoid the
  // pg parameter limit (max 65535) — at 8 params per row that's ~8000
  // rows safely.
  await withTransaction(async (client) => {
    await client.query(`TRUNCATE hevy_template_cache`);
    const COLS = 8;
    const BATCH = 200;
    for (let i = 0; i < templates.length; i += BATCH) {
      const slice = templates.slice(i, i + BATCH);
      const vals = [];
      const placeholders = [];
      slice.forEach((t, idx) => {
        const base = idx * COLS;
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8}::jsonb)`
        );
        vals.push(
          t.id || t.exercise_template_id,
          t.title || t.name || '',
          t.type || t.exercise_type || 'weight_reps',
          t.primary_muscle_group || null,
          Array.isArray(t.secondary_muscle_groups) ? t.secondary_muscle_groups : null,
          t.equipment || null,
          Boolean(t.is_custom),
          JSON.stringify(t),
        );
      });
      if (!placeholders.length) continue;
      await client.query(
        `INSERT INTO hevy_template_cache (
           hevy_id, title, type, primary_muscle_group,
           secondary_muscle_groups, equipment, is_custom, raw
         ) VALUES ${placeholders.join(',')}
         ON CONFLICT (hevy_id) DO NOTHING`,
        vals
      );
    }
  });
  return templates.length;
}

// ─── GET /api/hevy/exercise-templates?q=squat ────────────────
// Reads from the postgres cache first. If empty, lazy-refreshes once.
router.get('/exercise-templates', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    const limit = Math.min(Number(req.query.limit) || 25, 100);

    // Lazy-refresh on:
    //   1. Empty cache (first ever call)
    //   2. Cache older than 7 days (Hevy templates change rarely; weekly is plenty)
    //   3. Caller passed ?refresh=1
    const force = String(req.query.refresh || '') === '1';
    let { rows: stat } = await query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(MAX(cached_at), NOW() - INTERVAL '999 days') AS newest
         FROM hevy_template_cache`
    );
    const ageDays = (Date.now() - new Date(stat[0].newest).getTime()) / 86400_000;
    if (force || !stat[0].n || ageDays > 7) {
      await refreshTemplateCache();
      ({ rows: stat } = await query(`SELECT COUNT(*)::int AS n FROM hevy_template_cache`));
    }
    const total = stat[0].n;

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
//
// Hevy returns the UserInfoResponse shape: { data: { id, name, url } }.
// We unwrap the inner `data` so callers see a flat user object.
router.get('/health', async (req, res) => {
  if (!HEVY_API_KEY) {
    return res.status(200).json({ ok: false, error: 'HEVY_API_KEY not set' });
  }
  try {
    const resp = await hevyFetch('/user/info');
    const user = resp?.data || resp;
    res.json({ ok: true, user });
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
// Body: { auto_create_custom?: boolean }
//
// For every distinct exercise name referenced in plan_segments
// .planned_exercises[].name (or daily_plans.planned_exercises) that
// isn't already mapped, look up a Hevy template via the cache. Three
// outcome buckets:
//   mapped:    confident match auto-inserted
//   ambiguous: fuzzy match, awaiting manual review
//   unmapped:  no match
//
// If `auto_create_custom: true`, unmapped names get a custom Hevy
// exercise_template POSTed to the user's library (with sensible
// defaults), then mapped. Use sparingly — Coach should normally
// confirm with the user before creating customs.
router.post('/exercise-map/auto-populate', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const autoCreateCustom = Boolean(req.body?.auto_create_custom);

    // Ensure cache has data — auto-populate is useless without it.
    const { rows: cacheCount } = await query(`SELECT COUNT(*)::int AS n FROM hevy_template_cache`);
    if (!cacheCount[0].n) await refreshTemplateCache();

    // Gather distinct exercise names from plan_segments. (Pre-1.8.1 we
    // also unioned daily_plans.planned_exercises, but that column was
    // removed from the active write path in v1.8.1.)
    const { rows: nameRows } = await query(`
      SELECT DISTINCT lower(coalesce(e->>'name', e->>'exercise_name', e->>'title')) AS name
      FROM plan_segments,
           jsonb_array_elements(planned_exercises) AS e
      WHERE coalesce(e->>'name', e->>'exercise_name', e->>'title') IS NOT NULL
    `);
    const names = nameRows.map(r => r.name).filter(Boolean);

    const { rows: existing } = await query(`SELECT lower(ab_brain_exercise_name) AS n FROM hevy_exercise_map`);
    const have = new Set(existing.map(r => r.n));

    const mapped = [];
    const ambiguous = [];
    const unmapped = [];
    const customCreated = [];

    for (const name of names) {
      if (have.has(name)) continue;
      const hit = await lookupHevyTemplateByName(name);
      if (hit && hit.source === 'cache_fuzzy') {
        ambiguous.push({ name, suggestion: hit });
        continue;
      }
      if (hit) {
        // Exact map or cache match.
        await query(
          `INSERT INTO hevy_exercise_map (
             ab_brain_exercise_name, hevy_exercise_template_id, hevy_title, hevy_type, confidence
           ) VALUES ($1, $2, $3, $4, 'auto')
           ON CONFLICT (lower(ab_brain_exercise_name)) DO NOTHING`,
          [name, hit.id, hit.title, hit.type]
        );
        mapped.push({ name, hevy_id: hit.id, hevy_title: hit.title });
        continue;
      }
      // No match anywhere.
      if (!autoCreateCustom) { unmapped.push(name); continue; }

      // Auto-create custom Hevy template + map. Title-cases the AB
      // Brain name for Hevy display ("cat cow" → "Cat Cow").
      const titled = name.replace(/\b\w/g, c => c.toUpperCase());
      try {
        const data = await hevyFetch('/exercise_templates', {
          method: 'POST',
          body: JSON.stringify({
            exercise_template: {
              title: titled,
              primary_muscle_group: 'other',
              equipment: 'none',
            },
          }),
        });
        const tpl = data.exercise_template || data;
        const newId = tpl.id || tpl.exercise_template_id;
        if (!newId) { unmapped.push(name); continue; }

        // Map immediately and add to cache so future passes find it.
        await query(
          `INSERT INTO hevy_exercise_map (
             ab_brain_exercise_name, hevy_exercise_template_id, hevy_title, hevy_type, is_custom, confidence
           ) VALUES ($1, $2, $3, $4, TRUE, 'auto')
           ON CONFLICT (lower(ab_brain_exercise_name)) DO NOTHING`,
          [name, newId, titled, tpl.type || 'weight_reps']
        );
        await query(
          `INSERT INTO hevy_template_cache (hevy_id, title, type, is_custom, raw)
           VALUES ($1, $2, $3, TRUE, $4::jsonb)
           ON CONFLICT (hevy_id) DO NOTHING`,
          [newId, titled, tpl.type || 'weight_reps', JSON.stringify(tpl)]
        );
        customCreated.push({ name, hevy_id: newId, hevy_title: titled });
        mapped.push({ name, hevy_id: newId, hevy_title: titled, custom: true });
      } catch (err) {
        unmapped.push(name);
        console.error(`[hevy/auto-populate] custom create failed for "${name}": ${err.message}`);
      }
    }

    res.json({
      mapped: mapped.length,
      ambiguous: ambiguous.length,
      unmapped: unmapped.length,
      custom_created: customCreated.length,
      details: { mapped, ambiguous, unmapped, customCreated },
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
  const beforeIds = exercises.map(e => e.hevy_exercise_template_id || null);
  await resolveTemplateIds(exercises);
  // If the resolver filled in any new IDs, persist them back to the
  // segment row so the Today card chip renders green "→ Hevy: <Title>"
  // instead of amber "⚠ unresolved" on future loads. Without this,
  // every render shows unresolved even after a successful push,
  // because resolveTemplateIds only mutates the in-memory copy.
  const afterIds = exercises.map(e => e.hevy_exercise_template_id || null);
  const changed = afterIds.some((id, i) => id && id !== beforeIds[i]);
  if (changed && segment?.id) {
    try {
      await query(
        `UPDATE plan_segments SET planned_exercises = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(exercises), segment.id]
      );
    } catch (err) {
      console.error(`[hevy/push] failed to persist resolved IDs to segment ${segment.id}: ${err.message}`);
    }
  }
  const routine = mapSegmentToHevyRoutine(planRow, segment, exercises, folderId);
  if (!routine.exercises.length) {
    return { ok: false, segment_id: segment?.id, skipped: 'no_resolvable_exercises' };
  }
  if (!routine.folder_id) {
    return { ok: false, segment_id: segment?.id, error: 'no folder_id (set HEVY_ROUTINE_FOLDER_ID env var or pass folder_id in body)' };
  }

  let hevyRoutine;
  if (segment?.hevy_routine_id) {
    // PutRoutinesRequestBody schema does NOT accept folder_id — only
    // title, notes, exercises. Strip it so Hevy doesn't 400. (Folder
    // assignment is set on creation; you can't move routines between
    // folders via the API.)
    const { folder_id: _drop, ...putRoutine } = routine;
    hevyRoutine = await hevyFetch(`/routines/${segment.hevy_routine_id}`, {
      method: 'PUT',
      body: JSON.stringify({ routine: putRoutine }),
    });
  } else {
    hevyRoutine = await hevyFetch('/routines', {
      method: 'POST',
      body: JSON.stringify({ routine }),
    });
    const newId = await extractRoutineId(hevyRoutine, routine.title);
    if (!newId) {
      console.error(`[hevy/push] segment ${segment?.id} created routine but ID extraction failed. Raw response keys: ${Object.keys(hevyRoutine || {}).join(',')}. Full payload (truncated): ${JSON.stringify(hevyRoutine).slice(0, 500)}`);
    }
    if (newId && segment?.id) {
      await query(
        `UPDATE plan_segments SET hevy_routine_id = $1, updated_at = NOW() WHERE id = $2`,
        [newId, segment.id]
      );
      console.log(`[hevy/push] segment ${segment.id} → routine ${newId}`);
    }
  }

  return { ok: true, segment_id: segment?.id, hevy_routine: hevyRoutine };
}

// Hevy's POST /v1/routines response shape is documented as `Routine`
// directly, but in practice the response can be:
//   { id, title, ... }                    (per OAS)
//   { routine: { id, title, ... } }       (wrapper, like GET single)
//   { data: { id, ... } }                 (like UserInfo)
//   { data: { routine: { id } } }         (paranoid)
//
// If none of those yield an id, fall back to GET /v1/routines and find
// the newest one matching our title — guarantees we capture the ID
// even if Hevy ships a malformed response. Bug #10 fix.
async function extractRoutineId(resp, expectedTitle) {
  const direct = resp?.id
    || resp?.routine?.id
    || resp?.routine_id
    || resp?.data?.id
    || resp?.data?.routine?.id
    || resp?.data?.routine_id;
  if (direct) return direct;

  if (!expectedTitle) return null;
  // Fallback: list recent routines and match title. Page 1, pageSize=10
  // is enough — the routine we just created is at top.
  try {
    const list = await hevyFetch(`/routines?page=1&pageSize=10`);
    const items = list.routines || list.data || list.results || [];
    const match = items.find(r => r.title === expectedTitle);
    if (match?.id) return match.id;
  } catch (err) {
    console.error(`[hevy/extractRoutineId] fallback GET failed: ${err.message}`);
  }
  return null;
}

// Reusable helper: push a daily_plan to Hevy. Walks plan_segments
// where logging_target='hevy' and pushes each as its own routine.
// Plans without hevy segments are no-ops.
// fallback when no segments exist (e.g., pre-migration plans).
//
// Returns { ok, segments_pushed, results, error } when segments were
// found, or { ok, hevy_routine, error } for the legacy single-routine
// path. Silent no-op when HEVY_API_KEY is missing or no segment routes
// to Hevy.
async function pushPlanToHevy(planRow, _unused, folderId) {
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
    // Naming is Coach's responsibility. If two segments share a
    // block_label and Coach didn't set title_suffix on each, the Hevy
    // routine titles will collide. We don't auto-fix — that hides
    // Coach mistakes. Instead we surface the collision in the response
    // so the caller (and the user) sees what went wrong.
    const titleCollisions = [];
    const titlesSeen = new Map();
    for (const s of hevySegments) {
      const titleKey = (s.title_suffix || s.block_label || '').toLowerCase();
      if (titlesSeen.has(titleKey)) {
        titleCollisions.push({
          block_label: s.block_label,
          first_segment_id: titlesSeen.get(titleKey),
          colliding_segment_id: s.id,
          fix: `Set segment.title_suffix on each colliding segment (e.g. "Main Lift" / "Grip"). See morning-check-in skill §8a.`,
        });
      } else {
        titlesSeen.set(titleKey, s.id);
      }
    }

    const results = [];
    for (const seg of hevySegments) {
      try {
        const r = await pushSegmentToHevy(planRow, seg, folderId);
        results.push(r);
      } catch (err) {
        // v3.12: prefix hevy-api errors so the caller (and the
        // hevy_push_detail column) can distinguish a Hevy-side
        // rejection (400 from /v1/routines) from a Forge-side
        // validation failure (no folder_id, no resolvable exercises).
        const raw = err?.message || String(err);
        const prefixed = raw.startsWith('Hevy ') ? `hevy_api: ${raw}` : raw;
        results.push({ ok: false, segment_id: seg.id, error: prefixed });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    if (typeof logActivity === 'function') {
      try { await logActivity('hevy_push', 'daily_plan', planRow.id, null, `Pushed ${okCount}/${hevySegments.length} segments for ${planRow.plan_date}`); } catch (_) {}
    }
    if (titleCollisions.length) {
      console.warn(`[hevy/push] plan ${planRow.id} has ${titleCollisions.length} routine title collision(s) — Coach forgot to set title_suffix on segments sharing a block_label.`);
    }

    // v3.12: when every segment fails, aggregate the per-segment
    // reasons into a top-level `error` or `skipped` so callers
    // (autoPushToHevy, POST /push-plan, the UI badge) get a usable
    // diagnostic without walking results[]. Two precedence rules:
    //   1. If ANY segment threw a hard error, surface those as `error`
    //      (hard errors deserve attention more than soft skips).
    //   2. Otherwise, surface skip reasons as `skipped`.
    let aggregateError = null;
    let aggregateSkipped = null;
    if (okCount === 0 && results.length > 0) {
      const errored = results.filter((r) => r.error);
      const skipped = results.filter((r) => r.skipped);
      const formatSeg = (r) => {
        const sid = r.segment_id ? `segment ${String(r.segment_id).slice(0, 8)}` : 'segment';
        return `${sid}: ${r.error || r.skipped}`;
      };
      if (errored.length > 0) {
        aggregateError = errored.map(formatSeg).join('; ');
      } else if (skipped.length > 0) {
        aggregateSkipped = skipped.map(formatSeg).join('; ');
      }
    }

    return {
      ok: okCount > 0,
      segments_pushed: okCount,
      total_hevy_segments: hevySegments.length,
      results,
      ...(aggregateSkipped ? { skipped: aggregateSkipped } : {}),
      ...(aggregateError ? { error: aggregateError } : {}),
      ...(titleCollisions.length ? { warnings: { title_collisions: titleCollisions } } : {}),
    };
  }

  // No segments → nothing to push. Coach is required to write
  // plan_segments via POST /daily-plans body. Legacy daily-plan-level
  // planned_exercises was removed in v1.8.1.
  return { ok: false, skipped: 'no_segments_with_logging_target_hevy' };
}

// ─── POST /api/hevy/push-plan ────────────────────────────────
// Coach calls this after writing a daily_plan + its plan_segments.
// Pushes one Hevy routine per segment with logging_target='hevy'.
//
// Body: { plan_id, folder_id? }
// Each plan_segment with logging_target='hevy' must already have
// `planned_exercises` populated (each entry needs `name` for resolver
// to find a Hevy template, or a pre-resolved `hevy_exercise_template_id`).
router.post('/push-plan', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const { plan_id, folder_id } = req.body || {};
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });

    const planRes = await query(`SELECT * FROM daily_plans WHERE id = $1`, [plan_id]);
    const plan = planRes.rows[0];
    if (!plan) return res.status(404).json({ error: 'plan not found' });

    const result = await pushPlanToHevy(plan, null, folder_id);

    // v3.12: use the shared derivePushOutcome helper so failed pushes
    // always carry a non-null detail. Previously this path had the same
    // fall-through bug as autoPushToHevy (status='failed', detail=null
    // when results[] held per-segment failures but no top-level error).
    const { derivePushOutcome } = require('../lib/hevy-push-outcome');
    const { status: pushStatus, detail: pushDetail } = derivePushOutcome(result);
    try {
      await query(
        `UPDATE daily_plans SET hevy_push_status = $1, hevy_push_detail = $2, hevy_push_at = NOW()
         WHERE id = $3`, [pushStatus, pushDetail, plan_id]
      );
    } catch (_) { /* informational */ }

    if (!result.ok) {
      return res.status(result.skipped ? 200 : 400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error(`[hevy/push-plan] ${err.stack}`);
    try {
      await query(
        `UPDATE daily_plans SET hevy_push_status = 'failed', hevy_push_detail = $1, hevy_push_at = NOW()
         WHERE id = $2`, [err.message, req.body?.plan_id]
      );
    } catch (_) { /* swallow */ }
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/hevy/push-segment ─────────────────────────────
// Manual retry: push a single plan_segment to Hevy. Called from the
// Today card "Push to Hevy" button when auto-push fails or the user
// wants to retrigger after editing exercise mappings. Body:
//   { segment_id, folder_id? }
router.post('/push-segment', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const { segment_id, folder_id } = req.body || {};
    if (!segment_id) return res.status(400).json({ error: 'segment_id required' });

    const segR = await query(`SELECT * FROM plan_segments WHERE id = $1`, [segment_id]);
    const segment = segR.rows[0];
    if (!segment) return res.status(404).json({ error: 'segment not found' });
    if (segment.logging_target !== 'hevy') {
      return res.status(400).json({ error: `segment logging_target is '${segment.logging_target}', not 'hevy'` });
    }

    const planR = await query(`SELECT * FROM daily_plans WHERE id = $1`, [segment.daily_plan_id]);
    const plan = planR.rows[0];
    if (!plan) return res.status(404).json({ error: 'parent plan not found' });

    const result = await pushSegmentToHevy(plan, segment, folder_id);
    if (!result.ok) {
      return res.status(result.skipped ? 200 : 400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error(`[hevy/push-segment] ${err.stack}`);
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

// Pulls Hevy workout events (creates/updates AND deletes) since the
// last sync cursor and applies them to AB Brain `workouts`, deduped by
// hevy_id. After each upsert, auto-links the row to the daily_plan +
// hevy-target plan_segment for the workout's date.
//
// Why /workouts/events instead of /workouts:
//   - Captures DELETIONS (DeletedWorkout type) — /workouts paginated
//     can't surface a workout that was deleted.
//   - Server-side filter via `since` param (ISO 8601). No client-side
//     date-comparison loop.
//   - Returns events newest-first, but we walk all pages so we get
//     every change since the cursor.
//
// Cursor strategy:
//   - sync_state.cursor stores the ISO timestamp of the most recent
//     event we processed.
//   - On next call we pass that as `since`. Hevy returns events
//     strictly NEWER than this, so we don't re-process.
//   - On first run, default to 30 days back.
//
// `since` param accepts ISO 8601 OR YYYY-MM-DD; YYYY-MM-DD gets the
// T00:00:00Z suffix appended so legacy callers keep working.
async function syncHevyWorkouts(since) {
  if (!HEVY_API_KEY) return { ok: false, skipped: 'no_api_key', inserted: 0 };

  // Resolve effective `since`:
  //   1. Explicit param (caller override) — ISO 8601 or YYYY-MM-DD
  //   2. sync_state.cursor for 'hevy_workouts' (always ISO)
  //   3. 30 days back (first-ever run)
  let sinceIso = since;
  if (sinceIso && /^\d{4}-\d{2}-\d{2}$/.test(sinceIso)) {
    sinceIso = `${sinceIso}T00:00:00Z`;
  }
  if (!sinceIso) {
    const { rows } = await query(`SELECT cursor FROM sync_state WHERE source = 'hevy_workouts'`);
    if (rows[0]?.cursor) sinceIso = String(rows[0].cursor);
  }
  if (!sinceIso) {
    sinceIso = new Date(Date.now() - 30 * 86400_000).toISOString();
  }

  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  let linked = 0;
  let latestEventTime = sinceIso;

  // Walk all pages. Events are newest-first, so we sweep the full
  // window and stop on the first empty page. Cap at 50 pages to
  // prevent runaway loops.
  let page = 1;
  while (page < 50) {
    const url = `/workouts/events?page=${page}&pageSize=10&since=${encodeURIComponent(sinceIso)}`;
    const resp = await hevyFetch(url);
    const events = resp.events || [];
    if (!events.length) break;

    for (const ev of events) {
      try {
        if (ev.type === 'deleted') {
          // Soft-delete the AB Brain row. Don't hard-delete because
          // it may still be linked to a daily_plan / segment.
          const r = await query(
            `UPDATE workouts SET deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
             WHERE hevy_id = $1 AND deleted_at IS NULL
             RETURNING id`,
            [ev.id]
          );
          if (r.rows.length) deleted++;
          const ts = ev.deleted_at;
          if (ts && new Date(ts).getTime() > new Date(latestEventTime).getTime()) {
            latestEventTime = ts;
          }
          continue;
        }

        // Updated/created event.
        const hw = ev.workout;
        if (!hw?.id) { skipped++; continue; }
        const ts = hw.updated_at || hw.created_at || hw.start_time;
        if (ts && new Date(ts).getTime() > new Date(latestEventTime).getTime()) {
          latestEventTime = ts;
        }
        const row = mapHevyWorkoutToAB(hw);
        if (!row.hevy_id) { skipped++; continue; }

        // v1.11.9: exercises and metadata are both JSONB; stringify and cast
        // each at INSERT time. Was only handling metadata before — exercises
        // arrived as a JS array, postgres rejected the JSONB write, exercises
        // landed null. Goal auto-compute silently missed Hevy workouts.
        const JSONB_COLS = new Set(['exercises', 'metadata']);
        const cols = Object.keys(row);
        const placeholders = cols.map((c, i) => JSONB_COLS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`);
        const values = cols.map(c => JSONB_COLS.has(c) ? JSON.stringify(row[c] || (c === 'exercises' ? [] : {})) : row[c]);

        // Conflict resolution: Hevy is the source of execution truth,
        // so its sets/reps/weight/timing/volume OVERWRITE on each sync.
        // AB Brain owns the coaching context (body_notes) — preserved if
        // Hevy returns null.
        const upsert = await query(
          `INSERT INTO workouts (${cols.join(', ')})
           VALUES (${placeholders.join(', ')})
           ON CONFLICT (hevy_id) WHERE hevy_id IS NOT NULL DO UPDATE SET
             title = EXCLUDED.title,
             time_duration = EXCLUDED.time_duration,
             duration_minutes = EXCLUDED.duration_minutes,
             started_at = EXCLUDED.started_at,
             ended_at = EXCLUDED.ended_at,
             exercises = EXCLUDED.exercises,
             total_volume_lb = EXCLUDED.total_volume_lb,
             total_sets = EXCLUDED.total_sets,
             body_notes = COALESCE(workouts.body_notes, EXCLUDED.body_notes),
             metadata = workouts.metadata || EXCLUDED.metadata,
             deleted_at = NULL,
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS inserted`,
          values
        );
        if (upsert.rows[0]?.inserted) inserted++; else updated++;

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
        console.error(`[hevy/sync] failed for ${ev.type === 'deleted' ? ev.id : ev.workout?.id}: ${err.message}`);
        skipped++;
      }
    }
    if (events.length < 10) break;
    page++;
  }

  // Advance the durable cursor by 1ms past the newest event we saw.
  // Hevy's `since` filter is exclusive on equality, so adding 1ms
  // ensures we don't re-fetch the same boundary event next call.
  if (latestEventTime !== sinceIso) {
    const nextCursor = new Date(new Date(latestEventTime).getTime() + 1).toISOString();
    await query(
      `INSERT INTO sync_state (source, cursor, last_synced_at, stats, updated_at)
       VALUES ('hevy_workouts', $1, NOW(), $2::jsonb, NOW())
       ON CONFLICT (source) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         last_synced_at = NOW(),
         stats = EXCLUDED.stats,
         updated_at = NOW()`,
      [nextCursor, JSON.stringify({ inserted, updated, deleted, skipped, linked })]
    );
  }

  // v1.8.18: run Apple-Hevy dedupe after Hevy upserts. Without this,
  // Apple Watch auto-detected workouts that overlap a Hevy session
  // stay as separate rows because dedupe used to fire only at the end
  // of HAE ingest. Lazy-load to avoid a circular require with health.js.
  let dedupedNow = 0;
  if (inserted + updated > 0) {
    try {
      const { dedupeAppleWorkouts } = require('./health');
      if (typeof dedupeAppleWorkouts === 'function') {
        dedupedNow = await dedupeAppleWorkouts();
      }
    } catch (err) {
      console.error(`[hevy/sync] dedupe after sync failed: ${err.message}`);
    }
  }

  return {
    ok: true,
    inserted,
    updated,
    deleted,
    skipped,
    linked,
    deduped: dedupedNow,
    since: sinceIso,
    cursor_advanced_to: latestEventTime !== sinceIso ? latestEventTime : null,
  };
}

// ─── POST /api/hevy/backfill-exercises ────────────────────────
// One-shot backfill for the v1.11.9 fix. Walks every Hevy-source workout
// where `exercises` is empty/null and rebuilds it from
// `metadata.hevy.raw_exercises` using the same transform as live sync.
// After running, POST /api/goals/recompute-all picks up max weight + reps
// from these rebuilt exercises[] arrays — restoring auto-compute for
// Goals 1, 2, etc.
//
// Idempotent. Safe to run multiple times. Skips rows that already have
// non-empty exercises.
router.post('/backfill-exercises', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const r = await query(
      `SELECT id, hevy_id, metadata
         FROM workouts
        WHERE source = 'hevy'
          AND deleted_at IS NULL
          AND (exercises IS NULL
               OR jsonb_typeof(exercises) IS DISTINCT FROM 'array'
               OR jsonb_array_length(exercises) = 0)
          AND metadata IS NOT NULL`
    );

    let updated = 0;
    let skipped = 0;
    const failed = [];

    for (const row of r.rows) {
      try {
        const raw = row.metadata?.hevy?.raw_exercises;
        if (!Array.isArray(raw) || raw.length === 0) {
          skipped++;
          continue;
        }
        const exercises = transformHevyExercises(raw);
        // Recompute volume/set count on backfill so they're consistent
        let volumeLb = 0, setCount = 0;
        for (const ex of raw) {
          for (const s of (ex.sets || [])) {
            if (s.weight_kg != null && s.reps != null) {
              volumeLb += Number(s.weight_kg) * 2.2046226218 * Number(s.reps);
              setCount++;
            }
          }
        }
        await query(
          `UPDATE workouts
              SET exercises = $1::jsonb,
                  total_volume_lb = COALESCE(total_volume_lb, $2),
                  total_sets = COALESCE(total_sets, $3),
                  updated_at = NOW()
            WHERE id = $4`,
          [JSON.stringify(exercises), Math.round(volumeLb), setCount, row.id]
        );
        updated++;
      } catch (err) {
        failed.push({ id: row.id, hevy_id: row.hevy_id, error: err.message });
      }
    }

    // After backfill, fire goal recompute so Goals 1+2 pick up the
    // newly-visible exercise data. Fire-and-forget.
    try {
      const goals = require('./goals');
      if (typeof goals.recomputeAllGoals === 'function') {
        goals.recomputeAllGoals().catch(err =>
          console.error('[hevy backfill → goals recompute]', err.message));
      }
    } catch (_) { /* goals not loaded — fine */ }

    res.json({
      ok: true,
      total_candidates: r.rows.length,
      updated,
      skipped,
      failed,
      note: updated
        ? `Rebuilt exercises[] on ${updated} Hevy workouts. Goal recompute kicked off in background.`
        : 'No Hevy workouts needed backfill.',
    });
  } catch (err) {
    console.error('[POST /hevy/backfill-exercises]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

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
    // v1.11.0: trigger goal recompute after the sync batch lands. Fire-and-
    // forget so a recompute failure never poisons the sync response.
    try {
      const goals = require('./goals');
      if (typeof goals.recomputeAllGoals === 'function') {
        goals.recomputeAllGoals().catch(err =>
          console.error('[goals recompute after hevy sync]', err.message));
      }
    } catch (_) { /* goals not loaded — fine */ }
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

// Convert AB Brain body_metrics row to Hevy body_measurements payload.
//
// Hevy's actual schema (verified against api.hevyapp.com OAS spec
// May 2026): three numeric fields plus 14 tape-measurement fields.
// AB Brain (RENPHO) only fills the three numerics; tape data flows
// through `notes` if at all. We DO NOT send invented fields like bmi,
// water_percent, bone_mass_kg, etc. — Hevy's PUT validates strictly
// and would reject the payload.
//
//   weight_kg     ← weight_lb × 0.453592
//   lean_mass_kg  ← fat_free_mass_lb × 0.453592 (RENPHO's lean mass
//                                                approximation)
//   fat_percent   ← body_fat_pct (already a %)
function abMetricsToHevy(row) {
  return {
    weight_kg: lbToKg(row.weight_lb),
    lean_mass_kg: lbToKg(row.fat_free_mass_lb),
    fat_percent: row.body_fat_pct != null ? Number(row.body_fat_pct) : null,
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
              measurement_date, weight_lb, fat_free_mass_lb, body_fat_pct
         FROM body_metrics
        WHERE measurement_date >= $1
        ORDER BY measurement_date DESC, measurement_time DESC NULLS LAST, created_at DESC`,
      [since]
    );

    let created = 0;
    let updated = 0;
    let merged = 0;
    let skipped = 0;
    const errors = [];

    for (const row of rows) {
      const date = String(row.measurement_date).slice(0, 10);
      const ab = abMetricsToHevy(row);

      // Skip if every AB field is null — nothing to push.
      if (!Object.values(ab).some(v => v != null)) { skipped++; continue; }

      // Merge with existing Hevy record so PUT doesn't null fields we
      // didn't supply but Hevy already had (e.g. user edited tape
      // measurements on their phone). Hevy's PUT validates strictly:
      //   - PutBodyMeasurement schema = no `date` field (it's in the URL)
      //   - 404 if no measurement exists for the date — so use POST
      //     in that case (POST takes BodyMeasurement which DOES include
      //     `date`).
      let existing = null;
      try {
        existing = await getHevyMeasurement(date);
      } catch (err) {
        errors.push({ date, phase: 'get', error: err.message });
        continue;
      }

      const abNonNull = Object.fromEntries(Object.entries(ab).filter(([_, v]) => v != null));

      if (existing) {
        // PUT path: merge onto existing, strip URL-bound `date`.
        merged++;
        const payload = { ...existing, ...abNonNull };
        delete payload.date;
        try {
          await hevyFetch(`/body_measurements/${date}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
          });
          updated++;
        } catch (err) {
          errors.push({ date, phase: 'put', error: err.message });
        }
      } else {
        // POST path: brand-new record. POST schema requires `date`.
        const payload = { date, ...abNonNull };
        try {
          await hevyFetch(`/body_measurements`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          created++;
        } catch (err) {
          errors.push({ date, phase: 'post', error: err.message });
        }
      }
    }

    if (typeof logActivity === 'function') {
      try { await logActivity('hevy_body_sync', null, null, null, `Body measurements: ${created} created, ${updated} updated (${merged} merged), ${skipped} empty`); } catch (_) {}
    }

    res.json({ ok: true, considered: rows.length, created, updated, merged, skipped, errors });
  } catch (err) {
    console.error(`[hevy/body-measurements/sync] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/hevy/exercise-templates ─────────────────────────
// Add a custom exercise to the user's Hevy library. Body:
//   { title, muscle_group?, equipment_category?, exercise_type?,
//     other_muscles? }
//
// Hevy's request body shape (verified from OAS):
//   { exercise: { title, exercise_type, equipment_category,
//                 muscle_group, other_muscles[] } }
//
// Note the wrapper is `exercise`, NOT `exercise_template`. Field
// names are `muscle_group` (not primary_muscle_group) and
// `equipment_category` (not equipment). No `notes` on creation.
//
// Enums (verified from OAS):
//   exercise_type: weight_reps | reps_only | bodyweight_reps |
//                  bodyweight_assisted_reps | duration |
//                  weight_duration | distance_duration |
//                  short_distance_weight
//   muscle_group:  abdominals|shoulders|biceps|triceps|forearms|
//                  quadriceps|hamstrings|calves|glutes|abductors|
//                  adductors|lats|upper_back|traps|lower_back|
//                  chest|cardio|neck|full_body|other
//   equipment:     none|barbell|dumbbell|kettlebell|machine|plate|
//                  resistance_band|suspension|other
router.post('/exercise-templates', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const { title, muscle_group, equipment_category, equipment, exercise_type, other_muscles } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const payload = {
      exercise: {
        title,
        exercise_type: exercise_type || 'weight_reps',
        equipment_category: equipment_category || equipment || 'none',
        muscle_group: muscle_group || 'other',
        ...(Array.isArray(other_muscles) && other_muscles.length ? { other_muscles } : {}),
      },
    };
    const data = await hevyFetch('/exercise_templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // Hevy returns { id: <integer> } per OAS — but exercise_template
    // ids elsewhere are strings/UUIDs, so coerce to string for downstream
    // consistency.
    const newId = data?.id != null ? String(data.id) : (data?.exercise?.id || data?.exercise_template?.id);

    // Add to local cache so /exercise-templates?q= can find it without
    // a full refresh.
    if (newId) {
      try {
        await query(
          `INSERT INTO hevy_template_cache (hevy_id, title, type, primary_muscle_group, equipment, is_custom, raw)
           VALUES ($1, $2, $3, $4, $5, TRUE, $6::jsonb)
           ON CONFLICT (hevy_id) DO UPDATE SET
             title = EXCLUDED.title,
             type = EXCLUDED.type,
             primary_muscle_group = EXCLUDED.primary_muscle_group,
             equipment = EXCLUDED.equipment,
             is_custom = TRUE,
             cached_at = NOW()`,
          [
            newId,
            title,
            payload.exercise.exercise_type,
            payload.exercise.muscle_group,
            payload.exercise.equipment_category,
            JSON.stringify({ ...payload.exercise, id: newId }),
          ]
        );
      } catch (_) { /* cache table may not exist on first deploy */ }
    }

    res.json({ ok: true, id: newId, template: { id: newId, ...payload.exercise } });
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

// ─── v3.9: Forge → Hevy logged-session push ─────────────────────
//
// Until v3.9 the Forge → Hevy data flow was routine-only: plans pushed as
// templates, completed sessions had to be logged inside Hevy. This adds
// the third leg — push a workout you logged in Forge as a logged session
// in Hevy via POST /v1/workouts.
//
// Idempotent: writes the returned Hevy workout id back to
// workouts.hevy_id; subsequent pushes for the same workout PUT
// the existing one instead of creating duplicates.
//
// Skips silently when:
//   - HEVY_API_KEY is missing  → { ok: false, skipped: 'no_api_key' }
//   - workout has no exercises → { ok: false, skipped: 'no_exercises' }
//   - none of the exercises resolve to Hevy templates
//                              → { ok: false, skipped: 'no_resolvable_exercises' }

const LB_TO_KG = 0.45359237;

function lbToKg(lb) {
  if (lb == null || lb === '' || isNaN(Number(lb))) return null;
  return Math.round(Number(lb) * LB_TO_KG * 100) / 100;
}

// Build a Hevy /v1/workouts payload from an AB Brain workouts row.
// Missing weights become bodyweight sets (type: 'normal' with weight_kg
// omitted). Reps default to 0 if absent so Hevy still accepts the set.
function workoutRowToHevyPayload(w, resolvedExercises) {
  const startIso = w.started_at
    ? new Date(w.started_at).toISOString()
    : new Date(`${String(w.workout_date).slice(0, 10)}T06:00:00`).toISOString();
  const endIso = w.ended_at
    ? new Date(w.ended_at).toISOString()
    : (w.duration_minutes
        ? new Date(new Date(startIso).getTime() + Number(w.duration_minutes) * 60_000).toISOString()
        : new Date(new Date(startIso).getTime() + 60 * 60_000).toISOString());

  const titleParts = [];
  if (w.title) titleParts.push(String(w.title));
  else if (w.workout_type) titleParts.push(String(w.workout_type).replace(/_/g, ' '));
  else titleParts.push('Workout');

  const exercisesPayload = resolvedExercises.map((ex, idx) => ({
    index: idx,
    exercise_template_id: ex.hevy_exercise_template_id,
    notes: ex.notes ? String(ex.notes).slice(0, 240) : '',
    sets: (ex.sets || []).map((s, j) => {
      const weight_kg = s.weight_kg != null
        ? Number(s.weight_kg)
        : (s.weight_lb != null ? lbToKg(s.weight_lb) : (s.weight_lbs != null ? lbToKg(s.weight_lbs) : null));
      return {
        index: j,
        type: s.type || 'normal',
        weight_kg,
        reps: Number(s.reps) || 0,
        ...(s.distance_meters != null ? { distance_meters: Number(s.distance_meters) } : {}),
        ...(s.duration_seconds != null ? { duration_seconds: Number(s.duration_seconds) } : {}),
        ...(s.rpe != null ? { rpe: Number(s.rpe) } : {}),
      };
    }),
  }));

  return {
    workout: {
      title: titleParts.join(' ').slice(0, 80),
      description: w.body_notes ? String(w.body_notes).slice(0, 600) : '',
      start_time: startIso,
      end_time: endIso,
      is_private: false,
      exercises: exercisesPayload,
    },
  };
}

async function pushWorkoutToHevy(workoutRow) {
  if (!HEVY_API_KEY) return { ok: false, skipped: 'no_api_key' };
  if (!workoutRow || !workoutRow.id) return { ok: false, error: 'workout not found' };

  const exercises = Array.isArray(workoutRow.exercises) ? workoutRow.exercises : [];
  if (exercises.length === 0) return { ok: false, skipped: 'no_exercises' };

  // Resolve each exercise to a Hevy template id. Reuses the existing
  // resolver pattern from the plan-push code path.
  const resolved = [];
  for (const ex of exercises) {
    if (!ex.hevy_exercise_template_id) {
      const r = await query(
        `SELECT hevy_id AS id FROM hevy_template_cache
         WHERE LOWER(title) = LOWER($1)
         LIMIT 1`,
        [String(ex.name || '')]
      ).catch(() => ({ rows: [] }));
      if (r.rows[0]?.id) ex.hevy_exercise_template_id = r.rows[0].id;
    }
    if (ex.hevy_exercise_template_id) resolved.push(ex);
  }
  if (resolved.length === 0) return { ok: false, skipped: 'no_resolvable_exercises' };

  const payload = workoutRowToHevyPayload(workoutRow, resolved);
  const isUpdate = !!workoutRow.hevy_id;
  const path = isUpdate
    ? `/workouts/${workoutRow.hevy_id}`
    : '/workouts';
  const method = isUpdate ? 'PUT' : 'POST';

  let result;
  try {
    result = await hevyFetch(path, { method, body: JSON.stringify(payload) });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Persist the Hevy workout id back to AB Brain so subsequent pushes
  // are idempotent (PUT instead of POST).
  const newHevyId = result?.workout?.id || result?.id || workoutRow.hevy_id || null;
  try {
    if (newHevyId) {
      await query(
        `UPDATE workouts SET hevy_id = $1, updated_at = NOW() WHERE id = $2`,
        [newHevyId, workoutRow.id]
      );
    }
  } catch (_) { /* informational */ }

  return {
    ok: true,
    method,
    hevy_id: newHevyId,
    exercises_pushed: resolved.length,
    total_exercises: exercises.length,
  };
}

// ─── POST /api/hevy/push-workout ─────────────────────────────
// Body: { workout_id }
// Pushes a single Forge workout to Hevy as a logged session.
router.post('/push-workout', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const { workout_id } = req.body || {};
    if (!workout_id) return res.status(400).json({ error: 'workout_id required' });
    const r = await query(`SELECT * FROM workouts WHERE id = $1`, [workout_id]);
    const w = r.rows[0];
    if (!w) return res.status(404).json({ error: 'workout not found' });

    const result = await pushWorkoutToHevy(w);
    if (!result.ok) {
      return res.status(result.skipped ? 200 : 400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error(`[hevy/push-workout] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.pushPlanToHevy = pushPlanToHevy;
module.exports.pushSegmentToHevy = pushSegmentToHevy;
module.exports.pushWorkoutToHevy = pushWorkoutToHevy;
module.exports.workoutRowToHevyPayload = workoutRowToHevyPayload;
module.exports.syncHevyWorkouts = syncHevyWorkouts;
// Exposed for unit tests in tests/hevy.test.js. Don't import these
// elsewhere — they're internal helpers.
module.exports._test = {
  mapSegmentToHevyRoutine,
  mapHevyWorkoutToAB,
  formatPlanDate,
  abMetricsToHevy,
  lbToKg,
  TYPE_PREFIX,
};
