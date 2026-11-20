// ---------------------------------------------------------------------------
// HARVEST WEEKLY CURVES FROM BESTTIME'S VENUE FILTER, ADMITTING NO VENUE
// ---------------------------------------------------------------------------
// Run (from backend/):
//   node scripts/ml/harvestVenueFilter.js --city=philly            dry run
//   node scripts/ml/harvestVenueFilter.js --city=philly --commit   writes, once the dry run's axis proof passes
//   node scripts/ml/harvestVenueFilter.js --city=all --new-only    every training city, new venues only (dry run)
// --city takes CITIES keys, comma separated, or all (EVERY TRAINING CITY
// below); --radius-km (default 20) sets how far each reaches; --result-budget
// (default 60000) caps the results one run may be billed for; --cache-dir=<dir>
// keeps every answer the filter gives there and answers a repeated question
// from it, unbilled (THE CACHE, above requestPage).
//
// WHY THIS EXISTS. The plan (Pro Package 100) meters 100 NEW venue admissions
// a calendar month, and 100,000 Venue Filter results a calendar month (THE
// RESULT BUDGET below). Forecasts by id and live calls are unlimited. The
// Venue Filter (GET /api/v1/venues/filter) answers with every venue BestTime
// holds a forecast for inside a box, WITH that venue's 24-slot curve for the
// day asked, and it bills query credits (one per ten venues returned), not
// admissions.
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
// best rotation is 0 and the agreement at 0 clears AXIS_* below (under
// --new-only, the hour-origin rule at AXIS_NEW_ONLY_*, which drift in old
// stored curves cannot fail); a dry run that would be refused exits nonzero,
// and the gate's line names the rule that judged it. Each run also prints each category's peak
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
// Every venue is also placed (WHERE A VENUE BELONGS, below), and one placed in
// no market, or in a city this run did not ask for, is skipped.
//
// EVERY TRAINING CITY. --city takes any key of config.js CITIES, and --city=all
// means all of them but four, which are refused by name (REFUSED_CITIES):
//   miami, tokyo, barcelona  train/export_training_data.js HOLDOUT_CITIES, the
//                            whole-city test set a retrain is scored on. The
//                            harvest leaves what it measures alone.
//   beijing                  Google has no usable data in mainland China, so no
//                            venue there has a place id the app could serve.
// Each city is tiled around its own centroid (CITIES; philly and lehigh from
// PA_CITIES, the market rule's table, which agrees to the last digit today), so
// a PA re-run asks exactly the questions it asked before. Cities within MAX_KM
// of each other share one grid, as philly and lehigh (77 km apart) always have;
// no other two CITIES are closer than 124 km, and one grid across an ocean
// would walk the planet and take its longitude step at the wrong latitude. A
// shared grid's boxes are counted against the nearest of its cities.
//
// WHERE A VENUE BELONGS (placeVenue). The PA market rule first, unchanged:
// addDemandVenues.nearestPaCity puts a venue within MAX_KM of philly or lehigh
// in the nearer of the two, in every run, so the two ways a venue enters the
// corpus still agree about where philly ends. Anywhere else, the nearest
// centroid within MAX_KM among the cities the run asked for and the refused
// four (nearestMarket, the same loop): a venue nearer a holdout city than any
// city asked for is that city's, and skipped, whatever --radius-km reaches. A
// new row takes the city it was placed in and that city's timezone.
//
// --new-only WRITES NOTHING FOR A VENUE THE CORPUS ALREADY HOLDS: no weekly
// upsert and no ml_venues update for one matched by BestTime id, by Google
// place id or as a near-duplicate (identity rules 1 to 4). Only a venue new to
// ml_venues gets its row and its weekly rows. Why: the November retrain exports
// the weekly rows of the venues it knows around 2026-11-27..29 and its research
// plan is final, so those curves must not move before the export; a new venue
// adds breadth without touching anything the plan measured (and is
// 'harvested', which the export leaves out unless asked; NEW ROWS ARE INACTIVE
// below). The axis proof still reads every venue it can compare, because it
// writes nothing, and a --commit still refuses when it fails. The summary
// counts the known venues skipped.
//
// THE RESULT BUDGET. The plan allows 100,000 Venue Filter results a calendar
// month (UTC), billed at one query credit per ten venues returned; a full week
// of philly alone was about 32,000 (3,193 credits, 2026-09-28). The month's
// other runs count against the same 100,000, so --result-budget (default
// 60,000) is per run: give a second run in a month what is left. A page holds
// at most --page-size venues, so the run stops before any request that could
// take its results past the budget, and says how many it used, in all and by
// city. A request that may have been billed without its answer being read (our
// deadline passed, the connection dropped mid-answer, the answer was not JSON,
// or a 5xx) holds a whole page against the budget, and a successful retry is
// counted beside the hold, never instead of it, so retries cannot carry the
// run past the budget; a request that never left (a refused connection, a
// name that did not resolve), a 429 and a cached answer hold nothing. The
// summary gives the results counted from answers and those reserved apart.
// Stopping must not leave a venue with part of a week, so the harvest
// goes leaf first: a box's first day finds its leaves (splitting as below),
// and each leaf asks its other days before the next leaf starts. A leaf's
// answers join the run only once its last day is in, and a split box's own
// first-day answer only once every leaf under it is; when the budget stops the
// run, the leaf in progress and its box are dropped whole, and the summary
// names the cities left unfinished and the --city= that continues them. These
// are the questions the day-by-day order asked, in a different order. A budget
// stop is never a way past the day check: a record naming a day other than
// the one asked is counted as its page arrives, and any such record refuses
// the run, stopped by the budget or not.
//
// NEW ROWS ARE INACTIVE, ON PURPOSE. collectRealtime.js sweeps every active PA
// row with a BestTime id, hourly, and REFUSES (throws, every hour) once that
// scope passes its 2,500 credit ceiling; the scope is about 1,400 today. A
// harvest can find thousands of venues, so a new row is written is_active =
// false with besttime_status = 'harvested', which keeps it out of both the
// hourly sweep and collectWeekly's refresh. A harvested venue gets a served
// baseline and scores for its own hours from the hourly run's targeted
// rebuild, a few thousand venues per daily run (its stamp does not make the
// hourly run rebuild; buildBaselines.js says why), or at once from
// `buildBaselines.js --targeted` by hand after a big harvest. It
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
// failure to report, never a success (collectRealtime's lesson). A run the
// result budget stopped is not an abort: it is judged by what it wrote.
//
// BESTTIME DELETES A STORED FORECAST AFTER 31 DAYS, and the filter only returns
// venues whose forecast still exists. Run this at least monthly; see RETRAIN.md,
// "Venue Filter harvest".
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { CITIES, bestTimeDayToJsDay, sleep: realSleep, withCorpusWriteLock } = require('./config');
// IMPORTED, NEVER REIMPLEMENTED: the slot -> (venue-local day, hour) transform
// and the axis literal live in collectWeekly.js, pinned against migration 023's
// SQL by __tests__/mlClockAxisBackfill.test.js.
const {
  bestTimeSlotToLocal, venueCalendar, requireSlotIndex,
  HOUR_AXIS_VENUE_LOCAL, WEEKLY_SLOT_INDEX,
} = require('./collectWeekly');
const { requireVenueIdIndex } = require('./discoverBestTime');
const {
  PA_CITIES, MAX_KM, kmBetween, nearestMarket, nearestPaCity,
} = require('./addDemandVenues');
// The holdout list itself, not a copy: a city added to it is refused here too.
const { HOLDOUT_CITIES } = require('./train/export_training_data');
const { classifyHttpFailure, fetchJsonWithTimeout, NETWORK_ERR_RE } = require('./bestTimeService');
const { labelFor, describeError, describeDbError, safeText } = require('./logSafe');
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

// THE RESULT BUDGET (see the header): the month's allowance, and the share of
// it one run may spend unless told otherwise.
const MONTHLY_RESULT_ALLOWANCE = 100000;
const DEFAULT_RESULT_BUDGET = 60000;

// The cities a run refuses by name, and why (EVERY TRAINING CITY).
const REFUSED_CITIES = Object.freeze({
  ...Object.fromEntries(HOLDOUT_CITIES.map((c) => [c, `${c} is a holdout city (train/export_training_data.js `
    + 'HOLDOUT_CITIES): its rows are the test set a retrain is scored on, and the harvest leaves them alone.'])),
  beijing: 'beijing is not harvested: Google has no usable data in mainland China, so no venue there has a '
    + 'Google place id the app could serve it under.',
});

// Every city's centroid and timezone. PA_CITIES wins for philly and lehigh, so
// a PA run asks what it always asked even if the two tables ever drift apart.
const CENTROIDS = Object.freeze({ ...CITIES, ...PA_CITIES });

