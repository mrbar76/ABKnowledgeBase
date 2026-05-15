# Training Tab — Architecture as Built (May 15, 2026)

This document describes the Training tab as it actually renders in production, derived from reading `public/app.js`. Where two code paths exist for the same surface (a live one and dead-code descendants), both are named explicitly. No prescriptions; no aspirational framing.

> **Critical finding up front (Section 6):** There are two parallel Training implementations in the codebase. Only one is wired to the tab navigation. The other — a 4-sub-tab structure (`Day View / Plans / Coaching / Injuries`) at `app.js:12356-13800` — is approximately **1,500 lines of dead code** never reached from the live tab. Anything you've seen, used, or designed against in those sub-tabs is not what users see.

---

## Section 1 — Entry and top-level structure

### What the user lands on

When the user taps **Training** in the bottom-tab strip:

1. `switchTab('training')` at `app.js:191` is invoked.
2. `app.js:223` routes: `else if (tab === 'training') loadFitness();`
3. `loadFitness()` at `app.js:7247` runs.

The handler function is still named `loadFitness` (the tab was renamed Training in "v2 Foundation Phase 2," per the comment at `app.js:7242-7243`). There is no rename of the function itself. Searching for `loadTraining` will mislead you — see Section 6.

### Loading sequence

`loadFitness()` (`app.js:7247-7281`) does these things in order:

1. **Line 7251:** Immediately paints `renderTrainingSkeleton()` (`app.js:7298`) into `#main-content`. The skeleton is a single line: `<div class="ab-big-picture">Training · Loading…</div>`.
2. **Lines 7258-7273:** `Promise.all` of **nine** API calls fired in parallel, each individually `.catch(() => null)` so any one can fail without breaking the page:

| Endpoint | Bound variable | Used by section |
|---|---|---|
| `/training/day/${viewDate}` | `dayData` | Today/Session hero |
| `/goals/dashboard` | `goals` | Big Picture (phase/race) + Goals section |
| `/recovery/score?date=${viewDate}` | `recovery` | Recovery section |
| `/nutrition/daily-summary?date=${viewDate}` | `fuel` | Fuel section |
| `/body-metrics?limit=1` | `body` | Body section |
| `/daily-plans?week_start=${weekStart}` | `weekPlans` | Week strip |
| `/races/upcoming` | `races` | Big Picture (race countdown) |
| `/workouts?limit=30` | `weekWorkouts` | Week strip (status dots) |
| `/health/insights/training?days=42` | `trainingLoad` | Training Load section |

3. **Line 7279:** Replaces the skeleton with `renderTraining({...})` — a single string concat of 9 section render functions (see Section 2).
4. **Line 7280:** `renderIcons()` to inflate Lucide icons.

### State persistence

| Variable | Defined | Scope | Persisted across reloads? |
|---|---|---|---|
| `trainingDate` | `app.js:7245` | module `let`, `null` = today (live) | **No** — resets to `null` on page reload |
| `fitnessSubTab` | `app.js:7240` | module `let`, `'today'` default | **No** — but **also never read by the live renderer**. Vestigial. |
| `currentTab` | global | module `let` | **No** |

There is no localStorage / sessionStorage write for any Training state. Last-viewed sub-tab does not survive a reload.

### Top bar / global elements

The top bar belongs to the shell, not the Training renderer. Its contents are updated by `updateTopbar(tab)` at `app.js:219` and rendered separately. **Nothing in Training itself controls the top bar.**

The bottom-tab strip (Today / Productivity / Training / Personal, plus settings) is also shell-level and not part of Training.

### Sub-tab strip below the tab bar

**There is no sub-tab strip in the live Training tab.** Everything below the tab bar is the 9-section pipeline rendered as a single scroll surface.

---

## Section 2 — Section-by-section inventory of the live Training tab

The renderer (`renderTraining` at `app.js:7302-7314`) returns one string concatenating these 9 sections in order. They render unconditionally if the data exists; sections with `null` data are silently omitted.

### 2.1 — Big Picture / Phase / Race (`renderTrainingBigPicture`, `app.js:7334-7406`)

Header card. Four mutually exclusive variants based on `goals.active_phase`, `goals.next_phase`, and `races/upcoming` filtered to dates `>= viewDate`:

