// Run: node --test  (from backend/)
//
// TWO FIXES, ONE FILE.
//
// 1. THE INERT HALF. POST /api/crowd/batch scores every venue on that venue's
//    own wall clock — but only when `utcOffsetMinutes` arrives with the venue.
//    routes/venueSearch.js is where the app's vote list comes from, and neither
//    its text search nor its details call asked Google for that field, so every
//    venue discovered by search fell back to the VIEWER's clock while the same
//    venue's detail card (routes/crowd.js fetches the offset itself) used the
//    venue's. The server half of that fix is the field mask; these tests drive
//    the real search and the real batch end to end so the two halves are pinned
//    together rather than one route at a time.
//
//    The fake Google below HONOURS THE FIELD MASK. That is what makes these
//    tests mutation-verifiable: delete `places.utcOffsetMinutes` from the mask
//    and the venue comes back without an offset, the batch answers
//    `venueClock.local: false`, and the assertions go red. A fake that returned
//    every field regardless would have passed against the broken mask, which is
//    exactly how this bug shipped inert in the first place.
//
// 2. A PAID CALL IS NOT SPENT ON A STRING THAT CANNOT BE A PLACE ID.
//    routes/crowd.js (both Google-calling routes) and GET /api/venues/details
//    accepted any bounded string, spent a Place Details call on it, and — via
//    services/mlPredictor.js — used it as the key ml_venue_baselines rows and
//    the predictor's caches are written under. utils/places.isPlaceIdShaped is
//    the rule every other consumer already enforces. Refusal must happen BEFORE
//    the fetch and BEFORE the charge, or "we refused it" still costs money.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-search-offset-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.TICKETMASTER_API_KEY;
delete process.env.PAYWALL_ENABLED;

// --- the real spending ledger ----------------------------------------------
const { placesBudgetStatus, __resetPlacesBudget } = require('../utils/placesBudget');

// --- scripted pg ------------------------------------------------------------
const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

// --- stubbed collaborators (destructured at load, so patch before require) ---
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({
  temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3,
  isRaining: false, conditionId: 800, fetchedAt: Date.now(),
});

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({
  score: 55, label: 'Moderate', confidence: 60, factors: {},
  dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => ({ hour: `${(startHour + i) % 24}`, score: 55, label: 'Moderate' }));

const crowdEngine = require('../services/crowdEngine');

// --- Google, faked, and it respects X-Goog-FieldMask ------------------------
const PLACE = {
  id: 'PLACE_A',
  displayName: { text: 'The Bar' },
  formattedAddress: '1 Main St',
  rating: 4.4,
  userRatingCount: 120,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  types: ['bar'],
  photos: [{ name: 'places/PLACE_A/photos/PHOTOREF' }],
  location: { latitude: 39.74, longitude: -104.98 },
  currentOpeningHours: { openNow: true, periods: [] },
  googleMapsUri: 'https://maps.example/PLACE_A',
  nationalPhoneNumber: '555-0100',
  websiteUri: 'https://bar.example',
  // Pacific. Deliberately far from any plausible CI clock so a venue scored on
  // it cannot accidentally agree with the caller's hour.
  utcOffsetMinutes: -480,
};

function project(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  }
  return out;
}

let googleCalls = []; // { url, mask: string[] }
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    const raw = (opts && opts.headers && opts.headers['X-Goog-FieldMask']) || '';
    const mask = raw.split(',').map((s) => s.trim()).filter(Boolean);
    googleCalls.push({ url: u, mask });

    if (u.includes('/media')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ photoUri: 'https://cdn.example/photo.jpg' }) });
    }
    if (u.includes(':searchText')) {
      const fields = mask.filter((m) => m.startsWith('places.')).map((m) => m.slice('places.'.length));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [project(PLACE, fields)] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => project(PLACE, mask) });
  }
  if (u.startsWith('https://cdn.example/')) {
    googleCalls.push({ url: u, mask: [] });
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(4),
    });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

// --- routers (required AFTER every stub above) ------------------------------
const venueSearchRouter = require('../routes/venueSearch');
const crowdRouter = require('../routes/crowd');

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
  googleCalls = [];
});

