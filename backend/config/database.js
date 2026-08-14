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
  statement_timeout: Number.isInteger(parseInt(process.env.PG_STATEMENT_TIMEOUT_MS, 10))
    ? parseInt(process.env.PG_STATEMENT_TIMEOUT_MS, 10)
    : 15000,
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

// Verify connection on startup
pool.query('SELECT NOW()')
  .then(() => console.log('PostgreSQL connected'))
  .catch((err) => console.error('PostgreSQL connection error:', err.message));

module.exports = pool;
