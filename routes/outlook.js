// Outlook sync — polls Microsoft Graph API for flagged emails, creates tasks.
// Uses OAuth2 refresh token flow (delegated permissions).
// Required env vars: MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN

const express = require('express');
const https = require('https');
const { query, logActivity } = require('../db');
const syncStatus = require('../sync-status');
const router = express.Router();

// ── Token Management ──

let cachedToken = null;
let tokenExpiry = 0;

function getConfig() {
  const clientId = process.env.MS_CLIENT_ID;
  const tenantId = process.env.MS_TENANT_ID || 'common';
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const refreshToken = process.env.MS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, tenantId, clientSecret, refreshToken };
}

async function getAccessToken() {
  const config = getConfig();
  if (!config) throw new Error('Microsoft Graph not configured — set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN');

  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && Date.now() < tokenExpiry - 300000) return cachedToken;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access',
  }).toString();

  const result = await httpsRequest({
    hostname: 'login.microsoftonline.com',
    path: `/${config.tenantId}/oauth2/v2.0/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);

  if (result.error) throw new Error(`Token refresh failed: ${result.error_description || result.error}`);

  cachedToken = result.access_token;
  tokenExpiry = Date.now() + (result.expires_in * 1000);
  return cachedToken;
}

// ── Graph API Helpers ──

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Non-JSON response: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function graphGet(path) {
  const token = await getAccessToken();
  return httpsRequest({
    hostname: 'graph.microsoft.com',
    path,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
}

// ── Sync Logic ──

async function syncFlaggedEmails() {
  // Get flagged emails from Outlook
  const flaggedResponse = await graphGet(
    `/v1.0/me/messages?$filter=flag/flagStatus eq 'flagged'&$select=id,subject,bodyPreview,from,internetMessageId,receivedDateTime,importance&$top=50&$orderby=receivedDateTime desc`
  );

  if (flaggedResponse.error) {
    throw new Error(`Graph API error: ${flaggedResponse.error.message || JSON.stringify(flaggedResponse.error)}`);
  }

  const emails = flaggedResponse.value || [];
  const results = { created: 0, skipped: 0, completed: 0, errors: [] };

  // Get all existing outlook source_ids to avoid re-processing
  const existingResult = await query(
    `SELECT source_id, status FROM tasks WHERE source_id IS NOT NULL AND ai_agent = 'outlook'`
  );
  const existingMap = new Map(existingResult.rows.map(r => [r.source_id, r.status]));

  // Track which source_ids are currently flagged
  const currentlyFlagged = new Set();

  for (const email of emails) {
    const messageId = email.internetMessageId || email.id;
    currentlyFlagged.add(messageId);

    // Skip if task already exists
    if (existingMap.has(messageId)) {
      results.skipped++;
      continue;
    }

    try {
      // Call the existing email intake endpoint logic directly
      const subject = email.subject || '(no subject)';
      const bodyPreview = (email.bodyPreview || '').substring(0, 3000);
      const sender = email.from?.emailAddress?.name || 'Unknown';
      const senderEmail = email.from?.emailAddress?.address || '';
      const importance = email.importance || 'normal';

      // Build classification message
      const userMessage = [
        '[Source: outlook-email]',
        `From: ${sender} <${senderEmail}>`,
        `Subject: ${subject}`,
        importance !== 'normal' ? `Importance: ${importance}` : '',
        `Received: ${email.receivedDateTime || ''}`,
        '',
        bodyPreview
      ].filter(Boolean).join('\n');

      // Use intake classify function for AI-powered title + priority extraction
      const intakeRouter = require('./intake');
      let classification;
      try {
        classification = await intakeRouter.classify(userMessage);
      } catch {
        // Fallback if OpenAI unavailable — use email subject directly
        classification = { title: subject.substring(0, 80), priority: 'medium' };
      }

      let priority = classification.priority || 'medium';
      if (importance === 'high' && (priority === 'medium' || priority === 'low')) {
        priority = 'high';
      }

      const result = await query(
        `INSERT INTO tasks (title, description, status, priority, ai_agent, context, source_id)
         VALUES ($1, $2, 'todo', $3, 'outlook', 'work', $4) RETURNING id`,
        [
          classification.title || subject.substring(0, 80),
          `From: ${sender} <${senderEmail}>\n\n${bodyPreview}`,
          priority,
          messageId
        ]
      );

      await logActivity('create', 'task', result.rows[0].id, 'outlook', `Outlook sync: ${classification.title || subject}`);
      results.created++;
    } catch (err) {
      results.errors.push(`${email.subject}: ${err.message}`);
    }
  }

  // Check for unflagged emails — mark tasks as done if their email is no longer flagged
  const activeOutlookTasks = await query(
    `SELECT id, title, source_id FROM tasks WHERE ai_agent = 'outlook' AND source_id IS NOT NULL AND status != 'done'`
  );

  for (const task of activeOutlookTasks.rows) {
    if (!currentlyFlagged.has(task.source_id)) {
      // Email no longer flagged — check if it was completed or unflagged
      await query(`UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1`, [task.id]);
      await logActivity('update', 'task', task.id, 'outlook', `Completed (flag removed): ${task.title}`);
      results.completed++;
    }
  }

  return results;
}

// ── Routes ──

// Manual sync trigger
router.post('/sync', async (req, res) => {
  try {
    const results = await syncFlaggedEmails();
    res.json({
      message: 'Outlook sync complete',
      created: results.created,
      skipped: results.skipped,
      completed: results.completed,
      errors: results.errors.length,
      error_details: results.errors
    });
  } catch (err) {
    console.error('[outlook] Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Status check
router.get('/status', async (req, res) => {
  const config = getConfig();
  if (!config) return res.json({ configured: false, message: 'Set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN' });

  try {
    // Test token + API access
    const me = await graphGet('/v1.0/me?$select=displayName,mail');
    if (me.error) throw new Error(me.error.message);

    const taskCount = await query(`SELECT COUNT(*) as count FROM tasks WHERE ai_agent = 'outlook'`);

    res.json({
      configured: true,
      connected_as: me.displayName,
      email: me.mail,
      outlook_tasks: parseInt(taskCount.rows[0].count),
    });
  } catch (err) {
    res.json({ configured: true, error: err.message });
  }
});

// Export sync function for cron use
router.syncFlaggedEmails = syncFlaggedEmails;

module.exports = router;
