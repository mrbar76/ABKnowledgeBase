// Athlete-focused insights: recovery score, training load (ATL/CTL/TSB),
// body composition trends, nutrition balance. Reads from existing tables;
// no new schema beyond a `tss` column on workouts.

const express = require('express');

// Postgres returns DATE columns as JS Date objects by default, not strings.
// Normalizing here so downstream string-key Maps and string comparisons
// behave correctly. Same shape as lib/recovery.js's dateStr helper.
function dateStr(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// ─── BMR fallback ─────────────────────────────────────────────────
// HAE's daily payload doesn't reliably include basal_energy_kcal —
// depends on the user's HAE app config and which export format is
// active. When basal is null in daily_activity, we estimate it via
// Mifflin-St Jeor BMR using the user's latest weight + profile from
// the user_profile table (with env-var fallback for legacy deploys).
// Independent of HAE quirks; deterministic.
//
// Profile precedence:
//   1. user_profile row (set via PUT /api/user-profile or DB seed)
//   2. USER_HEIGHT_CM / USER_AGE / USER_SEX env vars (legacy)
//   3. Last-resort defaults (175 cm / 40 yo / male) clearly marked as
//      placeholder so it's obvious the data wasn't provided.
//
// Mifflin-St Jeor (1990) is the most accurate population formula
// without indirect calorimetry — typically within ±10% for adults:
//   Men:   10·kg + 6.25·cm − 5·age + 5
//   Women: 10·kg + 6.25·cm − 5·age − 161

let _profileCache = null;
let _profileCacheAt = 0;

async function loadUserProfile() {
  // Cache for 60s — profile changes rarely. Avoids a query per macros call.
  // Reads from athlete_profile (existing table — versioned by
  // effective_from/to). Picks the row active today.
  if (_profileCache && Date.now() - _profileCacheAt < 60_000) return _profileCache;
  try {
    const r = await query(`
      SELECT height_in, birth_date, sex
      FROM athlete_profile
      WHERE effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY effective_from DESC LIMIT 1
    `);
    const row = r.rows[0];
    _profileCache = row ? {
      // Convert height_in (athlete_profile schema) to height_cm (BMR formula).
      height_cm: row.height_in != null ? Number(row.height_in) * 2.54 : null,
      birth_date: row.birth_date,
      sex: row.sex,
    } : null;
  } catch (_) { _profileCache = null; }
  _profileCacheAt = Date.now();
  return _profileCache;
}

function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const bd = new Date(birthDate);
  if (isNaN(bd.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - bd.getFullYear();
  const m = now.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < bd.getDate())) age--;
  return age;
}

async function computeBmrKcal(weightKg) {
  if (weightKg == null || !Number.isFinite(Number(weightKg))) return null;
  const profile = await loadUserProfile();
  const heightCm = profile?.height_cm != null
    ? Number(profile.height_cm)
    : (Number(process.env.USER_HEIGHT_CM) || 175);
  const age = profile?.birth_date != null
    ? ageFromBirthDate(profile.birth_date)
    : (Number(process.env.USER_AGE) || 40);
  const sex = profile?.sex
    ? String(profile.sex).toLowerCase()
    : (process.env.USER_SEX || 'male').toLowerCase();
  const sexAdjust = sex === 'female' ? -161 : 5;
  const bmr = 10 * Number(weightKg) + 6.25 * heightCm - 5 * age + sexAdjust;
  return Math.round(bmr);
}

// Pro-rate BMR for a partial day. Apple Health's "Total CAL" by
// late evening is essentially full-day BMR + active-so-far. AB Brain
// has historically shown OUT mid-day too; pro-rating prevents
// surplus/deficit numbers from looking inflated at 8 AM.
async function bmrForDate(weightKg, dateStr) {
  const full = await computeBmrKcal(weightKg);
  if (full == null) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr !== today) return full;
  // Mid-day on `today`: pro-rate by hours elapsed.
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const fraction = Math.min(1, (now.getTime() - startOfDay.getTime()) / 86400000);
  return Math.round(full * fraction);
}
const { query } = require('../db');
const router = express.Router();

// ─── Helpers ────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
}

function lastN(rows, n, key) {
  return rows
    .filter(r => r[key] != null)
    .slice(-n)
    .map(r => Number(r[key]))
    .filter(v => isFinite(v));
}

// Exponentially-weighted moving average — used for ATL (7d) and CTL (42d).
// Uses standard fitness-modeling formula: today = yesterday * (1 - 1/N) + tss/N.
function ewma(dailyTss, n) {
  let v = 0;
  const out = [];
  for (const tss of dailyTss) {
    v = v * (1 - 1 / n) + (tss || 0) / n;
    out.push(v);
  }
  return out;
}

// ─── TSS computation ────────────────────────────────────────────
// If athlete_zones row covers the workout's date and we have heart_rate_avg
// and duration: compute hrTSS = duration_hours × IF² × 100, where
// IF = avg_HR / LTHR. Otherwise fall back to effort-based estimate
// (duration_min × effort × 1.5, capped at 200).

function durationToSeconds(s) {
  if (!s) return 0;
  const m = String(s).match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, h, mm, ss] = m;
  return (Number(h) || 0) * 3600 + Number(mm) * 60 + Number(ss);
}

async function getZonesForDate(date) {
  const r = await query(
    `SELECT * FROM athlete_zones
     WHERE zone_type = 'heart_rate'
       AND effective_from <= $1
       AND (effective_to IS NULL OR effective_to >= $1)
     ORDER BY effective_from DESC LIMIT 1`,
    [date]
  );
  return r.rows[0] || null;
}

function computeTSS(workout, zones) {
  const durSec = durationToSeconds(workout.time_duration);
  const durHr = durSec / 3600;
  if (durHr <= 0) return null;

  const avgHR = workout.heart_rate_avg ? Number(String(workout.heart_rate_avg).replace(/[^\d.]/g, '')) : null;
  const lthr = zones?.lthr || (zones?.max_hr ? Math.round(zones.max_hr * 0.88) : null);
  if (avgHR && lthr) {
    const intensity = avgHR / lthr;
    return Math.round(durHr * intensity * intensity * 100);
  }
  // Fallback: effort-based estimate. effort 1-10. duration_min × effort × 1.5
  const effort = Number(workout.effort) || 5;
  const tss = (durSec / 60) * effort * 1.5;
  return Math.min(Math.round(tss), 200);
}

// ─── GET /api/health/insights/today — recovery readiness ────────

// ─── Coaching rules (provenance: docs/coaching-rules.md) ────────
// Rule A: 7-day rolling effort sum > 50 for 5+ consecutive days OR ≥30%
//         week-over-week jump → chronic load alarm.
// Rule B: 3+ consecutive days with at least one workout effort ≥ 7 →
//         density alarm.

