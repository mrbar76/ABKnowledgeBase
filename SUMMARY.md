# AB Brain — What It Is (The Quick Version)

**AB Brain** is a personal app I built that gives all my AI assistants a shared memory.

## The Problem

I use multiple AIs every day — Claude, ChatGPT, Gemini — plus a wearable device called Bee that records my conversations. The problem? None of them remember what the others said. Claude doesn't know what I told ChatGPT yesterday. ChatGPT doesn't know what Bee recorded this morning. Every conversation starts from scratch.

## The Solution

AB Brain is a central hub that all my AIs read from and write to. It's a REST API backed by PostgreSQL, running on Railway (cloud hosting). Think of it as a shared brain for all my AIs.

```
Me (phone) ──→ Mobile Dashboard (PWA)
                    │
Claude ─────────→  AB Brain API  ←──── Bee Wearable
ChatGPT ────────→  (Railway)     ←──── Apple Health
Gemini ─────────→       │
                   PostgreSQL (primary)
                        │
                   Notion (mirror)
```

## What It Actually Does

- **Shared Knowledge Base** — Any AI can store and retrieve notes, facts, meeting summaries, research, code snippets. When I start a Claude conversation, I can tell it to load context from my brain. When we finish, I tell it to save the important stuff back.

- **Task Management** — Kanban board (To Do / In Progress / Review / Done). My AIs can create and update tasks. I see everything on my phone.

- **Bee Transcript Storage** — My Bee wearable records real-world conversations. AB Brain syncs them automatically every 30 minutes, stores the full transcripts with speaker-by-speaker detail, and makes them searchable.

- **Smart Intake** — I can throw any raw text at it and GPT-4o-mini auto-classifies it (is this a task? a note? a transcript?) and files it into the right place with tags and categories.

- **Conversation Distillation** — Feed it a ChatGPT or Claude conversation export, and it extracts facts, decisions, and action items automatically.

- **Full-Text Search** — PostgreSQL's built-in search finds anything across all my data in milliseconds. Search a name, a topic, a phrase from a conversation last month — it finds it.

- **Mobile Dashboard** — A phone-friendly web app (PWA — installs like a native app from the browser, no app store needed) with charts, search, and a Kanban board. Dark theme. Works offline for cached content.

- **Notion Mirror** — Everything also syncs one-way to my Notion workspace, so I can browse and organize data in the Notion app too.

## What's a PWA?

PWA stands for "Progressive Web App." It means you open a website on your phone, tap "Add to Home Screen," and it installs like a real app. It opens full-screen, has its own icon, works offline for cached pages, and auto-refreshes when you come back to it. No app store, no downloads, no updates to manage.

## The Tech

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express |
| Primary Database | PostgreSQL (Railway-managed) |
| Mirror | Notion (optional, read-only sync) |
| AI Classification | OpenAI GPT-4o-mini |
| Search | PostgreSQL full-text search (tsvector + trigram) |
| Hosting | Railway (Docker container) |
| Frontend | Vanilla JS (no framework), mobile-first PWA |
| Wearable | Bee by Amazon (auto-sync via cloud API) |

## Why Two Databases?

**PostgreSQL** is the real database — it's fast, handles full-text search, stores unlimited text, and doesn't have rate limits. All the AIs read from and write to PostgreSQL.

**Notion** is a mirror — a background job copies data over so I can browse it in the Notion app. Notion has nice built-in views, filtering, and a polished mobile app. But it's optional. If Notion goes away, nothing breaks.

## What's Next

- **People directory** — Track who I talk to, link conversations to people
- **AI conversation archive** — Store full ChatGPT/Claude conversations with chat-bubble UI
- **Health & fitness** — Pull in workout and health data
- **Security hardening** — Proper auth beyond a static API key
- **Backup strategy** — Automated data exports
- **Cost tracking** — Monitor AI API usage across all providers

---

*Built with Claude, deployed on Railway. The AI that helps build the system that connects all the AIs.*
