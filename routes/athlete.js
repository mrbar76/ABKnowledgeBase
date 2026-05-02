// Athlete profile: HR zones (versioned), set by trainer (Claude Project) or
// manually. Each new zones row auto-closes the prior active row's effective_to,
// so historical workouts retain the zones that were active at the time.

const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// ─── GET /api/athlete/zones?on=YYYY-MM-DD ─────────────────────
// Returns the zones row that was effective on the given date (default: today).

router.get('/zones', async (req, res) => {
  try {
    const on = req.query.on || new Date().toISOString().slice(0, 10);
    const result = await query(
      `SELECT * FROM athlete_zones
       WHERE zone_type = 'heart_rate'
         AND effective_from <= $1::date
         AND (effective_to IS NULL OR effective_to >= $1::date)
       ORDER BY effective_from DESC LIMIT 1`,
      [on]
    );
    if (!result.rows.length) return res.json(null);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/athlete/zones/history ──────────────────────────
router.get('/zones/history', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM athlete_zones WHERE zone_type = 'heart_rate'
       ORDER BY effective_from DESC`
    );
    res.json({ count: result.rows.length, zones: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/athlete/zones ──────────────────────────────────
// Creates a new zones row. Auto-closes the prior active row.
//
// Body:
//   { effective_from, max_hr, resting_hr, lthr?,
//     z1_max, z2_max, z3_max, z4_max, z5_max,
//     method, set_by?, rationale?, source_data? }

router.post('/zones', async (req, res) => {
  try {
    const b = req.body;
    const errors = [];
    if (!b.effective_from) errors.push('effective_from is required (YYYY-MM-DD)');
    if (!b.max_hr) errors.push('max_hr is required');
    for (const f of ['z1_max', 'z2_max', 'z3_max', 'z4_max', 'z5_max']) {
      if (b[f] == null) errors.push(`${f} is required`);
    }
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    // Validate monotonic zones
    const zs = [b.z1_max, b.z2_max, b.z3_max, b.z4_max, b.z5_max].map(Number);
    for (let i = 1; i < zs.length; i++) {
      if (zs[i] <= zs[i - 1]) {
        return res.status(400).json({ error: `Zones must be strictly increasing: z${i}_max=${zs[i-1]} >= z${i+1}_max=${zs[i]}` });
      }
    }
    if (Number(b.max_hr) < zs[4]) {
      return res.status(400).json({ error: `max_hr (${b.max_hr}) must be >= z5_max (${zs[4]})` });
    }

    // Close prior active row
    await query(
      `UPDATE athlete_zones
       SET effective_to = ($1::date - INTERVAL '1 day')::date
       WHERE zone_type = 'heart_rate' AND effective_to IS NULL
         AND effective_from < $1::date`,
      [b.effective_from]
    );

    const result = await query(
      `INSERT INTO athlete_zones (
         effective_from, effective_to, zone_type,
         max_hr, resting_hr, lthr,
         z1_max, z2_max, z3_max, z4_max, z5_max,
         method, set_by, rationale, source_data
       ) VALUES (
         $1, $2, 'heart_rate',
         $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13, $14::jsonb
       ) RETURNING *`,
      [
        b.effective_from,
        b.effective_to || null,
        Number(b.max_hr),
        b.resting_hr != null ? Number(b.resting_hr) : null,
        b.lthr != null ? Number(b.lthr) : null,
        zs[0], zs[1], zs[2], zs[3], zs[4],
        b.method || 'percent_max',
        b.set_by || 'trainer',
        b.rationale || null,
        JSON.stringify(b.source_data || {}),
      ]
    );

    await logActivity('create', 'athlete_zones', result.rows[0].id, b.set_by || 'trainer',
      `Zones set: max=${b.max_hr}, RHR=${b.resting_hr || '?'}, method=${b.method || 'percent_max'}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/athlete/zones/:id ────────────────────────────
// Allows trainer to correct an existing zones row (e.g., fix a typo, update rationale).

router.patch('/zones/:id', async (req, res) => {
  try {
    const b = req.body;
    const allowed = ['effective_from', 'effective_to', 'max_hr', 'resting_hr', 'lthr',
                     'z1_max', 'z2_max', 'z3_max', 'z4_max', 'z5_max',
                     'method', 'set_by', 'rationale', 'source_data'];
    const fields = [];
    const params = [];
    let i = 1;
    for (const k of allowed) {
      if (b[k] !== undefined) {
        if (k === 'source_data') {
          fields.push(`${k} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[k]));
        } else {
          fields.push(`${k} = $${i++}`);
          params.push(b[k]);
        }
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    const result = await query(
      `UPDATE athlete_zones SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('update', 'athlete_zones', req.params.id, b.set_by || 'trainer', 'Updated zones');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ ATHLETE PROFILE (sweat rate, FTP, threshold pace, race weight) ═══
// Versioned the same way as athlete_zones: each new row's effective_from
// auto-closes the prior active row's effective_to so historical sessions
// resolve to whatever was active at the time.

const PROFILE_FIELDS = [
  'effective_from','effective_to','lthr_bpm','max_hr_bpm','vo2_max',
  'ftp_w','threshold_pace_sec_per_mi','sweat_rate_ml_per_hr',
  'sodium_loss_mg_per_l','race_weight_lb','height_in','birth_date',
  'sex','notes','set_by',
];

router.get('/profile', async (req, res) => {
  try {
    const on = req.query.on || new Date().toISOString().slice(0, 10);
    const result = await query(
      `SELECT * FROM athlete_profile
       WHERE effective_from <= $1::date
         AND (effective_to IS NULL OR effective_to >= $1::date)
       ORDER BY effective_from DESC LIMIT 1`,
      [on]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/profile/history', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM athlete_profile ORDER BY effective_from DESC LIMIT 50`
    );
    res.json({ count: result.rows.length, profiles: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST creates a new versioned profile row, auto-closes prior active row.
router.post('/profile', async (req, res) => {
  try {
    const b = req.body || {};
    const effective_from = b.effective_from || new Date().toISOString().slice(0, 10);

    // Auto-close prior active row
    await query(
      `UPDATE athlete_profile
         SET effective_to = ($1::date - INTERVAL '1 day')::date, updated_at = NOW()
       WHERE effective_to IS NULL AND effective_from < $1::date`,
      [effective_from]
    );

    const cols = ['effective_from'];
    const values = [effective_from];
    for (const f of PROFILE_FIELDS) {
      if (f === 'effective_from') continue;
      if (!(f in b)) continue;
      cols.push(f);
      values.push(b[f]);
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const result = await query(
      `INSERT INTO athlete_profile (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    if (typeof logActivity === 'function') {
      try { await logActivity('create', 'athlete_profile', result.rows[0].id, b.set_by || 'user', 'Updated athlete profile'); } catch (_) {}
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`[athlete/profile/create] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/profile/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const fields = [];
    const params = [];
    let i = 1;
    for (const f of PROFILE_FIELDS) {
      if (!(f in b)) continue;
      fields.push(`${f} = $${i++}`);
      params.push(b[f]);
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push(`updated_at = NOW()`);
    params.push(req.params.id);
    const result = await query(
      `UPDATE athlete_profile SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