| Variant | Trigger | Eyebrow | Title | Meta | Countdown | Tap target |
|---|---|---|---|---|---|---|
| **Empty** | No phase, no next phase, no race | "Training" | "No active phase." | "Plan a race in Settings → Races to start a block." | — | none |
| **Upcoming race** (line 7359) | `nextRace` exists | `Phase N · NAME` or `Up next` | `race_name` | date · distance · terrain · A/B race | `Nd` or `race day` | `showRaceDetail(nextRace.id)` |
| **Active phase, no race** (line 7382) | `phase` exists, no race | `Active phase · phase_name` | `phase.description` | `Through DATE` | `Nd remaining` | `showRaceDetail(phase.linked_race_id)` if set |
| **Between phases** (line 7395) | `next` exists | "Between phases" | `next.phase_name` | `Starts DATE` | `starts in Nd` or `starts today` | none |

Card styling: `class="ab-big-picture ab-pillar-training"`. Countdown rendered as `<span class="ab-big-picture-countdown">` inside the card.

### 2.2 — Date navigation (`renderTrainingDateNav`, `app.js:7316-7332`)

Three controls in a flex row:

| Element | Action | file:line |
|---|---|---|
| Left chevron button `‹` | `setTrainingDate(prevStr)` (one day back) | 7328 |
| Center label | If `isToday`: shows "Today" (no subtitle). Else: shows `Mon, May 14` + a "← back to today" link that calls `setTrainingDate(null)` | 7329 |
| Right chevron button `›` | `setTrainingDate(nextStr)` (one day forward) | 7330 |

`setTrainingDate(d)` (`app.js:7283-7286`) sets `trainingDate` and re-calls `loadFitness()` — a full page re-fetch and re-render, not an incremental update.

No date picker (calendar widget). No week-jump. Single-day stepping only, plus the "back to today" escape.

### 2.3 — Week strip (`renderTrainingWeekStrip`, `app.js:7451-7504`)

Seven day pills, Mon-Sun, anchored to the week containing `viewDate`. Each pill (`<div class="ab-week-day">`):

- **Label** (`Mon`, `Tue`, ..., `Sun`)
- **Status dot** with class derived from this priority logic (`app.js:7479-7491`):
  1. If a workout exists for that date → `completed` (or `partial` if plan was tagged partial)
  2. Else if plan exists with status in `[completed, partial, missed, rest]` → use plan status
  3. Else if past date AND plan exists → `missed`
  4. Else → `''` (empty)
- **Day number**
- **Today highlight:** `ab-today` class if `dStr === realToday`
- **Currently-viewing outline:** 2px outline if `dStr === viewDate` AND `!isToday`
- **Onclick:** `setTrainingDate(dStr)` — switches the entire Training view to that day

Status data is reconciled in JS between `plans` (from `/daily-plans?week_start=...`) and `workoutsByDate` (from `/workouts?limit=30`). The comment at `app.js:7480-7484` is worth noting: it explicitly avoids trusting `plan.status` alone because plans are often left as `planned` even after the workout was logged.

### 2.4 — Today / Session hero (`renderTrainingTodaySession`, `app.js:7506-7557`)

Section label: `Today` if `viewDate === realToday`, else `Session`.

**Empty state** (`app.js:7510-7519`, when `dayData.daily_plan` is null):
```
[Section label] Today
[ab-list-row, non-interactive]
  Title: "Rest day." (if today) or "No session." (if other day)
  Meta:  "No session planned."
```

**Loaded state** (`app.js:7546-7556`):

`<div class="ab-hero-card ab-pillar-training">` with `onclick="showDailyPlanDetail('${plan.id}')"` if a plan ID exists.

| Field | Source | Notes |
|---|---|---|
| Pillar label | Static "TRAINING" | left |
| Kicker | `· workout_type · X min planned · effort N/10` | metaParts join, omits null pieces |
| Status badge | `plan.status` | right-aligned; data-state CSS hook |
| Title | `plan.title` (falls back to `workout_type`, then "Session") | comment at line 7520 explicitly forbids falling back to `workout_focus` because that field carries raw slugs like `rdl_pull_grip` |
| Body (debrief) | Computed when `status` is `completed` or `partial` AND `workouts.length > 0`: actual minutes vs planned, avg effort, session count, and `coaching_notes` if present | joined by ` · ` |

Tap → `showDailyPlanDetail(plan.id)` (see Section 3).

### 2.5 — Goals (`renderTrainingGoalsSection`, `app.js:7559-7622`)

Top: `<div class="ab-section-label">Goals</div>`.

**Empty state** (`app.js:7561-7566`):
```
[ab-list-row, non-interactive] "No active goals." / "Set a goal in the Goals area."
```

**Loaded state:** up to 5 goals (`list.slice(0, 5)`, line 7568). Each goal renders as `<div class="ab-goal-row" onclick="showGoalDetail('${g.id}')">`:

