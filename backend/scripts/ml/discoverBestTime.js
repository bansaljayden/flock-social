// ---------------------------------------------------------------------------
// Discover venues via BestTime Venue Search (Normal)
// Uses 1 credit per 20 venues. Returns venues WITH forecast data.
// Run: node scripts/ml/discoverBestTime.js
// ---------------------------------------------------------------------------
// TWO DEFECTS WERE FOUND HERE ON 2026-09-04, both against the production dump.
// They are written out because each one had been running for months while the
// script's own log line said the run had gone fine.
//
// ONE: THIS SCRIPT MINTED A SECOND IDENTITY FOR VENUES WE ALREADY HAD.
// BestTime's search answers with a BestTime venue id and no Google place id, so
// the insert below built one — `bt_${venue.venue_id}` — and upserted
// `ON CONFLICT (google_place_id)`. ml_venues is UNIQUE on google_place_id and
// on nothing else, so a venue already stored under its REAL Google place id did
// not conflict with anything: it got a SECOND row under the pseudo id, carrying
// the same besttime_venue_id.
//
// The 2026-09-03 dump holds 933 BestTime venue ids mapping to two or more
// ml_venues rows. 111 of those groups are active philly/lehigh venues, which is
// exactly the hourly realtime cron's scope, so every sweep pays two BestTime
// credits for one physical venue and writes two rows for one observation.
// Willow Grove Park is ml_venues 33840 (`bt_ven_556d6c...`, category 'park',
// rating NULL, review_count 0) AND 49000 (`ChIJfxx3xTuwxokRg2ccehxvlmU`,
// category 'mall', rating 4.4, review_count 9880). Both active, both philly,
// both carrying the same besttime_venue_id, both handed 168 identical weekly
// rows by the same 2026-09-01 run. Migration 024's unique indexes are keyed on
// venue_id, so they cannot see this: two venue ids are two venues as far as
// they are concerned. train/export_training_data.js joins ml_venues, so both
// copies are exported, and the per-venue averages and the category baselines
// double-count them.
//
// The arbiter is now besttime_venue_id, which is the thing BestTime is actually
// identifying, and migration 060 gives that column the unique index that makes
// the clause enforceable. scripts/ml/repairBestTimeDiscoveredVenues.js merges
// the groups already stored.
//
// TWO: EVERY TRAINING ROW THIS SCRIPT WROTE WAS REJECTED, AND IT REPORTED
// SUCCESS. The loop iterated BestTime's `day_raw` array and wrote the ARRAY
// INDEX into `hour` — six hours off the venue clock, with no day rollover for
// slots 18 to 23 — and never set hour_axis. Migration 023's
// ml_training_data_weekly_axis_declared CHECK rejects a weekly row that does not
// declare its axis, so every insert raised 23514, and the catch below suppressed
// only 23505. The run logged one error per row, printed "Training rows
// inserted: 0", and exited 0. The slots now go through collectWeekly's exported
// bestTimeSlotToLocal, which is the one place that transform is written down,
// and the row states its axis like every other weekly row in the corpus.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { bestTimeDayToJsDay, sleep } = require('./config');
// IMPORTED, NEVER REIMPLEMENTED. The slot -> (venue-local day, hour) transform
// exists once, in collectWeekly.js, and migration 023's SQL is pinned against
// that same function by __tests__/mlClockAxisBackfill.test.js. A second copy
// here is how the two would drift, and a six-hour drift in this column is the
// defect that made a dinner restaurant read 20% at 6 PM.
const {
  bestTimeSlotToLocal, venueCalendar, requireSlotIndex,
  HOUR_AXIS_VENUE_LOCAL, WEEKLY_SLOT_INDEX,
} = require('./collectWeekly');

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

const API_KEY = process.env.BESTTIME_API_KEY;

