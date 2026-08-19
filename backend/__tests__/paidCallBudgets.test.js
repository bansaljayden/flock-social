// Run: node --test  (from backend/)
//
// Round 15. Two failures live here, and they are different kinds of failure:
//
//   MONEY. Every paid Google Places surface must charge the SAME ledger, or the
//   "global daily ceiling" in utils/placesBudget.js is a ceiling on the
//   authenticated slice of the invoice and nothing else. The badge, both public
//   demo endpoints and the photo proxy each had a per-address gate and no
//   charge; GET /:placeId/alternatives charged one unit for two paid calls; and
//   Gemini, billed per token, had no deadline at all.
//
//   TRUTH. A weather outage must not become a fabricated reading. The ML path
//   substituted `temp = 20` on every null, and because weatherService fetches
//   imperial units — and the training rows were collected through that same
//   function — that told the model it was 20°F, below freezing, on every
//   outage. Every prediction skewed cold, silently, on the path that ships.
//
// The route assertions drive the real Express routers against the REAL budget
// module, so they fail if the wiring is removed rather than if a stub changes.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = 'paid-call-budgets-test-secret';
// Captured at module load by badge / publicCrowd / venueSearch / crowd / ai.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
// No live upstreams: predictions must never reach Ticketmaster.
delete process.env.TICKETMASTER_API_KEY;
delete process.env.PAYWALL_ENABLED;

// --- the real spending ledger ----------------------------------------------
const placesBudget = require('../utils/placesBudget');
const {
  allowPlacesSearch, allowGlobalPlacesCall, placesBudgetStatus, __resetPlacesBudget,
  GLOBAL_DAILY, PER_USER_HOURLY,
} = placesBudget;

// Spend the whole day the way ~200 real accounts would.
//
// M5-1 changed the shape of this helper. The unauthenticated doors can now
// reach only UNAUTH_DAILY of the day (allowGlobalPlacesCall refuses past it),
// so draining the ledger through that one door alone loops forever. Spend the
// unauthenticated share through it first — that is still the fastest way to
// prove the shared ceiling is shared — and then walk the authenticated reserve
// down through fresh accounts, which is exactly who the reserve is for.
function exhaustGlobalBudget() {
  while (placesBudgetStatus(1).unauthRemaining > 0) {
    allowGlobalPlacesCall(Math.min(30, placesBudgetStatus(1).unauthRemaining));
  }
  let id = 900000;
  while (placesBudgetStatus(1).globalRemaining > 0) {
    const cost = Math.min(PER_USER_HOURLY, placesBudgetStatus(1).globalRemaining);
    assert.strictEqual(allowPlacesSearch(id++, cost), true, 'the reserve must be spendable by accounts');
  }
  assert.strictEqual(placesBudgetStatus(1).globalRemaining, 0);
}

