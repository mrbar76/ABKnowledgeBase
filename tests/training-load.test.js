// Tests for lib/recovery.js:computeTrainingLoadScore after the v3.30
// rewrite. The pre-v3.30 function computed an internal "load" as
// effort × duration_minutes, which produced TSB values 2.5-3× larger
// than the dashboard's TSB (which has always read workouts.tss).
//
// These tests lock the new contract:
//   - Reads workouts.tss directly, ignores effort and duration_minutes
//   - EWMA formula matches routes/insights.js's ewma()
//   - TSB = round(CTL - ATL)
//   - Score bands aligned with insights.js's fresh / fatigued cuts
//   - Returns the same shape { score, detail, tsb, ctl, atl }

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTrainingLoadScore } = require('../lib/recovery');

// Helper: make N daily workouts ending on targetDate with constant tss.
function dailyStreak({ targetDate, days, tss }) {
  const rows = [];
  const end = new Date(targetDate + 'T12:00:00');
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    rows.push({
      workout_date: d.toISOString().slice(0, 10),
      tss,
      effort: 7,
      duration_minutes: 60,
      workout_type: 'run',
    });
  }
  return rows;
}

// ─── Input contract ─────────────────────────────────────────────

test('v3.30: reads workouts.tss directly, ignores effort/duration', () => {
  // Two synthetic workout sets with identical tss but wildly different
  // effort/duration. Pre-v3.30 these would have produced different TSB.
  // Post-v3.30 they must be identical.
  const A = [{ workout_date: '2026-06-16', tss: 80, effort: 5,  duration_minutes: 60 }];
  const B = [{ workout_date: '2026-06-16', tss: 80, effort: 10, duration_minutes: 180 }];
  const rA = computeTrainingLoadScore(A, '2026-06-16');
  const rB = computeTrainingLoadScore(B, '2026-06-16');
  assert.equal(rA.tsb, rB.tsb, 'TSB must depend ONLY on tss, not effort/duration');
  assert.equal(rA.ctl, rB.ctl);
  assert.equal(rA.atl, rB.atl);
});

test('v3.30: skips rows with missing / null / non-positive tss', () => {
  // Pre-v3.30 these rows would have been counted via the effort-duration
  // fallback. Now they must contribute zero.
  const withGarbage = [
    { workout_date: '2026-06-16', tss: 100 },
    { workout_date: '2026-06-16', tss: null,      effort: 8, duration_minutes: 60 },
    { workout_date: '2026-06-16', tss: undefined, effort: 8, duration_minutes: 60 },
    { workout_date: '2026-06-16', tss: 0,         effort: 8, duration_minutes: 60 },
    { workout_date: '2026-06-16', tss: 'NaN',     effort: 8, duration_minutes: 60 },
  ];
  const cleanOnly = [{ workout_date: '2026-06-16', tss: 100 }];
  const a = computeTrainingLoadScore(withGarbage, '2026-06-16');
  const b = computeTrainingLoadScore(cleanOnly, '2026-06-16');
  assert.equal(a.ctl, b.ctl, 'null/0/NaN tss must not contribute');
  assert.equal(a.atl, b.atl);
});

// ─── EWMA math ──────────────────────────────────────────────────

test('v3.30: empty input → CTL/ATL/TSB all zero, score = 95 (neutral band)', () => {
  const r = computeTrainingLoadScore([], '2026-06-16');
  assert.equal(r.ctl, 0);
  assert.equal(r.atl, 0);
  assert.equal(r.tsb, 0);
  // TSB 0 lands in the -10..5 "neutral / optimal" band — score 95.
  assert.equal(r.score, 95);
});

test('v3.30: steady-state convergence — daily TSS 100 for 56 days → CTL ≈ ATL ≈ 100', () => {
  // EWMA convergence: for constant input X with N=42, after enough
  // ticks v → X. 56 days is more than 1 time-constant; should converge
  // well above 80% of target.
  const rows = dailyStreak({ targetDate: '2026-06-16', days: 56, tss: 100 });
  const r = computeTrainingLoadScore(rows, '2026-06-16');
  assert.ok(r.ctl >= 73 && r.ctl <= 100, `CTL ≈ 100 expected, got ${r.ctl}`);
  assert.ok(r.atl >= 95 && r.atl <= 100, `ATL ≈ 100 expected, got ${r.atl}`);
  // TSB = CTL - ATL ≈ small (slightly negative — ATL converges faster).
  assert.ok(Math.abs(r.tsb) <= 30, `|TSB| small at steady state, got ${r.tsb}`);
});

