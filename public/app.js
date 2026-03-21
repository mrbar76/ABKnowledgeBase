// --- AB Brain — Full SPA with bottom tabs ---

const API = '/api';
function photoUrl(filename) {
  const key = sessionStorage.getItem('ab_api_key') || localStorage.getItem('ab_api_key') || '';
  return `${API}/progress/photos/file/${encodeURIComponent(filename)}?api_key=${encodeURIComponent(key)}`;
}
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
  if (['workouts', 'nutrition', 'body', 'training', 'progress'].includes(tab)) {
    fitnessSubTab = tab;
    tab = 'fitness';
    currentTab = 'fitness';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'fitness'));
  }

  // Map legacy tab names
  if (tab === 'kanban') { tab = 'tasks'; currentTab = 'tasks'; tasksSubTab = 'kanban';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'tasks'));
  }

  if (tab === 'home') loadDashboard();
  else if (tab === 'tasks') loadTasks();
  else if (tab === 'brain') loadBrain();
  else if (tab === 'transcripts') { brainSubTab = 'transcripts'; loadBrain(); }
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
    <div id="gamification-section"></div>
    <div id="dash-content">
      <div class="dash-section">
        <div class="dash-section-header">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
          Tasks
        </div>
        <div class="stats-grid">${skeletonStats(6)}</div>
      </div>
      <div class="dash-section">
        <div class="dash-section-header">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
          Knowledge Base
        </div>
        <div class="stats-grid">${skeletonStats(4)}</div>
      </div>
      <div class="dash-section">
        <div class="dash-section-header">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z"/></svg>
          Fitness
        </div>
        <div class="stats-grid">${skeletonStats(6)}</div>
      </div>
    </div>
  `;

  loadDashboardStats();
  loadGamification();
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

    const dueToday = data.tasks.due_today || 0;
    const dueWeek = data.tasks.due_this_week || 0;
    const todo = data.tasks.by_status.todo || 0;
    const review = data.tasks.by_status.review || 0;
    const done = data.tasks.by_status.done || 0;

    const taskCards = [
      { label: 'To Do', value: todo, color: '#6b7280', icon: '\u{1F4CB}', tab: 'tasks' },
      { label: 'In Progress', value: inProgress, color: '#3b82f6', icon: '\u{1F525}', tab: 'tasks' },
      { label: 'In Review', value: review, color: '#f59e0b', icon: '\u{1F50D}', tab: 'tasks' },
      { label: 'Done', value: done, color: '#22c55e', icon: '\u2705', tab: 'tasks' },
      { label: 'Due Today', value: dueToday, color: dueToday > 0 ? '#ef4444' : '#6b7280', icon: '\u{1F4C5}', tab: 'tasks' },
      { label: 'This Week', value: dueWeek, color: dueWeek > 0 ? '#f97316' : '#6b7280', icon: '\u{1F4C6}', tab: 'tasks' },
    ];

    const kbCards = [
      { label: 'Conversations', value: data.conversations.total, color: '#a855f7', icon: '\u{1F4AC}', tab: 'brain', sub: 'conversations' },
      { label: 'Transcripts', value: data.transcripts.total, color: '#f59e0b', icon: '\u{1F399}', tab: 'brain', sub: 'transcripts' },
      { label: 'Facts', value: data.facts.total, color: '#06b6d4', icon: '\u{1F4CC}', tab: 'brain', sub: 'facts' },
      { label: 'Knowledge', value: data.knowledge.total, color: '#818cf8', icon: '\u{1F9E0}', tab: 'brain', sub: 'knowledge' },
    ];

    function renderRingCard(c, onclick) {
      return `<div class="ring-card clickable" onclick="${onclick}">
        <div class="ring-icon" style="background:${c.color}18;color:${c.color}">${c.icon}</div>
        <div class="ring-value" style="color:${c.color}" data-target="${c.value}">0</div>
        <div class="ring-label">${c.label}</div>
      </div>`;
    }

    container.innerHTML = `
      <div class="dash-section fade-in stagger-1" onclick="switchTab('tasks')" style="cursor:pointer">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:#3b82f618;color:#3b82f6">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
            Tasks
          </div>
        </div>
        <div class="ring-grid">${taskCards.map(c => renderRingCard(c, `event.stopPropagation();switchTab('${c.tab}')`)).join('')}</div>
      </div>

      <div class="dash-section fade-in stagger-2" onclick="switchTab('brain')" style="cursor:pointer">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:#818cf818;color:#818cf8">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            Knowledge Base
          </div>
        </div>
        <div class="ring-grid">${kbCards.map(c => renderRingCard(c, `event.stopPropagation();brainSubTab='${c.sub}';switchTab('${c.tab}')`)).join('')}</div>
      </div>

      <div class="dash-section fade-in stagger-3" onclick="switchTab('fitness')" style="cursor:pointer">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:#22c55e18;color:#22c55e">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29z"/></svg>
            Fitness
          </div>
        </div>
        <div class="ring-grid">${fitnessCards.map(c => renderRingCard(c, `event.stopPropagation();fitnessSubTab='${c.sub}';switchTab('fitness')`)).join('')}</div>
      </div>

      <div class="card fade-in stagger-4" id="activity-card" style="display:none">
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

// ─── Gamification (Rings, Streaks, Badges, Nudges, Push) ─────

const RING_COLORS = { train: '#ef4444', execute: '#818cf8', recover: '#22c55e' };
const RING_LABELS = { train: 'Train', execute: 'Execute', recover: 'Recover' };
const RING_DESCRIPTIONS = {
  train: { what: 'Log workouts', how: 'Go to Fitness > Workouts and log a workout session', unit: 'workouts', min: 1, max: 5 },
  execute: { what: 'Complete tasks', how: 'Mark tasks as Done in the Tasks tab', unit: 'tasks', min: 1, max: 15 },
  recover: { what: 'Log meals + daily context', how: 'Log meals in Fitness > Nutrition and fill in your daily context (sleep, hydration, energy)', unit: 'entries', min: 1, max: 10 },
};
const RING_GOAL_KEYS = { train: 'ring_train_goal', execute: 'ring_execute_goal', recover: 'ring_recover_goal' };
let _badgesOpen = false;
let _ringsDetailOpen = false;
let _gamificationData = null; // cached for re-renders

function buildRingSVG(rings) {
  const defs = [
    { key: 'train', r: 78, sw: 14 },
    { key: 'execute', r: 60, sw: 14 },
    { key: 'recover', r: 42, sw: 14 },
  ];
  let paths = '';
  for (const d of defs) {
    const circ = 2 * Math.PI * d.r;
    const pct = rings[d.key]?.percent || 0;
    const offset = circ - (pct / 100) * circ;
    const color = RING_COLORS[d.key];
    paths += `<circle cx="90" cy="90" r="${d.r}" stroke="${color}" stroke-width="${d.sw}" class="ring-bg"/>`;
    paths += `<circle cx="90" cy="90" r="${d.r}" stroke="${color}" stroke-width="${d.sw}" class="ring-progress" stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-target-offset="${offset}" data-circ="${circ}"/>`;
  }
  return `<svg viewBox="0 0 180 180" class="rings-svg">${paths}</svg>`;
}

function buildRingDetailCards(rings) {
  return Object.keys(RING_COLORS).map(k => {
    const ring = rings[k] || { current: 0, goal: 1, percent: 0 };
    const closed = ring.percent >= 100;
    const desc = RING_DESCRIPTIONS[k];
    const remaining = Math.max(0, ring.goal - ring.current);
    const statusText = closed ? 'Closed!' : `${remaining} more to close`;
    return `<div class="ring-detail-card ${closed ? 'ring-closed' : ''}" style="--ring-color:${RING_COLORS[k]}">
      <div class="ring-detail-header">
        <span class="ring-detail-dot" style="background:${RING_COLORS[k]}"></span>
        <span class="ring-detail-name">${RING_LABELS[k]}</span>
        <span class="ring-detail-progress" style="color:${RING_COLORS[k]}">${ring.current}/${ring.goal}</span>
        ${closed ? '<span class="ring-detail-check">&#10003;</span>' : ''}
      </div>
      <div class="ring-detail-bar-track"><div class="ring-detail-bar-fill" style="width:${ring.percent}%;background:${RING_COLORS[k]}"></div></div>
      <div class="ring-detail-desc"><strong>${desc.what}</strong> &mdash; ${statusText}</div>
      ${!closed ? `<div class="ring-detail-how">${desc.how}</div>` : ''}
      <div class="ring-goal-editor" onclick="event.stopPropagation()">
        <span class="ring-goal-label">Daily goal:</span>
        <button class="ring-goal-btn" onclick="adjustRingGoal('${k}', -1)" ${ring.goal <= desc.min ? 'disabled' : ''}>-</button>
        <span class="ring-goal-value" id="goal-val-${k}">${ring.goal}</span>
        <button class="ring-goal-btn" onclick="adjustRingGoal('${k}', 1)" ${ring.goal >= desc.max ? 'disabled' : ''}>+</button>
        <span class="ring-goal-unit">${desc.unit}/day</span>
      </div>
    </div>`;
  }).join('');
}

