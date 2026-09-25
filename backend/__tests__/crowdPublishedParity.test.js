// Run: node --test  (from backend/)
//
// ===========================================================================
// WHATEVER IS DRAWN FROM A CROWD NUMBER IS DRAWN FROM THE ONE THAT SHIPS.
//
// Five defects from a read of the crowd forecast, each pinned where it lived:
//
//   1. BEST TIME FOLLOWS THE PUBLISHED SCORE. The card (routes/crowd.js) and
//      Birdie (routes/ai.js) chose the best-time sentence from the model's
//      score, and an owner's live reading then replaced the score, so "Packed
//      90" was printed beside "Now is good".
//   2. BIRDIE READS THE CARD'S HOURS. It kept the first Google period for
//      today and passed no weekday, so a split day lost its dinner service and
//      a window running past midnight read as closed.
//   3. ZERO IS A COORDINATE. `lat && lon` in the routes and `a || b || 0`
//      behind `!lat || !lng` in services/mlPredictor.js filed every venue on
//      the equator or the prime meridian, and every batch venue the two-decimal
//      rounding put on one, as having no location.
//   4. BIRDIE'S HOURS ARE HEDGED LIKE ITS HEADLINE and say which engine scored
//      them.
//   5. AN OWNER'S READING IS MARKED AS ONE: predictionMethod 'owner_report'.
//
// The routes run for real against stubbed upstreams: Google, the weather
// service, Ticketmaster, the predictor's two entry points and Postgres.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'crowd-published-parity-secret';
// Captured at module load by routes/crowd.js and routes/ai.js.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.TICKETMASTER_API_KEY;

const crowdEngine = require('../services/crowdEngine');

// --- scripted pg ------------------------------------------------------------
// Owner readings come back for the place ids scripted in `ownerRows`; every
// other statement (calibration reads, served_predictions, game nights, the
// predictor's baseline reads) answers with no rows.
const pool = require('../config/database');
let queries = [];
let ownerRows = {};
let neighborRows = [];
let feedbackRows = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params: params || [] });
  if (/DISTINCT ON \(r\.google_place_id\)/.test(flat)) {
    const ids = Array.isArray(params && params[0]) ? params[0] : [];
    return Promise.resolve({ rows: ids.map((id) => ownerRows[id]).filter(Boolean) });
  }
  // Verified reports, for the cases where they outrank an owner reading.
  if (/FROM venue_feedback/.test(flat)) {
    return Promise.resolve({ rows: feedbackRows });
  }
  // The neighbour box scan (mlPredictor scanNeighborBox), not the self read
  // that shares its join.
  if (/AS sum_bl/.test(flat)) {
    return Promise.resolve({ rows: neighborRows });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// --- weather, stubbed before the routes destructure it -----------------------
const weatherService = require('../services/weatherService');
let weatherCalls = [];
let hourlyWxCalls = [];
weatherService.getWeather = async (lat, lon) => {
  weatherCalls.push({ lat, lon });
  return { temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3, isRaining: false, conditionId: 800, fetchedAt: Date.now() };
};
weatherService.getHourlyForecast = async (lat, lng) => {
  hourlyWxCalls.push({ lat, lng });
  return null;
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 4101, name: 'Parity' }; next(); };

// A schedule fact with its own suite; nothing here is about it.
const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;