| Element | Source | Conditional |
|---|---|---|
| Title | `g.title` | always |
| Phase role chip | `g.active_phase_role === 'primary' \| 'maintenance'` | hidden if `inactive` |
| Status badge | `g.status` or computed `'pending'`/`'on_track'` | always |
| Evidence chip | `g.evidence_label` (`strong` / `heuristic`) | only if set |
| Progress bar | `current_value / target_value` % | only if `hasData` |
| Expected-today marker | `expected_today / target_value` % on the bar | only if both fields set |
| Value line | `current/target` with `unitFor(metric)` OR `Baseline set` if `is_at_baseline` OR `no data yet` | always |
| Days left | `g.days_left` | only if set |
| Coaching line (italic) | `g.coaching_action` | only if set |

Comment at `app.js:7577-7582` lists v3.2 fields the section now surfaces: `active_phase_role`, `evidence_label`, `coaching_action`, `expected_today`, `is_at_baseline`.

### 2.6 — Recovery (`renderTrainingRecoverySection`, `app.js:7624-7646`)

Renders nothing if `recovery` is null (line 7625).

**Two sub-elements:**

1. **List row** (`ab-list-row` with `onclick="showRecoveryDetail()"`):
   - Title: `score label` (e.g., `82 strong`)
   - Meta: `recovery.recommendation`
2. **3-up glance row** (`ab-glance-row`): three cards labeled Sleep / Load / Muscle, each pulling `recovery.components.{sleep|training_load|muscle_freshness}.detail`, truncated to 16 chars. All three cards have `onclick="showRecoveryDetail()"`.

All four tap targets go to the same detail. No granular drill-down.

### 2.7 — Training Load (`renderTrainingLoadSection`, `app.js:7651-7677`)

Hides if `load.current` is null OR if `tsb`, `ctl`, and `weekTss` are all null (lines 7652, 7662).

**Two sub-elements:**

1. **List row** with `onclick="showTrainingLoadSheet()"`:
   - Title: `TSB +N` (or `-N`) + status word
   - Meta: `CTL N · ATL N · this week N TSS / N.Nh`
2. **3-up glance row:** Form (TSB) / Fitness (CTL) / Z2 per week. All three cards `onclick="showTrainingLoadSheet()"`.

### 2.8 — Fuel (`renderTrainingFuelSection`, `app.js:7775-7790`)

Renders nothing if `fuel` is null (line 7776).

**3-up glance row** only — no list row preceding it:

| Card | Value | Target sub-label | Tap |
|---|---|---|---|
| Calories | `total_calories` | `/ planned cal` if `plan_targets.calories` set, else "today" | `showNutritionDetail()` |
| Protein | `total_protein_g` g | `/ planned g` if set, else "today" | `showNutritionDetail()` |
| Hydration | `hydration_liters` L | `/ planned L` if set, else "today" | **none** — card is not tappable |

The hydration card being non-tappable while the other two are is the only inconsistency in this section. See Section 6.

### 2.9 — Body (`renderTrainingBodySection`, `app.js:7792-7830`)

`body` shape can be `{ body_metrics: [...] }` OR a flat array — handled at line 7794.

**Empty state** (`app.js:7796-7800`, when no rows exist):
```
[Section label] Body
[ab-list-row] onclick="showBodyTrendsDetail()"
  Title: "No weigh-in logged."
  Meta:  "Tap to log →"
```

**Loaded state** (`app.js:7821-7828`):
1. **List row** with `onclick="showBodyTrendsDetail()"`:
   - Title: weight + unit, with dim `(May 12)` suffix if data is older than today (`stale` at line 7812)
   - Meta: "Latest weigh-in. Tap for trends." (or "Logged today. Tap for trends.")
2. **3-up glance row:** BF% / Muscle / BMR. All cards `onclick="showBodyTrendsDetail()"`. Missing values shown as `—` rather than collapsing the card (intentional, per the comment at lines 7813-7815).

---

## Section 3 — Deep links and detail surfaces reachable from Training

Every tap target in Sections 2.1-2.9 routes to a detail handler. Each handler `openModal(title, html, { variant: 'sheet' })` — full-screen sheets dismissed by close button or backdrop tap.

### 3.1 — `showRaceDetail(id)` (`app.js:11527`)

| Triggered by | `renderTrainingBigPicture` race variant (line 7374); also `showTrainingPlanDetail` from the dead path |
|---|---|
| Fetch | `/races/{id}` + lazy `/race-blocks?race_id={id}` + lazy `/race-fueling?race_id={id}` |
| Renders | Hero (race name, days to race), detail list (date / distance / terrain / target / priority / location), course notes, gear, fueling, notes, training blocks, race fueling detail |
| Editable | Edit button is inferred — not directly visible in the prior reading |
| Nested taps | Lazy-loaded sections render inline (not new sheets) |

