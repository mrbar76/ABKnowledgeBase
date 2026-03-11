const express = require('express');
const https = require('https');
const { pool, query, logActivity } = require('../db');
const syncStatus = require('../sync-status');
const router = express.Router();

// ─── Lazy-loaded OpenAI client ──────────────────────────────
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const OpenAI = require('openai');
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

// ─── Auto AI speaker identification ──────────────────────────
async function autoIdentifySpeakers(transcriptId) {
  try {
    const openai = getOpenAI();
    if (!openai) return; // No OpenAI key configured

    const transcriptResult = await query('SELECT * FROM transcripts WHERE id = $1', [transcriptId]);
    if (!transcriptResult.rows.length) return;
    const t = transcriptResult.rows[0];

    const speakersResult = await query(
      'SELECT * FROM transcript_speakers WHERE transcript_id = $1 ORDER BY utterance_index',
      [transcriptId]
    );
    const speakers = speakersResult.rows;
    if (!speakers.length) return;

    const uniqueSpeakers = [...new Set(speakers.map(s => s.speaker_name))];
    // Only run if there are generic/unknown speaker labels
    const hasGeneric = uniqueSpeakers.some(s => /^(speaker|unknown)/i.test(s));
    if (!hasGeneric) return; // All speakers already named

    const excerpt = speakers.slice(0, 80).map(s => `${s.speaker_name}: ${s.text}`).join('\n');
    if (!excerpt && !t.raw_text) return;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You are analyzing a conversation transcript to identify speakers.

The conversation has these speaker labels: ${uniqueSpeakers.join(', ')}
${t.location ? `Location: ${t.location}` : ''}
${t.title ? `Topic: ${t.title}` : ''}

Based on context clues (names mentioned, relationships, topics discussed, speaking patterns), try to identify who each speaker label actually is.

Return ONLY valid JSON:
{
  "identifications": {
    "<original_label>": {
      "likely_name": "their real name or best guess",
      "confidence": "high" | "medium" | "low",
      "reasoning": "brief reason for identification"
    }
  },
  "relationship_notes": "brief note about the relationship between speakers if apparent"
}

Rules:
- If a speaker says their own name or is addressed by name, that's high confidence
- If you can infer from context (e.g. family member, coworker), that's medium confidence
- If you truly cannot determine, keep the original label and mark low confidence
- Do NOT invent names — only use names actually mentioned or clearly implied in the text` },
        { role: 'user', content: excerpt || t.raw_text.substring(0, 8000) },
      ],
    });

    const text = response.choices[0]?.message?.content || '{}';
    let result;
    try { result = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : { identifications: {} }; }

    const identifications = result.identifications || {};
    const renames = {};
    for (const [original, info] of Object.entries(identifications)) {
      if (info.likely_name && info.likely_name !== original && (info.confidence === 'high' || info.confidence === 'medium')) {
        renames[original] = info.likely_name;
      }
    }

    if (Object.keys(renames).length > 0) {
      for (const [oldName, newName] of Object.entries(renames)) {
        await query(
          'UPDATE transcript_speakers SET speaker_name = $1 WHERE transcript_id = $2 AND speaker_name = $3',
          [newName, transcriptId, oldName]
        );
      }
      const newSpeakerNames = uniqueSpeakers.map(s => renames[s] || s);
      const meta = t.metadata || {};
      meta.speakers = [...new Set(newSpeakerNames)];
      meta.speaker_count = meta.speakers.length;
      meta.ai_speaker_identification = identifications;
      meta.relationship_notes = result.relationship_notes || null;
      await query(
        'UPDATE transcripts SET metadata = $1::jsonb, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(meta), transcriptId]
      );
      await logActivity('update', 'transcript', transcriptId, 'openai',
        `Auto-identified speakers: ${Object.entries(renames).map(([o,n]) => `${o}→${n}`).join(', ')}`);
      console.log(`[auto-identify] transcript ${transcriptId}: ${Object.entries(renames).map(([o,n]) => `${o}→${n}`).join(', ')}`);
    } else {
      console.log(`[auto-identify] transcript ${transcriptId}: no confident identifications`);
    }
  } catch (e) {
    console.log(`[auto-identify] transcript ${transcriptId} failed: ${e.message}`);
    // Non-fatal — don't block sync
  }
}

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
    const req = https.get(url, { agent: beeAgent, headers: { 'Authorization': `Bearer ${beeToken}` } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 5 * 1024 * 1024) { req.destroy(); reject(new Error('Response too large')); } });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid Bee token'));
        if (res.statusCode !== 200) return reject(new Error(`Bee API ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from Bee API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Bee API timeout`)); });
  });
}

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
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
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
  for (const key of ['items', 'results', 'data']) { if (data[key] && Array.isArray(data[key])) return data[key]; }
  const found = Object.values(data).find(v => Array.isArray(v));
  return found || [];
}

function extractTranscript(detail, convoStartTime, listItem) {
  if (detail.transcriptions && Array.isArray(detail.transcriptions) && detail.transcriptions.length > 0) {
    const finalized = detail.transcriptions.find(t => t.realtime === false) || detail.transcriptions[0];
    if (finalized.utterances && finalized.utterances.length > 0) {
      const sorted = [...finalized.utterances].sort((a, b) => (a.start || 0) - (b.start || 0));
      return { text: sorted.map(u => {
        const speaker = u.speaker || u.speaker_name || u.label || 'Speaker';
        const text = u.text || u.content || '';
        let timeStr = '';
        if (convoStartTime && u.start != null) {
          const t = new Date(convoStartTime + (u.start * 1000));
          timeStr = `[${t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}] `;
        }
        return `${timeStr}${speaker}: ${text}`;
      }).join('\n'), utterances: sorted };
    }
  }
  if (detail.utterances && Array.isArray(detail.utterances)) {
    return { text: detail.utterances.map(u => `${u.speaker || 'Speaker'}: ${u.text || ''}`).join('\n'), utterances: detail.utterances };
  }
  // Fallback: use any available text field, including summary — also check the list-level item
  const text = detail.transcript || detail.full_transcript || detail.text || detail.summary || detail.short_summary
    || (listItem && (listItem.summary || listItem.short_summary)) || '';
  return { text, utterances: [] };
}

// ─── Concurrency helper ──────────────────────────────────────────

async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function next() {
    const idx = i++;
    if (idx >= items.length) return;
    results[idx] = await fn(items[idx], idx);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

// ─── PostgreSQL dedup helpers ─────────────────────────────────────

async function findExistingFact(contentPrefix) {
  const r = await query("SELECT id FROM facts WHERE source='bee' AND content ILIKE '%' || $1 || '%' LIMIT 1", [contentPrefix.substring(0, 100)]);
  return r.rows[0] || null;
}
async function findExistingTask(title) {
  const r = await query("SELECT id FROM tasks WHERE ai_agent='bee' AND title = $1 LIMIT 1", [title]);
  return r.rows[0] || null;
}
async function findExistingTranscript(beeId) {
  const r = await query("SELECT id FROM transcripts WHERE bee_id = $1 LIMIT 1", [beeId]);
  return r.rows[0] || null;
}
async function findExistingKnowledge(contentPrefix, aiSource) {
  const r = await query("SELECT id FROM knowledge WHERE ai_source=$1 AND content ILIKE '%' || $2 || '%' LIMIT 1", [aiSource || 'bee', contentPrefix.substring(0, 100)]);
  return r.rows[0] || null;
}

// ─── Store helpers ─────────────────────────────────────────

async function storeFact(factText, fact, client) {
  const q = client || query;
  const factDate = fact.created_at ? new Date(fact.created_at).toISOString() : new Date().toISOString();
  const r = await q(
    `INSERT INTO facts (title, content, category, tags, source, confirmed, created_at)
     VALUES ($1, $2, 'personal', $3::jsonb, 'bee', $4, $5) RETURNING id`,
    [factText.substring(0, 80), factText, JSON.stringify(['bee', fact.confirmed ? 'confirmed' : 'unconfirmed']),
     !!fact.confirmed, factDate]
  );
  return r.rows[0].id;
}

async function storeTodo(todoText, todo, client) {
  const q = client || query;
  const todoDate = todo.created_at ? new Date(todo.created_at).toISOString() : new Date().toISOString();
  const r = await q(
    `INSERT INTO tasks (title, status, priority, ai_agent, next_steps, created_at)
     VALUES ($1, $2, 'medium', 'bee', $3, $4) RETURNING id`,
    [todoText, todo.completed ? 'done' : 'todo', todo.id ? `Bee Todo ID: ${todo.id}` : '', todoDate]
  );
  return r.rows[0].id;
}

async function storeConversation(convo, full, rawResult, client) {
  const q = client || query;
  const title = (full.short_summary || convo.short_summary || (full.summary ? full.summary.substring(0, 80) : null) ||
    `Bee Conversation ${convo.created_at ? new Date(convo.created_at).toLocaleDateString() : ''}`).substring(0, 200);
  const durationMs = (convo.end_time && convo.start_time) ? convo.end_time - convo.start_time : null;
  const durationSec = durationMs ? Math.round(durationMs / 1000) : (full.duration_seconds || null);
  const recordedAt = convo.start_time ? new Date(convo.start_time).toISOString() : (convo.created_at ? new Date(convo.created_at).toISOString() : null);
  const location = convo.primary_location?.address || full.primary_location?.address || null;

  const endedAt = convo.end_time ? new Date(convo.end_time).toISOString() : null;
  const speakerNames = rawResult.utterances && rawResult.utterances.length
    ? [...new Set(rawResult.utterances.map(u => u.speaker || u.speaker_name || u.label || 'Speaker'))]
    : [];
  const meta = {
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(full.short_summary ? { short_summary: full.short_summary } : {}),
    ...(convo.short_summary ? { short_summary: convo.short_summary } : {}),
    speakers: speakerNames,
    speaker_count: speakerNames.length,
    utterance_count: rawResult.utterances ? rawResult.utterances.length : 0,
  };

  const r = await q(
    `INSERT INTO transcripts (title, raw_text, summary, source, duration_seconds, recorded_at, location, tags, bee_id, metadata)
     VALUES ($1, $2, $3, 'bee', $4, $5, $6, $7::jsonb, $8, $9::jsonb) RETURNING id`,
    [title, rawResult.text, full.summary || (rawResult.text || '').substring(0, 2000),
     durationSec, recordedAt, location, JSON.stringify(['bee', 'conversation']), convo.id, JSON.stringify(meta)]
  );
  const transcriptId = r.rows[0].id;

  // Batch-insert speaker utterances in chunks of 100
  const utterances = rawResult.utterances || [];
  if (utterances.length > 0) {
    const CHUNK = 100;
    for (let off = 0; off < utterances.length; off += CHUNK) {
      const batch = utterances.slice(off, off + CHUNK);
      const values = [];
      const params = [];
      let pi = 1;
      for (let i = 0; i < batch.length; i++) {
        const u = batch[i];
        const idx = off + i;
        const convoStartTime = convo.start_time || full.start_time || null;
        const spokenAt = convoStartTime && u.start != null ? new Date(convoStartTime + (u.start * 1000)).toISOString() : null;
        values.push(`($${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},$${pi+7})`);
        params.push(
          transcriptId, u.speaker || u.speaker_name || u.label || 'Speaker', idx,
          u.text || u.content || '', spokenAt,
          u.start != null ? Math.round(u.start * 1000) : null,
          u.end != null ? Math.round(u.end * 1000) : null,
          u.confidence || null
        );
        pi += 8;
      }
      await q(
        `INSERT INTO transcript_speakers (transcript_id, speaker_name, utterance_index, text, spoken_at, start_offset_ms, end_offset_ms, confidence)
         VALUES ${values.join(',')}`,
        params
      );
    }
  }
  return transcriptId;
}

async function storeJournal(journal, client) {
  const q = client || query;
  const jText = journal.text || journal.content || journal.body || journal.markdown || '';
  const jTitle = (journal.title || journal.short_summary || (jText ? jText.substring(0, 80) : `Journal ${journal.id}`)).substring(0, 200);
  const journalDate = journal.created_at ? new Date(journal.created_at).toISOString() : (journal.date ? new Date(journal.date).toISOString() : new Date().toISOString());

  await q(
    `INSERT INTO knowledge (title, content, category, tags, source, ai_source, created_at)
     VALUES ($1, $2, 'journal', $3::jsonb, 'bee', 'bee', $4)`,
    [jTitle, (jText || journal.summary).substring(0, 50000), JSON.stringify(['bee', 'journal']), journalDate]
  );
}

async function storeDaily(day, client) {
  const q = client || query;
  const dText = day.text || day.content || day.body || day.summary || day.markdown || '';
  const dDate = day.date || day.created_at || '';
  const dTitle = (day.title || `Daily Summary ${dDate ? new Date(dDate).toLocaleDateString() : day.id}`).substring(0, 200);
  const dailyDate = dDate ? new Date(dDate).toISOString() : new Date().toISOString();

  await q(
    `INSERT INTO knowledge (title, content, category, tags, source, ai_source, created_at)
     VALUES ($1, $2, 'daily-summary', $3::jsonb, 'bee', 'bee', $4)`,
    [dTitle, dText.substring(0, 50000), JSON.stringify(['bee', 'daily-summary']), dailyDate]
  );
}

// ─── Counts ───────────────────────────────────────────────────────

router.get('/counts', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  const counts = {};
  try { const d = await beeApiGet('/v1/facts?limit=1', beeToken); counts.facts = d.total || d.total_count || d.count || 0; } catch (e) { counts.facts_error = e.message; }
  try { const d = await beeApiGet('/v1/todos?limit=1', beeToken); counts.todos = d.total || d.total_count || d.count || 0; } catch (e) { counts.todos_error = e.message; }
  try { const d = await beeApiGet('/v1/conversations?limit=1&created_after=2024-01-01', beeToken); counts.conversations = d.total || d.total_count || d.count || 0; } catch (e) { counts.conversations_error = e.message; }
  try { const d = await beeApiGet('/v1/journals?limit=1', beeToken); counts.journals = d.total || d.total_count || d.count || 0; } catch (e) { counts.journals_error = e.message; }
  try { const d = await beeApiGet('/v1/daily?limit=1', beeToken); counts.daily = d.total || d.total_count || d.count || 0; } catch (e) { counts.daily_error = e.message; }
  res.json(counts);
});

// ─── Full Sync ──────────────────────────────────────────

router.post('/sync', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  const force = req.body?.force === true;
  const job = syncStatus.startJob('bee', force ? 'Full sync (force refresh)' : 'Full cloud sync');
  const results = { facts: 0, todos: 0, conversations: 0, journals: 0, daily: 0, skipped: 0, errors: [] };
  const newTranscriptIds = []; // Track for auto-identify after commit

  // Use a transaction for the entire sync so partial failures can be rolled back
  const client = await pool.connect();
  const cq = client.query.bind(client);
  try {
    await client.query('BEGIN');

    // Sync Facts (paginated, batched inserts per page)
    try {
      let cursor = null;
      do {
        const url = '/v1/facts' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const data = await beeApiGet(url, beeToken);
        const facts = extractArray(data, 'facts'); cursor = data.next_cursor || null;
        for (const fact of facts) {
          const t = extractFactText(fact); if (!t) continue;
          if (!force && await findExistingFact(t)) { results.skipped++; continue; }
          await storeFact(t, fact, cq); results.facts++;
        }
      } while (cursor);
    } catch (e) { results.errors.push(`Facts: ${e.message}`); }

    // Sync Todos (paginated, batched)
    try {
      let cursor = null;
      do {
        const url = '/v1/todos' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const data = await beeApiGet(url, beeToken);
        const todos = extractArray(data, 'todos'); cursor = data.next_cursor || null;
        for (const todo of todos) {
          const t = extractTodoText(todo); if (!t) continue;
          if (!force && await findExistingTask(t)) { results.skipped++; continue; }
          await storeTodo(t, todo, cq); results.todos++;
        }
      } while (cursor);
    } catch (e) { results.errors.push(`Todos: ${e.message}`); }

    // Sync Conversations (paginated, fetch details concurrently 5-at-a-time)
    try {
      let cursor = null;
      do {
        const url = `/v1/conversations?limit=50` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const data = await beeApiGet(url, beeToken);
        const convos = extractArray(data, 'conversations'); cursor = data.next_cursor || null;

        // Filter out already-synced and in-progress convos
        const toSync = [];
        for (const convo of convos) {
          if (!convo.id) continue;
          if (convo.state === 'CAPTURING') { results.skipped++; continue; }
          if (!force && await findExistingTranscript(convo.id)) { results.skipped++; continue; }
          toSync.push(convo);
        }

        // Fetch conversation details concurrently (5 at a time)
        const detailed = await mapConcurrent(toSync, 5, async (convo) => {
          let full = convo;
          try { const d = await beeApiGet(`/v1/conversations/${convo.id}`, beeToken); full = d.conversation || d; }
          catch (e) { results.errors.push(`Conv ${convo.id}: ${e.message}`); }
          const rawResult = extractTranscript(full, convo.start_time || full.start_time || null, convo);
          if (!rawResult.text) {
            console.log(`[sync] conv ${convo.id} no transcript text, detail keys: ${Object.keys(full).join(',')}, list keys: ${Object.keys(convo).join(',')}`);
            return null;
          }
          return { convo, full, rawResult };
        });

        // Store sequentially within the transaction
        for (const item of detailed) {
          if (!item) { results.skipped++; continue; }
          const tid = await storeConversation(item.convo, item.full, item.rawResult, cq);
          newTranscriptIds.push(tid);
          results.conversations++;
        }
      } while (cursor);
    } catch (e) { results.errors.push(`Conversations: ${e.message}`); }

    // Sync Journals (paginated)
    try {
      let cursor = null;
      do {
        const url = '/v1/journals' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const data = await beeApiGet(url, beeToken);
        const journals = extractArray(data, 'journals'); cursor = data.next_cursor || null;
        for (const journal of journals) {
          const jText = journal.text || journal.content || journal.body || journal.markdown || '';
          if (!jText && !journal.summary) continue;
          if (!force && await findExistingKnowledge(jText || journal.summary, 'bee')) { results.skipped++; continue; }
          await storeJournal(journal, cq); results.journals++;
        }
      } while (cursor);
    } catch (e) { results.errors.push(`Journals: ${e.message}`); }

    // Sync Daily (paginated)
    try {
      let cursor = null;
      do {
        const url = '/v1/daily' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const data = await beeApiGet(url, beeToken);
        const dailies = extractArray(data, 'daily'); cursor = data.next_cursor || null;
        for (const day of dailies) {
          const dText = day.text || day.content || day.body || day.summary || day.markdown || '';
          if (!dText) continue;
          if (!force && await findExistingKnowledge(dText, 'bee')) { results.skipped++; continue; }
          await storeDaily(day, cq); results.daily++;
        }
      } while (cursor);
    } catch (e) { results.errors.push(`Daily: ${e.message}`); }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    results.errors.push(`Transaction failed: ${e.message}`);
  } finally {
    client.release();
  }

  const totalImported = results.facts + results.todos + results.conversations + results.journals + results.daily;
  await logActivity('sync', 'bee-import', 'cloud-sync', 'bee',
    `Cloud sync${force ? ' (full)' : ''}: ${results.facts}F ${results.todos}T ${results.conversations}C ${results.journals}J ${results.daily}D (${results.skipped} skipped)`);
  syncStatus.completeJob('bee', job, { imported: totalImported, skipped: results.skipped, errors: results.errors, details: results });
  res.json({ message: `Bee cloud sync complete${force ? ' (full refresh)' : ''}`, imported: results });

  // Fire-and-forget: auto-identify speakers on new transcripts (after response sent)
  if (newTranscriptIds.length > 0) {
    console.log(`[sync] Queuing auto-identify for ${newTranscriptIds.length} new transcripts`);
    (async () => {
      for (const tid of newTranscriptIds) {
        await autoIdentifySpeakers(tid);
      }
      console.log(`[sync] Auto-identify complete for ${newTranscriptIds.length} transcripts`);
    })().catch(e => console.error('[sync] Auto-identify batch error:', e.message));
  }
});

// ─── Chunked sync ──────────────────────────────────────────

router.post('/sync-chunk', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  const { type, cursor, force } = req.body;
  if (!type) return res.status(400).json({ error: 'type required (facts, todos, conversations, journals, daily)' });

  const result = { imported: 0, skipped: 0, errors: [], cursor: null, done: false, type, page_items: 0 };
  try {
    if (type === 'facts') {
      const url = '/v1/facts' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const facts = extractArray(data, 'facts');
      result.cursor = data.next_cursor || null;
      result.page_items = facts.length;
      console.log(`[sync-chunk] facts: ${facts.length} items, cursor=${!!result.cursor}`);
      for (const fact of facts) {
        const t = extractFactText(fact);
        if (!t) { result.skipped++; continue; }
        if (!force && await findExistingFact(t)) { result.skipped++; continue; }
        await storeFact(t, fact); result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else if (type === 'todos') {
      const url = '/v1/todos' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const todos = extractArray(data, 'todos');
      result.cursor = data.next_cursor || null;
      result.page_items = todos.length;
      console.log(`[sync-chunk] todos: ${todos.length} items, cursor=${!!result.cursor}`);
      for (const todo of todos) {
        const t = extractTodoText(todo);
        if (!t) { result.skipped++; continue; }
        if (!force && await findExistingTask(t)) { result.skipped++; continue; }
        await storeTodo(t, todo); result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else if (type === 'conversations') {
      const url = `/v1/conversations?limit=50` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const convos = extractArray(data, 'conversations');
      result.cursor = data.next_cursor || null;
      result.page_items = convos.length;
      const chunkTranscriptIds = [];
      console.log(`[sync-chunk] conversations: ${convos.length} items, cursor=${!!result.cursor}`);
      for (const convo of convos) {
        if (!convo.id) { result.skipped++; continue; }
        if (!force && await findExistingTranscript(convo.id)) { result.skipped++; continue; }
        if (convo.state === 'CAPTURING') { result.skipped++; continue; }
        let full = convo;
        try {
          const d = await beeApiGet(`/v1/conversations/${convo.id}`, beeToken, 60000);
          full = d.conversation || d;
        } catch (e) {
          console.log(`[sync-chunk] conv ${convo.id} detail fetch failed: ${e.message}`);
          // Still try to store with whatever data we have from the list endpoint
        }
        const rawResult = extractTranscript(full, convo.start_time || full.start_time || null, convo);
        if (!rawResult.text) {
          console.log(`[sync-chunk] conv ${convo.id} no transcript text, detail keys: ${Object.keys(full).join(',')}, list keys: ${Object.keys(convo).join(',')}`);
          result.skipped++; continue;
        }
        const tid = await storeConversation(convo, full, rawResult);
        chunkTranscriptIds.push(tid);
        result.imported++;
      }
      if (!result.cursor) result.done = true;
      // Fire-and-forget auto-identify after response
      if (chunkTranscriptIds.length > 0) {
        result._autoIdentifyQueued = chunkTranscriptIds.length;
        setImmediate(() => {
          (async () => {
            for (const tid of chunkTranscriptIds) await autoIdentifySpeakers(tid);
            console.log(`[sync-chunk] Auto-identify done for ${chunkTranscriptIds.length} transcripts`);
          })().catch(e => console.error('[sync-chunk] Auto-identify error:', e.message));
        });
      }

    } else if (type === 'journals') {
      const url = '/v1/journals' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const journals = extractArray(data, 'journals');
      result.cursor = data.next_cursor || null;
      result.page_items = journals.length;
      console.log(`[sync-chunk] journals: ${journals.length} items, cursor=${!!result.cursor}, keys=${journals.length > 0 ? Object.keys(journals[0]).join(',') : 'empty'}`);
      for (const j of journals) {
        const t = j.text || j.content || j.body || j.markdown || '';
        if (!t && !j.summary) { result.skipped++; continue; }
        if (!force && await findExistingKnowledge(t || j.summary, 'bee')) { result.skipped++; continue; }
        await storeJournal(j); result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else if (type === 'daily') {
      const url = '/v1/daily' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const data = await beeApiGet(url, beeToken);
      const dailies = extractArray(data, 'daily');
      result.cursor = data.next_cursor || null;
      result.page_items = dailies.length;
      console.log(`[sync-chunk] daily: ${dailies.length} items, cursor=${!!result.cursor}, keys=${dailies.length > 0 ? Object.keys(dailies[0]).join(',') : 'empty'}`);
      for (const d of dailies) {
        const t = d.text || d.content || d.body || d.summary || d.markdown || '';
        if (!t) { result.skipped++; continue; }
        if (!force && await findExistingKnowledge(t, 'bee')) { result.skipped++; continue; }
        await storeDaily(d); result.imported++;
      }
      if (!result.cursor) result.done = true;

    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error(`[sync-chunk] ${type} error:`, err.message);
    result.errors.push(err.message);
  }
  console.log(`[sync-chunk] ${type} result: imported=${result.imported} skipped=${result.skipped} errors=${result.errors.length} done=${result.done}`);
  res.json(result);
});

// ─── Sync conversations by date range (chunked — one page per request) ──────

router.post('/sync-conversations', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  const { start_date, end_date, force, cursor } = req.body;
  // Default: Dec 2025 to now
  const endStr = end_date || new Date().toISOString().split('T')[0];
  const startStr = start_date || '2025-12-01';

  const result = { imported: 0, skipped: 0, errors: [], total_found: 0, cursor: null, done: false };
  const newTranscriptIds = [];

  try {
    let url = `/v1/conversations?limit=50&created_after=${startStr}&created_before=${endStr}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    console.log(`[sync-conv] Fetching: ${url}`);
    const data = await beeApiGet(url, beeToken, 60000);
    const convos = extractArray(data, 'conversations');
    result.cursor = data.next_cursor || null;
    result.total_found = convos.length;
    if (!result.cursor) result.done = true;

    for (const convo of convos) {
      if (!convo.id) continue;
      if (convo.state === 'CAPTURING') { result.skipped++; continue; }
      if (!force && await findExistingTranscript(convo.id)) { result.skipped++; continue; }

      let full = convo;
      try {
        const d = await beeApiGet(`/v1/conversations/${convo.id}`, beeToken, 60000);
        full = d.conversation || d;
      } catch (e) {
        console.log(`[sync-conv] detail fetch failed for ${convo.id}: ${e.message}`);
      }
      const rawResult = extractTranscript(full, convo.start_time || full.start_time || null, convo);
      if (!rawResult.text) {
        console.log(`[sync-conv] ${convo.id} no text, detail keys: ${Object.keys(full).join(',')}`);
        result.skipped++;
        continue;
      }
      const tid = await storeConversation(convo, full, rawResult);
      newTranscriptIds.push(tid);
      result.imported++;
    }
  } catch (e) {
    result.errors.push(e.message);
  }

  console.log(`[sync-conv] page: imported=${result.imported} skipped=${result.skipped} done=${result.done}`);
  res.json({ ...result, date_range: { start: startStr, end: endStr } });

  // Fire-and-forget: auto-identify speakers on new transcripts from this page
  if (newTranscriptIds.length > 0) {
    setImmediate(() => {
      (async () => {
        for (const tid of newTranscriptIds) await autoIdentifySpeakers(tid);
        console.log(`[sync-conv] Auto-identify done for ${newTranscriptIds.length} transcripts`);
      })().catch(e => console.error('[sync-conv] Auto-identify error:', e.message));
    });
  }
});

