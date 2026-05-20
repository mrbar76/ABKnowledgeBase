// Regression test for the Bee importer's DB-handle normalization.
//
// The incremental sync (POST /api/bee/sync incremental path) wraps each
// fact / todo / conversation in `withTransaction(async (client) => …)`.
// withTransaction hands its callback a raw pg PoolClient — an object that
// exposes a `.query()` method but is NOT itself callable.
//
// The store helpers (storeFact, storeTodo, storeConversation,
// storeJournal, storeDaily) used `const q = client || query;` then
// `await q(...)`. When handed a PoolClient, `q` became the client object
// and `q(...)` threw "q is not a function" on the first INSERT — so the
// incremental sync failed on every conversation and never succeeded.
//
// The full sync path was unaffected because it passes
// `client.query.bind(client)` (an actual callable).
//
// asQueryFn normalizes all three forms (function / PoolClient / nothing)
// into a callable. These tests lock that contract.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../routes/bee');
const { asQueryFn } = _test;

test('asQueryFn: a plain query function is returned unchanged', () => {
  const fn = async () => ({ rows: [] });
  assert.equal(asQueryFn(fn), fn);
});

test('asQueryFn: a raw PoolClient-like object becomes a callable that delegates to .query', async () => {
  let receivedArgs = null;
  const fakeClient = {
    query: async (...args) => { receivedArgs = args; return { rows: [{ id: 1 }] }; },
  };
  const q = asQueryFn(fakeClient);
  assert.equal(typeof q, 'function', 'asQueryFn(PoolClient) must return a callable');
  const r = await q('INSERT INTO knowledge ...', [1, 2]);
  assert.deepEqual(receivedArgs, ['INSERT INTO knowledge ...', [1, 2]], 'args must reach client.query');
  assert.deepEqual(r.rows, [{ id: 1 }]);
});

test('asQueryFn: the returned PoolClient query keeps `this` bound (the actual bug)', async () => {
  // A real pg PoolClient.query relies on `this`. If asQueryFn returned
  // the bare method instead of a bound one, calling it would lose `this`.
  // A method that reads `this.tag` proves the binding survived.
  const fakeClient = {
    tag: 'pool-client',
    async query() { return { rows: [{ tag: this.tag }] }; },
  };
  const q = asQueryFn(fakeClient);
  const r = await q('SELECT 1');
  assert.equal(r.rows[0].tag, 'pool-client', 'bound query must retain its client as `this`');
});

test('asQueryFn: no arg / non-client object falls back to the module query function', () => {
  // undefined, null, or an object with no .query → module-level `query`.
  // We assert it is callable (don't invoke — no DB in unit tests).
  assert.equal(typeof asQueryFn(undefined), 'function');
  assert.equal(typeof asQueryFn(null), 'function');
  assert.equal(typeof asQueryFn({}), 'function', 'object without .query must fall back, not return the object');
});

test('regression: a PoolClient handed straight through never yields a non-callable', () => {
  // The exact shape withTransaction passes: an object with .query.
  // Before the fix, `client || query` returned this object and the
  // caller did `q(...)` → "q is not a function". asQueryFn must always
  // hand back something callable.
  const poolClient = { query: async () => ({ rows: [] }), release: () => {} };
  assert.equal(typeof asQueryFn(poolClient), 'function',
    'withTransaction\'s PoolClient must normalize to a callable — this is the q-is-not-a-function fix');
});
