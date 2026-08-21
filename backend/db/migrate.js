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
//
// POST-CONDITIONS (`-- @requires`). "The batch returned without throwing" is a
// weaker fact than it looks, and two files proved it. 032 and 038 wrap every
// `ALTER TABLE` in `DO $$ ... EXCEPTION WHEN others THEN NULL`, so a
// lock_timeout on a busy table (this runner sets one, deliberately, at 10s)
// raised, was swallowed, and the file was recorded as applied with its columns
// absent. Nothing retries a migration the runner believes is done, so
// `routes/feedback.js` and `routes/crowd.js` would have gone on reading columns
// that were never going to appear. A file can therefore declare what it must
// leave behind:
//
//   -- @requires table served_predictions
//   -- @requires column venue_feedback.served_prediction_id
//
// and the runner does two things with that. It VERIFIES the requirements after
// running the file and before writing the schema_migrations row, so a swallowed
// failure cannot be recorded as success. And on every boot it RE-VERIFIES them
// for files already recorded, so a database that was already falsely marked
// heals itself: the row is deleted and the file runs again. Declaring
// @requires is a promise that the file is safe to run twice, which every file
// in this directory already has to be (__tests__/migrationBootSafety.test.js
// wipes schema_migrations and replays the whole chain over live data).
//
// One rule comes with it. If a LATER migration ever drops something an earlier
// one declares, delete the earlier `@requires` line in the same change, or the
// two will fight on every boot: the heal re-applies the old file, the old file
// puts the column back, and the next boot does it again.
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
    // DESTROY, never release (round 17 audit). The two SETs above are
    // SESSION-level, and `client.release()` hands that same backend straight
    // back to the pool with them still applied — measured, not theorised: after
    // a boot, `SHOW statement_timeout` on the first pooled connection returned
    // `5min` instead of the pool's 15s, and `lock_timeout` was 10s instead of 0.
    // config/database.js caps statements at 15s precisely so one query blocked
    // on a lock cannot park a pool slot forever; leaking the migration's 300s
    // made one of the twenty slots 20x looser for the whole life of the
    // process, and it was the slot at the head of the idle list, so it was the
    // one the first requests after boot actually got. Passing `true` closes the
    // backend instead; the pool opens a clean one on demand, which at boot
    // costs a single connection handshake.
    client.release(true);
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

// ---------------------------------------------------------------------------
// `-- @requires`: what a file promises to leave behind.
// ---------------------------------------------------------------------------
// Matched on its own comment line anywhere in the file, so the declaration can
// sit next to the DDL it describes instead of in a header nobody reads next to
// the statement. Two forms only, because two are what the catalog can answer
// cheaply and unambiguously:
//
//   -- @requires table <name>
//   -- @requires column <table>.<name>
//
// Identifiers are matched as bare lowercase-able words. Quoted or mixed-case
// identifiers are not supported and would be a mistake to introduce: nothing in
// this schema uses them.
const REQUIRES_RE =
  /^[ \t]*--[ \t]*@requires[ \t]+(column|table)[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?[ \t]*$/gim;

function parseRequirements(sql) {
  const out = [];
  REQUIRES_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRES_RE.exec(sql)) !== null) {
    const [, kind, first, second] = m;
    if (kind === 'column') {
      if (!second) continue; // `@requires column foo` is malformed; ignore rather than guess
      out.push({ kind: 'column', table: first, column: second });
    } else {
      out.push({ kind: 'table', table: first });
    }
  }
  return out;
}

// Returns the requirements that are NOT satisfied, as printable strings. At
// most two catalog SELECTs regardless of how many requirements are passed, and
// none at all when there are none, so the boot-time scan over every applied
// file costs a healthy database one query.
async function findMissingRequirements(client, reqs) {
  const missing = [];
  const columnKeys = [...new Set(
    reqs.filter((r) => r.kind === 'column').map((r) => `${r.table}.${r.column}`)
  )];
  const tableNames = [...new Set(reqs.filter((r) => r.kind === 'table').map((r) => r.table))];

  if (columnKeys.length > 0) {
    const { rows } = await client.query(
      `SELECT c.table_name || '.' || c.column_name AS key
         FROM information_schema.columns c
        WHERE c.table_schema = current_schema()
          AND (c.table_name || '.' || c.column_name) = ANY($1::text[])`,
      [columnKeys]
    );
    const have = new Set(rows.map((r) => r.key));
    for (const key of columnKeys) if (!have.has(key)) missing.push(`column ${key}`);
  }

  if (tableNames.length > 0) {
    const { rows } = await client.query(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($1::text[])`,
      [tableNames]
    );
    const have = new Set(rows.map((r) => r.relname));
    for (const name of tableNames) if (!have.has(name)) missing.push(`table ${name}`);
  }

  return missing;
}

// Run after the file's statements, before schema_migrations is written. In the
// default mode this executes inside the file's own open transaction, so it sees
// the uncommitted DDL and a throw rolls the whole thing back.
async function assertRequirementsMet(client, file, reqs) {
  if (reqs.length === 0) return;
  const missing = await findMissingRequirements(client, reqs);
  if (missing.length > 0) {
    throw new Error(
      `${file} ran without raising, but ${missing.join(', ')} still missing. ` +
      'A statement was skipped or its error was swallowed; refusing to record this migration as applied.'
    );
  }
}

// The self-heal. A database that was already marked as having 032/038 while the
// columns never landed has no other way back: nothing re-runs a migration the
// runner believes is done. So before the normal loop, re-check the declared
// post-conditions of every file already in schema_migrations and un-record any
// that does not hold. The loop below then applies it again like any pending
// file. On a healthy database this finds nothing and changes nothing.
async function healFalselyAppliedMigrations(client, dir, files, applied) {
  const byFile = new Map();
  const all = [];
  for (const file of files) {
    if (!applied.has(file)) continue;
    let reqs;
    try {
      reqs = parseRequirements(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // unreadable file: the normal loop skips it too, nothing to heal
    }
    if (reqs.length === 0) continue;
    byFile.set(file, reqs);
    all.push(...reqs);
  }
  if (all.length === 0) return;

  const missing = new Set(await findMissingRequirements(client, all));
  if (missing.size === 0) return;

  for (const [file, reqs] of byFile) {
    const gone = reqs
      .map((r) => (r.kind === 'column' ? `column ${r.table}.${r.column}` : `table ${r.table}`))
      .filter((s) => missing.has(s));
    if (gone.length === 0) continue;
    console.error(
      `[migrate] ${file} is recorded as applied but ${gone.join(', ')} is missing. ` +
      're-applying it (its error was swallowed on a previous boot)'
    );
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [file]);
    applied.delete(file);
  }
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

  await healFalselyAppliedMigrations(client, dir, files, applied);

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const reqs = parseRequirements(sql);
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
      const unmet = failures === 0 ? await findMissingRequirements(client, reqs) : [];
      if (failures === 0 && unmet.length === 0) {
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      } else if (unmet.length > 0) {
        console.error(
          `[migrate] ${file}: every statement returned but ${unmet.join(', ')} is missing. ` +
          'NOT recording as applied, will retry next boot'
        );
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
      await assertRequirementsMet(client, file, reqs);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    } else {
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await assertRequirementsMet(client, file, reqs);
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

module.exports = { migrate, splitStatements, parseRequirements, findMissingRequirements };
