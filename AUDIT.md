# AB Brain — Full Audit

**Repo:** `mrbar76/abknowledgebase` (v1.7.2) · **Branch:** `claude/generate-audit-report-18gBF` · **Date:** 2026-04-25

---

## 1. Executive Summary

AB Brain is a single-user personal knowledge base: Express + PostgreSQL backend, vanilla-JS PWA frontend, Bee wearable polling, OpenAI smart intake, optional Notion mirror. The schema is mature and search-rich (16 tables, full-text + trigram indexes, idempotent migrations), and the deployment story (Railway + Docker + healthcheck) is clean. The biggest weaknesses are concentrated in **security posture**, **multi-statement atomicity**, and **frontend maintainability** of an 8.3 KLOC monolithic `app.js`.

**Top 5 risks**
1. SQL string interpolation in the purge endpoint (`server.js:122`) — protected only by an in-memory whitelist.
2. Single static `API_KEY` accepted via `?api_key=` query string (`server.js:97`) — leaks into access logs and browser history.
3. CSP disabled (`server.js:35`) and CORS fully open (`server.js:36`) on a service that stores health, fitness, and conversation transcripts.
4. `exercises` table is dropped and recreated on every server start (`db.js:591`) — any user-edited rows are lost.
5. No transactions anywhere; multi-table writes (purge, distill, sync) can leave partial state.

**Top 3 strengths**
1. Idempotent schema with 50+ `CREATE … IF NOT EXISTS` / `ALTER TABLE … IF NOT EXISTS` migrations and search-vector backfills.
2. Hybrid search infrastructure (tsvector GIN + `pg_trgm` trigram) covering 8+ tables, with BEFORE-trigger maintenance.
3. Solid PWA fundamentals (versioned cache `abkb-v33`, offline shell, VAPID push, iOS safe-area handling).

---

## 2. Repository Snapshot

| Area | Detail |
| --- | --- |
| Language / runtime | Node.js ≥ 18 (engines), Docker base `node:20-slim` |
| Backend | Express 4.21, Helmet 8, CORS 2.8, `pg` 8.20, `web-push` 3.6, `openai` 6.27 |
| Database | PostgreSQL 16 (Railway-managed), `pg_trgm` extension |
| Frontend | Vanilla JS PWA, Lucide + Chart.js via CDN, no build step |
| Deploy | Railway via Dockerfile; `--max-old-space-size=384`; `/api/health-check`; `ON_FAILURE` × 3 |
| Tests / lint | None |
| Docs | README, FUNCTIONAL_SPEC, CHANGELOG, SUMMARY, SETUP, ab-brain-knowledge.md |

**Line counts (key files)**

| File | LOC |
| --- | ---: |
| `db.js` | 1,159 |
| `server.js` | 451 |
| `public/app.js` | 8,278 |
| `public/index.html` | 640 |
| `public/styles.css` | 3,841 |
| `routes/*` (21 files) | 8,020 |
| **Total measured** | **22,389** |

Largest route modules: `transcripts.js` (1,201), `bee.js` (1,164), `tasks.js` (712), `gamification.js` (586), `recovery.js` (481), `exercises.js` (476).

---

## 3. Database Audit

### 3.1 Schema (16 primary tables + helpers)

| Table | PK | Purpose / key columns |
| --- | --- | --- |
| `knowledge` | UUID | Unified KB (title, content, category, tags, ai_source, metadata, search_vector). Absorbed the old `facts` table. |
| `tasks` | UUID | Kanban (status, priority, ai_agent, due_date, recurrence_rule, parent_id self-ref, reminder_at, checklist) |
| `transcripts` | UUID | Bee transcripts (raw_text, summary, source, recorded_at, bee_id, search_vector) |
| `transcript_speakers` | UUID | Per-utterance rows (FK → `transcripts` ON DELETE CASCADE) |
| `conversations` | UUID | AI chat threads (`full_thread JSONB`, summary, search_vector) |
| `activity_log` | **SERIAL** | Audit trail (action, entity_type, entity_id, ai_source, created_at DESC) |
| `workouts` | UUID | Sessions (date, type, exercises JSONB, effort, duration/HR both TEXT and numeric) |
| `exercises` | UUID | Library (name UNIQUE, level, equipment, muscle_strength_score). **Dropped & recreated each boot.** |
| `gym_profiles` | UUID | Equipment selections, `is_primary` flag |
| `body_metrics` | UUID | Weight/BMI/body-fat with vendor metadata + raw_payload JSONB |
| `meals` | UUID | Macro logging + 1–10 hunger/fullness/energy scales |
| `daily_context` | UUID | One row per `date` (sleep, hydration, notes) |
| `coaching_sessions` | UUID | Session notes, FK → `daily_plans` (SET NULL), FK → `conversations` (SET NULL) |
| `daily_plans` | UUID | One row per `plan_date` (target_effort/calories/protein, planned_exercises JSONB) |
| `injuries` | UUID | Body area, severity 1–10, status enum, treatment notes |
| `contacts` | UUID | Name, aliases JSONB, relationship, confidentiality enum |

