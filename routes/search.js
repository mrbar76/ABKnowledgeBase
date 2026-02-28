const express = require('express');
const { query } = require('../db');
const router = express.Router();

// Unified search across all data types
// GET /api/search?q=term&limit=20
router.get('/', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    if (!q || !q.trim()) {
      return res.status(400).json({ error: 'q parameter is required' });
    }

    const perType = Math.min(Number(limit), 50);
    const term = q.trim();

    // Run all searches in parallel
    const [knowledge, transcripts, tasks, projects] = await Promise.all([
      searchKnowledge(term, perType),
      searchTranscripts(term, perType),
      searchTasks(term, perType),
      searchProjects(term, perType)
    ]);

    res.json({
      query: term,
      results: {
        knowledge,
        transcripts,
        tasks,
        projects
      },
      total: knowledge.length + transcripts.length + tasks.length + projects.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI-powered search — for ChatGPT/Claude to call
// POST /api/search/ai
router.post('/ai', async (req, res) => {
  try {
    const { query: searchQuery, limit = 10 } = req.body;
    if (!searchQuery) {
      return res.status(400).json({ error: 'query is required' });
    }

    const perType = Math.min(Number(limit), 30);
    const term = searchQuery.trim();

    const [knowledge, transcripts, tasks, projects] = await Promise.all([
      searchKnowledge(term, perType),
      searchTranscripts(term, perType),
      searchTasks(term, perType),
      searchProjects(term, perType)
    ]);

    // Format results with full context for AI consumption
    const allResults = [
      ...knowledge.map(r => ({ ...r, type: 'knowledge' })),
      ...transcripts.map(r => ({ ...r, type: 'transcript' })),
      ...tasks.map(r => ({ ...r, type: 'task' })),
      ...projects.map(r => ({ ...r, type: 'project' }))
    ].sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

    res.json({
      query: term,
      total: allResults.length,
      results: allResults,
      summary: `Found ${knowledge.length} knowledge entries, ${transcripts.length} transcripts, ${tasks.length} tasks, ${projects.length} projects matching "${term}"`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function searchKnowledge(term, limit) {
  // Full-text search first
  let result = await query(`
    SELECT id, title, LEFT(content, 200) as preview, category, tags, ai_source,
           updated_at, ts_rank(
             to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')),
             plainto_tsquery('english', $1)
           ) as relevance
    FROM knowledge
    WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
          @@ plainto_tsquery('english', $1)
    ORDER BY relevance DESC
    LIMIT $2
  `, [term, limit]);

  // Fallback to ILIKE
  if (result.rows.length === 0) {
    result = await query(`
      SELECT id, title, LEFT(content, 200) as preview, category, tags, ai_source,
             updated_at, 0.1 as relevance
      FROM knowledge
      WHERE title ILIKE $1 OR content ILIKE $1
      ORDER BY updated_at DESC
      LIMIT $2
    `, [`%${term}%`, limit]);
  }

  return result.rows.map(r => ({
    type: 'knowledge',
    id: r.id,
    title: r.title,
    preview: r.preview,
    category: r.category,
    tags: r.tags,
    ai_source: r.ai_source,
    updated_at: r.updated_at,
    relevance: parseFloat(r.relevance) || 0
  }));
}

async function searchTranscripts(term, limit) {
  let result = await query(`
    SELECT id, title, LEFT(raw_text, 200) as preview, summary, source, speaker_labels,
           duration_seconds, recorded_at, tags,
           ts_rank(
             to_tsvector('english', coalesce(title,'') || ' ' || coalesce(raw_text,'')),
             plainto_tsquery('english', $1)
           ) as relevance
    FROM transcripts
    WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(raw_text,''))
          @@ plainto_tsquery('english', $1)
    ORDER BY relevance DESC
    LIMIT $2
  `, [term, limit]);

  if (result.rows.length === 0) {
    result = await query(`
      SELECT id, title, LEFT(raw_text, 200) as preview, summary, source, speaker_labels,
             duration_seconds, recorded_at, tags, 0.1 as relevance
      FROM transcripts
      WHERE title ILIKE $1 OR raw_text ILIKE $1
      ORDER BY recorded_at DESC NULLS LAST
      LIMIT $2
    `, [`%${term}%`, limit]);
  }

  return result.rows.map(r => ({
    type: 'transcript',
    id: r.id,
    title: r.title,
    preview: r.summary || r.preview,
    source: r.source,
    duration_seconds: r.duration_seconds,
    recorded_at: r.recorded_at,
    tags: r.tags,
    relevance: parseFloat(r.relevance) || 0
  }));
}

async function searchTasks(term, limit) {
  const result = await query(`
    SELECT t.id, t.title, LEFT(t.description, 200) as preview, t.status, t.priority,
           t.ai_agent, t.created_at, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.title ILIKE $1 OR t.description ILIKE $1
    ORDER BY t.created_at DESC
    LIMIT $2
  `, [`%${term}%`, limit]);

  return result.rows.map(r => ({
    type: 'task',
    id: r.id,
    title: r.title,
    preview: r.preview,
    status: r.status,
    priority: r.priority,
    ai_agent: r.ai_agent,
    project_name: r.project_name,
    created_at: r.created_at,
    relevance: 0.05
  }));
}

async function searchProjects(term, limit) {
  const result = await query(`
    SELECT id, name as title, LEFT(description, 200) as preview, status, created_at
    FROM projects
    WHERE name ILIKE $1 OR description ILIKE $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [`%${term}%`, limit]);

  return result.rows.map(r => ({
    type: 'project',
    id: r.id,
    title: r.title,
    preview: r.preview,
    status: r.status,
    created_at: r.created_at,
    relevance: 0.05
  }));
}

module.exports = router;
