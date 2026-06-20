# Forge relational redesign — proposal

Status: **Proposal, no code changes.** Approval gate before any DDL.

## The problem

Live map (your prod query, 2026-06-20):

| Table | Live cols | Notes |
|---|---:|---|
| **workouts** | **64** | God table — every concern bolted on for years |
| daily_plans | 33 | Plan envelope; borderline |
| daily_activity | 30 | Deprecated, dropping Aug 5 |
| races | 27 | Race detail; reasonable |
| goals | 25 | Goal definition; reasonable |
| tasks | 25 | TODO tracking; reasonable |
| injuries | 23 | Injury record; reasonable |
| coaching_sessions | 21 | Session log; reasonable |
| meals | 20 | Meal entry; reasonable |
| (everything else) | ≤19 | Fine |

**Only workouts is structurally broken.** 64 columns conflate at least 5 separate concerns. Daily_plans at 33 is borderline — splittable but not urgent. Everything else is well-sized.

## The workouts split

Today's 64-column workouts table → 5 tables with clean FK relationships:

### 1. `workouts` (core session) — ~22 cols

The session identity + linkage. One row per session.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `title` | TEXT | |
| `workout_date` | DATE | |
| `workout_type` | TEXT | (later: ENUM) |
| `focus` | TEXT | |
| `location` | TEXT | |
| `effort` | INT 1-10 | Overall RPE |
| `body_notes` | TEXT | Free-text session notes |
| `completion_status` | TEXT | logged / partial / failed |
| `source` | TEXT | manual / apple_health / hevy / etc |
| `ai_source` | TEXT | |
| `started_at` | TIMESTAMPTZ | |
| `ended_at` | TIMESTAMPTZ | |
| `deleted_at` | TIMESTAMPTZ | Soft delete |
| `daily_plan_id` | UUID FK → daily_plans | |
| `plan_segment_id` | UUID FK → plan_segments | |
| `hevy_id` | TEXT | External integration id |
| `warmup` | TEXT | Prescribed warmup notes |
| `main_sets` | TEXT | Prescribed main sets text |
| `carries` | TEXT | Loaded carry notes |
| `tags` | JSONB | |
| `metadata` | JSONB | |
| `search_vector` | TSVECTOR | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

### 2. `workout_metrics` (1:1 with workouts) — ~12 cols

Numeric session results. One row per workout.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `workout_id` | UUID FK + UNIQUE → workouts(id) ON DELETE CASCADE | Enforces 1:1 |
| `duration_minutes` | INT | |
| `distance_value` | NUMERIC(7,2) | Miles |
| `elevation_gain_ft` | INT | |
| `hr_avg` | INT | |
| `hr_max` | INT | |
| `cadence` | INT | |
| `cal_active` | INT | |
| `cal_total` | INT | |
| `total_volume_lb` | NUMERIC(10,2) | Strength volume |
| `total_sets` | INT | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**TEXT predecessors dropped:** `time_duration`, `distance`, `elevation_gain`, `heart_rate_avg`, `heart_rate_max`, `active_calories`, `total_calories` — these duplicated the numeric columns above and were backfill targets. They're no longer the source of truth on writes.

### 3. `workout_training_load` (1:1 with workouts) — ~6 cols

TSS / IF / HR-zone analysis. One row per workout.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `workout_id` | UUID FK + UNIQUE → workouts(id) ON DELETE CASCADE | |
| `tss` | INT | |
| `intensity_factor` | NUMERIC(4,2) | |
| `hr_zones` | JSONB | Time-in-zone breakdown |
| `inferred_workout_type` | BOOLEAN | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

### 4. `workout_feedback` (1:N with workouts) — ~5 cols

Normalizes the `grip_feedback / legs_feedback / cardio_feedback / shoulder_feedback` 1NF violation. Zero or more rows per workout, one per body area.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `workout_id` | UUID FK → workouts(id) ON DELETE CASCADE | |
| `body_area` | TEXT | Constrained: grip / legs / cardio / shoulder / plan_comparison / slowdown / failure_first |
| `feedback_text` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| **UNIQUE** | `(workout_id, body_area)` | One feedback per area per workout |

