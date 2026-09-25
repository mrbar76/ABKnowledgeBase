const express = require('express');
const { query, logActivity } = require('../db');
const router = express.Router();

// All numeric metric fields
const METRIC_FIELDS = [
  'weight_lb', 'bmi', 'body_fat_pct', 'skeletal_muscle_pct', 'fat_free_mass_lb',
  'subcutaneous_fat_pct', 'visceral_fat', 'body_water_pct', 'muscle_mass_lb',
  'bone_mass_lb', 'protein_pct', 'bmr_kcal', 'metabolic_age',
];

// v3.35 Feature 1: tape (circumference) measurements, inches. All decimal,
// all optional. A row may carry ONLY tape values (no weight) — see
// validateBody. waist_in (at navel) is the primary physique measure.
const TAPE_FIELDS = [
  'waist_in', 'chest_in', 'arm_relaxed_in', 'shoulders_in', 'thigh_in', 'hip_in', 'neck_in',
];

// Integer-only metric fields
const INT_FIELDS = ['visceral_fat', 'bmr_kcal', 'metabolic_age'];

// Percentage fields (must be 0-100)
const PCT_FIELDS = ['body_fat_pct', 'skeletal_muscle_pct', 'subcutaneous_fat_pct', 'body_water_pct', 'protein_pct'];

function validateBody(b) {
  const errors = [];
  if (!b.measurement_date) errors.push('measurement_date is required');

  // v3.35: weight_lb is no longer mandatory — a tape-only row carries
  // circumference values with no weigh-in. But a row must contain SOME
  // measurement (weight, a scale metric, or a tape value), else it's an
  // empty row. When weight_lb IS supplied it must still be a positive number.
  if (b.weight_lb != null && b.weight_lb !== '') {
    if (typeof b.weight_lb !== 'number' || b.weight_lb <= 0) errors.push('weight_lb must be a positive number');
  }
  const hasAnyValue = [...METRIC_FIELDS, ...TAPE_FIELDS].some(f => b[f] != null && b[f] !== '');
  if (!hasAnyValue) {
    errors.push('at least one measurement is required (weight_lb, a scale metric, or a tape field)');
  }

  for (const f of METRIC_FIELDS) {
    if (b[f] != null && b[f] !== '') {
      const v = Number(b[f]);
      if (isNaN(v)) { errors.push(`${f} must be a number`); continue; }
      if (v < 0) errors.push(`${f} must be >= 0`);
      if (PCT_FIELDS.includes(f) && v > 100) errors.push(`${f} must be <= 100`);
    }
  }

  // Tape fields: positive numbers, inches. Guard against nonsense (a
  // circumference over ~99in is a typo, and numeric(4,1) caps at 999.9).
  for (const f of TAPE_FIELDS) {
    if (b[f] != null && b[f] !== '') {
      const v = Number(b[f]);
      if (isNaN(v)) { errors.push(`${f} must be a number`); continue; }
      if (v <= 0) errors.push(`${f} must be > 0`);
      if (v > 99) errors.push(`${f} must be <= 99 (inches)`);
    }
  }

  if (b.measurement_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(b.measurement_time)) {
    errors.push('measurement_time must be HH:MM or HH:MM:SS');
  }

  return errors;
}

function parseNumeric(val, isInt) {
  if (val == null || val === '') return null;
  const n = Number(val);
  if (isNaN(n)) return null;
  return isInt ? Math.round(n) : n;
}

function buildInsertParams(b) {
  return [
    b.measurement_date,
    b.measurement_time || null,
    b.source || 'RENPHO',
    b.source_type || 'smart_scale',
    parseNumeric(b.weight_lb, false),
    parseNumeric(b.bmi, false),
    parseNumeric(b.body_fat_pct, false),
    parseNumeric(b.skeletal_muscle_pct, false),
    parseNumeric(b.fat_free_mass_lb, false),
    parseNumeric(b.subcutaneous_fat_pct, false),
    parseNumeric(b.visceral_fat, true),
    parseNumeric(b.body_water_pct, false),
    parseNumeric(b.muscle_mass_lb, false),
    parseNumeric(b.bone_mass_lb, false),
    parseNumeric(b.protein_pct, false),
    parseNumeric(b.bmr_kcal, true),
    parseNumeric(b.metabolic_age, true),
    b.measurement_context || null,
    b.vendor_user_mode || null,
    // v3.35 tape fields ($20-$26)
    parseNumeric(b.waist_in, false),
    parseNumeric(b.chest_in, false),
    parseNumeric(b.arm_relaxed_in, false),
    parseNumeric(b.shoulders_in, false),
    parseNumeric(b.thigh_in, false),
    parseNumeric(b.hip_in, false),
    parseNumeric(b.neck_in, false),
    b.notes || null,
    JSON.stringify(b.tags || []),
    b.is_manual_entry === true,
    b.raw_payload ? JSON.stringify(b.raw_payload) : null,
  ];
}