### 3.2 — `showDailyPlanDetail(id)` (`app.js:13776`)

| Triggered by | Today/Session hero (line 7546) |
|---|---|
| Fetch | `/daily-plans/{id}` + parallel `/training/day/{date}` for actual workouts |
| Renders | Hero (date, status badge, title), quick-facts (Type / Duration / Effort), targets list (nutrition + recovery), actual-workouts list (tappable rows), planned-workout narrative, rationale, coaching notes, Edit + Delete buttons |
| Editable | Edit → `showCreateDailyPlanForm(id)` at line 13908; Delete with confirmation |
| Nested taps | Each actual-workout row → `showWorkoutDetail(workout.id)` |

### 3.3 — `showWorkoutDetail(id)` (`app.js:9407`)

| Triggered by | Inside `showDailyPlanDetail` actual-workouts list. Also reachable from other tabs (history, etc). **NOT directly reachable from the Training tab's 9-section pipeline.** |
|---|---|
| Renders | Type badge, date/effort, location, focus, workout sections (warmup/main/carries), metrics (TSS, duration, distance, elevation, pace, cadence, HR, calories, splits), HR zone bar + breakdown, performance notes, body feedback, exercises array (per-set weight/reps/RPE), tags, Hevy sync status + push button, Edit + Delete |
| Editable | Edit → workout form (inferred); Delete with confirmation |

### 3.4 — `showGoalDetail(id)`

| Triggered by | Each `.ab-goal-row` (line 7604) |
|---|---|
| Renders | (Not fully read; needs separate audit) |

### 3.5 — `showRecoveryDetail()` (`app.js:11734`)

| Triggered by | List row + all three glance cards in section 2.6 |
|---|---|
| Fetch | `/recovery/score?date=${localDateStr()}` — **note: uses `localDateStr()` (today), NOT the Training tab's `viewDate`**. See Section 4. |
| Renders | Hero (large score), 6 component bars (sleep, training_load, muscle_freshness, injury, nutrition, subjective). Each component shows score/100, weight multiplier, color-coded bar (≥70 green, ≥40 amber, <40 red) |
| Editable | None — read-only |

### 3.6 — `showTrainingLoadSheet()` (`app.js:7682`)

| Triggered by | List row + all three glance cards in section 2.7 |
|---|---|
| Fetch | `/health/insights/training?days=42` |
| Renders | Header row (Form / Fitness / Fatigue stats), "This week" line (workouts, TSS, hours, miles, Z2), Daily TSS Chart.js bar+line (TSS bars + CTL line + ATL dashed line), Z2 minutes Chart.js bar (12 weeks). Charts deferred via `setTimeout(..., 60)` (line 7721) so the sheet animates first |
| Editable | None — read-only |
| **Known issue** | Charts fail silently if Chart.js global isn't loaded; no fallback text. See Section 6. |

### 3.7 — `showNutritionDetail()` (`app.js:11792`)

| Triggered by | Calories + Protein glance cards in section 2.8 (NOT Hydration) |
|---|---|
| Fetch | `/nutrition/daily-summary?date=${viewDate}` (uses sticky `_abNutritionDate`, defaults to today) |
| Renders | Date navigation (prev/next), 3-up glance (Calories / Protein / on-pace), macros bars (Protein / Carbs / Fat with targets), meals list, "Log meal" button |
| Editable | "Log meal" routes to a meal form (handler not verified in this audit) |

### 3.8 — `showBodyTrendsDetail()` (`app.js:11395`)

| Triggered by | Empty state, list row, all three glance cards in section 2.9 |
|---|---|
| Fetch | `/body-metrics?limit=1000` — full client-side history, then filtered in JS by sticky `_abBodyRange` (30 / 90 / 180 / 365 / All days) |
| Renders | Time-range toggle (5 buttons), 4-5 big metric tiles (weight / BF% / muscle / water / BMR), 2-column composition cards, recent weigh-ins list, "Log new weigh-in" button (line 11508), 4 Chart.js line charts deferred via `requestAnimationFrame` (line 11515) |
| Editable | "Log new weigh-in" → `showBodyMetricForm()` |
| Nested taps | Body metric row in recent weigh-ins → `showBodyMetricDetail(id)` → `showBodyMetricForm(id)` |

### 3.9 — `showBodyMetricDetail(id)` and `showBodyMetricForm(id)` (`app.js:10737`, `10786`)

