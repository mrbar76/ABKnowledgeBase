// In-memory sync status tracker.
// Tracks the state of each data source (bee, chatgpt, claude, intake, etc.)
// and recent sync/import job history.

const sources = {};
const jobHistory = []; // last N completed jobs
const MAX_HISTORY = 50;

// Source states: 'idle' | 'syncing' | 'error'
function initSource(name, opts = {}) {
  if (!sources[name]) {
    sources[name] = {
      name,
      label: opts.label || name,
      state: 'idle',
      last_sync: null,
      last_success: null,
      last_error: null,
      error_message: null,
      items_imported: 0,
      items_skipped: 0,
      total_syncs: 0,
      total_errors: 0,
      cron_enabled: opts.cron_enabled || false,
      cron_interval_min: opts.cron_interval_min || null,
      current_job: null,
    };
  }
  return sources[name];
}

function startJob(sourceName, description) {
  const src = sources[sourceName] || initSource(sourceName);
  const job = {
    id: `${sourceName}-${Date.now()}`,
    source: sourceName,
    description: description || `${sourceName} sync`,
    state: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null,
    items_imported: 0,
    items_skipped: 0,
    errors: [],
    details: {},
  };
  src.state = 'syncing';
  src.current_job = job;
  return job;
}

function completeJob(sourceName, job, results = {}) {
  const src = sources[sourceName];
  if (!src) return;

  job.state = 'completed';
  job.finished_at = new Date().toISOString();
  job.duration_ms = Date.now() - new Date(job.started_at).getTime();
  job.items_imported = results.imported || 0;
  job.items_skipped = results.skipped || 0;
  job.errors = results.errors || [];
  job.details = results.details || {};

  // Only mark as 'error' if nothing was imported and there were errors (total failure)
  // Partial errors (some items imported, some failed) count as 'idle' (success with warnings)
  const hasErrors = job.errors.length > 0;
  const hasImports = job.items_imported > 0;
  src.state = (hasErrors && !hasImports) ? 'error' : 'idle';
  src.last_sync = job.finished_at;
  src.last_success = (!hasErrors || hasImports) ? job.finished_at : src.last_success;
  src.items_imported += job.items_imported;
  src.items_skipped += job.items_skipped;
  src.total_syncs++;
  if (job.errors.length > 0) {
    src.last_error = job.finished_at;
    src.error_message = job.errors[0];
    src.total_errors++;
  } else {
    src.error_message = null;
  }
  src.current_job = null;

  // Add to history
  jobHistory.unshift(job);
  if (jobHistory.length > MAX_HISTORY) jobHistory.pop();
}

function failJob(sourceName, job, errorMessage) {
  const src = sources[sourceName];
  if (!src) return;

  job.state = 'failed';
  job.finished_at = new Date().toISOString();
  job.duration_ms = Date.now() - new Date(job.started_at).getTime();
  job.errors = [errorMessage];

  src.state = 'error';
  src.last_sync = job.finished_at;
  src.last_error = job.finished_at;
  src.error_message = errorMessage;
  src.total_syncs++;
  src.total_errors++;
  src.current_job = null;

  jobHistory.unshift(job);
  if (jobHistory.length > MAX_HISTORY) jobHistory.pop();
}

function getStatus() {
  return {
    sources: Object.values(sources),
    recent_jobs: jobHistory.slice(0, 20),
    server_uptime_ms: process.uptime() * 1000,
    timestamp: new Date().toISOString(),
  };
}

function getSource(name) {
  return sources[name] || null;
}

module.exports = {
  initSource,
  startJob,
  completeJob,
  failJob,
  getStatus,
  getSource,
};