// --- scripted pg ------------------------------------------------------------
const pool = require('../config/database');
let queries = [];
let handlers = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) return Promise.resolve(fn(params || [], flat) || { rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// --- stubbed collaborators (all destructured at load, so patch first) --------
const weatherService = require('../services/weatherService');
let weatherCalls = [];
weatherService.getWeather = async (lat, lon, opts) => {
  weatherCalls.push({ fn: 'getWeather', lat, lon, opts });
  return { temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3, isRaining: false, conditionId: 800, fetchedAt: Date.now() };
};
weatherService.getForecast = async (lat, lon, opts) => {
  weatherCalls.push({ fn: 'getForecast', lat, lon, opts });
  return [{ date: '2026-08-15', temp: 70 }];
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 7, name: 'Ava' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const mlPredictor = require('../services/mlPredictor');
const mlInternals = mlPredictor._internals;
const realPredictBusyness = mlPredictor.predictBusyness;
mlPredictor.predictBusyness = async () => ({
  score: 55, label: 'Moderate', confidence: 60, factors: {},
  dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => ({ hour: `${(startHour + i) % 24}`, score: 55, label: 'Moderate' }));

// --- Gemini, faked ----------------------------------------------------------
// ai.js destructures GoogleGenAI at load, so the class is replaced on the
// module object before the router is required.
const genaiMod = require('@google/genai');
let chatCreates = [];
let sendCalls = [];
let sendImpl = null;
const fakeChat = {
  sendMessage: async (params) => {
    sendCalls.push(params);
    if (sendImpl) return sendImpl(params, sendCalls.length);
    return { candidates: [{ content: { parts: [{ text: 'oakwood, chill till 9' }] } }] };
  },
};
genaiMod.GoogleGenAI = function FakeGenAI() {
  return { chats: { create: (p) => { chatCreates.push(p); return fakeChat; } } };
};

// --- Google, faked ----------------------------------------------------------
const PLACE = {
  id: 'PLACE_A',
  displayName: { text: 'The Bar' },
  formattedAddress: '1 Main St',
  rating: 4.4,
  userRatingCount: 120,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  types: ['bar'],
  location: { latitude: 39.74, longitude: -104.98 },
  currentOpeningHours: { openNow: true, periods: [] },
  utcOffsetMinutes: -360,
};
let googleCalls = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    googleCalls.push(u);
    if (u.includes('/media')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ photoUri: 'https://cdn.example/photo.jpg' }) });
    }
    if (u.includes(':searchText')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [PLACE] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => PLACE });
  }
  if (u.startsWith('https://cdn.example/')) {
    googleCalls.push(u);
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(4),
    });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

// --- routers (required AFTER every stub above) ------------------------------
const badgeRouter = require('../routes/badge');
const publicCrowdRouter = require('../routes/publicCrowd');
const venueSearchRouter = require('../routes/venueSearch');
const crowdRouter = require('../routes/crowd');
const weatherRouter = require('../routes/weather');
const aiRouter = require('../routes/ai');
const { feedbackWindow } = crowdRouter.__testables;
const { executeTool } = aiRouter.__testables;

const app = express();
app.use(express.json());
app.use('/api/badge', badgeRouter);
app.use('/api/public', publicCrowdRouter);
app.use('/api/venues', venueSearchRouter);
app.use('/api/crowd', crowdRouter);
app.use('/api/weather', weatherRouter);
app.use('/api/ai', aiRouter);

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
  queries = [];
  handlers = [];
  weatherCalls = [];
  googleCalls = [];
  chatCreates = [];
  sendCalls = [];
  sendImpl = null;
  CURRENT_USER = { id: 7, name: 'Ava' };
});

async function get(pathname, opts) {
  const res = await realFetch(`${base}${pathname}`, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function post(pathname, payload) {
  return get(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// 1. The daily Places ceiling is global or it is nothing
// ---------------------------------------------------------------------------

test('the venue badge charges the shared ceiling and stops when it is spent', async () => {
  handlers.push([/FROM venue_profiles/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })]);

  const ok = await get('/api/badge/PLACE_BADGE_1.svg');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1,
    'a Place Details call on the public badge is a real Google invoice line');

  exhaustGlobalBudget();
  googleCalls = [];
  const refused = await get('/api/badge/PLACE_BADGE_2.svg');
  assert.strictEqual(refused.status, 503);
  assert.strictEqual(googleCalls.length, 0, 'a refused badge must not reach Google anyway');
});

test('the public demo charges the shared ceiling on both endpoints', async () => {
  const area = await get('/api/public/demo/venues?lat=39.74&lng=-104.98&localHour=20&localDay=5');
  assert.strictEqual(area.status, 200);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1, 'the demo Text Search is paid');

  const venue = await get('/api/public/demo/venue/PLACE_A?localHour=20&localDay=5');
  assert.strictEqual(venue.status, 200);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 2, 'the demo Place Details is paid too');
});

