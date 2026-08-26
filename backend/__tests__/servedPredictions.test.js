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

// ===========================================================================
// WHICH DOOR, AND WHAT CLOCK (migration 038).
//
// 032 recorded the score and nothing about how it was arrived at, and
// routes/feedback.js then read "the server wrote this row" as "the server
// chose this number". On two of the three write paths that is false. The
// batch route scores venues out of a CLIENT-ASSEMBLED body, so a caller can
// post a real bar with rating 1.0 and a 4am utcOffsetMinutes, watch the server
// publish ~5 and record it as its own, then report the room packed and hand
// the calibration layer a forged pair wearing server provenance.
//
// The read half is pinned in __tests__/feedbackRoute.test.js. This is the
// write half, and it has to hold or that one is checking a column nothing
// fills in.
// ===========================================================================
const paramNames = (sql) => {
  const cols = /INSERT INTO served_predictions \(([^)]*)\)/.exec(sql);
  return cols ? cols[1].split(',').map((s) => s.trim()) : [];
};
// The INSERT is positional over unnest'd arrays; params[0] is the user id and
// params[1..] line up with the column list after it.
const columnValues = (w, column) => {
  const idx = paramNames(w.sql).indexOf(column);
  // user_id is params[0] and is a scalar, not an array; every column after it
  // is an array at params[idx].
  return w.params[idx];
};

test('a detail card scored on the venue clock is stamped detail, with that clock', async () => {
  // The Google fake returns utcOffsetMinutes: null for every place, so the
  // card falls back to the caller's clock — that case is the next test. Here
  // the venue answers with an offset, which is the ordinary case in production.
  const realJson = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (!u.startsWith('https://places.googleapis.com/')) return realJson(url, opts);
    return realJson(url, opts).then(async (r) => {
      const body = await r.json();
      return { ok: true, status: 200, json: async () => ({ ...body, utcOffsetMinutes: 0 }) };
    });
  };
  try {
    const place = pid('Stamped1');
    // The caller's hour has to be one the venue clock cannot also be, and this
    // test pins the venue to UTC (utcOffsetMinutes: 0) above, so a hardcoded
    // hour makes the assertion depend on when the suite is run. It was 4, and
    // for the sixty minutes a day that UTC is in hour 4 the venue clock landed
    // on 4 as well, the substitution became invisible, and the final assertion
    // failed on a correct route. Twelve hours away from the current UTC hour is
    // a different hour at every hour, so the caller's clock and the venue's are
    // guaranteed to disagree and the substitution is always observable.
    const callerHour = (new Date().getUTCHours() + 12) % 24;
    const r = await call('GET', `/api/crowd/${place}?localHour=${callerHour}&localDay=2`);
    assert.equal(r.status, 200, r.text);

    const w = servedWrites[0];
    assert.deepEqual(columnValues(w, 'source'), ['detail']);
    // AND the recorded clock is the one the CARD shipped, which is the venue's
    // own — NOT the localHour=4 the caller asked for. That substitution is the
    // whole reason the stamp is trustworthy: with the offset in hand the route
    // overwrites the caller's hour before it scores anything.
    assert.deepEqual(columnValues(w, 'local_hour'), [r.body.venueClock.hour]);
    assert.deepEqual(columnValues(w, 'local_day'), [r.body.venueClock.day]);
    assert.notEqual(r.body.venueClock.hour, callerHour, 'the venue clock replaced the caller-supplied hour');
  } finally {
    global.fetch = realJson;
  }
});

test('a detail card with no venue offset is stamped detail_client_clock, not detail', async () => {
  // Google gave us no utcOffsetMinutes (the module-level fake), so the hour
  // the card was scored on is the hour the CALLER named — and the hour is the
  // single biggest lever on a crowd score. The venue facts are still Google's,
  // which is why this is its own value rather than 'batch', but it is outside
  // the trusted allowlist all the same.
  const place = pid('ClientClk');
  const r = await call('GET', `/api/crowd/${place}?localHour=4&localDay=2`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.venueClock.local, false, 'no offset from Google in this fixture');

  const w = servedWrites[0];
  assert.deepEqual(columnValues(w, 'source'), ['detail_client_clock']);
  assert.deepEqual(columnValues(w, 'local_hour'), [4]);
  assert.deepEqual(columnValues(w, 'local_day'), [2]);
});

