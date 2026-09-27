// Run: node --test  (from backend/)
//
// ===========================================================================
// THE STRIP COMPARES A VENUE WITH ITS OWN KIND, NOT WITH BARS BY DEFAULT.
//
// GET /api/venue-dashboard/strip searches the venues within 1.5 km and lays
// their evening peaks beside the owner's. It kept only bar, night_club and
// restaurant from the owner's Google types, and when none of those matched it
// searched `includedTypes: ['bar']`. So a coffee shop on Roost (Google types
// cafe, coffee_shop, food) was shown the bars around it as "Your Strip
// Tonight", with "projected busier than you tonight" lines, a category it does
// not compete with, on a plan it pays for.
//
// Pinned here, through the real route with Places faked:
//   1. A bar, club or restaurant still compares against those types, as before.
//   2. Any other venue compares against Google's primaryType for it.
//   3. With no primaryType, the first specific type on the listing is used,
//      never one of Google's catch-all tags.
//   4. A listing that names no kind at all gets `available: false` and a
//      reason, and buys no search, instead of borrowing 'bar'.
//   5. Google's address and region tags are never the fallback kind, because
//      searchNearby refuses them as a filter.
//   6. The hours follow the comparison: bars, clubs and restaurants are ranked
//      on 5 PM to midnight, anything else on its whole day, and the answer
//      carries `peakWindow` so the dashboard says "today" or "tonight".
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'strip-comparison-set-test-secret';
// Set BEFORE requiring the router: venueDashboard captures the key at load.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

let profiles = {};
pool.query = async (sql, params) => {
  const text = String(sql).replace(/\s+/g, ' ');
  if (/FROM venue_profiles WHERE user_id = \$1/.test(text)) {
    const row = profiles[params[0]];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  // Anything else the scoring path reads (feedback, owner readings) is empty.
  return { rows: [], rowCount: 0 };
};

const placesBudget = require('../utils/placesBudget');
let searchCharges = 0;
placesBudget.allowPlacesSearch = () => { searchCharges += 1; return true; };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');
const { stripComparisonTypes, stripPeakWindow, STRIP_PEAK_WINDOWS } = venueDashboardRouter.__test;
const { describe } = test;

const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({ score: 55, label: 'Moderate', predictionMethod: 'rule_engine', modelVersion: 'test' });
// Every window a row's peak was read from, as [startHour, count].
let forecastWindows = [];
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) => {
  forecastWindows.push([startHour, count]);
  return [{ hour: 20, score: 70 }, { hour: 21, score: 80 }];
};

// The owner's own listing, per place id, every searchNearby body sent, and
// what the search finds (nobody, unless a case says otherwise).
let listings = {};
let nearbyBodies = [];
let listingsNearby = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchNearby')) {
    nearbyBodies.push(JSON.parse(opts.body));
    return Promise.resolve({ status: 200, json: async () => ({ places: listingsNearby }) });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length));
    return Promise.resolve({ status: 200, json: async () => listings[id] });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

// A fresh place id per case: the strip caches its answer by place id and hour,
// and a cached answer would skip the search this file is watching.
let seq = 0;
function venueWith({ types, primaryType }) {
  seq += 1;
  const id = `ChIJstripKind${String(seq).padStart(6, '0')}`;
  listings[id] = {
    id,
    displayName: { text: `Venue ${seq}` },
    rating: 4.4,
    userRatingCount: 120,
    types,
    ...(primaryType ? { primaryType } : {}),
    location: { latitude: 39.74, longitude: -104.98 },
    currentOpeningHours: { openNow: true },
    utcOffsetMinutes: -360,
  };
  profiles[CURRENT_USER.id] = { id: 3, google_place_id: id, verified: true, category: null, verification_requested_at: null };
  return id;
}

async function strip() {
  const res = await realFetch(`${base}/api/venue-dashboard/strip`);
  return { status: res.status, body: await res.json() };
}

test.beforeEach(() => {
  nearbyBodies = [];
  searchCharges = 0;
  forecastWindows = [];
});

test('a coffee shop is compared with coffee shops, not with the bars around it', async () => {
  venueWith({ types: ['coffee_shop', 'cafe', 'food', 'point_of_interest', 'establishment'], primaryType: 'coffee_shop' });
  const r = await strip();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
  assert.strictEqual(nearbyBodies.length, 1);
  assert.deepStrictEqual(nearbyBodies[0].includedTypes, ['coffee_shop']);
});