test('the public demo is refused once the day is spent, before it calls Google', async () => {
  exhaustGlobalBudget();
  googleCalls = [];
  const area = await get('/api/public/demo/venues?lat=1.5&lng=2.5&localHour=20&localDay=5');
  assert.strictEqual(area.status, 429);
  const venue = await get('/api/public/demo/venue/PLACE_UNSEEN?localHour=20&localDay=5');
  assert.strictEqual(venue.status, 429);
  assert.strictEqual(googleCalls.length, 0);
});

test('the photo proxy charges the shared ceiling per cache miss', async () => {
  const first = await get('/api/venues/photo?ref=places/X/photos/ABC&maxwidth=400');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1,
    'the /media metadata leg is a paid Places request');

  // A cache hit is free, and must stay free — charging for a call we did not
  // make would mask the real burn rate.
  await get('/api/venues/photo?ref=places/X/photos/ABC&maxwidth=400');
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1, 'cache hits cost nothing');

  exhaustGlobalBudget();
  googleCalls = [];
  const refused = await get('/api/venues/photo?ref=places/X/photos/NEW&maxwidth=400');
  assert.strictEqual(refused.status, 429);
  assert.strictEqual(googleCalls.length, 0);
});

test('an unauthenticated surface and a logged-in user draw down one ledger', async () => {
  handlers.push([/FROM venue_profiles/, () => ({ rows: [{ ok: 1 }], rowCount: 1 })]);
  await get('/api/badge/PLACE_SHARED.svg');
  const afterBadge = placesBudgetStatus(1).globalUsed;
  await get('/api/crowd/PLACE_A');
  assert.strictEqual(placesBudgetStatus(1).globalUsed, afterBadge + 1,
    'both doors must count into the same daily total');
});

// ---------------------------------------------------------------------------
// 2. Charge what you spend
// ---------------------------------------------------------------------------

// Each alternatives test uses a place id of its own. The route caches its
// response for 10 minutes in a module-level map that no beforeEach can reach, so
// two tests sharing an id would have the second one silently measuring a cache
// hit — which is exactly the failure mode a money test must not have.
test('alternatives charges two units for its two paid Google calls', async () => {
  const res = await get('/api/crowd/PLACE_ALT_COST/alternatives?localHour=20&localDay=5');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 2,
    'Place Details + Text Search is two invoice lines, so it is two units');
  assert.strictEqual(placesBudgetStatus(7).userRemaining, 28,
    'and both come out of the caller‘s hourly allowance');
});

test('a second identical alternatives request costs nothing and never reaches Google', async () => {
  // The most expensive endpoint in the app: two paid calls, and until it grew a
  // cache the only thing between a client that re-asks and the invoice was the
  // 30-per-hour budget, i.e. fifteen requests. A cache hit must be answered
  // BEFORE the charge (utils/placesBudget.js: charging for a call we did not
  // make masks the real burn rate), so the second request costs zero units.
  const first = await get('/api/crowd/PLACE_ALT_CACHE/alternatives?localHour=20&localDay=5');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 2);

  googleCalls = [];
  const second = await get('/api/crowd/PLACE_ALT_CACHE/alternatives?localHour=20&localDay=5');
  assert.strictEqual(second.status, 200);
  assert.deepStrictEqual(second.body, first.body, 'a cache hit must be the same answer, not a stub');
  assert.strictEqual(googleCalls.length, 0, 'the repeat request reached Google anyway');
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 2, 'a call we did not make was charged');
});

test('a caller with one unit left cannot start a two-call request', async () => {
  // Burn 29 of 30 so the request needs a unit it does not have. All-or-nothing:
  // the refusal must cost nothing.
  for (let i = 0; i < 29; i++) assert.strictEqual(placesBudget.allowPlacesSearch(7), true);
  const before = placesBudgetStatus(7).globalUsed;
  googleCalls = [];
  const res = await get('/api/crowd/PLACE_ALT_BUDGET/alternatives?localHour=20&localDay=5');
  assert.strictEqual(res.status, 429);
  assert.strictEqual(googleCalls.length, 0);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, before, 'a refused charge costs nothing');
});

