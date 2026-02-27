const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { initDB } = require('./db');

const knowledgeRoutes = require('./routes/knowledge');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const transcriptRoutes = require('./routes/transcripts');
const healthRoutes = require('./routes/health');
const activityRoutes = require('./routes/activity');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check — BEFORE auth middleware so Railway can reach it
app.get('/api/health-check', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API key authentication for /api routes
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
});

// API Routes — health data routes mounted at /api/healthdata to avoid conflict
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/transcripts', transcriptRoutes);
app.use('/api/healthdata', healthRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server, then init DB (so healthcheck responds while DB sets up)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AB Knowledge Base running on port ${PORT}`);
});

// Initialize database after server is listening
initDB().then(() => {
  console.log('Database ready');
}).catch(err => {
  console.error('Database init failed:', err.message);
  console.error('Server is running but database is not available.');
  console.error('Make sure DATABASE_URL is set and Postgres is accessible.');
});
