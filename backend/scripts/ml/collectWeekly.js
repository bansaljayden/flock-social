// ---------------------------------------------------------------------------
// Mode 1: Collect BestTime weekly patterns for all venues
// Produces 168 rows per venue (7 days × 24 hours)
// Run: node scripts/ml/collectWeekly.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { getWeather } = require('../../services/weatherService');
const { fetchWeeklyForecast } = require('./bestTimeService');
const { bestTimeDayToJsDay, getLocalTime, getSeason, sleep } = require('./config');

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

// ---------------------------------------------------------------------------
// month / season. This collector omitted both columns entirely, which is why
// 62.9% of the training corpus carried `month = 0` with all four season
// one-hots at zero — a combination services/mlPredictor.js can never produce at
// inference (it writes month 1..12 and exactly one season). Two thirds of the
// corpus sat in a region of feature space the serving path cannot reach, and
// train/prepare_features.py now REFUSES to run rather than fill it with zeros.
//
// What these two columns mean on a weekly row is worth being precise about:
// BestTime's "typical week" is an average over a trailing window, so the month
// is not the month the busyness happened in — it is the month the SNAPSHOT was
// taken in. That is genuine information about the row, and it is the same thing
// migration 024's backfill derives from `collected_at` for the existing rows, so
// the two agree.
//
// The venue's own wall clock is used, matching collectRealtime.js
// (config.getLocalTime(tz).month). ml_venues.timezone is not guaranteed usable —
// Intl throws on a bad zone name — and a venue with a typo'd timezone must not
// lose its whole week over a calendar column, so an unusable zone falls back to
// UTC. Exported for the test.
// ---------------------------------------------------------------------------
function venueCalendar(venue, at) {
  try {
    if (venue && venue.timezone) {
      const local = getLocalTime(venue.timezone, at);
      if (Number.isInteger(local.month) && local.month >= 1 && local.month <= 12) {
        return { month: local.month, season: local.season };
      }
    }
  } catch (_) { /* unusable timezone: fall through to UTC rather than skip the venue */ }
  const month = (at ? new Date(at) : new Date()).getUTCMonth() + 1;
  return { month, season: getSeason(month) };
}

// The column normally arrives with migration 023 (db/migrate.js runs on every
// boot). These scripts are also pointed at databases that have not booted the
// current server yet, and the INSERT below names the column, so create it here
// too — same self-migrating pattern as collectRealtime.ensureHolidayColumns().
async function ensureAxisColumn() {
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS hour_axis VARCHAR(16)`);
}

// The INSERT below names a conflict target. A missing column can be created
// here; a missing unique INDEX cannot — building one requires first collapsing
// whatever duplicates the database is already holding, which is migration 024's
// whole job and not something a collector should do behind an operator's back.
// So this checks and refuses. Without it, Postgres raises 42P10 ("no unique or
// exclusion constraint matching the ON CONFLICT specification") once per venue,
// the per-venue catch logs it as a batch insert error, and a run of thousands of
// venues reports "0 rows inserted" thousands of times without ever saying why.
const WEEKLY_SLOT_INDEX = 'ml_training_data_weekly_slot_uniq';
async function requireSlotIndex(client, indexName) {
  const { rows } = await client.query(
    `SELECT i.indisvalid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [indexName]
  );
  if (rows.length === 0) {
    throw new Error(
      `${indexName} does not exist on this database. Migration `
      + '024_ml_training_data_unique_slot.sql creates it (and collapses the duplicate rows it '
      + 'forbids); it runs on server boot. Boot the backend against this database first — '
      + 'without the index the ON CONFLICT clause in this collector has nothing to hit.'
    );
  }
  if (rows[0].indisvalid === false) {
    throw new Error(
      `${indexName} exists but is INVALID — a CREATE INDEX CONCURRENTLY died partway. `
      + 'It still enforces itself on every insert and is ignored by the planner. Re-run migration '
      + '024 (delete its row from schema_migrations and boot); its cleanup block drops and rebuilds it.'
    );
  }
}

