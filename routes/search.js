const express = require('express');
const {
  queryDatabase, searchNotion,
  pageToKnowledge, pageToFact, pageToTask, pageToProject, pageToTranscript
} = require('../notion');
const router = express.Router();

// Unified search across all data types
// GET /api/search?q=term&limit=20
router.get('/', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'q parameter is required' });
    }

    const term = q.trim();
    const perType = Math.min(Number(limit), 50);

    // Search each database in parallel
    const [knowledge, facts, transcripts, tasks, projects] = await Promise.all([
      searchType('knowledge', term, perType),
      searchType('facts', term, perType),
      searchType('transcripts', term, perType),
      searchType('tasks', term, perType),
      searchType('projects', term, perType),
    ]);

    res.json({
      query: term,
      results: { knowledge, facts, transcripts, tasks, projects },
      total: knowledge.length + facts.length + transcripts.length + tasks.length + projects.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI-optimized search
// POST /api/search/ai
router.post('/ai', async (req, res) => {
  try {
    const { query: searchQuery, limit = 10 } = req.body;
    if (!searchQuery) return res.status(400).json({ error: 'query is required' });

    const term = searchQuery.trim();
    const perType = Math.min(Number(limit), 30);

    const [knowledge, facts, transcripts, tasks, projects] = await Promise.all([
      searchType('knowledge', term, perType),
      searchType('facts', term, perType),
      searchType('transcripts', term, perType),
      searchType('tasks', term, perType),
      searchType('projects', term, perType),
    ]);

    const allResults = [
      ...knowledge.map(r => ({ ...r, type: 'knowledge' })),
      ...facts.map(r => ({ ...r, type: 'fact' })),
      ...transcripts.map(r => ({ ...r, type: 'transcript' })),
      ...tasks.map(r => ({ ...r, type: 'task' })),
      ...projects.map(r => ({ ...r, type: 'project' })),
    ];

    res.json({
      query: term,
      total: allResults.length,
      results: allResults,
      summary: `Found ${knowledge.length} knowledge, ${facts.length} facts, ${transcripts.length} transcripts, ${tasks.length} tasks, ${projects.length} projects matching "${term}"`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function searchType(dbName, term, limit) {
  try {
    const titleProp = dbName === 'projects' ? 'Name' : 'Title';
    const contentProp = dbName === 'knowledge' ? 'Content'
      : dbName === 'transcripts' ? 'Summary'
      : 'Description';

    const filter = { or: [
      { property: titleProp, title: { contains: term } },
      { property: contentProp, rich_text: { contains: term } },
    ]};

    const result = await queryDatabase(dbName, filter, undefined, limit);

    const converters = {
      knowledge: pageToKnowledge,
      facts: pageToFact,
      transcripts: pageToTranscript,
      tasks: pageToTask,
      projects: pageToProject,
    };

    return result.results.map(p => {
      const item = converters[dbName](p);
      item.type = dbName === 'transcripts' ? 'transcript'
        : dbName === 'projects' ? 'project' : dbName.replace(/s$/, '');
      return item;
    });
  } catch {
    return [];
  }
}

module.exports = router;
