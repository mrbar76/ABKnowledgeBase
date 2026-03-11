const express = require('express');
const { query } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [
      knowledgeTotal, knowledgeByCat, knowledgeBySource,
      factsTotal, factsByCat, factsConfirmed,
      projectsActive,
      tasksByStatus, tasksByPriority, tasksByAgent,
      transcriptsTotal, conversationsTotal,
      recentActivity
    ] = await Promise.all([
      query('SELECT COUNT(*)::int as total FROM knowledge'),
      query('SELECT category, COUNT(*)::int as count FROM knowledge GROUP BY category ORDER BY count DESC'),
      query('SELECT ai_source, COUNT(*)::int as count FROM knowledge WHERE ai_source IS NOT NULL GROUP BY ai_source ORDER BY count DESC'),
      query('SELECT COUNT(*)::int as total FROM facts'),
      query('SELECT category, COUNT(*)::int as count FROM facts GROUP BY category ORDER BY count DESC'),
      query('SELECT COUNT(*)::int as confirmed FROM facts WHERE confirmed = true'),
      query("SELECT COUNT(*)::int as active FROM projects WHERE status = 'active'"),
      query('SELECT status, COUNT(*)::int as count FROM tasks GROUP BY status'),
      query('SELECT priority, COUNT(*)::int as count FROM tasks GROUP BY priority'),
      query('SELECT ai_agent, COUNT(*)::int as count FROM tasks WHERE ai_agent IS NOT NULL GROUP BY ai_agent'),
      query('SELECT COUNT(*)::int as total FROM transcripts'),
      query('SELECT COUNT(*)::int as total FROM conversations'),
      query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 15'),
    ]);

    const statusMap = {};
    for (const r of tasksByStatus.rows) statusMap[r.status] = r.count;
    const priorityMap = {};
    for (const r of tasksByPriority.rows) priorityMap[r.priority] = r.count;

    res.json({
      knowledge: {
        total: knowledgeTotal.rows[0].total,
        by_category: knowledgeByCat.rows,
        by_ai_source: knowledgeBySource.rows,
      },
      facts: {
        total: factsTotal.rows[0].total,
        by_category: factsByCat.rows,
        confirmed: factsConfirmed.rows[0].confirmed,
      },
      projects: { active: projectsActive.rows[0].active },
      tasks: {
        by_status: statusMap,
        by_priority: priorityMap,
        by_agent: tasksByAgent.rows.map(r => ({ ai_agent: r.ai_agent, count: r.count })),
      },
      transcripts: { total: transcriptsTotal.rows[0].total },
      conversations: { total: conversationsTotal.rows[0].total },
      recent_activity: recentActivity.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
