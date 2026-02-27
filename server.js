const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { initDB } = require('./db');

const knowledgeRoutes = require('./routes/knowledge');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const transcriptRoutes = require('./routes/transcripts');
const healthRoutes = require('./routes/health');
const activityRoutes = require('./routes/activity');
const dashboardRoutes = require('./routes/dashboard');
const beeRoutes = require('./routes/bee');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check — BEFORE auth middleware so Railway can reach it
app.get('/api/health-check', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// OpenAPI spec — no auth required (ChatGPT needs to fetch it during setup)
app.get('/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'openapi-chatgpt.json'));
});

// ChatGPT privacy policy placeholder
app.get('/privacy', (req, res) => {
  res.type('text/html').send(`<!DOCTYPE html><html><head><title>AB Brain - Privacy</title></head><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
    <h1>AB Brain - Privacy Policy</h1>
    <p>AB Brain is a personal knowledge base. All data is stored privately and only accessible via authenticated API calls. No data is shared with third parties. This API is for personal use by the account owner only.</p>
    <p>Last updated: 2025</p></body></html>`);
});

// API key authentication for /api routes
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
});

// API Routes — health data routes mounted at /api/healthdata to avoid conflict
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/transcripts', transcriptRoutes);
app.use('/api/healthdata', healthRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/bee', beeRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server, then init DB (so healthcheck responds while DB sets up)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AB Knowledge Base running on port ${PORT}`);
});

// Initialize database after server is listening
initDB().then(() => {
  console.log('Database ready');

  // --- Scheduled Bee Cloud Sync ---
  const BEE_TOKEN = process.env.BEE_API_TOKEN;
  const BEE_SYNC_INTERVAL = Number(process.env.BEE_SYNC_INTERVAL || 30) * 60 * 1000;

  if (BEE_TOKEN) {
    const https = require('https');

    async function runBeeSync() {
      console.log('[bee-auto-sync] Starting incremental sync...');
      try {
        const payload = JSON.stringify({ bee_token: BEE_TOKEN });
        const url = new URL('/api/bee/sync-incremental', `http://127.0.0.1:${PORT}`);
        const http = require('http');

        const result = await new Promise((resolve, reject) => {
          const req = http.request(url, {
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

        const i = result.imported || {};
        console.log(`[bee-auto-sync] Done: ${i.facts || 0} facts, ${i.todos || 0} todos, ${i.conversations || 0} conversations (${result.changes_processed || 0} changes processed)`);
        if (i.errors?.length) console.log(`[bee-auto-sync] Errors: ${i.errors.join(', ')}`);
      } catch (e) {
        console.error(`[bee-auto-sync] Failed: ${e.message}`);
      }
    }

    // Initial sync 10 seconds after startup
    setTimeout(runBeeSync, 10000);
    // Then every N minutes
    setInterval(runBeeSync, BEE_SYNC_INTERVAL);
    console.log(`[bee-auto-sync] Scheduled every ${BEE_SYNC_INTERVAL / 60000} minutes (BEE_API_TOKEN configured)`);
  } else {
    console.log('[bee-auto-sync] Skipped — no BEE_API_TOKEN env var set');
  }
}).catch(err => {
  console.error('Database init failed:', err.message);
  console.error('Server is running but database is not available.');
  console.error('Make sure DATABASE_URL is set and Postgres is accessible.');
});
