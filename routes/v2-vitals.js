// AB Brain v2 — daily vitals cache ingest.
//
// Receives a small structured payload from the morning iOS Shortcut at 5:30am
// and upserts into `daily_vitals_cache`. Six fields, one row per day. Off-device
// coaching reads from here when HealthKit isn't reachable.
//
// Intentionally minimal: no parser dispatch, no format detection, no dedup
// logic, no stale-rescue. The Shortcut owns the query semantics on-device;
// this endpoint just stores what it sends.

const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const NUMERIC_FIELDS = ['hrv_ms', 'rhr_bpm', 'sleep_total_min', 'sleep_deep_min', 'sleep_rem_min'];
const INT_FIELDS = ['rhr_bpm', 'sleep_total_min', 'sleep_deep_min', 'sleep_rem_min'];

function validateBody(b) {
  const errors = [];
  if (!b.date) errors.push('date is required (YYYY-MM-DD)');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) errors.push('date must be YYYY-MM-DD');

  let hasAtLeastOne = false;
  for (const f of NUMERIC_FIELDS) {
    if (b[f] == null || b[f] === '') continue;
    const v = Number(b[f]);
    if (!Number.isFinite(v)) { errors.push(`${f} must be a number`); continue; }
    if (v < 0) errors.push(`${f} must be >= 0`);
    if (INT_FIELDS.includes(f) && !Number.isInteger(v)) errors.push(`${f} must be an integer`);
    hasAtLeastOne = true;
  }
  if (!hasAtLeastOne) errors.push('at least one of hrv_ms, rhr_bpm, sleep_total_min, sleep_deep_min, sleep_rem_min is required');

  return errors;
}

// POST /api/v2/daily-vitals
// Body: { date, hrv_ms?, rhr_bpm?, sleep_total_min?, sleep_deep_min?, sleep_rem_min?, source_device? }
// Idempotent: re-POSTing the same date overwrites (UPSERT on date PK).
router.post('/daily-vitals', async (req, res) => {
  const errors = validateBody(req.body || {});
  if (errors.length) return res.status(400).json({ errors });

  const b = req.body;
  const params = [
    b.date,
    b.hrv_ms != null && b.hrv_ms !== '' ? Number(b.hrv_ms) : null,
    b.rhr_bpm != null && b.rhr_bpm !== '' ? Math.round(Number(b.rhr_bpm)) : null,
    b.sleep_total_min != null && b.sleep_total_min !== '' ? Math.round(Number(b.sleep_total_min)) : null,
    b.sleep_deep_min != null && b.sleep_deep_min !== '' ? Math.round(Number(b.sleep_deep_min)) : null,
    b.sleep_rem_min != null && b.sleep_rem_min !== '' ? Math.round(Number(b.sleep_rem_min)) : null,
    typeof b.source_device === 'string' ? b.source_device.slice(0, 100) : null,
  ];

  const sql = `
    INSERT INTO daily_vitals_cache (
      date, hrv_ms, rhr_bpm, sleep_total_min, sleep_deep_min, sleep_rem_min, source_device, recorded_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (date) DO UPDATE SET
      hrv_ms          = COALESCE(EXCLUDED.hrv_ms,          daily_vitals_cache.hrv_ms),
      rhr_bpm         = COALESCE(EXCLUDED.rhr_bpm,         daily_vitals_cache.rhr_bpm),
      sleep_total_min = COALESCE(EXCLUDED.sleep_total_min, daily_vitals_cache.sleep_total_min),
      sleep_deep_min  = COALESCE(EXCLUDED.sleep_deep_min,  daily_vitals_cache.sleep_deep_min),
      sleep_rem_min   = COALESCE(EXCLUDED.sleep_rem_min,   daily_vitals_cache.sleep_rem_min),
      source_device   = COALESCE(EXCLUDED.source_device,   daily_vitals_cache.source_device),
      updated_at      = NOW()
    RETURNING *`;

  try {
    const result = await query(sql, params);
    const row = result.rows[0];
    logActivity('upsert', 'daily_vitals_cache', b.date, b.source_device || 'shortcut',
      `vitals for ${b.date}: HRV=${row.hrv_ms ?? '—'} RHR=${row.rhr_bpm ?? '—'} sleep=${row.sleep_total_min ?? '—'}min`).catch(() => {});
    res.json({ ok: true, row });
  } catch (err) {
    console.error('[v2/daily-vitals] insert failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v2/daily-vitals?date=YYYY-MM-DD  (latest if date omitted)
// Read-back endpoint Coach uses off-device when HealthKit isn't reachable.
router.get('/daily-vitals', async (req, res) => {
  try {
    if (req.query.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      const r = await query('SELECT * FROM daily_vitals_cache WHERE date = $1', [req.query.date]);
      return res.json({ row: r.rows[0] || null });
    }
    const r = await query('SELECT * FROM daily_vitals_cache ORDER BY date DESC LIMIT $1', [Math.min(Number(req.query.limit) || 7, 90)]);
    res.json({ rows: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
