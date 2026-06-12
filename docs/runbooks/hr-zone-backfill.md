# Runbook: HR zone correction + Z2 minutes backfill

**Symptom:** Z2 minutes chart on the Training Load screen reads near-zero for the last N weeks, even for sessions where avg HR was clearly aerobic (130-150 bpm range).

**Root cause:** the `athlete_zones` table held a row derived from a wrong max HR (174 instead of 190). Under those bounds, Z2 was 105-125 bpm, so genuine Z2 effort got bucketed into Z3 (or higher) when `routes/health.js:bucketSamplesByZone` ran. Aggregation in `routes/insights.js:z2MinutesByWeek` sums `wo.hr_zones.minutes.z2`, which was ~0 for every affected workout.

**Canonical zones (locked):**

| Zone | Range (bpm) |
|---|---|
| Z1 | <130 |
| Z2 | 130-150 |
| Z3 | 151-165 |
| Z4 | 166-180 |
| Z5 | 181+ |
| max_hr | 190 |
| LTHR | 165 |

## Procedure

### 1. Verify the symptom

```
GET /api/health/diag/hr-sample-coverage?days=90
```

Look at the response:
- `summary.with_zones` vs `summary.total_workouts` — coverage rate
- `summary.backfillable_now` — workouts with samples in `metadata.heartRateData` but `hr_zones IS NULL`
- `summary.no_samples_needs_ios` — workouts with no per-sample HR at all (Format A or HR-stream disabled iOS-side)
- `zones_now` — currently effective zone row. If `z2_max < 130` or `max_hr < 180`, this is the wrong-bounds row.
- `z2_band_examples` — sessions whose avg HR was 130-150 bpm; check `minutes.z2` and `zones_z2_max_used`.
- `verdict` — plain-English next step.

### 2. Correct the athlete_zones table

```
node scripts/correct-athlete-zones-canonical.js
```

Dry run prints what it would do. Review the existing rows + the candidate count of workouts whose `hr_zones` would be NULLed.

```
node scripts/correct-athlete-zones-canonical.js --apply
```

This is one transaction:
1. Deletes all existing `heart_rate` rows in `athlete_zones`
2. Inserts the canonical row with `effective_from = 2024-01-01` (backdated)
3. NULLs `hr_zones` on every workout from that date forward that has HR samples in `metadata.heartRateData`

The NULL step is the trigger for step 3 — `scripts/backfill-hr-zones-from-metadata.js` only touches rows where `hr_zones IS NULL`.

### 3. Recompute zones from stored samples

```
node scripts/backfill-hr-zones-from-metadata.js --apply
```

This pre-existing script (PR #47) iterates workouts with `hr_zones IS NULL` and `metadata.heartRateData` non-empty, normalizes the various HR-sample shapes (HK direct, Shortcut, Apple Health Auto Export `{Avg, date}`), and runs `computeHrZonesForWorkout` — which now uses the canonical bounds because step 2 backdated them.

Per-row output (JSON line) tells you sample count, in-window count, coverage %, and bucketed minutes.

### 4. Verify the fix

Re-run the diagnostic from step 1.

`summary.with_zones` should now equal `summary.total_workouts - summary.no_samples_needs_ios`. The Training Load screen's Z2 chart should reflect actual aerobic time. For the validation fixture from the task brief: the 2026-06-11 stair workout (avg HR 148) should show ~41 min Z2.

If the chart still looks wrong, check the frontend cache — `public/app.js` may need a hard reload on the Training tab.

## What about Format A (no-sample) workouts?

The script can't backfill these — they were submitted by Apple Watch as summary-only payloads (no `heartRateData` array). `summary.no_samples_needs_ios` counts them.

Fixes, depending on your iOS-side setup:
- **HealthAutoExport (HAE):** enable Heart Rate metric, aggregation = "raw samples" or "1 minute average" (not daily/hourly). Confirm with a fresh export.
- **Custom Shortcut:** the Shortcut needs to query `Get Heart Rate Samples` from Health and include the array in the POST body as `metadata.heartRateData`.

The ingest pipeline already accepts both shapes — `extractHrSamplesFromB` at `routes/health.js:1262` reads `value | qty | quantity | Avg | avg`. The blocker (if any) is iOS-side.

## Rollback

If something looks wrong after step 2's `--apply`:

```sql
-- Restore the prior (wrong) zones row — only useful if you saved the old row out-of-band.
INSERT INTO athlete_zones (...) VALUES (...);
-- NULLing hr_zones is harmless — they'll get recomputed on the next ingest or backfill run.
```

The backfill script is non-destructive (only UPDATEs, no DELETEs), so a partial backfill is safe to interrupt.
