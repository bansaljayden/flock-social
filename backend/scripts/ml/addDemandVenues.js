// ---------------------------------------------------------------------------
// ADD THE DEMAND WANT-LIST TO ml_venues
// ---------------------------------------------------------------------------
// The corpus was built by category search, so it holds the venues a query
// generator thought of. This adds the venues REAL USERS proved they care
// about and the corpus lacks: every distinct place a crowd score was served
// for (served_predictions), voted on (venue_votes), or checked into
// (venue_checkins) that has no ml_venues row. Measured 2026-08-28: 56.5% of
// all serves were such venues, which is why they go in before any
// breadth-by-category discovery spends another dollar.
//
// This script spends GOOGLE PLACES quota (one Details call per candidate),
// never BestTime credits. The BestTime admission happens afterwards through
// the normal collector, bounded and priced by its own guards:
//
//   node scripts/ml/addDemandVenues.js                (dry run: list only)
//   node scripts/ml/addDemandVenues.js --commit       (write ml_venues rows)
//   node scripts/ml/collectWeekly.js --city=philly --skip-attempted --limit=N
//   node scripts/ml/collectWeekly.js --city=lehigh --skip-attempted --limit=N
//
// Dry run is the DEFAULT because the Package tier admits at most 100 new
// venues a calendar month: the list gets eyeballed before anything is
// written, and --max-new refuses a surprise pileup the same way the
// collectors refuse a surprise bill.
//
// PA only, by geometry rather than trust: a candidate is assigned to philly
// or lehigh by nearest centroid and skipped entirely when it is more than
// MAX_KM from both. Demo serves and travel serves exist in
// served_predictions, and a Tokyo venue would otherwise ride in carrying a
// city label the collectors would then loyally spend credits on.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { priceLevelToNum, sleep } = require('./config');

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

const PA_CITIES = {
  philly: { lat: 39.9526, lon: -75.1652, tz: 'America/New_York' },
  lehigh: { lat: 40.6023, lon: -75.4714, tz: 'America/New_York' },
};
const MAX_KM = 80;

function kmBetween(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Google types to the corpus's own category vocabulary (the GROUP BY of
// ml_venues.venue_category). Order matters: the first match wins, and the
// specific types outrank the generic ones Google attaches to everything.
const TYPE_TO_CATEGORY = [
  ['night_club', 'nightclub'],
  ['movie_theater', 'movie_theater'],
  ['museum', 'museum'],
  ['park', 'park'],
  ['gym', 'gym'],
  ['fitness_center', 'gym'],
  ['shopping_mall', 'mall'],
  ['brewery', 'brewery'],
  ['bakery', 'dessert'],
  ['ice_cream_shop', 'dessert'],
  ['dessert_shop', 'dessert'],
  ['cafe', 'cafe'],
  ['coffee_shop', 'cafe'],
  ['bar', 'bar'],
  ['pub', 'bar'],
  ['fast_food_restaurant', 'fast_food'],
  ['hamburger_restaurant', 'fast_food'],
  ['bowling_alley', 'entertainment'],
  ['amusement_center', 'entertainment'],
  ['casino', 'entertainment'],
  ['restaurant', 'restaurant'],
];

function categoryFor(types) {
  const set = new Set(types || []);
  for (const [gType, category] of TYPE_TO_CATEGORY) {
    if (set.has(gType)) return category;
  }
  // Google stamps meal_delivery/food/establishment on almost anything edible;
  // a venue users met at is overwhelmingly likely a food-service place when
  // nothing sharper matched.
  return 'restaurant';
}

async function fetchDetails(placeId) {
  // 429 is Google saying slow down, not Google saying this place is gone.
  // The first dry run mislabeled live venues as unresolvable for exactly
  // that reason, so rate limiting retries with backoff, and a still-429
  // after the ladder is reported as rate limiting, never folded into gone.
  for (const backoff of [0, 2000, 5000]) {
    if (backoff) await sleep(backoff);
    const response = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      headers: {
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,types,priceLevel,rating,userRatingCount,businessStatus',
      },
    }
  );
    if (response.status === 429) continue;
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, place: await response.json() };
  }
  return { ok: false, status: 429, rateLimited: true };
}