function buildWeeklyBar(weekly) {
  if (!weekly || !weekly.train) return '';
  const w = weekly;
  const bars = [
    { label: 'Train', value: w.train.days_active, target: w.train.target_days, color: RING_COLORS.train, detail: `${w.train.total_workouts} workouts across ${w.train.days_active} days` },
    { label: 'Execute', value: w.execute.days_active, target: Math.min(7, Math.ceil(w.execute.target_tasks / (_gamificationData?.settings?.ring_execute_goal || 3))), color: RING_COLORS.execute, detail: `${w.execute.total_tasks} tasks across ${w.execute.days_active} days` },
    { label: 'Recover', value: w.recover.days_closed, target: w.recover.target_days, color: RING_COLORS.recover, detail: `${w.recover.total_entries} entries across ${w.recover.days_closed} days` },
  ];
  const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const today = (new Date().getDay() + 6) % 7; // 0=Mon

  return `
    <div class="weekly-section">
      <div class="weekly-header">
        <span class="weekly-title">This Week</span>
        <span class="weekly-perfect">${w.perfect_days} perfect day${w.perfect_days !== 1 ? 's' : ''}</span>
      </div>
      <div class="weekly-bars">
        ${bars.map(b => {
          const pct = Math.min(100, Math.round((b.value / Math.max(1, b.target)) * 100));
          return `<div class="weekly-bar-row" title="${b.detail}">
            <span class="weekly-bar-label" style="color:${b.color}">${b.label}</span>
            <div class="weekly-bar-track"><div class="weekly-bar-fill" style="width:${pct}%;background:${b.color}"></div></div>
            <span class="weekly-bar-count">${b.value}/${b.target}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="weekly-day-dots">
        ${dayLabels.map((l, i) => `<span class="weekly-dot${i <= today ? ' past' : ''}${i === today ? ' today' : ''}">${l}</span>`).join('')}
      </div>
    </div>
  `;
}

function buildSuggestionCards(suggestions) {
  if (!suggestions?.length) return '';
  return suggestions.map(s => {
    const color = RING_COLORS[s.ring] || 'var(--accent)';
    const icon = s.direction === 'up' ? '&#9650;' : '&#9660;';
    const actionLabel = s.direction === 'up' ? 'Level Up' : 'Adjust';
    return `<div class="suggestion-card" style="--sug-color:${color}">
      <div class="suggestion-body">
        <span class="suggestion-icon" style="color:${color}">${icon}</span>
        <span class="suggestion-text">${esc(s.reason)}</span>
      </div>
      <button class="suggestion-apply" onclick="event.stopPropagation();applySuggestion('${s.ring}', ${s.suggested_goal})" style="background:${color}">
        ${actionLabel} to ${s.suggested_goal}
      </button>
    </div>`;
  }).join('');
}

async function adjustRingGoal(ring, delta) {
  const desc = RING_DESCRIPTIONS[ring];
  const valEl = document.getElementById(`goal-val-${ring}`);
  if (!valEl) return;
  const current = parseInt(valEl.textContent) || 1;
  const newVal = Math.max(desc.min, Math.min(desc.max, current + delta));
  if (newVal === current) return;

  valEl.textContent = newVal;
  try {
    await api('/gamification/settings', {
      method: 'PUT',
      body: JSON.stringify({ [RING_GOAL_KEYS[ring]]: newVal }),
    });
    showToast(`${RING_LABELS[ring]} goal updated to ${newVal}`, 'success', 2000);
    // Refresh gamification to reflect new percentages
    setTimeout(() => loadGamification(), 300);
  } catch (err) {
    valEl.textContent = current; // revert
    showToast(`Failed to update: ${err.message}`, 'error');
  }
}

async function applySuggestion(ring, newGoal) {
  try {
    await api('/gamification/settings', {
      method: 'PUT',
      body: JSON.stringify({ [RING_GOAL_KEYS[ring]]: newGoal }),
    });
    showToast(`${RING_LABELS[ring]} goal updated to ${newGoal}`, 'success', 2000);
    setTimeout(() => loadGamification(), 300);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

function buildStreakChips(streaks) {
  const defs = [
    { key: 'train', icon: '🔥', label: 'Train', desc: 'Consecutive days with at least 1 workout logged' },
    { key: 'execute', icon: '⚡', label: 'Execute', desc: 'Consecutive days with at least 1 task completed' },
    { key: 'recover', icon: '🌿', label: 'Recover', desc: 'Consecutive days with meals + daily context logged' },
    { key: 'perfect_day', icon: '💎', label: 'Perfect', desc: 'Consecutive days with all 3 rings closed' },
    { key: 'weigh_in', icon: '📊', label: 'Weigh-in', desc: 'Consecutive days with a body metric logged' },
  ];
  return defs.map(d => {
    const val = streaks[d.key] || 0;
    const active = val > 0 ? ' active' : '';
    return `<div class="streak-chip${active}" title="${d.desc}">
      <span class="streak-icon">${d.icon}</span>
      <span class="streak-count">${val}d</span>
      <span>${d.label}</span>
    </div>`;
  }).join('');
}

function buildNudges(nudges) {
  if (!nudges?.length) return '';
  return nudges.map(n => {
    const type = n.type === 'success' ? 'success' : n.type === 'warning' ? 'warning' : 'info';
    const icon = type === 'success' ? '&#10003;' : type === 'warning' ? '!' : 'i';
    return `<div class="nudge-banner nudge-${type}"><span class="nudge-icon-circle nudge-icon-${type}">${icon}</span><span>${esc(n.message)}</span></div>`;
  }).join('');
}

function buildBadgeGrid(badges) {
  const unlocked = (badges.unlocked || []).map(b => ({ ...b, isUnlocked: true }));
  const locked = (badges.locked || []).map(b => ({ ...b, isUnlocked: false }));
  const all = [...unlocked, ...locked];

  // Group by category
  const categories = { milestone: 'Milestones', streak: 'Streak Badges', variety: 'Variety' };
  const grouped = {};
  for (const b of all) {
    const cat = b.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(b);
  }

  let html = '';
  for (const [cat, catBadges] of Object.entries(grouped)) {
    const catLabel = categories[cat] || cat;
    const catUnlocked = catBadges.filter(b => b.isUnlocked).length;
    html += `<div class="badge-category-label">${catLabel} <span class="badge-category-count">${catUnlocked}/${catBadges.length}</span></div>`;
    html += `<div class="badge-list">`;
    for (const b of catBadges) {
      const cls = b.isUnlocked ? 'unlocked' : 'locked';
      const dateStr = b.isUnlocked && b.unlocked_at ? new Date(b.unlocked_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      html += `<div class="badge-row badge-${cls}" onclick="showBadgeDetail(this)" data-name="${esc(b.name)}" data-desc="${esc(b.description)}" data-icon="${b.icon}" data-unlocked="${b.isUnlocked ? '1' : '0'}" data-date="${dateStr}">
        <span class="badge-row-icon">${b.icon}</span>
        <div class="badge-row-info">
          <div class="badge-row-name">${esc(b.name)}</div>
          <div class="badge-row-desc">${esc(b.description)}</div>
        </div>
        ${b.isUnlocked ? `<span class="badge-row-date">${dateStr}</span>` : '<span class="badge-row-lock">&#128274;</span>'}
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

function showBadgeDetail(el) {
  const name = el.dataset.name;
  const desc = el.dataset.desc;
  const icon = el.dataset.icon;
  const unlocked = el.dataset.unlocked === '1';
  const date = el.dataset.date;

  // Remove any existing expanded detail
  document.querySelectorAll('.badge-detail-expanded').forEach(e => e.remove());

  const detail = document.createElement('div');
  detail.className = 'badge-detail-expanded';
  detail.innerHTML = `
    <div class="badge-detail-icon">${icon}</div>
    <div class="badge-detail-body">
      <div class="badge-detail-name">${name}</div>
      <div class="badge-detail-desc">${desc}</div>
      ${unlocked ? `<div class="badge-detail-status unlocked">Unlocked ${date}</div>` : `<div class="badge-detail-status locked">Not yet unlocked &mdash; keep going!</div>`}
    </div>
  `;
  el.after(detail);
  // Toggle off on second click
  el.addEventListener('click', function handler() {
    detail.remove();
    el.removeEventListener('click', handler);
  }, { once: true });
}

async function loadGamification() {
  const container = document.getElementById('gamification-section');
  if (!container) return;

  try {
    const data = await api('/gamification');
    _gamificationData = data;
    const { rings, streaks, badges, nudges, suggestions, weekly } = data;

    // Filter nudges: separate level-up suggestions from regular nudges
    const regularNudges = (nudges || []).filter(n => n.type !== 'level_up');

    // Check push permission
    let pushBanner = '';
    if ('Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window) {
      const perm = Notification.permission;
      if (perm === 'default' && !localStorage.getItem('ab_push_dismissed')) {
        pushBanner = `<div class="push-banner" id="push-permission-banner">
          <span>🔔</span>
          <span style="flex:1">Enable notifications to stay on track</span>
          <button class="push-allow" onclick="requestPushPermission()">Allow</button>
          <button class="push-later" onclick="dismissPushBanner()">Later</button>
        </div>`;
      }
    }

    const allClosed = rings.train?.percent >= 100 && rings.execute?.percent >= 100 && rings.recover?.percent >= 100;

    container.innerHTML = `
      ${pushBanner}
      <div class="rings-hero fade-in" onclick="toggleRingsDetail()">
        <div class="rings-container">
          ${buildRingSVG(rings)}
          <div class="rings-center-label"><span class="rings-a">${allClosed ? '&#10003;' : 'A'}</span></div>
        </div>
        <div class="rings-legend">
          ${Object.keys(RING_COLORS).map(k => {
            const r = rings[k] || {};
            const closed = r.percent >= 100;
            return `<div class="rings-legend-item">
              <span class="rings-legend-dot" style="background:${RING_COLORS[k]}"></span>
              <span>${RING_LABELS[k]}</span>
              <span class="rings-legend-value" style="color:${RING_COLORS[k]}">${r.current || 0}/${r.goal || 0}${closed ? ' &#10003;' : ''}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="rings-tap-hint">Tap for details &amp; adjust goals</div>
      </div>
      <div class="rings-detail-panel${_ringsDetailOpen ? ' open' : ''}" id="rings-detail-panel">
        <div class="rings-detail-title">How to close your rings</div>
        ${buildRingDetailCards(rings)}
      </div>
      ${buildWeeklyBar(weekly)}
      <div class="streaks-row fade-in stagger-1">${buildStreakChips(streaks)}</div>
      ${suggestions?.length ? `<div class="suggestions-container fade-in stagger-1">${buildSuggestionCards(suggestions)}</div>` : ''}
      <div id="nudges-container" class="fade-in stagger-1">${buildNudges(regularNudges)}</div>
      <div class="badges-section fade-in stagger-2">
        <div class="badges-toggle${_badgesOpen ? ' open' : ''}" onclick="toggleBadges()">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
          Badges
          <span class="badge-progress-text">${badges.total_unlocked}/${badges.total_available} unlocked</span>
        </div>
        <div id="badge-grid" style="display:${_badgesOpen ? 'block' : 'none'}">
          ${buildBadgeGrid(badges)}
        </div>
      </div>
    `;

    // Animate ring progress after render
    requestAnimationFrame(() => {
      setTimeout(() => {
        container.querySelectorAll('.ring-progress').forEach(el => {
          el.style.strokeDashoffset = el.dataset.targetOffset;
        });
      }, 100);
    });

    // Show badge unlock toasts
    if (badges.newly_unlocked?.length) {
      for (const b of badges.newly_unlocked) {
        showToast(`${b.icon} Badge unlocked: ${b.name} — ${b.description}`, 'success', 5000);
      }
    }
  } catch (err) {
    console.warn('[gamification]', err.message);
  }
}

function toggleRingsDetail() {
  _ringsDetailOpen = !_ringsDetailOpen;
  const panel = document.getElementById('rings-detail-panel');
  if (panel) panel.classList.toggle('open', _ringsDetailOpen);
}

function toggleBadges() {
  _badgesOpen = !_badgesOpen;
  const grid = document.getElementById('badge-grid');
  const toggle = document.querySelector('.badges-toggle');
  if (grid) grid.style.display = _badgesOpen ? 'block' : 'none';
  if (toggle) toggle.classList.toggle('open', _badgesOpen);
}

// ─── Push Notification Permission ────────────────────────────

async function requestPushPermission() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      dismissPushBanner();
      return;
    }

    // Get VAPID public key
    const { key: vapidKey } = await api('/gamification/notifications/vapid-public-key');
    if (!vapidKey) { showToast('Push setup incomplete — VAPID key missing', 'warning'); return; }

    // Subscribe
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    // Send subscription to backend
    await api('/gamification/notifications/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });

    dismissPushBanner();
    showToast('Notifications enabled!', 'success');
  } catch (err) {
    showToast(`Push setup failed: ${err.message}`, 'error');
  }
}

function dismissPushBanner() {
  localStorage.setItem('ab_push_dismissed', '1');
  const banner = document.getElementById('push-permission-banner');
  if (banner) banner.remove();
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
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

async function handleChatGPTImport(input) {
  const file = input.files[0];
  if (!file) return;

  const btn = document.getElementById('chatgpt-import-btn');
  const progress = document.getElementById('chatgpt-import-progress');
  const bar = document.getElementById('chatgpt-import-bar');
  const status = document.getElementById('chatgpt-import-status');
  const count = document.getElementById('chatgpt-import-count');
  const result = document.getElementById('chatgpt-import-result');

  btn.disabled = true;
  btn.textContent = 'Reading file...';
  result.style.display = 'none';

  let conversations;
  try {
    const text = await file.text();
    conversations = JSON.parse(text);
    if (!Array.isArray(conversations)) throw new Error('Expected a JSON array');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Choose conversations.json';
    result.style.display = 'block';
    result.style.color = 'var(--red)';
    result.textContent = 'Error reading file: ' + err.message;
    input.value = '';
    return;
  }

  const total = conversations.length;
  const BATCH = 100;
  let imported = 0, skipped = 0, errors = 0, done = 0;

  progress.style.display = 'block';
  btn.textContent = 'Importing...';

  for (let i = 0; i < total; i += BATCH) {
    const batch = conversations.slice(i, i + BATCH);
    try {
      const res = await api('/conversations/import/chatgpt', {
        method: 'POST',
        body: JSON.stringify(batch)
      });
      imported += res.imported || 0;
      skipped += res.skipped || 0;
      errors += res.errors || 0;
    } catch (err) {
      errors += batch.length;
    }
    done = Math.min(i + BATCH, total);
    const pct = Math.round((done / total) * 100);
    bar.style.width = pct + '%';
    status.textContent = `Importing... ${done} of ${total}`;
    count.textContent = pct + '%';
  }

  progress.style.display = 'none';
  btn.disabled = false;
  btn.textContent = 'Choose conversations.json';
  input.value = '';

  result.style.display = 'block';
  result.style.color = errors > 0 ? 'var(--yellow)' : 'var(--green)';
  result.textContent = `Done: ${imported} imported, ${skipped} already existed, ${errors} errors (${total} total)`;

  if (imported > 0) showToast(`Imported ${imported} ChatGPT conversations`, 'success');
}

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

/* ── GPT System Instructions (copy-paste for Custom GPTs) ── */

function getKbGptInstructions() {
  return `You are Avi's personal AI assistant with full read/write access to his AB Brain knowledge base. AB Brain is Avi's unified personal system for capturing knowledge, managing tasks and projects, reviewing Bee wearable transcripts, and storing AI conversations.

## IDENTITY & TONE
- Be direct, efficient, and concise. Lead with answers, not preamble.
- When saving data, confirm briefly — don't parrot back every field.
- When querying data, summarize findings — don't dump raw JSON.
- Avi is a builder and business owner who tracks everything. Respect his time.

## CRITICAL: SEARCHING & DATE FILTERING

The search system has two distinct paths. Using the wrong one will return zero results.

### Text/Topic Search
Use \`GET /search?q=term\` or \`POST /search/ai\` to find content by keywords or topics.
These search across: knowledge, facts, transcripts, tasks, projects, conversations, workouts, meals, body metrics, training plans, coaching sessions, injuries.

### Date Filtering
**NEVER pass a date string (like "2026-03-18") as a search query.** Dates live in structured timestamp fields, NOT in searchable text. The search index will not find them.

Use the dedicated list endpoints with date parameters instead:
- **Transcripts**: \`GET /transcripts?from=YYYY-MM-DD&to=YYYY-MM-DD\` (use \`from\`/\`to\`)
- **Workouts**: \`GET /workouts?since=YYYY-MM-DD&before=YYYY-MM-DD\`
- **Meals**: \`GET /meals?date=YYYY-MM-DD\` (exact day) or \`since\`/\`before\` (range)
- **Body metrics**: \`GET /body-metrics?since=YYYY-MM-DD&before=YYYY-MM-DD\` or \`?latest=true\`
- **Coaching sessions**: \`GET /training/coaching?since=YYYY-MM-DD&before=YYYY-MM-DD\`
- **Nutrition context**: \`GET /nutrition/daily-context?date=YYYY-MM-DD\`

To combine topic + date: first query by date using the list endpoint, then filter/read the results by content.

## TASK MANAGEMENT

Tasks are a core part of this system. Treat task creation as seriously as any other data entry.

### Creating Tasks
- When Avi says "remind me to…", "I need to…", "add a task for…", "follow up on…", or describes any action item → create a task with \`POST /tasks\`.
- **Always set \`ai_agent: "chatgpt"\`** so Avi knows which AI created it.
- Write clear, actionable titles. Bad: "Pricing stuff". Good: "Send updated pricing proposal to client".
- Use \`description\` for context or background.
- Use \`next_steps\` for the specific immediate action, not just the goal.
- Use \`due_date\` only when there is a real deadline. Never fabricate deadlines.

### Priorities
- \`low\` — nice to have, no time pressure
- \`medium\` — default for most tasks
- \`high\` — important, should be done soon
- \`urgent\` — time-sensitive, needs attention today

### Projects
- Tasks belong to projects. Before creating a task, check \`GET /projects?status=active\` for existing projects.
- If the task fits an existing project, use its \`project_id\`.
- Only create a new project (\`POST /projects\`) if there's genuinely a new initiative.
- Projects have statuses: active, paused, completed, archived.

### Viewing Tasks
- \`GET /tasks/kanban\` — board view organized by status (todo, in_progress, review, done)
- \`GET /tasks?status=todo\` — filter by status
- \`GET /tasks?project_id=UUID\` — all tasks for a project
- \`GET /tasks?ai_agent=chatgpt\` — tasks you created

### Updating Tasks
- When work is done: \`PUT /tasks/:id\` with \`status: "done"\` and \`output_log\` describing what was completed.
- For status changes: update \`status\` and optionally \`next_steps\` for what comes next.
- Before adding a new task, check the kanban to avoid duplicates.

### Extracting Tasks from Transcripts/Meetings
When asked to extract action items from a meeting or transcript:
1. Get the transcript: \`GET /transcripts?from=DATE&to=DATE\` then \`GET /transcripts/:id\` for full text
2. Identify concrete action items with owners
3. Create each as a separate task with \`POST /tasks\`, linking to the right project
4. Set appropriate priorities based on urgency discussed

## KNOWLEDGE ENTRIES

For saving insights, notes, research, how-tos, decisions, and reference material.

- \`POST /knowledge\` — required: \`title\`, \`content\`
- Categories: general, code, meeting, research, decision, reference, personal
- Always include meaningful \`tags\` (lowercase array: ["pricing", "client-name", "q1"])
- Set \`ai_source: "chatgpt"\`
- Search before creating to avoid duplicates: \`GET /knowledge?q=topic\` or \`GET /search?q=topic\`
- Update with \`PUT /knowledge/:id\` — can change title, content, category, tags
- Get full content with \`GET /knowledge/:id\`

## FACTS

For verified claims, data points, and reference facts.

- \`POST /facts\` — required: \`title\`, \`content\`
- Set \`confirmed: true\` when the fact has a reliable source
- Include \`source\` to track where the fact came from
- Use categories to organize (same as knowledge)

## TRANSCRIPTS (Bee Wearable)

Bee wearable auto-syncs conversation transcripts. You don't create these — you read and analyze them.

- **Recent transcripts**: \`GET /transcripts?sort=newest&limit=10\`
- **By date**: \`GET /transcripts?from=YYYY-MM-DD&to=YYYY-MM-DD\`
- **By content**: \`GET /transcripts?q=keyword\`
- **By speaker**: \`GET /transcripts?speaker=name\`
- **Filter by status**: \`?status=unidentified\` or \`?status=identified\`
- **Full text**: \`GET /transcripts/:id\` — returns raw_text, summary, and speaker utterances

The list endpoint returns summaries. Always use the detail endpoint to read the full conversation.

## CONVERSATIONS

For storing important AI conversation threads.

- \`POST /conversations\` — required: \`title\`, \`ai_source\`
- ai_source: "chatgpt", "claude", "gemini"
- Include \`summary\` and optionally \`full_thread\` (array of {role, content, timestamp})
- \`message_count\` for thread size
- Search with \`GET /conversations?q=topic\` or \`?ai_source=chatgpt\`

## SMART INTAKE

\`POST /intake\` with \`{text: "..."}\` — AI auto-classifies raw text into the right table (knowledge, fact, task, or transcript). Use when Avi dumps unstructured info and you're not sure where it goes.

## DASHBOARD & ACTIVITY

- \`GET /dashboard\` — overview stats (knowledge count, task counts by status, transcript count, recent activity)
- \`GET /activity?limit=30\` — recent activity log across all types
- \`GET /activity?entity_type=task\` — filter activity by type

## WORKFLOW PATTERNS

**"What's on my plate?" / "What are my tasks?"**
→ \`GET /tasks/kanban\` for the full board, or \`GET /tasks?status=todo&priority=high\` for focused view.

**"Save this / Remember this / Note that..."**
→ \`POST /knowledge\` with good title, content, category, and tags.

**"What did we talk about in the meeting today?"**
→ \`GET /transcripts?from=TODAY&to=TOMORROW\`, then \`GET /transcripts/:id\` for full text.

**"Pull action items from today's meetings"**
→ Get transcripts by date → read full text → create tasks for each action item.

**"Find that conversation/note about X"**
→ \`GET /search?q=X\` — unified search across ALL types. Or \`POST /search/ai\` for semantic search.

**"What happened recently?"**
→ \`GET /dashboard\` for stats + \`GET /activity?limit=20\` for recent changes.

**"Mark task X as done"**
→ Find the task, then \`PUT /tasks/:id\` with \`{status: "done", output_log: "what was completed"}\`.

**"Create a project for X with tasks"**
→ \`POST /projects\` first, then \`POST /tasks\` for each task with the new \`project_id\`.

## RESPONSE STYLE
- After creating/updating data, give a one-line confirmation with the key info.
- When querying, summarize — don't paste raw API responses.
- If you spot duplicates, stale tasks, or inconsistencies, flag them.
- When Avi shares meeting notes or thoughts, proactively offer to save as knowledge or create tasks.`;
}

function getFitnessGptInstructions() {
  return `You are Avi's AI training coach with full read/write access to his AB Brain fitness platform. AB Brain tracks workouts, meals, nutrition, body composition, training plans, coaching sessions, and injuries. Avi is a competitive obstacle course racer who trains seriously and tracks everything.

## IDENTITY & TONE
- You are a direct, opinionated coach. Lead with the answer.
- Don't over-explain or hedge. Be concise.
- When logging data, confirm briefly — don't parrot back every field.
- When analyzing data, summarize trends and give actionable takeaways.

## CRITICAL: SEARCHING & DATE FILTERING

**NEVER pass a date string (like "2026-03-18") as a search query.** Dates live in structured fields, NOT in searchable text. The search index will not find them.

Use the dedicated list endpoints with date parameters:
- **Workouts**: \`GET /workouts?since=YYYY-MM-DD&before=YYYY-MM-DD\`
- **Meals**: \`GET /meals?date=YYYY-MM-DD\` (exact day) or \`since\`/\`before\` (range)
- **Body metrics**: \`GET /body-metrics?since=YYYY-MM-DD&before=YYYY-MM-DD\` or \`?latest=true\`
- **Coaching sessions**: \`GET /training/coaching?since=YYYY-MM-DD&before=YYYY-MM-DD\`
- **Nutrition context**: \`GET /nutrition/daily-context?date=YYYY-MM-DD\`
- **Full day view**: \`GET /training/day/YYYY-MM-DD\` — cross-references ALL fitness data for a date

For topic/keyword searches use \`GET /search?q=term\` or \`POST /search/ai\`.

## BEFORE ANY COACHING OR TRAINING CONVERSATION
Always run these checks first:
1. \`GET /training/injuries/active/summary\` — check for contraindications FIRST
2. \`GET /training/day/{YYYY-MM-DD}\` — today's full context (workouts, meals, metrics, injuries, plan)
3. \`GET /training/plans?status=active\` — understand the current program

## AFTER COACHING CONVERSATIONS
Always save the session:
1. \`POST /training/coaching\` — save summary with key_decisions, adjustments, next_steps
2. Log any new injury: \`POST /training/injuries\` — include body_area, severity, modifications
3. Update plan if needed: \`PUT /training/plans/:id\`

## LOGGING WORKOUTS

Use \`POST /workouts\`. Required: \`workout_type\`.

- **workout_type**: hill, strength, run, hybrid, recovery, ruck, cycling, swim, yoga, crossfit, hiit, class, machine, walk, hike, rowing, boxing — or any custom value
- Include: focus, warmup, main_sets, carries, exercises[], time_duration, distance, elevation_gain
- **effort** (1-10): always ask for or estimate this
- **Body feedback fields**: grip_feedback, legs_feedback, cardio_feedback, shoulder_feedback, body_notes
- **Performance**: slowdown_notes (where form broke), failure_first (what gave out first)
- **adjustment**: what to change next time
- **exercises[]**: structured array with name, sets, reps, weight, duration, distance, machine, notes
- Tags: lowercase, no # prefix: ["hill", "grip", "race-prep", "spartan"]
- Always set \`ai_source: "chatgpt"\`
- Title auto-generates if omitted
- For historical imports: \`POST /workouts/bulk\` (max 200 per request)

## MEALS & NUTRITION

### Logging Meals
\`POST /meals\` — required: \`title\`, \`meal_date\`
- Estimate macros when Avi describes food casually. Be reasonable, not precise.
- meal_type: breakfast, lunch, dinner, snack, pre-workout, post-workout, drink, supplement
- Include hunger_before, fullness_after, energy_after (1-10) when discussed
- Bulk import: \`POST /meals/bulk\` (max 200)

### Daily Context
\`POST /nutrition/daily-context\` — one per date, tracks non-meal data:
- day_type: rest, strength, run, hill, hybrid, race, travel
- hydration_liters, energy_rating, hunger_rating, cravings, digestion
- sleep_hours, sleep_quality, recovery_rating (all 1-10)
- Returns 409 if context already exists for that date — use \`PATCH /nutrition/daily-context/:id\` to update

### Daily Summaries
- \`GET /nutrition/daily-summary?date=YYYY-MM-DD\` — computed macro totals from meals + context
- \`GET /nutrition/daily-summary/range?since=YYYY-MM-DD&before=YYYY-MM-DD\` — multi-day with averages

## BODY METRICS

RENPHO scale data. Key fields: weight_lb, body_fat_pct, skeletal_muscle_pct, visceral_fat, bmr_kcal, metabolic_age.

- \`POST /body-metrics\` — required: measurement_date, weight_lb
- \`GET /body-metrics?latest=true\` — most recent reading
- \`GET /body-metrics?since=YYYY-MM-DD&before=YYYY-MM-DD\` — for trend analysis
- For trends, look at direction over weeks — don't fixate on single readings
- Bulk import: \`POST /body-metrics/bulk\` (max 200)

## TRAINING PLANS

For periodized programming. Store the WHY behind decisions.

- \`POST /training/plans\` — required: title
- plan_type: block, mesocycle, microcycle, deload, race_prep, rehab, custom
- Include: goal, rationale (WHY this approach), constraints (injuries, schedule, equipment)
- weekly_structure: array of day objects [{day: "Monday", type: "strength", focus: "upper body"}]
- intensity_scheme, progression_notes for how to progress week over week
- Link to project_id if part of a larger initiative

### Before Creating a Plan
1. Review recent workouts: \`GET /workouts?limit=20\`
2. Review body trends: \`GET /body-metrics?limit=10\`
3. Check active injuries: \`GET /training/injuries?status=active\`

## INJURIES

- \`POST /training/injuries\` — required: title, body_area
- severity (1-10): 1=minor discomfort, 5=limits some movements, 10=cannot train
- status: active → monitoring → recovering → resolved (or chronic)
- Track: mechanism (how it happened), symptoms, aggravating_movements, relieving_factors
- **modifications**: workout adjustments to avoid aggravation — this is critical for programming
- prevention_notes: long-term strategy
- Link to related_workout_id if caused during a workout
- Always check \`GET /training/injuries/active/summary\` before recommending exercises

## TASK MANAGEMENT

When training discussions produce action items:
- \`POST /tasks\` with ai_agent: "chatgpt"
- Check \`GET /projects?status=active\` for existing projects first
- Use appropriate priority (low/medium/high/urgent)
- Include next_steps for the immediate action

## WORKFLOW PATTERNS

**"What did I do today/this week?"**
→ \`GET /training/day/YYYY-MM-DD\` or \`GET /workouts?since=DATE&before=DATE\`

**"Log this workout"**
→ \`POST /workouts\` with structured data. Confirm briefly.

**"Log this meal"**
→ \`POST /meals\`. Estimate macros if described casually.

**"How's my weight trending?"**
→ \`GET /body-metrics?since=DATE&before=DATE\` — summarize the trend, don't list every reading.

**"Create a training plan"**
→ Check injuries, recent workouts, body trends. Then \`POST /training/plans\` with rationale.

**"What are my current injuries?"**
→ \`GET /training/injuries/active/summary\`

**"Review my nutrition this week"**
→ \`GET /nutrition/daily-summary/range?since=MONDAY&before=NEXT_MONDAY\`

**"How was my effort this month?"**
→ \`GET /workouts?since=FIRST&before=LAST\` — analyze effort ratings, volume, types.

## RESPONSE STYLE
- After logging data, give a one-line confirmation.
- When analyzing, lead with the insight and back it up with data.
- Flag concerning patterns (overtraining, injury risk, poor recovery, nutrition gaps).
- Proactively suggest saving coaching sessions after substantive training discussions.
- If you see active injuries, always factor them into recommendations without being asked.`;
}

async function copyGptInstructions(type) {
  const isKb = type === 'kb';
  const btn = document.getElementById(isKb ? 'btn-copy-kb-instructions' : 'btn-copy-fitness-instructions');
  const resultEl = document.getElementById(isKb ? 'sm-kb-instructions-result' : 'sm-fitness-instructions-result');
  const label = isKb ? 'KB Instructions' : 'Fitness Instructions';
  const text = isKb ? getKbGptInstructions() : getFitnessGptInstructions();
  try {
    btn.textContent = 'Copying...';
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--accent)';
    resultEl.textContent = 'Instructions copied! Paste into your Custom GPT\u2019s Instructions field.';
    setTimeout(() => { btn.textContent = 'Copy ' + label; }, 3000);
  } catch (err) {
    btn.textContent = 'Copy ' + label;
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

  // Outlook status
  const outlookEl = document.getElementById('sm-outlook-val');
  if (outlookEl) {
    try {
      const olData = await api('/outlook/status');
      if (olData.configured && !olData.error) {
        outlookEl.textContent = `${olData.connected_as} (${olData.outlook_tasks} tasks)`;
        outlookEl.style.color = 'var(--green)';
      } else if (olData.configured) {
        outlookEl.textContent = 'Auth error';
        outlookEl.style.color = 'var(--red)';
      } else {
        outlookEl.textContent = 'Not configured';
        outlookEl.style.color = 'var(--text-dim)';
      }
    } catch {
      outlookEl.textContent = 'Not configured';
      outlookEl.style.color = 'var(--text-dim)';
    }
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

async function triggerOutlookSync() {
  const btn = document.getElementById('sm-btn-outlook-sync');
  const resultEl = document.getElementById('sm-outlook-result');
  if (!resultEl) return;

  if (btn) btn.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';
  resultEl.textContent = 'Syncing flagged emails...';

  try {
    const data = await api('/outlook/sync', { method: 'POST', body: JSON.stringify({}) });
    const parts = [];
    if (data.created) parts.push(`${data.created} created`);
    if (data.completed) parts.push(`${data.completed} completed`);
    if (data.skipped) parts.push(`${data.skipped} skipped`);
    resultEl.style.color = data.errors > 0 ? 'var(--yellow)' : 'var(--green)';
    resultEl.textContent = parts.length ? parts.join(', ') : 'No new flagged emails';
    if (data.errors > 0) resultEl.textContent += ` (${data.errors} errors)`;
  } catch (err) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = err.message.includes('not configured') ? 'Outlook not configured' : `Sync failed: ${err.message}`;
  }

  if (btn) btn.disabled = false;
  if (currentTab === 'tasks') loadTasks();
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

// ─── Tasks (List / Kanban / Calendar) ────────────────────────
let tasksSubTab = 'list';
function tasksTabsHtml() {
  return `<div class="brain-tabs">
    <button class="brain-tab${tasksSubTab==='list'?' active':''}" onclick="tasksSubTab='list';loadTasks()">List</button>
    <button class="brain-tab${tasksSubTab==='kanban'?' active':''}" onclick="tasksSubTab='kanban';loadTasks()">Kanban</button>
    <button class="brain-tab${tasksSubTab==='calendar'?' active':''}" onclick="tasksSubTab='calendar';loadTasks()">Calendar</button>
  </div>`;
}

async function loadTasks() {
  const main = document.getElementById('main-content');
  main.innerHTML = tasksTabsHtml() + '<div class="loading">Loading...</div>';
  if (tasksSubTab === 'kanban') return loadTasksKanban();
  if (tasksSubTab === 'calendar') return loadTasksCalendar();
  return loadTasksList();
}

// ── List View ──
let taskListFilter = '';
let taskPriorityFilter = '';
let taskContextFilter = '';
async function loadTasksList() {
  const main = document.getElementById('main-content');
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (taskListFilter) params.set('status', taskListFilter);
    if (taskPriorityFilter) params.set('priority', taskPriorityFilter);
    if (taskContextFilter) params.set('context', taskContextFilter);
    const data = await api('/tasks?' + params.toString());

    const statusLabels = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
    const statusColors = { todo: 'var(--text-dim)', in_progress: 'var(--blue)', review: 'var(--yellow)', done: 'var(--green)' };
    const priorityLabels = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

    main.innerHTML = tasksTabsHtml() + `
      <div class="flex-between mb-md">
        <div style="display:flex;flex-direction:column;gap:6px">
          <div class="filter-row">
            <button class="filter-btn ${!taskListFilter ? 'active' : ''}" onclick="taskListFilter='';loadTasksList()">All</button>
            ${Object.entries(statusLabels).map(([k, v]) =>
              `<button class="filter-btn ${taskListFilter === k ? 'active' : ''}" onclick="taskListFilter='${k}';loadTasksList()">${v}</button>`
            ).join('')}
          </div>
          <div class="filter-row">
            ${Object.entries(priorityLabels).map(([k, v]) =>
              `<button class="filter-btn filter-btn-sm ${taskPriorityFilter === k ? 'active' : ''}" onclick="taskPriorityFilter=taskPriorityFilter==='${k}'?'':'${k}';loadTasksList()">
                <span class="priority-dot priority-${k}"></span> ${v}
              </button>`
            ).join('')}
            ${taskPriorityFilter ? `<button class="filter-btn filter-btn-sm" onclick="taskPriorityFilter='';loadTasksList()" style="color:var(--text-dim)">Clear</button>` : ''}
          </div>
          <div class="filter-row">
            <button class="filter-btn filter-btn-sm ${taskContextFilter === '' ? 'active' : ''}" onclick="taskContextFilter='';loadTasksList()">All</button>
            <button class="filter-btn filter-btn-sm ${taskContextFilter === 'work' ? 'active' : ''}" onclick="taskContextFilter=taskContextFilter==='work'?'':'work';loadTasksList()">
              <span style="color:var(--blue)">&#9679;</span> Work
            </button>
            <button class="filter-btn filter-btn-sm ${taskContextFilter === 'personal' ? 'active' : ''}" onclick="taskContextFilter=taskContextFilter==='personal'?'':'personal';loadTasksList()">
              <span style="color:var(--green)">&#9679;</span> Personal
            </button>
          </div>
        </div>
        <button class="btn-action btn-compact-sm" onclick="showNewTaskModal()" style="align-self:start">+ Task</button>
      </div>
      <div id="task-list">
        ${data.tasks.length ? data.tasks.map(t => {
          const dueBadge = t.due_date ? (() => {
            const d = new Date(t.due_date); const now = new Date(); now.setHours(0,0,0,0);
            const isOverdue = d < now && t.status !== 'done';
            const isToday = d.toDateString() === now.toDateString();
            const label = isToday ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `<span style="font-size:0.7rem;color:${isOverdue ? 'var(--red)' : isToday ? 'var(--yellow)' : 'var(--text-dim)'}">${label}</span>`;
          })() : '';
          return `
          <div class="list-item" onclick="showTaskDetail('${t.id}')" style="display:flex;align-items:center;gap:10px">
            <input type="checkbox" ${t.status==='done'?'checked':''} onclick="event.stopPropagation();quickToggleTask('${t.id}','${t.status}')" style="cursor:pointer;flex-shrink:0">
            <div style="flex:1;min-width:0">
              <div class="list-item-title" style="${t.status==='done'?'text-decoration:line-through;color:var(--text-dim)':''}">${esc(t.title)}</div>
              <div class="list-item-meta">
                <span class="priority-badge priority-${t.priority}">${t.priority}</span>
                ${t.project_name ? `<span>${esc(t.project_name)}</span>` : ''}
                ${t.context ? `<span class="context-badge context-${t.context}">${t.context}</span>` : ''}
                ${t.ai_agent ? `<span class="k-source-badge source-${t.ai_agent}">${t.ai_agent}</span>` : ''}
                <span style="color:${statusColors[t.status]}">${statusLabels[t.status]}</span>
                ${dueBadge}
              </div>
            </div>
          </div>`;
        }).join('') : '<div class="empty-state">No tasks yet</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = tasksTabsHtml() + `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function quickToggleTask(id, currentStatus) {
  const newStatus = currentStatus === 'done' ? 'todo' : 'done';
  try { await api(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) }); loadTasks(); } catch {}
}

// ── Kanban View ──
async function loadTasksKanban() {
  const main = document.getElementById('main-content');
  try {
    const data = await api('/tasks/kanban');
    const cols = ['todo', 'in_progress', 'review', 'done'];
    const labels = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
    const colors = { todo: 'var(--text-dim)', in_progress: 'var(--blue)', review: 'var(--yellow)', done: 'var(--green)' };

    main.innerHTML = tasksTabsHtml() + `
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
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
                  ${t.context ? `<span class="context-badge context-${t.context}">${t.context}</span>` : ''}
                  ${t.ai_agent ? `<span class="k-source-badge source-${t.ai_agent}">${t.ai_agent}</span>` : ''}
                  ${t.due_date ? `<span style="font-size:0.65rem;color:var(--text-dim)">${new Date(t.due_date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : ''}
                </div>
              </div>`).join('') || '<div class="empty-state" style="padding:12px">Empty</div>'}
          </div>
        </div>`).join('')}
      </div>
    `;
  } catch (e) { main.innerHTML = tasksTabsHtml() + `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ── Calendar View ──
let calendarDate = new Date();
let _calSelectedTaskId = null;
let _calSelectedTaskTitle = null;

function calSelectTask(e, taskId, taskTitle) {
  e.stopPropagation();
  if (_calSelectedTaskId === taskId) { calClearSelection(); return; }
  _calSelectedTaskId = taskId;
  _calSelectedTaskTitle = taskTitle;
  // Highlight selected task
  document.querySelectorAll('.cal-task-selected').forEach(el => el.classList.remove('cal-task-selected'));
  document.querySelectorAll('.cal-unscheduled .cal-item-selected').forEach(el => el.classList.remove('cal-item-selected'));
  e.currentTarget.classList.add(e.currentTarget.closest('.cal-unscheduled') ? 'cal-item-selected' : 'cal-task-selected');
  // Show drop zones on all date cells
  document.querySelectorAll('.cal-cell:not(.cal-empty)').forEach(c => c.classList.add('cal-drop-zone'));
  // Show banner
  let banner = document.getElementById('cal-move-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'cal-move-banner';
    banner.className = 'cal-move-banner';
    document.querySelector('.cal-grid')?.parentNode.insertBefore(banner, document.querySelector('.cal-grid'));
  }
  banner.innerHTML = `Moving: <strong>${esc(taskTitle)}</strong> &mdash; tap a date <button onclick="calClearSelection()" style="margin-left:8px;background:none;border:none;color:var(--red);cursor:pointer;font-weight:700">&times; Cancel</button>`;
  banner.style.display = 'flex';
}

function calClearSelection() {
  _calSelectedTaskId = null;
  _calSelectedTaskTitle = null;
  document.querySelectorAll('.cal-task-selected, .cal-item-selected').forEach(el => el.classList.remove('cal-task-selected', 'cal-item-selected'));
  document.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('cal-drop-zone'));
  const banner = document.getElementById('cal-move-banner');
  if (banner) banner.style.display = 'none';
}

function calCellClick(dateStr) {
  if (_calSelectedTaskId) {
    updateTask(_calSelectedTaskId, 'due_date', dateStr);
    showToast(`Moved to ${new Date(dateStr + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, 'success', 2000);
    calClearSelection();
  } else {
    setTaskDueByCalendar(dateStr);
  }
}

async function loadTasksCalendar() {
  const main = document.getElementById('main-content');
  try {
    const data = await api('/tasks?limit=500');
    const tasks = data.tasks || [];

    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);
    const monthLabel = calendarDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Index tasks by due date
    const tasksByDate = {};
    for (const t of tasks) {
      if (t.due_date) {
        const d = t.due_date.slice(0, 10);
        (tasksByDate[d] = tasksByDate[d] || []).push(t);
      }
    }

    // Also collect tasks without due dates
    const unscheduled = tasks.filter(t => !t.due_date && t.status !== 'done');

    // Build calendar grid
    let cells = '';
    // Empty leading cells
    for (let i = 0; i < firstDay; i++) cells += '<div class="cal-cell cal-empty"></div>';
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const cellDate = new Date(year, month, day);
      const isToday = cellDate.toDateString() === today.toDateString();
      const dayTasks = tasksByDate[dateStr] || [];
      const dots = dayTasks.slice(0, 4).map(t =>
        `<div class="cal-task" onclick="calSelectTask(event,'${t.id}','${esc(t.title).replace(/'/g,"\\'")}')">
          <span class="priority-dot priority-${t.priority}"></span>
          <span class="cal-task-title">${esc(t.title)}</span>
        </div>`
      ).join('');
      const more = dayTasks.length > 4 ? `<div class="cal-more">+${dayTasks.length - 4} more</div>` : '';
      cells += `
        <div class="cal-cell${isToday ? ' cal-today' : ''}" data-date="${dateStr}"
          onclick="calCellClick('${dateStr}')">
          <div class="cal-day">${day}</div>
          ${dots}${more}
        </div>`;
    }

    main.innerHTML = tasksTabsHtml() + `
      <div class="flex-between mb-md">
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn-action btn-compact-sm" onclick="calendarDate.setMonth(calendarDate.getMonth()-1);loadTasksCalendar()">&lt;</button>
          <span style="font-weight:700;font-size:0.9rem;min-width:140px;text-align:center">${monthLabel}</span>
          <button class="btn-action btn-compact-sm" onclick="calendarDate.setMonth(calendarDate.getMonth()+1);loadTasksCalendar()">&gt;</button>
          <button class="btn-action btn-compact-sm" onclick="calendarDate=new Date();loadTasksCalendar()" style="font-size:0.7rem">Today</button>
        </div>
        <button class="btn-action btn-compact-sm" onclick="showNewTaskModal()">+ Task</button>
      </div>
      <div class="cal-grid">
        <div class="cal-header">Sun</div><div class="cal-header">Mon</div><div class="cal-header">Tue</div>
        <div class="cal-header">Wed</div><div class="cal-header">Thu</div><div class="cal-header">Fri</div><div class="cal-header">Sat</div>
        ${cells}
      </div>
      ${unscheduled.length ? `
        <div style="margin-top:16px">
          <div style="font-size:0.8rem;font-weight:700;color:var(--text-dim);margin-bottom:6px">Unscheduled (${unscheduled.length}) — tap to move to a date</div>
          <div class="cal-unscheduled">
            ${unscheduled.slice(0, 10).map(t => `
              <div class="list-item list-item-compact"
                onclick="calSelectTask(event,'${t.id}','${esc(t.title).replace(/'/g,"\\'")}')" style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <span class="priority-badge priority-${t.priority}" style="font-size:0.65rem">${t.priority[0].toUpperCase()}</span>
                <span style="flex:1;font-size:0.8rem">${esc(t.title)}</span>
              </div>`).join('')}
            ${unscheduled.length > 10 ? `<div style="font-size:0.75rem;color:var(--text-dim);padding:4px">+${unscheduled.length - 10} more</div>` : ''}
          </div>
        </div>` : ''}
    `;
  } catch (e) { main.innerHTML = tasksTabsHtml() + `<div class="empty-state">${esc(e.message)}</div>`; }
}

function setTaskDueByCalendar(dateStr) {
  // Quick-create a task on this date
  ensureProjectsCache().then(() => {
    openModal('New Task', `
      <form onsubmit="createTask(event)">
        <div class="form-group"><label>Title</label><input type="text" id="new-task-title" required></div>
        <div class="form-group"><label>Description</label><textarea id="new-task-desc" rows="2"></textarea></div>
        <div class="form-group"><label>Due Date</label><input type="date" id="new-task-due" value="${dateStr}"></div>
        <div class="form-group"><label>Priority</label>
          <select id="new-task-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
        </div>
        <div class="form-group"><label>Project</label>
          <select id="new-task-project">${projectDropdownHtml()}</select>
        </div>
        <div class="form-group"><label>Context</label>
          <select id="new-task-context"><option value="">Auto-detect</option><option value="work">Work</option><option value="personal">Personal</option></select>
        </div>
        <button type="submit" class="btn-submit">Create Task</button>
      </form>
    `);
  });
}

// ── Shared Task Detail / Edit ──
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
      <div class="form-group"><label>Due Date</label>
        <input type="date" value="${task.due_date ? task.due_date.slice(0,10) : ''}" onchange="updateTask('${id}', 'due_date', this.value||null)">
      </div>
      <div class="form-group"><label>Project</label>
        <select onchange="updateTask('${id}', 'project_id', this.value||null)">
          ${projectDropdownHtml(task.project_id)}
        </select>
      </div>
      <div class="form-group"><label>Context</label>
        <select onchange="updateTask('${id}', 'context', this.value||null)">
          <option value="" ${!task.context?'selected':''}>None</option>
          <option value="work" ${task.context==='work'?'selected':''}>Work</option>
          <option value="personal" ${task.context==='personal'?'selected':''}>Personal</option>
        </select>
      </div>
      ${task.source_id ? '<div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:8px">Created from Outlook email</div>' : ''}
      ${task.description ? `<div class="form-group"><label>Description</label><div style="font-size:0.85rem;white-space:pre-wrap">${esc(task.description)}</div></div>` : ''}
      ${task.next_steps ? `<div class="form-group"><label>Next Steps</label><div style="font-size:0.85rem">${esc(task.next_steps)}</div></div>` : ''}
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn-action btn-action-danger" onclick="deleteTask('${id}')" style="flex:1">Delete</button>
      </div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function updateTask(id, field, value) {
  try { await api(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); loadTasks(); } catch {}
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
  try { await api(`/tasks/${id}`, { method: 'DELETE' }); closeModal(); loadTasks(); } catch {}
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
        <div class="form-group"><label>Due Date</label><input type="date" id="new-task-due"></div>
        <div class="form-group"><label>Priority</label>
          <select id="new-task-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
        </div>
        <div class="form-group"><label>Project</label>
          <select id="new-task-project">${projectDropdownHtml(defaultProjectId)}</select>
        </div>
        <div class="form-group"><label>Context</label>
          <select id="new-task-context"><option value="">Auto-detect</option><option value="work">Work</option><option value="personal">Personal</option></select>
        </div>
        <button type="submit" class="btn-submit">Create Task</button>
      </form>
    `);
  });
}

