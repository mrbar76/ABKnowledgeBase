#!/usr/bin/env node
// Email ingestion driver.
//
//   node scripts/email-ingest.js probe                      # list MCP tools
//   node scripts/email-ingest.js ingest [--account=avibar.js] [--days=7] [--limit=200] [--dry-run]
//
// Pulls email headers from a remote MCP server (e.g. gmail-multi-mcp), groups
// by thread, classifies each thread (NOISE/INDEX/DISTILL/CALENDAR), embeds the
// summary, and upserts a pointer row into email_threads + email_messages.
//
// Bodies are NOT stored. Fetch on demand via routes/email.js.

require('dotenv').config?.();
const { McpClient } = require('../lib/mcp-client');
const { query, logActivity } = require('../db');

// ─── config ──────────────────────────────────────────────────────────────────
const MCP_URL = process.env.MCP_GMAIL_URL || 'https://gmail-multi-mcp-production.up.railway.app/mcp';
const MCP_TOKEN = process.env.MCP_GMAIL_TOKEN || ''; // optional bearer token
const CLASSIFIER_MODEL = process.env.EMAIL_CLASSIFIER_MODEL || 'gpt-4o-mini';
const EMBEDDING_MODEL = process.env.EMAIL_EMBEDDING_MODEL || 'text-embedding-3-small';
const PROMPT_VERSION = 'email-classifier@2026-04-26.v1';

const USER_ADDRESSES = (process.env.USER_EMAIL_ADDRESSES || 'avibar.ny@gmail.com,avibar.js@gmail.com,avi.lilach@gmail.com,avi.solar@gmail.com,abar@thinkalpen.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ─── arg parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      out[k] = rest.length ? rest.join('=') : true;
    } else out._.push(a);
  }
  return out;
}

// ─── MCP tool discovery ──────────────────────────────────────────────────────
// We don't hardcode tool names because different Gmail MCP servers expose
// different shapes. Discover them once, pick by name pattern.
function pickTool(tools, patterns) {
  for (const p of patterns) {
    const re = new RegExp(p, 'i');
    const t = tools.find(t => re.test(t.name));
    if (t) return t;
  }
  return null;
}

async function discoverGmailTools(mcp) {
  const { tools } = await mcp.listTools();
  const names = tools.map(t => t.name);
  const search = pickTool(tools, ['^gmail_search', 'search_(emails|messages|mail)', '^search$', 'list_messages']);
  const getMessage = pickTool(tools, ['get_message', 'gmail_get_email', 'read_message', 'fetch_message']);
  const getThread = pickTool(tools, ['get_thread', 'gmail_get_thread', 'fetch_thread']);
  if (!search) {
    throw new Error(`No search tool found on MCP server. Available tools:\n  ${names.join('\n  ')}`);
  }
  if (!getMessage && !getThread) {
    throw new Error(`No message/thread fetch tool found. Available:\n  ${names.join('\n  ')}`);
  }
  return { search, getMessage, getThread, allNames: names };
}

// ─── argument shape inference for tool calls ─────────────────────────────────
// Different servers want different param names (q vs query, account vs userId).
// Build args by inspecting the tool's inputSchema when possible, else best-guess.
function buildSearchArgs(tool, { q, account, max }) {
  const props = tool?.inputSchema?.properties || {};
  const args = {};
  // query
  if ('q' in props) args.q = q;
  else if ('query' in props) args.query = q;
  else args.query = q;
  // account / user
  if (account) {
    if ('account' in props) args.account = account;
    else if ('userId' in props) args.userId = account;
    else if ('user' in props) args.user = account;
    else if ('email' in props) args.email = account;
    else args.account = account;
  }
  // max results
  if (max != null) {
    if ('maxResults' in props) args.maxResults = max;
    else if ('limit' in props) args.limit = max;
    else if ('max' in props) args.max = max;
    else args.maxResults = max;
  }
  return args;
}

function buildGetArgs(tool, { id, account }) {
  const props = tool?.inputSchema?.properties || {};
  const args = {};
  if ('id' in props) args.id = id;
  else if ('messageId' in props) args.messageId = id;
  else if ('threadId' in props) args.threadId = id;
  else args.id = id;
  if (account) {
    if ('account' in props) args.account = account;
    else if ('userId' in props) args.userId = account;
    else if ('user' in props) args.user = account;
    else args.account = account;
  }
  return args;
}

// ─── MCP result helpers ──────────────────────────────────────────────────────
// Tool results come back as { content: [{type:'text', text:'...'}], isError? }.
// We try to JSON-parse the first text block.
function parseToolResult(result) {
  if (result?.isError) {
    const msg = (result.content || []).map(c => c.text || '').join('\n').slice(0, 1000);
    throw new Error(`MCP tool error: ${msg}`);
  }
  const blocks = result?.content || [];
  for (const b of blocks) {
    if (b.type !== 'text' || !b.text) continue;
    try { return JSON.parse(b.text); } catch { /* not json */ }
  }
  // Fall back to concatenated text
  return { _raw: blocks.map(b => b.text || '').join('') };
}

