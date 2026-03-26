const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════
// MUSCLE GROUP MODEL
// ═══════════════════════════════════════════════════════════════

const MUSCLE_MAP = {
  strength:  ['upper_push','upper_pull','core'],
  hill:      ['legs','cardio','core'],
  run:       ['legs','cardio'],
  hybrid:    ['full_body'],
  ruck:      ['legs','core','cardio'],
  hiit:      ['full_body','cardio'],
  crossfit:  ['full_body','cardio'],
  boxing:    ['upper_push','upper_pull','cardio','core'],
  cycling:   ['legs','cardio'],
  swim:      ['full_body','cardio'],
  rowing:    ['upper_pull','legs','cardio','core'],
  yoga:      ['core'],
  recovery:  [],
  walk:      [],
  machine:   ['legs'],
  class:     ['full_body'],
  hike:      ['legs','cardio'],
  race:      ['full_body','cardio'],
};

const RECOVERY_HOURS = {
  upper_push: 48, upper_pull: 48, core: 24, legs: 48, cardio: 24, full_body: 72,
};

const REGION_LABELS = {
  upper_push: 'Upper Push', upper_pull: 'Upper Pull', core: 'Core',
  legs: 'Legs', cardio: 'Cardio', full_body: 'Full Body',
};

const ALL_REGIONS = Object.keys(RECOVERY_HOURS);

// Map muscle names from exercise library → recovery regions
const MUSCLE_TO_REGION = {
  chest: 'upper_push', triceps: 'upper_push', shoulders: 'upper_push',
  back: 'upper_pull', biceps: 'upper_pull', traps: 'upper_pull', forearms: 'upper_pull',
  quadriceps: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs',
  core: 'core', abs: 'core',
  full_body: 'full_body',
  cardio: 'cardio',
};

function getRegionsForWorkout(w) {
  // New path: if workout has structured exercises with muscle data, use those
  const exercises = w.exercises;
  if (Array.isArray(exercises) && exercises.length > 0) {
    const regions = new Set();
    for (const ex of exercises) {
      if (ex.completed === false) continue; // skip exercises marked as skipped
      const primary = (ex.muscle_primary || '').toLowerCase();
      if (MUSCLE_TO_REGION[primary]) regions.add(MUSCLE_TO_REGION[primary]);
      const secondaries = Array.isArray(ex.muscle_secondary) ? ex.muscle_secondary : [];
      for (const s of secondaries) {
        const r = MUSCLE_TO_REGION[(s || '').toLowerCase()];
        if (r) regions.add(r);
      }
    }
    if (regions.size > 0) return [...regions];
    // Fall through if no muscle data on exercises
  }

  // Legacy path: use focus keywords or workout_type mapping
  const focus = (w.focus || '').toLowerCase();
  if (focus.includes('upper') && focus.includes('push')) return ['upper_push'];
  if (focus.includes('upper') && focus.includes('pull')) return ['upper_pull'];
  if (focus.includes('upper')) return ['upper_push', 'upper_pull'];
  if (focus.includes('lower') || focus.includes('leg')) return ['legs'];
  if (focus.includes('chest') || focus.includes('shoulder') || focus.includes('press')) return ['upper_push'];
  if (focus.includes('back') || focus.includes('pull') || focus.includes('row')) return ['upper_pull'];
  if (focus.includes('core') || focus.includes('abs')) return ['core'];
  if (focus.includes('full') || focus.includes('total')) return ['full_body'];

  const type = (w.workout_type || '').toLowerCase().trim();
  return MUSCLE_MAP[type] || ['full_body'];
}

// ═══════════════════════════════════════════════════════════════
// RECOVERY SCORE COMPUTATION
// ═══════════════════════════════════════════════════════════════

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function dateStr(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }

function computeSleepScore(ctx) {
  if (!ctx || ctx.sleep_hours == null) return { score: 50, detail: 'No sleep logged' };
  const hrs = Number(ctx.sleep_hours);
  const qual = ctx.sleep_quality ? Number(ctx.sleep_quality) : 5;
  const hourScore = clamp((hrs / 8) * 50, 0, 50);
  const qualScore = clamp((qual / 10) * 50, 0, 50);
  const score = Math.round(hourScore + qualScore);
  return { score, detail: `${hrs}h, quality ${qual}/10` };
}

