const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// Search/list knowledge
router.get('/', async (req, res) => {
  try {
    const { q, category, tag, ai_source, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || content) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (category) { where.push(`category = $${i++}`); params.push(category); }
    if (ai_source) { where.push(`ai_source = $${i++}`); params.push(ai_source); }
    if (tag) { where.push(`tags @> $${i++}::jsonb`); params.push(JSON.stringify([tag])); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = q
      ? `ORDER BY CASE WHEN search_vector @@ plainto_tsquery('english', $1) THEN ts_rank(search_vector, plainto_tsquery('english', $1)) ELSE 0 END DESC, updated_at DESC`
      : 'ORDER BY updated_at DESC';

    params.push(Number(limit), Number(offset));
    const result = await query(
      `SELECT id, title, LEFT(content, 300) as content, category, tags, source, ai_source, project_id, metadata, created_at, updated_at
       FROM knowledge ${whereClause} ${orderBy} LIMIT $${i++} OFFSET $${i++}`, params
    );

    res.json({ count: result.rows.length, entries: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get categories
router.get('/meta/categories', async (req, res) => {
  try {
    const result = await query('SELECT DISTINCT category FROM knowledge WHERE category IS NOT NULL ORDER BY category');
    res.json(result.rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single entry (full content)
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM knowledge WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Store knowledge
router.post('/', async (req, res) => {
  try {
    const { title, content, category, tags, source, ai_source, project_id, metadata, created_at } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content are required' });

    const result = await query(
      `INSERT INTO knowledge (title, content, category, tags, source, ai_source, project_id, metadata, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
      [title, content, category || 'general', JSON.stringify(tags || []),
       source || 'api', ai_source || null, project_id || null,
       JSON.stringify(metadata || {}), created_at || new Date().toISOString()]
    );

    await logActivity('create', 'knowledge', result.rows[0].id, ai_source, `Created knowledge: ${title}`);
    res.status(201).json({ id: result.rows[0].id, message: 'Knowledge stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update knowledge
router.put('/:id', async (req, res) => {
  try {
    const { title, content, category, tags, ai_source, project_id, metadata } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;

    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(title); }
    if (content !== undefined) { sets.push(`content = $${i++}`); params.push(content); }
    if (category !== undefined) { sets.push(`category = $${i++}`); params.push(category); }
    if (tags !== undefined) { sets.push(`tags = $${i++}::jsonb`); params.push(JSON.stringify(tags)); }
    if (ai_source !== undefined) { sets.push(`ai_source = $${i++}`); params.push(ai_source); }
    if (project_id !== undefined) { sets.push(`project_id = $${i++}`); params.push(project_id); }
    if (metadata !== undefined) { sets.push(`metadata = $${i++}::jsonb`); params.push(JSON.stringify(metadata)); }

    params.push(req.params.id);
    const result = await query(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'knowledge', req.params.id, ai_source, `Updated knowledge: ${title || req.params.id}`);
    res.json({ message: 'Updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete knowledge
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM knowledge WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'knowledge', req.params.id, null, 'Deleted knowledge entry');
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
