const express = require('express');
const {
  queryDatabase, createPage, getPage, updatePage, archivePage,
  pageToKnowledge, richText, dateOrNull, selectOrNull, multiSelect,
  logActivity, getPageBlocks, blocksToText
} = require('../notion');
const router = express.Router();

// Search/list knowledge
// GET /api/knowledge?q=search&category=cat&tag=tag&ai_source=src&limit=50
router.get('/', async (req, res) => {
  try {
    const { q, category, tag, ai_source, limit = 50 } = req.query;
    const filters = [];

    if (q) {
      filters.push({ or: [
        { property: 'Title', title: { contains: q } },
        { property: 'Content', rich_text: { contains: q } },
      ]});
    }
    if (category) {
      filters.push({ property: 'Category', select: { equals: category } });
    }
    if (ai_source) {
      filters.push({ property: 'AI Source', select: { equals: ai_source } });
    }
    if (tag) {
      filters.push({ property: 'Tags', multi_select: { contains: tag } });
    }

    const filter = filters.length > 1 ? { and: filters }
      : filters.length === 1 ? filters[0] : undefined;

    const result = await queryDatabase('knowledge', filter,
      [{ property: 'Updated At', direction: 'descending' }],
      Number(limit));

    const entries = result.results.map(pageToKnowledge);
    res.json({ count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get categories
router.get('/meta/categories', async (req, res) => {
  try {
    // Query a few pages grouped by category
    const result = await queryDatabase('knowledge', undefined, undefined, 100);
    const cats = [...new Set(result.results.map(p =>
      p.properties.Category?.select?.name).filter(Boolean))];
    res.json(cats.sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single entry
router.get('/:id', async (req, res) => {
  try {
    const page = await getPage(req.params.id);
    if (page.archived) return res.status(404).json({ error: 'Not found' });
    const entry = pageToKnowledge(page);

    // If content is truncated, also fetch page body blocks
    if (entry.content.endsWith('...')) {
      const blocks = await getPageBlocks(req.params.id);
      const bodyText = blocksToText(blocks);
      if (bodyText) entry.content = bodyText;
    }

    res.json(entry);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Store knowledge
router.post('/', async (req, res) => {
  try {
    const { title, content, category, tags, source, ai_source } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content are required' });

    const now = new Date().toISOString();
    const page = await createPage('knowledge', {
      Title: { title: richText(title) },
      Content: { rich_text: richText(content) },
      Category: { select: selectOrNull(category || 'general') },
      Tags: { multi_select: multiSelect(tags || []) },
      Source: { select: selectOrNull(source || 'api') },
      'AI Source': { select: selectOrNull(ai_source) },
      'Created At': { date: dateOrNull(now) },
      'Updated At': { date: dateOrNull(now) },
    });

    await logActivity('create', 'knowledge', page.id, ai_source, `Created knowledge: ${title}`);
    res.status(201).json({ id: page.id, message: 'Knowledge stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update knowledge
router.put('/:id', async (req, res) => {
  try {
    const existing = await getPage(req.params.id);
    if (existing.archived) return res.status(404).json({ error: 'Not found' });
    const e = pageToKnowledge(existing);

    const { title, content, category, tags, ai_source } = req.body;
    const props = {
      'Updated At': { date: dateOrNull(new Date()) },
    };
    if (title) props.Title = { title: richText(title) };
    if (content) props.Content = { rich_text: richText(content) };
    if (category) props.Category = { select: selectOrNull(category) };
    if (tags) props.Tags = { multi_select: multiSelect(tags) };
    if (ai_source) props['AI Source'] = { select: selectOrNull(ai_source) };

    await updatePage(req.params.id, props);
    await logActivity('update', 'knowledge', req.params.id, ai_source, `Updated knowledge: ${title || e.title}`);
    res.json({ message: 'Updated successfully' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Delete knowledge (archive in Notion)
router.delete('/:id', async (req, res) => {
  try {
    await archivePage(req.params.id);
    await logActivity('delete', 'knowledge', req.params.id, null, 'Deleted knowledge entry');
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
