// Notion integration layer — replaces PostgreSQL as the data backend.
// Maps AB Brain data models to Notion databases.

const { Client } = require('@notionhq/client');

let notion = null;
let dbIds = {};

function init() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN environment variable is required');
  notion = new Client({ auth: token });

  dbIds = {
    knowledge: process.env.NOTION_DB_KNOWLEDGE || '',
    facts: process.env.NOTION_DB_FACTS || '',
    tasks: process.env.NOTION_DB_TASKS || '',
    projects: process.env.NOTION_DB_PROJECTS || '',
    transcripts: process.env.NOTION_DB_TRANSCRIPTS || '',
    activity_log: process.env.NOTION_DB_ACTIVITY_LOG || '',
  };

  return { notion, dbIds };
}

function getClient() {
  if (!notion) init();
  return notion;
}

function getDbId(name) {
  if (!notion) init();
  const id = dbIds[name];
  if (!id) throw new Error(`NOTION_DB_${name.toUpperCase()} not configured. Run POST /api/setup to create databases.`);
  return id;
}

// ─── Rate limiting ───────────────────────────────────────────────
// Notion API: 3 requests/second average
const queue = [];
let processing = false;
const MIN_INTERVAL = 340; // ~3 req/s

async function rateLimited(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!processing) processQueue();
  });
}

async function processQueue() {
  processing = true;
  while (queue.length > 0) {
    const { fn, resolve, reject } = queue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      if (err.status === 429) {
        const retryAfter = (err.headers?.['retry-after'] || 1) * 1000;
        await sleep(retryAfter);
        queue.unshift({ fn, resolve, reject });
      } else {
        reject(err);
      }
    }
    if (queue.length > 0) await sleep(MIN_INTERVAL);
  }
  processing = false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Database schema definitions ─────────────────────────────────
// Used by POST /api/setup to auto-create Notion databases

