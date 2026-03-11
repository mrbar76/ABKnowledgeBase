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
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'') || ' ' || coalesce(metadata->>'speakers','')) ILIKE '%' || $${i+1} || '%')`);
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

// AI speaker identification — uses OpenAI to figure out who "Unknown" speakers are
router.post('/:id/identify-speakers', async (req, res) => {
  try {
    const transcriptResult = await query('SELECT * FROM transcripts WHERE id = $1', [req.params.id]);
    if (!transcriptResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const t = transcriptResult.rows[0];

    const speakersResult = await query(
      'SELECT * FROM transcript_speakers WHERE transcript_id = $1 ORDER BY utterance_index',
      [req.params.id]
    );
    const speakers = speakersResult.rows;

    // Build a conversation excerpt for the AI (first 80 utterances to keep token cost low)
    const excerpt = speakers.slice(0, 80).map(s =>
      `${s.speaker_name}: ${s.text}`
    ).join('\n');

    if (!excerpt && !t.raw_text) {
      return res.status(400).json({ error: 'No transcript content to analyze' });
    }

    const uniqueSpeakers = [...new Set(speakers.map(s => s.speaker_name))];
    const OpenAI = require('openai');
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const openai = new OpenAI({ apiKey: key });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You are analyzing a conversation transcript to identify speakers.

The conversation has these speaker labels: ${uniqueSpeakers.join(', ')}
${t.location ? `Location: ${t.location}` : ''}
${t.title ? `Topic: ${t.title}` : ''}

Based on context clues (names mentioned, relationships, topics discussed, speaking patterns), try to identify who each speaker label actually is.

Return ONLY valid JSON:
{
  "identifications": {
    "<original_label>": {
      "likely_name": "their real name or best guess",
      "confidence": "high" | "medium" | "low",
      "reasoning": "brief reason for identification"
    }
  },
  "relationship_notes": "brief note about the relationship between speakers if apparent"
}

Rules:
- If a speaker says their own name or is addressed by name, that's high confidence
- If you can infer from context (e.g. family member, coworker), that's medium confidence
- If you truly cannot determine, keep the original label and mark low confidence
- Do NOT invent names — only use names actually mentioned or clearly implied in the text` },
        { role: 'user', content: excerpt || t.raw_text.substring(0, 8000) },
      ],
    });

    const text = response.choices[0]?.message?.content || '{}';
    let result;
    try { result = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : { identifications: {} }; }

    const identifications = result.identifications || {};
    const renames = {};

    // Apply renames for high/medium confidence identifications
    for (const [original, info] of Object.entries(identifications)) {
      if (info.likely_name && info.likely_name !== original && (info.confidence === 'high' || info.confidence === 'medium')) {
        renames[original] = info.likely_name;
      }
    }

    // Update speaker names in the database if we have renames
    if (Object.keys(renames).length > 0) {
      for (const [oldName, newName] of Object.entries(renames)) {
        await query(
          'UPDATE transcript_speakers SET speaker_name = $1 WHERE transcript_id = $2 AND speaker_name = $3',
          [newName, req.params.id, oldName]
        );
      }

      // Update metadata with new speaker names
      const newSpeakerNames = uniqueSpeakers.map(s => renames[s] || s);
      const meta = t.metadata || {};
      meta.speakers = [...new Set(newSpeakerNames)];
      meta.speaker_count = meta.speakers.length;
      meta.ai_speaker_identification = identifications;
      await query(
        'UPDATE transcripts SET metadata = $1::jsonb, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(meta), req.params.id]
      );

      await logActivity('update', 'transcript', req.params.id, 'openai', `AI identified speakers: ${Object.entries(renames).map(([o,n]) => `${o}→${n}`).join(', ')}`);
    }

    res.json({
      message: Object.keys(renames).length > 0 ? `Identified ${Object.keys(renames).length} speaker(s)` : 'No confident identifications found',
      identifications,
      renames,
      relationship_notes: result.relationship_notes || null,
    });
  } catch (err) {
    console.error('[identify-speakers] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual speaker rename ──────────────────────────────────
router.post('/:id/rename-speaker', async (req, res) => {
  try {
    const { old_name, new_name } = req.body;
    if (!old_name || !new_name) return res.status(400).json({ error: 'old_name and new_name required' });

    const transcriptResult = await query('SELECT * FROM transcripts WHERE id = $1', [req.params.id]);
    if (!transcriptResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const t = transcriptResult.rows[0];

    // Update speaker utterances
    const updateResult = await query(
      'UPDATE transcript_speakers SET speaker_name = $1 WHERE transcript_id = $2 AND speaker_name = $3',
      [new_name.trim(), req.params.id, old_name]
    );

    // Update metadata speakers array
    const meta = t.metadata || {};
    if (meta.speakers && Array.isArray(meta.speakers)) {
      meta.speakers = [...new Set(meta.speakers.map(s => s === old_name ? new_name.trim() : s))];
      meta.speaker_count = meta.speakers.length;
    }
    await query(
      'UPDATE transcripts SET metadata = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(meta), req.params.id]
    );

    await logActivity('update', 'transcript', req.params.id, 'manual',
      `Renamed speaker: ${old_name} → ${new_name.trim()}`);

    res.json({
      message: `Renamed "${old_name}" to "${new_name.trim()}"`,
      utterances_updated: updateResult.rowCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Re-identify speakers with hints ──────────────────────────
router.post('/:id/identify-speakers-with-hints', async (req, res) => {
  try {
    const { known_names } = req.body;
    if (!known_names || !known_names.length) return res.status(400).json({ error: 'known_names array required (e.g. ["Tyler", "Gregg", "Craig"])' });

    const transcriptResult = await query('SELECT * FROM transcripts WHERE id = $1', [req.params.id]);
    if (!transcriptResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const t = transcriptResult.rows[0];

    const speakersResult = await query(
      'SELECT * FROM transcript_speakers WHERE transcript_id = $1 ORDER BY utterance_index',
      [req.params.id]
    );
    const speakers = speakersResult.rows;
    if (!speakers.length && !t.raw_text) return res.status(400).json({ error: 'No transcript content' });

    const uniqueSpeakers = [...new Set(speakers.map(s => s.speaker_name))];
    const excerpt = speakers.slice(0, 120).map(s => `${s.speaker_name}: ${s.text}`).join('\n');

    const OpenAI = require('openai');
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const openai = new OpenAI({ apiKey: key });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You are analyzing a conversation transcript to identify speakers.

The conversation has these speaker labels: ${uniqueSpeakers.join(', ')}
${t.location ? `Location: ${t.location}` : ''}
${t.title ? `Topic: ${t.title}` : ''}

IMPORTANT: The user has confirmed these people were in the conversation: ${known_names.join(', ')}

Your job is to match each speaker label to the correct person from the known list. Analyze speaking patterns, topics, who addresses whom, and any name mentions to make the best assignment.

Return ONLY valid JSON:
{
  "identifications": {
    "<original_label>": {
      "likely_name": "name from the known list or original if truly unidentifiable",
      "confidence": "high" | "medium" | "low",
      "reasoning": "brief reason"
    }
  },
  "relationship_notes": "brief note about the conversation dynamics"
}

Rules:
- Try to assign every speaker label to someone from the known list: ${known_names.join(', ')}
- Use conversation clues: who speaks first, who is addressed by name, speaking style
- If a label already matches a known name, confirm it as high confidence
- If you cannot determine, mark as low confidence but still try your best guess` },
        { role: 'user', content: excerpt || t.raw_text.substring(0, 10000) },
      ],
    });

    const text = response.choices[0]?.message?.content || '{}';
    let result;
    try { result = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : { identifications: {} }; }

    const identifications = result.identifications || {};
    const renames = {};
    for (const [original, info] of Object.entries(identifications)) {
      if (info.likely_name && info.likely_name !== original && (info.confidence === 'high' || info.confidence === 'medium')) {
        renames[original] = info.likely_name;
      }
    }

    if (Object.keys(renames).length > 0) {
      for (const [oldName, newName] of Object.entries(renames)) {
        await query(
          'UPDATE transcript_speakers SET speaker_name = $1 WHERE transcript_id = $2 AND speaker_name = $3',
          [newName, req.params.id, oldName]
        );
      }
      const newSpeakerNames = uniqueSpeakers.map(s => renames[s] || s);
      const meta = t.metadata || {};
      meta.speakers = [...new Set(newSpeakerNames)];
      meta.speaker_count = meta.speakers.length;
      meta.ai_speaker_identification = identifications;
      meta.known_participants = known_names;
      await query(
        'UPDATE transcripts SET metadata = $1::jsonb, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(meta), req.params.id]
      );
      await logActivity('update', 'transcript', req.params.id, 'openai',
        `AI re-identified with hints [${known_names.join(',')}]: ${Object.entries(renames).map(([o,n]) => `${o}→${n}`).join(', ')}`);
    }

    res.json({
      message: Object.keys(renames).length > 0
        ? `Identified ${Object.keys(renames).length} speaker(s) using hints`
        : 'No confident matches found even with hints',
      identifications,
      renames,
      relationship_notes: result.relationship_notes || null,
    });
  } catch (err) {
    console.error('[identify-speakers-with-hints] Error:', err.message);
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
