# SPARTAN COACH — KNOWLEDGE FILE

Reference data for the coaching system. All endpoints verified against codebase as of March 2026.

---

## AB BRAIN API REFERENCE

Base URL: `https://ab-brain.up.railway.app/api`
All paths below include the `/api/` prefix.

### Workouts

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/workouts?workout_type=X&since=DATE&before=DATE&tag=X&limit=N&offset=N&sort=X` | List/search. Sort: `newest`, `oldest`, `effort_desc` |
| GET | `/api/workouts/{id}` | Single workout |
| GET | `/api/workouts/stats/summary` | Aggregate stats |
| POST | `/api/workouts` | Create. Required: `workout_type` |
| PUT | `/api/workouts/{id}` | Update |
| DELETE | `/api/workouts/{id}` | Delete |

**Workout fields:** `title`, `workout_date`, `workout_type` (hill/strength/run/hybrid/recovery/ruck), `location`, `focus`, `warmup`, `main_sets`, `carries`, `exercises` (JSONB), `daily_plan_id` (UUID FK), `time_duration` (text) or `duration_minutes` (int), `distance` (text) or `distance_value` (numeric), `elevation_gain` (text) or `elevation_gain_ft` (int), `heart_rate_avg`/`hr_avg`, `heart_rate_max`/`hr_max`, `pace_avg`, `splits`, `cadence_avg`/`cadence`, `active_calories`/`cal_active`, `total_calories`/`cal_total`, `effort` (1–10 int), `body_notes`, `slowdown_notes`, `failure_first`, `grip_feedback`, `legs_feedback`, `cardio_feedback`, `shoulder_feedback`, `completion_status` (default: 'logged'), `plan_comparison_notes`, `adjustment`, `tags` (JSONB), `ai_source`, `source`, `metadata` (JSONB)

**Effort scale:**

| Rating | Meaning |
|--------|---------|
| 1–2 | Walking the dog. Mobility only. |
| 3–4 | Easy movement. Full conversation. |
| 5–6 | Moderate. Short sentences. |
| 7 | Hard. Uncomfortable. Limited talking. |
| 8 | Very hard. Few words between breaths. |
| 9 | Near max. Couldn't do much more. |
| 10 | All-out. Race effort or failure. |

**Structured exercises JSONB:**
```json
[{
  "name": "Barbell Bench Press",
  "sets": 4, "reps": 6, "weight": "180 lb",
  "muscle_primary": "chest",
  "muscle_secondary": ["triceps", "shoulders"],
  "completed": true, "notes": "PR"
}]
```

### Meals

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/meals?date=YYYY-MM-DD&meal_type=X&since=DATE&before=DATE&limit=N` | List/search |
| GET | `/api/meals/{id}` | Single meal |
| POST | `/api/meals` | Create. Required: `title`, `meal_date` |
| PATCH | `/api/meals/{id}` | Update (PATCH not PUT) |
| DELETE | `/api/meals/{id}` | Delete |

**Meal fields:** `meal_date`, `meal_time`, `meal_type` (breakfast/lunch/dinner/snack/pre-workout/post-workout/drink/supplement), `title`, `calories`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `sugar_g`, `sodium_mg`, `serving_size`, `hunger_before`, `fullness_after`, `energy_after`, `notes`, `tags` (JSONB), `ai_source`

### Body Metrics

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/body-metrics?latest=true` | Latest reading |
| GET | `/api/body-metrics?since=DATE&before=DATE&sort=X` | Range |
| GET | `/api/body-metrics/stats/summary` | Aggregate stats |
| POST | `/api/body-metrics` | Create |
| PATCH | `/api/body-metrics/{id}` | Update (PATCH not PUT) |
| DELETE | `/api/body-metrics/{id}` | Delete |

**Body metric fields:** `measurement_date`, `measurement_time`, `source`, `weight_lb`, `bmi`, `body_fat_pct`, `skeletal_muscle_pct`, `fat_free_mass_lb`, `subcutaneous_fat_pct`, `visceral_fat`, `body_water_pct`, `muscle_mass_lb`, `bone_mass_lb`, `protein_pct`, `bmr_kcal`, `metabolic_age`, `measurement_context`, `notes`, `tags`, `is_manual_entry`

### Nutrition

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/nutrition/daily-summary?date=YYYY-MM-DD` | Single day summary |
| GET | `/api/nutrition/daily-summary/range?since=DATE&before=DATE` | Multi-day range |
| GET | `/api/nutrition/daily-context?date=YYYY-MM-DD` | Daily context (or list with `since`/`before`) |
| GET | `/api/nutrition/daily-context/{id}` | Single context by ID |
| POST | `/api/nutrition/daily-context` | Create daily context |
| PATCH | `/api/nutrition/daily-context/{id}` | Update |
| DELETE | `/api/nutrition/daily-context/{id}` | Delete |

