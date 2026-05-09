// Race calendar — first-class races + training blocks + fueling rehearsals.
// The Coach reads this to know A/B/C priorities, days-to-race, taper window,
// and to plan periodization phases. The race-countdown card on the home tab
// reads from /races/upcoming instead of inferring from daily_plans tags.

const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// v1.9.4: dropped expected_weather (pulled live from forecast at race-pulse
// time) and goal_process (duplicated by goal_outcome + training_blocks.thesis).
const RACE_FIELDS = [
  'race_date','name','discipline','distance_value','distance_unit',
  'elevation_gain_ft','terrain','target_time_seconds','priority',
  'status','location','course_notes','fueling_plan',
  'gear_list','goal_outcome','result_time_seconds',
  'result_notes','tags',
];

function pickRace(body) {
  const out = {};
  for (const f of RACE_FIELDS) if (f in body) out[f] = body[f];
  return out;
}

// ─── GET /api/races ───────────────────────────────────────────
// Filters: status (default scheduled), priority, since, before. Default
// returns scheduled races sorted by date ascending so the Coach sees the
// next-up race first.
router.get('/', async (req, res) => {
  try {
    const { status, priority, since, before, limit = 50 } = req.query;
    const where = [];
    const params = [];
    let i = 1;
    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (priority) { where.push(`priority = $${i++}`); params.push(priority); }
    if (since) { where.push(`race_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`race_date < $${i++}`); params.push(before); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit));
    const result = await query(
      `SELECT * FROM races ${whereClause}
       ORDER BY race_date ASC
       LIMIT $${i}`,
      params
    );
    res.json({ count: result.rows.length, races: result.rows });
  } catch (err) {
    console.error(`[races/list] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/races/upcoming ─────────────────────────────────
// Returns the next scheduled race plus countdown days. Powers the home
// race-countdown card.
router.get('/upcoming', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM races
       WHERE status = 'scheduled' AND race_date >= CURRENT_DATE
       ORDER BY race_date ASC LIMIT 5`
    );
    // v3.4: was constructing today via setHours(0,0,0,0) (local) and
    // race_date via new Date() (UTC). Off-by-one for any user west of
    // UTC. Use canonical helper. (Audit bug #9.)
    const { daysBetween, todayLocalISO } = require('../lib/date-helpers');
    const today = todayLocalISO();
    const enriched = result.rows.map(r => ({
      ...r,
      days_to_race: daysBetween(today, r.race_date),
    }));
    res.json({ count: enriched.length, races: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/races/:id ─────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM races WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'race not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/races ────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.race_date || !body.name) {
      return res.status(400).json({ error: 'race_date and name required' });
    }
    const fields = pickRace(body);
    const cols = Object.keys(fields);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map(c => c === 'tags' ? JSON.stringify(fields[c] ?? []) : fields[c]);
    const result = await query(
      `INSERT INTO races (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    if (typeof logActivity === 'function') {
      try { await logActivity('race_added', `Race scheduled: ${result.rows[0].name} on ${result.rows[0].race_date}`, { race_id: result.rows[0].id }); } catch (_) {}
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`[races/create] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/races/:id ─────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const fields = pickRace(req.body || {});
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'no editable fields' });
    const cols = Object.keys(fields);
    const setClauses = cols.map((c, i) => `${c} = $${i + 2}`);
    const values = [req.params.id, ...cols.map(c => c === 'tags' ? JSON.stringify(fields[c]) : fields[c])];
    setClauses.push(`updated_at = NOW()`);
    const result = await query(
      `UPDATE races SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'race not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/races/:id ──────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query(`DELETE FROM races WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'race not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ TRAINING BLOCKS (periodization) ═════════════════════════

router.get('/blocks/list', async (req, res) => {
  try {
    const result = await query(
      `SELECT b.*, r.name AS target_race_name, r.race_date AS target_race_date
       FROM training_blocks b
       LEFT JOIN races r ON r.id = b.target_race_id
       ORDER BY b.start_date DESC LIMIT 24`
    );
    res.json({ count: result.rows.length, blocks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/races/blocks/current — block covering today ────
router.get('/blocks/current', async (req, res) => {
  try {
    const result = await query(
      `SELECT b.*, r.name AS target_race_name, r.race_date AS target_race_date
       FROM training_blocks b
       LEFT JOIN races r ON r.id = b.target_race_id
       WHERE b.start_date <= CURRENT_DATE AND b.end_date >= CURRENT_DATE
       ORDER BY b.start_date DESC LIMIT 1`
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/blocks', async (req, res) => {
  try {
    const { start_date, end_date, phase, thesis, target_race_id, notes, tags } = req.body || {};
    if (!start_date || !end_date || !phase) {
      return res.status(400).json({ error: 'start_date, end_date, phase required' });
    }
    const result = await query(
      `INSERT INTO training_blocks (start_date, end_date, phase, thesis, target_race_id, notes, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [start_date, end_date, phase, thesis ?? null, target_race_id ?? null, notes ?? null, JSON.stringify(tags ?? [])]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`[blocks/create] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/blocks/:id', async (req, res) => {
  try {
    const allowed = ['start_date','end_date','phase','thesis','target_race_id','notes','tags'];
    const fields = {};
    for (const k of allowed) if (k in (req.body || {})) fields[k] = req.body[k];
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'no editable fields' });
    const cols = Object.keys(fields);
    const setClauses = cols.map((c, i) => `${c} = $${i + 2}`);
    const values = [req.params.id, ...cols.map(c => c === 'tags' ? JSON.stringify(fields[c]) : fields[c])];
    setClauses.push(`updated_at = NOW()`);
    const result = await query(
      `UPDATE training_blocks SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'block not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/blocks/:id', async (req, res) => {
  try {
    const result = await query(`DELETE FROM training_blocks WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'block not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ FUELING REHEARSALS ════════════════════════════════════

const FUEL_FIELDS = [
  'rehearsal_date','workout_id','target_race_id','duration_min',
  'g_carb_per_hr','g_sodium_per_hr','ml_fluid_per_hr','mg_caffeine_total',
  'products','gut_response','energy_response','notes','tags','ai_source',
];

router.get('/fueling/list', async (req, res) => {
  try {
    const { since, before, target_race_id, limit = 30 } = req.query;
    const where = [];
    const params = [];
    let i = 1;
    if (since) { where.push(`rehearsal_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`rehearsal_date < $${i++}`); params.push(before); }
    if (target_race_id) { where.push(`target_race_id = $${i++}`); params.push(target_race_id); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit));
    const result = await query(
      `SELECT * FROM fueling_rehearsals ${whereClause}
       ORDER BY rehearsal_date DESC LIMIT $${i}`,
      params
    );
    res.json({ count: result.rows.length, rehearsals: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/fueling', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.rehearsal_date) return res.status(400).json({ error: 'rehearsal_date required' });
    const fields = {};
    for (const f of FUEL_FIELDS) if (f in body) fields[f] = body[f];
    const cols = Object.keys(fields);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map(c => c === 'tags' ? JSON.stringify(fields[c] ?? []) : fields[c]);
    const result = await query(
      `INSERT INTO fueling_rehearsals (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`[fueling/create] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/races/fueling/:id — corrections within the same session.
// Hybrid update path: skill logs immediately (ADHD-friendly), then offers
// a 5-minute window to PATCH if values were wrong.
router.put('/fueling/:id', async (req, res) => {
  try {
    const fields = {};
    for (const f of FUEL_FIELDS) if (f in (req.body || {})) fields[f] = req.body[f];
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'no editable fields' });
    const cols = Object.keys(fields);
    const setClauses = cols.map((c, i) => `${c} = $${i + 2}`);
    const values = [req.params.id, ...cols.map(c => c === 'tags' ? JSON.stringify(fields[c]) : fields[c])];
    setClauses.push(`updated_at = NOW()`);
    const result = await query(
      `UPDATE fueling_rehearsals SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'rehearsal not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[fueling/update] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/fueling/:id', async (req, res) => {
  try {
    const result = await query(`DELETE FROM fueling_rehearsals WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'rehearsal not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
