// Run: node --test  (from backend/)
//
// ===========================================================================
// THE SERVER RECORDS WHAT IT PUBLISHES (migration 032).
//
// venue_feedback.predicted_score is the denominator of every calibration
// feature, and until this change it was whatever the CLIENT said we predicted.
// The fix has two halves: routes/crowd.js writes every score it serves into
// served_predictions, and routes/feedback.js prefers that record over the
// client's claim (__tests__/feedbackRoute.test.js pins the read half). This
// file pins the WRITE half, because a read that joins against a table nothing
// writes is the old hole with better paperwork:
//
//   * the detail card records, on the fresh path AND the cache path — a cached
//     card puts the same number on the same screen;
//   * the vote-list batch records, one multi-row UPSERT per request;
//   * batch junk place ids are dropped BEFORE the write — batch ids are
//     deliberately unvalidated for scoring, but a junk id minting rows here
//     is unbounded table growth, twenty ids per free POST;
//   * the write is fire-and-forget: its failure never fails the card.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'served-predictions-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;

// --- pg fake -----------------------------------------------------------------
const pool = require('../config/database');
let servedWrites;   // every INSERT INTO served_predictions, with params
let servedWriteFails;
let unknownSql;

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/INSERT INTO served_predictions/.test(flat)) {
    servedWrites.push({ sql: flat, params });
    if (servedWriteFails) return Promise.reject(new Error('served_predictions is on fire'));
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/DELETE FROM served_predictions/.test(flat)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/FROM venue_feedback/.test(flat)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/is_premium/.test(flat)) return Promise.resolve({ rows: [{ is_premium: false }] });
  unknownSql.push(flat);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
placesBudget.allowGlobalPlacesCall = () => true;

// --- Google Places, faked ----------------------------------------------------
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://places.googleapis.com/')) return realFetch(url, opts);
  const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      id,
      displayName: { text: id },
      formattedAddress: '1 Main St',
      rating: 4.2,
      userRatingCount: 300,
      priceLevel: 'PRICE_LEVEL_MODERATE',
      types: ['bar'],
      location: { latitude: 39.74, longitude: -104.98 },
      currentOpeningHours: { openNow: true, periods: [] },
      utcOffsetMinutes: null,
    }),
  });
};
test.after(() => { global.fetch = realFetch; });

// --- the predictor, faked ------------------------------------------------------
const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({
  score: 55,
  label: 'Moderate',
  confidence: 70,
  predictionMethod: 'ml',
  modelVersion: 'test-model',
  factors: {},
  dataSourcesUsed: ['ml_model'],
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) => (
  Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score: 40 + i, label: 'Moderate' };
  })
);

const crowdRouter = require('../routes/crowd');

const app = express();
app.use(express.json());
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

// Distinct users per test: the route cache keys on place+hour, not user, so
// each test also uses its own place id to dodge the module-level cache.
let nextUser = 800000;
test.beforeEach(() => {
  servedWrites = [];
  servedWriteFails = false;
  unknownSql = [];
  CURRENT_USER = { id: ++nextUser, name: 'Ava', role: 'user' };
});

async function call(method, path_, body) {
  const res = await realFetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed, text };
}

// Shaped like a real Google place id (utils/places.isPlaceIdShaped).
const pid = (tag) => `ChIJServed${tag}aaaaaaaaaaaaaaa`;

test('the detail card records the score it served, keyed to the caller', async () => {
  const place = pid('Detail1');
  const r = await call('GET', `/api/crowd/${place}?localHour=20&localDay=5`);
  assert.equal(r.status, 200, r.text);

  assert.equal(servedWrites.length, 1, 'exactly one served_predictions write per card');
  const w = servedWrites[0];
  // APPEND-ONLY. An ON CONFLICT upsert here would collapse the night's serve
  // history to "most recent", and the feedback join plus "what did Flock tell
  // users that night" both need the history (see the note in routes/crowd.js).
  assert.doesNotMatch(w.sql, /ON CONFLICT/i, 'the serve log must be append-only, not last-serve-wins');
  const [userId, placeIds, scores] = w.params;
  assert.equal(userId, CURRENT_USER.id, 'recorded against the caller, nobody else');
  assert.deepEqual(placeIds, [place]);
  assert.deepEqual(scores, [r.body.score], 'the recorded score IS the score the payload shipped');
});

