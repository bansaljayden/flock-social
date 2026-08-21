const { Pool } = require('pg');

// TLS decision, in priority order — and the history of why it is written out:
//
// When DATABASE_URL vanished from the Railway service, the pool fell back to
// the PG* variables (pg reads them natively when connectionString is
// undefined). Those point at Railway's INTERNAL Postgres host, and this config
// force-enabled TLS whenever NODE_ENV was production — so every connection
// died at the handshake before a single query, the migration runner reported
// a generic fatal, and production crash-looped with nothing in the logs naming
// the cause.
//
// The rule now: an explicit PGSSLMODE always wins, because whoever set it knew
// the endpoint. Without one, DATABASE_URL deployments keep the old production
// default (TLS, self-signed tolerated — Railway's public proxy). A PG*-only
// deployment with no PGSSLMODE tries TLS but no longer insists a missing
// handshake is fatal at config time; pg will surface the endpoint's truth.
const SSLMODE = String(process.env.PGSSLMODE || '').toLowerCase();
const sslConfig = SSLMODE
  ? (SSLMODE === 'disable' ? false : { rejectUnauthorized: false })
  : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // For non-Railway production (AWS RDS, etc.), set rejectUnauthorized: true + provide CA cert.
  ssl: sslConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  // Waiting for a free pooled connection. 2s was too aggressive: under a burst
  // that briefly saturates all 20 slots, a request that would have been served
  // in 2.5s instead threw "timeout exceeded when trying to connect" out of
  // pool.connect(), which every route funnels into a generic 500. Saturation
  // then read as a broken server rather than a slow one, and the retries it
  // provoked made it worse. 10s rides out a burst; anything still waiting past
  // that is genuinely wedged and should fail.
  connectionTimeoutMillis: 10000,
  // Server-side cap on a SINGLE statement. Without it one query blocked on a
  // lock (or scanning a table nobody indexed) parks its pool slot forever — 20
  // of those and the whole API stops, with no error anywhere to say why. 15s is
  // far above every legitimate query in this codebase (the slowest are the
  // dashboard aggregates, single-digit ms on any realistic dataset) and well
  // under the point where a user has given up.
  //
  // Postgres raises this as an ordinary query error, so it surfaces at the
  // await like any other failure: the routes that hold a client all release it
  // in a `finally` and roll back in a `catch`, so a timeout returns the slot
  // instead of leaking it.
  //
  // Migrations are exempt by construction — db/migrate.js runs on one dedicated
  // connection and does `SET statement_timeout = 300000` on it before any DDL,
  // and a session-level SET overrides this connection default. A CONCURRENTLY
  // index build is not going to be killed at 15 seconds.
  //
  // Overridable because this module is also imported by one-shot jobs
  // (scripts/ml/*, backfills) whose whole purpose is a long aggregate. Those
  // run as `PG_STATEMENT_TIMEOUT_MS=0 node scripts/...` (0 disables it); the
  // API server never sets the variable and gets the 15s cap.
  // A NEGATIVE override is not a longer timeout, it is a connection that fails:
  // Postgres rejects `SET statement_timeout = -5` outright, so every checkout
  // from this pool would error at startup rather than at the first slow query.
  // Only 0 (disabled) and positive values are accepted; anything else falls
  // back to the default, which is the direction that keeps the cap on.
  statement_timeout: (() => {
    const n = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS, 10);
    return Number.isInteger(n) && n >= 0 ? n : 15000;
  })(),
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

