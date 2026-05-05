# Subjective Vitals Shortcut

A 5-question one-tap iOS Shortcut that captures Avi's subjective state
without typing. Pairs with the morning vitals Shortcut (HRV/RHR/sleep)
to close the gap on what HealthKit can't measure.

**Replaces:** typing answers in chat when Coach asks "how'd you sleep?",
"how's mood?", "any soreness?". Coach reads the daily_context row off
the cache instead of asking.

**Endpoint:** `POST /api/nutrition/daily-context` (already exists; upserts
on date with COALESCE per field — re-running overwrites only the keys
provided, preserves existing).

---

## Building the Shortcut

### Step 1 — date

Action: **Format Date** (input: Current Date, format: `yyyy-MM-dd`)
Save to variable `date`.

### Step 2 — five Ask for Input prompts

For each: **Ask for Input** action.

| # | Prompt | Input type | Default | Variable |
|---|---|---|---|---|
| 1 | "Sleep quality 1-10" | Number | 7 | `sleep_quality` |
| 2 | "Mood 1-10" | Number | 7 | `mood` |
| 3 | "Motivation 1-10" | Number | 7 | `motivation` |
| 4 | "Soreness overall 1-10" | Number | 3 | `soreness_overall` |
| 5 | "Life stress 1-10" | Number | 3 | `life_stress` |

Numbers force a numeric keyboard so it's literally one-tap-per-question.

### Step 3 — Dictionary

Action: **Dictionary** with these keys (exact spelling — typos silently
drop into nothing):

| Dictionary key | Value (magic variable) |
|---|---|
| `date` | the `date` variable from Step 1 |
| `sleep_quality` | `sleep_quality` magic var |
| `mood` | `mood` magic var |
| `motivation` | `motivation` magic var |
| `soreness_overall` | `soreness_overall` magic var |
| `life_stress` | `life_stress` magic var |

### Step 4 — Get Contents of URL

- **URL:** `{your Railway URL}/api/nutrition/daily-context`
- **Method:** `POST`
- **Headers:**
  - `Content-Type` → `application/json`
  - `x-api-key` → your AB Brain API key
- **Request Body:** JSON → reference the Dictionary

### Step 5 — Confirm (optional)

**Show Notification** with the response body. If you see
`{"id": "...", "date": "...", ...}` you're good.

---

## Schedule

**No automation.** Trigger manually whenever you want — usually:
- Once in the morning after waking (before the first chat)
- Optionally again at end-of-day if mood/stress shifted materially

Why no Wake Up automation? The 5 questions need typing/tapping; a Wake
Up trigger that prompts at scheduled wake time would be intrusive. Run
manually when you actually have a moment to answer.

---

## Why these 5 fields and not more

Coach's audit identified these as the subjective signals that actually
move coaching decisions:

- **sleep_quality (1-10):** distinguishes "I slept 7h but it was awful"
  from "7h and I feel rested" — HealthKit can't tell.
- **mood (1-10):** ADHD-aware coaching needs this; flat-mood days get
  different prescriptions than upbeat-mood days.
- **motivation (1-10):** maps directly to whether to push or pull back
  intensity today.
- **soreness_overall (1-10):** combined-area score; granular soreness_areas
  is JSONB but not in this Shortcut (defer to chat-time logging).
- **life_stress (1-10):** Friday-night gathering pattern, work pressure,
  family things — affects HRV interpretation.

Anything else (illness_flag, travel_status, alcohol, hydration_liters,
bedtime_self_report) is logged in chat when relevant — no need to type
through every day.

---

## Idempotency

The endpoint upserts on `date` with COALESCE per field:
- Run at 7am with mood=7 → row created with mood=7, others null
- Run at 11am with mood=5 → mood updated to 5, other fields preserved
- Run at 9pm with sleep_quality=8 (correcting earlier estimate) → only
  sleep_quality changes

Safe to run multiple times per day. Coach reads the most recent row
when scenarios call for it (e.g., `/api/coach/end-of-day` includes
`subjective_context` which is the day's daily_context row).

---

## Coach reads via

- `GET /api/coach/end-of-day` → `subjective_context` field
- `GET /api/nutrition/daily-context?date={today}` for direct reads
- The morning brief (Step 1 of `morning-check-in` skill) does NOT pull
  daily_context — subjective Q&A happens in-conversation when needed,
  separate from the readiness brief which fires off `/coach/morning`.
