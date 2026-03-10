const express = require('express');
const {
  queryDatabase, createPage, getPage, updatePage, archivePage,
  pageToFact, richText, dateOrNull, selectOrNull, multiSelect, logActivity
} = require('../notion');
const router = express.Router();

// List/search facts
router.get('/', async (req, res) => {
  try {
    const { q, category, source, confirmed, limit = 50 } = req.query;
    const filters = [];

    if (q) {
      filters.push({ or: [
        { property: 'Title', title: { contains: q } },
        { property: 'Content', rich_text: { contains: q } },
      ]});
    }
    if (category) filters.push({ property: 'Category', select: { equals: category } });
    if (source) filters.push({ property: 'Source', select: { equals: source } });
    if (confirmed !== undefined) filters.push({ property: 'Confirmed', checkbox: { equals: confirmed === 'true' } });

    const filter = filters.length > 1 ? { and: filters }
      : filters.length === 1 ? filters[0] : undefined;

    const result = await queryDatabase('facts', filter,
      [{ property: 'Created At', direction: 'descending' }],
      Number(limit));

    res.json({ count: result.results.length, facts: result.results.map(pageToFact) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single fact
router.get('/:id', async (req, res) => {
  try {
    const page = await getPage(req.params.id);
    if (page.archived) return res.status(404).json({ error: 'Not found' });
    res.json(pageToFact(page));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Create fact
router.post('/', async (req, res) => {
  try {
    const { title, content, category, tags, source, confirmed, created_at } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const now = new Date().toISOString();
    const page = await createPage('facts', {
      Title: { title: richText(title || content.substring(0, 80)) },
      Content: { rich_text: richText(content) },
      Category: { select: selectOrNull(category || 'general') },
      Tags: { multi_select: multiSelect(tags || []) },
      Source: { select: selectOrNull(source || 'manual') },
      Confirmed: { checkbox: confirmed || false },
      'Created At': { date: dateOrNull(created_at || now) },
      'Updated At': { date: dateOrNull(now) },
    });

    await logActivity('create', 'fact', page.id, source, `Created fact: ${title || content.substring(0, 60)}`);
    res.status(201).json({ id: page.id, message: 'Fact stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update fact
router.put('/:id', async (req, res) => {
  try {
    const { title, content, category, tags, confirmed } = req.body;
    const props = { 'Updated At': { date: dateOrNull(new Date()) } };

    if (title !== undefined) props.Title = { title: richText(title) };
    if (content !== undefined) props.Content = { rich_text: richText(content) };
    if (category !== undefined) props.Category = { select: selectOrNull(category) };
    if (tags !== undefined) props.Tags = { multi_select: multiSelect(tags) };
    if (confirmed !== undefined) props.Confirmed = { checkbox: confirmed };

    await updatePage(req.params.id, props);
    res.json({ message: 'Updated successfully' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Delete fact
router.delete('/:id', async (req, res) => {
  try {
    await archivePage(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
