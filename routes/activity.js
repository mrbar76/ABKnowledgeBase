const express = require('express');
const { query } = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { limit = 50, entity_type, ai_source } = req.query;
    const params = [];
    const where = [];
    let i = 1;

    if (entity_type) { where.push(`entity_type = $${i++}`); params.push(entity_type); }
    if (ai_source) { where.push(`ai_source = $${i++}`); params.push(ai_source); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Number(limit));

    const result = await query(
      `SELECT * FROM activity_log ${whereClause} ORDER BY created_at DESC LIMIT $${i}`, params
    );
    res.json({ count: result.rows.length, logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
