#!/usr/bin/env node
// ============================================================
// Bee → AB Brain Live Sync Daemon
//
// Runs on your Mac, connects to the local Bee proxy's SSE stream,
// and pushes new facts, todos, and conversations to AB Brain
// in real time.
//
// Usage:
//   1. Start the Bee proxy:  bee proxy
//   2. In another terminal:  node bee-live-sync.js
//
// Or run both together:
//   node bee-live-sync.js --start-proxy
//
// Environment variables (or edit defaults below):
//   BEE_PROXY_URL    - default: http://127.0.0.1:8787
//   BRAIN_API        - default: https://ab-brain.up.railway.app/api
//   BRAIN_API_KEY    - your AB Brain API key
//   SYNC_INTERVAL    - periodic full sync interval in minutes (default: 30)
// ============================================================

const http = require('http');
const https = require('https');
const { execSync, spawn } = require('child_process');

// --- Configuration ---
const BEE_PROXY = process.env.BEE_PROXY_URL || 'http://127.0.0.1:8787';
const BRAIN_API = process.env.BRAIN_API || 'https://ab-brain.up.railway.app/api';
const BRAIN_API_KEY = process.env.BRAIN_API_KEY || '';
const SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL || 30) * 60 * 1000; // minutes to ms
const START_PROXY = process.argv.includes('--start-proxy');

let proxyProcess = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;

// --- Logging ---
function log(msg) {
  console.log(`[bee-sync ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// --- HTTP helpers ---
function beeGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BEE_PROXY);
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from Bee: ${data.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function brainPost(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BRAIN_API.replace(/\/api$/, '') + '/api');
    const payload = JSON.stringify(body);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': BRAIN_API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function brainGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BRAIN_API.replace(/\/api$/, '') + '/api');
    const mod = url.protocol === 'https:' ? https : http;

    mod.get(url, {
      headers: { 'X-Api-Key': BRAIN_API_KEY }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from Brain`)); }
      });
    }).on('error', reject);
  });
}

// --- SSE Stream ---
function connectStream() {
  const url = new URL('/v1/stream', BEE_PROXY);
  log(`Connecting to Bee SSE stream at ${url}...`);

  http.get(url, (res) => {
    if (res.statusCode !== 200) {
      log(`Stream returned ${res.statusCode}, retrying...`);
      scheduleReconnect();
      return;
    }

    log('Connected to Bee real-time stream');
    reconnectAttempts = 0;

    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const events = buffer.split('\n\n');
      buffer = events.pop(); // keep incomplete event in buffer

      for (const event of events) {
        if (!event.trim()) continue;
        processSSEEvent(event);
      }
    });

    res.on('end', () => {
      log('Stream ended, reconnecting...');
      scheduleReconnect();
    });

    res.on('error', (err) => {
      log(`Stream error: ${err.message}`);
      scheduleReconnect();
    });
  }).on('error', (err) => {
    log(`Cannot connect to Bee proxy: ${err.message}`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
  setTimeout(connectStream, delay);
}

async function processSSEEvent(raw) {
  try {
    let eventType = 'message';
    let eventData = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) eventData += line.slice(5).trim();
    }

    if (!eventData) return;

    const data = JSON.parse(eventData);
    log(`Event: ${eventType} — ${data.type || data.kind || JSON.stringify(data).substring(0, 80)}`);

    // Handle different event types
    if (eventType === 'fact' || data.type === 'fact') {
      await syncFact(data);
    } else if (eventType === 'todo' || data.type === 'todo') {
      await syncTodo(data);
    } else if (eventType === 'conversation' || data.type === 'conversation') {
      await syncConversation(data);
    } else if (eventType === 'conversation_update' || data.type === 'conversation_update') {
      await syncConversation(data);
    }
  } catch (e) {
    log(`Error processing event: ${e.message}`);
  }
}

// --- Sync individual items ---
async function syncFact(fact) {
  const text = fact.text || fact.content || '';
  if (!text) return;

  const title = `Bee Fact: ${text.substring(0, 80)}`;
  try {
    const result = await brainPost('/api/bee/import', {
      facts: [{ id: fact.id, text, confirmed: fact.confirmed, tags: fact.tags }]
    });
    if (result.imported?.facts > 0) log(`  Saved fact: ${text.substring(0, 60)}`);
    else if (result.imported?.skipped > 0) log(`  Fact already exists, skipped`);
  } catch (e) {
    log(`  Failed to save fact: ${e.message}`);
  }
}

async function syncTodo(todo) {
  const text = todo.text || todo.content || '';
  if (!text) return;

  try {
    const result = await brainPost('/api/bee/import', {
      todos: [{ id: todo.id, text, completed: todo.completed }]
    });
    if (result.imported?.todos > 0) log(`  Saved todo: ${text.substring(0, 60)}`);
    else log(`  Todo already exists, skipped`);
  } catch (e) {
    log(`  Failed to save todo: ${e.message}`);
  }
}

