const express = require('express');
const { query } = require('../db');
const router = express.Router();

// Search knowledge (full-text search with Postgres)
// GET /api/knowledge?q=search+terms&category=cat&tag=tagname&limit=50&offset=0
router.get('/', async (req, res) => {
  try {
    const { q, category, tag, ai_source, limit = 50, offset = 0 } = req.query;

    let sql, params;
    if (q) {
      sql = `
        SELECT *, ts_rank(
          to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')),
          plainto_tsquery('english', $1)
        ) as rank
        FROM knowledge
        WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
              @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2 OFFSET $3
      `;
      params = [q, Number(limit), Number(offset)];
    } else {
      let where = [];
      params = [];
      let idx = 1;

      if (category) { where.push(`category = $${idx++}`); params.push(category); }
      if (ai_source) { where.push(`ai_source = $${idx++}`); params.push(ai_source); }
      if (tag) { where.push(`tags @> $${idx++}::jsonb`); params.push(JSON.stringify([tag])); }

      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      sql = `SELECT * FROM knowledge ${clause} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
      params.push(Number(limit), Number(offset));
    }

    const result = await query(sql, params);
    res.json({ count: result.rows.length, entries: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get categories
router.get('/meta/categories', async (req, res) => {
  try {
    const result = await query('SELECT DISTINCT category FROM knowledge ORDER BY category');
    res.json(result.rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single entry
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
    const { title, content, category, tags, source, ai_source, metadata } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content are required' });

    const result = await query(`
      INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      title, content, category || 'general',
      JSON.stringify(tags || []), source || 'api',
      ai_source || null, JSON.stringify(metadata || {})
    ]);

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('create', 'knowledge', $1, $2, $3)
    `, [result.rows[0].id, ai_source || null, `Created knowledge: ${title}`]);

    res.status(201).json({ id: result.rows[0].id, message: 'Knowledge stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update knowledge
router.put('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM knowledge WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    const e = existing.rows[0];

    const { title, content, category, tags, ai_source, metadata } = req.body;
    await query(`
      UPDATE knowledge
      SET title = $1, content = $2, category = $3, tags = $4,
          ai_source = COALESCE($5, ai_source), metadata = $6, updated_at = NOW()
      WHERE id = $7
    `, [
      title || e.title, content || e.content, category || e.category,
      JSON.stringify(tags || e.tags), ai_source || null,
      JSON.stringify(metadata || e.metadata), req.params.id
    ]);

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('update', 'knowledge', $1, $2, $3)
    `, [req.params.id, ai_source || null, `Updated knowledge: ${title || e.title}`]);

    res.json({ message: 'Updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete knowledge
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM knowledge WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ('delete', 'knowledge', $1, 'Deleted knowledge entry')
    `, [req.params.id]);

    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