// ─── classifier + embedder ───────────────────────────────────────────────────
let _openai;
function openai() {
  if (_openai) return _openai;
  const OpenAI = require('openai');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const CLASSIFIER_PROMPT = `You triage email threads for a personal knowledge index.

Classify the thread into exactly one of:
  - "noise"    : automated, marketing, transactional. Do not store body.
  - "index"    : real but routine. Store a 1-sentence summary so it can be re-found.
  - "distill"  : substantive (decisions, deals, relationships, technical detail). Store a 2-3 sentence summary plus entities and topics.
  - "calendar" : a calendar invite / accept / decline / update. Subject typically starts with "Accepted:", "Declined:", "Tentative:", or contains an iTIP method.

Return ONLY JSON:
{
  "classification": "noise" | "index" | "distill" | "calendar",
  "confidence": 0.0-1.0,
  "summary": "string (empty for noise; 1 sentence for index/calendar; 2-3 sentences for distill)",
  "entities": ["names of people, companies, projects mentioned"],
  "topics": ["short lowercase topic tags"]
}

Rules:
- Be ruthless about noise. LinkedIn digests, USPS notifications, marketing, OTPs are noise.
- Calendar accept/decline messages encode useful facts (who, what, when) but no body — classify as "calendar" and capture them in the summary.
- Summaries are about the thread, not just the latest message.
- Never invent facts. If the headers don't tell you, don't guess.`;

async function classifyThread(threadHeaders) {
  const client = openai();
  const res = await client.chat.completions.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 400,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFIER_PROMPT },
      { role: 'user', content: JSON.stringify(threadHeaders).slice(0, 8000) },
    ],
  });
  const text = res.choices[0]?.message?.content || '{}';
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { classification: 'index', confidence: 0.3, summary: '', entities: [], topics: [] };
  }
}

async function embedSummary(text) {
  if (!text || !text.trim()) return null;
  const client = openai();
  const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) });
  return res.data[0]?.embedding || null;
}

// ─── normalization ───────────────────────────────────────────────────────────
function parseAddress(s) {
  if (!s || typeof s !== 'string') return { name: null, email: null };
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: s.trim().toLowerCase() };
}
function parseAddressList(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s.map(parseAddress).filter(a => a.email);
  return s.split(/,(?![^<]*>)/).map(parseAddress).filter(a => a.email);
}

function isCalendarMessage(headers) {
  const subj = (headers.subject || '').trim();
  if (/^(Accepted|Declined|Tentative):/i.test(subj)) return true;
  const ctype = (headers.contentType || headers['content-type'] || '').toLowerCase();
  if (ctype.includes('text/calendar')) return true;
  return false;
}

function recipientIsUser(toList, ccList, account) {
  const userSet = new Set([account.toLowerCase(), ...USER_ADDRESSES]);
  return [...toList, ...ccList].some(a => a.email && userSet.has(a.email));
}

// ─── upsert ─────────────────────────────────────────────────────────────────
async function upsertThread(thread, classification, embedding) {
  const sql = `
    INSERT INTO email_threads (
      provider, account, thread_provider_id, subject, participants,
      message_count, first_message_at, last_message_at,
      classification, classifier_confidence, classifier_model, classifier_prompt_version,
      summary, entities, topics, embedding, embedding_model,
      search_vector, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb,
      $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14::jsonb, $15::jsonb, $16, $17,
      to_tsvector('english', coalesce($4,'') || ' ' || coalesce($13,'')),
      NOW()
    )
    ON CONFLICT (provider, account, thread_provider_id) DO UPDATE SET
      subject = EXCLUDED.subject,
      participants = EXCLUDED.participants,
      message_count = EXCLUDED.message_count,
      first_message_at = EXCLUDED.first_message_at,
      last_message_at = EXCLUDED.last_message_at,
      classification = EXCLUDED.classification,
      classifier_confidence = EXCLUDED.classifier_confidence,
      classifier_model = EXCLUDED.classifier_model,
      classifier_prompt_version = EXCLUDED.classifier_prompt_version,
      summary = EXCLUDED.summary,
      entities = EXCLUDED.entities,
      topics = EXCLUDED.topics,
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      search_vector = EXCLUDED.search_vector,
      updated_at = NOW()
    RETURNING id`;

  const r = await query(sql, [
    'gmail',
    thread.account,
    thread.threadId,
    thread.subject,
    JSON.stringify(thread.participants),
    thread.messages.length,
    thread.firstAt,
    thread.lastAt,
    classification.classification,
    classification.confidence ?? null,
    CLASSIFIER_MODEL,
    PROMPT_VERSION,
    classification.summary || null,
    JSON.stringify(classification.entities || []),
    JSON.stringify(classification.topics || []),
    embedding ? `[${embedding.join(',')}]` : null,
    embedding ? EMBEDDING_MODEL : null,
  ]);
  return r.rows[0].id;
}

