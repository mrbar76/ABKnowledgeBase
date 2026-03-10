const express = require('express');
const {
  queryDatabase, pageToKnowledge, pageToFact, pageToTask, pageToProject,
  pageToTranscript, pageToHealthMetric, pageToWorkout, pageToActivity
} = require('../notion');
const router = express.Router();

// Dashboard stats — aggregated overview
router.get('/', async (req, res) => {
  try {
    // Fetch data in parallel (respects rate limit internally)
    const [knowledgeRes, factsRes, taskRes, projectRes, transcriptRes, healthRes, workoutRes, activityRes] = await Promise.all([
      queryDatabase('knowledge', undefined, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('facts', undefined, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('tasks', undefined, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('projects', { property: 'Status', select: { equals: 'active' } }, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('transcripts', undefined, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('health_metrics', undefined, undefined, 1).catch(() => ({ results: [] })),
      queryDatabase('workouts', undefined, undefined, 1).catch(() => ({ results: [] })),
      queryDatabase('activity_log', undefined, [{ property: 'Created At', direction: 'descending' }], 15).catch(() => ({ results: [] })),
    ]);

    const knowledge = knowledgeRes.results.map(pageToKnowledge);
    const tasks = taskRes.results.map(pageToTask);

    // Knowledge by category
    const byCategory = {};
    for (const k of knowledge) {
      byCategory[k.category] = (byCategory[k.category] || 0) + 1;
    }

    // Knowledge by AI source
    const bySource = {};
    for (const k of knowledge) {
      if (k.ai_source) bySource[k.ai_source] = (bySource[k.ai_source] || 0) + 1;
    }

    // Tasks by status
    const byStatus = {};
    for (const t of tasks) { byStatus[t.status] = (byStatus[t.status] || 0) + 1; }

    // Tasks by priority
    const byPriority = {};
    for (const t of tasks) { byPriority[t.priority] = (byPriority[t.priority] || 0) + 1; }

    // Tasks by agent
    const byAgent = {};
    for (const t of tasks) {
      if (t.ai_agent) byAgent[t.ai_agent] = (byAgent[t.ai_agent] || 0) + 1;
    }

    // Facts by category
    const facts = factsRes.results.map(pageToFact);
    const factsByCategory = {};
    for (const f of facts) {
      factsByCategory[f.category] = (factsByCategory[f.category] || 0) + 1;
    }

    res.json({
      knowledge: {
        total: knowledge.length,
        by_category: Object.entries(byCategory).map(([category, count]) => ({ category, count })),
        by_ai_source: Object.entries(bySource).map(([ai_source, count]) => ({ ai_source, count })),
      },
      facts: {
        total: facts.length,
        by_category: Object.entries(factsByCategory).map(([category, count]) => ({ category, count })),
        confirmed: facts.filter(f => f.confirmed).length,
      },
      projects: { active: projectRes.results.length },
      tasks: {
        by_status: byStatus,
        by_priority: byPriority,
        by_agent: Object.entries(byAgent).map(([ai_agent, count]) => ({ ai_agent, count })),
      },
      transcripts: { total: transcriptRes.results.length },
      health: {
        total_metrics: healthRes.results.length,
        total_workouts: workoutRes.results.length,
      },
      recent_activity: activityRes.results.map(pageToActivity),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
