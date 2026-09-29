// ---------------------------------------------------------------------------
// HARVEST WEEKLY CURVES FROM BESTTIME'S VENUE FILTER, ADMITTING NO VENUE
// ---------------------------------------------------------------------------
// Run (from backend/):
//   node scripts/ml/harvestVenueFilter.js --city=philly            dry run
//   node scripts/ml/harvestVenueFilter.js --city=philly --commit   writes, once the dry run's axis proof passes
// One market at a time; --radius-km (default 20) sets how far it reaches.
//
// WHY THIS EXISTS. The plan (Pro Package 100) meters exactly one thing: 100
// NEW venue admissions a calendar month. Forecasts by id, live calls, query
// calls and venue-filter calls on the package are unlimited. The Venue Filter
// (GET /api/v1/venues/filter) answers with every venue BestTime holds a
// forecast for inside a box, WITH that venue's 24-slot curve for the day asked,
// and it bills query credits (one per ten venues returned), not admissions.
// Measured 2026-09-28: 50 central-Philadelphia venues with full-day curves for
// "credits_charged: 5". So seven filter passes over a market, one per weekday,
// are a full typical week for every venue BestTime knows there, and none of
// them spends one of the hundred.
//
// WHAT IT NEVER CALLS. No forecast by name or address (POST /forecasts), no
// venue search (/venues/search), no live call and no live refresh. Those are
// the endpoints that admit a venue, or might: whether a live call by id on a
// venue some OTHER account first forecast counts as a new venue for this
// account is not documented. This is enforced, not promised: every request this
// process makes during a run goes through assertAllowedRequest, which admits
// exactly two requests (GET /venues/filter without live parameters, GET
// /keys/<key>) and throws on anything else before a byte leaves.
// __tests__/harvestVenueFilter.test.js pins it.
//
// WHAT IT WRITES.
//   ml_training_data  weekly rows, one per (venue, venue-local day, hour),
//                     through collectWeekly's bestTimeSlotToLocal and its axis
//                     declaration, upserted on migration 024's weekly key. A
//                     re-run refreshes the same rows in place.
//   ml_venues         a NEW row only for a venue that is in neither
//                     besttime_venue_id nor google_place_id already AND carries
//                     a real Google place id. See "IDENTITY" below.
//
// PROVENANCE: the rows are labelled exactly as collectWeekly labels its rows,
// because they are the same thing. The filter returns BestTime's stored
// typical-week forecast, the object a POST /forecasts by id creates, so these
// are vendor FORECASTS and never observations. The corpus names that by
// collection_mode = 'weekly' and hour_axis = 'venue_local', and leaves
// label_source NULL: migration 025's CHECK admits only 'live' and 'forecast'
// there and its column comment reserves both for realtime rows, while the
// export (train/export_training_data.js labelProvenance) calls every
// non-realtime row 'weekly' whatever the column says. A distinct label for
// "weekly, via the filter" would need a new column or a widened CHECK, and it
// would carry no information the weight ladder uses: prepare_features.py
// weights every weekly row alike. What does differ is recorded honestly where
// it can be: a NEW row's besttime_epoch is NULL, because the filter does not
// say which analysis produced the curve (discoverBestTime.js writes NULL for
// the same reason), and a known row keeps the epoch it already stores rather
// than having it blanked (see WEEKLY_UPSERT_CONFLICT); events_observed is false
// with 'no_observation_date', migration 045's vocabulary for a typical week.
//
// THE AXIS IS PROVED BEFORE ANYTHING IS WRITTEN. The slot transform assumes
// slot 0 of the filter's curve is 6 AM, as it is in a forecast's day_raw. If it
// were midnight, every row this writes would sit six hours off the venue
// clock, which is migration 023's defect over again. So every run compares the
// curves it would write for the venues this corpus already holds by BestTime
// id against the weekly rows stored for them (collectWeekly wrote those, from
// forecasts, through the same transform), at every rotation of the 168-hour
// week, and prints which rotation agrees best. A --commit refuses unless the
// best rotation is 0 and the agreement at 0 clears AXIS_* below; a dry run that
// would be refused exits nonzero. Each run also prints each category's peak
// hour on the venue clock, the plain-language form of the same check (bars
// peak late in the evening, never at dawn). See readFilterVenue for which
// field the curve is read from and why.
//
// IDENTITY, in the order it is decided:
//   1. besttime_venue_id already held by a row: that row, refreshed.
//   2. else a real Google place id already held by a row with no BestTime id:
//      that row, refreshed. The BestTime id is NOT stamped onto it. Stamping
//      puts an active row into the hourly live sweep, and whether a live call
//      on a venue first forecast by another account spends an admission is
//      exactly the undocumented question above. The rerun maps it by place id
//      again, so nothing is lost by waiting.
//   3. else a real Google place id held by a row under a DIFFERENT BestTime id:
//      skipped. Two BestTime venues for one Google place is the pair the repair
//      script exists for; filing one venue's curve under the other's row is the
//      defect discoverBestTime.js's header describes.
//   4. else an existing row within NEAR_DUP_METERS with a similar name (the
//      same building under a place id Google has since reissued, or one the
//      corpus took from another listing): that row, refreshed exactly as in 2,
//      or skipped as in 3 when it holds another BestTime id. A second identity
//      for one venue splits its curves and counts it as its own neighbour.
//   5. else, with a real Google place id, within --radius-km of its market's
//      centroid: a NEW row. Never with a `bt_` pseudo id; that minted identity
//      is the first defect in discoverBestTime.js's header. With no place id
//      the venue is skipped, and the summary says how many were. Two new
//      venues within NEAR_DUP_METERS of each other with similar names are one
//      venue: the lower BestTime id is kept.
// Every venue is also placed by nearestPaCity, addDemandVenues' own rule: the
// nearest PA centroid within MAX_KM, or outside both markets and skipped.
//
// NEW ROWS ARE INACTIVE, ON PURPOSE. collectRealtime.js sweeps every active PA
// row with a BestTime id, hourly, and REFUSES (throws, every hour) once that
// scope passes its 2,500 credit ceiling; the scope is about 1,400 today. A
// harvest can find thousands of venues, so a new row is written is_active =
// false with besttime_status = 'harvested', which keeps it out of both the
// hourly sweep and collectWeekly's refresh. buildBaselines reads every row, so
// a harvested venue gets a served baseline and scores for its own hours. It
// does NOT move anybody else's score: services/mlPredictor.js leaves harvested
// rows out of the neighbour box (log_neighbor_count and
// neighbor_baseline_same_hour are inputs of the shipped model), and
// train/export_training_data.js leaves them out of the CSV unless
// --include-harvested is passed, so training and serving agree until a
// retrain measures them. addDemandVenues.js lists the harvested rows real
// users asked about as promotion candidates; promoting one into the live
// sweep is a separate, deliberate UPDATE, made with that ceiling in view.
//
// google_types is NULL on a new row, not BestTime's type: the column feeds the
// gtype_* model features and means "what Google said", and nobody asked Google.
// price_level is NULL because BestTime's scale (1 to 5) is not the corpus's
// (Google's 0 to 4). rating and review_count are BestTime's copy of Google's
// numbers, written when present and NULL when BestTime reports 0, which it uses
// for "not available" (migration 060 explains why a stored 0 is a lie).
//
// TYPES. The request asks only for BestTime types that map onto the model's
// thirteen categories (TYPE_TO_CATEGORY). discoverBestTime.mapCategory files
// anything it does not recognise as 'restaurant', which is how a supermarket or
// a dentist would join the restaurant curves; here an unmapped type is not
// requested at all. --all-types drops the filter so every known venue of any
// type is refreshed, and a NEW venue of an unmapped type is still skipped.
//
// TILING. The account caps one query at 500 results. Each market (a
// --radius-km circle around its centroid, 20 km by default: the circle
// discoverVenues.js searches, so the corpus's own footprint; 80, MAX_KM, asks
// for everything the market rule would accept) is covered with boxes, each box is paged
// (--page-size, default 100) until a short page, and a box that reaches the cap
// is split in four and its quarters asked instead, down to 0.002 degrees. The
// leaves found on the first day are reused for the rest of the week. Venues are
// de-duplicated by BestTime id, so a venue on a shared edge is counted once. A
// box's corner reaches past the circle: a venue found there that the corpus
// already holds is refreshed, and a new one is skipped (outsideRadius).
//
// PACING. The Venue Filter is documented at 30 requests a minute; this starts
// one every four seconds, half that, for the reason collectWeekly's pacing
// comment gives. 429 and 5xx wait and retry; 401/402/403 end the run at once.
//
// EXIT CODE. Nonzero on any abort, on a --commit that wrote no row or failed a
// write, and on a dry run that found nothing to write. An empty run is a
// failure to report, never a success (collectRealtime's lesson).
//
// BESTTIME DELETES A STORED FORECAST AFTER 31 DAYS, and the filter only returns
// venues whose forecast still exists. Run this at least monthly; see RETRAIN.md,
// "Venue Filter harvest".
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { bestTimeDayToJsDay, sleep: realSleep, withCorpusWriteLock } = require('./config');
// IMPORTED, NEVER REIMPLEMENTED: the slot -> (venue-local day, hour) transform
// and the axis literal live in collectWeekly.js, pinned against migration 023's
// SQL by __tests__/mlClockAxisBackfill.test.js.
const {
  bestTimeSlotToLocal, venueCalendar, requireSlotIndex,
  HOUR_AXIS_VENUE_LOCAL, WEEKLY_SLOT_INDEX,
} = require('./collectWeekly');
const { requireVenueIdIndex } = require('./discoverBestTime');
const { PA_CITIES, MAX_KM, kmBetween, nearestPaCity } = require('./addDemandVenues');
const { classifyHttpFailure, fetchJsonWithTimeout, NETWORK_ERR_RE } = require('./bestTimeService');
const { labelFor, describeError, describeDbError } = require('./logSafe');
const besttime = require('../../services/besttimeAccount');

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const TAG = '[ML:Harvest]';
const FILTER_URL = 'https://besttime.app/api/v1/venues/filter';
const FILTER_PATH = '/api/v1/venues/filter';
const KEY_PATH_PREFIX = '/api/v1/keys/';

