// Run: node --test  (from backend/)
//
// A LATER DAY (routes/ai.js, 2026-11-06). Asked for a place "on the 13th" on a
// Thursday afternoon, Birdie answered "Crowds only read twelve hours out, so
// check back closer to the 13th for the timing", over cards with no crowd row:
// the crowd tool took no date, so it could only speak about the next twelve
// hours, and the prompt told Birdie to say the read it had was for now.
//
// Pinned here, with Google, the predictor's model path and Postgres faked and
// the usual night read through the real mlPredictor.usualDayCurve:
//   1. the tool takes `date`, and a day after today at the venue is answered
//      with how busy the venue usually is that weekday (its own curve,
//      blended as a slot lookup blends it): when it is usually busiest and its
//      posted hours that day, and nothing about now (no number, no level, no
//      best time, no forecast, no open-now, no weather, no game);
//   2. the model is handed no hour-by-hour numbers for that day; the card gets
//      the usual night's bars under a key the model never sees;
//   3. today, or no date, is the lookup it was; a past, malformed or far day
//      is an error the model can act on;
//   4. a spent month locks a later day the same way it locks now;
//   5. the prompt tells Birdie to say it in plain words, never as that night's
//      crowd and never by explaining how far ahead it can see;
//   6. the cards of an answer about another day say nothing about right now
//      (no open-now pill, on any build), say which day they are about and,
//      when looked up for it, its posted hours then; a card about now that is
//      closed says when it next opens, which the model is never handed (S19);
//   7. (review, 2026-11-06) such a card carries no number for now even when
//      the turn read the venue for now too, and each card is about the day it
//      was looked up for; "tomorrow" and a weekday's name are read on the
//      venue's calendar, a dated result says the venue's own today, and a day
//      the server's clock cannot tell from today gets a note and no numbers;
//      a date in the week reads that date's own hours, a date past it the
//      posted week; a closed venue's next opening carries the venue's zone.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-later-day-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;
delete process.env.CROWD_NO_CURVE_FALLBACK;
delete process.env.CROWD_SERVE_MODE;
delete process.env.CROWD_NOWCAST_ENABLED;

const crowdEngine = require('../services/crowdEngine');

// Thursday, November 5, 2026, 3:44 PM in Bethlehem: the moment of the ask.
const THURSDAY_AFTERNOON = Date.parse('2026-11-05T20:44:00Z');

// A stand-in restaurant: closed Monday and Tuesday, dinner 5 to 9:30 PM
// Wednesday and Thursday and 5 to 10 PM Friday and Saturday, brunch 10 AM to
// 2 PM Sunday. The name and every number are invented.
const window_ = (day, open, close, closeMinute = 0) => ({ open: { day, hour: open, minute: 0 }, close: { day, hour: close, minute: closeMinute } });
const PERIODS = [window_(0, 10, 14), window_(3, 17, 21, 30), window_(4, 17, 21, 30), window_(5, 17, 22), window_(6, 17, 22)];
const PLACE = {
  id: 'ChIJlaterDayHearthBell1', displayName: { text: 'Hearth & Bell' }, formattedAddress: '12 Mill Rd, Bethlehem, PA 18015, USA',
  rating: 4.7, userRatingCount: 940, priceLevel: 'PRICE_LEVEL_EXPENSIVE', types: ['american_restaurant', 'restaurant', 'food'],
  location: { latitude: 40.59, longitude: -75.37 },
  currentOpeningHours: { openNow: false, periods: PERIODS, nextOpenTime: '2026-11-05T22:00:00Z' }, utcOffsetMinutes: -300, timeZone: { id: 'America/New_York' },
};

// The venue's weekly curve, as ml_venue_baselines holds it: Friday dinner
// rising to 7 and 8 PM, a thinner Thursday.
const CURVE = {
  '5_17': 40, '5_18': 62, '5_19': 78, '5_20': 80, '5_21': 55,
  '4_17': 30, '4_18': 41, '4_19': 52, '4_20': 49, '4_21': 33,
};
const curveRows = () => Object.entries(CURVE).map(([k, v]) => {
  const [d, h] = k.split('_').map(Number);
  return { day_of_week: d, hour: h, baseline: String(v), source: 'collected', updated_at: new Date('2026-10-30T00:00:00Z') };
});

