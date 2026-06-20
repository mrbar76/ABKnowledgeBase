#!/usr/bin/env node
// Live-database schema map. Queries information_schema and pg_catalog
// against the connected DB (whatever DATABASE_URL points at) and emits
// a single markdown document covering:
//
//   PART 1 — Table inventory (column counts, tombstones, row counts)
//   PART 2 — Columns per table (types, nullability, PK/FK)
//             + daily_context "real vs junk" split (non-null vs empty)
//   PART 3 — Relationships (real FK constraints + naming-convention FKs)
//
// PART 4 (the proposed daily_context after-shape) is assembled from
// PART 2's output separately — this script only emits ground truth.
//
// READ-ONLY: every query is a SELECT against system catalogs. No DDL,
// no DML, no schema changes. Safe to run against production.
//
// Usage:
//   railway run node scripts/dump-live-schema-map.js > schema-map.md
//   # or with explicit env:
//   DATABASE_URL=postgres://... node scripts/dump-live-schema-map.js
//
// Output is markdown to stdout; status/progress is logged to stderr so
// stdout stays clean for piping.

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { pool, query } = require('../db');

function log(msg) { process.stderr.write(`[dump] ${msg}\n`); }
function out(line) { process.stdout.write(line + '\n'); }

async function readOnlyClient() {
  // Acquire a single client, set transaction read-only as belt-and-
  // suspenders against any accidental write.
  const c = await pool.connect();
  await c.query('SET default_transaction_read_only = on');
  return c;
}

// ─── PART 1 ─────────────────────────────────────────────────────────
async function part1(c) {
  log('PART 1: table inventory');
  // Live column count + tombstones + row count in one pass.
  const sql = `
    SELECT
      c.relname AS table_name,
      (SELECT count(*) FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      )::int AS live_cols,
      (SELECT count(*) FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND a.attisdropped
      )::int AS tombstones,
      c.reltuples::bigint AS approx_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY live_cols DESC, c.relname
  `;
  const { rows } = await c.query(sql);

  out('## PART 1 — Table inventory (worst-first by live column count)');
  out('');
  out('| Table | Live | Tombstones | Approx rows | Flag |');
  out('|---|---:|---:|---:|---|');
  for (const r of rows) {
    const flag = r.live_cols > 30 ? '🚩 >30 cols' : '';
    out(`| \`${r.table_name}\` | ${r.live_cols} | ${r.tombstones} | ${r.approx_rows.toLocaleString()} | ${flag} |`);
  }
  out('');
  // Surface daily_context explicitly per ask.
  const dc = rows.find(r => r.table_name === 'daily_context');
  if (dc) {
    out(`**daily_context: ${dc.live_cols} live columns, ${dc.tombstones} tombstones, ~${dc.approx_rows.toLocaleString()} rows.**`);
    out('');
  }
  return rows;
}

// ─── PART 2 ─────────────────────────────────────────────────────────
async function part2(c, tables) {
  log('PART 2: columns per table');
  // Bulk-load PK/FK membership per column so we don't N+1.
  const pkSql = `
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
  `;
  const fkSql = `
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
  `;
  const pks = new Set((await c.query(pkSql)).rows.map(r => `${r.table_name}.${r.column_name}`));
  const fks = new Set((await c.query(fkSql)).rows.map(r => `${r.table_name}.${r.column_name}`));

  const colsSql = `
    SELECT table_name, column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  const allCols = (await c.query(colsSql)).rows;

  // Compact type rendering: ARRAY → "text[]" etc.; tsvector stays tsvector.
  function shortType(r) {
    if (r.data_type === 'ARRAY') return `${r.udt_name.replace(/^_/, '')}[]`;
    if (r.data_type === 'USER-DEFINED') return r.udt_name;
    return r.data_type
      .replace('timestamp with time zone', 'timestamptz')
      .replace('character varying', 'varchar')
      .replace('double precision', 'double');
  }

  out('## PART 2 — Columns per table');
  out('');
  const byTable = {};
  for (const c of allCols) (byTable[c.table_name] = byTable[c.table_name] || []).push(c);

  for (const t of tables) {
    const cols = byTable[t.table_name] || [];
    if (!cols.length) continue;
    out(`### \`${t.table_name}\` (${cols.length} cols)`);
    out('');
    out('| Column | Type | Null | Key |');
    out('|---|---|---|---|');
    for (const col of cols) {
      const key = pks.has(`${t.table_name}.${col.column_name}`) ? 'PK'
                : fks.has(`${t.table_name}.${col.column_name}`) ? 'FK'
                : '';
      out(`| \`${col.column_name}\` | ${shortType(col)} | ${col.is_nullable === 'YES' ? '✓' : '—'} | ${key} |`);
    }
    out('');
  }

  // daily_context real-vs-junk split: per-column non-null count.
  log('PART 2 extra: daily_context real-vs-junk split');
  const dcCols = (byTable['daily_context'] || []).map(c => c.column_name);
  if (dcCols.length) {
    // Build a single SELECT with one FILTER per column. Quote identifiers
    // defensively even though information_schema names are well-formed.
    const filters = dcCols.map(
      n => `count(*) FILTER (WHERE "${n}" IS NOT NULL)::int AS "${n}"`
    ).join(',\n      ');
    const totalSql = `SELECT count(*)::int AS total, ${filters} FROM daily_context`;
    const r = (await c.query(totalSql)).rows[0];
    const total = r.total;

    const real = [], dead = [];
    for (const n of dcCols) {
      const nonnull = r[n];
      (nonnull > 0 ? real : dead).push({ name: n, nonnull, total });
    }

    out(`### \`daily_context\` real-vs-junk split (across ${total} row${total === 1 ? '' : 's'})`);
    out('');
    out(`**Real (${real.length} cols holding data in ≥1 row):**`);
    out('');
    out('| Column | Non-null rows | Coverage |');
    out('|---|---:|---:|');
    for (const r2 of real) {
      const pct = total > 0 ? Math.round((r2.nonnull / total) * 100) : 0;
      out(`| \`${r2.name}\` | ${r2.nonnull} | ${pct}% |`);
    }
    out('');
    out(`**Dead/empty (${dead.length} cols — never populated in any row):**`);
    out('');
    if (dead.length === 0) out('_(none — every column has data somewhere)_');
    else {
      out('| Column |');
      out('|---|');
      for (const d of dead) out(`| \`${d.name}\` |`);
    }
    out('');
  }
}