Reachable only through `showBodyTrendsDetail`. Detail sheet has 12-row metric table; form has date/time/source dropdowns + numeric inputs for all composition fields. Both are sheets; no nesting deeper than that.

### 3.10 — Detail surfaces in the dead path (NOT reachable from live Training)

`showTrainingPlanDetail(id)` at `app.js:13097`, `showTrainingPlanForm(existing)` at `13167`, `showCoachingDetail(id)`, `showInjuryDetail(id)`, plus their form variants — these handlers exist and may work if invoked, but the live 9-section pipeline never calls them. See Section 6.

---

## Section 4 — Cross-section data dependencies

### 4.1 — Recovery score

| Surface | Source | Date param |
|---|---|---|
| Section 2.6 list row + 3 glance cards | `recovery` from `loadFitness` Promise.all | `viewDate` (line 7261) |
| `showRecoveryDetail()` sheet | Fresh fetch of `/recovery/score` | **`localDateStr()` — always today, ignores `viewDate`** (line 11737) |

**Inconsistency:** If the user navigates to a past date in the Training tab and then taps a recovery card, the sheet shows **today's** recovery score, not the date they were viewing. The list row's score is from `viewDate`. These can disagree.

### 4.2 — Body weight

| Surface | Source | Limit |
|---|---|---|
| Section 2.9 list row + 3 glance cards | `body` from `loadFitness` Promise.all | `/body-metrics?limit=1` — most recent only |
| `showBodyTrendsDetail()` sheet | Fresh fetch | `/body-metrics?limit=1000` |

Both ultimately come from the same table; the trend sheet fetches the full history. Consistent on the latest row.

### 4.3 — Training Load (TSB / CTL / ATL)

| Surface | Source | Window |
|---|---|---|
| Section 2.7 list row + 3 glance cards | `trainingLoad` from `loadFitness` Promise.all | `/health/insights/training?days=42` |
| `showTrainingLoadSheet()` sheet | Fresh fetch | `/health/insights/training?days=42` |

Both fetch the same endpoint with the same param. Consistent.

### 4.4 — Today's plan

| Surface | Source |
|---|---|
| Section 2.4 Today/Session hero | `dayData.daily_plan` from `/training/day/{viewDate}` |
| `showDailyPlanDetail(id)` sheet | `/daily-plans/{id}` + `/training/day/{date}` |

The detail sheet re-fetches by ID — small risk of divergence if the plan is edited in another tab between renders, but otherwise consistent.

### 4.5 — Goals

| Surface | Source |
|---|---|
| Section 2.5 Goals list | `goals.goals_active[]` from `/goals/dashboard` |
| `showGoalDetail(id)` | (not audited) |

### 4.6 — Sleep

Sleep appears as a component inside Recovery (`recovery.components.sleep.detail`, section 2.6 glance card). It does **not** appear independently in the Training tab. The sleep tile in `showBodyTrendsDetail` (if any) wasn't surfaced in the prior reading. **Sleep is functionally a sub-field of Recovery here.**

---

## Section 5 — Page weight and density

### 5.1 — Live Training tab (the only reachable surface)

| Metric | Value |
|---|---|
| Distinct section blocks | **9** (Big Picture, Date Nav, Week Strip, Today/Session, Goals, Recovery, Training Load, Fuel, Body) |
| Distinct cards/rows | ~14-18 depending on data (Today=1 hero, Recovery=1 row + 3 glance, Load=1 row + 3 glance, Fuel=3 glance, Body=1 row + 3 glance, Goals=up to 5 rows, Week Strip=7 pills, Date Nav=3 controls) |
| Tappable elements | ~22-30 (date nav: 3, week pills: 7, big-picture card: 0-1, today hero: 1, goals: up to 5, recovery: 4, training load: 4, fuel: 2, body: 4) |
| Vertical scroll on iPhone (rough) | **3-4 screens** (cards are roomy; ab-section-label spacing adds ~24px per section) |
| Subjective density | **Balanced.** Each section is one row + optional 3-up glance. No deeply nested lists in the main scroll. Most density lives behind taps (`showTrainingLoadSheet`, `showBodyTrendsDetail`). |

### 5.2 — Dead path (NOT reachable from live tab)

The 4-sub-tab structure at `app.js:12356-13800` would render: a Race Countdown card, Training Load Strip with CTL/ATL/TSB + chart, Week Navigation Strip, Hero Plan Card, Weekly Plan List, Activity Heatmap (53×7 grid, ~371 cells, ~30+ tappable past-day cells). It is **not** what users see. If you measured page weight against a screenshot of the live tab, those don't appear.

---

