#!/usr/bin/env node
// Backfill workouts.hr_zones from workouts.metadata.heartRateData for
// apple_health rows that have HR samples but no derived zones.
//
// Why this exists: the Format B HR-zone derivation in
// `routes/health.js` only fires inside the same /api/health/ingest
// request that delivered the samples. Any apple_health workout whose
// row was created via Format A first (or whose Format B ingest pre-
// dated the zone-compute code) ends up with the raw HR array sitting
// in `metadata.heartRateData` and `hr_zones = NULL`. The
// /health/insights/polarization endpoint then reads 0 minutes per
// week and the Training Load screen shows an empty Z2 chart.
//
// Usage:
//   node scripts/backfill-hr-zones-from-metadata.js              # dry run
//   node scripts/backfill-hr-zones-from-metadata.js --apply      # write
//   node scripts/backfill-hr-zones-from-metadata.js --apply --workout=<uuid>
//   node scripts/backfill-hr-zones-from-metadata.js --apply --since=2026-05-01
//
// Idempotent: only touches rows where hr_zones IS NULL. To re-derive a
// row whose zones are wrong, NULL the column first (or use the
// POST /api/workouts/:id/hr-samples endpoint with a fresh trace).
//
// Output: per-workout JSON line with id, samples_seen, samples_in_window,
// computed minutes by zone, coverage_pct, and what the UPDATE did.

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { query } = require('../db');
const { computeHrZonesForWorkout } = require('../routes/health');

function parseArgs(argv) {
  const out = { apply: false, workout: null, since: null, limit: null };
  for (const a of argv.slice(2)) {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--workout=')) out.workout = a.slice('--workout='.length);
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
  }
  return out;
}

// Normalize whatever the Apple Health pipeline stashed in
// metadata.heartRateData into [{t, value}]. The shapes we have seen:
//   { date, qty }                           older HK exports
//   { startDate, value }                    HK direct dump
//   { timestamp, bpm }                      Shortcuts
//   { date, Avg, Max, Min, units, source }  Apple Health Auto Export
//                                           — the dominant shape in
//                                           Forge's actual data. Avg
//                                           is the per-minute mean.
function normalizeSamples(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    const t = s.t || s.timestamp || s.date || s.start_date || s.startDate;
    const v = Number(s.value ?? s.bpm ?? s.qty ?? s.quantity ?? s.Avg ?? s.avg ?? s.AVG);
    if (t && isFinite(v)) out.push({ t, value: v });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const where = [
    `hr_zones IS NULL`,
    `metadata->'heartRateData' IS NOT NULL`,
    `jsonb_array_length(COALESCE(metadata->'heartRateData', '[]'::jsonb)) > 0`,
  ];
  const params = [];
  let p = 1;
  if (args.workout) { where.push(`id = $${p++}`); params.push(args.workout); }
  if (args.since) { where.push(`workout_date >= $${p++}`); params.push(args.since); }
  const limit = args.limit ? ` LIMIT ${Math.max(1, args.limit | 0)}` : '';

  const sql = `SELECT id, workout_date, time_duration, source,
                      jsonb_array_length(metadata->'heartRateData') AS sample_count
                 FROM workouts
                WHERE ${where.join(' AND ')}
                ORDER BY workout_date DESC${limit}`;

  const { rows } = await query(sql, params);
  console.log(`[backfill-hr-zones] candidates: ${rows.length} (apply=${args.apply})`);

  let updated = 0;
  let skippedNoZones = 0;
  let skippedNoWindowMatch = 0;

  for (const w of rows) {
    // Pull the raw samples for this row.
    const raw = await query(
      `SELECT metadata->'heartRateData' AS samples FROM workouts WHERE id = $1`,
      [w.id]
    );
    const samples = normalizeSamples(raw.rows[0].samples);
    if (!samples.length) {
      console.log(JSON.stringify({ id: w.id, status: 'skipped', reason: 'no_normalizable_samples', raw_count: w.sample_count }));
      continue;
    }

    let zones;
    try {
      zones = await computeHrZonesForWorkout(w.id, samples);
    } catch (err) {
      console.log(JSON.stringify({ id: w.id, status: 'error', message: err.message }));
      continue;
    }

    if (!zones) {
      // computeHrZonesForWorkout returns null when either no athlete_zones
      // row covers this date, OR no samples fall inside the workout
      // window. Distinguish so the operator can tell which to fix.
      const inWindowProbe = await query(
        `SELECT started_at, ended_at FROM workouts WHERE id = $1`,
        [w.id]
      );
      const reason = !inWindowProbe.rows[0]?.started_at
        ? 'no_started_at'
        : 'no_zones_or_window';
      if (reason === 'no_zones_or_window') skippedNoZones++;
      else skippedNoWindowMatch++;
      console.log(JSON.stringify({ id: w.id, status: 'skipped', reason, samples: samples.length }));
      continue;
    }

    if (args.apply) {
      await query(
        `UPDATE workouts SET hr_zones = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(zones), w.id]
      );
      updated++;
    }

    console.log(JSON.stringify({
      id: w.id,
      workout_date: w.workout_date instanceof Date ? w.workout_date.toISOString().slice(0, 10) : w.workout_date,
      status: args.apply ? 'updated' : 'would_update',
      samples_in: samples.length,
      samples_in_window: zones.sample_count,
      coverage_pct: zones.coverage_pct,
      minutes: zones.minutes,
    }));
  }

  console.log(`[backfill-hr-zones] done. candidates=${rows.length} updated=${updated} skipped_no_zones=${skippedNoZones} skipped_no_window=${skippedNoWindowMatch}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[backfill-hr-zones] fatal:', err.stack);
  process.exit(1);
});
