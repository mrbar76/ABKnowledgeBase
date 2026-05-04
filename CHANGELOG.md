# AB Brain — Changelog

All notable changes to the AB Brain platform are documented here.

---

## [1.8.22] — 2026-05-04

### Apple-stale auto-rescue + HAE paste-import

User flagged: yesterday's OUT showed 1,757 kcal, but Apple Fitness clearly logged 3,500+ kcal total burned. Diagnosis: `daily_activity.active_energy_kcal = 9` for May 3 in our DB (HAE hadn't pushed the day's complete export), while logged workouts summed to 334 kcal active. Workouts are a strict subset of daily active — `workoutActive > haeActive` is impossible if Apple is fresh, so it's an integrity violation that proves staleness.

**Auto-rescue (backend):** in both `/insights/nutrition` and `/trends`, when `workoutActive > haeActive`:
- Floor `active = workoutActive` so OUT doesn't fall below logged training
- Set `active_source = 'workouts_floor_stale_apple'`
- Set `apple_stale = true` on the day's row
- NEAT clamped to 0 (we can't separate workouts from ambient when Apple's daily total is unknown — don't fabricate)

**Frontend:** macros card surfaces a `⚠ Apple Health stale — open HAE on iPhone to refresh today's totals` chip below the OUT breakdown when `apple_stale` is true. NEAT is suppressed in the breakdown line in stale state.

**HAE paste-import (UX):** new Settings card "Paste HAE Export" — textarea + button. User pastes any HAE JSON (e.g., from iPhone HAE → Sample Export, or from another tool that has the raw payload) and it POSTs directly to `/api/health/ingest`. Fixes the same-day staleness issue without waiting for HAE's scheduled cadence. Idempotent via existing file-hash dedup.

### Per-date workout active sum in /trends
Was today-only; now SUM-grouped across all dates. Past days couldn't trigger the stale rescue before because `workoutActive` was always 0 there.

### Out of scope
- Cross-source dedupe pass for the Spartan/Hiking duplicate (manual race entry without `started_at` colliding with Apple "Hiking" auto-detect on Apr 26). Need the diag JSON to fix precisely.

---

## [1.8.21] — 2026-05-04

### Footer mismatch + Reparse 502 timeout

After v1.8.20a deployed, two loose ends remained:

**1. Footer label still showed "AB Brain v2.0.0"**
- The `<span id="sm-version">` is overwritten on Settings open: `loadSettingsMenuInfo()` calls `/api/health-check` and writes `'v' + data.version`.
- `/api/health-check` reads `require('./package.json').version` — which was still `2.0.0` from the original Coach release.
- Hardcoding the span in HTML had no effect because the JS runs after.
- Fixed by bumping `package.json` to `1.8.21`. Single source of truth now: package.json drives the footer.

**2. `POST /api/health/reparse` returned 502**
- The endpoint loops through every stored `raw_health_imports` row synchronously. With ~36 payloads × `processPayload` (each one runs Format A/B/C/D parsing, multi-table upserts, dedupe), the request blew past the Railway proxy's ~30s ceiling.
- Reworked to chunk: accepts `?limit=N&offset=M` (capped at 25/call, default 5). Returns `total`, `next_offset` (null when done), and the per-chunk `results[]`.
- Final-chunk-only triggers `dedupeAppleWorkouts()` + `recomputeMissingTss()` so we don't waste cycles re-deduping after every page.
- Frontend `reparseHealthImports()` now iterates: kicks off chunk 0, posts each next batch when the prior returns, updates the result line with `Reparsing… X/N`, stops on `next_offset == null`. Hard cap of 200 iterations as a safety.

### Out of scope
- Background job queue with persistent state (current chunked approach is fine for ≤500 payloads).
- Single-payload reparse (`{ file_hash }` body) still runs in one shot — single payload doesn't hit the timeout.

---

## [1.8.20] — 2026-05-04

### Schema cleanup — three deprecated daily_plans columns dropped

v1.8.19 audit verdict:
- `planned_exercises`: 1 row, **0 unmirrored** → safe drop
- `actual_exercises`: 3 rows, never mirrored → stash + drop
- `hevy_routine_id`: 0 rows → trivial drop

### Migration sequence (idempotent)

1. **Stash `actual_exercises` into `metadata.legacy_actual_exercises`** for any row with non-empty data. Guarded by `NOT (metadata ? 'legacy_actual_exercises')` so it only runs once. The 3 audit rows are preserved indefinitely under that key — recoverable via `SELECT id, plan_date, metadata->'legacy_actual_exercises' FROM daily_plans WHERE metadata ? 'legacy_actual_exercises'`.
2. **`ALTER TABLE daily_plans DROP COLUMN IF EXISTS planned_exercises`**
3. **`ALTER TABLE daily_plans DROP COLUMN IF EXISTS actual_exercises`**
4. **`ALTER TABLE daily_plans DROP COLUMN IF EXISTS hevy_routine_id`**

Backfill query (line 1393) wrapped in `information_schema` column-exists check so it doesn't error after the drop or on fresh DBs that never had the columns.

### Other schema hygiene
- Removed the deprecated `ALTER TABLE ADD COLUMN` statements for the three columns. Fresh DBs no longer create them in the first place.
- `/api/health/diag/deprecated-columns` updated to report post-drop state. Now tells you whether each column still exists, plus how many rows have data preserved in the metadata stash.

### Schema is now the canonical shape
Coach reading the API surface or running raw SQL no longer sees three different stale fields competing with the canonical `plan_segments` location. The schema map matches the documented architecture.

---

## [1.8.19] — 2026-05-04

### Schema audit before drop (Tier 1 cleanup, paused safely)

User asked to drop the three deprecated `daily_plans` columns (`planned_exercises`, `actual_exercises`, `hevy_routine_id`). I started writing the DROP COLUMN migration, then paused when asked "I'm assuming I haven't lost valuable data?" — good call. Audit first, drop in v1.8.20.

**Risk profile per column:**
- `planned_exercises` — has a backfill into `plan_segments` (line 1393, idempotent). Risk only exists if a daily_plan has populated `planned_exercises` AND has plan_segments WITHOUT mirrored exercise data. Probably zero rows but worth checking.
- `hevy_routine_id` — same backfill mirrors it to `plan_segments.hevy_routine_id`. Same minimal risk.
- `actual_exercises` — **never had a backfill.** If Coach wrote actual workout structure here pre-v1.8.1 without also POSTing to `/api/workouts`, that data is unique to this column. **Dropping without migration would lose it.**

### Added — `GET /api/health/diag/deprecated-columns`

Reports per-column:
- `rows_with_data` — count of daily_plans rows with non-empty values
- `rows_NOT_mirrored_*` — count of rows whose data is unique (would be lost on drop)
- `unmirrored_sample` — up to 50 example rows with `id`, `plan_date`, exercise count
- Plain-language `verdict`: `"SAFE TO DROP"` or `"RISK — N row(s) ..."`

Settings → **Audit Deprecated Columns** button. Output goes to the same textarea used by the other diagnostic dumps.

### Schema convention docs (Tier 2 partial)

Added a "Schema convention — dual-representation columns on workouts" section to `claude-schema.json` description. Explains the TEXT (display, with units) vs NUMERIC (query, raw number) duals on `time_duration`/`duration_minutes`, `distance`/`distance_value`, etc. Coach now has the explicit guide.

Updated `claude-schema.yaml`: removed the dead `actual_exercises` field block, replaced with a comment explaining workouts FK-link to plan_segments instead.

### What you do
1. Deploy v1.8.19
2. Settings → Audit Deprecated Columns
3. Paste the JSON to me
4. Based on the numbers, I either:
   - Ship v1.8.20 with safe `DROP COLUMN` for columns that show zero risk
   - Build a migration that copies `actual_exercises` data into a useful place first, THEN drops

---

## [1.8.18] — 2026-05-04

### Fixed — three findings from the v1.8.17 diagnostic dump

User pulled `/api/health/diag/workouts?days=30` (51 rows, 28 anomalies). Three actionable issues:

1. **Today's PT row didn't merge into the Hevy parent (93% time overlap, should have).** Root cause: dedupe ran at the end of HAE ingest only. Hevy /sync added rows AFTER and didn't trigger dedupe. → **Wired `dedupeAppleWorkouts()` into Hevy /sync** (after `inserted+updated > 0`). Lazy-loaded via `require('./health')` to avoid circular import.

2. **PT/Mobility Block row tagged `workout_type='recovery'`, not `mobility`.** v1.8.16 added the mobility branch to `normalizeWorkoutType` but only at write time — existing rows kept their stale type. → **Catch-up migration in `POST /api/health/cleanup-now`**: re-runs the classifier on every row's title from the last 90 days; only updates when the new type differs and isn't `other`.

3. **Legacy `"🔥 Hybrid Sun May 03 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"` titles still on disk.** v1.8.0 stopped *generating* this format but didn't fix existing rows. → Same `cleanup-now` endpoint detects rows with `'GMT+0000'` AND `'Coordinated Universal Time'` in title, rewrites to `"May 3 — Hybrid"` (the v1.8.0 format).

### Added — Settings → Run Cleanup Migrations button
One click runs all three catch-up migrations. Idempotent. Result panel shows `Deduped N · re-classified M · titles fixed K`.

### Bug #4 (synthetic wrapper) confirmed not a bug
Today's `2751fa34` is a real Hevy-sourced row (`source='hevy'`, `hevy_id=f79f...`). Coach's hypothesis that it was an AB Brain auto-creation was wrong. The misleading "🔥 Hybrid" title came from the legacy Hevy routine name, fixed by the title cleanup above.

### Apr 26 Vernon double-count remains a manual-data issue
The two rows have the same duration/distance/calories but `started_at` 4 hours apart (manual entry typo on the 19:42 UTC row). Dedupe correctly doesn't merge non-overlapping windows. User needs to update the manual row's `started_at` to match Apple Watch (`15:47 UTC`).

---

## [1.8.17] — 2026-05-03

### Fixed — Path B importer writing seconds into duration_minutes column

Coach's deep audit of 63 workout records found **8 rows where `duration_minutes` exactly matched `(ended_at − started_at) seconds`** (e.g. stored 324, true 5.4 min, true 324 seconds). Root cause: the SQL backfill in `db.js:653` used a `<= 12` heuristic to disambiguate `h:mm` from `mm:ss`, which fails for any sub-1-hour mm:ss duration where mm ≤ 12 (every walk under an hour, basically).

- **`backfill duration_minutes v3`** — anchored regex matching v1.8.16's JS fix. Three-segment `^\d+:\d{1,2}:\d{1,2}$` → `h*60 + m + ROUND(s/60)`. Two-segment `^\d+:\d{1,2}$` → `m + ROUND(s/60)`. Two-segment ALWAYS treated as mm:ss (the format `formatDuration()` emits).
- **`correct duration_minutes from timestamps`** migration — for any row where `started_at` and `ended_at` both exist, `duration_minutes = ROUND((end − start) / 60)`. Skips rows already correct (within ±2 min). This corrects legacy rows polluted by the v2 backfill bug.

### Fixed — literal "nan" string in HR columns

Coach's audit: Vernon walking record had `hr_avg = 'nan'` (literal string), because Python's NaN got string-coerced when an importer averaged an empty list. Two fixes:
- **`sanitizeHrText()` helper** at every HR write site in `routes/health.js`. Treats `nan/null/none/-/undefined` as null. Returns `Math.round(n)` as string for finite positive numbers only.
- **`cleanup nan-string heart_rate` migration** — nulls existing rows where `lower(heart_rate_avg) IN ('nan','null','none','-')`. Same for hr_max.

### Added — diagnostic endpoints + Settings UI

- **`GET /api/health/diag/workouts?days=N`** — returns last N days of workout rows with anomaly detection (seconds-as-minutes, NaN strings, missing hae_id, no HR samples, etc.). For paste-back analysis.
- **`GET /api/health/diag/full-day?date=YYYY-MM-DD`** — comprehensive cross-table audit for one date. Pulls workouts + daily_activity + meals + body_metrics + daily_plans + plan_segments + coaching_sessions + daily_context + raw_imports. Detects anomalies AND overlapping workout windows (>50%). Built for "deep dive" sessions when something doesn't match.
- **Settings → Workout Data Review card** — three buttons (7d/14d/30d) for the workouts dump, plus a date picker for the full-day audit. Output goes into a textarea you can copy to share with Coach / Claude Code.

### Bug #4 (Hevy rows tagged source=apple_health) downgraded
No code path auto-creates workout rows on plan completion. Coach's hypothesis was speculative. Today's `2751fa34` synthetic wrapper has unknown origin — needs the new diagnostic endpoint to trace. Removing from the active bug list until reproduced.

---

## [1.8.16] — 2026-05-03

### Coach bugs #2, #5, #6 fixed (#4 self-heals via v1.8.15 dedupe)

**Bug #2 — seconds-as-minutes regression.** `parseDurationMin` matched both `h:mm:ss` and `mm:ss` against the same loose regex. A 354-second walk that `formatDuration` wrote as `"5:54"` got re-parsed as **354 minutes** (5h × 60 + 54). Two-segment time strings now require `^(\d+):(\d{1,2})$` (anchored, exactly 2 segments) and resolve as `min + sec/60`. Three-segment strings stay `h*60 + m + s/60`.

| Input | Old | New |
|---|---|---|
| `"5:54"` (mm:ss) | 354 min ❌ | 6 min ✓ |
| `"23:45"` (mm:ss) | 1425 min ❌ | 24 min ✓ |
| `"1:30:00"` (h:mm:ss) | 90 min ✓ | 90 min ✓ |
| `"45 min"` | 45 ✓ | 45 ✓ |

**Bug #5 — PT/Mobility tagged as strength.** `normalizeWorkoutType` had no mobility/PT/yoga branches, so titles like `"PT/Mobility Block (Cascade Prophylaxis)"` fell through to `'other'` (or got mistagged via the loose `strength` substring match). Added explicit branches **before** strength: mobility, stretch, yoga, PT, foam, prehab, rehab. Also reordered cooldown/warmup before walk/run so `"Cool Down Walk"` resolves to `cooldown`, not `walking`.

**Bug #6 — "Forearm Rebuild" auto-title despite memory edit.** Not in any code template — Coach was freeform-generating the phrase from old training context. Added a skill rule in `morning-check-in.skill`: do NOT inject body-part rehab terminology into titles unless that injury is currently in `active_injuries[]` with severity ≥ 1. Default to neutral labels (`Mobility Block`, `PT/Mobility`, `Recovery Work`). The cascade-prophylaxis programming logic still applies; only the *titling* changes.

**Bug #4 — Hevy rows tagged `source: apple_health`.** Likely an artifact of pre-dedupe data: Apple Watch auto-detected the strength session before Hevy /sync ran, so the row existed with source='apple_health' until dedupe. v1.8.15's overlap-based dedupe collapses Apple children into the Hevy parent, leaving the surviving row with `source='hevy'`. After deploy + reparse + dedupe pass, this self-corrects. Will revisit if it persists with fresh data.

### Tests
- `tests/duration-and-classification.test.js` — 8 new tests (mm:ss vs h:mm:ss, word-form durations, mobility/strength/cardio classification, cooldown/warmup ordering)
- 33/33 passing across all test files

---

## [1.8.15] — 2026-05-03

### Architecture fix per Coach spec — energy accounting boundaries

Coach's diagnosis: today's "5 workouts for 1 session" was Apple Watch auto-detecting 3 sub-workouts (warmup walk + indoor run + strength) overlapping the same Hevy entry. Old logic:
- Stored all 4 rows separately
- v1.8.12's `Math.max(daily_activity.active, sum(workouts.active))` summed those 4 → double-counted what Apple already had in its daily total
- Lost NEAT entirely (dog walks, ambient — ~993 kcal/day for this user)

Result: workout day showed less "burned" than rest day. Energy balance off by 800-1500 kcal daily.

### Coach's 4 rules, now implemented

1. **Apple Health is sole source of truth for daily energy** (`active = daily_activity.active_energy_kcal`). Reverted v1.8.12's `Math.max` workaround. Workout active sum no longer feeds OUT — that risks double-counting and loses NEAT.

2. **Workouts table = training load only.** Sets/reps/HR/structure. Calorie sum on workouts no longer drives nutrition balance. Per-workout `active_calories` still populated from v1.8.14's robust parser, but they're a *subset* of `daily_active`, not additive to it.

3. **Dedupe by time-window overlap, not start-time proximity.** New `dedupeAppleWorkouts()`:
   - For each non-Apple workout (Hevy, manual): find apple_health rows whose [started_at, ended_at] overlaps by >50% of the apple row's duration
   - Merge: SUM Apple calories across overlapping rows (each covers a different slice), MAX HR
   - Soft-delete merged Apple rows (`workouts.deleted_at`) so they don't get re-summed
   - Caps at 500 most-recent parents per pass

4. **NEAT line on daily energy record.** New API field `calories_neat = max(0, daily_active − sum(workout_active))`. Captures dog walks, standing, fidgeting — the "missing bucket" that explains workout-day-vs-rest-day comparisons.

### API response shape

`/health/insights/nutrition` and `/insights/nutrition/macros/today` now return per-day:
```json
{
  "calories_active": 1373,    // from Apple Health daily total (truth)
  "calories_workout": 380,    // sum of today's workout active_calories
  "calories_neat": 993,       // active − workouts (dog walks etc.)
  "calories_basal": 1582,     // HAE OR BMR fallback
  "basal_source": "apple_health" | "bmr_estimated"
}
```

### UI

Macros tab OUT line now reads:
> `2955 burned (workouts 380 · NEAT 993 · basal 1582)`

Instead of:
> `2408 burned (active 660 · basal 1748 est.)` ← old, double-counted/missing-NEAT shape

### Migration

After deploy:
1. `Settings → Reparse Health Imports → Reparse All` — fixes today's broken workout calorie data via the v1.8.14 parser.
2. Hit any insights endpoint — dedupe runs implicitly during HAE sync. Today's 5 dupe rows should collapse to 1 (the Hevy parent) with merged sensor data, others soft-deleted.
3. The Macros tab will reflect Coach's 4-rule architecture.

---

## [1.8.14] — 2026-05-03

### Fixed — Coach bug #1: Apple Health workouts logging zero calories

Coach's end-of-day review surfaced that **every** Apple Watch workout had `calories_burned: None` despite the watch always tracking active energy. Two compounding bugs:

1. **Parser only checked one field shape.** HAE exports workout calories under at least four different keys depending on version + config:
   - `activeEnergyBurned: { qty, units }` (canonical HAE)
   - `activeEnergy: { qty }` (older HAE)
   - `activeEnergyKcal: 365` (Format A flat numeric)
   - `metrics.activeEnergy.qty` (newer nested HAE)

   The parser only checked the first. Any other shape silently dropped. Same for `totalEnergy` / `totalEnergyBurned` / `totalEnergyKcal`.

2. **`cal_active` / `cal_total` INT columns never populated on insert.** A startup-only backfill copied from the legacy TEXT columns once at boot. New rows had `active_calories` TEXT populated but `cal_active` INT null, so any downstream query reading the INT columns returned zero.

### Fixes

- **New `pickEnergyKcal(obj, keys[])` helper** that tries every plausible shape (object with `qty`, flat number, numeric string with units suffix). Returns the kcal number or null.
- **Format A + Format D workout parsers both use it now.** Active and total calories pulled from `activeEnergyBurned | activeEnergy | activeEnergyKcal | metrics.activeEnergy` (in priority order). Total falls back to `active + basal` when only those two are available.
- **Both parsers log a warning** with the actual payload keys when no calorie field is found, so future drift is visible in deploy logs instead of silent.
- **`cal_active` / `cal_total` written on every insert** — the INSERT and the merge-into-manual-row paths both compute the INT from the TEXT field at insert time, so all downstream consumers (recovery score, energy balance, Coach review) see the same number.

### Added — regression tests
`tests/health-calories.test.js`: 11 tests covering every payload shape, plus a "no calorie field" case so we get a flagged null instead of silently zero.

### What this means for your data
- **Going forward**: every new HAE push populates calories on workouts immediately.
- **Today's broken rows** (5 dupe rows with 0 calories): will be re-parsed and corrected on next HAE push that covers those start_times. Or you can hit Settings → Reparse Health Imports → Reparse All to re-run all stored payloads against the fixed parser.

---

## [1.8.13] — 2026-05-03

### Fixed — Trends tab crashed with "weightKg is not defined"

v1.8.12 added BMR fallback calls inside `/insights/trends`, but referenced `weightKg` which only existed in `/insights/nutrition`'s scope. Trends tab errored on every load: `Could not load trends: weightKg is not defined`. Added an explicit `body_metrics` weight lookup at the top of the trends-handler block.

### Fixed — REST DAY misclassification on workout days

`is_hard_day` was strictly `effort >= 5`. A real workout logged with `effort=null` or `effort < 5` got tagged "rest day" — target calories dropped from 2400 → 2100, recovery-fueling banner fired wrong guidance, and the macros card showed REST DAY despite the user lifting that morning.

New rule: training day if ANY of:
1. Workout effort >= 5 (legacy)
2. Any `workouts` row exists for the date
3. Any `plan_segments` row with `status='completed'` AND `logging_target IN ('hevy','apple_health')`

### Note on calorie-data freshness (not a code issue)

OUT can lag Apple Health by hours because HAE only pushes on its own schedule. AB Brain is a passive webhook receiver — it can't pull from HAE. **Fix: open HAE on iPhone → Automations → set interval to 15 min.** After that, AB Brain self-corrects every 15 min. No code change in AB Brain can speed this up; the data simply isn't sent.

---

## [1.8.12] — 2026-05-03

### Changed — BMR profile now reads from `athlete_profile` (existing table)

v1.8.10/.11 used `USER_HEIGHT_CM` / `USER_AGE` / `USER_SEX` env vars with made-up defaults (175 cm / 38 yo / male). That was placeholder engineering — the user's real values were never anywhere in the DB.

Refactor:
- `loadUserProfile()` now queries `athlete_profile` (existing versioned table from `routes/athlete.js`). Picks the row active today via `effective_from`/`effective_to`. Converts `height_in` → cm for the Mifflin-St Jeor formula.
- Idempotent seed inserted with the user-supplied values from chat: 49 yo male, 5'1" (61 in), birth_date 1977-01-01. Only seeded if no `athlete_profile` row exists.
- Env vars (`USER_*`) remain as fallback for legacy deploys but `athlete_profile` always wins.
- Settings UI / Coach can edit profile via existing `POST /api/athlete/profile` (creates new versioned row, auto-closes prior).

### Fixed — active calories no longer held hostage by HAE Format A push cadence

`daily_activity.active_energy_kcal` for today was stuck at 9 kcal because HAE Format A only pushes daily summaries once per day; subsequent pushes don't update active. Apple Watch shows 1,500+ active kcal but AB Brain stays at the early-morning value.

**Augmented OUT calculation:** `active = MAX(daily_activity.active_energy_kcal, SUM(today's workouts.active_calories))`. Workouts log active calories as they're synced; if Hevy/HAE workout sync ran more recently than the Format A daily push, the workout sum is closer to truth. API response surfaces `active_source: 'apple_health' | 'workouts_sum'` so the UI can flag.

**Edge case:** today has no `daily_activity` row at all (HAE silent) → BMR + workout-active still produces a non-zero OUT.

### Note — v1.8.13 will tackle 6 deeper data-pipeline bugs Coach surfaced

This release improves the math on whatever data exists. The actual data is still corrupt:
1. AH ingest dropping `calories_burned` (every workout shows 0)
2. Seconds-as-minutes bug regressing on new imports
3. Apple Watch session not deduped (5 rows for one workout)
4. Hevy-sourced workouts tagged `source: apple_health`
5. PT/Mobility blocks tagged `strength`
6. "Forearm Rebuild" still in auto-titles despite memory edit

Tackling those next as v1.8.13.

---

## [1.8.11] — 2026-05-03

### Fixed — Macros tab still showed "active null · basal null"

v1.8.10 added BMR fallback to `/insights/nutrition/macros/today`, but the Macros tab in the Fitness UI actually calls a different endpoint: `/health/insights/nutrition?days=14&date=...`. That endpoint was unchanged, so it returned `calories_out` summed correctly but never exposed `calories_active`, `calories_basal`, `basal_source`, or `last_synced_at`. UI saw `undefined` and rendered "active null · basal null" even when the underlying numbers were fine.

Patched `/health/insights/nutrition` (`router.get('/nutrition')`) so every `history[]` entry now carries:
- `calories_active` — real active from `daily_activity.active_energy_kcal`
- `calories_basal` — real basal OR BMR fallback (Mifflin-St Jeor)
- `basal_source` — `'apple_health'` | `'bmr_estimated'` | `null`
- `last_synced_at` — `daily_activity.updated_at`

Same BMR fallback rules as v1.8.10: latest weight from RENPHO + `USER_HEIGHT_CM` / `USER_AGE` / `USER_SEX` env vars (defaults 175 cm / 38 yo / male). Pro-rated by elapsed-day fraction for "today"; full BMR for past dates.

After deploy, hard-refresh the Macros tab — the OUT line will read like:
> `1757 burned (basal 1757 est.) · synced —`

(active will still be `null` if HAE hasn't synced any active energy for the day yet — that's not BMR's job).

---

## [1.8.10] — 2026-05-03

### Fixed — OUT/balance calculation no longer depends on HAE supplying basal

After v1.8.8 (Format A basal capture) + v1.8.9 (diagnostic visibility), basal was still null because **HAE's daily payload simply doesn't include basal_energy_kcal** in many configs. User-visible result: workout days showed less "burned" than rest days, because the dominant ~1,800 kcal/day BMR component was missing from both.

**Solution: stop depending on HAE for basal entirely.** When `basal_energy_kcal` is null, AB Brain now computes BMR via Mifflin-St Jeor:

```
BMR_kcal = 10·weight_kg + 6.25·height_cm − 5·age + (sex == 'male' ? +5 : -161)
```

Inputs:
- **Weight** — latest from `body_metrics` (RENPHO scale)
- **Height** — `USER_HEIGHT_CM` env var, default **175 cm**
- **Age** — `USER_AGE` env var, default **38**
- **Sex** — `USER_SEX` env var, default **male**

For `today`, BMR is pro-rated by elapsed-day fraction so 8 AM doesn't show a full-day basal. For past dates, full BMR.

**API response (`/insights/nutrition/macros/today`):**
- `calories_basal` — populated either from HAE or from BMR fallback
- `basal_source` — `'apple_health'` | `'bmr_estimated'` | `null` so clients can show provenance

**UI:** OUT line now reads `OUT 3275 burned (active 1526 · basal 1749 est.) · synced 12m ago`. The `est.` tag (with explanatory tooltip) shows up only when basal came from BMR. When HAE supplies real basal, no tag.

**Edge case handled:** if `daily_activity` row doesn't exist yet for today (HAE hasn't synced anything), AB Brain still injects a BMR-only OUT estimate so the Macros tab isn't suspiciously empty in the morning.

### Action — set your real profile (optional, recommended)

Defaults give a reasonable estimate (~1,800 kcal BMR for a 90 kg adult male). For accuracy, set on Railway:

```
USER_HEIGHT_CM=180
USER_AGE=42
USER_SEX=male
```

Then redeploy. The estimate adjusts on the next request.

---

## [1.8.9] — 2026-05-03

### Added — visibility into why OUT looks wrong on the Macros tab

v1.8.8 fixed Format A's missing basal capture, but if HAE never sends `basalEnergyKcal` in its payloads (config issue) OR uses a different field name, reparse won't help. Hard to diagnose without seeing the raw data.

- **`OUT` line now shows breakdown:** `OUT 3275 burned (active 1526 · basal 1749) · synced 12m ago`. If basal is null, the chip shows `basal null` in amber with a tooltip explaining what's missing.
- **`/api/health/diagnose-day?date=YYYY-MM-DD`** — new endpoint that dumps:
  - The `daily_activity` row for the date
  - The 5 most recent `raw_health_imports` covering that date
  - **For each import, every payload field with `basal/active/energy/calorie/kcal` in its key** — so you can see exactly what HAE exported under what name
  - A plain-language `diagnosis` string explaining what's null and why
- `/insights/nutrition/macros/today` response gains `calories_active`, `calories_basal`, and `last_synced_at` fields under `today`.

If after deploy + reparse the OUT chip still shows `basal null`, hit `/api/health/diagnose-day?date=2026-05-03` to see whether your HAE export config sends Basal Energy Burned at all. If `energy_fields_in_payload` doesn't include any basal-related entry, enable that metric in the HAE app settings.

---

## [1.8.8] — 2026-05-03

### Fixed — Macros tab "OUT" massively under-counts vs Apple Health

Apple Health showed total burned today = 3,275 cal. AB Brain Macros tab showed `OUT 520 · BALANCE +2875`. Result: every training day looked like a 1,500–3,000 kcal surplus when reality was balanced or in deficit. Energy-balance recommendations were wildly wrong.

**Root cause:** Format A daily-activity ingest at `routes/health.js:198` captured `activeEnergyKcal` but **omitted `basalEnergyKcal`**. Format B (line ~714) parsed both. Depending on which HAE export shape your iPhone pushed, basal was silently dropped.

The Macros math is `OUT = active + basal`. With basal null, OUT = active only ≈ 500–1500 kcal, missing the ~1,500–2,000 kcal/day BMR that Apple includes in its "TOTAL CAL" display.

**Fix:** added `basal_energy_kcal: d.basalEnergyKcal ?? null` to the Format A daily row. Format B was already correct. The `ON CONFLICT DO UPDATE` upsert in `daily_activity` writes via `COALESCE(existing, new)` so a Reparse All will backfill historical days where basal was null.

### Action required after deploy
1. **Settings → Reparse Health Imports → Reparse All** — backfills `basal_energy_kcal` on historical days from stored raw payloads.
2. Verify on the Macros tab: `OUT` should now match Apple's "Total CAL" (within ±200 kcal due to ingest timing).
3. If `OUT` is still much lower than Apple, run this SQL to inspect:
   ```sql
   SELECT activity_date, active_energy_kcal, basal_energy_kcal
   FROM daily_activity
   ORDER BY activity_date DESC LIMIT 7;
   ```
   If `basal_energy_kcal` is null even after reparse, your HAE export config isn't sending Basal Energy Burned — enable it in the HAE app settings.

---

## [1.8.7] — 2026-05-03

### Added — Apple Watch enrichment chip on Hevy workout rows

Hevy doesn't return heart rate or calories (verified against the OAS — only `start_time/end_time/exercises/sets`). Those fields only land in the AB Brain `workouts` row when `dedupeAppleWorkouts()` merges an Apple Watch workout into the Hevy row by overlapping `started_at`. Without a chip, you couldn't tell if the watch picked up your lift or not.

- **`✓ Watch HR+kcal`** (green) — both HR and active calories merged from HAE
- **`✓ Watch HR`** / **`✓ Watch kcal`** (green) — partial sync
- **`⚠ no watch data`** (amber) — Hevy row has no Apple data; either watch wasn't tracking or HAE hasn't synced yet (typically 5–30 min lag)

Chip only renders for Hevy-sourced workouts (`source='hevy'` or `hevy_id IS NOT NULL`). Apple Health and manual workouts get the data natively, so the chip would be redundant.

Active calories also now show in the workout meta line alongside HR / duration / distance when available.

---

## [1.8.6] — 2026-05-03

### Fixed — every Today-card exercise showed "⚠ unresolved"

When Coach writes segment `planned_exercises` with `name` only (no `hevy_exercise_template_id`), the resolver in `pushSegmentToHevy` fills IDs **at push time** so the Hevy routine gets the right templates. But the resolver only mutated the in-memory copy — it never wrote IDs back to `plan_segments.planned_exercises`. Result: push works, but every render of the Today card shows amber "⚠ unresolved" forever, because the chip checks `ex.hevy_exercise_template_id` which is still null in the DB.

Two fixes:

- **Push-time persistence** (`routes/hevy.js`) — after `resolveTemplateIds()` mutates the array, if any IDs were filled in, persist the new `planned_exercises` JSONB back to the segment row. From the next render onward, chips show green "→ Hevy: \<Title\>".
- **Render-time fallback** (`routes/training.js`) — when the Today endpoint sees an exercise without `hevy_exercise_template_id`, try the sticky `hevy_exercise_map` first, then `hevy_template_cache` exact-title match. Cover plans created before v1.8.6 (display-only enrichment; does NOT write back — push handles that).

Both passes only run for segments with `logging_target='hevy'`. Cardio / manual segments are untouched.

---

## [1.8.5] — 2026-05-03

### Changed — naming is Coach's job, not the system's
v1.8.4 quietly auto-disambiguated colliding routine titles by appending "Strength 1" / "Strength 2". That hid Coach mistakes. Removed: now the system pushes whatever Coach gave it, and surfaces title collisions in the push response so Coach learns to set `title_suffix` properly.
- `pushPlanToHevy()` returns `warnings.title_collisions[]` when two segments share a label without explicit `title_suffix`. Each warning includes the colliding segment IDs and a fix hint pointing at the morning-check-in skill.
- `morning-check-in.skill` updated: `title_suffix` is now documented as REQUIRED when block_labels collide. No silent system rescue.

### Fixed — deploy log noise
Three already-applied migrations were logging errors on every restart because they referenced columns/tables that no longer exist:
- `daily_plans indexes failed: column "training_plan_id" does not exist` — removed the index migration (column was DROPped in v1.8.x cleanup; the index is dead).
- `coaching_sessions indexes failed: column "training_plan_id" does not exist` — same fix.
- `rename dnc→dc failed: relation "daily_context" already exists` — wrapped in a `DO $$ ... END $$` block that checks `information_schema.tables` first.
- `fueling_rehearsals copy g→mg caffeine failed: column "g_caffeine_total" does not exist` — same `DO $$` guard, only runs the UPDATE if the source column is still present.

### Fixed — pg `client.query()` DeprecationWarning
`pool.on('connect', client => client.query('SET timezone...'))` doesn't await the SET, leaving the client in an indeterminate state. Pg 9.0 will reject it. Replaced with `Pool({ options: '-c timezone=...' })` so timezone is set during the protocol startup — no `client.query()` needed, no warning, no race.

---

## [1.8.4] — 2026-05-03

### Fixed — Hevy routine title collisions on multi-segment days

When Coach builds a day with multiple segments sharing a `block_label` (e.g. heavy-pull day = two `block_label='strength'` segments — one for the main lift, one for grip work), the Hevy routine title generator produced **identical names** like:

> Strength A — Heavy Pull + Grip + PT (Strength)
> Strength A — Heavy Pull + Grip + PT (Strength)

Indistinguishable in the AB Brain Plans folder.

### New: `plan_segments.title_suffix`

Coach now sets `title_suffix` on each segment to disambiguate. Hevy routine title becomes `<plan.title> · <title_suffix>`:

- `title_suffix: "Main Lift"` → `"Strength A · Main Lift"`
- `title_suffix: "Grip"` → `"Strength A · Grip"`

If Coach forgets, the server auto-disambiguates by appending `Strength 1` / `Strength 2` based on `block_order` so titles still don't collide.

Schema:
- `plan_segments +title_suffix TEXT` (idempotent ALTER)
- `claude-schema.json` documents the field on segment objects
- `morning-check-in.skill` instructs Coach when to set it

---

## [1.8.3] — 2026-05-03

### Fixed (3 spec bugs surfaced during live testing)

- **Bug #10 — `plan_segments.hevy_routine_id` never written back after push.** Auto-push silently created Hevy routines but the segment row's `hevy_routine_id` stayed null, so subsequent pushes created duplicates instead of updating, and sync couldn't link routines to segments. Root cause: ID extraction was checking only `resp.id`, `resp.routine.id`, `resp.routine_id` — Hevy may also wrap as `resp.data.id` or return a malformed shape. New `extractRoutineId()` tries all five paths and falls back to `GET /v1/routines` to find the just-created routine by title match. Logs the response shape on extraction failure so future regressions are visible.
- **Bug #11 — `daily_plans.hevy_routine_id` is single-valued for multi-segment days.** The column is now stripped from every `/api/daily-plans/*` and `/api/training/day/*` response. Coach + clients only see `plan.segments[].hevy_routine_id`, which is naturally plural across segments. Column kept in DB for one release of soak; will be DROPped in v1.9.0.
- **Bug #12 — `daily_plans.planned_exercises` and `actual_exercises` still surfaced on read despite v1.8.1 deprecation.** Same fix: stripped from every API response. `stripDeprecated()` helper applied at all six daily-plans response sites + the `/training/day` endpoint that the Today UI consumes.

### Added — manual retry path for failed pushes

- **`POST /api/hevy/push-segment`** — push one plan_segment to Hevy by ID. Used for retry when auto-push at plan-create time silently skipped because the template cache was empty.
- **"↑ Push to Hevy" / "↻ Re-push" button** on every Hevy segment block in the Today card. Hovers show the existing `hevy_routine_id` (if any). Re-push updates the existing routine via PUT; first push creates a new one via POST.

### Operational notes
- If you have orphaned routines in Hevy from before v1.8.3 (where the writeback failed), delete them manually in the Hevy app — the API doesn't expose a DELETE endpoint for routines.
- After clicking "Refresh Template Cache" and "Auto-Map Exercises" in Settings, use the per-segment Push button to retry any segment that previously showed "⚠ unresolved" exercises.

---

## [1.8.2] — 2026-05-03

### Fixed
- **Settings/Plans `Invalid input syntax for type uuid: "gym-profiles"` toast** — frontend was calling `/api/exercises/gym-profiles*` but the route is mounted at `/api/gym-profiles`. The wrong path fell through to `/exercises/:id` which tried to parse `"gym-profiles"` as a UUID and 500'd. Fixed all four call sites + the Coach init prompt + claude-schema.yaml so Coach won't write the broken path either. Active endpoint is `/gym-profiles/primary` (not `/active`).
- **`HR NaN`** rendering on logged-workout chips — coerced non-numeric HR values via `Number.isFinite()` so the chip hides when HR is null or NaN.
- **`⚠ Hevy queued` badge on plans with no Hevy segments** — e.g. race day. Badge now hides when (a) plan status is completed/skipped, (b) plan has zero segments with `logging_target='hevy'`. Removed the legacy `daily_plans.hevy_routine_id` fallback path entirely.
- **Redundant Completed/Partial/Missed buttons on already-completed plans** — auto-rollup is the primary path now. When `plan.status === 'completed'`, only "Mark Partial" + Edit show, not the full triplet.

---

## [1.8.1] — 2026-05-03

### Removed — legacy code paths that confused Coach
Coach (Claude) reads the OpenAPI schema and skill files to decide what to write. As of v1.8.0 there were two ways to attach exercises to a day (the old `daily_plans.planned_exercises` flat field AND the new `plan_segments.planned_exercises` per-segment array) — Coach could go either way and the system would accept both. v1.8.1 forces a single canonical path so Coach can't pick wrong.

- **Removed** legacy fallback in `pushPlanToHevy()` that read `daily_plans.planned_exercises` when no segments existed. If a plan has no Hevy-target segments, push is a no-op (returns `skipped: 'no_segments_with_logging_target_hevy'`).
- **Removed** `mapPlanToHevyRoutine` helper (was a one-segment-fake wrapper for legacy callers).
- **Removed** `daily_plans.hevy_routine_id` mirror writes from Hevy push. The single source of truth is `plan_segments.hevy_routine_id`.
- **Removed** `planned_exercises` and `actual_exercises` from `WRITABLE_FIELDS` whitelist on `POST/PUT /api/daily-plans` — sending them is now silently ignored.
- **Removed** `legacyPlannedExercises` parameter from `syncSegmentsForPlan()`.
- **Removed** auto-populate's UNION with `daily_plans.planned_exercises` — only segments are scanned for unmapped exercise names.
- **Removed** stale Coach init prompt section (`public/app.js`) referencing Fitbod, `daily_plan.planned_exercises`, and `actual_exercises`. Replaced with v1.8.1 segments-based instructions.
- **Removed** dead `safeQuery('training_plans table', 'SELECT 1')` shim in `db.js` (table dropped long ago).
- **Removed** duplicate `daily_plans +planned_exercises` ALTER at `db.js:641`.
- **Updated** skills (morning-check-in, image-intake, amend-day) so all references point at segments.
- **Updated** `claude-schema.json`: dropped `DailyPlanCreate.planned_exercises` from request body. Added `required: [block_label, planned_exercises]` on segment items so Coach gets a validation error if it forgets either.

### Note — DB columns kept for backwards compat
The `daily_plans.planned_exercises`, `daily_plans.actual_exercises`, and `daily_plans.hevy_routine_id` columns are still in the schema (with deprecation comments). The one-time backfill migration that copied them into `plan_segments` still runs. Active code never writes to them. They will be dropped in v1.9.0 after one release of soak time.

---

## [1.8.0] — 2026-05-03

### Added — Plan segments + per-segment logging
- **`plan_segments` table** — daily_plan now decomposes into ordered segments (`block_label`, `block_order`, `logging_target`, `planned_exercises`, `target_duration_min`, `target_effort`, `hevy_routine_id`, `status`, `notes`). One plan can have N segments routed to different log targets (Hevy / Apple Health / manual).
- **`logging_target` per segment** — Coach picks where each block should be logged. Strength → Hevy, Z2 run → Apple Health, mobility → manual. Resolved via `utils/exerciseTaxonomy.js` when Coach doesn't set explicitly.
- **Per-segment Mark Done + notes** — Each segment block on the Today card now has Mark Done / In Progress / Skip buttons and a Notes prompt. Coach reads `segment.notes` in the end-of-day review (e.g. "ran too fast — HR drifted Z3", "weights too light, +5lb next week").
- **Auto-rollup of `daily_plan.status`** — When the last non-skipped segment marks completed, the day flips to completed automatically. Wrap Day still exists for end-of-day notes.
- **Workout auto-link** — Hevy / HAE / manual workouts now attach to today's plan + the matching `plan_segment_id` via FK. Replaces the old date-string heuristic.
- **`workouts.deleted_at`** — soft-delete tombstone so Hevy `DeletedWorkout` events don't lose plan-segment links.

### Added — Hevy two-way integration overhaul
- **`hevy_template_cache` table** — postgres-backed mirror of Hevy's ~4,300 exercise templates. `GET /api/hevy/exercise-templates?q=` now reads from this cache; lazy-refresh on first call or when older than 7 days. Catalog refresh uses `pageSize=100` (the spec's actual max) so a full refresh is ~43 calls instead of 433.
- **`hevy_exercise_map` table** — sticky AB Brain name → Hevy template binding. Push-plan resolves missing template IDs via map → cache exact → cache fuzzy (trgm). CRUD endpoints + auto-populate that buckets matches into mapped/ambiguous/unmapped.
- **Custom exercise auto-create** — `POST /api/hevy/exercise-map/auto-populate` accepts `auto_create_custom: true`. Unmapped names get title-cased, POSTed to Hevy's `/exercise_templates`, mapped, and cached in one pass.
- **`sync_state` cursor** — `POST /api/hevy/sync` now uses `/v1/workouts/events` (not paginated `/workouts`) so DELETIONS are captured as `DeletedWorkout` events. Cursor stored in `sync_state` table; survives restarts.
- **Body measurements bridge** — `POST /api/hevy/body-measurements/sync`. Pushes RENPHO `body_metrics` (weight_lb, fat_free_mass_lb, body_fat_pct) → Hevy `/v1/body_measurements` (weight_kg, lean_mass_kg, fat_percent). Merges with existing Hevy data first since PUT overwrites null. POST for new dates (PUT 404s on missing).
- **Conflict resolution per spec** — `/sync` UPSERT now lets Hevy win for sets/reps/weight/timing/volume; AB Brain wins for body_notes via reversed COALESCE.
- **`GET /api/hevy/health`** — verifies API key by hitting `/v1/user/info`. Settings page health-check button.
- **Routine title cleanup** — Drop emoji prefix and the GMT timezone string. Precedence: `daily_plans.hevy_routine_title` (override) → `daily_plans.title` → generated `"May 3 — Strength (Top)"`.
- **Today card chip per Hevy exercise** — Green "→ Hevy: <Title>" pill when template resolved, amber "⚠ unresolved" otherwise. Server enriches segments with `hevy_resolved_title` from cache.
- **Settings → Hevy section** — Six buttons: Health Check, Sample Catalog, Sync Workouts, Refresh Template Cache, Auto-Map Exercises, Sync Body Measurements.

