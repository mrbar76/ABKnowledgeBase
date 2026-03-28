// --- AB Brain — Full SPA with bottom tabs ---

const API = '/api';
let currentTab = 'home';

// Local-timezone date string (YYYY-MM-DD) — avoids UTC offset bugs
function localDateStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

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

// ─── Lucide Icon Helpers ──────────────────────────────────────
function icon(name, size = 16, cls = '') {
  return `<i data-lucide="${name}" class="lucide-icon ${cls}" style="width:${size}px;height:${size}px"></i>`;
}
function renderIcons() { if (window.lucide) lucide.createIcons(); }

const BADGE_ICON_MAP = {
  '🏆': 'trophy', '🎯': 'target', '⭐': 'star', '🔥': 'flame',
  '💪': 'dumbbell', '🏅': 'medal', '📊': 'bar-chart-2', '🔒': 'lock',
  '🎖️': 'award', '⚡': 'zap', '🌿': 'leaf', '💎': 'gem',
  '🧠': 'brain', '📋': 'clipboard-list', '🎙': 'mic', '💬': 'message-square',
  '🏋': 'dumbbell', '🍎': 'utensils', '📏': 'ruler', '🩹': 'heart-pulse',
  '🔔': 'bell', '✅': 'check-circle', '📅': 'calendar-clock', '📆': 'calendar-range',
  '🔍': 'search', '🧑‍🏫': 'graduation-cap',
};
function badgeIcon(emoji, size = 22) {
  return icon(BADGE_ICON_MAP[emoji] || 'award', size);
}

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
  showFab();
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
  const headers = { 'Content-Type': 'application/json', 'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone, ...opts.headers };
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

  // Map legacy fitness sub-tab names to the new structure
  const legacyFitnessMap = { workouts: 'history', nutrition: 'nutrition', body: 'history', training: 'plans', recovery: 'today' };
  if (legacyFitnessMap[tab]) {
    fitnessSubTab = legacyFitnessMap[tab];
    if (tab === 'workouts') historyFilter = 'workouts';
    else if (tab === 'body') historyFilter = 'body';
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
  else if (tab === 'badges') loadBadges();
  else if (tab === 'fitness') loadFitness();
}

// ─── Badges (Gamification) ─────────────────────────────────────
async function loadBadges() {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading">Loading badges...</div>';
  try {
    const data = await api('/gamification');
    const { badges } = data;
    main.innerHTML = `
      <h2 style="font-size:1rem;font-weight:700;margin-bottom:12px">Badges <span style="font-weight:400;color:var(--text-dim)">${badges.total_unlocked}/${badges.total_available} unlocked</span></h2>
      ${buildBadgeGrid(badges)}
    `;
    renderIcons();
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ─── Dashboard (Home) ─────────────────────────────────────────

function skeletonStats(n) {
  return Array(n).fill('<div class="skeleton-stat"><div class="skeleton skeleton-stat-value"></div><div class="skeleton skeleton-stat-label"></div></div>').join('');
}
function skeletonCards(n) {
  return Array(n).fill('<div class="skeleton-card"><div class="skeleton skeleton-line skeleton-line-lg"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line skeleton-line-sm"></div></div>').join('');
}

let _statsOpen = true;
let _activeFilter = null; // null = 'all', or 'train'|'fuel'|'recover'

async function loadDashboard() {
  const main = document.getElementById('main-content');
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  main.innerHTML = `
    <div id="xp-bar-container"></div>
    <div class="dash-greeting animate-in">${greeting}.</div>
    <div class="dash-date animate-in stagger-1">${dateStr}</div>
    <div id="today-actions" class="animate-in stagger-2"></div>
    <div id="gamification-section"></div>
    <div class="stats-toggle-row animate-in stagger-4" id="dash-stats-toggle" onclick="toggleDashStats()">
      ${icon('bar-chart-2', 14)}
      <span>Stats Overview</span>
      <span class="stats-toggle-chevron" id="stats-chevron" style="transform:rotate(180deg)">${icon('chevron-down', 14)}</span>
    </div>
    <div id="dash-content" class="dash-content-collapsible">
      <div class="dash-section">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:color-mix(in srgb, var(--color-tactical) 10%, transparent);color:var(--color-tactical)">
            ${icon('check-square', 12)} Tasks
          </div>
        </div>
        <div class="stats-grid">${skeletonStats(6)}</div>
      </div>
      <div class="dash-section">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:color-mix(in srgb, var(--color-mental) 10%, transparent);color:var(--color-mental)">
            ${icon('brain', 12)} Knowledge Base
          </div>
        </div>
        <div class="stats-grid">${skeletonStats(4)}</div>
      </div>
      <div class="dash-section">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:color-mix(in srgb, var(--color-physical) 10%, transparent);color:var(--color-physical)">
            ${icon('dumbbell', 12)} Fitness
          </div>
        </div>
        <div class="stats-grid">${skeletonStats(6)}</div>
      </div>
    </div>
    <div class="stats-toggle-row animate-in stagger-5" id="activity-stream-toggle" onclick="toggleActivityStream()">
      ${icon('activity', 14)}
      <span>System Activity</span>
      <span class="stats-toggle-chevron" id="activity-chevron">${icon('chevron-down', 14)}</span>
    </div>
    <div id="activity-stream" style="display:none"></div>
  `;
  renderIcons();

  loadDashboardStats();
  loadGamification();
}

let _activityOpen = false;
function toggleActivityStream() {
  _activityOpen = !_activityOpen;
  const content = document.getElementById('activity-stream');
  const chevron = document.getElementById('activity-chevron');
  if (content) {
    content.style.display = _activityOpen ? 'block' : 'none';
    if (_activityOpen) content.classList.add('animate-in');
  }
  if (chevron) chevron.style.transform = _activityOpen ? 'rotate(180deg)' : '';
}

function toggleDashStats() {
  _statsOpen = !_statsOpen;
  const content = document.getElementById('dash-content');
  const chevron = document.getElementById('stats-chevron');
  if (content) {
    content.style.display = _statsOpen ? 'block' : 'none';
    if (_statsOpen) content.classList.add('animate-in');
  }
  if (chevron) chevron.style.transform = _statsOpen ? 'rotate(180deg)' : '';
}

function setRingFilter(ring) {
  _activeFilter = _activeFilter === ring ? null : ring;
  // Update ring visual state
  document.querySelectorAll('.ring-filter-target').forEach(el => {
    el.classList.toggle('ring-active', el.dataset.ring === _activeFilter);
    el.classList.toggle('ring-dimmed', _activeFilter && el.dataset.ring !== _activeFilter);
  });
  // Filter activity stream items
  document.querySelectorAll('.stream-card').forEach(el => {
    if (!_activeFilter) { el.style.display = ''; return; }
    el.style.display = el.dataset.category === _activeFilter ? '' : 'none';
  });
  // Update filter label
  const label = document.getElementById('stream-filter-label');
  if (label) label.textContent = _activeFilter ? RING_LABELS[_activeFilter] : 'All';
}

// ─── Spartan XP Bar ──────────────────────────────────────────
function buildXPBar(data) {
  const container = document.getElementById('xp-bar-container');
  if (!container) return;
  // Try to find active training plan with dates for XP calculation
  const plan = data?.training?.plans;
  if (!plan) { container.innerHTML = ''; return; }

  // Use gamification data for XP if available
  const gam = _gamificationData;
  if (!gam) { container.innerHTML = ''; return; }

  const { rings } = gam;
  const avgPercent = Math.round(((rings.train?.percent || 0) + (rings.fuel?.percent || 0) + (rings.recover?.percent || 0)) / 3);

  container.innerHTML = `
    <div class="xp-bar-label">
      <span>Today's Progress</span>
      <span class="font-data">${avgPercent}%</span>
    </div>
    <div class="xp-bar">
      <div class="xp-bar-fill" style="width:0%"></div>
    </div>
  `;
  requestAnimationFrame(() => {
    setTimeout(() => {
      const fill = container.querySelector('.xp-bar-fill');
      if (fill) fill.style.width = avgPercent + '%';
    }, 200);
  });
}

// ─── Activity Stream ─────────────────────────────────────────
const STREAM_CATEGORY_MAP = {
  workout: { ring: 'train', color: 'var(--color-physical)', ic: 'dumbbell', label: 'Workout' },
  meal: { ring: 'fuel', color: 'var(--color-tactical)', ic: 'utensils', label: 'Meal' },
  body_metric: { ring: 'recover', color: 'var(--color-body)', ic: 'ruler', label: 'Body' },
  task: { ring: 'fuel', color: 'var(--color-tactical)', ic: 'check-square', label: 'Task' },
  knowledge: { ring: 'recover', color: 'var(--color-mental)', ic: 'brain', label: 'Knowledge' },
  transcript: { ring: 'recover', color: 'var(--color-mental)', ic: 'mic', label: 'Transcript' },
  conversation: { ring: 'recover', color: 'var(--color-mental)', ic: 'message-square', label: 'Conversation' },
  coaching: { ring: 'train', color: 'var(--color-physical)', ic: 'graduation-cap', label: 'Coaching' },
  injury: { ring: 'train', color: 'var(--red)', ic: 'heart-pulse', label: 'Injury' },
};

function buildStreamCard(item) {
  const type = item.entity_type || 'task';
  const cat = STREAM_CATEGORY_MAP[type] || { ring: 'fuel', color: 'var(--accent)', ic: 'activity', label: type };
  const time = item.created_at ? timeAgo(item.created_at) : '';
  const title = item.details || item.action || 'Activity';
  const action = item.action || '';
  const actionIcon = action === 'create' ? 'plus' : action === 'update' ? 'pencil' : action === 'delete' ? 'trash-2' : 'activity';
  const metric = item.metric || '';

  return `<div class="stream-card" data-category="${cat.ring}" style="--stream-color:${cat.color}" onclick="toggleStreamDetail(this)">
    <div class="stream-card-header">
      <div class="stream-card-icon">${icon(cat.ic, 15)}</div>
      <div class="stream-card-body">
        <div class="stream-card-title">${esc(title)}</div>
        <div class="stream-card-meta">
          <span>${icon(actionIcon, 10)} ${cat.label}</span>
          <span class="stream-card-time">${time}</span>
        </div>
      </div>
      ${metric ? `<span class="stream-card-metric">${esc(metric)}</span>` : ''}
    </div>
    <div class="stream-card-detail">
      <div class="stream-card-detail-inner">
        ${item.ai_source ? `<span style="color:var(--accent);font-size:0.65rem;text-transform:uppercase">${esc(item.ai_source)}</span> · ` : ''}
        ${item.created_at ? new Date(item.created_at).toLocaleString() : ''}
      </div>
    </div>
  </div>`;
}

function toggleStreamDetail(el) {
  const detail = el.querySelector('.stream-card-detail');
  if (detail) detail.classList.toggle('open');
}

function renderActivityStream(items) {
  const container = document.getElementById('activity-stream');
  if (!container) return;
  if (!items?.length) {
    container.innerHTML = `<div class="stream-empty">${icon('inbox', 20)}<div style="margin-top:8px">No recent activity</div></div>`;
    renderIcons();
    return;
  }
  container.innerHTML = `
    <div class="activity-stream">
      ${items.map(i => buildStreamCard(i)).join('')}
    </div>
  `;
  renderIcons();
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
      { label: 'Workouts', value: data.workouts?.total || 0, color: 'var(--color-physical)', iconName: 'dumbbell', sub: 'history' },
      { label: 'Meals', value: data.meals?.total || 0, color: 'var(--orange)', iconName: 'utensils', sub: 'history' },
      { label: 'Body Metrics', value: data.body_metrics?.total || 0, color: 'var(--color-body)', iconName: 'ruler', sub: 'history' },
    ];
    if (data.training) {
      fitnessCards.push(
        { label: 'Plans', value: data.training.plans?.total || 0, color: 'var(--purple)', iconName: 'notebook-pen', sub: 'today' },
        { label: 'Coaching', value: data.training.coaching_sessions?.total || 0, color: 'var(--cyan)', iconName: 'graduation-cap', sub: 'coaching' },
        { label: 'Injuries', value: activeInjuries, color: activeInjuries > 0 ? 'var(--red)' : '#6b7280', iconName: 'heart-pulse', sub: 'coaching' },
      );
    }

    const dueToday = data.tasks.due_today || 0;
    const dueWeek = data.tasks.due_this_week || 0;
    const todo = data.tasks.by_status.todo || 0;
    const review = data.tasks.by_status.review || 0;
    const done = data.tasks.by_status.done || 0;

    const taskCards = [
      { label: 'To Do', value: todo, color: '#6b7280', iconName: 'clipboard-list', tab: 'tasks' },
      { label: 'In Progress', value: inProgress, color: 'var(--color-body)', iconName: 'loader', tab: 'tasks' },
      { label: 'In Review', value: review, color: 'var(--color-tactical)', iconName: 'search', tab: 'tasks' },
      { label: 'Done', value: done, color: 'var(--color-physical)', iconName: 'check-circle', tab: 'tasks' },
      { label: 'Due Today', value: dueToday, color: dueToday > 0 ? 'var(--red)' : '#6b7280', iconName: 'calendar-clock', tab: 'tasks' },
      { label: 'This Week', value: dueWeek, color: dueWeek > 0 ? 'var(--orange)' : '#6b7280', iconName: 'calendar-range', tab: 'tasks' },
    ];

    const kbCards = [
      { label: 'Conversations', value: data.conversations.total, color: 'var(--purple)', iconName: 'message-square', tab: 'brain', sub: 'conversations' },
      { label: 'Transcripts', value: data.transcripts.total, color: 'var(--color-tactical)', iconName: 'mic', tab: 'brain', sub: 'transcripts' },
      { label: 'Knowledge', value: data.knowledge.total, color: 'var(--color-mental)', iconName: 'brain', tab: 'brain', sub: 'knowledge' },
    ];

    function renderRingCard(c, onclick) {
      return `<div class="ring-card clickable" onclick="${onclick}" style="--card-color:${c.color}">
        <div class="ring-icon" style="background:color-mix(in srgb, ${c.color} 10%, transparent);color:${c.color}">${icon(c.iconName, 18)}</div>
        <div class="ring-value font-data" style="color:${c.color}" data-target="${c.value}">0</div>
        <div class="ring-label">${c.label}</div>
      </div>`;
    }

    container.innerHTML = `
      <div class="dash-section fade-in stagger-1" onclick="switchTab('tasks')" style="cursor:pointer">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:color-mix(in srgb, var(--color-tactical) 10%, transparent);color:var(--color-tactical)">
            ${icon('check-square', 12)}
            Tasks
          </div>
        </div>
        <div class="ring-grid">${taskCards.map(c => renderRingCard(c, `event.stopPropagation();switchTab('${c.tab}')`)).join('')}</div>
      </div>

      <div class="dash-section fade-in stagger-2" onclick="switchTab('brain')" style="cursor:pointer">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:color-mix(in srgb, var(--color-mental) 10%, transparent);color:var(--color-mental)">
            ${icon('brain', 12)}
            Knowledge Base
          </div>
        </div>
        <div class="ring-grid">${kbCards.map(c => renderRingCard(c, `event.stopPropagation();brainSubTab='${c.sub}';switchTab('${c.tab}')`)).join('')}</div>
      </div>

      <div class="dash-section fade-in stagger-3" onclick="switchTab('fitness')" style="cursor:pointer">
        <div class="dash-section-header">
          <div class="dash-section-pill" style="background:color-mix(in srgb, var(--color-physical) 10%, transparent);color:var(--color-physical)">
            ${icon('dumbbell', 12)}
            Fitness
          </div>
        </div>
        <div class="ring-grid">${fitnessCards.map(c => renderRingCard(c, `event.stopPropagation();fitnessSubTab='${c.sub}';switchTab('fitness')`)).join('')}</div>
      </div>

    `;
    renderIcons();
    // Animate all stat values
    document.querySelectorAll('#dash-content [data-target]').forEach(el => {
      animateValue(el, parseInt(el.dataset.target) || 0);
    });
    // Activity Stream
    if (data.recent_activity?.length) {
      renderActivityStream(data.recent_activity);
    }
    // XP Bar
    buildXPBar(data);
  } catch (e) {
    if (e.message === 'Unauthorized') return;
    const container = document.getElementById('dash-content');
    if (container) container.innerHTML = '<div class="empty-state">Could not load stats</div>';
  }
}

// ─── Focus Edit Mode (Dark Room) ─────────────────────────────
function openFocusMode(title, bodyHtml, onSave) {
  closeFocusMode(); // close any existing
  const overlay = document.createElement('div');
  overlay.className = 'focus-overlay';
  overlay.id = 'focus-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) closeFocusMode(); };
  overlay.innerHTML = `
    <div class="focus-card">
      <div class="focus-card-header">
        <div class="focus-card-title">${esc(title)}</div>
        <button class="focus-card-close" onclick="closeFocusMode()">${icon('x', 18)}</button>
      </div>
      <div class="focus-card-body" id="focus-card-body">${bodyHtml}</div>
      ${onSave ? `<div class="focus-card-footer"><button class="focus-save-btn" id="focus-save-btn" onclick="handleFocusSave()">Save</button></div>` : ''}
    </div>
  `;
  document.body.appendChild(overlay);
  renderIcons();
  // Store save callback
  if (onSave) window._focusSaveCallback = onSave;
}

function closeFocusMode() {
  const overlay = document.getElementById('focus-overlay');
  if (overlay) overlay.remove();
  window._focusSaveCallback = null;
}

async function handleFocusSave() {
  if (window._focusSaveCallback) {
    const btn = document.getElementById('focus-save-btn');
    try {
      await window._focusSaveCallback();
      if (btn) { btn.textContent = 'Saved'; btn.classList.add('saved'); }
      setTimeout(() => closeFocusMode(), 600);
    } catch (e) {
      showToast(`Save failed: ${e.message}`, 'error');
    }
  }
}

// Close focus mode on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('focus-overlay')) closeFocusMode();
});

// ─── Gamification (Rings, Streaks, Badges, Nudges, Push) ─────

const RING_COLORS = { train: '#10b981', fuel: '#f59e0b', recover: '#6366f1' };
const RING_LABELS = { train: 'Train', fuel: 'Fuel', recover: 'Recover' };
const RING_DESCRIPTIONS = {
  train: { what: 'Hit effort target', how: 'Complete your planned workout at target intensity', unit: 'effort', fixed: true },
  fuel: { what: 'Hit nutrition targets', how: 'Protein + calories in range + hydration', unit: 'targets', fixed: true },
  recover: { what: 'Recovery quality', how: 'Sleep hours + sleep quality + recovery/energy rating', unit: 'metrics', fixed: true },
};
let _badgesOpen = false;
let _ringsDetailOpen = false;
let _gamificationData = null; // cached for re-renders

function buildRingSVG(rings) {
  const defs = [
    { key: 'train', r: 78, sw: 14 },
    { key: 'fuel', r: 60, sw: 14 },
    { key: 'recover', r: 42, sw: 14 },
  ];
  let paths = '';
  for (const d of defs) {
    const circ = 2 * Math.PI * d.r;
    const pct = rings[d.key]?.percent || 0;
    const offset = circ - (pct / 100) * circ;
    const color = RING_COLORS[d.key];
    const complete = pct >= 100 ? ' ring-complete' : '';
    paths += `<circle cx="90" cy="90" r="${d.r}" stroke="${color}" stroke-width="${d.sw}" class="ring-bg"/>`;
    paths += `<circle cx="90" cy="90" r="${d.r}" stroke="${color}" stroke-width="${d.sw}" class="ring-progress${complete}" stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-target-offset="${offset}" data-circ="${circ}"/>`;
  }
  return `<svg viewBox="0 0 180 180" class="rings-svg">${paths}</svg>`;
}

function buildRingDetailCards(rings) {
  return Object.keys(RING_COLORS).map(k => {
    const ring = rings[k] || { current: 0, goal: 1, percent: 0 };
    const closed = ring.percent >= 100;
    const desc = RING_DESCRIPTIONS[k];
    const color = RING_COLORS[k];

    // Build achievement checklist based on ring type
    let checklist = '';
    if (k === 'train') {
      const effortActual = ring.current || 0;
      const effortTarget = ring.goal || 6;
      if (ring.is_rest_day) {
        checklist = `<div class="ring-checklist"><div class="ring-check-item done">Rest Day — auto-closed</div></div>`;
      } else {
        checklist = `<div class="ring-checklist">
          <div class="ring-check-item ${effortActual > 0 ? 'done' : ''}">Workout logged ${effortActual > 0 ? '&#10003;' : '&#10007;'}</div>
          <div class="ring-check-item ${closed ? 'done' : ''}">Effort ${effortActual}/${effortTarget} (${ring.percent}%) ${closed ? '&#10003;' : ''}</div>
          ${!ring.has_plan ? '<div class="ring-check-hint">No daily plan — using default effort target</div>' : ''}
        </div>`;
      }
    } else if (k === 'fuel') {
      const check = v => v ? '<span class="check-mark">&#10003;</span>' : '';
      checklist = `<div class="ring-checklist">
        <div class="ring-check-item ${ring.protein_hit ? 'done' : ''}">
          <span class="ring-sub-label">Protein: ${ring.protein_actual || 0}g / ${ring.protein_target || '?'}g ${check(ring.protein_hit)}</span>
          <div class="ring-sub-bar-track"><div class="ring-sub-bar-fill" style="width:${ring.protein_progress || 0}%;background:${color}"></div></div>
        </div>
        <div class="ring-check-item ${ring.calories_hit ? 'done' : ''}">
          <span class="ring-sub-label">Calories: ${ring.calories_actual || 0} (${ring.calories_min || '?'}-${ring.calories_max || '?'}) ${check(ring.calories_hit)}</span>
          <div class="ring-sub-bar-track"><div class="ring-sub-bar-fill" style="width:${ring.calories_progress || 0}%;background:${color}"></div></div>
        </div>
        <div class="ring-check-item ${ring.hydration_hit ? 'done' : ''}">
          <span class="ring-sub-label">Hydration: ${ring.hydration_actual || 0}L / ${ring.hydration_target || '?'}L ${check(ring.hydration_hit)}</span>
          <div class="ring-sub-bar-track"><div class="ring-sub-bar-fill" style="width:${ring.hydration_progress || 0}%;background:${color}"></div></div>
        </div>
      </div>`;
    } else if (k === 'recover') {
      const check = v => v ? '<span class="check-mark">&#10003;</span>' : '';
      checklist = `<div class="ring-checklist">
        <div class="ring-check-item ${ring.sleep_hit ? 'done' : ''}">
          <span class="ring-sub-label">Sleep: ${ring.sleep_actual || '?'}h / ${ring.sleep_target || '?'}h ${check(ring.sleep_hit)}</span>
          <div class="ring-sub-bar-track"><div class="ring-sub-bar-fill" style="width:${ring.sleep_progress || 0}%;background:${color}"></div></div>
        </div>
        <div class="ring-check-item ${ring.quality_hit ? 'done' : ''}">
          <span class="ring-sub-label">Sleep Quality: ${ring.sleep_quality_actual || '?'}/10 (need ${ring.sleep_quality_threshold || '?'}+) ${check(ring.quality_hit)}</span>
          <div class="ring-sub-bar-track"><div class="ring-sub-bar-fill" style="width:${ring.quality_progress || 0}%;background:${color}"></div></div>
        </div>
        <div class="ring-check-item ${ring.recovery_hit ? 'done' : ''}">
          <span class="ring-sub-label">Recovery: ${ring.recovery_actual || '?'}/10 (need ${ring.recovery_threshold || '?'}+) ${check(ring.recovery_hit)}</span>
          <div class="ring-sub-bar-track"><div class="ring-sub-bar-fill" style="width:${ring.recovery_progress || 0}%;background:${color}"></div></div>
        </div>
      </div>`;
    }

    return `<div class="ring-detail-card ${closed ? 'ring-closed' : ''}" style="--ring-color:${color}">
      <div class="ring-detail-header">
        <span class="ring-detail-dot" style="background:${color}"></span>
        <span class="ring-detail-name">${RING_LABELS[k]}</span>
        <span class="ring-detail-progress" style="color:${color}">${ring.percent}%</span>
        ${closed ? '<span class="ring-detail-check">&#10003;</span>' : ''}
      </div>
      <div class="ring-detail-bar-track"><div class="ring-detail-bar-fill" style="width:${ring.percent}%;background:${color}"></div></div>
      <div class="ring-detail-desc"><strong>${desc.what}</strong></div>
      ${checklist}
    </div>`;
  }).join('');
}

