# AB Knowledge Base — Functional Specification

**Version:** 1.0
**Date:** 2026-03-08
**Purpose:** Complete rebuild specification for the AB Knowledge Base ("AB Brain") platform — a unified personal AI knowledge base and task management system.

---

## 1. SYSTEM OVERVIEW

AB Brain is a **single-user personal knowledge management system** that serves as a shared memory layer across multiple AI assistants (Claude, ChatGPT, Gemini) and the Bee wearable device. It is a Node.js/Express backend with PostgreSQL storage and a vanilla JavaScript single-page application (SPA) frontend designed as a mobile-first Progressive Web App (PWA).

### Core Value Proposition
A single person uses multiple AI assistants daily. Each AI has no memory of what the others said. AB Brain solves this by giving every AI read/write access to a shared database via REST API. The user also gets a phone-friendly dashboard to browse, search, and manage everything.

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
│  9 route modules, ~40 endpoints               │
│  Bee Cloud API proxy (HTTPS w/ custom CA)     │
│  Scheduled auto-sync (setInterval)            │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│         PostgreSQL 16 (Railway-managed)        │
│  7 tables, full-text search (tsvector/GIN)    │
│  pg_trgm extension                            │
└───────────────────────────────────────────────┘

External integrations (via REST):
  - Claude (Project Instructions → HTTP calls)
  - ChatGPT (Custom GPT + Actions via OpenAPI spec)
  - Gemini (import-only; no outbound API capability)
  - Bee Cloud API (Amazon-hosted, private CA cert)
```

### Deployment Target
- **Railway.app** (Docker container + managed Postgres)
- Dockerfile: `node:20-slim`, `npm ci --omit=dev`
- Railway config limits Node heap to 384 MB (`--max-old-space-size=384`)
- Health check: `GET /api/health-check` (60s timeout)
- Restart policy: on failure, max 3 retries

---

## 2. DATABASE SCHEMA

PostgreSQL with the `pg_trgm` extension enabled. All tables use `gen_random_uuid()` for primary keys (except `activity_log` which uses `SERIAL`). All timestamps are `TIMESTAMPTZ`.

### 2.1 `knowledge` — Shared AI Memory

The core table. Every AI writes here. Transcripts also get mirrored here for unified search.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `title` | TEXT NOT NULL | | Short descriptive title |
| `content` | TEXT NOT NULL | | Full content body (can be very long) |
| `category` | TEXT | `'general'` | One of: `general`, `transcript`, `meeting`, `code`, `research`, `decision`, `reference`, `health`, `personal`, `journal`, `daily-summary` |
| `tags` | JSONB | `'[]'` | Array of string tags |
| `source` | TEXT | `'manual'` | How data entered: `api`, `bee`, `chatgpt-export`, `claude-export`, `manual` |
| `ai_source` | TEXT | NULL | Which AI wrote it: `claude`, `chatgpt`, `gemini`, `bee`, `bee-sync` |
| `metadata` | JSONB | `'{}'` | Flexible extra data (e.g., `transcript_id`, `bee_id`, `bee_journal_id`, `bee_daily_id`, `original_id`) |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:**
- `idx_knowledge_category` — B-tree on `category`
- `idx_knowledge_ai_source` — B-tree on `ai_source`
- `idx_knowledge_tags` — GIN on `tags`
- `idx_knowledge_search` — GIN full-text on `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))`

### 2.2 `projects` — Project Containers

| Column | Type | Default | Constraint |
|--------|------|---------|------------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `name` | TEXT NOT NULL | | |
| `description` | TEXT | NULL | |
| `status` | TEXT | `'active'` | CHECK: `active`, `paused`, `completed`, `archived` |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

### 2.3 `tasks` — Work Items (Kanban)

| Column | Type | Default | Constraint |
|--------|------|---------|------------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `project_id` | UUID FK → `projects(id)` | NULL | `ON DELETE SET NULL` |
| `title` | TEXT NOT NULL | | |
| `description` | TEXT | NULL | |
| `status` | TEXT | `'todo'` | CHECK: `todo`, `in_progress`, `review`, `done` |
| `priority` | TEXT | `'medium'` | CHECK: `low`, `medium`, `high`, `urgent` |
| `ai_agent` | TEXT | NULL | Which AI created/owns: `claude`, `chatgpt`, `gemini`, `bee` |
| `next_steps` | TEXT | NULL | Free-text next steps (also stores Bee Todo IDs) |
| `output_log` | TEXT | NULL | Execution output/notes |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:**
- `idx_tasks_project` — B-tree on `project_id`
- `idx_tasks_status` — B-tree on `status`

**Sorting convention:** Tasks are always ordered by priority (urgent→high→medium→low), then `created_at ASC`.

### 2.4 `transcripts` — Bee Conversations & Other Audio

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `title` | TEXT NOT NULL | | Auto-generated if blank |
| `raw_text` | TEXT NOT NULL | | Full transcript. Format: `[HH:MM:SS AM] Speaker: text` (one line per utterance) |
| `summary` | TEXT | NULL | AI-generated or Bee-provided summary |
| `source` | TEXT | `'bee'` | `bee`, `manual`, `zoom`, `meet`, `teams` |
| `speaker_labels` | JSONB | `'[]'` | Array of speaker objects from Bee (may include `is_me`, `role`, `name`) |
| `duration_seconds` | INTEGER | NULL | |
| `recorded_at` | TIMESTAMPTZ | NULL | When the conversation happened |
| `location` | TEXT | NULL | Added via migration; physical location string |
| `tags` | JSONB | `'[]'` | |
| `metadata` | JSONB | `'{}'` | Stores `bee_id`, `utterances_count`, `primary_location` object, `state`, `start_time`, `end_time` |
| `created_at` | TIMESTAMPTZ | `NOW()` | |
| `updated_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:**
- `idx_transcripts_source` — B-tree on `source`
- `idx_transcripts_recorded` — B-tree on `recorded_at`
- `idx_transcripts_search` — GIN full-text on `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(raw_text,''))`

