# AB Brain — Notion Setup Guide

## Overview

AB Brain is an AI-to-Notion gateway. Your AIs (Claude, ChatGPT, Gemini, Bee) call the REST API, and the app files everything into your Notion workspace — automatically organized with AI-powered classification.

```
Claude / ChatGPT / Gemini / Bee
        ↓
   AB Brain API  ←→  Claude Haiku (classification)
        ↓
   Notion Workspace
   ├── Knowledge (facts, research, notes)
   ├── Tasks (todos, action items)
   ├── Projects (grouping for tasks)
   ├── Transcripts (Bee conversations, meeting notes)
   ├── Health Metrics (Apple Health)
   ├── Workouts (Apple Health)
   └── Activity Log (audit trail)
```

## Step 1: Create a Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **"+ New integration"**
3. Name it `AB Brain`
4. Select your workspace
5. Under **Capabilities**, enable:
   - Read content
   - Update content
   - Insert content
6. Click **Save**
7. Copy the **"Internal Integration Secret"** (starts with `ntn_`)

## Step 2: Create a Parent Page in Notion

1. Open Notion
2. Create a new page called **"AB Brain"** (or whatever you want)
3. This page will contain all 7 databases
4. **Share it with your integration:**
   - Click the `...` menu on the page
   - Click **"Connections"** → **"Connect to"** → find **"AB Brain"**
   - Click **"Confirm"**
5. Copy the **page ID** from the URL:
   - URL looks like: `https://notion.so/AB-Brain-abc123def456...`
   - The page ID is the 32-character hex string: `abc123def456...`
   - Remove any dashes: `abc123def456789...`

## Step 3: Set Environment Variables

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Fill in these required values:

```bash
# Your API key (any random string — this secures your API)
API_KEY=generate-a-random-string-here

# Notion integration token from Step 1
NOTION_TOKEN=ntn_your-token-here

# OpenAI API key for smart intake (from platform.openai.com)
OPENAI_API_KEY=sk-your-key-here
```

## Step 4: Start the Server

```bash
npm install
npm run dev
```

You should see:
```
AB Brain (Notion backend) running on port 3000
Notion client initialized
```

## Step 5: Create the Databases

Run the setup endpoint with your page ID from Step 2:

```bash
curl -X POST http://localhost:3000/api/setup \
  -H "Content-Type: application/json" \
  -d '{"parent_page_id": "your-page-id-from-step-2"}'
```

This creates all 7 databases in your Notion page. The response gives you the database IDs:

```json
{
  "message": "Notion databases created successfully!",
  "databases": {
    "knowledge": "abc...",
    "tasks": "def...",
    "projects": "ghi...",
    "transcripts": "jkl...",
    "health_metrics": "mno...",
    "workouts": "pqr...",
    "activity_log": "stu..."
  }
}
```

## Step 6: Save the Database IDs

Add the returned IDs to your `.env` file:

```bash
NOTION_DB_KNOWLEDGE=abc...
NOTION_DB_TASKS=def...
NOTION_DB_PROJECTS=ghi...
NOTION_DB_TRANSCRIPTS=jkl...
NOTION_DB_HEALTH_METRICS=mno...
NOTION_DB_WORKOUTS=pqr...
NOTION_DB_ACTIVITY_LOG=stu...
```

Restart the server. You're done!

## Step 7: Test It

### Smart Intake (AI auto-files)

Send any raw input — Claude Haiku classifies and files it:

```bash
curl -X POST http://localhost:3000/api/intake \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-api-key" \
  -d '{
    "input": "Need to buy groceries: milk, eggs, bread. Also schedule dentist appointment for next Tuesday.",
    "source": "manual"
  }'
```

Response:
```json
{
  "message": "Filed successfully",
  "classification": {
    "database": "tasks",
    "title": "Buy groceries and schedule dentist",
    "tags": ["groceries", "errands", "dentist"],
    "priority": "medium",
    "status": "todo"
  }
}
```

### Direct API (explicit filing)

```bash
# Store knowledge
curl -X POST http://localhost:3000/api/knowledge \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-api-key" \
  -d '{"title": "Meeting notes", "content": "Discussed Q2 goals...", "category": "meeting", "ai_source": "claude"}'

# Create a task
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-api-key" \
  -d '{"title": "Review PR #42", "priority": "high", "ai_agent": "claude"}'

# Search everything
curl "http://localhost:3000/api/search?q=meeting" \
  -H "X-Api-Key: your-api-key"
```

## How Your AIs Should Use It

### Claude / Gemini
Call the API directly via HTTP. Use `POST /api/intake` for auto-filing, or the specific endpoints for explicit control.

### ChatGPT
Use the OpenAPI spec at `/openapi.json` to set up a Custom Action/Plugin. ChatGPT can then call the API as a tool.

### Bee.computer
Set `BEE_API_TOKEN` in your env vars. The server auto-syncs Bee data every 30 minutes.

## Notion Workspace Organization

After setup, your Notion page will have these databases with these views available:

| Database | Notion View Suggestions |
|----------|------------------------|
| Knowledge | Table view filtered by category, Gallery view for browsing |
| Tasks | Board view (Kanban by Status), Table filtered by priority |
| Projects | Table view filtered by status |
| Transcripts | Timeline view by Recorded At, Table filtered by source |
| Health Metrics | Table filtered by metric type |
| Workouts | Calendar view by Started At |
| Activity Log | Table sorted by Created At (audit trail) |

You can customize these views directly in Notion — add filters, sorts, groupings, and create as many views as you want.

## Deployment (Railway)

```bash
# Set these env vars in Railway dashboard:
API_KEY=your-strong-random-key
NOTION_TOKEN=ntn_your-token
OPENAI_API_KEY=sk-your-openai-key
NOTION_DB_KNOWLEDGE=...
NOTION_DB_TASKS=...
NOTION_DB_PROJECTS=...
NOTION_DB_TRANSCRIPTS=...
NOTION_DB_HEALTH_METRICS=...
NOTION_DB_WORKOUTS=...
NOTION_DB_ACTIVITY_LOG=...

# Optional:
BEE_API_TOKEN=your-bee-token
SYNC_INTERVAL=30
```

Push to GitHub and Railway auto-deploys from the Dockerfile. No PostgreSQL needed.
