// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// ONE VENUE DETAIL SCREEN USED TO BUY THE SAME PLACES RESPONSE TWICE.
// ---------------------------------------------------------------------------
// frontend/src/App.js openVenueDetail fires getVenueDetails and
// getCrowdPrediction inside one Promise.allSettled. The first landed on
// routes/venueSearch.js GET /details, the second on routes/crowd.js
// GET /:placeId, and each made its OWN paid Enterprise Place Details request
// for the SAME place id — the crowd mask a strict subset of the details mask,
// so the second call bought nothing the first had not already paid for. They
// cached separately (5 minutes on place id; 10 minutes on place id PLUS hour,
// which missed on every hour boundary) and each charged utils/placesBudget.js.
// Place Details at Enterprise is $20 per 1,000 and is the largest non-photo
// line on the Places bill, so this was a straight 50% of that SKU, found and
// priced by the cost audit in services/costModel.js and left alone there
// because it spans two route files and one of them is the crowd model's
// serving path.
//
// services/placeDetailsCache.js is the collapse: one raw Places payload per
// place id, one flight, both routes projecting the fields they need out of it.
//
// WHAT THIS FILE PINS, and why each one is here rather than being eyeballed:
//
//   1. THE SAVING IS REAL AND IT IS EXACTLY HALF. The concurrent pair the client
//      actually fires results in ONE upstream Google request and ONE ledger
//      unit, not two — and the sequential re-open inside the TTL costs nothing
//      at all. Counted at global.fetch and at placesBudgetStatus, not inferred.
//
//   2. BOTH CONSUMERS STILL GET EVERYTHING. The detail card's fields that the
//      crowd mask never asked for (phone, website, photos, googleMapsUri) must
//      survive, or "shared payload" quietly means "the subset won".
//
//   3. THE MODEL'S INPUTS ARE BYTE-IDENTICAL. This is the one that needs a test
//      rather than a reading. mlPredictor.buildFeatureMap reads `rating`,
//      `price_level`, `review_count` and `log_review_count`, and a MISSING one
//      does not throw — it substitutes the corpus median, so every venue
//      silently becomes 4.0-star, mid-priced and zero-review and the model
//      keeps answering. That failure has shipped twice from this exact class of
//      change (routes/badge.js round 10, routes/venueDashboard.js round 20) and
//      both times it was found as a product bug, not by a test. So the feature
//      map built from a venue shaped by the NEW path is compared, key by key,
//      against one built from a venue shaped by a verbatim copy of the OLD
//      shaping over the identical Places payload — and separately against the
//      literal Google values, so the test would fail rather than pass if BOTH
//      sides regressed to the median together.
//
//   4. THE LEDGER IS CHARGED ONCE PER REAL UPSTREAM FETCH AND NEVER ON A HIT.
//      utils/placesBudget.js's own rule: "cache hits must be answered before
//      the charge... charging for a call you did not make masks the real burn
//      rate".
//
//   5. A FAILURE IS NOT CACHED. A Google error body must not pin a 502 for the
//      rest of the TTL; the next request goes back upstream.
//
// __tests__/placesFieldMaskModelInputs.test.js is the static half of the same
// argument (it sweeps every mask in routes/ and services/ for the three trained
// columns). This is the dynamic half: the mask can be right and the SHAPING can
// still drop a field on the floor.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'place-details-shared-cache-test-secret';
// Captured at module load by the routers; the shared cache reads it per call.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.TICKETMASTER_API_KEY;
delete process.env.PAYWALL_ENABLED;

const placesBudget = require('../utils/placesBudget');
const { placesBudgetStatus, __resetPlacesBudget } = placesBudget;

// --- scripted pg ------------------------------------------------------------
const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

// --- stubbed collaborators (destructured at load, so patch before requiring) --
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({
  temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3,
  isRaining: false, conditionId: 800, fetchedAt: Date.now(),
});
weatherService.getForecast = async () => [];

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

