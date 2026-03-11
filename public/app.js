// --- AB Brain — Dashboard + Sync Status ---

const API = '/api';

// --- Auth ---
function getStoredKey() {
  return sessionStorage.getItem('ab_api_key') || localStorage.getItem('ab_api_key') || '';
}

function showLogin(message) {
  document.getElementById('login-screen').style.display = 'flex';
  document.querySelector('.app-header').style.display = 'none';
  document.querySelector('.page-content').style.display = 'none';
  if (message) {
    document.getElementById('login-error').textContent = message;
    document.getElementById('login-error').style.display = 'block';
  }
}

function hideLogin() {
  document.getElementById('login-screen').style.display = 'none';
  document.querySelector('.app-header').style.display = '';
  document.querySelector('.page-content').style.display = '';
}

async function doLogin(e) {
  if (e) e.preventDefault();
  const key = document.getElementById('login-key').value.trim();
  if (!key) return;

  try {
    const res = await fetch(API + '/dashboard', {
      headers: { 'X-Api-Key': key }
    });
    if (res.status === 401) {
      document.getElementById('login-error').textContent = 'Invalid API key. Try again.';
      document.getElementById('login-error').style.display = 'block';
      return;
    }
    const remember = document.getElementById('login-remember').checked;
    sessionStorage.setItem('ab_api_key', key);
    if (remember) localStorage.setItem('ab_api_key', key);
    hideLogin();
    loadPage();
  } catch (err) {
    document.getElementById('login-error').textContent = 'Connection error. Check your network.';
    document.getElementById('login-error').style.display = 'block';
  }
}

function logout() {
  sessionStorage.removeItem('ab_api_key');
  localStorage.removeItem('ab_api_key');
  showLogin();
}

