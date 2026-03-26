// PostgreSQL database layer for AB Brain.
// Full-text search via tsvector + pg_trgm, granular Bee transcripts,
// AI conversation storage with both full threads and summaries.

const { Pool } = require('pg');

const APP_TIMEZONE = process.env.TZ || process.env.APP_TIMEZONE || 'America/New_York';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
});

// Set timezone on every new connection so CURRENT_DATE, NOW(), etc. use the user's local time
pool.on('connect', (client) => {
  client.query(`SET timezone = '${APP_TIMEZONE}'`).catch(() => {});
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

  // ===== TRAINING PLANS =====
  await safeQuery('training_plans table', `
    SELECT 1`); // training_plans table removed — all planning now uses daily_plans

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
    CREATE INDEX IF NOT EXISTS idx_coaching_sessions_plan ON coaching_sessions(training_plan_id);
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
    CREATE INDEX IF NOT EXISTS idx_daily_plans_training_plan ON daily_plans(training_plan_id);
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

  // exercises migrations not needed — table is dropped and recreated fresh on each startup

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
  // Migrate equipment TEXT[] → JSONB if fix branch created it as array
  await safeQuery('gym_profiles migrate equipment type', `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'gym_profiles' AND column_name = 'equipment' AND udt_name = '_text') THEN
        ALTER TABLE gym_profiles ALTER COLUMN equipment TYPE JSONB USING to_jsonb(equipment);
        ALTER TABLE gym_profiles ALTER COLUMN equipment SET DEFAULT '[]'::jsonb;
      END IF;
    END $$`);

  // -- daily_plans migrations --
  await safeQuery('daily_plans +planned_exercises', `ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS planned_exercises JSONB DEFAULT '[]'::jsonb`);

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
  await safeQuery('backfill duration_minutes v2', `
    UPDATE workouts SET duration_minutes = (
      CASE
        WHEN time_duration ~ '^\\d+:\\d+:\\d+' THEN
          SPLIT_PART(time_duration, ':', 1)::int * 60 + SPLIT_PART(time_duration, ':', 2)::int
        WHEN time_duration ~ '^\\d+:\\d+' AND SPLIT_PART(time_duration, ':', 1)::int <= 12 THEN
          SPLIT_PART(time_duration, ':', 1)::int * 60 + SPLIT_PART(time_duration, ':', 2)::int
        WHEN time_duration ~ '^\\d+:\\d+' THEN
          SPLIT_PART(time_duration, ':', 1)::int
        WHEN time_duration ~ '^[\\d.]+ *h' THEN
          ROUND(REGEXP_REPLACE(time_duration, '[^\\d.]', '', 'g')::numeric * 60)::int
        WHEN time_duration ~ '^[\\d.]+' THEN
          LEAST(ROUND(REGEXP_REPLACE(time_duration, '[^\\d.]', '', 'g')::numeric)::int, 300)
        ELSE NULL
      END
    ) WHERE time_duration IS NOT NULL AND time_duration != ''
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
    WHERE hr_avg IS NULL AND heart_rate_avg IS NOT NULL AND heart_rate_avg ~ '\\d'
  `);
  await safeQuery('backfill hr_max', `
    UPDATE workouts SET hr_max = REGEXP_REPLACE(heart_rate_max, '[^\\d]', '', 'g')::int
    WHERE hr_max IS NULL AND heart_rate_max IS NOT NULL AND heart_rate_max ~ '\\d'
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
  await safeQuery('rename dnc→dc', `ALTER TABLE IF EXISTS daily_nutrition_context RENAME TO daily_context`);
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

  // Seed exercises removed — 1069 exercises already imported via CSV

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

module.exports = { pool, query, initDB, logActivity };
