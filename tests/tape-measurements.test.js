// v3.35 Feature 1 — tape (circumference) measurements on body_metrics.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bm = require('../routes/body-metrics');
const { validateBody, computeTapeAnalytics, TAPE_FIELDS } = bm;

// ─── tape-only rows: weight not required ─────────────────────────
test('validateBody: tape-only row is valid without weight_lb', () => {
  const errors = validateBody({
    measurement_date: '2026-10-03',
    measurement_context: 'tape',
    waist_in: 34.5,
  });
  assert.deepEqual(errors, [], `tape-only row should pass, got: ${errors.join('; ')}`);
});

test('validateBody: row with no measurement at all is rejected', () => {
  const errors = validateBody({ measurement_date: '2026-10-03' });
  assert.ok(errors.some(e => /at least one measurement/.test(e)),
    'a row with only a date must be rejected');
});

test('validateBody: weight-only row still valid (RENPHO unchanged)', () => {
  const errors = validateBody({ measurement_date: '2026-10-03', weight_lb: 178.2 });
  assert.deepEqual(errors, []);
});

test('validateBody: weight + tape together valid', () => {
  const errors = validateBody({ measurement_date: '2026-10-03', weight_lb: 178, waist_in: 34, chest_in: 44 });
  assert.deepEqual(errors, []);
});

test('validateBody: bad weight rejected even when tape present', () => {
  const errors = validateBody({ measurement_date: '2026-10-03', weight_lb: -5, waist_in: 34 });
  assert.ok(errors.some(e => /weight_lb must be a positive number/.test(e)));
});

test('validateBody: tape value out of range rejected', () => {
  assert.ok(validateBody({ measurement_date: '2026-10-03', waist_in: 0 }).some(e => /waist_in must be > 0/.test(e)));
  assert.ok(validateBody({ measurement_date: '2026-10-03', neck_in: 150 }).some(e => /neck_in must be <= 99/.test(e)));
});

test('TAPE_FIELDS is the exact agreed set', () => {
  assert.deepEqual([...TAPE_FIELDS].sort(), [
    'arm_relaxed_in', 'chest_in', 'hip_in', 'neck_in', 'shoulders_in', 'thigh_in', 'waist_in',
  ]);
});

// ─── stats/summary tape analytics ────────────────────────────────
test('computeTapeAnalytics: latest, baseline delta, 4wk trend', () => {
  // Three tape rows over ~5 weeks. waist trending down, chest up.
  const rows = [
    { measurement_date: '2026-10-03', waist_in: 35.0, chest_in: 43.0 },
    { measurement_date: '2026-10-20', waist_in: 34.2, chest_in: 43.5 },
    { measurement_date: '2026-11-01', waist_in: 33.6, chest_in: 44.0 },
  ];
  const a = computeTapeAnalytics(rows, null); // default baseline = earliest
  assert.equal(a.baseline_date, '2026-10-03');
  assert.equal(a.latest.waist_in.value, 33.6);
  assert.equal(a.latest.waist_in.date, '2026-11-01');
  // change vs baseline: 33.6 - 35.0 = -1.4
  assert.equal(a.change_vs_baseline.waist_in.baseline, 35.0);
  assert.equal(a.change_vs_baseline.waist_in.latest, 33.6);
  assert.equal(a.change_vs_baseline.waist_in.delta, -1.4);
  assert.equal(a.change_vs_baseline.chest_in.delta, 1.0);
  // 4-week trend anchored on latest (2026-11-01) → window back to 2026-10-04,
  // so the 10-03 reading falls just outside; 10-20 and 11-01 are in.
  assert.ok(Array.isArray(a.trend_4wk.waist_in));
  const dates = a.trend_4wk.waist_in.map(p => p.date);
  assert.ok(dates.includes('2026-11-01') && dates.includes('2026-10-20'));
  assert.ok(!dates.includes('2026-10-03'), '10-03 is >28d before 11-01, excluded from 4wk window');
});

test('computeTapeAnalytics: explicit baseline_date param', () => {
  const rows = [
    { measurement_date: '2026-10-03', waist_in: 35.0 },
    { measurement_date: '2026-10-20', waist_in: 34.2 },
    { measurement_date: '2026-11-01', waist_in: 33.6 },
  ];
  const a = computeTapeAnalytics(rows, '2026-10-20');
  assert.equal(a.baseline_date, '2026-10-20');
  // baseline is first row on/after 10-20 → 34.2; delta 33.6-34.2 = -0.6
  assert.equal(a.change_vs_baseline.waist_in.baseline, 34.2);
  assert.equal(a.change_vs_baseline.waist_in.delta, -0.6);
});

test('computeTapeAnalytics: empty when no tape rows', () => {
  const a = computeTapeAnalytics([], null);
  assert.equal(a.baseline_date, null);
  assert.deepEqual(a.latest, {});
  assert.deepEqual(a.change_vs_baseline, {});
});

// ─── Hevy tape mapping (in → cm, single-side → left_*) ───────────
test('hevy abMetricsToHevy: tape inches → cm on correct Hevy fields', () => {
  process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test-key';
  // abMetricsToHevy isn't exported; assert the mapping via a source check
  // instead (the function is small and pure but private). We verify the
  // conversion math + field names are present in source.
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/hevy.js'), 'utf8');
  // in→cm factor
  assert.ok(/\* 2\.54/.test(src), 'inToCm must multiply by 2.54');
  // field mapping present — each AB field → list of Hevy field(s).
  // Single-value fields → one Hevy field; arm/thigh fan out to BOTH sides.
  for (const [ab, hevyList] of [
    ['waist_in', "['waist']"],
    ['chest_in', "['chest_cm']"],
    ['arm_relaxed_in', "['left_bicep_cm', 'right_bicep_cm']"],
    ['shoulders_in', "['shoulder_cm']"],
    ['thigh_in', "['left_thigh', 'right_thigh']"],
    ['hip_in', "['hips']"],
    ['neck_in', "['neck_cm']"],
  ]) {
    assert.ok(src.includes(`${ab}: ${hevyList}`),
      `AB_TAPE_TO_HEVY must map ${ab} → ${hevyList}`);
  }
});
