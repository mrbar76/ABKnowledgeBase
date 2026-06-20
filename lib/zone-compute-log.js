'use strict';

// Bounded in-process log of HR-zone-compute attempts. Same surfacing
// pattern as db.js FAILED_MIGRATIONS — the silent-skip class of bug
// (computeHrZonesForWorkout returns null for any of four reasons; the
// ingest sites just don't write zones) is reportable via the schema
// sentinel rather than buried in stderr or "you have to know to run
// /diag/hr-sample-coverage".
//
// Outcome vocabulary (pin once, surface everywhere):
//   wrote                    zones computed + persisted
//   skipped_no_started_at    workout row has no started_at timestamp
//   skipped_no_samples       caller passed an empty sample array
//   skipped_no_zones_row     no athlete_zones row covers the workout date
//   skipped_no_window_match  samples present but none inside [start, end]
//   error                    exception thrown — message preserved

const MAX_ENTRIES = 200;
const LOG = [];

function record(entry) {
  LOG.push({ ...entry, ts: new Date().toISOString() });
  // Bounded so memory doesn't grow unbounded on a long-lived server.
  // The sentinel reports both the rolling summary (cheap) and the last
  // N for forensics (capped).
  if (LOG.length > MAX_ENTRIES) LOG.splice(0, LOG.length - MAX_ENTRIES);
}

function getRecent(limit = MAX_ENTRIES) {
  const n = Math.min(Math.max(limit | 0, 1), MAX_ENTRIES);
  return LOG.slice(-n);
}

function summary() {
  const by_outcome = {};
  const by_source = {};
  for (const e of LOG) {
    by_outcome[e.outcome] = (by_outcome[e.outcome] || 0) + 1;
    if (e.source) by_source[e.source] = (by_source[e.source] || 0) + 1;
  }
  return { total: LOG.length, by_outcome, by_source };
}

function reset() { LOG.length = 0; }

module.exports = { record, getRecent, summary, reset, MAX_ENTRIES };
