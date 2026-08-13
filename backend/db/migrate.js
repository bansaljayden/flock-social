// ---------------------------------------------------------------------------
// Versioned migrations. Files in backend/migrations/*.sql run in name order,
// once each, recorded in schema_migrations.
//
// Three modes, chosen by a directive on the FIRST line:
//  - default: the whole file runs in ONE transaction; any error rolls back,
//    logs loudly, and FAILS THE BOOT. No more silent partially-migrated
//    deployments (the old inline runner swallowed errors per-group).
//  - `-- @tolerant`: statements run one-by-one and errors are logged but
//    skipped. Reserved for 001_baseline.sql, which replays the historical
//    idempotent DDL against databases in unknown drift states.
//  - `-- @noTransaction`: statements run one-by-one, each autocommitting, and
//    the FIRST error fails the boot. For DDL that cannot live in a transaction
//    block (CREATE INDEX CONCURRENTLY) or that must not share one
//    (ADD CONSTRAINT NOT VALID + VALIDATE — see 004).
//
// The whole run happens on ONE dedicated connection so the session-level
// advisory lock and the session timeouts below actually apply to every
// statement (round 12: tolerant mode used to borrow arbitrary pool
// connections, where a `SET` would not stick).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

// Fixed app-wide key for pg_advisory_lock — serializes migration runs across
// replicas / rolling deploys so two boots can't race the same file.
const MIGRATION_LOCK_KEY = 727501842;

// Round 12 (migration safety): a rolling deploy must not be able to block
// forever. The advisory lock is polled with pg_try_advisory_lock against a
// deadline rather than waited on indefinitely, lock_timeout stops any DDL from
// queueing behind a long-running query (which would also stall everything
// arriving after it), and statement_timeout caps a single runaway statement.
// Losing the race is a clean FATAL: server.js exits and the platform restarts
// us, which is recoverable — a wedged boot is not.
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 1_000;
const LOCK_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 300_000; // generous: covers a CONCURRENTLY build

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await acquireLock(client);
    try {
      await runMigrations(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function acquireLock(client) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_KEY]);
    if (rows[0].ok) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire the migration advisory lock within ${LOCK_WAIT_MS}ms — another instance is still migrating`
      );
    }
    console.log('[migrate] another instance holds the migration lock, waiting...');
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

// Split a file into statements on top-level semicolons. Aware of single-quoted
// strings, dollar-quoted bodies (DO $$ ... $$, which contain their own
// semicolons) and comments — the old naive `split(/;\s*\n/)` tore DO blocks in
// half, which is why comment/no-transaction files could not use them.
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (two === '*/') { buf += two; i += 2; inBlockComment = false; continue; }
      buf += ch; i += 1;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += ch; i += 1;
      continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { buf += "'"; i += 2; continue; } // escaped quote
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (two === '--') { inLineComment = true; buf += two; i += 2; continue; }
    if (two === '/*') { inBlockComment = true; buf += two; i += 2; continue; }
    if (ch === "'") { inSingle = true; buf += ch; i += 1; continue; }

    const dollar = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
    if (dollar) { dollarTag = dollar[0]; buf += dollarTag; i += dollarTag.length; continue; }

    if (ch === ';') { out.push(buf); buf = ''; i += 1; continue; }

    buf += ch;
    i += 1;
  }
  out.push(buf);

  // Drop chunks that are only whitespace/comments (trailing text after the last
  // semicolon, file headers, etc.) — Postgres rejects an empty query string.
  return out
    .map((s) => s.trim())
    .filter((s) => s && stripComments(s).trim().length > 0);
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

async function runMigrations(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT NOW()
     )`
  );

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const appliedRes = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const head = sql.trimStart();
    const tolerant = head.startsWith('-- @tolerant');
    const noTransaction = head.startsWith('-- @noTransaction');
    const mode = tolerant ? ' (tolerant)' : noTransaction ? ' (no transaction)' : '';
    console.log(`[migrate] applying ${file}${mode}`);

    if (tolerant) {
      const stmts = splitStatements(sql);
      let failures = 0;
      for (const stmt of stmts) {
        try {
          await client.query(stmt);
        } catch (e) {
          failures += 1;
          console.warn(`[migrate] ${file} tolerant skip: ${e.message}`);
        }
      }
      if (failures === 0) {
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      } else {
        // A transient error (lock, dependency, drift) must not permanently
        // skip DDL: leave the file pending so the next boot replays it. The
        // statements are idempotent, so replay is safe and cheap.
        console.error(`[migrate] ${file}: ${failures} statement(s) failed — NOT recording as applied, will retry next boot`);
      }
    } else if (noTransaction) {
      // Each statement autocommits. There is no rollback, so every statement in
      // such a file must be independently idempotent; the first failure still
      // halts the boot rather than recording a half-applied file.
      for (const stmt of splitStatements(sql)) {
        try {
          await client.query(stmt);
        } catch (e) {
          console.error(`[migrate] FAILED ${file}: ${e.message}`);
          throw e;
        }
      }
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    } else {
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[migrate] FAILED ${file}: ${e.message}`);
        throw e; // boot must not continue on a half-applied schema
      }
    }
    console.log(`[migrate] applied ${file}`);
  }
}

module.exports = { migrate, splitStatements };
