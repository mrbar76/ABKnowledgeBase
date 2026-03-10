const express = require('express');
const https = require('https');
const {
  queryDatabase, createPage, updatePage, archivePage,
  pageToKnowledge, pageToFact, pageToTask, pageToTranscript,
  richText, dateOrNull, selectOrNull, multiSelect,
  logActivity, textToBlocks, richTextToString
} = require('../notion');
const syncStatus = require('../sync-status');
const router = express.Router();

// --- Bee Cloud API (Amazon-hosted) ---
const BEE_API = 'https://app-api-developer.ce.bee.amazon.dev';

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
  });
}

function getBeeToken(req) {
  return req.headers['x-bee-token'] || req.body?.bee_token || process.env.BEE_API_TOKEN || '';
}

function extractFactText(item) {
  if (typeof item === 'string') return item;
  return item.text || item.content || item.body || item.description || item.value || item.fact || null;
}

function extractTodoText(item) {
  if (typeof item === 'string') return item;
  return item.text || item.content || item.title || item.body || item.description || item.task || null;
}

function extractArray(data, primaryKey) {
  if (Array.isArray(data)) return data;
  if (data[primaryKey] && Array.isArray(data[primaryKey])) return data[primaryKey];
  for (const key of ['items', 'results', 'data']) {
    if (data[key] && Array.isArray(data[key])) return data[key];
  }
  const found = Object.values(data).find(v => Array.isArray(v));
  return found || [];
}

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

function buildConversationText(detail, listItem) {
  const convoStartTime = listItem.start_time || detail.start_time || null;
  const transcript = extractTranscript(detail, convoStartTime);
  return transcript || detail.summary || listItem.summary || '';
}

// ─── Notion dedup helpers ─────────────────────────────────────────

async function findExistingFact(contentPrefix) {
  try {
    const result = await queryDatabase('facts', {
      and: [
        { property: 'Source', select: { equals: 'bee' } },
        { property: 'Content', rich_text: { contains: contentPrefix.substring(0, 100) } },
      ]
    }, undefined, 1);
    return result.results[0] || null;
  } catch { return null; }
}

async function findExistingKnowledge(contentPrefix, aiSource) {
  try {
    const result = await queryDatabase('knowledge', {
      and: [
        { property: 'AI Source', select: { equals: aiSource || 'bee' } },
        { property: 'Content', rich_text: { contains: contentPrefix.substring(0, 100) } },
      ]
    }, undefined, 1);
    return result.results[0] || null;
  } catch { return null; }
}

async function findExistingTask(title) {
  try {
    const result = await queryDatabase('tasks', {
      and: [
        { property: 'AI Agent', select: { equals: 'bee' } },
        { property: 'Title', title: { equals: title } },
      ]
    }, undefined, 1);
    return result.results[0] || null;
  } catch { return null; }
}

async function findExistingTranscript(beeId) {
  try {
    const result = await queryDatabase('transcripts', {
      and: [
        { property: 'Source', select: { equals: 'bee' } },
        { property: 'Bee ID', rich_text: { contains: beeId } },
      ]
    }, undefined, 1);
    return result.results[0] || null;
  } catch { return null; }
}

// ─── Counts ───────────────────────────────────────────────────────

router.get('/counts', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  const counts = {};

  try {
    const data = await beeApiGet('/v1/facts?limit=1', beeToken);
    counts.facts = data.total || data.total_count || data.count || extractArray(data, 'facts').length || 0;
  } catch (e) { counts.facts_error = e.message; }

  try {
    const data = await beeApiGet('/v1/todos?limit=1', beeToken);
    counts.todos = data.total || data.total_count || data.count || extractArray(data, 'todos').length || 0;
  } catch (e) { counts.todos_error = e.message; }

  try {
    const data = await beeApiGet('/v1/conversations?limit=1&created_after=2024-01-01', beeToken);
    counts.conversations = data.total || data.total_count || data.count || extractArray(data, 'conversations').length || 0;
  } catch (e) { counts.conversations_error = e.message; }

  try {
    const data = await beeApiGet('/v1/journals?limit=1', beeToken);
    counts.journals = data.total || data.total_count || data.count || extractArray(data, 'journals').length || 0;
  } catch (e) { counts.journals_error = e.message; }

  try {
    const data = await beeApiGet('/v1/daily?limit=1', beeToken);
    counts.daily = data.total || data.total_count || data.count || extractArray(data, 'daily').length || 0;
  } catch (e) { counts.daily_error = e.message; }

  res.json(counts);
});

