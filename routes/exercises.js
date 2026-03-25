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

module.exports = router;