### Daily Plans (replaces training_plans)

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/daily-plans?date=YYYY-MM-DD&from=DATE&to=DATE&status=X&limit=N` | List/filter |
| GET | `/api/daily-plans/by-date/{date}` | Single day with actuals + comparison + rings |
| GET | `/api/daily-plans/{id}` | By ID |
| GET | `/api/daily-plans/{id}/review` | Plan-vs-actual review (for coaching) |
| POST | `/api/daily-plans` | Create single plan |
| POST | `/api/daily-plans/week` | Create 7 daily plans at once |
| PUT | `/api/daily-plans/{id}` | Update/amend |
| DELETE | `/api/daily-plans/{id}` | Delete |

**Daily plan fields:** `plan_date`, `status`, `title`, `goal`, `workout_type`, `workout_focus`, `target_effort`, `target_duration_min`, `workout_notes`, `target_calories`, `target_protein_g`, `target_carbs_g`, `target_fat_g`, `target_hydration_liters`, `target_sleep_hours`, `recovery_notes`, `coaching_notes`, `rationale`, `planned_exercises` (JSONB), `actual_exercises` (JSONB), `completion_notes`, `tags` (JSONB), `ai_source`

**Planned exercises JSONB:**
```json
[{
  "name": "Barbell Bench Press",
  "sets": 4, "reps": 6, "weight": "175 lb",
  "group": "main",
  "muscle_primary": "chest",
  "muscle_secondary": ["triceps", "shoulders"],
  "superset_with": null, "notes": ""
}]
```
Valid groups: `warmup`, `main`, `superset`, `circuit`, `finisher`

### Training (Coaching + Injuries + Day View)

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/training/coaching?since=DATE&before=DATE` | List sessions |
| GET | `/api/training/coaching/{id}` | Single session |
| POST | `/api/training/coaching` | Create session |
| PUT | `/api/training/coaching/{id}` | Update session |
| DELETE | `/api/training/coaching/{id}` | Delete session |
| GET | `/api/training/injuries?status=STATUS&body_area=AREA` | List injuries |
| GET | `/api/training/injuries/{id}` | Single injury |
| GET | `/api/training/injuries/active/summary` | **Active injury summary** |
| POST | `/api/training/injuries` | Create injury |
| PUT | `/api/training/injuries/{id}` | Update injury |
| DELETE | `/api/training/injuries/{id}` | Delete injury |
| GET | `/api/training/day/YYYY-MM-DD` | Full day cross-reference |

**Coaching session fields:** `session_date`, `title`, `summary`, `key_decisions` (JSONB), `adjustments` (JSONB), `injury_notes`, `nutrition_notes`, `recovery_notes`, `mental_notes`, `next_steps`, `data_reviewed`, `conversation_id`, `ai_source`, `tags` (JSONB), `metadata` (JSONB)

**Injury fields:** `title`, `body_area`, `side`, `injury_type`, `severity` (1–10), `status` (active/resolved/monitoring), `onset_date`, `resolved_date`, `symptoms`, `treatment`, `notes`, `tags` (JSONB), `ai_source`

