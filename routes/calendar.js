// Calendar index routes.
//
// Mirrors routes/email.js: the brain holds pointers + summaries + embeddings,
// the source (Google Calendar via MCP) holds the truth.
//
//   GET  /api/calendar/events                list (filter by account, classification, range)
//   GET  /api/calendar/upcoming              shortcut: next N days
//   GET  /api/calendar/search?q=...          hybrid search (keyword + semantic)
//   GET  /api/calendar/events/:id            event metadata
//   GET  /api/calendar/events/:id/raw        live fetch of full event from MCP
//   POST /api/calendar/ingest                trigger ingestion (account, days, past)

const express = require('express');
const { query, logActivity } = require('../db');
const { McpClient } = require('../lib/mcp-client');
const router = express.Router();

const MCP_URL = process.env.MCP_GMAIL_URL || 'https://gmail-multi-mcp-production.up.railway.app/mcp';
const MCP_TOKEN = process.env.MCP_GMAIL_TOKEN || '';
const EMBEDDING_MODEL = process.env.CALENDAR_EMBEDDING_MODEL || process.env.EMAIL_EMBEDDING_MODEL || 'text-embedding-3-small';

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

// ─── GET /api/calendar/events ──────────────────────────────────────────────
router.get('/events', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const account = req.query.account || null;
    const classification = req.query.classification || null;
    const from = req.query.from || null;
    const to = req.query.to || null;

    const where = [];
    const params = [];
    if (account) { params.push(account); where.push(`account = $${params.length}`); }
    if (classification) { params.push(classification); where.push(`classification = $${params.length}`); }
    if (from) { params.push(from); where.push(`start_time >= $${params.length}`); }
    if (to) { params.push(to); where.push(`start_time <= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const sql = `
      SELECT id, provider, account, calendar_id, event_provider_id, title,
             location, start_time, end_time, all_day, status,
             organizer_email, organizer_name, attendees, attendee_count,
             classification, classifier_confidence, summary, entities, topics,
             ingested_at, updated_at
      FROM calendar_events
      ${whereSql}
      ORDER BY start_time ASC NULLS LAST
      LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const r = await query(sql, params);
    res.json({ count: r.rows.length, events: r.rows });
  } catch (err) {
    console.error('[calendar/events] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/calendar/upcoming ────────────────────────────────────────────
router.get('/upcoming', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 1, 90);
    const account = req.query.account || null;
    const minClass = req.query.min_class || null;

    const params = [];
    const where = [`start_time >= NOW()`, `start_time <= NOW() + ($${params.push(`${days} days`)})::interval`];
    if (account) { params.push(account); where.push(`account = $${params.length}`); }
    if (minClass === 'distill') where.push(`classification = 'distill'`);
    else if (minClass === 'index') where.push(`classification IN ('index','distill')`);

    const sql = `
      SELECT id, account, title, location, start_time, end_time, all_day,
             organizer_email, attendees, attendee_count,
             classification, summary, entities, topics
      FROM calendar_events
      WHERE ${where.join(' AND ')}
      ORDER BY start_time ASC
      LIMIT 200`;
    const r = await query(sql, params);
    res.json({ count: r.rows.length, events: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/calendar/search ──────────────────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    const limit = clampInt(req.query.limit, 20, 1, 200);
    const account = req.query.account || null;
    const minClass = req.query.min_class || null;

    // 1) keyword
    const kwParams = [q];
    let kwAccount = '';
    if (account) { kwParams.push(account); kwAccount = `AND account = $${kwParams.length}`; }
    let kwClass = '';
    if (minClass === 'distill') kwClass = `AND classification = 'distill'`;
    else if (minClass === 'index') kwClass = `AND classification IN ('index','distill')`;
    kwParams.push(limit);
    const kwSql = `
      SELECT id, ts_rank(search_vector, plainto_tsquery('english', $1)) AS score
      FROM calendar_events
      WHERE search_vector @@ plainto_tsquery('english', $1)
        ${kwAccount}
        ${kwClass}
      ORDER BY score DESC
      LIMIT $${kwParams.length}`;
    let keywordHits = [];
    try { keywordHits = (await query(kwSql, kwParams)).rows; }
    catch (err) { console.warn('[calendar/search] keyword failed:', err.message); }

    // 2) semantic
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
          FROM calendar_events
          WHERE embedding IS NOT NULL
            ${semAccount}
            ${semClass}
          ORDER BY embedding <=> $1::vector
          LIMIT $${semParams.length}`;
        semanticHits = (await query(semSql, semParams)).rows;
      }
    } catch (err) { console.warn('[calendar/search] semantic failed:', err.message); }

    // 3) RRF blend
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

    const ids = ranked.map(r => r.id);
    const r = await query(`
      SELECT id, account, calendar_id, event_provider_id, title, location,
             start_time, end_time, all_day, status,
             organizer_email, organizer_name, attendees, attendee_count,
             classification, classifier_confidence, summary, entities, topics
      FROM calendar_events
      WHERE id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(r.rows.map(row => [row.id, row]));
    const results = ranked.map(rk => ({ ...byId.get(rk.id), score: rk.score, matched_via: rk.sources }));
    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[calendar/search] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/calendar/events/:id ──────────────────────────────────────────
router.get('/events/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM calendar_events WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'event not found' });
    const ev = r.rows[0];
    delete ev.embedding;
    res.json({ event: ev });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/calendar/events/:id/raw ──────────────────────────────────────
// Live fetch of full event from MCP.
router.get('/events/:id/raw', async (req, res) => {
  let mcp;
  try {
    const r = await query(
      `SELECT account, calendar_id, event_provider_id FROM calendar_events WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'event not found' });
    const { account, calendar_id, event_provider_id } = r.rows[0];

    mcp = newMcp();
    await mcp.initialize();
    const { tools } = await mcp.listTools();
    const get = tools.find(t => /gcal_get_event|get_event|calendar_get_event/i.test(t.name));
    if (!get) return res.status(503).json({ error: 'no gcal_get_event tool found', tools: tools.map(t => t.name) });

    const props = get.inputSchema?.properties || {};
    const args = {};
    if ('eventId' in props) args.eventId = event_provider_id;
    else if ('id' in props) args.id = event_provider_id;
    else args.eventId = event_provider_id;
    if ('calendarId' in props) args.calendarId = calendar_id || 'primary';
    else if ('calendar_id' in props) args.calendar_id = calendar_id || 'primary';
    if ('account' in props) args.account = account;
    else if ('userId' in props) args.userId = account;
    else if ('email' in props) args.email = account;

    const result = await mcp.callTool(get.name, args);
    res.json({ source: get.name, account, calendar_id, event_provider_id, result });
  } catch (err) {
    console.error('[calendar/raw] error:', err.message);
    res.status(502).json({ error: err.message });
  } finally {
    if (mcp) await mcp.close().catch(() => {});
  }
});

// ─── POST /api/calendar/ingest ─────────────────────────────────────────────
router.post('/ingest', async (req, res) => {
  try {
    const { account, days = 14, past = 7, limit = 500, calendar = null, dry_run = false } = req.body || {};
    if (!account) return res.status(400).json({ error: 'account is required' });
    const { ingest } = require('../scripts/calendar-ingest');
    const result = await ingest({
      account,
      days: Number(days), past: Number(past), limit: Number(limit),
      calendarId: calendar, dryRun: !!dry_run,
    });
    await logActivity('ingest', 'calendar', account, 'api', `Calendar ingest via API: ${result.events} events`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[calendar/ingest] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
