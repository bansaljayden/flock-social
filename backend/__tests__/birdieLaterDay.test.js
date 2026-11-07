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
//      closed says when it next opens, which the model is never handed (S19).
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

const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchText')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [PLACE] }) });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) return Promise.resolve({ ok: true, status: 200, json: async () => PLACE });
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
    assert.match(out.day_note, /I can't see that night's crowd yet\. Fridays there usually peak around 9\./);
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
    assert.deepStrictEqual(Object.keys(sent).sort(), ['date', 'day', 'day_note', 'hours_that_day', 'usual_for_day', 'venue_name']);
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
    assert.match((await lookup({ date: 'Friday' })).error, /YYYY-MM-DD, like 2026-11-13/);
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
    assert.ok(!('for_date' in card) && !('hours_that_day' in card));
    const searchSent = sentResponses().find((r) => r.name === 'search_venues');
    const wire = JSON.stringify(searchSent.response);
    assert.ok(!/opens_at|nextOpenTime|2026-11-05T22/.test(wire), wire);
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