const mlPredictor = require('../services/mlPredictor');
// buildFeatureMap is NOT stubbed — it is the thing under test in part 3. Only
// the two entry points that would reach ONNX and Postgres are.
const { buildFeatureMap } = mlPredictor._internals;
let venuesHandedToTheModel = [];
mlPredictor.predictBusyness = async (venue) => {
  venuesHandedToTheModel.push(venue);
  return {
    score: 55, label: 'Moderate', confidence: 60, factors: {},
    dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
  };
};
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => ({ hour: `${(startHour + i) % 24}`, score: 55, label: 'Moderate' }));

// ---------------------------------------------------------------------------
// The Google response. One object, served to every Place Details request, so
// "the two callers saw the same payload" is not something the fake can fake.
// ---------------------------------------------------------------------------
const PLACE = {
  id: 'ChIJshared_detail_0001',
  displayName: { text: 'The Shared Payload' },
  formattedAddress: '77 One Call Street',
  nationalPhoneNumber: '+1 555 0100',
  websiteUri: 'https://example.com/venue',
  rating: 4.4,
  userRatingCount: 913,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  photos: [{ name: 'places/ChIJshared_detail_0001/photos/aaa' }],
  currentOpeningHours: {
    openNow: true,
    periods: [
      { open: { day: 0, hour: 17, minute: 0 }, close: { day: 0, hour: 23, minute: 0 } },
      { open: { day: 1, hour: 17, minute: 0 }, close: { day: 1, hour: 23, minute: 0 } },
      { open: { day: 2, hour: 17, minute: 0 }, close: { day: 2, hour: 23, minute: 0 } },
      { open: { day: 3, hour: 17, minute: 0 }, close: { day: 3, hour: 23, minute: 0 } },
      { open: { day: 4, hour: 17, minute: 0 }, close: { day: 4, hour: 23, minute: 0 } },
      { open: { day: 5, hour: 17, minute: 0 }, close: { day: 5, hour: 23, minute: 0 } },
      { open: { day: 6, hour: 17, minute: 0 }, close: { day: 6, hour: 23, minute: 0 } },
    ],
  },
  types: ['bar', 'restaurant', 'point_of_interest'],
  location: { latitude: 40.62, longitude: -75.37 },
  googleMapsUri: 'https://maps.google.com/?cid=1',
  utcOffsetMinutes: -300,
};

// THE MASK routes/crowd.js used to send, kept verbatim so the "strict subset"
// claim is checked rather than asserted in a comment.
const OLD_CROWD_MASK = 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,types,location,currentOpeningHours,utcOffsetMinutes';