// Parameters that would turn a filter call into something that refreshes live
// data (live refresh calls the live API on every matching venue, other
// accounts' venues included) or that belong to the admitting forecast call.
const FORBIDDEN_FILTER_PARAMS = ['live', 'live_refresh', 'live_limit', 'now', 'venue_name', 'venue_address'];

const BT_DAYS = [0, 1, 2, 3, 4, 5, 6]; // BestTime's Monday = 0 .. Sunday = 6
const BT_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DEFAULT_RESULT_CAP = 500;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TILE_KM = 20;
const DEFAULT_MAX_REQUESTS = 4000;
// Coordinates are sent with three decimals, the most the filter accepts, so
// tiles live on a grid of thousandths of a degree and their edges are exact.
const MIN_TILE_SPAN = 2; // thousandths of a degree, about 200 m
const START_INTERVAL_MS = 4000;
const REQUEST_TIMEOUT_MS = 60000;
const RETRY_WAITS_MS = [5000, 30000, 60000, 120000];
const THROTTLE_WAIT_MS = 60000;
// services/mlPredictor.js HARVESTED_STATUS and export_training_data.js
// HARVESTED_STATUS name the same value; __tests__/harvestedIsolation.test.js
// pins the three together.
const HARVEST_STATUS = 'harvested';
const KM_PER_DEG_LAT = 111.32;

// The circle discoverVenues.js searches (locationBias radius 20,000 m), so the
// corpus's own footprint. MAX_KM, the market rule's 80, stays available on
// purpose with --radius-km=80.
const DEFAULT_RADIUS_KM = 20;

// Two listings of one venue: closer than this, with names that normalise to
// nearly the same string. 40 m is inside one building's frontage on a city
// block; two different venues that close with the same name are not a case
// the corpus can tell apart anyway.
const NEAR_DUP_METERS = 40;

// The axis proof (see the header). A venue counts toward it when it has at
// least AXIS_MIN_OVERLAP cells both here and in its stored weekly rows and its
// stored curve is not flat (a flat curve agrees with every rotation). A
// --commit needs AXIS_MIN_VENUES such venues, the best pooled rotation at 0,
// and at rotation 0: pooled cells within five points at least AXIS_MIN_WITHIN5,
// and venues whose own best rotation is 0 at least AXIS_MIN_VENUE_SHARE.
// Measured on the first dry run (philly, Monday, 216 venues): 99.7% within
// five and 87.5% of venues at rotation 0, the rest tied between 0 and a whole
// day (a venue whose Monday is its Tuesday matches both, and a tie counts for
// neither). A six-hour error measured 42% within five; a whole-day one 75%, which
// the best-rotation rule refuses on its own. So the floors sit well under an
// honest run and well over any wrong one.
const AXIS_MIN_OVERLAP = 24;
const AXIS_MIN_VENUES = 20;
const AXIS_MIN_WITHIN5 = 0.9;
const AXIS_MIN_VENUE_SHARE = 0.75;
// The rotations printed, in hours on the 168-hour week. Six is the origin
// error the proof exists for, 24 a weekday mislabelled by one.
const AXIS_SHOWN_SHIFTS = [0, 1, -1, 2, -2, 3, -3, 6, -6, 12, -12, 24, -24];
const WEEK_HOURS = 168;

// BestTime broad venue types -> the model's thirteen categories. Only these
// are requested (see TYPES above). A burger place is fast food because
// addDemandVenues maps Google's hamburger_restaurant that way; a type with no
// honest category (supermarket, stadium, winery, a beer shop) is absent.
const RESTAURANT_TYPES = [
  'RESTAURANT', 'FOOD_AND_DRINK', 'AMERICAN_RESTAURANT', 'ASIAN_RESTAURANT', 'BBQ_RESTAURANT',
  'BREAKFAST_RESTAURANT', 'CHICKEN_RESTAURANT', 'CHINESE_RESTAURANT', 'FRENCH_RESTAURANT',
  'INDIAN_RESTAURANT', 'ITALIAN_RESTAURANT', 'JAPANESE_RESTAURANT', 'MEDITERANEAN_RESTAURANT',
  'MEXICAN_RESTAURANT', 'PIZZA_RESTAURANT', 'RAMEN_RESTAURANT', 'SANDWICH_RESTAURANT',
  'SEAFOOD_RESTAURANT', 'STEAK_RESTAURANT', 'SUSHI_RESTAURANT', 'THAI_RESTAURANT',
  'VEGETERIAN_RESTAURANT', // sic: BestTime's spelling, as its catalog lists it
];
const TYPE_TO_CATEGORY = Object.freeze({
  ...Object.fromEntries(RESTAURANT_TYPES.map((t) => [t, 'restaurant'])),
  FAST_FOOD: 'fast_food',
  BURGER_RESTAURANT: 'fast_food',
  BAR: 'bar',
  CLUBS: 'nightclub',
  BREWERY: 'brewery',
  CAFE: 'cafe',
  COFFEE: 'cafe',
  TEA: 'cafe',
  BAKERY: 'dessert',
  DESSERT: 'dessert',
  FITNESS: 'gym',
  SHOPPING_CENTER: 'mall',
  MUSEUM: 'museum',
  MOVIE_THEATER: 'movie_theater',
  MOVIES: 'movie_theater',
  PARK: 'park',
  AMUSEMENT_PARK: 'entertainment',
  CASINO: 'entertainment',
});

// ---------------------------------------------------------------------------
// The request guard.
// ---------------------------------------------------------------------------
function refusal(message) {
  const err = new Error(message);
  err.admissionRefused = true;
  err.abort = true;
  return err;
}

// Throws unless (url, method) is one of the two requests this script may make.
function assertAllowedRequest(url, method) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw refusal('REFUSED: a request to an unparseable URL.');
  }
  const verb = String(method || 'GET').toUpperCase();
  if (u.protocol !== 'https:' || u.hostname !== 'besttime.app') {
    throw refusal(`REFUSED: this harvest makes no request outside besttime.app (${u.hostname}).`);
  }
  if (verb !== 'GET') {
    throw refusal(`REFUSED: ${verb} ${u.pathname}. Every BestTime call that can admit a venue is a POST; this harvest only reads.`);
  }
  if (u.pathname === FILTER_PATH) {
    for (const p of FORBIDDEN_FILTER_PARAMS) {
      if (u.searchParams.has(p)) throw refusal(`REFUSED: the venue filter with "${p}", which calls or refreshes live data.`);
    }
    return;
  }
  if (u.pathname.startsWith(KEY_PATH_PREFIX) && u.pathname.length > KEY_PATH_PREFIX.length) return;
  throw refusal(`REFUSED: GET ${u.pathname}. This harvest calls the venue filter and the key status endpoint, nothing else.`);
}

// Every fetch made while fn runs goes through the guard, including any a
// helper makes on the harvest's behalf. Restored afterwards.
async function withAdmissionGuard(fn) {
  const inner = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
    const method = init.method || (input && typeof input === 'object' && input.method) || 'GET';
    try {
      assertAllowedRequest(url, method);
    } catch (err) {
      return Promise.reject(err);
    }
    return inner(input, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = inner;
  }
}

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------
function intArg(argv, name, fallback, { min = 1, max = Infinity } = {}) {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return { value: fallback };
  const raw = arg.slice(name.length + 3);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    return { error: `--${name} must be an integer from ${min} to ${max === Infinity ? 'up' : max}, got "${raw}".` };
  }
  return { value: Number(raw) };
}

function parseArgs(argv) {
  const known = ['--commit', '--all-types', '--no-place-id'];
  const valued = ['--city=', '--days=', '--tile-km=', '--page-size=', '--result-cap=', '--max-requests=', '--radius-km='];
  for (const a of argv.slice(2)) {
    if (!known.includes(a) && !valued.some((p) => a.startsWith(p))) {
      return { error: `Unknown argument "${a}".` };
    }
  }
  const cityArg = argv.find((a) => a.startsWith('--city='));
  const cities = cityArg
    ? [...new Set(cityArg.slice('--city='.length).split(',').map((s) => s.trim()).filter(Boolean))]
    : Object.keys(PA_CITIES);
  const unknownCity = cities.find((c) => !PA_CITIES[c]);
  if (cities.length === 0 || unknownCity) {
    return { error: `--city must name ${Object.keys(PA_CITIES).join(' and/or ')}${unknownCity ? `, got "${unknownCity}"` : ''}.` };
  }
  const daysArg = argv.find((a) => a.startsWith('--days='));
  let days = BT_DAYS;
  if (daysArg) {
    const parts = daysArg.slice('--days='.length).split(',').map((s) => s.trim());
    if (parts.length === 0 || parts.some((p) => !/^[0-6]$/.test(p))) {
      return { error: '--days takes BestTime day numbers, 0 (Monday) to 6 (Sunday), comma separated.' };
    }
    days = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  }
  const tileKm = intArg(argv, 'tile-km', DEFAULT_TILE_KM, { min: 1, max: 160 });
  const resultCap = intArg(argv, 'result-cap', DEFAULT_RESULT_CAP, { min: 2, max: 10000 });
  const pageSize = intArg(argv, 'page-size', DEFAULT_PAGE_SIZE, { min: 1, max: 10000 });
  const maxRequests = intArg(argv, 'max-requests', DEFAULT_MAX_REQUESTS, { min: 1 });
  // Past MAX_KM the market rule places nothing, so a wider circle only spends
  // requests on venues that are skipped.
  const radiusKm = intArg(argv, 'radius-km', DEFAULT_RADIUS_KM, { min: 1, max: MAX_KM });
  for (const r of [tileKm, resultCap, pageSize, maxRequests, radiusKm]) if (r.error) return { error: r.error };
  if (pageSize.value > resultCap.value) {
    return { error: `--page-size (${pageSize.value}) cannot exceed --result-cap (${resultCap.value}).` };
  }
  return {
    commit: argv.includes('--commit'),
    allTypes: argv.includes('--all-types'),
    askPlaceId: !argv.includes('--no-place-id'),
    cities,
    days,
    tileKm: tileKm.value,
    radiusKm: radiusKm.value,
    resultCap: resultCap.value,
    pageSize: pageSize.value,
    maxRequests: maxRequests.value,
  };
}

