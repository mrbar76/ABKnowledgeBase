# AB Brain — Changelog

All notable changes to the AB Brain platform are documented here.

---

## [1.11.8] — 2026-05-06

### Coach handoff — Bug A + Goals UI fixes 1-6 + Bug B contract clarification

**Bug A — `PUT /api/workouts/:id` alias-column collision (high priority).**
The PUT/PATCH handler had a redundant third loop that wrote
`duration_minutes`, `hr_avg`, `cal_active`, etc. to the SET clause —
even though those columns were already covered by `WRITABLE_FIELDS` in
the first loop. Result: Postgres "multiple assignments to same column
duration_minutes" → 500 on every PUT that included a numeric dual.

Fix: introduced `NUMERIC_FIELDS` Set inside the handler. First loop now
detects numeric duals and applies `Number()` coercion inline. Removed
the redundant third loop entirely. The `numericMap` (auto-derive numeric
from text fields when only the text was provided) stays — it correctly
guards on `b[numCol] === undefined` to avoid double-write.

**Bug B — `PUT` merge semantics clarified.**
Coach reported sending `{body_notes: "..."}` wiped other fields. After
re-checking, the handler is correctly merge-on-undefined — keys not
present in the body are skipped, leaving the existing column value
intact. **`null` and empty-string in the body ARE explicit clears.**
If you saw fields wiping, the client sent null/empty-string. To leave
a field unchanged, omit the key entirely. Added regression test +
explicit comment block documenting the contract.

**Goals UI fixes 1-6 (Coach's UX list):**
1. **Day-zero progress bar** — when `current_value == anchor_value`
   (`is_at_baseline` true), the bar renders as `— BASELINE SET —` text
   marker instead of an empty 0% fill. The trio anchor → anchor → target
   reads as the starting line, not absence of data.
2. **Date timezone** — `current_value_date_iso` sent raw from server;
   client computes "today / yesterday / N days ago" via new
   `relativeDateLabel()` in user's local TZ.
3. **"No data" vs "Baseline" badge** — new `statusLabelFor(g)` returns
   "Baseline" when `status === 'pending' && is_at_baseline`. "No data"
   only when there's truly no anchor either.
4. **Last-attempt line for sub-anchor sessions** — dashboard composite
   now attaches `last_attempt` per goal via new `lastAttemptFor()` query
   that scans workouts matching `linked_exercise_names` OR
   `linked_workout_types` since `anchor_date`. UI renders italic
   "last attempt: 60lb × 5 on yesterday (sub-anchor)" line under the
   trio when applicable.
5. **Sort order** — `STATUS_URGENCY` updated:
   `at_risk(0) → behind(1) → on_track(2) → pending(3) → ahead(4) →
   paused(5) → complete(6) → failed(7)`. Most-needs-attention first;
   pending sinks below in-progress goals.
6. **Between-phases header + empty state** — when `active_phase` is null,
   dashboard surfaces `next_phase` and `focus_summary` says
   "Between phases. Phase X (Name) starts in N days on YYYY-MM-DD."
   Header label flips to "Phase X starts YYYY-MM-DD." Dev placeholder
   ("POST /api/goals to create one") replaced with user copy:
   "No goals tracked yet. Coach can add one — or open a goal in
   Settings."

### Tests
- `tests/phase1-fixes.test.js` — 6 new assertions covering Bug A's
  NUMERIC_FIELDS pattern, Bug B's documented merge contract, dashboard
  emits new fields, STATUS_URGENCY new order, app.js renders baseline
  marker + last-attempt line + relativeDateLabel + statusLabelFor.
  138/138 tests pass.

### Out of scope (next commit)
- **Bug C — Hevy sync `exercises[]` empty.** Hevy-synced workouts have
  lifts in `metadata.hevy.raw_exercises` but not in the structured
  `exercises[]` field, so `recomputeForWorkout` silently misses them.
  Fix: a Hevy → AB Brain transform helper applied during sync + a
  one-shot backfill endpoint for existing rows. Shipping as v1.11.9.

---

## [1.11.7] — 2026-05-06

### Real fix — duplicate /api/ prefix in Goals UI fetch paths

The actual reason Goals never appeared in the UI: every `api()` call in
the v1.11.0 Goals UI was written as `api('/api/goals/...')`. The `api()`
helper prepends `API = '/api'` automatically. Result: requests went to
`/api/api/goals/dashboard` (and 6 sibling paths). That URL doesn't match
any route, so Express's SPA fallback served `index.html` (HTML, status
200). The `api()` helper's `await res.json().catch(() => ({}))` swallowed
the JSON parse error on HTML, returned `{}`. The UI parsed `{}` as
"no goals found" and rendered the empty placeholder.

Cache/SW/HTTP-cache theories in v1.11.1–6 were chasing the wrong cause.
The bug was a 7-character typo (`/api/` extra prefix) repeated across
7 lines that I wrote and shipped on day one.

Fixed paths:
- `api('/api/goals/dashboard')` → `api('/goals/dashboard')` (2 sites:
  loadGoalsCard + loadFitnessGoals)
- `api('/api/goals/${id}/trajectory')` → `api('/goals/${id}/trajectory')`
- `api('/api/goals/${id}')` PUT → `api('/goals/${id}')` (2 sites)
- `api('/api/goals/${id}/status')` → `api('/goals/${id}/status')`
- `api('/api/goals/phases')` → `api('/goals/phases')`

Single sed-style replace; verified zero `api('/api/goals` patterns
remain.

133/133 tests pass.

### Apology

