// lib/training-load.js
//
// Single source of truth for the training-load math that both the
// Training dashboard (routes/insights.js) and the Recovery panel
// (lib/recovery.js) depend on. Before this module existed, computeTSS
// and durationToSeconds lived in routes/insights.js and lib/recovery.js
// had no access to them — so the recovery panel skipped null-tss rows
// while the dashboard filled them in on-the-fly, and the two surfaces
// reported different CTL/ATL/TSB off the same data (the v3.32 bug).
//
// Everything here is pure or query-injectable. No module-level DB
// handle, so the same functions work from a route (module `query`) and
// from the recovery pipeline (the `query` fn passed into
// computeRecoveryScore).

'use strict';

// Parse an h:mm:ss / mm:ss duration string into seconds. Returns 0 for
// anything it can't parse (e.g. "45 min", "90", "1.5 hr") — callers
// that have a numeric duration column should prefer that and use this
// only as a fallback.
function durationToSeconds(s) {
  if (!s) return 0;
  const m = String(s).match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, h, mm, ss] = m;
  return (Number(h) || 0) * 3600 + Number(mm) * 60 + Number(ss);
}

// Exponentially-weighted moving average — ATL (N=7) and CTL (N=42).
// Standard fitness-modeling recurrence: v_t = v_{t-1}(1 - 1/N) + tss/N.
// Returns the full series so callers can read the last element for
// "today" or the whole array for charting.
function ewma(dailySeries, n) {
  let v = 0;
  const out = [];
  for (const tss of dailySeries) {
    v = v * (1 - 1 / n) + (Number(tss) || 0) / n;
    out.push(v);
  }
  return out;
}

// Canonical per-workout TSS. HR path when avg HR + zones are present;
// effort fallback otherwise.
//
//   HR:     TSS = durHr × (avgHR / LTHR)² × 100
//   effort: TSS = durHr × (effort / 10)²  × 100
//
// The effort fallback mirrors the HR intensity-factor structure so it
// caps naturally at 100 TSS/hr at max effort (effort 10 == IF 1.0 ==
// threshold). No HR + no effort → null (no silent imputation).
function computeTSS(workout, zones) {
  // Prefer the numeric duration_minutes column; fall back to the text
  // time_duration parser only when the numeric column is absent.
  let durSec = (Number(workout.duration_minutes) || 0) * 60;
  if (!durSec) durSec = durationToSeconds(workout.time_duration);
  const durHr = durSec / 3600;
  if (durHr <= 0) return null;

  const avgHR = workout.heart_rate_avg
    ? Number(String(workout.heart_rate_avg).replace(/[^\d.]/g, ''))
    : null;
  const lthr = zones?.lthr || (zones?.max_hr ? Math.round(zones.max_hr * 0.88) : null);
  if (avgHR && lthr) {
    const intensity = avgHR / lthr;
    return Math.round(durHr * intensity * intensity * 100);
  }

  const effort = Number(workout.effort);
  if (!isFinite(effort) || effort <= 0) return null;
  const ifProxy = Math.min(effort, 10) / 10;
  return Math.round(durHr * ifProxy * ifProxy * 100);
}

// Fetch the athlete_zones row effective on `date`. Query-injectable so
// route handlers pass their module `query` and the recovery pipeline
// passes the `query` it was handed. Returns null when no row covers
// the date — computeTSS then falls through to the effort path.
async function getEffectiveZones(date, queryFn) {
  if (typeof queryFn !== 'function') {
    throw new Error('getEffectiveZones: queryFn required');
  }
  const r = await queryFn(
    `SELECT * FROM athlete_zones
      WHERE zone_type = 'heart_rate'
        AND effective_from <= $1
        AND (effective_to IS NULL OR effective_to >= $1)
      ORDER BY effective_from DESC LIMIT 1`,
    [date]
  );
  return r.rows[0] || null;
}

// Fill workout.tss on-the-fly for any row whose stored tss is null,
// using the zones row for `date`. Mutates the passed array's rows in
// place and returns it. This is the exact behavior the dashboard's
// /training loop has always had; lib/recovery.js calls this so the
// recovery panel sees the same workout set the dashboard does.
//
// Mutation is deliberate and matches the dashboard's existing pattern
// (it assigns wo.tss = computeTSS(...) on the fetched rows). The rows
// are request-scoped query results, never persisted from here.
function fillMissingTss(workouts, zones) {
  for (const w of workouts) {
    if (w.tss == null) {
      const t = computeTSS(w, zones);
      if (t != null) w.tss = t;
    }
  }
  return workouts;
}

module.exports = {
  durationToSeconds,
  ewma,
  computeTSS,
  getEffectiveZones,
  fillMissingTss,
};
