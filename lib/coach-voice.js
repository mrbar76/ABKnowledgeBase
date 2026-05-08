// lib/coach-voice.js
//
// Optional LLM rewrite layer over composeCoachRead. Uses the structured
// `coach_read_signals` payload as input; emits the same three-sentence
// shape (lead/body/mute) but in less templated language so the Today
// screen doesn't plateau visually.
//
// Disabled by default. Enable via COACH_LLM_ENABLED=true in env.
// Falls back to the deterministic compose on:
//   - flag off
//   - OPENAI_API_KEY missing
//   - any LLM error or timeout
//
// Cached 5 minutes per signals fingerprint so the Today screen doesn't
// burn tokens on every refresh.

'use strict';

const { composeCoachRead, cleanForUI } = require('./voice');

const MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;

let _openai;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAI = require('openai');
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function isEnabled() {
  return process.env.COACH_LLM_ENABLED === 'true' && !!process.env.OPENAI_API_KEY;
}

// Lightweight in-memory cache. Single-user app; no Redis needed.
const _cache = new Map();
function cacheKey(signals) {
  // Stable fingerprint of the inputs that actually shape the read.
  const y = signals.yesterday || {};
  const t = signals.today || {};
  const r = signals.recovery || {};
  const o = signals.overdue || {};
  const tf = t.top_focus || {};
  return JSON.stringify({
    wc: y.workouts_completed || 0,
    tc: y.tasks_completed || 0,
    yw: (y.workouts && y.workouts[0] && y.workouts[0].title) || '',
    pw: (t.planned_workout && t.planned_workout.title) || '',
    anchor: !!(t.planned_workout && t.planned_workout.is_anchor),
    tfk: tf.kind || '', tft: tf.title || '', tfs: tf.status || '',
    rs: r.score == null ? -1 : r.score,
    oc: o.count || 0, oh: o.hot_count || 0,
    race: signals.race ? `${signals.race.name}:${signals.race.days_away}` : '',
    bp: !!signals.between_phases,
    sb: !!signals.shabbat,
  });
}
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  _cache.set(key, { ts: Date.now(), value });
  // Bound the cache to a small fixed size — single user, low cardinality.
  if (_cache.size > 32) {
    const oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
}

const SYSTEM_PROMPT = [
  'You write the three-sentence morning coach read for a single-user training/productivity app.',
  'Voice: warm, direct, second-person, terse. No emojis. No em dashes (use commas or periods).',
  'No exclamation points. No "you got this", no hype. No idioms.',
  'Lead reacts to yesterday in one sentence.',
  'Body names today\'s main thing in one sentence.',
  'Mute is a quieter follow-up or warning, one sentence, may be empty.',
  'Each sentence is at most 14 words. Each ends with a period.',
  'If a sentence does not have content, return it as an empty string.',
  'Return JSON only: {"lead": "...", "body": "...", "mute": "..."}',
].join(' ');

function buildUserPrompt(signals, deterministic) {
  return JSON.stringify({
    signals: {
      yesterday: signals.yesterday || {},
      today: {
        planned_workout: signals.today && signals.today.planned_workout,
        top_focus: signals.today && signals.today.top_focus,
      },
      recovery: signals.recovery || {},
      overdue: signals.overdue || {},
      race: signals.race || null,
      between_phases: !!signals.between_phases,
      shabbat: !!signals.shabbat,
    },
    deterministic_baseline: deterministic,
  });
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('coach-llm timeout')), ms)),
  ]);
}

/**
 * Rewrite the deterministic coach_read using an LLM, with full fallback.
 * Always returns the same {lead, body, mute} shape. Output runs through
 * cleanForUI so any voice violations the model emits are still scrubbed.
 */
async function composeCoachReadLLM(signals) {
  // Shabbat is canonical — never let the LLM rewrite it.
  if (signals && signals.shabbat) return composeCoachRead(signals);

  const deterministic = composeCoachRead(signals || {});

  if (!isEnabled()) return deterministic;

  const key = cacheKey(signals || {});
  const cached = cacheGet(key);
  if (cached) return cached;

  const client = getOpenAI();
  if (!client) return deterministic;

  try {
    const completion = await withTimeout(
      client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(signals, deterministic) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 200,
      }),
      TIMEOUT_MS,
    );
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return deterministic;
    const parsed = JSON.parse(raw);
    const out = {
      lead: cleanForUI(parsed.lead || ''),
      body: cleanForUI(parsed.body || ''),
      mute: cleanForUI(parsed.mute || ''),
    };
    // Sanity: if model collapsed everything to empty, prefer the
    // deterministic version so the screen still says something useful.
    if (!out.lead && !out.body && !out.mute) return deterministic;
    cacheSet(key, out);
    return out;
  } catch (err) {
    console.warn('[coach-voice] LLM rewrite failed, falling back:', err.message);
    return deterministic;
  }
}

module.exports = {
  composeCoachReadLLM,
  isEnabled,
  // Test seams.
  cacheKey,
  _resetCache: () => _cache.clear(),
};
