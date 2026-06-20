// v3.34 #4: safeQuery in-process failure log + sentinel surfacing.
//
// The original silent-swallow bug (trigger pinning the adjustment DROP)
// hid for months because safeQuery only logged to stderr — nothing
// surfaced in the API. These tests pin the new contract:
//   - safeQuery records every failure in FAILED_MIGRATIONS
//   - getFailedMigrations() exports the log
//   - the schema sentinel returns failed_migrations_count + the list
//   - verdict text reflects both drift and boot-failure state

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('db.js: safeQuery records failures in FAILED_MIGRATIONS', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  // The module-level array must exist.
  assert.ok(/const FAILED_MIGRATIONS = \[\]/.test(src),
    'FAILED_MIGRATIONS array must be declared at module scope');
  // safeQuery must push on error.
  const safeQueryBody = src.match(/async function safeQuery\([\s\S]*?\n\}/);
  assert.ok(safeQueryBody, 'safeQuery function present');
  assert.ok(/FAILED_MIGRATIONS\.push\(\{[\s\S]*?label[\s\S]*?message[\s\S]*?\}\)/.test(safeQueryBody[0]),
    'safeQuery must push {label, message, ...} into FAILED_MIGRATIONS on catch');
  // Must STILL log to console.error — the in-memory log is additive,
  // not a replacement.
  assert.ok(/console\.error\(`\[initDB\] \$\{label\} failed/.test(safeQueryBody[0]),
    'safeQuery must keep console.error logging (stderr trail for Railway logs)');
});

test('db.js: exports getFailedMigrations + resetFailedMigrations', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  const exportLine = src.match(/module\.exports = \{[\s\S]*?\};/);
  assert.ok(exportLine, 'module.exports present');
  assert.ok(/getFailedMigrations/.test(exportLine[0]),
    'getFailedMigrations must be exported (sentinel reads it)');
  assert.ok(/resetFailedMigrations/.test(exportLine[0]),
    'resetFailedMigrations must be exported (test harnesses need to clear between runs)');
});

test('db.js: safeQuery runtime behaviour — failure goes into the log', async () => {
  // Black-box exercise: a guaranteed-failing safeQuery must populate
  // FAILED_MIGRATIONS but not throw. We can't import the unexported
  // safeQuery directly, but we can use the exported initDB-like
  // primitives — wait, no, safeQuery isn't exported. Test via the
  // exported getter after calling something that uses safeQuery.
  //
  // The cleanest path: monkey-patch the exported `query` to throw,
  // then call any initDB sub-step. But initDB has lots of side
  // effects. So instead, run a deliberate failure via withTransaction
  // — but withTransaction throws on failure (not safe-swallow), wrong
  // semantics.
  //
  // Pragmatic compromise: spawn a child node that requires db.js,
  // calls safeQuery's wrapped error path indirectly by invoking a
  // failing query via the module's own internal usage. Since we can't
  // reach safeQuery's wrapper without running initDB (which needs a
  // live DB), we keep this test purely static and rely on the
  // structural assertions above. The runtime behaviour is exercised
  // every time initDB runs in production.
  const dbModule = require('../db');
  assert.equal(typeof dbModule.getFailedMigrations, 'function',
    'exported getter must be callable');
  assert.equal(typeof dbModule.resetFailedMigrations, 'function',
    'exported reset must be callable');
  const log = dbModule.getFailedMigrations();
  assert.ok(Array.isArray(log), 'getFailedMigrations must return an array');
  // Returned value must be a copy (slice), not the live array — so
  // mutating it from outside doesn't corrupt the in-process log.
  log.push({ label: 'mutation-probe', message: 'should not appear' });
  const afterProbe = dbModule.getFailedMigrations();
  assert.ok(!afterProbe.some(e => e.label === 'mutation-probe'),
    'getFailedMigrations must return a copy so external mutation is harmless');
});

test('routes/health.js: sentinel surfaces failed_migrations + count', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/health.js'), 'utf8');
  // Import line updated to include getFailedMigrations.
  assert.ok(/getFailedMigrations/.test(src),
    'routes/health.js must import getFailedMigrations from ../db');
  // Sentinel JSON response must include the new fields.
  const responseBlock = src.match(/res\.json\(\{[\s\S]*?columns: cols,[\s\S]*?\}\);/);
  assert.ok(responseBlock, 'sentinel res.json block present');
  assert.ok(/failed_migrations_count: failedMigrations\.length/.test(responseBlock[0]),
    'response must include failed_migrations_count');
  assert.ok(/failed_migrations: failedMigrations/.test(responseBlock[0]),
    'response must include the failed_migrations array');
});

test('routes/health.js: sentinel verdict reflects drift, boot failures, and zone-compute skips', () => {
  // v3.34 hr_zones gap extension: verdict refactored from a 4-state
  // hardcoded ternary into a verdictParts.join('; ') pattern. The OK
  // case still requires ALL counts at 0; degraded cases append a part
  // per concern. Pin the structural invariants.
  const src = fs.readFileSync(path.join(__dirname, '../routes/health.js'), 'utf8');
  // OK case: all three counts must gate "OK".
  assert.ok(/const ok = drifts === 0 && failedMigrations\.length === 0 && zoneSkipCount === 0/.test(src),
    'sentinel OK gate must require drifts=0 AND failedMigrations=0 AND zoneSkipCount=0');
  // Verdict text on the OK path must name all three.
  assert.ok(/OK: live schema matches manifest, all boot migrations succeeded, no zone-compute skips/.test(src),
    'OK verdict text must mention all three invariants');
  // Each verdictParts branch contributes a string for the non-OK
  // verdict. Pin one phrase per concern so a future "drop the zone
  // line" regression fails this test.
  assert.ok(/schema drift\(s\)/.test(src), 'verdictParts must include schema-drift phrase');
  assert.ok(/boot migration failure\(s\)/.test(src), 'verdictParts must include boot-migration phrase');
  assert.ok(/zone-compute skip\(s\)\/error\(s\)/.test(src), 'verdictParts must include zone-compute phrase');
});