const pool = require('../config/database');
let curveReads = 0;
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) return Promise.resolve({ rows: [{ name: 'Sam Rivera', date_of_birth: null }], rowCount: 1 });
  if (/^SELECT day_of_week, hour, baseline, source, updated_at FROM ml_venue_baselines WHERE google_place_id = \$1$/.test(flat)) {
    curveReads += 1;
    return Promise.resolve({ rows: curveRows(), rowCount: Object.keys(CURVE).length });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 41, name: 'Sam' }; next(); };
const weatherService = require('../services/weatherService');
let weatherCalls = 0;
weatherService.getWeather = async () => { weatherCalls += 1; return null; };
const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;

// The month's allowance: open unless a test spends it. Replaced before the
// route loads, which is when it takes the function.
const crowdRoute = require('../routes/crowd');
let monthSpent = false;
const charges = [];
crowdRoute.forecastAccess = async (_userId, { count, placeId } = {}) => {
  if (count) charges.push(placeId);
  return monthSpent ? { locked: true, remaining: 0, limit: 30 } : { locked: false, remaining: null, limit: null };
};

// The model path, for today's lookups only: a later day never runs it.
const mlPredictor = require('../services/mlPredictor');
let modelRuns = 0;
const label = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? 'AM' : 'PM'}`;
mlPredictor.predictBusyness = async () => {
  modelRuns += 1;
  return { score: 22, label: crowdEngine.getLabel(22), confidence: 40, factors: {}, dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test', baselineScore: 22 };
};
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count) => Array.from({ length: count || 12 }, (_, i) => {
  const h = (startHour + i) % 24;
  return { hour: label(h), score: 30, baselineScore: 30, label: crowdEngine.getLabel(30), predictionMethod: 'ml' };
});
mlPredictor.agreeWithStrip = async (headline) => headline;

// A second stand-in, a late kitchen Thursday to Saturday; invented too.
const PLACE_TWO = {
  ...PLACE,
  id: 'ChIJlaterDayLanternRm2', displayName: { text: 'Lantern Room' }, formattedAddress: '40 Main St, Bethlehem, PA 18018, USA',
  types: ['italian_restaurant', 'restaurant', 'food'],
  currentOpeningHours: { openNow: false, periods: [window_(4, 18, 23), window_(5, 18, 23), window_(6, 16, 23)] },
};
// The first stand-in as Google would send it with no zone and no offset, so
// nothing knows the date there (the server's clock).
const PLACE_NO_CLOCK = { ...PLACE, id: 'ChIJlaterDayNoClock003' };
delete PLACE_NO_CLOCK.utcOffsetMinutes;
delete PLACE_NO_CLOCK.timeZone;
// The first stand-in with this week's dated periods, as currentOpeningHours
// carries them (Thursday the 5th to Wednesday the 11th), and the posted week
// beside them. This Friday it is shut for a private event, and this Saturday
// it closes at 8; neither is its usual week.
const dated = (date, day, open, close, closeMinute = 0) => ({
  open: { day, hour: open, minute: 0, date: { year: 2026, month: 11, day: date } },
  close: { day, hour: close, minute: closeMinute, date: { year: 2026, month: 11, day: date } },
});
const PLACE_THIS_WEEK = {
  ...PLACE,
  id: 'ChIJlaterDayThisWeek04',
  currentOpeningHours: {
    openNow: false,
    periods: [dated(5, 4, 17, 21, 30), dated(7, 6, 17, 20), dated(8, 0, 10, 14), dated(11, 3, 17, 21, 30)],
    nextOpenTime: '2026-11-05T22:00:00Z',
  },
  regularOpeningHours: { periods: PERIODS },
};
const PLACES_BY_ID = new Map([PLACE, PLACE_TWO, PLACE_NO_CLOCK, PLACE_THIS_WEEK].map((pl) => [pl.id, pl]));

const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')) {
    const query = JSON.parse((opts && opts.body) || '{}').textQuery || '';
    const places = /two places/.test(query) ? [PLACE, PLACE_TWO] : [PLACE];
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places }) });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length).split('?')[0]);
    const place = PLACES_BY_ID.get(id) || PLACE;
    return Promise.resolve({ ok: true, status: 200, json: async () => place });
  }
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

// Gemini, scripted: a search, the crowd lookup for the 13th, then words.
const genaiMod = require('@google/genai');
let sends = [];
let chatConfigs = [];
let script = [];
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: (params) => {
        chatConfigs.push(params.config);
        return {
          sendMessage: async (p) => {
            sends.push(p);
            const next = script[sends.length - 1];
            if (next && next.call) return { candidates: [{ content: { parts: [{ functionCall: { id: `c${sends.length}`, ...next.call } }] } }] };
            return { candidates: [{ content: { parts: [{ text: (next && next.text) || 'Hearth & Bell.' }] } }] };
          },
        };
      },
    },
  };
};

const placeDetailsCache = require('../services/placeDetailsCache');
const aiRouter = require('../routes/ai');
const { executeTool, buildSystemPrompt } = aiRouter.__testables;

function reset() {
  placeDetailsCache.__test.reset();
  mlPredictor._internals.__resetVenueLookupCaches();
  modelRuns = 0;
  weatherCalls = 0;
  curveReads = 0;
  charges.length = 0;
  monthSpent = false;
}

const lookup = (args, opts = {}) => executeTool('get_crowd_prediction', { place_id: PLACE.id, ...args }, 51, {
  includeForecast: true, salesOff: false, searchedPlaces: new Map(), timeZone: null, ...opts,
});

async function at(t, when, fn) {
  t.mock.timers.enable({ apis: ['Date'], now: when });
  try {
    reset();
    return await fn();
  } finally {
    t.mock.timers.reset();
  }
}

// ── 1 and 2. The tool, for the 13th ───────────────────────────────────────

test('the 13th: how busy it usually is that Friday, in words, and nothing about now', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const out = await lookup({ date: '2026-11-13' });
    assert.strictEqual(out.date, '2026-11-13');
    assert.strictEqual(out.day, 'Friday');
    assert.strictEqual(out.hours_that_day, '5 PM to 10 PM');
    // Blended as one slot's lookup blends it: 7 PM and 8 PM both come to 75,
    // so the busiest stretch is 7 PM to 9 PM.
    assert.deepStrictEqual(out.usual_for_day, { source: 'venue_pattern', busiest: '7 PM to 9 PM' });
    assert.match(out.day_note, /usually busiest on that weekday, from its own usual pattern/);
    // The example is this venue's own day and hours.
    assert.match(out.day_note, /for example: "I can't see that night's crowd yet\. Fridays there are usually busiest from 7 PM to 9 PM\."$/);
    for (const k of ['crowd_score', 'crowd_label', 'crowd_source', 'crowd_method', 'confidence', 'confidence_measurement',
      'best_time', 'peak_hours', 'hourly_forecast', 'is_open', 'weather', 'game_night', 'clock']) {
      assert.ok(!(k in out), `a later day carries no ${k}`);
    }
    assert.strictEqual(modelRuns, 0, 'no model runs for a usual night');
    assert.strictEqual(weatherCalls, 0, "tonight's weather is not that night's");
    assert.strictEqual(curveReads, 1);
  });
});

test('what the model is sent holds no number for that day; the card\'s bars ride where JSON never reaches', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const out = await lookup({ date: '2026-11-13' });
    const sent = JSON.parse(JSON.stringify(out));
    assert.deepStrictEqual(Object.keys(sent).sort(), ['date', 'day', 'day_note', 'hours_that_day', 'today_there', 'usual_for_day', 'venue_name']);
    assert.strictEqual(sent.today_there, '2026-11-05 Thursday');
    assert.ok(!/\b(44|61|75|60)\b/.test(JSON.stringify(sent.usual_for_day)), JSON.stringify(sent));
    const hidden = Object.getOwnPropertySymbols(out);
    assert.strictEqual(hidden.length, 1, 'one card-only key');
    assert.deepStrictEqual(out[hidden[0]].usual, {
      date: '2026-11-13', weekday: 5, source: 'venue_pattern', busiest: { start: 19, end: 21 },
      hours: [{ h: 17, v: 44 }, { h: 18, v: 61 }, { h: 19, v: 75 }, { h: 20, v: 75 }, { h: 21, v: 60 }],
    });
  });
});

test('a day it is closed: its posted hours say so, and there is no usual night to give', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const out = await lookup({ date: '2026-11-09' }); // a Monday
    assert.strictEqual(out.day, 'Monday');
    assert.strictEqual(out.hours_that_day, 'closed');
    assert.strictEqual(out.usual_for_day, null);
    assert.match(out.day_note, /Say you can't see that night's crowd yet, and give no level and no hour for it\./);
    assert.strictEqual(Object.getOwnPropertySymbols(out).length, 0, 'no bars for a closed night');
  });
});

// ── 3. Today, and the days it cannot answer ────────────────────────────────

test('today, or no date, is the lookup it was', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    for (const args of [{}, { date: '2026-11-05' }]) {
      reset();
      const out = await lookup(args);
      assert.strictEqual(out.crowd_score, 22, JSON.stringify(args));
      assert.ok(Array.isArray(out.hourly_forecast), JSON.stringify(args));
      assert.ok(!('usual_for_day' in out) && !('date' in out), JSON.stringify(args));
      assert.strictEqual(modelRuns, 1);
    }
  });
});

test('a past day, a word, an impossible date and a day years off are errors the model can act on', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    assert.deepStrictEqual(await lookup({ date: '2026-11-04' }), { error: 'That day has already passed there.' });
    assert.match((await lookup({ date: 'next week' })).error, /YYYY-MM-DD, like 2026-11-13, or tomorrow or the weekday's name/);
    assert.match((await lookup({ date: '2026-02-30' })).error, /YYYY-MM-DD/);
    assert.match((await lookup({ date: '2028-11-13' })).error, /more than a year away/);
    assert.strictEqual(modelRuns, 0);
  });
});

// ── 4. A spent month ───────────────────────────────────────────────────────

test('a locked venue gets no usual night either, and keeps its posted hours', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const out = await lookup({ date: '2026-11-13' }, { includeForecast: false });
    assert.strictEqual(out.forecast_locked, true);
    assert.ok(!('usual_for_day' in out) && !('day_note' in out));
    assert.strictEqual(out.hours_that_day, '5 PM to 10 PM');
    assert.strictEqual(Object.getOwnPropertySymbols(out).length, 0);
    assert.strictEqual(curveReads, 0, 'a locked lookup reads no curve');
  });
});

// ── 2 and 4, through the route: the card, the meter ────────────────────────

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

const LATER_DAY_SCRIPT = [
  { call: { name: 'search_venues', args: { query: 'fine dining', location: '40.60,-75.37' } } },
  { call: { name: 'get_crowd_prediction', args: { place_id: PLACE.id, date: '2026-11-13' } } },
  { text: "Hearth & Bell. I can't see that night's crowd yet. Fridays there usually peak around 7." },
];
async function ask(text, steps = LATER_DAY_SCRIPT) {
  sends = [];
  chatConfigs = [];
  script = steps;
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text }], location: { lat: 40.6, lng: -75.37 } }),
  });
  assert.strictEqual(res.status, 200, await res.clone().text());
  return res.json();
}
const sentResponses = () => sends.flatMap((s) => (Array.isArray(s.message) ? s.message : [])).map((p) => p.functionResponse).filter(Boolean);

test('the route: the card carries that Friday\'s usual night, the model never sees its bars, and the venue is charged once', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const body = await ask('need a place on the 13th, somewhere good regardless of price');
    const card = body.venues.find((v) => v.place_id === PLACE.id);
    assert.ok(card, JSON.stringify(body.venues));
    assert.strictEqual(card.crowd, null, 'no number for now on a card about the 13th');
    assert.deepStrictEqual(card.usual, {
      date: '2026-11-13', weekday: 5, source: 'venue_pattern', busiest: { start: 19, end: 21 },
      hours: [{ h: 17, v: 44 }, { h: 18, v: 61 }, { h: 19, v: 75 }, { h: 20, v: 75 }, { h: 21, v: 60 }],
    });
    const crowdSent = sentResponses().find((r) => r.name === 'get_crowd_prediction');
    const wire = JSON.stringify(crowdSent.response);
    assert.ok(!/"hours"|"v":|"h":/.test(wire), wire);
    assert.deepStrictEqual(crowdSent.response.usual_for_day, { source: 'venue_pattern', busiest: '7 PM to 9 PM' });
    assert.deepStrictEqual(charges, [PLACE.id], 'charged once, on delivery, for the venue');
  });
});

test('the route, with the month spent: no usual night for the model or the card', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    monthSpent = true;
    const body = await ask('is hearth and bell busy on the 13th');
    const card = body.venues.find((v) => v.place_id === PLACE.id);
    assert.ok(card && !('usual' in card), JSON.stringify(card));
    const crowdSent = sentResponses().find((r) => r.name === 'get_crowd_prediction');
    assert.strictEqual(crowdSent.response.forecast_locked, true);
    assert.ok(!('usual_for_day' in crowdSent.response));
  });
});

test('the tool declares the date, as a day on their calendar', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    await ask('anything on the 13th');
    const decl = chatConfigs[0].tools[0].functionDeclarations.find((d) => d.name === 'get_crowd_prediction');
    assert.strictEqual(decl.parameters.properties.date.type, 'STRING');
    assert.match(decl.parameters.properties.date.description, /YYYY-MM-DD/);
    assert.deepStrictEqual(decl.parameters.required, ['place_id'], 'the date stays optional');
  });
});

// ── 5. The words ───────────────────────────────────────────────────────────

test('the prompt: another day is looked up with its date and said as what usually happens, in plain words', () => {
  const prompt = buildSystemPrompt('Sam', {}, { ageBracket: 'adult' });
  assert.match(prompt, /For a plan on another day \(tomorrow night, Friday, the 13th\), look the place up with get_crowd_prediction and `date` set to that day\./);
  assert.match(prompt, /Say it in plain words, like "I can't see that night's crowd yet\. Fridays there usually peak around 9\."/);
  assert.match(prompt, /never a number, a crowd level or a best time for that day/);
  assert.match(prompt, /Never explain how far ahead you can see\./);
  assert.match(prompt, /A search result's `is_open` is about right now, so for that day say open or closed only from the lookup's `hours_that_day`\./);
  // The wording that taught "The crowd reads I have are only for tonight".
  assert.doesNotMatch(prompt, /say the read you have is for now/);
  assert.doesNotMatch(prompt, /there is no forecast: never give them/);
});

// ── 6. The cards of a later day, and when a closed place opens (S19) ───────

test('the cards of an answer about the 13th: no pill for right now, the day they are about, and its posted hours', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const body = await ask('need a place on the 13th, somewhere good regardless of price');
    const card = body.venues.find((v) => v.place_id === PLACE.id);
    assert.strictEqual(card.is_open, null, 'a build that draws is_open draws nothing for 3:44 PM');
    assert.strictEqual(card.for_date, '2026-11-13');
    assert.strictEqual(card.hours_that_day, '5 PM to 10 PM');
    assert.ok(!('opens_at' in card), 'when it opens today is about today');
  });
});

test('a card about now that is closed says when it next opens, and the model is never handed it', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const body = await ask('somewhere good for dinner', [
      { call: { name: 'search_venues', args: { query: 'fine dining', location: '40.60,-75.37' } } },
      { text: 'Hearth & Bell.' },
    ]);
    const card = body.venues.find((v) => v.place_id === PLACE.id);
    assert.strictEqual(card.is_open, false);
    assert.strictEqual(card.opens_at, '2026-11-05T22:00:00Z');
    // The venue's zone, so the app says 5 PM on the venue's clock and not
    // the phone's.
    assert.strictEqual(card.opens_tz, 'America/New_York');
    assert.ok(!('for_date' in card) && !('hours_that_day' in card));
    const searchSent = sentResponses().find((r) => r.name === 'search_venues');
    const wire = JSON.stringify(searchSent.response);
    assert.ok(!/opens_at|opens_tz|nextOpenTime|2026-11-05T22|America\/New_York/.test(wire), wire);
  });
});

test('an open place, or one Google gives no next opening for, carries no opening time', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const saved = PLACE.currentOpeningHours;
    try {
      for (const hours of [{ ...saved, openNow: true }, { openNow: false, periods: PERIODS }]) {
        PLACE.currentOpeningHours = hours;
        aiRouter.__testables.resetBirdieSearchCache?.();
        const body = await ask(`dinner ${hours.openNow}`, [
          { call: { name: 'search_venues', args: { query: `fine dining ${hours.openNow} ${'nextOpenTime' in hours}`, location: '40.60,-75.37' } } },
          { text: 'Hearth & Bell.' },
        ]);
        const card = body.venues.find((v) => v.place_id === PLACE.id);
        assert.ok(!('opens_at' in card), JSON.stringify(card));
      }
    } finally {
      PLACE.currentOpeningHours = saved;
    }
  });
});

// ── 7. The review of 2026-11-06 ────────────────────────────────────────────

test('the route: a card about a later day carries no number for now, even when the turn read the venue for now as well', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const body = await ask('is hearth and bell busy now, and on the 13th?', [
      { call: { name: 'search_venues', args: { query: 'hearth and bell now and later', location: '40.60,-75.37' } } },
      { call: { name: 'get_crowd_prediction', args: { place_id: PLACE.id } } },
      { call: { name: 'get_crowd_prediction', args: { place_id: PLACE.id, date: '2026-11-13' } } },
      { text: "Hearth & Bell is quiet now. I can't see the 13th's crowd yet. Fridays there usually peak around 7." },
    ]);
    const nowSent = sentResponses().find((r) => r.name === 'get_crowd_prediction' && !('date' in r.response));
    assert.strictEqual(nowSent.response.crowd_score, 22, 'the lookup for now was made and scored');
    const card = body.venues.find((v) => v.place_id === PLACE.id);
    assert.strictEqual(card.for_date, '2026-11-13');
    assert.strictEqual(card.crowd, null, "tonight's number is not on a card about the 13th");
    assert.strictEqual(card.crowd_label, null);
    assert.ok(card.usual && card.usual.date === '2026-11-13', 'the usual night is drawn instead');
  });
});

test('the same, with the dated lookup first: still no number for now on the card', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const body = await ask('the 13th, and how about right now?', [
      { call: { name: 'search_venues', args: { query: 'hearth and bell later and now', location: '40.60,-75.37' } } },
      { call: { name: 'get_crowd_prediction', args: { place_id: PLACE.id, date: '2026-11-13' } } },
      { call: { name: 'get_crowd_prediction', args: { place_id: PLACE.id } } },
      { text: 'Hearth & Bell.' },
    ]);
    const card = body.venues.find((v) => v.place_id === PLACE.id);
    assert.strictEqual(card.crowd, null);
    assert.strictEqual(card.crowd_label, null);
    assert.strictEqual(card.for_date, '2026-11-13');
  });
});

test('the route: "Friday or Saturday?" makes each card about the day it was looked up for', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    const body = await ask('two places for friday or saturday', [
      { call: { name: 'search_venues', args: { query: 'two places friday or saturday', location: '40.60,-75.37' } } },
      { call: { name: 'get_crowd_prediction', args: { place_id: PLACE.id, date: '2026-11-06' } } },
      { call: { name: 'get_crowd_prediction', args: { place_id: PLACE_TWO.id, date: '2026-11-07' } } },
      { text: 'Hearth & Bell on Friday, or Lantern Room on Saturday.' },
    ]);
    const hearth = body.venues.find((v) => v.place_id === PLACE.id);
    const lantern = body.venues.find((v) => v.place_id === PLACE_TWO.id);
    assert.ok(hearth && lantern, JSON.stringify(body.venues));
    assert.strictEqual(hearth.for_date, '2026-11-06');
    assert.strictEqual(hearth.hours_that_day, '5 PM to 10 PM');
    assert.strictEqual(lantern.for_date, '2026-11-07', "Saturday's card is about Saturday, not the turn's first day");
    assert.strictEqual(lantern.hours_that_day, '4 PM to 11 PM');
  });
});

test('"tomorrow" and a weekday are read on the venue\'s calendar; today\'s own name is today', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    for (const [word, date, day] of [['tomorrow', '2026-11-06', 'Friday'], ['Friday', '2026-11-06', 'Friday'], [' wednesday ', '2026-11-11', 'Wednesday']]) {
      reset();
      const out = await lookup({ date: word });
      assert.strictEqual(out.date, date, word);
      assert.strictEqual(out.day, day, word);
      assert.strictEqual(out.today_there, '2026-11-05 Thursday', word);
    }
    for (const word of ['Thursday', 'tonight', 'today']) {
      reset();
      const out = await lookup({ date: word });
      assert.strictEqual(out.crowd_score, 22, word);
      assert.ok(!('date' in out), word);
    }
  });
});

// Friday, November 6, 2026, 9 PM in Bethlehem, which is 2 AM Saturday UTC.
const FRIDAY_NIGHT = Date.parse('2026-11-07T02:00:00Z');

test('a UTC Now line past midnight: "tomorrow" is the venue\'s Saturday, and a date worked out from UTC shows against today_there', async (t) => {
  await at(t, FRIDAY_NIGHT, async () => {
    const out = await lookup({ date: 'tomorrow' });
    assert.strictEqual(out.date, '2026-11-07');
    assert.strictEqual(out.day, 'Saturday');
    assert.strictEqual(out.today_there, '2026-11-06 Friday');
    reset();
    // What a model reading "Now: Saturday, November 7" sends for tomorrow.
    const fromUtc = await lookup({ date: '2026-11-08' });
    assert.strictEqual(fromUtc.day, 'Sunday');
    assert.strictEqual(fromUtc.today_there, '2026-11-06 Friday', 'the venue\'s own today rides with it');
  });
});

test('the prompt with no zone for the user asks for the word, and one with a zone grows by nothing', () => {
  const utc = buildSystemPrompt('Sam', {}, { ageBracket: 'adult', clock: { nowMs: FRIDAY_NIGHT, timeZone: null } });
  assert.match(utc, /For get_crowd_prediction, send tomorrow or a weekday as the word itself \(`date`: "tomorrow", "friday"\), never a date worked out from this UTC one; a result's `today_there` is the venue's own date\./);
  const zoned = buildSystemPrompt('Sam', {}, { ageBracket: 'adult', clock: { nowMs: FRIDAY_NIGHT, timeZone: 'America/New_York' } });
  assert.doesNotMatch(zoned, /as the word itself/);
});

test('no clock for the venue: a day that cannot be told from today gets a note and no numbers for now', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    for (const date of ['2026-11-06', 'tomorrow', '2026-11-05']) {
      reset();
      const out = await lookup({ place_id: PLACE_NO_CLOCK.id, date });
      assert.strictEqual(typeof out.date, 'string', date);
      assert.match(out.date_note, /cannot be told apart from today/, date);
      for (const k of ['crowd_score', 'crowd_label', 'best_time', 'hourly_forecast', 'usual_for_day']) {
        assert.ok(!(k in out), `${date}: no ${k}`);
      }
      assert.strictEqual(modelRuns, 0, date);
    }
    // Two days out is still a later day there, and no date is the lookup it was.
    reset();
    assert.strictEqual((await lookup({ place_id: PLACE_NO_CLOCK.id, date: '2026-11-07' })).day, 'Saturday');
    reset();
    assert.ok(!('date_note' in await lookup({ place_id: PLACE_NO_CLOCK.id })));
  });
});

test('a date in the week reads that date\'s own hours; a date past it reads the posted week', async (t) => {
  await at(t, THURSDAY_AFTERNOON, async () => {
    // This Friday it is shut, so there is no usual night to give.
    const friday = await lookup({ place_id: PLACE_THIS_WEEK.id, date: '2026-11-06' });
    assert.strictEqual(friday.hours_that_day, 'closed');
    assert.strictEqual(friday.usual_for_day, null);
    reset();
    // This Saturday it closes at 8.
    assert.strictEqual((await lookup({ place_id: PLACE_THIS_WEEK.id, date: '2026-11-07' })).hours_that_day, '5 PM to 8 PM');
    reset();
    // The 13th is past the week Google dates: the posted Friday, open, and
    // its usual night drawn over its posted hours.
    const thirteenth = await lookup({ place_id: PLACE_THIS_WEEK.id, date: '2026-11-13' });
    assert.strictEqual(thirteenth.hours_that_day, '5 PM to 10 PM');
    assert.deepStrictEqual(thirteenth.usual_for_day, { source: 'venue_pattern', busiest: '7 PM to 9 PM' });
    reset();
    // The 14th, a Saturday past the week: the posted 5 to 10, not this week's 8.
    assert.strictEqual((await lookup({ place_id: PLACE_THIS_WEEK.id, date: '2026-11-14' })).hours_that_day, '5 PM to 10 PM');
  });
});

test('the shared details mask carries the posted week, on the tier it already pays for', () => {
  const fields = placeDetailsCache.PLACE_DETAILS_FIELD_MASK.split(',');
  assert.ok(fields.includes('regularOpeningHours'));
  assert.ok(fields.includes('currentOpeningHours'), 'an Enterprise field beside it, so it raises no price');
});
