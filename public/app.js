// --- AB Brain — Simplified Frontend ---
// Control panel for importing data into Notion + search + AI connection setup.
// Notion is the actual UI for browsing knowledge/facts/tasks/transcripts.

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
  loadBeeStatus();
  renderPrompts();
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
      <div class="stat-card">
        <div class="stat-value">${data.health.total_workouts}</div>
        <div class="stat-label">Workouts</div>
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

// --- Collapsible Sections ---
function toggleSection(name) {
  const body = document.getElementById(`section-${name}`);
  const chevron = document.getElementById(`chevron-${name}`);
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
}

// --- Import ---
const dropZone = document.getElementById('drop-zone');
const importFile = document.getElementById('import-file');

dropZone.addEventListener('click', () => importFile.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleImportFiles(e.dataTransfer.files);
});
importFile.addEventListener('change', e => {
  if (e.target.files.length) handleImportFiles(e.target.files);
});

function readFileAsJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try { resolve(JSON.parse(e.target.result)); }
      catch (err) { reject(new Error(`${file.name}: ${err.message}`)); }
    };
    reader.onerror = () => reject(new Error(`${file.name}: failed to read`));
    reader.readAsText(file);
  });
}

async function handleImportFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.name.endsWith('.json'));
  if (!files.length) { updateImportLog('No .json files selected', true); return; }

  const source = document.getElementById('import-source').value;
  updateImportLog(`Loading ${files.length} file(s)...`);

  let allConversations = [];
  for (const file of files) {
    try {
      const data = await readFileAsJSON(file);
      const convs = Array.isArray(data) ? data : (data.conversations || [data]);
      allConversations = allConversations.concat(convs);
      updateImportLog(`Loaded ${file.name} (${convs.length} conversations). Total: ${allConversations.length}`);
    } catch (err) {
      updateImportLog(`Error: ${err.message}`, true);
    }
  }

  if (allConversations.length) {
    await runImport(allConversations, source);
  }
}

function updateImportLog(text, isError) {
  document.getElementById('import-status').style.display = 'block';
  document.getElementById('import-log').innerHTML = `<span style="color:${isError ? 'var(--red)' : 'var(--text-dim)'}">${esc(text)}</span>`;
}

function updateImportProgress(pct) {
  document.getElementById('import-progress-fill').style.width = pct + '%';
}

async function runImport(data, source) {
  const conversations = Array.isArray(data) ? data : (data.conversations || [data]);
  if (!conversations.length) { updateImportLog('No conversations found', true); return; }

  const distill = document.getElementById('import-distill')?.checked || false;
  updateImportLog(`Importing ${conversations.length} conversations${distill ? ' + distilling' : ''}...`);
  updateImportProgress(0);

  let imported = 0, skipped = 0, failed = 0;
  let distilled = { facts: 0, decisions: 0, tasks: 0 };

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const title = conv.title || conv.name || `${source} Conversation ${i + 1}`;
    let content = '';

    if (source === 'chatgpt') content = extractChatGPT(conv);
    else if (source === 'claude') content = extractClaude(conv);
    else content = JSON.stringify(conv, null, 2);

    if (!content || content.trim().length < 20) { skipped++; updateImportProgress(((i + 1) / conversations.length) * 100); continue; }

    const originalDate = conv.create_time ? new Date(conv.create_time * 1000).toISOString()
      : conv.created_at ? new Date(conv.created_at).toISOString()
      : conv.updated_at ? new Date(conv.updated_at).toISOString() : null;

    const aiSource = source === 'chatgpt' ? 'chatgpt' : source === 'claude' ? 'claude' : source;

    try {
      await api('/transcripts', {
        method: 'POST',
        body: JSON.stringify({
          title, raw_text: content.substring(0, 50000), summary: content.substring(0, 2000),
          source: aiSource, tags: [`${source}-import`, 'conversation'],
          recorded_at: originalDate, metadata: { original_id: conv.id || null }
        })
      });

      if (distill) {
        try {
          const d = await api('/intake/distill', {
            method: 'POST',
            body: JSON.stringify({ title, content: content.substring(0, 15000), source: aiSource, created_at: originalDate })
          });
          if (d.extracted) {
            distilled.facts += d.extracted.facts || 0;
            distilled.decisions += d.extracted.decisions || 0;
            distilled.tasks += d.extracted.tasks || 0;
          }
        } catch (e) { /* best-effort */ }
      }
      imported++;
    } catch (err) { failed++; }

    updateImportProgress(((i + 1) / conversations.length) * 100);
    let st = `${imported} done, ${skipped} skipped, ${failed} failed (${i + 1}/${conversations.length})`;
    if (distill && (distilled.facts || distilled.decisions || distilled.tasks)) {
      st += ` | ${distilled.facts}F ${distilled.decisions}D ${distilled.tasks}T`;
    }
    updateImportLog(st);
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 200));
  }

  updateImportProgress(100);
  let done = `Done! ${imported} imported, ${skipped} skipped, ${failed} failed.`;
  if (distill && (distilled.facts || distilled.decisions || distilled.tasks)) {
    done += ` Distilled: ${distilled.facts} facts, ${distilled.decisions} decisions, ${distilled.tasks} tasks.`;
  }
  updateImportLog(done);

  try { await api('/sync-status/import-complete', { method: 'POST', body: JSON.stringify({ source, imported, skipped, failed, total: conversations.length }) }); } catch (e) {}
  loadDashboard();
}

