const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// ─── List / Search Exercises ─────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { q, level, equipment, category, muscle_group, sort, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR (coalesce(name,'') || ' ' || coalesce(equipment,'') || ' ' || coalesce(primary_muscle_groups,'') || ' ' || coalesce(description,'')) ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (level) { where.push(`level = $${i++}`); params.push(level); }
    if (equipment) { where.push(`equipment ILIKE $${i++}`); params.push(equipment); }
    if (category) { where.push(`category = $${i++}`); params.push(category); }
    if (muscle_group) { where.push(`primary_muscle_groups ILIKE $${i++}`); params.push(`%${muscle_group}%`); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let orderBy = 'muscle_strength_score DESC, name ASC';
    if (sort === 'name') orderBy = 'name ASC';
    else if (sort === 'mscore_asc') orderBy = 'muscle_strength_score ASC';
    else if (sort === 'sets_logged') orderBy = 'sets_logged DESC';
    else if (sort === 'level') orderBy = "CASE level WHEN 'beginner' THEN 1 WHEN 'intermediate' THEN 2 WHEN 'advanced' THEN 3 ELSE 4 END, name ASC";

    params.push(Number(limit), Number(offset));

    const countResult = await query(
      `SELECT COUNT(*) as total FROM exercises ${whereClause}`, params.slice(0, -2)
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM exercises ${whereClause}
       ORDER BY ${orderBy} LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, exercises: result.rows });
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
      `SELECT * FROM exercises ORDER BY name`,
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
    const profile = await query('SELECT equipment FROM gym_profiles WHERE is_primary = true LIMIT 1');
    if (!profile.rows.length) {
      // No active profile — return all exercises
      const all = await query('SELECT * FROM exercises ORDER BY name');
      return res.json(all.rows);
    }

    const equip = profile.rows[0].equipment || [];
    const result = await query(
      `SELECT * FROM exercises ORDER BY name`,
      [equip]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Unique Equipment List ──────────────────────────────
router.get('/equipment', async (req, res) => {
  try {
    const result = await query(
      `SELECT equipment, COUNT(*)::int as exercise_count
       FROM exercises GROUP BY equipment ORDER BY exercise_count DESC`
    );
    res.json({ equipment: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Equipment catalog (for gym profile picker) ─────────────
router.get('/equipment-catalog', async (req, res) => {
  try {
    const result = await query('SELECT * FROM equipment_catalog ORDER BY category, label');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Unique Categories List ─────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const result = await query(
      `SELECT category, COUNT(*)::int as exercise_count
       FROM exercises GROUP BY category ORDER BY exercise_count DESC`
    );
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Exercise Stats ─────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [totals, byLevel, byEquipment, byCategory, topMscore] = await Promise.all([
      query('SELECT COUNT(*)::int as total FROM exercises'),
      query('SELECT level, COUNT(*)::int as count FROM exercises GROUP BY level ORDER BY count DESC'),
      query('SELECT equipment, COUNT(*)::int as count FROM exercises GROUP BY equipment ORDER BY count DESC LIMIT 20'),
      query('SELECT category, COUNT(*)::int as count FROM exercises GROUP BY category ORDER BY count DESC'),
      query('SELECT name, muscle_strength_score, equipment, category FROM exercises ORDER BY muscle_strength_score DESC LIMIT 10'),
    ]);

    res.json({
      total: totals.rows[0]?.total || 0,
      by_level: byLevel.rows,
      by_equipment: byEquipment.rows,
      by_category: byCategory.rows,
      top_mscore: topMscore.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Exercise ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM exercises WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Exercise ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'name is required' });

    const result = await query(
      `INSERT INTO exercises (
        name, level, equipment, primary_muscle_groups, category,
        muscle_strength_score, sets_logged, description, secondary_muscle_groups,
        tags, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        b.name,
        b.level || 'beginner',
        b.equipment || 'Body Weight',
        b.primary_muscle_groups || null,
        b.category || null,
        b.muscle_strength_score != null ? parseFloat(b.muscle_strength_score) : 0,
        b.sets_logged != null ? parseInt(b.sets_logged, 10) : 0,
        b.description || null,
        b.secondary_muscle_groups || null,
        JSON.stringify(b.tags || []),
        b.source || 'manual',
      ]
    );

    await logActivity('create', 'exercise', result.rows[0].id, b.source || 'manual', `Exercise: ${b.name}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Import Exercises ──────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    let exercises = req.body.exercises || req.body;
    if (!Array.isArray(exercises)) {
      return res.status(400).json({ error: 'exercises array is required' });
    }
    if (exercises.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 exercises per request' });
    }

    const results = [];
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const b of exercises) {
      try {
        const name = b.name || b.Name;
        if (!name) { errors++; results.push({ error: 'Missing name', raw: b }); continue; }

        const result = await query(
          `INSERT INTO exercises (
            name, level, equipment, primary_muscle_groups, category,
            muscle_strength_score, sets_logged, description, secondary_muscle_groups,
            tags, source
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (name) DO UPDATE SET
            level = EXCLUDED.level,
            equipment = EXCLUDED.equipment,
            primary_muscle_groups = EXCLUDED.primary_muscle_groups,
            category = EXCLUDED.category,
            muscle_strength_score = EXCLUDED.muscle_strength_score,
            sets_logged = EXCLUDED.sets_logged,
            description = EXCLUDED.description,
            secondary_muscle_groups = EXCLUDED.secondary_muscle_groups,
            updated_at = NOW()
          RETURNING id, name`,
          [
            name,
            b.level || b.Level || 'beginner',
            b.equipment || b.Equipment || 'Body Weight',
            b.primary_muscle_groups || b['Primary Muscle Groups'] || null,
            b.category || b.Category || null,
            parseFloat(b.muscle_strength_score || b['Muscle Strength Score']) || 0,
            parseInt(b.sets_logged || b['Sets Logged'], 10) || 0,
            b.description || b.Description || null,
            b.secondary_muscle_groups || b['Secondary Muscle Groups'] || null,
            JSON.stringify(b.tags || []),
            b.source || 'fitbod',
          ]
        );

        results.push({ id: result.rows[0].id, name: result.rows[0].name });
        imported++;
      } catch (itemErr) {
        if (itemErr.message.includes('duplicate')) {
          skipped++;
          results.push({ skipped: true, name: b.name || b.Name });
        } else {
          errors++;
          results.push({ error: itemErr.message, name: b.name || b.Name });
        }
      }
    }

    await logActivity('create', 'exercise', 'bulk', 'import', `Bulk imported ${imported} exercises (${skipped} updated, ${errors} errors)`);
    res.status(201).json({ message: `Imported ${imported} exercises`, imported, skipped, errors, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk import from Fitbod CSV (auto-detects format) ──────
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

    // Determine category -> our category
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
        `INSERT INTO exercises (name, primary_muscle_groups, secondary_muscle_groups, category, source, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE SET
           primary_muscle_groups = COALESCE(NULLIF(EXCLUDED.primary_muscle_groups, ''), exercises.primary_muscle_groups),
           secondary_muscle_groups = COALESCE(NULLIF(EXCLUDED.secondary_muscle_groups, ''), exercises.secondary_muscle_groups),
           category = COALESCE(NULLIF(EXCLUDED.category, 'strength'), exercises.category),
           description = COALESCE(EXCLUDED.description, exercises.description)
         RETURNING id, (xmax = 0) as is_insert`,
        [
          name,
          primary,
          secondary.length ? secondary.join(', ') : null,
          category,
          format === 'exercise_library' ? 'fitbod_library' : 'fitbod_export',
          description,
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

// ─── Update Exercise ─────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'name', 'level', 'equipment', 'primary_muscle_groups', 'category',
      'muscle_strength_score', 'sets_logged', 'description', 'secondary_muscle_groups',
      'tags', 'source',
    ];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (key === 'tags') {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else if (key === 'muscle_strength_score') {
          fields.push(`${key} = $${i++}`);
          params.push(parseFloat(b[key]));
        } else if (key === 'sets_logged') {
          fields.push(`${key} = $${i++}`);
          params.push(parseInt(b[key], 10));
        } else {
          fields.push(`${key} = $${i++}`);
          params.push(b[key]);
        }
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE exercises SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'exercise', req.params.id, b.source || 'manual', 'Updated exercise');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Exercise ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM exercises WHERE id = $1 RETURNING id, name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'exercise', req.params.id, 'manual', `Deleted: ${result.rows[0].name}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Purge All Exercises ────────────────────────────────────
router.delete('/purge/all', async (req, res) => {
  try {
    const result = await query('DELETE FROM exercises');
    await logActivity('delete', 'exercise', 'all', 'manual', `Purged ${result.rowCount} exercises`);
    res.json({ deleted: true, count: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// GYM PROFILES
// Gym profiles managed via /api/gym-profiles (routes/gym-profiles.js)

module.exports = router;
