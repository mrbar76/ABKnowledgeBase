# Morning Vitals Shortcut

**Purpose:** each morning, pull six fields from Apple HealthKit and POST them to Forge's `daily_vitals_cache`. Coach reads from this cache when off-device.

**Replaces:** all the old HAE / LODE / HealthDataExport / HealthExportKit auto-export to Dropbox automations. Direct 6-field POST instead of file generation + Dropbox round-trip.

---

## What it sends

`POST {API_BASE}/api/v2/daily-vitals` with header `x-api-key: {API_KEY}` and JSON body:

```json
{
  "date": "2026-05-05",
  "hrv_ms": 42.7,
  "rhr_bpm": 56,
  "sleep_total_min": 410,
  "sleep_deep_min": 62,
  "sleep_rem_min": 95,
  "source_device": "iPhone17,1"
}
```

All vital fields are optional individually (e.g., HealthKit may not have a sleep recording on a given night), but the payload must include `date` and at least one numeric field.

Re-POSTing the same date is idempotent — `ON CONFLICT (date)` upsert with `COALESCE` so a later run with more data doesn't blank earlier values.

---

## Heads-up before you start

This runbook reflects the action flow verified in iOS 18 Shortcuts on May 5, 2026 (HRV + RHR round-trip proven into `daily_vitals_cache`). Apple's exact labels vary slightly across iOS versions; the *pattern* is what matters: **Find Health Samples → name the magic variable → reference it in the Dictionary with property = Value** (the property picker appears automatically when you tap a magic-variable chip).

### Hardware constraints (Apple Watch Series 3)

| Metric | Series 3 | Why |
|---|---|---|
| HRV, RHR, sleep total, respiratory rate | ✓ Available | Series 3 sensors record these |
| Sleep stages (deep/REM/core/awake) | ✗ Not available | Stage detail requires watchOS 9 / Series 4+ |
| SpO2 / blood oxygen | ✗ Not available | Series 6+ sensor |
| Wrist temperature | ✗ Not available | Series 8+ sensor |

The schema accepts the missing fields anyway — they sit null until you upgrade. Don't waste Shortcut UI time wiring queries that won't have data.

The shortcut is small (~12 actions on Series 3). The fragile part is sleep stages — Series 3 doesn't record them, so just send `sleep_total_min` and skip stages entirely. See Step 3c.

## Building the Shortcut on iPhone

### Step 1 — create the Shortcut

1. Shortcuts app → Library → `+` to create new
2. Name: **Morning Vitals → Forge**

### Step 2 — get the date (one action)

Action: **Format Date** (input: Current Date)
→ Format: `Custom`, Format String: `yyyy-MM-dd`
→ This gives you the day's date string (e.g. `2026-05-05`).

Save it to a variable named `date`.

### Step 3 — query HealthKit

For each vital below, add a **Find Health Samples** action. The pattern is identical for every quantity-type metric — copy-paste-modify is fine.

**Why a 3-day window:** HealthKit records HRV / RHR / respiratory rate at irregular cadence (Apple Watch logs them when conditions are right, sometimes with 1-2 day gaps). A 3-day window ending at "now" reliably catches the latest reading even on slow days.

**Magic-variable + property pattern (verified May 5, 2026):**
1. Find Health Samples produces a "Health sample" magic variable. Tap the action's variable indicator and **rename the variable** (e.g. to `HRV`, `RHR`, `RespRate`) — this makes downstream references readable.
2. In the Dictionary action (Step 5), reference that variable. When you tap the variable chip, a property picker opens showing Value / Type / Unit / Start Date / End Date / Duration / Source / Name. **Pick `Value`** for any quantity type. The chip then displays as something like "Get HRV from Value" — that's the correct shape.
3. **Don't** add a separate "Get Details of Health Sample" action. Newer iOS Shortcuts handles property extraction directly on the magic-variable chip; adding a wrapper action causes property-slot confusion (we lost an hour to this on May 5).

#### 3a. HRV (heart rate variability)

- Action: **Find Health Samples**
- **Type:** Heart Rate Variability
- **Unit:** ms
- **Sort by:** End Date, **Order:** Latest First
- **Limit:** ON, 1 sample
- Filter: **Start Date is in the last 3 days**
- Rename the result variable: **`HRV`**

In Step 5 you'll reference `HRV` with property = Value (this is HRV in milliseconds).

#### 3b. Resting Heart Rate