async function get(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

async function post(pathname, payload) {
  const res = await realFetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

// Unique queries/ids per test: both routers cache for minutes in module-level
// maps no beforeEach can reach, so a shared key would have the second test
// silently measuring a cache hit.
let seq = 0;
const uniq = () => `u${Date.now().toString(36)}${seq++}`;

// ===========================================================================
// PART 1 — the offset actually leaves routes/venueSearch.js
// ===========================================================================

test('the text search asks Google for the venue clock and hands it to the client', async () => {
  const res = await get(`/api/venues/search?query=bars ${uniq()}&location=39.74,-104.98`);
  assert.strictEqual(res.status, 200, res.text);

  const call = googleCalls.find((c) => c.url.includes(':searchText'));
  assert.ok(call, 'the search never reached Google');
  assert.ok(call.mask.includes('places.utcOffsetMinutes'),
    'without this field every venue in the vote list is scored on the viewer‘s clock');

  const venue = res.body.venues[0];
  assert.strictEqual(venue.utcOffsetMinutes, -480,
    'the offset must survive the Google -> venue shaping under the exact key /api/crowd/batch reads');
});

test('the details card asks for the venue clock too', async () => {
  const res = await get('/api/venues/details?place_id=PLACE_DETAIL_OFFSET');
  assert.strictEqual(res.status, 200, res.text);

  const call = googleCalls.find((c) => c.url.includes('/v1/places/'));
  assert.ok(call, 'the details route never reached Google');
  assert.ok(call.mask.includes('utcOffsetMinutes'));
  assert.strictEqual(res.body.venue.utcOffsetMinutes, -480);
});

// The field mask is the only thing standing between "each venue on its own
// clock" and "everything on the viewer's". Google's SKU tiers are per FIELD and
// a request is billed at the highest tier it touches, so this also records why
// the addition is free: both masks already carry Enterprise fields.
test('both masks already carry an Enterprise field, so the venue clock costs nothing extra', async () => {
  const ENTERPRISE = ['currentOpeningHours', 'rating', 'userRatingCount', 'priceLevel'];

  await get(`/api/venues/search?query=bars ${uniq()}&location=39.74,-104.98`);
  const search = googleCalls.find((c) => c.url.includes(':searchText'));
  assert.ok(ENTERPRISE.some((f) => search.mask.includes(`places.${f}`)),
    'if this mask ever drops to Pro-only, adding utcOffsetMinutes stops being free and the note above it is wrong');

  googleCalls = [];
  await get('/api/venues/details?place_id=PLACE_SKU_CHECK');
  const details = googleCalls.find((c) => c.url.includes('/v1/places/'));
  assert.ok(ENTERPRISE.some((f) => details.mask.includes(f)));
});

// ===========================================================================
// PART 2 — search -> batch, the whole point of the change
// ===========================================================================

// Two readings taken around the request: `venueLocalNow` runs against the real
// clock, so the only honest assertion is "the hour the route used is the hour
// the venue was actually on", allowing for the request straddling an hour tick.
function venueHoursAround(offset, fn) {
  const before = crowdEngine.venueLocalNow(offset).hour;
  return Promise.resolve(fn()).then((out) => {
    const after = crowdEngine.venueLocalNow(offset).hour;
    return { out, allowed: [before, after] };
  });
}

test('a venue found by search is scored on ITS clock once the search carries the offset', async () => {
  const search = await get(`/api/venues/search?query=bars ${uniq()}&location=39.74,-104.98`);
  const v = search.body.venues[0];

  // Exactly the payload frontend/src/App.js forwards.
  const { out: batch, allowed } = await venueHoursAround(-480, () => post('/api/crowd/batch', {
    venues: [{
      place_id: 'PLACE_FROM_SEARCH', name: v.name, rating: v.rating,
      user_ratings_total: v.user_ratings_total, types: v.types,
      price_level: v.price_level, location: v.location,
      utcOffsetMinutes: v.utcOffsetMinutes != null ? v.utcOffsetMinutes : null,
    }],
    localHour: 23, localDay: 5,
  }));

  assert.strictEqual(batch.status, 200, batch.text);
  const p = batch.body.predictions[0];
  assert.strictEqual(p.venueClock.local, true,
    'the venue arrived from search with no offset, so it was scored on the caller‘s clock — the fix is inert');
  assert.strictEqual(p.venueClock.utcOffsetMinutes, -480);
  assert.ok(allowed.includes(p.venueClock.hour),
    `scored on hour ${p.venueClock.hour}, but the venue was on ${allowed.join(' or ')}`);
});

test('a venue Google gives no offset for still says so out loud instead of pretending', async () => {
  // The one thing worse than falling back to the caller's clock is doing it
  // silently. `local: false` is the per-row signal that this row's hour is the
  // viewer's, and it is in the payload the client renders from.
  const { out: res, allowed } = await venueHoursAround(-480, () => post('/api/crowd/batch', {
    venues: [
      { place_id: 'HAS_OFFSET', location: { latitude: 39.74, longitude: -104.98 }, utcOffsetMinutes: -480 },
      { place_id: 'NO_OFFSET', location: { latitude: 39.74, longitude: -104.98 } },
    ],
    localHour: 23, localDay: 5,
  }));
  assert.strictEqual(res.status, 200, res.text);
  const byId = Object.fromEntries(res.body.predictions.map((p) => [p.placeId, p]));

  assert.strictEqual(byId.NO_OFFSET.venueClock.local, false);
  assert.strictEqual(byId.NO_OFFSET.venueClock.utcOffsetMinutes, null);
  assert.strictEqual(byId.NO_OFFSET.venueClock.hour, 23, 'the fallback is the caller‘s hour, as documented');

  assert.strictEqual(byId.HAS_OFFSET.venueClock.local, true);
  // This used to assert the two hours DIFFER, which is true for 23 hours out of
  // every 24 and false for the one where the caller's hardcoded 23 happens to
  // equal the venue's real UTC-8 hour. It failed for exactly that hour, every
  // day, and passed every other time it was run. What the test means is that
  // HAS_OFFSET is scored on the VENUE's clock rather than the caller's, so
  // assert that directly against the real elapsed time; the two hours coinciding
  // once a day is arithmetic, not a regression.
  assert.ok(allowed.includes(byId.HAS_OFFSET.venueClock.hour),
    `scored on hour ${byId.HAS_OFFSET.venueClock.hour}, but the venue's own clock says ${allowed.join(' or ')}`);
});

test('an offset of zero is a clock, not a missing one', async () => {
  // London in winter is utcOffsetMinutes: 0. Every hop this value takes —
  // Number.isFinite in the batch whitelist, `== null` in venueLocalNow, the
  // `clock.local ?` ternary in the response — has to tell 0 from absent, or the
  // one time zone the server can least afford to guess about gets guessed.
  const { out: res, allowed } = await venueHoursAround(0, () => post('/api/crowd/batch', {
    venues: [{ place_id: 'UTC_VENUE', location: { latitude: 51.5, longitude: -0.12 }, utcOffsetMinutes: 0 }],
    localHour: 23, localDay: 5,
  }));
  assert.strictEqual(res.status, 200, res.text);
  const p = res.body.predictions[0];
  assert.strictEqual(p.venueClock.local, true, '0 was read as "no offset"');
  assert.strictEqual(p.venueClock.utcOffsetMinutes, 0);
  assert.ok(allowed.includes(p.venueClock.hour));
});

// ===========================================================================
// PART 3 — a paid call is never spent on a string that cannot be a place id
// ===========================================================================

// Each entry is a route that spends REAL money per request. `charge` is what a
// successful request costs, so the refusal assertions can say "and nothing was
// charged" in the same breath as "and Google was never called".
const PAID_BY_PLACE_ID = [
  { name: 'GET /api/crowd/:placeId', url: (id) => `/api/crowd/${id}?localHour=20&localDay=5`, charge: 1 },
  { name: 'GET /api/crowd/:placeId/alternatives', url: (id) => `/api/crowd/${id}/alternatives?localHour=20&localDay=5`, charge: 2 },
  { name: 'GET /api/venues/details', url: (id) => `/api/venues/details?place_id=${id}`, charge: 1 },
];

// Every one of these decodes, on the wire, to something that is not a Google
// place id. The traversal pair are the ones that used to rewrite the URL our
// server-restricted API key rides on.
const NOT_A_PLACE_ID = [
  ['a path traversal', 'AAAAAA%2F..%2F..%2Fv1%3Aescape'],
  ['a query-string injection', 'AAAAAA%3Fkey%3Dleak'],
  ['a fragment', 'AAAAAA%23frag'],
  ['too short to be an id', 'ab'],
  ['a name with spaces', 'the%20bar%20downtown'],
  ['punctuation Google never mints', 'PLACE.A%40evil'],
];

for (const route of PAID_BY_PLACE_ID) {
  test(`${route.name} refuses an unshaped id before it costs anything`, async () => {
    for (const [why, encoded] of NOT_A_PLACE_ID) {
      __resetPlacesBudget();
      googleCalls = [];
      const res = await get(route.url(encoded));
      assert.strictEqual(res.status, 400, `${why}: ${res.text}`);
      assert.strictEqual(googleCalls.length, 0,
        `${why}: a paid Google call was spent on an id that cannot be real`);
      assert.strictEqual(placesBudgetStatus(7).globalUsed, 0,
        `${why}: the budget was charged for a call that was never made`);
      assert.strictEqual(placesBudgetStatus(7).userRemaining, 30);
    }
  });

  test(`${route.name} still serves a real id, and still charges for it`, async () => {
    const id = `SHAPED_${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
    assert.ok(require('../utils/places').isPlaceIdShaped(id), `the test id ${id} is not itself shaped`);
    const res = await get(route.url(id));
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(placesBudgetStatus(7).globalUsed, route.charge,
      'the shape check must not have changed what a real request costs');
  });
}

test('a shaped id reaches Google as exactly one path segment', async () => {
  // The property routes/crowd.js and routes/venueSearch.js both encode for. The
  // shape check makes it unreachable from outside, and the encoding is what
  // keeps it true for any future caller that skips the validator.
  await get(`/api/crowd/PLACEONE_${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}?localHour=20&localDay=5`);
  await get(`/api/venues/details?place_id=PLACETWO_${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`);

  const details = googleCalls.filter((c) => c.url.includes('/v1/places/'));
  assert.ok(details.length >= 2, 'neither route called Google, so this proves nothing');
  for (const c of details) {
    const parsed = new URL(c.url);
    assert.deepStrictEqual(parsed.pathname.split('/').filter(Boolean).slice(0, 2), ['v1', 'places']);
    assert.strictEqual(parsed.pathname.split('/').filter(Boolean).length, 3,
      `a place id became extra path segments: ${parsed.pathname}`);
    assert.strictEqual(parsed.search, '', `a place id injected a query string: ${c.url}`);
  }
});

// ===========================================================================
// PART 4 — the photo proxy's ref is a resource name, not a free string
// ===========================================================================

test('the photo proxy serves a real photo name and charges the ledger once', async () => {
  const ref = `places/PLACE_A/photos/${uniq()}`;
  const res = await get(`/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=400`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1,
    'the /media metadata leg is a paid Places request');

  // A cache hit is free and must stay free.
  await get(`/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=400`);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1);
});

test('a ref that is not a photo resource name never reaches Google', async () => {
  // `ref` was interpolated raw into the /media URL built around our API key, so
  // a `?` or `#` rewrote that URL's query string and extra segments reached a
  // different Google path — and every one of those still cost a unit, because
  // the charge happens before the fetch.
  const BAD = [
    ['a query-string injection', 'places/X/photos/ABC?key=leak'],
    ['a fragment', 'places/X/photos/ABC#frag'],
    ['a traversal', 'places/../../v1/photos/ABC'],
    ['extra path segments', 'places/X/photos/ABC/extra'],
    ['not a photo name at all', 'ChIJN1t_tDeuEmsRUsoyG83frY4'],
    ['empty segments', 'places//photos/'],
  ];
  for (const [why, ref] of BAD) {
    __resetPlacesBudget();
    googleCalls = [];
    const res = await get(`/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=400`);
    assert.strictEqual(res.status, 400, `${why}: ${res.text}`);
    assert.strictEqual(googleCalls.length, 0, `${why}: reached Google anyway`);
    assert.strictEqual(placesBudgetStatus(1).globalUsed, 0, `${why}: charged for a call never made`);
  }
});
