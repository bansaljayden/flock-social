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
//   node scripts/ml/collectWeekly.js --skip-attempted --created-after=<when --commit ran> --max-new=N
//
// The last line is printed, filled in, at the end of a --commit run. It admits
// exactly the rows this run staged: a --city/--limit run orders by id and would
// spend the month's admissions on the oldest never-attempted venues instead.
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
//
// A demanded venue that harvestVenueFilter.js already added is present but
// inactive, so it is neither staged here nor refreshed by either collector.
// Every run lists those separately as PROMOTION CANDIDATES (promotionReport);
// promoting one is a hand-made UPDATE that puts it in the hourly live sweep.
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

// The market rule, in one place: the nearest PA centroid, or no city at all
// when the point is more than MAX_KM from both. harvestVenueFilter.js assigns
// its venues with this same function, so the two ways a venue enters the
// corpus cannot disagree about where philly ends.
function nearestPaCity(lat, lon) {
  let cityKey = null;
  let best = Infinity;
  for (const [key, city] of Object.entries(PA_CITIES)) {
    const d = kmBetween(lat, lon, city.lat, city.lon);
    if (d < best) { best = d; cityKey = key; }
  }
  return { cityKey: best > MAX_KM ? null : cityKey, km: best };
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

// A place somebody goes OUT to. The demand list is every place a crowd score
// was served for, and served_predictions also holds searches that resolved to
// an auto shop, a property manager, an airline and a bare street address
// (dry run, 2026-09-25): each would have spent one of the month's 100
// admissions on a place nobody plans a night around, and most 404 anyway. So
// a candidate needs a food, drink or going-out type of its own, and a
// business type that is only ever an office, a garage, an airport or a farm
// is refused unless it is also a restaurant or a bar.
const GOING_OUT_EXTRA = new Set([
  'food', 'meal_takeaway', 'meal_delivery', 'tea_house', 'juice_shop',
  'bar_and_grill', 'beer_garden', 'beer_hall', 'brewpub', 'gastropub', 'lounge', 'taproom', 'winery', 'distillery',
  'karaoke', 'comedy_club', 'dance_club', 'dance_hall', 'live_music_venue', 'concert_hall', 'event_venue',
  'performing_arts_theater', 'opera_house', 'philharmonic_hall', 'amphitheatre', 'video_arcade', 'stadium', 'arena',
]);
const NOT_A_NIGHT_OUT = new Set(['car_repair', 'car_dealer', 'car_wash', 'car_rental', 'gas_station', 'airport', 'airline', 'real_estate_agency', 'insurance_agency', 'accounting', 'lawyer', 'finance', 'bank', 'corporate_office', 'general_contractor', 'farm', 'storage', 'moving_company', 'hospital', 'doctor', 'dentist']);
// Every *_bar and *_pub type (wine_bar, cocktail_bar, sports_bar, hookah_bar,
// irish_pub, ...) is a drink, the same way every *_restaurant is a meal.
const isDrinkOrMeal = (t) => t === 'restaurant' || t === 'bar' || t === 'pub'
  || t.endsWith('_restaurant') || t.endsWith('_bar') || t.endsWith('_pub');
function isGoingOutPlace(types) {
  const list = types || [];
  const hospitality = list.some((t) => GOING_OUT_EXTRA.has(t)
    || isDrinkOrMeal(t)
    || TYPE_TO_CATEGORY.some(([gType]) => gType === t));
  if (!hospitality) return false;
  return list.some(isDrinkOrMeal) || !list.some((t) => NOT_A_NIGHT_OUT.has(t));
}

// Every demand signal, weighted by how much intent it carries: a check-in
// is a person standing in the room, a vote is a plan considering it, a
// serve is a card somebody looked at.
const DEMAND_CTE = `
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
    )`;

// Demanded places with no ml_venues row at all: the ones this script stages.
const MISSING_DEMAND_SQL = `${DEMAND_CTE}
    SELECT r.*
      FROM rolled r
      LEFT JOIN ml_venues v ON v.google_place_id = r.place_id
     WHERE v.id IS NULL
     ORDER BY r.signal DESC, r.place_id`;

// Demanded places whose only row is one harvestVenueFilter.js added: present,
// so the query above rightly skips them, but inactive, so neither collector
// ever reaches them, and a demanded venue would sit there unrefreshed with
// nothing saying so. They are listed as promotion candidates instead. The
// status literal is harvestVenueFilter.HARVEST_STATUS; it is not required from
// there because that module loads the vendor client this script must never
// load, and __tests__/harvestedIsolation.test.js pins the two equal.
const HARVESTED_STATUS = 'harvested';
const HARVESTED_DEMAND_SQL = `${DEMAND_CTE}
    SELECT r.*, v.id AS venue_row_id, v.name, v.city, v.venue_category
      FROM rolled r
      JOIN ml_venues v ON v.google_place_id = r.place_id
     WHERE v.besttime_status = '${HARVESTED_STATUS}'
       AND v.is_active = false
     ORDER BY r.signal DESC, r.place_id`;

// The printed half of the promotion list. Nothing here writes: promotion is an
// UPDATE the operator makes on purpose, because of what it starts.
function promotionReport(rows) {
  if (rows.length === 0) {
    return ['[ML:Demand] No demanded venue is held only as an inactive harvested row.'];
  }
  const lines = [
    `[ML:Demand] ${rows.length} demanded venues are in ml_venues only as inactive harvested rows. They are PROMOTION `
      + 'CANDIDATES, listed apart from the list below; this script neither stages nor changes them.',
  ];
  for (const r of rows) {
    lines.push(`  PROMOTE? ml_venues.id=${r.venue_row_id} ${r.name || '(unnamed)'} [${r.city}/${r.venue_category}] `
      + `signal=${r.signal} (s${r.serves} v${r.votes} c${r.checkins})`);
  }
  lines.push('[ML:Demand] Promoting one (UPDATE ml_venues SET is_active = true WHERE id IN (...)) PUTS IT IN THE HOURLY '
    + 'LIVE SWEEP: collectRealtime.js then calls it every hour against the sweep\'s 2,500-credit ceiling, and whether a '
    + 'live call on a venue another account first forecast spends one of the month\'s 100 admissions is not documented. '
    + 'Promote a few on purpose, never the whole list.');
  return lines;
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
  // Ten minutes early, so a database clock a little behind this machine's
  // cannot leave the first staged rows outside the admission command below.
  const stagedSince = new Date(Date.now() - 10 * 60 * 1000);
  const maxNewArg = process.argv.find((a) => a.startsWith('--max-new='));
  const maxNew = maxNewArg ? parseInt(maxNewArg.split('=')[1], 10) : 95;
  if (!Number.isInteger(maxNew) || maxNew <= 0) {
    console.error('[ML:Demand] --max-new must be a positive integer.');
    process.exitCode = 1;
    return pool.end();
  }
  // Two ceilings, deliberately separate (code review, 2026-09-01): maxNew
  // counts VENUES ACTUALLY STAGED, so a skipped candidate (out of area,
  // permanently closed, dead place id) cannot eat an admission slot and
  // permanently shadow the valid venue ranked below it. maxProbe bounds the
  // Places Details spend the walk itself costs.
  const maxProbeArg = process.argv.find((a) => a.startsWith('--max-probe='));
  const maxProbe = maxProbeArg ? parseInt(maxProbeArg.split('=')[1], 10) : maxNew * 3;
  if (!Number.isInteger(maxProbe) || maxProbe <= 0) {
    console.error('[ML:Demand] --max-probe must be a positive integer.');
    process.exitCode = 1;
    return pool.end();
  }

  const { rows: candidates } = await pool.query(MISSING_DEMAND_SQL);
  console.log(`[ML:Demand] ${candidates.length} distinct demanded venues are missing from ml_venues.`);

  // Listed before anything else can return: a harvested row real users asked
  // about is the demand list's business even on a day nothing is missing.
  const { rows: promotable } = await pool.query(HARVESTED_DEMAND_SQL);
  for (const line of promotionReport(promotable)) console.log(line);

  if (candidates.length === 0) return pool.end();
  console.log(`[ML:Demand] Walking by signal until ${maxNew} are staged or ${maxProbe} probed (the Package tier admits 100 new venues a month; --max-new= and --max-probe= raise on purpose).`);

  let inserted = 0;
  let outOfArea = 0;
  let gone = 0;
  let notVenue = 0;
  let rateLimited = 0;
  let probed = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (inserted >= maxNew) break;
    if (probed >= maxProbe) {
      console.log(`  PROBE CEILING reached (${maxProbe}); ${inserted} staged. Raise --max-probe to walk further.`);
      break;
    }
    probed++;
    const c = candidates[i];
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

    const nearest = nearestPaCity(lat, lon);
    if (!nearest.cityKey) {
      outOfArea++;
      console.log(`  SKIP (out of area, ${Math.round(nearest.km)}km) ${p.displayName?.text || c.place_id}`);
      continue;
    }
    const cityKey = nearest.cityKey;
    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') {
      gone++;
      console.log(`  SKIP (${p.businessStatus}) ${p.displayName?.text || c.place_id}`);
      continue;
    }

    if (!isGoingOutPlace(p.types)) {
      notVenue++;
      console.log(`  SKIP (not a going-out place: ${(p.types || []).slice(0, 4).join(', ') || 'no types'}) ${p.displayName?.text || c.place_id}`);
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

  console.log(`\n[ML:Demand] ${commit ? 'Inserted' : 'Would insert'} ${inserted}. Skipped: ${outOfArea} out of area, ${gone} gone or unresolvable, ${notVenue} not a going-out place${rateLimited ? ', stopped early on rate limiting' : ''} (${probed} probed).`);
  if (commit && inserted > 0) {
    console.log('[ML:Demand] Next: admit exactly these through the collector, which prices the run first:');
    console.log(`  node scripts/ml/collectWeekly.js --skip-attempted --created-after=${stagedSince.toISOString()} --max-new=${inserted}`);
  }
  return pool.end();
}

module.exports = {
  PA_CITIES, MAX_KM, kmBetween, nearestPaCity,
  MISSING_DEMAND_SQL, HARVESTED_DEMAND_SQL, HARVESTED_STATUS, promotionReport,
};

// Only when run directly. The market rule above is required by
// harvestVenueFilter.js, and a require must not start a Places walk against
// whatever database the environment names.
if (require.main === module) {
  main().catch((err) => {
    console.error('[ML:Demand] Fatal:', err);
    pool.end();
    process.exitCode = 1;
  });
}
