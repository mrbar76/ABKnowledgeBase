// Apple Health ingest pipeline. Sniffs payload format, parses into
// daily_activity (cooperative per-format authority) and workouts. Idempotent
// at the file level (raw_health_imports.file_hash) and at the row level
// (daily_activity.activity_date UNIQUE, partial unique idx on workouts.started_at
// where source='apple_health').

const crypto = require('crypto');
const express = require('express');
const { query, logActivity } = require('../db');
const { computeTSS } = require('./insights');
const router = express.Router();

// Recompute workouts.tss for any rows missing tss within a date window.
// Called automatically after /reparse and after Format A/D ingest so the
// trends endpoints don't silently undercount load.
async function recomputeMissingTss(startDate, endDate) {
  const where = startDate && endDate
    ? `WHERE workout_date BETWEEN $1::date AND $2::date AND tss IS NULL`
    : `WHERE tss IS NULL`;
  const params = startDate && endDate ? [startDate, endDate] : [];
  const r = await query(
    `SELECT id, workout_date, time_duration, heart_rate_avg, effort, tss FROM workouts ${where}`,
    params
  );
  const dateZones = new Map();
  let updated = 0;
  for (const wo of r.rows) {
    if (!dateZones.has(wo.workout_date)) {
      const z = await query(
        `SELECT * FROM athlete_zones
         WHERE zone_type = 'heart_rate' AND effective_from <= $1
           AND (effective_to IS NULL OR effective_to >= $1)
         ORDER BY effective_from DESC LIMIT 1`,
        [wo.workout_date]
      );
      dateZones.set(wo.workout_date, z.rows[0] || null);
    }
    const tss = computeTSS(wo, dateZones.get(wo.workout_date));
    if (tss != null) {
      await query(`UPDATE workouts SET tss = $1 WHERE id = $2`, [tss, wo.id]);
      updated++;
    }
  }
  return updated;
}

const MILES_TO_KM = 1.609344;
const KM_TO_MI = 0.621371;
const M_TO_FT = 3.28084;
const M_TO_IN = 39.3701;
const MS_TO_MPH = 2.23694; // m/s → mph

// ─── Format detection ───────────────────────────────────────────

function detectFormat(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  if (body.activity && Array.isArray(body.activity.daily)) return 'A';
  if (Array.isArray(body.metrics) && body.date_range) return 'B';
  if (body.days && body.summaries) return 'C';
  // Health Auto Export native — accept any payload that has data.metrics OR
  // data.workouts (the two top-level arrays we parse). HAE's per-data-type
  // automations may send only one of them.
  if (body.data && (Array.isArray(body.data.metrics) || Array.isArray(body.data.workouts))) return 'D';
  return 'unknown';
}

// ─── Stable hash for file-level idempotency ─────────────────────
// Sorts object keys so two semantically-identical re-exports hash the same.

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function fileHash(body) {
  return crypto.createHash('sha256').update(stableStringify(body)).digest('hex');
}

// ─── Workout type heuristic (fallback when format C lookup misses) ──

function inferWorkoutType(w) {
  const indoor = w.isIndoor === true;
  const distKm = Number(w.distanceKm) || 0;
  const durSec = Number(w.durationSec) || 0;
  const elevM = Number(w.elevationAscendedM) || 0;
  const speedKmh = Number(w.averageSpeedKmh) || (durSec > 0 ? (distKm / (durSec / 3600)) : 0);

  if (indoor && distKm < 0.2) return 'strength';
  if (indoor && speedKmh > 8) return 'indoor_cardio';
  if (indoor) return 'other';
  // outdoor
  if (distKm > 0 && elevM / Math.max(distKm, 0.1) > 30) return 'hiking';
  if (speedKmh >= 7) return 'running';
  if (speedKmh >= 14) return 'cycling';
  if (speedKmh > 0) return 'walking';
  return 'other';
}

// ─── Per-format authority for daily_activity upserts ─────────────
// `authoritative` columns always overwrite (EXCLUDED.x).
// `fill_only` columns only fill nulls (COALESCE(table.x, EXCLUDED.x)).

const FIELD_AUTHORITY = {
  A: {
    authoritative: ['steps', 'distance_mi', 'exercise_minutes', 'flights_climbed',
                    'active_energy_kcal', 'workout_count'],
    fill_only: [],
  },
  B: {
    authoritative: ['resting_hr_bpm', 'walking_hr_avg_bpm', 'hrv_sdnn_ms',
                    'respiratory_rate_avg', 'walking_speed_mph', 'walking_steadiness_pct',
                    'walking_asymmetry_pct', 'heart_rate_avg_bpm', 'walking_step_length_in'],
    fill_only: [],
  },
  C: {
    authoritative: ['vo2_max', 'sleep_total_min', 'sleep_deep_min', 'sleep_rem_min',
                    'sleep_core_min', 'sleep_awake_min', 'sleep_efficiency_pct',
                    'basal_energy_kcal', 'stand_hours', 'stand_minutes'],
    fill_only: ['steps', 'distance_mi', 'exercise_minutes', 'flights_climbed',
                'active_energy_kcal', 'workout_count', 'resting_hr_bpm',
                'walking_hr_avg_bpm', 'hrv_sdnn_ms', 'respiratory_rate_avg',
                'walking_speed_mph', 'walking_steadiness_pct', 'walking_asymmetry_pct'],
  },
  // Format D = Health Auto Export. Same authority as B (recovery/mobility own;
  // movement metrics are fill-only since A is canonical for those).
  D: {
    authoritative: ['resting_hr_bpm', 'walking_hr_avg_bpm', 'hrv_sdnn_ms',
                    'respiratory_rate_avg', 'walking_speed_mph', 'walking_steadiness_pct',
                    'walking_asymmetry_pct', 'heart_rate_avg_bpm', 'walking_step_length_in'],
    fill_only: [],
  },
};

const ALL_DAILY_COLS = [
  'steps', 'distance_mi', 'exercise_minutes', 'flights_climbed', 'active_energy_kcal',
  'basal_energy_kcal', 'stand_hours', 'stand_minutes', 'workout_count',
  'resting_hr_bpm', 'walking_hr_avg_bpm', 'hrv_sdnn_ms', 'respiratory_rate_avg',
  'vo2_max', 'walking_speed_mph', 'walking_steadiness_pct', 'walking_asymmetry_pct',
  'heart_rate_avg_bpm', 'walking_step_length_in',
  'sleep_total_min', 'sleep_deep_min', 'sleep_rem_min', 'sleep_core_min',
  'sleep_awake_min', 'sleep_efficiency_pct',
  'sleep_in_bed_start', 'sleep_in_bed_end',
];

async function upsertDailyActivity(format, dateRows) {
  const auth = FIELD_AUTHORITY[format];
  if (!auth) return { inserted: 0, updated: 0 };

  let inserted = 0;
  let updated = 0;
  for (const row of dateRows) {
    const cols = ['activity_date', ...ALL_DAILY_COLS, 'sources'];
    const values = [row.activity_date, ...ALL_DAILY_COLS.map(c => row[c] ?? null),
                    JSON.stringify({ [format]: new Date().toISOString() })];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    // ON CONFLICT: per-format authority via SET clause
    const setClauses = ALL_DAILY_COLS.map(col => {
      if (auth.authoritative.includes(col)) {
        return `${col} = EXCLUDED.${col}`;
      }
      return `${col} = COALESCE(daily_activity.${col}, EXCLUDED.${col})`;
    });
    setClauses.push(`sources = daily_activity.sources || EXCLUDED.sources`);
    setClauses.push(`updated_at = NOW()`);

    const sql = `
      INSERT INTO daily_activity (${cols.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (activity_date) DO UPDATE SET ${setClauses.join(', ')}
      RETURNING (xmax = 0) AS inserted_now`;

    try {
      const result = await query(sql, values);
      if (result.rows[0].inserted_now) inserted++; else updated++;
    } catch (err) {
      console.error(`[health/ingest] daily_activity upsert failed for ${row.activity_date}: ${err.message}`);
    }
  }
  return { inserted, updated };
}

