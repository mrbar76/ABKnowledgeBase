# Forge Database Schema

The intended shape of the Forge Postgres schema, the entity ownership
boundaries the code commits to, and the deprecation log. Source of truth
for "what column should and shouldn't exist".

The live schema lives in `db.js` — every `CREATE TABLE` and idempotent
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` runs at boot via `initDB()`.
This doc is the human-readable contract; `db.js` is what actually executes.

When the two disagree, the **drift detector** at `GET
/api/health/diag/deprecated-columns` flags it. Endpoint is driven by the
`DEPRECATED_COLUMNS` manifest in `routes/health.js` — add a row there
every time a column is dropped, and the endpoint will tell us if the
drop ever stops succeeding.

---

## Entity map

### Training core

| Table | Owns | Key FKs |
|---|---|---|
| `workouts` | One per workout session (logged or synced). | `daily_plan_id → daily_plans`, `plan_segment_id → plan_segments` |
| `plan_segments` | Sessions within a daily plan (the canonical "what was planned"). | `daily_plan_id → daily_plans` |
| `daily_plans` | One per plan_date — the daily envelope (status, targets, coaching notes). | `training_block_id → training_blocks`, `linked_race_id → races` |
| `training_blocks` | Multi-day blocks with phase + intent. | `target_race_id → races` |
| `races` | Race-centric plans (goal, splits, placement). | — |
| `fueling_rehearsals` | Pre-race fueling protocol trials. | `workout_id → workouts`, `target_race_id → races` |
| `exercises` | Catalog (one row per exercise). | `hevy_template_id` (external) |
| `exercises_reference` | Imported research-library entries (free-exercise-db, wger). Never auto-promoted to `exercises`. | — |
| `hevy_template_cache` | Mirror of the user's Hevy exercise library, refreshed on demand. | — |
| `hevy_exercise_map` | Bridge between `exercises.name` and `hevy_template_cache.hevy_id`. | — |
| `gym_profiles` | Equipment available at a gym. | — |
| `equipment_catalog` | Lookup table for gym-profile equipment selection. | — |

### Daily check-in + recovery

| Table | Owns | Notes |
|---|---|---|
| `daily_context` | One per date — subjective inputs (mood, soreness, illness flag, hydration). | High historical churn — see **Tombstones**. |
| `daily_activity` | Canonical movement metrics (steps, exercise minutes, sleep stages). | Marked deprecated Aug 2026 in favor of `daily_vitals_cache`. |
| `daily_vitals_cache` | Morning HealthKit snapshot (HRV, RHR, sleep total, respiratory rate). | New canonical "daily metric" target. |
| `body_metrics` | One row per body-comp measurement (Renpho scale, manual). | — |
| `athlete_profile` | Single-row reference (height, baseline HR, etc.). | — |
| `athlete_zones` | HR zone definitions effective from a date. | — |
| `injuries` | One per active or historic injury. | `body_area` is TEXT, no FK. |

### Goals + planning meta

| Table | Owns | Key FKs |
|---|---|---|
| `goals` | Long-arc training goals. | — |
| `goal_phases` | Phases within a goal. | `goal_id → goals`, `linked_race_id → races` |
| `goal_history` | Audit trail. | `goal_id → goals` |
| `coaching_sessions` | Coach conversation summaries (one per session). | `conversation_id → conversations`, `daily_plan_id → daily_plans` |
| `coaching_retros` | Retrospectives over coaching periods. | — |
| `coaching_snapshots` | Frozen state at coaching-session time. | `coaching_session_id → coaching_sessions` |
| `user_targets` | Daily/period targets the user is held to. | — |
| `gamification_settings` | UI gamification config. | — |
| `badges` | Earned badges. | — |

### Ingestion + integration

| Table | Owns | Notes |
|---|---|---|
| `meals` | One per meal. | Pre/post-meal subjective fields (hunger_before, fullness_after, energy_after). |
| `raw_health_imports` | Dedupe ledger for Apple Health uploads (one per file hash). | — |
| `sync_state` | Per-integration cursor state (Hevy, Bee, etc.). | — |

### Notes + correspondence

| Table | Owns | Key FKs |
|---|---|---|
| `knowledge` | Free-form facts + merged-fact entries. | — |
| `tasks` | TODOs, hierarchical. | `parent_id → tasks`, `recurring_parent_id → tasks` |
| `task_comments` | Comments on tasks. | `task_id → tasks` |
| `conversations` | Bee conversations. | — |
| `transcripts` | Audio transcripts. | — |
| `transcript_speakers` | Speakers per transcript. | `transcript_id → transcripts` |
| `email_threads`, `email_messages` | Email mirror. | `email_messages.thread_id → email_threads` |
| `calendar_events` | Calendar mirror. | — |
| `contacts` | Person directory. | — |
| `activity_log` | Polymorphic audit log. | `entity_id` is intentionally not FK'd. |

---

## Foreign-key coverage

About half of `*_id` columns carry an explicit `REFERENCES` constraint
today. The other half rely on application code for referential integrity.
Known intentional omissions: external IDs (`hevy_id`, `hevy_template_id`,
`bee_id`), the polymorphic `activity_log.entity_id`, and the TEXT-array
"links" on `goals.linked_exercise_names` / `daily_plans.linked_exercise_names`
(these should become junction tables; tracked under **Known design debt**).

---

## Tombstones (dropped columns)

Postgres keeps a permanent attribute slot for every dropped column,
against the 1600-column-per-table ceiling. We track every drop so the
sentinel can detect when one stops succeeding (e.g. a new trigger
re-creates a dependency).

| Table | Column | Dropped in | Snapshot | Recovery |
|---|---|---|---|---|
| `daily_plans` | `planned_exercises` | v1.8.20 | — | Migrated to `plan_segments`. |
| `daily_plans` | `actual_exercises` | v1.8.20 | `metadata.legacy_actual_exercises` | `SELECT metadata->'legacy_actual_exercises' FROM daily_plans WHERE metadata ? 'legacy_actual_exercises'` |
| `daily_plans` | `hevy_routine_id` | v1.8.20 | — | Migrated to `plan_segments.hevy_routine_id`. |
| `workouts` | `pace_avg` | v1.9.4 | — | Derive from `duration_minutes` / `distance_value`. |
| `workouts` | `splits` | v1.9.4 | — | Will move to `plan_segments` if reintroduced. |
| `workouts` | `cadence_avg` | v1.9.4 | — | Numeric `cadence` is canonical. |
| `workouts` | `adjustment` | v3.33 | `metadata.legacy_adjustment` | `SELECT metadata->>'legacy_adjustment' FROM workouts WHERE metadata ? 'legacy_adjustment'` |
| `daily_context` | `day_type`, `energy_rating`, `hunger_rating`, `recovery_rating`, `body_weight_lb`, `cravings`, `digestion`, `tags` | various | — | Design churn — these columns were added then removed. |
| `daily_vitals_cache` | `sleep_deep_min`, `sleep_rem_min`, `sleep_core_min`, `sleep_awake_min`, `wrist_temp_c`, `spo2_pct`, `source_device`, `is_stale` | various | — | Series-3 watch can't supply these. |
| `meals` | `fiber_g`, `sugar_g`, `sodium_mg`, `serving_size` | v1.9.4 | — | Simplified to calorie + macro tracking. |
| `injuries` | `treatment`, `tags` | v1.9.4 | — | `treatment` replaced by `modifications` + `prevention_notes`. |
| `coaching_sessions` | `training_plan_id` | (early) | — | — |
| `races` | `expected_weather`, `goal_process` | v1.9.4 | — | — |
| `fueling_rehearsals` | `g_caffeine_total` | v1.9.4 | `mg_caffeine_total` | — |

The drift detector at `GET /api/health/diag/deprecated-columns` will return `schema_drift_count: 0` when the live schema matches this table.

---

## Known design debt

Honest list of where the schema disagrees with relational best practice.
None are imminent failures; tracked here so future rebuilds don't lose
the context.

### Hidden relations (JSONB blobs that should be junction tables)

- `workouts.exercises` — array of exercise objects with names, sets,
  reps, weights. Should be a `workout_exercises` table with FK to
  `exercises.id`. Filtering "show workouts with Deadlift" today requires
  JSONB containment instead of a JOIN.
- `plan_segments.planned_exercises` — same shape, same problem, for the
  planned (vs. executed) side.
- `coaching_sessions.adjustments` — array of `{type, exercise, detail,
  reason}` objects. No audit trail of who made each adjustment when.
- `goals.linked_exercise_names`, `daily_plans.linked_exercise_names` —
  `TEXT[]` arrays of exercise names. Stringly-typed FKs to
  `exercises.name`. Typo-fragile.
- `gym_profiles.equipment` — TEXT array; should be a junction with
  `equipment_catalog`.

### Stringly-typed lookups

- `exercises.primary_muscle_groups` / `secondary_muscle_groups` — TEXT,
  should be join to a muscle-groups lookup.
- `exercises.equipment` — TEXT, should be an `exercise_equipment`
  junction.
- `injuries.body_area` — TEXT, should be FK to a `body_areas` lookup.

### God tables

- `workouts` at 54 live columns conflates: core session, cardio metrics,
  TEXT/numeric duplicates (`time_duration` + `duration_minutes`,
  `heart_rate_avg` + `hr_avg`, etc.), TSS/training-load analysis,
  Hevy sync state, and per-body-area feedback (`grip_feedback`,
  `legs_feedback`, `cardio_feedback`, `shoulder_feedback`). A clean split
  would be `workouts` (core) + `workout_metrics` (results) +
  `workout_feedback` (body-area 1NF) + a Hevy-sync row.

### Daily-namespace overlap

`daily_context` (subjective), `daily_activity` (movement, **deprecated**),
and `daily_vitals_cache` (HealthKit snapshot) all key on a single date.
The deprecation comment on `daily_activity` (Aug 2026) signals the
intended consolidation toward `daily_vitals_cache`, but the migration
isn't done; routes still UNION both tables.

### Daily-context misplacement

`cravings`, `digestion`, `hydration_liters`, `alcohol_units`,
`supplement_change_note` — all on `daily_context` today, all about
nutritional state. Cleaner home would be `meals` (post-meal symptoms) or
a dedicated nutrition log.

---

## Migration patterns

Conventions the code follows:

1. **Idempotent boots.** Every `ALTER TABLE` in `initDB()` uses
   `IF NOT EXISTS` (additions) or `IF EXISTS` (drops). Boot is safe to
   re-run.
2. **Snapshot before drop.** When a drop will lose data, the value is
   first copied into `metadata.<legacy_key>` for forensic recovery. See
   `workouts.adjustment → metadata.legacy_adjustment` (v3.33) and
   `daily_plans.actual_exercises → metadata.legacy_actual_exercises`
   (v1.8.20) for the pattern.
3. **`safeQuery` wraps everything.** Errors during `initDB` log to
   stderr and continue — boot doesn't fail. This is by design (a fresh
   DB shouldn't fail on a migration that depends on an existing row).
   But it also means migrations can silently fail; the drift detector is
   how we catch that.
4. **Triggers must not pin dropped columns.** A trigger that references a
   column blocks `DROP COLUMN`. When dropping a column, the trigger
   function and DDL get updated in the same release. See the v3.33 fix
   for `update_workouts_search()`.
5. **No silent ENUMs.** Status/type fields are TEXT with `CHECK`
   constraints. Native ENUMs would be cleaner; tracked under design debt.
