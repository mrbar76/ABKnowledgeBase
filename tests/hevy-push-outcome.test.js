// lib/hevy-push-outcome.js tests
//
// Verifies every return shape pushPlanToHevy can emit translates to a
// non-null detail when status is not 'synced'. v3.12 closes the
// silent-failure loop flagged by the planning agent: failed pushes now
// surface a usable reason in hevy_push_detail instead of null.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { derivePushOutcome } = require('../lib/hevy-push-outcome');

// ─── Synced path ─────────────────────────────────────────────────────

test('synced: ok=true with segments_pushed', () => {
  const r = derivePushOutcome({ ok: true, segments_pushed: 2, total_hevy_segments: 3 });
  assert.equal(r.status, 'synced');
  assert.equal(r.detail, '2/3 segments');
});

test('synced: ok=true without counts falls back to "pushed"', () => {
  const r = derivePushOutcome({ ok: true });
  assert.equal(r.status, 'synced');
  assert.equal(r.detail, 'pushed');
});

// ─── Top-level skipped ───────────────────────────────────────────────

test('skipped: top-level skipped string preserved', () => {
  const r = derivePushOutcome({ ok: false, skipped: 'no_api_key' });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail, 'no_api_key');
});

test('skipped: no_segments_with_logging_target_hevy', () => {
  const r = derivePushOutcome({ ok: false, skipped: 'no_segments_with_logging_target_hevy' });
  assert.equal(r.status, 'skipped');
  assert.match(r.detail, /no_segments/);
});

// ─── Top-level error ─────────────────────────────────────────────────

test('failed: top-level error string preserved', () => {
  const r = derivePushOutcome({ ok: false, error: 'plan not found' });
  assert.equal(r.status, 'failed');
  assert.equal(r.detail, 'plan not found');
});

test('failed: hevy_api: prefix passes through (preserves diagnostic prefix)', () => {
  const r = derivePushOutcome({ ok: false, error: 'hevy_api: Hevy POST /routines → 400: bad request' });
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /hevy_api:/);
  assert.match(r.detail, /400/);
});

// ─── Aggregator fallback: results[] only ─────────────────────────────

test('aggregator: per-segment errors stitched into top-level detail', () => {
  // This is the exact bug v3.12 fixes — okCount === 0 with no top-level
  // skipped/error, only per-segment results. Pre-v3.12, autoPushToHevy
  // returned { status: 'failed', detail: null }. Now it walks results[].
  const r = derivePushOutcome({
    ok: false,
    segments_pushed: 0,
    total_hevy_segments: 2,
    results: [
      { ok: false, segment_id: 'aaaa1111', error: 'hevy_api: Hevy POST /routines → 400: bad payload' },
      { ok: false, segment_id: 'bbbb2222', error: 'no folder_id (set HEVY_ROUTINE_FOLDER_ID env var or pass folder_id in body)' },
    ],
  });
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /hevy_api:/);
  assert.match(r.detail, /no folder_id/);
});

test('aggregator: mix of errors + skips prefers error (hard failures win)', () => {
  const r = derivePushOutcome({
    ok: false,
    results: [
      { ok: false, segment_id: 'aaaa', error: 'hevy_api: 400' },
      { ok: false, segment_id: 'bbbb', skipped: 'no_resolvable_exercises' },
    ],
  });
  assert.equal(r.status, 'failed', 'hard error beats soft skip');
  assert.match(r.detail, /hevy_api/);
});

test('aggregator: only-skipped results yield skipped status', () => {
  const r = derivePushOutcome({
    ok: false,
    results: [
      { ok: false, segment_id: 'aaaa', skipped: 'no_resolvable_exercises' },
      { ok: false, segment_id: 'bbbb', skipped: 'no_resolvable_exercises' },
    ],
  });
  assert.equal(r.status, 'skipped');
  assert.match(r.detail, /no_resolvable/);
});

// ─── Pathological inputs — never return null detail ──────────────────

test('never null: empty object', () => {
  const r = derivePushOutcome({});
  assert.equal(r.status, 'failed');
  assert.ok(r.detail, 'detail must not be null/empty');
  assert.match(r.detail, /unknown shape/i);
});

test('never null: null input', () => {
  const r = derivePushOutcome(null);
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /returned null/);
});

test('never null: undefined input', () => {
  const r = derivePushOutcome(undefined);
  assert.equal(r.status, 'failed');
  assert.ok(r.detail);
});

test('never null: ok=false with empty results array', () => {
  const r = derivePushOutcome({ ok: false, results: [] });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail);
  assert.match(r.detail, /unknown shape/i);
});