async function createTask(e) {
  e.preventDefault();
  try {
    const dueEl = document.getElementById('new-task-due');
    await api('/tasks', { method: 'POST', body: JSON.stringify({
      title: document.getElementById('new-task-title').value,
      description: document.getElementById('new-task-desc').value,
      priority: document.getElementById('new-task-priority').value,
      project_id: document.getElementById('new-task-project').value || null,
      due_date: dueEl ? dueEl.value || null : null,
      context: document.getElementById('new-task-context').value || null,
    }) });
    closeModal();
    if (currentTab === 'tasks') loadTasks();
    else if (currentTab === 'projects') loadProjects();
  } catch (err) { showToast(err.message); }
}

// ─── Brain (Knowledge + Facts) ────────────────────────────────
let brainSubTab = 'all';
function brainTabsHtml() {
  return `<div class="brain-tabs">
    <button class="brain-tab${brainSubTab==='all'?' active':''}" onclick="brainSubTab='all';loadBrain()">All</button>
    <button class="brain-tab${brainSubTab==='knowledge'?' active':''}" onclick="brainSubTab='knowledge';loadBrain()">Knowledge</button>
    <button class="brain-tab${brainSubTab==='facts'?' active':''}" onclick="brainSubTab='facts';loadBrain()">Facts</button>
    <button class="brain-tab${brainSubTab==='conversations'?' active':''}" onclick="brainSubTab='conversations';loadBrain()">Conversations</button>
    <button class="brain-tab${brainSubTab==='transcripts'?' active':''}" onclick="brainSubTab='transcripts';loadBrain()">Transcripts</button>
    <button class="brain-tab${brainSubTab==='guide'?' active':''}" onclick="brainSubTab='guide';loadBrain()">Guide</button>
  </div>`;
}