const DB_SCHEMAS = {
  knowledge: {
    title: 'AB Brain — Knowledge',
    icon: '🧠',
    properties: {
      Title: { title: {} },
      Content: { rich_text: {} },
      Category: { select: { options: [
        { name: 'general', color: 'default' },
        { name: 'code', color: 'blue' },
        { name: 'meeting', color: 'green' },
        { name: 'research', color: 'purple' },
        { name: 'decision', color: 'orange' },
        { name: 'reference', color: 'gray' },
        { name: 'personal', color: 'pink' },
        { name: 'transcript', color: 'yellow' },
        { name: 'journal', color: 'brown' },
        { name: 'daily-summary', color: 'default' },
      ]}},
      Tags: { multi_select: { options: [] }},
      Source: { select: { options: [
        { name: 'manual', color: 'default' },
        { name: 'api', color: 'blue' },
        { name: 'bee', color: 'yellow' },
      ]}},
      'AI Source': { select: { options: [
        { name: 'claude', color: 'purple' },
        { name: 'gemini', color: 'blue' },
        { name: 'chatgpt', color: 'green' },
        { name: 'bee', color: 'yellow' },
      ]}},
      Project: { relation: { single_property: {} }}, // linked after project DB created
      'Created At': { date: {} },
      'Updated At': { date: {} },
    }
  },
  facts: {
    title: 'AB Brain — Facts',
    icon: '🧩',
    properties: {
      Title: { title: {} },
      Content: { rich_text: {} },
      Category: { select: { options: [
        { name: 'personal', color: 'pink' },
        { name: 'preference', color: 'purple' },
        { name: 'work', color: 'blue' },
        { name: 'relationship', color: 'green' },
        { name: 'financial', color: 'orange' },
        { name: 'general', color: 'default' },
      ]}},
      Tags: { multi_select: { options: [] }},
      Source: { select: { options: [
        { name: 'bee', color: 'yellow' },
        { name: 'chatgpt', color: 'green' },
        { name: 'claude', color: 'purple' },
        { name: 'gemini', color: 'blue' },
        { name: 'manual', color: 'default' },
      ]}},
      Confirmed: { checkbox: {} },
      'Created At': { date: {} },
      'Updated At': { date: {} },
    }
  },
  tasks: {
    title: 'AB Brain — Tasks',
    icon: '✅',
    properties: {
      Title: { title: {} },
      Description: { rich_text: {} },
      Status: { select: { options: [
        { name: 'todo', color: 'red' },
        { name: 'in_progress', color: 'yellow' },
        { name: 'review', color: 'blue' },
        { name: 'done', color: 'green' },
      ]}},
      Priority: { select: { options: [
        { name: 'urgent', color: 'red' },
        { name: 'high', color: 'orange' },
        { name: 'medium', color: 'yellow' },
        { name: 'low', color: 'gray' },
      ]}},
      'AI Agent': { select: { options: [
        { name: 'claude', color: 'purple' },
        { name: 'gemini', color: 'blue' },
        { name: 'chatgpt', color: 'green' },
        { name: 'bee', color: 'yellow' },
      ]}},
      'Next Steps': { rich_text: {} },
      'Output Log': { rich_text: {} },
      Project: { relation: { single_property: {} }}, // linked after project DB created
      'Created At': { date: {} },
      'Updated At': { date: {} },
    }
  },
  projects: {
    title: 'AB Brain — Projects',
    icon: '📁',
    properties: {
      Name: { title: {} },
      Description: { rich_text: {} },
      Status: { select: { options: [
        { name: 'active', color: 'green' },
        { name: 'paused', color: 'yellow' },
        { name: 'completed', color: 'blue' },
        { name: 'archived', color: 'gray' },
      ]}},
      'Created At': { date: {} },
      'Updated At': { date: {} },
    }
  },
  transcripts: {
    title: 'AB Brain — Transcripts',
    icon: '🎙️',
    properties: {
      Title: { title: {} },
      Summary: { rich_text: {} },
      Source: { select: { options: [
        { name: 'bee', color: 'yellow' },
        { name: 'chatgpt', color: 'green' },
        { name: 'claude', color: 'purple' },
        { name: 'gemini', color: 'blue' },
        { name: 'manual', color: 'default' },
      ]}},
      'AI Source': { select: { options: [
        { name: 'claude', color: 'purple' },
        { name: 'gemini', color: 'blue' },
        { name: 'chatgpt', color: 'green' },
        { name: 'bee', color: 'yellow' },
      ]}},
      'Duration (sec)': { number: {} },
      'Recorded At': { date: {} },
      Location: { rich_text: {} },
      Tags: { multi_select: { options: [] }},
      'Bee ID': { rich_text: {} },
      Project: { relation: { single_property: {} }}, // linked after project DB created
      'Created At': { date: {} },
      'Updated At': { date: {} },
    }
  },
  activity_log: {
    title: 'AB Brain — Activity Log',
    icon: '📋',
    properties: {
      Title: { title: {} },
      Action: { select: { options: [
        { name: 'create', color: 'green' },
        { name: 'update', color: 'yellow' },
        { name: 'delete', color: 'red' },
        { name: 'sync', color: 'blue' },
      ]}},
      'Entity Type': { select: { options: [
        { name: 'knowledge', color: 'purple' },
        { name: 'task', color: 'green' },
        { name: 'project', color: 'blue' },
        { name: 'transcript', color: 'yellow' },
        { name: 'bee-import', color: 'yellow' },
      ]}},
      'Entity ID': { rich_text: {} },
      'AI Source': { select: { options: [
        { name: 'claude', color: 'purple' },
        { name: 'gemini', color: 'blue' },
        { name: 'chatgpt', color: 'green' },
        { name: 'bee', color: 'yellow' },
      ]}},
      Details: { rich_text: {} },
      'Created At': { date: {} },
    }
  }
};

// ─── Setup: create all databases under a parent page ─────────────

async function setupDatabases(parentPageId) {
  const n = getClient();
  const created = {};

  for (const [key, schema] of Object.entries(DB_SCHEMAS)) {
    // Skip relation property during creation (add after)
    const props = { ...schema.properties };
    if (props.Project && props.Project.relation) {
      delete props.Project;
    }

    const db = await rateLimited(() => n.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: schema.title } }],
      icon: schema.icon ? { type: 'emoji', emoji: schema.icon } : undefined,
      initial_data_source: { properties: props },
    }));
    created[key] = db.id;
    dbIds[key] = db.id;
  }

  // Add Project relations to tasks, knowledge, transcripts, facts
  const dbsNeedingProjectRelation = ['tasks', 'knowledge', 'transcripts', 'facts'];
  if (created.projects) {
    for (const dbKey of dbsNeedingProjectRelation) {
      if (created[dbKey]) {
        await rateLimited(() => n.databases.update({
          database_id: created[dbKey],
          properties: {
            Project: { relation: { database_id: created.projects, single_property: {} } }
          }
        }));
      }
    }
  }

  return created;
}

