// Smart intake — AI-powered auto-classification and filing.
// Accepts any raw input, uses OpenAI GPT-4o-mini to classify it,
// then files it into the correct Notion database with proper metadata.

const express = require('express');
const {
  createPage, richText, dateOrNull, selectOrNull, multiSelect,
  textToBlocks, logActivity
} = require('../notion');
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

      // Also create a knowledge entry for cross-search
      await createPage('knowledge', {
        Title: { title: richText(classification.title || input.substring(0, 80)) },
        Content: { rich_text: richText(classification.summary || input.substring(0, 2000)) },
        Category: { select: selectOrNull('transcript') },
        Tags: { multi_select: multiSelect(classification.tags || []) },
        Source: { select: selectOrNull(aiSource || 'manual') },
        'AI Source': { select: selectOrNull(aiSource) },
        'Created At': { date: dateOrNull(now) },
        'Updated At': { date: dateOrNull(now) },
      });

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

    res.status(201).json({
      message: `Processed ${results.length} items`,
      filed: results.filter(r => r.id).length,
      errors: results.filter(r => r.error).length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