// New cities for Month 2 expansion
const EXPANSION_CITIES = {
  // Original expansion
  sydney:     { name: 'Sydney',        lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' },
  delhi:      { name: 'Delhi',         lat: 28.6139,  lon: 77.2090,  tz: 'Asia/Kolkata' },
  beijing:    { name: 'Beijing',       lat: 39.9042,  lon: 116.4074, tz: 'Asia/Shanghai' },
  paris:      { name: 'Paris',         lat: 48.8566,  lon: 2.3522,   tz: 'Europe/Paris' },
  madrid:     { name: 'Madrid',        lat: 40.4168,  lon: -3.7038,  tz: 'Europe/Madrid' },
  philly:     { name: 'Philadelphia',  lat: 39.9526,  lon: -75.1652, tz: 'America/New_York' },
  dallas:     { name: 'Dallas',        lat: 32.7767,  lon: -96.7970, tz: 'America/Chicago' },
  // US
  austin:     { name: 'Austin',        lat: 30.2672,  lon: -97.7431, tz: 'America/Chicago' },
  seattle:    { name: 'Seattle',       lat: 47.6062,  lon: -122.3321, tz: 'America/Los_Angeles' },
  denver:     { name: 'Denver',        lat: 39.7392,  lon: -104.9903, tz: 'America/Denver' },
  boston:      { name: 'Boston',        lat: 42.3601,  lon: -71.0589, tz: 'America/New_York' },
  nashville:  { name: 'Nashville',     lat: 36.1627,  lon: -86.7816, tz: 'America/Chicago' },
  nola:       { name: 'New Orleans',   lat: 29.9511,  lon: -90.0715, tz: 'America/Chicago' },
  // Latin America
  mexico:     { name: 'Mexico City',   lat: 19.4326,  lon: -99.1332, tz: 'America/Mexico_City' },
  saopaulo:   { name: 'São Paulo',     lat: -23.5505, lon: -46.6333, tz: 'America/Sao_Paulo' },
  buenosaires: { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires' },
  // Europe
  berlin:     { name: 'Berlin',        lat: 52.5200,  lon: 13.4050,  tz: 'Europe/Berlin' },
  amsterdam:  { name: 'Amsterdam',     lat: 52.3676,  lon: 4.9041,   tz: 'Europe/Amsterdam' },
  rome:       { name: 'Rome',          lat: 41.9028,  lon: 12.4964,  tz: 'Europe/Rome' },
  barcelona:  { name: 'Barcelona',     lat: 41.3874,  lon: 2.1686,   tz: 'Europe/Madrid' },
  // Middle East/Africa
  dubai:      { name: 'Dubai',         lat: 25.2048,  lon: 55.2708,  tz: 'Asia/Dubai' },
  capetown:   { name: 'Cape Town',     lat: -33.9249, lon: 18.4241,  tz: 'Africa/Johannesburg' },
  // Asia-Pacific
  singapore:  { name: 'Singapore',     lat: 1.3521,   lon: 103.8198, tz: 'Asia/Singapore' },
  seoul:      { name: 'Seoul',         lat: 37.5665,  lon: 126.9780, tz: 'Asia/Seoul' },
  bangkok:    { name: 'Bangkok',       lat: 13.7563,  lon: 100.5018, tz: 'Asia/Bangkok' },
  mumbai:     { name: 'Mumbai',        lat: 19.0760,  lon: 72.8777,  tz: 'Asia/Kolkata' },
  // Canada
  toronto:    { name: 'Toronto',       lat: 43.6532,  lon: -79.3832, tz: 'America/Toronto' },
};

const SEARCH_QUERIES = [
  'popular restaurants',
  'bars',
  'coffee shops',
  'nightclubs',
  'fast food',
  'gyms',
  'shopping malls',
  'breweries',
  'ice cream shops',
  'museums',
];

// Category mapping from BestTime types
function mapCategory(venueTypes) {
  if (!venueTypes) return 'other';
  const t = venueTypes.toLowerCase();
  if (t.includes('bar') || t.includes('pub')) return 'bar';
  if (t.includes('night') || t.includes('club')) return 'nightclub';
  if (t.includes('cafe') || t.includes('coffee')) return 'cafe';
  if (t.includes('gym') || t.includes('fitness')) return 'gym';
  if (t.includes('mall') || t.includes('shop')) return 'mall';
  if (t.includes('museum')) return 'museum';
  if (t.includes('brewery')) return 'brewery';
  if (t.includes('fast food')) return 'fast_food';
  if (t.includes('ice cream') || t.includes('dessert') || t.includes('bakery')) return 'dessert';
  if (t.includes('theater') || t.includes('cinema')) return 'movie_theater';
  if (t.includes('park')) return 'park';
  return 'restaurant';
}

async function submitSearch(query, city) {
  const params = new URLSearchParams({
    api_key_private: API_KEY,
    q: `${query} in ${city.name}`,
    num: 20,
  });

  const response = await fetch(`https://besttime.app/api/v1/venues/search?${params}`, {
    method: 'POST',
  });

  if (!response.ok) {
    console.error(`[ML:BTSearch] Search failed (${response.status}) for "${query}" in ${city.name}`);
    return null;
  }

  const data = await response.json();
  if (data.status !== 'OK') {
    console.error(`[ML:BTSearch] Search error for "${query}" in ${city.name}:`, data.message);
    return null;
  }

  return { jobId: data.job_id, collectionId: data.collection_id, link: data._links?.venue_search_progress };
}

async function pollResults(jobId, collectionId) {
  const maxAttempts = 30;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);

    const params = new URLSearchParams({
      job_id: jobId,
      collection_id: collectionId,
      ven: 'True',
    });

    const response = await fetch(`https://besttime.app/api/v1/venues/progress?${params}`);
    if (!response.ok) continue;

    const data = await response.json();

    if (data.job_finished) {
      return data.venues || [];
    }
  }

  console.warn('[ML:BTSearch] Poll timed out');
  return [];
}

