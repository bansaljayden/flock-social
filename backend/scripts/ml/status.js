require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const r = await pool.query(`SELECT city, COUNT(*) as total, COUNT(*) FILTER (WHERE besttime_venue_id IS NOT NULL) as collected, COUNT(*) FILTER (WHERE besttime_venue_id IS NULL) as uncollected FROM ml_venues WHERE is_active = true GROUP BY city ORDER BY city`);
  const r2 = await pool.query('SELECT COUNT(*) as total FROM ml_training_data');

  console.log('City            | Total | Collected | Uncollected');
  console.log('----------------|-------|-----------|------------');
  let tTotal = 0, tCol = 0, tUn = 0;
  r.rows.forEach(row => {
    const city = row.city.padEnd(15);
    tTotal += parseInt(row.total);
    tCol += parseInt(row.collected);
    tUn += parseInt(row.uncollected);
    console.log(`${city} | ${String(row.total).padStart(5)} | ${String(row.collected).padStart(9)} | ${String(row.uncollected).padStart(10)}`);
  });
  console.log('----------------|-------|-----------|------------');
  console.log(`TOTAL           | ${String(tTotal).padStart(5)} | ${String(tCol).padStart(9)} | ${String(tUn).padStart(10)}`);
  console.log(`\nTraining data rows: ${r2.rows[0].total}`);
  await pool.end();
})();