async function main() {
  if (!API_KEY) {
    console.error('[ML:Demand] GOOGLE_PLACES_API_KEY not set');
    process.exitCode = 1;
    return pool.end();
  }
  const commit = process.argv.includes('--commit');
  const maxNewArg = process.argv.find((a) => a.startsWith('--max-new='));
  const maxNew = maxNewArg ? parseInt(maxNewArg.split('=')[1], 10) : 95;
  if (!Number.isInteger(maxNew) || maxNew <= 0) {
    console.error('[ML:Demand] --max-new must be a positive integer.');
    process.exitCode = 1;
    return pool.end();
  }

  // Every demand signal, weighted by how much intent it carries: a check-in
  // is a person standing in the room, a vote is a plan considering it, a
  // serve is a card somebody looked at.
  const { rows: candidates } = await pool.query(`
    WITH demand AS (
      SELECT venue_place_id AS place_id, COUNT(*)::int AS serves, 0 AS votes, 0 AS checkins
        FROM served_predictions GROUP BY 1
      UNION ALL
      SELECT venue_id, 0, COUNT(*)::int, 0
        FROM venue_votes WHERE venue_id IS NOT NULL GROUP BY 1
      UNION ALL
      SELECT venue_place_id, 0, 0, COUNT(*)::int
        FROM venue_checkins GROUP BY 1
    ),
    rolled AS (
      SELECT place_id,
             SUM(serves)::int AS serves,
             SUM(votes)::int AS votes,
             SUM(checkins)::int AS checkins,
             (SUM(serves) + SUM(votes) * 3 + SUM(checkins) * 5)::int AS signal
        FROM demand
       WHERE place_id IS NOT NULL AND LENGTH(place_id) BETWEEN 10 AND 255
       GROUP BY 1
    )
    SELECT r.*
      FROM rolled r
      LEFT JOIN ml_venues v ON v.google_place_id = r.place_id
     WHERE v.id IS NULL
     ORDER BY r.signal DESC, r.place_id
  `);

  console.log(`[ML:Demand] ${candidates.length} distinct demanded venues are missing from ml_venues.`);
  if (candidates.length === 0) return pool.end();
  if (candidates.length > maxNew) {
    console.log(`[ML:Demand] Taking the top ${maxNew} by signal (the Package tier admits 100 new venues a month; raise on purpose with --max-new=N).`);
  }
  const take = candidates.slice(0, maxNew);

  let inserted = 0;
  let outOfArea = 0;
  let gone = 0;
  let rateLimited = 0;
  for (let i = 0; i < take.length; i++) {
    const c = take[i];
    const details = await fetchDetails(c.place_id);
    await sleep(400);
    if (!details.ok) {
      if (details.rateLimited) {
        // Quota is exhausted for now; every remaining candidate would hit
        // the same wall, and mislabeling them dead would drop real venues.
        rateLimited++;
        console.log('  RATE LIMITED after retries, stopping here. Re-run later; inserts are ON CONFLICT safe.');
        break;
      }
      // A 400 or 404 is a place id Google no longer honors (stale serve,
      // junk from an old client). Not an error worth a retry, not a venue.
      gone++;
      console.log(`  SKIP (Places ${details.status}) ${c.place_id}`);
      continue;
    }
    const p = details.place;
    const lat = p.location?.latitude;
    const lon = p.location?.longitude;
    if (!lat || !lon) { gone++; continue; }

    let cityKey = null;
    let best = Infinity;
    for (const [key, city] of Object.entries(PA_CITIES)) {
      const d = kmBetween(lat, lon, city.lat, city.lon);
      if (d < best) { best = d; cityKey = key; }
    }
    if (best > MAX_KM) {
      outOfArea++;
      console.log(`  SKIP (out of area, ${Math.round(best)}km) ${p.displayName?.text || c.place_id}`);
      continue;
    }
    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') {
      gone++;
      console.log(`  SKIP (${p.businessStatus}) ${p.displayName?.text || c.place_id}`);
      continue;
    }

    const category = categoryFor(p.types);
    const label = `${p.displayName?.text || '(unnamed)'} [${cityKey}/${category}] signal=${c.signal} (s${c.serves} v${c.votes} c${c.checkins})`;
    if (!commit) {
      console.log(`  WOULD ADD ${label}`);
      inserted++;
      continue;
    }
    await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, address, city, latitude, longitude, venue_category, google_types, price_level, rating, review_count, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (google_place_id) DO NOTHING`,
      [
        p.id || c.place_id,
        p.displayName?.text || '',
        p.formattedAddress || '',
        cityKey,
        lat,
        lon,
        category,
        p.types || [],
        priceLevelToNum(p.priceLevel),
        p.rating || null,
        p.userRatingCount || 0,
        PA_CITIES[cityKey].tz,
      ]
    );
    inserted++;
    console.log(`  ADDED ${label}`);
  }

  console.log(`\n[ML:Demand] ${commit ? 'Inserted' : 'Would insert'} ${inserted}. Skipped: ${outOfArea} out of area, ${gone} gone or unresolvable${rateLimited ? ', stopped early on rate limiting' : ''}.`);
  if (commit && inserted > 0) {
    console.log('[ML:Demand] Next: admit them through the collector, which prices the run first:');
    console.log('  node scripts/ml/collectWeekly.js --city=philly --skip-attempted');
    console.log('  node scripts/ml/collectWeekly.js --city=lehigh --skip-attempted');
  }
  return pool.end();
}

main().catch((err) => {
  console.error('[ML:Demand] Fatal:', err);
  pool.end();
  process.exitCode = 1;
});
