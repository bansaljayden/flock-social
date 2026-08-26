// Run: node --test  (from backend/)
//
// THE GUARD AND THE QUERY THAT FEEDS IT.
//
// crowdEngine.buildCalibrationAdjustment enforces three things before user
// reports may move a venue's public crowd score: at least three DISTINCT
// reporters, one vote per account, and nothing older than 28 days. All three
// are decided from the columns on the row it is handed — and routes/crowd.js
// selected `crowd_level, predicted_score` and nothing else. No user_id meant
// the per-account dedupe had nothing to dedupe by; no created_at meant the
// recency window had nothing to age. Both degraded to "keep every row", so the
// protection existed in one file and did nothing in production.
//
// That is the bug this file exists to keep fixed, and it is invisible to a test
// that calls buildCalibrationAdjustment directly with well-shaped rows
// (__tests__/moneyAndCalibration.test.js does exactly that, and passed the
// whole time the queries were starving it). These assertions look at what the
// ROUTE asks Postgres for, on all three calibration paths, plus two end-to-end
// checks that the columns survive the trip.
//
// The 28 days is asserted against crowdEngine.CALIBRATION_MAX_AGE_MS rather
// than against the number 28, because a SQL literal and a JS constant that mean
// the same thing are exactly the pair that drifts.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'calibration-queries-test-secret';
// Captured at module load by routes/crowd.js.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

// --- scripted pg fake -------------------------------------------------------
const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).slice(0, 120)}`));
}
pool.query = (sql, params) => dispatch(sql, params);

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava', role: 'user' }; next(); };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

// --- Google Places, faked ---------------------------------------------------
// utcOffsetMinutes is null on purpose: with an offset the route re-derives the
// hour from the venue's wall clock, and these tests want the localHour/localDay
// they pass in.
// Per-place Google offset, so a venue can be put in another time zone.
let OFFSETS = {};

function place(id) {
  return {
    id,
    displayName: { text: id },
    formattedAddress: '1 Main St',
    rating: 4.2,
    userRatingCount: 300,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 39.74, longitude: -104.98 },
    currentOpeningHours: { openNow: true, periods: [] },
    utcOffsetMinutes: OFFSETS[id] != null ? OFFSETS[id] : null,
  };
}

// What the neighbour searches return. `null` means the search failed the way
// Google actually fails: a non-2xx carrying an { error } body.
let NEARBY = [];
let NEARBY_FAILS = false;
const SEARCH_FAILURE = {
  ok: false,
  status: 429,
  json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
};

const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')
   || u.startsWith('https://places.googleapis.com/v1/places:searchNearby')) {
    if (NEARBY_FAILS) return Promise.resolve(SEARCH_FAILURE);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: NEARBY }) });
  }
  if (u.startsWith('https://places.googleapis.com/')) {
    const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
    return Promise.resolve({ ok: true, status: 200, json: async () => place(id || 'PLACE_X') });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { CALIBRATION_MAX_AGE_MS, MIN_CALIBRATION_REPORTERS } = crowdEngine;

// The model's answer, per place id, so the alternatives ranking can be set up
// as a tie that only calibration can break.
let SCORES = {};
const scoreFor = (v) => (SCORES[v?.place_id] != null ? SCORES[v.place_id] : 50);

mlPredictor.predictBusyness = async (v) => ({
  score: scoreFor(v),
  label: crowdEngine.getLabel(scoreFor(v)),
  confidence: 60,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: 'test',
});
mlPredictor.predictHourlyForecast = async (v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score: scoreFor(v), label: 'Quiet' };
  });

const crowdRouter = require('../routes/crowd');
// Same round, same class of bug one file over — see PART 4.
delete process.env.VENUE_BILLING_ENABLED;
const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  NEARBY = [];
  NEARBY_FAILS = false;
  SCORES = {};
  OFFSETS = {};
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

function scriptFeedback(rows) {
  handlers = [
    [/FROM venue_feedback/, () => ({ rows })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
}

const feedbackSql = () => log.find((q) => /FROM venue_feedback/.test(q.sql))?.sql;

// A verified report row as Postgres hands it back.
const DAY = 24 * 60 * 60 * 1000;
function report(level, userId, ageDays = 0) {
  return {
    crowd_level: level,
    predicted_score: 50,
    user_id: userId,
    created_at: new Date(Date.now() - ageDays * DAY),
  };
}

// Every calibration path in the file, driven end to end. Each entry runs the
// real route and returns the feedback SQL it issued.
const PATHS = [
  {
    name: 'GET /api/crowd/:placeId',
    run: async (suffix) => {
      const res = await call('GET', `/api/crowd/SINGLE_${suffix}?localHour=20&localDay=5`);
      assert.strictEqual(res.status, 200, res.text);
      return res;
    },
  },
  {
    name: 'POST /api/crowd/batch',
    run: async (suffix) => {
      const res = await call('POST', '/api/crowd/batch', {
        venues: [{ place_id: `BATCH_${suffix}`, location: { latitude: 39.74, longitude: -104.98 } }],
        localHour: 20,
        localDay: 5,
      });
      assert.strictEqual(res.status, 200, res.text);
      return res;
    },
  },
  {
    name: 'GET /api/crowd/:placeId/alternatives',
    run: async (suffix) => {
      const res = await call('GET', `/api/crowd/ALT_${suffix}/alternatives?localHour=20&localDay=5`);
      assert.strictEqual(res.status, 200, res.text);
      return res;
    },
  },
];

// ===========================================================================
// PART 1 — the columns the guard needs are actually asked for
// ===========================================================================

test('every calibration query selects the account and the age of the report', async () => {
  let i = 0;
  for (const path of PATHS) {
    scriptFeedback([]);
    log = [];
    await path.run(`COLS${i++}`);

    const sql = feedbackSql();
    assert.ok(sql, `${path.name} did not query venue_feedback at all`);
    // The columns have to be in the SELECT LIST, not merely mentioned somewhere
    // in the statement: the single-venue query has always had `ORDER BY
    // created_at DESC`, so a test that searched the whole string would have
    // passed for the entire time the projection was starving the guard.
    const projection = sql.slice(0, sql.indexOf(' FROM '));
    // Without user_id every row is its own reporter, so one account clears the
    // three-reporter floor by itself. Without created_at nothing ages out.
    assert.match(projection, /\buser_id\b/, `${path.name}: no user_id in the projection — the per-account dedupe is a no-op`);
    assert.match(projection, /\bcreated_at\b/, `${path.name}: no created_at in the projection — the recency window is a no-op`);
    // The presence filter this all sits downstream of.
    assert.match(sql, /verified = true/, `${path.name}: unverified reports must not reach calibration`);
  }
});

