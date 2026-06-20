// v3.34 round 4: prevent add → drop tombstone leaks in db.js.
//
// Every (table, column) pair that has BOTH an ADD COLUMN IF NOT EXISTS
// AND a DROP COLUMN IF EXISTS in db.js's initDB() creates a per-boot
// tombstone leak: the ADD allocates a new attribute slot, the DROP
// marks it dropped (slot consumed permanently), and the next boot
// repeats. Production hit 1581 tombstones on daily_context this way
// — enough to trip the Postgres 1600-column ceiling.
//
// This test enforces: no zombie ADDs allowed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('db.js: no ADD COLUMN paired with DROP COLUMN for same table.column (per-boot leak guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');

  const adds = new Set();
  for (const m of src.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)) {
    adds.add(`${m[1]}.${m[2]}`);
  }
  const drops = new Set();
  for (const m of src.matchAll(/ALTER TABLE (\w+) DROP COLUMN IF EXISTS (\w+)/g)) {
    drops.add(`${m[1]}.${m[2]}`);
  }
  const leaks = [...adds].filter(k => drops.has(k)).sort();

  assert.deepEqual(leaks, [],
    `Active per-boot tombstone leak(s) detected in db.js. ` +
    `These (table, column) pairs have BOTH an ADD COLUMN and a DROP ` +
    `COLUMN in initDB() — every boot allocates a new attribute slot ` +
    `then drops it, permanently consuming the slot. Remove the ADD ` +
    `COLUMN line; keep the DROP for idempotency on legacy DBs.\n` +
    `Leaks: ${JSON.stringify(leaks, null, 2)}`);
});

test('db.js: CREATE TABLE columns are not also in DROP COLUMN list (fresh-DB tombstone guard)', () => {
  // Weaker but still useful: if a column is in CREATE TABLE for a
  // table AND in a later DROP COLUMN, fresh DBs allocate then drop,
  // costing 1 tombstone per fresh boot. Production DBs already past
  // the first boot are unaffected by this specific pattern (the DROP
  // is a no-op once the column is gone), but new test envs and any
  // future fresh deploy bleeds one slot per affected column.
  const src = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');

  // Pull (table, column) pairs from CREATE TABLE blocks. Best-effort
  // parse — the regex captures the table name from the CREATE line
  // and column names from each non-blank line until the closing `)`.
  const createBlocks = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)`/g)];
  const created = new Set();
  for (const block of createBlocks) {
    const table = block[1];
    const body = block[2];
    // Match `  col_name TYPE` patterns at the start of trimmed lines.
    // Skip lines starting with comments or constraint keywords.
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('CHECK') || trimmed.startsWith('UNIQUE') || trimmed.startsWith('PRIMARY')) continue;
      const cm = trimmed.match(/^([a-z_][a-z0-9_]*)\s+[A-Z]/);
      if (cm) created.add(`${table}.${cm[1]}`);
    }
  }

  const drops = new Set();
  for (const m of src.matchAll(/ALTER TABLE (\w+) DROP COLUMN IF EXISTS (\w+)/g)) {
    drops.add(`${m[1]}.${m[2]}`);
  }

  const freshDbLeaks = [...created].filter(k => drops.has(k)).sort();
  assert.deepEqual(freshDbLeaks, [],
    `Column(s) present in BOTH CREATE TABLE and DROP COLUMN — fresh ` +
    `DBs (CI, new deploys, test envs) allocate then drop, costing one ` +
    `tombstone per fresh boot. Remove from CREATE TABLE if the column ` +
    `is being intentionally dropped.\n` +
    `Affected: ${JSON.stringify(freshDbLeaks, null, 2)}`);
});