// ---------------------------------------------------------------------------
// 3. The weather enumeration surface
// ---------------------------------------------------------------------------

test('GET /api/weather identifies its caller so the per-user ceiling applies', async () => {
  const res = await get('/api/weather?lat=39.74&lon=-104.98');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(weatherCalls[0].opts, { userId: 7 },
    'any signed-in account can walk lat/lon here; without an id the only ceilings are global');
});

test('GET /api/weather/forecast identifies its caller too', async () => {
  const res = await get('/api/weather/forecast?lat=39.74&lon=-104.98');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(weatherCalls[0].opts, { userId: 7 });
});

test('venue-derived weather lookups stay unidentified', async () => {
  // routes/crowd.js gets its coordinates from Google, not from the caller, so
  // it is not the enumeration surface and must not consume a per-user ceiling
  // that a legitimate browsing session would hit.
  // A place id of its own: the crowd route caches by place id, and a cache hit
  // would answer without ever asking for weather.
  await get('/api/crowd/PLACE_VENUE_DERIVED');
  const call = weatherCalls.find((c) => c.fn === 'getWeather');
  assert.ok(call, 'the crowd route does look up weather');
  assert.strictEqual(call.opts, undefined);
});

test('POST /api/crowd/batch identifies its caller too — those coordinates are body input', async () => {
  // They look venue-derived, but they arrive in the request body: a caller can
  // put any lat/lng in the first item, which is the same enumeration shape as
  // GET /api/weather wearing a venue's clothes.
  const res = await post('/api/crowd/batch', {
    venues: [{ place_id: 'PLACE_A', location: { latitude: 12.34, longitude: 56.78 } }],
    localHour: 20, localDay: 5,
  });
  assert.strictEqual(res.status, 200);
  const call = weatherCalls.find((c) => c.fn === 'getWeather');
  assert.deepStrictEqual(call.opts, { userId: 7 });
});

// The batch feedback read asks for (venue_place_id, day_of_week, hour) TRIPLES,
// one per venue per window slot, because every venue in the body is scored on
// its own clock. Three parallel arrays keep the bind-parameter count at three
// however many venues arrive. Read them back as triples rather than by index, so
// these assertions say what they mean and survive a reshaping of the statement.
function batchWindowTriples(q) {
  const [ids, days, hours] = q.params;
  assert.ok(Array.isArray(ids) && Array.isArray(days) && Array.isArray(hours),
    'the batch feedback read binds three parallel arrays');
  assert.strictEqual(days.length, ids.length);
  assert.strictEqual(hours.length, ids.length);
  return ids.map((id, i) => [id, days[i], hours[i]]);
}

test('a junk clock in the batch body is ignored, never fed to the model as NaN', async () => {
  const res = await post('/api/crowd/batch', {
    venues: [{ place_id: 'PLACE_A', location: { latitude: 39.74, longitude: -104.98 } }],
    localHour: 'abc', localDay: 99,
  });
  assert.strictEqual(res.status, 200);
  // setHours(NaN) makes an Invalid Date, and every feature derived from it —
  // hour, weekday, month, holiday, the event window — would be zero-filled.
  assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)));
  const fb = queries.find((q) => /FROM venue_feedback/.test(q.sql));
  const triples = batchWindowTriples(fb);
  assert.ok(triples.length > 0, 'the batch route asked for no feedback at all');
  for (const [id, day, hour] of triples) {
    assert.strictEqual(typeof id, 'string');
    assert.ok(Number.isInteger(day) && day >= 0 && day <= 6, `day ${day} is not a real weekday`);
    assert.ok(Number.isInteger(hour) && hour >= 0 && hour <= 23, `hour ${hour} is not a real clock value`);
  }
});

test('the authenticated venue search still draws on the same ledger', async () => {
  const res = await get('/api/venues/search?query=bars&location=39.74,-104.98');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 1);
  assert.strictEqual(placesBudgetStatus(7).userRemaining, 29);
});

