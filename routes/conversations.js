const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// ─── ChatGPT export parser ─────────────────────────────────────
// Walks up from current_node to root, collecting messages in order
function extractChatGPTThread(mapping, currentNode) {
  const messages = [];
  let nodeId = currentNode;

  while (nodeId) {
    const node = mapping[nodeId];
    if (!node) break;

    const msg = node.message;
    if (msg && msg.author && msg.content) {
      const role = msg.author.role;
      const contentType = msg.content.content_type;

      // Skip system/tool messages and internal JSON tool calls
      if (role === 'system' || role === 'tool') { nodeId = node.parent; continue; }
      if (contentType === 'code') { nodeId = node.parent; continue; }
      // Skip assistant messages that are only routing to functions
      if (msg.recipient && msg.recipient !== 'all' && role === 'assistant') { nodeId = node.parent; continue; }

      let text = '';
      if (contentType === 'text' && Array.isArray(msg.content.parts)) {
        text = msg.content.parts.filter(p => typeof p === 'string').join('').trim();
      } else if (contentType === 'multimodal_text' && Array.isArray(msg.content.parts)) {
        const textParts = msg.content.parts.filter(p => typeof p === 'string');
        text = textParts.length ? textParts.join('').trim() : '[image attached]';
      }

      if (text) {
        messages.unshift({
          role,
          content: text,
          timestamp: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null
        });
      }
    }
    nodeId = node.parent;
  }

  return messages;
}

// ─── Bulk ChatGPT import ───────────────────────────────────────
router.post('/import/chatgpt', async (req, res) => {
  try {
    const conversations = Array.isArray(req.body) ? req.body : req.body.conversations;
    if (!Array.isArray(conversations)) return res.status(400).json({ error: 'Expected array of conversations' });

    let imported = 0, skipped = 0, errors = 0;

    for (const conv of conversations) {
      try {
        const chatgptId = conv.id || conv.conversation_id;
        if (!chatgptId) { errors++; continue; }

        // Deduplication check
        const existing = await query(
          `SELECT id FROM conversations WHERE ai_source = 'chatgpt' AND metadata->>'chatgpt_id' = $1`,
          [chatgptId]
        );
        if (existing.rows.length) { skipped++; continue; }

        const thread = extractChatGPTThread(conv.mapping || {}, conv.current_node);
        if (!thread.length) { skipped++; continue; }

        const title = (conv.title || 'Untitled').slice(0, 500);
        const firstUser = thread.find(m => m.role === 'user');
        const firstAsst = thread.find(m => m.role === 'assistant');
        const summary = [
          firstUser ? firstUser.content.slice(0, 300) : '',
          firstAsst ? '→ ' + firstAsst.content.slice(0, 300) : ''
        ].filter(Boolean).join(' ');

        const metadata = {
          chatgpt_id: chatgptId,
          model: conv.default_model_slug || 'unknown',
          origin: conv.conversation_origin || null,
          is_archived: conv.is_archived || false
        };

        const createdAt = conv.create_time
          ? new Date(conv.create_time * 1000).toISOString()
          : req.getNow();

        await query(
          `INSERT INTO conversations (title, ai_source, full_thread, summary, message_count, metadata, created_at, updated_at)
           VALUES ($1, 'chatgpt', $2::jsonb, $3, $4, $5::jsonb, $6, $6)`,
          [title, JSON.stringify(thread), summary || null, thread.length, JSON.stringify(metadata), createdAt]
        );

        imported++;
      } catch (err) {
        console.error('[chatgpt import] conversation error:', err.message);
        errors++;
      }
    }

    await logActivity('create', 'conversation', null, 'chatgpt',
      `ChatGPT bulk import: ${imported} imported, ${skipped} skipped, ${errors} errors`);

    res.json({ imported, skipped, errors, total: conversations.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { q, ai_source, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || coalesce(summary,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (ai_source) { where.push(`ai_source = $${i++}`); params.push(ai_source); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const result = await query(
      `SELECT id, title, ai_source, summary, tags, message_count, metadata, created_at, updated_at
       FROM conversations ${whereClause} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ count: result.rows.length, conversations: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, ai_source, full_thread, summary, tags, metadata } = req.body;
    if (!title || !ai_source) return res.status(400).json({ error: 'title and ai_source are required' });

    const thread = Array.isArray(full_thread) ? full_thread : [];
    const result = await query(
      `INSERT INTO conversations (title, ai_source, full_thread, summary, tags, message_count, metadata)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7::jsonb) RETURNING id`,
      [title, ai_source, JSON.stringify(thread), summary || null,
       JSON.stringify(tags || []), thread.length,
       JSON.stringify(metadata || {})]
    );

    await logActivity('create', 'conversation', result.rows[0].id, ai_source, `Stored conversation: ${title}`);
    res.status(201).json({ id: result.rows[0].id, message: 'Conversation stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, summary, tags, full_thread, metadata } = req.body;
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;

    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(title); }
    if (summary !== undefined) { sets.push(`summary = $${i++}`); params.push(summary); }
    if (tags !== undefined) { sets.push(`tags = $${i++}::jsonb`); params.push(JSON.stringify(tags)); }
    if (full_thread !== undefined) {
      sets.push(`full_thread = $${i++}::jsonb`);
      params.push(JSON.stringify(full_thread));
      sets.push(`message_count = $${i++}`);
      params.push(Array.isArray(full_thread) ? full_thread.length : 0);
    }
    if (metadata !== undefined) { sets.push(`metadata = $${i++}::jsonb`); params.push(JSON.stringify(metadata)); }

    params.push(req.params.id);
    const result = await query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Conversation updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM conversations WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
