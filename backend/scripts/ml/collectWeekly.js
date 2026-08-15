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

// Same rule config/database.js states at length: an explicit PGSSLMODE wins,
// because whoever set it knew the endpoint. Without one, keep the Railway
// default (TLS, self-signed tolerated). This is also what lets
// __tests__/mlClockAxisBackfill.test.js run this collector against the embedded
// Postgres harness instead of asserting the INSERT's shape by eye.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------------
// THE HOUR AXIS — read this before touching the INSERT below.
//
// `ml_training_data.hour` is a VENUE-LOCAL HOUR: 0 is the venue's midnight, 18
// is the venue's 6 PM. Every row this file writes now states that in the row
// itself (`hour_axis = 'venue_local'`), and migration
// 023_backfill_ml_weekly_local_hours.sql adds a CHECK constraint that REJECTS a
// weekly insert which does not declare its axis. That is deliberate: the column
// used to hold something else and nothing said so.
//
// WHAT IT USED TO HOLD. This loop iterated BestTime's `day_raw` array and wrote
// the ARRAY INDEX:
//
//     for (let hour = 0; hour < day.hours.length && hour < 24; hour++) {
//       const busyness = day.hours[hour];      // day.hours = day.day_raw
//       ... venue.id, jsDayOfWeek, hour, ...
//
// BestTime's day does not start at midnight — it runs 06:00 to 05:59 — so
// day_raw[0] is the venue's 6 AM and day_raw[18] is the venue's MIDNIGHT.
// scripts/ml/buildBaselines.js copied the column verbatim into
// ml_venue_baselines, services/mlPredictor.js looked it up as a wall-clock
// hour, and because the model is a delta model (score = baseline + a bounded
// nudge) a 6 PM request was answered with the venue's overnight number. The
// symptom was a well-known dinner restaurant reading ~20% at 6 PM; the proof is
// arithmetic on the shipped artifact, pinned in
// __tests__/dinnerPeakAccuracy.test.js PART 3.
//
// THE TRANSFORM, and the half of it that is easy to forget: the last six slots
// of a BestTime day belong to the NEXT calendar day. Slot 18 of Saturday is
// Sunday 00:00, so day_of_week must roll forward with the hour or the whole
// small-hours block is filed under the wrong weekday — including across the
// Saturday -> Sunday week boundary.
// ---------------------------------------------------------------------------
const BESTTIME_DAY_START_HOUR = 6;

// The value written into ml_training_data.hour_axis by this collector. The
// other legal value is 'besttime_index' (what the rows above held, and what
// scripts/ml/discoverBestTime.js STILL writes — see RETRAIN.md).
const HOUR_AXIS_VENUE_LOCAL = 'venue_local';

// (slot, JS day the BestTime day is labelled with) -> venue-local (hour, day).
// Exported so __tests__/mlClockAxisBackfill.test.js can pin that the SQL
// backfill in migration 023 computes exactly this, rather than the two drifting.
function bestTimeSlotToLocal(slot, jsDayOfWeek) {
  const shifted = slot + BESTTIME_DAY_START_HOUR;
  return {
    hour: shifted % 24,
    dayOfWeek: shifted >= 24 ? (jsDayOfWeek + 1) % 7 : jsDayOfWeek,
  };
}