test('Birdie’s get_weather tool charges the caller, since the model relays their coordinates', async () => {
  const out = await executeTool('get_weather', { lat: 39.74, lng: -104.98 }, 42);
  assert.ok(out && !out.error);
  assert.deepStrictEqual(weatherCalls[0].opts, { userId: 42 },
    'a user can steer Birdie into arbitrary coordinates repeatedly');
});

// ---------------------------------------------------------------------------
// 4. Gemini has a deadline, and a timeout is not retried
// ---------------------------------------------------------------------------

function chatBody() {
  return { messages: [{ role: 'user', text: "what's the move tonight" }] };
}

test('every Gemini call carries the shared deadline', async () => {
  handlers.push([/FROM users WHERE id/, () => ({ rows: [{ name: 'Ava Lee', date_of_birth: '2000-01-01' }] })]);
  const res = await post('/api/ai/chat', chatBody());
  assert.strictEqual(res.status, 200);
  assert.ok(sendCalls.length >= 1);
  for (const call of sendCalls) {
    assert.ok(call.config?.abortSignal instanceof AbortSignal,
      'a paid vendor call with no deadline parks an Express connection indefinitely');
    assert.strictEqual(call.config.abortSignal.aborted, false, 'the signal must be fresh per call');
  }
});

test('the per-request config still carries the system prompt and the tools', async () => {
  // The SDK does `config: params.config ?? this.config` — a per-request config
  // REPLACES the chat's, it does not merge. Passing only { abortSignal } would
  // have silently dropped Birdie's persona and every tool declaration.
  handlers.push([/FROM users WHERE id/, () => ({ rows: [{ name: 'Ava Lee' }] })]);
  await post('/api/ai/chat', chatBody());
  const cfg = sendCalls[0].config;
  assert.match(String(cfg.systemInstruction), /You are Birdie/);
  const names = (cfg.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
  assert.ok(names.includes('search_venues') && names.includes('get_crowd_prediction'),
    'the tools must survive the per-request config');
});

test('a Gemini timeout is not retried — an aborted paid call is still billed', async () => {
  handlers.push([/FROM users WHERE id/, () => ({ rows: [{ name: 'Ava Lee' }] })]);
  sendImpl = () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const res = await post('/api/ai/chat', chatBody());
  assert.strictEqual(res.status, 500);
  assert.strictEqual(sendCalls.length, 1,
    'retrying a timed-out paid call is a second invoice for a question we already paid to ask');
});

test('a transient 429 still gets its one retry', async () => {
  handlers.push([/FROM users WHERE id/, () => ({ rows: [{ name: 'Ava Lee' }] })]);
  sendImpl = (_p, n) => {
    if (n === 1) { const e = new Error('overloaded'); e.status = 429; throw e; }
    return { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
  };
  const res = await post('/api/ai/chat', chatBody());
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sendCalls.length, 2);
});

// ---------------------------------------------------------------------------
// 5. A weather outage is not a temperature
// ---------------------------------------------------------------------------

const META = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json'), 'utf8'));

const DENVER = {
  place_id: 'PLACE_A', types: ['bar'], rating: 4.4, price_level: 2,
  user_ratings_total: 120, location: { latitude: 39.74, longitude: -104.98 },
};

test('a null weather reading never becomes 20 degrees', async () => {
  await mlPredictor.init();
  const ts = new Date(2026, 0, 15, 20, 0); // January, so a cold month exists to confuse it
  const map = mlInternals.buildFeatureMap(DENVER, null, ts, {}, {}, 50, {});

  assert.notStrictEqual(map.temperature, 20,
    'weatherService fetches imperial units and the training rows came through it, so 20 meant 20°F — below freezing on every outage');
  const norm = mlInternals.climateNorm(39.74, 1);
  assert.ok(Number.isFinite(norm), 'the trained metadata carries a climatology to impute from');
  assert.strictEqual(map.temperature, norm,
    'the substitute must be the same climatology prepare_features.py imputes a missing temperature with');
  assert.strictEqual(map.temp_anomaly, 0,
    'and an imputed temperature must read as "nothing unusual", not as a fabricated anomaly');
  assert.strictEqual(map.weather_unknown, 1, 'the one-hot lands in a bucket the model was trained on');
  assert.strictEqual(map.weather_clear, 0);
  assert.strictEqual(map.is_raining, 0);
});

test('a real reading is passed through untouched', async () => {
  await mlPredictor.init();
  const ts = new Date(2026, 0, 15, 20, 0);
  const map = mlInternals.buildFeatureMap(
    DENVER, { temp: 34, humidity: 60, windSpeed: 4, isRaining: false, conditionId: 800 }, ts, {}, {}, 50, {});
  assert.strictEqual(map.temperature, 34);
  assert.strictEqual(map.weather_clear, 1);
  assert.strictEqual(map.weather_unknown, 0);
});

test('a freezing reading of 20 is still honoured — only the invented one is gone', async () => {
  await mlPredictor.init();
  const map = mlInternals.buildFeatureMap(
    DENVER, { temp: 20, conditionId: 800 }, new Date(2026, 0, 15, 20, 0), {}, {}, 50, {});
  assert.strictEqual(map.temperature, 20, 'the fix must not start ignoring genuinely cold readings');
});

test('hasTempReading tells absence from a reading of zero', () => {
  assert.strictEqual(mlInternals.hasTempReading({ temp: 0 }), true, '0°F is a reading');
  assert.strictEqual(mlInternals.hasTempReading({ temperature: -5 }), true);
  assert.strictEqual(mlInternals.hasTempReading(null), false);
  assert.strictEqual(mlInternals.hasTempReading({}), false);
  assert.strictEqual(mlInternals.hasTempReading({ temp: null }), false);
  assert.strictEqual(mlInternals.hasTempReading({ temp: NaN }), false);
  assert.strictEqual(mlInternals.hasTempReading({ temp: '61' }), false, 'a string is not a reading');
});

test('the model is not told weather it never got', async () => {
  await mlPredictor.init();
  const withWeather = await realPredictBusyness.call(
    mlPredictor, { ...DENVER, popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(50) })) },
    { temp: 61, conditionId: 800, humidity: 40, windSpeed: 2, isRaining: false }, new Date());
  const without = await realPredictBusyness.call(
    mlPredictor, { ...DENVER, popular_times: Array.from({ length: 7 }, (_, d) => ({ day: d, data: Array(24).fill(50) })) },
    null, new Date());

  assert.ok(!without.dataSourcesUsed.includes('weather'),
    'the rule engine drops weather from its sources on an outage; the ML path must too');
  if (withWeather.predictionMethod === 'ml' && without.predictionMethod === 'ml') {
    assert.ok(withWeather.dataSourcesUsed.includes('weather'));
    assert.ok(without.confidence < withWeather.confidence,
      'a prediction made without a reading must not claim the same confidence');
  }
});