const INSERT_SQL = `INSERT INTO body_metrics (
  measurement_date, measurement_time, source, source_type,
  weight_lb, bmi, body_fat_pct, skeletal_muscle_pct, fat_free_mass_lb,
  subcutaneous_fat_pct, visceral_fat, body_water_pct, muscle_mass_lb,
  bone_mass_lb, protein_pct, bmr_kcal, metabolic_age,
  measurement_context, vendor_user_mode,
  waist_in, chest_in, arm_relaxed_in, shoulders_in, thigh_in, hip_in, neck_in,
  notes, tags, is_manual_entry, raw_payload
) VALUES (
  $1, $2, $3, $4,
  $5, $6, $7, $8, $9,
  $10, $11, $12, $13,
  $14, $15, $16, $17,
  $18, $19,
  $20, $21, $22, $23, $24, $25, $26,
  $27, $28, $29, $30
)`;

// ─── List / Search Body Metrics ──────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { q, source, since, before, on_or_before, latest, limit = 50, offset = 0, sort } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (q) {
      where.push(`(search_vector @@ plainto_tsquery('english', $${i}) OR coalesce(notes,'') ILIKE '%' || $${i+1} || '%')`);
      params.push(q, q);
      i += 2;
    }
    if (source) { where.push(`source = $${i++}`); params.push(source); }
    if (since) { where.push(`measurement_date >= $${i++}`); params.push(since); }
    if (before) { where.push(`measurement_date < $${i++}`); params.push(before); }
    // on_or_before is the inclusive sibling of `before`. Used by the Training
    // tab's Body section to show the most recent weigh-in as of a given date,
    // including that date itself. `before` (strict <) preserved for callers
    // that need exclusive semantics.
    if (on_or_before) { where.push(`measurement_date <= $${i++}`); params.push(on_or_before); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // If latest=true, return only the most recent entry
    if (latest === 'true') {
      const result = await query(
        `SELECT * FROM body_metrics ${whereClause} ORDER BY measurement_date DESC, measurement_time DESC NULLS LAST LIMIT 1`,
        params
      );
      return res.json(deriveLeanMass(result.rows[0]));
    }

    let orderBy = 'measurement_date DESC, measurement_time DESC NULLS LAST';
    if (sort === 'oldest') orderBy = 'measurement_date ASC, measurement_time ASC NULLS LAST';

    params.push(Number(limit), Number(offset));

    const countResult = await query(
      `SELECT COUNT(*) as total FROM body_metrics ${whereClause}`, params.slice(0, -2)
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT * FROM body_metrics ${whereClause}
       ORDER BY ${orderBy} LIMIT $${i++} OFFSET $${i++}`, params
    );
    res.json({ total, count: result.rows.length, body_metrics: result.rows.map(deriveLeanMass) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Single Body Metric ─────────────────────────────────
// v3.4: lean_mass_lb is a stored column but never written by RENPHO or
// most smart scales. Compute it server-side from weight × (1 - bf%/100)
// when both inputs are present (audit bug #10). Stored value wins when
// the scale provided one. Output is a NEW object — never mutates the
// row. Returns null/undefined unchanged.
function deriveLeanMass(row) {
  if (!row || typeof row !== 'object') return row;
  if (row.lean_mass_lb != null) return row;
  const w = Number(row.weight_lb);
  const bf = Number(row.body_fat_pct);
  if (!Number.isFinite(w) || !Number.isFinite(bf) || w <= 0) return row;
  const lean = w * (1 - bf / 100);
  return { ...row, lean_mass_lb: Math.round(lean * 10) / 10, lean_mass_lb_derived: true };
}

router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM body_metrics WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(deriveLeanMass(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Body Metric ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    const errors = validateBody(b);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const result = await query(`${INSERT_SQL} RETURNING *`, buildInsertParams(b));

    await logActivity('create', 'body_metric', result.rows[0].id,
      b.source || 'RENPHO',
      `Body metric: ${b.weight_lb}lb on ${b.measurement_date}`
    );

    // v3.17: trigger goal recompute for body-composition goals
    // (weight, body fat %, lean mass, etc.). Fire-and-forget — never
    // let a recompute failure 500 the body_metric write.
    try {
      const { recomputeForBodyMetric } = require('./goals');
      if (typeof recomputeForBodyMetric === 'function') {
        recomputeForBodyMetric(result.rows[0]).catch(err =>
          console.error('[goals recompute on body-metric create]', err.message));
      }
    } catch (_) { /* goals route not loaded yet (e.g., startup race) */ }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk Import Body Metrics ────────────────────────────────
router.post('/bulk', async (req, res) => {
  try {
    const { body_metrics: entries } = req.body;
    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ error: 'body_metrics array is required' });
    }
    if (entries.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 entries per request' });
    }

    const results = [];
    let imported = 0;
    let errorCount = 0;

    for (const b of entries) {
      try {
        const errors = validateBody(b);
        if (errors.length) {
          results.push({ error: errors.join('; '), measurement_date: b.measurement_date });
          errorCount++;
          continue;
        }

        const result = await query(
          `${INSERT_SQL} RETURNING id, measurement_date, weight_lb`,
          buildInsertParams(b)
        );
        results.push({ id: result.rows[0].id, measurement_date: result.rows[0].measurement_date, weight_lb: result.rows[0].weight_lb });
        imported++;
      } catch (itemErr) {
        results.push({ error: itemErr.message, measurement_date: b.measurement_date });
        errorCount++;
      }
    }

    await logActivity('create', 'body_metric', 'bulk', 'import', `Bulk imported ${imported} body metrics (${errorCount} errors)`);

    // v3.17: trigger one recompute after the bulk completes. The hook
    // is keyed on "any body metric changed" not per-row, so a single
    // call suffices regardless of how many rows landed.
    if (imported > 0) {
      try {
        const { recomputeForBodyMetric } = require('./goals');
        if (typeof recomputeForBodyMetric === 'function') {
          // Pass the latest inserted row as the trigger marker; the hook
          // recomputes every body-comp goal anyway, so the row identity
          // doesn't matter for what gets recomputed.
          recomputeForBodyMetric(results.find(r => r.id) || {}).catch(err =>
            console.error('[goals recompute on body-metric bulk]', err.message));
        }
      } catch (_) { /* goals route not loaded */ }
    }

    res.status(201).json({ message: `Imported ${imported} body metrics`, imported, errors: errorCount, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update Body Metric ─────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    const allowed = [
      'measurement_date', 'measurement_time', 'source', 'source_type',
      ...METRIC_FIELDS,
      ...TAPE_FIELDS,
      'measurement_context', 'vendor_user_mode',
      'notes', 'tags', 'is_manual_entry', 'raw_payload',
    ];

    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (key === 'tags') {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(JSON.stringify(b[key]));
        } else if (key === 'raw_payload') {
          fields.push(`${key} = $${i++}::jsonb`);
          params.push(b[key] ? JSON.stringify(b[key]) : null);
        } else if (METRIC_FIELDS.includes(key) || TAPE_FIELDS.includes(key)) {
          fields.push(`${key} = $${i++}`);
          params.push(parseNumeric(b[key], INT_FIELDS.includes(key)));
        } else if (key === 'is_manual_entry') {
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
      `UPDATE body_metrics SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    await logActivity('update', 'body_metric', req.params.id, b.source || 'manual', 'Updated body metric');

    // v3.17: trigger goal recompute on edit too — editing a weigh-in's
    // weight value should re-evaluate matching body-composition goals.
    try {
      const { recomputeForBodyMetric } = require('./goals');
      if (typeof recomputeForBodyMetric === 'function') {
        recomputeForBodyMetric(result.rows[0]).catch(err =>
          console.error('[goals recompute on body-metric update]', err.message));
      }
    } catch (_) { /* goals route not loaded */ }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Body Metric ─────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM body_metrics WHERE id = $1 RETURNING id, measurement_date', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await logActivity('delete', 'body_metric', req.params.id, 'manual', `Deleted: ${result.rows[0].measurement_date}`);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats / Trends ─────────────────────────────────────────
const dateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const round1 = (n) => Math.round(Number(n) * 10) / 10;

// v3.35: compute tape analytics from the set of rows that carry any tape
// value, ordered oldest→newest. Pure function so it's unit-testable.
//   latest:            most recent non-null value + date per field
//   change_vs_baseline: baseline value (on/after baseline_date) vs latest, with delta
//   trend_4wk:         per-field readings within 28 days of the latest tape date
function computeTapeAnalytics(rows, baselineDateParam) {
  const asc = [...rows].sort((a, b) => dateStr(a.measurement_date).localeCompare(dateStr(b.measurement_date)));
  const withAny = asc.filter(r => TAPE_FIELDS.some(f => r[f] != null));
  if (!withAny.length) {
    return { baseline_date: null, latest: {}, change_vs_baseline: {}, trend_4wk: {} };
  }
  const earliest = dateStr(withAny[0].measurement_date);
  const baselineDate = baselineDateParam || earliest;
  const latestTapeDate = dateStr(withAny[withAny.length - 1].measurement_date);
  // 28-day window anchored on the latest tape reading.
  const windowStart = new Date(latestTapeDate + 'T00:00:00Z');
  windowStart.setUTCDate(windowStart.getUTCDate() - 28);
  const windowStartStr = windowStart.toISOString().slice(0, 10);

  const latest = {};
  const change = {};
  const trend = {};
  for (const f of TAPE_FIELDS) {
    // latest non-null
    for (let i = withAny.length - 1; i >= 0; i--) {
      if (withAny[i][f] != null) { latest[f] = { value: round1(withAny[i][f]), date: dateStr(withAny[i].measurement_date) }; break; }
    }
    // baseline = first non-null on/after baselineDate (falls back to earliest non-null)
    let baseRow = withAny.find(r => r[f] != null && dateStr(r.measurement_date) >= baselineDate)
      || withAny.find(r => r[f] != null);
    if (baseRow && latest[f]) {
      const bval = round1(baseRow[f]);
      change[f] = { baseline: bval, baseline_date: dateStr(baseRow.measurement_date), latest: latest[f].value, delta: round1(latest[f].value - bval) };
    }
    // 4-week trend (readings within the 28-day window)
    const pts = withAny
      .filter(r => r[f] != null && dateStr(r.measurement_date) >= windowStartStr)
      .map(r => ({ date: dateStr(r.measurement_date), value: round1(r[f]) }));
    if (pts.length) trend[f] = pts;
  }
  return { baseline_date: baselineDate, latest, change_vs_baseline: change, trend_4wk: trend };
}

router.get('/stats/summary', async (req, res) => {
  try {
    const tapeCols = TAPE_FIELDS.join(', ');
    const [totals, latest, avgWeight, sources, tapeRows, weight7d] = await Promise.all([
      query('SELECT COUNT(*)::int as total FROM body_metrics'),
      query('SELECT * FROM body_metrics ORDER BY measurement_date DESC, measurement_time DESC NULLS LAST LIMIT 1'),
      query('SELECT ROUND(AVG(weight_lb)::numeric, 1)::text as avg_weight FROM body_metrics'),
      query('SELECT source, COUNT(*)::int as count FROM body_metrics GROUP BY source ORDER BY count DESC'),
      // Only rows that carry at least one tape value — cheap, tape rows are sparse.
      query(`SELECT measurement_date, measurement_time, ${tapeCols}
               FROM body_metrics
              WHERE ${TAPE_FIELDS.map(f => `${f} IS NOT NULL`).join(' OR ')}
              ORDER BY measurement_date ASC, measurement_time ASC NULLS LAST`),
      // 7-day average bodyweight (trailing 7 days, inclusive of today).
      query(`SELECT ROUND(AVG(weight_lb)::numeric, 1)::float AS avg7
               FROM body_metrics
              WHERE weight_lb IS NOT NULL
                AND measurement_date >= (CURRENT_DATE - INTERVAL '6 days')`),
    ]);

    const baselineDate = req.query.baseline_date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.baseline_date)
      ? req.query.baseline_date : null;

    res.json({
      total: totals.rows[0]?.total || 0,
      latest: latest.rows[0] ? deriveLeanMass(latest.rows[0]) : null,
      avg_weight_lb: avgWeight.rows[0]?.avg_weight || null,
      weight_7day_avg_lb: weight7d.rows[0]?.avg7 ?? null,
      by_source: sources.rows,
      tape: computeTapeAnalytics(tapeRows.rows, baselineDate),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.computeTapeAnalytics = computeTapeAnalytics;
module.exports.validateBody = validateBody;
module.exports.TAPE_FIELDS = TAPE_FIELDS;