let detailCalls = [];   // every https://places.googleapis.com/v1/places/<id> GET
let failNextWith = null; // { body } to return instead of PLACE
// A HELD-OPEN UPSTREAM. Google takes a couple of hundred milliseconds; a stub
// that resolves in the same microtask does not, and a fetch that returns
// instantly makes the CACHE look sufficient because the leader has already
// filled it before the follower looks. Every in-flight assertion in this file
// would then pass with the coalescing deleted. `detailGate`, when set, holds the
// upstream open so "concurrent" means concurrent.
let detailGate = null;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    detailCalls.push({ url: u, mask: opts?.headers?.['X-Goog-FieldMask'] || '' });
    const gate = detailGate;
    const body = failNextWith || PLACE;
    if (failNextWith) failNextWith = null;
    const respond = () => ({ ok: true, status: 200, json: async () => body });
    if (gate) return gate.then(respond);
    return Promise.resolve(respond());
  }
  if (u.startsWith('https://places.googleapis.com/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [] }) });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

// --- routers (required AFTER every stub above) ------------------------------
const venueSearchRouter = require('../routes/venueSearch');
const crowdRouter = require('../routes/crowd');
const placeDetailsCache = require('../services/placeDetailsCache');
const { fetchVenueFromGoogle } = crowdRouter.__testables;

const app = express();
app.use(express.json());
app.use('/api/venues', venueSearchRouter);
app.use('/api/crowd', crowdRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  __resetPlacesBudget();
  placeDetailsCache.__test.reset();
  venueSearchRouter.__test.clearVenueCache();
  detailCalls = [];
  failNextWith = null;
  detailGate = null;
  venuesHandedToTheModel = [];
});

// A promise plus the handle that settles it, so a test can decide when the
// upstream comes back.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}

// A fresh id per test, so routes/crowd.js's own 10-minute prediction cache
// (`full:${placeId}:${hour}:${day}`, which is NOT what this file is about)
// cannot answer a request the test meant to send upstream.
let n = 0;
const uniqueId = () => `ChIJshared_detail_${String(++n).padStart(4, '0')}`;

const charged = () => placesBudgetStatus(7).globalUsed;

// ===========================================================================
// PART 1 — the saving. Two consumers, one call, one charge.
// ===========================================================================

test('the pair the client actually fires costs ONE Place Details call and ONE ledger unit', async () => {
  const placeId = uniqueId();

  // The upstream is held open for the whole overlap, so neither request can be
  // answered out of a cache the other one already filled. This is the shape of
  // the real thing: a Google round trip is long enough that the second request
  // arrives while the first is still waiting.
  const gate = deferred();
  detailGate = gate.promise;

  // Exactly what App.js openVenueDetail does: both requests in flight at once.
  const pair = Promise.all([
    get(`/api/venues/details?place_id=${placeId}`),
    get(`/api/crowd/${placeId}?localHour=20&localDay=5`),
  ]);
  await sleep(40);
  gate.resolve();
  const [details, crowd] = await pair;

  assert.strictEqual(details.status, 200, details.text);
  assert.strictEqual(crowd.status, 200, crowd.text);

  assert.strictEqual(detailCalls.length, 1,
    'the venue detail screen made two paid Enterprise Place Details calls for one place id; ' +
    `this is the whole point of services/placeDetailsCache.js. Calls: ${detailCalls.length}`);
  assert.strictEqual(charged(), 1,
    'a follower riding the leader\'s in-flight fetch must not charge the Places ledger — ' +
    'utils/placesBudget.js: charging for a call you did not make masks the real burn rate');
});

test('a cache alone would not have done it — the deduplication has to be on the FLIGHT', async () => {
  // The route-level test above is the product case; this is the same property
  // asserted where nothing can be timing-lucky. Both calls are made in ONE tick
  // against a held-open upstream, so the second one provably cannot be served
  // by a cache — the first has not returned. Delete detailsInflight and this is
  // two Google calls and two charges.
  const placeId = uniqueId();
  const gate = deferred();
  detailGate = gate.promise;

  const leader = placeDetailsCache.fetchPlaceDetails(placeId);
  assert.strictEqual(placeDetailsCache.__test.inflightSize(), 1, 'the leader must register a flight synchronously');
  assert.strictEqual(placeDetailsCache.willCostUpstreamCall(placeId), false,
    'a caller arriving during a flight must be told it costs nothing, or it charges for a call it will not make');
  const follower = placeDetailsCache.fetchPlaceDetails(placeId);

  gate.resolve();
  const [a, b] = await Promise.all([leader, follower]);

  assert.strictEqual(detailCalls.length, 1, 'concurrent requests for one place id must share one flight');
  assert.ok(a.ok && b.ok);
  assert.strictEqual(a.place, b.place, 'both callers must be handed the same payload object');
  assert.strictEqual(placeDetailsCache.__test.inflightSize(), 0, 'the flight must drain on settle');
});

test('re-opening the same venue inside the TTL costs nothing at all', async () => {
  const placeId = uniqueId();

  await get(`/api/venues/details?place_id=${placeId}`);
  assert.strictEqual(detailCalls.length, 1, 'the first open is a real miss and must fetch');
  assert.strictEqual(charged(), 1, 'a cache MISS still charges exactly once');

  // Second open: same id, well inside the 10-minute TTL. Different local hour
  // on the crowd side, which is precisely the case the old `place id + hour`
  // key re-bought a Places response for.
  const again = await get(`/api/venues/details?place_id=${placeId}`);
  const crowdNextHour = await get(`/api/crowd/${placeId}?localHour=22&localDay=5`);

  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(crowdNextHour.status, 200, crowdNextHour.text);
  assert.strictEqual(detailCalls.length, 1,
    'the hour belongs to the PREDICTION cache, not to the Places payload — a venue\'s ' +
    'rating, price level and posted hours do not change because the clock rolled');
  assert.strictEqual(charged(), 1, 'a cache hit must not charge');
});

test('the one call that is made asks for the SUPERSET mask, so nothing was traded away', async () => {
  const placeId = uniqueId();
  await get(`/api/crowd/${placeId}?localHour=20&localDay=5`);
  assert.strictEqual(detailCalls.length, 1);

  const sent = detailCalls[0].mask.split(',').map((s) => s.trim()).filter(Boolean);
  for (const field of OLD_CROWD_MASK.split(',')) {
    assert.ok(sent.includes(field),
      `the shared mask dropped '${field}', which routes/crowd.js used to ask for itself`);
  }
  // And the four the detail card needs on top of it.
  for (const field of ['nationalPhoneNumber', 'websiteUri', 'photos', 'googleMapsUri']) {
    assert.ok(sent.includes(field), `the shared mask dropped '${field}', which GET /details needs`);
  }
});

// ===========================================================================
// PART 2 — both consumers still receive complete data.
// ===========================================================================

test('the detail card keeps the fields the crowd mask never asked for', async () => {
  const placeId = uniqueId();
  // Crowd goes FIRST, so the payload in the cache was fetched on behalf of the
  // consumer with the smaller appetite. If the shared fetch ever narrows to
  // whoever asked first, this is where it shows.
  await get(`/api/crowd/${placeId}?localHour=20&localDay=5`);
  const details = await get(`/api/venues/details?place_id=${placeId}`);

  assert.strictEqual(details.status, 200, details.text);
  const v = details.body.venue;
  assert.strictEqual(v.formatted_phone_number, '+1 555 0100');
  assert.strictEqual(v.website, 'https://example.com/venue');
  assert.strictEqual(v.google_maps_url, 'https://maps.google.com/?cid=1');
  assert.strictEqual(v.photos.length, 1, 'the photo proxy URLs are built from the shared payload');
  assert.ok(v.photos[0].startsWith('/api/venues/photo?ref='));
  assert.strictEqual(v.rating, 4.4);
  assert.strictEqual(v.user_ratings_total, 913);
  assert.strictEqual(v.price_level, 2);
  assert.strictEqual(v.utcOffsetMinutes, -300);
  assert.ok(v.opening_hours, 'the hours block must survive');
  assert.strictEqual(detailCalls.length, 1);
});

test('the crowd card is complete when the DETAIL card led the fetch', async () => {
  const placeId = uniqueId();
  await get(`/api/venues/details?place_id=${placeId}`);
  const crowd = await get(`/api/crowd/${placeId}?localHour=20&localDay=5`);

  assert.strictEqual(crowd.status, 200, crowd.text);
  assert.strictEqual(crowd.body.priceLevel, 2, 'price level reached the card through the shared payload');
  assert.deepStrictEqual(crowd.body.venueTypes, ['bar', 'restaurant', 'point_of_interest']);
  assert.strictEqual(crowd.body.isOpen, true, 'currentOpeningHours.openNow still drives the Now bar');
  assert.strictEqual(crowd.body.venueClock.utcOffsetMinutes, -300,
    'the venue clock comes off the same payload; losing it scores an out-of-zone venue on the viewer\'s hour');
  assert.strictEqual(detailCalls.length, 1);
});

// ===========================================================================
// PART 3 — the model's inputs, proved rather than eyeballed.
// ===========================================================================

// A VERBATIM COPY of routes/crowd.js fetchVenueFromGoogle's projection as it
// stood before the shared cache (commit cee86cd), minus the fetch it used to do
// for itself. This is the reference the new path is compared against. If the
// two ever disagree, the diff below names the feature that moved.
//
// It is duplicated here on purpose. The point of the test is that two
// INDEPENDENTLY WRITTEN shapings of the same Places payload produce the same
// feature vector; importing the live one would make the comparison vacuous.
function oldCrowdVenueShape(p, clientDay) {
  const crowdEngine = require('../services/crowdEngine');
  const priceLevelToNum = (priceLevel) => ({
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  }[priceLevel] ?? null);

  const periods = p.currentOpeningHours?.periods;
  const hoursByDay = crowdEngine.buildHoursByDay(periods);
  const venueDay = crowdEngine.venueLocalNow(p.utcOffsetMinutes)?.day;
  const today = venueDay != null ? venueDay : (clientDay != null ? clientDay : new Date().getDay());
  const hoursToday = hoursByDay ? (hoursByDay[today] || []) : [];
  const todayWindow = hoursToday[0] || null;

  return {
    hoursByDay,
    hoursToday,
    closeMinute: todayWindow ? todayWindow.closeMinute : 0,
    place_id: p.id,
    name: p.displayName?.text || '',
    formatted_address: p.formattedAddress || '',
    rating: p.rating || null,
    user_ratings_total: p.userRatingCount || 0,
    price_level: priceLevelToNum(p.priceLevel),
    types: p.types || [],
    location: p.location || null,
    isOpen: p.currentOpeningHours?.openNow ?? null,
    openHour: todayWindow ? todayWindow.open : null,
    closeHour: todayWindow ? todayWindow.close : null,
    utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
  };
}

// Fixed everywhere, so the only thing that can differ between the two feature
// maps is the venue.
// buildFeatureMap reads `metadata` (the corpus medians and the category
// encoding), which is null until init() has loaded the shipped artifact. That
// is exactly the state this test needs: the corpus medians have to be REAL, or
// "did not fall back to the median" is not a distinction the assertions below
// could draw.
test.before(async () => {
  const ok = await mlPredictor.init();
  assert.ok(ok, 'model_metadata.json must load — the corpus medians are what a dropped input falls back TO');
});

const AT = new Date('2026-08-21T01:00:00Z');
const WEATHER = { temp: 61, humidity: 40, windSpeed: 3, isRaining: false, conditionId: 800 };
const FEATURE_ARGS = [WEATHER, AT, null, null, null, null];

test('the feature map from the NEW venue shape is identical to the pre-change one', async () => {
  const placeId = uniqueId();

  const fresh = await fetchVenueFromGoogle(placeId, 5);
  assert.ok(fresh, 'the shared cache must still shape a venue for the crowd path');

  const before = buildFeatureMap(oldCrowdVenueShape(PLACE, 5), ...FEATURE_ARGS);
  const after = buildFeatureMap(fresh, ...FEATURE_ARGS);

  // Key by key, with the differing key named — `deepStrictEqual` on a
  // ~200-column object reports "objects differ" and nothing a reader can act on.
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const drift = [...keys].filter((k) => before[k] !== after[k]);
  assert.deepStrictEqual(drift, [],
    'the crowd model is being fed a different vector than it was before the shared cache. ' +
    'buildFeatureMap SUBSTITUTES THE CORPUS MEDIAN for a missing input rather than throwing, ' +
    'so this is silent in production: every venue scores as 4.0-star, mid-priced and zero-review.');
});

test('the three trained columns hold the REAL Google values, not the corpus median', async () => {
  // Part of the same argument as the test above and not redundant with it: a
  // regression that hit BOTH shapings equally would leave them identical and
  // still be wrong. This one is anchored to the literal payload.
  const placeId = uniqueId();
  const venue = await fetchVenueFromGoogle(placeId, 5);
  const f = buildFeatureMap(venue, ...FEATURE_ARGS);

  assert.strictEqual(f.rating, 4.4, 'rating fell back to metadata.median_rating');
  assert.strictEqual(f.price_level, 2, 'price_level fell back to metadata.median_price_level');
  assert.strictEqual(f.review_count, 913, 'review_count fell back to 0');
  assert.strictEqual(f.log_review_count, Math.log1p(913),
    'log_review_count collapsed from a real spread to a constant — the tell for a dropped userRatingCount');
});

test('the venue the SERVING PATH hands the model carries all three inputs', async () => {
  // The unit test above proves the shaping. This proves the wiring: what
  // routes/crowd.js actually passes to predictBusyness on a live request.
  const placeId = uniqueId();
  const res = await get(`/api/crowd/${placeId}?localHour=20&localDay=5`);
  assert.strictEqual(res.status, 200, res.text);

  assert.ok(venuesHandedToTheModel.length >= 1, 'the card never reached the predictor');
  const venue = venuesHandedToTheModel[0];
  assert.strictEqual(venue.rating, 4.4);
  assert.strictEqual(venue.user_ratings_total, 913);
  assert.strictEqual(venue.price_level, 2);
  assert.deepStrictEqual(venue.location, { latitude: 40.62, longitude: -75.37 },
    'coordinates too: buildFeatureMap reads venue.location and a miss puts the venue at 0,0');
});

// ===========================================================================
// PART 4 — the ledger, and failures.
// ===========================================================================

test('a cache miss charges exactly once, and the charge is refused when the budget is gone', async () => {
  const placeId = uniqueId();
  await get(`/api/venues/details?place_id=${placeId}`);
  assert.strictEqual(charged(), 1);

  // Spend the caller's whole rolling hour, then ask for a venue nobody has
  // fetched. The gate must still bite — sharing a cache must not become a way
  // around the budget for uncached ids.
  const other = uniqueId();
  while (placesBudgetStatus(7).userRemaining > 0) placesBudget.allowPlacesSearch(7, 1);
  const refused = await get(`/api/venues/details?place_id=${other}`);
  assert.strictEqual(refused.status, 429, 'an uncached id must still be gated by the Places budget');
  assert.strictEqual(detailCalls.length, 1, 'a refused request must not reach Google');
});

test('a served-from-cache request is answered even when the budget is exhausted', async () => {
  // The other half of the same rule. The entry is already bought; refusing to
  // serve it would spend nothing and help nobody.
  const placeId = uniqueId();
  await get(`/api/venues/details?place_id=${placeId}`);
  while (placesBudgetStatus(7).userRemaining > 0) placesBudget.allowPlacesSearch(7, 1);

  const again = await get(`/api/venues/details?place_id=${placeId}`);
  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(detailCalls.length, 1);
});

test('a Google error body is a 502 and is NOT cached — the next request retries', async () => {
  const placeId = uniqueId();
  failNextWith = { error: { message: 'NOT_FOUND' } };

  const failed = await get(`/api/venues/details?place_id=${placeId}`);
  assert.strictEqual(failed.status, 502, failed.text);
  assert.match(failed.body.error, /Places API: NOT_FOUND/,
    'the detail route answered a Google error body with Google\'s own message before the shared cache and must still');
  assert.strictEqual(detailCalls.length, 1);

  // A poisoned cache would serve the 502 again for the whole TTL and never
  // reach Google. A healthy retry is the proof it wrote nothing.
  const recovered = await get(`/api/venues/details?place_id=${placeId}`);
  assert.strictEqual(recovered.status, 200, recovered.text);
  assert.strictEqual(recovered.body.venue.rating, 4.4);
  assert.strictEqual(detailCalls.length, 2, 'a failed fetch must not be pinned as a cache entry');
  assert.strictEqual(charged(), 2, 'two real upstream attempts are two real charges');
});

test('an unreachable upstream is a 500 on the detail card and a 502 on the crowd card, as before', async () => {
  // The two routes have always disagreed about this deliberately: venueSearch
  // reports its own failure as a 500 and crowd turns every failure into a 502.
  // The shared module returns a discriminated result rather than one null so
  // that both behaviours survive.
  const placeId = uniqueId();
  const stashed = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://places.googleapis.com/v1/places/')) {
      detailCalls.push({ url: u, mask: opts?.headers?.['X-Goog-FieldMask'] || '' });
      return Promise.reject(new Error('socket hang up'));
    }
    return stashed(url, opts);
  };
  try {
    const details = await get(`/api/venues/details?place_id=${placeId}`);
    assert.strictEqual(details.status, 500, details.text);

    const crowdId = uniqueId();
    const crowd = await get(`/api/crowd/${crowdId}?localHour=20&localDay=5`);
    assert.strictEqual(crowd.status, 502, crowd.text);
  } finally {
    global.fetch = stashed;
  }

  // And neither failure was cached.
  const healthy = await get(`/api/venues/details?place_id=${placeId}`);
  assert.strictEqual(healthy.status, 200, healthy.text);
});
