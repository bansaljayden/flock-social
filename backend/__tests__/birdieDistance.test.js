// Run: node --test  (from backend/)
//
// HOW FAR A VENUE IS (routes/ai.js). A search result and a crowd lookup carry
// `distance_miles` and `walk_minutes`, worked out locally from coordinates the
// turn already has, so Birdie can answer "near me", "walkable" and "closest"
// without guessing from an address. Pinned here:
//   1. the arithmetic: miles to one decimal, walking minutes on the app's own
//      pace (frontend/src/lib/travel.js), nothing past three miles on foot;
//   2. measured from the location the turn already sends Gemini, rounded to
//      two decimals, never from the exact one;
//   3. only from a fix the client says is fresh: no age, an old age or no
//      location means no result carries a distance;
//   4. never cached: the next person in the same square gets their own, or
//      none;
//   5. the crowd lookup carries it too, locked or not, and the venue cards do
//      not;
//   6. the prompt says what the fields are and forbids a guessed distance.
// Driven through the real route with Gemini, Places and the predictor faked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-distance-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;
delete process.env.CROWD_NO_CURVE_FALLBACK;

const pool = require('../config/database');
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) return Promise.resolve({ rows: [{ name: 'Maya Torres', date_of_birth: '2000-01-01' }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 11, name: 'Maya' }; next(); };
// Destructured by routes/ai.js at load, so patched first.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
mlPredictor.predictBusyness = async () => ({
  score: 55, label: crowdEngine.getLabel(55), confidence: 60, factors: {},
  dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
});
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count) => Array.from({ length: count || 12 }, (_, i) => ({
  hour: hourLabel((startHour + i) % 24), score: 55, label: crowdEngine.getLabel(55), predictionMethod: 'ml',
}));
mlPredictor.agreeWithStrip = async (headline) => headline;

// Two venues in Center City, Philadelphia: one a block from the asker, one in
// Fishtown.
const NEAR = { id: 'PLACE_NEAR_SLICE', name: 'Near Slice', lat: 39.9502, lng: -75.1667 };
const FAR = { id: 'PLACE_FAR_TACOS', name: 'Far Tacos', lat: 39.9716, lng: -75.1342 };
const placeOf = (v) => ({
  id: v.id, displayName: { text: v.name }, formattedAddress: '1 Main St, Philadelphia, PA', rating: 4.5, userRatingCount: 300,
  priceLevel: 'PRICE_LEVEL_INEXPENSIVE', types: ['restaurant', 'food'], location: { latitude: v.lat, longitude: v.lng },
  currentOpeningHours: { openNow: true, periods: [] }, utcOffsetMinutes: -300, timeZone: { id: 'America/New_York' },
});
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [placeOf(NEAR), placeOf(FAR)] }) });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const v = u.includes(FAR.id) ? FAR : NEAR;
    return Promise.resolve({ ok: true, status: 200, json: async () => placeOf(v) });
  }
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

// Gemini: a search, a crowd lookup for the far venue, then words.
const genaiMod = require('@google/genai');
let sends = [];
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: () => ({
        sendMessage: async (p) => {
          sends.push(p);
          if (sends.length === 1) return { candidates: [{ content: { parts: [{ functionCall: { id: 's1', name: 'search_venues', args: { query: 'food', location: '39.95,-75.17' } } }] } }] };
          if (sends.length === 2) return { candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'get_crowd_prediction', args: { place_id: FAR.id } } }] } }] };
          return { candidates: [{ content: { parts: [{ text: 'Near Slice, a block over.' }] } }] };
        },
      }),
    },
  };
};

const placeDetailsCache = require('../services/placeDetailsCache');
const aiRouter = require('../routes/ai');
const { venueDistance, distanceOrigin, buildSystemPrompt } = aiRouter.__testables;
const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  aiRouter.__clearBirdieSearchCache();
  placeDetailsCache.__test.reset();
  sends = [];
});

// Where the asker stands: inside the square 39.95,-75.17 rounds to, but not
// at its centre, so a distance from the exact spot and one from the rounded
// point come out different.
const HERE = { lat: 39.9511, lng: -75.1660 };
const ROUNDED = { lat: 39.95, lng: -75.17 };

async function ask(extra) {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text: 'food near me' }], location: HERE, ...extra }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const responses = sends.flatMap((s) => (Array.isArray(s.message) ? s.message : [])).map((p) => p.functionResponse).filter(Boolean);
  return {
    status: res.status,
    body,
    search: (responses.find((r) => r.name === 'search_venues') || {}).response,
    crowd: (responses.find((r) => r.name === 'get_crowd_prediction') || {}).response,
  };
}

test('miles to one decimal, walking minutes on the app pace, no walk past three miles', () => {
  const far = venueDistance(ROUNDED, FAR.lat, FAR.lng);
  assert.deepStrictEqual(far, { distance_miles: 2.4, walk_minutes: 63 });
  // A block away still reads as a tenth of a mile and a minute, never zero.
  assert.deepStrictEqual(venueDistance(ROUNDED, 39.9500, -75.1699), { distance_miles: 0.1, walk_minutes: 1 });
  // Allentown from Center City: about 50 miles, and no walk to speak of.
  const allentown = venueDistance(ROUNDED, 40.6023, -75.4714);
  assert.ok(allentown.distance_miles > 45 && allentown.distance_miles < 55, JSON.stringify(allentown));
  assert.ok(!('walk_minutes' in allentown));
  assert.strictEqual(venueDistance(null, FAR.lat, FAR.lng), null);
  assert.strictEqual(venueDistance(ROUNDED, undefined, FAR.lng), null);
});

