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
The deprecation comment on `daily_activity` (Aug 5, 2026) signals the
intended consolidation toward `daily_vitals_cache`. Routes UNION both
tables today via FULL OUTER JOIN; daily_vitals_cache values win on
overlap. See **Phase E plan** below for the consolidation script + the
columns-without-a-home tradeoff.

#### Phase E plan — daily_activity → daily_vitals_cache (v3.34 #2 decided)

**Operator decision:** option 2 selective. Absorb movement + energy
into `daily_vitals_cache`; accept the loss on sleep-phase and
walking/mobility (Series 3 watch can't supply them — null going
forward).

| Source column (`daily_activity`) | Destination (`daily_vitals_cache`) | Status |
|---|---|---|
| `activity_date` | `date` | Mapped (join key) |
| `hrv_sdnn_ms` | `hrv_ms` | **Mapped — recovery vital** |
| `resting_hr_bpm` | `rhr_bpm` | **Mapped — recovery vital** |
| `sleep_total_min` | `sleep_total_min` | **Mapped — recovery vital** |
| `respiratory_rate_avg` | `respiratory_rate_bpm` | **Mapped — recovery vital** |
| `steps` | `steps` | **Mapped — movement (v3.34 #2)** |
| `distance_mi` | `distance_mi` | **Mapped — movement (v3.34 #2)** |
| `exercise_minutes` | `exercise_minutes` | **Mapped — movement (v3.34 #2)** |
| `flights_climbed` | `flights_climbed` | **Mapped — movement (v3.34 #2)** |
| `workout_count` | `workout_count` | **Mapped — movement (v3.34 #2)** |
| `active_energy_kcal` | `active_energy_kcal` | **Mapped — energy (v3.34 #2)** |
| `basal_energy_kcal` | `basal_energy_kcal` | **Mapped — energy (v3.34 #2)** |
| `sleep_deep_min`, `sleep_rem_min`, `sleep_core_min`, `sleep_awake_min`, `sleep_efficiency_pct` | — | **Accepted loss** — Series 3 can't supply; null going forward |
| `walking_hr_avg_bpm`, `vo2_max`, `walking_speed_mph`, `walking_steadiness_pct`, `walking_asymmetry_pct`, `walking_step_length_in`, `stand_hours`, `stand_minutes` | — | **Accepted loss** — same hardware constraint |

**Execution sequence:**

1. `db.js` adds the 7 movement + energy columns to `daily_vitals_cache`
   via additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Auto-runs
   on next deploy.
2. Operator runs `scripts/consolidate-daily-activity-to-vitals.js`
   (dry, inspect, `--apply`). Backfills 11 fields total from
   historical `daily_activity` rows into `daily_vitals_cache`.
3. Operator runs `scripts/drop-daily-activity-movement-cols.js` (dry,
   inspect, `--apply`). Pre-flight blocks if any `daily_activity` row
   still has data not mirrored in `daily_vitals_cache`. On apply,
   drops the 7 source columns from `daily_activity`.
4. (Aug 5, 2026) `daily_activity` itself is dropped, taking the
   sleep-phase + walking/mobility columns with it.

After step 3, `daily_vitals_cache` is the canonical source for movement
+ energy. The `/diag/full-day` SELECT in `routes/health.js` already
uses a `FULL OUTER JOIN` with `COALESCE` so it survives transparently
across the transition (cache wins on overlap, daily_activity provides
fallback only until its columns drop).

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
6. **Table-level rebuilds for tombstone reclamation.** When add/drop
   churn has cost a table N attribute slots, the only way to reclaim
   them is to rebuild the table inside a transaction (CREATE v2,
   INSERT, assert row-count + checksum match, DROP old, RENAME v2 in).
   See `scripts/rebuild-daily-context.js` for the v3.33 reference
   implementation. Dry-run by default; `--apply` commits.

---

## Source-to-field coverage map

The wide `daily_context` table wasn't just a slot problem — fields could get silently missed because there was no clean home and no signal when expected data wasn't arriving (HRV/RHR/respiratory rate were the classic example). This section makes coverage explicit: per source, what's captured, where it lands, and what gaps exist.

**Methodology:** ground truth is what `routes/*.js` actually writes (INSERT/UPSERT statements) and what `db.js` declares. "Captured" means an active code path populates a column. "Gap" means either: column exists but no ingest writes to it, or the source provides data we want but no column receives it.

### Gaps & wishlist (action items)

Ranked by importance. Each gap is grounded in code state (column exists / column missing / ingest wired / ingest missing) — not speculation.

| # | Gap | Severity | What's true today | What would close it |
|---|---|---|---|---|
| 1 | **Forward-going movement after Aug 5 daily_activity drop** | HIGH | `POST /api/v2/daily-vitals` only accepts 4 fields (hrv, rhr, sleep_total, resp_rate) — see `routes/v2-vitals.js:20-24`. Movement (steps, distance, exercise_min, flights, energy) flows ONLY via `daily_activity` from HAE today. v3.34 #2 absorbs historical data into `daily_vitals_cache` but doesn't establish a new write path. | Extend the iOS Shortcut to POST movement+energy fields too, and extend `validateBody` in `v2-vitals.js` to accept them. OR keep HAE as a secondary post-Aug 5 ingest specifically for these fields. |
| 1b | **`workouts.hr_zones` null on most runs (silent skip)** | HIGH | `computeHrZonesForWorkout` returns null for 4 distinct reasons (no started_at, no samples, no `athlete_zones` row, no sample-window match); the ingest sites at `routes/health.js` previously just moved on, no signal. Raw per-second HR confirmed intact in Apple Health for the affected workouts, but never pulled into `metadata.heartRateData` because the workout was created via a sample-less path (Format A summary, or Format D payload without the HR-stream metric). v3.34 wraps every ingest-site call in `attemptZoneCompute` (records outcome to `lib/zone-compute-log`); `/diag/deprecated-columns` surfaces `zone_compute_skip_count` so silent skips are now visible. | (a) Operator review of `zone_compute.by_outcome` after a normal sync — pattern reveals which iOS path is dropping samples (`skipped_no_samples` = HR stream not exported; `skipped_no_zones_row` = athlete_zones gap; etc.). (b) Historical backfill = per zone-less workout, fetch HR stream from Apple Health via Shortcut → `POST /api/workouts/:id/hr-samples` (existing endpoint, computes + persists zones in one shot). The `/diag/hr-sample-coverage?days=N` endpoint lists exactly which workouts need it. |
| 2 | **Series 3 sleep-stage loss accepted but not telemetered** | MEDIUM | Sleep stages dropped from `daily_vitals_cache` in v1.9.4 (Series 3 can't supply). Code shows "—" in UI when fields are null but doesn't surface "hardware gated, won't appear" to user. | Add a small banner / API field `hardware_capability` so the absent fields are explained rather than just blank. |
| 3 | **VO2max captured but sparse** | MEDIUM | `daily_activity.vo2_max` exists and is written by Format B/D parsers (`routes/health.js:408, 673`). Apple emits rarely (needs specific workout shape on Series 5+). After Aug 5 drop, no destination column. | Add `daily_vitals_cache.vo2_max NUMERIC(4,1)` and extend the consolidate script + Shortcut. Low write frequency means low slot cost. |
| 4 | **Bee transcript health mentions never parsed** | LOW | Voice transcripts are stored as `raw_text` + `summary`. No code path extracts "ran 5 miles", "slept poorly", "felt sore in left knee" into structured records. Today these are search-only. | Optional NLU pass at ingest time → propose creating `workouts` / `injuries` / `meals` rows. Coach-confirmation flow rather than auto-write. |
| 5 | **Meal subjective (hunger_before, fullness_after, energy_after) captured but unread** | LOW | `meals` table has the columns; POST endpoints accept them. No analytics or coach surface reads them (verified by grep). | Add insights endpoint that surfaces patterns (e.g. "high fullness_after + low energy_after on training days → macro rebalance suggestion"). |
| 6 | **Garmin / Whoop / Oura / Strava** | LOW | No `routes/garmin.js`, no `routes/whoop.js`, etc. Some users export via Apple Health (covers basics) but no direct sync. | Only worth wiring if user actively uses one of these devices. Track demand before building. |
| 7 | **Cycling power, running power (watts)** | LOW | Apple HealthKit emits these for supported devices. No column anywhere. | Add `workouts.power_avg`, `workouts.power_max` if a power meter enters the stack. |

### Apple Health (via Health Auto Export)

Four parallel ingest formats in `routes/health.js`. Authority rules: Format A is authoritative for movement; Formats B/D are authoritative for recovery + mobility. Sleep gets a dedicated branch in each format (not a simple metric-map entry).

| Field | Lands in | Wired via | Notes |
|---|---|---|---|
| HR samples (per-second during workout) | `workouts.metadata.heartRateData`, then derived `workouts.hr_zones` | Format B/D ingest (samples-bearing payloads only) + `computeHrZonesForWorkout` via `attemptZoneCompute`; `POST /api/workouts/:id/hr-samples` for re-ingest. **Format A creates workouts with NO samples** (summary-only payload). | **Partial coverage.** See gap #1b — `workouts.hr_zones` null on most runs because the iOS path doesn't reliably attach the HR stream to every workout payload. Silent skips now surfaced via `zone_compute` in the sentinel. |
| Resting HR | `daily_activity.resting_hr_bpm` | Format B `routes/health.js:404`, Format D line 669 | Active ingest. Backfilled to `daily_vitals_cache.rhr_bpm` by v3.34 Phase E script. |
| HRV (SDNN) | `daily_activity.hrv_sdnn_ms` | Format B line 401, Format D line 668 | Mapped to `daily_vitals_cache.hrv_ms` |
| Respiratory rate | `daily_activity.respiratory_rate_avg` | Format B line 407, Format D line 672 | Mapped to `daily_vitals_cache.respiratory_rate_bpm` |
| VO2max | `daily_activity.vo2_max` | Format B line 408, Format D line 673 | **No `daily_vitals_cache` home** — see gap #3 |
| Walking HR avg | `daily_activity.walking_hr_avg_bpm` | Format B line 405, Format D line 670 | Series 3 supplies. Will be lost post-Aug-5 drop (option-2 accepted). |
| Steps | `daily_activity.steps` | Format A authoritative, B/D fill-only | Backfilled to `daily_vitals_cache.steps` by v3.34 #2 |
| Distance (mi) | `daily_activity.distance_mi` | Format A auth, B/D fill | Backfilled to `daily_vitals_cache.distance_mi` |
| Exercise minutes | `daily_activity.exercise_minutes` | Format A auth, B/D fill | Backfilled to `daily_vitals_cache.exercise_minutes` |
| Flights climbed | `daily_activity.flights_climbed` | Format A auth, B/D fill | Backfilled to `daily_vitals_cache.flights_climbed` |
| Stand hours, stand minutes | `daily_activity.{stand_hours, stand_minutes}` | Format D line 662-663 | Series 3 supplies; will be lost post-Aug-5 |
| Active energy (kcal) | `daily_activity.active_energy_kcal` | Format A auth, B/D fill | Backfilled to `daily_vitals_cache.active_energy_kcal` |
| Basal energy (kcal) | `daily_activity.basal_energy_kcal` | Format A auth, B/D fill | Backfilled to `daily_vitals_cache.basal_energy_kcal` |
| Walking gait cluster (speed, asymmetry, steadiness, step length) | `daily_activity.walking_*` | Format B lines 411-416, Format D lines 676-679 | Series 3 doesn't supply all; partial coverage. Will be lost post-Aug-5 (option-2 accepted). |
| Body mass / BMI / body fat / lean mass | `body_metrics.{weight_lb, bmi, body_fat_pct, lean_mass_lb}` | Format B lines 428-431, Format D lines 683-688 | Dedupes against RENPHO via `POST /api/health/merge-duplicate-body-metrics` |
| Sleep total + stages (deep/REM/core/awake/efficiency) | `daily_activity.sleep_*_min` | Format B sleep branch, Format D sleep branch, Format C | Stages dropped from `daily_vitals_cache` v1.9.4 (Series 3 can't supply) |
| Workouts (cardio/outdoor) | `workouts.*` | Format A `parseFormatA`, Format D workouts parser | Dedupes against Hevy entries via time+type overlap |
| **NOT captured:** SpO2, wrist temp, ECG/AFib, irregular rhythm, sleep stages on Series 3 | — | — | Hardware-gated; columns dropped or never added |

### Hevy (workout sync)

Source of truth for strength training. Pull-only (Hevy → Forge) plus a body-measurement push (Forge → Hevy).

| Field | Lands in | Wired via | Notes |
|---|---|---|---|
| Workout id, start, end, title | `workouts.{hevy_id, started_at, ended_at, title, workout_date, duration_minutes}` | `mapHevyWorkoutToAB`, `routes/hevy.js:287-356` | `hevy_id` is the dedupe key for re-sync idempotency |
| Description / notes | `workouts.body_notes` | Smart 3-way merge `routes/hevy.js:1529-1541` | Hevy edits respected unless user manually edited Forge's body_notes post-sync |
| Exercises + sets (weight, reps, RPE, rest) | `workouts.exercises` (JSONB) + `metadata.hevy.raw_exercises` | `transformHevyExercises`, `routes/hevy.js:248-285` | kg→lb at ingest. **JSONB-hidden 1:N relation** — see "Known design debt" |
| Total volume (lb), total sets | `workouts.{total_volume_lb, total_sets}` | Computed at ingest | Strength load proxy |
| Effort (1-10, derived from max RPE) | `workouts.effort` | `deriveEffortFromRpe`, audit trail in `metadata.hevy.derived_effort_from_max_rpe` | v3.16 feature |
| **NOT captured:** set notes, distance per set | — | Set-level fields beyond {weight, reps, rpe, rest} discarded by transform | Low value for strength focus |

### RENPHO scale (body composition)

Direct POST from RENPHO companion app (or manual). Comprehensive — all BIA outputs captured.

| Field | Lands in | Wired via | Notes |
|---|---|---|---|
| Weight, BMI, body fat %, fat-free mass, lean mass, muscle mass, bone mass | `body_metrics.{weight_lb, bmi, body_fat_pct, fat_free_mass_lb, lean_mass_lb, muscle_mass_lb, bone_mass_lb}` | `POST /api/body-metrics` (`routes/body-metrics.js:75-200`) | All directly mapped |
| Subcutaneous fat %, visceral fat, body water %, skeletal muscle %, protein % | `body_metrics.{subcutaneous_fat_pct, visceral_fat, body_water_pct, skeletal_muscle_pct, protein_pct}` | Same endpoint | BIA breakdown |
| BMR, metabolic age | `body_metrics.{bmr_kcal, metabolic_age}` | Same endpoint | Vendor-computed |
| Measurement context, vendor user mode, notes | `body_metrics.{measurement_context, vendor_user_mode, notes}` | Same endpoint | Free-text |
| Dedupe with Apple Health body-mass entries | — | `POST /api/health/merge-duplicate-body-metrics` | RENPHO wins (richer fields) |

### Bee transcripts (voice)

Captured as raw + summary, not parsed into structured records.

| Field | Lands in | Wired via | Notes |
|---|---|---|---|
| Title, raw_text, summary, duration_seconds, recorded_at, location, tags, metadata | `transcripts.*` | `POST /api/transcripts` | Direct mapping |
| Speakers + utterances + timestamps + confidence | `transcript_speakers.*` (FK to transcripts) | `autoIdentifySpeakers` (AI-inferred — Bee doesn't supply names) `routes/bee.js:19-175` | OpenAI-driven |
| **NOT captured:** structured nutrition / workout / injury mentions | — | No NLU pass extracts them | See gap #4 |

### Shortcut iOS (v2-vitals daily POST)

Replaces HAE for forward-going recovery data. Intentionally minimal — Shortcut owns the HealthKit query semantics on-device.

| Field | Lands in | Wired via | Notes |
|---|---|---|---|
| date | `daily_vitals_cache.date` (PK) | `POST /api/v2/daily-vitals` `routes/v2-vitals.js:56` | YYYY-MM-DD |
| hrv_ms, rhr_bpm, sleep_total_min, respiratory_rate_bpm | `daily_vitals_cache.{hrv_ms, rhr_bpm, sleep_total_min, respiratory_rate_bpm}` | Same endpoint, validated at lines 20-24 | At least one required, all optional |
| **NOT captured:** steps, distance, exercise_minutes, flights_climbed, active_energy_kcal, basal_energy_kcal, workout_count | — (cache columns exist but no v2-vitals path writes them) | `daily_activity` is the current write path | **See gap #1** — critical post-Aug 5 |
| **NOT captured:** sleep_deep/rem/core/awake, SpO2, wrist temp | — | Series 3 hardware-gated | Accepted loss |

### Manual API endpoints

| Source | Destination | Wired via |
|---|---|---|
| Workout POST/PATCH | `workouts.*` | `routes/workouts.js` |
| Meals POST | `meals.*` | `routes/meals.js:171-199` |
| Daily check-in POST | `daily_context.{sleep_hours, sleep_quality, hydration_liters, mood, motivation, soreness_overall, life_stress, illness_flag, ...}` | `routes/nutrition.js`, `routes/coach.js` |
| Body metrics POST | `body_metrics.*` (when RENPHO not available) | `routes/body-metrics.js` |
| HR samples POST (per-workout HealthKit dump) | `workouts.metadata.heartRateData` → `workouts.hr_zones` | `POST /api/workouts/:id/hr-samples` (v3.23) |

---

## Operational scripts

| Script | Purpose | Default |
|---|---|---|
| `scripts/rebuild-daily-context.js` | Reclaim the 8 tombstoned attribute slots on `daily_context` by rebuilding the table. Transactional, with row-count and md5 checksum assertions; rolls back on any mismatch. | Dry run; pass `--apply` to commit. |
| `scripts/consolidate-daily-activity-to-vitals.js` | Backfill `daily_vitals_cache` rows from `daily_activity` for the 11 mapped fields (4 vitals + 5 movement + 2 energy per v3.34 #2 selective absorb). Idempotent — cache values always win on overlap. Prerequisite to `scripts/drop-daily-activity-movement-cols.js`. | Dry run; pass `--apply` to write. |
| `scripts/drop-daily-activity-movement-cols.js` | Drop the 7 movement + energy columns from `daily_activity` AFTER the consolidate script has backfilled them. Pre-flight blocks if any `daily_activity` row still has data not in `daily_vitals_cache`. | Dry run; pass `--apply` to write. |
| `scripts/backfill-hr-zones-from-metadata.js` | Derive `workouts.hr_zones` from `metadata.heartRateData` for rows missing it. | Dry run; pass `--apply` to write. |

When operating these in production, always run dry-run first and
inspect the output. The drift detector at
`GET /api/health/diag/deprecated-columns` confirms the post-state.
