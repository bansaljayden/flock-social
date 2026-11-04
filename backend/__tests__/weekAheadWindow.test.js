// Run: node --test __tests__/weekAheadWindow.test.js  (from backend/)
//
// THE WEEK AHEAD READS EACH DAY ON HOURS THE VENUE KEEPS (2026-11-04).
//
// GET /api/venue-dashboard/intelligence scanned 5 PM to midnight for every
// venue, so a cafe that opens 7 to 3 was given a 6 PM peak on every day of its
// week and on "Tonight's Peak". Pinned here:
//   1. a venue whose Google listing has hours is read on them: a cafe on its
//      mornings, a closed day not at all, a split day without its gap;
//   2. with no hours listed, the window for its kind: the day (6 AM to 5 PM)
//      for a cafe or a bakery, the evening, as before, for a bar, a club or a
//      restaurant, and the evening for a kind with no window of its own;
//   3. a bar, a club or a restaurant keeps the evening part of its hours, is
//      read past midnight when its hours run there, and is read on its own
//      hours only on a day it does not open in the evening;
//   4. today's peak is read on today's hours, from the bars the dashboard
//      draws, and the response says which words fit (peakWindow, today.window)
//      and where the hours came from (scanFrom);
//   5. on the night the clocks spring forward, the hour the strip walks on into
//      is the next morning's, never this day's.

process.env.TZ = 'UTC'; // Railway's clock, as server.js sets it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// Wednesday 4 November 2026, 10 AM: the week ahead runs Thursday to Tuesday.
const { pinClock } = require('./helpers/pinnedClock');

pinClock(Date.parse('2026-11-04T10:00:00Z'));

process.env.JWT_SECRET = 'week-ahead-window-test-secret';
// Set BEFORE requiring the router: venueDashboard captures the key at load.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

// Each test names its own place, so the hour-keyed cache never hands one test
// another's week.
let placeId = null;
pool.query = async (sql) => {
  const q = String(sql).replace(/\s+/g, ' ');
  if (/FROM venue_profiles WHERE user_id/.test(q)) {
    return { rows: [{ id: 1, google_place_id: placeId, verified: true, category: null }], rowCount: 1 };
  }
  // No curve and no corpus: a venue Flock has never collected.
  return { rows: [], rowCount: 0 };
};

const placesBudget = require('../utils/placesBudget');

placesBudget.allowPlacesSearch = () => true;
const weatherService = require('../services/weatherService');

weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });
const authMod = require('../middleware/auth');

authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Owner', role: 'venue_owner' }; next(); };

// ── The forecast, scripted ──────────────────────────────────────────────────
// A morning rush at 8, a lunch at noon, a 3 PM that is the day's strongest,
// an evening stronger still at 6 PM and a 1 AM above everything. Any hour a
// venue is shut that the scan wrongly reads wins outright.
const LEVEL = {
  0: 40, 1: 95, 2: 35, 3: 30, 4: 20, 5: 10, 6: 20, 7: 55, 8: 60, 9: 50, 10: 40, 11: 45,
  12: 58, 13: 50, 14: 35, 15: 70, 16: 30, 17: 75, 18: 90, 19: 80, 20: 70, 21: 65, 22: 60, 23: 50,
};
const label = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);
const TODAY = '2026-11-04';

const mlPredictor = require('../services/mlPredictor');

mlPredictor.predictBusyness = async () => ({ score: 40, label: 'Moderate', predictionMethod: 'rule_engine_no_baseline', modelVersion: null });
mlPredictor.agreeWithStrip = async (scored) => scored;
let runs = [];
// The night the clocks spring forward: a strip that would reach 2 AM skips it
// and walks one hour further, and that extra morning hour is the loudest.
let springForward = false;
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count, day) => {
  const date = new Date(day).toISOString().slice(0, 10);
  runs.push({ date, weekday: new Date(day).getDay(), startHour, count });
  const hours = [];
  for (let i = 0; i < count; i += 1) hours.push((startHour + i) % 24);
  const bars = hours.map((h) => ({ hour: label(h), score: LEVEL[h], baselineScore: null, predictionMethod: 'rule_engine_no_baseline' }));
  const skip = hours.indexOf(2);
  if (springForward && skip > 0) {
    bars.splice(skip, 1);
    bars.push({ hour: label((hours[hours.length - 1] + 1) % 24), score: 99, baselineScore: null, predictionMethod: 'rule_engine_no_baseline' });
  }
  return bars;
};

