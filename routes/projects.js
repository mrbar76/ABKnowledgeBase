const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const params = status ? [status] : [];
    const where = status ? 'WHERE p.status = $1' : '';

    const result = await query(`
      SELECT p.*,
        COUNT(CASE WHEN t.status = 'todo' THEN 1 END)::int as todo,
        COUNT(CASE WHEN t.status = 'in_progress' THEN 1 END)::int as in_progress,
        COUNT(CASE WHEN t.status = 'review' THEN 1 END)::int as review,
        COUNT(CASE WHEN t.status = 'done' THEN 1 END)::int as done
      FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
      ${where}
      GROUP BY p.id ORDER BY p.updated_at DESC`, params);

    const projects = result.rows.map(r => ({
      ...r,
      task_counts: { todo: r.todo, in_progress: r.in_progress, review: r.review, done: r.done }
    }));

    res.json({ count: projects.length, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const projResult = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!projResult.rows.length) return res.status(404).json({ error: 'Not found' });

    const tasksResult = await query(
      `SELECT * FROM tasks WHERE project_id = $1
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC`,
      [req.params.id]
    );

    res.json({ ...projResult.rows[0], tasks: tasksResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, description, status } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await query(
      'INSERT INTO projects (name, description, status) VALUES ($1, $2, $3) RETURNING id',
      [name, description || null, status || 'active']
    );

    await logActivity('create', 'project', result.rows[0].id, null, `Created project: ${name}`);
    res.status(201).json({ id: result.rows[0].id, message: 'Project created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, description, status } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;

    if (name !== undefined) { sets.push(`name = $${i++}`); params.push(name); }
    if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description); }
    if (status !== undefined) { sets.push(`status = $${i++}`); params.push(status); }

    params.push(req.params.id);
    const result = await query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Project updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Project deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