// ─── Full Sync → Notion ──────────────────────────────────────────

router.post('/sync', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) {
    return res.status(400).json({
      error: 'Bee token required. Set BEE_API_TOKEN env var or pass X-Bee-Token header.',
    });
  }

  const force = req.body?.force === true;
  const job = syncStatus.startJob('bee', force ? 'Full sync (force refresh)' : 'Full cloud sync');
  const results = { facts: 0, todos: 0, conversations: 0, journals: 0, daily: 0, skipped: 0, errors: [] };

  // --- Sync Facts ---
  try {
    let cursor = null;
    do {
      const url = '/v1/facts' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const facts = extractArray(data, 'facts');
      cursor = data.next_cursor || null;
      console.log(`[bee-sync] Facts: ${facts.length} items`);

      for (const fact of facts) {
        const factText = extractFactText(fact);
        if (!factText) continue;
        if (!force) {
          const existing = await findExistingFact(factText);
          if (existing) { results.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const factDate = fact.created_at ? new Date(fact.created_at).toISOString() : (fact.updated_at ? new Date(fact.updated_at).toISOString() : now);
        await createPage('facts', {
          Title: { title: richText(factText.substring(0, 80)) },
          Content: { rich_text: richText(factText) },
          Category: { select: selectOrNull('personal') },
          Tags: { multi_select: multiSelect(['bee', fact.confirmed ? 'confirmed' : 'unconfirmed']) },
          Source: { select: selectOrNull('bee') },
          Confirmed: { checkbox: !!fact.confirmed },
          'Created At': { date: dateOrNull(factDate) },
          'Updated At': { date: dateOrNull(now) },
        });
        results.facts++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Facts: ${e.message}`);
  }

  // --- Sync Todos ---
  try {
    let cursor = null;
    do {
      const url = '/v1/todos' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const todos = extractArray(data, 'todos');
      cursor = data.next_cursor || null;
      console.log(`[bee-sync] Todos: ${todos.length} items`);

      for (const todo of todos) {
        const todoText = extractTodoText(todo);
        if (!todoText) continue;
        if (!force) {
          const existing = await findExistingTask(todoText);
          if (existing) { results.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const todoDate = todo.created_at ? new Date(todo.created_at).toISOString() : (todo.updated_at ? new Date(todo.updated_at).toISOString() : now);
        await createPage('tasks', {
          Title: { title: richText(todoText) },
          Status: { select: selectOrNull(todo.completed ? 'done' : 'todo') },
          Priority: { select: selectOrNull('medium') },
          'AI Agent': { select: selectOrNull('bee') },
          'Next Steps': { rich_text: richText(todo.id ? `Bee Todo ID: ${todo.id}` : '') },
          'Created At': { date: dateOrNull(todoDate) },
          'Updated At': { date: dateOrNull(now) },
        });
        results.todos++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Todos: ${e.message}`);
  }

  // --- Sync Conversations ---
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
          const existing = await findExistingTranscript(beeId);
          if (existing) { results.skipped++; continue; }
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
        const now = new Date().toISOString();

        await createPage('transcripts', {
          Title: { title: richText(title.substring(0, 200)) },
          Summary: { rich_text: richText(summary || rawText.substring(0, 2000)) },
          Source: { select: selectOrNull('bee') },
          'Duration (sec)': { number: durationSec },
          'Recorded At': { date: dateOrNull(recordedAt) },
          Location: { rich_text: richText(location || '') },
          Tags: { multi_select: multiSelect(['bee', 'conversation']) },
          'Bee ID': { rich_text: richText(beeId) },
          'Created At': { date: dateOrNull(now) },
          'Updated At': { date: dateOrNull(now) },
        }, textToBlocks(rawText));

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

      for (const journal of journals) {
        const jText = journal.text || journal.content || journal.body || journal.markdown || '';
        const jTitle = journal.title || journal.short_summary || (jText ? jText.substring(0, 80) : `Journal ${journal.id}`);
        if (!jText && !journal.summary) continue;
        if (!force) {
          const existing = await findExistingKnowledge(jText || journal.summary, 'bee');
          if (existing) { results.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const journalDate = journal.created_at ? new Date(journal.created_at).toISOString() : (journal.date ? new Date(journal.date).toISOString() : now);
        await createPage('knowledge', {
          Title: { title: richText(jTitle.substring(0, 200)) },
          Content: { rich_text: richText((jText || journal.summary).substring(0, 2000)) },
          Category: { select: selectOrNull('journal') },
          Tags: { multi_select: multiSelect(['bee', 'journal']) },
          Source: { select: selectOrNull('bee') },
          'AI Source': { select: selectOrNull('bee') },
          'Created At': { date: dateOrNull(journalDate) },
          'Updated At': { date: dateOrNull(now) },
        });
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

      for (const day of dailies) {
        const dText = day.text || day.content || day.body || day.summary || day.markdown || '';
        if (!dText) continue;
        const dDate = day.date || day.created_at || '';
        const dTitle = day.title || `Daily Summary ${dDate ? new Date(dDate).toLocaleDateString() : day.id}`;
        if (!force) {
          const existing = await findExistingKnowledge(dText, 'bee');
          if (existing) { results.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const dailyDate = dDate ? new Date(dDate).toISOString() : now;
        await createPage('knowledge', {
          Title: { title: richText(dTitle.substring(0, 200)) },
          Content: { rich_text: richText(dText.substring(0, 2000)) },
          Category: { select: selectOrNull('daily-summary') },
          Tags: { multi_select: multiSelect(['bee', 'daily-summary']) },
          Source: { select: selectOrNull('bee') },
          'AI Source': { select: selectOrNull('bee') },
          'Created At': { date: dateOrNull(dailyDate) },
          'Updated At': { date: dateOrNull(now) },
        });
        results.daily++;
      }
    } while (cursor);
  } catch (e) {
    results.errors.push(`Daily: ${e.message}`);
  }

  await logActivity('sync', 'bee-import', 'cloud-sync', 'bee',
    `Cloud sync${force ? ' (full)' : ''}: ${results.facts}F ${results.todos}T ${results.conversations}C ${results.journals}J ${results.daily}D (${results.skipped} skipped)`);

  const totalImported = results.facts + results.todos + results.conversations + results.journals + results.daily;
  syncStatus.completeJob('bee', job, {
    imported: totalImported,
    skipped: results.skipped,
    errors: results.errors,
    details: { facts: results.facts, todos: results.todos, conversations: results.conversations, journals: results.journals, daily: results.daily },
  });

  res.json({ message: `Bee cloud sync complete${force ? ' (full refresh)' : ''}`, imported: results });
});

// ─── Chunked sync (one page per request, avoids Railway timeout) ──

router.post('/sync-chunk', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  const { type, cursor, force } = req.body;
  if (!type) return res.status(400).json({ error: 'type required (facts, todos, conversations, journals, daily)' });

  const result = { imported: 0, skipped: 0, errors: [], cursor: null, done: false };

  try {
    if (type === 'facts') {
      const url = '/v1/facts' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const facts = extractArray(data, 'facts');
      result.cursor = data.next_cursor || null;
      result.debug_keys = facts.length > 0 ? Object.keys(facts[0]) : [];

      for (const fact of facts) {
        const factText = extractFactText(fact);
        if (!factText) continue;
        if (!force) {
          const existing = await findExistingFact(factText);
          if (existing) { result.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const factDate = fact.created_at ? new Date(fact.created_at).toISOString() : (fact.updated_at ? new Date(fact.updated_at).toISOString() : now);
        await createPage('facts', {
          Title: { title: richText(factText.substring(0, 80)) },
          Content: { rich_text: richText(factText) },
          Category: { select: selectOrNull('personal') },
          Tags: { multi_select: multiSelect(['bee', fact.confirmed ? 'confirmed' : 'unconfirmed']) },
          Source: { select: selectOrNull('bee') },
          Confirmed: { checkbox: !!fact.confirmed },
          'Created At': { date: dateOrNull(factDate) },
          'Updated At': { date: dateOrNull(now) },
        });
        result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else if (type === 'todos') {
      const url = '/v1/todos' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const todos = extractArray(data, 'todos');
      result.cursor = data.next_cursor || null;
      result.debug_keys = todos.length > 0 ? Object.keys(todos[0]) : [];

      for (const todo of todos) {
        const todoText = extractTodoText(todo);
        if (!todoText) continue;
        if (!force) {
          const existing = await findExistingTask(todoText);
          if (existing) { result.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const todoDate = todo.created_at ? new Date(todo.created_at).toISOString() : (todo.updated_at ? new Date(todo.updated_at).toISOString() : now);
        await createPage('tasks', {
          Title: { title: richText(todoText) },
          Status: { select: selectOrNull(todo.completed ? 'done' : 'todo') },
          Priority: { select: selectOrNull('medium') },
          'AI Agent': { select: selectOrNull('bee') },
          'Next Steps': { rich_text: richText(todo.id ? `Bee Todo ID: ${todo.id}` : '') },
          'Created At': { date: dateOrNull(todoDate) },
          'Updated At': { date: dateOrNull(now) },
        });
        result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else if (type === 'conversations') {
      const url = `/v1/conversations?limit=5&created_after=2024-01-01` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const convos = extractArray(data, 'conversations');
      result.cursor = data.next_cursor || null;
      result.debug_keys = convos.length > 0 ? Object.keys(convos[0]) : [];
      const skip_reasons = { capturing: 0, duplicate: 0, noId: 0, noText: 0, fetchError: 0 };
      let dateRange = { earliest: null, latest: null };

      for (const convo of convos) {
        const beeId = convo.id;
        if (!beeId) { skip_reasons.noId++; result.skipped++; continue; }
        if (!force) {
          const existing = await findExistingTranscript(beeId);
          if (existing) { skip_reasons.duplicate++; result.skipped++; continue; }
        }
        if (convo.state === 'CAPTURING') { skip_reasons.capturing++; result.skipped++; continue; }

        let summary = convo.summary || null;
        let full = convo;
        try {
          const detail = await beeApiGet(`/v1/conversations/${beeId}`, beeToken);
          full = detail.conversation || detail;
          if (full.summary) summary = full.summary;
        } catch (e) {
          if (!summary) { skip_reasons.fetchError++; result.errors.push(`Conversation ${beeId}: ${e.message}`); continue; }
        }

        const rawText = buildConversationText(full, convo);
        if (!rawText) { skip_reasons.noText++; result.skipped++; continue; }

        const title = full.short_summary || convo.short_summary ||
          (summary ? summary.substring(0, 80) : null) ||
          `Bee Conversation ${convo.created_at ? new Date(convo.created_at).toLocaleDateString() : ''}`;

        const durationMs = (convo.end_time && convo.start_time) ? convo.end_time - convo.start_time : null;
        const durationSec = durationMs ? Math.round(durationMs / 1000) : (full.duration_seconds || null);
        const recordedAt = convo.start_time ? new Date(convo.start_time).toISOString()
          : (convo.created_at ? new Date(convo.created_at).toISOString() : null);
        const location = convo.primary_location?.address || full.primary_location?.address || null;
        const now = new Date().toISOString();

        // Track date range
        if (recordedAt) {
          if (!dateRange.earliest || recordedAt < dateRange.earliest) dateRange.earliest = recordedAt;
          if (!dateRange.latest || recordedAt > dateRange.latest) dateRange.latest = recordedAt;
        }

        await createPage('transcripts', {
          Title: { title: richText(title.substring(0, 200)) },
          Summary: { rich_text: richText(summary || rawText.substring(0, 2000)) },
          Source: { select: selectOrNull('bee') },
          'Duration (sec)': { number: durationSec },
          'Recorded At': { date: dateOrNull(recordedAt) },
          Location: { rich_text: richText(location || '') },
          Tags: { multi_select: multiSelect(['bee', 'conversation']) },
          'Bee ID': { rich_text: richText(beeId) },
          'Created At': { date: dateOrNull(recordedAt || now) },
          'Updated At': { date: dateOrNull(now) },
        }, textToBlocks(rawText));

        result.imported++;
      }
      result.skip_reasons = skip_reasons;
      result.date_range = dateRange;
      if (!result.cursor) result.done = true;

    } else if (type === 'journals') {
      const url = '/v1/journals' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const journals = extractArray(data, 'journals');
      result.cursor = data.next_cursor || null;

      for (const journal of journals) {
        const jText = journal.text || journal.content || journal.body || journal.markdown || '';
        const jTitle = journal.title || journal.short_summary || (jText ? jText.substring(0, 80) : `Journal ${journal.id}`);
        if (!jText && !journal.summary) continue;
        if (!force) {
          const existing = await findExistingKnowledge(jText || journal.summary, 'bee');
          if (existing) { result.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const journalDate = journal.created_at ? new Date(journal.created_at).toISOString() : (journal.date ? new Date(journal.date).toISOString() : now);
        await createPage('knowledge', {
          Title: { title: richText(jTitle.substring(0, 200)) },
          Content: { rich_text: richText((jText || journal.summary).substring(0, 2000)) },
          Category: { select: selectOrNull('journal') },
          Tags: { multi_select: multiSelect(['bee', 'journal']) },
          Source: { select: selectOrNull('bee') },
          'AI Source': { select: selectOrNull('bee') },
          'Created At': { date: dateOrNull(journalDate) },
          'Updated At': { date: dateOrNull(now) },
        });
        result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else if (type === 'daily') {
      const url = '/v1/daily' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const dailies = extractArray(data, 'daily');
      result.cursor = data.next_cursor || null;

      for (const day of dailies) {
        const dText = day.text || day.content || day.body || day.summary || day.markdown || '';
        if (!dText) continue;
        const dDate = day.date || day.created_at || '';
        const dTitle = day.title || `Daily Summary ${dDate ? new Date(dDate).toLocaleDateString() : day.id}`;
        if (!force) {
          const existing = await findExistingKnowledge(dText, 'bee');
          if (existing) { result.skipped++; continue; }
        }
        const now = new Date().toISOString();
        const dailyDate = dDate ? new Date(dDate).toISOString() : now;
        await createPage('knowledge', {
          Title: { title: richText(dTitle.substring(0, 200)) },
          Content: { rich_text: richText(dText.substring(0, 2000)) },
          Category: { select: selectOrNull('daily-summary') },
          Tags: { multi_select: multiSelect(['bee', 'daily-summary']) },
          Source: { select: selectOrNull('bee') },
          'AI Source': { select: selectOrNull('bee') },
          'Created At': { date: dateOrNull(dailyDate) },
          'Updated At': { date: dateOrNull(now) },
        });
        result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    result.errors.push(err.message);
  }

  res.json(result);
});

// ─── Purge all Bee data from Notion ──────────────────────────────

router.post('/purge', async (req, res) => {
  try {
    let archived = 0;

    // Purge bee facts
    let hasMore = true;
    while (hasMore) {
      const result = await queryDatabase('facts', {
        property: 'Source', select: { equals: 'bee' }
      }, undefined, 100);
      if (!result.results.length) { hasMore = false; break; }
      for (const page of result.results) {
        try { await archivePage(page.id); archived++; } catch {}
      }
    }

    // Purge bee knowledge entries
    hasMore = true;
    while (hasMore) {
      const result = await queryDatabase('knowledge', {
        property: 'AI Source', select: { equals: 'bee' }
      }, undefined, 100);
      if (!result.results.length) { hasMore = false; break; }
      for (const page of result.results) {
        try { await archivePage(page.id); archived++; } catch {}
      }
    }

    // Purge bee tasks
    hasMore = true;
    while (hasMore) {
      const result = await queryDatabase('tasks', {
        property: 'AI Agent', select: { equals: 'bee' }
      }, undefined, 100);
      if (!result.results.length) { hasMore = false; break; }
      for (const page of result.results) {
        try { await archivePage(page.id); archived++; } catch {}
      }
    }

    // Purge bee transcripts
    hasMore = true;
    while (hasMore) {
      const result = await queryDatabase('transcripts', {
        property: 'Source', select: { equals: 'bee' }
      }, undefined, 100);
      if (!result.results.length) { hasMore = false; break; }
      for (const page of result.results) {
        try { await archivePage(page.id); archived++; } catch {}
      }
    }

    await logActivity('purge', 'bee-import', 'purge', 'bee', `Purged ${archived} Bee entries`);
    res.json({ message: `Purged ${archived} Bee entries`, archived });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Incremental sync (via /v1/changes) → Notion ─────────────────

router.post('/sync-incremental', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });

  try {
    // Get last cursor from activity log
    let lastCursor = null;
    try {
      const cursorResult = await queryDatabase('activity_log', {
        and: [
          { property: 'Action', select: { equals: 'sync' } },
          { property: 'Details', rich_text: { contains: 'cursor:' } },
        ]
      }, [{ property: 'Created At', direction: 'descending' }], 1);
      if (cursorResult.results.length > 0) {
        const details = richTextToString(cursorResult.results[0].properties.Details?.rich_text);
        const match = details.match(/cursor:(\S+)/);
        if (match) lastCursor = match[1];
      }
    } catch { /* first sync */ }

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
        const now = new Date().toISOString();
        const existing = await findExistingFact(fText);
        if (existing) {
          await updatePage(existing.id, {
            Content: { rich_text: richText(fText) },
            'Updated At': { date: dateOrNull(now) },
          });
        } else {
          const factDate = f.created_at ? new Date(f.created_at).toISOString() : now;
          await createPage('facts', {
            Title: { title: richText(fText.substring(0, 80)) },
            Content: { rich_text: richText(fText) },
            Category: { select: selectOrNull('personal') },
            Tags: { multi_select: multiSelect(['bee']) },
            Source: { select: selectOrNull('bee') },
            Confirmed: { checkbox: !!f.confirmed },
            'Created At': { date: dateOrNull(factDate) },
            'Updated At': { date: dateOrNull(now) },
          });
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
        const now = new Date().toISOString();
        const existing = await findExistingTask(tText);
        if (existing) {
          await updatePage(existing.id, {
            Status: { select: selectOrNull(t.completed ? 'done' : 'todo') },
            'Updated At': { date: dateOrNull(now) },
          });
        } else {
          await createPage('tasks', {
            Title: { title: richText(tText) },
            Status: { select: selectOrNull(t.completed ? 'done' : 'todo') },
            Priority: { select: selectOrNull('medium') },
            'AI Agent': { select: selectOrNull('bee') },
            'Created At': { date: dateOrNull(now) },
            'Updated At': { date: dateOrNull(now) },
          });
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
        const durationSec = durationMs ? Math.round(durationMs / 1000) : null;
        const recordedAt = c.start_time ? new Date(c.start_time).toISOString() : null;
        const location = c.primary_location?.address || null;
        const now = new Date().toISOString();

        const existing = await findExistingTranscript(convoId);
        if (existing) {
          await updatePage(existing.id, {
            Summary: { rich_text: richText(c.summary || rawText.substring(0, 2000)) },
            'Updated At': { date: dateOrNull(now) },
          });
        } else {
          await createPage('transcripts', {
            Title: { title: richText(title.substring(0, 200)) },
            Summary: { rich_text: richText(c.summary || rawText.substring(0, 2000)) },
            Source: { select: selectOrNull('bee') },
            'Duration (sec)': { number: durationSec },
            'Recorded At': { date: dateOrNull(recordedAt) },
            Location: { rich_text: richText(location || '') },
            Tags: { multi_select: multiSelect(['bee', 'conversation']) },
            'Bee ID': { rich_text: richText(convoId) },
            'Created At': { date: dateOrNull(now) },
            'Updated At': { date: dateOrNull(now) },
          }, textToBlocks(rawText));
        }
        results.conversations++;
      } catch (e) { results.errors.push(`conversation ${convoId}: ${e.message}`); }
    }

    if (newCursor) {
      await logActivity('sync', 'bee-import', 'cursor', 'bee', `cursor:${newCursor}`);
    }

    await logActivity('sync', 'bee-import', 'incremental', 'bee',
      `Incremental: ${results.facts}F ${results.todos}T ${results.conversations}C`);

    res.json({ message: 'Incremental sync complete', imported: results, changes_processed: changes.length, had_cursor: !!lastCursor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bee status ──────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const [factsRes, knowledgeRes, tasksRes, transcriptsRes] = await Promise.all([
      queryDatabase('facts', { property: 'Source', select: { equals: 'bee' } }, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('knowledge', { property: 'AI Source', select: { equals: 'bee' } }, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('tasks', { property: 'AI Agent', select: { equals: 'bee' } }, undefined, 100).catch(() => ({ results: [] })),
      queryDatabase('transcripts', { property: 'Source', select: { equals: 'bee' } }, undefined, 100).catch(() => ({ results: [] })),
    ]);

    const knowledge = knowledgeRes.results.map(pageToKnowledge);
    res.json({
      facts: factsRes.results.length,
      tasks: tasksRes.results.length,
      transcripts: transcriptsRes.results.length,
      journals: knowledge.filter(k => k.category === 'journal').length,
      daily: knowledge.filter(k => k.category === 'daily-summary').length,
      bee_token_configured: !!process.env.BEE_API_TOKEN,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bee neural search proxy ─────────────────────────────────────

function beeApiPost(path, body, beeToken, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BEE_API);
    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST', agent: beeAgent,
      headers: { 'Authorization': `Bearer ${beeToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Bee API ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

router.post('/search', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  const { query: q, limit = 20 } = req.body;
  if (!q) return res.status(400).json({ error: 'query is required' });

  try {
    const beeResults = await beeApiPost('/v1/search/conversations/neural', { query: q, limit: Math.min(Number(limit), 50) }, beeToken);
    const conversations = extractArray(beeResults, 'conversations');
    res.json({
      query: q, count: conversations.length,
      results: conversations.map(c => ({
        type: 'bee_neural', bee_id: c.id, title: c.title || c.summary?.substring(0, 80) || 'Bee Conversation',
        preview: c.summary || c.snippet || '', score: c.score || 0, start_time: c.start_time || c.created_at,
      }))
    });
  } catch (err) {
    res.status(500).json({ error: `Bee neural search failed: ${err.message}` });
  }
});

module.exports = router;