test('every calibration query bounds the age in SQL, at the window the engine enforces', async () => {
  let i = 0;
  for (const path of PATHS) {
    scriptFeedback([]);
    log = [];
    await path.run(`AGE${i++}`);

    const sql = feedbackSql();
    const m = sql.match(/created_at > NOW\(\) - INTERVAL '(\d+) days'/);
    assert.ok(m, `${path.name}: the age bound must be in the WHERE clause, not only in JavaScript`);
    // One window, two languages. A SQL literal and a JS constant that mean the
    // same thing are the pair most likely to drift, so they are compared.
    assert.strictEqual(
      Number(m[1]) * DAY,
      CALIBRATION_MAX_AGE_MS,
      `${path.name}: SQL asks for ${m[1]} days, crowdEngine enforces ${CALIBRATION_MAX_AGE_MS / DAY}`
    );
  }
});

test('bounding the age in SQL did not cost the (day, hour) window its parameters', async () => {
  // The interval is a literal rather than a bind parameter on purpose: the
  // window pairs are $2..$7 on every one of these queries and other tests read
  // them positionally. An eighth parameter here would break them silently.
  scriptFeedback([]);
  await PATHS[0].run('PARAMS');
  const fb = log.find((q) => /FROM venue_feedback/.test(q.sql));
  assert.strictEqual(fb.params.length, 7);
  assert.match(fb.sql, /\(day_of_week, hour\) IN/);
});

// ===========================================================================
// PART 2 — the single-venue LIMIT counts reporters, not rows
// ===========================================================================

test('the single-venue read spends its 50-row budget on 50 different reporters', async () => {
  scriptFeedback([]);
  await PATHS[0].run('LIMIT');
  const sql = feedbackSql();

  // buildCalibrationAdjustment keeps exactly one report per account, so any
  // extra row from an account already in the result is a row the caller will
  // throw away. Fetching them anyway means a handful of accounts holding
  // several in-window reports each can fill all 50 slots and push genuine
  // reporters out of a budget that was spent on discards. Deduping in SQL makes
  // LIMIT 50 mean "50 reporters".
  assert.match(sql, /DISTINCT ON \(user_id\)/,
    'LIMIT 50 must be 50 reporters, not 50 rows one account can own');
  assert.match(sql, /ORDER BY user_id, created_at DESC/,
    'the row kept per account must be that account\'s newest report');
  assert.match(sql, /LIMIT 50/);
});

