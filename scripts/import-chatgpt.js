#!/usr/bin/env node
/**
 * Import ChatGPT exported conversations into AB Knowledge Base
 *
 * Usage:
 *   node scripts/import-chatgpt.js <path-to-conversations.json>
 *
 * Environment:
 *   ABKB_URL    — Your AB Brain URL (default: https://ab-brain.up.railway.app)
 *   ABKB_API_KEY — Your API key
 */

const fs = require('fs');
const path = require('path');

const ABKB_URL = process.env.ABKB_URL || 'https://ab-brain.up.railway.app';
const API_KEY = process.env.ABKB_API_KEY || '';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/import-chatgpt.js <path-to-conversations.json>');
  console.error('');
  console.error('First export your data from ChatGPT:');
  console.error('  chatgpt.com → Profile → Settings → Data Controls → Export Data');
  console.error('  Unzip the download and pass the conversations.json file');
  console.error('');
  console.error('Environment variables:');
  console.error('  ABKB_URL=https://ab-brain.up.railway.app');
  console.error('  ABKB_API_KEY=your-api-key');
  process.exit(1);
}

async function postKnowledge(entry) {
  const res = await fetch(`${ABKB_URL}/api/knowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'X-Api-Key': API_KEY } : {})
    },
    body: JSON.stringify(entry)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

function extractConversationContent(conversation) {
  const messages = [];

  // ChatGPT export has a mapping object with message nodes
  if (conversation.mapping) {
    const nodes = Object.values(conversation.mapping);
    // Sort by create_time where available
    nodes.sort((a, b) => {
      const timeA = a.message?.create_time || 0;
      const timeB = b.message?.create_time || 0;
      return timeA - timeB;
    });

    for (const node of nodes) {
      const msg = node.message;
      if (!msg || !msg.content) continue;

      const role = msg.author?.role || 'unknown';
      if (role === 'system') continue;

      // Extract text content
      let text = '';
      if (msg.content.parts) {
        text = msg.content.parts
          .filter(p => typeof p === 'string')
          .join('\n');
      } else if (msg.content.text) {
        text = msg.content.text;
      }

      if (text.trim()) {
        const label = role === 'user' ? 'You' : 'ChatGPT';
        messages.push(`**${label}:** ${text.trim()}`);
      }
    }
  }

  return messages.join('\n\n---\n\n');
}

function categorizeConversation(title, content) {
  const lower = (title + ' ' + content).toLowerCase();
  if (lower.includes('code') || lower.includes('function') || lower.includes('bug') || lower.includes('error') || lower.includes('api')) return 'code';
  if (lower.includes('meeting') || lower.includes('agenda') || lower.includes('standup')) return 'meeting';
  if (lower.includes('research') || lower.includes('study') || lower.includes('paper')) return 'research';
  if (lower.includes('idea') || lower.includes('brainstorm') || lower.includes('plan')) return 'decision';
  return 'general';
}

async function main() {
  console.log(`Reading ${filePath}...`);
  const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
  const conversations = JSON.parse(raw);

  console.log(`Found ${conversations.length} conversations`);
  console.log(`Target: ${ABKB_URL}`);
  console.log('');

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const title = conv.title || `ChatGPT Conversation ${i + 1}`;

    // Extract the full conversation text
    const content = extractConversationContent(conv);

    // Skip empty conversations
    if (!content || content.trim().length < 20) {
      skipped++;
      continue;
    }

    // Build the knowledge entry
    const entry = {
      title,
      content,
      category: categorizeConversation(title, content),
      tags: ['chatgpt-import', 'conversation'],
      source: 'chatgpt-export',
      ai_source: 'chatgpt',
      metadata: {
        original_id: conv.id || null,
        created: conv.create_time ? new Date(conv.create_time * 1000).toISOString() : null,
        updated: conv.update_time ? new Date(conv.update_time * 1000).toISOString() : null,
        message_count: Object.keys(conv.mapping || {}).length
      }
    };

    try {
      await postKnowledge(entry);
      imported++;
      process.stdout.write(`\r  Imported: ${imported} | Skipped: ${skipped} | Failed: ${failed} | Total: ${i + 1}/${conversations.length}`);
    } catch (err) {
      failed++;
      console.error(`\n  Failed "${title}": ${err.message}`);
    }

    // Small delay to avoid overwhelming the API
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n');
  console.log('Import complete!');
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (empty): ${skipped}`);
  console.log(`  Failed: ${failed}`);
  console.log('');
  console.log(`View your knowledge base at: ${ABKB_URL}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
