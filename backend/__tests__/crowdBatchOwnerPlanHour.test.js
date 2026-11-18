// Run: node --test  (from backend/)
//
// POST /api/crowd/batch — the owner's "right now" reading lands only on a row
// scored for right now.
//
// The vote panel asks this route for a PLAN's hour (frontend App.js
// requestEventCrowdScores): the plan's localHour/localDay on top and no zone or
// offset on any venue, so every row falls back to the body's clock. The owner
// override used to run on every row anyway, so a Saturday 9 PM plan printed the
// owner's Tuesday-evening 12% over the model's answer for Saturday 9 PM, and the
// strike test judged that reading against reports filed for the plan's hour.
//
// The server knows a row was scored for the venue's current moment only when
// the venue's own zone or offset set its clock (venueClock.local): that clock
// is crowdEngine.venueLocalNow at the server's now. A row on the body's clock
// may be the device's now or a plan's hour, and nothing in the request says
// which, so the reading is not applied there and nothing is judged.
//
// pg fake modelled on crowdBatchClock.test.js; the owner row is the shape
// LIVE_OWNER_REPORTS_SQL returns, as in abuseOwnerSliderStrikes.test.js.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'crowd-batch-owner-plan-hour-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
delete process.env.PAYWALL_ENABLED;

const MIN = 60e3;
const pool = require('../config/database');

let FEEDBACK_ROWS = [];
let OWNER_ROWS = [];
let stamps = [];

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (/^UPDATE venue_owner_reports SET diverged = true/.test(flat)) {
    stamps.push(Number(params[0]));
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/DISTINCT ON \(r\.google_place_id\)/.test(flat)) {
    const ids = new Set(params[0]);
    return Promise.resolve({ rows: OWNER_ROWS.filter((r) => ids.has(r.google_place_id)) });
  }
  if (/FROM venue_feedback/.test(flat)) {
    const [ids, days, hours] = params;
    const asked = new Set(ids.map((id, i) => `${id}|${days[i]}|${hours[i]}`));
    return Promise.resolve({
      rows: FEEDBACK_ROWS.filter((r) => asked.has(`${r.venue_place_id}|${r.day_of_week}|${r.hour}`)),
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 3, name: 'Ava', role: 'user' }; next(); };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
weatherService.getForecast = async () => [];

const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (!String(url).startsWith('http://127.0.0.1:')) throw new Error(`outbound call from a test: ${url}`);
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');

// The model says 82 for whatever hour it is asked about.
mlPredictor.predictBusyness = async () => ({
  score: 82,
  label: crowdEngine.getLabel(82),
  confidence: 60,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: 'test',
});

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

test.beforeEach(() => { FEEDBACK_ROWS = []; OWNER_ROWS = []; stamps = []; });
const settle = () => new Promise((r) => setImmediate(r));

function ownerRow(placeId, percent, id = 9) {
  const at = new Date(Date.now() - 4 * MIN);
  return {
    id,
    google_place_id: placeId,
    busy_percent: percent,
    created_at: at,
    diverged: false,
    profile_category: 'bar',
    assertion_since: at,
  };
}

// Three verified reporters saying "quiet" (20), filed a minute ago, in the
// weekly bucket the route will look up for this row.
function quietRoom(placeId, day, hour) {
  return [401, 402, 403].map((u) => ({
    venue_place_id: placeId,
    day_of_week: day,
    hour,
    crowd_level: 1,
    predicted_score: 50,
    user_id: u,
    created_at: new Date(Date.now() - MIN),
  }));
}

function venue(place_id, extra = {}) {
  return {
    place_id,
    name: place_id,
    rating: 4.4,
    user_ratings_total: 900,
    types: ['bar'],
    price_level: 2,
    location: { latitude: 40.72, longitude: -74.0 },
    ...extra,
  };
}

async function batch(venues, clock = {}) {
  const res = await fetch(`${base}/api/crowd/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ venues, ...clock }),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

test('a plan-hour row keeps the model\'s answer for that hour, not the owner\'s reading for now', async () => {
  OWNER_ROWS = [ownerRow('PLAN_BAR_01', 12)];
  // Exactly the body requestEventCrowdScores sends for a Saturday 9 PM plan.
  const res = await batch([venue('PLAN_BAR_01')], { localHour: 21, localDay: 6 });
  assert.strictEqual(res.status, 200, res.text);
  const row = res.body.predictions[0];
  assert.strictEqual(row.venueClock.local, false);
  assert.strictEqual(row.score, 82, 'the owner\'s 12 right now was printed over the plan hour\'s 82');
  assert.notStrictEqual(row.confidenceBasis, 'owner_report');
  assert.strictEqual(row.ownerReport, undefined);
});

test('a plan-hour row does not judge the owner\'s reading', async () => {
  // Reports in the plan's bucket that happen to fall inside the reading's live
  // window. They describe the plan's hour, so they are no evidence about the
  // reading on screen now.
  OWNER_ROWS = [ownerRow('PLAN_BAR_02', 95, 21)];
  FEEDBACK_ROWS = quietRoom('PLAN_BAR_02', 6, 21);
  const res = await batch([venue('PLAN_BAR_02')], { localHour: 21, localDay: 6 });
  assert.strictEqual(res.status, 200, res.text);
  await settle();
  assert.deepStrictEqual(stamps, [], 'a strike was stamped from a row scored for another hour');
});

test('a row on the venue\'s own clock is "now", so the reading still applies', async () => {
  OWNER_ROWS = [ownerRow('NOW_BAR_01', 95)];
  const res = await batch([venue('NOW_BAR_01', { utcOffsetMinutes: 0 })], { localHour: 21, localDay: 6 });
  assert.strictEqual(res.status, 200, res.text);
  const row = res.body.predictions[0];
  assert.strictEqual(row.venueClock.local, true);
  assert.strictEqual(row.score, 95);
  assert.strictEqual(row.ownerReport.applied, true);
});

test('and a row on the venue\'s own clock is still judged', async () => {
  OWNER_ROWS = [ownerRow('NOW_BAR_02', 95, 31)];
  const clock = crowdEngine.venueLocalNow(0, new Date());
  FEEDBACK_ROWS = quietRoom('NOW_BAR_02', clock.day, clock.hour);
  const res = await batch([venue('NOW_BAR_02', { utcOffsetMinutes: 0 })], { localHour: 21, localDay: 6 });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.predictions[0].ownerReport, 'the reading still rides along beside the reporters\' number');
  await settle();
  assert.deepStrictEqual(stamps, [31]);
});
