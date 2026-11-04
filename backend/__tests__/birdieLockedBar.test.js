// Run: node --test  (from backend/)
//
// LOCKED IN AT A BAR, FOR SOMEONE UNDER 21 (routes/ai.js buildPlanRule and
// the reply; utils/birdieDoorTalk.js; utils/birdieGrounding.js withoutClauses).
//
// A flock's plan can be locked in at a bar while the person asking Birdie from
// inside it is 19, or 16, or has no date of birth on file (every account the
// iPhone app makes). Before 2026-11-04 the age rules ("never recommend bars",
// "skip bars and clubs") pulled against "answer about that venue", nothing in
// the prompt kept drinks, ID or the door out of the answer, and a reply that
// mentioned carding was swapped whole for "can't help with drinking under 21",
// so "how busy will it be?" could come back as a refusal of a question nobody
// asked. This pins what is true now:
//   1. the crowd and timing of the group's locked venue are answered for any
//      age, and the prompt says so per age;
//   2. for anyone under 21 or of no known age, no clause about drinks, ID, age
//      limits or getting in reaches them, and the crowd answer around it stays;
//   3. no other bar reaches them, from a search or on a card, and someone under
//      18 or of no known age gets no card for the plan's bar either;
//   4. someone who asks about drinking, ID or the door still gets the plain no;
//   5. an adult's answer, and every answer outside a locked plan, is as before.
//
// Driven through the real route with Gemini, Places and the database faked.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'birdie-locked-bar-test-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.NODE_ENV;
delete process.env.POSTHOG_API_KEY;
delete process.env.CROWD_NO_CURVE_FALLBACK;
delete process.env.CROWD_SERVE_MODE;
delete process.env.CROWD_NOWCAST_ENABLED;

const years = (n) => new Date(Date.now() - n * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
// Who is asking: a date of birth, or none.
const ASKERS = [
  { who: '19', dob: years(19), bracket: 'under21' },
  { who: '16', dob: years(16), bracket: 'minor' },
  { who: 'no age', dob: null, bracket: null },
];

// The database: the asker, and the flock's plan, locked in at a bar (or not).
const LOCKED_AT_BAR = { status: 'confirmed', venue_name: 'The Velvet Hour', venue_id: 'PLACE_VELVET', going_member_ids: [7, 11, 12, 13], guests_going: 1 };
const VOTING = { status: 'planning', venue_name: null, venue_id: null, going_member_ids: [7, 11, 12], guests_going: 0 };
const db = { dob: null, planRow: LOCKED_AT_BAR };
const pool = require('../config/database');
pool.query = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(flat)) return Promise.resolve({ rows: [{ name: 'Jules Park', date_of_birth: db.dob }], rowCount: 1 });
  if (/AS going_member_ids/.test(flat)) return Promise.resolve({ rows: db.planRow ? [db.planRow] : [], rowCount: db.planRow ? 1 : 0 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};
// A fresh account per request, so the per-account minute meter never answers
// in place of the route.
let nextUserId = 72000;
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: ++nextUserId, name: 'Jules Park' }; next(); };
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => null;
const gameNights = require('../services/gameNights');
gameNights.gameNightFor = async () => null;

