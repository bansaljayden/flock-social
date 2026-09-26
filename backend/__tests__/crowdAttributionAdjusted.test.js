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
//   * Birdie's hourly_forecast, the public demo's bars and the venue
//     dashboard's strip say what made each hour or peak, so no chart or
//     narration is attributed off the headline;
//   * an '_adjusted' number is never described as people who are there now:
//     the blend reads 28 days of reports for this time of week;
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
// Per-hour switched fields, by index, when a test needs hours that differ.
// predictHourlyForecast only ever sends numberSource and liveReadings while a
// switch is on, so nothing here applies with SWITCHED false.
let HOURLY = null;
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => ({
    hour: hourLabel(startHour + i),
    score: READING,
    label: crowdEngine.getLabel(READING),
    predictionMethod: 'ml',
    baselineScore: READING,
    ...(SWITCHED ? (HOURLY ? HOURLY(i) : { numberSource: 'live_reading_1h', liveReadings: true }) : {}),
  }));

// A strip whose hours differ, as a switch makes them: the first hour's
// pattern plus a reading, a model hour whose live offset landed on the stored
// one (no source, readings used), three hours of the pattern alone, and the
// rest answered by the rule engine for want of a baseline.
function mixedHour(i) {
  if (i === 0) return { numberSource: 'venue_pattern_live', liveReadings: true };
  if (i === 1) return { liveReadings: true };
  if (i < 5) return { numberSource: 'venue_pattern', liveReadings: false };
  return { predictionMethod: 'rule_engine_no_baseline', liveReadings: false };
}

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
  HOURLY = null;
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

test('Birdie is told what an adjusted source means, and that its reports are not from tonight', () => {
  const { buildSystemPrompt } = aiRouter.__testables;
  for (const ageBracket of ['adult', 'teen', null]) {
    const prompt = buildSystemPrompt('Ava', {}, { ageBracket });
    const rule = /- When get_crowd_prediction returns `crowd_method`[^\n]*/.exec(prompt);
    assert.ok(rule, 'the crowd_method rule is in the prompt');
    // The blend reads verified reports for this weekly slot from the last 28
    // days, so three "busy" reports from last Friday can move tonight's
    // number. Nothing about it is contemporaneous.
    assert.match(rule[0], /A value ending in "_adjusted" \(for example "live_reading_1h_adjusted"\) means that same source, then adjusted by verified visitor reports filed for this time of week over the last four weeks\./);
    assert.match(rule[0], /Those reports can be days or weeks old, so never say or imply that people at the venue right now adjusted it\./);
    assert.match(rule[0], /Say it was adjusted by visitor reports from this time of week, and never present it as the live reading itself or as an unadjusted number\./);
    assert.doesNotMatch(rule[0], /people who are there|people who are at the venue/);
    assert.doesNotMatch(rule[0], /—/, 'no em dash');
  }
});

