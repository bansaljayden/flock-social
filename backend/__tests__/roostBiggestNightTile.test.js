// Run: node --test  (from backend/)
//
// "BIGGEST NIGHT AHEAD" READS THE WHOLE NIGHT (2026-11-03).
//
// The dashboard tile picks the strongest of the six evenings that
// GET /api/venue-dashboard/intelligence returns in `week`. Each evening was
// scanned from 5 PM to 11 PM, so a club that peaks at 1 AM showed its 11 PM
// hour on the tile while Roost, whose week reads the whole night
// (advisorFacts.nightTailHours), named 1 AM. Pinned here:
//   1. an evening whose room is still open at 11 PM is scanned on into the
//      small hours its curve keeps open, up to 4 AM, and keeps its own day's
//      name; a small-hours peak says so (`afterMidnight`);
//   2. a room that closes at midnight, a morning that only starts at 4 AM,
//      and a venue whose curve cannot be read keep the evening alone.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'roost-biggest-night-test-secret';
// Set BEFORE requiring the router: venueDashboard captures the key at load.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

// Each test names its own place, so the route's hour-keyed cache never hands
// one test another's week.
let placeId = null;
let curveRows = [];
let curveFails = false;
pool.query = async (sql) => {
  const q = String(sql).replace(/\s+/g, ' ');
  if (/FROM venue_profiles WHERE user_id/.test(q)) {
    return { rows: [{ id: 1, google_place_id: placeId, verified: true, category: null }], rowCount: 1 };
  }
  if (/FROM ml_venue_baselines/.test(q)) {
    if (curveFails) throw new Error('connection reset');
    return { rows: curveRows, rowCount: curveRows.length };
  }
  return { rows: [], rowCount: 0 };
};

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Owner', role: 'venue_owner' }; next(); };

const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({ score: 40, label: 'Moderate', predictionMethod: 'ml', modelVersion: 'test' });
mlPredictor.agreeWithStrip = async (scored) => scored;

const label = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
// A night that builds to 1 AM and empties by 4.
const LEVEL = { 17: 5, 18: 6, 19: 8, 20: 15, 21: 30, 22: 50, 23: 70, 0: 85, 1: 96, 2: 80, 3: 40, 4: 10 };
let forecastCalls = [];
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count, day) => {
  // Today's strip (6 AM, 18 hours) is not the week; the six evenings are.
  if (startHour === 17) forecastCalls.push({ startHour, count, weekday: new Date(day).getDay() });
  return Array.from({ length: count }, (_, i) => {
    const h = (startHour + i) % 24;
    return { hour: label(h), score: LEVEL[h], baselineScore: LEVEL[h], predictionMethod: 'ml' };
  });
};

const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length));
    return Promise.resolve({
      status: 200,
      json: async () => ({
        id,
        displayName: { text: 'Test Room' },
        rating: 4.4,
        userRatingCount: 120,
        types: ['night_club'],
        location: { latitude: 39.74, longitude: -104.98 },
        currentOpeningHours: { openNow: true },
        utcOffsetMinutes: 0,
      }),
    });
  }
  return realFetch(url, opts);
};

const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  global.fetch = realFetch;
  server.close(resolve);
}));

// A curve: the given hours open (baseline 50) on the given weekdays (0 is Sunday).
function curve(hoursByDay) {
  const rows = [];
  for (const [day, hours] of Object.entries(hoursByDay)) {
    for (const hour of hours) rows.push({ day_of_week: Number(day), hour, baseline: 50, source: 'google', updated_at: new Date() });
  }
  return rows;
}
const EVENING = [17, 18, 19, 20, 21, 22, 23];

async function weekFor(id, rows, { fail = false } = {}) {
  placeId = id;
  curveRows = rows;
  curveFails = fail;
  forecastCalls = [];
  const res = await fetch(`${base}/api/venue-dashboard/intelligence`);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.available, true, JSON.stringify(body));
  return body;
}

test('an evening the room keeps open past midnight is scanned to the end of its night, under its own day', async () => {
  // A club open every evening to 11 PM, and on into the small hours of
  // Saturday and Sunday: Friday and Saturday nights run to 2 AM.
  const body = await weekFor('PLACE_CLUB', curve({
    0: [0, 1, 2, ...EVENING], 1: EVENING, 2: EVENING, 3: EVENING, 4: EVENING, 5: EVENING, 6: [0, 1, 2, ...EVENING],
  }));
  assert.strictEqual(forecastCalls.length, 6);
  for (const call of forecastCalls) {
    assert.strictEqual(call.startHour, 17);
    // Friday (5) and Saturday (6) evenings carry on to 2 AM: 5 PM to 2 AM.
    assert.strictEqual(call.count, call.weekday === 5 || call.weekday === 6 ? 10 : 7, `weekday ${call.weekday}`);
  }
  const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const night of body.week) {
    const longNight = night.weekday === 'Fri' || night.weekday === 'Sat';
    assert.strictEqual(night.peakHour, longNight ? '1 AM' : '11 PM', `${night.weekday} ${night.date}`);
    assert.strictEqual(night.peakScore, longNight ? 96 : 70);
    assert.strictEqual(night.afterMidnight === true, longNight);
    // Named for its evening: the date and the weekday are the evening's.
    assert.strictEqual(SHORT[new Date(`${night.date}T12:00:00Z`).getUTCDay()], night.weekday);
  }
  // So the tile's biggest night is a 1 AM peak, the hour Roost names.
  const biggest = body.week.reduce((a, b) => (b.peakScore > a.peakScore ? b : a));
  assert.strictEqual(biggest.peakHour, '1 AM');
  assert.ok(['Fri', 'Sat'].includes(biggest.weekday));
});

test('a room that closes at midnight, a morning that starts at 4 AM, and an unread curve keep the evening alone', async () => {
  // Open to 11 PM, nothing after midnight.
  let body = await weekFor('PLACE_BAR', curve({ 0: EVENING, 1: EVENING, 2: EVENING, 3: EVENING, 4: EVENING, 5: EVENING, 6: EVENING }));
  assert.deepStrictEqual(forecastCalls.map((c) => c.count), [7, 7, 7, 7, 7, 7]);
  assert.ok(body.week.every((n) => n.peakHour === '11 PM' && !n.afterMidnight));
  // A bakery that opens at 4 AM and is shut by evening: its mornings are
  // mornings, never the end of the night before.
  body = await weekFor('PLACE_BAKERY', curve({ 0: [4, 5, 6, 7], 1: [4, 5, 6, 7], 2: [4, 5, 6, 7], 3: [4, 5, 6, 7], 4: [4, 5, 6, 7], 5: [4, 5, 6, 7], 6: [4, 5, 6, 7] }));
  assert.deepStrictEqual(forecastCalls.map((c) => c.count), [7, 7, 7, 7, 7, 7]);
  assert.ok(body.week.every((n) => !n.afterMidnight));
  // A curve that cannot be read is no reason to lose the week.
  body = await weekFor('PLACE_UNREAD', [], { fail: true });
  assert.deepStrictEqual(forecastCalls.map((c) => c.count), [7, 7, 7, 7, 7, 7]);
  assert.strictEqual(body.week.length, 6);
});
