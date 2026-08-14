const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway uses internal TLS with self-signed certs — rejectUnauthorized: false is required.
  // For non-Railway production (AWS RDS, etc.), set rejectUnauthorized: true + provide CA cert.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
const originalQuery = pool.query.bind(pool);
pool.query = function safeQuery(...args) {
  const queryText = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text);
  if (queryText && /DROP\s+TABLE/i.test(queryText) && process.env.ALLOW_DROP_TABLES !== 'true') {
    const err = new Error(
      'DROP TABLE is BLOCKED for safety. Set ALLOW_DROP_TABLES=true in .env to allow, or use migrations instead.'
    );
    console.error('🛡️ BLOCKED dangerous query:', queryText);
    return Promise.reject(err);
  }
  if (queryText && /TRUNCATE/i.test(queryText) && process.env.ALLOW_DROP_TABLES !== 'true') {
    const err = new Error(
      'TRUNCATE is BLOCKED for safety. Set ALLOW_DROP_TABLES=true in .env to allow.'
    );
    console.error('🛡️ BLOCKED dangerous query:', queryText);
    return Promise.reject(err);
  }
  return originalQuery(...args);
};

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
