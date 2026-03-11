# AB Brain — Functional Specification

**Version:** 2.0
**Date:** 2026-03-11
**Purpose:** Complete specification for AB Brain — a unified personal AI knowledge base and task management system.

---

## 1. SYSTEM OVERVIEW

AB Brain is a **single-user personal knowledge management system** that serves as a shared memory layer across multiple AI assistants (Claude, ChatGPT, Gemini) and the Bee wearable device. It is a Node.js/Express backend with PostgreSQL as the primary data store, an optional one-way mirror to Notion, and a vanilla JavaScript single-page application (SPA) frontend designed as a mobile-first Progressive Web App (PWA).

### Core Value Proposition

A single person uses multiple AI assistants daily. Each AI has no memory of what the others said. AB Brain solves this by giving every AI read/write access to a shared PostgreSQL database via REST API. The user also gets a phone-friendly dashboard to browse, search, and manage everything.

### Architecture Summary

```
┌──────────────────────────────────────────────┐
│          Mobile PWA Frontend (vanilla JS)     │
│  Views: Dashboard, Kanban, Brain, Transcripts,│
│          Projects, Import                     │
└──────────────┬───────────────────────────────┘
               │ HTTPS (same-origin)
┌──────────────▼───────────────────────────────┐
│         Express.js REST API (Node 20)         │
│  Auth: X-Api-Key header (static key)          │
│  10+ route modules, ~50 endpoints             │
│  Smart Intake: GPT-4o-mini classification     │
│  Bee Cloud API proxy (HTTPS w/ custom CA)     │
│  Scheduled auto-sync (setInterval)            │
└──────┬───────────────────┬───────────────────┘
       │                   │ (optional)
┌──────▼──────────┐  ┌────▼─────────────────┐
│  PostgreSQL 16   │  │  Notion Workspace     │
│  (Railway)       │  │  (read-only mirror)   │
│  8 tables        │  │  One-way sync from PG │
│  tsvector + trgm │  └──────────────────────┘
└─────────────────┘

External integrations (via REST):
  - Claude (Project Instructions -> HTTP calls)
  - ChatGPT (Custom GPT + Actions via OpenAPI spec)
  - Gemini (import-only; no outbound API capability)
  - Bee Cloud API (Amazon-hosted, private CA cert)
  - OpenAI GPT-4o-mini (smart intake classification)
```

### Deployment Target

- **Railway.app** (Docker container + managed Postgres)
- Dockerfile: `node:20-slim`, `npm ci --omit=dev`
- Railway config limits Node heap to 384 MB (`--max-old-space-size=384`)
- Health check: `GET /api/health-check` (60s timeout)
- Restart policy: on failure, max 3 retries

---

## 2. DATABASE SCHEMA

PostgreSQL 16 with the `pg_trgm` extension enabled. All tables use `gen_random_uuid()` for primary keys (except `activity_log` which uses `SERIAL`). All timestamps are `TIMESTAMPTZ`. Full-text search via `tsvector` columns with auto-update triggers.

### 2.1 `knowledge` — Shared AI Memory

The core table. Every AI writes here.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `title` | TEXT NOT NULL | | Short descriptive title |
| `content` | TEXT NOT NULL | | Full content body (unlimited length) |
| `category` | TEXT | `'general'` | `general`, `transcript`, `meeting`, `code`, `research`, `decision`, `reference`, `health`, `personal`, `journal`, `daily-summary` |
| `tags` | JSONB | `'[]'` | Array of string tags |
| `source` | TEXT | `'manual'` | `api`, `bee`, `chatgpt-export`, `claude-export`, `manual` |
| `ai_source` | TEXT | NULL | `claude`, `chatgpt`, `gemini`, `bee`, `bee-sync` |
| `project_id` | UUID FK | NULL | References `projects(id)` |
| `metadata` | JSONB | `'{}'` | Flexible extra data |
| `search_vector` | TSVECTOR | NULL | Auto-populated by trigger |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:**
- `idx_knowledge_category` — B-tree on `category`
- `idx_knowledge_ai_source` — B-tree on `ai_source`
- `idx_knowledge_tags` — GIN on `tags`
- `idx_knowledge_search` — GIN on `search_vector`
- `idx_knowledge_trgm` — GIN trigram on `title || content`

**Trigger:** `trg_knowledge_search` — auto-updates `search_vector` on INSERT/UPDATE of title or content.

