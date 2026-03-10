const express = require('express');
const {
  queryDatabase, createPage, getPage, updatePage, archivePage,
  pageToProject, pageToTask, richText, dateOrNull, selectOrNull, logActivity
} = require('../notion');
const router = express.Router();

// List projects
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status
      ? { property: 'Status', select: { equals: status } }
      : undefined;

    const result = await queryDatabase('projects', filter,
      [{ property: 'Updated At', direction: 'descending' }]);

    const projects = result.results.map(pageToProject);

    // Get task counts per project
    for (const project of projects) {
      try {
        const tasksResult = await queryDatabase('tasks',
          { property: 'Project', relation: { contains: project.id } },
          undefined, 100);
        const tasks = tasksResult.results.map(pageToTask);
        project.task_counts = {
          todo: tasks.filter(t => t.status === 'todo').length,
          in_progress: tasks.filter(t => t.status === 'in_progress').length,
          review: tasks.filter(t => t.status === 'review').length,
          done: tasks.filter(t => t.status === 'done').length,
        };
      } catch {
        project.task_counts = { todo: 0, in_progress: 0, review: 0, done: 0 };
      }
    }

    res.json({ count: projects.length, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single project with tasks
router.get('/:id', async (req, res) => {
  try {
    const page = await getPage(req.params.id);
    if (page.archived) return res.status(404).json({ error: 'Not found' });
    const project = pageToProject(page);

    const tasksResult = await queryDatabase('tasks',
      { property: 'Project', relation: { contains: req.params.id } },
      [{ property: 'Created At', direction: 'ascending' }], 100);

    project.tasks = tasksResult.results.map(pageToTask);
    res.json(project);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Create project
router.post('/', async (req, res) => {
  try {
    const { name, description, status } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const now = new Date().toISOString();
    const page = await createPage('projects', {
      Name: { title: richText(name) },
      Description: { rich_text: richText(description || '') },
      Status: { select: selectOrNull(status || 'active') },
      'Created At': { date: dateOrNull(now) },
      'Updated At': { date: dateOrNull(now) },
    });

    await logActivity('create', 'project', page.id, null, `Created project: ${name}`);
    res.status(201).json({ id: page.id, message: 'Project created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update project
router.put('/:id', async (req, res) => {
  try {
    const existing = await getPage(req.params.id);
    if (existing.archived) return res.status(404).json({ error: 'Not found' });

    const { name, description, status } = req.body;
    const props = { 'Updated At': { date: dateOrNull(new Date()) } };
    if (name) props.Name = { title: richText(name) };
    if (description !== undefined) props.Description = { rich_text: richText(description) };
    if (status) props.Status = { select: selectOrNull(status) };

    await updatePage(req.params.id, props);
    res.json({ message: 'Project updated' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Delete project
router.delete('/:id', async (req, res) => {
  try {
    await archivePage(req.params.id);
    res.json({ message: 'Project deleted' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
