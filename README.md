# AB Brain — Unified AI Knowledge Base

A personal knowledge management platform that gives all your AI assistants (Claude, ChatGPT, Gemini) and your Bee wearable a shared memory. Your AIs read and write to a central PostgreSQL database via REST API, with an optional one-way mirror to Notion for browsing. You manage everything from a mobile-friendly PWA dashboard.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  YOUR PHONE                      │
│           Mobile Web Dashboard (PWA)             │
│  ┌──────┬──────┬───────┬────────┬──────────┐    │
│  │ Home │Kanban│ Brain │Transcr.│ Projects │    │
│  └──────┴──────┴───────┴────────┴──────────┘    │
└─────────────────┬───────────────────────────────┘
                  │ HTTPS
┌─────────────────▼───────────────────────────────┐
│              Express.js API Server               │
│                 (Railway)                         │
│                                                   │
│  /api/knowledge    — shared AI memory             │
│  /api/tasks        — Kanban task management       │
│  /api/projects     — project containers           │
│  /api/transcripts  — Bee transcripts              │
│  /api/facts        — extracted personal facts     │
│  /api/conversations— full AI chat threads         │
│  /api/intake       — AI-powered auto-filing       │
│  /api/bee          — Bee wearable sync            │
│  /api/search       — unified cross-type search    │
│  /api/dashboard    — aggregated stats             │
│  /api/activity     — audit trail                  │
└─────────┬───────────────────┬───────────────────┘
          │                   │
┌─────────▼─────────┐  ┌─────▼──────────────────┐
│   PostgreSQL 16    │  │   Notion (optional)     │
│  (Railway-managed) │  │   Read-only mirror      │
│                    │  │   One-way sync →         │
│  8 tables          │  │   Browse in Notion app  │
│  Full-text search  │  └────────────────────────┘
│  tsvector + trgm   │
└────────────────────┘

         ▲              ▲              ▲
    Claude API     ChatGPT API     Gemini
    (read/write)   (Custom GPT)    (import-only)
```

## How It Works

### Your AIs Connect via REST API

Each AI calls the AB Brain API with your API key.

**Load context at the start of a conversation:**
```
GET /api/knowledge?q=TOPIC
Header: X-Api-Key: YOUR_KEY
```

**Save knowledge back:**
```json
POST /api/knowledge
{
  "title": "Meeting notes from standup",
  "content": "We decided to migrate to PostgreSQL...",
  "category": "meeting",
  "tags": ["standup", "database"],
  "ai_source": "claude"
}
```

### Smart Intake — AI Auto-Filing

Throw any raw text at it. GPT-4o-mini classifies and files it automatically.

```json
POST /api/intake
{
  "input": "Need to buy groceries and schedule dentist for Tuesday",
  "source": "claude"
}
// -> Auto-classified as task, priority: medium, tagged: [groceries, errands, dentist]
```

### Conversation Distillation

Extract structured insights from a full AI conversation:

```json
POST /api/intake/distill
{
  "title": "Planning session with Claude",
  "content": "Full conversation text...",
  "source": "claude"
}
// -> Extracts facts, decisions, and action items into separate tables
```

### Bee Wearable Auto-Sync

The Bee (by Amazon) records real-world conversations. AB Brain syncs automatically:
- Facts the Bee learns about you
- Todos extracted from conversations
- Full conversation transcripts with speaker-by-speaker utterances
- Journal entries and daily summaries

Sync runs every 30 minutes when `BEE_API_TOKEN` is configured.

### Notion Mirror (Optional)

When `NOTION_TOKEN` is configured, a background sync pushes data one-way from PostgreSQL to Notion. This lets you browse your data in the Notion app with its built-in views and filters. PostgreSQL remains the source of truth.

### ChatGPT Custom GPT

An OpenAPI spec is served at `/openapi.json` for creating a ChatGPT Custom GPT that calls your API as an Action.

## Deploy to Railway

### Step 1: Push to GitHub & Deploy

```bash
git remote add origin https://github.com/YOUR_USER/ABKnowledgeBase.git
git push -u origin main
```

On [railway.app](https://railway.app):
1. Create a new project -> "Deploy from GitHub repo" -> pick ABKnowledgeBase
2. Add a PostgreSQL database: Click "+ New" -> "Database" -> "PostgreSQL"
3. Railway automatically sets `DATABASE_URL` — no config needed
4. Deploy — Railway builds from the Dockerfile automatically

### Step 2: Set Environment Variables

In Railway dashboard, add:

```
API_KEY=<generate-a-strong-random-string>
OPENAI_API_KEY=sk-your-openai-key
```

### Step 3: (Optional) Enable Bee Sync

```
BEE_API_TOKEN=your-bee-token
BEE_SYNC_INTERVAL=30
```

Get the token by running `bee login` on a Mac, then reading `~/.bee/token-prod`.

### Step 4: (Optional) Enable Notion Mirror

```
NOTION_TOKEN=ntn_your-notion-integration-secret
NOTION_DB_KNOWLEDGE=...
NOTION_DB_FACTS=...
NOTION_DB_TASKS=...
NOTION_DB_PROJECTS=...
NOTION_DB_TRANSCRIPTS=...
NOTION_DB_ACTIVITY_LOG=...
```

### Step 5: Access

- Dashboard: `https://your-app.railway.app`
- API: `https://your-app.railway.app/api`