// ---------------------------------------------------------------------------
// DATABASE SAFETY: Intercept dangerous queries
// ---------------------------------------------------------------------------
//
// THE GUARD READ COMMENTS AND PROSE, AND IT COST US A WHOLE ROUTE.
//
// This was `/TRUNCATE/i.test(queryText)` — an unanchored substring match over
// the ENTIRE statement text, comments included. `routes/venueProfile.js`'s
// UPDATE carries a long `--` comment explaining the jsonb merge, and one of its
// sentences ends "...reaches Postgres truncated at that point." The substring
// `truncat` is in `truncated`, so from 2026-08-14 (commit 7c696ed, which added
// that comment) every single `PUT /api/venue-profile` was rejected here and
// answered 500 "Failed to update venue profile". That is the venue settings
// save AND the eighteen-field intake form behind it — the owner's whole write
// path — dead, with the only evidence a `🛡️ BLOCKED dangerous query` line in
// the Railway log that reads like an attack being stopped.
//
// A guard on a SQL VERB has to look at SQL verbs:
//
//   * comments are stripped first, so prose in a `--` or `/* */` block can
//     never be mistaken for a statement (this is the bug above, and it would
//     have bitten migration 025 too, whose header says "a typo'd or truncated
//     label"); and
//   * the match is word-bounded, so `truncated`, `untruncated`, `date_trunc`
//     and a column named `truncate_after` are words rather than verbs.
//
// String literals and dollar-quoted bodies are preserved rather than stripped —
// a `--` inside a quoted string does not start a comment in Postgres and must
// not start one here, or a statement could be hidden from the guard by putting
// a `--` in a literal ahead of it.
//
// WHAT THIS GUARD IS AND IS NOT. It protects against OUR OWN code — a script,
// a migration draft, a copy-pasted psql line — running a destructive statement
// against production. It is not an injection defence: no route in this codebase
// builds SQL from request data, and if one ever did, a verb blocklist would not
// be the thing that saved it. It also only wraps `pool.query`; a client checked
// out with `pool.connect()` (the transaction routes, and db/migrate.js) calls
// `client.query` and is NOT covered. That is deliberate — the migration runner
// has to be able to run whatever a migration says — and it is the reason this
// is a seatbelt rather than a wall.
// COMMENTS WERE HALF THE PROBLEM. STRING LITERALS ARE THE OTHER HALF.
//
// Stripping comments fixed the statement that shipped the outage, and left the
// identical mistake reachable one quote character away. `stripSqlComments`
// deliberately PRESERVES quoted text, because a `--` inside a literal does not
// start a comment in Postgres; the consequence nobody followed through on is
// that the words inside that literal are then handed to the verb match, so
//
//   INSERT INTO venue_profiles (quirks) VALUES ('we truncate the tap list')
//   SELECT * FROM t WHERE note <> 'DROP TABLE users'
//
// are both refused with a 500, for prose, exactly as `truncated` was. Migration
// 030 added `quirks`, `event_note` and `anchor_note` — three free-text columns
// whose whole purpose is an owner describing their own room in their own words
// — so the class of statement that trips this is now a shipped product surface
// rather than a hypothetical.
//
// The fix is to blank literal CONTENTS for the danger match only, AFTER the
// comment strip. Order is what makes it safe: comments are already gone by the
// time literals are blanked, so nothing can be hidden from the guard inside a
// literal that a `--` used to protect. And a verb inside `'...'` is a string,
// never a statement, so removing it can only take away false positives. Dollar
// quoted bodies are left alone on purpose — `DO $$ ... DROP TABLE x ... $$`
// really does drop the table.
function blankStringLiterals(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {                                  // string literal, '' escapes
      let j = i + 1;
      while (j < n) {
        if (sql[j] !== "'") { j++; continue; }
        if (sql[j + 1] === "'") { j += 2; continue; }
        j++;
        break;
      }
      out += "''"; i = j; continue;                   // contents gone, quotes kept
    }
    if (c === '"') {                                  // quoted identifier: a NAME,
      const close = sql.indexOf('"', i + 1);          // not data, so it stays
      const end = close === -1 ? n : close + 1;
      out += sql.slice(i, end); i = end; continue;
    }
    if (c === '$') {                                  // $$ ... $$ executes; keep it
      const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sql.slice(i, end); i = end; continue;
      }
    }
    out += c; i++;
  }
  return out;
}

// An unconditional DELETE is a TRUNCATE that spells itself differently, and the
// guard blocked one and waved the other through. `DELETE FROM users` empties
// the table this whole product is, from a `pool.query` call, with no error to
// say it happened. Scoped by what it does NOT match: any WHERE (however it is
// spelled, including a WHERE the statement inherits from a CTE), any USING
// join, and anything where the DELETE is only a word inside a literal — which
// is why this runs on the blanked text like every other rule. Measured against
// every SQL string in routes/, services/, sockets/, middleware/, utils/ and
// db/: 1,096 statements, zero matches, so no live route pays for it.
// PER STATEMENT, not per query text. A single string handed to pool.query can
// hold several statements, and "does this text contain a WHERE" is the wrong
// question for it: `DELETE FROM sessions WHERE id = 1; DELETE FROM users` has
// a WHERE and still empties the users table. Splitting on the semicolons that
// survive the comment strip and the literal blanking answers the right question
// for each half. A dollar-quoted body is left whole by both of those passes, so
// splitting it here can only produce fragments that lack a WHERE and are
// therefore refused, which is the safe direction to be wrong in.
function isUnconditionalDelete(code) {
  if (!/\bDELETE\s+FROM\b/i.test(code)) return false;
  return code.split(';').some(
    (stmt) => /\bDELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt) && !/\bUSING\b/i.test(stmt)
  );
}

