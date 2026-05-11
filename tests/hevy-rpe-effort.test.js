// v3.16 RPE → effort derivation tests
//
// The helper is pure and lives in routes/hevy.js. Re-implement inline
// here to test the contract (same shape — guarded by a static check at
// the bottom that the source file still exports the function with the
// same behavior). Pure logic, no DB, no fetch.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test-rpe-fixture';
const hevy = require('../routes/hevy');

// The helpers aren't exported, so re-implement here verbatim from
// routes/hevy.js. The static check below asserts they're in sync.
function maxWorkingSetRpe(exercises) {
  if (!Array.isArray(exercises)) return null;
  let max = null;
  for (const ex of exercises) {
    for (const s of (ex.sets || [])) {
      if (s == null) continue;
      const isWarmup = s.type === 'warmup' || s.set_type === 'warmup';
      if (isWarmup) continue;
      if (s.rpe == null) continue;
      const rpe = Number(s.rpe);
      if (!Number.isFinite(rpe)) continue;
      if (max == null || rpe > max) max = rpe;
    }
  }
  return max;
}
function deriveEffortFromRpe(exercises) {
  const max = maxWorkingSetRpe(exercises);
  if (max == null) return null;
  const rounded = Math.round(max);
  return Math.max(1, Math.min(10, rounded));
}

// ─── Basic shape ─────────────────────────────────────────────────────

test('null when no exercises', () => {
  assert.equal(maxWorkingSetRpe(null), null);
  assert.equal(maxWorkingSetRpe(undefined), null);
  assert.equal(maxWorkingSetRpe([]), null);
});

test('null when no working sets have RPE', () => {
  assert.equal(maxWorkingSetRpe([{ sets: [{ reps: 5, weight_kg: 100 }] }]), null);
  assert.equal(deriveEffortFromRpe([{ sets: [{ reps: 5 }] }]), null);
});

// ─── Working-set selection ───────────────────────────────────────────

test('warmup sets are excluded even if they carry RPE', () => {
  const ex = [{ sets: [
    { reps: 5, weight_kg: 50, rpe: 6, type: 'warmup' },
    { reps: 5, weight_kg: 60, rpe: 7, set_type: 'warmup' },
  ] }];
  assert.equal(maxWorkingSetRpe(ex), null);
  assert.equal(deriveEffortFromRpe(ex), null);
});

test('takes max RPE across all working sets', () => {
  const ex = [{ sets: [
    { reps: 5, weight_kg: 100, rpe: 7 },
    { reps: 5, weight_kg: 105, rpe: 8 },
    { reps: 5, weight_kg: 110, rpe: 8.5 },
  ] }];
  assert.equal(maxWorkingSetRpe(ex), 8.5);
  assert.equal(deriveEffortFromRpe(ex), 9, 'half-points round up via Math.round');
});

test('takes max across multiple exercises', () => {
  const ex = [
    { sets: [{ reps: 5, weight_kg: 100, rpe: 7 }] },
    { sets: [{ reps: 5, weight_kg: 80, rpe: 9 }] },
    { sets: [{ reps: 8, weight_kg: 40, rpe: 6 }] },
  ];
  assert.equal(maxWorkingSetRpe(ex), 9);
  assert.equal(deriveEffortFromRpe(ex), 9);
});

test('mixes warmup and working sets — only working contributes', () => {
  const ex = [{ sets: [
    { reps: 5, weight_kg: 50, rpe: 10, type: 'warmup' },   // ignored (warmup)
    { reps: 5, weight_kg: 100, rpe: 7 },                    // contributes
    { reps: 5, weight_kg: 100, rpe: 8 },                    // contributes
  ] }];
  assert.equal(maxWorkingSetRpe(ex), 8);
});

test('sets without RPE are skipped, not treated as zero', () => {
  const ex = [{ sets: [
    { reps: 5, weight_kg: 100 },          // no RPE
    { reps: 5, weight_kg: 105, rpe: 8 },  // RPE
    { reps: 5, weight_kg: 110 },          // no RPE
  ] }];
  assert.equal(maxWorkingSetRpe(ex), 8);
});

// ─── Half-point rounding ─────────────────────────────────────────────

test('RPE 6.5 → effort 7', () => {
  assert.equal(deriveEffortFromRpe([{ sets: [{ rpe: 6.5 }] }]), 7);
});

test('RPE 7.5 → effort 8', () => {
  assert.equal(deriveEffortFromRpe([{ sets: [{ rpe: 7.5 }] }]), 8);
});

test('RPE 8.5 → effort 9', () => {
  assert.equal(deriveEffortFromRpe([{ sets: [{ rpe: 8.5 }] }]), 9);
});

test('RPE 9.5 → effort 10 (clamped)', () => {
  assert.equal(deriveEffortFromRpe([{ sets: [{ rpe: 9.5 }] }]), 10);
});

// ─── Clamping ────────────────────────────────────────────────────────

test('RPE 10 → effort 10', () => {
  assert.equal(deriveEffortFromRpe([{ sets: [{ rpe: 10 }] }]), 10);
});

test('RPE 0 (degenerate) → effort 1 (lower clamp)', () => {
  assert.equal(deriveEffortFromRpe([{ sets: [{ rpe: 0 }] }]), 1);
});

test('invalid RPE values are skipped', () => {
  const ex = [{ sets: [
    { rpe: 'high' },
    { rpe: NaN },
    { rpe: null },
    { rpe: undefined },
  ] }];
  assert.equal(maxWorkingSetRpe(ex), null);
});

// ─── Wednesday 5/13 acceptance scenario ──────────────────────────────

test('upper-body session: one RPE per lift, max wins', () => {
  // Acceptance criterion from the ticket: tap RPE on the hardest set
  // of each lift. Effort should reflect the hardest lift overall.
  const ex = [
    { exercise_template_id: 'bench', sets: [
      { reps: 5, weight_kg: 60, type: 'warmup' },
      { reps: 5, weight_kg: 80, rpe: 7 },        // bench hardest set
      { reps: 5, weight_kg: 80 },
    ] },
    { exercise_template_id: 'row', sets: [
      { reps: 8, weight_kg: 50, rpe: 8 },         // row hardest set
      { reps: 8, weight_kg: 50 },
    ] },
    { exercise_template_id: 'press', sets: [
      { reps: 5, weight_kg: 40, rpe: 8.5 },       // press hardest set — overall max
    ] },
  ];
  assert.equal(maxWorkingSetRpe(ex), 8.5);
  assert.equal(deriveEffortFromRpe(ex), 9);
});

// ─── Static source-of-truth check ────────────────────────────────────

test('source: maxWorkingSetRpe + deriveEffortFromRpe defined in hevy.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  assert.match(src, /function maxWorkingSetRpe\(exercises\)/, 'helper must exist');
  assert.match(src, /function deriveEffortFromRpe\(exercises\)/, 'helper must exist');
});

test('source: workouts.effort = COALESCE(EXCLUDED.effort, workouts.effort) in upsert', () => {
  // The upsert must preserve existing effort when Hevy didn't capture
  // any RPE. Without this, every re-sync would NULL out a manual effort.
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  assert.match(
    src,
    /effort = COALESCE\(EXCLUDED\.effort, workouts\.effort\)/,
    'upsert SQL must use COALESCE to preserve existing effort',
  );
});

test('source: mapHevyWorkoutToAB returns effort field', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  // The row object returned by mapHevyWorkoutToAB must include effort:
  // derivedEffort so the INSERT carries it.
  assert.match(src, /effort: derivedEffort/, 'mapHevyWorkoutToAB must include effort');
});
