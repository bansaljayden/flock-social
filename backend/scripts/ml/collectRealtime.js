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
const { getNearestEvent } = require('./eventService');
const { specialNightFor, isHolidayEve } = require('./specialNights');
const { refreshCollectedBaselines, REFUSAL_MESSAGE } = require('./buildBaselines');

// ---------------------------------------------------------------------------
// THE HOUR AXIS. This collector has always written the TRUE venue-local hour
// (config.getLocalTime(tz).hour) into ml_training_data.hour — but it never said
// so, and scripts/ml/collectWeekly.js was writing BestTime's array index into
// the same column. Two clocks, one column, nothing marking which. Every row
// written from here now declares `hour_axis = 'venue_local'`; migration 023
// converts the weekly half to the same axis and adds the CHECK constraint that
// stops an undeclared weekly row from ever being inserted again.
// ---------------------------------------------------------------------------
const HOUR_AXIS_VENUE_LOCAL = 'venue_local';

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

// An explicit PGSSLMODE wins (see config/database.js, and the same line in
// collectWeekly.js) — which also lets the embedded-Postgres harness in
// __tests__/mlClockAxisBackfill.test.js run this collector for real.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

// Dated holiday context (2026-08-12): every realtime row now records WHEN it
// was observed and what special night it was, so retrains can learn eve/party/
// ban effects. Weekly rows stay dateless by design ("typical Tuesday").
async function ensureHolidayColumns() {
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS observed_date DATE`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS is_holiday_eve BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS special_night VARCHAR(40)`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS special_night_effect VARCHAR(8)`);
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS special_night_conf VARCHAR(4)`);
  // Round 10: 'live' when BestTime reported live foot traffic, 'forecast' when
  // we fell back to their forecast. Both land in collection_mode='realtime',
  // and before this column existed both were exported as is_realtime=1 and
  // trained at sample weight 1.0 — a vendor forecast carrying more confidence
  // than any other label in the corpus. NULL on rows collected before this.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS label_source VARCHAR(10)`);
  // Which clock this row's `hour` is on. Normally created by migration 023;
  // created here too because these scripts also run against databases that have
  // not booted the current server, and the INSERT below names the column.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS hour_axis VARCHAR(16)`);
}