// ─── Helpers: convert Notion pages to plain objects ──────────────

function richTextToString(prop) {
  if (!prop || !Array.isArray(prop)) return '';
  return prop.map(p => p.plain_text || '').join('');
}

function pageToKnowledge(page) {
  const p = page.properties;
  return {
    id: page.id,
    title: richTextToString(p.Title?.title),
    content: richTextToString(p.Content?.rich_text),
    category: p.Category?.select?.name || 'general',
    tags: (p.Tags?.multi_select || []).map(t => t.name),
    source: p.Source?.select?.name || 'manual',
    ai_source: p['AI Source']?.select?.name || null,
    project_id: p.Project?.relation?.[0]?.id || null,
    created_at: p['Created At']?.date?.start || page.created_time,
    updated_at: p['Updated At']?.date?.start || page.last_edited_time,
  };
}

function pageToFact(page) {
  const p = page.properties;
  return {
    id: page.id,
    title: richTextToString(p.Title?.title),
    content: richTextToString(p.Content?.rich_text),
    category: p.Category?.select?.name || 'general',
    tags: (p.Tags?.multi_select || []).map(t => t.name),
    source: p.Source?.select?.name || 'manual',
    confirmed: p.Confirmed?.checkbox || false,
    created_at: p['Created At']?.date?.start || page.created_time,
    updated_at: p['Updated At']?.date?.start || page.last_edited_time,
  };
}

function pageToTask(page) {
  const p = page.properties;
  return {
    id: page.id,
    title: richTextToString(p.Title?.title),
    description: richTextToString(p.Description?.rich_text),
    status: p.Status?.select?.name || 'todo',
    priority: p.Priority?.select?.name || 'medium',
    ai_agent: p['AI Agent']?.select?.name || null,
    next_steps: richTextToString(p['Next Steps']?.rich_text),
    output_log: richTextToString(p['Output Log']?.rich_text),
    project_id: p.Project?.relation?.[0]?.id || null,
    created_at: p['Created At']?.date?.start || page.created_time,
    updated_at: p['Updated At']?.date?.start || page.last_edited_time,
  };
}

function pageToProject(page) {
  const p = page.properties;
  return {
    id: page.id,
    name: richTextToString(p.Name?.title),
    description: richTextToString(p.Description?.rich_text),
    status: p.Status?.select?.name || 'active',
    created_at: p['Created At']?.date?.start || page.created_time,
    updated_at: p['Updated At']?.date?.start || page.last_edited_time,
  };
}

function pageToTranscript(page) {
  const p = page.properties;
  return {
    id: page.id,
    title: richTextToString(p.Title?.title),
    summary: richTextToString(p.Summary?.rich_text),
    source: p.Source?.select?.name || 'bee',
    ai_source: p['AI Source']?.select?.name || null,
    duration_seconds: p['Duration (sec)']?.number || null,
    recorded_at: p['Recorded At']?.date?.start || null,
    location: richTextToString(p.Location?.rich_text) || null,
    tags: (p.Tags?.multi_select || []).map(t => t.name),
    bee_id: richTextToString(p['Bee ID']?.rich_text) || null,
    project_id: p.Project?.relation?.[0]?.id || null,
    created_at: p['Created At']?.date?.start || page.created_time,
    updated_at: p['Updated At']?.date?.start || page.last_edited_time,
  };
}

function pageToActivity(page) {
  const p = page.properties;
  return {
    id: page.id,
    action: p.Action?.select?.name || '',
    entity_type: p['Entity Type']?.select?.name || '',
    entity_id: richTextToString(p['Entity ID']?.rich_text),
    ai_source: p['AI Source']?.select?.name || null,
    details: richTextToString(p.Details?.rich_text),
    created_at: p['Created At']?.date?.start || page.created_time,
  };
}

// ─── Helpers: truncate text for Notion's 2000-char rich_text limit ─

function truncate(str, max = 2000) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 3) + '...' : str;
}

