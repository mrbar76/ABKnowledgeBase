// Tests for routes/insights.js:computeTSS after v3.31 — replaced the
// effort fallback with an IF² mirror and added duration_minutes as a
// fallback when the text time_duration parser fails.
//
// Pre-v3.31 issues these tests guard against:
//   1. Effort fallback used (durMin × effort × 1.5) capped at 200,
//      which blew past 100 TSS/hr on any 1+ hour session and biased
//      every long strength row upward.
//   2. The default `Number(workout.effort) || 5` silently imputed
//      effort=5 for every row with no effort set, inflating CTL with
//      phantom moderate-load sessions.
//   3. Text time_duration parser (h:mm:ss / mm:ss only) returned 0 for
//      "45 min", "90", "1.5 hr" etc. — TSS came out NULL on rows where
//      duration_minutes had the real value sitting right there.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test-key';
const { computeTSS } = require('../routes/insights');

const ZONES = { lthr: 165, max_hr: 190 };

// ─── HR-based TSS (unchanged behavior) ──────────────────────────

test('HR path: 60 min, avgHR 145, LTHR 165 → 77 TSS', () => {
  // IF = 145/165 = 0.879, TSS = 1 × 0.879² × 100 = 77
  const r = computeTSS({ duration_minutes: 60, heart_rate_avg: '145' }, ZONES);
  assert.equal(r, 77);
});

test('HR path: avgHR string with bpm suffix parses cleanly', () => {
  const r = computeTSS({ duration_minutes: 60, heart_rate_avg: '145 bpm' }, ZONES);
  assert.equal(r, 77, 'numeric extractor must strip non-digits');
});

test('HR path: zones missing LTHR but has max_hr → 88% fallback', () => {
  // LTHR = round(190 × 0.88) = 167. IF = 145/167 = 0.868. TSS = 75.
  const r = computeTSS({ duration_minutes: 60, heart_rate_avg: '145' }, { max_hr: 190 });
  assert.equal(r, 75);
});

// ─── v3.31 effort fallback ──────────────────────────────────────

test('v3.31 effort fallback: 75 min, effort 8 → 80 TSS, 64 TSS/hr', () => {
  // 1.25 hr × (8/10)² × 100 = 1.25 × 0.64 × 100 = 80
  // 80 × 60 / 75 = 64 TSS/hr — below the 100 flag threshold → WRITE
  const r = computeTSS({ duration_minutes: 75, effort: 8 }, ZONES);
  assert.equal(r, 80);
});

test('v3.31 effort fallback: 60 min, effort 10 caps naturally at 100 TSS/hr', () => {
  // 1.0 × (10/10)² × 100 = 100. Per hour: 100. Exactly the threshold.
  const r = computeTSS({ duration_minutes: 60, effort: 10 }, ZONES);
  assert.equal(r, 100);
});

test('v3.31 effort fallback: effort >10 clamped to 10 (no inflation past max)', () => {
  // Defensive: a stray 12 in the effort column shouldn't yield 144 TSS/hr.
  const r = computeTSS({ duration_minutes: 60, effort: 12 }, ZONES);
  assert.equal(r, 100);
});

test('v3.31 effort fallback: 30 min, effort 5 → 13 TSS, 26 TSS/hr', () => {
  // 0.5 × (5/10)² × 100 = 0.5 × 0.25 × 100 = 12.5 → 13
  const r = computeTSS({ duration_minutes: 30, effort: 5 }, ZONES);
  assert.equal(r, 13);
});

test('v3.31 effort fallback: 120 min strength at effort 7 → 49 TSS/hr (the strength case)', () => {
  // The peak-block scenario from the user request — 2-hour strength
  // session, effort 7, no HR. Pre-v3.31: (120 × 7 × 1.5) = 1260 raw,
  // capped to 200 → 100 TSS/hr. Post-v3.31: 2 × 0.49 × 100 = 98 TSS,
  // 49 TSS/hr → WRITE, no flag.
  const r = computeTSS({ duration_minutes: 120, effort: 7 }, ZONES);
  assert.equal(r, 98);
});

// ─── v3.31: no-imputation guards ────────────────────────────────

