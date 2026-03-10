const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { init: initNotion, setupDatabases } = require('./notion');

const knowledgeRoutes = require('./routes/knowledge');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const transcriptRoutes = require('./routes/transcripts');
const healthRoutes = require('./routes/health');
const activityRoutes = require('./routes/activity');
const dashboardRoutes = require('./routes/dashboard');
const beeRoutes = require('./routes/bee');
const searchRoutes = require('./routes/search');

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
        `NOTION_DB_TASKS=${dbIds.tasks}`,
        `NOTION_DB_PROJECTS=${dbIds.projects}`,
        `NOTION_DB_TRANSCRIPTS=${dbIds.transcripts}`,
        `NOTION_DB_HEALTH_METRICS=${dbIds.health_metrics}`,
        `NOTION_DB_WORKOUTS=${dbIds.workouts}`,
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

// API Routes
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/transcripts', transcriptRoutes);
app.use('/api/healthdata', healthRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/bee', beeRoutes);
app.use('/api/search', searchRoutes);

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

// ─── Cron: scheduled auto-sync ───────────────────────────────────
// Runs Bee sync on a configurable interval (default 30 min)

const BEE_TOKEN = process.env.BEE_API_TOKEN;
const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL || process.env.BEE_SYNC_INTERVAL || 30) * 60 * 1000;

if (BEE_TOKEN) {
  const http = require('http');

  async function runScheduledSync() {
    console.log('[cron] Starting scheduled sync...');
    const startTime = Date.now();

    // Bee incremental sync
    try {
      const payload = JSON.stringify({ bee_token: BEE_TOKEN });
      const result = await httpPost(`http://127.0.0.1:${PORT}/api/bee/sync-incremental`, payload);
      const i = result.imported || {};
      console.log(`[cron] Bee: ${i.facts || 0}F ${i.todos || 0}T ${i.conversations || 0}C (${result.changes_processed || 0} changes, ${Date.now() - startTime}ms)`);
      if (i.errors?.length) console.log(`[cron] Errors: ${i.errors.join(', ')}`);
    } catch (e) {
      console.error(`[cron] Bee sync failed: ${e.message}`);
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
