const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { initDB, query } = require('./db');
const syncStatus = require('./sync-status');

const knowledgeRoutes = require('./routes/knowledge');
const taskRoutes = require('./routes/tasks');
const transcriptRoutes = require('./routes/transcripts');
const conversationRoutes = require('./routes/conversations');
const activityRoutes = require('./routes/activity');
const dashboardRoutes = require('./routes/dashboard');
const beeRoutes = require('./routes/bee');
const searchRoutes = require('./routes/search');
const intakeRoutes = require('./routes/intake');
const workoutRoutes = require('./routes/workouts');
const bodyMetricsRoutes = require('./routes/body-metrics');
const mealsRoutes = require('./routes/meals');
const nutritionRoutes = require('./routes/nutrition');
const trainingRoutes = require('./routes/training');
const gamificationRoutes = require('./routes/gamification');
const recoveryRoutes = require('./routes/recovery');
const dailyPlanRoutes = require('./routes/daily-plans');
const exerciseRoutes = require('./routes/exercises');
const gymProfileRoutes = require('./routes/gym-profiles');
const briefingRoutes = require('./routes/briefing');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Timezone-aware "today" helper — uses client's X-Timezone header
app.use((req, res, next) => {
  const tz = req.headers['x-timezone'];
  req.getToday = () => {
    try {
      if (tz) {
        return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // en-CA = YYYY-MM-DD
      }
    } catch (e) { /* invalid tz, fall through */ }
    return new Date().toISOString().slice(0, 10);
  };
  req.getNow = () => {
    try {
      if (tz) {
        const d = new Date();
        return d.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T') + '.000Z';
      }
    } catch (e) { /* invalid tz, fall through */ }
    return new Date().toISOString();
  };
  next();
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check — BEFORE auth middleware
const APP_VERSION = require('./package.json').version;

app.get('/api/health-check', (req, res) => {
  res.json({ status: 'ok', version: APP_VERSION, backend: 'postgresql', timestamp: new Date().toISOString() });
});

// OpenAPI spec — no auth
app.get('/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'openapi-chatgpt.json'));
});

// Claude schema — no auth
app.get('/claude-schema.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'claude-schema.json'));
});
app.get('/claude-schema.yaml', (req, res) => {
  res.type('text/yaml').sendFile(path.join(__dirname, 'public', 'claude-schema.yaml'));
});

// Privacy policy
app.get('/privacy', (req, res) => {
  res.type('text/html').send(`<!DOCTYPE html><html><head><title>AB Brain - Privacy</title></head><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
    <h1>AB Brain - Privacy Policy</h1>
    <p>AB Brain is a personal knowledge base backed by PostgreSQL. All data is stored in your own database and only accessible via authenticated API calls. No data is shared with third parties.</p>
    <p>Last updated: 2026</p></body></html>`);
});

// API key authentication for /api routes
app.use('/api', (req, res, next) => {
  if (req.path === '/health-check') return next();
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== API_KEY) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
});

// ─── Purge: clear all data from PostgreSQL tables ──────────────────
const purgeState = { running: false, progress: null, result: null };

app.post('/api/purge', async (req, res) => {
  if (purgeState.running) return res.json({ status: 'running', progress: purgeState.progress });
  try {
    const allowed = ['knowledge', 'tasks', 'transcripts', 'conversations', 'workouts', 'body_metrics', 'meals', 'daily_context', 'coaching_sessions', 'injuries', 'daily_plans', 'exercises', 'gym_profiles'];
    const requested = req.body.databases || allowed;
    const targets = requested.filter(d => allowed.includes(d));
    if (!targets.length) return res.status(400).json({ error: 'No valid tables specified', allowed });

    purgeState.running = true;
    purgeState.progress = { current: 0, databases: targets };
    purgeState.result = null;
    res.json({ status: 'started', databases: targets });

    let totalDeleted = 0;
    const results = {};
    for (const table of targets) {
      try {
        const r = await query(`DELETE FROM ${table}`);
        results[table] = r.rowCount || 0;
        totalDeleted += r.rowCount || 0;
        purgeState.progress.current += r.rowCount || 0;
      } catch (e) { results[table] = `error: ${e.message}`; }
    }

    purgeState.result = { message: `Purged ${totalDeleted} entries`, results };
    purgeState.running = false;
  } catch (err) {
    purgeState.result = { error: err.message };
    purgeState.running = false;
  }
});

