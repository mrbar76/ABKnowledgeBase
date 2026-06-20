// v3.34 #3: live-DB integration suite. Runs against the Postgres 16
// service started by .github/workflows/test.yml — or any local
// Postgres reachable via DATABASE_URL. Skips cleanly when no DB is
// available so this file is safe to keep in the static glob too.
//
// Coverage:
//   - initDB() against a fresh schema with no failed migrations
//   - rebuild-daily-context.js dry run → reports NO-OP (zero tombstones
//     on a fresh DB; idempotency check)
//   - consolidate-daily-activity-to-vitals.js dry run → reports zero
//     writes (no source rows on a fresh DB)
//   - drop-daily-activity-movement-cols.js dry run → reports DRY RUN
//     verdict (movement cols still present, no rows blocking)
//
// What this catches that static tests can't: the silent-swallow bug
// where update_workouts_search pinned the adjustment DROP. After
// v3.33 Phase B fixed the trigger, this suite would detect a
// regression at PR time instead of months later in production logs.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const HAS_DB = !!process.env.DATABASE_URL;

function runScript(rel, args = []) {
  return spawnSync('node', [path.join(REPO_ROOT, rel), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function parseLastJson(stdout) {
  // Scripts emit a single JSON object as their final output. Find the
  // last `{` line and parse from there.
  const trimmed = stdout.trim();
  const lastBrace = trimmed.lastIndexOf('\n{');
  const json = lastBrace === -1 ? trimmed : trimmed.slice(lastBrace + 1);
  return JSON.parse(json);
}

test('integration: DATABASE_URL is set (skip otherwise)', { skip: !HAS_DB }, () => {
  assert.ok(HAS_DB, 'DATABASE_URL must be set for integration tests');
});

test('integration: initDB succeeds with zero failed migrations on a fresh schema',
  { skip: !HAS_DB }, async () => {
    const db = require('../../db');
    db.resetFailedMigrations();
    await db.initDB();
    const failures = db.getFailedMigrations();
    assert.deepEqual(failures, [],
      `initDB() must complete with zero failed migrations on a fresh Postgres. Failures: ${JSON.stringify(failures, null, 2)}`);
  });

test('integration: schema sentinel reports zero drift after fresh initDB',
  { skip: !HAS_DB }, async () => {
    // The DEPRECATED_COLUMNS manifest only lists columns that SHOULD
    // be gone. On a fresh DB, the CREATE TABLE statements never had
    // them in the first place, so the drift count is 0 trivially.
    const { query } = require('../../db');
    // information_schema query mirroring what the sentinel does
    const r = await query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'workouts' AND column_name = 'adjustment' LIMIT 1
    `);
    assert.equal(r.rows.length, 0,
      'workouts.adjustment must not exist after fresh initDB (CREATE TABLE has been cleaned in v3.33 Phase B)');
  });

test('integration: rebuild-daily-context dry run reports NO-OP on fresh DB',
  { skip: !HAS_DB }, () => {
    const r = runScript('scripts/rebuild-daily-context.js');
    assert.equal(r.status, 0, `script must exit 0. stderr: ${r.stderr}`);
    const out = parseLastJson(r.stdout);
    assert.equal(out.dry_run, true);
    // Fresh DB → zero tombstones → NO-OP path.
    assert.match(out.verdict, /NO-OP/,
      `expected NO-OP verdict on fresh DB. Got: ${out.verdict}`);
    assert.equal(out.tombstones_before, 0);
  });

test('integration: consolidate-daily-activity-to-vitals dry run on empty tables',
  { skip: !HAS_DB }, () => {
    const r = runScript('scripts/consolidate-daily-activity-to-vitals.js');
    assert.equal(r.status, 0, `script must exit 0. stderr: ${r.stderr}`);
    const out = parseLastJson(r.stdout);
    assert.equal(out.dry_run, true);
    // No daily_activity rows on a fresh DB → zero writes planned.
    assert.equal(out.activity_rows_scanned, 0);
    assert.equal(out.writes_planned, 0);
    assert.match(out.verdict, /DRY RUN/);
  });

test('integration: drop-daily-activity-movement-cols dry run with no blocking data',
  { skip: !HAS_DB }, () => {
    const r = runScript('scripts/drop-daily-activity-movement-cols.js');
    assert.equal(r.status, 0, `script must exit 0. stderr: ${r.stderr}`);
    const out = parseLastJson(r.stdout);
    assert.equal(out.dry_run, true);
    // Fresh DB has the 7 columns present (db.js CREATE TABLE includes
    // them) but no rows, so pre-flight passes and we get a clean DRY RUN.
    assert.equal(Object.keys(out.unbacked_rows_by_column || {}).length, 0,
      'no blocking data on fresh DB');
    assert.match(out.verdict, /DRY RUN/);
  });

// Tear down the pool so the test process exits cleanly.
test('integration: teardown', { skip: !HAS_DB }, async () => {
  const { pool } = require('../../db');
  await pool.end();
});