// TSB-based Training Load (TrainingPeaks model)
// Session load = effort × duration (session-RPE method, validated in sports science)
// CTL = 42-day exponentially weighted moving average of daily load ("fitness")
// ATL = 7-day exponentially weighted moving average of daily load ("fatigue")
// TSB = CTL - ATL ("form" / training stress balance)
function computeTrainingLoadScore(allWorkouts, targetDate) {
  // Build daily load map from all available workouts
  // Standard session-RPE method: load = effort × duration_minutes
  // Typical ranges: easy 50-150, moderate 200-350, hard 350-500
  const dailyLoad = {};
  for (const w of allWorkouts) {
    const d = dateStr(w.workout_date);
    const effort = Number(w.effort) || 5;
    const wType = (w.workout_type || '').toLowerCase();

    // Skip recovery-type sessions at low effort — these aren't training stress
    const isRecovery = ['walk', 'recovery', 'stretch', 'yoga', 'rest'].includes(wType);
    if (isRecovery && effort <= 4) continue;

    // Cap duration at 180 min (3 hrs) — catches bad parses and unrealistic values
    let duration = Number(w.duration_minutes) || 45;
    if (duration > 300) duration = Math.min(Math.round(duration / 60), 180);
    if (duration > 180) duration = 180;
    if (duration < 1) duration = 45;

    // Session-RPE load: effort × duration (standard sports science method)
    // E5 × 45min = 225 (moderate), E7 × 60min = 420 (hard), E9 × 50min = 450 (very hard)
    const load = effort * duration;
    dailyLoad[d] = (dailyLoad[d] || 0) + load;
  }

  // Calculate EWMA for CTL (42-day) and ATL (7-day) up to targetDate
  // Standard exponential decay: decay = exp(-1/N)
  // ATL: exp(-1/7) ≈ 0.867 — 7-day time constant
  // CTL: exp(-1/42) ≈ 0.976 — 42-day time constant
  const ctlDecay = Math.exp(-1 / 42); // ~0.976
  const atlDecay = Math.exp(-1 / 7);  // ~0.867

  let ctl = 0;
  let atl = 0;
  const startDate = new Date(targetDate + 'T12:00:00');
  startDate.setDate(startDate.getDate() - 56); // seed from 56 days back for EWMA stability

  for (let d = new Date(startDate); d <= new Date(targetDate + 'T12:00:00'); d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    const load = dailyLoad[ds] || 0;
    ctl = ctl * ctlDecay + load * (1 - ctlDecay);
    atl = atl * atlDecay + load * (1 - atlDecay);
  }

  const tsb = Math.round(ctl - atl);

  // Convert TSB to a 0-100 training load score
  // Negative TSB = more recent fatigue than long-term fitness (normal during training)
  // The "optimal" zone is slightly negative — it means you're training productively
  // Only extreme negatives indicate real danger
  //
  // TSB > +10     → 60 (detraining — not enough stimulus)
  // +10 to -10    → 90 (fresh — ready for quality sessions)
  // -10 to -30    → 100 (optimal — productive training zone)
  // -30 to -60    → 75 (productive — meaningful training block)
  // -60 to -100   → 50 (accumulated fatigue — monitor closely)
  // -100 to -150  → 30 (overreaching — need planned recovery)
  // < -150        → 15 (danger — excessive overload)
  let score;
  if (tsb > 10) score = 60;                                                    // detraining
  else if (tsb >= -10) score = 90;                                             // fresh
  else if (tsb >= -30) score = 100;                                            // optimal
  else if (tsb >= -60) score = 75 + Math.round(((tsb + 60) / 30) * 25);       // 75-100 (productive→optimal)
  else if (tsb >= -100) score = 50 + Math.round(((tsb + 100) / 40) * 25);     // 50-75 (accumulated→productive)
  else if (tsb >= -150) score = 30 + Math.round(((tsb + 150) / 50) * 20);     // 30-50 (overreaching)
  else score = 15;                                                             // danger

  score = clamp(score);

  // Descriptive label
  let tsbLabel;
  if (tsb > 10) tsbLabel = 'detraining';
  else if (tsb >= -10) tsbLabel = 'fresh';
  else if (tsb >= -30) tsbLabel = 'optimal';
  else if (tsb >= -60) tsbLabel = 'productive';
  else if (tsb >= -100) tsbLabel = 'accumulated fatigue';
  else if (tsb >= -150) tsbLabel = 'overreaching';
  else tsbLabel = 'danger';

  return {
    score,
    detail: `TSB ${tsb > 0 ? '+' : ''}${tsb} (${tsbLabel}) · CTL ${Math.round(ctl)} / ATL ${Math.round(atl)}`,
    tsb, ctl: Math.round(ctl), atl: Math.round(atl),
  };
}