// ─── Energy field extractor ─────────────────────────────────────
// Apple Watch / HAE workouts come in with calorie data under varying
// key names. v1.8.14 unified extractor: try canonical, older, flat
// numeric, and Format-A variants, return the kcal number or null.
//
// Accepts:
//   { activeEnergyBurned: { qty: 365, units: 'kcal' } }     ← canonical
//   { activeEnergyBurned: 365 }                              ← flat
//   { activeEnergyKcal: 365 }                                ← Format A
function pickEnergyKcal(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'object' && v.qty != null && Number.isFinite(Number(v.qty))) return Number(v.qty);
    if (typeof v === 'string' && /\d/.test(v)) {
      const n = Number(v.replace(/[^\d.]/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ─── Format A parser ────────────────────────────────────────────

function parseFormatA(body) {
  const dailyRows = [];
  const workouts = [];

  for (const d of body.activity.daily || []) {
    dailyRows.push({
      activity_date: d.date,
      steps: d.steps ?? null,
      distance_mi: d.distanceKm != null ? round3(d.distanceKm * KM_TO_MI) : null,
      exercise_minutes: d.exerciseMinutes ?? null,
      flights_climbed: d.flightsClimbed ?? null,
      active_energy_kcal: d.activeEnergyKcal ?? null,
      // BUG FIX (v1.8.8): basal_energy_kcal was omitted here, causing
      // the Macros tab to show OUT = active_only (~500-1500 kcal)
      // instead of active + basal (~2500-3500 kcal). Result: every
      // training day looked like a massive surplus when it was
      // actually balanced. Format B parsing at line ~714 already
      // captures it; Format A was missing.
      basal_energy_kcal: d.basalEnergyKcal ?? null,
      workout_count: d.workoutCount ?? null,
    });
  }

  for (const w of body.activity.workouts || []) {
    const endIso = w.end;
    const durSec = Number(w.durationSec) || 0;
    const startedAt = w.start || (endIso && durSec > 0
      ? new Date(new Date(endIso).getTime() - durSec * 1000).toISOString()
      : (Array.isArray(w.route) && w.route[0] ? w.route[0].t : null));

    const inferredType = inferWorkoutType(w);
    const workoutDate = (startedAt || endIso || '').slice(0, 10);

    workouts.push({
      started_at: startedAt,
      ended_at: endIso,
      workout_date: workoutDate,
      workout_type: inferredType,
      inferred_workout_type: true,
      distance: w.distanceKm != null ? `${(w.distanceKm * KM_TO_MI).toFixed(2)} mi` : null,
      time_duration: durSec > 0 ? formatDuration(durSec) : null,
      elevation_gain: w.elevationAscendedM != null ? `${Math.round(w.elevationAscendedM * M_TO_FT)} ft` : null,
      heart_rate_avg: sanitizeHrText(w.averageHeartRateBpm),
      heart_rate_max: sanitizeHrText(w.maxHeartRateBpm),
      pace_avg: w.averagePaceSecPerKm != null ? formatPace(w.averagePaceSecPerKm * MILES_TO_KM, 'mi') : null,
      // v1.8.14: same robust calorie extractor as Format D so workouts
      // populate active_calories regardless of which field name HAE
      // shipped this version.
      active_calories: (() => {
        const a = pickEnergyKcal(w, ['activeEnergyKcal', 'activeEnergyBurned', 'activeEnergy'])
          ?? pickEnergyKcal(w?.metrics, ['activeEnergy', 'activeEnergyBurned']);
        if (a == null) console.warn(`[health/Format A] no calories on workout ${startedAt}; payload keys: ${Object.keys(w).join(',')}`);
        return a != null ? String(Math.round(a)) : null;
      })(),
      total_calories: (() => {
        const t = pickEnergyKcal(w, ['totalEnergyKcal', 'totalEnergyBurned', 'totalEnergy'])
          ?? pickEnergyKcal(w?.metrics, ['totalEnergy', 'totalEnergyBurned']);
        if (t != null) return String(Math.round(t));
        const a = pickEnergyKcal(w, ['activeEnergyKcal', 'activeEnergyBurned', 'activeEnergy']);
        const b = pickEnergyKcal(w, ['basalEnergyKcal', 'basalEnergyBurned', 'basalEnergy']);
        return (a != null && b != null) ? String(Math.round(a + b)) : null;
      })(),
      location: w.isIndoor ? 'indoor' : 'outdoor',
      source: 'apple_health',
      ai_source: null,
      metadata: {
        events: w.events || [],
        route: w.route || [],
        isIndoor: w.isIndoor,
        averageSpeedKmh: w.averageSpeedKmh,
        minHeartRateBpm: w.minHeartRateBpm,
        basalEnergyKcal: w.basalEnergyKcal,
        timeZone: body.activity.timeZone,
      },
    });
  }

  return { dailyRows, workouts };
}

// v1.8.17: never let "nan" / "null" / "none" land in TEXT HR columns.
// Coach found Vernon walking record had hr_avg = 'nan' (literal string)
// because Python's NaN got string-coerced when the importer averaged
// an empty list. Returns null for non-finite or string-NaN inputs.
function sanitizeHrText(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    if (!lower || ['nan', 'null', 'none', '-', 'undefined'].includes(lower)) return null;
  }
  const n = Number(typeof v === 'string' ? v.replace(/[^\d.]/g, '') : v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n));
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatPace(secPerUnit, unit = 'mi') {
  const m = Math.floor(secPerUnit / 60);
  const s = Math.round(secPerUnit % 60);
  return `${m}:${String(s).padStart(2, '0')}/${unit}`;
}

// ─── Format B parser (aggregate samples → per-day stats) ─────────

// Apple Shortcuts / Health Auto Export send PascalCase HealthKit identifiers,
// optionally prefixed with `HKQuantityTypeIdentifier` or `HKCategoryTypeIdentifier`.
// Normalize to a lowercase key with the prefix stripped so we can match either form.
function normalizeMetricId(id) {
  if (!id) return '';
  return String(id)
    .replace(/^HK(Quantity|Category|Correlation)TypeIdentifier/i, '')
    .toLowerCase();
}

// target='daily'        → aggregate into a daily_activity row
// target='body_metric'  → upsert into body_metrics keyed by date
// scale                 → multiplier applied after aggregation (unit conversion)
const B_METRIC_MAP = {
  // recovery / readiness → daily_activity
  heartratevariabilitysdnn: { col: 'hrv_sdnn_ms',         agg: 'mean', target: 'daily' },
  heartratevariability:     { col: 'hrv_sdnn_ms',         agg: 'mean', target: 'daily' },
  hrv:                      { col: 'hrv_sdnn_ms',         agg: 'mean', target: 'daily' },
  restingheartrate:         { col: 'resting_hr_bpm',      agg: 'mean', target: 'daily' },
  walkingheartrateaverage:  { col: 'walking_hr_avg_bpm',  agg: 'mean', target: 'daily' },
  heartrate:                { col: 'heart_rate_avg_bpm',  agg: 'mean', target: 'daily' },
  respiratoryrate:          { col: 'respiratory_rate_avg', agg: 'mean', target: 'daily' },
  vo2max:                   { col: 'vo2_max',             agg: 'mean', target: 'daily' },

  // gait / mobility → daily_activity (HealthKit walking_speed is m/s; asymmetry/steadiness are 0..1 fractions)
  walkingspeed:                  { col: 'walking_speed_mph',     agg: 'mean', scale: MS_TO_MPH, target: 'daily' }, // m/s → mph
  walkingsteadiness:             { col: 'walking_steadiness_pct', agg: 'mean', scale: 100, target: 'daily' },
  appwalkingsteadiness:          { col: 'walking_steadiness_pct', agg: 'mean', scale: 100, target: 'daily' },
  walkingasymmetrypercentage:    { col: 'walking_asymmetry_pct',  agg: 'mean', scale: 100, target: 'daily' },
  walkingasymmetry:              { col: 'walking_asymmetry_pct',  agg: 'mean', scale: 100, target: 'daily' },
  walkingsteplength:             { col: 'walking_step_length_in', agg: 'mean', scale: M_TO_IN, target: 'daily' }, // m → in

  // movement → daily_activity (B is fill-only; A remains authoritative when present)
  stepcount:               { col: 'steps',              agg: 'sum',  target: 'daily' },
  steps:                   { col: 'steps',              agg: 'sum',  target: 'daily' },
  flightsclimbed:          { col: 'flights_climbed',    agg: 'sum',  target: 'daily' },
  activeenergyburned:      { col: 'active_energy_kcal', agg: 'sum',  target: 'daily' },
  basalenergyburned:       { col: 'basal_energy_kcal',  agg: 'sum',  target: 'daily' },
  appleexercisetime:       { col: 'exercise_minutes',   agg: 'sum',  target: 'daily' },
  distancewalkingrunning:  { col: 'distance_mi',        agg: 'sum',  scale: 0.001 * KM_TO_MI, target: 'daily' }, // m → mi

  // body composition → body_metrics (HealthKit BodyFatPercentage is 0..1)
  bodyfatpercentage: { col: 'body_fat_pct',  agg: 'mean', scale: 100, target: 'body_metric' },
  bodymassindex:     { col: 'bmi',           agg: 'mean',             target: 'body_metric' },
  bodymass:          { col: 'weight_lb',     agg: 'mean', scale: 2.2046226218, target: 'body_metric' }, // kg → lb
  leanbodymass:      { col: 'lean_mass_lb',  agg: 'mean', scale: 2.2046226218, target: 'body_metric' }, // kg → lb

  // Sleep analysis — handled out-of-band in parseFormatB via a dedicated
  // branch (same pattern as parseFormatD). Without this entry, Format B
  // exports silently skip sleep — every dashboard sleep panel reads null.
  sleepanalysis: { target: 'sleep' },
};

function parseFormatB(body) {
  const byDate = new Map();         // daily_activity rows
  const bodyByDate = new Map();     // body_metrics rows (date → { col: value })
  const skippedMetrics = [];
  const mappedMetrics = [];

  for (const metric of body.metrics || []) {
    const key = normalizeMetricId(metric.id);
    const map = B_METRIC_MAP[key];
    if (!map) { skippedMetrics.push(metric.id); continue; }
    mappedMetrics.push(metric.id);

    // Sleep analysis is special — value is a category (asleep / core / rem /
    // deep / awake / inBed) and minutes come from the start_date→end_date
    // window, not from a numeric `value` field. Same dual-form handling as
    // parseFormatD. Without this branch Format B exports silently dropped
    // every sleep night.
    if (map.target === 'sleep') {
      const phaseAccum = new Map(); // date → { asleep, core, rem, deep, awake, inBed, firstStart, lastEnd }
      const ensureAcc = (d) => {
        if (!phaseAccum.has(d)) phaseAccum.set(d, { asleep: 0, core: 0, rem: 0, deep: 0, awake: 0, inBed: 0, firstStart: null, lastEnd: null });
        return phaseAccum.get(d);
      };
      const recordTimestamps = (acc, startStr, endStr) => {
        if (startStr) {
          const t = new Date(startStr);
          if (!isNaN(t.getTime()) && (acc.firstStart == null || t < acc.firstStart)) acc.firstStart = t;
        }
        if (endStr) {
          const t = new Date(endStr);
          if (!isNaN(t.getTime()) && (acc.lastEnd == null || t > acc.lastEnd)) acc.lastEnd = t;
        }
      };

      for (const dp of metric.data_points || []) {
        const startStr = dp.start_date || dp.startDate;
        const endStr = dp.end_date || dp.endDate;
        if (!startStr || !endStr) continue;
        const startMs = new Date(startStr).getTime();
        const endMs = new Date(endStr).getTime();
        if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) continue;
        const hrs = (endMs - startMs) / 3600000;
        // Sleep stretching across midnight is filed under the wake date
        // (typical Apple convention — match Format D so dashboards align).
        const d = String(endStr).slice(0, 10);

        // Normalize the category. HKCategoryValueSleepAnalysis prefix is
        // sometimes present, sometimes already stripped by HAE.
        const v = String(dp.value ?? '').toLowerCase()
          .replace(/\s+/g, '')
          .replace(/^hkcategoryvaluesleepanalysis/, '');
        const acc = ensureAcc(d);
        if (v === 'asleep' || v === 'unspecified' || v === 'asleepunspecified') acc.asleep += hrs;
        else if (v === 'core' || v === 'asleepcore') acc.core += hrs;
        else if (v === 'rem' || v === 'asleeprem') acc.rem += hrs;
        else if (v === 'deep' || v === 'asleepdeep') acc.deep += hrs;
        else if (v === 'awake') acc.awake += hrs;
        else if (v === 'inbed' || v === 'in_bed') acc.inBed += hrs;
        recordTimestamps(acc, startStr, endStr);
      }

      for (const [d, p] of phaseAccum) {
        if (!byDate.has(d)) byDate.set(d, { activity_date: d });
        const row = byDate.get(d);
        const total = p.core + p.rem + p.deep + p.asleep;
        if (total > 0) row.sleep_total_min = Math.round(total * 60);
        if (p.deep > 0) row.sleep_deep_min = Math.round(p.deep * 60);
        if (p.rem > 0) row.sleep_rem_min = Math.round(p.rem * 60);
        if (p.core > 0) row.sleep_core_min = Math.round(p.core * 60);
        if (p.awake > 0) row.sleep_awake_min = Math.round(p.awake * 60);
        const inBed = p.inBed > 0 ? p.inBed : (total + p.awake);
        if (inBed > 0 && total > 0) row.sleep_efficiency_pct = round1((total / inBed) * 100);
        if (p.firstStart) row.sleep_in_bed_start = p.firstStart.toISOString();
        if (p.lastEnd) row.sleep_in_bed_end = p.lastEnd.toISOString();
      }
      continue;
    }

    const buckets = new Map(); // date → values[]
    for (const dp of metric.data_points || []) {
      const d = (dp.start_date || dp.timestamp || dp.date || '').slice(0, 10);
      if (!d) continue;
      const raw = dp.value ?? dp.qty ?? dp.quantity;
      const v = Number(raw);
      if (!isFinite(v)) continue;
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d).push(v);
    }

    for (const [date, vals] of buckets) {
      const agg = map.agg === 'mean'
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : map.agg === 'max' ? Math.max(...vals)
        : map.agg === 'min' ? Math.min(...vals)
        : vals.reduce((a, b) => a + b, 0);
      const scaled = agg * (map.scale || 1);

      if (map.target === 'body_metric') {
        if (!bodyByDate.has(date)) bodyByDate.set(date, { measurement_date: date });
        bodyByDate.get(date)[map.col] = round2(scaled);
      } else {
        if (!byDate.has(date)) byDate.set(date, { activity_date: date });
        byDate.get(date)[map.col] = roundForCol(map.col, scaled);
      }
    }
  }

  return {
    dailyRows: Array.from(byDate.values()),
    bodyMetricRows: Array.from(bodyByDate.values()),
    mappedMetrics,
    skippedMetrics,
  };
}

