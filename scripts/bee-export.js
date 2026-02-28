#!/usr/bin/env node
/**
 * Bee Data Export — pulls all data from the Bee Cloud API and saves
 * it as organized JSON files under data/bee-export/.
 *
 * Usage:
 *   BEE_API_TOKEN=<token> node scripts/bee-export.js
 *   BEE_API_TOKEN=<token> node scripts/bee-export.js --since 2025-12-26
 *   BEE_API_TOKEN=<token> node scripts/bee-export.js --output-dir ./my-export
 *
 * Get your token:
 *   1. Run "bee login" on your Mac
 *   2. Copy from ~/.bee/token-prod
 *
 * Output structure:
 *   data/bee-export/
 *     daily-summaries/YYYY-MM-DD.json
 *     conversations/YYYY-MM-DD-slug.json
 *     journals/YYYY-MM-DD.json
 *     facts.json
 *     todos.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const BEE_API = 'https://app-api-developer.ce.bee.amazon.dev';
const BEE_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDfzCCAmegAwIBAgIRANp9rGecKAk6t6XGd3GWVHkwDQYJKoZIhvcNAQELBQAw
WTELMAkGA1UEBhMCVVMxDDAKBgNVBAoMA0JlZTEaMBgGA1UECwwRVHJ1c3QgYW5k
IFByaXZhY3kxIDAeBgNVBAMMF0JlZUNlcnRpZmljYXRlQXV0aG9yaXR5MB4XDTI1
MDgyMTE5MjUyNloXDTM1MDgyMTIwMjUyNlowWTELMAkGA1UEBhMCVVMxDDAKBgNV
BAoMA0JlZTEaMBgGA1UECwwRVHJ1c3QgYW5kIFByaXZhY3kxIDAeBgNVBAMMF0Jl
ZUNlcnRpZmljYXRlQXV0aG9yaXR5MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEA7a4dWfEBlstJGQWx2MG9fInEWw4v5e2Sasiw8D09fW77VbSskLEectYl
t8XgM8a2O9JAPkCQ3vNJmIO+6etyPj/DEtjwllSPR5/1qcZXGFMbjRGzmDz2Y6Mr
uPlrGYZZQgSNrnuSSndADCrqSEGLdBzkjXqkuXLXDqdLLTzseNQVfCiN2LDCwFRD
Ugjw4KuiJzSBZ1CQEdug4qauitcif6NOFEiTViAOkXjSmjAdTjN0GDKQdTmDtQYg
NfLuhhfmEB9mdiEm3++AUURQ2Cn+MfP2YAy/5gr3t+ydPRx361mbA1UiWnx7lmLU
xRmZhzeaDmO8vUxxM1jHSXLNxMPMUwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBRAKKN5ASGNfQOKcsdpaFwNki78xzAOBgNVHQ8BAf8EBAMCAYYw
DQYJKoZIhvcNAQELBQADggEBADXy/YcenRwuAbCH57sFcwe/akWsdh7bs9ZNb7dq
g6qzDpitO8yhpEK1DSW2Nmbtxd59rhV5jmnAfFHLEoeOlsSeBLADH3/3uRLV1kIR
M3kUPKOv1FJq7UkK2VzgabpehyeJ4lfozfT983b3AoDvI6quf3Dl2NrCmmUUewrZ
6g+RSR6n6Q/PalGUPtoV+W4OT5j9hS1d0PSNO6QbRRFzW+NZ+aQdLwHQPzwjofSh
vM1JjV7Hz2KOPJwmqHQbCiaayGq5lZIVI3UrqnTIqB/hySEBIJNeyHN3ggORH2JJ
wzMF+xiaNYUCir9ZzsgYiEsuaxEyiS96ydDImWJboALiWmE=
-----END CERTIFICATE-----`;

const beeAgent = new https.Agent({ ca: BEE_CA_CERT });

// --- Parse CLI args ---
const args = process.argv.slice(2);
const BEE_TOKEN = process.env.BEE_API_TOKEN || '';
let sinceDate = '2025-12-26';
let outputDir = path.join(__dirname, '..', 'data', 'bee-export');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since' && args[i + 1]) sinceDate = args[++i];
  else if (args[i] === '--output-dir' && args[i + 1]) outputDir = args[++i];
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`Usage: BEE_API_TOKEN=<token> node ${path.basename(__filename)} [options]`);
    console.log('');
    console.log('Options:');
    console.log('  --since YYYY-MM-DD   Only export data after this date (default: 2025-12-26)');
    console.log('  --output-dir PATH    Output directory (default: data/bee-export/)');
    console.log('  --help               Show this help');
    process.exit(0);
  }
}

if (!BEE_TOKEN) {
  console.error('ERROR: Set BEE_API_TOKEN environment variable');
  console.error('  Get it by running "bee login" on your Mac, then: cat ~/.bee/token-prod');
  console.error('');
  console.error(`  BEE_API_TOKEN=<token> node ${path.basename(__filename)}`);
  process.exit(1);
}

// --- Logging ---
function log(msg) {
  console.log(`[bee-export ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// --- HTTP helper ---
function beeApiGet(apiPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, BEE_API);
    const req = https.get(url, {
      agent: beeAgent,
      headers: { 'Authorization': `Bearer ${BEE_TOKEN}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 10 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Response too large (>10MB)'));
        }
      });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid Bee token'));
        if (res.statusCode !== 200) return reject(new Error(`Bee API ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Bee API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractArray(data, primaryKey) {
  if (Array.isArray(data)) return data;
  if (data[primaryKey] && Array.isArray(data[primaryKey])) return data[primaryKey];
  for (const key of ['items', 'results', 'data']) {
    if (data[key] && Array.isArray(data[key])) return data[key];
  }
  const found = Object.values(data).find(v => Array.isArray(v));
  return found || [];
}

function slugify(str) {
  return (str || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// --- Export functions ---

async function exportDailySummaries() {
  log('Exporting daily summaries...');
  const dir = path.join(outputDir, 'daily-summaries');
  let cursor = null;
  let total = 0;

  do {
    const url = '/v1/daily' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    const data = await beeApiGet(url);
    const dailies = extractArray(data, 'daily');
    cursor = data.next_cursor || null;

    for (const day of dailies) {
      const dateStr = day.date || day.created_at || '';
      const dateKey = dateStr ? new Date(dateStr).toISOString().slice(0, 10) : `unknown-${day.id || total}`;

      if (dateStr && new Date(dateStr) < new Date(sinceDate)) continue;

      writeJSON(path.join(dir, `${dateKey}.json`), day);
      total++;
    }
  } while (cursor);

  log(`  Exported ${total} daily summaries`);
  return total;
}

async function exportConversations() {
  log('Exporting conversations...');
  const dir = path.join(outputDir, 'conversations');
  let cursor = null;
  let total = 0;
  let errors = 0;

  do {
    const url = `/v1/conversations?limit=50&created_after=${sinceDate}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const data = await beeApiGet(url);
    const convos = extractArray(data, 'conversations');
    cursor = data.next_cursor || null;

    for (const convo of convos) {
      if (!convo.id) continue;
      if (convo.state === 'CAPTURING') continue;

      // Fetch full conversation detail
      let full = convo;
      try {
        const detail = await beeApiGet(`/v1/conversations/${convo.id}`);
        full = detail.conversation || detail;
      } catch (e) {
        log(`  Warning: Could not fetch detail for ${convo.id}: ${e.message}`);
        errors++;
      }

      const dateStr = convo.start_time || convo.created_at || '';
      const dateKey = dateStr ? new Date(dateStr).toISOString().slice(0, 10) : 'unknown';
      const title = full.short_summary || convo.short_summary || full.summary?.substring(0, 60) || convo.id;
      const slug = slugify(title);
      const fileName = `${dateKey}-${slug}.json`;

      // Save complete data: list item + full detail merged
      const exportData = {
        _exported_at: new Date().toISOString(),
        _list_item: convo,
        ...full,
        // Ensure key fields are at top level for easy access
        id: convo.id,
        summary: full.summary || convo.summary || null,
        short_summary: full.short_summary || convo.short_summary || null,
        location: full.primary_location || convo.primary_location || null,
        location_address: full.primary_location?.address || convo.primary_location?.address || null,
        speakers: full.speakers || convo.speakers || [],
        start_time: convo.start_time || full.start_time || null,
        end_time: convo.end_time || full.end_time || null,
        duration_seconds: convo.end_time && convo.start_time
          ? Math.round((convo.end_time - convo.start_time) / 1000)
          : (full.duration_seconds || null),
        state: convo.state || full.state || null,
        utterances_count: convo.utterances_count || full.utterances_count || null
      };

      writeJSON(path.join(dir, fileName), exportData);
      total++;
    }
  } while (cursor);

  log(`  Exported ${total} conversations${errors ? ` (${errors} detail fetch errors)` : ''}`);
  return total;
}

async function exportJournals() {
  log('Exporting journals...');
  const dir = path.join(outputDir, 'journals');
  let cursor = null;
  let total = 0;

  do {
    const url = '/v1/journals' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    const data = await beeApiGet(url);
    const journals = extractArray(data, 'journals');
    cursor = data.next_cursor || null;

    for (const journal of journals) {
      const dateStr = journal.created_at || journal.date || '';
      const dateKey = dateStr ? new Date(dateStr).toISOString().slice(0, 10) : `unknown-${journal.id || total}`;

      if (dateStr && new Date(dateStr) < new Date(sinceDate)) continue;

      writeJSON(path.join(dir, `${dateKey}.json`), {
        _exported_at: new Date().toISOString(),
        ...journal
      });
      total++;
    }
  } while (cursor);

  log(`  Exported ${total} journals`);
  return total;
}

async function exportFacts() {
  log('Exporting facts...');
  let cursor = null;
  const allFacts = [];

  do {
    const url = '/v1/facts' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    const data = await beeApiGet(url);
    const facts = extractArray(data, 'facts');
    cursor = data.next_cursor || null;
    allFacts.push(...facts);
  } while (cursor);

  writeJSON(path.join(outputDir, 'facts.json'), {
    _exported_at: new Date().toISOString(),
    count: allFacts.length,
    facts: allFacts
  });

  log(`  Exported ${allFacts.length} facts`);
  return allFacts.length;
}

async function exportTodos() {
  log('Exporting todos...');
  let cursor = null;
  const allTodos = [];

  do {
    const url = '/v1/todos' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    const data = await beeApiGet(url);
    const todos = extractArray(data, 'todos');
    cursor = data.next_cursor || null;
    allTodos.push(...todos);
  } while (cursor);

  writeJSON(path.join(outputDir, 'todos.json'), {
    _exported_at: new Date().toISOString(),
    count: allTodos.length,
    todos: allTodos
  });

  log(`  Exported ${allTodos.length} todos`);
  return allTodos.length;
}

// --- Main ---
async function main() {
  log(`Bee Data Export`);
  log(`  Since: ${sinceDate}`);
  log(`  Output: ${outputDir}`);
  log('');

  // Test connection
  try {
    const me = await beeApiGet('/v1/me');
    log(`Connected to Bee as: ${me.name || me.email || JSON.stringify(me).substring(0, 80)}`);
  } catch (e) {
    console.error(`Cannot connect to Bee API: ${e.message}`);
    process.exit(1);
  }

  ensureDir(outputDir);

  const results = {};
  const exporters = [
    ['daily_summaries', exportDailySummaries],
    ['conversations', exportConversations],
    ['journals', exportJournals],
    ['facts', exportFacts],
    ['todos', exportTodos]
  ];

  for (const [name, fn] of exporters) {
    try {
      results[name] = await fn();
    } catch (e) {
      log(`  ERROR exporting ${name}: ${e.message}`);
      results[name] = `error: ${e.message}`;
    }
  }

  log('');
  log('Export complete:');
  for (const [name, count] of Object.entries(results)) {
    log(`  ${name}: ${count}`);
  }
  log(`Files saved to: ${outputDir}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
