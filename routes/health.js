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

// ─── Format detection ───────────────────────────────────────────

function detectFormat(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  if (body.activity && Array.isArray(body.activity.daily)) return 'A';
  if (Array.isArray(body.metrics) && body.date_range) return 'B';
  if (body.days && body.summaries) return 'C';
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
    authoritative: ['steps', 'distance_km', 'exercise_minutes', 'flights_climbed',
                    'active_energy_kcal', 'workout_count'],
    fill_only: [],
  },
  B: {
    authoritative: ['resting_hr_bpm', 'walking_hr_avg_bpm', 'hrv_sdnn_ms',
                    'respiratory_rate_avg', 'walking_speed_kmh', 'walking_steadiness_pct'],
    fill_only: [],
  },
  C: {
    authoritative: ['vo2_max', 'sleep_total_min', 'sleep_deep_min', 'sleep_rem_min',
                    'sleep_core_min', 'sleep_awake_min', 'sleep_efficiency_pct',
                    'basal_energy_kcal', 'stand_hours', 'stand_minutes'],
    fill_only: ['steps', 'distance_km', 'exercise_minutes', 'flights_climbed',
                'active_energy_kcal', 'workout_count', 'resting_hr_bpm',
                'walking_hr_avg_bpm', 'hrv_sdnn_ms', 'respiratory_rate_avg',
                'walking_speed_kmh', 'walking_steadiness_pct'],
  },
};

const ALL_DAILY_COLS = [
  'steps', 'distance_km', 'exercise_minutes', 'flights_climbed', 'active_energy_kcal',
  'basal_energy_kcal', 'stand_hours', 'stand_minutes', 'workout_count',
  'resting_hr_bpm', 'walking_hr_avg_bpm', 'hrv_sdnn_ms', 'respiratory_rate_avg',
  'vo2_max', 'walking_speed_kmh', 'walking_steadiness_pct',
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
      distance_km: d.distanceKm ?? null,
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
      distance: w.distanceKm != null ? `${w.distanceKm} km` : null,
      time_duration: durSec > 0 ? formatDuration(durSec) : null,
      elevation_gain: w.elevationAscendedM != null ? `${w.elevationAscendedM} m` : null,
      heart_rate_avg: w.averageHeartRateBpm != null ? String(w.averageHeartRateBpm) : null,
      heart_rate_max: w.maxHeartRateBpm != null ? String(w.maxHeartRateBpm) : null,
      pace_avg: w.averagePaceSecPerKm != null ? formatPace(w.averagePaceSecPerKm) : null,
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

function formatPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

// ─── Format B parser (aggregate samples → per-day stats) ─────────

const B_METRIC_MAP = {
  // Common metric IDs from Apple Health time-series exporters → daily_activity columns
  heartRateVariability: { col: 'hrv_sdnn_ms', agg: 'mean' },
  hrv: { col: 'hrv_sdnn_ms', agg: 'mean' },
  restingHeartRate: { col: 'resting_hr_bpm', agg: 'mean' },
  walkingHeartRateAverage: { col: 'walking_hr_avg_bpm', agg: 'mean' },
  walkingSpeed: { col: 'walking_speed_kmh', agg: 'mean', scale: 3.6 }, // m/s → km/h
  walkingSteadiness: { col: 'walking_steadiness_pct', agg: 'mean' },
  respiratoryRate: { col: 'respiratory_rate_avg', agg: 'mean' },
  vo2Max: { col: 'vo2_max', agg: 'mean' },
};

function parseFormatB(body) {
  const byDate = new Map();
  const skippedMetrics = [];

  for (const metric of body.metrics || []) {
    const map = B_METRIC_MAP[metric.id] || B_METRIC_MAP[metric.id?.replace(/[A-Z]/g, m => m.toLowerCase())];
    if (!map) { skippedMetrics.push(metric.id); continue; }

    const buckets = new Map(); // date → values[]
    for (const dp of metric.data_points || []) {
      const d = (dp.start_date || dp.timestamp || '').slice(0, 10);
      if (!d) continue;
      const v = Number(dp.value);
      if (!isFinite(v)) continue;
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d).push(v);
    }

    for (const [date, vals] of buckets) {
      if (!byDate.has(date)) byDate.set(date, { activity_date: date });
      const agg = map.agg === 'mean'
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : map.agg === 'max' ? Math.max(...vals)
        : map.agg === 'min' ? Math.min(...vals)
        : vals.reduce((a, b) => a + b, 0);
      byDate.get(date)[map.col] = round1(agg * (map.scale || 1));
    }
  }

  return { dailyRows: Array.from(byDate.values()), skippedMetrics };
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
      if (a.walkingRunningDistance != null) row.distance_km = round3(a.walkingRunningDistance * MILES_TO_KM);
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
      if (day.mobility.walkingSpeed != null) row.walking_speed_kmh = round1(day.mobility.walkingSpeed * MILES_TO_KM);
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

async function upsertWorkouts(workouts) {
  let inserted = 0;
  let updated = 0;
  for (const w of workouts) {
    if (!w.started_at) {
      // Cannot dedupe without started_at; skip
      console.warn(`[health/ingest] workout skipped (no started_at): date=${w.workout_date}`);
      continue;
    }
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
  return { inserted, updated };
}

function capitalize(s) {
  if (!s) return 'Workout';
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    if (metric.id === 'heartRate' || metric.id === 'heart_rate') {
      for (const dp of metric.data_points || []) {
        const t = dp.timestamp || dp.start_date;
        const v = Number(dp.value);
        if (t && isFinite(v)) samples.push({ t, value: v });
      }
    }
  }
  samples.sort((a, b) => new Date(a.t) - new Date(b.t));
  return samples;
}

// ─── POST /api/health/ingest ────────────────────────────────────

router.post('/ingest', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Request body must be JSON' });
    }

    const hash = fileHash(body);
    const dup = await query('SELECT id, source_format, ingested_at, parse_result FROM raw_health_imports WHERE file_hash = $1', [hash]);
    if (dup.rows.length) {
      return res.json({ duplicate: true, file_hash: hash, ...dup.rows[0] });
    }

    const format = detectFormat(body);
    if (format === 'unknown') {
      await logImport(hash, 'unknown', body, null, { error: 'unknown format' });
      return res.status(400).json({ error: 'Unknown payload format', file_hash: hash });
    }

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
      const { dailyRows, skippedMetrics } = parseFormatB(body);
      const dailyStats = await upsertDailyActivity('B', dailyRows);

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
    }

    await logImport(hash, format, body, result, null);
    await logActivity('create', 'health_import', hash.slice(0, 12), 'apple_health',
      `Ingested ${format}: ${JSON.stringify(result)}`);

    res.json({ duplicate: false, file_hash: hash, ...result });
  } catch (err) {
    console.error(`[health/ingest] failed: ${err.stack}`);
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

module.exports = router;
module.exports.computeHrZonesForWorkout = computeHrZonesForWorkout;
module.exports.extractHrSamplesFromB = extractHrSamplesFromB;