## Section 6 — What's broken, weird, or vestigial

### 6.1 — **MAJOR: `loadTraining()` and the 4-sub-tab structure are dead code**

`app.js:12356-13800` defines `loadTraining()` and four sub-tab loaders: `loadTrainingDay`, `loadUnifiedPlans`, `loadCoachingSessions`, `loadInjuries`. None of them are called by the live tab navigation:

- `app.js:223` routes `tab === 'training'` to `loadFitness()`, not `loadTraining()`.
- `loadTraining()` is only invoked by the sub-tab pills' own `onclick` handlers — which only render after `loadTraining()` itself runs.
- Search the file for `loadTraining\b` — every hit is a self-reference inside the dead block.

What's stranded in this dead path:
- The 4-pill sub-tab strip (Day View / Plans / Coaching / Injuries)
- `trainingSubTab`, `plansWeekOffset`, `plansSelectedDate`, `trainingDayDate` — state variables read only by dead code
- `loadUnifiedPlans` with its rich Plans surface: race countdown, training load strip with charts, 7-day week strip, hero plan card, weekly plan list, 53-week activity heatmap (`app.js:12374-12644`, `12649-12699`, `12704-12800`)
- `loadCoachingSessions` (`13241-13266`) + `showCoachingDetail` + `showCoachingForm`
- `loadInjuries` (`13382-13412`) + `showInjuryDetail` + `showInjuryForm` + `markInjuryResolved`
- `showTrainingPlanDetail` (`13097`) + `showTrainingPlanForm` (`13167`)
- `editDailyPlan`, `updateDailyPlanStatus`, `showCreateDailyPlanForm` (still partially reachable from `showDailyPlanDetail` in the live path)
- `renderTrainingLoadStrip` (`12649`), `renderRaceCountdownCard` (`12805`), `drawTrainingLoadChart` (`12908`), `drawZ2WeeklyChart`, `renderActivityHeatmap`

Roughly **1,500 lines of unreachable rendering**. Some of the standalone detail handlers (e.g., `showCoachingDetail`, `showInjuryDetail`) might still be tapped from elsewhere — but the list views and forms that lead to them in this dead block are not.

### 6.2 — Hydration card is non-tappable while Calories and Protein are tappable (Fuel section)

`app.js:7788` — the Hydration card has no `onclick`. The other two glance cards in the same row do. Looks like an oversight. [SCREENSHOT NEEDED: Fuel section showing the three cards side-by-side, ideally highlighting the tap-target inconsistency.]

### 6.3 — Recovery detail uses `localDateStr()`, ignoring the Training tab's `viewDate`

`app.js:11737` — `showRecoveryDetail` always fetches `/recovery/score?date=${localDateStr()}`. If the user navigates to a past date in the Training tab and taps the Recovery card, the resulting sheet shows today's score, not the score for the date being viewed. The list row's number and the sheet's hero number can disagree by days.

### 6.4 — Chart.js failures are silent in `showTrainingLoadSheet`

`app.js:7723, 7746` — chart rendering checks `typeof Chart !== 'undefined'` before painting. If Chart.js failed to load (cache eviction, offline), the sheet shows the section labels (`Daily TSS · last 42 days`) and a blank `<canvas>` with no error. The user sees a partially-empty modal with no explanation.

### 6.5 — Empty state in Body section: bare "No weigh-in logged" with no source attribution

`app.js:7796-7800` — when no body metrics exist, the section is still rendered with a tap-to-log row. Not broken, but the "Tap to log →" leads to `showBodyTrendsDetail`, which itself shows the trends sheet (mostly empty) and the user has to find the "Log new weigh-in" button inside. One indirection more than necessary.

### 6.6 — `viewDate` propagation gaps

The `viewDate` selected via Date Nav (Section 2.2) is honored by:
- `dayData` fetch (line 7259)
- `recovery` fetch (line 7261)
- `fuel` fetch (line 7262)

But it is **NOT** propagated to:
- `goals.dashboard` (line 7260) — always returns "active goals," date-independent. Probably correct.
- `body` (line 7263) — `?limit=1` returns the latest weigh-in regardless of viewDate. The Body section's `stale` flag (`app.js:7812`) compares to `today`, not `viewDate`. **When viewing a past date, "Latest weigh-in" might still show today's reading rather than the most recent one on or before viewDate.** Likely a bug for past-date navigation.
- `weekWorkouts` (line 7269) — `?limit=30` is date-independent
- `trainingLoad` (line 7272) — `?days=42` is rolling window from now, not from viewDate