function buildWeeklyBar(weekly) {
  if (!weekly || !weekly.train) return '';
  const w = weekly;
  const bars = [
    { label: 'Train', value: w.train.days_closed, target: w.train.target_days, color: RING_COLORS.train, detail: `Train ring closed ${w.train.days_closed}/${w.train.target_days} days` },
    { label: 'Fuel', value: w.fuel?.days_closed || 0, target: w.fuel?.target_days || 5, color: RING_COLORS.fuel, detail: `Fuel ring closed ${w.fuel?.days_closed || 0}/${w.fuel?.target_days || 5} days` },
    { label: 'Recover', value: w.recover.days_closed, target: w.recover.target_days, color: RING_COLORS.recover, detail: `Recover ring closed ${w.recover.days_closed}/${w.recover.target_days} days` },
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
    const sugIcon = s.direction === 'up' ? icon('trending-up', 14) : icon('trending-down', 14);
    const actionLabel = s.direction === 'up' ? 'Level Up' : 'Adjust';
    return `<div class="suggestion-card" style="--sug-color:${color}">
      <div class="suggestion-body">
        <span class="suggestion-icon" style="color:${color}">${sugIcon}</span>
        <span class="suggestion-text">${esc(s.reason)}</span>
      </div>
      <button class="suggestion-apply" onclick="event.stopPropagation();updateRingSetting('${s.ring}', ${s.suggested_goal})" style="background:${color}">
        ${actionLabel} to ${s.suggested_goal}
      </button>
    </div>`;
  }).join('');
}