app.get('/api/purge/status', (req, res) => {
  if (purgeState.running) return res.json({ status: 'running', progress: purgeState.progress });
  if (purgeState.result) { const r = purgeState.result; purgeState.result = null; return res.json({ status: 'done', ...r }); }
  res.json({ status: 'idle' });
});

// API Routes
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/transcripts', transcriptRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/bee', beeRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/intake', intakeRoutes);
app.use('/api/workouts', workoutRoutes);
app.use('/api/body-metrics', bodyMetricsRoutes);
app.use('/api/meals', mealsRoutes);
app.use('/api/nutrition', nutritionRoutes);
app.use('/api/daily-context', nutritionRoutes); // alias: /api/daily-context → nutrition router (daily-context endpoints)
app.use('/api/training', trainingRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/recovery', recoveryRoutes);
app.use('/api/daily-plans', dailyPlanRoutes);
app.use('/api/exercises', exerciseRoutes);
app.use('/api/gym-profiles', gymProfileRoutes);
app.use('/api/briefing', briefingRoutes);

// Sync status
app.get('/api/sync-status', (req, res) => res.json(syncStatus.getStatus()));

app.post('/api/sync-status/import-complete', (req, res) => {
  const { source, imported, skipped, failed, total } = req.body;
  const srcName = source || 'unknown';
  syncStatus.initSource(srcName, { label: `${srcName.charAt(0).toUpperCase() + srcName.slice(1)} Import` });
  const job = syncStatus.startJob(srcName, `File import: ${total || 0} conversations`);
  syncStatus.completeJob(srcName, job, {
    imported: imported || 0, skipped: (skipped || 0) + (failed || 0),
    errors: failed > 0 ? [`${failed} conversations failed to import`] : [],
    details: { total, imported, skipped, failed },
  });
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start server ────────────────────────────────────────────────

async function start() {
  try {
    await initDB();
    console.log('PostgreSQL initialized');
  } catch (err) {
    console.error(`PostgreSQL init failed: ${err.message}`);
    console.error('Ensure DATABASE_URL is set correctly');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AB Brain (PostgreSQL backend) running on port ${PORT}`);
  });

  // ─── VAPID key generation (one-time) ──────────────────────────
  try {
    const webpush = require('web-push');
    const { rows: [gs] } = await query(`SELECT vapid_public_key, vapid_private_key FROM gamification_settings WHERE id = 1`);
    if (gs && !gs.vapid_public_key) {
      const vapidKeys = webpush.generateVAPIDKeys();
      await query(`UPDATE gamification_settings SET vapid_public_key = $1, vapid_private_key = $2 WHERE id = 1`, [vapidKeys.publicKey, vapidKeys.privateKey]);
      console.log('[push] VAPID keys generated');
    } else if (gs?.vapid_public_key) {
      console.log('[push] VAPID keys already configured');
    }
  } catch (err) {
    console.error(`[push] VAPID setup failed: ${err.message}`);
  }

  // ─── Notification scheduler (checks every minute) ─────────────
  const notifState = { lastSent: {} };

  async function checkNotifications() {
    try {
      const webpush = require('web-push');
      const { rows: [settings] } = await query(`SELECT * FROM gamification_settings WHERE id = 1`);
      if (!settings?.notification_enabled || !settings.push_subscription || !settings.vapid_public_key) return;

      const schedule = settings.notification_schedule || [];
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = now.toISOString().slice(0, 10);

      for (const slot of schedule) {
        const sentKey = `${today}-${slot.type}`;
        if (notifState.lastSent[sentKey]) continue;
        if (currentTime < slot.time) continue;
        // Check within 2-minute window
        const [slotH, slotM] = slot.time.split(':').map(Number);
        const slotMins = slotH * 60 + slotM;
        const nowMins = now.getHours() * 60 + now.getMinutes();
        if (nowMins - slotMins > 2) continue;

        // Build contextual message
        let title = 'AB Brain';
        let body = '';
        try {
          const [trainR, execR, mealsR, ctxR, tasksR] = await Promise.all([
            query(`SELECT COUNT(*)::int AS n FROM workouts WHERE workout_date = CURRENT_DATE`),
            query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'done' AND updated_at::date = CURRENT_DATE`),
            query(`SELECT COUNT(*)::int AS n FROM meals WHERE meal_date = CURRENT_DATE`),
            query(`SELECT COUNT(*)::int AS n FROM daily_context WHERE date = CURRENT_DATE`),
            query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('todo', 'in_progress') AND (due_date IS NULL OR due_date <= CURRENT_DATE)`),
          ]);
          const train = trainR.rows[0].n;
          const exec = execR.rows[0].n;
          const meals = mealsR.rows[0].n;
          const ctx = ctxR.rows[0].n;
          const pending = tasksR.rows[0].n;

          const tG = settings.ring_train_goal;
          const eG = settings.ring_execute_goal;
          const rG = settings.ring_recover_goal;
          const trainDone = train >= tG;
          const execDone = exec >= eG;
          // Check sleep logged
          const sleepR = await query(`SELECT sleep_hours FROM daily_context WHERE date = CURRENT_DATE`);
          const sleepLogged = sleepR.rows[0]?.sleep_hours != null;
          const recoverDone = ((sleepLogged ? 1 : 0) + (meals >= 2 ? 1 : 0) + (ctx > 0 ? 1 : 0)) >= rG;

          switch (slot.type) {
            case 'morning_briefing':
              title = 'Morning Briefing';
              body = sleepLogged
                ? `${pending} tasks pending. Time to train and execute.`
                : `Log last night's sleep! ${pending} tasks pending.`;
              break;
            case 'pre_lunch':
              title = 'Midday Check';
              body = `Tasks: ${exec}/${eG}.` + (!trainDone ? ' No workout yet.' : ' Train: done!') + (meals === 0 ? ' Log your meals.' : '');
              if (trainDone && execDone && meals > 0) return; // suppress if ahead
              break;
            case 'post_lunch':
              title = 'Post Lunch';
              if (meals < 2) body = 'Log lunch. ';
              body += `Execute: ${exec}/${eG}. Keep pushing.`;
              if (execDone && meals >= 2) return;
              break;
            case 'end_of_work':
              title = 'End of Work';
              body = `${exec} tasks done today.` + (!trainDone ? ' Still need to train.' : '') + ' Review tomorrow\'s priorities.';
              break;
            case 'evening_close':
              title = 'Close Your Rings';
              body = `Train: ${trainDone ? '✓' : '✗'} | Execute: ${exec}/${eG} | Recover: ${meals + ctx}/${rG}`;
              if (!recoverDone) body += '. Log dinner + recovery data.';
              break;
            default:
              body = slot.label || 'Check your progress';
          }
        } catch { body = slot.label || 'Check AB Brain'; }

        webpush.setVapidDetails('mailto:avi@abbrain.app', settings.vapid_public_key, settings.vapid_private_key);
        try {
          await webpush.sendNotification(settings.push_subscription, JSON.stringify({
            title, body,
            icon: '/icons/brand/icon-app-180.png',
            badge: '/icons/brand/icon-app-64.png',
            url: '/',
          }));
          notifState.lastSent[sentKey] = true;
          console.log(`[push] Sent: ${slot.type} at ${currentTime}`);
        } catch (pushErr) {
          if (pushErr.statusCode === 410) {
            // Subscription expired, clean up
            await query(`UPDATE gamification_settings SET push_subscription = NULL WHERE id = 1`);
            console.log('[push] Subscription expired, cleared');
          } else {
            console.error(`[push] Send failed: ${pushErr.message}`);
          }
        }
      }
    } catch (err) {
      // Silently skip if DB not ready
    }

    // ─── Task Reminders ─────────────────────────────────────────
    try {
      const webpush = require('web-push');
      const { rows: [settings] } = await query(`SELECT * FROM gamification_settings WHERE id = 1`);
      if (!settings?.push_subscription || !settings.vapid_public_key) return;

      // Find tasks with reminder_at in the past that haven't been sent yet
      const { rows: dueTasks } = await query(`
        SELECT id, title, priority, due_date FROM tasks
        WHERE reminder_at IS NOT NULL
          AND reminder_at <= NOW()
          AND status NOT IN ('done')
        LIMIT 10
      `);

      if (dueTasks.length) {
        webpush.setVapidDetails('mailto:avi@abbrain.app', settings.vapid_public_key, settings.vapid_private_key);
      }

      for (const task of dueTasks) {
        const sentKey = `reminder-${task.id}`;
        if (notifState.lastSent[sentKey]) continue;

        try {
          const prioLabel = task.priority === 'urgent' ? '🔴 ' : task.priority === 'high' ? '🟠 ' : '';
          await webpush.sendNotification(settings.push_subscription, JSON.stringify({
            title: `${prioLabel}Task Reminder`,
            body: task.title,
            icon: '/icons/brand/icon-app-180.png',
            badge: '/icons/brand/icon-app-64.png',
            url: '/',
          }));
          notifState.lastSent[sentKey] = true;
          // Clear the reminder so it doesn't fire again
          await query('UPDATE tasks SET reminder_at = NULL WHERE id = $1', [task.id]);
          console.log(`[push] Task reminder sent: ${task.title}`);
        } catch (pushErr) {
          if (pushErr.statusCode === 410) {
            await query(`UPDATE gamification_settings SET push_subscription = NULL WHERE id = 1`);
            break;
          }
          console.error(`[push] Task reminder failed: ${pushErr.message}`);
        }
      }
    } catch (err) {
      // Silently skip
    }
  }

  // Check every 60 seconds
  setInterval(checkNotifications, 60000);
  setTimeout(checkNotifications, 5000); // first check 5s after boot
  console.log('[push] Notification scheduler active');

  // ─── Cron: extend recurring task instances (daily) ────────────
  const { extendAllRecurring } = require('./routes/tasks');
  async function runRecurringExtension() {
    try {
      const created = await extendAllRecurring();
      if (created > 0) console.log(`[recurring] Extended ${created} recurring task instances`);
    } catch (err) {
      console.error(`[recurring] Extension failed: ${err.message}`);
    }
  }
  // Run once at boot (after 15s) and then every 6 hours
  setTimeout(runRecurringExtension, 15000);
  setInterval(runRecurringExtension, 6 * 60 * 60 * 1000);
  console.log('[recurring] Recurring task scheduler active (every 6h)');

  // Initialize sync sources
  syncStatus.initSource('bee', { label: 'Bee Wearable', cron_enabled: !!process.env.BEE_API_TOKEN });
  syncStatus.initSource('chatgpt', { label: 'ChatGPT Import' });
  syncStatus.initSource('claude', { label: 'Claude Import' });
  syncStatus.initSource('intake', { label: 'Smart Intake' });

  // ─── Cron: scheduled Bee auto-sync ─────────────────────────────
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
      try {
        const payload = JSON.stringify({ bee_token: BEE_TOKEN });
        const result = await httpPost(`http://127.0.0.1:${PORT}/api/bee/sync-incremental`, payload);
        const i = result.imported || {};
        const imported = (i.facts || 0) + (i.todos || 0) + (i.conversations || 0);
        console.log(`[cron] Bee: ${i.facts||0}F ${i.todos||0}T ${i.conversations||0}C (${result.changes_processed||0} changes, ${Date.now()-startTime}ms)`);
        syncStatus.completeJob('bee', job, { imported, skipped: i.skipped||0, errors: i.errors||[], details: i });
      } catch (e) {
        console.error(`[cron] Bee sync failed: ${e.message}`);
        syncStatus.failJob('bee', job, e.message);
      }
    }

    function httpPost(url, payload) {
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const req = http.request(parsedUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY || '', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }

    setTimeout(runScheduledSync, 10000);
    setInterval(runScheduledSync, SYNC_INTERVAL);
    console.log(`[cron] Scheduled every ${SYNC_INTERVAL/60000} min (BEE_API_TOKEN configured)`);
  } else {
    console.log('[cron] Bee sync disabled (set BEE_API_TOKEN to enable)');
  }

}

start();
