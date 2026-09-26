// Run: node --test  (from backend/)
//
// ===========================================================================
// THE ATTRIBUTION FOLLOWS THE NUMBER THAT SHIPS, NOT THE ONE THAT WAS SERVED.
//
// While a serving switch is on (CROWD_SERVE_MODE=curve_offset or
// CROWD_NOWCAST_ENABLED=true) the predictor names the arithmetic behind its
// number, and a reading carried at full weight is named as that reading:
// 'live_reading_1h' means "the number IS the venue's reading from an hour
// ago". Two things can move the number after the predictor: verified
// reporters' blend (buildCalibrationAdjustment) and the owner's live reading
// (ownerReports.applyOwnerReport). Either one used to leave the served name
// on the payload, so a reading of 20 blended to 35 still went out as
// live_reading_1h, and Birdie's hard rule then described 35 as the reading
// carried forward.
//
// Pinned here end to end, through the real routes with the predictor, Google,
// the weather and Postgres stubbed:
//   * the card (/api/crowd/:placeId): '_adjusted' after a reporters' blend,
//     nothing under an applied owner reading, the plain name otherwise;
//   * Birdie (get_crowd_prediction): the same for crowd_method;
//   * the public demo and the venue dashboard, which adjust nothing, publish
//     the plain name;
//   * with both switches off, no surface carries the key at all.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'crowd-attribution-adjusted-secret';
// Captured at module load by the routers below.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.TICKETMASTER_API_KEY;

const crowdEngine = require('../services/crowdEngine');

// --- scripted pg ------------------------------------------------------------
const pool = require('../config/database');
let ownerRows = {};
let feedbackRows = [];
let venueCtx = null;
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/DISTINCT ON \(r\.google_place_id\)/.test(flat)) {
    const ids = Array.isArray(params && params[0]) ? params[0] : [];
    return Promise.resolve({ rows: ids.map((id) => ownerRows[id]).filter(Boolean) });
  }
  if (/FROM venue_feedback/.test(flat)) return Promise.resolve({ rows: feedbackRows });
  if (/SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles/.test(flat)) {
    return Promise.resolve({ rows: venueCtx ? [venueCtx] : [] });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// --- weather, stubbed before the routes destructure it -----------------------
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3, isRaining: false, conditionId: 800, fetchedAt: Date.now() });
weatherService.getHourlyForecast = async () => null;
weatherService.getForecast = async () => [];

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 4301, name: 'Attr', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
placesBudget.allowGlobalPlacesCall = () => true;

