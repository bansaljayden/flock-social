// Run: node --test  (from backend/)
//
// THE EVENING, FOR SOMEONE UNDER 18 (routes/ai.js; crowdEngine
// recommendBestTime's `latestHour`). The crowd engine's best time can be
// midnight or 1 AM, and on the Birdie eval a 16-year-old asking about bowling
// was told "midnight is your best shot". For an account whose stored date of
// birth makes it under 18, and only that one (an account with no date of birth
// is not: the iPhone app asks none and many of those accounts are adults):
//   1. the best time is chosen from the same forecast among the hours from
//      6 AM to 10 PM, and "now" is not offered once it is past 10 PM;
//   2. a caller that sets no latest hour gets exactly the old answer;
//   3. the crowd tool says so when that moved the answer, and its hour-by-hour
//      list stops before the first hour after 10 PM;
//   4. the route asks for it for a known minor and for nobody else;
//   5. the minor's prompt says it, and no other prompt does.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-minor-best-time-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;
delete process.env.CROWD_NO_CURVE_FALLBACK;
delete process.env.CROWD_SERVE_MODE;
delete process.env.CROWD_NOWCAST_ENABLED;

const crowdEngine = require('../services/crowdEngine');
const { recommendBestTime, findPeakTime, venueHoursForDay, NO_WINDOW_LEFT } = crowdEngine;

