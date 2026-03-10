const express = require('express');
const {
  queryDatabase, createPage, getPage, archivePage,
  pageToTranscript, richText, dateOrNull, selectOrNull, multiSelect,
  logActivity, textToBlocks, getPageBlocks, blocksToText
} = require('../notion');
const router = express.Router();

// List/search transcripts
router.get('/', async (req, res) => {
  try {
    const { q, source, limit = 50 } = req.query;
    const filters = [];

    if (q) {
      filters.push({ or: [
        { property: 'Title', title: { contains: q } },
        { property: 'Summary', rich_text: { contains: q } },
      ]});
    }
    if (source) {
      filters.push({ property: 'Source', select: { equals: source } });
    }

    const filter = filters.length > 1 ? { and: filters }
      : filters.length === 1 ? filters[0] : undefined;

    const result = await queryDatabase('transcripts', filter,
      [{ property: 'Recorded At', direction: 'descending' }],
      Number(limit));

    const transcripts = result.results.map(p => {
      const t = pageToTranscript(p);
      t.preview = t.summary ? t.summary.substring(0, 300) : '';
      return t;
    });

    res.json({ count: transcripts.length, transcripts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full transcript (body blocks contain raw_text)
router.get('/:id', async (req, res) => {
  try {
    const page = await getPage(req.params.id);
    if (page.archived) return res.status(404).json({ error: 'Not found' });
    const transcript = pageToTranscript(page);

    // Fetch full raw_text from page body blocks
    const blocks = await getPageBlocks(req.params.id);
    transcript.raw_text = blocksToText(blocks);

    res.json(transcript);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Upload transcript
router.post('/', async (req, res) => {
  try {
    const { title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata } = req.body;
    if (!raw_text) return res.status(400).json({ error: 'raw_text is required' });

    const autoTitle = title || `Transcript ${new Date(recorded_at || Date.now()).toLocaleDateString()}`;
    const now = new Date().toISOString();

    // Store raw_text as page body blocks (can be very long)
    const bodyBlocks = textToBlocks(raw_text);

    const page = await createPage('transcripts', {
      Title: { title: richText(autoTitle) },
      Summary: { rich_text: richText(summary || raw_text.substring(0, 2000)) },
      Source: { select: selectOrNull(source || 'bee') },
      'Duration (sec)': { number: duration_seconds || null },
      'Recorded At': { date: dateOrNull(recorded_at) },
      Tags: { multi_select: multiSelect(tags || []) },
      'Bee ID': { rich_text: richText(metadata?.bee_id || '') },
      'Created At': { date: dateOrNull(now) },
      'Updated At': { date: dateOrNull(now) },
    }, bodyBlocks);

    await logActivity('create', 'transcript', page.id, source || 'bee', `Uploaded transcript: ${autoTitle}`);
    res.status(201).json({ id: page.id, message: 'Transcript stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk upload transcripts
router.post('/bulk', async (req, res) => {
  try {
    const { transcripts } = req.body;
    if (!Array.isArray(transcripts) || !transcripts.length) {
      return res.status(400).json({ error: 'transcripts array is required' });
    }

    const ids = [];
    for (const t of transcripts) {
      if (!t.raw_text) continue;
      const autoTitle = t.title || `Transcript ${new Date(t.recorded_at || Date.now()).toLocaleDateString()}`;
      const now = new Date().toISOString();

      const page = await createPage('transcripts', {
        Title: { title: richText(autoTitle) },
        Summary: { rich_text: richText(t.summary || t.raw_text.substring(0, 2000)) },
        Source: { select: selectOrNull(t.source || 'bee') },
        'Duration (sec)': { number: t.duration_seconds || null },
        'Recorded At': { date: dateOrNull(t.recorded_at) },
        Tags: { multi_select: multiSelect(t.tags || []) },
        'Created At': { date: dateOrNull(now) },
        'Updated At': { date: dateOrNull(now) },
      }, textToBlocks(t.raw_text));

      ids.push(page.id);
    }

    await logActivity('create', 'transcript', ids[0] || 'bulk', 'bee', `Bulk uploaded ${ids.length} transcripts`);
    res.status(201).json({ count: ids.length, ids, message: 'Transcripts stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete transcript
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
