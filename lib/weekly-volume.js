'use strict';

// v3.35 Feature 2 — weekly working-set volume per program bucket.
//
// KNOWN BUG THIS RESPECTS: an evening ET session (e.g. Mon 8pm ET) is
// stored as the next UTC day (Tue 00:00 UTC). Bucketing by UTC date puts
// it in the wrong week. So we bucket by America/New_York wall time: the
// week is [Mon 00:00 ET, next Mon 00:00 ET), converted to real UTC
// instants, and workouts are filtered by started_at against those.

const { BUCKETS, bucketForMuscle, normalizeMuscle } = require('./muscle-buckets');

const TZ = 'America/New_York';

// Working set types per the program. Warmups always excluded. If Hevy adds
// a new working type (e.g. rest_pause), add it here.
const WORKING_SET_TYPES = new Set(['normal', 'failure', 'dropset']);

// Offset (ms) between a timeZone's wall clock and UTC at a given instant.
// asUTC(wallclock) - instant. Positive when the zone is ahead of UTC.
function tzOffsetMs(instant, timeZone = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(instant).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// The UTC instant whose ET wall-clock reads `ymd` 00:00:00. Two-step
// guess-and-correct (accurate outside the 1h DST gap, which never lands
// on midnight in ET — DST flips at 2am).
function etWallMidnightToUTC(ymd, timeZone = TZ) {
  const guess = new Date(ymd + 'T00:00:00Z').getTime();
  const off = tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - off);
}

// The ET calendar date (YYYY-MM-DD) for a given instant.
function etDateOf(instant, timeZone = TZ) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// Monday (YYYY-MM-DD) of the ET week containing `ymd`. Pure date math on
// the calendar date — no zone needed once we have the ET date.
function mondayOf(ymd) {
  const d = new Date(ymd + 'T12:00:00Z'); // noon avoids any edge rounding
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = (dow === 0 ? -6 : 1 - dow); // Sun→-6, Mon→0, Tue→-1...
  d.setUTCDate(d.getUTCDate() + deltaToMonday);
  return d.toISOString().slice(0, 10);
}

// Resolve the week_start param (or default to the current ET week's
// Monday). Accepts any YYYY-MM-DD (snaps to that date's Monday) so a
// caller passing a mid-week date still gets a sane week.
function resolveWeekStart(weekStartParam, now = new Date()) {
  const anchor = (weekStartParam && /^\d{4}-\d{2}-\d{2}$/.test(weekStartParam))
    ? weekStartParam
    : etDateOf(now);
  return mondayOf(anchor);
}

// [startUTC, endUTC) instants for the ET week beginning at mondayYmd.
function etWeekWindowUTC(mondayYmd) {
  const start = etWallMidnightToUTC(mondayYmd);
  const nextMonday = new Date(mondayYmd + 'T12:00:00Z');
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  const end = etWallMidnightToUTC(nextMonday.toISOString().slice(0, 10));
  return { startUTC: start, endUTC: end };
}

// Count working sets in one exercise's sets[] (Hevy-transformed shape:
// { set_type, warmup, ... }). Warmups excluded; only WORKING_SET_TYPES.
function countWorkingSets(sets) {
  if (!Array.isArray(sets)) return 0;
  let n = 0;
  for (const s of sets) {
    if (!s) continue;
    if (s.warmup === true) continue;
    const t = normalizeMuscle(s.set_type || s.type || 'normal'); // reuse lower/trim
    if (WORKING_SET_TYPES.has(t)) n++;
  }
  return n;
}

// Pure tally. Inputs:
//   workouts: [{ exercises: [{ name, hevy_exercise_template_id, sets:[...] }] }]
//   resolveMuscles(exercise) → { primary: <muscle|bucket|null>,
//                                secondary: [<muscle>...],
//                                unmapped: bool }
//   targets: { <bucket>: { target_min, target_max } }
// Returns { buckets:[...], unmapped_exercises:[...], working_set_total }.
function tallyVolume(workouts, resolveMuscles, targets = {}) {
  const primaryByBucket = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const secondaryByBucket = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const unmapped = [];
  let workingTotal = 0;

  for (const w of (workouts || [])) {
    for (const ex of (w.exercises || [])) {
      const working = countWorkingSets(ex.sets);
      if (working === 0) continue;
      workingTotal += working;

      const r = resolveMuscles(ex) || {};
      const primaryBucket = bucketForMuscleOrBucket(r.primary);
      const secondaryBuckets = (r.secondary || [])
        .map(bucketForMuscleOrBucket)
        .filter(Boolean);

      let placed = false;
      if (primaryBucket) {
        primaryByBucket[primaryBucket] += working;
        placed = true;
      }
      for (const sb of secondaryBuckets) {
        secondaryByBucket[sb] += working * 0.5;
        placed = true;
      }
      // Not placeable into any bucket → surface, never drop.
      if (!placed) {
        unmapped.push({
          name: ex.name || ex.hevy_exercise_template_id || 'Unknown',
          hevy_exercise_template_id: ex.hevy_exercise_template_id || null,
          working_sets: working,
          reason: r.unmapped ? 'no_muscle_data' : 'muscle_not_in_any_bucket',
        });
      }
    }
  }

  const buckets = BUCKETS.map(b => {
    const primary = round1(primaryByBucket[b]);
    const secondary = round1(secondaryByBucket[b]);
    const total = round1(primary + secondary);
    const t = targets[b] || {};
    const min = t.target_min ?? null;
    const max = t.target_max ?? null;
    let status = 'no_target';
    if (min != null && max != null) {
      status = total < min ? 'under' : (total > max ? 'over' : 'in');
    }
    return { bucket: b, primary_sets: primary, secondary_sets: secondary, total, target_min: min, target_max: max, status };
  });

  return { buckets, unmapped_exercises: unmapped, working_set_total: workingTotal };
}

