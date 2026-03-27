const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

router.get('/', async (req, res) => {
  try {
    const { status, priority, ai_agent, context, limit = 100 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (priority) { where.push(`priority = $${i++}`); params.push(priority); }
    if (ai_agent) { where.push(`ai_agent = $${i++}`); params.push(ai_agent); }
    if (context) { where.push(`context = $${i++}`); params.push(context); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit));

    const result = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comment_count
       FROM tasks t
       ${whereClause} ORDER BY ${PRIORITY_ORDER}, created_at ASC LIMIT $${i}`, params
    );
    res.json({ count: result.rows.length, tasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/kanban', async (req, res) => {
  try {
    const { context } = req.query;
    const params = [];
    const conditions = [];
    let pi = 1;
    if (context) { conditions.push(`context = $${pi++}`); params.push(context); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comment_count
       FROM tasks t
       ${where} ORDER BY ${PRIORITY_ORDER}, created_at ASC`, params
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
    const result = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    // Include activity history and comments
    const [history, comments] = await Promise.all([
      query(
        `SELECT action, details, created_at FROM activity_log
         WHERE entity_type = 'task' AND entity_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [req.params.id]
      ),
      query(
        `SELECT id, content, author, created_at FROM task_comments
         WHERE task_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      ),
    ]);

    res.json({ ...result.rows[0], history: history.rows, comments: comments.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, description, status, priority, ai_agent, next_steps, due_date, context, source_id, notes } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const effectiveStatus = status || 'todo';
    const result = await query(
      `INSERT INTO tasks (title, description, status, priority, ai_agent, next_steps, due_date, context, source_id, notes, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [title, description || null, effectiveStatus,
       priority || 'medium', ai_agent || null, next_steps || null, due_date || null,
       context || null, source_id || null, notes || null,
       effectiveStatus === 'done' ? new Date() : null]
    );

    await logActivity('create', 'task', result.rows[0].id, ai_agent, `Created task: ${title}`);
    res.status(201).json({ id: result.rows[0].id, message: 'Task created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, description, status, priority, ai_agent, next_steps, output_log, due_date, context, notes, tags, checklist } = req.body;
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
    if (due_date !== undefined) { sets.push(`due_date = $${i++}`); params.push(due_date || null); }
    if (context !== undefined) { sets.push(`context = $${i++}`); params.push(context || null); }
    if (notes !== undefined) { sets.push(`notes = $${i++}`); params.push(notes); }
    if (tags !== undefined) { sets.push(`tags = $${i++}::jsonb`); params.push(JSON.stringify(tags)); }
    if (checklist !== undefined) { sets.push(`checklist = $${i++}::jsonb`); params.push(JSON.stringify(checklist)); }

    // Auto-manage completed_at on status transitions
    if (status !== undefined) {
      if (status === 'done') {
        sets.push('completed_at = NOW()');
      } else {
        sets.push('completed_at = NULL');
      }
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, title, status, completed_at`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const row = result.rows[0];
    if (status) {
      await logActivity('update', 'task', req.params.id, ai_agent, `Task "${row.title}" moved to ${status}`);
    }
    res.json({ message: 'Task updated', task: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Task Comments ────────────────────────────────────────────
router.get('/:id/comments', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, content, author, created_at FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/comments', async (req, res) => {
  try {
    const { content, author } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const result = await query(
      `INSERT INTO task_comments (task_id, content, author) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, content, author || 'manual']
    );

    await logActivity('comment', 'task', req.params.id, author || 'manual', `Comment added`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/comments/:commentId', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM task_comments WHERE id = $1 AND task_id = $2 RETURNING id',
      [req.params.commentId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
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
