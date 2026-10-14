// Run: node --test  (from backend/)
//
// ===========================================================================
// THE CARD'S CAPACITY IS THE OWNER'S WHEN A VERIFIED OWNER GAVE ONE.
//
// Venue intake asks an owner how many people fit (validators/venueIntake.js,
// 1 to 20,000). The card's capacity was always crowdEngine.estimateCapacity's
// ladder of place types and review counts. What this file pins:
//
//   * estimateCapacity prefers an owner figure the validator would accept,
//     marks it source 'owner', and otherwise answers exactly as before;
//   * the read (ownerReports.getOwnerCapacity) asks only for a verified
//     profile of this place id whose owner is not banned, and a failed read
//     is the ladder's answer, never an error;
//   * the card route publishes it, fresh and from the cache, and an owner's
//     live reading keeps the owner's capacity when it re-derives `current`.
//
// The route runs for real against stubbed upstreams: Google, the weather
// service, the predictor's two entry points and Postgres.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'owner-capacity-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.TICKETMASTER_API_KEY;

const { pinClock } = require('./helpers/pinnedClock');
const pinnedClock = pinClock(Date.UTC(2026, 6, 15, 12, 0, 0));
test.after(() => pinnedClock.restore());

const crowdEngine = require('../services/crowdEngine');
const ownerReports = require('../services/ownerReports');

// --- scripted pg ------------------------------------------------------------
const pool = require('../config/database');
let queries = [];
let capacityRows = {};
let ownerRows = {};
let capacityReadFails = false;
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params: params || [] });
  if (/^SELECT vp\.capacity FROM venue_profiles vp/.test(flat)) {
    if (capacityReadFails) return Promise.reject(new Error('connection reset'));
    const row = capacityRows[params[0]];
    return Promise.resolve({ rows: row === undefined ? [] : [{ capacity: row }] });
  }
  if (/DISTINCT ON \(r\.google_place_id\)/.test(flat)) {
    const ids = Array.isArray(params && params[0]) ? params[0] : [];
    return Promise.resolve({ rows: ids.map((id) => ownerRows[id]).filter(Boolean) });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3, isRaining: false, conditionId: 800, fetchedAt: Date.now() });
weatherService.getHourlyForecast = async () => null;

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 4201, name: 'Cap' }; next(); };

const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;