**Migration:** `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS location TEXT` runs at init.

### 2.5 `health_metrics` — Apple Health Vitals

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `metric_type` | TEXT NOT NULL | | e.g., `heart_rate`, `steps`, `blood_pressure` |
| `value` | NUMERIC NOT NULL | | |
| `unit` | TEXT NOT NULL | | e.g., `bpm`, `count`, `mmHg` |
| `source_name` | TEXT | `'apple_health'` | |
| `recorded_at` | TIMESTAMPTZ NOT NULL | | |
| `metadata` | JSONB | `'{}'` | |
| `created_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:**
- `idx_health_type` — B-tree on `metric_type`
- `idx_health_recorded` — B-tree on `recorded_at`
- `idx_health_type_date` — Composite on `(metric_type, recorded_at)`

### 2.6 `workouts` — Apple Health Workouts

| Column | Type | Default |
|--------|------|---------|
| `id` | UUID PK | `gen_random_uuid()` |
| `workout_type` | TEXT NOT NULL | |
| `duration_minutes` | NUMERIC | NULL |
| `calories_burned` | NUMERIC | NULL |
| `distance_km` | NUMERIC | NULL |
| `avg_heart_rate` | NUMERIC | NULL |
| `max_heart_rate` | NUMERIC | NULL |
| `source_name` | TEXT | `'apple_health'` |
| `started_at` | TIMESTAMPTZ NOT NULL | |
| `ended_at` | TIMESTAMPTZ | NULL |
| `metadata` | JSONB | `'{}'` |
| `created_at` | TIMESTAMPTZ | `NOW()` |

**Indexes:**
- `idx_workouts_type` — B-tree on `workout_type`
- `idx_workouts_date` — B-tree on `started_at`

### 2.7 `activity_log` — Audit Trail

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | SERIAL PK | | Auto-increment |
| `action` | TEXT NOT NULL | | `create`, `update`, `delete`, `bee-change-cursor` |
| `entity_type` | TEXT | NULL | `knowledge`, `task`, `project`, `transcript`, `health_metric`, `workout`, `bee-import`, `bee-sync` |
| `entity_id` | TEXT | NULL | UUID or special value like `cloud-sync`, `incremental`, `bulk`, `cursor` |
| `ai_source` | TEXT | NULL | Which AI or system triggered the action |
| `details` | TEXT | NULL | Human-readable description; also stores the incremental sync cursor for Bee |
| `created_at` | TIMESTAMPTZ | `NOW()` | |

**Indexes:**
- `idx_activity_entity` — Composite on `(entity_type, entity_id)`
- `idx_activity_time` — B-tree on `created_at`

**Special usage:** Rows with `action = 'bee-change-cursor'` store the Bee incremental sync cursor in the `details` column. The most recent such row is queried to resume incremental sync.

---

## 3. API SPECIFICATION

### 3.1 Authentication

All `/api/*` routes (except `/api/health-check`) require authentication via:
- Header: `X-Api-Key: <key>`
- OR query parameter: `?api_key=<key>`

The key is compared against the `API_KEY` environment variable. If `API_KEY` is unset, auth is skipped (development mode). Returns `401` on mismatch.

### 3.2 Global Configuration

- `Content-Type: application/json` for all request/response bodies
- Request body size limit: `50 MB` (for large transcript imports)
- CORS: permissive (all origins allowed)
- Security: Helmet with `contentSecurityPolicy: false`

### 3.3 Public Routes (No Auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health-check` | Returns `{ status: 'ok', timestamp }` |
| GET | `/openapi.json` | Serves the OpenAPI spec for ChatGPT Actions |
| GET | `/privacy` | Static HTML privacy policy page |
| GET | `*` (catch-all) | SPA fallback → serves `index.html` |

### 3.4 Knowledge Routes (`/api/knowledge`)

#### `GET /` — List/Search Knowledge
- Query params: `q` (full-text search), `category`, `ai_source`, `tag`, `limit` (default 50), `offset` (default 0)
- **Search logic:** If `q` is provided, tries PostgreSQL full-text search (`plainto_tsquery`) first. If zero results, falls back to `ILIKE %q%` on title and content.
- Returns: `{ count, entries: [...] }`

#### `GET /meta/categories` — List Distinct Categories
- Returns: array of category strings

#### `GET /:id` — Get Single Entry
- Returns full knowledge object or `404`

#### `POST /` — Create Knowledge Entry
- Required body: `{ title, content }`
- Optional: `category`, `tags` (array), `source`, `ai_source`, `metadata` (object)
- Creates an `activity_log` entry
- Returns: `{ id, message }` with status `201`

#### `PUT /:id` — Update Knowledge Entry
- Merges provided fields with existing values (partial update)
- Updates `updated_at`
- Creates an `activity_log` entry

#### `DELETE /:id` — Delete Knowledge Entry
- Creates an `activity_log` entry

### 3.5 Task Routes (`/api/tasks`)

#### `GET /` — List Tasks
- Query params: `project_id`, `status`, `ai_agent`, `limit` (default 100), `offset`
- Joins with `projects` to include `project_name`
- Ordered by priority (urgent first), then `created_at ASC`

#### `GET /kanban` — Kanban View
- Optional: `project_id` filter
- Returns: `{ todo: [...], in_progress: [...], review: [...], done: [...] }`

#### `GET /:id` — Get Single Task
- Includes `project_name` via JOIN

#### `POST /` — Create Task
- Required: `{ title }`
- Optional: `project_id`, `description`, `status`, `priority`, `ai_agent`, `next_steps`
- Creates `activity_log` entry

#### `PUT /:id` — Update Task
- Partial update (merges with existing)
- If status changed, activity log says "moved to [status]"

#### `DELETE /:id` — Delete Task

### 3.6 Project Routes (`/api/projects`)

#### `GET /` — List Projects
- Optional: `status` filter
- Returns projects with `task_counts` per status: `{ todo: N, in_progress: N, review: N, done: N }`

#### `GET /:id` — Get Project with Tasks
- Returns project object with nested `tasks` array

#### `POST /` — Create Project
- Required: `{ name }`
- Optional: `description`, `status`

#### `PUT /:id` — Update Project
#### `DELETE /:id` — Delete Project
- Tasks with this `project_id` get `SET NULL` (not deleted)

### 3.7 Transcript Routes (`/api/transcripts`)

#### `GET /` — List/Search Transcripts
- Query params: `q` (full-text), `source`, `limit` (default 50), `offset`
- Returns `preview` (first 300 chars of raw_text) instead of full text for list view
- **Important:** When `q` is provided, also includes `location` in the SELECT fields

#### `GET /:id` — Get Full Transcript
- Returns complete object including full `raw_text`

#### `POST /` — Upload Transcript
- Required: `{ raw_text }`
- Auto-generates title from date if not provided
- **Dual write:** Also creates a `knowledge` entry (category: `transcript`) with the summary or first 2000 chars of raw_text. This ensures transcripts are searchable in the unified knowledge view.

#### `POST /bulk` — Bulk Upload
- Body: `{ transcripts: [...] }`
- Iterates and inserts each

#### `DELETE /:id` — Delete Transcript

### 3.8 Health Routes (`/api/healthdata`)

**Note:** Mounted at `/api/healthdata` (not `/api/health`) to avoid collision with `/api/health-check`.

#### `GET /metrics` — Query Metrics
- Params: `type`, `from`, `to`, `limit` (default 100), `offset`

#### `GET /metrics/types` — Summary by Type
- Returns: metric_type, unit, count, earliest, latest, avg_value

#### `POST /metrics` — Store Metrics
- Accepts single metric or `{ metrics: [...] }` array
- Required per item: `metric_type`, `value`, `unit`, `recorded_at`

#### `GET /workouts` — List Workouts
- Params: `type`, `from`, `to`, `limit` (default 50), `offset`

#### `GET /workouts/types` — Summary by Type
- Returns: workout_type, count, avg_duration, total_calories, total_distance

#### `POST /workouts` — Store Workouts
- Accepts single or `{ workouts: [...] }` array

#### `GET /workouts/:id` — Get Single Workout

### 3.9 Activity Log (`/api/activity`)

#### `GET /` — List Activity
- Params: `entity_type`, `ai_source`, `limit` (default 50), `offset`
- Ordered by `created_at DESC`

### 3.10 Dashboard (`/api/dashboard`)

#### `GET /` — Aggregated Stats
Returns a single object with 11 parallel queries:

```json
{
  "knowledge": {
    "total": 150,
    "by_category": [{ "category": "general", "count": 50 }, ...],
    "by_ai_source": [{ "ai_source": "claude", "count": 30 }, ...]
  },
  "projects": { "active": 5 },
  "tasks": {
    "by_status": { "todo": 10, "in_progress": 3, "review": 2, "done": 15 },
    "by_priority": { "low": 5, "medium": 12, "high": 6, "urgent": 2 },
    "by_agent": [{ "ai_agent": "claude", "count": 10 }, ...]
  },
  "transcripts": { "total": 200 },
  "health": { "total_metrics": 500, "total_workouts": 30 },
  "recent_activity": [/* last 15 activity_log entries */]
}
```

### 3.11 Unified Search (`/api/search`)

#### `GET /` — Search All Types
- Required: `q` param
- Runs 4 searches in parallel: knowledge, transcripts, tasks, projects
- Knowledge and transcripts use full-text search with ILIKE fallback
- Tasks and projects use ILIKE only
- Returns: `{ query, results: { knowledge, transcripts, tasks, projects }, total }`

#### `POST /ai` — AI-Optimized Search
- Body: `{ query, limit }`
- Same search logic but flattens results into a single array sorted by relevance
- Returns: `{ query, total, results: [...], summary: "Found X knowledge..." }`
- Intended for ChatGPT/Claude to call programmatically

### 3.12 Bee Integration (`/api/bee`) — The Largest Module

The Bee (by Amazon) is a wearable device that records conversations, extracts facts, and manages todos. This module proxies to the Bee Cloud API.

#### Bee Cloud API Details
- Base URL: `https://app-api-developer.ce.bee.amazon.dev`
- TLS: Uses a **private CA certificate** (embedded in source code). You must create an `https.Agent` with `ca: BEE_CA_CERT`.
- Auth: `Authorization: Bearer <token>` header
- Token source (priority): `X-Bee-Token` header → `req.body.bee_token` → `BEE_API_TOKEN` env var
- Response size guard: Rejects responses > 5 MB
- Timeout: 30 seconds per request
- Pagination: cursor-based (`?cursor=...`, response has `next_cursor`)

