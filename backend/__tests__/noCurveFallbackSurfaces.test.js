// Run: node --test  (from backend/)
//
// ===========================================================================
// THE CATEGORY TABLE'S NUMBER, THROUGH EVERY SURFACE THAT PUBLISHES ONE.
//
// With CROWD_NO_CURVE_FALLBACK=category_curve, services/mlPredictor.js answers
// a venue with no curve of its own (200+ Google reviews, no ml_venue_baselines
// row at all) with the shipped artifact's typical level for its category at
// that weekday and hour, tagged rule_engine_category_table. Every surface has
// to say what that is: what is typical for that kind of place at that hour,
// never the venue's own pattern, never the trained model, never live.
//
// Pinned here end to end, through the real routes and the REAL predictor
// (only Google, the weather, the ONNX session and Postgres are scripted, and
// Postgres holds no curve for anybody):
//   * the card: the hedged label, basis category_pattern, numberSource
//     category_typical (category_typical_adjusted once verified reporters
//     blend in), the measured confidence block with its own population, no
//     model version, no model or live source, every bar named, and the serve
//     recorded under the new method;
//   * the vote list under it: the same evidence, row by row;
//   * the public demo: confidence_basis, number_source, the hedged label and
//     the bars;
//   * Birdie's crowd tool and its rules, which name the method only while the
//     switch can serve it;
//   * the venue's embeddable badge, which hedges it and does not call it live;
//   * the venue dashboard's strip, whose row names a peak the table made even
//     with both serving switches off (the fallback is a switch, so the hours
//     say what made them, every one a plain no to live readings);
//   * with the switch off, every one of those reads exactly as it did.
//
// __tests__/noCurveFallback.test.js pins the predictor's gates and figure.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.TZ = 'UTC';
process.env.JWT_SECRET = 'no-curve-fallback-surfaces-secret';
// Captured at module load by the routers below.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.TICKETMASTER_API_KEY;
delete process.env.ML_SHIP_GATE_OVERRIDE;
for (const k of ['CROWD_NO_CURVE_FALLBACK', 'CROWD_SERVE_MODE', 'CROWD_NOWCAST_ENABLED']) delete process.env[k];

const SWITCH = 'CROWD_NO_CURVE_FALLBACK';
const METHOD = 'rule_engine_category_table';
const META = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'models', 'model_metadata.json'), 'utf8'));

// --- the ONNX session: the real artifact's shape, and a run() that throws, so
// a model run on any of these paths would surface as rule_engine_fallback.
const ORT = require.resolve('onnxruntime-node');
require.cache[ORT] = {
  id: ORT,
  filename: ORT,
  loaded: true,
  exports: {
    InferenceSession: {
      create: async () => ({
        inputNames: [META.onnx_input_name || 'input'],
        outputNames: ['variable'],
        inputMetadata: [{ name: META.onnx_input_name || 'input', isTensor: true, type: 'float32', shape: ['', META.feature_names.length] }],
        outputMetadata: [{ name: 'variable', isTensor: true, type: 'float32', shape: ['', 1] }],
        run: async () => { throw new Error('the model ran on a path that must not run it'); },
      }),
    },
    Tensor: class Tensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
  },
};

const crowdEngine = require('../services/crowdEngine');

// --- scripted pg: no curve for anybody --------------------------------------
const pool = require('../config/database');
let feedbackRows = [];
let served = [];
// The signed-in owner's venue, for the venue dashboard's strip.
let venueCtx = null;
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM venue_feedback/.test(flat)) return Promise.resolve({ rows: feedbackRows });
  if (/SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles WHERE user_id = \$1/.test(flat)) {
    return Promise.resolve({ rows: venueCtx ? [venueCtx] : [] });
  }
  if (/^INSERT INTO served_predictions/.test(flat)) {
    served.push(params);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (/FROM venue_profiles WHERE google_place_id = \$1 AND verified = true/.test(flat)) {
    return Promise.resolve({ rows: [{ '?column?': 1 }] });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// --- weather, stubbed before the routes destructure it -----------------------
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3, isRaining: false, conditionId: 800, fetchedAt: Date.now() });
weatherService.getHourlyForecast = async () => null;
weatherService.getForecast = async () => [];

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 5301, name: 'Cat', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
placesBudget.allowGlobalPlacesCall = () => true;