// ---------------------------------------------------------------------------
// Tiles. A tile is { s, w, n, e } in integer thousandths of a degree.
// ---------------------------------------------------------------------------
const kmPerDegLng = (lat) => KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// True when any point of the box is within radiusKm of a centroid of `cities`.
function tileIntersects(tile, cities, radiusKm = DEFAULT_RADIUS_KM) {
  return cities.some((key) => {
    const c = PA_CITIES[key];
    const lat = Math.min(Math.max(c.lat, tile.s / 1000), tile.n / 1000);
    const lon = Math.min(Math.max(c.lon, tile.w / 1000), tile.e / 1000);
    return kmBetween(c.lat, c.lon, lat, lon) <= radiusKm;
  });
}

function buildTiles(cities, tileKm, radiusKm = DEFAULT_RADIUS_KM) {
  let s = Infinity; let n = -Infinity; let w = Infinity; let e = -Infinity;
  for (const key of cities) {
    const c = PA_CITIES[key];
    const dLat = radiusKm / KM_PER_DEG_LAT;
    const dLng = radiusKm / kmPerDegLng(c.lat);
    s = Math.min(s, Math.floor((c.lat - dLat) * 1000));
    n = Math.max(n, Math.ceil((c.lat + dLat) * 1000));
    w = Math.min(w, Math.floor((c.lon - dLng) * 1000));
    e = Math.max(e, Math.ceil((c.lon + dLng) * 1000));
  }
  const midLat = (s + n) / 2000;
  const latStep = Math.max(MIN_TILE_SPAN, Math.round((tileKm / KM_PER_DEG_LAT) * 1000));
  const lngStep = Math.max(MIN_TILE_SPAN, Math.round((tileKm / kmPerDegLng(midLat)) * 1000));
  const tiles = [];
  for (let ts = s; ts < n; ts += latStep) {
    for (let tw = w; tw < e; tw += lngStep) {
      const tile = { s: ts, w: tw, n: Math.min(ts + latStep, n), e: Math.min(tw + lngStep, e) };
      if (tileIntersects(tile, cities, radiusKm)) tiles.push(tile);
    }
  }
  return tiles;
}

// Four quarters (or two halves when one side is already at the minimum), or
// null when neither side can be halved again.
function splitTile(tile) {
  const canLat = tile.n - tile.s >= 2 * MIN_TILE_SPAN;
  const canLng = tile.e - tile.w >= 2 * MIN_TILE_SPAN;
  if (!canLat && !canLng) return null;
  const midLat = Math.floor((tile.s + tile.n) / 2);
  const midLng = Math.floor((tile.w + tile.e) / 2);
  const lats = canLat ? [[tile.s, midLat], [midLat, tile.n]] : [[tile.s, tile.n]];
  const lngs = canLng ? [[tile.w, midLng], [midLng, tile.e]] : [[tile.w, tile.e]];
  const out = [];
  for (const [ts, tn] of lats) for (const [tw, te] of lngs) out.push({ s: ts, w: tw, n: tn, e: te });
  return out;
}

const fmt = (t) => (t / 1000).toFixed(3);
const tileLabel = (t) => `${fmt(t.s)},${fmt(t.w)} to ${fmt(t.n)},${fmt(t.e)}`;

// ---------------------------------------------------------------------------
// One venue from a filter answer, read defensively.
// ---------------------------------------------------------------------------

// A Google place id, as opposed to nothing, a pseudo id this corpus once minted
// (`bt_...`), a BestTime venue id, or any other token of a plausible length.
// Google calls the id opaque, but the ids it publishes have a fixed head: the
// place ids on its Place IDs page all begin "ChIJ", and the id its geocoding
// documentation shows for a bare point begins "GhIJ". The "Ei..."/"Eh..." ids
// it shows for a street address are refused: an address is not a venue, and
// the app looks venues up by the establishment's own id, so a row filed under
// one could never be served. The first dry run prints the heads of every id
// refused here (unusablePlaceId), so a shape this misses shows up as a count.
const GOOGLE_PLACE_ID_RE = /^(?:ChIJ|GhIJ)[A-Za-z0-9_-]{16,251}$/;
function isRealGooglePlaceId(id) {
  return typeof id === 'string' && GOOGLE_PLACE_ID_RE.test(id);
}

// The filter's place-id field is not in BestTime's published response schema,
// so the likely spellings are all read, and whatever came is kept raw so the
// summary can report a present-but-unusable value separately from none at all.
const PLACE_ID_FIELDS = ['venue_place_id', 'place_id', 'google_place_id', 'venue_google_place_id'];

function readHours(raw) {
  if (!Array.isArray(raw) || raw.length !== 24) return null;
  return raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null));
}

function readFilterVenue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const venueId = typeof raw.venue_id === 'string' && raw.venue_id.trim() ? raw.venue_id.trim() : null;
  if (!venueId) return null;
  const rawPlaceId = PLACE_ID_FIELDS.map((f) => raw[f]).find((v) => typeof v === 'string' && v.trim()) || null;
  const dayInt = Number.isInteger(raw.day_int) ? raw.day_int
    : (raw.day_info && Number.isInteger(raw.day_info.day_int) ? raw.day_info.day_int : null);
  const rating = Number(raw.rating);
  const reviews = Number(raw.reviews);
  return {
    venueId,
    name: typeof raw.venue_name === 'string' ? raw.venue_name : '',
    address: typeof raw.venue_address === 'string' ? raw.venue_address : '',
    lat: Number(raw.venue_lat),
    lng: Number(raw.venue_lng ?? raw.venue_lon),
    type: typeof raw.venue_type === 'string' ? raw.venue_type.toUpperCase() : null,
    dayInt,
    // THE CURVE IS day_raw_whole, AND ITS INDEX 0 IS 6 AM. Settled by the axis
    // proof on the first dry run (philly, Monday, 2026-09-28): the filter
    // answered day_raw_whole on all 3,933 venue-days and day_raw on none, and
    // for the 216 venues this corpus holds by BestTime id, day_raw_whole
    // through collectWeekly's 6 AM transform matched the weekly rows stored
    // from their forecasts exactly on 99.6% of 5,184 cells at rotation 0 (MAE
    // 0.06, r 0.999), against 42% within five points at +/-6 and r 0.19. It is
    // the forecast's own day_raw, starting at 6 AM. day_raw is NOT read as a
    // fallback: no answer has carried it, so its origin was never proved, and
    // a curve the proof has not covered is not written. A venue-day without
    // day_raw_whole counts as malformed. day_raw is kept only to report how it
    // compares, should BestTime start sending it.
    hours: readHours(raw.day_raw_whole),
    curveField: readHours(raw.day_raw_whole) ? 'day_raw_whole' : null,
    hoursAlt: readHours(raw.day_raw_whole) ? readHours(raw.day_raw) : null,
    rawPlaceId: rawPlaceId ? rawPlaceId.trim() : null,
    placeId: rawPlaceId && isRealGooglePlaceId(rawPlaceId.trim()) ? rawPlaceId.trim() : null,
    rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? rating : null,
    reviews: Number.isInteger(reviews) && reviews > 0 ? reviews : null,
  };
}