function extractChatGPT(conv) {
  if (!conv.mapping) return '';
  const nodes = Object.values(conv.mapping);
  nodes.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
  const parts = [];
  for (const node of nodes) {
    const msg = node.message;
    if (!msg || !msg.content) continue;
    const role = msg.author?.role;
    if (role === 'system') continue;
    let text = '';
    if (msg.content.parts) text = msg.content.parts.filter(p => typeof p === 'string').join('\n');
    else if (msg.content.text) text = msg.content.text;
    if (text.trim()) parts.push(`**${role === 'user' ? 'You' : 'ChatGPT'}:** ${text.trim()}`);
  }
  return parts.join('\n\n---\n\n');
}

function extractClaude(conv) {
  const messages = conv.chat_messages || conv.messages || [];
  if (!messages.length && typeof conv.content === 'string') return conv.content;
  return messages.map(m => {
    const role = m.sender === 'human' || m.role === 'user' ? 'You' : 'Claude';
    const text = m.text || m.content || '';
    if (typeof text === 'string') return `**${role}:** ${text.trim()}`;
    if (Array.isArray(text)) return `**${role}:** ${text.filter(t => typeof t === 'string' || t.text).map(t => t.text || t).join('\n')}`;
    return '';
  }).filter(Boolean).join('\n\n---\n\n');
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

// --- Connect AI Prompts ---
const SITE_URL = 'https://ab-brain.up.railway.app';

function getApiKey() {
  return document.getElementById('connect-api-key')?.value?.trim() || getStoredKey() || 'YOUR_API_KEY';
}

function buildPrompt(ai) {
  const key = getApiKey();
  const base = `${SITE_URL}/api`;
  const shared = `API Base: ${base}\nAuth: X-Api-Key: ${key}\n\nENDPOINTS:\n- UNIFIED SEARCH: POST ${base}/search/ai  Body: {"query":"...","limit":10}\n- Knowledge: GET ${base}/knowledge?q=TERM\n- Save: POST ${base}/knowledge  Body: {"title":"...","content":"...","category":"general","tags":[],"ai_source":"${ai}"}\n- Tasks: GET ${base}/tasks\n- Create task: POST ${base}/tasks  Body: {"title":"...","status":"todo","ai_agent":"${ai}","priority":"medium"}\n- Update task: PUT ${base}/tasks/:id`;

  if (ai === 'claude') return `You have access to my personal knowledge base (AB Brain).\n\n${shared}\n\nBefore answering questions about me, SEARCH first. After learning something new, SAVE it. Set ai_source to "claude".`;
  if (ai === 'chatgpt') return `You have access to the user's knowledge base (AB Brain) via Actions.\n\n${shared}\n\nSearch before answering personal questions. Save new facts. Create tasks for action items. Set ai_source to "chatgpt".`;
  return `The user has a knowledge base at ${base}. Since Gemini can't make API calls, help format data as JSON for manual import.`;
}

function renderPrompts() {
  const el = document.getElementById('openapi-url');
  if (el) el.textContent = `${SITE_URL}/openapi-chatgpt.json`;
  for (const ai of ['chatgpt', 'claude', 'gemini']) {
    const promptEl = document.getElementById(`prompt-${ai}`);
    if (promptEl) promptEl.textContent = buildPrompt(ai);
  }
}

function copyPrompt(ai) {
  navigator.clipboard.writeText(buildPrompt(ai)).then(() => {
    const btn = event.target;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 2000);
  });
}

