const express = require('express');
const { query } = require('../db');
const router = express.Router();

// List/search transcripts
// GET /api/transcripts?q=search&source=bee&limit=50&offset=0
router.get('/', async (req, res) => {
  try {
    const { q, source, limit = 50, offset = 0 } = req.query;

    if (q) {
      const result = await query(`
        SELECT id, title, summary, source, speaker_labels, duration_seconds,
               recorded_at, tags, created_at, updated_at,
               LEFT(raw_text, 300) as preview,
               ts_rank(
                 to_tsvector('english', coalesce(title,'') || ' ' || coalesce(raw_text,'')),
                 plainto_tsquery('english', $1)
               ) as rank
        FROM transcripts
        WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(raw_text,''))
              @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2 OFFSET $3
      `, [q, Number(limit), Number(offset)]);
      return res.json({ count: result.rows.length, transcripts: result.rows });
    }

    let sql = `
      SELECT id, title, summary, source, speaker_labels, duration_seconds,
             recorded_at, tags, created_at, updated_at,
             LEFT(raw_text, 300) as preview
      FROM transcripts
    `;
    let params = [];
    let idx = 1;

    if (source) {
      sql += ` WHERE source = $${idx++}`;
      params.push(source);
    }
    sql += ` ORDER BY recorded_at DESC NULLS LAST, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(Number(limit), Number(offset));

    const result = await query(sql, params);
    res.json({ count: result.rows.length, transcripts: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full transcript
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM transcripts WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload transcript (Bee.computer or manual)
// POST /api/transcripts
router.post('/', async (req, res) => {
  try {
    const { title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata } = req.body;
    if (!raw_text) return res.status(400).json({ error: 'raw_text is required' });

    const autoTitle = title || `Transcript ${new Date(recorded_at || Date.now()).toLocaleDateString()}`;

    const result = await query(`
      INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      autoTitle, raw_text, summary || null, source || 'bee',
      JSON.stringify(speaker_labels || []), duration_seconds || null,
      recorded_at || null, JSON.stringify(tags || []),
      JSON.stringify(metadata || {})
    ]);

    // Also create a knowledge entry so transcripts are searchable in the unified knowledge base
    await query(`
      INSERT INTO knowledge (title, content, category, tags, source, ai_source, metadata)
      VALUES ($1, $2, 'transcript', $3, $4, $5, $6)
    `, [
      autoTitle,
      summary || raw_text.substring(0, 2000),
      JSON.stringify(tags || []),
      source || 'bee',
      source || 'bee',
      JSON.stringify({ transcript_id: result.rows[0].id, ...(metadata || {}) })
    ]);

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('create', 'transcript', $1, $2, $3)
    `, [result.rows[0].id, source || 'bee', `Uploaded transcript: ${autoTitle}`]);

    res.status(201).json({ id: result.rows[0].id, message: 'Transcript stored successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk upload transcripts (for Bee batch sync)
// POST /api/transcripts/bulk
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

      const result = await query(`
        INSERT INTO transcripts (title, raw_text, summary, source, speaker_labels, duration_seconds, recorded_at, tags, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [
        autoTitle, t.raw_text, t.summary || null, t.source || 'bee',
        JSON.stringify(t.speaker_labels || []), t.duration_seconds || null,
        t.recorded_at || null, JSON.stringify(t.tags || []),
        JSON.stringify(t.metadata || {})
      ]);

      ids.push(result.rows[0].id);
    }

    await query(`
      INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details)
      VALUES ('create', 'transcript', $1, 'bee', $2)
    `, [ids[0] || 'bulk', `Bulk uploaded ${ids.length} transcripts`]);

    res.status(201).json({ count: ids.length, ids, message: 'Transcripts stored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete transcript
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM transcripts WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
