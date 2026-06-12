#!/usr/bin/env node
// Backdate the canonical HR zones over all athlete history.
//
// Why this exists: the prior athlete_profile had max_hr=174 (wrong),
// which produced an athlete_zones row whose Z2 band was 105-125 bpm.
// Sessions around 130-150 bpm — actual Z2 effort for an athlete with
// max=190 — fell into Z3 in the bucketing math, so the Z2 chart on
// the Training Load screen reads near-zero even though those sessions
// were aerobic.
//
// Canonical zones (from athlete profile b1c9e742, effective 2026-06-12,
// max_hr=190, LTHR=165):
//
//     Z1:  <130  → z1_max = 129
//     Z2:  130-150 → z2_max = 150
//     Z3:  151-165 → z3_max = 165
//     Z4:  166-180 → z4_max = 180
//     Z5:  181+    → z5_max = 200  (lower bound for "anything above Z4")
//
// Approach (Avi-selected, A): treat the old row as wrong, not as a
// historical change. We delete it and backdate the corrected row so
// every historical workout resolves to the canonical bounds when the
// hr-zones backfill runs.
//
// Usage:
//   node scripts/correct-athlete-zones-canonical.js              # dry run
//   node scripts/correct-athlete-zones-canonical.js --apply      # write
//   node scripts/correct-athlete-zones-canonical.js --apply --from=2025-01-01
//
// After this script + --apply, run:
//   node scripts/backfill-hr-zones-from-metadata.js --apply
// to re-bucket all workouts whose hr_zones were computed under the wrong
// boundaries. The backfill script only touches rows where hr_zones IS
// NULL, so we NULL the column on candidates first.
//
// Idempotent. Re-running with --apply when the canonical row already
// exists is a no-op (returns "already_canonical").

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { query } = require('../db');

const CANONICAL = {
  zone_type: 'heart_rate',
  max_hr: 190,
  lthr: 165,
  z1_max: 129,
  z2_max: 150,
  z3_max: 165,
  z4_max: 180,
  z5_max: 200,
  method: 'absolute_bpm',
  set_by: 'avi',
  rationale: 'Corrected from prior wrong max_hr=174 row. Canonical bounds locked per athlete profile b1c9e742 (2026-06-12).',
};

const DEFAULT_BACKDATE = '2024-01-01';

function parseArgs(argv) {
  const out = { apply: false, from: DEFAULT_BACKDATE, nullHrZones: true };
  for (const a of argv.slice(2)) {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--from=')) out.from = a.slice('--from='.length);
    else if (a === '--no-null-hr-zones') out.nullHrZones = false;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('[correct-zones] canonical:', JSON.stringify(CANONICAL));
  console.log(`[correct-zones] backdate effective_from: ${args.from}`);
  console.log(`[correct-zones] apply mode: ${args.apply}`);

  // Audit existing rows.
  const existing = await query(
    `SELECT id, effective_from, effective_to, max_hr,
            z1_max, z2_max, z3_max, z4_max, z5_max, method, set_by
       FROM athlete_zones
      WHERE zone_type = 'heart_rate'
      ORDER BY effective_from DESC`
  );
  console.log(`[correct-zones] existing zone rows: ${existing.rows.length}`);
  for (const r of existing.rows) {
    console.log('  ', JSON.stringify(r));
  }

  const canonicalAlready = existing.rows.find(r =>
    r.max_hr === CANONICAL.max_hr &&
    r.z1_max === CANONICAL.z1_max &&
    r.z2_max === CANONICAL.z2_max &&
    r.z3_max === CANONICAL.z3_max &&
    r.z4_max === CANONICAL.z4_max &&
    r.effective_from && r.effective_from.toISOString().slice(0, 10) <= args.from
  );
  if (canonicalAlready) {
    console.log(`[correct-zones] already_canonical — row id=${canonicalAlready.id} covers ${args.from} onward with correct bounds. No write needed.`);
    process.exit(0);
  }

  if (!args.apply) {
    console.log('[correct-zones] DRY RUN — would:');
    console.log(`  1. DELETE ${existing.rows.length} existing heart_rate rows`);
    console.log(`  2. INSERT canonical row with effective_from=${args.from}, effective_to=NULL`);
    if (args.nullHrZones) {
      const candidates = await query(
        `SELECT COUNT(*)::int AS n FROM workouts
         WHERE workout_date >= $1::date
           AND jsonb_array_length(COALESCE(metadata->'heartRateData', '[]'::jsonb)) > 0`,
        [args.from]
      );
      console.log(`  3. NULL hr_zones on ${candidates.rows[0].n} workouts (those with HR samples since ${args.from})`);
    }
    console.log('[correct-zones] Re-run with --apply to write.');
    process.exit(0);
  }

  // APPLY path. Wrap in a single transaction so a mid-run failure leaves
  // the table consistent.
  await query('BEGIN');
  try {
    const del = await query(
      `DELETE FROM athlete_zones WHERE zone_type = 'heart_rate' RETURNING id`
    );
    console.log(`[correct-zones] deleted ${del.rowCount} old rows`);

    const ins = await query(
      `INSERT INTO athlete_zones (
         effective_from, effective_to, zone_type,
         max_hr, lthr,
         z1_max, z2_max, z3_max, z4_max, z5_max,
         method, set_by, rationale, source_data
       ) VALUES (
         $1::date, NULL, 'heart_rate',
         $2, $3,
         $4, $5, $6, $7, $8,
         $9, $10, $11, '{}'::jsonb
       ) RETURNING id, effective_from, z1_max, z2_max, z3_max, z4_max, z5_max, max_hr, lthr`,
      [
        args.from,
        CANONICAL.max_hr, CANONICAL.lthr,
        CANONICAL.z1_max, CANONICAL.z2_max, CANONICAL.z3_max,
        CANONICAL.z4_max, CANONICAL.z5_max,
        CANONICAL.method, CANONICAL.set_by, CANONICAL.rationale,
      ]
    );
    console.log('[correct-zones] inserted canonical row:', JSON.stringify(ins.rows[0]));

    if (args.nullHrZones) {
      const upd = await query(
        `UPDATE workouts
            SET hr_zones = NULL, updated_at = NOW()
          WHERE workout_date >= $1::date
            AND jsonb_array_length(COALESCE(metadata->'heartRateData', '[]'::jsonb)) > 0`,
        [args.from]
      );
      console.log(`[correct-zones] NULLed hr_zones on ${upd.rowCount} workouts so the backfill script will recompute them`);
    }

    await query('COMMIT');
    console.log('[correct-zones] COMMIT. Next step: node scripts/backfill-hr-zones-from-metadata.js --apply');
  } catch (err) {
    await query('ROLLBACK');
    console.error('[correct-zones] ROLLBACK:', err.stack);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[correct-zones] fatal:', err.stack);
  process.exit(1);
});
