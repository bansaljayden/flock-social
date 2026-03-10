// ---------------------------------------------------------------------------
// Mode 2: Collect BestTime live busyness snapshots with real-time weather
// Produces ~250 rows per run (one per venue). Run periodically via cron.
// Run: node scripts/ml/collectRealtime.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { getWeather } = require('../../services/weatherService');
const { fetchLiveBusyness } = require('./bestTimeService');
const { CITIES, getLocalTime, isHoliday, isSchoolBreak, sleep } = require('./config');

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

async function collectRealtime() {
  const { rows: venues } = await pool.query(
    `SELECT * FROM ml_venues WHERE is_active = true AND besttime_venue_id IS NOT NULL ORDER BY city, id`
  );

  if (venues.length === 0) {
    console.log('[ML:Realtime] No venues with besttime_venue_id. Run weekly collection first.');
    await pool.end();
    return;
  }

  console.log(`[ML:Realtime] Starting real-time collection for ${venues.length} venues...`);

  // Group venues by city to share weather calls
  const byCity = {};
  for (const venue of venues) {
    if (!byCity[venue.city]) byCity[venue.city] = [];
    byCity[venue.city].push(venue);
  }

  let totalRows = 0;
  let skipped = 0;

  for (const [cityKey, cityVenues] of Object.entries(byCity)) {
    const cityConfig = CITIES[cityKey];
    if (!cityConfig) continue;

    // One weather call per city
    const weather = await getWeather(cityConfig.lat, cityConfig.lon);
    const local = getLocalTime(cityConfig.tz);

    console.log(`\n[ML:Realtime] ${cityConfig.name} (${local.dateStr} ${local.hour}:00 local)`);

    for (const venue of cityVenues) {
      const live = await fetchLiveBusyness(venue.besttime_venue_id);
      if (!live) {
        skipped++;
        continue;
      }

      // Use live busyness if available, else forecasted
      const busyness = live.liveAvailable ? live.liveBusyness : live.forecastedBusyness;
      if (busyness == null) {
        skipped++;
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO ml_training_data
            (venue_id, collection_mode, day_of_week, hour, month, season, is_holiday, is_school_break,
             venue_category, price_level, rating, review_count,
             temperature, humidity, wind_speed, weather_condition, is_raining,
             busyness_pct)
          VALUES ($1, 'realtime', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            venue.id,
            local.dayOfWeek,
            local.hour,
            local.month,
            local.season,
            isHoliday(local.dateStr),
            isSchoolBreak(local.dateStr),
            venue.venue_category,
            venue.price_level,
            venue.rating,
            venue.review_count,
            weather?.temp ?? null,
            weather?.humidity ?? null,
            weather?.windSpeed ?? null,
            weather?.conditions ?? null,
            weather?.isRaining ?? null,
            Math.max(0, Math.min(100, busyness)),
          ]
        );
        totalRows++;
      } catch (err) {
        console.error(`  Insert error for ${venue.name}:`, err.message);
      }

      await sleep(100);
    }
  }

  console.log(`\n[ML:Realtime] Done. ${totalRows} rows inserted. ${skipped} venues skipped.`);
  await pool.end();
}

async function run() {
  await collectRealtime();
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Realtime] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
