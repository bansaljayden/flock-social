const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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