// A resolver value may be a raw Hevy muscle ("chest") or already a bucket
// name ("chest"/"arms") when it came from a manual override. Try muscle→
// bucket first; if the value is itself a valid bucket, accept it.
function bucketForMuscleOrBucket(v) {
  if (!v) return null;
  const viaMuscle = bucketForMuscle(v);
  if (viaMuscle) return viaMuscle;
  const norm = normalizeMuscle(v);
  return BUCKETS.includes(norm) ? norm : null;
}

function round1(n) { return Math.round(Number(n) * 10) / 10; }

// Build a muscle resolver from the two sources, preferring the strong
// template-id link, then the exercise map (which carries manual overrides).
function buildResolver(templateRows, mapRows) {
  const tplById = new Map();
  for (const t of templateRows) tplById.set(t.hevy_id, {
    primary: t.primary_muscle_group || null,
    secondary: Array.isArray(t.secondary_muscle_groups) ? t.secondary_muscle_groups : [],
  });
  const mapByTpl = new Map();
  const mapByName = new Map();
  for (const m of mapRows) {
    if (m.hevy_exercise_template_id) mapByTpl.set(m.hevy_exercise_template_id, m);
    if (m.name) mapByName.set(String(m.name).toLowerCase(), m);
  }
  return function resolve(ex) {
    const tid = ex.hevy_exercise_template_id || null;
    if (tid && tplById.get(tid)?.primary) {
      const t = tplById.get(tid);
      return { primary: t.primary, secondary: t.secondary };
    }
    const m = (tid && mapByTpl.get(tid)) || (ex.name && mapByName.get(String(ex.name).toLowerCase()));
    if (m) {
      const secondary = Array.isArray(m.hevy_secondary_muscle_groups) ? m.hevy_secondary_muscle_groups : [];
      if (m.manual_muscle_override) return { primary: m.manual_muscle_override, secondary };
      if (m.hevy_primary_muscle_group) return { primary: m.hevy_primary_muscle_group, secondary };
    }
    return { primary: null, secondary: [], unmapped: true };
  };
}

// Full DB-backed weekly volume for one ET week. `query` is injected so the
// lib stays DB-agnostic and unit-testable. Returns the response payload
// shared by GET /training/volume/weekly and the weekly-review block.
async function loadWeeklyVolume(query, { weekStart, now } = {}) {
  const monday = resolveWeekStart(weekStart, now);
  const { startUTC, endUTC } = etWeekWindowUTC(monday);
  const weekEnd = (() => { const d = new Date(monday + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })();

  const { rows: workoutRows } = await query(
    `SELECT id, started_at, workout_date, source, exercises
       FROM workouts
      WHERE started_at >= $1 AND started_at < $2
        AND deleted_at IS NULL
        AND exercises IS NOT NULL
        AND jsonb_typeof(exercises) = 'array'
        AND jsonb_array_length(exercises) > 0
      ORDER BY started_at ASC`,
    [startUTC.toISOString(), endUTC.toISOString()]
  );
  // pg returns jsonb already parsed; guard against a stringified column.
  const workouts = workoutRows.map(w => ({
    ...w,
    exercises: typeof w.exercises === 'string' ? safeParse(w.exercises) : (w.exercises || []),
  }));

  const [{ rows: tpls }, { rows: maps }, { rows: targetRows }] = await Promise.all([
    query(`SELECT hevy_id, primary_muscle_group, secondary_muscle_groups FROM hevy_template_cache`),
    query(`SELECT lower(ab_brain_exercise_name) AS name, hevy_exercise_template_id,
                  hevy_primary_muscle_group, hevy_secondary_muscle_groups, manual_muscle_override, muscle_unmapped
             FROM hevy_exercise_map`),
    query(`SELECT bucket, target_min, target_max FROM volume_targets`),
  ]);

  const resolver = buildResolver(tpls, maps);
  const targets = {};
  for (const t of targetRows) targets[t.bucket] = { target_min: t.target_min, target_max: t.target_max };

  const tally = tallyVolume(workouts, resolver, targets);
  return {
    week_start: monday,
    week_end: weekEnd,
    timezone: TZ,
    window_utc: { start: startUTC.toISOString(), end: endUTC.toISOString() },
    workouts_counted: workouts.length,
    ...tally,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return []; } }

module.exports = {
  TZ,
  WORKING_SET_TYPES,
  tzOffsetMs,
  etWallMidnightToUTC,
  etDateOf,
  mondayOf,
  resolveWeekStart,
  etWeekWindowUTC,
  countWorkingSets,
  tallyVolume,
  bucketForMuscleOrBucket,
  buildResolver,
  loadWeeklyVolume,
};
