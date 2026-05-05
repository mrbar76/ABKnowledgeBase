# Morning Vitals Shortcut

**Purpose:** each morning, pull six fields from Apple HealthKit and POST them to AB Brain's `daily_vitals_cache`. Coach reads from this cache when off-device.

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

This runbook is grounded in Apple's official Shortcuts documentation (event triggers, Get Contents of URL with JSON body) and the [Shortcuts actions reference](https://matthewcassinelli.com/actions/find-health-samples/) — but Apple's Shortcuts UI varies slightly across iOS versions and some actions don't have public Apple docs. **Action names below are what I've verified; exact dropdown labels may differ on your device.** When something doesn't match, screenshot it and we'll fix the doc.

The shortcut is small (~10–14 actions). The fragile part is sleep — see Step 3c for the simpler path.

## Building the Shortcut on iPhone

### Step 1 — create the Shortcut

1. Shortcuts app → Library → `+` to create new
2. Name: **Morning Vitals → AB Brain**

### Step 2 — get the date (one action)

Action: **Format Date** (input: Current Date)
→ Format: `Custom`, Format String: `yyyy-MM-dd`
→ This gives you the day's date string (e.g. `2026-05-05`).

Save it to a variable named `date`.

### Step 3 — query HealthKit

For each of the vitals below, add a **Find Health Samples** action.

**Apple confirms** Find Health Samples supports filters on Value / Start Date / End Date / Duration / Source / Name, and sorts by date / value / duration / source / name. The "Type" parameter is what selects the metric (HRV, Resting HR, Sleep Analysis, etc.).

**Why a 36-hour window:** HealthKit syncs HRV / RHR / sleep on a slight delay. A 36h window ending at "now" catches values even if Apple Watch synced after midnight or you woke up late.

#### 3a. HRV (heart rate variability)

- Action: **Find Health Samples**
- **Type:** Heart Rate Variability
- **Sort by:** End Date, Latest First
- **Limit:** 1
- Filter: **Start Date is in the last 36 hours**

To extract the number from the returned sample, add a **Get Details of Health Sample** action (or whichever action your iOS version exposes for sample property extraction) → property **Quantity** or **Value**. Save to variable `hrv_ms`.

> If the property dropdown shows different option names than "Quantity"/"Value" on your iPhone, pick the numeric one (HRV is a quantity type — value is in milliseconds).

#### 3b. Resting Heart Rate

- Action: **Find Health Samples** → **Type:** Resting Heart Rate, **Limit:** 1, **Sort:** Latest First, filter Start Date in last 36 hours
- Extract Quantity / Value → save to variable `rhr_bpm`

#### 3c. Sleep — the simpler path

Sleep is a *category* type (not quantity), with stages: in bed, asleep core, asleep deep, asleep REM, awake. Filtering and summing per-stage durations inside Shortcuts works but is fragile.

**Simpler approach: send only `sleep_total_min` for now.** The endpoint is happy receiving a partial payload (deep + REM as null is fine). If the simple version works for two weeks of coaching, we don't bother with stage-level detail. If Coach asks for more, we add it.

- Action: **Find Health Samples** → **Type:** Sleep Analysis, **Limit:** unset, filter Start Date in last 36 hours
- Add a **filter** (using the action's `+ Add Filter` UI): "Value is not In Bed" — keeps only the asleep stages
- Then either:
  - **Option A (cleaner if available):** the action exposes a "Total Duration" or sum aggregation → use it
  - **Option B (works if A isn't available):** add **Repeat with Each** → inside, **Calculate** Sample's End Date − Start Date in minutes → accumulate into a Math variable → after the loop, save the total as `sleep_total_min`

Leave `sleep_deep_min` and `sleep_rem_min` empty for the first version. The endpoint accepts them as null.

> When you build this in iOS, screenshot the Sleep Analysis filter dropdown — what exact stage labels does it show? Send me the screenshot and I'll rewrite this section verbatim. Right now I'm guessing the label is "In Bed" but it could be "InBed" or "Asleep (In Bed)" depending on iOS version.
- Get Quantity from Sample → `value` (bpm)
- Save to variable `rhr_bpm`

### Step 4 — device label (optional)

Action: **Get Device Details** → property: pick a model/identifier label (UI varies — "Device Model" or similar). Save to `source_device`. Skip this step if your iOS version doesn't expose a clean model property — it's optional in the payload.

### Step 5 — build the JSON body (one action)

Action: **Dictionary** with the following keys. Each value references the variable you saved earlier:

```
date              → date variable from Step 2
hrv_ms            → hrv_ms variable from Step 3a
rhr_bpm           → rhr_bpm variable from Step 3b
sleep_total_min   → sleep_total_min variable from Step 3c (may be empty)
sleep_deep_min    → leave blank for v1
sleep_rem_min     → leave blank for v1
source_device     → source_device variable from Step 4 (may be empty)
```

The endpoint validator only requires `date` plus at least one numeric field. Empty/blank values are treated as null.

### Step 6 — POST to AB Brain (one action)

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

Pick **Run Shortcut** → select `Morning Vitals → AB Brain`.

> Per Apple's [event triggers documentation](https://support.apple.com/guide/shortcuts/event-triggers-apd932ff833f/ios), the Sleep "Waking Up" trigger fires when your Wake Up alarm sounds (or, with no alarm, per your Sleep Schedule). Requires a Sleep Schedule set in the Health app (Health → Sleep → Your Schedule). This is more robust than a fixed time because by the time it fires, Apple Watch has closed the night's sleep session and HRV / RHR / sleep stages are populated.
>
> **Note on timing:** Apple's docs warn that "Waking Up" fires at the *scheduled* wake time, not necessarily when you physically get out of bed. So if you sleep through your alarm, the trigger still fires at the schedule time — the safety-net 10am run below covers the case where Apple Watch hadn't yet closed the sleep session at scheduled wake time.

### Trigger 2 — 10:00 AM safety net

Same Automation flow:
- **Time of Day**: 10:00 AM
- **Repeat**: Daily
- **Run Immediately**
- **Run when device is locked**: enabled

Pick **Run Shortcut** → select `Morning Vitals → AB Brain`.

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
- AB Brain: `GET /api/v2/daily-vitals?date=2026-05-05` returns the row

If 400: validator error, check the body shape.
If 401/403: API key missing or wrong.
If 500: backend error, check Railway logs.

---

## Why six fields and not more

Coach reads HealthKit live for everything when it's running on iPhone. The cache exists for the cases where Coach is running on a Mac/web/Claude Code and HealthKit isn't reachable. Six fields cover the daily readiness signals (HRV, RHR, sleep total + deep + REM). Anything else Coach needs from HealthKit, it queries live.

If you find yourself wanting a seventh field, the question is: **what coaching decision does it enable that the existing six don't?** If the answer is "trend analytics" → it belongs in the Progress tab via live HealthKit query at retro time, not in the morning cache.

---

## What this replaces

| Old | New |
|---|---|
| HAE app → Dropbox auto-export | This Shortcut |
| LODE / HealthDataExport / HealthExportKit | This Shortcut |
| AB Brain Dropbox poller (`/api/health/dropbox-sync`) | Direct POST to `/api/v2/daily-vitals` |
| Format A/B/C/D parser dispatch | None — Shortcut sends typed JSON |
| Mojibake repair, HR object-shape unwrap, stale-rescue | None — Apple HealthKit returns clean values |

Once this Shortcut runs reliably for 7 days, the entire HAE → Dropbox → parser → dedup pipeline gets torn out (Phase 7).
