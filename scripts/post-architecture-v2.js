#!/usr/bin/env node
// Posts the 9 AB Brain v2 architecture entries to a deployed AB Brain instance.
// Reads scripts/architecture-v2-entries.json, POSTs each via /api/knowledge,
// captures returned IDs to scripts/architecture-v2-ids.json, then verifies
// retrieval via the tag query.
//
// Usage:
//   ABKB_URL=https://yourapp.railway.app \
//   ABKB_API_KEY=your-key \
//     node scripts/post-architecture-v2.js
//
// The auth header is X-Api-Key (matches Track 1 — query-string auth removed).
// Requires Node 18+ (uses native fetch).

const fs = require('fs');
const path = require('path');

const ABKB_URL = (process.env.ABKB_URL || '').replace(/\/$/, '');
const ABKB_API_KEY = process.env.ABKB_API_KEY || '';

if (!ABKB_URL || !ABKB_API_KEY) {
  console.error('Error: ABKB_URL and ABKB_API_KEY env vars are both required.');
  console.error('  ABKB_URL=https://yourapp.railway.app ABKB_API_KEY=key node scripts/post-architecture-v2.js');
  process.exit(1);
}

const ENTRIES_PATH = path.join(__dirname, 'architecture-v2-entries.json');
const IDS_PATH = path.join(__dirname, 'architecture-v2-ids.json');

const entries = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
console.log(`Loaded ${entries.length} entries from ${ENTRIES_PATH}`);
console.log(`Target: ${ABKB_URL}`);
console.log('');

async function postOne(entry) {
  const res = await fetch(`${ABKB_URL}/api/knowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': ABKB_API_KEY,
    },
    body: JSON.stringify(entry),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON response: ${text.slice(0, 200)}`); }
}

async function verify() {
  const res = await fetch(`${ABKB_URL}/api/knowledge?tag=architecture-v2&limit=20`, {
    headers: { 'X-Api-Key': ABKB_API_KEY },
  });
  if (!res.ok) throw new Error(`verify HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

(async () => {
  const results = [];
  let posted = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const r = await postOne(entry);
      results.push({ title: entry.title, id: r.id, status: 'posted' });
      posted++;
      console.log(`  ✓ ${entry.title.padEnd(55)} → ${r.id}`);
    } catch (err) {
      results.push({ title: entry.title, error: err.message, status: 'failed' });
      failed++;
      console.error(`  ✗ ${entry.title.padEnd(55)} → ${err.message}`);
    }
  }

  fs.writeFileSync(IDS_PATH, JSON.stringify(results, null, 2));
  console.log('');
  console.log(`Wrote ${results.length} results to ${IDS_PATH}`);
  console.log(`Summary: ${posted} posted, ${failed} failed`);

  if (failed > 0) {
    console.error('');
    console.error('Some entries failed. Inspect the IDs file for details. You can re-run safely —');
    console.error('successful entries will be duplicated unless you remove them first via the API.');
    process.exit(1);
  }

  console.log('');
  console.log('Verifying via tag query…');
  try {
    const v = await verify();
    console.log(`  Tag "architecture-v2" returns count: ${v.count}`);
    if (v.count !== entries.length) {
      console.warn(`  Note: expected ${entries.length}, got ${v.count}. May indicate prior entries with the same tag.`);
    }
  } catch (err) {
    console.error(`  Verify failed: ${err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('Done. To pull these in a future session, use the bridge prompt:');
  console.log('');
  console.log('  GET /api/knowledge?tag=architecture-v2');
  console.log('  For each id, GET /api/knowledge/:id and read the full content.');
  console.log('  For this session focus on: <topic>');
  console.log('');
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