const SQL_DANGER = [
  [/\bDROP\s+TABLE\b/i, 'DROP TABLE is BLOCKED for safety. Set ALLOW_DROP_TABLES=true in .env to allow, or use migrations instead.'],
  [/\bTRUNCATE\b/i, 'TRUNCATE is BLOCKED for safety. Set ALLOW_DROP_TABLES=true in .env to allow.'],
  // The four statements that are strictly worse than the two above and were not
  // on the list. `DROP SCHEMA public CASCADE` takes all 46 tables in one line
  // and is the single most likely thing to arrive by copy-paste out of a psql
  // session, which is the exact accident this guard exists for. `DROP OWNED BY`
  // does the same thing wearing a role name. `DROP DATABASE` needs no comment.
  // `ALTER TABLE ... DROP COLUMN` is irreversible data loss on a live table and
  // belongs in a migration, on a client this guard does not wrap, every time.
  [/\bDROP\s+SCHEMA\b/i, 'DROP SCHEMA is BLOCKED for safety. Set ALLOW_DROP_TABLES=true in .env to allow, or use migrations instead.'],
  [/\bDROP\s+DATABASE\b/i, 'DROP DATABASE is BLOCKED for safety. Set ALLOW_DROP_TABLES=true in .env to allow.'],
  [/\bDROP\s+OWNED\b/i, 'DROP OWNED is BLOCKED for safety. Set ALLOW_DROP_TABLES=true in .env to allow.'],
  [/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i, 'ALTER TABLE ... DROP COLUMN is BLOCKED for safety. Write a migration, or set ALLOW_DROP_TABLES=true in .env to allow.'],
  [isUnconditionalDelete, 'DELETE with no WHERE clause is BLOCKED for safety: it empties the table. Add a WHERE, or set ALLOW_DROP_TABLES=true in .env to allow.'],
];

// Replace every SQL comment with a space, leaving quoted text alone. Postgres
// block comments nest, so `/* /* */ */` is one comment; line comments run to
// the newline, which is kept so token boundaries survive.
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {                                  // string literal, '' escapes
      let j = i + 1;
      while (j < n) {
        if (sql[j] !== "'") { j++; continue; }
        if (sql[j + 1] === "'") { j += 2; continue; }
        j++;
        break;
      }
      out += sql.slice(i, j); i = j; continue;
    }
    if (c === '"') {                                  // quoted identifier
      const close = sql.indexOf('"', i + 1);
      const end = close === -1 ? n : close + 1;
      out += sql.slice(i, end); i = end; continue;
    }
    if (c === '$') {                                  // $$ ... $$ / $tag$ ... $tag$
      const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sql.slice(i, end); i = end; continue;
      }
    }
    if (c === '-' && sql[i + 1] === '-') {            // line comment
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      out += ' '; continue;
    }
    if (c === '/' && sql[i + 1] === '*') {            // block comment, nestable
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue; }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      i = j; out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

/** The refusal message for a statement, or null when it is allowed. */
function dangerousStatement(queryText) {
  if (!queryText || typeof queryText !== 'string') return null;
  if (process.env.ALLOW_DROP_TABLES === 'true') return null;
  const code = blankStringLiterals(stripSqlComments(queryText));
  for (const [rule, message] of SQL_DANGER) {
    const hit = typeof rule === 'function' ? rule(code) : rule.test(code);
    if (hit) return message;
  }
  return null;
}

const originalQuery = pool.query.bind(pool);
pool.query = function safeQuery(...args) {
  const queryText = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text);
  const refusal = dangerousStatement(queryText);
  if (refusal) {
    console.error('🛡️ BLOCKED dangerous query:', queryText);
    return Promise.reject(new Error(refusal));
  }
  return originalQuery(...args);
};

// Exposed so __tests__/poolQueryGuard.test.js can test the predicate without
// opening a connection.
pool.__dangerousStatement = dangerousStatement;
pool.__stripSqlComments = stripSqlComments;
pool.__blankStringLiterals = blankStringLiterals;

// ---------------------------------------------------------------------------
// STARTUP CONNECTIVITY CHECK — only in the process that is actually a server.
//
// This used to run at module scope, unconditionally. Requiring the pool is not
// the same thing as booting the API: `services/entitlements.js` requires it,
// every route requires it, and therefore every one of the ~60 files under
// `node --test`, every one-shot script under scripts/, and anything that pulls
// in a helper three levels down, all opened a real connection the moment they
// were loaded — from processes that were never going to run a query.
//
// Against an unset DATABASE_URL that is a harmless connection-refused. Against a
// REACHABLE host it is not harmless: a developer with production PG* variables
// in their shell runs the test suite and takes one connection per test process
// out of a 20-slot pool on the live database, and nothing in the output says so.
//
// A boot-time check is genuinely useful when the server starts (it turns "the
// database URL is wrong" into a log line at second zero instead of a 500 on the
// first request) and useless everywhere else. So it runs when THIS process's
// entry point is server.js, and anything else that wants it asks for it:
// `pool.verifyConnection()`, or PG_STARTUP_PING=true for a script that wants the
// same log line.
pool.verifyConnection = function verifyConnection() {
  return pool.query('SELECT NOW()')
    .then(() => { console.log('PostgreSQL connected'); return true; })
    .catch((err) => { console.error('PostgreSQL connection error:', err.message); return false; });
};

const entryFile = require.main && typeof require.main.filename === 'string' ? require.main.filename : '';
// `npm start` is `node server.js`; nodemon execs the same file. Matched on the
// path separator so a file called `my-server.js` does not count.
const IS_API_SERVER_BOOT = /(^|[\\/])server\.js$/.test(entryFile);
if (IS_API_SERVER_BOOT || process.env.PG_STARTUP_PING === 'true') {
  pool.verifyConnection();
}

module.exports = pool;
