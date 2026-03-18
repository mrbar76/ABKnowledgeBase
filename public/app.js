// --- AB Brain — Full SPA with bottom tabs ---

const API = '/api';
let currentTab = 'home';
let cachedProjects = []; // cached for dropdowns

// ─── Theme Management ─────────────────────────────────────────
function getThemeMode() { return localStorage.getItem('ab_theme') || 'auto'; }

function applyCurrentTheme() {
  const mode = getThemeMode();
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  updateThemeButtons(mode);
}

function setTheme(mode) {
  if (mode === 'auto') localStorage.removeItem('ab_theme');
  else localStorage.setItem('ab_theme', mode);
  applyCurrentTheme();
}

function updateThemeButtons(mode) {
  ['light', 'auto', 'dark'].forEach(t => {
    const btn = document.getElementById('theme-btn-' + t);
    if (!btn) return;
    const active = t === mode;
    btn.style.background = active ? 'var(--bg-card-solid)' : 'none';
    btn.style.color = active ? 'var(--text)' : 'var(--text-dim)';
    btn.style.boxShadow = active ? '0 1px 4px rgba(0,0,0,0.15)' : 'none';
    btn.style.fontWeight = active ? '600' : '500';
  });
}

// Apply theme immediately before any rendering
applyCurrentTheme();
// Re-apply if system preference changes and user is on Auto
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getThemeMode() === 'auto') applyCurrentTheme();
});

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

// ─── Toast Notification System ────────────────────────────────
function showToast(message, type = 'error', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { error: '\u26A0\uFE0F', success: '\u2705', warning: '\u26A0\uFE0F', info: '\u2139\uFE0F' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-message">${esc(message)}</span><button class="toast-close" onclick="this.parentElement.classList.add('toast-exit');setTimeout(()=>this.parentElement.remove(),200)">\u00D7</button>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 200); }, duration);
}

// ─── Animated Counter ─────────────────────────────────────────
function animateValue(el, end, duration = 600) {
  const start = parseInt(el.textContent) || 0;
  if (start === end) return;
  const range = end - start;
  const startTime = performance.now();
  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    el.textContent = Math.round(start + range * eased);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ─── Pull-to-Refresh ─────────────────────────────────────────
let _ptrStartY = 0, _ptrActive = false;
document.addEventListener('touchstart', e => { if (window.scrollY === 0) _ptrStartY = e.touches[0].clientY; else _ptrStartY = 0; }, { passive: true });
document.addEventListener('touchmove', e => {
  if (_ptrStartY && e.touches[0].clientY - _ptrStartY > 80 && !_ptrActive) {
    _ptrActive = true;
    const ind = document.getElementById('ptr-indicator');
    if (ind) ind.classList.add('active');
    switchTab(currentTab);
    setTimeout(() => { if (ind) ind.classList.remove('active'); _ptrActive = false; }, 1200);
  }
}, { passive: true });
document.addEventListener('touchend', () => { _ptrStartY = 0; }, { passive: true });

// ─── Tab Navigation ───────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const main = document.getElementById('main-content');
  main.scrollTop = 0;
  // Re-trigger fade-in animation on tab switch
  main.style.animation = 'none';
  main.offsetHeight; // force reflow
  main.style.animation = '';

  // Map legacy fitness sub-tab names to the unified fitness tab
  if (['workouts', 'nutrition', 'body', 'training'].includes(tab)) {
    fitnessSubTab = tab;
    tab = 'fitness';
    currentTab = 'fitness';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'fitness'));
  }

  if (tab === 'home') loadDashboard();
  else if (tab === 'kanban') loadKanban();
  else if (tab === 'brain') loadBrain();
  else if (tab === 'transcripts') loadTranscripts();
  else if (tab === 'projects') loadProjects();
  else if (tab === 'fitness') loadFitness();
}

// ─── Dashboard (Home) ─────────────────────────────────────────

function skeletonStats(n) {
  return Array(n).fill('<div class="skeleton-stat"><div class="skeleton skeleton-stat-value"></div><div class="skeleton skeleton-stat-label"></div></div>').join('');
}
function skeletonCards(n) {
  return Array(n).fill('<div class="skeleton-card"><div class="skeleton skeleton-line skeleton-line-lg"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line skeleton-line-sm"></div></div>').join('');
}

async function loadDashboard() {
  const main = document.getElementById('main-content');
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  main.innerHTML = `
    <div class="dash-greeting">${greeting}.</div>
    <div class="dash-date">${dateStr}</div>
    <div id="dash-content">
      <div class="dash-section">
        <div class="dash-section-header">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z"/></svg>
          Fitness
        </div>
        <div class="stats-grid">${skeletonStats(6)}</div>
      </div>
      <div class="dash-section">
        <div class="dash-section-header">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
          Knowledge &amp; Tasks
        </div>
        <div class="stats-grid">${skeletonStats(5)}</div>
      </div>
    </div>
  `;

  loadDashboardStats();
}

async function loadDashboardStats() {
  try {
    const data = await api('/dashboard');
    const totalTasks = Object.values(data.tasks.by_status).reduce((a, b) => a + b, 0);
    const inProgress = data.tasks.by_status.in_progress || 0;
    const container = document.getElementById('dash-content');
    if (!container) return;

    const activeInjuries = data.training?.injuries?.active || 0;

    const fitnessCards = [
      { label: 'Workouts', value: data.workouts?.total || 0, color: '#22c55e', icon: '\u{1F3CB}', sub: 'workouts' },
      { label: 'Meals', value: data.meals?.total || 0, color: '#f97316', icon: '\u{1F34E}', sub: 'nutrition' },
      { label: 'Body Metrics', value: data.body_metrics?.total || 0, color: '#3b82f6', icon: '\u{1F4CF}', sub: 'body' },
    ];
    if (data.training) {
      fitnessCards.push(
        { label: 'Active Plans', value: data.training.plans?.active || 0, color: '#a855f7', icon: '\u{1F4CB}', sub: 'training' },
        { label: 'Coaching', value: data.training.coaching_sessions?.total || 0, color: '#06b6d4', icon: '\u{1F9D1}\u{200D}\u{1F3EB}', sub: 'training' },
        { label: 'Injuries', value: activeInjuries, color: activeInjuries > 0 ? '#ef4444' : '#6b7280', icon: '\u{1FA79}', sub: 'training' },
      );
    }

    const knowledgeCards = [
      { label: 'Knowledge', value: data.knowledge.total, color: '#818cf8', icon: '\u{1F9E0}', tab: 'brain' },
      { label: 'Transcripts', value: data.transcripts.total, color: '#f59e0b', icon: '\u{1F399}', tab: 'transcripts' },
      { label: 'Tasks', value: totalTasks, color: '#3b82f6', icon: '\u2705', tab: 'kanban' },
      { label: 'In Progress', value: inProgress, color: '#f97316', icon: '\u{1F525}', tab: 'kanban' },
      { label: 'Projects', value: data.projects.active, color: '#22c55e', icon: '\u{1F4C1}', tab: 'projects' },
    ];

    function renderRingCard(c, onclick) {
      return `<div class="ring-card clickable" onclick="${onclick}">
        <div class="ring-icon" style="background:${c.color}18;color:${c.color}">${c.icon}</div>
        <div class="ring-value" style="color:${c.color}" data-target="${c.value}">0</div>
        <div class="ring-label">${c.label}</div>
      </div>`;
    }

    container.innerHTML = `
      <div class="dash-section fade-in stagger-1" onclick="switchTab('fitness')" style="cursor:pointer">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:#22c55e18;color:#22c55e">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z"/></svg>
            Fitness
          </div>
        </div>
        <div class="ring-grid">${fitnessCards.map(c => renderRingCard(c, `event.stopPropagation();fitnessSubTab='${c.sub}';switchTab('fitness')`)).join('')}</div>
      </div>

      <div class="dash-section fade-in stagger-2">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:#818cf818;color:#818cf8">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            Knowledge &amp; Tasks
          </div>
        </div>
        <div class="ring-grid">${knowledgeCards.map(c => renderRingCard(c, `switchTab('${c.tab}')`)).join('')}</div>
      </div>

      <div class="card fade-in stagger-3" id="activity-card" style="display:none">
        <div class="activity-header clickable" onclick="toggleActivity()">
          <h2>Recent Activity</h2>
          <svg id="activity-chevron" viewBox="0 0 24 24" width="16" height="16" style="color:var(--text-dim);transition:transform 0.2s"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        </div>
        <div id="recent-activity" class="activity-body collapsed"></div>
      </div>
    `;
    // Animate all stat values
    document.querySelectorAll('#dash-content [data-target]').forEach(el => {
      animateValue(el, parseInt(el.dataset.target) || 0);
    });
    if (data.recent_activity?.length) {
      const ac = document.getElementById('activity-card');
      if (ac) { ac.style.display = ''; document.getElementById('recent-activity').innerHTML = data.recent_activity.map(renderActivityItem).join(''); }
    }
  } catch (e) {
    if (e.message === 'Unauthorized') return;
    const container = document.getElementById('dash-content');
    if (container) container.innerHTML = '<div class="empty-state">Could not load stats</div>';
  }
}