## API Reference

All endpoints accept/return JSON. Authenticate with `X-Api-Key` header.

### Core Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge?q=search` | Full-text search knowledge |
| GET | `/api/knowledge?category=meeting` | Filter by category |
| POST | `/api/knowledge` | Store knowledge entry |
| PUT | `/api/knowledge/:id` | Update entry |
| DELETE | `/api/knowledge/:id` | Delete entry |
| GET | `/api/knowledge/meta/categories` | List distinct categories |

### Tasks & Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks?status=in_progress` | Filter tasks |
| GET | `/api/tasks/kanban` | Get tasks grouped by Kanban column |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| GET | `/api/projects` | List projects with task counts |
| POST | `/api/projects` | Create project |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |

### Transcripts & Facts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/transcripts?q=search` | Full-text search transcripts |
| GET | `/api/transcripts/:id` | Get full transcript with utterances |
| POST | `/api/transcripts` | Upload transcript |
| POST | `/api/transcripts/bulk` | Bulk upload |
| DELETE | `/api/transcripts/:id` | Delete transcript |
| GET | `/api/facts` | List/search facts |
| POST | `/api/facts` | Create fact |
| PUT | `/api/facts/:id` | Update fact |
| DELETE | `/api/facts/:id` | Delete fact |

### Conversations (AI Chat Threads)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/conversations` | List/search conversations |
| GET | `/api/conversations/:id` | Get full conversation thread |
| POST | `/api/conversations` | Store conversation |
| PUT | `/api/conversations/:id` | Update conversation |
| DELETE | `/api/conversations/:id` | Delete conversation |

### Smart Intake

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/intake` | AI auto-classify and file any input |
| POST | `/api/intake/batch` | Batch auto-classify multiple items |
| POST | `/api/intake/distill` | Extract facts/decisions/tasks from a conversation |

### Bee Wearable

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bee/status` | Current sync status and counts |
| GET | `/api/bee/counts` | Live Bee API item counts |
| POST | `/api/bee/sync` | Full sync (blocks until done) |
| POST | `/api/bee/sync-chunk` | Chunked sync (one page at a time) |
| POST | `/api/bee/sync-incremental` | Delta sync via change feed |
| POST | `/api/bee/purge` | Delete all bee data |
| POST | `/api/bee/import` | Import from JSON |
| POST | `/api/bee/search` | Neural search via Bee API |

### Search & Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=term` | Search across all types |
| POST | `/api/search/ai` | AI-optimized flattened search |
| GET | `/api/dashboard` | Aggregated stats |
| GET | `/api/activity` | Activity/audit log |
| GET | `/api/sync-status` | Sync source states and job history |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health-check` | Server health (no auth) |
| GET | `/openapi.json` | OpenAPI spec for ChatGPT Actions (no auth) |

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start local Postgres
docker run -d --name abkb-postgres -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=abknowledgebase postgres:16

# 3. Set environment
export DATABASE_URL=postgresql://postgres:dev@localhost:5432/abknowledgebase
export API_KEY=dev-key
export OPENAI_API_KEY=sk-your-key

# 4. Start server with auto-reload
npm run dev
```

Tables are created automatically on first startup.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server listen port |
| `API_KEY` | Yes (prod) | None | Static API key for authentication |
| `DATABASE_URL` | Yes | None | PostgreSQL connection string (Railway provides automatically) |
| `OPENAI_API_KEY` | Yes | None | OpenAI key for smart intake (GPT-4o-mini) |
| `BEE_API_TOKEN` | No | None | Bee wearable API token for auto-sync |
| `BEE_SYNC_INTERVAL` | No | `30` | Minutes between automatic Bee syncs |
| `NOTION_TOKEN` | No | None | Notion integration secret (enables mirror sync) |
| `NOTION_DB_*` | No | None | Notion database IDs (6 total, for mirror sync) |

## What's a PWA?

AB Brain is a **Progressive Web App**. Open the URL in your phone's browser and tap "Add to Home Screen." It installs like a native app — launches full-screen, has its own icon, works offline for cached pages, and auto-refreshes when you switch back to it. No app store needed.

## Future Roadmap

- **People directory** — Track who you talk to, link conversations to people
- **AI conversation archive** — Full ChatGPT/Claude conversation storage with chat-bubble UI
- **Health & fitness** — Import workout and health data (Fitbod, Strava, Apple Health)
- **AI query endpoints** — Single fast endpoint for AIs to search your entire knowledge base
- **Security** — Proper authentication beyond static API key
- **Backup** — Automated PostgreSQL exports
- **Cost tracking** — Monitor AI API spend across providers