// --city=all: every CITIES key but the refused ones, in config.js order.
const ALL_CITIES = Object.freeze(Object.keys(CITIES).filter((c) => !REFUSED_CITIES[c]));

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
// A --new-only commit writes nothing known, so the one question its gate asks
// is the hour origin of the NEW venues' curves. The within-five share above
// measures that AND how far the stored curves have drifted since they were
// collected: Denver (2026-11-18) had rotation 0 best by every measure, 528 of
// 540 venues best there, r 0.972 against 0.884 an hour off, and 88.1% within
// five only because its stored curves were months older than PA's (PA passed
// at 99.9% on fresh curves, 2026-11-02). Drift lowers every rotation's
// agreement alike; an origin error moves the best rotation. So under
// --new-only: the best pooled rotation at 0, at least
// AXIS_NEW_ONLY_MIN_VENUE_SHARE of compared venues individually best at 0, and
// rotation 0's r above every other rotation's by AXIS_NEW_ONLY_MIN_R_MARGIN,
// with AXIS_MIN_VENUES as before. A commit that refreshes known rows keeps the
// within-five rule: it overwrites stored curves, and how far they move is its
// question too.
// That venue share is two questions since 2026-11-18, each asked of the venues
// that can answer it, each with the same floor:
//   THE HOUR. Every compared venue whose best rotation (or every rotation tied
//   for its best) is a whole number of days, 0 included, lines up by hour.
//   THE DAY. A venue votes on it only with all 168 cells held on both sides
//   and a stored week at least AXIS_DAY_CONTRAST_MIN points (MAE) from itself
//   a whole number of days on: one whose days look alike cannot tell them
//   apart, as a flat curve cannot tell rotations apart. A voter lines up by
//   day when its best is a whole number of days and rotation 0 fits it within
//   AXIS_DAY_TIE_MAE of that best. The day share is those over EVERY compared
//   venue, so one that cannot vote counts against it: a day error cannot hide
//   among venues that cannot speak to it, and non-voters and voters a day off
//   share one allowance. At least AXIS_MIN_VENUES must vote. A voter really a day off,
//   read with no drift, misses that by its own day contrast (its best fits
//   exactly, rotation 0 by the contrast at that shift), so only drift can
//   admit one: drift that brings rotation 0 within a point of the true
//   rotation hides that venue's error, and no tolerance can tell the two
//   apart. How often that happens is measured below on NYC, not bounded.
// Why: counting rotation 0 alone (as first written) refused NYC's commit
// (2026-11-18: 404 of 454 venues, 89.0%) and would have refused PA's reference
// run (189 of 216 at 0, the rest tied with a whole day). A dry rerun from
// NYC's cache compared 462: 411 best at 0, 41 best or tied a whole day off, 10
// an hour off, r 0.939 against 0.854 at +1. A venue whose days look alike fits
// a day off nearly as well, and on months-old stored curves some tip over: the
// 38 best a whole day off fitted rotation 0 worse by a median of 0.36 points
// (90th percentile 1.49), though their days differ by a median of 8.4. NYC's
// venues all differ from themselves a day on by at least 2 points (10th
// percentile 5.2), and 461 of 462 hold whole weeks on both sides; 459 vote on
// the day, and 441 of the 462 (95.5%) line up by day while 452 (97.8%) do by
// hour. With a one-day error planted on the same harvested weeks (+24 or -24,
// ten spreads each), 11.7% of the venues still line up by day, and the gate
// refused every trial with 8% or more of the venues a day off, 15 of 20 at 7%,
// 3 of 20 at 6% and none at 5% or less. Review (2026-11-18)
// dropped four looser versions: a whole-day best with no tolerance counts every
// planted venue; a tolerance with no contrast floor counts venues whose days
// differ by one spike; a floor whose share is taken over the voters alone, or
// measured over a partial week, lets the venues that can speak decide for the
// rest, and with two 90% floors (voters, then voters lined up) 19% of venues
// exactly a day off passed. A city whose curves are all a day off is refused by the
// pooled tests as before: the best pooled rotation must be 0, and r at 0 must
// beat +-24 by the margin.
const AXIS_NEW_ONLY_MIN_VENUE_SHARE = 0.9;
const AXIS_DAY_TIE_MAE = 1;
const AXIS_DAY_CONTRAST_MIN = 3;
const AXIS_NEW_ONLY_MIN_R_MARGIN = 0.05;
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

function parseCities(argv) {
  const cityArg = argv.find((a) => a.startsWith('--city='));
  if (!cityArg) return { cities: Object.keys(PA_CITIES) };
  const names = [...new Set(cityArg.slice('--city='.length).split(',').map((s) => s.trim()).filter(Boolean))];
  if (names.includes('all')) {
    return names.length === 1 ? { cities: [...ALL_CITIES] } : { error: '--city=all stands alone; name cities, or all.' };
  }
  const refused = names.find((c) => REFUSED_CITIES[c]);
  if (refused) return { error: `--city=${refused} refused: ${REFUSED_CITIES[refused]}` };
  const unknownCity = names.find((c) => !CENTROIDS[c]);
  if (names.length === 0 || unknownCity) {
    return { error: `--city takes scripts/ml/config.js CITIES keys, comma separated, or all${unknownCity ? `; got "${unknownCity}"` : ''}.` };
  }
  return { cities: names };
}

function parseArgs(argv) {
  const known = ['--commit', '--all-types', '--no-place-id', '--new-only'];
  const valued = ['--city=', '--days=', '--tile-km=', '--page-size=', '--result-cap=', '--max-requests=', '--radius-km=',
    '--result-budget=', '--cache-dir='];
  for (const a of argv.slice(2)) {
    if (!known.includes(a) && !valued.some((p) => a.startsWith(p))) {
      return { error: `Unknown argument "${a}".` };
    }
  }
  const parsedCities = parseCities(argv);
  if (parsedCities.error) return { error: parsedCities.error };
  const { cities } = parsedCities;
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
  const resultBudget = intArg(argv, 'result-budget', DEFAULT_RESULT_BUDGET, { min: 1, max: MONTHLY_RESULT_ALLOWANCE });
  for (const r of [tileKm, resultCap, pageSize, maxRequests, radiusKm, resultBudget]) if (r.error) return { error: r.error };
  if (pageSize.value > resultCap.value) {
    return { error: `--page-size (${pageSize.value}) cannot exceed --result-cap (${resultCap.value}).` };
  }
  if (pageSize.value > resultBudget.value) {
    return { error: `--result-budget (${resultBudget.value}) is smaller than one page (--page-size=${pageSize.value}).` };
  }
  const cacheArg = argv.find((a) => a.startsWith('--cache-dir='));
  if (cacheArg !== undefined && !cacheArg.slice('--cache-dir='.length).trim()) {
    return { error: '--cache-dir takes a directory path (see THE CACHE).' };
  }
  return {
    cacheDir: cacheArg ? path.resolve(cacheArg.slice('--cache-dir='.length).trim()) : null,
    commit: argv.includes('--commit'),
    allTypes: argv.includes('--all-types'),
    askPlaceId: !argv.includes('--no-place-id'),
    newOnly: argv.includes('--new-only'),
    cities,
    days,
    tileKm: tileKm.value,
    radiusKm: radiusKm.value,
    resultCap: resultCap.value,
    pageSize: pageSize.value,
    maxRequests: maxRequests.value,
    resultBudget: resultBudget.value,
  };
}

// ---------------------------------------------------------------------------
// Tiles. A tile is { s, w, n, e } in integer thousandths of a degree.
// ---------------------------------------------------------------------------
const kmPerDegLng = (lat) => KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// The distance from a city's centroid to the nearest point of the box.
function kmToTile(tile, key) {
  const c = CENTROIDS[key];
  const lat = Math.min(Math.max(c.lat, tile.s / 1000), tile.n / 1000);
  const lon = Math.min(Math.max(c.lon, tile.w / 1000), tile.e / 1000);
  return kmBetween(c.lat, c.lon, lat, lon);
}

// True when any point of the box is within radiusKm of a centroid of `cities`.
function tileIntersects(tile, cities, radiusKm = DEFAULT_RADIUS_KM) {
  return cities.some((key) => kmToTile(tile, key) <= radiusKm);
}