// The name of the unique index migration 060 builds. Named here rather than
// spelled inline so the refusal below, the ON CONFLICT clause and the repair
// script cannot drift apart about which index they mean.
const VENUE_ID_INDEX = 'ml_venues_besttime_venue_id_uniq';

// Same refusal collectWeekly.requireSlotIndex makes, for the same reason and
// with a different remedy. A missing COLUMN can be created from a collector; a
// missing unique INDEX cannot, because building one means first deciding what
// to do with the duplicates the database is already holding, and here that
// decision is a merge across two venue rows. Without this check Postgres raises
// 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
// specification") once per venue, the per-venue catch logs it as a failed
// insert, and a run of thousands of venues says nothing about why.
async function requireVenueIdIndex(client) {
  const { rows } = await client.query(
    `SELECT i.indisvalid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [VENUE_ID_INDEX]
  );
  if (rows.length === 0) {
    throw new Error(
      `${VENUE_ID_INDEX} does not exist on this database. Migration `
      + '060_ml_venues_besttime_identity.sql builds it, but it SKIPS the build while two ml_venues '
      + 'rows still share a besttime_venue_id, because a boot-time migration must not choose which '
      + 'of two venue rows to retire. Run scripts/ml/repairBestTimeDiscoveredVenues.js (report only '
      + 'by default, --commit to write) — it merges those groups and builds this index itself.'
    );
  }
  if (rows[0].indisvalid === false) {
    throw new Error(
      `${VENUE_ID_INDEX} exists but is INVALID — a CREATE INDEX CONCURRENTLY died partway. `
      + 'It still enforces itself on every insert and is ignored by the planner. Drop it and re-run '
      + 'scripts/ml/repairBestTimeDiscoveredVenues.js --commit to rebuild it.'
    );
  }
}

async function upsertVenue(venue, cityKey, city) {
  const category = mapCategory(venue.venue_type || venue.venue_name);

  // A pseudo google_place_id is still minted, because google_place_id is NOT
  // NULL and BestTime's search does not return one. What changed is that it is
  // no longer the ARBITER: 832 venues in the corpus exist only because this
  // script found them and have no Google record at all, so the pseudo id is a
  // real identity for them. It just is not the identity that says whether we
  // already know this venue.
  const pseudoPlaceId = `bt_${venue.venue_id}`;

  const result = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, address, city, latitude, longitude, venue_category, google_types, price_level, rating, review_count, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     -- THE ARBITER IS THE BESTTIME ID. The index is partial, so its predicate is
     -- repeated verbatim; that is what lets Postgres infer it. venue.venue_id is
     -- checked by the caller, so the inserted value is never NULL and this row
     -- is always inside the index.
     ON CONFLICT (besttime_venue_id) WHERE besttime_venue_id IS NOT NULL
     DO UPDATE SET updated_at = NOW()
     RETURNING id, google_place_id, venue_category, price_level, rating, review_count`,
    [
      pseudoPlaceId,
      venue.venue_id,
      venue.venue_name || '',
      venue.venue_address || '',
      cityKey,
      Number(venue.venue_lat),
      Number(venue.venue_lon),
      category,
      venue.venue_types || [],
      null, // BestTime doesn't return price level
      null, // BestTime doesn't return rating
      // NULL, not 0. BestTime does not report review counts, and a stored zero
      // is not "unknown", it is "nobody has ever been here" — the far end of
      // the range. train/prepare_features.py imputes a missing review_count
      // with the corpus median the way it already does for rating; a stored 0
      // is taken at face value instead, and paired with the median rating it
      // becomes a learnable signature for "this row came from the discovery
      // path". Migration 060 drops the column's DEFAULT 0 so this NULL survives.
      null,
      city.tz,
    ]
  );

  // DO UPDATE SET updated_at, and NOTHING ELSE, which is deliberate. The row we
  // conflicted with is either a venue Google gave us (rating, review count,
  // price level, a real category) or an earlier discovery of this same BestTime
  // venue. Everything in EXCLUDED is either equal to what is stored or poorer
  // than it: Willow Grove Park is a 'mall' with 9,880 reviews in Google's
  // record and a 'park' with none in BestTime's. Overwriting would be the same
  // defect in a quieter form. DO NOTHING would be tempting and is wrong: it
  // returns no row, and the id is what the forecast attaches to.
  return result.rows[0];
}

