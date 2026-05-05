// v1.10.4 regression tests for the three Coach-flagged bugs +
// the perf optimizations (workout_notes / summary truncation).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coachSrc = fs.readFileSync(path.join(__dirname, '../routes/coach.js'), 'utf8');
const peopleSrc = fs.readFileSync(path.join(__dirname, '../routes/people.js'), 'utf8');

// ─── Bug 1: people interactions matches via substring + emits diagnostics
test('people: interactions uses substring (ILIKE) match in addition to exact', () => {
  const handler = peopleSrc.split("'/:idOrName/interactions'")[1].split('router.post')[0];
  assert.ok(/namesPatterns/.test(handler),
    'must build namesPatterns for ILIKE match');
  assert.ok(/ILIKE pat/.test(handler),
    'must use ILIKE pattern matching against speaker_name / from_name / organizer');
});

test('people: interactions returns diagnostics block when results empty', () => {
  const handler = peopleSrc.split("'/:idOrName/interactions'")[1].split('router.post')[0];
  assert.ok(/diagnostics/.test(handler), 'response must include diagnostics field');
  assert.ok(/bee_speakers_in_window/.test(handler),
    'diagnostics must list unmatched bee speakers');
  assert.ok(/email_senders_in_window/.test(handler),
    'diagnostics must list unmatched email senders');
  assert.ok(/calendar_organizers_in_window/.test(handler),
    'diagnostics must list unmatched calendar organizers');
  assert.ok(/next_step/.test(handler),
    'diagnostics must include actionable next_step hint');
});

// ─── Bug 2: race-pulse adds taper_phase / recommendation / last_28d_build_summary
test('coach: race-pulse derives taper_phase from days_to_race', () => {
  assert.ok(/function taperPhaseFor/.test(coachSrc),
    'taperPhaseFor helper must exist');
  for (const phase of ['recovery','race-day','race-week','taper','sharpen','pre-taper','base']) {
    assert.ok(coachSrc.includes(`'${phase}'`),
      `taperPhaseFor must return '${phase}'`);
  }
});

test('coach: race-pulse exposes recommendation per phase', () => {
  assert.ok(/TAPER_RECOMMENDATIONS/.test(coachSrc),
    'TAPER_RECOMMENDATIONS map must exist');
  const handler = coachSrc.split("router.get('/race-pulse'")[1].split('module.exports')[0];
  assert.ok(/taper_phase:/.test(handler), 'response must include taper_phase');
  assert.ok(/recommendation:/.test(handler), 'response must include recommendation');
});

test('coach: race-pulse computes last_28d_build_summary', () => {
  const handler = coachSrc.split("router.get('/race-pulse'")[1].split('module.exports')[0];
  assert.ok(/last_28d_build_summary/.test(handler),
    'response must include last_28d_build_summary');
  // Must aggregate from workouts table over last 28 days
  assert.ok(/CURRENT_DATE - INTERVAL '28 days'/.test(handler),
    'must aggregate workouts last 28 days');
});

// ─── Bug 3: end-of-day plan_vs_actual diff
test('coach: end-of-day returns plan_vs_actual diff', () => {
  const handler = coachSrc.split("router.get('/end-of-day'")[1].split('router.get')[0];
  assert.ok(/plan_vs_actual/.test(handler), 'response must include plan_vs_actual');
  assert.ok(/segments_completed/.test(handler), 'must report segments_completed count');
  assert.ok(/segments_total/.test(handler), 'must report segments_total count');
  assert.ok(/unplanned_workouts/.test(handler), 'must list unplanned workouts');
  assert.ok(/macros_delta/.test(handler), 'must compute macros_delta');
  assert.ok(/effort_delta/.test(handler), 'must compute effort_delta');
});

// ─── Perf: truncate large fields ───────────────────────────────────
test('coach: morning truncates coaching_sessions.summary at 200 chars', () => {
  const handler = coachSrc.split("router.get('/morning'")[1].split('router.get')[0];
  assert.ok(/LEFT\(summary,\s*200\)\s+AS\s+summary/i.test(handler),
    'morning must LEFT(summary, 200) for coaching_sessions');
  assert.ok(/summary_truncated/.test(handler),
    'morning must surface summary_truncated flag');
});

test('coach: morning + midday-amend + end-of-day truncate workout body_notes', () => {
  // Each of these endpoints attaches workouts to plan_segments via subquery.
  // body_notes can be 1000+ chars of prescription; truncate to 200.
  for (const route of ['/morning', '/midday-amend', '/end-of-day']) {
    const handler = coachSrc.split(`router.get('${route}'`)[1].split('router.get')[0];
    if (route === '/end-of-day') {
      // /end-of-day's todayWorkouts query truncates inline (separate from segment subquery)
      assert.ok(/LEFT\(body_notes,\s*200\)/i.test(handler),
        `${route} must truncate body_notes`);
    } else {
      assert.ok(/'body_notes',\s*LEFT\(w\.body_notes,\s*200\)/.test(handler),
        `${route} segment subquery must truncate body_notes`);
    }
  }
});

test('coach: segment subqueries select narrow columns, not w.*', () => {
  // Was: SELECT json_agg(w.* ...) — returned every column including huge notes
  // Now: SELECT json_agg(json_build_object('id', w.id, ...)) — explicit column list
  for (const route of ['/morning', '/midday-amend', '/end-of-day']) {
    const handler = coachSrc.split(`router.get('${route}'`)[1].split('router.get')[0];
    assert.ok(!/json_agg\(w\.\*/.test(handler),
      `${route} must not use w.* (returns all columns including body_notes)`);
  }
});