- Action: **Find Health Samples**
- **Type:** Resting Heart Rate
- **Unit:** count/min (== BPM under HealthKit's hood; auto-fills correctly)
- **Sort by:** End Date, **Order:** Latest First
- **Limit:** ON, 1 sample
- Filter: **Start Date is in the last 3 days**
- Rename the result variable: **`RHR`**

In Step 5 you'll reference `RHR` with property = Value.

#### 3c. Respiratory Rate

- Action: **Find Health Samples**
- **Type:** Respiratory Rate
- **Unit:** count/min
- **Sort by:** End Date, **Order:** Latest First
- **Limit:** ON, 1 sample
- Filter: **Start Date is in the last 3 days**
- Rename the result variable: **`RespRate`**

In Step 5 you'll reference `RespRate` with property = Value.

#### 3d. Sleep total (Series 3 path)

Sleep is a *category* type (not quantity), with stages: in bed, asleep core, asleep deep, asleep REM, awake. **On Series 3, only "asleep" / "in bed" are recorded** — there's no per-stage detail to extract.

Send only `sleep_total_min`. The endpoint is happy with deep / REM / core / awake all null.

- Action: **Find Health Samples**
- **Type:** Sleep Analysis
- **Limit:** unset (you want all sleep periods from last night)
- Filter: **Start Date is in the last 3 days**
- Add a filter: **"Value is not In Bed"** — this keeps only asleep stages, excluding bed-time padding

Then sum the durations:
- **Option A (if available):** the action exposes a "Total Duration" output — use it directly, save as `SleepTotal`
- **Option B (works on all iOS versions):** add **Repeat with Each** over the result → inside, **Calculate** Sample's End Date − Start Date in minutes → accumulate into a Math variable → after the loop, save the total as `SleepTotal`

In Step 5 you'll reference `SleepTotal` directly (no property pick needed if it's already a Number).

> If you upgrade to Apple Watch Series 4+ later: add 4 more Find Health Samples actions (one per stage: Asleep Core, Asleep Deep, Asleep REM, Awake), each filtered to that stage's value, and sum each stage's durations into `SleepCore`, `SleepDeep`, `SleepREM`, `SleepAwake` magic variables. Schema columns are already in place.

### Step 4 — device label (skip)

This was originally going to use **Get the Device Name**, but Apple's Shortcuts UI doesn't expose a clean device-model variable that lands cleanly in the Dictionary. The endpoint accepts `source_device` as null, and no coaching logic uses it (only the activity log, which falls back to `'shortcut'`). **Skip this step.** Do NOT include `source_device` as a Dictionary key — leave it out entirely.

### Step 5 — build the JSON body (one action)

Action: **Dictionary**. **Key names must match the endpoint validator exactly** — typos here are silent (the field gets ignored as unknown, the row gets created with a null in that column).

For each value cell: tap the cell, pick the magic variable from Step 3, then set property = **Value** in the picker that appears.

| Dictionary key (exact) | Value | Required |
|---|---|---|
| `date` | the `date` variable from Step 2 | yes |
| `hrv_ms` | `HRV` magic var, property = Value | needs ≥ 1 vital |
| `rhr_bpm` | `RHR` magic var, property = Value | |
| `respiratory_rate_bpm` | `RespRate` magic var, property = Value | |
| `sleep_total_min` | `SleepTotal` accumulator (already a number; no property pick) | |

**Common mistakes (we hit each of these on May 5, 2026):**

| Symptom | Cause | Fix |
|---|---|---|
| Field stored as null in DB even though Apple Health has data | Dictionary key misspelled (e.g. `hrv` not `hrv_ms`) — endpoint silently ignores unknown keys | Rename the key exactly per table above |
| Field stored as `0` | Dictionary value pointing at the wrong magic variable, or property slot accidentally set to a variable instead of "Value" from the dropdown | Tap the value chip → pick the right variable + property = Value |
| Both chips in "Get [X] from [Y]" have heart icons | You inserted a magic variable into the property slot. Tap it → delete → re-pick "Value" from the property dropdown list (no chip) | |
| Row's `updated_at` doesn't change after a run | Shortcut errored before reaching the POST step. Check Activity log (long-press the Shortcut tile → Activity) | |

The endpoint validator only requires `date` plus at least one numeric field. Empty/blank values are treated as null. Any key the endpoint doesn't know about gets silently dropped.

### Step 6 — POST to Forge (one action)

Action: **Get Contents of URL** (Apple confirms POST request body supports JSON):
- **URL:** `{API_BASE}/api/v2/daily-vitals` (your Railway URL, e.g. `https://abrain-production.up.railway.app/api/v2/daily-vitals`)
- **Method:** POST
- **Headers:**
  - `Content-Type` → `application/json`
  - `x-api-key` → your API key (from Railway env var `API_KEY`)
- **Request Body:** JSON → reference the Dictionary from Step 5

> Apple's docs note that JSON Request Body in this action only supports objects at the top level (not arrays). Our payload is an object — fine.

### Step 7 — confirm success

Optional: add **Show Notification** with the response body so you see `{"ok":true,"row":...}` each morning. Catches silent failures.

---

## Schedule it — two triggers, primary + safety net

