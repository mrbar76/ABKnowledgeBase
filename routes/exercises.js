const express = require('express');
const { query } = require('../db');
const router = express.Router();

// ─── List exercises (with optional filters) ─────────────────
router.get('/', async (req, res) => {
  try {
    const { muscle, equipment, q, limit = 200, offset = 0 } = req.query;
    const where = [];
    const params = [];
    let i = 1;

    if (q) {
      where.push(`(name ILIKE '%' || $${i} || '%' OR muscle_primary ILIKE '%' || $${i} || '%')`);
      params.push(q);
      i++;
    }
    if (muscle) {
      where.push(`(muscle_primary = $${i} OR $${i} = ANY(muscle_secondary))`);
      params.push(muscle.toLowerCase());
      i++;
    }
    if (equipment) {
      where.push(`$${i} = ANY(equipment)`);
      params.push(equipment.toLowerCase());
      i++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));
    const result = await query(
      `SELECT * FROM exercises ${whereClause} ORDER BY name LIMIT $${i} OFFSET $${i + 1}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get exercises available for a gym profile ──────────────
router.get('/for-profile/:profileId', async (req, res) => {
  try {
    const profile = await query('SELECT equipment FROM gym_profiles WHERE id = $1', [req.params.profileId]);
    if (!profile.rows.length) return res.status(404).json({ error: 'Profile not found' });

    const equip = profile.rows[0].equipment || [];
    if (!equip.length) return res.json([]);

    // Find exercises where ALL required equipment is in the profile
    const result = await query(
      `SELECT * FROM exercises WHERE equipment <@ $1 ORDER BY name`,
      [equip]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get exercises for the active gym profile ───────────────
router.get('/available', async (req, res) => {
  try {
    const profile = await query('SELECT equipment FROM gym_profiles WHERE is_active = true LIMIT 1');
    if (!profile.rows.length) {
      // No active profile — return all exercises
      const all = await query('SELECT * FROM exercises ORDER BY name');
      return res.json(all.rows);
    }

    const equip = profile.rows[0].equipment || [];
    const result = await query(
      `SELECT * FROM exercises WHERE equipment <@ $1 ORDER BY name`,
      [equip]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create exercise ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await query(
      `INSERT INTO exercises (name, name_normalized, muscle_primary, muscle_secondary, equipment, category, force_type, is_compound, is_warmup_eligible, fitbod_name, source, notes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (name_normalized) DO UPDATE SET
         muscle_primary = COALESCE(EXCLUDED.muscle_primary, exercises.muscle_primary),
         muscle_secondary = COALESCE(EXCLUDED.muscle_secondary, exercises.muscle_secondary),
         equipment = COALESCE(EXCLUDED.equipment, exercises.equipment),
         fitbod_name = COALESCE(EXCLUDED.fitbod_name, exercises.fitbod_name)
       RETURNING *`,
      [
        name,
        name.toLowerCase().trim(),
        (b.muscle_primary || '').toLowerCase() || null,
        b.muscle_secondary || [],
        b.equipment || [],
        b.category || 'strength',
        b.force_type || null,
        b.is_compound || false,
        b.is_warmup_eligible !== false,
        b.fitbod_name || name,
        b.source || 'manual',
        b.notes || null,
        JSON.stringify(b.metadata || {}),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk import from Fitbod CSV ────────────────────────────
// Expects { csv_text: "Date,Exercise,Reps,Weight(kg),..." }
router.post('/import-fitbod', async (req, res) => {
  try {
    const { csv_text } = req.body;
    if (!csv_text) return res.status(400).json({ error: 'csv_text is required' });

    const lines = csv_text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header + data rows' });

    // Parse header to find Exercise column
    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const exIdx = header.findIndex(h => h.toLowerCase() === 'exercise');
    if (exIdx === -1) return res.status(400).json({ error: 'No "Exercise" column found in CSV header' });

    // Extract unique exercise names
    const exerciseNames = new Set();
    for (let i = 1; i < lines.length; i++) {
      // Simple CSV parse (handles basic quoting)
      const cols = lines[i].match(/(".*?"|[^,]+)/g) || [];
      const name = (cols[exIdx] || '').replace(/"/g, '').trim();
      if (name) exerciseNames.add(name);
    }

    // Upsert each exercise
    let imported = 0;
    let existing = 0;
    for (const name of exerciseNames) {
      const result = await query(
        `INSERT INTO exercises (name, name_normalized, fitbod_name, source)
         VALUES ($1, $2, $1, 'fitbod_import')
         ON CONFLICT (name_normalized) DO NOTHING
         RETURNING id`,
        [name, name.toLowerCase().trim()]
      );
      if (result.rows.length) imported++;
      else existing++;
    }

    res.json({
      total_unique: exerciseNames.size,
      imported,
      already_existed: existing,
      exercises: [...exerciseNames].sort(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete exercise ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM exercises WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true, name: result.rows[0].name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GYM PROFILES
// ═════════════════════════════════════════════════════════════

// ─── List gym profiles ───────────────────────────────────────
router.get('/gym-profiles', async (req, res) => {
  try {
    const result = await query('SELECT * FROM gym_profiles ORDER BY is_active DESC, name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get active gym profile ─────────────────────────────────
router.get('/gym-profiles/active', async (req, res) => {
  try {
    const result = await query('SELECT * FROM gym_profiles WHERE is_active = true LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create gym profile ─────────────────────────────────────
router.post('/gym-profiles', async (req, res) => {
  try {
    const { name, equipment, is_active, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // If setting active, deactivate others
    if (is_active) {
      await query('UPDATE gym_profiles SET is_active = false');
    }

    const result = await query(
      `INSERT INTO gym_profiles (name, equipment, is_active, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, equipment || [], is_active || false, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update gym profile ─────────────────────────────────────
router.put('/gym-profiles/:id', async (req, res) => {
  try {
    const { name, equipment, is_active, notes } = req.body;

    // If setting active, deactivate others
    if (is_active) {
      await query('UPDATE gym_profiles SET is_active = false WHERE id != $1', [req.params.id]);
    }

    const result = await query(
      `UPDATE gym_profiles SET
        name = COALESCE($1, name),
        equipment = COALESCE($2, equipment),
        is_active = COALESCE($3, is_active),
        notes = COALESCE($4, notes),
        updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [name || null, equipment || null, is_active, notes, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete gym profile ─────────────────────────────────────
router.delete('/gym-profiles/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM gym_profiles WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Equipment catalog (for gym profile picker) ─────────────
router.get('/equipment', async (req, res) => {
  try {
    const result = await query('SELECT * FROM equipment_catalog ORDER BY category, label');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
