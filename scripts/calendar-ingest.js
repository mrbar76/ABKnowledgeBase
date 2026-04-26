#!/usr/bin/env node
// Calendar ingestion driver.
//
//   node scripts/calendar-ingest.js probe                      # list MCP tools
//   node scripts/calendar-ingest.js ingest [--account=...] [--days=14] [--past=7] [--limit=500] [--dry-run]
//
// Pulls calendar events from a remote MCP server (gcal_* tools), classifies
// each event, embeds the summary, and upserts a pointer row into
// calendar_events. Full event payloads are NOT stored long-term beyond the
// fields we extract; fetch-on-demand via routes/calendar.js for raw details.

require('dotenv').config?.();
const { McpClient } = require('../lib/mcp-client');
const { query, logActivity } = require('../db');

const MCP_URL = process.env.MCP_GMAIL_URL || 'https://gmail-multi-mcp-production.up.railway.app/mcp';
const MCP_TOKEN = process.env.MCP_GMAIL_TOKEN || '';
const CLASSIFIER_MODEL = process.env.CALENDAR_CLASSIFIER_MODEL || process.env.EMAIL_CLASSIFIER_MODEL || 'gpt-4o-mini';
const EMBEDDING_MODEL = process.env.CALENDAR_EMBEDDING_MODEL || process.env.EMAIL_EMBEDDING_MODEL || 'text-embedding-3-small';
const PROMPT_VERSION = 'calendar-classifier@2026-04-26.v1';

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

function pickTool(tools, patterns) {
  for (const p of patterns) {
    const re = new RegExp(p, 'i');
    const t = tools.find(t => re.test(t.name));
    if (t) return t;
  }
  return null;
}

async function discoverGcalTools(mcp) {
  const { tools } = await mcp.listTools();
  const names = tools.map(t => t.name);
  const list = pickTool(tools, ['gcal_list_events', 'list_events', 'calendar_list_events']);
  const search = pickTool(tools, ['gcal_search_events', 'search_events', 'calendar_search']);
  const get = pickTool(tools, ['gcal_get_event', 'get_event', 'calendar_get_event']);
  const listCalendars = pickTool(tools, ['gcal_list_calendars', 'list_calendars']);
  const fetcher = search || list;
  if (!fetcher) {
    throw new Error(`No calendar list/search tool found. Available:\n  ${names.join('\n  ')}`);
  }
  return { fetcher, get, listCalendars, allNames: names };
}

function buildFetcherArgs(tool, { account, calendarId, timeMin, timeMax, max, q }) {
  const props = tool?.inputSchema?.properties || {};
  const args = {};
  if (account) {
    if ('account' in props) args.account = account;
    else if ('userId' in props) args.userId = account;
    else if ('user' in props) args.user = account;
    else if ('email' in props) args.email = account;
  }
  if (calendarId) {
    if ('calendarId' in props) args.calendarId = calendarId;
    else if ('calendar_id' in props) args.calendar_id = calendarId;
    else if ('calendar' in props) args.calendar = calendarId;
  }
  if (timeMin) {
    if ('timeMin' in props) args.timeMin = timeMin;
    else if ('time_min' in props) args.time_min = timeMin;
    else if ('start' in props) args.start = timeMin;
    else if ('after' in props) args.after = timeMin;
  }
  if (timeMax) {
    if ('timeMax' in props) args.timeMax = timeMax;
    else if ('time_max' in props) args.time_max = timeMax;
    else if ('end' in props) args.end = timeMax;
    else if ('before' in props) args.before = timeMax;
  }
  if (max != null) {
    if ('maxResults' in props) args.maxResults = max;
    else if ('limit' in props) args.limit = max;
    else if ('max' in props) args.max = max;
  }
  if (q && 'q' in props) args.q = q;
  if (q && 'query' in props) args.query = q;
  return args;
}

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
  return { _raw: blocks.map(b => b.text || '').join('') };
}