async function collectRealtime() {
  await ensureHolidayColumns();
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
  let liveRows = 0;
  let forecastRows = 0;
  // Round 13: fetchLiveBusyness now throws on outage/rate-limit (transient)
  // and key/credit failures (fatal) instead of returning null. Before, a dead
  // key or a BestTime outage looked identical to "no live data for this
  // venue": the loop kept firing one doomed request per venue (thousands of
  // them, 250ms apart) and the summary line cheerfully reported them as
  // "skipped". Transient errors bail after 10 in a row; fatal bails instantly.
  let consecutiveErrors = 0;
  let aborted = false;

  for (const [cityKey, cityVenues] of Object.entries(byCity)) {
    if (aborted) break;
    const cityConfig = CITIES[cityKey];
    if (!cityConfig) continue;

    // One weather call per city
    const weather = await getWeather(cityConfig.lat, cityConfig.lon);
    const local = getLocalTime(cityConfig.tz);
    const special = specialNightFor(cityKey, local.dateStr);
    const holidayEve = isHolidayEve(cityKey, local.dateStr);

    console.log(`\n[ML:Realtime] ${cityConfig.name} (${local.dateStr} ${local.hour}:00 local)`
      + (special ? ` [${special.name}: ${special.effect}]` : '') + (holidayEve ? ' [holiday eve]' : ''));

    for (const venue of cityVenues) {
      let live;
      try {
        live = await fetchLiveBusyness(venue.besttime_venue_id);
        consecutiveErrors = 0;
      } catch (err) {
        if (err.fatal) {
          console.error(`[ML:Realtime] FATAL: ${err.message} — aborting run`);
          aborted = true;
          break;
        }
        consecutiveErrors++;
        console.error(`[ML:Realtime] Transient error ${consecutiveErrors}/10 for ${venue.name}: ${err.message}`);
        if (consecutiveErrors >= 10) {
          console.error('[ML:Realtime] 10 consecutive errors — BestTime looks down, aborting run');
          aborted = true;
          break;
        }
        await sleep(2000);
        continue;
      }
      if (!live) {
        skipped++;
        continue;
      }

      // Use live busyness if available, else forecasted. Round 10: record
      // WHICH, so training can stop treating a vendor forecast as ground truth.
      const usedLive = !!live.liveAvailable && live.liveBusyness != null;
      const busyness = usedLive ? live.liveBusyness : live.forecastedBusyness;
      const labelSource = usedLive ? 'live' : 'forecast';
      if (busyness == null) {
        skipped++;
        continue;
      }

      // Look up the weekly baseline for this venue at the current venue-local
      // day/hour. local.hour is a wall clock hour, so only weekly rows that
      // DECLARE the venue-local axis may answer it: before migration 023 the
      // weekly rows held BestTime array indices, and this lookup silently
      // stamped every realtime row with the busyness of a slot six hours away.
      // An undeclared corpus now yields NULL — an honest "no baseline" — rather
      // than a confident wrong number. (Nothing in training reads this column:
      // train/export_training_data.js recomputes the baseline leave-one-out at
      // export time. It is kept for operational inspection.)
      let baseline = null;
      try {
        const { rows: baselineRows } = await pool.query(
          `SELECT ROUND(AVG(busyness_pct)) AS avg
           FROM ml_training_data
           WHERE venue_id = $1 AND collection_mode = 'weekly'
             AND hour_axis = $4
             AND day_of_week = $2 AND hour = $3 AND busyness_pct IS NOT NULL`,
          [venue.id, local.dayOfWeek, local.hour, HOUR_AXIS_VENUE_LOCAL]
        );
        baseline = baselineRows[0]?.avg ?? null;
      } catch (_) {}

      // Fetch nearby event data (graceful — nulls if no API key or error)
      let eventData = { event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null };
      try {
        eventData = await getNearestEvent(venue.latitude, venue.longitude);
      } catch (err) {
        console.error(`  Event fetch error for ${venue.name}:`, err.message);
      }

      try {
        await pool.query(
          `INSERT INTO ml_training_data
            (venue_id, collection_mode, hour_axis, day_of_week, hour, month, season, is_holiday, is_school_break,
             venue_category, price_level, rating, review_count,
             temperature, humidity, wind_speed, weather_condition, is_raining,
             event_nearby, event_distance_km, event_size, event_type, event_hours_until,
             baseline_busyness, busyness_pct,
             observed_date, is_holiday_eve, special_night, special_night_effect, special_night_conf,
             label_source)
          VALUES ($1, 'realtime', $30, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                  $24, $25, $26, $27, $28, $29)`,
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
            eventData.event_nearby,
            eventData.event_distance_km,
            eventData.event_size,
            eventData.event_type,
            eventData.event_hours_until,
            baseline,
            Math.max(0, Math.min(100, busyness)),
            local.dateStr,
            holidayEve,
            special?.name ?? null,
            special?.effect ?? null,
            special?.conf ?? null,
            labelSource,
            HOUR_AXIS_VENUE_LOCAL,
          ]
        );
        totalRows++;
        if (usedLive) liveRows++; else forecastRows++;
      } catch (err) {
        console.error(`  Insert error for ${venue.name}:`, err.message);
      }

      await sleep(100);
    }
  }

  console.log(`\n[ML:Realtime] ${aborted ? 'ABORTED EARLY' : 'Done'}. ${totalRows} rows inserted `
    + `(${liveRows} live-observed, ${forecastRows} vendor-forecast). ${skipped} venues skipped.`);
}

async function run() {
  await collectRealtime();
  // Refresh baselines. This used to be a second, hand-written copy of
  // buildBaselines.js's statement that had drifted from it: no
  // `collection_mode = 'weekly'` filter at all, so it averaged live realtime
  // readings and weekly forecast rows — on two different hour axes — into the
  // same baseline slot, and whichever script ran last decided what a venue's
  // baseline meant. One definition now, in buildBaselines.js.
  try {
    console.log('[ML:Realtime] Refreshing venue baselines...');
    const result = await refreshCollectedBaselines(pool);
    if (!result.ok) {
      console.error(`[ML:Realtime] Baseline refresh ${REFUSAL_MESSAGE}`);
    } else {
      console.log(`[ML:Realtime] Baselines refreshed (${result.upserted} changed, ${result.deleted} stale removed)`);
    }
  } catch (err) {
    console.error('[ML:Realtime] Baseline refresh failed:', err.message);
  }
  await pool.end();
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Realtime] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
