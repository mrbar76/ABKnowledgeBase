# Skill Rewrite Specs (Phase 5)

This doc tells the Claude Project skills which composite endpoints to call
and what to drop from their old fan-out logic. Skills live in the Claude
Project's Skills section (not in this repo); apply these changes there.

The contract: **every skill respects the 3-item latency cap** Coach laid
out. One composite endpoint hit before responding; deferred fetches only
if the conversation goes deeper.

---

## morning-check-in (rank 1 — fires daily)

**Old Step 1:** 7 sequential GETs (insights/morning + recovery/score +
injuries/active + injuries/recovering + daily-plans + workouts +
training/coaching).

**New Step 1:** ONE call.

```
GET /api/coach/morning
Headers: x-api-key
```

Returns everything in one shot:
```json
{
  "today_plan": { /* daily_plans row + segments[] */ },
  "readiness": {
    "hrv": { "value", "as_of", "deviation_sd", "baseline", "is_stale" },
    "rhr": { ...same shape },
    "sleep": { "total_min", "as_of", "is_stale" },
    "respiratory_rate": { "value", "as_of", "is_stale" }
  },
  "alerts": [ /* high-severity only */ ],
  "active_injuries": [ /* status IN (active, recovering, monitoring) */ ],
  "yesterday_summary": { "workout_title", "effort", "duration_min" },
  "recent_coaching": [ /* last 2 sessions: title, key_decisions, next_steps, tags */ ]
}
```