### 5. `workout_exercises` (1:N with workouts) — ~9 cols

Replaces the `workouts.exercises JSONB` blob. The biggest relational win — queryable strength data.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `workout_id` | UUID FK → workouts(id) ON DELETE CASCADE | |
| `exercise_position` | INT | 1, 2, 3 within the workout |
| `exercise_id` | UUID FK → exercises(id) ON DELETE SET NULL | Real link to catalog |
| `exercise_name` | TEXT | Fallback if catalog row deleted; also captures Hevy-only names |
| `sets` | JSONB | `[{set_number, weight_lb, reps, rpe, rest_sec, type}, …]` — could normalize further later |
| `notes` | TEXT | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |
| **UNIQUE** | `(workout_id, exercise_position)` | |

`sets` stays JSONB for now because individual set data is rarely queried independently (always read in context of the parent exercise). Pulling sets into a 6th table is possible but adds load with little query benefit. Defer until needed.

## Result

| Table | Cols | Purpose |
|---|---:|---|
| workouts | 22 | Identity + linkage |
| workout_metrics | 12 | Numeric results |
| workout_training_load | 6 | TSS analysis |
| workout_feedback | 5 | Body-area feedback (was 4 cols, now N rows) |
| workout_exercises | 9 | Real strength catalog link (was JSONB blob) |

**Net:** 64 cols on 1 table → 54 cols across 5 tables. More importantly:
- **Every relationship is queryable.** "All workouts with Deadlift" becomes `JOIN workout_exercises ON exercise_id = …` instead of JSONB containment.
- **No 1NF violations.** Per-body-area feedback is rows, not columns.
- **TEXT/numeric duplication ends.** Drop the 7 TEXT predecessors.
- **Each table has one job.** Easier to reason about, easier to index, easier to evolve.

## Migration approach

Because `workouts` is heavily read/written by ingest, coach, frontend, Hevy sync — this can't be a single transaction swap like `daily_context`. The safe pattern:

1. **Additive phase (auto on deploy):** create the 4 child tables empty. They sit alongside `workouts` with no data. Routes unchanged.
2. **Dual-write phase (PR per surface):** every place that writes workouts also writes the relevant child rows. Keep the old workouts columns in sync. Catch drift with a sentinel.
3. **Dual-read phase (PR per surface):** reads start preferring child tables when populated, falling back to workouts columns. Backfill historical workouts in one operator-gated script (transactional, row-count + checksum assert, same pattern as `rebuild-daily-context`).
4. **Read-cutover phase:** reads ignore old columns even when populated.
5. **Drop phase (operator-gated):** drop the now-dead workouts columns. Use the existing `scripts/rebuild-table.js` to reclaim the tombstones.

Each phase is a separate PR with reversal via the previous phase's code remaining live. No "everything breaks at once" risk.

## What I want from you before any code

1. **Approve the 5-table split shape** above, OR redirect (e.g. "fold training_load into metrics, I won't need it queried separately").
2. **Approve the JSONB stays in `workout_exercises.sets`** — alternative is a 6th `workout_sets` table, which is purer but heavier. Defer or do now?
3. **Approve the phased migration** (additive → dual-write → dual-read → cutover → drop) vs. a faster but riskier alternative.
4. **Decide on daily_plans (33 cols)** — split now alongside workouts, or leave for later? My read: leave; it's not actively biting.

Once approved I'll execute phase 1 (additive only, zero risk) as the first PR.

## What this does NOT touch

- The tombstone reclamation work already queued (`scripts/rebuild-daily-context.js`, `scripts/rebuild-table.js`) — still needed for tables we don't restructure.
- The 9 active leaks in db.js — still need fixing to stop the bleed.
- Phase D / Phase E / other operator-gated scripts already on the parent branch.

All of those land first/separately. This redesign is the architectural lever **on top of** the hygiene work.
