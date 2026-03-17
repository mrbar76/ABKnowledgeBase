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

// Run a query, log errors but don't throw (for init resilience)
async function safeQuery(label, text, params) {
  try {
    await query(text, params);
  } catch (err) {
    console.error(`[initDB] ${label} failed: ${err.message}`);
  }
}

async function initDB() {
  // Extension (needed for trigram indexes)
  await safeQuery('pg_trgm', `CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  // ===== KNOWLEDGE BASE =====
  await safeQuery('knowledge table', `
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
    )`);
  await safeQuery('knowledge indexes', `
    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
    CREATE INDEX IF NOT EXISTS idx_knowledge_ai_source ON knowledge(ai_source);
    CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_knowledge_search ON knowledge USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_knowledge_trgm ON knowledge USING gin(
      (coalesce(title,'') || ' ' || coalesce(content,'')) gin_trgm_ops
    )`);

  // ===== FACTS =====
  await safeQuery('facts table', `
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
    )`);
  await safeQuery('facts indexes', `
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
    CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source);
    CREATE INDEX IF NOT EXISTS idx_facts_search ON facts USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_facts_trgm ON facts USING gin(
      (coalesce(title,'') || ' ' || coalesce(content,'')) gin_trgm_ops
    )`);

  // ===== PROJECTS =====
  await safeQuery('projects table', `
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

  // ===== TASKS =====
  await safeQuery('tasks table', `
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
    )`);
  await safeQuery('tasks indexes', `
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_ai_agent ON tasks(ai_agent)`);

  // ===== TRANSCRIPTS =====
  await safeQuery('transcripts table', `
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
    )`);
  await safeQuery('transcripts indexes', `
    CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(source);
    CREATE INDEX IF NOT EXISTS idx_transcripts_bee_id ON transcripts(bee_id);
    CREATE INDEX IF NOT EXISTS idx_transcripts_recorded ON transcripts(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_transcripts_search ON transcripts USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_transcripts_trgm ON transcripts USING gin(
      (coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'')) gin_trgm_ops
    )`);

  // ===== TRANSCRIPT SPEAKERS =====
  await safeQuery('transcript_speakers table', `
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
    )`);
  await safeQuery('transcript_speakers indexes', `
    CREATE INDEX IF NOT EXISTS idx_speakers_transcript ON transcript_speakers(transcript_id);
    CREATE INDEX IF NOT EXISTS idx_speakers_name ON transcript_speakers(speaker_name);
    CREATE INDEX IF NOT EXISTS idx_speakers_trgm ON transcript_speakers USING gin(text gin_trgm_ops)`);

  // ===== CONVERSATIONS =====
  await safeQuery('conversations table', `
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
    )`);
  await safeQuery('conversations indexes', `
    CREATE INDEX IF NOT EXISTS idx_conversations_ai_source ON conversations(ai_source);
    CREATE INDEX IF NOT EXISTS idx_conversations_search ON conversations USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_conversations_tags ON conversations USING gin(tags)`);

  // ===== ACTIVITY LOG =====
  await safeQuery('activity_log table', `
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      ai_source TEXT,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('activity_log indexes', `
    CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at DESC)`);

  // ===== WORKOUT LOGS =====
  await safeQuery('workouts table', `
    CREATE TABLE IF NOT EXISTS workouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      workout_date DATE NOT NULL DEFAULT CURRENT_DATE,
      workout_type TEXT DEFAULT 'hybrid' CHECK(workout_type IN ('hill','strength','run','hybrid','recovery','ruck')),
      location TEXT,
      elevation TEXT,
      focus TEXT,
      warmup TEXT,
      main_sets TEXT,
      carries TEXT,
      time_duration TEXT,
      distance TEXT,
      elevation_gain TEXT,
      heart_rate_avg TEXT,
      heart_rate_max TEXT,
      pace_avg TEXT,
      splits TEXT,
      cadence_avg TEXT,
      active_calories TEXT,
      total_calories TEXT,
      effort INTEGER CHECK(effort >= 1 AND effort <= 10),
      slowdown_notes TEXT,
      failure_first TEXT,
      grip_feedback TEXT,
      legs_feedback TEXT,
      cardio_feedback TEXT,
      shoulder_feedback TEXT,
      body_notes TEXT,
      adjustment TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      source TEXT DEFAULT 'manual',
      ai_source TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('workouts indexes', `
    CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(workout_date DESC);
    CREATE INDEX IF NOT EXISTS idx_workouts_type ON workouts(workout_type);
    CREATE INDEX IF NOT EXISTS idx_workouts_tags ON workouts USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_workouts_search ON workouts USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_workouts_trgm ON workouts USING gin(
      (coalesce(title,'') || ' ' || coalesce(focus,'') || ' ' || coalesce(main_sets,'') || ' ' || coalesce(body_notes,'')) gin_trgm_ops
    )`);

  // ===== SCHEMA MIGRATIONS =====
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS ensures columns exist even if
  // tables were created by an older schema version (CREATE TABLE IF NOT EXISTS
  // skips existing tables entirely, never adding new columns).

  // -- knowledge migrations --
  await safeQuery('knowledge +ai_source', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('knowledge +project_id', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS project_id UUID`);
  await safeQuery('knowledge +metadata', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('knowledge +search_vector', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('knowledge +source', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`);
  await safeQuery('knowledge +tags', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('knowledge +updated_at', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- facts migrations --
  await safeQuery('facts +search_vector', `ALTER TABLE facts ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('facts +tags', `ALTER TABLE facts ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('facts +confirmed', `ALTER TABLE facts ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT false`);
  await safeQuery('facts +updated_at', `ALTER TABLE facts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- projects migrations --
  await safeQuery('projects +updated_at', `ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- tasks migrations --
  await safeQuery('tasks +project_id', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID`);
  await safeQuery('tasks +description', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT`);
  await safeQuery('tasks +priority', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium'`);
  await safeQuery('tasks +ai_agent', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_agent TEXT`);
  await safeQuery('tasks +next_steps', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_steps TEXT`);
  await safeQuery('tasks +output_log', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS output_log TEXT`);
  await safeQuery('tasks +updated_at', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- transcripts migrations --
  await safeQuery('transcripts +raw_text', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS raw_text TEXT`);
  await safeQuery('transcripts +ai_source', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('transcripts +duration_seconds', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS duration_seconds INTEGER`);
  await safeQuery('transcripts +recorded_at', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ`);
  await safeQuery('transcripts +location', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS location TEXT`);
  await safeQuery('transcripts +tags', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('transcripts +bee_id', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS bee_id TEXT`);
  await safeQuery('transcripts +project_id', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS project_id UUID`);
  await safeQuery('transcripts +metadata', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('transcripts +search_vector', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('transcripts +updated_at', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- transcript_speakers migrations --
  await safeQuery('transcript_speakers +spoken_at', `ALTER TABLE transcript_speakers ADD COLUMN IF NOT EXISTS spoken_at TIMESTAMPTZ`);
  await safeQuery('transcript_speakers +start_offset_ms', `ALTER TABLE transcript_speakers ADD COLUMN IF NOT EXISTS start_offset_ms INTEGER`);
  await safeQuery('transcript_speakers +end_offset_ms', `ALTER TABLE transcript_speakers ADD COLUMN IF NOT EXISTS end_offset_ms INTEGER`);
  await safeQuery('transcript_speakers +confidence', `ALTER TABLE transcript_speakers ADD COLUMN IF NOT EXISTS confidence REAL`);

  // -- conversations migrations --
  await safeQuery('conversations +full_thread', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS full_thread JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await safeQuery('conversations +summary', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary TEXT`);
  await safeQuery('conversations +tags', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('conversations +project_id', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id UUID`);
  await safeQuery('conversations +message_count', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_count INTEGER DEFAULT 0`);
  await safeQuery('conversations +metadata', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('conversations +search_vector', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('conversations +updated_at', `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- activity_log migrations --
  await safeQuery('activity_log +ai_source', `ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('activity_log +entity_type', `ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS entity_type TEXT`);
  await safeQuery('activity_log +entity_id', `ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS entity_id TEXT`);
  await safeQuery('activity_log +details', `ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS details TEXT`);

  // -- workouts migrations --
  await safeQuery('workouts +title', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS title TEXT`);
  await safeQuery('workouts +workout_date', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS workout_date DATE NOT NULL DEFAULT CURRENT_DATE`);
  await safeQuery('workouts +workout_type', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS workout_type TEXT DEFAULT 'hybrid'`);
  await safeQuery('workouts +location', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS location TEXT`);
  await safeQuery('workouts +elevation', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS elevation TEXT`);
  await safeQuery('workouts +focus', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS focus TEXT`);
  await safeQuery('workouts +warmup', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS warmup TEXT`);
  await safeQuery('workouts +main_sets', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS main_sets TEXT`);
  await safeQuery('workouts +carries', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS carries TEXT`);
  await safeQuery('workouts +time_duration', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS time_duration TEXT`);
  await safeQuery('workouts +distance', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS distance TEXT`);
  await safeQuery('workouts +elevation_gain', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS elevation_gain TEXT`);
  await safeQuery('workouts +effort', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS effort INTEGER`);
  await safeQuery('workouts +slowdown_notes', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS slowdown_notes TEXT`);
  await safeQuery('workouts +failure_first', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS failure_first TEXT`);
  await safeQuery('workouts +grip_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS grip_feedback TEXT`);
  await safeQuery('workouts +legs_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS legs_feedback TEXT`);
  await safeQuery('workouts +cardio_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS cardio_feedback TEXT`);
  await safeQuery('workouts +shoulder_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS shoulder_feedback TEXT`);
  await safeQuery('workouts +body_notes', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS body_notes TEXT`);
  await safeQuery('workouts +adjustment', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS adjustment TEXT`);
  await safeQuery('workouts +tags', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('workouts +source', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`);
  await safeQuery('workouts +ai_source', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('workouts +heart_rate_avg', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS heart_rate_avg TEXT`);
  await safeQuery('workouts +heart_rate_max', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS heart_rate_max TEXT`);
  await safeQuery('workouts +pace_avg', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS pace_avg TEXT`);
  await safeQuery('workouts +splits', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS splits TEXT`);
  await safeQuery('workouts +cadence_avg', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS cadence_avg TEXT`);
  await safeQuery('workouts +active_calories', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS active_calories TEXT`);
  await safeQuery('workouts +total_calories', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS total_calories TEXT`);
  await safeQuery('workouts +metadata', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('workouts +search_vector', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('workouts +updated_at', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await safeQuery('workouts started_at default', `ALTER TABLE workouts ALTER COLUMN started_at SET DEFAULT NOW()`);
  await safeQuery('workouts started_at nullable', `ALTER TABLE workouts ALTER COLUMN started_at DROP NOT NULL`);

  // ===== SEARCH TRIGGERS =====
  await safeQuery('search triggers', `
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

    CREATE OR REPLACE FUNCTION update_workouts_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.focus,'') || ' ' || coalesce(NEW.main_sets,'') || ' ' || coalesce(NEW.body_notes,'') || ' ' || coalesce(NEW.adjustment,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_workouts_search ON workouts;
    CREATE TRIGGER trg_workouts_search BEFORE INSERT OR UPDATE OF title, focus, main_sets, body_notes, adjustment ON workouts
      FOR EACH ROW EXECUTE FUNCTION update_workouts_search();
  `);

  // Backfill search vectors for any existing rows
  await safeQuery('backfill knowledge search', `UPDATE knowledge SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill facts search', `UPDATE facts SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill transcripts search', `UPDATE transcripts SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill conversations search', `UPDATE conversations SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill workouts search', `UPDATE workouts SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(focus,'') || ' ' || coalesce(main_sets,'') || ' ' || coalesce(body_notes,'') || ' ' || coalesce(adjustment,'')) WHERE search_vector IS NULL`);

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
