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

function beeApiGet(path, beeToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BEE_API);
    https.get(url, {
      agent: beeAgent,
      headers: { 'Authorization': `Bearer ${beeToken}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid Bee token — run "bee login" on your Mac and copy ~/.bee/token-prod'));
        if (res.statusCode !== 200) return reject(new Error(`Bee API ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Bee API')); }
      });
    }).on('error', reject);
  });
}

// Get the Bee token from env or request
function getBeeToken(req) {
  return req.headers['x-bee-token'] || req.body?.bee_token || process.env.BEE_API_TOKEN || '';
}

// ============================================================
// CLOUD SYNC — calls Bee API directly from Railway
// POST /api/bee/sync
// Headers: X-Bee-Token: your-bee-token (or set BEE_API_TOKEN env var)
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
  const results = { facts: 0, todos: 0, conversations: 0, skipped: 0, purged: false, errors: [] };

  // --- Force mode: purge existing Bee data first ---
  if (force) {
    await query(`DELETE FROM knowledge WHERE ai_source = 'bee'`);
    await query(`DELETE FROM tasks WHERE ai_agent = 'bee'`);
    await query(`DELETE FROM transcripts WHERE source = 'bee'`);
    results.purged = true;
  }

  // --- Sync Facts (both confirmed and unconfirmed) ---
  for (const confirmed of [true, false]) {
    try {
      let cursor = null;
      let hasMore = true;
      while (hasMore) {
        const url = `/v1/facts?limit=250&confirmed=${confirmed}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const data = await beeApiGet(url, beeToken);
        const facts = Array.isArray(data) ? data : (data.facts || data.items || data.data || []);
        cursor = data.next_cursor || null;
        for (const fact of facts) {
          if (!fact.text) continue;
          if (!force) {
            const existing = await query(
              `SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`,
              [`%${fact.text.substring(0, 100)}%`]
            );
            if (existing.rows.length > 0) { results.skipped++; continue; }
          }

          await query(`
            INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
            VALUES ($1, $2, 'personal', $3, 'bee', 'bee', $4)
          `, [
            `Bee Fact: ${fact.text.substring(0, 80)}`,
            fact.text,
            JSON.stringify(['bee', 'fact', confirmed ? 'confirmed' : 'unconfirmed']),
            JSON.stringify({ bee_id: fact.id, confirmed: fact.confirmed })
          ]);
          results.facts++;
        }
        hasMore = facts.length > 0 && !!cursor;
      }
    } catch (e) {
      results.errors.push(`Facts (confirmed=${confirmed}): ${e.message}`);
    }
  }

  // --- Sync Todos ---
  try {
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const url = `/v1/todos?limit=250` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const todos = Array.isArray(data) ? data : (data.todos || data.items || data.data || []);
      cursor = data.next_cursor || null;
      for (const todo of todos) {
        if (!todo.text) continue;
        if (!force) {
          const existing = await query(
            `SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`,
            [todo.text]
          );
          if (existing.rows.length > 0) { results.skipped++; continue; }
        }

        await query(`
          INSERT INTO tasks (title, status, priority, ai_agent, next_steps)
          VALUES ($1, $2, 'medium', 'bee', $3)
        `, [
          todo.text,
          todo.completed ? 'done' : 'todo',
          todo.id ? `Bee Todo ID: ${todo.id}` : null
        ]);
        results.todos++;
      }
      hasMore = todos.length > 0 && !!cursor;
    }
  } catch (e) {
    results.errors.push(`Todos: ${e.message}`);
  }

  // --- Sync Conversations ---
  try {
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const url = `/v1/conversations?limit=50` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const convos = Array.isArray(data) ? data : (data.conversations || data.items || data.data || []);
      cursor = data.next_cursor || null;
      for (const convo of convos) {
        const beeId = convo.id;
        if (!beeId) continue;

        if (!force) {
          const existing = await query(
            `SELECT id FROM transcripts WHERE metadata::text ILIKE $1 AND source = 'bee'`,
            [`%${beeId}%`]
          );
          if (existing.rows.length > 0) { results.skipped++; continue; }
        }

        // Use summary from list response if available; fetch detail for transcript
        let summary = convo.summary || null;
        let rawText = summary || '';
        let full = convo;

        // Try to get full conversation detail for transcript
        try {
          const detail = await beeApiGet(`/v1/conversations/${beeId}`, beeToken);
          full = detail.conversation || detail;
          rawText = full.transcript || full.full_transcript || full.text || full.summary || summary || '';
          if (full.summary) summary = full.summary;
        } catch (e) {
          // Fall back to list-level data
          if (!rawText) {
            results.errors.push(`Conversation ${beeId}: ${e.message}`);
            continue;
          }
        }

        if (!rawText) continue;

        const title = full.short_summary || convo.short_summary ||
          (summary ? summary.substring(0, 80) : null) ||
          `Bee Conversation ${convo.created_at ? new Date(convo.created_at).toLocaleDateString() : ''}`;

        const durationMs = (convo.end_time && convo.start_time) ? convo.end_time - convo.start_time : null;
        const durationSec = durationMs ? Math.round(durationMs / 1000) : (full.duration_seconds || null);

        const result = await query(`
          INSERT INTO transcripts (title, raw_text, summary, source, duration_seconds, recorded_at, tags, metadata)
          VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7)
          RETURNING id
        `, [
          title.substring(0, 200),
          rawText,
          summary,
          durationSec,
          convo.start_time ? new Date(convo.start_time).toISOString() : (convo.created_at ? new Date(convo.created_at).toISOString() : null),
          JSON.stringify(['bee', 'conversation']),
          JSON.stringify({
            bee_id: beeId,
            utterances_count: convo.utterances_count || null,
            location: convo.primary_location?.address || null,
            state: convo.state || null
          })
        ]);

        await query(`
          INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
          VALUES ($1, $2, 'meeting', $3, 'bee', 'bee', $4)
        `, [
          title.substring(0, 200),
          (summary || rawText).substring(0, 5000),
          JSON.stringify(['bee', 'conversation']),
          JSON.stringify({ transcript_id: result.rows[0].id, bee_id: beeId })
        ]);

        results.conversations++;
      }
      hasMore = convos.length > 0 && !!cursor;
    }
  } catch (e) {
    results.errors.push(`Conversations: ${e.message}`);
  }

  await query(`
    INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
    VALUES ('create', 'bee-import', 'cloud-sync', 'bee', $1)
  `, [`Cloud sync${force ? ' (full)' : ''}: ${results.facts} facts, ${results.todos} todos, ${results.conversations} conversations (${results.skipped} skipped)`]);

  res.json({ message: `Bee cloud sync complete${force ? ' (full refresh)' : ''}`, imported: results });
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
        if (!fact.text) continue;
        const existing = await query(
          `SELECT id FROM knowledge WHERE content ILIKE $1 AND ai_source = 'bee'`,
          [`%${fact.text.substring(0, 100)}%`]
        );
        if (existing.rows.length > 0) { results.skipped++; continue; }

        await query(`
          INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
          VALUES ($1, $2, 'personal', $3, 'bee', 'bee', $4)
        `, [
          `Bee Fact: ${fact.text.substring(0, 80)}`,
          fact.text,
          JSON.stringify(fact.tags || ['bee', 'fact']),
          JSON.stringify({ bee_id: fact.id, confirmed: fact.confirmed || false })
        ]);
        results.facts++;
      }
    }

    if (Array.isArray(todos)) {
      for (const todo of todos) {
        if (!todo.text) continue;
        const existing = await query(
          `SELECT id FROM tasks WHERE title = $1 AND ai_agent = 'bee'`,
          [todo.text]
        );
        if (existing.rows.length > 0) { results.skipped++; continue; }

        await query(`
          INSERT INTO tasks (title, status, priority, ai_agent, next_steps)
          VALUES ($1, $2, 'medium', 'bee', $3)
        `, [todo.text, todo.completed ? 'done' : 'todo', todo.id ? `Bee Todo ID: ${todo.id}` : null]);
        results.todos++;
      }
    }

    if (Array.isArray(conversations)) {
      for (const convo of conversations) {
        if (!convo.text && !convo.raw_text) continue;
        const rawText = convo.raw_text || convo.text;
        const title = convo.title || `Bee Conversation ${convo.date || new Date().toLocaleDateString()}`;

        const existing = await query(
          `SELECT id FROM transcripts WHERE title = $1 AND source = 'bee'`,
          [title]
        );
        if (existing.rows.length > 0) { results.skipped++; continue; }

        const result = await query(`
          INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata)
          VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7, $8)
          RETURNING id
        `, [
          title, rawText, convo.summary || null,
          JSON.stringify(convo.speakers || []), convo.duration_seconds || null,
          convo.date || convo.recorded_at || null,
          JSON.stringify(convo.tags || ['bee', 'conversation']),
          JSON.stringify({ bee_id: convo.id || null })
        ]);

        await query(`
          INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
          VALUES ($1, $2, 'meeting', $3, 'bee', 'bee', $4)
        `, [
          title, (convo.summary || rawText).substring(0, 5000),
          JSON.stringify(convo.tags || ['bee', 'conversation']),
          JSON.stringify({ transcript_id: result.rows[0].id, bee_id: convo.id || null })
        ]);
        results.conversations++;
      }
    }

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('create', 'bee-import', 'bulk', 'bee', $1)
    `, [`Bee import: ${results.facts} facts, ${results.todos} todos, ${results.conversations} conversations (${results.skipped} skipped)`]);

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

  // Test /v1/me (identity)
  try {
    results.me = await beeApiGet('/v1/me', beeToken);
  } catch (e) {
    results.me_error = e.message;
  }

  // Test facts
  try {
    results.facts_raw = await beeApiGet('/v1/facts?page=1&limit=3&confirmed=true', beeToken);
  } catch (e) {
    results.facts_error = e.message;
  }

  // Test todos
  try {
    results.todos_raw = await beeApiGet('/v1/todos?page=1&limit=3', beeToken);
  } catch (e) {
    results.todos_error = e.message;
  }

  // Test conversations
  try {
    results.conversations_raw = await beeApiGet('/v1/conversations?page=1&limit=3', beeToken);
  } catch (e) {
    results.conversations_error = e.message;
  }

  res.json(results);
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
      last_import: lastImport.rows[0]?.created_at || null,
      bee_token_configured: !!process.env.BEE_API_TOKEN
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