This should have been a 5-minute fix on the first "I can't see goals"
report. I went down a cache/SW/HTTP-cache rabbit hole through 5 deploys
(v1.11.1 → v1.11.6) without checking the simplest thing: what URL is
the fetch actually hitting. The version-drift banner shipped in v1.11.6
is still useful long-term but was orthogonal to this specific bug.

---

## [1.11.6] — 2026-05-06

### Permanent fix — version drift detection on app boot

After three rounds of "deploy shipped but PWA didn't get the new code"
(v1.10.4 → v1.11.0 → v1.11.5), shipping the architectural fix that
prevents this class of bug entirely.

**How it works:**
- `APP_VERSION = '1.11.6'` constant baked into `app.js`
- On every app boot, `checkVersionDrift()` fetches `/api/health-check`
  with `cache: 'no-store'` and reads `data.version`
- If server version ≠ APP_VERSION, a purple banner pins to the top:
  "App is on vX.Y.Z, server is on vA.B.C. Reload to get the latest."
  with a one-tap **Reload** button
- Reload calls `forceReload()` which:
  1. Unregisters all service workers
  2. Reloads with cache-busting query string `?v=<timestamp>`
  3. Browser fetches fresh `app.js` and `sw.js` — no cache hits

User-facing: next time a deploy ships ahead of your installed PWA,
you'll SEE the version mismatch and reload in one tap. No more
silent staleness; no more nuclear cache resets.

**Convention going forward:** bump `APP_VERSION` in app.js to match
`package.json` on every release that touches `public/*`. The mismatch
detection makes the link automatic for users.

133/133 tests pass.

---

## [1.11.5] — 2026-05-06

### Hotfix — browser HTTP cache serving stale API responses

Coach confirmed UI bug. Backend healthy (`/api/goals/dashboard` returns
5 active goals + correct counts), but the home tab Goals widget showed
the empty placeholder. Same symptom on Train ring (0% despite logged
workout) and Effort indicator (0/7 despite effort 6.5 patched). Fuel +
Recover cards were current — those happen to be loaded fresh by other
code paths.

Root cause: `app.js`'s `api()` helper called `fetch()` with no cache
directive. Browser's HTTP cache happily served stale GET responses
captured during earlier loads. Service worker correctly passes `/api/*`
through (no SW caching) — but the browser layer was caching anyway.

Fix: pass `cache: 'no-store'` in the default fetch options inside `api()`.
Bypasses HTTP cache entirely on every API call. Caller can override via
`opts.cache` for specific endpoints if needed.

```js
res = await fetch(API + path, { cache: 'no-store', ...opts, headers });
```

Also bumped `CACHE_NAME` to `abkb-v1.11.5` so the new `app.js` reaches
installed PWAs.

After Railway deploys + force-refresh once, Goals card + Train ring +
Effort indicator all render fresh data on every load.

133/133 tests pass.

---

## [1.11.4] — 2026-05-06

### Hotfix — `POST /api/goals/seed-defaults` for empty-table recovery

User reported v1.11.3 cache fix worked (Goals card now renders) but the
backend had no goals — the `goals_active` array was empty, triggering the
"No goals yet" fallback message. Boot-time seed (db.js) silently failed
to insert the 5 locked goals + 6 phases on this Postgres instance. Likely
race during early deploys; safeQuery swallows whatever error occurred.

Added `POST /api/goals/seed-defaults` — idempotent one-shot endpoint that
inserts the same canonical seed data using `WHERE NOT EXISTS` guards.
Safe to hit multiple times. Use:

```
curl -X POST -H "x-api-key: $KEY" https://ab-brain.up.railway.app/api/goals/seed-defaults
```

Response includes `phases_inserted`, `goals_inserted` counts. After hit,
refresh the dashboard — goals appear.

Also seeds anchor history rows (`goal_history`) so trajectory charts
have a starting point.

133/133 tests pass.

---

## [1.11.3] — 2026-05-06

### Hotfix — service worker cache invalidation

**Root cause: PWA cache name `abkb-v33` was unchanged across v1.10.x and
v1.11.0/1/2.** Service workers only prune their precache when the
CACHE_NAME string changes. Since I shipped 5 releases with UI changes
(home Goals card, Fitness Goals sub-tab, pending status colors) without
bumping the cache name, every installed PWA kept serving the stale v33
copy of `app.js`. New code shipped but never reached the device.

Fix: bumped `CACHE_NAME` to `abkb-v1.11.3`. On next visit, browsers
detect the sw.js content change, install the new SW, and the activate
handler prunes v33. Fresh `app.js` (with `loadGoalsCard`, `loadFitnessGoals`,
pending color, all the Goals UI from v1.11.0–2) downloads on first fetch.

User-facing: **after this deploy lands, force-refresh once** (pull-to-refresh
on iPhone PWA, or Cmd+Shift+R desktop). Subsequent visits hit the fresh
cache automatically.

**Convention going forward: bump CACHE_NAME on every release that touches
anything in `public/*`.** Adding the version string (`abkb-v{semver}`)
makes the link explicit. CHANGELOG entry now flags this as a recurring
checklist item.

---

## [1.11.2] — 2026-05-06

### Coach-flagged: pending status + schema docs gap + Coach guide

**1. New `pending` status when current_value is null.**
Coach reported: Deadlift showed `on_track` despite `current_value: null` —
"on_track with no data is misleading." Was the result of `computeStatus`
returning `goal.status || 'on_track'` default. Now returns `pending`
explicitly. Migration includes:
- `ALTER TABLE goals` CHECK constraint expanded to allow `pending`
- One-time backfill: `UPDATE goals SET status='pending' WHERE current_value IS NULL`
- Default for new rows changed to `pending` (was `on_track`)
- UI: new color (gray) + label ("No data") for pending status
- Sort order: at_risk → behind → **pending** → on_track → ahead → paused → complete → failed