// The column normally arrives with migration 023 (db/migrate.js runs on every
// boot). These scripts are also pointed at databases that have not booted the
// current server yet, and the INSERT below names the column, so create it here
// too — same self-migrating pattern as collectRealtime.ensureHolidayColumns().
async function ensureAxisColumn() {
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS hour_axis VARCHAR(16)`);
}

async function collectWeekly() {
  await ensureAxisColumn();
  // Support --city=lehigh, --exclude-cities=beijing,foo, and --limit=10 flags
  const cityArg = process.argv.find(a => a.startsWith('--city='));
  const excludeArg = process.argv.find(a => a.startsWith('--exclude-cities='));
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const cityFilter = cityArg ? cityArg.split('=')[1] : null;
  const excludeCities = excludeArg ? excludeArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : [];
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
  if (excludeCities.length > 0) {
    params.push(excludeCities);
    query += ` AND city <> ALL($${params.length})`;
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

  // Resilient query helper — retries up to 3× on transient pg pool errors
  // (ECONNRESET / ETIMEDOUT / connection terminated). The pool reconnects on
  // its own; we just have to not crash and not skip the row.
  const safeQuery = async (sql, params) => {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await pool.query(sql, params); }
      catch (err) {
        lastErr = err;
        const transient = /ETIMEDOUT|ECONNRESET|terminated|connection|EAI_AGAIN|ENOTFOUND/i.test(err.code || err.message || '');
        if (!transient || attempt === 3) throw err;
        const backoff = 1000 * attempt;
        console.warn(`  DB error (attempt ${attempt}/3): ${err.message} — retrying in ${backoff}ms`);
        await sleep(backoff);
      }
    }
    throw lastErr;
  };

  let consecutiveErrors = 0;
  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i];
    console.log(`[ML:Weekly] (${i + 1}/${venues.length}) ${venue.name} [${venue.city}]`);

    try {
      // Fetch BestTime weekly forecast
      const forecast = await fetchWeeklyForecast(venue.name, venue.address, venue.besttime_venue_id);
      if (!forecast) {
        await safeQuery(
          `UPDATE ml_venues
           SET besttime_attempted_at = NOW(),
               besttime_status = COALESCE(besttime_status, '404')
           WHERE id = $1`,
          [venue.id]
        );
        console.log('  Skipped — no BestTime data (marked 404)');
        skipped++;
        consecutiveErrors = 0;
        continue;
      }

      // Update besttime_venue_id if we got one + mark found
      if (forecast.venueId && !venue.besttime_venue_id) {
        await safeQuery(
          `UPDATE ml_venues
           SET besttime_venue_id = $1,
               besttime_attempted_at = NOW(),
               besttime_status = 'found'
           WHERE id = $2`,
          [forecast.venueId, venue.id]
        );
      } else {
        await safeQuery(
          `UPDATE ml_venues
           SET besttime_attempted_at = NOW(),
               besttime_status = 'found'
           WHERE id = $1`,
          [venue.id]
        );
      }

      // Fetch weather for this venue's location (representative snapshot)
      const weather = await getWeather(venue.latitude, venue.longitude);

      // Insert 168 rows (7 days × 24 hours) — batched into a single multi-row INSERT
      let venueRows = 0;
      const params = [];
      const valueRows = [];
      let p = 0;
      for (const day of forecast.days) {
        const jsDayOfWeek = bestTimeDayToJsDay(day.dayInt);
        // `slot` is BestTime's array index, NOT an hour. See THE HOUR AXIS above.
        for (let slot = 0; slot < day.hours.length && slot < 24; slot++) {
          const busyness = day.hours[slot];
          if (busyness == null) continue;
          const local = bestTimeSlotToLocal(slot, jsDayOfWeek);
          params.push(
            venue.id, local.dayOfWeek, local.hour,
            venue.venue_category, venue.price_level, venue.rating, venue.review_count,
            weather?.temp ?? null, weather?.humidity ?? null, weather?.windSpeed ?? null,
            weather?.conditions ?? null, weather?.isRaining ?? null,
            Math.max(0, Math.min(100, busyness)), forecast.epochAnalysis,
          );
          valueRows.push(`($${++p}, 'weekly', '${HOUR_AXIS_VENUE_LOCAL}', $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`);
        }
      }
      if (valueRows.length > 0) {
        try {
          await safeQuery(
            `INSERT INTO ml_training_data
              (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, price_level, rating, review_count,
               temperature, humidity, wind_speed, weather_condition, is_raining, busyness_pct, besttime_epoch)
             VALUES ${valueRows.join(', ')}
             ON CONFLICT DO NOTHING`,
            params
          );
          venueRows = valueRows.length;
        } catch (err) {
          console.error(`  Batch insert error:`, err.message);
        }
      }

      totalRows += venueRows;
      console.log(`  ${venueRows} rows inserted`);

      // Update last_collected_at
      await safeQuery(
        'UPDATE ml_venues SET last_collected_at = NOW() WHERE id = $1',
        [venue.id]
      );

      consecutiveErrors = 0;
      await sleep(100);
    } catch (err) {
      // Key-level failures (401 bad key / 402 out of credits / 403) are not
      // venue problems — nothing further in this run can succeed, and before
      // this check every remaining venue would have burned an attempt. Stop now.
      if (err.fatal) {
        console.error(`  [FATAL] ${err.message} — aborting run immediately`);
        break;
      }
      // Per-venue errors must NOT kill the run. Log, count, sleep, continue.
      consecutiveErrors++;
      console.error(`  [PER-VENUE ERROR ${consecutiveErrors}] ${err.message}`);
      if (consecutiveErrors >= 10) {
        console.error('  10 consecutive errors — bailing to avoid burning slots');
        break;
      }
      await sleep(2000);
    }
  }

  console.log(`\n[ML:Weekly] Done. ${totalRows} total rows inserted. ${skipped} venues skipped.`);
  await pool.end();
}

async function run() {
  await collectWeekly();
}

module.exports = {
  run,
  bestTimeSlotToLocal,
  BESTTIME_DAY_START_HOUR,
  HOUR_AXIS_VENUE_LOCAL,
};

// Allow direct execution
if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Weekly] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
