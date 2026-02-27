# AB Knowledge Base — Unified AI Brain

A central platform that connects all your AIs (Claude, Gemini, ChatGPT, Bee.computer) to a shared PostgreSQL database. Your AIs can store and retrieve knowledge, you can track tasks and projects via a mobile-friendly dashboard with Kanban boards and charts, and all your Bee.computer transcripts and Apple Health data live in one searchable place.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  YOUR PHONE                      │
│         Mobile Web Dashboard (PWA-ready)          │
│  ┌──────┬──────┬───────┬────────┬──────────┐     │
│  │ Home │Kanban│ Brain │Transcr.│ Projects │     │
│  └──────┴──────┴───────┴────────┴──────────┘     │
└─────────────────┬───────────────────────────────┘
                  │ HTTPS
┌─────────────────▼───────────────────────────────┐
│              Express.js API Server               │
│                 (Railway)                         │
│  ┌─────────────────────────────────────────┐     │
│  │  /api/knowledge  — shared AI memory     │     │
│  │  /api/tasks      — task management      │     │
│  │  /api/projects   — project tracking     │     │
│  │  /api/transcripts— Bee transcripts      │     │
│  │  /api/health     — Apple Health data    │     │
│  │  /api/dashboard  — aggregated stats     │     │
│  │  /api/activity   — audit log            │     │
│  └─────────────────────────────────────────┘     │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│         PostgreSQL (Railway managed)             │
│                                                   │
│  knowledge    — everything your AIs know          │
│  projects     — project containers                │
│  tasks        — work items with Kanban status     │
│  transcripts  — Bee.computer raw transcripts      │
│  health_metrics — Apple Health vitals             │
│  workouts     — Apple Health workout history      │
│  activity_log — full audit trail                  │
└─────────────────────────────────────────────────┘

         ▲              ▲              ▲
    Claude API     Gemini API     ChatGPT API
    (read/write)   (read/write)   (read/write)
```

## How Your AIs Connect

Each AI can call the REST API with your API key. Here's what you tell them:

### At the START of a conversation — "Load my knowledge base"

Tell your AI:
> Access my knowledge base at https://your-app.railway.app/api/knowledge?q=TOPIC
> Use header X-Api-Key: YOUR_KEY

The AI makes a GET request and receives relevant knowledge entries.

### During or at the END — "Save this to my knowledge base"

Tell your AI:
> Store this in my knowledge base by POSTing to https://your-app.railway.app/api/knowledge
> with X-Api-Key header

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

### Claude Co-Work Task Updates

Claude can push task status updates directly:

```json
POST /api/tasks
{
  "title": "Refactor authentication module",
  "description": "Moving from JWT to session-based auth",
  "project_id": "uuid-of-project",
  "status": "in_progress",
  "priority": "high",
  "ai_agent": "claude",
  "next_steps": "1. Update middleware\n2. Migrate session store\n3. Update tests"
}
```

### Bee.computer Transcript Upload

```json
POST /api/transcripts
{
  "title": "Client meeting Feb 27",
  "raw_text": "Full transcript text here...",
  "summary": "Discussed Q1 targets and product roadmap",
  "source": "bee",
  "tags": ["client", "quarterly"],
  "recorded_at": "2026-02-27T14:00:00Z"
}
```

### Apple Health Data

```json
POST /api/health/metrics
{
  "metrics": [
    { "metric_type": "heart_rate", "value": 72, "unit": "bpm", "recorded_at": "2026-02-27T08:00:00Z" },
    { "metric_type": "steps", "value": 8542, "unit": "count", "recorded_at": "2026-02-27T23:59:00Z" }
  ]
}

POST /api/health/workouts
{
  "workouts": [
    {
      "workout_type": "running",
      "duration_minutes": 32,
      "calories_burned": 320,
      "distance_km": 5.2,
      "avg_heart_rate": 155,
      "started_at": "2026-02-27T06:30:00Z"
    }
  ]
}
```

## Deploy to Railway + GitHub

### Step 1: Push to GitHub
```bash
git remote add origin https://github.com/YOUR_USER/ABKnowledgeBase.git
git push -u origin main
```

### Step 2: Deploy on Railway
1. Go to [railway.app](https://railway.app) and create a new project
2. Select "Deploy from GitHub repo" and pick ABKnowledgeBase
3. Add a PostgreSQL database: Click "+ New" → "Database" → "PostgreSQL"
4. Railway automatically sets `DATABASE_URL` — no config needed
5. Add environment variable: `API_KEY` = (generate a strong random string)
6. Deploy — Railway builds from the Dockerfile automatically

### Step 3: Access
- Dashboard: `https://your-app.railway.app`
- API: `https://your-app.railway.app/api`

## API Reference

All endpoints accept/return JSON. Authenticate with `X-Api-Key` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge?q=search` | Search knowledge (full-text) |
| GET | `/api/knowledge?category=meeting` | Filter by category |
| POST | `/api/knowledge` | Store knowledge entry |
| PUT | `/api/knowledge/:id` | Update entry |
| DELETE | `/api/knowledge/:id` | Delete entry |
| GET | `/api/tasks/kanban` | Get tasks in Kanban format |
| GET | `/api/tasks?status=in_progress` | Filter tasks |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:id` | Update task status/details |
| GET | `/api/projects` | List projects with task counts |
| POST | `/api/projects` | Create project |
| GET | `/api/transcripts?q=search` | Search transcripts |
| POST | `/api/transcripts` | Upload transcript |
| POST | `/api/transcripts/bulk` | Bulk upload transcripts |
| GET | `/api/health/metrics?type=heart_rate` | Query health metrics |
| POST | `/api/health/metrics` | Store health metrics (single/batch) |
| GET | `/api/health/workouts` | List workouts |
| POST | `/api/health/workouts` | Store workouts (single/batch) |
| GET | `/api/dashboard` | Aggregated stats for all data |
| GET | `/api/activity` | Activity/audit log |
| GET | `/api/health-check` | Server health check |

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start local Postgres (or use Docker)
docker run -d --name abkb-postgres -p 5432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=abknowledgebase postgres:16

# 3. Set environment
export DATABASE_URL=postgresql://postgres:dev@localhost:5432/abknowledgebase

# 4. Start server
npm run dev
```

## No n8n Needed

This app IS the integration layer. Your AIs call it directly via HTTP. No middleware needed. If you later want workflow automation (e.g., auto-summarize transcripts, scheduled health reports), you can add n8n/Zapier on top, but the core platform works standalone.