#### Bee API Endpoints Used
| Bee Endpoint | Purpose | Data Format |
|---|---|---|
| `GET /v1/me` | User profile (debug) | `{ ... }` |
| `GET /v1/facts[?cursor=]` | User's learned facts | `{ facts: [{ id, text, confirmed }], next_cursor }` |
| `GET /v1/todos[?cursor=]` | User's todo items | `{ todos: [{ id, text, completed }], next_cursor }` |
| `GET /v1/conversations?limit=N&created_after=DATE[&cursor=]` | Conversation list | `{ conversations: [{ id, summary, short_summary, state, start_time, end_time, speakers, primary_location, utterances_count, created_at }], next_cursor }` |
| `GET /v1/conversations/:id` | Full conversation detail | `{ conversation: { ..., transcriptions: [{ utterances: [{ speaker, text, start, spoken_at }], realtime }], summary, short_summary } }` |
| `GET /v1/journals[?cursor=]` | Journal entries | `{ journals: [...], next_cursor }` |
| `GET /v1/daily[?cursor=]` | Daily summaries | `{ daily: [...], next_cursor }` |
| `GET /v1/changes[?cursor=]` | Incremental change feed | `{ changes: [{ type, id }], next_cursor }` |
| `GET /v1/facts/:id` | Single fact detail | `{ fact: {...} }` |
| `GET /v1/todos/:id` | Single todo detail | `{ todo: {...} }` |
| `POST /v1/search` | Neural search | `{ results: [...] }` |