// Effort-aware muscle freshness
// Scale recovery hours by workout effort: effort 1 → 0.78x, effort 5 → 1.1x, effort 10 → 1.5x
// Null effort = multiplier 1.0 (backward compatible)
function effortRecoveryMultiplier(effort) {
  if (effort == null || isNaN(effort)) return 1.0;
  const e = clamp(effort, 1, 10);
  return 0.7 + (e / 10) * 0.8;
}

function computeMuscleFreshness(workoutsRecent, targetDate) {
  const now = new Date(targetDate + 'T23:59:59');
  const regionLastHit = {}; // { region: { date, effort } }

  for (const w of workoutsRecent) {
    const regions = getRegionsForWorkout(w);
    const wDate = new Date(dateStr(w.workout_date) + 'T' + (w.start_time || '12:00:00'));
    const effort = w.effort != null ? Number(w.effort) : null;
    for (const r of regions) {
      if (!regionLastHit[r] || wDate > regionLastHit[r].date) {
        regionLastHit[r] = { date: wDate, effort };
      }
    }
  }

  const muscleStatus = {};
  let totalPct = 0;
  let counted = 0;

  for (const r of ALL_REGIONS) {
    const hit = regionLastHit[r];
    if (!hit) {
      muscleStatus[r] = { status: 'fresh', hours_since: null, recovery_pct: 100, label: REGION_LABELS[r] };
      totalPct += 100;
    } else {
      const baseHours = RECOVERY_HOURS[r];
      const recoveryNeeded = baseHours * effortRecoveryMultiplier(hit.effort);
      const hoursSince = (now - hit.date) / (1000 * 60 * 60);
      const pct = clamp(Math.round((hoursSince / recoveryNeeded) * 100));
      const status = pct >= 90 ? 'fresh' : pct >= 50 ? 'recovering' : 'fatigued';
      muscleStatus[r] = {
        status, hours_since: Math.round(hoursSince), recovery_pct: pct, label: REGION_LABELS[r],
        effort: hit.effort, recovery_hours_needed: Math.round(recoveryNeeded),
      };
      totalPct += pct;
    }
    counted++;
  }

  const avgPct = counted > 0 ? Math.round(totalPct / counted) : 100;
  const fatigued = Object.entries(muscleStatus).filter(([, v]) => v.status === 'fatigued').map(([, v]) => v.label);
  const recovering = Object.entries(muscleStatus).filter(([, v]) => v.status === 'recovering').map(([, v]) => v.label);
  let detail;
  if (fatigued.length) detail = `${fatigued.join(', ')} fatigued`;
  else if (recovering.length) detail = `${recovering.join(', ')} still recovering`;
  else detail = 'All regions fresh';

  return { score: avgPct, detail, muscleStatus };
}

function computeInjuryScore(injuries) {
  if (!injuries.length) return { score: 100, detail: 'No active injuries' };
  let reduction = 0;
  for (const inj of injuries) {
    const sev = Number(inj.severity || 3);
    reduction += inj.status === 'active' ? sev * 2 : sev * 1;
  }
  reduction = Math.min(reduction, 50);
  const score = 100 - reduction;
  return { score, detail: `${injuries.length} active (total severity impact: ${reduction})` };
}

// Blended nutrition: yesterday fueled overnight recovery, today fuels today's readiness
function nutritionDayScore(summary) {
  if (!summary || !summary.total_calories) return null;
  const cal = summary.total_calories;
  const protein = summary.total_protein_g || 0;
  let s = 50;
  if (cal >= 2000 && cal <= 3000) s += 25;
  else if (cal >= 1500) s += 10;
  if (protein >= 130) s += 25;
  else if (protein >= 100) s += 15;
  return clamp(s);
}

function computeNutritionScore(yesterdaySummary, todaySummary) {
  const yScore = nutritionDayScore(yesterdaySummary);
  const tScore = nutritionDayScore(todaySummary);

  if (yScore == null && tScore == null) return { score: 50, detail: 'No nutrition data' };

  let score, detail;

  if (tScore != null && yScore != null) {
    // Blend: yesterday 70%, today 30%
    score = Math.round(yScore * 0.7 + tScore * 0.3);
    const yCal = Math.round(yesterdaySummary.total_calories);
    const tCal = Math.round(todaySummary.total_calories);
    detail = `Yesterday ${yCal} cal · Today ${tCal} cal`;
  } else if (yScore != null) {
    // No meals today — use yesterday but cap at 85
    score = Math.min(yScore, 85);
    detail = `Yesterday ${Math.round(yesterdaySummary.total_calories)} cal · no meals today`;
  } else {
    // Only today logged (rare — maybe looking at historical date)
    score = tScore;
    detail = `Today ${Math.round(todaySummary.total_calories)} cal`;
  }

  return { score, detail };
}