**Stale-vitals branch (scenario #13):** if `readiness.hrv.is_stale === true`
OR `readiness.sleep.is_stale === true`, surface "vitals are stale — ask
Avi how he slept and any HRV gut feel" instead of citing yesterday's
numbers as today's. This is what handles "good morning" before the
Shortcut has run.

**Decision-pinning (Phase 6 wire):** when posting the brief, include a
`snapshot` field so the readiness values are pinned at decision time:

```
POST /api/training/coaching
{
  session_date, title, summary, key_decisions, ..., tags: ["morning_brief"],
  snapshot: {
    integrated_paragraph: "...",
    headline_prescription: "Train as planned, Z2 ceiling 145.",
    if_then_conditional: "If knee twinges past hour 1, swap to bike.",
    decision_references: {
      hrv: <readiness.hrv.value>,
      rhr: <readiness.rhr.value>,
      sleep_total: <readiness.sleep.total_min>,
      yesterday_effort: <yesterday_summary.effort>
    },
    input_freshness: {
      hrv: { is_stale: <readiness.hrv.is_stale>, as_of: <...> },
      rhr: { is_stale: <readiness.rhr.is_stale>, as_of: <...> },
      sleep: { is_stale: <readiness.sleep.is_stale>, as_of: <...> }
    }
  }
}
```

**Drop these old calls:**
- `GET /api/health/insights/morning` — covered by `/api/coach/morning`
- `GET /api/recovery/score` — readiness now embedded in `/coach/morning`
- `GET /api/training/injuries/active/summary` — `active_injuries[]` in
  `/coach/morning` returns active + recovering + monitoring
- `GET /api/workouts?since={yesterday}` — `yesterday_summary` in `/coach/morning`
- `GET /api/training/coaching?since={today-2d}` — `recent_coaching[]` in
  `/coach/morning`

**Keep these conditional pulls** (only when the conversation requires):
- Sunday → `GET /api/coach/weekly` for the scorecard
- 1st of month → `GET /api/athlete/profile` for physiology check
- Race ≤ 14d → `GET /api/coach/race-pulse?race_id=X`
- Friday/Saturday → Hebcal for Shabbat detection

---

## end-of-day-review (rank 2 — fires every training day)

**New skill, build fresh against:**

```
GET /api/coach/end-of-day
```

Returns plan + actuals diff, full nutrition summary with target compliance,
subjective context, total effort minutes for the day:

```json
{
  "today_plan": { /* with segments + workouts attached per segment */ },
  "today_workouts": [ /* all workouts logged today */ ],
  "nutrition_summary": {
    "meal_count", "kcal_consumed", "kcal_target",
    "protein_g", "protein_target_g", "carbs_g", "fat_g", "meals[]"
  },
  "subjective_context": { /* daily_context row: mood, motivation, etc. */ },
  "effort_total": { "total_minutes", "workout_count" }
}
```

**Output:** 3-line compliance summary (training, nutrition, subjective),
1-line tomorrow bias, write `coaching_sessions` with `tag = "end-of-day"`
and a snapshot pinning the day's actuals.

**Don't fetch separately:**
- `/daily-plans/by-date/{today}` (covered)
- `/nutrition/daily-summary?date={today}` (covered)
- `/daily-context?date={today}` (covered)
- `/workouts?date={today}` (covered)

---

## amend-day (rank 3 — fires mid-day on signal change)

**Old Step 1:** 6 sequential GETs (insights/today + recovery/score +
training/day/today + daily-plans + injuries × 2).

**New Step 1:** ONE call.

```
GET /api/coach/midday-amend
```

Returns today's plan + segments with current status, today's vitals + alerts,
today's coaching session (if exists — usually the morning brief), active
injuries:

```json
{
  "today_plan": { /* with segments[] */ },
  "readiness": { /* same shape as /coach/morning */ },
  "alerts": [],
  "active_injuries": [],
  "today_session": { /* today's coaching_session if present */ }
}
```

**Plan amend:** `PUT /api/daily-plans/{id}` — updates segments, target
fields. Works as before.

**Workout correction:** use `PUT /api/workouts/{id}` (the v1.9.3 fix
made this stop returning 500) or `PATCH /api/workouts/{id}` for partial
updates.

**Drop:** `GET /api/recovery/score` — covered by composite.

---

## log-fueling-rehearsal (rank 4 — post long session, ~weekly)

No changes. Skill is clean per audit.

---

## image-intake (rank 5 — variable, photo-driven)

**Critical fixes (post-pivot schema):**

- Drop all references to `daily_plans.planned_exercises` (column removed
  in v1.8.20). Use `plan_segments` via `/daily-plans/by-date/{today}`.
- Drop all references to `daily_plans.actual_exercises` (column removed
  in v1.8.20). Workout actuals link to `plan_segment_id`, not
  `daily_plan_id`.

**Plan-vs-actual:** read `/daily-plans/by-date/{today}` which returns
the diff already.

**Workout linking:** new workouts use `plan_segment_id` to link to a
specific segment. The auto-link logic on `POST /api/workouts` does this
based on segment block_label + workout_type matching.

**Body composition (RENPHO):** writes to `body_metrics`. All 12 BIA
columns kept per Avi (bmi, body_fat_pct, skeletal_muscle_pct,
fat_free_mass_lb, subcutaneous_fat_pct, visceral_fat, body_water_pct,
muscle_mass_lb, bone_mass_lb, protein_pct, bmr_kcal, metabolic_age).

**NEW — progress photo path (v1.10.1 schema add):**
- `body_metrics.photo_url TEXT` — store photo URL alongside the BIA reading
- `body_metrics.photo_date DATE` — photo capture date
- Cadence: **quarterly** (Coach's audit: monthly photos look identical
  to monthly photos because BF% changes visible to the eye take 6-12 weeks)
- Source: Body 360 / similar external app — not Apple Health
- AI extraction: posture, lean, muscle definition, visible weight change

When Avi sends a progress photo, image-intake creates a `body_metrics`
row with `photo_url`, `photo_date`, and (if Avi also weighed in) the BIA
values. AI describes visible change vs. the previous photo with same date
range.

---

## race-debrief (rank 6 — ~6× per year)

**New skill, build fresh against:**

```
GET /api/coach/race-pulse?race_id={id}
```

Returns:
```json
{
  "race": { /* races row + days_to_race */ },
  "fueling_rehearsals": [ /* up to 5 most recent for this race */ ],
  "training_block": { /* the block targeting this race */ }
}
```

**Write race result:** `PUT /api/races/{id}` with result fields
(result_time_seconds, result_notes, splits, placement_overall, etc.).

**Write debrief session:** `POST /api/training/coaching` with `tag =
"race-debrief"` and a snapshot containing the full race-day picture
(splits, fueling reality vs plan, body response, mental observations).

---

## What every skill should do post-pivot

1. **Hit ONE composite endpoint first.** No fan-outs.
2. **Respect is_stale flags** in readiness; fall back to subjective Q&A
   when vitals are old.
3. **Write coaching_snapshots when posting briefs/decisions** — pinned
   values for reproducible retros.
4. **Use plan_segment_id, not daily_plan_id** for workout-to-plan links.
5. **No references to dropped columns:** `planned_exercises`,
   `actual_exercises`, `cadence_avg`, `splits`, `pace_avg`, `adjustment`,
   `fiber_g`, `sugar_g`, `sodium_mg`, `serving_size`, `treatment` (folded
   into `modifications`), `expected_weather`, `goal_process`, sleep stages
   in cache (use `daily_activity` for historical only).
6. **Use the new `is_stale` generated column** on `daily_vitals_cache`
   for "is the cache fresh?" checks instead of computing from `updated_at`.

When in doubt: hit `/api/coach/<scenario>` first. If the data you need
isn't there, that's a build-list candidate — open an issue rather than
adding a fan-out call.
