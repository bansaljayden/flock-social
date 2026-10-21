// Run: node --test  (from backend/)
//
// A PLACE TAPPED ON THE DISCOVER MAP OPENS AS A VENUE, IN ANY CITY
// (services/poiPlaceResolver.js, GET /api/venues/resolve-poi).
//
// The basemap draws restaurants, cafes, bars, clubs, cinemas and museums from
// street zoom. A tap sends the glyph's name and point; the server answers with
// the Google place id the venue sheet opens. What is pinned here is the money
// and the match:
//   * the field mask is `places.id` and nothing else, which Google bills as
//     Text Search Essentials (IDs Only), listed at unlimited free usage;
//   * the result is RESTRICTED to a box about 150 m around the tap;
//   * one Google call is one unit of the caller's Places allowance, charged
//     only when Google is actually asked: a cached answer, a "nothing there"
//     answer within the hour, and a tap that joins one already in flight cost
//     nothing;
//   * a refused charge asks Google nothing, and a failure is never cached.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'poi-resolver-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';

const resolver = require('../services/poiPlaceResolver');
const { __resetPlacesBudget, PER_USER_HOURLY, placesBudgetStatus } = require('../utils/placesBudget');

const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 11, name: 'Maya' }; next(); };

const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

function fakeGoogle(answer, { status = 200, delayMs = 0, rejectWith = null } = {}) {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ url: String(url), opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (rejectWith) return Promise.reject(rejectWith);
    const reply = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer,
    };
    return delayMs ? new Promise((r) => setTimeout(() => r(reply), delayMs)) : Promise.resolve(reply);
  };
  return { fetchImpl, calls };
}

test.beforeEach(() => {
  resolver.__test.clear();
  __resetPlacesBudget();
});

test('the field mask is the place id alone, the free IDs-only tier', () => {
  assert.strictEqual(resolver.POI_FIELD_MASK, 'places.id');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'poiPlaceResolver.js'), 'utf8');
  // The request sends that constant and no other mask.
  assert.match(src, /'X-Goog-FieldMask': POI_FIELD_MASK,/);
  assert.strictEqual((src.match(/X-Goog-FieldMask/g) || []).length, 1);
});

test('a name is folded like a search query and bounded', () => {
  assert.strictEqual(resolver.normalizePoiName('  Joe’s   Pizza \n'), 'Joe’s Pizza');
  assert.strictEqual(resolver.normalizePoiName('Ｊｏｅ'), 'Joe'); // full-width folds
  assert.strictEqual(resolver.normalizePoiName(''), null);
  assert.strictEqual(resolver.normalizePoiName('   '), null);
  assert.strictEqual(resolver.normalizePoiName(['a', 'b']), null);
  assert.strictEqual(resolver.normalizePoiName(42), null);
  assert.strictEqual(resolver.normalizePoiName('x'.repeat(resolver.POI_NAME_MAX)), 'x'.repeat(resolver.POI_NAME_MAX));
  assert.strictEqual(resolver.normalizePoiName('x'.repeat(resolver.POI_NAME_MAX + 1)), null);
});

test('the box is about 150 m each way, wider in longitude away from the equator', () => {
  const b = resolver.boxAround(40, -75);
  const dLat = b.high.latitude - 40;
  const dLng = b.high.longitude - -75;
  assert.ok(Math.abs(dLat * 111320 - 150) < 0.5, `dLat ${dLat}`);
  assert.ok(Math.abs(dLng * 111320 * Math.cos((40 * Math.PI) / 180) - 150) < 0.5, `dLng ${dLng}`);
  assert.ok(Math.abs(b.low.latitude - (40 - dLat)) < 1e-12);
  // Near a pole the box stays finite and on the globe.
  const p = resolver.boxAround(89.99, 179.999);
  assert.ok(p.high.latitude <= 90 && p.high.longitude <= 180 && Number.isFinite(p.low.longitude));
});

test('a found place: one restricted IDs-only call, one unit, and the id', async () => {
  const g = fakeGoogle({ places: [{ id: PLACE_ID }] });
  let charges = 0;
  const out = await resolver.lookupPoiPlace({
    name: 'Joe’s Pizza', lat: 37.3229, lng: -122.0322, apiKey: 'k',
    charge: () => { charges += 1; return true; }, fetchImpl: g.fetchImpl,
  });
  assert.deepStrictEqual(out, { status: 200, placeId: PLACE_ID });
  assert.strictEqual(charges, 1);
  assert.strictEqual(g.calls.length, 1);
  const call = g.calls[0];
  assert.strictEqual(call.url, 'https://places.googleapis.com/v1/places:searchText');
  assert.strictEqual(call.opts.headers['X-Goog-FieldMask'], 'places.id');
  assert.strictEqual(call.body.textQuery, 'Joe’s Pizza');
  assert.strictEqual(call.body.pageSize, 1);
  assert.ok(call.body.locationRestriction && call.body.locationRestriction.rectangle);
  assert.strictEqual(call.body.locationBias, undefined);
});