### Recovery

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/recovery/score?date=YYYY-MM-DD` | Recovery readiness score (0–100) |
| GET | `/api/recovery/trend?days=N&date=YYYY-MM-DD` | Trend over N days (max 30) |

**Score response:** `score` (0–100), `label` (Peak/Good/Moderate/Low), `components` (sleep 30%, training_load 25%, muscle_freshness 20%, injury 10%, nutrition 10%, subjective 5%), `muscle_status` (per-region recovery data), `recommendation`

### Exercises

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/exercises?q=KEYWORD&equipment=X&muscle_group=X&level=X&sort=mscore_desc&limit=N` | Search/filter |
| GET | `/api/exercises/available` | Exercises matching primary gym profile equipment |
| GET | `/api/exercises/equipment` | Equipment types with counts |
| GET | `/api/exercises/equipment-catalog` | Full equipment catalog |
| GET | `/api/exercises/categories` | Categories with counts |
| GET | `/api/exercises/stats` | Top mscore, counts by level/equipment |
| GET | `/api/exercises/{id}` | Single exercise |
| POST | `/api/exercises` | Create (name, equipment, primary_muscle_groups, category, level, muscle_strength_score) |
| POST | `/api/exercises/import-fitbod` | Import from Fitbod CSV |
| PUT | `/api/exercises/{id}` | Update |

### Gym Profiles

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/gym-profiles` | List all profiles |
| GET | `/api/gym-profiles/primary` | Primary profile with equipment |
| GET | `/api/gym-profiles/{id}` | Single profile |
| POST | `/api/gym-profiles` | Create (name, equipment[], is_primary) |
| PUT | `/api/gym-profiles/{id}` | Update |
| DELETE | `/api/gym-profiles/{id}` | Delete |

### Search (keywords only — never dates)

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/search?q=KEYWORD&limit=N` | Full-text across all tables |
| POST | `/api/search/ai` | AI search. Body: `{"query": "natural language", "limit": N}` |

### Knowledge (replaces facts)

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/knowledge?q=X&category=X&tag=X&limit=N` | List/search |
| GET | `/api/knowledge/meta/categories` | All distinct categories |
| GET | `/api/knowledge/{id}` | Single entry (full content) |
| POST | `/api/knowledge` | Create insight, fact, or coaching principle |
| PUT | `/api/knowledge/{id}` | Update |
| DELETE | `/api/knowledge/{id}` | Delete |

### Gamification

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/gamification` | Rings (Train/Execute/Recover), streaks, badges |
| PUT | `/api/gamification/settings` | Adjust ring goals |

