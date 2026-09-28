// ---------------------------------------------------------------------------
// HARVEST WEEKLY CURVES FROM BESTTIME'S VENUE FILTER, ADMITTING NO VENUE
// ---------------------------------------------------------------------------
// Run (from backend/):
//   node scripts/ml/harvestVenueFilter.js --city=philly            dry run
//   node scripts/ml/harvestVenueFilter.js --city=philly --commit   writes
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
// it can be: besttime_epoch is NULL, because the filter does not say which
// analysis produced the curve (discoverBestTime.js writes NULL for the same
// reason), and events_observed is false with 'no_observation_date', migration
// 045's vocabulary for a typical week.
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
//   4. else, with a real Google place id: a NEW row. Never with a `bt_` pseudo
//      id; that minted identity is the first defect in discoverBestTime.js's
//      header. With no place id the venue is skipped, and the summary says how
//      many were.
// Every venue is also placed by nearestPaCity, addDemandVenues' own rule: the
// nearest PA centroid within MAX_KM, or outside both markets and skipped.
//
// NEW ROWS ARE INACTIVE, ON PURPOSE. collectRealtime.js sweeps every active PA
// row with a BestTime id, hourly, and REFUSES (throws, every hour) once that
// scope passes its 2,500 credit ceiling; the scope is about 1,400 today. A
// harvest can find thousands of venues, so a new row is written is_active =
// false with besttime_status = 'harvested', which keeps it out of both the
// hourly sweep and collectWeekly's refresh. Nothing that trains or serves
// filters on is_active: the export and buildBaselines read every row, so the
// curves are in the corpus and a real place id gets a served baseline.
// Promoting a harvested venue into the live sweep is a separate, deliberate
// UPDATE, made with that ceiling in view.
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
// TILING. The account caps one query at 500 results. Each market (a MAX_KM
// circle around its centroid) is covered with boxes, each box is paged
// (--page-size, default 100) until a short page, and a box that reaches the cap
// is split in four and its quarters asked instead, down to 0.002 degrees. The
// leaves found on the first day are reused for the rest of the week. Venues are
// de-duplicated by BestTime id, so a venue on a shared edge is counted once.
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
const HARVEST_STATUS = 'harvested';
const KM_PER_DEG_LAT = 111.32;

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
  const valued = ['--city=', '--days=', '--tile-km=', '--page-size=', '--result-cap=', '--max-requests='];
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
  for (const r of [tileKm, resultCap, pageSize, maxRequests]) if (r.error) return { error: r.error };
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
    resultCap: resultCap.value,
    pageSize: pageSize.value,
    maxRequests: maxRequests.value,
  };
}

// ---------------------------------------------------------------------------
// Tiles. A tile is { s, w, n, e } in integer thousandths of a degree.
// ---------------------------------------------------------------------------
const kmPerDegLng = (lat) => KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// True when any point of the box is within MAX_KM of a centroid of `cities`.
function tileIntersects(tile, cities) {
  return cities.some((key) => {
    const c = PA_CITIES[key];
    const lat = Math.min(Math.max(c.lat, tile.s / 1000), tile.n / 1000);
    const lon = Math.min(Math.max(c.lon, tile.w / 1000), tile.e / 1000);
    return kmBetween(c.lat, c.lon, lat, lon) <= MAX_KM;
  });
}

