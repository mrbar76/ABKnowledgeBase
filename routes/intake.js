// Smart intake — AI-powered auto-classification and filing.
// Accepts any raw input, uses OpenAI GPT-4o-mini to classify it,
// then files it into the correct PostgreSQL table with proper metadata.

const express = require('express');
const { query, logActivity } = require('../db');
const syncStatus = require('../sync-status');
const router = express.Router();

let openai = null;
function getOpenAIClient() {
  if (openai) return openai;
  const OpenAI = require('openai');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured — required for smart intake');
  openai = new OpenAI({ apiKey: key });
  return openai;
}

const CLASSIFICATION_PROMPT = `You are a personal knowledge organizer. Analyze the following input and classify it for filing.

Return ONLY valid JSON with these fields:
{
  "database": one of: "knowledge", "tasks", "transcripts",
  "title": a concise title (max 80 chars),
  "category": for knowledge entries, one of: "general", "code", "meeting", "research", "decision", "reference", "health", "personal", "journal", "daily-summary",
  "tags": array of 1-5 relevant tags (lowercase, short),
  "priority": for tasks only, one of: "low", "medium", "high", "urgent",
  "status": for tasks only, one of: "todo", "in_progress", "review", "done",
  "summary": a 1-2 sentence summary of the content,
  "ai_source": which AI or source created this, one of: "claude", "gemini", "chatgpt", "bee", "manual", or null if unknown,
  "context": one of: "work" or "personal" — detect from content and topics
}

Rules:
- If it looks like a task/action item/todo, use "tasks" database
- If it looks like a conversation transcript or meeting notes, use "transcripts"
- Everything else goes to "knowledge"
- Extract meaningful tags from the content (topics, people, projects mentioned)
- Detect the AI source from context clues (e.g., "Claude suggested..." → "claude")
- If the input already specifies a category or tags, respect those
- Keep the title descriptive but concise
- Detect context: work indicators (meetings, projects, clients, deadlines, budgets, team, deliverables) → "work"; personal indicators (family, health, hobbies, errands, appointments, personal finance) → "personal"
- If context is ambiguous, default to "work"`;

async function classify(userMessage) {
  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFICATION_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  const text = response.choices[0]?.message?.content || '';
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in classification response');
    return JSON.parse(jsonMatch[0]);
  }
}