// ─── Purge ──────────────────────────────────────────

router.post('/purge', async (req, res) => {
  try {
    const r1 = await query("DELETE FROM facts WHERE source = 'bee'");
    const r2 = await query("DELETE FROM knowledge WHERE ai_source = 'bee'");
    const r3 = await query("DELETE FROM tasks WHERE ai_agent = 'bee'");
    // Delete speaker utterances first (FK dependency), then transcripts
    await query("DELETE FROM transcript_speakers WHERE transcript_id IN (SELECT id FROM transcripts WHERE source = 'bee')");
    const r4 = await query("DELETE FROM transcripts WHERE source = 'bee'");
    const total = (r1.rowCount||0) + (r2.rowCount||0) + (r3.rowCount||0) + (r4.rowCount||0);
    await logActivity('purge', 'bee-import', 'purge', 'bee', `Purged ${total} Bee entries`);
    res.json({ message: `Purged ${total} Bee entries`, archived: total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Incremental sync ──────────────────────────────────────────

router.post('/sync-incremental', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  try {
    let lastCursor = null;
    try {
      const r = await query("SELECT details FROM activity_log WHERE action='bee-change-cursor' ORDER BY created_at DESC LIMIT 1");
      if (r.rows.length) { const m = r.rows[0].details.match(/cursor:(\S+)/); if (m) lastCursor = m[1]; }
    } catch { /* first sync */ }

    const url = '/v1/changes' + (lastCursor ? `?cursor=${encodeURIComponent(lastCursor)}` : '');
    const data = await beeApiGet(url, beeToken);
    const changes = data.changes || data.items || data.data || [];
    const newCursor = data.next_cursor || data.cursor || null;
    const results = { facts: 0, todos: 0, conversations: 0, skipped: 0, errors: [] };

    const changedFacts = [], changedTodos = [], changedConvos = [];
    for (const change of (Array.isArray(changes) ? changes : [])) {
      const et = change.type || change.entity_type;
      const eid = change.id || change.entity_id;
      if (!eid) continue;
      if (et === 'fact') changedFacts.push(eid);
      else if (et === 'todo') changedTodos.push(eid);
      else if (et === 'conversation') changedConvos.push(eid);
    }

    for (const factId of changedFacts) {
      try {
        const fact = await beeApiGet(`/v1/facts/${factId}`, beeToken);
        const f = fact.fact || fact; const fText = extractFactText(f); if (!fText) continue;
        const existing = await findExistingFact(fText);
        if (existing) { await query('UPDATE facts SET content=$1, updated_at=NOW() WHERE id=$2', [fText, existing.id]); }
        else { await storeFact(fText, f); }
        results.facts++;
      } catch (e) { results.errors.push(`fact ${factId}: ${e.message}`); }
    }

    for (const todoId of changedTodos) {
      try {
        const todo = await beeApiGet(`/v1/todos/${todoId}`, beeToken);
        const t = todo.todo || todo; const tText = extractTodoText(t); if (!tText) continue;
        const existing = await findExistingTask(tText);
        if (existing) { await query("UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2", [t.completed ? 'done' : 'todo', existing.id]); }
        else { await storeTodo(tText, t); }
        results.todos++;
      } catch (e) { results.errors.push(`todo ${todoId}: ${e.message}`); }
    }

    const incrTranscriptIds = [];
    for (const convoId of changedConvos) {
      try {
        const detail = await beeApiGet(`/v1/conversations/${convoId}`, beeToken);
        const c = detail.conversation || detail;
        if (c.state === 'CAPTURING') continue;
        const rawResult = extractTranscript(c, c.start_time || null, c);
        if (!rawResult.text) continue;
        const existing = await findExistingTranscript(convoId);
        if (existing) { await query('UPDATE transcripts SET summary=$1, updated_at=NOW() WHERE id=$2', [c.summary || rawResult.text.substring(0, 2000), existing.id]); }
        else { const tid = await storeConversation(c, c, rawResult); incrTranscriptIds.push(tid); }
        results.conversations++;
      } catch (e) { results.errors.push(`conversation ${convoId}: ${e.message}`); }
    }

    if (newCursor) { await logActivity('bee-change-cursor', 'bee-import', 'cursor', 'bee', `cursor:${newCursor}`); }
    await logActivity('sync', 'bee-import', 'incremental', 'bee', `Incremental: ${results.facts}F ${results.todos}T ${results.conversations}C`);
    res.json({ message: 'Incremental sync complete', imported: results, changes_processed: changes.length, had_cursor: !!lastCursor });
    // Fire-and-forget auto-identify on new transcripts
    if (incrTranscriptIds.length > 0) {
      (async () => {
        for (const tid of incrTranscriptIds) await autoIdentifySpeakers(tid);
        console.log(`[incremental] Auto-identify done for ${incrTranscriptIds.length} transcripts`);
      })().catch(e => console.error('[incremental] Auto-identify error:', e.message));
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Status ──────────────────────────────────────────

router.get('/status', async (req, res) => {
  const result = {
    facts: 0, tasks: 0, transcripts: 0, journals: 0, daily: 0,
    bee_token_configured: !!process.env.BEE_API_TOKEN,
    openai_configured: !!process.env.OPENAI_API_KEY,
  };
  try {
    const [factsR, knowledgeR, tasksR, transcriptsR] = await Promise.all([
      query("SELECT COUNT(*)::int as c FROM facts WHERE source='bee'"),
      query("SELECT category, COUNT(*)::int as c FROM knowledge WHERE ai_source='bee' GROUP BY category"),
      query("SELECT COUNT(*)::int as c FROM tasks WHERE ai_agent='bee'"),
      query("SELECT COUNT(*)::int as c FROM transcripts WHERE source='bee'"),
    ]);
    const kRows = knowledgeR.rows;
    result.facts = factsR.rows[0].c;
    result.tasks = tasksR.rows[0].c;
    result.transcripts = transcriptsR.rows[0].c;
    result.journals = (kRows.find(r => r.category === 'journal') || {}).c || 0;
    result.daily = (kRows.find(r => r.category === 'daily-summary') || {}).c || 0;
    res.json(result);
  } catch (err) {
    // Still return token config status even if DB queries fail
    result.db_error = err.message;
    res.json(result);
  }
});

// ─── Diagnose ──────────────────────────────────────────

router.get('/diagnose', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  const endpoints = [
    { name: 'facts', path: '/v1/facts?limit=2', key: 'facts' },
    { name: 'todos', path: '/v1/todos?limit=2', key: 'todos' },
    { name: 'conversations', path: '/v1/conversations?limit=2&created_after=2024-01-01', key: 'conversations' },
    { name: 'journals', path: '/v1/journals?limit=2', key: 'journals' },
    { name: 'daily', path: '/v1/daily?limit=2', key: 'daily' },
  ];
  const results = {};
  for (const ep of endpoints) {
    try {
      const data = await beeApiGet(ep.path, beeToken, 15000);
      const items = extractArray(data, ep.key);
      results[ep.name] = { status: 'ok', total: data.total || data.total_count || null, items_in_page: items.length, has_cursor: !!data.next_cursor, sample_item_keys: items.length > 0 ? Object.keys(items[0]) : [] };
    } catch (e) { results[ep.name] = { status: 'error', error: e.message }; }
  }
  res.json({ bee_token_configured: !!process.env.BEE_API_TOKEN, endpoints: results });
});

// ─── Neural search ──────────────────────────────────────────

router.post('/search', async (req, res) => {
  const beeToken = getBeeToken(req);
  if (!beeToken) return res.status(400).json({ error: 'Bee token required' });
  const { query: q, limit = 20 } = req.body;
  if (!q) return res.status(400).json({ error: 'query is required' });
  try {
    const beeResults = await beeApiPost('/v1/search/conversations/neural', { query: q, limit: Math.min(Number(limit), 50) }, beeToken);
    const conversations = extractArray(beeResults, 'conversations');
    res.json({ query: q, count: conversations.length, results: conversations.map(c => ({
      type: 'bee_neural', bee_id: c.id, title: c.title || c.summary?.substring(0, 80) || 'Bee Conversation',
      preview: c.summary || c.snippet || '', score: c.score || 0, start_time: c.start_time || c.created_at,
    })) });
  } catch (err) { res.status(500).json({ error: `Bee neural search failed: ${err.message}` }); }
});

module.exports = router;
