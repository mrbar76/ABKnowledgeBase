// --- AB Knowledge Base Frontend ---

const API = '/api';
let currentView = 'dashboard';
let currentCategory = '';

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
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  return res.json();
}

// --- Dashboard ---
async function loadDashboard() {
  const data = await api('/dashboard');

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
  const q = currentCategory ? `?category=${encodeURIComponent(currentCategory)}` : '';
  const data = await api(`/knowledge${q}`);

  try {
    const cats = await api('/knowledge/meta/categories');
    if (Array.isArray(cats)) {
      document.getElementById('category-chips').innerHTML =
        `<span class="chip ${!currentCategory ? 'active' : ''}" onclick="filterCategory('')">All</span>` +
        cats.map(c => `<span class="chip ${currentCategory === c ? 'active' : ''}" onclick="filterCategory('${esc(c)}')">${esc(c)}</span>`).join('');
    }
  } catch (e) { /* no categories yet */ }

  document.getElementById('knowledge-list').innerHTML = data.entries.length
    ? data.entries.map(renderKnowledgeItem).join('')
    : '<div class="empty-state"><div class="empty-icon">&#128218;</div>No knowledge entries yet.<br>Add some via the API or the + button.</div>';
}

function filterCategory(cat) {
  currentCategory = cat;
  loadKnowledge();
}

async function searchKnowledge() {
  const q = document.getElementById('knowledge-search').value.trim();
  if (!q) return loadKnowledge();
  const data = await api(`/knowledge?q=${encodeURIComponent(q)}`);
  document.getElementById('knowledge-list').innerHTML = data.entries.length
    ? data.entries.map(renderKnowledgeItem).join('')
    : '<div class="empty-state">No results found</div>';
}

document.getElementById('knowledge-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchKnowledge();
});

function renderKnowledgeItem(entry) {
  const typeClass = `type-${entry.category || 'general'}`;
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  return `
    <div class="knowledge-item ${typeClass}" onclick="openKnowledgeDetail('${entry.id}')">
      <div class="k-title">${esc(entry.title)}</div>
      <div class="k-preview">${esc(entry.content)}</div>
      <div class="k-meta">
        <span>${entry.category}</span>
        ${entry.ai_source ? `<span>via ${entry.ai_source}</span>` : ''}
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

// --- Init ---
loadDashboard();