// Health Auto Export workouts (data.workouts[]) → workouts table rows.
// HAE provides explicit workout type, so inferred_workout_type=false.
function parseFormatDWorkouts(body) {
  const out = [];
  for (const w of body.data?.workouts || []) {
    const startedAt = w.start;
    const endedAt = w.end;
    const durSec = Number(w.duration) || 0;
    const workoutDate = (startedAt || endedAt || '').slice(0, 10);
    if (!startedAt) continue;

    const distQty = w.distance?.qty;
    const distUnits = w.distance?.units;
    const elevUpQty = w.elevationUp?.qty;
    const elevUpUnits = w.elevationUp?.units;
    const hrSummary = w.heartRate || {};
    const avgHR = hrSummary.avg ?? w.avgHeartRate;
    const maxHR = hrSummary.max ?? w.maxHeartRate;

    // Coach bug #1 (v1.8.14): every Apple Watch workout was logging
    // calories_burned: None because the parser only checked one field
    // shape. HAE exports workouts with calorie data under several keys
    // depending on version + config:
    //   activeEnergyBurned: { qty, units }     ← canonical HAE
    //   activeEnergy:       { qty, units }     ← older HAE
    //   activeEnergyKcal:    <number>          ← Format A custom dispatch
    //   activeEnergyBurned:  <number>          ← flat numeric variant
    //   metrics.activeEnergy ← seen in newer HAE
    // Try all known shapes and log the keys that WERE in the payload
    // when none match, so future drift is visible.
    const activeKcal = pickEnergyKcal(w, ['activeEnergyBurned', 'activeEnergy', 'activeEnergyKcal'])
      ?? pickEnergyKcal(w?.metrics, ['activeEnergy', 'activeEnergyBurned']);
    const totalKcal = pickEnergyKcal(w, ['totalEnergy', 'totalEnergyBurned', 'totalEnergyKcal'])
      ?? pickEnergyKcal(w?.metrics, ['totalEnergy', 'totalEnergyBurned']);
    const basalKcal = pickEnergyKcal(w, ['basalEnergyBurned', 'basalEnergy', 'basalEnergyKcal'])
      ?? pickEnergyKcal(w?.metrics, ['basalEnergy', 'basalEnergyBurned']);
    // Compute total if missing but active+basal both present.
    const totalComputed = (totalKcal == null && activeKcal != null && basalKcal != null)
      ? activeKcal + basalKcal
      : totalKcal;
    if (activeKcal == null) {
      console.warn(`[health/parseFormatDWorkouts] no calories on ${w.name || 'workout'} ${startedAt}; payload keys: ${Object.keys(w).join(',')}`);
    }

    out.push({
      started_at: startedAt,
      ended_at: endedAt,
      workout_date: workoutDate,
      workout_type: normalizeWorkoutType(w.name),
      inferred_workout_type: false,
      time_duration: durSec > 0 ? formatDuration(durSec) : null,
      distance: distQty != null ? `${Number(distQty).toFixed(2)} ${distUnits || 'mi'}` : null,
      elevation_gain: elevUpQty != null ? `${Math.round(Number(elevUpQty))} ${elevUpUnits || 'ft'}` : null,
      heart_rate_avg: sanitizeHrText(avgHR),
      heart_rate_max: sanitizeHrText(maxHR),
      pace_avg: null,
      active_calories: activeKcal != null ? String(Math.round(activeKcal)) : null,
      total_calories: totalComputed != null ? String(Math.round(totalComputed)) : null,
      location: typeof w.location === 'string' ? w.location.toLowerCase() : null,
      source: 'apple_health',
      ai_source: null,
      metadata: {
        hae_id: w.id,
        hae_name: w.name,
        avgSpeed: w.avgSpeed,
        maxSpeed: w.maxSpeed,
        intensity: w.intensity,
        temperature: w.temperature,
        humidity: w.humidity,
        elevationDown: w.elevationDown,
        heartRateData: w.heartRateData || [],
        route: w.route || [],
      },
    });
  }
  return out;
}

function roundForCol(col, n) {
  if (isIntColumn(col)) return Math.round(n);
  if (col === 'distance_mi') return Math.round(n * 1000) / 1000;
  if (col === 'walking_step_length_in') return Math.round(n * 10) / 10;
  return Math.round(n * 10) / 10;
}

function isIntColumn(col) {
  return col === 'steps' || col === 'flights_climbed' || col === 'exercise_minutes'
    || col === 'resting_hr_bpm' || col === 'walking_hr_avg_bpm' || col === 'heart_rate_avg_bpm';
}

function round2(n) { return Math.round(n * 100) / 100; }

// ─── Format D parser (Health Auto Export native format) ──────────
// Shape: { data: { metrics: [{ name, units, data: [{date, qty, source}, ...] }] } }
// Health Auto Export respects iOS Health unit settings, so values are already
// in whatever units the user has set (typically imperial here). Date format
// is "2026-05-01 08:27:00 -0400" which still works with slice(0,10).

const D_METRIC_MAP = {
  // Movement (Format A is canonical; Format D fills nulls)
  step_count:                 { col: 'steps',              agg: 'sum',  target: 'daily' },
  walking_running_distance:   { col: 'distance_mi',        agg: 'sum',  target: 'daily' },
  flights_climbed:            { col: 'flights_climbed',    agg: 'sum',  target: 'daily' },
  apple_exercise_time:        { col: 'exercise_minutes',   agg: 'sum',  target: 'daily' },
  apple_stand_hour:           { col: 'stand_hours',        agg: 'sum',  target: 'daily' },
  apple_stand_time:           { col: 'stand_minutes',      agg: 'sum',  target: 'daily' },
  active_energy:              { col: 'active_energy_kcal', agg: 'sum',  target: 'daily' },
  basal_energy_burned:        { col: 'basal_energy_kcal',  agg: 'sum',  target: 'daily' },

  // Recovery / readiness — Format D is authoritative
  heart_rate_variability:     { col: 'hrv_sdnn_ms',          agg: 'mean', target: 'daily' },
  resting_heart_rate:         { col: 'resting_hr_bpm',       agg: 'mean', target: 'daily' },
  walking_heart_rate_average: { col: 'walking_hr_avg_bpm',   agg: 'mean', target: 'daily' },
  heart_rate:                 { col: 'heart_rate_avg_bpm',   agg: 'mean', target: 'daily' },
  respiratory_rate:           { col: 'respiratory_rate_avg', agg: 'mean', target: 'daily' },
  vo2_max:                    { col: 'vo2_max',              agg: 'mean', target: 'daily' },

  // Mobility (already imperial from Health Auto Export)
  walking_speed:                { col: 'walking_speed_mph',     agg: 'mean', target: 'daily' },
  walking_step_length:          { col: 'walking_step_length_in', agg: 'mean', target: 'daily' },
  walking_asymmetry_percentage: { col: 'walking_asymmetry_pct',  agg: 'mean', target: 'daily' },
  walking_steadiness:           { col: 'walking_steadiness_pct', agg: 'mean', target: 'daily' },

  // Body composition. Health Auto Export emits weights in user's iOS unit
  // (lb here). If we ever see metric.units === 'kg' we scale at parse time.
  body_fat_percentage: { col: 'body_fat_pct', agg: 'mean', target: 'body_metric' },
  body_mass:           { col: 'weight_lb',    agg: 'mean', target: 'body_metric' },
  'weight_&_body_mass': { col: 'weight_lb',   agg: 'mean', target: 'body_metric' },
  weight_body_mass:    { col: 'weight_lb',    agg: 'mean', target: 'body_metric' },
  body_mass_index:     { col: 'bmi',          agg: 'mean', target: 'body_metric' },
  lean_body_mass:      { col: 'lean_mass_lb', agg: 'mean', target: 'body_metric' },

  // Sleep analysis is special — has multiple fields per data point. Handled
  // out-of-band in parseFormatD via a dedicated branch.
  sleep_analysis: { target: 'sleep' },
};

function parseFormatD(body) {
  const byDate = new Map();
  const bodyByDate = new Map();
  const skippedMetrics = [];
  const mappedMetrics = [];

  for (const metric of body.data.metrics || []) {
    const name = String(metric.name || '').toLowerCase().trim();
    const map = D_METRIC_MAP[name];
    if (!map) { skippedMetrics.push(metric.name); continue; }
    mappedMetrics.push(metric.name);

    // Sleep analysis ships in two shapes from HAE:
    //   1. Aggregated: one row per night with totalSleep / deep / rem / core /
    //      asleep / inBed (in hours).
    //   2. Unaggregated: one row per sleep PHASE with startDate / endDate /
    //      qty / value where value is "Asleep" / "Core" / "REM" / "Deep" /
    //      "Awake" / "In Bed". qty is in metric.units (typically "hr").
    // Detect which form we have by inspecting the first data point with keys.
    if (map.target === 'sleep') {
      // phaseAccum tracks per-night totals plus first-in-bed and last-out-of-
      // bed timestamps. The latter two power Sleep Score consistency
      // (bedtime stddev) and bedtime regularity in /insights/trends.sleep.
      const phaseAccum = new Map(); // date → { asleep, core, rem, deep, awake, inBed, firstStart, lastEnd }
      const recordTimestamps = (acc, startStr, endStr) => {
        if (startStr) {
          const t = new Date(startStr);
          if (!isNaN(t.getTime()) && (acc.firstStart == null || t < acc.firstStart)) acc.firstStart = t;
        }
        if (endStr) {
          const t = new Date(endStr);
          if (!isNaN(t.getTime()) && (acc.lastEnd == null || t > acc.lastEnd)) acc.lastEnd = t;
        }
      };
      const ensureAcc = (d) => {
        if (!phaseAccum.has(d)) phaseAccum.set(d, { asleep: 0, core: 0, rem: 0, deep: 0, awake: 0, inBed: 0, firstStart: null, lastEnd: null });
        return phaseAccum.get(d);
      };

      for (const dp of metric.data || []) {
        // Aggregated branch (multi-field per row)
        if (dp.totalSleep != null || dp.asleep != null || dp.deep != null || dp.rem != null || dp.core != null) {
          const dateStr = dp.sleepEnd || dp.inBedEnd || dp.date;
          if (!dateStr) continue;
          const d = String(dateStr).slice(0, 10);
          if (!byDate.has(d)) byDate.set(d, { activity_date: d });
          const row = byDate.get(d);
          if (dp.totalSleep != null) row.sleep_total_min = Math.round(dp.totalSleep * 60);
          if (dp.deep != null) row.sleep_deep_min = Math.round(dp.deep * 60);
          if (dp.rem != null) row.sleep_rem_min = Math.round(dp.rem * 60);
          if (dp.core != null) row.sleep_core_min = Math.round(dp.core * 60);
          if (dp.inBed != null && dp.asleep != null) {
            row.sleep_awake_min = Math.round(Math.max(0, (dp.inBed - dp.asleep) * 60));
            if (dp.inBed > 0) row.sleep_efficiency_pct = round1((dp.asleep / dp.inBed) * 100);
          }
          // Aggregated form sometimes carries inBedStart/sleepStart and
          // inBedEnd/sleepEnd — capture the bedtime/wake-time window.
          const acc = ensureAcc(d);
          recordTimestamps(acc, dp.inBedStart || dp.sleepStart, dp.inBedEnd || dp.sleepEnd);
          continue;
        }
        // Unaggregated branch (one phase per row)
        const dateStr = dp.endDate || dp.end_date || dp.date || dp.startDate;
        if (!dateStr) continue;
        const d = String(dateStr).slice(0, 10);
        const value = String(dp.value || '').toLowerCase().replace(/\s+/g, '');
        const qty = Number(dp.qty ?? dp.value_qty ?? dp.duration);
        if (!isFinite(qty) || qty <= 0) continue;
        // qty unit normalization. metric.units typically "hr"; sometimes "min"
        // (HAE older builds). Convert everything to hours.
        const unitMul = String(metric.units || '').toLowerCase().startsWith('min') ? (1/60) : 1;
        const hrs = qty * unitMul;
        const acc = ensureAcc(d);
        if (value === 'asleep' || value === 'asleepunspecified' || value === 'unspecified') acc.asleep += hrs;
        else if (value === 'core' || value === 'asleepcore') acc.core += hrs;
        else if (value === 'rem' || value === 'asleeprem') acc.rem += hrs;
        else if (value === 'deep' || value === 'asleepdeep') acc.deep += hrs;
        else if (value === 'awake') acc.awake += hrs;
        else if (value === 'inbed' || value === 'in_bed') acc.inBed += hrs;
        // Capture timestamps from each phase row — earliest start = bedtime,
        // latest end = wake time.
        recordTimestamps(acc, dp.startDate || dp.start_date, dp.endDate || dp.end_date);
      }
      // Roll phaseAccum into daily_activity rows
      for (const [d, p] of phaseAccum) {
        if (!byDate.has(d)) byDate.set(d, { activity_date: d });
        const row = byDate.get(d);
        // Total = Core + REM + Deep + (any plain Asleep that wasn't classified)
        const total = p.core + p.rem + p.deep + p.asleep;
        if (total > 0) row.sleep_total_min = Math.round(total * 60);
        if (p.deep > 0) row.sleep_deep_min = Math.round(p.deep * 60);
        if (p.rem > 0) row.sleep_rem_min = Math.round(p.rem * 60);
        if (p.core > 0) row.sleep_core_min = Math.round(p.core * 60);
        if (p.awake > 0) row.sleep_awake_min = Math.round(p.awake * 60);
        const inBed = p.inBed > 0 ? p.inBed : (total + p.awake);
        if (inBed > 0 && total > 0) row.sleep_efficiency_pct = round1((total / inBed) * 100);
        if (p.firstStart) row.sleep_in_bed_start = p.firstStart.toISOString();
        if (p.lastEnd) row.sleep_in_bed_end = p.lastEnd.toISOString();
      }
      continue;
    }

    // Unit-aware conversion for the few metrics where users may have non-imperial
    let scale = 1;
    const u = String(metric.units || '').toLowerCase();
    if (map.col === 'weight_lb' || map.col === 'lean_mass_lb') {
      if (u === 'kg') scale = 2.2046226218;
    } else if (map.col === 'distance_mi') {
      if (u === 'km') scale = 0.621371;
    } else if (map.col === 'walking_speed_mph') {
      if (u === 'km/hr' || u === 'kmh' || u === 'km/h') scale = 0.621371;
      else if (u === 'm/s') scale = 2.23694;
    } else if (map.col === 'walking_step_length_in') {
      if (u === 'cm') scale = 0.393701;
      else if (u === 'm') scale = 39.3701;
    }

    const buckets = new Map();
    for (const dp of metric.data || []) {
      const dateStr = dp.date || dp.start_date || dp.timestamp;
      if (!dateStr) continue;
      const d = String(dateStr).slice(0, 10);
      const raw = dp.Avg ?? dp.qty ?? dp.value ?? dp.quantity;
      const v = Number(raw);
      if (!isFinite(v)) continue;
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d).push(v);
    }

    for (const [date, vals] of buckets) {
      const agg = map.agg === 'mean'
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : map.agg === 'max' ? Math.max(...vals)
        : map.agg === 'min' ? Math.min(...vals)
        : vals.reduce((a, b) => a + b, 0);
      const scaled = agg * scale;

      if (map.target === 'body_metric') {
        if (!bodyByDate.has(date)) bodyByDate.set(date, { measurement_date: date });
        bodyByDate.get(date)[map.col] = round2(scaled);
      } else {
        if (!byDate.has(date)) byDate.set(date, { activity_date: date });
        byDate.get(date)[map.col] = roundForCol(map.col, scaled);
      }
    }
  }

  return {
    dailyRows: Array.from(byDate.values()),
    bodyMetricRows: Array.from(bodyByDate.values()),
    mappedMetrics,
    skippedMetrics,
  };
}