// (BestTime day, 24 slots) for each day -> [{ dayOfWeek, hour, busyness }],
// venue-local, first occurrence of a cell kept. Same loop as collectWeekly's.
function weekCells(days) {
  const cells = [];
  const seen = new Set();
  for (const [btDay, hours] of days) {
    const jsDayOfWeek = bestTimeDayToJsDay(btDay);
    for (let slot = 0; slot < hours.length && slot < 24; slot++) {
      const busyness = hours[slot];
      if (busyness == null) continue;
      const local = bestTimeSlotToLocal(slot, jsDayOfWeek);
      const cell = `${local.dayOfWeek}:${local.hour}`;
      if (seen.has(cell)) continue;
      seen.add(cell);
      cells.push({ dayOfWeek: local.dayOfWeek, hour: local.hour, busyness: Math.max(0, Math.min(100, busyness)) });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// The axis proof and the peak-hour histogram (see the header).
// ---------------------------------------------------------------------------

// Cells -> a 168-slot week indexed day_of_week * 24 + hour, -1 where absent.
function weekCurve(cells) {
  const curve = new Int16Array(WEEK_HOURS).fill(-1);
  for (const c of cells) curve[c.dayOfWeek * 24 + c.hour] = c.busyness;
  return curve;
}

// Rotation k (0..167) -> hours, signed, in -83..84.
const signedShift = (k) => (k > WEEK_HOURS / 2 ? k - WEEK_HOURS : k);

// pairs: [{ planned, stored }], both weekCurve()s. At rotation k the stored
// cell at slot i is compared with the planned cell at slot i + k, so a best
// rotation of +6 means the harvested curve sits six hours LATER on the venue
// clock than the stored one: the reading a midnight origin mapped as 6 AM
// would give.
function axisProof(pairs) {
  const pooled = Array.from({ length: WEEK_HOURS }, () => ({
    pairs: 0, abs: 0, exact: 0, within5: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0,
  }));
  const venueBest = new Array(WEEK_HOURS).fill(0);
  let venues = 0;
  let tied = 0;
  let thin = 0;
  let flat = 0;
  for (const { planned, stored } of pairs) {
    let overlap = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < WEEK_HOURS; i++) {
      if (stored[i] < 0) continue;
      lo = Math.min(lo, stored[i]);
      hi = Math.max(hi, stored[i]);
      if (planned[i] >= 0) overlap++;
    }
    if (overlap < AXIS_MIN_OVERLAP) { thin++; continue; }
    if (hi === lo) { flat++; continue; }
    venues++;
    let bestMae = Infinity;
    let bestAt = [];
    for (let k = 0; k < WEEK_HOURS; k++) {
      const p = pooled[k];
      let n = 0;
      let abs = 0;
      for (let i = 0; i < WEEK_HOURS; i++) {
        const y = stored[i];
        if (y < 0) continue;
        const x = planned[(i + k) % WEEK_HOURS];
        if (x < 0) continue;
        const d = Math.abs(x - y);
        n++;
        abs += d;
        p.pairs++;
        p.abs += d;
        if (d === 0) p.exact++;
        if (d <= 5) p.within5++;
        p.sx += x; p.sy += y; p.sxx += x * x; p.syy += y * y; p.sxy += x * y;
      }
      if (n === 0) continue;
      const mae = abs / n;
      if (mae < bestMae - 1e-9) { bestMae = mae; bestAt = [k]; } else if (Math.abs(mae - bestMae) <= 1e-9) bestAt.push(k);
    }
    // A venue whose minimum is shared by two rotations votes for neither.
    if (bestAt.length === 1) venueBest[bestAt[0]]++; else tied++;
  }
  const table = pooled.map((p, k) => {
    const cov = p.pairs * p.sxy - p.sx * p.sy;
    const den = Math.sqrt((p.pairs * p.sxx - p.sx * p.sx) * (p.pairs * p.syy - p.sy * p.sy));
    return {
      shift: signedShift(k),
      pairs: p.pairs,
      mae: p.pairs ? p.abs / p.pairs : null,
      exact: p.pairs ? p.exact / p.pairs : null,
      within5: p.pairs ? p.within5 / p.pairs : null,
      r: den > 0 ? cov / den : null,
      venuesBestHere: venueBest[k],
    };
  });
  let best = null;
  for (const row of table) if (row.mae !== null && (best === null || row.mae < best.mae)) best = row;
  return { venues, tied, thin, flat, table, bestShift: best ? best.shift : null };
}

// The --commit gate. Returns { pass, reason }.
function axisVerdict(proof) {
  const at0 = proof.table.find((r) => r.shift === 0);
  if (proof.venues < AXIS_MIN_VENUES) {
    return { pass: false, reason: `only ${proof.venues} known venues could be compared (at least ${AXIS_MIN_VENUES} are needed to prove the axis)` };
  }
  if (proof.bestShift !== 0) {
    return { pass: false, reason: `the curves agree best with the stored rows at a rotation of ${proof.bestShift > 0 ? '+' : ''}${proof.bestShift} hours, not 0` };
  }
  if (at0.within5 < AXIS_MIN_WITHIN5) {
    return { pass: false, reason: `at rotation 0 only ${pct(at0.within5)} of cells are within five points (at least ${pct(AXIS_MIN_WITHIN5)} needed)` };
  }
  const share = at0.venuesBestHere / proof.venues;
  if (share < AXIS_MIN_VENUE_SHARE) {
    return { pass: false, reason: `only ${pct(share)} of compared venues agree best at rotation 0 (at least ${pct(AXIS_MIN_VENUE_SHARE)} needed)` };
  }
  return {
    pass: true,
    reason: `best rotation 0; at 0, ${pct(at0.within5)} of cells within five points and ${pct(share)} of ${proof.venues} venues agree best`,
  };
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);

function formatAxisTable(proof) {
  const lines = ['  shift   pairs    MAE   exact  within5      r   venues best here'];
  const shown = new Set(AXIS_SHOWN_SHIFTS);
  if (proof.bestShift !== null) shown.add(proof.bestShift);
  const rows = proof.table.filter((r) => shown.has(r.shift))
    .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift) || b.shift - a.shift);
  for (const r of rows) {
    lines.push(`  ${(r.shift > 0 ? `+${r.shift}` : String(r.shift)).padStart(5)}  ${String(r.pairs).padStart(6)}  `
      + `${r.mae === null ? '   n/a' : r.mae.toFixed(2).padStart(5)}  ${pct(r.exact).padStart(6)}  ${pct(r.within5).padStart(7)}  `
      + `${r.r === null ? '   n/a' : r.r.toFixed(3).padStart(6)}  ${String(r.venuesBestHere).padStart(6)}`
      + `${r.shift === proof.bestShift ? '   <- best' : ''}`);
  }
  return lines;
}

// Category -> Int32Array(24): venues whose week-averaged busiest venue-local
// hour is that hour. A venue whose curve is zero everywhere has no peak.
function peakHourHistogram(plan) {
  const byCategory = new Map();
  for (const item of plan) {
    const category = item.category || (item.row && item.row.venue_category) || 'unknown';
    const sum = new Float64Array(24);
    const cnt = new Int32Array(24);
    for (const c of item.cells || []) { sum[c.hour] += c.busyness; cnt[c.hour]++; }
    let peak = -1;
    let peakValue = 0;
    for (let h = 0; h < 24; h++) {
      if (cnt[h] === 0) continue;
      const mean = sum[h] / cnt[h];
      if (mean > peakValue) { peakValue = mean; peak = h; }
    }
    if (peak < 0) continue;
    if (!byCategory.has(category)) byCategory.set(category, new Int32Array(24));
    byCategory.get(category)[peak]++;
  }
  return byCategory;
}

