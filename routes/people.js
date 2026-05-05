// People layer — unified person view across Bee transcripts, email, and
// calendar. Coach uses this for "what did Vernon say" / "when's my sister
// flying in" / "what's my PT recommending" queries.
//
// One contacts row per person. Aliases JSONB lets a single contact match
// multiple speaker names (e.g., Lilach + "Lily" + "Mom").

const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ─── Resolve :idOrName → contact row ──────────────────────────────
async function resolveContact(idOrName) {
  // Try UUID match first
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName)) {
    const r = await query(`SELECT * FROM contacts WHERE id = $1`, [idOrName]);
    if (r.rows.length) return r.rows[0];
  }
  // Then exact name (case-insensitive)
  const exact = await query(
    `SELECT * FROM contacts WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [idOrName]
  );
  if (exact.rows.length) return exact.rows[0];
  // Then alias match
  const alias = await query(
    `SELECT * FROM contacts c
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.aliases, '[]'::jsonb)) AS a(alias)
       WHERE LOWER(a.alias) = LOWER($1)
     )
     LIMIT 1`,
    [idOrName]
  );
  return alias.rows[0] || null;
}

// Build a SQL-safe list of person identifiers (name + aliases) for matching.
function identifierVariations(contact) {
  const set = new Set();
  set.add(contact.name);
  if (Array.isArray(contact.aliases)) {
    for (const a of contact.aliases) set.add(String(a));
  }
  return [...set].filter(Boolean);
}

// ─── GET /api/people/:idOrName/interactions ───────────────────────
// Query params:
//   topic    - filter (matches contacts.topics_tagged or interaction topics)
//   since    - ISO date (default 30 days ago)
//   sources  - csv: bee,email,calendar,all (default all)
//   limit    - default 20, max 100
router.get('/:idOrName/interactions', async (req, res) => {
  try {
    const idOrName = req.params.idOrName;
    const since = req.query.since
      ? new Date(req.query.since).toISOString().slice(0, 10)
      : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const sources = (req.query.sources || 'all').toLowerCase().split(',').map(s => s.trim());
    const wantAll = sources.includes('all');
    const wantBee = wantAll || sources.includes('bee');
    const wantEmail = wantAll || sources.includes('email');
    const wantCal = wantAll || sources.includes('calendar');
    const topic = req.query.topic ? String(req.query.topic).toLowerCase() : null;

    const contact = await resolveContact(idOrName);
    if (!contact) {
      return res.status(404).json({
        error: `No contact found for "${idOrName}"`,
        hint: 'Try a UUID, exact name, or one of the contact aliases.',
      });
    }

    const names = identifierVariations(contact);
    const namesLower = names.map(n => n.toLowerCase());
    // v1.10.4: also build like-patterns for substring matching. Handles
    // "Vernon" matching "Vernon Smith" in transcripts where the AI gave
    // the full name, and vice versa.
    const namesPatterns = namesLower.map(n => `%${n}%`);

    // ─── BEE: transcript_speakers ↔ transcripts ──────────────────
    // Match on speaker_name — exact (case-insensitive) OR substring.
    const beePromise = wantBee
      ? query(
          `SELECT
             ts.transcript_id AS ref_id,
             COALESCE(t.recorded_at, ts.spoken_at, t.created_at)::date AS date,
             ts.speaker_name AS speaker_attribution,
             COALESCE(SUBSTRING(ts.text FROM 1 FOR 280), t.summary) AS summary_excerpt,
             COALESCE(t.metadata->'topics', '[]'::jsonb) AS topic_tags
           FROM transcript_speakers ts
           JOIN transcripts t ON t.id = ts.transcript_id
           WHERE COALESCE(t.recorded_at, t.created_at)::date >= $2
             AND (
               LOWER(ts.speaker_name) = ANY($1)
               OR EXISTS (
                 SELECT 1 FROM unnest($4::text[]) AS pat
                 WHERE LOWER(ts.speaker_name) ILIKE pat
               )
             )
           ORDER BY date DESC, ts.utterance_index
           LIMIT $3`,
          [namesLower, since, limit, namesPatterns]
        )
      : { rows: [] };

    // ─── EMAIL: from_name OR participants ────────────────────────
    const emailPromise = wantEmail
      ? query(
          `SELECT
             em.thread_id AS ref_id,
             COALESCE(em.date, et.last_message_at)::date AS date,
             COALESCE(em.from_name, em.from_email) AS speaker_attribution,
             COALESCE(em.snippet, et.summary, et.subject) AS summary_excerpt,
             COALESCE(et.topics, '[]'::jsonb) AS topic_tags
           FROM email_messages em
           JOIN email_threads et ON et.id = em.thread_id
           WHERE COALESCE(em.date, et.last_message_at)::date >= $2
             AND (
               LOWER(em.from_name) = ANY($1)
               OR LOWER(em.from_email) = ANY($1)
               OR EXISTS (
                 SELECT 1 FROM unnest($4::text[]) AS pat
                 WHERE LOWER(em.from_name) ILIKE pat OR LOWER(em.from_email) ILIKE pat
               )
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(et.participants, '[]'::jsonb)) p
                 WHERE LOWER(p->>'name') = ANY($1) OR LOWER(p->>'email') = ANY($1)
               )
             )
           ORDER BY date DESC LIMIT $3`,
          [namesLower, since, limit, namesPatterns]
        ).catch(() => ({ rows: [] }))
      : { rows: [] };

    // ─── CALENDAR: organizer + attendees ─────────────────────────
    const calPromise = wantCal
      ? query(
          `SELECT
             ce.id AS ref_id,
             ce.start_time::date AS date,
             COALESCE(ce.organizer_name, ce.organizer_email) AS speaker_attribution,
             COALESCE(ce.summary, ce.title, ce.description) AS summary_excerpt,
             COALESCE(ce.topics, '[]'::jsonb) AS topic_tags
           FROM calendar_events ce
           WHERE ce.start_time::date >= $2
             AND (
               LOWER(ce.organizer_name) = ANY($1)
               OR LOWER(ce.organizer_email) = ANY($1)
               OR EXISTS (
                 SELECT 1 FROM unnest($4::text[]) AS pat
                 WHERE LOWER(ce.organizer_name) ILIKE pat OR LOWER(ce.organizer_email) ILIKE pat
               )
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(ce.attendees, '[]'::jsonb)) a
                 WHERE LOWER(a->>'name') = ANY($1) OR LOWER(a->>'email') = ANY($1)
               )
             )
           ORDER BY date DESC LIMIT $3`,
          [namesLower, since, limit, namesPatterns]
        ).catch(() => ({ rows: [] }))
      : { rows: [] };

    const [beeR, emailR, calR] = await Promise.all([beePromise, emailPromise, calPromise]);

    const interactions = [
      ...beeR.rows.map(r => ({ source: 'bee', ...r })),
      ...emailR.rows.map(r => ({ source: 'email', ...r })),
      ...calR.rows.map(r => ({ source: 'calendar', ...r })),
    ];

    // Topic filter (post-aggregation since topics live in JSONB across sources)
    const filtered = topic
      ? interactions.filter(i => {
          const tags = Array.isArray(i.topic_tags) ? i.topic_tags : [];
          return tags.some(t => String(t).toLowerCase().includes(topic));
        })
      : interactions;

    // Sort merged by date desc, cap at limit
    filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const capped = filtered.slice(0, limit);

    // Stats
    const topicsDist = {};
    for (const i of filtered) {
      for (const t of (i.topic_tags || [])) {
        const key = String(t).toLowerCase();
        topicsDist[key] = (topicsDist[key] || 0) + 1;
      }
    }

    // v1.10.4: when the result is empty, surface a diagnostics block so
    // Avi/Coach can see what speaker_names / from_names / organizers DO
    // exist in the time window. This makes "no results" actionable —
    // either the contact's aliases need updating, or the data really
    // isn't there.
    let diagnostics = null;
    if (capped.length === 0) {
      const [beeNames, emailNames, calNames] = await Promise.all([
        wantBee ? query(
          `SELECT DISTINCT ts.speaker_name, COUNT(*)::int AS n
           FROM transcript_speakers ts
           JOIN transcripts t ON t.id = ts.transcript_id
           WHERE COALESCE(t.recorded_at, t.created_at)::date >= $1
             AND ts.speaker_name IS NOT NULL AND TRIM(ts.speaker_name) <> ''
           GROUP BY ts.speaker_name ORDER BY n DESC LIMIT 20`,
          [since]
        ).catch(() => ({ rows: [] })) : { rows: [] },
        wantEmail ? query(
          `SELECT DISTINCT COALESCE(em.from_name, em.from_email) AS sender, COUNT(*)::int AS n
           FROM email_messages em
           WHERE COALESCE(em.date, em.ingested_at)::date >= $1
           GROUP BY sender ORDER BY n DESC LIMIT 20`,
          [since]
        ).catch(() => ({ rows: [] })) : { rows: [] },
        wantCal ? query(
          `SELECT DISTINCT COALESCE(ce.organizer_name, ce.organizer_email) AS organizer, COUNT(*)::int AS n
           FROM calendar_events ce
           WHERE ce.start_time::date >= $1
           GROUP BY organizer ORDER BY n DESC LIMIT 20`,
          [since]
        ).catch(() => ({ rows: [] })) : { rows: [] },
      ]);
      diagnostics = {
        message: `No interactions matched contact "${contact.name}" (aliases: ${(contact.aliases || []).join(', ') || 'none'}) in window since ${since}.`,
        looked_for_names: names,
        bee_speakers_in_window: beeNames.rows,
        email_senders_in_window: emailNames.rows,
        calendar_organizers_in_window: calNames.rows,
        next_step: 'Add unmatched names to contacts.aliases via PATCH /api/contacts/:id, or run /transcripts/:id/identify-speakers if Bee speakers are still "Speaker 1"/"Speaker 2".',
      };
    }

    res.json({
      person: contact,
      interactions: capped,
      stats: {
        interaction_count_30d: filtered.length,
        bee_count: beeR.rows.length,
        email_count: emailR.rows.length,
        calendar_count: calR.rows.length,
        topics_distribution: topicsDist,
      },
      filters: { since, limit, sources: wantAll ? ['all'] : sources, topic },
      diagnostics,
    });
  } catch (err) {
    console.error('[GET /people/:idOrName/interactions]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/people/backfill-interactions ──────────────────────
// Recomputes contacts.last_interaction_date, last_interaction_source,
// interaction_count_30d, topics_tagged from transcript_speakers + emails
// + calendar. Idempotent. Run nightly via cron OR manually after a bulk
// import. Phase 4 ships the manual endpoint; cron is a follow-up if Avi
// wants it.
router.post('/backfill-interactions', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

    // Get all contacts with their alias variations
    const contacts = await query(`SELECT id, name, aliases FROM contacts`);
    let updated = 0;

    for (const c of contacts.rows) {
      const names = [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])]
        .filter(Boolean).map(s => String(s).toLowerCase());
      if (!names.length) continue;

      // Last interaction across all three sources
      const [bee, email, cal] = await Promise.all([
        query(
          `SELECT MAX(COALESCE(t.recorded_at, ts.spoken_at, t.created_at))::date AS d
           FROM transcript_speakers ts JOIN transcripts t ON t.id = ts.transcript_id
           WHERE LOWER(ts.speaker_name) = ANY($1)`,
          [names]
        ),
        query(
          `SELECT MAX(COALESCE(em.date, et.last_message_at))::date AS d
           FROM email_messages em JOIN email_threads et ON et.id = em.thread_id
           WHERE LOWER(em.from_name) = ANY($1) OR LOWER(em.from_email) = ANY($1)`,
          [names]
        ).catch(() => ({ rows: [{ d: null }] })),
        query(
          `SELECT MAX(ce.start_time)::date AS d FROM calendar_events ce
           WHERE LOWER(ce.organizer_name) = ANY($1) OR LOWER(ce.organizer_email) = ANY($1)`,
          [names]
        ).catch(() => ({ rows: [{ d: null }] })),
      ]);

      const sources = [
        { src: 'bee', d: bee.rows[0]?.d },
        { src: 'email', d: email.rows[0]?.d },
        { src: 'calendar', d: cal.rows[0]?.d },
      ].filter(s => s.d);
      sources.sort((a, b) => (b.d > a.d ? 1 : -1));
      const latest = sources[0];

      // 30-day count
      const count30Q = await query(
        `SELECT
           (SELECT COUNT(*) FROM transcript_speakers ts JOIN transcripts t ON t.id = ts.transcript_id
            WHERE LOWER(ts.speaker_name) = ANY($1)
              AND COALESCE(t.recorded_at, t.created_at)::date >= $2) AS bee_n,
           (SELECT COUNT(*) FROM email_messages em JOIN email_threads et ON et.id = em.thread_id
            WHERE (LOWER(em.from_name) = ANY($1) OR LOWER(em.from_email) = ANY($1))
              AND COALESCE(em.date, et.last_message_at)::date >= $2) AS email_n,
           (SELECT COUNT(*) FROM calendar_events ce
            WHERE (LOWER(ce.organizer_name) = ANY($1) OR LOWER(ce.organizer_email) = ANY($1))
              AND ce.start_time::date >= $2) AS cal_n`,
        [names, cutoff]
      ).catch(() => ({ rows: [{ bee_n: 0, email_n: 0, cal_n: 0 }] }));

      const total30 = Number(count30Q.rows[0].bee_n || 0)
        + Number(count30Q.rows[0].email_n || 0)
        + Number(count30Q.rows[0].cal_n || 0);

      await query(
        `UPDATE contacts SET
           last_interaction_date = $2,
           last_interaction_source = $3,
           interaction_count_30d = $4,
           updated_at = NOW()
         WHERE id = $1`,
        [c.id, latest?.d || null, latest?.src || null, total30]
      );
      updated++;
    }

    res.json({
      ok: true,
      contacts_processed: contacts.rows.length,
      contacts_updated: updated,
    });
  } catch (err) {
    console.error('[POST /people/backfill-interactions]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/people ─────────────────────────────────────────────
// List all contacts ordered by recent interaction. Used by Coach to
// surface "people Avi has been talking to / about lately."
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const r = await query(
      `SELECT id, name, aliases, relationship, organization, role_tags,
              last_interaction_date, last_interaction_source,
              interaction_count_30d, topics_tagged
       FROM contacts
       ORDER BY last_interaction_date DESC NULLS LAST, name ASC
       LIMIT $1`,
      [limit]
    );
    res.json({ count: r.rows.length, people: r.rows });
  } catch (err) {
    console.error('[GET /people]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
