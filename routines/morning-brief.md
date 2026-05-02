# Routine: Morning Brief

**Schedule:** Daily at 5:00 AM (Avi wakes ~5:30 AM)
**Output:** One `coaching_session` record tagged `morning_brief`
**Conditional logic:** Sunday → fold in weekly scorecard. 1st of month →
fold in monthly physiology check. days_to_race ≤ 14 → fold in race-week
pulse. Saturday during Shabbat window → home-basement modalities only.

---

## API access (read this first)

**Base URL:** `https://ab-brain.up.railway.app/api`

All endpoints below are relative to that base. Prepend the base URL to
every path (e.g., `/health/insights/morning` → `https://ab-brain.up.railway.app/api/health/insights/morning`).

**Auth:** Send the `X-Api-Key` header on every request. The API key is
provided as the `AB_BRAIN_API_KEY` environment variable in this routine's
configuration. **The value is the same secret as the AB Brain server's
`API_KEY` env var** (defined in `.env.example`); only the env-var name
differs in scope (`API_KEY` server-side, `AB_BRAIN_API_KEY` in the
routine's config to avoid colliding with other API keys the routine
might use later). If you can't find it, halt and report: do not proceed
without auth.

```
curl -H "X-Api-Key: ${AB_BRAIN_API_KEY}" \
     https://ab-brain.up.railway.app/api/health/insights/morning
```

**Apple Health (freshness fallback):** If the AB Brain reading shows
`is_stale: true`, fall back to the Apple Health MCP for today's HRV /
RHR / steps. Note the source as "apple_health" in the brief.

**Shabbat times (Saturdays only):** Free, no auth.
```
GET https://www.hebcal.com/shabbat?cfg=json&zip=10705&geo=zip
```

---

## How to run this routine

This document is the **prompt body** for both manual and scheduled
execution. Same content either way.

**Manual run (testing or one-off):** Just execute every step below in
order against today's date. Output goes to AB Brain via the POST in
Step 6, surfaces on the home dashboard's "Today's Brief" card.

**Scheduled run (autonomous):** Set up a Cloud Routine at
https://claude.ai/code/routines with:
- **Schedule:** `0 5 * * *` (cron — 5am daily, local timezone)
- **Prompt:** the entire contents of this file from "## Steps" onward
- **Repo:** `mrbar76/abknowledgebase`
- **Env var:** `AB_BRAIN_API_KEY` set to the AB Brain key
- **Permissions:** allow Bash + WebFetch (for Hebcal)

The routine writes a `coaching_session` regardless of whether triggered
manually or via cron — the data path is the same. The Today's Brief
card on the home dashboard reads the most recent `coaching_session`
tagged `morning_brief` for today's date.

**Today's date is whatever the day actually is.** Check today's day-of-week
and date-of-month at the START of the routine to determine which
conditional sections fire (Sunday → weekly scorecard, 1st → physiology
check, race ≤ 14d → race-week pulse, Friday/Saturday → Shabbat check).

---

## Purpose

When Avi wakes up, today's prescription is already waiting on the home
tab. No "remember to check in" cognitive load. He reads, he acts, he
logs. ADHD-aware externalization.

## Steps

### 1. Pull context (parallel)

All paths are relative to `https://ab-brain.up.railway.app/api`.

```
GET /health/insights/morning
GET /training/injuries/active/summary
GET /workouts?since={yesterday}&limit=5
GET /meals?date={yesterday}
GET /nutrition/daily-summary?date={yesterday}
GET /recovery/score?date={today}
GET /daily-plans?date={today}
```

If `/insights/morning.readiness.hrv.is_stale` is true, fall back to
Apple Health for today's HRV. Note the source in the brief.

### 2. Conditional pulls

- **If today is Sunday** → also pull `GET /health/insights/weekly-review?week_of={yesterday}`
- **If today is the 1st of the month** → pull `GET /athlete/profile` and check `effective_from` ages of LTHR, max HR, sweat rate, VO2
- **If `/insights/morning.upcoming_race.days_to_race ≤ 14`** → pull `GET /health/insights/race?race_id={upcoming.id}`
- **If today is Friday or Saturday** → fetch Hebcal to determine if Shabbat is currently active:
  ```
  GET https://www.hebcal.com/shabbat?cfg=json&zip=10705&geo=zip
  ```
  Default zip 10705 unless `daily_context.travel_status` is set (then ask in
  the brief for current zip). Find candle-lighting and Havdalah times.
  If today + current local time is between them, set `shabbat_active = true`.

### 2.5. Apply Shabbat constraint

If `shabbat_active = true`:
- **Legal modalities only:** home-basement strength, mobility, walking
  indoors, stretching, yoga, foam rolling. Indoor only.
- **Illegal:** outdoor sessions, gym/Y, cycling outside, races, anything
  requiring driving or screens-during.
- If today's `daily_plans` row calls for an illegal modality, the brief's
  prescription defaults to home-basement recovery. State the swap honestly.

If today is Saturday but Shabbat ended last night (or starts later
tonight), proceed without the constraint.

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
POST /training/coaching
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
POST /daily-plans
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
