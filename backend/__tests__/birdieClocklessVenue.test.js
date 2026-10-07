// Run: node --test  (from backend/)
//
// THE PHONE'S HOUR IS THE USER'S CLOCK (routes/ai.js).
//
// Every Birdie build sends the device's hour and weekday with each turn
// (localHour, localDay). The crowd tool fell back to them for a venue whose
// Places details carry no zone and no offset, so that venue's forecast hours,
// its best time and its peak were labelled on the phone's clock, and Gemini
// read them beside the UTC Now line. One hour beside UTC gives the user's
// offset away, on a turn whose consent never named the time zone.
//
// Pinned here through the real route, with Gemini, Places and the predictor
// faked:
//   1. a turn whose zone Birdie may not read (a yes to the earlier question,
//      an installed build that sends no zone, a turn with no zone at all)
//      never scores that venue on the phone's hour or day. It is scored on
//      UTC, and the result says its hours are UTC hours.
//   2. a yes to the question that names the zone, with the zone sent, still
//      scores it on the phone's clock.
//   3. a venue the crowd corpus holds a zone for is scored on that zone.
//   4. a number scored on UTC never goes on a venue card as the level now,
//      and a locked result carries no note about hours it does not have.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-clockless-venue-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
// posthog-node holds a connection open, and NODE_ENV is deleted above.
delete process.env.POSTHOG_API_KEY;
delete process.env.CROWD_NO_CURVE_FALLBACK;