### Briefing

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/briefing?date=YYYY-MM-DD` | Morning briefing (markdown) |

---

## VERNON NJ RACE PROFILE

### Course Demands
- Steep, technical trail with significant elevation changes
- Short punchy climbs requiring power hiking
- Technical descents requiring leg durability and confidence
- Obstacles under cardiovascular fatigue (grip must hold)
- Carries (bucket, sandbag, atlas) on hilly terrain
- Fast transitions between running and obstacles

### Performance Benchmarks

| Metric | Current (est.) | Target | Test Method |
|--------|---------------|--------|-------------|
| Hill mile pace (steep) | ~14 min | 11–12 min | Timed hill repeat on local steep route |
| Carry pace (50lb, 0.25mi) | untested | < 4:00 | Farmer carry time trial |
| Grip hold (dead hang) | untested | > 90 sec | Max dead hang |
| Grip under fatigue | untested | > 60 sec after effort 7+ | Dead hang after 400m run |
| 5K trail pace | untested | < 28:00 | Trail 5K or timed effort |
| Burpee rate (penalty) | untested | < 3:00/30 | Timed set |
| Transition speed | N/A | < 15 sec/obstacle | Practice in simulation |

**Weekly testing:** Every Sunday or Monday, test ONE benchmark. Rotate. Log as workout with tag `benchmark`. Track trend over 5 weeks.

---

## MESOCYCLE STRUCTURE (5 weeks to Vernon)

### Week 1 (Mar 23–29): REBUILD + TEST BASELINE
- Manage calf, establish benchmarks, fix nutrition baseline
- Key: 2 quality (1 hill, 1 hybrid carry), 1 benchmark test
- Intensity cap: effort 7 max. No aggressive hill running until calf <=2/10

### Week 2 (Mar 30–Apr 5): BUILD SPECIFICITY
- Race-specific sessions, increase hill volume, grip work
- Key: 2 quality (1 race sim, 1 hill + carry), 1 grip/strength
- Effort 8 allowed on 1 session. Add carry weight, hill steepness.

### Week 3 (Apr 6–12): PEAK SPECIFICITY
- Highest race-specific load of the block
- Key: 2 quality (1 full race sim, 1 hill intervals), 1 strength maintenance
- One session at effort 9. Nutrition must support this week.

### Week 4 (Apr 13–19): SHARPEN
- Maintain intensity, reduce volume 20–30%
- Key: 2 quality (shorter, faster, more transitions), 1 easy run
- Effort 8 max, sessions shorter. Race pace or faster for shorter durations.

### Week 5 (Apr 20–25): TAPER + RACE
- Mon: Light mobility + 15 min easy run
- Tue: Short hill pickups (4–6 x 30 sec), grip check
- Wed: Complete rest or 20 min walk
- Thu: 10 min easy jog + 5 strides + visualization
- Fri: Rest. Hydrate. Eat well.
- Sat Apr 25: Rest. Lay out gear. Early sleep.
- **Sun Apr 26: RACE DAY**

---

## INTENSITY DISTRIBUTION TARGETS (per week)

| Category | Sessions/week | Notes |
|----------|---------------|-------|
| Key quality (effort 7–9) | 2–3 | Hill, hybrid, race sim, carries |
| Moderate support (effort 5–6) | 1–2 | Strength maintenance, easy runs |
| Recovery (effort 1–4) | 1–2 | Walks, mobility, light cycling |
| Full rest | 1 | No training. No "active recovery" disguised as training. |
| Benchmark test | 1 (weekly) | Rotates through performance targets |

**Flags:**
- Fewer than 2 sessions at effort 7+ in a week: undercooked. Flag it.
- More than 3 sessions at effort 1–3: too much filler. Flag it.

---

## BODY METRICS TARGETS

### Current Baseline (Mar 21, 2026)
Weight: 190.0 lb | BF: 15.3% | Skeletal muscle: 54.7% | Visceral fat: 9 | BMR: 1933 kcal | Metabolic age: 50

### Race Day Targets
Weight: 185–188 lb | BF: 14.0–14.8% | Skeletal muscle: >=54.5% | Visceral fat: <=8

### Interpretation Rules
- Weight alone means nothing. Track BF% and muscle% together.
- Weight drops + muscle% drops = underfueling. Raise calories immediately.
- Weight holds + BF drops = recomposition. Good sign.
- Visceral fat rises = stress, sleep, or alcohol issue. Investigate.
- Metabolic age trending down = positive. Up = recovery or nutrition problem.
- Don't chase weight loss. Chase race performance.

---

## RACE DAY STRATEGY

### Pacing Plan
- First mile: controlled, 10:30–11:00. DO NOT go out fast.
- Hills: power hike >15% grade. Run everything else.
- Obstacles: steady, no rushing. Failed obstacle = 30 burpees = 3+ min penalty.
- Carries: grip and go. No putting down. Walk uphills, run flats.
- Last mile: whatever's left. This is where 60–70 vs 70–80 is decided.

### Pre-Race Nutrition
- Night before: High-carb dinner, 800–1000 cal, low fiber, hydrate
- Morning (2–3 hrs before): 400–600 cal, familiar food, carb-dominant
- 30 min before: Gel or simple sugar + water
- During: One gel at 30–35 min if available

### Gear Checklist
- Shoes: trail shoes with grip (NOT minimalist)
- Gloves: optional for carries, not for obstacles
- Clothing: compression shorts, moisture-wicking top, no cotton
- Hydration: whatever the course provides

---

## DROPPED SYSTEMS — DO NOT REFERENCE

| Dropped | Replacement |
|---------|-------------|
| `training_plans` table | Use `daily_plans` |
| `POST /api/facts` | Use `POST /api/knowledge` |
| `projects` table | None (removed) |
| `session_completed` field | Use `completion_status` on workouts |
| `trunk_feedback` field | Does not exist |
| `limiters_targeted` field | Does not exist |
| `daily_context` dropped fields | Check `/api/nutrition/daily-context` for current schema |
