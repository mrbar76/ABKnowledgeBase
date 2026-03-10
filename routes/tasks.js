const express = require('express');
const {
  queryDatabase, createPage, getPage, updatePage, archivePage,
  pageToTask, richText, dateOrNull, selectOrNull, logActivity
} = require('../notion');
const router = express.Router();

// List tasks
router.get('/', async (req, res) => {
  try {
    const { project_id, status, ai_agent, limit = 100 } = req.query;
    const filters = [];

    if (project_id) {
      filters.push({ property: 'Project', relation: { contains: project_id } });
    }
    if (status) {
      filters.push({ property: 'Status', select: { equals: status } });
    }
    if (ai_agent) {
      filters.push({ property: 'AI Agent', select: { equals: ai_agent } });
    }

    const filter = filters.length > 1 ? { and: filters }
      : filters.length === 1 ? filters[0] : undefined;

    const result = await queryDatabase('tasks', filter,
      [{ property: 'Created At', direction: 'ascending' }],
      Number(limit));

    const tasks = result.results.map(pageToTask);

    // Sort by priority: urgent > high > medium > low
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    tasks.sort((a, b) => (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3));

    res.json({ count: tasks.length, tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kanban view
router.get('/kanban', async (req, res) => {
  try {
    const { project_id } = req.query;
    const filter = project_id
      ? { property: 'Project', relation: { contains: project_id } }
      : undefined;

    const result = await queryDatabase('tasks', filter, undefined, 100);
    const tasks = result.results.map(pageToTask);

    const kanban = { todo: [], in_progress: [], review: [], done: [] };
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };

    for (const task of tasks) {
      const col = kanban[task.status] || kanban.todo;
      col.push(task);
    }

    // Sort each column by priority
    for (const col of Object.values(kanban)) {
      col.sort((a, b) => (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3));
    }

    res.json(kanban);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single task
router.get('/:id', async (req, res) => {
  try {
    const page = await getPage(req.params.id);
    if (page.archived) return res.status(404).json({ error: 'Not found' });
    res.json(pageToTask(page));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Create task
router.post('/', async (req, res) => {
  try {
    const { project_id, title, description, status, priority, ai_agent, next_steps } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const now = new Date().toISOString();
    const props = {
      Title: { title: richText(title) },
      Description: { rich_text: richText(description || '') },
      Status: { select: selectOrNull(status || 'todo') },
      Priority: { select: selectOrNull(priority || 'medium') },
      'AI Agent': { select: selectOrNull(ai_agent) },
      'Next Steps': { rich_text: richText(next_steps || '') },
      'Created At': { date: dateOrNull(now) },
      'Updated At': { date: dateOrNull(now) },
    };
    if (project_id) {
      props.Project = { relation: [{ id: project_id }] };
    }

    const page = await createPage('tasks', props);
    await logActivity('create', 'task', page.id, ai_agent, `Created task: ${title}`);
    res.status(201).json({ id: page.id, message: 'Task created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update task
router.put('/:id', async (req, res) => {
  try {
    const existing = await getPage(req.params.id);
    if (existing.archived) return res.status(404).json({ error: 'Not found' });
    const e = pageToTask(existing);

    const { project_id, title, description, status, priority, ai_agent, next_steps, output_log } = req.body;
    const props = { 'Updated At': { date: dateOrNull(new Date()) } };

    if (title) props.Title = { title: richText(title) };
    if (description !== undefined) props.Description = { rich_text: richText(description) };
    if (status) props.Status = { select: selectOrNull(status) };
    if (priority) props.Priority = { select: selectOrNull(priority) };
    if (ai_agent !== undefined) props['AI Agent'] = { select: selectOrNull(ai_agent) };
    if (next_steps !== undefined) props['Next Steps'] = { rich_text: richText(next_steps) };
    if (output_log !== undefined) props['Output Log'] = { rich_text: richText(output_log) };
    if (project_id !== undefined) {
      props.Project = project_id ? { relation: [{ id: project_id }] } : { relation: [] };
    }

    await updatePage(req.params.id, props);

    const statusChanged = status && status !== e.status;
    await logActivity('update', 'task', req.params.id, ai_agent || e.ai_agent,
      statusChanged ? `Task "${title || e.title}" moved to ${status}` : `Updated task: ${title || e.title}`);

    res.json({ message: 'Task updated' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Delete task
router.delete('/:id', async (req, res) => {
  try {
    await archivePage(req.params.id);
    res.json({ message: 'Task deleted' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
