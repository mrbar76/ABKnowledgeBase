// --- AB Knowledge Base Frontend ---

const API = '/api';
let currentView = 'dashboard';
let currentCategory = '';
let currentSource = '';

// --- Auth ---
function getStoredKey() {
  return sessionStorage.getItem('ab_api_key') || localStorage.getItem('ab_api_key') || '';
}

function showLogin(message) {
  document.getElementById('login-screen').style.display = 'flex';
  document.querySelector('.bottom-nav').style.display = 'none';
  document.querySelector('.app-header').style.display = 'none';
  document.querySelector('.views-container').style.display = 'none';
  if (message) {
    document.getElementById('login-error').textContent = message;
    document.getElementById('login-error').style.display = 'block';
  }
}

function hideLogin() {
  document.getElementById('login-screen').style.display = 'none';
  document.querySelector('.bottom-nav').style.display = '';
  document.querySelector('.app-header').style.display = '';
  document.querySelector('.views-container').style.display = '';
}

async function doLogin(e) {
  if (e) e.preventDefault();
  const key = document.getElementById('login-key').value.trim();
  if (!key) return;

  // Test the key
  try {
    const res = await fetch(API + '/dashboard', {
      headers: { 'X-Api-Key': key }
    });
    if (res.status === 401) {
      document.getElementById('login-error').textContent = 'Invalid API key. Try again.';
      document.getElementById('login-error').style.display = 'block';
      return;
    }
    // Key works — store it
    const remember = document.getElementById('login-remember').checked;
    sessionStorage.setItem('ab_api_key', key);
    if (remember) localStorage.setItem('ab_api_key', key);
    hideLogin();
    loadDashboard();
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

// --- Navigation ---
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view);
  });
});

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-view="${view}"]`).classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');

  if (view === 'dashboard') loadDashboard();
  else if (view === 'kanban') loadKanban();
  else if (view === 'knowledge') loadKnowledge();
  else if (view === 'facts') loadFacts();
  else if (view === 'transcripts') loadTranscripts();
  else if (view === 'projects') loadProjects();
}

// --- API helpers ---
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

// --- Dashboard ---
async function loadDashboard() {
  const data = await api('/dashboard');
  loadBeeStatus();

  const totalTasks = Object.values(data.tasks.by_status).reduce((a, b) => a + b, 0);
  const inProgress = data.tasks.by_status.in_progress || 0;
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
      <div class="stat-label">Transcripts</div>
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

  // Task status chart
  const statusColors = { todo: '#8b8fa3', in_progress: '#3b82f6', review: '#eab308', done: '#22c55e' };
  const maxStatus = Math.max(...Object.values(data.tasks.by_status), 1);
  document.getElementById('chart-tasks-status').innerHTML = Object.entries(data.tasks.by_status)
    .map(([status, count]) => `
      <div class="chart-bar-row">
        <span class="chart-bar-label">${status.replace('_', ' ')}</span>
        <div class="chart-bar-track">
          <div class="chart-bar-fill" style="width:${(count/maxStatus)*100}%;background:${statusColors[status]}">${count}</div>
        </div>
      </div>
    `).join('') || '<div class="empty-state">No tasks yet</div>';

  // Knowledge by source chart
  const sourceColors = { claude: '#a855f7', gemini: '#06b6d4', chatgpt: '#22c55e', bee: '#eab308', manual: '#8b8fa3' };
  const maxSource = Math.max(...data.knowledge.by_ai_source.map(s => s.count), 1);
  document.getElementById('chart-knowledge-source').innerHTML = data.knowledge.by_ai_source
    .map(s => `
      <div class="chart-bar-row">
        <span class="chart-bar-label">${s.ai_source || 'unknown'}</span>
        <div class="chart-bar-track">
          <div class="chart-bar-fill" style="width:${(s.count/maxSource)*100}%;background:${sourceColors[s.ai_source] || '#6366f1'}">${s.count}</div>
        </div>
      </div>
    `).join('') || '<div class="empty-state">No AI-sourced knowledge yet</div>';

  // Tasks by agent chart
  const maxAgent = Math.max(...data.tasks.by_agent.map(a => a.count), 1);
  document.getElementById('chart-tasks-agent').innerHTML = data.tasks.by_agent
    .map(a => `
      <div class="chart-bar-row">
        <span class="chart-bar-label">${a.ai_agent}</span>
        <div class="chart-bar-track">
          <div class="chart-bar-fill" style="width:${(a.count/maxAgent)*100}%;background:${sourceColors[a.ai_agent] || '#6366f1'}">${a.count}</div>
        </div>
      </div>
    `).join('') || '<div class="empty-state">No agent tasks yet</div>';

  // Recent activity
  document.getElementById('recent-activity').innerHTML = data.recent_activity.length
    ? data.recent_activity.map(a => renderActivityItem(a)).join('')
    : '<div class="empty-state">No activity yet</div>';

  // Load sync status
  loadSyncStatus();
}

// --- Sync Status ---
async function loadSyncStatus() {
  try {
    const data = await api('/sync-status');
    renderSyncSources(data.sources);
    renderSyncJobs(data.recent_jobs);
  } catch (e) {
    document.getElementById('sync-status-panel').innerHTML = '<div class="empty-state">Could not load sync status</div>';
  }
}

function renderSyncSources(sources) {
  if (!sources || !sources.length) {
    document.getElementById('sync-status-panel').innerHTML = '<div class="empty-state">No sync sources configured</div>';
    return;
  }

  const stateColors = { idle: 'var(--green, #22c55e)', syncing: 'var(--blue, #3b82f6)', error: 'var(--red, #ef4444)' };
  const stateLabels = { idle: 'Idle', syncing: 'Syncing...', error: 'Error' };

  document.getElementById('sync-status-panel').innerHTML = sources.map(s => {
    const color = stateColors[s.state] || '#8b8fa3';
    const label = stateLabels[s.state] || s.state;
    const lastSync = s.last_sync ? timeAgo(s.last_sync) : 'Never';
    const cronBadge = s.cron_enabled
      ? `<span style="font-size:0.7rem;background:var(--bg-input);padding:2px 6px;border-radius:10px;margin-left:6px">Cron: ${s.cron_interval_min || '?'}min</span>`
      : '';

    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border, #333)">
        <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0;${s.state === 'syncing' ? 'animation:pulse 1.5s infinite' : ''}"></span>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.9rem;font-weight:600">${esc(s.label)}${cronBadge}</div>
          <div style="font-size:0.75rem;color:var(--text-dim)">
            ${label} &middot; Last sync: ${lastSync}
            ${s.items_imported > 0 ? ` &middot; ${s.items_imported} imported` : ''}
            ${s.total_errors > 0 ? ` &middot; <span style="color:var(--red)">${s.total_errors} errors</span>` : ''}
          </div>
          ${s.error_message ? `<div style="font-size:0.7rem;color:var(--red);margin-top:2px">${esc(s.error_message)}</div>` : ''}
        </div>
        <span style="font-size:0.75rem;color:var(--text-dim)">${s.total_syncs} syncs</span>
      </div>
    `;
  }).join('');
}

