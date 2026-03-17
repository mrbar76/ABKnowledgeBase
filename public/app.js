// --- AB Brain — Full SPA with bottom tabs ---

const API = '/api';
let currentTab = 'home';
let cachedProjects = []; // cached for dropdowns

// ─── Auth ─────────────────────────────────────────────────────
function getStoredKey() { return sessionStorage.getItem('ab_api_key') || localStorage.getItem('ab_api_key') || ''; }

function showLogin(message) {
  document.getElementById('login-screen').style.display = 'flex';
  document.querySelector('.app-header').style.display = 'none';
  document.getElementById('main-content').style.display = 'none';
  document.getElementById('bottom-nav').style.display = 'none';
  if (message) { const e = document.getElementById('login-error'); e.textContent = message; e.style.display = 'block'; }
}
function hideLogin() {
  document.getElementById('login-screen').style.display = 'none';
  document.querySelector('.app-header').style.display = '';
  document.getElementById('main-content').style.display = '';
  document.getElementById('bottom-nav').style.display = '';
}
async function doLogin(e) {
  if (e) e.preventDefault();
  const key = document.getElementById('login-key').value.trim();
  if (!key) return;
  try {
    const res = await fetch(API + '/dashboard', { headers: { 'X-Api-Key': key } });
    if (res.status === 401) { document.getElementById('login-error').textContent = 'Invalid API key.'; document.getElementById('login-error').style.display = 'block'; return; }
    const remember = document.getElementById('login-remember').checked;
    sessionStorage.setItem('ab_api_key', key);
    if (remember) localStorage.setItem('ab_api_key', key);
    hideLogin(); switchTab('home');
  } catch { document.getElementById('login-error').textContent = 'Connection error.'; document.getElementById('login-error').style.display = 'block'; }
}
function logout() { sessionStorage.removeItem('ab_api_key'); localStorage.removeItem('ab_api_key'); showLogin(); }

