# Coaching Rules — Athlete-Specific Training Load & Recovery

## Provenance

These rules are derived from a data-driven analysis of the athlete's own
training history through May 2026, performed by Claude.ai on the workouts
+ daily_activity dataset. Two consecutive injury cascades (3/17/2026 and
4/3/2026) were preceded by clear, measurable training-load patterns. The
rules below encode those patterns as automated alerts so the cascades
become preventable.

The rules are **stronger predictors than HRV/RHR** for early warning,
because they're causal (load → damage), not reactive (HRV measures damage
3-5 days after the fact).

## Rule A — Chronic Load Alarm

**Trigger**: 7-day rolling effort sum > 50 for 5+ consecutive days
**Trigger**: OR 7-day effort sum jumps ≥30% week-over-week
**Action**: Force a deload. Recommendation flips to "DELOAD" regardless
of HRV reading.

**Evidence (cascade 2, 4/3/2026)**: Sustained at 49–57 for a full week
before the cascade started.

## Rule B — Density Alarm

**Trigger**: 3+ consecutive days with at least one workout at effort ≥ 7
**Action**: Force rest day. Recommendation: "Recovery day. Sleep, walk,
mobility only."

**Evidence**: Two-for-two — both cascades preceded by 3 consecutive
hard days.
- 3/15–3/17 (3 hard days) → cascade 3/17
- 4/1–4/3 (3 hard days) → cascade 4/3

## Rule C — Rest-Day Underfueling

**Trigger**: Previous day was a rest day (no workout OR max effort < 5)
AND previous day's protein < 130g
**Action**: Surface a "underfueling recovery" flag on the nutrition view.

**Evidence**: Rest-day average 2,187 kcal / 106g protein vs hard-day
average 2,622 kcal / 138g protein. Tissue repair happens on rest days;
a 190 lb athlete needs 130g+ protein on recovery days for repair.

## Rule D — Apple Watch Fragment Cleanup

**Trigger**: Multiple `apple_health` workouts on the same date where any
one has duration < 5 minutes.
**Action**: Treat the cluster as fragments of a single session. Pick the
longest-duration row as survivor. Sum durations and distances. Delete
fragments. (Implemented in `mergeAllWorkoutDuplicates` in `routes/health.js`.)

**Evidence (4/1/2026)**: One session split into 6 apple_health entries:
3:31, 3:27, 3:04, 45:00, 12:34, 36:35. Aggregated effort math becomes
meaningless; effort distribution analysis is corrupted; "20 sessions/week"
counts double the real volume.

## Validated trends (no rule needed — these are working)

- **Hard-session recovery is excellent.** 23 hard sessions analyzed. Average
  next-day HRV: 105% of 7-day baseline. Only 4/23 had poor recovery
  (<85% baseline). An isolated hard session does not break the engine —
  density and chronic load do.
- **HRV trend is improving.** 60-day net trajectory up. Base parasympathetic
  capacity gained 3–4ms over the spring even with race stress in the middle.

## Watchlist (track but don't alert yet)

- **Saturday HRV is consistently the worst day** (~36ms vs week avg ~46ms),
  despite Saturday being the lightest training day. Likely Friday-night
  Shabbat dinner timing/wine/sodium or sleep disruption. Not yet an
  automated alert; revisit when more data accumulates.

## How the rules surface in the app

- `GET /api/health/insights/today` — response includes `alerts: [...]` array
  when Rules A or B trigger. Each alert has `{ severity, type, reason }`.
- `GET /api/health/insights/nutrition` — response includes `rest_day_flag`
  when Rule C triggers, with the prior day's protein deficit.
- Home dashboard's "Today's Readiness" card renders an alert banner above
  the score when any alerts are present.
- `routes/health.js mergeAllWorkoutDuplicates()` — Rule D runs every time
  workouts ingest from Format A or D, automatically.

## Trends endpoint (Coach API)

The Coach should fetch `GET /api/health/insights/trends` for the user's full
state in a single call. Shape:

```
{
  generated_at: ISO,
  windows: { short: 7, medium: 30, long: 90 },
  sleep:     { current, target, score, trend, debt: { rolling_7d, rolling_14d, rolling_30d }, regularity, history },
  nutrition: { today, targets: { calories, protein, carbs, fat }, rolling: { d7, d30 }, protein_trend, history },
  training:  { current: { atl, ctl, tsb, weekly_tss, weekly_z2_min, weekly_workouts, weekly_miles, weekly_hours }, targets, load_trend, history },
  body:      { current, targets, weight_trend, history },
  vitals:    { hrv, rhr, vo2_max, walking_speed_mph, walking_asymmetry_pct },
  alerts:    [...]    // composite — same Rules A/B as /insights/today
}
```

### How the Coach should use it

1. **Check `alerts` first.** If any have `severity: 'high'`, override training
   recommendations with rest/deload regardless of HRV.
2. **Compare current vs target per section.** Each section has `target`
   (with `value`, optional `value_max`, `comparison`, `source`). When `source
   === 'user'` the target is athlete-set and should be respected over defaults.
3. **Use `direction` to spot drift early.** Direction is set when the 30d mean
   deviates from the prior-60d mean by > 0.5σ. `up`/`down`/`stable`. For sleep
   duration `up` is good, for RHR/weight `down` is good — the UI inverts the
   color but the raw flag is uncolored.
4. **Sleep is the user's named #1 weakness.** Lead with it. Reference the
   Sleep Score (0-100), the rolling debt in hours, and the stage breakdown.
   When debt > 2h over 14 days, recommend earlier bedtime tonight.
5. **Targets editor.** Coach can guide the user to Settings → Fitness & Gym →
   Targets to adjust any goal. Default targets are athlete-appropriate but the
   user can override.
