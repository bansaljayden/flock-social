// ---------------------------------------------------------------------------
// EXPORT ml_sports_events FOR THE FEATURE BUILDER
// ---------------------------------------------------------------------------
// prepare_features.py reads flat files, not the database, so the game
// schedule crosses the same bridge training_data.csv does. One row per
// tracked-team game with exactly the fields the sports feature family needs.
//
//   node scripts/ml/train/exportSportsEvents.js       (from backend/)
//
// Writes scripts/ml/train/sports_events.csv. Reads the database, writes a
// file, touches no external API.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

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

async function main() {
  const { rows } = await pool.query(`
    SELECT sportsdb_event_id, league, team_key, is_home,
           event_local_date::text AS event_local_date,
           event_local_time::text AS event_local_time,
           venue_lat, venue_lon
      FROM ml_sports_events
     WHERE event_local_date IS NOT NULL
     ORDER BY event_local_date, sportsdb_event_id
  `);
  const out = path.join(__dirname, 'sports_events.csv');
  const header = 'sportsdb_event_id,league,team_key,is_home,event_local_date,event_local_time,venue_lat,venue_lon';
  const lines = rows.map((r) => [
    r.sportsdb_event_id, r.league, r.team_key, r.is_home ? 1 : 0,
    r.event_local_date, r.event_local_time || '',
    r.venue_lat == null ? '' : r.venue_lat, r.venue_lon == null ? '' : r.venue_lon,
  ].join(','));
  fs.writeFileSync(out, [header, ...lines].join('\n') + '\n');
  console.log(`[ML:Sports] Exported ${rows.length} events to ${out}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[ML:Sports] Export fatal:', err.message);
  pool.end();
  process.exitCode = 1;
});