**2. `claude-schema.json` v2.0.0 → v2.1.0.**
Coach noted /goals + /people + /coach endpoints weren't in the schema.
Added a "v1.10–1.11 endpoint families" section to the description with
endpoint-by-endpoint summaries. Full OpenAPI path expansion deferred —
the description text is what Coach reads first.

**3. `docs/coach-goals-guide.md` (NEW)** — full operating contract for
Coach × Goals interaction. 11 sections covering read patterns, write
patterns, per-goal manual update logic, phase awareness, status
interpretation, anchor recalibration triggers, common mistakes, snapshot
integration, example session flows, and quick-reference endpoint table.

### Tests
- `goals.test.js` — 2 new tests asserting pending semantics + backfill
  migration present. 133/133 across full suite pass.

### Note on phase visibility
Coach observed `active_phase: null` when running the dashboard.
**This is correct behavior**, not a bug. Phase 1 (Riverdale prep) starts
May 11; today is May 6. Between phases (or before all phases) the
`active_phase` field returns null and `focus_summary` says "No active
phase." The dashboard handles this state gracefully.

---

## [1.11.1] — 2026-05-06

### Hotfix — `/insights/trends` 500 + Goals visibility

**1. `/insights/trends` 500 on text-with-unit numeric cast.**
- Workouts schema has `active_calories TEXT` (legacy) and `cal_active NUMERIC`
  (canonical numeric dual). The `/insights/trends` aggregator was casting
  the TEXT column directly: `NULLIF(active_calories, '')::numeric`. Some
  rows have unit suffixes ("75 kcal") that crash the cast → entire trends
  page errored with `invalid input syntax for type numeric: "75 kcal"`.
- Fix: prefer `cal_active` (numeric) first; if null, fall back to a
  regex-stripped numeric cast on `active_calories` (`REGEXP_REPLACE` strips
  any non-digit/non-dot before casting). Two query sites updated (workout
  effort aggregate at line ~860, workout active sum at line ~1352).

**2. Goals visible on Fitness tab (was Home tab only).**
- v1.11.0 placed the Goals card on the Home tab between today-actions
  and the gamification rings. Avi naturally lands on Fitness for training
  context — Goals weren't reachable from there.
- Fix: added Goals as a Fitness sub-tab alongside Today / Log / Macros /
  History / Trends / Plans / Coaching. Same dashboard render as the
  home-tab card, plus a "Phase Timeline" button at top for one-tap
  access to the periodization view.

131/131 tests pass.

---

## [1.11.0] — 2026-05-06

### Goals Tracking System (Phases A + B + C in one commit)

Spec: knowledge entry `1f247878`. Three-phase build delivered together so
seed → CRUD → auto-compute → UI is one coherent shipment.

**Phase A — schema, CRUD, dashboard, seed**

Three new tables:
- `goals` — title, category, metric, anchor/target/current/status,
  linked_exercise_names[], linked_workout_types[], compute_method,
  phase_primary[], phase_maintenance[], evidence_label
- `goal_phases` — periodization windows tied to races
- `goal_history` — trajectory data points (FK to goals, ON DELETE CASCADE)

Endpoints (`/api/goals/*`):
- CRUD: `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`
- Composite: `GET /dashboard` (active + complete sections, sorted by status
  urgency then deadline; per-goal `expected_today`, `days_left`,
  `last_update_label`, `active_phase_role`)
- Status: `GET /:id/status` (recompute now, return updated goal)
- Trajectory: `GET /:id/trajectory` (history + projection)
- Recompute trigger: `POST /recompute-all`
- Phases: `GET /phases`, `GET /phases/current`, `POST /phases`