test('the walking pace is the one the app shows on the who-is-here card', () => {
  const travel = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'travel.js'), 'utf8');
  assert.match(travel, /const ROAD_FACTOR = 1\.3;/);
  assert.match(travel, /walk: 4\.8\b/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  assert.match(src, /const WALK_ROAD_FACTOR = 1\.3;/);
  assert.match(src, /const WALK_KMH = 4\.8;/);
});

test('distances start from the rounded location, and only from a fresh fix', () => {
  assert.deepStrictEqual(distanceOrigin(HERE, 30), ROUNDED);
  assert.deepStrictEqual(distanceOrigin(HERE, 600), ROUNDED);
  assert.strictEqual(distanceOrigin(HERE, 601), null, 'a fix older than ten minutes');
  assert.strictEqual(distanceOrigin(HERE, undefined), null, 'a client that did not say how old its fix is');
  assert.strictEqual(distanceOrigin(HERE, '30'), null);
  assert.strictEqual(distanceOrigin(HERE, -1), null);
  assert.strictEqual(distanceOrigin(null, 30), null);
});

test('a fresh fix: the search and the crowd lookup the model reads carry the distance from the rounded point', async () => {
  const { status, body, search, crowd } = await ask({ locationAgeSec: 45 });
  assert.strictEqual(status, 200, JSON.stringify(body));
  const byId = new Map(search.venues.map((v) => [v.place_id, v]));
  const near = byId.get(NEAR.id);
  const far = byId.get(FAR.id);
  assert.deepStrictEqual({ d: near.distance_miles, w: near.walk_minutes }, { d: 0.2, w: 5 });
  assert.deepStrictEqual({ d: far.distance_miles, w: far.walk_minutes }, { d: 2.4, w: 63 });
  // From the exact spot the near one is a tenth of a mile: that number, and
  // the spot it would give away, never reach the model.
  assert.strictEqual(venueDistance(HERE, NEAR.lat, NEAR.lng).distance_miles, 0.1);
  assert.strictEqual(crowd.distance_miles, 2.4);
  assert.strictEqual(crowd.walk_minutes, 63);
  // The cards are drawn from fields of their own; a distance is not one.
  for (const card of body.venues) assert.ok(!('distance_miles' in card) && !('walk_minutes' in card), JSON.stringify(card));
});

test('no age, a stale fix or no location: no result carries a distance', async () => {
  for (const extra of [{}, { locationAgeSec: null }, { locationAgeSec: 3600 }, { location: null, locationAgeSec: 10 }]) {
    aiRouter.__clearBirdieSearchCache();
    placeDetailsCache.__test.reset();
    sends = [];
    const { status, search, crowd } = await ask(extra);
    assert.strictEqual(status, 200, JSON.stringify(extra));
    if (search && Array.isArray(search.venues)) {
      for (const v of search.venues) assert.ok(!('distance_miles' in v) && !('walk_minutes' in v), `${JSON.stringify(extra)}: ${JSON.stringify(v)}`);
    }
    if (crowd) assert.ok(!('distance_miles' in crowd) && !('walk_minutes' in crowd), `${JSON.stringify(extra)}: ${JSON.stringify(crowd)}`);
  }
});

test('the shared search cache never holds a distance', async () => {
  await ask({ locationAgeSec: 20 });
  sends = [];
  // The same words from the same square inside five minutes: a cache hit.
  const { search } = await ask({});
  assert.ok(search && search.venues.length === 2);
  for (const v of search.venues) assert.ok(!('distance_miles' in v), 'the first caller\'s distance reached the next caller');
});

test('the age is whole seconds or nothing', async () => {
  const { status, body } = await ask({ locationAgeSec: '45' });
  assert.strictEqual(status, 400);
  assert.match(body.error, /locationAgeSec/);
});

test('a locked crowd lookup keeps the distance, like the open state', async () => {
  const { executeTool } = aiRouter.__testables;
  const out = await executeTool('get_crowd_prediction', { place_id: FAR.id }, 77, {
    includeForecast: false, salesOff: false, searchedPlaces: new Map(), timeZone: null, distanceFrom: ROUNDED,
  });
  assert.strictEqual(out.forecast_locked, true);
  assert.ok(!('crowd_score' in out));
  assert.strictEqual(out.distance_miles, 2.4);
});

test('the prompt says what the distance is and forbids a guessed one', () => {
  const prompt = buildSystemPrompt('Maya', {}, { ageBracket: 'adult' });
  assert.match(prompt, /may carry `distance_miles` and `walk_minutes`: how far that venue is in a straight line from the location in their message/);
  assert.match(prompt, /say them as about/);
  assert.match(prompt, /They measure from where the person is now, not from a place they name\./);
  assert.match(prompt, /A venue whose result has no `distance_miles` has no known distance: never say or guess how near or far it is, how long it takes to get there, or that it is walkable\./);
});
