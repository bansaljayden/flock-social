// Run: node --test  (from backend/)
//
// GET /api/public/demo/venue/:placeId — a junk place id is not a Places outage.
//
// The demo card is unauthenticated and its id is the caller's to choose. The
// route length-checked the id and then recorded every non-404 answer from
// Place Details as a Places failure, so three requests for an id that never
// decoded (Google answers 400 INVALID_ARGUMENT naming the place id) were
// FAILURE_STREAK_ALARM, and the "Google Places is failing" email is sent once
// per UTC day: a stranger could spend that day's alert before a real outage.
//
// The shared details path already reads that answer as Google working
// (utils/placesHealth.js isPlaceNotFoundAnswer, commit 90741b64); the demo now
// asks the same predicate, and refuses an id no place id could be
// (utils/places.js isPlaceIdShaped) before it calls Google at all. A dead API
// key, which also answers INVALID_ARGUMENT, still counts.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

const pool = require('../config/database');
pool.query = async () => ({ rows: [], rowCount: 0 });

let detailCalls = 0;
let answer = null;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    detailCalls += 1;
    const { status, body } = answer;
    return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
  }
  if (u.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  throw new Error(`outbound call from a test: ${u}`);
};
test.after(() => { global.fetch = realFetch; });

const { placesHealthStatus, __resetPlacesHealth } = require('../utils/placesHealth');
const { __resetPlacesBudget } = require('../utils/placesBudget');
const publicCrowd = require('../routes/publicCrowd');

const app = express();
app.use('/api/public', publicCrowd);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(() => resolve())));

test.beforeEach(() => {
  detailCalls = 0;
  __resetPlacesHealth();
  __resetPlacesBudget();
  publicCrowd.__testables.resetDemoLimitsForTest();
});

async function card(placeId) {
  const res = await fetch(`${base}/api/public/demo/venue/${encodeURIComponent(placeId)}?localHour=20&localDay=2`);
  return { status: res.status, text: await res.text() };
}

const notAPlaceId = (placeId) => ({
  status: 400,
  body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Not a valid Place ID: ${placeId}` } },
});

test('an id Google says does not decode is a 404 and is not counted toward the outage alarm', async () => {
  for (const id of ['notARealPlace1', 'notARealPlace2', 'notARealPlace3']) {
    answer = notAPlaceId(id);
    const out = await card(id);
    assert.strictEqual(out.status, 404, out.text);
  }
  const health = placesHealthStatus();
  assert.strictEqual(health.consecutiveFailures, 0, 'three made-up ids in a row armed "Places is down"');
  assert.strictEqual(health.unhealthy, false);
});

test('an id no place id could be is refused before Google is asked', async () => {
  answer = notAPlaceId('x');
  for (const id of ['a b c d e f', 'abc', 'x/../places:searchText', 'bar.pub.club']) {
    const out = await card(id);
    assert.strictEqual(out.status, 400, `${id}: ${out.text}`);
  }
  assert.strictEqual(detailCalls, 0, 'a paid call Google could only refuse');
  assert.strictEqual(placesHealthStatus().totalFailed, 0);
});

test('a dead API key still counts, so a real outage still alarms', async () => {
  answer = {
    status: 400,
    body: {
      error: {
        code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
      },
    },
  };
  for (const id of ['ChIJkeyDead0001', 'ChIJkeyDead0002', 'ChIJkeyDead0003']) {
    const out = await card(id);
    assert.strictEqual(out.status, 503, out.text);
  }
  assert.strictEqual(placesHealthStatus().unhealthy, true);
});