let _openai;
function openai() {
  if (_openai) return _openai;
  const OpenAI = require('openai');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const CLASSIFIER_PROMPT = `You triage calendar events for a personal knowledge index.

Classify into one of:
  - "noise"   : auto-generated, blocked time without info, focus blocks, lunch
  - "index"   : real but routine (1:1s, recurring standups, regular check-ins)
  - "distill" : substantive (board meetings, customer calls, interviews, decisions, deals, deadlines)

Return ONLY JSON:
{
  "classification": "noise" | "index" | "distill",
  "confidence": 0.0-1.0,
  "summary": "1 sentence for index, 2-3 sentences for distill including who/what/why",
  "entities": ["people, companies, projects mentioned"],
  "topics": ["short lowercase topic tags"]
}

Rules:
- Use the title, attendees, description, and location to decide.
- Recurring 1:1s and standups are usually "index".
- External-attendee meetings, board/exec meetings, interviews, customer calls usually "distill".
- Personal calendar items (lunch, gym, commute) are usually "noise".
- Never invent. If you don't know who someone is, just use their email/name as given.`;

async function classifyEvent(eventForLLM) {
  const client = openai();
  const res = await client.chat.completions.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 350,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFIER_PROMPT },
      { role: 'user', content: JSON.stringify(eventForLLM).slice(0, 6000) },
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

// ─── normalize event ────────────────────────────────────────────────────────
function pickDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return new Date(d);
  if (d.dateTime) return new Date(d.dateTime);
  if (d.date) return new Date(d.date); // all-day
  return null;
}

function normalizeEvent(raw, account) {
  const start = pickDate(raw.start) || pickDate(raw.startTime) || (raw.start_time ? new Date(raw.start_time) : null);
  const end = pickDate(raw.end) || pickDate(raw.endTime) || (raw.end_time ? new Date(raw.end_time) : null);
  const allDay = !!(raw.start?.date && !raw.start?.dateTime);
  const organizerEmail = raw.organizer?.email?.toLowerCase() || raw.organizer_email || null;
  const organizerName = raw.organizer?.displayName || raw.organizer?.name || raw.organizer_name || null;
  const attendeesRaw = raw.attendees || [];
  const attendees = attendeesRaw.map(a => ({
    email: (a.email || '').toLowerCase() || null,
    name: a.displayName || a.name || null,
    response: a.responseStatus || a.response || null,
    optional: !!a.optional,
  })).filter(a => a.email);

  return {
    id: raw.id || raw.eventId || raw.event_id,
    icalUid: raw.iCalUID || raw.icalUid || raw.ical_uid || null,
    recurringEventId: raw.recurringEventId || raw.recurring_event_id || null,
    calendarId: raw.calendarId || raw.calendar_id || raw.organizer?.email || null,
    title: raw.summary || raw.title || '(no title)',
    description: raw.description || null,
    location: raw.location || null,
    start, end, allDay,
    status: raw.status || null,
    organizerEmail, organizerName,
    attendees,
    accountUsed: account,
  };
}

