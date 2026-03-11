const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { q, source, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (source) { where.push(`source = $${i++}`); params.push(source); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const result = await query(
      `SELECT id, title, LEFT(summary, 300) as preview, summary, source, ai_source,
              duration_seconds, recorded_at, location, tags, bee_id, project_id, metadata, created_at, updated_at
       FROM transcripts ${whereClause}
       ORDER BY COALESCE(recorded_at, created_at) DESC LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ count: result.rows.length, transcripts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM transcripts WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const speakers = await query(
      'SELECT * FROM transcript_speakers WHERE transcript_id = $1 ORDER BY utterance_index',
      [req.params.id]
    );

    res.json({ ...result.rows[0], speakers: speakers.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata, bee_id, location } = req.body;
    if (!raw_text) return res.status(400).json({ error: 'raw_text is required' });

    const autoTitle = title || `Transcript ${new Date(recorded_at || Date.now()).toLocaleDateString()}`;

    const result = await query(
      `INSERT INTO transcripts (title, raw_text, summary, source, duration_seconds, recorded_at, location, tags, bee_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb) RETURNING id`,
      [autoTitle, raw_text, summary || raw_text.substring(0, 2000), source || 'bee',
       duration_seconds || null, recorded_at || null, location || null,
       JSON.stringify(tags || []), bee_id || metadata?.bee_id || null, JSON.stringify(metadata || {})]
    );

    const transcriptId = result.rows[0].id;

    // Store speaker utterances if provided
    if (Array.isArray(speaker_labels) && speaker_labels.length) {
      for (let idx = 0; idx < speaker_labels.length; idx++) {
        const s = speaker_labels[idx];
        await query(
          `INSERT INTO transcript_speakers (transcript_id, speaker_name, utterance_index, text, spoken_at, start_offset_ms, end_offset_ms, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [transcriptId, s.speaker || s.speaker_name || 'Speaker', idx,
           s.text || s.content || '', s.spoken_at || null,
           s.start_offset_ms || s.start || null, s.end_offset_ms || s.end || null,
           s.confidence || null]
        );
      }
    }

    await logActivity('create', 'transcript', transcriptId, source || 'bee', `Uploaded transcript: ${autoTitle}`);
    res.status(201).json({ id: transcriptId, message: 'Transcript stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      const result = await query(
        `INSERT INTO transcripts (title, raw_text, summary, source, duration_seconds, recorded_at, tags, bee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
        [autoTitle, t.raw_text, t.summary || t.raw_text.substring(0, 2000),
         t.source || 'bee', t.duration_seconds || null, t.recorded_at || null,
         JSON.stringify(t.tags || []), t.bee_id || null]
      );
      ids.push(result.rows[0].id);
    }

    await logActivity('create', 'transcript', ids[0] || 'bulk', 'bee', `Bulk uploaded ${ids.length} transcripts`);
    res.status(201).json({ count: ids.length, ids, message: 'Transcripts stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM transcripts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