function formatPeakHistogram(byCategory) {
  const entries = [...byCategory.entries()]
    .map(([category, h]) => ({ category, h, n: h.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));
  const width = Math.max(3, ...entries.flatMap((e) => [...e.h].map((x) => String(x).length + 1)));
  const lines = [`  ${'category'.padEnd(14)}${'n'.padStart(6)}  mode `
    + Array.from({ length: 24 }, (_, h) => String(h).padStart(width)).join('')];
  for (const e of entries) {
    let mode = 0;
    for (let h = 1; h < 24; h++) if (e.h[h] > e.h[mode]) mode = h;
    lines.push(`  ${e.category.padEnd(14)}${String(e.n).padStart(6)}  ${String(mode).padStart(2, '0')}h  `
      + [...e.h].map((x) => String(x).padStart(width)).join(''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Near-duplicate names (identity rule 4).
// ---------------------------------------------------------------------------
// Words that tell two listings of one venue apart without telling two venues
// apart: articles, the company suffix, the city a listing appends.
const NAME_STOPWORDS = new Set(['the', 'and', 'of', 'at', 'a', 'an', 'llc', 'inc', 'co', 'philadelphia', 'philly', 'pa']);

function nameKey(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !NAME_STOPWORDS.has(t))
    .join('');
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return out;
}

// The same name, one name inside the other with at least half its length and
// five letters ("Olde Bar" and "The Olde Bar Philadelphia", "Starbucks" and
// "Starbucks Coffee"), or a character-bigram Dice score of 0.75 or more (a
// typo, a dropped word). "Cafe" and "Cafe Lift" are not similar: four letters
// is a word, not a name.
function namesSimilar(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 5 && short.length * 2 >= long.length && long.includes(short)) return true;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  for (const [g, n] of bx) shared += Math.min(n, by.get(g) || 0);
  const total = (x.length - 1) + (y.length - 1);
  return total > 0 && (2 * shared) / total >= 0.75;
}

// Rows by a ~110 m grid, so a lookup reads nine cells instead of the market.
function nearIndex(rows) {
  const grid = new Map();
  for (const r of rows) {
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = `${Math.floor(lat * 1000)}_${Math.floor(lng * 1000)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ row: r, lat, lng });
  }
  return (lat, lng) => {
    const out = [];
    const gx = Math.floor(lat * 1000);
    const gy = Math.floor(lng * 1000);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const c of grid.get(`${gx + dx}_${gy + dy}`) || []) {
          const m = kmBetween(lat, lng, c.lat, c.lng) * 1000;
          if (m <= NEAR_DUP_METERS) out.push({ row: c.row, meters: m });
        }
      }
    }
    return out.sort((p, q) => p.meters - q.meters);
  };
}

// ---------------------------------------------------------------------------
// The HTTP side.
// ---------------------------------------------------------------------------
function abortError(message) {
  const err = new Error(message);
  err.abort = true;
  return err;
}

function makePacer(sleep, intervalMs) {
  let last = -Infinity;
  return async () => {
    const wait = last + intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

function buildFilterUrl(key, q, opts) {
  const params = new URLSearchParams({
    api_key_private: key,
    lat_min: fmt(q.tile.s),
    lng_min: fmt(q.tile.w),
    lat_max: fmt(q.tile.n),
    lng_max: fmt(q.tile.e),
    day_int: String(q.day),
    foot_traffic: 'day',
    // BestTime's own generated filter links spell booleans True/False.
    own_venues_only: 'False',
    limit: String(opts.pageSize),
    page: String(q.page),
  });
  if (!opts.allTypes) params.set('types', Object.keys(TYPE_TO_CATEGORY).join(','));
  if (opts.askPlaceId) params.set('place_id', 'True');
  return `${FILTER_URL}?${params}`;
}

// One page. Retries what BestTime asks to be retried, throws an abort for
// everything else. Never prints the URL or a fetch error's message: the URL
// carries the private key.
async function requestPage(ctx, q) {
  const url = buildFilterUrl(ctx.key, q, ctx.opts);
  assertAllowedRequest(url, 'GET');
  for (let attempt = 0; ; attempt++) {
    if (ctx.stats.requests >= ctx.opts.maxRequests) {
      throw abortError(`REFUSED: the request ceiling (--max-requests=${ctx.opts.maxRequests}) was reached. `
        + 'Raise it on purpose, or narrow the run with --city= or --days=.');
    }
    await ctx.pace();
    ctx.stats.requests++;
    let response;
    let data;
    try {
      ({ response, data } = await fetchJsonWithTimeout(url, { method: 'GET' }, REQUEST_TIMEOUT_MS));
    } catch (err) {
      if (err && err.admissionRefused) throw err;
      const code = besttime.errorCode(err);
      if (!NETWORK_ERR_RE.test(String((err && err.message) || '')) && !(err instanceof SyntaxError)
        && !(err && err.notJson)) {
        throw abortError(`the venue filter request failed (${code}).`);
      }
      if (attempt >= RETRY_WAITS_MS.length) throw abortError(`the venue filter kept failing (${code}); stopping.`);
      console.warn(`  network error (${code}); retry ${attempt + 1}/${RETRY_WAITS_MS.length} in ${RETRY_WAITS_MS[attempt] / 1000}s`);
      await ctx.sleep(RETRY_WAITS_MS[attempt]);
      continue;
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 404) {
        // Documented as "resource not found". Counted, and treated as an empty
        // box; a run in which every request 404s finds nothing and exits
        // nonzero, which is how a wrong route would show.
        ctx.stats.notFound++;
        return { venues: [], total: 0, credits: null };
      }
      const err = classifyHttpFailure(status, 'venue filter');
      if (err && err.fatal) {
        throw abortError(`HTTP ${status} from the venue filter: the key or the account was refused. Nothing further can succeed.`);
      }
      if (err && err.transient) {
        if (attempt >= RETRY_WAITS_MS.length) throw abortError(`HTTP ${status} from the venue filter after ${attempt + 1} tries; BestTime is not letting us in.`);
        const wait = status === 429 || status === 503 ? THROTTLE_WAIT_MS : RETRY_WAITS_MS[attempt];
        console.warn(`  HTTP ${status}; retry ${attempt + 1}/${RETRY_WAITS_MS.length} in ${wait / 1000}s`);
        await ctx.sleep(wait);
        continue;
      }
      throw abortError(`HTTP ${status} from the venue filter: BestTime rejected the request parameters. `
        + 'The place_id flag and the types list are the two not yet confirmed against a live answer: '
        + '--no-place-id drops the first (refresh only, no new venues), --all-types the second.');
    }
    if (!data || typeof data !== 'object') throw abortError('the venue filter answered without a JSON object.');
    if (!Array.isArray(data.venues)) {
      const msg = typeof data.message === 'string' ? data.message : '';
      if (/no venues?|not found|none found/i.test(msg)) return { venues: [], total: 0, credits: null };
      // What the answer meant, never its text: status and message both came
      // back from BestTime and can echo the request, key included (logSafe.js).
      throw abortError(`the venue filter answered without a venue list (${labelFor(msg)}).`);
    }
    const total = Number.isInteger(data.venues_n) ? data.venues_n : null;
    const credits = typeof data.credits_charged === 'number' && Number.isFinite(data.credits_charged) ? data.credits_charged : null;
    return { venues: data.venues, total, credits };
  }
}

// Pages one box for one day, up to the cap.
async function fetchTile(ctx, tile, day) {
  const venues = [];
  let saturated = false;
  let pages = 0;
  for (let page = 0; ; page++) {
    const res = await requestPage(ctx, { tile, day, page });
    pages++;
    const n = res.venues.length;
    ctx.stats.venuesReturned += n;
    if (res.credits !== null) ctx.stats.creditsReported += res.credits;
    // BestTime bills about one query credit per ten venues returned.
    ctx.stats.creditsEstimated += Math.max(1, Math.ceil(n / 10));
    venues.push(...res.venues);
    // venues_n is documented as "the total number of found venues", and the
    // documentation's own example has it equal to the page. It is read as the
    // box total only when it is larger than the page it came with; otherwise
    // it says nothing the page length does not, and the short page decides.
    const total = res.total !== null && res.total > n ? res.total : null;
    if (venues.length >= ctx.opts.resultCap || (total !== null && total >= ctx.opts.resultCap)) {
      saturated = true;
      break;
    }
    if (n < ctx.opts.pageSize) break;
    if (total !== null && venues.length >= total) break;
  }
  return { venues, saturated, pages };
}

// One weekday across the tiles. Returns the leaves (boxes that answered under
// the cap, or could not be split further) so later days start from them.
async function harvestDay(ctx, tiles, day) {
  const queue = tiles.slice();
  const leaves = [];
  const byVenue = new Map();
  let mismatched = 0;
  let unverifiable = 0;
  while (queue.length > 0) {
    const tile = queue.shift();
    const res = await fetchTile(ctx, tile, day);
    for (const raw of res.venues) {
      const v = readFilterVenue(raw);
      if (!v) { ctx.stats.malformed++; continue; }
      if (v.dayInt === null) { unverifiable++; continue; }
      if (v.dayInt !== day) { mismatched++; continue; }
      if (!byVenue.has(v.venueId)) byVenue.set(v.venueId, v);
    }
    if (res.saturated) {
      const kids = splitTile(tile);
      const inside = kids ? kids.filter((k) => tileIntersects(k, ctx.opts.cities, ctx.opts.radiusKm)) : null;
      if (inside) {
        ctx.stats.splits++;
        console.log(`  ${BT_DAY_NAMES[day]}  ${tileLabel(tile)}  reached the ${ctx.opts.resultCap} cap, split into ${inside.length}`);
        queue.unshift(...inside);
        continue;
      }
      ctx.stats.truncatedTiles++;
      console.warn(`  ${BT_DAY_NAMES[day]}  ${tileLabel(tile)}  reached the cap at the minimum tile size; some venues here are missing`);
    } else {
      console.log(`  ${BT_DAY_NAMES[day]}  ${tileLabel(tile)}  ${res.venues.length} venues (${res.pages} page${res.pages === 1 ? '' : 's'})`);
    }
    leaves.push(tile);
  }
  // A record for another day is the filter ignoring day_int, and writing it
  // would file one weekday's curve under another. Refuse the whole day.
  if (mismatched > 0) {
    throw abortError(`BestTime answered ${mismatched} venues for a different day than ${BT_DAY_NAMES[day]} (day_int=${day}). `
      + 'The day parameter is not being honoured; nothing from this run is written.');
  }
  if (unverifiable > 0 && byVenue.size === 0) {
    throw abortError(`none of the ${unverifiable} venues for ${BT_DAY_NAMES[day]} said which day they are for; nothing is written.`);
  }
  if (unverifiable > 0) ctx.stats.unverifiable += unverifiable;
  return { leaves, byVenue };
}

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------
async function loadIdentities(pool, venueIds, placeIds) {
  const { rows } = await pool.query(
    `SELECT id, google_place_id, besttime_venue_id, city, is_active, venue_category,
            price_level, rating, review_count, timezone
       FROM ml_venues
      WHERE besttime_venue_id = ANY($1::text[]) OR google_place_id = ANY($2::text[])`,
    [venueIds, placeIds]
  );
  const byBtId = new Map();
  const byPlaceId = new Map();
  for (const r of rows) {
    if (r.besttime_venue_id) byBtId.set(r.besttime_venue_id, r);
    byPlaceId.set(r.google_place_id, r);
  }
  return { byBtId, byPlaceId };
}

// Every row inside the box the harvested venues span, padded by more than
// NEAR_DUP_METERS, for identity rule 4.
async function loadNearbyRows(pool, venues) {
  const pts = venues.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
  if (pts.length === 0) return [];
  const pad = 0.001;
  let s = Infinity; let n = -Infinity; let w = Infinity; let e = -Infinity;
  for (const v of pts) {
    s = Math.min(s, v.lat); n = Math.max(n, v.lat);
    w = Math.min(w, v.lng); e = Math.max(e, v.lng);
  }
  const { rows } = await pool.query(
    `SELECT id, google_place_id, besttime_venue_id, name, latitude, longitude, city, is_active, venue_category,
            price_level, rating, review_count, timezone
       FROM ml_venues
      WHERE latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4`,
    [s - pad, n + pad, w - pad, e + pad]
  );
  return rows;
}

// The stored weekly week of every row in `rowIds`, as weekCurve()s.
async function loadStoredWeeks(pool, rowIds) {
  const out = new Map();
  if (rowIds.length === 0) return out;
  const { rows } = await pool.query(
    `SELECT venue_id, day_of_week, hour, busyness_pct
       FROM ml_training_data
      WHERE venue_id = ANY($1::bigint[])
        AND collection_mode = 'weekly'
        AND hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'
        AND busyness_pct IS NOT NULL`,
    [rowIds]
  );
  for (const r of rows) {
    const id = Number(r.venue_id);
    if (!out.has(id)) out.set(id, new Int16Array(WEEK_HOURS).fill(-1));
    if (r.day_of_week >= 0 && r.day_of_week <= 6 && r.hour >= 0 && r.hour <= 23) {
      out.get(id)[r.day_of_week * 24 + r.hour] = Math.max(0, Math.min(100, Math.round(Number(r.busyness_pct))));
    }
  }
  return out;
}

// For the venues known by BestTime id: does the filter's place id agree with
// the one the row stores?
function placeIdAgreement(plan) {
  const out = { knownBt: 0, same: 0, differs: 0, storedPseudo: 0, filterUnusable: 0, filterNone: 0 };
  for (const item of plan) {
    if (item.kind !== 'known_bt') continue;
    out.knownBt++;
    const stored = item.row.google_place_id || '';
    if (!item.venue.placeId) {
      if (item.venue.rawPlaceId) out.filterUnusable++; else out.filterNone++;
    } else if (item.venue.placeId === stored) out.same++;
    else if (/^bt_/i.test(stored)) out.storedPseudo++;
    else out.differs++;
  }
  return out;
}

// Decides, for every harvested venue, which row its week belongs to, or why it
// is skipped. Pure: the tests drive it without a database. `identities.nearby`
// is every ml_venues row around the harvest (loadNearbyRows); without it rule 4
// finds nothing.
function planVenues(venues, identities, cities, { radiusKm = DEFAULT_RADIUS_KM } = {}) {
  const plan = [];
  const skipped = {
    outsideMarkets: 0, otherMarket: 0, outsideRadius: 0, noPlaceId: 0, unusablePlaceId: 0,
    placeHeldByOtherBtId: 0, placeClaimedTwice: 0, nearDupHeldByOtherBtId: 0, nearDupClaimed: 0,
    nearDuplicateInRun: 0, unmappedType: 0, noName: 0, noSignal: 0, noCoordinates: 0,
  };
  const claimedPlaces = new Map(); // place id -> BestTime id that took it this run
  const claimedRows = new Set();
  const nearRows = nearIndex(identities.nearby || []);
  const rest = [];
  // Pass one: placement, and every venue this corpus already holds by its
  // BestTime id. Done first so the answer does not depend on the order
  // BestTime listed the venues in.
  for (const v of venues) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) { skipped.noCoordinates++; continue; }
    const where = nearestPaCity(v.lat, v.lng);
    if (!where.cityKey) { skipped.outsideMarkets++; continue; }
    if (!cities.includes(where.cityKey)) { skipped.otherMarket++; continue; }
    const byBt = identities.byBtId.get(v.venueId);
    if (!byBt) { rest.push({ v, where }); continue; }
    plan.push({ kind: 'known_bt', venue: v, row: byBt, city: where.cityKey });
    claimedRows.add(byBt.id);
    // Its place id is spoken for even when the stored row sits under a pseudo
    // id, or a second BestTime venue carrying the same place would be admitted
    // as a new row for the same building.
    if (v.placeId) claimedPlaces.set(v.placeId, v.venueId);
  }
  // Pass two: everything else, by Google place id, then by a nearby row with a
  // similar name. In BestTime id order, so which of two claimants wins does not
  // depend on the order the filter listed them in.
  rest.sort((a, b) => (a.v.venueId < b.v.venueId ? -1 : a.v.venueId > b.v.venueId ? 1 : 0));
  const newGrid = new Map(); // new venues accepted so far, by ~110 m cell
  for (const { v, where } of rest) {
    if (!v.placeId) {
      if (v.rawPlaceId) skipped.unusablePlaceId++; else skipped.noPlaceId++;
      continue;
    }
    const claimedBy = claimedPlaces.get(v.placeId);
    if (claimedBy && claimedBy !== v.venueId) { skipped.placeClaimedTwice++; continue; }
    const byPlace = identities.byPlaceId.get(v.placeId);
    if (byPlace) {
      if (byPlace.besttime_venue_id && byPlace.besttime_venue_id !== v.venueId) { skipped.placeHeldByOtherBtId++; continue; }
      if (claimedRows.has(byPlace.id)) { skipped.placeClaimedTwice++; continue; }
      claimedPlaces.set(v.placeId, v.venueId);
      claimedRows.add(byPlace.id);
      plan.push({ kind: 'known_place', venue: v, row: byPlace, city: where.cityKey });
      continue;
    }
    // Rule 4: the nearest row close enough with a similar name.
    const near = nearRows(v.lat, v.lng).find((c) => namesSimilar(v.name, c.row.name));
    if (near) {
      const row = near.row;
      if (row.besttime_venue_id && row.besttime_venue_id !== v.venueId) { skipped.nearDupHeldByOtherBtId++; continue; }
      if (claimedRows.has(row.id)) { skipped.nearDupClaimed++; continue; }
      claimedPlaces.set(v.placeId, v.venueId);
      claimedRows.add(row.id);
      plan.push({ kind: 'known_near', venue: v, row, city: where.cityKey, meters: near.meters });
      continue;
    }
    if (where.km > radiusKm) { skipped.outsideRadius++; continue; }
    const category = v.type ? TYPE_TO_CATEGORY[v.type] : undefined;
    if (!category) { skipped.unmappedType++; continue; }
    if (!v.name) { skipped.noName++; continue; }
    const hasSignal = [...v.days.values()].some((hours) => hours.some((x) => x != null && x > 0));
    if (!hasSignal) { skipped.noSignal++; continue; }
    // Two new listings of one venue: the first (lower BestTime id) is kept.
    const gx = Math.floor(v.lat * 1000);
    const gy = Math.floor(v.lng * 1000);
    let twin = false;
    for (let dx = -1; dx <= 1 && !twin; dx++) {
      for (let dy = -1; dy <= 1 && !twin; dy++) {
        twin = (newGrid.get(`${gx + dx}_${gy + dy}`) || []).some((o) => (
          kmBetween(v.lat, v.lng, o.lat, o.lng) * 1000 <= NEAR_DUP_METERS && namesSimilar(v.name, o.name)));
      }
    }
    if (twin) { skipped.nearDuplicateInRun++; continue; }
    if (!newGrid.has(`${gx}_${gy}`)) newGrid.set(`${gx}_${gy}`, []);
    newGrid.get(`${gx}_${gy}`).push(v);
    claimedPlaces.set(v.placeId, v.venueId);
    plan.push({ kind: 'new', venue: v, row: null, city: where.cityKey, category });
  }
  return { plan, skipped };
}

// ---------------------------------------------------------------------------
// Writes, one venue per transaction under the corpus write lock.
// ---------------------------------------------------------------------------
const WEEKLY_UPSERT_COLUMNS = `(venue_id, collection_mode, hour_axis, day_of_week, hour, month, season,
   venue_category, price_level, rating, review_count,
   temperature, humidity, wind_speed, weather_condition, weather_condition_code,
   is_raining, busyness_pct, besttime_epoch,
   events_observed, events_unavailable_reason,
   event_nearby, has_nearby_event, total_nearby_events, total_nearby_attendance,
   nearest_event_attendance, nearest_event_distance_km, nearest_event_type)`;

// Same arbiter and the same DO UPDATE list as collectWeekly.js: every non-key
// column of the INSERT appears below, so a refresh can leave nothing stale.
// One exception, besttime_epoch: this script never knows an epoch, so it keeps
// the one a row already carries instead of blanking it. For a venue this
// corpus forecast, the curve the filter returns is that stored forecast, the
// analysis the epoch names (the axis proof's "exact" column says how often the
// values are unchanged); migration 024 and the repair script break ties on
// the column, and NULL sorts last there.
const WEEKLY_UPSERT_CONFLICT = `ON CONFLICT (venue_id, day_of_week, hour)
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
  besttime_epoch         = COALESCE(EXCLUDED.besttime_epoch, ml_training_data.besttime_epoch),
  events_observed        = EXCLUDED.events_observed,
  events_unavailable_reason = EXCLUDED.events_unavailable_reason,
  event_nearby           = EXCLUDED.event_nearby,
  has_nearby_event       = EXCLUDED.has_nearby_event,
  total_nearby_events    = EXCLUDED.total_nearby_events,
  total_nearby_attendance = EXCLUDED.total_nearby_attendance,
  nearest_event_attendance = EXCLUDED.nearest_event_attendance,
  nearest_event_distance_km = EXCLUDED.nearest_event_distance_km,
  nearest_event_type     = EXCLUDED.nearest_event_type,
  collected_at           = NOW()
RETURNING (xmax = 0) AS inserted`;

async function upsertWeek(client, row, cells) {
  const calendar = venueCalendar(row);
  const params = [];
  const values = [];
  for (const c of cells) {
    const rowParams = [
      row.id, c.dayOfWeek, c.hour, calendar.month, calendar.season,
      row.venue_category, row.price_level, row.rating, row.review_count,
      // A typical week has no weather (collectWeekly.js explains at length).
      null, null, null, null, null, null,
      // No analysis epoch: the filter does not say which analysis this is. A
      // refreshed row keeps the one it has (WEEKLY_UPSERT_CONFLICT).
      c.busyness, null,
      // Migration 045's stamp for a typical week, and the seven event columns
      // NULL so their SQL defaults cannot write a measured absence.
      false, 'no_observation_date',
      null, null, null, null, null, null, null,
    ];
    const base = params.length;
    params.push(...rowParams);
    values.push(`($${base + 1}, 'weekly', '${HOUR_AXIS_VENUE_LOCAL}', `
      + rowParams.slice(1).map((_, k) => `$${base + 2 + k}`).join(', ') + ')');
  }
  const res = await client.query(
    `INSERT INTO ml_training_data ${WEEKLY_UPSERT_COLUMNS} VALUES ${values.join(', ')} ${WEEKLY_UPSERT_CONFLICT}`,
    params
  );
  return { written: res.rows.length, inserted: res.rows.filter((r) => r.inserted).length };
}

// Returns { status: 'written' | 'vanished' | 'claimed', written, inserted, newVenue }.
async function writeOne(pool, item, cells) {
  const v = item.venue;
  return withCorpusWriteLock(pool, async (client) => {
    let row;
    let newVenue = false;
    if (item.kind === 'known_bt') {
      // Re-resolved inside the lock: the repair script may have retired or
      // unmapped the row since the plan was made.
      const { rows } = await client.query('SELECT * FROM ml_venues WHERE id = $1 AND besttime_venue_id = $2', [item.row.id, v.venueId]);
      if (!rows[0]) return { status: 'vanished' };
      row = rows[0];
    } else if (item.kind === 'known_place' || item.kind === 'known_near') {
      // A near-duplicate row was chosen by distance and name, not by this
      // place id, so only the BestTime half of the check applies to it.
      const { rows } = item.kind === 'known_place'
        ? await client.query(
          'SELECT * FROM ml_venues WHERE id = $1 AND google_place_id = $2 AND (besttime_venue_id IS NULL OR besttime_venue_id = $3)',
          [item.row.id, v.placeId, v.venueId]
        )
        : await client.query(
          'SELECT * FROM ml_venues WHERE id = $1 AND (besttime_venue_id IS NULL OR besttime_venue_id = $2)',
          [item.row.id, v.venueId]
        );
      if (!rows[0]) return { status: 'vanished' };
      const { rows: holder } = await client.query(
        'SELECT 1 FROM ml_venues WHERE besttime_venue_id = $1 AND id <> $2', [v.venueId, item.row.id]
      );
      if (holder[0]) return { status: 'claimed' };
      row = rows[0];
    } else {
      // Asked again under the lock, so a venue another writer admitted since
      // the plan was made is not given a second identity.
      const { rows: taken } = await client.query(
        'SELECT 1 FROM ml_venues WHERE besttime_venue_id = $1 OR google_place_id = $2', [v.venueId, v.placeId]
      );
      if (taken[0]) return { status: 'claimed' };
      const { rows } = await client.query(
        `INSERT INTO ml_venues
           (google_place_id, besttime_venue_id, name, address, city, latitude, longitude,
            venue_category, google_types, price_level, rating, review_count, timezone,
            is_active, besttime_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, $10, $11, false, $12)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          v.placeId, v.venueId, v.name, v.address, item.city, v.lat, v.lng,
          item.category, v.rating, v.reviews, PA_CITIES[item.city].tz, HARVEST_STATUS,
        ]
      );
      if (!rows[0]) return { status: 'claimed' };
      row = rows[0];
      newVenue = true;
    }
    const res = await upsertWeek(client, row, cells);
    if (res.written > 0) {
      // A claim about data, made only when data landed (collectWeekly's rule).
      await client.query('UPDATE ml_venues SET last_collected_at = NOW() WHERE id = $1', [row.id]);
    }
    return { status: 'written', ...res, newVenue };
  });
}

