# How goals update in Forge

A plain-English map of when goals recompute, what triggers them, and what data they pull from. Honest about the gaps.

---

## The 30-second version

Goals update **automatically** in three cases:

1. You log a workout (`POST /api/workouts`) → matching goals recompute.
2. Hevy sync pulls workouts in → all active goals recompute.
3. **NEW (v3.17):** You log a body metric (`POST /api/body-metrics`) → body-composition goals recompute.

Goals do **not** update on their own when you just open the app. There's no daily cron that re-evaluates them. They recompute only when their input data changes.

Goals also have a few **manual** levers:

- Coach can ask Forge to recompute everything: `POST /api/goals/recompute-all`
- Coach can set a value directly and lock it: PUT the goal with `manual_locked: true`
- Manual update button in the goal detail sheet (frontend wraps the PUT)

---

## The data flow, diagrammed

```
                          ┌─────────────────────────────────────────┐
                          │  WHAT YOU DO                            │
                          └─────────────────────────────────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                 │                                 │
        ▼                                 ▼                                 ▼
  Log a workout                   Log a body metric                  Hevy syncs a workout
  POST /api/workouts              POST /api/body-metrics             POST /api/hevy/sync
        │                                 │                                 │
        ▼                                 ▼                                 ▼
  writes workouts row             writes body_metrics row           writes workouts rows
        │                                 │                                 │
        │ (fire-and-forget)               │ (fire-and-forget)               │ (fire-and-forget)
        ▼                                 ▼                                 ▼
 recomputeForWorkout(w)          recomputeForBodyMetric(m)         recomputeAllGoals()
        │                                 │                                 │
 filters by:                     filters by:                       no filter:
  - linked_exercise_names         - compute_method =                walks every active
    matches w.exercises[]          'latest_body_value'              non-paused goal
  - OR linked_workout_types       - manual_locked = false
    matches w.workout_type        - status not in
  - manual_locked = false          (complete|failed|paused)
  - status not in
    (complete|failed|paused)
        │                                 │                                 │
        └─────────────┬───────────────────┴────────────────┬────────────────┘
                      │                                    │
                      ▼                                    ▼
              ┌─────────────────────────────────────────────────────┐
              │  For each matching goal: recomputeOneGoal(g)        │
              └─────────────────────────────────────────────────────┘
                      │
                      ├── If goal.manual_locked → skip (Coach owns the value)
                      ├── If goal.compute_method = 'manual' → just refresh status
                      │
                      └── Otherwise:
                            │
                            ├── Body-comp goal? (compute_method = latest_body_value)
                            │     └── Load body_metrics since goal.anchor_date
                            │           ORDER BY measurement_date DESC
                            │           Pick latest non-null reading for goal.metric
                            │
                            └── Workout-driven goal?
                                  └── Load workouts since goal.anchor_date
                                        Dispatch to driver:
                                          max_weight        (strength PR)
                                          max_reps_single_set (rep PR)
                                          latest_pace       (running PR — lower is better)
                                          max_duration      (cardio time PR)
                                          total_volume      (last 7 days)
                            │
                            ▼
                      Did we find a new "best" value?
                            │
                ┌───────────┴───────────┐
               YES                      NO
                │                        │
                ▼                        ▼
      Update goal.current_value     Just recompute status:
      Append goal_history row         on_track / at_risk / behind /
      Recompute status                ahead / pending / complete
                │                        │
                └───────────┬────────────┘
                            ▼
                  Goal row in DB now reflects
                  the latest measurement.
                  Visible on the next render
                  of Training → Goals.
```

---

## In plain English, by scenario

### Scenario 1: You hit a new deadlift PR
1. Hevy logs the workout. Sync fires within 30 min (or you tap "Sync from Hevy").
2. `routes/hevy.js syncHevyWorkouts` upserts the workout and at the end calls `recomputeAllGoals()`.
3. Your deadlift goal has `compute_method: 'max_weight'` and `linked_exercise_names: ['Conventional Deadlift']`.
4. The `max_weight` driver scans your workouts since `anchor_date`, finds the heaviest working set on that lift, returns 195lb × 5.
5. 195 > previous current_value (185), so it's a new best. `current_value` updates to 195. `goal_history` gets a new row: `{ value: 195, source_workout_id: <w>, source_note: "Workout Strength A on 2026-05-13" }`.
6. Status recomputes — if 195 is on pace for hitting target_value by target_date, status stays `on_track`. If it's ahead, flips to `ahead`. If it's behind the trajectory, `at_risk` or `behind`.
7. Next time you open Training → Goals, you see the new value + updated badge.

### Scenario 2: You weigh in on RENPHO and your weight goal needs to move
**v3.17 fix.** Pre-v3.17 this didn't auto-update — RENPHO synced into `body_metrics`, but no goal recompute fired.

1. RENPHO sends the weigh-in. Forge writes `body_metrics` row.
2. The route now calls `recomputeForBodyMetric(row)` fire-and-forget.
3. The hook pulls every goal with `compute_method: 'latest_body_value'` AND `manual_locked: false`.
4. For each matching goal, `recomputeOneGoal` runs. It loads body_metrics since anchor_date, picks the latest reading for the goal's `metric` (e.g. `weight_lb`), updates `current_value`.
5. Same `goal_history` write + status recompute as the workout case. Source note reads `"Weigh-in on 2026-05-11"` since there's no workout to attribute to.

### Scenario 3: You're paused on a goal (e.g. shoulder injury, training hold)
1. You set `status: 'paused'` on the goal (via Coach or manual update).
2. The recompute hook's `WHERE status NOT IN ('complete','failed','paused')` filter excludes it.
3. New workouts and weigh-ins land without touching this goal. When you un-pause, the next recompute picks up where it left off.