**Response parsing is defensive:** The `extractArray(data, primaryKey)` function tries `data[primaryKey]`, then `data.items`, `data.results`, `data.data`, then auto-detects the first array value.

#### AB Brain Bee Endpoints

**`GET /api/bee/status`** — Current sync status
- Returns counts of bee facts, tasks, transcripts, journals, daily summaries stored locally
- Indicates whether `BEE_API_TOKEN` is configured (auto-sync active)
- Returns timestamp of last import activity

**`GET /api/bee/counts`** — Live Bee API item counts
- Fetches first page of each type with `limit=1` to get totals

**`POST /api/bee/sync`** — Full sync (single request, blocks until done)
- Optional body: `{ force: true }` purges all bee data first
- Paginates through all facts, todos, conversations, journals, daily summaries
- For each conversation: fetches detail to get full transcript with utterances
- Deduplication: checks by content ILIKE (facts), title match (todos), metadata bee_id (conversations/journals/daily)
- Dual writes conversations: `transcripts` table AND `knowledge` table (category: `meeting`)

**`POST /api/bee/sync-chunk`** — Chunked sync (one page at a time)
- Body: `{ type: 'facts'|'todos'|'conversations'|'journals'|'daily', cursor, force }`
- Frontend calls this in a loop, advancing cursor until `done: true`
- Conversations limited to 5 per chunk (each requires a detail fetch)
- Returns: `{ imported, skipped, cursor, done, page_size, debug_keys, skip_reasons, date_range, errors }`
- **This is the primary sync method used by the frontend** — it allows progress reporting between chunks