test('v3.31: returns null when no HR AND no effort (no silent imputation)', () => {
  // Pre-v3.31 the `Number(workout.effort) || 5` default silently
  // imputed effort=5 for every effort-less row. That phantom-load
  // inflation is gone — return null instead, so downstream callers
  // can decide whether to skip or backfill manually.
  const r = computeTSS({ duration_minutes: 60 }, ZONES);
  assert.equal(r, null);
});

test('v3.31: effort 0 → null (treated as no effort)', () => {
  const r = computeTSS({ duration_minutes: 60, effort: 0 }, ZONES);
  assert.equal(r, null);
});

// ─── v3.31: duration_minutes fallback ───────────────────────────

test('v3.31: prefers numeric duration_minutes over text time_duration', () => {
  // Both set, numeric wins. (Should agree, but if they disagree the
  // numeric column is canonical.)
  const r = computeTSS({
    duration_minutes: 60,
    time_duration: '01:00:00',
    heart_rate_avg: '145',
  }, ZONES);
  assert.equal(r, 77);
});

test('v3.31: falls back to text time_duration when duration_minutes missing', () => {
  // 01:00:00 → 3600 sec → 1 hr × 0.879² × 100 = 77
  const r = computeTSS({
    time_duration: '01:00:00',
    heart_rate_avg: '145',
  }, ZONES);
  assert.equal(r, 77);
});

test('v3.31: text time_duration "45 min" was unparseable pre-v3.31 — numeric fallback rescues it', () => {
  // Pre-v3.31: durationToSeconds("45 min") = 0 → TSS = null.
  // Post-v3.31: duration_minutes=45 wins, TSS computed correctly.
  // 0.75 × (7/10)² × 100 = 0.75 × 0.49 × 100 = 37 (effort fallback)
  const r = computeTSS({
    time_duration: '45 min',  // unparseable
    duration_minutes: 45,     // numeric fallback
    effort: 7,
  }, ZONES);
  assert.equal(r, 37);
});

test('v3.31: returns null when both duration columns are unusable', () => {
  // Neither text nor numeric → null, no phantom TSS.
  const r = computeTSS({
    time_duration: 'unparseable',
    heart_rate_avg: '145',
    effort: 7,
  }, ZONES);
  assert.equal(r, null);
});

// ─── Regression: the user's three sample scenarios ──────────────

test("sample 1 (endurance run): 60 min, HR 145, LTHR 165 → 77 TSS, 77/hr (WRITE)", () => {
  const r = computeTSS({ duration_minutes: 60, heart_rate_avg: '145', effort: 6 }, ZONES);
  assert.equal(r, 77);
  const tssPerHour = (r * 60) / 60;
  assert.equal(tssPerHour, 77);
  assert.ok(tssPerHour <= 100, 'sample 1 must not flag');
});

test('sample 2 (hard intervals): 45 min, HR 175, LTHR 165 → 84 TSS, 112/hr (FLAG)', () => {
  // IF = 175/165 = 1.061, TSS = 0.75 × 1.061² × 100 = 84.4 → 84
  // Per hour: 84 × 60 / 45 = 112
  const r = computeTSS({ duration_minutes: 45, heart_rate_avg: '175' }, ZONES);
  assert.equal(r, 84);
  const tssPerHour = (r * 60) / 45;
  assert.ok(tssPerHour > 100, `sample 2 must trip flag threshold, got ${tssPerHour}/hr`);
});

test("sample 3 (strength, no HR, effort 8): 75 min → 80 TSS, 64/hr (WRITE, post-v3.31)", () => {
  // Pre-v3.31 would have been (75 × 8 × 1.5) = 900 capped to 200, 160/hr → FLAG.
  // Post-v3.31: 1.25 × 0.64 × 100 = 80, 64/hr → WRITE.
  const r = computeTSS({ duration_minutes: 75, effort: 8 }, ZONES);
  assert.equal(r, 80);
  const tssPerHour = (r * 60) / 75;
  assert.equal(tssPerHour, 64);
  assert.ok(tssPerHour <= 100, 'sample 3 must WRITE under v3.31, not FLAG');
});
