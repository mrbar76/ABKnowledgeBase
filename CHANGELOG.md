# AB Brain — Changelog

All notable changes to the AB Brain platform are documented here.

---

## [1.5.0] — 2026-03-29

### Added
- **Agents Section** — new top-level tab for managing AI agents (Jarvis orchestrator system)
  - **Agents table** — PostgreSQL table with name, codename, role, personality, avatar_emoji, status (active/busy/idle/offline/retired), reports_to hierarchy, capabilities, tools, model, hired_date, metadata
  - **Full CRUD API** — `GET/POST/PUT/DELETE /api/agents`, plus `GET /api/agents/:id` with assigned tasks and activity history
  - **Roster view** — card-based roster showing all agents with status badges, active/completed task counts, capabilities pills, and model info
  - **Org Chart view** — hierarchical tree view showing reporting structure with indented nodes, status dots, and active task counts
  - **Agent detail modal** — full profile with editable status, reports-to dropdown, personality, notes, assigned work list (linked to tasks), and recent activity log
  - **Hire Agent form** — create new agents with name, codename, role, emoji avatar, personality, model, capabilities, and tools
  - **Task integration** — agents linked to tasks via `ai_agent` field (codename). Agent detail shows all assigned work with status colors.
  - **Activity tracking** — agent create/update/delete actions logged to activity_log
  - **Founding team auto-seed** — on first visit, roster auto-populates with 6 agents: Jarvis (Chief of Staff), Cascade (HR), Scout (Research), Forge (Backend Dev), Pixel (Frontend Dev), Sentinel (QA Lead). All report to Jarvis.
  - **Agent assignment on tasks** — dropdown in task detail modal to assign any agent. Agent codename shown on task cards in Today and List views.
  - **Seed API endpoint** — `POST /api/agents/seed` creates founding team idempotently (skips if roster already populated)

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