function renderSyncJobs(jobs) {
  if (!jobs || !jobs.length) {
    document.getElementById('sync-job-history').innerHTML = '<div class="empty-state">No sync jobs yet</div>';
    return;
  }

  const stateIcons = { completed: '\u2705', failed: '\u274C', running: '\u23F3' };

  document.getElementById('sync-job-history').innerHTML = jobs.slice(0, 10).map(j => {
    const icon = stateIcons[j.state] || '\u2022';
    const dur = j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '...';
    const time = j.started_at ? timeAgo(j.started_at) : '';

    return `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border, #333);font-size:0.8rem">
        <span>${icon}</span>
        <div style="flex:1;min-width:0">
          <div>${esc(j.description)}</div>
          <div style="color:var(--text-dim);font-size:0.7rem">
            ${time} &middot; ${dur}
            ${j.items_imported > 0 ? ` &middot; ${j.items_imported} imported` : ''}
            ${j.items_skipped > 0 ? ` &middot; ${j.items_skipped} skipped` : ''}
          </div>
          ${j.errors.length > 0 ? `<div style="color:var(--red);font-size:0.7rem">${esc(j.errors[0])}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// --- Kanban ---
async function loadKanban() {
  const projectFilter = document.getElementById('kanban-project-filter').value;
  const q = projectFilter ? `?project_id=${projectFilter}` : '';
  const data = await api(`/tasks/kanban${q}`);

  const projects = await api('/projects');
  const select = document.getElementById('kanban-project-filter');
  const currentVal = select.value;
  select.innerHTML = '<option value="">All Projects</option>' +
    projects.projects.map(p => `<option value="${p.id}" ${p.id === currentVal ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  for (const status of ['todo', 'in_progress', 'review', 'done']) {
    const cards = data[status] || [];
    document.getElementById(`count-${status}`).textContent = cards.length;
    document.getElementById(`kanban-${status}`).innerHTML = cards.length
      ? cards.map(t => renderKanbanCard(t)).join('')
      : '<div class="empty-state">No tasks</div>';
  }
}

document.getElementById('kanban-project-filter').addEventListener('change', loadKanban);

function renderKanbanCard(task) {
  const agentClass = task.ai_agent ? `agent-${task.ai_agent}` : '';
  return `
    <div class="kanban-card" onclick="openTaskDetail('${task.id}')">
      <div class="card-title">${esc(task.title)}</div>
      <div class="card-meta">
        <span class="badge priority-${task.priority}">${task.priority}</span>
        ${task.ai_agent ? `<span class="badge ${agentClass}">${task.ai_agent}</span>` : ''}
        ${task.project_name ? `<span>${esc(task.project_name)}</span>` : ''}
      </div>
      ${task.next_steps ? `<div style="font-size:0.72rem;color:var(--text-dim);margin-top:6px">Next: ${esc(task.next_steps.substring(0, 80))}${task.next_steps.length > 80 ? '...' : ''}</div>` : ''}
    </div>
  `;
}

// --- Knowledge ---
async function loadKnowledge() {
  try {
    const params = new URLSearchParams();
    if (currentCategory) params.set('category', currentCategory);
    if (currentSource) params.set('ai_source', currentSource);
    const q = params.toString() ? `?${params}` : '';
    const data = await api(`/knowledge${q}`);

    // Source filter chips
    const sources = ['claude', 'chatgpt', 'gemini', 'bee-sync'];
    document.getElementById('source-chips').innerHTML =
      `<span class="chip ${!currentSource ? 'active' : ''}" onclick="filterSource('')">All Sources</span>` +
      sources.map(s => `<span class="chip source-${s} ${currentSource === s ? 'active' : ''}" onclick="filterSource('${s}')">${s}</span>`).join('');

    try {
      const cats = await api('/knowledge/meta/categories');
      if (Array.isArray(cats)) {
        document.getElementById('category-chips').innerHTML =
          `<span class="chip ${!currentCategory ? 'active' : ''}" onclick="filterCategory('')">All</span>` +
          cats.map(c => `<span class="chip ${currentCategory === c ? 'active' : ''}" onclick="filterCategory('${esc(c)}')">${esc(c)}</span>`).join('');
      }
    } catch (e) { /* no categories yet */ }

    document.getElementById('knowledge-list').innerHTML = data.entries && data.entries.length
      ? data.entries.map(renderKnowledgeItem).join('')
      : `<div class="empty-state"><div class="empty-icon">&#128218;</div>${currentSource ? `No entries from ${currentSource} yet.` : 'No knowledge entries yet.<br>Add some via the API or the + button.'}</div>`;
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      document.getElementById('knowledge-list').innerHTML = '<div class="empty-state">Failed to load entries. Check connection.</div>';
    }
  }
}

function filterCategory(cat) {
  currentCategory = cat;
  loadKnowledge();
}

function filterSource(source) {
  currentSource = source;
  loadKnowledge();
}

async function searchKnowledge() {
  const q = document.getElementById('knowledge-search').value.trim();
  if (!q) return loadKnowledge();
  try {
    const data = await api(`/knowledge?q=${encodeURIComponent(q)}`);
    document.getElementById('knowledge-list').innerHTML = data.entries && data.entries.length
      ? data.entries.map(renderKnowledgeItem).join('')
      : '<div class="empty-state">No results found</div>';
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      document.getElementById('knowledge-list').innerHTML = '<div class="empty-state">Search failed. Try again.</div>';
    }
  }
}

document.getElementById('knowledge-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchKnowledge();
});

function renderKnowledgeItem(entry) {
  const typeClass = `type-${entry.category || 'general'}`;
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  return `
    <div class="knowledge-item ${typeClass}" onclick="openKnowledgeDetail('${entry.id}')">
      <div class="k-title">
        ${entry.ai_source ? `<span class="k-source-badge source-${entry.ai_source}">${entry.ai_source}</span>` : ''}
        ${esc(entry.title)}
      </div>
      <div class="k-preview">${esc(entry.content)}</div>
      <div class="k-meta">
        <span>${entry.category}</span>
        <span>${timeAgo(entry.updated_at)}</span>
      </div>
      ${tags.length ? `<div class="k-tags">${tags.map(t => `<span class="k-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
  `;
}

// --- Facts ---
let currentFactCategory = '';

async function loadFacts() {
  try {
    const params = new URLSearchParams();
    if (currentFactCategory) params.set('category', currentFactCategory);
    const q = params.toString() ? `?${params}` : '';
    const data = await api(`/facts${q}`);

    const categories = ['personal', 'preference', 'health', 'work', 'relationship', 'financial', 'general'];
    document.getElementById('facts-category-chips').innerHTML =
      `<span class="chip ${!currentFactCategory ? 'active' : ''}" onclick="filterFactCategory('')">All</span>` +
      categories.map(c => `<span class="chip ${currentFactCategory === c ? 'active' : ''}" onclick="filterFactCategory('${c}')">${c}</span>`).join('');

    document.getElementById('facts-list').innerHTML = data.facts && data.facts.length
      ? data.facts.map(renderFactItem).join('')
      : '<div class="empty-state">No facts yet. Import conversations or sync from Bee.</div>';
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      document.getElementById('facts-list').innerHTML = '<div class="empty-state">Failed to load facts.</div>';
    }
  }
}

function filterFactCategory(cat) {
  currentFactCategory = cat;
  loadFacts();
}

async function searchFacts() {
  const q = document.getElementById('facts-search').value.trim();
  if (!q) return loadFacts();
  try {
    const data = await api(`/facts?q=${encodeURIComponent(q)}`);
    document.getElementById('facts-list').innerHTML = data.facts && data.facts.length
      ? data.facts.map(renderFactItem).join('')
      : '<div class="empty-state">No results found</div>';
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      document.getElementById('facts-list').innerHTML = '<div class="empty-state">Search failed.</div>';
    }
  }
}

document.getElementById('facts-search')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') searchFacts();
});