// One grid for each set of cities whose centroids lie within MAX_KM of one
// another (see EVERY TRAINING CITY), in the order the cities were asked for.
function gridGroups(cities) {
  const groups = [];
  for (const key of cities) {
    const c = CENTROIDS[key];
    const near = groups.filter((g) => g.some((k) => kmBetween(c.lat, c.lon, CENTROIDS[k].lat, CENTROIDS[k].lon) <= MAX_KM));
    const merged = [...near.flat(), key];
    for (const g of near) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups.map((g) => cities.filter((k) => g.includes(k)))
    .sort((a, b) => cities.indexOf(a[0]) - cities.indexOf(b[0]));
}

// The run's first-pass boxes, city by city in the order asked, each box on
// its grid's own order: [{ city, area, tile }], where `area` is the grid's
// cities (a split keeps the quarters that touch any of them, as it always
// has) and `city` the nearest of them, which the box's requests and results
// are counted against. Pure, so a run's size can be read off it without a
// request; the run prints that sizing before its first one.
function planTiles(cities, tileKm, radiusKm = DEFAULT_RADIUS_KM) {
  const out = [];
  for (const area of gridGroups(cities)) {
    for (const tile of buildTiles(area, tileKm, radiusKm)) {
      let city = area[0];
      for (const key of area) if (kmToTile(tile, key) < kmToTile(tile, city)) city = key;
      out.push({ city, area, tile });
    }
  }
  return cities.flatMap((key) => out.filter((p) => p.city === key));
}

function buildTiles(cities, tileKm, radiusKm = DEFAULT_RADIUS_KM) {
  let s = Infinity; let n = -Infinity; let w = Infinity; let e = -Infinity;
  for (const key of cities) {
    const c = CENTROIDS[key];
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

// Every one of the week's 168 cells held.
const wholeWeek = (week) => week.length === WEEK_HOURS && week.every((v) => v >= 0);

// How far a stored week sits from itself a whole number of days on, at the
// closest such rotation (MAE over the cells both hold): how well the venue can
// tell its days apart. null when no such rotation shares a cell (a week held
// on one day only cannot tell days apart either).
function dayContrast(stored) {
  let least = Infinity;
  for (let d = 24; d < WEEK_HOURS; d += 24) {
    let n = 0;
    let abs = 0;
    for (let i = 0; i < WEEK_HOURS; i++) {
      const a = stored[i];
      const b = stored[(i + d) % WEEK_HOURS];
      if (a < 0 || b < 0) continue;
      n++;
      abs += Math.abs(a - b);
    }
    if (n > 0) least = Math.min(least, abs / n);
  }
  return least === Infinity ? null : least;
}

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
  let hourAligned = 0;
  let dayInformative = 0;
  let dayAligned = 0;
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
    let mae0 = null;
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
      if (k === 0) mae0 = mae;
      if (mae < bestMae - 1e-9) { bestMae = mae; bestAt = [k]; } else if (Math.abs(mae - bestMae) <= 1e-9) bestAt.push(k);
    }
    // A venue whose minimum is shared by two rotations votes for neither.
    if (bestAt.length === 1) venueBest[bestAt[0]]++; else tied++;
    // The hour and the day (see AXIS_NEW_ONLY_MIN_VENUE_SHARE).
    const wholeDays = bestAt.length > 0 && bestAt.every((k) => k % 24 === 0);
    if (wholeDays) hourAligned++;
    const contrast = wholeWeek(planned) && wholeWeek(stored) ? dayContrast(stored) : null;
    if (contrast !== null && contrast >= AXIS_DAY_CONTRAST_MIN - 1e-9) {
      dayInformative++;
      if (wholeDays && mae0 !== null && mae0 - bestMae <= AXIS_DAY_TIE_MAE + 1e-9) dayAligned++;
    }
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
  return {
    venues, tied, hourAligned, dayInformative, dayAligned, thin, flat, table, bestShift: best ? best.shift : null,
  };
}

const AXIS_RULE_WITHIN5 = 'the within-five rule, because this commit would refresh known venues\' rows';
const AXIS_RULE_NEW_ONLY = 'the --new-only hour-origin rule, because nothing known is written and only the new venues\' '
  + 'hour origin is in question (within five points is reported, not required)';

// The --commit gate. Returns { pass, reason, rule }; `newOnly` picks the rule
// (see AXIS_NEW_ONLY_MIN_VENUE_SHARE).
function axisVerdict(proof, { newOnly = false } = {}) {
  const rule = newOnly ? AXIS_RULE_NEW_ONLY : AXIS_RULE_WITHIN5;
  const refuse = (reason) => ({ pass: false, reason, rule });
  const at0 = proof.table.find((r) => r.shift === 0);
  if (proof.venues < AXIS_MIN_VENUES) {
    return refuse(`only ${proof.venues} known venues could be compared (at least ${AXIS_MIN_VENUES} are needed to prove the axis)`);
  }
  if (proof.bestShift !== 0) {
    return refuse(`the curves agree best with the stored rows at a rotation of ${proof.bestShift > 0 ? '+' : ''}${proof.bestShift} hours, not 0`);
  }
  const share = at0.venuesBestHere / proof.venues;
  if (newOnly) {
    if (![proof.hourAligned, proof.dayInformative, proof.dayAligned].every((x) => typeof x === 'number')) {
      return refuse('the proof did not count venues by hour and by day');
    }
    const needed = `(at least ${pct(AXIS_NEW_ONLY_MIN_VENUE_SHARE)} needed)`;
    const byHour = proof.hourAligned / proof.venues;
    const hourFit = `${proof.hourAligned} of ${proof.venues} venues (${pct(byHour)}) fit best at rotation 0 or a whole `
      + `number of days from it (${at0.venuesBestHere} at 0 itself)`;
    if (byHour < AXIS_NEW_ONLY_MIN_VENUE_SHARE) return refuse(`by hour, only ${hourFit} ${needed}`);
    const daysApart = `whole weeks on both sides whose days differ by at least ${AXIS_DAY_CONTRAST_MIN} points`;
    if (proof.dayInformative < AXIS_MIN_VENUES) {
      return refuse(`only ${proof.dayInformative} compared venues hold ${daysApart} `
        + `(at least ${AXIS_MIN_VENUES} are needed to prove the day)`);
    }
    // Over every compared venue: one that cannot vote counts against the day,
    // so non-voters and voters a day off share one allowance.
    const byDay = proof.dayAligned / proof.venues;
    const dayFit = `${proof.dayAligned} of ${proof.venues} venues (${pct(byDay)}) hold ${daysApart} and fit rotation 0 `
      + `within ${AXIS_DAY_TIE_MAE} point of their best whole-day rotation (${proof.dayInformative} could vote)`;
    if (byDay < AXIS_NEW_ONLY_MIN_VENUE_SHARE) return refuse(`by day, only ${dayFit} ${needed}`);
    const fit = `by hour, ${hourFit}; by day, ${dayFit}`;
    if (typeof at0.r !== 'number') return refuse('rotation 0 has no correlation to judge');
    let next = null;
    for (const row of proof.table) {
      if (row.shift !== 0 && typeof row.r === 'number' && (next === null || row.r > next.r)) next = row;
    }
    const sign = (k) => `${k > 0 ? '+' : ''}${k}`;
    if (next !== null && at0.r - next.r < AXIS_NEW_ONLY_MIN_R_MARGIN - 1e-9) {
      return refuse(`r ${at0.r.toFixed(3)} is only ${(at0.r - next.r).toFixed(3)} above rotation ${sign(next.shift)}'s `
        + `(${next.r.toFixed(3)}); at least ${AXIS_NEW_ONLY_MIN_R_MARGIN} needed`);
    }
    return {
      pass: true,
      rule,
      reason: `best rotation 0; ${fit}; r ${at0.r.toFixed(3)} is `
        + (next === null ? 'the only one' : `${(at0.r - next.r).toFixed(3)} above the next rotation's (${sign(next.shift)}, ${next.r.toFixed(3)})`)
        + `; ${pct(at0.within5)} of cells within five points`,
    };
  }
  if (at0.within5 < AXIS_MIN_WITHIN5) {
    return refuse(`at rotation 0 only ${pct(at0.within5)} of cells are within five points (at least ${pct(AXIS_MIN_WITHIN5)} needed)`);
  }
  if (share < AXIS_MIN_VENUE_SHARE) {
    return refuse(`only ${pct(share)} of compared venues agree best at rotation 0 (at least ${pct(AXIS_MIN_VENUE_SHARE)} needed)`);
  }
  return {
    pass: true,
    rule,
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

// The city a listing appends, outside PA ("The Ivy London", "Joe Bar Buenos
// Aires"): the venue's own city only, as config.js names it, its CITIES key,
// and the few other forms below. Removed as whole words, a multi-word name
// only as the whole phrase ("Buenos Aires", never a lone "Aires"). The key
// "la" is not one of them: it is the article in "La Colombe", a word of the
// name, and "Los Angeles" is.
const CITY_NAME_FORMS = Object.freeze({
  nyc: ['New York', 'NY'],
  mexico: ['CDMX'],
  delhi: ['New Delhi'],
  seoul: ['서울'],
  dubai: ['دبي'],
});
const CITY_KEYS_THAT_ARE_WORDS = new Set(['la']);
const cityPhraseCache = new Map();

// Unicode words: NFKD with the Latin accents dropped ("Café" is "cafe"), then
// NFKC so Hangul syllables come back whole, lower case, and split on anything
// that is not a letter, a mark or a digit. Marks stay because they are letters'
// parts outside Latin: a Thai vowel or tone mark, a Devanagari vowel sign.
function nameTokens(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFKC').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

function cityPhrases(cityKey) {
  if (!cityKey) return [];
  if (!cityPhraseCache.has(cityKey)) {
    const forms = [...(CITY_NAME_FORMS[cityKey] || [])];
    if (CITIES[cityKey] && CITIES[cityKey].name) forms.push(CITIES[cityKey].name);
    if (!CITY_KEYS_THAT_ARE_WORDS.has(cityKey)) forms.push(cityKey);
    const phrases = forms.map(nameTokens).filter((p) => p.length > 0);
    // Longest first, so "New York City" goes before "New York" can split it.
    cityPhraseCache.set(cityKey, phrases.sort((p, q) => q.length - p.length));
  }
  return cityPhraseCache.get(cityKey);
}

function withoutPhrases(tokens, phrases) {
  let out = tokens;
  for (const phrase of phrases) {
    const kept = [];
    for (let i = 0; i < out.length;) {
      if (i + phrase.length <= out.length && phrase.every((t, j) => out[i + j] === t)) { i += phrase.length; continue; }
      kept.push(out[i]);
      i++;
    }
    out = kept;
  }
  return out;
}

// `cityKey` is the CITIES key of the city the venue was placed in; without it
// only the PA words above are removed. `full` keeps every word.
function nameKey(name, cityKey = null, { full = false } = {}) {
  const tokens = nameTokens(name);
  if (full) return tokens.join('');
  return withoutPhrases(tokens, cityPhrases(cityKey)).filter((t) => !NAME_STOPWORDS.has(t)).join('');
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
// is a word, not a name. Names in any script are compared (nameTokens): the
// same Hangul, Thai or Arabic name is the same name. `cityKey`: see nameKey.
function namesSimilar(a, b, cityKey = null) {
  const x = nameKey(a, cityKey);
  const y = nameKey(b, cityKey);
  if (x && x === y) return true;
  if (!x || !y) {
    // A name that is nothing but those words ("The London", "Philly"): only
    // the same whole name is the same name.
    const fx = nameKey(a, null, { full: true });
    return fx !== '' && fx === nameKey(b, null, { full: true });
  }
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

// Not an abort: the run keeps every week already whole and writes it.
function budgetStop(message) {
  const err = new Error(message);
  err.budgetStop = true;
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

// ---------------------------------------------------------------------------
// THE CACHE (--cache-dir). Every answer the filter gives, so a run that is
// refused or aborted after it fetched does not have to buy those results
// again. One file per question: <sha256 of the URL without the key>.json,
// holding { url (without the key), fetchedAt, data (the parsed answer) }, with
// any copy of either key in the answer replaced by [withheld] before it is
// written. A question already in the directory is answered from it: no request,
// no pacing, nothing counted against --result-budget or --max-requests, and the
// summary counts it apart. Asked after the admission guard has approved the
// URL, so the guard sees every question either way. Entries never expire, and
// BestTime's stored forecasts change and are deleted after 31 days: a cache is
// for re-running the same scope soon after, so give each new month's run a
// fresh directory. Without --cache-dir nothing is read or written.
// ---------------------------------------------------------------------------
function cacheKeyUrl(url) {
  const u = new URL(url);
  u.searchParams.delete('api_key_private');
  u.searchParams.delete('api_key_public');
  return u.toString();
}

const cacheFile = (dir, keyless) => path.join(dir, `${crypto.createHash('sha256').update(keyless).digest('hex')}.json`);

function readCache(dir, keyless) {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(cacheFile(dir, keyless), 'utf8'));
  } catch {
    return null; // absent, or cut short by a crash mid-write: asked again
  }
  return entry && entry.url === keyless && entry.data && typeof entry.data === 'object' ? entry.data : null;
}

function writeCache(ctx, keyless, data) {
  let text = JSON.stringify({ url: keyless, fetchedAt: new Date().toISOString(), data });
  for (const secret of ctx.secrets) text = text.split(secret).join('[withheld]');
  const file = cacheFile(ctx.opts.cacheDir, keyless);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    ctx.stats.cacheWrites++;
  } catch (err) {
    // A cache that cannot be written costs the next run, not this one.
    const code = besttime.errorCode(err);
    if (ctx.stats.cacheWriteFailures++ === 0) {
      console.warn(`${TAG} WARNING: could not write to --cache-dir (${code}); the run goes on uncached.`);
    }
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
  }
}

// What a filter answer says: { venues, total, credits }, or an abort.
function readFilterAnswer(data) {
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

// What the result budget has spent: the results counted from answers, and a
// page held for every request that may have been billed without one.
const budgetUsed = (s) => s.venuesReturned + s.resultsReserved;

// A failure that shows the request never left this machine (a refused
// connection, a name that did not resolve, a connection never made in time):
// BestTime cannot have billed it. Any other failure once the request was made
// (our deadline passing, a connection dropped mid-answer, an answer that was
// not JSON) may have been served and billed.
// A refused connection, a name that did not resolve and a connect timeout can
// only happen before the request is sent. A network or host that is
// unreachable or down can also cut an answer already being read, so it counts
// as never sent only when the failing call was the connect itself.
const NEVER_SENT_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/;
const CONNECT_ONLY_RE = /ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN/;
function neverSent(err, code) {
  const said = `${code} ${String((err && err.message) || '')}`;
  if (NEVER_SENT_RE.test(said)) return true;
  const cause = (err && err.cause) || {};
  return CONNECT_ONLY_RE.test(`${said} ${cause.code || ''}`) && cause.syscall === 'connect';
}

// A request that may have been billed without an answer being read holds a
// whole page against the budget, and the hold is never released: the retry
// that succeeds is counted beside it (THE RESULT BUDGET).
function reservePage(ctx) {
  ctx.stats.resultsReserved += ctx.opts.pageSize;
  return `${ctx.opts.pageSize} results reserved against the budget (${ctx.stats.resultsReserved} in all)`;
}

// One page. Retries what BestTime asks to be retried, throws an abort for
// everything else. Never prints the URL or a fetch error's message: the URL
// carries the private key. With --cache-dir, a question already answered is
// answered from the cache (THE CACHE), after the guard and before the network.
async function requestPage(ctx, q) {
  const url = buildFilterUrl(ctx.key, q, ctx.opts);
  assertAllowedRequest(url, 'GET');
  const keyless = ctx.opts.cacheDir ? cacheKeyUrl(url) : null;
  if (keyless) {
    const cached = readCache(ctx.opts.cacheDir, keyless);
    if (cached) {
      const answer = readFilterAnswer(cached);
      ctx.stats.cachedPages++;
      if (ctx.city) ctx.city.cachedPages++;
      return { ...answer, cached: true };
    }
  }
  for (let attempt = 0; ; attempt++) {
    // A page holds at most --page-size venues, so this is the last moment the
    // budget can be kept rather than passed (THE RESULT BUDGET). Asked again
    // before every retry, with the pages earlier attempts may have been billed
    // for already held.
    const used = budgetUsed(ctx.stats);
    if (used + ctx.opts.pageSize > ctx.opts.resultBudget) {
      throw budgetStop(`the next page could take the run past --result-budget=${ctx.opts.resultBudget} `
        + `(${used} results used: ${ctx.stats.venuesReturned} counted from answers, ${ctx.stats.resultsReserved} reserved).`);
    }
    if (ctx.stats.requests >= ctx.opts.maxRequests) {
      throw abortError(`REFUSED: the request ceiling (--max-requests=${ctx.opts.maxRequests}) was reached. `
        + 'Raise it on purpose, or narrow the run with --city= or --days=.');
    }
    await ctx.pace();
    ctx.stats.requests++;
    if (ctx.city) ctx.city.requests++;
    let response;
    let data;
    try {
      // redirect: 'manual', because assertAllowedRequest approved THIS address;
      // a followed redirect is a request the guard never saw, and could be one
      // that spends an admission.
      ({ response, data } = await fetchJsonWithTimeout(url, { method: 'GET', redirect: 'manual' }, REQUEST_TIMEOUT_MS));
    } catch (err) {
      if (err && err.admissionRefused) throw err;
      const code = besttime.errorCode(err);
      if (!NETWORK_ERR_RE.test(String((err && err.message) || '')) && !(err instanceof SyntaxError)
        && !(err && err.notJson)) {
        throw abortError(`the venue filter request failed (${code}).`);
      }
      // Tested, never printed: the message can carry the URL.
      const held = neverSent(err, code) ? 'never sent, nothing reserved' : reservePage(ctx);
      if (attempt >= RETRY_WAITS_MS.length) throw abortError(`the venue filter kept failing (${code}); stopping.`);
      console.warn(`  network error (${code}); ${held}; retry ${attempt + 1}/${RETRY_WAITS_MS.length} in ${RETRY_WAITS_MS[attempt] / 1000}s`);
      await ctx.sleep(RETRY_WAITS_MS[attempt]);
      continue;
    }
    if (!response.ok) {
      const status = response.status;
      if (status >= 300 && status < 400) {
        throw abortError(`HTTP ${status} from the venue filter: a redirect, which is not followed. The admission guard approved only the address asked for.`);
      }
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
        // A 5xx came from a server that had the request and may have served
        // and billed it before failing; a 429 is BestTime declining to serve it.
        const held = status >= 500 ? reservePage(ctx) : 'throttled, nothing reserved';
        if (attempt >= RETRY_WAITS_MS.length) throw abortError(`HTTP ${status} from the venue filter after ${attempt + 1} tries; BestTime is not letting us in.`);
        const wait = status === 429 || status === 503 ? THROTTLE_WAIT_MS : RETRY_WAITS_MS[attempt];
        console.warn(`  HTTP ${status}; ${held}; retry ${attempt + 1}/${RETRY_WAITS_MS.length} in ${wait / 1000}s`);
        await ctx.sleep(wait);
        continue;
      }
      throw abortError(`HTTP ${status} from the venue filter: BestTime rejected the request parameters. `
        + 'The place_id flag and the types list are the two not yet confirmed against a live answer: '
        + '--no-place-id drops the first (refresh only, no new venues), --all-types the second.');
    }
    const answer = readFilterAnswer(data);
    if (keyless) writeCache(ctx, keyless, data);
    return { ...answer, cached: false };
  }
}

// Every record naming a day other than the one asked, counted for the run as
// its page arrives, before the next request can be stopped by the budget. The
// refusal in harvestDay comes only once its call has asked every box, and a
// budget stop in between (a later page, a split box's quarter, or the other
// days a leaf asks) skips it; checkMarketDays, which every run passes through
// on its way to the commit, budget stop or not, refuses on this count.
function noteOtherDays(ctx, day, records) {
  let n = 0;
  for (const raw of records) {
    const v = readFilterVenue(raw);
    if (v && v.dayInt !== null && v.dayInt !== day) n++;
  }
  if (n === 0) return;
  ctx.stats.otherDay += n;
  ctx.otherDays.set(day, (ctx.otherDays.get(day) || 0) + n);
}

// Pages one box for one day, up to the cap.
async function fetchTile(ctx, tile, day) {
  // A box that cannot be split any further is paged to the cap even when page
  // one already reports a total past it: stopping early to split is only worth
  // it when there is a split to make, and otherwise throws away pages that
  // could still be read.
  const splittable = splitTile(tile) !== null;
  const venues = [];
  let saturated = false;
  let pages = 0;
  for (let page = 0; ; page++) {
    const res = await requestPage(ctx, { tile, day, page });
    noteOtherDays(ctx, day, res.venues);
    pages++;
    const n = res.venues.length;
    if (res.cached) {
      // Bought by an earlier run: not billed now, and not this run's budget.
      ctx.stats.cachedResults += n;
      if (ctx.city) ctx.city.cachedResults += n;
    } else {
      ctx.stats.venuesReturned += n;
      if (res.credits !== null) ctx.stats.creditsReported += res.credits;
      // BestTime bills about one query credit per ten venues returned.
      ctx.stats.creditsEstimated += Math.max(1, Math.ceil(n / 10));
      if (ctx.city) {
        ctx.city.results += n;
        ctx.city.credits += Math.max(1, Math.ceil(n / 10));
      }
    }
    venues.push(...res.venues);
    // venues_n is documented as "the total number of found venues", and the
    // documentation's own example has it equal to the page. It is read as the
    // box total only when it is larger than the page it came with; otherwise
    // it says nothing the page length does not, and the short page decides.
    const total = res.total !== null && res.total > n ? res.total : null;
    if (venues.length >= ctx.opts.resultCap || (splittable && total !== null && total >= ctx.opts.resultCap)) {
      saturated = true;
      break;
    }
    if (n < ctx.opts.pageSize) break;
    if (total !== null && venues.length >= total) break;
  }
  return { venues, saturated, pages };
}

// One weekday across the tiles. Returns the leaves (boxes that answered under
// the cap, or could not be split further) so later days start from them. With
// onLeaf, each leaf is handed over with its own answers the moment it is
// found, and the queue waits while onLeaf asks the leaf's other days: the
// leaf-first order of THE RESULT BUDGET. The mismatch check below judges each
// call, since one record for another day is enough to refuse. A venue with no
// day_int is skipped and counted here, and whether a day said nothing it could
// verify is judged over the whole market-day (checkMarketDays), never per call:
// a sparse leaf whose only venue carries no day_int is not a reason to stop.
async function harvestDay(ctx, tiles, day, onLeaf = null) {
  const queue = tiles.slice();
  const leaves = [];
  const byVenue = new Map();
  let mismatched = 0;
  let unverifiable = 0;
  while (queue.length > 0) {
    const tile = queue.shift();
    const res = await fetchTile(ctx, tile, day);
    const own = new Map();
    for (const raw of res.venues) {
      const v = readFilterVenue(raw);
      if (!v) { ctx.stats.malformed++; continue; }
      if (v.dayInt === null) { unverifiable++; tallyDay(ctx, day, 0, 1); continue; }
      if (v.dayInt !== day) { mismatched++; continue; }
      tallyDay(ctx, day, 1, 0);
      if (!own.has(v.venueId)) own.set(v.venueId, v);
      if (!byVenue.has(v.venueId)) byVenue.set(v.venueId, v);
    }
    if (res.saturated) {
      const kids = splitTile(tile);
      const area = ctx.area || ctx.opts.cities;
      const inside = kids ? kids.filter((k) => tileIntersects(k, area, ctx.opts.radiusKm)) : null;
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
    if (onLeaf) await onLeaf(tile, own);
  }
  // A record for another day is the filter ignoring day_int, and writing it
  // would file one weekday's curve under another. Refuse the whole day.
  if (mismatched > 0) {
    throw abortError(`BestTime answered ${mismatched} venues for a different day than ${BT_DAY_NAMES[day]} (day_int=${day}). `
      + 'The day parameter is not being honoured; nothing from this run is written.');
  }
  if (unverifiable > 0) ctx.stats.unverifiable += unverifiable;
  return { leaves, byVenue };
}

// One market-day's records, every box and leaf of the city in progress for
// one weekday: those that named the day asked for, and those that named none.
function tallyDay(ctx, day, verified, unverifiable) {
  if (!ctx.dayTally) ctx.dayTally = new Map();
  const t = ctx.dayTally.get(day) || { verified: 0, unverifiable: 0 };
  t.verified += verified;
  t.unverifiable += unverifiable;
  ctx.dayTally.set(day, t);
}

// The day_int check as it stood before the harvest went leaf first: a weekday
// on which the whole market answered venues and not one said which day it was
// for refuses the run, since nothing shows the day was honoured. Judged when
// a city's boxes are all asked (or the budget stops it), then cleared for the
// next city. First, any record this run has seen naming another day than the
// one asked refuses it (noteOtherDays), whatever stopped the harvest.
function checkMarketDays(ctx, city) {
  if (ctx.stats.otherDay > 0) {
    const asked = [...ctx.otherDays.entries()].sort((a, b) => a[0] - b[0])
      .map(([day, n]) => `${n} when ${BT_DAY_NAMES[day]} was asked`).join(', ');
    throw abortError(`BestTime answered ${ctx.stats.otherDay} venues for a different day than the one asked (${asked}). `
      + 'The day parameter is not being honoured; nothing from this run is written.');
  }
  const tally = ctx.dayTally || new Map();
  ctx.dayTally = new Map();
  for (const [day, t] of [...tally.entries()].sort((a, b) => a[0] - b[0])) {
    if (t.unverifiable > 0 && t.verified === 0) {
      throw abortError(`none of the ${t.unverifiable} venues for ${BT_DAY_NAMES[day]} in ${city} said which day they are for; `
        + 'nothing is written.');
    }
  }
}

// The run's venues, one answer per (venue, day): the first to arrive, as the
// day-by-day order kept the first box's.
function mergeDay(ctx, venues, day, answers) {
  for (const v of answers.values()) {
    let merged = venues.get(v.venueId);
    if (!merged) {
      merged = { ...v, days: new Map(), altDays: new Map(), answered: new Set() };
      delete merged.hours;
      delete merged.hoursAlt;
      delete merged.curveField;
      delete merged.dayInt;
      venues.set(v.venueId, merged);
    }
    if (merged.answered.has(day)) continue;
    merged.answered.add(day);
    if (!merged.placeId && v.placeId) merged.placeId = v.placeId;
    if (!merged.rawPlaceId && v.rawPlaceId) merged.rawPlaceId = v.rawPlaceId;
    if (v.hours) merged.days.set(day, v.hours); else ctx.stats.malformed++;
    if (v.curveField === 'day_raw_whole') ctx.stats.fromWhole++;
    if (v.hours && v.hoursAlt) {
      merged.altDays.set(day, v.hoursAlt);
      if (v.hoursAlt.every((x, s) => x === v.hours[s])) ctx.stats.fieldsIdentical++; else ctx.stats.fieldsDiffer++;
    } else if (v.hours) ctx.stats.fieldAltAbsent++;
  }
}

// One first-pass box, leaf first (THE RESULT BUDGET). The first day asked
// finds the box's leaves; each leaf asks the other days before the next leaf
// is looked for, and its answers reach `venues` only once its last day is in.
// The box's own first-day answers (a split box's, which its leaves repeat, and
// a corner no kept quarter covers) follow once every leaf is in. A budget stop
// thrown anywhere in here leaves `venues` holding whole leaves only.
async function harvestBox(ctx, tile, venues) {
  const [first, ...rest] = ctx.opts.days;
  const { byVenue } = await harvestDay(ctx, [tile], first, async (leaf, own) => {
    const week = [[first, own]];
    let current = [leaf];
    for (const day of rest) {
      const res = await harvestDay(ctx, current, day);
      current = res.leaves;
      week.push([day, res.byVenue]);
    }
    ctx.city.leaves += current.length;
    for (const [day, answers] of week) mergeDay(ctx, venues, day, answers);
  });
  mergeDay(ctx, venues, first, byVenue);
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

// The centroids a venue outside PA is placed among: the cities asked for and
// the refused ones. Philly and lehigh are left to nearestPaCity, which
// placeVenue asks first.
function otherMarkets(cities) {
  const keys = new Set([...cities, ...Object.keys(REFUSED_CITIES)].filter((k) => !PA_CITIES[k] && CENTROIDS[k]));
  return Object.fromEntries([...keys].map((k) => [k, CENTROIDS[k]]));
}

// WHERE A VENUE BELONGS (see the header): { cityKey, km }, cityKey null when
// no market is within MAX_KM. `markets` is otherMarkets(cities).
function placeVenue(lat, lng, markets) {
  const pa = nearestPaCity(lat, lng);
  if (pa.cityKey) return pa;
  const other = nearestMarket(lat, lng, markets);
  return other.cityKey ? other : { cityKey: null, km: Math.min(pa.km, other.km) };
}

// Decides, for every harvested venue, which row its week belongs to, or why it
// is skipped. Pure: the tests drive it without a database. `identities.nearby`
// is every ml_venues row around the harvest (loadNearbyRows); without it rule 4
// finds nothing. `placed` counts the venues placed in each city asked for.
// `categoryOf` names a new venue's category, undefined to skip it as
// unmappedType; by default its BestTime type through TYPE_TO_CATEGORY, the
// only rule this script uses.
function planVenues(venues, identities, cities, {
  radiusKm = DEFAULT_RADIUS_KM,
  categoryOf = (v) => (v.type ? TYPE_TO_CATEGORY[v.type] : undefined),
} = {}) {
  const plan = [];
  const skipped = {
    outsideMarkets: 0, otherMarket: 0, outsideRadius: 0, noPlaceId: 0, unusablePlaceId: 0,
    placeHeldByOtherBtId: 0, placeClaimedTwice: 0, nearDupHeldByOtherBtId: 0, nearDupClaimed: 0,
    nearDuplicateInRun: 0, unmappedType: 0, noName: 0, noSignal: 0, noCoordinates: 0,
  };
  const claimedPlaces = new Map(); // place id -> BestTime id that took it this run
  const claimedRows = new Set();
  const nearRows = nearIndex(identities.nearby || []);
  const markets = otherMarkets(cities);
  const placed = new Map();
  const rest = [];
  // Pass one: placement, and every venue this corpus already holds by its
  // BestTime id. Done first so the answer does not depend on the order
  // BestTime listed the venues in.
  for (const v of venues) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) { skipped.noCoordinates++; continue; }
    const where = placeVenue(v.lat, v.lng, markets);
    if (!where.cityKey) { skipped.outsideMarkets++; continue; }
    if (!cities.includes(where.cityKey)) { skipped.otherMarket++; continue; }
    placed.set(where.cityKey, (placed.get(where.cityKey) || 0) + 1);
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
  // Every exact Google place id match claims its row BEFORE any near-duplicate
  // is considered. In one pass, a similar name 40 m away with a lower BestTime
  // id ("Cafe Lift Annex") took the row first, the venue whose place id WAS
  // that row ("Cafe Lift") was skipped as placeClaimedTwice, and the Annex's
  // curves were filed under Cafe Lift. The first philly commit (2026-09-28)
  // reported one placeClaimedTwice beside one near-duplicate filing.
  const unresolved = [];
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
    unresolved.push({ v, where });
  }
  const newGrid = new Map(); // new venues accepted so far, by ~110 m cell
  for (const { v, where } of unresolved) {
    // A second listing of the same place id, neither one known: the first
    // (lower BestTime id) holds it.
    const claimedBy = claimedPlaces.get(v.placeId);
    if (claimedBy && claimedBy !== v.venueId) { skipped.placeClaimedTwice++; continue; }
    // Rule 4: the nearest row close enough with a similar name.
    const near = nearRows(v.lat, v.lng).find((c) => namesSimilar(v.name, c.row.name, where.cityKey));
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
    const category = categoryOf(v);
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
          kmBetween(v.lat, v.lng, o.lat, o.lng) * 1000 <= NEAR_DUP_METERS && namesSimilar(v.name, o.name, where.cityKey)));
      }
    }
    if (twin) { skipped.nearDuplicateInRun++; continue; }
    if (!newGrid.has(`${gx}_${gy}`)) newGrid.set(`${gx}_${gy}`, []);
    newGrid.get(`${gx}_${gy}`).push(v);
    claimedPlaces.set(v.placeId, v.venueId);
    plan.push({ kind: 'new', venue: v, row: null, city: where.cityKey, category });
  }
  return { plan, skipped, placed };
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
      // And the near-duplicate rule, asked again too: a row another writer
      // added since the plan under a different Google listing of the same
      // place (same name, a few metres off) holds no id this one could match.
      // A box of about 45 m either way, then the planner's own distance and
      // name test.
      const dLat = 0.0004;
      const dLng = 0.0004 / Math.max(0.2, Math.cos((v.lat * Math.PI) / 180));
      const { rows: around } = await client.query(
        `SELECT id, name, latitude, longitude FROM ml_venues
          WHERE latitude BETWEEN $1 AND $2 AND longitude BETWEEN $3 AND $4`,
        [v.lat - dLat, v.lat + dLat, v.lng - dLng, v.lng + dLng]
      );
      if (around.some((r) => kmBetween(v.lat, v.lng, Number(r.latitude), Number(r.longitude)) * 1000 <= NEAR_DUP_METERS
        && namesSimilar(v.name, r.name, item.city))) {
        return { status: 'claimed' };
      }
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
          item.category, v.rating, v.reviews, CENTROIDS[item.city].tz, HARVEST_STATUS,
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
    // THE RESULT BUDGET: a page held for each request that may have been
    // billed without an answer, beside venuesReturned, counted from answers.
    resultsReserved: 0,
    splits: 0, truncatedTiles: 0, malformed: 0, unverifiable: 0,
    // Records naming a day other than the one asked, counted as each page
    // arrives (checkMarketDays refuses the run on any).
    otherDay: 0,
    // THE CACHE: pages answered from it and their results, and pages written.
    cachedPages: 0, cachedResults: 0, cacheWrites: 0, cacheWriteFailures: 0,
    // Which field each venue-day's curve came from, and how the other compared.
    fromWhole: 0, fieldsIdentical: 0, fieldsDiffer: 0, fieldAltAbsent: 0,
  };
}