// ─── Settings Menu (logo tap) ────────────────────────────────
function toggleSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  if (menu.classList.contains('open')) { closeSettingsMenu(); return; }
  menu.classList.add('open');
  loadSettingsMenuInfo();
  updateThemeButtons(getThemeMode());
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
  main.innerHTML = skeletonCards(2);
  try {
    const data = await api('/tasks/kanban');
    const cols = ['todo', 'in_progress', 'review', 'done'];
    const labels = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
    const colors = { todo: 'var(--text-dim)', in_progress: 'var(--blue)', review: 'var(--yellow)', done: 'var(--green)' };

    main.innerHTML = `
      <div class="flex-between mb-md">
        <h2 class="section-title">Kanban Board</h2>
        <button class="btn-action btn-compact-sm" onclick="showNewTaskModal()">+ Task</button>
      </div>
      <div class="kanban-board">${cols.map(col => `
        <div class="kanban-col" data-status="${col}">
          <div class="kanban-col-header" style="border-bottom-color:${colors[col]}">
            <span>${labels[col]}</span>
            <span class="kanban-count">${(data[col] || []).length}</span>
          </div>
          <div class="kanban-col-body" ondragover="kanbanDragOver(event)" ondrop="kanbanDrop(event)">
            ${(data[col] || []).map(t => `
              <div class="kanban-card" draggable="true"
                ondragstart="kanbanDragStart(event,'${t.id}')" ondragend="kanbanDragEnd(event)"
                ontouchstart="kanbanTouchStart(event,'${t.id}')" ontouchmove="kanbanTouchMove(event)" ontouchend="kanbanTouchEnd(event)"
                onclick="if(!_touchMoved)showTaskDetail('${t.id}')">
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

// ─── Kanban Drag & Drop ──────────────────────────────────────
let _dragTaskId = null;
let _dragGhost = null;
let _touchStartX = 0, _touchStartY = 0, _touchMoved = false;

function kanbanDragStart(e, taskId) {
  _dragTaskId = taskId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', taskId);
  e.target.classList.add('kanban-card-dragging');
  // Highlight drop zones
  setTimeout(() => document.querySelectorAll('.kanban-col-body').forEach(c => c.classList.add('kanban-drop-zone')), 0);
}
function kanbanDragEnd(e) {
  e.target.classList.remove('kanban-card-dragging');
  document.querySelectorAll('.kanban-col-body').forEach(c => { c.classList.remove('kanban-drop-zone', 'kanban-drop-hover'); });
  _dragTaskId = null;
}
function kanbanDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const zone = e.target.closest('.kanban-col-body');
  if (zone) {
    document.querySelectorAll('.kanban-col-body').forEach(c => c.classList.remove('kanban-drop-hover'));
    zone.classList.add('kanban-drop-hover');
  }
}
function kanbanDrop(e) {
  e.preventDefault();
  const zone = e.target.closest('.kanban-col-body');
  if (!zone || !_dragTaskId) return;
  const col = zone.closest('.kanban-col');
  const status = col?.dataset.status;
  if (status) {
    updateTask(_dragTaskId, 'status', status);
    showToast(`Moved to ${status.replace('_', ' ')}`, 'success', 2000);
  }
  document.querySelectorAll('.kanban-col-body').forEach(c => { c.classList.remove('kanban-drop-zone', 'kanban-drop-hover'); });
  _dragTaskId = null;
}

// Touch-based drag for mobile
function kanbanTouchStart(e, taskId) {
  const touch = e.touches[0];
  _touchStartX = touch.clientX;
  _touchStartY = touch.clientY;
  _touchMoved = false;
  _dragTaskId = taskId;
}
function kanbanTouchMove(e) {
  if (!_dragTaskId) return;
  const touch = e.touches[0];
  const dx = Math.abs(touch.clientX - _touchStartX);
  const dy = Math.abs(touch.clientY - _touchStartY);
  if (dx > 10 || dy > 10) _touchMoved = true;
  if (!_touchMoved) return;
  e.preventDefault();

  if (!_dragGhost) {
    const card = e.target.closest('.kanban-card');
    if (!card) return;
    _dragGhost = card.cloneNode(true);
    _dragGhost.classList.add('kanban-ghost');
    _dragGhost.style.width = card.offsetWidth + 'px';
    document.body.appendChild(_dragGhost);
    card.classList.add('kanban-card-dragging');
    document.querySelectorAll('.kanban-col-body').forEach(c => c.classList.add('kanban-drop-zone'));
  }
  _dragGhost.style.left = (touch.clientX - 40) + 'px';
  _dragGhost.style.top = (touch.clientY - 20) + 'px';

  // Highlight target column
  document.querySelectorAll('.kanban-col-body').forEach(c => c.classList.remove('kanban-drop-hover'));
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const zone = el?.closest('.kanban-col-body');
  if (zone) zone.classList.add('kanban-drop-hover');
}
function kanbanTouchEnd(e) {
  if (!_dragTaskId) return;
  if (_touchMoved && _dragGhost) {
    const touch = e.changedTouches[0];
    // Temporarily hide ghost to find element below
    _dragGhost.style.display = 'none';
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    _dragGhost.style.display = '';
    const zone = el?.closest('.kanban-col-body');
    const status = zone?.closest('.kanban-col')?.dataset.status;
    if (status) {
      updateTask(_dragTaskId, 'status', status);
      showToast(`Moved to ${status.replace('_', ' ')}`, 'success', 2000);
    }
  }
  if (_dragGhost) { _dragGhost.remove(); _dragGhost = null; }
  document.querySelectorAll('.kanban-card-dragging').forEach(c => c.classList.remove('kanban-card-dragging'));
  document.querySelectorAll('.kanban-col-body').forEach(c => { c.classList.remove('kanban-drop-zone', 'kanban-drop-hover'); });
  _dragTaskId = null;
  _touchMoved = false;
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
  } catch (err) { showToast(err.message); }
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
  } catch (e) { showToast(e.message); }
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
  } catch (err) { showToast(err.message); }
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
      showToast(msg, 'success');
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Error'; btn.style.background = 'var(--red)'; }
    showToast('Speaker identification failed: ' + e.message);
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
      showToast('Could not match speakers to those names. You can manually rename speakers by tapping their name tags.', 'warning');
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Error'; btn.style.background = 'var(--red)'; }
    showToast('Re-identification failed: ' + e.message);
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
    showToast('Rename failed: ' + e.message);
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
  } catch (err) { showToast(err.message); }
}

async function deleteProject(id) {
  if (!confirm('Delete this project and unlink its tasks?')) return;
  try { await api(`/projects/${id}`, { method: 'DELETE' }); closeModal(); loadProjects(); } catch {}
}

// ─── Sync helpers ─────────────────────────────────────────────

function toggleActivity() {
  const body = document.getElementById('recent-activity');
  const chevron = document.getElementById('activity-chevron');
  if (!body) return;
  body.classList.toggle('collapsed');
  if (chevron) chevron.style.transform = body.classList.contains('collapsed') ? '' : 'rotate(180deg)';
}

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
    if (r.meals?.length) html += renderSearchGroup('Meals', r.meals, i => `<div class="search-result-item" onclick="closeGlobalSearch();switchTab('nutrition');setTimeout(()=>showMealDetail('${i.id}'),300)"><div class="search-result-title">${highlightText(i.title,q)}</div><div class="search-result-meta"><span>${i.meal_type||''}</span><span>${i.meal_date||''}</span>${i.calories?`<span>${i.calories} cal</span>`:''}</div></div>`);
    if (r.body_metrics?.length) html += renderSearchGroup('Body Metrics', r.body_metrics, i => `<div class="search-result-item" onclick="closeGlobalSearch();switchTab('body');setTimeout(()=>showBodyMetricDetail('${i.id}'),300)"><div class="search-result-title">${i.weight_lb}lb — ${i.measurement_date||''}</div><div class="search-result-meta"><span>${i.source||'RENPHO'}</span>${i.body_fat_pct?`<span>BF: ${i.body_fat_pct}%</span>`:''}</div></div>`);
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

// ─── Fitness (unified tab) ────────────────────────────────────
let fitnessSubTab = 'workouts';

function loadFitness() {
  const main = document.getElementById('main-content');
  const tabs = [
    { key: 'workouts', label: 'Workouts', icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z"/></svg>' },
    { key: 'nutrition', label: 'Nutrition', icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M18.06 22.99h1.66c.84 0 1.53-.64 1.63-1.46L23 5.05h-5V1h-1.97v4.05h-4.97l.3 2.34c1.71.47 3.31 1.32 4.27 2.26 1.44 1.42 2.43 2.89 2.43 5.29v8.05zM1 21.99V21h15.03v.99c0 .55-.45 1-1.01 1H2.01c-.56 0-1.01-.45-1.01-1zm15.03-7c0-4.5-6.83-5-9.52-5C3.92 9.99 1 10.99 1 14.99h15.03zm-15.03 2h15.03v2H1v-2z"/></svg>' },
    { key: 'body', label: 'Body', icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm9 7h-6v13h-2v-6h-2v6H9V9H3V7h18v2z"/></svg>' },
    { key: 'training', label: 'Training', icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 7h2v2h-2V7zm0 4h2v6h-2v-6zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>' },
  ];
  main.innerHTML = `
    <div class="fitness-tabs">
      ${tabs.map(t => `<button class="fitness-tab ${fitnessSubTab === t.key ? 'active' : ''}" onclick="fitnessSubTab='${t.key}';loadFitness()">${t.icon}<span>${t.label}</span></button>`).join('')}
    </div>
    <div id="fitness-content"></div>
  `;
  if (fitnessSubTab === 'workouts') loadWorkouts();
  else if (fitnessSubTab === 'nutrition') loadNutrition();
  else if (fitnessSubTab === 'body') loadBodyMetrics();
  else if (fitnessSubTab === 'training') loadTraining();
}

// ─── Workouts ─────────────────────────────────────────────────
let workoutFilters = {};

function setWorkoutFilter(key, value) {
  if (!value) delete workoutFilters[key]; else workoutFilters[key] = value;
  loadWorkouts(workoutFilters._q || '');
}

async function loadWorkouts(searchQuery) {
  const main = document.getElementById('fitness-content') || document.getElementById('main-content');
  main.innerHTML = skeletonCards(4);
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
      <div class="list-search-row">
        <input type="text" class="brain-search" placeholder="Search workouts..." value="${esc(searchQuery || '')}"
          oninput="debounceWorkoutSearch(this.value)">
        <button class="btn-submit btn-secondary btn-compact-sm" onclick="showWorkoutImport()">Import</button>
        <button class="btn-submit btn-compact" onclick="showWorkoutForm()">+ Log</button>
      </div>
      <div class="filter-row mb-md">
        <button class="filter-btn ${!activeType ? 'active' : ''}" onclick="workoutFilters={};loadWorkouts('')">All</button>
        ${['hill','strength','run','hybrid','recovery','ruck'].map(t =>
          `<button class="filter-btn ${activeType === t ? 'active' : ''}" onclick="setWorkoutFilter('workout_type', '${activeType === t ? '' : t}')"
            style="${activeType === t ? 'background:' + typeColors[t] + ';border-color:' + typeColors[t] : ''}">${t}</button>`
        ).join('')}
      </div>
      <div class="transcript-count">${data.total} workout${data.total !== 1 ? 's' : ''}</div>
      <div id="workout-list" class="fade-in">
        ${data.workouts.length ? data.workouts.map(w => {
          const color = typeColors[w.workout_type] || '#6366f1';
          const d = new Date(w.workout_date.slice(0,10) + 'T12:00:00');
          const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          return `
          <div class="list-item workout-card" onclick="showWorkoutDetail('${w.id}')" style="border-left:3px solid ${color}">
            <div class="transcript-card-header">
              <div class="list-item-title">${esc(w.title)}</div>
              <span class="badge-dynamic" style="background:${color}22;color:${color}">${w.workout_type}</span>
              ${w.effort ? `<span class="effort-badge effort-${w.effort >= 8 ? 'high' : w.effort >= 5 ? 'med' : 'low'}">${w.effort}/10</span>` : ''}
            </div>
            ${w.focus ? `<div class="transcript-summary" style="-webkit-line-clamp:2">${esc(w.focus)}</div>` : ''}
            <div class="list-item-meta">
              <span>${dateLabel}</span>
              ${w.location ? `<span>${esc(w.location)}</span>` : ''}
              ${w.time_duration ? `<span>${esc(w.time_duration)}</span>` : ''}
              ${w.distance ? `<span>${esc(w.distance)}</span>` : ''}
              ${w.elevation_gain ? `<span>↑${esc(w.elevation_gain)}</span>` : ''}
              ${w.heart_rate_avg ? `<span>♥${esc(w.heart_rate_avg)}</span>` : ''}
              ${w.active_calories ? `<span>${esc(w.active_calories)}</span>` : ''}
            </div>
            ${w.tags && w.tags.length ? `<div class="transcript-speakers mt-sm">${w.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join('')}</div>` : ''}
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
    const d = new Date(w.workout_date.slice(0,10) + 'T12:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    function section(label, value) {
      if (!value) return '';
      return `<div class="workout-detail-section"><div class="workout-detail-label">${label}</div><div class="workout-detail-value">${esc(value).replace(/\n/g, '<br>')}</div></div>`;
    }

    let html = `
      <div class="flex-row-wrap mb-md">
        <span class="badge-dynamic badge-lg" style="background:${color}22;color:${color}">${w.workout_type}</span>
        <span class="text-meta">${dateLabel}</span>
        ${w.effort ? `<span class="effort-badge effort-${w.effort >= 8 ? 'high' : w.effort >= 5 ? 'med' : 'low'} badge-lg">Effort: ${w.effort}/10</span>` : ''}
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

      ${w.time_duration || w.distance || w.elevation_gain || w.heart_rate_avg || w.heart_rate_max || w.pace_avg || w.cadence_avg || w.active_calories || w.total_calories || w.splits ? `
      <div class="workout-detail-section">
        <div class="workout-detail-label">Metrics</div>
        <div class="workout-detail-value">
          ${w.time_duration ? '<strong>Duration:</strong> ' + esc(w.time_duration) + '<br>' : ''}
          ${w.distance ? '<strong>Distance:</strong> ' + esc(w.distance) + '<br>' : ''}
          ${w.elevation_gain ? '<strong>Elevation gain:</strong> ' + esc(w.elevation_gain) + '<br>' : ''}
          ${w.pace_avg ? '<strong>Avg pace:</strong> ' + esc(w.pace_avg) + '<br>' : ''}
          ${w.cadence_avg ? '<strong>Cadence:</strong> ' + esc(w.cadence_avg) + '<br>' : ''}
          ${w.heart_rate_avg ? '<strong>Avg HR:</strong> ' + esc(w.heart_rate_avg) + '<br>' : ''}
          ${w.heart_rate_max ? '<strong>Max HR:</strong> ' + esc(w.heart_rate_max) + '<br>' : ''}
          ${w.active_calories ? '<strong>Active cal:</strong> ' + esc(w.active_calories) + '<br>' : ''}
          ${w.total_calories ? '<strong>Total cal:</strong> ' + esc(w.total_calories) + '<br>' : ''}
          ${w.splits ? '<strong>Splits:</strong><br>' + esc(w.splits).replace(/\n/g, '<br>') : ''}
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

      ${w.tags && w.tags.length ? `<div class="transcript-speakers mt-sm">${w.tags.map(t => `<span class="speaker-tag">${esc(t)}</span>`).join('')}</div>` : ''}

      <div class="action-row">
        <button class="btn-submit flex-1" onclick="showWorkoutForm('${w.id}')">Edit</button>
        <button class="btn-action btn-action-danger flex-half" onclick="deleteWorkout('${w.id}')">Delete</button>
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
      <div class="flex-row">
        <div class="form-group flex-1"><label>Date</label><input type="date" id="wf-date" value="${w.workout_date ? w.workout_date.slice(0,10) : today}"></div>
        <div class="form-group flex-1"><label>Type</label>
          <select id="wf-type">
            ${['hill','strength','run','hybrid','recovery','ruck'].map(t => `<option value="${t}" ${w.workout_type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="flex-row">
        <div class="form-group flex-1"><label>Location</label><input type="text" id="wf-location" value="${esc(w.location || '')}" placeholder="Runyon Canyon"></div>
        <div class="form-group flex-1"><label>Elevation</label><input type="text" id="wf-elevation" value="${esc(w.elevation || '')}" placeholder="1,320 ft"></div>
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
      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Avg HR</label><input type="text" id="wf-hr-avg" value="${esc(w.heart_rate_avg || '')}" placeholder="135 bpm"></div>
        <div class="form-group" style="flex:1"><label>Max HR</label><input type="text" id="wf-hr-max" value="${esc(w.heart_rate_max || '')}" placeholder="172 bpm"></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Avg Pace</label><input type="text" id="wf-pace" value="${esc(w.pace_avg || '')}" placeholder="9:30 /mi"></div>
        <div class="form-group" style="flex:1"><label>Cadence</label><input type="text" id="wf-cadence" value="${esc(w.cadence_avg || '')}" placeholder="160 spm"></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-group" style="flex:1"><label>Active Cal</label><input type="text" id="wf-active-cal" value="${esc(w.active_calories || '')}" placeholder="284 kcal"></div>
        <div class="form-group" style="flex:1"><label>Total Cal</label><input type="text" id="wf-total-cal" value="${esc(w.total_calories || '')}" placeholder="346 kcal"></div>
      </div>
      <div class="form-group"><label>Splits</label><textarea id="wf-splits" rows="2" placeholder="Mile 1: 8:20 @ 140 bpm&#10;Mile 2: 8:45 @ 155 bpm">${esc(w.splits || '')}</textarea></div>

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
    heart_rate_avg: val('wf-hr-avg') || null,
    heart_rate_max: val('wf-hr-max') || null,
    pace_avg: val('wf-pace') || null,
    cadence_avg: val('wf-cadence') || null,
    active_calories: val('wf-active-cal') || null,
    total_calories: val('wf-total-cal') || null,
    splits: val('wf-splits') || null,
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
    showToast('Error saving workout: ' + e.message);
  }
}

async function deleteWorkout(id) {
  if (!confirm('Delete this workout?')) return;
  try {
    await api(`/workouts/${id}`, { method: 'DELETE' });
    closeModal();
    loadWorkouts(workoutFilters._q || '');
  } catch (e) { showToast('Error: ' + e.message); }
}

// ─── Nutrition (Meals + Daily Context + Summary) ──────────────
let nutritionDate = new Date().toISOString().slice(0, 10);

async function loadNutrition(date) {
  if (date) nutritionDate = date;
  const main = document.getElementById('fitness-content') || document.getElementById('main-content');
  main.innerHTML = skeletonCards(3);
  try {
    const summary = await api(`/nutrition/daily-summary?date=${nutritionDate}`);
    const d = new Date(nutritionDate + 'T12:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const ctx = summary.context;

    const mealTypeColors = {
      breakfast: '#f59e0b', lunch: '#3b82f6', dinner: '#8b5cf6', snack: '#10b981',
      'pre-workout': '#ef4444', 'post-workout': '#06b6d4', drink: '#64748b', supplement: '#ec4899', meal: '#6366f1',
    };

    main.innerHTML = `
      <div class="flex-between mb-sm">
        <button class="btn-action btn-icon" onclick="loadNutrition(shiftDate(nutritionDate,-1))">&lt;</button>
        <div class="text-center flex-1">
          <input type="date" value="${nutritionDate}" onchange="loadNutrition(this.value)"
            style="background:transparent;border:none;color:var(--text);font-size:1rem;text-align:center;cursor:pointer">
          <div class="text-micro">${dateLabel}</div>
        </div>
        <button class="btn-action btn-icon" onclick="loadNutrition(shiftDate(nutritionDate,1))">&gt;</button>
      </div>

      <div class="macro-grid">
        <div class="stat-card"><div class="stat-value">${summary.total_calories}</div><div class="stat-label">Calories</div></div>
        <div class="stat-card"><div class="stat-value">${summary.total_protein_g}g</div><div class="stat-label">Protein</div></div>
        <div class="stat-card"><div class="stat-value">${summary.total_carbs_g}g</div><div class="stat-label">Carbs</div></div>
        <div class="stat-card"><div class="stat-value">${summary.total_fat_g}g</div><div class="stat-label">Fat</div></div>
      </div>

      ${ctx ? `
      <div class="card mb-md" style="padding:10px;font-size:0.8rem">
        <div class="flex-between mb-xs">
          <strong>Daily Context</strong>
          ${ctx.day_type ? `<span class="badge-dynamic" style="background:#f59e0b22;color:#f59e0b">${ctx.day_type}</span>` : ''}
          <button class="btn-action btn-compact-sm" onclick="showDailyContextForm('${nutritionDate}','${ctx.id}')" style="padding:2px 8px;font-size:0.7rem">Edit</button>
        </div>
        <div class="flex-row-wrap text-dim">
          ${ctx.energy_rating ? `<span>Energy: ${ctx.energy_rating}/10</span>` : ''}
          ${ctx.hunger_rating ? `<span>Hunger: ${ctx.hunger_rating}/10</span>` : ''}
          ${ctx.hydration_liters ? `<span>Water: ${ctx.hydration_liters}L</span>` : ''}
          ${ctx.sleep_hours ? `<span>Sleep: ${ctx.sleep_hours}h</span>` : ''}
          ${ctx.sleep_quality ? `<span>Sleep Q: ${ctx.sleep_quality}/10</span>` : ''}
          ${ctx.recovery_rating ? `<span>Recovery: ${ctx.recovery_rating}/10</span>` : ''}
          ${ctx.body_weight_lb ? `<span>Weight: ${ctx.body_weight_lb}lb</span>` : ''}
        </div>
        ${ctx.cravings ? `<div class="mt-sm text-dim">Cravings: ${esc(ctx.cravings)}</div>` : ''}
        ${ctx.notes ? `<div class="mt-sm text-dim">${esc(ctx.notes)}</div>` : ''}
      </div>` : `
      <div class="mb-md text-center">
        <button class="btn-action btn-compact-sm" onclick="showDailyContextForm('${nutritionDate}')">+ Add Daily Context</button>
      </div>`}

      <div class="list-header">
        <div class="transcript-count">${summary.total_meals} meal${summary.total_meals !== 1 ? 's' : ''}</div>
        <div class="flex-row gap-4">
          <button class="btn-submit btn-secondary btn-compact-sm" onclick="showMealImport()">Import</button>
          <button class="btn-submit btn-compact-sm" onclick="showMealForm()">+ Meal</button>
        </div>
      </div>

      <div id="meal-list" class="fade-in">
        ${summary.meals.length ? summary.meals.map(m => {
          const color = mealTypeColors[m.meal_type] || '#6366f1';
          return `
          <div class="list-item workout-card" onclick="showMealDetail('${m.id}')" style="border-left:3px solid ${color}">
            <div class="transcript-card-header">
              <div class="list-item-title">${esc(m.title)}</div>
              <span class="badge-dynamic" style="background:${color}22;color:${color}">${m.meal_type}</span>
            </div>
            <div class="list-item-meta">
              ${m.meal_time ? `<span>${m.meal_time.slice(0,5)}</span>` : ''}
              ${m.calories ? `<span>${m.calories} cal</span>` : ''}
              ${m.protein_g ? `<span>P: ${m.protein_g}g</span>` : ''}
              ${m.carbs_g ? `<span>C: ${m.carbs_g}g</span>` : ''}
              ${m.fat_g ? `<span>F: ${m.fat_g}g</span>` : ''}
            </div>
          </div>`;
        }).join('') : '<div class="empty-state">No meals logged. Tap "+ Meal" to add one!</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function showMealDetail(id) {
  try {
    const m = await api(`/meals/${id}`);
    const color = { breakfast:'#f59e0b', lunch:'#3b82f6', dinner:'#8b5cf6', snack:'#10b981', 'pre-workout':'#ef4444', 'post-workout':'#06b6d4', drink:'#64748b', supplement:'#ec4899', meal:'#6366f1' }[m.meal_type] || '#6366f1';

    function row(label, val, unit) {
      if (val == null || val === '') return '';
      return `<tr><td>${label}</td><td>${esc(String(val))}${unit ? ' ' + unit : ''}</td></tr>`;
    }

    let html = `
      <div class="flex-row-wrap mb-md">
        <span class="badge-dynamic badge-lg" style="background:${color}22;color:${color}">${m.meal_type}</span>
        ${m.meal_time ? `<span class="text-meta">${m.meal_time.slice(0,5)}</span>` : ''}
      </div>
      <table class="detail-table">
        ${row('Calories', m.calories, 'cal')}
        ${row('Protein', m.protein_g, 'g')}
        ${row('Carbs', m.carbs_g, 'g')}
        ${row('Fat', m.fat_g, 'g')}
        ${row('Fiber', m.fiber_g, 'g')}
        ${row('Sugar', m.sugar_g, 'g')}
        ${row('Sodium', m.sodium_mg, 'mg')}
        ${row('Serving', m.serving_size, '')}
        ${row('Hunger Before', m.hunger_before, '/10')}
        ${row('Fullness After', m.fullness_after, '/10')}
        ${row('Energy After', m.energy_after, '/10')}
      </table>
      ${m.notes ? `<div class="detail-info">${esc(m.notes)}</div>` : ''}
      ${m.tags && m.tags.length ? `<div class="mt-sm">${m.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join(' ')}</div>` : ''}
      <div class="action-row">
        <button class="btn-submit flex-1" onclick="showMealForm('${m.id}')">Edit</button>
        <button class="btn-action btn-action-danger flex-half" onclick="deleteMeal('${m.id}')">Delete</button>
      </div>
    `;
    openModal(m.title, html);
  } catch (e) { showToast('Error: ' + e.message); }
}

async function showMealForm(editId) {
  let m = {};
  const isEdit = !!editId;
  if (isEdit) {
    try { m = await api(`/meals/${editId}`); } catch {}
  }
  const types = ['breakfast','lunch','dinner','snack','pre-workout','post-workout','drink','supplement','meal'];

  const numField = (id, label, val, step) =>
    `<div class="form-group flex-1" style="min-width:80px"><label>${label}</label><input type="number" step="${step || '0.1'}" id="${id}" value="${val != null ? val : ''}" placeholder="—"></div>`;

  const html = `
    <div class="form-scroll">
      <div class="form-group"><label>Title*</label><input type="text" id="ml-title" value="${esc(m.title || '')}" placeholder="Grilled chicken & rice"></div>
      <div class="flex-row">
        <div class="form-group flex-1"><label>Date</label><input type="date" id="ml-date" value="${m.meal_date ? m.meal_date.slice(0,10) : nutritionDate}"></div>
        <div class="form-group flex-1"><label>Time</label><input type="time" id="ml-time" value="${m.meal_time || ''}"></div>
        <div class="form-group flex-1"><label>Type</label><select id="ml-type">
          ${types.map(t => `<option value="${t}" ${m.meal_type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
      </div>
      <h3 class="form-section-title">Macros</h3>
      <div class="flex-row-wrap">
        ${numField('ml-cal', 'Calories', m.calories, '1')}
        ${numField('ml-prot', 'Protein (g)', m.protein_g, '0.1')}
        ${numField('ml-carb', 'Carbs (g)', m.carbs_g, '0.1')}
        ${numField('ml-fat', 'Fat (g)', m.fat_g, '0.1')}
      </div>
      <div class="flex-row-wrap">
        ${numField('ml-fiber', 'Fiber (g)', m.fiber_g, '0.1')}
        ${numField('ml-sugar', 'Sugar (g)', m.sugar_g, '0.1')}
        ${numField('ml-sodium', 'Sodium (mg)', m.sodium_mg, '1')}
      </div>
      <div class="form-group"><label>Serving Size</label><input type="text" id="ml-serving" value="${esc(m.serving_size || '')}" placeholder="1 plate, 2 scoops, etc."></div>
      <h3 class="form-section-title">Feel (1-10)</h3>
      <div class="flex-row">
        ${numField('ml-hunger', 'Hunger Before', m.hunger_before, '1')}
        ${numField('ml-full', 'Fullness After', m.fullness_after, '1')}
        ${numField('ml-energy', 'Energy After', m.energy_after, '1')}
      </div>
      <div class="form-group"><label>Notes</label><textarea id="ml-notes" rows="2" placeholder="Optional notes">${esc(m.notes || '')}</textarea></div>
      <div class="form-group"><label>Tags</label><input type="text" id="ml-tags" value="${(m.tags || []).join(', ')}" placeholder="chicken, post-workout"></div>
      <button class="btn-submit" onclick="saveMeal('${editId || ''}')" style="width:100%;margin-top:8px">${isEdit ? 'Update' : 'Save'} Meal</button>
    </div>
  `;
  openModal(isEdit ? 'Edit Meal' : 'Log Meal', html);
}

async function saveMeal(editId) {
  const nv = (id) => { const v = document.getElementById(id)?.value; return v ? Number(v) : null; };
  const body = {
    title: document.getElementById('ml-title').value,
    meal_date: document.getElementById('ml-date').value,
    meal_time: document.getElementById('ml-time').value || null,
    meal_type: document.getElementById('ml-type').value,
    calories: nv('ml-cal'),
    protein_g: nv('ml-prot'),
    carbs_g: nv('ml-carb'),
    fat_g: nv('ml-fat'),
    fiber_g: nv('ml-fiber'),
    sugar_g: nv('ml-sugar'),
    sodium_mg: nv('ml-sodium'),
    serving_size: document.getElementById('ml-serving').value || null,
    hunger_before: nv('ml-hunger'),
    fullness_after: nv('ml-full'),
    energy_after: nv('ml-energy'),
    notes: document.getElementById('ml-notes').value || null,
    tags: document.getElementById('ml-tags').value.split(',').map(t => t.trim()).filter(Boolean),
  };
  if (!body.title) { showToast('Title is required', 'warning'); return; }
  try {
    if (editId) {
      await api(`/meals/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await api('/meals', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal();
    loadNutrition(nutritionDate);
  } catch (e) { showToast('Error: ' + e.message); }
}

async function deleteMeal(id) {
  if (!confirm('Delete this meal?')) return;
  try {
    await api(`/meals/${id}`, { method: 'DELETE' });
    closeModal();
    loadNutrition(nutritionDate);
  } catch (e) { showToast('Error: ' + e.message); }
}

async function showDailyContextForm(date, editId) {
  let ctx = {};
  if (editId) {
    try { ctx = await api(`/nutrition/daily-context/${editId}`); } catch {}
  }
  const dayTypes = ['rest','strength','run','hill','hybrid','race','travel'];
  const numField = (id, label, val, step) =>
    `<div class="form-group flex-1" style="min-width:90px"><label>${label}</label><input type="number" step="${step || '1'}" id="${id}" value="${val != null ? val : ''}" placeholder="—"></div>`;

  const html = `
    <div class="form-scroll">
      <div class="flex-row">
        <div class="form-group flex-1"><label>Day Type</label><select id="dc-type">
          <option value="">—</option>
          ${dayTypes.map(t => `<option value="${t}" ${ctx.day_type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        ${numField('dc-weight', 'Weight (lb)', ctx.body_weight_lb, '0.1')}
        ${numField('dc-water', 'Water (L)', ctx.hydration_liters, '0.1')}
      </div>
      <div class="flex-row-wrap">
        ${numField('dc-energy', 'Energy (1-10)', ctx.energy_rating, '1')}
        ${numField('dc-hunger', 'Hunger (1-10)', ctx.hunger_rating, '1')}
        ${numField('dc-recovery', 'Recovery (1-10)', ctx.recovery_rating, '1')}
      </div>
      <div class="flex-row-wrap">
        ${numField('dc-sleep-hrs', 'Sleep (hrs)', ctx.sleep_hours, '0.5')}
        ${numField('dc-sleep-q', 'Sleep Quality (1-10)', ctx.sleep_quality, '1')}
      </div>
      <div class="form-group"><label>Cravings</label><input type="text" id="dc-cravings" value="${esc(ctx.cravings || '')}" placeholder="Sugar, salty, none"></div>
      <div class="form-group"><label>Digestion</label><input type="text" id="dc-digestion" value="${esc(ctx.digestion || '')}" placeholder="Good, bloated, etc."></div>
      <div class="form-group"><label>Notes</label><textarea id="dc-notes" rows="2">${esc(ctx.notes || '')}</textarea></div>
      <div class="form-group"><label>Tags</label><input type="text" id="dc-tags" value="${(ctx.tags || []).join(', ')}" placeholder="fasted, cheat-day"></div>
      <button class="btn-submit" onclick="saveDailyContext('${date}','${editId || ''}')" style="width:100%;margin-top:8px">${editId ? 'Update' : 'Save'} Daily Context</button>
    </div>
  `;
  openModal(`Daily Context — ${date}`, html);
}

async function saveDailyContext(date, editId) {
  const nv = (id) => { const v = document.getElementById(id)?.value; return v ? Number(v) : null; };
  const body = {
    date,
    day_type: document.getElementById('dc-type').value || null,
    body_weight_lb: nv('dc-weight'),
    hydration_liters: nv('dc-water'),
    energy_rating: nv('dc-energy'),
    hunger_rating: nv('dc-hunger'),
    recovery_rating: nv('dc-recovery'),
    sleep_hours: nv('dc-sleep-hrs'),
    sleep_quality: nv('dc-sleep-q'),
    cravings: document.getElementById('dc-cravings').value || null,
    digestion: document.getElementById('dc-digestion').value || null,
    notes: document.getElementById('dc-notes').value || null,
    tags: document.getElementById('dc-tags').value.split(',').map(t => t.trim()).filter(Boolean),
  };
  try {
    if (editId) {
      await api(`/nutrition/daily-context/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await api('/nutrition/daily-context', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal();
    loadNutrition(date);
  } catch (e) { showToast('Error: ' + e.message); }
}

// ─── Bulk Meal Import ─────────────────────────────────────────
let _importMeals = [];

function showMealImport() {
  _importMeals = [];
  const html = `
    <div style="margin-bottom:12px;color:var(--text-dim);font-size:0.85rem">
      Upload a JSON file with an array of meal objects.<br>
      Required: title, meal_date. Optional: meal_time, meal_type, calories, protein_g, carbs_g, fat_g, etc.
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <label class="btn-submit" style="cursor:pointer;text-align:center;flex:1;padding:10px;margin:0">
        Choose JSON File
        <input type="file" accept=".json,application/json" onchange="handleMealFile(this)" style="display:none">
      </label>
    </div>
    <textarea id="meal-import-raw" placeholder='[{"title":"Oatmeal","meal_date":"2026-03-17","meal_type":"breakfast","calories":350,...}]'
      style="width:100%;min-height:100px;font-family:monospace;font-size:0.75rem;background:var(--bg-secondary,#1e1e2e);color:var(--text-primary,#cdd6f4);border:1px solid var(--border-color,#45475a);border-radius:8px;padding:10px;box-sizing:border-box;resize:vertical"></textarea>
    <button class="btn-submit" onclick="parseMealImport()" style="width:100%;margin-top:8px;padding:10px">Preview Import</button>
    <div id="meal-import-preview" style="margin-top:12px"></div>
    <div id="meal-import-progress" style="margin-top:12px"></div>
  `;
  openModal('Import Meals from JSON', html);
}

function handleMealFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('meal-import-raw').value = e.target.result;
    parseMealImport();
  };
  reader.readAsText(file);
}

function parseMealImport() {
  const raw = document.getElementById('meal-import-raw').value.trim();
  const preview = document.getElementById('meal-import-preview');
  if (!raw) { preview.innerHTML = '<div style="color:#f38ba8">No JSON provided</div>'; return; }
  try {
    let parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      if (parsed.meals && Array.isArray(parsed.meals)) parsed = parsed.meals;
      else { preview.innerHTML = '<div style="color:#f38ba8">JSON must be an array or have a "meals" array</div>'; return; }
    }
    if (!parsed.length) { preview.innerHTML = '<div style="color:#f38ba8">Empty array</div>'; return; }
    _importMeals = parsed;
    const sample = parsed.slice(0, 5);
    preview.innerHTML = `
      <div style="color:#a6e3a1;font-weight:600;margin-bottom:8px">${parsed.length} meal${parsed.length !== 1 ? 's' : ''} found</div>
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border-color,#45475a);border-radius:6px;padding:8px;font-size:0.75rem">
        <table style="width:100%;border-collapse:collapse">
          <tr style="border-bottom:1px solid var(--border-color,#45475a)">
            <th style="text-align:left;padding:4px">#</th>
            <th style="text-align:left;padding:4px">Date</th>
            <th style="text-align:left;padding:4px">Type</th>
            <th style="text-align:left;padding:4px">Title</th>
            <th style="text-align:left;padding:4px">Cal</th>
          </tr>
          ${sample.map((m, i) => `<tr>
            <td style="padding:4px">${i + 1}</td>
            <td style="padding:4px">${esc(m.meal_date || '—')}</td>
            <td style="padding:4px">${esc(m.meal_type || 'meal')}</td>
            <td style="padding:4px">${esc(m.title || '—')}</td>
            <td style="padding:4px">${m.calories || '—'}</td>
          </tr>`).join('')}
          ${parsed.length > 5 ? `<tr><td colspan="5" style="padding:4px;color:var(--text-dim)">... and ${parsed.length - 5} more</td></tr>` : ''}
        </table>
      </div>
      <button class="btn-submit" onclick="executeMealImport()" style="width:100%;margin-top:12px;padding:12px;font-size:1rem">
        Import ${parsed.length} Meal${parsed.length !== 1 ? 's' : ''}
      </button>
    `;
  } catch (e) {
    preview.innerHTML = `<div style="color:#f38ba8">Invalid JSON: ${esc(e.message)}</div>`;
  }
}

async function executeMealImport() {
  if (!_importMeals.length) return;
  const progress = document.getElementById('meal-import-progress');
  const total = _importMeals.length;
  const BATCH = 200;
  let imported = 0, errors = 0;

  const batches = [];
  for (let i = 0; i < _importMeals.length; i += BATCH) batches.push(_importMeals.slice(i, i + BATCH));

  progress.innerHTML = `<div style="color:var(--text-dim)">Importing... 0/${total}</div>`;

  for (const batch of batches) {
    try {
      const data = await api('/meals/bulk', { method: 'POST', body: JSON.stringify({ meals: batch }) });
      imported += data.imported || 0;
      errors += data.errors || 0;
    } catch (e) { errors += batch.length; }
    progress.innerHTML = `<div style="color:var(--text-dim)">Importing... ${imported + errors}/${total}</div>`;
  }

  progress.innerHTML = `
    <div style="color:#a6e3a1;font-weight:600;font-size:1.1rem;margin-bottom:6px">${imported} meal${imported !== 1 ? 's' : ''} imported</div>
    ${errors ? `<div style="color:#f38ba8;margin-bottom:6px">${errors} error${errors !== 1 ? 's' : ''}</div>` : ''}
    <button class="btn-submit" onclick="closeModal();loadNutrition(nutritionDate)" style="width:100%;margin-top:12px;padding:10px">Done</button>
  `;
  _importMeals = [];
}

// ─── Body Metrics ─────────────────────────────────────────────
let bodyMetricFilters = {};

function setBodyMetricFilter(key, value) {
  if (!value) delete bodyMetricFilters[key]; else bodyMetricFilters[key] = value;
  loadBodyMetrics(bodyMetricFilters._q || '');
}

async function loadBodyMetrics(searchQuery) {
  const main = document.getElementById('fitness-content') || document.getElementById('main-content');
  main.innerHTML = skeletonCards(4);
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (searchQuery) params.set('q', searchQuery);
    for (const [k, v] of Object.entries(bodyMetricFilters)) {
      if (k !== '_q' && v) params.set(k, v);
    }
    const data = await api('/body-metrics?' + params.toString());

    main.innerHTML = `
      <div class="list-search-row">
        <input type="text" class="brain-search" placeholder="Search body metrics..." value="${esc(searchQuery || '')}"
          oninput="debounceBodyMetricSearch(this.value)">
        <button class="btn-submit btn-secondary btn-compact-sm" onclick="showBodyMetricImport()">Import</button>
        <button class="btn-submit btn-compact" onclick="showBodyMetricForm()">+ Log</button>
      </div>
      <div class="transcript-count">${data.total} measurement${data.total !== 1 ? 's' : ''}</div>
      <div id="body-metric-list" class="fade-in">
        ${data.body_metrics.length ? data.body_metrics.map(m => {
          const d = new Date(m.measurement_date.slice(0,10) + 'T12:00:00');
          const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          return `
          <div class="list-item workout-card" onclick="showBodyMetricDetail('${m.id}')" style="border-left:3px solid #06b6d4">
            <div class="transcript-card-header">
              <div class="list-item-title">${esc(m.weight_lb)}lb</div>
              <span class="badge-dynamic" style="background:#06b6d422;color:#06b6d4">${esc(m.source || 'RENPHO')}</span>
            </div>
            <div class="list-item-meta">
              <span>${dateLabel}</span>
              ${m.body_fat_pct ? `<span>BF: ${m.body_fat_pct}%</span>` : ''}
              ${m.muscle_mass_lb ? `<span>Muscle: ${m.muscle_mass_lb}lb</span>` : ''}
              ${m.bmi ? `<span>BMI: ${m.bmi}</span>` : ''}
              ${m.bmr_kcal ? `<span>BMR: ${m.bmr_kcal}</span>` : ''}
              ${m.metabolic_age ? `<span>Met Age: ${m.metabolic_age}</span>` : ''}
            </div>
            ${m.measurement_context ? `<div class="transcript-summary text-micro" style="-webkit-line-clamp:1">${esc(m.measurement_context)}</div>` : ''}
          </div>`;
        }).join('') : '<div class="empty-state">No body metrics yet. Tap "+ Log" to add one!</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

let bodyMetricSearchTimer = null;
function debounceBodyMetricSearch(q) {
  bodyMetricFilters._q = q;
  clearTimeout(bodyMetricSearchTimer);
  bodyMetricSearchTimer = setTimeout(() => loadBodyMetrics(q), 300);
}

async function showBodyMetricDetail(id) {
  try {
    const m = await api(`/body-metrics/${id}`);
    const d = new Date(m.measurement_date.slice(0,10) + 'T12:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    function row(label, value, unit) {
      if (value == null || value === '') return '';
      return `<tr><td>${label}</td><td>${esc(String(value))}${unit ? ' ' + unit : ''}</td></tr>`;
    }

    let html = `
      <div class="flex-row-wrap mb-md">
        <span class="badge-dynamic badge-lg" style="background:#06b6d422;color:#06b6d4">${esc(m.source || 'RENPHO')}</span>
        <span class="text-meta">${dateLabel}</span>
        ${m.measurement_time ? `<span class="text-meta">${esc(m.measurement_time)}</span>` : ''}
        ${m.vendor_user_mode ? `<span class="badge-dynamic" style="background:#f59e0b22;color:#f59e0b">${esc(m.vendor_user_mode)}</span>` : ''}
      </div>

      <div class="text-hero mb-md">${esc(String(m.weight_lb))} lb</div>

      <table class="detail-table">
        ${row('BMI', m.bmi, '')}
        ${row('Body Fat', m.body_fat_pct, '%')}
        ${row('Skeletal Muscle', m.skeletal_muscle_pct, '%')}
        ${row('Fat-Free Mass', m.fat_free_mass_lb, 'lb')}
        ${row('Subcutaneous Fat', m.subcutaneous_fat_pct, '%')}
        ${row('Visceral Fat', m.visceral_fat, '')}
        ${row('Body Water', m.body_water_pct, '%')}
        ${row('Muscle Mass', m.muscle_mass_lb, 'lb')}
        ${row('Bone Mass', m.bone_mass_lb, 'lb')}
        ${row('Protein', m.protein_pct, '%')}
        ${row('BMR', m.bmr_kcal, 'kcal')}
        ${row('Metabolic Age', m.metabolic_age, '')}
      </table>

      ${m.measurement_context ? `<div class="detail-info mt-md"><strong>Context:</strong> ${esc(m.measurement_context)}</div>` : ''}
      ${m.notes ? `<div class="detail-info mt-sm"><strong>Notes:</strong> ${esc(m.notes)}</div>` : ''}
      ${m.tags && m.tags.length ? `<div class="mt-sm">${m.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join(' ')}</div>` : ''}

      <div class="action-row">
        <button class="btn-submit flex-1" onclick="showBodyMetricForm('${m.id}')">Edit</button>
        <button class="btn-action btn-action-danger flex-half" onclick="deleteBodyMetric('${m.id}')">Delete</button>
      </div>
    `;
    openModal(`${m.weight_lb} lb — ${dateLabel}`, html);
  } catch (e) { showToast('Error: ' + e.message); }
}

async function showBodyMetricForm(editId) {
  let m = {};
  const isEdit = !!editId;
  if (isEdit) {
    try { m = await api(`/body-metrics/${editId}`); } catch {}
  }
  const today = new Date().toISOString().slice(0, 10);

  const numField = (id, label, val, step) =>
    `<div class="form-group flex-1" style="min-width:100px"><label>${label}</label><input type="number" step="${step || '0.1'}" id="${id}" value="${val != null ? val : ''}" placeholder="—"></div>`;

  const html = `
    <div class="form-scroll">
      <div class="form-group"><label>Measurement Date</label><input type="date" id="bm-date" value="${m.measurement_date ? m.measurement_date.slice(0,10) : today}"></div>
      <div class="flex-row">
        <div class="form-group flex-1"><label>Time (optional)</label><input type="time" id="bm-time" value="${m.measurement_time || ''}"></div>
        <div class="form-group flex-1"><label>Source</label><input type="text" id="bm-source" value="${esc(m.source || 'RENPHO')}" placeholder="RENPHO"></div>
      </div>
      <div class="flex-row">
        <div class="form-group flex-1"><label>Source Type</label><input type="text" id="bm-source-type" value="${esc(m.source_type || 'smart_scale')}"></div>
        <div class="form-group flex-1"><label>Mode</label><input type="text" id="bm-mode" value="${esc(m.vendor_user_mode || '')}" placeholder="Athlete mode"></div>
      </div>

      <h3 class="form-section-title mt-lg">Core Metrics</h3>
      <div class="flex-row-wrap">
        ${numField('bm-weight', 'Weight (lb)*', m.weight_lb, '0.1')}
        ${numField('bm-bmi', 'BMI', m.bmi, '0.1')}
        ${numField('bm-bf', 'Body Fat %', m.body_fat_pct, '0.1')}
      </div>
      <div class="flex-row-wrap">
        ${numField('bm-skeletal', 'Skeletal Muscle %', m.skeletal_muscle_pct, '0.1')}
        ${numField('bm-ffm', 'Fat-Free Mass (lb)', m.fat_free_mass_lb, '0.1')}
        ${numField('bm-subq', 'Subcutaneous Fat %', m.subcutaneous_fat_pct, '0.1')}
      </div>
      <div class="flex-row-wrap">
        ${numField('bm-visceral', 'Visceral Fat', m.visceral_fat, '1')}
        ${numField('bm-water', 'Body Water %', m.body_water_pct, '0.1')}
        ${numField('bm-muscle', 'Muscle Mass (lb)', m.muscle_mass_lb, '0.1')}
      </div>
      <div class="flex-row-wrap">
        ${numField('bm-bone', 'Bone Mass (lb)', m.bone_mass_lb, '0.1')}
        ${numField('bm-protein', 'Protein %', m.protein_pct, '0.1')}
        ${numField('bm-bmr', 'BMR (kcal)', m.bmr_kcal, '1')}
      </div>
      <div class="flex-row-wrap">
        ${numField('bm-metage', 'Metabolic Age', m.metabolic_age, '1')}
      </div>

      <h3 class="form-section-title mt-lg">Context</h3>
      <div class="form-group"><label>Measurement Context</label><input type="text" id="bm-context" value="${esc(m.measurement_context || '')}" placeholder="morning, fasted, post-bathroom"></div>
      <div class="form-group"><label>Notes</label><textarea id="bm-notes" rows="2" placeholder="Optional notes">${esc(m.notes || '')}</textarea></div>
      <div class="form-group"><label>Tags (comma-separated)</label><input type="text" id="bm-tags" value="${(m.tags || []).join(', ')}" placeholder="renpho, body-composition"></div>

      <button class="btn-submit" onclick="saveBodyMetric('${editId || ''}')" style="width:100%;margin-top:8px">${isEdit ? 'Update' : 'Save'} Body Metric</button>
    </div>
  `;
  openModal(isEdit ? 'Edit Body Metric' : 'Log Body Metric', html);
}

function numVal(id) { const v = document.getElementById(id)?.value; return v ? Number(v) : null; }

async function saveBodyMetric(editId) {
  const body = {
    measurement_date: document.getElementById('bm-date').value,
    measurement_time: document.getElementById('bm-time').value || null,
    source: document.getElementById('bm-source').value || 'RENPHO',
    source_type: document.getElementById('bm-source-type').value || 'smart_scale',
    vendor_user_mode: document.getElementById('bm-mode').value || null,
    weight_lb: numVal('bm-weight'),
    bmi: numVal('bm-bmi'),
    body_fat_pct: numVal('bm-bf'),
    skeletal_muscle_pct: numVal('bm-skeletal'),
    fat_free_mass_lb: numVal('bm-ffm'),
    subcutaneous_fat_pct: numVal('bm-subq'),
    visceral_fat: numVal('bm-visceral'),
    body_water_pct: numVal('bm-water'),
    muscle_mass_lb: numVal('bm-muscle'),
    bone_mass_lb: numVal('bm-bone'),
    protein_pct: numVal('bm-protein'),
    bmr_kcal: numVal('bm-bmr'),
    metabolic_age: numVal('bm-metage'),
    measurement_context: document.getElementById('bm-context').value || null,
    notes: document.getElementById('bm-notes').value || null,
    tags: document.getElementById('bm-tags').value.split(',').map(t => t.trim()).filter(Boolean),
  };

  if (!body.weight_lb) { showToast('Weight is required', 'warning'); return; }
  if (!body.measurement_date) { showToast('Date is required', 'warning'); return; }

  try {
    if (editId) {
      await api(`/body-metrics/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await api('/body-metrics', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal();
    loadBodyMetrics(bodyMetricFilters._q || '');
  } catch (e) {
    showToast('Error saving: ' + e.message);
  }
}

async function deleteBodyMetric(id) {
  if (!confirm('Delete this body metric?')) return;
  try {
    await api(`/body-metrics/${id}`, { method: 'DELETE' });
    closeModal();
    loadBodyMetrics(bodyMetricFilters._q || '');
  } catch (e) { showToast('Error: ' + e.message); }
}

// ─── Bulk Body Metrics Import ─────────────────────────────────
let _importBodyMetrics = [];

function showBodyMetricImport() {
  _importBodyMetrics = [];
  const html = `
    <div style="margin-bottom:12px;color:var(--text-dim);font-size:0.85rem">
      Upload a JSON file with an array of body metric objects (e.g. RENPHO export).<br>
      Required fields: measurement_date, weight_lb. All other fields are optional.
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <label class="btn-submit" style="cursor:pointer;text-align:center;flex:1;padding:10px;margin:0">
        Choose JSON File
        <input type="file" accept=".json,application/json" onchange="handleBodyMetricFile(this)" style="display:none">
      </label>
    </div>
    <textarea id="bm-import-raw" placeholder='[{"measurement_date":"2026-03-17","weight_lb":190,...}]'
      style="width:100%;min-height:100px;font-family:monospace;font-size:0.75rem;background:var(--bg-secondary,#1e1e2e);color:var(--text-primary,#cdd6f4);border:1px solid var(--border-color,#45475a);border-radius:8px;padding:10px;box-sizing:border-box;resize:vertical"></textarea>
    <button class="btn-submit" onclick="parseBodyMetricImport()" style="width:100%;margin-top:8px;padding:10px">Preview Import</button>
    <div id="bm-import-preview" style="margin-top:12px"></div>
    <div id="bm-import-progress" style="margin-top:12px"></div>
  `;
  openModal('Import Body Metrics from JSON', html);
}

function handleBodyMetricFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('bm-import-raw').value = e.target.result;
    parseBodyMetricImport();
  };
  reader.readAsText(file);
}

function parseBodyMetricImport() {
  const raw = document.getElementById('bm-import-raw').value.trim();
  const preview = document.getElementById('bm-import-preview');
  if (!raw) { preview.innerHTML = '<div style="color:#f38ba8">No JSON provided</div>'; return; }
  try {
    let parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      if (parsed.body_metrics && Array.isArray(parsed.body_metrics)) parsed = parsed.body_metrics;
      else { preview.innerHTML = '<div style="color:#f38ba8">JSON must be an array or have a "body_metrics" array</div>'; return; }
    }
    if (!parsed.length) { preview.innerHTML = '<div style="color:#f38ba8">Empty array</div>'; return; }
    _importBodyMetrics = parsed;
    const sample = parsed.slice(0, 5);
    preview.innerHTML = `
      <div style="color:#a6e3a1;font-weight:600;margin-bottom:8px">${parsed.length} entry${parsed.length !== 1 ? 'ies' : 'y'} found</div>
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border-color,#45475a);border-radius:6px;padding:8px;font-size:0.75rem">
        <table style="width:100%;border-collapse:collapse">
          <tr style="border-bottom:1px solid var(--border-color,#45475a)">
            <th style="text-align:left;padding:4px">#</th>
            <th style="text-align:left;padding:4px">Date</th>
            <th style="text-align:left;padding:4px">Weight</th>
            <th style="text-align:left;padding:4px">BF%</th>
            <th style="text-align:left;padding:4px">Source</th>
          </tr>
          ${sample.map((m, i) => `<tr>
            <td style="padding:4px">${i + 1}</td>
            <td style="padding:4px">${esc(m.measurement_date || '—')}</td>
            <td style="padding:4px">${m.weight_lb || '—'}</td>
            <td style="padding:4px">${m.body_fat_pct || '—'}</td>
            <td style="padding:4px">${esc(m.source || 'RENPHO')}</td>
          </tr>`).join('')}
          ${parsed.length > 5 ? `<tr><td colspan="5" style="padding:4px;color:var(--text-dim)">... and ${parsed.length - 5} more</td></tr>` : ''}
        </table>
      </div>
      <button class="btn-submit" onclick="executeBodyMetricImport()" style="width:100%;margin-top:12px;padding:12px;font-size:1rem">
        Import ${parsed.length} Body Metric${parsed.length !== 1 ? 's' : ''}
      </button>
    `;
  } catch (e) {
    preview.innerHTML = `<div style="color:#f38ba8">Invalid JSON: ${esc(e.message)}</div>`;
  }
}

async function executeBodyMetricImport() {
  if (!_importBodyMetrics.length) return;
  const progress = document.getElementById('bm-import-progress');
  const total = _importBodyMetrics.length;
  const BATCH = 200;
  let imported = 0, errors = 0;

  const batches = [];
  for (let i = 0; i < _importBodyMetrics.length; i += BATCH) {
    batches.push(_importBodyMetrics.slice(i, i + BATCH));
  }

  progress.innerHTML = `<div style="color:var(--text-dim)">Importing... 0/${total}</div>`;

  for (const batch of batches) {
    try {
      const data = await api('/body-metrics/bulk', {
        method: 'POST',
        body: JSON.stringify({ body_metrics: batch })
      });
      imported += data.imported || 0;
      errors += data.errors || 0;
    } catch (e) {
      errors += batch.length;
    }
    progress.innerHTML = `<div style="color:var(--text-dim)">Importing... ${imported + errors}/${total}</div>`;
  }

  progress.innerHTML = `
    <div style="color:#a6e3a1;font-weight:600;font-size:1.1rem;margin-bottom:6px">${imported} body metric${imported !== 1 ? 's' : ''} imported</div>
    ${errors ? `<div style="color:#f38ba8;margin-bottom:6px">${errors} error${errors !== 1 ? 's' : ''}</div>` : ''}
    <button class="btn-submit" onclick="closeModal();loadBodyMetrics('')" style="width:100%;margin-top:12px;padding:10px">Done</button>
  `;
  _importBodyMetrics = [];
}

// ─── Bulk Workout Import ──────────────────────────────────────
let _importWorkouts = [];

function showWorkoutImport() {
  _importWorkouts = [];
  const html = `
    <div style="margin-bottom:12px;color:var(--text-dim);font-size:0.85rem">
      Upload a JSON file containing an array of workout objects, or paste JSON directly.<br>
      Fields map to: title, workout_date, workout_type, location, focus, warmup, main_sets, carries, exercises,
      time_duration, distance, elevation_gain, heart_rate_avg, heart_rate_max, pace_avg, splits, cadence_avg,
      active_calories, total_calories, effort (1-10), body_notes, tags, etc.
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <label class="btn-submit" style="cursor:pointer;text-align:center;flex:1;padding:10px;margin:0">
        Choose JSON File
        <input type="file" accept=".json,application/json" onchange="handleWorkoutFile(this)" style="display:none">
      </label>
    </div>
    <textarea id="import-json-raw" placeholder='Paste JSON array here, e.g. [{"workout_date":"2024-01-15","workout_type":"strength","focus":"Upper body",...}]'
      style="width:100%;min-height:120px;font-family:monospace;font-size:0.75rem;background:var(--bg-secondary,#1e1e2e);color:var(--text-primary,#cdd6f4);border:1px solid var(--border-color,#45475a);border-radius:8px;padding:10px;box-sizing:border-box;resize:vertical"></textarea>
    <button class="btn-submit" onclick="parseWorkoutImport()" style="width:100%;margin-top:8px;padding:10px">Preview Import</button>
    <div id="import-preview" style="margin-top:12px"></div>
    <div id="import-progress" style="margin-top:12px"></div>
  `;
  openModal('Import Workouts from JSON', html);
}

function handleWorkoutFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('import-json-raw').value = e.target.result;
    parseWorkoutImport();
  };
  reader.readAsText(file);
}

