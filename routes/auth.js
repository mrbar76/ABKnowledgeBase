const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

// POST /api/auth/login
// Validates {username, password} against env vars and returns the
// shared API_KEY as a session token. The API key keeps working for
// integrations (Claude, ChatGPT, Apple Shortcuts) that send it
// directly via X-Api-Key — this route is just a friendlier login
// layer for the PWA.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const expectedUser = process.env.LOGIN_USERNAME;
  const expectedHash = process.env.LOGIN_PASSWORD_HASH;
  const apiKey = process.env.API_KEY;

  if (!expectedUser || !expectedHash || !apiKey) {
    return res.status(503).json({
      error: 'Login not configured. Set LOGIN_USERNAME, LOGIN_PASSWORD_HASH, and API_KEY env vars.'
    });
  }

  if (username !== expectedUser) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  let valid = false;
  try {
    valid = await bcrypt.compare(password, expectedHash);
  } catch {
    valid = false;
  }
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({ api_key: apiKey });
});

module.exports = router;
