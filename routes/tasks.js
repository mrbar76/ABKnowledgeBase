const express = require('express');
const { query } = require('../db');
const router = express.Router();

// List tasks
router.get('/', async (req, res) => {
  try {
    const { project_id, status, ai_agent, limit = 100, offset = 0 } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    if (project_id) { where.push(`t.project_id = $${idx++}`); params.push(project_id); }
    if (status) { where.push(`t.status = $${idx++}`); params.push(status); }
    if (ai_agent) { where.push(`t.ai_agent = $${idx++}`); params.push(ai_agent); }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await query(`
      SELECT t.*, p.name as project_name
      FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
      ${clause}
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        t.created_at ASC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, Number(limit), Number(offset)]);

    res.json({ count: result.rows.length, tasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kanban view
router.get('/kanban', async (req, res) => {
  try {
    const { project_id } = req.query;
    let sql = `
      SELECT t.*, p.name as project_name FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
    `;
    let params = [];

    if (project_id) {
      sql += ' WHERE t.project_id = $1';
      params.push(project_id);
    }
    sql += ' ORDER BY CASE t.priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, t.created_at ASC';

    const result = await query(sql, params);
    const kanban = { todo: [], in_progress: [], review: [], done: [] };
    for (const task of result.rows) {
      kanban[task.status].push(task);
    }
    res.json(kanban);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single task
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT t.*, p.name as project_name FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = $1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create task
router.post('/', async (req, res) => {
  try {
    const { project_id, title, description, status, priority, ai_agent, next_steps } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const result = await query(`
      INSERT INTO tasks (project_id, title, description, status, priority, ai_agent, next_steps)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [project_id || null, title, description || null, status || 'todo', priority || 'medium', ai_agent || null, next_steps || null]);

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('create', 'task', $1, $2, $3)
    `, [result.rows[0].id, ai_agent || null, `Created task: ${title}`]);

    res.status(201).json({ id: result.rows[0].id, message: 'Task created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update task
router.put('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    const e = existing.rows[0];

    const { project_id, title, description, status, priority, ai_agent, next_steps, output_log } = req.body;

    await query(`
      UPDATE tasks
      SET project_id = $1, title = $2, description = $3, status = $4, priority = $5,
          ai_agent = $6, next_steps = $7, output_log = $8, updated_at = NOW()
      WHERE id = $9
    `, [
      project_id !== undefined ? project_id : e.project_id,
      title || e.title, description !== undefined ? description : e.description,
      status || e.status, priority || e.priority,
      ai_agent !== undefined ? ai_agent : e.ai_agent,
      next_steps !== undefined ? next_steps : e.next_steps,
      output_log !== undefined ? output_log : e.output_log,
      req.params.id
    ]);

    const statusChanged = status && status !== e.status;
    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('update', 'task', $1, $2, $3)
    `, [
      req.params.id, ai_agent || e.ai_agent,
      statusChanged ? `Task "${title || e.title}" moved to ${status}` : `Updated task: ${title || e.title}`
    ]);

    res.json({ message: 'Task updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete task
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