// ─── PART 3 ─────────────────────────────────────────────────────────
async function part3(c) {
  log('PART 3: relationships (real FK + naming-convention FK)');
  const realFkSql = `
    SELECT
      tc.table_name      AS child_table,
      kcu.column_name    AS child_column,
      ccu.table_name     AS parent_table,
      ccu.column_name    AS parent_column,
      rc.delete_rule     AS on_delete,
      rc.update_rule     AS on_update
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema    = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema    = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY child_table, child_column
  `;
  const real = (await c.query(realFkSql)).rows;

  const idColsSql = `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name LIKE '%\\_id' ESCAPE '\\'
      AND column_name <> 'id'
    ORDER BY table_name, column_name
  `;
  const idCols = (await c.query(idColsSql)).rows;
  const realFkSet = new Set(real.map(r => `${r.child_table}.${r.child_column}`));
  const conventionFks = idCols.filter(r => !realFkSet.has(`${r.table_name}.${r.column_name}`));

  // JSONB array detection — proxy for "1:N relation hidden as blob".
  const jsonbSql = `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND udt_name = 'jsonb'
    ORDER BY table_name, column_name
  `;
  const jsonbCols = (await c.query(jsonbSql)).rows;

  out('## PART 3 — Relationships');
  out('');
  out(`### Real foreign-key constraints (${real.length})`);
  out('');
  if (real.length === 0) out('_(none)_');
  else {
    out('| Child | → | Parent | On delete |');
    out('|---|---|---|---|');
    for (const r of real) {
      out(`| \`${r.child_table}.${r.child_column}\` | → | \`${r.parent_table}.${r.parent_column}\` | ${r.on_delete} |`);
    }
  }
  out('');
  out(`### Naming-convention FKs (looks like FK, no constraint enforcing it) — ${conventionFks.length}`);
  out('');
  if (conventionFks.length === 0) out('_(none — every \\*_id column has a real FK)_');
  else {
    out('| Column | Likely refers to |');
    out('|---|---|');
    for (const r of conventionFks) {
      // Heuristic: foo_id → foos table, fallback to "?"
      const guess = r.column_name.replace(/_id$/, '');
      out(`| \`${r.table_name}.${r.column_name}\` | \`${guess}\` (?) |`);
    }
  }
  out('');
  out(`### JSONB columns (potential 1:N hidden as blob) — ${jsonbCols.length}`);
  out('');
  if (jsonbCols.length === 0) out('_(none)_');
  else {
    out('| Table.column |');
    out('|---|');
    for (const r of jsonbCols) {
      out(`| \`${r.table_name}.${r.column_name}\` |`);
    }
  }
  out('');
  out('_(JSONB columns are flagged but may or may not be hiding relations — inspect contents to confirm. Known cases per audit: `workouts.exercises`, `plan_segments.planned_exercises`, `coaching_sessions.adjustments` are 1:N blobs that should be junction tables. `*.metadata`, `*.tags`, `*.search_vector`, `*.sources`, `*.raw_payload` are intentional blobs.)_');
  out('');
  out('### Numbered-column / repeating-group patterns');
  out('');
  out('_(static-grep level. Known: `workouts.grip_feedback / legs_feedback / cardio_feedback / shoulder_feedback` — 1NF violation, should be a `workout_feedback` table keyed by (workout_id, body_area).)_');
  out('');
}

async function main() {
  out('# Forge live database map');
  out('');
  out(`Generated: ${new Date().toISOString()}`);
  out('');
  out('Source: direct `information_schema` + `pg_catalog` queries against the connected DB.');
  out('Read-only — every query is a `SELECT` against system catalogs.');
  out('');

  const c = await readOnlyClient();
  try {
    const tables = await part1(c);
    await part2(c, tables);
    await part3(c);
  } finally {
    c.release();
  }
}

main()
  .then(() => pool.end())
  .catch(err => {
    log(`ERROR: ${err.stack || err.message}`);
    pool.end();
    process.exit(1);
  });