async function upsertEvent(ev, classification, embedding) {
  const sql = `
    INSERT INTO calendar_events (
      provider, account, calendar_id, event_provider_id, recurring_event_id, ical_uid,
      title, description, location, start_time, end_time, all_day, status,
      organizer_email, organizer_name, attendees, attendee_count,
      classification, classifier_confidence, classifier_model, classifier_prompt_version,
      summary, entities, topics, embedding, embedding_model,
      search_vector, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,$10,$11,$12,$13,
      $14,$15,$16::jsonb,$17,
      $18,$19,$20,$21,
      $22,$23::jsonb,$24::jsonb,$25,$26,
      to_tsvector('english', coalesce($7,'') || ' ' || coalesce($22,'') || ' ' || coalesce($9,'')),
      NOW()
    )
    ON CONFLICT (provider, account, event_provider_id) DO UPDATE SET
      calendar_id = EXCLUDED.calendar_id,
      recurring_event_id = EXCLUDED.recurring_event_id,
      ical_uid = EXCLUDED.ical_uid,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      location = EXCLUDED.location,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      all_day = EXCLUDED.all_day,
      status = EXCLUDED.status,
      organizer_email = EXCLUDED.organizer_email,
      organizer_name = EXCLUDED.organizer_name,
      attendees = EXCLUDED.attendees,
      attendee_count = EXCLUDED.attendee_count,
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
    'gcal',
    ev.accountUsed,
    ev.calendarId,
    ev.id,
    ev.recurringEventId,
    ev.icalUid,
    ev.title,
    ev.description ? ev.description.slice(0, 2000) : null,
    ev.location,
    ev.start,
    ev.end,
    ev.allDay,
    ev.status,
    ev.organizerEmail,
    ev.organizerName,
    JSON.stringify(ev.attendees),
    ev.attendees.length,
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

async function probe() {
  const mcp = new McpClient({
    url: MCP_URL,
    headers: MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {},
  });
  console.log(`[cal-probe] connecting to ${MCP_URL}`);
  await mcp.initialize();
  const { tools } = await mcp.listTools();
  const cal = tools.filter(t => /^(gcal_|calendar_)/i.test(t.name));
  console.log(`[cal-probe] ${cal.length} calendar tools (of ${tools.length} total):\n`);
  for (const t of cal) {
    const params = Object.keys(t.inputSchema?.properties || {}).join(', ');
    console.log(`  ${t.name}(${params})`);
    if (t.description) console.log(`     ${t.description.slice(0, 160)}`);
  }
  await mcp.close();
}

async function ingest({ account, days, past, limit, calendarId, dryRun }) {
  const mcp = new McpClient({
    url: MCP_URL,
    headers: MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {},
  });
  console.log(`[cal-ingest] account=${account} days=+${days} past=-${past} cal=${calendarId || 'primary'} limit=${limit} dryRun=${dryRun}`);
  await mcp.initialize();
  const { fetcher } = await discoverGcalTools(mcp);
  console.log(`[cal-ingest] using fetcher=${fetcher.name}`);

  const now = Date.now();
  const timeMin = new Date(now - past * 86400000).toISOString();
  const timeMax = new Date(now + days * 86400000).toISOString();

  const args = buildFetcherArgs(fetcher, {
    account,
    calendarId: calendarId || 'primary',
    timeMin, timeMax,
    max: limit,
  });
  const result = parseToolResult(await mcp.callTool(fetcher.name, args));
  const events = result.events || result.items || result.results || result.data || [];
  if (!events.length) {
    console.log(`[cal-ingest] no events. Raw shape keys: ${Object.keys(result).join(', ')}`);
    await mcp.close();
    return { events: 0 };
  }
  console.log(`[cal-ingest] fetched ${events.length} events`);

  const normalized = events.map(e => normalizeEvent(e, account)).filter(e => e.id);
  let stored = 0;

  for (const ev of normalized) {
    const eventForLLM = {
      title: ev.title,
      description: (ev.description || '').slice(0, 800),
      location: ev.location,
      start: ev.start, end: ev.end, allDay: ev.allDay,
      status: ev.status,
      organizer: ev.organizerEmail,
      attendees: ev.attendees.slice(0, 25),
      attendeeCount: ev.attendees.length,
    };

    let classification;
    try { classification = await classifyEvent(eventForLLM); }
    catch (err) {
      console.warn(`[cal-ingest] classifier failed for ${ev.id}: ${err.message}`);
      classification = { classification: 'index', confidence: 0.2, summary: ev.title, entities: [], topics: [] };
    }

    let embedding = null;
    if (classification.classification !== 'noise' && classification.summary?.trim()) {
      try { embedding = await embedSummary(classification.summary); }
      catch (err) { console.warn(`[cal-ingest] embed failed: ${err.message}`); }
    }

    if (dryRun) {
      const when = ev.start ? new Date(ev.start).toISOString().slice(0, 16) : '????';
      console.log(`  [dry] ${classification.classification.toUpperCase().padEnd(8)} ${when}  ${ev.title?.slice(0, 60)}`);
      continue;
    }

    try {
      await upsertEvent(ev, classification, embedding);
      stored++;
    } catch (err) {
      console.error(`[cal-ingest] upsert failed for ${ev.id}: ${err.message}`);
    }
  }

  await mcp.close();
  if (!dryRun) {
    await logActivity('ingest', 'calendar', account, 'mcp', `Calendar ingest: ${stored} events (${past}d past, ${days}d future)`);
  }
  console.log(`[cal-ingest] done. stored ${stored} events.`);
  return { events: stored };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  if (cmd === 'probe') {
    await probe();
  } else if (cmd === 'ingest') {
    const account = args.account || 'avibar.js@gmail.com';
    const days = Number(args.days || 14);
    const past = Number(args.past || 7);
    const limit = Number(args.limit || 500);
    const calendarId = args.calendar || null;
    const dryRun = !!args['dry-run'];
    await ingest({ account, days, past, limit, calendarId, dryRun });
  } else {
    console.log(`Usage:
  node scripts/calendar-ingest.js probe
  node scripts/calendar-ingest.js ingest [--account=avibar.js@gmail.com] [--days=14] [--past=7] [--limit=500] [--calendar=primary] [--dry-run]`);
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
