// Phase 0 architecture-foundation schema guards.
//
// These migrations land columns and a table that later phases (responsive
// Coach endpoint, substitution maps, gap analysis, reference-library
// import) depend on. We can't run a real DB from CI, so we statically
// assert the migration text is present in db.js — if a refactor
// accidentally removes one, later phases would break silently.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

// ─── exercises columns ────────────────────────────────────────────

test('phase0: exercises.hevy_template_id column is added', () => {
  assert.ok(
    /ALTER TABLE exercises ADD COLUMN IF NOT EXISTS hevy_template_id/.test(dbSrc),
    'hevy_template_id ALTER missing — Phase 0 collapses the two-hop ' +
    'name-based bridge through hevy_exercise_map. Removing this leaves ' +
    'the curated catalog with no direct key into Hevy.'
  );
});

test('phase0: exercises.movement_pattern column is added', () => {
  assert.ok(
    /ALTER TABLE exercises ADD COLUMN IF NOT EXISTS movement_pattern/.test(dbSrc),
    'movement_pattern ALTER missing — Phase 3 gap analysis depends on this column. ' +
    'Without it, "what movement patterns am I undertraining?" cannot be computed.'
  );
});

test('phase0: exercises.last_logged_at column is added', () => {
  assert.ok(
    /ALTER TABLE exercises ADD COLUMN IF NOT EXISTS last_logged_at/.test(dbSrc),
    'last_logged_at ALTER missing — gap analysis treats NULL as ' +
    '"never logged via this column"; removing the column breaks that contract.'
  );
});

// ─── indexes on the new columns ───────────────────────────────────

test('phase0: hevy_template_id partial index exists', () => {
  assert.ok(
    /CREATE INDEX IF NOT EXISTS idx_exercises_hevy_template_id[\s\S]*?ON exercises\(hevy_template_id\)[\s\S]*?WHERE hevy_template_id IS NOT NULL/i.test(dbSrc),
    'Partial index on hevy_template_id missing — resolver lookups by template id ' +
    'will degrade to a seq scan as the catalog grows.'
  );
});

test('phase0: movement_pattern partial index exists', () => {
  assert.ok(
    /CREATE INDEX IF NOT EXISTS idx_exercises_movement_pattern[\s\S]*?WHERE movement_pattern IS NOT NULL/i.test(dbSrc),
    'Partial index on movement_pattern missing — gap-analysis grouping needs it.'
  );
});

// ─── backfill ─────────────────────────────────────────────────────

test('phase0: hevy_template_id backfilled from hevy_exercise_map', () => {
  // Match the UPDATE ... FROM hevy_exercise_map pattern regardless of
  // whitespace, so a future formatter pass doesn't break the guard.
  assert.ok(
    /UPDATE exercises e[\s\S]*?SET hevy_template_id[\s\S]*?FROM hevy_exercise_map/i.test(dbSrc),
    'Backfill UPDATE missing — without it, existing exercises rows have ' +
    'NULL hevy_template_id even when the name-based map already resolves them. ' +
    'Coach planning still works via the map, but resolver lookups by template ' +
    'id (the eventual contract) would return nothing.'
  );
});

test('phase0: backfill is guarded against missing hevy_exercise_map (fresh DB safe)', () => {
  // Cold-boot safety: a fresh DB might not have hevy_exercise_map yet
  // when this safeQuery runs. The DO block has to test for it.
  assert.ok(
    /information_schema\.tables[\s\S]*?WHERE table_name = 'hevy_exercise_map'/i.test(dbSrc),
    'Backfill is not guarded against a missing hevy_exercise_map table. ' +
    'A fresh DB would error during initDB cold boot.'
  );
});

// ─── exercises_reference table ────────────────────────────────────

test('phase0: exercises_reference table is created', () => {
  assert.ok(
    /CREATE TABLE IF NOT EXISTS exercises_reference/.test(dbSrc),
    'exercises_reference table missing — research library namespace for Phase 3 import.'
  );
});

test('phase0: exercises_reference has the structural columns gap analysis + import need', () => {
  // Block-level check: the CREATE TABLE body must include the columns
  // Phase 3 will read. Pulling the table body and asserting each column.
  const m = dbSrc.match(/CREATE TABLE IF NOT EXISTS exercises_reference \(([\s\S]*?)\)\s*`/);
  assert.ok(m, 'exercises_reference CREATE TABLE body not found');
  const body = m[1];
  for (const col of ['name', 'primary_muscle_group', 'secondary_muscle_groups', 'equipment', 'movement_pattern', 'source', 'source_id', 'image_urls', 'raw']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(body), `exercises_reference missing column: ${col}`);
  }
});

test('phase0: exercises_reference enforces (source, source_id) uniqueness', () => {
  assert.ok(
    /UNIQUE INDEX IF NOT EXISTS uq_exercises_reference_source_id[\s\S]*?ON exercises_reference\(source, source_id\)/i.test(dbSrc),
    'Unique (source, source_id) index missing — without it, re-importing ' +
    'the same external dataset would silently duplicate rows.'
  );
});

test('phase0: exercises_reference movement_pattern partial index for gap analysis', () => {
  assert.ok(
    /CREATE INDEX IF NOT EXISTS idx_exercises_reference_movement_pattern[\s\S]*?WHERE movement_pattern IS NOT NULL/i.test(dbSrc),
    'Partial index on exercises_reference.movement_pattern missing — gap ' +
    'analysis filters reference candidates by pattern.'
  );
});

test('phase0: exercises_reference trigram name index for substring search', () => {
  assert.ok(
    /idx_exercises_reference_name_trgm[\s\S]*?USING gin\(name gin_trgm_ops\)/i.test(dbSrc),
    'Trigram index on exercises_reference.name missing — fuzzy candidate ' +
    'search for gap-fill proposals depends on it.'
  );
});