// --- the predictor's two entry points, scripted -----------------------------
function hourLabel(h24) {
  const h = ((h24 % 24) + 24) % 24;
  const period = h >= 12 ? 'PM' : 'AM';
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display} ${period}`;
}

const mlPredictor = require('../services/mlPredictor');
const I = mlPredictor._internals;
const realPredictHourlyForecast = mlPredictor.predictHourlyForecast;
let MODEL_NOW = 40;
let stripScore = () => 40;
let stripMethod = () => 'ml';
let stripBaseline = (_h, score) => score;
mlPredictor.predictBusyness = async () => ({
  score: MODEL_NOW,
  label: crowdEngine.getLabel(MODEL_NOW),
  confidence: 60,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: 'parity-test',
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => {
    const h24 = (startHour + i) % 24;
    const score = stripScore(h24);
    return {
      hour: hourLabel(h24),
      score,
      label: crowdEngine.getLabel(score),
      predictionMethod: stripMethod(h24),
      baselineScore: stripBaseline(h24, score),
    };
  });

// --- Google and Ticketmaster, faked; everything else is the real network ----
const PLACES = new Map();
let tmCalls = [];
let tmEvents = [];
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
  if (u.startsWith('https://app.ticketmaster.com/')) {
    tmCalls.push(u);
    const events = tmEvents;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ _embedded: { events } }) });
  }
  return realFetch(url, opts);
};

// --- routers (required AFTER every stub above) ------------------------------
const crowdRouter = require('../routes/crowd');
const aiRouter = require('../routes/ai');
const { executeTool } = aiRouter.__testables;
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
  ownerRows = {};
  neighborRows = [];
  feedbackRows = [];
  weatherCalls = [];
  hourlyWxCalls = [];
  tmCalls = [];
  tmEvents = [];
  MODEL_NOW = 40;
  stripScore = () => 40;
  stripMethod = () => 'ml';
  stripBaseline = (_h, score) => score;
  __resetPlacesBudget();
  placeDetailsCache.__test.reset();
  crowdRouter.__test.clearCache();
});

async function call(method, path, body) {
  const res = await realFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

let seq = 0;
const freshId = (tag) => `ChIJparity${tag}${String(++seq).padStart(5, '0')}`;

// A bar open around the clock (Google's one period with no close), on UTC.
function alwaysOpenPlace(id, overrides = {}) {
  return {
    id,
    displayName: { text: 'The Parity Bar' },
    formattedAddress: '1 Test St',
    rating: 4.4,
    userRatingCount: 300,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 39.95, longitude: -75.16 },
    currentOpeningHours: { openNow: true, periods: [{ open: { day: 0, hour: 0, minute: 0 } }] },
    utcOffsetMinutes: 0,
    ...overrides,
  };
}

// A live reading, set five minutes ago by a verified owner.
function liveOwnerRow(placeId, percent) {
  const at = new Date(Date.now() - 5 * 60 * 1000);
  return {
    id: 77,
    google_place_id: placeId,
    busy_percent: percent,
    created_at: at,
    diverged: false,
    profile_category: 'bar',
    assertion_since: at,
  };
}

// The Google offset that puts the venue's wall clock on `hour` right now, so a
// case can pin the venue's hour without pinning the machine's clock. Returned
// with the weekday the venue is on, which the hours fixtures are built around.
function clockAt(hour) {
  const now = new Date();
  let off = (hour - now.getUTCHours()) * 60;
  if (off > crowdEngine.MAX_UTC_OFFSET_MINUTES) off -= 1440;
  if (off < crowdEngine.MIN_UTC_OFFSET_MINUTES) off += 1440;
  const clock = crowdEngine.venueLocalNow(off, now);
  assert.strictEqual(clock.hour, hour, 'fixture clock did not land on the hour it was built for');
  return { off, day: clock.day };
}

const GO_NOW = /^Now(, before the rush| is good)$/;
const PACKED_NOW = 'Packed now, and it stays that way';

// ===========================================================================
// 1 and 5. The card: best time and method follow the owner's number.
// ===========================================================================

test('the card picks its best time from the owner\'s number, on a cache hit and on a fresh card', async () => {
  const id = freshId('CARD');
  PLACES.set(id, alwaysOpenPlace(id));

  // Control: no reading. The model's 40 on a flat night is a "go now" answer.
  const plain = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(plain.status, 200, plain.text);
  assert.strictEqual(plain.body.score, 40);
  assert.match(plain.body.bestTime, GO_NOW);
  assert.strictEqual(plain.body.predictionMethod, 'ml');

  // The owner says 90. This request is answered from the cached card.
  ownerRows[id] = liveOwnerRow(id, 90);
  const cachedOwned = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(cachedOwned.status, 200, cachedOwned.text);
  assert.strictEqual(cachedOwned.body.score, 90);
  assert.strictEqual(cachedOwned.body.label, 'Packed');
  assert.strictEqual(cachedOwned.body.ownerReport.applied, true);
  assert.strictEqual(cachedOwned.body.bestTime, PACKED_NOW,
    '"Now is good" beside the owner\'s Packed is the bug this pins');
  assert.strictEqual(cachedOwned.body.bestIsNow, true);
  assert.strictEqual(cachedOwned.body.predictionMethod, 'owner_report');
  // The model's own answer is still on the payload beside the owner's.
  assert.strictEqual(cachedOwned.body.rawEngineScore, 40);
  assert.strictEqual(cachedOwned.body.modelVersion, 'parity-test');

  // Nothing owner-shaped was baked into the cache: with the reading gone, the
  // same cached card says what the model said.
  delete ownerRows[id];
  const after = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(after.body.score, 40);
  assert.strictEqual(after.body.bestTime, plain.body.bestTime);
  assert.strictEqual(after.body.predictionMethod, 'ml');

  // And the fresh path, where the reading is live on the first request.
  const id2 = freshId('CARDFRESH');
  PLACES.set(id2, alwaysOpenPlace(id2));
  ownerRows[id2] = liveOwnerRow(id2, 90);
  const freshOwned = await call('GET', `/api/crowd/${id2}`);
  assert.strictEqual(freshOwned.status, 200, freshOwned.text);
  assert.strictEqual(freshOwned.body.score, 90);
  assert.strictEqual(freshOwned.body.bestTime, PACKED_NOW);
  assert.strictEqual(freshOwned.body.predictionMethod, 'owner_report');
});

test('an owner reading that says the room is empty turns "busy now" into a go-now answer', async () => {
  // The other direction: the model says 90, the owner says 10.
  MODEL_NOW = 90;
  stripScore = () => 90;
  const id = freshId('CARDLOW');
  PLACES.set(id, alwaysOpenPlace(id));
  const plain = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(plain.body.bestTime, PACKED_NOW);
  ownerRows[id] = liveOwnerRow(id, 10);
  const owned = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(owned.body.score, 10);
  assert.match(owned.body.bestTime, GO_NOW);
});

// ===========================================================================
// 1. Birdie: best time from the score it quotes.
// ===========================================================================

test('Birdie picks its best time from the score it quotes, the owner\'s when one is live', async () => {
  const id = freshId('BIRDIE');
  PLACES.set(id, alwaysOpenPlace(id));
  ownerRows[id] = liveOwnerRow(id, 90);
  const owned = await executeTool('get_crowd_prediction', { place_id: id }, 4102, { includeForecast: true });
  assert.strictEqual(owned.crowd_score, 90);
  assert.strictEqual(owned.crowd_source, 'owner_report');
  assert.strictEqual(owned.best_time, PACKED_NOW);

  delete ownerRows[id];
  const plain = await executeTool('get_crowd_prediction', { place_id: id }, 4102, { includeForecast: true });
  assert.strictEqual(plain.crowd_score, 40);
  assert.match(plain.best_time, GO_NOW);
});

test('Birdie\'s current hour carries the number it quotes, whoever produced it', async () => {
  const id = freshId('NOWHOUR');
  PLACES.set(id, alwaysOpenPlace(id));
  const ask = () => executeTool('get_crowd_prediction', { place_id: id }, 4107, { includeForecast: true });
  const nowOf = (out) => {
    const h = out.hourly_forecast[0];
    return { score: h.score, label: h.label, predictionMethod: h.predictionMethod };
  };

  // The model alone: the headline and the first hour were one number already.
  const plain = await ask();
  assert.deepStrictEqual(nowOf(plain), { score: plain.crowd_score, label: plain.crowd_label, predictionMethod: 'ml' });

  // The owner says 90 over the model's 40. One tool result used to say
  // "Packed now" in its best time and 40 for the same hour.
  ownerRows[id] = liveOwnerRow(id, 90);
  const owned = await ask();
  assert.strictEqual(owned.best_time, PACKED_NOW);
  assert.deepStrictEqual(nowOf(owned), { score: 90, label: 'Packed', predictionMethod: 'owner_report' });
  assert.strictEqual(owned.hourly_forecast[0].hour, plain.hourly_forecast[0].hour, 'still the current hour');
  assert.strictEqual(owned.hourly_forecast[1].score, 40, 'the hours after now stay the forecast');

  // Three verified reporters outrank the owner, so their blend is the number,
  // and the current hour says the blend too. They agree with the owner closely
  // enough (80 against 90) that nobody is struck.
  const filed = new Date(Date.now() - 2 * 60 * 1000);
  feedbackRows = [1, 2, 3].map((n) => ({ crowd_level: 3, predicted_score: 40, user_id: 5000 + n, created_at: filed }));
  const blended = await ask();
  assert.strictEqual(blended.crowd_source, 'user_reports');
  assert.ok(blended.crowd_score > 40 && blended.crowd_score < 90, `blend ${blended.crowd_score}`);
  assert.deepStrictEqual(nowOf(blended), { score: blended.crowd_score, label: blended.crowd_label, predictionMethod: 'ml' });
});

// ===========================================================================
// 2. Birdie reads the hours the card reads.
// ===========================================================================

test('Birdie keeps the dinner service of a split day', async () => {
  // 3 PM, between lunch (11-2) and dinner (5-10), closed right now. The first
  // period alone made dinner read as closed and sent people to tomorrow.
  const { off } = clockAt(15);
  const periods = [];
  for (let d = 0; d < 7; d++) {
    periods.push({ open: { day: d, hour: 11, minute: 0 }, close: { day: d, hour: 14, minute: 0 } });
    periods.push({ open: { day: d, hour: 17, minute: 0 }, close: { day: d, hour: 22, minute: 0 } });
  }
  const id = freshId('SPLIT');
  PLACES.set(id, alwaysOpenPlace(id, {
    types: ['restaurant'],
    currentOpeningHours: { openNow: false, periods },
    utcOffsetMinutes: off,
  }));
  // Model ordering (no baseline on the strip); dinner peaks at 7-8 PM.
  stripBaseline = () => null;
  stripScore = (h) => ({ 17: 30, 18: 50, 19: 80, 20: 80, 21: 60 }[h] ?? 40);

  const out = await executeTool('get_crowd_prediction', { place_id: id }, 4103, { includeForecast: true });
  assert.strictEqual(out.peak_hours, '7 PM - 8 PM', 'the dinner rush is tonight\'s peak');
  assert.strictEqual(out.best_time, '5 PM', 'the quiet start of dinner service, not tomorrow\'s lunch');
});

test('Birdie reads a window that runs past midnight as open after midnight', async () => {
  // 12:xx AM, inside the previous day's 11 PM - 1 AM window and nothing else
  // all day. Today's own (empty) list is not the whole answer.
  const { off, day } = clockAt(0);
  const id = freshId('OVERNIGHT');
  PLACES.set(id, alwaysOpenPlace(id, {
    types: ['restaurant'],
    currentOpeningHours: {
      openNow: true,
      periods: [{ open: { day: (day + 6) % 7, hour: 23, minute: 0 }, close: { day, hour: 1, minute: 0 } }],
    },
    utcOffsetMinutes: off,
  }));
  stripBaseline = () => null;

  const out = await executeTool('get_crowd_prediction', { place_id: id }, 4104, { includeForecast: true });
  assert.strictEqual(out.peak_hours, '12 AM', 'the open hour is the one it is in right now');
  assert.strictEqual(out.best_time, 'Now, they close soon',
    'nothing else opens today, so the answer is now, not a daytime hour the venue is shut');
});

// ===========================================================================
// 4. Birdie's hours are hedged like its headline.
// ===========================================================================

test('every Birdie hour is hedged by its own engine and says which one scored it', async () => {
  const id = freshId('HEDGE');
  PLACES.set(id, alwaysOpenPlace(id));
  stripScore = () => 75;
  stripMethod = (h) => (h % 2 === 0 ? 'ml' : 'rule_engine_no_baseline');

  const out = await executeTool('get_crowd_prediction', { place_id: id }, 4105, { includeForecast: true });
  assert.strictEqual(out.hourly_forecast.length, 12);
  // The first entry is the current hour, which carries the headline itself
  // (pinned by the case above); every hour after it is the forecast.
  assert.deepStrictEqual([out.hourly_forecast[0].score, out.hourly_forecast[0].label], [out.crowd_score, out.crowd_label]);
  const methods = new Set();
  for (const hour of out.hourly_forecast.slice(1)) {
    assert.ok(['ml', 'rule_engine_no_baseline'].includes(hour.predictionMethod), 'each hour names its engine');
    methods.add(hour.predictionMethod);
    const expected = hour.predictionMethod === 'ml' ? 'Busy' : 'Usually busy';
    assert.strictEqual(hour.label, expected, `${hour.hour}: a category-curve hour is stated as a prior`);
    assert.strictEqual(hour.label, crowdEngine.publishedLabel(
      hour.score, crowdEngine.describePredictionSupport(hour.predictionMethod, 0)));
  }
  assert.strictEqual(methods.size, 2, 'both engines were exercised');
});

// ===========================================================================
// 3. Zero is a coordinate.
// ===========================================================================

test('the coordinate read keeps 0 and drops only what is missing', () => {
  const { venueCoordinate } = I;
  assert.strictEqual(venueCoordinate(0, 51.5), 0, 'the prime meridian is a longitude');
  assert.strictEqual(venueCoordinate(-0, 51.5), -0);
  assert.strictEqual(venueCoordinate(undefined, null, 32.58), 32.58);
  assert.strictEqual(venueCoordinate(NaN, Infinity, 7), 7);
  assert.strictEqual(venueCoordinate(undefined, null), null);
  assert.strictEqual(venueCoordinate('0.01'), null, 'a string never worked downstream and is not coerced now');
});

test('the card fetches weather for a venue on the prime meridian', async () => {
  const id = freshId('MERIDIAN');
  PLACES.set(id, alwaysOpenPlace(id, { location: { latitude: 51.503, longitude: 0 } }));
  const res = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(weatherCalls, [{ lat: 51.503, lon: 0 }]);
  assert.deepStrictEqual(res.body.weather, { temp: 61, conditions: 'clear sky' });
});

test('the batch list keeps its weather when the first venue rounds onto the meridian', async () => {
  // Two-decimal rounding: 0.0031 becomes an exact 0.
  const res = await call('POST', '/api/crowd/batch', {
    venues: [{ place_id: freshId('BATCH'), name: 'By the O2', types: ['bar'], location: { latitude: 51.5031, longitude: 0.0031 } }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(weatherCalls, [{ lat: 51.5, lon: 0 }]);
  assert.ok(res.body.weather, 'the list was scored with weather');
});

test('Birdie fetches weather for a venue on the equator', async () => {
  const id = freshId('EQUATOR');
  PLACES.set(id, alwaysOpenPlace(id, { location: { latitude: 0, longitude: 32.58 } }));
  const out = await executeTool('get_crowd_prediction', { place_id: id }, 4106, { includeForecast: true });
  assert.deepStrictEqual(weatherCalls, [{ lat: 0, lon: 32.58 }]);
  assert.ok(out.weather, 'the answer carries the reading');
});

test('the predictor asks for events and neighbours at a 0 coordinate, and not without one', async () => {
  process.env.TICKETMASTER_API_KEY = 'parity-test-key';
  I.__resetEventBudget();
  try {
    const at = new Date('2026-08-21T23:00:00Z');
    const onMeridian = await I.getNearbyEvents(51.5, 0, at);
    assert.strictEqual(onMeridian.observed, true, 'a venue on the meridian gets its listing');
    assert.strictEqual(tmCalls.length, 1);
    assert.match(tmCalls[0], /latlong=51\.5%2C0(&|$)/);

    const missing = await I.getNearbyEvents(null, -0.1, at);
    assert.strictEqual(missing.observed, false);
    assert.strictEqual(missing.unavailableReason, 'no_coordinates');
    assert.strictEqual(tmCalls.length, 1, 'no coordinate, no call');
  } finally {
    delete process.env.TICKETMASTER_API_KEY;
    I.__resetEventBudget();
  }

  neighborRows = [{ dow: 5, hour: 20, cnt: 3, sum_bl: 150 }];
  const near = await mlPredictor._internals.getNeighborActivity('ChIJparityNeighbour0001', 51.5, 0, 5, 20);
  const scan = queries.find((q) => /AS sum_bl/.test(q.sql));
  assert.ok(scan, 'the neighbour scan ran for a venue on the meridian');
  assert.deepStrictEqual(scan.params.slice(0, 2), [51.5, 0]);
  assert.ok(near.count > 0, 'and its neighbours count');
});

test('an event on the meridian is counted, and an event with no location is not put at 0,0', async () => {
  process.env.TICKETMASTER_API_KEY = 'parity-test-key';
  I.__resetEventBudget();
  try {
    const at = new Date('2026-08-21T23:00:00Z');
    // No start time, so it counts as under way (see buildEventResult).
    tmEvents = [{ name: 'On the line', _embedded: { venues: [{ location: { latitude: '51.5005', longitude: '0' } }] } }];
    const meridian = await I.getNearbyEvents(51.5, 0.001, at);
    assert.strictEqual(meridian.hasEvent, true, 'an event at longitude 0 is on the street');
    assert.strictEqual(meridian.nearestName, 'On the line');

    // Beside Null Island, which is where a `|| 0` default puts an event that
    // carries no location at all. Missing is NaN and skipped; a real 0 counts.
    tmEvents = [
      { name: 'Unplaced', _embedded: { venues: [{ location: {} }] } },
      { name: 'No venue block', _embedded: { venues: [{}] } },
      { name: 'Blank strings', _embedded: { venues: [{ location: { latitude: '', longitude: '' } }] } },
    ];
    const nearZero = await I.getNearbyEvents(0.001, 0.001, at);
    assert.strictEqual(nearZero.observed, true);
    assert.strictEqual(nearZero.hasEvent, false, 'an event with no coordinates is nowhere, not at 0,0');
    assert.strictEqual(nearZero.totalEvents, 0);
  } finally {
    delete process.env.TICKETMASTER_API_KEY;
    I.__resetEventBudget();
  }
});

test('a pair that is not a place on Earth spends no lookup', async () => {
  process.env.TICKETMASTER_API_KEY = 'parity-test-key';
  I.__resetEventBudget();
  try {
    const at = new Date('2026-08-21T23:00:00Z');
    // Finite and out of range: the batch whitelist checks finiteness only, so
    // a body can carry these. The weather service already refuses them.
    for (const [lat, lng] of [[500, 0], [-91, 10], [45, 181], [45, -180.5]]) {
      const out = await I.getNearbyEvents(lat, lng, at);
      assert.strictEqual(out.unavailableReason, 'no_coordinates', `${lat},${lng}`);
    }
    assert.strictEqual(tmCalls.length, 0, 'no Ticketmaster call for a point that does not exist');
    // The edges are places.
    await I.getNearbyEvents(90, 180, at);
    assert.strictEqual(tmCalls.length, 1);
  } finally {
    delete process.env.TICKETMASTER_API_KEY;
    I.__resetEventBudget();
  }

  const none = await I.getNeighborActivity('ChIJparityNeighbour0002', 91, 0, 5, 20);
  assert.deepStrictEqual(none, { count: 0, mean: 0 });
  assert.ok(!queries.some((q) => /AS sum_bl/.test(q.sql)), 'no neighbour scan either');
});

test('the strip fetches its hourly weather at a 0 coordinate and needs both coordinates', async () => {
  const at = new Date(2026, 7, 21, 20, 0, 0, 0);
  await realPredictHourlyForecast(
    { place_id: 'ChIJparityStrip0001', types: ['bar'], location: { latitude: 51.5, longitude: 0 } },
    null, 20, 2, at
  );
  assert.deepStrictEqual(hourlyWxCalls, [{ lat: 51.5, lng: 0 }]);

  // Half a location is no location: this used to ask for the weather at
  // longitude 0 because the latitude alone was truthy.
  hourlyWxCalls = [];
  await realPredictHourlyForecast(
    { place_id: 'ChIJparityStrip0002', types: ['bar'], location: { latitude: 51.5, longitude: null } },
    null, 20, 2, at
  );
  assert.deepStrictEqual(hourlyWxCalls, []);
});
