const express = require('express');
const { query } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    if (!q || !q.trim()) return res.status(400).json({ error: 'q parameter is required' });

    const term = q.trim();
    const perType = Math.min(Number(limit), 50);

    const [knowledge, transcripts, tasks, conversations, workouts, bodyMetrics, meals, trainingPlans, coachingSessions, injuries] = await Promise.all([
      searchFTS('knowledge', 'content', term, perType, 'id,title,LEFT(content,200) as content,category,ai_source,tags,created_at'),
      searchFTS('transcripts', 'summary', term, perType, 'id,title,LEFT(summary,200) as summary,source,recorded_at,duration_seconds,created_at'),
      searchILIKE('tasks', 'title', 'description', term, perType, 'id,title,LEFT(description,200) as description,status,priority,ai_agent,created_at'),
      searchFTS('conversations', 'summary', term, perType, 'id,title,ai_source,LEFT(summary,200) as summary,message_count,created_at'),
      searchFTS('workouts', 'focus', term, perType, 'id,title,workout_type,workout_date,LEFT(focus,200) as focus,effort,tags,created_at'),
      searchFTS('body_metrics', 'notes', term, perType, 'id,measurement_date,weight_lb,body_fat_pct,source,LEFT(notes,200) as notes,created_at'),
      searchFTS('meals', 'notes', term, perType, 'id,title,meal_type,meal_date,calories,protein_g,LEFT(notes,200) as notes,created_at'),
      searchFTS('training_plans', 'goal', term, perType, 'id,title,plan_type,status,LEFT(goal,200) as goal,start_date,end_date,created_at'),
      searchFTS('coaching_sessions', 'summary', term, perType, 'id,title,session_date,LEFT(summary,200) as summary,ai_source,created_at'),
      searchFTS('injuries', 'symptoms', term, perType, 'id,title,body_area,side,severity,status,onset_date,LEFT(symptoms,200) as symptoms,created_at'),
    ]);

    res.json({
      query: term,
      results: { knowledge, transcripts, tasks, conversations, workouts, body_metrics: bodyMetrics, meals, training_plans: trainingPlans, coaching_sessions: coachingSessions, injuries },
      total: knowledge.length + transcripts.length + tasks.length + conversations.length + workouts.length + bodyMetrics.length + meals.length + trainingPlans.length + coachingSessions.length + injuries.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ai', async (req, res) => {
  try {
    const { query: searchQuery, limit = 10 } = req.body;
    if (!searchQuery) return res.status(400).json({ error: 'query is required' });

    const term = searchQuery.trim();
    const perType = Math.min(Number(limit), 30);

    const [knowledge, transcripts, tasks, workouts, bodyMetrics, meals, trainingPlans, coachingSessions, injuries] = await Promise.all([
      searchFTS('knowledge', 'content', term, perType, 'id,title,LEFT(content,300) as content,category,ai_source,tags,created_at'),
      searchFTS('transcripts', 'summary', term, perType, 'id,title,LEFT(summary,300) as summary,source,recorded_at,created_at'),
      searchILIKE('tasks', 'title', 'description', term, perType, 'id,title,LEFT(description,200) as description,status,priority,ai_agent,created_at'),
      searchFTS('workouts', 'focus', term, perType, 'id,title,workout_type,workout_date,LEFT(focus,200) as focus,effort,tags,created_at'),
      searchFTS('body_metrics', 'notes', term, perType, 'id,measurement_date,weight_lb,body_fat_pct,source,LEFT(notes,200) as notes,created_at'),
      searchFTS('meals', 'notes', term, perType, 'id,title,meal_type,meal_date,calories,protein_g,LEFT(notes,200) as notes,created_at'),
      searchFTS('training_plans', 'goal', term, perType, 'id,title,plan_type,status,LEFT(goal,200) as goal,start_date,end_date,created_at'),
      searchFTS('coaching_sessions', 'summary', term, perType, 'id,title,session_date,LEFT(summary,200) as summary,ai_source,created_at'),
      searchFTS('injuries', 'symptoms', term, perType, 'id,title,body_area,side,severity,status,onset_date,LEFT(symptoms,200) as symptoms,created_at'),
    ]);

    const allResults = [
      ...knowledge.map(r => ({ ...r, type: 'knowledge' })),
      ...transcripts.map(r => ({ ...r, type: 'transcript' })),
      ...tasks.map(r => ({ ...r, type: 'task' })),
      ...workouts.map(r => ({ ...r, type: 'workout' })),
      ...bodyMetrics.map(r => ({ ...r, type: 'body_metric' })),
      ...meals.map(r => ({ ...r, type: 'meal' })),
      ...trainingPlans.map(r => ({ ...r, type: 'training_plan' })),
      ...coachingSessions.map(r => ({ ...r, type: 'coaching_session' })),
      ...injuries.map(r => ({ ...r, type: 'injury' })),
    ];

    res.json({ query: term, total: allResults.length, results: allResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function searchFTS(table, contentCol, term, limit, cols) {
  try {
    const result = await query(
      `SELECT ${cols} FROM ${table}
       WHERE search_vector @@ plainto_tsquery('english', $1)
          OR (coalesce(title,'') || ' ' || coalesce(${contentCol},'')) ILIKE '%' || $2 || '%'
       ORDER BY CASE WHEN search_vector @@ plainto_tsquery('english', $1)
         THEN ts_rank(search_vector, plainto_tsquery('english', $1)) ELSE 0 END DESC,
         created_at DESC
       LIMIT $3`,
      [term, term, limit]
    );
    return result.rows;
  } catch { return []; }
}

async function searchILIKE(table, col1, col2, term, limit, cols) {
  try {
    const result = await query(
      `SELECT ${cols} FROM ${table}
       WHERE coalesce(${col1},'') || ' ' || coalesce(${col2},'') ILIKE '%' || $1 || '%'
       ORDER BY created_at DESC LIMIT $2`,
      [term, limit]
    );
    return result.rows;
  } catch { return []; }
}

module.exports = router;
