// Apple Health ingest pipeline. Sniffs payload format, parses into
// daily_activity (cooperative per-format authority) and workouts. Idempotent
// at the file level (raw_health_imports.file_hash) and at the row level
// (daily_activity.activity_date UNIQUE, partial unique idx on workouts.started_at
// where source='apple_health').

const crypto = require('crypto');
const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

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
      heart_rate_avg: w.averageHeartRateBpm != null ? String(w.averageHeartRateBpm) : null,
      heart_rate_max: w.maxHeartRateBpm != null ? String(w.maxHeartRateBpm) : null,
      pace_avg: w.averagePaceSecPerKm != null ? formatPace(w.averagePaceSecPerKm * MILES_TO_KM, 'mi') : null,
      active_calories: w.activeEnergyKcal != null ? String(Math.round(w.activeEnergyKcal)) : null,
      total_calories: (w.activeEnergyKcal != null && w.basalEnergyKcal != null)
        ? String(Math.round(w.activeEnergyKcal + w.basalEnergyKcal)) : null,
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

    out.push({
      started_at: startedAt,
      ended_at: endedAt,
      workout_date: workoutDate,
      workout_type: normalizeWorkoutType(w.name),
      inferred_workout_type: false,
      time_duration: durSec > 0 ? formatDuration(durSec) : null,
      distance: distQty != null ? `${Number(distQty).toFixed(2)} ${distUnits || 'mi'}` : null,
      elevation_gain: elevUpQty != null ? `${Math.round(Number(elevUpQty))} ${elevUpUnits || 'ft'}` : null,
      heart_rate_avg: avgHR != null ? String(Math.round(Number(avgHR))) : null,
      heart_rate_max: maxHR != null ? String(Math.round(Number(maxHR))) : null,
      pace_avg: null,
      active_calories: w.activeEnergyBurned?.qty != null ? String(Math.round(w.activeEnergyBurned.qty)) : null,
      total_calories: w.totalEnergy?.qty != null ? String(Math.round(w.totalEnergy.qty)) : null,
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

    // Sleep analysis has multiple fields per data point — handle separately
    if (map.target === 'sleep') {
      for (const dp of metric.data || []) {
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
             ended_at        = COALESCE($10, ended_at),
             metadata        = metadata || $11::jsonb,
             updated_at      = NOW()
           WHERE id = $1`,
          [nearby.rows[0].id,
           w.time_duration, w.distance, w.elevation_gain,
           w.heart_rate_avg, w.heart_rate_max, w.pace_avg,
           w.active_calories, w.total_calories, w.ended_at,
           JSON.stringify({ apple_health: w.metadata || {} })]
        );
        merged++;
      } catch (err) {
        console.error(`[health/ingest] workout merge failed (${w.started_at}): ${err.message}`);
      }
      continue;
    }

    // 2) No nearby existing row — fall through to insert/upsert against the
    //    apple_health partial unique index.
    const title = `${capitalize(w.workout_type)} – ${w.workout_date}`;
    const sql = `
      INSERT INTO workouts (
        title, workout_date, workout_type, inferred_workout_type, location,
        time_duration, distance, elevation_gain,
        heart_rate_avg, heart_rate_max, pace_avg,
        active_calories, total_calories,
        started_at, ended_at, source, ai_source, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $12, $13,
        $14, $15, $16, $17, $18
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
        w.started_at, w.ended_at, w.source, w.ai_source,
        JSON.stringify(w.metadata || {}),
      ]);
      if (result.rows[0].inserted_now) inserted++; else updated++;
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
  if (m.includes('hik')) return 'hiking';
  if (m.includes('run')) return 'running';
  if (m.includes('walk')) return 'walking';
  if (m.includes('cycl') || m.includes('bik')) return 'cycling';
  if (m.includes('strength')) return 'strength';
  if (m.includes('hiit')) return 'hiit';
  if (m.includes('row')) return 'rowing';
  if (m.includes('elliptical')) return 'elliptical';
  if (m.includes('cooldown')) return 'cooldown';
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
    res.json({ reparsed: summary.length, duplicates_merged: duplicatesMerged, results: summary });
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

// Find apple_health workout rows whose started_at overlaps an existing
// manual workout (within WORKOUT_MERGE_WINDOW_SEC). Merge the apple row's
// sensor data into the manual row, then delete the apple duplicate.
async function dedupeAppleWorkouts() {
  const pairs = await query(
    `SELECT DISTINCT ON (a.id)
            a.id AS apple_id, m.id AS manual_id,
            a.distance AS apple_distance, a.heart_rate_avg AS apple_hr_avg,
            a.heart_rate_max AS apple_hr_max, a.elevation_gain AS apple_elev,
            a.pace_avg AS apple_pace, a.active_calories AS apple_active_cal,
            a.total_calories AS apple_total_cal, a.time_duration AS apple_dur,
            a.ended_at AS apple_end, a.metadata AS apple_meta
       FROM workouts a
       JOIN workouts m
         ON m.id <> a.id
        AND m.source <> 'apple_health'
        AND m.started_at IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (m.started_at - a.started_at))) < $1
      WHERE a.source = 'apple_health' AND a.started_at IS NOT NULL
      ORDER BY a.id, ABS(EXTRACT(EPOCH FROM (m.started_at - a.started_at))) ASC`,
    [WORKOUT_MERGE_WINDOW_SEC]
  );

  let merged = 0;
  for (const p of pairs.rows) {
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
           ended_at        = COALESCE($10, ended_at),
           metadata        = metadata || $11::jsonb,
           updated_at      = NOW()
         WHERE id = $1`,
        [p.manual_id, p.apple_dur, p.apple_distance, p.apple_elev,
         p.apple_hr_avg, p.apple_hr_max, p.apple_pace,
         p.apple_active_cal, p.apple_total_cal, p.apple_end,
         JSON.stringify({ apple_health: p.apple_meta || {} })]
      );
      await query(`DELETE FROM workouts WHERE id = $1 AND source = 'apple_health'`, [p.apple_id]);
      merged++;
    } catch (err) {
      console.error(`[dedupeAppleWorkouts] failed for apple=${p.apple_id} manual=${p.manual_id}: ${err.message}`);
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

  // Group consecutive workouts whose started_at delta is within window
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

module.exports = router;
module.exports.computeHrZonesForWorkout = computeHrZonesForWorkout;
module.exports.extractHrSamplesFromB = extractHrSamplesFromB;
module.exports.parseFormatB = parseFormatB;
module.exports.parseFormatD = parseFormatD;
module.exports.normalizeMetricId = normalizeMetricId;
module.exports.B_METRIC_MAP = B_METRIC_MAP;
module.exports.D_METRIC_MAP = D_METRIC_MAP;
module.exports.ingestPayload = ingestPayload;