function parseWorkoutImport() {
  const raw = document.getElementById('import-json-raw').value.trim();
  const preview = document.getElementById('import-preview');
  if (!raw) { preview.innerHTML = '<div style="color:#f38ba8">No JSON provided</div>'; return; }

  try {
    let parsed = JSON.parse(raw);
    // Support both array and {workouts:[...]} wrapper
    if (!Array.isArray(parsed)) {
      if (parsed.workouts && Array.isArray(parsed.workouts)) parsed = parsed.workouts;
      else { preview.innerHTML = '<div style="color:#f38ba8">JSON must be an array or have a "workouts" array</div>'; return; }
    }
    if (!parsed.length) { preview.innerHTML = '<div style="color:#f38ba8">Empty array</div>'; return; }

    _importWorkouts = parsed;
    const sample = parsed.slice(0, 5);
    const fields = [...new Set(parsed.flatMap(w => Object.keys(w)))];

    preview.innerHTML = `
      <div style="color:#a6e3a1;font-weight:600;margin-bottom:8px">${parsed.length} workout${parsed.length !== 1 ? 's' : ''} found</div>
      <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:8px">Fields detected: ${fields.join(', ')}</div>
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border-color,#45475a);border-radius:6px;padding:8px;font-size:0.75rem">
        <table style="width:100%;border-collapse:collapse">
          <tr style="border-bottom:1px solid var(--border-color,#45475a)">
            <th style="text-align:left;padding:4px">#</th>
            <th style="text-align:left;padding:4px">Date</th>
            <th style="text-align:left;padding:4px">Type</th>
            <th style="text-align:left;padding:4px">Title / Focus</th>
            <th style="text-align:left;padding:4px">Effort</th>
          </tr>
          ${sample.map((w, i) => `<tr style="border-bottom:1px solid var(--border-color,#45475a)22">
            <td style="padding:4px">${i + 1}</td>
            <td style="padding:4px">${esc(w.workout_date || w.date || '—')}</td>
            <td style="padding:4px">${esc(w.workout_type || w.type || '—')}</td>
            <td style="padding:4px">${esc(w.title || w.focus || '—')}</td>
            <td style="padding:4px">${w.effort || '—'}</td>
          </tr>`).join('')}
          ${parsed.length > 5 ? `<tr><td colspan="5" style="padding:4px;color:var(--text-dim)">... and ${parsed.length - 5} more</td></tr>` : ''}
        </table>
      </div>
      <button class="btn-submit" onclick="executeWorkoutImport()" style="width:100%;margin-top:12px;padding:12px;font-size:1rem">
        Import ${parsed.length} Workout${parsed.length !== 1 ? 's' : ''}
      </button>
    `;
  } catch (e) {
    preview.innerHTML = `<div style="color:#f38ba8">Invalid JSON: ${esc(e.message)}</div>`;
  }
}

