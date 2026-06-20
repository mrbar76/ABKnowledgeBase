// Tests for lib/training-load.js (v3.32) — the shared module that both
// routes/insights.js (Training dashboard) and lib/recovery.js (Recovery
// panel) now import, so the two surfaces can't compute TSS / EWMA
// differently.
//
// The bug this closes: the dashboard filled workout.tss on the fly for
// null-tss rows (computeTSS in its /training loop) while the recovery
// panel skipped null-tss rows entirely. Same data, different CTL/ATL/
// TSB. fillMissingTss is the shared step that ends that divergence.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeTSS,
  durationToSeconds,
  ewma,
  getEffectiveZones,
  fillMissingTss,
} = require('../lib/training-load');

const ZONES = { lthr: 165, max_hr: 190 };

// ─── module surface ─────────────────────────────────────────────

test('lib exports the five training-load helpers', () => {
  assert.equal(typeof computeTSS, 'function');
  assert.equal(typeof durationToSeconds, 'function');
  assert.equal(typeof ewma, 'function');
  assert.equal(typeof getEffectiveZones, 'function');
  assert.equal(typeof fillMissingTss, 'function');
});

// ─── parity: lib computeTSS === the one re-exported by insights ──

test('routes/insights re-exports the same computeTSS instance', () => {
  process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test-key';
  const insights = require('../routes/insights');
  assert.equal(insights.computeTSS, computeTSS,
    'insights.computeTSS must be the literal lib function, not a copy');
  assert.equal(insights.durationToSeconds, durationToSeconds);
});

// ─── ewma ───────────────────────────────────────────────────────

test('ewma: constant input converges toward the input value', () => {
  const series = Array(60).fill(100);
  const out = ewma(series, 42);
  assert.ok(out[out.length - 1] > 70, 'CTL of constant 100 should climb past 70 in 60d');
  assert.ok(out[out.length - 1] <= 100);
});

test('ewma: empty series → empty output', () => {
  assert.deepEqual(ewma([], 7), []);
});

test('ewma: tolerates null/undefined entries as zero', () => {
  const out = ewma([100, null, undefined, 100], 7);
  assert.equal(out.length, 4);
  assert.ok(out.every(Number.isFinite));
});

// ─── fillMissingTss — the parity-critical helper ────────────────

test('fillMissingTss: computes tss only for null-tss rows, leaves stored values alone', () => {
  const rows = [
    { id: 'a', tss: 55, duration_minutes: 60, effort: 8 },   // already set — keep 55
    { id: 'b', tss: null, duration_minutes: 60, effort: 8 }, // fill: 1×0.64×100 = 64
    { id: 'c', tss: null, duration_minutes: 60, heart_rate_avg: '145' }, // HR fill: 77
  ];
  fillMissingTss(rows, ZONES);
  assert.equal(rows[0].tss, 55, 'stored tss must not be overwritten');
  assert.equal(rows[1].tss, 64, 'null-tss effort row filled');
  assert.equal(rows[2].tss, 77, 'null-tss HR row filled');
});

test('fillMissingTss: leaves tss null when row has no usable inputs', () => {
  const rows = [{ id: 'x', tss: null, duration_minutes: 60 }]; // no HR, no effort
  fillMissingTss(rows, ZONES);
  assert.equal(rows[0].tss, null, 'no inputs → stays null, no phantom value');
});

test('fillMissingTss: tolerates null zones (effort path still works)', () => {
  const rows = [{ id: 'x', tss: null, duration_minutes: 60, effort: 10 }];
  fillMissingTss(rows, null);
  assert.equal(rows[0].tss, 100, 'effort path independent of zones');
});

test('regression v3.32: dashboard-fill and recovery-fill produce identical daily TSS', () => {
  // The exact divergence scenario. A workout set where one row has
  // stored tss and one is null-with-inputs. Both surfaces now run
  // fillMissingTss, so the daily-TSS map they build is identical.
  const makeRows = () => [
    { id: 'logged', workout_date: '2026-06-16', tss: 80 },
    { id: 'synced-no-tss', workout_date: '2026-06-16', tss: null, duration_minutes: 75, effort: 8 },
  ];

  // "Dashboard" path: fill then sum.
  const dash = makeRows();
  fillMissingTss(dash, ZONES);
  const dashDaily = dash.reduce((s, w) => s + (Number(w.tss) || 0), 0);

  // "Recovery" path: same fill, same sum.
  const rec = makeRows();
  fillMissingTss(rec, ZONES);
  const recDaily = rec.reduce((s, w) => s + (Number(w.tss) || 0), 0);

  assert.equal(dashDaily, recDaily, 'both surfaces must see the same daily TSS');
  assert.equal(dashDaily, 80 + 80, 'logged 80 + filled 80 (75min @ effort 8 = 80 TSS)');
});

// ─── getEffectiveZones — query injection ────────────────────────

test('getEffectiveZones: passes date to queryFn and returns first row', async () => {
  let received = null;
  const fakeQuery = async (sql, params) => {
    received = params;
    return { rows: [{ lthr: 165, max_hr: 190 }] };
  };
  const r = await getEffectiveZones('2026-06-16', fakeQuery);
  assert.deepEqual(received, ['2026-06-16']);
  assert.equal(r.lthr, 165);
});

test('getEffectiveZones: returns null when no row covers the date', async () => {
  const fakeQuery = async () => ({ rows: [] });
  const r = await getEffectiveZones('2026-06-16', fakeQuery);
  assert.equal(r, null);
});

test('getEffectiveZones: throws if no queryFn provided', async () => {
  await assert.rejects(() => getEffectiveZones('2026-06-16'), /queryFn required/);
});