Seed data inserted on first deploy: 5 locked goals (pull-ups,
deadlift, farmer's walk, stair climber, 5mi pace) + 6 phases
(Riverdale prep → Killington taper). Idempotent — `WHERE NOT EXISTS`
guards prevent re-seeding.

**Phase B — auto-compute on workout insert + Hevy sync**

`lib/goal-compute.js` — pure-function module:
- 5 compute drivers: `max_weight` (with rep floor parsed from title like
  "225×5"), `max_reps_single_set` (skips warmup sets), `latest_pace`
  (with distance floor from "5mi" in title), `max_duration`,
  `total_volume` (last 7d)
- `computeStatus(goal)` — direction-aware (pace metrics flip), ±10% on_track
  band, 25% threshold for at_risk, complete on target reach
- `projectCompletion(history, target, anchor_date, metric)` — least-squares
  slope on last 4 history points, projects target ISO date

Hooks:
- `routes/workouts.js` POST → `recomputeForWorkout(workout)` — only goals
  whose linked exercises or workout_type match this workout get recomputed
- `routes/hevy.js` /sync → `recomputeAllGoals()` after batch lands
- Both fire-and-forget; recompute failure never poisons the parent request

**Phase C — UI on home view**

`public/app.js` (8K-line file edited surgically):
- `loadGoalsCard()` fetches `/api/goals/dashboard` and renders in
  `#goals-section` (between today-actions and gamification)
- Per-goal row: progress bar (anchor → current → target with marker at
  expected-today position), status pill color-coded
  (at_risk red / behind yellow / on_track green / ahead blue / paused gray /
  complete green), days-remaining, last-update label, primary/maintenance chip
- Active goals listed, completed in collapsible details block below
- Tap any goal → modal with Chart.js trajectory chart (Actual line vs
  Target trajectory line, projection on tooltip), history table, manual-update
  / recompute / pause-resume buttons
- Phase timeline modal (tap section header) — all phases with active marker

Auto-advance:
- `checkPhaseAdvance()` runs at server boot + every 12h via `setInterval`
- When today is the start_date of any phase, writes a single `phase_advance`
  entry to `activity_log` (idempotent — checks for same-day entry first).
  Surfaces in the existing Activity Stream UI.

### Tests

`tests/goals.test.js` — 21 regression tests:
- Pure compute logic (status thresholds for ahead/on_track/behind/at_risk/complete,
  pace-metric direction handling, projection slope math, rep/distance floor
  parsing, exercise name matching)
- Compute drivers (max_weight respects rep floor, max_reps skips warmups,
  latest_pace honors distance floor + most-recent)
- Route registration + every endpoint declared
- Mounting in server.js
- Hooks present in workouts.js + hevy.js
- Seed data present in db.js (all 5 goals + all 6 phases by name)
- Phase auto-advance idempotency check
- UI smoke (Chart.js datasets, sort contract, function names)

131/131 tests pass (including all prior phases).

### Coach's role (unchanged from spec section 7)

Goals 3 (Farmer's walk) and 4 (Stair climber Z3) are `compute_method='manual'`
because Hevy farmer's walk doesn't always carry duration cleanly and
stair-climber Z3 needs HR sample analysis. Coach pulls dashboard at every
session, manually updates these via `PUT /api/goals/:id` after long sessions,
and recalibrates anchors when context warrants (PR outside the system,
detraining checkpoint, post-phase recalibration).

### Out of scope

- True push notifications on phase advance (existing VAPID push subscription
  could be wired; for v1.11.0, activity log entry is the user-visible signal)
- Hard-delete UI controls (DELETE endpoint supports `?hard=true` for CLI use)
- Multi-user support (single-user system per spec section 11)

---

## [1.10.4] — 2026-05-05

### Coach-flagged fixes — three composite endpoint gaps + perf

**Bug 1 (highest priority): `/api/people/:idOrName/interactions` returned
empty for known contacts with data.**
The original join used exact case-insensitive equality on `speaker_name` /
`from_name` / `organizer_name`. When transcripts had "Vernon Smith" and
the contact was just "Vernon" (or vice versa), no match → empty results.

Fix:
- Added substring (`ILIKE`) match alongside the exact match. "Vernon"
  contact now matches "Vernon Smith" speaker, and "Vernon Smith" contact
  matches "Vernon" speaker.
- When results are still empty, response includes a `diagnostics` block:
  `bee_speakers_in_window`, `email_senders_in_window`,
  `calendar_organizers_in_window` (top 20 each, with counts), plus the
  names that were searched. Lets Avi/Coach see exactly what's there and
  decide whether to add aliases or run AI speaker identification.

**Bug 2: `/api/coach/race-pulse` missing `taper_phase`, `recommendation`,
`last_28d_build_summary`.**

Added all three:
- `taper_phase`: derived from `days_to_race` (recovery / race-day /
  race-week / taper / sharpen / pre-taper / base) using standard Friel /
  Galpin / Seiler periodization breakpoints.
- `recommendation`: short prescription per phase from a constant map
  (e.g., "Volume −20% week-over-week, intensity preserved" for taper).
- `last_28d_build_summary`: aggregate from prior 28d workouts —
  workout_count, total_minutes, total_active_kcal, hard/moderate/easy
  session counts, avg_effort, hardest_effort, longest_minutes,
  total_distance.
- Bonus: `fueling_rehearsal_count_28d` so Coach can flag race-week if
  zero rehearsals were done.

**Bug 3: `/api/coach/end-of-day` missing plan-vs-actual diff.**

Added `plan_vs_actual`:
- `segments[]`: per-segment with `target_duration_min`, `target_effort`,
  `actual_duration_min`, `actual_effort`, `completed`, `workout_count`
- `segments_completed` / `segments_total` counts
- `unplanned_workouts[]`: workouts that didn't link to any plan segment
- `macros_delta`: `kcal` and `protein_g` (target − actual; negative =
  short, positive = over)
- `effort_delta`: max actual effort − planned target_effort

Plus `effort_total.max_effort` so the skill can compare directly.

### Perf optimizations

**Truncate large fields in composite responses:**
- `coaching_sessions.summary` → `LEFT(summary, 200) AS summary` +
  `summary_truncated` boolean. Full text still queryable via
  `GET /api/training/coaching/:id` when the skill needs the brief body.
- `workouts.body_notes` → same 200-char trim across `/coach/morning`,
  `/coach/midday-amend`, `/coach/end-of-day` (segment subqueries +
  todayWorkouts list).
- Replaced `json_agg(w.* ORDER BY ...)` with explicit
  `json_agg(json_build_object('id', w.id, 'title', w.title, ...))` —
  no more "select all columns" bloat.

Coach observed `/coach/morning` cold start was 1.4s (~160KB payload).
With trimming it should fall to ~30KB / ~400ms per Coach's projection.

**Cold-start profiling deferred** — likely an unindexed query path
(daily_activity range scan?). Will surface specific slow queries in a
follow-up commit if perf is still an issue post-deploy.

### Tests
- `tests/phase4-bugfixes.test.js` — 9 regression tests covering all 3
  bugs + the truncation/narrow-column perf changes. 105/105 pass.

### Out of scope
- AI speaker identification trigger from `/people/backfill-interactions`
  — that's a separate workflow via `/api/transcripts/:id/identify-speakers`.
  Backfill stats only; speaker ID stays explicit.

---

## [1.10.3] — 2026-05-05

### Hotfix — four production bugs Coach surfaced post-deploy

**1. `daily_vitals_cache.is_stale` column never created → `/coach/morning` 500**
- v1.9.4 attempted `ADD COLUMN is_stale BOOLEAN GENERATED ALWAYS AS (updated_at < NOW() - INTERVAL '6 hours') STORED`. Postgres rejects: `NOW()` isn't immutable, STORED generated columns require immutable expressions. The migration silently failed via `safeQuery`'s catch.
- `routes/coach.js`'s `loadMergedVitals()` referenced `c.is_stale AS cache_is_stale` → 500 on every `/coach/morning` and `/coach/midday-amend` call.
- Fix: drop the GENERATED column attempt entirely. Derive `is_stale` inline at SELECT: `(c.updated_at < NOW() - INTERVAL '6 hours') AS cache_is_stale`. No schema dependency; no immutability constraint; same coaching semantics.
- Migration: `ALTER TABLE daily_vitals_cache DROP COLUMN IF EXISTS is_stale` (idempotent, no-op if it never got created).

**2. `/health/insights/nutrition` returned 0s on Macros & Balance card**
- v1.9.4 dropped `meals.fiber_g`. The `/insights/nutrition` aggregator's SQL still summed it: `COALESCE(SUM(fiber_g), 0) AS fiber_g`. Postgres rejects with "column fiber_g does not exist". The handler's `.catch(() => ({ rows: [] }))` swallowed the error and returned an empty meal map → every day's Macros & Balance card showed `IN: 0, protein: 0, carbs: 0, fat: 0` even though meals existed.
- Visible symptom: top "Calories" card showed real macros (different endpoint); "Macros & Balance" card showed all zeros (this endpoint).
- Fix: drop `fiber_g` from the SUM, the `mealMap` row shape, and the response key. Per-day rows now return `{kcal, protein_g, carbs_g, fat_g}` only.

**3. `/coach/race-pulse` required `race_id` even when one upcoming race exists**
- The endpoint returned 400 on missing `race_id`, forcing skills to first call `/api/races/upcoming` to get the ID, then call `/coach/race-pulse?race_id=X`. Two calls when one would do.
- Fix: when `race_id` is omitted, resolve to the next upcoming scheduled race automatically. If no upcoming race exists, return 404 with a hint to schedule one or pass `race_id` explicitly. Response now includes `resolved_via: 'race_id' | 'upcoming'` so the skill knows which path was taken.

**4. `POST /api/training/coaching` accepted any-shape `snapshot` field**
- v1.10.1 added optional snapshot pinning but didn't validate the shape — Coach noticed posting `{hrv_ms, rhr_bpm, sleep_total_min}` as the snapshot returned 201, silently producing useless `coaching_snapshots` rows missing `integrated_paragraph`, `headline_prescription`, `if_then_conditional`. Weekly retros built on these would have nothing to read.
- Fix: when `snapshot` is provided, require `snapshot.integrated_paragraph` (non-empty string). Return 400 with field list if violated. `decision_references` and `input_freshness` stay permissive (any JSONB shape) so the skill can evolve those without endpoint changes.

### Tests
- `tests/phase2-schema.test.js` updated: assert `is_stale` column drop is present, GENERATED add is gone, and `coach.js` derives the value inline.
- `tests/phase3-coach.test.js` updated: race-pulse default-to-upcoming behavior assertion.
- 96/96 tests pass.

### Out of scope
- `/insights/trends` 500 (Coach reported still failing). v1.9.3 fixed the two bugs Explore identified (undefined `todayWorkoutActive`, monotony NaN). If Coach still sees 500s post-deploy, surface the specific error and I'll trace.
- Manual cleanup of test coaching session row Coach asked to remove (one-off DELETE from prod, not a code change).

---

## [1.10.2] — 2026-05-05

### Phase 5 — skill rewrite specs

`docs/skill-rewrite-specs.md` describes how each of the 6 Spartan skills
should be updated to call the v1.10.0 composite endpoints instead of
fanning out 4-7 calls per scenario. Skills live in the Claude Project's
Skills section (not in this repo since `chore: remove /skills/` on
2026-05-05); apply these changes there.

Per-skill updates:
- `morning-check-in` — collapses Step 1's 7 GETs to one `/api/coach/morning`
  call. Adds stale-vitals branch for scenario #13. Adds Phase 6 snapshot
  payload to the coaching session POST.
- `end-of-day-review` — new skill, single `/api/coach/end-of-day` call.
- `amend-day` — collapses Step 1's 6 GETs to one `/api/coach/midday-amend`.
  Workout corrections use the v1.9.3-fixed PUT/PATCH /workouts/{id}.
- `log-fueling-rehearsal` — no changes (clean per audit).
- `image-intake` — drops references to deprecated daily_plans columns
  (`planned_exercises`, `actual_exercises`); workouts link via
  `plan_segment_id`. Adds quarterly progress photo path writing
  `body_metrics.photo_url + photo_date`.
- `race-debrief` — new skill, single `/api/coach/race-pulse?race_id=X`
  call. PUTs race result; POSTs debrief session with snapshot.

### Phase 7 — subjective vitals Shortcut runbook

`docs/subjective-shortcut.md` describes the 5-question one-tap iOS
Shortcut that POSTs to the existing `/api/nutrition/daily-context`
endpoint. Five fields:

| Field | Range |
|---|---|
| `sleep_quality` | 1-10 |
| `mood` | 1-10 |
| `motivation` | 1-10 |
| `soreness_overall` | 1-10 |
| `life_stress` | 1-10 |

No backend changes — endpoint already does upsert-on-date with COALESCE
per field. Runs manually whenever Avi has a moment; idempotent across
re-runs.

Closes the gap on subjective signals HealthKit can't measure. Coach reads
via `/api/coach/end-of-day.subjective_context`.

### Out of scope
- Phase 8 (drop `daily_activity`) — scheduled for Aug 5, 2026 once
  `daily_vitals_cache` has 90 days of HRV-not-null data.

---

## [1.10.1] — 2026-05-05

### Phase 4 — people layer + Phase 6 — `coaching_snapshots` write path

**Phase 4** ships the unified person-context query Coach uses for "what
did Vernon say about pacing", "when's my sister flying in", "what did
the PT recommend last visit". One `contacts` row per person; interactions
joined across Bee transcripts + email_threads + calendar_events.

| Endpoint | Purpose |
|---|---|
| `GET /api/people` | List contacts ordered by last_interaction_date DESC |
| `GET /api/people/:idOrName/interactions` | Unified interaction view across Bee + email + calendar with topic + date filters |
| `POST /api/people/backfill-interactions` | Rewrites `contacts.last_interaction_date / source / count_30d / topics_tagged` from current sources. Idempotent. Run nightly via cron OR manually after bulk imports. |

`/interactions` query params:
- `topic` — substring match on interaction `topic_tags`
- `since` — ISO date (default = 30 days ago)
- `sources` — csv: `bee,email,calendar,all` (default = all)
- `limit` — default 20, max 100

Response shape:
```
{
  person: { /* contacts row + role_tags + last_interaction_* + topics_tagged */ },
  interactions: [ { source, ref_id, date, speaker_attribution, summary_excerpt, topic_tags } ],
  stats: { interaction_count_30d, bee_count, email_count, calendar_count, topics_distribution }
}
```

Contact resolution: tries UUID match → exact name (case-insensitive) →
alias match against `contacts.aliases` JSONB. 404 with helpful error when
no contact resolves.

All three source queries run in `Promise.all` for sub-500ms latency. Topic
filter applies post-aggregation since topics live in JSONB across sources.

**Phase 6** extends `POST /api/training/coaching` to optionally pin a
`coaching_snapshots` row to the new session. When the skill posts a
`snapshot` field, AB Brain writes a snapshot row tagged to the session
ID. Retros can then re-read the pinned values instead of relying on
current vitals (which may have shifted since the decision was made).

`coaching_snapshots` schema (already existed from v1.9.0):
- `integrated_paragraph`, `headline_prescription`, `if_then_conditional`
- `decision_references` JSONB — what data the brief cited
- `input_freshness` JSONB — is_stale flags at decision time
- `coaching_session_id` FK → coaching_sessions

The skill posts:
```
POST /api/training/coaching
{
  ...session fields,
  snapshot: {
    integrated_paragraph: "...",
    headline_prescription: "Train as planned, Z2 ceiling 145.",
    if_then_conditional: "If knee twinges past hour 1, swap to bike.",
    decision_references: { hrv: 53.1, rhr: 58, ... },
    input_freshness: { hrv: { is_stale: false, as_of: "2026-05-05" }, ... }
  }
}
```

If `snapshot` is omitted (existing callers), behavior unchanged.

### Tests
- `tests/phase4-people.test.js` — 10 regression tests asserting routes
  registered, mounted, all 3 sources joined, Promise.all used,
  contact resolution by UUID/name/alias, response shape complete,
  backfill writes the right contact fields.
- 95/95 tests pass.

### Out of scope
- Nightly cron for `backfill-interactions` (manual run via curl works;
  schedule deferred until Avi confirms cadence).
- Phase 5 skill spec doc (next).
- Phase 7 subjective-Shortcut runbook (next).

---

## [1.10.0] — 2026-05-05

### Phase 3 — composite `/api/coach/*` endpoints

Coach's audit revealed every skill made 4-7 sequential API calls before
responding. Latency budget is broken; ADHD-aware fast coaching needs
≤3 items of context fetched in one round trip. New `routes/coach.js`
delivers seven scenario-shaped endpoints, each Promise.all'd internally.

| Endpoint | Replaces | Used by scenario |
|---|---|---|
| `GET /api/coach/morning` | 7 calls (insights/morning + recovery/score + injuries × 2 + daily-plans + workouts + training/coaching) | "Good morning" / morning-check-in skill |
| `GET /api/coach/midday-amend` | 5 calls (insights/today + recovery + training/day + daily-plans + injuries) | Mid-day amend skill |
| `GET /api/coach/preworkout?in_minutes=N` | 4 calls (daily-plans + body-metrics + meals + fueling) | Pre-workout fueling check |
| `GET /api/coach/postworkout` | 3 calls (workouts + meals + daily-context) | Post-workout fueling check |
| `GET /api/coach/end-of-day` | 4 calls (daily-plans/by-date + nutrition-summary + daily-context + workouts) | end-of-day-review skill |
| `GET /api/coach/weekly` | 4 calls (insights/weekly-review + targets + races/upcoming + races/blocks/current) | Sunday weekly scorecard |
| `GET /api/coach/race-pulse?race_id=X` | 2 calls (insights/race + fueling/list) | Race-week pulse + race-debrief |

Each composite returns the scenario-shaped payload Coach actually needs
(no superset bloat). Readiness object includes `is_stale` per metric so
the skill knows when to fall back to subjective Q&A or re-prompt the
Shortcut.

**Architecture decisions:**
- `Promise.all` everywhere — no sequential awaits inside handlers.
  Latency target: <500ms p95 for all seven.
- Self-contained: doesn't call other route modules. Direct SQL only.
  Means /insights/* can deprecate over time without breaking coach.
- `loadMergedVitals(N)` helper consolidates the cache+activity FULL OUTER
  JOIN logic that's now in two places (insights.js + coach.js). Both
  produce the same merged source.
- `readinessFromRows()` helper computes deviation_sd + baselines + is_stale
  in one pass. Exported once, used by `/morning` and `/midday-amend`.

**Mount:** `app.use('/api/coach', coachRoutes)` after the existing routes.
No changes to other endpoints — old endpoints continue to work for
backwards compat during skill migration.

### Tests
- `tests/phase3-coach.test.js` — 14 regression tests asserting all 7
  endpoints register, mount, use Promise.all (latency contract), include
  expected response keys, and surface is_stale per readiness metric.
- 85/85 tests pass.

### Out of scope
- Skill rewrites (Phase 5 — describes which composite each skill should
  call and what to drop).
- People layer endpoint (Phase 4 — builds on the `/transcripts/speakers`
  endpoint added in v1.9.3).
- Deprecating the old fan-out endpoints (parallel for now; deprecate
  after all skills migrate).

---

## [1.9.4] — 2026-05-05

### Phase 2 — schema cleanup

Coach's audit produced a list of straggler columns no coaching decision
relied on. Migration is idempotent (`IF EXISTS` / `IF NOT EXISTS`), safe to
re-run, and route handlers updated in lockstep so INSERT statements never
reference dropped columns.

**Override of Coach's drop list:** Avi explicitly preserved all 12 RENPHO
BIA columns on `body_metrics` (bmi, fat_free_mass_lb, visceral_fat,
body_water_pct, muscle_mass_lb, bone_mass_lb, protein_pct, metabolic_age,
measurement_context, vendor_user_mode, lean_mass_lb, subcutaneous_fat_pct).
The detail UI surfaces them in `showBodyMetricDetail`; Avi tracks them
monthly. Coach can ignore the columns in coaching decisions but the data
stays visible.

**Dropped columns** (data preserved up to drop time; rebuild as empty if
hardware/use case changes):
- `workouts`: cadence_avg (canonical numeric `cadence` kept), splits (segments
  via plan_segments), pace_avg (derive from duration/distance), adjustment
  (folded into body_notes)
- `meals`: fiber_g, sugar_g, sodium_mg (race fueling logs sodium separately),
  serving_size (kcal + macros sufficient)
- `injuries`: treatment (folded into modifications), tags
- `races`: expected_weather (live forecast), goal_process (training_blocks.thesis)
- `daily_vitals_cache`: sleep_deep_min, sleep_rem_min, sleep_core_min,
  sleep_awake_min (Series 3 doesn't record stages — watchOS 9+ only),
  wrist_temp_c (Series 8+), spo2_pct (Series 6+), source_device (never read
  by coaching logic)

**New columns:**
- `daily_vitals_cache`: `is_stale BOOLEAN GENERATED` — true when row is
  more than 6 hours old; Coach uses to decide subjective-Q&A fallback.
- `body_metrics`: photo_url, photo_date for monthly progress photos from
  Body 360 / similar via image-intake skill (Phase 4 build).
- `contacts`: role_tags, last_interaction_date, last_interaction_source,
  interaction_count_30d, topics_tagged for Phase 4 people layer.

**Deprecation marker:** `daily_activity` table commented as deprecated.
Drop scheduled for ~Aug 5, 2026 once `daily_vitals_cache` has 90 days of
HRV-not-null history (Phase 8).

**Route handlers updated:**
- `routes/v2-vitals.js`: validator + INSERT shrunk from 7 → 4 numeric fields
  (HRV, RHR, sleep_total, respiratory). Old payloads with sleep stages or
  source_device silently ignored at validator (no error).
- `routes/workouts.js`: WRITABLE_FIELDS, POST INSERT, bulk INSERT, numericMap
  all cleaned of cadence_avg/splits/pace_avg/adjustment. Folded
  `b.adjustment` into body_notes for backwards compat.
- `routes/meals.js`: validator, buildInsertParams, INSERT_SQL, PATCH
  `allowed` list cleaned of fiber_g/sugar_g/sodium_mg/serving_size.
- `routes/training.js`: injuries POST INSERT + PATCH allowed cleaned of
  treatment + tags. Folded `b.treatment` into modifications for backwards
  compat.
- `routes/races.js`: RACE_FIELDS cleaned of expected_weather, goal_process.
- `routes/insights.js`: FULL OUTER JOIN queries in `/morning` and `/today`
  pull sleep stages from daily_activity only (cache no longer has them).

### Tests
- `tests/phase2-schema.test.js` — 7 regression tests asserting INSERT
  statements + field lists no longer reference dropped columns; RENPHO
  BIA columns preserved; is_stale generated column present.
- `tests/v2-vitals.test.js` — validator tests updated to current Series-3
  field set; new test confirms dropped fields are silently ignored.
- `tests/phase1-fixes.test.js` — TEXT_JSON_FIELDS test rewritten to
  assert splits is no longer in WRITABLE_FIELDS (Phase 2 dropped it).
- 71/71 tests pass.

### Out of scope
- Phase 3 composite endpoints (next).
- Phase 4 people layer (`/api/people/{id}/interactions`).
- Phase 8 — `daily_activity` drop (90-day timer).

---

## [1.9.3] — 2026-05-05

### Phase 1 — fix three production 500s

Coach's audit surfaced three endpoints returning 500 on every call. Root
causes diagnosed and fixed; regression tests added.

**1. `PUT /api/workouts/:id` — JSONB cast against TEXT column**
- `JSONB_FIELDS` in `routes/workouts.js` included `'splits'`, which
  produced `splits = $N::jsonb` in the dynamic UPDATE — but `workouts.splits`
  is a TEXT column. Postgres rejected every PUT that included `splits`.
- POST handler stringifies `splits` without the `::jsonb` cast (correct
  for TEXT). PUT diverged.
- Fix: split `JSONB_FIELDS` (true JSONB: exercises/tags/metadata) from new
  `TEXT_JSON_FIELDS` (TEXT columns holding JSON: splits). PUT now matches
  POST behavior.

**2. `PATCH /api/workouts/:id` — route didn't exist**
- Coach was calling PATCH for partial edits; Express returned 404 →
  surfaced as 500 upstream.
- Fix: extracted handler into shared `updateWorkoutHandler`, registered on
  both PUT and PATCH.

**3. `GET /api/transcripts/speakers` — endpoint didn't exist**
- Coach was hitting it for the people-context layer (Phase 4 dependency).
- Built: aggregates distinct speakers across all transcripts with
  `transcript_count`, `last_seen`, `total_text_chars`, plus left-joins
  `contacts` on name + alias for `contact_id` and `alias_matched`.

**4. `GET /api/health/insights/trends` — ReferenceError + NaN cascade**
- Line 1401 referenced `todayWorkoutActive` without declaring it. Threw
  `ReferenceError` on every call where today had no `daily_activity` row,
  which is now permanent post-HAE-retirement → 100% of calls 500'd.
- Fix: declare `const todayWorkoutActive = workoutActiveByDate.get(today) || 0`
  before the conditional.
- Secondary: monotony calc (`meanLast7 / sdLast7`) produced NaN when
  `meanLast7 = 0` (all rest days). Added explicit `meanLast7 > 0` guard.
- **Deferred to Phase 3:** rewriting `/trends` to FULL-OUTER-JOIN
  `daily_vitals_cache` with `daily_activity`. Phase 1 scope is "make it
  return 200"; Phase 3 makes the vitals history correct post-HAE.

### Tests
- `tests/phase1-fixes.test.js` — 9 regression tests asserting bug patterns
  are gone (JSONB_FIELDS shape, TEXT_JSON_FIELDS, PATCH route, /speakers
  endpoint shape, todayWorkoutActive declaration, monotony guard). 64/64
  tests pass.

### Out of scope
- Full `/insights/trends` rewrite to read `daily_vitals_cache` (Phase 3).
- Phase 2 schema cleanup (next commit).
- Skill rewrites (Phase 5).

---

## [1.8.23] — 2026-05-04

### Apple Watch HR drop + HAE source-name mojibake

User shared a partial HAE export that surfaced two latent parser bugs.

**1. Apple Watch heart rate landed null on every workout.**
- HAE canonical workout shape ships HR as `heartRate.avg = { qty: 88.27, units: "count/min" }` (and the same shape on `avgHeartRate` / `maxHeartRate`).
- `sanitizeHrText` only handled strings + numbers; `Number({qty,units}) → NaN → null`.
- Result: every Apple Watch strength/cardio session had `heart_rate_avg = NULL`, `heart_rate_max = NULL`. Recovery / TSS / zone-time downstream were all running on missing data.
- Fix: unwrap `.qty` from object-shaped HR values up-front. Same pattern as `pickEnergyKcal`.

**2. HAE device names round-tripped through Windows-1252 → mojibake.**
- Some pipelines (notably the iOS Shortcut bridge into a couple of automation tools) re-decode UTF-8 source-name bytes as CP1252 then re-encode as UTF-8. `Avi's Apple Watch` becomes `Aviâ€™s AppleÂ Watch` (apostrophe `\xE2\x80\x99` → `â€™`; NBSP `\xC2\xA0` → `Â `).
- New `fixMojibake()` helper: maps each char back to its CP1252 byte (with the high-page mapping for chars like `€`, `™`, `'`), reinterprets the byte stream as UTF-8, and only adopts the repair if no `U+FFFD` replacement chars appear.
- Applied via `repairSourceStrings()` walker to every `source` / `sourceName` / `device` string in workout metadata before persistence. Top-level `source: 'apple_health'` constant is unaffected.

**3. More per-second streams retained in metadata.**
- HAE workout payloads include `heartRateRecovery`, `stepCount`, `activeEnergy`, `walkingAndRunningDistance` as time-series arrays. Only `heartRateData` was being kept; the others were dropped on the floor.
- These streams now land in `workouts.metadata` so post-hoc analysis (recovery curves, cadence, second-by-second pacing) can use them without re-ingesting the raw HAE payload.

### Tests
- `sanitizeHrText` regression: `{qty,units}` shape returns the `qty` value rounded.
- `parseFormatDWorkouts` regression: HR fields populate from canonical shape (was the bug).
- `fixMojibake`: round-trips a known mojibake string back to clean UTF-8; passes through clean strings unchanged; returns input on null/empty.
- `parseFormatDWorkouts` end-to-end: mojibake'd `source` strings inside `heartRateData` and `stepCount` come out clean.

### Out of scope
- Bulk repair of historical workout rows whose `metadata.heartRateData[].source` already shipped mojibake'd (only future ingests are clean). A one-off backfill is trivial if needed: `UPDATE workouts SET metadata = repair(metadata) WHERE source='apple_health'` — defer until a user actually queries against those values.
- Repairing display strings outside `metadata.*.source` (e.g. user-typed workout notes that happen to contain mojibake). Out of scope for this branch.

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