### 2.2 `facts` — Extracted Personal Facts

Discrete truths about the user, extracted from conversations or synced from Bee.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `title` | TEXT NOT NULL | | Short fact title |
| `content` | TEXT NOT NULL | | Full fact text |
| `category` | TEXT | `'general'` | `personal`, `preference`, `work`, `relationship`, `financial`, `general` |
| `tags` | JSONB | `'[]'` | |
| `source` | TEXT | `'manual'` | `bee`, `chatgpt`, `claude`, `gemini`, `manual` |
| `confirmed` | BOOLEAN | `false` | User-verified fact |
| `search_vector` | TSVECTOR | NULL | Auto-populated |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:** `idx_facts_category`, `idx_facts_source`, `idx_facts_search` (GIN), `idx_facts_trgm` (GIN trigram)

### 2.3 `projects` — Project Containers

| Column | Type | Default | Constraint |
|--------|------|---------|------------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `name` | TEXT NOT NULL | | |
| `description` | TEXT | NULL | |
| `status` | TEXT | `'active'` | CHECK: `active`, `paused`, `completed`, `archived` |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

### 2.4 `tasks` — Work Items (Kanban)

| Column | Type | Default | Constraint |
|--------|------|---------|------------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `project_id` | UUID FK | NULL | `ON DELETE SET NULL` -> `projects(id)` |
| `title` | TEXT NOT NULL | | |
| `description` | TEXT | NULL | |
| `status` | TEXT | `'todo'` | CHECK: `todo`, `in_progress`, `review`, `done` |
| `priority` | TEXT | `'medium'` | CHECK: `low`, `medium`, `high`, `urgent` |
| `ai_agent` | TEXT | NULL | `claude`, `chatgpt`, `gemini`, `bee` |
| `next_steps` | TEXT | NULL | |
| `output_log` | TEXT | NULL | |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:** `idx_tasks_project`, `idx_tasks_status`, `idx_tasks_ai_agent`

**Sorting:** priority (urgent first), then `created_at ASC`.

### 2.5 `transcripts` — Bee Conversations & Other Audio

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `title` | TEXT NOT NULL | | Auto-generated if blank |
| `raw_text` | TEXT | NULL | Full transcript (unlimited) |
| `summary` | TEXT | NULL | AI-generated or Bee-provided |
| `source` | TEXT | `'bee'` | `bee`, `manual`, `zoom`, `meet`, `teams` |
| `ai_source` | TEXT | NULL | |
| `duration_seconds` | INTEGER | NULL | |
| `recorded_at` | TIMESTAMPTZ | NULL | |
| `location` | TEXT | NULL | Physical location |
| `tags` | JSONB | `'[]'` | |
| `bee_id` | TEXT | NULL | Bee conversation ID for dedup |
| `project_id` | UUID FK | NULL | -> `projects(id)` |
| `metadata` | JSONB | `'{}'` | `bee_id`, `utterances_count`, `primary_location`, etc. |
| `search_vector` | TSVECTOR | NULL | |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:** `idx_transcripts_source`, `idx_transcripts_bee_id`, `idx_transcripts_recorded`, `idx_transcripts_search` (GIN), `idx_transcripts_trgm` (GIN trigram on title+summary+raw_text)

### 2.6 `transcript_speakers` — Granular Speaker Data

