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
// (a live Apple OAuth refresh token), device_tokens.token and
// flock_invite_links.token / guest_rsvps.guest_token (bearer capabilities — the
// push tokens let the holder notify any user, the link tokens let them join a
// private flock), and sensor_devices.api_key.
//
// Round 17 correction: this used to claim "password_reset_tokens.token (live
// reset tokens)". No such table exists. Migration 015 stores a reset as a SPLIT
// token — password_resets.selector is the public lookup half and verifier_hash
// is a SHA-256 of a secret half that is never written down — so a dump contains
// no usable reset link, and the same is true of email_verifications. Naming a
// table that does not exist in the one comment operators read before handling
// this file is how a warning stops being believed, so it is corrected rather
// than left generously vague.
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

// Round 17 re-audit: the first version of this compared paths case-SENSITIVELY,
// and path.resolve() preserves case on Windows down to the drive letter. So
// `node scripts/dump-db.js c:/users/jayden/flock-app/leak.sql` did not look like
// an in-repo path at all, and with DUMP_ALLOW_ANY_PATH=1 it was allowed to
// write a full credential dump into the tracked worktree. Measured, then fixed.
//
// Two comparators, because they are two different questions:
//  - "is this the gitignored backups directory": must follow the FILESYSTEM's
//    own rules. On Linux, backend/BACKUPS is a genuinely different directory
//    and .gitignore does not cover it, so matching it case-insensitively there
//    would allow exactly what this guard exists to stop.
//  - "is this inside the repo at all": always case-insensitive. Over-refusing a
//    path costs one retyped command; under-refusing costs a credential leak.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const under = (target, dir, fold) => {
  const t = fold ? target.toLowerCase() : target;
  const d = fold ? dir.toLowerCase() : dir;
  return t === d || t.startsWith(d + path.sep);
};
const withinBackups = (target) => under(target, BACKUP_DIR, CASE_INSENSITIVE_FS);
const withinRepo = (target) => under(target, REPO_ROOT, true);

function assertSafeOutputPath(target) {
  if (withinBackups(target)) return;

  // Round 17: the opt-out used to be the FIRST line of this function, so
  // DUMP_ALLOW_ANY_PATH=1 disabled every check including the one that matters.
  // Its own error message says the flag is for "writing to somewhere outside
  // the repo entirely" — now that is all it does. A committable path is the
  // single failure this guard exists to prevent, and no environment variable
  // should be able to wave it through, least of all one an operator sets once
  // and leaves exported in a shell for the rest of the session.
  const inRepo = withinRepo(target);
  if (!inRepo && process.env.DUMP_ALLOW_ANY_PATH === '1') return;

  console.error(
    `\nRefusing to write the dump to:\n  ${target}\n\n` +
    'A full dump contains bcrypt password hashes, Apple refresh tokens, push\n' +
    'device tokens, flock invite tokens and sensor API keys. Only backend/backups/\n' +
    `is gitignored, so ${inRepo ? 'that path is inside the repo and committable' : 'that path is outside the protected directory'}.\n\n` +
    `Write it to ${BACKUP_DIR}\n` +
    (inRepo
      ? 'Paths inside the repo are refused outright; DUMP_ALLOW_ANY_PATH does not cover them.\n'
      : 'or, if you really mean to write outside the repo, re-run with DUMP_ALLOW_ANY_PATH=1.\n')
  );
  process.exit(1);
}

// Column names whose values are credentials rather than user content. Matched
// against every column actually dumped, so a migration that adds a new secret
// column gets flagged without anyone remembering to update a list here.
const SENSITIVE_COLUMN = /password|secret|token|api_key|private_key|refresh/i;

// A second class, added in round 17 alongside migrations 011/012/015. These are
// NOT credentials — they are keyed HMACs and split-token halves whose secret
// counterpart was never stored, so nobody can replay them out of this file, and
// calling them credentials would dilute the warning above until it is ignored.
// They still need saying, because each one is retention-bound at the row level
// (banned_identities expires after 365 days; a verification or reset link dies
// in 24h or 1h) and a dump copies them somewhere with no expiry at all. The
// ban-evasion digests in particular are identity data about users who are
// frequently minors. Same principle as above: a regex over the columns that
// actually exist, not a list someone has to remember to extend.
const RETENTION_BOUND_COLUMN = /hash|digest|verifier|selector|email_key/i;