// ===========================================================================
// PART 3 — the columns survive the trip, on every path
// ===========================================================================

test('one account filing repeatedly is one reporter on the batch list too', async () => {
  // The batch list is the score printed beside every venue in a vote list, so
  // it is the surface a determined account would actually aim at. Four rows,
  // one account: below the floor, so the model's answer stands.
  SCORES.BATCH_SYBIL = 20;
  scriptFeedback([
    { venue_place_id: 'BATCH_SYBIL', ...report(3, 777, 0) },
    { venue_place_id: 'BATCH_SYBIL', ...report(3, 777, 1) },
    { venue_place_id: 'BATCH_SYBIL', ...report(3, 777, 2) },
    { venue_place_id: 'BATCH_SYBIL', ...report(3, 777, 3) },
  ]);

  const res = await call('POST', '/api/crowd/batch', {
    venues: [{ place_id: 'BATCH_SYBIL', location: { latitude: 39.74, longitude: -104.98 } }],
    localHour: 20,
    localDay: 5,
  });

  assert.strictEqual(res.status, 200, res.text);
  const p = res.body.predictions[0];
  assert.strictEqual(p.calibration.reportCount, 1, 'four rows from one account are one opinion');
  assert.strictEqual(p.calibration.feedbackUsed, false);
  assert.strictEqual(p.score, 20, 'one account must not move a venue in the list');
});

test('three real reporters still move the batch list', async () => {
  // The floor is a floor, not an off switch: the same four rows from three
  // accounts do move the number.
  SCORES.BATCH_REAL = 20;
  scriptFeedback([
    { venue_place_id: 'BATCH_REAL', ...report(3, 801) },
    { venue_place_id: 'BATCH_REAL', ...report(3, 802) },
    { venue_place_id: 'BATCH_REAL', ...report(3, 803) },
  ]);

  const res = await call('POST', '/api/crowd/batch', {
    venues: [{ place_id: 'BATCH_REAL', location: { latitude: 39.74, longitude: -104.98 } }],
    localHour: 20,
    localDay: 5,
  });

  const p = res.body.predictions[0];
  assert.strictEqual(p.calibration.reportCount, MIN_CALIBRATION_REPORTERS);
  assert.strictEqual(p.calibration.feedbackUsed, true);
  assert.ok(p.score > 20, 'three verified reporters are evidence');
});

test('a stale report does not vote on the batch list', async () => {
  // The SQL would not have returned this row; the engine drops it anyway, so
  // the two halves of the window agree.
  SCORES.BATCH_STALE = 20;
  scriptFeedback([
    { venue_place_id: 'BATCH_STALE', ...report(3, 811, 400) },
    { venue_place_id: 'BATCH_STALE', ...report(3, 812, 400) },
    { venue_place_id: 'BATCH_STALE', ...report(3, 813, 400) },
  ]);

  const res = await call('POST', '/api/crowd/batch', {
    venues: [{ place_id: 'BATCH_STALE', location: { latitude: 39.74, longitude: -104.98 } }],
    localHour: 20,
    localDay: 5,
  });

  const p = res.body.predictions[0];
  assert.strictEqual(p.calibration.reportCount, 0);
  assert.strictEqual(p.score, 20);
});

test('one account cannot promote a neighbour into "less crowded nearby"', async () => {
  // The alternatives list compares the target's CALIBRATED score against each
  // neighbour's. Model-tied at 50 each, so nothing is quieter than anything —
  // unless one account's six "packed" reports on the target count as six
  // reporters, which would push the target to 65 and list the neighbour as the
  // quieter option. That is a recommendation to walk somewhere else, published
  // on the say-so of a single account.
  SCORES.ALT_TARGET = 50;
  SCORES.ALT_NEIGHBOUR = 50;
  NEARBY = [{
    ...place('ALT_NEIGHBOUR'),
    displayName: { text: 'Next Door' },
  }];
  scriptFeedback(Array.from({ length: 6 }, (_, i) => ({
    venue_place_id: 'ALT_TARGET',
    ...report(3, 777, i),
  })));

  const res = await call('GET', '/api/crowd/ALT_TARGET/alternatives?localHour=20&localDay=5');

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.currentVenue.score, 50, 'six rows from one account are one opinion');
  assert.deepStrictEqual(res.body.alternatives, []);
});

