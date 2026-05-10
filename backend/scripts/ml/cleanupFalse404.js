// One-off: revert venues falsely marked 404 by transient 5xx in the last 30 min.
// Reads venue names (one per line) from a file and reverts only those.
// Sets besttime_attempted_at = NULL and besttime_status = NULL so --skip-attempted
// will retry them on the next run.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
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
  const fileArg = process.argv.find(a => a.startsWith('--names-file='));
  if (!fileArg) {
    console.error('Usage: node cleanupFalse404.js --names-file=<path> [--apply]');
    process.exit(1);
  }
  const filePath = fileArg.split('=')[1];
  const names = fs.readFileSync(filePath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const dryRun = !process.argv.includes('--apply');

  const preview = await pool.query(
    `SELECT id, name, city, besttime_attempted_at
     FROM ml_venues
     WHERE besttime_status = '404'
       AND besttime_attempted_at > NOW() - INTERVAL '30 minutes'
       AND besttime_venue_id IS NULL
       AND name = ANY($1::text[])
     ORDER BY besttime_attempted_at`,
    [names]
  );
  console.log(`Matched ${preview.rows.length} venues (of ${names.length} names) to revert:`);
  preview.rows.forEach(r => console.log(`  - ${r.name} [${r.city}]`));

  if (dryRun) {
    console.log('\nDry run — pass --apply to revert.');
    await pool.end();
    return;
  }

  const result = await pool.query(
    `UPDATE ml_venues
     SET besttime_attempted_at = NULL,
         besttime_status = NULL
     WHERE besttime_status = '404'
       AND besttime_attempted_at > NOW() - INTERVAL '30 minutes'
       AND besttime_venue_id IS NULL
       AND name = ANY($1::text[])`,
    [names]
  );
  console.log(`\nReverted ${result.rowCount} venues.`);
  await pool.end();
})();
