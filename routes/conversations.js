const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { q, ai_source, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || coalesce(summary,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (ai_source) { where.push(`ai_source = $${i++}`); params.push(ai_source); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const result = await query(
      `SELECT id, title, ai_source, summary, tags, project_id, message_count, metadata, created_at, updated_at
       FROM conversations ${whereClause} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ count: result.rows.length, conversations: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, ai_source, full_thread, summary, tags, project_id, metadata } = req.body;
    if (!title || !ai_source) return res.status(400).json({ error: 'title and ai_source are required' });

    const thread = Array.isArray(full_thread) ? full_thread : [];
    const result = await query(
      `INSERT INTO conversations (title, ai_source, full_thread, summary, tags, project_id, message_count, metadata)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8::jsonb) RETURNING id`,
      [title, ai_source, JSON.stringify(thread), summary || null,
       JSON.stringify(tags || []), project_id || null, thread.length,
       JSON.stringify(metadata || {})]
    );

    await logActivity('create', 'conversation', result.rows[0].id, ai_source, `Stored conversation: ${title}`);
    res.status(201).json({ id: result.rows[0].id, message: 'Conversation stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, summary, tags, full_thread, project_id, metadata } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;

    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(title); }
    if (summary !== undefined) { sets.push(`summary = $${i++}`); params.push(summary); }
    if (tags !== undefined) { sets.push(`tags = $${i++}::jsonb`); params.push(JSON.stringify(tags)); }
    if (full_thread !== undefined) {
      sets.push(`full_thread = $${i++}::jsonb`);
      params.push(JSON.stringify(full_thread));
      sets.push(`message_count = $${i++}`);
      params.push(Array.isArray(full_thread) ? full_thread.length : 0);
    }
    if (project_id !== undefined) { sets.push(`project_id = $${i++}`); params.push(project_id || null); }
    if (metadata !== undefined) { sets.push(`metadata = $${i++}::jsonb`); params.push(JSON.stringify(metadata)); }

    params.push(req.params.id);
    const result = await query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Conversation updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM conversations WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
