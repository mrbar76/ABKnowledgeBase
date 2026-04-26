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

try { require('dotenv').config(); } catch { /* dotenv optional */ }
const { McpClient } = require('../lib/mcp-client');
const { query, logActivity } = require('../db');

// ─── config ──────────────────────────────────────────────────────────────────
const MCP_URL = process.env.MCP_GMAIL_URL || 'https://gmail-multi-mcp-production.up.railway.app/mcp';
const MCP_TOKEN = process.env.MCP_GMAIL_TOKEN || ''; // optional bearer token
const CLASSIFIER_MODEL = process.env.EMAIL_CLASSIFIER_MODEL || 'gpt-4o-mini';
const EMBEDDING_MODEL = process.env.EMAIL_EMBEDDING_MODEL || 'text-embedding-3-small';
const PROMPT_VERSION = 'email-classifier@2026-04-26.v2-strict-noise';

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

function buildGetArgs(tool, { id, account, kind }) {
  const props = tool?.inputSchema?.properties || {};
  const args = {};
  // try the most-specific match first, then snake_case, then camelCase, then plain id
  const idCandidates = kind === 'thread'
    ? ['thread_id', 'threadId', 'id']
    : ['message_id', 'messageId', 'id'];
  for (const k of idCandidates) {
    if (k in props) { args[k] = id; break; }
  }
  if (!Object.keys(args).length) args.id = id;
  if (account) {
    if ('account' in props) args.account = account;
    else if ('userId' in props) args.userId = account;
    else if ('user' in props) args.user = account;
    else if ('email' in props) args.email = account;
    else args.account = account;
  }
  // We never want bodies for ingestion (saves tokens; bodies are fetched on demand)
  if ('include_body' in props) args.include_body = false;
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

const CLASSIFIER_PROMPT = `You triage email threads for a personal knowledge index. The user is a busy executive; the index must contain only signal, never noise.

Classify the thread into exactly one of:
  - "noise"    : automated, marketing, transactional, generic update, anything from a no-reply/notification/marketing sender. Drop entirely.
  - "index"    : a real human exchange that's routine but worth indexing — quick logistics, scheduling, family-ops, a short ack from a real person. Store a 1-sentence summary.
  - "distill"  : substantive (decisions, deals, relationships, technical detail, executive-search, professional negotiation, legal). Store a 2-3 sentence summary, entities, topics.
  - "calendar" : a calendar invite/accept/decline/update.

Return ONLY JSON:
{
  "classification": "noise" | "index" | "distill" | "calendar",
  "confidence": 0.0-1.0,
  "summary": "empty for noise; 1 sentence for index/calendar; 2-3 sentences for distill",
  "entities": ["names of people, companies, projects mentioned"],
  "topics": ["short lowercase topic tags"]
}

DEFAULT TO NOISE. If you are uncertain whether something is real signal, classify as noise.

ALWAYS NOISE — these are common false-positives, classify aggressively:
- Job-board emails (Ladders, Indeed, ExecThread, Foundever, ZipRecruiter, "jobs that fit you", "X% match", "open to work").
- Recruiter mass-blast emails that aren't addressed to the user personally — i.e. the body could have been sent to anyone with the same role keyword.
- LinkedIn digests, "X just messaged you" notifications.
- Marketing: "X% off", "ending soon", "last chance", "double points", "exclusive offer", product feature announcements.
- Newsletters: Morning Brew, Railway weekly, Coursera promos, dev/AI tool blasts.
- Transactional notifications: USPS delivery, package tracking, OTP/verification codes, password resets, security alerts, app update notices.
- Receipts/invoices unless they're for an unusually large or personally-relevant transaction (default: noise).
- School broadcast announcements (Veracross, Google Classroom weekly summaries, all-parent newsletters).
- Loyalty / "your points" emails.
- Trade-magazine subscription nags.
- ANY email from a noreply@, no-reply@, donotreply@, notify@, notification@, alerts@, news@, marketing@, updates@, offers@, info@ sender.

INDEX (worth keeping, but routine):
- Personal email from a real human that's logistics or short ack.
- Family-ops / scheduling.
- A short reply in a substantive thread ("ok, sounds good") — index, not distill.

DISTILL (substantive):
- Job/executive-search interviews, recruiter conversations naming a specific role at a specific company.
- Deal negotiation, contract terms, partnership detail.
- Technical or engineering substance, decisions, root-cause analysis.
- Legal/financial advice or instruction with names attached.
- Industry intelligence with specific firms, prices, or quotes.

When in doubt between noise and index, choose noise. When in doubt between index and distill, choose index.
Never invent facts. If the headers don't tell you, don't guess.`;

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

// Deterministic spam/marketing/noise pre-filter.
// Anything matching here is dropped without LLM classification or DB write.
// Goal: kill the 70%+ of inbound noise (job boards, marketing, OTPs, digests,
// notifications) before we spend tokens or Postgres rows on it.
const NOISE_DOMAIN_PATTERNS = [
  /(^|\.)noreply\./i, /(^|\.)no-reply\./i, /(^|\.)donotreply\./i, /(^|\.)do-not-reply\./i,
  /(^|\.)notify\./i, /(^|\.)notification(s)?\./i, /(^|\.)alerts?\./i, /(^|\.)mail\d*\./i,
  /(^|\.)email\./i, /(^|\.)news\./i, /(^|\.)updates?\./i, /(^|\.)offers?\./i,
  /(^|\.)reply\.linkedin\.com$/i, /(^|\.)e\.linkedin\.com$/i,
  /(^|\.)theladders\.com$/i, /(^|\.)my\.theladders\.com$/i,
  /(^|\.)indeed\.com$/i, /(^|\.)ziprecruiter\.com$/i, /(^|\.)glassdoor\.com$/i,
  /(^|\.)execthread\./i, /(^|\.)foundever/i, /jobs2web\.com$/i, /noreply\.jobs/i,
  /(^|\.)news\.\w+/i, /\.bounces\./i, /sendgrid\.net$/i, /mailgun\.net$/i,
  /amazonses\.com$/i, /mailchimp/i, /klaviyo/i, /constantcontact/i,
  /(^|\.)withings\./i, /(^|\.)veracross\.com$/i, /(^|\.)usps\.com$/i,
  /(^|\.)mail\.classroom\.google\.com$/i, /(^|\.)classroom\.google\.com$/i,
  /(^|\.)pictory\.ai$/i, /(^|\.)coursera\.org$/i, /(^|\.)dreamstime\.com$/i,
  /experian\.com$/i, /(^|\.)e\.usa\.experian\.com$/i, /htallc\.com$/i,
  /(^|\.)comosense\.com$/i, /podium\.com$/i, /proofpointessentials\.com$/i,
  /informeddelivery\.usps\.com$/i, /supports?@.*openai\.com$/i,
  /(^|\.)railway\.app$/i, /(^|\.)anthropic\.com$/i, // newsletters; receipts come through but get filtered by subject patterns below
];

const NOISE_FROM_LOCALPART = [
  /^messaging-digest-/i, /^digest-/i, /^newsletter@/i, /^marketing@/i,
  /^promo@/i, /^promotions@/i, /^updates?@/i, /^offers?@/i,
  /^community@/i, /^crew@/i, /^hello@news\./i,
  /^auto-?reply@/i, /^bounce@/i, /^postmaster@/i,
  /^notify@/i, /^notification@/i, /^alerts?@/i,
  /^subscriptions?@/i, /^subscription-confirmation@/i,
  /^invoice/i, /^billing@/i, /^receipt@/i, /^statements@/i,
];

const NOISE_SUBJECT_PATTERNS = [
  /^(re:\s*)?your daily digest/i, /weekly summary/i, /weekly digest/i,
  /just messaged you/i, /your weekly/i, /daily digest/i,
  /\d+%\s*off/i, /save\s+\d+%/i, /ending soon/i, /final days/i, /last chance/i,
  /flash sale/i, /exclusive offer/i, /limited time/i,
  /your \w+ passcode/i, /one[- ]time (password|code|passcode)/i, /verification code/i,
  /password reset/i, /security alert/i,
  /^your receipt/i, /your invoice/i, /payment (received|confirmation|receipt)/i,
  /usps.*expected delivery/i, /delivery (notification|confirmation|update)/i,
  /tracking (number|update|info)/i, /shipped|out for delivery/i,
  /jobs that fit you/i, /job opportunities/i, /\bjob alerts?\b/i, /job listings?/i,
  /(open to work)/i, /jobs near \d+/i, /chief revenue officer/i, // job boards spamming role titles
  /step on. step off/i, /double points day/i,
  /please review the following documentation regarding a recent debit card/i,
  /seller account not live/i, /partner ads setting/i,
  /quarantine digest/i,
];

function isObviousNoise(stub) {
  const fromStr = (stub.from || '').toLowerCase();
  const subj = (stub.subject || '').toLowerCase();

  for (const re of NOISE_FROM_LOCALPART) if (re.test(fromStr)) return true;
  for (const re of NOISE_SUBJECT_PATTERNS) if (re.test(subj)) return true;
  // domain patterns require parsing the email
  const m = fromStr.match(/<([^>]+)>/) || fromStr.match(/([^\s<>]+@[^\s<>]+)/);
  if (m) {
    const addr = m[1] || m[0];
    const at = addr.indexOf('@');
    const domain = at >= 0 ? addr.slice(at + 1) : '';
    for (const re of NOISE_DOMAIN_PATTERNS) if (re.test(domain)) return true;
  }
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

  // Outbound if the sender is one of our known addresses (handles MCP aliases like 'js')
  const userSet = new Set([account.toLowerCase(), ...USER_ADDRESSES]);
  const direction = from.email && userSet.has(from.email) ? 'outbound' : 'inbound';
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

  // gmail_search returns { threads: [{threadId, subject, from, lastDate, snippet, ...}] }
  const allStubs = searchResult.threads || searchResult.results || searchResult.items || searchResult.messages || searchResult.data || [];
  if (!allStubs.length) {
    console.log(`[ingest] no threads returned. Raw shape keys: ${Object.keys(searchResult).join(', ')}`);
    await mcp.close();
    return { threads: 0, messages: 0 };
  }

  // Pre-filter obvious noise (job boards, marketing, OTPs, USPS, digests, etc.)
  // These never get a get_thread call, never get an LLM call, never get a row.
  const threadStubs = [];
  let noiseDropped = 0;
  for (const stub of allStubs) {
    if (isObviousNoise(stub)) noiseDropped++;
    else threadStubs.push(stub);
  }
  console.log(`[ingest] search returned ${allStubs.length} threads; ${noiseDropped} dropped as obvious noise; ${threadStubs.length} to classify`);

  // For each thread, fetch its messages (headers only).
  const threads = [];
  for (const stub of threadStubs) {
    const tid = stub.threadId || stub.thread_id || stub.id;
    if (!tid) continue;
    let messages = [];
    if (getThread) {
      try {
        const r = parseToolResult(await mcp.callTool(getThread.name, buildGetArgs(getThread, { id: tid, account, kind: 'thread' })));
        messages = (r.messages || []).map(m => normalizeMessage(m, account));
      } catch (err) {
        console.warn(`[ingest] get_thread failed for ${tid}: ${err.message}`);
        // Fall back to the stub itself
        messages = [normalizeMessage({ ...stub, id: tid, threadId: tid }, account)];
      }
    } else {
      messages = [normalizeMessage({ ...stub, id: tid, threadId: tid }, account)];
    }
    if (!messages.length) continue;

    // Recipient filter at message level: keep outbound, or inbound where we're addressed
    const filtered = messages.filter(m => m.direction === 'outbound' || recipientIsUser(m.to, m.cc, account));
    if (!filtered.length) continue;

    const participants = new Map();
    let firstAt = null, lastAt = null, subject = stub.subject;
    for (const m of filtered) {
      if (m.from?.email) participants.set(m.from.email, { email: m.from.email, name: m.from.name || null });
      for (const a of m.to) if (a.email) participants.set(a.email, { email: a.email, name: a.name || null });
      for (const a of m.cc) if (a.email) participants.set(a.email, { email: a.email, name: a.name || null });
      if (m.date && (!firstAt || m.date < firstAt)) firstAt = m.date;
      if (m.date && (!lastAt || m.date > lastAt)) lastAt = m.date;
      if (!subject && m.subject) subject = m.subject;
    }
    threads.push({
      account, threadId: tid, subject,
      participants: [...participants.values()],
      messages: filtered, firstAt, lastAt,
    });
  }
  console.log(`[ingest] built ${threads.length} threads with messages`);

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
    if (dryRun && !process.env.OPENAI_API_KEY) {
      // Structural dry-run: no LLM, just placeholder
      classification = { classification: '?', confidence: null, summary: '(no OPENAI_API_KEY; LLM skipped)', entities: [], topics: [] };
    } else {
      try { classification = await classifyThread(headersForLLM); }
      catch (err) {
        console.warn(`[ingest] classifier failed for thread ${th.threadId}: ${err.message}`);
        classification = { classification: 'index', confidence: 0.2, summary: th.subject || '', entities: [], topics: [] };
      }
    }

    // Override: if every message in the thread is a calendar message, force classification
    if (th.messages.every(m => m.isCalendar)) classification.classification = 'calendar';

    let embedding = null;
    if (!dryRun && classification.classification !== 'noise' && classification.summary?.trim() && process.env.OPENAI_API_KEY) {
      try { embedding = await embedSummary(classification.summary); }
      catch (err) { console.warn(`[ingest] embed failed: ${err.message}`); }
    }

    if (dryRun) {
      console.log(`  [dry] ${classification.classification.toUpperCase().padEnd(8)} ${th.subject?.slice(0, 70) || '(no subject)'}`);
      continue;
    }

    // Don't write noise rows. They clog the index and have no retrieval value;
    // if a future user query happens to need it, Gmail still has the source.
    if (classification.classification === 'noise') {
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

  const totalMessages = threads.reduce((n, t) => n + t.messages.length, 0);
  await mcp.close();
  if (!dryRun) {
    await logActivity('ingest', 'email', account, 'mcp', `Email ingest: ${stored} threads (${totalMessages} messages, ${days}d)`);
  }
  console.log(`[ingest] done. stored ${stored} threads.`);
  return { threads: stored, messages: totalMessages };
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