function round1(n) { return Math.round(n * 10) / 10; }

// ─── Format C parser (lode-export, yearly) ──────────────────────

function parseFormatC(body) {
  const dailyRows = [];
  const workoutTypeOverrides = []; // {time, type, durationMinutes, distanceKm} for matching

  for (const [date, day] of Object.entries(body.days || {})) {
    const row = { activity_date: date };

    if (day.activity) {
      const a = day.activity;
      if (a.steps != null) row.steps = a.steps;
      if (a.walkingRunningDistance != null) row.distance_mi = round3(a.walkingRunningDistance);
      if (a.flightsClimbed != null) row.flights_climbed = a.flightsClimbed;
      if (a.activeCalories != null) row.active_energy_kcal = a.activeCalories;
      if (a.basalEnergy != null) row.basal_energy_kcal = a.basalEnergy;
      if (a.standHours != null) row.stand_hours = a.standHours;
      if (a.standMinutes != null) row.stand_minutes = a.standMinutes;
    }
    if (day.exercise) {
      if (day.exercise.exerciseMinutes != null) row.exercise_minutes = day.exercise.exerciseMinutes;
      if (Array.isArray(day.exercise.workouts)) {
        row.workout_count = day.exercise.workouts.length;
        for (const w of day.exercise.workouts) {
          if (w.time && w.type) {
            workoutTypeOverrides.push({
              time: w.time,
              type: w.type,
              durationMinutes: w.durationMinutes,
              distanceKm: w.distanceMiles != null ? w.distanceMiles * MILES_TO_KM : null,
              source: w.source,
            });
          }
        }
      }
    }
    if (day.heart) {
      if (day.heart.restingHeartRate != null) row.resting_hr_bpm = Math.round(day.heart.restingHeartRate);
      if (day.heart.walkingHeartRateAverage != null) row.walking_hr_avg_bpm = Math.round(day.heart.walkingHeartRateAverage);
      if (day.heart.heartRateVariability != null) row.hrv_sdnn_ms = round1(day.heart.heartRateVariability);
    }
    if (day.respiratory) {
      if (day.respiratory.respiratoryRate != null) row.respiratory_rate_avg = round1(day.respiratory.respiratoryRate);
    }
    if (day.mobility) {
      if (day.mobility.walkingSpeed != null) row.walking_speed_mph = round1(day.mobility.walkingSpeed);
      if (day.mobility.walkingSteadiness != null) row.walking_steadiness_pct = round1(day.mobility.walkingSteadiness);
    }
    if (day.exercise && day.exercise.vo2Max != null) row.vo2_max = round1(day.exercise.vo2Max);
    if (day.body && day.body.vo2Max != null) row.vo2_max = round1(day.body.vo2Max);
    if (day.sleep) {
      const s = day.sleep;
      if (s.totalMinutes != null) row.sleep_total_min = s.totalMinutes;
      if (s.deepMinutes != null) row.sleep_deep_min = s.deepMinutes;
      if (s.remMinutes != null) row.sleep_rem_min = s.remMinutes;
      if (s.coreMinutes != null) row.sleep_core_min = s.coreMinutes;
      if (s.awakeMinutes != null) row.sleep_awake_min = s.awakeMinutes;
      if (s.efficiency != null) row.sleep_efficiency_pct = round1(s.efficiency);
      // Alternative shapes
      if (s.byStage) {
        if (s.byStage.deep != null) row.sleep_deep_min = Math.round(s.byStage.deep);
        if (s.byStage.rem != null) row.sleep_rem_min = Math.round(s.byStage.rem);
        if (s.byStage.core != null) row.sleep_core_min = Math.round(s.byStage.core);
        if (s.byStage.awake != null) row.sleep_awake_min = Math.round(s.byStage.awake);
      }
      if (s.averageHours != null && row.sleep_total_min == null) {
        row.sleep_total_min = Math.round(s.averageHours * 60);
      }
    }

    dailyRows.push(row);
  }

  return { dailyRows, workoutTypeOverrides };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// ─── Workout upsert ─────────────────────────────────────────────

// Window (seconds) for matching an Apple Health workout to an existing
// manually-logged workout. Apple's clock and the user's manual log can drift
// by a few minutes; 15min comfortably covers race starts and tap-to-end lag.
const WORKOUT_MERGE_WINDOW_SEC = 900;

// Auto-link a freshly inserted/merged Apple Health workout to today's
// plan + the apple_health-target segment. Falls back to first segment
// of any kind if no apple_health segment exists. No-op when no plan
// exists for the workout's date.
async function linkWorkoutToPlan(workoutId, workoutDate, source) {
  if (!workoutId || !workoutDate) return;
  try {
    const targetPref = source === 'apple_health' ? 'apple_health'
      : source === 'hevy' ? 'hevy' : 'manual';
    const r = await query(
      `SELECT dp.id AS plan_id,
        (SELECT id FROM plan_segments
         WHERE daily_plan_id = dp.id AND logging_target = $2
         ORDER BY block_order LIMIT 1) AS preferred_segment_id,
        (SELECT id FROM plan_segments
         WHERE daily_plan_id = dp.id
         ORDER BY block_order LIMIT 1) AS first_segment_id
       FROM daily_plans dp
       WHERE dp.plan_date = $1
       LIMIT 1`,
      [workoutDate, targetPref]
    );
    if (!r.rows[0]?.plan_id) return;
    const segmentId = r.rows[0].preferred_segment_id || r.rows[0].first_segment_id;
    await query(
      `UPDATE workouts
       SET daily_plan_id = COALESCE(daily_plan_id, $1),
           plan_segment_id = COALESCE(plan_segment_id, $2),
           updated_at = NOW()
       WHERE id = $3`,
      [r.rows[0].plan_id, segmentId, workoutId]
    );
    if (segmentId) {
      await query(
        `UPDATE plan_segments SET status = 'completed', updated_at = NOW()
         WHERE id = $1 AND status IN ('planned','in_progress')`,
        [segmentId]
      );
    }
  } catch (err) {
    console.error(`[health/link] workout ${workoutId} → plan failed: ${err.message}`);
  }
}

async function upsertWorkouts(workouts) {
  let inserted = 0;
  let updated = 0;
  let merged = 0;
  for (const w of workouts) {
    if (!w.started_at) {
      console.warn(`[health/ingest] workout skipped (no started_at): date=${w.workout_date}`);
      continue;
    }

    // 1) If a workout from another source already covers this start time,
    //    enrich it with Apple's metrics rather than creating a duplicate row.
    const nearby = await query(
      `SELECT id, source FROM workouts
       WHERE started_at IS NOT NULL
         AND ABS(EXTRACT(EPOCH FROM (started_at - $1::timestamptz))) < $2
       ORDER BY (source = 'apple_health') ASC, ABS(EXTRACT(EPOCH FROM (started_at - $1::timestamptz))) ASC
       LIMIT 1`,
      [w.started_at, WORKOUT_MERGE_WINDOW_SEC]
    );
    if (nearby.rows.length && nearby.rows[0].source !== 'apple_health') {
      // Merge: only fill nulls on existing manual fields; always overwrite
      // sensor-derived metrics where Apple is more authoritative.
      // v1.8.14: merge into cal_active / cal_total too — earlier the
      // merge updated only the legacy TEXT fields, leaving INT columns
      // null on rows enriched from Apple data.
      const mergeCalActive = w.active_calories != null
        ? Number(String(w.active_calories).replace(/[^\d.]/g, '')) || null : null;
      const mergeCalTotal = w.total_calories != null
        ? Number(String(w.total_calories).replace(/[^\d.]/g, '')) || null : null;
      try {
        await query(
          `UPDATE workouts SET
             time_duration   = COALESCE($2, time_duration),
             distance        = COALESCE($3, distance),
             elevation_gain  = COALESCE($4, elevation_gain),
             heart_rate_avg  = COALESCE($5, heart_rate_avg),
             heart_rate_max  = COALESCE($6, heart_rate_max),
             pace_avg        = COALESCE($7, pace_avg),
             active_calories = COALESCE($8, active_calories),
             total_calories  = COALESCE($9, total_calories),
             cal_active      = COALESCE($12, cal_active),
             cal_total       = COALESCE($13, cal_total),
             ended_at        = COALESCE($10, ended_at),
             metadata        = metadata || $11::jsonb,
             updated_at      = NOW()
           WHERE id = $1`,
          [nearby.rows[0].id,
           w.time_duration, w.distance, w.elevation_gain,
           w.heart_rate_avg, w.heart_rate_max, w.pace_avg,
           w.active_calories, w.total_calories, w.ended_at,
           JSON.stringify({ apple_health: w.metadata || {} }),
           mergeCalActive, mergeCalTotal]
        );
        merged++;
        await linkWorkoutToPlan(nearby.rows[0].id, w.workout_date, nearby.rows[0].source);
      } catch (err) {
        console.error(`[health/ingest] workout merge failed (${w.started_at}): ${err.message}`);
      }
      continue;
    }

    // 2) No nearby existing row — fall through to insert/upsert against the
    //    apple_health partial unique index.
    const title = `${capitalize(w.workout_type)} – ${w.workout_date}`;
    // v1.8.14: also write the numeric cal_active / cal_total at insert
    // time. The legacy startup-only backfill only ran on init, so new
    // rows had active_calories TEXT populated but cal_active INT null,
    // making downstream queries that read the INT columns return zero.
    const calActiveInt = w.active_calories != null
      ? Number(String(w.active_calories).replace(/[^\d.]/g, '')) || null
      : null;
    const calTotalInt = w.total_calories != null
      ? Number(String(w.total_calories).replace(/[^\d.]/g, '')) || null
      : null;

    const sql = `
      INSERT INTO workouts (
        title, workout_date, workout_type, inferred_workout_type, location,
        time_duration, distance, elevation_gain,
        heart_rate_avg, heart_rate_max, pace_avg,
        active_calories, total_calories,
        cal_active, cal_total,
        started_at, ended_at, source, ai_source, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $12, $13,
        $14, $15,
        $16, $17, $18, $19, $20
      )
      ON CONFLICT (started_at) WHERE source = 'apple_health' AND started_at IS NOT NULL
      DO UPDATE SET
        time_duration = EXCLUDED.time_duration,
        distance = EXCLUDED.distance,
        elevation_gain = EXCLUDED.elevation_gain,
        heart_rate_avg = EXCLUDED.heart_rate_avg,
        heart_rate_max = EXCLUDED.heart_rate_max,
        pace_avg = EXCLUDED.pace_avg,
        active_calories = EXCLUDED.active_calories,
        total_calories = EXCLUDED.total_calories,
        cal_active = EXCLUDED.cal_active,
        cal_total = EXCLUDED.cal_total,
        ended_at = EXCLUDED.ended_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS inserted_now`;

    try {
      const result = await query(sql, [
        title, w.workout_date, w.workout_type, w.inferred_workout_type === true, w.location,
        w.time_duration, w.distance, w.elevation_gain,
        w.heart_rate_avg, w.heart_rate_max, w.pace_avg,
        w.active_calories, w.total_calories,
        calActiveInt, calTotalInt,
        w.started_at, w.ended_at, w.source, w.ai_source,
        JSON.stringify(w.metadata || {}),
      ]);
      if (result.rows[0].inserted_now) inserted++; else updated++;
      await linkWorkoutToPlan(result.rows[0].id, w.workout_date, w.source || 'apple_health');
    } catch (err) {
      console.error(`[health/ingest] workout upsert failed (${w.started_at}): ${err.message}`);
    }
  }
  return { inserted, updated, merged };
}

function capitalize(s) {
  if (!s) return 'Workout';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Body metric upsert (one row per day, partial unique on apple_health) ─

const BODY_METRIC_COLS = ['weight_lb', 'bmi', 'body_fat_pct', 'lean_mass_lb'];

async function upsertBodyMetricsFromHealth(rows) {
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const cols = ['measurement_date', 'source', 'source_type', 'is_manual_entry', ...BODY_METRIC_COLS];
    const values = [row.measurement_date, 'apple_health', 'health_kit', false,
                    ...BODY_METRIC_COLS.map(c => row[c] ?? null)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const setClauses = BODY_METRIC_COLS
      .map(c => `${c} = COALESCE(EXCLUDED.${c}, body_metrics.${c})`)
      .concat(['updated_at = NOW()']);

    const sql = `
      INSERT INTO body_metrics (${cols.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (measurement_date) WHERE source = 'apple_health'
      DO UPDATE SET ${setClauses.join(', ')}
      RETURNING (xmax = 0) AS inserted_now`;

    try {
      const result = await query(sql, values);
      if (result.rows[0].inserted_now) inserted++; else updated++;
    } catch (err) {
      console.error(`[health/ingest] body_metrics upsert failed for ${row.measurement_date}: ${err.message}`);
    }
  }
  return { inserted, updated };
}

// ─── Apply workout-type overrides from format C ─────────────────
// Match by start time within ±5 min.

async function applyWorkoutTypeOverrides(overrides) {
  let updated = 0;
  for (const o of overrides) {
    try {
      const result = await query(
        `UPDATE workouts
         SET workout_type = $1,
             inferred_workout_type = false,
             updated_at = NOW()
         WHERE source = 'apple_health'
           AND started_at IS NOT NULL
           AND ABS(EXTRACT(EPOCH FROM (started_at - $2::timestamptz))) < 300
         RETURNING id`,
        [normalizeWorkoutType(o.type), o.time]
      );
      updated += result.rowCount || 0;
    } catch (err) {
      console.error(`[health/ingest] workout type override failed (${o.time}): ${err.message}`);
    }
  }
  return updated;
}

function normalizeWorkoutType(t) {
  if (!t) return 'other';
  const m = String(t).toLowerCase();
  // v1.8.16: PT/Mobility/Yoga blocks were getting tagged 'strength'
  // because the strength-match (line below) is too permissive — a
  // title like "PT/Mobility Block (Cascade Prophylaxis)" hits no
  // earlier branch and falls through. Add explicit mobility branches
  // BEFORE strength so they win.
  if (m.includes('mobility') || m.includes('stretch') || m.includes('yoga') ||
      m.includes('pt ') || m.startsWith('pt/') || m.includes('pt/') ||
      m.includes('foam') || m.includes('prehab') || m.includes('rehab')) {
    return 'mobility';
  }
  // cooldown/warmup before walk/run so "Cool Down Walk" → cooldown,
  // not walking. Both labels are legitimate but cooldown is the more
  // training-load-meaningful one.
  if (m.includes('cooldown') || m.includes('cool down') || m.includes('cool-down')) return 'cooldown';
  if (m.includes('warmup') || m.includes('warm up') || m.includes('warm-up')) return 'warmup';
  if (m.includes('hik')) return 'hiking';
  if (m.includes('run')) return 'running';
  if (m.includes('walk')) return 'walking';
  if (m.includes('cycl') || m.includes('bik')) return 'cycling';
  if (m.includes('hiit')) return 'hiit';
  if (m.includes('row')) return 'rowing';
  if (m.includes('elliptical')) return 'elliptical';
  // strength last so PT/mobility blocks above win
  if (m.includes('strength') || m.includes('lift') || m.includes('weight')) return 'strength';
  return 'other';
}

// ─── HR zone computation (joins format B HR samples to a workout window) ──

async function computeHrZonesForWorkout(workoutId, hrSamples) {
  const w = (await query('SELECT id, started_at, ended_at FROM workouts WHERE id = $1', [workoutId])).rows[0];
  if (!w || !w.started_at) return null;

  const zones = await getEffectiveZones(w.started_at);
  if (!zones || !zones.z1_max) return null;

  // Filter samples to workout window
  const start = new Date(w.started_at).getTime();
  const end = w.ended_at ? new Date(w.ended_at).getTime() : start + 3 * 3600 * 1000;
  const inWindow = hrSamples.filter(s => {
    const t = new Date(s.t).getTime();
    return t >= start && t <= end;
  });
  if (!inWindow.length) return null;

  // Bucket each sample by zone (assuming samples are roughly 1/sec; weight by gap to next sample)
  const minutesByZone = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (let i = 0; i < inWindow.length; i++) {
    const cur = inWindow[i];
    const next = inWindow[i + 1];
    const gapSec = next ? (new Date(next.t).getTime() - new Date(cur.t).getTime()) / 1000 : 1;
    const dur = Math.min(Math.max(gapSec, 0), 60); // cap gaps at 60s
    const hr = cur.value;
    const zone = hr <= zones.z1_max ? 'z1'
      : hr <= zones.z2_max ? 'z2'
      : hr <= zones.z3_max ? 'z3'
      : hr <= zones.z4_max ? 'z4'
      : 'z5';
    minutesByZone[zone] += dur / 60;
  }
  return {
    zones_used: { z1_max: zones.z1_max, z2_max: zones.z2_max, z3_max: zones.z3_max, z4_max: zones.z4_max, z5_max: zones.z5_max, max_hr: zones.max_hr },
    minutes: {
      z1: round1(minutesByZone.z1),
      z2: round1(minutesByZone.z2),
      z3: round1(minutesByZone.z3),
      z4: round1(minutesByZone.z4),
      z5: round1(minutesByZone.z5),
    },
    sample_count: inWindow.length,
    method: zones.method,
    computed_at: new Date().toISOString(),
  };
}

async function getEffectiveZones(date) {
  const result = await query(
    `SELECT * FROM athlete_zones
     WHERE zone_type = 'heart_rate'
       AND effective_from <= $1
       AND (effective_to IS NULL OR effective_to >= $1)
     ORDER BY effective_from DESC LIMIT 1`,
    [date]
  );
  return result.rows[0] || null;
}

// Extract HR samples from a format B body (returns [{t, value}, ...])
function extractHrSamplesFromB(body) {
  const samples = [];
  for (const metric of body.metrics || []) {
    if (normalizeMetricId(metric.id) !== 'heartrate') continue;
    for (const dp of metric.data_points || []) {
      const t = dp.timestamp || dp.start_date || dp.date;
      const raw = dp.value ?? dp.qty ?? dp.quantity;
      const v = Number(raw);
      if (t && isFinite(v)) samples.push({ t, value: v });
    }
  }
  samples.sort((a, b) => new Date(a.t) - new Date(b.t));
  return samples;
}

// ─── POST /api/health/ingest ────────────────────────────────────

// Parse + upsert a payload (no dedupe check). Used by /ingest and /reparse.
async function processPayload(body) {
  const format = detectFormat(body);
  if (format === 'unknown') return { format, result: null };

  let result;
  if (format === 'A') {
      const { dailyRows, workouts } = parseFormatA(body);
      const dailyStats = await upsertDailyActivity('A', dailyRows);
      const workoutStats = await upsertWorkouts(workouts);
      // HR zones aren't computable here — format A has no HR samples.
      // Format B ingest fills hr_zones for these workouts in a later run.
      result = {
        format: 'A',
        date_range: rangeFromDailyRows(dailyRows),
        daily_inserted: dailyStats.inserted,
        daily_updated: dailyStats.updated,
        workouts_inserted: workoutStats.inserted,
        workouts_updated: workoutStats.updated,
      };
    } else if (format === 'B') {
      const { dailyRows, bodyMetricRows, mappedMetrics, skippedMetrics } = parseFormatB(body);
      const dailyStats = await upsertDailyActivity('B', dailyRows);
      const bodyStats = bodyMetricRows.length
        ? await upsertBodyMetricsFromHealth(bodyMetricRows)
        : { inserted: 0, updated: 0 };
      // Auto-clean any apple_health body_metric rows that duplicate a RENPHO/
      // manual entry on the same date.
      const bodyDupes = bodyMetricRows.length
        ? await mergeBodyMetricDuplicates({ dryRun: false })
        : { merged: 0 };

      // If we have HR samples, recompute zones for any workouts in the window
      const hrSamples = extractHrSamplesFromB(body);
      let zonesComputed = 0;
      if (hrSamples.length) {
        const startD = body.date_range.start;
        const endD = body.date_range.end;
        const windowWorkouts = await query(
          `SELECT id FROM workouts WHERE source = 'apple_health'
            AND started_at >= $1::date AND started_at < ($2::date + INTERVAL '1 day')`,
          [startD, endD]
        );
        for (const w of windowWorkouts.rows) {
          const zones = await computeHrZonesForWorkout(w.id, hrSamples);
          if (zones) {
            await query('UPDATE workouts SET hr_zones = $1::jsonb WHERE id = $2', [JSON.stringify(zones), w.id]);
            zonesComputed++;
          }
        }
      }

      result = {
        format: 'B',
        date_range: { start: body.date_range.start, end: body.date_range.end },
        daily_inserted: dailyStats.inserted,
        daily_updated: dailyStats.updated,
        body_metrics_inserted: bodyStats.inserted,
        body_metrics_updated: bodyStats.updated,
        body_metrics_dupes_merged: bodyDupes.merged,
        mapped_metrics: mappedMetrics,
        skipped_metrics: skippedMetrics,
        zones_computed: zonesComputed,
      };
    } else if (format === 'C') {
      const { dailyRows, workoutTypeOverrides } = parseFormatC(body);
      const dailyStats = await upsertDailyActivity('C', dailyRows);
      const overridesApplied = await applyWorkoutTypeOverrides(workoutTypeOverrides);

      result = {
        format: 'C',
        date_range: { start: body.metadata?.dateRange?.start, end: body.metadata?.dateRange?.end },
        days_processed: dailyRows.length,
        daily_inserted: dailyStats.inserted,
        daily_updated: dailyStats.updated,
        workout_types_corrected: overridesApplied,
      };
    } else if (format === 'D') {
      const { dailyRows, bodyMetricRows, mappedMetrics, skippedMetrics } = parseFormatD(body);
      const dailyStats = await upsertDailyActivity('D', dailyRows);
      const bodyStats = bodyMetricRows.length
        ? await upsertBodyMetricsFromHealth(bodyMetricRows)
        : { inserted: 0, updated: 0 };
      const bodyDupes = bodyMetricRows.length
        ? await mergeBodyMetricDuplicates({ dryRun: false })
        : { merged: 0 };

      const workouts = parseFormatDWorkouts(body);
      const workoutStats = workouts.length
        ? await upsertWorkouts(workouts)
        : { inserted: 0, updated: 0, merged: 0 };
      // After inserts, run auto-dedupe so any apple_health rows that overlap
      // an existing manual workout get merged in rather than left as duplicates.
      const dupesMerged = workouts.length ? await dedupeAppleWorkouts() : 0;

      result = {
        format: 'D',
        date_range: rangeFromDailyRows(dailyRows),
        daily_inserted: dailyStats.inserted,
        daily_updated: dailyStats.updated,
        body_metrics_inserted: bodyStats.inserted,
        body_metrics_updated: bodyStats.updated,
        body_metrics_dupes_merged: bodyDupes.merged,
        workouts_inserted: workoutStats.inserted,
        workouts_updated: workoutStats.updated,
        workouts_merged: workoutStats.merged + dupesMerged,
        mapped_metrics: mappedMetrics,
        skipped_metrics: skippedMetrics,
      };
  }

  return { format, result };
}

// Full ingest pipeline: dedup, parse, upsert, log. Returns the same shape
// as POST /ingest. Used by the HTTP route and the Dropbox poller.
async function ingestPayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'payload must be a JSON object' };
  }
  const hash = fileHash(body);
  const dup = await query(
    'SELECT id, source_format, ingested_at, parse_result FROM raw_health_imports WHERE file_hash = $1',
    [hash]
  );
  if (dup.rows.length) {
    return { ok: true, status: 200, body: { duplicate: true, file_hash: hash, ...dup.rows[0] } };
  }

  const { format, result } = await processPayload(body);
  if (format === 'unknown') {
    await logImport(hash, 'unknown', body, null, { error: 'unknown format' });
    return { ok: false, status: 400, error: 'unknown payload format', file_hash: hash };
  }

  if (format === 'A') {
    const merged = await dedupeAppleWorkouts();
    if (merged) result.duplicates_merged = merged;
  }

  await logImport(hash, format, body, result, null);
  await logActivity('create', 'health_import', hash.slice(0, 12), 'apple_health',
    `Ingested ${format}: ${JSON.stringify(result)}`);

  return { ok: true, status: 200, body: { duplicate: false, file_hash: hash, ...result } };
}

