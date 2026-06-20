// Static safety guards for scripts/rebuild-daily-context.js.
//
// The script does table-level destructive ops (DROP TABLE / RENAME).
// Without a live DB in CI, we can't run end-to-end, but we CAN prove a
// few invariants that — if violated — would silently lose data.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../scripts/rebuild-daily-context.js'), 'utf8');

test('rebuild-daily-context: default is dry-run (apply must be explicit)', () => {
  // The script should NOT call --apply automatically. The runtime
  // entrypoint must read process.argv and treat absence-of-flag as a
  // no-write dry run.
  assert.ok(/const apply = process\.argv\.includes\(['"]--apply['"]\)/.test(src),
    'apply flag must be read from argv');
  // Verify dry-run path actually throws to roll back the transaction
  // (so v2 table doesn't survive a dry-run).
  assert.ok(/__DRY_RUN__/.test(src),
    'dry-run path must throw a __DRY_RUN__ sentinel to force rollback');
});

test('rebuild-daily-context: row-count + checksum assertions before swap', () => {
  // Two distinct guards must fire before any DROP TABLE statement: row
  // count match and checksum match. If either is absent the rebuild
  // could swap mismatched tables and lose data silently.
  const dropIdx = src.indexOf('DROP TABLE daily_context');
  assert.ok(dropIdx > 0, 'DROP TABLE statement present');
  const beforeDrop = src.slice(0, dropIdx);
  assert.ok(/row_count !== newStats\.rows\[0\]\.row_count/.test(beforeDrop),
    'row-count assertion must precede the live swap');
  assert.ok(/checksum !== newStats\.rows\[0\]\.checksum/.test(beforeDrop),
    'checksum assertion must precede the live swap');
});

test('rebuild-daily-context: entire flow is wrapped in withTransaction', () => {
  // The destructive sequence (CREATE/INSERT/DROP/RENAME) must execute
  // inside one transaction so a mid-flight failure rolls back cleanly.
  assert.ok(/await withTransaction\(async \(client\) => \{/.test(src),
    'must use withTransaction wrapper');
  // The DROP TABLE statement must use the client (transactional) not
  // the module-level query (auto-commit).
  assert.ok(/client\.query\(`DROP TABLE daily_context`\)/.test(src),
    'DROP must use client.query so it stays inside the transaction');
});

test('rebuild-daily-context: COPY_COLUMNS preserves every live daily_context column', () => {
  // The COPY_COLUMNS list determines which columns get copied to the
  // new table. Missing a live column would silently drop user data
  // (e.g. forgetting `bedtime_self_report` would lose every row's
  // bedtime). Pin the full set.
  const m = src.match(/const COPY_COLUMNS = \[([\s\S]*?)\];/);
  assert.ok(m, 'COPY_COLUMNS list present');
  const list = m[1];
  const required = [
    'id', 'date', 'hydration_liters', 'notes',
    'sleep_hours', 'sleep_quality',
    'mood', 'motivation', 'soreness_overall', 'soreness_areas',
    'life_stress', 'illness_flag', 'travel_status', 'bedtime_self_report',
    'alcohol_units', 'supplement_change_note',
    'search_vector', 'created_at', 'updated_at',
  ];
  for (const col of required) {
    assert.ok(new RegExp(`['"]${col}['"]`).test(list),
      `COPY_COLUMNS must include '${col}' (live column would be lost otherwise)`);
  }
  // The 8 tombstoned columns must NOT be copied — they're the whole
  // point of the rebuild.
  for (const col of ['day_type', 'energy_rating', 'hunger_rating',
                     'recovery_rating', 'body_weight_lb', 'cravings',
                     'digestion', 'tags']) {
    assert.ok(!new RegExp(`['"]${col}['"]`).test(list),
      `COPY_COLUMNS must NOT include tombstoned column '${col}'`);
  }
});

test('rebuild-daily-context: id is preserved (not regenerated) during copy', () => {
  // Preserving the id column matters even with no FKs today — activity_log
  // and other future joiners may reference daily_context rows by id, and
  // re-minting UUIDs would invalidate any external links.
  const m = src.match(/CREATE TABLE daily_context_v2 \(([\s\S]*?)\)\`/);
  assert.ok(m, 'CREATE TABLE daily_context_v2 statement present');
  const ddl = m[1];
  // No DEFAULT gen_random_uuid() on id — the copy supplies the UUID
  // from the old row.
  assert.ok(!/id\s+UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/.test(ddl),
    'id column must NOT have a DEFAULT (the copy preserves the old id)');
});

test('rebuild-daily-context: no-op when no tombstones (idempotent re-run)', () => {
  // Re-running after a successful rebuild should be safe. The
  // tombstones_before guard exits early with a friendly message.
  assert.ok(/tombstones_before === 0/.test(src),
    'must detect a fresh table and skip the rebuild');
  assert.ok(/__NO_OP__/.test(src),
    'no-op path must throw a sentinel so the transaction rolls back without side effects');
});

test('rebuild-daily-context: recreates indexes + trigger after rename', () => {
  // The old table's indexes and triggers die with the DROP. The
  // rename promotes daily_context_v2, which has only the implicit PK +
  // UNIQUE. The script must rebuild the explicit idx_dc_date,
  // idx_dc_search, and trg_dc_search to match db.js.
  const renameIdx = src.indexOf('ALTER TABLE daily_context_v2 RENAME TO daily_context');
  assert.ok(renameIdx > 0, 'rename statement present');
  const afterRename = src.slice(renameIdx);
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_dc_date/.test(afterRename),
    'idx_dc_date must be recreated after rename');
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_dc_search/.test(afterRename),
    'idx_dc_search must be recreated after rename');
  assert.ok(/CREATE TRIGGER trg_dc_search BEFORE INSERT OR UPDATE OF notes/.test(afterRename),
    'trg_dc_search must be recreated after rename');
});