function hourLabel(h24) {
  const h = ((h24 % 24) + 24) % 24;
  const period = h >= 12 ? 'PM' : 'AM';
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display} ${period}`;
}

const mlPredictor = require('../services/mlPredictor');
const MODEL_NOW = 50;
mlPredictor.predictBusyness = async () => ({
  score: MODEL_NOW,
  label: crowdEngine.getLabel(MODEL_NOW),
  confidence: 60,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: 'capacity-test',
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => ({
    hour: hourLabel((startHour + i) % 24),
    score: MODEL_NOW,
    label: crowdEngine.getLabel(MODEL_NOW),
    predictionMethod: 'ml',
    baselineScore: MODEL_NOW,
  }));

const PLACES = new Map();
const realFetch = global.fetch;
const PLACES_PREFIX = 'https://places.googleapis.com/v1/places/';
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith(PLACES_PREFIX)) {
    const id = decodeURIComponent(u.slice(PLACES_PREFIX.length).split('?')[0]);
    const place = PLACES.get(id);
    return Promise.resolve(place
      ? { ok: true, status: 200, json: async () => place }
      : { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', message: 'not found' } }) });
  }
  return realFetch(url, opts);
};

const crowdRouter = require('../routes/crowd');
const placeDetailsCache = require('../services/placeDetailsCache');
const { __resetPlacesBudget } = require('../utils/placesBudget');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  global.fetch = realFetch;
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  queries = [];
  capacityRows = {};
  ownerRows = {};
  capacityReadFails = false;
  __resetPlacesBudget();
  placeDetailsCache.__test.reset();
  crowdRouter.__test.clearCache();
});

async function card(id) {
  const res = await realFetch(`${base}/api/crowd/${id}`);
  return { status: res.status, body: await res.json() };
}

let seq = 0;
const freshId = (tag) => `ChIJcapacity${tag}${String(++seq).padStart(5, '0')}`;

function barPlace(id) {
  return {
    id,
    displayName: { text: 'The Capacity Bar' },
    formattedAddress: '1 Test St',
    rating: 4.4,
    userRatingCount: 1500,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 39.95, longitude: -75.16 },
    currentOpeningHours: { openNow: true, periods: [{ open: { day: 0, hour: 0, minute: 0 } }] },
    utcOffsetMinutes: 0,
  };
}

// ===========================================================================
// estimateCapacity
// ===========================================================================

test('an owner figure the intake would accept wins over the ladder, and says so', () => {
  const venue = { types: ['bar'], user_ratings_total: 1500 };
  assert.deepStrictEqual(crowdEngine.estimateCapacity(venue, 50, 220), { current: 110, max: 220, source: 'owner' });
  assert.deepStrictEqual(crowdEngine.estimateCapacity(venue, 0, 220), { current: 0, max: 220, source: 'owner' });
  assert.deepStrictEqual(crowdEngine.estimateCapacity(venue, 100, 220), { current: 220, max: 220, source: 'owner' });
  assert.deepStrictEqual(crowdEngine.estimateCapacity(venue, 50, 1), { current: 1, max: 1, source: 'owner' });
  assert.deepStrictEqual(crowdEngine.estimateCapacity(venue, 50, 20000).max, 20000);
});

test('anything the intake would refuse leaves the ladder answering exactly as before', () => {
  const venue = { types: ['bar'], user_ratings_total: 1500 };
  const ladder = crowdEngine.estimateCapacity(venue, 50);
  assert.deepStrictEqual(ladder, { current: 100, max: 200 }, 'the bar ladder at 1,000+ reviews');
  for (const bad of [undefined, null, '', 0, -5, 20001, 120.5, NaN, Infinity, true, false, 'lots', {}]) {
    assert.deepStrictEqual(crowdEngine.estimateCapacity(venue, 50, bad), ladder, `owner capacity ${String(bad)}`);
  }
  assert.strictEqual(crowdEngine.ownerCapacityMax('220'), 220, 'pg may hand an INTEGER back as text');
});

// ===========================================================================
// The read
// ===========================================================================

test('the read asks only for a verified, unbanned owner of this place id', async () => {
  const sql = ownerReports.OWNER_CAPACITY_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /vp\.google_place_id = \$1/);
  assert.match(sql, /vp\.verified = true/);
  assert.match(sql, /JOIN users ou ON ou\.id = vp\.user_id AND ou\.is_banned IS NOT TRUE/);
  assert.match(sql, /vp\.capacity IS NOT NULL/);
  assert.match(sql, /LIMIT 1/);
  capacityRows = { ChIJcapread0001: 180 };
  assert.strictEqual(await ownerReports.getOwnerCapacity('ChIJcapread0001'), 180);
  assert.strictEqual(await ownerReports.getOwnerCapacity('ChIJcapread0002'), null);
  assert.strictEqual(await ownerReports.getOwnerCapacity(''), null);
  assert.strictEqual(await ownerReports.getOwnerCapacity(null), null);
  // A stored value outside the intake's bounds is not a capacity.
  capacityRows = { ChIJcapread0003: 0 };
  assert.strictEqual(await ownerReports.getOwnerCapacity('ChIJcapread0003'), null);
});

test('a failed read is the ladder, never an error', async () => {
  capacityReadFails = true;
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.strictEqual(await ownerReports.getOwnerCapacity('ChIJcapread0004'), null);
  } finally {
    console.error = original;
  }
  assert.strictEqual(errors.length, 1);
});

// ===========================================================================
// The card
// ===========================================================================

test('the card publishes the owner capacity, fresh and from the cache', async () => {
  const id = freshId('CARD');
  PLACES.set(id, barPlace(id));
  capacityRows[id] = 240;
  const fresh = await card(id);
  assert.strictEqual(fresh.status, 200);
  assert.deepStrictEqual(fresh.body.capacity, { current: 120, max: 240, source: 'owner' });
  const read = queries.filter((q) => /^SELECT vp\.capacity FROM venue_profiles/.test(q.sql));
  assert.strictEqual(read.length, 1);
  assert.deepStrictEqual(read[0].params, [id]);
  const cached = await card(id);
  assert.deepStrictEqual(cached.body.capacity, fresh.body.capacity);
});

test('with no owner figure the card keeps the ladder', async () => {
  const id = freshId('LADDER');
  PLACES.set(id, barPlace(id));
  const res = await card(id);
  assert.deepStrictEqual(res.body.capacity, crowdEngine.estimateCapacity({ types: ['bar'], user_ratings_total: 1500 }, MODEL_NOW));
});

test('a failed capacity read still serves the card, on the ladder', async () => {
  const id = freshId('FAIL');
  PLACES.set(id, barPlace(id));
  capacityReadFails = true;
  const original = console.error;
  console.error = () => {};
  let res;
  try {
    res = await card(id);
  } finally {
    console.error = original;
  }
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.capacity, { current: 100, max: 200 });
});

test('an owner live reading re-derives current from the owner capacity and keeps its source', async () => {
  const id = freshId('LIVE');
  PLACES.set(id, barPlace(id));
  capacityRows[id] = 300;
  const at = new Date(Date.now() - 5 * 60 * 1000);
  ownerRows[id] = {
    id: 91, google_place_id: id, busy_percent: 90, created_at: at, diverged: false,
    profile_category: 'bar', assertion_since: at,
  };
  const res = await card(id);
  assert.strictEqual(res.body.score, 90);
  assert.deepStrictEqual(res.body.capacity, { current: 270, max: 300, source: 'owner' });
});
