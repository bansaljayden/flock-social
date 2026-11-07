// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A SHORT QUERY IS RANKED BY DISTANCE (2026-11-06, S4 of a tester's recording).
// ---------------------------------------------------------------------------
// "tor" typed in Bethlehem PA came back with Tor Chimney & Fireplace 40 km away
// and High Tor State Park 125 km away, and the restaurant 16 km away showed up
// only once the whole word was typed. The search sent Google a 20 km
// locationBias and nothing else, and a bias only leans: for a prefix that
// matches little, Google's relevance ranking is free to lead with places far
// outside the circle.
//
// A query under five characters now asks Google to rank by DISTANCE from the
// same circle (rankPreference). The bias stays, so the answer is never
// narrower than before: nothing is restricted away, and there is nothing to
// fall back from when the distance-ranked answer is empty. Text Search's
// locationRestriction takes only a rectangle, and a restricted search that
// came back empty would need a second, paid call to fall back to the bias.
// So the count of Places calls is unchanged: ONE per uncached search, short or
// long, and none for a cached or coalesced one. Places is stubbed here; no
// request leaves the machine.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-search-short-query-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';

const { __resetPlacesBudget, placesBudgetStatus } = require('../utils/placesBudget');

const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

const place = (id, name, lat, lng) => ({
  id, displayName: { text: name }, formattedAddress: name, types: ['restaurant'], location: { latitude: lat, longitude: lng },
});
let googleCalls = [];
let googleAnswer = null;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    googleCalls.push({ url: u, body: JSON.parse(opts.body) });
    const answer = googleAnswer || { places: [place('P_TORRE', 'Torre', 40.5512, -75.4072)] };
    return Promise.resolve({ ok: true, status: 200, json: async () => answer });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const venueSearchRouter = require('../routes/venueSearch');

const app = express();
app.use(express.json());
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

test.beforeEach(() => {
  __resetPlacesBudget();
  venueSearchRouter.__test.clearVenueCache();
  googleCalls = [];
  googleAnswer = null;
});

async function get(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

const HERE = '40.6259,-75.3705';
const search = (q, loc = HERE) => get(`/api/venues/search?query=${encodeURIComponent(q)}${loc ? `&location=${loc}` : ''}`);
const used = () => { const st = placesBudgetStatus(7); return st.limits.perUserHourly - st.userRemaining; };
const BIAS = { circle: { center: { latitude: 40.63, longitude: -75.37 }, radius: 20000 } };

test('"tor" asks Google to rank by distance from the same 20 km circle, in one call', async () => {
  const res = await search('tor');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(googleCalls.length, 1);
  const body = googleCalls[0].body;
  assert.strictEqual(body.textQuery, 'tor');
  assert.strictEqual(body.rankPreference, 'DISTANCE');
  // The bias stays: the answer is ordered nearest first, never narrowed.
  assert.deepStrictEqual(body.locationBias, BIAS);
  assert.strictEqual(body.locationRestriction, undefined);
  assert.strictEqual(used(), 1);
});

test('four characters is still short; five is a word, ranked as before', async () => {
  await search('pubs');
  await search('torre');
  await search('high tor');
  assert.strictEqual(googleCalls.length, 3);
  assert.strictEqual(googleCalls[0].body.rankPreference, 'DISTANCE');
  assert.strictEqual(googleCalls[1].body.rankPreference, undefined);
  assert.strictEqual(googleCalls[2].body.rankPreference, undefined);
  for (const c of googleCalls) assert.deepStrictEqual(c.body.locationBias, BIAS);
});

test('the length is the query Google is sent: casing and spaces folded, letters counted as letters', async () => {
  await search('  TOR  ');
  // "cafe" with its accent typed as a combining mark: five code units as
  // typed, four letters once folded (NFKC), and four is what Google is sent.
  await search('cafe\u0301');
  assert.strictEqual(googleCalls.length, 2);
  assert.strictEqual(googleCalls[0].body.textQuery, 'tor');
  assert.strictEqual(googleCalls[0].body.rankPreference, 'DISTANCE');
  assert.strictEqual(googleCalls[1].body.textQuery, 'caf\u00e9');
  assert.strictEqual(googleCalls[1].body.rankPreference, 'DISTANCE');
});

test('with no location there is nothing to measure from, so nothing changes', async () => {
  await search('tor', null);
  assert.strictEqual(googleCalls.length, 1);
  assert.strictEqual(googleCalls[0].body.rankPreference, undefined);
  assert.strictEqual(googleCalls[0].body.locationBias, undefined);
});

test('an empty distance-ranked answer is the answer: no second paid call', async () => {
  googleAnswer = {};
  const res = await search('xqz');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { venues: [], total: 0 });
  assert.strictEqual(googleCalls.length, 1);
  assert.strictEqual(used(), 1);
});

test('a short query is cached like any other: the same question twice is one call', async () => {
  await search('tor');
  await search('Tor');
  assert.strictEqual(googleCalls.length, 1);
  assert.strictEqual(used(), 1);
});
