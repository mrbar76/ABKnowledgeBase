# Routine: Morning Brief

**Schedule:** Daily at 5:00 AM (Avi wakes ~5:30 AM)
**Output:** One `coaching_session` record tagged `morning_brief`
**Conditional logic:** Sunday → fold in weekly scorecard. 1st of month →
fold in monthly physiology check. days_to_race ≤ 14 → fold in race-week
pulse.

---

## Purpose

When Avi wakes up, today's prescription is already waiting on the home
tab. No "remember to check in" cognitive load. He reads, he acts, he
logs. ADHD-aware externalization.

## Steps

### 1. Pull context (parallel)

```
GET /api/health/insights/morning
GET /api/training/injuries/active/summary
GET /api/workouts?since={yesterday}&limit=5
GET /api/meals?date={yesterday}
GET /api/nutrition/daily-summary?date={yesterday}
GET /api/recovery/score?date={today}
GET /api/daily-plans?date={today}
```

If `/insights/morning.readiness.hrv.is_stale` is true, fall back to
Apple Health for today's HRV. Note the source in the brief.

### 2. Conditional pulls

- **If today is Sunday** → also pull `GET /api/health/insights/weekly-review?week_of={yesterday}`
- **If today is the 1st of the month** → pull `GET /api/athlete/profile` and check `effective_from` ages of LTHR, max HR, sweat rate, VO2
- **If `/insights/morning.upcoming_race.days_to_race ≤ 14`** → pull `GET /api/health/insights/race?race_id={upcoming.id}`

### 3. Apply hard rules

Check `alerts[]` from `/insights/morning`. If any has `severity: 'high'`:

- **chronic_load alert** → today is forced deload, override any planned session
- **density alert** → today is forced rest
- **rest-day underfueling flag** → lead with nutrition; training is secondary
- **active injury severity ≥ 7** → modify all sessions per injury `modifications`
- **illness flag = active** → rest until resolving
- **sleep < 5h two nights running** → halve session intensity
- **ACWR > 1.5** → flat or reduced volume, no spike

State the rule firing in the brief honestly.

### 4. Generate the brief

Write to `summary` in the format below. Voice rules from
`/docs/coach-project-instructions.md` apply.

```
READINESS CHECK
- Injury status: [active injuries with severity + trend, or "none active"]
- Recovery: [score/100 + label + key limiting component]
- Yesterday: [workout type, effort, duration, fueling adherence]
- Alerts: [Rules A/B/C if firing, or "none"]

TODAY'S SESSION
- Intent: [aerobic_endurance / aerobic_durability / threshold / vo2max / race_specific / recovery / strength / mobility]
- What: [session type + focus]
- Why: [connection to current block thesis or next race goal]
- Constraints: [injury mods, intensity ceiling]
- Duration / Effort target: [N min @ effort N/10 or Z2-Z3]

NUTRITION TARGET
- Calories: [target — from daily_plans.target_calories if set, else day-type table]
- Protein minimum: [Ng]
- Pre-workout (60-90 min before): [300-500 cal carb-dominant if effort 6+]
- Post-workout (within 60 min): [30-40g protein + 50-80g carbs]

WATCH FOR
- [injury signal that would trigger amend-day]
- [performance cue that matters today]

PROCESS WIN
- [one tangible specific recent win to anchor — see ADHD-aware mode in instructions]
```

### 5. Conditional sections

**If Sunday — append weekly scorecard:**

```
WEEK SCORECARD ({last_sunday} – {yesterday})

| Domain | Grade | Note |
|--------|-------|------|
| Engine | [A-F] | [hill pace, ACWR, polarization] |
| Strength & Carries | [A-F] | [progression] |
| Race Specificity | [A-F] | [% quality sessions] |
| Recovery | [A-F] | [rest compliance, sleep, HRV trend] |
| Nutrition | [A-F] | [meal logging %, cal/protein compliance] |
| Injury Management | [A-F] | [severity trend, rehab compliance] |
| Overall | [A-F] | [weighted by next-race impact] |

NEXT WEEK FOCUS
- [1-3 amendments]
```

Apply caps from instructions: meal logging < 50% caps Nutrition at C;
no effort 7+ caps Engine + Race Specificity at C; injury worsened →
Injury Management D or F; polarization coverage < 60% → Engine
confidence flagged.

**If 1st of month — append physiology check:**

```
PHYSIOLOGY CHECK
- LTHR: last set [date], [N] weeks ago. [Retest in 2 weeks / current]
- Max HR: last set [date]. [Yearly cadence]
- Sweat rate: last set [date]. [Seasonal — retest before next race]
- VO2 max (passive): [latest value, age]
```

If any test is stale, set `next_steps` to include "schedule retest within
N days."

**If race ≤ 14d — append race-week pulse:**

```
RACE WEEK PULSE — {race_name}, T-{days}
- Phase: [sharpen / taper / race-week / race-day]
- Today's adjustment: [from /insights/race.taper_recommendation]
- Fueling rehearsals in last 28d: [count + last gut/energy response]
  - If 0: REFUSE to confirm race plan; demand a long-session rehearsal
- Gear list status: [from race.gear_list — flag if empty]
- Fueling plan status: [from race.fueling_plan — flag if empty]
```

### 6. Save the coaching session

```
POST /api/training/coaching
{
  "session_date": "{today}",
  "title": "Morning brief — {today}",
  "summary": "{the full formatted brief above}",
  "key_decisions": [...],
  "adjustments": [...],
  "injury_notes": "{from /insights/morning.active_injuries}",
  "nutrition_notes": "{from /insights/morning.yesterday_context + today's target}",
  "recovery_notes": "{from /insights/morning.readiness}",
  "next_steps": "{1-3 concrete actions}",
  "ai_source": "claude",
  "tags": ["routine", "morning_brief"]
}
```

### 7. If today's plan is missing or stale

If `/insights/morning.today_plan` is null OR was created > 7 days ago,
also write a fresh `daily_plans` row for today:

```
POST /api/daily-plans
{
  "plan_date": "{today}",
  "workout_type": "...",
  "intent_type": "...",
  "phase": "{from current_block}",
  "target_effort": N,
  "target_duration_min": N,
  "target_calories": N,
  "target_protein_g": N,
  "target_carbs_g": N,
  "target_fat_g": N,
  "goal": "{thesis sentence}",
  "rationale": "{why this session today}",
  "ai_source": "claude"
}
```

## Error handling

- If `/insights/morning` returns 5xx: skip, log error, retry next day. Do
  not write a partial brief.
- If a single endpoint times out: proceed with the data you have, flag
  the missing section in the brief.
- If Apple Health MCP is unavailable: use whatever AB Brain has, note
  staleness.
