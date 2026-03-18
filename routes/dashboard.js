const express = require('express');
const { query } = require('../db');
const router = express.Router();

// Safe query — returns default on error (missing table etc.)
async function sq(text, fallbackRows) {
  try { return (await query(text)).rows; }
  catch { return fallbackRows || []; }
}

router.get('/', async (req, res) => {
  try {
    const [
      knowledgeRows, factRows, projectRows,
      taskStatusRows, taskPriorityRows, taskAgentRows,
      transcriptRows, conversationRows, activityRows,
      workoutRows, bodyMetricRows, mealRows,
      trainingPlanRows, coachingRows, injuryRows, activeInjuryRows
    ] = await Promise.all([
      sq('SELECT COUNT(*)::int as total FROM knowledge', [{ total: 0 }]),
      sq('SELECT COUNT(*)::int as total FROM facts', [{ total: 0 }]),
      sq("SELECT COUNT(*)::int as active FROM projects WHERE status = 'active'", [{ active: 0 }]),
      sq('SELECT status, COUNT(*)::int as count FROM tasks GROUP BY status'),
      sq('SELECT priority, COUNT(*)::int as count FROM tasks GROUP BY priority'),
      sq('SELECT ai_agent, COUNT(*)::int as count FROM tasks WHERE ai_agent IS NOT NULL GROUP BY ai_agent'),
      sq('SELECT COUNT(*)::int as total FROM transcripts', [{ total: 0 }]),
      sq('SELECT COUNT(*)::int as total FROM conversations', [{ total: 0 }]),
      sq('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 15'),
      sq('SELECT COUNT(*)::int as total FROM workouts', [{ total: 0 }]),
      sq('SELECT COUNT(*)::int as total FROM body_metrics', [{ total: 0 }]),
      sq('SELECT COUNT(*)::int as total FROM meals', [{ total: 0 }]),
      sq("SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE status = 'active')::int as active FROM training_plans", [{ total: 0, active: 0 }]),
      sq('SELECT COUNT(*)::int as total FROM coaching_sessions', [{ total: 0 }]),
      sq('SELECT COUNT(*)::int as total FROM injuries', [{ total: 0 }]),
      sq("SELECT COUNT(*)::int as active FROM injuries WHERE status IN ('active','monitoring')", [{ active: 0 }]),
    ]);

    const statusMap = {};
    for (const r of taskStatusRows) statusMap[r.status] = r.count;
    const priorityMap = {};
    for (const r of taskPriorityRows) priorityMap[r.priority] = r.count;

    res.json({
      knowledge: { total: knowledgeRows[0]?.total || 0 },
      facts: { total: factRows[0]?.total || 0 },
      projects: { active: projectRows[0]?.active || 0 },
      tasks: {
        by_status: statusMap,
        by_priority: priorityMap,
        by_agent: taskAgentRows.map(r => ({ ai_agent: r.ai_agent, count: r.count })),
      },
      transcripts: { total: transcriptRows[0]?.total || 0 },
      conversations: { total: conversationRows[0]?.total || 0 },
      workouts: { total: workoutRows[0]?.total || 0 },
      body_metrics: { total: bodyMetricRows[0]?.total || 0 },
      meals: { total: mealRows[0]?.total || 0 },
      training: {
        plans: { total: trainingPlanRows[0]?.total || 0, active: trainingPlanRows[0]?.active || 0 },
        coaching_sessions: { total: coachingRows[0]?.total || 0 },
        injuries: { total: injuryRows[0]?.total || 0, active: activeInjuryRows[0]?.active || 0 },
      },
      recent_activity: activityRows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
