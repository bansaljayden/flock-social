// Run: node --test  (from backend/)
//
// GET /api/public/demo/venues?...&q=a&q=b — a repeated `q` is a 400, not a 500.
//
// Express parses a repeated query key into an array, and express-validator runs
// trim() and isLength() on each element, so the array passed validation and
// reached `.toLowerCase()`, which threw: a 500 from the unauthenticated door
// for a malformed query string. The shape is settled first now, the way the
// app's other routes do it (validators/shape.js scalarOnly).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

const pool = require('../config/database');
pool.query = async () => ({ rows: [], rowCount: 0 });

let googleCalls = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  googleCalls += 1;
  throw new Error(`outbound call from a test: ${u}`);
};
test.after(() => { global.fetch = realFetch; });

const publicCrowd = require('../routes/publicCrowd');
const app = express();
app.use('/api/public', publicCrowd);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(() => resolve())));

test('a repeated q is refused as a bad request before anything is spent', async () => {
  publicCrowd.__testables.resetDemoLimitsForTest();
  const res = await fetch(`${base}/api/public/demo/venues?lat=40.71&lng=-74.00&q=bars&q=pubs&localHour=20&localDay=5`);
  const text = await res.text();
  assert.strictEqual(res.status, 400, text);
  assert.strictEqual(googleCalls, 0);
});

test('so is a repeated lat or lng, which reached a paid search with a null coordinate', async () => {
  // isFloat() passes each element, `+['40.71', '41.0']` is NaN, and the Text
  // Search went out with latitude null: a paid call Google can only refuse,
  // recorded as a Places failure toward the outage alarm.
  for (const qs of ['lat=40.71&lat=41.0&lng=-74.00', 'lat=40.71&lng=-74.00&lng=-73.9']) {
    publicCrowd.__testables.resetDemoLimitsForTest();
    const res = await fetch(`${base}/api/public/demo/venues?${qs}&localHour=20&localDay=5`);
    const text = await res.text();
    assert.strictEqual(res.status, 400, `${qs}: ${text}`);
  }
  assert.strictEqual(googleCalls, 0);
});
