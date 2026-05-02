// Dropbox integration: scheduled poller + OAuth refresh-token bootstrap.
//
// Setup is two-phase:
//   1. User sets DROPBOX_APP_KEY + DROPBOX_APP_SECRET env vars.
//   2. User visits /dropbox-auth (top-level, no auth required — the page has
//      no secrets), follows the link to authorize, pastes the resulting code
//      together with their API key, and we mint a refresh token they put back
//      into Railway as DROPBOX_REFRESH_TOKEN. After a redeploy, the poller
//      starts on its own.
//
// The poller is idempotent — re-downloading the same file is a no-op because
// /ingest dedupes by file_hash. After successful ingest we move the file to
// /processed/YYYY-MM/ so the inbox stays clean.

const express = require('express');
const { logActivity } = require('../db');
const { ingestPayload } = require('./health');

const router = express.Router();

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;
const FOLDER_PATH = process.env.DROPBOX_FOLDER_PATH || '';
const POLL_MINUTES = Number(process.env.DROPBOX_POLL_MINUTES || 15);

// Cached short-lived access token (Dropbox short-lived tokens last ~4h)
let accessTokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    throw new Error('Dropbox env vars missing (DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN)');
  }
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt - 60_000) {
    return accessTokenCache.token;
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
  });
  const auth = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
  const r = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!r.ok) throw new Error(`Dropbox token refresh failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  accessTokenCache = {
    token: j.access_token,
    expiresAt: Date.now() + (j.expires_in || 14400) * 1000,
  };
  return accessTokenCache.token;
}

async function dbx(path, body, isDownload = false) {
  const token = await getAccessToken();
  const r = await fetch(`https://${isDownload ? 'content' : 'api'}.dropboxapi.com${path}`, {
    method: 'POST',
    headers: isDownload
      ? { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify(body) }
      : { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: isDownload ? null : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Dropbox ${path} failed: ${r.status} ${await r.text()}`);
  if (isDownload) return r;
  return r.json();
}

async function listJsonFiles() {
  const out = [];
  let cursor = null;
  let resp = await dbx('/2/files/list_folder', {
    path: FOLDER_PATH,
    recursive: false,
    include_non_downloadable_files: false,
  });
  while (true) {
    for (const e of resp.entries || []) {
      if (e['.tag'] === 'file' && /\.json$/i.test(e.name)) out.push(e);
    }
    if (!resp.has_more) break;
    cursor = resp.cursor;
    resp = await dbx('/2/files/list_folder/continue', { cursor });
  }
  return out;
}

async function downloadJson(path) {
  const r = await dbx('/2/files/download', { path }, true);
  return r.json();
}

async function moveToProcessed(file) {
  const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
  const dest = `${FOLDER_PATH}/processed/${ym}/${file.name}`;
  try {
    await dbx('/2/files/create_folder_v2', { path: `${FOLDER_PATH}/processed/${ym}`, autorename: false })
      .catch(() => {}); // ignore "already exists"
    await dbx('/2/files/move_v2', {
      from_path: file.path_lower,
      to_path: dest,
      autorename: true,
    });
  } catch (err) {
    console.error(`[dropbox] move failed for ${file.name}: ${err.message}`);
  }
}

let syncRunning = false;
let lastSync = null;

async function runSync() {
  if (syncRunning) return { skipped: true, reason: 'already running' };
  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    return { skipped: true, reason: 'not configured' };
  }
  syncRunning = true;
  const summary = { found: 0, ingested: 0, duplicates: 0, errors: [], moved: 0 };
  try {
    const files = await listJsonFiles();
    summary.found = files.length;
    for (const f of files) {
      try {
        const payload = await downloadJson(f.path_lower);
        const out = await ingestPayload(payload);
        if (out.ok) {
          if (out.body.duplicate) summary.duplicates++;
          else summary.ingested++;
          await moveToProcessed(f);
          summary.moved++;
        } else {
          summary.errors.push({ file: f.name, error: out.error });
        }
      } catch (err) {
        summary.errors.push({ file: f.name, error: err.message });
      }
    }
    lastSync = { at: new Date().toISOString(), ...summary };
    if (summary.ingested > 0 || summary.errors.length > 0) {
      await logActivity('create', 'dropbox_sync', new Date().toISOString().slice(0, 16), 'dropbox',
        `Dropbox sync: ${summary.ingested} new, ${summary.duplicates} dup, ${summary.errors.length} err`);
    }
    return summary;
  } catch (err) {
    console.error(`[dropbox] sync failed: ${err.stack}`);
    summary.errors.push({ error: err.message });
    return summary;
  } finally {
    syncRunning = false;
  }
}

function startPoller() {
  if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
    console.log('[dropbox] poller disabled — env vars missing');
    return;
  }
  console.log(`[dropbox] poller enabled — folder="${FOLDER_PATH || '(app root)'}" interval=${POLL_MINUTES}min`);
  setTimeout(() => runSync().catch(err => console.error('[dropbox] initial sync failed:', err.message)), 30_000);
  setInterval(() => runSync().catch(err => console.error('[dropbox] sync failed:', err.message)),
    POLL_MINUTES * 60_000);
}

// ─── Routes (auth-gated, mounted under /api/health) ─────────────

router.post('/dropbox-sync', async (req, res) => {
  try {
    const summary = await runSync();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dropbox-status', (req, res) => {
  res.json({
    configured: Boolean(APP_KEY && APP_SECRET && REFRESH_TOKEN),
    has_app_key: Boolean(APP_KEY),
    has_app_secret: Boolean(APP_SECRET),
    has_refresh_token: Boolean(REFRESH_TOKEN),
    folder_path: FOLDER_PATH || '(app root)',
    poll_minutes: POLL_MINUTES,
    sync_running: syncRunning,
    last_sync: lastSync,
  });
});

// POST /api/health/dropbox-auth { code } → exchanges code for refresh token
router.post('/dropbox-auth', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });
    if (!APP_KEY || !APP_SECRET) return res.status(400).json({ error: 'app key/secret env vars missing' });

    const params = new URLSearchParams({
      code: code.trim(),
      grant_type: 'authorization_code',
    });
    const auth = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64');
    const r = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'token exchange failed', dropbox: j });
    res.json({
      ok: true,
      refresh_token: j.refresh_token,
      next: 'Set DROPBOX_REFRESH_TOKEN in Railway to the value above, then redeploy.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public auth-bootstrap page (mounted top-level in server.js, no auth) ──
// The page itself has no secrets — Dropbox app_key is public OAuth identifier.
// User pastes their API key into the form, which submits to the auth-gated
// POST /api/health/dropbox-auth via Authorization: Bearer header.

function renderAuthPage(req, res) {
  if (!APP_KEY || !APP_SECRET) {
    return res.status(400).type('html').send(
      `<h2>Dropbox auth: env vars missing</h2>
       <p>Set <code>DROPBOX_APP_KEY</code> and <code>DROPBOX_APP_SECRET</code> in Railway, redeploy, then reload this page.</p>`
    );
  }
  const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(APP_KEY)}&token_access_type=offline&response_type=code`;
  res.type('html').send(`<!doctype html>
<html><head><title>Dropbox auth setup</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5;color:#222}
code{background:#eee;padding:2px 6px;border-radius:3px}
input{width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:6px;margin:8px 0;box-sizing:border-box}
button{padding:10px 16px;font-size:16px;background:#0061fe;color:#fff;border:0;border-radius:6px;cursor:pointer}
.step{margin:24px 0;padding:16px;border-left:3px solid #0061fe;background:#f4f8ff}
#out{margin-top:16px;padding:12px;background:#f4f4f4;border-radius:6px;word-break:break-all;font-family:monospace;font-size:13px;white-space:pre-wrap}
small{color:#666}
</style></head><body>
<h2>Dropbox refresh token setup</h2>

<div class="step"><b>Step 0.</b> Paste your AB Brain API key (used as Bearer token for the next call).
<input id="apikey" type="password" placeholder="AB Brain API key">
<small>Saved in localStorage on this device only — not transmitted anywhere except this server.</small></div>

<div class="step"><b>Step 1.</b> Click below. Dropbox will ask permission, then show you a code.<br><br>
<a href="${authUrl}" target="_blank"><button>Open Dropbox authorization →</button></a></div>

<div class="step"><b>Step 2.</b> Copy the code Dropbox shows, paste it here:
<input id="code" placeholder="Paste the authorization code">
<button onclick="submitCode()">Get refresh token</button>
<div id="out"></div></div>

<div class="step"><b>Step 3.</b> Copy the <code>refresh_token</code> from the output and add it to Railway env vars as <code>DROPBOX_REFRESH_TOKEN</code>. Redeploy.</div>

<script>
const apikeyEl = document.getElementById('apikey');
apikeyEl.value = localStorage.getItem('ab_brain_api_key') || '';
apikeyEl.addEventListener('change', () => localStorage.setItem('ab_brain_api_key', apikeyEl.value));

async function submitCode() {
  const code = document.getElementById('code').value.trim();
  const apiKey = apikeyEl.value.trim();
  const out = document.getElementById('out');
  if (!apiKey) { out.textContent = 'Paste your API key in Step 0 first.'; return; }
  if (!code) { out.textContent = 'Paste the authorization code from Dropbox.'; return; }
  localStorage.setItem('ab_brain_api_key', apiKey);
  out.textContent = 'Working...';
  try {
    const r = await fetch('/api/health/dropbox-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ code }),
    });
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
  } catch (e) { out.textContent = 'error: ' + e.message; }
}
</script>
</body></html>`);
}

module.exports = router;
module.exports.startPoller = startPoller;
module.exports.runSync = runSync;
module.exports.renderAuthPage = renderAuthPage;