async function updateRingSetting(key, value) {
  try {
    await api('/gamification/settings', {
      method: 'PUT',
      body: JSON.stringify({ [key]: value }),
    });
    showToast('Setting updated', 'success', 2000);
    setTimeout(() => loadGamification(), 300);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

function buildStreakChips(streaks) {
  const defs = [
    { key: 'train', ic: 'flame', label: 'Train', desc: 'Consecutive days with workout at target effort', color: 'var(--color-physical)' },
    { key: 'fuel', ic: 'utensils', label: 'Fuel', desc: 'Consecutive days hitting 2+ nutrition targets', color: 'var(--color-tactical)' },
    { key: 'recover', ic: 'leaf', label: 'Recover', desc: 'Consecutive days hitting 2+ recovery targets', color: 'var(--color-mental)' },
    { key: 'perfect_day', ic: 'gem', label: 'Perfect', desc: 'Consecutive days with all 3 rings closed', color: 'var(--accent)' },
    { key: 'weigh_in', ic: 'scale', label: 'Weigh-in', desc: 'Consecutive days with a body metric logged', color: 'var(--color-body)' },
  ];
  return defs.map(d => {
    const val = streaks[d.key] || 0;
    const active = val > 0 ? ' active' : '';
    return `<div class="streak-chip${active}" title="${d.desc}" style="--streak-color:${d.color}">
      <span class="streak-icon" style="color:${d.color}">${icon(d.ic, 14)}</span>
      <span class="streak-count">${val}d</span>
      <span>${d.label}</span>
    </div>`;
  }).join('');
}

function buildNudges(nudges) {
  if (!nudges?.length) return '';
  return nudges.map(n => {
    const type = n.type === 'success' ? 'success' : n.type === 'warning' ? 'warning' : 'info';
    const ic = type === 'success' ? icon('check', 12) : type === 'warning' ? icon('alert-triangle', 12) : icon('info', 12);
    return `<div class="nudge-banner nudge-${type}"><span class="nudge-icon-circle nudge-icon-${type}">${ic}</span><span>${esc(n.message)}</span></div>`;
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
        <span class="badge-row-icon">${badgeIcon(b.icon)}</span>
        <div class="badge-row-info">
          <div class="badge-row-name">${esc(b.name)}</div>
          <div class="badge-row-desc">${esc(b.description)}</div>
        </div>
        ${b.isUnlocked ? `<span class="badge-row-date">${dateStr}</span>` : `<span class="badge-row-lock">${icon('lock', 14)}</span>`}
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

function showBadgeDetail(el) {
  const name = el.dataset.name;
  const desc = el.dataset.desc;
  const bdgIcon = el.dataset.icon;
  const unlocked = el.dataset.unlocked === '1';
  const date = el.dataset.date;

  // Remove any existing expanded detail
  document.querySelectorAll('.badge-detail-expanded').forEach(e => e.remove());

  const detail = document.createElement('div');
  detail.className = 'badge-detail-expanded';
  detail.innerHTML = `
    <div class="badge-detail-icon">${badgeIcon(bdgIcon, 28)}</div>
    <div class="badge-detail-body">
      <div class="badge-detail-name">${name}</div>
      <div class="badge-detail-desc">${desc}</div>
      ${unlocked ? `<div class="badge-detail-status unlocked">Unlocked ${date}</div>` : `<div class="badge-detail-status locked">Not yet unlocked &mdash; keep going!</div>`}
    </div>
  `;
  renderIcons();
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
          ${icon('bell', 16)}
          <span style="flex:1">Enable notifications to stay on track</span>
          <button class="push-allow" onclick="requestPushPermission()">Allow</button>
          <button class="push-later" onclick="dismissPushBanner()">Later</button>
        </div>`;
      }
    }

    const allClosed = rings.train?.percent >= 100 && rings.fuel?.percent >= 100 && rings.recover?.percent >= 100;

    // Nudges + Suggestions → promoted to #today-actions
    const actionsEl = document.getElementById('today-actions');
    if (actionsEl) {
      const actionNudges = [...(regularNudges || []).slice(0, 3)];
      const suggestionHtml = suggestions?.length ? buildSuggestionCards(suggestions) : '';
      actionsEl.innerHTML = buildNudges(actionNudges) + suggestionHtml;
    }

    // Rings hero — tapping individual rings sets a filter
    container.innerHTML = `
      ${pushBanner}
      <div class="rings-hero fade-in animate-in stagger-3">
        <div class="rings-container" onclick="toggleRingsDetail()" style="cursor:pointer">
          ${buildRingSVG(rings)}
          <div class="rings-center-label"><span class="rings-a">${allClosed ? '&#10003;' : 'A'}</span></div>
        </div>
        <div class="rings-legend">
          ${Object.keys(RING_COLORS).map(k => {
            const r = rings[k] || {};
            const closed = r.percent >= 100;
            return `<div class="rings-legend-item ring-filter-target${_activeFilter === k ? ' ring-active' : ''}${_activeFilter && _activeFilter !== k ? ' ring-dimmed' : ''}" data-ring="${k}" onclick="event.stopPropagation();setRingFilter('${k}')">
              <span class="rings-legend-dot" style="background:${RING_COLORS[k]}"></span>
              <span>${RING_LABELS[k]}</span>
              <span class="rings-legend-value" style="color:${RING_COLORS[k]}">${r.percent || 0}%${closed ? ' &#10003;' : ''}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="rings-tap-hint" onclick="toggleRingsDetail()" style="cursor:pointer">Tap for details</div>
      </div>
      ${data.today_plan ? `<div class="today-plan-card animate-in stagger-2" onclick="fitnessSubTab='today';switchTab('fitness')">
        <div class="today-plan-header">
          <span class="today-plan-dot" style="background:${data.today_plan.status === 'rest' ? '#6366f1' : '#10b981'}"></span>
          <span class="today-plan-label">${data.today_plan.status === 'rest' ? 'Rest Day' : (data.today_plan.workout_type || 'Workout') + (data.today_plan.workout_focus ? ' — ' + data.today_plan.workout_focus : '')}</span>
          ${data.today_plan.target_effort ? `<span class="today-plan-effort">Effort ${data.today_plan.target_effort}</span>` : ''}
        </div>
      </div>` : ''}
      <div class="rings-detail-panel${_ringsDetailOpen ? ' open' : ''}" id="rings-detail-panel">
        <div class="rings-detail-title">Ring Progress</div>
        ${buildRingDetailCards(rings)}
        ${buildWeeklyBar(weekly)}
      </div>
      <div class="streaks-row fade-in stagger-1">${buildStreakChips(streaks)}</div>
    `;

    renderIcons();

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
        showToast(`Badge unlocked: ${b.name} — ${b.description}`, 'success', 5000);
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
  loadSchemaBuilder();
  loadGymProfiles();
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

/* ── Schema Builder ── */
let _fullSchema = null;

// Skip these operationIds from presets (low-priority: deletes, bulk imports)
const SKIP_OPS = new Set([
  'deleteKnowledge','deleteTask','deleteConversation','deleteTranscript',
  'deleteWorkout','deleteBodyMetric','deleteMeal','deleteTrainingPlan',
  'deleteCoachingSession','deleteInjury',
  'bulkImportWorkouts','bulkImportBodyMetrics','bulkImportMeals',
  'listProjects','createProject','searchFacts','createFact','getFact','updateFact','deleteFact'
]);

// Fitness-focused paths for Spartan preset
const SPARTAN_PATHS = [
  '/workouts','/workouts/{id}','/workouts/stats/summary','/workouts/bulk',
  '/body-metrics','/body-metrics/{id}','/body-metrics/stats/summary','/body-metrics/bulk',
  '/meals','/meals/{id}','/meals/bulk',
  '/nutrition/daily-context','/nutrition/daily-context/{id}','/nutrition/daily-summary','/nutrition/daily-summary/range',
  '/training/plans','/training/plans/{id}','/training/coaching','/training/coaching/{id}',
  '/training/injuries','/training/injuries/{id}','/training/injuries/active/summary',
  '/training/day/{date}',
  '/exercises','/exercises/{id}','/exercises/equipment','/exercises/categories','/exercises/stats',
  '/gym-profiles','/gym-profiles/{id}','/gym-profiles/primary',
  '/daily-plans','/daily-plans/{id}','/daily-plans/by-date/{date}','/daily-plans/{id}/review','/daily-plans/week',
  '/gamification','/gamification/settings',
  '/intake','/search','/search/ai','/dashboard'
];

async function loadSchemaBuilder() {
  if (_fullSchema) return;
  const resp = await fetch('/openapi-everything.json');
  if (!resp.ok) return;
  _fullSchema = await resp.json();
  renderSchemaBuilder();
}

function renderSchemaBuilder() {
  const container = document.getElementById('schema-builder-list');
  if (!container || !_fullSchema) return;
  // Group by path prefix
  const groups = {};
  for (const [path, methods] of Object.entries(_fullSchema.paths)) {
    const prefix = path.split('/').filter(Boolean)[0] || 'other';
    const label = prefix.replace('training','training').replace('nutrition','nutrition');
    if (!groups[label]) groups[label] = [];
    for (const method of Object.keys(methods)) {
      if (!['get','post','put','patch','delete'].includes(method)) continue;
      const op = methods[method];
      groups[label].push({ path, method, opId: op.operationId, summary: op.summary || '' });
    }
  }
  let html = '';
  for (const [group, ops] of Object.entries(groups)) {
    html += `<div style="margin-top:6px;font-weight:600;color:var(--accent);text-transform:capitalize">${group}</div>`;
    for (const op of ops) {
      const id = `schema-cb-${op.opId}`;
      html += `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer">
        <input type="checkbox" id="${id}" data-path="${op.path}" data-method="${op.method}" data-opid="${op.opId}" onchange="updateSchemaCount()">
        <span style="color:var(--text-dim);min-width:42px;font-size:0.65rem;text-transform:uppercase">${op.method}</span>
        <span>${op.summary || op.opId}</span>
      </label>`;
    }
  }
  container.innerHTML = html;
}

function schemaPreset(type) {
  const cbs = Array.from(document.querySelectorAll('#schema-builder-list input[type=checkbox]'));
  if (type === 'none') {
    cbs.forEach(cb => cb.checked = false);
  } else if (type === 'claude') {
    // Select ALL endpoints, no limit
    cbs.forEach(cb => {
      cb.checked = true;
    });
  } else if (type === 'all') {
    // Select best 30: skip deletes and bulk, prioritize by order (ChatGPT limit)
    let count = 0;
    cbs.forEach(cb => {
      const dominated = SKIP_OPS.has(cb.dataset.opid);
      cb.checked = !dominated && count < 30;
      if (cb.checked) count++;
    });
  } else if (type === 'spartan') {
    let count = 0;
    cbs.forEach(cb => {
      const path = cb.dataset.path;
      const inSpartan = SPARTAN_PATHS.some(p => path.startsWith(p.replace('/{id}','').replace('/{date}','')) || path === p);
      const skip = SKIP_OPS.has(cb.dataset.opid);
      cb.checked = inSpartan && !skip && count < 30;
      if (cb.checked) count++;
    });
  } else if (type === 'brain') {
    let count = 0;
    cbs.forEach(cb => {
      const path = cb.dataset.path;
      const isBrain = !SPARTAN_PATHS.includes(path) || ['/intake','/search','/dashboard'].includes(path);
      const skip = SKIP_OPS.has(cb.dataset.opid);
      cb.checked = isBrain && !skip && count < 30;
      if (cb.checked) count++;
    });
  }
  updateSchemaCount();
}

function updateSchemaCount() {
  const count = document.querySelectorAll('#schema-builder-list input:checked').length;
  const el = document.getElementById('schema-count');
  if (el) {
    el.textContent = count;
    el.style.color = count > 30 ? '#e74c3c' : 'var(--accent)';
  }
}

async function copyBuiltSchema() {
  const btn = document.getElementById('btn-copy-built');
  const resultEl = document.getElementById('sm-schema-result');
  if (!_fullSchema) { await loadSchemaBuilder(); }
  const checked = document.querySelectorAll('#schema-builder-list input:checked');
  if (checked.length === 0) {
    resultEl.style.display = 'block';
    resultEl.style.color = '#e74c3c';
    resultEl.textContent = 'Select at least one endpoint.';
    return;
  }
  if (checked.length > 30) {
    resultEl.style.display = 'block';
    resultEl.style.color = '#f39c12';
    resultEl.textContent = `${checked.length} endpoints selected. ChatGPT limit is 30 — Claude has no limit.`;
  }
  // Build filtered schema
  const selected = new Map();
  checked.forEach(cb => {
    const key = cb.dataset.path;
    if (!selected.has(key)) selected.set(key, []);
    selected.get(key).push(cb.dataset.method);
  });
  const built = JSON.parse(JSON.stringify(_fullSchema));
  built.paths = {};
  for (const [path, methods] of selected.entries()) {
    built.paths[path] = {};
    for (const m of methods) {
      if (_fullSchema.paths[path] && _fullSchema.paths[path][m]) {
        built.paths[path][m] = _fullSchema.paths[path][m];
      }
    }
  }
  // Keep only referenced schemas
  const text = JSON.stringify(built.paths);
  if (built.components && built.components.schemas) {
    for (const name of Object.keys(built.components.schemas)) {
      if (!text.includes('#/components/schemas/' + name)) {
        delete built.components.schemas[name];
      }
    }
  }
  try {
    btn.textContent = 'Copying...';
    const out = JSON.stringify(built, null, 2);
    await navigator.clipboard.writeText(out);
    btn.textContent = 'Copied!';
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--accent)';
    resultEl.textContent = `Copied ${checked.length} operations to clipboard.`;
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
  return `You are Avi's personal AI assistant with full read/write access to his AB Brain knowledge base. AB Brain is Avi's unified personal system for capturing knowledge, managing tasks, reviewing Bee wearable transcripts, and storing AI conversations.

## IDENTITY & TONE
- Be direct, efficient, and concise. Lead with answers, not preamble.
- When saving data, confirm briefly — don't parrot back every field.
- When querying data, summarize findings — don't dump raw JSON.
- Avi is a builder and business owner who tracks everything. Respect his time.

## CRITICAL: SEARCHING & DATE FILTERING

The search system has two distinct paths. Using the wrong one will return zero results.

### Text/Topic Search
Use \`GET /search?q=term\` or \`POST /search/ai\` to find content by keywords or topics.
These search across: knowledge, transcripts, tasks, conversations, workouts, meals, body metrics, training plans, coaching sessions, injuries.

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

### Viewing Tasks
- \`GET /tasks/kanban\` — board view organized by status (todo, in_progress, review, done)
- \`GET /tasks?status=todo\` — filter by status
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

## RESPONSE STYLE
- After creating/updating data, give a one-line confirmation with the key info.
- When querying, summarize — don't paste raw API responses.
- If you spot duplicates, stale tasks, or inconsistencies, flag them.
- When Avi shares meeting notes or thoughts, proactively offer to save as knowledge or create tasks.`;
}

function getFitnessGptInstructions() {
  return `You are Avi's direct, opinionated AI training coach with read/write access to AB Brain. Avi is a serious Spartan/OCR athlete. Upcoming race: Spartan Vernon NJ Sprint on April 26, 2026. Goal: 60–70 min. Prior: ~90 min.
TONE
- Lead with the answer.
- Be concise. No fluff.
- After logging: confirm what was saved.
- When analyzing: state trend, risk, and action.
HARD RULES
- Never use a date string as a text search query. Use structured date filters.
- Use topic search only for topics/keywords: \`GET /search?q=term\` or \`POST /search/ai\`.
- Before training advice or planning, check:
  1. active injuries
  2. today's training/day context
  3. gym profile (available equipment)
  4. active plans
- After substantive coaching, save a coaching session.
- Factor active injuries into every recommendation automatically.
- Set \`ai_source: "chatgpt"\` on created records when supported.

EXERCISE CATALOG (1060+ exercises)
The catalog stores Fitbod exercises with Muscle Strength Score (mscore):
- 90-100: elite compound movements (Barbell Squat, Deadlift, Bench Press) — use for main lifts
- 70-89: strong accessories (Romanian Deadlift, Incline DB Press) — pair with compounds
- 50-69: moderate isolation/single-joint (Lateral Raise, Leg Curl) — accessory work
- <50: light/stabilizer (Wrist Curls, Face Pulls) — warm-up or prehab
Search exercises: \`GET /exercises?q=keyword&equipment=Barbell&muscle_group=Chest&level=intermediate&sort=mscore_desc\`
Equipment list: \`GET /exercises/equipment\` — all equipment types with counts
Categories: \`GET /exercises/categories\`
Stats overview: \`GET /exercises/stats\` — top mscore exercises, counts by level/equipment
When prescribing exercises, ALWAYS select from the catalog. Prefer higher mscore exercises for main work.
To add custom exercises (Spartan-specific, hybrid): \`POST /exercises\` with name, equipment, primary_muscle_groups, category, level, and estimated muscle_strength_score.

GYM PROFILE
Check \`GET /gym-profiles/primary\` to know what equipment Avi has available.
ALWAYS filter exercise recommendations to equipment in the gym profile. If equipment is unavailable, suggest the best alternative from available equipment.
Coach can create/update gym profiles: \`POST /gym-profiles\`, \`PUT /gym-profiles/{id}\`.
Equipment is a JSON array of strings, e.g. ["Barbell","Dumbbells","Cable Machine","Pull Up Bar"].
When the user shares GYM PHOTOS: identify all visible equipment, create a gym profile via \`POST /gym-profiles\` with the equipment list, and set \`is_primary: true\` if no primary profile exists. Confirm what was saved.

CORE WORKFLOW
1. Evaluate: review recent training, recovery, injuries, adherence.
2. Plan: create or adjust daily/weekly training targets.
3. Execute: log workouts, meals, daily context.
4. Review: compare plan vs actual, extract lesson, adjust next step, save coaching summary.
USE THESE ENDPOINT PATTERNS
- Workouts: list/search by filters, log with \`POST /workouts\`
- Meals: \`GET /meals?date=...\` or range; log with \`POST /meals\`
- Body metrics: \`GET /body-metrics?latest=true\` or range; log with \`POST /body-metrics\`
- Daily context: \`GET/POST /nutrition/daily-context\`
- Daily summary: \`GET /nutrition/daily-summary?date=...\`
- Range nutrition review: \`GET /nutrition/daily-summary/range?since=...&before=...\`
- Daily plans: \`GET /daily-plans?from=&to=\`, create with \`POST /daily-plans\`, \`POST /daily-plans/week\` for 7 days at once
- Coaching sessions: list by date range, create after substantive reviews
- Full day view when needed: \`GET /training/day/YYYY-MM-DD\`
EXERCISE LIBRARY & GYM PROFILES
- \`GET /exercises/available\` — exercises matching the active gym profile's equipment
- \`GET /exercises?muscle=chest&equipment=dumbbell\` — filter by muscle/equipment
- \`GET /exercises/gym-profiles/active\` — current gym profile + equipment list
- \`POST /exercises/import-fitbod\` — import from Fitbod CSV export
- \`POST /exercises/gym-profiles\` — create profile (name, equipment[], is_active)
- \`PUT /exercises/gym-profiles/:id\` — update profile
- \`GET /exercises/equipment\` — full equipment catalog for picker

WORKOUT PLANNING (Fitbod-compatible)
When planning workouts, ALWAYS:
1. Check the active gym profile: \`GET /exercises/gym-profiles/active\`
2. Only suggest exercises available for that profile's equipment: \`GET /exercises/available\`
3. Use EXACT exercise names from the library (these match Fitbod naming so Avi can quickly find them)
4. ALWAYS include specific weight targets for every exercise. Look up Avi's recent workout history to set appropriate weights.
   Do NOT write "build to heavy" or "moderate-heavy" — give a number: "3x10 @ 50 lb" not "3x10, build to moderate-heavy".
   If unsure, give a range: "3x10 @ 45-55 lb". For bodyweight exercises, say "bodyweight". For bands, say the band level.
5. Save structured planned_exercises on the daily plan using \`PUT /daily-plans/:id\`:
   \`planned_exercises\` is a JSONB array:
   [{ "name": "Barbell Bench Press", "sets": 4, "reps": 6, "weight": "175 lb",
      "group": "main", "muscle_primary": "chest", "muscle_secondary": ["triceps","shoulders"],
      "superset_with": null, "notes": "" },
    { "name": "Cable Fly", "sets": 3, "reps": 12, "weight": "30 lb",
      "group": "superset", "superset_with": "Dumbbell Lateral Raise" }]
   Valid groups: warmup, main, superset, circuit, finisher
6. Also put a human-readable summary in workout_notes for Avi to reference in Fitbod.
   Format each exercise as: "- Exercise Name: SETSxREPS @ WEIGHT" (e.g. "- Leg Press: 4x10 @ 180 lb")
7. If an exercise isn't in the library, add it: \`POST /exercises\` with name, muscle_primary, equipment

PLAN-WORKOUT CONNECTION
- Plans and workouts are linked by date (plan_date = workout_date) and optionally by daily_plan_id
- After Avi completes a workout (sends Fitbod screenshots), log the actual workout:
  \`POST /workouts\` with \`daily_plan_id\` set to the plan's id, and structured \`exercises\` JSONB:
  [{ "name": "Barbell Bench Press", "sets": 4, "reps": 6, "weight": "180 lb",
     "muscle_primary": "chest", "muscle_secondary": ["triceps","shoulders"],
     "completed": true, "notes": "PR" }]
- Then update the plan: \`PUT /daily-plans/:id\` with:
  - status: "completed" or "partial"
  - actual_exercises: same structured array of what was actually done
  - completion_notes: your review (what changed, what was skipped, why)
- Recovery scoring reads structured exercises for granular per-muscle tracking.
  Exercises before March 2026 use legacy workout_type mapping. New structured data gives better accuracy.

LOGGING FROM FITBOD SCREENSHOTS
When Avi sends Fitbod screenshots, extract exercises into the structured format:
- Fitbod summary view: exercise name, highest weight, volume, estimated 1RM, total reps, PRs
- Fitbod detail view: each set with reps × weight
- Log whichever level of detail the screenshot shows. Both are valid.
- For BANDS (resistance bands, loop bands): keep the label exactly as Fitbod shows (Light, Medium, Heavy, X-Heavy).
  Do NOT convert to pounds — band resistance varies by stance, stretch, and brand. Treat labels as RPE.
  Track progression by label: "Heavy → X-Heavy for same reps" = progress.
- For TIMED exercises (plank, stretches): log duration per set, not reps.
- Exercise names must match Fitbod naming exactly. If an exercise isn't in the library, add it via POST /exercises.
- Mark PRs (trophy icon in Fitbod) in the exercise notes field.

WORKOUT LOGGING
Use \`POST /workouts\`. Required: \`workout_type\`.
Include when relevant:
- daily_plan_id — link to the plan this workout fulfills (if planned)
- exercises — structured JSONB array (see schema above). Include muscle_primary for recovery tracking.
- focus, warmup, main_sets, carries (legacy text fields, still supported)
- time_duration (text, e.g. "45 min") or duration_minutes (integer) — server auto-parses text to numeric
- distance (text) or distance_value (number), elevation_gain (text) or elevation_gain_ft (integer)
- heart_rate_avg/hr_avg, heart_rate_max/hr_max, active_calories/cal_active, total_calories/cal_total — text or numeric
- effort 1–10
- slowdown_notes, failure_first
- grip_feedback, legs_feedback, cardio_feedback, shoulder_feedback, body_notes
- adjustment
- pace_avg, cadence_avg, splits
- lowercase tags
Workout types: hill, strength, run, hybrid, recovery, ruck.

ENDPOINT PATTERNS
- Exercises: \`GET /exercises?q=&equipment=&muscle_group=&sort=mscore_desc\`
- Gym profiles: \`GET /gym-profiles\`, \`GET /gym-profiles/primary\`
- Workouts: list/search by filters, log with \`POST /workouts\`
- Meals: \`GET /meals?date=...\` or range; log with \`POST /meals\`
- Body metrics: \`GET /body-metrics?latest=true\` or range; log with \`POST /body-metrics\`
- Daily context: \`GET/POST /nutrition/daily-context\`
- Daily summary: \`GET /nutrition/daily-summary?date=...\`
- Range nutrition review: \`GET /nutrition/daily-summary/range?since=...&before=...\`
- Daily plans: \`GET /daily-plans?from=&to=\`, \`POST /daily-plans\`, \`POST /daily-plans/week\`
- Plan review: \`GET /daily-plans/{id}/review\`
- Coaching sessions: list by date range, create after substantive reviews
- Full day view: \`GET /training/day/YYYY-MM-DD\`

MEAL LOGGING
Use \`POST /meals\`. Required: \`title\`, \`meal_date\`.
- Estimate macros reasonably if Avi describes food casually.
- meal_type: breakfast, lunch, dinner, snack, pre-workout, post-workout, drink, supplement
BODY METRICS
RENPHO trends matter more than single readings.
Key fields: weight_lb, body_fat_pct, skeletal_muscle_pct, visceral_fat, bmr_kcal, metabolic_age.
INJURIES
Always check active injury summary first.
Track severity, symptoms, aggravating movements, relieving factors, modifications, prevention notes.
WEEKLY SCORECARD
When asked, score: Engine, Strength & carries, Race specificity, Recovery, Nutrition, Injury management, Overall grade.
Use actual logged patterns, not hype. Call out junk volume, poor fueling, fake recovery, rising injury risk.
VERNON NJ RACE CONTEXT
Bias recommendations toward: steep trail running, short high-output climbs, carry durability, grip under fatigue, fast obstacle transitions, leg durability without trashing recovery.
OUTPUT STYLE
- Logging: one-line confirmation.
- Analysis: insight first, then supporting data.
- Plans: format exercises clearly for Fitbod transcription (Exercise Name: SetsxReps @Weight, rest).
- Coaching: clear next action.
- Tell the truth. Don't inflate progress.`;
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

async function copyClaudeSchema() {
  const btn = document.getElementById('btn-copy-claude-schema');
  const resultEl = document.getElementById('sm-claude-schema-result');
  try {
    btn.textContent = 'Fetching...';
    const res = await fetch('/claude-schema.json');
    const text = await res.text();
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--accent)';
    resultEl.textContent = 'Claude schema copied to clipboard.';
    setTimeout(() => { btn.textContent = 'Copy JSON Schema'; }, 3000);
  } catch (err) {
    btn.textContent = 'Copy JSON Schema';
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
    const res = await fetch(API + '/health-check');
    const data = await res.json().catch(() => ({}));
    if (bkEl) {
      bkEl.textContent = res.ok ? (data.backend || 'PostgreSQL') + ' — connected' : 'error';
      bkEl.style.color = res.ok ? 'var(--green)' : 'var(--red)';
    }
    const verEl = document.getElementById('sm-version');
    if (verEl && data.version) verEl.textContent = 'v' + data.version;
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
let tasksSubTab = 'today';
function tasksTabsHtml() {
  return `<div class="brain-tabs">
    <button class="brain-tab${tasksSubTab==='today'?' active':''}" onclick="tasksSubTab='today';loadTasks()">Today</button>
    <button class="brain-tab${tasksSubTab==='waiting'?' active':''}" onclick="tasksSubTab='waiting';loadTasks()">Waiting</button>
    <button class="brain-tab${tasksSubTab==='list'?' active':''}" onclick="tasksSubTab='list';loadTasks()">List</button>
    <button class="brain-tab${tasksSubTab==='kanban'?' active':''}" onclick="tasksSubTab='kanban';loadTasks()">Kanban</button>
    <button class="brain-tab${tasksSubTab==='calendar'?' active':''}" onclick="tasksSubTab='calendar';loadTasks()">Calendar</button>
  </div>`;
}

async function loadTasks() {
  const main = document.getElementById('main-content');
  main.innerHTML = tasksTabsHtml() + '<div class="loading">Loading...</div>';
  if (tasksSubTab === 'today') return loadTasksToday();
  if (tasksSubTab === 'waiting') return loadTasksWaiting();
  if (tasksSubTab === 'kanban') return loadTasksKanban();
  if (tasksSubTab === 'calendar') return loadTasksCalendar();
  return loadTasksList();
}

// ── Today Focus View ──
async function loadTasksToday() {
  const main = document.getElementById('main-content');
  try {
    const data = await api('/tasks?limit=200');
    const tasks = data.tasks || [];
    const today = new Date(); today.setHours(0,0,0,0);
    const todayStr = today.toDateString();

    // Categorize tasks
    const overdue = [];
    const dueToday = [];
    const inProgress = [];
    const waitingOn = [];
    const topPriority = [];
    const recentlyDone = [];

    const priorityRank = { urgent: 0, high: 1, medium: 2, low: 3 };

    for (const t of tasks) {
      if (t.status === 'done') {
        if (t.completed_at && new Date(t.completed_at).toDateString() === todayStr) {
          recentlyDone.push(t);
        }
        continue;
      }

      if (t.status === 'waiting_on') {
        waitingOn.push(t);
        continue;
      }

      const due = t.due_date ? new Date(t.due_date) : null;
      if (due) due.setHours(0,0,0,0);

      if (due && due < today) {
        overdue.push(t);
      } else if (due && due.toDateString() === todayStr) {
        dueToday.push(t);
      } else if (t.status === 'in_progress') {
        inProgress.push(t);
      } else {
        topPriority.push(t);
      }
    }

    // Sort by priority
    const byPriority = (a, b) => (priorityRank[a.priority] ?? 4) - (priorityRank[b.priority] ?? 4);
    overdue.sort(byPriority);
    dueToday.sort(byPriority);
    inProgress.sort(byPriority);
    topPriority.sort(byPriority);

    // Group waiting_on by person
    const waitingByPerson = {};
    for (const t of waitingOn) {
      const person = (t.waiting_on || 'Unknown').trim();
      (waitingByPerson[person] = waitingByPerson[person] || []).push(t);
    }

    // Only show top 5 from the backlog
    const topBacklog = topPriority.slice(0, 5);

    const totalFocus = overdue.length + dueToday.length + inProgress.length;

    // Date helpers for reschedule
    const todayISO = localDateStr(today);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = localDateStr(tomorrow);
    const nextMon = new Date(today); nextMon.setDate(nextMon.getDate() + ((8 - nextMon.getDay()) % 7 || 7));
    const nextMonISO = localDateStr(nextMon);

    function renderTodayCard(t, showDue, showReschedule) {
      const checklist = t.checklist || [];
      const checkProgress = checklist.length ? ` <span style="font-size:0.7rem;color:var(--text-dim)">${checklist.filter(i=>i.done).length}/${checklist.length}</span>` : '';
      const commentCount = t.comment_count ? ` <span style="font-size:0.7rem;color:var(--text-dim)">💬${t.comment_count}</span>` : '';
      const dueBadge = showDue && t.due_date ? (() => {
        const d = new Date(t.due_date);
        const isOverdue = d < today && t.status !== 'done';
        return `<span style="font-size:0.7rem;color:${isOverdue ? 'var(--red)' : 'var(--yellow)'}">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
      })() : '';
      const waitingBadge = t.waiting_on ? `<span style="font-size:0.7rem;color:#f97316">⏳${esc(t.waiting_on)}</span>` : '';

      const rescheduleRow = showReschedule ? `
        <div style="display:flex;gap:4px;margin-top:4px" onclick="event.stopPropagation()">
          <button class="btn-reschedule" onclick="rescheduleTask('${t.id}','${todayISO}')">Today</button>
          <button class="btn-reschedule" onclick="rescheduleTask('${t.id}','${tomorrowISO}')">Tmrw</button>
          <button class="btn-reschedule" onclick="rescheduleTask('${t.id}','${nextMonISO}')">Mon</button>
          <button class="btn-reschedule" onclick="pickRescheduleDate('${t.id}',this)">Pick…</button>
        </div>` : '';

      return `
        <div class="list-item" onclick="showTaskDetail('${t.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 12px">
          <input type="checkbox" ${t.status==='done'?'checked':''} onclick="event.stopPropagation();quickToggleTask('${t.id}','${t.status}')" style="cursor:pointer;flex-shrink:0">
          <div style="flex:1;min-width:0">
            <div class="list-item-title" style="${t.status==='done'?'text-decoration:line-through;color:var(--text-dim)':''}">${esc(t.title)}</div>
            <div class="list-item-meta">
              <span class="priority-badge priority-${t.priority}">${t.priority}</span>
              ${t.context ? `<span class="context-badge context-${t.context}">${t.context}</span>` : ''}
              ${dueBadge}${waitingBadge}${checkProgress}${commentCount}
            </div>
            ${rescheduleRow}
          </div>
          ${t.status !== 'done' && t.status !== 'in_progress' ? `<button class="btn-action" onclick="event.stopPropagation();updateTask('${t.id}','status','in_progress')" style="font-size:0.7rem;padding:3px 8px;flex-shrink:0">Start</button>` : ''}
          ${t.status === 'in_progress' ? `<button class="btn-action" onclick="event.stopPropagation();quickToggleTask('${t.id}','${t.status}')" style="font-size:0.7rem;padding:3px 8px;flex-shrink:0;background:var(--green)">Done</button>` : ''}
        </div>`;
    }

    main.innerHTML = tasksTabsHtml() + `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div style="font-size:1.1rem;font-weight:700">Focus Today</div>
          <div style="font-size:0.75rem;color:var(--text-dim)">${totalFocus} task${totalFocus !== 1 ? 's' : ''} need attention${recentlyDone.length ? ` · ${recentlyDone.length} completed today` : ''}</div>
        </div>
        <button class="btn-action btn-compact-sm" onclick="showNewTaskModal()">+ Task</button>
      </div>

      ${overdue.length ? `
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="font-size:0.8rem;font-weight:600;color:var(--red)">Overdue (${overdue.length})</div>
            <div style="display:flex;gap:4px">
              <button class="btn-reschedule" onclick="rescheduleAllOverdue('${todayISO}')">All → Today</button>
              <button class="btn-reschedule" onclick="rescheduleAllOverdue('${tomorrowISO}')">All → Tmrw</button>
            </div>
          </div>
          ${overdue.map(t => renderTodayCard(t, true, true)).join('')}
        </div>
      ` : ''}

      ${dueToday.length ? `
        <div style="margin-bottom:16px">
          <div style="font-size:0.8rem;font-weight:600;color:var(--yellow);margin-bottom:6px">Due Today (${dueToday.length})</div>
          ${dueToday.map(t => renderTodayCard(t, false, false)).join('')}
        </div>
      ` : ''}

      ${inProgress.length ? `
        <div style="margin-bottom:16px">
          <div style="font-size:0.8rem;font-weight:600;color:var(--blue);margin-bottom:6px">In Progress (${inProgress.length})</div>
          ${inProgress.map(t => renderTodayCard(t, true, false)).join('')}
        </div>
      ` : ''}

      ${waitingOn.length ? `
        <div onclick="tasksSubTab='waiting';loadTasks()" style="margin-bottom:16px;padding:10px 14px;background:rgba(249,115,22,0.08);border:1px solid rgba(249,115,22,0.2);border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:space-between">
          <div>
            <span style="font-size:0.82rem;font-weight:600;color:#f97316">⏳ Waiting On Others</span>
            <span style="font-size:0.75rem;color:var(--text-dim);margin-left:8px">${waitingOn.length} task${waitingOn.length !== 1 ? 's' : ''} across ${Object.keys(waitingByPerson).length} ${Object.keys(waitingByPerson).length === 1 ? 'person' : 'people'}</span>
          </div>
          <span style="font-size:0.75rem;color:var(--text-dim)">View →</span>
        </div>
      ` : ''}

      ${topBacklog.length ? `
        <div style="margin-bottom:16px">
          <div style="font-size:0.8rem;font-weight:600;color:var(--text-dim);margin-bottom:6px">Up Next (top ${topBacklog.length})</div>
          ${topBacklog.map(t => renderTodayCard(t, true, false)).join('')}
          ${topPriority.length > 5 ? `<div style="font-size:0.72rem;color:var(--text-dim);text-align:center;padding:6px">+${topPriority.length - 5} more in backlog</div>` : ''}
        </div>
      ` : ''}

      ${!totalFocus && !topBacklog.length ? '<div class="empty-state">All clear — no tasks need attention today</div>' : ''}

      ${recentlyDone.length ? `
        <div style="margin-top:8px">
          <div style="font-size:0.8rem;font-weight:600;color:var(--green);margin-bottom:6px">Completed Today (${recentlyDone.length})</div>
          ${recentlyDone.map(t => renderTodayCard(t, false, false)).join('')}
        </div>
      ` : ''}
    `;
  } catch (e) { main.innerHTML = tasksTabsHtml() + `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ── Waiting View ──
async function loadTasksWaiting() {
  const main = document.getElementById('main-content');
  try {
    const data = await api('/tasks?status=waiting_on&limit=200');
    const tasks = data.tasks || [];

    // Group by person
    const byPerson = {};
    for (const t of tasks) {
      const person = (t.waiting_on || 'Unknown').trim();
      (byPerson[person] = byPerson[person] || []).push(t);
    }
    const people = Object.keys(byPerson).sort();

    main.innerHTML = tasksTabsHtml() + `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div>
          <div style="font-size:1.1rem;font-weight:700">Waiting On Others</div>
          <div style="font-size:0.75rem;color:var(--text-dim)">${tasks.length} task${tasks.length !== 1 ? 's' : ''} across ${people.length} ${people.length === 1 ? 'person' : 'people'}</div>
        </div>
        <button class="btn-action btn-compact-sm" onclick="showNewTaskModal()">+ Task</button>
      </div>

      ${people.length ? people.map(person => {
        const personTasks = byPerson[person];
        const oldestWait = personTasks.reduce((oldest, t) => {
          const u = new Date(t.updated_at || t.created_at);
          return u < oldest ? u : oldest;
        }, new Date());
        const daysWaiting = Math.floor((Date.now() - oldestWait.getTime()) / 86400000);

        return `
          <div style="margin-bottom:20px">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(249,115,22,0.08);border:1px solid rgba(249,115,22,0.15);border-radius:8px 8px 0 0">
              <div>
                <span style="font-size:0.9rem;font-weight:700;color:#f97316">⏳ ${esc(person)}</span>
                <span style="font-size:0.75rem;color:var(--text-dim);margin-left:8px">${personTasks.length} task${personTasks.length !== 1 ? 's' : ''}</span>
                ${daysWaiting > 0 ? `<span style="font-size:0.7rem;color:${daysWaiting > 7 ? 'var(--red)' : daysWaiting > 3 ? 'var(--yellow)' : 'var(--text-dim)'};margin-left:6px">${daysWaiting}d waiting</span>` : ''}
              </div>
              <button class="btn-reschedule" onclick="event.stopPropagation();moveAllFromPerson('${esc(person)}','todo')" title="Move all back to To Do">Unblock All</button>
            </div>
            <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;overflow:hidden">
              ${personTasks.map(t => {
                const dueBadge = t.due_date ? (() => {
                  const d = new Date(t.due_date); const now = new Date(); now.setHours(0,0,0,0);
                  const isOverdue = d < now;
                  return `<span style="font-size:0.7rem;color:${isOverdue ? 'var(--red)' : 'var(--text-dim)'}">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
                })() : '';
                const cl = t.checklist || [];
                const checkBadge = cl.length ? `<span style="font-size:0.7rem;color:var(--text-dim)">${cl.filter(x=>x.done).length}/${cl.length}</span>` : '';
                const cmtBadge = t.comment_count ? `<span style="font-size:0.7rem;color:var(--text-dim)">💬${t.comment_count}</span>` : '';
                const waitSince = new Date(t.updated_at || t.created_at);
                const waitDays = Math.floor((Date.now() - waitSince.getTime()) / 86400000);

                return `
                  <div class="list-item" onclick="showTaskDetail('${t.id}')" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">
                    <div style="flex:1;min-width:0">
                      <div class="list-item-title">${esc(t.title)}</div>
                      <div class="list-item-meta">
                        <span class="priority-badge priority-${t.priority}">${t.priority}</span>
                        ${t.context ? `<span class="context-badge context-${t.context}">${t.context}</span>` : ''}
                        ${dueBadge}${checkBadge}${cmtBadge}
                        ${waitDays > 0 ? `<span style="font-size:0.68rem;color:${waitDays > 7 ? 'var(--red)' : waitDays > 3 ? 'var(--yellow)' : 'var(--text-dim)'}">${waitDays}d ago</span>` : '<span style="font-size:0.68rem;color:var(--text-dim)">today</span>'}
                      </div>
                    </div>
                    <button class="btn-reschedule" onclick="event.stopPropagation();updateTask('${t.id}','status','todo')" style="padding:3px 8px">Unblock</button>
                  </div>`;
              }).join('')}
            </div>
          </div>`;
      }).join('') : '<div class="empty-state">No tasks waiting on others — you\'re all clear</div>'}
    `;
  } catch (e) { main.innerHTML = tasksTabsHtml() + `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function moveAllFromPerson(person, newStatus) {
  try {
    const data = await api('/tasks?status=waiting_on&limit=200');
    const tasks = (data.tasks || []).filter(t => (t.waiting_on || '').trim() === person);
    if (!tasks.length) return;
    await Promise.all(tasks.map(t =>
      api(`/tasks/${t.id}`, { method: 'PUT', body: JSON.stringify({ status: newStatus, waiting_on: null }) })
    ));
    showToast(`${tasks.length} task${tasks.length > 1 ? 's' : ''} from ${person} unblocked`, 'success', 2500);
    loadTasks();
  } catch {}
}

// ── List View ──
let taskListFilter = '';
let taskPriorityFilter = '';
let taskContextFilter = '';
let taskSortBy = 'priority';
async function loadTasksList() {
  const main = document.getElementById('main-content');
  try {
    const params = new URLSearchParams({ limit: '200' });
    if (taskListFilter) params.set('status', taskListFilter);
    if (taskPriorityFilter) params.set('priority', taskPriorityFilter);
    if (taskContextFilter) params.set('context', taskContextFilter);
    const data = await api('/tasks?' + params.toString());

    const statusLabels = { todo: 'To Do', in_progress: 'In Progress', waiting_on: 'Waiting On', review: 'Review', done: 'Done' };
    const statusColors = { todo: 'var(--text-dim)', in_progress: 'var(--blue)', waiting_on: '#f97316', review: 'var(--yellow)', done: 'var(--green)' };
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
          <div class="filter-row">
            <span style="font-size:0.7rem;color:var(--text-dim)">Sort:</span>
            <select onchange="taskSortBy=this.value;loadTasksList()" style="font-size:0.7rem;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px">
              <option value="priority" ${taskSortBy==='priority'?'selected':''}>Priority</option>
              <option value="due_date" ${taskSortBy==='due_date'?'selected':''}>Due Date</option>
              <option value="created_at" ${taskSortBy==='created_at'?'selected':''}>Created</option>
              <option value="updated_at" ${taskSortBy==='updated_at'?'selected':''}>Updated</option>
              <option value="status" ${taskSortBy==='status'?'selected':''}>Status</option>
            </select>
          </div>
        </div>
        <button class="btn-action btn-compact-sm" onclick="showNewTaskModal()" style="align-self:start">+ Task</button>
      </div>
      <div id="task-list">
        ${(() => {
          const pRank = { urgent: 0, high: 1, medium: 2, low: 3 };
          const sRank = { in_progress: 0, todo: 1, review: 2, done: 3 };
          if (taskSortBy === 'due_date') data.tasks.sort((a,b) => {
            const ad = a.due_date ? new Date(a.due_date) : new Date('9999-12-31');
            const bd = b.due_date ? new Date(b.due_date) : new Date('9999-12-31');
            return ad - bd || (pRank[a.priority]??4) - (pRank[b.priority]??4);
          });
          else if (taskSortBy === 'created_at') data.tasks.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
          else if (taskSortBy === 'updated_at') data.tasks.sort((a,b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
          else if (taskSortBy === 'status') data.tasks.sort((a,b) => (sRank[a.status]??4) - (sRank[b.status]??4) || (pRank[a.priority]??4) - (pRank[b.priority]??4));
          // default: priority — already sorted by server
          return '';
        })()}
        ${data.tasks.length ? data.tasks.map(t => {
          const dueBadge = t.due_date ? (() => {
            const d = new Date(t.due_date); const now = new Date(); now.setHours(0,0,0,0);
            const isOverdue = d < now && t.status !== 'done';
            const isToday = d.toDateString() === now.toDateString();
            const label = isToday ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `<span style="font-size:0.7rem;color:${isOverdue ? 'var(--red)' : isToday ? 'var(--yellow)' : 'var(--text-dim)'}">${label}</span>`;
          })() : '';
          const cl = t.checklist || [];
          const checkProgress = cl.length ? `<span style="font-size:0.7rem;color:var(--text-dim)">${cl.filter(i=>i.done).length}/${cl.length}</span>` : '';
          const cmtCount = t.comment_count ? `<span style="font-size:0.7rem;color:var(--text-dim)">💬${t.comment_count}</span>` : '';
          const waitBadge = t.waiting_on ? `<span style="font-size:0.7rem;color:#f97316">⏳${esc(t.waiting_on)}</span>` : '';
          return `
          <div class="list-item" onclick="showTaskDetail('${t.id}')" style="display:flex;align-items:center;gap:10px">
            <input type="checkbox" ${t.status==='done'?'checked':''} onclick="event.stopPropagation();quickToggleTask('${t.id}','${t.status}')" style="cursor:pointer;flex-shrink:0">
            <div style="flex:1;min-width:0">
              <div class="list-item-title" style="${t.status==='done'?'text-decoration:line-through;color:var(--text-dim)':''}">${esc(t.title)}</div>
              <div class="list-item-meta">
                <span class="priority-badge priority-${t.priority}">${t.priority}</span>
                ${t.context ? `<span class="context-badge context-${t.context}">${t.context}</span>` : ''}
                ${t.ai_agent ? `<span class="k-source-badge source-${t.ai_agent}">${t.ai_agent}</span>` : ''}
                <span style="color:${statusColors[t.status]}">${statusLabels[t.status]}</span>
                ${dueBadge}${waitBadge}${checkProgress}${cmtCount}
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

async function rescheduleTask(id, newDate) {
  try {
    await api(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ due_date: newDate }) });
    showToast(`Rescheduled to ${new Date(newDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`, 'success', 2000);
    loadTasks();
  } catch {}
}

function pickRescheduleDate(id, btn) {
  // Insert a date input next to the button
  const existing = btn.parentElement.querySelector('.reschedule-picker');
  if (existing) { existing.remove(); return; }
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'reschedule-picker';
  input.style.cssText = 'font-size:0.7rem;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 4px;width:auto';
  input.onchange = () => { if (input.value) rescheduleTask(id, input.value); };
  btn.parentElement.appendChild(input);
  input.focus();
  input.showPicker?.();
}

async function rescheduleAllOverdue(newDate) {
  try {
    const data = await api('/tasks?limit=200');
    const tasks = data.tasks || [];
    const today = new Date(); today.setHours(0,0,0,0);
    const overdue = tasks.filter(t => {
      if (t.status === 'done') return false;
      const due = t.due_date ? new Date(t.due_date) : null;
      if (due) due.setHours(0,0,0,0);
      return due && due < today;
    });
    if (!overdue.length) return;
    await Promise.all(overdue.map(t =>
      api(`/tasks/${t.id}`, { method: 'PUT', body: JSON.stringify({ due_date: newDate }) })
    ));
    const label = new Date(newDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    showToast(`${overdue.length} task${overdue.length > 1 ? 's' : ''} rescheduled to ${label}`, 'success', 2500);
    loadTasks();
  } catch {}
}

// ── Kanban View ──
async function loadTasksKanban() {
  const main = document.getElementById('main-content');
  try {
    const data = await api('/tasks/kanban');
    const cols = ['todo', 'in_progress', 'waiting_on', 'review', 'done'];
    const labels = { todo: 'To Do', in_progress: 'In Progress', waiting_on: 'Waiting On', review: 'Review', done: 'Done' };
    const colors = { todo: 'var(--text-dim)', in_progress: 'var(--blue)', waiting_on: '#f97316', review: 'var(--yellow)', done: 'var(--green)' };

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
                <div class="kanban-card-meta">
                  <span class="priority-badge priority-${t.priority}">${t.priority}</span>
                  ${t.context ? `<span class="context-badge context-${t.context}">${t.context}</span>` : ''}
                  ${t.ai_agent ? `<span class="k-source-badge source-${t.ai_agent}">${t.ai_agent}</span>` : ''}
                  ${t.due_date ? `<span style="font-size:0.65rem;color:var(--text-dim)">${new Date(t.due_date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>` : ''}
                  ${t.waiting_on ? `<span style="font-size:0.65rem;color:#f97316">⏳${esc(t.waiting_on)}</span>` : ''}
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
  openModal('New Task', `
    <form onsubmit="createTask(event)">
      <div class="form-group"><label>Title</label><input type="text" id="new-task-title" required></div>
      <div class="form-group"><label>Description</label><textarea id="new-task-desc" rows="2"></textarea></div>
      <div class="form-group"><label>Due Date</label><input type="date" id="new-task-due" value="${dateStr}"></div>
      <div class="form-group"><label>Priority</label>
        <select id="new-task-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
      </div>
      <div class="form-group"><label>Context</label>
        <select id="new-task-context"><option value="">Auto-detect</option><option value="work">Work</option><option value="personal">Personal</option></select>
      </div>
      <button type="submit" class="btn-submit">Create Task</button>
    </form>
  `);
}

// ── Shared Task Detail / Edit ──
async function showTaskDetail(id) {
  try {
    const task = await api(`/tasks/${id}`);
    const history = task.history || [];
    const comments = task.comments || [];
    const checklist = task.checklist || [];

    const checklistHtml = checklist.map((item, idx) => `
      <div style="display:flex;align-items:center;gap:6px;padding:3px 0">
        <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleChecklistItem('${id}', ${idx}, this.checked)" style="margin:0">
        <span style="font-size:0.82rem;${item.done ? 'text-decoration:line-through;color:var(--text-dim)' : ''}">${esc(item.text)}</span>
        <button onclick="removeChecklistItem('${id}', ${idx})" style="margin-left:auto;background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:0.7rem">x</button>
      </div>
    `).join('');

    const checklistProgress = checklist.length ? ` (${checklist.filter(i=>i.done).length}/${checklist.length})` : '';

    const commentsHtml = comments.map(c => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:0.8rem">
        <div style="color:var(--text-dim);font-size:0.7rem;margin-bottom:2px">${c.author || 'manual'} &middot; ${new Date(c.created_at).toLocaleString()}</div>
        <div style="white-space:pre-wrap">${esc(c.content)}</div>
        <button onclick="deleteTaskComment('${id}','${c.id}')" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:0.65rem;margin-top:2px">delete</button>
      </div>
    `).join('');

    const historyHtml = history.map(h => `
      <div style="font-size:0.72rem;color:var(--text-dim);padding:2px 0">
        ${new Date(h.created_at).toLocaleString()} — ${esc(h.details)}
      </div>
    `).join('');

    openModal('Task Detail', `
      <div class="form-group"><label>Title</label>
        <input type="text" value="${esc(task.title)}" onblur="updateTask('${id}', 'title', this.value)" style="width:100%;box-sizing:border-box;font-size:0.9rem;font-weight:600">
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <div style="flex:1" class="form-group"><label>Status</label>
          <select onchange="updateTask('${id}', 'status', this.value)">
            ${['todo','in_progress','waiting_on','review','done'].map(s => `<option value="${s}" ${task.status===s?'selected':''}>${s === 'waiting_on' ? 'Waiting On' : s.replace('_',' ')}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1" class="form-group"><label>Priority</label>
          <select onchange="updateTask('${id}', 'priority', this.value)">
            ${['low','medium','high','urgent'].map(p => `<option value="${p}" ${task.priority===p?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <div style="flex:1" class="form-group"><label>Due Date</label>
          <input type="date" value="${task.due_date ? task.due_date.slice(0,10) : ''}" onchange="updateTask('${id}', 'due_date', this.value||null)">
          <div style="display:flex;gap:4px;margin-top:4px">
            <button class="btn-reschedule" onclick="rescheduleTask('${id}',localDateStr())">Today</button>
            <button class="btn-reschedule" onclick="(()=>{const d=new Date();d.setDate(d.getDate()+1);rescheduleTask('${id}',localDateStr(d))})()">Tmrw</button>
            <button class="btn-reschedule" onclick="(()=>{const d=new Date();d.setDate(d.getDate()+((8-d.getDay())%7||7));rescheduleTask('${id}',localDateStr(d))})()">Mon</button>
            <button class="btn-reschedule" onclick="(()=>{const d=new Date();d.setDate(d.getDate()+7);rescheduleTask('${id}',localDateStr(d))})()">+1wk</button>
          </div>
        </div>
        <div style="flex:1" class="form-group"><label>Context</label>
          <select onchange="updateTask('${id}', 'context', this.value||null)">
            <option value="" ${!task.context?'selected':''}>None</option>
            <option value="work" ${task.context==='work'?'selected':''}>Work</option>
            <option value="personal" ${task.context==='personal'?'selected':''}>Personal</option>
          </select>
        </div>
      </div>
      ${task.status === 'waiting_on' || task.waiting_on ? `
        <div class="form-group" style="margin-bottom:12px"><label>Waiting On (person)</label>
          <input type="text" value="${esc(task.waiting_on || '')}" placeholder="e.g. Adin, Sarah..." onblur="updateTask('${id}', 'waiting_on', this.value||null)" style="width:100%;box-sizing:border-box;font-size:0.82rem">
        </div>
      ` : ''}
      ${task.completed_at ? `<div style="font-size:0.75rem;color:var(--accent);margin-bottom:8px">Completed: ${new Date(task.completed_at).toLocaleString()}</div>` : ''}
      ${task.source_id ? '<div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:8px">Created from Outlook email</div>' : ''}
      <div class="form-group"><label>Description</label>
        <textarea rows="3" onblur="updateTask('${id}', 'description', this.value)" style="width:100%;box-sizing:border-box;font-size:0.82rem">${esc(task.description || '')}</textarea>
      </div>
      <div class="form-group"><label>Notes</label>
        <textarea rows="2" onblur="updateTask('${id}', 'notes', this.value)" placeholder="Quick notes..." style="width:100%;box-sizing:border-box;font-size:0.82rem">${esc(task.notes || '')}</textarea>
      </div>
      <div class="form-group"><label>Next Steps</label>
        <textarea rows="2" onblur="updateTask('${id}', 'next_steps', this.value)" style="width:100%;box-sizing:border-box;font-size:0.82rem">${esc(task.next_steps || '')}</textarea>
      </div>

      <div class="form-group"><label>Checklist${checklistProgress}</label>
        ${checklistHtml}
        <div style="display:flex;gap:6px;margin-top:6px">
          <input type="text" id="new-checklist-item-${id}" placeholder="Add item..." style="flex:1;font-size:0.8rem;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)" onkeydown="if(event.key==='Enter'){addChecklistItem('${id}')}">
          <button class="btn-action" onclick="addChecklistItem('${id}')" style="font-size:0.75rem;padding:4px 10px">Add</button>
        </div>
      </div>

      <div class="form-group" style="margin-top:16px"><label>Comments (${comments.length})</label>
        ${commentsHtml || '<div style="font-size:0.75rem;color:var(--text-dim)">No comments yet</div>'}
        <div style="display:flex;gap:6px;margin-top:8px">
          <input type="text" id="new-comment-${id}" placeholder="Add comment..." style="flex:1;font-size:0.8rem;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)" onkeydown="if(event.key==='Enter'){addTaskComment('${id}')}">
          <button class="btn-action" onclick="addTaskComment('${id}')" style="font-size:0.75rem;padding:4px 10px">Post</button>
        </div>
      </div>

      ${history.length ? `
        <details style="margin-top:16px">
          <summary style="font-size:0.78rem;font-weight:600;cursor:pointer;color:var(--text-dim)">History (${history.length})</summary>
          <div style="margin-top:6px">${historyHtml}</div>
        </details>
      ` : ''}

      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn-action btn-action-danger" onclick="deleteTask('${id}')" style="flex:1">Delete</button>
      </div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function updateTask(id, field, value) {
  try {
    const body = { [field]: value };
    // When moving to "waiting_on", prompt for who
    if (field === 'status' && value === 'waiting_on') {
      const person = prompt('Who are you waiting on?');
      if (!person) return; // cancelled
      body.waiting_on = person.trim();
    }
    const resp = await api(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    if (field === 'status') showToast(`Moved to ${value === 'waiting_on' ? 'Waiting On' : value.replace('_',' ')}`, 'success', 2000);
    // Refresh task detail if open
    if (field === 'status' || field === 'waiting_on') {
      const modal = document.querySelector('.modal-overlay');
      if (modal) showTaskDetail(id);
      else loadTasks();
    } else {
      loadTasks();
    }
  } catch (err) {
    console.error('[updateTask] error:', err);
    showToast('Failed to update task: ' + (err.message || 'unknown error'), 'error', 3000);
  }
}

async function addTaskComment(taskId) {
  const input = document.getElementById(`new-comment-${taskId}`);
  if (!input || !input.value.trim()) return;
  try {
    await api(`/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ content: input.value.trim() }) });
    showTaskDetail(taskId);
  } catch (e) { showToast(e.message); }
}

async function deleteTaskComment(taskId, commentId) {
  try {
    await api(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' });
    showTaskDetail(taskId);
  } catch (e) { showToast(e.message); }
}

async function addChecklistItem(taskId) {
  const input = document.getElementById(`new-checklist-item-${taskId}`);
  if (!input || !input.value.trim()) return;
  try {
    const task = await api(`/tasks/${taskId}`);
    const checklist = task.checklist || [];
    checklist.push({ id: Date.now().toString(36), text: input.value.trim(), done: false });
    await api(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ checklist }) });
    showTaskDetail(taskId);
  } catch (e) { showToast(e.message); }
}

async function toggleChecklistItem(taskId, idx, done) {
  try {
    const task = await api(`/tasks/${taskId}`);
    const checklist = task.checklist || [];
    if (checklist[idx]) checklist[idx].done = done;
    await api(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ checklist }) });
  } catch (e) { showToast(e.message); }
}

async function removeChecklistItem(taskId, idx) {
  try {
    const task = await api(`/tasks/${taskId}`);
    const checklist = task.checklist || [];
    checklist.splice(idx, 1);
    await api(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ checklist }) });
    showTaskDetail(taskId);
  } catch (e) { showToast(e.message); }
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

function showNewTaskModal() {
  openModal('New Task', `
    <form onsubmit="createTask(event)">
      <div class="form-group"><label>Title</label><input type="text" id="new-task-title" required></div>
      <div class="form-group"><label>Description</label><textarea id="new-task-desc" rows="3"></textarea></div>
      <div class="form-group"><label>Notes</label><textarea id="new-task-notes" rows="2" placeholder="Quick notes..."></textarea></div>
      <div style="display:flex;gap:8px">
        <div style="flex:1" class="form-group"><label>Due Date</label><input type="date" id="new-task-due"></div>
        <div style="flex:1" class="form-group"><label>Priority</label>
          <select id="new-task-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
        </div>
      </div>
      <div class="form-group"><label>Context</label>
        <select id="new-task-context"><option value="">Auto-detect</option><option value="work">Work</option><option value="personal">Personal</option></select>
      </div>
      <div style="flex:1" class="form-group"><label>Status</label>
        <select id="new-task-status" onchange="document.getElementById('new-task-waiting-on-row').style.display=this.value==='waiting_on'?'block':'none'">
          <option value="todo">To Do</option><option value="in_progress">In Progress</option><option value="waiting_on">Waiting On</option>
        </select>
      </div>
      </div>
      <div id="new-task-waiting-on-row" class="form-group" style="display:none">
        <label>Waiting On (person)</label>
        <input type="text" id="new-task-waiting-on" placeholder="e.g. Adin, Sarah...">
      </div>
      <button type="submit" class="btn-submit">Create Task</button>
    </form>
  `);
}

async function createTask(e) {
  e.preventDefault();
  try {
    const dueEl = document.getElementById('new-task-due');
    const statusEl = document.getElementById('new-task-status');
    const waitingOnEl = document.getElementById('new-task-waiting-on');
    await api('/tasks', { method: 'POST', body: JSON.stringify({
      title: document.getElementById('new-task-title').value,
      description: document.getElementById('new-task-desc').value,
      notes: document.getElementById('new-task-notes')?.value || null,
      priority: document.getElementById('new-task-priority').value,
      due_date: dueEl ? dueEl.value || null : null,
      context: document.getElementById('new-task-context').value || null,
      status: statusEl ? statusEl.value : 'todo',
      waiting_on: waitingOnEl ? waitingOnEl.value || null : null,
    }) });
    closeModal();
    if (currentTab === 'tasks') loadTasks();
  } catch (err) { showToast(err.message); }
}

// ─── Brain (Knowledge) ────────────────────────────────────────
let brainSubTab = 'all';
function brainTabsHtml() {
  return `<div class="brain-tabs">
    <button class="brain-tab${brainSubTab==='all'?' active':''}" onclick="brainSubTab='all';loadBrain()">All</button>
    <button class="brain-tab${brainSubTab==='knowledge'?' active':''}" onclick="brainSubTab='knowledge';loadBrain()">Knowledge</button>
    <button class="brain-tab${brainSubTab==='conversations'?' active':''}" onclick="brainSubTab='conversations';loadBrain()">Conversations</button>
    <button class="brain-tab${brainSubTab==='transcripts'?' active':''}" onclick="brainSubTab='transcripts';loadBrain()">Transcripts</button>
    <button class="brain-tab${brainSubTab==='guide'?' active':''}" onclick="brainSubTab='guide';loadBrain()">Guide</button>
  </div>`;
}

async function loadBrain(searchQuery) {
  const main = document.getElementById('main-content');
  main.innerHTML = brainTabsHtml() + '<div class="loading">Loading...</div>';
  if (brainSubTab === 'all') return loadBrainAll(searchQuery);
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
    const [kData, cData, tData] = await Promise.all([
      api('/knowledge' + qs),
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
      ${sections.length ? sections.join('') : `<div class="empty-state">${searchQuery ? 'No results found' : 'Your brain is empty. Start adding knowledge or import conversations.'}</div>`}
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
          <span>Just use it. Tasks and knowledge push automatically.</span>
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
          <span>Wear it. Conversations and tasks sync on their own.</span>
        </div>
      </div>
      <div class="guide-callout">Best habit: when a conversation is useful, ask your AI to outline it, then paste into Custom GPT. Takes 30 seconds. The intake system classifies it into knowledge or tasks automatically.</div>
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
          <span>Something you need to do</span><span>Task</span><span>Create manually or AI extracts</span>
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
    if (r.transcripts?.length) html += renderSearchGroup('Transcripts', r.transcripts, i => `<div class="search-result-item"><div class="search-result-title">${highlightText(i.title,q)}</div><div class="search-result-preview">${searchSnippet(i.summary||'',q)}</div></div>`);
    if (r.tasks?.length) html += renderSearchGroup('Tasks', r.tasks, i => `<div class="search-result-item"><div class="search-result-title">${highlightText(i.title,q)}</div><div class="search-result-meta"><span>${i.status||''}</span><span>${i.priority||''}</span></div></div>`);
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

// ─── Fitness (unified tab — 4 tabs: Today/Log/History/Coaching) ────
let fitnessSubTab = 'today';

function loadFitness() {
  const main = document.getElementById('main-content');
  const tabs = [
    { key: 'today', label: 'Today', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/></svg>' },
    { key: 'log', label: 'Log', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>' },
    { key: 'nutrition', label: 'Macros', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/></svg>' },
    { key: 'history', label: 'History', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>' },
    { key: 'plans', label: 'Plans', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>' },
    { key: 'coaching', label: 'Coaching', icon: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>' },
  ];
  main.innerHTML = `
    <div class="fitness-tabs">
      ${tabs.map(t => `<button class="fitness-tab ${fitnessSubTab === t.key ? 'active' : ''}" onclick="fitnessSubTab='${t.key}';loadFitness()">${t.icon}<span>${t.label}</span></button>`).join('')}
    </div>
    <div id="fitness-content"></div>
  `;
  if (fitnessSubTab === 'today') loadFitnessToday();
  else if (fitnessSubTab === 'log') loadFitnessLog();
  else if (fitnessSubTab === 'nutrition') loadNutrition();
  else if (fitnessSubTab === 'plans') loadUnifiedPlans();
  else if (fitnessSubTab === 'history') loadFitnessHistory();
  else if (fitnessSubTab === 'coaching') loadFitnessCoaching();
}

// ─── Exercise Import (Settings menu) ─────────────────────────
let _importExercises = [];

async function handleExerciseImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('exercise-import-btn');
  const progress = document.getElementById('exercise-import-progress');
  const result = document.getElementById('exercise-import-result');

  btn.disabled = true;
  btn.textContent = 'Reading file...';
  result.style.display = 'none';

  let exercises;
  try {
    const text = await file.text();
    const isCSV = file.name.toLowerCase().endsWith('.csv') || (!text.trim().startsWith('[') && !text.trim().startsWith('{'));
    if (isCSV) {
      exercises = parseCSVToExercises(text);
    } else {
      let parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        if (parsed.exercises && Array.isArray(parsed.exercises)) parsed = parsed.exercises;
        else throw new Error('Expected a JSON array or {exercises:[...]}');
      }
      exercises = parsed;
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Choose File';
    result.style.display = 'block';
    result.style.color = 'var(--red)';
    result.textContent = 'Error reading file: ' + err.message;
    input.value = '';
    return;
  }

  const total = exercises.length;
  const BATCH = 100;
  let imported = 0, errors = 0;

  progress.style.display = 'block';
  btn.textContent = 'Importing...';
  const bar = document.getElementById('exercise-import-bar');
  const status = document.getElementById('exercise-import-status');
  const count = document.getElementById('exercise-import-count');

  for (let i = 0; i < total; i += BATCH) {
    const batch = exercises.slice(i, i + BATCH);
    try {
      const res = await api('/exercises/bulk', {
        method: 'POST',
        body: JSON.stringify({ exercises: batch })
      });
      imported += res.imported || 0;
      errors += res.errors || 0;
      if (res.errors > 0) console.warn('Bulk import batch errors:', res.results?.filter(r => r.error));
    } catch (err) {
      console.error('Bulk import batch failed:', err.message, 'First item:', JSON.stringify(batch[0]).slice(0, 200));
      errors += batch.length;
    }
    const done = Math.min(i + BATCH, total);
    const pct = Math.round((done / total) * 100);
    bar.style.width = pct + '%';
    status.textContent = 'Importing... ' + done + ' of ' + total;
    count.textContent = pct + '%';
  }

  progress.style.display = 'none';
  btn.disabled = false;
  btn.textContent = 'Choose File';
  input.value = '';

  result.style.display = 'block';
  result.style.color = errors > 0 ? 'var(--yellow)' : 'var(--green)';
  result.textContent = 'Done: ' + imported + ' imported/updated, ' + errors + ' errors (' + total + ' total). Check browser console (F12) for error details.';

  if (imported > 0) showToast('Imported ' + imported + ' exercises', 'success');
  if (errors > 0 && imported === 0) showToast('Import failed. Open browser console (F12) for details.', 'error');
}

function parseCSVToExercises(csvText) {
  // Strip BOM
  let text = csvText.replace(/^\uFEFF/, '');
  // Parse all rows handling multi-line quoted fields
  const rows = parseCSVRows(text);
  if (rows.length < 2) throw new Error('CSV must have a header row and at least one data row');
  const headers = rows[0].map(h => h.trim());
  const exercises = [];
  for (let i = 1; i < rows.length; i++) {
    const vals = rows[i];
    if (vals.length < 2) continue;
    // Skip rows where first cell (Name) is empty
    if (!vals[0] || !vals[0].trim()) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (vals[j] || '').trim();
    }
    exercises.push(row);
  }
  return exercises;
}

function parseCSVRows(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field); field = '';
      } else if (ch === '\r') {
        // skip carriage return
      } else if (ch === '\n') {
        current.push(field); field = '';
        rows.push(current); current = [];
      } else {
        field += ch;
      }
    }
  }
  // Last field/row
  if (field || current.length) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}

async function purgeExercises() {
  if (!confirm('Purge ALL exercises from the catalog? This cannot be undone.')) return;
  const btn = document.getElementById('exercise-purge-btn');
  const result = document.getElementById('exercise-import-result');
  btn.disabled = true;
  btn.textContent = 'Purging...';
  try {
    const data = await api('/exercises/purge/all', { method: 'DELETE' });
    result.style.display = 'block';
    result.style.color = 'var(--green)';
    result.textContent = 'Purged ' + data.count + ' exercises';
    showToast('Purged ' + data.count + ' exercises', 'success');
  } catch (err) {
    result.style.display = 'block';
    result.style.color = 'var(--red)';
    result.textContent = 'Purge failed: ' + err.message;
  }
  btn.disabled = false;
  btn.textContent = 'Purge All';
}

// ─── Gym Profiles (Settings) ─────────────────────────────────
async function loadGymProfiles() {
  const list = document.getElementById('gym-profiles-list');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">Loading...</div>';
  try {
    const data = await api('/gym-profiles');
    const profiles = data.gym_profiles || [];
    if (!profiles.length) {
      list.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">No gym profiles yet. Add one below.</div>';
      return;
    }
    list.innerHTML = profiles.map(p => `
      <div class="sm-card" style="margin-bottom:6px;padding:8px 10px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <strong>${esc(p.name)}</strong>${p.is_primary ? ' <span style="color:var(--green);font-size:0.7rem">PRIMARY</span>' : ''}
            <div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">${(p.equipment || []).length} equipment items</div>
          </div>
          <div style="display:flex;gap:4px">
            ${!p.is_primary ? `<button class="btn-action btn-action-secondary" style="font-size:0.65rem;padding:2px 6px" onclick="setGymPrimary('${p.id}')">Set Primary</button>` : ''}
            <button class="btn-action btn-action-secondary" style="font-size:0.65rem;padding:2px 6px" onclick="editGymProfile('${p.id}')">Edit</button>
            <button class="btn-action btn-action-danger" style="font-size:0.65rem;padding:2px 6px" onclick="deleteGymProfile('${p.id}')">Del</button>
          </div>
        </div>
        ${(p.equipment || []).length > 0 ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px;line-height:1.4">${(p.equipment || []).map(e => esc(e)).join(', ')}</div>` : ''}
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:var(--red);font-size:0.8rem">${err.message}</div>`;
  }
}

async function addGymProfile() {
  const nameEl = document.getElementById('gym-profile-name');
  const equipEl = document.getElementById('gym-profile-equipment');
  const result = document.getElementById('gym-profile-result');
  const name = (nameEl.value || '').trim();
  const equipStr = (equipEl.value || '').trim();
  if (!name) { result.textContent = 'Name is required'; result.style.display = 'block'; result.style.color = 'var(--red)'; return; }

  const equipment = equipStr ? equipStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  try {
    await api('/gym-profiles', { method: 'POST', body: JSON.stringify({ name, equipment, is_primary: true }) });
    nameEl.value = ''; equipEl.value = '';
    result.style.display = 'block'; result.style.color = 'var(--green)'; result.textContent = 'Gym profile created';
    showToast('Gym profile created', 'success');
    loadGymProfiles();
  } catch (err) {
    result.style.display = 'block'; result.style.color = 'var(--red)'; result.textContent = err.message;
  }
}

async function setGymPrimary(id) {
  try {
    await api('/gym-profiles/' + id, { method: 'PUT', body: JSON.stringify({ is_primary: true }) });
    loadGymProfiles();
    showToast('Primary gym updated', 'success');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

async function editGymProfile(id) {
  try {
    const profile = await api('/gym-profiles/' + id);
    const name = prompt('Gym name:', profile.name);
    if (name === null) return;
    const equipStr = prompt('Equipment (comma-separated):', (profile.equipment || []).join(', '));
    if (equipStr === null) return;
    const equipment = equipStr.split(',').map(s => s.trim()).filter(Boolean);
    await api('/gym-profiles/' + id, { method: 'PUT', body: JSON.stringify({ name, equipment }) });
    loadGymProfiles();
    showToast('Gym profile updated', 'success');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

async function deleteGymProfile(id) {
  if (!confirm('Delete this gym profile?')) return;
  try {
    await api('/gym-profiles/' + id, { method: 'DELETE' });
    loadGymProfiles();
    showToast('Gym profile deleted', 'success');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

// ─── Fitness > Today ──────────────────────────────────────────
let fitnessTodayDate = localDateStr();
let fitnessTodayWeekOffset = 0;

function shiftFitnessToday(delta) {
  const d = new Date(fitnessTodayDate + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  fitnessTodayDate = localDateStr(d);
  loadFitnessToday();
}

async function loadFitnessToday() {
  const el = document.getElementById('fitness-content');
  if (!el) return;
  el.innerHTML = skeletonCards(3);

  try {
    const [dayData, recoveryData, trendData] = await Promise.all([
      api(`/training/day/${fitnessTodayDate}`),
      api(`/recovery/score?date=${fitnessTodayDate}`),
      api(`/recovery/trend?date=${fitnessTodayDate}&days=7`),
    ]);

    const plan = dayData.daily_plan;
    const ctx = dayData.nutrition_context || {};
    const workouts = dayData.workouts || [];
    const meals = dayData.meals || [];
    const injuries = dayData.active_injuries || [];
    const bodyMetrics = dayData.body_metrics || [];

    // Week strip
    const today = localDateStr();
    const sel = new Date(fitnessTodayDate + 'T12:00:00');
    const dayOfWeek = sel.getDay();
    const monday = new Date(sel);
    monday.setDate(monday.getDate() - ((dayOfWeek + 6) % 7));
    const weekDays = [];
    const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      const ds = d.toLocaleDateString('en-CA');
      weekDays.push({ date: ds, label: dayLabels[i], isToday: ds === today, isSelected: ds === fitnessTodayDate });
    }

    const prevWeekDate = new Date(monday);
    prevWeekDate.setDate(prevWeekDate.getDate() - 7);
    const prevWeekStr = prevWeekDate.toLocaleDateString('en-CA');
    const nextWeekDate = new Date(monday);
    nextWeekDate.setDate(nextWeekDate.getDate() + 7);
    const nextWeekStr = nextWeekDate.toLocaleDateString('en-CA');

    const weekDayBtns = weekDays.map(d => {
      const dayNum = new Date(d.date + 'T12:00:00').getDate();
      return '<button class="week-day ' + (d.isSelected ? 'selected' : '') + ' ' + (d.isToday ? 'today' : '') + '" onclick="fitnessTodayDate=\'' + d.date + '\';loadFitnessToday()">' + d.label + '<br><span style="font-size:0.65rem">' + dayNum + '</span></button>';
    }).join('');

    const weekStrip = '<div class="week-strip">'
      + '<button class="week-nav" onclick="fitnessTodayDate=\'' + prevWeekStr + '\';loadFitnessToday()">‹</button>'
      + weekDayBtns
      + '<button class="week-nav" onclick="fitnessTodayDate=\'' + nextWeekStr + '\';loadFitnessToday()">›</button>'
      + '</div>';

    const dateLabel = sel.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const isToday = fitnessTodayDate === today;

    // Plan section (with structured exercises support)
    let planHtml = '';
    if (plan) {
      const statusColors = { planned: '#3b82f6', completed: '#10b981', partial: '#f59e0b', missed: '#ef4444', rest: '#8b5cf6', amended: '#6366f1' };
      const statusColor = statusColors[plan.status] || '#6b7280';
      const statusIcons = { planned: '○', completed: '✓', partial: '~', missed: '✗', rest: '◇', amended: '◆' };
      const statusIcon = statusIcons[plan.status] || '○';

      // Build exercise list from planned_exercises or actual_exercises
      const showActual = plan.actual_exercises && plan.actual_exercises.length > 0;
      const exercises = showActual ? plan.actual_exercises : (plan.planned_exercises || []);
      let exerciseHtml = '';
      if (exercises.length > 0) {
        let currentGroup = '';
        exerciseHtml = exercises.map(ex => {
          let groupHeader = '';
          const group = (ex.group || 'main').toLowerCase();
          if (group !== currentGroup) {
            currentGroup = group;
            const groupLabels = { warmup: 'WARMUP', main: 'MAIN', superset: 'SUPERSET', circuit: 'CIRCUIT', finisher: 'FINISHER' };
            groupHeader = `<div style="font-size:0.6rem;font-weight:700;color:var(--text-dim);margin-top:8px;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.5px">${groupLabels[group] || group.toUpperCase()}</div>`;
          }

          // Status icon for actual exercises
          const exStatus = ex.status || (ex.completed === false ? 'skipped' : ex.completed === true ? 'completed' : '');
          const exIcon = exStatus === 'completed' ? '<span style="color:#10b981">✓</span>' :
                         exStatus === 'partial' ? '<span style="color:#f59e0b">~</span>' :
                         exStatus === 'skipped' ? '<span style="color:#ef4444">✗</span>' :
                         '<span style="color:var(--text-dim)">·</span>';

          // Format sets info
          let setsInfo = '';
          if (ex.sets && Array.isArray(ex.sets)) {
            // Set-level detail from Fitbod
            const setStrs = ex.sets.map(s => {
              if (s.duration) return s.duration;
              return `${s.reps}${s.weight ? ' × ' + s.weight : ''}`;
            });
            // Collapse identical sets: "5×50, 5×50, 5×50" → "3×5 @ 50 lb"
            const unique = [...new Set(setStrs)];
            if (unique.length === 1) {
              setsInfo = `${ex.sets.length}× ${unique[0]}`;
            } else {
              setsInfo = setStrs.join(' · ');
            }
          } else {
            // Summary-level data
            const parts = [];
            if (ex.planned_sets && !showActual) parts.push(`${ex.planned_sets}×${ex.planned_reps || '?'}${ex.planned_weight ? ' @ ' + ex.planned_weight : ''}`);
            else if (ex.actual_sets) parts.push(`${ex.actual_sets}×${ex.actual_reps || '?'}${ex.actual_weight ? ' @ ' + ex.actual_weight : ''}`);
            else if (ex.total_reps) parts.push(`${ex.total_reps} reps`);
            else if (ex.duration) parts.push(ex.duration);
            else if (ex.total_time) parts.push(`${ex.sets || '?'}× ${ex.total_time}`);
            if (ex.highest_weight) parts.push(ex.highest_weight);
            if (ex.volume && ex.volume !== ex.highest_weight) parts.push(ex.volume + ' vol');
            setsInfo = parts.join(' · ');
          }

          // PR indicator
          const prBadge = ex.pr || ex.notes?.includes('PR') ? ' <span style="color:#eab308;font-size:0.6rem">🏆</span>' : '';

          // Notes
          const notesHtml = ex.notes && !ex.notes.includes('PR') ? `<div style="font-size:0.6rem;color:var(--text-dim);margin-left:20px;font-style:italic">${esc(ex.notes)}</div>` : '';

          return groupHeader + `<div style="display:flex;align-items:baseline;gap:6px;font-size:0.75rem;padding:2px 0">
            ${showActual ? exIcon : '<span style="color:var(--text-dim)">·</span>'}
            <span style="flex:1;font-weight:500">${esc(ex.name)}${prBadge}</span>
            <span style="color:var(--text-dim);font-size:0.68rem;white-space:nowrap">${setsInfo}</span>
          </div>${notesHtml}`;
        }).join('');
      }

      // Planned vs actual comparison line
      let vsLine = '';
      if (showActual && plan.planned_exercises && plan.planned_exercises.length > 0) {
        const plannedCount = plan.planned_exercises.length;
        const actualCount = plan.actual_exercises.filter(e => e.status !== 'skipped' && e.completed !== false).length;
        vsLine = `<div style="font-size:0.65rem;color:var(--text-dim);margin-top:4px">${actualCount}/${plannedCount} exercises completed</div>`;
      }

      planHtml = `
        <div class="card mb-md" style="border-left:3px solid ${statusColor}">
          <div class="card-title" style="display:flex;align-items:center;gap:8px">
            <span>${plan.status === 'rest' ? "Rest Day" : "Today's Plan"}</span>
            <span class="badge-dynamic" style="background:${statusColor}22;color:${statusColor};font-size:0.65rem">${statusIcon} ${plan.status}</span>
            <span style="flex:1"></span>
            <button class="btn-submit btn-compact-sm btn-secondary" style="font-size:0.6rem;padding:2px 6px" onclick="showGymProfilePicker()">⚙</button>
          </div>
          ${plan.title ? `<div style="font-weight:600;font-size:0.85rem">${esc(plan.title)}</div>` : ''}
          ${plan.workout_type ? `<div style="font-size:0.75rem;color:var(--text-dim)">${esc(plan.workout_type)}${plan.workout_focus ? ' — ' + esc(plan.workout_focus) : ''}${plan.target_effort ? ' · effort ' + plan.target_effort : ''}${plan.target_duration_min ? ' · ' + plan.target_duration_min + 'min' : ''}</div>` : ''}
          ${exerciseHtml ? `<div style="margin-top:8px">${exerciseHtml}</div>` : ''}
          ${!exerciseHtml && plan.workout_notes ? `
            <div style="margin-top:8px;padding:8px 10px;background:var(--bg-tertiary);border-radius:6px;font-size:0.75rem;line-height:1.6;white-space:pre-line;font-family:var(--font-mono, monospace)">${esc(plan.workout_notes)}</div>
          ` : ''}
          ${vsLine}
          ${plan.target_calories || plan.target_protein_g || plan.target_hydration_liters || plan.target_sleep_hours ? `
            <div class="list-item-meta" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--bg-tertiary)">
              ${plan.target_calories ? 'Cal: ' + plan.target_calories + ' ' : ''}
              ${plan.target_protein_g ? 'P: ' + plan.target_protein_g + 'g ' : ''}
              ${plan.target_hydration_liters ? 'Water: ' + plan.target_hydration_liters + 'L ' : ''}
              ${plan.target_sleep_hours ? 'Sleep: ' + plan.target_sleep_hours + 'h' : ''}
            </div>
          ` : ''}
          ${plan.coaching_notes ? `<div class="transcript-summary mt-sm">${esc(plan.coaching_notes)}</div>` : ''}
          ${plan.completion_notes ? `<div style="margin-top:6px;padding:6px 8px;background:${statusColor}11;border-radius:6px;font-size:0.72rem;color:var(--text-dim)"><strong style="color:${statusColor}">Coach:</strong> ${esc(plan.completion_notes)}</div>` : ''}
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            ${['completed','partial','missed'].map(s => `<button class="btn-submit btn-compact-sm ${plan.status === s ? '' : 'btn-secondary'}" style="font-size:0.65rem" onclick="quickUpdatePlanStatus('${plan.id}','${s}')">${s.charAt(0).toUpperCase() + s.slice(1)}</button>`).join('')}
            <button class="btn-submit btn-compact-sm btn-secondary" style="font-size:0.65rem" onclick="editDailyPlan('${plan.id}')">Edit</button>
          </div>
        </div>`;
    } else {
      planHtml = `<div class="card mb-md" style="border-left:3px solid #d1d5db">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
          No plan for ${dateLabel}
          <button class="btn-submit btn-compact-sm btn-secondary" style="font-size:0.6rem;padding:2px 6px" onclick="showGymProfilePicker()">⚙</button>
        </div>
        <button class="btn-submit btn-compact-sm" onclick="showCreateDailyPlanForm('${fitnessTodayDate}')">+ Create Plan</button>
      </div>`;
    }

    // Sleep & Context section
    const hasCheckIn = !!(ctx.id);
    let checkInHtml = '';
    if (ctx.id && (ctx.sleep_hours != null || ctx.sleep_quality != null)) {
      const sleepColor = ctx.sleep_hours >= 7 ? '#10b981' : ctx.sleep_hours >= 5.5 ? '#f59e0b' : '#ef4444';
      checkInHtml = `<div class="card mb-md" style="border-left:3px solid ${sleepColor}">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
          Sleep
          <button class="btn-submit btn-compact-sm btn-secondary" style="font-size:0.65rem" onclick="showDailyContextForm('${fitnessTodayDate}','${ctx.id}')">Edit</button>
        </div>
        <div style="display:flex;gap:16px;align-items:center">
          ${ctx.sleep_hours != null ? `<div><span style="font-size:1.4rem;font-weight:700;color:${sleepColor}">${ctx.sleep_hours}</span><span style="font-size:0.8rem;color:var(--text-dim)">h</span></div>` : ''}
          ${ctx.sleep_quality != null ? `<div><span style="font-size:0.8rem;color:var(--text-dim)">Quality:</span> <span style="font-weight:600">${ctx.sleep_quality}/10</span></div>` : ''}
          ${ctx.hydration_liters != null ? `<div><span style="font-size:0.8rem;color:var(--text-dim)">Water:</span> <span style="font-weight:600">${ctx.hydration_liters}L</span></div>` : ''}
        </div>
        ${ctx.notes ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:6px">${esc(ctx.notes)}</div>` : ''}
      </div>`;
    } else {
      checkInHtml = `<div class="card mb-md" style="border-left:3px solid #d1d5db">
        <div class="card-title">No sleep logged</div>
        <button class="btn-submit btn-compact-sm" onclick="showDailyContextForm('${fitnessTodayDate}')">+ Log Sleep & Context</button>
      </div>`;
    }

    // Plan vs Actual comparison (if plan exists and there's data)
    let comparisonHtml = '';
    if (plan && (workouts.length || meals.length || hasCheckIn)) {
      const maxEffort = Math.max(0, ...workouts.map(w => w.effort || 0));
      const totalCal = meals.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
      const totalProtein = meals.reduce((s, m) => s + (parseFloat(m.protein_g) || 0), 0);
      const hydration = parseFloat(ctx.hydration_liters) || 0;
      const sleepHrs = parseFloat(ctx.sleep_hours) || 0;

      function pctBar(actual, target, label, unit) {
        if (!target) return '';
        const pct = Math.min(100, Math.round((actual / target) * 100));
        const color = pct >= 90 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#ef4444';
        return `<div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--text-dim)"><span>${label}</span><span>${Math.round(actual)}/${target}${unit} (${pct}%)</span></div>
          <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div></div>
        </div>`;
      }

      comparisonHtml = `<div class="card mb-md">
        <div class="card-title">Plan vs Actual</div>
        ${pctBar(maxEffort, plan.target_effort, 'Effort', '/10')}
        ${pctBar(totalCal, plan.target_calories, 'Calories', '')}
        ${pctBar(totalProtein, plan.target_protein_g, 'Protein', 'g')}
        ${pctBar(hydration, plan.target_hydration_liters, 'Water', 'L')}
        ${pctBar(sleepHrs, plan.target_sleep_hours, 'Sleep', 'h')}
      </div>`;
    }

    // Workouts section
    const typeColors = { hill: '#f59e0b', strength: '#ef4444', run: '#3b82f6', hybrid: '#8b5cf6', recovery: '#10b981', ruck: '#78716c' };
    let workoutsHtml = '';
    if (workouts.length) {
      workoutsHtml = `<div class="card mb-md"><div class="card-title">Workouts (${workouts.length})</div>
        ${workouts.map(w => {
          const color = typeColors[w.workout_type] || '#6366f1';
          return `<div class="list-item" onclick="showWorkoutDetail('${w.id}')" style="border-left:3px solid ${color};cursor:pointer;padding:6px 8px;margin-bottom:4px">
            <div style="font-weight:600;font-size:0.8rem">${esc(w.title)}</div>
            <div class="list-item-meta">${w.workout_type}${w.effort ? ' · E' + w.effort : ''}${w.time_duration ? ' · ' + esc(w.time_duration) : ''}</div>
          </div>`;
        }).join('')}
      </div>`;
    }

    // Meals section with compact macro bars
    let mealsHtml = '';
    if (meals.length) {
      const totalCal = meals.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
      const totalProtein = meals.reduce((s, m) => s + (parseFloat(m.protein_g) || 0), 0);
      const totalCarbs = meals.reduce((s, m) => s + (parseFloat(m.carbs_g) || 0), 0);
      const totalFat = meals.reduce((s, m) => s + (parseFloat(m.fat_g) || 0), 0);

      // Compact macro summary bar
      const macroTargets = { cal: 2500, p: 145, c: 225, f: 78 }; // moderate defaults
      function miniBar(actual, target, label, color) {
        const pct = Math.min(100, Math.round((actual / target) * 100));
        const barColor = actual > target * 1.15 ? '#ef4444' : color;
        return `<div style="flex:1;text-align:center">
          <div style="font-size:0.6rem;color:var(--text-dim)">${label}</div>
          <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;margin:2px 0;overflow:hidden"><div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px"></div></div>
          <div style="font-size:0.6rem;font-weight:600;color:${barColor}">${Math.round(actual)}<span style="color:var(--text-dim);font-weight:400">/${target}</span></div>
        </div>`;
      }

      mealsHtml = `<div class="card mb-md" onclick="fitnessSubTab='nutrition';loadFitness()" style="cursor:pointer">
        <div class="card-title">Macros — ${meals.length} meal${meals.length !== 1 ? 's' : ''}</div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          ${miniBar(totalCal, macroTargets.cal, 'Cal', '#f59e0b')}
          ${miniBar(totalProtein, macroTargets.p, 'Protein', '#3b82f6')}
          ${miniBar(totalCarbs, macroTargets.c, 'Carbs', '#f59e0b')}
          ${miniBar(totalFat, macroTargets.f, 'Fat', '#ef4444')}
        </div>
        <div style="font-size:0.6rem;color:var(--accent);text-align:center">Tap for full macro dashboard →</div>
      </div>`;
    }

    // Recovery score
    const score = (recoveryData.score != null && !isNaN(recoveryData.score)) ? recoveryData.score : null;
    const scoreColor = score == null ? '#6b7280' : score >= 81 ? '#10b981' : score >= 61 ? '#f59e0b' : score >= 31 ? '#f97316' : '#ef4444';
    const scoreDisplay = score != null ? score : '—';
    const dashVal = score != null ? score : 0;
    let recoveryHtml = `<div class="card mb-md" style="text-align:center">
      <div class="card-title" style="text-align:left">Recovery Score</div>
      <div style="display:inline-block;position:relative;width:80px;height:80px">
        <svg viewBox="0 0 36 36" style="width:80px;height:80px;transform:rotate(-90deg)">
          <circle cx="18" cy="18" r="16" fill="none" stroke="var(--bg-tertiary)" stroke-width="3"/>
          <circle cx="18" cy="18" r="16" fill="none" stroke="${scoreColor}" stroke-width="3"
            stroke-dasharray="${dashVal} ${100 - dashVal}" stroke-linecap="round"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.2rem;font-weight:700;color:${scoreColor}">${scoreDisplay}</div>
      </div>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${score != null ? (recoveryData.label || '') + ' — ' + esc(recoveryData.recommendation || '') : 'Log sleep, workouts & meals to see your recovery score'}</div>
      <details style="text-align:left;margin-top:8px"><summary style="font-size:0.68rem;color:var(--text-dim);cursor:pointer;opacity:0.7">What is this?</summary>
        <div style="font-size:0.68rem;color:var(--text-dim);margin-top:6px;line-height:1.5;text-align:left">
          <div style="margin-bottom:6px"><strong style="color:var(--text)">Your body's readiness to train</strong> — based on sleep, training stress balance (TSB), muscle recovery, injuries, nutrition, and how you feel.</div>
          <div style="margin-bottom:4px"><strong style="color:#10b981">81–100 Peak</strong> — body can handle max effort</div>
          <div style="margin-bottom:4px"><strong style="color:#f59e0b">61–80 Good</strong> — train normally</div>
          <div style="margin-bottom:4px"><strong style="color:#f97316">31–60 Moderate</strong> — reduce intensity or rest</div>
          <div style="margin-bottom:6px"><strong style="color:#ef4444">0–30 Low</strong> — active recovery only</div>
          <div style="margin-bottom:2px;color:var(--text);font-weight:600;font-size:0.66rem">COMPONENTS</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Sleep (30%)</strong> — last night's hours + quality</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Training Load (25%)</strong> — TSB: compares 7-day fatigue to 42-day fitness (like TrainingPeaks). Heavy training blocks pull this down even if you slept well</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Muscle Freshness (20%)</strong> — hours since each group was worked, <em>scaled by effort</em>. High-effort sessions need longer recovery</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Injuries (10%)</strong> — active injury severity impact</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Nutrition (10%)</strong> — yesterday's fuel + today's intake. Capped at 85 if no meals logged today</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Subjective (5%)</strong> — sleep quality as readiness proxy. Defaults to 50 if not logged</div>
          <div style="margin-top:6px;border-top:1px solid var(--bg-tertiary);padding-top:6px">During progressive overload, Training Load (TSB) drops — this is normal and means the score reflects accumulated training stress, not just last night's sleep.</div>
        </div>
      </details>`;

    // Component breakdown (collapsed by default)
    if (recoveryData.components && score != null) {
      const comps = recoveryData.components;
      const compOrder = ['sleep','training_load','muscle_freshness','injury','nutrition','subjective'];
      const compLabels = { sleep: 'Sleep', training_load: 'Training Load', muscle_freshness: 'Muscle Freshness', injury: 'Injuries', nutrition: 'Nutrition', subjective: 'Subjective' };
      recoveryHtml += `<details style="text-align:left;margin-top:8px"><summary style="font-size:0.72rem;color:var(--text-dim);cursor:pointer">Score Breakdown</summary>
        <div style="margin-top:6px">
          ${compOrder.map(k => {
            const c = comps[k];
            if (!c) return '';
            const cColor = c.score >= 81 ? '#10b981' : c.score >= 61 ? '#f59e0b' : c.score >= 31 ? '#f97316' : '#ef4444';
            return `<div style="margin-bottom:6px">
              <div style="display:flex;align-items:center;gap:6px;font-size:0.72rem">
                <span style="width:90px;color:var(--text-dim)">${compLabels[k]}</span>
                <div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div style="height:100%;width:${c.score}%;background:${cColor};border-radius:3px"></div></div>
                <span style="width:24px;text-align:right;font-weight:600;color:${cColor}">${c.score}</span>
              </div>
              ${c.detail ? `<div style="font-size:0.62rem;color:var(--text-dim);opacity:0.7;margin-left:96px;margin-top:1px">${c.detail}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </details>`;
    }
    recoveryHtml += `</div>`;

    // Active injuries
    let injuriesHtml = '';
    if (injuries.length) {
      injuriesHtml = `<div class="card mb-md"><div class="card-title" style="color:#ef4444">Active Injuries (${injuries.length})</div>
        ${injuries.map(inj => `<div class="list-item" onclick="showInjuryDetail('${inj.id}')" style="cursor:pointer;padding:4px 8px;margin-bottom:4px">
          <span style="font-weight:600;font-size:0.8rem">${esc(inj.title)}</span>
          <span class="list-item-meta">${inj.body_area || ''}${inj.severity ? ' · ' + inj.severity + '/10' : ''}</span>
        </div>`).join('')}
      </div>`;
    }

    // Body metrics
    let bodyHtml = '';
    if (bodyMetrics.length) {
      const bm = bodyMetrics[0];
      bodyHtml = `<div class="card mb-md"><div class="card-title">Body Metrics</div>
        <div class="list-item-meta">${bm.weight_lb}lb${bm.body_fat_pct ? ' · ' + bm.body_fat_pct + '% BF' : ''}${bm.muscle_mass_lb ? ' · ' + bm.muscle_mass_lb + 'lb muscle' : ''}</div>
      </div>`;
    }

    // 7-day trend
    let trendHtml = '';
    if (trendData && trendData.trend && trendData.trend.length > 1) {
      const maxScore = 100;
      trendHtml = `<div class="card mb-md"><div class="card-title">7-Day Recovery Trend</div>
        <div style="display:flex;align-items:flex-end;gap:4px;height:80px;padding-top:14px">
          ${trendData.trend.map(t => {
            const s = (t.score != null && !isNaN(t.score)) ? t.score : 0;
            const h = Math.max(4, (s / maxScore) * 56);
            const c = s >= 81 ? '#10b981' : s >= 61 ? '#f59e0b' : s >= 31 ? '#f97316' : '#ef4444';
            const dayLabel = new Date(t.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' });
            return `<div style="flex:1;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
              <div style="font-size:0.55rem;font-weight:600;color:${c};margin-bottom:2px">${s > 0 ? s : ''}</div>
              <div style="width:100%;height:${h}px;background:${c};border-radius:3px;margin-bottom:2px"></div>
              <div style="font-size:0.55rem;color:var(--text-dim)">${dayLabel}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    el.innerHTML = `
      ${weekStrip}
      <div style="text-align:center;font-size:0.8rem;font-weight:600;margin:8px 0;color:var(--text-dim)">${dateLabel}${isToday ? ' (Today)' : ''}</div>
      <div class="fade-in">
        ${planHtml}
        ${checkInHtml}
        ${comparisonHtml}
        ${workoutsHtml}
        ${mealsHtml}
        ${recoveryHtml}
        ${injuriesHtml}
        ${bodyHtml}
        ${trendHtml}
      </div>
    `;
  } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ─── Fitness > Log (quick-add hub) ──────────────────────────────
function loadFitnessLog() {
  const el = document.getElementById('fitness-content');
  if (!el) return;
  const items = [
    { label: 'Workout', icon: '💪', action: "showWorkoutForm()" },
    { label: 'Meal', icon: '🍽️', action: "showMealForm()" },
    { label: 'Sleep', icon: '😴', action: "showDailyContextForm('" + localDateStr() + "')" },
    { label: 'Weight', icon: '⚖️', action: "showBodyMetricForm()" },
    { label: 'Injury', icon: '🩹', action: "showInjuryForm()" },
    { label: 'Plan', icon: '📅', action: "showCreateDailyPlanForm('" + localDateStr() + "')" },
    { label: 'Coaching', icon: '🧠', action: "showCoachingForm()" },
  ];
  el.innerHTML = `
    <div style="padding:12px 0">
      <div style="font-size:0.85rem;font-weight:600;margin-bottom:12px;color:var(--text-dim)">What are you logging?</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
        ${items.map(it => `<button class="card" onclick="${it.action}" style="cursor:pointer;text-align:center;padding:20px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-secondary)">
          <div style="font-size:1.5rem;margin-bottom:6px">${it.icon}</div>
          <div style="font-weight:600;font-size:0.85rem">${it.label}</div>
        </button>`).join('')}
      </div>
    </div>
  `;
}

// ─── Fitness > History (unified browse) ──────────────────────────
let historyFilter = 'all';
let historySearchQuery = '';
let historySearchTimer = null;

function debounceHistorySearch(q) {
  historySearchQuery = q;
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => loadFitnessHistory(), 300);
}

async function loadFitnessHistory() {
  const el = document.getElementById('fitness-content');
  if (!el) return;
  el.innerHTML = skeletonCards(4);

  try {
    const params = new URLSearchParams({ limit: '50' });
    if (historySearchQuery) params.set('q', historySearchQuery);
    const filter = historyFilter;

    // Fetch data based on filter
    const fetches = {};
    if (filter === 'all' || filter === 'workouts') {
      const wp = new URLSearchParams(params);
      fetches.workouts = api('/workouts?' + wp.toString());
    }
    if (filter === 'all' || filter === 'meals') {
      const mp = new URLSearchParams(params);
      fetches.meals = api('/meals?' + mp.toString());
    }
    if (filter === 'all' || filter === 'body') {
      const bp = new URLSearchParams(params);
      fetches.body = api('/body-metrics?' + bp.toString());
    }
    if (filter === 'all' || filter === 'plans') {
      const pp = new URLSearchParams(params);
      fetches.plans = api('/daily-plans?' + pp.toString());
    }

    const results = {};
    const keys = Object.keys(fetches);
    const values = await Promise.all(Object.values(fetches));
    keys.forEach((k, i) => results[k] = values[i]);

    // Build unified timeline items
    const items = [];
    if (results.workouts) {
      (results.workouts.workouts || []).forEach(w => items.push({
        type: 'workout', date: w.workout_date, title: w.title,
        meta: `${w.workout_type || ''}${w.effort ? ' · E' + w.effort : ''}${w.time_duration ? ' · ' + w.time_duration : ''}`,
        color: ({ hill: '#f59e0b', strength: '#ef4444', run: '#3b82f6', hybrid: '#8b5cf6', recovery: '#10b981', ruck: '#78716c' })[w.workout_type] || '#6366f1',
        action: `showWorkoutDetail('${w.id}')`, raw: w
      }));
    }
    if (results.meals) {
      (results.meals.meals || []).forEach(m => items.push({
        type: 'meal', date: m.meal_date, title: m.title,
        meta: `${m.meal_type || ''}${m.calories ? ' · ' + m.calories + 'cal' : ''}${m.protein_g ? ' · ' + m.protein_g + 'g' : ''}`,
        color: '#10b981', action: `showMealDetail('${m.id}')`, raw: m
      }));
    }
    if (results.body) {
      (results.body.body_metrics || []).forEach(b => items.push({
        type: 'body', date: b.measurement_date, title: `${b.weight_lb}lb`,
        meta: `${b.body_fat_pct ? b.body_fat_pct + '% BF' : ''}${b.source ? ' · ' + b.source : ''}`,
        color: '#8b5cf6', action: `showBodyMetricDetail('${b.id}')`, raw: b
      }));
    }
    if (results.plans) {
      (results.plans.results || []).forEach(p => items.push({
        type: 'plan', date: p.plan_date, title: p.title || p.workout_type || 'Daily Plan',
        meta: `${p.status}${p.target_effort ? ' · E' + p.target_effort : ''}`,
        color: '#3b82f6', action: `editDailyPlan('${p.id}')`, raw: p
      }));
    }

    // Sort by date descending
    items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // Group by date
    const grouped = {};
    items.forEach(it => {
      const d = (it.date || '').slice(0, 10);
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(it);
    });

    const typeIcons = { workout: '💪', meal: '🍽️', body: '⚖️', plan: '📅' };
    const filterBtns = ['all','workouts','meals','body','plans'];

    el.innerHTML = `
      <div class="list-search-row">
        <input type="text" class="brain-search" placeholder="Search history..." value="${esc(historySearchQuery)}"
          oninput="debounceHistorySearch(this.value)">
        ${filter === 'workouts' ? `<button class="btn-submit btn-secondary btn-compact-sm" onclick="showWorkoutImport()">Import</button>` : ''}
        ${filter === 'meals' ? `<button class="btn-submit btn-secondary btn-compact-sm" onclick="showMealImport()">Import</button>` : ''}
        ${filter === 'body' ? `<button class="btn-submit btn-secondary btn-compact-sm" onclick="showBodyMetricImport()">Import</button>` : ''}
      </div>
      <div class="filter-row mb-md">
        ${filterBtns.map(f => `<button class="filter-btn ${filter === f ? 'active' : ''}" onclick="historyFilter='${f}';loadFitnessHistory()">${f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}</button>`).join('')}
      </div>
      <div class="transcript-count">${items.length} item${items.length !== 1 ? 's' : ''}</div>
      <div id="history-list" class="fade-in">
        ${Object.keys(grouped).length ? Object.entries(grouped).map(([date, dateItems]) => {
          const d = new Date(date + 'T12:00:00');
          const dateLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          return `
            <div class="date-group-label" style="font-size:0.7rem;font-weight:700;color:var(--text-dim);margin:12px 0 4px;text-transform:uppercase">${dateLabel}</div>
            ${dateItems.map(it => `
              <div class="list-item" onclick="${it.action}" style="border-left:3px solid ${it.color};cursor:pointer">
                <div class="transcript-card-header">
                  <span style="margin-right:4px">${typeIcons[it.type] || ''}</span>
                  <div class="list-item-title">${esc(it.title)}</div>
                  <span class="badge-dynamic" style="background:${it.color}22;color:${it.color};font-size:0.6rem">${it.type}</span>
                </div>
                <div class="list-item-meta">${esc(it.meta)}</div>
              </div>
            `).join('')}`;
        }).join('') : '<div class="empty-state">No data yet. Use the Log tab to start tracking!</div>'}
      </div>
    `;
  } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ─── Fitness > Coaching (sessions + injuries) ───────────────────
let coachingSubFilter = 'sessions';

function loadFitnessCoaching() {
  const el = document.getElementById('fitness-content');
  if (!el) return;
  el.innerHTML = `
    <div class="filter-row mb-md">
      <button class="filter-btn ${coachingSubFilter === 'sessions' ? 'active' : ''}" onclick="coachingSubFilter='sessions';loadFitnessCoaching()">Sessions</button>
      <button class="filter-btn ${coachingSubFilter === 'injuries' ? 'active' : ''}" onclick="coachingSubFilter='injuries';loadFitnessCoaching()">Injuries</button>
    </div>
    <div id="coaching-list"></div>
  `;
  if (coachingSubFilter === 'sessions') loadCoachingSessions();
  else loadInjuries();
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
  const today = localDateStr();
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
let nutritionDate = localDateStr();

const MACRO_GOALS = {
  hard:     { cal: [2700, 2900], p: [140, 150], c: [275, 325], f: [70, 90] },
  moderate: { cal: [2300, 2500], p: [140, 150], c: [200, 250], f: [70, 85] },
  rest:     { cal: [2000, 2200], p: [140, 150], c: [150, 200], f: [65, 80] },
};

function getMacroTarget(tier) {
  const g = MACRO_GOALS[tier] || MACRO_GOALS.moderate;
  return {
    cal: Math.round((g.cal[0] + g.cal[1]) / 2), calRange: g.cal,
    p: Math.round((g.p[0] + g.p[1]) / 2), pRange: g.p,
    c: Math.round((g.c[0] + g.c[1]) / 2), cRange: g.c,
    f: Math.round((g.f[0] + g.f[1]) / 2), fRange: g.f,
  };
}

let _macroChart = null;
let _currentTierOverride = null;

function buildMacroBar(label, actual, goalRange, color) {
  const mid = Math.round((goalRange[0] + goalRange[1]) / 2);
  const pct = mid > 0 ? Math.min((actual / mid) * 100, 115) : 0;
  const inRange = actual >= goalRange[0] && actual <= goalRange[1];
  const over = actual > goalRange[1];
  const fillColor = over ? '#ef4444' : color;
  const zoneLeft = mid > 0 ? (goalRange[0] / mid * 100) : 0;
  const zoneWidth = mid > 0 ? ((goalRange[1] - goalRange[0]) / mid * 100) : 0;
  return `<div class="macro-bar-row">
    <div class="macro-bar-label">${label}</div>
    <div class="macro-bar-track">
      <div class="macro-bar-zone" style="left:${zoneLeft}%;width:${zoneWidth}%"></div>
      <div class="macro-bar-fill" style="width:${pct}%;background:${fillColor}"></div>
    </div>
    <div class="macro-bar-value font-data">${Math.round(actual)}/${mid}g</div>
  </div>`;
}

function buildMacroDashboard(summary) {
  const tier = _currentTierOverride || summary.intensity_tier || 'moderate';
  const src = _currentTierOverride ? 'override' : (summary.intensity_source || 'default');
  const planned = summary.planned_type;
  const goals = getMacroTarget(tier);

  const calActual = summary.total_calories || 0;
  const calPct = goals.cal > 0 ? Math.min((calActual / goals.cal) * 100, 115) : 0;
  const calOver = calActual > goals.calRange[1];
  const calColor = calOver ? '#ef4444' : calActual >= goals.calRange[0] ? '#10b981' : '#f59e0b';

  const badgeColors = { hard: '#ef4444', moderate: '#f59e0b', rest: '#10b981' };
  const badgeColor = badgeColors[tier] || '#f59e0b';
  const sourceLabel = src === 'workout' ? `workout: ${planned}`
    : src === 'plan' ? `plan: ${planned}`
    : src === 'context' ? `set: ${planned}`
    : src === 'override' ? 'manual'
    : 'default';

  const pCal = (summary.total_protein_g || 0) * 4;
  const cCal = (summary.total_carbs_g || 0) * 4;
  const fCal = (summary.total_fat_g || 0) * 9;
  const totalMacroCal = pCal + cCal + fCal;
  const pPct = totalMacroCal > 0 ? Math.round(pCal / totalMacroCal * 100) : 0;
  const cPct = totalMacroCal > 0 ? Math.round(cCal / totalMacroCal * 100) : 0;
  const fPct = totalMacroCal > 0 ? Math.round(fCal / totalMacroCal * 100) : 0;

  return `<div class="macro-dashboard card mb-md">
    <div class="flex-between mb-sm">
      <button class="intensity-badge" style="background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor}44"
        onclick="cycleMacroTier()" title="Tap to change">
        ${tier.toUpperCase()} DAY
      </button>
      <span class="text-micro text-dim">${sourceLabel}</span>
    </div>

    <div class="calorie-bar-wrap mb-sm">
      <div class="flex-between mb-xs">
        <span class="text-micro text-dim">Calories</span>
        <span class="font-data" style="font-size:0.85rem;color:${calColor}">${Math.round(calActual)} / ${goals.cal}</span>
      </div>
      <div class="calorie-bar-track">
        <div class="calorie-bar-fill" style="width:${calPct}%;background:${calColor}"></div>
      </div>
    </div>

    <div class="macro-chart-row">
      <div class="macro-chart-wrap">
        <canvas id="macro-chart"></canvas>
        <div class="macro-chart-center font-data">${totalMacroCal > 0 ? Math.round(calActual) : '—'}<br><span class="text-micro">kcal</span></div>
      </div>
      <div class="macro-bars-wrap">
        ${buildMacroBar('P', summary.total_protein_g || 0, goals.pRange, '#3b82f6')}
        ${buildMacroBar('C', summary.total_carbs_g || 0, goals.cRange, '#f59e0b')}
        ${buildMacroBar('F', summary.total_fat_g || 0, goals.fRange, '#ef4444')}
        <div class="macro-legend mt-xs">
          <span style="color:#3b82f6">${pPct}% P</span>
          <span style="color:#f59e0b">${cPct}% C</span>
          <span style="color:#ef4444">${fPct}% F</span>
        </div>
      </div>
    </div>
  </div>`;
}

function renderMacroChart(summary) {
  if (_macroChart) { _macroChart.destroy(); _macroChart = null; }
  const el = document.getElementById('macro-chart');
  if (!el) return;
  const p = (summary.total_protein_g || 0) * 4;
  const c = (summary.total_carbs_g || 0) * 4;
  const f = (summary.total_fat_g || 0) * 9;
  if (p + c + f === 0) {
    // Empty state: single gray ring
    _macroChart = new Chart(el, {
      type: 'doughnut',
      data: { datasets: [{ data: [1], backgroundColor: ['rgba(255,255,255,0.1)'], borderWidth: 0 }] },
      options: { cutout: '70%', plugins: { legend: { display: false }, tooltip: { enabled: false } }, responsive: true, maintainAspectRatio: true, events: [] }
    });
    return;
  }
  _macroChart = new Chart(el, {
    type: 'doughnut',
    data: {
      labels: ['Protein','Carbs','Fat'],
      datasets: [{ data: [p, c, f], backgroundColor: ['#3b82f6','#f59e0b','#ef4444'], borderWidth: 0 }]
    },
    options: {
      cutout: '70%',
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => `${ctx.label}: ${Math.round(ctx.parsed)}cal (${Math.round(ctx.parsed / (p+c+f) * 100)}%)` }
      }},
      responsive: true,
      maintainAspectRatio: true,
    }
  });
}

function cycleMacroTier() {
  const tiers = ['hard', 'moderate', 'rest'];
  const current = _currentTierOverride || 'moderate';
  const idx = tiers.indexOf(current);
  _currentTierOverride = tiers[(idx + 1) % tiers.length];
  loadNutrition();
}

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

      ${buildMacroDashboard(summary)}

      ${ctx && ctx.hydration_liters ? `
      <div class="card mb-md" style="padding:10px;font-size:0.8rem">
        <div class="flex-between mb-xs">
          <strong>Hydration</strong>
          <button class="btn-action btn-compact-sm" onclick="showDailyContextForm('${nutritionDate}','${ctx.id}')" style="padding:2px 8px;font-size:0.7rem">Edit</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:1.2rem;font-weight:700;color:#06b6d4">${ctx.hydration_liters}L</span>
          <div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div style="height:100%;width:${Math.min(100, Math.round((ctx.hydration_liters / 3) * 100))}%;background:#06b6d4;border-radius:3px"></div></div>
          <span class="text-micro text-dim">/ 3L</span>
        </div>
      </div>` : ''}

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
    renderMacroChart(summary);
    if (window.lucide) lucide.createIcons();
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
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
  const numField = (id, label, val, step) =>
    `<div class="form-group flex-1" style="min-width:90px"><label>${label}</label><input type="number" step="${step || '1'}" id="${id}" value="${val != null ? val : ''}" placeholder="—"></div>`;

  const html = `
    <div class="form-scroll">
      <div class="flex-row-wrap">
        ${numField('dc-sleep-hrs', 'Sleep (hrs)', ctx.sleep_hours, '0.5')}
        ${numField('dc-sleep-q', 'Sleep Quality (1-10)', ctx.sleep_quality, '1')}
        ${numField('dc-water', 'Water (L)', ctx.hydration_liters, '0.1')}
      </div>
      <div class="form-group"><label>Notes</label><textarea id="dc-notes" rows="3" placeholder="How are you feeling? Any context for the day...">${esc(ctx.notes || '')}</textarea></div>
      <button class="btn-submit" onclick="saveDailyContext('${date}','${editId || ''}')" style="width:100%;margin-top:8px">${editId ? 'Update' : 'Save'}</button>
    </div>
  `;
  openModal(`Sleep & Context — ${date}`, html);
}

async function saveDailyContext(date, editId) {
  const nv = (id) => { const v = document.getElementById(id)?.value; return v ? Number(v) : null; };
  const body = {
    date,
    sleep_hours: nv('dc-sleep-hrs'),
    sleep_quality: nv('dc-sleep-q'),
    hydration_liters: nv('dc-water'),
    notes: document.getElementById('dc-notes').value || null,
  };
  try {
    if (editId) {
      await api(`/nutrition/daily-context/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await api('/nutrition/daily-context', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal();
    if (fitnessSubTab === 'today') loadFitnessToday();
    else loadNutrition(date);
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
  const today = localDateStr();

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
// ─── Recovery ──────────────────────────────────────────────────
let recoveryDate = localDateStr();

async function loadRecovery(date) {
  if (date) recoveryDate = date;
  const main = document.getElementById('fitness-content') || document.getElementById('main-content');
  main.innerHTML = skeletonCards(3);
  try {
    const today = recoveryDate;
    const [scoreData, trendData] = await Promise.all([
      api(`/recovery/score?date=${today}`),
      api(`/recovery/trend?date=${today}&days=7`),
    ]);

    const s = scoreData;
    const scoreColor = s.score >= 81 ? '#10b981' : s.score >= 61 ? '#f59e0b' : s.score >= 31 ? '#f97316' : '#ef4444';
    const scoreRingPct = s.score;
    const circumference = 2 * Math.PI * 70;
    const offset = circumference - (scoreRingPct / 100) * circumference;

    const statusColors = { fresh: '#10b981', recovering: '#f59e0b', fatigued: '#ef4444' };
    const componentIcons = {
      sleep: 'moon', training_load: 'activity', muscle_freshness: 'body',
      injury: 'heart-pulse', nutrition: 'utensils', subjective: 'brain'
    };
    const componentLabels = {
      sleep: 'Sleep', training_load: 'Training Load', muscle_freshness: 'Muscle Freshness',
      injury: 'Injury Impact', nutrition: 'Nutrition', subjective: 'Subjective'
    };

    // Check if sleep is logged
    const ctx = await api(`/nutrition/daily-context?date=${today}`);
    const sleepLogged = ctx && ctx.sleep_hours != null;

    const dLabel = new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    main.innerHTML = `
      <!-- Date Navigation -->
      <div class="flex-between mb-sm">
        <button class="btn-action btn-icon" onclick="loadRecovery(shiftDate(recoveryDate,-1))">&lt;</button>
        <div class="text-center flex-1">
          <input type="date" value="${today}" onchange="loadRecovery(this.value)"
            style="background:transparent;border:none;color:var(--text);font-size:1rem;text-align:center;cursor:pointer">
          <div class="text-micro">${dLabel}</div>
        </div>
        <button class="btn-action btn-icon" onclick="loadRecovery(shiftDate(recoveryDate,1))">&gt;</button>
      </div>

      <!-- Recovery Score Hero -->
      <div class="recovery-score-hero card mb-md">
        <svg viewBox="0 0 160 160" class="recovery-score-ring">
          <circle cx="80" cy="80" r="70" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10"/>
          <circle cx="80" cy="80" r="70" fill="none" stroke="${scoreColor}" stroke-width="10"
            stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
            transform="rotate(-90 80 80)" style="transition: stroke-dashoffset 0.8s ease"/>
        </svg>
        <div class="recovery-score-center">
          <div class="recovery-score-number font-data" style="color:${scoreColor}">${s.score}</div>
          <div class="recovery-score-label">${s.label}</div>
        </div>
      </div>

      <!-- Explainer -->
      <details class="card mb-md" style="padding:12px">
        <summary style="font-size:0.75rem;color:var(--text-dim);cursor:pointer">What is the Recovery Score?</summary>
        <div style="font-size:0.72rem;color:var(--text-dim);margin-top:8px;line-height:1.6">
          <div style="margin-bottom:8px"><strong style="color:var(--text)">Your body's readiness to train</strong> — based on sleep, training stress balance (TSB), muscle recovery, injuries, nutrition, and how you feel.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:8px">
            <div><strong style="color:#10b981">81–100 Peak</strong> — max effort</div>
            <div><strong style="color:#f59e0b">61–80 Good</strong> — train normally</div>
            <div><strong style="color:#f97316">31–60 Moderate</strong> — reduce or rest</div>
            <div><strong style="color:#ef4444">0–30 Low</strong> — recovery only</div>
          </div>
          <div style="margin-bottom:2px;color:var(--text);font-weight:600;font-size:0.68rem">COMPONENTS</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Sleep (30%)</strong> — last night's hours + quality</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Training Load (25%)</strong> — TSB: compares 7-day fatigue to 42-day fitness. Heavy blocks pull this down even with good sleep</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Muscle Freshness (20%)</strong> — hours since each group was worked, <em>scaled by effort</em>. Hard sessions need longer recovery</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Injuries (10%)</strong> — active injury severity impact</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Nutrition (10%)</strong> — yesterday's fuel + today's intake. Capped at 85 if no meals logged today</div>
          <div style="margin-bottom:4px"><strong style="color:var(--text)">Subjective (5%)</strong> — sleep quality as readiness proxy. Defaults to 50 if not logged</div>
          <div style="margin-top:6px;border-top:1px solid var(--bg-tertiary);padding-top:6px">During progressive overload, Training Load (TSB) drops — this reflects accumulated training stress, not just last night's sleep. Watch the 7-day trend for overall direction.</div>
        </div>
      </details>

      <!-- Sleep Card -->
      <div class="card mb-md" style="padding:12px">
        <div class="flex-between mb-sm">
          <strong style="font-size:0.85rem">Sleep</strong>
          ${sleepLogged ? `<button class="btn-action btn-compact-sm" onclick="showSleepForm()" style="font-size:0.7rem;padding:2px 8px">Edit</button>` : ''}
        </div>
        ${sleepLogged ? `
          <div class="flex-row-wrap text-dim" style="font-size:0.8rem">
            <span class="font-data">${ctx.sleep_hours}h</span>
            <span>Quality: ${ctx.sleep_quality || '—'}/10</span>
            ${ctx.recovery_rating ? `<span>Recovery feel: ${ctx.recovery_rating}/10</span>` : ''}
          </div>
          <div class="calorie-bar-track mt-sm" style="height:6px">
            <div class="calorie-bar-fill" style="width:${Math.min((ctx.sleep_hours / 8) * 100, 115)}%;background:${ctx.sleep_hours >= 7 ? '#10b981' : ctx.sleep_hours >= 6 ? '#f59e0b' : '#ef4444'}"></div>
          </div>
          <div class="text-micro text-dim mt-xs">${ctx.sleep_hours}h / 8h target</div>
        ` : `
          <div class="sleep-quick-form">
            <div class="flex-row-wrap" style="gap:8px">
              <div class="form-group" style="flex:1;min-width:80px;margin:0">
                <label style="font-size:0.7rem">Hours</label>
                <input type="number" id="sleep-hrs-quick" min="0" max="24" step="0.5" placeholder="7.5" style="padding:6px 8px">
              </div>
              <div class="form-group" style="flex:1;min-width:80px;margin:0">
                <label style="font-size:0.7rem">Quality (1-10)</label>
                <input type="number" id="sleep-q-quick" min="1" max="10" step="1" placeholder="7" style="padding:6px 8px">
              </div>
              <button class="btn-submit btn-compact-sm" onclick="saveSleepQuick()" style="align-self:flex-end;padding:6px 14px">Log</button>
            </div>
          </div>
        `}
      </div>

      <!-- Score Breakdown -->
      <div class="card mb-md" style="padding:12px">
        <div class="flex-between mb-sm" onclick="document.getElementById('recovery-breakdown').classList.toggle('hidden')" style="cursor:pointer">
          <strong style="font-size:0.85rem">Score Breakdown</strong>
          <span class="text-dim" style="font-size:0.75rem">tap to expand</span>
        </div>
        <div id="recovery-breakdown" class="hidden">
          ${Object.entries(s.components).map(([key, comp]) => `
            <div class="recovery-component-row">
              <span class="recovery-comp-label">${componentLabels[key] || key}</span>
              <div class="macro-bar-track" style="flex:1;height:6px">
                <div class="macro-bar-fill" style="width:${comp.score}%;background:${comp.score >= 70 ? '#10b981' : comp.score >= 40 ? '#f59e0b' : '#ef4444'}"></div>
              </div>
              <span class="font-data" style="font-size:0.7rem;min-width:28px;text-align:right">${comp.score}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Muscle Status Grid -->
      <div class="card mb-md" style="padding:12px">
        <strong style="font-size:0.85rem;display:block;margin-bottom:8px">Muscle Status</strong>
        <div class="muscle-grid">
          ${Object.entries(s.muscle_status).map(([key, m]) => {
            const color = statusColors[m.status] || '#64748b';
            return `
            <div class="muscle-card" style="border-color:${color}33">
              <div class="flex-between">
                <span style="font-size:0.75rem;font-weight:600">${m.label}</span>
                <span class="muscle-status-badge" style="background:${color}22;color:${color}">${m.status}</span>
              </div>
              <div class="macro-bar-track mt-xs" style="height:4px">
                <div class="macro-bar-fill" style="width:${m.recovery_pct}%;background:${color}"></div>
              </div>
              <div class="text-micro text-dim mt-xs">${m.hours_since != null ? m.hours_since + 'h ago' : 'No recent load'}</div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <!-- Recommendation -->
      ${s.recommendation ? `
      <div class="card mb-md recovery-rec" style="padding:10px;font-size:0.8rem">
        <strong style="font-size:0.75rem;color:var(--accent);display:block;margin-bottom:4px">Recommendation</strong>
        ${esc(s.recommendation)}
      </div>` : ''}

      <!-- 7-Day Trend -->
      <div class="card mb-md" style="padding:12px">
        <strong style="font-size:0.85rem;display:block;margin-bottom:8px">7-Day Trend</strong>
        <div class="recovery-trend">
          ${trendData.trend.map(d => {
            const c = d.score >= 81 ? '#10b981' : d.score >= 61 ? '#f59e0b' : d.score >= 31 ? '#f97316' : '#ef4444';
            const day = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
            return `<div class="recovery-trend-bar">
              <div class="recovery-trend-fill" style="height:${d.score}%;background:${c}"></div>
              <div class="recovery-trend-score font-data">${d.score}</div>
              <div class="recovery-trend-day">${day}</div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

async function saveSleepQuick() {
  const hrs = document.getElementById('sleep-hrs-quick')?.value;
  const qual = document.getElementById('sleep-q-quick')?.value;
  if (!hrs) return;
  const dateToSave = recoveryDate;
  try {
    // Check if context exists
    const existing = await api(`/nutrition/daily-context?date=${dateToSave}`);
    if (existing && existing.id) {
      await api(`/nutrition/daily-context/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ sleep_hours: Number(hrs), sleep_quality: qual ? Number(qual) : null }) });
    } else {
      await api('/nutrition/daily-context', { method: 'POST', body: JSON.stringify({ date: dateToSave, sleep_hours: Number(hrs), sleep_quality: qual ? Number(qual) : null }) });
    }
    loadRecovery();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function showSleepForm() {
  // Reuse the daily context form which already has sleep fields
  showDailyContextForm(recoveryDate);
}

let trainingSubTab = 'day';
let plansWeekOffset = 0;
let plansSelectedDate = localDateStr();

async function loadTraining() {
  const main = document.getElementById('fitness-content') || document.getElementById('main-content');
  main.innerHTML = `
    <div class="filter-row" style="margin-bottom:12px">
      <button class="filter-btn ${trainingSubTab === 'day' ? 'active' : ''}" onclick="trainingSubTab='day';loadTraining()">Day View</button>
      <button class="filter-btn ${trainingSubTab === 'plans' ? 'active' : ''}" onclick="trainingSubTab='plans';loadTraining()">Plans</button>
      <button class="filter-btn ${trainingSubTab === 'coaching' ? 'active' : ''}" onclick="trainingSubTab='coaching';loadTraining()">Coaching</button>
      <button class="filter-btn ${trainingSubTab === 'injuries' ? 'active' : ''}" onclick="trainingSubTab='injuries';loadTraining()">Injuries</button>
    </div>
    <div id="training-content"><div class="loading">Loading...</div></div>
  `;
  if (trainingSubTab === 'day') loadTrainingDay();
  else if (trainingSubTab === 'plans') loadUnifiedPlans();
  else if (trainingSubTab === 'coaching') loadCoachingSessions();
  else if (trainingSubTab === 'injuries') loadInjuries();
}

// ── Plans Tab — Today-first with check-in ──
async function loadUnifiedPlans() {
  const container = document.getElementById('training-content') || document.getElementById('fitness-content');
  const dpColors = { planned: '#3b82f6', completed: '#22c55e', partial: '#f59e0b', missed: '#ef4444', rest: '#6366f1', amended: '#8b5cf6' };

  // Compute week dates from offset
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA');
  const dayOfWeek = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + (plansWeekOffset * 7));
  const monStr = monday.toLocaleDateString('en-CA');
  const sunDate = new Date(monday);
  sunDate.setDate(monday.getDate() + 6);
  const sunStr = sunDate.toLocaleDateString('en-CA');

  // Fetch week plans + training plans + selected day data in parallel
  try {
    const [weekData, dayData] = await Promise.all([
      api(`/daily-plans?from=${monStr}&to=${sunStr}`),
      api(`/training/day/${plansSelectedDate}`),
    ]);

    const weekPlans = weekData.results || [];
    const planMap = {};
    for (const p of weekPlans) planMap[p.plan_date?.slice(0, 10)] = p;

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let html = '';

    // ── Header with + Plan button ──
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:600;font-size:0.9rem;color:var(--text-secondary)">plans</div>
      <button class="btn-submit" onclick="showCreateDailyPlanForm('${plansSelectedDate}')" style="padding:4px 14px;font-size:0.8rem">+ Plan</button>
    </div>`;

    // ── Week strip with navigation ──
    html += `<div class="plans-week-strip">
      <button class="plans-week-arrow" onclick="plansWeekOffset--;loadUnifiedPlans()">&lsaquo;</button>
      <div class="plans-week-days">`;
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dateStr = d.toLocaleDateString('en-CA');
      const plan = planMap[dateStr];
      const isToday = dateStr === todayStr;
      const isSelected = dateStr === plansSelectedDate;
      const statusColor = plan ? (dpColors[plan.status] || '#6366f1') : 'transparent';
      const pillType = plan ? (plan.status === 'rest' ? 'Rest' : (plan.workout_type || plan.title?.slice(0, 12) || '—')) : '';
      html += `<button class="plans-day-pill${isToday ? ' is-today' : ''}${isSelected ? ' selected' : ''}${plan ? ' has-plan' : ''}" onclick="plansSelectedDate='${dateStr}';loadUnifiedPlans()" style="--pill-status:${statusColor}">
        <span class="plans-day-pill-label">${dayLabels[i]}</span>
        <span class="plans-day-pill-date">${d.getDate()}</span>
        ${plan ? `<span class="plans-day-pill-type" style="color:${statusColor}">${esc(pillType)}</span>` : '<span class="plans-day-pill-type" style="color:var(--text-dim)">—</span>'}
      </button>`;
    }
    html += `</div>
      <button class="plans-week-arrow" onclick="plansWeekOffset++;loadUnifiedPlans()">&rsaquo;</button>
    </div>`;
    if (plansWeekOffset !== 0) {
      html += `<div style="text-align:center;margin-bottom:8px"><button class="btn-action" style="font-size:0.7rem;padding:2px 10px" onclick="plansWeekOffset=0;plansSelectedDate='${todayStr}';loadUnifiedPlans()">Back to today</button></div>`;
    }

    // ── Hero plan card ──
    const dp = dayData.daily_plan;
    const selectedLabel = new Date(plansSelectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const isRest = dp?.status === 'rest';

    if (!dp) {
      // No plan for this day
      html += `<div class="plans-hero-card">
        <div class="plans-hero-header">
          <span class="plans-hero-date">${selectedLabel}</span>
        </div>
        <div class="empty-state" style="padding:24px 0">
          <div style="color:var(--text-dim);margin-bottom:12px">No plan for this day</div>
          <button class="btn-submit" onclick="showCreateDailyPlanForm('${plansSelectedDate}')" style="padding:8px 20px">+ Create Plan</button>
        </div>
      </div>`;
    } else if (isRest) {
      // Rest day
      html += `<div class="plans-hero-card" style="border-left:4px solid #6366f1">
        <div class="plans-hero-header">
          <span class="plans-hero-date">${selectedLabel}</span>
          <span class="plans-status-pill" style="background:#6366f122;color:#6366f1">${dp.status}</span>
        </div>
        <div style="text-align:center;padding:16px 0;font-size:1.1rem;font-weight:700;color:#6366f1">Rest Day</div>
        ${dp.recovery_notes ? `<div style="font-size:0.8rem;color:var(--text-dim);text-align:center">${esc(dp.recovery_notes)}</div>` : ''}
        ${dp.coaching_notes ? `<div style="font-size:0.8rem;color:var(--text-dim);text-align:center;font-style:italic;margin-top:4px">${esc(dp.coaching_notes)}</div>` : ''}
        <div class="plans-actions" style="display:flex;gap:8px">
          <button class="btn-action" style="flex:1" onclick="editDailyPlan('${dp.id}')">Edit Plan</button>
          <button class="btn-action" style="flex:0 0 auto;background:#ef444422;color:#ef4444" onclick="if(confirm('Delete this plan?'))deleteDailyPlan('${dp.id}')">Delete</button>
        </div>
      </div>`;
    } else {
      // Active plan day
      const sc = dpColors[dp.status] || '#6366f1';
      html += `<div class="plans-hero-card" style="border-left:4px solid ${sc}">
        <div class="plans-hero-header">
          <span class="plans-hero-date">${selectedLabel}</span>
          <span class="plans-status-pill" style="background:${sc}22;color:${sc}">${dp.status}</span>
        </div>`;

      // Title and goal
      if (dp.title) {
        html += `<div style="padding:0 14px 4px;font-weight:700;font-size:1rem">${esc(dp.title)}</div>`;
      }
      if (dp.goal) {
        html += `<div style="padding:0 14px 8px;font-size:0.8rem;color:var(--text-dim)">${esc(dp.goal)}</div>`;
      }

      // Workout section
      if (dp.workout_type || dp.workout_focus || dp.target_effort) {
        html += `<div class="plans-section">
          <div class="plans-section-label">Workout</div>
          <div style="font-weight:700;font-size:0.95rem">${esc(dp.workout_type || 'Workout')}${dp.workout_focus ? ` — ${esc(dp.workout_focus)}` : ''}</div>
          <div class="plans-section-meta">
            ${dp.target_effort ? `<span>Effort: <strong>${dp.target_effort}/10</strong></span>` : ''}
            ${dp.target_duration_min ? `<span>Duration: <strong>${dp.target_duration_min} min</strong></span>` : ''}
          </div>
          ${dp.workout_notes ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:4px">${esc(dp.workout_notes)}</div>` : ''}
        </div>`;
      }

      // Nutrition targets
      const hasNutrition = dp.target_calories || dp.target_protein_g || dp.target_hydration_liters;
      if (hasNutrition) {
        html += `<div class="plans-section">
          <div class="plans-section-label">Nutrition</div>
          <div class="plans-section-meta">
            ${dp.target_calories ? `<span>Cal: <strong>${Math.round(parseFloat(dp.target_calories))}</strong></span>` : ''}
            ${dp.target_protein_g ? `<span>Protein: <strong>${Math.round(parseFloat(dp.target_protein_g))}g</strong></span>` : ''}
            ${dp.target_carbs_g ? `<span>Carbs: <strong>${Math.round(parseFloat(dp.target_carbs_g))}g</strong></span>` : ''}
            ${dp.target_fat_g ? `<span>Fat: <strong>${Math.round(parseFloat(dp.target_fat_g))}g</strong></span>` : ''}
            ${dp.target_hydration_liters ? `<span>Water: <strong>${dp.target_hydration_liters}L</strong></span>` : ''}
          </div>
        </div>`;
      }

      // Recovery target
      if (dp.target_sleep_hours) {
        html += `<div class="plans-section">
          <div class="plans-section-label">Recovery</div>
          <div class="plans-section-meta"><span>Sleep: <strong>${dp.target_sleep_hours}h</strong></span></div>
        </div>`;
      }

      // Coaching notes
      if (dp.coaching_notes) {
        html += `<div style="font-size:0.78rem;color:var(--text-dim);font-style:italic;padding:0 12px 8px">${esc(dp.coaching_notes)}</div>`;
      }

      // ── Check-in: Plan vs Actual ──
      const hasActual = dayData.workouts?.length || dayData.meals?.length || dayData.nutrition_context;
      if (hasActual) {
        const maxEffort = Math.max(0, ...(dayData.workouts || []).map(w => w.effort || 0));
        const totalCal = (dayData.meals || []).reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
        const totalProtein = (dayData.meals || []).reduce((s, m) => s + (parseFloat(m.protein_g) || 0), 0);
        const nc = dayData.nutrition_context || {};

        const rows = [];
        if (dp.target_effort) {
          const pct = Math.min(100, Math.round((maxEffort / dp.target_effort) * 100));
          rows.push({ label: 'Effort', actual: maxEffort || '—', target: dp.target_effort, pct });
        }
        if (dp.target_calories) {
          const pct = Math.min(100, Math.round((totalCal / parseFloat(dp.target_calories)) * 100));
          rows.push({ label: 'Calories', actual: Math.round(totalCal) || '—', target: Math.round(parseFloat(dp.target_calories)), pct });
        }
        if (dp.target_protein_g) {
          const pct = Math.min(100, Math.round((totalProtein / parseFloat(dp.target_protein_g)) * 100));
          rows.push({ label: 'Protein', actual: Math.round(totalProtein) + 'g', target: Math.round(parseFloat(dp.target_protein_g)) + 'g', pct });
        }
        if (dp.target_hydration_liters && nc.hydration_liters) {
          const pct = Math.min(100, Math.round((parseFloat(nc.hydration_liters) / parseFloat(dp.target_hydration_liters)) * 100));
          rows.push({ label: 'Water', actual: nc.hydration_liters + 'L', target: dp.target_hydration_liters + 'L', pct });
        }
        if (dp.target_sleep_hours && nc.sleep_hours) {
          const pct = Math.min(100, Math.round((parseFloat(nc.sleep_hours) / parseFloat(dp.target_sleep_hours)) * 100));
          rows.push({ label: 'Sleep', actual: nc.sleep_hours + 'h', target: dp.target_sleep_hours + 'h', pct });
        }

        if (rows.length) {
          html += `<div class="plans-checkin">
            <div class="plans-section-label">Check-in</div>
            ${rows.map(r => {
              const barColor = r.pct >= 100 ? '#22c55e' : r.pct >= 70 ? '#f59e0b' : '#ef4444';
              return `<div class="plans-checkin-row">
                <div class="plans-checkin-meta">
                  <span class="plans-checkin-label">${r.label}</span>
                  <span><strong style="color:${barColor}">${r.actual}</strong> / ${r.target}</span>
                </div>
                <div class="plans-checkin-bar-track"><div class="plans-checkin-bar-fill" style="width:${r.pct}%;background:${barColor}"></div></div>
              </div>`;
            }).join('')}
          </div>`;
        }
      }

      // ── Quick status buttons + Edit ──
      html += `<div class="plans-status-row">
        <button class="plans-status-btn ${dp.status === 'completed' ? 'active' : ''}" style="--btn-color:#22c55e" onclick="quickUpdatePlanStatus('${dp.id}','completed')">Completed</button>
        <button class="plans-status-btn ${dp.status === 'partial' ? 'active' : ''}" style="--btn-color:#f59e0b" onclick="quickUpdatePlanStatus('${dp.id}','partial')">Partial</button>
        <button class="plans-status-btn ${dp.status === 'missed' ? 'active' : ''}" style="--btn-color:#ef4444" onclick="quickUpdatePlanStatus('${dp.id}','missed')">Missed</button>
      </div>
      <div class="plans-actions" style="display:flex;gap:8px">
        <button class="btn-action" style="flex:1" onclick="editDailyPlan('${dp.id}')">Edit Plan</button>
        <button class="btn-action" style="flex:0 0 auto;background:#ef444422;color:#ef4444" onclick="if(confirm('Delete this plan?'))deleteDailyPlan('${dp.id}')">Delete</button>
      </div>`;

      html += '</div>'; // close plans-hero-card
    }

    // ── Week plan list (all plans for the week) ──
    const sortedPlans = weekPlans.slice().sort((a, b) => (a.plan_date || '').localeCompare(b.plan_date || ''));
    if (sortedPlans.length) {
      html += `<div style="margin-top:12px">`;
      for (const p of sortedPlans) {
        const pDate = p.plan_date?.slice(0, 10) || '';
        const pLabel = new Date(pDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const sc = dpColors[p.status] || '#6366f1';
        const isSelected = pDate === plansSelectedDate;
        const title = p.title || (p.workout_type ? `${p.workout_type}${p.workout_focus ? ' — ' + p.workout_focus : ''}` : 'Plan');
        html += `<div class="card mb-sm" onclick="plansSelectedDate='${pDate}';loadUnifiedPlans()" style="cursor:pointer;border-left:3px solid ${sc};padding:10px 12px;${isSelected ? 'background:var(--bg-tertiary);' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:600;font-size:0.85rem">${esc(title)}</div>
              <div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">${pLabel}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="badge-dynamic" style="background:${sc}22;color:${sc};font-size:0.6rem;padding:2px 6px;border-radius:4px">${p.status}</span>
              ${p.workout_type ? `<span style="font-size:0.65rem;color:var(--text-dim)">${esc(p.workout_type)}</span>` : ''}
            </div>
          </div>
          ${p.goal ? `<div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">${esc(p.goal)}</div>` : ''}
        </div>`;
      }
      html += `</div>`;
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  }
}

async function quickUpdatePlanStatus(id, status) {
  try {
    await api(`/daily-plans/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    if (fitnessSubTab === 'today') loadFitnessToday();
    else loadUnifiedPlans();
  } catch (e) { showToast(e.message); }
}

// ─── Gym Profile Picker ─────────────────────────────────────
async function showGymProfilePicker() {
  try {
    const [profiles, catalog] = await Promise.all([
      api('/exercises/gym-profiles'),
      api('/exercises/equipment'),
    ]);

    // Group equipment by category
    const categories = {};
    for (const eq of catalog) {
      if (!categories[eq.category]) categories[eq.category] = [];
      categories[eq.category].push(eq);
    }
    const categoryLabels = { free_weights: 'Free Weights', machines: 'Machines', benches: 'Benches & Racks', racks: 'Racks', bodyweight: 'Bodyweight', accessories: 'Accessories', cardio: 'Cardio' };

    const activeProfile = profiles.find(p => p.is_active);
    const activeEquipment = new Set(activeProfile ? activeProfile.equipment : []);

    // Profile tabs
    const profileTabs = profiles.length ? profiles.map(p =>
      `<button class="btn-submit btn-compact-sm ${p.is_active ? '' : 'btn-secondary'}" style="font-size:0.7rem" onclick="switchGymProfile('${p.id}')">${esc(p.name)}${p.is_active ? ' ●' : ''}</button>`
    ).join(' ') : '<span style="font-size:0.75rem;color:var(--text-dim)">No profiles yet</span>';

    // Equipment checkboxes
    let equipHtml = '';
    for (const [cat, items] of Object.entries(categories)) {
      const label = categoryLabels[cat] || cat;
      equipHtml += `<div style="margin-top:10px"><div style="font-size:0.68rem;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">${label}</div>`;
      equipHtml += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">`;
      for (const eq of items) {
        const checked = activeEquipment.has(eq.id) ? 'checked' : '';
        equipHtml += `<label style="font-size:0.72rem;display:flex;align-items:center;gap:6px;padding:4px;cursor:pointer">
          <input type="checkbox" class="gym-equip-cb" value="${eq.id}" ${checked}> ${eq.label}
        </label>`;
      }
      equipHtml += `</div></div>`;
    }

    const html = `
      <div style="margin-bottom:12px">
        <div style="font-size:0.75rem;font-weight:600;margin-bottom:6px">Profiles</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${profileTabs}
          <button class="btn-action btn-compact-sm" style="font-size:0.7rem" onclick="createGymProfile()">+ New</button>
        </div>
      </div>
      ${activeProfile ? `
        <div style="font-size:0.75rem;font-weight:600;margin-bottom:4px">Equipment — ${esc(activeProfile.name)}</div>
        ${equipHtml}
        <button class="btn-submit" style="width:100%;margin-top:12px" onclick="saveGymProfileEquipment('${activeProfile.id}')">Save Equipment</button>
      ` : `
        <div style="font-size:0.8rem;color:var(--text-dim);text-align:center;padding:20px 0">
          Create a profile to select your equipment
        </div>
      `}
    `;
    openModal('Gym Profiles', html);
  } catch (e) { showToast(e.message); }
}

async function switchGymProfile(id) {
  try {
    await api(`/exercises/gym-profiles/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
    closeModal();
    showGymProfilePicker();
  } catch (e) { showToast(e.message); }
}

async function createGymProfile() {
  const name = prompt('Profile name (e.g. Home, Gym, Travel):');
  if (!name) return;
  try {
    await api('/exercises/gym-profiles', { method: 'POST', body: JSON.stringify({ name, is_active: true, equipment: ['bodyweight'] }) });
    closeModal();
    showGymProfilePicker();
  } catch (e) { showToast(e.message); }
}

async function saveGymProfileEquipment(id) {
  const checkboxes = document.querySelectorAll('.gym-equip-cb');
  const equipment = [];
  checkboxes.forEach(cb => { if (cb.checked) equipment.push(cb.value); });
  try {
    await api(`/exercises/gym-profiles/${id}`, { method: 'PUT', body: JSON.stringify({ equipment }) });
    showToast('Equipment saved');
    closeModal();
    if (fitnessSubTab === 'today') loadFitnessToday();
  } catch (e) { showToast(e.message); }
}

// Settings menu import — handles multiple files
async function handleFitbodImportFromSettings(input) {
  const resultEl = document.getElementById('sm-fitbod-import-result');
  const files = input.files;
  if (!files.length) return;

  let totalImported = 0, totalUpdated = 0, totalRows = 0;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-dim)';
  resultEl.textContent = `Importing ${files.length} file(s)...`;

  for (const file of files) {
    try {
      const text = await file.text();
      const result = await api('/exercises/import-fitbod', { method: 'POST', body: JSON.stringify({ csv_text: text }) });
      totalImported += result.imported || 0;
      totalUpdated += result.updated || 0;
      totalRows += result.total_rows || 0;
    } catch (e) {
      resultEl.style.color = 'var(--red)';
      resultEl.textContent = `Error in ${file.name}: ${e.message}`;
      input.value = '';
      return;
    }
  }

  resultEl.style.color = 'var(--green)';
  resultEl.textContent = `✓ ${totalRows} rows processed: ${totalImported} new exercises, ${totalUpdated} enriched`;
  input.value = '';
  showToast(`Imported ${totalImported} exercises, enriched ${totalUpdated}`);
}

// Gym profile modal import (legacy — kept for backward compat)
async function importFitbodFile(input) {
  const file = input.files[0];
  if (!file) return;
  const text = await file.text();
  await doFitbodImport(text);
}

async function importFitbodPaste() {
  const text = document.getElementById('fitbod-csv-paste')?.value;
  if (!text || !text.trim()) return showToast('Paste CSV text first');
  await doFitbodImport(text);
}

async function doFitbodImport(csvText) {
  const resultEl = document.getElementById('fitbod-import-result');
  if (resultEl) resultEl.innerHTML = '<span style="color:var(--text-dim)">Importing...</span>';
  try {
    const result = await api('/exercises/import-fitbod', { method: 'POST', body: JSON.stringify({ csv_text: csvText }) });
    const msg = `✓ Found ${result.total_unique} exercises: ${result.imported} new, ${result.already_existed} already in library`;
    if (resultEl) resultEl.innerHTML = `<span style="color:#10b981">${msg}</span>`;
    showToast(msg);
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:#ef4444">Error: ${e.message}</span>`;
    showToast(e.message);
  }
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
    loadFitness();
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
  try { await api(`/training/plans/${id}`, { method: 'DELETE' }); closeModal(); if (fitnessSubTab === 'coaching') loadFitnessCoaching(); else loadFitness(); }
  catch (e) { showToast(e.message); }
}

// ── Coaching Sessions ──
async function loadCoachingSessions() {
  const container = document.getElementById('coaching-list') || document.getElementById('training-content');
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
      <div class="form-group"><label>Date</label><input type="date" name="session_date" value="${s.session_date ? s.session_date.slice(0,10) : localDateStr()}"></div>
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
    if (fitnessSubTab === 'coaching') loadFitnessCoaching(); else loadFitness();
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
  try { await api(`/training/coaching/${id}`, { method: 'DELETE' }); closeModal(); if (fitnessSubTab === 'coaching') loadFitnessCoaching(); else loadFitness(); }
  catch (e) { showToast(e.message); }
}

// ── Injuries ──
async function loadInjuries() {
  const container = document.getElementById('coaching-list') || document.getElementById('training-content');
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
      <div class="form-group"><label>Additional Notes</label><textarea name="notes" rows="2" placeholder="Any other notes...">${esc(inj.notes || '')}</textarea></div>
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
    notes: f.get('notes') || null,
    tags: f.get('tags') ? f.get('tags').split(',').map(t => t.trim()).filter(Boolean) : [],
  };
  try {
    if (id) await api(`/training/injuries/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/training/injuries', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    if (fitnessSubTab === 'coaching') loadFitnessCoaching(); else loadFitness();
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
    await api(`/training/injuries/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'resolved', resolved_date: localDateStr() }) });
    closeModal();
    if (fitnessSubTab === 'coaching') loadFitnessCoaching(); else loadFitness();
  } catch (e) { showToast(e.message); }
}

async function deleteInjury(id) {
  if (!confirm('Delete this injury record?')) return;
  try { await api(`/training/injuries/${id}`, { method: 'DELETE' }); closeModal(); if (fitnessSubTab === 'coaching') loadFitnessCoaching(); else loadFitness(); }
  catch (e) { showToast(e.message); }
}

// ── Training Day View ──
let trainingDayDate = localDateStr();

async function loadTrainingDay() {
  const container = document.getElementById('training-content');
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <button class="btn-action" onclick="trainingDayDate=shiftDate(trainingDayDate,-1);loadTrainingDay()">&larr;</button>
      <input type="date" value="${trainingDayDate}" onchange="trainingDayDate=this.value;loadTrainingDay()" style="flex:1;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);text-align:center">
      <button class="btn-action" onclick="trainingDayDate=shiftDate(trainingDayDate,1);loadTrainingDay()">&rarr;</button>
      <button class="btn-action" onclick="trainingDayDate=localDateStr();loadTrainingDay()">Today</button>
    </div>
    <div id="day-view-content"><div class="loading">Loading...</div></div>
  `;

  try {
    const data = await api(`/training/day/${trainingDayDate}`);
    const dv = document.getElementById('day-view-content');
    const dateLabel = new Date(trainingDayDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    let html = `<h3 style="color:var(--accent);margin-bottom:12px">${dateLabel}</h3>`;

    // Daily Plan + Plan vs Actual
    if (data.daily_plan) {
      const dp = data.daily_plan;
      const isRest = dp.status === 'rest';
      const statusColors = { planned: '#3b82f6', completed: '#22c55e', partial: '#f59e0b', missed: '#ef4444', rest: '#6366f1', amended: '#8b5cf6' };
      const statusColor = statusColors[dp.status] || '#6366f1';

      html += `<div class="card" style="border-left:3px solid ${statusColor};margin-bottom:12px;padding:10px 14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim)">Daily Plan</div>
          <span style="font-size:0.65rem;background:${statusColor}22;color:${statusColor};padding:1px 8px;border-radius:10px;font-weight:600">${dp.status}</span>
        </div>
        ${isRest ? '<div style="font-weight:700;color:#6366f1">Rest Day</div>' : `
          <div style="font-weight:700">${dp.workout_type ? esc(dp.workout_type) : 'Workout'}${dp.workout_focus ? ' — ' + esc(dp.workout_focus) : ''}</div>
          ${dp.target_effort ? `<div style="font-size:0.8rem;color:#10b981">Target Effort: ${dp.target_effort}/10${dp.target_duration_min ? ' · ' + dp.target_duration_min + ' min' : ''}</div>` : ''}
        `}
        ${dp.workout_notes ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:4px">${esc(dp.workout_notes)}</div>` : ''}
        ${dp.target_calories || dp.target_protein_g ? `<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:0.78rem;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
          ${dp.target_calories ? `<span><strong>Calories:</strong> ${dp.target_calories}</span>` : ''}
          ${dp.target_protein_g ? `<span><strong>Protein:</strong> ${dp.target_protein_g}g</span>` : ''}
          ${dp.target_carbs_g ? `<span><strong>Carbs:</strong> ${dp.target_carbs_g}g</span>` : ''}
          ${dp.target_fat_g ? `<span><strong>Fat:</strong> ${dp.target_fat_g}g</span>` : ''}
          ${dp.target_hydration_liters ? `<span><strong>Water:</strong> ${dp.target_hydration_liters}L</span>` : ''}
        </div>` : ''}
        ${dp.target_sleep_hours ? `<div style="font-size:0.78rem;margin-top:4px"><strong>Sleep target:</strong> ${dp.target_sleep_hours}h</div>` : ''}
        ${dp.coaching_notes ? `<div style="font-size:0.75rem;color:var(--text-dim);margin-top:4px;font-style:italic">${esc(dp.coaching_notes)}</div>` : ''}
      </div>`;

      // Plan vs Actual comparison (if there's any actual data)
      const hasActual = data.workouts?.length || data.meals?.length || data.nutrition_context;
      if (hasActual && !isRest) {
        const maxEffort = Math.max(0, ...(data.workouts || []).map(w => w.effort || 0));
        const totalCal = (data.meals || []).reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
        const totalProtein = (data.meals || []).reduce((s, m) => s + (parseFloat(m.protein_g) || 0), 0);
        const nc = data.nutrition_context || {};

        const rows = [];
        if (dp.target_effort) {
          const pct = Math.min(100, Math.round((maxEffort / dp.target_effort) * 100));
          rows.push({ label: 'Effort', actual: maxEffort || '—', target: dp.target_effort, pct, color: '#10b981' });
        }
        if (dp.target_calories) {
          const pct = Math.min(100, Math.round((totalCal / parseFloat(dp.target_calories)) * 100));
          rows.push({ label: 'Calories', actual: Math.round(totalCal) || '—', target: dp.target_calories, pct, color: '#f59e0b' });
        }
        if (dp.target_protein_g) {
          const pct = Math.min(100, Math.round((totalProtein / parseFloat(dp.target_protein_g)) * 100));
          rows.push({ label: 'Protein', actual: Math.round(totalProtein) + 'g' || '—', target: dp.target_protein_g + 'g', pct, color: '#f59e0b' });
        }
        if (dp.target_hydration_liters && nc.hydration_liters) {
          const pct = Math.min(100, Math.round((parseFloat(nc.hydration_liters) / parseFloat(dp.target_hydration_liters)) * 100));
          rows.push({ label: 'Water', actual: nc.hydration_liters + 'L', target: dp.target_hydration_liters + 'L', pct, color: '#06b6d4' });
        }
        if (dp.target_sleep_hours && nc.sleep_hours) {
          const pct = Math.min(100, Math.round((parseFloat(nc.sleep_hours) / parseFloat(dp.target_sleep_hours)) * 100));
          rows.push({ label: 'Sleep', actual: nc.sleep_hours + 'h', target: dp.target_sleep_hours + 'h', pct, color: '#6366f1' });
        }

        if (rows.length) {
          html += `<div class="card" style="margin-bottom:12px;padding:10px 14px">
            <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px">Plan vs Actual</div>
            ${rows.map(r => `<div style="margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-bottom:2px">
                <span style="color:var(--text-dim)">${r.label}</span>
                <span><strong style="color:${r.color}">${r.actual}</strong> / ${r.target}</span>
              </div>
              <div style="height:4px;border-radius:2px;background:var(--border);overflow:hidden">
                <div style="height:100%;width:${r.pct}%;background:${r.color};border-radius:2px;transition:width 0.3s"></div>
              </div>
            </div>`).join('')}
          </div>`;
        }
      }
    }

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

    // Sleep & Context
    if (data.nutrition_context) {
      const nc = data.nutrition_context;
      if (nc.sleep_hours || nc.hydration_liters) {
        html += `<div class="card" style="border-left:3px solid #6366f1;margin-bottom:12px;padding:10px 14px">
          <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Sleep & Context</div>
          <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:0.8rem">
            ${nc.sleep_hours ? `<span><strong>Sleep:</strong> ${nc.sleep_hours}h</span>` : ''}
            ${nc.sleep_quality ? `<span><strong>Quality:</strong> ${nc.sleep_quality}/10</span>` : ''}
            ${nc.hydration_liters ? `<span><strong>Water:</strong> ${nc.hydration_liters}L</span>` : ''}
          </div>
          ${nc.notes ? `<div style="font-size:0.8rem;color:var(--text-dim);margin-top:4px">${esc(nc.notes)}</div>` : ''}
        </div>`;
      }
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
  return d.toLocaleDateString('en-CA');
}

// ── Daily Plan Manager ──
function showDailyPlanDetail(id) {
  openModal('Daily Plan', `<div class="loading">Loading...</div>`);
  api(`/daily-plans/${id}`).then(plan => {
    const sc = { planned: '#3b82f6', completed: '#22c55e', partial: '#f59e0b', missed: '#ef4444', rest: '#6366f1', amended: '#8b5cf6' };
    const color = sc[plan.status] || '#6366f1';
    const dateLabel = new Date(plan.plan_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    let html = `<div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <h3 style="margin:0;color:var(--accent)">${dateLabel}</h3>
        <span style="font-size:0.7rem;background:${color}22;color:${color};padding:2px 10px;border-radius:12px;font-weight:600">${plan.status}</span>
      </div>
    </div>`;

    if (plan.status === 'rest') {
      html += '<div style="font-size:1rem;font-weight:700;color:#6366f1;margin-bottom:12px">Rest Day</div>';
    } else {
      html += `<div class="card" style="padding:10px 14px;margin-bottom:12px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Workout</div>
        <div style="font-weight:700">${plan.workout_type || '—'}${plan.workout_focus ? ' — ' + esc(plan.workout_focus) : ''}</div>
        ${plan.target_effort ? `<div style="color:#10b981;font-size:0.85rem">Target Effort: ${plan.target_effort}/10</div>` : ''}
        ${plan.target_duration_min ? `<div style="color:var(--text-dim);font-size:0.8rem">Duration: ${plan.target_duration_min} min</div>` : ''}
        ${plan.workout_notes ? `<div style="color:var(--text-dim);font-size:0.8rem;margin-top:4px">${esc(plan.workout_notes)}</div>` : ''}
      </div>`;
    }

    if (plan.target_calories || plan.target_protein_g || plan.target_hydration_liters) {
      html += `<div class="card" style="padding:10px 14px;margin-bottom:12px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Nutrition Targets</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:0.85rem">
          ${plan.target_calories ? `<span><strong>Calories:</strong> ${plan.target_calories}</span>` : ''}
          ${plan.target_protein_g ? `<span><strong>Protein:</strong> ${plan.target_protein_g}g</span>` : ''}
          ${plan.target_carbs_g ? `<span><strong>Carbs:</strong> ${plan.target_carbs_g}g</span>` : ''}
          ${plan.target_fat_g ? `<span><strong>Fat:</strong> ${plan.target_fat_g}g</span>` : ''}
          ${plan.target_hydration_liters ? `<span><strong>Water:</strong> ${plan.target_hydration_liters}L</span>` : ''}
        </div>
      </div>`;
    }

    if (plan.target_sleep_hours) {
      html += `<div class="card" style="padding:10px 14px;margin-bottom:12px">
        <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">Recovery Target</div>
        <div style="font-size:0.85rem"><strong>Sleep:</strong> ${plan.target_sleep_hours}h</div>
      </div>`;
    }

    if (plan.coaching_notes || plan.rationale) {
      html += `<div class="card" style="padding:10px 14px;margin-bottom:12px">
        ${plan.rationale ? `<div style="font-size:0.85rem;margin-bottom:4px"><strong>Rationale:</strong> ${esc(plan.rationale)}</div>` : ''}
        ${plan.coaching_notes ? `<div style="font-size:0.85rem;color:var(--text-dim);font-style:italic">${esc(plan.coaching_notes)}</div>` : ''}
      </div>`;
    }

    html += `<div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn-action" style="flex:1" onclick="editDailyPlan('${plan.id}')">Edit Plan</button>
      <button class="btn-action" style="flex:1;background:var(--red);color:white" onclick="if(confirm('Delete this plan?'))deleteDailyPlan('${plan.id}')">Delete</button>
    </div>`;

    document.getElementById('modal-body').innerHTML = html;
  }).catch(e => {
    document.getElementById('modal-body').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
  });
}

function showCreateDailyPlanForm(prefillDate) {
  const date = prefillDate || localDateStr();
  openModal('Create Plan', `
    <form onsubmit="return saveDailyPlan(event)">
      <label>Date *</label>
      <input type="date" name="plan_date" value="${date}" required style="width:100%">
      <label>Title</label>
      <input type="text" name="title" placeholder="e.g. Hill Sprint Day, Recovery / Mobility" style="width:100%">
      <label>Goal</label>
      <input type="text" name="goal" placeholder="e.g. Build carry endurance under fatigue" style="width:100%">
      <label>Status</label>
      <select name="status" style="width:100%">
        <option value="planned">Planned</option>
        <option value="rest">Rest Day</option>
      </select>
      <label>Workout Type</label>
      <input type="text" name="workout_type" placeholder="e.g. strength, run, hill, hybrid" style="width:100%">
      <label>Workout Focus</label>
      <input type="text" name="workout_focus" placeholder="e.g. upper push, grip, zone 2" style="width:100%">
      <label>Target Effort (1-10)</label>
      <input type="number" name="target_effort" min="1" max="10" placeholder="7" style="width:100%">
      <label>Target Duration (min)</label>
      <input type="number" name="target_duration_min" placeholder="60" style="width:100%">
      <label>Target Calories</label>
      <input type="number" name="target_calories" placeholder="2400" style="width:100%">
      <label>Target Protein (g)</label>
      <input type="number" name="target_protein_g" placeholder="150" style="width:100%">
      <label>Target Hydration (L)</label>
      <input type="number" name="target_hydration_liters" step="0.1" placeholder="2.5" style="width:100%">
      <label>Target Sleep (h)</label>
      <input type="number" name="target_sleep_hours" step="0.5" placeholder="7" style="width:100%">
      <label>Workout Notes</label>
      <textarea name="workout_notes" rows="2" style="width:100%" placeholder="Any workout-specific notes"></textarea>
      <label>Coaching Notes</label>
      <textarea name="coaching_notes" rows="2" style="width:100%" placeholder="Context or rationale"></textarea>
      <button type="submit" class="btn-action" style="width:100%;margin-top:12px">Create Plan</button>
    </form>
  `);
}

async function saveDailyPlan(event) {
  event.preventDefault();
  const form = event.target;
  const body = {};
  for (const el of form.elements) {
    if (el.name && el.value) {
      body[el.name] = el.type === 'number' ? parseFloat(el.value) : el.value;
    }
  }
  try {
    await api('/daily-plans', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    showToast('Daily plan created', 'success');
    if (fitnessSubTab === 'today') loadFitnessToday();
    else if (typeof loadUnifiedPlans === 'function') loadUnifiedPlans();
    loadGamification();
  } catch (e) {
    showToast(e.message, 'error');
  }
  return false;
}

async function editDailyPlan(id) {
  try {
    const plan = await api(`/daily-plans/${id}`);
    closeModal();
    openModal('Edit Plan', `
      <form onsubmit="return updateDailyPlan(event, '${id}')">
        <label>Date</label>
        <input type="date" name="plan_date" value="${plan.plan_date?.slice(0, 10)}" style="width:100%" disabled>
        <label>Title</label>
        <input type="text" name="title" value="${esc(plan.title || '')}" style="width:100%">
        <label>Goal</label>
        <input type="text" name="goal" value="${esc(plan.goal || '')}" style="width:100%">
        <label>Status</label>
        <select name="status" style="width:100%">
          ${['planned', 'completed', 'partial', 'missed', 'rest', 'amended'].map(s => `<option value="${s}" ${plan.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <label>Workout Type</label>
        <input type="text" name="workout_type" value="${plan.workout_type || ''}" style="width:100%">
        <label>Workout Focus</label>
        <input type="text" name="workout_focus" value="${plan.workout_focus || ''}" style="width:100%">
        <label>Target Effort (1-10)</label>
        <input type="number" name="target_effort" min="1" max="10" value="${plan.target_effort || ''}" style="width:100%">
        <label>Target Duration (min)</label>
        <input type="number" name="target_duration_min" value="${plan.target_duration_min || ''}" style="width:100%">
        <label>Target Calories</label>
        <input type="number" name="target_calories" value="${plan.target_calories || ''}" style="width:100%">
        <label>Target Protein (g)</label>
        <input type="number" name="target_protein_g" value="${plan.target_protein_g || ''}" style="width:100%">
        <label>Target Hydration (L)</label>
        <input type="number" name="target_hydration_liters" step="0.1" value="${plan.target_hydration_liters || ''}" style="width:100%">
        <label>Target Sleep (h)</label>
        <input type="number" name="target_sleep_hours" step="0.5" value="${plan.target_sleep_hours || ''}" style="width:100%">
        <label>Workout Notes</label>
        <textarea name="workout_notes" rows="2" style="width:100%">${plan.workout_notes || ''}</textarea>
        <label>Coaching Notes</label>
        <textarea name="coaching_notes" rows="2" style="width:100%">${plan.coaching_notes || ''}</textarea>
        <button type="submit" class="btn-action" style="width:100%;margin-top:12px">Save Changes</button>
        <button type="button" class="btn-action" style="width:100%;margin-top:8px;background:#ef444422;color:#ef4444" onclick="if(confirm('Delete this plan?'))deleteDailyPlan('${id}')">Delete Plan</button>
      </form>
    `);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function updateDailyPlan(event, id) {
  event.preventDefault();
  const form = event.target;
  const body = {};
  for (const el of form.elements) {
    if (el.name && el.value && !el.disabled) {
      body[el.name] = el.type === 'number' ? parseFloat(el.value) : el.value;
    }
  }
  try {
    await api(`/daily-plans/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    closeModal();
    showToast('Plan updated', 'success');
    if (fitnessSubTab === 'today') loadFitnessToday();
    else if (typeof loadUnifiedPlans === 'function') loadUnifiedPlans();
    loadGamification();
  } catch (e) {
    showToast(e.message, 'error');
  }
  return false;
}

async function deleteDailyPlan(id) {
  try {
    await api(`/daily-plans/${id}`, { method: 'DELETE' });
    closeModal();
    showToast('Plan deleted', 'success');
    if (typeof loadUnifiedPlans === 'function') loadUnifiedPlans();
    if (typeof loadFitnessToday === 'function') loadFitnessToday();
    loadGamification();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// (Progress photos section removed)

// ─── Utilities ────────────────────────────────────────────────
function esc(str) { if(!str)return''; const d=document.createElement('div'); d.textContent=String(str); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function formatBeeSummary(text) {
  if (!text) return '';
  return esc(text)
    .replace(/^# (.+)$/gm, '<div style="font-weight:700;font-size:0.9rem;margin-top:12px;margin-bottom:4px;color:var(--accent)">$1</div>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:2px 0">• $1</div>')
    .replace(/\n/g, '<br>');
}
function timeAgo(dateStr) {
  if(!dateStr)return'';
  const diff=(new Date()-new Date(dateStr))/1000;
  if(diff<60)return'just now'; if(diff<3600)return`${Math.floor(diff/60)}m ago`;
  if(diff<86400)return`${Math.floor(diff/3600)}h ago`; if(diff<604800)return`${Math.floor(diff/86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ─── Quick Action FAB ─────────────────────────────────────────
let _fabOpen = false;
function toggleFab() {
  _fabOpen = !_fabOpen;
  const btn = document.getElementById('fab-btn');
  const menu = document.getElementById('fab-menu');
  if (btn) btn.classList.toggle('open', _fabOpen);
  if (menu) menu.classList.toggle('open', _fabOpen);
}

function showFab() {
  const fab = document.getElementById('fab-container');
  if (fab) { fab.style.display = ''; renderIcons(); }
}
function hideFab() {
  const fab = document.getElementById('fab-container');
  if (fab) fab.style.display = 'none';
  _fabOpen = false;
}

function fabAction(type) {
  toggleFab(); // close menu
  switch (type) {
    case 'task':
      switchTab('tasks');
      setTimeout(() => { if (typeof showTaskForm === 'function') showTaskForm(); }, 300);
      break;
    case 'workout':
      fitnessSubTab = 'log';
      switchTab('fitness');
      setTimeout(() => { if (typeof showWorkoutForm === 'function') showWorkoutForm(); }, 300);
      break;
    case 'meal':
      fitnessSubTab = 'log';
      switchTab('fitness');
      setTimeout(() => { if (typeof showMealForm === 'function') showMealForm(); }, 300);
      break;
    case 'weight':
      fitnessSubTab = 'log';
      switchTab('fitness');
      setTimeout(() => { if (typeof showBodyMetricForm === 'function') showBodyMetricForm(); }, 300);
      break;
  }
}

// Close FAB when clicking outside
document.addEventListener('click', e => {
  if (_fabOpen && !e.target.closest('.fab-container')) toggleFab();
});

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
