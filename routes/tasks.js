const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

router.get('/', async (req, res) => {
  try {
    await ensureWaitingOnCol();
    const { status, priority, ai_agent, context, waiting_on, limit = 100 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (priority) { where.push(`priority = $${i++}`); params.push(priority); }
    if (ai_agent) { where.push(`ai_agent = $${i++}`); params.push(ai_agent); }
    if (context) { where.push(`context = $${i++}`); params.push(context); }
    if (waiting_on) { where.push(`waiting_on ILIKE $${i++}`); params.push(waiting_on); }

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

    const kanban = { todo: [], in_progress: [], waiting_on: [], review: [], done: [] };
    for (const task of result.rows) {
      (kanban[task.status] || kanban.todo).push(task);
    }
    res.json(kanban);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Weekly Review ───────────────────────────────────────────
router.get('/weekly-review', async (req, res) => {
  try {
    // Support offset: ?weeks_ago=0 (this week), 1 (last week), etc.
    const weeksAgo = parseInt(req.query.weeks_ago) || 0;

    const [completed, created, byDay, byPriority, byContext, overdue, streakR, carryOver] = await Promise.all([
      // Tasks completed this week
      query(`
        SELECT id, title, priority, context, completed_at, due_date, recurrence_rule IS NOT NULL OR recurring_parent_id IS NOT NULL AS is_recurring
        FROM tasks
        WHERE status = 'done'
          AND completed_at >= date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval)
          AND completed_at < date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval) + interval '7 days'
        ORDER BY completed_at ASC
      `, [weeksAgo]),
      // Tasks created this week
      query(`
        SELECT id, title, priority, context, status, due_date
        FROM tasks
        WHERE created_at >= date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval)
          AND created_at < date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval) + interval '7 days'
        ORDER BY created_at ASC
      `, [weeksAgo]),
      // Completions by day of week
      query(`
        WITH week_start AS (SELECT date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval)::date AS ws)
        SELECT d::date AS date,
          (SELECT COUNT(*)::int FROM tasks WHERE status = 'done' AND completed_at::date = d) AS completed,
          (SELECT COUNT(*)::int FROM tasks WHERE created_at::date = d) AS created
        FROM week_start, generate_series(ws, ws + 6, '1 day') d
        ORDER BY d
      `, [weeksAgo]),
      // Completed by priority
      query(`
        SELECT priority, COUNT(*)::int AS count
        FROM tasks
        WHERE status = 'done'
          AND completed_at >= date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval)
          AND completed_at < date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval) + interval '7 days'
        GROUP BY priority ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END
      `, [weeksAgo]),
      // Completed by context
      query(`
        SELECT COALESCE(context, 'unset') AS context, COUNT(*)::int AS count
        FROM tasks
        WHERE status = 'done'
          AND completed_at >= date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval)
          AND completed_at < date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval) + interval '7 days'
        GROUP BY context
      `, [weeksAgo]),
      // Currently overdue (only relevant for current week)
      query(`
        SELECT COUNT(*)::int AS count FROM tasks
        WHERE status NOT IN ('done') AND due_date < CURRENT_DATE
      `),
      // Completion streak: consecutive days with at least 1 completion
      query(`
        WITH dates AS (
          SELECT DISTINCT completed_at::date AS d FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL ORDER BY d DESC
        ),
        grouped AS (
          SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp FROM dates
        )
        SELECT COUNT(*)::int AS streak FROM grouped WHERE grp = (SELECT grp FROM grouped ORDER BY d DESC LIMIT 1)
      `),
      // Carry-over: tasks that were open at week start and still open at week end
      query(`
        SELECT COUNT(*)::int AS count FROM tasks
        WHERE status NOT IN ('done')
          AND created_at < date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval)
      `, [weeksAgo]),
    ]);

    // Previous week comparison
    const prevWeeksAgo = weeksAgo + 1;
    const prevCompleted = await query(`
      SELECT COUNT(*)::int AS count FROM tasks
      WHERE status = 'done'
        AND completed_at >= date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval)
        AND completed_at < date_trunc('week', CURRENT_DATE - ($1 || ' weeks')::interval) + interval '7 days'
    `, [prevWeeksAgo]);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() - (weeksAgo * 7));
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    res.json({
      week_start: weekStart.toISOString().slice(0, 10),
      week_end: weekEnd.toISOString().slice(0, 10),
      weeks_ago: weeksAgo,
      completed: { count: completed.rows.length, tasks: completed.rows },
      created: { count: created.rows.length, tasks: created.rows },
      by_day: byDay.rows,
      by_priority: byPriority.rows,
      by_context: byContext.rows,
      overdue_count: overdue.rows[0]?.count || 0,
      completion_streak: streakR.rows[0]?.streak || 0,
      carry_over_count: carryOver.rows[0]?.count || 0,
      prev_week_completed: prevCompleted.rows[0]?.count || 0,
      velocity_change: completed.rows.length - (prevCompleted.rows[0]?.count || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug/status-check', async (req, res) => {
  try {
    const cols = await query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'waiting_on'`);
    const statuses = await query(`SELECT status, waiting_on, COUNT(*) as count FROM tasks GROUP BY status, waiting_on ORDER BY status`);
    const waitingTasks = await query(`SELECT id, title, status, waiting_on FROM tasks WHERE status = 'waiting_on' OR waiting_on IS NOT NULL LIMIT 20`);
    res.json({
      waiting_on_column_exists: cols.rows.length > 0,
      status_summary: statuses.rows,
      waiting_tasks: waitingTasks.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const { title, description, status, priority, ai_agent, next_steps, due_date, context, source_id, notes, waiting_on, recurrence_rule } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const effectiveStatus = status || 'todo';
    const result = await query(
      `INSERT INTO tasks (title, description, status, priority, ai_agent, next_steps, due_date, context, source_id, notes, completed_at, waiting_on, recurrence_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [title, description || null, effectiveStatus,
       priority || 'medium', ai_agent || null, next_steps || null, due_date || null,
       context || null, source_id || null, notes || null,
       effectiveStatus === 'done' ? new Date() : null, waiting_on || null,
       recurrence_rule ? JSON.stringify(recurrence_rule) : null]
    );

    const taskId = result.rows[0].id;

    // If recurring, generate upcoming instances
    if (recurrence_rule && due_date) {
      await generateRecurringInstances(taskId, title, description, priority, context, notes, recurrence_rule, due_date);
    }

    await logActivity('create', 'task', taskId, ai_agent, `Created task: ${title}${recurrence_rule ? ' (recurring)' : ''}`);
    res.status(201).json({ id: taskId, message: 'Task created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ensure waiting_on column exists (runs once, cached)
let _waitingOnColChecked = false;
async function ensureWaitingOnCol() {
  if (_waitingOnColChecked) return;
  try {
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_on TEXT`);
    await query(`CREATE INDEX IF NOT EXISTS idx_tasks_waiting_on ON tasks(waiting_on)`);
    await query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check`);
    await query(`ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK(status IN ('todo','in_progress','waiting_on','review','done'))`);
  } catch (e) { console.error('[tasks] waiting_on setup:', e.message); }
  _waitingOnColChecked = true;
}

router.put('/:id', async (req, res) => {
  try {
    await ensureWaitingOnCol();
    const { title, description, status, priority, ai_agent, next_steps, output_log, due_date, context, notes, tags, checklist, waiting_on } = req.body;
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
    if (waiting_on !== undefined) { sets.push(`waiting_on = $${i++}`); params.push(waiting_on || null); }
    if (req.body.recurrence_rule !== undefined) {
      sets.push(`recurrence_rule = $${i++}::jsonb`);
      params.push(req.body.recurrence_rule ? JSON.stringify(req.body.recurrence_rule) : null);
    }
    if (req.body.reminder_at !== undefined) {
      sets.push(`reminder_at = $${i++}`);
      params.push(req.body.reminder_at || null);
    }
    if (req.body.linked_items !== undefined) {
      sets.push(`linked_items = $${i++}::jsonb`);
      params.push(JSON.stringify(req.body.linked_items));
    }

    // Auto-clear waiting_on when moving away from waiting_on status
    if (status !== undefined && status !== 'waiting_on' && waiting_on === undefined) {
      sets.push('waiting_on = NULL');
    }

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

// ─── Task Context (Related Items) ────────────────────────────

// Auto-discover related context + return manually linked items
router.get('/:id/context', async (req, res) => {
  try {
    const taskResult = await query('SELECT id, title, description, notes, linked_items FROM tasks WHERE id = $1', [req.params.id]);
    if (!taskResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const task = taskResult.rows[0];

    // Build search terms from title + description + notes
    const searchTerms = [task.title, task.description, task.notes].filter(Boolean).join(' ');
    // Extract meaningful keywords (skip short/common words)
    const words = searchTerms.split(/\s+/).filter(w => w.length > 3);
    const searchQuery = words.slice(0, 12).join(' '); // cap at 12 words for performance

    // Search across all context sources in parallel using FTS
    const [knowledge, transcripts, conversations] = await Promise.all([
      query(`
        SELECT id, title, category, ai_source, tags, created_at,
          LEFT(content, 200) AS snippet,
          CASE WHEN search_vector @@ plainto_tsquery('english', $1)
            THEN ts_rank(search_vector, plainto_tsquery('english', $1)) ELSE 0.01 END AS relevance
        FROM knowledge
        WHERE search_vector @@ plainto_tsquery('english', $1)
          OR (coalesce(title,'') || ' ' || coalesce(content,'')) ILIKE '%' || $2 || '%'
        ORDER BY relevance DESC, created_at DESC LIMIT 5
      `, [searchQuery, words[0] || '']),
      query(`
        SELECT id, title, source, recorded_at, duration_seconds, location, tags, created_at,
          LEFT(summary, 200) AS snippet,
          CASE WHEN search_vector @@ plainto_tsquery('english', $1)
            THEN ts_rank(search_vector, plainto_tsquery('english', $1)) ELSE 0.01 END AS relevance
        FROM transcripts
        WHERE search_vector @@ plainto_tsquery('english', $1)
          OR (coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'')) ILIKE '%' || $2 || '%'
        ORDER BY relevance DESC, created_at DESC LIMIT 5
      `, [searchQuery, words[0] || '']),
      query(`
        SELECT id, title, ai_source, message_count, tags, created_at,
          LEFT(summary, 200) AS snippet,
          CASE WHEN search_vector @@ plainto_tsquery('english', $1)
            THEN ts_rank(search_vector, plainto_tsquery('english', $1)) ELSE 0.01 END AS relevance
        FROM conversations
        WHERE search_vector @@ plainto_tsquery('english', $1)
          OR (coalesce(title,'') || ' ' || coalesce(summary,'')) ILIKE '%' || $2 || '%'
        ORDER BY relevance DESC, created_at DESC LIMIT 5
      `, [searchQuery, words[0] || '']),
    ]);

    // Fetch manually linked items
    const linkedItems = task.linked_items || [];
    const linked = [];
    for (const item of linkedItems) {
      try {
        const table = { knowledge: 'knowledge', transcript: 'transcripts', conversation: 'conversations' }[item.type];
        if (!table) continue;
        const r = await query(`SELECT id, title, created_at FROM ${table} WHERE id = $1`, [item.id]);
        if (r.rows.length) linked.push({ ...r.rows[0], type: item.type, manual: true });
      } catch { /* skip broken links */ }
    }

    res.json({
      auto: {
        knowledge: knowledge.rows,
        transcripts: transcripts.rows,
        conversations: conversations.rows,
      },
      linked,
      search_query: searchQuery,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Link an item to a task
router.post('/:id/link', async (req, res) => {
  try {
    const { type, item_id } = req.body;
    if (!type || !item_id) return res.status(400).json({ error: 'type and item_id required' });
    if (!['knowledge', 'transcript', 'conversation'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

    const taskResult = await query('SELECT linked_items FROM tasks WHERE id = $1', [req.params.id]);
    if (!taskResult.rows.length) return res.status(404).json({ error: 'Not found' });

    const linked = taskResult.rows[0].linked_items || [];
    // Don't duplicate
    if (linked.some(l => l.type === type && l.id === item_id)) {
      return res.json({ message: 'Already linked' });
    }

    linked.push({ type, id: item_id, linked_at: new Date().toISOString() });
    await query('UPDATE tasks SET linked_items = $1::jsonb, updated_at = NOW() WHERE id = $2', [JSON.stringify(linked), req.params.id]);
    await logActivity('link', 'task', req.params.id, null, `Linked ${type}: ${item_id}`);
    res.json({ message: 'Linked', linked_items: linked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unlink an item from a task
router.delete('/:id/link', async (req, res) => {
  try {
    const { type, item_id } = req.body;
    const taskResult = await query('SELECT linked_items FROM tasks WHERE id = $1', [req.params.id]);
    if (!taskResult.rows.length) return res.status(404).json({ error: 'Not found' });

    const linked = (taskResult.rows[0].linked_items || []).filter(l => !(l.type === type && l.id === item_id));
    await query('UPDATE tasks SET linked_items = $1::jsonb, updated_at = NOW() WHERE id = $2', [JSON.stringify(linked), req.params.id]);
    res.json({ message: 'Unlinked', linked_items: linked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Operations ─────────────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { task_ids, action, value } = req.body;
    if (!task_ids?.length) return res.status(400).json({ error: 'task_ids required' });
    if (!action) return res.status(400).json({ error: 'action required' });

    let affected = 0;
    const placeholders = task_ids.map((_, idx) => `$${idx + 1}`).join(',');

    if (action === 'mark_done') {
      const result = await query(
        `UPDATE tasks SET status = 'done', completed_at = NOW(), updated_at = NOW() WHERE id IN (${placeholders}) AND status != 'done' RETURNING id`,
        task_ids
      );
      affected = result.rows.length;
      for (const row of result.rows) {
        await logActivity('update', 'task', row.id, null, 'Bulk: marked done');
      }
    } else if (action === 'mark_todo') {
      const result = await query(
        `UPDATE tasks SET status = 'todo', completed_at = NULL, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id`,
        task_ids
      );
      affected = result.rows.length;
    } else if (action === 'reschedule' && value) {
      const result = await query(
        `UPDATE tasks SET due_date = $${task_ids.length + 1}, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id`,
        [...task_ids, value]
      );
      affected = result.rows.length;
    } else if (action === 'set_priority' && value) {
      const result = await query(
        `UPDATE tasks SET priority = $${task_ids.length + 1}, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id`,
        [...task_ids, value]
      );
      affected = result.rows.length;
    } else if (action === 'set_context' && value !== undefined) {
      const result = await query(
        `UPDATE tasks SET context = $${task_ids.length + 1}, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id`,
        [...task_ids, value || null]
      );
      affected = result.rows.length;
    } else if (action === 'delete') {
      const result = await query(
        `DELETE FROM tasks WHERE id IN (${placeholders}) RETURNING id`,
        task_ids
      );
      affected = result.rows.length;
      for (const row of result.rows) {
        await logActivity('delete', 'task', row.id, null, 'Bulk: deleted');
      }
    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    res.json({ message: `Bulk ${action}: ${affected} tasks affected`, affected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Recurring Tasks ─────────────────────────────────────────

/**
 * Generate upcoming instances for a recurring task.
 * Generates up to 30 days ahead (or until end_date).
 * recurrence_rule: { type: "daily"|"weekly"|"monthly", interval: 1, days_of_week: [0-6], end_date: "YYYY-MM-DD" }
 */
async function generateRecurringInstances(parentId, title, description, priority, context, notes, rule, startDate) {
  const HORIZON_DAYS = 30;
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const horizon = new Date(start);
  horizon.setDate(horizon.getDate() + HORIZON_DAYS);
  const endDate = rule.end_date ? new Date(rule.end_date) : horizon;
  const limit = endDate < horizon ? endDate : horizon;

  // Find already-generated instance dates for this parent
  const existing = await query(
    `SELECT due_date FROM tasks WHERE recurring_parent_id = $1 AND due_date IS NOT NULL`,
    [parentId]
  );
  const existingDates = new Set(existing.rows.map(r => r.due_date?.toISOString?.()?.slice(0, 10) || r.due_date));

  const dates = computeRecurrenceDates(rule, start, limit);

  let created = 0;
  for (const d of dates) {
    const ds = toDateStr(d);
    if (ds === toDateStr(start)) continue; // skip the original date
    if (existingDates.has(ds)) continue;
    await query(
      `INSERT INTO tasks (title, description, status, priority, context, notes, due_date, recurring_parent_id)
       VALUES ($1, $2, 'todo', $3, $4, $5, $6, $7)`,
      [title, description || null, priority || 'medium', context || null, notes || null, ds, parentId]
    );
    created++;
  }
  return created;
}

function toDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function computeRecurrenceDates(rule, start, limit) {
  const dates = [];
  const interval = rule.interval || 1;
  let current = new Date(start);

  if (rule.type === 'daily') {
    while (current <= limit) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + interval);
    }
  } else if (rule.type === 'weekly') {
    const dow = rule.days_of_week || [start.getDay()];
    while (current <= limit) {
      if (dow.includes(current.getDay())) {
        dates.push(new Date(current));
      }
      current.setDate(current.getDate() + 1);
      // Skip ahead by (interval-1) weeks after completing a week cycle
      if (current.getDay() === start.getDay() && interval > 1) {
        current.setDate(current.getDate() + 7 * (interval - 1));
      }
    }
  } else if (rule.type === 'monthly') {
    const dayOfMonth = rule.day_of_month || start.getDate();
    while (current <= limit) {
      const candidate = new Date(current.getFullYear(), current.getMonth(), Math.min(dayOfMonth, daysInMonth(current.getFullYear(), current.getMonth())));
      if (candidate >= start && candidate <= limit) {
        dates.push(candidate);
      }
      current.setMonth(current.getMonth() + interval);
    }
  }
  return dates;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// Get all instances for a recurring parent
router.get('/:id/instances', async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comment_count
       FROM tasks t WHERE t.recurring_parent_id = $1 ORDER BY t.due_date ASC`,
      [req.params.id]
    );
    res.json({ count: result.rows.length, instances: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all future instances of a recurring task
router.delete('/:id/future-instances', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await query(
      `DELETE FROM tasks WHERE recurring_parent_id = $1 AND due_date >= $2 AND status != 'done' RETURNING id`,
      [req.params.id, today]
    );
    res.json({ deleted: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update recurrence rule on a parent task (and regenerate)
router.put('/:id/recurrence', async (req, res) => {
  try {
    const { recurrence_rule } = req.body;
    const taskResult = await query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (!taskResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const task = taskResult.rows[0];

    // Update the rule
    await query('UPDATE tasks SET recurrence_rule = $1, updated_at = NOW() WHERE id = $2',
      [recurrence_rule ? JSON.stringify(recurrence_rule) : null, req.params.id]);

    // Delete future undone instances and regenerate
    const today = new Date().toISOString().slice(0, 10);
    await query(`DELETE FROM tasks WHERE recurring_parent_id = $1 AND due_date >= $2 AND status != 'done'`, [req.params.id, today]);

    let created = 0;
    if (recurrence_rule && task.due_date) {
      const startFrom = task.due_date < today ? today : task.due_date;
      created = await generateRecurringInstances(req.params.id, task.title, task.description, task.priority, task.context, task.notes, recurrence_rule, startFrom);
    }

    await logActivity('update', 'task', req.params.id, null, `Recurrence updated: ${recurrence_rule ? recurrence_rule.type : 'removed'}`);
    res.json({ message: 'Recurrence updated', instances_created: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extend recurring instances (called by cron to keep 30-day horizon)
async function extendAllRecurring() {
  try {
    const parents = await query(`SELECT * FROM tasks WHERE recurrence_rule IS NOT NULL AND status != 'done'`);
    let total = 0;
    for (const task of parents.rows) {
      const rule = typeof task.recurrence_rule === 'string' ? JSON.parse(task.recurrence_rule) : task.recurrence_rule;
      if (!rule || !task.due_date) continue;
      const today = new Date().toISOString().slice(0, 10);
      const startFrom = task.due_date < today ? today : toDateStr(new Date(task.due_date));
      const created = await generateRecurringInstances(task.id, task.title, task.description, task.priority, task.context, task.notes, rule, startFrom);
      total += created;
    }
    return total;
  } catch (err) {
    console.error('[recurring] Extension failed:', err.message);
    return 0;
  }
}

module.exports = router;
module.exports.extendAllRecurring = extendAllRecurring;