test('the CACHE path stamps the clock the cached card was scored on, not the request URL', async () => {
  // The route's `localHour`/`localDay` locals hold the caller's query values
  // until Google's offset overwrites them — and the cache-hit path answers
  // BEFORE that fetch. Recording those locals would write the requester's
  // asserted hour onto a card that was scored on a different one, which is a
  // forged clock introduced by the fix rather than by an attacker.
  const place = pid('CacheClk');
  const r1 = await call('GET', `/api/crowd/${place}?localHour=4&localDay=2`);
  assert.equal(r1.status, 200, r1.text);

  CURRENT_USER = { id: ++nextUser, name: 'Ben', role: 'user' };
  const r2 = await call('GET', `/api/crowd/${place}?localHour=4&localDay=2`);
  assert.equal(r2.status, 200, r2.text);
  assert.equal(servedWrites.length, 2);

  const cachedWrite = servedWrites[1];
  assert.deepEqual(columnValues(cachedWrite, 'local_hour'), [r2.body.venueClock.hour]);
  assert.deepEqual(columnValues(cachedWrite, 'local_day'), [r2.body.venueClock.day]);
  assert.deepEqual(columnValues(cachedWrite, 'source'), columnValues(servedWrites[0], 'source'),
    'a cached serve came out of the same door as the serve that filled the cache');
});

test('THE FORGERY: every batch row is stamped batch, whatever the body claims', async () => {
  // The attacker's own request. A real bar, handed to the server with the
  // rating, review count and clock that produce the lowest score they can
  // reach — then reported packed twelve hours later.
  const bar = pid('ForgedBar');
  const r = await call('POST', '/api/crowd/batch', {
    localHour: 4,
    localDay: 2,
    venues: [{
      place_id: bar,
      name: 'A Real Busy Bar',
      types: ['bar'],
      rating: 1.0,
      user_ratings_total: 3,
      utcOffsetMinutes: 0,
    }],
  });
  assert.equal(r.status, 200, r.text);

  const w = servedWrites[0];
  assert.deepEqual(columnValues(w, 'source'), ['batch'],
    'a score computed from a client-assembled body must be recorded as one');
  // Never 'detail', by any route. The read side allowlists exactly that value,
  // so this is the assertion the whole fix rests on.
  assert.ok(!columnValues(w, 'source').includes('detail'));
  // The clock is recorded even though nothing reads it yet: it is the only way
  // to ask afterwards which hour a forged serve was aimed at.
  const hours = columnValues(w, 'local_hour');
  assert.ok(Number.isInteger(hours[0]) && hours[0] >= 0 && hours[0] <= 23);
});

test('a mixed batch is all batch — one honest-looking row cannot carry the others', async () => {
  const r = await call('POST', '/api/crowd/batch', {
    venues: [
      { place_id: pid('MixA'), name: 'A', types: ['bar'], utcOffsetMinutes: 0 },
      { place_id: pid('MixB'), name: 'B', types: ['bar'] },
    ],
  });
  assert.equal(r.status, 200, r.text);
  const sources = columnValues(servedWrites[0], 'source');
  assert.equal(sources.length, 2);
  assert.deepEqual([...new Set(sources)], ['batch']);
});

test('the source column is written from an allowlist, so an unknown value records NULL', () => {
  // Belt and braces at the WRITE as well as the read. The columns are
  // CHECK-constrained, so an unrecognised string is a 23514 that loses the row
  // — but more importantly, "unknown" and "trusted" must never be one typo
  // apart in either direction.
  const { SERVE_SOURCES, clockField } = require('../routes/crowd').__test;
  assert.ok(SERVE_SOURCES.has('detail'));
  assert.ok(SERVE_SOURCES.has('batch'));
  assert.ok(!SERVE_SOURCES.has('server'), "'server' is the FEEDBACK row's vocabulary, never a serve's");
  assert.equal(clockField(0, 23), 0, 'hour 0 is a real hour, not a falsy miss');
  assert.equal(clockField(23, 23), 23);
  assert.equal(clockField(24, 23), null);
  assert.equal(clockField(-1, 6), null);
  assert.equal(clockField(undefined, 23), null);
  assert.equal(clockField('4', 23), null, 'a string clock is not a clock');
});

test('the fake understood every statement these cases produced', () => {
  assert.deepEqual(unknownSql, [],
    `unmodelled SQL reached the fake:\n${unknownSql.join('\n')}`);
});
