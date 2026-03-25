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

// ─── Bulk import from Fitbod data (auto-detects format) ─────
// Handles 4 formats:
//   1. Exercise library: Exercise, Category, Primary_Muscle_Group, Secondary_Muscles, ...
//   2. Fitbod exercise details: exercise_name, fitbod_url, description, primary_muscle_group, secondary_muscles, ...
//   3. Workout export: Date, Exercise, Reps, Weight(kg), Duration(s), ...
//   4. Tab-separated variants of any above
router.post('/import-fitbod', async (req, res) => {
  try {
    const { csv_text } = req.body;
    if (!csv_text) return res.status(400).json({ error: 'csv_text is required' });

    const lines = csv_text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'Need header + data rows' });

    // Detect delimiter (tab or comma)
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const splitRow = (line) => {
      if (delim === '\t') return line.split('\t').map(c => c.trim());
      return (line.match(/(".*?"|[^,]+)/g) || []).map(c => c.replace(/"/g, '').trim());
    };

    const header = splitRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, '_'));

    // Detect format by header columns
    const colIdx = (names) => {
      for (const n of names) {
        const idx = header.indexOf(n);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const nameIdx = colIdx(['exercise', 'exercise_name']);
    if (nameIdx === -1) return res.status(400).json({ error: 'No exercise name column found. Expected "Exercise" or "exercise_name".' });

    const categoryIdx = colIdx(['category']);
    const primaryIdx = colIdx(['primary_muscle_group']);
    const secondaryIdx = colIdx(['secondary_muscles']);
    const descIdx = colIdx(['description']);
    const urlIdx = colIdx(['fitbod_url']);
    const sourceIdx = colIdx(['muscle_source', 'muscle_mapping_basis']);

    const hasMuscleCols = primaryIdx !== -1;
    const format = hasMuscleCols ? 'exercise_library' : 'workout_export';

    // Normalize muscle names to our schema
    const normalizeMuscle = (m) => {
      const s = (m || '').toLowerCase().trim();
      const map = {
        'abdominals': 'core', 'abs': 'core', 'obliques': 'core',
        'quads': 'quadriceps', 'quadriceps': 'quadriceps',
        'hamstrings': 'hamstrings', 'hamstrings/glutes': 'hamstrings',
        'glutes': 'glutes', 'hip flexors': 'glutes',
        'calves': 'calves',
        'chest': 'chest', 'pecs': 'chest',
        'back': 'back', 'lats': 'back', 'lower back': 'back', 'upper back': 'back', 'posterior chain': 'back', 'rhomboids': 'back', 'traps': 'back',
        'shoulders': 'shoulders', 'front delts': 'shoulders', 'rear delts': 'shoulders', 'delts': 'shoulders', 'rotator cuff': 'shoulders',
        'triceps': 'triceps',
        'biceps': 'biceps', 'forearms': 'forearms',
        'core': 'core',
        'full body': 'full_body', 'total body': 'full_body',
        'cardio': 'cardio',
        'legs': 'quadriceps', 'lower body': 'quadriceps',
      };
      return map[s] || s || null;
    };

    const parseSecondary = (val) => {
      if (!val) return [];
      return val.split(/,\s*/).map(normalizeMuscle).filter(Boolean);
    };

    // Determine category → our category
    const normalizeCategory = (cat) => {
      const s = (cat || '').toLowerCase();
      if (s.includes('core')) return 'core';
      if (s.includes('cardio')) return 'cardio';
      if (s.includes('stretch') || s.includes('flex') || s.includes('mobil')) return 'mobility';
      return 'strength';
    };

    // Parse and upsert
    let imported = 0;
    let updated = 0;
    let existing = 0;
    const exercises = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = splitRow(lines[i]);
      const name = (cols[nameIdx] || '').trim();
      if (!name) continue;

      const primary = hasMuscleCols ? normalizeMuscle(cols[primaryIdx]) : null;
      const secondary = hasMuscleCols && secondaryIdx !== -1 ? parseSecondary(cols[secondaryIdx]) : [];
      const category = categoryIdx !== -1 ? normalizeCategory(cols[categoryIdx]) : 'strength';
      const description = descIdx !== -1 ? (cols[descIdx] || '').trim() : null;
      const url = urlIdx !== -1 ? (cols[urlIdx] || '').replace(/_/g, '').trim() : null;

      const result = await query(
        `INSERT INTO exercises (name, name_normalized, muscle_primary, muscle_secondary, equipment, category, fitbod_name, source, notes, metadata)
         VALUES ($1, $2, $3, $4, '{}', $5, $1, $6, $7, $8)
         ON CONFLICT (name_normalized) DO UPDATE SET
           muscle_primary = COALESCE(NULLIF(EXCLUDED.muscle_primary, ''), exercises.muscle_primary),
           muscle_secondary = CASE WHEN array_length(EXCLUDED.muscle_secondary, 1) > 0 THEN EXCLUDED.muscle_secondary ELSE exercises.muscle_secondary END,
           category = COALESCE(NULLIF(EXCLUDED.category, 'strength'), exercises.category),
           notes = COALESCE(EXCLUDED.notes, exercises.notes),
           metadata = exercises.metadata || EXCLUDED.metadata
         RETURNING id, (xmax = 0) as is_insert`,
        [
          name,
          name.toLowerCase().trim(),
          primary,
          secondary,
          category,
          format === 'exercise_library' ? 'fitbod_library' : 'fitbod_export',
          description,
          JSON.stringify(url ? { fitbod_url: url } : {}),
        ]
      );
      if (result.rows[0].is_insert) imported++;
      else updated++;
      exercises.push(name);
    }

    existing = exercises.length - imported - updated;

    res.json({
      format,
      total_rows: lines.length - 1,
      total_unique: new Set(exercises).size,
      imported,
      updated,
      exercises: [...new Set(exercises)].sort(),
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