test('Birdie is told to attribute each forecast hour by its own source', () => {
  const { buildSystemPrompt } = aiRouter.__testables;
  const prompt = buildSystemPrompt('Ava', {}, { ageBracket: 'adult' });
  const rule = /- Each entry in `hourly_forecast`[^\n]*/.exec(prompt);
  assert.ok(rule, 'the per-hour rule is in the prompt');
  assert.match(rule[0], /Attribute each hour by its own `crowd_method`, with the meanings above, and never by the headline's/);
  assert.match(rule[0], /An hour without `crowd_method` is the crowd model's number when its `predictionMethod` is "ml"\./);
  assert.match(rule[0], /`live_readings` says whether the venue's recent live readings reached that hour's number\. When it is false, never say that hour used live readings\./);
  assert.doesNotMatch(rule[0], /—/, 'no em dash');
});

// ===========================================================================
// Birdie's hourly forecast: each hour says what made it.
// ===========================================================================

const SWITCHED_OFF_HOUR_KEYS = ['hour', 'label', 'predictionMethod', 'score'];
const keysOf = (o) => Object.keys(o).sort();

test('Birdie: every forecast hour carries its own source and live-readings answer while a switch is on', async () => {
  HOURLY = mixedHour;
  const out = await ask(freshId('BIRDIEHOURS'), 4506);
  const hf = out.hourly_forecast;
  assert.strictEqual(hf.length, 12);
  // The first hour is the headline's number and takes the headline's
  // attribution, not the strip's own first bar.
  assert.strictEqual(hf[0].score, out.crowd_score);
  assert.strictEqual(hf[0].crowd_method, 'live_reading_1h');
  assert.strictEqual(hf[0].live_readings, true);
  // A model hour with no named source still says a reading reached it.
  assert.strictEqual(hf[1].predictionMethod, 'ml');
  assert.ok(!('crowd_method' in hf[1]));
  assert.strictEqual(hf[1].live_readings, true);
  // The pattern alone: no model ran and no reading reached it, whatever the
  // headline says.
  for (const i of [2, 3, 4]) {
    assert.strictEqual(hf[i].predictionMethod, 'ml');
    assert.strictEqual(hf[i].crowd_method, 'venue_pattern', `hour ${i}`);
    assert.strictEqual(hf[i].live_readings, false, `hour ${i}`);
  }
  // A rule-engine hour is typical for the category and read nothing live.
  for (let i = 5; i < 12; i++) {
    assert.strictEqual(hf[i].predictionMethod, 'rule_engine_no_baseline');
    assert.ok(!('crowd_method' in hf[i]), `hour ${i}`);
    assert.strictEqual(hf[i].live_readings, false, `hour ${i}`);
  }
});

test('Birdie: a first hour replaced by a reporters\' blend is named as adjusted; the rest keep their own', async () => {
  HOURLY = mixedHour;
  const id = freshId('BIRDIEHOURBLEND');
  ownerRows[id] = liveOwnerRow(id, 85);
  feedbackRows = threeBusyReporters();
  const out = await ask(id, 4507);
  const hf = out.hourly_forecast;
  assert.strictEqual(out.crowd_source, 'user_reports');
  assert.strictEqual(hf[0].score, out.crowd_score);
  assert.strictEqual(hf[0].crowd_method, 'live_reading_1h_adjusted');
  assert.strictEqual(hf[0].live_readings, true);
  assert.strictEqual(hf[2].crowd_method, 'venue_pattern', 'the blend moved the current hour only');
});

test('Birdie: a first hour replaced by the owner\'s reading carries neither key', async () => {
  HOURLY = mixedHour;
  const id = freshId('BIRDIEHOUROWNER');
  ownerRows[id] = liveOwnerRow(id, 85);
  const out = await ask(id, 4508);
  const hf = out.hourly_forecast;
  assert.strictEqual(hf[0].score, 85);
  assert.strictEqual(hf[0].predictionMethod, 'owner_report');
  assert.ok(!('crowd_method' in hf[0]), 'the owner\'s 85 is not the venue\'s pattern');
  assert.ok(!('live_readings' in hf[0]));
  assert.strictEqual(hf[2].crowd_method, 'venue_pattern');
});

test('Birdie with both switches off: every forecast hour keeps exactly its four keys, on every path', async () => {
  SWITCHED = false;
  const plain = await ask(freshId('BIRDIEHOUROFF'), 4509);
  for (const h of plain.hourly_forecast) assert.deepStrictEqual(keysOf(h), SWITCHED_OFF_HOUR_KEYS, h.hour);
  assert.strictEqual(plain.hourly_forecast[0].predictionMethod, 'ml');

  const b = freshId('BIRDIEHOUROFFBLEND');
  ownerRows[b] = liveOwnerRow(b, 85);
  feedbackRows = threeBusyReporters();
  const blended = await ask(b, 4510);
  assert.strictEqual(blended.crowd_source, 'user_reports');
  for (const h of blended.hourly_forecast) assert.deepStrictEqual(keysOf(h), SWITCHED_OFF_HOUR_KEYS, h.hour);
  assert.strictEqual(blended.hourly_forecast[0].score, blended.crowd_score);

  const o = freshId('BIRDIEHOUROFFOWNER');
  ownerRows[o] = liveOwnerRow(o, 85);
  feedbackRows = [];
  const owned = await ask(o, 4511);
  for (const h of owned.hourly_forecast) assert.deepStrictEqual(keysOf(h), SWITCHED_OFF_HOUR_KEYS, h.hour);
  assert.strictEqual(owned.hourly_forecast[0].predictionMethod, 'owner_report');
  assert.strictEqual(owned.hourly_forecast[0].score, 85);
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

test('the public demo carries each bar\'s source, so its caption can be read off the bars drawn', async () => {
  HOURLY = mixedHour;
  const on = await call('GET', `/api/public/demo/venue/${freshId('DEMOBARS')}?localHour=20&localDay=5`);
  assert.strictEqual(on.status, 200, on.text);
  const bars = on.body.hourly;
  assert.strictEqual(bars.length, 12, on.text);
  assert.strictEqual(bars[0].numberSource, 'venue_pattern_live');
  assert.strictEqual(bars[0].liveReadings, true);
  assert.ok(!('numberSource' in bars[1]));
  assert.strictEqual(bars[1].liveReadings, true);
  for (const i of [2, 3, 4]) {
    assert.strictEqual(bars[i].numberSource, 'venue_pattern', `bar ${i}`);
    assert.strictEqual(bars[i].liveReadings, false, `bar ${i}`);
  }
  for (let i = 5; i < 12; i++) {
    assert.strictEqual(bars[i].predictionMethod, 'rule_engine_no_baseline');
    assert.ok(!('numberSource' in bars[i]));
    assert.strictEqual(bars[i].liveReadings, false);
  }
  // The headline is the served number's, which is not the chart's.
  assert.strictEqual(on.body.number_source, 'live_reading_1h');
});

test('the public demo with both switches off: every bar keeps exactly the keys it had', async () => {
  SWITCHED = false;
  const off = await call('GET', `/api/public/demo/venue/${freshId('DEMOBARSOFF')}?localHour=20&localDay=5`);
  assert.strictEqual(off.status, 200, off.text);
  assert.strictEqual(off.body.hourly.length, 12, off.text);
  for (const b of off.body.hourly) {
    assert.deepStrictEqual(keysOf(b), ['hour', 'label', 'open', 'predictionMethod', 'score'], b.hour);
  }
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

// ===========================================================================
// The venue dashboard's strip: each row's peak says what made it.
// ===========================================================================

test('the strip carries what made each row\'s peak while a switch is on, and nothing with both off', async () => {
  HOURLY = mixedHour;
  CURRENT_USER = { id: 4611, name: 'Owner', role: 'venue_owner' };
  venueCtx = { id: 41, google_place_id: freshId('STRIP'), verified: true };
  const on = await call('GET', '/api/venue-dashboard/strip');
  assert.strictEqual(on.status, 200, on.text);
  assert.strictEqual(on.body.available, true, on.text);
  // Every hour scores the same, so the peak is the evening's first hour.
  assert.strictEqual(on.body.you.peakMethod, 'ml');
  assert.strictEqual(on.body.you.peakNumberSource, 'venue_pattern_live');
  assert.strictEqual(on.body.you.peakLiveReadings, true);

  SWITCHED = false;
  CURRENT_USER = { id: 4612, name: 'Owner', role: 'venue_owner' };
  venueCtx = { id: 42, google_place_id: freshId('STRIPOFF'), verified: true };
  const off = await call('GET', '/api/venue-dashboard/strip');
  assert.strictEqual(off.status, 200, off.text);
  assert.strictEqual(off.body.available, true, off.text);
  assert.deepStrictEqual(keysOf(off.body.you), ['label', 'method', 'name', 'peakHour', 'peakScore', 'score']);
});
