const express = require('express');
const https = require('https');
const { query } = require('../db');
const router = express.Router();

// --- Bee Cloud API (Amazon-hosted) ---
// Bee was acquired by Amazon; the API lives at an Amazon dev domain
// and requires a private CA certificate for TLS.
const BEE_API = 'https://app-api-developer.ce.bee.amazon.dev';

// Bee's production root CA — required because the API uses a private CA, not a public one
const BEE_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDfzCCAmegAwIBAgIRANp9rGecKAk6t6XGd3GWVHkwDQYJKoZIhvcNAQELBQAw
WTELMAkGA1UEBhMCVVMxDDAKBgNVBAoMA0JlZTEaMBgGA1UECwwRVHJ1c3QgYW5k
IFByaXZhY3kxIDAeBgNVBAMMF0JlZUNlcnRpZmljYXRlQXV0aG9yaXR5MB4XDTI1
MDgyMTE5MjUyNloXDTM1MDgyMTIwMjUyNlowWTELMAkGA1UEBhMCVVMxDDAKBgNV
BAoMA0JlZTEaMBgGA1UECwwRVHJ1c3QgYW5kIFByaXZhY3kxIDAeBgNVBAMMF0Jl
ZUNlcnRpZmljYXRlQXV0aG9yaXR5MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEA7a4dWfEBlstJGQWx2MG9fInEWw4v5e2Sasiw8D09fW77VbSskLEectYl
t8XgM8a2O9JAPkCQ3vNJmIO+6etyPj/DEtjwllSPR5/1qcZXGFMbjRGzmDz2Y6Mr
uPlrGYZZQgSNrnuSSndADCrqSEGLdBzkjXqkuXLXDqdLLTzseNQVfCiN2LDCwFRD
Ugjw4KuiJzSBZ1CQEdug4qauitcif6NOFEiTViAOkXjSmjAdTjN0GDKQdTmDtQYg
NfLuhhfmEB9mdiEm3++AUURQ2Cn+MfP2YAy/5gr3t+ydPRx361mbA1UiWnx7lmLU
xRmZhzeaDmO8vUxxM1jHSXLNxMPMUwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBRAKKN5ASGNfQOKcsdpaFwNki78xzAOBgNVHQ8BAf8EBAMCAYYw
DQYJKoZIhvcNAQELBQADggEBADXy/YcenRwuAbCH57sFcwe/akWsdh7bs9ZNb7dq
g6qzDpitO8yhpEK1DSW2Nmbtxd59rhV5jmnAfFHLEoeOlsSeBLADH3/3uRLV1kIR
M3kUPKOv1FJq7UkK2VzgabpehyeJ4lfozfT983b3AoDvI6quf3Dl2NrCmmUUewrZ
6g+RSR6n6Q/PalGUPtoV+W4OT5j9hS1d0PSNO6QbRRFzW+NZ+aQdLwHQPzwjofSh
vM1JjV7Hz2KOPJwmqHQbCiaayGq5lZIVI3UrqnTIqB/hySEBIJNeyHN3ggORH2JJ
wzMF+xiaNYUCir9ZzsgYiEsuaxEyiS96ydDImWJboALiWmE=
-----END CERTIFICATE-----`;

const beeAgent = new https.Agent({ ca: BEE_CA_CERT });

function beeApiGet(path, beeToken, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BEE_API);
    const req = https.get(url, {
      agent: beeAgent,
      headers: { 'Authorization': `Bearer ${beeToken}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 5 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Response too large (>5MB), skipping'));
        }
      });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid Bee token — run "bee login" on your Mac and copy ~/.bee/token-prod'));
        if (res.statusCode !== 200) return reject(new Error(`Bee API ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Bee API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Bee API timeout after ${timeoutMs}ms`));
    });
  });
}

// Get the Bee token from env or request
function getBeeToken(req) {
  return req.headers['x-bee-token'] || req.body?.bee_token || process.env.BEE_API_TOKEN || '';
}

// Extract text from a fact item — Bee API uses "text" but check alternatives for safety
function extractFactText(item) {
  if (typeof item === 'string') return item;
  return item.text || item.content || item.body || item.description || item.value || item.fact || null;
}

// Extract text from a todo item
function extractTodoText(item) {
  if (typeof item === 'string') return item;
  return item.text || item.content || item.title || item.body || item.description || item.task || null;
}

// Extract items array from an API response — tries all common wrapper patterns
function extractArray(data, primaryKey) {
  if (Array.isArray(data)) return data;
  if (data[primaryKey] && Array.isArray(data[primaryKey])) return data[primaryKey];
  // Try common alternatives
  for (const key of ['items', 'results', 'data']) {
    if (data[key] && Array.isArray(data[key])) return data[key];
  }
  // Auto-detect: find first array value
  const found = Object.values(data).find(v => Array.isArray(v));
  return found || [];
}

// Extract the best available transcript text from a conversation detail response
function extractTranscript(detail, convoStartTime) {
  if (detail.transcriptions && Array.isArray(detail.transcriptions) && detail.transcriptions.length > 0) {
    const finalized = detail.transcriptions.find(t => t.realtime === false) || detail.transcriptions[0];
    if (finalized.utterances && finalized.utterances.length > 0) {
      const sorted = [...finalized.utterances].sort((a, b) => (a.start || 0) - (b.start || 0)).slice(0, 1500);
      return sorted.map(u => {
        const speaker = u.speaker || u.speaker_name || u.label || 'Speaker';
        const text = u.text || u.content || '';
        let timeStr = '';
        if (convoStartTime && u.start != null) {
          const actualTime = new Date(convoStartTime + (u.start * 1000));
          timeStr = `[${actualTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}] `;
        } else if (u.spoken_at) {
          const spokenTime = new Date(u.spoken_at);
          timeStr = `[${spokenTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}] `;
        }
        return `${timeStr}${speaker}: ${text}`;
      }).join('\n');
    }
  }
  if (detail.utterances && Array.isArray(detail.utterances) && detail.utterances.length > 0) {
    return detail.utterances.map(u => {
      const speaker = u.speaker || u.speaker_name || u.label || 'Speaker';
      const text = u.text || u.content || '';
      return `${speaker}: ${text}`;
    }).join('\n');
  }
  return detail.transcript || detail.full_transcript || detail.text || '';
}

