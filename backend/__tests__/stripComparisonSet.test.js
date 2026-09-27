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
const { stripComparisonTypes } = venueDashboardRouter.__test;

const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({ score: 55, label: 'Moderate', predictionMethod: 'rule_engine', modelVersion: 'test' });
mlPredictor.predictHourlyForecast = async () => [{ hour: 20, score: 70 }, { hour: 21, score: 80 }];

// The owner's own listing, per place id, and every searchNearby body sent.
let listings = {};
let nearbyBodies = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchNearby')) {
    nearbyBodies.push(JSON.parse(opts.body));
    return Promise.resolve({ status: 200, json: async () => ({ places: [] }) });
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