test('the alternatives list looks up reports on the venue\'s clock, not the viewer\'s', async () => {
  // The reports that calibrate a venue are stored per (day_of_week, hour), so
  // the clock this route reads decides which bucket it asks for. GET
  // /api/crowd/:placeId re-derives the hour from Google's utcOffsetMinutes;
  // this route used the query string. For a venue three zones away that is a
  // different bucket entirely, so the reports that moved the card were invisible
  // here and the two surfaces published different numbers for the same venue.
  const now = new Date();
  // Put the venue at 2 AM whatever the viewer says, and the viewer says 8 PM.
  //
  // Folded into the range a real UTC offset can occupy, which is -720 to +840,
  // and that fold is the whole point of this line rather than tidiness. The
  // modulo alone yields 0 to 1439, so between roughly 03:00 and 11:00 UTC it
  // produced an offset above +14:00, the route correctly rejected it as not a
  // real timezone, venueLocalNow returned null, and the route fell back to the
  // viewer's hour. The assertion below then read the viewer's bucket and failed
  // for eight hours out of every twenty four, on a clock nobody was looking at.
  // The test's arithmetic was wrong, not the route. An offset above +840 has an
  // equivalent 1440 lower that names the same wall clock and is a timezone that
  // exists, so subtracting a day keeps 2 AM and makes the input legal.
  const wrapped = (((2 - now.getUTCHours()) * 60) + 1440) % 1440;
  const offset = wrapped > 840 ? wrapped - 1440 : wrapped;
  OFFSETS.ALT_ABROAD = offset;
  scriptFeedback([]);

  const res = await call('GET', '/api/crowd/ALT_ABROAD/alternatives?localHour=20&localDay=5');
  assert.strictEqual(res.status, 200, res.text);

  const fb = log.find((q) => /FROM venue_feedback/.test(q.sql));
  const hours = [fb.params[2], fb.params[4], fb.params[6]];
  // ±1 for a UTC hour that ticks over mid-test; the point is that 20 is gone.
  assert.ok(hours.includes(2) || hours.includes(3),
    `expected the venue's own hour in the window, got ${hours.join(',')}`);
  assert.ok(!hours.includes(20),
    'the viewer\'s hour must not decide which reports calibrate a venue abroad');
});

// ===========================================================================
// PART 4 — "we could not ask" is not "there is nothing"
//
// Found by re-auditing the same three files for the same shape of mistake: a
// result that looks like an answer but is really a swallowed failure. Both
// routes below read `(response.places || [])`, so a quota, auth or Places
// outage arrived as a successful search that happened to find nobody.
// ===========================================================================

test('a failed neighbour search is not published as "nothing quieter nearby"', async () => {
  SCORES.ALT_UPSTREAM = 90;
  NEARBY_FAILS = true;
  scriptFeedback([]);

  const res = await call('GET', '/api/crowd/ALT_UPSTREAM/alternatives?localHour=20&localDay=5');

  // An empty alternatives array is this endpoint's way of saying "we looked and
  // everywhere near you is busier", which is a real claim about a real place.
  assert.strictEqual(res.status, 502, res.text);
  assert.strictEqual(res.body.unavailable, true);
  assert.ok(!('alternatives' in res.body));
});

// --- the competitive strip, same shape ---------------------------------------

const VERIFIED_CTX = { id: 5, google_place_id: 'STRIP_PLACE', verified: true };
function scriptVenueCtx() {
  handlers = [
    [/FROM venue_profiles WHERE user_id/, () => ({ rows: [VERIFIED_CTX] })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
}

test('a failed competitor search does not tell an owner the street is empty', async () => {
  NEARBY_FAILS = true;
  scriptVenueCtx();

  const res = await call('GET', '/api/venue-dashboard/strip');

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.available, false, 'an outage was served as "no competitors nearby"');
  assert.ok(!('competitors' in res.body));

  // And it must not be remembered. The strip is cached for an hour, so caching
  // the failure would freeze the false reading on the dashboard for that long
  // while the owner's own dial kept updating beside it.
  NEARBY_FAILS = false;
  NEARBY = [];
  scriptVenueCtx();
  const retry = await call('GET', '/api/venue-dashboard/strip');
  assert.strictEqual(retry.body.available, true, 'the failure was cached; the retry never reached Google');
});