test('the same place again is answered from the cache: no call, no unit', async () => {
  const g = fakeGoogle({ places: [{ id: PLACE_ID }] });
  let charges = 0;
  const args = { name: 'Blue Door Cafe', lat: 30.2672, lng: -97.7431, apiKey: 'k', charge: () => { charges += 1; return true; }, fetchImpl: g.fetchImpl };
  await resolver.lookupPoiPlace(args);
  const again = await resolver.lookupPoiPlace({ ...args, name: 'blue door cafe', lat: 30.26721, lng: -97.74312 });
  assert.deepStrictEqual(again, { status: 200, placeId: PLACE_ID });
  assert.strictEqual(g.calls.length, 1);
  assert.strictEqual(charges, 1);
});

test('taps that arrive together share one call and one unit', async () => {
  const g = fakeGoogle({ places: [{ id: PLACE_ID }] }, { delayMs: 20 });
  let charges = 0;
  const args = { name: 'Harbor Grill', lat: 41.0, lng: -73.0, apiKey: 'k', charge: () => { charges += 1; return true; }, fetchImpl: g.fetchImpl };
  const outs = await Promise.all([resolver.lookupPoiPlace(args), resolver.lookupPoiPlace(args), resolver.lookupPoiPlace(args)]);
  for (const o of outs) assert.deepStrictEqual(o, { status: 200, placeId: PLACE_ID });
  assert.strictEqual(g.calls.length, 1);
  assert.strictEqual(charges, 1);
});

test('nothing there is a 404, and it is remembered for the hour', async () => {
  const g = fakeGoogle({});
  let charges = 0;
  const args = { name: 'Corner Kiosk', lat: 10, lng: 10, apiKey: 'k', charge: () => { charges += 1; return true; }, fetchImpl: g.fetchImpl };
  assert.deepStrictEqual(await resolver.lookupPoiPlace(args), { status: 404 });
  assert.deepStrictEqual(await resolver.lookupPoiPlace(args), { status: 404 });
  assert.strictEqual(g.calls.length, 1);
  assert.strictEqual(charges, 1);
  assert.strictEqual(resolver.__test.NOT_FOUND_TTL_MS, 60 * 60 * 1000);
});

test('an id that is not shaped like a place id is treated as nothing there', async () => {
  const g = fakeGoogle({ places: [{ id: '../../evil?x=1' }] });
  const out = await resolver.lookupPoiPlace({ name: 'Odd', lat: 1, lng: 1, apiKey: 'k', charge: () => true, fetchImpl: g.fetchImpl });
  assert.deepStrictEqual(out, { status: 404 });
});

test('a refused charge asks Google nothing', async () => {
  const g = fakeGoogle({ places: [{ id: PLACE_ID }] });
  const out = await resolver.lookupPoiPlace({ name: 'Joe’s Pizza', lat: 2, lng: 2, apiKey: 'k', charge: () => false, fetchImpl: g.fetchImpl });
  assert.deepStrictEqual(out, { status: 429, refused: true });
  assert.strictEqual(g.calls.length, 0);
});

test('failures are never cached, so the next tap asks again', async () => {
  const errorBody = fakeGoogle({ error: { status: 'PERMISSION_DENIED', message: 'API key not valid.' } }, { status: 403 });
  const args = { name: 'Nope', lat: 3, lng: 3, apiKey: 'k', charge: () => true, fetchImpl: errorBody.fetchImpl };
  assert.deepStrictEqual(await resolver.lookupPoiPlace(args), { status: 502 });
  assert.deepStrictEqual(await resolver.lookupPoiPlace(args), { status: 502 });
  assert.strictEqual(errorBody.calls.length, 2);

  const edge = fakeGoogle({ message: 'backend unavailable' }, { status: 503 });
  assert.deepStrictEqual(await resolver.lookupPoiPlace({ ...args, name: 'Edge', fetchImpl: edge.fetchImpl }), { status: 502 });

  const malformed = fakeGoogle({ places: 'nope' });
  assert.deepStrictEqual(await resolver.lookupPoiPlace({ ...args, name: 'Malformed', fetchImpl: malformed.fetchImpl }), { status: 502 });

  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const slow = fakeGoogle(null, { rejectWith: timeout });
  assert.deepStrictEqual(await resolver.lookupPoiPlace({ ...args, name: 'Slow', fetchImpl: slow.fetchImpl }), { status: 504 });
  assert.strictEqual(resolver.__test.cacheSize(), 0);
});