// The bar's crowd: quiet early, packed after 10.
const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const LEVELS = { 17: 12, 18: 20, 19: 26, 20: 38, 21: 55, 22: 77, 23: 91, 0: 94, 1: 80 };
const levelAt = (h) => LEVELS[h] ?? 2;
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? 'AM' : 'PM'}`;
mlPredictor.predictBusyness = async (_venue, _weather, ts) => {
  const score = levelAt(new Date(ts).getHours());
  return { score, label: crowdEngine.getLabel(score), confidence: 40, factors: {}, dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test', baselineScore: score };
};
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count) => Array.from({ length: count || 12 }, (_, i) => {
  const h = (startHour + i) % 24;
  const score = levelAt(h);
  return { hour: hourLabel(h), score, baselineScore: score, label: crowdEngine.getLabel(score), predictionMethod: 'ml' };
});
mlPredictor.agreeWithStrip = async (headline) => headline;

// Open every evening from 5 PM to 2 AM, the way Google sends its periods.
const PERIODS = Array.from({ length: 7 }, (_, d) => ({ open: { day: d, hour: 17, minute: 0 }, close: { day: (d + 1) % 7, hour: 2, minute: 0 } }));
const place = (id, name, types) => ({
  id, displayName: { text: name }, formattedAddress: `${name} St, Philadelphia, PA`, rating: 4.2, userRatingCount: 296,
  priceLevel: 'PRICE_LEVEL_EXPENSIVE', types, location: { latitude: 39.97, longitude: -75.13 },
  currentOpeningHours: { openNow: true, periods: PERIODS }, utcOffsetMinutes: -300, timeZone: { id: 'America/New_York' },
});
const VELVET = place('PLACE_VELVET', 'The Velvet Hour', ['bar', 'night_club', 'establishment']);
const LARKSPUR = place('PLACE_LARKSPUR', 'Larkspur Tap', ['bar', 'pub', 'establishment']);
const MANGO = place('PLACE_MANGO', 'Mango Street Tacos', ['mexican_restaurant', 'restaurant', 'food']);
const PIXEL = place('PLACE_PIXEL', 'Pixel Pier Arcade', ['amusement_center', 'point_of_interest']);
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/') && u.includes(':searchText')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [VELVET, LARKSPUR, MANGO, PIXEL] }) });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    const byId = { PLACE_VELVET: VELVET, PLACE_LARKSPUR: LARKSPUR, PLACE_MANGO: MANGO, PLACE_PIXEL: PIXEL };
    const p = byId[decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length).split('?')[0])];
    return Promise.resolve(p ? { ok: true, status: 200, json: async () => p } : { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND' } }) });
  }
  return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
};
test.after(() => { global.fetch = realFetch; });

// The model: `script` is what it does, one entry per call: a tool to call, or
// the words it writes.
const genaiMod = require('@google/genai');
let sends = [];
let configs = [];
let script = [];
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: (opts) => {
        configs.push(opts.config);
        return {
          sendMessage: async (p) => {
            sends.push(p);
            const step = script[Math.min(sends.length - 1, script.length - 1)];
            if (step.call) return { candidates: [{ content: { parts: [{ functionCall: { id: `c${sends.length}`, name: step.call, args: step.args } }] } }] };
            return { candidates: [{ content: { parts: [{ text: step.text }] } }] };
          },
        };
      },
    },
  };
};

const placeDetailsCache = require('../services/placeDetailsCache');
const aiRouter = require('../routes/ai');
const { buildPlanRule } = aiRouter.__testables;
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

const FLOCK = { screen: 'chatDetail', tab: 'chat', flock: { id: 912, name: 'Saturday night', venue: 'The Velvet Hour', status: 'confirmed' } };
const CROWD = { call: 'get_crowd_prediction', args: { place_id: 'PLACE_VELVET' } };
const SEARCH = { call: 'search_venues', args: { query: 'bars in fishtown', location: '39.97,-75.13' } };
const PLAIN_NO = "can't help with drinking under 21. want a spot that fits the night without it? tell me what you're into";
const LOCKED_LINE = "the plan's locked in. ask me how busy it'll be or when to head over";

async function ask(dob, text, steps, { planRow = LOCKED_AT_BAR, ctx = FLOCK } = {}) {
  db.dob = dob;
  db.planRow = planRow;
  script = steps;
  sends = [];
  configs = [];
  aiRouter.__clearBirdieSearchCache();
  placeDetailsCache.__test.reset();
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', text }], location: { lat: 39.97, lng: -75.13 }, currentContext: ctx }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  return body;
}
const systemPrompt = () => String(configs[0] && configs[0].systemInstruction);
// What a tool handed the model this turn, by name.
const toolResult = (name) => sends.flatMap((s) => (Array.isArray(s.message) ? s.message : []))
  .map((p) => p.functionResponse).filter((f) => f && f.name === name).map((f) => f.response)[0];

const LOCKED_RULE = '- The plan is locked in at the venue in that line, so where to go is settled. Answer about that venue: for how busy it will be or when to go, look it up with get_crowd_prediction and its place_id. Do not suggest another place unless they ask for a different one.';
const AGE_LINE = /It is the group's plan, not your pick for them, so telling them how busy it will be and when to go is not recommending it: answer that the way you would for any venue\. Say nothing about drinks, drinking, ID, being carded, age limits or getting in, and never suggest another bar or club\./;
const SELLS = /Name it as the group's plan with its crowd and timing and nothing that sells it: no rating, price, vibe, music or deal\./;

test('the locked plan\'s rule, per age: answered for anyone, nothing about drinks, ID or the door under 21, nothing that sells it under 18', () => {
  const plan = { going: 5, locked: { name: 'The Velvet Hour', placeId: 'PLACE_VELVET' }, venueSoFar: null, picks: [] };
  const adult = buildPlanRule(plan, 'adult');
  assert.ok(adult.endsWith(LOCKED_RULE), adult);
  assert.doesNotMatch(adult, AGE_LINE);
  const at = {
    under21: buildPlanRule(plan, 'under21'),
    minor: buildPlanRule(plan, 'minor'),
    unknown: buildPlanRule(plan, null),
    unset: buildPlanRule(plan),
  };
  assert.match(at.under21, /\n- This person is under 21, and the plan stands whatever kind of place it is, a bar or a club included\./);
  assert.match(at.minor, /\n- This person is under 18, and the plan stands/);
  assert.match(at.unknown, /\n- You do not know this person's age, and the plan stands/);
  assert.strictEqual(at.unset, at.unknown, 'no age passed is no known age');
  for (const [k, rule] of Object.entries(at)) {
    assert.ok(rule.includes(LOCKED_RULE), k);
    assert.match(rule, AGE_LINE, k);
  }
  assert.doesNotMatch(at.under21, SELLS);
  assert.match(at.minor, SELLS);
  assert.match(at.unknown, SELLS);
  // A plan still voting is untouched by age.
  const voting = { going: 3, locked: null, venueSoFar: null, picks: [{ name: 'Larkspur Tap', placeId: 'PLACE_LARKSPUR', votes: 2 }] };
  assert.strictEqual(buildPlanRule(voting, 'minor'), buildPlanRule(voting, 'adult'));
  assert.doesNotMatch(buildPlanRule(voting, 'minor'), AGE_LINE);
});

test('"how busy will it be?": the bar\'s crowd and timing for any age, and the ID warning around it goes', async () => {
  const reply = 'The Velvet Hour sits at 26 right now and climbs after 9. Heads up, they card at the door.';
  for (const a of ASKERS) {
    const body = await ask(a.dob, 'how busy will it be?', [CROWD, { text: reply }]);
    // The crowd tool answered about the group's bar, whoever asked.
    const crowd = toolResult('get_crowd_prediction');
    assert.ok(crowd && Number.isFinite(crowd.crowd_score) && typeof crowd.best_time === 'string', `${a.who}: ${JSON.stringify(crowd)}`);
    assert.strictEqual(crowd.venue_name, 'The Velvet Hour');
    // The prompt says to answer it, in that person's words.
    assert.ok(systemPrompt().includes(LOCKED_RULE), a.who);
    assert.match(systemPrompt(), AGE_LINE, a.who);
    // The crowd answer stands; the carding goes; no plain no to a question
    // nobody asked.
    assert.strictEqual(body.text, 'The Velvet Hour sits at 26 right now and climbs after 9.', a.who);
  }
});

test('"where should we go?": the plan, and nothing about being 21 or bringing ID', async () => {
  for (const a of ASKERS) {
    const body = await ask(a.dob, 'where should we go?', [{ text: "Stick with The Velvet Hour. It's 21+, so bring ID." }]);
    assert.strictEqual(body.text, 'Stick with The Velvet Hour.', a.who);
  }
});

test('drink talk goes clause by clause, and a reply that was only that says what the plan can answer', async () => {
  for (const a of ASKERS) {
    const drinks = await ask(a.dob, 'how busy will it be?', [CROWD, { text: 'You are locked in at The Velvet Hour. It is steady at 26, and happy hour ends at 7, so go now.' }]);
    assert.strictEqual(drinks.text, 'You are locked in at The Velvet Hour. It is steady at 26, so go now.', a.who);
    const cocktails = await ask(a.dob, 'how busy will it be?', [CROWD, { text: 'The Velvet Hour is at 26 right now, and the cocktails are worth it.' }]);
    assert.strictEqual(cocktails.text, 'The Velvet Hour is at 26 right now.', a.who);
    const door = await ask(a.dob, 'where should we go?', [{ text: "The Velvet Hour is 21 and up, so you won't get in." }]);
    assert.strictEqual(door.text, LOCKED_LINE, a.who);
  }
});

test('no other bar reaches them from a search; under 18 or of no known age, no card for the plan\'s bar either', async () => {
  for (const a of ASKERS) {
    const body = await ask(a.dob, 'where should we go?', [SEARCH, { text: 'Stick with The Velvet Hour, it is at 26 right now.' }]);
    const seen = (toolResult('search_venues').venues || []).map((v) => v.name);
    assert.ok(!seen.includes('Larkspur Tap'), `${a.who}: another bar reached the model: ${seen.join(', ')}`);
    assert.ok(seen.includes('Mango Street Tacos') && seen.includes('Pixel Pier Arcade'), `${a.who}: ${seen.join(', ')}`);
    const cards = body.venues.map((v) => v.name);
    assert.ok(!cards.includes('Larkspur Tap'), a.who);
    if (a.bracket === 'under21') {
      // 18 to 20: the group's own venue is a place they may hear of, and carry a card for.
      assert.ok(seen.includes('The Velvet Hour'), `${a.who}: ${seen.join(', ')}`);
      assert.deepStrictEqual(cards, ['The Velvet Hour'], a.who);
    } else {
      assert.ok(!seen.includes('The Velvet Hour'), `${a.who}: ${seen.join(', ')}`);
      assert.deepStrictEqual(cards, [], a.who);
    }
    assert.strictEqual(body.text, 'Stick with The Velvet Hour, it is at 26 right now.', a.who);
  }
});

test('a drink the bar\'s own listing stands behind is still drink talk to someone under 21', async () => {
  // The search hands the model the bar typed `bar`, which makes "cocktails" a
  // fact about it for the grounding check (WHAT BIRDIE MAY SAY ABOUT A VENUE),
  // so only this rule takes it out.
  const reply = 'Stick with The Velvet Hour, the cocktails are worth it.';
  const young = await ask(years(19), 'where should we go?', [SEARCH, { text: reply }]);
  assert.strictEqual(young.text, 'Stick with The Velvet Hour.');
  const adult = await ask(years(23), 'where should we go?', [SEARCH, { text: reply }]);
  assert.strictEqual(adult.text, reply, 'for an adult the listing stands behind it, and it stays');
});

test('someone who asks about drinking, ID or the door still gets the plain no, for any of it in the reply', async () => {
  for (const a of ASKERS) {
    const drink = await ask(a.dob, 'can we drink there?', [{ text: "Not for you, but it's at 26 right now if you're going for the group." }]);
    assert.strictEqual(drink.text, "Not for you, but it's at 26 right now if you're going for the group.", `${a.who}: a reply with none of it is left alone`);
    const served = await ask(a.dob, 'can we drink there?', [{ text: "No drinking at 16 or 19, but it's at 26 right now." }]);
    assert.strictEqual(served.text, PLAIN_NO, a.who);
    const door = await ask(a.dob, 'will they let us in?', [{ text: 'They might turn you away at the door.' }]);
    assert.strictEqual(door.text, PLAIN_NO, a.who);
    const carded = await ask(a.dob, 'do they card?', [{ text: 'They card at the door after 9.' }]);
    assert.strictEqual(carded.text, PLAIN_NO, a.who);
  }
});

test('an adult in the same plan is answered as before: no age line, nothing taken out, every bar a search found', async () => {
  const adultDob = years(23);
  const reply = 'The Velvet Hour sits at 26 right now and climbs after 9. Heads up, they card at the door.';
  const body = await ask(adultDob, 'how busy will it be?', [CROWD, { text: reply }]);
  assert.strictEqual(body.text, reply);
  assert.ok(systemPrompt().includes(LOCKED_RULE));
  assert.doesNotMatch(systemPrompt(), AGE_LINE);
  const search = await ask(adultDob, 'where should we go?', [SEARCH, { text: 'Stick with The Velvet Hour.' }]);
  const seen = toolResult('search_venues').venues.map((v) => v.name);
  assert.deepStrictEqual(seen, ['The Velvet Hour', 'Larkspur Tap', 'Mango Street Tacos', 'Pixel Pier Arcade']);
  assert.deepStrictEqual(search.venues.map((v) => v.name), ['The Velvet Hour']);
});

test('outside a locked plan nothing changed: a vote, or no flock at all, still gets the plain no for carding talk', async () => {
  const reply = 'The Velvet Hour sits at 26 right now. Heads up, they check IDs at the door.';
  for (const a of ASKERS) {
    const voting = await ask(a.dob, 'how busy will it be?', [{ text: reply }], { planRow: VOTING, ctx: { ...FLOCK, flock: { ...FLOCK.flock, venue: null, status: 'planning' } } });
    assert.strictEqual(voting.text, PLAIN_NO, `${a.who}: voting`);
    assert.doesNotMatch(systemPrompt(), AGE_LINE);
    const home = await ask(a.dob, 'how busy will it be?', [{ text: reply }], { planRow: null, ctx: { screen: 'main', tab: 'home' } });
    assert.strictEqual(home.text, PLAIN_NO, `${a.who}: no flock`);
    // And a drink word with no carding in it is the prompt's alone there.
    const cocktails = await ask(a.dob, 'how busy is the velvet hour?', [{ text: 'The Velvet Hour is at 26 right now, and the cocktails are worth it.' }], { planRow: null, ctx: { screen: 'main', tab: 'home' } });
    assert.strictEqual(cocktails.text, 'The Velvet Hour is at 26 right now, and the cocktails are worth it.', a.who);
  }
  // Under 21 outside a plan keeps every bar a search found, as before.
  await ask(years(19), 'bars near me?', [SEARCH, { text: 'Mango Street Tacos.' }], { planRow: null, ctx: { screen: 'main', tab: 'home' } });
  assert.deepStrictEqual(toolResult('search_venues').venues.map((v) => v.name), ['The Velvet Hour', 'Larkspur Tap', 'Mango Street Tacos', 'Pixel Pier Arcade']);
});
