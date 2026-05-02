// User targets — long-term goals (sleep duration, weight, weekly Z2 minutes,
// macro targets per day, etc.). One row per metric. Seeds with athlete-
// appropriate defaults on first DB init (see db.js); user can override any
// metric independently via PUT, or revert to default via DELETE.
//
// Surfaced in the UI via Settings → Targets, and consumed by the Trends
// aggregator (/api/health/insights/trends) so the Coach knows what to compare
// current values against.

const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

const VALID_COMPARISONS = new Set(['gte', 'lte', 'between']);
const VALID_TIMEFRAMES = new Set(['daily', 'weekly', 'monthly', 'long_term']);

// Map a target metric to the SQL that returns its current observed value.
// Used by GET /api/targets to enrich each row with a `current_value`.
//
// Each entry returns { sql, params } that yields a single column `value`.
function currentValueQuery(metric) {
  const today = new Date().toISOString().slice(0, 10);
  const _7d = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const _30d = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  switch (metric) {
    case 'sleep_duration_min':
      return { sql: `SELECT sleep_total_min AS value FROM daily_activity WHERE sleep_total_min IS NOT NULL ORDER BY activity_date DESC LIMIT 1`, params: [] };
    case 'sleep_deep_min':
      return { sql: `SELECT sleep_deep_min AS value FROM daily_activity WHERE sleep_deep_min IS NOT NULL ORDER BY activity_date DESC LIMIT 1`, params: [] };
    case 'sleep_rem_min':
      return { sql: `SELECT sleep_rem_min AS value FROM daily_activity WHERE sleep_rem_min IS NOT NULL ORDER BY activity_date DESC LIMIT 1`, params: [] };
    case 'protein_g':
      return { sql: `SELECT COALESCE(SUM(protein_g), 0) AS value FROM meals WHERE meal_date = $1`, params: [today] };
    case 'calories_kcal':
      return { sql: `SELECT COALESCE(SUM(calories), 0) AS value FROM meals WHERE meal_date = $1`, params: [today] };
    case 'carbs_g':
      return { sql: `SELECT COALESCE(SUM(carbs_g), 0) AS value FROM meals WHERE meal_date = $1`, params: [today] };
    case 'fat_g':
      return { sql: `SELECT COALESCE(SUM(fat_g), 0) AS value FROM meals WHERE meal_date = $1`, params: [today] };
    case 'weight_lb':
      return { sql: `SELECT weight_lb AS value FROM body_metrics WHERE weight_lb IS NOT NULL ORDER BY measurement_date DESC LIMIT 1`, params: [] };
    case 'body_fat_pct':
      return { sql: `SELECT body_fat_pct AS value FROM body_metrics WHERE body_fat_pct IS NOT NULL ORDER BY measurement_date DESC LIMIT 1`, params: [] };
    case 'weekly_z2_min':
      return { sql: `SELECT COALESCE(SUM(((hr_zones->>'z2')::numeric)), 0) AS value FROM workouts WHERE workout_date >= $1 AND hr_zones IS NOT NULL`, params: [_7d] };
    case 'weekly_workouts':
      return { sql: `SELECT COUNT(*) AS value FROM workouts WHERE workout_date >= $1`, params: [_7d] };
    case 'weekly_tss':
      return { sql: `SELECT COALESCE(SUM(tss), 0) AS value FROM workouts WHERE workout_date >= $1 AND tss IS NOT NULL`, params: [_7d] };
    case 'hrv_ms':
      return { sql: `SELECT hrv_sdnn_ms AS value FROM daily_activity WHERE hrv_sdnn_ms IS NOT NULL ORDER BY activity_date DESC LIMIT 1`, params: [] };
    case 'resting_hr_bpm':
      return { sql: `SELECT resting_hr_bpm AS value FROM daily_activity WHERE resting_hr_bpm IS NOT NULL ORDER BY activity_date DESC LIMIT 1`, params: [] };
    default:
      return null;
  }
}

async function fetchCurrent(metric) {
  const q = currentValueQuery(metric);
  if (!q) return null;
  try {
    const result = await query(q.sql, q.params);
    if (!result.rows.length) return null;
    const v = result.rows[0].value;
    return v != null ? Number(v) : null;
  } catch (_) {
    return null;
  }
}