async function executeWorkoutImport() {
  if (!_importWorkouts.length) return;

  const progress = document.getElementById('import-progress');
  const total = _importWorkouts.length;
  const BATCH = 200;
  let imported = 0, errors = 0, allResults = [];

  // Normalize field names: support common aliases
  const normalized = _importWorkouts.map(w => {
    const out = { ...w };
    if (w.date && !w.workout_date) out.workout_date = w.date;
    if (w.type && !w.workout_type) out.workout_type = w.type;
    if (w.time && !w.time_duration) out.time_duration = w.time;
    if (w.duration && !w.time_duration) out.time_duration = w.duration;
    if (w.notes && !w.body_notes) out.body_notes = w.notes;
    if (w.where_slowed_down && !w.slowdown_notes) out.slowdown_notes = w.where_slowed_down;
    if (w.what_failed_first && !w.failure_first) out.failure_first = w.what_failed_first;
    if (w.grip && !w.grip_feedback) out.grip_feedback = w.grip;
    if (w.legs && !w.legs_feedback) out.legs_feedback = w.legs;
    if (w.cardio && !w.cardio_feedback) out.cardio_feedback = w.cardio;
    if (w.shoulder && !w.shoulder_feedback) out.shoulder_feedback = w.shoulder;
    if (w.adjustment_next_time && !w.adjustment) out.adjustment = w.adjustment_next_time;
    if (!out.source) out.source = 'import';
    return out;
  });

  const batches = [];
  for (let i = 0; i < normalized.length; i += BATCH) {
    batches.push(normalized.slice(i, i + BATCH));
  }

  progress.innerHTML = `<div style="color:var(--text-dim)">Importing... 0/${total}</div>`;

  for (let bi = 0; bi < batches.length; bi++) {
    try {
      const data = await api('/workouts/bulk', {
        method: 'POST',
        body: JSON.stringify({ workouts: batches[bi] })
      });
      imported += data.imported || 0;
      errors += data.errors || 0;
      if (data.results) allResults.push(...data.results);
    } catch (e) {
      errors += batches[bi].length;
      allResults.push({ error: e.message, batch: bi + 1 });
    }
    progress.innerHTML = `<div style="color:var(--text-dim)">Importing... ${imported + errors}/${total}</div>`;
  }

  const errorItems = allResults.filter(r => r.error);
  progress.innerHTML = `
    <div style="color:#a6e3a1;font-weight:600;font-size:1.1rem;margin-bottom:6px">${imported} workout${imported !== 1 ? 's' : ''} imported</div>
    ${errors ? `<div style="color:#f38ba8;margin-bottom:6px">${errors} error${errors !== 1 ? 's' : ''}</div>` : ''}
    ${errorItems.length ? `<div style="max-height:150px;overflow-y:auto;font-size:0.75rem;color:#f38ba8;background:var(--bg-secondary,#1e1e2e);padding:8px;border-radius:6px;margin-top:4px">
      ${errorItems.map(e => `<div>${esc(e.workout_date || e.title || 'batch ' + e.batch)}: ${esc(e.error)}</div>`).join('')}
    </div>` : ''}
    <button class="btn-submit" onclick="closeModal();loadWorkouts('')" style="width:100%;margin-top:12px;padding:10px">Done</button>
  `;
  _importWorkouts = [];
}

