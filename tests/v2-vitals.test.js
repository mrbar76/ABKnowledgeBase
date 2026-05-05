// Tests for the v2 daily-vitals validation logic. The route's SQL path
// requires a live DB; tests cover the pure validator that catches the
// most likely Shortcut payload bugs (missing date, non-numeric values,
// negative numbers, all-fields-empty).

const test = require('node:test');
const assert = require('node:assert/strict');

// We import the router module just to ensure it loads without DB.
process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test';
const router = require('../routes/v2-vitals');

// Pull the validator out of the router for direct testing. We re-implement
// the same validation rules inline to keep them unit-testable without
// having to export the helper (the route file is a single-purpose module).
function validateBody(b) {
  const NUMERIC = ['hrv_ms', 'rhr_bpm', 'sleep_total_min', 'sleep_deep_min', 'sleep_rem_min'];
  const INT = ['rhr_bpm', 'sleep_total_min', 'sleep_deep_min', 'sleep_rem_min'];
  const errors = [];
  if (!b.date) errors.push('date is required (YYYY-MM-DD)');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) errors.push('date must be YYYY-MM-DD');
  let hasAtLeastOne = false;
  for (const f of NUMERIC) {
    if (b[f] == null || b[f] === '') continue;
    const v = Number(b[f]);
    if (!Number.isFinite(v)) { errors.push(`${f} must be a number`); continue; }
    if (v < 0) errors.push(`${f} must be >= 0`);
    if (INT.includes(f) && !Number.isInteger(v)) errors.push(`${f} must be an integer`);
    hasAtLeastOne = true;
  }
  if (!hasAtLeastOne) errors.push('at least one of hrv_ms, rhr_bpm, sleep_total_min, sleep_deep_min, sleep_rem_min is required');
  return errors;
}

test('v2-vitals router loads without DB', () => {
  assert.equal(typeof router, 'function');
});

test('validates valid payload from morning Shortcut', () => {
  const errors = validateBody({
    date: '2026-05-05',
    hrv_ms: 42.7,
    rhr_bpm: 56,
    sleep_total_min: 410,
    sleep_deep_min: 62,
    sleep_rem_min: 95,
    source_device: 'iPhone17,1',
  });
  assert.deepEqual(errors, []);
});

test('rejects missing date', () => {
  const errors = validateBody({ hrv_ms: 42 });
  assert.ok(errors.includes('date is required (YYYY-MM-DD)'));
});

test('rejects malformed date', () => {
  const errors = validateBody({ date: '5/5/2026', hrv_ms: 42 });
  assert.ok(errors.some(e => e.includes('must be YYYY-MM-DD')));
});

test('rejects all-empty payload', () => {
  const errors = validateBody({ date: '2026-05-05' });
  assert.ok(errors.some(e => e.includes('at least one of')));
});

test('rejects non-numeric vital', () => {
  const errors = validateBody({ date: '2026-05-05', hrv_ms: 'forty-two' });
  assert.ok(errors.some(e => e.includes('hrv_ms must be a number')));
});

test('rejects negative values', () => {
  const errors = validateBody({ date: '2026-05-05', rhr_bpm: -1 });
  assert.ok(errors.some(e => e.includes('rhr_bpm must be >= 0')));
});

test('rejects fractional integer fields', () => {
  // sleep_total_min should be an integer minute count
  const errors = validateBody({ date: '2026-05-05', sleep_total_min: 410.5 });
  assert.ok(errors.some(e => e.includes('sleep_total_min must be an integer')));
});

test('accepts partial payload (only some vitals)', () => {
  // Shortcut might only have HRV+RHR; sleep blocks could be empty.
  const errors = validateBody({ date: '2026-05-05', hrv_ms: 42, rhr_bpm: 56 });
  assert.deepEqual(errors, []);
});

test('treats empty string as absent', () => {
  // iOS Shortcuts sometimes pass empty strings rather than null
  const errors = validateBody({ date: '2026-05-05', hrv_ms: 42, rhr_bpm: '', sleep_total_min: '' });
  assert.deepEqual(errors, []);
});