So navigating to last Tuesday gives you: Tuesday's plan, Tuesday's recovery, Tuesday's fuel — but today's body weight, today's training load, today's goals. Mixed picture. [SCREENSHOT NEEDED: Training tab with `viewDate` set to a past date, showing the inconsistency between the Today/Session hero and the Body/Load sections.]

### 6.7 — `renderTrainingDateNav` re-fetches the entire Training tab on every chevron tap

`setTrainingDate` (`app.js:7283-7286`) calls `loadFitness()` — which re-fires all 9 API calls. Stepping through a week's history burns 63 requests. Not broken, but inefficient.

### 6.8 — `fitnessSubTab` state variable: read by nothing in the live path

`app.js:7240` — `let fitnessSubTab = 'today';`. Referenced by `switchTab`'s alias map at line 197 (so old hash-routes survive), but the live `loadFitness` never reads it. Vestigial.

### 6.9 — Inline styles vs. CSS classes

Most sections use the `ab-*` class family defined in `public/style.css`. Some sections use **inline styles** for one-offs (date nav at line 7327-7330, goal row markers at line 7589-7591, body section status color at line 7825). Not broken, just inconsistent — themes/dark-mode tweaks may not catch the inline styles.

---

## Section 7 — Code-level structure

### 7.1 — Dispatcher

| File | Line | Symbol | Role |
|---|---|---|---|
| `public/app.js` | 191 | `switchTab(tab)` | Tab navigation; rewrites aliases; calls `loadFitness()` for training |
| `public/app.js` | 223 | dispatch case | `else if (tab === 'training') loadFitness();` |
| `public/app.js` | 7247 | `loadFitness()` | The Training tab's actual entry point |
| `public/app.js` | 7279 | `main.innerHTML = renderTraining({...})` | Single render assignment; no incremental updates |

### 7.2 — Render functions (live path)

| Section | Function | File:line |
|---|---|---|
| Skeleton | `renderTrainingSkeleton` | `public/app.js:7298` |
| Orchestrator | `renderTraining` | `public/app.js:7302` |
| 2.1 Big Picture | `renderTrainingBigPicture` | `public/app.js:7334` |
| 2.2 Date Nav | `renderTrainingDateNav` | `public/app.js:7316` |
| 2.3 Week Strip | `renderTrainingWeekStrip` | `public/app.js:7451` |
| 2.4 Today/Session | `renderTrainingTodaySession` | `public/app.js:7506` |
| 2.5 Goals | `renderTrainingGoalsSection` | `public/app.js:7559` |
| 2.6 Recovery | `renderTrainingRecoverySection` | `public/app.js:7624` |
| 2.7 Training Load | `renderTrainingLoadSection` | `public/app.js:7651` |
| 2.8 Fuel | `renderTrainingFuelSection` | `public/app.js:7775` |
| 2.9 Body | `renderTrainingBodySection` | `public/app.js:7792` |

### 7.3 — Detail handlers (reachable from live path)

| Handler | File:line | Trigger section |
|---|---|---|
| `showRaceDetail(id)` | `public/app.js:11527` | 2.1 |
| `setTrainingDate(d)` | `public/app.js:7283` | 2.2, 2.3 |
| `showDailyPlanDetail(id)` | `public/app.js:13776` | 2.4 |
| `showGoalDetail(id)` | (not audited) | 2.5 |
| `showRecoveryDetail()` | `public/app.js:11734` | 2.6 |
| `showTrainingLoadSheet()` | `public/app.js:7682` | 2.7 |
| `showNutritionDetail()` | `public/app.js:11792` | 2.8 |
| `showBodyTrendsDetail()` | `public/app.js:11395` | 2.9 |
| `showBodyMetricDetail(id)` | `public/app.js:10737` | 2.9 → trends |
| `showBodyMetricForm(id)` | `public/app.js:10786` | 2.9 → trends |
| `showWorkoutDetail(id)` | `public/app.js:9407` | 2.4 → plan detail |

### 7.4 — Dead handlers (defined but not reachable from live Training)

| Handler | File:line |
|---|---|
| `loadTraining()` | `public/app.js:12356` |
| `loadTrainingDay()` | `public/app.js:13551` |
| `loadUnifiedPlans()` | `public/app.js:12374` |
| `loadCoachingSessions()` | `public/app.js:13241` |
| `loadInjuries()` | `public/app.js:13382` |
| `showTrainingPlanDetail(id)` | `public/app.js:13097` |
| `showTrainingPlanForm(existing)` | `public/app.js:13167` |
| `showCoachingDetail(id)` | `public/app.js:13268` |
| `showCoachingForm(existing)` | `public/app.js:13320` |
| `showInjuryDetail(id)` | `public/app.js:13414` |
| `showInjuryForm(existing)` | `public/app.js:13459` |
| `markInjuryResolved(id)` | (not located precisely) |
| `renderTrainingLoadStrip` | `public/app.js:12649` |
| `renderRaceCountdownCard` | `public/app.js:12805` |
| `drawTrainingLoadChart` | `public/app.js:12908` |
| `renderActivityHeatmap` | (inside `loadUnifiedPlans`) |

