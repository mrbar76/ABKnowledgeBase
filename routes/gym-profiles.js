const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// ─── List Gym Profiles ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM gym_profiles ORDER BY is_primary DESC, name ASC');
    res.json({ gym_profiles: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Primary Gym Profile ────────────────────────────────
router.get('/primary', async (req, res) => {
  try {
    const result = await query('SELECT * FROM gym_profiles WHERE is_primary = true LIMIT 1');
    if (!result.rows.length) return res.status(404).json({ error: 'No primary gym profile set' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Gym Profile ────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM gym_profiles WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Gym Profile ────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, equipment, is_primary, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // If setting as primary, unset others first
    if (is_primary) {
      await query('UPDATE gym_profiles SET is_primary = false WHERE is_primary = true');
    }

    const result = await query(
      `INSERT INTO gym_profiles (name, equipment, is_primary, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, JSON.stringify(equipment || []), is_primary || false, notes || null]
    );

    await logActivity('create', 'gym_profile', result.rows[0].id, 'manual', `Gym profile: ${name}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Gym Profile ────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { name, equipment, is_primary, notes } = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    if (name !== undefined) { fields.push(`name = $${i++}`); params.push(name); }
    if (equipment !== undefined) { fields.push(`equipment = $${i++}::jsonb`); params.push(JSON.stringify(equipment)); }
    if (is_primary !== undefined) {
      if (is_primary) {
        await query('UPDATE gym_profiles SET is_primary = false WHERE is_primary = true');
      }
      fields.push(`is_primary = $${i++}`); params.push(is_primary);
    }
    if (notes !== undefined) { fields.push(`notes = $${i++}`); params.push(notes); }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    const result = await query(
      `UPDATE gym_profiles SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'gym_profile', req.params.id, 'manual', 'Updated gym profile');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Gym Profile ────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM gym_profiles WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'gym_profile', req.params.id, 'manual', `Deleted: ${result.rows[0].name}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