function renderFactItem(fact) {
  const confirmed = fact.confirmed ? '<span style="color:var(--green);font-size:0.75rem">confirmed</span>' : '<span style="color:var(--yellow);font-size:0.75rem">unconfirmed</span>';
  const tags = Array.isArray(fact.tags) ? fact.tags : [];
  return `
    <div class="knowledge-item" style="border-left:3px solid ${fact.confirmed ? 'var(--green)' : 'var(--yellow)'}">
      <div class="k-title">${esc(fact.title)}</div>
      <div class="k-preview">${esc(fact.content)}</div>
      <div class="k-meta">
        <span>${fact.category}</span>
        ${confirmed}
        <span>${fact.source}</span>
        <span>${timeAgo(fact.created_at)}</span>
      </div>
      ${tags.length ? `<div class="k-tags">${tags.map(t => `<span class="k-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
  `;
}

// --- Transcripts ---
async function loadTranscripts() {
  const data = await api('/transcripts');
  document.getElementById('transcript-list').innerHTML = data.transcripts.length
    ? data.transcripts.map(renderTranscriptItem).join('')
    : '<div class="empty-state"><div class="empty-icon">&#127908;</div>No transcripts yet.<br>Upload via Bee.computer webhook or the + button.</div>';
}

async function searchTranscripts() {
  const q = document.getElementById('transcript-search').value.trim();
  if (!q) return loadTranscripts();
  const data = await api(`/transcripts?q=${encodeURIComponent(q)}`);
  document.getElementById('transcript-list').innerHTML = data.transcripts.length
    ? data.transcripts.map(renderTranscriptItem).join('')
    : '<div class="empty-state">No results found</div>';
}

document.getElementById('transcript-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchTranscripts();
});

function renderTranscriptItem(t) {
  return `
    <div class="knowledge-item type-transcript" onclick="openTranscriptDetail('${t.id}')">
      <div class="k-title">${esc(t.title)}</div>
      <div class="k-preview">${esc(t.summary || t.preview || '')}</div>
      <div class="k-meta">
        <span>${t.source || 'bee'}</span>
        ${t.duration_seconds ? `<span>${Math.round(t.duration_seconds / 60)}min</span>` : ''}
        <span>${timeAgo(t.recorded_at || t.created_at)}</span>
        ${t.location ? `<span>${esc(t.location)}</span>` : ''}
      </div>
    </div>
  `;
}

function openTranscriptModal() {
  openModal('Upload Transcript', `
    <form onsubmit="createTranscript(event)">
      <div class="form-group"><label>Title</label><input name="title" placeholder="Auto-generated if blank"></div>
      <div class="form-group"><label>Raw Text</label><textarea name="raw_text" required style="min-height:200px" placeholder="Paste transcript text here..."></textarea></div>
      <div class="form-group"><label>Summary</label><textarea name="summary" placeholder="Optional summary"></textarea></div>
      <div class="form-group"><label>Source</label>
        <select name="source">
          <option value="bee">Bee.computer</option>
          <option value="manual">Manual</option>
          <option value="zoom">Zoom</option>
          <option value="meet">Google Meet</option>
          <option value="teams">Teams</option>
        </select>
      </div>
      <div class="form-group"><label>Tags (comma-separated)</label><input name="tags" placeholder="meeting, client, standup"></div>
      <button type="submit" class="btn-submit">Upload Transcript</button>
    </form>
  `);
}

async function createTranscript(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  const tags = form.get('tags') ? form.get('tags').split(',').map(t => t.trim()).filter(Boolean) : [];
  await api('/transcripts', {
    method: 'POST',
    body: JSON.stringify({
      title: form.get('title') || null,
      raw_text: form.get('raw_text'),
      summary: form.get('summary') || null,
      source: form.get('source'),
      tags,
      recorded_at: new Date().toISOString()
    })
  });
  closeModal();
  loadTranscripts();
}

async function openTranscriptDetail(id) {
  const t = await api(`/transcripts/${id}`);
  const tags = Array.isArray(t.tags) ? t.tags : [];
  const messages = parseTranscriptToMessages(t.raw_text || '');
  const hasSpeakers = messages.some(m => m.speaker);
  const speakerLabels = Array.isArray(t.speaker_labels) ? t.speaker_labels : [];

  // Determine which speaker is "you" (the user wearing the Bee)
  // Heuristic: the speaker with the most utterances is typically the wearer
  const mySpeaker = detectMySpeaker(messages, speakerLabels);

  const chatHtml = hasSpeakers && messages.length > 1
    ? renderChatBubbles(messages, mySpeaker, id)
    : `<div style="background:var(--bg-input);padding:10px;border-radius:6px;font-size:0.82rem;max-height:400px;overflow-y:auto;white-space:pre-wrap">${esc(t.raw_text)}</div>`;

  openModal('Transcript', `
    <div style="margin-bottom:12px">
      <strong>${esc(t.title)}</strong>
      <div style="font-size:0.75rem;color:var(--text-dim);margin-top:4px">
        ${t.source || 'bee'} &middot; ${t.recorded_at ? new Date(t.recorded_at).toLocaleString() : 'Unknown date'}
        ${t.duration_seconds ? ` &middot; ${Math.round(t.duration_seconds / 60)} minutes` : ''}
        ${t.location ? ` &middot; ${esc(t.location)}` : ''}
      </div>
      ${tags.length ? `<div class="k-tags" style="margin-top:6px">${tags.map(tg => `<span class="k-tag">${esc(tg)}</span>`).join('')}</div>` : ''}
    </div>
    ${t.summary ? `<div class="form-group"><label>Summary</label><div style="background:var(--bg-input);padding:10px;border-radius:6px;font-size:0.85rem">${esc(t.summary)}</div></div>` : ''}
    <div class="form-group">
      <label>${hasSpeakers ? 'Conversation' : 'Full Transcript'}</label>
      ${chatHtml}
    </div>
    ${hasSpeakers ? `<span class="chat-raw-toggle" onclick="toggleRawText('${id}')">Show raw text</span><div id="raw-text-${id}" style="display:none;background:var(--bg-input);padding:10px;border-radius:6px;font-size:0.82rem;max-height:300px;overflow-y:auto;white-space:pre-wrap;margin-top:8px">${esc(t.raw_text)}</div>` : ''}
    <button type="button" class="btn-submit btn-danger" style="margin-top:12px" onclick="deleteTranscript('${id}')">Delete Transcript</button>
  `);
}

function toggleRawText(id) {
  const el = document.getElementById(`raw-text-${id}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function parseTranscriptToMessages(rawText) {
  if (!rawText) return [];
  return rawText.split('\n').filter(l => l.trim()).map(line => {
    // Format: [HH:MM:SS AM] Speaker: text  OR  Speaker: text
    const match = line.match(/^(?:\[([^\]]+)\]\s*)?(.+?):\s(.+)$/);
    if (!match) return { speaker: null, time: null, text: line.trim() };
    return { time: match[1] || null, speaker: match[2].trim(), text: match[3].trim() };
  });
}

function detectMySpeaker(messages, speakerLabels) {
  // If speaker_labels has a "me" or "self" marker, use that
  const meLabel = speakerLabels.find(s => s.is_me || s.is_self || s.role === 'self');
  if (meLabel) return meLabel.name || meLabel.speaker || meLabel.label;

  // Heuristic: the speaker with the most utterances is likely the Bee wearer
  const counts = {};
  for (const m of messages) {
    if (m.speaker) counts[m.speaker] = (counts[m.speaker] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : null;
}

function renderChatBubbles(messages, mySpeaker, transcriptId) {
  let lastSpeaker = null;
  const html = messages.map(m => {
    if (!m.speaker && !m.text) return '';
    const isSelf = m.speaker === mySpeaker;
    const showSpeaker = m.speaker !== lastSpeaker;
    lastSpeaker = m.speaker;

    return `<div class="chat-bubble-row ${isSelf ? 'is-self' : 'is-other'}">
      ${showSpeaker && m.speaker ? `<div class="chat-speaker">${esc(m.speaker)}</div>` : ''}
      <div class="chat-bubble">${esc(m.text)}</div>
      ${m.time ? `<div class="chat-timestamp">${esc(m.time)}</div>` : ''}
    </div>`;
  }).join('');

  return `<div class="chat-transcript">${html}</div>`;
}

async function deleteTranscript(id) {
  if (!confirm('Delete this transcript?')) return;
  await api(`/transcripts/${id}`, { method: 'DELETE' });
  closeModal();
  loadTranscripts();
}

// --- Projects ---
async function loadProjects() {
  const data = await api('/projects');
  document.getElementById('projects-list').innerHTML = data.projects.length
    ? data.projects.map(renderProjectCard).join('')
    : '<div class="empty-state"><div class="empty-icon">&#128194;</div>No projects yet.<br>Create one with the + button.</div>';
}

function renderProjectCard(project) {
  const tc = project.task_counts;
  const total = (tc.todo || 0) + (tc.in_progress || 0) + (tc.review || 0) + (tc.done || 0);
  const donePercent = total ? ((tc.done || 0) / total * 100) : 0;

  return `
    <div class="project-card" onclick="openProjectDetail('${project.id}')">
      <div class="p-name">${esc(project.name)}</div>
      ${project.description ? `<div class="p-desc">${esc(project.description)}</div>` : ''}
      <div class="p-progress">
        <div class="p-stat"><span class="status-dot todo"></span> ${tc.todo || 0}</div>
        <div class="p-stat"><span class="status-dot in_progress"></span> ${tc.in_progress || 0}</div>
        <div class="p-stat"><span class="status-dot review"></span> ${tc.review || 0}</div>
        <div class="p-stat"><span class="status-dot done"></span> ${tc.done || 0}</div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${donePercent}%"></div></div>
    </div>
  `;
}

// --- Activity (shown in dashboard) ---
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

// --- Modals ---
function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// Task modal
function openTaskModal() {
  openModal('New Task', `
    <form onsubmit="createTask(event)">
      <div class="form-group"><label>Title</label><input name="title" required></div>
      <div class="form-group"><label>Description</label><textarea name="description"></textarea></div>
      <div class="form-group"><label>Project</label><select name="project_id" id="task-project-select"><option value="">None</option></select></div>
      <div class="form-group"><label>Priority</label>
        <select name="priority">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>
      <div class="form-group"><label>AI Agent</label>
        <select name="ai_agent">
          <option value="">None</option>
          <option value="claude">Claude</option>
          <option value="gemini">Gemini</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="bee">Bee</option>
        </select>
      </div>
      <div class="form-group"><label>Next Steps</label><textarea name="next_steps"></textarea></div>
      <button type="submit" class="btn-submit">Create Task</button>
    </form>
  `);

  api('/projects').then(data => {
    const sel = document.getElementById('task-project-select');
    if (sel) {
      sel.innerHTML = '<option value="">None</option>' +
        data.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    }
  });
}

async function createTask(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: form.get('title'),
      description: form.get('description'),
      project_id: form.get('project_id') || null,
      priority: form.get('priority'),
      ai_agent: form.get('ai_agent') || null,
      next_steps: form.get('next_steps') || null
    })
  });
  closeModal();
  loadKanban();
}

async function openTaskDetail(id) {
  const task = await api(`/tasks/${id}`);
  openModal('Edit Task', `
    <form onsubmit="updateTask(event, '${id}')">
      <div class="form-group"><label>Title</label><input name="title" value="${esc(task.title)}" required></div>
      <div class="form-group"><label>Description</label><textarea name="description">${esc(task.description || '')}</textarea></div>
      <div class="form-group"><label>Status</label>
        <select name="status">
          ${['todo','in_progress','review','done'].map(s => `<option value="${s}" ${task.status === s ? 'selected' : ''}>${s.replace('_',' ')}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Priority</label>
        <select name="priority">
          ${['low','medium','high','urgent'].map(p => `<option value="${p}" ${task.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>AI Agent</label>
        <select name="ai_agent">
          <option value="">None</option>
          ${['claude','gemini','chatgpt','bee'].map(a => `<option value="${a}" ${task.ai_agent === a ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Next Steps</label><textarea name="next_steps">${esc(task.next_steps || '')}</textarea></div>
      <div class="form-group"><label>Output Log</label><textarea name="output_log">${esc(task.output_log || '')}</textarea></div>
      <button type="submit" class="btn-submit">Update Task</button>
      <button type="button" class="btn-submit btn-danger" onclick="deleteTask('${id}')">Delete Task</button>
    </form>
  `);
}

async function updateTask(e, id) {
  e.preventDefault();
  const form = new FormData(e.target);
  await api(`/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: form.get('title'),
      description: form.get('description'),
      status: form.get('status'),
      priority: form.get('priority'),
      ai_agent: form.get('ai_agent') || null,
      next_steps: form.get('next_steps') || null,
      output_log: form.get('output_log') || null
    })
  });
  closeModal();
  if (currentView === 'kanban') loadKanban();
  else if (currentView === 'dashboard') loadDashboard();
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  await api(`/tasks/${id}`, { method: 'DELETE' });
  closeModal();
  if (currentView === 'kanban') loadKanban();
  else if (currentView === 'dashboard') loadDashboard();
}

// Knowledge modal
function openKnowledgeModal() {
  openModal('Add Knowledge', `
    <form onsubmit="createKnowledge(event)">
      <div class="form-group"><label>Title</label><input name="title" required></div>
      <div class="form-group"><label>Content</label><textarea name="content" required style="min-height:150px"></textarea></div>
      <div class="form-group"><label>Category</label>
        <select name="category">
          <option value="general">General</option>
          <option value="transcript">Transcript</option>
          <option value="meeting">Meeting</option>
          <option value="code">Code</option>
          <option value="research">Research</option>
          <option value="decision">Decision</option>
          <option value="reference">Reference</option>
          <option value="health">Health</option>
          <option value="personal">Personal</option>
        </select>
      </div>
      <div class="form-group"><label>Tags (comma-separated)</label><input name="tags" placeholder="tag1, tag2, tag3"></div>
      <div class="form-group"><label>AI Source</label>
        <select name="ai_source">
          <option value="">Manual</option>
          <option value="claude">Claude</option>
          <option value="gemini">Gemini</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="bee">Bee</option>
        </select>
      </div>
      <button type="submit" class="btn-submit">Store Knowledge</button>
    </form>
  `);
}

async function createKnowledge(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  const tags = form.get('tags') ? form.get('tags').split(',').map(t => t.trim()).filter(Boolean) : [];
  await api('/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      title: form.get('title'),
      content: form.get('content'),
      category: form.get('category'),
      tags,
      ai_source: form.get('ai_source') || null
    })
  });
  closeModal();
  loadKnowledge();
}

async function openKnowledgeDetail(id) {
  const entry = await api(`/knowledge/${id}`);
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  openModal('Knowledge Entry', `
    <form onsubmit="updateKnowledge(event, '${id}')">
      <div class="form-group"><label>Title</label><input name="title" value="${esc(entry.title)}" required></div>
      <div class="form-group"><label>Content</label><textarea name="content" required style="min-height:200px">${esc(entry.content)}</textarea></div>
      <div class="form-group"><label>Category</label>
        <select name="category">
          ${['general','transcript','meeting','code','research','decision','reference','health','personal'].map(c => `<option value="${c}" ${entry.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Tags (comma-separated)</label><input name="tags" value="${esc(tags.join(', '))}"></div>
      <div class="form-group"><label>AI Source</label>
        <select name="ai_source">
          <option value="">Manual</option>
          ${['claude','gemini','chatgpt','bee'].map(a => `<option value="${a}" ${entry.ai_source === a ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:14px">
        Created: ${new Date(entry.created_at).toLocaleString()} &middot; Updated: ${new Date(entry.updated_at).toLocaleString()}
        ${entry.source ? ` &middot; Source: ${entry.source}` : ''}
      </div>
      <button type="submit" class="btn-submit">Update</button>
      <button type="button" class="btn-submit btn-danger" onclick="deleteKnowledge('${id}')">Delete</button>
    </form>
  `);
}

async function updateKnowledge(e, id) {
  e.preventDefault();
  const form = new FormData(e.target);
  const tags = form.get('tags') ? form.get('tags').split(',').map(t => t.trim()).filter(Boolean) : [];
  await api(`/knowledge/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: form.get('title'),
      content: form.get('content'),
      category: form.get('category'),
      tags,
      ai_source: form.get('ai_source') || null
    })
  });
  closeModal();
  loadKnowledge();
}

async function deleteKnowledge(id) {
  if (!confirm('Delete this knowledge entry?')) return;
  await api(`/knowledge/${id}`, { method: 'DELETE' });
  closeModal();
  loadKnowledge();
}

// Project modal
function openProjectModal() {
  openModal('New Project', `
    <form onsubmit="createProject(event)">
      <div class="form-group"><label>Name</label><input name="name" required></div>
      <div class="form-group"><label>Description</label><textarea name="description"></textarea></div>
      <button type="submit" class="btn-submit">Create Project</button>
    </form>
  `);
}

async function createProject(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: form.get('name'),
      description: form.get('description')
    })
  });
  closeModal();
  loadProjects();
}

async function openProjectDetail(id) {
  const project = await api(`/projects/${id}`);
  openModal('Edit Project', `
    <form onsubmit="updateProject(event, '${id}')">
      <div class="form-group"><label>Name</label><input name="name" value="${esc(project.name)}" required></div>
      <div class="form-group"><label>Description</label><textarea name="description">${esc(project.description || '')}</textarea></div>
      <div class="form-group"><label>Status</label>
        <select name="status">
          ${['active','paused','completed','archived'].map(s => `<option value="${s}" ${project.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <button type="submit" class="btn-submit">Update Project</button>
      <button type="button" class="btn-submit btn-danger" onclick="deleteProject('${id}')">Delete Project</button>
    </form>
  `);
}

async function updateProject(e, id) {
  e.preventDefault();
  const form = new FormData(e.target);
  await api(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: form.get('name'),
      description: form.get('description'),
      status: form.get('status')
    })
  });
  closeModal();
  loadProjects();
}

async function deleteProject(id) {
  if (!confirm('Delete this project and unlink its tasks?')) return;
  await api(`/projects/${id}`, { method: 'DELETE' });
  closeModal();
  loadProjects();
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

  // Read and merge all conversations from all files
  let allConversations = [];
  for (const file of files) {
    try {
      const data = await readFileAsJSON(file);
      const convs = Array.isArray(data) ? data : (data.conversations || [data]);
      allConversations = allConversations.concat(convs);
      updateImportLog(`Loaded ${file.name} (${convs.length} conversations). Total so far: ${allConversations.length}`);
    } catch (err) {
      updateImportLog(`Error reading ${err.message}`, true);
    }
  }

  if (allConversations.length) {
    updateImportLog(`Starting import of ${allConversations.length} conversations from ${files.length} file(s)...`);
    await runImport(allConversations, source);
  }
}

function updateImportLog(text, isError) {
  const log = document.getElementById('import-log');
  const status = document.getElementById('import-status');
  status.style.display = 'block';
  log.innerHTML = `<span style="color:${isError ? 'var(--red)' : 'var(--text-dim)'}">${esc(text)}</span>`;
}

function updateImportProgress(pct) {
  document.getElementById('import-progress-fill').style.width = pct + '%';
}

async function runImport(data, source) {
  const conversations = Array.isArray(data) ? data : (data.conversations || [data]);

  if (!conversations.length) {
    updateImportLog('No conversations found in file', true);
    return;
  }

  const distill = document.getElementById('import-distill')?.checked || false;
  updateImportLog(`Found ${conversations.length} conversations. Importing${distill ? ' + distilling' : ''}...`);
  updateImportProgress(0);

  let imported = 0, skipped = 0, failed = 0;
  let distilled = { facts: 0, decisions: 0, tasks: 0 };

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const title = conv.title || conv.name || `${source} Conversation ${i + 1}`;
    let content = '';

    if (source === 'chatgpt') {
      content = extractChatGPT(conv);
    } else if (source === 'claude') {
      content = extractClaude(conv);
    } else {
      content = JSON.stringify(conv, null, 2);
    }

    if (!content || content.trim().length < 20) {
      skipped++;
      updateImportProgress(((i + 1) / conversations.length) * 100);
      continue;
    }

    // Preserve original conversation date
    const originalDate = conv.create_time ? new Date(conv.create_time * 1000).toISOString()
      : conv.created_at ? new Date(conv.created_at).toISOString()
      : conv.updated_at ? new Date(conv.updated_at).toISOString() : null;

    const aiSource = source === 'chatgpt' ? 'chatgpt' : source === 'claude' ? 'claude' : source;

    try {
      // Store as transcript (not knowledge)
      await api('/transcripts', {
        method: 'POST',
        body: JSON.stringify({
          title,
          raw_text: content.substring(0, 50000),
          summary: content.substring(0, 2000),
          source: aiSource,
          tags: [`${source}-import`, 'conversation'],
          recorded_at: originalDate,
          metadata: {
            original_id: conv.id || null,
          }
        })
      });

      // Optionally distill facts/decisions/tasks from the conversation
      if (distill) {
        try {
          const d = await api('/intake/distill', {
            method: 'POST',
            body: JSON.stringify({
              title,
              content: content.substring(0, 15000),
              source: aiSource,
              created_at: originalDate,
            })
          });
          if (d.extracted) {
            distilled.facts += d.extracted.facts || 0;
            distilled.decisions += d.extracted.decisions || 0;
            distilled.tasks += d.extracted.tasks || 0;
          }
        } catch (e) { /* distill is best-effort */ }
      }

      imported++;
    } catch (err) {
      failed++;
    }

    updateImportProgress(((i + 1) / conversations.length) * 100);
    let statusText = `Importing... ${imported} done, ${skipped} skipped, ${failed} failed (${i + 1}/${conversations.length})`;
    if (distill && (distilled.facts || distilled.decisions || distilled.tasks)) {
      statusText += ` | Distilled: ${distilled.facts} facts, ${distilled.decisions} decisions, ${distilled.tasks} tasks`;
    }
    updateImportLog(statusText);

    // Small pause every 5 to avoid overwhelming the API (more calls now with distill)
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 200));
  }

  updateImportProgress(100);
  let doneText = `Done! Imported ${imported} conversations as transcripts. ${skipped} skipped, ${failed} failed.`;
  if (distill && (distilled.facts || distilled.decisions || distilled.tasks)) {
    doneText += ` Distilled: ${distilled.facts} facts, ${distilled.decisions} decisions, ${distilled.tasks} tasks.`;
  }
  updateImportLog(doneText);

  // Notify server of import completion for sync status tracking
  try {
    await api('/sync-status/import-complete', {
      method: 'POST',
      body: JSON.stringify({ source, imported, skipped, failed, total: conversations.length }),
    });
  } catch (e) { /* non-critical */ }
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
    if (msg.content.parts) {
      text = msg.content.parts.filter(p => typeof p === 'string').join('\n');
    } else if (msg.content.text) {
      text = msg.content.text;
    }
    if (text.trim()) {
      parts.push(`**${role === 'user' ? 'You' : 'ChatGPT'}:** ${text.trim()}`);
    }
  }
  return parts.join('\n\n---\n\n');
}

function extractClaude(conv) {
  // Claude export format: array of chat_messages with sender and text
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

function autoCategory(title, content) {
  const lower = (title + ' ' + content.substring(0, 500)).toLowerCase();
  if (lower.includes('code') || lower.includes('function') || lower.includes('bug') || lower.includes('error') || lower.includes('api') || lower.includes('javascript') || lower.includes('python')) return 'code';
  if (lower.includes('meeting') || lower.includes('agenda') || lower.includes('standup')) return 'meeting';
  if (lower.includes('research') || lower.includes('study') || lower.includes('paper') || lower.includes('analysis')) return 'research';
  if (lower.includes('idea') || lower.includes('brainstorm') || lower.includes('plan') || lower.includes('strategy')) return 'decision';
  return 'general';
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

// Keyboard shortcut: Ctrl+K or Cmd+K
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === 'Escape' && document.getElementById('search-overlay').classList.contains('open')) {
    closeGlobalSearch();
  }
});

document.getElementById('global-search-input').addEventListener('input', e => {
  clearTimeout(searchDebounceTimer);
  const q = e.target.value.trim();
  if (!q) {
    document.getElementById('search-results').innerHTML = '';
    return;
  }
  if (q.length < 2) return;
  searchDebounceTimer = setTimeout(() => runGlobalSearch(q), 300);
});

document.getElementById('global-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    clearTimeout(searchDebounceTimer);
    const q = e.target.value.trim();
    if (q) runGlobalSearch(q);
  }
});

async function runGlobalSearch(q) {
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '<div class="search-loading">Searching...</div>';

  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}`);
    const r = data.results;

    if (data.total === 0) {
      resultsEl.innerHTML = '<div class="search-empty">No results found</div>';
      return;
    }

    let html = '';

    if (r.knowledge.length) {
      html += renderSearchGroup('Knowledge', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z', r.knowledge, item => {
        const badge = item.ai_source ? `<span class="badge source-${item.ai_source}" style="font-size:0.6rem">${item.ai_source}</span>` : '';
        return `<div class="search-result-item" onclick="closeGlobalSearch();openKnowledgeDetail('${item.id}')">
          <div class="search-result-title">${badge} ${esc(item.title)}</div>
          <div class="search-result-preview">${esc(item.preview || '')}</div>
          <div class="search-result-meta"><span>${item.category || ''}</span><span>${timeAgo(item.updated_at)}</span></div>
        </div>`;
      });
    }

    if (r.facts && r.facts.length) {
      html += renderSearchGroup('Facts', 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L19 8l-9 9z', r.facts, item => {
        return `<div class="search-result-item">
          <div class="search-result-title">${esc(item.title)}</div>
          <div class="search-result-preview">${esc(item.content || '')}</div>
          <div class="search-result-meta"><span>${item.category || ''}</span><span>${item.confirmed ? 'confirmed' : 'unconfirmed'}</span><span>${timeAgo(item.created_at)}</span></div>
        </div>`;
      });
    }

    if (r.transcripts.length) {
      html += renderSearchGroup('Transcripts', 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z', r.transcripts, item => {
        return `<div class="search-result-item" onclick="closeGlobalSearch();openTranscriptDetail('${item.id}')">
          <div class="search-result-title">${esc(item.title)}</div>
          <div class="search-result-preview">${esc(item.preview || '')}</div>
          <div class="search-result-meta">
            <span>${item.source || 'bee'}</span>
            ${item.duration_seconds ? `<span>${Math.round(item.duration_seconds / 60)}min</span>` : ''}
            <span>${timeAgo(item.recorded_at)}</span>
          </div>
        </div>`;
      });
    }

    if (r.tasks.length) {
      html += renderSearchGroup('Tasks', 'M4 4h4v16H4V4zm6 0h4v12h-4V4zm6 0h4v8h-4V4z', r.tasks, item => {
        return `<div class="search-result-item" onclick="closeGlobalSearch();openTaskDetail('${item.id}')">
          <div class="search-result-title">${esc(item.title)}</div>
          ${item.preview ? `<div class="search-result-preview">${esc(item.preview)}</div>` : ''}
          <div class="search-result-meta">
            <span class="badge priority-${item.priority}">${item.priority}</span>
            <span class="badge" style="background:var(--bg-input)">${(item.status || '').replace('_', ' ')}</span>
            ${item.project_name ? `<span>${esc(item.project_name)}</span>` : ''}
          </div>
        </div>`;
      });
    }

    if (r.projects.length) {
      html += renderSearchGroup('Projects', 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z', r.projects, item => {
        return `<div class="search-result-item" onclick="closeGlobalSearch();openProjectDetail('${item.id}')">
          <div class="search-result-title">${esc(item.title)}</div>
          ${item.preview ? `<div class="search-result-preview">${esc(item.preview)}</div>` : ''}
          <div class="search-result-meta"><span>${item.status || ''}</span></div>
        </div>`;
      });
    }

    resultsEl.innerHTML = html;

    // Also try Bee neural search in background if token is configured
    tryBeeNeuralSearch(q, resultsEl);

  } catch (err) {
    resultsEl.innerHTML = `<div class="search-empty">Search failed: ${esc(err.message)}</div>`;
  }
}