router.post('/', async (req, res) => {
  try {
    const { input, text, source, context } = req.body;
    const rawInput = input || text;
    if (!rawInput || !rawInput.trim()) return res.status(400).json({ error: 'input is required' });

    let userMessage = rawInput.trim();
    if (context) userMessage = `Context: ${context}\n\n${userMessage}`;
    if (source) userMessage = `[Source: ${source}]\n\n${userMessage}`;

    const classification = await classify(userMessage);
    const db = classification.database || 'knowledge';
    const aiSource = classification.ai_source || source || null;
    let rowId;

    if (db === 'tasks') {
      const result = await query(
        `INSERT INTO tasks (title, description, status, priority, ai_agent, context)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [classification.title || rawInput.substring(0, 80), rawInput,
         classification.status || 'todo', classification.priority || 'medium', aiSource,
         classification.context || null]
      );
      rowId = result.rows[0].id;
    } else if (db === 'transcripts') {
      const result = await query(
        `INSERT INTO transcripts (title, raw_text, summary, source, tags)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [classification.title || rawInput.substring(0, 80), rawInput,
         classification.summary || rawInput.substring(0, 2000),
         aiSource || 'manual', JSON.stringify(classification.tags || [])]
      );
      rowId = result.rows[0].id;
    } else {
      const result = await query(
        `INSERT INTO knowledge (title, content, category, tags, source, ai_source)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
        [classification.title || rawInput.substring(0, 80), rawInput,
         classification.category || 'general', JSON.stringify(classification.tags || []),
         aiSource || 'api', aiSource]
      );
      rowId = result.rows[0].id;
    }

    await logActivity('create', db, rowId, aiSource, `Smart intake: ${classification.title || rawInput.substring(0, 60)}`);
    const intakeJob = syncStatus.startJob('intake', `Intake: ${classification.title || 'item'}`);
    syncStatus.completeJob('intake', intakeJob, { imported: 1, details: { database: db, ai_source: aiSource } });

    res.status(201).json({
      message: 'Filed successfully', id: rowId,
      classification: {
        database: db, title: classification.title, category: classification.category,
        tags: classification.tags, summary: classification.summary, ai_source: aiSource,
      }
    });
  } catch (err) {
    console.error('[intake] Error:', err.message);
    const errJob = syncStatus.startJob('intake', 'Intake failed');
    syncStatus.failJob('intake', errJob, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/batch', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });

    const results = [];
    for (const item of items) {
      try {
        let userMessage = (item.input || '').trim();
        if (!userMessage) { results.push({ error: 'empty input', skipped: true }); continue; }
        if (item.source) userMessage = `[Source: ${item.source}]\n\n${userMessage}`;

        const classification = await classify(userMessage);
        const aiSource = classification.ai_source || item.source || null;
        const db = classification.database || 'knowledge';

        let result;
        if (db === 'tasks') {
          result = await query(
            'INSERT INTO tasks (title, description, status, priority, ai_agent) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [classification.title || userMessage.substring(0, 80), userMessage, classification.status || 'todo', classification.priority || 'medium', aiSource]
          );
        } else {
          result = await query(
            'INSERT INTO knowledge (title, content, category, tags, source, ai_source) VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id',
            [classification.title || userMessage.substring(0, 80), userMessage, classification.category || 'general',
             JSON.stringify(classification.tags || []), aiSource || 'api', aiSource]
          );
        }
        results.push({ id: result.rows[0].id, database: db, title: classification.title, tags: classification.tags });
      } catch (itemErr) {
        results.push({ error: itemErr.message, input: (item.input || '').substring(0, 50) });
      }
    }

    const filed = results.filter(r => r.id).length;
    const errCount = results.filter(r => r.error).length;
    const batchJob = syncStatus.startJob('intake', `Batch intake: ${items.length} items`);
    syncStatus.completeJob('intake', batchJob, { imported: filed, skipped: errCount, errors: results.filter(r => r.error).map(r => r.error) });

    res.status(201).json({ message: `Processed ${results.length} items`, filed, errors: errCount, results });
  } catch (err) {
    const errJob = syncStatus.startJob('intake', 'Batch intake failed');
    syncStatus.failJob('intake', errJob, err.message);
    res.status(500).json({ error: err.message });
  }
});

const DISTILL_PROMPT = `You are a personal knowledge analyst. Given a conversation transcript, extract structured insights.

Return ONLY valid JSON with these fields:
{
  "facts": [{ "text": "short factual statement about the user", "category": "personal|preference|health|work|relationship|financial|general" }],
  "decisions": [{ "title": "short title", "content": "what was decided and why", "category": "code|meeting|research|decision|reference|health|personal|general" }],
  "tasks": [{ "title": "action item", "priority": "low|medium|high|urgent" }],
  "project": "detected project name or null if none",
  "tags": ["topic1", "topic2"]
}

Rules:
- Extract ONLY things explicitly stated or clearly implied, never invent
- Facts should be discrete, reusable truths about the user
- Decisions are conclusions reached during the conversation
- Tasks are action items the user committed to or was assigned
- If no items for a category, return an empty array
- Keep facts short (1 sentence max)
- Detect project names from context
- Return 0-10 facts, 0-5 decisions, 0-5 tasks per conversation`;

router.post('/distill', async (req, res) => {
  try {
    const { title, content, source, created_at } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini', max_tokens: 1500, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: DISTILL_PROMPT },
        { role: 'user', content: `Title: ${title || 'Untitled'}\nSource: ${source || 'unknown'}\n\n${content.substring(0, 15000)}` },
      ],
    });

    const text = response.choices[0]?.message?.content || '{}';
    let extracted;
    try { extracted = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); extracted = m ? JSON.parse(m[0]) : { facts: [], decisions: [], tasks: [] }; }

    const originalDate = created_at || req.getNow();
    const results = { facts: 0, decisions: 0, tasks: 0, project: extracted.project || null };

    for (const fact of (extracted.facts || [])) {
      if (!fact.text) continue;
      await query(
        'INSERT INTO knowledge (title, content, category, tags, source, confirmed, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, false, $6)',
        [fact.text.substring(0, 80), fact.text, fact.category || 'general',
         JSON.stringify(extracted.tags || []), source || 'manual', originalDate]
      );
      results.facts++;
    }

    for (const decision of (extracted.decisions || [])) {
      if (!decision.title && !decision.content) continue;
      await query(
        'INSERT INTO knowledge (title, content, category, tags, source, ai_source, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)',
        [decision.title || (decision.content || '').substring(0, 80), decision.content || decision.title,
         decision.category || 'decision', JSON.stringify(extracted.tags || []),
         source || 'manual', source, originalDate]
      );
      results.decisions++;
    }

    for (const task of (extracted.tasks || [])) {
      if (!task.title) continue;
      await query(
        'INSERT INTO tasks (title, status, priority, ai_agent) VALUES ($1, $2, $3, $4)',
        [task.title, 'todo', task.priority || 'medium', source]
      );
      results.tasks++;
    }

    await logActivity('create', 'intake-distill', 'distill', source,
      `Distilled "${title}": ${results.facts}F ${results.decisions}D ${results.tasks}T`);

    res.json({ message: 'Distillation complete', extracted: results, project: extracted.project, tags: extracted.tags || [] });
  } catch (err) {
    console.error('[distill] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email Intake (Power Automate → flagged Outlook email → task) ──

router.post('/email', async (req, res) => {
  try {
    const { subject, body, sender, sender_email, message_id, received_at, importance } = req.body;
    if (!subject && !body) return res.status(400).json({ error: 'subject or body is required' });

    // Prevent duplicates on Power Automate retries
    if (message_id) {
      const existing = await query('SELECT id FROM tasks WHERE source_id = $1', [message_id]);
      if (existing.rows.length) {
        return res.status(200).json({ message: 'Task already exists', id: existing.rows[0].id, duplicate: true });
      }
    }

    // Build formatted message for classification
    const bodyTruncated = (body || '').substring(0, 3000);
    const userMessage = [
      '[Source: outlook-email]',
      sender ? `From: ${sender}${sender_email ? ` <${sender_email}>` : ''}` : '',
      `Subject: ${subject || '(no subject)'}`,
      importance ? `Importance: ${importance}` : '',
      received_at ? `Received: ${received_at}` : '',
      '',
      bodyTruncated
    ].filter(Boolean).join('\n');

    const classification = await classify(userMessage);

    // Priority: use classifier result, but boost if Outlook importance is high
    let priority = classification.priority || 'medium';
    if (importance === 'high' && (priority === 'medium' || priority === 'low')) {
      priority = 'high';
    }

    // M365 source = always work context
    const context = 'work';

    const result = await query(
      `INSERT INTO tasks (title, description, status, priority, ai_agent, context, source_id, due_date)
       VALUES ($1, $2, 'todo', $3, 'outlook', $4, $5, $6) RETURNING id`,
      [
        classification.title || (subject || '').substring(0, 80) || 'Email task',
        `From: ${sender || 'Unknown'}${sender_email ? ` <${sender_email}>` : ''}\n\n${bodyTruncated}`,
        priority, context, message_id || null, null
      ]
    );

    const taskId = result.rows[0].id;
    await logActivity('create', 'task', taskId, 'outlook', `Email intake: ${classification.title || subject}`);

    const intakeJob = syncStatus.startJob('intake', `Email: ${classification.title || subject}`);
    syncStatus.completeJob('intake', intakeJob, { imported: 1, details: { source: 'outlook', context } });

    res.status(201).json({
      message: 'Email filed as task',
      id: taskId,
      title: classification.title || subject,
      context,
      priority,
      tags: classification.tags || []
    });
  } catch (err) {
    console.error('[intake/email] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/email/complete', async (req, res) => {
  try {
    const { message_id } = req.body;
    if (!message_id) return res.status(400).json({ error: 'message_id is required' });

    const result = await query(
      `UPDATE tasks SET status = 'done', updated_at = NOW()
       WHERE source_id = $1 AND status != 'done' RETURNING id, title`,
      [message_id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'No matching task found for this message_id' });

    const task = result.rows[0];
    await logActivity('update', 'task', task.id, 'outlook', `Completed via Outlook unflag: ${task.title}`);

    res.json({ message: 'Task marked done', id: task.id, title: task.title });
  } catch (err) {
    console.error('[intake/email/complete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.classify = classify;
module.exports = router;