// ── Google Places, one listing per test ─────────────────────────────────────
let listing = null;
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
        userRatingCount: 200,
        types: listing.types,
        ...(listing.primaryType ? { primaryType: listing.primaryType } : {}),
        location: { latitude: 39.95, longitude: -75.16 },
        currentOpeningHours: listing.periods ? { openNow: true, periods: listing.periods } : { openNow: true },
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

async function intel(id, l) {
  placeId = id;
  listing = l;
  runs = [];
  const res = await fetch(`${base}/api/venue-dashboard/intelligence`);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(body.available, true, JSON.stringify(body));
  // The six days ahead, and today's strip of bars (6 AM, 18 hours).
  return { body, weekRuns: runs.filter((r) => r.date !== TODAY), todayRuns: runs.filter((r) => r.date === TODAY) };
}

// Google's periods: one window per listed weekday, close on the next day when
// the window runs past midnight.
function periods(byDay) {
  const out = [];
  for (const [day, windows] of Object.entries(byDay)) {
    for (const [open, close] of windows) {
      const d = Number(day);
      out.push({ open: { day: d, hour: open, minute: 0 }, close: { day: close <= open ? (d + 1) % 7 : d, hour: close % 24, minute: 0 } });
    }
  }
  return out;
}
const everyDay = (windows) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, windows]));
const byWeekday = (body) => Object.fromEntries(body.week.map((d) => [d.weekday, d]));

// ── 1. The venue's own hours ────────────────────────────────────────────────

test('a cafe with hours on its listing is read on them: its mornings, never the 6 PM it is shut for', async () => {
  // 7 AM to 3 PM on weekdays, 8 AM to 2 PM at the weekend.
  const { body, weekRuns } = await intel('PLACE_CAFE_HOURS', {
    types: ['coffee_shop', 'cafe', 'food', 'store'],
    primaryType: 'coffee_shop',
    periods: periods({ 0: [[8, 14]], 1: [[7, 15]], 2: [[7, 15]], 3: [[7, 15]], 4: [[7, 15]], 5: [[7, 15]], 6: [[8, 14]] }),
  });
  assert.strictEqual(body.scanFrom, 'hours');
  assert.strictEqual(body.peakWindow, 'day');
  // Each day's one forecast run covers its open hours and no more: from the
  // opening hour to the last hour before the close.
  assert.strictEqual(weekRuns.length, 6);
  for (const r of weekRuns) {
    const weekend = r.weekday === 0 || r.weekday === 6;
    assert.deepStrictEqual({ start: r.startHour, count: r.count }, weekend ? { start: 8, count: 6 } : { start: 7, count: 8 }, `weekday ${r.weekday}`);
  }
  for (const d of body.week) {
    assert.strictEqual(d.peakHour, '8 AM', `${d.weekday}: ${JSON.stringify(d)}`);
    assert.strictEqual(d.peakScore, 60);
    assert.ok(!d.afterMidnight && !d.closed);
  }
  // Today is a Wednesday, 7 to 3: its peak is 8 AM, from the bars drawn,
  // never the 6 PM the old last-eight-bars reading picked.
  assert.deepStrictEqual(body.today, { date: TODAY, weekday: 'Wed', peakScore: 60, peakHour: '8 AM', method: 'rule_engine_no_baseline', window: 'day' });
  // The bars themselves are unchanged: today, 6 AM to 11 PM.
  assert.strictEqual(body.todayHourly.length, 18);
});

test('a day the listing has the venue closed gets no peak and no forecast run', async () => {
  // A bakery closed on Mondays and Tuesdays.
  const { body, weekRuns } = await intel('PLACE_BAKERY_CLOSED', {
    types: ['bakery', 'food', 'store'],
    primaryType: 'bakery',
    periods: periods({ 0: [[7, 13]], 3: [[6, 14]], 4: [[6, 14]], 5: [[6, 14]], 6: [[7, 13]] }),
  });
  const days = byWeekday(body);
  for (const shut of ['Mon', 'Tue']) {
    assert.deepStrictEqual(days[shut], { date: days[shut].date, weekday: shut, peakScore: null, peakHour: null, method: null, closed: true });
  }
  assert.deepStrictEqual(weekRuns.map((r) => r.weekday).sort(), [0, 4, 5, 6], 'a closed day was forecast');
  assert.strictEqual(days.Thu.peakHour, '8 AM');
  // Today, Wednesday, opens at 6: its bars start at 6 too.
  assert.strictEqual(body.today.peakHour, '8 AM');
  assert.strictEqual(body.peakWindow, 'day');
});

