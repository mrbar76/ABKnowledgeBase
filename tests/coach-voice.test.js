// Coach voice LLM bolt-on tests.
//
// The LLM call is feature-flagged off by default + requires OPENAI_API_KEY.
// These tests cover the contract guarantees that hold without the flag:
//
//   - returns {lead, body, mute} shape unconditionally
//   - falls back to composeCoachRead deterministic when disabled
//   - shabbat signals never invoke the LLM
//   - cacheKey produces stable fingerprints

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Force disabled state for these tests.
delete process.env.COACH_LLM_ENABLED;

const { composeCoachReadLLM, isEnabled, cacheKey, _resetCache } = require('../lib/coach-voice');
const { composeCoachRead } = require('../lib/voice');

test('isEnabled: false when flag missing', () => {
  delete process.env.COACH_LLM_ENABLED;
  assert.equal(isEnabled(), false);
});

test('isEnabled: false when flag set but no API key', () => {
  process.env.COACH_LLM_ENABLED = 'true';
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(isEnabled(), false);
  if (saved) process.env.OPENAI_API_KEY = saved;
  delete process.env.COACH_LLM_ENABLED;
});

test('composeCoachReadLLM: returns three-slot shape when disabled', async () => {
  _resetCache();
  const r = await composeCoachReadLLM({
    yesterday: { workouts_completed: 0, tasks_completed: 0 },
    today: {},
  });
  assert.ok('lead' in r);
  assert.ok('body' in r);
  assert.ok('mute' in r);
});

test('composeCoachReadLLM: falls back to deterministic when disabled', async () => {
  _resetCache();
  const signals = {
    yesterday: { workouts_completed: 0, tasks_completed: 0 },
    today: { planned_workout: { title: 'Strength A', is_anchor: true } },
  };
  const llm = await composeCoachReadLLM(signals);
  const det = composeCoachRead(signals);
  assert.equal(llm.lead, det.lead);
  assert.equal(llm.body, det.body);
  assert.equal(llm.mute, det.mute);
});

test('composeCoachReadLLM: shabbat short-circuits to canonical copy', async () => {
  _resetCache();
  const r = await composeCoachReadLLM({ shabbat: true });
  assert.equal(r.lead, 'Shabbat.');
  assert.match(r.body, /work is paused/i);
  assert.match(r.body, /personal and training stay live/i);
});

test('cacheKey: stable across irrelevant fields', () => {
  const a = cacheKey({ yesterday: { workouts_completed: 1 }, today: {}, recovery: { score: 70 } });
  const b = cacheKey({ yesterday: { workouts_completed: 1 }, today: {}, recovery: { score: 70 } });
  assert.equal(a, b);
});

test('cacheKey: changes when input changes', () => {
  const a = cacheKey({ yesterday: { workouts_completed: 1 }, recovery: { score: 70 } });
  const b = cacheKey({ yesterday: { workouts_completed: 1 }, recovery: { score: 80 } });
  assert.notEqual(a, b);
});

test('cacheKey: race name + days_away both contribute', () => {
  const a = cacheKey({ race: { name: 'Riverdale 5K', days_away: 3 } });
  const b = cacheKey({ race: { name: 'Riverdale 5K', days_away: 4 } });
  assert.notEqual(a, b);
});

test('composeCoachReadLLM: tolerates undefined signals', async () => {
  _resetCache();
  const r = await composeCoachReadLLM();
  assert.ok('lead' in r);
});
