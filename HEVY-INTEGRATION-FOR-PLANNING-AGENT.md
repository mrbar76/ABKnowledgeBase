# Forge → Hevy Integration: Operating Manual

**Version:** v3.10 (May 2026)
**Audience:** Any Claude / agent / human writing Forge daily plans intended to land in Hevy as routines.
**Goal:** Tell you exactly what to write so the auto-push succeeds the first time.

---

## TL;DR

1. Forge auto-pushes any `daily_plan` whose `plan_segments` carry `logging_target: "hevy"` to Hevy as routines. **Instant**, in the same request that creates the plan. No nightly job, no manual button required.
2. Exercise names in `planned_exercises[].name` must **exactly match** (case-insensitive) the title of a Hevy exercise template. No fuzzy match. No slug-to-human conversion.
3. The push status is persisted on the plan: `hevy_push_status` flips from `not_attempted` → `pending` → `synced` / `skipped` / `failed` within ~2 seconds.
4. If you don't know the exact Hevy title for an exercise, query `GET /api/hevy/exercise-templates` first and use the title verbatim.

---

## What Forge is

Forge is a single-user PWA on top of a Node/Express + PostgreSQL backend. It tracks tasks, training, recovery, nutrition, knowledge, and family. Hevy is the user's logging app for strength sessions. Forge writes the plan; Hevy logs the execution; the two systems exchange data both ways.

---

## The three Hevy data flows

| Direction | Trigger | Endpoint | What lands |
|-----------|---------|----------|------------|
| **Forge → Hevy: routine** | Auto on plan create / update | (internal) `autoPushToHevy(plan)` | Each segment with `logging_target: "hevy"` becomes one Hevy routine in the configured folder |
| **Forge → Hevy: completed session** | Manual button / API call | `POST /api/hevy/push-workout` | A workout the user logged in Forge becomes a logged session in Hevy |
| **Hevy → Forge: completed session** | Manual sync / cron | `POST /api/hevy/sync` | Sessions logged in Hevy land in Forge's `workouts` table, deduped by `hevy_id` |

This document covers **direction 1** (the auto-push of routines). Directions 2 and 3 are mentioned only where they affect direction 1.

---

## How the auto-push fires

When you call:

```
POST /api/daily-plans
PUT  /api/daily-plans/:id
```

with a body containing `segments[]`, the route handler:

1. Inserts / updates the `daily_plans` row.
2. Replaces all `plan_segments` for that plan with the supplied list (idempotent).
3. Calls `autoPushToHevy(plan)` fire-and-forget.

`autoPushToHevy` immediately marks the plan `hevy_push_status = 'pending'` and schedules a microtask that does the actual push. When the push resolves, it writes back `synced` / `skipped` / `failed` plus the reason / segment count.

You do **not** need to call any push endpoint after the POST. The push happens automatically. You only call `POST /api/hevy/push-plan` manually when you want to **retry** a previous failure or re-push without changing the plan.

---

## What "push-eligible" means

A plan pushes to Hevy when **all** of these are true:

- The plan has at least one `plan_segment` row.
- At least one of those segments has `logging_target: "hevy"`.
- That segment's `planned_exercises[]` is non-empty.
- At least one entry in `planned_exercises[]` has a `name` (or pre-resolved `hevy_exercise_template_id`) that matches a Hevy exercise template.

If any of those fail, the response carries an explicit skip code (see §Skip codes).

---

## The plan body schema

The full POST body for a plan that pushes correctly:

```json
{
  "plan_date": "2026-05-11",
  "title": "Phase 1 · Day 1 · Strength A",
  "workout_type": "strength",
  "workout_focus": "Deadlift, pull, grip",
  "target_effort": 8,
  "target_duration_min": 65,
  "workout_notes": "First conventional pull in 17 months. RPE cap at 8.",
  "rationale": "Base-building week 1; nervous system primer.",
  "segments": [
    {
      "block_order": 1,
      "block_label": "Main Lift",
      "logging_target": "hevy",
      "title_suffix": null,
      "target_duration_min": 35,
      "target_effort": 8,
      "planned_exercises": [
        {
          "name": "Conventional Deadlift",
          "sets": [
            { "type": "warmup", "weight_lb": 135, "reps": 5 },
            { "type": "warmup", "weight_lb": 155, "reps": 3 },
            { "type": "normal", "weight_lb": 175, "reps": 5 },
            { "type": "normal", "weight_lb": 175, "reps": 5 },
            { "type": "normal", "weight_lb": 175, "reps": 5 }
          ],
          "notes": "RPE cap 8, brace before each rep"
        }
      ]
    },
    {
      "block_order": 2,
      "block_label": "Accessory",
      "logging_target": "hevy",
      "title_suffix": "Pull and Grip",
      "target_duration_min": 25,
      "target_effort": 7,
      "planned_exercises": [
        {
          "name": "Pull Up",
          "sets": [
            { "type": "normal", "reps": 5 },
            { "type": "normal", "reps": 5 },
            { "type": "normal", "reps": 5 }
          ]
        },
        {
          "name": "Farmer's Walk",
          "sets": [
            { "type": "normal", "weight_lb": 70, "duration_seconds": 45 },
            { "type": "normal", "weight_lb": 70, "duration_seconds": 45 }
          ]
        }
      ]
    }
  ]
}
```