Sleep data only finalizes in HealthKit *after* Apple Watch detects you waking up. If we fire too early (e.g. 5:30 AM while you're still asleep), sleep is null. So we use two automations and let the endpoint's `COALESCE` merge handle re-runs.

### Trigger 1 — Sleep → Waking Up (primary)

Apple offers two related triggers; the one we want is under **Sleep**, not Alarm:

Shortcuts → Automation tab → `+` → Create Personal Automation → **Sleep** category → **Waking Up**
- **Run Immediately** (no confirmation prompt)
- **Notify When Run**: optional

Pick **Run Shortcut** → select `Morning Vitals → Forge`.

> Per Apple's [event triggers documentation](https://support.apple.com/guide/shortcuts/event-triggers-apd932ff833f/ios), the Sleep "Waking Up" trigger fires when your Wake Up alarm sounds (or, with no alarm, per your Sleep Schedule). Requires a Sleep Schedule set in the Health app (Health → Sleep → Your Schedule). This is more robust than a fixed time because by the time it fires, Apple Watch has closed the night's sleep session and HRV / RHR / sleep stages are populated.
>
> **Note on timing:** Apple's docs warn that "Waking Up" fires at the *scheduled* wake time, not necessarily when you physically get out of bed. So if you sleep through your alarm, the trigger still fires at the schedule time — the safety-net 10am run below covers the case where Apple Watch hadn't yet closed the sleep session at scheduled wake time.

### Trigger 2 — 10:00 AM safety net

Same Automation flow:
- **Time of Day**: 10:00 AM
- **Repeat**: Daily
- **Run Immediately**
- **Run when device is locked**: enabled

Pick **Run Shortcut** → select `Morning Vitals → Forge`.

> If you woke up before 10, the Wake Up trigger already filled the row and this 10am run is a harmless no-op (idempotent UPSERT). If you slept past 10 (or didn't have a Sleep Schedule), this run catches whatever's available.

### Why this is safe to run twice

The endpoint is idempotent — `INSERT ... ON CONFLICT (date) DO UPDATE` with `COALESCE` per field. Re-POSTing the same date with partial data doesn't blank existing values. Concretely:

| Run | What it sends | Result in `daily_vitals_cache` |
|---|---|---|
| 7:15 AM (Wake Up fires) | hrv=42, rhr=56, sleep_total=410, deep=62, rem=95 | row created, all fields filled |
| 10:00 AM (safety net) | hrv=42, rhr=56, sleep_total=410, deep=62, rem=95 | identical → no change |
| 10:00 AM (when you slept in) | hrv=42, rhr=56, sleep blank | row created with HRV/RHR; sleep null |
| 11:30 AM (you wake up; Wake Up fires) | sleep_total=520, deep=80, rem=110 | sleep fields populated; HRV/RHR preserved |

Worst case: you sleep all day and never wake up. Then only the 10am partial row exists. Coach surfaces `is_stale` on the sleep card and asks you about it next time you're online.

---

## Test it

Run it manually first (tap the Shortcut tile). Expected:
- Notification: `{"ok": true, "row": {...}}`
- Forge: `GET /api/v2/daily-vitals?date=2026-05-05` returns the row

If 400: validator error, check the body shape.
If 401/403: API key missing or wrong.
If 500: backend error, check Railway logs.

---

## What this Shortcut covers and why

| Field | Source | Coverage |
|---|---|---|
| `hrv_ms` | Apple Watch HRV reading | Daily readiness (deviation from baseline) |
| `rhr_bpm` | Apple Watch resting HR | Daily readiness (deviation from baseline) |
| `respiratory_rate_bpm` | Apple Watch overnight breath rate | Recovery / illness early-warning |
| `sleep_total_min` | Apple Watch / iPhone sleep tracking | Sleep debt + recovery |
| `sleep_deep_min` / `sleep_rem_min` / `sleep_core_min` / `sleep_awake_min` | (Series 4+ only) | Sleep quality breakdown |

On iPhone, Coach reads HealthKit live via MCP for everything. **This cache exists for off-device coaching** — Mac, web Claude.ai, Claude Code — where HealthKit isn't reachable. Without it, ~60-70% of coaching conversations would have no vital data.

Why these specific fields and not, say, daily steps or workouts? **Different distribution shape.** Daily totals (steps, calories, workouts) are derivative of moment-to-moment activity that HealthKit accumulates in real time; they don't fit the "snapshot at Wake Up" model. Workouts come in via Hevy + Apple Watch direct sync. Body composition comes via RENPHO photo intake. The morning cache is scoped to **readiness signals only** — what Coach needs to decide today's training intensity.

---

## What this replaces

| Old (retired) | New |
|---|---|
| HAE app → Dropbox auto-export | This Shortcut |
| LODE / HealthDataExport / HealthExportKit | This Shortcut |
| Forge Dropbox poller (`/api/health/dropbox-sync`) | Direct POST to `/api/v2/daily-vitals` |
| Format A/B/C/D parser dispatch | None — Shortcut sends typed JSON |
| Mojibake repair, HR object-shape unwrap, stale-rescue | None — Apple HealthKit returns clean values via Shortcut |

HAE has been retired (May 2026). The legacy `daily_activity` table still holds historical pre-Shortcut data; insights endpoints UNION it with `daily_vitals_cache` (cache wins on overlapping dates). Phase 7 will drop `daily_activity` once enough cache history accumulates.