// ─── API helper ───────────────────────────────────────────────
async function api(path, opts = {}) {
  const key = getStoredKey();
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (key) headers['X-Api-Key'] = key;
  let res;
  try { res = await fetch(API + path, { ...opts, headers }); } catch (e) { throw new Error(`Network error: ${e.message}`); }
  if (res.status === 401) { showLogin('Session expired.'); throw new Error('Unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
}

// ─── Tab Navigation ───────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const main = document.getElementById('main-content');
  main.scrollTop = 0;

  if (tab === 'home') loadDashboard();
  else if (tab === 'kanban') loadKanban();
  else if (tab === 'brain') loadBrain();
  else if (tab === 'transcripts') loadTranscripts();
  else if (tab === 'projects') loadProjects();
  else if (tab === 'workouts') loadWorkouts();
}

// ─── Dashboard (Home) ─────────────────────────────────────────
async function loadDashboard() {
  const main = document.getElementById('main-content');

  main.innerHTML = `
    <div class="stats-grid" id="stats-grid">
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Knowledge</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Transcripts</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Tasks</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">In Progress</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Projects</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Facts</div></div>
    </div>

    <div class="card" id="activity-card" style="display:none">
      <h2>Recent Activity</h2>
      <div id="recent-activity"></div>
    </div>
  `;

  loadDashboardStats();
}

async function loadDashboardStats() {
  try {
    const data = await api('/dashboard');
    const totalTasks = Object.values(data.tasks.by_status).reduce((a, b) => a + b, 0);
    const inProgress = data.tasks.by_status.in_progress || 0;
    const grid = document.getElementById('stats-grid');
    if (!grid) return;
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-value">${data.knowledge.total}</div><div class="stat-label">Knowledge</div></div>
      <div class="stat-card"><div class="stat-value">${data.transcripts.total}</div><div class="stat-label">Transcripts</div></div>
      <div class="stat-card"><div class="stat-value">${totalTasks}</div><div class="stat-label">Tasks</div></div>
      <div class="stat-card"><div class="stat-value">${inProgress}</div><div class="stat-label">In Progress</div></div>
      <div class="stat-card"><div class="stat-value">${data.projects.active}</div><div class="stat-label">Projects</div></div>
      <div class="stat-card" onclick="switchTab('workouts')" style="cursor:pointer"><div class="stat-value">${data.workouts?.total || 0}</div><div class="stat-label">Workouts</div></div>
    `;
    if (data.recent_activity?.length) {
      const ac = document.getElementById('activity-card');
      if (ac) { ac.style.display = ''; document.getElementById('recent-activity').innerHTML = data.recent_activity.map(renderActivityItem).join(''); }
    }
  } catch (e) {
    if (e.message === 'Unauthorized') return;
    const grid = document.getElementById('stats-grid');
    if (grid) grid.innerHTML = '<div class="stat-card" style="grid-column:1/-1"><div class="stat-value" style="font-size:0.85rem;color:var(--text-dim)">Could not load stats</div></div>';
  }
}

// ─── Settings Menu (logo tap) ────────────────────────────────
function toggleSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  if (menu.classList.contains('open')) { closeSettingsMenu(); return; }
  menu.classList.add('open');
  loadSettingsMenuInfo();
}
function closeSettingsMenu() { document.getElementById('settings-menu').classList.remove('open'); }

async function copyGptActionsSchema() {
  const btn = document.getElementById('btn-copy-schema');
  const resultEl = document.getElementById('sm-schema-result');
  try {
    btn.textContent = 'Loading...';
    const resp = await fetch('/openapi-gpt-actions.yaml');
    if (!resp.ok) throw new Error('Failed to fetch schema');
    const text = await resp.text();
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--accent)';
    resultEl.textContent = 'Schema copied to clipboard. Paste it into your GPT Actions configuration.';
    setTimeout(() => { btn.textContent = 'Copy Schema'; }, 3000);
  } catch (err) {
    btn.textContent = 'Copy Schema';
    resultEl.style.display = 'block';
    resultEl.style.color = '#e74c3c';
    resultEl.textContent = 'Error: ' + err.message;
  }
}

async function loadSettingsMenuInfo() {
  const bkEl = document.getElementById('sm-backend-val');
  const beeEl = document.getElementById('sm-bee-val');
  const oaEl = document.getElementById('sm-openai-val');
  const syncEl = document.getElementById('sm-synced-val');

  // Health / backend
  try {
    const key = getStoredKey();
    const res = await fetch(API + '/health', { headers: key ? { 'X-Api-Key': key } : {} });
    const data = await res.json().catch(() => ({}));
    if (bkEl) {
      bkEl.textContent = res.ok ? (data.backend || 'PostgreSQL') + ' — connected' : 'error';
      bkEl.style.color = res.ok ? 'var(--green)' : 'var(--red)';
    }
  } catch {
    if (bkEl) { bkEl.textContent = 'offline'; bkEl.style.color = 'var(--red)'; }
  }

  // Bee status
  try {
    const beeData = await api('/bee/status');
    if (beeEl) {
      beeEl.textContent = beeData.bee_token_configured ? 'Configured' : 'Not set';
      beeEl.style.color = beeData.bee_token_configured ? 'var(--green)' : 'var(--yellow)';
    }
    if (oaEl) {
      oaEl.textContent = beeData.openai_configured ? 'Configured' : 'Not set';
      oaEl.style.color = beeData.openai_configured ? 'var(--green)' : 'var(--yellow)';
    }
    // Synced counts
    if (syncEl) {
      const parts = [];
      if (beeData.facts > 0) parts.push(`${beeData.facts} facts`);
      if (beeData.tasks > 0) parts.push(`${beeData.tasks} tasks`);
      if (beeData.transcripts > 0) parts.push(`${beeData.transcripts} transcripts`);
      syncEl.textContent = parts.length ? parts.join(', ') : 'None';
    }
  } catch (e) {
    if (beeEl) { beeEl.textContent = 'Error'; beeEl.style.color = 'var(--red)'; }
    if (oaEl) { oaEl.textContent = 'Error'; oaEl.style.color = 'var(--red)'; }
  }
}

async function triggerBeeSyncFromMenu(mode) {
  const btnUp = document.getElementById('sm-btn-sync-updates');
  const btnFull = document.getElementById('sm-btn-sync-full');
  const resultEl = document.getElementById('sm-sync-result');
  if (!resultEl) return;

  if (btnUp) btnUp.disabled = true;
  if (btnFull) btnFull.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';

  if (mode === 'full') {
    const types = ['facts', 'todos', 'conversations', 'journals', 'daily'];
    const typeLabels = { facts: 'Facts', todos: 'Tasks', conversations: 'Conversations', journals: 'Journals', daily: 'Daily' };
    const totals = { facts: 0, todos: 0, conversations: 0, journals: 0, daily: 0, skipped: 0, errors: [] };

    resultEl.innerHTML = `
      <div style="margin-bottom:6px;font-weight:600;font-size:0.82rem">Syncing from Bee...</div>
      <div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:6px">
        <div id="sm-sync-fill" style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),var(--green));border-radius:3px;transition:width 0.3s"></div>
      </div>
      <div id="sm-sync-text" style="font-size:0.75rem;color:var(--text-dim)">Starting...</div>
    `;
    const fill = document.getElementById('sm-sync-fill');
    const text = document.getElementById('sm-sync-text');

    for (let ti = 0; ti < types.length; ti++) {
      const type = types[ti];
      const basePct = (ti / types.length) * 100;
      const typePct = (1 / types.length) * 100;
      let cursor = null, pageNum = 0;

      if (text) text.textContent = `Syncing ${typeLabels[type]}...`;
      if (fill) fill.style.width = `${basePct}%`;

      do {
        pageNum++;
        try {
          const data = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify({ type, cursor, force: false }) });
          totals[type] += (data.imported || 0);
          totals.skipped += (data.skipped || 0);
          if (data.errors?.length) totals.errors.push(...data.errors);
          cursor = data.cursor;
          if (fill) fill.style.width = `${basePct + (data.done || !cursor ? typePct : typePct * 0.8 * pageNum / (pageNum + 2))}%`;
          if (text) text.textContent = `${typeLabels[type]}: ${totals[type]} imported`;
          if (data.done || !cursor) break;
        } catch (err) {
          totals.errors.push(`${type}: ${err.message}`);
          if (text) text.textContent = `${typeLabels[type]}: error`;
          break;
        }
      } while (cursor);
    }

    if (fill) fill.style.width = '100%';
    const parts = [];
    if (totals.facts) parts.push(`${totals.facts} facts`);
    if (totals.todos) parts.push(`${totals.todos} tasks`);
    if (totals.conversations) parts.push(`${totals.conversations} conversations`);
    if (totals.journals) parts.push(`${totals.journals} journals`);
    if (totals.daily) parts.push(`${totals.daily} daily`);
    let summary = parts.length ? `Imported: ${parts.join(', ')}` : 'No new items';
    if (totals.skipped > 0) summary += ` (${totals.skipped} skipped)`;
    if (totals.errors.length) summary += ` — ${totals.errors.length} error(s)`;
    if (totals.conversations > 0) summary += '\nAI identifying speakers in background...';
    if (text) { text.innerHTML = summary.replace(/\n/g, '<br>'); text.style.color = totals.errors.length ? 'var(--yellow)' : 'var(--green)'; }
  } else {
    resultEl.textContent = 'Syncing updates...';
    try {
      const data = await api('/bee/sync-incremental', { method: 'POST', body: JSON.stringify({}) });
      const i = data.imported || {};
      const parts = [];
      if (i.facts) parts.push(`${i.facts} facts`);
      if (i.todos) parts.push(`${i.todos} tasks`);
      if (i.conversations) parts.push(`${i.conversations} conversations`);
      resultEl.style.color = 'var(--green)';
      resultEl.textContent = parts.length ? `Imported: ${parts.join(', ')}` : 'No new items';
    } catch (err) {
      resultEl.style.color = 'var(--red)';
      resultEl.textContent = `Sync failed: ${err.message}`;
    }
  }

  if (btnUp) btnUp.disabled = false;
  if (btnFull) btnFull.disabled = false;
  loadSettingsMenuInfo();
  // Refresh dashboard if visible
  if (currentTab === 'home') loadDashboardStats();
}

function confirmPurgeFromMenu() {
  const btn = document.getElementById('btn-purge-settings');
  const resultEl = document.getElementById('purge-menu-result');

  if (!btn._confirmStep) {
    btn._confirmStep = 1;
    btn.textContent = 'Are you sure? Tap again to confirm';
    btn.style.background = 'rgba(239,68,68,0.3)';
    setTimeout(() => { if (btn._confirmStep === 1) { btn._confirmStep = 0; btn.textContent = 'Purge All Data'; btn.style.background = ''; } }, 4000);
    return;
  }
  if (btn._confirmStep === 1) {
    btn._confirmStep = 2;
    btn.textContent = 'LAST CHANCE — This deletes EVERYTHING';
    btn.style.background = 'rgba(239,68,68,0.5)';
    setTimeout(() => { if (btn._confirmStep === 2) { btn._confirmStep = 0; btn.textContent = 'Purge All Data'; btn.style.background = ''; } }, 4000);
    return;
  }

  // Actually purge
  btn._confirmStep = 0;
  btn.disabled = true;
  btn.textContent = 'Purging...';
  if (resultEl) { resultEl.style.display = 'block'; resultEl.textContent = 'Purging all data...'; resultEl.style.color = 'var(--text-dim)'; }

  api('/purge', { method: 'POST', body: JSON.stringify({}) }).then(() => {
    const poll = async () => {
      try {
        const s = await api('/purge/status');
        if (s.status === 'running') { if (resultEl) resultEl.textContent = `Purging... (${s.progress?.current || 0} deleted)`; setTimeout(poll, 1500); }
        else { if (resultEl) { resultEl.style.color = 'var(--green)'; resultEl.textContent = s.message || 'All data purged.'; } btn.disabled = false; btn.textContent = 'Purge All Data'; btn.style.background = ''; if (currentTab === 'home') loadDashboard(); loadSettingsMenuInfo(); }
      } catch { if (resultEl) { resultEl.style.color = 'var(--green)'; resultEl.textContent = 'Purge complete.'; } btn.disabled = false; btn.textContent = 'Purge All Data'; btn.style.background = ''; }
    };
    setTimeout(poll, 1500);
  }).catch(e => {
    if (resultEl) { resultEl.style.display = 'block'; resultEl.style.color = 'var(--red)'; resultEl.textContent = e.message; }
    btn.disabled = false; btn.textContent = 'Purge All Data'; btn.style.background = '';
  });
}

// ─── Sync Conversations by Date Range (chunked — page by page) ────────────
async function syncConversationsByDate() {
  const btn = document.getElementById('sm-btn-sync-convos');
  const resultEl = document.getElementById('sm-conv-sync-result');
  const startInput = document.getElementById('sm-conv-start');
  const endInput = document.getElementById('sm-conv-end');
  if (!resultEl) return;

  const baseBody = {
    start_date: (startInput && startInput.value) || '2025-12-01',
    end_date: (endInput && endInput.value) || new Date().toISOString().split('T')[0],
  };

  if (btn) btn.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';
  resultEl.textContent = 'Syncing conversations...';

  let cursor = null, totalImported = 0, totalSkipped = 0, pageNum = 0, errors = [];
  do {
    pageNum++;
    try {
      const body = { ...baseBody };
      if (cursor) body.cursor = cursor;
      const data = await api('/bee/sync-conversations', { method: 'POST', body: JSON.stringify(body) });
      totalImported += (data.imported || 0);
      totalSkipped += (data.skipped || 0);
      if (data.errors?.length) errors.push(...data.errors);
      cursor = data.cursor;
      resultEl.textContent = `Page ${pageNum}: ${totalImported} imported, ${totalSkipped} skipped...`;
      if (data.done || !cursor) break;
    } catch (err) {
      errors.push(err.message);
      resultEl.textContent = `Page ${pageNum}: error — ${err.message}`;
      break;
    }
  } while (cursor);

  let msg = totalImported ? `${totalImported} conversations imported` : 'No new conversations';
  if (totalSkipped) msg += `, ${totalSkipped} skipped`;
  msg += ` (${pageNum} page${pageNum > 1 ? 's' : ''})`;
  if (errors.length) msg += ` — ${errors.length} error(s)`;
  if (totalImported > 0) msg += '\nAI identifying speakers in background...';
  resultEl.innerHTML = msg.replace(/\n/g, '<br>');
  resultEl.style.color = errors.length ? 'var(--yellow)' : 'var(--green)';
  if (btn) btn.disabled = false;
  loadSettingsMenuInfo();
  if (currentTab === 'home') loadDashboardStats();
  if (currentTab === 'transcripts') loadTranscripts();
}

// ─── Debug / Diagnostics Panel ───────────────────────────────
async function showDebugPanel() {
  const main = document.getElementById('main-content');
  // Deselect tabs since this is a non-tab view
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  main.innerHTML = '<div class="loading">Running diagnostics...</div>';

  const results = {};

  // Health check
  try {
    const key = getStoredKey();
    const r = await fetch(API + '/health', { headers: key ? { 'X-Api-Key': key } : {} });
    results.health = await r.json().catch(() => ({ status: r.status }));
    results.health._http = r.status;
  } catch (e) { results.health = { error: e.message }; }

  // Bee status
  try { results.bee_status = await api('/bee/status'); } catch (e) { results.bee_status = { error: e.message }; }

  // Bee diagnose (tests each Bee API endpoint)
  try { results.bee_diagnose = await api('/bee/diagnose'); } catch (e) { results.bee_diagnose = { error: e.message }; }

  // Sync status
  try { results.sync_status = await api('/sync-status'); } catch (e) { results.sync_status = { error: e.message }; }

  // Dashboard (tests all DB tables)
  try { results.dashboard = await api('/dashboard'); } catch (e) { results.dashboard = { error: e.message }; }

  // Activity log (last 10)
  try { results.activity = await api('/activity?limit=10'); } catch (e) { results.activity = { error: e.message }; }

  main.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="font-size:1rem;font-weight:700">Diagnostics &amp; Logs</h2>
      <button class="btn-action btn-action-secondary" onclick="switchTab('home')" style="padding:6px 14px;font-size:0.8rem">Back</button>
    </div>
    ${renderDebugSection('Health Check', results.health)}
    ${renderDebugSection('Bee Status', results.bee_status)}
    ${renderDebugSection('Bee API Endpoints', results.bee_diagnose)}
    ${renderDebugSection('Sync Status', results.sync_status)}
    ${renderDebugSection('Dashboard Data', results.dashboard)}
    ${renderDebugSection('Recent Activity', results.activity)}
    <div class="card">
      <h2>Raw JSON (tap to copy)</h2>
      <pre id="debug-raw" onclick="copyDebugRaw()" style="font-size:0.65rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto;padding:8px;background:var(--bg-input);border-radius:6px;cursor:pointer;color:var(--text-dim)">${esc(JSON.stringify(results, null, 2))}</pre>
    </div>
  `;
}