function renderSearchGroup(label, iconPath, items, renderItem) {
  return `<div class="search-group-label">
    <svg class="search-type-icon" viewBox="0 0 24 24"><path fill="currentColor" d="${iconPath}"/></svg>
    ${label} (${items.length})
  </div>` + items.map(renderItem).join('');
}

async function tryBeeNeuralSearch(q, resultsEl) {
  try {
    const data = await api('/bee/search', {
      method: 'POST',
      body: JSON.stringify({ query: q, limit: 5 })
    });
    if (data.results && data.results.length > 0) {
      const beeHtml = renderSearchGroup('Bee Neural', 'M12 2a3 3 0 0 0-3 3v1H7a2 2 0 0 0-2 2v2a6 6 0 0 0 3.34 5.37A5.98 5.98 0 0 0 12 22a5.98 5.98 0 0 0 3.66-6.63A6 6 0 0 0 19 10V8a2 2 0 0 0-2-2h-2V5a3 3 0 0 0-3-3z', data.results, item => {
        const onclick = item.local_transcript
          ? `closeGlobalSearch();openTranscriptDetail('${item.local_transcript.id}')`
          : '';
        return `<div class="search-result-item" ${onclick ? `onclick="${onclick}"` : ''} style="${onclick ? '' : 'opacity:0.7;cursor:default'}">
          <div class="search-result-title">${esc(item.title)}</div>
          <div class="search-result-preview">${esc(item.preview || '')}</div>
          <div class="search-result-meta">
            <span class="badge" style="background:rgba(251,191,36,0.15);color:#fbbf24">neural</span>
            ${item.start_time ? `<span>${timeAgo(item.start_time)}</span>` : ''}
            ${item.local_transcript ? '' : '<span>not synced locally</span>'}
          </div>
        </div>`;
      });
      resultsEl.innerHTML += beeHtml;
    }
  } catch (e) {
    // Bee search is optional — silently fail if token not configured
  }
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
  const now = new Date();
  const diff = (now - date) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  return date.toLocaleDateString();
}

