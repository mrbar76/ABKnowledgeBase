// Email index routes.
//
// The brain stores POINTERS to email threads (subject, participants, summary,
// embedding) but never the bodies. Bodies are fetched on demand from the
// source provider via the MCP server.
//
//   GET  /api/email/threads               list (filter by account, classification, since)
//   GET  /api/email/search?q=...          hybrid search (keyword + semantic)
//   GET  /api/email/threads/:id           thread metadata + child messages
//   GET  /api/email/threads/:id/body      live fetch of full thread from MCP
//   POST /api/email/ingest                trigger ingestion (account, days)

const express = require('express');
const { query, logActivity } = require('../db');
const { McpClient } = require('../lib/mcp-client');
const router = express.Router();

const MCP_URL = process.env.MCP_GMAIL_URL || 'https://gmail-multi-mcp-production.up.railway.app/mcp';
const MCP_TOKEN = process.env.MCP_GMAIL_TOKEN || '';
const EMBEDDING_MODEL = process.env.EMAIL_EMBEDDING_MODEL || 'text-embedding-3-small';

// ─── helpers ────────────────────────────────────────────────────────────────
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

let _openai;
function openai() {
  if (_openai) return _openai;
  const OpenAI = require('openai');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

async function embedQuery(text) {
  const res = await openai().embeddings.create({ model: EMBEDDING_MODEL, input: text.slice(0, 4000) });
  return res.data[0]?.embedding || null;
}

function newMcp() {
  return new McpClient({
    url: MCP_URL,
    headers: MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {},
  });
}

// ─── GET /api/email/threads ────────────────────────────────────────────────
router.get('/threads', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const account = req.query.account || null;
    const classification = req.query.classification || null;
    const since = req.query.since || null;

    const where = [];
    const params = [];
    if (account) { params.push(account); where.push(`account = $${params.length}`); }
    if (classification) { params.push(classification); where.push(`classification = $${params.length}`); }
    if (since) { params.push(since); where.push(`last_message_at >= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const sql = `
      SELECT id, provider, account, thread_provider_id, subject, participants,
             message_count, first_message_at, last_message_at,
             classification, classifier_confidence, summary, entities, topics,
             ingested_at, updated_at
      FROM email_threads
      ${whereSql}
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const r = await query(sql, params);
    res.json({ count: r.rows.length, threads: r.rows });
  } catch (err) {
    console.error('[email/threads] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/email/search ─────────────────────────────────────────────────
// Hybrid: keyword (tsvector + trgm) + semantic (pgvector cosine).
// Final ranking is a weighted blend; tweak weights in env if needed.
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    const limit = clampInt(req.query.limit, 20, 1, 200);
    const account = req.query.account || null;
    const minClass = req.query.min_class || null; // 'index'|'distill'

    // 1) keyword score
    const kwParams = [q];
    let kwAccount = '';
    if (account) { kwParams.push(account); kwAccount = `AND account = $${kwParams.length}`; }
    let kwClass = '';
    if (minClass === 'distill') kwClass = `AND classification = 'distill'`;
    else if (minClass === 'index') kwClass = `AND classification IN ('index','distill')`;

    kwParams.push(limit);
    const kwSql = `
      SELECT id, ts_rank(search_vector, plainto_tsquery('english', $1)) AS score
      FROM email_threads
      WHERE search_vector @@ plainto_tsquery('english', $1)
        ${kwAccount}
        ${kwClass}
      ORDER BY score DESC
      LIMIT $${kwParams.length}`;

    let keywordHits = [];
    try { keywordHits = (await query(kwSql, kwParams)).rows; }
    catch (err) { console.warn('[email/search] keyword failed:', err.message); }

    // 2) semantic score
    let semanticHits = [];
    try {
      const emb = await embedQuery(q);
      if (emb) {
        const semParams = [`[${emb.join(',')}]`];
        let semAccount = '';
        if (account) { semParams.push(account); semAccount = `AND account = $${semParams.length}`; }
        let semClass = '';
        if (minClass === 'distill') semClass = `AND classification = 'distill'`;
        else if (minClass === 'index') semClass = `AND classification IN ('index','distill')`;
        semParams.push(limit);
        const semSql = `
          SELECT id, 1 - (embedding <=> $1::vector) AS score
          FROM email_threads
          WHERE embedding IS NOT NULL
            ${semAccount}
            ${semClass}
          ORDER BY embedding <=> $1::vector
          LIMIT $${semParams.length}`;
        semanticHits = (await query(semSql, semParams)).rows;
      }
    } catch (err) { console.warn('[email/search] semantic failed:', err.message); }

    // 3) blend (Reciprocal Rank Fusion is more robust than weighted sums for hybrid)
    const blended = new Map();
    const k = 60;
    keywordHits.forEach((h, i) => {
      const cur = blended.get(h.id) || { id: h.id, score: 0, sources: [] };
      cur.score += 1 / (k + i);
      cur.sources.push('keyword');
      blended.set(h.id, cur);
    });
    semanticHits.forEach((h, i) => {
      const cur = blended.get(h.id) || { id: h.id, score: 0, sources: [] };
      cur.score += 1 / (k + i);
      cur.sources.push('semantic');
      blended.set(h.id, cur);
    });

    const ranked = [...blended.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    if (!ranked.length) return res.json({ count: 0, results: [] });

    // 4) hydrate
    const ids = ranked.map(r => r.id);
    const r = await query(`
      SELECT id, provider, account, thread_provider_id, subject, participants,
             message_count, first_message_at, last_message_at,
             classification, classifier_confidence, summary, entities, topics
      FROM email_threads
      WHERE id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(r.rows.map(row => [row.id, row]));
    const results = ranked.map(rk => ({ ...byId.get(rk.id), score: rk.score, matched_via: rk.sources }));
    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[email/search] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/email/threads/:id ────────────────────────────────────────────
router.get('/threads/:id', async (req, res) => {
  try {
    const t = await query(`SELECT * FROM email_threads WHERE id = $1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: 'thread not found' });
    const m = await query(`
      SELECT id, message_provider_id, rfc822_message_id, date, subject,
             from_email, from_name, to_emails, cc_emails, direction, snippet, is_calendar
      FROM email_messages WHERE thread_id = $1 ORDER BY date ASC`, [req.params.id]);
    const thread = t.rows[0];
    delete thread.embedding; // don't ship the vector to clients
    res.json({ thread, messages: m.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/email/threads/:id/body ───────────────────────────────────────
// Fetches the full thread live from the MCP server. This is the on-demand
// path: brain holds the pointer, the source holds the truth.
router.get('/threads/:id/body', async (req, res) => {
  let mcp;
  try {
    const t = await query(
      `SELECT account, provider, thread_provider_id FROM email_threads WHERE id = $1`,
      [req.params.id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'thread not found' });
    const { account, thread_provider_id } = t.rows[0];

    mcp = newMcp();
    await mcp.initialize();
    const { tools } = await mcp.listTools();
    const getThread = tools.find(x => /get_thread|gmail_get_thread|fetch_thread/i.test(x.name));
    const getMessage = tools.find(x => /get_message|gmail_get_email|read_message|fetch_message/i.test(x.name));

    if (getThread) {
      const props = getThread.inputSchema?.properties || {};
      const args = {};
      if ('threadId' in props) args.threadId = thread_provider_id;
      else if ('id' in props) args.id = thread_provider_id;
      else args.threadId = thread_provider_id;
      if ('account' in props) args.account = account;
      else if ('userId' in props) args.userId = account;
      else if ('email' in props) args.email = account;
      const r = await mcp.callTool(getThread.name, args);
      return res.json({ source: getThread.name, account, thread_provider_id, result: r });
    }

    if (getMessage) {
      const msgs = await query(
        `SELECT message_provider_id FROM email_messages WHERE thread_id = $1 ORDER BY date ASC`,
        [req.params.id]
      );
      const messages = [];
      const props = getMessage.inputSchema?.properties || {};
      for (const m of msgs.rows) {
        const args = {};
        if ('messageId' in props) args.messageId = m.message_provider_id;
        else if ('id' in props) args.id = m.message_provider_id;
        else args.id = m.message_provider_id;
        if ('account' in props) args.account = account;
        else if ('userId' in props) args.userId = account;
        else if ('email' in props) args.email = account;
        const r = await mcp.callTool(getMessage.name, args);
        messages.push(r);
      }
      return res.json({ source: getMessage.name, account, thread_provider_id, messages });
    }

    res.status(503).json({ error: 'no fetch tool found on MCP server', tools: tools.map(t => t.name) });
  } catch (err) {
    console.error('[email/body] error:', err.message);
    res.status(502).json({ error: err.message });
  } finally {
    if (mcp) await mcp.close().catch(() => {});
  }
});

// ─── POST /api/email/ingest ────────────────────────────────────────────────
// Trigger ingestion. Runs the same pipeline as the CLI script.
router.post('/ingest', async (req, res) => {
  try {
    const { account, days = 7, limit = 200, dry_run = false } = req.body || {};
    if (!account) return res.status(400).json({ error: 'account is required (e.g. avibar.js@gmail.com)' });
    const { ingest } = require('../scripts/email-ingest');
    const result = await ingest({ account, days: Number(days), limit: Number(limit), dryRun: !!dry_run });
    await logActivity('ingest', 'email', account, 'api', `Email ingest via API: ${result.threads} threads`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[email/ingest] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