router.post('/ingest', async (req, res) => {
  try {
    const out = await ingestPayload(req.body);
    if (!out.ok) return res.status(out.status).json({ error: out.error, file_hash: out.file_hash });
    res.json(out.body);
  } catch (err) {
    console.error(`[health/ingest] failed: ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/health/reparse ─────────────────────────────────
// Re-runs the current parser on stored payloads and overwrites parse_result.
// Body: { file_hash } to reparse one; omit to reparse all imports.
// Idempotent — all upserts use ON CONFLICT DO UPDATE.

router.post('/reparse', async (req, res) => {
  try {
    const { file_hash } = req.body || {};
    const params = file_hash ? [file_hash] : [];
    const where = file_hash ? 'WHERE file_hash = $1' : '';
    const stored = await query(
      `SELECT file_hash, payload FROM raw_health_imports ${where} ORDER BY ingested_at ASC`,
      params
    );
    if (!stored.rows.length) {
      return res.status(404).json({ error: file_hash ? 'No import with that hash' : 'No imports stored' });
    }

    const summary = [];
    for (const row of stored.rows) {
      try {
        const { format, result } = await processPayload(row.payload);
        await query(
          `UPDATE raw_health_imports SET source_format = $1, parse_result = $2::jsonb WHERE file_hash = $3`,
          [format, JSON.stringify(result || { error: 'unknown format' }), row.file_hash]
        );
        summary.push({ file_hash: row.file_hash, format, ...(result || {}) });
      } catch (err) {
        summary.push({ file_hash: row.file_hash, error: err.message });
      }
    }
    const duplicatesMerged = await dedupeAppleWorkouts();
    // Auto-recompute TSS so /trends.training stays current without the
    // user having to remember to POST /insights/recompute-tss.
    const tssUpdated = await recomputeMissingTss().catch(() => 0);
    res.json({ reparsed: summary.length, duplicates_merged: duplicatesMerged, tss_recomputed: tssUpdated, results: summary });
  } catch (err) {
    console.error(`[health/reparse] failed: ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

function rangeFromDailyRows(rows) {
  if (!rows.length) return null;
  const dates = rows.map(r => r.activity_date).sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

async function logImport(hash, format, body, parseResult, errResult) {
  try {
    const dateRange = format === 'A' ? rangeFromDailyRowsBody(body)
      : format === 'B' ? body.date_range
      : format === 'C' ? body.metadata?.dateRange
      : format === 'D' ? parseResult?.date_range
      : null;
    await query(
      `INSERT INTO raw_health_imports (source_format, filename, file_hash, file_bytes, date_range_start, date_range_end, payload, parse_result)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT (file_hash) DO NOTHING`,
      [format, null, hash, JSON.stringify(body).length,
       dateRange?.start || null, dateRange?.end || null,
       JSON.stringify(body), JSON.stringify(parseResult || errResult)]
    );
  } catch (err) {
    console.error(`[health/ingest] raw_health_imports insert failed: ${err.message}`);
  }
}

function rangeFromDailyRowsBody(body) {
  const days = body.activity?.daily || [];
  if (!days.length) return null;
  const dates = days.map(d => d.date).sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

// ─── POST /api/health/merge-duplicate-workouts ────────────────
// Comprehensive workout dedup. Body: { dry_run: true } previews; omit to apply.
router.post('/merge-duplicate-workouts', async (req, res) => {
  try {
    const dryRun = req.body?.dry_run === true;
    const summary = await mergeAllWorkoutDuplicates({ dryRun });
    res.json({ dry_run: dryRun, ...summary });
  } catch (err) {
    console.error(`[health/merge-duplicate-workouts] failed: ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/health/merge-duplicate-body-metrics ────────────
// Same root cause as workouts: RENPHO writes to Apple Health AND a separate
// manual import path; both rows end up in body_metrics for the same date,
// e.g. 188.80lb renpho + 188.82lb apple_health on 2026-04-25. Survivor =
// the non-apple_health row (RENPHO/manual is the original scale entry; the
// apple_health row is just an echo of the same reading, often slightly
// rounded by HealthKit). Sensor data merged via COALESCE; loser deleted.
router.post('/merge-duplicate-body-metrics', async (req, res) => {
  try {
    const dryRun = req.body?.dry_run === true;
    const summary = await mergeBodyMetricDuplicates({ dryRun });
    res.json({ dry_run: dryRun, ...summary });
  } catch (err) {
    console.error(`[health/merge-duplicate-body-metrics] failed: ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/imports — audit log ──────────────────────

router.get('/imports', async (req, res) => {
  try {
    const { limit = 50, format } = req.query;
    const params = [];
    const where = [];
    let i = 1;
    if (format) { where.push(`source_format = $${i++}`); params.push(format); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit));
    const result = await query(
      `SELECT id, source_format, file_hash, file_bytes, date_range_start, date_range_end,
              parse_result, ingested_at
       FROM raw_health_imports ${whereClause}
       ORDER BY ingested_at DESC LIMIT $${i}`, params
    );
    res.json({ count: result.rows.length, imports: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/daily — daily activity rows ───────────────

router.get('/daily', async (req, res) => {
  try {
    const { since, before, limit = 90 } = req.query;
    const params = [];
    const where = [];
    let i = 1;
    if (since) { where.push(`activity_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`activity_date < $${i++}`); params.push(before); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit));
    const result = await query(
      `SELECT * FROM daily_activity ${whereClause} ORDER BY activity_date DESC LIMIT $${i}`, params
    );
    res.json({ count: result.rows.length, daily: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v1.8.15: dedupe by time-window OVERLAP (not just start-time proximity).
//
// Apple Watch auto-detects N workouts during one physical session
// (warmup walk + indoor run + traditional strength). Hevy logs the
// session as 1 row. Old logic only merged when start times were
// within 15 min — that caught the 'strength' segment of the Apple
// trio but left the warmup walk + run as separate rows, so summing
// their active_calories double-counted what Apple already tallied
// in its daily total.
//
// New rule (per Coach spec):
//   For each non-apple_health workout (Hevy / manual):
//     Find all apple_health rows whose [started_at, ended_at] window
//     overlaps the parent's window by >50% of the apple row's duration.
//     Merge sensor data (HR avg/max from max value, calories SUMMED
//     across the Apple rows since they're each measuring different
//     intervals). Soft-delete the merged Apple rows.
//
// Key change: we SUM Apple calories across overlapping rows (not max)
// because each Apple auto-detected workout covers a different time
// slice. The sum approximates what Apple's daily active_energy attributes
// to that session.
async function dedupeAppleWorkouts() {
  // For each non-apple parent, collect overlapping apple children.
  const parents = await query(
    `SELECT id, started_at, ended_at, source, daily_plan_id, plan_segment_id
     FROM workouts
     WHERE source <> 'apple_health'
       AND started_at IS NOT NULL
       AND ended_at IS NOT NULL
       AND deleted_at IS NULL
     ORDER BY started_at DESC LIMIT 500`
  );

  let merged = 0;
  for (const parent of parents.rows) {
    const parentStart = new Date(parent.started_at).getTime();
    const parentEnd = new Date(parent.ended_at).getTime();
    if (parentEnd <= parentStart) continue;

    // Pull every apple row that *might* overlap (window padded by 15 min
    // on each side to catch warmup/cooldown blocks Apple split off).
    const candidates = await query(
      `SELECT id, started_at, ended_at, distance, heart_rate_avg, heart_rate_max,
              elevation_gain, pace_avg, active_calories, total_calories,
              cal_active, cal_total, time_duration, metadata
       FROM workouts
       WHERE source = 'apple_health'
         AND started_at IS NOT NULL
         AND ended_at IS NOT NULL
         AND deleted_at IS NULL
         AND started_at >= ($1::timestamptz - INTERVAL '15 min')
         AND ended_at   <= ($2::timestamptz + INTERVAL '15 min')`,
      [parent.started_at, parent.ended_at]
    );

    const overlapping = [];
    for (const c of candidates.rows) {
      const cStart = new Date(c.started_at).getTime();
      const cEnd = new Date(c.ended_at).getTime();
      if (cEnd <= cStart) continue;
      const cDur = cEnd - cStart;
      const overlapMs = Math.max(0, Math.min(cEnd, parentEnd) - Math.max(cStart, parentStart));
      const overlapFrac = overlapMs / cDur;
      if (overlapFrac > 0.5) overlapping.push(c);
    }
    if (!overlapping.length) continue;

    // Merge: sum calories across overlapping apple rows (each covers
    // a different time slice). Use max for HR (avg/max are scalars
    // describing the whole session, take the most representative).
    const sumCalActive = overlapping.reduce((s, r) => s + (Number(r.cal_active) || Number(String(r.active_calories || '').replace(/[^\d.]/g, '')) || 0), 0);
    const sumCalTotal = overlapping.reduce((s, r) => s + (Number(r.cal_total) || Number(String(r.total_calories || '').replace(/[^\d.]/g, '')) || 0), 0);
    const maxHrAvg = Math.max(...overlapping.map(r => Number(String(r.heart_rate_avg || '').replace(/[^\d.]/g, '')) || 0));
    const maxHrMax = Math.max(...overlapping.map(r => Number(String(r.heart_rate_max || '').replace(/[^\d.]/g, '')) || 0));

    try {
      await query(
        `UPDATE workouts SET
           heart_rate_avg  = COALESCE($2, heart_rate_avg),
           heart_rate_max  = COALESCE($3, heart_rate_max),
           active_calories = COALESCE($4, active_calories),
           total_calories  = COALESCE($5, total_calories),
           cal_active      = COALESCE($6, cal_active),
           cal_total       = COALESCE($7, cal_total),
           metadata        = metadata || $8::jsonb,
           updated_at      = NOW()
         WHERE id = $1`,
        [parent.id,
         maxHrAvg > 0 ? String(maxHrAvg) : null,
         maxHrMax > 0 ? String(maxHrMax) : null,
         sumCalActive > 0 ? String(sumCalActive) : null,
         sumCalTotal > 0 ? String(sumCalTotal) : null,
         sumCalActive > 0 ? sumCalActive : null,
         sumCalTotal > 0 ? sumCalTotal : null,
         JSON.stringify({ apple_health: { merged_from: overlapping.map(r => r.id), overlap_count: overlapping.length } })]
      );
      // Soft-delete the merged apple rows so they don't get summed
      // again by anything else (recovery score, calorie totals).
      await query(
        `UPDATE workouts SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1::uuid[]) AND source = 'apple_health'`,
        [overlapping.map(r => r.id)]
      );
      merged += overlapping.length;
    } catch (err) {
      console.error(`[dedupeAppleWorkouts] failed for parent=${parent.id} children=${overlapping.length}: ${err.message}`);
    }
  }
  return merged;
}

// ─── Comprehensive workout dedup ────────────────────────────────
// Walks all workouts ordered by started_at, groups any whose start times are
// within WORKOUT_DEDUP_WINDOW_SEC of each other, picks a single survivor per
// group (manual > apple_health, more sensor data > less, more recent update >
// older), merges sensor data from losers into survivor, and deletes losers.
//
// Catches three patterns at once:
//   - Apple Health row duplicating a manually-logged workout
//   - Format A and Format D both creating apple_health rows with slightly
//     different started_at timestamps for the same activity
//   - Format D sending the same workout in successive 15-min sync cycles

const WORKOUT_DEDUP_WINDOW_SEC = 1800; // 30 min — slightly wider than the
                                       // ingest-time merge window for cleanup

// Parse 'h:mm:ss' or 'mm:ss' workout durations to seconds. Used by Rule D
// (Apple Watch fragment cleanup) to identify <5min fragments.
function durationToSeconds(s) {
  if (!s) return 0;
  const m = String(s).match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, h, mm, ss] = m;
  return (Number(h) || 0) * 3600 + Number(mm) * 60 + Number(ss);
}

const SENSOR_FIELDS = [
  'time_duration', 'distance', 'elevation_gain',
  'heart_rate_avg', 'heart_rate_max', 'pace_avg',
  'active_calories', 'total_calories', 'ended_at',
  'splits', 'cadence_avg',
];

function scoreWorkout(w) {
  let score = 0;
  for (const f of SENSOR_FIELDS) if (w[f] != null) score++;
  return score;
}

function pickSurvivor(group) {
  // 1. Manual entries always win — they have the user's title/notes/effort
  const manuals = group.filter(w => w.source !== 'apple_health');
  const candidates = manuals.length ? manuals : group.slice();
  // 2. Among remaining, prefer the one with most sensor fields populated
  // 3. Tiebreak by most recent updated_at (newer ingests usually have HAE's
  //    richer payload)
  candidates.sort((a, b) => {
    const sd = scoreWorkout(b) - scoreWorkout(a);
    if (sd !== 0) return sd;
    const tb = new Date(b.updated_at || b.created_at || 0).getTime();
    const ta = new Date(a.updated_at || a.created_at || 0).getTime();
    return tb - ta;
  });
  return candidates[0];
}

async function mergeAllWorkoutDuplicates({ windowSec = WORKOUT_DEDUP_WINDOW_SEC, dryRun = false } = {}) {
  const all = await query(
    `SELECT * FROM workouts WHERE started_at IS NOT NULL
     ORDER BY workout_date, started_at`
  );

  // Pass 1: Group consecutive workouts whose started_at delta is within window
  const groups = [];
  let current = [];
  let lastTs = null;
  let lastDate = null;
  for (const w of all.rows) {
    const t = new Date(w.started_at).getTime();
    if (current.length && w.workout_date === lastDate && Math.abs(t - lastTs) < windowSec * 1000) {
      current.push(w);
    } else {
      if (current.length > 1) groups.push(current);
      current = [w];
    }
    lastTs = t;
    lastDate = w.workout_date;
  }
  if (current.length > 1) groups.push(current);

  // Pass 2 (Rule D — provenance: docs/coaching-rules.md): Apple Watch fragment
  // cleanup. Apple sometimes splits a single session into many short
  // apple_health rows scattered across the day (e.g. one workout becomes 6
  // entries: 3:31, 3:27, 3:04, 45:00, 12:34, 36:35). Pass 1's started_at
  // window catches close pairs but misses fragments separated by hours.
  // Rule: on any date with multiple apple_health rows where AT LEAST ONE has
  // duration < 5 min, treat the whole apple_health cluster on that date as
  // fragments of a single session. Survivor = longest-duration row.
  const byDate = new Map();
  for (const w of all.rows) {
    if (w.source !== 'apple_health') continue;
    if (!byDate.has(w.workout_date)) byDate.set(w.workout_date, []);
    byDate.get(w.workout_date).push(w);
  }
  const alreadyGrouped = new Set();
  for (const g of groups) for (const w of g) alreadyGrouped.add(w.id);
  for (const [date, dayWorkouts] of byDate) {
    if (dayWorkouts.length < 2) continue;
    // Skip if all members are already in a started_at-window group together
    const remaining = dayWorkouts.filter(w => !alreadyGrouped.has(w.id));
    const seedFragments = remaining.length >= 2
      ? remaining.some(w => durationToSeconds(w.time_duration) > 0 && durationToSeconds(w.time_duration) < 300)
      : false;
    if (!seedFragments) continue;
    groups.push(remaining);
    for (const w of remaining) alreadyGrouped.add(w.id);
  }

  const summary = { groups: groups.length, merged: 0, deleted: 0, pairs: [] };

  for (const group of groups) {
    const survivor = pickSurvivor(group);
    const losers = group.filter(w => w.id !== survivor.id);

    summary.pairs.push({
      survivor: { id: survivor.id, source: survivor.source, title: survivor.title, started_at: survivor.started_at },
      losers: losers.map(l => ({ id: l.id, source: l.source, title: l.title, started_at: l.started_at })),
    });

    if (dryRun) continue;

    for (const loser of losers) {
      try {
        // Build COALESCE update for sensor fields where survivor is null
        const updates = {};
        for (const f of SENSOR_FIELDS) {
          if (survivor[f] == null && loser[f] != null) updates[f] = loser[f];
        }
        // Adopt loser's explicit type if survivor's type is generic/inferred
        const adoptType = survivor.inferred_workout_type === true
          && loser.inferred_workout_type === false
          && loser.workout_type;
        if (adoptType) {
          updates.workout_type = loser.workout_type;
          updates.inferred_workout_type = false;
        }

        const setClauses = [];
        const params = [survivor.id];
        let i = 2;
        for (const [k, v] of Object.entries(updates)) {
          setClauses.push(`${k} = $${i++}`);
          params.push(v);
        }
        // Always merge metadata regardless of other field updates
        setClauses.push(`metadata = metadata || $${i++}::jsonb`);
        params.push(JSON.stringify({ merged_from: { id: loser.id, source: loser.source, metadata: loser.metadata || {} } }));
        setClauses.push(`updated_at = NOW()`);

        if (setClauses.length) {
          await query(
            `UPDATE workouts SET ${setClauses.join(', ')} WHERE id = $1`,
            params
          );
        }
        await query(`DELETE FROM workouts WHERE id = $1`, [loser.id]);
        summary.merged++;
        summary.deleted++;
      } catch (err) {
        console.error(`[mergeAllWorkoutDuplicates] failed survivor=${survivor.id} loser=${loser.id}: ${err.message}`);
      }
    }
  }

  return summary;
}

// ─── Body-metric duplicate cleanup ─────────────────────────────
// Group body_metrics rows by measurement_date. When >1 row for a date:
//   1. Survivor priority: non-apple_health row (RENPHO/manual scale entry).
//      The user's actual scale reading is the source of truth; HealthKit's
//      copy is usually rounded by 0.02-0.05 lb and lacks all the body-comp
//      fields beyond weight + body_fat_pct.
//   2. Tiebreak by most recent updated_at.
// Loser data is folded into survivor via COALESCE (e.g. apple's BMI fills
// survivor's null BMI), then loser row is deleted. Survivor's metadata
// (raw_payload) gets a `merged_from` annotation.

const BODY_MERGE_FIELDS = [
  'weight_lb', 'bmi', 'body_fat_pct', 'lean_mass_lb',
  'skeletal_muscle_pct', 'fat_free_mass_lb', 'subcutaneous_fat_pct',
  'visceral_fat', 'body_water_pct', 'muscle_mass_lb', 'bone_mass_lb',
  'protein_pct', 'bmr_kcal', 'metabolic_age', 'measurement_time',
  'measurement_context', 'vendor_user_mode', 'notes',
];

function pickBodySurvivor(group) {
  const nonApple = group.filter(r => r.source !== 'apple_health');
  const candidates = nonApple.length ? nonApple : group.slice();
  candidates.sort((a, b) => {
    const tb = new Date(b.updated_at || b.created_at || 0).getTime();
    const ta = new Date(a.updated_at || a.created_at || 0).getTime();
    return tb - ta;
  });
  return candidates[0];
}

async function mergeBodyMetricDuplicates({ dryRun = false } = {}) {
  const all = await query(
    `SELECT * FROM body_metrics ORDER BY measurement_date, source`
  );

  const byDate = new Map();
  for (const r of all.rows) {
    const key = String(r.measurement_date);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }

  const summary = { groups: 0, merged: 0, deleted: 0, pairs: [] };

  for (const [date, group] of byDate) {
    if (group.length < 2) continue;
    summary.groups++;
    const survivor = pickBodySurvivor(group);
    const losers = group.filter(r => r.id !== survivor.id);

    summary.pairs.push({
      date,
      survivor: { id: survivor.id, source: survivor.source, weight_lb: survivor.weight_lb },
      losers: losers.map(l => ({ id: l.id, source: l.source, weight_lb: l.weight_lb })),
    });

    if (dryRun) continue;

    for (const loser of losers) {
      try {
        const updates = {};
        for (const f of BODY_MERGE_FIELDS) {
          if (survivor[f] == null && loser[f] != null) updates[f] = loser[f];
        }

        const setClauses = [];
        const params = [survivor.id];
        let i = 2;
        for (const [k, v] of Object.entries(updates)) {
          setClauses.push(`${k} = $${i++}`);
          params.push(v);
        }
        setClauses.push(`raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $${i++}::jsonb`);
        params.push(JSON.stringify({
          merged_from: { id: loser.id, source: loser.source, raw_payload: loser.raw_payload || null },
        }));
        setClauses.push(`updated_at = NOW()`);

        await query(
          `UPDATE body_metrics SET ${setClauses.join(', ')} WHERE id = $1`,
          params
        );
        await query(`DELETE FROM body_metrics WHERE id = $1`, [loser.id]);
        summary.merged++;
        summary.deleted++;
      } catch (err) {
        console.error(`[mergeBodyMetricDuplicates] failed survivor=${survivor.id} loser=${loser.id}: ${err.message}`);
      }
    }
  }

  return summary;
}

// ─── GET /api/health/diagnose-day?date=YYYY-MM-DD ─────────────
// v1.8.9: surface what's actually stored for a given date so we can
// debug why "OUT" on the Macros tab is suspiciously low. Returns:
//   - daily_activity row (active_energy_kcal, basal_energy_kcal, etc.)
//   - raw_health_imports rows covering that date, with their top-level
//     payload keys + which energy-related field names the payload
//     actually contains
// Use the "Reparse Health Imports → Reparse All" button after a parser
// fix; if basal_energy_kcal stays null after that, the field simply
// isn't in HAE's export.
router.get('/diagnose-day', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query param required, format YYYY-MM-DD' });
    }
    const da = await query(
      `SELECT activity_date, active_energy_kcal, basal_energy_kcal,
              steps, distance_mi, exercise_minutes, flights_climbed,
              sources, updated_at
       FROM daily_activity WHERE activity_date = $1`,
      [date]
    );
    const imports = await query(
      `SELECT id, source_format, ingested_at, file_hash, file_bytes,
              date_range_start, date_range_end,
              parse_result,
              jsonb_object_keys(payload::jsonb) AS payload_top_key
       FROM raw_health_imports
       WHERE date_range_start <= $1::date AND date_range_end >= $1::date
       ORDER BY ingested_at DESC LIMIT 5`,
      [date]
    );

    // For each import, scan the payload for any key containing
    // "basal" or "energy" or "calorie" (case-insensitive) so we can
    // see what HAE actually exported.
    const importDigest = [];
    const seen = new Set();
    for (const r of imports.rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const payloadR = await query(`SELECT payload FROM raw_health_imports WHERE id = $1`, [r.id]);
      const payload = payloadR.rows[0]?.payload || {};
      const energyFields = [];
      function scan(obj, path = '$') {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          if (obj.length && typeof obj[0] === 'object') scan(obj[0], `${path}[0]`);
          return;
        }
        for (const k of Object.keys(obj)) {
          if (/basal|active|energy|calorie|kcal/i.test(k)) {
            const v = obj[k];
            energyFields.push({ path: `${path}.${k}`, type: typeof v, sample: typeof v === 'object' ? '<object>' : v });
          }
          if (typeof obj[k] === 'object') scan(obj[k], `${path}.${k}`);
        }
      }
      scan(payload);
      importDigest.push({
        import_id: r.id,
        source_format: r.source_format,
        ingested_at: r.ingested_at,
        file_bytes: r.file_bytes,
        date_range: [r.date_range_start, r.date_range_end],
        top_keys: Array.from(new Set(imports.rows.filter(x => x.id === r.id).map(x => x.payload_top_key))),
        parse_result_summary: r.parse_result ? Object.keys(r.parse_result).slice(0, 10) : null,
        energy_fields_in_payload: energyFields.slice(0, 30),
      });
    }

    res.json({
      date,
      daily_activity_row: da.rows[0] || null,
      diagnosis: !da.rows.length
        ? 'no daily_activity row for this date — HAE has never written one'
        : da.rows[0].active_energy_kcal == null && da.rows[0].basal_energy_kcal == null
        ? 'both active and basal are null — HAE payload likely missing energy fields entirely'
        : da.rows[0].basal_energy_kcal == null
        ? 'basal_energy_kcal is null — check energy_fields_in_payload below to see what HAE actually exported. If no basal-related field is present, enable "Basal Energy Burned" in HAE app settings.'
        : 'both fields populated; if OUT looks low, day is incomplete (HAE syncs throughout the day).',
      raw_imports: importDigest,
    });
  } catch (err) {
    console.error(`[health/diagnose-day] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/diag/workouts?days=14 ────────────────────
// v1.8.17: paste-back diagnostic. Returns all workout rows in the
// window with key fields + detected anomalies so the user can copy
// the JSON and share with Coach / Claude Code for analysis. Read-only.
router.get('/diag/workouts', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(Number(req.query.days) || 14, 90));
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const { rows } = await query(
      `SELECT id, workout_date, workout_type, source, ai_source,
              title, time_duration, duration_minutes,
              distance, distance_value,
              elevation_gain, elevation_gain_ft,
              heart_rate_avg, heart_rate_max, hr_avg, hr_max,
              active_calories, total_calories, cal_active, cal_total,
              effort, started_at, ended_at, deleted_at,
              daily_plan_id, plan_segment_id, hevy_id,
              metadata->>'hae_id' AS hae_id,
              jsonb_array_length(COALESCE(metadata->'heartRateData', '[]'::jsonb)) AS hr_samples_count,
              created_at, updated_at
       FROM workouts
       WHERE workout_date >= $1
       ORDER BY workout_date DESC, started_at DESC NULLS LAST`,
      [since]
    );

    // Anomaly detection — flag suspicious rows so the user/Coach can
    // focus on what's broken.
    const anomalies = [];
    for (const r of rows) {
      const flags = [];
      // Seconds-as-minutes: stored duration_minutes within ±2 of raw
      // start-end seconds suggests the bug is still there.
      if (r.started_at && r.ended_at && r.duration_minutes != null) {
        const trueSec = (new Date(r.ended_at) - new Date(r.started_at)) / 1000;
        const trueMin = trueSec / 60;
        if (Math.abs(r.duration_minutes - trueSec) <= 2 && trueSec > 60) {
          flags.push(`duration_minutes (${r.duration_minutes}) matches seconds, true=${Math.round(trueMin)}min`);
        }
      }
      // String "nan" in HR text columns
      if (typeof r.heart_rate_avg === 'string' && /^(nan|null|none)$/i.test(r.heart_rate_avg.trim())) flags.push(`heart_rate_avg = "${r.heart_rate_avg}"`);
      if (typeof r.heart_rate_max === 'string' && /^(nan|null|none)$/i.test(r.heart_rate_max.trim())) flags.push(`heart_rate_max = "${r.heart_rate_max}"`);
      // Missing hae_id but source='apple_health' (Path B)
      if (r.source === 'apple_health' && !r.hae_id) flags.push('source=apple_health but no hae_id (Path B legacy)');
      // No HR samples on a long workout
      if (r.duration_minutes >= 20 && r.hr_samples_count === 0 && r.source === 'apple_health') flags.push('no HR samples in metadata');
      if (flags.length) anomalies.push({ id: r.id, date: r.workout_date, source: r.source, flags });
    }

    // Group by date for quick scan
    const byDate = {};
    for (const r of rows) {
      const k = String(r.workout_date).slice(0, 10);
      if (!byDate[k]) byDate[k] = [];
      byDate[k].push({
        id: r.id, source: r.source, hae_id: r.hae_id, hevy_id: r.hevy_id,
        type: r.workout_type, title: r.title,
        started: r.started_at, ended: r.ended_at,
        time_duration: r.time_duration, duration_min: r.duration_minutes,
        distance: r.distance, hr_avg: r.heart_rate_avg, hr_max: r.heart_rate_max,
        cal_active: r.active_calories, cal_total: r.total_calories,
        plan_segment_id: r.plan_segment_id, hr_samples: r.hr_samples_count,
        deleted_at: r.deleted_at,
      });
    }

    res.json({
      window_days: days,
      since,
      generated_at: new Date().toISOString(),
      total_rows: rows.length,
      total_anomalies: anomalies.length,
      anomalies,
      workouts_by_date: byDate,
    });
  } catch (err) {
    console.error(`[health/diag/workouts] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/diag/full-day?date=YYYY-MM-DD ──────────────
// v1.8.17: comprehensive cross-table diagnostic for one date. Pulls
// workouts, daily_activity, meals, body_metrics, daily_plans +
// plan_segments, coaching_sessions, daily_context. Designed for
// paste-back analysis when the data doesn't match expectations.
router.get('/diag/full-day', async (req, res) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date YYYY-MM-DD required' });

    const [workouts, daily, meals, bmets, plan, coach, ctx, raw] = await Promise.all([
      query(`SELECT id, workout_type, source, title, time_duration, duration_minutes,
                    distance, heart_rate_avg, heart_rate_max, active_calories, total_calories,
                    effort, started_at, ended_at, deleted_at, daily_plan_id, plan_segment_id,
                    hevy_id, metadata->>'hae_id' AS hae_id,
                    jsonb_array_length(COALESCE(metadata->'heartRateData', '[]'::jsonb)) AS hr_samples_count
             FROM workouts WHERE workout_date = $1 ORDER BY started_at NULLS LAST, created_at`, [date]),
      query(`SELECT activity_date, steps, distance_mi, exercise_minutes, flights_climbed,
                    active_energy_kcal, basal_energy_kcal, resting_hr_bpm, walking_hr_avg_bpm,
                    hrv_sdnn_ms, sleep_total_min, sleep_deep_min, sleep_rem_min,
                    workout_count, sources, updated_at
             FROM daily_activity WHERE activity_date = $1`, [date]),
      query(`SELECT id, meal_type, meal_time, calories, protein_g, carbs_g, fat_g, source, notes
             FROM meals WHERE meal_date = $1 ORDER BY meal_time NULLS LAST`, [date]),
      query(`SELECT id, measurement_time, source, weight_lb, body_fat_pct, lean_mass_lb, bmi, notes
             FROM body_metrics WHERE measurement_date = $1 ORDER BY measurement_time NULLS LAST`, [date]),
      query(`SELECT id, plan_date, status, title, workout_type, intent_type, target_effort,
                    target_calories, target_protein_g, target_carbs_g, target_fat_g,
                    workout_notes, completion_notes, rationale, ai_source, updated_at
             FROM daily_plans WHERE plan_date = $1`, [date]),
      query(`SELECT id, session_date, session_type, title, summary, ai_source, created_at
             FROM coaching_sessions WHERE session_date = $1 ORDER BY created_at`, [date]),
      query(`SELECT date, mood, motivation, soreness_overall, soreness_areas,
                    life_stress, illness_flag, hydration_liters, day_type, notes, updated_at
             FROM daily_context WHERE date = $1`, [date]),
      query(`SELECT id, source_format, ingested_at, file_bytes, parse_result
             FROM raw_health_imports
             WHERE date_range_start <= $1::date AND date_range_end >= $1::date
             ORDER BY ingested_at DESC LIMIT 5`, [date]),
    ]);

    let segments = { rows: [] };
    if (plan.rows[0]?.id) {
      segments = await query(
        `SELECT id, block_order, block_label, title_suffix, logging_target,
                planned_exercises, target_duration_min, target_effort,
                hevy_routine_id, status, notes
         FROM plan_segments WHERE daily_plan_id = $1 ORDER BY block_order`,
        [plan.rows[0].id]
      );
    }

    // Anomaly detection
    const anomalies = [];
    for (const w of workouts.rows) {
      const flags = [];
      if (w.started_at && w.ended_at && w.duration_minutes != null) {
        const trueSec = (new Date(w.ended_at) - new Date(w.started_at)) / 1000;
        if (Math.abs(w.duration_minutes - trueSec) <= 2 && trueSec > 60) {
          flags.push(`duration_minutes=${w.duration_minutes} matches seconds (true=${Math.round(trueSec/60)}min)`);
        }
      }
      if (typeof w.heart_rate_avg === 'string' && /^(nan|null|none)$/i.test(w.heart_rate_avg.trim())) flags.push(`hr_avg="${w.heart_rate_avg}"`);
      if (w.source === 'apple_health' && !w.hae_id) flags.push('no hae_id (Path B legacy)');
      if (w.duration_minutes >= 20 && w.hr_samples_count === 0 && w.source === 'apple_health') flags.push('no HR samples in metadata');
      if (flags.length) anomalies.push({ id: w.id, type: w.workout_type, source: w.source, flags });
    }
    // Cross-row dupe detection: workouts on the same date with overlapping windows
    const dupes = [];
    for (let i = 0; i < workouts.rows.length; i++) {
      for (let j = i + 1; j < workouts.rows.length; j++) {
        const a = workouts.rows[i], b = workouts.rows[j];
        if (!a.started_at || !b.started_at || !a.ended_at || !b.ended_at) continue;
        if (a.deleted_at || b.deleted_at) continue;
        const aStart = new Date(a.started_at).getTime(), aEnd = new Date(a.ended_at).getTime();
        const bStart = new Date(b.started_at).getTime(), bEnd = new Date(b.ended_at).getTime();
        const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
        const minDur = Math.min(aEnd - aStart, bEnd - bStart);
        if (minDur > 0 && overlap / minDur > 0.5) {
          dupes.push({ a: a.id, b: b.id, overlap_pct: Math.round(overlap / minDur * 100), a_source: a.source, b_source: b.source });
        }
      }
    }

    res.json({
      date,
      generated_at: new Date().toISOString(),
      summary: {
        workout_count: workouts.rows.length,
        active_workouts: workouts.rows.filter(w => !w.deleted_at).length,
        anomalies_count: anomalies.length,
        overlapping_pairs: dupes.length,
        has_daily_activity: daily.rows.length > 0,
        meal_count: meals.rows.length,
        plan_status: plan.rows[0]?.status || null,
        segment_count: segments.rows.length,
        coaching_session_count: coach.rows.length,
        raw_imports_count: raw.rows.length,
      },
      anomalies,
      overlapping_workouts: dupes,
      workouts: workouts.rows,
      daily_activity: daily.rows[0] || null,
      meals: meals.rows,
      body_metrics: bmets.rows,
      daily_plan: plan.rows[0] || null,
      plan_segments: segments.rows,
      coaching_sessions: coach.rows,
      daily_context: ctx.rows[0] || null,
      raw_imports: raw.rows,
    });
  } catch (err) {
    console.error(`[health/diag/full-day] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.computeHrZonesForWorkout = computeHrZonesForWorkout;
module.exports.extractHrSamplesFromB = extractHrSamplesFromB;
module.exports.parseFormatB = parseFormatB;
module.exports.parseFormatD = parseFormatD;
module.exports.normalizeMetricId = normalizeMetricId;
module.exports.B_METRIC_MAP = B_METRIC_MAP;
module.exports.D_METRIC_MAP = D_METRIC_MAP;
module.exports.ingestPayload = ingestPayload;
module.exports.mergeBodyMetricDuplicates = mergeBodyMetricDuplicates;
module.exports.pickEnergyKcal = pickEnergyKcal;
module.exports.parseFormatDWorkouts = parseFormatDWorkouts;
module.exports.normalizeWorkoutType = normalizeWorkoutType;