document.getElementById('connect-api-key')?.addEventListener('input', renderPrompts);

// --- Bee ---
async function loadBeeStatus() {
  try {
    const data = await api('/bee/status');
    const el = document.getElementById('bee-status');
    if (!data || !el) return;
    const parts = [];
    if (data.synced_conversations !== undefined) parts.push(`${data.synced_conversations} conversations`);
    if (data.synced_facts !== undefined) parts.push(`${data.synced_facts} facts`);
    if (data.synced_tasks !== undefined) parts.push(`${data.synced_tasks} tasks`);
    if (data.last_sync) parts.push(`Last: ${timeAgo(data.last_sync)}`);
    el.innerHTML = parts.length
      ? `<div style="padding:8px;background:var(--bg-input);border-radius:6px;margin-bottom:8px">Bee: ${parts.join(' &middot; ')}</div>`
      : '';
  } catch (e) {
    const el = document.getElementById('bee-status');
    if (el) el.innerHTML = '';
  }
}

async function triggerBeeCloudSync(force = false) {
  const btn = document.getElementById(force ? 'bee-full-sync-btn' : 'bee-sync-btn');
  const token = document.getElementById('bee-token-input')?.value?.trim();
  const result = document.getElementById('bee-import-result');

  btn.disabled = true;
  btn.textContent = force ? 'Purging & syncing...' : 'Syncing...';
  result.style.display = 'block';
  result.style.background = 'var(--bg-input)';
  result.textContent = force ? 'Purging old data...' : 'Starting sync...';

  try {
    if (force) {
      await api('/bee/purge', { method: 'POST', body: JSON.stringify({ token: token || undefined }) });
      result.textContent = 'Purge done. Syncing...';
    }

    const types = ['facts', 'todos', 'conversations'];
    let totalImported = 0;

    for (const type of types) {
      let cursor = null, typeCount = 0, hasMore = true;
      while (hasMore) {
        result.textContent = `Syncing ${type}... (${typeCount} so far, ${totalImported} total)`;
        const body = { type, token: token || undefined };
        if (cursor) body.cursor = cursor;
        const res = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body) });
        typeCount += res.imported || 0;
        totalImported += res.imported || 0;
        cursor = res.next_cursor || null;
        hasMore = res.has_more && cursor;
      }
    }

    result.style.background = '#0d3320';
    result.textContent = `Done! ${totalImported} items imported.`;
    loadBeeStatus();
    loadDashboard();
  } catch (err) {
    result.style.background = '#3d0a0a';
    result.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = force ? 'Purge & Re-import All' : 'Full Sync (chunked)';
  }
}

async function triggerBeeIncrementalSync() {
  const btn = document.getElementById('bee-incremental-btn');
  const token = document.getElementById('bee-token-input')?.value?.trim();
  const result = document.getElementById('bee-import-result');

  btn.disabled = true;
  btn.textContent = 'Syncing...';
  result.style.display = 'block';
  result.style.background = 'var(--bg-input)';
  result.textContent = 'Running incremental sync...';

  try {
    const res = await api('/bee/sync-incremental', { method: 'POST', body: JSON.stringify({ token: token || undefined }) });
    result.style.background = '#0d3320';
    result.textContent = `Done! ${res.imported || 0} new items.`;
    loadBeeStatus();
    loadDashboard();
  } catch (err) {
    result.style.background = '#3d0a0a';
    result.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Updates Only';
  }
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
  const connectInput = document.getElementById('connect-api-key');
  if (connectInput) connectInput.value = key;
  loadPage();
})();