function progressFlag(target, current) {
  if (current == null || target.target_value == null) return null;
  const t = Number(target.target_value);
  const c = Number(current);
  switch (target.comparison) {
    case 'gte': return c >= t ? 'on_track' : 'below';
    case 'lte': return c <= t ? 'on_track' : 'above';
    case 'between': {
      const max = target.target_value_max != null ? Number(target.target_value_max) : Infinity;
      if (c < t) return 'below';
      if (c > max) return 'above';
      return 'on_track';
    }
    default: return null;
  }
}

// ─── GET /api/targets ─────────────────────────────────────────
// Returns all active targets, each enriched with the latest observed value
// and an on_track/below/above flag.
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM user_targets
       WHERE effective_to IS NULL OR effective_to >= CURRENT_DATE
       ORDER BY metric ASC`
    );
    const enriched = await Promise.all(result.rows.map(async (t) => {
      const current = await fetchCurrent(t.metric);
      return {
        ...t,
        target_value: t.target_value != null ? Number(t.target_value) : null,
        target_value_max: t.target_value_max != null ? Number(t.target_value_max) : null,
        current_value: current,
        progress: progressFlag(t, current),
      };
    }));
    res.json({ count: enriched.length, targets: enriched });
  } catch (err) {
    console.error(`[targets/list] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/targets/:metric ─────────────────────────────────
router.get('/:metric', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM user_targets WHERE metric = $1`, [req.params.metric]);
    if (!result.rows.length) return res.status(404).json({ error: 'target not found' });
    const t = result.rows[0];
    const current = await fetchCurrent(t.metric);
    res.json({
      ...t,
      target_value: t.target_value != null ? Number(t.target_value) : null,
      target_value_max: t.target_value_max != null ? Number(t.target_value_max) : null,
      current_value: current,
      progress: progressFlag(t, current),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/targets/:metric ─────────────────────────────────
// Body: { target_value, target_value_max?, comparison?, timeframe?, rationale? }
// Upserts the target. set_by becomes 'user'.
router.put('/:metric', async (req, res) => {
  try {
    const { target_value, target_value_max, comparison, timeframe, rationale } = req.body || {};
    if (target_value == null || isNaN(Number(target_value))) {
      return res.status(400).json({ error: 'target_value (numeric) required' });
    }
    const cmp = comparison || 'gte';
    const tf = timeframe || 'daily';
    if (!VALID_COMPARISONS.has(cmp)) return res.status(400).json({ error: 'invalid comparison' });
    if (!VALID_TIMEFRAMES.has(tf)) return res.status(400).json({ error: 'invalid timeframe' });
    if (cmp === 'between' && (target_value_max == null || isNaN(Number(target_value_max)))) {
      return res.status(400).json({ error: 'target_value_max required when comparison=between' });
    }

    const result = await query(
      `INSERT INTO user_targets (metric, target_value, target_value_max, comparison, timeframe, set_by, rationale)
       VALUES ($1, $2, $3, $4, $5, 'user', $6)
       ON CONFLICT (metric) DO UPDATE SET
         target_value = EXCLUDED.target_value,
         target_value_max = EXCLUDED.target_value_max,
         comparison = EXCLUDED.comparison,
         timeframe = EXCLUDED.timeframe,
         set_by = 'user',
         rationale = EXCLUDED.rationale,
         updated_at = NOW()
       RETURNING *`,
      [req.params.metric, Number(target_value), target_value_max != null ? Number(target_value_max) : null, cmp, tf, rationale ?? null]
    );
    const t = result.rows[0];
    if (typeof logActivity === 'function') {
      try { await logActivity('target_set', `Target ${t.metric} → ${t.target_value}`, { target: t }); } catch (_) {}
    }
    res.json(t);
  } catch (err) {
    console.error(`[targets/put] ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/targets/:metric ──────────────────────────────
// Removes the user-set value. db.js seed will replant on next initDB if the
// row is fully removed; for the running session, the GET will 404 until then.
router.delete('/:metric', async (req, res) => {
  try {
    const result = await query(`DELETE FROM user_targets WHERE metric = $1 RETURNING metric`, [req.params.metric]);
    if (!result.rows.length) return res.status(404).json({ error: 'target not found' });
    res.json({ deleted: result.rows[0].metric });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