test('venue coordinates reach the feature vector', () => {
  // Every live caller shapes a venue as { location: { latitude, longitude } }.
  // Reading only venue.latitude built every live prediction at 0,0: astronomy
  // on the equator, and specialNightContext all-zeros because 0,0 is nowhere
  // near a training city — i.e. the v2.5 special-night features were dead in
  // production while the training rows carried real coordinates.
  const ts = new Date(2026, 10, 25, 20, 0); // Thanksgiving Eve week, NYC
  const nyc = { ...DENVER, location: { latitude: 40.71, longitude: -74.0 } };
  const atOrigin = { ...DENVER, location: null };
  const here = mlInternals.buildFeatureMap(nyc, null, ts, {}, {}, 50, {});
  const nowhere = mlInternals.buildFeatureMap(atOrigin, null, ts, {}, {}, 50, {});
  assert.notStrictEqual(here.daylight_hours, nowhere.daylight_hours,
    'a New York November evening is not an equatorial one');
});

// ---------------------------------------------------------------------------
// 6. Hours are a circle
// ---------------------------------------------------------------------------

test('the feedback hour window wraps midnight instead of clamping at it', () => {
  // Friday 23:00 (day 5) — its neighbours are Friday 22:00 and SATURDAY 00:00.
  assert.deepStrictEqual(feedbackWindow(5, 23), [[5, 22], [5, 23], [6, 0]]);
  // Saturday 00:00 — reaches back into Friday night, which is the whole point.
  assert.deepStrictEqual(feedbackWindow(6, 0), [[5, 23], [6, 0], [6, 1]]);
  // The week wraps too: Sunday 00:00 borders Saturday 23:00.
  assert.deepStrictEqual(feedbackWindow(0, 0), [[6, 23], [0, 0], [0, 1]]);
  assert.deepStrictEqual(feedbackWindow(6, 23), [[6, 22], [6, 23], [0, 0]]);
  // An ordinary hour is unchanged.
  assert.deepStrictEqual(feedbackWindow(3, 14), [[3, 13], [3, 14], [3, 15]]);
});