Person-by-person utterance data from Bee transcripts.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `transcript_id` | UUID FK NOT NULL | | -> `transcripts(id)` ON DELETE CASCADE |
| `speaker_name` | TEXT NOT NULL | | Raw name from Bee |
| `utterance_index` | INTEGER NOT NULL | | Order in conversation |
| `text` | TEXT NOT NULL | | What they said |
| `spoken_at` | TIMESTAMPTZ | NULL | |
| `start_offset_ms` | INTEGER | NULL | |
| `end_offset_ms` | INTEGER | NULL | |
| `confidence` | REAL | NULL | |
| `created_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:** `idx_speakers_transcript`, `idx_speakers_name`, `idx_speakers_trgm` (GIN trigram on text)

### 2.7 `conversations` — Full AI Chat Threads

Stores complete AI conversation threads (Claude, ChatGPT, Gemini) with both the full message history and an AI-generated summary.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `title` | TEXT NOT NULL | | |
| `ai_source` | TEXT NOT NULL | | `claude`, `chatgpt`, `gemini` |
| `full_thread` | JSONB NOT NULL | `'[]'` | Array of `{role, content, timestamp}` |
| `summary` | TEXT | NULL | AI-generated summary |
| `tags` | JSONB | `'[]'` | |
| `project_id` | UUID FK | NULL | -> `projects(id)` |
| `message_count` | INTEGER | `0` | |
| `metadata` | JSONB | `'{}'` | `chatgpt_id` for dedup, etc. |
| `search_vector` | TSVECTOR | NULL | |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:** `idx_conversations_ai_source`, `idx_conversations_search` (GIN), `idx_conversations_tags` (GIN)

### 2.8 `activity_log` — Audit Trail

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL PK | | Auto-increment |
| `action` | TEXT NOT NULL | | `create`, `update`, `delete`, `bee-change-cursor` |
| `entity_type` | TEXT | NULL | `knowledge`, `task`, `project`, `transcript`, `fact`, `conversation`, `bee-import`, `bee-sync` |
| `entity_id` | TEXT | NULL | |
| `ai_source` | TEXT | NULL | |
| `details` | TEXT | NULL | Also stores Bee sync cursors |
| `created_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:** `idx_activity_entity` (composite), `idx_activity_time` (DESC)

### Search Strategy

- **Primary:** `tsvector` full-text search with `plainto_tsquery` and `ts_rank` scoring
- **Fallback:** `pg_trgm` similarity matching via `ILIKE` for partial/fuzzy matches
- **Auto-update:** Triggers on INSERT/UPDATE automatically rebuild `search_vector` columns
- **Backfill:** On startup, backfills any rows with NULL `search_vector`

### Data Relationships

```
projects <-- tasks.project_id
  |      <-- knowledge.project_id
  |      <-- transcripts.project_id
  |      <-- conversations.project_id

transcripts <-- transcript_speakers.transcript_id (CASCADE)
```

---

## 3. API SPECIFICATION

### 3.1 Authentication

All `/api/*` routes (except `/api/health-check`) require:
- Header: `X-Api-Key: <key>`
- OR query parameter: `?api_key=<key>`

Compared against `API_KEY` env var. If unset, auth is skipped (dev mode). Returns `401` on mismatch.

### 3.2 Global Configuration

- `Content-Type: application/json` for all request/response bodies
- Request body size limit: 50 MB (for large transcript imports)
- CORS: permissive (all origins)
- Security: Helmet with `contentSecurityPolicy: false`

### 3.3 Public Routes (No Auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health-check` | Returns `{ status: 'ok', timestamp }` |
| GET | `/openapi.json` | OpenAPI spec for ChatGPT Actions |
| GET | `/privacy` | Static HTML privacy policy |
| GET | `*` (catch-all) | SPA fallback -> `index.html` |

### 3.4 Knowledge Routes (`/api/knowledge`)

**`GET /`** — List/Search
- Query params: `q` (full-text search), `category`, `ai_source`, `tag`, `limit` (default 50), `offset`
- Search: tsvector first, ILIKE fallback if zero results
- Returns: `{ count, entries: [...] }`

**`GET /meta/categories`** — List distinct categories

**`GET /:id`** — Get single entry (full content)

**`POST /`** — Create entry
- Required: `{ title, content }`
- Optional: `category`, `tags`, `source`, `ai_source`, `metadata`
- Returns: `{ id, message }` (201)

**`PUT /:id`** — Partial update

**`DELETE /:id`** — Delete entry

### 3.5 Facts Routes (`/api/facts`)

**`GET /`** — List/search with `q`, `category`, `source`, `confirmed`, `limit`

**`GET /:id`** — Get single fact

**`POST /`** — Create fact (required: `title`, `content`)

**`PUT /:id`** — Update fact

**`DELETE /:id`** — Delete fact

### 3.6 Task Routes (`/api/tasks`)

**`GET /`** — List tasks with `project_id`, `status`, `ai_agent`, `limit` filters

**`GET /kanban`** — Returns `{ todo: [...], in_progress: [...], review: [...], done: [...] }`

**`GET /:id`** — Get single task

**`POST /`** — Create task (required: `title`)

**`PUT /:id`** — Update task (logs status changes)

**`DELETE /:id`** — Delete task

### 3.7 Project Routes (`/api/projects`)

**`GET /`** — List projects with `task_counts` per status

**`GET /:id`** — Get project with tasks