async function upsertMessage(threadRowId, msg) {
  await query(`
    INSERT INTO email_messages (
      thread_id, message_provider_id, rfc822_message_id, date, subject,
      from_email, from_name, to_emails, cc_emails, direction, snippet, is_calendar
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
    ON CONFLICT (message_provider_id) DO UPDATE SET
      thread_id = EXCLUDED.thread_id,
      date = EXCLUDED.date,
      subject = EXCLUDED.subject,
      direction = EXCLUDED.direction,
      snippet = EXCLUDED.snippet,
      is_calendar = EXCLUDED.is_calendar
  `, [
    threadRowId, msg.id, msg.rfc822 || null, msg.date, msg.subject,
    msg.from?.email || null, msg.from?.name || null,
    JSON.stringify(msg.to || []), JSON.stringify(msg.cc || []),
    msg.direction, msg.snippet || null, !!msg.isCalendar,
  ]);
}

// ─── grouping ───────────────────────────────────────────────────────────────
function groupByThread(messages, account) {
  const groups = new Map();
  for (const m of messages) {
    const key = m.threadId || m.id;
    if (!groups.has(key)) {
      groups.set(key, { account, threadId: key, messages: [], participants: new Map(), subject: null, firstAt: null, lastAt: null });
    }
    const g = groups.get(key);
    g.messages.push(m);
    if (!g.subject && m.subject) g.subject = m.subject;
    const t = m.date ? new Date(m.date) : null;
    if (t && (!g.firstAt || t < g.firstAt)) g.firstAt = t;
    if (t && (!g.lastAt || t > g.lastAt)) g.lastAt = t;
    if (m.from?.email) g.participants.set(m.from.email, { email: m.from.email, name: m.from.name || null });
    for (const a of (m.to || [])) if (a.email) g.participants.set(a.email, { email: a.email, name: a.name || null });
    for (const a of (m.cc || [])) if (a.email) g.participants.set(a.email, { email: a.email, name: a.name || null });
  }
  return [...groups.values()].map(g => ({ ...g, participants: [...g.participants.values()] }));
}

// ─── normalize provider message shape ────────────────────────────────────────
// Handles a few common shapes returned by Gmail-style MCP servers.
function normalizeMessage(raw, account) {
  const headers = raw.headers || raw.payload?.headers || {};
  const get = (k) => {
    if (Array.isArray(headers)) {
      const h = headers.find(h => (h.name || '').toLowerCase() === k.toLowerCase());
      return h?.value || null;
    }
    return headers[k] || headers[k.toLowerCase()] || null;
  };

  const from = parseAddress(raw.from || get('From') || '');
  const to = parseAddressList(raw.to || get('To') || '');
  const cc = parseAddressList(raw.cc || get('Cc') || '');
  const subject = raw.subject || get('Subject') || '';
  const dateStr = raw.date || raw.internalDate || get('Date');
  const date = dateStr ? new Date(isNaN(dateStr) ? dateStr : Number(dateStr)) : null;

  const direction = from.email && from.email === account.toLowerCase() ? 'outbound' : 'inbound';
  const isCalendar = isCalendarMessage({ subject, contentType: get('Content-Type') });

  return {
    id: raw.id || raw.messageId,
    rfc822: get('Message-ID') || get('Message-Id'),
    threadId: raw.threadId || raw.thread_id || raw.id,
    date,
    subject,
    from, to, cc,
    snippet: raw.snippet || raw.preview || null,
    direction,
    isCalendar,
    accountUsed: account,
  };
}

// ─── main flows ──────────────────────────────────────────────────────────────
async function probe() {
  const mcp = new McpClient({
    url: MCP_URL,
    headers: MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {},
  });
  console.log(`[probe] connecting to ${MCP_URL}`);
  await mcp.initialize();
  const { tools } = await mcp.listTools();
  console.log(`[probe] server returned ${tools.length} tools:\n`);
  for (const t of tools) {
    const params = Object.keys(t.inputSchema?.properties || {}).join(', ');
    console.log(`  ${t.name}(${params})`);
    if (t.description) console.log(`     ${t.description.slice(0, 160)}`);
  }
  await mcp.close();
}

