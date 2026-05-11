# Rebuild HAE → Forge ingest

If Apple Health data has stopped flowing into Forge (no new HR zones on workouts, recovery score degraded, empty Z2 chart), the culprit is almost always the iPhone side: either the Shortcut got deleted, the API key changed, or you stopped triggering it.

This doc walks you through getting it back. Two paths — pick whichever is less effort for you.

---

## Confirm Forge is healthy first

Before rebuilding the iPhone side, verify the server is still accepting payloads:

```bash
curl -X POST -H "X-Api-Key: <your-key>" -H "Content-Type: application/json" \
  -d '{"data":{"metrics":[],"workouts":[]}}' \
  "$BASE/api/health/ingest"
```

Expected: 200 with a JSON body describing what was parsed (probably empty insert counts since the payload is empty). If you get 200, Forge is fine and the problem is on the iPhone. If you get 401/403/500, tell me what the error says.

Check the most recent successful ingest:

```bash
curl -H "X-Api-Key: <your-key>" "$BASE/api/health/imports?limit=1" | jq
```

The `ingested_at` field on the latest row tells you when ingest last fired. If it's > 7 days ago, you've been data-dark on HR/sleep/calories for that long.

---

## Path 1 (Recommended): Health Auto Export app

Easier than maintaining a custom Shortcut. The Health Auto Export iOS app handles the export + scheduling + retry.

