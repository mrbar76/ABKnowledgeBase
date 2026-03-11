const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { init: initNotion, setupDatabases, searchNotion, getClient, rateLimited, queryDatabase, archivePage, getDbId, DB_SCHEMAS } = require('./notion');
const syncStatus = require('./sync-status');

const knowledgeRoutes = require('./routes/knowledge');
const factsRoutes = require('./routes/facts');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const transcriptRoutes = require('./routes/transcripts');
const activityRoutes = require('./routes/activity');
const dashboardRoutes = require('./routes/dashboard');
const beeRoutes = require('./routes/bee');
const searchRoutes = require('./routes/search');
const intakeRoutes = require('./routes/intake');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend (kept for legacy/simple status page)
app.use(express.static(path.join(__dirname, 'public')));

// Health check — BEFORE auth middleware
app.get('/api/health-check', (req, res) => {
  res.json({ status: 'ok', backend: 'notion', timestamp: new Date().toISOString() });
});

// OpenAPI spec — no auth
app.get('/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'openapi-chatgpt.json'));
});

// Privacy policy
app.get('/privacy', (req, res) => {
  res.type('text/html').send(`<!DOCTYPE html><html><head><title>AB Brain - Privacy</title></head><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
    <h1>AB Brain - Privacy Policy</h1>
    <p>AB Brain is a personal knowledge base backed by Notion. All data is stored in your Notion workspace and only accessible via authenticated API calls. No data is shared with third parties.</p>
    <p>Last updated: 2026</p></body></html>`);
});

// API key authentication for /api routes
app.use('/api', (req, res, next) => {
  // Skip auth for setup and health-check
  if (req.path === '/health-check' || req.path === '/setup') return next();
  if (!API_KEY) return next();

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
});