**`POST /api/bee/sync-incremental`** — Delta sync via change feed
- Reads last cursor from `activity_log` (action: `bee-change-cursor`)
- Calls Bee `/v1/changes` API
- For each changed entity: fetches full detail, upserts into DB
- Updates cursor in `activity_log` for next run
- **This is the method used by the scheduled auto-sync** (runs every 30 min by default)

**`POST /api/bee/purge`** — Delete all bee data
- Deletes from knowledge (ai_source='bee'), tasks (ai_agent='bee'), transcripts (source='bee')

**`POST /api/bee/import`** — Import from JSON
- Body: `{ facts: [...], todos: [...], conversations: [...] }`
- Same dedup logic as sync

**`POST /api/bee/import-markdown`** — Import from markdown files
- Parses `facts_md` (lines starting with `- `), `todos_md` (lines with `- [ ]` or `- [x]`), and conversation markdown files

**`POST /api/bee/search`** — Neural search via Bee API
- Proxies to `POST /v1/search` on Bee Cloud API
- Cross-references results with local transcripts by matching `bee_id` in metadata
- Returns results with `local_transcript` link if found

**`GET /api/bee/test`** — Debug endpoint
- Tests Bee API connectivity, dumps raw response shapes

#### Transcript Text Extraction Logic

The `extractTranscript(detail, convoStartTime)` function extracts readable transcript text from Bee's conversation detail response:

1. Check `detail.transcriptions` array → prefer the non-realtime (finalized) transcription
2. From the transcription, extract `utterances`, sort by `start` time, limit to 1500 utterances
3. Format each as: `[HH:MM:SS AM] Speaker: text`
4. Timestamps calculated from `convoStartTime + utterance.start` (seconds offset) or `utterance.spoken_at`
5. Fallback: `detail.utterances`, then `detail.transcript`, `detail.full_transcript`, `detail.text`

#### Scheduled Auto-Sync

After DB init in `server.js`:
1. If `BEE_API_TOKEN` env var is set:
   - Run incremental sync 10 seconds after startup
   - Then repeat every `BEE_SYNC_INTERVAL` minutes (default: 30, configurable via env)
   - Calls its own `/api/bee/sync-incremental` endpoint internally via `http.request` to `127.0.0.1`

---

## 4. FRONTEND SPECIFICATION