async function ingest({ account, days, limit, dryRun }) {
  const mcp = new McpClient({
    url: MCP_URL,
    headers: MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {},
  });
  console.log(`[ingest] account=${account} days=${days} limit=${limit} dryRun=${dryRun}`);
  await mcp.initialize();
  const { search, getMessage, getThread, allNames } = await discoverGmailTools(mcp);
  console.log(`[ingest] using search=${search.name}${getMessage ? ` get=${getMessage.name}` : ''}${getThread ? ` getThread=${getThread.name}` : ''}`);

  const q = `newer_than:${days}d`;
  const searchArgs = buildSearchArgs(search, { q, account, max: limit });
  const searchResult = parseToolResult(await mcp.callTool(search.name, searchArgs));

  // Try common shapes for the result list
  const messages = searchResult.messages || searchResult.results || searchResult.items || searchResult.data || [];
  if (!messages.length) {
    console.log(`[ingest] no messages returned. Raw shape keys: ${Object.keys(searchResult).join(', ')}`);
    await mcp.close();
    return { threads: 0, messages: 0 };
  }
  console.log(`[ingest] search returned ${messages.length} messages`);

  // If search returned only IDs/snippets, fetch each for full headers
  const fetched = [];
  for (const m of messages) {
    const hasHeaders = m.from || m.headers || m.payload;
    if (hasHeaders) { fetched.push(m); continue; }
    if (!getMessage) { fetched.push(m); continue; }
    try {
      const r = parseToolResult(await mcp.callTool(getMessage.name, buildGetArgs(getMessage, { id: m.id || m.messageId, account })));
      fetched.push(r.message || r);
    } catch (err) {
      console.warn(`[ingest] could not fetch ${m.id}: ${err.message}`);
    }
  }

  const normalized = fetched.map(r => normalizeMessage(r, account)).filter(m => m.id);
  // Recipient filter: skip messages where we are not in to/cc/from
  const filtered = normalized.filter(m => m.direction === 'outbound' || recipientIsUser(m.to, m.cc, account));
  console.log(`[ingest] normalized ${normalized.length} messages, ${filtered.length} pass recipient filter`);

  const threads = groupByThread(filtered, account);
  console.log(`[ingest] grouped into ${threads.length} threads`);

  let stored = 0;
  for (const th of threads) {
    const headersForLLM = {
      subject: th.subject,
      participants: th.participants.slice(0, 20),
      messageCount: th.messages.length,
      messages: th.messages.slice(0, 8).map(m => ({
        from: m.from?.email,
        to: m.to.map(a => a.email),
        date: m.date,
        subject: m.subject,
        snippet: (m.snippet || '').slice(0, 400),
        isCalendar: m.isCalendar,
        direction: m.direction,
      })),
    };

    let classification;
    try { classification = await classifyThread(headersForLLM); }
    catch (err) {
      console.warn(`[ingest] classifier failed for thread ${th.threadId}: ${err.message}`);
      classification = { classification: 'index', confidence: 0.2, summary: th.subject || '', entities: [], topics: [] };
    }

    // Override: if every message in the thread is a calendar message, force classification
    if (th.messages.every(m => m.isCalendar)) classification.classification = 'calendar';

    let embedding = null;
    if (classification.classification !== 'noise' && classification.summary?.trim()) {
      try { embedding = await embedSummary(classification.summary); }
      catch (err) { console.warn(`[ingest] embed failed: ${err.message}`); }
    }

    if (dryRun) {
      console.log(`  [dry] ${classification.classification.toUpperCase().padEnd(8)} ${th.subject?.slice(0, 70) || '(no subject)'}`);
      continue;
    }

    try {
      const threadRowId = await upsertThread(th, classification, embedding);
      for (const m of th.messages) await upsertMessage(threadRowId, m);
      stored++;
    } catch (err) {
      console.error(`[ingest] upsert failed for thread ${th.threadId}: ${err.message}`);
    }
  }

  await mcp.close();
  if (!dryRun) {
    await logActivity('ingest', 'email', account, 'mcp', `Email ingest: ${stored} threads (${filtered.length} messages, ${days}d)`);
  }
  console.log(`[ingest] done. stored ${stored} threads.`);
  return { threads: stored, messages: filtered.length };
}

// ─── entry ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  if (cmd === 'probe') {
    await probe();
  } else if (cmd === 'ingest') {
    const account = args.account || 'avibar.js@gmail.com';
    const days = Number(args.days || 7);
    const limit = Number(args.limit || 200);
    const dryRun = !!args['dry-run'];
    await ingest({ account, days, limit, dryRun });
  } else {
    console.log(`Usage:
  node scripts/email-ingest.js probe
  node scripts/email-ingest.js ingest [--account=avibar.js@gmail.com] [--days=7] [--limit=200] [--dry-run]`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { ingest, probe };