**`POST /`** — Create project (required: `name`)

**`PUT /:id`** — Update project

**`DELETE /:id`** — Delete project (tasks get `SET NULL`)

### 3.8 Transcript Routes (`/api/transcripts`)

**`GET /`** — List/search with `q`, `source`, `limit`. Returns preview (300 chars).

**`GET /:id`** — Full transcript including `raw_text` and speaker utterances

**`POST /`** — Upload transcript (required: `raw_text`)
- Auto-generates title if not provided
- Stores speaker utterances in `transcript_speakers` if `speaker_labels` provided

**`POST /bulk`** — Bulk upload

**`DELETE /:id`** — Delete transcript (cascades to speakers)

### 3.9 Conversation Routes (`/api/conversations`)

**`GET /`** — List/search conversations

**`GET /:id`** — Full conversation thread

**`POST /`** — Store conversation with `full_thread` JSONB

**`PUT /:id`** — Update

**`DELETE /:id`** — Delete

### 3.10 Smart Intake Routes (`/api/intake`)

AI-powered auto-classification using OpenAI GPT-4o-mini.

**`POST /`** — Classify and file any input
- Required: `{ input }`
- Optional: `source`, `context`
- GPT-4o-mini determines: database, title, category, tags, priority, status, summary
- Returns: `{ id, classification }`

**`POST /batch`** — Batch auto-classify multiple items

**`POST /distill`** — Extract insights from a conversation
- Required: `{ content }`
- Extracts: facts -> `facts` table, decisions -> `knowledge` table, tasks -> `tasks` table
- Returns: `{ extracted: { facts, decisions, tasks }, project, tags }`

### 3.11 Activity Log (`/api/activity`)

**`GET /`** — List with `entity_type`, `ai_source`, `limit` filters. Ordered by `created_at DESC`.

### 3.12 Dashboard (`/api/dashboard`)

**`GET /`** — Parallel SQL aggregate queries returning:

```json
{
  "knowledge": { "total", "by_category", "by_ai_source" },
  "facts": { "total", "by_category", "confirmed", "unconfirmed" },
  "projects": { "active" },
  "tasks": { "by_status", "by_priority", "by_agent" },
  "transcripts": { "total" },
  "recent_activity": [/* last 15 entries */]
}
```

### 3.13 Unified Search (`/api/search`)

**`GET /`** — Search all types in parallel
- Required: `q`, optional: `limit` (max 50)
- Returns: `{ query, results: { knowledge, facts, transcripts, tasks, projects }, total }`

**`POST /ai`** — AI-optimized flattened results for programmatic access

### 3.14 Bee Integration (`/api/bee`)

The Bee (by Amazon) is a wearable that records conversations.

**Bee Cloud API Details:**
- Base URL: `https://app-api-developer.ce.bee.amazon.dev`
- TLS: Private CA certificate (embedded in source code)
- Auth: Bearer token from `X-Bee-Token` header / `req.body.bee_token` / `BEE_API_TOKEN` env
- Timeout: 30s, max response: 5 MB
- Pagination: cursor-based

**Endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `GET /status` | Sync status and local counts |
| `GET /counts` | Live Bee API item counts |
| `POST /sync` | Full sync (blocks) |
| `POST /sync-chunk` | Chunked sync (frontend-driven, primary method) |
| `POST /sync-incremental` | Delta sync via change feed (used by auto-sync) |
| `POST /purge` | Delete all Bee data |
| `POST /import` | Import from JSON |
| `POST /search` | Neural search via Bee API |
| `GET /diagnose` | Test Bee API connectivity |

**Scheduled Auto-Sync:** When `BEE_API_TOKEN` is set, runs incremental sync 10s after startup, then every `BEE_SYNC_INTERVAL` minutes (default 30).

### 3.15 Sync Status (`/api/sync-status`)

In-memory tracker for all data sources (bee, chatgpt, claude, intake). Returns source states and recent job history.

---

## 4. NOTION MIRROR (OPTIONAL)

When `NOTION_TOKEN` and `NOTION_DB_*` environment variables are configured, a background sync pushes data one-way from PostgreSQL to Notion.

### How It Works

- PostgreSQL is the **source of truth** — all API reads and writes go to PostgreSQL
- A background job periodically mirrors new/updated records to corresponding Notion databases
- Notion databases have matching schemas (Title, Content, Category, Tags, etc.)
- The mirror is **read-only** from Notion's perspective — edits in Notion are NOT synced back
- Rate limited to ~3 requests/second (Notion API constraint)