### 4.1 Technology

- **Vanilla JavaScript** — no framework, no build step
- Single HTML file (`index.html`) + one CSS file (`styles.css`) + one JS file (`app.js`)
- Dark theme by default (background: `#0f1117`, text: `#e4e6f0`, accent: `#6366f1`)
- Mobile-first responsive design with bottom tab navigation
- PWA: Service worker (`sw.js`) + web manifest (`manifest.json`)
- iOS-optimized: `apple-mobile-web-app-capable`, safe area insets, no text size adjust

### 4.2 Authentication Flow

1. On page load, check `sessionStorage` then `localStorage` for `ab_api_key`
2. If no key found, show full-screen login overlay
3. On login: test key against `GET /api/dashboard`. If 401, show error. If success, store key.
4. "Remember me" checkbox → store in `localStorage` (persistent) vs. `sessionStorage` (tab only)
5. All API calls include `X-Api-Key` header via `api()` helper function
6. If any API call returns 401, redirect to login screen with "Session expired" message

### 4.3 Navigation & Views

Bottom tab bar with 6 tabs. Only one view visible at a time. CSS class `active` controls visibility.

| Tab | View ID | Load Function |
|-----|---------|---------------|
| Home | `view-dashboard` | `loadDashboard()` |
| Kanban | `view-kanban` | `loadKanban()` |
| Brain | `view-knowledge` | `loadKnowledge()` |
| Transcripts | `view-transcripts` | `loadTranscripts()` |
| Projects | `view-projects` | `loadProjects()` |
| Import | `view-import` | (static content + dynamic prompts) |

### 4.4 Dashboard View

Displays:
1. **Stats grid** (2 cols on mobile, 4 on desktop): Knowledge Entries, Transcripts, Total Tasks, In Progress, Active Projects, Workouts
2. **Tasks by Status** chart — horizontal bar chart (custom CSS, no chart library)
3. **Knowledge by AI Source** chart — horizontal bars with color-coded fills
4. **Tasks by Agent** chart — horizontal bars
5. **Recent Activity** — last 15 items from activity log, each showing action icon (+/~/x), description, AI source, and relative time

### 4.5 Kanban View

- 4 columns: To Do, In Progress, Review, Done
- Horizontal scroll with `scroll-snap-type: x mandatory` on mobile
- Column headers show count badge
- Cards show: title, priority badge (color-coded), AI agent badge, project name, truncated next_steps
- Project filter dropdown (fetched from `/api/projects`)
- Click card → opens edit modal (status, priority, ai_agent, next_steps, output_log)
- FAB (+) button → opens new task modal

### 4.6 Brain (Knowledge) View

- **Search bar** with enter-to-search
- **Source filter chips:** All Sources, claude, chatgpt, gemini, bee-sync (horizontal scroll)
- **Category filter chips:** dynamically loaded from `/api/knowledge/meta/categories`
- **Knowledge list:** cards with colored left border by category, showing:
  - AI source badge (color-coded: purple=claude, green=chatgpt, blue=gemini, yellow=bee)
  - Title, content preview (2-line clamp), category, relative time, tags
- Click item → opens detail/edit modal with all fields
- FAB (+) → new knowledge entry modal

### 4.7 Transcripts View

- Search bar with full-text search
- List items show: title, summary/preview, source, duration (minutes), relative time, location
- Yellow left border (category: transcript)
- Click → opens transcript detail modal with:
  - **Chat-bubble conversation view:** If raw_text has `Speaker: text` format, renders as iMessage-style chat bubbles
  - Speaker detection: `detectMySpeaker()` heuristic — speaker with most utterances = the Bee wearer (shown on right/blue bubbles)
  - Other speakers shown on left with border styling
  - Timestamps shown per message
  - "Show raw text" toggle to see unformatted transcript
  - Summary section if available
  - Location and duration metadata
  - Delete button

**Transcript parsing:** `parseTranscriptToMessages(rawText)` splits on newlines, regex matches `[timestamp] Speaker: text` or `Speaker: text` format.

### 4.8 Projects View

- List of project cards showing: name, description, task count dots (todo/in_progress/review/done), progress bar (% done)
- Click → edit modal (name, description, status)
- FAB (+) → new project modal

### 4.9 Import View

Three sections:

