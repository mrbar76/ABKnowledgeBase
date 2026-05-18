# Forge — Training Tab Polish (revised spec)

Branch: `forge/training-polish` off `redesign/v2`.

Three content/UX fixes + Fix 4 split across three sub-fixes for `viewDate` propagation. Half a day plus 30 min backend.

Surgical changes only. Do not bundle other findings (audit Section 6.2 hydration tap, 6.7 chevron re-fetch, 6.8 `fitnessSubTab`, 6.9 inline styles, 6.1 dead 4-sub-tab code). Those are tracked separately.

---

## Fix 1 — Drop `coaching_notes` from the Today/Session hero card body

**Where:** `renderTrainingTodaySession`, `public/app.js:7506-7557`.

**What's wrong:** The hero card body currently includes the entire `plan.coaching_notes` field — a wall of 80+ words ("Stacked leg week. Mon lower, Tue lower. Thu stair level 10. AV flagged calf could be talking…"). Same prose also renders inside `showDailyPlanDetail`. Duplicate content. The hero is 6+ lines on iPhone when it should be 3-4.

**Code change:** Delete the unconditional push at `app.js:7544`:

```js
if (plan.coaching_notes) debriefLines.push(plan.coaching_notes);   // ← DELETE THIS LINE
```

**What stays:** The conditional debrief block right above it (line 7533-7543) — actual-vs-planned minutes, avg effort, session count. Those metrics earn their place because they only render when `status` is `completed` or `partial` and there's something to summarize.

**No change to detail sheet:** `showDailyPlanDetail` at `app.js:13776` already renders `coaching_notes` (audit Section 3.2). Don't add anything there — the prose is preserved, just moved out of the hero.

**Acceptance:** On a planned-but-not-yet-done day, hero shows: badge + kicker + title only. No body line. On a completed day, hero shows: badge + kicker + title + one debrief line ("58 min actual / 60 min planned · avg effort 7.4/10").

---

## Fix 2 — Empty state for Training Load sheet

**Where:** `showTrainingLoadSheet`, `public/app.js:7682-7773`.

**What's wrong:** When there's no logged training in the 42-day window (`history.length === 0`), the sheet still renders three "0 / —" stat cards at the top and a "0 workouts · 0 TSS" weekly row. The chart canvases below are correctly skipped (the conditional at 7708 already handles that). Result: a half-empty modal that looks like a Chart.js failure instead of an honest "no data yet" state.

**Threshold:** Render empty-state when no day in the 42-day window has any logged TSS. The route zero-pads `history` to one entry per day, so `history.length` is always 42 — check `history.every(h => !h.tss)` instead. **Do not** apply a "≥3 workouts OR weekly TSS ≥30" threshold — sparse data is still data and the user should see it.

**Code change:** At the top of the try block in `showTrainingLoadSheet` (after the `data` is fetched, before the `head` const at line 7691), check for empty:

```js
const noTraining = history.every(h => !h.tss);
if (noTraining) {
  const empty = '<div class="ab-list-row" style="cursor:default;margin:24px 16px;border:1px solid var(--ab-border);border-radius:16px">' +
    '<div class="ab-list-row-body">' +
      '<div class="ab-list-row-title">No training in the last 42 days.</div>' +
      '<div class="ab-list-row-meta">Once you log a few sessions, this view shows your form, fitness, and fatigue trends.</div>' +
    '</div>' +
  '</div>';
  openModal('Training load', empty, { variant: 'sheet' });
  return;
}
```

No CTA button. Forge has no central "log workout" entry, and a button that just dismisses the sheet adds nothing. Just the explanation.

**Voice:** Calm, factual. The user hasn't done anything wrong — the system just has no data to show. No nagging, no fake encouragement.

**Acceptance:** Open Training Load sheet when there's no data → see only the empty-state copy in a single bordered card. No stat cards. No section labels for charts that won't render.

---

## Fix 3 — `viewDate` propagation (three sub-fixes)

When the user navigates to a past date via Date Nav, the rest of the Training tab should reflect that date. Three places where it currently doesn't:

### Fix 3a — Body section honors viewDate

**Where:** `loadFitness`, `public/app.js:7263` and `renderTrainingBodySection`, `public/app.js:7792-7830`.

**What's wrong:** Body fetch at line 7263 is `/body-metrics?limit=1` — always returns the latest weigh-in regardless of `viewDate`. The `stale` flag at line 7812 compares to `today` (`localDateStr()`), not `viewDate`. Result: navigating to last Tuesday still shows today's weigh-in, not the most recent one as of Tuesday.

**Backend change:** `routes/body-metrics.js:94-106` — add a new `on_or_before` query parameter alongside the existing `before` (which uses strict `<`). Don't change the existing `before` semantics; other callers may rely on it.

```js
const { q, source, since, before, on_or_before, latest, limit = 50, offset = 0, sort } = req.query;
// ...
if (on_or_before) { where.push(`measurement_date <= $${i++}`); params.push(on_or_before); }
```

**Frontend change:** `public/app.js:7263`:
```js
api('/body-metrics?on_or_before=' + viewDate + '&limit=1').catch(() => null),
```

`renderTrainingBodySection` needs to know the viewDate to compute `stale` correctly. Add a second parameter:

```js
function renderTrainingBodySection(body, viewDate) {
  // ... existing code ...
  const stale = latest.measurement_date && String(latest.measurement_date).slice(0,10) !== viewDate;
  // ... existing code ...
}
```