function richText(str) {
  const s = truncate(str);
  if (!s) return [];
  return [{ type: 'text', text: { content: s } }];
}

function dateOrNull(val) {
  if (!val) return null;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return { start: d.toISOString() };
  } catch { return null; }
}

function selectOrNull(val) {
  if (!val) return null;
  return { name: val };
}

function multiSelect(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.filter(Boolean).map(name => ({ name: String(name) }));
}

// ─── CRUD helpers ────────────────────────────────────────────────

async function queryDatabase(dbName, filter, sorts, pageSize = 50, startCursor) {
  const n = getClient();
  const params = {
    database_id: getDbId(dbName),
    page_size: Math.min(pageSize, 100),
  };
  if (filter) params.filter = filter;
  if (sorts) params.sorts = sorts;
  if (startCursor) params.start_cursor = startCursor;
  return rateLimited(() => n.databases.query(params));
}

async function createPage(dbName, properties, children) {
  const n = getClient();
  const params = {
    parent: { database_id: getDbId(dbName) },
    properties,
  };
  if (children) params.children = children;
  return rateLimited(() => n.pages.create(params));
}

async function getPage(pageId) {
  const n = getClient();
  return rateLimited(() => n.pages.retrieve({ page_id: pageId }));
}

async function updatePage(pageId, properties) {
  const n = getClient();
  return rateLimited(() => n.pages.update({ page_id: pageId, properties }));
}

async function archivePage(pageId) {
  const n = getClient();
  return rateLimited(() => n.pages.update({ page_id: pageId, archived: true }));
}

async function searchNotion(query, filter) {
  const n = getClient();
  const params = { query };
  if (filter) params.filter = filter;
  params.page_size = 20;
  return rateLimited(() => n.search(params));
}

// Read page body content (for transcript raw_text stored as blocks)
async function getPageBlocks(pageId) {
  const n = getClient();
  const blocks = [];
  let cursor;
  do {
    const resp = await rateLimited(() => n.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    }));
    blocks.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return blocks;
}

function blocksToText(blocks) {
  return blocks.map(b => {
    if (b.type === 'paragraph') return richTextToString(b.paragraph?.rich_text);
    if (b.type === 'heading_1') return richTextToString(b.heading_1?.rich_text);
    if (b.type === 'heading_2') return richTextToString(b.heading_2?.rich_text);
    if (b.type === 'heading_3') return richTextToString(b.heading_3?.rich_text);
    if (b.type === 'bulleted_list_item') return '• ' + richTextToString(b.bulleted_list_item?.rich_text);
    if (b.type === 'numbered_list_item') return richTextToString(b.numbered_list_item?.rich_text);
    if (b.type === 'code') return richTextToString(b.code?.rich_text);
    return '';
  }).filter(Boolean).join('\n');
}

// Write long text as page body blocks (Notion rich_text max 2000 chars per block)
function textToBlocks(text) {
  if (!text) return [];
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push(text.substring(i, i + 2000));
  }
  return chunks.map(chunk => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] }
  }));
}

// ─── Activity log helper ─────────────────────────────────────────

async function logActivity(action, entityType, entityId, aiSource, details) {
  try {
    await createPage('activity_log', {
      Title: { title: richText(details || `${action} ${entityType}`) },
      Action: { select: selectOrNull(action) },
      'Entity Type': { select: selectOrNull(entityType) },
      'Entity ID': { rich_text: richText(entityId || '') },
      'AI Source': { select: selectOrNull(aiSource) },
      Details: { rich_text: richText(details || '') },
      'Created At': { date: dateOrNull(new Date()) },
    });
  } catch (err) {
    console.error(`[activity-log] Failed to log: ${err.message}`);
  }
}

module.exports = {
  init,
  getClient,
  getDbId,
  rateLimited,
  setupDatabases,
  DB_SCHEMAS,
  // Converters
  pageToKnowledge,
  pageToFact,
  pageToTask,
  pageToProject,
  pageToTranscript,
  pageToActivity,
  richTextToString,
  // Helpers
  truncate,
  richText,
  dateOrNull,
  selectOrNull,
  multiSelect,
  textToBlocks,
  blocksToText,
  // CRUD
  queryDatabase,
  createPage,
  getPage,
  updatePage,
  archivePage,
  searchNotion,
  getPageBlocks,
  logActivity,
};
