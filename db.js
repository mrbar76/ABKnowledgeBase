const { Pool } = require('pg');

// Railway provides DATABASE_URL automatically when you add Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

// Helper for running queries
async function query(text, params) {
  return pool.query(text, params);
}

// Initialize all tables
async function initDB() {
  await query(`
    -- Enable full-text search
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- ===== KNOWLEDGE BASE =====
    CREATE TABLE IF NOT EXISTS knowledge (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      tags JSONB DEFAULT '[]'::jsonb,
      source TEXT DEFAULT 'manual',
      ai_source TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
    CREATE INDEX IF NOT EXISTS idx_knowledge_ai_source ON knowledge(ai_source);
    CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_knowledge_search ON knowledge USING gin(
      (to_tsvector('english', coalesce(title,'')) || to_tsvector('english', coalesce(content,'')))
    );

    -- ===== PROJECTS =====
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===== TASKS =====
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      ai_agent TEXT,
      next_steps TEXT,
      output_log TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    -- ===== TRANSCRIPTS (Bee.computer + other sources) =====
    CREATE TABLE IF NOT EXISTS transcripts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      summary TEXT,
      source TEXT DEFAULT 'bee',
      speaker_labels JSONB DEFAULT '[]'::jsonb,
      duration_seconds INTEGER,
      recorded_at TIMESTAMPTZ,
      tags JSONB DEFAULT '[]'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(source);
    CREATE INDEX IF NOT EXISTS idx_transcripts_recorded ON transcripts(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_transcripts_search ON transcripts USING gin(
      (to_tsvector('english', coalesce(title,'')) || to_tsvector('english', coalesce(raw_text,'')))
    );

    -- ===== ACTIVITY LOG =====
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      ai_source TEXT,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at);
  `);

  // Migrations — add columns safely
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS location TEXT`);

  console.log('Database initialized successfully');
}

module.exports = { pool, query, initDB };