// ─── Modal ────────────────────────────────────────────────────
function openModal(title, bodyHtml) { document.getElementById('modal-title').textContent=title; document.getElementById('modal-body').innerHTML=bodyHtml; document.getElementById('modal-overlay').classList.add('open'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

// ─── Training Tab ─────────────────────────────────────────────
let trainingSubTab = 'plans';

async function loadTraining() {
  const main = document.getElementById('fitness-content') || document.getElementById('main-content');
  main.innerHTML = `
    <div class="filter-row" style="margin-bottom:12px">
      <button class="filter-btn ${trainingSubTab === 'plans' ? 'active' : ''}" onclick="trainingSubTab='plans';loadTraining()">Plans</button>
      <button class="filter-btn ${trainingSubTab === 'coaching' ? 'active' : ''}" onclick="trainingSubTab='coaching';loadTraining()">Coaching</button>
      <button class="filter-btn ${trainingSubTab === 'injuries' ? 'active' : ''}" onclick="trainingSubTab='injuries';loadTraining()">Injuries</button>
      <button class="filter-btn ${trainingSubTab === 'day' ? 'active' : ''}" onclick="trainingSubTab='day';loadTraining()">Day View</button>
    </div>
    <div id="training-content"><div class="loading">Loading...</div></div>
  `;
  if (trainingSubTab === 'plans') loadTrainingPlans();
  else if (trainingSubTab === 'coaching') loadCoachingSessions();
  else if (trainingSubTab === 'injuries') loadInjuries();
  else if (trainingSubTab === 'day') loadTrainingDay();
}

// ── Training Plans ──
async function loadTrainingPlans() {
  const container = document.getElementById('training-content');
  try {
    const data = await api('/training/plans?limit=50');
    const statusColors = { draft: '#6b7280', active: '#22c55e', completed: '#3b82f6', paused: '#f59e0b', archived: '#78716c' };
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="transcript-count">${data.total} plan${data.total !== 1 ? 's' : ''}</div>
        <button class="btn-submit" onclick="showTrainingPlanForm()" style="padding:8px 16px">+ Plan</button>
      </div>
      ${data.plans.length ? data.plans.map(p => {
        const color = statusColors[p.status] || '#6366f1';
        const dates = p.start_date ? `${new Date(p.start_date).toLocaleDateString('en-US', {month:'short',day:'numeric'})}${p.end_date ? ' - ' + new Date(p.end_date).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : ''}` : '';
        return `
        <div class="list-item" onclick="showTrainingPlanDetail('${p.id}')" style="border-left:3px solid ${color}">
          <div class="transcript-card-header">
            <div class="list-item-title">${esc(p.title)}</div>
            <span class="content-type-badge" style="background:${color}22;color:${color}">${p.status}</span>
            <span class="content-type-badge" style="background:var(--bg-input);color:var(--text-dim)">${p.plan_type}</span>
          </div>
          ${p.goal ? `<div class="transcript-summary" style="-webkit-line-clamp:2">${esc(p.goal)}</div>` : ''}
          <div class="list-item-meta">
            ${dates ? `<span>${dates}</span>` : ''}
            ${p.weeks ? `<span>${p.weeks}wk</span>` : ''}
            ${p.phase ? `<span>${esc(p.phase)}</span>` : ''}
          </div>
        </div>`;
      }).join('') : '<div class="empty-state">No training plans yet. Create one to track your programming!</div>'}
    `;
  } catch (e) { container.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function showTrainingPlanDetail(id) {
  try {
    const p = await api(`/training/plans/${id}`);
    const statusColors = { draft: '#6b7280', active: '#22c55e', completed: '#3b82f6', paused: '#f59e0b', archived: '#78716c' };
    const color = statusColors[p.status] || '#6366f1';

    function section(label, value) {
      if (!value) return '';
      return `<div class="workout-detail-section"><div class="workout-detail-label">${label}</div><div class="workout-detail-value">${esc(value).replace(/\n/g, '<br>')}</div></div>`;
    }

    let html = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <span class="content-type-badge" style="background:${color}22;color:${color}">${p.status}</span>
        <span class="content-type-badge" style="background:var(--bg-input);color:var(--text-dim)">${p.plan_type}</span>
        ${p.weeks ? `<span style="font-size:0.8rem;color:var(--text-dim)">${p.weeks} weeks</span>` : ''}
        ${p.phase ? `<span style="font-size:0.8rem;color:var(--accent)">${esc(p.phase)}</span>` : ''}
      </div>
      ${p.start_date ? `<div class="workout-detail-section"><div class="workout-detail-label">Dates</div><div class="workout-detail-value">${new Date(p.start_date).toLocaleDateString()}${p.end_date ? ' — ' + new Date(p.end_date).toLocaleDateString() : ''}</div></div>` : ''}
      ${section('Goal', p.goal)}
      ${section('Rationale', p.rationale)}
      ${section('Constraints', p.constraints)}
      ${section('Intensity Scheme', p.intensity_scheme)}
      ${section('Progression', p.progression_notes)}
    `;

    if (p.weekly_structure && p.weekly_structure.length) {
      html += `<div class="workout-detail-section"><div class="workout-detail-label">Weekly Structure</div><div class="workout-detail-value">`;
      p.weekly_structure.forEach(d => {
        html += `<div style="margin-bottom:6px"><strong>${esc(d.day || d.name || 'Day')}</strong>: ${esc(d.type || '')} ${d.focus ? '— ' + esc(d.focus) : ''} ${d.notes ? '<br><span style="color:var(--text-dim)">' + esc(d.notes) + '</span>' : ''}</div>`;
      });
      html += `</div></div>`;
    }

    if (p.coaching_sessions?.length) {
      html += `<div class="workout-detail-section"><div class="workout-detail-label">Coaching Sessions (${p.coaching_sessions.length})</div><div class="workout-detail-value">`;
      p.coaching_sessions.forEach(s => {
        html += `<div class="list-item" onclick="event.stopPropagation();closeModal();setTimeout(()=>showCoachingDetail('${s.id}'),200)" style="cursor:pointer;margin-bottom:6px;padding:8px">
          <div class="list-item-title" style="font-size:0.8rem">${esc(s.title)}</div>
          <div style="font-size:0.7rem;color:var(--text-dim)">${new Date(s.session_date).toLocaleDateString()} · ${esc(s.ai_source || '')}</div>
          ${s.summary ? `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:2px">${esc(s.summary)}</div>` : ''}
        </div>`;
      });
      html += `</div></div>`;
    }

    if (p.injuries?.length) {
      html += `<div class="workout-detail-section"><div class="workout-detail-label">Related Injuries (${p.injuries.length})</div><div class="workout-detail-value">`;
      p.injuries.forEach(inj => {
        const sevColor = inj.severity >= 7 ? 'var(--red)' : inj.severity >= 4 ? 'var(--yellow)' : 'var(--green)';
        html += `<div style="margin-bottom:6px"><span style="color:${sevColor};font-weight:700">${inj.severity || '?'}/10</span> ${esc(inj.title)} <span style="color:var(--text-dim)">(${esc(inj.body_area)}${inj.side && inj.side !== 'n/a' ? ' · ' + inj.side : ''} · ${inj.status})</span></div>`;
      });
      html += `</div></div>`;
    }

    if (p.tags?.length) {
      html += `<div class="transcript-speakers" style="margin-top:8px">${p.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join('')}</div>`;
    }

    html += `
      <div style="display:flex;gap:8px;margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
        <button class="btn-action" onclick="editTrainingPlan('${p.id}')">Edit</button>
        <button class="btn-action btn-action-danger" onclick="deleteTrainingPlan('${p.id}')">Delete</button>
      </div>
    `;

    openModal(p.title, html);
  } catch (e) { showToast(e.message); }
}

function showTrainingPlanForm(existing) {
  const p = existing || {};
  const html = `
    <form onsubmit="saveTrainingPlan(event, '${p.id || ''}')">
      <div class="form-group"><label>Title *</label><input name="title" value="${esc(p.title || '')}" required></div>
      <div class="form-row">
        <div class="form-group"><label>Type</label><select name="plan_type">
          ${['block','mesocycle','microcycle','deload','race_prep','rehab','custom'].map(t => `<option value="${t}" ${p.plan_type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="form-group"><label>Status</label><select name="status">
          ${['draft','active','completed','paused','archived'].map(s => `<option value="${s}" ${(p.status || 'active') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      </div>
      <div class="form-group"><label>Goal</label><textarea name="goal" rows="2">${esc(p.goal || '')}</textarea></div>
      <div class="form-group"><label>Rationale (WHY this plan)</label><textarea name="rationale" rows="3">${esc(p.rationale || '')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Start Date</label><input type="date" name="start_date" value="${p.start_date ? p.start_date.slice(0,10) : ''}"></div>
        <div class="form-group"><label>End Date</label><input type="date" name="end_date" value="${p.end_date ? p.end_date.slice(0,10) : ''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Weeks</label><input type="number" name="weeks" value="${p.weeks || ''}" min="1"></div>
        <div class="form-group"><label>Phase</label><input name="phase" value="${esc(p.phase || '')}" placeholder="base, build, peak, taper..."></div>
      </div>
      <div class="form-group"><label>Intensity Scheme</label><input name="intensity_scheme" value="${esc(p.intensity_scheme || '')}" placeholder="e.g. RPE 7-8, 5/3/1 progression"></div>
      <div class="form-group"><label>Progression Notes</label><textarea name="progression_notes" rows="2">${esc(p.progression_notes || '')}</textarea></div>
      <div class="form-group"><label>Constraints</label><textarea name="constraints" rows="2" placeholder="Injuries, schedule limits, equipment...">${esc(p.constraints || '')}</textarea></div>
      <div class="form-group"><label>Tags (comma separated)</label><input name="tags" value="${(p.tags || []).join(', ')}"></div>
      <button type="submit" class="btn-submit" style="width:100%;margin-top:8px">${p.id ? 'Update' : 'Create'} Plan</button>
    </form>
  `;
  openModal(p.id ? 'Edit Training Plan' : 'New Training Plan', html);
}

async function saveTrainingPlan(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    title: f.get('title'),
    plan_type: f.get('plan_type'),
    status: f.get('status'),
    goal: f.get('goal') || null,
    rationale: f.get('rationale') || null,
    start_date: f.get('start_date') || null,
    end_date: f.get('end_date') || null,
    weeks: f.get('weeks') ? parseInt(f.get('weeks')) : null,
    phase: f.get('phase') || null,
    intensity_scheme: f.get('intensity_scheme') || null,
    progression_notes: f.get('progression_notes') || null,
    constraints: f.get('constraints') || null,
    tags: f.get('tags') ? f.get('tags').split(',').map(t => t.trim()).filter(Boolean) : [],
  };
  try {
    if (id) await api(`/training/plans/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/training/plans', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    loadTraining();
  } catch (err) { showToast(err.message); }
}

async function editTrainingPlan(id) {
  try {
    const p = await api(`/training/plans/${id}`);
    closeModal();
    setTimeout(() => showTrainingPlanForm(p), 200);
  } catch (e) { showToast(e.message); }
}

async function deleteTrainingPlan(id) {
  if (!confirm('Delete this training plan?')) return;
  try { await api(`/training/plans/${id}`, { method: 'DELETE' }); closeModal(); loadTraining(); }
  catch (e) { showToast(e.message); }
}

// ── Coaching Sessions ──
async function loadCoachingSessions() {
  const container = document.getElementById('training-content');
  try {
    const data = await api('/training/coaching?limit=50');
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="transcript-count">${data.total} session${data.total !== 1 ? 's' : ''}</div>
        <button class="btn-submit" onclick="showCoachingForm()" style="padding:8px 16px">+ Session</button>
      </div>
      ${data.sessions.length ? data.sessions.map(s => `
        <div class="list-item" onclick="showCoachingDetail('${s.id}')" style="border-left:3px solid #a855f7">
          <div class="transcript-card-header">
            <div class="list-item-title">${esc(s.title)}</div>
            <span class="content-type-badge" style="background:#a855f722;color:#a855f7">${esc(s.ai_source || 'ai')}</span>
          </div>
          ${s.summary ? `<div class="transcript-summary" style="-webkit-line-clamp:2">${esc(s.summary)}</div>` : ''}
          <div class="list-item-meta">
            <span>${new Date(s.session_date).toLocaleDateString('en-US', {weekday:'short',month:'short',day:'numeric'})}</span>
            ${s.injury_notes ? '<span style="color:var(--red)">injury notes</span>' : ''}
            ${s.next_steps ? '<span>has next steps</span>' : ''}
          </div>
        </div>
      `).join('') : '<div class="empty-state">No coaching sessions yet. Chat with your AI coach and save the summary here!</div>'}
    `;
  } catch (e) { container.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function showCoachingDetail(id) {
  try {
    const s = await api(`/training/coaching/${id}`);
    function section(label, value) {
      if (!value) return '';
      return `<div class="workout-detail-section"><div class="workout-detail-label">${label}</div><div class="workout-detail-value">${esc(value).replace(/\n/g, '<br>')}</div></div>`;
    }

    let html = `
      <div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:10px">
        ${new Date(s.session_date).toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'})}
        · <span style="color:#a855f7">${esc(s.ai_source || 'AI')}</span>
      </div>
      ${section('Summary', s.summary)}
    `;

    if (s.key_decisions?.length) {
      html += `<div class="workout-detail-section"><div class="workout-detail-label">Key Decisions</div><div class="workout-detail-value">`;
      s.key_decisions.forEach(d => { html += `<div style="margin-bottom:4px">• ${esc(typeof d === 'string' ? d : JSON.stringify(d))}</div>`; });
      html += `</div></div>`;
    }

    if (s.adjustments?.length) {
      html += `<div class="workout-detail-section"><div class="workout-detail-label">Adjustments</div><div class="workout-detail-value">`;
      s.adjustments.forEach(a => {
        if (typeof a === 'object') html += `<div style="margin-bottom:6px"><strong>${esc(a.area || '')}</strong>: ${esc(a.change || '')} ${a.reason ? '<span style="color:var(--text-dim)">(' + esc(a.reason) + ')</span>' : ''}</div>`;
        else html += `<div style="margin-bottom:4px">• ${esc(String(a))}</div>`;
      });
      html += `</div></div>`;
    }

    html += section('Injury Notes', s.injury_notes);
    html += section('Nutrition Notes', s.nutrition_notes);
    html += section('Recovery Notes', s.recovery_notes);
    html += section('Mental Notes', s.mental_notes);
    html += section('Next Steps', s.next_steps);

    if (s.tags?.length) {
      html += `<div class="transcript-speakers" style="margin-top:8px">${s.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join('')}</div>`;
    }

    html += `
      <div style="display:flex;gap:8px;margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
        <button class="btn-action" onclick="editCoachingSession('${s.id}')">Edit</button>
        <button class="btn-action btn-action-danger" onclick="deleteCoachingSession('${s.id}')">Delete</button>
      </div>
    `;

    openModal(s.title, html);
  } catch (e) { showToast(e.message); }
}

function showCoachingForm(existing) {
  const s = existing || {};
  const html = `
    <form onsubmit="saveCoachingSession(event, '${s.id || ''}')">
      <div class="form-group"><label>Title *</label><input name="title" value="${esc(s.title || '')}" required placeholder="e.g. Weekly Training Review - March 18"></div>
      <div class="form-group"><label>Date</label><input type="date" name="session_date" value="${s.session_date ? s.session_date.slice(0,10) : new Date().toISOString().slice(0,10)}"></div>
      <div class="form-group"><label>Summary *</label><textarea name="summary" rows="4" required placeholder="Full summary of the coaching conversation...">${esc(s.summary || '')}</textarea></div>
      <div class="form-group"><label>Key Decisions (one per line)</label><textarea name="key_decisions" rows="3" placeholder="Reduce upper body volume 20%\nAdd hip mobility work">${(s.key_decisions || []).map(d => typeof d === 'string' ? d : JSON.stringify(d)).join('\n')}</textarea></div>
      <div class="form-group"><label>Injury Notes</label><textarea name="injury_notes" rows="2">${esc(s.injury_notes || '')}</textarea></div>
      <div class="form-group"><label>Nutrition Notes</label><textarea name="nutrition_notes" rows="2">${esc(s.nutrition_notes || '')}</textarea></div>
      <div class="form-group"><label>Recovery Notes</label><textarea name="recovery_notes" rows="2">${esc(s.recovery_notes || '')}</textarea></div>
      <div class="form-group"><label>Mental Notes</label><textarea name="mental_notes" rows="2">${esc(s.mental_notes || '')}</textarea></div>
      <div class="form-group"><label>Next Steps</label><textarea name="next_steps" rows="2">${esc(s.next_steps || '')}</textarea></div>
      <div class="form-group"><label>AI Source</label><select name="ai_source">
        ${['chatgpt','claude','gemini','manual'].map(src => `<option value="${src}" ${(s.ai_source || 'chatgpt') === src ? 'selected' : ''}>${src}</option>`).join('')}
      </select></div>
      <div class="form-group"><label>Tags (comma separated)</label><input name="tags" value="${(s.tags || []).join(', ')}"></div>
      <button type="submit" class="btn-submit" style="width:100%;margin-top:8px">${s.id ? 'Update' : 'Save'} Session</button>
    </form>
  `;
  openModal(s.id ? 'Edit Coaching Session' : 'New Coaching Session', html);
}

async function saveCoachingSession(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    title: f.get('title'),
    session_date: f.get('session_date') || null,
    summary: f.get('summary'),
    key_decisions: f.get('key_decisions') ? f.get('key_decisions').split('\n').map(s => s.trim()).filter(Boolean) : [],
    injury_notes: f.get('injury_notes') || null,
    nutrition_notes: f.get('nutrition_notes') || null,
    recovery_notes: f.get('recovery_notes') || null,
    mental_notes: f.get('mental_notes') || null,
    next_steps: f.get('next_steps') || null,
    ai_source: f.get('ai_source'),
    tags: f.get('tags') ? f.get('tags').split(',').map(t => t.trim()).filter(Boolean) : [],
  };
  try {
    if (id) await api(`/training/coaching/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/training/coaching', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    loadTraining();
  } catch (err) { showToast(err.message); }
}

async function editCoachingSession(id) {
  try {
    const s = await api(`/training/coaching/${id}`);
    closeModal();
    setTimeout(() => showCoachingForm(s), 200);
  } catch (e) { showToast(e.message); }
}

async function deleteCoachingSession(id) {
  if (!confirm('Delete this coaching session?')) return;
  try { await api(`/training/coaching/${id}`, { method: 'DELETE' }); closeModal(); loadTraining(); }
  catch (e) { showToast(e.message); }
}

// ── Injuries ──
async function loadInjuries() {
  const container = document.getElementById('training-content');
  try {
    const data = await api('/training/injuries?limit=50');
    const statusColors = { active: '#ef4444', monitoring: '#f59e0b', recovering: '#3b82f6', resolved: '#22c55e', chronic: '#78716c' };
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="transcript-count">${data.total} injur${data.total !== 1 ? 'ies' : 'y'}</div>
        <button class="btn-submit" onclick="showInjuryForm()" style="padding:8px 16px">+ Injury</button>
      </div>
      ${data.injuries.length ? data.injuries.map(inj => {
        const color = statusColors[inj.status] || '#6366f1';
        const sevColor = inj.severity >= 7 ? '#ef4444' : inj.severity >= 4 ? '#f59e0b' : '#22c55e';
        return `
        <div class="list-item" onclick="showInjuryDetail('${inj.id}')" style="border-left:3px solid ${color}">
          <div class="transcript-card-header">
            <div class="list-item-title">${esc(inj.title)}</div>
            <span class="content-type-badge" style="background:${color}22;color:${color}">${inj.status}</span>
            ${inj.severity ? `<span class="effort-badge" style="background:${sevColor}22;color:${sevColor}">${inj.severity}/10</span>` : ''}
          </div>
          <div class="list-item-meta">
            <span>${esc(inj.body_area)}${inj.side && inj.side !== 'n/a' ? ' (' + inj.side + ')' : ''}</span>
            <span>${esc(inj.injury_type || '')}</span>
            ${inj.onset_date ? `<span>onset: ${new Date(inj.onset_date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : ''}
          </div>
          ${inj.symptoms ? `<div class="transcript-summary" style="-webkit-line-clamp:1">${esc(inj.symptoms)}</div>` : ''}
        </div>`;
      }).join('') : '<div class="empty-state">No injuries logged. Track injuries to help AI coaches prevent re-injury!</div>'}
    `;
  } catch (e) { container.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function showInjuryDetail(id) {
  try {
    const inj = await api(`/training/injuries/${id}`);
    const statusColors = { active: '#ef4444', monitoring: '#f59e0b', recovering: '#3b82f6', resolved: '#22c55e', chronic: '#78716c' };
    const color = statusColors[inj.status] || '#6366f1';
    const sevColor = inj.severity >= 7 ? '#ef4444' : inj.severity >= 4 ? '#f59e0b' : '#22c55e';

    function section(label, value) {
      if (!value) return '';
      return `<div class="workout-detail-section"><div class="workout-detail-label">${label}</div><div class="workout-detail-value">${esc(value).replace(/\n/g, '<br>')}</div></div>`;
    }

    let html = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <span class="content-type-badge" style="background:${color}22;color:${color}">${inj.status}</span>
        <span style="font-size:0.8rem">${esc(inj.body_area)}${inj.side && inj.side !== 'n/a' ? ' (' + inj.side + ')' : ''}</span>
        <span class="content-type-badge" style="background:var(--bg-input);color:var(--text-dim)">${inj.injury_type || ''}</span>
        ${inj.severity ? `<span class="effort-badge" style="background:${sevColor}22;color:${sevColor};font-size:0.75rem;padding:3px 10px">Severity: ${inj.severity}/10</span>` : ''}
      </div>
      ${inj.onset_date ? `<div class="workout-detail-section"><div class="workout-detail-label">Dates</div><div class="workout-detail-value">Onset: ${new Date(inj.onset_date).toLocaleDateString()}${inj.resolved_date ? ' — Resolved: ' + new Date(inj.resolved_date).toLocaleDateString() : ''}</div></div>` : ''}
      ${section('Mechanism', inj.mechanism)}
      ${section('Symptoms', inj.symptoms)}
      ${section('Aggravating Movements', inj.aggravating_movements)}
      ${section('Relieving Factors', inj.relieving_factors)}
      ${section('Treatment', inj.treatment)}
      ${section('Workout Modifications', inj.modifications)}
      ${section('Prevention Notes', inj.prevention_notes)}
    `;

    if (inj.tags?.length) {
      html += `<div class="transcript-speakers" style="margin-top:8px">${inj.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join('')}</div>`;
    }

    html += `
      <div style="display:flex;gap:8px;margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
        <button class="btn-action" onclick="editInjury('${inj.id}')">Edit</button>
        ${inj.status !== 'resolved' ? `<button class="btn-action" style="background:#22c55e22;color:#22c55e" onclick="resolveInjury('${inj.id}')">Mark Resolved</button>` : ''}
        <button class="btn-action btn-action-danger" onclick="deleteInjury('${inj.id}')">Delete</button>
      </div>
    `;

    openModal(inj.title, html);
  } catch (e) { showToast(e.message); }
}

function showInjuryForm(existing) {
  const inj = existing || {};
  const html = `
    <form onsubmit="saveInjury(event, '${inj.id || ''}')">
      <div class="form-group"><label>Title *</label><input name="title" value="${esc(inj.title || '')}" required placeholder="e.g. Left shoulder impingement"></div>
      <div class="form-row">
        <div class="form-group"><label>Body Area *</label><input name="body_area" value="${esc(inj.body_area || '')}" required placeholder="shoulder, knee, lower_back..."></div>
        <div class="form-group"><label>Side</label><select name="side">
          ${['n/a','left','right','bilateral','central'].map(s => `<option value="${s}" ${(inj.side || 'n/a') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Type</label><select name="injury_type">
          ${['strain','sprain','tendinitis','soreness','tightness','pain','fracture','contusion','overuse','other'].map(t => `<option value="${t}" ${(inj.injury_type || 'strain') === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="form-group"><label>Severity (1-10)</label><input type="number" name="severity" value="${inj.severity || ''}" min="1" max="10"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Status</label><select name="status">
          ${['active','monitoring','recovering','resolved','chronic'].map(s => `<option value="${s}" ${(inj.status || 'active') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
        <div class="form-group"><label>Onset Date</label><input type="date" name="onset_date" value="${inj.onset_date ? inj.onset_date.slice(0,10) : ''}"></div>
      </div>
      <div class="form-group"><label>Mechanism (how it happened)</label><textarea name="mechanism" rows="2">${esc(inj.mechanism || '')}</textarea></div>
      <div class="form-group"><label>Symptoms</label><textarea name="symptoms" rows="2">${esc(inj.symptoms || '')}</textarea></div>
      <div class="form-group"><label>Aggravating Movements</label><textarea name="aggravating_movements" rows="2" placeholder="Movements that make it worse...">${esc(inj.aggravating_movements || '')}</textarea></div>
      <div class="form-group"><label>Relieving Factors</label><textarea name="relieving_factors" rows="2" placeholder="What helps...">${esc(inj.relieving_factors || '')}</textarea></div>
      <div class="form-group"><label>Treatment</label><textarea name="treatment" rows="2">${esc(inj.treatment || '')}</textarea></div>
      <div class="form-group"><label>Workout Modifications</label><textarea name="modifications" rows="2" placeholder="How to modify workouts to avoid aggravation...">${esc(inj.modifications || '')}</textarea></div>
      <div class="form-group"><label>Prevention Notes</label><textarea name="prevention_notes" rows="2">${esc(inj.prevention_notes || '')}</textarea></div>
      <div class="form-group"><label>Tags (comma separated)</label><input name="tags" value="${(inj.tags || []).join(', ')}"></div>
      <button type="submit" class="btn-submit" style="width:100%;margin-top:8px">${inj.id ? 'Update' : 'Log'} Injury</button>
    </form>
  `;
  openModal(inj.id ? 'Edit Injury' : 'Log Injury', html);
}

async function saveInjury(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    title: f.get('title'),
    body_area: f.get('body_area'),
    side: f.get('side'),
    injury_type: f.get('injury_type'),
    severity: f.get('severity') ? parseInt(f.get('severity')) : null,
    status: f.get('status'),
    onset_date: f.get('onset_date') || null,
    mechanism: f.get('mechanism') || null,
    symptoms: f.get('symptoms') || null,
    aggravating_movements: f.get('aggravating_movements') || null,
    relieving_factors: f.get('relieving_factors') || null,
    treatment: f.get('treatment') || null,
    modifications: f.get('modifications') || null,
    prevention_notes: f.get('prevention_notes') || null,
    tags: f.get('tags') ? f.get('tags').split(',').map(t => t.trim()).filter(Boolean) : [],
  };
  try {
    if (id) await api(`/training/injuries/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/training/injuries', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    loadTraining();
  } catch (err) { showToast(err.message); }
}

async function editInjury(id) {
  try {
    const inj = await api(`/training/injuries/${id}`);
    closeModal();
    setTimeout(() => showInjuryForm(inj), 200);
  } catch (e) { showToast(e.message); }
}

async function resolveInjury(id) {
  try {
    await api(`/training/injuries/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'resolved', resolved_date: new Date().toISOString().slice(0,10) }) });
    closeModal();
    loadTraining();
  } catch (e) { showToast(e.message); }
}

async function deleteInjury(id) {
  if (!confirm('Delete this injury record?')) return;
  try { await api(`/training/injuries/${id}`, { method: 'DELETE' }); closeModal(); loadTraining(); }
  catch (e) { showToast(e.message); }
}

// ── Training Day View ──
let trainingDayDate = new Date().toISOString().slice(0, 10);

async function loadTrainingDay() {
  const container = document.getElementById('training-content');
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <button class="btn-action" onclick="trainingDayDate=shiftDate(trainingDayDate,-1);loadTrainingDay()">&larr;</button>
      <input type="date" value="${trainingDayDate}" onchange="trainingDayDate=this.value;loadTrainingDay()" style="flex:1;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);text-align:center">
      <button class="btn-action" onclick="trainingDayDate=shiftDate(trainingDayDate,1);loadTrainingDay()">&rarr;</button>
      <button class="btn-action" onclick="trainingDayDate=new Date().toISOString().slice(0,10);loadTrainingDay()">Today</button>
    </div>
    <div id="day-view-content"><div class="loading">Loading...</div></div>
  `;

  try {
    const data = await api(`/training/day/${trainingDayDate}`);
    const dv = document.getElementById('day-view-content');
    const dateLabel = new Date(trainingDayDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    let html = `<h3 style="color:var(--accent);margin-bottom:12px">${dateLabel}</h3>`;

    // Active Plan
    if (data.active_plan) {
      html += `<div class="card" style="border-left:3px solid #22c55e;margin-bottom:12px;padding:10px 14px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Active Plan</div>
        <div style="font-weight:700">${esc(data.active_plan.title)}</div>
        ${data.active_plan.phase ? `<div style="font-size:0.8rem;color:var(--accent)">Phase: ${esc(data.active_plan.phase)}</div>` : ''}
        ${data.active_plan.goal ? `<div style="font-size:0.8rem;color:var(--text-dim);margin-top:2px">${esc(data.active_plan.goal)}</div>` : ''}
      </div>`;
    }

    // Active Injuries
    if (data.active_injuries?.length) {
      html += `<div class="card" style="border-left:3px solid #ef4444;margin-bottom:12px;padding:10px 14px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--red);margin-bottom:4px">Active Injuries (${data.active_injuries.length})</div>
        ${data.active_injuries.map(inj => {
          const sevColor = inj.severity >= 7 ? '#ef4444' : inj.severity >= 4 ? '#f59e0b' : '#22c55e';
          return `<div style="margin-bottom:4px"><span style="color:${sevColor};font-weight:700">${inj.severity || '?'}/10</span> ${esc(inj.title)} <span style="color:var(--text-dim)">(${esc(inj.body_area)})</span>${inj.modifications ? `<div style="font-size:0.75rem;color:var(--text-dim);padding-left:28px">Mod: ${esc(inj.modifications)}</div>` : ''}</div>`;
        }).join('')}
      </div>`;
    }

    // Nutrition Context
    if (data.nutrition_context) {
      const nc = data.nutrition_context;
      html += `<div class="card" style="border-left:3px solid #06b6d4;margin-bottom:12px;padding:10px 14px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Daily Context</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:0.8rem">
          ${nc.day_type ? `<span><strong>Type:</strong> ${nc.day_type}</span>` : ''}
          ${nc.energy_rating ? `<span><strong>Energy:</strong> ${nc.energy_rating}/10</span>` : ''}
          ${nc.sleep_hours ? `<span><strong>Sleep:</strong> ${nc.sleep_hours}h</span>` : ''}
          ${nc.sleep_quality ? `<span><strong>Sleep Q:</strong> ${nc.sleep_quality}/10</span>` : ''}
          ${nc.recovery_rating ? `<span><strong>Recovery:</strong> ${nc.recovery_rating}/10</span>` : ''}
          ${nc.hydration_liters ? `<span><strong>Water:</strong> ${nc.hydration_liters}L</span>` : ''}
        </div>
        ${nc.notes ? `<div style="font-size:0.8rem;color:var(--text-dim);margin-top:4px">${esc(nc.notes)}</div>` : ''}
      </div>`;
    }

    // Workouts
    if (data.workouts?.length) {
      const typeColors = { hill: '#f59e0b', strength: '#ef4444', run: '#3b82f6', hybrid: '#8b5cf6', recovery: '#10b981', ruck: '#78716c' };
      html += `<div class="card" style="margin-bottom:12px;padding:10px 14px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px">Workouts (${data.workouts.length})</div>
        ${data.workouts.map(w => {
          const c = typeColors[w.workout_type] || '#6366f1';
          return `<div class="list-item" onclick="showWorkoutDetail('${w.id}')" style="border-left:3px solid ${c};cursor:pointer;margin-bottom:6px">
            <div class="transcript-card-header"><div class="list-item-title">${esc(w.title)}</div>
              <span class="content-type-badge" style="background:${c}22;color:${c}">${w.workout_type}</span>
              ${w.effort ? `<span class="effort-badge effort-${w.effort >= 8 ? 'high' : w.effort >= 5 ? 'med' : 'low'}">${w.effort}/10</span>` : ''}
            </div>
            ${w.focus ? `<div style="font-size:0.8rem;color:var(--text-dim)">${esc(w.focus)}</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    }

    // Meals
    if (data.meals?.length) {
      html += `<div class="card" style="margin-bottom:12px;padding:10px 14px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px">Meals (${data.meals.length})</div>
        ${data.meals.map(m => `<div style="margin-bottom:4px;font-size:0.8rem">
          ${m.meal_time ? `<span style="color:var(--text-dim)">${m.meal_time.slice(0,5)}</span> ` : ''}
          <strong>${esc(m.title)}</strong>
          ${m.calories ? ` · ${m.calories}cal` : ''}${m.protein_g ? ` · ${m.protein_g}g protein` : ''}
        </div>`).join('')}
      </div>`;
    }

    // Body Metrics
    if (data.body_metrics?.length) {
      const bm = data.body_metrics[0];
      html += `<div class="card" style="margin-bottom:12px;padding:10px 14px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Body Metrics</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:0.8rem">
          <span><strong>Weight:</strong> ${bm.weight_lb} lb</span>
          ${bm.body_fat_pct ? `<span><strong>BF:</strong> ${bm.body_fat_pct}%</span>` : ''}
          ${bm.muscle_mass_lb ? `<span><strong>Muscle:</strong> ${bm.muscle_mass_lb} lb</span>` : ''}
        </div>
      </div>`;
    }

    // Coaching Sessions
    if (data.coaching_sessions?.length) {
      html += `<div class="card" style="border-left:3px solid #a855f7;margin-bottom:12px;padding:10px 14px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px">Coaching Sessions</div>
        ${data.coaching_sessions.map(s => `<div class="list-item" onclick="showCoachingDetail('${s.id}')" style="cursor:pointer;margin-bottom:6px;padding:8px">
          <div class="list-item-title" style="font-size:0.85rem">${esc(s.title)}</div>
          ${s.summary ? `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:2px;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">${esc(s.summary)}</div>` : ''}
        </div>`).join('')}
      </div>`;
    }

    // Empty state
    if (!data.workouts?.length && !data.meals?.length && !data.nutrition_context && !data.body_metrics?.length && !data.coaching_sessions?.length) {
      html += '<div class="empty-state">No data for this date.</div>';
    }

    dv.innerHTML = html;
  } catch (e) {
    document.getElementById('day-view-content').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Utilities ────────────────────────────────────────────────
function esc(str) { if(!str)return''; const d=document.createElement('div'); d.textContent=String(str); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

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