// --- Connect AI Prompts ---
const SITE_URL = 'https://ab-brain.up.railway.app';

function getApiKey() {
  return document.getElementById('connect-api-key')?.value?.trim() || getStoredKey() || 'YOUR_API_KEY';
}

function buildPrompt(ai) {
  const key = getApiKey();
  const base = `${SITE_URL}/api`;

  const shared = `API Base: ${base}
Auth: X-Api-Key: ${key}

ENDPOINTS:
- UNIFIED SEARCH:  POST ${base}/search/ai
  Body: {"query":"natural language question","limit":10}
  Returns results from ALL data types (knowledge, transcripts, tasks, projects) sorted by relevance.
  USE THIS FIRST to search across everything.
- Search knowledge: GET ${base}/knowledge?q=SEARCH_TERM
- Get all knowledge: GET ${base}/knowledge
- Save knowledge:  POST ${base}/knowledge
  Body: {"title":"...","content":"...","category":"general","tags":["tag1"],"ai_source":"${ai}"}
- Get tasks:       GET ${base}/tasks
- Create task:     POST ${base}/tasks
  Body: {"title":"...","status":"todo","ai_agent":"${ai}","priority":"medium"}
- Update task:     PUT ${base}/tasks/:id
  Body: {"status":"in_progress","next_steps":"..."}`;

  if (ai === 'claude') {
    return `You have access to my personal knowledge base (AB Brain). Use it to remember things across our conversations.

${shared}

INSTRUCTIONS:
1. At the start of each conversation, search my knowledge base for context relevant to my question.
2. When we reach an important insight, decision, or piece of information worth remembering, save it to my knowledge base.
3. When I ask you to do something, create a task in the task board.
4. Always include ai_source: "claude" when saving knowledge.
5. Categories: general, code, meeting, research, decision, reference, health, personal
6. Keep titles short and descriptive. Content should capture the full context.`;
  }

  if (ai === 'chatgpt') {
    return `You have access to the user's personal knowledge base (AB Brain) via Actions. Use it to remember things across conversations.

The Actions are already configured with the API endpoints. You can call them directly.

INSTRUCTIONS:
1. At the start of each conversation, use the searchKnowledge action to find context relevant to the user's question.
2. When you reach an important insight or decision, use createKnowledge to save it.
3. When the user asks you to do something actionable, use createTask to add it.
4. Always include ai_source: "chatgpt" when saving knowledge.
5. Categories: general, code, meeting, research, decision, reference, health, personal
6. Keep titles short and descriptive. Content should capture the full context.
7. You can also search and create transcripts and manage projects.`;
  }

  // gemini
  return `You have access to the user's personal knowledge base (AB Brain). Use it to remember things across conversations.

${shared}

INSTRUCTIONS:
1. At the start of each conversation, search the knowledge base for context relevant to the user's question.
2. When you reach an important insight or decision, save it to the knowledge base.
3. When the user asks you to do something actionable, create a task.
4. Always include ai_source: "gemini" when saving knowledge.
5. Categories: general, code, meeting, research, decision, reference, health, personal
6. Keep titles short and descriptive. Content should capture the full context.`;
}