**Helpers:** `gamification_settings` (singleton row `id = 1`, holds VAPID keys, push subscription, ring goals, notification schedule), `badges`, `equipment_catalog` (TEXT PK, 41 seeded rows), `task_comments` (FK → `tasks` CASCADE).

### 3.2 Indexes & full-text search

- `pg_trgm` extension installed (`db.js:37`).
- **GIN tsvector** indexes on `knowledge`, `transcripts`, `conversations`, `workouts`, `body_metrics`, `meals`, `coaching_sessions`, `injuries`, `exercises`.
- **Trigram (`gin_trgm_ops`)** expression indexes for fuzzy ILIKE (knowledge, transcripts, workouts, meals, exercises, injuries, coaching_sessions).
- **B-tree** indexes on the obvious filter/sort columns: `*_date DESC`, `status`, `ai_source`, `category`, etc.
- **Composite** index `(entity_type, entity_id)` and `(created_at DESC)` on `activity_log` — important for audit queries.
- **GIN** on `tags` columns where tags are stored as arrays.

### 3.3 Triggers & functions

Ten `BEFORE INSERT OR UPDATE` triggers maintain `search_vector` and bump `updated_at = NOW()` on the relevant tables. Side effect: a row updated *only* on a column outside the trigger's `OF …` list will not bump `updated_at`.

### 3.4 Migrations & idempotency

