const express = require('express');
const { query } = require('../db');
const router = express.Router();

// List projects
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM projects';
    let params = [];

    if (status) {
      sql += ' WHERE status = $1';
      params.push(status);
    }
    sql += ' ORDER BY updated_at DESC';

    const result = await query(sql, params);

    // Task counts per project
    const counts = await query(`
      SELECT project_id, status, COUNT(*)::int as count
      FROM tasks WHERE project_id IS NOT NULL
      GROUP BY project_id, status
    `);

    const countMap = {};
    for (const row of counts.rows) {
      if (!countMap[row.project_id]) countMap[row.project_id] = {};
      countMap[row.project_id][row.status] = row.count;
    }

    const projects = result.rows.map(p => ({
      ...p,
      task_counts: countMap[p.id] || { todo: 0, in_progress: 0, review: 0, done: 0 }
    }));

    res.json({ count: projects.length, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single project with tasks
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const tasks = await query('SELECT * FROM tasks WHERE project_id = $1 ORDER BY priority DESC, created_at ASC', [req.params.id]);
    res.json({ ...result.rows[0], tasks: tasks.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create project
router.post('/', async (req, res) => {
  try {
    const { name, description, status } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await query(
      'INSERT INTO projects (name, description, status) VALUES ($1, $2, $3) RETURNING id',
      [name, description || null, status || 'active']
    );

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, details)
      VALUES ('create', 'project', $1, $2)
    `, [result.rows[0].id, `Created project: ${name}`]);

    res.status(201).json({ id: result.rows[0].id, message: 'Project created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update project
router.put('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    const e = existing.rows[0];

    const { name, description, status } = req.body;
    await query(`
      UPDATE projects SET name = $1, description = $2, status = $3, updated_at = NOW()
      WHERE id = $4
    `, [name || e.name, description !== undefined ? description : e.description, status || e.status, req.params.id]);

    res.json({ message: 'Project updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete project
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Project deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
