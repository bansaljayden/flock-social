// ---------------------------------------------------------------------------
// Probe BestTime hit rate on the 13 untested cities.
// 100 venues per city = ~1,300 BestTime slots.
// Writes besttime_attempted_at + besttime_status on every venue tried.
//
// Run: node scripts/ml/probeUntestedCities.js [--limit=100]
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { fetchWeeklyForecast } = require('./bestTimeService');
const { sleep } = require('./config');

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const UNTESTED_CITIES = [
  'singapore', 'denver', 'bangkok', 'berlin', 'madrid', 'saopaulo',
  'mumbai', 'buenosaires', 'rome', 'nola', 'delhi', 'capetown', 'beijing',
];

async function probeCity(city, limit) {
  const { rows: venues } = await pool.query(
    `SELECT id, name, address FROM ml_venues
     WHERE is_active = true
       AND city = $1
       AND besttime_attempted_at IS NULL
     ORDER BY id
     LIMIT $2`,
    [city, limit]
  );

  let found = 0, missed = 0;
  for (const v of venues) {
    const forecast = await fetchWeeklyForecast(v.name, v.address, null);
    if (forecast && forecast.venueId) {
      await pool.query(
        `UPDATE ml_venues
         SET besttime_venue_id = $1,
             besttime_attempted_at = NOW(),
             besttime_status = 'found'
         WHERE id = $2`,
        [forecast.venueId, v.id]
      );
      found++;
    } else {
      await pool.query(
        `UPDATE ml_venues
         SET besttime_attempted_at = NOW(),
             besttime_status = '404'
         WHERE id = $1`,
        [v.id]
      );
      missed++;
    }
    // One call per second, matching collectRealtime.js and collectWeekly.js.
    // This script was left at 150ms (400 a minute) when those two were paced
    // down on 2026-09-01, which makes it the fastest caller in the repo and
    // the only one still above BestTime's stated 300 a minute. That pace is
    // what the sibling comment describes earning a hard key block: 600 a
    // minute drew one outright, and even 240 a minute, lawfully under the
    // published ceiling, drew a 503 wall after ~475 calls and then the same
    // 403, because a key that has offended once is not judged by the ceiling.
    // A key block stops the nightly collection service too, so the blast
    // radius of running this is the whole pipeline, not just this probe.
    await sleep(1000);
  }
  return { city, attempted: venues.length, found, missed, hit_pct: venues.length ? (100 * found / venues.length).toFixed(1) : 'n/a' };
}

async function run() {
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 100;

  console.log(`[Probe] Probing ${UNTESTED_CITIES.length} cities × ${limit} venues = ${UNTESTED_CITIES.length * limit} BestTime slots\n`);

  const results = [];
  for (const city of UNTESTED_CITIES) {
    console.log(`[Probe] ${city}...`);
    const r = await probeCity(city, limit);
    results.push(r);
    console.log(`  ${r.city}: ${r.found}/${r.attempted} = ${r.hit_pct}%`);
  }

  console.log('\n=== Probe results (sorted by hit rate) ===');
  console.log('city            | attempted | found | hit %');
  console.log('----------------+-----------+-------+-------');
  results
    .sort((a, b) => parseFloat(b.hit_pct) - parseFloat(a.hit_pct))
    .forEach(r => {
      console.log(`${r.city.padEnd(15)} | ${String(r.attempted).padStart(9)} | ${String(r.found).padStart(5)} | ${String(r.hit_pct).padStart(5)}%`);
    });

  const totalAttempted = results.reduce((s, r) => s + r.attempted, 0);
  const totalFound = results.reduce((s, r) => s + r.found, 0);
  console.log('----------------+-----------+-------+-------');
  console.log(`TOTAL           | ${String(totalAttempted).padStart(9)} | ${String(totalFound).padStart(5)} | ${(100 * totalFound / totalAttempted).toFixed(1)}%`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