And update the call site at `public/app.js:7312`:
```js
renderTrainingBodySection(data.body, data.viewDate)
```

**Acceptance:** Navigate to a date 5 days ago. Body section shows the most recent weigh-in from that date or earlier (not a weigh-in logged after that date). The "(May 12)" stale-date suffix appears if the most recent weigh-in is older than the viewed date.

### Fix 3b — Training Load honors viewDate

**Where:** `loadFitness` `public/app.js:7272`, `showTrainingLoadSheet` `public/app.js:7682-7773`, and `routes/insights.js:601-690`.

**What's wrong:** The endpoint anchors its 42-day window to `Date.now()`. Past-date views show today's TSB/CTL/ATL, not the values that existed on the viewed date.

**Backend change:** `routes/insights.js:601-690` — add `end_date` query parameter. When present, anchor the window to that date instead of `Date.now()`. Three places use `Date.now()` for window math (lines 604, 625, 649) plus the `z2MinutesByWeek` helper at line 706. All four must respect `end_date`.

```js
router.get('/training', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 90, 365);
    const endDate = req.query.end_date || new Date().toISOString().slice(0, 10);
    const endMs = new Date(endDate + 'T12:00:00').getTime();
    const startDate = new Date(endMs - days * 86400_000).toISOString().slice(0, 10);

    // ... query unchanged, but add upper bound:
    const w = await query(
      `SELECT id, workout_date, started_at, workout_type, time_duration,
              heart_rate_avg, effort, distance, tss, hr_zones
       FROM workouts
       WHERE workout_date >= $1 AND workout_date <= $2
       ORDER BY workout_date ASC`,
      [startDate, endDate]
    );
    // ...

    // Daily TSS series — anchor to endDate, not Date.now()
    for (let i = 0; i < days; i++) {
      const d = new Date(endMs - (days - 1 - i) * 86400_000).toISOString().slice(0, 10);
      dailyTss.set(d, 0);
    }
    // ...

    // Weekly summary (last 7 days ending at endDate)
    const weekStart = new Date(endMs - 7 * 86400_000).toISOString().slice(0, 10);
    const weekWorkouts = workouts.filter(wo => wo.workout_date >= weekStart && wo.workout_date <= endDate);
    // ...

    // Pass endDate to z2MinutesByWeek
    z2_minutes_by_week: z2MinutesByWeek(workouts, 12, endDate),
```

And `z2MinutesByWeek` needs an `endDate` parameter to anchor its 12-week window.

**Frontend change:** `public/app.js:7272`:
```js
api('/health/insights/training?days=42&end_date=' + viewDate).catch(() => null)
```

And in `showTrainingLoadSheet` at `public/app.js:7685`:
```js
const data = await api('/health/insights/training?days=42&end_date=' + (trainingDate || localDateStr()));
```

**Acceptance:** Navigate to a past date with logged training around it. Training Load section shows TSB/CTL/ATL values that reflect the 42-day window ending at that date. Tap into the sheet → same context, with charts ending at the viewed date.

### Fix 3c — Recovery sheet honors viewDate

**Where:** `showRecoveryDetail`, `public/app.js:11734-11782`.

**What's wrong:** Line 11737 always fetches `/recovery/score?date=' + localDateStr()`. The list row in section 2.6 (`renderTrainingRecoverySection`) uses the `viewDate` data correctly, but tapping into the sheet jumps the user back to today's score.

**Code change:** Read the `trainingDate` module variable at line 11737:

```js
const r = await api('/recovery/score?date=' + (trainingDate || localDateStr()));
```

No backend change — the route already accepts `?date=` (`routes/recovery.js:19-23`).

**Acceptance:** From a past-date Training tab, tap the Recovery card. Sheet shows that date's score, not today's.

---

## Out of scope (calling out so they don't get bundled)

- **Strip ISO date prefix from session title** — *kept on purpose.* The prefix ships through to HEVY so Avi can identify what to do on a specific day. Don't touch.
- **Hydration tap inconsistency (audit 6.2)** — needs a separate Hydration logging sheet. Feature, not polish. Tracked as follow-up.
- **Chevron re-fires 9 API calls (audit 6.7)** — inefficiency, not a bug. Defer.
- **Inline styles vs CSS classes (audit 6.9)** — cleanup. Defer.
- **`fitnessSubTab` vestigial state (audit 6.8)** — cleanup. Defer.
- **Dead 4-sub-tab code (audit 6.1)** — separate decision (delete / gate / revive). Tracked separately.

---

## Acceptance criteria (full)

After this PR ships:

1. Today/Session hero card on the Training tab fits in 3-4 lines on iPhone. Long workout prose only appears in the Daily Plan detail sheet.
2. Tap into Training Load when no data exists in the last 42 days → see "No training in the last 42 days." card. No stat cards. No blank chart canvases.
3. Navigate to a past date via Date Nav → Body section shows the most recent weigh-in on or before that date. Training Load values reflect the 42-day window ending at that date. Recovery detail sheet shows that date's score.
4. Navigate back to today → all sections update correctly.

## Smoke test screenshots requested back

1. Training tab top showing trimmed Today/Session hero (planned day and completed day)
2. Daily Plan sheet open showing the long workout prose moved cleanly there
3. Training Load sheet on empty-state
4. Training tab with `viewDate` set to a past date (full scroll), proving Body / Training Load reflect that date
5. Recovery detail sheet opened from a past-date Training tab

## Time estimate

~Half a day frontend + ~30 min backend (the `end_date` param on `/training` and the `on_or_before` param on `/body-metrics`).