// One city's line of the BY CITY table. `state`: planned, done, stopped (the
// result budget ended the run inside it) or not reached.
function emptyCityStats(tiles) {
  return {
    state: 'planned', tiles, leaves: 0, requests: 0, results: 0, credits: 0, venues: 0,
    cachedPages: 0, cachedResults: 0,
    newPlanned: 0, knownPlanned: 0, knownSkipped: 0, rowsPlanned: 0,
    newWritten: 0, knownWritten: 0, rowsWritten: 0,
  };
}

const duration = (requests) => {
  const min = Math.ceil((requests * START_INTERVAL_MS) / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

function formatCityTable(summary, opts) {
  const head = ['city', 'tiles', 'requests', 'results', 'venues', 'new', 'known', 'known skipped', 'weekly rows'];
  const pick = (c) => (opts.commit ? [c.newWritten, c.knownWritten, c.knownSkipped, c.rowsWritten]
    : [c.newPlanned, c.knownPlanned, c.knownSkipped, c.rowsPlanned]);
  const rows = opts.cities.map((city) => {
    const c = summary.byCity[city];
    const label = c.state === 'stopped' || c.state === 'not reached' ? `${city} (${c.state})` : city;
    return [label, c.tiles, c.requests, c.results, c.venues, ...pick(c)];
  });
  if (rows.length > 1) rows.push(['all', ...rows.reduce((sum, r) => sum.map((x, i) => x + r[i + 1]), new Array(8).fill(0))]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => `  ${String(r[0]).padEnd(width[0])}${r.slice(1).map((x, i) => `  ${String(x).padStart(width[i + 1])}`).join('')}`;
  return [line(head), ...rows.map(line)];
}

// Cached against fetched, for a run with --cache-dir (THE CACHE).
function logCache(opts, s) {
  console.log(`${TAG} CACHE: answered ${s.cachedPages} filter pages from the cache (${s.cachedResults} results, not billed `
    + `and not counted against the budget); fetched ${s.requests} (${s.venuesReturned} results) and wrote ${s.cacheWrites} `
    + `new answers to ${opts.cacheDir}${s.cacheWriteFailures ? ` (${s.cacheWriteFailures} could not be written)` : ''}. `
    + 'A rerun of the same scope with this --cache-dir buys none of them again.');
}

async function harvest({ argv = process.argv, pool, sleep = realSleep } = {}) {
  const summary = {
    exitCode: 1, aborted: false, abortReason: null, commit: false, newOnly: false,
    tiles: 0, leaves: 0, venuesFound: 0, plan: { known_bt: 0, known_place: 0, known_near: 0, new: 0 },
    skipped: null, rowsPlanned: 0, rowsWritten: 0, rowsInserted: 0, rowsRefreshed: 0,
    venuesInserted: 0, venuesWritten: 0, vanished: 0, claimed: 0, writeFailures: 0,
    incompleteWeeks: 0, knownSkipped: 0, stats: emptyStats(), byCity: {},
    budget: { limit: null, used: 0, reserved: 0, stopped: false, cutShort: null, unfinished: [] },
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
  summary.newOnly = opts.newOnly;
  summary.budget.limit = opts.resultBudget;
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
    + `within ${opts.radiusKm} km, cap ${opts.resultCap}, page ${opts.pageSize}, result budget ${opts.resultBudget}`
    + `${opts.newOnly ? ', NEW VENUES ONLY (nothing is written for a venue the corpus holds)' : ''}.`);
  if (opts.cacheDir) {
    // Made, and its holdings counted, before any request (THE CACHE).
    let held;
    try {
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      held = fs.readdirSync(opts.cacheDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length;
    } catch (err) {
      const reason = `--cache-dir could not be made or read (${besttime.errorCode(err)}).`;
      console.error(`${TAG} REFUSED: ${reason}`);
      summary.aborted = true;
      summary.abortReason = reason;
      return summary;
    }
    console.log(`${TAG} CACHE: ${opts.cacheDir} holds ${held} filter answers; a question already there is answered `
      + 'from it, with no request and nothing counted against the result budget, and every new answer is added.');
  }

  // The size of the run, before any request: each first-pass box is asked once
  // a day at least, and splits and pages only add to that.
  const tilePlan = planTiles(opts.cities, opts.tileKm, opts.radiusKm);
  summary.tiles = tilePlan.length;
  for (const city of opts.cities) summary.byCity[city] = emptyCityStats(tilePlan.filter((p) => p.city === city).length);
  const minRequests = tilePlan.length * opts.days.length;
  console.log(`${TAG} ${tilePlan.length} tiles of about ${opts.tileKm} km cover ${opts.cities.join(' + ')} `
    + `(within ${opts.radiusKm} km of each centroid). At least ${minRequests} requests, one every `
    + `${START_INTERVAL_MS / 1000}s: ${duration(minRequests)} at least. Query credits: about one per ten venues returned, `
    + `per day asked, and the run stops before its results could pass ${opts.resultBudget}. `
    + 'New-venue admissions: none; this script cannot call an endpoint that makes one.');
  if (opts.cities.length > 1) {
    for (const city of opts.cities) {
      const n = summary.byCity[city].tiles;
      console.log(`  ${city.padEnd(12)} ${String(n).padStart(3)} tiles, at least ${n * opts.days.length} requests`);
    }
  }
  if (minRequests > opts.maxRequests) {
    // Refused now, because reaching the ceiling later aborts and writes nothing.
    const reason = `--max-requests=${opts.maxRequests} is below the ${minRequests} requests this run needs at least. `
      + 'Raise it on purpose, or narrow the run with --city= or --days=.';
    console.error(`${TAG} REFUSED: ${reason}`);
    summary.aborted = true;
    summary.abortReason = reason;
    return summary;
  }

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

      const ctx = {
        key, opts, stats: summary.stats, sleep, pace: makePacer(sleep, START_INTERVAL_MS), city: null, area: null,
        dayTally: new Map(),
        // Asked day -> records that named another, for the whole run.
        otherDays: new Map(),
        // Never written into the cache (THE CACHE).
        secrets: [key, process.env.BESTTIME_API_KEY_PUBLIC].filter((x) => typeof x === 'string' && x.length > 0),
      };
      const s = ctx.stats;

      // venueId -> merged venue with a Map of BestTime day -> 24 slots, and the
      // other curve field's slots for the axis proof. Whole leaves only.
      const venues = new Map();
      let current = null;
      try {
        for (const city of opts.cities) {
          current = city;
          ctx.city = summary.byCity[city];
          for (const { area, tile } of tilePlan.filter((p) => p.city === city)) {
            ctx.area = area;
            await harvestBox(ctx, tile, venues);
          }
          checkMarketDays(ctx, city);
          ctx.city.state = 'done';
          console.log(`${TAG} ${city}: ${ctx.city.tiles} tiles (${ctx.city.leaves} leaves), ${ctx.city.requests} requests, `
            + `${ctx.city.results} results (~${ctx.city.credits} query credits)`
            + `${opts.cacheDir ? `, and ${ctx.city.cachedPages} pages (${ctx.city.cachedResults} results) from the cache` : ''}. `
            + `Run so far: ${budgetUsed(s)} of the ${opts.resultBudget}-result budget`
            + `${s.resultsReserved ? ` (${s.resultsReserved} of them reserved for requests that may have been billed without an answer)` : ''}.`);
        }
      } catch (err) {
        if (!err.budgetStop) throw err;
        summary.budget.stopped = true;
        summary.budget.cutShort = current;
        summary.budget.unfinished = opts.cities.slice(opts.cities.indexOf(current));
        summary.byCity[current].state = 'stopped';
        for (const city of summary.budget.unfinished.slice(1)) summary.byCity[city].state = 'not reached';
        console.log(`${TAG} RESULT BUDGET: stopped in ${current} with ${budgetUsed(s)} of ${opts.resultBudget} results `
          + `used (${s.venuesReturned} counted from answers, ${s.resultsReserved} reserved for requests that may have been `
          + 'billed without one); the next page could have passed --result-budget. The leaf in progress and its box were dropped '
          + 'whole, so no venue is written with part of the week this run asked for. '
          + `Unfinished: ${summary.budget.unfinished.join(', ')}. To continue, with what the month has left: `
          + `--city=${summary.budget.unfinished.join(',')} (${current} starts again from its first box).`);
        // The cut city's market-days, over what it answered before the stop,
        // and every record of the run that named another day: the stop can
        // come before the call that saw one could refuse it.
        checkMarketDays(ctx, current);
      }
      summary.budget.used = budgetUsed(s);
      summary.budget.reserved = s.resultsReserved;
      summary.leaves = opts.cities.reduce((n, city) => n + summary.byCity[city].leaves, 0);
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
      const { plan, skipped, placed } = planVenues(all, identities, opts.cities, { radiusKm: opts.radiusKm });
      summary.skipped = skipped;
      for (const [city, n] of placed) summary.byCity[city].venues = n;
      // Under --new-only a known venue stays in the plan, for the axis proof and
      // the identity checks, and is never written (see the header).
      const writes = [];
      for (const item of plan) {
        summary.plan[item.kind]++;
        item.cells = weekCells([...item.venue.days.entries()].sort((a, b) => a[0] - b[0]));
        const c = summary.byCity[item.city];
        if (opts.newOnly && item.kind !== 'new') {
          summary.knownSkipped++;
          c.knownSkipped++;
          continue;
        }
        writes.push(item);
        summary.rowsPlanned += item.cells.length;
        c.rowsPlanned += item.cells.length;
        if (item.kind === 'new') c.newPlanned++; else c.knownPlanned++;
        if (item.venue.days.size < 7) summary.incompleteWeeks++;
      }
      console.log(`${TAG} Venues found: ${venues.size}. Known by BestTime id: ${summary.plan.known_bt}. `
        + `Known by Google place id: ${summary.plan.known_place}. Known as a near-duplicate of an existing row: `
        + `${summary.plan.known_near}. New with a Google place id: ${summary.plan.new}.`);
      console.log(`${TAG} Skipped: ${Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
      if (opts.newOnly) {
        console.log(`${TAG} --new-only: ${summary.knownSkipped} known venues skipped (${summary.plan.known_bt} by BestTime `
          + `id, ${summary.plan.known_place} by Google place id, ${summary.plan.known_near} as near-duplicates). Nothing `
          + 'is written for them; they still feed the axis proof, which only reads.');
      } else if (summary.plan.known_place + summary.plan.known_near > 0) {
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
      const verdict = axisVerdict(proof, { newOnly: opts.newOnly });
      summary.axis = proof;
      summary.axisVerdict = verdict;
      console.log(`${TAG} AXIS PROOF: ${knownBt.length} venues known by BestTime id, ${stored.size} with stored weekly `
        + `rows; ${proof.venues} compared (${proof.thin} with fewer than ${AXIS_MIN_OVERLAP} shared cells and ${proof.flat} `
        + `with a flat stored curve left out). Curves read from day_raw_whole on ${s.fromWhole} venue-days; day_raw `
        + `beside it identical on ${s.fieldsIdentical}, different on ${s.fieldsDiffer}, absent on ${s.fieldAltAbsent}. `
        + 'Shift +k: the harvested curve sits k hours later on the venue clock than the stored rows.');
      for (const line of formatAxisTable(proof)) console.log(line);
      console.log(`${TAG} By hour: ${proof.hourAligned} of ${proof.venues} venues best at rotation 0 or a whole number `
        + `of days from it. By day: ${proof.dayAligned} of the ${proof.dayInformative} with whole weeks on both sides whose `
        + `days differ by at least ${AXIS_DAY_CONTRAST_MIN} points fit rotation 0 within ${AXIS_DAY_TIE_MAE} point of their `
        + `best. ${proof.tied} tied in all.`);
      if (s.fieldsDiffer > 0) {
        const alt = axisProof(pairsFor('altDays'));
        summary.axisAlt = alt;
        const alt0 = alt.table.find((r) => r.shift === 0);
        console.log(`${TAG} Read from day_raw instead: best rotation ${alt.bestShift}, at rotation 0 MAE `
          + `${alt0.mae === null ? 'n/a' : alt0.mae.toFixed(2)}, within five ${pct(alt0.within5)}, r `
          + `${alt0.r === null ? 'n/a' : alt0.r.toFixed(3)}, over ${alt.venues} venues.`);
      }
      console.log(`${TAG} COMMIT GATE: ${verdict.pass ? 'PASS' : 'REFUSED'} (${verdict.reason}). Judged by ${verdict.rule}.`);

      const peaks = peakHourHistogram(plan);
      summary.peakHours = peaks;
      console.log(`${TAG} PEAK HOUR by category, venue-local: venues whose week-averaged busiest hour is that hour.`);
      for (const line of formatPeakHistogram(peaks)) console.log(line);

      const skippedNote = opts.newOnly ? ` ${summary.knownSkipped} known venues skipped (--new-only).` : '';
      if (!opts.commit) {
        console.log(`${TAG} Would write ${summary.rowsPlanned} weekly rows for ${writes.length} venues `
          + `and add ${summary.plan.new} ml_venues rows (inactive, besttime_status '${HARVEST_STATUS}').${skippedNote}`);
        summary.exitCode = summary.rowsPlanned > 0 && verdict.pass ? 0 : 1;
      } else {
        if (!verdict.pass) {
          throw abortError(`REFUSED: the axis proof failed, so the curves' hour origin is not established: ${verdict.reason}. `
            + 'Nothing was written.');
        }
        for (const item of writes) {
          if (item.cells.length === 0) continue;
          try {
            const res = await writeOne(pool, item, item.cells);
            if (res.status === 'vanished') { summary.vanished++; continue; }
            if (res.status === 'claimed') { summary.claimed++; continue; }
            const c = summary.byCity[item.city];
            summary.venuesWritten++;
            if (res.newVenue) { summary.venuesInserted++; c.newWritten++; } else c.knownWritten++;
            summary.rowsWritten += res.written;
            c.rowsWritten += res.written;
            summary.rowsInserted += res.inserted;
            summary.rowsRefreshed += res.written - res.inserted;
          } catch (err) {
            summary.writeFailures++;
            console.error(`  write failed for ${safeText(item.venue.venueId)} (${err.code || 'no code'}): ${describeDbError(err)}`);
          }
        }
        console.log(`${TAG} Wrote ${summary.rowsWritten} weekly rows (${summary.rowsInserted} new, `
          + `${summary.rowsRefreshed} refreshed in place) for ${summary.venuesWritten} venues; `
          + `added ${summary.venuesInserted} ml_venues rows. ${summary.vanished} venues changed under the run, `
          + `${summary.claimed} were claimed by another writer, ${summary.writeFailures} writes failed.${skippedNote}`);
        summary.exitCode = summary.rowsWritten > 0 && summary.writeFailures === 0 ? 0 : 1;
      }
      if (summary.incompleteWeeks > 0) {
        console.log(`${TAG} ${summary.incompleteWeeks} venues have fewer than seven days in this run; their other days are left as they were.`);
      }

      console.log(`${TAG} ${s.requests} filter requests over ${summary.leaves} leaf tiles (${s.splits} splits, `
        + `${s.truncatedTiles} tiles still at the cap at minimum size, ${s.notFound} answered 404). Results: `
        + `${s.venuesReturned} counted from answers and ${s.resultsReserved} reserved for requests that may have been billed `
        + `without one, ${budgetUsed(s)} of the ${opts.resultBudget} budget. Query credits: `
        + `${s.creditsReported > 0 ? `${s.creditsReported} reported by BestTime, ` : ''}~${s.creditsEstimated} estimated.`
        + `${opts.commit ? '' : ' A --commit run of the same scope asks the same questions and should cost the same.'}`);
      if (opts.cacheDir) logCache(opts, s);
      console.log(`${TAG} BY CITY${opts.commit ? '' : ' (dry run: new, known and weekly rows are what --commit would write)'}: `
        + 'results are the venues the filter returned, billed one query credit per ten; venues are the distinct ones placed '
        + `in the city${opts.newOnly ? '' : '; known are refreshed in place'}.`);
      for (const line of formatCityTable(summary, opts)) console.log(line);
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
    if (opts.cacheDir) logCache(opts, summary.stats);
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
  planTiles,
  gridGroups,
  splitTile,
  tileIntersects,
  placeVenue,
  otherMarkets,
  buildFilterUrl,
  readFilterVenue,
  isRealGooglePlaceId,
  weekCells,
  weekCurve,
  planVenues,
  writeOne,
  placeIdAgreement,
  axisProof,
  axisVerdict,
  formatAxisTable,
  peakHourHistogram,
  formatPeakHistogram,
  namesSimilar,
  // harvestVenueSearch.js plans and writes the venues a venue search found
  // through these same readers, so both paths decide identity the same way.
  loadIdentities,
  loadNearbyRows,
  TYPE_TO_CATEGORY,
  FILTER_URL,
  HARVEST_STATUS,
  DEFAULT_RESULT_CAP,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RADIUS_KM,
  DEFAULT_RESULT_BUDGET,
  MONTHLY_RESULT_ALLOWANCE,
  ALL_CITIES,
  REFUSED_CITIES,
  CENTROIDS,
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
