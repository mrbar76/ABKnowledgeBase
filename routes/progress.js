const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query, logActivity } = require('../db');
const router = express.Router();

// ─── Photo Upload Config ─────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'progress');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|heic)$/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('Only image files (jpg, png, webp, heic) are allowed'));
  },
});

// ─── Constants ───────────────────────────────────────────────
const VALID_POSES = [
  'front_relaxed', 'front_flexed',
  'side_relaxed_left', 'side_relaxed_right',
  'back_relaxed', 'back_flexed',
  'quarter_turn_left', 'quarter_turn_right',
];

const VALID_FREQUENCIES = ['weekly', 'biweekly', 'monthly'];
const VALID_PHASES = ['cut', 'maintenance', 'bulk'];

// ─── Validation ──────────────────────────────────────────────
function validateCheckin(b) {
  const errors = [];
  if (!b.checkin_date) errors.push('checkin_date is required');
  if (b.weight_lb != null && b.weight_lb !== '') {
    const v = Number(b.weight_lb);
    if (isNaN(v) || v <= 0) errors.push('weight_lb must be a positive number');
  }
  if (b.waist_inches != null && b.waist_inches !== '') {
    const v = Number(b.waist_inches);
    if (isNaN(v) || v <= 0) errors.push('waist_inches must be a positive number');
  }
  if (b.chest_inches != null && b.chest_inches !== '') {
    const v = Number(b.chest_inches);
    if (isNaN(v) || v <= 0) errors.push('chest_inches must be a positive number');
  }
  if (b.arm_inches != null && b.arm_inches !== '') {
    const v = Number(b.arm_inches);
    if (isNaN(v) || v <= 0) errors.push('arm_inches must be a positive number');
  }
  if (b.thigh_inches != null && b.thigh_inches !== '') {
    const v = Number(b.thigh_inches);
    if (isNaN(v) || v <= 0) errors.push('thigh_inches must be a positive number');
  }
  if (b.calorie_phase && !VALID_PHASES.includes(b.calorie_phase)) {
    errors.push(`calorie_phase must be one of: ${VALID_PHASES.join(', ')}`);
  }
  return errors;
}

