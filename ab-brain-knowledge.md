# AB Brain — Knowledge File for Claude Projects

> **Version:** 1.6.0 | **Last Updated:** 2026-04-01
> **Base URL:** `https://ab-brain.up.railway.app`
> **Auth:** `X-Api-Key: ab-brain-x7kP9mQ2wR4tY8` (header on every request)

---

## Known Bugs

### `GET /api/exercises/available` — DO NOT CALL
- **Status:** Broken (SQL binding error: "bind message supplies 1 parameters, but prepared statement requires 0")
- **Workaround:**
  1. `GET /api/gym-profiles/primary` → get the equipment list from the response
  2. `GET /api/exercises?equipment=<type>` for each equipment type → filter results to exercises matching your equipment

---

## API Reference

### Morning Briefing
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/briefing` | Complete morning briefing as markdown. Optional `?date=YYYY-MM-DD` (defaults to today). Returns smart-ranked tasks, recovery, rings/streaks, stale alerts, yesterday recap, today's plan. |

### Tasks
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks. Filters: `status`, `priority`, `ai_agent`, `context`, `waiting_on` |
| GET | `/api/tasks/kanban` | Tasks grouped by status for kanban board |
| GET | `/api/tasks/:id` | Single task with activity history and comments |
| POST | `/api/tasks` | Create task |
| PUT | `/api/tasks/:id` | Update task (status, priority, due_date, ai_agent, etc.) |
| DELETE | `/api/tasks/:id` | Delete task |

### Daily Plans
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/daily-plans` | List daily plans (date, status filters) |
| GET | `/api/daily-plans/by-date/:date` | Plan + actuals for a date with ring progress |

### Knowledge Base
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/knowledge` | Search/list. Filters: `q`, `category`, `tag`, `ai_source` |
| GET | `/api/knowledge/meta/categories` | Distinct categories |
| GET | `/api/knowledge/:id` | Single entry |
| POST | `/api/knowledge` | Create |
| PUT | `/api/knowledge/:id` | Update |
| DELETE | `/api/knowledge/:id` | Delete |

### Workouts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workouts` | List/search. Filters: `q`, `workout_type`, `tag`, `since`, `before`, `sort` |
| GET | `/api/workouts/:id` | Single workout with exercise details |
| POST | `/api/workouts` | Create |
| PUT | `/api/workouts/:id` | Update |
| DELETE | `/api/workouts/:id` | Delete |

### Meals & Nutrition
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/meals` | List/search. Filters: `q`, `meal_type`, `date`, `since`, `before` |
| POST | `/api/meals` | Create |
| PATCH | `/api/meals/:id` | Update |
| DELETE | `/api/meals/:id` | Delete |
| GET | `/api/meals/stats/daily` | Daily nutrition totals |
| GET | `/api/meals/stats/weekly` | Weekly nutrition stats |
| GET | `/api/nutrition/daily-context` | Daily context (sleep, hydration) |
| POST | `/api/nutrition/daily-context` | Create daily context |

### Recovery & Fitness
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/recovery/*` | Recovery scoring, muscle readiness |
| GET | `/api/body-metrics` | Body metrics. Filters: `source`, `since`, `before`, `latest` |
| POST | `/api/body-metrics` | Create body metric |
| GET | `/api/body-metrics/stats/summary` | Aggregate stats |

### Exercises & Gym Profiles
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/exercises` | List/search. Filters: `q`, `level`, `equipment`, `category`, `muscle_group` |
| GET | `/api/exercises/equipment` | Equipment list with exercise counts |
| GET | `/api/gym-profiles` | All gym profiles |
| GET | `/api/gym-profiles/primary` | Active/primary gym profile |
| POST | `/api/gym-profiles` | Create profile |
| PUT | `/api/gym-profiles/:id` | Update profile |

### Coaching & Injuries
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/training/coaching` | List coaching sessions |
| POST | `/api/training/coaching` | Create coaching session |
| GET/POST/PUT/DELETE | `/api/training/injuries/*` | Injury tracking CRUD |

### Agents (Jarvis System)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents. Filter: `?status=` |
| GET | `/api/agents/:id` | Agent detail with assigned tasks and activity |
| POST | `/api/agents` | Create agent |
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |
| POST | `/api/agents/seed` | Seed founding team (idempotent) |
| GET | `/api/agents/org/chart` | Org chart hierarchy |
| GET | `/api/agents/work/dashboard` | Work board grouped by agent |

### Conversations & Transcripts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List/search. Filters: `q`, `ai_source`, `limit`, `offset` |
| POST | `/api/conversations` | Create |
| POST | `/api/conversations/import/chatgpt` | Bulk import ChatGPT exports |
| GET | `/api/transcripts` | List/search. Filters: `q`, `source`, `status`, `content_type`, `speaker` |

### Search & Intake
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search` | Global full-text search across all entities |
| POST | `/api/intake` | Smart intake — AI auto-classifies raw input into knowledge/tasks/transcripts |

### Gamification
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/gamification/*` | Badges, streaks, rings, notifications |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health-check` | Status, version, backend type |
| GET | `/api/dashboard` | Aggregate stats across all entities |
| GET | `/api/activity` | Activity log. Filters: `entity_type`, `ai_source`, `limit` |
| GET | `/api/sync-status` | Sync status across all data sources |

---

## Smart Task Ranking Algorithm

Used in the morning briefing and Today view to surface the 3 most important tasks:

| Factor | Condition | Points |
|--------|-----------|--------|
| **Priority** | urgent | 40 |
| | high | 30 |
| | medium | 20 |
| | low | 10 |
| **Due Date** | overdue | +50 |
| | due today | +30 |
| | due this week | +15 |
| | no date / future | +5 |
| **Staleness** | >14 days untouched | +15 |
| | >7 days untouched | +10 |
| **Waiting Duration** | waiting >5 days | +10 |
| | waiting >3 days | +5 |

Tasks are sorted by total score descending. Top 3 shown as "Focus" items.

---

## Agent Roster (Jarvis System)

| Codename | Name | Role | Emoji |
|----------|------|------|-------|
| Jarvis | Jarvis | Chief of Staff | 🦊 |
| Cascade | Cascade | HR & Culture | 🦋 |
| Scout | Scout | Research & Recon | 🦉 |
| Forge | Forge | Backend Dev | 🐻 |
| Pixel | Pixel | Frontend Dev | 🦎 |
| Sentinel | Sentinel | QA Lead | 🐺 |

All agents report to Jarvis. Agents are assigned to tasks via the `ai_agent` field (codename).

---

## MCP Tools Available

These MCP tools are connected and available in Claude Projects / Claude Code:

| Tool | Capabilities |
|------|-------------|
| **Google Calendar** | List calendars, list/create/update/delete events, find free time, find meeting times, RSVP |
| **Outlook / M365** | Email search, calendar search, chat message search, find meeting availability, SharePoint search |
| **Gmail** | Search messages, read messages/threads, create drafts, list labels |
| **Notion** | Search, create/update pages, create databases/views, get comments/users/teams |
| **Canva** | Generate designs, search/export designs, edit designs, manage folders/assets, brand kits |

---

## Architecture Quick Reference

- **Backend:** Node.js 20 + Express.js 4.21
- **Database:** PostgreSQL 16 (14+ tables, full-text search with tsvector + pg_trgm)
- **Frontend:** Vanilla JS SPA, PWA-enabled
- **Auth:** Static API key via `X-Api-Key` header
- **Deployment:** Railway (Docker + managed PostgreSQL)
- **AI:** OpenAI GPT-4o-mini for smart intake classification