### Field reference

**Plan-level (table `daily_plans`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `plan_date` | DATE | yes | Format `YYYY-MM-DD`. UNIQUE — duplicate insert returns 409. Use PUT to amend. |
| `title` | TEXT | recommended | Becomes part of the Hevy routine title (`<title> · <segment.title_suffix>`). |
| `workout_type` | enum | recommended | `strength` / `hill` / `run` / `hybrid` / `recovery` / `ruck` / `hiit` / `crossfit` / `boxing` / `cycling` / `swim` / `rowing` / `yoga` / `walk` / `machine` / `class` / `hike` / `race` / `long_run` / `tempo_run` / `easy_run`. Drives recovery muscle-group inference and the Hevy routine title prefix. |
| `workout_focus` | TEXT | optional | Human-readable focus. Voice-cleaned on read. **Do NOT use slugs** like `rdl_pull_grip`. |
| `status` | enum | optional | `planned` / `in_progress` / `completed` / `partial` / `missed` / `rest` / `amended` / `skipped`. Defaults to `planned`. |
| `target_effort` | int 1-10 | optional | Drives anchor detection (≥8 = anchor session, takes Today screen hero slot). |
| `target_duration_min` | int | optional | Whole minutes. |
| `workout_notes` | TEXT | optional | Coach prose for the user. Does NOT push to Hevy. |
| `rationale` | TEXT | optional | "Why this session today." Voice-cleaned on read; do not put commit-message text here. |
| `target_calories`, `target_protein_g`, `target_carbs_g`, `target_fat_g`, `target_hydration_liters`, `target_sleep_hours` | numeric | optional | Nutrition targets shown in the Fuel section. |
| `coaching_notes`, `recovery_notes` | TEXT | optional | Voice-cleaned on read. |

**Segment-level (table `plan_segments`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `block_order` | int | yes | 1-based ordinal. Determines display order. |
| `block_label` | TEXT | yes | "Main Lift" / "Accessory" / "Conditioning" / "Z2 Run" / etc. Becomes part of the Hevy routine title if `title_suffix` is null. |
| `logging_target` | enum | yes | `manual` / `hevy` / `apple_health`. **Only `hevy` triggers a routine push.** |
| `title_suffix` | TEXT | conditional | **Required when two segments share the same `block_label` in one day.** Without it, Hevy gets two routines with identical titles. |
| `target_duration_min` | int | optional | |
| `target_effort` | int 1-10 | optional | |
| `time_window_start`, `time_window_end` | TIME | optional | When the segment should happen (for multi-block days). |
| `planned_exercises` | JSONB array | required for hevy push | See exercise schema below. |
| `notes` | TEXT | optional | |

**Exercise-level (inside `planned_exercises[]`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | TEXT | yes (unless `hevy_exercise_template_id` is set) | **Must exactly match a Hevy exercise template title, case-insensitive.** No slug. No fuzzy match. |
| `hevy_exercise_template_id` | TEXT | optional | Pre-resolve the Hevy template id and skip the title lookup. Faster + more reliable. |
| `sets` | array | yes | Each set has `type`, `weight_lb` or `weight_kg` (optional for bodyweight), `reps`, optionally `duration_seconds`, `distance_meters`, `rpe`. |
| `notes` | TEXT | optional | Per-exercise note. Truncated to 240 chars on push. |

**Set-level:**

| Field | Type | Notes |
|-------|------|-------|
| `type` | enum | `warmup` / `normal` / `failure` / `dropset`. Defaults to `normal`. |
| `weight_lb` | numeric | Imperial. Converted to kg server-side (`* 0.45359237`). |
| `weight_kg` | numeric | Pass-through if you already have kg. |
| `reps` | int | Defaults to 0 for time-based / distance-based sets. |
| `duration_seconds` | int | For Farmer's walks, planks, etc. |
| `distance_meters` | int | For runs, rows, etc. |
| `rpe` | numeric | Optional. Logged to Hevy if present. |

---

## Exercise name resolution: the critical detail

The push resolver does this for each exercise:

1. If `hevy_exercise_template_id` is already set on the entry, use it.
2. Otherwise, query the local `hevy_template_cache` table:
   ```sql
   SELECT hevy_id FROM hevy_template_cache
   WHERE LOWER(title) = LOWER($name) LIMIT 1
   ```
3. If a row matches, cache the id back to the exercise entry.
4. If no row matches, the segment skips with `no_resolvable_exercises`.

**There is no fuzzy match in the production push path.** Case differences are tolerated. Punctuation differences (apostrophe, parens) are not. Equipment qualifiers Hevy uses in titles must be present in your name.

### How to find the right name

Always query first:

```
GET /api/hevy/exercise-templates
```

Returns the cached Hevy library. Search by title for the exercise you want. Use that title verbatim in `planned_exercises[].name`.

If the cache is stale:

```
POST /api/hevy/templates/refresh
```

Pulls the current list from Hevy's API and updates `hevy_template_cache`.

### Common gotchas Hevy's library imposes

- **Apostrophes are real.** `"Farmer's Walk"` is the title; `"Farmers Walk"` will not match.
- **Equipment qualifier in parens** is the Hevy convention to disambiguate variants:
  - `"Bench Press (Barbell)"` vs `"Bench Press (Dumbbell)"`
  - `"Squat (Barbell)"` vs `"Goblet Squat (Dumbbell)"`
  - `"Romanian Deadlift (Barbell)"` vs `"Romanian Deadlift (Dumbbell)"`
- **Some compound exercises have a primary noun first**: `"Pull Up"` (not `"Pullup"`), `"Sit Up"` (not `"Situp"`).
- **Conventional Deadlift** is `"Deadlift (Barbell)"` in some Hevy library versions and `"Conventional Deadlift"` in others. Query first.

When in doubt, a single `GET /api/hevy/exercise-templates?q=deadlift` (if your route supports search) or a client-side filter on the full template list resolves it.

---

## Title collision rule

Hevy organizes routines in folders. Within a folder, two routines with the same title are visually indistinguishable. The push enforces this:

If two segments in the same plan share `block_label`, you **must** set `title_suffix` on each. Without it, the push completes but the response includes a `title_collisions` warning and the user sees two identical "Strength A · Main Lift" routines in Hevy.

Example:

```json
{ "block_order": 1, "block_label": "Main Lift", "title_suffix": "Deadlift" }
{ "block_order": 2, "block_label": "Main Lift", "title_suffix": "Pull-ups" }
```

Resulting Hevy routine titles: `Strength A · Deadlift` and `Strength A · Pull-ups`.

If `block_label`s are unique within the day, `title_suffix` can be null — the routine title is `<plan.title> · <block_label>`.

---

## Status tracking on the plan row

After the push fires, the plan row carries:

| Column | Type | Values |
|--------|------|--------|
| `hevy_push_status` | TEXT | `not_attempted` / `pending` / `synced` / `skipped` / `failed` |
| `hevy_push_detail` | TEXT | Skip reason / error message / segments-pushed summary. **Always non-null** when status is `skipped` or `failed` (v3.12+). May be null on `not_attempted` or in flight `pending`. |
| `hevy_push_at` | TIMESTAMPTZ | Last attempt time |

### Detail conventions (v3.12+)

- **`synced`** → `detail` reads `"N/M segments"` (or `"pushed"` if no count).
- **`skipped`** → `detail` is the canonical skip code (`no_api_key`, `no_segments_with_logging_target_hevy`, `no_resolvable_exercises`) OR — when multiple segments skipped — `"segment <id-prefix>: <reason>; segment <id-prefix>: <reason>; …"`.
- **`failed`** → `detail` is an error message. Two prefixes you'll see:
  - **`hevy_api: Hevy <METHOD> <PATH> → <STATUS>: <body>`** — Hevy's API rejected the request. Status code + body tell you why. Common: 400 (payload shape), 401 (bad API key), 404 (unknown template_id), 422 (validation).
  - **No prefix** — Forge-side validation failure. Common: `"no folder_id (set HEVY_ROUTINE_FOLDER_ID env var or pass folder_id in body)"`.

Distinguishing the two matters because the fix is different:
- `hevy_api:` errors → fix the payload (exercise name, set shape, etc.) and re-PUT the plan.
- No-prefix errors → fix Forge config (env var, folder_id in body) and retry. Plan body may be fine.

**Workflow:**

1. POST the plan.
2. Wait ~2 seconds.
3. `GET /api/daily-plans/:id` → read `hevy_push_status`.
4. If `synced`, you're done. The Hevy app shows the routine immediately.
5. If `skipped`, read `hevy_push_detail` for the reason and fix.
6. If `failed`, read `hevy_push_detail` for the error and fix.

---

## Skip codes

`hevy_push_detail` (and the explicit response from `POST /api/hevy/push-plan`) carry one of:

| Detail | Meaning | Fix |
|--------|---------|-----|
| `no_api_key` | Server `HEVY_API_KEY` env var unset | Server config — not a plan-side problem |
| `no_segments_with_logging_target_hevy` | Plan has no segments, or none have `logging_target: "hevy"` | Add at least one hevy segment |
| `no_resolvable_exercises` | No `planned_exercises[].name` matched a Hevy template title | Use exact Hevy titles, query `/api/hevy/exercise-templates` |
| `no folder_id` | Server `HEVY_ROUTINE_FOLDER_ID` unset and not in body | Pass `folder_id` in body, or set env var |
| (any error string) | Hevy API rejected the request | Read the message; usually a payload shape issue |

---

## Manual retry

If a push skipped or failed, you can re-fire it without modifying the plan:

```
POST /api/hevy/push-plan
{ "plan_id": "<uuid>", "folder_id": 2804154 }
```

Returns:

```json
{
  "ok": true,
  "segments_pushed": 2,
  "total_hevy_segments": 2,
  "results": [ ... ]
}
```

Or, with explicit skip:

```json
{ "ok": false, "skipped": "no_resolvable_exercises", "segment_id": "..." }
```

The plan's `hevy_push_status` is updated either way.

---

## Idempotency: the second push

When you PUT a plan that has already been pushed, the push runs again. For each segment:

1. If `plan_segments.hevy_routine_id` is set, the push **PUTs** the existing Hevy routine (updates in place).
2. If not set, it **POSTs** a new routine and stores the returned id.

Result: no duplicate routines on retry. Edits propagate.

---

## End-to-end checklist for a new plan

```
1. Pick the day and figure out the session shape (strength A, hill, etc.).

2. GET /api/hevy/exercise-templates
   Find the exact title for each exercise you want.
   If your library is cached and stale: POST /api/hevy/templates/refresh first.

3. GET /api/daily-plans?date=YYYY-MM-DD
   If a plan exists, decide: PUT (amend) or leave alone?
   Existing plans created by other agents may have wrong exercise names.
   Check existing plan's hevy_push_status — if 'skipped' it needs a fix.

4. Build the plan body per the schema above. Critical:
   - Every segment that should appear in Hevy: logging_target: "hevy"
   - Every planned_exercises[].name: exact Hevy template title
   - Two segments with same block_label: each gets a title_suffix
   - Sets array per exercise — at least one set, with type and reps

5. POST /api/daily-plans (or PUT /api/daily-plans/:id if amending)
   Returns the created/updated plan row.

6. Wait ~2 seconds. GET /api/daily-plans/:id
   Read hevy_push_status:
     synced  → done. Open Hevy app, find the routine.
     pending → wait another second and re-check.
     skipped → read hevy_push_detail, fix, PUT again.
     failed  → read hevy_push_detail, fix, PUT again.

7. Verify in Hevy: routines should appear in the AB Brain Plans folder
   (or whatever HEVY_ROUTINE_FOLDER_ID points at).
```

---

## Self-diagnostic

Inspect a week's worth of plans and their push status in one curl:

```bash
curl -s -H "X-Api-Key: <key>" \
  "$BASE/api/daily-plans?week_start=2026-05-11" \
  | jq '.results[] | {
      date: .plan_date,
      title,
      hevy_status: .hevy_push_status,
      hevy_detail: .hevy_push_detail,
      seg_count: (.segments | length),
      hevy_segs: (.segments | map(select(.logging_target == "hevy")) | length),
      first_ex: (.segments[0].planned_exercises[0].name // "(none)")
    }'
```

For each day this tells you:
- Does the plan exist?
- Does it have `hevy` segments?
- What's the push status?
- What name did the previous agent use for the first exercise?

From there, decide: leave alone, fix names + PUT, or rewrite entirely.

---

## What NOT to do

- **Do not** cram exercises into `workout_notes` as prose. The Hevy push reads `planned_exercises`, not prose. The previous agent's pattern of writing `workout_notes: "Deadlift 5x5 @ 175lb, then 3 sets of pull-ups"` produces zero Hevy routines.
- **Do not** use slugs in `name`: `rdl_pull_grip`, `bench_row`, `farmer_carry`. The resolver will not match these against any Hevy template.
- **Do not** invent your own canonical names. The Hevy library is the source of truth. Always query `/api/hevy/exercise-templates`.
- **Do not** skip `title_suffix` when two segments share `block_label`. The push will succeed but Hevy gets duplicate-titled routines.
- **Do not** repeatedly POST when you mean PUT. POST returns 409 on duplicate `plan_date`.
- **Do not** push to Hevy and then immediately push again expecting it to "really" land. The first push already fired in the background. Read `hevy_push_status` instead.
- **Do not** put commit-message text or internal phrases in `rationale` or `coaching_notes` (e.g. "REVISED v3 after Avi pushback"). Forge cleans some of this on read but the cleaner is not exhaustive.

---

## What to do when the push consistently skips

1. Confirm `hevy_push_status` says `skipped: no_resolvable_exercises` (not just "didn't appear in Hevy").
2. For each `planned_exercises[].name`, search `/api/hevy/exercise-templates`:
   ```bash
   curl -s -H "X-Api-Key: <key>" "$BASE/api/hevy/exercise-templates" \
     | jq '.[] | select(.title | test("farmer"; "i")) | .title'
   ```
3. Replace the name with the exact match. PUT the plan again.
4. Re-check `hevy_push_status`. Should now be `synced`.

If a name has no match in Hevy's library at all, the exercise doesn't exist as a Hevy template. Two options:
- Use a close substitute that does exist.
- Create a custom exercise inside Hevy first, then `POST /api/hevy/templates/refresh` to pull it into the local cache.

---

## What you have authority to do

- Read existing plans (`GET /api/daily-plans`).
- Create new plans (`POST /api/daily-plans`).
- Amend existing plans (`PUT /api/daily-plans/:id`).
- Refresh the Hevy template cache (`POST /api/hevy/templates/refresh`).
- Manually retry a push (`POST /api/hevy/push-plan`).

## What you do NOT have authority to do without asking

- Delete an existing plan (`DELETE /api/daily-plans/:id`). Existing plans may be the user's own work; ask first.
- Mass-overwrite a week of plans without surveying what's already there.
- Push to Hevy via direct calls to `api.hevyapp.com`. The integration goes through Forge — that's where the resolver, idempotency, and dedup live.

---

## Reference: the push code path (for grounding)

If you ever need to verify behavior against the source:

- **Auto-push trigger**: `routes/daily-plans.js:17-66` — `autoPushToHevy(plan)`
- **POST handler**: `routes/daily-plans.js:491` (calls autoPushToHevy after insert)
- **PUT handler**: `routes/daily-plans.js:604` (calls autoPushToHevy after update)
- **Push pipeline**: `routes/hevy.js:856-920` — `pushPlanToHevy(planRow, _, folderId)`
- **Per-segment resolver**: `routes/hevy.js:130-150`
- **Title builder**: `routes/hevy.js:153-220` — `mapSegmentToHevyRoutine`
- **Schema**: `db.js:411-441` (daily_plans), `db.js:1361-1390` (plan_segments)
- **Status columns**: `db.js` `daily_plans + hevy_push_status / hevy_push_detail / hevy_push_at` migrations

---

## Quick reference card

```
WRITE PLAN:
  POST /api/daily-plans
  body: { plan_date, title, workout_type, target_effort, segments: [...] }

VERIFY PUSH:
  GET /api/daily-plans/:id
  read .hevy_push_status

RETRY PUSH:
  POST /api/hevy/push-plan { plan_id }

LOOKUP EXERCISE NAMES:
  GET /api/hevy/exercise-templates

REFRESH CACHE:
  POST /api/hevy/templates/refresh

AMEND PLAN:
  PUT /api/daily-plans/:id
  body: same shape as POST

WHAT TO PUT IN planned_exercises[]:
  { name: "<exact Hevy title>", sets: [{ type, weight_lb, reps }] }
```
