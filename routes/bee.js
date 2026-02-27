const express = require('express');
const { query } = require('../db');
const router = express.Router();

// Import Bee sync data (from bee sync markdown export)
// POST /api/bee/import
// Body: { facts: [...], todos: [...], conversations: [...] }
router.post('/import', async (req, res) => {
  try {
    const { facts, todos, conversations } = req.body;
    const results = { facts: 0, todos: 0, conversations: 0, skipped: 0 };

    // --- Import Facts ---
    if (Array.isArray(facts)) {
      for (const fact of facts) {
        if (!fact.text) continue;
        const beeId = fact.id || fact.text.substring(0, 80);

        // Deduplicate by checking content
        const existing = await query(
          `SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`,
          [`%${fact.text.substring(0, 100)}%`]
        );

        if (existing.rows.length > 0) {
          results.skipped++;
          continue;
        }

        const title = `Bee Fact: ${fact.text.substring(0, 80)}`;
        await query(`
          INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
          VALUES ($1, $2, 'personal', $3, 'bee', 'bee', $4)
        `, [
          title,
          fact.text,
          JSON.stringify(fact.tags || ['bee', 'fact']),
          JSON.stringify({ bee_id: beeId, confirmed: fact.confirmed || false })
        ]);
        results.facts++;
      }
    }

    // --- Import Todos as Tasks ---
    if (Array.isArray(todos)) {
      for (const todo of todos) {
        if (!todo.text) continue;

        // Deduplicate
        const existing = await query(
          `SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`,
          [todo.text]
        );

        if (existing.rows.length > 0) {
          results.skipped++;
          continue;
        }

        const status = todo.completed ? 'done' : 'todo';
        await query(`
          INSERT INTO tasks (title, status, priority, ai_agent, next_steps)
          VALUES ($1, $2, 'medium', 'bee', $3)
        `, [
          todo.text,
          status,
          todo.id ? `Bee Todo ID: ${todo.id}` : null
        ]);
        results.todos++;
      }
    }

    // --- Import Conversations as Transcripts ---
    if (Array.isArray(conversations)) {
      for (const convo of conversations) {
        if (!convo.text && !convo.raw_text) continue;
        const rawText = convo.raw_text || convo.text;
        const title = convo.title || `Bee Conversation ${convo.date || new Date().toLocaleDateString()}`;

        // Deduplicate by title + source
        const existing = await query(
          `SELECT id FROM transcripts WHERE title = $1 AND source = 'bee'`,
          [title]
        );

        if (existing.rows.length > 0) {
          results.skipped++;
          continue;
        }

        const result = await query(`
          INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata)
          VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7, $8)
          RETURNING id
        `, [
          title,
          rawText,
          convo.summary || null,
          JSON.stringify(convo.speakers || []),
          convo.duration_seconds || null,
          convo.date || convo.recorded_at || null,
          JSON.stringify(convo.tags || ['bee', 'conversation']),
          JSON.stringify({ bee_id: convo.id || null })
        ]);

        // Also add to knowledge for searchability
        await query(`
          INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
          VALUES ($1, $2, 'meeting', $3, 'bee', 'bee', $4)
        `, [
          title,
          (convo.summary || rawText).substring(0, 5000),
          JSON.stringify(convo.tags || ['bee', 'conversation']),
          JSON.stringify({ transcript_id: result.rows[0].id, bee_id: convo.id || null })
        ]);

        results.conversations++;
      }
    }

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('create', 'bee-import', 'bulk', 'bee', $1)
    `, [`Bee import: ${results.facts} facts, ${results.todos} todos, ${results.conversations} conversations (${results.skipped} skipped/duplicates)`]);

    res.json({
      message: 'Bee data imported successfully',
      imported: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import from raw bee sync markdown files
// POST /api/bee/import-markdown
// Body: { facts_md: "...", todos_md: "...", conversations: [{ title, markdown }] }
router.post('/import-markdown', async (req, res) => {
  try {
    const { facts_md, todos_md, conversations } = req.body;
    const results = { facts: 0, todos: 0, conversations: 0, skipped: 0 };

    // Parse facts.md
    if (facts_md) {
      const factLines = facts_md.split('\n').filter(l => l.startsWith('- '));
      for (const line of factLines) {
        const text = line.replace(/^- /, '').trim();
        if (!text) continue;

        const existing = await query(
          `SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`,
          [`%${text.substring(0, 100)}%`]
        );
        if (existing.rows.length > 0) { results.skipped++; continue; }

        await query(`
          INSERT INTO knowledge (title, content, category, tags, source, ai_source)
          VALUES ($1, $2, 'personal', '["bee","fact"]', 'bee', 'bee')
        `, [`Bee Fact: ${text.substring(0, 80)}`, text]);
        results.facts++;
      }
    }

    // Parse todos.md
    if (todos_md) {
      const todoLines = todos_md.split('\n').filter(l => /^- \[[ x]\]/.test(l));
      for (const line of todoLines) {
        const completed = line.includes('[x]');
        const text = line.replace(/^- \[[ x]\] /, '').trim();
        if (!text) continue;

        const existing = await query(
          `SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`,
          [text]
        );
        if (existing.rows.length > 0) { results.skipped++; continue; }

        await query(`
          INSERT INTO tasks (title, status, priority, ai_agent)
          VALUES ($1, $2, 'medium', 'bee')
        `, [text, completed ? 'done' : 'todo']);
        results.todos++;
      }
    }

    // Import conversation markdown files
    if (Array.isArray(conversations)) {
      for (const convo of conversations) {
        if (!convo.markdown) continue;
        const title = convo.title || convo.filename || `Bee Conversation`;

        const existing = await query(
          `SELECT id FROM transcripts WHERE title = $1 AND source = 'bee'`,
          [title]
        );
        if (existing.rows.length > 0) { results.skipped++; continue; }

        // Extract date from title or filename
        const dateMatch = (convo.title || convo.filename || '').match(/(\d{4}-\d{2}-\d{2})/);
        const recordedAt = dateMatch ? dateMatch[1] : null;

        const result = await query(`
          INSERT INTO transcripts (title, raw_text, source, recorded_at, tags)
          VALUES ($1, $2, 'bee', $3, '["bee","conversation"]')
          RETURNING id
        `, [title, convo.markdown, recordedAt]);

        await query(`
          INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
          VALUES ($1, $2, 'meeting', '["bee","conversation"]', 'bee', 'bee', $3)
        `, [title, convo.markdown.substring(0, 5000), JSON.stringify({ transcript_id: result.rows[0].id })]);

        results.conversations++;
      }
    }

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('create', 'bee-import', 'bulk', 'bee', $1)
    `, [`Bee markdown import: ${results.facts} facts, ${results.todos} todos, ${results.conversations} conversations (${results.skipped} skipped)`]);

    res.json({ message: 'Bee markdown imported', imported: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Bee sync status
router.get('/status', async (req, res) => {
  try {
    const facts = await query(`SELECT COUNT(*) as count FROM knowledge WHERE ai_source = 'bee'`);
    const tasks = await query(`SELECT COUNT(*) as count FROM tasks WHERE ai_agent = 'bee'`);
    const transcripts = await query(`SELECT COUNT(*) as count FROM transcripts WHERE source = 'bee'`);
    const lastImport = await query(`SELECT created_at FROM activity_log WHERE entity_type = 'bee-import' ORDER BY created_at DESC LIMIT 1`);

    res.json({
      facts: Number(facts.rows[0].count),
      tasks: Number(tasks.rows[0].count),
      transcripts: Number(transcripts.rows[0].count),
      last_import: lastImport.rows[0]?.created_at || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
