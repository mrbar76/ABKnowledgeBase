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

  const res = await fetch(API + path, { ...opts, headers });

  if (res.status === 401) {
    showLogin('Session expired. Please log in again.');
    throw new Error('Unauthorized');
  }
  return res.json();
}

// --- Page Load ---
async function loadPage() {
  loadDashboard();
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