1. Install **Health Auto Export — JSON+CSV** from the App Store (paid, ~$5; the free version doesn't include the auto-sync feature).
2. Open the app → Automations → Add Automation.
3. Configure:
   - **Trigger**: Time of day (e.g. 6:00 AM) — or Manual if you want explicit control
   - **Health Data**: All the categories you care about. Minimum: Heart Rate, HRV, Resting Heart Rate, Active Energy, Workouts, Sleep Analysis, Steps. Maximum: everything.
   - **Aggregate type**: Per Sample (don't roll up — Forge can aggregate downstream)
   - **Data Range**: Yesterday (or Last 24 Hours)
   - **Export Format**: JSON
   - **Destination**: REST API
4. Set the REST API endpoint:
   - **URL**: `https://<your-forge-host>/api/health/ingest`
   - **Method**: POST
   - **Headers**:
     - `X-Api-Key: <your-key>`
     - `Content-Type: application/json`
   - **Body**: Default (leave HAE's native payload shape — Forge's format D detector handles it)
5. Tap "Run Once" to test. Expected toast: "Success" or "200 OK".
6. Check Forge:
   ```bash
   curl -H "X-Api-Key: <your-key>" "$BASE/api/health/imports?limit=1" | jq '.results[0] | {ingested_at, source_format, file_bytes}'
   ```
   `source_format` should be `"D"`. `ingested_at` should be the time you just tapped Run Once.
7. If the test worked, leave the automation enabled and you're done.

Forge accepts format D natively (it's the HAE app's native shape — `body.data.metrics` and `body.data.workouts`). No transformation needed on the iPhone side.

---

## Path 2: Custom Shortcut

If you don't want to pay for HAE or you had a custom Shortcut that worked before, here's the rebuild.

The Shortcut needs to:

1. Pull health data via Apple's "Get Health Sample" or "Find Health Samples" action
2. Build a JSON body matching one of Forge's supported formats (A, B, or D)
3. POST it to `https://<your-forge-host>/api/health/ingest` with the right headers

The shape Forge prefers is format A (custom — daily summaries):

```json
{
  "activity": {
    "daily": [
      {
        "date": "2026-05-11",
        "steps": 8234,
        "distance_mi": 4.2,
        "exercise_minutes": 42,
        "active_energy_kcal": 412,
        "basal_energy_kcal": 1820,
        "resting_hr_bpm": 56,
        "hrv_sdnn_ms": 48,
        "vo2_max": 47.2,
        "sleep_total_min": 425,
        "sleep_deep_min": 78,
        "sleep_rem_min": 92,
        "sleep_core_min": 220,
        "sleep_awake_min": 35,
        "sleep_efficiency_pct": 92.5
      }
    ]
  }
}
```

For workouts with HR data, format B is better — it includes time-series HR samples that Forge uses to compute Z1-Z5 minutes:

```json
{
  "date_range": { "start": "2026-05-11", "end": "2026-05-11" },
  "metrics": [
    {
      "type": "HeartRate",
      "samples": [
        { "t": "2026-05-11T06:15:23Z", "value": 142 },
        { "t": "2026-05-11T06:15:38Z", "value": 145 }
      ]
    }
  ],
  "workouts": [
    {
      "type": "Running",
      "start": "2026-05-11T06:00:00Z",
      "end": "2026-05-11T06:45:00Z",
      "distanceMeters": 6800,
      "activeEnergyKcal": 410
    }
  ]
}
```

Forge's format B parser at `routes/health.js:1297` joins the HR samples to the workout windows and writes `hr_zones` JSONB to the matching workouts row.

### Shortcut steps (high level)

In iOS Shortcuts:

1. **Find Health Samples** (multiple actions, one per data type: HR, HRV, RHR, Active Energy, etc.)
2. **Repeat With Each** sample → build a dictionary entry for that sample
3. **Get Dictionary** to assemble the final body matching format A or B
4. **Get Contents of URL**:
   - URL: `https://<your-forge-host>/api/health/ingest`
   - Method: POST
   - Headers: `X-Api-Key` and `Content-Type`
   - Request Body: JSON, the dictionary from step 3
5. **Show Result** so you can see the response

Tip: build it incrementally. Get one data type working first (steps, easiest), confirm Forge accepts the payload, then add HR, then HRV, etc.

If you find an old broken Shortcut on your phone, the most common reason it stopped working is:

- API key rotated → re-paste in the headers action
- Base URL changed (you redeployed Forge to a new host) → update the URL action
- The Shortcut got into a "needs review" state from iOS update → open it, tap each action to acknowledge any warnings, save

---

## Verify data is flowing

After your first successful run, check three things:

```bash
# 1. Ingest hit the server
curl -H "X-Api-Key: <key>" "$BASE/api/health/imports?limit=3" | jq '.results[] | {ingested_at, source_format, date_range_start, date_range_end}'

# 2. daily_activity has fresh rows
curl -H "X-Api-Key: <key>" "$BASE/api/health/daily?date=$(date +%Y-%m-%d)" | jq

# 3. A recent workout has hr_zones populated
curl -H "X-Api-Key: <key>" "$BASE/api/workouts?limit=3" | jq '.workouts[] | {workout_date, source, hr_zones_present: (.hr_zones != null)}'
```

For #3, the hr_zones come from format B ingest joining HR samples to workout windows. If you're using format A only (no HR samples), workouts get the metric fields (HR avg/max, calories) but not the zone breakdown.

---

## Schedule it

Once one-shot works:

- **Path 1 (HAE app)**: the automation you set up runs on schedule. Done.
- **Path 2 (custom Shortcut)**: configure an iOS Automation in the Shortcuts app:
  - Open Shortcuts → Automation tab → New Personal Automation
  - Trigger: Time of Day, 6:00 AM daily (or whatever)
  - Run Shortcut → pick your HAE shortcut
  - Run Immediately, Notify Off (or On if you want a confirmation)

Most users run it once in the morning (captures yesterday's data complete) plus once in the evening (catches today's workout if you trained earlier).

---

## What lights back up once HAE is flowing

- **Recovery score** uses sleep stages + HRV + RHR (was running on partial data)
- **Z2 minutes chart** in Training tab fills with the last 12 weeks
- **TSS / CTL / ATL chart** gets more accurate (less guessing from effort × duration)
- **Workout detail "Heart Rate Zones" section** renders again
- **Daily activity card** on Today (steps, NEAT, basal calories)
- **Workout HR avg/max** on every Apple Watch session

If you're prepping for the Riverdale 5K, you want all of this back before Phase 2 (the build block where Z2 volume matters most).

---

## Need help with the Shortcut

If you try the HAE app and something's still not landing, paste:

1. The output of the `imports?limit=1` curl (latest ingested_at)
2. Any error message from the HAE app or the Shortcut
3. The HTTP status code from the POST

I can diagnose from there. The endpoint hasn't changed since v1.8 — anything that worked before should still work.
