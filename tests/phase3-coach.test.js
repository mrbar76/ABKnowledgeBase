// Phase 3 composite-endpoint regression tests.
//
// Each test asserts that the route file declares the endpoint with the
// expected shape. We can't hit Postgres from CI, but we can verify the
// route handler is registered and the response keys are produced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coachSrc = fs.readFileSync(path.join(__dirname, '../routes/coach.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('coach router loads', () => {
  process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test';
  const router = require('../routes/coach');
  assert.equal(typeof router, 'function');
});

test('coach router mounted at /api/coach', () => {
  assert.ok(serverSrc.includes("require('./routes/coach')"), 'coach router required');
  assert.ok(/app\.use\('\/api\/coach',\s*coachRoutes\)/.test(serverSrc), 'mounted at /api/coach');
});

const expectedRoutes = [
  '/morning', '/midday-amend', '/preworkout', '/postworkout',
  '/end-of-day', '/weekly', '/race-pulse',
];

for (const route of expectedRoutes) {
  test(`coach: GET ${route} is registered`, () => {
    assert.ok(coachSrc.includes(`router.get('${route}'`), `GET ${route} must be registered`);
  });
}

test('coach: /morning returns the 7 expected top-level keys', () => {
  // Static check — payload object literal contains expected keys
  // (allow ES6 shorthand: `key,` matches `key: value` and `key,`)
  const morningHandler = coachSrc.split("router.get('/morning'")[1];
  const responseBlock = morningHandler.split('res.json(')[1];
  for (const key of [
    'today_plan', 'readiness', 'alerts', 'active_injuries',
    'yesterday_summary', 'recent_coaching',
  ]) {
    const regex = new RegExp(`\\b${key}\\s*[,:}]`);
    assert.ok(regex.test(responseBlock), `/morning response must include ${key}`);
  }
});

test('coach: /preworkout accepts in_minutes query param', () => {
  const handler = coachSrc.split("router.get('/preworkout'")[1].split('router.get')[0];
  assert.ok(handler.includes("req.query.in_minutes"), 'preworkout must accept in_minutes');
});

test('coach: /race-pulse requires race_id', () => {
  const handler = coachSrc.split("router.get('/race-pulse'")[1].split('module.exports')[0];
  assert.ok(handler.includes('race_id is required'), 'race-pulse must validate race_id');
});

test('coach: every endpoint uses Promise.all for parallel queries', () => {
  // Latency budget enforcement — if any endpoint awaits queries
  // sequentially, that's a regression.
  const endpoints = ['/morning', '/midday-amend', '/preworkout', '/postworkout', '/end-of-day', '/weekly', '/race-pulse'];
  for (const route of endpoints) {
    const handler = coachSrc.split(`router.get('${route}'`)[1].split('router.get')[0];
    assert.ok(handler.includes('Promise.all'), `${route} must use Promise.all`);
  }
});

test('coach: readiness includes is_stale per metric', () => {
  // Coach uses is_stale to fall back to subjective Q&A
  const readiness = coachSrc.split('function readinessFromRows')[1].split('async function')[0];
  for (const stale of ['hrvStale', 'rhrStale', 'sleepStale', 'respStale']) {
    assert.ok(readiness.includes(stale), `readiness must compute ${stale}`);
  }
  assert.ok(/is_stale:\s*hrvStale/.test(readiness), 'hrv.is_stale must be exposed');
  assert.ok(/is_stale:\s*sleepStale/.test(readiness), 'sleep.is_stale must be exposed');
});
