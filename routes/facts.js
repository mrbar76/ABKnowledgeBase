const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { q, category, source, confirmed, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || content) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (category) { where.push(`category = $${i++}`); params.push(category); }
    if (source) { where.push(`source = $${i++}`); params.push(source); }
    if (confirmed !== undefined) { where.push(`confirmed = $${i++}`); params.push(confirmed === 'true'); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const result = await query(
      `SELECT * FROM facts ${whereClause} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ count: result.rows.length, facts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM facts WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, content, category, tags, source, confirmed, created_at } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const result = await query(
      `INSERT INTO facts (title, content, category, tags, source, confirmed, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
      [title || content.substring(0, 80), content, category || 'general',
       JSON.stringify(tags || []), source || 'manual', confirmed || false,
       created_at || new Date().toISOString()]
    );

    await logActivity('create', 'fact', result.rows[0].id, source, `Created fact: ${title || content.substring(0, 60)}`);
    res.status(201).json({ id: result.rows[0].id, message: 'Fact stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, content, category, tags, confirmed } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;

    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(title); }
    if (content !== undefined) { sets.push(`content = $${i++}`); params.push(content); }
    if (category !== undefined) { sets.push(`category = $${i++}`); params.push(category); }
    if (tags !== undefined) { sets.push(`tags = $${i++}::jsonb`); params.push(JSON.stringify(tags)); }
    if (confirmed !== undefined) { sets.push(`confirmed = $${i++}`); params.push(confirmed); }

    params.push(req.params.id);
    const result = await query(`UPDATE facts SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM facts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
