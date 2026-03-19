const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

router.get('/', async (req, res) => {
  try {
    const { project_id, status, priority, ai_agent, context, limit = 100 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (project_id) { where.push(`t.project_id = $${i++}`); params.push(project_id); }
    if (status) { where.push(`t.status = $${i++}`); params.push(status); }
    if (priority) { where.push(`t.priority = $${i++}`); params.push(priority); }
    if (ai_agent) { where.push(`t.ai_agent = $${i++}`); params.push(ai_agent); }
    if (context) { where.push(`t.context = $${i++}`); params.push(context); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit));

    const result = await query(
      `SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
       ${whereClause} ORDER BY ${PRIORITY_ORDER}, t.created_at ASC LIMIT $${i}`, params
    );
    res.json({ count: result.rows.length, tasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/kanban', async (req, res) => {
  try {
    const { project_id, context } = req.query;
    const params = [];
    const conditions = [];
    let pi = 1;
    if (project_id) { conditions.push(`t.project_id = $${pi++}`); params.push(project_id); }
    if (context) { conditions.push(`t.context = $${pi++}`); params.push(context); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
       ${where} ORDER BY ${PRIORITY_ORDER}, t.created_at ASC`, params
    );

    const kanban = { todo: [], in_progress: [], review: [], done: [] };
    for (const task of result.rows) {
      (kanban[task.status] || kanban.todo).push(task);
    }
    res.json(kanban);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { project_id, title, description, status, priority, ai_agent, next_steps, due_date, context, source_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const result = await query(
      `INSERT INTO tasks (project_id, title, description, status, priority, ai_agent, next_steps, due_date, context, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [project_id || null, title, description || null, status || 'todo',
       priority || 'medium', ai_agent || null, next_steps || null, due_date || null,
       context || null, source_id || null]
    );

    await logActivity('create', 'task', result.rows[0].id, ai_agent, `Created task: ${title}`);
    res.status(201).json({ id: result.rows[0].id, message: 'Task created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { project_id, title, description, status, priority, ai_agent, next_steps, output_log, due_date, context } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;

    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(title); }
    if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description); }
    if (status !== undefined) { sets.push(`status = $${i++}`); params.push(status); }
    if (priority !== undefined) { sets.push(`priority = $${i++}`); params.push(priority); }
    if (ai_agent !== undefined) { sets.push(`ai_agent = $${i++}`); params.push(ai_agent); }
    if (next_steps !== undefined) { sets.push(`next_steps = $${i++}`); params.push(next_steps); }
    if (output_log !== undefined) { sets.push(`output_log = $${i++}`); params.push(output_log); }
    if (project_id !== undefined) { sets.push(`project_id = $${i++}`); params.push(project_id || null); }
    if (due_date !== undefined) { sets.push(`due_date = $${i++}`); params.push(due_date || null); }
    if (context !== undefined) { sets.push(`context = $${i++}`); params.push(context || null); }

    params.push(req.params.id);
    const result = await query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, title, status`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const row = result.rows[0];
    if (status) {
      await logActivity('update', 'task', req.params.id, ai_agent, `Task "${row.title}" moved to ${status}`);
    }
    res.json({ message: 'Task updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM tasks WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