async function loadBrain(searchQuery) {
  const main = document.getElementById('main-content');
  main.innerHTML = brainTabsHtml() + '<div class="loading">Loading...</div>';
  if (brainSubTab === 'all') return loadBrainAll(searchQuery);
  if (brainSubTab === 'facts') return loadFacts(searchQuery);
  if (brainSubTab === 'conversations') return loadConversations(searchQuery);
  if (brainSubTab === 'transcripts') return loadTranscripts(searchQuery);
  if (brainSubTab === 'guide') return loadBrainGuide();
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
    main.innerHTML = brainTabsHtml() + listHtml;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

let brainAllSearchTimer = null;
function debounceBrainAllSearch(q) { clearTimeout(brainAllSearchTimer); brainAllSearchTimer = setTimeout(() => loadBrainAll(q), 300); }

async function loadBrainAll(searchQuery) {
  const main = document.getElementById('main-content');
  try {
    const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}&limit=20` : '?limit=20';
    const [kData, fData, cData, tData] = await Promise.all([
      api('/knowledge' + qs),
      api('/facts' + qs),
      api('/conversations' + qs),
      api('/transcripts' + qs)
    ]);

    const sections = [];

    if (kData.entries.length) {
      sections.push(`<div class="brain-all-section">
        <div class="brain-all-section-header" onclick="brainSubTab='knowledge';loadBrain(${searchQuery ? "'" + esc(searchQuery).replace(/'/g,"\\'") + "'" : ''})">
          <span>Knowledge</span><span class="brain-all-count">${kData.entries.length}${kData.entries.length >= 20 ? '+' : ''}</span>
        </div>
        ${kData.entries.slice(0, 5).map(k => `
          <div class="list-item list-item-compact" onclick="showKnowledgeDetail('${k.id}')">
            <div class="list-item-title">
              ${k.ai_source ? `<span class="k-source-badge source-${k.ai_source}">${k.ai_source}</span>` : ''}
              ${esc(k.title)}
            </div>
            <div class="list-item-preview">${esc((k.content || '').substring(0, 100))}</div>
          </div>`).join('')}
        ${kData.entries.length > 5 ? `<div class="brain-all-more" onclick="brainSubTab='knowledge';loadBrain()">View all knowledge &rarr;</div>` : ''}
      </div>`);
    }

    if (fData.facts.length) {
      sections.push(`<div class="brain-all-section">
        <div class="brain-all-section-header" onclick="brainSubTab='facts';loadBrain(${searchQuery ? "'" + esc(searchQuery).replace(/'/g,"\\'") + "'" : ''})">
          <span>Facts</span><span class="brain-all-count">${fData.facts.length}${fData.facts.length >= 20 ? '+' : ''}</span>
        </div>
        ${fData.facts.slice(0, 5).map(f => `
          <div class="list-item list-item-compact" onclick="showFactDetail('${f.id}')">
            <div class="list-item-title">${esc(f.title)}</div>
            <div class="list-item-preview">${esc((f.content || '').substring(0, 100))}</div>
          </div>`).join('')}
        ${fData.facts.length > 5 ? `<div class="brain-all-more" onclick="brainSubTab='facts';loadBrain()">View all facts &rarr;</div>` : ''}
      </div>`);
    }

    if (cData.conversations.length) {
      sections.push(`<div class="brain-all-section">
        <div class="brain-all-section-header" onclick="brainSubTab='conversations';loadBrain(${searchQuery ? "'" + esc(searchQuery).replace(/'/g,"\\'") + "'" : ''})">
          <span>Conversations</span><span class="brain-all-count">${cData.conversations.length}${cData.conversations.length >= 20 ? '+' : ''}</span>
        </div>
        ${cData.conversations.slice(0, 5).map(c => `
          <div class="list-item list-item-compact" onclick="showConversationDetail('${c.id}')">
            <div class="list-item-title">
              <span class="k-source-badge source-${c.ai_source}">${c.ai_source}</span>
              ${esc(c.title)}
            </div>
            <div class="list-item-preview">${esc((c.summary || '').substring(0, 100))}</div>
          </div>`).join('')}
        ${cData.conversations.length > 5 ? `<div class="brain-all-more" onclick="brainSubTab='conversations';loadBrain()">View all conversations &rarr;</div>` : ''}
      </div>`);
    }

    if (tData.transcripts.length) {
      sections.push(`<div class="brain-all-section">
        <div class="brain-all-section-header" onclick="brainSubTab='transcripts';loadBrain(${searchQuery ? "'" + esc(searchQuery).replace(/'/g,"\\'") + "'" : ''})">
          <span>Transcripts</span><span class="brain-all-count">${tData.transcripts.length}${tData.transcripts.length >= 20 ? '+' : ''}</span>
        </div>
        ${tData.transcripts.slice(0, 5).map(t => `
          <div class="list-item list-item-compact" onclick="showTranscriptDetail('${t.id}')">
            <div class="list-item-title">${esc(t.title)}</div>
            <div class="list-item-preview">${esc((t.summary || t.preview || '').substring(0, 100))}</div>
          </div>`).join('')}
        ${tData.transcripts.length > 5 ? `<div class="brain-all-more" onclick="brainSubTab='transcripts';loadBrain()">View all transcripts &rarr;</div>` : ''}
      </div>`);
    }

    main.innerHTML = brainTabsHtml() + `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" class="brain-search" placeholder="Search everything..." value="${esc(searchQuery || '')}" oninput="debounceBrainAllSearch(this.value)">
      </div>
      ${sections.length ? sections.join('') : `<div class="empty-state">${searchQuery ? 'No results found' : 'Your brain is empty. Start adding knowledge, facts, or import conversations.'}</div>`}
    `;
  } catch (e) { main.innerHTML = brainTabsHtml() + `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ─── Guide ────────────────────────────────────────────────────