// --- API helper ---
async function api(path, opts = {}) {
  const key = getStoredKey();
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (key) headers['X-Api-Key'] = key;

  let res;
  try {
    res = await fetch(API + path, { ...opts, headers });
  } catch (e) {
    throw new Error(`Network error: ${e.message} (${path})`);
  }

  if (res.status === 401) {
    showLogin('Session expired. Please log in again.');
    throw new Error('Unauthorized');
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${body.error || JSON.stringify(body)}`);
  }

  return body;
}

// --- Page Load ---
async function loadPage() {
  checkDbStatus();
  loadDashboard();
}

// --- Database Status ---
async function checkDbStatus() {
  try {
    const data = await api('/db-status');
    const warning = document.getElementById('db-warning');
    if (data.missing.length > 0) {
      warning.style.display = '';
      document.getElementById('db-missing-list').innerHTML =
        `<p>These databases are not configured:</p>` +
        data.missing.map(n => `<div style="color:var(--red);padding:2px 0">• ${n}</div>`).join('') +
        `<p style="margin-top:8px;color:var(--text-dim)">Enter your Notion page ID to create them.</p>`;
      document.getElementById('db-setup-form').style.display = '';
    } else {
      warning.style.display = 'none';
    }
  } catch {}
}

async function createMissingDbs() {
  const pageId = document.getElementById('db-parent-id').value.trim();
  const resultEl = document.getElementById('db-setup-result');
  const btn = document.getElementById('btn-setup-missing');

  if (!pageId) {
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = 'Please enter a Notion page ID';
    return;
  }

  btn.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';
  resultEl.textContent = 'Creating databases...';

  try {
    const data = await api('/setup-missing', {
      method: 'POST',
      body: JSON.stringify({ parent_page_id: pageId }),
    });
    resultEl.style.color = 'var(--green)';
    let msg = data.message;
    if (data.env_vars?.length) {
      msg += '\n\nAdd to your environment:\n' + data.env_vars.join('\n');
    }
    resultEl.textContent = msg;
  } catch (err) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = `Setup failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadDashboard() {
  try {
    const data = await api('/dashboard');

    const totalTasks = Object.values(data.tasks.by_status).reduce((a, b) => a + b, 0);
    const factsTotal = data.facts?.total || 0;

    document.getElementById('stats-grid').innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${data.knowledge.total}</div>
        <div class="stat-label">Knowledge</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${factsTotal}</div>
        <div class="stat-label">Facts</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.transcripts.total}</div>
        <div class="stat-label">Conversations</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalTasks}</div>
        <div class="stat-label">Tasks</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.projects.active}</div>
        <div class="stat-label">Projects</div>
      </div>
    `;

    // Recent activity
    if (data.recent_activity && data.recent_activity.length) {
      document.getElementById('activity-card').style.display = '';
      document.getElementById('recent-activity').innerHTML =
        data.recent_activity.map(renderActivityItem).join('');
    }

    loadSyncStatus();
    loadBeeStatus();
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      document.getElementById('stats-grid').innerHTML = '<div class="empty-state">Could not load dashboard</div>';
    }
  }
}

// --- Sync Status ---
async function loadSyncStatus() {
  try {
    const data = await api('/sync-status');
    renderSyncSources(data.sources);
    renderSyncJobs(data.recent_jobs);
  } catch (e) {
    document.getElementById('sync-status-panel').innerHTML = '';
  }
}

function renderSyncSources(sources) {
  if (!sources || !sources.length) {
    document.getElementById('sync-status-panel').innerHTML = '';
    return;
  }

  const stateColors = { idle: 'var(--green)', syncing: 'var(--blue)', error: 'var(--red)' };
  const stateLabels = { idle: 'Idle', syncing: 'Syncing...', error: 'Error' };

  document.getElementById('sync-status-panel').innerHTML = sources.map(s => {
    const color = stateColors[s.state] || '#8b8fa3';
    const label = stateLabels[s.state] || s.state;
    const lastSync = s.last_sync ? timeAgo(s.last_sync) : 'Never';

    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;${s.state === 'syncing' ? 'animation:pulse 1.5s infinite' : ''}"></span>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.85rem;font-weight:600">${esc(s.label)}</div>
          <div style="font-size:0.7rem;color:var(--text-dim)">${label} &middot; Last: ${lastSync}${s.items_imported > 0 ? ` &middot; ${s.items_imported} imported` : ''}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderSyncJobs(jobs) {
  if (!jobs || !jobs.length) {
    document.getElementById('sync-job-history').innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">No jobs yet</div>';
    return;
  }

  document.getElementById('sync-job-history').innerHTML = jobs.slice(0, 8).map(j => {
    const icon = j.state === 'completed' ? '\u2705' : j.state === 'failed' ? '\u274C' : '\u23F3';
    const dur = j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '';

    return `
      <div style="display:flex;align-items:flex-start;gap:6px;padding:6px 0;border-bottom:1px solid var(--border);font-size:0.75rem">
        <span>${icon}</span>
        <div style="flex:1">
          <div>${esc(j.description)}</div>
          <div style="color:var(--text-dim)">${timeAgo(j.started_at)}${dur ? ` &middot; ${dur}` : ''}${j.items_imported > 0 ? ` &middot; ${j.items_imported} imported` : ''}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderActivityItem(log) {
  const icons = { create: '+', update: '~', delete: 'x' };
  const cls = `a-${log.action}`;
  return `
    <div class="activity-item">
      <div class="a-icon ${cls}">${icons[log.action] || '?'}</div>
      <div class="a-details">
        <div class="a-text">${esc(log.details || log.action)}</div>
        <div class="a-time">${log.ai_source ? log.ai_source + ' &middot; ' : ''}${timeAgo(log.created_at)}</div>
      </div>
    </div>
  `;
}

// --- Bee Sync ---
let syncPollTimer = null;

async function triggerBeeSync(mode) {
  const btnUpdates = document.getElementById('btn-sync-updates');
  const btnFull = document.getElementById('btn-sync-full');
  const resultEl = document.getElementById('bee-sync-result');

  btnUpdates.disabled = true;
  btnFull.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';
  resultEl.textContent = mode === 'full' ? 'Starting full sync...' : 'Syncing updates...';

  const endpoint = mode === 'full' ? '/bee/sync' : '/bee/sync-incremental';
  const body = mode === 'full' ? { force: false } : {};

  // Fire the request — don't await for full sync (iOS kills long requests)
  const fetchPromise = api(endpoint, { method: 'POST', body: JSON.stringify(body) });

  if (mode === 'full') {
    // Fire-and-forget: poll sync status instead of waiting
    resultEl.textContent = 'Full sync started. Polling for progress...';
    fetchPromise.then(data => {
      showSyncResult(resultEl, data);
      btnUpdates.disabled = false;
      btnFull.disabled = false;
      stopSyncPolling();
      loadDashboard();
    }).catch(() => {
      // Timeout is expected for full sync — poll will pick up results
    });
    startSyncPolling(resultEl, btnUpdates, btnFull);
  } else {
    // Incremental is fast — await normally
    try {
      const data = await fetchPromise;
      showSyncResult(resultEl, data);
      loadDashboard();
    } catch (err) {
      resultEl.style.color = 'var(--red)';
      resultEl.textContent = `Sync failed: ${err.message}`;
    } finally {
      btnUpdates.disabled = false;
      btnFull.disabled = false;
    }
  }
}

function showSyncResult(resultEl, data) {
  const i = data.imported || {};
  const parts = [];
  if (i.facts) parts.push(`${i.facts} facts`);
  if (i.todos) parts.push(`${i.todos} tasks`);
  if (i.conversations) parts.push(`${i.conversations} conversations`);
  if (i.journals) parts.push(`${i.journals} journals`);
  if (i.daily) parts.push(`${i.daily} daily summaries`);
  const errors = i.errors || [];

  let msg = parts.length > 0 ? `Imported: ${parts.join(', ')}` : 'No new items';
  if (i.skipped > 0) msg += ` (${i.skipped} skipped)`;
  if (errors.length > 0) msg += `\nErrors: ${errors.join('; ')}`;

  resultEl.style.color = errors.length > 0 ? 'var(--yellow)' : 'var(--green)';
  resultEl.textContent = msg;
}

function startSyncPolling(resultEl, btnUpdates, btnFull) {
  stopSyncPolling();
  let polls = 0;
  syncPollTimer = setInterval(async () => {
    polls++;
    try {
      const data = await api('/sync-status');
      const bee = data.sources?.find(s => s.label === 'Bee Wearable');
      if (bee) {
        if (bee.state === 'syncing') {
          resultEl.textContent = `Syncing... (${polls * 5}s elapsed)`;
          loadSyncStatus();
        } else {
          // Sync finished
          stopSyncPolling();
          btnUpdates.disabled = false;
          btnFull.disabled = false;
          const lastJob = data.recent_jobs?.[0];
          if (lastJob) {
            const dur = lastJob.duration_ms ? `${(lastJob.duration_ms / 1000).toFixed(1)}s` : '';
            resultEl.style.color = lastJob.state === 'completed' ? 'var(--green)' : 'var(--red)';
            resultEl.textContent = `${lastJob.description}: ${lastJob.state}${dur ? ` (${dur})` : ''}${lastJob.items_imported > 0 ? ` — ${lastJob.items_imported} imported` : ''}`;
          }
          loadDashboard();
        }
      }
    } catch {}
    // Stop after 5 minutes
    if (polls > 60) {
      stopSyncPolling();
      btnUpdates.disabled = false;
      btnFull.disabled = false;
      resultEl.style.color = 'var(--yellow)';
      resultEl.textContent = 'Sync may still be running. Refresh to check.';
    }
  }, 5000);
}

function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

async function loadBeeStatus() {
  try {
    const data = await api('/bee/status');
    const el = document.getElementById('bee-sync-status');
    const parts = [];
    if (data.facts > 0) parts.push(`${data.facts} facts`);
    if (data.tasks > 0) parts.push(`${data.tasks} tasks`);
    if (data.transcripts > 0) parts.push(`${data.transcripts} transcripts`);
    if (data.journals > 0) parts.push(`${data.journals} journals`);
    if (data.daily > 0) parts.push(`${data.daily} daily summaries`);
    el.textContent = parts.length > 0 ? `Synced: ${parts.join(', ')}` : 'No Bee data synced yet';
    if (!data.bee_token_configured) {
      el.textContent += ' (BEE_API_TOKEN not set)';
    }
  } catch {}
}

// --- Notion Cleanup ---
async function runCleanup() {
  const btn = document.getElementById('btn-cleanup');
  const resultEl = document.getElementById('cleanup-result');
  btn.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';
  resultEl.textContent = 'Cleaning up...';

  try {
    const data = await api('/cleanup', { method: 'POST' });
    resultEl.style.color = 'var(--green)';
    let msg = data.message;
    if (data.archived?.length) {
      msg += '\n' + data.archived.map(a => `Archived: ${a.name}`).join('\n');
    }
    if (data.not_found?.length) {
      msg += '\nAlready clean: ' + data.not_found.join(', ');
    }
    resultEl.textContent = msg;
  } catch (err) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = `Cleanup failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// --- Purge Data ---
function confirmPurge() {
  const confirmed = confirm(
    'This will DELETE ALL entries from Knowledge, Facts, Tasks, Projects, and Transcripts in Notion.\n\n' +
    'This cannot be undone. Are you sure?'
  );
  if (!confirmed) return;

  const doubleConfirm = confirm('Really clear everything? Type OK to confirm.');
  if (!doubleConfirm) return;

  runPurge();
}

async function runPurge() {
  const btn = document.getElementById('btn-purge');
  const resultEl = document.getElementById('purge-result');
  btn.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';
  resultEl.textContent = 'Starting purge...';

  try {
    await api('/purge', { method: 'POST', body: JSON.stringify({}) });
    // Poll for completion
    const poll = async () => {
      const status = await api('/purge/status');
      if (status.status === 'running') {
        const p = status.progress || {};
        resultEl.textContent = `Purging ${p.currentDb || '...'}  (${p.current || 0} archived so far)`;
        setTimeout(poll, 1500);
      } else if (status.status === 'done') {
        if (status.error) {
          resultEl.style.color = 'var(--red)';
          resultEl.textContent = `Purge error: ${status.error}`;
        } else {
          resultEl.style.color = 'var(--green)';
          const details = Object.entries(status.results || {})
            .map(([db, count]) => `${db}: ${count}`)
            .join(', ');
          resultEl.textContent = `${status.message}\n${details}`;
        }
        btn.disabled = false;
        loadDashboard();
      } else {
        resultEl.style.color = 'var(--green)';
        resultEl.textContent = 'Purge complete.';
        btn.disabled = false;
        loadDashboard();
      }
    };
    setTimeout(poll, 1500);
  } catch (err) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = `Purge failed: ${err.message}`;
    btn.disabled = false;
  }
}

// --- Global Search ---
let searchDebounceTimer = null;

function openGlobalSearch() {
  document.getElementById('search-overlay').classList.add('open');
  const input = document.getElementById('global-search-input');
  input.value = '';
  input.focus();
  document.getElementById('search-results').innerHTML = '';
}

function closeGlobalSearch() {
  document.getElementById('search-overlay').classList.remove('open');
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openGlobalSearch(); }
  if (e.key === 'Escape' && document.getElementById('search-overlay').classList.contains('open')) closeGlobalSearch();
});

document.getElementById('global-search-input').addEventListener('input', e => {
  clearTimeout(searchDebounceTimer);
  const q = e.target.value.trim();
  if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
  if (q.length < 2) return;
  searchDebounceTimer = setTimeout(() => runGlobalSearch(q), 300);
});

document.getElementById('global-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchDebounceTimer); const q = e.target.value.trim(); if (q) runGlobalSearch(q); }
});

async function runGlobalSearch(q) {
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '<div class="search-loading">Searching...</div>';

  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}`);
    const r = data.results;

    if (data.total === 0) { resultsEl.innerHTML = '<div class="search-empty">No results found</div>'; return; }

    let html = '';

    if (r.knowledge?.length) {
      html += renderSearchGroup('Knowledge', r.knowledge, item =>
        `<div class="search-result-item">
          <div class="search-result-title">${item.ai_source ? `<span class="k-source-badge source-${item.ai_source}">${item.ai_source}</span>` : ''}${esc(item.title)}</div>
          <div class="search-result-preview">${esc((item.content || '').substring(0, 200))}</div>
          <div class="search-result-meta"><span>${item.category || ''}</span><span>${timeAgo(item.updated_at)}</span></div>
        </div>`);
    }
    if (r.facts?.length) {
      html += renderSearchGroup('Facts', r.facts, item =>
        `<div class="search-result-item">
          <div class="search-result-title">${esc(item.title)}</div>
          <div class="search-result-preview">${esc((item.content || '').substring(0, 200))}</div>
          <div class="search-result-meta"><span>${item.category || ''}</span><span>${item.confirmed ? 'confirmed' : ''}</span></div>
        </div>`);
    }
    if (r.transcripts?.length) {
      html += renderSearchGroup('Conversations', r.transcripts, item =>
        `<div class="search-result-item">
          <div class="search-result-title">${esc(item.title)}</div>
          <div class="search-result-preview">${esc((item.summary || item.preview || '').substring(0, 200))}</div>
          <div class="search-result-meta"><span>${item.source || ''}</span><span>${timeAgo(item.recorded_at)}</span></div>
        </div>`);
    }
    if (r.tasks?.length) {
      html += renderSearchGroup('Tasks', r.tasks, item =>
        `<div class="search-result-item">
          <div class="search-result-title">${esc(item.title)}</div>
          <div class="search-result-meta"><span>${item.priority || ''}</span><span>${(item.status || '').replace('_', ' ')}</span></div>
        </div>`);
    }
    if (r.projects?.length) {
      html += renderSearchGroup('Projects', r.projects, item =>
        `<div class="search-result-item">
          <div class="search-result-title">${esc(item.title || item.name)}</div>
          <div class="search-result-meta"><span>${item.status || ''}</span></div>
        </div>`);
    }

    resultsEl.innerHTML = html || '<div class="search-empty">No results</div>';
  } catch (err) {
    resultsEl.innerHTML = `<div class="search-empty">Search failed: ${esc(err.message)}</div>`;
  }
}

function renderSearchGroup(label, items, renderItem) {
  return `<div class="search-group-label">${label} (${items.length})</div>` + items.map(renderItem).join('');
}

// --- Modal (for future use) ---
function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// --- Utilities ---
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const diff = (new Date() - date) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  return date.toLocaleDateString();
}

// --- Init ---
(async function init() {
  const key = getStoredKey();
  if (!key) { showLogin(); return; }
  try {
    const test = await fetch(API + '/dashboard', { headers: { 'X-Api-Key': key } });
    if (test.status === 401) {
      sessionStorage.removeItem('ab_api_key');
      localStorage.removeItem('ab_api_key');
      showLogin('API key expired. Please log in again.');
      return;
    }
  } catch (e) {}
  hideLogin();
  loadPage();
})();