const label = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? 'AM' : 'PM'}`;
// A venue open noon to 1 AM every day, the way Google sends its periods.
const PERIODS = Array.from({ length: 7 }, (_, d) => ({ open: { day: d, hour: 12, minute: 0 }, close: { day: (d + 1) % 7, hour: 1, minute: 0 } }));
const hoursEveryDay = (open, close) => Array.from({ length: 7 }, (_, d) => ({ open: { day: d, hour: open, minute: 0 }, close: { day: close >= 24 ? (d + 1) % 7 : d, hour: close % 24, minute: 0 } }));
const venueOn = (day, periods = PERIODS) => ({ types: ['bowling_alley'], ...venueHoursForDay(periods, day) });
// A day's strip from `start`, 24 hours, each hour's level from `levels` (a
// closed hour reads 2), ranked on the baseline the way the model's hours are.
function strip(start, levels) {
  return Array.from({ length: 24 }, (_, i) => {
    const h = (start + i) % 24;
    const score = levels[h] ?? 2;
    return { hour: label(h), score, baselineScore: score, predictionMethod: 'ml' };
  });
}
function best(start, day, levels, { latestHour, currentScore, periods } = {}) {
  const fullDay = strip(start, levels);
  const venue = venueOn(day, periods);
  const peak = findPeakTime(fullDay.slice(0, 12), venue, { startDay: day });
  return recommendBestTime(fullDay, venue, peak.startIdx, peak.endIdx, true, {
    currentHour: start, currentDay: day, currentScore: currentScore ?? levels[start], ...(latestHour != null ? { latestHour } : {}),
  });
}
const lateHour = (text) => /\b(11 PM|12 AM|[1-5] AM)\b/.test(String(text));

// Lehigh Lanes on the eval, Friday night: busiest at 9, quietest at midnight.
const LEHIGH = { 12: 20, 15: 32, 17: 50, 18: 61, 19: 69, 20: 84, 21: 87, 22: 80, 23: 59, 0: 35 };

test('a bowling night that is quietest at midnight: midnight for an adult, the evening for a minor', () => {
  assert.strictEqual(best(19, 5, LEHIGH).text, '12 AM', 'the default answer moved');
  const minor = best(19, 5, LEHIGH, { latestHour: 22 });
  assert.ok(!lateHour(minor.text), minor.text);
  // 8, 9 and 10 PM are all busier than now, so now is the time that works.
  assert.strictEqual(minor.text, 'Now is good');
});

test('a quieter hour by 10 PM is named for the minor, and 10 PM itself may be', () => {
  const night = { 19: 80, 20: 70, 21: 40, 22: 45, 23: 20, 0: 18 };
  assert.strictEqual(best(19, 5, night).text, '12 AM');
  assert.strictEqual(best(19, 5, night, { latestHour: 22 }).text, '9 PM');
  // The arcade on the eval: quietest at 10 PM, which works for both.
  const galaxy = { 11: 15, 13: 32, 15: 45, 17: 60, 18: 68, 19: 74, 20: 81, 21: 72, 22: 46 };
  const periods = hoursEveryDay(11, 23);
  assert.strictEqual(best(19, 5, galaxy, { periods }).text, '10 PM');
  assert.strictEqual(best(19, 5, galaxy, { latestHour: 22, periods }).text, '10 PM');
});

test('past 10 PM "now" is never the answer for the minor: a time tomorrow, never the small hours', () => {
  const late = { ...LEHIGH, 23: 30 };
  assert.match(best(23, 5, late).text, /^Now/, 'an adult may still be told now');
  for (const start of [22, 23]) {
    const minor = best(start, 5, late, { latestHour: 22 });
    assert.ok(!/^Now/.test(minor.text), `${start}: ${minor.text}`);
    assert.ok(!lateHour(minor.text), `${start}: ${minor.text}`);
    assert.ok(minor.text === NO_WINDOW_LEFT || /^Tomorrow /.test(minor.text), `${start}: ${minor.text}`);
  }
});

test('after midnight the minor is pointed at a daytime hour, never 1 AM', () => {
  // 12:35 AM Saturday: open till 1, and noon to 10 PM later that day.
  const sat = { 0: 35, 12: 20, 13: 28, 14: 30, 15: 32, 16: 41, 17: 50, 18: 61, 19: 69, 20: 84, 21: 87, 22: 80 };
  const minor = best(0, 6, sat, { latestHour: 22 });
  assert.ok(!/^Now/.test(minor.text) && !lateHour(minor.text), minor.text);
  assert.strictEqual(minor.text, '12 PM');
});

test('the hours a time may be named at', () => {
  const { suggestableHour, EARLIEST_SUGGESTED_HOUR } = crowdEngine;
  assert.strictEqual(EARLIEST_SUGGESTED_HOUR, 6);
  for (const h of [6, 12, 19, 22]) assert.strictEqual(suggestableHour(h, 22), true, String(h));
  for (const h of [23, 0, 1, 5]) assert.strictEqual(suggestableHour(h, 22), false, String(h));
  for (const h of [0, 1, 23]) assert.strictEqual(suggestableHour(h, null), true, 'no latest hour, every hour');
});

// ── The crowd tool, with the Places details and the predictor faked ─────────

const pool = require('../config/database');
let dob = null;
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) return Promise.resolve({ rows: [{ name: 'Leo Brennan', date_of_birth: dob }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 21, name: 'Leo' }; next(); };
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;
const mlPredictor = require('../services/mlPredictor');
let LEVELS = LEHIGH;
const levelAt = (h) => LEVELS[h] ?? 2;
mlPredictor.predictBusyness = async (_venue, _weather, ts) => {
  const score = levelAt(new Date(ts).getHours());
  return { score, label: crowdEngine.getLabel(score), confidence: 40, factors: {}, dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test', baselineScore: score };
};
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count) => Array.from({ length: count || 12 }, (_, i) => {
  const h = (startHour + i) % 24;
  const score = levelAt(h);
  return { hour: label(h), score, baselineScore: score, label: crowdEngine.getLabel(score), predictionMethod: 'ml' };
});
mlPredictor.agreeWithStrip = async (headline) => headline;

const PLACE = {
  id: 'PLACE_LEHIGH_LANES', displayName: { text: 'Lehigh Lanes' }, formattedAddress: '1800 Union Blvd, Allentown, PA', rating: 4.2, userRatingCount: 546,
  priceLevel: 'PRICE_LEVEL_MODERATE', types: ['bowling_alley', 'point_of_interest'], location: { latitude: 40.61, longitude: -75.46 },
  currentOpeningHours: { openNow: true, periods: PERIODS }, utcOffsetMinutes: -300, timeZone: { id: 'America/New_York' },
};
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) return Promise.resolve({ ok: true, status: 200, json: async () => PLACE });
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

const genaiMod = require('@google/genai');
let sends = [];
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: () => ({
        sendMessage: async (p) => {
          sends.push(p);
          if (sends.length === 1) return { candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'get_crowd_prediction', args: { place_id: PLACE.id } } }] } }] };
          return { candidates: [{ content: { parts: [{ text: 'Lehigh Lanes, now is good.' }] } }] };
        },
      }),
    },
  };
};

const placeDetailsCache = require('../services/placeDetailsCache');
const aiRouter = require('../routes/ai');
const { executeTool, buildSystemPrompt } = aiRouter.__testables;
// Friday, November 6, 2026, 7:40 PM in Allentown.
const FRIDAY_EVENING = Date.parse('2026-11-07T00:40:00Z');

const lookup = (eveningOnly) => executeTool('get_crowd_prediction', { place_id: PLACE.id }, 31, {
  includeForecast: true, salesOff: false, searchedPlaces: new Map(), timeZone: null, eveningOnly,
});

test('the crowd tool for a minor: the evening best time, a note that it moved, and no hour after 10 PM', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FRIDAY_EVENING });
  try {
    placeDetailsCache.__test.reset();
    const adult = await lookup(false);
    assert.strictEqual(adult.best_time, '12 AM');
    assert.ok(!('best_time_note' in adult));
    assert.strictEqual(adult.hourly_forecast.length, 12);
    placeDetailsCache.__test.reset();
    const minor = await lookup(true);
    assert.strictEqual(minor.best_time, 'Now is good');
    assert.match(minor.best_time_note, /best time to go is later than 10 PM, so best_time is the best time at or before 10 PM/);
    assert.match(minor.best_time_note, /do not name a later hour or say why/);
    assert.deepStrictEqual(minor.hourly_forecast.map((h) => h.hour), ['7 PM', '8 PM', '9 PM', '10 PM']);
    // The headline and the peak are facts, and stay.
    assert.strictEqual(minor.crowd_score, 69);
    assert.strictEqual(minor.peak_hours, adult.peak_hours);
  } finally {
    t.mock.timers.reset();
  }
});

test('when the evening answer is the same answer, there is no note', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T22:40:00Z') }); // 5:40 PM
  try {
    placeDetailsCache.__test.reset();
    const minor = await lookup(true);
    const adultAnswer = (placeDetailsCache.__test.reset(), await lookup(false)).best_time;
    assert.strictEqual(minor.best_time, adultAnswer);
    assert.ok(!('best_time_note' in minor), JSON.stringify(minor));
  } finally {
    t.mock.timers.reset();
  }
});

test('a different evening answer gets no note when the answer anyone gets is not a late one', async (t) => {
  // 9:40 PM: the peak is 10 PM, and only 11 PM and midnight come after it.
  // Anyone else is told now is good; the minor is told now, before the rush.
  LEVELS = { 21: 60, 22: 90, 23: 75, 0: 70 };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T02:40:00Z') });
  try {
    placeDetailsCache.__test.reset();
    const adult = await lookup(false);
    placeDetailsCache.__test.reset();
    const minor = await lookup(true);
    assert.strictEqual(adult.best_time, 'Now is good');
    assert.strictEqual(minor.best_time, 'Now, before the rush');
    assert.ok(!('best_time_note' in minor), JSON.stringify(minor));
  } finally {
    t.mock.timers.reset();
    LEVELS = LEHIGH;
  }
});

// ── The route asks for it for a known minor and nobody else ────────────────

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
test.after(() => new Promise((resolve) => server.close(resolve)));

const years = (n) => new Date(Date.parse('2026-11-07T00:40:00Z') - n * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);

async function crowdFor(birthday) {
  dob = birthday;
  sends = [];
  placeDetailsCache.__test.reset();
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text: 'best time to go bowling tonight' }] }),
  });
  assert.strictEqual(res.status, 200, await res.clone().text());
  const fr = sends.flatMap((s) => (Array.isArray(s.message) ? s.message : [])).map((p) => p.functionResponse).find(Boolean);
  return fr.response;
}

test('a known minor gets the evening; an account with no date of birth, and anyone 18 or over, do not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FRIDAY_EVENING });
  try {
    const minor = await crowdFor(years(16));
    assert.strictEqual(minor.best_time, 'Now is good');
    assert.ok(minor.best_time_note);
    for (const birthday of [null, years(19), years(23)]) {
      const out = await crowdFor(birthday);
      assert.strictEqual(out.best_time, '12 AM', `dob ${birthday}`);
      assert.ok(!('best_time_note' in out), `dob ${birthday}`);
    }
  } finally {
    t.mock.timers.reset();
  }
});

test('only the minor prompt carries the 10 PM line', () => {
  const minor = buildSystemPrompt('Leo', {}, { ageBracket: 'minor' });
  assert.match(minor, /Suggest times to go only up to 10 PM: never tell them to go after 10 PM, or that it gets quieter after 10 PM\./);
  assert.match(minor, /when `best_time_note` says a venue's best time is later, give `best_time` plainly and leave the later hours and the reason out\./);
  for (const ageBracket of [null, 'under21', 'adult']) {
    assert.ok(!/only up to 10 PM/.test(buildSystemPrompt('Leo', {}, { ageBracket })), String(ageBracket));
  }
});
