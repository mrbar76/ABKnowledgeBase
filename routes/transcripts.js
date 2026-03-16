const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { q, source, limit = 50, offset = 0,
            status, content_type, is_media, tag, speaker,
            since, before, sort } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (title || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'') || ' ' || coalesce(metadata->>'speakers','')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (source) { where.push(`source = $${i++}`); params.push(source); }

    // --- Speaker identification status filters ---
    if (status === 'unidentified') {
      // Transcripts that still have generic Speaker/Unknown labels
      where.push(`EXISTS (
        SELECT 1 FROM transcript_speakers ts
        WHERE ts.transcript_id = transcripts.id
        AND ts.speaker_name ~* '^(speaker|unknown)'
      )`);
    } else if (status === 'identified') {
      // Transcripts where all speakers have been named
      where.push(`NOT EXISTS (
        SELECT 1 FROM transcript_speakers ts
        WHERE ts.transcript_id = transcripts.id
        AND ts.speaker_name ~* '^(speaker|unknown)'
      )`);
      // Must have at least one speaker to count as identified
      where.push(`EXISTS (
        SELECT 1 FROM transcript_speakers ts WHERE ts.transcript_id = transcripts.id
      )`);
    } else if (status === 'unclassified') {
      // Transcripts with no content_type set yet
      where.push(`(metadata->>'content_type') IS NULL`);
    }

    // --- Content type filter ---
    if (content_type) {
      where.push(`metadata->>'content_type' = $${i++}`);
      params.push(content_type);
    }

    // --- Media vs conversation filter ---
    if (is_media === 'true') {
      where.push(`(metadata->>'is_media')::text = 'true'`);
    } else if (is_media === 'false') {
      where.push(`((metadata->>'is_media')::text != 'true' OR (metadata->>'is_media') IS NULL)`);
    }

    // --- Tag filter ---
    if (tag) {
      where.push(`tags @> $${i++}::jsonb`);
      params.push(JSON.stringify([tag]));
    }

    // --- Speaker name filter ---
    if (speaker) {
      where.push(`metadata->>'speakers' ILIKE '%' || $${i++} || '%'`);
      params.push(speaker);
    }

    // --- Date range filters ---
    if (since) {
      where.push(`COALESCE(recorded_at, created_at) >= $${i++}`);
      params.push(since);
    }
    if (before) {
      where.push(`COALESCE(recorded_at, created_at) < $${i++}`);
      params.push(before);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // --- Sorting ---
    let orderBy = 'COALESCE(recorded_at, created_at) DESC';
    if (sort === 'oldest') orderBy = 'COALESCE(recorded_at, created_at) ASC';
    else if (sort === 'shortest') orderBy = 'duration_seconds ASC NULLS LAST';
    else if (sort === 'longest') orderBy = 'duration_seconds DESC NULLS LAST';
    else if (sort === 'updated') orderBy = 'updated_at DESC';

    params.push(Number(limit), Number(offset));

    // Get total count for pagination
    const countResult = await query(
      `SELECT COUNT(*) as total FROM transcripts ${whereClause}`, params.slice(0, -2)
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT id, title, LEFT(summary, 300) as preview, summary, source, ai_source,
              duration_seconds, recorded_at, location, tags, bee_id, project_id, metadata, created_at, updated_at
       FROM transcripts ${whereClause}
       ORDER BY ${orderBy} LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, transcripts: result.rows });
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
        { role: 'system', content: `You are an expert at identifying who is speaking in a conversation transcript. You must apply careful logical reasoning about HOW names are used.

The conversation has these speaker labels: ${uniqueSpeakers.join(', ')}
${t.location ? `Location: ${t.location}` : ''}
${t.title ? `Topic: ${t.title}` : ''}

CRITICAL REASONING RULES for name usage:

PRIORITY 1 — DIRECT ADDRESS (strongest evidence, use these first):
These patterns mean the name belongs to the person being SPOKEN TO, not the speaker:
- "Hey Chris, how are you?" → Chris is the LISTENER
- "Thanks Sarah" → Sarah is the LISTENER
- "What do you think, Mike?" → Mike is the LISTENER
- "Chris, can you..." / "So Chris..." / "Right, Chris?" → Chris is the LISTENER
- Any name used as a greeting, sign-off, or mid-sentence address = that person is the OTHER speaker

PRIORITY 2 — SELF-IDENTIFICATION (strong evidence):
- "I'm John" / "My name is John" / "This is John calling" → the speaker IS John

PRIORITY 3 — CASUAL MENTION (WEAK evidence — DO NOT use for speaker identification):
These are about a THIRD PERSON not in the conversation. IGNORE these for labeling:
- "Kyle told me yesterday..." → Kyle is probably NOT a speaker, just being talked about
- "I was with Kyle and..." → Kyle is being referenced, not addressed
- "Kyle's project is..." → talking ABOUT Kyle
- "Did you talk to Kyle?" → asking about Kyle, Kyle is absent

HOW TO TELL THE DIFFERENCE:
- DIRECT ADDRESS: the name is used TO someone ("Hey Chris", "Chris, what do you think")
- CASUAL MENTION: the name is used ABOUT someone ("Chris said...", "I told Chris...", "Chris's idea")
- KEY TEST: Could you replace the name with "you"? If yes → direct address. If you'd replace with "he/she/they" → casual mention.

Additional rules:
1. People rarely say their own name. When a name appears, it almost always refers to someone ELSE.
2. In a 2-person conversation: if one speaker directly addresses someone by name, that name belongs to the OTHER speaker.
3. In a multi-speaker conversation (3+ people): a name used in direct address by Speaker A could belong to ANY of the other speakers — use surrounding context.
4. In meetings: look for introductions, roll calls, or "as [Name] mentioned" patterns.
5. NEVER assign a name to a speaker based solely on a casual mention. Only use direct address or self-identification.

FIRST — CLASSIFY THE CONTENT:
Before identifying speakers, determine what type of content this is:
- "conversation" — a real conversation between people present together
- "meeting" — a work/business meeting with multiple participants
- "phone_call" — a phone or video call
- "movie" — dialogue from a movie being watched
- "tv_show" — dialogue from a TV show being watched
- "youtube" — audio from a YouTube video being watched
- "podcast" — a podcast being listened to
- "music" — song lyrics or music playing
- "media_other" — other non-conversation media

Clues for MEDIA (not a real conversation):
- Dramatic/scripted-sounding dialogue, sound effects described
- Famous character or actor names
- Narration or voiceover style speech
- Background music mentions, laugh tracks
- Repetitive/lyrical content (music)
- Very polished/rehearsed speaking (podcast/YouTube)
- One speaker doing most of the talking in a presentation style (YouTube/podcast)
- Content that sounds like it's being watched/listened to rather than participated in

THEN — IDENTIFY SPEAKERS (follow these steps):
1. List every name mentioned in the transcript
2. For EACH name, classify the usage:
   - DIRECT ADDRESS? (name used TO someone: "Hey Chris", "Thanks Chris") → HIGH value for identification
   - SELF-ID? ("I'm Chris", "This is Chris") → HIGH value
   - CASUAL MENTION? ("Chris told me", "I saw Chris") → IGNORE for speaker labeling
3. Using ONLY direct address and self-ID evidence: if Speaker A directly addresses "Chris", then a DIFFERENT speaker label is Chris
4. In multi-speaker scenarios, use process of elimination after direct-address mapping
5. Only if no direct address or self-ID evidence exists, consider casual mentions as very low confidence guesses

Return ONLY valid JSON:
{
  "content_type": "conversation" | "meeting" | "phone_call" | "movie" | "tv_show" | "youtube" | "podcast" | "music" | "media_other",
  "content_type_confidence": "high" | "medium" | "low",
  "content_type_reasoning": "why you classified it this way",
  "identifications": {
    "<original_label>": {
      "likely_name": "their real name or best guess",
      "confidence": "high" | "medium" | "low",
      "reasoning": "specific quote or evidence from transcript"
    }
  },
  "people_mentioned": ["names of people TALKED ABOUT but NOT present as speakers"],
  "relationship_notes": "brief note about the relationship between speakers if apparent"
}

IMPORTANT — "people_mentioned" vs "identifications":
- "identifications" = people who ARE speakers (identified via direct address or self-ID)
- "people_mentioned" = people TALKED ABOUT but NOT speakers (casual mentions like "Kyle said...")
- A name should appear in ONE list or the other, never both
- If unsure whether someone is a speaker or just mentioned, default to "people_mentioned"

Rules:
- Do NOT assign a name to the speaker who SAID that name (unless they said "I'm X" or "my name is X")
- If Speaker A addresses someone as "John", assign "John" to a DIFFERENT speaker label
- If you truly cannot determine identity, keep the original label and mark low confidence
- Do NOT invent names — only use names actually found in the transcript text
- Provide the specific quote that led to your identification in the reasoning field
- For media content (movie, tv_show, youtube, podcast, music): use character/host names if identifiable
- In conference calls/meetings: carefully separate who is PRESENT vs who is DISCUSSED` },
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

    // Store content type classification
    const contentType = result.content_type || 'conversation';
    const isMedia = ['movie', 'tv_show', 'youtube', 'podcast', 'music', 'media_other'].includes(contentType);
    const existingTags = Array.isArray(t.tags) ? t.tags : [];
    const newTags = [...new Set([...existingTags, contentType])];
    if (isMedia && !existingTags.includes('media')) newTags.push('media');

    // Update speaker names in the database if we have renames
    if (Object.keys(renames).length > 0 || contentType !== 'conversation') {
      for (const [oldName, newName] of Object.entries(renames)) {
        await query(
          'UPDATE transcript_speakers SET speaker_name = $1 WHERE transcript_id = $2 AND speaker_name = $3',
          [newName, req.params.id, oldName]
        );
      }

      // Update metadata with new speaker names and content type
      const newSpeakerNames = uniqueSpeakers.map(s => renames[s] || s);
      const meta = t.metadata || {};
      meta.speakers = [...new Set(newSpeakerNames)];
      meta.speaker_count = meta.speakers.length;
      meta.ai_speaker_identification = identifications;
      meta.content_type = contentType;
      meta.content_type_confidence = result.content_type_confidence || null;
      meta.content_type_reasoning = result.content_type_reasoning || null;
      meta.is_media = isMedia;
      meta.people_mentioned = Array.isArray(result.people_mentioned) ? result.people_mentioned : [];
      await query(
        'UPDATE transcripts SET metadata = $1::jsonb, tags = $2::jsonb, updated_at = NOW() WHERE id = $3',
        [JSON.stringify(meta), JSON.stringify(newTags), req.params.id]
      );

      const logParts = [];
      if (Object.keys(renames).length > 0) logParts.push(`speakers: ${Object.entries(renames).map(([o,n]) => `${o}→${n}`).join(', ')}`);
      if (meta.people_mentioned.length > 0) logParts.push(`mentioned: ${meta.people_mentioned.join(', ')}`);
      logParts.push(`type: ${contentType}`);
      await logActivity('update', 'transcript', req.params.id, 'openai', `AI identified ${logParts.join('; ')}`);
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
        { role: 'system', content: `You are an expert at identifying who is speaking in a conversation transcript. You must apply careful logical reasoning about HOW names are used.

The conversation has these speaker labels: ${uniqueSpeakers.join(', ')}
${t.location ? `Location: ${t.location}` : ''}
${t.title ? `Topic: ${t.title}` : ''}

CONFIRMED PARTICIPANTS: ${known_names.join(', ')}
Your job is to match each speaker label to the correct person from this list.

CRITICAL REASONING RULES for name usage:

PRIORITY 1 — DIRECT ADDRESS (strongest evidence, use these first):
These patterns mean the name belongs to the person being SPOKEN TO, not the speaker:
- "Hey Chris, how are you?" → Chris is the LISTENER
- "Thanks Sarah" → Sarah is the LISTENER
- "What do you think, Mike?" → Mike is the LISTENER
- Any name used as a greeting, sign-off, or mid-sentence address = that person is the OTHER speaker

PRIORITY 2 — SELF-IDENTIFICATION (strong evidence):
- "I'm John" / "My name is John" / "This is John calling" → the speaker IS John

PRIORITY 3 — CASUAL MENTION (WEAK — DO NOT use for speaker identification):
These refer to a THIRD PERSON not present. IGNORE for labeling:
- "Kyle told me yesterday..." → Kyle is probably NOT a speaker
- "I was with Kyle and..." → Kyle is being referenced, not addressed
- KEY TEST: Could you replace the name with "you"? If yes → direct address. If "he/she/they" → casual mention, IGNORE it.

Additional rules:
1. In a 2-person conversation: if one speaker directly addresses by name, that name belongs to the OTHER speaker.
2. In multi-speaker conversations: use direct address evidence + process of elimination from the known list.
3. NEVER assign a name to a speaker based solely on a casual mention.

FIRST — CLASSIFY THE CONTENT TYPE:
- "conversation" — real conversation between people present together
- "meeting" — a work/business meeting with multiple participants
- "phone_call" — a phone or video call
- "movie" — dialogue from a movie being watched
- "tv_show" — dialogue from a TV show
- "youtube" — audio from a YouTube video
- "podcast" — a podcast being listened to
- "music" — song lyrics or music
- "media_other" — other non-conversation media

THEN — IDENTIFY SPEAKERS AND MENTIONED PEOPLE:
1. List every name from the known list that appears in the transcript
2. For EACH name, classify: DIRECT ADDRESS vs SELF-ID vs CASUAL MENTION
3. Using ONLY direct address and self-ID: map names to speaker labels
4. Collect all casually mentioned names separately — these are people TALKED ABOUT, not speakers
5. Use process of elimination with the known participant list

Return ONLY valid JSON:
{
  "content_type": "conversation" | "meeting" | "phone_call" | "movie" | "tv_show" | "youtube" | "podcast" | "music" | "media_other",
  "content_type_confidence": "high" | "medium" | "low",
  "identifications": {
    "<original_label>": {
      "likely_name": "name from the known list",
      "confidence": "high" | "medium" | "low",
      "reasoning": "specific quote and logic"
    }
  },
  "people_mentioned": ["names of people TALKED ABOUT but NOT present as speakers"],
  "relationship_notes": "brief note about the conversation dynamics"
}

IMPORTANT — "people_mentioned" vs "identifications":
- "identifications" = people who ARE speakers on the call (matched from known list via direct address or self-ID)
- "people_mentioned" = people TALKED ABOUT during the call but NOT on the call themselves
- In conference calls, many names may come up — only assign names to speaker labels if there's direct address evidence
- Names from the known list that don't match any speaker label should go in people_mentioned if they appear in casual references

Rules:
- Do NOT assign a name to the speaker who SAID that name (unless they said "I'm X")
- If Speaker A addresses someone as "John", assign "John" to a DIFFERENT speaker label
- Try to assign every speaker label to someone from: ${known_names.join(', ')}
- Use process of elimination: if you identify one speaker, the remaining names go to remaining labels
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

    // Store content type classification
    const contentType = result.content_type || 'conversation';
    const isMedia = ['movie', 'tv_show', 'youtube', 'podcast', 'music', 'media_other'].includes(contentType);
    const existingTags = Array.isArray(t.tags) ? t.tags : [];
    const newTags = [...new Set([...existingTags, contentType])];
    if (isMedia && !existingTags.includes('media')) newTags.push('media');

    if (Object.keys(renames).length > 0 || contentType !== 'conversation') {
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
      meta.content_type = contentType;
      meta.content_type_confidence = result.content_type_confidence || null;
      meta.is_media = isMedia;
      meta.people_mentioned = Array.isArray(result.people_mentioned) ? result.people_mentioned : [];
      await query(
        'UPDATE transcripts SET metadata = $1::jsonb, tags = $2::jsonb, updated_at = NOW() WHERE id = $3',
        [JSON.stringify(meta), JSON.stringify(newTags), req.params.id]
      );
      const logParts = [`hints: [${known_names.join(',')}]`];
      if (Object.keys(renames).length > 0) logParts.push(Object.entries(renames).map(([o,n]) => `${o}→${n}`).join(', '));
      if (meta.people_mentioned.length > 0) logParts.push(`mentioned: ${meta.people_mentioned.join(', ')}`);
      logParts.push(`type: ${contentType}`);
      await logActivity('update', 'transcript', req.params.id, 'openai', `AI re-identified: ${logParts.join('; ')}`);
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

// ─── Batch re-identify speakers ──────────────────────────────
router.post('/batch-identify', async (req, res) => {
  try {
    const { autoIdentifySpeakers } = require('./bee');
    const { ids, filter } = req.body;

    // Option 1: explicit list of transcript IDs
    // Option 2: filter criteria to find transcripts
    let transcriptIds = [];

    if (ids && Array.isArray(ids) && ids.length > 0) {
      transcriptIds = ids;
    } else if (filter) {
      // Build query from filter criteria
      const conditions = ['1=1'];
      const params = [];
      let paramIdx = 1;

      if (filter.source) {
        conditions.push(`source = $${paramIdx++}`);
        params.push(filter.source);
      }

      if (filter.unidentified) {
        // Only transcripts with generic speaker labels still present
        conditions.push(`EXISTS (
          SELECT 1 FROM transcript_speakers ts
          WHERE ts.transcript_id = transcripts.id
          AND ts.speaker_name ~* '^(speaker|unknown)'
        )`);
      }

      if (filter.content_type) {
        conditions.push(`metadata->>'content_type' = $${paramIdx++}`);
        params.push(filter.content_type);
      }

      if (filter.no_content_type) {
        // Transcripts that haven't been classified yet
        conditions.push(`(metadata->>'content_type') IS NULL`);
      }

      if (filter.is_media !== undefined) {
        conditions.push(`(metadata->>'is_media')::boolean = $${paramIdx++}`);
        params.push(filter.is_media);
      }

      if (filter.since) {
        conditions.push(`COALESCE(recorded_at, created_at) >= $${paramIdx++}`);
        params.push(filter.since);
      }

      if (filter.before) {
        conditions.push(`COALESCE(recorded_at, created_at) < $${paramIdx++}`);
        params.push(filter.before);
      }

      const limit = Math.min(filter.limit || 100, 500);
      const result = await query(
        `SELECT id FROM transcripts WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(recorded_at, created_at) DESC LIMIT ${limit}`,
        params
      );
      transcriptIds = result.rows.map(r => r.id);
    } else {
      return res.status(400).json({
        error: 'Provide either "ids" (array of transcript IDs) or "filter" (criteria object)',
        filter_options: {
          source: 'e.g. "bee"',
          unidentified: 'true — only transcripts with Unknown/Speaker labels',
          content_type: 'e.g. "conversation", "movie", "youtube"',
          no_content_type: 'true — transcripts not yet classified',
          is_media: 'true/false',
          since: 'ISO date string',
          before: 'ISO date string',
          limit: 'max transcripts to process (default 100, max 500)',
        },
        examples: [
          { ids: ['uuid1', 'uuid2'] },
          { filter: { unidentified: true, source: 'bee' } },
          { filter: { no_content_type: true, limit: 200 } },
          { filter: { since: '2025-01-01', source: 'bee' } },
        ]
      });
    }

    if (!transcriptIds.length) {
      return res.json({ message: 'No transcripts matched', processed: 0, results: [] });
    }

    // Return immediately, process in background
    const jobId = `batch-identify-${Date.now()}`;
    res.json({
      message: `Processing ${transcriptIds.length} transcripts in background`,
      job_id: jobId,
      transcript_count: transcriptIds.length,
      transcript_ids: transcriptIds,
    });

    // Process in background
    (async () => {
      const results = [];
      for (const tid of transcriptIds) {
        try {
          await autoIdentifySpeakers(tid);
          results.push({ id: tid, status: 'ok' });
        } catch (err) {
          results.push({ id: tid, status: 'error', error: err.message });
        }
      }
      const succeeded = results.filter(r => r.status === 'ok').length;
      const failed = results.filter(r => r.status === 'error').length;
      await logActivity('update', 'transcript', null, 'openai',
        `Batch re-identified ${succeeded}/${transcriptIds.length} transcripts (${failed} failed), job: ${jobId}`);
      console.log(`[batch-identify] job ${jobId}: ${succeeded} ok, ${failed} failed`);
    })().catch(err => console.error(`[batch-identify] job ${jobId} fatal:`, err.message));
  } catch (err) {
    console.error('[batch-identify] Error:', err.message);
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