### Scenario 4: Coach manually overrode your value
1. Coach saw real-world context Forge didn't (e.g. the recorded 5×5 was actually 4×5 because you racked it). They manually set `current_value` via `PUT /api/goals/:id { current_value: ..., manual_locked: true }`.
2. Next time a workout/weigh-in fires the recompute hook, `manual_locked = true` short-circuits — the goal is preserved as Coach set it.
3. To re-enable auto-compute, PUT `manual_locked: false`. Next data event will recompute.

### Scenario 5: You ask Coach "are my goals on track?"
1. Coach probably reads `GET /api/goals/dashboard`.
2. That endpoint **does not recompute** — it reads stored `current_value` + computes display-side projections (days remaining, status color, evidence label).
3. If you want a fresh recompute before the dashboard read, Coach calls `POST /api/goals/recompute-all` first, then reads the dashboard.

---

## What can still go wrong

Each is a real "huh, why didn't my goal update?" pattern:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Workout logged but goal didn't move | `linked_exercise_names` doesn't match the exercise name in the workout (case-insensitive exact, no fuzzy) | Edit the goal: add the exact name Hevy uses |
| Weigh-in logged but weight goal didn't move (v3.17+) | Goal's `compute_method` isn't `latest_body_value` | Edit the goal: set `compute_method: 'latest_body_value'` and `metric: 'weight_lb'` |
| Goal stuck on old value despite recent PRs | `manual_locked: true` — Coach overrode it | PUT `manual_locked: false` to re-enable auto-compute |
| Goal stuck in `pending` forever | `current_value` is still null (no qualifying data since anchor_date) | Lower the bar (e.g. drop a `linked_workout_type`), or set baseline manually |
| Goal shows wrong "expected_today" | `anchor_value` or `target_date` is off; the linear projection is wrong | Edit the goal's anchor/target |
| Hevy sync ran but `recomputeAllGoals` log line missing | Hevy returned 0 new workouts, so the post-sync hook didn't trigger | Normal — no new data means no recompute needed |

---

## What's running when

| Event | Triggers recompute? | Scope |
|-------|---------------------|-------|
| `POST /api/workouts` | Yes | Goals matching the workout's exercises/type |
| `POST /api/hevy/sync` (auto or manual) | Yes, if any workout landed | All active goals |
| `POST /api/body-metrics` (v3.17) | Yes | All body-comp goals |
| `POST /api/body-metrics/bulk` (v3.17) | Yes, once after the batch | All body-comp goals |
| `PATCH /api/body-metrics/:id` (v3.17) | Yes | All body-comp goals |
| `DELETE /api/body-metrics/:id` | No (could be added if needed) | — |
| `POST /api/goals/recompute-all` | Yes | All active goals |
| `GET /api/goals/dashboard` | No — read-only | — |
| `GET /api/goals/:id` | No | — |
| `GET /api/goals/:id/status` | **Yes** — this endpoint recomputes one goal | One goal |
| Server boot / cron | No | — |
| Opening the Training tab in the PWA | No | — |

---

## Drivers (what data each goal type reads)

Each goal has a `compute_method` that picks one driver:

| compute_method | Reads from | What it does |
|----------------|-----------|--------------|
| `max_weight` | workouts | For each matching exercise's working sets since anchor_date, find the heaviest weight × reps combination meeting the goal's rep floor (parsed from title: "225×5" → require ≥5 reps). |
| `max_reps_single_set` | workouts | Find the highest rep count in any single working set of matching exercises. |
| `latest_pace` | workouts | Latest run matching `linked_workout_types` (e.g. `easy_run`, `tempo_run`). Pace is duration_minutes / distance_miles. Lower is better. |
| `max_duration` | workouts | Find the longest duration of any matching workout (e.g. longest Z2 run). |
| `total_volume` | workouts (last 7 days) | Sum of weight × reps across linked exercises in the past week. |
| `latest_body_value` (v3.17) | body_metrics | Most recent non-null reading of the goal's `metric` column (`weight_lb`, `body_fat_pct`, `lean_mass_lb`, `skeletal_muscle_pct`, `bmi`). |
| `manual` | nothing | Coach owns the value entirely. Recompute only refreshes status (on_track / at_risk based on trajectory). |

---

## Where to look in the code

- `routes/workouts.js:255` — workout POST hook calling `recomputeForWorkout`
- `routes/body-metrics.js POST / bulk / PATCH` (v3.17) — body-metric hooks
- `routes/hevy.js:1431` — Hevy sync post-import hook calling `recomputeAllGoals`
- `routes/goals.js recomputeForWorkout` (~line 855) — filters goals to matching ones
- `routes/goals.js recomputeForBodyMetric` (v3.17) — filters to body-comp goals
- `routes/goals.js recomputeOneGoal` — loads data, runs the driver, persists current_value + status
- `lib/goal-compute.js DRIVERS` — the actual computation logic per compute_method

---

## TL;DR rules of thumb

1. **Workout → goal:** if your exercise name matches the goal's `linked_exercise_names` (case-insensitive exact), the goal auto-updates within 30 min of the Hevy sync. No need to ask Coach.

2. **Weigh-in → goal (v3.17):** if your goal has `compute_method: 'latest_body_value'`, the goal auto-updates the moment the body_metric row lands. RENPHO syncs → goal moves.

3. **No matching data:** goal stays where it was. No silent regression. `goal_history` lets you see the trajectory.

4. **Coach override:** `manual_locked: true` freezes the value. Auto-compute respects that until you unlock it.

5. **You can always force it:** `POST /api/goals/recompute-all` re-evaluates everything. Useful after manual edits, after a data import, or just to satisfy doubt.