function buildTiles(cities, tileKm) {
  let s = Infinity; let n = -Infinity; let w = Infinity; let e = -Infinity;
  for (const key of cities) {
    const c = PA_CITIES[key];
    const dLat = MAX_KM / KM_PER_DEG_LAT;
    const dLng = MAX_KM / kmPerDegLng(c.lat);
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
      if (tileIntersects(tile, cities)) tiles.push(tile);
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
// (`bt_...`) or a BestTime venue id. Same length window addDemandVenues uses.
function isRealGooglePlaceId(id) {
  return typeof id === 'string'
    && /^[A-Za-z0-9_-]{10,255}$/.test(id)
    && !/^bt_/i.test(id)
    && !/^ven_/i.test(id);
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
    // day_raw_whole is the whole day whatever hours were filtered; day_raw is
    // the whole day too when no hours are, which is how this script asks.
    hours: readHours(raw.day_raw_whole) || readHours(raw.day_raw),
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
      if (!NETWORK_ERR_RE.test(String((err && err.message) || '')) && !(err instanceof SyntaxError)) {
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
      const shown = besttime.containsKeyMaterial(msg, [ctx.key]) ? '[withheld]' : msg.slice(0, 160);
      throw abortError(`the venue filter answered status "${String(data.status).slice(0, 20)}"${shown ? `: ${shown}` : ''}.`);
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
      const inside = kids ? kids.filter((k) => tileIntersects(k, ctx.opts.cities)) : null;
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

// Decides, for every harvested venue, which row its week belongs to, or why it
// is skipped. Pure: the tests drive it without a database.
function planVenues(venues, identities, cities) {
  const plan = [];
  const skipped = {
    outsideMarkets: 0, otherMarket: 0, noPlaceId: 0, unusablePlaceId: 0,
    placeHeldByOtherBtId: 0, placeClaimedTwice: 0, unmappedType: 0, noName: 0, noSignal: 0, noCoordinates: 0,
  };
  const claimedPlaces = new Map(); // place id -> BestTime id that took it this run
  const claimedRows = new Set();
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
  // Pass two: everything else, by Google place id.
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
    const category = v.type ? TYPE_TO_CATEGORY[v.type] : undefined;
    if (!category) { skipped.unmappedType++; continue; }
    if (!v.name) { skipped.noName++; continue; }
    const hasSignal = [...v.days.values()].some((hours) => hours.some((x) => x != null && x > 0));
    if (!hasSignal) { skipped.noSignal++; continue; }
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
  besttime_epoch         = EXCLUDED.besttime_epoch,
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
      // No analysis epoch: the filter does not say which analysis this is.
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
    } else if (item.kind === 'known_place') {
      const { rows } = await client.query(
        'SELECT * FROM ml_venues WHERE id = $1 AND google_place_id = $2 AND (besttime_venue_id IS NULL OR besttime_venue_id = $3)',
        [item.row.id, v.placeId, v.venueId]
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
  };
}

async function harvest({ argv = process.argv, pool, sleep = realSleep } = {}) {
  const summary = {
    exitCode: 1, aborted: false, abortReason: null, commit: false,
    tiles: 0, leaves: 0, venuesFound: 0, plan: { known_bt: 0, known_place: 0, new: 0 },
    skipped: null, rowsPlanned: 0, rowsWritten: 0, rowsInserted: 0, rowsRefreshed: 0,
    venuesInserted: 0, venuesWritten: 0, vanished: 0, claimed: 0, writeFailures: 0,
    incompleteWeeks: 0, stats: emptyStats(),
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
    + `cap ${opts.resultCap}, page ${opts.pageSize}.`);

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
      let tiles = buildTiles(opts.cities, opts.tileKm);
      summary.tiles = tiles.length;
      console.log(`${TAG} ${tiles.length} tiles of about ${opts.tileKm} km cover ${opts.cities.join(' + ')} `
        + `(within ${MAX_KM} km of the centroid). At least ${tiles.length * opts.days.length} requests, one every `
        + `${START_INTERVAL_MS / 1000}s. Query credits: about one per ten venues returned, per day asked. `
        + 'New-venue admissions: none; this script cannot call an endpoint that makes one.');

      // venueId -> merged venue with a Map of BestTime day -> 24 slots.
      const venues = new Map();
      for (let i = 0; i < opts.days.length; i++) {
        const day = opts.days[i];
        const startCredits = ctx.stats.creditsEstimated;
        const { leaves, byVenue } = await harvestDay(ctx, tiles, day);
        tiles = leaves;
        for (const v of byVenue.values()) {
          let merged = venues.get(v.venueId);
          if (!merged) {
            merged = { ...v, days: new Map() };
            delete merged.hours;
            delete merged.dayInt;
            venues.set(v.venueId, merged);
          }
          if (!merged.placeId && v.placeId) merged.placeId = v.placeId;
          if (!merged.rawPlaceId && v.rawPlaceId) merged.rawPlaceId = v.rawPlaceId;
          if (v.hours) merged.days.set(day, v.hours); else ctx.stats.malformed++;
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
      const { plan, skipped } = planVenues(all, identities, opts.cities);
      summary.skipped = skipped;
      for (const item of plan) {
        summary.plan[item.kind]++;
        item.cells = weekCells([...item.venue.days.entries()].sort((a, b) => a[0] - b[0]));
        summary.rowsPlanned += item.cells.length;
        if (item.venue.days.size < 7) summary.incompleteWeeks++;
      }
      console.log(`${TAG} Venues found: ${venues.size}. Known by BestTime id: ${summary.plan.known_bt}. `
        + `Known by Google place id: ${summary.plan.known_place}. New with a Google place id: ${summary.plan.new}.`);
      console.log(`${TAG} Skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
      if (summary.plan.known_place > 0) {
        console.log(`${TAG} ${summary.plan.known_place} known venues have no BestTime id stored; their curves are filed, `
          + 'and no id is stamped (stamping would put them in the hourly live sweep).');
      }

      if (!opts.commit) {
        console.log(`${TAG} Would write ${summary.rowsPlanned} weekly rows for ${plan.length} venues `
          + `and add ${summary.plan.new} ml_venues rows (inactive, besttime_status '${HARVEST_STATUS}').`);
        summary.exitCode = summary.rowsPlanned > 0 ? 0 : 1;
      } else {
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
            console.error(`  write failed for ${item.venue.venueId} (${err.code || 'no code'}): ${err.message}`);
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

      const s = ctx.stats;
      console.log(`${TAG} ${s.requests} filter requests over ${summary.leaves} leaf tiles (${s.splits} splits, `
        + `${s.truncatedTiles} tiles still at the cap at minimum size, ${s.notFound} answered 404). Query credits: `
        + `${s.creditsReported > 0 ? `${s.creditsReported} reported by BestTime, ` : ''}~${s.creditsEstimated} estimated.`
        + `${opts.commit ? '' : ' A --commit run of the same scope asks the same questions and should cost the same.'}`);
      await readAccount(key, 'after');
      console.log(`${TAG} New-venue admissions this run: none attempted (only the venue filter and the key `
        + 'status endpoint were called). The besttime.app dashboard shows the month\'s admission count.');
      if (summary.exitCode !== 0) {
        console.error(`${TAG} ${opts.commit ? 'Nothing written, or a write failed' : 'Nothing to write'}: exiting nonzero.`);
      }
      return summary;
    });
  } catch (err) {
    summary.aborted = true;
    summary.exitCode = 1;
    summary.abortReason = err.message;
    console.error(`${TAG} ABORTED: ${err.message}`);
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
  planVenues,
  TYPE_TO_CATEGORY,
  FILTER_URL,
  HARVEST_STATUS,
  DEFAULT_RESULT_CAP,
  DEFAULT_PAGE_SIZE,
  MIN_TILE_SPAN,
};

// Only when run directly: a require from a test must not call BestTime.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} Fatal (${(err && err.name) || 'unknown error'}): ${err && err.message}`);
    process.exitCode = 1;
  });
}
