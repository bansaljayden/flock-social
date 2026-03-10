// ---------------------------------------------------------------------------
// Discovers 250 venues across 5 cities via Google Places Text Search
// Populates ml_venues table. Safe to re-run (upserts).
// Run: node scripts/ml/discoverVenues.js
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { CITIES, VENUE_TARGETS, priceLevelToNum, sleep } = require('./config');

// Build DATABASE_URL from individual PG* vars if not set
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

async function searchPlaces(query, city) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.types,places.location',
    },
    body: JSON.stringify({
      textQuery: `${query} in ${city.name}`,
      locationBias: {
        circle: { center: { latitude: city.lat, longitude: city.lon }, radius: 20000.0 },
      },
      maxResultCount: 20,
    }),
  });

  if (!response.ok) {
    console.error(`[ML:Discover] Google Places search failed (${response.status}) for "${query}" in ${city.name}`);
    return [];
  }

  const data = await response.json();
  return data.places || [];
}

async function upsertVenue(place, cityKey, city, category) {
  const result = await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, address, city, latitude, longitude, venue_category, google_types, price_level, rating, review_count, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (google_place_id) DO UPDATE SET
       name = EXCLUDED.name,
       rating = EXCLUDED.rating,
       review_count = EXCLUDED.review_count,
       price_level = EXCLUDED.price_level,
       google_types = EXCLUDED.google_types,
       updated_at = NOW()
     RETURNING id, google_place_id`,
    [
      place.id,
      place.displayName?.text || '',
      place.formattedAddress || '',
      cityKey,
      place.location?.latitude,
      place.location?.longitude,
      category,
      place.types || [],
      priceLevelToNum(place.priceLevel),
      place.rating || null,
      place.userRatingCount || 0,
      city.tz,
    ]
  );
  return result.rows[0];
}

async function discover() {
  if (!API_KEY) {
    console.error('[ML:Discover] GOOGLE_PLACES_API_KEY not set');
    process.exit(1);
  }

  let totalInserted = 0;

  for (const [cityKey, city] of Object.entries(CITIES)) {
    let cityCount = 0;
    console.log(`\n[ML:Discover] Searching ${city.name}...`);

    for (const target of VENUE_TARGETS) {
      const places = await searchPlaces(target.query, city);
      let added = 0;

      for (const place of places) {
        if (added >= target.count) break;
        if (!place.location?.latitude || !place.location?.longitude) continue;

        try {
          await upsertVenue(place, cityKey, city, target.category);
          added++;
          cityCount++;
        } catch (err) {
          console.error(`[ML:Discover] Failed to insert ${place.displayName?.text}:`, err.message);
        }
      }

      console.log(`  ${target.category}: ${added}/${target.count} venues`);
      await sleep(200);
    }

    totalInserted += cityCount;
    console.log(`[ML:Discover] ${city.name}: ${cityCount} venues total`);
  }

  // Final count
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM ml_venues');
  console.log(`\n[ML:Discover] Done. ${totalInserted} venues processed. ${rows[0].count} total in ml_venues.`);
  await pool.end();
}

discover().catch(err => {
  console.error('[ML:Discover] Fatal error:', err);
  pool.end();
  process.exit(1);
});
