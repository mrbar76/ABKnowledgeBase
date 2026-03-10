// Smart intake — AI-powered auto-classification and filing.
// Accepts any raw input, uses OpenAI GPT-4o-mini to classify it,
// then files it into the correct Notion database with proper metadata.

const express = require('express');
const {
  createPage, richText, dateOrNull, selectOrNull, multiSelect,
  textToBlocks, logActivity
} = require('../notion');
const syncStatus = require('../sync-status');
const router = express.Router();

// Lazy-load OpenAI client
let openai = null;
function getOpenAIClient() {
  if (openai) return openai;
  const OpenAI = require('openai');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured — required for smart intake');
  openai = new OpenAI({ apiKey: key });
  return openai;
}

const CLASSIFICATION_PROMPT = `You are a personal knowledge organizer. Analyze the following input and classify it for filing into a Notion workspace.

Return ONLY valid JSON with these fields:
{
  "database": one of: "knowledge", "tasks", "transcripts",
  "title": a concise title (max 80 chars),
  "category": for knowledge entries, one of: "general", "code", "meeting", "research", "decision", "reference", "health", "personal", "journal", "daily-summary",
  "tags": array of 1-5 relevant tags (lowercase, short),
  "priority": for tasks only, one of: "low", "medium", "high", "urgent",
  "status": for tasks only, one of: "todo", "in_progress", "review", "done",
  "summary": a 1-2 sentence summary of the content,
  "ai_source": which AI or source created this, one of: "claude", "gemini", "chatgpt", "bee", "manual", or null if unknown
}

Rules:
- If it looks like a task/action item/todo, use "tasks" database
- If it looks like a conversation transcript or meeting notes, use "transcripts"
- Everything else goes to "knowledge"
- Extract meaningful tags from the content (topics, people, projects mentioned)
- Detect the AI source from context clues (e.g., "Claude suggested..." → "claude")
- If the input already specifies a category or tags, respect those
- Keep the title descriptive but concise`;

// Classify input using OpenAI GPT-4o-mini
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