function loadBrainGuide() {
  const main = document.getElementById('main-content');
  main.innerHTML = brainTabsHtml() + `<div class="guide">

    <div class="guide-section guide-highlight">
      <div class="guide-section-title">Your System in 10 Seconds</div>
      <div class="guide-flow">
        <div class="guide-flow-item">
          <div class="guide-flow-icon">ChatGPT / Claude</div>
          <div class="guide-flow-label">Talk to your AI</div>
        </div>
        <div class="guide-flow-arrow">&rarr;</div>
        <div class="guide-flow-item">
          <div class="guide-flow-icon">Bee</div>
          <div class="guide-flow-label">Captures calls & meetings</div>
        </div>
        <div class="guide-flow-arrow">&rarr;</div>
        <div class="guide-flow-item">
          <div class="guide-flow-icon" style="color:var(--accent)">AB Brain</div>
          <div class="guide-flow-label">Everything lands here</div>
        </div>
      </div>
      <p style="text-align:center;color:var(--text-dim);margin:0">Use your AI naturally. Wear your Bee. This system catches what you miss.</p>
    </div>

    <div class="guide-section">
      <div class="guide-section-title">The 2-Minute Re-Entry</div>
      <p class="guide-subtitle">Been away for days or weeks? Here's all you need to do:</p>
      <div class="guide-steps">
        <div class="guide-step">
          <span class="guide-step-num">1</span>
          <div><strong>Sync Bee</strong> &mdash; Tap the logo &rarr; Sync Updates. One tap, done.</div>
        </div>
        <div class="guide-step">
          <span class="guide-step-num">2</span>
          <div><strong>Catch up on AI chats</strong> &mdash; Review any useful ChatGPT/Claude conversations, ask for an outline, paste into Custom GPT. Or bulk import from Settings.</div>
        </div>
        <div class="guide-step">
          <span class="guide-step-num">3</span>
          <div><strong>Glance at Home</strong> &mdash; See what's there. No obligation to act on anything.</div>
        </div>
      </div>
      <div class="guide-callout">Nothing broke while you were gone. The system waited for you.</div>
    </div>

    <div class="guide-section">
      <div class="guide-section-title">How Your AI Connects</div>
      <div class="guide-table">
        <div class="guide-row guide-row-header">
          <span>Tool</span><span>Connection</span><span>What to do</span>
        </div>
        <div class="guide-row">
          <span><strong>Custom GPT</strong></span>
          <span style="color:var(--green)">Live &mdash; posts directly</span>
          <span>Just use it. Tasks, knowledge, facts push automatically.</span>
        </div>
        <div class="guide-row">
          <span><strong>ChatGPT / Claude</strong></span>
          <span style="color:var(--green)">Curate &amp; push</span>
          <span>Had a useful conversation? Ask it: "Give me a detailed outline of this entire conversation." Copy the outline &rarr; paste into your Custom GPT to post. Only the valuable stuff gets saved.</span>
        </div>
        <div class="guide-row">
          <span><strong>ChatGPT bulk</strong></span>
          <span style="color:var(--text-dim)">Optional backup</span>
          <span>Settings &rarr; Export data &rarr; Import here. Archives all conversations for search. Duplicates auto-skipped.</span>
        </div>
        <div class="guide-row">
          <span><strong>Bee Wearable</strong></span>
          <span style="color:var(--green)">Automatic</span>
          <span>Wear it. Conversations, tasks, and facts sync on their own.</span>
        </div>
      </div>
      <div class="guide-callout">Best habit: when a conversation is useful, ask your AI to outline it, then paste into Custom GPT. Takes 30 seconds. The intake system classifies it into knowledge, tasks, or facts automatically.</div>
    </div>

    <div class="guide-section">
      <div class="guide-section-title">What Goes Where</div>
      <div class="guide-table">
        <div class="guide-row guide-row-header">
          <span>You have...</span><span>It becomes...</span><span>How</span>
        </div>
        <div class="guide-row">
          <span>Meeting or phone call</span><span>Transcript</span><span>Bee auto-captures</span>
        </div>
        <div class="guide-row">
          <span>ChatGPT / Claude chat</span><span>Conversation</span><span>Export &amp; import</span>
        </div>
        <div class="guide-row">
          <span>Something you learned</span><span>Knowledge</span><span>AI intake or Custom GPT</span>
        </div>
        <div class="guide-row">
          <span>A fact about you or someone</span><span>Fact</span><span>Extracted from transcripts</span>
        </div>
        <div class="guide-row">
          <span>Something you need to do</span><span>Task</span><span>Create manually or AI extracts</span>
        </div>
        <div class="guide-row">
          <span>A bigger initiative</span><span>Project</span><span>Group tasks under it</span>
        </div>
      </div>
    </div>

    <div class="guide-section guide-highlight">
      <div class="guide-section-title">When You Fall Off</div>
      <p>You will stop using this. That's normal, not failure.</p>
      <p>Bee keeps recording. ChatGPT keeps your history. Nothing is lost.</p>
      <p>Coming back = 2 taps (sync + import). That's it.</p>
      <p><strong>No streaks. No daily requirements. No guilt.</strong></p>
      <p>Even using this once a month has value &mdash; it's your searchable second brain.</p>
    </div>

    <div class="guide-section">
      <div class="guide-section-title">Quick Actions</div>
      <div class="guide-actions">
        <button class="btn-action" onclick="brainSubTab='all';loadBrain()">Search Everything</button>
        <button class="btn-action" onclick="showNewTaskModal()">New Task</button>
        <button class="btn-action btn-action-secondary" onclick="triggerBeeSyncFromMenu('incremental')">Sync Bee</button>
        <button class="btn-action btn-action-secondary" onclick="document.getElementById('settings-menu').classList.add('open');setTimeout(()=>document.getElementById('chatgpt-import-file')?.click(),300)">Import ChatGPT</button>
      </div>
    </div>

  </div>`;
}

