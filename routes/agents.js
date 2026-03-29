const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// List all agents (with optional status filter)
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { where = 'WHERE a.status = $1'; params.push(status); }

    const result = await query(`
      SELECT a.*,
        m.name AS manager_name,
        m.codename AS manager_codename,
        (SELECT COUNT(*)::int FROM tasks t WHERE t.ai_agent = a.codename AND t.status IN ('todo','in_progress','review','waiting_on')) AS active_tasks,
        (SELECT COUNT(*)::int FROM tasks t WHERE t.ai_agent = a.codename AND t.status = 'done') AS completed_tasks
      FROM agents a
      LEFT JOIN agents m ON a.reports_to = m.id
      ${where}
      ORDER BY CASE a.status WHEN 'busy' THEN 0 WHEN 'active' THEN 1 WHEN 'idle' THEN 2 WHEN 'offline' THEN 3 WHEN 'retired' THEN 4 END,
        a.name ASC
    `, params);
    res.json({ count: result.rows.length, agents: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Org chart — hierarchical view (must be before /:id)
router.get('/org/chart', async (req, res) => {
  try {
    const result = await query(`
      SELECT a.id, a.name, a.codename, a.role, a.avatar_emoji, a.status, a.reports_to,
        (SELECT COUNT(*)::int FROM tasks t WHERE t.ai_agent = a.codename AND t.status IN ('todo','in_progress','review','waiting_on')) AS active_tasks
      FROM agents a
      WHERE a.status != 'retired'
      ORDER BY a.name
    `);
    const agents = result.rows;
    const roots = agents.filter(a => !a.reports_to);
    function buildTree(parent) {
      const children = agents.filter(a => a.reports_to === parent.id);
      return { ...parent, reports: children.map(buildTree) };
    }
    const tree = roots.map(buildTree);
    const allIds = new Set(agents.map(a => a.id));
    const orphans = agents.filter(a => a.reports_to && !allIds.has(a.reports_to));
    res.json({ tree, orphans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single agent with their assigned tasks
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT a.*,
        m.name AS manager_name, m.codename AS manager_codename
      FROM agents a
      LEFT JOIN agents m ON a.reports_to = m.id
      WHERE a.id = $1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Agent not found' });

    const tasks = await query(`
      SELECT id, title, status, priority, due_date, waiting_on
      FROM tasks
      WHERE ai_agent = $1
      ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 WHEN 'waiting_on' THEN 3 WHEN 'done' THEN 4 END,
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END
      LIMIT 50
    `, [result.rows[0].codename]);

    const activity = await query(`
      SELECT action, details, created_at FROM activity_log
      WHERE ai_source = $1
      ORDER BY created_at DESC LIMIT 20
    `, [result.rows[0].codename]);

    res.json({ ...result.rows[0], tasks: tasks.rows, activity: activity.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create agent
router.post('/', async (req, res) => {
  try {
    const { name, codename, role, personality, avatar_url, avatar_emoji, status, reports_to, capabilities, tools, model, notes } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'name and role are required' });

    const result = await query(`
      INSERT INTO agents (name, codename, role, personality, avatar_url, avatar_emoji, status, reports_to, capabilities, tools, model, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id
    `, [
      name, codename || null, role, personality || null,
      avatar_url || null, avatar_emoji || '🤖',
      status || 'active', reports_to || null,
      JSON.stringify(capabilities || []), JSON.stringify(tools || []),
      model || null, notes || null
    ]);

    await logActivity('create', 'agent', result.rows[0].id, 'jarvis', `Hired agent: ${name} (${role})`);
    res.status(201).json({ id: result.rows[0].id, message: 'Agent created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update agent
router.put('/:id', async (req, res) => {
  try {
    const { name, codename, role, personality, avatar_url, avatar_emoji, status, reports_to, capabilities, tools, model, notes, metadata } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;

    if (name !== undefined) { sets.push(`name = $${i++}`); params.push(name); }
    if (codename !== undefined) { sets.push(`codename = $${i++}`); params.push(codename); }
    if (role !== undefined) { sets.push(`role = $${i++}`); params.push(role); }
    if (personality !== undefined) { sets.push(`personality = $${i++}`); params.push(personality); }
    if (avatar_url !== undefined) { sets.push(`avatar_url = $${i++}`); params.push(avatar_url); }
    if (avatar_emoji !== undefined) { sets.push(`avatar_emoji = $${i++}`); params.push(avatar_emoji); }
    if (status !== undefined) { sets.push(`status = $${i++}`); params.push(status); }
    if (reports_to !== undefined) { sets.push(`reports_to = $${i++}`); params.push(reports_to || null); }
    if (capabilities !== undefined) { sets.push(`capabilities = $${i++}::jsonb`); params.push(JSON.stringify(capabilities)); }
    if (tools !== undefined) { sets.push(`tools = $${i++}::jsonb`); params.push(JSON.stringify(tools)); }
    if (model !== undefined) { sets.push(`model = $${i++}`); params.push(model); }
    if (notes !== undefined) { sets.push(`notes = $${i++}`); params.push(notes); }
    if (metadata !== undefined) { sets.push(`metadata = $${i++}::jsonb`); params.push(JSON.stringify(metadata)); }

    // Update last_active_at when status changes to busy/active
    if (status === 'busy' || status === 'active') {
      sets.push('last_active_at = NOW()');
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, name, status`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agent not found' });

    const row = result.rows[0];
    if (status) {
      await logActivity('update', 'agent', req.params.id, 'jarvis', `Agent "${row.name}" status → ${status}`);
    }
    res.json({ message: 'Agent updated', agent: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete agent
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM agents WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Agent not found' });
    await logActivity('delete', 'agent', req.params.id, 'jarvis', `Agent "${result.rows[0].name}" removed`);
    res.json({ message: 'Agent deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