// Build raw_text: detailed transcript only (summary stored separately)
function buildConversationText(detail, listItem) {
  const convoStartTime = listItem.start_time || detail.start_time || null;
  const transcript = extractTranscript(detail, convoStartTime);
  return transcript || detail.summary || listItem.summary || '';
}

// ============================================================
// COUNTS — fetch item counts from Bee API for progress tracking
// GET /api/bee/counts
// ============================================================
router.get('/counts', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  const counts = {};

  // Fetch first page of each type with limit=1 to get total counts quickly
  try {
    const data = await beeApiGet('/v1/facts?limit=1', beeToken);
    const items = extractArray(data, 'facts');
    counts.facts = data.total || data.total_count || data.count || items.length || 0;
    counts.facts_keys = Array.isArray(data) ? '_array_' : Object.keys(data);
  } catch (e) { counts.facts_error = e.message; }

  try {
    const data = await beeApiGet('/v1/todos?limit=1', beeToken);
    const items = extractArray(data, 'todos');
    counts.todos = data.total || data.total_count || data.count || items.length || 0;
    counts.todos_keys = Array.isArray(data) ? '_array_' : Object.keys(data);
  } catch (e) { counts.todos_error = e.message; }

  try {
    const data = await beeApiGet('/v1/conversations?limit=1&created_after=2024-01-01', beeToken);
    const items = extractArray(data, 'conversations');
    counts.conversations = data.total || data.total_count || data.count || items.length || 0;
    counts.conversations_keys = Array.isArray(data) ? '_array_' : Object.keys(data);
  } catch (e) { counts.conversations_error = e.message; }

  try {
    const data = await beeApiGet('/v1/journals?limit=1', beeToken);
    const items = extractArray(data, 'journals');
    counts.journals = data.total || data.total_count || data.count || items.length || 0;
  } catch (e) { counts.journals_error = e.message; }

  try {
    const data = await beeApiGet('/v1/daily?limit=1', beeToken);
    const items = extractArray(data, 'daily');
    counts.daily = data.total || data.total_count || data.count || items.length || 0;
  } catch (e) { counts.daily_error = e.message; }

  res.json(counts);
});

