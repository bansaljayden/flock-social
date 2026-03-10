// ---------------------------------------------------------------------------
// Discover venues via BestTime Venue Search (Normal)
// Uses 1 credit per 20 venues. Returns venues WITH forecast data.
// Run: node scripts/ml/discoverBestTime.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { sleep } = require('./config');

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

async function upsertVenue(venue, cityKey, city) {
  const category = mapCategory(venue.venue_type || venue.venue_name);

  // Use besttime venue_id as a pseudo google_place_id since these come from BestTime
  const pseudoPlaceId = `bt_${venue.venue_id}`;

  const result = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, address, city, latitude, longitude, venue_category, google_types, price_level, rating, review_count, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (google_place_id) DO UPDATE SET
       besttime_venue_id = COALESCE(EXCLUDED.besttime_venue_id, ml_venues.besttime_venue_id),
       updated_at = NOW()
     RETURNING id, google_place_id`,
    [
      pseudoPlaceId,
      venue.venue_id || null,
      venue.venue_name || '',
      venue.venue_address || '',
      cityKey,
      venue.venue_lat || 0,
      venue.venue_lon || 0,
      category,
      venue.venue_types || [],
      null, // BestTime doesn't return price level
      null, // BestTime doesn't return rating
      0,
      city.tz,
    ]
  );
  return result.rows[0];
}

async function insertForecastData(venueDbId, venue, category) {
  const forecast = venue.venue_foot_traffic_forecast;
  if (!forecast || !Array.isArray(forecast)) return 0;

  let rows = 0;
  for (const day of forecast) {
    const dayInt = day.day_int;
    const hourly = day.day_raw || [];

    for (let hour = 0; hour < hourly.length && hour < 24; hour++) {
      const busyness = hourly[hour];
      if (busyness == null) continue;

      try {
        await pool.query(
          `INSERT INTO ml_training_data
            (venue_id, collection_mode, day_of_week, hour, venue_category, price_level, rating, review_count, busyness_pct)
          VALUES ($1, 'weekly', $2, $3, $4, $5, $6, $7, $8)`,
          [
            venueDbId,
            dayInt === 6 ? 0 : dayInt + 1, // BestTime Mon=0..Sun=6 → JS Sun=0..Sat=6
            hour,
            category,
            null,
            null,
            0,
            Math.max(0, Math.min(100, busyness)),
          ]
        );
        rows++;
      } catch (err) {
        if (err.code !== '23505') {
          console.error(`  Row insert error:`, err.message);
        }
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

  let totalVenues = 0;
  let totalRows = 0;
  let searchesUsed = 0;

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

        try {
          const dbVenue = await upsertVenue(venue, cityKey, city);
          const category = mapCategory(venue.venue_type || venue.venue_name);

          // Insert forecast data if available
          const rows = await insertForecastData(dbVenue.id, venue, category);
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
  console.log(`  Training rows inserted: ${totalRows}`);
  console.log(`  Total venues in ml_venues: ${rows[0].count}`);
  await pool.end();
}

discover().catch(err => {
  console.error('[ML:BTSearch] Fatal error:', err);
  pool.end();
  process.exit(1);
});
