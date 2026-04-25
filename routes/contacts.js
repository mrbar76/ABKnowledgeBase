const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ─── List contacts ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { relationship, confidentiality, q } = req.query;
    const where = [];
    const params = [];
    let i = 1;

    if (relationship) { where.push(`relationship = $${i++}`); params.push(relationship); }
    if (confidentiality) { where.push(`confidentiality = $${i++}`); params.push(confidentiality); }
    if (q) {
      where.push(`(name ILIKE '%' || $${i} || '%' OR aliases::text ILIKE '%' || $${i} || '%' OR email ILIKE '%' || $${i} || '%' OR organization ILIKE '%' || $${i} || '%')`);
      params.push(q); i++;
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await query(`SELECT * FROM contacts ${whereClause} ORDER BY name`, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Search contacts (fuzzy, for speaker resolution) ────────
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const r = await query(
      `SELECT * FROM contacts WHERE name ILIKE '%' || $1 || '%' OR aliases::text ILIKE '%' || $1 || '%' ORDER BY name LIMIT 20`,
      [q]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Unrecognized speakers across transcripts ───────────────
router.get('/unrecognized', async (req, res) => {
  try {
    // Find distinct speaker names from transcripts that don't match any contact
    const r = await query(`
      SELECT speaker_name, COUNT(DISTINCT transcript_id)::int AS transcript_count,
             MAX(ts.created_at) AS last_seen
      FROM transcript_speakers ts
      WHERE speaker_name !~* '^(speaker|unknown)'
        AND NOT EXISTS (
          SELECT 1 FROM contacts c
          WHERE LOWER(c.name) = LOWER(ts.speaker_name)
             OR c.aliases @> to_jsonb(ts.speaker_name)
        )
      GROUP BY speaker_name
      ORDER BY transcript_count DESC, last_seen DESC
      LIMIT 100
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Get single contact ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await query('SELECT * FROM contacts WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Create contact ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, aliases, email, phone, relationship, organization, confidentiality, metadata } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const r = await query(
      `INSERT INTO contacts (name, aliases, email, phone, relationship, organization, confidentiality, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, JSON.stringify(aliases || []), email || null, phone || null,
       relationship || null, organization || null, confidentiality || 'open',
       JSON.stringify(metadata || {})]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Update contact ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { name, aliases, email, phone, relationship, organization, confidentiality, metadata } = req.body;
    const r = await query(
      `UPDATE contacts SET
        name = COALESCE($1, name),
        aliases = COALESCE($2, aliases),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        relationship = COALESCE($5, relationship),
        organization = COALESCE($6, organization),
        confidentiality = COALESCE($7, confidentiality),
        metadata = COALESCE($8, metadata),
        updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [name || null, aliases ? JSON.stringify(aliases) : null, email, phone,
       relationship, organization, confidentiality,
       metadata ? JSON.stringify(metadata) : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Delete contact ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const r = await query('DELETE FROM contacts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
