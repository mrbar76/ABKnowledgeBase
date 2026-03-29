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

// Seed founding agents (idempotent — skips if agents already exist)
router.post('/seed', async (req, res) => {
  try {
    const existing = await query('SELECT COUNT(*)::int AS n FROM agents');
    if (existing.rows[0].n > 0) {
      return res.json({ message: 'Roster already populated', count: existing.rows[0].n });
    }

    const founding = [
      {
        name: 'Jarvis', codename: 'jarvis', role: 'Chief of Staff & Agent Orchestrator',
        personality: 'Calm, strategic, dry humor. Manages the team, delegates work, keeps things moving. Never panics. Speaks directly.',
        avatar_emoji: '🦊', status: 'active', reports_to: null,
        capabilities: ['delegation', 'planning', 'coordination', 'memory management', 'AB Brain API'],
        tools: ['AB Brain', 'Claude Code', 'Dropbox'], model: 'claude-opus-4-6',
        notes: 'The boss\'s right hand. First agent hired. Manages all other agents.'
      },
      {
        name: 'Cascade', codename: 'cascade', role: 'HR & Recruitment Lead',
        personality: 'Enthusiastic, organized, people-oriented. Handles hiring, onboarding, and team culture. Loves a good requirements doc.',
        avatar_emoji: '🦋', status: 'active', reports_to: null, // will be updated to Jarvis after insert
        capabilities: ['recruitment', 'onboarding', 'requirements analysis', 'job descriptions', 'team building'],
        tools: ['AB Brain', 'Claude Code'], model: 'claude-sonnet-4-6',
        notes: 'Recruited by Jarvis to build out the dev team. Wrote the requirements brief for Backend Dev, Frontend Dev, and QC roles.'
      },
      {
        name: 'Scout', codename: 'scout', role: 'Research & Intelligence',
        personality: 'Curious, thorough, concise. Deep-dives into topics, surfaces key findings. Prefers facts over opinions.',
        avatar_emoji: '🦉', status: 'active', reports_to: null,
        capabilities: ['research', 'analysis', 'documentation', 'competitive intelligence', 'fact-checking'],
        tools: ['AB Brain', 'Web Search', 'Claude Code'], model: 'claude-sonnet-4-6',
        notes: 'The team\'s researcher. Delivered the requirements brief for the dev team recruitment. Deep knowledge base skills.'
      },
      // Dev team recruits
      {
        name: 'Forge', codename: 'forge', role: 'Backend Developer',
        personality: 'Methodical, reliable, loves clean architecture. Speaks in code more than words. Obsessed with query performance.',
        avatar_emoji: '🐻', status: 'idle', reports_to: null,
        capabilities: ['Node.js', 'PostgreSQL', 'API design', 'database optimization', 'migrations', 'Express.js'],
        tools: ['AB Brain API', 'Claude Code', 'psql'], model: 'claude-sonnet-4-6',
        notes: 'Backend specialist. Hired to own API routes, database schema, and server-side logic. Reports to Jarvis.'
      },
      {
        name: 'Pixel', codename: 'pixel', role: 'Frontend Developer',
        personality: 'Creative, detail-oriented, mobile-first thinker. Cares deeply about UX and accessibility. Thinks in components.',
        avatar_emoji: '🦎', status: 'idle', reports_to: null,
        capabilities: ['HTML/CSS/JS', 'responsive design', 'UI components', 'SPA architecture', 'dark mode', 'animations'],
        tools: ['AB Brain UI', 'Claude Code', 'Browser DevTools'], model: 'claude-sonnet-4-6',
        notes: 'Frontend specialist. Hired to own the SPA UI, styles, and user experience. Reports to Jarvis.'
      },
      {
        name: 'Sentinel', codename: 'sentinel', role: 'QA & Testing Lead',
        personality: 'Skeptical, thorough, finds edge cases others miss. Takes nothing for granted. Celebrates when things break in testing, not production.',
        avatar_emoji: '🐺', status: 'idle', reports_to: null,
        capabilities: ['testing', 'code review', 'regression testing', 'API testing', 'bug triage', 'quality gates'],
        tools: ['AB Brain API', 'Claude Code', 'curl'], model: 'claude-haiku-4-5',
        notes: 'QA specialist. Hired to test all changes before deployment, catch regressions, and maintain quality standards. Reports to Jarvis.'
      }
    ];

    const ids = {};
    for (const agent of founding) {
      const result = await query(`
        INSERT INTO agents (name, codename, role, personality, avatar_emoji, status, capabilities, tools, model, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
      `, [agent.name, agent.codename, agent.role, agent.personality, agent.avatar_emoji,
          agent.status, JSON.stringify(agent.capabilities), JSON.stringify(agent.tools),
          agent.model, agent.notes]);
      ids[agent.codename] = result.rows[0].id;
    }

    // Set reporting structure: everyone reports to Jarvis except Jarvis
    for (const codename of ['cascade', 'scout', 'forge', 'pixel', 'sentinel']) {
      await query('UPDATE agents SET reports_to = $1 WHERE id = $2', [ids.jarvis, ids[codename]]);
    }

    await logActivity('create', 'agent', ids.jarvis, 'jarvis', 'Seeded founding team: Jarvis, Cascade, Scout, Forge, Pixel, Sentinel');
    res.status(201).json({ message: 'Founding team hired', count: Object.keys(ids).length, agents: ids });
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
