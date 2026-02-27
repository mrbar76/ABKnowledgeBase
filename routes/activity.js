const express = require('express');
const { query } = require('../db');
const router = express.Router();

// Get activity log
router.get('/', async (req, res) => {
  try {
    const { limit = 50, offset = 0, entity_type, ai_source } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    if (entity_type) { where.push(`entity_type = $${idx++}`); params.push(entity_type); }
    if (ai_source) { where.push(`ai_source = $${idx++}`); params.push(ai_source); }

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await query(`
      SELECT * FROM activity_log ${clause}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, Number(limit), Number(offset)]);

    res.json({ count: result.rows.length, logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