function renderDebugSection(title, data) {
  if (!data) return '';
  const isError = data.error || data._http >= 400;
  const color = isError ? 'var(--red)' : 'var(--green)';
  let body = '';

  if (data.error) {
    body = `<div style="color:var(--red);font-size:0.8rem">${esc(data.error)}</div>`;
  } else {
    const entries = Object.entries(data).filter(([k]) => !k.startsWith('_'));
    body = entries.map(([k, v]) => {
      let val = v;
      if (typeof v === 'object' && v !== null) val = JSON.stringify(v);
      if (typeof val === 'string' && val.length > 200) val = val.substring(0, 200) + '...';
      const valColor = v === false || v === 'error' ? 'var(--red)' : v === true || v === 'idle' || v === 'ok' ? 'var(--green)' : 'var(--text-dim)';
      return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);font-size:0.75rem">
        <span style="color:var(--text-dim)">${esc(k)}</span>
        <span style="color:${valColor};max-width:60%;text-align:right;word-break:break-all">${esc(String(val))}</span>
      </div>`;
    }).join('');
  }

  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h2 style="margin-bottom:0">${esc(title)}</h2>
        <span style="width:8px;height:8px;border-radius:50%;background:${color}"></span>
      </div>
      ${body}
    </div>`;
}

function copyDebugRaw() {
  const el = document.getElementById('debug-raw');
  if (el) {
    navigator.clipboard.writeText(el.textContent).then(() => {
      el.style.borderColor = 'var(--green)';
      setTimeout(() => { el.style.borderColor = ''; }, 1000);
    }).catch(() => {});
  }
}

// ─── Kanban ───────────────────────────────────────────────────
async function loadKanban() {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const data = await api('/tasks/kanban');
    const cols = ['todo', 'in_progress', 'review', 'done'];
    const labels = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
    const colors = { todo: 'var(--text-dim)', in_progress: 'var(--blue)', review: 'var(--yellow)', done: 'var(--green)' };

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:1rem;font-weight:700">Kanban Board</h2>
        <button class="btn-action" onclick="showNewTaskModal()" style="padding:6px 14px;font-size:0.8rem">+ Task</button>
      </div>
      <div class="kanban-board">${cols.map(col => `
        <div class="kanban-col">
          <div class="kanban-col-header" style="border-bottom-color:${colors[col]}">
            <span>${labels[col]}</span>
            <span class="kanban-count">${(data[col] || []).length}</span>
          </div>
          <div class="kanban-col-body">
            ${(data[col] || []).map(t => `
              <div class="kanban-card" onclick="showTaskDetail('${t.id}')">
                <div class="kanban-card-title">${esc(t.title)}</div>
                ${t.project_name ? `<div class="kanban-card-meta">${esc(t.project_name)}</div>` : ''}
                <div class="kanban-card-meta">
                  <span class="priority-badge priority-${t.priority}">${t.priority}</span>
                  ${t.ai_agent ? `<span class="k-source-badge source-${t.ai_agent}">${t.ai_agent}</span>` : ''}
                </div>
              </div>`).join('') || '<div class="empty-state" style="padding:12px">Empty</div>'}
          </div>
        </div>`).join('')}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">Failed to load kanban: ${esc(e.message)}</div>`; }
}

async function showTaskDetail(id) {
  try {
    const task = await api(`/tasks/${id}`);
    await ensureProjectsCache();
    openModal(task.title, `
      <div class="form-group"><label>Status</label>
        <select onchange="updateTask('${id}', 'status', this.value)">
          ${['todo','in_progress','review','done'].map(s => `<option value="${s}" ${task.status===s?'selected':''}>${s.replace('_',' ')}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Priority</label>
        <select onchange="updateTask('${id}', 'priority', this.value)">
          ${['low','medium','high','urgent'].map(p => `<option value="${p}" ${task.priority===p?'selected':''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Project</label>
        <select onchange="updateTask('${id}', 'project_id', this.value||null)">
          ${projectDropdownHtml(task.project_id)}
        </select>
      </div>
      ${task.description ? `<div class="form-group"><label>Description</label><div style="font-size:0.85rem;white-space:pre-wrap">${esc(task.description)}</div></div>` : ''}
      ${task.next_steps ? `<div class="form-group"><label>Next Steps</label><div style="font-size:0.85rem">${esc(task.next_steps)}</div></div>` : ''}
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn-action btn-action-danger" onclick="deleteTask('${id}')" style="flex:1">Delete</button>
      </div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function updateTask(id, field, value) {
  try { await api(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); loadKanban(); } catch {}
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try { await api(`/tasks/${id}`, { method: 'DELETE' }); closeModal(); loadKanban(); } catch {}
}

async function ensureProjectsCache() {
  if (!cachedProjects.length) {
    try { const d = await api('/projects'); cachedProjects = d.projects || []; } catch {}
  }
  return cachedProjects;
}

function projectDropdownHtml(selectedId) {
  return `<option value="">No project</option>` +
    cachedProjects.map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function showNewTaskModal(defaultProjectId) {
  ensureProjectsCache().then(() => {
    openModal('New Task', `
      <form onsubmit="createTask(event)">
        <div class="form-group"><label>Title</label><input type="text" id="new-task-title" required></div>
        <div class="form-group"><label>Description</label><textarea id="new-task-desc" rows="3"></textarea></div>
        <div class="form-group"><label>Priority</label>
          <select id="new-task-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
        </div>
        <div class="form-group"><label>Project</label>
          <select id="new-task-project">${projectDropdownHtml(defaultProjectId)}</select>
        </div>
        <button type="submit" class="btn-submit">Create Task</button>
      </form>
    `);
  });
}

async function createTask(e) {
  e.preventDefault();
  try {
    await api('/tasks', { method: 'POST', body: JSON.stringify({
      title: document.getElementById('new-task-title').value,
      description: document.getElementById('new-task-desc').value,
      priority: document.getElementById('new-task-priority').value,
      project_id: document.getElementById('new-task-project').value || null,
    }) });
    closeModal();
    if (currentTab === 'kanban') loadKanban();
    else if (currentTab === 'projects') loadProjects();
  } catch (err) { alert(err.message); }
}

// ─── Brain (Knowledge + Facts) ────────────────────────────────
let brainSubTab = 'knowledge';

async function loadBrain(searchQuery) {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="brain-tabs">
      <button class="brain-tab${brainSubTab==='knowledge'?' active':''}" onclick="brainSubTab='knowledge';loadBrain()">Knowledge</button>
      <button class="brain-tab${brainSubTab==='facts'?' active':''}" onclick="brainSubTab='facts';loadBrain()">Facts</button>
    </div>
    <div class="loading">Loading...</div>`;
  if (brainSubTab === 'facts') return loadFacts(searchQuery);
  try {
    const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}&limit=50` : '?limit=50';
    const data = await api('/knowledge' + qs);

    const listHtml = `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" class="brain-search" placeholder="Search knowledge..." value="${esc(searchQuery || '')}" oninput="debounceBrainSearch(this.value)">
        <button class="btn-action" onclick="showNewKnowledgeModal()" style="flex-shrink:0;padding:8px 14px;font-size:0.8rem">+ Add</button>
      </div>
      <div id="brain-list">
        ${data.entries.length ? data.entries.map(k => `
          <div class="list-item" onclick="showKnowledgeDetail('${k.id}')">
            <div class="list-item-title">
              ${k.ai_source ? `<span class="k-source-badge source-${k.ai_source}">${k.ai_source}</span>` : ''}
              ${esc(k.title)}
            </div>
            <div class="list-item-preview">${esc((k.content || '').substring(0, 150))}</div>
            <div class="list-item-meta">
              <span>${k.category || 'general'}</span>
              <span>${timeAgo(k.updated_at || k.created_at)}</span>
            </div>
          </div>`).join('') : '<div class="empty-state">No knowledge entries yet</div>'}
      </div>
    `;
    main.innerHTML = `
      <div class="brain-tabs">
        <button class="brain-tab${brainSubTab==='knowledge'?' active':''}" onclick="brainSubTab='knowledge';loadBrain()">Knowledge</button>
        <button class="brain-tab${brainSubTab==='facts'?' active':''}" onclick="brainSubTab='facts';loadBrain()">Facts</button>
      </div>` + listHtml;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function loadFacts(searchQuery) {
  const main = document.getElementById('main-content');
  try {
    const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}&limit=50` : '?limit=50';
    const data = await api('/facts' + qs);

    main.innerHTML = `
      <div class="brain-tabs">
        <button class="brain-tab${brainSubTab==='knowledge'?' active':''}" onclick="brainSubTab='knowledge';loadBrain()">Knowledge</button>
        <button class="brain-tab${brainSubTab==='facts'?' active':''}" onclick="brainSubTab='facts';loadBrain()">Facts</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" class="brain-search" placeholder="Search facts..." value="${esc(searchQuery || '')}" oninput="debounceFactSearch(this.value)">
      </div>
      <div id="facts-list">
        ${data.facts.length ? data.facts.map(f => `
          <div class="list-item" onclick="showFactDetail('${f.id}')">
            <div class="list-item-title">${esc(f.title)}</div>
            <div class="list-item-preview">${esc((f.content || '').substring(0, 200))}</div>
            <div class="list-item-meta">
              <span>${f.category || 'general'}</span>
              <span>${f.source || ''}</span>
              ${f.confirmed ? '<span style="color:var(--green)">confirmed</span>' : '<span style="color:var(--text-dim)">unconfirmed</span>'}
              <span>${timeAgo(f.created_at)}</span>
            </div>
          </div>`).join('') : '<div class="empty-state">No facts yet. Facts are captured from Bee sync and AI intake.</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

let factSearchTimer = null;
function debounceFactSearch(q) { clearTimeout(factSearchTimer); factSearchTimer = setTimeout(() => loadFacts(q), 300); }

async function showFactDetail(id) {
  try {
    const f = await api(`/facts/${id}`);
    openModal(f.title, `
      <div class="list-item-meta" style="margin-bottom:12px">
        <span>${f.category || 'general'}</span>
        <span>${f.source || ''}</span>
        ${f.confirmed ? '<span style="color:var(--green)">confirmed</span>' : '<span style="color:var(--text-dim)">unconfirmed</span>'}
        <span>${timeAgo(f.created_at)}</span>
      </div>
      ${f.tags?.length ? `<div style="margin-bottom:12px">${(Array.isArray(f.tags) ? f.tags : []).map(t => `<span class="tag-pill">${esc(t)}</span>`).join(' ')}</div>` : ''}
      <div style="font-size:0.88rem;white-space:pre-wrap;line-height:1.6">${esc(f.content)}</div>
      <div style="margin-top:12px;display:flex;gap:8px">
        ${!f.confirmed ? `<button class="btn-action" onclick="confirmFact('${id}')" style="flex:1;padding:8px">Confirm</button>` : ''}
        <button class="btn-action btn-action-danger" onclick="deleteFact('${id}')" style="flex:1;padding:8px">Delete</button>
      </div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function confirmFact(id) {
  try {
    await api(`/facts/${id}`, { method: 'PUT', body: JSON.stringify({ confirmed: true }) });
    closeModal(); loadBrain();
  } catch (e) { alert(e.message); }
}

async function deleteFact(id) {
  if (!confirm('Delete this fact?')) return;
  try { await api(`/facts/${id}`, { method: 'DELETE' }); closeModal(); loadBrain(); } catch {}
}

let brainSearchTimer = null;
function debounceBrainSearch(q) { clearTimeout(brainSearchTimer); brainSearchTimer = setTimeout(() => loadBrain(q), 300); }

async function showKnowledgeDetail(id) {
  try {
    const k = await api(`/knowledge/${id}`);
    openModal(k.title, `
      <div class="list-item-meta" style="margin-bottom:12px"><span>${k.category}</span><span>${k.ai_source || ''}</span><span>${timeAgo(k.created_at)}</span></div>
      ${k.tags?.length ? `<div style="margin-bottom:12px">${(Array.isArray(k.tags) ? k.tags : []).map(t => `<span class="tag-pill">${esc(t)}</span>`).join(' ')}</div>` : ''}
      <div style="font-size:0.88rem;white-space:pre-wrap;line-height:1.6">${esc(k.content)}</div>
      <div style="margin-top:16px"><button class="btn-action btn-action-danger" onclick="deleteKnowledge('${id}')" style="width:100%">Delete</button></div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function deleteKnowledge(id) {
  if (!confirm('Delete this entry?')) return;
  try { await api(`/knowledge/${id}`, { method: 'DELETE' }); closeModal(); loadBrain(); } catch {}
}

function showNewKnowledgeModal() {
  openModal('New Knowledge', `
    <form onsubmit="createKnowledge(event)">
      <div class="form-group"><label>Title</label><input type="text" id="new-k-title" required></div>
      <div class="form-group"><label>Content</label><textarea id="new-k-content" rows="6" required></textarea></div>
      <div class="form-group"><label>Category</label>
        <select id="new-k-category">
          ${['general','code','meeting','research','decision','reference','health','personal','journal'].map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Tags (comma-separated)</label><input type="text" id="new-k-tags" placeholder="tag1, tag2"></div>
      <button type="submit" class="btn-submit">Save</button>
    </form>
  `);
}

async function createKnowledge(e) {
  e.preventDefault();
  try {
    await api('/knowledge', { method: 'POST', body: JSON.stringify({
      title: document.getElementById('new-k-title').value,
      content: document.getElementById('new-k-content').value,
      category: document.getElementById('new-k-category').value,
      tags: document.getElementById('new-k-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    }) });
    closeModal(); loadBrain();
  } catch (err) { alert(err.message); }
}

// ─── Transcripts ──────────────────────────────────────────────
let transcriptFilters = {};

function setTranscriptFilter(key, value) {
  if (value === null || value === undefined || value === '') {
    delete transcriptFilters[key];
  } else {
    transcriptFilters[key] = value;
  }
  loadTranscripts(transcriptFilters._q || '');
}

async function loadTranscripts(searchQuery) {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (searchQuery) params.set('q', searchQuery);
    for (const [k, v] of Object.entries(transcriptFilters)) {
      if (k !== '_q' && v) params.set(k, v);
    }
    const data = await api('/transcripts?' + params.toString());

    const activeStatus = transcriptFilters.status || '';
    const activeType = transcriptFilters.content_type || '';
    const activeMedia = transcriptFilters.is_media || '';

    main.innerHTML = `
      <input type="text" class="brain-search" placeholder="Search transcripts..." value="${esc(searchQuery || '')}"
        oninput="debounceTranscriptSearch(this.value)" style="margin-bottom:8px">
      <div class="transcript-filters">
        <div class="filter-row">
          <button class="filter-btn ${!activeStatus && !activeType && !activeMedia ? 'active' : ''}" onclick="transcriptFilters={};loadTranscripts('')">All</button>
          <button class="filter-btn ${activeStatus === 'unidentified' ? 'active' : ''}" onclick="setTranscriptFilter('status', '${activeStatus === 'unidentified' ? '' : 'unidentified'}')">Needs ID</button>
          <button class="filter-btn ${activeStatus === 'unclassified' ? 'active' : ''}" onclick="setTranscriptFilter('status', '${activeStatus === 'unclassified' ? '' : 'unclassified'}')">Unclassified</button>
          <button class="filter-btn ${activeMedia === 'true' ? 'active' : ''}" onclick="setTranscriptFilter('is_media', '${activeMedia === 'true' ? '' : 'true'}')">Media</button>
        </div>
        <div class="filter-row">
          ${['conversation','meeting','phone_call','movie','tv_show','youtube','podcast'].map(ct =>
            `<button class="filter-btn filter-btn-sm ${activeType === ct ? 'active' : ''}" onclick="setTranscriptFilter('content_type', '${activeType === ct ? '' : ct}')">${ct.replace('_',' ')}</button>`
          ).join('')}
        </div>
      </div>
      <div class="transcript-count">${data.total !== undefined ? data.total : data.count} transcript${data.count !== 1 ? 's' : ''}${activeStatus || activeType || activeMedia ? ' matching filters' : ''}</div>
      <div id="transcript-list">
        ${data.transcripts.length ? data.transcripts.map(t => {
          const summary = t.summary || t.preview || '';
          const loc = t.location ? t.location.split(',').slice(0,2).join(',') : '';
          const meta = t.metadata || {};
          const speakers = meta.speakers || [];
          const contentType = meta.content_type;
          const isMedia = meta.is_media;
          const hasGeneric = speakers.some(s => /^(speaker|unknown)/i.test(s));
          const rd = t.recorded_at || t.created_at;
          const rdObj = rd ? new Date(rd) : null;
          const dateLabel = rdObj ? rdObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          const timeLabel = rdObj ? rdObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
          return `
          <div class="list-item transcript-card ${hasGeneric ? 'needs-id' : ''}" onclick="showTranscriptDetail('${t.id}')">
            <div class="transcript-card-header">
              <div class="list-item-title">${esc(t.title)}</div>
              ${contentType && contentType !== 'conversation' ? `<span class="content-type-badge ${isMedia ? 'media' : ''}">${esc(contentType.replace('_',' '))}</span>` : ''}
              ${hasGeneric ? '<span class="needs-id-badge">Needs ID</span>' : ''}
            </div>
            ${speakers.length ? `<div class="transcript-speakers">${speakers.map(s => `<span class="speaker-tag ${/^(speaker|unknown)/i.test(s) ? 'generic' : ''}">${esc(s)}</span>`).join('')}</div>` : ''}
            ${summary ? `<div class="transcript-summary">${esc(summary.substring(0, 300))}</div>` : ''}
            <div class="list-item-meta">
              <span>${t.source || 'bee'}</span>
              ${t.duration_seconds ? `<span>${Math.round(t.duration_seconds/60)} min</span>` : ''}
              ${loc ? `<span>${esc(loc)}</span>` : ''}
              ${dateLabel ? `<span>${dateLabel} ${timeLabel}</span>` : ''}
            </div>
          </div>`;
        }).join('') : '<div class="empty-state">No transcripts match these filters</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

let transcriptSearchTimer = null;
function debounceTranscriptSearch(q) {
  transcriptFilters._q = q;
  clearTimeout(transcriptSearchTimer);
  transcriptSearchTimer = setTimeout(() => loadTranscripts(q), 300);
}

async function showTranscriptDetail(id) {
  try {
    const t = await api(`/transcripts/${id}`);
    const meta = t.metadata || {};

    // Format date/time info
    const startDate = t.recorded_at ? new Date(t.recorded_at) : null;
    const endDate = meta.ended_at ? new Date(meta.ended_at) : null;
    const dateOpts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    const timeOpts = { hour: 'numeric', minute: '2-digit', hour12: true };
    let dateStr = '';
    if (startDate) {
      dateStr = startDate.toLocaleDateString('en-US', dateOpts);
      const startTime = startDate.toLocaleTimeString('en-US', timeOpts);
      const endTime = endDate ? endDate.toLocaleTimeString('en-US', timeOpts) : '';
      dateStr += ` &middot; ${startTime}${endTime ? ' – ' + endTime : ''}`;
    }

    // Also get speaker names from the speakers array if metadata doesn't have them
    const speakerNames = meta.speakers && meta.speakers.length
      ? meta.speakers
      : (t.speakers && t.speakers.length ? [...new Set(t.speakers.map(s => s.speaker_name))] : []);

    let bodyHtml = '<div class="transcript-detail-meta">';
    if (dateStr) bodyHtml += `<div style="font-size:0.85rem;font-weight:600;margin-bottom:4px">${dateStr}</div>`;
    bodyHtml += '<div class="list-item-meta" style="margin-bottom:2px">';
    bodyHtml += `<span>${t.source || 'bee'}</span>`;
    if (t.duration_seconds) bodyHtml += `<span>${Math.round(t.duration_seconds/60)} min</span>`;
    if (meta.utterance_count) bodyHtml += `<span>${meta.utterance_count} messages</span>`;
    bodyHtml += '</div>';
    const hasUnknown = speakerNames.some(s => /unknown|speaker/i.test(s));
    if (speakerNames.length) {
      bodyHtml += `<div class="transcript-speakers" style="margin-top:6px">${speakerNames.map(s =>
        `<span class="speaker-tag" style="cursor:pointer" onclick="renameSpeaker('${id}','${esc(s).replace(/'/g, "\\'")}')" title="Tap to rename">${esc(s)}</span>`
      ).join('')}`;
      if (hasUnknown) {
        bodyHtml += ` <button class="btn-identify-speakers" id="btn-identify-${id}" onclick="identifySpeakers('${id}')">Auto-ID</button>`;
        bodyHtml += ` <button class="btn-identify-speakers" id="btn-rehint-${id}" onclick="reIdentifyWithHints('${id}')" style="background:var(--accent)">ID with names</button>`;
      }
      bodyHtml += '</div>';
    }
    if (t.location) bodyHtml += `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:4px">${esc(t.location)}</div>`;
    bodyHtml += '<div id="identify-result-${id}"></div>';
    bodyHtml += '</div>';

    // Show summary section with speakers listed
    if (t.summary || speakerNames.length) {
      bodyHtml += `<div class="transcript-detail-summary">`;
      if (speakerNames.length) {
        bodyHtml += `<div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim);margin-bottom:4px">Participants</div>`;
        bodyHtml += `<div style="font-size:0.85rem;margin-bottom:8px;color:var(--text)">${speakerNames.join(', ')}</div>`;
      }
      if (t.summary) {
        bodyHtml += `<div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim);margin-bottom:4px">Summary</div>`;
        bodyHtml += `<div style="font-size:0.88rem;line-height:1.6;color:var(--text)">${formatBeeSummary(t.summary)}</div>`;
      }
      bodyHtml += `</div>`;
    }

    // Show full transcript (speakers or raw text)
    const hasTranscript = (t.speakers && t.speakers.length) || t.raw_text;
    if (hasTranscript) {
      const utteranceCount = t.speakers?.length || 0;
      bodyHtml += `
        <div style="margin-top:12px">
          <button class="btn-action" onclick="this.style.display='none';document.getElementById('transcript-full-${id}').style.display='block'" style="width:100%;padding:10px;font-size:0.82rem">
            View Full Transcript${utteranceCount ? ` (${utteranceCount} messages)` : ''}
          </button>
        </div>
        <div id="transcript-full-${id}" style="display:none;margin-top:10px">`;

      if (t.speakers && t.speakers.length) {
        // Detect the primary speaker ("self") — prefer a named speaker over generic "Speaker"
        const speakerCounts = {};
        for (const s of t.speakers) { speakerCounts[s.speaker_name] = (speakerCounts[s.speaker_name]||0) + 1; }
        const sorted = Object.entries(speakerCounts).sort((a,b) => b[1]-a[1]);
        // If most-frequent is "Speaker"/"Unknown", pick the next named one as self
        const namedSpeakers = sorted.filter(([name]) => !/^(speaker|unknown)/i.test(name));
        const selfSpeaker = namedSpeakers.length > 0 ? namedSpeakers[0][0] : (sorted[0]?.[0] || '');

        bodyHtml += '<div class="transcript-chat">';
        let lastSpeaker = '';
        for (const s of t.speakers) {
          const isNew = s.speaker_name !== lastSpeaker;
          lastSpeaker = s.speaker_name;
          const isSelf = s.speaker_name === selfSpeaker;
          const timeLabel = s.spoken_at ? new Date(s.spoken_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
          bodyHtml += `
            ${isNew ? `<div class="chat-speaker${isSelf?' chat-speaker-self':''}">${esc(s.speaker_name)}${timeLabel ? ` <span class="chat-time">${timeLabel}</span>` : ''}</div>` : ''}
            <div class="chat-bubble${isSelf?' chat-self':''}">
              <div class="chat-text">${esc(s.text)}</div>
            </div>`;
        }
        bodyHtml += '</div>';
      } else if (t.raw_text) {
        bodyHtml += `<div style="font-size:0.85rem;white-space:pre-wrap;line-height:1.6;max-height:60vh;overflow-y:auto">${esc(t.raw_text)}</div>`;
      }
      bodyHtml += '</div>';
    } else if (!t.summary) {
      bodyHtml += `<div style="font-size:0.85rem;color:var(--text-dim);padding:16px 0">No transcript content available</div>`;
    }

    bodyHtml += `<div style="margin-top:16px"><button class="btn-action btn-action-danger" onclick="deleteTranscript('${id}')" style="width:100%">Delete</button></div>`;
    openModal(t.title, bodyHtml);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function deleteTranscript(id) {
  if (!confirm('Delete this transcript?')) return;
  try { await api(`/transcripts/${id}`, { method: 'DELETE' }); closeModal(); loadTranscripts(); } catch {}
}

async function identifySpeakers(id) {
  const btn = document.getElementById(`btn-identify-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
  try {
    const data = await api(`/transcripts/${id}/identify-speakers`, { method: 'POST' });
    const renames = data.renames || {};
    const ids = data.identifications || {};
    if (Object.keys(renames).length > 0) {
      if (btn) { btn.textContent = 'Done!'; btn.style.background = 'var(--green)'; }
      setTimeout(() => showTranscriptDetail(id), 800);
    } else {
      let msg = 'Could not confidently identify unknown speakers.\nTry "Re-identify with names" and provide the names of people in this conversation.';
      const notes = [];
      for (const [label, info] of Object.entries(ids)) {
        notes.push(`${label}: ${info.likely_name || '?'} (${info.confidence}) — ${info.reasoning || ''}`);
      }
      if (data.relationship_notes) notes.push(data.relationship_notes);
      if (notes.length) msg += '\n\n' + notes.join('\n');
      if (btn) { btn.textContent = 'No match'; btn.style.background = 'var(--yellow)'; btn.style.color = '#000'; }
      alert(msg);
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Error'; btn.style.background = 'var(--red)'; }
    alert('Speaker identification failed: ' + e.message);
  }
}

async function reIdentifyWithHints(id) {
  const names = prompt('Enter the names of people in this conversation (comma-separated):\ne.g. "Tyler, Gregg, Daniel, Craig"');
  if (!names) return;
  const known_names = names.split(',').map(n => n.trim()).filter(Boolean);
  if (!known_names.length) return;

  const btn = document.getElementById(`btn-rehint-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
  try {
    const data = await api(`/transcripts/${id}/identify-speakers-with-hints`, {
      method: 'POST', body: JSON.stringify({ known_names })
    });
    const renames = data.renames || {};
    if (Object.keys(renames).length > 0) {
      if (btn) { btn.textContent = 'Done!'; btn.style.background = 'var(--green)'; }
      setTimeout(() => showTranscriptDetail(id), 800);
    } else {
      if (btn) { btn.textContent = 'No match'; btn.style.background = 'var(--yellow)'; btn.style.color = '#000'; }
      alert('Could not match speakers to those names. You can manually rename speakers by tapping their name tags.');
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Error'; btn.style.background = 'var(--red)'; }
    alert('Re-identification failed: ' + e.message);
  }
}

async function renameSpeaker(id, oldName) {
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName === oldName) return;
  try {
    await api(`/transcripts/${id}/rename-speaker`, {
      method: 'POST', body: JSON.stringify({ old_name: oldName, new_name: newName })
    });
    showTranscriptDetail(id); // Refresh
  } catch (e) {
    alert('Rename failed: ' + e.message);
  }
}

// ─── Projects ─────────────────────────────────────────────────
async function loadProjects() {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const data = await api('/projects');

    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:1rem;font-weight:700">Projects</h2>
        <button class="btn-action" onclick="showNewProjectModal()" style="padding:6px 14px;font-size:0.8rem">+ Project</button>
      </div>
      <div id="projects-list">
        ${data.projects.length ? data.projects.map(p => {
          const tc = p.task_counts || {};
          const total = (tc.todo||0) + (tc.in_progress||0) + (tc.review||0) + (tc.done||0);
          const done = tc.done || 0;
          const pct = total > 0 ? Math.round(done / total * 100) : 0;
          return `
          <div class="list-item" onclick="showProjectDetail('${p.id}')">
            <div class="list-item-title">${esc(p.name)}</div>
            ${p.description ? `<div class="list-item-preview">${esc(p.description.substring(0, 100))}</div>` : ''}
            <div class="list-item-meta">
              <span class="status-badge status-${p.status}">${p.status}</span>
              <span>${total} tasks</span>
              ${total > 0 ? `<span>${pct}% done</span>` : ''}
            </div>
            ${total > 0 ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
          </div>`;
        }).join('') : '<div class="empty-state">No projects yet</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function showProjectDetail(id) {
  try {
    const p = await api(`/projects/${id}`);
    const tasks = p.tasks || [];
    const statuses = ['active', 'paused', 'completed', 'archived'];
    const doneTasks = tasks.filter(t => t.status === 'done').length;
    const pct = tasks.length ? Math.round(doneTasks / tasks.length * 100) : 0;

    openModal(p.name, `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <select onchange="updateProject('${id}', 'status', this.value)" style="background:var(--bg-input);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:0.8rem">
          ${statuses.map(s => `<option value="${s}" ${p.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
        <span style="font-size:0.75rem;color:var(--text-dim)">${timeAgo(p.created_at)}</span>
        ${tasks.length ? `<span style="font-size:0.75rem;color:var(--text-dim)">${pct}% done</span>` : ''}
      </div>
      ${p.description ? `<div style="font-size:0.85rem;margin-bottom:12px;color:var(--text-dim)">${esc(p.description)}</div>` : ''}
      ${tasks.length ? `<div class="progress-bar" style="margin-bottom:12px"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h4 style="font-size:0.85rem;color:var(--text-dim)">Tasks (${tasks.length})</h4>
        <button class="btn-action" onclick="closeModal();showNewTaskModal('${id}')" style="padding:4px 12px;font-size:0.75rem">+ Task</button>
      </div>
      ${tasks.length ? tasks.map(t => `
        <div onclick="closeModal();showTaskDetail('${t.id}')" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.82rem;cursor:pointer">
          <input type="checkbox" ${t.status==='done'?'checked':''} onclick="event.stopPropagation();toggleTaskDone('${t.id}','${t.status}','${id}')" style="cursor:pointer">
          <span style="flex:1;${t.status==='done'?'text-decoration:line-through;color:var(--text-dim)':''}">${esc(t.title)}</span>
          <span class="priority-badge priority-${t.priority}">${t.priority[0].toUpperCase()}</span>
        </div>`).join('') : '<div class="empty-state" style="padding:12px">No tasks yet — add one above</div>'}

      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn-action btn-action-danger" onclick="deleteProject('${id}')" style="flex:1">Delete Project</button>
      </div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function updateProject(id, field, value) {
  try { await api(`/projects/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); cachedProjects = []; } catch {}
}

async function toggleTaskDone(taskId, currentStatus, projectId) {
  const newStatus = currentStatus === 'done' ? 'todo' : 'done';
  try { await api(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) }); showProjectDetail(projectId); } catch {}
}

function showNewProjectModal() {
  openModal('New Project', `
    <form onsubmit="createProject(event)">
      <div class="form-group"><label>Name</label><input type="text" id="new-proj-name" required></div>
      <div class="form-group"><label>Description</label><textarea id="new-proj-desc" rows="3"></textarea></div>
      <button type="submit" class="btn-submit">Create Project</button>
    </form>
  `);
}

async function createProject(e) {
  e.preventDefault();
  try {
    await api('/projects', { method: 'POST', body: JSON.stringify({
      name: document.getElementById('new-proj-name').value,
      description: document.getElementById('new-proj-desc').value,
    }) });
    closeModal(); loadProjects();
  } catch (err) { alert(err.message); }
}

async function deleteProject(id) {
  if (!confirm('Delete this project and unlink its tasks?')) return;
  try { await api(`/projects/${id}`, { method: 'DELETE' }); closeModal(); loadProjects(); } catch {}
}

// ─── Sync helpers ─────────────────────────────────────────────

function renderActivityItem(log) {
  const icons = { create: '+', update: '~', delete: 'x', sync: '\u21BB' };
  return `<div class="activity-item">
    <div class="a-icon a-${log.action}">${icons[log.action]||'?'}</div>
    <div class="a-details"><div class="a-text">${esc(log.details||log.action)}</div>
    <div class="a-time">${log.ai_source?log.ai_source+' \u00B7 ':''}${timeAgo(log.created_at)}</div></div>
  </div>`;
}

// (Purge moved to confirmPurgeFromMenu in settings menu section)

// ─── Global Search ────────────────────────────────────────────
let searchDebounceTimer = null;
function openGlobalSearch() { document.getElementById('search-overlay').classList.add('open'); const i=document.getElementById('global-search-input'); i.value=''; i.focus(); document.getElementById('search-results').innerHTML=''; }
function closeGlobalSearch() { document.getElementById('search-overlay').classList.remove('open'); }

document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='k') { e.preventDefault(); openGlobalSearch(); }
  if (e.key==='Escape' && document.getElementById('search-overlay').classList.contains('open')) closeGlobalSearch();
});
document.getElementById('global-search-input').addEventListener('input', e => {
  clearTimeout(searchDebounceTimer); const q=e.target.value.trim(); if(!q){document.getElementById('search-results').innerHTML='';return;} if(q.length<2)return;
  searchDebounceTimer = setTimeout(() => runGlobalSearch(q), 300);
});
document.getElementById('global-search-input').addEventListener('keydown', e => { if(e.key==='Enter'){clearTimeout(searchDebounceTimer);const q=e.target.value.trim();if(q)runGlobalSearch(q);} });

async function runGlobalSearch(q) {
  const el = document.getElementById('search-results');
  el.innerHTML = '<div class="search-loading">Searching...</div>';
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}`);
    const r = data.results;
    if (data.total === 0) { el.innerHTML = '<div class="search-empty">No results</div>'; return; }
    let html = '';
    if (r.knowledge?.length) html += renderSearchGroup('Knowledge', r.knowledge, i => `<div class="search-result-item"><div class="search-result-title">${i.ai_source?`<span class="k-source-badge source-${i.ai_source}">${i.ai_source}</span>`:''}${highlightText(i.title,q)}</div><div class="search-result-preview">${searchSnippet(i.content||'',q)}</div></div>`);
    if (r.facts?.length) html += renderSearchGroup('Facts', r.facts, i => `<div class="search-result-item"><div class="search-result-title">${highlightText(i.title,q)}</div><div class="search-result-preview">${searchSnippet(i.content||'',q)}</div></div>`);
    if (r.transcripts?.length) html += renderSearchGroup('Transcripts', r.transcripts, i => `<div class="search-result-item"><div class="search-result-title">${highlightText(i.title,q)}</div><div class="search-result-preview">${searchSnippet(i.summary||'',q)}</div></div>`);
    if (r.tasks?.length) html += renderSearchGroup('Tasks', r.tasks, i => `<div class="search-result-item"><div class="search-result-title">${highlightText(i.title,q)}</div><div class="search-result-meta"><span>${i.status||''}</span><span>${i.priority||''}</span></div></div>`);
    if (r.projects?.length) html += renderSearchGroup('Projects', r.projects, i => `<div class="search-result-item"><div class="search-result-title">${highlightText(i.title||i.name,q)}</div></div>`);
    if (r.workouts?.length) html += renderSearchGroup('Workouts', r.workouts, i => `<div class="search-result-item" onclick="closeGlobalSearch();switchTab('workouts');setTimeout(()=>showWorkoutDetail('${i.id}'),300)"><div class="search-result-title">${highlightText(i.title,q)}</div><div class="search-result-meta"><span>${i.workout_type||''}</span><span>${i.workout_date||''}</span>${i.effort?`<span>Effort: ${i.effort}/10</span>`:''}</div></div>`);
    el.innerHTML = html || '<div class="search-empty">No results</div>';
  } catch (e) { el.innerHTML = `<div class="search-empty">${esc(e.message)}</div>`; }
}
function renderSearchGroup(label, items, fn) { return `<div class="search-group-label">${label} (${items.length})</div>` + items.map(fn).join(''); }

// Highlight search terms in text (safe: escapes HTML first, then wraps matches)
function highlightText(text, query) {
  if (!text || !query) return esc(text);
  const escaped = esc(text);
  const words = query.trim().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return escaped;
  const re = new RegExp('(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return escaped.replace(re, '<span class="search-highlight">$1</span>');
}

// Show a snippet of text centered around the first match, with highlighting
function searchSnippet(text, query, maxLen) {
  maxLen = maxLen || 200;
  if (!text || !query) return esc((text||'').substring(0, maxLen));
  const lower = text.toLowerCase();
  const words = query.trim().split(/\s+/).filter(w => w.length > 1);
  let matchIdx = -1;
  for (const w of words) { const idx = lower.indexOf(w.toLowerCase()); if (idx !== -1) { matchIdx = idx; break; } }
  let snippet;
  if (matchIdx === -1) {
    snippet = text.substring(0, maxLen);
  } else {
    const start = Math.max(0, matchIdx - 60);
    snippet = (start > 0 ? '...' : '') + text.substring(start, start + maxLen) + (start + maxLen < text.length ? '...' : '');
  }
  return highlightText(snippet, query);
}

// ─── Workouts ─────────────────────────────────────────────────
let workoutFilters = {};

function setWorkoutFilter(key, value) {
  if (!value) delete workoutFilters[key]; else workoutFilters[key] = value;
  loadWorkouts(workoutFilters._q || '');
}

async function loadWorkouts(searchQuery) {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (searchQuery) params.set('q', searchQuery);
    for (const [k, v] of Object.entries(workoutFilters)) {
      if (k !== '_q' && v) params.set(k, v);
    }
    const data = await api('/workouts?' + params.toString());
    const activeType = workoutFilters.workout_type || '';

    const typeColors = { hill: '#f59e0b', strength: '#ef4444', run: '#3b82f6', hybrid: '#8b5cf6', recovery: '#10b981', ruck: '#78716c' };

    main.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <input type="text" class="brain-search" placeholder="Search workouts..." value="${esc(searchQuery || '')}"
          oninput="debounceWorkoutSearch(this.value)" style="margin-bottom:0;flex:1;margin-right:8px">
        <button class="btn-submit" onclick="showWorkoutForm()" style="white-space:nowrap;padding:8px 16px">+ Log</button>
      </div>
      <div class="filter-row" style="margin-bottom:10px">
        <button class="filter-btn ${!activeType ? 'active' : ''}" onclick="workoutFilters={};loadWorkouts('')">All</button>
        ${['hill','strength','run','hybrid','recovery','ruck'].map(t =>
          `<button class="filter-btn ${activeType === t ? 'active' : ''}" onclick="setWorkoutFilter('workout_type', '${activeType === t ? '' : t}')"
            style="${activeType === t ? 'background:' + typeColors[t] + ';border-color:' + typeColors[t] : ''}">${t}</button>`
        ).join('')}
      </div>
      <div class="transcript-count">${data.total} workout${data.total !== 1 ? 's' : ''}</div>
      <div id="workout-list">
        ${data.workouts.length ? data.workouts.map(w => {
          const color = typeColors[w.workout_type] || '#6366f1';
          const d = new Date(w.workout_date);
          const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          return `
          <div class="list-item workout-card" onclick="showWorkoutDetail('${w.id}')" style="border-left:3px solid ${color}">
            <div class="transcript-card-header">
              <div class="list-item-title">${esc(w.title)}</div>
              <span class="content-type-badge" style="background:${color}22;color:${color}">${w.workout_type}</span>
              ${w.effort ? `<span class="effort-badge effort-${w.effort >= 8 ? 'high' : w.effort >= 5 ? 'med' : 'low'}">${w.effort}/10</span>` : ''}
            </div>
            ${w.focus ? `<div class="transcript-summary" style="-webkit-line-clamp:2">${esc(w.focus)}</div>` : ''}
            <div class="list-item-meta">
              <span>${dateLabel}</span>
              ${w.location ? `<span>${esc(w.location)}</span>` : ''}
              ${w.time_duration ? `<span>${esc(w.time_duration)}</span>` : ''}
              ${w.distance ? `<span>${esc(w.distance)}</span>` : ''}
              ${w.elevation_gain ? `<span>↑${esc(w.elevation_gain)}</span>` : ''}
            </div>
            ${w.tags && w.tags.length ? `<div class="transcript-speakers" style="margin-top:4px">${w.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join('')}</div>` : ''}
          </div>`;
        }).join('') : '<div class="empty-state">No workouts yet. Tap "+ Log" to add one!</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

let workoutSearchTimer = null;
function debounceWorkoutSearch(q) {
  workoutFilters._q = q;
  clearTimeout(workoutSearchTimer);
  workoutSearchTimer = setTimeout(() => loadWorkouts(q), 300);
}

async function showWorkoutDetail(id) {
  try {
    const w = await api(`/workouts/${id}`);
    const typeColors = { hill: '#f59e0b', strength: '#ef4444', run: '#3b82f6', hybrid: '#8b5cf6', recovery: '#10b981', ruck: '#78716c' };
    const color = typeColors[w.workout_type] || '#6366f1';
    const d = new Date(w.workout_date);
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    function section(label, value) {
      if (!value) return '';
      return `<div class="workout-detail-section"><div class="workout-detail-label">${label}</div><div class="workout-detail-value">${esc(value).replace(/\n/g, '<br>')}</div></div>`;
    }

    let html = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <span class="content-type-badge" style="background:${color}22;color:${color};font-size:0.75rem;padding:3px 12px">${w.workout_type}</span>
        <span style="font-size:0.8rem;color:var(--text-dim)">${dateLabel}</span>
        ${w.effort ? `<span class="effort-badge effort-${w.effort >= 8 ? 'high' : w.effort >= 5 ? 'med' : 'low'}" style="font-size:0.75rem;padding:3px 10px">Effort: ${w.effort}/10</span>` : ''}
      </div>

      ${w.location || w.elevation ? `<div class="workout-detail-section"><div class="workout-detail-label">Location</div><div class="workout-detail-value">${esc(w.location || '')}${w.elevation ? ' · Elev: ' + esc(w.elevation) : ''}</div></div>` : ''}

      ${section('Focus', w.focus)}

      ${w.warmup || w.main_sets || w.carries ? `
      <div class="workout-detail-section">
        <div class="workout-detail-label">Workout</div>
        <div class="workout-detail-value">
          ${w.warmup ? '<strong>Warm-up:</strong> ' + esc(w.warmup).replace(/\n/g, '<br>') + '<br>' : ''}
          ${w.main_sets ? '<strong>Main sets:</strong> ' + esc(w.main_sets).replace(/\n/g, '<br>') + '<br>' : ''}
          ${w.carries ? '<strong>Carries / lifts:</strong> ' + esc(w.carries).replace(/\n/g, '<br>') : ''}
        </div>
      </div>` : ''}

      ${w.time_duration || w.distance || w.elevation_gain ? `
      <div class="workout-detail-section">
        <div class="workout-detail-label">Metrics</div>
        <div class="workout-detail-value">
          ${w.time_duration ? '⏱ ' + esc(w.time_duration) + '<br>' : ''}
          ${w.distance ? '📏 ' + esc(w.distance) + '<br>' : ''}
          ${w.elevation_gain ? '⛰ ' + esc(w.elevation_gain) : ''}
        </div>
      </div>` : ''}

      ${w.slowdown_notes || w.failure_first ? `
      <div class="workout-detail-section">
        <div class="workout-detail-label">Performance</div>
        <div class="workout-detail-value">
          ${w.slowdown_notes ? '<strong>Slowed down:</strong> ' + esc(w.slowdown_notes).replace(/\n/g, '<br>') + '<br>' : ''}
          ${w.failure_first ? '<strong>Failed first:</strong> ' + esc(w.failure_first) : ''}
        </div>
      </div>` : ''}

      ${w.grip_feedback || w.legs_feedback || w.cardio_feedback || w.shoulder_feedback || w.body_notes ? `
      <div class="workout-detail-section">
        <div class="workout-detail-label">Body Feedback</div>
        <div class="workout-detail-value">
          ${w.grip_feedback ? '<strong>Grip:</strong> ' + esc(w.grip_feedback) + '<br>' : ''}
          ${w.legs_feedback ? '<strong>Legs:</strong> ' + esc(w.legs_feedback) + '<br>' : ''}
          ${w.cardio_feedback ? '<strong>Cardio:</strong> ' + esc(w.cardio_feedback) + '<br>' : ''}
          ${w.shoulder_feedback ? '<strong>Shoulder:</strong> ' + esc(w.shoulder_feedback) + '<br>' : ''}
          ${w.body_notes ? '<strong>Notes:</strong> ' + esc(w.body_notes).replace(/\n/g, '<br>') : ''}
        </div>
      </div>` : ''}

      ${section('Adjustment Next Time', w.adjustment)}

      ${w.tags && w.tags.length ? `<div class="transcript-speakers" style="margin-top:8px">${w.tags.map(t => `<span class="speaker-tag">${esc(t)}</span>`).join('')}</div>` : ''}

      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn-submit" onclick="showWorkoutForm('${w.id}')" style="flex:1">Edit</button>
        <button class="btn-action btn-action-danger" onclick="deleteWorkout('${w.id}')" style="flex:0.5">Delete</button>
      </div>
    `;

    openModal(w.title, html);
  } catch (e) {
    openModal('Error', `<div class="empty-state">${esc(e.message)}</div>`);
  }
}

async function showWorkoutForm(editId) {
  closeModal();
  let w = {};
  if (editId) {
    try { w = await api(`/workouts/${editId}`); } catch {}
  }
  const isEdit = !!editId;
  const today = new Date().toISOString().slice(0, 10);
  const tagsStr = (w.tags || []).join(', ');

  const html = `
    <div class="workout-form-scroll">
      <div class="form-group"><label>Title</label><input type="text" id="wf-title" value="${esc(w.title || '')}" placeholder="Spartan Workout – ${today} – HILL"></div>
      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Date</label><input type="date" id="wf-date" value="${w.workout_date ? w.workout_date.slice(0,10) : today}"></div>
        <div class="form-group" style="flex:1"><label>Type</label>
          <select id="wf-type">
            ${['hill','strength','run','hybrid','recovery','ruck'].map(t => `<option value="${t}" ${w.workout_type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Location</label><input type="text" id="wf-location" value="${esc(w.location || '')}" placeholder="Runyon Canyon"></div>
        <div class="form-group" style="flex:1"><label>Elevation</label><input type="text" id="wf-elevation" value="${esc(w.elevation || '')}" placeholder="1,320 ft"></div>
      </div>

      <div class="form-group"><label>Focus</label><textarea id="wf-focus" rows="2" placeholder="Hill durability, grip endurance...">${esc(w.focus || '')}</textarea></div>

      <div class="form-group"><label>Warm-up</label><textarea id="wf-warmup" rows="2" placeholder="Joint circles, band walks...">${esc(w.warmup || '')}</textarea></div>
      <div class="form-group"><label>Main Sets</label><textarea id="wf-main-sets" rows="3" placeholder="5x hill sprints, 3x sandbag carry...">${esc(w.main_sets || '')}</textarea></div>
      <div class="form-group"><label>Carries / Lifts</label><textarea id="wf-carries" rows="2" placeholder="Farmer carry 100m x3...">${esc(w.carries || '')}</textarea></div>

      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Time</label><input type="text" id="wf-time" value="${esc(w.time_duration || '')}" placeholder="45 min"></div>
        <div class="form-group" style="flex:1"><label>Distance</label><input type="text" id="wf-distance" value="${esc(w.distance || '')}" placeholder="3.2 mi"></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Elevation Gain</label><input type="text" id="wf-elev-gain" value="${esc(w.elevation_gain || '')}" placeholder="850 ft"></div>
        <div class="form-group" style="flex:1"><label>Effort (1-10)</label><input type="number" id="wf-effort" min="1" max="10" value="${w.effort || ''}"></div>
      </div>

      <div class="form-group"><label>Where did I slow down / break?</label><textarea id="wf-slowdown" rows="2">${esc(w.slowdown_notes || '')}</textarea></div>
      <div class="form-group"><label>What failed first?</label><input type="text" id="wf-failure" value="${esc(w.failure_first || '')}" placeholder="legs / grip / cardio"></div>

      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Grip</label><input type="text" id="wf-grip" value="${esc(w.grip_feedback || '')}" placeholder="solid / pumped / gave out"></div>
        <div class="form-group" style="flex:1"><label>Legs</label><input type="text" id="wf-legs" value="${esc(w.legs_feedback || '')}" placeholder="strong / heavy / cramped"></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Cardio</label><input type="text" id="wf-cardio" value="${esc(w.cardio_feedback || '')}" placeholder="steady / gasping / recovered fast"></div>
        <div class="form-group" style="flex:1"><label>Shoulder</label><input type="text" id="wf-shoulder" value="${esc(w.shoulder_feedback || '')}" placeholder="fine / tight / clicking"></div>
      </div>
      <div class="form-group"><label>Body Notes</label><textarea id="wf-body-notes" rows="2">${esc(w.body_notes || '')}</textarea></div>

      <div class="form-group"><label>Adjustment Next Time</label><textarea id="wf-adjustment" rows="2" placeholder="More hip mobility, slower carries...">${esc(w.adjustment || '')}</textarea></div>

      <div class="form-group"><label>Tags (comma separated)</label><input type="text" id="wf-tags" value="${esc(tagsStr)}" placeholder="#spartan #hill #carry"></div>

      <button class="btn-submit" onclick="saveWorkout('${editId || ''}')" style="width:100%;margin-top:8px">${isEdit ? 'Update Workout' : 'Save Workout'}</button>
    </div>
  `;

  openModal(isEdit ? 'Edit Workout' : 'Log Workout', html);
}

async function saveWorkout(editId) {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const tags = val('wf-tags').split(/[,\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean);

  const body = {
    title: val('wf-title') || undefined,
    workout_date: val('wf-date'),
    workout_type: val('wf-type'),
    location: val('wf-location') || null,
    elevation: val('wf-elevation') || null,
    focus: val('wf-focus') || null,
    warmup: val('wf-warmup') || null,
    main_sets: val('wf-main-sets') || null,
    carries: val('wf-carries') || null,
    time_duration: val('wf-time') || null,
    distance: val('wf-distance') || null,
    elevation_gain: val('wf-elev-gain') || null,
    effort: val('wf-effort') ? parseInt(val('wf-effort'), 10) : null,
    slowdown_notes: val('wf-slowdown') || null,
    failure_first: val('wf-failure') || null,
    grip_feedback: val('wf-grip') || null,
    legs_feedback: val('wf-legs') || null,
    cardio_feedback: val('wf-cardio') || null,
    shoulder_feedback: val('wf-shoulder') || null,
    body_notes: val('wf-body-notes') || null,
    adjustment: val('wf-adjustment') || null,
    tags: tags,
  };

  try {
    if (editId) {
      await api(`/workouts/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/workouts', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal();
    loadWorkouts(workoutFilters._q || '');
  } catch (e) {
    alert('Error saving workout: ' + e.message);
  }
}

async function deleteWorkout(id) {
  if (!confirm('Delete this workout?')) return;
  try {
    await api(`/workouts/${id}`, { method: 'DELETE' });
    closeModal();
    loadWorkouts(workoutFilters._q || '');
  } catch (e) { alert('Error: ' + e.message); }
}

// ─── Modal ────────────────────────────────────────────────────
function openModal(title, bodyHtml) { document.getElementById('modal-title').textContent=title; document.getElementById('modal-body').innerHTML=bodyHtml; document.getElementById('modal-overlay').classList.add('open'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

// ─── Utilities ────────────────────────────────────────────────
function esc(str) { if(!str)return''; const d=document.createElement('div'); d.textContent=String(str); return d.innerHTML; }

function formatBeeSummary(text) {
  if (!text) return '';
  // Convert Bee markdown-style summaries into formatted HTML sections
  return esc(text)
    .replace(/^# (.+)$/gm, '<div style="font-weight:700;font-size:0.9rem;margin-top:12px;margin-bottom:4px;color:var(--accent)">$1</div>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:2px 0">• $1</div>')
    .replace(/\n\n/g, '<div style="height:8px"></div>')
    .replace(/\n/g, '<br>');
}
function timeAgo(dateStr) {
  if(!dateStr)return'';
  const diff=(new Date()-new Date(dateStr))/1000;
  if(diff<60)return'just now'; if(diff<3600)return`${Math.floor(diff/60)}m ago`;
  if(diff<86400)return`${Math.floor(diff/3600)}h ago`; if(diff<604800)return`${Math.floor(diff/86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ─── Init ─────────────────────────────────────────────────────
(async function init() {
  const key = getStoredKey();
  if (!key) { showLogin(); return; }
  try {
    const test = await fetch(API + '/dashboard', { headers: { 'X-Api-Key': key } });
    if (test.status === 401) { sessionStorage.removeItem('ab_api_key'); localStorage.removeItem('ab_api_key'); showLogin('API key expired.'); return; }
  } catch {}
  hideLogin();
  switchTab('home');

  // Set default dates for conversation sync
  const convStart = document.getElementById('sm-conv-start');
  const convEnd = document.getElementById('sm-conv-end');
  if (convStart) convStart.value = '2025-12-01';
  if (convEnd) convEnd.value = new Date().toISOString().split('T')[0];

  // Auto-refresh on app resume
  document.addEventListener('visibilitychange', () => { if (!document.hidden && getStoredKey()) switchTab(currentTab); });
})();