function renderPrompts() {
  ['claude', 'chatgpt', 'gemini'].forEach(ai => {
    const el = document.getElementById(`prompt-${ai}`);
    if (el) el.textContent = buildPrompt(ai);
  });
  // Set the OpenAPI spec URL for ChatGPT Actions setup
  const openapiEl = document.getElementById('openapi-url');
  if (openapiEl) openapiEl.textContent = `${SITE_URL}/openapi-chatgpt.json`;
}

function copyPrompt(ai) {
  const text = buildPrompt(ai);
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.style.background = 'var(--green)';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 2000);
  });
}

// Re-render prompts when API key changes
document.getElementById('connect-api-key')?.addEventListener('input', renderPrompts);

// Initial render
renderPrompts();

// --- Bee Import ---
async function loadBeeStatus() {
  try {
    const data = await api('/bee/status');
    const el = document.getElementById('bee-status');
    if (el) {
      const parts = [];
      if (data.facts) parts.push(`${data.facts} facts`);
      if (data.tasks) parts.push(`${data.tasks} todos`);
      if (data.transcripts) parts.push(`${data.transcripts} transcripts`);
      if (data.journals) parts.push(`${data.journals} journals`);
      if (data.daily) parts.push(`${data.daily} daily summaries`);
      const autoSync = data.bee_token_configured ? '<span style="color:var(--green)">Auto-sync active</span>' : '<span style="color:var(--yellow)">Auto-sync off (no BEE_API_TOKEN on Railway)</span>';
      if (parts.length) {
        el.innerHTML = `${autoSync} &mdash; <strong>${parts.join(', ')}</strong>` +
          (data.last_import ? ` &mdash; last sync ${timeAgo(data.last_import)}` : '');
      } else {
        el.innerHTML = autoSync;
      }
    }
  } catch (e) { /* ignore */ }
}