function lastNDates(n) {
  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function chronicLoadAlerts(workouts) {
  const byDate = new Map();
  for (const w of workouts) {
    const e = Number(w.effort) || 0;
    if (!e) continue;
    byDate.set(w.workout_date, (byDate.get(w.workout_date) || 0) + e);
  }
  const days = lastNDates(14);
  const efforts = days.map(d => byDate.get(d) || 0);
  const rolling = efforts.map((_, i) => {
    let sum = 0;
    for (let j = Math.max(0, i - 6); j <= i; j++) sum += efforts[j];
    return sum;
  });
  const alerts = [];
  let trailingHigh = 0;
  for (let i = rolling.length - 1; i >= 0; i--) {
    if (rolling[i] > 50) trailingHigh++;
    else break;
  }
  if (trailingHigh >= 5) {
    alerts.push({
      severity: 'high', type: 'chronic_load',
      reason: `7-day load > 50 for ${trailingHigh} consecutive days — deload required`,
    });
  }
  if (rolling.length >= 14) {
    const thisWeek = rolling[rolling.length - 1];
    const lastWeek = rolling[rolling.length - 8];
    if (lastWeek > 0 && (thisWeek - lastWeek) / lastWeek >= 0.30) {
      const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
      alerts.push({
        severity: 'high', type: 'load_spike',
        reason: `7-day load jumped ${pct}% week-over-week (${lastWeek} → ${thisWeek}) — deload recommended`,
      });
    }
  }
  return alerts;
}

function consecutiveHardDayAlerts(workouts) {
  const maxEffortByDate = new Map();
  for (const w of workouts) {
    const e = Number(w.effort) || 0;
    const cur = maxEffortByDate.get(w.workout_date) || 0;
    if (e > cur) maxEffortByDate.set(w.workout_date, e);
  }
  const days = lastNDates(14);
  const isHard = days.map(d => (maxEffortByDate.get(d) || 0) >= 7);
  let trailing = 0;
  for (let i = isHard.length - 1; i >= 0; i--) {
    if (isHard[i]) trailing++;
    else break;
  }
  // Threshold lowered from 3 → 2 (Avi-specific): both spring 2026 injury
  // cascades were preceded by 3-day clusters. By the time the 3rd day
  // hits, accumulated damage is already in motion. 2-day cap gives one
  // buffer day to interrupt before the cascade triggers.
  if (trailing >= 2) {
    return [{
      severity: 'high', type: 'density',
      reason: `${trailing} consecutive hard days (effort ≥ 7) — forced rest day required`,
    }];
  }
  return [];
}

// Rule E (Avi-specific): TSB < -80 = automatic rest. Functional
// overtraining indicator. Surfaces alongside ACWR > 1.5 since they
// catch overlapping but not identical patterns (TSB integrates 6 weeks
// of CTL; ACWR is sharper 7d/28d ratio). Caller passes today's TSB
// from the load model.
function tsbAlerts(todayTSB) {
  if (todayTSB == null) return [];
  if (todayTSB < -80) {
    return [{
      severity: 'high', type: 'tsb_crash',
      reason: `TSB at ${Math.round(todayTSB)} — functional overtraining zone, forced rest`,
    }];
  }
  if (todayTSB < -30) {
    return [{
      severity: 'medium', type: 'tsb_low',
      reason: `TSB at ${Math.round(todayTSB)} — accumulated fatigue, hold or reduce volume`,
    }];
  }
  return [];
}

// Rule F (Avi-specific): single night < 5h sleep = automatic effort
// downgrade. Two consecutive nights < 5h = halve session intensity.
// Coach reads this and drops one effort tier (planned hard → moderate;
// moderate → easy/recovery).
function sleepAlerts(daRows) {
  if (!daRows || !daRows.length) return [];
  const last = daRows[daRows.length - 1];
  const prev = daRows[daRows.length - 2];
  const lastSleep = last?.sleep_total_min;
  const prevSleep = prev?.sleep_total_min;
  const alerts = [];
  if (lastSleep != null && lastSleep < 300 && prevSleep != null && prevSleep < 300) {
    alerts.push({
      severity: 'high', type: 'sleep_deprivation',
      reason: `${(lastSleep/60).toFixed(1)}h + ${(prevSleep/60).toFixed(1)}h two nights running — halve intensity`,
    });
  } else if (lastSleep != null && lastSleep < 300) {
    alerts.push({
      severity: 'high', type: 'sleep_short',
      reason: `${(lastSleep/60).toFixed(1)}h last night — drop one effort tier`,
    });
  }
  return alerts;
}

// Quick TSB computation for alert composition. Pulls 90 days of daily
// TSS, runs ATL (7d EWMA) and CTL (42d EWMA), returns today's TSB
// (CTL - ATL). Used by tsbAlerts in /insights/today, morning, trends.
async function computeTodayTSB() {
  try {
    const start = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const r = await query(
      `SELECT workout_date, COALESCE(SUM(tss), 0) AS daily_tss
       FROM workouts WHERE workout_date >= $1 AND tss IS NOT NULL
       GROUP BY workout_date ORDER BY workout_date ASC`,
      [start]
    );
    const tssMap = new Map();
    for (const row of r.rows) tssMap.set(dateOnly(row.workout_date), Number(row.daily_tss) || 0);
    const startMs = new Date(start + 'T12:00:00').getTime();
    const todayMs = new Date(today + 'T12:00:00').getTime();
    const dailyTss = [];
    for (let ms = startMs; ms <= todayMs; ms += 86400_000) {
      const d = new Date(ms).toISOString().slice(0, 10);
      dailyTss.push(tssMap.get(d) || 0);
    }
    const atlSeries = ewma(dailyTss, 7);
    const ctlSeries = ewma(dailyTss, 42);
    const todayATL = atlSeries[atlSeries.length - 1] || 0;
    const todayCTL = ctlSeries[ctlSeries.length - 1] || 0;
    return todayCTL - todayATL;
  } catch (_) {
    return null;
  }
}

// Normalize a daily_activity / meals row's date column to YYYY-MM-DD,
// regardless of whether pg returned it as a Date object, ISO string, or
// already-stripped date string. Avoids invalid-date crashes downstream.
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function hrvByDayOfWeek(rows) {
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = Object.fromEntries(dows.map(d => [d, []]));
  for (const r of rows) {
    if (r.hrv_sdnn_ms == null || !r.activity_date) continue;
    const ds = dateOnly(r.activity_date);
    if (!ds) continue;
    const d = new Date(ds + 'T12:00:00');
    if (isNaN(d.getTime())) continue;
    buckets[dows[d.getDay()]].push(Number(r.hrv_sdnn_ms));
  }
  const out = {};
  for (const d of dows) {
    out[d] = buckets[d].length ? round1(mean(buckets[d])) : null;
  }
  return out;
}

// Day-of-week patterns: HRV, max effort that day, sleep total, calories balance.
// Bucket each daily_activity row by weekday, average the values. Validates
// the user's "Saturday HRV is suppressed" finding and surfaces other patterns.
function dowPatterns(activityRows, workoutRows, mealRows) {
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = Object.fromEntries(dows.map(d => [d, { hrv: [], effort: [], sleep: [], cals: [] }]));
  // Index workouts by date (max effort per day) — normalize date keys
  const effortByDate = new Map();
  for (const w of workoutRows || []) {
    const e = Number(w.effort) || 0;
    const ds = dateOnly(w.workout_date);
    if (!ds) continue;
    const cur = effortByDate.get(ds) || 0;
    if (e > cur) effortByDate.set(ds, e);
  }
  // Index meals' calorie sum by date
  const mealsByDate = new Map();
  for (const m of mealRows || []) {
    const ds = dateOnly(m.meal_date);
    if (ds) mealsByDate.set(ds, Number(m.kcal) || 0);
  }
  for (const r of activityRows) {
    const ds = dateOnly(r.activity_date);
    if (!ds) continue;
    const d = new Date(ds + 'T12:00:00');
    if (isNaN(d.getTime())) continue;
    const key = dows[d.getDay()];
    if (!buckets[key]) continue;
    if (r.hrv_sdnn_ms != null) buckets[key].hrv.push(Number(r.hrv_sdnn_ms));
    if (r.sleep_total_min != null) buckets[key].sleep.push(Number(r.sleep_total_min));
    const ef = effortByDate.get(ds);
    if (ef != null) buckets[key].effort.push(ef);
    const inK = mealsByDate.get(ds);
    if (inK != null) {
      const out = (Number(r.active_energy_kcal) || 0) + (Number(r.basal_energy_kcal) || 0);
      buckets[key].cals.push(inK - out);
    }
  }
  const out = {};
  for (const d of dows) {
    const b = buckets[d];
    out[d] = {
      hrv: b.hrv.length ? round1(mean(b.hrv)) : null,
      effort: b.effort.length ? round1(mean(b.effort)) : null,
      sleep_min: b.sleep.length ? Math.round(mean(b.sleep)) : null,
      cals_balance: b.cals.length ? Math.round(mean(b.cals)) : null,
      sample_size: b.hrv.length,
    };
  }
  return out;
}

// ─── GET /api/health/insights/today — recovery readiness ────────

router.get('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const lookback = 30;
    const startDate = new Date(Date.now() - lookback * 86400_000).toISOString().slice(0, 10);

    // FULL OUTER JOIN of daily_vitals_cache (Shortcut-fed, post-HAE) with
    // daily_activity (legacy HAE-fed history). Cache values win on overlap;
    // daily_activity fills dates the cache hasn't reached yet (historical
    // baselines). v1.9.4: cache no longer holds sleep stages or efficiency;
    // those come exclusively from daily_activity (historical) until that
    // table is dropped in Phase 8 (~Aug 5, 2026).
    const r = await query(
      `SELECT
         COALESCE(c.date, da.activity_date)              AS activity_date,
         COALESCE(c.hrv_ms, da.hrv_sdnn_ms)              AS hrv_sdnn_ms,
         COALESCE(c.rhr_bpm, da.resting_hr_bpm)          AS resting_hr_bpm,
         COALESCE(c.sleep_total_min, da.sleep_total_min) AS sleep_total_min,
         da.sleep_deep_min,
         da.sleep_rem_min,
         da.sleep_core_min,
         da.sleep_awake_min,
         da.sleep_efficiency_pct,
         da.active_energy_kcal,
         da.basal_energy_kcal,
         c.respiratory_rate_bpm
       FROM daily_vitals_cache c
       FULL OUTER JOIN daily_activity da ON c.date = da.activity_date
       WHERE COALESCE(c.date, da.activity_date) >= $1
       ORDER BY activity_date ASC`,
      [startDate]
    );
    const rows = r.rows;
    // For dow_patterns: workouts (effort) + meals (cals_in)
    const dowWorkouts = await query(
      `SELECT workout_date, MAX(effort) AS effort FROM workouts
       WHERE workout_date >= $1
       GROUP BY workout_date`,
      [startDate]
    ).catch(() => ({ rows: [] }));
    const dowMeals = await query(
      `SELECT meal_date, COALESCE(SUM(calories), 0) AS kcal FROM meals
       WHERE meal_date >= $1
       GROUP BY meal_date`,
      [startDate]
    ).catch(() => ({ rows: [] }));

    const hrvVals = lastN(rows, lookback, 'hrv_sdnn_ms');
    const rhrVals = lastN(rows, lookback, 'resting_hr_bpm');
    const sleepVals = lastN(rows, lookback, 'sleep_total_min');

    const hrvBase = mean(hrvVals);
    const hrvSd = stddev(hrvVals);
    const rhrBase = mean(rhrVals);
    const rhrSd = stddev(rhrVals);
    const sleepBase = mean(sleepVals);

    // Most recent row for "today" snapshot
    const todayRow = rows[rows.length - 1] || {};
    // HAE syncs HRV/RHR once per day after the watch records it, so today's
    // row is often partially populated (steps yes, HRV null). Walk back to
    // find the most recent non-null reading and tag it with as_of.
    function mostRecentNonNull(field) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const v = rows[i][field];
        if (v != null) return { value: Number(v), as_of: dateOnly(rows[i].activity_date) };
      }
      return { value: null, as_of: null };
    }
    const hrvLatest = mostRecentNonNull('hrv_sdnn_ms');
    const rhrLatest = mostRecentNonNull('resting_hr_bpm');
    const sleepLatest = mostRecentNonNull('sleep_total_min');
    const deepLatest = mostRecentNonNull('sleep_deep_min');
    const remLatest = mostRecentNonNull('sleep_rem_min');

    const hrvToday = hrvLatest.value;
    const rhrToday = rhrLatest.value;
    const sleepToday = sleepLatest.value;
    const deepToday = deepLatest.value;
    const remToday = remLatest.value;
    const todayDate = dateOnly(todayRow.activity_date) || today;
    const hrvIsStale = hrvLatest.as_of && hrvLatest.as_of !== todayDate;
    const rhrIsStale = rhrLatest.as_of && rhrLatest.as_of !== todayDate;
    const sleepIsStale = sleepLatest.as_of && sleepLatest.as_of !== todayDate;

    const hrvDevSd = (hrvToday != null && hrvBase != null && hrvSd) ? (hrvToday - hrvBase) / hrvSd : null;
    const rhrDevSd = (rhrToday != null && rhrBase != null && rhrSd) ? (rhrToday - rhrBase) / rhrSd : null;

    // Recovery score (0-100)
    let score = 75;
    let reasons = [];
    if (hrvDevSd != null) {
      if (hrvDevSd >= 0.5) { score += 15; reasons.push(`HRV ${hrvDevSd.toFixed(1)}σ above baseline`); }
      else if (hrvDevSd <= -1.0) { score -= 25; reasons.push(`HRV ${hrvDevSd.toFixed(1)}σ below baseline — suppressed`); }
      else if (hrvDevSd <= -0.5) { score -= 10; reasons.push(`HRV ${hrvDevSd.toFixed(1)}σ below baseline`); }
    }
    if (rhrDevSd != null) {
      if (rhrDevSd <= -0.5) { score += 8; reasons.push(`RHR ${Math.abs(rhrDevSd).toFixed(1)}σ below baseline`); }
      else if (rhrDevSd >= 1.0) { score -= 15; reasons.push(`RHR ${rhrDevSd.toFixed(1)}σ above baseline — elevated stress`); }
    }
    if (sleepToday != null) {
      if (sleepToday < 360) { score -= 25; reasons.push(`Sleep <6h`); }
      else if (sleepToday < 420) { score -= 10; reasons.push(`Sleep ~6-7h`); }
      else if (sleepToday >= 420 && sleepToday <= 540) { score += 5; reasons.push(`Sleep 7-9h`); }
    }
    if (deepToday != null && remToday != null && sleepToday) {
      const qualityPct = ((deepToday + remToday) / sleepToday) * 100;
      if (qualityPct >= 35) { score += 5; reasons.push(`Deep+REM ${qualityPct.toFixed(0)}%`); }
      else if (qualityPct < 20) { score -= 5; reasons.push(`Deep+REM only ${qualityPct.toFixed(0)}%`); }
    }
    score = Math.max(0, Math.min(100, score));

    let status = score >= 75 ? 'good' : score >= 55 ? 'moderate' : 'poor';
    let recommendation = score >= 80 ? 'Push hard — your body is ready.'
      : score >= 65 ? 'Train as planned.'
      : score >= 45 ? 'Moderate intensity only. Skip the hardest sets.'
      : 'Recovery day. Sleep, walk, mobility only.';

    // ─── Coaching rules: load + density + TSB + sleep alerts ──
    const recentWorkouts = await query(
      `SELECT workout_date, effort FROM workouts
       WHERE workout_date >= CURRENT_DATE - INTERVAL '14 days'
         AND effort IS NOT NULL
       ORDER BY workout_date ASC`
    );
    const todayTSB = await computeTodayTSB();
    const alerts = [
      ...chronicLoadAlerts(recentWorkouts.rows),
      ...consecutiveHardDayAlerts(recentWorkouts.rows),
      ...tsbAlerts(todayTSB),
      ...sleepAlerts(rows),
    ];
    if (alerts.some(a => a.severity === 'high')) {
      status = 'deload';
      recommendation = 'DELOAD — ' + alerts[0].reason;
    }

    // Last 7 days for sparkline
    const trend7d = rows.slice(-7).map(r => ({
      date: dateOnly(r.activity_date),
      hrv: r.hrv_sdnn_ms != null ? Number(r.hrv_sdnn_ms) : null,
      rhr: r.resting_hr_bpm != null ? Number(r.resting_hr_bpm) : null,
      sleep_min: r.sleep_total_min != null ? Number(r.sleep_total_min) : null,
    }));

    res.json({
      date: dateOnly(todayRow.activity_date) || today,
      readiness_score: score,
      readiness_status: status,
      recommendation,
      reasons,
      alerts,
      components: {
        hrv: { today: hrvToday, baseline: hrvBase ? round1(hrvBase) : null, deviation_sd: hrvDevSd != null ? round1(hrvDevSd) : null, sample_size: hrvVals.length, as_of: hrvLatest.as_of, is_stale: hrvIsStale || false },
        rhr: { today: rhrToday, baseline: rhrBase ? round1(rhrBase) : null, deviation_sd: rhrDevSd != null ? round1(rhrDevSd) : null, sample_size: rhrVals.length, as_of: rhrLatest.as_of, is_stale: rhrIsStale || false },
        sleep: { last_night_min: sleepToday, baseline_min: sleepBase ? Math.round(sleepBase) : null, target_min: 480, debt_min: sleepToday != null && sleepBase != null ? Math.max(0, Math.round(sleepBase - sleepToday)) : null, as_of: sleepLatest.as_of, is_stale: sleepIsStale || false },
        sleep_quality: { deep_min: deepToday, rem_min: remToday, deep_rem_pct: (deepToday != null && remToday != null && sleepToday) ? round1((deepToday + remToday) / sleepToday * 100) : null, efficiency_pct: todayRow.sleep_efficiency_pct != null ? Number(todayRow.sleep_efficiency_pct) : null },
      },
      trend_7d: trend7d,
      hrv_by_day_of_week: hrvByDayOfWeek(rows),
      dow_patterns: dowPatterns(rows, dowWorkouts.rows, dowMeals.rows),
      sleep_history_30d: rows.slice(-30).map(r => ({
        date: dateOnly(r.activity_date),
        total_min: r.sleep_total_min != null ? Number(r.sleep_total_min) : null,
        deep_min: r.sleep_deep_min != null ? Number(r.sleep_deep_min) : null,
        rem_min: r.sleep_rem_min != null ? Number(r.sleep_rem_min) : null,
        core_min: r.sleep_core_min != null ? Number(r.sleep_core_min) : null,
        awake_min: r.sleep_awake_min != null ? Number(r.sleep_awake_min) : null,
      })).filter(r => r.total_min != null),
    });
  } catch (err) {
    console.error(`[insights/today] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/insights/training — load: ATL/CTL/TSB + volume ──

router.get('/training', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 90, 365);
    // end_date anchors the rolling window. Defaults to today. When set,
    // the entire calculation (daily TSS series, EWMA, weekly summary,
    // Z2-by-week) is computed as if `end_date` were the current day.
    // Lets the Training tab show past-date load context.
    const endDate = req.query.end_date || new Date().toISOString().slice(0, 10);
    const endMs = new Date(endDate + 'T12:00:00').getTime();
    const startDate = new Date(endMs - days * 86400_000).toISOString().slice(0, 10);

    const w = await query(
      `SELECT id, workout_date, started_at, workout_type, time_duration,
              heart_rate_avg, effort, distance, tss, hr_zones
       FROM workouts
       WHERE workout_date >= $1 AND workout_date <= $2
       ORDER BY workout_date ASC`,
      [startDate, endDate]
    );
    const workouts = w.rows;

    // Normalize workout_date to YYYY-MM-DD string up front. Postgres returns
    // DATE columns as Date objects, which silently break the dailyTss Map
    // lookup (string keys) and the weekly string comparison below. Caused
    // the entire daily TSS series to read as zeros, hiding all logged
    // training. Bug predated end_date param work.
    for (const wo of workouts) {
      wo.workout_date = dateStr(wo.workout_date);
    }

    // Per-workout TSS — fill missing. Uses zones in effect at endDate
    // (not "today") so historical TSS reflects the zones at that time
    // if the helper supports past-dated lookups.
    const zonesRow = await getZonesForDate(endDate);
    for (const wo of workouts) {
      if (wo.tss == null) wo.tss = computeTSS(wo, zonesRow);
    }

    // Daily TSS series — anchored to endDate, walking back `days` days.
    const dailyTss = new Map();
    for (let i = 0; i < days; i++) {
      const d = new Date(endMs - (days - 1 - i) * 86400_000).toISOString().slice(0, 10);
      dailyTss.set(d, 0);
    }
    for (const wo of workouts) {
      if (dailyTss.has(wo.workout_date)) {
        dailyTss.set(wo.workout_date, dailyTss.get(wo.workout_date) + (wo.tss || 0));
      }
    }
    const dates = Array.from(dailyTss.keys());
    const tssSeries = Array.from(dailyTss.values());

    const atl = ewma(tssSeries, 7);
    const ctl = ewma(tssSeries, 42);
    const tsb = atl.map((a, i) => ctl[i] - a);

    // "Current" here means the value at endDate (the last entry in the
    // series), which equals "today" when end_date is omitted.
    const todayATL = atl[atl.length - 1] || 0;
    const todayCTL = ctl[ctl.length - 1] || 0;
    const todayTSB = tsb[tsb.length - 1] || 0;
    const status = todayTSB > 5 ? 'fresh'
      : todayTSB > -10 ? 'neutral'
      : todayTSB > -20 ? 'fatigued'
      : 'very_fatigued';

    // Weekly summary — 7 days ending at endDate.
    const weekStart = new Date(endMs - 7 * 86400_000).toISOString().slice(0, 10);
    const weekWorkouts = workouts.filter(wo => wo.workout_date >= weekStart && wo.workout_date <= endDate);
    let weekMiles = 0, weekSec = 0, weekTss = 0;
    const zoneMin = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    for (const wo of weekWorkouts) {
      const m = wo.distance ? Number(String(wo.distance).replace(/[^\d.]/g, '')) : 0;
      if (String(wo.distance || '').toLowerCase().includes('mi')) weekMiles += m;
      weekSec += durationToSeconds(wo.time_duration);
      weekTss += wo.tss || 0;
      if (wo.hr_zones?.minutes) {
        for (const z of ['z1', 'z2', 'z3', 'z4', 'z5']) zoneMin[z] += wo.hr_zones.minutes[z] || 0;
      }
    }

    res.json({
      current: {
        atl: round1(todayATL),
        ctl: round1(todayCTL),
        tsb: round1(todayTSB),
        status,
      },
      weekly: {
        workouts: weekWorkouts.length,
        miles: round1(weekMiles),
        hours: round1(weekSec / 3600),
        tss: Math.round(weekTss),
        time_in_zone_min: zoneMin,
      },
      history: dates.map((d, i) => ({
        date: d,
        tss: Math.round(tssSeries[i]),
        atl: round1(atl[i]),
        ctl: round1(ctl[i]),
        tsb: round1(tsb[i]),
      })),
      z2_minutes_by_week: z2MinutesByWeek(workouts, 12, endDate),
    });
  } catch (err) {
    console.error(`[insights/training] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// Aggregate Z2 minutes from each workout's hr_zones into ISO weeks for the
// last `weeks` weeks. Returns [{ week_start, minutes }, ...] in chronological
// order. Z2 is the aerobic-base zone; tracking weekly volume here is the key
// long-term endurance KPI.
function z2MinutesByWeek(workouts, weeks = 12, endDate = null) {
  // Map each workout to its ISO-week-start (Monday)
  function isoWeekStart(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = (d.getDay() + 6) % 7; // Mon = 0
    d.setDate(d.getDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  const buckets = new Map();
  // Initialize empty buckets for the last `weeks` weeks ending at endDate
  // (or today when endDate is null).
  const anchor = endDate ? new Date(endDate + 'T12:00:00') : new Date();
  const anchorDow = (anchor.getDay() + 6) % 7;
  const anchorMonday = new Date(anchor);
  anchorMonday.setDate(anchor.getDate() - anchorDow);
  for (let i = weeks - 1; i >= 0; i--) {
    const m = new Date(anchorMonday);
    m.setDate(anchorMonday.getDate() - i * 7);
    buckets.set(m.toISOString().slice(0, 10), 0);
  }
  for (const w of workouts) {
    if (!w.hr_zones || !w.hr_zones.minutes) continue;
    const z2 = Number(w.hr_zones.minutes.z2) || 0;
    if (z2 <= 0) continue;
    const wk = isoWeekStart(w.workout_date);
    if (buckets.has(wk)) buckets.set(wk, buckets.get(wk) + z2);
  }
  return Array.from(buckets.entries()).map(([week_start, minutes]) => ({
    week_start,
    minutes: Math.round(minutes),
  }));
}

// ─── GET /api/health/insights/body — composition trends ────────

router.get('/body', async (req, res) => {
  try {
    const r = await query(
      `SELECT measurement_date, weight_lb, body_fat_pct, lean_mass_lb, bmi
       FROM body_metrics
       WHERE measurement_date >= CURRENT_DATE - INTERVAL '180 days'
       ORDER BY measurement_date ASC`
    );
    const rows = r.rows;
    if (!rows.length) return res.json({ current: null, trends: null, history: [] });

    const last = rows[rows.length - 1];
    const findRow = (daysAgo) => {
      const target = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
      // Find closest row with measurement_date <= target
      let best = null;
      for (const row of rows) {
        if (row.measurement_date <= target) best = row;
      }
      return best;
    };

    const delta = (field, daysAgo) => {
      const past = findRow(daysAgo);
      const now = last[field];
      if (now == null || past == null || past[field] == null) return null;
      return round1(Number(now) - Number(past[field]));
    };

    res.json({
      current: {
        date: last.measurement_date,
        weight_lb: last.weight_lb != null ? Number(last.weight_lb) : null,
        body_fat_pct: last.body_fat_pct != null ? Number(last.body_fat_pct) : null,
        lean_mass_lb: last.lean_mass_lb != null ? Number(last.lean_mass_lb) : null,
        bmi: last.bmi != null ? Number(last.bmi) : null,
      },
      trends: {
        weight: { d7: delta('weight_lb', 7), d30: delta('weight_lb', 30), d90: delta('weight_lb', 90) },
        body_fat_pct: { d7: delta('body_fat_pct', 7), d30: delta('body_fat_pct', 30), d90: delta('body_fat_pct', 90) },
        lean_mass_lb: { d7: delta('lean_mass_lb', 7), d30: delta('lean_mass_lb', 30), d90: delta('lean_mass_lb', 90) },
      },
      history: rows.map(r => ({
        date: r.measurement_date,
        weight_lb: r.weight_lb != null ? Number(r.weight_lb) : null,
        body_fat_pct: r.body_fat_pct != null ? Number(r.body_fat_pct) : null,
        lean_mass_lb: r.lean_mass_lb != null ? Number(r.lean_mass_lb) : null,
      })),
    });
  } catch (err) {
    console.error(`[insights/body] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/insights/nutrition — caloric balance ────────

router.get('/nutrition', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 14, 90);
    const startDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    // Optional ?date= picks the row to surface in `today`. If absent, the
    // most-recent activity row is used (legacy behavior). The UI passes the
    // selected nutritionDate so the card follows the date picker.
    const targetDate = req.query.date || null;

    // Activity output (active + basal kcal). Pull updated_at so the UI
    // can show "synced N min ago" and basal_energy_kcal can fall back
    // to BMR when null.
    const a = await query(
      `SELECT activity_date, active_energy_kcal, basal_energy_kcal, updated_at
       FROM daily_activity
       WHERE activity_date >= $1
       ORDER BY activity_date ASC`,
      [startDate]
    );

    // Nutrition input — sum all macros per day. v1.10.3: fiber_g dropped from
    // schema (v1.9.4 cleanup); was breaking the entire /insights/nutrition
    // call because the catch() swallowed the SQL error and returned empty
    // rows, zeroing out the Macros & Balance card.
    const m = await query(
      `SELECT meal_date,
              COALESCE(SUM(calories), 0) AS kcal,
              COALESCE(SUM(protein_g), 0) AS protein_g,
              COALESCE(SUM(carbs_g), 0) AS carbs_g,
              COALESCE(SUM(fat_g), 0) AS fat_g
       FROM meals
       WHERE meal_date >= $1
       GROUP BY meal_date
       ORDER BY meal_date ASC`,
      [startDate]
    ).catch(() => ({ rows: [] }));

    // Postgres returns DATE columns as JS Date objects. Map keys compare by
    // identity, so two different Date instances representing the same day
    // miss. Normalize every key to YYYY-MM-DD string before storing/lookup.
    const mealMap = new Map();
    for (const row of m.rows) {
      mealMap.set(dateOnly(row.meal_date), {
        kcal: Number(row.kcal) || 0,
        protein_g: Number(row.protein_g) || 0,
        carbs_g: Number(row.carbs_g) || 0,
        fat_g: Number(row.fat_g) || 0,
      });
    }

    // Per-day plan targets (when set)
    const p = await query(
      `SELECT plan_date, target_calories, target_protein_g, target_carbs_g, target_fat_g
       FROM daily_plans
       WHERE plan_date >= $1`,
      [startDate]
    ).catch(() => ({ rows: [] }));
    const planMap = new Map();
    for (const row of p.rows) {
      planMap.set(dateOnly(row.plan_date), row);
    }

    // Hard-day detection per date — drives carb-target swing (workout day vs rest).
    // ALSO query workout_count separately so a workout with effort=NULL or
    // effort < 5 still counts as a training day (v1.8.13 fix). Previously
    // a deadlift session logged with effort=4 was tagged "rest day" because
    // the threshold was strict >= 5. New rule: any workout row exists OR
    // effort >= 5 → training day. Plan_segments with status='completed'
    // also count. v1.11.1: prefer cal_active (numeric dual column) over the
    // TEXT active_calories field — some rows have unit suffixes ("75 kcal")
    // that crash the ::numeric cast. Falls back to a regex-stripped numeric
    // cast if cal_active is null but active_calories has digits.
    const wo = await query(
      `SELECT workout_date,
              MAX(effort) AS max_effort,
              COUNT(*)::int AS workout_count,
              SUM(COALESCE(
                cal_active,
                NULLIF(REGEXP_REPLACE(COALESCE(active_calories, ''), '[^0-9.]', '', 'g'), '')::numeric,
                0
              )) AS workout_active_kcal
       FROM workouts
       WHERE workout_date >= $1 AND deleted_at IS NULL
       GROUP BY workout_date`,
      [startDate]
    ).catch(() => ({ rows: [] }));
    const effortMap = new Map();
    const workoutCountMap = new Map();
    // Also count completed plan_segments as training-day signals.
    const segR = await query(
      `SELECT dp.plan_date,
              COUNT(*) FILTER (WHERE ps.status = 'completed' AND ps.logging_target IN ('hevy','apple_health'))::int AS done_segments
       FROM plan_segments ps
       JOIN daily_plans dp ON dp.id = ps.daily_plan_id
       WHERE dp.plan_date >= $1
       GROUP BY dp.plan_date`,
      [startDate]
    ).catch(() => ({ rows: [] }));
    const completedSegmentMap = new Map();
    for (const row of segR.rows) completedSegmentMap.set(dateOnly(row.plan_date), Number(row.done_segments) || 0);
    // v1.8.12: workoutActiveByDate — secondary signal for active calories.
    // HAE Format A often pushes daily_activity.active_energy_kcal only
    // once per day (early), leaving it stuck at a tiny value while
    // workouts log many active kcal throughout the day. We use
    // max(daily_activity, workout_sum) so OUT isn't held hostage by
    // HAE push cadence.
    const workoutActiveByDate = new Map();
    for (const row of wo.rows) {
      const date = dateOnly(row.workout_date);
      effortMap.set(date, Number(row.max_effort) || 0);
      workoutCountMap.set(date, Number(row.workout_count) || 0);
      const wa = Number(row.workout_active_kcal) || 0;
      if (wa > 0) workoutActiveByDate.set(date, Math.round(wa));
    }

    // Latest weight for per-kg targets
    const w = await query(
      `SELECT weight_lb FROM body_metrics
       WHERE weight_lb IS NOT NULL
       ORDER BY measurement_date DESC LIMIT 1`
    );
    const weightLb = w.rows[0]?.weight_lb ? Number(w.rows[0].weight_lb) : null;
    const weightKg = weightLb ? weightLb / 2.2046226218 : null;

    function macroBlock(actual, planTarget, fallback, sourceWhenPlan = 'plan', sourceWhenFallback = 'estimated') {
      const target = planTarget != null ? Number(planTarget) : (fallback != null ? Math.round(fallback) : null);
      const source = planTarget != null ? sourceWhenPlan : (fallback != null ? sourceWhenFallback : null);
      const deficit = (target != null) ? Math.round(target - actual) : null;
      return { actual: Math.round(actual), target, deficit, source };
    }

    const history = await Promise.all(a.rows.map(async r => {
      const date = dateOnly(r.activity_date);
      // v1.8.15: per Coach spec, Apple Health is sole source of truth
      // for daily energy. Don't take max(haeActive, workoutSum) — that
      // double-counts when Apple Watch auto-detects N workouts that
      // overlap a Hevy entry, AND it loses NEAT (dog walks, ambient
      // activity). v1.8.12's max() approach was a bad workaround for
      // HAE staleness; the right fix is HAE 15-min push cadence.
      //
      // v1.8.22: BUT — workouts are a strict subset of daily active.
      // If `workoutActive > haeActive`, that's an integrity violation
      // proving Apple data is stale (HAE hasn't pushed today's full
      // export yet). In that case, floor `active` at workoutActive so
      // OUT doesn't fall below logged training, and tag the row
      // `apple_stale` so the UI can prompt for HAE refresh.
      const haeActive = Number(r.active_energy_kcal) || 0;
      const workoutActive = workoutActiveByDate.get(date) || 0;
      const appleStale = workoutActive > haeActive;
      const active = appleStale ? workoutActive : haeActive;
      const activeSource = appleStale
        ? 'workouts_floor_stale_apple'
        : (haeActive > 0 ? 'apple_health' : null);
      // NEAT only computable when Apple data is fresh. When stale, we
      // can't separate workouts vs ambient, so report 0 (don't fabricate).
      const neat = appleStale ? 0 : Math.max(0, haeActive - workoutActive);
      // BMR fallback (v1.8.10/.11): when basal_energy_kcal is null (HAE
      // doesn't always export it), estimate via Mifflin-St Jeor using
      // user_profile (set by user) + last-resort defaults.
      let basal = r.basal_energy_kcal != null ? Number(r.basal_energy_kcal) : null;
      let basalSource = basal != null ? 'apple_health' : null;
      if (basal == null) {
        const estimate = await bmrForDate(weightKg, date);
        if (estimate != null) {
          basal = estimate;
          basalSource = 'bmr_estimated';
        }
      }
      const out = active + (basal || 0);
      const meal = mealMap.get(date) || { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
      const plan = planMap.get(date);
      // v1.8.13: training day if ANY of:
      //   - effort >= 5 (legacy heuristic, hard sessions)
      //   - workout exists for the day at all (catches mobility days, easy
      //     runs, anything where the user moved purposefully)
      //   - completed plan_segment with logging_target in (hevy, apple_health)
      // Previously the strict effort >= 5 threshold tagged a real workout
      // day "rest" if effort wasn't logged, leading to wrong carb targets +
      // bad recovery-fueling guidance.
      const hasWorkout = (workoutCountMap.get(date) || 0) > 0;
      const hasCompletedSegment = (completedSegmentMap.get(date) || 0) > 0;
      const isHardDay = (effortMap.get(date) || 0) >= 5 || hasWorkout || hasCompletedSegment;
      const fbCalories = weightLb ? weightLb * 14 : null;
      const fbProtein = weightKg ? weightKg * 1.8 : null;
      const fbCarbs = weightKg ? weightKg * (isHardDay ? 4.0 : 2.5) : null;
      const fbFat = weightKg ? weightKg * 1.0 : null;
      return {
        date,
        is_hard_day: isHardDay,
        calories_in: Math.round(meal.kcal),
        calories_out: Math.round(out),
        // v1.8.15: per Coach spec, breakdown is workouts · NEAT · basal.
        // calories_active stays for back-compat but the meaningful split
        // is workouts (logged training) vs NEAT (everything else Apple
        // Health tracked but no workout was logged for).
        calories_active: active > 0 ? Math.round(active) : null,
        calories_workout: workoutActive > 0 ? Math.round(workoutActive) : null,
        calories_neat: Math.round(neat),
        calories_basal: basal != null ? Math.round(basal) : null,
        basal_source: basalSource,
        active_source: activeSource,
        apple_stale: appleStale,
        last_synced_at: r.updated_at || null,
        balance: Math.round(meal.kcal - out),
        protein_g: Math.round(meal.protein_g),
        carbs_g: Math.round(meal.carbs_g),
        fat_g: Math.round(meal.fat_g),
        protein_per_kg: weightKg ? round1(meal.protein_g / weightKg) : null,
        carbs_per_kg: weightKg ? round1(meal.carbs_g / weightKg) : null,
        fat_per_kg: weightKg ? round1(meal.fat_g / weightKg) : null,
        targets: {
          calories: macroBlock(meal.kcal, plan?.target_calories, fbCalories),
          protein:  macroBlock(meal.protein_g, plan?.target_protein_g, fbProtein),
          carbs:    macroBlock(meal.carbs_g, plan?.target_carbs_g, fbCarbs),
          fat:      macroBlock(meal.fat_g, plan?.target_fat_g, fbFat),
        },
      };
    }));

    // `today` follows the UI date selector when ?date= is passed. Falls back
    // to the most-recent activity row otherwise.
    let last = null;
    let yesterdayIdx = -2;
    if (targetDate) {
      const idx = history.findIndex(h => h.date === targetDate);
      if (idx >= 0) { last = history[idx]; yesterdayIdx = idx - 1; }
    }
    if (!last) {
      last = history[history.length - 1] || null;
      yesterdayIdx = history.length - 2;
    }
    const week = history.slice(-7);
    const weekly_avg = week.length ? {
      calories_in: Math.round(mean(week.map(d => d.calories_in))),
      calories_out: Math.round(mean(week.map(d => d.calories_out))),
      balance: Math.round(mean(week.map(d => d.balance))),
      protein_g: Math.round(mean(week.map(d => d.protein_g))),
      carbs_g: Math.round(mean(week.map(d => d.carbs_g))),
      fat_g: Math.round(mean(week.map(d => d.fat_g))),
      protein_per_kg: weightKg ? round1(mean(week.map(d => d.protein_g)) / weightKg) : null,
      carbs_per_kg: weightKg ? round1(mean(week.map(d => d.carbs_g)) / weightKg) : null,
      fat_per_kg: weightKg ? round1(mean(week.map(d => d.fat_g)) / weightKg) : null,
    } : null;

    // ─── Rule C: rest-day underfueling (provenance: docs/coaching-rules.md) ──
    // If yesterday was a rest day (no workout OR max effort < 5) AND
    // protein < 130g, flag underfueling. Tissue repair happens on rest days;
    // the athlete's data showed rest-day protein at 106g vs hard-day 138g —
    // consistent recovery gap. "Yesterday" is relative to the displayed day,
    // so navigating back in time still surfaces meaningful context.
    const yesterday = (yesterdayIdx >= 0 ? history[yesterdayIdx] : null) || null;
    let rest_day_flag = null;
    if (yesterday) {
      const wo = await query(
        `SELECT MAX(effort) AS max_effort, COUNT(*)::int AS n FROM workouts
         WHERE workout_date = $1`,
        [yesterday.date]
      );
      const maxEffort = wo.rows[0]?.max_effort != null ? Number(wo.rows[0].max_effort) : 0;
      const isRestDay = wo.rows[0]?.n === 0 || maxEffort < 5;
      if (isRestDay && yesterday.protein_g < 130) {
        rest_day_flag = {
          date: yesterday.date,
          protein_g: yesterday.protein_g,
          target_g: 130,
          deficit_g: 130 - yesterday.protein_g,
          message: `Rest day yesterday — protein at ${yesterday.protein_g}g, target 130g+ for tissue repair. ${130 - yesterday.protein_g}g short.`,
        };
      }
    }

    res.json({
      today: last,
      weekly_avg,
      weight_kg: weightKg ? round1(weightKg) : null,
      rest_day_flag,
      history,
    });
  } catch (err) {
    console.error(`[insights/nutrition] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/health/insights/recompute-tss — backfill workouts.tss ────
// Idempotent. Uses HR-based hrTSS when avg_HR + athlete_zones available,
// else effort-based fallback.

router.post('/recompute-tss', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, workout_date, time_duration, heart_rate_avg, effort, tss
       FROM workouts ORDER BY workout_date ASC`
    );
    const dateZones = new Map();
    let updated = 0;
    for (const wo of r.rows) {
      if (!dateZones.has(wo.workout_date)) {
        dateZones.set(wo.workout_date, await getZonesForDate(wo.workout_date));
      }
      const tss = computeTSS(wo, dateZones.get(wo.workout_date));
      if (tss != null && tss !== wo.tss) {
        await query(`UPDATE workouts SET tss = $1 WHERE id = $2`, [tss, wo.id]);
        updated++;
      }
    }
    res.json({ updated, total: r.rows.length });
  } catch (err) {
    console.error(`[insights/recompute-tss] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

function round1(n) {
  if (n == null) return null;
  return Math.round(n * 10) / 10;
}

// ─── Trends helpers ────────────────────────────────────────────
// Apple Trends-style direction flag. Compute medium-window mean
// (last 30 days) and long-window mean (the prior 60 days, days 31-90).
// Flag direction when |medium - long| > 0.5 × stddev_long.

function trendDirection(values30, values60Prior) {
  const m = values30.length ? mean(values30) : null;
  const l = values60Prior.length ? mean(values60Prior) : null;
  const sd = values60Prior.length >= 7 ? stddev(values60Prior) : null;
  if (m == null || l == null || sd == null || sd === 0) {
    return { direction: 'stable', medium: m, long: l, delta: m != null && l != null ? round1(m - l) : null };
  }
  const delta = m - l;
  if (Math.abs(delta) <= 0.5 * sd) return { direction: 'stable', medium: round1(m), long: round1(l), delta: round1(delta) };
  return { direction: delta > 0 ? 'up' : 'down', medium: round1(m), long: round1(l), delta: round1(delta) };
}

// Group an array of {date, value} rows into the last 30 vs prior 60 windows.
function splitWindows(rows, key, today) {
  const m30 = [];   // last 30 days (current)
  const l60 = [];   // days 31-90 (prior)
  const todayMs = new Date(today + 'T12:00:00').getTime();
  for (const r of rows) {
    const v = r[key];
    if (v == null) continue;
    const dStr = dateOnly(r.activity_date || r.date || r.measurement_date);
    if (!dStr) continue;
    const ageDays = Math.round((todayMs - new Date(dStr + 'T12:00:00').getTime()) / 86400_000);
    if (ageDays < 0) continue;
    if (ageDays < 30) m30.push(Number(v));
    else if (ageDays < 90) l60.push(Number(v));
  }
  return { m30, l60 };
}

// Sleep debt: rolling deficit clamped to ≥0 per night (no banking surplus).
// Returns total deficit in minutes over the last `windowDays` nights.
function sleepDebtMin(rows, target, windowDays) {
  let debt = 0;
  let nights = 0;
  for (const r of rows.slice(-windowDays)) {
    if (r.sleep_total_min == null) continue;
    const deficit = target - Number(r.sleep_total_min);
    if (deficit > 0) debt += deficit;
    nights++;
  }
  return { debt_min: Math.round(debt), nights, target_min: target };
}

// Sleep Score (Apple-style 0-100 composite):
// - Duration (50 pts): linear 0 at <5h to 50 at 7h+
// - Quality (30 pts): based on Deep+REM percentage (target 35%+)
// - Consistency (20 pts): bedtime variance over last 14 nights (lower=better)
function sleepScore(lastNight, last14Bedtimes) {
  if (!lastNight || lastNight.total_min == null) return null;
  const dur = Number(lastNight.total_min);
  let durationPts = 0;
  if (dur >= 420) durationPts = 50;
  else if (dur <= 300) durationPts = 0;
  else durationPts = Math.round(((dur - 300) / 120) * 50);

  let qualityPts = 0;
  if (lastNight.deep_min != null && lastNight.rem_min != null && dur > 0) {
    const pct = (Number(lastNight.deep_min) + Number(lastNight.rem_min)) / dur;
    qualityPts = Math.min(30, Math.round(pct / 0.35 * 30));
  }

  // Consistency: stddev of bedtime in minutes-from-midnight; <30min → 20pts,
  // 30-60min → 10pts, >60min → 0pts. last14Bedtimes is array of minutes.
  let consistencyPts = 0;
  if (last14Bedtimes.length >= 5) {
    const sd = stddev(last14Bedtimes);
    if (sd != null) {
      if (sd < 30) consistencyPts = 20;
      else if (sd < 60) consistencyPts = 10;
      else consistencyPts = 0;
    }
  }

  return {
    score: durationPts + qualityPts + consistencyPts,
    duration_pts: durationPts,
    quality_pts: qualityPts,
    consistency_pts: consistencyPts,
  };
}

// Build a fresh-daily history array, capped to 90 entries.
function dailyHistory(rows, fields, days = 90) {
  return rows.slice(-days).map(r => {
    const out = { date: dateOnly(r.activity_date || r.date || r.measurement_date) };
    for (const f of fields) out[f] = r[f] != null ? Number(r[f]) : null;
    return out;
  });
}

// ─── GET /api/health/insights/trends ───────────────────────────
// Single aggregator that powers the Trends sub-tab AND the Coach. Returns
// nested sleep/nutrition/training/body/vitals sections, each with current,
// target (from user_targets, falling back to defaults), direction, history.

router.get('/trends', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const start180 = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
    const start90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
    const start30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const start7 = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

    // Targets — single fetch, indexed by metric
    const targetsRes = await query(
      `SELECT metric, target_value, target_value_max, comparison, set_by FROM user_targets
       WHERE effective_to IS NULL OR effective_to >= CURRENT_DATE`
    );
    const targets = {};
    for (const t of targetsRes.rows) {
      targets[t.metric] = {
        value: t.target_value != null ? Number(t.target_value) : null,
        value_max: t.target_value_max != null ? Number(t.target_value_max) : null,
        comparison: t.comparison,
        source: t.set_by === 'user' ? 'user' : 'default',
      };
    }
    const tget = (m, fallback) => targets[m] || { value: fallback, source: 'default' };

    // ─── daily_activity (90 days for sleep/vitals/calories) ──────
    const da = await query(
      `SELECT activity_date, hrv_sdnn_ms, resting_hr_bpm, vo2_max,
              walking_speed_mph, walking_asymmetry_pct, walking_step_length_in,
              sleep_total_min, sleep_deep_min, sleep_rem_min,
              sleep_core_min, sleep_awake_min, sleep_efficiency_pct,
              sleep_in_bed_start, sleep_in_bed_end,
              active_energy_kcal, basal_energy_kcal, updated_at
         FROM daily_activity
         WHERE activity_date >= $1
         ORDER BY activity_date ASC`,
      [start90]
    );
    const daRows = da.rows;

    // ─── meals (90 days) ─────────────────────────────────────────
    const mealsRes = await query(
      `SELECT meal_date,
              COALESCE(SUM(calories), 0) AS kcal,
              COALESCE(SUM(protein_g), 0) AS protein,
              COALESCE(SUM(carbs_g), 0) AS carbs,
              COALESCE(SUM(fat_g), 0) AS fat
         FROM meals WHERE meal_date >= $1
         GROUP BY meal_date ORDER BY meal_date ASC`,
      [start90]
    );

    // ─── workouts (90 days) ──────────────────────────────────────
    const woRes = await query(
      `SELECT workout_date, time_duration, distance, effort, tss, hr_zones
         FROM workouts WHERE workout_date >= $1
         ORDER BY workout_date ASC`,
      [start90]
    );

    // ─── body_metrics (180 days, weekly cadence) ─────────────────
    const bmRes = await query(
      `SELECT measurement_date, weight_lb, body_fat_pct, lean_mass_lb, bmi
         FROM body_metrics WHERE measurement_date >= $1
         ORDER BY measurement_date ASC`,
      [start180]
    );
    const bmRows = bmRes.rows;

    // ═══ SLEEP ═══════════════════════════════════════════════════
    const sleepRows = daRows.filter(r => r.sleep_total_min != null);
    const lastNight = sleepRows[sleepRows.length - 1] || null;
    const sleepTarget = tget('sleep_duration_min', 480);

    const sleepWindows = splitWindows(daRows, 'sleep_total_min', today);
    const sleepDir = trendDirection(sleepWindows.m30, sleepWindows.l60);

    // Bedtime regularity over the last 14 nights — minutes from midnight
    // (24:00 = 0, so 23:30 → 1410, 00:30 → 30). Wraps cleanly because
    // stddev cares about variance, not absolute scale, and we store the
    // raw minute-of-day. Coach uses the stddev: <30min = consistent,
    // 30-60min = variable, >60min = chaotic.
    const last14Bedtimes = sleepRows.slice(-14)
      .map(r => r.sleep_in_bed_start)
      .filter(Boolean)
      .map(t => {
        const d = new Date(t);
        if (isNaN(d.getTime())) return null;
        return d.getHours() * 60 + d.getMinutes();
      })
      .filter(v => v != null);

    const lastNightForScore = lastNight ? {
      total_min: Number(lastNight.sleep_total_min),
      deep_min: lastNight.sleep_deep_min != null ? Number(lastNight.sleep_deep_min) : null,
      rem_min: lastNight.sleep_rem_min != null ? Number(lastNight.sleep_rem_min) : null,
    } : null;

    const sleep = {
      current: lastNight ? {
        date: dateOnly(lastNight.activity_date),
        duration_min: Number(lastNight.sleep_total_min),
        deep_min: lastNight.sleep_deep_min != null ? Number(lastNight.sleep_deep_min) : null,
        rem_min: lastNight.sleep_rem_min != null ? Number(lastNight.sleep_rem_min) : null,
        awake_min: lastNight.sleep_awake_min != null ? Number(lastNight.sleep_awake_min) : null,
        efficiency_pct: lastNight.sleep_efficiency_pct != null ? Number(lastNight.sleep_efficiency_pct) : null,
      } : null,
      target: sleepTarget,
      score: sleepScore(lastNightForScore, last14Bedtimes),
      trend: sleepDir,
      debt: {
        rolling_7d: sleepDebtMin(daRows, sleepTarget.value || 480, 7),
        rolling_14d: sleepDebtMin(daRows, sleepTarget.value || 480, 14),
        rolling_30d: sleepDebtMin(daRows, sleepTarget.value || 480, 30),
      },
      regularity: {
        bedtime_stddev_min: last14Bedtimes.length >= 5 ? round1(stddev(last14Bedtimes)) : null,
        sample_size: last14Bedtimes.length,
      },
      history: dailyHistory(daRows, ['sleep_total_min', 'sleep_deep_min', 'sleep_rem_min', 'sleep_awake_min', 'sleep_core_min'], 90),
    };

    // ═══ NUTRITION ═══════════════════════════════════════════════
    const todayMeal = mealsRes.rows.find(m => dateOnly(m.meal_date) === today) || {};
    const calBurnByDate = new Map();
    // Per-day breakdown so the UI can surface "active X · basal Y" and
    // the user can tell at a glance whether basal_energy_kcal is null
    // (HAE export config issue) or just the day is incomplete.
    //
    // BMR fallback (v1.8.10): if basal_energy_kcal is null, estimate
    // via Mifflin-St Jeor using latest weight. HAE's daily payload
    // often omits basal entirely; without this fallback OUT looked
    // ~1500-2000 kcal too low every day.
    // v1.8.13 fix: query latest weight here too — earlier I assumed
    // weightKg was in scope from /nutrition handler, but /trends has
    // its own scope. Result was "weightKg is not defined" runtime
    // error every time the Trends tab loaded.
    const weightR = await query(
      `SELECT weight_lb FROM body_metrics WHERE weight_lb IS NOT NULL
       ORDER BY measurement_date DESC LIMIT 1`
    );
    const weightLbForBmr = weightR.rows[0]?.weight_lb ? Number(weightR.rows[0].weight_lb) : null;
    const weightKg = weightLbForBmr ? weightLbForBmr / 2.2046226218 : null;
    // v1.8.22: per-date workout active sum so the staleness floor also
    // applies on past days (was today-only — past days couldn't trigger
    // the apple_stale rescue even when daily_activity was clearly under
    // the workouts logged on that date).
    const workoutActiveByDateR = await query(
      `SELECT workout_date, SUM(COALESCE(
        cal_active,
        NULLIF(REGEXP_REPLACE(COALESCE(active_calories, ''), '[^0-9.]', '', 'g'), '')::numeric,
        0
      )) AS active_kcal
       FROM workouts WHERE deleted_at IS NULL
       GROUP BY workout_date`
    );
    const workoutActiveByDate = new Map();
    for (const row of workoutActiveByDateR.rows) {
      const d = dateOnly(row.workout_date);
      const k = Math.round(Number(row.active_kcal) || 0);
      if (k > 0) workoutActiveByDate.set(d, k);
    }

    const calBreakdownByDate = new Map();
    for (const r of daRows) {
      const dateKey = dateOnly(r.activity_date);
      const haeActive = Number(r.active_energy_kcal) || 0;
      const workoutActive = workoutActiveByDate.get(dateKey) || 0;
      // v1.8.22: staleness rescue (matches /insights/nutrition logic).
      // workouts are a strict subset of daily active; if workout sum
      // exceeds Apple's daily active, HAE hasn't pushed today's full
      // export yet — floor active at workout sum and tag apple_stale.
      const appleStale = workoutActive > haeActive;
      const active = appleStale ? workoutActive : haeActive;
      const neat = appleStale ? 0 : Math.max(0, haeActive - workoutActive);
      let basal = r.basal_energy_kcal != null ? Number(r.basal_energy_kcal) : null;
      let basalSource = basal != null ? 'apple_health' : null;
      if (basal == null) {
        const estimate = await bmrForDate(weightKg, dateKey);
        if (estimate != null) {
          basal = estimate;
          basalSource = 'bmr_estimated';
        }
      }
      const out = active + (basal || 0);
      if (out > 0) calBurnByDate.set(dateKey, out);
      calBreakdownByDate.set(dateKey, {
        active: active > 0 ? Math.round(active) : null,
        workout: workoutActive > 0 ? Math.round(workoutActive) : null,
        neat: Math.round(neat),
        active_source: appleStale
          ? 'workouts_floor_stale_apple'
          : (active > 0 ? 'apple_health' : null),
        apple_stale: appleStale,
        basal: basal != null ? Math.round(basal) : null,
        basal_source: basalSource,
        last_synced_at: r.updated_at || null,
      });
    }
    // Special case: if `today` has NO daily_activity row at all (HAE
    // hasn't synced yet today, which is permanent now post-retirement),
    // inject a BMR-only estimate. Don't include workout active here —
    // that would imply we know total active, which we don't until HAE
    // pushes the daily summary (it never will). Workout subtotal only
    // surfaces if we logged a workout today.
    if (!calBreakdownByDate.has(today)) {
      const todayWorkoutActive = workoutActiveByDate.get(today) || 0;
      const estimate = await bmrForDate(weightKg, today);
      if (estimate != null && estimate > 0) {
        calBurnByDate.set(today, estimate);
        calBreakdownByDate.set(today, {
          active: null,
          workout: todayWorkoutActive > 0 ? todayWorkoutActive : null,
          neat: null,
          active_source: null,
          basal: estimate,
          basal_source: 'bmr_estimated',
          last_synced_at: null,
        });
      }
    }
    const calsTarget = tget('calories_kcal', 2600);
    const proteinTarget = tget('protein_g', 138);

    // 7d / 30d deficits
    function rollingNutrition(days) {
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      const recent = mealsRes.rows.filter(m => dateOnly(m.meal_date) >= cutoff);
      const totalIn = recent.reduce((s, m) => s + Number(m.kcal), 0);
      const totalOut = recent.reduce((s, m) => s + (calBurnByDate.get(dateOnly(m.meal_date)) || 0), 0);
      const totalProtein = recent.reduce((s, m) => s + Number(m.protein), 0);
      const proteinShortfall = recent.reduce((s, m) => s + Math.max(0, (proteinTarget.value || 138) - Number(m.protein)), 0);
      return {
        days_with_data: recent.length,
        kcal_in: Math.round(totalIn),
        kcal_out: Math.round(totalOut),
        kcal_balance: Math.round(totalIn - totalOut),
        protein_g: Math.round(totalProtein),
        protein_shortfall_g: Math.round(proteinShortfall),
      };
    }

    const proteinSeries = mealsRes.rows.map(m => Number(m.protein)).filter(v => v != null);
    const protein30 = proteinSeries.slice(-30);
    const protein60Prior = proteinSeries.slice(-90, -30);

    const todayBreakdown = calBreakdownByDate.get(today) || { active: null, workout: null, neat: null, active_source: null, basal: null, basal_source: null, last_synced_at: null };
    const nutrition = {
      today: {
        calories_in: Math.round(Number(todayMeal.kcal) || 0),
        calories_out: Math.round(calBurnByDate.get(today) || 0),
        // v1.8.9: surface the breakdown so the UI can show
        // "OUT 3275 (active 1526 · basal 1749)" or warn when basal is null.
        // v1.8.10: basal_source = 'apple_health' | 'bmr_estimated' | null
        // so the UI can distinguish HAE-supplied basal from our
        // Mifflin-St Jeor fallback.
        calories_active: todayBreakdown.active,
        calories_workout: todayBreakdown.workout,
        calories_neat: todayBreakdown.neat,
        calories_basal: todayBreakdown.basal,
        basal_source: todayBreakdown.basal_source,
        active_source: todayBreakdown.active_source,
        apple_stale: todayBreakdown.apple_stale || false,
        last_synced_at: todayBreakdown.last_synced_at,
        balance: Math.round((Number(todayMeal.kcal) || 0) - (calBurnByDate.get(today) || 0)),
        protein_g: Math.round(Number(todayMeal.protein) || 0),
        carbs_g: Math.round(Number(todayMeal.carbs) || 0),
        fat_g: Math.round(Number(todayMeal.fat) || 0),
      },
      targets: {
        calories: calsTarget,
        protein: proteinTarget,
        carbs: tget('carbs_g', 280),
        fat: tget('fat_g', 80),
      },
      rolling: { d7: rollingNutrition(7), d30: rollingNutrition(30) },
      protein_trend: trendDirection(protein30, protein60Prior),
      history: mealsRes.rows.map(m => ({
        date: dateOnly(m.meal_date),
        kcal: Math.round(Number(m.kcal)),
        protein_g: Math.round(Number(m.protein)),
        carbs_g: Math.round(Number(m.carbs)),
        fat_g: Math.round(Number(m.fat)),
        kcal_out: Math.round(calBurnByDate.get(dateOnly(m.meal_date)) || 0),
      })),
    };

    // ═══ TRAINING ═══════════════════════════════════════════════
    // ATL/CTL/TSB on the 90-day daily TSS series
    const dailyTssMap = new Map();
    for (const w of woRes.rows) {
      const d = dateOnly(w.workout_date);
      if (!d) continue;
      dailyTssMap.set(d, (dailyTssMap.get(d) || 0) + (Number(w.tss) || 0));
    }
    const startMs = new Date(start90 + 'T12:00:00').getTime();
    const todayMs = new Date(today + 'T12:00:00').getTime();
    const dailyTss = [];
    for (let ms = startMs; ms <= todayMs; ms += 86400_000) {
      const d = new Date(ms).toISOString().slice(0, 10);
      dailyTss.push(dailyTssMap.get(d) || 0);
    }
    const atlSeries = ewma(dailyTss, 7);
    const ctlSeries = ewma(dailyTss, 42);
    const todayATL = atlSeries[atlSeries.length - 1] || 0;
    const todayCTL = ctlSeries[ctlSeries.length - 1] || 0;
    const todayTSB = todayCTL - todayATL;

    let weeklyTss = 0, weeklyZ2 = 0, weeklyMiles = 0, weeklyHours = 0, weeklyWorkouts = 0;
    let weeklyZ1 = 0, weeklyZ3 = 0, weeklyZ4 = 0, weeklyZ5 = 0, weeklyZ_total = 0;
    let weeklyZonesCovered = 0;
    for (const w of woRes.rows) {
      if (dateOnly(w.workout_date) < start7) continue;
      weeklyWorkouts++;
      weeklyTss += Number(w.tss) || 0;
      weeklyMiles += Number(w.distance) || 0;
      const sec = durationToSeconds(w.time_duration);
      weeklyHours += sec / 3600;
      if (w.hr_zones && typeof w.hr_zones === 'object') {
        weeklyZonesCovered++;
        const z = w.hr_zones;
        const z1 = Number(z.z1 || z.Z1 || 0);
        const z2 = Number(z.z2 || z.Z2 || 0);
        const z3 = Number(z.z3 || z.Z3 || 0);
        const z4 = Number(z.z4 || z.Z4 || 0);
        const z5 = Number(z.z5 || z.Z5 || 0);
        weeklyZ1 += z1; weeklyZ2 += z2; weeklyZ3 += z3; weeklyZ4 += z4; weeklyZ5 += z5;
        weeklyZ_total += z1 + z2 + z3 + z4 + z5;
      }
    }

    const tssDaily30 = dailyTss.slice(-30);
    const tssDaily60Prior = dailyTss.slice(-90, -30);

    // ACWR (acute:chronic workload ratio) — Foster/Gabbett. 7d EWMA / 28d
    // EWMA. Sweet spot 0.8–1.3; <0.8 detraining, >1.5 spike injury risk.
    const acuteTss = atlSeries[atlSeries.length - 1] || 0;
    const chronic28 = ewma(dailyTss, 28);
    const chronicTss = chronic28[chronic28.length - 1] || 0;
    const acwr = chronicTss > 0 ? acuteTss / chronicTss : null;

    // Monotony & strain (Foster) over the last 7 days. Monotony =
    // mean / stddev. Strain = monotony * weekly load. Monotony > 2 with
    // high load = injury / illness window.
    const last7 = dailyTss.slice(-7);
    const meanLast7 = mean(last7);
    const sdLast7 = stddev(last7);
    // Guard against meanLast7 = 0 (all rest days) which produced 0/0 = NaN
    // and cascaded through downstream JSON serialization.
    const monotony = (sdLast7 && sdLast7 > 0 && meanLast7 != null && meanLast7 > 0) ? meanLast7 / sdLast7 : null;
    const strain = monotony != null ? monotony * last7.reduce((a, b) => a + b, 0) : null;

    // Polarization: % of weekly zone-time in low (Z1+Z2), gray (Z3),
    // high (Z4+Z5). Seiler's polarized-training thesis: 80% low, ~5%
    // gray, ~15% high. Coverage_pct flags how much of weekly load was
    // included (zones come from Format B HR samples; manual workouts
    // and Format-A-only workouts fall through with hr_zones=NULL).
    const coverage_pct = weeklyWorkouts > 0
      ? Math.round((weeklyZonesCovered / weeklyWorkouts) * 100)
      : null;
    const polarization = weeklyZ_total > 0 ? {
      low_pct:  Math.round(((weeklyZ1 + weeklyZ2) / weeklyZ_total) * 100),
      gray_pct: Math.round((weeklyZ3 / weeklyZ_total) * 100),
      high_pct: Math.round(((weeklyZ4 + weeklyZ5) / weeklyZ_total) * 100),
      total_min: Math.round(weeklyZ_total),
      coverage_pct,
    } : { low_pct: null, gray_pct: null, high_pct: null, total_min: 0, coverage_pct };

    const training = {
      current: {
        atl: round1(todayATL),
        ctl: round1(todayCTL),
        tsb: round1(todayTSB),
        acwr: acwr != null ? round1(acwr) : null,
        monotony: monotony != null ? round1(monotony) : null,
        strain: strain != null ? Math.round(strain) : null,
        weekly_tss: Math.round(weeklyTss),
        weekly_workouts: weeklyWorkouts,
        weekly_miles: round1(weeklyMiles),
        weekly_hours: round1(weeklyHours),
        weekly_z2_min: Math.round(weeklyZ2),
        weekly_zones_coverage_pct: coverage_pct,
      },
      targets: {
        weekly_z2: tget('weekly_z2_min', 180),
        weekly_workouts: tget('weekly_workouts', 5),
        weekly_tss: tget('weekly_tss', 400),
      },
      load_trend: trendDirection(tssDaily30, tssDaily60Prior),
      polarization,
      history: dailyTss.map((tss, i) => ({
        date: new Date(startMs + i * 86400_000).toISOString().slice(0, 10),
        tss: Math.round(tss),
        atl: round1(atlSeries[i]),
        ctl: round1(ctlSeries[i]),
        tsb: round1(ctlSeries[i] - atlSeries[i]),
      })),
    };

    // ═══ BODY ═══════════════════════════════════════════════════
    const latestBody = bmRows[bmRows.length - 1] || null;
    const weightSeries = bmRows.map(r => r.weight_lb != null ? Number(r.weight_lb) : null).filter(v => v != null);
    const w30 = weightSeries.slice(-30);
    const w60Prior = weightSeries.slice(-90, -30);

    const body = {
      current: latestBody ? {
        date: dateOnly(latestBody.measurement_date),
        weight_lb: latestBody.weight_lb != null ? Number(latestBody.weight_lb) : null,
        body_fat_pct: latestBody.body_fat_pct != null ? Number(latestBody.body_fat_pct) : null,
        lean_mass_lb: latestBody.lean_mass_lb != null ? Number(latestBody.lean_mass_lb) : null,
        bmi: latestBody.bmi != null ? Number(latestBody.bmi) : null,
      } : null,
      targets: {
        weight_lb: tget('weight_lb', 185),
        body_fat_pct: tget('body_fat_pct', 15),
      },
      weight_trend: trendDirection(w30, w60Prior),
      history: bmRows.map(r => ({
        date: dateOnly(r.measurement_date),
        weight_lb: r.weight_lb != null ? Number(r.weight_lb) : null,
        body_fat_pct: r.body_fat_pct != null ? Number(r.body_fat_pct) : null,
        lean_mass_lb: r.lean_mass_lb != null ? Number(r.lean_mass_lb) : null,
      })).filter(r => r.weight_lb != null || r.body_fat_pct != null),
    };

    // ═══ VITALS ══════════════════════════════════════════════════
    function latest(key) {
      for (let i = daRows.length - 1; i >= 0; i--) {
        if (daRows[i][key] != null) return { value: Number(daRows[i][key]), as_of: dateOnly(daRows[i].activity_date) };
      }
      return { value: null, as_of: null };
    }
    function vitalSection(key, target30, target90) {
      const latestRec = latest(key);
      const w = splitWindows(daRows, key, today);
      return {
        today: latestRec.value,
        as_of: latestRec.as_of,
        is_stale: latestRec.as_of && latestRec.as_of !== today,
        baseline_30d: w.m30.length ? round1(mean(w.m30)) : null,
        baseline_90d: w.l60.length ? round1(mean(w.l60)) : null,
        trend: trendDirection(w.m30, w.l60),
        history: dailyHistory(daRows, [key], 90).map(r => ({ date: r.date, value: r[key] })),
      };
    }

    const vitals = {
      hrv: { ...vitalSection('hrv_sdnn_ms'), target: tget('hrv_ms', 45) },
      rhr: { ...vitalSection('resting_hr_bpm'), target: tget('resting_hr_bpm', 55) },
      vo2_max: vitalSection('vo2_max'),
      walking_speed_mph: vitalSection('walking_speed_mph'),
      walking_asymmetry_pct: vitalSection('walking_asymmetry_pct'),
    };

    // Composite alerts: chronic load + density (Rules A/B) + TSB (Rule E,
    // Avi-specific) + sleep (Rule F, Avi-specific). All fire as needed.
    const recentWorkouts = await query(
      `SELECT workout_date, effort FROM workouts
        WHERE workout_date >= CURRENT_DATE - INTERVAL '14 days'
          AND effort IS NOT NULL`
    );
    // dailyTss is already in scope from the training section above; reuse
    // for inline TSB rather than re-querying.
    const trendsTodayTSB = todayCTL - todayATL;
    const alerts = [
      ...chronicLoadAlerts(recentWorkouts.rows),
      ...consecutiveHardDayAlerts(recentWorkouts.rows),
      ...tsbAlerts(trendsTodayTSB),
      ...sleepAlerts(daRows),
    ];

    res.json({
      generated_at: new Date().toISOString(),
      windows: { short: 7, medium: 30, long: 90 },
      sleep,
      nutrition,
      training,
      body,
      vitals,
      alerts,
    });
  } catch (err) {
    console.error(`[insights/trends] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/insights/morning ─────────────────────────
// Single morning brief — bundles readiness + active injuries + today's
// plan + upcoming race + current training block. The morning-check-in
// Skill calls this first, then asks the user 3-4 subjective questions,
// then POSTs daily_context. Replaces 4 separate Coach calls.
router.get('/morning', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Today's readiness — reuse the same logic as /today.
    // FULL OUTER JOIN: cache values win on overlap; daily_activity fills
    // historical baselines. Sleep stages live only in daily_activity
    // post-v1.9.4 (cache columns dropped).
    const lookback = 30;
    const startDate = new Date(Date.now() - lookback * 86400_000).toISOString().slice(0, 10);
    const da = await query(
      `SELECT
         COALESCE(c.date, da.activity_date)              AS activity_date,
         COALESCE(c.hrv_ms, da.hrv_sdnn_ms)              AS hrv_sdnn_ms,
         COALESCE(c.rhr_bpm, da.resting_hr_bpm)          AS resting_hr_bpm,
         COALESCE(c.sleep_total_min, da.sleep_total_min) AS sleep_total_min,
         da.sleep_deep_min,
         da.sleep_rem_min,
         da.sleep_efficiency_pct,
         c.respiratory_rate_bpm
       FROM daily_vitals_cache c
       FULL OUTER JOIN daily_activity da ON c.date = da.activity_date
       WHERE COALESCE(c.date, da.activity_date) >= $1
       ORDER BY activity_date ASC`,
      [startDate]
    );
    const rows = da.rows;
    const hrvVals = lastN(rows, lookback, 'hrv_sdnn_ms');
    const rhrVals = lastN(rows, lookback, 'resting_hr_bpm');
    const hrvBase = mean(hrvVals);
    const rhrBase = mean(rhrVals);
    const hrvSd = stddev(hrvVals);
    const rhrSd = stddev(rhrVals);
    function latest(field) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][field] != null) return { value: Number(rows[i][field]), as_of: dateOnly(rows[i].activity_date) };
      }
      return { value: null, as_of: null };
    }
    const hrvL = latest('hrv_sdnn_ms');
    const rhrL = latest('resting_hr_bpm');
    const sleepL = latest('sleep_total_min');
    const respL = latest('respiratory_rate_bpm');
    const hrvDevSd = (hrvL.value != null && hrvBase != null && hrvSd) ? (hrvL.value - hrvBase) / hrvSd : null;
    const rhrDevSd = (rhrL.value != null && rhrBase != null && rhrSd) ? (rhrL.value - rhrBase) / rhrSd : null;

    // Coaching alerts
    const recentWorkouts = await query(
      `SELECT workout_date, effort FROM workouts
        WHERE workout_date >= CURRENT_DATE - INTERVAL '14 days'
          AND effort IS NOT NULL`
    );
    const todayTSB = await computeTodayTSB();
    const alerts = [
      ...chronicLoadAlerts(recentWorkouts.rows),
      ...consecutiveHardDayAlerts(recentWorkouts.rows),
      ...tsbAlerts(todayTSB),
      ...sleepAlerts(rows),
    ];

    // Active injuries
    const inj = await query(
      `SELECT id, title, body_area, severity, status, modifications
         FROM injuries
        WHERE status IN ('active','monitoring','recovering')
        ORDER BY severity DESC NULLS LAST LIMIT 10`
    ).catch(() => ({ rows: [] }));

    // Today's plan
    const plan = await query(
      `SELECT * FROM daily_plans WHERE plan_date = $1`, [today]
    ).catch(() => ({ rows: [] }));

    // Yesterday's daily_context (what subjective fields are already filled)
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const ctxRes = await query(
      `SELECT * FROM daily_context WHERE date IN ($1, $2) ORDER BY date DESC`,
      [today, yesterday]
    ).catch(() => ({ rows: [] }));
    const todayCtx = ctxRes.rows.find(r => dateOnly(r.date) === today) || null;
    const yesterdayCtx = ctxRes.rows.find(r => dateOnly(r.date) === yesterday) || null;

    // Upcoming race
    const upcoming = await query(
      `SELECT id, race_date, name, discipline, priority,
              (race_date - CURRENT_DATE) AS days_to_race
         FROM races
        WHERE status = 'scheduled' AND race_date >= CURRENT_DATE
        ORDER BY race_date ASC LIMIT 1`
    ).catch(() => ({ rows: [] }));

    // Current training block
    const block = await query(
      `SELECT b.*, r.name AS target_race_name
         FROM training_blocks b
         LEFT JOIN races r ON r.id = b.target_race_id
        WHERE b.start_date <= CURRENT_DATE AND b.end_date >= CURRENT_DATE
        ORDER BY b.start_date DESC LIMIT 1`
    ).catch(() => ({ rows: [] }));

    // If today has a plan, attach its segments + per-segment status so
    // the morning-check-in skill knows what's planned for Hevy vs Apple
    // vs manual, and can flag any segments stuck in 'planned' from
    // yesterday.
    let todayPlan = plan.rows[0] || null;
    if (todayPlan) {
      const segR = await query(
        `SELECT ps.*, COALESCE(
           (SELECT json_agg(w.* ORDER BY w.started_at NULLS LAST, w.created_at)
            FROM workouts w WHERE w.plan_segment_id = ps.id), '[]'::json
         ) AS workouts
         FROM plan_segments ps
         WHERE ps.daily_plan_id = $1
         ORDER BY ps.block_order`,
        [todayPlan.id]
      ).catch(() => ({ rows: [] }));
      todayPlan.segments = segR.rows;
    }

    res.json({
      generated_at: new Date().toISOString(),
      date: today,
      readiness: {
        hrv: { value: hrvL.value, as_of: hrvL.as_of, deviation_sd: hrvDevSd != null ? round1(hrvDevSd) : null, baseline: hrvBase ? round1(hrvBase) : null },
        rhr: { value: rhrL.value, as_of: rhrL.as_of, deviation_sd: rhrDevSd != null ? round1(rhrDevSd) : null, baseline: rhrBase ? round1(rhrBase) : null },
        sleep: { total_min: sleepL.value, as_of: sleepL.as_of },
        respiratory_rate: { value: respL.value != null ? round1(respL.value) : null, as_of: respL.as_of },
      },
      alerts,
      active_injuries: inj.rows,
      today_plan: todayPlan,
      today_context: todayCtx,
      yesterday_context: yesterdayCtx,
      upcoming_race: upcoming.rows[0] || null,
      current_block: block.rows[0] || null,
      // Coach prompts: which subjective fields are missing for today.
      // Skill iterates these and asks the user.
      missing_subjective: ['mood','motivation','soreness_overall','life_stress','illness_flag']
        .filter(k => !todayCtx || todayCtx[k] == null),
    });
  } catch (err) {
    console.error(`[insights/morning] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/insights/race?race_id= ───────────────────
// Race-context bundle for race-week-protocol Skill: countdown, taper
// guidance, recent fueling rehearsals, last 4 weeks of build-summary,
// gear+fueling text from the race row.
router.get('/race', async (req, res) => {
  try {
    let race;
    if (req.query.race_id) {
      const r = await query(`SELECT * FROM races WHERE id = $1`, [req.query.race_id]);
      race = r.rows[0];
    } else {
      const r = await query(
        `SELECT * FROM races WHERE status = 'scheduled' AND race_date >= CURRENT_DATE
         ORDER BY race_date ASC LIMIT 1`
      );
      race = r.rows[0];
    }
    if (!race) return res.json({ race: null, message: 'no upcoming race' });

    const today = new Date(); today.setHours(0,0,0,0);
    const days_to_race = Math.round((new Date(race.race_date) - today) / 86400000);

    // Taper guidance: ≥21d build hard; 14-20d sharpen; 7-13d taper
    // (volume −20%/wk, intensity preserved); 1-6d race week (volume
    // −50%, opener day -3, full rest day -1).
    let taper_phase = 'build';
    let taper_recommendation = '';
    if (days_to_race < 0) { taper_phase = 'past'; taper_recommendation = 'Race complete. Run race-debrief.'; }
    else if (days_to_race === 0) { taper_phase = 'race_day'; taper_recommendation = 'Race day. Stick to fuel plan; warm up to race intensity briefly.'; }
    else if (days_to_race <= 6) { taper_phase = 'race_week'; taper_recommendation = 'Race week — volume ~50% of normal, one short opener at race pace 3 days out, full rest day day-before.'; }
    else if (days_to_race <= 13) { taper_phase = 'taper'; taper_recommendation = 'Taper — drop volume 20% week-over-week, keep intensity (race-pace touches), reinforce sleep & fueling.'; }
    else if (days_to_race <= 20) { taper_phase = 'sharpen'; taper_recommendation = 'Sharpen — race-specific intervals, reduce non-specific volume, dial fueling rehearsals.'; }
    else { taper_phase = 'build'; taper_recommendation = `Build — ${days_to_race} days out. Stay specific, train durability.`; }

    // Recent fueling rehearsals linked to this race
    const fuel = await query(
      `SELECT * FROM fueling_rehearsals
        WHERE target_race_id = $1 OR rehearsal_date >= $2
        ORDER BY rehearsal_date DESC LIMIT 5`,
      [race.id, new Date(Date.now() - 60 * 86400_000).toISOString().slice(0,10)]
    ).catch(() => ({ rows: [] }));

    // Last 4 weeks training summary
    const startBuild = new Date(Date.now() - 28 * 86400_000).toISOString().slice(0, 10);
    const buildSummary = await query(
      `SELECT
         COUNT(*)::int AS workouts,
         COALESCE(SUM(tss), 0)::int AS tss,
         COALESCE(SUM(distance), 0) AS distance,
         AVG(effort) AS avg_effort
       FROM workouts WHERE workout_date >= $1`, [startBuild]
    ).catch(() => ({ rows: [{ workouts: 0, tss: 0, distance: 0, avg_effort: null }] }));

    res.json({
      race,
      days_to_race,
      taper_phase,
      taper_recommendation,
      fueling_rehearsals: fuel.rows,
      build_summary_28d: buildSummary.rows[0],
    });
  } catch (err) {
    console.error(`[insights/race] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/insights/weekly-review?week_of=YYYY-MM-DD ──
// Structured retro for last 7 days. Skill review-week reads this then
// proposes amendments. week_of defaults to today; returns the 7-day
// window ending on that date.
router.get('/weekly-review', async (req, res) => {
  try {
    const end = req.query.week_of || new Date().toISOString().slice(0, 10);
    const start = new Date(new Date(end + 'T12:00:00').getTime() - 6 * 86400_000).toISOString().slice(0, 10);

    const wo = await query(
      `SELECT workout_date, workout_type, time_duration, distance, effort, tss, hr_zones
         FROM workouts WHERE workout_date BETWEEN $1 AND $2
         ORDER BY workout_date ASC`,
      [start, end]
    );
    const plans = await query(
      `SELECT plan_date, status, intent_type, target_effort, target_duration_min,
              workout_type, goal, rationale
         FROM daily_plans WHERE plan_date BETWEEN $1 AND $2
         ORDER BY plan_date ASC`,
      [start, end]
    );
    const da = await query(
      `SELECT activity_date, hrv_sdnn_ms, sleep_total_min, sleep_efficiency_pct
         FROM daily_activity WHERE activity_date BETWEEN $1 AND $2
         ORDER BY activity_date ASC`,
      [start, end]
    );
    const meals = await query(
      `SELECT meal_date, COALESCE(SUM(calories),0) AS kcal, COALESCE(SUM(protein_g),0) AS protein
         FROM meals WHERE meal_date BETWEEN $1 AND $2
         GROUP BY meal_date ORDER BY meal_date ASC`,
      [start, end]
    );

    // Adherence: of plans with status set, how many are completed?
    const planByDate = new Map(plans.rows.map(p => [dateOnly(p.plan_date), p]));
    const completed = plans.rows.filter(p => p.status === 'completed').length;
    const adherence_pct = plans.rows.length ? Math.round((completed / plans.rows.length) * 100) : null;

    // Time-in-zone aggregate over the week
    let z = { z1:0, z2:0, z3:0, z4:0, z5:0, total:0, covered:0 };
    let weekTss = 0, weekDist = 0, weekEffortSum = 0, weekEffortN = 0;
    for (const w of wo.rows) {
      weekTss += Number(w.tss) || 0;
      weekDist += Number(w.distance) || 0;
      if (w.effort != null) { weekEffortSum += Number(w.effort); weekEffortN++; }
      if (w.hr_zones && typeof w.hr_zones === 'object') {
        z.covered++;
        for (const k of ['z1','z2','z3','z4','z5']) {
          const v = Number(w.hr_zones[k] || w.hr_zones[k.toUpperCase()] || 0);
          z[k] += v; z.total += v;
        }
      }
    }
    const polar = z.total > 0 ? {
      low_pct: Math.round(((z.z1 + z.z2) / z.total) * 100),
      gray_pct: Math.round((z.z3 / z.total) * 100),
      high_pct: Math.round(((z.z4 + z.z5) / z.total) * 100),
      total_min: Math.round(z.total),
      coverage_pct: wo.rows.length ? Math.round((z.covered / wo.rows.length) * 100) : null,
    } : null;

    // Sleep + HRV summary
    const sleepValues = da.rows.map(r => r.sleep_total_min).filter(v => v != null);
    const hrvValues = da.rows.map(r => r.hrv_sdnn_ms).filter(v => v != null);

    // Plan-vs-actual deltas (simple per-day comparison)
    const deltas = wo.rows.map(w => {
      const p = planByDate.get(dateOnly(w.workout_date));
      return {
        date: dateOnly(w.workout_date),
        actual_effort: w.effort,
        planned_effort: p?.target_effort ?? null,
        intent_type: p?.intent_type ?? null,
        actual_min: Math.round(durationToSeconds(w.time_duration) / 60),
        planned_min: p?.target_duration_min ?? null,
      };
    });

    res.json({
      week_start: start,
      week_end: end,
      counts: { workouts: wo.rows.length, plans: plans.rows.length, meals_days: meals.rows.length },
      week_tss: Math.round(weekTss),
      week_distance: round1(weekDist),
      week_avg_effort: weekEffortN ? round1(weekEffortSum / weekEffortN) : null,
      adherence_pct,
      polarization: polar,
      sleep: {
        avg_min: sleepValues.length ? Math.round(mean(sleepValues)) : null,
        nights: sleepValues.length,
      },
      hrv: {
        avg: hrvValues.length ? round1(mean(hrvValues)) : null,
        readings: hrvValues.length,
      },
      nutrition: {
        avg_kcal: meals.rows.length ? Math.round(mean(meals.rows.map(m => Number(m.kcal)))) : null,
        avg_protein_g: meals.rows.length ? Math.round(mean(meals.rows.map(m => Number(m.protein)))) : null,
      },
      deltas,
    });
  } catch (err) {
    console.error(`[insights/weekly-review] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/health/insights/polarization?weeks=4 ────────────
// Standalone polarization breakdown over N weeks (default 4). Coach
// uses this to spot drift toward gray-zone (Z3) which is the classic
// over-trained-yet-undertrained pattern.
router.get('/polarization', async (req, res) => {
  try {
    const weeks = Math.max(1, Math.min(12, Number(req.query.weeks) || 4));
    const start = new Date(Date.now() - weeks * 7 * 86400_000).toISOString().slice(0, 10);
    const wo = await query(
      `SELECT workout_date, hr_zones FROM workouts
        WHERE workout_date >= $1
        ORDER BY workout_date ASC`,
      [start]
    );
    const buckets = new Map();
    let totalCovered = 0, totalWorkouts = 0;
    for (const w of wo.rows) {
      totalWorkouts++;
      const wk = isoWeek(dateOnly(w.workout_date));
      if (!buckets.has(wk)) buckets.set(wk, { z1:0, z2:0, z3:0, z4:0, z5:0, covered:0, total:0 });
      const b = buckets.get(wk);
      b.total++;
      if (w.hr_zones && typeof w.hr_zones === 'object') {
        b.covered++;
        totalCovered++;
        for (const k of ['z1','z2','z3','z4','z5']) {
          b[k] += Number(w.hr_zones[k] || w.hr_zones[k.toUpperCase()] || 0);
        }
      }
    }
    const series = [];
    for (const [wk, b] of buckets) {
      const tot = b.z1 + b.z2 + b.z3 + b.z4 + b.z5;
      series.push({
        iso_week: wk,
        low_pct: tot > 0 ? Math.round(((b.z1 + b.z2) / tot) * 100) : null,
        gray_pct: tot > 0 ? Math.round((b.z3 / tot) * 100) : null,
        high_pct: tot > 0 ? Math.round(((b.z4 + b.z5) / tot) * 100) : null,
        total_min: Math.round(tot),
        coverage_pct: b.total ? Math.round((b.covered / b.total) * 100) : null,
      });
    }
    res.json({
      weeks,
      coverage_pct: totalWorkouts ? Math.round((totalCovered / totalWorkouts) * 100) : null,
      series,
    });
  } catch (err) {
    console.error(`[insights/polarization] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ISO-week label for a YYYY-MM-DD date (e.g. "2026-W18"). Used to bucket
// workouts into polarization rows.
function isoWeek(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00');
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  const wk = 1 + Math.ceil((firstThursday - target) / 604800000);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

module.exports = router;
module.exports.computeTSS = computeTSS;
module.exports.durationToSeconds = durationToSeconds;
