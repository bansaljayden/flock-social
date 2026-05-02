// ---------------------------------------------------------------------------
// Mode 1: Collect BestTime weekly patterns for all venues
// Produces 168 rows per venue (7 days × 24 hours)
// Run: node scripts/ml/collectWeekly.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { getWeather } = require('../../services/weatherService');
const { fetchWeeklyForecast } = require('./bestTimeService');
const { bestTimeDayToJsDay, sleep } = require('./config');

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

async function collectWeekly() {
  // Support --city=lehigh and --limit=10 flags for testing
  const cityArg = process.argv.find(a => a.startsWith('--city='));
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const cityFilter = cityArg ? cityArg.split('=')[1] : null;
  const limitFilter = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

  const skipCollected = process.argv.includes('--skip-collected');
  const skipAttempted = process.argv.includes('--skip-attempted') || skipCollected;
  const retry404 = process.argv.includes('--retry-404');

  let query = 'SELECT * FROM ml_venues WHERE is_active = true';
  const params = [];
  if (cityFilter) {
    params.push(cityFilter);
    query += ` AND city = $${params.length}`;
  }
  if (skipCollected) {
    query += ' AND besttime_venue_id IS NULL';
  }
  if (skipAttempted && !retry404) {
    query += ' AND besttime_attempted_at IS NULL';
  }
  query += ' ORDER BY city, id';
  if (limitFilter) {
    params.push(limitFilter);
    query += ` LIMIT $${params.length}`;
  }

  const { rows: venues } = await pool.query(query, params);

  console.log(`[ML:Weekly] Starting weekly collection for ${venues.length} venues${cityFilter ? ` (city: ${cityFilter})` : ''}${limitFilter ? ` (limit: ${limitFilter})` : ''}...`);

  let totalRows = 0;
  let skipped = 0;

  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i];
    console.log(`[ML:Weekly] (${i + 1}/${venues.length}) ${venue.name} [${venue.city}]`);

    // Fetch BestTime weekly forecast
    const forecast = await fetchWeeklyForecast(venue.name, venue.address, venue.besttime_venue_id);
    if (!forecast) {
      await pool.query(
        `UPDATE ml_venues
         SET besttime_attempted_at = NOW(),
             besttime_status = COALESCE(besttime_status, '404')
         WHERE id = $1`,
        [venue.id]
      );
      console.log('  Skipped — no BestTime data (marked 404)');
      skipped++;
      continue;
    }

    // Update besttime_venue_id if we got one + mark found
    if (forecast.venueId && !venue.besttime_venue_id) {
      await pool.query(
        `UPDATE ml_venues
         SET besttime_venue_id = $1,
             besttime_attempted_at = NOW(),
             besttime_status = 'found'
         WHERE id = $2`,
        [forecast.venueId, venue.id]
      );
    } else {
      await pool.query(
        `UPDATE ml_venues
         SET besttime_attempted_at = NOW(),
             besttime_status = 'found'
         WHERE id = $1`,
        [venue.id]
      );
    }

    // Fetch weather for this venue's location (representative snapshot)
    const weather = await getWeather(venue.latitude, venue.longitude);

    // Insert 168 rows (7 days × 24 hours)
    let venueRows = 0;
    for (const day of forecast.days) {
      const jsDayOfWeek = bestTimeDayToJsDay(day.dayInt);

      for (let hour = 0; hour < day.hours.length && hour < 24; hour++) {
        const busyness = day.hours[hour];
        if (busyness == null) continue;

        try {
          await pool.query(
            `INSERT INTO ml_training_data
              (venue_id, collection_mode, day_of_week, hour, venue_category, price_level, rating, review_count,
               temperature, humidity, wind_speed, weather_condition, is_raining, busyness_pct, besttime_epoch)
            VALUES ($1, 'weekly', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              venue.id,
              jsDayOfWeek,
              hour,
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
              forecast.epochAnalysis,
            ]
          );
          venueRows++;
        } catch (err) {
          // Skip duplicate rows
          if (err.code !== '23505') {
            console.error(`  Row insert error (day=${jsDayOfWeek}, hour=${hour}):`, err.message);
          }
        }
      }
    }

    totalRows += venueRows;
    console.log(`  ${venueRows} rows inserted`);

    // Update last_collected_at
    await pool.query(
      'UPDATE ml_venues SET last_collected_at = NOW() WHERE id = $1',
      [venue.id]
    );

    await sleep(100);
  }

  console.log(`\n[ML:Weekly] Done. ${totalRows} total rows inserted. ${skipped} venues skipped.`);
  await pool.end();
}

async function run() {
  await collectWeekly();
}

module.exports = { run };

// Allow direct execution
if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Weekly] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