// --- the database: the account's answer, its name, and the corpus zone ------
const pool = require('../config/database');
let consent = { at: null, copy: null };
let corpusZone = null; // ml_venues.timezone for the venue; null is no row
let corpusFails = false;
let sql = [];
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  sql.push(flat);
  if (/^SELECT birdie_ai_consent_at, birdie_ai_consent_copy FROM users WHERE id = \$1$/.test(flat)) {
    return Promise.resolve({ rows: [{ birdie_ai_consent_at: consent.at, birdie_ai_consent_copy: consent.copy }], rowCount: 1 });
  }
  if (/^SELECT timezone FROM ml_venues WHERE google_place_id = \$1 LIMIT 1$/.test(flat)) {
    if (corpusFails) return Promise.reject(new Error('connection terminated unexpectedly'));
    return Promise.resolve(corpusZone ? { rows: [{ timezone: corpusZone }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (/FROM users WHERE id/.test(flat)) {
    return Promise.resolve({ rows: [{ name: 'Ava Lee', date_of_birth: '2000-01-01' }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Destructured by routes/ai.js at load, so patched first.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;

// --- the predictor, faked ---------------------------------------------------
// The strip is labelled the way the real one is: its first hour is the hour it
// is handed, which is the hour the tool decided the venue is in. Flat scores,
// so neither the best time nor the peak names an hour of their own choosing.
const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const label = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
let scored = []; // { venue, ts } the headline was scored on
let strips = []; // { venue, startHour } the strip was asked for
mlPredictor.predictBusyness = async (venue, _weather, ts) => {
  scored.push({ venue, ts: new Date(ts) });
  return {
    score: 55, label: crowdEngine.getLabel(55), confidence: 60, factors: {},
    dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
  };
};
mlPredictor.predictHourlyForecast = async (venue, _weather, startHour, count) => {
  strips.push({ venue, startHour });
  return Array.from({ length: count || 12 }, (_, i) => ({
    hour: label((startHour + i) % 24), score: 55, label: crowdEngine.getLabel(55), predictionMethod: 'ml',
  }));
};

// --- Gemini, faked ----------------------------------------------------------
// The first reply makes the calls a test names; every later one answers.
const genaiMod = require('@google/genai');
let sendCalls = [];
let firstReply = null;
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: () => ({
        sendMessage: async (params) => {
          sendCalls.push(params);
          if (sendCalls.length === 1 && firstReply) return { candidates: [{ content: { parts: firstReply } }] };
          return { candidates: [{ content: { parts: [{ text: 'go now' }] } }] };
        },
      }),
    },
  };
};

// --- Google Places, faked ---------------------------------------------------
// The venue Google sends no clock for: no timeZone and no utcOffsetMinutes.
const PLACE_ID = 'PLACE_CLOCKLESS';
const CLOCKLESS = {
  id: PLACE_ID,
  displayName: { text: 'Clockless Cafe' },
  formattedAddress: '1 Main St',
  rating: 4.4,
  userRatingCount: 300,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  types: ['cafe'],
  location: { latitude: 39.95, longitude: -75.16 },
  currentOpeningHours: { openNow: true, periods: [] },
};
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/')) {
    if (u.includes(':searchText')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [CLOCKLESS] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => CLOCKLESS });
  }
  // Nothing else here may reach the network.
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

const birdieUsage = require('../services/birdieUsage');
const placeDetailsCache = require('../services/placeDetailsCache');
const aiRouter = require('../routes/ai');
const { executeTool } = aiRouter.__testables;

const app = express();
app.use(express.json());
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

// A fresh account per case: the turn meter has no reset hook by design.
let nextUserId = 9100;
test.beforeEach(() => {
  birdieUsage.__resetGeminiSpend();
  placeDetailsCache.__test.reset();
  aiRouter.__clearBirdieSearchCache();
  CURRENT_USER = { id: ++nextUserId, name: 'Ava' };
  consent = { at: null, copy: null };
  corpusZone = null;
  corpusFails = false;
  sql = [];
  sendCalls = [];
  scored = [];
  strips = [];
  firstReply = [{ functionCall: { id: 'c1', name: 'get_crowd_prediction', args: { place_id: PLACE_ID } } }];
});

// Every case reads the clock before its turn and expects the turn to finish
// inside the same UTC hour, so none starts in the last seconds of one.
async function awayFromHourEdge() {
  const intoHour = Date.now() % 3_600_000;
  if (intoHour > 3_600_000 - 5_000) await new Promise((r) => setTimeout(r, 3_600_000 - intoHour + 100));
}

// The phone's clock, twelve hours and three days from UTC, so it can never be
// taken for the UTC hour or day, or for any hour of a twelve-hour strip that
// starts at the UTC hour.
function phoneClockFor(utc) {
  return { localHour: (utc.getUTCHours() + 12) % 24, localDay: (utc.getUTCDay() + 3) % 7 };
}

const ZONE = 'America/Los_Angeles';
const MESSAGES = [{ role: 'user', text: 'how busy is the cafe' }];
// Today's web app: it asks, and it sends the device's zone.
const askingTurn = (phone) => ({ messages: MESSAGES, consentFlow: 'ask', timeZone: ZONE, ...phone });
// A build installed before the question existed: no flag and no zone, and the
// device's hour and day as every build has sent them since August.
const installedTurn = (phone) => ({ messages: MESSAGES, ...phone });

async function chat(body) {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

// What the crowd tool handed back to Gemini this turn.
function crowdToolResult() {
  for (const c of sendCalls) {
    if (!Array.isArray(c.message)) continue;
    for (const p of c.message) {
      if (p.functionResponse?.name === 'get_crowd_prediction') return p.functionResponse.response;
    }
  }
  return null;
}

const namesHour = (text, h) => new RegExp(`(^|\\D)${label(h)}(?!\\w)`).test(String(text || ''));

function assertScoredOnUtc(out, utc, phone, what) {
  assert.ok(out, `${what}: the crowd tool never answered`);
  const hour = utc.getUTCHours();
  // The tool decided the venue is in the UTC hour, on the UTC weekday.
  assert.strictEqual(strips[0]?.startHour, hour, `${what}: the strip was asked for hour ${strips[0]?.startHour}`);
  assert.strictEqual(scored[0].ts.getHours(), hour, `${what}: the headline was scored at hour ${scored[0].ts.getHours()}`);
  assert.strictEqual(scored[0].ts.getDay(), utc.getUTCDay(), `${what}: the headline was scored on weekday ${scored[0].ts.getDay()}`);
  // And Gemini was handed nothing on the phone's clock.
  assert.strictEqual(out.hourly_forecast[0].hour, label(hour));
  for (const h of out.hourly_forecast) {
    assert.notStrictEqual(h.hour, label(phone.localHour), `${what}: the forecast carries the phone's hour ${h.hour}`);
  }
  assert.ok(!namesHour(out.best_time, phone.localHour), `${what}: best_time names the phone's hour: ${out.best_time}`);
  assert.ok(!namesHour(out.peak_hours, phone.localHour), `${what}: peak_hours names the phone's hour: ${out.peak_hours}`);
  // The result says its hours are UTC hours, in words the model reads.
  assert.strictEqual(out.clock, 'UTC', `${what}: the result does not say its hours are UTC hours`);
  assert.match(out.clock_note, /does not know the local time at this venue/);
  assert.match(out.clock_note, /is a UTC hour, and "now" in any of them means the current UTC hour/);
  assert.match(out.clock_note, /crowd_score is the number for that current UTC hour too/);
  assert.match(out.clock_note, /Never present any of these hours as the venue's local time, or any of these numbers as how busy it is there right now/);
}

test("a yes to the earlier question keeps the phone's hour and day out of the crowd tool", async () => {
  await awayFromHourEdge();
  consent = { at: new Date(), copy: null };
  const utc = new Date();
  const phone = phoneClockFor(utc);
  const res = await chat(askingTurn(phone));
  assert.strictEqual(res.status, 200, res.text);
  assertScoredOnUtc(crowdToolResult(), utc, phone, 'earlier yes');
  // The Now line agrees: the user's zone is unknown on this turn.
  assert.match(String(sendCalls[0].config.systemInstruction), /You do not know the user's time zone/);
});

test("an installed build's hour and day stay out of the crowd tool too", async () => {
  await awayFromHourEdge();
  const utc = new Date();
  const phone = phoneClockFor(utc);
  const res = await chat(installedTurn(phone));
  assert.strictEqual(res.status, 200, res.text);
  assertScoredOnUtc(crowdToolResult(), utc, phone, 'installed build');
  // Still served the way it always was: its consent column is never read.
  assert.ok(!sql.some((s) => /birdie_ai_consent/.test(s)), 'the installed build now reads the consent columns');
});

test("a yes to the question that names the zone still scores that venue on the phone's clock", async () => {
  await awayFromHourEdge();
  consent = { at: new Date(), copy: 2 };
  const utc = new Date();
  const phone = phoneClockFor(utc);
  const res = await chat(askingTurn(phone));
  assert.strictEqual(res.status, 200, res.text);
  const out = crowdToolResult();
  assert.strictEqual(strips[0].startHour, phone.localHour);
  assert.strictEqual(scored[0].ts.getHours(), phone.localHour);
  assert.strictEqual(scored[0].ts.getDay(), phone.localDay);
  assert.strictEqual(out.hourly_forecast[0].hour, label(phone.localHour));
  assert.ok(!('clock' in out) && !('clock_note' in out), 'a venue scored on the user\'s clock was called UTC');
});

test("that yes on a turn that sends no zone keeps the phone's hour out, as the Now line does", async () => {
  // The zone and the hour are one clock. With no zone sent Birdie is told the
  // user's zone is unknown, and the crowd tool does not hand it over anyway.
  await awayFromHourEdge();
  consent = { at: new Date(), copy: 2 };
  const utc = new Date();
  const phone = phoneClockFor(utc);
  const res = await chat({ messages: MESSAGES, consentFlow: 'ask', ...phone });
  assert.strictEqual(res.status, 200, res.text);
  assertScoredOnUtc(crowdToolResult(), utc, phone, 'no zone sent');
  assert.match(String(sendCalls[0].config.systemInstruction), /You do not know the user's time zone/);
});

test('a venue the crowd corpus holds a zone for is scored on that zone, for any turn', async () => {
  await awayFromHourEdge();
  corpusZone = 'Asia/Tokyo'; // UTC+9 all year
  for (const [what, body, answer] of [
    ['earlier yes', askingTurn, { at: new Date(), copy: null }],
    ['zone named', askingTurn, { at: new Date(), copy: 2 }],
  ]) {
    consent = answer;
    scored = [];
    strips = [];
    sendCalls = [];
    placeDetailsCache.__test.reset();
    const utc = new Date();
    const tokyo = new Date(utc.getTime() + 9 * 3_600_000);
    const res = await chat(body(phoneClockFor(utc)));
    assert.strictEqual(res.status, 200, res.text);
    const out = crowdToolResult();
    assert.strictEqual(strips[0].startHour, tokyo.getUTCHours(), `${what}: not scored on the venue's zone`);
    assert.strictEqual(scored[0].ts.getDay(), tokyo.getUTCDay(), `${what}: not scored on the venue's weekday`);
    assert.strictEqual(scored[0].venue.timeZone, 'Asia/Tokyo', `${what}: the strip was not handed the venue's zone`);
    assert.strictEqual(out.hourly_forecast[0].hour, label(tokyo.getUTCHours()));
    assert.ok(!('clock' in out), `${what}: a venue scored on its own zone was called UTC`);
  }
});

test('a corpus zone ICU refuses, or a corpus read that fails, costs the zone and never the answer', async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    for (const setup of [() => { corpusZone = 'Not/AZone'; }, () => { corpusFails = true; }]) {
      await awayFromHourEdge();
      corpusZone = null;
      corpusFails = false;
      setup();
      scored = [];
      strips = [];
      sendCalls = [];
      placeDetailsCache.__test.reset();
      consent = { at: new Date(), copy: null };
      const utc = new Date();
      const phone = phoneClockFor(utc);
      const res = await chat(askingTurn(phone));
      assert.strictEqual(res.status, 200, res.text);
      assertScoredOnUtc(crowdToolResult(), utc, phone, corpusFails ? 'failed corpus read' : 'unusable corpus zone');
    }
  } finally {
    console.error = errors;
  }
});

test('a number scored on UTC never goes on a venue card; one on the user\'s clock does', async () => {
  firstReply = [
    { functionCall: { id: 'c1', name: 'search_venues', args: { query: 'cafes' } } },
    { functionCall: { id: 'c2', name: 'get_crowd_prediction', args: { place_id: PLACE_ID } } },
  ];
  await awayFromHourEdge();
  consent = { at: new Date(), copy: null };
  const earlier = await chat(askingTurn(phoneClockFor(new Date())));
  assert.strictEqual(earlier.status, 200, earlier.text);
  const card = earlier.body.venues.find((v) => v.place_id === PLACE_ID);
  assert.ok(card, 'the search produced no card');
  assert.strictEqual(card.crowd, null, 'a UTC hour\'s number went on the card as the level now');
  assert.strictEqual(card.crowd_label, null);

  sendCalls = [];
  aiRouter.__clearBirdieSearchCache();
  placeDetailsCache.__test.reset();
  consent = { at: new Date(), copy: 2 };
  const named = await chat(askingTurn(phoneClockFor(new Date())));
  assert.strictEqual(named.status, 200, named.text);
  assert.strictEqual(named.body.venues.find((v) => v.place_id === PLACE_ID).crowd, 55);
});

test('a locked result carries no note about hours it does not have', async () => {
  const out = await executeTool('get_crowd_prediction', { place_id: PLACE_ID }, CURRENT_USER.id, { includeForecast: false });
  assert.strictEqual(out.forecast_locked, true);
  assert.ok(!('clock' in out) && !('clock_note' in out), `a locked result still carries the UTC note: ${JSON.stringify(out)}`);
  assert.ok(!('crowd_score' in out));
});
