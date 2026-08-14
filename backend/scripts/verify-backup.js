#!/usr/bin/env node
/**
 * Restore-verify a Flock dump. A backup that has never been restored is a hope,
 * not a backup, and this file is the other half of scripts/dump-db.js: it takes
 * a dump, restores it into a throwaway embedded Postgres, and then checks that
 * what came out is the database that went in.
 *
 * Usage:
 *     node scripts/verify-backup.js <path-to-dump.sql | .sql.gz>
 *
 * Encrypted (.gpg) files are refused on purpose. Decryption is a human step
 * with a human-held passphrase (see BACKUP-AND-VERIFICATION.md); decrypt to a
 * pipe or a temp file first:
 *     gpg -d backups/flock-STAMP.sql.gz.gpg > /tmp/flock-STAMP.sql.gz
 *     node scripts/verify-backup.js /tmp/flock-STAMP.sql.gz
 * and destroy the plaintext afterwards.
 *
 * What it proves, in order:
 *   1. STRUCTURE  — the file is a complete dump-db.js dump: header present,
 *                   BEGIN + replica mode at the top, COMMIT; as the last line
 *                   (dump-db.js writes COMMIT; last, so this catches a dump
 *                   truncated mid-write), and a per-table row-count manifest
 *                   (the `-- table (N)` comments the dump carries).
 *   2. SCHEMA     — a fresh database is built from the repo's migrations alone,
 *                   via the same db/migrate.js that production boots run.
 *   3. RESTORE    — every statement in the dump executes, first error aborts
 *                   loudly with the table and statement it died in. This is the
 *                   psql ON_ERROR_STOP=1 semantic, without needing psql.
 *   4. MIGRATIONS — the restored schema_migrations matches the repo's migration
 *                   file list exactly. An extra name means the dump came from a
 *                   NEWER schema than this checkout, and restoring it here
 *                   would be a silent downgrade.
 *   5. COUNTS     — every table's restored row count equals the manifest count
 *                   the dump carries. A single dropped row fails here.
 *   6. INTEGRITY  — every foreign key in the schema is swept for orphans.
 *                   This is not paranoia: the dump restores under
 *                   session_replication_role = replica, which DISABLES foreign
 *                   key enforcement, so a corrupt dump can insert orphans
 *                   without a single error. This sweep is the only net.
 *   7. SEQUENCES  — every serial sequence is positioned above its table's max
 *                   id, so the first INSERT after a real restore does not
 *                   collide on a duplicate primary key.
 *   8. INVARIANTS — named semantic checks: no user without an email, no
 *                   flock_member without a flock, every ml_training_data row
 *                   resolves to an ml_venues row, busyness_pct in range.
 *
 * What it CANNOT prove: a value silently corrupted in place (row counts and
 * constraints intact, contents wrong) is invisible to every check here, and so
 * is anything that happened to the database BEFORE the dump was taken. It also
 * does not touch encryption — verify the .gpg with its .sha256 and `gzip -t`
 * per the runbook before decrypting.
 *
 * Runs entirely against an embedded Postgres in a temp directory. It cannot
 * touch production: DATABASE_URL is never read.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ---------------------------------------------------------------------------
// Dump-format helpers. These target the exact output of scripts/dump-db.js:
// line comments only at statement boundaries, single-quoted literals with ''
// escaping (which may span lines), every statement ending with `;` at end of
// line. No dollar quoting, no block comments. If dump-db.js ever changes its
// format, change these with it — the unit test pins the contract.
// ---------------------------------------------------------------------------

// `-- users (12)` -> { table: 'users', count: 12 }. Anything else -> null.
// The other comments a dump contains (`-- Flock data dump ...`, `-- Restore:`,
// `-- sequences`) do not match this shape.
function parseManifestLine(line) {
  const m = /^-- ([A-Za-z_][A-Za-z0-9_]*) \((\d+)\)\s*$/.exec(line);
  return m ? { table: m[1], count: Number(m[2]) } : null;
}

// Reassembles statements from a stream of lines, tracking single-quote state
// so a literal containing `;` or spanning lines cannot end a statement early.
// push(line) returns a completed statement or null; comments at statement
// boundaries go to onComment.
class StatementAssembler {
  constructor(onComment) {
    this.lines = [];
    this.inSingle = false;
    this.onComment = onComment || (() => {});
  }
  push(rawLine) {
    if (!this.inSingle && this.lines.length === 0) {
      const probe = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (probe.trim() === '') return null;
      if (probe.startsWith('--')) { this.onComment(probe); return null; }
    }
    // Walk the quote state first. '' inside a literal toggles twice: net
    // unchanged, which is exactly right for an escaped quote. (\r never
    // affects quote state, so scanning before the strip below is safe.)
    let inSingle = this.inSingle;
    for (let i = 0; i < rawLine.length; i++) {
      if (rawLine[i] === "'") inSingle = !inSingle;
    }
    // Strip one trailing \r (CRLF transfer artifact) only when the line ENDS
    // outside a literal — a \r at the end of a line INSIDE a literal is data.
    // The end-of-line state is the one that matters: a literal can open
    // mid-line, in which case the start-of-line state would lie.
    const line = !inSingle && rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    this.lines.push(line);
    this.inSingle = inSingle;
    if (!inSingle && /;\s*$/.test(line)) {
      const stmt = this.lines.join('\n');
      this.lines = [];
      return stmt;
    }
    return null;
  }
  // True if a statement is still open (file ended mid-statement or mid-literal).
  dangling() {
    return this.inSingle || this.lines.length > 0;
  }
}

function openDumpStream(file) {
  const raw = fs.createReadStream(file);
  if (!file.endsWith('.gz')) return raw;
  const gz = zlib.createGunzip();
  raw.pipe(gz);
  // A truncated or corrupt gzip errors on the gunzip stream; surface it on the
  // stream the caller is reading.
  raw.on('error', (e) => gz.destroy(e));
  return gz;
}

// ---------------------------------------------------------------------------
// Result collection. Every check lands here so the summary at the end can be
// read by someone who has never seen this codebase.
// ---------------------------------------------------------------------------
const results = [];
function record(section, ok, detail) {
  results.push({ section, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${detail}`);
  return ok;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Pass 1: structure scan. Streams the file once, no database involved.
// ---------------------------------------------------------------------------
async function scanStructure(file) {
  const manifest = new Map();
  let firstLine = null;
  let lastNonBlank = null;
  let sawBegin = false;
  let sawReplica = false;
  let setvals = 0;
  let lineCount = 0;

  const rl = readline.createInterface({ input: openDumpStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    lineCount++;
    if (firstLine === null) firstLine = line;
    if (line.trim() !== '') lastNonBlank = line.trim();
    if (line.startsWith('BEGIN;')) sawBegin = true;
    if (line.startsWith('SET session_replication_role = replica;')) sawReplica = true;
    if (line.startsWith("SELECT setval(")) setvals++;
    const m = parseManifestLine(line);
    if (m) manifest.set(m.table, (manifest.get(m.table) || 0) + m.count);
  }

  console.log('\n[1/8] Dump structure');
  let ok = true;
  ok = record('structure', /^-- Flock data dump /.test(firstLine || ''),
    `file starts with the dump-db.js header (${(firstLine || '<empty file>').slice(0, 60)})`) && ok;
  ok = record('structure', sawBegin && sawReplica,
    'transaction preamble present (BEGIN + replica mode)') && ok;
  ok = record('structure', lastNonBlank === 'COMMIT;',
    lastNonBlank === 'COMMIT;'
      ? 'last line is COMMIT; — the dump was not cut off mid-write'
      : `last line is "${String(lastNonBlank).slice(0, 60)}" instead of COMMIT; — the dump is TRUNCATED or was interrupted mid-write`) && ok;
  ok = record('structure', manifest.size > 0,
    `row-count manifest found for ${manifest.size} table(s)`) && ok;
  ok = record('structure', setvals > 0,
    setvals > 0
      ? `${setvals} sequence reset(s) present`
      : 'no sequence resets found — inserts after a restore would collide on duplicate ids') && ok;

  return { ok, manifest, lineCount };
}

// ---------------------------------------------------------------------------
// Pass 2: restore. Streams the file again, executing statement by statement.
// First error aborts with the table it died in — psql ON_ERROR_STOP semantics.
// ---------------------------------------------------------------------------
async function restoreDump(file, client) {
  let currentTable = '(preamble)';
  let statements = 0;
  const assembler = new StatementAssembler((comment) => {
    const m = parseManifestLine(comment);
    if (m) currentTable = m.table;
  });

  const rl = readline.createInterface({ input: openDumpStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const stmt = assembler.push(line);
    if (!stmt) continue;
    try {
      await client.query(stmt);
      statements++;
    } catch (e) {
      const head = stmt.split('\n')[0].slice(0, 120);
      throw new Error(
        `restore died in table "${currentTable}" after ${statements} statement(s):\n` +
        `    ${e.message}\n` +
        `    statement began: ${head}\n` +
        (/(column|relation) .* does not exist/.test(e.message)
          ? '    (a missing column/table usually means the dump was taken from a NEWER schema than this checkout — pull the repo the dump was made against)\n'
          : '')
      );
    }
  }
  if (assembler.dangling()) {
    throw new Error(`the file ends mid-statement in table "${currentTable}" — the dump is truncated`);
  }
  return statements;
}

// ---------------------------------------------------------------------------
// Checks against the restored database.
// ---------------------------------------------------------------------------
async function checkMigrations(client) {
  console.log('\n[4/8] Migrations vs the repo');
  const repoFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query('SELECT name FROM schema_migrations ORDER BY name');
  const dbNames = rows.map((r) => r.name);
  const repoSet = new Set(repoFiles);
  const dbSet = new Set(dbNames);
  const extra = dbNames.filter((n) => !repoSet.has(n));
  const missing = repoFiles.filter((n) => !dbSet.has(n));

  let ok = true;
  ok = record('migrations', extra.length === 0,
    extra.length === 0
      ? `no migration names beyond this repo's ${repoFiles.length} files`
      : `dump carries migration(s) this repo does not have: ${extra.join(', ')} — the backup is from a NEWER schema than this checkout; restoring it here would silently downgrade the schema`) && ok;
  ok = record('migrations', missing.length === 0,
    missing.length === 0
      ? 'every repo migration is recorded as applied'
      : `migrations not recorded as applied: ${missing.join(', ')}`) && ok;
  return ok;
}

async function checkRowCounts(client, manifest) {
  console.log('\n[5/8] Row counts vs the manifest');
  let ok = true;
  for (const [table, expected] of [...manifest.entries()].sort()) {
    let n;
    try {
      const r = await client.query(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
      n = Number(r.rows[0].n);
    } catch (e) {
      ok = record('counts', false, `${table}: cannot count rows (${e.message})`);
      continue;
    }
    if (table === 'schema_migrations') {
      // migrate.js legitimately records migrations newer than the dump, and
      // the dump's own rows land ON CONFLICT DO NOTHING. Never fewer, though.
      ok = record('counts', n >= expected,
        `${table}: ${n} rows (dump had ${expected}; newer repo migrations may add more, fewer would be a loss)`) && ok;
    } else {
      ok = record('counts', n === expected,
        n === expected
          ? `${table}: ${n} rows, matches the manifest`
          : `${table}: manifest says ${expected} rows, restored table has ${n} — ${n < expected ? 'rows were LOST' : 'rows appeared from nowhere'}`) && ok;
    }
  }
  // A table the manifest does not mention was empty (or absent) at dump time,
  // so nothing should have restored into it.
  const { rows: allTables } = await client.query(`
    SELECT c.relname AS t FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  let unexpected = 0;
  for (const { t } of allTables) {
    if (manifest.has(t) || t === 'schema_migrations') continue;
    const r = await client.query(`SELECT COUNT(*)::bigint AS n FROM "${t}"`);
    if (Number(r.rows[0].n) !== 0) {
      unexpected++;
      ok = record('counts', false, `${t}: not in the manifest but has ${r.rows[0].n} rows after restore`);
    }
  }
  if (unexpected === 0) record('counts', true, 'all tables outside the manifest are empty, as expected');
  return ok;
}

async function checkForeignKeys(client) {
  console.log('\n[6/8] Referential integrity (replica-mode restore disables FK enforcement, so this sweep is the only net)');
  const { rows: fks } = await client.query(`
    SELECT co.conname, co.conrelid, co.confrelid, co.conkey, co.confkey,
           c.relname AS child, f.relname AS parent
    FROM pg_constraint co
    JOIN pg_class c ON c.oid = co.conrelid
    JOIN pg_class f ON f.oid = co.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE co.contype = 'f' AND n.nspname = 'public'
    ORDER BY c.relname, co.conname`);

  const attName = async (relid, attnum) => {
    const r = await client.query(
      'SELECT attname FROM pg_attribute WHERE attrelid = $1 AND attnum = $2', [relid, attnum]);
    return r.rows[0].attname;
  };

  let ok = true;
  let orphanedConstraints = 0;
  for (const fk of fks) {
    const childCols = [];
    const parentCols = [];
    for (let i = 0; i < fk.conkey.length; i++) {
      childCols.push(await attName(fk.conrelid, fk.conkey[i]));
      parentCols.push(await attName(fk.confrelid, fk.confkey[i]));
    }
    // MATCH SIMPLE: the constraint only binds rows where every FK column is
    // non-null, so the sweep checks exactly those rows.
    const notNull = childCols.map((c) => `c."${c}" IS NOT NULL`).join(' AND ');
    const join = childCols.map((c, i) => `p."${parentCols[i]}" = c."${c}"`).join(' AND ');
    const q = `SELECT COUNT(*)::bigint AS n FROM "${fk.child}" c
               WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM "${fk.parent}" p WHERE ${join})`;
    const r = await client.query(q);
    const n = Number(r.rows[0].n);
    if (n !== 0) {
      orphanedConstraints++;
      ok = record('integrity', false,
        `${fk.child}.${childCols.join('+')} -> ${fk.parent}: ${n} orphaned row(s) reference a ${fk.parent} row that does not exist`);
    }
  }
  if (orphanedConstraints === 0) {
    record('integrity', true, `all ${fks.length} foreign keys swept, zero orphaned rows`);
  }
  return ok;
}

async function checkSequences(client, manifest) {
  console.log('\n[7/8] Sequences (a mispositioned sequence means the first insert after a real restore collides on a duplicate id)');
  const { rows: seqs } = await client.query(`
    SELECT s.relname AS seq, c.relname AS tbl, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
    JOIN pg_class c ON c.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
    JOIN pg_namespace n ON n.oid = s.relnamespace
    WHERE s.relkind = 'S' AND n.nspname = 'public'
    ORDER BY c.relname`);

  let ok = true;
  let checked = 0;
  let bad = 0;
  for (const { seq, tbl, col } of seqs) {
    if (!manifest.has(tbl) || manifest.get(tbl) === 0) continue; // empty table: nothing to collide with
    const mx = await client.query(`SELECT MAX("${col}")::bigint AS m FROM "${tbl}"`);
    const m = mx.rows[0].m === null ? null : Number(mx.rows[0].m);
    if (m === null) continue;
    const sv = await client.query(`SELECT last_value, is_called FROM "${seq}"`);
    const { last_value, is_called } = sv.rows[0];
    const nextVal = is_called ? Number(last_value) + 1 : Number(last_value);
    checked++;
    if (nextVal <= m) {
      bad++;
      ok = record('sequences', false,
        `${tbl}.${col}: max id is ${m} but the sequence would hand out ${nextVal} next — the dump's setval is missing or wrong`);
    }
  }
  if (bad === 0) record('sequences', true, `${checked} sequence(s) checked, all positioned past their table's max id`);
  return ok;
}

async function checkInvariants(client) {
  console.log('\n[8/8] Semantic invariants');
  let ok = true;
  const invariants = [
    ['every user has an email address',
      `SELECT COUNT(*)::bigint AS n FROM users WHERE email IS NULL OR btrim(email) = ''`],
    ['every flock_member belongs to a flock that exists',
      `SELECT COUNT(*)::bigint AS n FROM flock_members fm
       LEFT JOIN flocks f ON f.id = fm.flock_id
       WHERE fm.flock_id IS NULL OR f.id IS NULL`],
    ['every flock_member is a user that exists',
      `SELECT COUNT(*)::bigint AS n FROM flock_members fm
       LEFT JOIN users u ON u.id = fm.user_id
       WHERE fm.user_id IS NULL OR u.id IS NULL`],
    ['every ML training row resolves to a known venue (the corpus is intact)',
      `SELECT COUNT(*)::bigint AS n FROM ml_training_data t
       LEFT JOIN ml_venues v ON v.id = t.venue_id
       WHERE v.id IS NULL`],
    ['every ML training busyness value is in range 0..100',
      `SELECT COUNT(*)::bigint AS n FROM ml_training_data
       WHERE busyness_pct IS NULL OR busyness_pct < 0 OR busyness_pct > 100`],
  ];
  for (const [name, sql] of invariants) {
    try {
      const r = await client.query(sql);
      const n = Number(r.rows[0].n);
      ok = record('invariants', n === 0,
        n === 0 ? name : `${name} — VIOLATED by ${n} row(s)`) && ok;
    } catch (e) {
      ok = record('invariants', false, `${name} — check could not run (${e.message})`);
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      'Usage: node scripts/verify-backup.js <path-to-dump.sql | .sql.gz>\n\n' +
      'Restores the dump into a throwaway embedded Postgres and verifies it.\n' +
      'Never touches production; DATABASE_URL is not read.'
    );
    process.exit(2);
  }
  const file = path.resolve(arg);
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }
  if (file.endsWith('.gpg')) {
    console.error(
      'This is the encrypted backup. Decryption is a human step and this script\n' +
      'never handles the passphrase. Decrypt first, verify, then destroy the plaintext:\n\n' +
      '    gpg -d backups/flock-STAMP.sql.gz.gpg > /tmp/flock-STAMP.sql.gz\n' +
      '    node scripts/verify-backup.js /tmp/flock-STAMP.sql.gz\n' +
      '    rm -f /tmp/flock-STAMP.sql.gz'
    );
    process.exit(2);
  }

  const started = Date.now();
  const sizeMb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`Verifying ${file} (${sizeMb} MB${file.endsWith('.gz') ? ', gzipped' : ''})`);

  // ---- pass 1: structure --------------------------------------------------
  let scan;
  try {
    scan = await scanStructure(file);
  } catch (e) {
    console.error(`\nCould not read the dump at all: ${e.message}`);
    if (file.endsWith('.gz')) console.error('A gzip error here means the archive itself is corrupt or truncated.');
    return finish(false, started);
  }
  if (!scan.ok) {
    console.error('\nStructural checks failed — not attempting a restore of a file that is already known broken.');
    return finish(false, started);
  }
  const totalExpected = [...scan.manifest.values()].reduce((a, b) => a + b, 0);
  console.log(`\n  Manifest: ${scan.manifest.size} tables, ${totalExpected.toLocaleString()} rows expected.`);

  // ---- embedded postgres --------------------------------------------------
  const EP = require('embedded-postgres');
  const EmbeddedPostgres = EP.default || EP;
  const { Pool, Client } = require('pg');

  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), `flock-verify-pg-${Date.now()}`);
  // initdb and the postgres server are chatty on stdout; buffer their output
  // and only show it if setup actually fails, so the report stays readable.
  const pgLog = [];
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: (msg) => pgLog.push(String(msg)),
    onError: (msg) => pgLog.push(String(msg)),
  });

  console.log('\n[2/8] Building a fresh schema from the repo migrations (embedded Postgres, first run downloads binaries)');
  let client = null;
  let pool = null;
  let passed = false;
  try {
    await pg.initialise();
    await pg.start();
    // NOT pg.createDatabase(): on Windows initdb inherits the OS locale, so the
    // cluster default encoding is WIN1252 — and a dump containing any emoji or
    // non-Latin text (i.e. any real Flock dump; the messages table is Gen Z
    // chat) dies mid-restore with "has no equivalent in encoding WIN1252".
    // Production is UTF8, so the throwaway database must be too. Measured, not
    // theorised: a fixture row containing Cyrillic failed exactly that way.
    {
      const admin = new Client({
        connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
      });
      await admin.connect();
      await admin.query(
        `CREATE DATABASE flock_verify ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`
      );
      await admin.end();
    }
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/flock_verify`;

    // The same migration runner production boots use, pointed at the throwaway
    // database via its own pool — process.env.DATABASE_URL is never involved.
    pool = new Pool({ connectionString: url, max: 3 });
    const { migrate } = require('../db/migrate');
    await migrate(pool);
    record('schema', true, 'schema built from migrations alone (same runner as a production boot)');

    client = new Client({ connectionString: url });
    await client.connect();

    // ---- pass 2: restore --------------------------------------------------
    console.log('\n[3/8] Restoring the dump, statement by statement');
    let restored = false;
    try {
      const statements = await restoreDump(file, client);
      record('restore', true, `${statements} statement(s) executed, zero errors`);
      restored = true;
    } catch (e) {
      record('restore', false, e.message);
      // The transaction the dump opened is now aborted; nothing downstream can
      // run, and there is no point pretending otherwise.
      await client.query('ROLLBACK').catch(() => {});
    }

    // ---- checks ------------------------------------------------------------
    if (restored) {
      let ok = true;
      ok = (await checkMigrations(client)) && ok;
      ok = (await checkRowCounts(client, scan.manifest)) && ok;
      ok = (await checkForeignKeys(client)) && ok;
      ok = (await checkSequences(client, scan.manifest)) && ok;
      ok = (await checkInvariants(client)) && ok;
      passed = ok;
    }
  } catch (e) {
    record('setup', false, `verification could not run: ${e.message}`);
    const tail = pgLog.slice(-25).join('\n').trim();
    if (tail) console.error(`\nEmbedded Postgres output (last lines):\n${tail}`);
    passed = false;
  } finally {
    if (client) await client.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    // Teardown must never decide the verdict: on Windows pg.stop() can hit
    // EBUSY removing the temp dir while postgres is still releasing files
    // (same caveat as scripts/e2e-local.js). The results above stand. A full
    // production restore leaves a multi-GB data directory, so it is worth a
    // patient retry rather than telling the operator to delete it by hand —
    // fs.rm's maxRetries exists for exactly this Windows condition.
    try {
      await pg.stop();
    } catch (e) {
      try {
        await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (e2) {
        console.warn(`\n(cleanup) could not remove the throwaway data directory: ${e2.message}`);
        console.warn(`(cleanup) delete ${dataDir} by hand; the results above stand.`);
      }
    }
  }
  return finish(passed, started);
}

function finish(passed, started) {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const failures = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  if (passed && failures.length === 0) {
    console.log(`VERDICT: PASS (${secs}s)`);
    console.log('This backup restored completely into a fresh database and every check');
    console.log('passed. It is safe to encrypt, upload, and rely on.');
  } else {
    console.log(`VERDICT: FAIL — DO NOT trust this backup file. (${secs}s)`);
    console.log(`${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  - [${f.section}] ${f.detail.split('\n')[0]}`);
    console.log('\nTake a fresh dump with `node scripts/dump-db.js`, verify it, and only');
    console.log('encrypt/upload a dump that passes. If a fresh dump also fails, the');
    console.log('problem is in the live database or in dump-db.js — investigate before');
    console.log('the next retention window deletes the last good backup.');
  }
  console.log('='.repeat(70));
  process.exit(passed && failures.length === 0 ? 0 : 1);
}

module.exports = { parseManifestLine, StatementAssembler };

if (require.main === module) {
  main().catch((e) => {
    console.error('verify-backup crashed:', e);
    process.exit(1);
  });
}
