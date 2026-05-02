# Routine: Evening Review

**Schedule:** Daily at 9:00 PM
**Output:** One `coaching_session` record tagged `evening_review`
**Conditional logic:** Sunday → no special handling here (weekly scorecard
runs in the Sunday morning brief instead).

---

## Purpose

End-of-day debrief. Auto-checks if a workout was logged today, computes
plan-vs-actual, captures anomalies, queues amendments for tomorrow's
morning brief. No human action required — Avi reads it next morning.

## Steps

### 1. Pull today's data

```
GET /api/daily-plans/by-date/{today}    (returns plan + actual + comparison + ring_progress)
GET /api/workouts?date={today}
GET /api/meals?date={today}
GET /api/nutrition/daily-summary?date={today}
GET /api/health/insights/today
```

### 2. Detect what kind of day it was

| Signal | Day type |
|--------|----------|
| At least one workout logged | training_day |
| No workout, plan said rest | planned_rest |
| No workout, plan said train | missed_session |
| No workout, no plan | unstructured |

### 3. Compute deltas (only if training_day)

- `effort_delta` = actual_effort − planned_effort
- `duration_delta_pct` = (actual_min − planned_min) / planned_min × 100
- `protein_pct` = actual_protein / target_protein × 100
- `cal_pct` = actual_cal / target_cal × 100
- HR-zone check: if intent was `aerobic_endurance` or `recovery` and
  actual avg HR pushed into Z3+, flag drift

Anomaly thresholds:
- |effort_delta| > 2 → flag
- |duration_delta_pct| > 25% → flag
- protein_pct < 80 → flag
- cal_pct < 70 → flag
- HR-zone drift on easy day → flag

### 4. Generate the review

```
EVENING REVIEW — {today}

WHAT WAS DONE
- {workout type, duration, effort, distance}
- Meals: {N meals, total cal, total protein}
- Subjective: {mood / motivation / soreness if logged}

PLAN vs ACTUAL
- Effort: {actual} vs {planned} ({delta})
- Duration: {actual} vs {planned} ({delta_pct}%)
- Nutrition: {actual_cal}/{target_cal} kcal, {actual_protein}/{target_protein}g protein

ANOMALIES
- {flagged item 1: what + likely why}
- {flagged item 2}
- (or "none — execution matched plan")

INJURY RESPONSE
- {if any active injuries: today's status update}

QUEUED FOR TOMORROW
- {1-3 specific adjustments to surface in tomorrow's morning brief}
```

If day_type was `missed_session`, lead with that and ask (in
`next_steps`) what got in the way — Avi will see this in the Project
chat next time he opens it.

If day_type was `unstructured` and a workout was logged, treat it as
a training day and infer what intent it served.

### 5. Long-session fueling rehearsal nudge

If a workout's `time_duration` ≥ 60 min AND no `fueling_rehearsal` row
exists for today's date with `workout_id` matching:

Add to `next_steps`: "Long session today — log fueling rehearsal in the
morning Coach chat (Skill: log-fueling-rehearsal)."

### 6. Save the coaching session

```
POST /api/training/coaching
{
  "session_date": "{today}",
  "title": "Evening review — {today}",
  "summary": "{the full formatted review above}",
  "key_decisions": [...anomalies + decisions...],
  "adjustments": [...amendments queued for tomorrow...],
  "injury_notes": "{updated status}",
  "nutrition_notes": "{adherence notes}",
  "recovery_notes": "{HRV/sleep observations}",
  "next_steps": "{1-3 concrete things for tomorrow}",
  "ai_source": "claude",
  "tags": ["routine", "evening_review"]
}
```

### 7. Update today's daily plan

If `today_plan` exists, mark its status:
- `completed` if anomalies are minor
- `partial` if duration < 70% of plan
- `missed` if no workout logged but plan called for one
- `amended` if Avi did a different session than planned

```
PUT /api/daily-plans/{plan_id}
{
  "status": "...",
  "completion_notes": "{1-2 sentences from the review above}",
  "actual_exercises": [...if Fitbod-style data was captured...]
}
```

## Error handling

- If no workout was logged AND no plan existed: write a brief review
  noting it (don't skip — this is a data point).
- If only some endpoints succeed: compose what you can, flag missing
  sections.
- Never delete or override prior coaching sessions — always insert new.