function parseNum(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

// ─── Consistency Scoring ─────────────────────────────────────
function computeConsistency(photos) {
  if (!photos || !photos.length) return 'low';
  const poseCount = new Set(photos.map(p => p.pose_type)).size;
  const ratio = poseCount / VALID_POSES.length;
  if (ratio >= 0.875) return 'high';    // 7-8 poses
  if (ratio >= 0.5) return 'moderate';   // 4-6 poses
  return 'low';
}

// ═══════════════════════════════════════════════════════════════
// CHECK-INS
// ═══════════════════════════════════════════════════════════════

// ─── List Check-ins ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { since, before, limit = 50, offset = 0 } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (since) { where.push(`checkin_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`checkin_date < $${i++}`); params.push(before); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*) as total FROM progress_checkins ${whereClause}`, params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    params.push(Number(limit), Number(offset));
    const result = await query(
      `SELECT c.*,
        (SELECT COUNT(*)::int FROM progress_photos WHERE checkin_id = c.id) AS photo_count,
        (SELECT json_agg(json_build_object('id', p.id, 'pose_type', p.pose_type, 'filename', p.filename) ORDER BY p.pose_order)
         FROM progress_photos p WHERE p.checkin_id = c.id) AS photos
       FROM progress_checkins c ${whereClause}
       ORDER BY c.checkin_date DESC LIMIT $${i++} OFFSET $${i++}`, params
    );

    res.json({ total, count: result.rows.length, checkins: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Check-in ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*,
        (SELECT json_agg(json_build_object(
          'id', p.id, 'pose_type', p.pose_type, 'filename', p.filename,
          'pose_order', p.pose_order, 'notes', p.notes, 'created_at', p.created_at
        ) ORDER BY p.pose_order)
        FROM progress_photos p WHERE p.checkin_id = c.id) AS photos
       FROM progress_checkins c WHERE c.id = $1`, [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const checkin = result.rows[0];
    checkin.consistency_score = computeConsistency(checkin.photos || []);
    res.json(checkin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Check-in ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const errors = validateCheckin(b);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const result = await query(
      `INSERT INTO progress_checkins (
        checkin_date, weight_lb, waist_inches, chest_inches, arm_inches, thigh_inches,
        training_phase, calorie_phase, pump_state, notes, tags
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        b.checkin_date,
        parseNum(b.weight_lb),
        parseNum(b.waist_inches),
        parseNum(b.chest_inches),
        parseNum(b.arm_inches),
        parseNum(b.thigh_inches),
        b.training_phase || null,
        b.calorie_phase || null,
        b.pump_state || null,
        b.notes || null,
        JSON.stringify(b.tags || []),
      ]
    );

    await logActivity('create', 'progress_checkin', result.rows[0].id, 'manual',
      `Progress check-in on ${b.checkin_date}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Check-in ─────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'checkin_date', 'weight_lb', 'waist_inches', 'chest_inches',
      'arm_inches', 'thigh_inches', 'training_phase', 'calorie_phase',
      'pump_state', 'notes', 'tags', 'is_baseline',
    ];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (key === 'tags') {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else if (['weight_lb', 'waist_inches', 'chest_inches', 'arm_inches', 'thigh_inches'].includes(key)) {
          fields.push(`${key} = $${i++}`);
          params.push(parseNum(b[key]));
        } else if (key === 'is_baseline') {
          fields.push(`${key} = $${i++}`);
          params.push(b[key] === true);
        } else {
          fields.push(`${key} = $${i++}`);
          params.push(b[key]);
        }
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE progress_checkins SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'progress_checkin', req.params.id, 'manual', 'Updated progress check-in');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Check-in (cascades photos) ──────────────────────
router.delete('/:id', async (req, res) => {
  try {
    // Get photo filenames to delete from disk
    const photos = await query('SELECT filename FROM progress_photos WHERE checkin_id = $1', [req.params.id]);
    for (const p of photos.rows) {
      const filePath = path.join(UPLOAD_DIR, p.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    const result = await query('DELETE FROM progress_checkins WHERE id = $1 RETURNING id, checkin_date', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'progress_checkin', req.params.id, 'manual', `Deleted check-in: ${result.rows[0].checkin_date}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PHOTOS
// ═══════════════════════════════════════════════════════════════

// ─── Upload Photo to Check-in ────────────────────────────────
router.post('/:id/photos', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo file provided' });

    const checkin = await query('SELECT id FROM progress_checkins WHERE id = $1', [req.params.id]);
    if (!checkin.rows.length) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Check-in not found' });
    }

    const pose = req.body.pose_type;
    if (!VALID_POSES.includes(pose)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `pose_type must be one of: ${VALID_POSES.join(', ')}` });
    }

    const poseOrder = VALID_POSES.indexOf(pose);

    // Upsert: replace existing photo for same pose in same check-in
    const existing = await query(
      'SELECT id, filename FROM progress_photos WHERE checkin_id = $1 AND pose_type = $2',
      [req.params.id, pose]
    );
    if (existing.rows.length) {
      const oldFile = path.join(UPLOAD_DIR, existing.rows[0].filename);
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      await query('DELETE FROM progress_photos WHERE id = $1', [existing.rows[0].id]);
    }

    const result = await query(
      `INSERT INTO progress_photos (checkin_id, pose_type, pose_order, filename, original_name, file_size, mime_type, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.params.id, pose, poseOrder, req.file.filename,
        req.file.originalname, req.file.size, req.file.mimetype,
        req.body.notes || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Single Photo ─────────────────────────────────────
router.delete('/photos/:photoId', async (req, res) => {
  try {
    const result = await query('DELETE FROM progress_photos WHERE id = $1 RETURNING filename', [req.params.photoId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const filePath = path.join(UPLOAD_DIR, result.rows[0].filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve Photo File ────────────────────────────────────────
router.get('/photos/file/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// ═══════════════════════════════════════════════════════════════
// COMPARISON & TIMELINE
// ═══════════════════════════════════════════════════════════════

// ─── Compare Two Check-ins ───────────────────────────────────
router.get('/compare/:fromId/:toId', async (req, res) => {
  try {
    const [fromResult, toResult] = await Promise.all([
      query(
        `SELECT c.*,
          (SELECT json_agg(json_build_object('id', p.id, 'pose_type', p.pose_type, 'filename', p.filename, 'pose_order', p.pose_order) ORDER BY p.pose_order)
           FROM progress_photos p WHERE p.checkin_id = c.id) AS photos
         FROM progress_checkins c WHERE c.id = $1`, [req.params.fromId]
      ),
      query(
        `SELECT c.*,
          (SELECT json_agg(json_build_object('id', p.id, 'pose_type', p.pose_type, 'filename', p.filename, 'pose_order', p.pose_order) ORDER BY p.pose_order)
           FROM progress_photos p WHERE p.checkin_id = c.id) AS photos
         FROM progress_checkins c WHERE c.id = $1`, [req.params.toId]
      ),
    ]);

    if (!fromResult.rows.length || !toResult.rows.length) {
      return res.status(404).json({ error: 'One or both check-ins not found' });
    }

    const from = fromResult.rows[0];
    const to = toResult.rows[0];

    // Find matching poses
    const fromPhotos = from.photos || [];
    const toPhotos = to.photos || [];
    const matchedPoses = [];
    for (const pose of VALID_POSES) {
      const fp = fromPhotos.find(p => p.pose_type === pose);
      const tp = toPhotos.find(p => p.pose_type === pose);
      if (fp && tp) matchedPoses.push({ pose, from: fp, to: tp });
    }

    const fromConsistency = computeConsistency(fromPhotos);
    const toConsistency = computeConsistency(toPhotos);

    // Measurement deltas
    const deltas = {};
    for (const field of ['weight_lb', 'waist_inches', 'chest_inches', 'arm_inches', 'thigh_inches']) {
      if (from[field] != null && to[field] != null) {
        deltas[field] = +(to[field] - from[field]).toFixed(2);
      }
    }

    res.json({
      from: { ...from, consistency_score: fromConsistency },
      to: { ...to, consistency_score: toConsistency },
      matched_poses: matchedPoses,
      unmatched_count: VALID_POSES.length - matchedPoses.length,
      measurement_deltas: deltas,
      comparison_quality: matchedPoses.length >= 6 ? 'high' : matchedPoses.length >= 3 ? 'moderate' : 'low',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Timeline (compact list for gallery) ─────────────────────
router.get('/timeline', async (req, res) => {
  try {
    const { pose } = req.query;
    let photoFilter = '';
    const params = [];

    if (pose && VALID_POSES.includes(pose)) {
      photoFilter = `AND p.pose_type = $1`;
      params.push(pose);
    }

    const result = await query(
      `SELECT c.id, c.checkin_date, c.weight_lb, c.is_baseline,
        (SELECT json_agg(json_build_object('id', p.id, 'pose_type', p.pose_type, 'filename', p.filename) ORDER BY p.pose_order)
         FROM progress_photos p WHERE p.checkin_id = c.id ${photoFilter}) AS photos
       FROM progress_checkins c
       ORDER BY c.checkin_date DESC
       LIMIT 100`, params
    );

    res.json({ checkins: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings (frequency preference) ─────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const result = await query('SELECT * FROM progress_settings WHERE id = 1');
    res.json(result.rows[0] || { frequency: 'biweekly' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const { frequency } = req.body;
    if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
    }
    await query(
      `INSERT INTO progress_settings (id, frequency) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET frequency = $1, updated_at = NOW()`,
      [frequency || 'biweekly']
    );
    res.json({ message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