test('the cache path records too — a cached card shows the same number', async () => {
  const place = pid('Cached1');
  const r1 = await call('GET', `/api/crowd/${place}?localHour=20&localDay=5`);
  assert.equal(r1.status, 200, r1.text);
  const firstUser = CURRENT_USER.id;

  // Second caller, same place+hour: served from the module cache (no second
  // Google fetch is observable here, but the write is).
  CURRENT_USER = { id: ++nextUser, name: 'Ben', role: 'user' };
  const r2 = await call('GET', `/api/crowd/${place}?localHour=20&localDay=5`);
  assert.equal(r2.status, 200, r2.text);

  assert.equal(servedWrites.length, 2, 'both the fresh and the cached serve were recorded');
  assert.equal(servedWrites[0].params[0], firstUser);
  assert.equal(servedWrites[1].params[0], CURRENT_USER.id,
    'the cached serve is recorded for the user it was served TO');
  assert.deepEqual(servedWrites[1].params[2], [r2.body.score]);
});

test('the batch records every shaped id in ONE statement and drops the junk ones', async () => {
  const good1 = pid('Batch1');
  const good2 = pid('Batch2');
  const r = await call('POST', '/api/crowd/batch', {
    venues: [
      { place_id: good1, name: 'Bar One', types: ['bar'] },
      { place_id: 'not a place id', name: 'Junk', types: ['bar'] },
      { place_id: good2, name: 'Bar Two', types: ['bar'] },
    ],
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.predictions.length, 3, 'junk ids still get SCORED — only the record drops them');

  assert.equal(servedWrites.length, 1, 'one multi-row UPSERT per batch, not one per venue');
  const [userId, placeIds, scores] = servedWrites[0].params;
  assert.equal(userId, CURRENT_USER.id);
  assert.deepEqual([...placeIds].sort(), [good1, good2].sort(),
    'a junk place id must not mint served_predictions rows');
  assert.equal(scores.length, 2);
  for (const s of scores) assert.ok(Number.isInteger(s) && s >= 0 && s <= 100);
});

test('a duplicated place id in one batch is one serve, not many', async () => {
  // The batch route accepts the same place id many times in one body (its
  // header documents that as the clock oracle). Twenty copies of one venue in
  // one POST are one screen moment — recording each would let a single free
  // request write twenty log rows per venue, forever.
  const place = pid('Dup1');
  const r = await call('POST', '/api/crowd/batch', {
    venues: [
      { place_id: place, name: 'Bar', types: ['bar'], utcOffsetMinutes: -300 },
      { place_id: place, name: 'Bar', types: ['bar'], utcOffsetMinutes: 60 },
    ],
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(servedWrites.length, 1);
  const [, placeIds] = servedWrites[0].params;
  assert.deepEqual(placeIds, [place], 'one row per (user, venue), whatever the body repeats');
});

test('a failing write never fails the card — fire-and-forget means it', async () => {
  servedWriteFails = true;
  const r = await call('GET', `/api/crowd/${pid('WriteFail')}?localHour=20&localDay=5`);
  assert.equal(r.status, 200, `the card must survive a served_predictions outage: ${r.text}`);
  assert.equal(servedWrites.length, 1, 'the write was attempted');
  // Give the rejected fire-and-forget promise a tick to reach its .catch, so
  // an unhandled rejection here would fail this test loudly.
  await new Promise((resolve) => setImmediate(resolve));
});

test('the fake understood every statement these cases produced', () => {
  assert.deepEqual(unknownSql, [],
    `unmodelled SQL reached the fake:\n${unknownSql.join('\n')}`);
});