// ─── Setup endpoint: creates all Notion databases ────────────────
// POST /api/setup { "parent_page_id": "your-notion-page-id" }
app.post('/api/setup', async (req, res) => {
  try {
    const { parent_page_id } = req.body;
    if (!parent_page_id) {
      return res.status(400).json({
        error: 'parent_page_id is required',
        instructions: [
          '1. Create a page in Notion called "AB Brain"',
          '2. Share it with your integration (Settings > Integrations > find your integration > Share)',
          '3. Copy the page ID from the URL (the 32-char hex string after the page name)',
          '4. POST /api/setup with { "parent_page_id": "your-page-id" }',
        ]
      });
    }

    initNotion();
    console.log('[setup] Creating Notion databases...');
    const dbIds = await setupDatabases(parent_page_id);
    console.log('[setup] Databases created:', dbIds);

    res.json({
      message: 'Notion databases created successfully!',
      databases: dbIds,
      next_steps: [
        'Add these database IDs to your environment variables:',
        `NOTION_DB_KNOWLEDGE=${dbIds.knowledge}`,
        `NOTION_DB_FACTS=${dbIds.facts}`,
        `NOTION_DB_TASKS=${dbIds.tasks}`,
        `NOTION_DB_PROJECTS=${dbIds.projects}`,
        `NOTION_DB_TRANSCRIPTS=${dbIds.transcripts}`,
        `NOTION_DB_ACTIVITY_LOG=${dbIds.activity_log}`,
        '',
        'Then restart the server. Your AIs can now read/write to Notion via the same API.',
      ]
    });
  } catch (err) {
    console.error('[setup] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Database status: check which databases are configured ────────
app.get('/api/db-status', (req, res) => {
  const expected = ['knowledge', 'facts', 'tasks', 'projects', 'transcripts', 'activity_log'];
  const status = {};
  for (const name of expected) {
    try {
      const id = getDbId(name);
      status[name] = { configured: true, id };
    } catch {
      status[name] = { configured: false };
    }
  }
  const missing = expected.filter(n => !status[n].configured);
  res.json({ status, missing, all_configured: missing.length === 0 });
});

// ─── Create missing databases only ───────────────────────────────
app.post('/api/setup-missing', async (req, res) => {
  try {
    const { parent_page_id } = req.body;
    if (!parent_page_id) {
      return res.status(400).json({ error: 'parent_page_id is required' });
    }

    initNotion();
    const n = getClient();
    const expected = ['knowledge', 'facts', 'tasks', 'projects', 'transcripts', 'activity_log'];
    const missing = expected.filter(name => {
      try { getDbId(name); return false; } catch { return true; }
    });

    if (!missing.length) {
      return res.json({ message: 'All databases already configured', created: {} });
    }

    const created = {};
    for (const key of missing) {
      const schema = DB_SCHEMAS[key];
      if (!schema) continue;

      const props = { ...schema.properties };
      if (props.Project && props.Project.relation) delete props.Project;

      const db = await rateLimited(() => n.databases.create({
        parent: { type: 'page_id', page_id: parent_page_id },
        title: [{ type: 'text', text: { content: schema.title } }],
        icon: schema.icon ? { type: 'emoji', emoji: schema.icon } : undefined,
        initial_data_source: { properties: props },
      }));
      created[key] = db.id;
    }

    // Add Project relations if projects DB exists
    let projectsId;
    try { projectsId = getDbId('projects'); } catch {}
    if (projectsId) {
      for (const dbKey of ['tasks', 'knowledge', 'transcripts', 'facts']) {
        if (created[dbKey]) {
          await rateLimited(() => n.databases.update({
            database_id: created[dbKey],
            properties: {
              Project: { relation: { database_id: projectsId, single_property: {} } }
            }
          }));
        }
      }
    }

    const envLines = Object.entries(created).map(([k, v]) =>
      `NOTION_DB_${k.toUpperCase()}=${v}`
    );

    res.json({
      message: `Created ${Object.keys(created).length} missing database(s)`,
      created,
      env_vars: envLines,
      next_steps: [
        'Add these to your environment variables and restart:',
        ...envLines,
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cleanup: archive orphaned Notion databases ───────────────────
// POST /api/cleanup — finds and archives databases that are no longer used
const cleanupState = { running: false, result: null };

app.post('/api/cleanup', async (req, res) => {
  if (cleanupState.running) {
    return res.json({ status: 'running' });
  }

  cleanupState.running = true;
  cleanupState.result = null;
  res.json({ status: 'started' });

  try {
    initNotion();
    const n = getClient();
    const orphanNames = [
      'AB Brain — Health Metrics',
      'AB Brain — Workouts',
    ];
    const archived = [];
    const notFound = [];

    for (const name of orphanNames) {
      try {
        const searchRes = await rateLimited(() => n.search({
          query: name,
          filter: { value: 'database', property: 'object' },
          page_size: 5,
        }));

        const matches = searchRes.results.filter(r =>
          r.title?.some(t => t.plain_text === name)
        );

        if (matches.length === 0) {
          notFound.push(name);
          continue;
        }

        for (const db of matches) {
          await rateLimited(() => n.databases.update({
            database_id: db.id,
            archived: true,
          }));
          archived.push({ name, id: db.id });
        }
      } catch (e) {
        notFound.push(`${name} (error: ${e.message})`);
      }
    }

    cleanupState.result = {
      message: `Archived ${archived.length} orphaned database(s)`,
      archived,
      not_found: notFound,
    };
  } catch (err) {
    cleanupState.result = { error: err.message };
  } finally {
    cleanupState.running = false;
  }
});

app.get('/api/cleanup/status', (req, res) => {
  if (cleanupState.running) return res.json({ status: 'running' });
  if (cleanupState.result) {
    const result = cleanupState.result;
    cleanupState.result = null;
    return res.json({ status: 'done', ...result });
  }
  res.json({ status: 'idle' });
});

// ─── Purge: clear all entries from a Notion database ──────────────
// POST /api/purge { "databases": ["knowledge", "facts", "tasks", "transcripts"] }
// Omit "databases" to clear all content databases (excludes activity_log)
// Purge runs as a background job so it doesn't timeout
const purgeState = { running: false, progress: null, result: null };

app.post('/api/purge', async (req, res) => {
  if (purgeState.running) {
    return res.json({ status: 'running', progress: purgeState.progress });
  }
  try {
    initNotion();
    const allowed = ['knowledge', 'facts', 'tasks', 'projects', 'transcripts'];
    const requested = req.body.databases || allowed;
    const targets = requested.filter(d => allowed.includes(d));

    if (!targets.length) {
      return res.status(400).json({ error: 'No valid databases specified', allowed });
    }

    purgeState.running = true;
    purgeState.progress = { current: 0, currentDb: targets[0], databases: targets };
    purgeState.result = null;

    // Respond immediately — client will poll /api/purge/status
    res.json({ status: 'started', databases: targets });

    // Run purge in background
    let totalArchived = 0;
    const results = {};
    const skipped = [];

    for (const dbName of targets) {
      purgeState.progress.currentDb = dbName;
      let archived = 0;
      try {
        let hasMore = true;
        while (hasMore) {
          const result = await queryDatabase(dbName, undefined, undefined, 100);
          if (!result.results.length) { hasMore = false; break; }
          for (const page of result.results) {
            try { await archivePage(page.id); archived++; purgeState.progress.current++; } catch {}
          }
        }
        results[dbName] = archived;
        totalArchived += archived;
      } catch (e) {
        skipped.push(`${dbName}: ${e.message}`);
        results[dbName] = 'skipped';
      }
    }

    purgeState.result = {
      message: `Purged ${totalArchived} entries${skipped.length ? ` (${skipped.length} skipped)` : ''}`,
      results,
      skipped,
    };
    purgeState.running = false;
  } catch (err) {
    purgeState.result = { error: err.message };
    purgeState.running = false;
  }
});

app.get('/api/purge/status', (req, res) => {
  if (purgeState.running) {
    return res.json({ status: 'running', progress: purgeState.progress });
  }
  if (purgeState.result) {
    const result = purgeState.result;
    purgeState.result = null; // Clear after reading
    return res.json({ status: 'done', ...result });
  }
  res.json({ status: 'idle' });
});

// API Routes
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/facts', factsRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/transcripts', transcriptRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/bee', beeRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/intake', intakeRoutes);

// Sync status — returns state of all data sources and recent job history
app.get('/api/sync-status', (req, res) => {
  res.json(syncStatus.getStatus());
});

// Import notification — frontend calls this after completing a file import
app.post('/api/sync-status/import-complete', (req, res) => {
  const { source, imported, skipped, failed, total } = req.body;
  const srcName = source || 'unknown';
  syncStatus.initSource(srcName, { label: `${srcName.charAt(0).toUpperCase() + srcName.slice(1)} Import` });
  const job = syncStatus.startJob(srcName, `File import: ${total || 0} conversations`);
  syncStatus.completeJob(srcName, job, {
    imported: imported || 0,
    skipped: (skipped || 0) + (failed || 0),
    errors: failed > 0 ? [`${failed} conversations failed to import`] : [],
    details: { total, imported, skipped, failed },
  });
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AB Brain (Notion backend) running on port ${PORT}`);
});

// Initialize Notion connection
try {
  initNotion();
  console.log('Notion client initialized');
} catch (err) {
  console.warn(`Notion not configured yet: ${err.message}`);
  console.warn('POST /api/setup to create databases, then set env vars and restart.');
}

// ─── Initialize sync sources ─────────────────────────────────────
syncStatus.initSource('bee', { label: 'Bee Wearable', cron_enabled: !!process.env.BEE_API_TOKEN });
syncStatus.initSource('chatgpt', { label: 'ChatGPT Import' });
syncStatus.initSource('claude', { label: 'Claude Import' });
syncStatus.initSource('intake', { label: 'Smart Intake' });

// ─── Cron: scheduled auto-sync ───────────────────────────────────
// Runs Bee sync on a configurable interval (default 30 min)

const BEE_TOKEN = process.env.BEE_API_TOKEN;
const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL || process.env.BEE_SYNC_INTERVAL || 30) * 60 * 1000;

if (BEE_TOKEN) {
  const http = require('http');
  const beeSource = syncStatus.getSource('bee');
  beeSource.cron_enabled = true;
  beeSource.cron_interval_min = SYNC_INTERVAL / 60000;

  async function runScheduledSync() {
    console.log('[cron] Starting scheduled sync...');
    const job = syncStatus.startJob('bee', 'Scheduled incremental sync');
    const startTime = Date.now();

    // Bee incremental sync
    try {
      const payload = JSON.stringify({ bee_token: BEE_TOKEN });
      const result = await httpPost(`http://127.0.0.1:${PORT}/api/bee/sync-incremental`, payload);
      const i = result.imported || {};
      const imported = (i.facts || 0) + (i.todos || 0) + (i.conversations || 0);
      console.log(`[cron] Bee: ${i.facts || 0}F ${i.todos || 0}T ${i.conversations || 0}C (${result.changes_processed || 0} changes, ${Date.now() - startTime}ms)`);
      if (i.errors?.length) console.log(`[cron] Errors: ${i.errors.join(', ')}`);
      syncStatus.completeJob('bee', job, {
        imported,
        skipped: i.skipped || 0,
        errors: i.errors || [],
        details: { facts: i.facts || 0, todos: i.todos || 0, conversations: i.conversations || 0, changes_processed: result.changes_processed || 0 },
      });
    } catch (e) {
      console.error(`[cron] Bee sync failed: ${e.message}`);
      syncStatus.failJob('bee', job, e.message);
    }

    console.log(`[cron] Done (${Date.now() - startTime}ms)`);
  }

  function httpPost(url, payload) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const req = http.request(parsedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': API_KEY || '',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(data)); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // First sync 10 seconds after startup
  setTimeout(runScheduledSync, 10000);
  // Then every N minutes
  setInterval(runScheduledSync, SYNC_INTERVAL);
  console.log(`[cron] Scheduled every ${SYNC_INTERVAL / 60000} min (BEE_API_TOKEN configured)`);
} else {
  console.log('[cron] No sync sources configured (set BEE_API_TOKEN to enable)');
}