test('a brewery with no primaryType on its listing uses its first specific type', async () => {
  venueWith({ types: ['food', 'brewery', 'point_of_interest', 'establishment'] });
  const r = await strip();
  assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
  assert.deepStrictEqual(nearbyBodies[0].includedTypes, ['brewery'],
    "a catch-all tag like 'food' was sent as the comparison type");
});

test('bars, clubs and restaurants keep the comparison they had', async () => {
  venueWith({ types: ['bar', 'restaurant', 'food', 'point_of_interest', 'establishment'], primaryType: 'bar' });
  await strip();
  assert.deepStrictEqual(nearbyBodies[0].includedTypes, ['bar', 'restaurant']);

  venueWith({ types: ['night_club', 'bar', 'point_of_interest', 'establishment'], primaryType: 'night_club' });
  await strip();
  assert.deepStrictEqual(nearbyBodies[1].includedTypes, ['bar', 'night_club']);
});

test('a listing that names no kind of place is told so, and buys no search', async () => {
  venueWith({ types: ['point_of_interest', 'establishment'] });
  const r = await strip();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.available, false);
  assert.match(r.body.reason, /nothing to compare it against/);
  assert.strictEqual(nearbyBodies.length, 0, "the strip searched anyway, which is how 'bar' got borrowed");
  // One charge: the owner's own listing. The search was never paid for.
  assert.strictEqual(searchCharges, 1);
});

test('the rule, directly: never bars by default', () => {
  assert.deepStrictEqual(stripComparisonTypes({ types: ['cafe', 'food'], primary_type: 'cafe' }), ['cafe']);
  assert.deepStrictEqual(stripComparisonTypes({ types: ['store', 'book_store'] }), ['book_store']);
  assert.deepStrictEqual(stripComparisonTypes({ types: ['administrative_area_level_1', 'locality', 'point_of_interest'] }), null);
  assert.strictEqual(stripComparisonTypes({ types: [] }), null);
  assert.strictEqual(stripComparisonTypes(null), null);
});

// searchNearby refuses these as a filter, and the strip would count that
// refusal as a Places failure, so none of them may ever be the fallback.
test("none of Google's address and region tags is sent as the kind of place", () => {
  for (const tag of ['postal_town', 'street_number', 'archipelago', 'continent',
    'postal_code_prefix', 'postal_code_suffix', 'sublocality_level_2', 'administrative_area_level_7']) {
    assert.strictEqual(stripComparisonTypes({ types: [tag, 'point_of_interest', 'establishment'] }), null,
      `${tag} was sent as the comparison type`);
    assert.deepStrictEqual(stripComparisonTypes({ types: [tag, 'florist'] }), ['florist']);
  }
});

// THE HOURS FOLLOW THE COMPARISON. A coffee shop's strip is coffee shops now,
// and ranking them on 5 PM to midnight scores every row on hours they are
// shut, under a heading that says "tonight".
describe('the hours each strip ranks on', () => {
  test('a coffee shop and every coffee shop beside it are read over the whole day, and the answer says so', async () => {
    venueWith({ types: ['coffee_shop', 'cafe', 'food', 'point_of_interest', 'establishment'], primaryType: 'coffee_shop' });
    listingsNearby = [{ id: 'ChIJnearbyCafe01', displayName: { text: 'Next Door Coffee' }, types: ['coffee_shop'], location: { latitude: 39.741, longitude: -104.981 } }];
    const r = await strip();
    listingsNearby = [];
    assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.peakWindow, 'day');
    // The owner and the one competitor, both on the same whole day.
    assert.deepStrictEqual(forecastWindows, [[0, 24], [0, 24]]);
  });

  test('a bar is still read over the evening, 5 PM to midnight, and the answer says so', async () => {
    venueWith({ types: ['bar', 'point_of_interest', 'establishment'], primaryType: 'bar' });
    const r = await strip();
    assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.peakWindow, 'evening');
    assert.deepStrictEqual(forecastWindows, [[17, 7]]);
  });

  test('the rule, directly', () => {
    assert.strictEqual(stripPeakWindow(['bar', 'restaurant']), 'evening');
    assert.strictEqual(stripPeakWindow(['night_club']), 'evening');
    assert.strictEqual(stripPeakWindow(['coffee_shop']), 'day');
    assert.strictEqual(stripPeakWindow(['brewery']), 'day');
    assert.strictEqual(stripPeakWindow(null), 'day');
    assert.deepStrictEqual({ ...STRIP_PEAK_WINDOWS.evening }, { startHour: 17, count: 7 });
    assert.deepStrictEqual({ ...STRIP_PEAK_WINDOWS.day }, { startHour: 0, count: 24 });
  });
});
