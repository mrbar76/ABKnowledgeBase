// PostgreSQL database layer for AB Brain.
// Full-text search via tsvector + pg_trgm, granular Bee transcripts,
// AI conversation storage with both full threads and summaries.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initDB() {
  await query(`
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
      project_id UUID,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
    CREATE INDEX IF NOT EXISTS idx_knowledge_ai_source ON knowledge(ai_source);
    CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_knowledge_search ON knowledge USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_knowledge_trgm ON knowledge USING gin(
      (coalesce(title,'') || ' ' || coalesce(content,'')) gin_trgm_ops
    );

    -- ===== FACTS =====
    CREATE TABLE IF NOT EXISTS facts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      tags JSONB DEFAULT '[]'::jsonb,
      source TEXT DEFAULT 'manual',
      confirmed BOOLEAN DEFAULT false,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source);
    CREATE INDEX IF NOT EXISTS idx_facts_search ON facts USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_facts_trgm ON facts USING gin(
      (coalesce(title,'') || ' ' || coalesce(content,'')) gin_trgm_ops
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
    CREATE INDEX IF NOT EXISTS idx_tasks_ai_agent ON tasks(ai_agent);

    -- ===== TRANSCRIPTS (Bee + other sources) =====
    CREATE TABLE IF NOT EXISTS transcripts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      raw_text TEXT,
      summary TEXT,
      source TEXT DEFAULT 'bee',
      ai_source TEXT,
      duration_seconds INTEGER,
      recorded_at TIMESTAMPTZ,
      location TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      bee_id TEXT,
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(source);
    CREATE INDEX IF NOT EXISTS idx_transcripts_bee_id ON transcripts(bee_id);
    CREATE INDEX IF NOT EXISTS idx_transcripts_recorded ON transcripts(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_transcripts_search ON transcripts USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_transcripts_trgm ON transcripts USING gin(
      (coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'')) gin_trgm_ops
    );

    -- ===== TRANSCRIPT SPEAKERS (granular person-by-person Bee data) =====
    CREATE TABLE IF NOT EXISTS transcript_speakers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      speaker_name TEXT NOT NULL,
      utterance_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      spoken_at TIMESTAMPTZ,
      start_offset_ms INTEGER,
      end_offset_ms INTEGER,
      confidence REAL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_speakers_transcript ON transcript_speakers(transcript_id);
    CREATE INDEX IF NOT EXISTS idx_speakers_name ON transcript_speakers(speaker_name);
    CREATE INDEX IF NOT EXISTS idx_speakers_trgm ON transcript_speakers USING gin(text gin_trgm_ops);

    -- ===== CONVERSATIONS (full AI chat threads — full + summary) =====
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      ai_source TEXT NOT NULL,
      full_thread JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      message_count INTEGER DEFAULT 0,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_ai_source ON conversations(ai_source);
    CREATE INDEX IF NOT EXISTS idx_conversations_search ON conversations USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_conversations_tags ON conversations USING gin(tags);

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
    CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at DESC);
  `);

  // Auto-update search vectors via triggers
  await query(`
    CREATE OR REPLACE FUNCTION update_knowledge_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.content,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION update_facts_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.content,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION update_transcripts_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.summary,'') || ' ' || coalesce(NEW.raw_text,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION update_conversations_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.summary,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_knowledge_search ON knowledge;
    CREATE TRIGGER trg_knowledge_search BEFORE INSERT OR UPDATE OF title, content ON knowledge
      FOR EACH ROW EXECUTE FUNCTION update_knowledge_search();

    DROP TRIGGER IF EXISTS trg_facts_search ON facts;
    CREATE TRIGGER trg_facts_search BEFORE INSERT OR UPDATE OF title, content ON facts
      FOR EACH ROW EXECUTE FUNCTION update_facts_search();

    DROP TRIGGER IF EXISTS trg_transcripts_search ON transcripts;
    CREATE TRIGGER trg_transcripts_search BEFORE INSERT OR UPDATE OF title, summary, raw_text ON transcripts
      FOR EACH ROW EXECUTE FUNCTION update_transcripts_search();

    DROP TRIGGER IF EXISTS trg_conversations_search ON conversations;
    CREATE TRIGGER trg_conversations_search BEFORE INSERT OR UPDATE OF title, summary ON conversations
      FOR EACH ROW EXECUTE FUNCTION update_conversations_search();
  `);

  // Backfill search vectors for any existing rows
  await query(`UPDATE knowledge SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')) WHERE search_vector IS NULL`);
  await query(`UPDATE facts SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')) WHERE search_vector IS NULL`);
  await query(`UPDATE transcripts SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'')) WHERE search_vector IS NULL`);
  await query(`UPDATE conversations SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'')) WHERE search_vector IS NULL`);

  console.log('PostgreSQL database initialized successfully');
}

// ─── Activity log helper ─────────────────────────────────────────

async function logActivity(action, entityType, entityId, aiSource, details) {
  try {
    await query(
      `INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details) VALUES ($1, $2, $3, $4, $5)`,
      [action, entityType, entityId, aiSource, details]
    );
  } catch (err) {
    console.error(`[activity-log] Failed to log: ${err.message}`);
  }
}

module.exports = { pool, query, initDB, logActivity };