async function loadFacts(searchQuery) {
  const main = document.getElementById('main-content');
  try {
    const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}&limit=50` : '?limit=50';
    const data = await api('/facts' + qs);

    main.innerHTML = brainTabsHtml() + `
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

// ─── Conversations sub-tab ─────────────────────────────────────
let convSearchTimer = null;
function debounceConvSearch(q) { clearTimeout(convSearchTimer); convSearchTimer = setTimeout(() => loadConversations(q), 300); }

async function loadConversations(searchQuery) {
  const main = document.getElementById('main-content');
  try {
    const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}&limit=50` : '?limit=50';
    const data = await api('/conversations' + qs);

    main.innerHTML = brainTabsHtml() + `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" class="brain-search" placeholder="Search conversations..." value="${esc(searchQuery || '')}" oninput="debounceConvSearch(this.value)">
      </div>
      <div id="conv-list">
        ${data.conversations.length ? data.conversations.map(c => `
          <div class="list-item" onclick="showConversationDetail('${c.id}')">
            <div class="list-item-title">
              <span class="k-source-badge source-${c.ai_source}">${c.ai_source}</span>
              ${esc(c.title)}
            </div>
            <div class="list-item-preview">${esc((c.summary || '').substring(0, 150))}</div>
            <div class="list-item-meta">
              <span>${c.message_count || 0} messages</span>
              <span>${c.metadata?.model || ''}</span>
              <span>${timeAgo(c.created_at)}</span>
            </div>
          </div>`).join('') : '<div class="empty-state">No conversations yet. Import ChatGPT conversations from Settings.</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = brainTabsHtml() + `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function showConversationDetail(id) {
  try {
    const c = await api(`/conversations/${id}`);
    const thread = Array.isArray(c.full_thread) ? c.full_thread : [];
    const messagesHtml = thread.map(m => `
      <div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:${m.role === 'assistant' ? 'var(--bg-input)' : 'transparent'};border:1px solid var(--border)">
        <div style="font-size:0.7rem;font-weight:700;color:${m.role === 'assistant' ? 'var(--accent)' : 'var(--green)'};text-transform:uppercase;margin-bottom:4px">
          ${m.role}${m.timestamp ? ` &middot; ${new Date(m.timestamp).toLocaleString()}` : ''}
        </div>
        <div style="font-size:0.85rem;white-space:pre-wrap;line-height:1.55">${esc(m.content)}</div>
      </div>`).join('');

    openModal(c.title, `
      <div class="list-item-meta" style="margin-bottom:12px">
        <span class="k-source-badge source-${c.ai_source}">${c.ai_source}</span>
        <span>${c.metadata?.model || ''}</span>
        <span>${thread.length} messages</span>
        <span>${timeAgo(c.created_at)}</span>
      </div>
      ${c.summary ? `<div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:14px;padding:8px 10px;background:var(--bg-input);border-radius:6px">${esc(c.summary)}</div>` : ''}
      <div style="max-height:60vh;overflow-y:auto">${messagesHtml || '<div class="empty-state">No messages</div>'}</div>
      <div style="margin-top:14px">
        <button class="btn-action btn-action-danger" onclick="deleteConversation('${id}')" style="width:100%">Delete</button>
      </div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  try { await api(`/conversations/${id}`, { method: 'DELETE' }); closeModal(); loadBrain(); } catch {}
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

    main.innerHTML = brainTabsHtml() + `
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
    { key: 'progress', label: 'Progress', icon: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 11.75c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zm6 0c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-.29.02-.58.05-.86 2.36-1.05 4.23-2.98 5.21-5.37C11.07 8.33 14.05 10 17.42 10c.78 0 1.53-.09 2.25-.26.21.71.33 1.47.33 2.26 0 4.41-3.59 8-8 8z"/></svg>' },
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
  else if (fitnessSubTab === 'progress') loadProgress();
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

// ─── Body Progress Photos ─────────────────────────────────────
const PROGRESS_POSES = [
  { key: 'front_relaxed', label: 'Front Relaxed', instruction: 'Face camera. Feet hip-width apart, arms slightly away from sides. Neutral posture, don\'t flex.' },
  { key: 'front_flexed', label: 'Front Flexed', instruction: 'Face camera. Double bicep pose or most muscular. Show your best front.' },
  { key: 'side_relaxed_left', label: 'Left Side', instruction: 'Left side to camera. Arms at sides, stand tall. Don\'t suck in stomach.' },
  { key: 'side_relaxed_right', label: 'Right Side', instruction: 'Right side to camera. Arms at sides, stand tall. Don\'t suck in stomach.' },
  { key: 'back_relaxed', label: 'Back Relaxed', instruction: 'Back to camera. Arms slightly away from sides. Natural posture.' },
  { key: 'back_flexed', label: 'Back Flexed', instruction: 'Back to camera. Lat spread or double bicep. Show back width.' },
  { key: 'quarter_turn_left', label: 'Quarter Left', instruction: 'Turn 45° left from front-facing. Arms relaxed at sides.' },
  { key: 'quarter_turn_right', label: 'Quarter Right', instruction: 'Turn 45° right from front-facing. Arms relaxed at sides.' },
];

function poseSvg(key) {
  // Realistic solid silhouette SVGs using smooth bezier curves
  const svgs = {
    front_relaxed: `<svg viewBox="0 0 120 280" width="60" height="120" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="60" cy="22" rx="14" ry="17" fill="currentColor" opacity="0.85"/>
      <path d="M52 38 C52 42,54 46,54 48 C42 50,28 56,22 64 C18 70,16 76,16 80
        C16 90,14 100,14 110 C14 118,16 122,20 122 C24 122,24 118,24 112
        C24 104,26 96,26 88 C26 82,28 76,30 72 C34 66,38 62,44 58
        C44 62,44 68,44 74 C42 82,38 96,36 110 C34 118,32 126,32 134
        C32 142,34 148,36 152 C36 160,36 168,38 176 C40 184,40 192,40 200
        C40 210,40 220,42 230 C42 238,42 246,42 252 C42 258,44 264,50 266
        C54 268,56 264,54 260 C52 254,50 246,50 238 C50 228,50 218,52 208
        C54 198,54 188,56 178 C56 172,58 166,58 160
        C60 160,60 160,62 160
        C62 166,64 172,64 178 C66 188,66 198,68 208
        C70 218,70 228,70 238 C70 246,68 254,66 260
        C64 264,66 268,70 266 C76 264,78 258,78 252
        C78 246,78 238,78 230 C80 220,80 210,80 200
        C80 192,80 184,82 176 C84 168,84 160,84 152
        C86 148,88 142,88 134 C88 126,86 118,84 110
        C82 96,78 82,76 74 C76 68,76 62,76 58
        C82 62,86 66,90 72 C92 76,94 82,94 88
        C94 96,96 104,96 112 C96 118,96 122,100 122
        C104 122,104 118,106 110 C106 100,104 90,104 80
        C104 76,102 70,98 64 C92 56,78 50,66 48
        C66 46,68 42,68 38 Z" fill="currentColor" opacity="0.85"/>
    </svg>`,
    front_flexed: `<svg viewBox="0 0 140 280" width="60" height="120" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="70" cy="22" rx="14" ry="17" fill="currentColor" opacity="0.85"/>
      <path d="M62 38 C62 42,64 46,64 48 C52 50,38 56,32 64 C28 68,26 72,24 76
        C22 80,18 82,14 78 C10 74,8 68,6 60 C4 52,4 44,6 38
        C8 34,12 34,12 38 C12 44,14 52,16 58 C18 64,20 68,22 70
        C24 68,26 64,28 62 C32 58,38 54,44 52
        C44 58,44 68,44 74 C42 82,38 96,36 110 C34 118,32 126,32 134
        C32 142,34 148,36 152 C36 160,36 168,38 176 C40 184,40 192,40 200
        C40 210,40 220,42 230 C42 238,42 246,42 252 C42 258,44 264,50 266
        C54 268,56 264,54 260 C52 254,50 246,50 238 C50 228,50 218,52 208
        C54 198,54 188,56 178 C56 172,58 166,58 160
        C60 160,60 160,62 160
        C62 166,64 172,64 178 C66 188,66 198,68 208
        C70 218,70 228,70 238 C70 246,68 254,66 260
        C64 264,66 268,70 266 C76 264,78 258,78 252
        C78 246,78 238,78 230 C80 220,80 210,80 200
        C80 192,80 184,82 176 C84 168,84 160,84 152
        C86 148,88 142,88 134 C88 126,86 118,84 110
        C82 96,78 82,76 74 C76 68,76 62,76 58 C76 54,82 52,86 54
        C92 58,96 62,98 68 C100 72,96 64,98 62
        C100 68,102 74,104 78 C106 82,108 80,116 76
        C118 74,120 68,122 58 C124 52,126 44,128 38
        C128 34,132 34,134 38 C136 44,136 52,134 60
        C132 68,130 74,126 78 C122 82,118 84,116 80
        C114 78,112 76,108 76 C106 78,98 80,96 76
        C94 72,92 68,90 64 C88 60,86 56,82 54
        C78 52,76 50,76 48
        C76 46,78 42,78 38 Z" fill="currentColor" opacity="0.85"/>
    </svg>`,
    side_relaxed_left: `<svg viewBox="0 0 100 280" width="60" height="120" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="52" cy="22" rx="14" ry="17" fill="currentColor" opacity="0.85"/>
      <path d="M46 38 C44 42,42 46,42 50 C36 54,32 60,30 68
        C28 74,26 80,26 86 C24 92,22 98,20 104
        C18 110,18 116,22 118 C26 120,28 116,28 110
        C28 104,30 98,32 92 C34 86,34 80,36 74 C36 70,38 66,40 62
        C40 68,40 76,38 84 C36 94,34 104,34 114
        C34 124,34 134,36 144 C38 154,38 164,38 174
        C38 184,38 194,38 204 C38 214,38 224,40 234
        C40 242,40 250,40 256 C40 262,42 268,48 268
        C52 268,52 264,50 258 C48 252,48 244,48 236
        C48 226,50 216,50 206 C50 196,52 186,52 176
        C54 166,54 160,56 154
        C58 160,58 166,58 176 C58 186,58 196,58 206
        C58 216,60 226,60 236 C60 244,60 252,58 258
        C56 264,56 268,60 268 C66 268,68 262,68 256
        C68 250,68 242,68 234 C70 224,70 214,70 204
        C70 194,70 184,70 174 C70 164,70 154,72 144
        C74 134,74 124,74 114 C74 104,72 94,70 84
        C68 76,68 68,68 62
        C70 66,72 70,72 74 C74 80,74 86,76 92
        C78 98,80 104,80 110 C80 116,82 120,86 118
        C90 116,90 110,88 104 C86 98,84 92,82 86
        C82 80,80 74,78 68 C76 60,72 54,66 50
        C66 46,64 42,62 38 Z" fill="currentColor" opacity="0.85"/>
    </svg>`,
    quarter_turn_left: `<svg viewBox="0 0 120 280" width="60" height="120" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="56" cy="22" rx="15" ry="17" fill="currentColor" opacity="0.85"/>
      <path d="M48 38 C46 42,44 46,44 50 C34 54,24 60,20 68
        C16 74,14 80,14 86 C12 92,10 98,10 104
        C10 110,10 116,14 118 C18 120,20 116,20 110
        C20 104,22 98,24 92 C26 86,28 80,30 74 C32 68,36 64,40 60
        C40 66,40 74,38 82 C36 92,34 102,34 112
        C34 122,34 132,36 142 C36 152,36 162,36 172
        C36 182,36 192,36 202 C36 212,36 222,38 232
        C38 240,38 248,38 254 C38 260,40 266,46 268
        C50 270,52 266,50 260 C48 254,48 244,48 236
        C48 226,48 216,50 206 C50 196,52 186,52 176
        C52 170,54 164,56 158
        C58 164,58 170,60 176 C60 186,60 196,62 206
        C62 216,64 226,64 236 C64 244,64 254,62 260
        C60 266,62 270,66 268 C72 266,74 260,74 254
        C74 248,74 240,74 232 C76 222,76 212,76 202
        C76 192,76 182,76 172 C76 162,76 152,78 142
        C78 132,80 122,80 112 C80 102,78 92,76 82
        C74 74,74 66,74 60
        C78 64,82 68,84 74 C86 80,88 86,90 92
        C92 98,94 104,94 110 C94 116,96 120,100 118
        C104 116,104 110,102 104 C100 98,98 92,96 86
        C94 80,92 74,90 68 C86 60,80 54,70 50
        C70 46,68 42,66 38 Z" fill="currentColor" opacity="0.85"/>
    </svg>`,
  };
  // Reuse: back = front, side_right = side_left flipped, quarter_right = quarter_left flipped
  svgs.back_relaxed = svgs.front_relaxed;
  svgs.back_flexed = svgs.front_flexed;
  svgs.side_relaxed_right = svgs.side_relaxed_left.replace('viewBox="0 0 100 280"', 'viewBox="0 0 100 280" style="transform:scaleX(-1)"');
  svgs.quarter_turn_right = svgs.quarter_turn_left.replace('viewBox="0 0 120 280"', 'viewBox="0 0 120 280" style="transform:scaleX(-1)"');
  return svgs[key] || svgs.front_relaxed;
}

let progressViewMode = 'timeline'; // 'timeline' | 'compare'
let progressCompareFrom = null;
let progressCompareTo = null;

async function loadProgress() {
  const main = document.getElementById('fitness-content') || document.getElementById('main-content');
  main.innerHTML = skeletonCards(4);
  try {
    const data = await api('/progress?limit=50');

    main.innerHTML = `
      <div class="list-search-row">
        <div class="filter-row" style="flex:1;margin:0">
          <button class="filter-btn ${progressViewMode === 'timeline' ? 'active' : ''}" onclick="progressViewMode='timeline';loadProgress()">Timeline</button>
          <button class="filter-btn ${progressViewMode === 'compare' ? 'active' : ''}" onclick="progressViewMode='compare';loadProgress()">Compare</button>
          <button class="filter-btn ${progressViewMode === 'poses' ? 'active' : ''}" onclick="progressViewMode='poses';loadProgress()">Pose Guide</button>
        </div>
        <button class="btn-submit btn-compact" onclick="showProgressCheckinForm()">+ Check-in</button>
      </div>
      <div id="progress-view-content"></div>
    `;

    const viewEl = document.getElementById('progress-view-content');

    if (progressViewMode === 'poses') {
      renderPoseGuide(viewEl);
    } else if (progressViewMode === 'compare') {
      renderCompareView(viewEl, data.checkins);
    } else {
      renderTimeline(viewEl, data.checkins);
    }
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

function renderTimeline(el, checkins) {
  if (!checkins.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div style="font-size:1.1rem;margin-bottom:8px">No progress check-ins yet</div>
        <div style="font-size:0.8rem;color:var(--text-dim)">Tap "+ Check-in" to capture your first set of progress photos.</div>
        <div style="margin-top:12px">
          <button class="btn-submit btn-compact" onclick="progressViewMode='poses';loadProgress()">View Pose Guide</button>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="transcript-count">${checkins.length} check-in${checkins.length !== 1 ? 's' : ''}</div>
    <div class="fade-in">
      ${checkins.map(c => {
        const d = new Date(c.checkin_date.slice(0,10) + 'T12:00:00');
        const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const photoCount = c.photo_count || (c.photos ? c.photos.length : 0);
        const consistency = photoCount >= 7 ? 'high' : photoCount >= 4 ? 'moderate' : 'low';
        const consistencyColor = consistency === 'high' ? '#10b981' : consistency === 'moderate' ? '#f59e0b' : '#ef4444';
        const thumbs = (c.photos || []).slice(0, 4);

        return `
        <div class="list-item workout-card" onclick="showProgressDetail('${c.id}')" style="border-left:3px solid ${consistencyColor}">
          <div class="transcript-card-header">
            <div class="list-item-title">${dateLabel}${c.is_baseline ? ' <span style="color:#8b5cf6;font-size:0.7rem">BASELINE</span>' : ''}</div>
            <span class="badge-dynamic" style="background:${consistencyColor}22;color:${consistencyColor}">${photoCount}/8 poses</span>
          </div>
          ${thumbs.length ? `<div style="display:flex;gap:4px;margin:6px 0">${thumbs.map(p =>
            `<div style="width:40px;height:40px;border-radius:6px;overflow:hidden;background:var(--bg-input)">
              <img src="${photoUrl(p.filename)}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.parentNode.innerHTML='<div style=\\'display:flex;align-items:center;justify-content:center;height:100%;font-size:0.5rem;color:var(--text-dim)\\'>📷</div>'">
            </div>`
          ).join('')}${photoCount > 4 ? `<div style="width:40px;height:40px;border-radius:6px;background:var(--bg-input);display:flex;align-items:center;justify-content:center;font-size:0.65rem;color:var(--text-dim)">+${photoCount - 4}</div>` : ''}</div>` : ''}
          <div class="list-item-meta">
            ${c.weight_lb ? `<span>${c.weight_lb} lb</span>` : ''}
            ${c.waist_inches ? `<span>Waist: ${c.waist_inches}"</span>` : ''}
            ${c.calorie_phase ? `<span>${c.calorie_phase}</span>` : ''}
            <span style="color:${consistencyColor}">${consistency} consistency</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function renderCompareView(el, checkins) {
  if (checkins.length < 2) {
    el.innerHTML = '<div class="empty-state">Need at least 2 check-ins to compare.</div>';
    return;
  }

  const fromOptions = checkins.map(c => {
    const d = new Date(c.checkin_date.slice(0,10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `<option value="${c.id}" ${progressCompareFrom === c.id ? 'selected' : ''}>${d}${c.is_baseline ? ' (Baseline)' : ''}</option>`;
  }).join('');
  const toOptions = checkins.map(c => {
    const d = new Date(c.checkin_date.slice(0,10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `<option value="${c.id}" ${progressCompareTo === c.id ? 'selected' : ''}>${d}${c.is_baseline ? ' (Baseline)' : ''}</option>`;
  }).join('');

  if (!progressCompareFrom) progressCompareFrom = checkins[checkins.length - 1].id;
  if (!progressCompareTo) progressCompareTo = checkins[0].id;

  el.innerHTML = `
    <div style="display:flex;gap:8px;margin:12px 0;align-items:center">
      <div style="flex:1">
        <label class="form-label" style="font-size:0.7rem">Before</label>
        <select class="brain-search" onchange="progressCompareFrom=this.value" style="font-size:0.8rem">${fromOptions}</select>
      </div>
      <div style="padding-top:14px;color:var(--text-dim)">vs</div>
      <div style="flex:1">
        <label class="form-label" style="font-size:0.7rem">After</label>
        <select class="brain-search" onchange="progressCompareTo=this.value" style="font-size:0.8rem">${toOptions}</select>
      </div>
      <button class="btn-submit btn-compact" style="margin-top:14px" onclick="runProgressCompare()">Compare</button>
    </div>
    <div id="compare-results"></div>`;
}

async function runProgressCompare() {
  const el = document.getElementById('compare-results');
  if (!el || !progressCompareFrom || !progressCompareTo) return;
  if (progressCompareFrom === progressCompareTo) { el.innerHTML = '<div class="empty-state">Select two different check-ins.</div>'; return; }

  el.innerHTML = skeletonCards(2);
  try {
    const data = await api(`/progress/compare/${progressCompareFrom}/${progressCompareTo}`);
    const fromDate = new Date(data.from.checkin_date.slice(0,10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const toDate = new Date(data.to.checkin_date.slice(0,10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    let deltasHtml = '';
    const d = data.measurement_deltas;
    if (d.weight_lb != null) deltasHtml += `<div class="stat-card"><div class="stat-value" style="color:${d.weight_lb < 0 ? '#10b981' : d.weight_lb > 0 ? '#ef4444' : 'var(--text)'}">${d.weight_lb > 0 ? '+' : ''}${d.weight_lb} lb</div><div class="stat-label">Weight</div></div>`;
    if (d.waist_inches != null) deltasHtml += `<div class="stat-card"><div class="stat-value" style="color:${d.waist_inches < 0 ? '#10b981' : d.waist_inches > 0 ? '#ef4444' : 'var(--text)'}">${d.waist_inches > 0 ? '+' : ''}${d.waist_inches}"</div><div class="stat-label">Waist</div></div>`;
    if (d.chest_inches != null) deltasHtml += `<div class="stat-card"><div class="stat-value">${d.chest_inches > 0 ? '+' : ''}${d.chest_inches}"</div><div class="stat-label">Chest</div></div>`;
    if (d.arm_inches != null) deltasHtml += `<div class="stat-card"><div class="stat-value">${d.arm_inches > 0 ? '+' : ''}${d.arm_inches}"</div><div class="stat-label">Arm</div></div>`;

    el.innerHTML = `
      ${deltasHtml ? `<div class="stats-grid" style="margin:8px 0">${deltasHtml}</div>` : ''}
      <div style="text-align:center;margin:8px 0;font-size:0.75rem;color:var(--text-dim)">
        Comparison quality: <strong style="color:${data.comparison_quality === 'high' ? '#10b981' : data.comparison_quality === 'moderate' ? '#f59e0b' : '#ef4444'}">${data.comparison_quality}</strong>
        · ${data.matched_poses.length} matched poses
      </div>
      ${data.matched_poses.length ? `
        <div style="display:flex;align-items:center;justify-content:space-between;margin:12px 0 8px">
          <div style="font-size:0.8rem;font-weight:600">Side-by-Side</div>
          <button class="btn-submit btn-compact btn-secondary" onclick="runAIAssessment('${progressCompareFrom}','${progressCompareTo}')" id="ai-assess-btn">AI Assessment</button>
        </div>
        <div id="ai-assessment-report"></div>
        ${data.matched_poses.map(mp => `
          <div style="margin-bottom:12px">
            <div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:4px">${PROGRESS_POSES.find(p => p.key === mp.pose)?.label || mp.pose}</div>
            <div style="display:flex;gap:4px;position:relative">
              <div style="flex:1;position:relative">
                <img src="${photoUrl(mp.from.filename)}" style="width:100%;border-radius:8px;aspect-ratio:3/4;object-fit:cover" loading="lazy">
                <div style="position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.7);color:#fff;font-size:0.6rem;padding:2px 6px;border-radius:4px">${fromDate}</div>
              </div>
              <div style="flex:1;position:relative">
                <img src="${photoUrl(mp.to.filename)}" style="width:100%;border-radius:8px;aspect-ratio:3/4;object-fit:cover" loading="lazy">
                <div style="position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.7);color:#fff;font-size:0.6rem;padding:2px 6px;border-radius:4px">${toDate}</div>
              </div>
            </div>
          </div>
        `).join('')}
      ` : '<div class="empty-state">No matching poses between these check-ins.</div>'}
    `;
  } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function runAIAssessment(fromId, toId) {
  const btn = document.getElementById('ai-assess-btn');
  const reportEl = document.getElementById('ai-assessment-report');
  if (!reportEl) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
  reportEl.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.75rem">
    Sending photos to AI for visual analysis. This may take 10-20 seconds...
  </div>`;

  try {
    const key = sessionStorage.getItem('ab_api_key') || localStorage.getItem('ab_api_key');
    const resp = await fetch(`${API}/progress/assess/${fromId}/${toId}`, {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Assessment failed');
    }
    const a = await resp.json();

    const confColor = a.confidence === 'high' ? '#10b981' : a.confidence === 'medium' ? '#f59e0b' : '#ef4444';

    reportEl.innerHTML = `
      <div style="background:var(--bg-input);border-radius:10px;padding:12px;margin-bottom:12px;border-left:3px solid ${confColor}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <span style="font-size:0.75rem;font-weight:600">AI Assessment</span>
          <span class="badge-dynamic" style="background:${confColor}22;color:${confColor};font-size:0.6rem">${a.confidence || 'medium'} confidence</span>
        </div>
        <div style="font-size:0.8rem;line-height:1.5;margin-bottom:10px">${esc(a.summary || '')}</div>

        ${a.likely_changes && a.likely_changes.length ? `
          <div style="font-size:0.7rem;font-weight:600;color:#10b981;margin-bottom:4px">Likely Changes</div>
          <ul style="font-size:0.7rem;margin:0 0 10px 16px;padding:0;line-height:1.6;color:var(--text)">
            ${a.likely_changes.map(c => `<li>${esc(c)}</li>`).join('')}
          </ul>
        ` : ''}

        ${a.uncertain_observations && a.uncertain_observations.length ? `
          <div style="font-size:0.7rem;font-weight:600;color:#f59e0b;margin-bottom:4px">Uncertain Observations</div>
          <ul style="font-size:0.7rem;margin:0 0 10px 16px;padding:0;line-height:1.6;color:var(--text-dim)">
            ${a.uncertain_observations.map(o => `<li>${esc(o)}</li>`).join('')}
          </ul>
        ` : ''}

        ${a.pose_specific_notes && Object.keys(a.pose_specific_notes).length ? `
          <div style="font-size:0.7rem;font-weight:600;margin-bottom:4px">Pose Notes</div>
          <div style="font-size:0.7rem;color:var(--text-dim);line-height:1.6;margin-bottom:10px">
            ${Object.entries(a.pose_specific_notes).map(([k, v]) => {
              const pose = PROGRESS_POSES.find(p => p.key === k);
              return `<div><strong>${pose ? pose.label : k}:</strong> ${esc(v)}</div>`;
            }).join('')}
          </div>
        ` : ''}

        ${a.coaching_interpretation ? `
          <div style="font-size:0.7rem;font-weight:600;color:var(--accent);margin-bottom:4px">Coaching Take</div>
          <div style="font-size:0.75rem;line-height:1.5;font-style:italic">${esc(a.coaching_interpretation)}</div>
        ` : ''}
      </div>
    `;
    if (btn) { btn.textContent = 'Re-run Assessment'; btn.disabled = false; }
  } catch (e) {
    reportEl.innerHTML = `<div style="background:#ef444422;border-radius:8px;padding:10px;font-size:0.75rem;color:#ef4444">${esc(e.message)}</div>`;
    if (btn) { btn.textContent = 'Retry Assessment'; btn.disabled = false; }
  }
}

function renderPoseGuide(el) {
  el.innerHTML = `
    <div style="padding:8px 0">
      <div style="font-size:0.85rem;font-weight:600;margin-bottom:4px">Photo Capture Guide</div>
      <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:12px;line-height:1.5">
        Follow these 8 poses each check-in for consistent progress tracking.
      </div>
      <div style="background:var(--bg-input);border-radius:10px;padding:10px;margin-bottom:12px">
        <div style="font-size:0.75rem;font-weight:600;margin-bottom:6px;color:var(--accent)">Best Practices</div>
        <div style="font-size:0.7rem;color:var(--text-dim);line-height:1.6">
          &bull; Morning, before food & workout<br>
          &bull; Same lighting, distance, clothing<br>
          &bull; Same camera height every time<br>
          &bull; Neutral chin and posture<br>
          &bull; Don't suck in stomach (unless flexed pose)
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${PROGRESS_POSES.map(p => `
          <div style="background:var(--bg-input);border-radius:10px;padding:10px;text-align:center">
            <div style="color:var(--accent);margin-bottom:4px">${poseSvg(p.key)}</div>
            <div style="font-size:0.75rem;font-weight:600;margin-bottom:2px">${esc(p.label)}</div>
            <div style="font-size:0.65rem;color:var(--text-dim);line-height:1.4">${esc(p.instruction)}</div>
          </div>
        `).join('')}
      </div>
    </div>`;
}

async function showProgressDetail(id) {
  try {
    const c = await api(`/progress/${id}`);
    const d = new Date(c.checkin_date.slice(0,10) + 'T12:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const photos = c.photos || [];
    const consistency = c.consistency_score || 'low';
    const consistencyColor = consistency === 'high' ? '#10b981' : consistency === 'moderate' ? '#f59e0b' : '#ef4444';

    let html = `
      <div class="flex-row-wrap mb-md">
        <span class="badge-dynamic" style="background:${consistencyColor}22;color:${consistencyColor}">${consistency} consistency</span>
        <span class="text-meta">${dateLabel}</span>
        ${c.is_baseline ? '<span class="badge-dynamic" style="background:#8b5cf622;color:#8b5cf6">Baseline</span>' : ''}
        ${c.calorie_phase ? `<span class="badge-dynamic" style="background:var(--bg-input);color:var(--text-dim)">${esc(c.calorie_phase)}</span>` : ''}
      </div>

      ${c.weight_lb || c.waist_inches || c.chest_inches || c.arm_inches || c.thigh_inches ? `
      <div class="stats-grid mb-md">
        ${c.weight_lb ? `<div class="stat-card"><div class="stat-value">${c.weight_lb}</div><div class="stat-label">Weight (lb)</div></div>` : ''}
        ${c.waist_inches ? `<div class="stat-card"><div class="stat-value">${c.waist_inches}"</div><div class="stat-label">Waist</div></div>` : ''}
        ${c.chest_inches ? `<div class="stat-card"><div class="stat-value">${c.chest_inches}"</div><div class="stat-label">Chest</div></div>` : ''}
        ${c.arm_inches ? `<div class="stat-card"><div class="stat-value">${c.arm_inches}"</div><div class="stat-label">Arm</div></div>` : ''}
        ${c.thigh_inches ? `<div class="stat-card"><div class="stat-value">${c.thigh_inches}"</div><div class="stat-label">Thigh</div></div>` : ''}
      </div>` : ''}

      <div style="font-size:0.8rem;font-weight:600;margin-bottom:8px">Photos (${photos.length}/8)</div>
      ${photos.length ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px">
        ${photos.map(p => {
          const pose = PROGRESS_POSES.find(pp => pp.key === p.pose_type);
          return `
          <div style="position:relative;border-radius:8px;overflow:hidden;background:var(--bg-input)">
            <img src="${photoUrl(p.filename)}" style="width:100%;aspect-ratio:3/4;object-fit:cover;display:block" loading="lazy">
            <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.8));padding:4px 6px;font-size:0.65rem;color:#fff">${pose ? pose.label : p.pose_type}</div>
          </div>`;
        }).join('')}
      </div>` : '<div class="empty-state" style="margin-bottom:12px">No photos yet. Add photos to this check-in.</div>'}

      <button class="btn-submit btn-secondary mb-sm" onclick="closeModal();showProgressPhotoUpload('${c.id}')" style="width:100%">Add / Replace Photos</button>

      ${c.training_phase ? `<div class="detail-info mt-sm"><strong>Training:</strong> ${esc(c.training_phase)}</div>` : ''}
      ${c.pump_state ? `<div class="detail-info mt-sm"><strong>Pump:</strong> ${esc(c.pump_state)}</div>` : ''}
      ${c.notes ? `<div class="detail-info mt-sm"><strong>Notes:</strong> ${esc(c.notes)}</div>` : ''}
      ${c.tags && c.tags.length ? `<div class="mt-sm">${c.tags.map(t => `<span class="speaker-tag" style="font-size:0.6rem">${esc(t)}</span>`).join(' ')}</div>` : ''}

      <div class="action-row">
        <button class="btn-submit flex-1" onclick="closeModal();showProgressCheckinForm('${c.id}')">Edit</button>
        <button class="btn-action btn-action-danger flex-half" onclick="deleteProgressCheckin('${c.id}')">Delete</button>
      </div>
    `;
    openModal(`Progress — ${dateLabel}`, html);
  } catch (e) { showToast('Error: ' + e.message); }
}

async function showProgressCheckinForm(editId) {
  let existing = null;
  if (editId) {
    try { existing = await api(`/progress/${editId}`); } catch {}
  }

  const today = new Date().toISOString().slice(0, 10);

  const html = `
    <div class="form-group">
      <label class="form-label">Date *</label>
      <input type="date" id="pc-date" class="brain-search" value="${existing ? existing.checkin_date.slice(0,10) : today}">
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="form-group">
        <label class="form-label">Weight (lb)</label>
        <input type="number" step="0.1" id="pc-weight" class="brain-search" placeholder="185" value="${existing?.weight_lb || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Waist (in)</label>
        <input type="number" step="0.1" id="pc-waist" class="brain-search" placeholder="33" value="${existing?.waist_inches || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Chest (in)</label>
        <input type="number" step="0.1" id="pc-chest" class="brain-search" placeholder="42" value="${existing?.chest_inches || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Arm (in)</label>
        <input type="number" step="0.1" id="pc-arm" class="brain-search" placeholder="15" value="${existing?.arm_inches || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Thigh (in)</label>
        <input type="number" step="0.1" id="pc-thigh" class="brain-search" placeholder="24" value="${existing?.thigh_inches || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Phase</label>
        <select id="pc-phase" class="brain-search">
          <option value="">—</option>
          <option value="cut" ${existing?.calorie_phase === 'cut' ? 'selected' : ''}>Cut</option>
          <option value="maintenance" ${existing?.calorie_phase === 'maintenance' ? 'selected' : ''}>Maintenance</option>
          <option value="bulk" ${existing?.calorie_phase === 'bulk' ? 'selected' : ''}>Bulk</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Training Phase</label>
      <input type="text" id="pc-training" class="brain-search" placeholder="e.g., Hypertrophy Block 2" value="${existing?.training_phase || ''}">
    </div>
    <div class="form-group">
      <label class="form-label">Pump / State</label>
      <input type="text" id="pc-pump" class="brain-search" placeholder="e.g., fasted, post-workout pump" value="${existing?.pump_state || ''}">
    </div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <textarea id="pc-notes" class="brain-search" rows="2" placeholder="Any context...">${existing?.notes || ''}</textarea>
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;cursor:pointer">
        <input type="checkbox" id="pc-baseline" ${existing?.is_baseline ? 'checked' : ''}>
        Mark as baseline
      </label>
    </div>
    <button class="btn-submit" style="width:100%" onclick="saveProgressCheckin(${editId ? `'${editId}'` : 'null'})">${editId ? 'Update' : 'Create'} Check-in</button>
  `;
  openModal(editId ? 'Edit Check-in' : 'New Progress Check-in', html);
}

async function saveProgressCheckin(editId) {
  const body = {
    checkin_date: document.getElementById('pc-date').value,
    weight_lb: document.getElementById('pc-weight').value ? Number(document.getElementById('pc-weight').value) : null,
    waist_inches: document.getElementById('pc-waist').value ? Number(document.getElementById('pc-waist').value) : null,
    chest_inches: document.getElementById('pc-chest').value ? Number(document.getElementById('pc-chest').value) : null,
    arm_inches: document.getElementById('pc-arm').value ? Number(document.getElementById('pc-arm').value) : null,
    thigh_inches: document.getElementById('pc-thigh').value ? Number(document.getElementById('pc-thigh').value) : null,
    calorie_phase: document.getElementById('pc-phase').value || null,
    training_phase: document.getElementById('pc-training').value || null,
    pump_state: document.getElementById('pc-pump').value || null,
    notes: document.getElementById('pc-notes').value || null,
    is_baseline: document.getElementById('pc-baseline').checked,
  };

  if (!body.checkin_date) { showToast('Date is required'); return; }

  try {
    if (editId) {
      await api(`/progress/${editId}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      showToast('Check-in updated', 'success');
    } else {
      const result = await api('/progress', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      showToast('Check-in created', 'success');
      // Open photo upload for new check-in
      closeModal();
      setTimeout(() => showProgressPhotoUpload(result.id), 300);
      return;
    }
    closeModal();
    loadProgress();
  } catch (e) { showToast('Error: ' + e.message); }
}

async function deleteProgressCheckin(id) {
  if (!confirm('Delete this check-in and all its photos?')) return;
  try {
    await api(`/progress/${id}`, { method: 'DELETE' });
    showToast('Deleted', 'success');
    closeModal();
    loadProgress();
  } catch (e) { showToast('Error: ' + e.message); }
}

function showProgressPhotoUpload(checkinId) {
  const html = `
    <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:12px">
      Upload photos for each pose. Tap a pose card to add/replace its photo.
    </div>
    <div id="photo-upload-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${PROGRESS_POSES.map(p => `
        <div class="progress-pose-upload" id="pose-card-${p.key}"
             style="background:var(--bg-input);border-radius:10px;padding:8px;text-align:center;cursor:pointer;border:2px solid transparent;transition:border-color 0.2s"
             onclick="triggerPoseUpload('${checkinId}','${p.key}')">
          <div style="color:var(--accent);margin-bottom:2px;opacity:0.7">${poseSvg(p.key)}</div>
          <div style="font-size:0.7rem;font-weight:600">${esc(p.label)}</div>
          <div id="pose-status-${p.key}" style="font-size:0.6rem;color:var(--text-dim);margin-top:2px">Tap to add</div>
        </div>
      `).join('')}
    </div>
    <input type="file" id="progress-photo-input" accept="image/*" style="display:none" onchange="handlePosePhotoSelect(this)">
    <div style="margin-top:12px;text-align:center">
      <button class="btn-submit" onclick="closeModal();loadProgress()">Done</button>
    </div>
  `;
  openModal('Add Progress Photos', html);

  // Load existing photos for this check-in
  api(`/progress/${checkinId}`).then(c => {
    if (c.photos) {
      for (const photo of c.photos) {
        const statusEl = document.getElementById(`pose-status-${photo.pose_type}`);
        const cardEl = document.getElementById(`pose-card-${photo.pose_type}`);
        if (statusEl) statusEl.innerHTML = '<span style="color:#10b981">Uploaded</span>';
        if (cardEl) cardEl.style.borderColor = '#10b981';
      }
    }
  }).catch(() => {});
}

let _pendingPoseUpload = { checkinId: null, poseKey: null };

function triggerPoseUpload(checkinId, poseKey) {
  _pendingPoseUpload = { checkinId, poseKey };
  const input = document.getElementById('progress-photo-input');
  if (input) { input.value = ''; input.click(); }
}

async function handlePosePhotoSelect(input) {
  if (!input.files || !input.files[0]) return;
  const { checkinId, poseKey } = _pendingPoseUpload;
  if (!checkinId || !poseKey) return;

  const statusEl = document.getElementById(`pose-status-${poseKey}`);
  const cardEl = document.getElementById(`pose-card-${poseKey}`);
  if (statusEl) statusEl.innerHTML = '<span style="color:#f59e0b">Uploading...</span>';

  const formData = new FormData();
  formData.append('photo', input.files[0]);
  formData.append('pose_type', poseKey);

  try {
    const key = sessionStorage.getItem('ab_api_key') || localStorage.getItem('ab_api_key');
    const resp = await fetch(`${API}/progress/${checkinId}/photos`, {
      method: 'POST',
      headers: { 'X-Api-Key': key },
      body: formData,
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Upload failed');
    }
    if (statusEl) statusEl.innerHTML = '<span style="color:#10b981">Uploaded</span>';
    if (cardEl) cardEl.style.borderColor = '#10b981';
    showToast('Photo uploaded', 'success');
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444">${esc(e.message)}</span>`;
    showToast('Upload error: ' + e.message);
  }
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