- All `CREATE TABLE` statements use `IF NOT EXISTS`.
- 50+ `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migrations span `db.js:467–1104` to grow the schema safely.
- Search-vector backfills at `db.js:1122–1131` populate older rows that predate the triggers.
- Numeric backfills (`db.js:631–675`) parse legacy TEXT fields (`time_duration`, `distance`) into proper numeric columns. Both old and new columns are retained — doubles storage during the transition.
- Deprecated tables (`facts`, `projects`, `training_plans`, `goal_profiles`, `readiness_snapshots`, `progress_checkins`) are explicitly dropped after data migration; `daily_nutrition_context` was renamed to `daily_context`.

### 3.5 Data integrity issues

| Issue | Where | Impact |
| --- | --- | --- |
| Only **7 explicit foreign keys** | schema-wide | `meals`, `body_metrics`, `daily_context`, `injuries`, `activity_log` reference no parents; `entity_id` in audit log can dangle. |
| `activity_log.id SERIAL` while everything else is UUID | `db.js` activity table | Inconsistent ID strategy; SERIAL is fine but breaks portability of exports. |
| `exercises` table dropped & recreated on every boot | `db.js:591` (commented as deliberate seed-from-CSV) | **User edits are lost on restart.** |
| `gamification_settings` singleton has no `UNIQUE` on `id` | `db.js` | If a second row appears, app behaviour is undefined. |
| `daily_plans.plan_date UNIQUE` and `daily_context.date UNIQUE` | schema | Disallows multiple workouts/contexts in one day; may collide with reality. |
| Many text "enum" columns lack `CHECK` constraints | `workout_type`, `ai_source`, etc. | Free-text drift over time. |
| `effort` allowed NULL but no `CHECK` on initial CREATE | `workouts` | Range only enforced via later ALTER. |
| Cascade behavior is mixed | `coaching_sessions` SET NULL vs `transcript_speakers` CASCADE | OK by design but undocumented. |

### 3.6 SQL patterns

- **Connection pool** (`db.js:9–15`): `max: 20`, SSL `rejectUnauthorized: false` for non-localhost. No idle timeout configured.
- **Timezone** (`db.js:18–20`): `SET timezone = '${APP_TIMEZONE}'` runs on every connection — string-interpolated from env, low risk but worth parameterising.
- **Parameterised queries everywhere** in `routes/*` (`$1, $2, …`). Search uses both tsvector and ILIKE fallback (`routes/search.js:74–91`).
- **SQL injection risk — purge endpoint** (`server.js:105–135`): `await query(\`DELETE FROM ${table}\`)` at `server.js:122`. The whitelist at `server.js:108` is the only thing standing between user input and arbitrary table deletion. Future edits to that whitelist are the failure mode.
- **No transactions.** Purge loops `DELETE FROM` table-by-table. Distill/sync flows write to multiple tables sequentially. Partial failures leave inconsistent state.
- **Connection-per-request via pool** is fine for current scale; no slow-query log, no `EXPLAIN ANALYZE` plumbing.

### 3.7 Data volume / growth

- `activity_log` grows unbounded; SERIAL id and no TTL/archival.
- `transcripts` + `transcript_speakers` accumulate from Bee polling every 30 minutes.
- `conversations.full_thread JSONB` stores entire threads in a single column; no per-message index. Containment queries will full-scan.
- `daily_plans.planned_exercises`, `coaching_sessions.key_decisions` are JSONB arrays without GIN indexes.
- Pagination is mostly present (LIMIT/OFFSET parameterised) but `routes/briefing.js:102–106` selects open tasks with no LIMIT.

---

## 4. Application Audit

### 4.1 Architecture

`server.js` middleware order (lines 34–60): Helmet (CSP off) → CORS (open) → JSON body 50 MB → timezone helper → static files. Auth middleware (`server.js:94–100`) gates everything under `/api/*` except `/api/health-check`. Twenty-one route modules are mounted under `/api/<feature>`; the SPA fallback `app.get('*')` at `server.js:184` catches everything else and serves `public/index.html`.

In-process schedulers run inside `start()`:
- **Notification scheduler** (`server.js:219–375`): polls `gamification_settings.notification_schedule` every 60 s with a 2-minute window. State (`notifState.lastSent`) is in-memory — restart mid-day can re-fire.
- **Recurring task extender** (`server.js:378–390`): every 6 h.
- **Bee cron** (`server.js:399–447`): every `BEE_SYNC_INTERVAL` minutes (default 30) when `BEE_API_TOKEN` is set; calls its own HTTP server back via `http.request` to `127.0.0.1:PORT`.

There is **no global error handler** and no `SIGTERM` handler — Railway will SIGKILL after ~30 s and in-flight requests drop.

### 4.2 Route inventory (~95 endpoints)

| Route file | Endpoints | Purpose |
| --- | ---: | --- |
| `tasks.js` | 18 | Kanban CRUD, weekly review, comments, checklists, recurring extension |
| `transcripts.js` | 15 | Bee transcript CRUD, speaker assignment, split analysis |
| `exercises.js` | 14 | Library + Fitbod CSV import + filtering |
| `training.js` | 12 | Daily plans, coaching sessions, injuries |
| `bee.js` | 11 | Sync (full / chunked / incremental), counts, status, purge, search |
| `daily-plans.js` | 8 | Plan CRUD, ring progress, plan↔workout linking |
| `workouts.js` | 7 | CRUD, stats, exercise history |
| `nutrition.js` | 7 | Meals + daily context (also aliased to `/api/daily-context`) |
| `gym-profiles.js` | 7 | Equipment selection |
| `gamification.js` | 7 | Badges, streaks, settings, ring updates, push subscription |
| `contacts.js` | 7 | CRUD + unrecognized speaker aggregation |
| `body-metrics.js` | 7 | CRUD + summary stats |
| `meals.js` | 6 | CRUD by `meal_type` |
| `knowledge.js` | 6 | CRUD + categories endpoint |
| `conversations.js` | 6 | CRUD + ChatGPT import |
| `intake.js` | 3 | Smart intake, batch classify, distill |
| `search.js` | 2 | Cross-type unified + AI flattened |
| `recovery.js` | 2 | Recovery score + muscle readiness |
| `dashboard.js` | 1 | Aggregated stats (Promise.all of 16 queries at `dashboard.js:11–37`) |
| `briefing.js` | 1 | Morning briefing markdown |
| `activity.js` | 1 | Audit log with filters |

### 4.3 Authentication & security

| Concern | Where | Notes |
| --- | --- | --- |
| Single static `API_KEY` | `server.js:32`, `:94–100` | No per-user scoping; if `API_KEY` is unset, **auth is silently disabled**. |
| Key accepted via query string | `server.js:97` | `?api_key=…` ends up in access logs, browser history, referer headers. Restrict to header. |
| Helmet CSP disabled | `server.js:35` | `helmet({ contentSecurityPolicy: false })` weakens the only XSS defence beyond manual `esc()`. |
| CORS fully permissive | `server.js:36` | `cors()` with no allowlist on a service holding health/conversation data. |
| 50 MB JSON body | `server.js:37` | DoS-friendly. |
| Open-text plaintext secrets in DB | `gamification_settings.vapid_private_key`, `push_subscription` | DB dumps leak push capability. |
| Bee token via env, then echoed in HTTP body to localhost | `server.js:413–417` | OK in-process but appears in any HTTP capture. |
| Privacy policy hardcoded HTML | `server.js:86–91` | No mention of OpenAI / Bee / Notion dataflow. |

### 4.4 Validation & error handling

- No request-validation library (no `zod`, `joi`, etc.). Routes inspect required fields manually (e.g. `routes/knowledge.js` checks `title`, `content`).
- `limit` query params parsed via `Number()` with no upper bound — clients can request huge result sets.
- Most handlers wrap in `try/catch` and return `{ error: err.message }` with status 500 — leaks internal messages.
- No async-error wrapper and no global Express error middleware. Promise rejections inside `Promise.all` swallow partial failures.

### 4.5 Frontend

- `public/app.js` is a single 8,278-line vanilla-JS file: tab navigation, view rendering, modal management, charts, debounced global search, push-subscription flow.
- DOM updated via `innerHTML` with a local `esc()` helper; not all dynamic content runs through it (transcript titles, task names occasionally interpolated raw).
- No framework, no bundler, no minification — repeat visitors are saved by the service worker; first-load is a 430 KB JS payload.
- One reusable modal element — nested modals impossible by design.
- Auth state: API key in `localStorage`; 401 from `api()` helper triggers logout.

### 4.6 PWA

- `public/sw.js`: cache name `abkb-v33`, precaches `/`, `/styles.css`, `/app.js`, `/manifest.json`. Network-first for static, network-only for `/api/*`. Old caches pruned on `activate`. Push events dispatch notifications.
- `public/manifest.json`: `display: standalone`, indigo theme, 192/512 icons, `start_url: /`.
- iOS treatment in `index.html`: `viewport-fit=cover`, safe-area insets, `apple-mobile-web-app-status-bar-style: black-translucent`, 180×180 apple-touch-icon, 100 dvh layout.
- VAPID keys auto-generated once at boot (`server.js:204–215`) and persisted into `gamification_settings`.

### 4.7 Integrations

- **Bee** (`routes/bee.js`, 58 KB / 1,164 LOC): three sync flavours (full / chunk / incremental), embeds a custom CA cert, paginates cursor feeds, calls GPT-4o-mini for speaker identification, dedupes by `bee_id` plus heuristic content match. Polling-only; if user has thousands of conversations the chunked path requires hundreds of sequential calls.
- **OpenAI smart intake** (`routes/intake.js`): GPT-4o-mini classification + distillation. No retry/backoff visible; cost is per call.
- **Notion mirror**: optional one-way sync (`NOTION_TOKEN` + 6 DB IDs in `.env.example`). No UI surface for sync status — a silent failure is invisible.

---

## 5. Code Quality & Tooling

- **No tests** (no `jest`, `vitest`, `mocha`, no `__tests__`, no `npm test` script).
- **No linter / formatter** (no `eslint`, `prettier`, no `.editorconfig`).
- **No type system** — pure JS, no JSDoc types of significance.
- **Logging** is `console.log` / `console.error` everywhere. No structured logger, no request IDs, no log levels. Bee module logs heavily; other routes barely at all.
- **Dependencies** (`package.json`):

  | Package | Version | Note |
  | --- | --- | --- |
  | `express` | ^4.21.0 | Current 4.x line |
  | `helmet` | ^8.0.0 | Current — but CSP intentionally off |
  | `cors` | ^2.8.5 | Long-stable |
  | `pg` | ^8.20.0 | Current |
  | `openai` | ^6.27.0 | Current SDK |
  | `web-push` | ^3.6.7 | Slightly behind current 3.7 |

  No dev-dependencies block at all — implies no local tooling.
- **Health check** (`server.js:68–70`) only returns `{ status: 'ok', version, backend, timestamp }` — does not ping the database, so will report green even if Postgres is down.

---

## 6. Deployment & Ops

**Dockerfile**

```
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY scripts/generate-icons.js …
RUN npm install sharp --no-save && node scripts/generate-icons.js || echo "Skipping"
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

- Slim base, prod-only deps — good.
- Inline `sharp` install for icon generation; gracefully skipped if it fails.
- No `HEALTHCHECK`, no non-root `USER`, no signal forwarding (no `tini`).

**`railway.toml`**
```
builder = "DOCKERFILE"
startCommand = "node --max-old-space-size=384 server.js"
healthcheckPath = "/api/health-check"
healthcheckTimeout = 60
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```
Sane Railway profile; no graceful-shutdown handling on the app side means the heap cap + auto-restart is the safety net.

**`.env.example`** — clearly documents `PORT`, `API_KEY`, `OPENAI_API_KEY`, `BEE_API_TOKEN`, `SYNC_INTERVAL`, `NOTION_TOKEN` and the six `NOTION_DB_*` IDs. There is no startup validation that required vars are present; a missing `OPENAI_API_KEY` only surfaces on first intake call.

**`scripts/`**

| Script | Purpose |
| --- | --- |
| `generate-icons.js` | PNG favicons from SVG (build-time, optional) |
| `generate-brand-assets.js` | Brand asset generation |
| `generate-product-pdf.py` | Builds `AB_Brain_Product_Overview.pdf` |
| `import-chatgpt.js` | Bulk import `conversations.json` exports |
| `bee-export.js`, `bee-live-sync.js`, `bee-to-brain-sync.sh`, `com.abbrain.bee-sync.plist` | Local Bee mirror + macOS LaunchAgent for periodic sync |

---

## 7. Documentation Inventory

| File | Status |
| --- | --- |
| `README.md` | Architecture diagram + endpoint table + Railway deploy steps. In sync with v1.7.2. |
| `FUNCTIONAL_SPEC.md` | ~25 KB; thorough schema + API + design rationale. |
| `CHANGELOG.md` | Active, version-by-version with rationale (e.g. TSB overhaul, transcript splitting). |
| `SUMMARY.md` | Elevator pitch / why-PostgreSQL. |
| `SETUP.md` | Local dev setup. |
| `ab-brain-knowledge.md` | Claude Project knowledge file (API reference for AI consumers). |
| `AB_Brain_Product_Overview.pdf` | Generated by `scripts/generate-product-pdf.py`. |

Docs are unusually well maintained for a one-person project. The main gap is operational: no troubleshooting playbook (Bee API timeouts, push subscription expiry, Notion mirror failures) and no migration guide beyond "schema is idempotent."

---

## 8. Risk Matrix

| # | Area | Issue | Where | Severity |
| --- | --- | --- | --- | --- |
| 1 | Security | Static `API_KEY`, accepted via query string | `server.js:32`, `:97` | High |
| 2 | Security | CSP disabled | `server.js:35` | High |
| 3 | Security | CORS open to all origins | `server.js:36` | High |
| 4 | Security | 50 MB JSON body limit | `server.js:37` | Medium |
| 5 | Security | VAPID private key + push subs in plaintext | `gamification_settings` | Medium |
| 6 | Integrity | SQL string interpolation in purge | `server.js:122` | High |
| 7 | Integrity | Only 7 explicit foreign keys | schema-wide | Medium |
| 8 | Integrity | No transactions for multi-table writes | purge, distill, sync | Medium |
| 9 | Integrity | `exercises` dropped & recreated on boot | `db.js:591` | High (silent data loss) |
| 10 | Integrity | `gamification_settings` singleton has no `UNIQUE(id)` | `db.js` | Low |
| 11 | Performance | Unbounded `activity_log`, `transcripts`, `conversations.full_thread` | schema | Medium |
| 12 | Performance | Briefing route fetches all open tasks | `routes/briefing.js:102–106` | Low |
| 13 | Reliability | No `SIGTERM` / graceful shutdown | `server.js` | Medium |
| 14 | Reliability | Health check does not ping DB | `server.js:68–70` | Medium |
| 15 | Reliability | Notification scheduler state in memory | `server.js:217` | Low |
| 16 | Reliability | No retries on OpenAI / Bee calls | `routes/intake.js`, `routes/bee.js` | Low |
| 17 | Maintainability | 8.3 KLOC monolithic `app.js` | `public/app.js` | Medium |
| 18 | Maintainability | No tests, no linter, no types | repo-wide | Medium |
| 19 | Observability | `console.*` logging, no structured logs / request IDs | repo-wide | Medium |
| 20 | Observability | Sync status state lost on restart | `sync-status.js` | Low |

---

## 9. Recommendations (prioritised)

**Immediate (low effort, high value)**
- Replace `DELETE FROM ${table}` with a hardcoded switch over the whitelist (`server.js:122`); or use `pg`'s `format` helper with identifier quoting. Add the purge action to `activity_log`.
- Drop query-string API key support — header only (`server.js:97`).
- Tighten CORS to known origins; tighten Helmet (re-enable CSP with a starter policy that allows the CDNs already used).
- Lower JSON body limit to ~2 MB; raise per-route only where genuinely needed (Bee import).
- Add a `process.on('SIGTERM', …)` that drains the HTTP server and closes the pg pool.
- Make `/api/health-check` run `SELECT 1` so Railway routes traffic away from a broken DB.

**Short-term (1–2 days)**
- Stop dropping/recreating `exercises`; switch to upsert seed (`INSERT … ON CONFLICT (name) DO UPDATE`). Otherwise document that user edits are intentionally ephemeral.
- Add `UNIQUE` on `gamification_settings.id` (or a `CHECK (id = 1)`).
- Wrap purge, distill, and Bee incremental sync in `BEGIN/COMMIT`.
- Add foreign keys (with `ON DELETE SET NULL` where appropriate) for `meals`, `body_metrics`, `daily_context`, `injuries`, `activity_log.entity_id`.
- Enforce a max `limit` parameter (e.g. 500) across list routes.
- Add a global Express error handler that maps known errors to 4xx and hides internals.
- Persist `notifState.lastSent` and `sync-status` job history to the DB to survive restarts.
- Add a structured logger (`pino` is one dep, JSON output, request IDs via middleware).

**Long-term (project-shaping)**
- Introduce Zod (or Valibot) request schemas for every route; reuse them to generate the OpenAPI specs instead of hand-maintaining four `openapi-*.json` files.
- Add a minimal test harness (`vitest` + `supertest`) covering auth, purge, search, and Bee idempotency. Wire it into a CI workflow.
- Plan an `app.js` split. The cheapest path: extract per-tab modules and load via `<script type="module">` — no bundler required.
- Add a retention/archival job for `activity_log` and `transcript_speakers` (e.g. move rows older than N days to a cold table or S3 export).
- Encrypt sensitive columns at rest (`vapid_private_key`, `push_subscription`) — even simple AES with a key from env improves the dump-leak posture.
- Multi-user support: introduce a `users` table, add `user_id` to every domain table, add row-level security policies in Postgres. Even if only one user ever signs in, the model future-proofs sharing.

---

## 10. Appendix — File sizes & line counts

```
 1,159  db.js
   451  server.js
 8,278  public/app.js
   640  public/index.html
 3,841  public/styles.css
    27  routes/activity.js
 1,164  routes/bee.js
   296  routes/body-metrics.js
   365  routes/briefing.js
   120  routes/contacts.js
   207  routes/conversations.js
   387  routes/daily-plans.js
    70  routes/dashboard.js
   476  routes/exercises.js
   586  routes/gamification.js
   117  routes/gym-profiles.js
   265  routes/intake.js
   121  routes/knowledge.js
   245  routes/meals.js
   336  routes/nutrition.js
   481  routes/recovery.js
    99  routes/search.js
   712  routes/tasks.js
   344  routes/training.js
 1,201  routes/transcripts.js
   401  routes/workouts.js
22,389  total
```

*Generated 2026-04-25 on branch `claude/generate-audit-report-18gBF`. No source files were modified to produce this audit.*