// Postgres ARRAY input syntax: {a,b}, elements always double-quoted so that
// commas, braces, backslashes, empty strings and the literal word NULL inside a
// value cannot change the parse. An unquoted NULL is a real SQL NULL element,
// which is why that one case is not quoted.
function pgArrayBody(arr) {
  return '{' + arr.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return pgArrayBody(v);
    const s = v instanceof Date ? v.toISOString()
      : Buffer.isBuffer(v) ? `\\x${v.toString('hex')}`
        : typeof v === 'object' ? JSON.stringify(v)
          : String(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(',') + '}';
}

// Postgres literal escaping. Buffers become bytea hex, dates become ISO.
//
// ROUND 17 — THIS FILE DID NOT RESTORE.
// Every non-scalar was emitted as `'<json>'::jsonb`, and that explicit cast is
// what broke it: a TEXT[] column is not a jsonb column, so restoring a dump of
// any real database died on the FIRST table with
//   ERROR: column "interests" is of type text[] but expression is of type jsonb
// (users.interests, venue_profiles.goals, ml_venues.google_types are all
// TEXT[]). The tool's entire premise is the word "restorable" in its own
// docblock, and it was false — measured by dumping a populated database and
// replaying the output into a freshly migrated one.
//
// The fix is to stop guessing from the JavaScript value and use the type the
// server actually reported for the column (res.fields[i].dataTypeID), and to
// drop the cast. An UNTYPED quoted literal in INSERT ... VALUES is coerced to
// whatever the target column is, so one representation restores correctly into
// text[], jsonb, json, inet, or anything else added later — while `::jsonb`
// asserts a type the column may not have.
function lit(v, typeName) {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (v instanceof Date) return `'${v.toISOString()}'`;
  // Arrays: only when the COLUMN is an array type. pg parses a jsonb column
  // holding a JSON array into a JS array too, and that one must stay JSON.
  if (Array.isArray(v) && typeof typeName === 'string' && typeName.startsWith('_')) {
    return `'${pgArrayBody(v).replace(/'/g, "''")}'`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v) || typeof v === 'object') {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
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

  // Type name per column OID, so lit() can tell a text[] column from a jsonb
  // one holding a JSON array. Cheap: one query, ~600 rows.
  const { rows: pgTypes } = await client.query('SELECT oid, typname FROM pg_type');
  const typeNameByOid = new Map(pgTypes.map((t) => [Number(t.oid), t.typname]));

  // 0600: the dump holds live credentials, so it is readable only by the user
  // that produced it. (No-op on Windows; correct everywhere the dump is likely
  // to be taken from, which is a Linux shell against the Railway proxy.)
  //
  // Round 17: the `mode` option only applies when open(2) actually CREATES the
  // file. Re-running a dump over a path that already exists — the same filename
  // twice, or a file someone else left there — kept the OLD permissions, so the
  // one case where the mode matters most (a world-readable leftover) was
  // exactly the case it did not cover. chmod unconditionally after opening.
  const out = fs.createWriteStream(OUT, { mode: 0o600 });
  try { fs.chmodSync(OUT, 0o600); } catch (_) { /* Windows / non-POSIX fs */ }
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
  const retentionColumns = new Set();
  for (const table of ordered) {
    const res = await client.query(`SELECT * FROM "${table}"`);
    const rows = res.rows;
    if (!rows.length) { counts.push([table, 0]); continue; }
    // From res.fields, not Object.keys(rows[0]): the field list carries the
    // column type the server reported, and it is also the only correct source
    // when a row happens to hold JS `undefined` for a column.
    const cols = res.fields.map((f) => f.name);
    const colType = res.fields.map((f) => typeNameByOid.get(f.dataTypeID));
    for (const c of cols) {
      if (SENSITIVE_COLUMN.test(c)) credentialColumns.add(`${table}.${c}`);
      else if (RETENTION_BOUND_COLUMN.test(c)) retentionColumns.add(`${table}.${c}`);
    }
    const collist = cols.map((c) => `"${c}"`).join(', ');
    await write(`-- ${table} (${rows.length})\n`);
    // Batch so a huge table does not become one unreadable statement.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = chunk
        .map((r) => `(${cols.map((c, ci) => lit(r[c], colType[ci])).join(', ')})`)
        .join(',\n  ');
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

  if (credentialColumns.size || retentionColumns.size) {
    const block = ['\n  ------------------------------------------------------------------'];
    if (credentialColumns.size) {
      block.push(
        '  This file contains CREDENTIALS in cleartext, not just user data:',
        ...[...credentialColumns].sort().map((c) => `    - ${c}`)
      );
    }
    if (retentionColumns.size) {
      block.push(
        credentialColumns.size ? '' : '  This file contains regulated material, not just user data:',
        '  It also copies digest and link-record columns out of their retention',
        '  window. They expire in the database and not in this file, and',
        '  banned_identities is identity data about users who are often minors.',
        '  Treat them as sensitive even though they are hashes:',
        ...[...retentionColumns].sort().map((c) => `    - ${c}`)
      );
    }
    block.push(
      '',
      '  Treat it like a password vault: do not commit it, do not paste it',
      '  into an issue or a chat, and delete it when the restore is done.',
      '  ------------------------------------------------------------------'
    );
    console.log(block.join('\n'));
  }
}

main().catch((err) => { console.error('Dump failed:', err.message); process.exit(1); });
