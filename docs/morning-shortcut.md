# Morning Vitals Shortcut

**Purpose:** every morning at 5:30am, pull six fields from Apple HealthKit and POST them to AB Brain's `daily_vitals_cache`. Coach reads from this cache when off-device.

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

## Building the Shortcut on iPhone

### Step 1 — create the Shortcut

1. Shortcuts app → Library → `+` to create new
2. Name: **Morning Vitals → AB Brain**

### Step 2 — get the date (one action)

Action: **Get Current Date**
→ Format Date: `Custom`, Format String: `yyyy-MM-dd`
→ This gives you the day's date string (`2026-05-05`).

### Step 3 — query each HealthKit metric (five actions)

For each of the five vitals below, add: **Find Health Samples** action with these settings.

Note: HealthKit reports HRV / RHR / sleep on a slight delay. Query a 36-hour window ending at "now" so the morning's values land even if Apple Watch synced after midnight.

#### 3a. HRV (heart rate variability SDNN)

- **Find** Health Samples
- **Type:** Heart Rate Variability
- **Sort by:** End Date, Latest First
- **Limit:** 1
- **Date range:** Started in the last `36 hours`

Then: **Get Quantity from Sample** → take the `value` (in milliseconds).

Save to variable `hrv_ms`.

#### 3b. Resting Heart Rate

- **Find** Health Samples → Resting Heart Rate, latest 1, last 36 hours
- Get Quantity from Sample → `value` (bpm)
- Save to variable `rhr_bpm`

#### 3c. Sleep total minutes (asleep stages)

- **Find** Health Samples → Sleep Analysis, **all matching**, last 36 hours
- Filter: where Sleep Stage is one of `Asleep Core`, `Asleep Deep`, `Asleep REM`, `Asleep Unspecified`
- For each filtered sample, compute `(End Date − Start Date)` in minutes
- Sum the durations
- Save to variable `sleep_total_min`

#### 3d. Sleep Deep minutes

- Same Find as above (Sleep Analysis, last 36 hours)
- Filter: where Sleep Stage is `Asleep Deep`
- Sum durations in minutes
- Save to variable `sleep_deep_min`

#### 3e. Sleep REM minutes

- Same Find (Sleep Analysis, last 36 hours)
- Filter: where Sleep Stage is `Asleep REM`
- Sum durations in minutes
- Save to variable `sleep_rem_min`

> **Tip:** rather than running Find Health Samples three times for sleep, run it once with `all matching` last 36 hours, save the result list to a variable, then derive `sleep_total_min` / `sleep_deep_min` / `sleep_rem_min` by filtering the same list three different ways. Faster + more reliable.

### Step 4 — get the device model (one action)

Action: **Get Device Details** → Model
Save to variable `source_device`.

### Step 5 — build the JSON body (one action)

Action: **Dictionary** with these keys (each value is the variable from above):

```
date              → [Formatted Current Date]
hrv_ms            → [hrv_ms variable]
rhr_bpm           → [rhr_bpm variable]
sleep_total_min   → [sleep_total_min variable]
sleep_deep_min    → [sleep_deep_min variable]
sleep_rem_min     → [sleep_rem_min variable]
source_device     → [source_device variable]
```

### Step 6 — POST to AB Brain (one action)

Action: **Get Contents of URL**
- URL: `{API_BASE}/api/v2/daily-vitals` (your Railway URL, e.g. `https://abrain-production.up.railway.app/api/v2/daily-vitals`)
- Method: POST
- Headers:
  - `Content-Type` → `application/json`
  - `x-api-key` → your API key (from Railway env var `API_KEY`)
- Request Body: **JSON** → the dictionary from Step 5

### Step 7 — confirm success

Optional: add **Show Notification** with the response body so you see "✓ vitals for 2026-05-05" each morning. Feels nice. Catches failures early.

---

## Schedule it

Shortcuts → Automation tab → `+` → Create Personal Automation
- **Time of Day**: 5:30 AM
- **Repeat**: Daily
- **Run Immediately** (no confirmation prompt)
- **Run when device is locked**: enabled if your iPhone supports it

Pick "Run Shortcut" → select `Morning Vitals → AB Brain`.

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