async function collectWeekly() {
  await ensureAxisColumn();
  await requireSlotIndex(pool, WEEKLY_SLOT_INDEX);
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
  // --only-found is the REFRESH mode: only venues whose besttime_venue_id is
  // already stored, which bills at 1 credit by id instead of 2 by name, and
  // which skips every historical 404 that would otherwise be re-attempted at
  // 1 credit per failure (about $20-40 of nothing on a full PA pass). This is
  // the flag the two paid collection windows run under. It contradicts
  // --skip-collected (which selects the OPPOSITE set) so that pairing refuses
  // to run rather than silently selecting zero venues.
  const onlyFound = process.argv.includes('--only-found');
  if (onlyFound && skipCollected) {
    console.error('[ML:Weekly] --only-found and --skip-collected select opposite sets. Pick one.');
    process.exit(1);
  }

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
  if (onlyFound) {
    query += ' AND besttime_venue_id IS NOT NULL';
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
  let newRows = 0;
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

      // When this snapshot was taken, on the venue's own clock. One value for
      // the whole week — the 168 rows are one fetch.
      const calendar = venueCalendar(venue);

      // Insert 168 rows (7 days × 24 hours) — batched into a single multi-row INSERT
      let venueRows = 0;
      let venueNew = 0;
      const params = [];
      const valueRows = [];
      // The slot -> (day, hour) transform is a rotation of the 168-cell week, so
      // a well-formed forecast cannot produce the same cell twice. A vendor
      // response that repeats a day CAN, and `ON CONFLICT ... DO UPDATE` raises
      // 21000 ("cannot affect row a second time") when one statement hits the
      // same key twice — which would throw away the whole venue's week over a
      // vendor glitch. Keep the first occurrence of each cell instead.
      const seenCells = new Set();
      let duplicateCells = 0;
      for (const day of forecast.days) {
        const jsDayOfWeek = bestTimeDayToJsDay(day.dayInt);
        // `slot` is BestTime's array index, NOT an hour. See THE HOUR AXIS above.
        for (let slot = 0; slot < day.hours.length && slot < 24; slot++) {
          const busyness = day.hours[slot];
          if (busyness == null) continue;
          const local = bestTimeSlotToLocal(slot, jsDayOfWeek);
          const cell = `${local.dayOfWeek}:${local.hour}`;
          if (seenCells.has(cell)) { duplicateCells++; continue; }
          seenCells.add(cell);
          // Built from the row's own values so the placeholder numbering cannot
          // drift out of step with the column list when a column is added.
          const rowParams = [
            venue.id, local.dayOfWeek, local.hour,
            calendar.month, calendar.season,
            venue.venue_category, venue.price_level, venue.rating, venue.review_count,
            weather?.temp ?? null, weather?.humidity ?? null, weather?.windSpeed ?? null,
            weather?.conditions ?? null, weather?.conditionId ?? null, weather?.isRaining ?? null,
            Math.max(0, Math.min(100, busyness)), forecast.epochAnalysis,
          ];
          const base = params.length;
          params.push(...rowParams);
          valueRows.push(
            `($${base + 1}, 'weekly', '${HOUR_AXIS_VENUE_LOCAL}', `
            + rowParams.slice(1).map((_, k) => `$${base + 2 + k}`).join(', ')
            + ')'
          );
        }
      }
      if (duplicateCells > 0) {
        console.warn(`  ${duplicateCells} repeated (day, hour) cells in the forecast — kept the first of each`);
      }
      if (valueRows.length > 0) {
        try {
          // THE CONFLICT TARGET IS REAL NOW. This clause used to be a bare
          // `ON CONFLICT DO NOTHING` with no arbiter, and no unique index
          // existed for it to hit — so every re-run stacked another full copy of
          // the venue's week and the log line still said "168 rows inserted".
          // Migration 024 adds ml_training_data_weekly_slot_uniq; naming its
          // columns and its predicate here is what makes the protection real.
          // The index is partial, so the predicate is repeated verbatim — that
          // is what lets Postgres infer this arbiter. It includes
          // `hour_axis = 'venue_local'` because an hour means nothing without
          // its clock, and because migration 023's rotation must stay re-runnable
          // (see that index's header in 024).
          //
          // DO UPDATE, not DO NOTHING: a weekly row is BestTime's ESTIMATE of a
          // typical week, and a re-collection is a fresher read of the same
          // estimate, so it should replace the stored one. DO NOTHING would
          // freeze the corpus at whatever was collected first and no
          // re-collection could ever correct a venue. Migration 024 collapsed
          // the historical duplicates by the same rule (newest wins), so history
          // and go-forward behaviour are one rule.
          //
          // Every non-key column of the INSERT must appear below. If you add a
          // column above and not here, a re-collection keeps the stale value.
          const res = await safeQuery(
            `INSERT INTO ml_training_data
              (venue_id, collection_mode, hour_axis, day_of_week, hour, month, season,
               venue_category, price_level, rating, review_count,
               temperature, humidity, wind_speed, weather_condition, weather_condition_code,
               is_raining, busyness_pct, besttime_epoch)
             VALUES ${valueRows.join(', ')}
             ON CONFLICT (venue_id, day_of_week, hour)
               WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local'
             DO UPDATE SET
               hour_axis              = EXCLUDED.hour_axis,
               month                  = EXCLUDED.month,
               season                 = EXCLUDED.season,
               venue_category         = EXCLUDED.venue_category,
               price_level            = EXCLUDED.price_level,
               rating                 = EXCLUDED.rating,
               review_count           = EXCLUDED.review_count,
               temperature            = EXCLUDED.temperature,
               humidity               = EXCLUDED.humidity,
               wind_speed             = EXCLUDED.wind_speed,
               weather_condition      = EXCLUDED.weather_condition,
               weather_condition_code = EXCLUDED.weather_condition_code,
               is_raining             = EXCLUDED.is_raining,
               busyness_pct           = EXCLUDED.busyness_pct,
               besttime_epoch         = EXCLUDED.besttime_epoch,
               collected_at           = NOW()
             RETURNING (xmax = 0) AS inserted`,
            params
          );
          // `xmax = 0` on a row returned by an upsert means it was INSERTed;
          // a non-zero xmax means the conflict path updated an existing row.
          // The old log said "168 rows inserted" for a run that inserted
          // nothing, which is the same class of untruth that let the missing
          // unique index hide for so long.
          venueRows = res.rows.length;
          venueNew = res.rows.filter((r) => r.inserted).length;
        } catch (err) {
          console.error(`  Batch insert error:`, err.message);
        }
      }

      totalRows += venueRows;
      newRows += venueNew;
      console.log(`  ${venueRows} rows written (${venueNew} new, ${venueRows - venueNew} refreshed)`);

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

  console.log(`\n[ML:Weekly] Done. ${totalRows} rows written `
    + `(${newRows} new, ${totalRows - newRows} refreshed in place). ${skipped} venues skipped.`);
  await pool.end();
}

async function run() {
  await collectWeekly();
}

module.exports = {
  run,
  bestTimeSlotToLocal,
  venueCalendar,
  requireSlotIndex,
  BESTTIME_DAY_START_HOUR,
  HOUR_AXIS_VENUE_LOCAL,
  WEEKLY_SLOT_INDEX,
};

// Allow direct execution
if (require.main === module) {
  run().catch(err => {
    console.error('[ML:Weekly] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