// `dbVenue` is the ml_venues row the upsert returned, NOT the BestTime payload.
// The venue metadata columns are copied off it for the same reason
// collectWeekly copies them off its own row: when the conflict path matched a
// venue Google enriched, these rows must carry Google's rating and category,
// not the blanks BestTime returns. A row written under the venue id of a 4.4
// star mall that says 'park' with no rating is a row that disagrees with its
// own venue.
async function insertForecastData(dbVenue, venue, city) {
  const forecast = venue.venue_foot_traffic_forecast;
  if (!forecast || !Array.isArray(forecast)) return 0;

  // When the snapshot was taken, on the venue's clock. Same function
  // collectWeekly uses, so a typical week collected here and a typical week
  // collected there carry the same calendar meaning.
  const calendar = venueCalendar({ timezone: city.tz });

  let rows = 0;
  // The transform is a rotation of the 168-cell week, so a well-formed forecast
  // cannot land on the same cell twice. A vendor response that repeats a day
  // can, and the DO UPDATE below would silently let the second write win. Keep
  // the first, which is what collectWeekly does with the same situation.
  const seenCells = new Set();
  for (const day of forecast) {
    const jsDayOfWeek = bestTimeDayToJsDay(day.day_int);
    const hourly = day.day_raw || [];

    // `slot` is BestTime's day_raw INDEX, not an hour. Their day runs 06:00 to
    // 05:59, so slot 0 is the venue's 6 AM and slot 18 is the venue's midnight
    // — on the FOLLOWING calendar day, which is the half that used to be
    // missing entirely.
    for (let slot = 0; slot < hourly.length && slot < 24; slot++) {
      const busyness = hourly[slot];
      if (busyness == null) continue;

      const local = bestTimeSlotToLocal(slot, jsDayOfWeek);
      const cell = `${local.dayOfWeek}:${local.hour}`;
      if (seenCells.has(cell)) continue;
      seenCells.add(cell);

      try {
        await pool.query(
          `INSERT INTO ml_training_data
            (venue_id, collection_mode, hour_axis, day_of_week, hour, month, season,
             venue_category, price_level, rating, review_count, busyness_pct, besttime_epoch,
             events_observed, events_unavailable_reason,
             event_nearby, has_nearby_event, total_nearby_events, total_nearby_attendance,
             nearest_event_attendance, nearest_event_distance_km, nearest_event_type)
          VALUES ($1, 'weekly', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL,
                  false, 'no_observation_date',
                  NULL, NULL, NULL, NULL, NULL, NULL, NULL)
          -- Migration 024's weekly arbiter, predicate repeated verbatim because
          -- the index is partial. Without it this statement had no conflict
          -- target at all, so a re-run stacked another copy of the venue's week.
          ON CONFLICT (venue_id, day_of_week, hour)
            WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local'
          DO UPDATE SET
            hour_axis      = EXCLUDED.hour_axis,
            month          = EXCLUDED.month,
            season         = EXCLUDED.season,
            venue_category = EXCLUDED.venue_category,
            price_level    = EXCLUDED.price_level,
            rating         = EXCLUDED.rating,
            review_count   = EXCLUDED.review_count,
            busyness_pct   = EXCLUDED.busyness_pct,
            -- The search endpoint does not say which analysis epoch produced
            -- these numbers, so there is nothing true to write. Leaving a
            -- previous fetch's epoch beside a fresh busyness would be a claim
            -- about provenance that nobody made.
            besttime_epoch = NULL,
            events_observed = EXCLUDED.events_observed,
            events_unavailable_reason = EXCLUDED.events_unavailable_reason,
            -- All seven, explicitly, on the insert AND here. Their SQL defaults
            -- are false/false/0/0, so a row that omits them asserts a measured
            -- "no event nearby" next to an honest "nothing was measured" —
            -- the fabricated negative migration 045 and
            -- repairFabricatedEventAbsence.js exist to end.
            event_nearby   = EXCLUDED.event_nearby,
            has_nearby_event = EXCLUDED.has_nearby_event,
            total_nearby_events = EXCLUDED.total_nearby_events,
            total_nearby_attendance = EXCLUDED.total_nearby_attendance,
            nearest_event_attendance = EXCLUDED.nearest_event_attendance,
            nearest_event_distance_km = EXCLUDED.nearest_event_distance_km,
            nearest_event_type = EXCLUDED.nearest_event_type,
            collected_at   = NOW()`,
          [
            dbVenue.id,
            HOUR_AXIS_VENUE_LOCAL,
            local.dayOfWeek,
            local.hour,
            calendar.month,
            calendar.season,
            dbVenue.venue_category,
            dbVenue.price_level,
            dbVenue.rating,
            dbVenue.review_count,
            Math.max(0, Math.min(100, busyness)),
          ]
        );
        rows++;
      } catch (err) {
        // EVERY error is printed now. The old catch swallowed 23505 on the
        // theory that a duplicate slot was expected and harmless; what it
        // actually hid was 23514, migration 023's axis CHECK, raised on every
        // single row this function ever wrote. With a real conflict target
        // there is no expected error left to suppress.
        console.error(`  Row insert error (${err.code || 'no code'}):`, err.message);
      }
    }
  }
  return rows;
}