// ---------------------------------------------------------------------------
// Account status, before and after.
// ---------------------------------------------------------------------------
async function readAccount(key, label) {
  const answer = await besttime.fetchKeyStatus(key, { timeoutMs: 20000 });
  if (!answer.ok) {
    const why = answer.kind === 'network' ? `request failed (${answer.code})`
      : answer.kind === 'http' ? `HTTP ${answer.httpStatus}` : 'not JSON';
    console.log(`${TAG} Account ${label}: could not be read (${why}).`);
    return { ok: false };
  }
  const status = besttime.readKeyStatus(answer.body, { secrets: [key, process.env.BESTTIME_API_KEY_PUBLIC].filter(Boolean) });
  const shown = (v) => (v === null ? 'not reported' : v);
  const extra = status.reported.map((f) => `${f.name}=${f.withheld ? '[withheld]' : String(f.value).slice(0, 40)}`);
  console.log(`${TAG} Account ${label}: key ${status.healthy ? 'OK (valid, active)' : 'NOT OK'}, `
    + `credits_forecast=${shown(status.creditsForecast)}, credits_query=${shown(status.creditsQuery)}`
    + `${extra.length ? `, ${extra.join(', ')}` : ''}`);
  return { ok: true, status };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
function emptyStats() {
  return {
    requests: 0, venuesReturned: 0, creditsReported: 0, creditsEstimated: 0, notFound: 0,
    splits: 0, truncatedTiles: 0, malformed: 0, unverifiable: 0,
    // Which field each venue-day's curve came from, and how the other compared.
    fromWhole: 0, fieldsIdentical: 0, fieldsDiffer: 0, fieldAltAbsent: 0,
  };
}

async function harvest({ argv = process.argv, pool, sleep = realSleep } = {}) {
  const summary = {
    exitCode: 1, aborted: false, abortReason: null, commit: false,
    tiles: 0, leaves: 0, venuesFound: 0, plan: { known_bt: 0, known_place: 0, known_near: 0, new: 0 },
    skipped: null, rowsPlanned: 0, rowsWritten: 0, rowsInserted: 0, rowsRefreshed: 0,
    venuesInserted: 0, venuesWritten: 0, vanished: 0, claimed: 0, writeFailures: 0,
    incompleteWeeks: 0, stats: emptyStats(),
    axis: null, axisAlt: null, axisVerdict: null, placeIds: null, nearDuplicates: null, peakHours: null,
  };

  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`${TAG} ${opts.error}`);
    summary.aborted = true;
    summary.abortReason = opts.error;
    return summary;
  }
  summary.commit = opts.commit;
  const key = besttime.configuredKey();
  if (!key) {
    summary.aborted = true;
    summary.abortReason = 'BESTTIME_API_KEY is not set';
    console.error(`${TAG} BESTTIME_API_KEY is not set in backend/.env; nothing to harvest.`);
    return summary;
  }

  console.log(`${TAG} ${opts.commit ? 'COMMIT' : 'DRY RUN (nothing is written; --commit writes)'}: `
    + `${opts.cities.join(' + ')}, days ${opts.days.map((d) => BT_DAY_NAMES[d]).join(',')}, `
    + `${opts.allTypes ? 'all venue types' : `${Object.keys(TYPE_TO_CATEGORY).length} mapped venue types`}, `
    + `within ${opts.radiusKm} km, cap ${opts.resultCap}, page ${opts.pageSize}.`);

  try {
    // Both refusals before the first BestTime call, the way discoverBestTime
    // orders them: a run that cannot upsert must not spend credits first, and a
    // dry run against such a database would promise writes it cannot make.
    await requireVenueIdIndex(pool);
    await requireSlotIndex(pool, WEEKLY_SLOT_INDEX);

    return await withAdmissionGuard(async () => {
      const before = await readAccount(key, 'before');
      if (!before.ok || !before.status.healthy) {
        throw abortError('the key status endpoint did not report a healthy key; not starting.');
      }

      const ctx = { key, opts, stats: summary.stats, sleep, pace: makePacer(sleep, START_INTERVAL_MS) };
      let tiles = buildTiles(opts.cities, opts.tileKm, opts.radiusKm);
      summary.tiles = tiles.length;
      console.log(`${TAG} ${tiles.length} tiles of about ${opts.tileKm} km cover ${opts.cities.join(' + ')} `
        + `(within ${opts.radiusKm} km of the centroid). At least ${tiles.length * opts.days.length} requests, one every `
        + `${START_INTERVAL_MS / 1000}s. Query credits: about one per ten venues returned, per day asked. `
        + 'New-venue admissions: none; this script cannot call an endpoint that makes one.');

      // venueId -> merged venue with a Map of BestTime day -> 24 slots, and the
      // other curve field's slots for the axis proof.
      const venues = new Map();
      for (let i = 0; i < opts.days.length; i++) {
        const day = opts.days[i];
        const startCredits = ctx.stats.creditsEstimated;
        const { leaves, byVenue } = await harvestDay(ctx, tiles, day);
        tiles = leaves;
        for (const v of byVenue.values()) {
          let merged = venues.get(v.venueId);
          if (!merged) {
            merged = { ...v, days: new Map(), altDays: new Map() };
            delete merged.hours;
            delete merged.hoursAlt;
            delete merged.curveField;
            delete merged.dayInt;
            venues.set(v.venueId, merged);
          }
          if (!merged.placeId && v.placeId) merged.placeId = v.placeId;
          if (!merged.rawPlaceId && v.rawPlaceId) merged.rawPlaceId = v.rawPlaceId;
          if (v.hours) merged.days.set(day, v.hours); else ctx.stats.malformed++;
          if (v.curveField === 'day_raw_whole') ctx.stats.fromWhole++;
          if (v.hours && v.hoursAlt) {
            merged.altDays.set(day, v.hoursAlt);
            if (v.hoursAlt.every((x, s) => x === v.hours[s])) ctx.stats.fieldsIdentical++; else ctx.stats.fieldsDiffer++;
          } else if (v.hours) ctx.stats.fieldAltAbsent++;
        }
        const used = ctx.stats.creditsEstimated - startCredits;
        console.log(`${TAG} ${BT_DAY_NAMES[day]}: ${byVenue.size} venues, ~${used} query credits.`
          + (i === 0 && opts.days.length > 1
            ? ` The other ${opts.days.length - 1} days should use about ${used * (opts.days.length - 1)} more.`
            : ''));
      }
      summary.leaves = tiles.length;
      summary.venuesFound = venues.size;

      const all = [...venues.values()].filter((v) => v.days.size > 0);
      const withPlaceId = all.filter((v) => v.placeId).length;
      if (opts.askPlaceId && all.length > 0 && withPlaceId === 0) {
        console.warn(`${TAG} WARNING: place ids were asked for and none of ${all.length} venues carried one. `
          + 'No new venue can be added; known venues are still refreshed. Check the place_id parameter name.');
      }

      const identities = await loadIdentities(
        pool, all.map((v) => v.venueId), all.map((v) => v.placeId).filter(Boolean)
      );
      identities.nearby = await loadNearbyRows(pool, all);
      const { plan, skipped } = planVenues(all, identities, opts.cities, { radiusKm: opts.radiusKm });
      summary.skipped = skipped;
      for (const item of plan) {
        summary.plan[item.kind]++;
        item.cells = weekCells([...item.venue.days.entries()].sort((a, b) => a[0] - b[0]));
        summary.rowsPlanned += item.cells.length;
        if (item.venue.days.size < 7) summary.incompleteWeeks++;
      }
      console.log(`${TAG} Venues found: ${venues.size}. Known by BestTime id: ${summary.plan.known_bt}. `
        + `Known by Google place id: ${summary.plan.known_place}. Known as a near-duplicate of an existing row: `
        + `${summary.plan.known_near}. New with a Google place id: ${summary.plan.new}.`);
      console.log(`${TAG} Skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
      if (summary.plan.known_place + summary.plan.known_near > 0) {
        console.log(`${TAG} ${summary.plan.known_place + summary.plan.known_near} known venues have no BestTime id stored; `
          + 'their curves are filed, and no id is stamped (stamping would put them in the hourly live sweep).');
      }

      // IDENTITY CHECKS.
      const agree = placeIdAgreement(plan);
      summary.placeIds = agree;
      console.log(`${TAG} PLACE IDS, venues known by BestTime id: ${agree.same} of ${agree.knownBt} carry the stored `
        + `google_place_id; ${agree.differs} carry a different real one; ${agree.storedPseudo} are stored under a bt_ `
        + `pseudo id; ${agree.filterUnusable} carry an id of no Google shape; ${agree.filterNone} carry none.`);
      const near = {
        filed: summary.plan.known_near,
        heldByOtherBtId: skipped.nearDupHeldByOtherBtId,
        claimed: skipped.nearDupClaimed,
        inRun: skipped.nearDuplicateInRun,
      };
      summary.nearDuplicates = near;
      console.log(`${TAG} NEAR-DUPLICATES: ${near.filed + near.heldByOtherBtId + near.claimed} venues with no row by `
        + `either id sit within ${NEAR_DUP_METERS} m of an existing ml_venues row with a similar name: ${near.filed} filed `
        + `under that row (no new row), ${near.heldByOtherBtId} skipped (the row holds another BestTime id), `
        + `${near.claimed} skipped (the row was already claimed this run). ${near.inRun} more were a second listing `
        + 'of a new venue in this run and were skipped.');
      const heads = new Map();
      for (const v of all) {
        if (v.rawPlaceId && !v.placeId) heads.set(v.rawPlaceId.slice(0, 4), (heads.get(v.rawPlaceId.slice(0, 4)) || 0) + 1);
      }
      if (heads.size > 0) {
        console.log(`${TAG} Place ids refused as no Google shape, by first four characters: `
          + [...heads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => `${h}.. ${n}`).join(', ') + '.');
      }

      // THE AXIS PROOF, before a single row can be written.
      const knownBt = plan.filter((item) => item.kind === 'known_bt');
      const stored = await loadStoredWeeks(pool, knownBt.map((item) => Number(item.row.id)));
      const pairsFor = (daysKey) => knownBt
        .filter((item) => stored.has(Number(item.row.id)) && item.venue[daysKey].size > 0)
        .map((item) => ({
          planned: weekCurve(weekCells([...item.venue[daysKey].entries()].sort((a, b) => a[0] - b[0]))),
          stored: stored.get(Number(item.row.id)),
        }));
      const proof = axisProof(pairsFor('days'));
      const verdict = axisVerdict(proof);
      summary.axis = proof;
      summary.axisVerdict = verdict;
      const s = ctx.stats;
      console.log(`${TAG} AXIS PROOF: ${knownBt.length} venues known by BestTime id, ${stored.size} with stored weekly `
        + `rows; ${proof.venues} compared (${proof.thin} with fewer than ${AXIS_MIN_OVERLAP} shared cells and ${proof.flat} `
        + `with a flat stored curve left out). Curves read from day_raw_whole on ${s.fromWhole} venue-days; day_raw `
        + `beside it identical on ${s.fieldsIdentical}, different on ${s.fieldsDiffer}, absent on ${s.fieldAltAbsent}. `
        + 'Shift +k: the harvested curve sits k hours later on the venue clock than the stored rows.');
      for (const line of formatAxisTable(proof)) console.log(line);
      if (s.fieldsDiffer > 0) {
        const alt = axisProof(pairsFor('altDays'));
        summary.axisAlt = alt;
        const alt0 = alt.table.find((r) => r.shift === 0);
        console.log(`${TAG} Read from day_raw instead: best rotation ${alt.bestShift}, at rotation 0 MAE `
          + `${alt0.mae === null ? 'n/a' : alt0.mae.toFixed(2)}, within five ${pct(alt0.within5)}, r `
          + `${alt0.r === null ? 'n/a' : alt0.r.toFixed(3)}, over ${alt.venues} venues.`);
      }
      console.log(`${TAG} COMMIT GATE: ${verdict.pass ? 'PASS' : 'REFUSED'} (${verdict.reason}).`);

      const peaks = peakHourHistogram(plan);
      summary.peakHours = peaks;
      console.log(`${TAG} PEAK HOUR by category, venue-local: venues whose week-averaged busiest hour is that hour.`);
      for (const line of formatPeakHistogram(peaks)) console.log(line);

      if (!opts.commit) {
        console.log(`${TAG} Would write ${summary.rowsPlanned} weekly rows for ${plan.length} venues `
          + `and add ${summary.plan.new} ml_venues rows (inactive, besttime_status '${HARVEST_STATUS}').`);
        summary.exitCode = summary.rowsPlanned > 0 && verdict.pass ? 0 : 1;
      } else {
        if (!verdict.pass) {
          throw abortError(`REFUSED: the axis proof failed, so the curves' hour origin is not established: ${verdict.reason}. `
            + 'Nothing was written.');
        }
        for (const item of plan) {
          if (item.cells.length === 0) continue;
          try {
            const res = await writeOne(pool, item, item.cells);
            if (res.status === 'vanished') { summary.vanished++; continue; }
            if (res.status === 'claimed') { summary.claimed++; continue; }
            summary.venuesWritten++;
            if (res.newVenue) summary.venuesInserted++;
            summary.rowsWritten += res.written;
            summary.rowsInserted += res.inserted;
            summary.rowsRefreshed += res.written - res.inserted;
          } catch (err) {
            summary.writeFailures++;
            console.error(`  write failed for ${item.venue.venueId} (${err.code || 'no code'}): ${describeDbError(err)}`);
          }
        }
        console.log(`${TAG} Wrote ${summary.rowsWritten} weekly rows (${summary.rowsInserted} new, `
          + `${summary.rowsRefreshed} refreshed in place) for ${summary.venuesWritten} venues; `
          + `added ${summary.venuesInserted} ml_venues rows. ${summary.vanished} venues changed under the run, `
          + `${summary.claimed} were claimed by another writer, ${summary.writeFailures} writes failed.`);
        summary.exitCode = summary.rowsWritten > 0 && summary.writeFailures === 0 ? 0 : 1;
      }
      if (summary.incompleteWeeks > 0) {
        console.log(`${TAG} ${summary.incompleteWeeks} venues have fewer than seven days in this run; their other days are left as they were.`);
      }

      console.log(`${TAG} ${s.requests} filter requests over ${summary.leaves} leaf tiles (${s.splits} splits, `
        + `${s.truncatedTiles} tiles still at the cap at minimum size, ${s.notFound} answered 404). Query credits: `
        + `${s.creditsReported > 0 ? `${s.creditsReported} reported by BestTime, ` : ''}~${s.creditsEstimated} estimated.`
        + `${opts.commit ? '' : ' A --commit run of the same scope asks the same questions and should cost the same.'}`);
      await readAccount(key, 'after');
      console.log(`${TAG} New-venue admissions this run: none attempted (only the venue filter and the key `
        + 'status endpoint were called). The besttime.app dashboard shows the month\'s admission count.');
      if (summary.exitCode !== 0) {
        const why = opts.commit ? 'Nothing written, or a write failed'
          : summary.rowsPlanned === 0 ? 'Nothing to write' : 'The axis proof would refuse --commit';
        console.error(`${TAG} ${why}: exiting nonzero.`);
      }
      return summary;
    });
  } catch (err) {
    summary.aborted = true;
    summary.exitCode = 1;
    summary.abortReason = err.message;
    console.error(`${TAG} ABORTED: ${describeError(err)}`);
    if (err.abort) {
      // The run is over; the after-read still shows what was spent. Outside the
      // guard only because the guard is gone by now; it is the same allowed call.
      await withAdmissionGuard(() => readAccount(key, 'after')).catch(() => {});
    }
    return summary;
  }
}