### Fixed — Hevy API correctness (against verified OAS spec)
- **Custom exercise POST shape** — Wrapper is `exercise` (not `exercise_template`). Fields are `muscle_group` (not `primary_muscle_group`), `equipment_category` (not `equipment`), `exercise_type` (required). Previous shape would have 400'd.
- **Routine PUT body** — `PutRoutinesRequestBody` does NOT accept `folder_id`. Strip it before update calls or Hevy rejects.
- **UserInfo unwrap** — Hevy returns `{ data: { id, name, url } }`. Health check now reads `resp.data` properly so the user's display name surfaces.
- **CustomExerciseType enum** — Real values are `bodyweight_reps` / `bodyweight_assisted_reps` (not `weighted_bodyweight` / `assisted_bodyweight`). Schema doc updated so Coach picks valid types.
- **Template refresh perf** — `/templates/refresh` previously ran 4,300 individual INSERTs in a tight loop (~30-90s). Now batches into chunks of 200 inside a transaction (~2-5s).
- **Workout sync misses deletions** — Old code used `GET /workouts?page=N` filtered by start_time client-side. Switched to `GET /workouts/events?since=<cursor>` which emits `UpdatedWorkout` + `DeletedWorkout` types. Deletions now soft-delete via `workouts.deleted_at`.
- **Body measurements field names** — Verified against Hevy OAS: `weight_kg`, `lean_mass_kg`, `fat_percent` (no `muscle_mass_kg`, `bone_mass_kg`, `water_percent`, `bmi`, `bmr_kcal`, `visceral_fat_rating` — all of those would 400 from Hevy's strict validator).
- **`folder_id` field name regression** — Locked in tests/hevy.test.js. Body sent to Hevy must contain `folder_id`, NOT `routine_folder_id` (the May 3 production bug).

### Added — Tests
- **`npm test`** — node:test suite (zero deps, built into Node 18+). 12 regression tests cover: folder_id field name, `HEVY_ROUTINE_FOLDER_ID` env fallback, title cleanup, lb→kg rounding, abMetricsToHevy real schema (asserts invented fields are NOT in payload), mapHevyWorkoutToAB shape.

---

## [1.7.1] — 2026-04-11

### Added
- **Transcript Splitting** — AI-powered detection and splitting of long Bee recordings that contain multiple distinct conversations. Uses multi-signal analysis: time gaps between utterances, speaker set transitions (sliding window), active speaker windows, and GPT-4o-mini topic/context boundary detection.
- **Ambient Noise Detection** — each detected segment classified as "primary" (user actively participating) or "ambient" (background chatter, airport noise, overheard strangers). Ambient segments tagged separately for filtering.
- **Auto-Flag Long Recordings** — transcripts exceeding 60 minutes or 500 utterances are automatically tagged `needs-split-review` during Bee sync. Shown with "Needs Split" badge in transcript list.
- **Split Analysis API** — `POST /api/transcripts/:id/analyze-splits` pre-computes signal layers (time gaps, speaker transitions, speaker windows) and sends them with sampled utterances to GPT-4o-mini for holistic boundary detection.
- **Split Execution API** — `POST /api/transcripts/:id/split` creates new transcript records per segment, copies utterances with re-indexed positions, queues speaker identification for primary segments, and marks the original as `split-parent`.
- **Needs-Split Review API** — `GET /api/transcripts/needs-split` lists all flagged transcripts not yet split.
- **Split UI** — "Analyze & Split" button on long transcript detail view. Shows AI-detected segments with title, speakers, relevance badge, and confidence. Confirm button executes split and links to child transcripts.

---

## [1.7.0] — 2026-04-11

### Added
- **Known Contacts System** — new `contacts` table storing name, aliases (JSONB), email, phone, relationship, organization, confidentiality tier (open/confidential/restricted), and metadata. CRUD API at `/api/contacts` with list, search, create, update, delete endpoints.
- **Contact-Aware Speaker Identification** — `autoIdentifySpeakers` now queries the contacts table before calling GPT-4o-mini. When contacts exist, known names are injected as "CONFIRMED KNOWN CONTACTS" in the prompt, using the proven hints-based identification pattern. Resolved speakers are linked to contact IDs via `metadata.contact_links`.
- **Unrecognized Speaker Detection** — after speaker identification, names that don't match any contact are stored in `metadata.unrecognized_speakers`. New `GET /api/contacts/unrecognized` endpoint returns distinct unrecognized names across all transcripts with frequency counts, sorted by most common.
- **Contacts Management UI** — new "Known Contacts" section in Settings with contact list, add form (name, aliases, relationship, organization), delete button, and "Unrecognized Speakers" panel showing names from transcripts with one-tap "Add as contact" flow.

---

## [1.6.1] — 2026-04-11

### Fixed
- **Bee Transcript Sync (Full Sync & Sync Updates)** — The Bee API `/v1/conversations` endpoint requires `created_after`/`created_before` date filter parameters to reliably return conversation data. Added these filters to `/sync` and `/sync-chunk` endpoints, matching the working `/sync-conversations` pattern.
- **Incremental Sync Transcript Gap** — The `/v1/changes` feed doesn't reliably report conversation updates. Added a supplementary 7-day date-range conversation fetch to `/sync-incremental`, so both the "Sync Updates" button and the 30-minute cron job now pick up new transcripts.
- **Conversation API Timeouts** — Increased conversation list and detail fetch timeouts from 30s to 60s across all sync endpoints to prevent silent failures on slower responses.
- **Login Page Version** — Updated hardcoded version on login page from v1.2.0 to current.

---

## [1.6.0] — 2026-03-31

### Added
- **Morning Briefing Endpoint** — `GET /api/briefing` returns a complete markdown morning briefing with smart task ranking, recovery readiness, rings/streaks, yesterday's activity, stale alerts, and today's plan. Designed for Claude Projects, Claude Code, and ChatGPT to call on-demand.
  - **Smart Task Ranking** — scores each task by priority (urgent=40, high=30, medium=20, low=10) + due urgency (overdue=50, today=30, this week=15) + staleness (>14d=+15, >7d=+10) + waiting duration (>5d=+10, >3d=+5). Top 3 Focus shown first.
  - **Stale Task Detection** — flags tasks untouched for 7+ days in briefing output
  - **Recovery Summary** — sleep, recovery score, injury status, workout fatigue
  - **Rings & Streaks** — train/execute/recover streak counts
  - **Yesterday Recap** — completed tasks, workout, nutrition totals
  - **Today's Plan** — daily plan if set, including workout/nutrition targets
  - Added to `claude-schema.json` and `openapi-chatgpt.json` for Custom GPT integration
- **Today View: Top 3 Focus** — new section at the top of Today view showing the 3 highest-scored tasks with highlighted cards, priority badges, and score indicators
- **Today View: Stale Tasks** — new section showing tasks untouched 7+ days with "Snooze 1w" and "Archive" quick actions

### Removed
- **Server-side Outlook email sync** — replaced by Claude's Outlook MCP tools
- **Agent system (Jarvis)** — roster, org chart, work board, agent CRUD, auto-seed. Removed as Claude Code handles delegation natively. The `ai_agent` field on tasks remains for source tracking.

### Fixed
- **`GET /api/exercises/available` SQL binding error** — query passed equipment array as parameter but had no `$1` placeholder. Fixed with `WHERE equipment = ANY($1::text[]) OR equipment IS NULL`. Same fix applied to `GET /api/exercises/for-profile/:profileId`.

---

## [1.5.0] — 2026-03-29

### Deprecated
- **Agents Section** — removed in v1.6.0. Agent personas (Jarvis, Cascade, Scout, Forge, Pixel, Sentinel) added management overhead without execution value. Claude Code handles task delegation natively.

---

## [1.4.0] — 2026-03-27

### Added
- **Task Management Overhaul** — fully editable tasks with comments, checklists, and history
  - **Editable title, description, notes, next_steps** — all fields are now inline-editable in the task detail modal (blur to save)
  - **Task Comments** — timestamped comments on any task with add/delete. New `task_comments` table with cascade delete. Comment count shown on task cards.
  - **Checklist/Subtasks** — JSONB checklist items `[{id, text, done}]` with checkbox toggle, add/remove. Progress shown as "3/5" on task cards.
  - **completed_at timestamp** — auto-set to `NOW()` when task moves to "done", cleared when re-opened. Displayed in task detail modal.
  - **Task History** — collapsible activity history in task detail modal showing all status transitions with timestamps.
  - **Notes field** — quick-capture notes field on tasks (separate from description). Available in both create and edit views.
  - **Tags** — JSONB tags column added to tasks (matching pattern from knowledge, workouts, meals). API-ready, UI in next phase.
  - **Today Focus View** — ADHD-friendly daily task view as default tab. Shows: Overdue (red), Due Today (yellow), In Progress (blue), Up Next (top 5 from backlog), Completed Today (green). Quick-action Start/Done buttons on each card.
  - **Smart Sort** — sort dropdown on list view: Priority, Due Date, Created, Updated, Status. Client-side sorting with secondary sort by priority.
  - **Checklist & Comment Badges** — list view now shows checklist progress (e.g. "3/5") and comment count on task cards.
  - **Quick Reschedule** — overdue tasks show one-tap reschedule buttons: Today, Tomorrow, Monday, or pick a date. Bulk "All → Today" / "All → Tomorrow" for all overdue at once. Task detail modal also has quick reschedule shortcuts (Today, Tmrw, Mon, +1wk) below the date picker.
  - **Waiting On Others** — new task status "waiting_on" with a `waiting_on` field to track who you're blocked by. Tasks grouped by person in Today view (e.g. all 5 Adin tasks together for one follow-up). Kanban board has dedicated "Waiting On" column. Prompt auto-appears when setting status. Auto-cleared when moving to another status.

---

## [1.3.1] — 2026-03-26

### Fixed
- **TSB calculation completely overhauled** — values were unrealistically negative (-336 on a rest day)
  - **Correct EWMA decay constants**: ATL uses `exp(-1/7) ≈ 0.867`, CTL uses `exp(-1/42) ≈ 0.976`. Previous values (`2/(N+1)`) caused massive spikes and slow decay.
  - **Standard session-RPE load**: `effort × duration` (linear, per sports science). Initial attempt at `effort^1.5` produced loads too large (1350 for one session).
  - **Recovery sessions excluded**: walk/yoga/stretch/recovery at effort ≤4 no longer count as training stress.
  - **Duration capped at 180 min**: catches bad data (600-min "dog walks") and unrealistic parses.
  - **TSB scoring rescaled with sports-science labels**: detraining (>+10, score 60), fresh (+10 to -10, score 90), optimal (-10 to -30, score 100), productive (-30 to -60, score 75), accumulated fatigue (-60 to -100, score 50), overreaching (-100 to -150, score 30), danger (<-150, score 15). Previous scale flagged -80 as "danger" — now correctly labeled "accumulated fatigue" at score 50.
- **Gym profiles POST 503 error** — table had `equipment TEXT[]` (array) from wrong branch deployment. Migration now drops and recreates as `JSONB`. Also migrated `is_active` → `is_primary` column.
- **Duplicate gym profile routes removed** — was in both `routes/exercises.js` and `routes/gym-profiles.js`. Now only in `gym-profiles.js` at `/api/gym-profiles`.
- **Import-fitbod route fixed** — referenced non-existent columns (`name_normalized`, `muscle_primary`, `muscle_secondary`). Updated to use actual schema (`name`, `primary_muscle_groups`, `secondary_muscle_groups`).
- **Duplicate table definitions removed from db.js** — merge brought in second exercises/gym_profiles CREATE TABLE with wrong column types. Removed to prevent startup failures.

### Added
- **Documentation & Version History in Settings** — collapsible sections: How It Works, Key Concepts (recovery score, TSB, muscle freshness, rings, schema builder), Architecture Decisions, and full version history v1.0–v1.3.
- **Gym profiles debug endpoint** — `GET /api/gym-profiles/debug/schema` shows live table column types for diagnostics.

---

## [1.3.0] — 2026-03-25

### Added
- **Recovery Score v2** — completely rebuilt with sports-science-backed methodology
  - **TSB-based Training Load** (TrainingPeaks model) — compares 7-day fatigue (ATL) to 42-day fitness (CTL) using session-RPE (effort × duration). Replaces naive 3-day average. Properly reflects progressive overload blocks.
  - **Effort-aware Muscle Freshness** — high-effort workouts now need up to 1.5× longer recovery time. A brutal effort-9 session needs ~72h, not just 48h.
  - **Blended Nutrition** — yesterday 70% + today 30%. Capped at 85 if no meals logged today. Shows both days.
  - **Recovery Score Explainer** — collapsible "What is this?" section on both fitness day and recovery views explaining all components.
- **Proper numeric workout columns** — `duration_minutes`, `distance_value`, `elevation_gain_ft`, `hr_avg`, `hr_max`, `cadence`, `cal_active`, `cal_total`. Auto-parsed from text fields on save, with SQL migration backfilling all historical data.
- **Exercise Library** — 65 seeded exercises with exact Fitbod naming, muscle groups, and equipment requirements
  - `POST /exercises/import-fitbod` — smart import that auto-detects 4 CSV formats (exercise library, Fitbod details, workout exports, tab-separated)
  - Normalizes muscle names to recovery schema (e.g. "Quads" → quadriceps, "front delts" → shoulders)
  - Upserts: duplicates enriched, not created
- **Gym Profiles** — Home/Gym/Travel equipment profiles with 42 equipment types matching Fitbod categories
  - Checkbox picker UI in Fitness tab (gear icon)
  - Coach checks active profile before planning workouts
  - `GET /exercises/available` — exercises filtered to active profile's equipment
- **Equipment Catalog** — 42 equipment types organized by category (free weights, machines, benches, racks, accessories, cardio, bodyweight)
- **Plan-Workout Connection** — plans and workouts formally linked
  - `daily_plans.planned_exercises` JSONB — structured exercise array from coach
  - `daily_plans.actual_exercises` JSONB — what was actually done (from Fitbod screenshots)
  - `daily_plans.completion_notes` — coach's review after workout
  - `workouts.daily_plan_id` FK — links workout to its plan (legacy data backfilled by date match)
  - Recovery reads structured exercises for granular per-muscle tracking (falls back to workout_type for pre-March 2026 data)
- **Today's Plan card** — enhanced UI showing structured exercises grouped by warmup/main/superset/circuit/finisher, with status icons (✓/~/✗), PR badges, set-level detail, coach notes, and planned-vs-actual comparison
- **Workout Notes display** — plan card shows workout_notes in monospace block for Fitbod transcription reference
- **Fitbod CSV import in Settings** — Settings → Fitness & Gym section with multi-file upload support
- **Fitbod screenshot logging instructions** — coach knows how to read Fitbod screenshots, handle band resistance labels (keep as-is, don't convert to lbs), mark PRs, use exact exercise names

### Changed
- **Coach must specify exact weights** — instructions updated: "Do NOT write 'build to heavy' — give a number: '3x10 @ 50 lb'"
- **Duration parsing** — handles MM:SS vs HH:MM ambiguity (52:30 = 52 min, not 52 hours). Caps at 300 min.
- **Recovery component detail** — Score Breakdown now shows detail text below each bar (TSB values, meal data, muscle status)
- **Claude schema** — all exercise, gym profile, and equipment endpoints documented. DailyPlanCreate schema includes planned_exercises, actual_exercises, completion_notes.
- **All OpenAPI schemas updated** — claude-schema.yaml/json, openapi-everything.json, openapi-spartan.json, openapi-chatgpt.json, openapi-gpt-actions.yaml now include numeric workout fields and exercise/gym endpoints.
- **Version bumped** to 1.3.0

### Fixed
- **TSB calculation NaN** — `time_duration` stored as text ("45 min") caused `Number("45 min") = NaN`, zeroing out CTL/ATL. Fixed with proper numeric columns and text parsing.
- **Duration backfill** — "52:30" was parsed as 52 hours (3150 min) instead of 52 minutes. Fixed HH:MM vs MM:SS detection.
- **Recovery score inflated** — was 81 "Peak" during progressive overload. Now ~70 "Good" with TSB properly reflecting accumulated training stress.

---

## [1.2.0] — 2026-03-24

### Added
- **Version labeling** across the entire app: login screen, settings panel, health-check API, and package.json
- **CHANGELOG.md** — full version history with commentary
- **Claude schema files** — `claude-schema.yaml` and `claude-schema.json` published for Claude AI integration
- Health-check endpoint now returns `version` field

### Fixed
- **Fitness Today crash** — `hasCheckIn` variable was used but never declared, causing "Can't find variable: hasCheckIn" error when viewing any date in the Fitness tab
- **Settings health-check** — frontend was calling `/api/health` (non-existent); corrected to `/api/health-check`

---

## [1.1.0] — 2026-03

### Added
- **Daily Plans system** — replaces training_plans with per-day granularity (`POST /daily-plans`, `POST /daily-plans/week`)
- **Achievement-based rings** — Train (effort), Fuel (protein + calories + hydration), Recover (sleep + quality) with proportional fill
- **Recovery system** — sleep tracking, recovery readiness score, muscle recovery model, trend charts
- **Dynamic macros dashboard** — pie chart with intensity-based calorie/protein goals
- **Gamification engine** — rings, streaks, badges, smart goal suggestions, push notifications (VAPID)
- **Coaching sessions** — end-of-day review workflow with key_decisions, adjustments, injury linkage
- **Injury tracking** — body area, severity, status lifecycle (active → monitoring → resolved)
- **Fitness UX redesign** — 4-tab structure: Today, Log, Macros, History
- **Plans sub-tab** — today-first hero card with quick status updates
- **DailyPlan schemas** added to all OpenAPI specs
- **Schema Builder** — in-app UI to select endpoints and generate custom OpenAPI specs for ChatGPT Actions
- **Outlook email sync** — flagged emails become tasks, unflagged = done
- **ChatGPT import** — bulk import conversations.json exports with dedup

### Changed
- **Daily context simplified** — reduced to 4 fields: sleep_hours, sleep_quality, hydration_liters, notes (removed energy_rating, hunger_rating, recovery_rating, body_weight_lb, cravings, digestion, day_type)
- **Rings made proportional** — Fuel and Recover rings now fill proportionally instead of binary on/off
- **Training plans dropped** — `training_plans` table removed; all planning uses `daily_plans` with auto-migration
- **OpenAPI specs synced** — all 4 spec variants updated to match actual backend schema
- **ChatGPT OpenAPI trimmed** to 30 endpoints (Custom GPT limit)

### Fixed
- Recovery score NaN bug from Date object concatenation
- Timezone bug: UI now uses local dates instead of UTC throughout
- Gamification nudges crash from dropped column references
- Intake endpoint: accepts 'text' as alias for 'input'
- Broken showModal calls in daily plan forms
- Rings not rendering due to undefined ctxCount variable
- Sleep save, date navigation in Recovery view, dashboard stats
- Double /api prefix on readiness API calls
- Seed route 404 (moved before :id param routes)
- Response schemas: missing schemas and field name mismatches

---

## [1.0.0] — 2026-02

### Added
- **Core knowledge base** — CRUD for facts, notes, research, meeting summaries with full-text search (tsvector + pg_trgm)
- **Task/Kanban board** — status workflow (todo → in_progress → review → done), priority levels, AI agent tracking
- **Transcript storage** — Bee wearable conversation imports with speaker-level utterances
- **Conversation archival** — store and search full ChatGPT/Claude/Gemini conversation threads
- **Workout logging** — strength, cardio, hybrid with exercises, sets, splits, heart rate, effort rating
- **Body metrics** — weight, body composition, BMI, metabolic age from smart scales (RENPHO, Withings)
- **Meal logging** — food tracking with full macro/micronutrient breakdown, hunger/fullness/energy ratings
- **Daily context** — daily nutrition and recovery context logging
- **Smart intake** — GPT-4o-mini auto-classification of raw input into knowledge, tasks, or transcripts
- **Bee wearable auto-sync** — 30-minute interval sync of conversations, facts, todos, journals from Bee Cloud API
- **Full-text search** — unified search across all 14 tables with AI-optimized flat result mode
- **Activity log** — audit trail of all create/update/delete/import actions
- **Dashboard** — aggregated stats with counts, breakdowns by status/priority, recent activity
- **Mobile PWA** — offline-capable progressive web app with service worker, home screen install
- **Obsidian Cockpit design system** — dark-first theme, activity stream, focus mode, FAB quick actions
- **OpenAPI specs** — 4 variants (chatgpt, brain, spartan, everything) for Custom GPT Actions
- **Notion mirror** — optional one-way sync from PostgreSQL to Notion databases
- **Docker deployment** — Railway-ready with managed PostgreSQL

### Architecture
- **Backend:** Node.js 20 + Express.js 4.21
- **Database:** PostgreSQL 16 with 14 tables, full-text search indexes
- **Frontend:** Vanilla JavaScript SPA (no framework), PWA-enabled
- **Auth:** Static API key via X-Api-Key header
- **AI:** OpenAI GPT-4o-mini for smart intake classification
- **Deployment:** Railway (Docker + managed PostgreSQL)
- **Integrations:** Bee wearable, Outlook email, Notion, ChatGPT Custom GPTs

---

## Version Numbering

- **Major (X.0.0):** Breaking API changes, database schema overhauls, architectural shifts
- **Minor (0.X.0):** New features, new endpoints, new UI views, non-breaking schema additions
- **Patch (0.0.X):** Bug fixes, UI polish, copy changes, spec corrections
