const express = require('express');
const { query } = require('../db');
const router = express.Router();

// Dashboard stats — all-in-one overview
router.get('/', async (req, res) => {
  try {
    const [
      knowledgeCount,
      projectCount,
      tasksByStatus,
      tasksByPriority,
      recentActivity,
      knowledgeByCategory,
      knowledgeBySource,
      tasksByAgent,
      transcriptCount,
      healthMetricCount,
      workoutCount
    ] = await Promise.all([
      query('SELECT COUNT(*)::int as count FROM knowledge'),
      query("SELECT COUNT(*)::int as count FROM projects WHERE status = 'active'"),
      query('SELECT status, COUNT(*)::int as count FROM tasks GROUP BY status'),
      query('SELECT priority, COUNT(*)::int as count FROM tasks GROUP BY priority'),
      query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 15'),
      query('SELECT category, COUNT(*)::int as count FROM knowledge GROUP BY category ORDER BY count DESC'),
      query('SELECT ai_source, COUNT(*)::int as count FROM knowledge WHERE ai_source IS NOT NULL GROUP BY ai_source ORDER BY count DESC'),
      query('SELECT ai_agent, COUNT(*)::int as count FROM tasks WHERE ai_agent IS NOT NULL GROUP BY ai_agent ORDER BY count DESC'),
      query('SELECT COUNT(*)::int as count FROM transcripts'),
      query('SELECT COUNT(*)::int as count FROM health_metrics'),
      query('SELECT COUNT(*)::int as count FROM workouts')
    ]);

    res.json({
      knowledge: {
        total: knowledgeCount.rows[0].count,
        by_category: knowledgeByCategory.rows,
        by_ai_source: knowledgeBySource.rows
      },
      projects: {
        active: projectCount.rows[0].count
      },
      tasks: {
        by_status: Object.fromEntries(tasksByStatus.rows.map(r => [r.status, r.count])),
        by_priority: Object.fromEntries(tasksByPriority.rows.map(r => [r.priority, r.count])),
        by_agent: tasksByAgent.rows
      },
      transcripts: {
        total: transcriptCount.rows[0].count
      },
      health: {
        total_metrics: healthMetricCount.rows[0].count,
        total_workouts: workoutCount.rows[0].count
      },
      recent_activity: recentActivity.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