function buildProgressBar(pct) {
  return `<div style="background:var(--bg-card);border-radius:4px;overflow:hidden;height:8px;margin-top:6px"><div style="background:var(--accent);height:100%;width:${Math.min(100, pct)}%;transition:width 0.3s"></div></div>`;
}

function buildProgressText(phase, totals, pct) {
  let txt = `<strong>${phase}</strong>`;
  const parts = [];
  if (totals.facts) parts.push(`${totals.facts} facts`);
  if (totals.todos) parts.push(`${totals.todos} todos`);
  if (totals.conversations) parts.push(`${totals.conversations} convos`);
  if (totals.journals) parts.push(`${totals.journals} journals`);
  if (totals.daily) parts.push(`${totals.daily} daily`);
  if (parts.length) txt += ` — ${parts.join(', ')}`;
  if (pct !== null) txt += ` (${Math.round(pct)}%)`;
  txt += buildProgressBar(pct || 0);
  return txt;
}

async function triggerBeeCloudSync(force = false) {
  const btn = document.getElementById(force ? 'bee-full-sync-btn' : 'bee-sync-btn');
  const resultEl = document.getElementById('bee-import-result');
  const token = document.getElementById('bee-token-input')?.value?.trim();

  if (force && !confirm('This will DELETE all existing Bee data and re-import everything from scratch. Continue?')) return;

  btn.disabled = true;
  resultEl.style.display = 'block';
  resultEl.style.background = 'var(--bg-input)';

  const headers = token ? { 'X-Bee-Token': token } : {};
  const bodyBase = token ? { bee_token: token } : {};
  const totals = { facts: 0, todos: 0, conversations: 0, journals: 0, daily: 0, skipped: 0, errors: [], debugKeys: {} };

  // Track overall progress across 5 phases
  const phaseWeights = { facts: 5, todos: 5, conversations: 70, journals: 10, daily: 10 };
  let completedWeight = 0;

  function overallPct(phaseKey, phasePct) {
    return completedWeight + (phaseWeights[phaseKey] * phasePct / 100);
  }

  try {
    if (force) {
      resultEl.textContent = 'Purging old Bee data...';
      await api('/bee/purge', { method: 'POST', headers });
    }

    // Phase 1: Facts (single call — API returns all facts at once)
    resultEl.innerHTML = buildProgressText('Syncing facts...', totals, overallPct('facts', 0));
    let cursor = null;
    let pageNum = 0;
    do {
      pageNum++;
      const body = { ...bodyBase, type: 'facts', cursor, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.facts += r.imported || 0;
      totals.skipped += r.skipped || 0;
      if (r.debug_keys) totals.debugKeys.facts = r.debug_keys;
      cursor = r.cursor;
      resultEl.innerHTML = buildProgressText(`Syncing facts (page ${pageNum})...`, totals, overallPct('facts', r.done ? 100 : 50));
      if (r.done) break;
    } while (cursor);
    completedWeight += phaseWeights.facts;

    // Phase 2: Todos
    cursor = null; pageNum = 0;
    do {
      pageNum++;
      resultEl.innerHTML = buildProgressText(`Syncing todos (page ${pageNum})...`, totals, overallPct('todos', 0));
      const body = { ...bodyBase, type: 'todos', cursor, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.todos += r.imported || 0;
      totals.skipped += r.skipped || 0;
      if (r.debug_keys) totals.debugKeys.todos = r.debug_keys;
      cursor = r.cursor;
      resultEl.innerHTML = buildProgressText(`Syncing todos (page ${pageNum})...`, totals, overallPct('todos', r.done ? 100 : 50));
      if (r.done) break;
    } while (cursor);
    completedWeight += phaseWeights.todos;

    // Phase 3: Conversations (5 per page — each needs full transcript fetch)
    cursor = null; pageNum = 0;
    let convoSkipReasons = { capturing: 0, duplicate: 0, noId: 0, noText: 0, fetchError: 0 };
    do {
      pageNum++;
      resultEl.innerHTML = buildProgressText(`Syncing conversations (page ${pageNum})...`, totals, overallPct('conversations', 0));
      const body = { ...bodyBase, type: 'conversations', cursor, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.conversations += r.imported || 0;
      totals.skipped += r.skipped || 0;
      if (r.debug_keys && !totals.debugKeys.conversations) totals.debugKeys.conversations = r.debug_keys;
      if (r.date_range) {
        if (!totals.dateRange) totals.dateRange = { earliest: r.date_range.earliest, latest: r.date_range.latest };
        else {
          if (r.date_range.earliest < totals.dateRange.earliest) totals.dateRange.earliest = r.date_range.earliest;
          if (r.date_range.latest > totals.dateRange.latest) totals.dateRange.latest = r.date_range.latest;
        }
      }
      if (r.skip_reasons) {
        for (const [k, v] of Object.entries(r.skip_reasons)) convoSkipReasons[k] = (convoSkipReasons[k] || 0) + v;
      }
      if (r.errors) totals.errors.push(...r.errors);
      cursor = r.cursor;
      // Estimate conversation progress: each page processes ~5, typical user has ~500
      const estPct = Math.min(95, (pageNum * 5 / 600) * 100);
      resultEl.innerHTML = buildProgressText(`Syncing conversations (page ${pageNum})...`, totals, overallPct('conversations', r.done ? 100 : estPct));
      if (r.done) break;
    } while (cursor);
    totals.convoSkipReasons = convoSkipReasons;
    completedWeight += phaseWeights.conversations;

    // Phase 4: Journals
    cursor = null; pageNum = 0;
    do {
      pageNum++;
      resultEl.innerHTML = buildProgressText(`Syncing journals (page ${pageNum})...`, totals, overallPct('journals', 0));
      const body = { ...bodyBase, type: 'journals', cursor, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.journals += r.imported || 0;
      totals.skipped += r.skipped || 0;
      cursor = r.cursor;
      resultEl.innerHTML = buildProgressText(`Syncing journals (page ${pageNum})...`, totals, overallPct('journals', r.done ? 100 : 50));
      if (r.done) break;
    } while (cursor);
    completedWeight += phaseWeights.journals;

    // Phase 5: Daily summaries
    cursor = null; pageNum = 0;
    do {
      pageNum++;
      resultEl.innerHTML = buildProgressText(`Syncing daily summaries (page ${pageNum})...`, totals, overallPct('daily', 0));
      const body = { ...bodyBase, type: 'daily', cursor, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.daily += r.imported || 0;
      totals.skipped += r.skipped || 0;
      cursor = r.cursor;
      resultEl.innerHTML = buildProgressText(`Syncing daily summaries (page ${pageNum})...`, totals, overallPct('daily', r.done ? 100 : 50));
      if (r.done) break;
    } while (cursor);
    completedWeight += phaseWeights.daily;

    showBeeResult(resultEl, { imported: totals });
    loadBeeStatus();
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      resultEl.style.background = 'rgba(239,68,68,0.15)';
      resultEl.innerHTML = `Sync stopped: ${e.message}<br>Progress so far: ${totals.facts} facts, ${totals.todos} todos, ${totals.conversations} convos, ${totals.journals} journals, ${totals.daily} daily`;
    }
  } finally {
    btn.textContent = force ? 'Full Sync (purge & re-import)' : 'Sync Now from Bee Cloud';
    btn.disabled = false;
  }
}

async function triggerBeeIncrementalSync() {
  const btn = document.getElementById('bee-incremental-btn');
  const resultEl = document.getElementById('bee-import-result');
  const token = document.getElementById('bee-token-input')?.value?.trim();

  btn.disabled = true;
  btn.textContent = 'Checking for changes...';
  resultEl.style.display = 'block';
  resultEl.style.background = 'var(--bg-input)';
  resultEl.textContent = 'Fetching changes from Bee...';

  try {
    const body = token ? { bee_token: token } : {};
    const opts = { method: 'POST', body: JSON.stringify(body) };
    if (token) opts.headers = { 'X-Bee-Token': token };
    const data = await api('/bee/sync-incremental', opts);
    const i = data.imported || {};
    resultEl.style.background = 'rgba(34,197,94,0.15)';
    resultEl.innerHTML = `Incremental sync: <strong>${i.facts || 0}</strong> facts, <strong>${i.todos || 0}</strong> todos, <strong>${i.conversations || 0}</strong> conversations updated` +
      (data.changes_processed ? ` (${data.changes_processed} changes processed)` : '') +
      (i.skipped ? ` (${i.skipped} skipped)` : '');
    loadBeeStatus();
  } catch (e) {
    resultEl.style.background = 'rgba(239,68,68,0.15)';
    resultEl.textContent = 'Incremental sync failed: ' + e.message;
  } finally {
    btn.textContent = 'Sync Updates Only';
    btn.disabled = false;
  }
}

async function handleBeeFileUpload(files) {
  const resultEl = document.getElementById('bee-import-result');
  resultEl.style.display = 'block';
  resultEl.style.background = 'var(--bg-input)';
  resultEl.textContent = 'Processing files...';

  const payload = { facts_md: null, todos_md: null, conversations: [] };

  for (const file of files) {
    const text = await file.text();
    const name = file.name.toLowerCase();

    if (name === 'facts.md') {
      payload.facts_md = text;
    } else if (name === 'todos.md') {
      payload.todos_md = text;
    } else if (name.endsWith('.md')) {
      // Treat other .md files as conversations
      payload.conversations.push({ title: file.name.replace('.md', ''), markdown: text });
    } else if (name.endsWith('.json')) {
      // Try to parse as Bee JSON export
      try {
        const json = JSON.parse(text);
        if (json.facts) payload.facts_md = null; // Will use JSON path
        // Post JSON directly
        const data = await api('/bee/import', {
          method: 'POST',
          body: JSON.stringify(json)
        });
        showBeeResult(resultEl, data);
        loadBeeStatus();
        return;
      } catch (e) { /* not valid JSON, skip */ }
    }
  }

  // Send markdown import
  try {
    const data = await api('/bee/import-markdown', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    showBeeResult(resultEl, data);
    loadBeeStatus();
  } catch (e) {
    resultEl.style.background = 'rgba(239,68,68,0.15)';
    resultEl.textContent = 'Import failed: ' + e.message;
  }
}

function showBeeJsonImport() {
  const json = prompt('Paste your Bee JSON data (from bee facts list --json, bee todos list --json, etc.):');
  if (!json) return;

  try {
    const parsed = JSON.parse(json);
    // Wrap in expected format if it's an array
    let payload;
    if (Array.isArray(parsed)) {
      // Guess type from structure
      if (parsed[0]?.text && parsed[0]?.confirmed !== undefined) {
        payload = { facts: parsed };
      } else if (parsed[0]?.text && parsed[0]?.completed !== undefined) {
        payload = { todos: parsed };
      } else {
        payload = { conversations: parsed };
      }
    } else {
      payload = parsed;
    }

    api('/bee/import', { method: 'POST', body: JSON.stringify(payload) }).then(data => {
      const resultEl = document.getElementById('bee-import-result');
      resultEl.style.display = 'block';
      showBeeResult(resultEl, data);
      loadBeeStatus();
    });
  } catch (e) {
    alert('Invalid JSON: ' + e.message);
  }
}

function showBeeResult(el, data) {
  if (data.imported) {
    const i = data.imported;
    el.style.background = 'rgba(34,197,94,0.15)';
    let html = `Imported: <strong>${i.facts || 0}</strong> facts, <strong>${i.todos || 0}</strong> todos, <strong>${i.conversations || 0}</strong> conversations` +
      (i.journals ? `, <strong>${i.journals}</strong> journals` : '') +
      (i.daily ? `, <strong>${i.daily}</strong> daily summaries` : '') +
      (i.skipped ? ` (${i.skipped} duplicates skipped)` : '');
    if (i.totalApiConvos) {
      html += `<br><small style="opacity:0.7">API returned ${i.totalApiConvos} total conversations from Bee</small>`;
    }
    if (i.convoSkipReasons) {
      const sr = i.convoSkipReasons;
      const parts = [];
      if (sr.capturing) parts.push(`${sr.capturing} still capturing`);
      if (sr.duplicate) parts.push(`${sr.duplicate} duplicates`);
      if (sr.noText) parts.push(`${sr.noText} empty`);
      if (sr.fetchError) parts.push(`${sr.fetchError} fetch errors`);
      if (sr.noId) parts.push(`${sr.noId} no ID`);
      if (parts.length) html += `<br><small style="opacity:0.7">Skipped: ${parts.join(', ')}</small>`;
    }
    if (i.errors && i.errors.length) {
      html += `<br><small style="color:#f87171">${i.errors.length} errors</small>`;
    }
    if (i.dateRange) {
      html += `<br><small style="opacity:0.7">Conversation date range: ${new Date(i.dateRange.earliest).toLocaleDateString()} — ${new Date(i.dateRange.latest).toLocaleDateString()}</small>`;
    }
    if (i.debugKeys && Object.keys(i.debugKeys).length) {
      const dk = Object.entries(i.debugKeys).map(([k, v]) => `${k}: [${Array.isArray(v) ? v.join(', ') : v}]`).join('; ');
      html += `<br><small style="opacity:0.5">API response keys: ${dk}</small>`;
    }
    el.innerHTML = html;
  } else {
    el.style.background = 'rgba(239,68,68,0.15)';
    el.textContent = data.error || 'Unknown error';
  }
}

// --- Auto-refresh ---
function refreshCurrentView() {
  if (currentView === 'dashboard') loadDashboard();
  else if (currentView === 'kanban') loadKanban();
  else if (currentView === 'knowledge') loadKnowledge();
  else if (currentView === 'transcripts') loadTranscripts();
  else if (currentView === 'projects') loadProjects();
}

// Refresh when app comes back into focus (tab switch / app switch on iPhone)
let lastRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && getStoredKey()) {
    // Only refresh if it's been at least 30 seconds since last load
    if (Date.now() - lastRefresh > 30000) {
      lastRefresh = Date.now();
      refreshCurrentView();
    }
  }
});

// Pull-to-refresh for mobile PWA
(function initPullToRefresh() {
  let startY = 0;
  let pulling = false;
  const threshold = 80;
  const indicator = document.getElementById('pull-indicator');
  const container = document.querySelector('.views-container');

  container.addEventListener('touchstart', (e) => {
    // Only trigger if scrolled to top
    if (container.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 10 && container.scrollTop <= 0) {
      indicator.style.transform = `translateY(${Math.min(dy * 0.4, threshold) - indicator.offsetHeight}px)`;
    }
  }, { passive: true });

  container.addEventListener('touchend', (e) => {
    if (!pulling) return;
    pulling = false;
    const dy = (e.changedTouches[0]?.clientY || 0) - startY;

    if (dy > threshold && container.scrollTop <= 0 && getStoredKey()) {
      indicator.classList.add('visible');
      indicator.style.transform = '';
      lastRefresh = Date.now();
      refreshCurrentView();
      setTimeout(() => {
        indicator.classList.remove('visible');
      }, 1000);
    } else {
      indicator.style.transform = '';
    }
  }, { passive: true });
})();

// --- Init ---
(async function init() {
  const key = getStoredKey();
  if (!key) {
    showLogin();
    return;
  }
  // Verify the stored key still works
  try {
    const res = await fetch(API + '/health-check');
    // health-check is unauthenticated, so test with dashboard
    const test = await fetch(API + '/dashboard', {
      headers: { 'X-Api-Key': key }
    });
    if (test.status === 401) {
      sessionStorage.removeItem('ab_api_key');
      localStorage.removeItem('ab_api_key');
      showLogin('API key expired or changed. Please log in again.');
      return;
    }
  } catch (e) {
    // Network error — try loading anyway
  }
  hideLogin();
  // Pre-fill the Connect AI key field
  const connectInput = document.getElementById('connect-api-key');
  if (connectInput) connectInput.value = key;
  renderPrompts();
  loadDashboard();
})();