// --- Google, faked: a bar with 300 reviews on UTC, open around the clock -----
const realFetch = global.fetch;
function place(id) {
  return {
    id,
    displayName: { text: 'The Category Bar' },
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
  return realFetch(url, opts);
};

// --- routers (required AFTER every stub above) ------------------------------
const mlPredictor = require('../services/mlPredictor');
const crowdRouter = require('../routes/crowd');
const publicCrowdRouter = require('../routes/publicCrowd');
const badgeRouter = require('../routes/badge');
const venueDashboardRouter = require('../routes/venueDashboard');
const aiRouter = require('../routes/ai');
const { executeTool, buildSystemPrompt } = aiRouter.__testables;
const { confidenceMeasurementFor } = crowdRouter;
const placeDetailsCache = require('../services/placeDetailsCache');
const { __resetPlacesBudget } = require('../utils/placesBudget');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
app.use('/api/public', publicCrowdRouter);
app.use('/api/badge', badgeRouter);
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

let nextUser = 5400;
test.beforeEach(() => {
  feedbackRows = [];
  served = [];
  venueCtx = null;
  delete process.env[SWITCH];
  CURRENT_USER = { id: ++nextUser, name: 'Cat', role: 'user' };
  if (typeof __resetPlacesBudget === 'function') __resetPlacesBudget();
  placeDetailsCache.__test.reset();
  crowdRouter.__test.clearCache();
  mlPredictor._internals.__resetVenueLookupCaches();
  publicCrowdRouter.__testables.resetDemoRevealsForTest();
  badgeRouter.__test.resetBadgeBudget();
});

async function call(method, path_, body) {
  const res = await realFetch(base + path_, {
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
const freshId = (tag) => `ChIJcat${tag}${String(++seq).padStart(5, '0')}`;
const on = () => { process.env[SWITCH] = 'category_curve'; };

// The table's value for a bar at the clock a payload says it was scored on.
const barValue = (day, hour) => Math.round(META.category_baselines[`bar_${day}_${hour}`]);
const HEDGED = /^Usually (quiet|not busy|steady|busy|packed)$/;
// Words that would describe the number as something it is not.
const NOT_THIS = /crowd model|\blive\b|usual pattern|this venue/i;

function threeBusyReporters() {
  const filed = new Date(Date.now() - 2 * 60 * 1000);
  return [1, 2, 3].map((n) => ({ crowd_level: 3, predicted_score: 40, user_id: 9100 + n, created_at: filed }));
}

// ===========================================================================
// The card.
// ===========================================================================

test('the card says the number is typical for this kind of place, measured as such, and records it under its own name', async () => {
  on();
  const id = freshId('CARD');
  const res = await call('GET', `/api/crowd/${id}`);
  assert.strictEqual(res.status, 200, res.text);
  const c = res.body;
  assert.strictEqual(c.predictionMethod, METHOD);
  assert.strictEqual(c.score, barValue(c.venueClock.day, c.venueClock.hour), 'the table value for a bar at the card\'s own clock');
  assert.strictEqual(c.rawEngineScore, c.score);
  assert.match(c.label, HEDGED);
  assert.strictEqual(c.label, crowdEngine.publishedLabel(c.score, { supported: false }));
  assert.strictEqual(c.confidenceBasis, 'category_pattern');
  assert.strictEqual(c.supported, false);
  assert.strictEqual(c.confidenceMeans, 'measured_accuracy');
  assert.strictEqual(c.numberSource, 'category_typical');
  assert.strictEqual(c.modelVersion, null, 'no model ran');
  assert.strictEqual(c.baselineData, null);
  assert.strictEqual(c.confidence, 41);
  assert.deepStrictEqual(c.confidenceMeasurement, {
    status: 'measured',
    means: 'measured_accuracy',
    metric: 'within_15_rule_engine_category_table',
    population: mlPredictor._internals.NO_CURVE_FALLBACK_POPULATION,
    populationRows: 4248,
    measuredPercent: 41.3,
    weatherPenalty: 0,
    userReportBoost: 0,
    publishedPercent: 41,
  });
  assert.deepStrictEqual(c.dataSourcesUsed, ['google_places', 'category_curve']);
  // Every bar is the table's, named as such, and says no live reading reached
  // it: the fallback is a switch, so the bars say what made them.
  assert.strictEqual(c.hourly.length, 12);
  for (const h of c.hourly) {
    assert.strictEqual(h.predictionMethod, METHOD, h.hour);
    assert.strictEqual(h.numberSource, 'category_typical', h.hour);
    assert.strictEqual(h.liveReadings, false, h.hour);
    assert.ok(!('baselineScore' in h), h.hour);
  }
  assert.strictEqual(c.hourly[0].score, c.score, 'the Now bar and the dial are one number');
  // The serve is on record as what it was, never as the venue's own data.
  assert.strictEqual(served.length, 1);
  assert.deepStrictEqual(served[0][3], [METHOD]);
  assert.deepStrictEqual(served[0][4], [null]);
});

test('the card: verified reporters blended into it are named, and the source says it was adjusted', async () => {
  on();
  feedbackRows = threeBusyReporters();
  const res = await call('GET', `/api/crowd/${freshId('CARDBLEND')}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.predictionMethod, METHOD);
  assert.strictEqual(res.body.confidenceBasis, 'user_reports');
  assert.notStrictEqual(res.body.score, res.body.rawEngineScore, 'the reporters moved the number');
  assert.strictEqual(res.body.numberSource, 'category_typical_adjusted');
});

test('the card with the switch off is today\'s rule-engine card: no source, no measured figure', async () => {
  const res = await call('GET', `/api/crowd/${freshId('CARDOFF')}`);
  assert.strictEqual(res.status, 200, res.text);
  const c = res.body;
  assert.strictEqual(c.predictionMethod, 'rule_engine_no_baseline');
  assert.ok(!('numberSource' in c));
  assert.strictEqual(c.confidenceBasis, 'category_pattern');
  assert.strictEqual(c.confidenceMeans, 'input_completeness');
  assert.strictEqual(c.confidenceMeasurement.status, 'unmeasured');
  assert.match(c.label, HEDGED);
  for (const h of c.hourly) {
    assert.strictEqual(h.predictionMethod, 'rule_engine_no_baseline', h.hour);
    assert.ok(!('numberSource' in h), h.hour);
  }
  assert.deepStrictEqual(served[0][3], ['rule_engine_no_baseline']);
});

// ===========================================================================
// The vote list.
// ===========================================================================

test('the vote list gives each row the same evidence the card gives it', async () => {
  on();
  const ids = [freshId('ROWA'), freshId('ROWB')];
  const res = await call('POST', '/api/crowd/batch', {
    venues: [
      { place_id: ids[0], name: 'A', types: ['bar'], user_ratings_total: 300 },
      // Under 200 reviews: the rule engine still answers, today's row.
      { place_id: ids[1], name: 'B', types: ['bar'], user_ratings_total: 120 },
    ],
    localHour: 21,
    localDay: 5,
  });
  assert.strictEqual(res.status, 200, res.text);
  const [a, b] = res.body.predictions;
  assert.strictEqual(a.predictionMethod, METHOD);
  assert.strictEqual(a.score, barValue(5, 21));
  assert.match(a.label, HEDGED);
  assert.strictEqual(a.confidenceBasis, 'category_pattern');
  assert.strictEqual(a.confidenceMeans, 'measured_accuracy');
  assert.strictEqual(a.modelVersion, null);
  assert.strictEqual(a.confidenceMeasurement.metric, 'within_15_rule_engine_category_table');
  assert.strictEqual(a.confidenceMeasurement.publishedPercent, a.confidence);
  assert.strictEqual(b.predictionMethod, 'rule_engine_no_baseline');
  assert.strictEqual(b.confidenceMeasurement.status, 'unmeasured');
});

// ===========================================================================
// The public demo.
// ===========================================================================

test('the public demo names it typical for its category, hedges it, and names every bar', async () => {
  on();
  const res = await call('GET', `/api/public/demo/venue/${freshId('DEMO')}?localHour=20&localDay=5`);
  assert.strictEqual(res.status, 200, res.text);
  const d = res.body;
  assert.strictEqual(d.confidence_basis, 'category_pattern');
  assert.strictEqual(d.number_source, 'category_typical');
  assert.match(d.label, HEDGED);
  assert.strictEqual(d.confidence, 41);
  assert.strictEqual(d.confidence_measurement.status, 'measured');
  assert.strictEqual(d.confidence_measurement.metric, 'within_15_rule_engine_category_table');
  for (const h of d.hourly) {
    assert.strictEqual(h.predictionMethod, METHOD, h.hour);
    assert.strictEqual(h.numberSource, 'category_typical', h.hour);
    assert.strictEqual(h.liveReadings, false, h.hour);
  }
  // Off, the same card carries no source at all.
  delete process.env[SWITCH];
  const off = await call('GET', `/api/public/demo/venue/${freshId('DEMOOFF')}?localHour=20&localDay=5`);
  assert.strictEqual(off.status, 200, off.text);
  assert.ok(!('number_source' in off.body));
  assert.strictEqual(off.body.confidence_measurement.status, 'unmeasured');
});

// ===========================================================================
// Birdie.
// ===========================================================================

test('Birdie is handed the number as typical for this kind of place, hour by hour', async () => {
  on();
  const out = await executeTool('get_crowd_prediction', { place_id: freshId('BIRDIE') }, 5501, { includeForecast: true });
  assert.strictEqual(out.crowd_source, 'category_pattern');
  assert.strictEqual(out.crowd_method, 'category_typical');
  assert.match(out.crowd_label, HEDGED);
  assert.strictEqual(out.confidence_measurement.status, 'measured');
  assert.strictEqual(out.confidence_measurement.metric, 'within_15_rule_engine_category_table');
  assert.strictEqual(out.hourly_forecast.length, 12);
  for (const h of out.hourly_forecast) {
    assert.strictEqual(h.predictionMethod, METHOD, h.hour);
    assert.match(h.label, HEDGED, h.hour);
    assert.strictEqual(h.live_readings, false, h.hour);
  }
  // Every hour names its source, the first included: it is the headline's
  // number, and it takes the headline's crowd_method while any switch is on.
  // Here the only switch on is this fallback.
  for (const h of out.hourly_forecast) assert.strictEqual(h.crowd_method, 'category_typical', h.hour);
});

test('Birdie\'s rules name the method and its source only while the switch can serve them', () => {
  const rule = /- When get_crowd_prediction returns `crowd_method` = "category_typical"[^\n]*/;
  const off = buildSystemPrompt('Ava', {}, { ageBracket: 'adult' });
  assert.doesNotMatch(off, /category_typical|rule_engine_category_table/, 'off, the prompt is what it was');
  on();
  const prompt = buildSystemPrompt('Ava', {}, { ageBracket: 'adult' });
  const line = rule.exec(prompt);
  assert.ok(line, 'the rule is in the prompt');
  assert.match(line[0], /or an hour in `hourly_forecast` has `predictionMethod` = "rule_engine_category_table"/);
  assert.match(line[0], /the number is what is typical for this kind of place at that hour of the week/);
  assert.match(line[0], /It is not a reading of this venue, not this venue's own usual pattern, not the crowd model's number and not live/);
  assert.match(line[0], /"category_typical_adjusted" is that typical level, adjusted by verified visitor reports/);
  assert.doesNotMatch(line[0], /—/, 'no em dash');
  // Added, never edited: everything else in the prompt is the switched-off text.
  assert.strictEqual(prompt.replace(`\n${line[0]}`, ''), off);
});

// ===========================================================================
// The badge.
// ===========================================================================

test('the venue\'s badge hedges the table\'s number and does not call it live', async () => {
  on();
  const res = await realFetch(`${base}/api/badge/${freshId('BADGE')}.svg`);
  assert.strictEqual(res.status, 200);
  const svg = await res.text();
  const text = />([^<]+)<\/text>\s*<text[^>]*>Flock<\/text>/.exec(svg);
  assert.ok(text, svg);
  assert.match(text[1], /^Usually (quiet|not busy|steady|busy|packed) at this hour$/);
  assert.doesNotMatch(svg, /right now|for this spot/);
  assert.match(svg, /aria-label="Usually [a-z ]+ at this hour - from Flock"/);
  assert.doesNotMatch(svg, /live from Flock/);
  // Off, the same venue's pill reads as it always has.
  delete process.env[SWITCH];
  const off = await (await realFetch(`${base}/api/badge/${freshId('BADGEOFF')}.svg`)).text();
  assert.match(off, /live from Flock/);
  assert.doesNotMatch(off, /at this hour/);
});

// ===========================================================================
// The venue dashboard's strip.
// ===========================================================================

test('the venue dashboard\'s strip names a peak the table made, with the serving switches off too', async () => {
  // No serving switch is on in this file. The strip forwards a row's peak
  // attribution only when the peak hour says yes or no to live readings,
  // and the hours say that while any switch is on, this fallback included:
  // without it the owner's own category peak was captioned as the crowd
  // model's (frontend lib/crowd peersSourcePhrase reads these fields).
  on();
  CURRENT_USER = { id: ++nextUser, name: 'Owner', role: 'venue_owner' };
  venueCtx = { id: 71, google_place_id: freshId('STRIP'), verified: true };
  const res = await call('GET', '/api/venue-dashboard/strip');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.available, true, res.text);
  const you = res.body.you;
  assert.strictEqual(you.method, METHOD);
  assert.strictEqual(you.peakMethod, METHOD);
  assert.strictEqual(you.peakNumberSource, 'category_typical');
  assert.strictEqual(you.peakLiveReadings, false);
  // Off, the same row keeps exactly the keys it had, and the rule engine's tag.
  delete process.env[SWITCH];
  CURRENT_USER = { id: ++nextUser, name: 'Owner', role: 'venue_owner' };
  venueCtx = { id: 72, google_place_id: freshId('STRIPOFF'), verified: true };
  const off = await call('GET', '/api/venue-dashboard/strip');
  assert.strictEqual(off.status, 200, off.text);
  assert.strictEqual(off.body.available, true, off.text);
  assert.deepStrictEqual(Object.keys(off.body.you).sort(), ['label', 'method', 'name', 'peakHour', 'peakScore', 'score']);
  assert.strictEqual(off.body.you.method, 'rule_engine_no_baseline');
});

// ===========================================================================
// The block, read the way every surface reads it.
// ===========================================================================

test('the measurement block forwards the figure as measured, and the label never says more than typical', async () => {
  on();
  const v = {
    place_id: freshId('BLOCK'), types: ['bar'], user_ratings_total: 300, rating: 4.4, price_level: 2,
    location: { latitude: 39.95, longitude: -75.16 },
  };
  const r = await mlPredictor.predictBusyness(v, null, new Date(Date.UTC(2026, 8, 4, 21)));
  assert.strictEqual(r.predictionMethod, METHOD);
  const block = confidenceMeasurementFor(r, r.confidence, 0);
  assert.strictEqual(block.status, 'measured');
  assert.strictEqual(block.measuredPercent, 41.3);
  assert.strictEqual(block.populationRows, 4248);
  assert.strictEqual(block.publishedPercent, 41);
  const support = crowdEngine.describePredictionSupport(r.predictionMethod, 0);
  assert.doesNotMatch(crowdEngine.publishedLabel(r.score, support), NOT_THIS);
  assert.match(crowdEngine.publishedLabel(r.score, support), HEDGED);
});
