// --- AB Brain — Full SPA with bottom tabs ---

const API = '/api';
let currentTab = 'home';

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
}

// ─── Dashboard (Home) ─────────────────────────────────────────
async function loadDashboard() {
  const main = document.getElementById('main-content');

  // Always render the full layout — stats get filled async
  main.innerHTML = `
    <div class="stats-grid" id="stats-grid">
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Knowledge</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Transcripts</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Tasks</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">In Progress</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Projects</div></div>
      <div class="stat-card"><div class="stat-value">—</div><div class="stat-label">Facts</div></div>
    </div>

    <div class="card">
      <h2>Bee Wearable Sync</h2>
      <div id="bee-sync-status" style="font-size:0.8rem;color:var(--text-dim);margin-bottom:12px"></div>
      <div class="sync-actions">
        <button class="btn-action" onclick="triggerBeeSync('incremental')" id="btn-sync-updates">Sync Updates</button>
        <button class="btn-action btn-action-secondary" onclick="triggerBeeSync('full')" id="btn-sync-full">Full Sync</button>
      </div>
      <div id="bee-sync-result" style="display:none;margin-top:12px;font-size:0.8rem;padding:10px;border-radius:6px;background:var(--bg-input)"></div>
    </div>

    <div class="card">
      <h2>Sync Status</h2>
      <div id="sync-status-panel"></div>
      <h3 style="font-size:0.85rem;color:var(--text-dim);margin:12px 0 8px">Recent Jobs</h3>
      <div id="sync-job-history"></div>
    </div>

    <div class="card" id="activity-card" style="display:none">
      <h2>Recent Activity</h2>
      <div id="recent-activity"></div>
    </div>

    <div class="card">
      <h2>Settings</h2>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div><div style="font-size:0.85rem;font-weight:600">Backend</div><div style="font-size:0.7rem;color:var(--text-dim)" id="settings-backend">PostgreSQL</div></div>
          <span style="font-size:0.7rem;padding:2px 8px;border-radius:4px;background:rgba(34,197,94,0.15);color:var(--green)" id="settings-health">checking...</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div><div style="font-size:0.85rem;font-weight:600">Bee Token</div><div style="font-size:0.7rem;color:var(--text-dim)" id="settings-bee-token">—</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div><div style="font-size:0.85rem;font-weight:600">OpenAI (Intake)</div><div style="font-size:0.7rem;color:var(--text-dim)" id="settings-openai">—</div></div>
        </div>
        <div style="padding-top:8px">
          <button class="btn-action btn-action-secondary" onclick="logout()" style="width:100%;margin-bottom:8px">Log Out</button>
          <button class="btn-action btn-action-danger" onclick="confirmPurge()" style="width:100%">Clear All Data</button>
        </div>
        <div id="purge-result" style="display:none;margin-top:4px;font-size:0.8rem;padding:10px;border-radius:6px;background:var(--bg-input)"></div>
      </div>
    </div>
  `;

  // Load stats async — doesn't block sync/settings rendering
  loadDashboardStats();
  loadSyncStatus();
  loadBeeStatus();
  loadSettingsInfo();
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
      <div class="stat-card"><div class="stat-value">${data.facts.total}</div><div class="stat-label">Facts</div></div>
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

async function loadSettingsInfo() {
  try {
    const key = getStoredKey();
    const res = await fetch(API + '/health', { headers: key ? { 'X-Api-Key': key } : {} });
    const data = await res.json().catch(() => ({}));
    const hEl = document.getElementById('settings-health');
    if (hEl) { hEl.textContent = res.ok ? 'connected' : 'error'; hEl.style.background = res.ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'; hEl.style.color = res.ok ? 'var(--green)' : 'var(--red)'; }
    const bEl = document.getElementById('settings-backend');
    if (bEl && data.backend) bEl.textContent = data.backend;
  } catch {
    const hEl = document.getElementById('settings-health');
    if (hEl) { hEl.textContent = 'offline'; hEl.style.background = 'rgba(239,68,68,0.15)'; hEl.style.color = 'var(--red)'; }
  }
  try {
    const beeData = await api('/bee/status');
    const btEl = document.getElementById('settings-bee-token');
    if (btEl) btEl.textContent = beeData.bee_token_configured ? 'Configured' : 'Not set (add BEE_API_TOKEN env var)';
    const oaEl = document.getElementById('settings-openai');
    if (oaEl) oaEl.textContent = beeData.openai_configured !== false ? 'Configured' : 'Not set';
  } catch (e) {
    const btEl = document.getElementById('settings-bee-token');
    if (btEl) btEl.textContent = `Error: ${e.message}`;
    const oaEl = document.getElementById('settings-openai');
    if (oaEl) oaEl.textContent = 'Could not check';
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

function showNewTaskModal() {
  openModal('New Task', `
    <form onsubmit="createTask(event)">
      <div class="form-group"><label>Title</label><input type="text" id="new-task-title" required></div>
      <div class="form-group"><label>Description</label><textarea id="new-task-desc" rows="3"></textarea></div>
      <div class="form-group"><label>Priority</label>
        <select id="new-task-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
      </div>
      <button type="submit" class="btn-submit">Create Task</button>
    </form>
  `);
}

async function createTask(e) {
  e.preventDefault();
  try {
    await api('/tasks', { method: 'POST', body: JSON.stringify({
      title: document.getElementById('new-task-title').value,
      description: document.getElementById('new-task-desc').value,
      priority: document.getElementById('new-task-priority').value,
    }) });
    closeModal(); loadKanban();
  } catch (err) { alert(err.message); }
}

// ─── Brain (Knowledge) ────────────────────────────────────────
async function loadBrain(searchQuery) {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}&limit=50` : '?limit=50';
    const data = await api('/knowledge' + qs);

    main.innerHTML = `
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
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
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
async function loadTranscripts(searchQuery) {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const qs = searchQuery ? `?q=${encodeURIComponent(searchQuery)}&limit=50` : '?limit=50';
    const data = await api('/transcripts' + qs);

    main.innerHTML = `
      <input type="text" class="brain-search" placeholder="Search transcripts..." value="${esc(searchQuery || '')}"
        oninput="debounceTranscriptSearch(this.value)" style="margin-bottom:12px">
      <div id="transcript-list">
        ${data.transcripts.length ? data.transcripts.map(t => `
          <div class="list-item" onclick="showTranscriptDetail('${t.id}')">
            <div class="list-item-title">${esc(t.title)}</div>
            <div class="list-item-preview">${esc((t.preview || t.summary || '').substring(0, 150))}</div>
            <div class="list-item-meta">
              <span>${t.source || 'bee'}</span>
              ${t.duration_seconds ? `<span>${Math.round(t.duration_seconds/60)}m</span>` : ''}
              <span>${timeAgo(t.recorded_at || t.created_at)}</span>
            </div>
          </div>`).join('') : '<div class="empty-state">No transcripts yet</div>'}
      </div>
    `;
  } catch (e) { main.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

let transcriptSearchTimer = null;
function debounceTranscriptSearch(q) { clearTimeout(transcriptSearchTimer); transcriptSearchTimer = setTimeout(() => loadTranscripts(q), 300); }

async function showTranscriptDetail(id) {
  try {
    const t = await api(`/transcripts/${id}`);
    let bodyHtml = `
      <div class="list-item-meta" style="margin-bottom:8px">
        <span>${t.source || 'bee'}</span>
        ${t.duration_seconds ? `<span>${Math.round(t.duration_seconds/60)} min</span>` : ''}
        ${t.location ? `<span>${esc(t.location)}</span>` : ''}
        <span>${timeAgo(t.recorded_at || t.created_at)}</span>
      </div>
    `;

    // Show speaker utterances if available
    if (t.speakers && t.speakers.length) {
      bodyHtml += '<div class="transcript-chat">';
      let lastSpeaker = '';
      for (const s of t.speakers) {
        const isNew = s.speaker_name !== lastSpeaker;
        lastSpeaker = s.speaker_name;
        bodyHtml += `
          <div class="chat-bubble">
            ${isNew ? `<div class="chat-speaker">${esc(s.speaker_name)}</div>` : ''}
            <div class="chat-text">${esc(s.text)}</div>
          </div>`;
      }
      bodyHtml += '</div>';
    } else if (t.raw_text) {
      bodyHtml += `<div style="font-size:0.85rem;white-space:pre-wrap;line-height:1.6;max-height:60vh;overflow-y:auto">${esc(t.raw_text)}</div>`;
    } else if (t.summary) {
      bodyHtml += `<div style="font-size:0.85rem">${esc(t.summary)}</div>`;
    }

    bodyHtml += `<div style="margin-top:16px"><button class="btn-action btn-action-danger" onclick="deleteTranscript('${id}')" style="width:100%">Delete</button></div>`;
    openModal(t.title, bodyHtml);
  } catch (e) { openModal('Error', esc(e.message)); }
}

async function deleteTranscript(id) {
  if (!confirm('Delete this transcript?')) return;
  try { await api(`/transcripts/${id}`, { method: 'DELETE' }); closeModal(); loadTranscripts(); } catch {}
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
    openModal(p.name, `
      <div class="list-item-meta" style="margin-bottom:8px"><span class="status-badge status-${p.status}">${p.status}</span><span>${timeAgo(p.created_at)}</span></div>
      ${p.description ? `<div style="font-size:0.85rem;margin-bottom:12px">${esc(p.description)}</div>` : ''}
      <h4 style="font-size:0.85rem;color:var(--text-dim);margin-bottom:8px">Tasks (${tasks.length})</h4>
      ${tasks.length ? tasks.map(t => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:0.82rem">
          <span class="priority-badge priority-${t.priority}">${t.priority[0].toUpperCase()}</span>
          <span style="flex:1">${esc(t.title)}</span>
          <span style="color:var(--text-dim)">${(t.status||'').replace('_',' ')}</span>
        </div>`).join('') : '<div class="empty-state">No tasks</div>'}
      <div style="margin-top:16px"><button class="btn-action btn-action-danger" onclick="deleteProject('${id}')" style="width:100%">Delete Project</button></div>
    `);
  } catch (e) { openModal('Error', esc(e.message)); }
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

// ─── Sync & Bee (reused from dashboard) ───────────────────────
let syncPollTimer = null;

async function triggerBeeSync(mode) {
  const btnUpdates = document.getElementById('btn-sync-updates');
  const btnFull = document.getElementById('btn-sync-full');
  const resultEl = document.getElementById('bee-sync-result');
  if (!btnUpdates) return;

  btnUpdates.disabled = true; btnFull.disabled = true;
  resultEl.style.display = 'block'; resultEl.style.color = 'var(--text-dim)';

  if (mode === 'full') {
    // Chunked sync — process each data type page-by-page (5 records at a time)
    resultEl.textContent = 'Starting chunked sync...';
    const types = ['facts', 'todos', 'conversations', 'journals', 'daily'];
    const totals = { facts: 0, todos: 0, conversations: 0, journals: 0, daily: 0, skipped: 0, errors: [] };

    for (const type of types) {
      let cursor = null;
      let pageNum = 0;
      do {
        pageNum++;
        resultEl.textContent = `Syncing ${type}... (page ${pageNum})`;
        try {
          const data = await api('/bee/sync-chunk', {
            method: 'POST',
            body: JSON.stringify({ type, cursor, force: false })
          });
          totals[type] = (totals[type] || 0) + (data.imported || 0);
          totals.skipped += (data.skipped || 0);
          if (data.errors?.length) totals.errors.push(...data.errors);
          cursor = data.cursor;
          if (data.done || !cursor) break;
        } catch (err) {
          totals.errors.push(`${type}: ${err.message}`);
          break;
        }
      } while (cursor);
    }

    showSyncResult(resultEl, { imported: totals });
    btnUpdates.disabled = false; btnFull.disabled = false;
    loadDashboardStats(); loadBeeStatus();
  } else {
    // Incremental — single request (small payload)
    resultEl.textContent = 'Syncing updates...';
    try {
      const data = await api('/bee/sync-incremental', { method: 'POST', body: JSON.stringify({}) });
      showSyncResult(resultEl, data);
      loadDashboardStats(); loadBeeStatus();
    } catch (err) {
      resultEl.style.color = 'var(--red)';
      resultEl.textContent = `Sync failed: ${err.message}`;
    } finally { btnUpdates.disabled = false; btnFull.disabled = false; }
  }
}

function showSyncResult(el, data) {
  const i = data.imported || {};
  const parts = [];
  if (i.facts) parts.push(`${i.facts} facts`); if (i.todos) parts.push(`${i.todos} tasks`);
  if (i.conversations) parts.push(`${i.conversations} conversations`);
  if (i.journals) parts.push(`${i.journals} journals`); if (i.daily) parts.push(`${i.daily} daily`);
  let msg = parts.length > 0 ? `Imported: ${parts.join(', ')}` : 'No new items';
  if (i.skipped > 0) msg += ` (${i.skipped} skipped)`;
  el.style.color = (i.errors?.length) ? 'var(--yellow)' : 'var(--green)';
  el.textContent = msg;
}

async function loadBeeStatus() {
  try {
    const data = await api('/bee/status');
    const el = document.getElementById('bee-sync-status'); if (!el) return;
    const parts = [];
    if (data.facts > 0) parts.push(`${data.facts} facts`); if (data.tasks > 0) parts.push(`${data.tasks} tasks`);
    if (data.transcripts > 0) parts.push(`${data.transcripts} transcripts`);
    el.textContent = parts.length > 0 ? `Synced: ${parts.join(', ')}` : 'No Bee data synced yet';
    if (!data.bee_token_configured) el.textContent += ' (BEE_API_TOKEN not set)';
  } catch {}
}

async function loadSyncStatus() {
  try {
    const data = await api('/sync-status');
    renderSyncSources(data.sources); renderSyncJobs(data.recent_jobs);
  } catch {}
}

function renderSyncSources(sources) {
  const el = document.getElementById('sync-status-panel'); if (!el || !sources?.length) return;
  const colors = { idle: 'var(--green)', syncing: 'var(--blue)', error: 'var(--red)' };
  el.innerHTML = sources.map(s => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="width:8px;height:8px;border-radius:50%;background:${colors[s.state]||'#8b8fa3'};flex-shrink:0;${s.state==='syncing'?'animation:pulse 1.5s infinite':''}"></span>
      <div style="flex:1"><div style="font-size:0.85rem;font-weight:600">${esc(s.label)}</div>
      <div style="font-size:0.7rem;color:var(--text-dim)">${s.state} &middot; Last: ${s.last_sync?timeAgo(s.last_sync):'Never'}</div></div>
    </div>`).join('');
}

function renderSyncJobs(jobs) {
  const el = document.getElementById('sync-job-history'); if (!el) return;
  if (!jobs?.length) { el.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim)">No jobs yet</div>'; return; }
  el.innerHTML = jobs.slice(0,8).map(j => `
    <div style="display:flex;gap:6px;padding:6px 0;border-bottom:1px solid var(--border);font-size:0.75rem">
      <span>${j.state==='completed'?'\u2705':j.state==='failed'?'\u274C':'\u23F3'}</span>
      <div style="flex:1"><div>${esc(j.description)}</div>
      <div style="color:var(--text-dim)">${timeAgo(j.started_at)}${j.items_imported>0?' \u00B7 '+j.items_imported+' imported':''}</div></div>
    </div>`).join('');
}

function renderActivityItem(log) {
  const icons = { create: '+', update: '~', delete: 'x', sync: '\u21BB' };
  return `<div class="activity-item">
    <div class="a-icon a-${log.action}">${icons[log.action]||'?'}</div>
    <div class="a-details"><div class="a-text">${esc(log.details||log.action)}</div>
    <div class="a-time">${log.ai_source?log.ai_source+' \u00B7 ':''}${timeAgo(log.created_at)}</div></div>
  </div>`;
}

function confirmPurge() {
  if (!confirm('DELETE ALL data? This cannot be undone.')) return;
  if (!confirm('Really? All knowledge, tasks, transcripts, facts — everything?')) return;
  runPurge();
}

async function runPurge() {
  const btn = document.querySelector('[onclick*="confirmPurge"]');
  const el = document.getElementById('purge-result');
  if (btn) btn.disabled = true; if (el) { el.style.display='block'; el.textContent='Purging...'; el.style.color='var(--text-dim)'; }
  try {
    await api('/purge', { method: 'POST', body: JSON.stringify({}) });
    const poll = async () => {
      const s = await api('/purge/status');
      if (s.status==='running') { if(el) el.textContent=`Purging... (${s.progress?.current||0} deleted)`; setTimeout(poll,1500); }
      else { if(el){el.style.color='var(--green)';el.textContent=s.message||'Done';} if(btn)btn.disabled=false; loadDashboard(); }
    };
    setTimeout(poll, 1500);
  } catch(e) { if(el){el.style.color='var(--red)';el.textContent=e.message;} if(btn)btn.disabled=false; }
}

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
    if (r.knowledge?.length) html += renderSearchGroup('Knowledge', r.knowledge, i => `<div class="search-result-item"><div class="search-result-title">${i.ai_source?`<span class="k-source-badge source-${i.ai_source}">${i.ai_source}</span>`:''}${esc(i.title)}</div><div class="search-result-preview">${esc((i.content||'').substring(0,200))}</div></div>`);
    if (r.facts?.length) html += renderSearchGroup('Facts', r.facts, i => `<div class="search-result-item"><div class="search-result-title">${esc(i.title)}</div><div class="search-result-preview">${esc((i.content||'').substring(0,200))}</div></div>`);
    if (r.transcripts?.length) html += renderSearchGroup('Transcripts', r.transcripts, i => `<div class="search-result-item"><div class="search-result-title">${esc(i.title)}</div><div class="search-result-preview">${esc((i.summary||'').substring(0,200))}</div></div>`);
    if (r.tasks?.length) html += renderSearchGroup('Tasks', r.tasks, i => `<div class="search-result-item"><div class="search-result-title">${esc(i.title)}</div><div class="search-result-meta"><span>${i.status||''}</span><span>${i.priority||''}</span></div></div>`);
    if (r.projects?.length) html += renderSearchGroup('Projects', r.projects, i => `<div class="search-result-item"><div class="search-result-title">${esc(i.title||i.name)}</div></div>`);
    el.innerHTML = html || '<div class="search-empty">No results</div>';
  } catch (e) { el.innerHTML = `<div class="search-empty">${esc(e.message)}</div>`; }
}
function renderSearchGroup(label, items, fn) { return `<div class="search-group-label">${label} (${items.length})</div>` + items.map(fn).join(''); }

// ─── Modal ────────────────────────────────────────────────────
function openModal(title, bodyHtml) { document.getElementById('modal-title').textContent=title; document.getElementById('modal-body').innerHTML=bodyHtml; document.getElementById('modal-overlay').classList.add('open'); }
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

// ─── Utilities ────────────────────────────────────────────────
function esc(str) { if(!str)return''; const d=document.createElement('div'); d.textContent=String(str); return d.innerHTML; }
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

  // Auto-refresh on app resume
  document.addEventListener('visibilitychange', () => { if (!document.hidden && getStoredKey()) switchTab(currentTab); });
})();
