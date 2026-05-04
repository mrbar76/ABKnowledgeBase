// PostgreSQL database layer for AB Brain.
// Full-text search via tsvector + pg_trgm, granular Bee transcripts,
// AI conversation storage with both full threads and summaries.

const { Pool } = require('pg');

const APP_TIMEZONE = process.env.TZ || process.env.APP_TIMEZONE || 'America/New_York';

// Set timezone via the PG protocol startup options. This avoids the
// deprecated `pool.on('connect', client => client.query(...))` pattern
// which fires the warning:
//   "Calling client.query() when the client is already executing a
//    query is deprecated and will be removed in pg@9.0"
// because the connect handler doesn't await the SET, leaving the
// client in an indeterminate state when subsequent queries arrive.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
  // -c key=value sets a server parameter at connection startup; no
  // separate SQL roundtrip required.
  options: `-c timezone=${APP_TIMEZONE}`,
});

async function query(text, params) {
  return pool.query(text, params);
}

// Run `fn` inside a single-client transaction. The callback receives a
// pg Client; every statement that should be atomic must use that client
// (not the module-level `query` helper, which checks out its own client).
// Commits on success, rolls back on any thrown error, and always releases
// the client back to the pool.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be broken */ }
    throw err;
  } finally {
    client.release();
  }
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

  // ===== KNOWLEDGE BASE (includes merged facts) =====
  await safeQuery('knowledge table', `
    CREATE TABLE IF NOT EXISTS knowledge (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      tags JSONB DEFAULT '[]'::jsonb,
      source TEXT DEFAULT 'manual',
      ai_source TEXT,
      confirmed BOOLEAN DEFAULT false,
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

  // (facts table removed — merged into knowledge)
  // (projects table removed)

  // ===== TASKS =====
  await safeQuery('tasks table', `
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      ai_agent TEXT,
      next_steps TEXT,
      output_log TEXT,
      due_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('tasks indexes', `
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_ai_agent ON tasks(ai_agent);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date)`);
  await safeQuery('tasks due_date column', `
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE`);

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
      workout_type TEXT DEFAULT 'hybrid',
      location TEXT,
      focus TEXT,
      warmup TEXT,
      main_sets TEXT,
      exercises JSONB DEFAULT '[]'::jsonb,
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

  // ===== EXERCISE CATALOG =====
  await safeQuery('exercises table', `
    CREATE TABLE IF NOT EXISTS exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      level TEXT DEFAULT 'beginner',
      equipment TEXT DEFAULT 'Body Weight',
      primary_muscle_groups TEXT,
      category TEXT,
      muscle_strength_score NUMERIC(6,2) DEFAULT 0,
      sets_logged INTEGER DEFAULT 0,
      description TEXT,
      secondary_muscle_groups TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      source TEXT DEFAULT 'fitbod',
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('exercises indexes', `
    CREATE INDEX IF NOT EXISTS idx_exercises_name ON exercises(name);
    CREATE INDEX IF NOT EXISTS idx_exercises_equipment ON exercises(equipment);
    CREATE INDEX IF NOT EXISTS idx_exercises_category ON exercises(category);
    CREATE INDEX IF NOT EXISTS idx_exercises_level ON exercises(level);
    CREATE INDEX IF NOT EXISTS idx_exercises_mscore ON exercises(muscle_strength_score DESC);
    CREATE INDEX IF NOT EXISTS idx_exercises_search ON exercises USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_exercises_trgm ON exercises USING gin(
      (coalesce(name,'') || ' ' || coalesce(equipment,'') || ' ' || coalesce(primary_muscle_groups,'') || ' ' || coalesce(category,'') || ' ' || coalesce(description,'')) gin_trgm_ops
    )`);

  // ===== GYM PROFILES =====
  await safeQuery('gym_profiles table', `
    CREATE TABLE IF NOT EXISTS gym_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      equipment JSONB DEFAULT '[]'::jsonb,
      is_primary BOOLEAN DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('gym_profiles indexes', `
    CREATE INDEX IF NOT EXISTS idx_gym_profiles_primary ON gym_profiles(is_primary);
    CREATE INDEX IF NOT EXISTS idx_gym_profiles_equipment ON gym_profiles USING gin(equipment)
  `);

  // ===== BODY METRICS =====
  await safeQuery('body_metrics table', `
    CREATE TABLE IF NOT EXISTS body_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      measurement_date DATE NOT NULL,
      measurement_time TIME,
      source TEXT DEFAULT 'RENPHO',
      source_type TEXT DEFAULT 'smart_scale',
      weight_lb NUMERIC(6,2) NOT NULL,
      bmi NUMERIC(5,2),
      body_fat_pct NUMERIC(5,2),
      skeletal_muscle_pct NUMERIC(5,2),
      fat_free_mass_lb NUMERIC(6,2),
      subcutaneous_fat_pct NUMERIC(5,2),
      visceral_fat INTEGER,
      body_water_pct NUMERIC(5,2),
      muscle_mass_lb NUMERIC(6,2),
      bone_mass_lb NUMERIC(5,2),
      protein_pct NUMERIC(5,2),
      bmr_kcal INTEGER,
      metabolic_age INTEGER,
      measurement_context TEXT,
      vendor_user_mode TEXT,
      notes TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      is_manual_entry BOOLEAN DEFAULT false,
      raw_payload JSONB,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('body_metrics indexes', `
    CREATE INDEX IF NOT EXISTS idx_body_metrics_date ON body_metrics(measurement_date DESC);
    CREATE INDEX IF NOT EXISTS idx_body_metrics_source ON body_metrics(source);
    CREATE INDEX IF NOT EXISTS idx_body_metrics_tags ON body_metrics USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_body_metrics_search ON body_metrics USING gin(search_vector)`);

  // ===== MEALS =====
  await safeQuery('meals table', `
    CREATE TABLE IF NOT EXISTS meals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      meal_date DATE NOT NULL DEFAULT CURRENT_DATE,
      meal_time TIME,
      meal_type TEXT DEFAULT 'meal',
      title TEXT NOT NULL,
      calories NUMERIC(7,1),
      protein_g NUMERIC(6,1),
      carbs_g NUMERIC(6,1),
      fat_g NUMERIC(6,1),
      fiber_g NUMERIC(6,1),
      sugar_g NUMERIC(6,1),
      sodium_mg NUMERIC(7,1),
      serving_size TEXT,
      hunger_before INTEGER CHECK(hunger_before >= 1 AND hunger_before <= 10),
      fullness_after INTEGER CHECK(fullness_after >= 1 AND fullness_after <= 10),
      energy_after INTEGER CHECK(energy_after >= 1 AND energy_after <= 10),
      notes TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      source TEXT DEFAULT 'manual',
      ai_source TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('meals indexes', `
    CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(meal_date DESC);
    CREATE INDEX IF NOT EXISTS idx_meals_type ON meals(meal_type);
    CREATE INDEX IF NOT EXISTS idx_meals_tags ON meals USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_meals_search ON meals USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_meals_trgm ON meals USING gin(
      (coalesce(title,'') || ' ' || coalesce(notes,'')) gin_trgm_ops
    )`);

  // ===== DAILY CONTEXT (renamed from daily_nutrition_context) =====
  await safeQuery('daily_context table', `
    CREATE TABLE IF NOT EXISTS daily_context (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      date DATE NOT NULL UNIQUE,
      day_type TEXT CHECK(day_type IN ('rest','strength','run','hill','hybrid','race','travel')),
      hydration_liters NUMERIC(4,2),
      energy_rating INTEGER CHECK(energy_rating >= 1 AND energy_rating <= 10),
      hunger_rating INTEGER CHECK(hunger_rating >= 1 AND hunger_rating <= 10),
      cravings TEXT,
      digestion TEXT,
      notes TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('daily_context indexes', `
    CREATE INDEX IF NOT EXISTS idx_dc_date ON daily_context(date DESC);
    CREATE INDEX IF NOT EXISTS idx_dc_search ON daily_context USING gin(search_vector)`);

  // ===== COACHING SESSIONS =====
  await safeQuery('coaching_sessions table', `
    CREATE TABLE IF NOT EXISTS coaching_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_date DATE NOT NULL DEFAULT CURRENT_DATE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_decisions JSONB DEFAULT '[]'::jsonb,
      adjustments JSONB DEFAULT '[]'::jsonb,
      injury_notes TEXT,
      nutrition_notes TEXT,
      recovery_notes TEXT,
      mental_notes TEXT,
      next_steps TEXT,
      data_reviewed JSONB DEFAULT '{}'::jsonb,
      conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      ai_source TEXT DEFAULT 'chatgpt',
      tags JSONB DEFAULT '[]'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('coaching_sessions indexes', `
    CREATE INDEX IF NOT EXISTS idx_coaching_sessions_date ON coaching_sessions(session_date DESC);
    CREATE INDEX IF NOT EXISTS idx_coaching_sessions_tags ON coaching_sessions USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_coaching_sessions_search ON coaching_sessions USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_coaching_sessions_trgm ON coaching_sessions USING gin(
      (coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(injury_notes,'') || ' ' || coalesce(next_steps,'')) gin_trgm_ops
    )`);

  // ===== DAILY PLANS =====
  await safeQuery('daily_plans table', `
    CREATE TABLE IF NOT EXISTS daily_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_date DATE NOT NULL UNIQUE,
      status TEXT DEFAULT 'planned' CHECK(status IN ('planned','completed','partial','missed','rest','amended')),
      title TEXT,
      goal TEXT,
      workout_type TEXT,
      workout_focus TEXT,
      target_effort INTEGER CHECK(target_effort >= 1 AND target_effort <= 10),
      target_duration_min INTEGER,
      workout_notes TEXT,
      target_calories NUMERIC(7,1),
      target_protein_g NUMERIC(6,1),
      target_carbs_g NUMERIC(6,1),
      target_fat_g NUMERIC(6,1),
      target_hydration_liters NUMERIC(4,2),
      target_sleep_hours NUMERIC(3,1),
      recovery_notes TEXT,
      coaching_notes TEXT,
      rationale TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      ai_source TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('daily_plans indexes', `
    CREATE INDEX IF NOT EXISTS idx_daily_plans_date ON daily_plans(plan_date DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_plans_status ON daily_plans(status);
    CREATE INDEX IF NOT EXISTS idx_daily_plans_tags ON daily_plans USING gin(tags)
  `);

  // ===== INJURIES =====
  await safeQuery('injuries table', `
    CREATE TABLE IF NOT EXISTS injuries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      body_area TEXT NOT NULL,
      side TEXT CHECK(side IN ('left','right','bilateral','central','n/a')),
      injury_type TEXT DEFAULT 'strain' CHECK(injury_type IN ('strain','sprain','tendinitis','soreness','tightness','pain','fracture','contusion','overuse','other')),
      severity INTEGER CHECK(severity >= 1 AND severity <= 10),
      status TEXT DEFAULT 'active' CHECK(status IN ('active','monitoring','recovering','resolved','chronic')),
      onset_date DATE,
      resolved_date DATE,
      symptoms TEXT,
      treatment TEXT,
      notes TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      ai_source TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('injuries indexes', `
    CREATE INDEX IF NOT EXISTS idx_injuries_status ON injuries(status);
    CREATE INDEX IF NOT EXISTS idx_injuries_body_area ON injuries(body_area);
    CREATE INDEX IF NOT EXISTS idx_injuries_onset ON injuries(onset_date DESC);
    CREATE INDEX IF NOT EXISTS idx_injuries_tags ON injuries USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_injuries_search ON injuries USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_injuries_trgm ON injuries USING gin(
      (coalesce(title,'') || ' ' || coalesce(body_area,'') || ' ' || coalesce(symptoms,'') || ' ' || coalesce(treatment,'') || ' ' || coalesce(notes,'')) gin_trgm_ops
    )`);

  // (goal_profiles table removed — readiness system removed)

  // (readiness_snapshots table removed)

  // ===== SCHEMA MIGRATIONS =====
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS ensures columns exist even if
  // tables were created by an older schema version (CREATE TABLE IF NOT EXISTS
  // skips existing tables entirely, never adding new columns).

  // -- knowledge migrations --
  await safeQuery('knowledge +ai_source', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('knowledge +metadata', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('knowledge +search_vector', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('knowledge +source', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`);
  await safeQuery('knowledge +tags', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('knowledge +updated_at', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await safeQuery('knowledge +confirmed', `ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT false`);
  // -- tasks migrations --
  await safeQuery('tasks +description', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT`);
  await safeQuery('tasks +priority', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium'`);
  await safeQuery('tasks +ai_agent', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_agent TEXT`);
  await safeQuery('tasks +next_steps', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_steps TEXT`);
  await safeQuery('tasks +output_log', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS output_log TEXT`);
  await safeQuery('tasks +updated_at', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await safeQuery('tasks +context', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS context TEXT`);
  await safeQuery('tasks +source_id', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_id TEXT`);
  await safeQuery('tasks idx_source_id', `CREATE INDEX IF NOT EXISTS idx_tasks_source_id ON tasks(source_id)`);
  await safeQuery('tasks idx_context', `CREATE INDEX IF NOT EXISTS idx_tasks_context ON tasks(context)`);
  await safeQuery('tasks +completed_at', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
  await safeQuery('tasks +notes', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safeQuery('tasks +tags', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('tasks +checklist', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('tasks +waiting_on', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_on TEXT`);
  await safeQuery('tasks idx_waiting_on', `CREATE INDEX IF NOT EXISTS idx_tasks_waiting_on ON tasks(waiting_on)`);
  // -- recurring tasks migrations --
  await safeQuery('tasks +recurrence_rule', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_rule JSONB`);
  await safeQuery('tasks +recurring_parent_id', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurring_parent_id UUID REFERENCES tasks(id) ON DELETE SET NULL`);
  await safeQuery('tasks idx_recurring_parent', `CREATE INDEX IF NOT EXISTS idx_tasks_recurring_parent_id ON tasks(recurring_parent_id)`);
  await safeQuery('tasks +reminder_at', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMPTZ`);
  await safeQuery('tasks idx_reminder_at', `CREATE INDEX IF NOT EXISTS idx_tasks_reminder_at ON tasks(reminder_at) WHERE reminder_at IS NOT NULL`);
  await safeQuery('tasks +linked_items', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_items JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('tasks +parent_id', `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES tasks(id) ON DELETE SET NULL`);
  await safeQuery('tasks idx_parent', `CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id)`);
  await safeQuery('tasks status_check +all_statuses', `
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK(status IN ('inbox','todo','planned','in_progress','waiting','waiting_on','review','done','cancelled'))
  `);

  // -- task_comments table --
  await safeQuery('task_comments table', `
    CREATE TABLE IF NOT EXISTS task_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      author TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('task_comments idx', `CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id)`);

  // -- transcripts migrations --
  await safeQuery('transcripts +raw_text', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS raw_text TEXT`);
  await safeQuery('transcripts +ai_source', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('transcripts +duration_seconds', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS duration_seconds INTEGER`);
  await safeQuery('transcripts +recorded_at', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ`);
  await safeQuery('transcripts +location', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS location TEXT`);
  await safeQuery('transcripts +tags', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('transcripts +bee_id', `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS bee_id TEXT`);
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
  await safeQuery('workouts +focus', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS focus TEXT`);
  await safeQuery('workouts +warmup', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS warmup TEXT`);
  await safeQuery('workouts +main_sets', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS main_sets TEXT`);
  await safeQuery('workouts +time_duration', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS time_duration TEXT`);
  await safeQuery('workouts +distance', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS distance TEXT`);
  await safeQuery('workouts +elevation_gain', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS elevation_gain TEXT`);
  await safeQuery('workouts +effort', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS effort INTEGER`);
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
  await safeQuery('workouts +exercises', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS exercises JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('workouts +metadata', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('workouts +search_vector', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('workouts +updated_at', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await safeQuery('workouts started_at default', `ALTER TABLE workouts ALTER COLUMN started_at SET DEFAULT NOW()`);
  await safeQuery('workouts started_at nullable', `ALTER TABLE workouts ALTER COLUMN started_at DROP NOT NULL`);
  await safeQuery('workouts drop type check', `ALTER TABLE workouts DROP CONSTRAINT IF EXISTS workouts_workout_type_check`);
  await safeQuery('workouts +elevation', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS elevation TEXT`);
  await safeQuery('workouts +carries', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS carries TEXT`);
  await safeQuery('workouts +slowdown_notes', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS slowdown_notes TEXT`);
  await safeQuery('workouts +failure_first', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS failure_first TEXT`);
  await safeQuery('workouts +grip_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS grip_feedback TEXT`);
  await safeQuery('workouts +legs_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS legs_feedback TEXT`);
  await safeQuery('workouts +cardio_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS cardio_feedback TEXT`);
  await safeQuery('workouts +shoulder_feedback', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS shoulder_feedback TEXT`);
  await safeQuery('workouts +completion_status', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS completion_status TEXT DEFAULT 'logged'`);
  await safeQuery('workouts +plan_comparison_notes', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS plan_comparison_notes TEXT`);

  // exercises: table is created with CREATE TABLE IF NOT EXISTS (line 215) and is
  // never dropped on boot. User edits and bulk-imported rows survive restarts.
  // Bulk re-imports go through routes/exercises.js POST /import-fitbod which
  // upserts via INSERT ... ON CONFLICT (name) DO UPDATE.

  // -- gym_profiles migrations --
  await safeQuery('gym_profiles +name', `ALTER TABLE gym_profiles ADD COLUMN IF NOT EXISTS name TEXT`);
  await safeQuery('gym_profiles +equipment', `ALTER TABLE gym_profiles ADD COLUMN IF NOT EXISTS equipment JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('gym_profiles +is_primary', `ALTER TABLE gym_profiles ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false`);
  await safeQuery('gym_profiles +notes', `ALTER TABLE gym_profiles ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safeQuery('gym_profiles +created_at', `ALTER TABLE gym_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await safeQuery('gym_profiles +updated_at', `ALTER TABLE gym_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  // Migrate is_active → is_primary if fix branch created the table first
  await safeQuery('gym_profiles migrate is_active→is_primary', `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'gym_profiles' AND column_name = 'is_active') THEN
        UPDATE gym_profiles SET is_primary = is_active WHERE is_primary = false AND is_active = true;
        ALTER TABLE gym_profiles DROP COLUMN is_active;
      END IF;
    END $$`);
  // Fix equipment TEXT[] → JSONB if fix branch created it as array
  await safeQuery('gym_profiles fix equipment type', `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'gym_profiles' AND column_name = 'equipment' AND udt_name = '_text') THEN
        ALTER TABLE gym_profiles DROP COLUMN equipment;
        ALTER TABLE gym_profiles ADD COLUMN equipment JSONB DEFAULT '[]'::jsonb;
      END IF;
    END $$`);

  // -- daily_plans migrations: planned_exercises moved earlier in the
  //    init flow; the duplicate ALTER here was removed in v1.8.1.

  // -- workouts: add proper numeric columns alongside TEXT originals --
  await safeQuery('workouts +duration_minutes', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS duration_minutes INTEGER`);
  await safeQuery('workouts +distance_value', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS distance_value NUMERIC(7,2)`);
  await safeQuery('workouts +elevation_gain_ft', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS elevation_gain_ft INTEGER`);
  await safeQuery('workouts +hr_avg', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS hr_avg INTEGER`);
  await safeQuery('workouts +hr_max', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS hr_max INTEGER`);
  await safeQuery('workouts +cadence', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS cadence INTEGER`);
  await safeQuery('workouts +cal_active', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS cal_active INTEGER`);
  await safeQuery('workouts +cal_total', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS cal_total INTEGER`);

  // Backfill numeric columns from TEXT fields (safe: only updates NULLs)
  // v1.8.17: anchored regex matching the JS parseDurationMin fix.
  // Old version used "h <= 12" heuristic which miscounted any mm:ss
  // duration where mm <= 12. Coach's audit found stored duration_minutes
  // matching exact seconds for 8 records (e.g. 324 stored, 5:24 mm:ss
  // = 324 sec = 5 min). Now: 3-segment = h*60 + m + ROUND(s/60),
  // 2-segment = m + ROUND(s/60). Two-segment ALWAYS treated as mm:ss
  // (the format formatDuration() emits in routes/health.js).
  await safeQuery('backfill duration_minutes v3', `
    UPDATE workouts SET duration_minutes = (
      CASE
        WHEN time_duration ~ '^\\d+:\\d{1,2}:\\d{1,2}$' THEN
          SPLIT_PART(time_duration, ':', 1)::int * 60
          + SPLIT_PART(time_duration, ':', 2)::int
          + ROUND(SPLIT_PART(time_duration, ':', 3)::int / 60.0)::int
        WHEN time_duration ~ '^\\d+:\\d{1,2}$' THEN
          SPLIT_PART(time_duration, ':', 1)::int
          + ROUND(SPLIT_PART(time_duration, ':', 2)::int / 60.0)::int
        WHEN time_duration ~ '^[\\d.]+ *h' THEN
          ROUND(REGEXP_REPLACE(time_duration, '[^\\d.]', '', 'g')::numeric * 60)::int
        WHEN time_duration ~ '^[\\d.]+' THEN
          LEAST(ROUND(REGEXP_REPLACE(time_duration, '[^\\d.]', '', 'g')::numeric)::int, 300)
        ELSE NULL
      END
    ) WHERE time_duration IS NOT NULL AND time_duration != ''
  `);
  // Corrective migration: where started_at and ended_at both exist,
  // duration_minutes can be computed exactly from the timestamps.
  // This fixes rows polluted by the v2 backfill's seconds-as-minutes
  // bug. Only updates rows where the stored value disagrees with
  // timestamps by >2 min (skips rows already correct).
  await safeQuery('correct duration_minutes from timestamps', `
    UPDATE workouts SET duration_minutes = ROUND(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0)::int
    WHERE started_at IS NOT NULL
      AND ended_at IS NOT NULL
      AND ended_at > started_at
      AND (
        duration_minutes IS NULL
        OR ABS(duration_minutes - ROUND(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0)::int) > 2
      )
      AND EXTRACT(EPOCH FROM (ended_at - started_at)) > 0
      AND EXTRACT(EPOCH FROM (ended_at - started_at)) < 86400
  `);
  await safeQuery('backfill distance_value', `
    UPDATE workouts SET distance_value = ROUND(REGEXP_REPLACE(distance, '[^\\d.]', '', 'g')::numeric, 2)
    WHERE distance_value IS NULL AND distance IS NOT NULL AND distance ~ '[\\d.]'
  `);
  await safeQuery('backfill elevation_gain_ft', `
    UPDATE workouts SET elevation_gain_ft = REGEXP_REPLACE(elevation_gain, '[^\\d]', '', 'g')::int
    WHERE elevation_gain_ft IS NULL AND elevation_gain IS NOT NULL AND elevation_gain ~ '\\d'
  `);
  await safeQuery('backfill hr_avg', `
    UPDATE workouts SET hr_avg = REGEXP_REPLACE(heart_rate_avg, '[^\\d]', '', 'g')::int
    WHERE hr_avg IS NULL AND heart_rate_avg IS NOT NULL
      AND heart_rate_avg ~ '\\d'
      AND lower(heart_rate_avg) NOT IN ('nan','null','none','-')
  `);
  await safeQuery('backfill hr_max', `
    UPDATE workouts SET hr_max = REGEXP_REPLACE(heart_rate_max, '[^\\d]', '', 'g')::int
    WHERE hr_max IS NULL AND heart_rate_max IS NOT NULL
      AND heart_rate_max ~ '\\d'
      AND lower(heart_rate_max) NOT IN ('nan','null','none','-')
  `);
  // v1.8.17: cleanup — null out the literal "nan" / "null" / "none"
  // strings that pre-v1.8.17 importers wrote when Python's NaN got
  // string-coerced into the column. Coach found this on the Vernon
  // walking record's hr_avg field.
  await safeQuery('cleanup nan-string heart_rate', `
    UPDATE workouts SET
      heart_rate_avg = NULL
      WHERE heart_rate_avg IS NOT NULL AND lower(heart_rate_avg) IN ('nan','null','none','-')
  `);
  await safeQuery('cleanup nan-string hr_max', `
    UPDATE workouts SET
      heart_rate_max = NULL
      WHERE heart_rate_max IS NOT NULL AND lower(heart_rate_max) IN ('nan','null','none','-')
  `);
  await safeQuery('backfill cadence', `
    UPDATE workouts SET cadence = REGEXP_REPLACE(cadence_avg, '[^\\d]', '', 'g')::int
    WHERE cadence IS NULL AND cadence_avg IS NOT NULL AND cadence_avg ~ '\\d'
  `);
  await safeQuery('backfill cal_active', `
    UPDATE workouts SET cal_active = REGEXP_REPLACE(active_calories, '[^\\d]', '', 'g')::int
    WHERE cal_active IS NULL AND active_calories IS NOT NULL AND active_calories ~ '\\d'
  `);
  await safeQuery('backfill cal_total', `
    UPDATE workouts SET cal_total = REGEXP_REPLACE(total_calories, '[^\\d]', '', 'g')::int
    WHERE cal_total IS NULL AND total_calories IS NOT NULL AND total_calories ~ '\\d'
  `);

  // -- meals migrations --
  await safeQuery('meals +meal_date', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS meal_date DATE NOT NULL DEFAULT CURRENT_DATE`);
  await safeQuery('meals +meal_time', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS meal_time TIME`);
  await safeQuery('meals +meal_type', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS meal_type TEXT DEFAULT 'meal'`);
  await safeQuery('meals +calories', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS calories NUMERIC(7,1)`);
  await safeQuery('meals +protein_g', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS protein_g NUMERIC(6,1)`);
  await safeQuery('meals +carbs_g', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS carbs_g NUMERIC(6,1)`);
  await safeQuery('meals +fat_g', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS fat_g NUMERIC(6,1)`);
  await safeQuery('meals +fiber_g', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS fiber_g NUMERIC(6,1)`);
  await safeQuery('meals +sugar_g', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS sugar_g NUMERIC(6,1)`);
  await safeQuery('meals +sodium_mg', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS sodium_mg NUMERIC(7,1)`);
  await safeQuery('meals +serving_size', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS serving_size TEXT`);
  await safeQuery('meals +hunger_before', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS hunger_before INTEGER`);
  await safeQuery('meals +fullness_after', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS fullness_after INTEGER`);
  await safeQuery('meals +energy_after', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS energy_after INTEGER`);
  await safeQuery('meals +notes', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safeQuery('meals +tags', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('meals +source', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`);
  await safeQuery('meals +ai_source', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('meals +metadata', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('meals +search_vector', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('meals +updated_at', `ALTER TABLE meals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- daily_context migrations (renamed from daily_nutrition_context) --
  // Only rename if source exists AND target does NOT — otherwise the
  // RENAME errors with "relation 'daily_context' already exists" on
  // every restart after the rename succeeds.
  await safeQuery('rename dnc→dc', `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'daily_nutrition_context')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'daily_context') THEN
        ALTER TABLE daily_nutrition_context RENAME TO daily_context;
      END IF;
    END $$;
  `);
  await safeQuery('dc +day_type', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS day_type TEXT`);
  await safeQuery('dc +hydration_liters', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS hydration_liters NUMERIC(4,2)`);
  await safeQuery('dc +energy_rating', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS energy_rating INTEGER`);
  await safeQuery('dc +hunger_rating', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS hunger_rating INTEGER`);
  await safeQuery('dc +cravings', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS cravings TEXT`);
  await safeQuery('dc +digestion', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS digestion TEXT`);
  await safeQuery('dc +notes', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safeQuery('dc +tags', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('dc +search_vector', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('dc +updated_at', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- body_metrics migrations --
  await safeQuery('body_metrics +measurement_context', `ALTER TABLE body_metrics ADD COLUMN IF NOT EXISTS measurement_context TEXT`);
  await safeQuery('body_metrics +vendor_user_mode', `ALTER TABLE body_metrics ADD COLUMN IF NOT EXISTS vendor_user_mode TEXT`);
  await safeQuery('body_metrics +search_vector', `ALTER TABLE body_metrics ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);

  // (progress_checkins, progress_photos, progress_settings tables removed)

  // ===== GAMIFICATION =====
  await safeQuery('gamification_settings table', `
    CREATE TABLE IF NOT EXISTS gamification_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      ring_train_goal INTEGER DEFAULT 1,
      ring_execute_goal INTEGER DEFAULT 3,
      ring_recover_goal INTEGER DEFAULT 3,
      notification_enabled BOOLEAN DEFAULT true,
      notification_schedule JSONB DEFAULT '[
        {"time":"06:30","type":"morning_briefing","label":"Morning Briefing"},
        {"time":"11:30","type":"pre_lunch","label":"Midday Check"},
        {"time":"14:00","type":"post_lunch","label":"Post Lunch"},
        {"time":"17:30","type":"end_of_work","label":"End of Work"},
        {"time":"20:30","type":"evening_close","label":"Evening Close"}
      ]'::jsonb,
      push_subscription JSONB,
      vapid_public_key TEXT,
      vapid_private_key TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('gamification_settings seed', `INSERT INTO gamification_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);

  await safeQuery('badges table', `
    CREATE TABLE IF NOT EXISTS badges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      badge_key TEXT NOT NULL UNIQUE,
      unlocked_at TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'::jsonb
    )`);
  await safeQuery('badges idx', `CREATE INDEX IF NOT EXISTS idx_badges_key ON badges(badge_key)`);

  // -- gamification_settings migrations (achievement-based rings) --
  await safeQuery('gamification +default_protein_target', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_protein_target NUMERIC(6,1) DEFAULT 150`);
  await safeQuery('gamification +default_calorie_min', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_calorie_min NUMERIC(7,1) DEFAULT 2000`);
  await safeQuery('gamification +default_calorie_max', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_calorie_max NUMERIC(7,1) DEFAULT 2800`);
  await safeQuery('gamification +default_hydration_target', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_hydration_target NUMERIC(4,2) DEFAULT 2.5`);
  await safeQuery('gamification +default_sleep_target', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_sleep_target NUMERIC(3,1) DEFAULT 7.0`);
  await safeQuery('gamification +default_sleep_quality_threshold', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_sleep_quality_threshold INTEGER DEFAULT 6`);
  await safeQuery('gamification +default_recovery_threshold', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_recovery_threshold INTEGER DEFAULT 6`);
  await safeQuery('gamification +default_effort_target', `ALTER TABLE gamification_settings ADD COLUMN IF NOT EXISTS default_effort_target INTEGER DEFAULT 6`);

  // -- coaching_sessions migration (link to daily plans) --
  await safeQuery('coaching +daily_plan_id', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS daily_plan_id UUID REFERENCES daily_plans(id) ON DELETE SET NULL`);
  await safeQuery('coaching daily_plan idx', `CREATE INDEX IF NOT EXISTS idx_coaching_sessions_daily_plan ON coaching_sessions(daily_plan_id)`);

  // -- daily_plans: add title + goal columns (unified plan concept) --
  await safeQuery('daily_plans +title', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS title TEXT`);
  await safeQuery('daily_plans +goal', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS goal TEXT`);
  // hevy_routine_title is an explicit override Coach can set when the
  // generated title isn't right (e.g. "May 3 — Z2 Run + Sled + PT").
  await safeQuery('daily_plans +hevy_routine_title', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS hevy_routine_title TEXT`);

  // -- migrate microcycle training_plans → daily_plans (before drop) --
  await (async () => {
    try {
      // Check if training_plans still exists
      const { rows: tableCheck } = await query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'training_plans' LIMIT 1`
      );
      if (!tableCheck.length) return; // already dropped

      const { rows: plans } = await query(`
        SELECT * FROM training_plans
        WHERE (plan_type = 'microcycle' OR (start_date IS NOT NULL AND start_date = end_date))
          AND status IN ('active', 'draft', 'planned')
        ORDER BY start_date ASC
      `);

      let migrated = 0;
      for (const tp of plans) {
        const planDate = tp.start_date ? (tp.start_date instanceof Date ? tp.start_date.toISOString().slice(0, 10) : String(tp.start_date).slice(0, 10)) : null;
        if (!planDate) continue;

        // Skip if daily plan already exists for this date
        const { rows: existing } = await query('SELECT id FROM daily_plans WHERE plan_date = $1', [planDate]);
        if (existing.length) continue;

        // Extract workout type from title/goal/weekly_structure
        let workoutType = null;
        let workoutFocus = null;
        if (tp.weekly_structure && Array.isArray(tp.weekly_structure) && tp.weekly_structure.length > 0) {
          workoutType = tp.weekly_structure[0].type || null;
          workoutFocus = tp.weekly_structure[0].focus || null;
        }
        if (!workoutType) {
          const text = ((tp.title || '') + ' ' + (tp.goal || '')).toLowerCase();
          if (text.includes('recovery') || text.includes('mobility') || text.includes('rest')) workoutType = 'recovery';
          else if (text.includes('run') || text.includes('pacing')) workoutType = 'run';
          else if (text.includes('strength') || text.includes('upper') || text.includes('push') || text.includes('pull')) workoutType = 'strength';
          else if (text.includes('hill') || text.includes('spartan') || text.includes('obstacle') || text.includes('outdoor')) workoutType = 'hill';
          else if (text.includes('hybrid') || text.includes('spin')) workoutType = 'hybrid';
          else if (text.includes('ruck')) workoutType = 'ruck';
          else workoutType = 'custom';
        }
        const titleParts = (tp.title || '').split('–').map(s => s.trim());
        if (!workoutFocus) workoutFocus = titleParts.length > 1 ? titleParts[1] : null;

        const isRest = workoutType === 'recovery';
        const status = isRest ? 'rest' : 'planned';

        await query(`
          INSERT INTO daily_plans (plan_date, status, title, goal, workout_type, workout_focus,
            workout_notes, coaching_notes, rationale, tags, ai_source, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          planDate, status, tp.title || null, tp.goal || null,
          workoutType, workoutFocus,
          tp.constraints || null, tp.progression_notes || null, tp.rationale || null,
          tp.tags || '[]', tp.ai_source || 'chatgpt',
          JSON.stringify({ migrated_from: 'training_plan', phase: tp.phase, intensity_scheme: tp.intensity_scheme }),
        ]);
        migrated++;
      }
      if (migrated > 0) console.log(`[initDB] Migrated ${migrated} training plans → daily plans`);
    } catch (err) {
      console.error(`[initDB] Training plan migration failed: ${err.message}`);
    }
  })();

  // -- remove training_plan_id FKs and drop training_plans table --
  await safeQuery('daily_plans drop training_plan_id', `ALTER TABLE daily_plans DROP COLUMN IF EXISTS training_plan_id`);
  await safeQuery('coaching drop training_plan_id', `ALTER TABLE coaching_sessions DROP COLUMN IF EXISTS training_plan_id`);
  await safeQuery('drop training_plans', `DROP TABLE IF EXISTS training_plans CASCADE`);

  // -- daily_plans: structured exercises and completion tracking --
  // DEPRECATED in v1.8.1: planned_exercises and actual_exercises moved
  // to plan_segments. The columns are kept for the one-time backfill
  // migration below (~line 1325) and to avoid breaking reads of legacy
  // rows. NEW WRITES MUST GO TO plan_segments.
  await safeQuery('daily_plans +planned_exercises', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS planned_exercises JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('daily_plans +completion_notes', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS completion_notes TEXT`);
  await safeQuery('daily_plans +actual_exercises', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS actual_exercises JSONB DEFAULT '[]'::jsonb`);

  // -- workouts: link to daily plan --
  await safeQuery('workouts +daily_plan_id', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS daily_plan_id UUID REFERENCES daily_plans(id) ON DELETE SET NULL`);
  await safeQuery('workouts daily_plan idx', `CREATE INDEX IF NOT EXISTS idx_workouts_daily_plan ON workouts(daily_plan_id)`);

  // Backfill: link workouts to plans by matching date
  await safeQuery('backfill workout plan links', `
    UPDATE workouts w SET daily_plan_id = dp.id
    FROM daily_plans dp
    WHERE w.workout_date = dp.plan_date AND w.daily_plan_id IS NULL
  `);

  // ===== EQUIPMENT CATALOG =====
  // exercises and gym_profiles tables already created above — only add equipment_catalog here
  await safeQuery('equipment_catalog table', `
    CREATE TABLE IF NOT EXISTS equipment_catalog (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT NOT NULL
    )`);
  await safeQuery('seed equipment_catalog', `
    INSERT INTO equipment_catalog (id, label, category) VALUES
      ('barbell', 'Barbell & Plates', 'free_weights'),
      ('dumbbell', 'Dumbbells', 'free_weights'),
      ('kettlebell', 'Kettlebells', 'free_weights'),
      ('ez_curl_bar', 'EZ Curl Bar', 'free_weights'),
      ('trap_bar', 'Trap/Hex Bar', 'free_weights'),
      ('cable_machine', 'Cable Machine', 'machines'),
      ('smith_machine', 'Smith Machine', 'machines'),
      ('leg_press', 'Leg Press', 'machines'),
      ('hack_squat', 'Hack Squat Machine', 'machines'),
      ('leg_curl', 'Leg Curl Machine', 'machines'),
      ('leg_extension', 'Leg Extension Machine', 'machines'),
      ('chest_press_machine', 'Chest Press Machine', 'machines'),
      ('shoulder_press_machine', 'Shoulder Press Machine', 'machines'),
      ('lat_pulldown', 'Lat Pulldown Machine', 'machines'),
      ('seated_row_machine', 'Seated Row Machine', 'machines'),
      ('pec_deck', 'Pec Deck / Fly Machine', 'machines'),
      ('cable_crossover', 'Cable Crossover', 'machines'),
      ('assisted_pullup', 'Assisted Pull-Up Machine', 'machines'),
      ('pull_up_bar', 'Pull-Up Bar', 'bodyweight'),
      ('dip_station', 'Dip Station / Parallel Bars', 'bodyweight'),
      ('roman_chair', 'Roman Chair / GHD', 'bodyweight'),
      ('flat_bench', 'Flat Bench', 'benches'),
      ('incline_bench', 'Incline Bench', 'benches'),
      ('decline_bench', 'Decline Bench', 'benches'),
      ('adjustable_bench', 'Adjustable Bench', 'benches'),
      ('preacher_curl_bench', 'Preacher Curl Bench', 'benches'),
      ('squat_rack', 'Squat Rack / Power Rack', 'racks'),
      ('resistance_bands', 'Resistance Bands', 'accessories'),
      ('trx', 'TRX / Suspension Trainer', 'accessories'),
      ('ab_wheel', 'Ab Wheel', 'accessories'),
      ('foam_roller', 'Foam Roller', 'accessories'),
      ('medicine_ball', 'Medicine Ball', 'accessories'),
      ('battle_ropes', 'Battle Ropes', 'accessories'),
      ('box_platform', 'Plyo Box / Step Platform', 'accessories'),
      ('sandbag', 'Sandbag', 'accessories'),
      ('sled', 'Sled / Prowler', 'accessories'),
      ('treadmill', 'Treadmill', 'cardio'),
      ('rowing_machine', 'Rowing Machine', 'cardio'),
      ('bike', 'Stationary Bike', 'cardio'),
      ('elliptical', 'Elliptical', 'cardio'),
      ('stairclimber', 'Stair Climber', 'cardio'),
      ('bodyweight', 'Bodyweight (no equipment)', 'bodyweight')
    ON CONFLICT (id) DO NOTHING
  `);

  // No automatic exercise seed runs at startup. Initial library is loaded via
  // POST /api/exercises/import-fitbod and persists across restarts. Subsequent
  // imports upsert via ON CONFLICT (name) DO UPDATE so user edits to existing
  // rows are not overwritten by re-import.

  // ===== CONTACTS =====
  await safeQuery('contacts table', `
    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      aliases JSONB DEFAULT '[]',
      email TEXT,
      phone TEXT,
      relationship TEXT,
      organization TEXT,
      confidentiality TEXT DEFAULT 'open' CHECK(confidentiality IN ('open','confidential','restricted')),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('contacts indexes', `
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_contacts_relationship ON contacts(relationship);
  `);

  // ===== SEARCH TRIGGERS =====
  await safeQuery('search triggers', `
    CREATE OR REPLACE FUNCTION update_knowledge_search() RETURNS TRIGGER AS $$
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

    CREATE OR REPLACE FUNCTION update_body_metrics_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.source,'') || ' ' || coalesce(NEW.notes,'') || ' ' || coalesce(NEW.measurement_context,'') || ' ' || coalesce(NEW.vendor_user_mode,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_body_metrics_search ON body_metrics;
    CREATE TRIGGER trg_body_metrics_search BEFORE INSERT OR UPDATE OF source, notes, measurement_context, vendor_user_mode ON body_metrics
      FOR EACH ROW EXECUTE FUNCTION update_body_metrics_search();

    CREATE OR REPLACE FUNCTION update_meals_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.notes,'') || ' ' || coalesce(NEW.meal_type,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_meals_search ON meals;
    CREATE TRIGGER trg_meals_search BEFORE INSERT OR UPDATE OF title, notes, meal_type ON meals
      FOR EACH ROW EXECUTE FUNCTION update_meals_search();

    CREATE OR REPLACE FUNCTION update_dc_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.notes,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_dnc_search ON daily_context;
    DROP TRIGGER IF EXISTS trg_dc_search ON daily_context;
    CREATE TRIGGER trg_dc_search BEFORE INSERT OR UPDATE OF notes ON daily_context
      FOR EACH ROW EXECUTE FUNCTION update_dc_search();

    CREATE OR REPLACE FUNCTION update_coaching_sessions_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.summary,'') || ' ' || coalesce(NEW.injury_notes,'') || ' ' || coalesce(NEW.next_steps,'') || ' ' || coalesce(NEW.recovery_notes,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_coaching_sessions_search ON coaching_sessions;
    CREATE TRIGGER trg_coaching_sessions_search BEFORE INSERT OR UPDATE OF title, summary, injury_notes, next_steps, recovery_notes ON coaching_sessions
      FOR EACH ROW EXECUTE FUNCTION update_coaching_sessions_search();

    CREATE OR REPLACE FUNCTION update_exercises_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.name,'') || ' ' || coalesce(NEW.equipment,'') || ' ' || coalesce(NEW.primary_muscle_groups,'') || ' ' || coalesce(NEW.category,'') || ' ' || coalesce(NEW.description,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_exercises_search ON exercises;
    CREATE TRIGGER trg_exercises_search BEFORE INSERT OR UPDATE OF name, equipment, primary_muscle_groups, category, description ON exercises
      FOR EACH ROW EXECUTE FUNCTION update_exercises_search();

    CREATE OR REPLACE FUNCTION update_injuries_search() RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.body_area,'') || ' ' || coalesce(NEW.symptoms,'') || ' ' || coalesce(NEW.treatment,'') || ' ' || coalesce(NEW.notes,''));
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_injuries_search ON injuries;
    CREATE TRIGGER trg_injuries_search BEFORE INSERT OR UPDATE OF title, body_area, symptoms, treatment, notes ON injuries
      FOR EACH ROW EXECUTE FUNCTION update_injuries_search();

  `);

  // (training_plans migrations removed — table dropped)

  // -- coaching_sessions migrations --
  await safeQuery('coaching_sessions +session_date', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS session_date DATE NOT NULL DEFAULT CURRENT_DATE`);
  await safeQuery('coaching_sessions +title', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS title TEXT`);
  await safeQuery('coaching_sessions +summary', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS summary TEXT`);
  await safeQuery('coaching_sessions +key_decisions', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS key_decisions JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('coaching_sessions +adjustments', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS adjustments JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('coaching_sessions +injury_notes', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS injury_notes TEXT`);
  await safeQuery('coaching_sessions +nutrition_notes', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS nutrition_notes TEXT`);
  await safeQuery('coaching_sessions +recovery_notes', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS recovery_notes TEXT`);
  await safeQuery('coaching_sessions +mental_notes', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS mental_notes TEXT`);
  await safeQuery('coaching_sessions +next_steps', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS next_steps TEXT`);
  await safeQuery('coaching_sessions +data_reviewed', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS data_reviewed JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('coaching_sessions +training_plan_id', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS training_plan_id UUID`);
  await safeQuery('coaching_sessions +conversation_id', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS conversation_id UUID`);
  await safeQuery('coaching_sessions +ai_source', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS ai_source TEXT DEFAULT 'chatgpt'`);
  await safeQuery('coaching_sessions +tags', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('coaching_sessions +metadata', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('coaching_sessions +search_vector', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('coaching_sessions +updated_at', `ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- injuries migrations --
  await safeQuery('injuries +title', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS title TEXT`);
  await safeQuery('injuries +body_area', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS body_area TEXT`);
  await safeQuery('injuries +side', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS side TEXT`);
  await safeQuery('injuries +injury_type', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS injury_type TEXT DEFAULT 'strain'`);
  await safeQuery('injuries +severity', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS severity INTEGER`);
  await safeQuery('injuries +status', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`);
  await safeQuery('injuries +onset_date', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS onset_date DATE`);
  await safeQuery('injuries +resolved_date', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS resolved_date DATE`);
  await safeQuery('injuries +symptoms', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS symptoms TEXT`);
  await safeQuery('injuries +treatment', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS treatment TEXT`);
  await safeQuery('injuries +notes', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS notes TEXT`);
  await safeQuery('injuries +tags', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('injuries +ai_source', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS ai_source TEXT`);
  await safeQuery('injuries +metadata', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`);
  await safeQuery('injuries +mechanism', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS mechanism TEXT`);
  await safeQuery('injuries +aggravating_movements', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS aggravating_movements TEXT`);
  await safeQuery('injuries +relieving_factors', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS relieving_factors TEXT`);
  await safeQuery('injuries +modifications', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS modifications TEXT`);
  await safeQuery('injuries +prevention_notes', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS prevention_notes TEXT`);
  await safeQuery('injuries +search_vector', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await safeQuery('injuries +updated_at', `ALTER TABLE injuries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // -- daily_context recovery/sleep migrations --
  await safeQuery('dc +sleep_hours', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS sleep_hours NUMERIC(3,1)`);
  await safeQuery('dc +sleep_quality', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS sleep_quality INTEGER CHECK(sleep_quality >= 1 AND sleep_quality <= 10)`);

  // -- daily_context subjective check-in (re-added for morning-check-in Skill) --
  // Captures the world-class-coach inputs the prior simplification dropped.
  // Coach asks these in chat, POSTs the row; trends + alerts read them.
  await safeQuery('dc +mood', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS mood INTEGER CHECK(mood >= 1 AND mood <= 10)`);
  await safeQuery('dc +motivation', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS motivation INTEGER CHECK(motivation >= 1 AND motivation <= 10)`);
  await safeQuery('dc +soreness_overall', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS soreness_overall INTEGER CHECK(soreness_overall >= 1 AND soreness_overall <= 10)`);
  await safeQuery('dc +soreness_areas', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS soreness_areas JSONB DEFAULT '[]'::jsonb`);
  await safeQuery('dc +life_stress', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS life_stress INTEGER CHECK(life_stress >= 1 AND life_stress <= 10)`);
  await safeQuery('dc +illness_flag', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS illness_flag TEXT CHECK(illness_flag IN ('none','onset','active','resolving'))`);
  await safeQuery('dc +travel_status', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS travel_status TEXT`);
  await safeQuery('dc +bedtime', `ALTER TABLE daily_context ADD COLUMN IF NOT EXISTS bedtime_self_report TIME`);

  // -- daily_activity bedtime/wake (HAE Format B/D writes them; sleep score
  // consistency + regularity stddev read them). Until populated, sleep score
  // consistency component returns 0 and regularity stddev returns null --
  await safeQuery('da +sleep_in_bed_start', `ALTER TABLE daily_activity ADD COLUMN IF NOT EXISTS sleep_in_bed_start TIMESTAMPTZ`);
  await safeQuery('da +sleep_in_bed_end', `ALTER TABLE daily_activity ADD COLUMN IF NOT EXISTS sleep_in_bed_end TIMESTAMPTZ`);

  // -- simplify daily_context: drop unused fields (sleep + hydration + notes kept) --
  await safeQuery('dc drop day_type', `ALTER TABLE daily_context DROP COLUMN IF EXISTS day_type`);
  await safeQuery('dc drop energy_rating', `ALTER TABLE daily_context DROP COLUMN IF EXISTS energy_rating`);
  await safeQuery('dc drop hunger_rating', `ALTER TABLE daily_context DROP COLUMN IF EXISTS hunger_rating`);
  await safeQuery('dc drop recovery_rating', `ALTER TABLE daily_context DROP COLUMN IF EXISTS recovery_rating`);
  await safeQuery('dc drop body_weight_lb', `ALTER TABLE daily_context DROP COLUMN IF EXISTS body_weight_lb`);
  await safeQuery('dc drop cravings', `ALTER TABLE daily_context DROP COLUMN IF EXISTS cravings`);
  await safeQuery('dc drop digestion', `ALTER TABLE daily_context DROP COLUMN IF EXISTS digestion`);
  await safeQuery('dc drop tags', `ALTER TABLE daily_context DROP COLUMN IF EXISTS tags`);

  // (progress_checkins and progress_photos migrations removed)

  // ===== APPLE HEALTH INGEST PIPELINE =====
  // Three new tables to support the Format A/B/C/D ingest in routes/health.js,
  // plus columns added to existing workouts and body_metrics. All migrations
  // are additive and idempotent — safe to run on an existing master DB.

  // Per-day aggregates from Apple Health / HAE / Lode. One row per date.
  // Format A is canonical for movement metrics; Format B/D for recovery and
  // mobility; Format C backfills historical sleep + workout-type overrides.
  await safeQuery('daily_activity table', `
    CREATE TABLE IF NOT EXISTS daily_activity (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      activity_date DATE NOT NULL UNIQUE,

      -- movement (imperial: miles, feet, calories)
      steps INTEGER,
      distance_mi NUMERIC(7,3),
      exercise_minutes INTEGER,
      flights_climbed INTEGER,
      active_energy_kcal NUMERIC(8,2),
      basal_energy_kcal NUMERIC(8,2),
      stand_hours INTEGER,
      stand_minutes INTEGER,
      workout_count INTEGER,

      -- recovery / readiness
      resting_hr_bpm INTEGER,
      walking_hr_avg_bpm INTEGER,
      heart_rate_avg_bpm INTEGER,
      hrv_sdnn_ms NUMERIC(5,1),
      respiratory_rate_avg NUMERIC(4,1),
      vo2_max NUMERIC(4,1),

      -- mobility / gait (imperial: mph, inches, percent)
      walking_speed_mph NUMERIC(4,2),
      walking_steadiness_pct NUMERIC(4,1),
      walking_asymmetry_pct NUMERIC(4,1),
      walking_step_length_in NUMERIC(5,1),

      -- sleep (minutes per stage; canonical from Format C/D)
      sleep_total_min INTEGER,
      sleep_deep_min INTEGER,
      sleep_rem_min INTEGER,
      sleep_core_min INTEGER,
      sleep_awake_min INTEGER,
      sleep_efficiency_pct NUMERIC(4,1),

      -- provenance per field group: which file format last wrote each block
      sources JSONB DEFAULT '{}'::jsonb,
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('daily_activity index', `
    CREATE INDEX IF NOT EXISTS idx_daily_activity_date ON daily_activity(activity_date DESC)`);

  // File-level idempotency + reprocess log for raw exports
  await safeQuery('raw_health_imports table', `
    CREATE TABLE IF NOT EXISTS raw_health_imports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_format TEXT NOT NULL,
      filename TEXT,
      file_hash TEXT NOT NULL UNIQUE,
      file_bytes INTEGER,
      date_range_start DATE,
      date_range_end DATE,
      payload JSONB,
      payload_path TEXT,
      parse_result JSONB,
      ingested_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('raw_health_imports indexes', `
    CREATE INDEX IF NOT EXISTS idx_raw_health_imports_format ON raw_health_imports(source_format);
    CREATE INDEX IF NOT EXISTS idx_raw_health_imports_ingested ON raw_health_imports(ingested_at DESC)`);

  // HR zones config — versioned per athlete, set by trainer or computed
  await safeQuery('athlete_zones table', `
    CREATE TABLE IF NOT EXISTS athlete_zones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      effective_from DATE NOT NULL,
      effective_to DATE,
      zone_type TEXT NOT NULL DEFAULT 'heart_rate',
      max_hr INTEGER,
      resting_hr INTEGER,
      lthr INTEGER,
      z1_max INTEGER,
      z2_max INTEGER,
      z3_max INTEGER,
      z4_max INTEGER,
      z5_max INTEGER,
      method TEXT,
      set_by TEXT DEFAULT 'trainer',
      rationale TEXT,
      source_data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('athlete_zones indexes', `
    CREATE INDEX IF NOT EXISTS idx_athlete_zones_effective ON athlete_zones(effective_from DESC);
    CREATE INDEX IF NOT EXISTS idx_athlete_zones_active ON athlete_zones(effective_to) WHERE effective_to IS NULL`);

  // Workouts: training-load and HR-zone-distribution columns
  await safeQuery('workouts +tss', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS tss INTEGER`);
  await safeQuery('workouts +intensity_factor', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS intensity_factor NUMERIC(4,2)`);
  await safeQuery('workouts +hr_zones', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS hr_zones JSONB`);
  await safeQuery('workouts +inferred_workout_type', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS inferred_workout_type BOOLEAN DEFAULT false`);
  // Hevy integration — link AB Brain workouts to their Hevy origin so
  // the sync is idempotent and can match completed workouts back to the
  // routine the Coach pushed.
  await safeQuery('workouts +hevy_id', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS hevy_id TEXT`);
  await safeQuery('workouts hevy_id unique', `CREATE UNIQUE INDEX IF NOT EXISTS uq_workouts_hevy_id ON workouts(hevy_id) WHERE hevy_id IS NOT NULL`);
  // DEPRECATED in v1.8.1: hevy_routine_id moved to plan_segments
  // (one routine per Hevy segment). Column kept for legacy reads only.
  await safeQuery('daily_plans +hevy_routine_id', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS hevy_routine_id TEXT`);
  // Partial unique index on (started_at) where source='apple_health' so
  // re-ingests deduplicate at the row level.
  await safeQuery('workouts unique apple_health started_at', `CREATE UNIQUE INDEX IF NOT EXISTS uq_workouts_apple_health_started_at ON workouts(started_at) WHERE source = 'apple_health' AND started_at IS NOT NULL`);

  // ===== PLAN SEGMENTS (Phase N) =====
  // A daily_plan is the day envelope; plan_segments are the prescribed
  // sessions inside it. Multi-modality days (warmup walk + Z2 run +
  // strength block) become 3 segments, each with its own logging_target
  // (hevy / apple_health / manual), so the Hevy push only sends segments
  // that belong in Hevy and Apple Fitness owns the cardio.
  await safeQuery('plan_segments table', `
    CREATE TABLE IF NOT EXISTS plan_segments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      daily_plan_id UUID NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
      block_order INTEGER NOT NULL DEFAULT 0,
      block_label TEXT NOT NULL,
      logging_target TEXT NOT NULL DEFAULT 'manual',
      planned_exercises JSONB DEFAULT '[]'::jsonb,
      target_duration_min INTEGER,
      target_effort INTEGER,
      time_window_start TIME,
      time_window_end TIME,
      hevy_routine_id TEXT,
      status TEXT DEFAULT 'planned',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('plan_segments plan idx', `CREATE INDEX IF NOT EXISTS idx_plan_segments_plan ON plan_segments(daily_plan_id)`);
  await safeQuery('plan_segments order idx', `CREATE INDEX IF NOT EXISTS idx_plan_segments_order ON plan_segments(daily_plan_id, block_order)`);
  // title_suffix lets Coach disambiguate when multiple segments share
  // a block_label (e.g. "Main Lift" vs "Grip" both = block_label='strength').
  // The Hevy routine title becomes "<plan.title> · <title_suffix>" so
  // the four routines for one day each have a unique name in the
  // AB Brain Plans folder.
  await safeQuery('plan_segments +title_suffix', `ALTER TABLE plan_segments ADD COLUMN IF NOT EXISTS title_suffix TEXT`);

  // Workouts now point at the segment they fulfilled (in addition to the
  // existing daily_plan_id FK so we keep day-level rollups easy).
  await safeQuery('workouts +plan_segment_id', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS plan_segment_id UUID REFERENCES plan_segments(id) ON DELETE SET NULL`);
  await safeQuery('workouts plan_segment idx', `CREATE INDEX IF NOT EXISTS idx_workouts_plan_segment ON workouts(plan_segment_id)`);
  // Soft-delete tombstone for Hevy sync. /workouts/events emits
  // DeletedWorkout entries we don't want to lose plan-segment links
  // for, so we mark deleted_at instead of hard-deleting.
  await safeQuery('workouts +deleted_at', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await safeQuery('workouts deleted_at idx', `CREATE INDEX IF NOT EXISTS idx_workouts_deleted_at ON workouts(deleted_at) WHERE deleted_at IS NOT NULL`);

  // Hevy sync was silently dropping these on INSERT (mapHevyWorkoutToAB
  // built them in the row but the columns didn't exist). Add as real
  // columns so total volume + sets land alongside the Hevy session.
  await safeQuery('workouts +total_volume_lb', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS total_volume_lb NUMERIC(10,2)`);
  await safeQuery('workouts +total_sets', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS total_sets INTEGER`);
  await safeQuery('workouts +ended_at', `ALTER TABLE workouts ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ`);

  // Backfill: synth one segment per existing daily_plan that already has
  // planned_exercises so legacy plans render correctly under the new
  // unified card. Idempotent — guarded by NOT EXISTS.
  await safeQuery('backfill plan_segments from daily_plans', `
    INSERT INTO plan_segments (daily_plan_id, block_order, block_label, logging_target, planned_exercises, target_duration_min, target_effort, hevy_routine_id, status)
    SELECT
      dp.id,
      0,
      COALESCE(NULLIF(dp.workout_type, ''), 'strength'),
      CASE
        WHEN dp.workout_type IN ('strength','hybrid','hill') THEN 'hevy'
        WHEN dp.workout_type IN ('run','recovery','cardio','ride','swim','bike') THEN 'apple_health'
        ELSE 'manual'
      END,
      COALESCE(dp.planned_exercises, '[]'::jsonb),
      dp.target_duration_min,
      dp.target_effort,
      dp.hevy_routine_id,
      CASE WHEN dp.status = 'completed' THEN 'completed' ELSE 'planned' END
    FROM daily_plans dp
    WHERE NOT EXISTS (SELECT 1 FROM plan_segments ps WHERE ps.daily_plan_id = dp.id)
  `);

  // Backfill: link existing workouts to the first segment of their plan.
  await safeQuery('backfill workouts.plan_segment_id', `
    UPDATE workouts w
    SET plan_segment_id = ps.id
    FROM plan_segments ps
    WHERE w.daily_plan_id = ps.daily_plan_id
      AND ps.block_order = 0
      AND w.plan_segment_id IS NULL
      AND w.daily_plan_id IS NOT NULL
  `);

  // ═══════════════════════════════════════════════════════════════════
  //  HEVY MAPPING + CACHE + SYNC STATE
  // ═══════════════════════════════════════════════════════════════════
  //
  // Three tables work together so push-plan / sync don't drift:
  //
  //   hevy_template_cache  — local mirror of /v1/exercise_templates so
  //                          we don't page through 4,300+ entries on
  //                          every search. Refreshed on a manual or
  //                          weekly trigger.
  //
  //   hevy_exercise_map    — sticky AB-Brain-name → Hevy-template-id
  //                          binding so "Standing Calf Raise" always
  //                          maps to the same Hevy template across
  //                          sessions. Push-plan consults this BEFORE
  //                          falling back to live search.
  //
  //   sync_state           — durable cursor for /v1/workouts/events.
  //                          Without this, every deploy resets the
  //                          cursor and we re-process old events.
  await safeQuery('hevy_template_cache table', `
    CREATE TABLE IF NOT EXISTS hevy_template_cache (
      hevy_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      primary_muscle_group TEXT,
      secondary_muscle_groups TEXT[],
      equipment TEXT,
      is_custom BOOLEAN DEFAULT FALSE,
      raw JSONB,
      cached_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safeQuery('hevy_template_cache title idx', `CREATE INDEX IF NOT EXISTS idx_hevy_tpl_title ON hevy_template_cache(lower(title))`);
  await safeQuery('hevy_template_cache title trgm idx', `CREATE INDEX IF NOT EXISTS idx_hevy_tpl_trgm ON hevy_template_cache USING gin(title gin_trgm_ops)`);

  await safeQuery('hevy_exercise_map table', `
    CREATE TABLE IF NOT EXISTS hevy_exercise_map (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ab_brain_exercise_name TEXT NOT NULL,
      ab_brain_exercise_id UUID,
      hevy_exercise_template_id TEXT NOT NULL,
      hevy_title TEXT NOT NULL,
      hevy_type TEXT NOT NULL,
      hevy_primary_muscle_group TEXT,
      hevy_equipment TEXT,
      is_custom BOOLEAN DEFAULT FALSE,
      confidence TEXT DEFAULT 'manual',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safeQuery('hevy_exercise_map name unique', `CREATE UNIQUE INDEX IF NOT EXISTS uq_hevy_map_ab_name ON hevy_exercise_map(lower(ab_brain_exercise_name))`);
  await safeQuery('hevy_exercise_map hevy_id idx', `CREATE INDEX IF NOT EXISTS idx_hevy_map_hevy_id ON hevy_exercise_map(hevy_exercise_template_id)`);

  await safeQuery('sync_state table', `
    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT PRIMARY KEY,
      cursor TEXT,
      last_synced_at TIMESTAMPTZ,
      stats JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // body_metrics: lean mass + apple_health partial unique + nullable weight
  await safeQuery('body_metrics +lean_mass_lb', `ALTER TABLE body_metrics ADD COLUMN IF NOT EXISTS lean_mass_lb NUMERIC(6,2)`);
  // Apple Health may emit body-fat-only or BMI-only rows with no weight, so
  // weight_lb cannot be NOT NULL in this schema.
  await safeQuery('body_metrics weight_lb nullable', `ALTER TABLE body_metrics ALTER COLUMN weight_lb DROP NOT NULL`);
  await safeQuery('body_metrics apple_health unique', `CREATE UNIQUE INDEX IF NOT EXISTS uq_body_metrics_apple_date ON body_metrics(measurement_date) WHERE source = 'apple_health'`);

  // ===== USER TARGETS =====
  // Single-user app, but row-per-target so the user can override any metric
  // independently. Defaults seeded on first boot via INSERT WHERE NOT EXISTS.
  await safeQuery('user_targets table', `
    CREATE TABLE IF NOT EXISTS user_targets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      metric TEXT NOT NULL UNIQUE,
      target_value NUMERIC,
      target_value_max NUMERIC,
      comparison TEXT NOT NULL DEFAULT 'gte',
      timeframe TEXT NOT NULL DEFAULT 'daily',
      effective_from DATE DEFAULT CURRENT_DATE,
      effective_to DATE,
      set_by TEXT DEFAULT 'system',
      rationale TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('user_targets metric idx', `CREATE INDEX IF NOT EXISTS idx_user_targets_metric ON user_targets(metric)`);

  // Seed athlete-appropriate defaults. Idempotent: ON CONFLICT DO NOTHING.
  // Numbers calibrated for a ~190lb endurance athlete; user overrides via
  // Settings → Targets.
  const targetSeed = [
    { metric: 'sleep_duration_min',        target_value: 480,   comparison: 'gte',     timeframe: 'daily',     rationale: '8h sleep — recovery foundation' },
    { metric: 'sleep_deep_min',            target_value: 60,    comparison: 'gte',     timeframe: 'daily',     rationale: '60+ min deep — physical repair' },
    { metric: 'sleep_rem_min',             target_value: 90,    comparison: 'gte',     timeframe: 'daily',     rationale: '90+ min REM — cognitive consolidation' },
    { metric: 'protein_g',                 target_value: 138,   comparison: 'gte',     timeframe: 'daily',     rationale: '1.6g/kg @ 190lb — muscle repair' },
    { metric: 'calories_kcal',             target_value: 2400,  target_value_max: 2800, comparison: 'between', timeframe: 'daily',  rationale: '14 kcal/lb maintenance window' },
    { metric: 'carbs_g',                   target_value: 280,   comparison: 'gte',     timeframe: 'daily',     rationale: 'Endurance fuel on training days' },
    { metric: 'fat_g',                     target_value: 80,    comparison: 'gte',     timeframe: 'daily',     rationale: 'Hormone support floor' },
    { metric: 'weight_lb',                 target_value: 185,   comparison: 'lte',     timeframe: 'long_term', rationale: 'Race weight target' },
    { metric: 'body_fat_pct',              target_value: 15,    comparison: 'lte',     timeframe: 'long_term', rationale: 'Athletic body comp' },
    { metric: 'weekly_z2_min',             target_value: 180,   comparison: 'gte',     timeframe: 'weekly',    rationale: 'Aerobic base maintenance' },
    { metric: 'weekly_workouts',           target_value: 5,     comparison: 'gte',     timeframe: 'weekly',    rationale: 'Volume floor' },
    { metric: 'weekly_tss',                target_value: 350,   target_value_max: 600, comparison: 'between', timeframe: 'weekly',   rationale: 'Productive load band' },
    { metric: 'hrv_ms',                    target_value: 45,    comparison: 'gte',     timeframe: 'daily',     rationale: 'Parasympathetic baseline' },
    { metric: 'resting_hr_bpm',            target_value: 55,    comparison: 'lte',     timeframe: 'daily',     rationale: 'Aerobic fitness signal' },
  ];
  for (const t of targetSeed) {
    await safeQuery(`seed target ${t.metric}`, `
      INSERT INTO user_targets (metric, target_value, target_value_max, comparison, timeframe, set_by, rationale)
      VALUES ($1, $2, $3, $4, $5, 'system', $6)
      ON CONFLICT (metric) DO NOTHING
    `, [t.metric, t.target_value, t.target_value_max ?? null, t.comparison, t.timeframe, t.rationale]);
  }

  // ===== ATHLETE PROFILE =====
  // Versioned physiology snapshot. Sits alongside athlete_zones (which
  // owns HR thresholds). Profile owns sweat rate, FTP, threshold pace,
  // VO2 max history, race weight target, sodium loss. Each row has
  // effective_from / effective_to so historical sessions can resolve to
  // the values that were active at the time (same pattern as zones).
  await safeQuery('athlete_profile table', `
    CREATE TABLE IF NOT EXISTS athlete_profile (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
      effective_to DATE,
      lthr_bpm INTEGER,
      max_hr_bpm INTEGER,
      vo2_max NUMERIC(4,1),
      ftp_w INTEGER,
      threshold_pace_sec_per_mi INTEGER,
      sweat_rate_ml_per_hr INTEGER,
      sodium_loss_mg_per_l INTEGER,
      race_weight_lb NUMERIC(5,1),
      height_in NUMERIC(4,1),
      birth_date DATE,
      sex TEXT,
      notes TEXT,
      set_by TEXT DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('athlete_profile index', `CREATE INDEX IF NOT EXISTS idx_athlete_profile_dates ON athlete_profile(effective_from DESC)`);

  // v1.8.12: seed an athlete_profile row from user-supplied values
  // (49 yo male, 5'1") so BMR computation has real inputs immediately.
  // Only inserts if NO row exists at all (any existing row wins).
  await safeQuery('athlete_profile seed', `
    INSERT INTO athlete_profile (effective_from, height_in, birth_date, sex, set_by, notes)
    SELECT CURRENT_DATE, 61, '1977-01-01', 'male', 'system',
           'Seeded v1.8.12 from chat values: 49 yo male, 5''1"'
    WHERE NOT EXISTS (SELECT 1 FROM athlete_profile)
  `);

  // ===== RACES =====
  // First-class race calendar. Replaces the prior tag-inference pattern
  // (renderRaceCountdownCard scanning daily_plans for workout_type=/race/i).
  // A race is the central entity periodization revolves around — it owns
  // the priority tier, course profile, fueling plan, and gear list.
  await safeQuery('races table', `
    CREATE TABLE IF NOT EXISTS races (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      race_date DATE NOT NULL,
      name TEXT NOT NULL,
      discipline TEXT CHECK(discipline IN ('run','trail_run','ultra','spartan','triathlon','swim','bike','duathlon','other')),
      distance_value NUMERIC(7,2),
      distance_unit TEXT CHECK(distance_unit IN ('mi','km','m','laps','obstacles')),
      elevation_gain_ft INTEGER,
      terrain TEXT,
      target_time_seconds INTEGER,
      priority TEXT CHECK(priority IN ('A','B','C')) DEFAULT 'B',
      status TEXT CHECK(status IN ('scheduled','dnf','completed','withdrawn','cancelled')) DEFAULT 'scheduled',
      location TEXT,
      course_notes TEXT,
      expected_weather TEXT,
      fueling_plan TEXT,
      gear_list TEXT,
      goal_outcome TEXT,
      goal_process TEXT,
      result_time_seconds INTEGER,
      result_notes TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('races index date', `CREATE INDEX IF NOT EXISTS idx_races_date ON races(race_date DESC)`);
  await safeQuery('races index priority', `CREATE INDEX IF NOT EXISTS idx_races_priority ON races(priority, race_date)`);

  // ===== TRAINING BLOCKS (mesocycle periodization) =====
  // 3-6 week blocks that group daily_plans into a coherent thesis
  // (e.g. "Build 2: raise LT2"). Each block can link to a target race.
  await safeQuery('training_blocks table', `
    CREATE TABLE IF NOT EXISTS training_blocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('offseason','base','build','peak','taper','race','transition','recovery')),
      thesis TEXT,
      target_race_id UUID REFERENCES races(id) ON DELETE SET NULL,
      notes TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('training_blocks index dates', `CREATE INDEX IF NOT EXISTS idx_training_blocks_dates ON training_blocks(start_date, end_date)`);

  // daily_plans: structured periodization fields. `phase` mirrors
  // training_blocks.phase for fast lookups; `intent_type` is the structured
  // session purpose (rationale stays as free-text colour).
  await safeQuery('daily_plans +phase', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS phase TEXT`);
  await safeQuery('daily_plans +intent_type', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS intent_type TEXT`);
  await safeQuery('daily_plans +block_id', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS training_block_id UUID REFERENCES training_blocks(id) ON DELETE SET NULL`);
  await safeQuery('daily_plans +linked_race', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS linked_race_id UUID REFERENCES races(id) ON DELETE SET NULL`);

  // ===== FUELING REHEARSALS =====
  // Long-session fueling practice runs — what was eaten/drunk per hour,
  // gut response. Critical for race-day GI safety.
  await safeQuery('fueling_rehearsals table', `
    CREATE TABLE IF NOT EXISTS fueling_rehearsals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rehearsal_date DATE NOT NULL,
      workout_id UUID REFERENCES workouts(id) ON DELETE SET NULL,
      target_race_id UUID REFERENCES races(id) ON DELETE SET NULL,
      duration_min INTEGER,
      g_carb_per_hr NUMERIC(5,1),
      g_sodium_per_hr NUMERIC(5,1),
      ml_fluid_per_hr NUMERIC(5,1),
      g_caffeine_total NUMERIC(5,1),
      products TEXT,
      gut_response INTEGER CHECK(gut_response >= 1 AND gut_response <= 10),
      energy_response INTEGER CHECK(energy_response >= 1 AND energy_response <= 10),
      notes TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await safeQuery('fueling_rehearsals index', `CREATE INDEX IF NOT EXISTS idx_fueling_rehearsals_date ON fueling_rehearsals(rehearsal_date DESC)`);
  // Migration: rename g_caffeine_total → mg_caffeine_total. Field name
  // claimed grams but every caller wrote mg. Skill-creator caught the
  // unit mismatch (60mg dose stored as 60 in a g-named field would
  // imply 60 grams = lethal). Rename, no conversion — existing values
  // were always mg-semantic regardless of the column name.
  await safeQuery('fueling_rehearsals add mg_caffeine_total', `ALTER TABLE fueling_rehearsals ADD COLUMN IF NOT EXISTS mg_caffeine_total NUMERIC(7,1)`);
  // Only copy if the source column still exists. After the DROP below
  // succeeds, this UPDATE would fail with "column g_caffeine_total
  // does not exist" on every restart.
  await safeQuery('fueling_rehearsals copy g→mg caffeine', `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'fueling_rehearsals' AND column_name = 'g_caffeine_total') THEN
        UPDATE fueling_rehearsals SET mg_caffeine_total = g_caffeine_total
        WHERE mg_caffeine_total IS NULL AND g_caffeine_total IS NOT NULL;
      END IF;
    END $$;
  `);
  await safeQuery('fueling_rehearsals drop g_caffeine_total', `ALTER TABLE fueling_rehearsals DROP COLUMN IF EXISTS g_caffeine_total`);
  // Add ai_source for provenance — was missing.
  await safeQuery('fueling_rehearsals +ai_source', `ALTER TABLE fueling_rehearsals ADD COLUMN IF NOT EXISTS ai_source TEXT`);

  // ===== EMAIL INDEX =====
  // Stores pointers + summaries for email threads. Bodies are NOT stored;
  // they are fetched on demand from the source (Gmail/Outlook via MCP).
  await safeQuery('vector extension', `CREATE EXTENSION IF NOT EXISTS vector`);

  await safeQuery('email_threads table', `
    CREATE TABLE IF NOT EXISTS email_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      thread_provider_id TEXT NOT NULL,
      subject TEXT,
      participants JSONB DEFAULT '[]'::jsonb,
      message_count INTEGER DEFAULT 0,
      first_message_at TIMESTAMPTZ,
      last_message_at TIMESTAMPTZ,
      classification TEXT,
      classifier_confidence REAL,
      classifier_model TEXT,
      classifier_prompt_version TEXT,
      summary TEXT,
      entities JSONB DEFAULT '[]'::jsonb,
      topics JSONB DEFAULT '[]'::jsonb,
      embedding vector(1536),
      embedding_model TEXT,
      search_vector TSVECTOR,
      ingested_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (provider, account, thread_provider_id)
    )`);

  await safeQuery('email_threads indexes', `
    CREATE INDEX IF NOT EXISTS idx_email_threads_account ON email_threads(account);
    CREATE INDEX IF NOT EXISTS idx_email_threads_classification ON email_threads(classification);
    CREATE INDEX IF NOT EXISTS idx_email_threads_last_msg ON email_threads(last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_threads_search ON email_threads USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_email_threads_topics ON email_threads USING gin(topics);
    CREATE INDEX IF NOT EXISTS idx_email_threads_entities ON email_threads USING gin(entities)`);

  await safeQuery('email_threads embedding index',
    `CREATE INDEX IF NOT EXISTS idx_email_threads_embedding
       ON email_threads USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`);

  await safeQuery('email_messages table', `
    CREATE TABLE IF NOT EXISTS email_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id UUID REFERENCES email_threads(id) ON DELETE CASCADE,
      message_provider_id TEXT NOT NULL,
      rfc822_message_id TEXT,
      date TIMESTAMPTZ,
      subject TEXT,
      from_email TEXT,
      from_name TEXT,
      to_emails JSONB DEFAULT '[]'::jsonb,
      cc_emails JSONB DEFAULT '[]'::jsonb,
      direction TEXT,
      snippet TEXT,
      is_calendar BOOLEAN DEFAULT false,
      ingested_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (message_provider_id)
    )`);

  await safeQuery('email_messages indexes', `
    CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_email_messages_date ON email_messages(date DESC);
    CREATE INDEX IF NOT EXISTS idx_email_messages_from ON email_messages(from_email)`);

  // ===== CALENDAR INDEX =====
  // One row per calendar event. Like email, full event payloads stay in the
  // source (Google/Outlook); we hold pointers + classification + embedding.
  await safeQuery('calendar_events table', `
    CREATE TABLE IF NOT EXISTS calendar_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      calendar_id TEXT,
      event_provider_id TEXT NOT NULL,
      recurring_event_id TEXT,
      ical_uid TEXT,
      title TEXT,
      description TEXT,
      location TEXT,
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      all_day BOOLEAN DEFAULT false,
      status TEXT,
      organizer_email TEXT,
      organizer_name TEXT,
      attendees JSONB DEFAULT '[]'::jsonb,
      attendee_count INTEGER,
      classification TEXT,
      classifier_confidence REAL,
      classifier_model TEXT,
      classifier_prompt_version TEXT,
      summary TEXT,
      entities JSONB DEFAULT '[]'::jsonb,
      topics JSONB DEFAULT '[]'::jsonb,
      embedding vector(1536),
      embedding_model TEXT,
      search_vector TSVECTOR,
      ingested_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (provider, account, event_provider_id)
    )`);

  await safeQuery('calendar_events indexes', `
    CREATE INDEX IF NOT EXISTS idx_calendar_events_account ON calendar_events(account);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_classification ON calendar_events(classification);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_search ON calendar_events USING gin(search_vector);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_attendees ON calendar_events USING gin(attendees);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_topics ON calendar_events USING gin(topics);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_entities ON calendar_events USING gin(entities)`);

  await safeQuery('calendar_events embedding index',
    `CREATE INDEX IF NOT EXISTS idx_calendar_events_embedding
       ON calendar_events USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`);

  // Backfill search vectors for any existing rows
  await safeQuery('backfill knowledge search', `UPDATE knowledge SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill transcripts search', `UPDATE transcripts SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(raw_text,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill conversations search', `UPDATE conversations SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill workouts search', `UPDATE workouts SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(focus,'') || ' ' || coalesce(main_sets,'') || ' ' || coalesce(body_notes,'') || ' ' || coalesce(adjustment,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill body_metrics search', `UPDATE body_metrics SET search_vector = to_tsvector('english', coalesce(source,'') || ' ' || coalesce(notes,'') || ' ' || coalesce(measurement_context,'') || ' ' || coalesce(vendor_user_mode,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill meals search', `UPDATE meals SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(notes,'') || ' ' || coalesce(meal_type,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill dc search', `UPDATE daily_context SET search_vector = to_tsvector('english', coalesce(notes,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill coaching_sessions search', `UPDATE coaching_sessions SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(injury_notes,'') || ' ' || coalesce(next_steps,'') || ' ' || coalesce(recovery_notes,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill exercises search', `UPDATE exercises SET search_vector = to_tsvector('english', coalesce(name,'') || ' ' || coalesce(equipment,'') || ' ' || coalesce(primary_muscle_groups,'') || ' ' || coalesce(category,'') || ' ' || coalesce(description,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill injuries search', `UPDATE injuries SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body_area,'') || ' ' || coalesce(symptoms,'') || ' ' || coalesce(treatment,'') || ' ' || coalesce(notes,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill email_threads search', `UPDATE email_threads SET search_vector = to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(summary,'')) WHERE search_vector IS NULL`);
  await safeQuery('backfill calendar_events search', `UPDATE calendar_events SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(location,'')) WHERE search_vector IS NULL`);


  // ===== DATA MIGRATIONS =====
  // Migrate facts into knowledge (one-time, safe with ON CONFLICT)
  await safeQuery('migrate facts→knowledge', `
    INSERT INTO knowledge (id, title, content, category, tags, source, confirmed, search_vector, created_at, updated_at)
    SELECT id, title, content, category, tags, source, confirmed, search_vector, created_at, updated_at
    FROM facts
    ON CONFLICT (id) DO NOTHING
  `);

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

// Same as logActivity but uses a caller-supplied client so the insert
// participates in an open transaction. Errors propagate so the caller can
// roll back; this is intentional since the activity log is part of the
// atomic unit being committed.
async function logActivityWith(client, action, entityType, entityId, aiSource, details) {
  await client.query(
    `INSERT INTO activity_log (action, entity_type, entity_id, ai_source, details) VALUES ($1, $2, $3, $4, $5)`,
    [action, entityType, entityId, aiSource, details]
  );
}

module.exports = { pool, query, withTransaction, initDB, logActivity, logActivityWith };
