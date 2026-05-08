const express = require('express');
const { query } = require('../db');
const {
  computeRecoveryScore,
  computeSleepScore,
  computeTrainingLoadScore,
  computeMuscleFreshness,
  computeInjuryScore,
  computeNutritionScore,
  computeSubjectiveScore,
  dateStr,
} = require('../lib/recovery');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════

router.get('/score', async (req, res) => {
  try {
    const date = req.query.date || req.getToday();
    const today = req.getToday();

    if (date > today) {
      return res.json({
        date,
        score: null,
        label: 'N/A',
        components: {},
        muscle_status: {},
        recommendation: "No data - this date hasn't happened yet.",
      });
    }

    const result = await computeRecoveryScore({ date, query });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trend', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 7, 30);
    const today = req.getToday();
    const requestedEnd = req.query.date || today;
    const endDate = requestedEnd > today ? today : requestedEnd;

    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(endDate + 'T12:00:00');
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      if (ds <= today) dates.push(ds);
    }

    const startDate = dates[0];
    const [ctxResult, workoutsResult, injuriesResult, mealsResult] = await Promise.all([
      query('SELECT * FROM daily_context WHERE date >= $1 AND date <= $2 ORDER BY date', [startDate, endDate]),
      query("SELECT * FROM workouts WHERE workout_date >= $1::date - INTERVAL '56 days' AND workout_date <= $2 ORDER BY workout_date DESC, created_at DESC", [startDate, endDate]),
      query("SELECT * FROM injuries WHERE status IN ('active','monitoring') ORDER BY severity DESC NULLS LAST"),
      query('SELECT meal_date, SUM(calories) as total_calories, SUM(protein_g) as total_protein_g FROM meals WHERE meal_date >= $1::date - 1 AND meal_date <= $2 GROUP BY meal_date', [startDate, endDate]),
    ]);

    const ctxByDate = {};
    ctxResult.rows.forEach((r) => { ctxByDate[dateStr(r.date)] = r; });
    const mealsByDate = {};
    mealsResult.rows.forEach((r) => { mealsByDate[dateStr(r.meal_date)] = r; });

    const trend = dates.map((date) => {
      const ctx = ctxByDate[date] || null;
      const allWorkoutsForDate = workoutsResult.rows.filter((w) => dateStr(w.workout_date) <= date);
      const workouts7d = allWorkoutsForDate.filter((w) => {
        const wd = new Date(dateStr(w.workout_date) + 'T12:00:00');
        const sevenAgo = new Date(date + 'T12:00:00');
        sevenAgo.setDate(sevenAgo.getDate() - 7);
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
