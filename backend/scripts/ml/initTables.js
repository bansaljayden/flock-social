// ---------------------------------------------------------------------------
// Creates ML training tables in PostgreSQL
// Run: node scripts/ml/initTables.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Build DATABASE_URL from individual PG* vars if not set
if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  try {
    console.log('[ML] Creating ML training tables...');
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'ml-schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('[ML] Tables created successfully: ml_venues, ml_training_data');
  } catch (err) {
    console.error('[ML] Failed to create tables:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

init();