### Notion Databases

| Notion Database | Mirrors From |
|----------------|--------------|
| Knowledge | `knowledge` table |
| Facts | `facts` table |
| Tasks | `tasks` table |
| Projects | `projects` table |
| Transcripts | `transcripts` table |
| Activity Log | `activity_log` table |

### Why Keep Notion?

- Browse data in the Notion app (nice mobile experience)
- Built-in views, filters, grouping, and sharing
- No frontend code to maintain for the mirror — it's just API calls
- If Notion goes down or is removed, nothing breaks — PostgreSQL has everything

---

## 5. FRONTEND SPECIFICATION

### 5.1 Technology

- **Vanilla JavaScript** — no framework, no build step
- Single HTML file (`index.html`) + one CSS file (`styles.css`) + one JS file (`app.js`)
- Dark theme (background: `#0f1117`, text: `#e4e6f0`, accent: `#6366f1`)
- Mobile-first responsive design
- PWA: Service worker (`sw.js`) + web manifest (`manifest.json`)
- iOS-optimized: `apple-mobile-web-app-capable`, safe area insets

### 5.2 What is a PWA?

A **Progressive Web App** means the website can be installed on a phone's home screen:
- Opens full-screen (no browser chrome)
- Has its own app icon (AB Brain logo)
- Works offline for cached content (app shell)
- Auto-refreshes data when resumed from background
- No app store required — "Add to Home Screen" from browser

### 5.3 Authentication Flow

1. Check `sessionStorage` then `localStorage` for `ab_api_key`
2. If missing, show login overlay with AB Brain logo
3. Test key against `GET /api/dashboard` — 401 = invalid, success = store and proceed
4. "Remember me" -> `localStorage` (persistent) vs. `sessionStorage` (tab only)
5. All API calls include `X-Api-Key` header via `api()` helper
6. Any 401 response redirects to login

### 5.4 Header & Branding

- Header shows AB Brain logo (SVG), title with gradient text (indigo to purple), and subtitle
- Logo is a stylized brain with "AB" initials, using the app's color palette
- Same logo used in: login screen, header, favicon, PWA icon

### 5.5 Dashboard View

- Stats grid (3 cols mobile, responsive): Knowledge, Transcripts, Tasks, In Progress, Active Projects, Facts
- Bee Wearable Sync card with sync buttons
- Sync Status card with per-source indicators and job history
- Recent Activity (last 15 items)
- Tools section

### 5.6 Global Search (Ctrl+K / Cmd+K)

- Full-screen overlay with debounced search (300ms, min 2 chars)
- Calls `GET /api/search?q=term`
- Results grouped by type with icons
- Also fires Bee neural search in background

### 5.7 Service Worker

- Cache name: `abkb-v2`
- Caches app shell: `/`, `/styles.css`, `/app.js`, `/manifest.json`
- Cache-first for static assets, network-only for `/api/*`
- `skipWaiting` + `clients.claim` on activate

---

## 6. ENVIRONMENT VARIABLES

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server listen port |
| `API_KEY` | Yes (prod) | None | Static API key for auth |
| `DATABASE_URL` | Yes | None | PostgreSQL connection string (Railway auto-sets) |
| `OPENAI_API_KEY` | Yes | None | OpenAI key for smart intake (GPT-4o-mini) |
| `BEE_API_TOKEN` | No | None | Bee API token for auto-sync |
| `BEE_SYNC_INTERVAL` | No | `30` | Minutes between auto-syncs |
| `NOTION_TOKEN` | No | None | Notion integration secret (enables mirror) |
| `NOTION_DB_KNOWLEDGE` | No | None | Notion database ID |
| `NOTION_DB_FACTS` | No | None | Notion database ID |
| `NOTION_DB_TASKS` | No | None | Notion database ID |
| `NOTION_DB_PROJECTS` | No | None | Notion database ID |
| `NOTION_DB_TRANSCRIPTS` | No | None | Notion database ID |
| `NOTION_DB_ACTIVITY_LOG` | No | None | Notion database ID |

---

## 7. SCRIPTS & UTILITIES

### 7.1 `scripts/import-chatgpt.js`
CLI script to bulk-import ChatGPT conversations from `conversations.json` directly into PostgreSQL.