### 7.5 — API endpoints called from live Training

All hit via `Promise.all` in `loadFitness` (`app.js:7258-7273`), parallelized:

```
GET /training/day/{viewDate}
GET /goals/dashboard
GET /recovery/score?date={viewDate}
GET /nutrition/daily-summary?date={viewDate}
GET /body-metrics?limit=1
GET /daily-plans?week_start={mondayOfWeek(viewDate)}
GET /races/upcoming
GET /workouts?limit=30
GET /health/insights/training?days=42
```

Detail sheets fire additional fetches lazily on open:
- `showRaceDetail`: `/races/{id}` + lazy `/race-blocks` + lazy `/race-fueling`
- `showDailyPlanDetail`: `/daily-plans/{id}` + `/training/day/{date}`
- `showRecoveryDetail`: `/recovery/score?date=` (note: uses `today`, not `viewDate` — see 6.3)
- `showTrainingLoadSheet`: `/health/insights/training?days=42` (re-fetched, same as initial)
- `showNutritionDetail`: `/nutrition/daily-summary?date={viewDate}`
- `showBodyTrendsDetail`: `/body-metrics?limit=1000`
- `showWorkoutDetail`: `/workouts/{id}` (assumed)

### 7.6 — CSS class inventory (training surfaces)

**Training-specific (Section 7 surfaces):**
- `ab-big-picture`, `ab-big-picture-eyebrow`, `ab-big-picture-title`, `ab-big-picture-meta`, `ab-big-picture-countdown`
- `ab-pillar-training`, `ab-pillar-label-training`
- `ab-week-strip`, `ab-week-day`, `ab-week-day-label`, `ab-week-day-mark`, `ab-today`
- `ab-state-completed`, `ab-state-partial`, `ab-state-missed`, `ab-state-rest`
- `ab-goal-row`, `ab-goal-row-head`, `ab-goal-row-title`, `ab-goal-row-meta`
- `ab-progress-bar`, `ab-progress-bar-fill`, `ab-progress-bar-marker`

**Shared with other tabs:**
- `ab-section-label`
- `ab-list-row`, `ab-list-row-dot`, `ab-list-row-body`, `ab-list-row-title`, `ab-list-row-meta`
- `ab-hero-card`, `ab-hero-card-head`, `ab-hero-card-kicker`, `ab-hero-card-title`, `ab-hero-card-body`
- `ab-glance-row`, `ab-glance-card`, `ab-glance-card-label`, `ab-glance-card-value`, `ab-glance-card-sub`
- `ab-status-badge` (uses `data-state` attribute for variants)
- `ab-badge`, `ab-badge-hot`, `ab-badge-waiting`

**Inline styles for one-offs:**
- Date nav buttons (`app.js:7328-7330`)
- Goal row markers (`app.js:7589-7591`)
- Body section stale-date suffix (`app.js:7825`)

All `.ab-*` classes are presumed to live in `public/style.css` (not audited for this doc).

---

## Where this leaves us

The Training tab as a user actually experiences it is the 9-section pipeline. It is **leaner and more cohesive** than the dead 4-sub-tab structure suggests. Most weirdness in code is the *coexistence of two implementations*, not problems within the live one.

Highest-priority items to confirm or screenshot before next iteration:
- [SCREENSHOT NEEDED: live Training tab on a recent strength day so we can confirm Section 2.4 hero state ("How it went" debrief)]
- [SCREENSHOT NEEDED: live Training tab with `viewDate` set to a past date — verify Section 6.6 (mixed viewDate propagation: plan vs body/load)]
- [SCREENSHOT NEEDED: Training Load sheet (`showTrainingLoadSheet`) with charts rendered — confirm Chart.js is loading]
- [SCREENSHOT NEEDED: Fuel section showing three glance cards — confirm Hydration is visually distinct from the two tappable cards or just identical-looking and silently non-interactive (Section 6.2)]
- Decide whether the dead `loadTraining()` block should be deleted, gated behind a feature flag, or revived (some surfaces in the dead path — activity heatmap, race countdown card, weekly plan list — are richer than anything in the live tab, and might be worth a future "Plans" companion view)
