const express = require('express');
const { queryDatabase, pageToActivity } = require('../notion');
const router = express.Router();

// Get activity log
router.get('/', async (req, res) => {
  try {
    const { limit = 50, entity_type, ai_source } = req.query;
    const filters = [];

    if (entity_type) {
      filters.push({ property: 'Entity Type', select: { equals: entity_type } });
    }
    if (ai_source) {
      filters.push({ property: 'AI Source', select: { equals: ai_source } });
    }

    const filter = filters.length > 1 ? { and: filters }
      : filters.length === 1 ? filters[0] : undefined;

    const result = await queryDatabase('activity_log', filter,
      [{ property: 'Created At', direction: 'descending' }],
      Number(limit));

    const logs = result.results.map(pageToActivity);
    res.json({ count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
