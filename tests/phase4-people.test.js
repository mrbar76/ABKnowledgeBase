// Phase 4 people-layer regression tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const peopleSrc = fs.readFileSync(path.join(__dirname, '../routes/people.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('people router loads', () => {
  process.env.HEVY_API_KEY = process.env.HEVY_API_KEY || 'test';
  const router = require('../routes/people');
  assert.equal(typeof router, 'function');
});

test('people router mounted at /api/people', () => {
  assert.ok(serverSrc.includes("require('./routes/people')"), 'people router required');
  assert.ok(/app\.use\('\/api\/people',\s*peopleRoutes\)/.test(serverSrc), 'mounted at /api/people');
});

test('people: GET /:idOrName/interactions registered', () => {
  assert.ok(peopleSrc.includes("router.get('/:idOrName/interactions'"),
    'GET /:idOrName/interactions must be registered');
});

test('people: POST /backfill-interactions registered', () => {
  assert.ok(peopleSrc.includes("router.post('/backfill-interactions'"),
    'POST /backfill-interactions must be registered');
});

test('people: GET / lists contacts ordered by recent interaction', () => {
  assert.ok(peopleSrc.includes("router.get('/'"), 'GET / must list contacts');
  assert.ok(/last_interaction_date DESC/.test(peopleSrc),
    'list ordered by last_interaction_date DESC');
});

test('people: interactions endpoint joins all 3 sources', () => {
  // Bee, email, calendar must all be queried via Promise.all
  const handler = peopleSrc.split("'/:idOrName/interactions'")[1].split('router.post')[0];
  assert.ok(/transcript_speakers/.test(handler), 'must query transcript_speakers');
  assert.ok(/email_messages/.test(handler), 'must query email_messages');
  assert.ok(/calendar_events/.test(handler), 'must query calendar_events');
  assert.ok(handler.includes('Promise.all'), 'must use Promise.all for parallel queries');
});

test('people: interactions endpoint resolves contact by UUID, name, or alias', () => {
  // resolveContact tries: UUID → exact name → alias
  assert.ok(peopleSrc.includes("async function resolveContact"), 'resolveContact helper present');
  const r = peopleSrc.split('async function resolveContact')[1].split('}\n\n')[0];
  assert.ok(/c\.aliases/.test(r), 'must check aliases');
  assert.ok(/UUID/.test(peopleSrc) || /[0-9a-f]{8}-[0-9a-f]{4}/.test(peopleSrc),
    'must accept UUID lookup');
});

test('people: 404 when contact not found', () => {
  assert.ok(/No contact found for/.test(peopleSrc),
    'must return 404 with helpful error when contact not found');
});

test('people: response shape includes person + interactions + stats', () => {
  const handler = peopleSrc.split("'/:idOrName/interactions'")[1].split('router.post')[0];
  assert.ok(/person:/.test(handler), 'response includes person');
  assert.ok(/interactions:/.test(handler), 'response includes interactions');
  assert.ok(/stats:/.test(handler), 'response includes stats');
  assert.ok(/topics_distribution/.test(handler), 'stats includes topics_distribution');
});

test('people: backfill updates last_interaction_date + count_30d + source', () => {
  const backfill = peopleSrc.split("'/backfill-interactions'")[1];
  assert.ok(/last_interaction_date/.test(backfill), 'backfill writes last_interaction_date');
  assert.ok(/last_interaction_source/.test(backfill), 'backfill writes last_interaction_source');
  assert.ok(/interaction_count_30d/.test(backfill), 'backfill writes interaction_count_30d');
});
