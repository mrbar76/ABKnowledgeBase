// v3.34 round 3 bonus fixes: defensive iteration in goal-compute +
// per-task try/catch in recurring extension. Both surfaced by the
// post-PR-#60 production deploy logs.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeValueForGoal } = require('../lib/goal-compute');

// ─── goal-compute: "number 3 is not iterable" regression ────────────
test('goal-compute: ex.sets stored as a number (not array) does not crash', () => {
  // Production data had at least one workout where an exercise was stored
  // with `"sets": 3` (a count instead of an array of set objects). The old
  // code did `for (const set of (ex.sets || []))` which evaluated `3 || []`
  // → `3` → `for...of 3` throws "number 3 is not iterable" → the entire
  // goals recompute crashed for that goal. With Array.isArray guard, the
  // malformed exercise is silently skipped and the goal computation
  // continues.
  const goal = {
    id: 'test-goal',
    compute_method: 'max_weight',
    metric: 'weight_lb',
    linked_exercise_names: ['Bench Press'],
    anchor_date: '2026-01-01',
  };
  const workouts = [{
    id: 'w1',
    workout_date: '2026-06-01',
    exercises: [
      { name: 'Bench Press', sets: 3 }, // ← the malformed shape that crashed prod
      { name: 'Bench Press', sets: [{ weight_lb: 225, reps: 5 }] }, // ← valid
    ],
  }];

  // Pre-fix: this threw "number 3 is not iterable" before ever reaching
  // the valid set. Post-fix: malformed exercise is skipped, valid set
  // computed normally.
  const result = computeValueForGoal(goal, workouts, []);
  assert.equal(result.value, 225,
    'malformed sets:3 must be skipped, valid set still computed');
});

test('goal-compute: ex.sets as string also does not crash', () => {
  // Defensive: any non-array truthy value (string, number, object,
  // boolean) must be skipped without crashing. Pre-fix `"abc" || []`
  // gave `"abc"` and `for...of "abc"` iterates chars — silently
  // produced garbage `set` objects.
  const goal = {
    id: 'test-goal',
    compute_method: 'max_weight',
    metric: 'weight_lb',
    linked_exercise_names: ['Squat'],
    anchor_date: '2026-01-01',
  };
  const workouts = [{
    id: 'w1',
    workout_date: '2026-06-01',
    exercises: [
      { name: 'Squat', sets: 'broken' },
      { name: 'Squat', sets: [{ weight_lb: 315, reps: 3 }] },
    ],
  }];
  const result = computeValueForGoal(goal, workouts, []);
  assert.equal(result.value, 315);
});

test('lib/goal-compute.js: every "for ... of ex.sets" uses Array.isArray guard', () => {
  // Pin the structural fix so the bug class can't re-appear by accident.
  const src = fs.readFileSync(path.join(__dirname, '../lib/goal-compute.js'), 'utf8');
  // No bare `(ex.sets || [])` patterns allowed.
  assert.ok(!/\(ex\.sets \|\| \[\]\)/.test(src),
    'bare `(ex.sets || [])` is the regression — must use Array.isArray guard');
  // Each `for (const set of ...)` must have an Array.isArray guard
  // on its iterable expression.
  const matches = src.match(/for \(const set of[^)]+\)/g) || [];
  assert.ok(matches.length >= 3,
    'expected at least 3 set-iteration sites to guard');
  for (const m of matches) {
    assert.ok(/Array\.isArray\(ex\.sets\)/.test(m),
      `set-iteration site must guard via Array.isArray(ex.sets): ${m}`);
  }
});

// ─── tasks.js: per-task try/catch in extendAllRecurring ──────────────
test('routes/tasks.js: extendAllRecurring wraps each task in try/catch', () => {
  // Pre-fix: a single task with a non-JSON recurrence_rule (e.g. legacy
  // iCal "FREQ=MONTH;BYMONTHDAY=1") threw JSON.parse SyntaxError. The
  // try/catch was OUTSIDE the for-loop, so the exception killed the
  // whole batch — every subsequent task got skipped, on every cron run,
  // forever, until that one bad row was repaired.
  const src = fs.readFileSync(path.join(__dirname, '../routes/tasks.js'), 'utf8');
  const fn = src.match(/async function extendAllRecurring\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'extendAllRecurring function present');
  // Must contain an inner try/catch around the JSON.parse step.
  assert.ok(/try \{\s*\n\s*rule = typeof task\.recurrence_rule === 'string'\s*\n[\s\S]*?\} catch \(parseErr\)/.test(fn[0]),
    'JSON.parse must be wrapped in its own try/catch so a malformed rule skips one task instead of killing the batch');
  // Must `continue` on parse failure rather than re-throwing.
  assert.ok(/catch \(parseErr\) \{[\s\S]*?continue;\s*\}/.test(fn[0]),
    'parseErr handler must `continue` to the next task');
  // Warning log must name the task id so the operator can find it.
  assert.ok(/\[recurring\][\s\S]*?\$\{task\.id\}[\s\S]*?recurrence_rule is not JSON/.test(fn[0]),
    'parseErr handler must log the task id + the offending value preview');
  // generateRecurringInstances also wrapped so an inner failure doesn't
  // kill the batch either (same class of risk, different layer).
  assert.ok(/try \{\s*\n\s*const created = await generateRecurringInstances[\s\S]*?\} catch \(genErr\)/.test(fn[0]),
    'generateRecurringInstances call must also be wrapped to isolate failures');
});