test('the cache is bounded, oldest out first, down to the low-water mark', () => {
  const { POI_CACHE_MAX, POI_CACHE_LOW_WATER, writeCache, cacheSize } = resolver.__test;
  for (let i = 0; i <= POI_CACHE_MAX; i += 1) writeCache(`k${i}`, PLACE_ID);
  assert.strictEqual(cacheSize(), POI_CACHE_LOW_WATER);
  assert.strictEqual(resolver.__test.readCache('k0'), null);
  assert.ok(resolver.__test.readCache(`k${POI_CACHE_MAX}`));
});

// --- the route --------------------------------------------------------------

let googleAnswer = null;
let googleStatus = 200;
let googleCalls = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (String(url).startsWith('https://places.googleapis.com/')) {
    googleCalls += 1;
    const answer = googleAnswer || {};
    return Promise.resolve({ ok: googleStatus >= 200 && googleStatus < 300, status: googleStatus, json: async () => answer });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const venueSearchRouter = require('../routes/venueSearch');
const app = express();
app.use('/api/venues', venueSearchRouter);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

async function get(qs) {
  const res = await realFetch(`${base}/api/venues/resolve-poi?${qs}`);
  return { status: res.status, body: await res.json() };
}

test('the route answers the place id, and a second tap is free', async () => {
  googleAnswer = { places: [{ id: PLACE_ID }] };
  googleStatus = 200;
  googleCalls = 0;
  const qs = `name=${encodeURIComponent('Wilder')}&lat=39.9496&lng=-75.1712`;
  const first = await get(qs);
  assert.deepStrictEqual(first, { status: 200, body: { place_id: PLACE_ID } });
  const second = await get(qs);
  assert.deepStrictEqual(second, { status: 200, body: { place_id: PLACE_ID } });
  assert.strictEqual(googleCalls, 1);
  assert.strictEqual(placesBudgetStatus(11).userRemaining, PER_USER_HOURLY - 1);
});

test('nothing there reads as a sentence that suggests search', async () => {
  googleAnswer = {};
  googleStatus = 200;
  const out = await get(`name=${encodeURIComponent('Mystery Spot')}&lat=12.5&lng=12.5`);
  assert.strictEqual(out.status, 404);
  assert.match(out.body.error, /search/i);
});

test('malformed input is refused before it costs a unit', async () => {
  googleCalls = 0;
  for (const qs of ['lat=1&lng=1', 'name=&lat=1&lng=1', 'name=A&lat=91&lng=1', 'name=A&lat=1&lng=181',
    'name=A&lat=abc&lng=1', 'name=A&name=B&lat=1&lng=1', 'name=A&lat=1&lat=2&lng=1',
    `name=${'x'.repeat(121)}&lat=1&lng=1`]) {
    const out = await get(qs);
    assert.strictEqual(out.status, 400, qs);
  }
  assert.strictEqual(googleCalls, 0);
  assert.strictEqual(placesBudgetStatus(11).userRemaining, PER_USER_HOURLY);
});

test('a spent allowance is a 429 that names the hour, and Google is not asked', async () => {
  googleAnswer = { places: [{ id: PLACE_ID }] };
  googleCalls = 0;
  for (let i = 0; i < PER_USER_HOURLY; i += 1) {
    const out = await get(`name=Place${i}&lat=20&lng=${(20 + i / 100).toFixed(4)}`);
    assert.strictEqual(out.status, 200);
  }
  const before = googleCalls;
  const refused = await get('name=OneTooMany&lat=21&lng=21');
  assert.strictEqual(refused.status, 429);
  assert.match(refused.body.error, /an hour/);
  assert.strictEqual(googleCalls, before);
});

test('an upstream failure is a plain sentence, not Google’s', async () => {
  googleAnswer = { error: { status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Requests'" } };
  googleStatus = 429;
  const out = await get('name=Busy&lat=33&lng=33');
  assert.strictEqual(out.status, 502);
  assert.doesNotMatch(out.body.error, /quota|api key/i);
});