// ============================================================
// CLOUD SYNC — calls Bee API directly from Railway
// POST /api/bee/sync
// ============================================================
router.post('/sync', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) {
    return res.status(400).json({
      error: 'Bee token required. Set BEE_API_TOKEN env var on Railway or pass X-Bee-Token header.',
      setup: 'Run "bee login" on your Mac, then: cat ~/.bee/token-prod'
    });
  }

  const force = req.body?.force === true;
  const results = { facts: 0, todos: 0, conversations: 0, journals: 0, daily: 0, skipped: 0, purged: false, errors: [] };

  if (force) {
    await query(`DELETE FROM knowledge WHERE ai_source = 'bee'`);
    await query(`DELETE FROM tasks WHERE ai_agent = 'bee'`);
    await query(`DELETE FROM transcripts WHERE source = 'bee'`);
    results.purged = true;
  }

  // --- Sync Facts ---
  try {
    let cursor = null;
    let page = 0;
    do {
      page++;
      const url = '/v1/facts' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const facts = extractArray(data, 'facts');
      cursor = data.next_cursor || null;
      console.log(`[bee-sync] Facts page ${page}: ${facts.length} items, response keys: ${Array.isArray(data) ? '_array_' : Object.keys(data).join(',')}`);
      if (facts.length > 0 && page === 1) console.log(`[bee-sync] First fact: ${JSON.stringify(facts[0]).substring(0, 400)}`);

      for (const fact of facts) {
        const factText = extractFactText(fact);
        if (!factText) continue;
        if (!force) {
          const existing = await query(`SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`, [`%${factText.substring(0, 100)}%`]);
          if (existing.rows.length > 0) { results.skipped++; continue; }
        }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'personal', $3, 'bee', 'bee', $4)`, [
          `Bee Fact: ${factText.substring(0, 80)}`, factText,
          JSON.stringify(['bee', 'fact', fact.confirmed ? 'confirmed' : 'unconfirmed']),
          JSON.stringify({ bee_id: fact.id, confirmed: fact.confirmed })
        ]);
        results.facts++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Facts: ${e.message}`);
  }

  // --- Sync Todos ---
  try {
    let cursor = null;
    let page = 0;
    do {
      page++;
      const url = '/v1/todos' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const todos = extractArray(data, 'todos');
      cursor = data.next_cursor || null;
      console.log(`[bee-sync] Todos page ${page}: ${todos.length} items, response keys: ${Array.isArray(data) ? '_array_' : Object.keys(data).join(',')}`);
      if (todos.length > 0 && page === 1) console.log(`[bee-sync] First todo: ${JSON.stringify(todos[0]).substring(0, 400)}`);

      for (const todo of todos) {
        const todoText = extractTodoText(todo);
        if (!todoText) continue;
        if (!force) {
          const existing = await query(`SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`, [todoText]);
          if (existing.rows.length > 0) { results.skipped++; continue; }
        }
        await query(`INSERT INTO tasks (title, status, priority, ai_agent, next_steps) VALUES ($1, $2, 'medium', 'bee', $3)`, [
          todoText, todo.completed ? 'done' : 'todo', todo.id ? `Bee Todo ID: ${todo.id}` : null
        ]);
        results.todos++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Todos: ${e.message}`);
  }

  // --- Sync Conversations (oldest first) ---
  try {
    let cursor = null;
    do {
      const url = `/v1/conversations?limit=50&created_after=2024-01-01` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const convos = extractArray(data, 'conversations');
      cursor = data.next_cursor || null;
      for (const convo of convos) {
        const beeId = convo.id;
        if (!beeId) continue;
        if (!force) {
          const existing = await query(`SELECT id FROM transcripts WHERE metadata::text ILIKE $1 AND source = 'bee'`, [`%${beeId}%`]);
          if (existing.rows.length > 0) { results.skipped++; continue; }
        }
        if (convo.state === 'CAPTURING') { results.skipped++; continue; }

        let summary = convo.summary || null;
        let full = convo;
        try {
          const detail = await beeApiGet(`/v1/conversations/${beeId}`, beeToken);
          full = detail.conversation || detail;
          if (full.summary) summary = full.summary;
        } catch (e) {
          if (!summary) { results.errors.push(`Conversation ${beeId}: ${e.message}`); continue; }
        }

        const rawText = buildConversationText(full, convo);
        if (!rawText) continue;

        const title = full.short_summary || convo.short_summary ||
          (summary ? summary.substring(0, 80) : null) ||
          `Bee Conversation ${convo.created_at ? new Date(convo.created_at).toLocaleDateString() : ''}`;

        const durationMs = (convo.end_time && convo.start_time) ? convo.end_time - convo.start_time : null;
        const durationSec = durationMs ? Math.round(durationMs / 1000) : (full.duration_seconds || null);
        const recordedAt = convo.start_time ? new Date(convo.start_time).toISOString()
          : (convo.created_at ? new Date(convo.created_at).toISOString() : null);

        const location = convo.primary_location?.address || full.primary_location?.address || null;
        const speakers = full.speakers || convo.speakers || [];

        const result = await query(`
          INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, location, tags, metadata)
          VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7, $8, $9) RETURNING id
        `, [
          title.substring(0, 200), rawText, summary,
          JSON.stringify(speakers), durationSec, recordedAt, location,
          JSON.stringify(['bee', 'conversation']),
          JSON.stringify({
            bee_id: beeId, utterances_count: convo.utterances_count || full.utterances_count || null,
            location: location, state: convo.state || null,
            start_time: convo.start_time || null, end_time: convo.end_time || null,
            primary_location: convo.primary_location || full.primary_location || null
          })
        ]);

        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'meeting', $3, 'bee', 'bee', $4)`, [
          title.substring(0, 200), (summary || rawText).substring(0, 5000),
          JSON.stringify(['bee', 'conversation']),
          JSON.stringify({ transcript_id: result.rows[0].id, bee_id: beeId })
        ]);
        results.conversations++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Conversations: ${e.message}`);
  }

  // --- Sync Journals ---
  try {
    let cursor = null;
    do {
      const url = '/v1/journals' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const journals = extractArray(data, 'journals');
      cursor = data.next_cursor || null;
      console.log(`[bee-sync] Journals: ${journals.length} items`);

      for (const journal of journals) {
        const jText = journal.text || journal.content || journal.body || journal.markdown || '';
        const jTitle = journal.title || journal.short_summary || (jText ? jText.substring(0, 80) : `Journal ${journal.id}`);
        if (!jText && !journal.summary) continue;
        if (!force) {
          const existing = await query(`SELECT id FROM knowledge WHERE metadata->>'bee_journal_id' = $1 AND ai_source = 'bee'`, [String(journal.id)]);
          if (existing.rows.length > 0) { results.skipped++; continue; }
        }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'journal', $3, 'bee', 'bee', $4)`, [
          jTitle.substring(0, 200), (jText || journal.summary).substring(0, 10000),
          JSON.stringify(['bee', 'journal']),
          JSON.stringify({ bee_journal_id: journal.id, created_at: journal.created_at })
        ]);
        results.journals++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Journals: ${e.message}`);
  }

  // --- Sync Daily Summaries ---
  try {
    let cursor = null;
    do {
      const url = '/v1/daily' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const dailies = extractArray(data, 'daily');
      cursor = data.next_cursor || null;
      console.log(`[bee-sync] Daily summaries: ${dailies.length} items`);

      for (const day of dailies) {
        const dText = day.text || day.content || day.body || day.summary || day.markdown || '';
        if (!dText) continue;
        const dDate = day.date || day.created_at || '';
        const dTitle = day.title || `Daily Summary ${dDate ? new Date(dDate).toLocaleDateString() : day.id}`;
        if (!force) {
          const existing = await query(`SELECT id FROM knowledge WHERE metadata->>'bee_daily_id' = $1 AND ai_source = 'bee'`, [String(day.id)]);
          if (existing.rows.length > 0) { results.skipped++; continue; }
        }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'daily-summary', $3, 'bee', 'bee', $4)`, [
          dTitle.substring(0, 200), dText.substring(0, 10000),
          JSON.stringify(['bee', 'daily-summary']),
          JSON.stringify({ bee_daily_id: day.id, date: dDate })
        ]);
        results.daily++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Daily: ${e.message}`);
  }

  await query(`INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details) VALUES ('create', 'bee-import', 'cloud-sync', 'bee', $1)`,
    [`Cloud sync${force ? ' (full)' : ''}: ${results.facts} facts, ${results.todos} todos, ${results.conversations} conversations, ${results.journals} journals, ${results.daily} daily (${results.skipped} skipped)`]);

  res.json({ message: `Bee cloud sync complete${force ? ' (full refresh)' : ''}`, imported: results });
});

// ============================================================
// CHUNKED SYNC — one page at a time, driven by the frontend
// POST /api/bee/sync-chunk
// Body: { type: 'facts'|'todos'|'conversations'|'journals'|'daily', cursor, force }
// Returns: { imported, skipped, cursor (next), done, debug_* }
// ============================================================
router.post('/sync-chunk', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  const { type, cursor, force } = req.body;
  if (!type) return res.status(400).json({ error: 'type required (facts, todos, conversations, journals, daily)' });

  try {
    if (type === 'facts') {
      // Bee API: GET /v1/facts — returns all facts, cursor-paginated
      const url = '/v1/facts' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const debugKeys = Array.isArray(data) ? '_array_' : Object.keys(data);
      const facts = extractArray(data, 'facts');
      const nextCursor = data.next_cursor || null;
      let imported = 0, skipped = 0;

      const debugFirstItem = facts.length > 0 ? Object.keys(facts[0]) : [];
      console.log(`[bee-sync-chunk] Facts: ${facts.length} items, response keys: ${JSON.stringify(debugKeys)}`);
      if (facts.length > 0) console.log(`[bee-sync-chunk] First fact: ${JSON.stringify(facts[0]).substring(0, 400)}`);

      for (const fact of facts) {
        const factText = extractFactText(fact);
        if (!factText) { skipped++; continue; }
        if (!force) {
          const existing = await query(`SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`, [`%${factText.substring(0, 100)}%`]);
          if (existing.rows.length > 0) { skipped++; continue; }
        }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'personal', $3, 'bee', 'bee', $4)`, [
          `Bee Fact: ${factText.substring(0, 80)}`, factText,
          JSON.stringify(['bee', 'fact', fact.confirmed ? 'confirmed' : 'unconfirmed']),
          JSON.stringify({ bee_id: fact.id, confirmed: fact.confirmed })
        ]);
        imported++;
      }

      return res.json({ type, imported, skipped, cursor: nextCursor, done: facts.length === 0 && !nextCursor, page_size: facts.length, debug_keys: debugKeys, debug_first_item_keys: debugFirstItem, total: data.total || data.total_count || data.count || null });

    } else if (type === 'todos') {
      // Bee API: GET /v1/todos — returns all todos, cursor-paginated
      const url = '/v1/todos' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const debugKeys = Array.isArray(data) ? '_array_' : Object.keys(data);
      const todos = extractArray(data, 'todos');
      const nextCursor = data.next_cursor || null;
      let imported = 0, skipped = 0;

      const debugFirstItem = todos.length > 0 ? Object.keys(todos[0]) : [];
      console.log(`[bee-sync-chunk] Todos: ${todos.length} items, response keys: ${JSON.stringify(debugKeys)}`);
      if (todos.length > 0) console.log(`[bee-sync-chunk] First todo: ${JSON.stringify(todos[0]).substring(0, 400)}`);

      for (const todo of todos) {
        const todoText = extractTodoText(todo);
        if (!todoText) { skipped++; continue; }
        if (!force) {
          const existing = await query(`SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`, [todoText]);
          if (existing.rows.length > 0) { skipped++; continue; }
        }
        await query(`INSERT INTO tasks (title, status, priority, ai_agent, next_steps) VALUES ($1, $2, 'medium', 'bee', $3)`, [
          todoText, todo.completed ? 'done' : 'todo', todo.id ? `Bee Todo ID: ${todo.id}` : null
        ]);
        imported++;
      }

      return res.json({ type, imported, skipped, cursor: nextCursor, done: todos.length === 0 && !nextCursor, page_size: todos.length, debug_keys: debugKeys, debug_first_item_keys: debugFirstItem, total: data.total || data.total_count || data.count || null });

    } else if (type === 'conversations') {
      const url = `/v1/conversations?limit=5&created_after=2024-01-01` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const debugKeys = Array.isArray(data) ? '_array_' : Object.keys(data);
      const convos = extractArray(data, 'conversations');
      const nextCursor = data.next_cursor || null;
      let imported = 0, skipped = 0, errors = [];
      let skipReasons = { capturing: 0, duplicate: 0, noId: 0, noText: 0, fetchError: 0 };

      for (const convo of convos) {
        const beeId = convo.id;
        if (!beeId) { skipReasons.noId++; continue; }
        if (convo.state === 'CAPTURING') { skipped++; skipReasons.capturing++; continue; }
        if (!force) {
          const existing = await query(`SELECT id FROM transcripts WHERE metadata::text ILIKE $1 AND source = 'bee'`, [`%${beeId}%`]);
          if (existing.rows.length > 0) { skipped++; skipReasons.duplicate++; continue; }
        }

        try {
          let summary = convo.summary || null;
          let full = convo;
          try {
            const detail = await beeApiGet(`/v1/conversations/${beeId}`, beeToken);
            full = detail.conversation || detail;
            if (full.summary) summary = full.summary;
          } catch (e) {
            if (!summary) { errors.push(`${beeId}: ${e.message}`); skipReasons.fetchError++; continue; }
          }

          let rawText = buildConversationText(full, convo);
          full = null;
          if (!rawText) { skipReasons.noText++; continue; }
          if (rawText.length > 500000) rawText = rawText.substring(0, 500000) + '\n\n[Transcript truncated at 500KB]';

          const title = convo.short_summary || (summary ? summary.substring(0, 80) : null) ||
            `Bee Conversation ${convo.created_at ? new Date(convo.created_at).toLocaleDateString() : ''}`;

          const durationMs = (convo.end_time && convo.start_time) ? convo.end_time - convo.start_time : null;
          const durationSec = durationMs ? Math.round(durationMs / 1000) : null;
          const recordedAt = convo.start_time ? new Date(convo.start_time).toISOString()
            : (convo.created_at ? new Date(convo.created_at).toISOString() : null);

          const chunkLocation = convo.primary_location?.address || null;

          const result = await query(`
            INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, location, tags, metadata)
            VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7, $8, $9) RETURNING id
          `, [
            title.substring(0, 200), rawText, summary,
            JSON.stringify(convo.speakers || []), durationSec, recordedAt, chunkLocation,
            JSON.stringify(['bee', 'conversation']),
            JSON.stringify({
              bee_id: beeId, utterances_count: convo.utterances_count || null,
              location: chunkLocation, state: convo.state || null,
              start_time: convo.start_time || null, end_time: convo.end_time || null,
              primary_location: convo.primary_location || null
            })
          ]);

          await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'meeting', $3, 'bee', 'bee', $4)`, [
            title.substring(0, 200), (summary || rawText).substring(0, 5000),
            JSON.stringify(['bee', 'conversation']),
            JSON.stringify({ transcript_id: result.rows[0].id, bee_id: beeId })
          ]);
          imported++;
        } catch (convErr) {
          errors.push(`${beeId}: ${convErr.message}`);
        }
      }

      const dates = convos.map(c => c.start_time || c.created_at).filter(Boolean).sort();
      return res.json({
        type, imported, skipped, cursor: nextCursor, done: convos.length === 0 && !nextCursor,
        page_size: convos.length, skip_reasons: skipReasons, errors: errors.length ? errors : undefined,
        debug_keys: debugKeys, total: data.total || data.total_count || data.count || null,
        date_range: dates.length ? { earliest: new Date(Math.min(...dates.map(d => new Date(d)))).toISOString(), latest: new Date(Math.max(...dates.map(d => new Date(d)))).toISOString() } : null
      });

    } else if (type === 'journals') {
      const url = '/v1/journals' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const debugKeys = Array.isArray(data) ? '_array_' : Object.keys(data);
      const journals = extractArray(data, 'journals');
      const nextCursor = data.next_cursor || null;
      let imported = 0, skipped = 0;

      console.log(`[bee-sync-chunk] Journals: ${journals.length} items, keys: ${JSON.stringify(debugKeys)}`);
      if (journals.length > 0) console.log(`[bee-sync-chunk] First journal: ${JSON.stringify(journals[0]).substring(0, 400)}`);

      for (const journal of journals) {
        const jText = journal.text || journal.content || journal.body || journal.markdown || '';
        const jTitle = journal.title || journal.short_summary || (jText ? jText.substring(0, 80) : `Journal ${journal.id}`);
        if (!jText && !journal.summary) { skipped++; continue; }
        if (!force) {
          const existing = await query(`SELECT id FROM knowledge WHERE metadata->>'bee_journal_id' = $1 AND ai_source = 'bee'`, [String(journal.id)]);
          if (existing.rows.length > 0) { skipped++; continue; }
        }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'journal', $3, 'bee', 'bee', $4)`, [
          jTitle.substring(0, 200), (jText || journal.summary).substring(0, 10000),
          JSON.stringify(['bee', 'journal']),
          JSON.stringify({ bee_journal_id: journal.id, created_at: journal.created_at })
        ]);
        imported++;
      }

      return res.json({ type, imported, skipped, cursor: nextCursor, done: journals.length === 0 && !nextCursor, page_size: journals.length, debug_keys: debugKeys, total: data.total || data.total_count || data.count || null });

    } else if (type === 'daily') {
      const url = '/v1/daily' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const debugKeys = Array.isArray(data) ? '_array_' : Object.keys(data);
      const dailies = extractArray(data, 'daily');
      const nextCursor = data.next_cursor || null;
      let imported = 0, skipped = 0;

      console.log(`[bee-sync-chunk] Daily: ${dailies.length} items, keys: ${JSON.stringify(debugKeys)}`);
      if (dailies.length > 0) console.log(`[bee-sync-chunk] First daily: ${JSON.stringify(dailies[0]).substring(0, 400)}`);

      for (const day of dailies) {
        const dText = day.text || day.content || day.body || day.summary || day.markdown || '';
        if (!dText) { skipped++; continue; }
        const dDate = day.date || day.created_at || '';
        const dTitle = day.title || `Daily Summary ${dDate ? new Date(dDate).toLocaleDateString() : day.id}`;
        if (!force) {
          const existing = await query(`SELECT id FROM knowledge WHERE metadata->>'bee_daily_id' = $1 AND ai_source = 'bee'`, [String(day.id)]);
          if (existing.rows.length > 0) { skipped++; continue; }
        }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'daily-summary', $3, 'bee', 'bee', $4)`, [
          dTitle.substring(0, 200), dText.substring(0, 10000),
          JSON.stringify(['bee', 'daily-summary']),
          JSON.stringify({ bee_daily_id: day.id, date: dDate })
        ]);
        imported++;
      }

      return res.json({ type, imported, skipped, cursor: nextCursor, done: dailies.length === 0 && !nextCursor, page_size: dailies.length, debug_keys: debugKeys, total: data.total || data.total_count || data.count || null });

    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error(`[bee-sync-chunk] Error for type=${type}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// INCREMENTAL SYNC — uses /v1/changes to only fetch new/modified items
// POST /api/bee/sync-incremental
// ============================================================
router.post('/sync-incremental', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  try {
    const cursorRow = await query(`SELECT details FROM activity_log WHERE action = 'bee-change-cursor' ORDER BY created_at DESC LIMIT 1`);
    const lastCursor = cursorRow.rows[0]?.details || null;

    const url = '/v1/changes' + (lastCursor ? `?cursor=${encodeURIComponent(lastCursor)}` : '');
    const data = await beeApiGet(url, beeToken);

    const changes = data.changes || data.items || data.data || [];
    const newCursor = data.next_cursor || data.cursor || null;
    const results = { facts: 0, todos: 0, conversations: 0, skipped: 0, errors: [] };

    const changedFacts = [], changedTodos = [], changedConvos = [];

    for (const change of (Array.isArray(changes) ? changes : [])) {
      const entityType = change.type || change.entity_type;
      const entityId = change.id || change.entity_id;
      if (!entityId) continue;
      if (entityType === 'fact') changedFacts.push(entityId);
      else if (entityType === 'todo') changedTodos.push(entityId);
      else if (entityType === 'conversation') changedConvos.push(entityId);
    }

    for (const factId of changedFacts) {
      try {
        const fact = await beeApiGet(`/v1/facts/${factId}`, beeToken);
        const f = fact.fact || fact;
        const fText = extractFactText(f);
        if (!fText) continue;
        const existing = await query(`SELECT id FROM knowledge WHERE metadata->>'bee_id' = $1 AND ai_source = 'bee'`, [String(f.id || factId)]);
        if (existing.rows.length > 0) {
          await query(`UPDATE knowledge SET content = $1, title = $2, updated_at = NOW() WHERE metadata->>'bee_id' = $3 AND ai_source = 'bee'`, [
            fText, `Bee Fact: ${fText.substring(0, 80)}`, String(f.id || factId)
          ]);
        } else {
          await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'personal', $3, 'bee', 'bee', $4)`, [
            `Bee Fact: ${fText.substring(0, 80)}`, fText,
            JSON.stringify(['bee', 'fact', f.confirmed ? 'confirmed' : 'unconfirmed']),
            JSON.stringify({ bee_id: f.id || factId, confirmed: f.confirmed })
          ]);
        }
        results.facts++;
      } catch (e) { results.errors.push(`fact ${factId}: ${e.message}`); }
    }

    for (const todoId of changedTodos) {
      try {
        const todo = await beeApiGet(`/v1/todos/${todoId}`, beeToken);
        const t = todo.todo || todo;
        const tText = extractTodoText(t);
        if (!tText) continue;
        const existing = await query(`SELECT id FROM tasks WHERE next_steps LIKE $1 AND ai_agent = 'bee'`, [`%${t.id || todoId}%`]);
        if (existing.rows.length > 0) {
          await query(`UPDATE tasks SET title = $1, status = $2, updated_at = NOW() WHERE next_steps LIKE $3 AND ai_agent = 'bee'`, [
            tText, t.completed ? 'done' : 'todo', `%${t.id || todoId}%`
          ]);
        } else {
          await query(`INSERT INTO tasks (title, status, priority, ai_agent, next_steps) VALUES ($1, $2, 'medium', 'bee', $3)`, [
            tText, t.completed ? 'done' : 'todo', `Bee Todo ID: ${t.id || todoId}`
          ]);
        }
        results.todos++;
      } catch (e) { results.errors.push(`todo ${todoId}: ${e.message}`); }
    }

    for (const convoId of changedConvos) {
      try {
        const detail = await beeApiGet(`/v1/conversations/${convoId}`, beeToken);
        const c = detail.conversation || detail;
        if (c.state === 'CAPTURING') continue;
        const rawText = buildConversationText(c, c);
        if (!rawText) continue;
        const title = c.short_summary || (c.summary ? c.summary.substring(0, 80) : `Bee Conversation ${convoId}`);

        const durationMs = (c.end_time && c.start_time) ? c.end_time - c.start_time : null;
        const durationSec = durationMs ? Math.round(durationMs / 1000) : (c.duration_seconds || null);
        const recordedAt = c.start_time ? new Date(c.start_time).toISOString()
          : (c.created_at ? new Date(c.created_at).toISOString() : null);
        const incLocation = c.primary_location?.address || null;
        const incSpeakers = c.speakers || [];

        const existing = await query(`SELECT id FROM transcripts WHERE metadata->>'bee_id' = $1 AND source = 'bee'`, [String(convoId)]);
        if (existing.rows.length > 0) {
          await query(`UPDATE transcripts SET raw_text = $1, summary = $2, title = $3, speaker_labels = $4, duration_seconds = COALESCE($5, duration_seconds), recorded_at = COALESCE($6, recorded_at), location = COALESCE($7, location), updated_at = NOW() WHERE metadata->>'bee_id' = $8 AND source = 'bee'`, [
            rawText, c.summary || null, title.substring(0, 200),
            JSON.stringify(incSpeakers), durationSec, recordedAt, incLocation, String(convoId)
          ]);
          await query(`UPDATE knowledge SET content = $1, title = $2, updated_at = NOW() WHERE metadata->>'bee_id' = $3 AND ai_source = 'bee' AND category = 'meeting'`, [
            (c.summary || rawText).substring(0, 5000), title.substring(0, 200), String(convoId)
          ]);
        } else {
          const result = await query(`INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, location, tags, metadata) VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7, $8, $9) RETURNING id`, [
            title.substring(0, 200), rawText, c.summary || null,
            JSON.stringify(incSpeakers), durationSec, recordedAt, incLocation,
            JSON.stringify(['bee', 'conversation']),
            JSON.stringify({ bee_id: convoId, state: c.state || null, location: incLocation, primary_location: c.primary_location || null })
          ]);
          await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'meeting', $3, 'bee', 'bee', $4)`, [
            title.substring(0, 200), (c.summary || rawText).substring(0, 5000),
            JSON.stringify(['bee', 'conversation']),
            JSON.stringify({ transcript_id: result.rows[0].id, bee_id: convoId })
          ]);
        }
        results.conversations++;
      } catch (e) { results.errors.push(`conversation ${convoId}: ${e.message}`); }
    }

    if (newCursor) {
      await query(`INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details) VALUES ('bee-change-cursor', 'bee-sync', 'cursor', 'bee', $1)`, [newCursor]);
    }

    await query(`INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details) VALUES ('create', 'bee-import', 'incremental', 'bee', $1)`, [
      `Incremental sync: ${results.facts} facts, ${results.todos} todos, ${results.conversations} conversations`
    ]);

    res.json({ message: 'Incremental sync complete', imported: results, changes_processed: changes.length, had_cursor: !!lastCursor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PURGE — clear all bee data (used before chunked full sync)
// POST /api/bee/purge
// ============================================================
router.post('/purge', async (req, res) => {
  try {
    const k = await query(`DELETE FROM knowledge WHERE ai_source = 'bee'`);
    const t = await query(`DELETE FROM tasks WHERE ai_agent = 'bee'`);
    const tr = await query(`DELETE FROM transcripts WHERE source = 'bee'`);
    res.json({ purged: { knowledge: k.rowCount, tasks: t.rowCount, transcripts: tr.rowCount } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// IMPORT — from local bee sync data (JSON or markdown)
// ============================================================
router.post('/import', async (req, res) => {
  try {
    const { facts, todos, conversations } = req.body;
    const results = { facts: 0, todos: 0, conversations: 0, skipped: 0 };

    if (Array.isArray(facts)) {
      for (const fact of facts) {
        const factText = extractFactText(fact);
        if (!factText) continue;
        const existing = await query(`SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`, [`%${factText.substring(0, 100)}%`]);
        if (existing.rows.length > 0) { results.skipped++; continue; }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'personal', $3, 'bee', 'bee', $4)`, [
          `Bee Fact: ${factText.substring(0, 80)}`, factText,
          JSON.stringify(fact.tags || ['bee', 'fact']),
          JSON.stringify({ bee_id: fact.id, confirmed: fact.confirmed || false })
        ]);
        results.facts++;
      }
    }

    if (Array.isArray(todos)) {
      for (const todo of todos) {
        const todoText = extractTodoText(todo);
        if (!todoText) continue;
        const existing = await query(`SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`, [todoText]);
        if (existing.rows.length > 0) { results.skipped++; continue; }
        await query(`INSERT INTO tasks (title, status, priority, ai_agent, next_steps) VALUES ($1, $2, 'medium', 'bee', $3)`, [
          todoText, todo.completed ? 'done' : 'todo', todo.id ? `Bee Todo ID: ${todo.id}` : null
        ]);
        results.todos++;
      }
    }

    if (Array.isArray(conversations)) {
      for (const convo of conversations) {
        if (!convo.text && !convo.raw_text) continue;
        const rawText = convo.raw_text || convo.text;
        const title = convo.title || `Bee Conversation ${convo.date || new Date().toLocaleDateString()}`;
        const existing = await query(`SELECT id FROM transcripts WHERE title = $1 AND source = 'bee'`, [title]);
        if (existing.rows.length > 0) { results.skipped++; continue; }
        const result = await query(`INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata) VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7, $8) RETURNING id`, [
          title, rawText, convo.summary || null,
          JSON.stringify(convo.speakers || []), convo.duration_seconds || null,
          convo.date || convo.recorded_at || null,
          JSON.stringify(convo.tags || ['bee', 'conversation']),
          JSON.stringify({ bee_id: convo.id || null })
        ]);
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'meeting', $3, 'bee', 'bee', $4)`, [
          title, (convo.summary || rawText).substring(0, 5000),
          JSON.stringify(convo.tags || ['bee', 'conversation']),
          JSON.stringify({ transcript_id: result.rows[0].id, bee_id: convo.id || null })
        ]);
        results.conversations++;
      }
    }

    await query(`INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details) VALUES ('create', 'bee-import', 'bulk', 'bee', $1)`,
      [`Bee import: ${results.facts} facts, ${results.todos} todos, ${results.conversations} conversations (${results.skipped} skipped)`]);

    res.json({ message: 'Bee data imported', imported: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import markdown files
router.post('/import-markdown', async (req, res) => {
  try {
    const { facts_md, todos_md, conversations } = req.body;
    const results = { facts: 0, todos: 0, conversations: 0, skipped: 0 };

    if (facts_md) {
      const factLines = facts_md.split('\n').filter(l => l.startsWith('- '));
      for (const line of factLines) {
        const text = line.replace(/^- /, '').trim();
        if (!text) continue;
        const existing = await query(`SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`, [`%${text.substring(0, 100)}%`]);
        if (existing.rows.length > 0) { results.skipped++; continue; }
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source) VALUES ($1, $2, 'personal', '["bee","fact"]', 'bee', 'bee')`, [`Bee Fact: ${text.substring(0, 80)}`, text]);
        results.facts++;
      }
    }

    if (todos_md) {
      const todoLines = todos_md.split('\n').filter(l => /^- \[[ x]\]/.test(l));
      for (const line of todoLines) {
        const completed = line.includes('[x]');
        const text = line.replace(/^- \[[ x]\] /, '').trim();
        if (!text) continue;
        const existing = await query(`SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`, [text]);
        if (existing.rows.length > 0) { results.skipped++; continue; }
        await query(`INSERT INTO tasks (title, status, priority, ai_agent) VALUES ($1, $2, 'medium', 'bee')`, [text, completed ? 'done' : 'todo']);
        results.todos++;
      }
    }

    if (Array.isArray(conversations)) {
      for (const convo of conversations) {
        if (!convo.markdown) continue;
        const title = convo.title || convo.filename || `Bee Conversation`;
        const existing = await query(`SELECT id FROM transcripts WHERE title = $1 AND source = 'bee'`, [title]);
        if (existing.rows.length > 0) { results.skipped++; continue; }
        const dateMatch = (convo.title || convo.filename || '').match(/(\d{4}-\d{2}-\d{2})/);
        const result = await query(`INSERT INTO transcripts (title, raw_text, source, recorded_at, tags) VALUES ($1, $2, 'bee', $3, '["bee","conversation"]') RETURNING id`, [title, convo.markdown, dateMatch ? dateMatch[1] : null]);
        await query(`INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata) VALUES ($1, $2, 'meeting', '["bee","conversation"]', 'bee', 'bee', $3)`, [title, convo.markdown.substring(0, 5000), JSON.stringify({ transcript_id: result.rows[0].id })]);
        results.conversations++;
      }
    }

    res.json({ message: 'Bee markdown imported', imported: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: test Bee API connection and see raw responses
router.get('/test', async (req, res) => {
  const beeToken = req.headers['x-bee-token'] || req.query.bee_token || process.env.BEE_API_TOKEN || '';
  if (!beeToken) return res.status(400).json({ error: 'No Bee token available' });

  const results = { token_length: beeToken.length, token_prefix: beeToken.substring(0, 20) + '...' };

  try {
    results.me = await beeApiGet('/v1/me', beeToken);
  } catch (e) { results.me_error = e.message; }

  // Test facts — NO extra params (the Bee API may not support limit/page/confirmed as query params)
  try {
    results.facts_raw = await beeApiGet('/v1/facts', beeToken);
    const facts = extractArray(results.facts_raw, 'facts');
    results.facts_count = facts.length;
    results.facts_response_keys = Array.isArray(results.facts_raw) ? '_array_' : Object.keys(results.facts_raw);
    if (facts.length > 0) results.facts_first_item = facts[0];
  } catch (e) { results.facts_error = e.message; }

  // Test todos — NO extra params
  try {
    results.todos_raw = await beeApiGet('/v1/todos', beeToken);
    const todos = extractArray(results.todos_raw, 'todos');
    results.todos_count = todos.length;
    results.todos_response_keys = Array.isArray(results.todos_raw) ? '_array_' : Object.keys(results.todos_raw);
    if (todos.length > 0) results.todos_first_item = todos[0];
  } catch (e) { results.todos_error = e.message; }

  // Test conversations
  try {
    const listData = await beeApiGet('/v1/conversations?limit=3&created_after=2024-01-01', beeToken);
    results.conversations_raw = listData;
    results.conversations_response_keys = Array.isArray(listData) ? '_array_' : Object.keys(listData);

    const convos = extractArray(listData, 'conversations');
    const completed = convos.find(c => c.state === 'COMPLETED');
    if (completed) {
      const detail = await beeApiGet(`/v1/conversations/${completed.id}`, beeToken);
      const fullConvo = detail.conversation || detail;
      const detailShape = {};
      for (const [key, val] of Object.entries(fullConvo)) {
        if (val === null || val === undefined) detailShape[key] = null;
        else if (Array.isArray(val)) detailShape[key] = `Array[${val.length}]${val.length > 0 ? ' first: ' + JSON.stringify(val[0]).substring(0, 300) : ''}`;
        else if (typeof val === 'object') detailShape[key] = `Object keys: [${Object.keys(val).join(', ')}] => ${JSON.stringify(val).substring(0, 300)}`;
        else if (typeof val === 'string') detailShape[key] = `String(${val.length}) "${val.substring(0, 300)}${val.length > 300 ? '...' : ''}"`;
        else detailShape[key] = val;
      }
      results.conversation_detail_shape = detailShape;
      results.conversation_detail_id = completed.id;
    }
  } catch (e) { results.conversations_error = e.message; }

  // Test journals
  try {
    results.journals_raw = await beeApiGet('/v1/journals', beeToken);
    const journals = extractArray(results.journals_raw, 'journals');
    results.journals_count = journals.length;
    results.journals_response_keys = Array.isArray(results.journals_raw) ? '_array_' : Object.keys(results.journals_raw);
    if (journals.length > 0) results.journals_first_item = journals[0];
  } catch (e) { results.journals_error = e.message; }

  // Test daily summaries
  try {
    results.daily_raw = await beeApiGet('/v1/daily', beeToken);
    const daily = extractArray(results.daily_raw, 'daily');
    results.daily_count = daily.length;
    results.daily_response_keys = Array.isArray(results.daily_raw) ? '_array_' : Object.keys(results.daily_raw);
    if (daily.length > 0) results.daily_first_item = daily[0];
  } catch (e) { results.daily_error = e.message; }

  res.json(results);
});

// Get Bee sync status
router.get('/status', async (req, res) => {
  try {
    const facts = await query(`SELECT COUNT(*) as count FROM knowledge WHERE ai_source = 'bee'`);
    const tasks = await query(`SELECT COUNT(*) as count FROM tasks WHERE ai_agent = 'bee'`);
    const transcripts = await query(`SELECT COUNT(*) as count FROM transcripts WHERE source = 'bee'`);
    const journals = await query(`SELECT COUNT(*) as count FROM knowledge WHERE ai_source = 'bee' AND category = 'journal'`);
    const daily = await query(`SELECT COUNT(*) as count FROM knowledge WHERE ai_source = 'bee' AND category = 'daily-summary'`);
    const lastImport = await query(`SELECT created_at FROM activity_log WHERE entity_type = 'bee-import' ORDER BY created_at DESC LIMIT 1`);

    res.json({
      facts: Number(facts.rows[0].count),
      tasks: Number(tasks.rows[0].count),
      transcripts: Number(transcripts.rows[0].count),
      journals: Number(journals.rows[0].count),
      daily: Number(daily.rows[0].count),
      last_import: lastImport.rows[0]?.created_at || null,
      bee_token_configured: !!process.env.BEE_API_TOKEN
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EXPORT — dump all Bee-synced data from the database as JSON
// GET /api/bee/export?since=2025-12-26
// ============================================================
router.get('/export', async (req, res) => {
  try {
    const since = req.query.since || '2025-01-01';

    const [dailySummaries, conversations, journals, facts, todos] = await Promise.all([
      query(`SELECT id, title, content, category, tags, metadata, created_at FROM knowledge WHERE ai_source = 'bee' AND category = 'daily-summary' AND created_at >= $1 ORDER BY created_at`, [since]),
      query(`SELECT id, title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, location, tags, metadata, created_at FROM transcripts WHERE source = 'bee' AND created_at >= $1 ORDER BY recorded_at`, [since]),
      query(`SELECT id, title, content, category, tags, metadata, created_at FROM knowledge WHERE ai_source = 'bee' AND category = 'journal' AND created_at >= $1 ORDER BY created_at`, [since]),
      query(`SELECT id, title, content, category, tags, metadata, created_at FROM knowledge WHERE ai_source = 'bee' AND category = 'personal' ORDER BY created_at`),
      query(`SELECT id, title, status, priority, ai_agent, next_steps, created_at FROM tasks WHERE ai_agent = 'bee' ORDER BY created_at`)
    ]);

    res.json({
      exported_at: new Date().toISOString(),
      since,
      counts: {
        daily_summaries: dailySummaries.rows.length,
        conversations: conversations.rows.length,
        journals: journals.rows.length,
        facts: facts.rows.length,
        todos: todos.rows.length
      },
      daily_summaries: dailySummaries.rows,
      conversations: conversations.rows,
      journals: journals.rows,
      facts: facts.rows,
      todos: todos.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BEE NEURAL SEARCH — proxy to Bee's semantic search API
// POST /api/bee/search
// ============================================================
function beeApiPost(path, body, beeToken, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BEE_API);
    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      agent: beeAgent,
      headers: {
        'Authorization': `Bearer ${beeToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid Bee token'));
        if (res.statusCode !== 200) return reject(new Error(`Bee API ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Bee API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Bee API timeout after ${timeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

// Neural (semantic) search over Bee conversations
router.post('/search', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  const { query: searchQuery, limit = 20 } = req.body;
  if (!searchQuery) return res.status(400).json({ error: 'query is required' });

  try {
    const beeResults = await beeApiPost('/v1/search/conversations/neural', {
      query: searchQuery,
      limit: Math.min(Number(limit), 50)
    }, beeToken);

    // Cross-reference with local transcripts to link IDs
    const conversations = extractArray(beeResults, 'conversations');
    const enriched = [];

    for (const convo of conversations) {
      const beeId = convo.id || convo.conversation_id;
      let localTranscript = null;

      if (beeId) {
        const local = await query(
          `SELECT id, title FROM transcripts WHERE metadata->>'bee_id' = $1 OR metadata->>'conversation_id' = $1 LIMIT 1`,
          [beeId]
        );
        if (local.rows.length > 0) {
          localTranscript = { id: local.rows[0].id, title: local.rows[0].title };
        }
      }

      enriched.push({
        type: 'bee_neural',
        bee_id: beeId,
        title: convo.title || convo.summary?.substring(0, 80) || 'Bee Conversation',
        preview: convo.summary || convo.snippet || '',
        score: convo.score || convo.relevance || 0,
        start_time: convo.start_time || convo.created_at,
        local_transcript: localTranscript
      });
    }

    res.json({
      query: searchQuery,
      count: enriched.length,
      results: enriched
    });
  } catch (err) {
    res.status(500).json({ error: `Bee neural search failed: ${err.message}` });
  }
});

// BM25 keyword search over Bee conversations
router.post('/search-keyword', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  const { query: searchQuery, limit = 20 } = req.body;
  if (!searchQuery) return res.status(400).json({ error: 'query is required' });

  try {
    const beeResults = await beeApiPost('/v1/search/conversations', {
      query: searchQuery,
      limit: Math.min(Number(limit), 50)
    }, beeToken);

    const conversations = extractArray(beeResults, 'conversations');
    res.json({
      query: searchQuery,
      count: conversations.length,
      results: conversations.map(c => ({
        type: 'bee_keyword',
        bee_id: c.id || c.conversation_id,
        title: c.title || c.summary?.substring(0, 80) || 'Bee Conversation',
        preview: c.summary || c.snippet || '',
        score: c.score || 0,
        start_time: c.start_time || c.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: `Bee keyword search failed: ${err.message}` });
  }
});

module.exports = router;