**1. Import AI Conversations**
- File drop zone (drag-and-drop or click-to-select)
- Source selector: ChatGPT, Claude, Generic JSON
- Progress bar and log during import
- **ChatGPT extraction:** Traverses `conv.mapping` nodes, sorts by `create_time`, extracts `content.parts` per message, formats as `**You/ChatGPT:** text`
- **Claude extraction:** Reads `chat_messages` or `messages` array, maps `sender` to `You`/`Claude`
- **Auto-categorization:** Keyword analysis on title+content to assign category (code, meeting, research, decision, general)
- Each conversation → stored as a knowledge entry with tags `[source-import, conversation]`

**2. Connect AI (Live)**
- Shows API key input (stays in browser)
- **ChatGPT card:** Step-by-step instructions for creating Custom GPT with Actions. Links to OpenAPI spec URL. Copy-able instruction prompt.
- **Claude card:** Instructions for pasting into Project Instructions. Copy-able prompt.
- **Gemini card:** Import-only instructions (Gemini cannot make outbound API calls). Google Takeout instructions.
- **Bee Wearable card:** Shows sync status, manual sync buttons, file upload for bee-sync exports, JSON paste option

**3. Bee Cloud Sync UI**
- Status indicator: auto-sync active/off, data counts, last sync time
- "Sync Updates Only" button → calls `/api/bee/sync-incremental`
- "Sync All New (chunked)" button → loops `/api/bee/sync-chunk` for all 5 types with progress bar
- "Full Sync (purge & re-import)" button → confirms, purges, then full chunked sync
- "Upload bee-sync files" → reads .md/.json files, sends to import endpoints
- "Paste Bee JSON data" → prompt for JSON, auto-detects type
- Progress reporting: 5-phase weighted progress bar (facts: 5%, todos: 5%, conversations: 70%, journals: 10%, daily: 10%)

### 4.10 Global Search (Ctrl+K / Cmd+K)

- Full-screen overlay with search input
- 300ms debounce, minimum 2 characters
- Calls `GET /api/search?q=term`
- Results grouped by type: Knowledge, Transcripts, Tasks, Projects — each with icon
- Click result → closes search, navigates to detail modal
- **Bonus:** After local search completes, also fires `POST /api/bee/search` in background for neural search results (appended with "Bee Neural" group label)

### 4.11 Pull-to-Refresh

- Touch gesture detection on `.views-container`
- Threshold: 80px pull distance
- Shows animated refresh indicator at top
- Calls `refreshCurrentView()` which reloads the current tab's data

### 4.12 Auto-Refresh

- On `visibilitychange` (tab switch back / app resume), if >30 seconds since last refresh, reload current view
- Prevents stale data on mobile where the PWA sits in background

### 4.13 Service Worker

- Cache name: `abkb-v2`
- Caches app shell: `/`, `/styles.css`, `/app.js`, `/manifest.json`
- Strategy: **Cache-first** for static assets (with background update), **network-only** for `/api/*` calls
- Installs immediately (`skipWaiting`), claims clients on activate

### 4.14 OpenAPI Spec for ChatGPT

A `public/openapi-chatgpt.json` file defines the API in OpenAPI 3.1 format for ChatGPT Custom GPT Actions. It documents endpoints for knowledge CRUD, task CRUD, project CRUD, transcript search/upload, health metrics, dashboard, and unified search — all with the `X-Api-Key` security scheme.

---

## 5. ENVIRONMENT VARIABLES

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server listen port |
| `API_KEY` | Yes (prod) | None | Static API key for authentication |
| `DATABASE_URL` | Yes | None | PostgreSQL connection string. Railway provides this automatically. SSL auto-enabled for non-localhost URLs. |
| `BEE_API_TOKEN` | No | None | Bee wearable API token for automatic cloud sync. Obtained by running `bee login` on Mac then reading `~/.bee/token-prod`. |
| `BEE_SYNC_INTERVAL` | No | `30` | Minutes between automatic Bee sync runs |

---

## 6. SCRIPTS & UTILITIES

### 6.1 `scripts/import-chatgpt.js`
CLI script to bulk-import ChatGPT conversations from `conversations.json` directly into the database (bypasses the API). Reads `DATABASE_URL` from env.

### 6.2 `scripts/bee-live-sync.js`
Node.js script for syncing Bee data from the local `~/.bee` directory on a Mac. Runs as a cron job. Reads facts, todos, and recent conversations from the Bee CLI's local cache.

### 6.3 `scripts/bee-to-brain-sync.sh`
Bash wrapper script for Bee sync. Supports `--only facts|todos|convos` and `--recent-days N` flags. Can be scheduled via cron.

