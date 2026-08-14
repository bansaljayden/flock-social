#!/usr/bin/env node
/**
 * Restorable database dump, with no pg_dump required.
 *
 * The old scripts/backup-data.js wrote `SELECT *` to JSON for a hand-written
 * table list that named two tables which never existed and omitted the entire
 * ML corpus. JSON also has no import path, so it was never actually a backup.
 *
 * This walks every table in the public schema (so it cannot fall out of date
 * the way a hardcoded list does), writes INSERT statements in an order that
 * respects foreign keys, and resets every sequence at the end. Restore is:
 *
 *     psql "$DATABASE_URL" -f database/schema.sql      # structure, from the repo
 *     psql "$DATABASE_URL" -f <this file's output>     # data
 *
 * Usage:  node scripts/dump-db.js [outfile]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// ---------------------------------------------------------------------------
// Where the dump is allowed to land.
//
// Security review: this file is not "user data", it is CREDENTIAL MATERIAL.
// A full dump contains users.password (bcrypt hashes), users.apple_refresh_token
// (a live Apple OAuth refresh token), device_tokens.token (APNs/FCM tokens that
// let the holder push to any user), sensor_devices.api_key, and
// password_reset_tokens.token (live reset tokens).
//
// backend/backups/ is gitignored; nothing else in the worktree is. The optional
// [outfile] argument used to accept any path, so one `node scripts/dump-db.js
// dump.sql` from the repo root dropped every one of those credentials into a
// tracked directory, one `git add -A` away from a push. The dump is now pinned
// to the ignored directory unless the operator explicitly opts out with
// DUMP_ALLOW_ANY_PATH=1 (for writing to somewhere outside the repo entirely).
// ---------------------------------------------------------------------------
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const REPO_ROOT = path.join(__dirname, '..', '..');

const OUT = path.resolve(
  process.argv[2]
    || path.join(BACKUP_DIR, `flock-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.sql`)
);

function assertSafeOutputPath(target) {
  if (process.env.DUMP_ALLOW_ANY_PATH === '1') return;
  const inBackups = target === BACKUP_DIR || target.startsWith(BACKUP_DIR + path.sep);
  if (inBackups) return;
  const inRepo = target === REPO_ROOT || target.startsWith(REPO_ROOT + path.sep);
  console.error(
    `\nRefusing to write the dump to:\n  ${target}\n\n` +
    'A full dump contains bcrypt password hashes, Apple refresh tokens, push\n' +
    'device tokens and password-reset tokens. Only backend/backups/ is gitignored,\n' +
    `so ${inRepo ? 'that path is inside the repo and committable' : 'that path is outside the protected directory'}.\n\n` +
    `Write it to ${BACKUP_DIR}\n` +
    'or, if you really mean to write outside the repo, re-run with DUMP_ALLOW_ANY_PATH=1.\n'
  );
  process.exit(1);
}

// Column names whose values are credentials rather than user content. Matched
// against every column actually dumped, so a migration that adds a new secret
// column gets flagged without anyone remembering to update a list here.
const SENSITIVE_COLUMN = /password|secret|token|api_key|private_key|refresh/i;

// Postgres literal escaping. Buffers become bytea hex, dates become ISO,
// objects become JSON. Anything else is quoted with doubled single quotes.
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v) || typeof v === 'object') {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  assertSafeOutputPath(OUT);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. It lives in backend/.env or the Railway Postgres service.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    // Railway's TCP proxy is slow to hand back the first packet and will drop
    // an idle socket mid-dump on a large table. Without the error handler an
    // 'error' event on the client is an unhandled throw that kills the process
    // halfway through writing the file.
    connectionTimeoutMillis: 30000,
    query_timeout: 300000,
    keepAlive: true,
  });
  client.on('error', (e) => console.error('pg client error:', e.message));
  await client.connect();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // Order tables so that a table is written after everything it references.
  // Self-references are ignored (they are nullable in this schema).
  const { rows: tables } = await client.query(`
    SELECT c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const { rows: fks } = await client.query(`
    SELECT c.relname AS child, f.relname AS parent
    FROM pg_constraint co
    JOIN pg_class c ON c.oid = co.conrelid
    JOIN pg_class f ON f.oid = co.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE co.contype = 'f' AND n.nspname = 'public' AND c.relname <> f.relname
  `);

  const names = tables.map((t) => t.table);
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of fks) {
    if (deps.has(child) && names.includes(parent)) deps.get(child).add(parent);
  }
  const ordered = [];
  const seen = new Set();
  const visit = (n, stack = new Set()) => {
    if (seen.has(n) || stack.has(n)) return;   // cycle: emit in whatever order we reached it
    stack.add(n);
    for (const p of deps.get(n) || []) visit(p, stack);
    stack.delete(n);
    seen.add(n);
    ordered.push(n);
  };
  names.forEach((n) => visit(n));

  // 0600: the dump holds live credentials, so it is readable only by the user
  // that produced it. (No-op on Windows; correct everywhere the dump is likely
  // to be taken from, which is a Linux shell against the Railway proxy.)
  const out = fs.createWriteStream(OUT, { mode: 0o600 });
  const write = (s) => new Promise((res) => (out.write(s) ? res() : out.once('drain', res)));

  await write(`-- Flock data dump ${new Date().toISOString()}\n`);
  await write(`-- Restore: create structure from database/schema.sql + migrations, then run this file.\n`);
  await write(`BEGIN;\nSET session_replication_role = replica;\n\n`);

  let grand = 0;
  const counts = [];
  // Reported at the end so the operator knows, concretely and per run, what
  // they are now holding — the set grows whenever a migration adds a column,
  // which is exactly when a stale comment would have stopped being true.
  const credentialColumns = new Set();
  for (const table of ordered) {
    const { rows } = await client.query(`SELECT * FROM "${table}"`);
    if (!rows.length) { counts.push([table, 0]); continue; }
    const cols = Object.keys(rows[0]);
    for (const c of cols) {
      if (SENSITIVE_COLUMN.test(c)) credentialColumns.add(`${table}.${c}`);
    }
    const collist = cols.map((c) => `"${c}"`).join(', ');
    await write(`-- ${table} (${rows.length})\n`);
    // Batch so a huge table does not become one unreadable statement.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk.map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`).join(',\n  ');
      await write(`INSERT INTO "${table}" (${collist}) VALUES\n  ${values}\nON CONFLICT DO NOTHING;\n`);
    }
    await write('\n');
    counts.push([table, rows.length]);
    grand += rows.length;
  }

  // Sequences: without this every SERIAL id collides on the first insert after a restore.
  const { rows: seqs } = await client.query(`
    SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
  `);
  if (seqs.length) {
    await write('-- sequences\n');
    for (const { sequence_name } of seqs) {
      const { rows } = await client.query(`SELECT last_value, is_called FROM "${sequence_name}"`);
      const { last_value, is_called } = rows[0];
      await write(`SELECT setval('"${sequence_name}"', ${last_value}, ${is_called ? 'true' : 'false'});\n`);
    }
    await write('\n');
  }

  await write(`SET session_replication_role = DEFAULT;\nCOMMIT;\n`);
  await new Promise((res) => out.end(res));
  await client.end();

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
  console.log(`\nWrote ${OUT}  (${mb} MB, ${grand} rows across ${ordered.length} tables)\n`);
  counts.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(8)}  ${t}`));
  const empty = counts.filter(([, n]) => n === 0).map(([t]) => t);
  if (empty.length) console.log(`\n  empty: ${empty.join(', ')}`);

  if (credentialColumns.size) {
    console.log(
      '\n  ------------------------------------------------------------------\n' +
      '  This file contains CREDENTIALS in cleartext, not just user data:\n' +
      [...credentialColumns].sort().map((c) => `    - ${c}`).join('\n') +
      '\n\n  Treat it like a password vault: do not commit it, do not paste it\n' +
      '  into an issue or a chat, and delete it when the restore is done.\n' +
      '  ------------------------------------------------------------------'
    );
  }
}

main().catch((err) => { console.error('Dump failed:', err.message); process.exit(1); });