async function discover() {
  if (!API_KEY) {
    console.error('[ML:BTSearch] BESTTIME_API_KEY not set');
    process.exit(1);
  }

  // Support --cities flag (comma-separated) or default to all expansion cities
  const citiesArg = process.argv.find(a => a.startsWith('--cities='));
  const cityKeys = citiesArg
    ? citiesArg.split('=')[1].split(',')
    : Object.keys(EXPANSION_CITIES);

  // Both refusals before the first paid search, not after it. Each names a
  // clause this run depends on being enforceable; a run that cannot upsert is a
  // run that spends credits to write nothing.
  await requireVenueIdIndex(pool);
  await requireSlotIndex(pool, WEEKLY_SLOT_INDEX);

  let totalVenues = 0;
  let totalRows = 0;
  let searchesUsed = 0;
  let noCoords = 0;

  for (const cityKey of cityKeys) {
    const city = EXPANSION_CITIES[cityKey];
    if (!city) {
      console.error(`[ML:BTSearch] Unknown city: ${cityKey}`);
      continue;
    }

    console.log(`\n[ML:BTSearch] Searching ${city.name}...`);

    for (const query of SEARCH_QUERIES) {
      console.log(`  Query: "${query} in ${city.name}"`);

      const job = await submitSearch(query, city);
      if (!job) continue;
      searchesUsed++;

      const venues = await pollResults(job.jobId, job.collectionId);
      console.log(`  Found ${venues.length} venues`);

      for (const venue of venues) {
        if (!venue.venue_id || !venue.venue_name) continue;

        // A VENUE WITH NO COORDINATES IS SKIPPED, NOT PLACED IN THE ATLANTIC.
        // The insert used to read `venue.venue_lat || 0`, so a missing or
        // unparseable coordinate stored the venue at 0,0 — a point in the Gulf
        // of Guinea. latitude and longitude are NOT NULL on ml_venues, so there
        // is no honest value to write instead, and the consequences are not
        // cosmetic: enrichWithEvents measures event distance from it,
        // collectRealtime's weather lookup fetches conditions for it, and
        // mlPredictor's astronomy and special-night features are computed from
        // it. A venue we cannot place is worth less than one we do not have.
        const lat = Number(venue.venue_lat);
        const lon = Number(venue.venue_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          noCoords++;
          console.warn(`  SKIP (no coordinates) ${venue.venue_name}`);
          continue;
        }

        try {
          const dbVenue = await upsertVenue(venue, cityKey, city);

          // Insert forecast data if available
          const rows = await insertForecastData(dbVenue, venue, city);
          if (rows > 0) totalRows += rows;
          totalVenues++;
        } catch (err) {
          console.error(`  Failed to insert ${venue.venue_name}:`, err.message);
        }
      }

      await sleep(500);
    }
  }

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM ml_venues');
  console.log(`\n[ML:BTSearch] Done.`);
  console.log(`  Searches used: ${searchesUsed} (of 20,000 Normal/month)`);
  console.log(`  New venues processed: ${totalVenues}`);
  console.log(`  Training rows written: ${totalRows}`);
  console.log(`  Skipped, no coordinates: ${noCoords}`);
  console.log(`  Total venues in ml_venues: ${rows[0].count}`);
  await pool.end();
}

module.exports = {
  discover,
  mapCategory,
  requireVenueIdIndex,
  VENUE_ID_INDEX,
};

// Allow direct execution — and ONLY direct execution. This file used to call
// discover() at import time, so requiring it from a test or a sibling script
// started a paid BestTime run against whatever DATABASE_URL happened to be set.
if (require.main === module) {
  discover().catch(err => {
    console.error('[ML:BTSearch] Fatal error:', err);
    pool.end();
    process.exit(1);
  });
}
