// Athlete-focused insights: recovery score, training load (ATL/CTL/TSB),
// body composition trends, nutrition balance. Reads from existing tables;
// no new schema beyond a `tss` column on workouts.

const express = require('express');
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
  if (trailing >= 3) {
    return [{
      severity: 'high', type: 'density',
      reason: `${trailing} consecutive hard days (effort ≥ 7) — forced rest day required`,
    }];
  }
  return [];
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

    const r = await query(
      `SELECT activity_date, hrv_sdnn_ms, resting_hr_bpm,
              sleep_total_min, sleep_deep_min, sleep_rem_min,
              sleep_core_min, sleep_awake_min, sleep_efficiency_pct,
              active_energy_kcal, basal_energy_kcal
       FROM daily_activity
       WHERE activity_date >= $1
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

    // ─── Coaching rules: load + density alerts (override recommendation) ──
    const recentWorkouts = await query(
      `SELECT workout_date, effort FROM workouts
       WHERE workout_date >= CURRENT_DATE - INTERVAL '14 days'
         AND effort IS NOT NULL
       ORDER BY workout_date ASC`
    );
    const alerts = [
      ...chronicLoadAlerts(recentWorkouts.rows),
      ...consecutiveHardDayAlerts(recentWorkouts.rows),
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
    const startDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

    const w = await query(
      `SELECT id, workout_date, started_at, workout_type, time_duration,
              heart_rate_avg, effort, distance, tss, hr_zones
       FROM workouts
       WHERE workout_date >= $1
       ORDER BY workout_date ASC`,
      [startDate]
    );
    const workouts = w.rows;

    // Per-workout TSS — fill missing
    const zonesRow = await getZonesForDate(new Date().toISOString().slice(0, 10));
    for (const wo of workouts) {
      if (wo.tss == null) wo.tss = computeTSS(wo, zonesRow);
    }

    // Daily TSS series
    const dailyTss = new Map();
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10);
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

    const todayATL = atl[atl.length - 1] || 0;
    const todayCTL = ctl[ctl.length - 1] || 0;
    const todayTSB = tsb[tsb.length - 1] || 0;
    const status = todayTSB > 5 ? 'fresh'
      : todayTSB > -10 ? 'neutral'
      : todayTSB > -20 ? 'fatigued'
      : 'very_fatigued';

    // Weekly summary (last 7 days)
    const weekStart = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const weekWorkouts = workouts.filter(wo => wo.workout_date >= weekStart);
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
      z2_minutes_by_week: z2MinutesByWeek(workouts, 12),
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
function z2MinutesByWeek(workouts, weeks = 12) {
  // Map each workout to its ISO-week-start (Monday)
  function isoWeekStart(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = (d.getDay() + 6) % 7; // Mon = 0
    d.setDate(d.getDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  const buckets = new Map();
  // Initialize empty buckets for the last `weeks` weeks
  const today = new Date();
  const todayDow = (today.getDay() + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - todayDow);
  for (let i = weeks - 1; i >= 0; i--) {
    const m = new Date(thisMonday);
    m.setDate(thisMonday.getDate() - i * 7);
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

    // Activity output (active + basal kcal)
    const a = await query(
      `SELECT activity_date, active_energy_kcal, basal_energy_kcal
       FROM daily_activity
       WHERE activity_date >= $1
       ORDER BY activity_date ASC`,
      [startDate]
    );

    // Nutrition input — sum all macros per day
    const m = await query(
      `SELECT meal_date,
              COALESCE(SUM(calories), 0) AS kcal,
              COALESCE(SUM(protein_g), 0) AS protein_g,
              COALESCE(SUM(carbs_g), 0) AS carbs_g,
              COALESCE(SUM(fat_g), 0) AS fat_g,
              COALESCE(SUM(fiber_g), 0) AS fiber_g
       FROM meals
       WHERE meal_date >= $1
       GROUP BY meal_date
       ORDER BY meal_date ASC`,
      [startDate]
    ).catch(() => ({ rows: [] }));

    const mealMap = new Map();
    for (const row of m.rows) {
      mealMap.set(row.meal_date, {
        kcal: Number(row.kcal) || 0,
        protein_g: Number(row.protein_g) || 0,
        carbs_g: Number(row.carbs_g) || 0,
        fat_g: Number(row.fat_g) || 0,
        fiber_g: Number(row.fiber_g) || 0,
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
      planMap.set(row.plan_date.toISOString ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date).slice(0, 10), row);
    }

    // Hard-day detection per date — drives carb-target swing (workout day vs rest)
    const wo = await query(
      `SELECT workout_date, MAX(effort) AS max_effort
       FROM workouts
       WHERE workout_date >= $1
       GROUP BY workout_date`,
      [startDate]
    ).catch(() => ({ rows: [] }));
    const effortMap = new Map();
    for (const row of wo.rows) effortMap.set(row.workout_date, Number(row.max_effort) || 0);

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

    const history = a.rows.map(r => {
      const date = r.activity_date;
      const out = (Number(r.active_energy_kcal) || 0) + (Number(r.basal_energy_kcal) || 0);
      const meal = mealMap.get(date) || { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
      const plan = planMap.get(date);
      const isHardDay = (effortMap.get(date) || 0) >= 5;
      const fbCalories = weightLb ? weightLb * 14 : null;
      const fbProtein = weightKg ? weightKg * 1.8 : null;
      const fbCarbs = weightKg ? weightKg * (isHardDay ? 4.0 : 2.5) : null;
      const fbFat = weightKg ? weightKg * 1.0 : null;
      return {
        date,
        is_hard_day: isHardDay,
        calories_in: Math.round(meal.kcal),
        calories_out: Math.round(out),
        balance: Math.round(meal.kcal - out),
        protein_g: Math.round(meal.protein_g),
        carbs_g: Math.round(meal.carbs_g),
        fat_g: Math.round(meal.fat_g),
        fiber_g: Math.round(meal.fiber_g),
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
    });

    const last = history[history.length - 1] || null;
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
    // consistent recovery gap.
    const yesterday = history[history.length - 2] || null;
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

module.exports = router;
module.exports.computeTSS = computeTSS;
module.exports.durationToSeconds = durationToSeconds;