function computeSubjectiveScore(ctx) {
  // Simplified: use sleep quality as subjective indicator (energy/recovery ratings removed)
  if (!ctx) return { score: 50, detail: 'No context logged' };
  const sleepQ = ctx.sleep_quality ? Number(ctx.sleep_quality) : null;
  if (sleepQ == null) return { score: 50, detail: 'No sleep quality logged' };
  const score = Math.round(sleepQ * 10);
  return { score, detail: `Sleep quality ${sleepQ}/10` };
}

function generateRecommendation(muscleStatus, injuries) {
  const fatigued = Object.entries(muscleStatus)
    .filter(([, v]) => v.status === 'fatigued')
    .map(([, v]) => v.label);
  const fresh = Object.entries(muscleStatus)
    .filter(([, v]) => v.status === 'fresh')
    .map(([, v]) => v.label);

  if (fatigued.length === 0 && injuries.length === 0) return 'All systems go — train any muscle group today';
  if (fatigued.length === ALL_REGIONS.length) return 'Full body fatigued — rest day or light recovery work recommended';

  const parts = [];
  if (fatigued.length) parts.push(`${fatigued.join(', ')} fatigued`);
  if (fresh.length) parts.push(`${fresh.join(', ')} fresh`);
  if (injuries.length) {
    const areas = injuries.map(i => i.body_area).filter(Boolean);
    if (areas.length) parts.push(`avoid aggravating ${areas.join(', ')}`);
  }
  return parts.join(' — ');
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════

router.get('/score', async (req, res) => {
  try {
    const date = req.query.date || req.getToday();
    const today = req.getToday();

    // Don't compute recovery for future dates
    if (date > today) {
      return res.json({ date, score: null, label: 'N/A', components: {}, muscle_status: {}, recommendation: 'No data — this date hasn\'t happened yet.' });
    }

    const [ctxResult, allWorkoutsResult, injuriesResult, yesterdayResult, todayMealsResult] = await Promise.all([
      query('SELECT * FROM daily_context WHERE date = $1', [date]),
      // 56 days back for TSB EWMA stability (42-day CTL + 14-day seed)
      query('SELECT * FROM workouts WHERE workout_date >= $1::date - INTERVAL \'56 days\' AND workout_date <= $1 ORDER BY workout_date DESC, created_at DESC', [date]),
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') AND (onset_date IS NULL OR onset_date <= $1) AND (resolved_date IS NULL OR resolved_date >= $1) ORDER BY severity DESC NULLS LAST`, [date]),
      query(`SELECT SUM(calories) as total_calories, SUM(protein_g) as total_protein_g FROM meals WHERE meal_date = ($1::date - 1)`, [date]),
      query(`SELECT SUM(calories) as total_calories, SUM(protein_g) as total_protein_g FROM meals WHERE meal_date = $1`, [date]),
    ]);

    const ctx = ctxResult.rows[0] || null;
    const allWorkouts = allWorkoutsResult.rows;
    // Filter to 7 days for muscle freshness
    const workouts7d = allWorkouts.filter(w => {
      const wd = new Date(dateStr(w.workout_date) + 'T12:00:00');
      const sevenAgo = new Date(date + 'T12:00:00'); sevenAgo.setDate(sevenAgo.getDate() - 7);
      return wd >= sevenAgo;
    });
    const injuries = injuriesResult.rows;
    const yesterdayMeals = yesterdayResult.rows[0] || null;
    const todayMeals = todayMealsResult.rows[0] || null;

    const sleep = computeSleepScore(ctx);
    const trainingLoad = computeTrainingLoadScore(allWorkouts, date);
    const { score: muscleFreshnessScore, detail: muscleDetail, muscleStatus } = computeMuscleFreshness(workouts7d, date);
    const injury = computeInjuryScore(injuries);
    const nutrition = computeNutritionScore(yesterdayMeals, todayMeals);
    const subjective = computeSubjectiveScore(ctx);

    const totalScore = Math.round(
      sleep.score * 0.30 +
      trainingLoad.score * 0.25 +
      muscleFreshnessScore * 0.20 +
      injury.score * 0.10 +
      nutrition.score * 0.10 +
      subjective.score * 0.05
    );

    const label = totalScore >= 81 ? 'Peak' : totalScore >= 61 ? 'Good' : totalScore >= 31 ? 'Moderate' : 'Low';
    const recommendation = generateRecommendation(muscleStatus, injuries);

    res.json({
      date,
      score: totalScore,
      label,
      components: {
        sleep: { score: sleep.score, weight: 30, detail: sleep.detail },
        training_load: { score: trainingLoad.score, weight: 25, detail: trainingLoad.detail, tsb: trainingLoad.tsb, ctl: trainingLoad.ctl, atl: trainingLoad.atl },
        muscle_freshness: { score: muscleFreshnessScore, weight: 20, detail: muscleDetail },
        injury: { score: injury.score, weight: 10, detail: injury.detail },
        nutrition: { score: nutrition.score, weight: 10, detail: nutrition.detail },
        subjective: { score: subjective.score, weight: 5, detail: subjective.detail },
      },
      muscle_status: muscleStatus,
      recommendation,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trend', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 7, 30);
    const today = req.getToday();
    const requestedEnd = req.query.date || today;
    // Cap end date at today — no future dates in trend
    const endDate = requestedEnd > today ? today : requestedEnd;

    // Generate date range
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(endDate + 'T12:00:00');
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      if (ds <= today) dates.push(ds);
    }

    // Fetch all data in bulk — 56 days back for TSB EWMA stability
    const startDate = dates[0];
    const [ctxResult, workoutsResult, injuriesResult, mealsResult] = await Promise.all([
      query('SELECT * FROM daily_context WHERE date >= $1 AND date <= $2 ORDER BY date', [startDate, endDate]),
      query('SELECT * FROM workouts WHERE workout_date >= $1::date - INTERVAL \'56 days\' AND workout_date <= $2 ORDER BY workout_date DESC, created_at DESC', [startDate, endDate]),
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') ORDER BY severity DESC NULLS LAST`),
      query('SELECT meal_date, SUM(calories) as total_calories, SUM(protein_g) as total_protein_g FROM meals WHERE meal_date >= $1::date - 1 AND meal_date <= $2 GROUP BY meal_date', [startDate, endDate]),
    ]);

    const ctxByDate = {};
    ctxResult.rows.forEach(r => { ctxByDate[dateStr(r.date)] = r; });
    const mealsByDate = {};
    mealsResult.rows.forEach(r => { mealsByDate[dateStr(r.meal_date)] = r; });

    const trend = dates.map(date => {
      const ctx = ctxByDate[date] || null;
      // All workouts up to this date (for TSB)
      const allWorkoutsForDate = workoutsResult.rows.filter(w => {
        const wd = dateStr(w.workout_date);
        return wd <= date;
      });
      // 7-day window for muscle freshness
      const workouts7d = allWorkoutsForDate.filter(w => {
        const wd = new Date(dateStr(w.workout_date) + 'T12:00:00');
        const sevenAgo = new Date(date + 'T12:00:00'); sevenAgo.setDate(sevenAgo.getDate() - 7);
        return wd >= sevenAgo;
      });

      const prevDate = new Date(date + 'T12:00:00');
      prevDate.setDate(prevDate.getDate() - 1);
      const prevDateStr = prevDate.toISOString().slice(0, 10);
      const yesterdayMeals = mealsByDate[prevDateStr] || null;
      const todayMeals = mealsByDate[date] || null;

      const sleep = computeSleepScore(ctx);
      const trainingLoad = computeTrainingLoadScore(allWorkoutsForDate, date);
      const { score: muscleScore } = computeMuscleFreshness(workouts7d, date);
      const injuryScore = computeInjuryScore(injuriesResult.rows);
      const nutritionScore = computeNutritionScore(yesterdayMeals, todayMeals);
      const subjectiveScore = computeSubjectiveScore(ctx);

      const score = Math.round(
        sleep.score * 0.30 + trainingLoad.score * 0.25 + muscleScore * 0.20 +
        injuryScore.score * 0.10 + nutritionScore.score * 0.10 + subjectiveScore.score * 0.05
      );

      return { date, score, tsb: trainingLoad.tsb };
    });

    res.json({ days, trend });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