function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // An explicit PGSSLMODE wins, as in collectWeekly.js; otherwise the
    // Railway default (TLS, self-signed tolerated).
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
}

async function main(argv = process.argv, deps = {}) {
  const pool = deps.pool || makePool();
  try {
    const summary = await harvest({ argv, pool, sleep: deps.sleep });
    process.exitCode = summary.exitCode;
    return summary;
  } finally {
    if (!deps.pool) await pool.end();
  }
}

module.exports = {
  main,
  harvest,
  parseArgs,
  assertAllowedRequest,
  withAdmissionGuard,
  buildTiles,
  splitTile,
  tileIntersects,
  buildFilterUrl,
  readFilterVenue,
  isRealGooglePlaceId,
  weekCells,
  weekCurve,
  planVenues,
  placeIdAgreement,
  axisProof,
  axisVerdict,
  peakHourHistogram,
  namesSimilar,
  TYPE_TO_CATEGORY,
  FILTER_URL,
  HARVEST_STATUS,
  DEFAULT_RESULT_CAP,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RADIUS_KM,
  NEAR_DUP_METERS,
  AXIS_MIN_VENUES,
  AXIS_MIN_OVERLAP,
  AXIS_MIN_WITHIN5,
  AXIS_MIN_VENUE_SHARE,
  MIN_TILE_SPAN,
};

// Only when run directly: a require from a test must not call BestTime.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} Fatal (${(err && err.name) || 'unknown error'}): ${describeError(err)}`);
    process.exitCode = 1;
  });
}
