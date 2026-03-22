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

function getRegionsForWorkout(w) {
  const focus = (w.focus || '').toLowerCase();
  // Override by focus keywords
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

function computeSleepScore(ctx) {
  if (!ctx || ctx.sleep_hours == null) return { score: 50, detail: 'No sleep logged' };
  const hrs = Number(ctx.sleep_hours);
  const qual = ctx.sleep_quality ? Number(ctx.sleep_quality) : 5;
  const hourScore = clamp((hrs / 8) * 50, 0, 50);
  const qualScore = clamp((qual / 10) * 50, 0, 50);
  const score = Math.round(hourScore + qualScore);
  return { score, detail: `${hrs}h, quality ${qual}/10` };
}

function computeTrainingLoadScore(workouts7d) {
  if (!workouts7d.length) return { score: 90, detail: 'No recent training' };
  // Acute load: avg effort last 3 days
  const now = new Date();
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const recent = workouts7d.filter(w => new Date(w.workout_date) >= threeDaysAgo);
  const acuteEfforts = recent.map(w => Number(w.effort || 5));
  const acuteLoad = acuteEfforts.length > 0 ? acuteEfforts.reduce((a, b) => a + b, 0) / acuteEfforts.length : 0;
  const score = clamp(Math.round(100 - (acuteLoad * 10)));
  return { score, detail: `Avg effort ${acuteLoad.toFixed(1)} last 3d (${recent.length} sessions)` };
}

function computeMuscleFreshness(workoutsRecent, targetDate) {
  const now = new Date(targetDate + 'T23:59:59');
  const regionLastHit = {};

  for (const w of workoutsRecent) {
    const regions = getRegionsForWorkout(w);
    const wDate = new Date(w.workout_date + 'T' + (w.start_time || '12:00:00'));
    for (const r of regions) {
      if (!regionLastHit[r] || wDate > regionLastHit[r]) {
        regionLastHit[r] = wDate;
      }
    }
  }

  const muscleStatus = {};
  let totalPct = 0;
  let counted = 0;

  for (const r of ALL_REGIONS) {
    const recoveryNeeded = RECOVERY_HOURS[r];
    if (!regionLastHit[r]) {
      muscleStatus[r] = { status: 'fresh', hours_since: null, recovery_pct: 100, label: REGION_LABELS[r] };
      totalPct += 100;
    } else {
      const hoursSince = (now - regionLastHit[r]) / (1000 * 60 * 60);
      const pct = clamp(Math.round((hoursSince / recoveryNeeded) * 100));
      const status = pct >= 90 ? 'fresh' : pct >= 50 ? 'recovering' : 'fatigued';
      muscleStatus[r] = { status, hours_since: Math.round(hoursSince), recovery_pct: pct, label: REGION_LABELS[r] };
      totalPct += pct;
    }
    counted++;
  }

  const avgPct = counted > 0 ? Math.round(totalPct / counted) : 100;
  const fatigued = Object.entries(muscleStatus).filter(([, v]) => v.status === 'fatigued').map(([, v]) => v.label);
  const detail = fatigued.length ? `${fatigued.join(', ')} fatigued` : 'All regions recovering well';

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

function computeNutritionScore(yesterdaySummary) {
  if (!yesterdaySummary || !yesterdaySummary.total_calories) return { score: 50, detail: 'No nutrition data' };
  // Simple: did they eat enough? Score based on calorie range 1800-3000
  const cal = yesterdaySummary.total_calories;
  const protein = yesterdaySummary.total_protein_g || 0;
  let score = 50;
  if (cal >= 2000 && cal <= 3000) score += 25;
  else if (cal >= 1500) score += 10;
  if (protein >= 130) score += 25;
  else if (protein >= 100) score += 15;
  return { score: clamp(score), detail: `${Math.round(cal)} cal, ${Math.round(protein)}g protein` };
}

function computeSubjectiveScore(ctx) {
  if (!ctx) return { score: 50, detail: 'No context logged' };
  const energy = ctx.energy_rating ? Number(ctx.energy_rating) : null;
  const recovery = ctx.recovery_rating ? Number(ctx.recovery_rating) : null;
  const values = [energy, recovery].filter(v => v != null);
  if (!values.length) return { score: 50, detail: 'No ratings' };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const score = Math.round(avg * 10);
  return { score, detail: `Energy ${energy || '—'}, Recovery ${recovery || '—'}` };
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
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const [ctxResult, workouts7dResult, injuriesResult, yesterdayResult] = await Promise.all([
      query('SELECT * FROM daily_context WHERE date = $1', [date]),
      query('SELECT * FROM workouts WHERE workout_date >= $1::date - INTERVAL \'7 days\' AND workout_date <= $1 ORDER BY workout_date DESC, created_at DESC', [date]),
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') AND (onset_date IS NULL OR onset_date <= $1) AND (resolved_date IS NULL OR resolved_date >= $1) ORDER BY severity DESC NULLS LAST`, [date]),
      query(`SELECT SUM(calories) as total_calories, SUM(protein_g) as total_protein_g FROM meals WHERE meal_date = ($1::date - 1)`, [date]),
    ]);

    const ctx = ctxResult.rows[0] || null;
    const workouts7d = workouts7dResult.rows;
    const injuries = injuriesResult.rows;
    const yesterday = yesterdayResult.rows[0] || null;

    const sleep = computeSleepScore(ctx);
    const trainingLoad = computeTrainingLoadScore(workouts7d);
    const { score: muscleFreshnessScore, detail: muscleDetail, muscleStatus } = computeMuscleFreshness(workouts7d, date);
    const injury = computeInjuryScore(injuries);
    const nutrition = computeNutritionScore(yesterday);
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
        training_load: { score: trainingLoad.score, weight: 25, detail: trainingLoad.detail },
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
    const endDate = req.query.date || new Date().toISOString().slice(0, 10);

    // Generate date range
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(endDate + 'T12:00:00');
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    // Fetch all data in bulk
    const startDate = dates[0];
    const [ctxResult, workoutsResult, injuriesResult, mealsResult] = await Promise.all([
      query('SELECT * FROM daily_context WHERE date >= $1 AND date <= $2 ORDER BY date', [startDate, endDate]),
      query('SELECT * FROM workouts WHERE workout_date >= $1::date - INTERVAL \'7 days\' AND workout_date <= $2 ORDER BY workout_date DESC, created_at DESC', [startDate, endDate]),
      query(`SELECT * FROM injuries WHERE status IN ('active','monitoring') ORDER BY severity DESC NULLS LAST`),
      query('SELECT meal_date, SUM(calories) as total_calories, SUM(protein_g) as total_protein_g FROM meals WHERE meal_date >= $1::date - 1 AND meal_date <= $2 GROUP BY meal_date', [startDate, endDate]),
    ]);

    const ctxByDate = {};
    ctxResult.rows.forEach(r => { ctxByDate[r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date] = r; });
    const mealsByDate = {};
    mealsResult.rows.forEach(r => { const d = r.meal_date instanceof Date ? r.meal_date.toISOString().slice(0, 10) : r.meal_date; mealsByDate[d] = r; });

    const trend = dates.map(date => {
      const ctx = ctxByDate[date] || null;
      const workouts7d = workoutsResult.rows.filter(w => {
        const wd = w.workout_date instanceof Date ? w.workout_date.toISOString().slice(0, 10) : w.workout_date;
        const target = new Date(date + 'T12:00:00');
        const sevenAgo = new Date(target); sevenAgo.setDate(sevenAgo.getDate() - 7);
        return new Date(wd + 'T12:00:00') >= sevenAgo && new Date(wd + 'T12:00:00') <= target;
      });

      const prevDate = new Date(date + 'T12:00:00');
      prevDate.setDate(prevDate.getDate() - 1);
      const prevDateStr = prevDate.toISOString().slice(0, 10);
      const yesterday = mealsByDate[prevDateStr] || null;

      const sleep = computeSleepScore(ctx);
      const trainingLoad = computeTrainingLoadScore(workouts7d);
      const { score: muscleScore } = computeMuscleFreshness(workouts7d, date);
      const injuryScore = computeInjuryScore(injuriesResult.rows);
      const nutritionScore = computeNutritionScore(yesterday);
      const subjectiveScore = computeSubjectiveScore(ctx);

      const score = Math.round(
        sleep.score * 0.30 + trainingLoad.score * 0.25 + muscleScore * 0.20 +
        injuryScore.score * 0.10 + nutritionScore.score * 0.10 + subjectiveScore.score * 0.05
      );

      return { date, score };
    });

    res.json({ days, trend });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
