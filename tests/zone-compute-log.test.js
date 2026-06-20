// v3.34 hr_zones gap: lib/zone-compute-log + the attemptZoneCompute
// wrapper + sentinel surfacing. Same surfacing class as #4
// safeQuery — the silent-skip class of bug (every Format A workout
// gets no zones, no log line, no operator signal) now shows up in
// /diag/deprecated-columns under the zone_compute key.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const zoneLog = require('../lib/zone-compute-log');

test('zone-compute-log: record + getRecent round-trips', () => {
  zoneLog.reset();
  zoneLog.record({ workoutId: 'w1', source: 'ingest:format_b', outcome: 'wrote' });
  zoneLog.record({ workoutId: 'w2', source: 'ingest:format_b', outcome: 'skipped_no_samples' });
  const entries = zoneLog.getRecent();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].workoutId, 'w1');
  assert.equal(entries[0].outcome, 'wrote');
  assert.ok(entries[0].ts, 'ts must be added by record()');
  assert.equal(entries[1].outcome, 'skipped_no_samples');
});

test('zone-compute-log: bounded at MAX_ENTRIES', () => {
  zoneLog.reset();
  // Push 50 more than the cap; expect only the latest MAX_ENTRIES retained.
  const overflow = zoneLog.MAX_ENTRIES + 50;
  for (let i = 0; i < overflow; i++) {
    zoneLog.record({ workoutId: `w${i}`, source: 's', outcome: 'wrote' });
  }
  const entries = zoneLog.getRecent();
  assert.equal(entries.length, zoneLog.MAX_ENTRIES,
    'log must be bounded at MAX_ENTRIES');
  // First retained entry should be at index = overflow - MAX_ENTRIES.
  assert.equal(entries[0].workoutId, `w${overflow - zoneLog.MAX_ENTRIES}`,
    'oldest retained entry must be the first one after eviction');
});

test('zone-compute-log: summary aggregates by outcome and source', () => {
  zoneLog.reset();
  zoneLog.record({ workoutId: 'a', source: 'ingest:format_b', outcome: 'wrote' });
  zoneLog.record({ workoutId: 'b', source: 'ingest:format_b', outcome: 'wrote' });
  zoneLog.record({ workoutId: 'c', source: 'ingest:format_d', outcome: 'skipped_no_samples' });
  zoneLog.record({ workoutId: 'd', source: 'ingest:format_b', outcome: 'error' });
  const s = zoneLog.summary();
  assert.equal(s.total, 4);
  assert.equal(s.by_outcome.wrote, 2);
  assert.equal(s.by_outcome.skipped_no_samples, 1);
  assert.equal(s.by_outcome.error, 1);
  assert.equal(s.by_source['ingest:format_b'], 3);
  assert.equal(s.by_source['ingest:format_d'], 1);
});

test('zone-compute-log: getRecent(limit) caps the slice', () => {
  zoneLog.reset();
  for (let i = 0; i < 30; i++) zoneLog.record({ workoutId: `w${i}`, source: 's', outcome: 'wrote' });
  assert.equal(zoneLog.getRecent(10).length, 10);
  assert.equal(zoneLog.getRecent(10)[9].workoutId, 'w29',
    'getRecent(limit) returns the LATEST N (slice from the end)');
});

// ─── attemptZoneCompute wrapper present in routes/health.js ──────────
test('routes/health.js: attemptZoneCompute helper exists and records all 5 outcomes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/health.js'), 'utf8');
  const fn = src.match(/async function attemptZoneCompute\(workoutId, hrSamples, source\)[\s\S]*?zoneLog\.record\(\{[\s\S]*?\}\);\s*return outcome;\s*\}/);
  assert.ok(fn, 'attemptZoneCompute function must be defined');
  // Every outcome from the documented vocabulary must appear as a
  // string literal in the function body so we know each codepath
  // actually records. Match the literal anywhere — direct assignment
  // OR ternary branch (skipped_no_zones_row / skipped_no_window_match
  // are produced via ternary, no `outcome = '...'` form).
  for (const outcome of [
    'wrote', 'skipped_no_samples', 'skipped_no_started_at',
    'skipped_no_zones_row', 'skipped_no_window_match', 'error',
  ]) {
    assert.ok(new RegExp(`['"]${outcome}['"]`).test(fn[0]),
      `attemptZoneCompute must produce outcome '${outcome}' on the corresponding path`);
  }
  // Must call zoneLog.record exactly once at the end.
  assert.equal(fn[0].match(/zoneLog\.record\(/g).length, 1,
    'attemptZoneCompute must record exactly once per call (single end-of-function point)');
});

test('routes/health.js: Format B + Format D ingest sites both use attemptZoneCompute', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/health.js'), 'utf8');
  // The two ingest sites that previously did raw `if (zones) { UPDATE }`
  // must both route through the wrapper. Tag the call sites by their
  // source string so we can distinguish.
  assert.ok(/attemptZoneCompute\(w\.id, hrSamples, ['"]ingest:format_b['"]\)/.test(src),
    'Format B ingest must call attemptZoneCompute with source=ingest:format_b');
  assert.ok(/attemptZoneCompute\(w\.id, hrSamplesD, ['"]ingest:format_d['"]\)/.test(src),
    'Format D ingest must call attemptZoneCompute with source=ingest:format_d');
  // The raw `UPDATE workouts SET hr_zones = $1::jsonb WHERE id = $2`
  // pattern that the wrapper replaced must be GONE from those sites.
  // (The wrapper itself uses an updated_at-bearing variant.)
  const ingestBlock = src.match(/if \(hrSamples\.length\) \{[\s\S]*?\}\s*\n\s*\}\s*\n\s*\n\s*result = \{\s*\n\s*format: 'B'/);
  assert.ok(ingestBlock, 'Format B ingest block locatable');
  assert.ok(!/UPDATE workouts SET hr_zones = \$1::jsonb WHERE id = \$2/.test(ingestBlock[0]),
    'Format B ingest must not contain the raw UPDATE pattern (delegated to wrapper)');
});

test('routes/health.js: sentinel response includes zone_compute + zone_compute_skip_count', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/health.js'), 'utf8');
  const responseBlock = src.match(/res\.json\(\{[\s\S]*?zone_compute: \{[\s\S]*?\},?\s*\}\);/);
  assert.ok(responseBlock, 'sentinel res.json must include a zone_compute key');
  assert.ok(/zone_compute_skip_count:/.test(responseBlock[0]),
    'response must surface zone_compute_skip_count alongside schema_drift_count and failed_migrations_count');
  // Verdict must mention zone-compute state.
  assert.ok(/zone-compute/i.test(responseBlock[0]) || /zone_compute/.test(responseBlock[0]),
    'verdict text must mention zone-compute state');
});

test('routes/health.js: zoneLog imported once at top of file', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/health.js'), 'utf8');
  const imports = src.match(/require\(['"]\.\.\/lib\/zone-compute-log['"]\)/g) || [];
  assert.equal(imports.length, 1,
    'zoneLog should be required exactly once (top of file, not inside handlers)');
});
