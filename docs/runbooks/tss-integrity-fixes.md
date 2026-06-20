# TSS / Training Load Data Integrity — Fix Plan

Status as of v3.30. Lead finding from the [TSB-divergence investigation](#background):
the Training dashboard and the Recovery panel were computing "TSB" using
completely different inputs (real TSS vs. an `effort × duration` heuristic),
producing 2.6–3× different numbers under the same label. v3.30 unifies them
onto `workouts.tss` and ships a diagnostic endpoint to surface the remaining
data-quality issues.

The rest of this doc tracks the phased fixes for the HIGH/MEDIUM risks the
investigation surfaced. Each phase is a separately-mergeable PR.

---

## Phase 0 — diagnose (in this PR)

**Endpoint:** `GET /api/health/diag/tss-integrity?days=42`

Returns four orthogonal diagnostics against `workouts`:
- `same_day_duplicates` — cross-source rows on the same date (apple_health + manual + hevy)
- `stale_zones` — TSS values whose `updated_at` predates the canonical `athlete_zones` row
- `effort_fallback` — rows likely computed via the no-HR fallback formula (`(durMin) × effort × 1.5`, capped at 200)
- `implausible_per_hour` — rows above 130 TSS/hour, regardless of cause

`summary.verdict` summarises in one sentence what the operator should act on first.

**Use this before each downstream phase** to see whether the structural fix is needed at all.

---

## Phase 1 — recompute TSS after canonical zone changes (HIGH)

**Why:** `workouts.tss` is computed once at insert against the `athlete_zones` row in effect at that moment. When `POST /api/athlete/zones/canonical-correct` updates zones, it nulls `hr_zones` but leaves `tss` stale. Every subsequent CTL/ATL roll-up reads the inflated values.

**Fix:**

1. Extend `POST /api/athlete/zones/canonical-correct` to also `UPDATE workouts SET tss = NULL WHERE workout_date >= from AND tss IS NOT NULL`.
2. Auto-invoke `POST /api/health/insights/recompute-tss?since=<from>` from within the canonical-correct transaction (or kick a fire-and-forget post-commit).
3. Add a `zones_id UUID REFERENCES athlete_zones(id)` column to `workouts` so future stale-detection is exact instead of timestamp-based.

**Effort:** ~half a day. Migration + endpoint extension + one regression test asserting `tss` is recomputed after a canonical-correct.

**Verification:** Re-run `/diag/tss-integrity` after deploy — `stale_tss_rows` should be 0.

---

## Phase 2 — cross-source workout dedupe (HIGH)

**Why:** Existing unique constraints (`uq_workouts_hevy_id`, `uq_workouts_apple_health_started_at`) prevent same-source duplication but allow:
- An `apple_health` row + a `manual` row at the same time
- A `hevy` row + a `manual` row
- Two `manual` rows at the same time

The `/training` endpoint does `SELECT SUM(tss) ... GROUP BY workout_date` — duplicates collapse on date but their TSS sums. `dedupeAppleWorkouts()` only handles same-source Apple Health overlaps; it doesn't merge across sources.

**Fix (two-step):**

1. **Detection job** — extend `/diag/tss-integrity`'s same-day-duplicates check into a dedupe candidate-list endpoint that flags rows whose `started_at` falls within ~10 min of another workout (any source) on the same date.
2. **Merge endpoint** — `POST /api/workouts/dedupe-cross-source` accepts `{ keep_id, drop_ids[], apply: bool }`. Migrates linked rows (plan_segment links, hr_zones, metadata) from drop → keep, deletes drop rows. Idempotent.
3. (Optional structural) Partial unique index on `(date_trunc('minute', started_at), workout_type) WHERE started_at IS NOT NULL` to prevent NEW cross-source dupes. Risky because legitimate concurrent workouts of different types (e.g., a walk then a lift in the same minute) would conflict — needs design pass.

**Effort:** ~1 day. The merge endpoint is the work; the detection is mostly already in Phase 0.

**Verification:** Sample 10 historical dupes flagged by Phase 0, manually confirm they're the same physical session, merge, re-run dashboard math, confirm CTL drop.

---

## Phase 3 — shared `lib/training-load.js` (HIGH)

**Why:** Even after v3.30 unifies the surfaces, the EWMA formula and daily-TSS query are duplicated across `routes/insights.js` (3 sites) and `lib/recovery.js` (1 site). Next maintainer will re-fork.

**Fix:**

1. New `lib/training-load.js` exporting:
   - `dailyTssSeries({ start, end, queryFn })` — SQL-backed daily TSS map.
   - `ewma(values, n)` — single canonical implementation (the discrete-time `v(1-1/N) + tss/N` form already in `insights.js`).
   - `computeCtlAtlTsb({ dailyTss, targetDate })` — runs the EWMA pair, returns `{ ctl, atl, tsb, series }`.
   - `statusFromTsb(tsb)` — single source of truth for the `fresh / neutral / fatigued / very_fatigued` mapping.
2. `routes/insights.js`'s `/training`, `computeTodayTSB`, weekly polar block, and `lib/recovery.js:computeTrainingLoadScore` all delegate to it.
3. Drop the duplicate `ewma` function in `insights.js` and the inlined EWMA in `recovery.js`.

**Effort:** ~half day. Pure refactor — no behavior change. Existing tests should pass unchanged; add a few helper-level tests for the new module.

**Verification:** Snapshot-compare TSB / CTL / ATL across `/training` and `/recovery/score` for the same date pre- and post-refactor. Should be bit-for-bit identical (already true after v3.30).

---

## Phase 4 — tighten `computeTSS` (MEDIUM)

**Why:** Two issues that bias TSS upward:
- Effort-fallback cap of 200 is above the physiological max (~100 TSS/hour at threshold). A 90-min effort-7 session without HR computes 945 raw → capped to 200, still 133 TSS/hr equivalent.
- `durationToSeconds` only parses `h:mm:ss` / `mm:ss`. Strings like `"45 min"` or `"90"` return 0 → TSS skipped silently.

**Fix:**

1. Lower the effort-fallback cap to **100** (one hour at threshold = 100 TSS, by definition).
2. Tag rows that used the fallback with `tss_method = 'fallback'` so downstream CTL can optionally exclude them or display warnings.
3. Replace `durationToSeconds(time_duration)` with `Number(duration_minutes) * 60` when `duration_minutes` is present (the canonical numeric column). Keep text parser as second-line fallback.

**Effort:** ~2 hours. Migration to add `tss_method` column + small `computeTSS` update + reparser pass.

---

## Phase 5 — timezone audit (MEDIUM)

**Why:** `workouts.workout_date` is a `DATE` column. Whichever writer set it (Apple Health Format A, Format B, Hevy sync, manual POST) may have used UTC vs ET. Late-night ET workouts (e.g., 9pm Mon ET = 1am Tue UTC) can land on the wrong `workout_date`, putting them in the wrong week for CTL purposes.

**Fix:**

1. Diagnostic query: `SELECT id, source, workout_date, started_at, started_at AT TIME ZONE 'America/New_York' AS local_start FROM workouts WHERE workout_date != date(started_at AT TIME ZONE 'America/New_York')`.
2. If non-zero, backfill `workout_date = date(started_at AT TIME ZONE 'America/New_York')` for the affected rows.
3. Update Apple Health ingest paths to set `workout_date` from `started_at AT TIME ZONE` rather than payload date.
4. Add a check to the ingest path that warns if the supplied `workout_date` disagrees with the local date of `started_at`.

**Effort:** ~half day, mostly investigative.

---

## Phase 6 — sleep into `/nutrition/daily-context` (MEDIUM)

**Why:** Apple Health sleep data is ingested into `daily_activity.sleep_total_min` but not flowing through to `/nutrition/daily-context`. Not yet traced; preliminary guess is a JOIN column mismatch or a stale cache layer.

**Fix:** Trace from `/nutrition/daily-context` route handler back through any helpers, identify the missing JOIN or transform, repair. Add one assertion that confirms sleep flows through.

**Effort:** ~30 min of tracing once we start.

---

## Phase 7 — low-priority cleanups

- Unify two EWMA implementations (already covered by Phase 3 if we go that route).
- `computeTodayTSB` and `/training` use different lookback windows (90 vs configurable). Standardize on one constant.

---

## Sequencing

Recommended order, each PR small and independently mergeable:

| Order | Phase | Why this first |
|---|---|---|
| **1** | Phase 0 — diagnostic | Already in v3.30. Use it to size the next phases. |
| **2** | Phase 1 — recompute on canonical-correct | One-time data cleanup PLUS prevents future recurrence. Biggest single CTL-correction lever. |
| **3** | Phase 2 — cross-source dedupe | Second-biggest source of inflated CTL. Detection first, merge endpoint second, structural constraint last. |
| **4** | Phase 3 — shared lib | Once #1 and #2 are stable, lock in the unification structurally so it can't drift back. |
| **5** | Phase 4 — TSS tightening | Cosmetic at this point if #1–#3 land first, but worth doing for correctness. |
| **6** | Phase 5 — timezone | Investigation-heavy, low expected blast radius. Schedule when there's downtime. |
| **7** | Phase 6 — sleep flow | Independent of the TSS work. Slot in when convenient. |

---

## Background

The investigation report that produced this plan: see chat session
`session_01WViiJEoQqmLDtV1ZVrHc5D` (2026-06-16).

Key finding: `routes/insights.js` reads `workouts.tss` (TrainingPeaks
HR-based formula). `lib/recovery.js` was computing its own load as
`effort × duration_minutes` and labeling the EWMA output `tsb`. Same
field name, completely different units. v3.30 closes the surface gap;
this plan addresses the upstream data quality.
