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
  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${data.knowledge.total}</div>
      <div class="stat-label">Knowledge Entries</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${data.transcripts.total}</div>
      <div class="stat-label">Transcripts</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalTasks}</div>
      <div class="stat-label">Total Tasks</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${inProgress}</div>
      <div class="stat-label">In Progress</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${data.projects.active}</div>
      <div class="stat-label">Active Projects</div>
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
  openModal('Transcript', `
    <div style="margin-bottom:12px">
      <strong>${esc(t.title)}</strong>
      <div style="font-size:0.75rem;color:var(--text-dim);margin-top:4px">
        ${t.source || 'bee'} &middot; ${t.recorded_at ? new Date(t.recorded_at).toLocaleString() : 'Unknown date'}
        ${t.duration_seconds ? ` &middot; ${Math.round(t.duration_seconds / 60)} minutes` : ''}
      </div>
      ${tags.length ? `<div class="k-tags" style="margin-top:6px">${tags.map(tg => `<span class="k-tag">${esc(tg)}</span>`).join('')}</div>` : ''}
    </div>
    ${t.summary ? `<div class="form-group"><label>Summary</label><div style="background:var(--bg-input);padding:10px;border-radius:6px;font-size:0.85rem">${esc(t.summary)}</div></div>` : ''}
    <div class="form-group">
      <label>Full Transcript</label>
      <div style="background:var(--bg-input);padding:10px;border-radius:6px;font-size:0.82rem;max-height:400px;overflow-y:auto;white-space:pre-wrap">${esc(t.raw_text)}</div>
    </div>
    <button type="button" class="btn-submit btn-danger" onclick="deleteTranscript('${id}')">Delete Transcript</button>
  `);
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
  if (e.dataTransfer.files.length) handleImportFile(e.dataTransfer.files[0]);
});
importFile.addEventListener('change', e => {
  if (e.target.files.length) handleImportFile(e.target.files[0]);
});

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const source = document.getElementById('import-source').value;
      await runImport(data, source);
    } catch (err) {
      updateImportLog(`Error: ${err.message}`, true);
    }
  };
  reader.readAsText(file);
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

  updateImportLog(`Found ${conversations.length} conversations. Importing...`);
  updateImportProgress(0);

  let imported = 0, skipped = 0, failed = 0;

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

    const category = autoCategory(title, content);

    try {
      await api('/knowledge', {
        method: 'POST',
        body: JSON.stringify({
          title,
          content: content.substring(0, 50000),
          category,
          tags: [`${source}-import`, 'conversation'],
          source: `${source}-export`,
          ai_source: source === 'chatgpt' ? 'chatgpt' : source === 'claude' ? 'claude' : source,
          metadata: {
            original_id: conv.id || null,
            created: conv.create_time ? new Date(conv.create_time * 1000).toISOString() : conv.created_at || null,
            message_count: conv.mapping ? Object.keys(conv.mapping).length : null
          }
        })
      });
      imported++;
    } catch (err) {
      failed++;
    }

    updateImportProgress(((i + 1) / conversations.length) * 100);
    updateImportLog(`Importing... ${imported} done, ${skipped} skipped, ${failed} failed (${i + 1}/${conversations.length})`);

    // Small pause every 10 to avoid overwhelming the API
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 100));
  }

  updateImportProgress(100);
  updateImportLog(`Done! Imported ${imported} conversations. ${skipped} skipped, ${failed} failed.`);
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
    return `You have access to the user's personal knowledge base (AB Brain). Use it to remember things across conversations.

${shared}

INSTRUCTIONS:
1. At the start of each conversation, search the knowledge base for context relevant to the user's question.
2. When you reach an important insight or decision, save it to the knowledge base.
3. When the user asks you to do something actionable, create a task.
4. Always include ai_source: "chatgpt" when saving knowledge.
5. Categories: general, code, meeting, research, decision, reference, health, personal
6. Keep titles short and descriptive. Content should capture the full context.`;
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
  const totals = { facts: 0, todos: 0, conversations: 0, skipped: 0, errors: [] };

  try {
    // Purge first if force
    if (force) {
      resultEl.textContent = 'Purging old Bee data...';
      await api('/bee/purge', { method: 'POST', headers });
    }

    // Phase 1: Facts (confirmed)
    let cursor = null;
    let pageNum = 0;
    do {
      pageNum++;
      resultEl.innerHTML = `Syncing confirmed facts (page ${pageNum})... <strong>${totals.facts}</strong> imported so far`;
      const body = { ...bodyBase, type: 'facts', cursor, confirmed: true, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.facts += r.imported || 0;
      totals.skipped += r.skipped || 0;
      cursor = r.cursor;
      if (r.done) break;
    } while (cursor);

    // Phase 2: Facts (unconfirmed)
    cursor = null; pageNum = 0;
    do {
      pageNum++;
      resultEl.innerHTML = `Syncing unconfirmed facts (page ${pageNum})... <strong>${totals.facts}</strong> facts total`;
      const body = { ...bodyBase, type: 'facts', cursor, confirmed: false, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.facts += r.imported || 0;
      totals.skipped += r.skipped || 0;
      cursor = r.cursor;
      if (r.done) break;
    } while (cursor);

    // Phase 3: Todos
    cursor = null; pageNum = 0;
    do {
      pageNum++;
      resultEl.innerHTML = `Syncing todos (page ${pageNum})... <strong>${totals.facts}</strong> facts, <strong>${totals.todos}</strong> todos`;
      const body = { ...bodyBase, type: 'todos', cursor, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.todos += r.imported || 0;
      totals.skipped += r.skipped || 0;
      cursor = r.cursor;
      if (r.done) break;
    } while (cursor);

    // Phase 4: Conversations (slowest — 20 per page with detail fetches)
    cursor = null; pageNum = 0;
    do {
      pageNum++;
      resultEl.innerHTML = `Syncing conversations (page ${pageNum})... <strong>${totals.facts}</strong> facts, <strong>${totals.todos}</strong> todos, <strong>${totals.conversations}</strong> convos`;
      const body = { ...bodyBase, type: 'conversations', cursor, force };
      const r = await api('/bee/sync-chunk', { method: 'POST', body: JSON.stringify(body), headers });
      totals.conversations += r.imported || 0;
      totals.skipped += r.skipped || 0;
      if (r.errors) totals.errors.push(...r.errors);
      cursor = r.cursor;
      if (r.done) break;
    } while (cursor);

    showBeeResult(resultEl, { imported: totals });
    loadBeeStatus();
  } catch (e) {
    if (e.message !== 'Unauthorized') {
      resultEl.style.background = 'rgba(239,68,68,0.15)';
      resultEl.innerHTML = `Sync stopped: ${e.message}<br>Progress so far: ${totals.facts} facts, ${totals.todos} todos, ${totals.conversations} conversations`;
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
    el.innerHTML = `Imported: <strong>${i.facts || 0}</strong> facts, <strong>${i.todos || 0}</strong> todos, <strong>${i.conversations || 0}</strong> conversations` +
      (i.skipped ? ` (${i.skipped} duplicates skipped)` : '');
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