test('a report filed at 23:00 is asked for by the midnight read', async () => {
  handlers.push([/FROM venue_feedback/, () => ({ rows: [] })]);
  await get('/api/crowd/PLACE_MIDNIGHT?localHour=0&localDay=6');
  const fb = queries.find((q) => /FROM venue_feedback/.test(q.sql));
  assert.ok(fb, 'the crowd route queries feedback');
  // The clock the venue is scored on comes from Google's utcOffsetMinutes, so
  // assert the SHAPE — three (day, hour) pairs — rather than the exact hour.
  assert.match(fb.sql, /\(day_of_week, hour\) IN/);
  assert.strictEqual(fb.params.length, 7);
  const hours = [fb.params[2], fb.params[4], fb.params[6]];
  assert.strictEqual(new Set(hours).size, 3, 'three distinct hours, never a clamped pair');
  for (const h of hours) assert.ok(h >= 0 && h <= 23, `hour ${h} out of range`);
});

test('the batch and alternatives queries use the same wrapped window', async () => {
  handlers.push([/FROM venue_feedback/, () => ({ rows: [] })]);
  await post('/api/crowd/batch', {
    // No utcOffsetMinutes on this venue, so it falls back to the caller's clock
    // and the window is the caller's 23:00 Friday — wrapped into Saturday.
    venues: [{ place_id: 'PLACE_A', location: { latitude: 39.74, longitude: -104.98 } }],
    localHour: 23, localDay: 5,
  });
  const batch = queries.find((q) => /FROM venue_feedback/.test(q.sql));
  assert.deepStrictEqual(
    batchWindowTriples(batch),
    feedbackWindow(5, 23).map(([d, h]) => ['PLACE_A', d, h]));

  queries = [];
  await get('/api/crowd/PLACE_WINDOW_ALT/alternatives?localHour=23&localDay=5');
  const alts = queries.find((q) => /FROM venue_feedback/.test(q.sql));
  assert.match(alts.sql, /\(day_of_week, hour\) IN/);
  assert.strictEqual(alts.params.length, 7);
});

// The metadata read above is what makes the climatology assertions meaningful;
// if a retrain ever drops temp_norms, tempForFeature returns null and
// predictBusyness answers with the rule engine rather than inventing a number.
test('a model with no climatology falls back rather than inventing a temperature', () => {
  assert.ok(META.temp_norms && Object.keys(META.temp_norms).length > 0,
    'the shipped artifact carries the climatology the imputation reads');
  assert.strictEqual(mlInternals.tempForFeature({ temp: 12 }, 39.74, 1), 12);
  assert.ok(Number.isFinite(mlInternals.tempForFeature(null, 39.74, 1)));
  // An unseen latitude band still resolves, via the mean of the norms table —
  // the same global fill prepare_features.add_climate_anomaly uses.
  assert.ok(Number.isFinite(mlInternals.climateNorm(-89, 7)));
});
