// Run: node --test  (from backend/)
//
// ONE ROW PER PLACE IN A SEARCH ANSWER (utils/searchRowDedupe.js, 2026-11-06).
// Typing "tor" in Discover listed "Tor Chimney & Fireplace" twice in one
// answer. Pinned here: a repeated place id is dropped, a same-named row within
// 150 m of one above it is dropped, the first row is the one kept with its own
// fields, and the route caches the clean list. The places are stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'search-row-dedupe-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';

const { dedupeSearchRows, normalizedName } = require('../utils/searchRowDedupe');

const row = (id, name, lat, lng, extra = {}) => ({ place_id: id, name, location: lat == null ? null : { latitude: lat, longitude: lng }, ...extra });

test('a place id already listed is dropped, and the first row is the one kept', () => {
  const out = dedupeSearchRows([
    row('A', 'Kiln & Hearth Supply', 40.31, -75.13, { rating: 4.9 }),
    row('B', 'Hearthside Park', 41.15, -73.99),
    row('A', 'Kiln & Hearth Supply', 40.31, -75.13, { rating: 1.0 }),
  ]);
  assert.deepStrictEqual(out.map((r) => r.place_id), ['A', 'B']);
  assert.strictEqual(out[0].rating, 4.9);
});

test('the same name within 150 m is one place; farther off, or another name, is not', () => {
  const out = dedupeSearchRows([
    row('A', 'Kiln & Hearth Supply', 40.31, -75.13, { photo_url: '/a.jpg' }),
    // About 60 m north, punctuation and "and" aside the same name.
    row('A2', 'KILN AND HEARTH SUPPLY', 40.31054, -75.13),
    // About 1.1 km off: a second branch, kept.
    row('A3', 'Kiln & Hearth Supply', 40.32, -75.13),
    // Next door, another name: kept.
    row('C', 'Kiln Street Cafe', 40.3101, -75.13),
  ]);
  assert.deepStrictEqual(out.map((r) => r.place_id), ['A', 'A3', 'C']);
  // Nothing of the dropped row is carried onto the kept one.
  assert.strictEqual(out[0].photo_url, '/a.jpg');
  assert.strictEqual(out[0].place_id, 'A');
});

test('rows with no coordinates are matched on the id alone', () => {
  const out = dedupeSearchRows([row('A', 'Twin', null), row('B', 'Twin', null), row('A', 'Twin', null)]);
  assert.deepStrictEqual(out.map((r) => r.place_id), ['A', 'B']);
  assert.deepStrictEqual(dedupeSearchRows(null), []);
  assert.deepStrictEqual(dedupeSearchRows([null, 'x', row('A', 'One', 1, 1)]).map((r) => r.place_id), ['A']);
});

test('names are compared without case, accents, punctuation or the ampersand', () => {
  assert.strictEqual(normalizedName('Café & Bar, Ltd.'), normalizedName('cafe and bar ltd'));
  assert.notStrictEqual(normalizedName('Torre'), normalizedName('Tor'));
});

// ── Through the route ──────────────────────────────────────────────────────

const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

const googlePlace = (id, name, lat, lng) => ({
  id, displayName: { text: name }, formattedAddress: `${id} Ferry Rd`, rating: 4.9, userRatingCount: 253,
  types: ['store', 'point_of_interest', 'establishment'], location: { latitude: lat, longitude: lng },
});
let googleCalls = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (String(url).startsWith('https://places.googleapis.com/')) {
    googleCalls += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          googlePlace('ChIJdedupeKiln000000A', 'Kiln & Hearth Supply', 40.31, -75.13),
          googlePlace('ChIJdedupeParks00000B', 'Hearthside Park', 41.15, -73.99),
          googlePlace('ChIJdedupeKiln000000A', 'Kiln & Hearth Supply', 40.31, -75.13),
          googlePlace('ChIJdedupeKilnTwin00C', 'Kiln and Hearth Supply', 40.3102, -75.1301),
        ],
      }),
    });
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
test.after(() => new Promise((resolve) => server.close(() => resolve())));

test('the route answers one row per place, and the cache holds the clean list', async () => {
  const first = await realFetch(`${base}/api/venues/search?query=kiln`);
  assert.strictEqual(first.status, 200);
  const body = await first.json();
  assert.deepStrictEqual(body.venues.map((v) => v.place_id), ['ChIJdedupeKiln000000A', 'ChIJdedupeParks00000B']);
  assert.strictEqual(body.total, 2);
  const again = await (await realFetch(`${base}/api/venues/search?query=kiln`)).json();
  assert.deepStrictEqual(again.venues.map((v) => v.place_id), ['ChIJdedupeKiln000000A', 'ChIJdedupeParks00000B']);
  assert.strictEqual(googleCalls, 1, 'the second answer is the cached one');
});
