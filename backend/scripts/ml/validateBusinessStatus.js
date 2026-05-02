// ---------------------------------------------------------------------------
// Validate ml_venues.is_active using Google Places (New) businessStatus.
// Marks CLOSED_PERMANENTLY / CLOSED_TEMPORARILY venues inactive so they
// don't waste BestTime slots.
//
// Cost: $17 per 1,000 calls (Basic Data SKU). Default cap = $180 of credit.
//
// Run:   node scripts/ml/validateBusinessStatus.js [--max=N] [--cities=a,b]
// ---------------------------------------------------------------------------

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const COST_PER_CALL = 0.017; // Basic Data SKU
const FREE_CREDIT = 200;

const KNOWN_GOOD_CITIES = [
  'boston', 'sydney', 'london', 'chicago', 'la', 'nyc', 'miami',
  'lehigh', 'toronto', 'tokyo', 'mexico', 'dubai', 'barcelona',
  'seoul', 'amsterdam', 'philly', 'austin', 'seattle', 'nashville',
  'paris', 'dallas',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkPlace(placeId) {
  // Place IDs starting with "bt_" are BestTime-discovered, not real Google IDs
  if (!placeId || placeId.startsWith('bt_')) return { skip: true };

  try {
    const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'id,businessStatus',
      },
    });

    if (response.status === 404) return { status: 'NOT_FOUND' };
    if (!response.ok) {
      const text = await response.text();
      return { error: `${response.status}: ${text.slice(0, 100)}` };
    }

    const data = await response.json();
    return { status: data.businessStatus || 'UNKNOWN' };
  } catch (err) {
    return { error: err.message };
  }
}

async function run() {
  if (!API_KEY) {
    console.error('GOOGLE_PLACES_API_KEY not set');
    process.exit(1);
  }

  const maxArg = process.argv.find(a => a.startsWith('--max='));
  const citiesArg = process.argv.find(a => a.startsWith('--cities='));
  const maxBudgetCalls = maxArg ? parseInt(maxArg.split('=')[1], 10) : 10800;
  const cityList = citiesArg ? citiesArg.split('=')[1].split(',') : KNOWN_GOOD_CITIES;

  console.log(`[Validate] Cap: ${maxBudgetCalls} calls = $${(maxBudgetCalls * COST_PER_CALL).toFixed(2)}`);
  console.log(`[Validate] Cities: ${cityList.join(', ')}`);

  const { rows: venues } = await pool.query(
    `SELECT id, google_place_id, name, city
     FROM ml_venues
     WHERE is_active = true
       AND besttime_attempted_at IS NULL
       AND city = ANY($1)
       AND google_place_id NOT LIKE 'bt_%'
     ORDER BY city, id
     LIMIT $2`,
    [cityList, maxBudgetCalls]
  );

  console.log(`[Validate] Will check ${venues.length} venues\n`);

  const counts = { OPERATIONAL: 0, CLOSED_TEMPORARILY: 0, CLOSED_PERMANENTLY: 0, NOT_FOUND: 0, UNKNOWN: 0, ERROR: 0, SKIPPED: 0 };
  let calls = 0;

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const result = await checkPlace(v.google_place_id);

    if (result.skip) { counts.SKIPPED++; continue; }
    calls++;

    if (result.error) {
      counts.ERROR++;
      if (counts.ERROR <= 5) console.log(`  [${i+1}/${venues.length}] ${v.name} ERROR: ${result.error}`);
      continue;
    }

    counts[result.status] = (counts[result.status] || 0) + 1;

    if (result.status === 'CLOSED_PERMANENTLY' || result.status === 'CLOSED_TEMPORARILY' || result.status === 'NOT_FOUND') {
      await pool.query(
        `UPDATE ml_venues SET is_active = false, updated_at = NOW() WHERE id = $1`,
        [v.id]
      );
    }

    if ((i + 1) % 250 === 0) {
      const cost = (calls * COST_PER_CALL).toFixed(2);
      console.log(`  Progress: ${i+1}/${venues.length} | calls=${calls} | spent=$${cost} | closed=${counts.CLOSED_PERMANENTLY + counts.CLOSED_TEMPORARILY} | 404s=${counts.NOT_FOUND}`);
    }

    await sleep(50); // gentle on the API
  }

  const totalCost = calls * COST_PER_CALL;
  console.log(`\n[Validate] Done.`);
  console.log(`  API calls:           ${calls}`);
  console.log(`  Estimated cost:      $${totalCost.toFixed(2)}`);
  console.log(`  Free credit used:    $${Math.min(totalCost, FREE_CREDIT).toFixed(2)} of $${FREE_CREDIT}`);
  console.log(`  OPERATIONAL:         ${counts.OPERATIONAL}`);
  console.log(`  CLOSED_TEMPORARILY:  ${counts.CLOSED_TEMPORARILY}  (deactivated)`);
  console.log(`  CLOSED_PERMANENTLY:  ${counts.CLOSED_PERMANENTLY}  (deactivated)`);
  console.log(`  NOT_FOUND:           ${counts.NOT_FOUND}  (deactivated)`);
  console.log(`  UNKNOWN:             ${counts.UNKNOWN}`);
  console.log(`  ERROR:               ${counts.ERROR}`);
  console.log(`  SKIPPED (bt_ id):    ${counts.SKIPPED}`);

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