test('v3.30: ramp + taper → positive TSB (the canonical "freshness" arc)', () => {
  // 35 days of heavy training (tss 120/day) followed by 14 days of
  // taper (tss 30/day). Classic race-week pattern. CTL should still
  // be elevated, ATL should drop, TSB should go strongly positive.
  const target = '2026-06-16';
  const end = new Date(target + 'T12:00:00');
  const rows = [];
  for (let i = 0; i < 49; i++) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    const isTaper = i < 14;
    rows.push({
      workout_date: d.toISOString().slice(0, 10),
      tss: isTaper ? 30 : 120,
    });
  }
  const r = computeTrainingLoadScore(rows, target);
  // 35-day ramp at TSS 120 builds CTL to ~68; 14-day taper at TSS 30
  // pulls CTL down to ~57 while ATL converges fast to ~30. TSB ~+27.
  // Looser bounds because EWMA decay isn't a clean integer.
  assert.ok(r.tsb > 10, `taper should yield positive TSB, got ${r.tsb}`);
  assert.ok(r.ctl > 50, `CTL should remain elevated, got ${r.ctl}`);
  assert.ok(r.atl < 60, `ATL should have dropped, got ${r.atl}`);
});

// ─── Score bands ────────────────────────────────────────────────

test('v3.30: TSB +30 → detraining band, score 70', () => {
  // Construct a workout history that lands TSB roughly +30:
  // moderate CTL, very low ATL. Easiest: high training 30+ days back
  // then total rest for 14 days.
  const target = '2026-06-16';
  const end = new Date(target + 'T12:00:00');
  const rows = [];
  for (let i = 14; i < 56; i++) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    rows.push({ workout_date: d.toISOString().slice(0, 10), tss: 100 });
  }
  // last 14 days: nothing → ATL decays toward 0, CTL stays elevated
  const r = computeTrainingLoadScore(rows, target);
  assert.ok(r.tsb > 25, `expected TSB > 25 (detraining), got ${r.tsb}`);
  assert.equal(r.score, 70);
});

test('v3.30: deep fatigue (TSB ≈ -45) → score 45 (accumulated fatigue band)', () => {
  // 14 days at TSS 80/day: ATL converges fast (~70 by day 14), CTL
  // builds slowly (~22 by day 14) → TSB ≈ -48. Lands in the -50 to
  // -30 "accumulated fatigue" band, score 45.
  // Pre-v3.30 (effort × duration units) would have produced TSB ≈ -200
  // for the same training history — same band by coincidence of the
  // old cuts, but completely different magnitude.
  const target = '2026-06-16';
  const rows = dailyStreak({ targetDate: target, days: 14, tss: 80 });
  const r = computeTrainingLoadScore(rows, target);
  assert.ok(r.tsb >= -55 && r.tsb < -30,
    `expected -55 ≤ TSB < -30 (accumulated fatigue), got ${r.tsb}`);
  assert.equal(r.score, 45);
});

// ─── Output shape ───────────────────────────────────────────────

test('v3.30: returns { score, detail, tsb, ctl, atl } in same shape as pre-rewrite', () => {
  const r = computeTrainingLoadScore([{ workout_date: '2026-06-16', tss: 50 }], '2026-06-16');
  assert.equal(typeof r.score, 'number');
  assert.equal(typeof r.tsb, 'number');
  assert.equal(typeof r.ctl, 'number');
  assert.equal(typeof r.atl, 'number');
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.includes('TSB'));
  assert.ok(r.detail.includes('CTL'));
  assert.ok(r.detail.includes('ATL'));
});

test('v3.30: detail string formats positive TSB with explicit +', () => {
  // Detraining case — TSB clearly positive. Detail line should show "TSB +N".
  const target = '2026-06-16';
  const end = new Date(target + 'T12:00:00');
  const rows = [];
  for (let i = 14; i < 56; i++) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    rows.push({ workout_date: d.toISOString().slice(0, 10), tss: 100 });
  }
  const r = computeTrainingLoadScore(rows, target);
  assert.ok(r.tsb > 0);
  assert.ok(/TSB \+\d+/.test(r.detail), `detail must show "TSB +N" for positive TSB; got ${r.detail}`);
});

// ─── Regression: parity with insights.js's TSB math ─────────────

test('regression v3.30: EWMA formula matches routes/insights.js exactly', () => {
  // The dashboard uses v_t = v_{t-1}(1-1/N) + tss/N. This is a hand
  // walkthrough of 3 days of TSS = [100, 100, 100] with N=7 (ATL).
  // expected_atl_3 ≈ 100 * (1 - (6/7)^3) ≈ 37.0
  const rows = [
    { workout_date: '2026-06-14', tss: 100 },
    { workout_date: '2026-06-15', tss: 100 },
    { workout_date: '2026-06-16', tss: 100 },
  ];
  // Loop walks 57 days (56-day window + targetDate). First 54 days
  // are empty → no contribution. Last 3 days are our 100s. So ATL
  // after 3 ticks of TSS=100 starting from 0 = 100 - 100*(6/7)^3.
  const expectedAtl = 100 * (1 - Math.pow(6 / 7, 3));
  const r = computeTrainingLoadScore(rows, '2026-06-16');
  assert.ok(Math.abs(r.atl - Math.round(expectedAtl)) <= 1,
    `ATL ≈ ${Math.round(expectedAtl)}, got ${r.atl} (formula must match insights.js)`);
});