### 6.4 `scripts/com.abbrain.bee-sync.plist`
macOS LaunchAgent plist file for scheduling `bee-live-sync.js` to run automatically on Mac.

---

## 7. KEY DESIGN DECISIONS & IMPLEMENTATION NOTES

### 7.1 No Framework Frontend
The entire frontend is vanilla JS with DOM manipulation via `innerHTML`. No React, Vue, or any framework. This keeps the bundle tiny (~67KB JS, ~21KB CSS, ~21KB HTML) and eliminates build tooling. The tradeoff is verbose DOM code and XSS-safe string escaping via a manual `esc()` function.

### 7.2 Dual-Write Pattern for Transcripts
Every transcript is written to BOTH `transcripts` (with full raw_text) AND `knowledge` (with summary/truncated text). This ensures the unified search and Brain view include transcript content without needing cross-table queries.

### 7.3 Full-Text Search with Fallback
PostgreSQL `to_tsvector` + `plainto_tsquery` is the primary search mechanism for knowledge and transcripts. If it returns zero results (common with short/unusual terms), falls back to `ILIKE %term%`. Tasks and projects use ILIKE only.

### 7.4 Chunked Bee Sync
The initial design had a single `/sync` endpoint that would block for minutes. The chunked approach (`/sync-chunk`) lets the frontend drive pagination, show real-time progress, and survive Railway's request timeouts. Conversations are limited to 5 per chunk because each requires a separate API call to Bee for the full transcript.

### 7.5 Incremental Sync via Change Feed
The Bee `/v1/changes` API returns a stream of entity-level changes since a cursor. The cursor is stored in `activity_log` (not a separate table). This enables efficient periodic sync — the scheduled auto-sync only processes new/modified items.

### 7.6 Activity Log as Audit Trail + State Store
The `activity_log` table serves dual purposes: user-visible audit trail AND system state storage (Bee sync cursors). Any action by any AI or the user creates a log entry.

### 7.7 Custom CA Certificate for Bee API
Bee (now owned by Amazon) uses a private Certificate Authority. The root CA certificate is embedded directly in the source code and passed to Node's `https.Agent`. Without this, all Bee API calls would fail with TLS errors.

### 7.8 Project-Task Relationship
Tasks have an optional `project_id` FK with `ON DELETE SET NULL`. Deleting a project orphans its tasks rather than cascading deletion. The frontend shows this as "None" in the project dropdown.

### 7.9 Mobile PWA Optimization
- Bottom nav bar with safe-area padding for iPhone notch
- `overscroll-behavior: none` prevents bounce scrolling
- `scroll-snap-type` for horizontal Kanban scrolling
- `100dvh` for proper viewport on mobile browsers
- Pull-to-refresh gesture detection
- Auto-refresh on app resume (visibility change)

---

## 8. REBUILD RECOMMENDATIONS

If rebuilding this application from scratch:

1. **Start with the database schema** (Section 2). Run the exact `CREATE TABLE` and `CREATE INDEX` statements. The `knowledge` table is central — everything cross-references it.

2. **Build the API layer next** (Section 3). The routes are stateless REST — any framework works. The key complexity is in the Bee integration (Section 3.12). Start with knowledge, tasks, projects, then add transcripts, health, and Bee last.

3. **The Bee integration is 55KB of code** for a reason — the Bee Cloud API has undocumented quirks:
   - Response shapes vary (sometimes array, sometimes `{ items: [...] }`, sometimes `{ facts: [...] }`)
   - The `extractArray()` function handles all variants
   - Conversation transcripts require a second API call per conversation
   - The private CA cert is mandatory
   - Rate limiting may apply — the 5-per-chunk limit on conversations is deliberate

4. **The frontend can be rebuilt in any framework** (React, Vue, etc.) but preserve:
   - The bottom-tab navigation pattern (not sidebar — this is phone-first)
   - The chat-bubble transcript viewer with speaker detection
   - The Ctrl+K global search overlay
   - The chunked sync progress UI for Bee imports
   - The inline AI connection instructions with copyable prompts

5. **The OpenAPI spec** (`openapi-chatgpt.json`) must be kept in sync with the API. ChatGPT fetches it during Custom GPT setup.

6. **Test with real Bee data.** The user has daily summaries, locations, and transcription details dating back to December 26, 2025. The system must handle hundreds of conversations with full utterance-level transcripts.