// POST /api/intake
// Body: { "input": "any text", "source": "claude" (optional), "context": "optional context" }
router.post('/', async (req, res) => {
  try {
    const { input, source, context } = req.body;
    if (!input || !input.trim()) {
      return res.status(400).json({ error: 'input is required' });
    }

    // Build the classification input
    let userMessage = input.trim();
    if (context) userMessage = `Context: ${context}\n\n${userMessage}`;
    if (source) userMessage = `[Source: ${source}]\n\n${userMessage}`;

    const classification = await classify(userMessage);

    const now = new Date().toISOString();
    const db = classification.database || 'knowledge';
    const aiSource = classification.ai_source || source || null;
    let pageId;

    // ─── File into the correct database ──────────────────────────

    if (db === 'tasks') {
      const page = await createPage('tasks', {
        Title: { title: richText(classification.title || input.substring(0, 80)) },
        Description: { rich_text: richText(input) },
        Status: { select: selectOrNull(classification.status || 'todo') },
        Priority: { select: selectOrNull(classification.priority || 'medium') },
        'AI Agent': { select: selectOrNull(aiSource) },
        'Next Steps': { rich_text: richText(classification.summary || '') },
        'Created At': { date: dateOrNull(now) },
        'Updated At': { date: dateOrNull(now) },
      });
      pageId = page.id;

    } else if (db === 'transcripts') {
      const bodyBlocks = textToBlocks(input);
      const page = await createPage('transcripts', {
        Title: { title: richText(classification.title || input.substring(0, 80)) },
        Summary: { rich_text: richText(classification.summary || input.substring(0, 2000)) },
        Source: { select: selectOrNull(aiSource || 'manual') },
        Tags: { multi_select: multiSelect(classification.tags || []) },
        'Recorded At': { date: dateOrNull(now) },
        'Created At': { date: dateOrNull(now) },
        'Updated At': { date: dateOrNull(now) },
      }, bodyBlocks);
      pageId = page.id;

    } else {
      // Default: knowledge
      const page = await createPage('knowledge', {
        Title: { title: richText(classification.title || input.substring(0, 80)) },
        Content: { rich_text: richText(input) },
        Category: { select: selectOrNull(classification.category || 'general') },
        Tags: { multi_select: multiSelect(classification.tags || []) },
        Source: { select: selectOrNull(aiSource || 'api') },
        'AI Source': { select: selectOrNull(aiSource) },
        'Created At': { date: dateOrNull(now) },
        'Updated At': { date: dateOrNull(now) },
      });
      pageId = page.id;
    }

    await logActivity('create', classification.database, pageId, aiSource,
      `Smart intake: ${classification.title || input.substring(0, 60)}`);

    // Track in sync status
    const intakeJob = syncStatus.startJob('intake', `Intake: ${classification.title || 'item'}`);
    syncStatus.completeJob('intake', intakeJob, { imported: 1, details: { database: db, ai_source: aiSource } });

    res.status(201).json({
      message: 'Filed successfully',
      id: pageId,
      classification: {
        database: db,
        title: classification.title,
        category: classification.category,
        tags: classification.tags,
        summary: classification.summary,
        ai_source: aiSource,
      }
    });
  } catch (err) {
    console.error('[intake] Error:', err.message);
    const errJob = syncStatus.startJob('intake', 'Intake failed');
    syncStatus.failJob('intake', errJob, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/intake/batch
// Body: { "items": [{ "input": "text", "source": "claude" }, ...] }
router.post('/batch', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const results = [];
    for (const item of items) {
      try {
        let userMessage = (item.input || '').trim();
        if (!userMessage) { results.push({ error: 'empty input', skipped: true }); continue; }
        if (item.source) userMessage = `[Source: ${item.source}]\n\n${userMessage}`;

        const classification = await classify(userMessage);
        const now = new Date().toISOString();
        const aiSource = classification.ai_source || item.source || null;

        // File into correct database
        const page = await createPage(classification.database || 'knowledge', {
          Title: { title: richText(classification.title || userMessage.substring(0, 80)) },
          ...(classification.database === 'tasks' ? {
            Description: { rich_text: richText(userMessage) },
            Status: { select: selectOrNull(classification.status || 'todo') },
            Priority: { select: selectOrNull(classification.priority || 'medium') },
            'AI Agent': { select: selectOrNull(aiSource) },
          } : {
            Content: { rich_text: richText(userMessage) },
            Category: { select: selectOrNull(classification.category || 'general') },
            Tags: { multi_select: multiSelect(classification.tags || []) },
            Source: { select: selectOrNull(aiSource || 'api') },
            'AI Source': { select: selectOrNull(aiSource) },
          }),
          'Created At': { date: dateOrNull(now) },
          'Updated At': { date: dateOrNull(now) },
        });

        results.push({
          id: page.id,
          database: classification.database,
          title: classification.title,
          tags: classification.tags,
        });
      } catch (itemErr) {
        results.push({ error: itemErr.message, input: (item.input || '').substring(0, 50) });
      }
    }

    const filed = results.filter(r => r.id).length;
    const errCount = results.filter(r => r.error).length;
    const batchJob = syncStatus.startJob('intake', `Batch intake: ${items.length} items`);
    syncStatus.completeJob('intake', batchJob, {
      imported: filed,
      skipped: errCount,
      errors: results.filter(r => r.error).map(r => r.error),
    });

    res.status(201).json({
      message: `Processed ${results.length} items`,
      filed,
      errors: errCount,
      results,
    });
  } catch (err) {
    const errJob = syncStatus.startJob('intake', 'Batch intake failed');
    syncStatus.failJob('intake', errJob, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/intake/distill
// Extracts facts, decisions, and tasks from a conversation
// Body: { "title": "...", "content": "...", "source": "chatgpt", "created_at": "..." }
const DISTILL_PROMPT = `You are a personal knowledge analyst. Given a conversation transcript, extract structured insights.

Return ONLY valid JSON with these fields:
{
  "facts": [
    { "text": "short factual statement about the user", "category": "personal|preference|health|work|relationship|financial|general" }
  ],
  "decisions": [
    { "title": "short title", "content": "what was decided and why", "category": "code|meeting|research|decision|reference|health|personal|general" }
  ],
  "tasks": [
    { "title": "action item", "priority": "low|medium|high|urgent" }
  ],
  "project": "detected project name or null if none",
  "tags": ["topic1", "topic2"]
}

Rules:
- Extract ONLY things explicitly stated or clearly implied, never invent
- Facts should be discrete, reusable truths about the user (preferences, personal info, decisions made)
- Decisions are conclusions reached during the conversation
- Tasks are action items the user committed to or was assigned
- If no items for a category, return an empty array
- Keep facts short (1 sentence max)
- Detect project names from context (e.g., "Spartan Training", "Website Redesign")
- Return 0-10 facts, 0-5 decisions, 0-5 tasks per conversation`;

router.post('/distill', async (req, res) => {
  try {
    const { title, content, source, created_at } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: DISTILL_PROMPT },
        { role: 'user', content: `Title: ${title || 'Untitled'}\nSource: ${source || 'unknown'}\n\n${content.substring(0, 15000)}` },
      ],
    });

    const text = response.choices[0]?.message?.content || '{}';
    let extracted;
    try {
      extracted = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : { facts: [], decisions: [], tasks: [] };
    }

    const now = new Date().toISOString();
    const originalDate = created_at || now;
    const results = { facts: 0, decisions: 0, tasks: 0, project: extracted.project || null };

    // Store extracted facts
    for (const fact of (extracted.facts || [])) {
      if (!fact.text) continue;
      await createPage('facts', {
        Title: { title: richText(fact.text.substring(0, 80)) },
        Content: { rich_text: richText(fact.text) },
        Category: { select: selectOrNull(fact.category || 'general') },
        Tags: { multi_select: multiSelect(extracted.tags || []) },
        Source: { select: selectOrNull(source || 'manual') },
        Confirmed: { checkbox: false },
        'Created At': { date: dateOrNull(originalDate) },
        'Updated At': { date: dateOrNull(now) },
      });
      results.facts++;
    }

    // Store extracted decisions as knowledge
    for (const decision of (extracted.decisions || [])) {
      if (!decision.title && !decision.content) continue;
      await createPage('knowledge', {
        Title: { title: richText(decision.title || decision.content.substring(0, 80)) },
        Content: { rich_text: richText(decision.content || decision.title) },
        Category: { select: selectOrNull(decision.category || 'decision') },
        Tags: { multi_select: multiSelect(extracted.tags || []) },
        Source: { select: selectOrNull(source || 'manual') },
        'AI Source': { select: selectOrNull(source) },
        'Created At': { date: dateOrNull(originalDate) },
        'Updated At': { date: dateOrNull(now) },
      });
      results.decisions++;
    }

    // Store extracted tasks
    for (const task of (extracted.tasks || [])) {
      if (!task.title) continue;
      await createPage('tasks', {
        Title: { title: richText(task.title) },
        Status: { select: selectOrNull('todo') },
        Priority: { select: selectOrNull(task.priority || 'medium') },
        'AI Agent': { select: selectOrNull(source) },
        'Created At': { date: dateOrNull(originalDate) },
        'Updated At': { date: dateOrNull(now) },
      });
      results.tasks++;
    }

    await logActivity('create', 'intake-distill', 'distill', source,
      `Distilled "${title}": ${results.facts}F ${results.decisions}D ${results.tasks}T`);

    res.json({
      message: 'Distillation complete',
      extracted: results,
      project: extracted.project,
      tags: extracted.tags || [],
    });
  } catch (err) {
    console.error('[distill] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