async function syncConversation(convo) {
  const text = convo.text || convo.transcript || convo.content || '';
  if (!text) return;

  const title = convo.title || convo.summary?.substring(0, 80) || `Bee Conversation ${new Date().toLocaleDateString()}`;
  try {
    const result = await brainPost('/api/bee/import', {
      conversations: [{
        id: convo.id,
        title,
        raw_text: text,
        text,
        summary: convo.summary,
        date: convo.date || convo.created_at || new Date().toISOString(),
        duration_seconds: convo.duration_seconds,
        speakers: convo.speakers || convo.speaker_labels
      }]
    });
    if (result.imported?.conversations > 0) log(`  Saved conversation: ${title.substring(0, 60)}`);
    else log(`  Conversation already exists, skipped`);
  } catch (e) {
    log(`  Failed to save conversation: ${e.message}`);
  }
}

// --- Periodic full sync (catch anything the stream missed) ---
async function fullSync() {
  log('Running periodic full sync...');
  let synced = { facts: 0, todos: 0, conversations: 0 };

  try {
    // Sync facts
    const facts = await beeGet('/v1/facts');
    const factList = Array.isArray(facts) ? facts : (facts.facts || facts.data || []);
    if (factList.length) {
      const result = await brainPost('/api/bee/import', {
        facts: factList.map(f => ({ id: f.id, text: f.text, confirmed: f.confirmed, tags: f.tags }))
      });
      synced.facts = result.imported?.facts || 0;
    }
  } catch (e) {
    log(`  Facts sync failed: ${e.message}`);
  }

  try {
    // Sync todos
    const todos = await beeGet('/v1/todos');
    const todoList = Array.isArray(todos) ? todos : (todos.todos || todos.data || []);
    if (todoList.length) {
      const result = await brainPost('/api/bee/import', {
        todos: todoList.map(t => ({ id: t.id, text: t.text, completed: t.completed }))
      });
      synced.todos = result.imported?.todos || 0;
    }
  } catch (e) {
    log(`  Todos sync failed: ${e.message}`);
  }

  try {
    // Sync recent conversations
    const convos = await beeGet('/v1/conversations');
    const convoList = Array.isArray(convos) ? convos : (convos.conversations || convos.data || []);
    for (const c of convoList.slice(0, 20)) {
      try {
        // Get full conversation detail
        const full = await beeGet(`/v1/conversations/${c.id}`);
        const text = full.transcript || full.text || full.content || '';
        if (!text) continue;

        const result = await brainPost('/api/bee/import', {
          conversations: [{
            id: c.id,
            title: full.title || full.summary?.substring(0, 80) || `Bee Conversation`,
            raw_text: text,
            text,
            summary: full.summary,
            date: full.date || full.created_at,
            duration_seconds: full.duration_seconds,
            speakers: full.speakers || full.speaker_labels
          }]
        });
        if (result.imported?.conversations > 0) synced.conversations++;
      } catch (e) { /* skip individual conversation errors */ }
    }
  } catch (e) {
    log(`  Conversations sync failed: ${e.message}`);
  }

  log(`Full sync complete: ${synced.facts} new facts, ${synced.todos} new todos, ${synced.conversations} new conversations`);
}

// --- Startup ---
async function main() {
  if (!BRAIN_API_KEY) {
    console.error('ERROR: Set BRAIN_API_KEY environment variable');
    console.error('  export BRAIN_API_KEY="ab-brain-x7kP9mQ2wR4tY8"');
    process.exit(1);
  }

  // Optionally start bee proxy
  if (START_PROXY) {
    log('Starting bee proxy...');
    proxyProcess = spawn('bee', ['proxy'], { stdio: 'ignore', detached: true });
    proxyProcess.unref();
    // Give it a moment to start
    await new Promise(r => setTimeout(r, 2000));
  }

  // Test connections
  try {
    await beeGet('/v1/me');
    log('Bee proxy connected');
  } catch (e) {
    log(`Cannot reach Bee proxy at ${BEE_PROXY}`);
    log('Make sure "bee proxy" is running in another terminal');
    if (!START_PROXY) {
      log('Or run with --start-proxy to auto-start it');
    }
    process.exit(1);
  }

  try {
    const status = await brainGet('/api/bee/status');
    log(`AB Brain connected (${status.facts} facts, ${status.tasks} tasks, ${status.transcripts} transcripts synced)`);
  } catch (e) {
    log(`Cannot reach AB Brain at ${BRAIN_API}: ${e.message}`);
    process.exit(1);
  }

  // Initial full sync
  await fullSync();

  // Connect to SSE stream for real-time updates
  connectStream();

  // Schedule periodic full syncs as backup
  setInterval(fullSync, SYNC_INTERVAL);

  log(`Live sync running. Full sync every ${SYNC_INTERVAL / 60000} minutes.`);
  log('Press Ctrl+C to stop.');
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  if (proxyProcess) proxyProcess.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (proxyProcess) proxyProcess.kill();
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