test('a split day is read on its two windows and not on the gap between them', async () => {
  // 7 AM to noon, then 4 to 5 PM: the 3 PM in the gap is the loudest hour of
  // the run that covers both, and it is shut.
  const { body } = await intel('PLACE_DELI_SPLIT', {
    types: ['deli', 'sandwich_shop', 'food'],
    primaryType: 'deli',
    periods: periods(everyDay([[7, 12], [16, 17]])),
  });
  for (const d of body.week) assert.strictEqual(d.peakHour, '8 AM', `${d.weekday}: ${JSON.stringify(d)}`);
  assert.strictEqual(body.today.peakHour, '8 AM');
});

// ── 2. No hours on the listing: the window for its kind ─────────────────────

test('with no hours listed, a cafe or a bakery is read by day, 6 AM to 5 PM', async () => {
  const kinds = [
    ['PLACE_CAFE_NOHOURS', { types: ['cafe', 'food', 'store'], primaryType: 'cafe' }],
    ['PLACE_BAKERY_NOHOURS', { types: ['bakery', 'food', 'store'] }],
    // A coffee shop that also lists 'restaurant' is a coffee shop.
    ['PLACE_COFFEE_RESTAURANT', { types: ['coffee_shop', 'restaurant', 'food'], primaryType: 'coffee_shop' }],
    // Periods none of which parse are no hours, not a week shut every day.
    ['PLACE_CAFE_BAD_PERIODS', { types: ['cafe', 'food'], primaryType: 'cafe', periods: [{ open: { day: 1 } }, { open: { hour: 7 }, close: { hour: 15 } }] }],
  ];
  for (const [id, l] of kinds) {
    const { body, weekRuns } = await intel(id, { periods: null, ...l });
    assert.strictEqual(body.scanFrom, 'kind', id);
    assert.strictEqual(body.peakWindow, 'day', id);
    assert.ok(weekRuns.every((r) => r.startHour === 6 && r.count === 11), `${id}: ${JSON.stringify(weekRuns)}`);
    // The strongest hour from 6 AM to 4 PM is 3 PM; the 6 PM is never read.
    for (const d of body.week) assert.strictEqual(d.peakHour, '3 PM', `${id} ${d.weekday}`);
    assert.strictEqual(body.today.peakHour, '3 PM', id);
    assert.strictEqual(body.today.window, 'day', id);
  }
});

test('with no hours listed, a bar, a club or a restaurant is read on the evening, as before', async () => {
  const kinds = [
    ['PLACE_BAR_NOHOURS', { types: ['bar'] }],
    ['PLACE_CLUB_NOHOURS', { types: ['night_club'] }],
    ['PLACE_RESTAURANT_NOHOURS', { types: ['italian_restaurant', 'restaurant'], primaryType: 'italian_restaurant' }],
  ];
  for (const [id, l] of kinds) {
    const { body, weekRuns } = await intel(id, { ...l, periods: null });
    assert.strictEqual(body.scanFrom, 'kind', id);
    assert.strictEqual(body.peakWindow, 'evening', id);
    assert.ok(weekRuns.every((r) => r.startHour === 17 && r.count === 7), `${id}: ${JSON.stringify(weekRuns)}`);
    for (const d of body.week) assert.strictEqual(d.peakHour, '6 PM', `${id} ${d.weekday}`);
    assert.deepStrictEqual(body.today, { date: TODAY, weekday: 'Wed', peakScore: 90, peakHour: '6 PM', method: 'rule_engine_no_baseline', window: 'evening' }, id);
  }
});