// --- the predictor: a switched number that IS a reading from an hour ago -----
const READING = 20;
let SWITCHED = true;
function servedResult() {
  const base = {
    score: READING,
    label: crowdEngine.getLabel(READING),
    confidence: 60,
    factors: {},
    predictionMethod: 'ml',
  };
  if (!SWITCHED) {
    return { ...base, dataSourcesUsed: ['ml_model'], modelVersion: 'attr-test' };
  }
  // The shape mlPredictor.predictBusyness returns with CROWD_NOWCAST_ENABLED
  // on and a one-hour-old reading carried at weight 1.
  return {
    ...base,
    dataSourcesUsed: ['ml_model', 'recent_live_readings'],
    modelVersion: 'attr-test+nowcast',
    serveMode: 'model',
    nowcast: { base: 'model_qmap', lagHours: 1, bucket: 1, weight: 1, reading: READING },
    offsetChangedBySwitch: false,
    usedLiveReadings: true,
  };
}
function hourLabel(h24) {
  const h = ((h24 % 24) + 24) % 24;
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h} ${h >= 12 ? 'PM' : 'AM'}`;
}
const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => servedResult();
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => ({
    hour: hourLabel(startHour + i),
    score: READING,
    label: crowdEngine.getLabel(READING),
    predictionMethod: 'ml',
    baselineScore: READING,
    ...(SWITCHED ? { numberSource: 'live_reading_1h', liveReadings: true } : {}),
  }));

// --- Google, faked -----------------------------------------------------------
const realFetch = global.fetch;
function place(id) {
  return {
    id,
    displayName: { text: 'The Attribution Bar' },
    formattedAddress: '1 Test St',
    rating: 4.4,
    userRatingCount: 300,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 39.95, longitude: -75.16 },
    currentOpeningHours: { openNow: true, periods: [{ open: { day: 0, hour: 0, minute: 0 } }] },
    utcOffsetMinutes: 0,
  };
}
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length).split('?')[0]);
    return Promise.resolve({ ok: true, status: 200, json: async () => place(id) });
  }
  if (u.startsWith('https://places.googleapis.com/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [] }) });
  }
  if (u.startsWith('https://app.ticketmaster.com/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }
  return realFetch(url, opts);
};

// --- routers (required AFTER every stub above) ------------------------------
const crowdRouter = require('../routes/crowd');
const publicCrowdRouter = require('../routes/publicCrowd');
const venueDashboardRouter = require('../routes/venueDashboard');
const aiRouter = require('../routes/ai');
const { executeTool } = aiRouter.__testables;
const placeDetailsCache = require('../services/placeDetailsCache');
const { __resetPlacesBudget } = require('../utils/placesBudget');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
app.use('/api/public', publicCrowdRouter);
app.use('/api/venue-dashboard', venueDashboardRouter);

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

let nextUser = 4400;
test.beforeEach(() => {
  ownerRows = {};
  feedbackRows = [];
  venueCtx = null;
  SWITCHED = true;
  CURRENT_USER = { id: ++nextUser, name: 'Attr', role: 'user' };
  if (typeof __resetPlacesBudget === 'function') __resetPlacesBudget();
  placeDetailsCache.__test.reset();
  crowdRouter.__test.clearCache();
});

async function call(method, path) {
  const res = await realFetch(base + path, { method, headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

let seq = 0;
const freshId = (tag) => `ChIJattr${tag}${String(++seq).padStart(5, '0')}`;

function liveOwnerRow(placeId, percent) {
  const at = new Date(Date.now() - 5 * 60 * 1000);
  return {
    id: 91,
    google_place_id: placeId,
    busy_percent: percent,
    created_at: at,
    diverged: false,
    profile_category: 'bar',
    assertion_since: at,
  };
}

// Three verified people in the room saying it is busy, filed two minutes ago.
function threeBusyReporters() {
  const filed = new Date(Date.now() - 2 * 60 * 1000);
  return [1, 2, 3].map((n) => ({ crowd_level: 3, predicted_score: READING, user_id: 7000 + n, created_at: filed }));
}

// ===========================================================================
// The card.
// ===========================================================================

test('the card names a carried reading as the reading only while nothing adjusted it', async () => {
  const id = freshId('CARDPLAIN');
  const plain = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(plain.status, 200, plain.text);
  assert.strictEqual(plain.body.score, READING, 'the number is the reading');
  assert.strictEqual(plain.body.numberSource, 'live_reading_1h');
});

test('the card: a reading blended with verified reporters is named as adjusted, never as the reading', async () => {
  const id = freshId('CARDBLEND');
  feedbackRows = threeBusyReporters();
  const res = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.confidenceBasis, 'user_reports');
  assert.notStrictEqual(res.body.score, READING, 'the reporters moved the number');
  assert.strictEqual(res.body.rawEngineScore, READING);
  assert.strictEqual(res.body.numberSource, 'live_reading_1h_adjusted');
});

test('the card: an applied owner reading carries no served source', async () => {
  const id = freshId('CARDOWNER');
  ownerRows[id] = liveOwnerRow(id, 85);
  const res = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.score, 85);
  assert.strictEqual(res.body.predictionMethod, 'owner_report');
  assert.ok(!('numberSource' in res.body), 'the owner\'s 85 is not the venue\'s reading from an hour ago');

  // On a cache hit too: the cached card was built with the served name.
  delete ownerRows[id];
  const cached = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(cached.body.numberSource, 'live_reading_1h');
  ownerRows[id] = liveOwnerRow(id, 85);
  const owned = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(owned.body.predictionMethod, 'owner_report');
  assert.ok(!('numberSource' in owned.body));
});

test('the card: reporters who outrank an owner reading leave the adjusted name', async () => {
  const id = freshId('CARDOUTRANK');
  ownerRows[id] = liveOwnerRow(id, 85);
  feedbackRows = threeBusyReporters();
  const res = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.ownerReport.applied, false);
  assert.strictEqual(res.body.confidenceBasis, 'user_reports');
  assert.strictEqual(res.body.numberSource, 'live_reading_1h_adjusted');
});

test('the card with both switches off carries no source, whatever adjusted the number', async () => {
  SWITCHED = false;
  const plain = await call('GET', `/api/crowd/${freshId('OFFPLAIN')}`);
  assert.strictEqual(plain.status, 200, plain.text);
  assert.ok(!('numberSource' in plain.body));
  feedbackRows = threeBusyReporters();
  const blended = await call('GET', `/api/crowd/${freshId('OFFBLEND')}`);
  assert.strictEqual(blended.body.confidenceBasis, 'user_reports');
  assert.ok(!('numberSource' in blended.body));
  for (const h of blended.body.hourly) assert.ok(!('numberSource' in h) && !('liveReadings' in h), h.hour);
  const ownedId = freshId('OFFOWNER');
  ownerRows[ownedId] = liveOwnerRow(ownedId, 85);
  feedbackRows = [];
  const owned = await call('GET', `/api/crowd/${ownedId}`);
  assert.ok(!('numberSource' in owned.body));
});

// ===========================================================================
// Birdie.
// ===========================================================================

const ask = (id, uid) => executeTool('get_crowd_prediction', { place_id: id }, uid, { includeForecast: true });

test('Birdie names a carried reading as the reading only while nothing adjusted it', async () => {
  const id = freshId('BIRDIEPLAIN');
  const out = await ask(id, 4501);
  assert.strictEqual(out.crowd_score, READING);
  assert.strictEqual(out.crowd_method, 'live_reading_1h');
});

test('Birdie: when reporters outrank the owner, the blend is named as adjusted, never as the reading', async () => {
  const id = freshId('BIRDIEBLEND');
  ownerRows[id] = liveOwnerRow(id, 85);
  feedbackRows = threeBusyReporters();
  const out = await ask(id, 4502);
  assert.strictEqual(out.crowd_source, 'user_reports');
  assert.notStrictEqual(out.crowd_score, READING, 'the reporters moved the number');
  assert.strictEqual(out.crowd_method, 'live_reading_1h_adjusted');
});

test('Birdie: an applied owner reading carries no crowd_method', async () => {
  const id = freshId('BIRDIEOWNER');
  ownerRows[id] = liveOwnerRow(id, 85);
  const out = await ask(id, 4503);
  assert.strictEqual(out.crowd_source, 'owner_report');
  assert.strictEqual(out.crowd_score, 85);
  assert.ok(!('crowd_method' in out));
});

test('Birdie with both switches off carries no crowd_method on any path', async () => {
  SWITCHED = false;
  const a = freshId('BIRDIEOFF');
  assert.ok(!('crowd_method' in await ask(a, 4504)));
  const b = freshId('BIRDIEOFFBLEND');
  ownerRows[b] = liveOwnerRow(b, 85);
  feedbackRows = threeBusyReporters();
  const blended = await ask(b, 4505);
  assert.strictEqual(blended.crowd_source, 'user_reports');
  assert.ok(!('crowd_method' in blended));
});

test('Birdie is told what an adjusted source means, in plain words', () => {
  const { buildSystemPrompt } = aiRouter.__testables;
  for (const ageBracket of ['adult', 'teen', null]) {
    const prompt = buildSystemPrompt('Ava', {}, { ageBracket });
    const rule = /- When get_crowd_prediction returns `crowd_method`[^\n]*/.exec(prompt);
    assert.ok(rule, 'the crowd_method rule is in the prompt');
    assert.match(rule[0], /A value ending in "_adjusted" \(for example "live_reading_1h_adjusted"\) means that same source, then adjusted by verified reports from people who are at the venue\./);
    assert.match(rule[0], /Say the number was adjusted by people who are there, and never present it as the live reading itself or as an unadjusted number\./);
    assert.doesNotMatch(rule[0], /—/, 'no em dash');
  }
});

// ===========================================================================
// The public demo and the venue dashboard adjust nothing.
// ===========================================================================

test('the public demo names the served source, and nothing with both switches off', async () => {
  const on = await call('GET', `/api/public/demo/venue/${freshId('DEMO')}?localHour=20&localDay=5`);
  assert.strictEqual(on.status, 200, on.text);
  assert.strictEqual(on.body.number_source, 'live_reading_1h');
  SWITCHED = false;
  const off = await call('GET', `/api/public/demo/venue/${freshId('DEMOOFF')}?localHour=20&localDay=5`);
  assert.strictEqual(off.status, 200, off.text);
  assert.ok(!('number_source' in off.body));
});

test('the venue dashboard names the served source and carries each hour\'s, and nothing with both switches off', async () => {
  CURRENT_USER = { id: 4601, name: 'Owner', role: 'venue_owner' };
  venueCtx = { id: 31, google_place_id: freshId('DASH'), verified: true };
  const on = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(on.status, 200, on.text);
  assert.strictEqual(on.body.available, true, on.text);
  assert.strictEqual(on.body.numberSource, 'live_reading_1h');
  assert.ok(on.body.todayHourly.every((h) => h.numberSource === 'live_reading_1h' && h.liveReadings === true));

  SWITCHED = false;
  CURRENT_USER = { id: 4602, name: 'Owner', role: 'venue_owner' };
  venueCtx = { id: 32, google_place_id: freshId('DASHOFF'), verified: true };
  const off = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(off.status, 200, off.text);
  assert.ok(!('numberSource' in off.body));
  assert.ok(off.body.todayHourly.every((h) => !('numberSource' in h) && !('liveReadings' in h)));
});
