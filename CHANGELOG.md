# AB Brain — Changelog

All notable changes to the AB Brain platform are documented here.

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