test('a kind with no window of its own and no hours keeps the evening, and says so', async () => {
  const { body, weekRuns } = await intel('PLACE_GYM_NOHOURS', { types: ['gym', 'health'], primaryType: 'gym', periods: null });
  assert.strictEqual(body.scanFrom, 'default');
  assert.strictEqual(body.peakWindow, 'evening');
  assert.ok(weekRuns.every((r) => r.startHour === 17 && r.count === 7), JSON.stringify(weekRuns));
});

// ── 3. A bar, a club or a restaurant with hours ─────────────────────────────

test('a bar keeps the evening part of its hours and is read to its close past midnight', async () => {
  // 4 PM to 2 AM, closed on Mondays.
  const { body, weekRuns } = await intel('PLACE_BAR_HOURS', {
    types: ['bar'],
    periods: periods({ 0: [[16, 2]], 2: [[16, 2]], 3: [[16, 2]], 4: [[16, 2]], 5: [[16, 2]], 6: [[16, 2]] }),
  });
  assert.strictEqual(body.scanFrom, 'hours');
  assert.strictEqual(body.peakWindow, 'evening');
  const days = byWeekday(body);
  assert.strictEqual(days.Mon.closed, true);
  for (const r of weekRuns) {
    // 5 PM, not the 4 PM it opens at, and on to the last hour before 2 AM.
    assert.deepStrictEqual({ start: r.startHour, count: r.count }, { start: 17, count: 9 }, `weekday ${r.weekday}`);
  }
  // The night's 1 AM is its loudest hour, named for the evening it belongs to.
  for (const d of body.week.filter((x) => !x.closed)) {
    assert.strictEqual(d.peakHour, '1 AM', d.weekday);
    assert.strictEqual(d.afterMidnight, true, d.weekday);
  }
  // Today's bars stop at 11 PM, so today reads its evening.
  assert.strictEqual(body.today.peakHour, '6 PM');
  assert.strictEqual(body.today.window, 'evening');
});

test('a restaurant is read on its own hours only on a day it does not open in the evening', async () => {
  // Sunday lunch only; dinner from 5 to 10 every other day.
  const { body, weekRuns } = await intel('PLACE_RESTAURANT_HOURS', {
    types: ['restaurant', 'food'],
    primaryType: 'restaurant',
    periods: periods({ 0: [[11, 15]], 1: [[17, 22]], 2: [[17, 22]], 3: [[17, 22]], 4: [[17, 22]], 5: [[17, 22]], 6: [[17, 22]] }),
  });
  const days = byWeekday(body);
  assert.strictEqual(days.Sun.peakHour, '12 PM', 'Sunday is read on its lunch');
  for (const d of ['Mon', 'Tue', 'Thu', 'Fri', 'Sat']) assert.strictEqual(days[d].peakHour, '6 PM', d);
  const sunday = weekRuns.find((r) => r.weekday === 0);
  assert.deepStrictEqual({ start: sunday.startHour, count: sunday.count }, { start: 11, count: 4 });
  assert.ok(weekRuns.filter((r) => r.weekday !== 0).every((r) => r.startHour === 17 && r.count === 5), JSON.stringify(weekRuns));
  // One day of the week is not an evening, so the card does not say evening.
  assert.strictEqual(body.peakWindow, 'day');
  assert.strictEqual(body.today.window, 'evening');
});

// ── 5. The night the clocks spring forward ──────────────────────────────────

test('on a spring-forward night the hour the strip walks on into is the next morning\'s, never this day\'s', async () => {
  // Open round the clock: each day is read from 5 AM to 4 AM the next
  // morning, and the 5 AM the strip walks on into after skipping 2 AM is the
  // next day's 5 AM, however loud.
  springForward = true;
  try {
    const { body, weekRuns } = await intel('PLACE_CAFE_24H_DST', {
      types: ['cafe', 'food'],
      primaryType: 'cafe',
      periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
    });
    assert.ok(weekRuns.every((r) => r.startHour === 5 && r.count === 24), JSON.stringify(weekRuns));
    for (const d of body.week) {
      assert.notStrictEqual(d.peakScore, 99, `${d.weekday}: ${JSON.stringify(d)}`);
      assert.strictEqual(d.peakHour, '1 AM', d.weekday);
      assert.strictEqual(d.afterMidnight, true, d.weekday);
    }
  } finally {
    springForward = false;
  }
});