### 7.2 `scripts/bee-live-sync.js`
Node.js script for syncing Bee data from the local `~/.bee` directory on a Mac.

### 7.3 `scripts/bee-to-brain-sync.sh`
Bash wrapper with `--only` and `--recent-days` flags.

### 7.4 `scripts/com.abbrain.bee-sync.plist`
macOS LaunchAgent for scheduling bee-live-sync.js.

---

## 8. KEY DESIGN DECISIONS

### 8.1 PostgreSQL as Primary, Notion as Mirror
PostgreSQL handles all reads, writes, and search. It offers millisecond queries, unlimited text storage, full-text search with ranking, and no rate limits. Notion serves as an optional read-only mirror for users who want to browse data in the Notion app. If Notion is removed, nothing breaks.

### 8.2 Full-Text Search with Trigram Fallback
Every searchable table has a `search_vector` TSVECTOR column auto-updated by triggers on INSERT/UPDATE. Primary search uses `plainto_tsquery` with `ts_rank` scoring. If zero results, falls back to `ILIKE` (powered by `pg_trgm` GIN indexes) for fuzzy/partial matching.

### 8.3 Speaker-Level Transcript Storage
The `transcript_speakers` table stores individual utterances with speaker names, timestamps, and text. This enables searching by speaker ("what did Andrew say?"), building conversation timelines, and rendering chat-bubble UIs.

### 8.4 AI Conversation Archive
The `conversations` table stores full AI chat threads as JSONB arrays alongside AI-generated summaries. This preserves the complete context of every AI interaction while making them searchable.

### 8.5 Smart Intake with GPT-4o-mini
The cheapest OpenAI model classifies raw input into the correct table with proper metadata. Costs fractions of a cent per classification. The distill endpoint extracts structured facts, decisions, and tasks from full conversations.

### 8.6 No Framework Frontend
Vanilla JS with DOM manipulation via `innerHTML`. Keeps the bundle tiny and eliminates build tooling. XSS prevention via manual `esc()` function.

### 8.7 Chunked Bee Sync
`/sync-chunk` lets the frontend drive pagination and show real-time progress. Conversations limited to 5 per chunk (each needs a separate Bee API call for the full transcript).

### 8.8 Custom CA Certificate for Bee API
Bee (Amazon) uses a private Certificate Authority. The root CA cert is embedded in source code.

### 8.9 Mobile PWA Optimization
- Bottom nav with safe-area padding for iPhone notch
- `overscroll-behavior: none` prevents bounce scrolling
- `100dvh` for proper mobile viewport
- Pull-to-refresh gesture detection
- Auto-refresh on app resume (visibility change)

---

## 9. FUTURE ROADMAP

### Planned Features
1. **People directory** — Normalized person table with aliases, speaker resolution for Bee transcripts
2. **Health & fitness** — Workout logs (Fitbod/Strava/Apple Fitness), daily health metrics
3. **AI query endpoints** — Fast single endpoint for AIs to search the entire knowledge base
4. **Decisions table** — Executive decision log extracted from conversations
5. **Bee task filtering** — Suggested vs. confirmed tasks from Bee todos
6. **Persistent sync jobs** — Replace in-memory tracker with database table
7. **Security** — Proper authentication beyond static API key
8. **Backup** — Automated PostgreSQL exports
9. **Cost tracking** — Monitor AI API spend across providers

---

## 10. REBUILD GUIDE

If rebuilding from scratch:

1. **Start with `db.js`** — Run `initDB()` to create all tables, indexes, and triggers. The `knowledge` table is central.

2. **Build the API layer** — Routes are stateless REST. Start with knowledge, tasks, projects. Add transcripts, facts, intake, then Bee last.

3. **The Bee integration is the most complex module:**
   - Response shapes vary (array, `{ items }`, `{ facts }`)
   - Conversation transcripts require a second API call per conversation
   - The private CA cert is mandatory
   - 5-per-chunk limit on conversations is deliberate

4. **The frontend can be rebuilt in any framework** but preserve:
   - Bottom-tab navigation (phone-first, not sidebar)
   - Chat-bubble transcript viewer with speaker detection
   - Ctrl+K global search overlay
   - Chunked sync progress UI for Bee imports

5. **The OpenAPI spec** must stay in sync with the API for ChatGPT Custom GPT setup.

6. **The Notion mirror** is a separate concern — build it last, as a background job.
