// Run: node --test __tests__/roostForecastMove.test.js  (from backend/)
//
// ROOST'S MONEY MOVE ANSWERS FROM THE WEEK AHEAD CARD WHEN THAT IS ALL THERE IS
// (2026-11-03).
//
// Filming the demo on a new venue with no crowd history, "What is our best
// money move this week?" answered "We can't answer that yet. We have no crowd
// history for this venue." while the same dashboard's Week Ahead card read
// Sat 74, Sun 45, Mon 48, Tue 48, Wed 48, Thu 64. Pinned here:
//   1. the facts: the card's own week (GET /api/venue-dashboard/intelligence,
//      venueIntelligence) becomes Roost facts with the card's numbers, source
//      category_pattern, ids of their own, and a label and note that call it
//      Flock's forecast for places like this one; never a week holding a model
//      number, and never a daytime venue's evening scan;
//   2. the answer: the money move names the card's quietest and busiest days
//      with the card's numbers, from the same function and the same cache
//      entry (no second estimate), said as Flock's forecast for places like
//      yours, with the move naming the quiet day; so do the other week chips;
//      today and the listing lines, which the card does not carry, are as
//      they were;
//   3. the phrasing input and the check: the model is handed those facts with
//      their source and note; a draft that does not open on whose forecast it
//      is, or puts "you" or "your" beside a ranking of its days, goes to the
//      template; an invented number loses its line;
//   4. advice: the advice model is never handed the card; the playbook's
//      answer leads with it, framed, and names the day in its move;
//   5. no history and no card: the refusal stands, word for word, and costs
//      no model call;
//   6. a venue with its own crowd history never reads the card;
//   7. the review's other findings: a level card week, a cafe, a tie, and a
//      failed lookup paid for once.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { pinClock } = require('./helpers/pinnedClock');

process.env.JWT_SECRET = 'roost-forecast-move-test-secret';
// Set BEFORE requiring the dashboard router: it captures the key at load.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;
delete process.env.ROOST_PLAYBOOK_FIRST;

// ── The database: one venue, scripted per test ─────────────────────────────
const pool = require('../config/database');

let profile = null;
pool.query = async (sql) => {
  const q = String(sql).replace(/\s+/g, ' ');
  if (/FROM venue_profiles WHERE user_id/.test(q)) return { rows: profile ? [profile] : [], rowCount: profile ? 1 : 0 };
  if (/roost_ai_consent_at FROM users/.test(q)) return { rows: [{ roost_ai_consent_at: '2026-10-01T00:00:00Z' }], rowCount: 1 };
  if (/INSERT INTO advisor_(?:venue_)?spend/.test(q)) return { rows: [{ tokens: 1 }], rowCount: 1 };
  // No corpus row and no curve: a venue Flock has never collected.
  return { rows: [], rowCount: 0 };
};

function noHistoryVenue(placeId, extra = {}) {
  return {
    id: 1,
    user_id: 1,
    google_place_id: placeId,
    verified: true,
    business_name: 'Thistle Room',
    category: null,
    updated_at: '2026-10-01T00:00:00Z',
    corpus_status: 'absent',
    corpus_baseline_rows: 0,
    corpus_checked_at: '2026-10-01T00:00:00Z',
    service_style: 'bar_standing',
    typical_spend_per_person: 28,
    kitchen_last_order: '21:30',
    ...extra,
  };
}

// ── Sign-in, budgets, weather ───────────────────────────────────────────────
const authMod = require('../middleware/auth');

authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Owner', role: 'venue_owner' }; next(); };
const placesBudget = require('../utils/placesBudget');

placesBudget.allowPlacesSearch = () => true;
const weatherService = require('../services/weatherService');

weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

// ── The forecast: the card's evenings, by weekday ───────────────────────────
// The demo's card, plus a Friday for a run on any other day of the week.
const CARD = { Sat: 74, Sun: 45, Mon: 48, Tue: 48, Wed: 48, Thu: 64, Fri: 66 };
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const label = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

const mlPredictor = require('../services/mlPredictor');

// What made each hour: a category prior, as for any venue with no curve.
let method = 'rule_engine_no_baseline';
let eveningCalls = 0;
mlPredictor.predictBusyness = async () => ({ score: 40, label: 'Moderate', predictionMethod: method, modelVersion: null });
mlPredictor.agreeWithStrip = async (scored) => scored;
// The run of a model number on one day only, for the tests of a card that
// holds one (`method` above puts one on every hour).
let modelOnDate = null;
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count, day) => {
  if (startHour === 17) eveningCalls += 1;
  const peak = CARD[SHORT[new Date(day).getDay()]];
  const hours = [];
  for (let i = 0; i < count; i += 1) hours.push((startHour + i) % 24);
  const onDate = modelOnDate && new Date(day).toISOString().slice(0, 10) === modelOnDate;
  // Each day peaks at the card's number for that weekday twice, at 8 AM and
  // at 9 PM, so a venue read by day and one read on the evening each find it.
  return hours.map((h) => ({
    hour: label(h),
    score: h === 21 || h === 8 ? peak : Math.max(1, peak - 12 - Math.min(Math.abs(21 - h), Math.abs(8 - h))),
    baselineScore: null,
    predictionMethod: onDate ? 'ml' : method,
  }));
};

// ── Google Places, for the card's one lookup ────────────────────────────────
let placesUp = true;
let placesCalls = 0;
// What Google says the place is: a bar, unless a test makes it a cafe.
let placeTypes = ['bar'];
// Google's primary type, and the listing's opening hours (periods), when a
// test gives the place either.
let placePrimary = null;
let placePeriods = null;
// The listing's clock: Google's utcOffsetMinutes, and its IANA zone when a
// test gives the place one. A venue on UTC unless a test moves it, so "today"
// at the venue is the UTC day (new Date().getUTCDay() in the tests below).
let placeOffset = 0;
let placeZone = null;
// How long Google takes to answer. Zero answers at once; a test that needs
// requests to overlap gives the lookup time to still be under way.
let placesDelayMs = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    placesCalls += 1;
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length));
    const answer = {
      status: 200,
      json: async () => (placesUp ? {
        id,
        displayName: { text: 'Thistle Room' },
        rating: 4.4,
        userRatingCount: 320,
        types: placeTypes,
        ...(placePrimary ? { primaryType: placePrimary } : {}),
        location: { latitude: 39.95, longitude: -75.16 },
        currentOpeningHours: placePeriods ? { openNow: true, periods: placePeriods } : { openNow: true },
        utcOffsetMinutes: placeOffset,
        ...(placeZone ? { timeZone: { id: placeZone } } : {}),
      } : { error: { code: 503, message: 'unavailable' } }),
    };
    return placesDelayMs > 0
      ? new Promise((resolve) => { setTimeout(() => resolve(answer), placesDelayMs); })
      : Promise.resolve(answer);
  }
  return realFetch(url, opts);
};

const advisorFacts = require('../services/advisorFacts');
const advisorPhrasing = require('../services/advisorPhrasing');
const roostPlaybook = require('../services/roostPlaybook');
const kindForecast = require('../services/kindForecast');
const { CLASSIFIER_PROMPT, ADVICE_SYSTEM_PROMPT, SYSTEM_PROMPT } = require('../services/advisorPrompt');
const venueDashboardRouter = require('../routes/venueDashboard');
const advisorRouter = require('../routes/advisor');

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);
app.use('/api/venue/advisor', advisorRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  global.fetch = realFetch;
  advisorPhrasing.__setGenAIForTests(null);
  server.close(resolve);
}));

// ── The model, scripted: the router's route, and a draft per answer call ───
let route = null;
let draftFor = null;
let modelCalls = [];
advisorPhrasing.__setGenAIForTests({
  models: {
    generateContent: async (req) => {
      const system = req.config.systemInstruction;
      const role = system === CLASSIFIER_PROMPT ? 'router' : (system === ADVICE_SYSTEM_PROMPT ? 'advice' : 'phrasing');
      const payload = req.contents[0].parts[0].text;
      modelCalls.push({ role, payload });
      if (role === 'router') return { text: JSON.stringify(route) };
      const draft = draftFor ? draftFor(role, payload) : null;
      if (draft === null) throw new Error('no draft scripted');
      return { text: JSON.stringify(draft), usageMetadata: { totalTokenCount: 10 } };
    },
  },
});

function setUp({ placeId, phrasing = false, extra = {} } = {}) {
  profile = noHistoryVenue(placeId, extra);
  process.env.ADVISOR_PHRASING_ENABLED = phrasing ? 'true' : 'false';
  advisorPhrasing.__resetAdvisorSpend();
  method = 'rule_engine_no_baseline';
  modelOnDate = null;
  placesUp = true;
  placeTypes = ['bar'];
  placePrimary = null;
  placePeriods = null;
  placeOffset = 0;
  placeZone = null;
  placesDelayMs = 0;
  route = null;
  draftFor = null;
  modelCalls = [];
}

async function call(path, body = null) {
  const res = await fetch(`${base}${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  return { status: res.status, body: await res.json() };
}

// The card's week as the dashboard serves it, and its quietest and busiest
// (each the first of its kind in date order, the way the tile reads it).
async function cardWeek() {
  const r = await call('/api/venue-dashboard/intelligence');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
  const week = r.body.week;
  const low = week.reduce((a, b) => (b.peakScore < a.peakScore ? b : a));
  const top = week.reduce((a, b) => (b.peakScore > a.peakScore ? b : a));
  return { intel: r.body, week, low, top };
}

// The facts a payload hands the model, read back off it.
function payloadFacts(payload) {
  const line = payload.split('\n').find((l) => l.startsWith('{') && l.includes('"facts"'));
  return JSON.parse(line).facts;
}
const idFor = (facts, weekday, part) => facts.find((f) => f.id.startsWith(`typical_peak_${part}`) && facts.some(
  (g) => g.id === f.id.replace(`_${part}`, '_weekday') && g.value === weekday,
)).id;

// The demo's card as the dashboard would serve it, for tests that need no
// route: the six evenings from a Friday, as filmed.
const DEMO_INTEL = {
  available: true,
  scanFrom: 'kind',
  peakWindow: 'evening',
  generatedAt: '2026-11-03T12:00:00Z',
  week: [
    ['2026-11-07', 'Sat', 74, '10 PM'], ['2026-11-08', 'Sun', 45, '8 PM'], ['2026-11-09', 'Mon', 48, '9 PM'],
    ['2026-11-10', 'Tue', 48, '9 PM'], ['2026-11-11', 'Wed', 48, '9 PM'], ['2026-11-12', 'Thu', 64, '10 PM'],
  ].map(([date, weekday, peakScore, peakHour]) => ({ date, weekday, peakScore, peakHour, method: 'rule_engine_no_baseline' })),
};
const demoCard = () => advisorFacts.projectionFacts(DEMO_INTEL, { hourOf: venueDashboardRouter.hourOfLabel });
// That Friday, for a route test that needs the demo's week: 11 AM in New
// York, 16:00 at the venue this file's listing puts on UTC, whose card then
// runs DEMO_INTEL's Saturday to Thursday. The card's week starts tomorrow, so
// on a venue's own Saturday, Sunday or Monday that day is today and not in it.
const DEMO_FRIDAY = Date.parse('2026-11-06T16:00:00Z');

// ── 1. The facts ────────────────────────────────────────────────────────────

test('the card\'s week becomes Roost facts with the card\'s numbers, labelled as Flock\'s forecast for places like this one', async () => {
  setUp({ placeId: 'ChIJforecastFacts000000000' });
  const { intel, week } = await cardWeek();
  // The card says what made each number; a venue with no curve is a category prior.
  assert.ok(week.every((d) => d.method === 'rule_engine_no_baseline'), JSON.stringify(week));
  // A bar with no hours on its listing is read on the evening, its kind's window.
  assert.strictEqual(intel.scanFrom, 'kind');
  assert.strictEqual(intel.peakWindow, 'evening');
  const facts = advisorFacts.projectionFacts(intel);
  assert.strictEqual(facts.length, 6, 'one fact per evening on the card');
  for (const [i, f] of facts.entries()) {
    const d = week[i];
    assert.strictEqual(f.id, `typical_peak_${d.date}`);
    assert.strictEqual(f.source, kindForecast.KIND_FORECAST_SOURCE);
    assert.strictEqual(f.source, 'category_pattern');
    assert.strictEqual(f.asOf, intel.generatedAt);
    assert.strictEqual(f.predictionMethod, 'rule_engine_no_baseline');
    assert.deepStrictEqual(f.value, { date: d.date, weekday: LONG[d.weekday], peakHour: 21, peakScore: d.peakScore });
    assert.strictEqual(f.value.peakScore, CARD[d.weekday], 'the number on the card, unchanged');
    assert.strictEqual(f.label, `${LONG[d.weekday]} projects busiest around 9 PM, at ${d.peakScore} on our 0 to 100 index, in Flock's forecast for places like yours.`);
    // Said once, in the label; the sources line attributes it. No note says
    // it a third time (2026-11-04).
    assert.ok(!('note' in f), JSON.stringify(f));
  }
  // Nothing that reads the venue's own forecast by its peak_ id can take one.
  assert.ok(facts.every((f) => !f.id.startsWith('peak_')));
});

test('each projected day says whose forecast it is once, in its label, with every number: no note repeats it, and a small-hours peak keeps the note naming its night', () => {
  // Saturday's peak at 1 AM, the tail of Saturday night.
  const intel = {
    ...DEMO_INTEL,
    week: DEMO_INTEL.week.map((d, i) => (i === 0 ? { ...d, peakHour: '1 AM', afterMidnight: true } : d)),
    today: { date: '2026-11-06', weekday: 'Fri', peakScore: 66, peakHour: '10 PM', method: 'rule_engine_no_baseline', window: 'evening' },
  };
  const hourOf = venueDashboardRouter.hourOfLabel;
  const facts = [...advisorFacts.projectionFacts(intel, { hourOf }), ...advisorFacts.todayProjectionFacts(intel, { hourOf })];
  assert.strictEqual(facts.length, 7);
  for (const f of facts) {
    const said = `${f.label} ${f.note || ''}`.match(/forecast for places like/gi) || [];
    assert.strictEqual(said.length, 1, JSON.stringify(f));
    assert.match(f.label, new RegExp(`projects busiest around \\d{1,2} [AP]M, at ${f.value.peakScore} on our 0 to 100 index, in Flock's forecast for places like yours\\.$`));
    // The source is what the sources line attributes.
    assert.strictEqual(f.source, 'category_pattern');
  }
  assert.strictEqual(facts[0].label, 'Saturday night projects busiest around 1 AM, at 74 on our 0 to 100 index, in Flock\'s forecast for places like yours.');
  assert.strictEqual(facts[0].note, advisorFacts.afterMidnightNote('Saturday'));
  assert.ok(facts.slice(1).every((f) => !('note' in f)), JSON.stringify(facts.slice(1)));
  // Today's fact: Friday, 10 PM, 66.
  assert.deepStrictEqual(facts[6].value, { date: '2026-11-06', weekday: 'Friday', peakHour: 22, peakScore: 66 });
});

test('a card that is not a week of category priors read on hours the venue keeps is no week at all', async () => {
  setUp({ placeId: 'ChIJforecastNotKind000000' });
  const { intel } = await cardWeek();
  // One model number means the venue has a curve its profile has not caught
  // up with: that week is not "typical for places like yours".
  const oneModelDay = { ...intel, week: intel.week.map((d, i) => (i === 2 ? { ...d, method: 'ml' } : d)) };
  assert.deepStrictEqual(advisorFacts.projectionFacts(oneModelDay), []);
  assert.deepStrictEqual(advisorFacts.projectionFacts({ ...intel, week: intel.week.map(({ method: _m, ...d }) => d) }), [],
    'a week that does not say what made it is not vouched for');
  // The evening drawn for a kind with no window of its own and no hours, and
  // a card from before the card said where its hours came from.
  assert.deepStrictEqual(advisorFacts.projectionFacts({ ...intel, scanFrom: 'default' }), [], 'a kind with no window of its own');
  assert.deepStrictEqual(advisorFacts.projectionFacts({ ...intel, scanFrom: undefined }), [], 'a card that does not say');
  assert.strictEqual(advisorFacts.projectionFacts({ ...intel, scanFrom: 'hours' }).length, 6, 'the venue\'s own listed hours');
  assert.deepStrictEqual(advisorFacts.projectionFacts(null), []);
  assert.deepStrictEqual(advisorFacts.projectionFacts({ available: false, reason: 'x' }), []);
  assert.deepStrictEqual(advisorFacts.projectionFacts({ ...intel, generatedAt: null }), []);
  // A day the card draws as a dash is left out; the rest stand.
  const dashed = advisorFacts.projectionFacts({ ...intel, week: intel.week.map((d, i) => (i === 0 ? { ...d, peakScore: null } : d)) });
  assert.strictEqual(dashed.length, 5);
  // The category table's method is a category prior too.
  const table = advisorFacts.projectionFacts({ ...intel, week: intel.week.map((d) => ({ ...d, method: 'rule_engine_category_table' })) });
  assert.strictEqual(table.length, 6);
});

// ── 2. The answer ───────────────────────────────────────────────────────────

test('the money move names the card\'s quietest and busiest days, from the card\'s own function and cache entry', async (t) => {
  // On the demo's Friday: its quiet Sunday and busy Saturday, pinned below,
  // are both in the week ahead only from a venue's Monday to its Friday, and
  // this failed on the others (2026-11-05).
  const clock = pinClock(DEMO_FRIDAY);
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJforecastMoneyMove0000' });
  const { intel, low, top } = await cardWeek();
  const before = { evenings: eveningCalls, places: placesCalls };

  const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'template');
  const lines = r.body.text.split('\n');
  assert.strictEqual(lines[0], `Fill ${LONG[low.weekday]}. In Flock's forecast for places like yours, it is the quietest day this week, with its peak around 9 PM at ${low.peakScore} on our 0 to 100 index, against ${top.peakScore} on ${LONG[top.weekday]}.`);
  // The demo's card: Sunday is the quiet one at 45, Saturday the busy one at 74.
  assert.strictEqual(low.peakScore, 45);
  assert.strictEqual(top.peakScore, 74);
  // The move names the day it fills: the playbook's "Give your slowest day"
  // under a card's Sunday would call Sunday the venue's own slowest day, and
  // "that day" after "against 74 on Saturday" reads as Saturday.
  const move = roostPlaybook.moveFor('money_move', { facts: advisorFacts.projectionFacts(intel) }, roostPlaybook.venueOf({ profile }));
  assert.strictEqual(move.topic, 'fill_slow_days', 'a week with a quiet day to fill');
  assert.match(move.move, /^Give your slowest day /);
  assert.ok(lines.includes(`• ${move.move.replace(/^Give your slowest day /, `Give ${LONG[low.weekday]} `)}`), r.body.text);
  assert.ok(lines.includes(`• At your $28 a head, every 10 extra covers on ${LONG[low.weekday]} is $280 a week, about $14,560 a year.`), r.body.text);
  assert.ok(!/\byour (?:quietest|busiest|slowest)\b/i.test(r.body.text), 'never "your quietest day" for a forecast that is not the venue\'s own');
  // "What else" still knows the move was shown, so it sets it aside.
  assert.deepStrictEqual(r.body.context.tactics, [move.id]);
  // Its sources: the card's forecast, as of the card's own timestamp.
  const forecastSources = r.body.sources.filter((s) => s.source === 'category_pattern');
  assert.strictEqual(forecastSources.length, 2);
  assert.ok(forecastSources.every((s) => s.asOf === intel.generatedAt));
  assert.deepStrictEqual(forecastSources.map((s) => s.id).sort(), [`typical_peak_${low.date}`, `typical_peak_${top.date}`].sort());
  // The same cache entry: no second lookup and no second forecast run.
  assert.deepStrictEqual({ evenings: eveningCalls, places: placesCalls }, before, 'Roost computed a second estimate');
  // What to ask next follows the day it named.
  assert.ok(r.body.followUps.some((f) => f.kind === 'question' && f.text === `How do I fill ${LONG[low.weekday]}s?`), JSON.stringify(r.body.followUps));
});

test('asked cold, Roost builds the card through the same function, and the card then shows the same numbers', async () => {
  setUp({ placeId: 'ChIJforecastCold000000000' });
  const before = eveningCalls;
  const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'template');
  assert.strictEqual(eveningCalls - before, 6, 'one run of the card, six evenings');
  const { low, top } = await cardWeek();
  assert.strictEqual(eveningCalls - before, 6, 'the card reads the entry Roost just made');
  assert.match(r.body.text, new RegExp(`^Fill ${LONG[low.weekday]}\\. .* at ${low.peakScore} on our 0 to 100 index, against ${top.peakScore} on ${LONG[top.weekday]}\\.`));
});

test('the other week questions answer from the card the same way, and what the card does not carry is as it was', async () => {
  setUp({ placeId: 'ChIJforecastOtherChips000' });
  const { low, top } = await cardWeek();

  const peaks = await call('/api/venue/advisor/ask', { intentId: 'peak_hours' });
  assert.strictEqual(peaks.body.mode, 'template');
  assert.strictEqual(peaks.body.text.split('\n')[0], `In Flock's forecast for places like yours, the busiest day this week is ${LONG[top.weekday]}, with its peak around 9 PM at ${top.peakScore} on our 0 to 100 index.`);

  const quiet = await call('/api/venue/advisor/ask', { intentId: 'quiet_nights' });
  assert.strictEqual(quiet.body.mode, 'template');
  assert.strictEqual(quiet.body.text.split('\n')[0], `In Flock's forecast for places like yours, the quietest day this week is ${LONG[low.weekday]}, with its peak around 9 PM at ${low.peakScore} on our 0 to 100 index.`);
  assert.ok(quiet.body.text.includes(`• Give ${LONG[low.weekday]} one recurring reason to visit`), quiet.body.text);

  for (const r of [peaks, quiet]) {
    assert.ok(!/\byour (?:quietest|busiest|slowest)\b/i.test(r.body.text), r.body.text);
    assert.ok(r.body.sources.length > 0 && r.body.sources.every((s) => s.source === 'category_pattern' || s.source === 'roost_playbook'), JSON.stringify(r.body.sources));
  }

  // Today comes off the same card, read on today's hours (2026-11-04).
  const { intel } = await cardWeek();
  const tonight = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
  assert.strictEqual(tonight.body.mode, 'template', tonight.body.text);
  assert.strictEqual(intel.today.peakScore, CARD[intel.today.weekday], 'today\'s number on the card');
  assert.strictEqual(tonight.body.text, `In Flock's forecast for places like yours, today peaks around 9 PM at ${intel.today.peakScore} on our 0 to 100 index.`);
  // The kitchen line sets the venue's own forecast beside its last orders,
  // never a forecast for places like it: it reads back what the owner told
  // us, as it did before the card was read, and does not read the card.
  const realProjection = advisorFacts.buildWeekProjection;
  let projectionReads = 0;
  advisorFacts.buildWeekProjection = async (...a) => { projectionReads += 1; return realProjection(...a); };
  try {
    const kitchen = await call('/api/venue/advisor/ask', { intentId: 'kitchen_vs_peak' });
    assert.strictEqual(kitchen.body.text, 'You told us the kitchen takes last orders at 9:30 PM.');
    assert.ok(!kitchen.body.sources.some((s) => s.source === 'category_pattern'), JSON.stringify(kitchen.body.sources));
    assert.strictEqual(projectionReads, 0, 'the listing lines read the venue\'s own week only');
  } finally {
    advisorFacts.buildWeekProjection = realProjection;
  }
});

// ── 3. The phrasing input and the check ─────────────────────────────────────

test('the model is handed the card\'s facts with their source and note, and an answer that opens on whose forecast it is is served', async () => {
  setUp({ placeId: 'ChIJforecastPhrased000000', phrasing: true });
  const { low, top } = await cardWeek();
  const quiet = LONG[low.weekday];
  const busy = LONG[top.weekday];
  let payload = null;
  // The live model's own wording for the typed money move (2026-11-03).
  const good = (p) => {
    const f = payloadFacts(p);
    return {
      answer: `Flock's forecast for places like yours has {{fact:${idFor(f, quiet, 'weekday')}}} as the quietest day this week, peaking at {{fact:${idFor(f, quiet, 'score')}}} on our index around {{fact:${idFor(f, quiet, 'hour')}}}.`,
      points: [
        `Give {{fact:${idFor(f, quiet, 'weekday')}}} one recurring reason to visit, such as a weekly game or tasting, and run it every week without skipping.`,
        'A fixed weekly reason builds a habit that fills a room you already pay to staff and light.',
        `For contrast, places like yours peak highest on {{fact:${idFor(f, busy, 'weekday')}}} around {{fact:${idFor(f, busy, 'hour')}}}, reaching {{fact:${idFor(f, busy, 'score')}}}.`,
      ],
    };
  };
  draftFor = (role, p) => { payload = p; return good(p); };
  let r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'phrased', r.body.text);
  assert.strictEqual(r.body.text.split('\n')[0], `Flock's forecast for places like yours has ${quiet} as the quietest day this week, peaking at ${low.peakScore} on our index around 9 PM.`);
  assert.ok(r.body.text.includes(`places like yours peak highest on ${busy} around 9 PM, reaching ${top.peakScore}.`), r.body.text);
  assert.ok(r.body.sources.every((s) => s.source === 'category_pattern'), JSON.stringify(r.body.sources));

  // What the model was given: the two days and their source, which the
  // system prompt reads as Flock's forecast for places like this one (no note
  // says it again since 2026-11-04, the notes say which end of the week a day
  // is), the ids it may write, and the playbook's move naming the quiet day.
  const facts = payloadFacts(payload);
  assert.ok(facts.length >= 6 && facts.every((f) => f.source === 'category_pattern' && f.id.startsWith('typical_peak_')), JSON.stringify(facts));
  assert.ok(facts.every((f) => !/forecast for places like/i.test(f.note || '')), JSON.stringify(facts));
  assert.ok(facts.some((f) => (f.note || '').includes('LOWEST projected day in the week ahead')));
  assert.match(payload, /^PLACEHOLDER IDS\. .*typical_peak_score/m);
  assert.match(payload, new RegExp(`"move":"Give ${quiet} one recurring reason to visit`));
  assert.ok(!/your (?:slowest|quietest) day/i.test(payload.slice(payload.indexOf('PLAYBOOK MOVE'))), payload);
  assert.ok(!/"peak_(?:score|hour|weekday)/.test(payload), 'no id of the venue\'s own forecast');
  for (const prompt of [SYSTEM_PROMPT, ADVICE_SYSTEM_PROMPT]) {
    assert.ok(prompt.includes('A fact whose source is category_pattern is Flock\'s forecast for places like this one'));
    assert.ok(prompt.includes('Open the answer with those words'));
  }

  // A number nothing on the card supports loses its line; the rest stands.
  draftFor = (role, p) => ({ ...good(p), points: [`Expect ${quiet} to sit near 31 on the index again next week.`, 'Give people one fixed reason to come in that day.'] });
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'phrased', r.body.text);
  assert.ok(!r.body.text.includes('31'), r.body.text);
  assert.ok(r.body.text.includes('Give people one fixed reason to come in that day.'), r.body.text);
});

test('a draft built on the card that does not open on whose forecast it is, or says "your" beside a ranking, goes to the template', async () => {
  setUp({ placeId: 'ChIJforecastStrict000000', phrasing: true });
  const { low, top } = await cardWeek();
  const quiet = LONG[low.weekday];
  const busy = LONG[top.weekday];
  const ids = (f) => ({ qd: idFor(f, quiet, 'weekday'), qs: idFor(f, quiet, 'score'), qh: idFor(f, quiet, 'hour'), bd: idFor(f, busy, 'weekday'), bs: idFor(f, busy, 'score') });
  const drafts = [
    // Given as the venue's own, with or without a "like yours" elsewhere.
    (i) => ({ answer: `{{fact:${i.qd}}} is your quietest day this week, at {{fact:${i.qs}}}.`, points: [] }),
    (i) => ({ answer: `{{fact:${i.qd}}} is your quietest day this week, at {{fact:${i.qs}}} against {{fact:${i.bs}}} on {{fact:${i.bd}}}.`, points: ['For a bar like yours, a weekly trivia night is the classic way to fill it.'] }),
    // An opener that is not about the forecast vouches for nothing after it.
    (i) => ({ answer: `For a bar like yours, a weekly trivia night is the classic fill, and {{fact:${i.qd}}} is the quietest night this week, at {{fact:${i.qs}}}.`, points: [] }),
    // The live model's wordings (2026-11-03): attribution first, then "your".
    (i) => ({ answer: `Flock's forecast for places like yours points to {{fact:${i.qd}}} as your quietest night this week, peaking at only {{fact:${i.qs}}} around {{fact:${i.qh}}}.`, points: [] }),
    (i) => ({ answer: `Flock's forecast for places like yours shows {{fact:${i.qd}}} as your quietest day this week.`, points: [] }),
    // "Your" two points after the attribution.
    (i) => ({ answer: `Fill {{fact:${i.qd}}}: Flock's forecast for places like yours has it as the quietest day this week, at {{fact:${i.qs}}}.`, points: [`{{fact:${i.bd}}} is your busiest night, so keep the promo off it.`] }),
    // Every other way of saying "yours" beside a ranking (2026-11-03 review).
    (i) => ({ answer: `Flock's forecast for places like yours has {{fact:${i.qd}}} at {{fact:${i.qs}}}.`, points: [`You are busiest on {{fact:${i.bd}}}.`] }),
    (i) => ({ answer: `Flock's forecast for places like yours has {{fact:${i.qd}}} at {{fact:${i.qs}}}.`, points: ['Your bar is quietest early in the week.'] }),
    (i) => ({ answer: `Flock's forecast for places like yours has {{fact:${i.qd}}} at {{fact:${i.qs}}}.`, points: [`Your room peaks on {{fact:${i.bd}}} at {{fact:${i.bs}}}.`] }),
    (i) => ({ answer: `Flock's forecast for places like yours has {{fact:${i.qd}}} at {{fact:${i.qs}}}.`, points: [`{{fact:${i.qd}}} is the slowest night at your bar.`] }),
    (i) => ({ answer: `Your forecast, like places like yours, has {{fact:${i.qd}}} at {{fact:${i.qs}}}.`, points: [] }),
    // Sentences joined at a placeholder are still read for "your".
    (i) => ({ answer: `This is Flock's forecast for bars like yours. {{fact:${i.qd}}} is your quietest night at {{fact:${i.qs}}}.`, points: [] }),
  ];
  for (const draft of drafts) {
    let shown = null;
    draftFor = (role, p) => { shown = draft(ids(payloadFacts(p))); return shown; };
    const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
    assert.strictEqual(r.body.mode, 'template', `${JSON.stringify(shown)} -> ${r.body.text}`);
    assert.match(r.body.text, /^Fill \w+\. In Flock's forecast for places like yours, it is the quietest day this week/);
  }
});

test('the two rules, read directly', () => {
  const card = [advisorFacts.makeFact({ id: 'typical_peak_score', value: 45, source: 'category_pattern', asOf: '2026-11-03T12:00:00Z' })];
  const own = [advisorFacts.makeFact({ id: 'peak_score', value: 45, source: 'model_holdout', asOf: '2026-11-03T12:00:00Z' })];
  const say = (answer, points = []) => JSON.stringify({ answer, points });
  const why = [];
  const reject = (reason) => { why.push(reason); return null; };
  assert.strictEqual(advisorPhrasing.applyValve(say('Sunday is the quietest day, at {{fact:typical_peak_score}}.'), { facts: card }, { reject }), null);
  assert.strictEqual(advisorPhrasing.applyValve(say('Flock\'s forecast for places like yours has Sunday as your quietest day, at {{fact:typical_peak_score}}.'), { facts: card }, { reject }), null);
  assert.deepStrictEqual(why, [
    'a forecast for places like this one that does not open on whose it is',
    'a forecast for places like this one, given as the venue\'s own',
  ]);
  for (const fine of [
    'Flock\'s forecast for places like yours puts Sunday at {{fact:typical_peak_score}}.',
    'The forecast for bars like yours has Sunday as the quietest night, at {{fact:typical_peak_score}}.',
    'What is typical for places like yours puts Sunday at {{fact:typical_peak_score}}.',
  ]) {
    const out = advisorPhrasing.applyValve(say(fine, ['Stagger your shifts so staff arrive as orders build and leave as the rush eases.']), { facts: card });
    assert.ok(out, fine);
    assert.ok(out.text.includes('45'), out.text);
  }
  // The venue's own forecast needs no such words, and "your" is its own.
  assert.ok(advisorPhrasing.applyValve(say('Sunday is your quietest day, at {{fact:peak_score}}.'), { facts: own }));
  // The readers on their own.
  assert.ok(kindForecast.saysWhose('Flock\'s forecast for places like yours'));
  assert.ok(!kindForecast.saysWhose('For a bar like yours, run a quiz'));
  assert.ok(kindForecast.ownsCard('Flock\'s forecast for places like yours points to Sunday as your quietest night'));
  assert.ok(!kindForecast.ownsCard('For contrast, places like yours peak highest on Saturday'));
  assert.ok(!kindForecast.ownsCard('Stagger your bartending shifts so staff arrive as orders build toward 10 PM'));
});

test('the playbook\'s copy beside the card names the quiet day, and leaves the busy days and the venue\'s own week alone', () => {
  assert.strictEqual(kindForecast.unownDays('Give your slowest day one recurring reason to visit.', 'Sunday'), 'Give Sunday one recurring reason to visit.');
  assert.strictEqual(kindForecast.unownDays('A habit around your quietest day fills seats.', 'Sunday'), 'A habit around Sunday fills seats.');
  assert.strictEqual(kindForecast.unownDays('Set lower minimums on your slow days.', 'Sunday'), 'Set lower minimums on days like Sunday.');
  assert.strictEqual(kindForecast.unownDays('Higher minimums on your busiest nights.', 'Sunday'), 'Higher minimums on your busiest nights.');
  assert.strictEqual(kindForecast.unownDays('Give your slowest day one recurring reason to visit.', null), 'Give your slowest day one recurring reason to visit.');
  assert.strictEqual(kindForecast.cardQuietDay(demoCard()), 'Sunday');
  assert.strictEqual(kindForecast.cardQuietDay([advisorFacts.makeFact({ id: 'peak_x', value: { weekday: 'Sunday', peakScore: 4 }, source: 'model_holdout', asOf: 'x' })]), null);
});

// ── 4. Advice ───────────────────────────────────────────────────────────────

test('the advice model is never handed the card; its answer reads as it did, and the playbook\'s leads with the card, framed', async (t) => {
  // On the demo's Friday: a named day's lead reads the week ahead, and on a
  // venue's own Monday the week ahead holds no Monday, so this failed there
  // (2026-11-05).
  const clock = pinClock(DEMO_FRIDAY);
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJforecastAdvice000000', phrasing: true });
  await cardWeek();
  route = { mode: 'advice', intentId: 'quiet_nights' };
  let advicePayload = null;
  draftFor = (role, p) => {
    advicePayload = p;
    return { answer: 'Skip blanket discounts and give people a fixed reason to show up every Monday, like a weekly industry night.', points: ['Run it for 6 weeks without skipping so people build a habit around it.'] };
  };
  let r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Monday?' });
  assert.strictEqual(r.body.mode, 'advice', r.body.text);
  assert.ok(advicePayload, 'the advice model was asked');
  assert.ok(!/category_pattern|typical_peak_/.test(advicePayload), 'the card reached the advice model');
  assert.strictEqual(r.body.text, 'Skip blanket discounts and give people a fixed reason to show up every Monday, like a weekly industry night.\n• Run it for 6 weeks without skipping so people build a habit around it.');
  assert.ok(!r.body.sources.some((s) => s.source === 'category_pattern'), JSON.stringify(r.body.sources));

  // The model out: the playbook answers, leading with the card in its own
  // framed words and naming the day in its move.
  draftFor = () => null;
  r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Monday?' });
  assert.strictEqual(r.body.mode, 'advice', r.body.text);
  assert.ok(r.body.sources.some((s) => s.source === 'roost_playbook') && r.body.sources.some((s) => s.source === 'category_pattern'), JSON.stringify(r.body.sources));
  assert.match(r.body.text, /^In Flock's forecast for places like yours, Monday projects /);
  assert.ok(!/\byour (?:slowest|quietest) day\b/i.test(r.body.text), r.body.text);
});

test('the playbook answer under a card day names that day in its move, and the venue\'s own week keeps the playbook\'s words', () => {
  const ctx = { profile: { service_style: 'bar_standing', typical_spend_per_person: 28 } };
  const card = demoCard();
  const out = roostPlaybook.answer({ question: 'How do I fill a slow Sunday?', intentId: 'quiet_nights', ctx, groundedFacts: card });
  assert.match(out.text, /^In Flock's forecast for places like yours, Sunday projects as the quietest day this week\. Give Sunday one recurring reason to visit/);
  assert.ok(!/\byour (?:slowest|quietest) day\b/i.test(out.text), out.text);
  const own = card.map((f) => ({ ...f, id: f.id.replace('typical_', ''), source: 'model_holdout' }));
  const mine = roostPlaybook.answer({ question: 'How do I fill a slow Sunday?', intentId: 'quiet_nights', ctx, groundedFacts: own });
  assert.match(mine.text, /^Sunday projects as your quietest day this week\. Give your slowest day one recurring reason to visit/);
  // The lead for the other questions.
  assert.strictEqual(roostPlaybook.groundedLead('money_move', card).text, 'In Flock\'s forecast for places like yours, Sunday projects as the quietest day this week.');
  assert.strictEqual(roostPlaybook.groundedLead('peak_hours', card).text, 'In Flock\'s forecast for places like yours, Saturday projects as the busiest day this week.');
});

test('typed, the money move routes to the card and is answered the same way', async () => {
  setUp({ placeId: 'ChIJforecastTyped00000000', phrasing: true });
  const { low } = await cardWeek();
  route = { mode: 'grounded', intentId: 'money_move' };
  draftFor = () => null; // the phrasing call fails: the template answers
  const r = await call('/api/venue/advisor/question', { question: 'What is our best money move this week?' });
  assert.strictEqual(r.body.intentId, 'money_move');
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.match(r.body.text, new RegExp(`^Fill ${LONG[low.weekday]}\\. In Flock's forecast for places like yours, it is the quietest day this week`));
});

// ── 5. No history and no card ───────────────────────────────────────────────

test('with no crowd history and no card to read, the refusal stands word for word', async () => {
  const refusal = (p) => {
    const gate = advisorFacts.corpusGate(p);
    return `We can't answer that yet. ${gate.reason} ${gate.whatWouldUnlock}`;
  };
  // The listing could not be read, so there is no card. Phrasing is on, and
  // a refusal still never reaches the model.
  setUp({ placeId: 'ChIJforecastNoCard0000000', phrasing: true });
  placesUp = false;
  draftFor = () => ({ answer: 'Fill Sunday.', points: [] });
  let r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'refusal');
  assert.strictEqual(r.body.text, refusal(profile));
  assert.match(r.body.text, /^We can't answer that yet\. We have no crowd history for this venue\./);
  assert.deepStrictEqual(r.body.sources, []);
  // Today has nothing to read either, and refuses as it always did: the
  // corpus gate first, then the street it cannot look up.
  r = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
  assert.strictEqual(r.body.mode, 'refusal');
  assert.ok(r.body.text.startsWith(refusal(profile)), r.body.text);
  assert.deepStrictEqual(modelCalls, [], 'a refusal cost a model call');

  // A card with a model number on it is not Flock's forecast for places like
  // yours, so it is not read as one.
  setUp({ placeId: 'ChIJforecastModelCard0000' });
  method = 'ml';
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'refusal');
  assert.strictEqual(r.body.text, refusal(profile));

  // An unverified claim never reaches the card.
  setUp({ placeId: 'ChIJforecastUnverified000', extra: { verified: false } });
  const calls = placesCalls;
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'refusal');
  assert.strictEqual(placesCalls, calls, 'an unverified claim spent a Places lookup');
  assert.deepStrictEqual(await advisorFacts.buildWeekProjection({ profile }, { userId: 1 }), []);
});

// ── 6. A venue with its own crowd history ───────────────────────────────────

test('a venue with its own crowd history never reads the card: its week is its own forecast, as before', async () => {
  setUp({ placeId: 'ChIJforecastCorpus0000000', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 } });
  const own = [
    advisorFacts.makeFact({ id: 'peak_2026-11-03', value: { date: '2026-11-03', weekday: 'Tuesday', peakHour: 18, peakScore: 38 }, source: 'model_holdout', asOf: '2026-11-03T12:00:00Z', unit: '0-100 index' }),
    advisorFacts.makeFact({ id: 'peak_2026-11-07', value: { date: '2026-11-07', weekday: 'Saturday', peakHour: 20, peakScore: 88 }, source: 'model_holdout', asOf: '2026-11-03T12:00:00Z', unit: '0-100 index' }),
  ];
  const realWeek = advisorFacts.buildWeekAhead;
  const realProjection = advisorFacts.buildWeekProjection;
  let projectionReads = 0;
  advisorFacts.buildWeekAhead = async () => own;
  advisorFacts.buildWeekProjection = async (...a) => { projectionReads += 1; return realProjection(...a); };
  try {
    const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
    assert.strictEqual(r.body.mode, 'template');
    const lines = r.body.text.split('\n');
    assert.strictEqual(lines[0], 'Fill Tuesday. It is your quietest day this week, with its peak around 6 PM at 38 on our 0 to 100 index, against 88 on Saturday.');
    // The playbook's own words for the venue's own week.
    assert.ok(lines.some((l) => l.startsWith('• Give your slowest day one recurring reason to visit')), r.body.text);
    assert.strictEqual(projectionReads, 0);
  } finally {
    advisorFacts.buildWeekAhead = realWeek;
    advisorFacts.buildWeekProjection = realProjection;
  }
});

// ── 7. The review's other findings (2026-11-03) ─────────────────────────────

test('a level week on the card says whose week it is and what would give the venue one of its own', async () => {
  setUp({ placeId: 'ChIJforecastLevelCard0000' });
  const saved = { ...CARD };
  Object.assign(CARD, { Sat: 52, Sun: 45, Mon: 48, Tue: 48, Wed: 48, Thu: 50, Fri: 51 });
  try {
    const r = await call('/api/venue/advisor/ask', { intentId: 'quiet_nights' });
    assert.strictEqual(r.body.mode, 'refusal');
    const gate = advisorFacts.corpusGate(profile);
    assert.match(r.body.text, /^We can't answer that yet\. In Flock's forecast for places like yours, no day stands out as quiet in the week ahead: every day projects within \d+ points of every other on our 0 to 100 index/);
    assert.ok(r.body.text.endsWith(gate.whatWouldUnlock), r.body.text);
    assert.ok(!/The moment one does/.test(r.body.text));
  } finally {
    Object.assign(CARD, saved);
  }
});

test('a cafe\'s card is read by day now, and Roost answers from its mornings; a kind with no window of its own keeps the refusal', async () => {
  // Until 2026-11-04 a cafe's card was its evenings, hours it may be shut,
  // and Roost refused it. The card now reads a cafe by day.
  setUp({ placeId: 'ChIJforecastCafe00000000', extra: { service_style: 'counter_order', typical_spend_per_person: 11 } });
  placeTypes = ['cafe', 'food'];
  const { intel, low, top } = await cardWeek();
  assert.strictEqual(intel.scanFrom, 'kind');
  assert.strictEqual(intel.peakWindow, 'day');
  assert.ok(intel.week.every((d) => d.peakHour === '8 AM'), JSON.stringify(intel.week));
  const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.strictEqual(r.body.text.split('\n')[0], `Fill ${LONG[low.weekday]}. In Flock's forecast for places like yours, it is the quietest day this week, with its peak around 8 AM at ${low.peakScore} on our 0 to 100 index, against ${top.peakScore} on ${LONG[top.weekday]}.`);
  assert.ok(!/\byour (?:quietest|busiest|slowest)\b/i.test(r.body.text), r.body.text);
  // A bar's, a club's and a restaurant's evenings are their week, as before.
  for (const [i, types] of [['bar'], ['night_club'], ['italian_restaurant', 'restaurant']].entries()) {
    setUp({ placeId: `ChIJforecastKind${i}0000000` });
    placeTypes = types;
    const card = await cardWeek();
    assert.strictEqual(card.intel.scanFrom, 'kind', types.join(','));
    assert.strictEqual(card.intel.peakWindow, 'evening', types.join(','));
  }
  // A kind with no window of its own and no hours listed is drawn on the
  // evening, as the card always was, and that is not its week.
  setUp({ placeId: 'ChIJforecastGym000000000' });
  placeTypes = ['gym'];
  placePrimary = 'gym';
  const gym = await cardWeek();
  assert.strictEqual(gym.intel.scanFrom, 'default');
  const g = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(g.body.mode, 'refusal');
  assert.match(g.body.text, /^We can't answer that yet\. We have no crowd history for this venue\./);
});

test('on a tie the money move names the busiest day the Biggest Night tile names', async () => {
  setUp({ placeId: 'ChIJforecastTie000000000' });
  const saved = { ...CARD };
  Object.assign(CARD, { Thu: 74, Fri: 74, Sat: 74 });
  try {
    const { top } = await cardWeek(); // the tile's own reduce: the first busiest day
    const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
    assert.match(r.body.text.split('\n')[0], new RegExp(`against 74 on ${LONG[top.weekday]}\\.$`), r.body.text);
  } finally {
    Object.assign(CARD, saved);
  }
});

test('a lookup that failed is not paid for again in the same question', async () => {
  setUp({ placeId: 'ChIJforecastPaidOnce00000', phrasing: true });
  placesUp = false;
  route = { mode: 'advice', intentId: 'quiet_nights' };
  draftFor = () => ({ answer: 'Give people one fixed reason to come in on Mondays.', points: [] });
  const before = placesCalls;
  const r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Monday?' });
  assert.strictEqual(r.body.mode, 'advice', r.body.text);
  assert.strictEqual(placesCalls - before, 1, 'the named day read the failed card a second time');
});

// ── 8. Roost's own card and chips (2026-11-03, second pass) ─────────────────
//
// The same gap in two more places: Roost's own Week ahead card refused under
// the dashboard card's numbers, and the four week chips were never offered to
// a venue with no crowd history, though their answers now come from that card.

const cardById = (body, id) => (body.cards || []).find((c) => c.id === id);
const offeredIds = (body) => [
  ...(body.lead || []).map((q) => q.id),
  ...(body.groups || []).flatMap((g) => g.questions.map((q) => q.id)),
];
// The four week chips and today's (2026-11-04), all answered off the card.
const WEEK_CHIPS = ['money_move', 'tonight_outlook', 'peak_hours', 'quiet_nights', 'weekend_outlook'];

test('Roost\'s own Week ahead card shows the dashboard\'s Week Ahead for a no-history bar, framed, from the same build', async () => {
  setUp({ placeId: 'ChIJforecastCardsBar00000' });
  const { intel, week } = await cardWeek();
  const before = { evenings: eveningCalls, places: placesCalls };
  const r = await call('/api/venue/advisor/cards');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const card = cardById(r.body, 'week_ahead');
  assert.strictEqual(card.status, 'ok', JSON.stringify(card));
  assert.deepStrictEqual(card.facts.map((f) => f.id), week.map((d) => `typical_peak_${d.date}`));
  for (const [i, f] of card.facts.entries()) {
    assert.strictEqual(f.source, 'category_pattern');
    assert.strictEqual(f.value.date, week[i].date, 'the client files each fact under its day');
    assert.strictEqual(f.value.peakScore, week[i].peakScore, 'the dashboard card\'s own number');
    assert.match(f.label, /in Flock's forecast for places like yours\.$/);
    // Said once per day, in its label, with the source attributing it; no
    // note repeats it.
    assert.ok(!('note' in f), JSON.stringify(f));
    assert.strictEqual(f.asOf, intel.generatedAt);
  }
  assert.deepStrictEqual({ evenings: eveningCalls, places: placesCalls }, before, 'the card was built a second time');
  // The listing card sets the owner's answers beside the venue's OWN week, and
  // there is none, so it is as it was.
  const listing = cardById(r.body, 'listing_read_back');
  assert.ok(!listing.facts.some((f) => f.source === 'category_pattern'), JSON.stringify(listing.facts));
});

test('a Week ahead card with no card to read, or one not read on hours the venue keeps, keeps the refusal', async () => {
  const cases = [
    ['ChIJforecastCardsGym00000', () => { placeTypes = ['gym']; placePrimary = 'gym'; }],
    ['ChIJforecastCardsDown0000', () => { placesUp = false; }],
    ['ChIJforecastCardsModel000', () => { method = 'ml'; }],
  ];
  for (const [placeId, arrange] of cases) {
    setUp({ placeId });
    arrange();
    const r = await call('/api/venue/advisor/cards');
    const card = cardById(r.body, 'week_ahead');
    assert.strictEqual(card.status, 'refused', `${placeId}: ${JSON.stringify(card)}`);
    assert.strictEqual(card.facts.length, 1, placeId);
    assert.match(card.facts[0].reason, /no crowd history/i, placeId);
    assert.ok(!card.facts.some((f) => f.source === 'category_pattern'), placeId);
  }
});

test('the week chips are offered to a no-history venue exactly when the card answers them', async () => {
  // A card with a quiet day on it: all four, and each one then answers from it.
  setUp({ placeId: 'ChIJforecastChipsCard0000' });
  let r = await call('/api/venue/advisor/questions');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  let offered = offeredIds(r.body);
  for (const id of WEEK_CHIPS) assert.ok(offered.includes(id), `${id} not offered: ${offered.join(', ')}`);
  assert.ok(!offered.includes('cohort_typical'), 'the city comparison needs a curve the card does not have');
  for (const id of WEEK_CHIPS) {
    const a = await call('/api/venue/advisor/ask', { intentId: id });
    assert.notStrictEqual(a.body.mode, 'refusal', `${id}: ${a.body.text}`);
    assert.ok(a.body.sources.some((s) => s.source === 'category_pattern'), `${id}: ${JSON.stringify(a.body.sources)}`);
  }

  // A level week: the quiet-days plan refuses a week with no quiet day, so
  // that chip goes, and the other three stay.
  const saved = { ...CARD };
  Object.assign(CARD, { Sat: 52, Sun: 45, Mon: 48, Tue: 48, Wed: 48, Thu: 50, Fri: 51 });
  try {
    setUp({ placeId: 'ChIJforecastChipsLevel000' });
    r = await call('/api/venue/advisor/questions');
    offered = offeredIds(r.body);
    assert.ok(!offered.includes('quiet_nights'), offered.join(', '));
    for (const id of ['money_move', 'peak_hours', 'weekend_outlook']) {
      assert.ok(offered.includes(id), `${id}: ${offered.join(', ')}`);
      const a = await call('/api/venue/advisor/ask', { intentId: id });
      assert.notStrictEqual(a.body.mode, 'refusal', `${id} was offered on a level week and refused: ${a.body.text}`);
    }
    const q = await call('/api/venue/advisor/ask', { intentId: 'quiet_nights' });
    assert.strictEqual(q.body.mode, 'refusal', 'the chip that was held back would have refused');
  } finally {
    Object.assign(CARD, saved);
  }

  // No card, for any of its reasons: none of the five, and each would refuse.
  const cases = [
    ['ChIJforecastChipsDown0000', () => { placesUp = false; }],
    ['ChIJforecastChipsGym00000', () => { placeTypes = ['gym']; placePrimary = 'gym'; }],
    ['ChIJforecastChipsModel000', () => { method = 'ml'; }],
  ];
  for (const [placeId, arrange] of cases) {
    setUp({ placeId });
    arrange();
    r = await call('/api/venue/advisor/questions');
    offered = offeredIds(r.body);
    for (const id of WEEK_CHIPS) assert.ok(!offered.includes(id), `${placeId}: ${id} offered with no card`);
    for (const id of WEEK_CHIPS) {
      const a = await call('/api/venue/advisor/ask', { intentId: id });
      assert.strictEqual(a.body.mode, 'refusal', `${placeId}: ${id} answered: ${a.body.text}`);
    }
  }
});

test('a corpus venue\'s chips are as they were, and never read the card', async () => {
  setUp({ placeId: 'ChIJforecastChipsCorpus00', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 } });
  const realProjection = advisorFacts.buildWeekProjection;
  let projectionReads = 0;
  advisorFacts.buildWeekProjection = async (...a) => { projectionReads += 1; return realProjection(...a); };
  try {
    const r = await call('/api/venue/advisor/questions');
    const offered = offeredIds(r.body);
    for (const id of [...WEEK_CHIPS, 'tonight_outlook']) assert.ok(offered.includes(id), `${id}: ${offered.join(', ')}`);
    assert.strictEqual(projectionReads, 0);
  } finally {
    advisorFacts.buildWeekProjection = realProjection;
  }
});

test('the dashboard, Roost\'s card and Roost\'s chips opening together build the card once', async () => {
  setUp({ placeId: 'ChIJforecastTogether00000' });
  // Google takes a moment, so all three arrive while the first build waits.
  placesDelayMs = 150;
  const before = { evenings: eveningCalls, places: placesCalls };
  const [intel, cards, questions] = await Promise.all([
    call('/api/venue-dashboard/intelligence'),
    call('/api/venue/advisor/cards'),
    call('/api/venue/advisor/questions'),
  ]);
  assert.strictEqual(intel.body.available, true, JSON.stringify(intel.body));
  assert.strictEqual(cardById(cards.body, 'week_ahead').status, 'ok');
  assert.ok(offeredIds(questions.body).includes('money_move'));
  assert.strictEqual(placesCalls - before.places, 1, 'one Places lookup for the three');
  assert.strictEqual(eveningCalls - before.evenings, 6, 'one run of the six evenings for the three');

  // A lookup that fails is shared the same way, each reader answers it as its
  // own, and it is not kept: the next ask tries again, as before.
  setUp({ placeId: 'ChIJforecastTogetherDown0' });
  placesUp = false;
  placesDelayMs = 150;
  const calls = placesCalls;
  const [downIntel, downCards] = await Promise.all([
    call('/api/venue-dashboard/intelligence'),
    call('/api/venue/advisor/cards'),
  ]);
  assert.strictEqual(placesCalls - calls, 1, 'the two shared the lookup that failed');
  assert.strictEqual(downIntel.body.code, 'lookup_failed', JSON.stringify(downIntel.body));
  assert.strictEqual(cardById(downCards.body, 'week_ahead').status, 'refused');
  await call('/api/venue-dashboard/intelligence');
  assert.strictEqual(placesCalls - calls, 2, 'a failed lookup was kept as the answer');
});

// ── 9. Any kind the card reads on its hours, and today (2026-11-04) ─────────
//
// The card read every venue on the evening, so a cafe or a bakery was refused.
// It now reads each day on the venue's own listed hours, or the window for its
// kind (routes/venueDashboard.js dayScanHours), and Roost answers any venue
// read that way, under the same rules as a bar. "How does today look?" is
// answered off the card's today, which the card's own function reads on
// today's hours although its week starts tomorrow.

// Google's periods: one window per listed weekday (0 is Sunday).
const periodsOf = (byDay) => Object.entries(byDay).map(([day, [open, close]]) => ({
  open: { day: Number(day), hour: open, minute: 0 }, close: { day: Number(day), hour: close, minute: 0 },
}));
const NO_YOUR_RANKING = /\byour (?:quietest|busiest|slowest)\b/i;

test('a no-history bakery with hours on its listing answers every week chip from them, framed, and a day it is shut is never its quiet day', async () => {
  setUp({ placeId: 'ChIJforecastBakeryHours00', extra: { service_style: 'counter_order', typical_spend_per_person: 9 } });
  placeTypes = ['bakery', 'food', 'store'];
  placePrimary = 'bakery';
  // 6 AM to 2 PM, and closed on Sundays, the card's quietest day (on Mondays
  // when today is a Sunday, so the closed day is always in the week ahead).
  const shut = new Date().getUTCDay() === 0 ? 1 : 0;
  placePeriods = periodsOf(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== shut).map((d) => [d, [6, 14]])));
  const { intel, week } = await cardWeek();
  assert.strictEqual(intel.scanFrom, 'hours');
  const open = week.filter((d) => !d.closed);
  assert.ok(week.some((d) => d.weekday === SHORT[shut] && d.closed), JSON.stringify(week));
  assert.ok(open.every((d) => d.peakHour === '8 AM'), JSON.stringify(open));
  const low = open.reduce((a, b) => (b.peakScore < a.peakScore ? b : a));
  const top = open.reduce((a, b) => (b.peakScore > a.peakScore ? b : a));

  const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.strictEqual(r.body.text.split('\n')[0], `Fill ${LONG[low.weekday]}. In Flock's forecast for places like yours, it is the quietest day this week, with its peak around 8 AM at ${low.peakScore} on our 0 to 100 index, against ${top.peakScore} on ${LONG[top.weekday]}.`);
  assert.ok(!r.body.text.includes(LONG[SHORT[shut]]), 'a day the listing has it closed was named');

  // Every week chip and today's is offered, and each answers off the card, framed.
  const q = await call('/api/venue/advisor/questions');
  const offered = offeredIds(q.body);
  for (const id of WEEK_CHIPS) {
    assert.ok(offered.includes(id), `${id}: ${offered.join(', ')}`);
    const a = await call('/api/venue/advisor/ask', { intentId: id });
    assert.notStrictEqual(a.body.mode, 'refusal', `${id}: ${a.body.text}`);
    assert.match(a.body.text, /^(?:Fill \w+\. )?In Flock's forecast for places like yours, /, `${id}: ${a.body.text}`);
    // The card's reading never says "your"; beside it the playbook's quiet-day
    // words name the day, and its busy-hour words are about the owner's own
    // room and stay (services/kindForecast.js unownDays).
    assert.ok(!NO_YOUR_RANKING.test(a.body.text.split('\n')[0]), `${id}: ${a.body.text}`);
    assert.ok(!/\byour (?:quietest|slowest)\b/i.test(a.body.text), `${id}: ${a.body.text}`);
    assert.ok(a.body.sources.some((s) => s.source === 'category_pattern'), `${id}: ${JSON.stringify(a.body.sources)}`);
  }
  // Roost's own Week ahead card shows the five open days.
  const cards = await call('/api/venue/advisor/cards');
  const card = cardById(cards.body, 'week_ahead');
  assert.strictEqual(card.status, 'ok', JSON.stringify(card));
  assert.deepStrictEqual(card.facts.map((f) => f.value.date), open.map((d) => d.date));
});

test('"How does today look?" answers off the card\'s today for a no-history bar and a cafe, framed, from the same cache entry', async () => {
  for (const [placeId, arrange, hour] of [
    ['ChIJforecastTodayBar00000', () => {}, '9 PM'],
    ['ChIJforecastTodayCafe0000', () => { placeTypes = ['cafe', 'food']; placePrimary = 'cafe'; }, '8 AM'],
  ]) {
    setUp({ placeId });
    arrange();
    const { intel } = await cardWeek();
    assert.strictEqual(intel.today.peakHour, hour, placeId);
    const before = { evenings: eveningCalls, places: placesCalls };
    const r = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
    assert.strictEqual(r.body.mode, 'template', r.body.text);
    assert.strictEqual(r.body.text, `In Flock's forecast for places like yours, today peaks around ${hour} at ${intel.today.peakScore} on our 0 to 100 index.`);
    assert.deepStrictEqual(r.body.sources.map((s) => [s.id, s.source, s.asOf]), [[`typical_peak_${intel.today.date}`, 'category_pattern', intel.generatedAt]]);
    assert.deepStrictEqual({ evenings: eveningCalls, places: placesCalls }, before, 'Roost computed a second estimate');
    // The chip is offered, and what to ask next is the week's peaks.
    assert.ok(offeredIds((await call('/api/venue/advisor/questions')).body).includes('tonight_outlook'), placeId);
    assert.ok(r.body.followUps.some((f) => f.kind === 'question' && f.text === 'How should I staff today?'), JSON.stringify(r.body.followUps));
  }
});

test('today phrased: the model is handed today\'s fact with its source, and a draft that gives it as the venue\'s own goes to the template', async () => {
  setUp({ placeId: 'ChIJforecastTodayPhrased0', phrasing: true });
  const { intel } = await cardWeek();
  const day = LONG[intel.today.weekday];
  let payload = null;
  const ids = (p) => {
    const f = payloadFacts(p);
    return { s: idFor(f, day, 'score'), h: idFor(f, day, 'hour') };
  };
  draftFor = (role, p) => {
    payload = p;
    const i = ids(p);
    return { answer: `Flock's forecast for places like yours has today peaking around {{fact:${i.h}}} at {{fact:${i.s}}} on our index.`, points: ['Have your second bartender on before the rush builds.'] };
  };
  let r = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
  assert.strictEqual(r.body.mode, 'phrased', r.body.text);
  assert.strictEqual(r.body.text.split('\n')[0], `Flock's forecast for places like yours has today peaking around 9 PM at ${intel.today.peakScore} on our index.`);
  const facts = payloadFacts(payload);
  assert.ok(facts.length > 0 && facts.every((f) => f.source === 'category_pattern' && f.id.startsWith('typical_peak_')), JSON.stringify(facts));

  for (const bad of [
    (i) => ({ answer: `Today looks quiet for you, peaking at {{fact:${i.s}}} around {{fact:${i.h}}}.`, points: [] }),
    (i) => ({ answer: `Flock's forecast for places like yours has today as your busiest stretch, at {{fact:${i.s}}}.`, points: [] }),
    (i) => ({ answer: `Flock's forecast for places like yours puts today at {{fact:${i.s}}}.`, points: [`You are busiest around {{fact:${i.h}}}.`] }),
  ]) {
    let shown = null;
    draftFor = (role, p) => { shown = bad(ids(p)); return shown; };
    r = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
    assert.strictEqual(r.body.mode, 'template', `${JSON.stringify(shown)} -> ${r.body.text}`);
    assert.match(r.body.text, /^In Flock's forecast for places like yours, today peaks around 9 PM at \d+ on our 0 to 100 index\.$/);
  }
});

test('today with nothing to read keeps the refusal: closed today by its listing, or a model number on the card', async () => {
  const gateText = (p) => {
    const gate = advisorFacts.corpusGate(p);
    return `We can't answer that yet. ${gate.reason} ${gate.whatWouldUnlock}`;
  };
  // Closed today by its listed hours, open every other day: today refuses,
  // and the week still answers.
  setUp({ placeId: 'ChIJforecastTodayClosed00' });
  const todayDow = new Date().getUTCDay();
  placePeriods = periodsOf(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== todayDow).map((d) => [d, [16, 23]])));
  const { intel } = await cardWeek();
  assert.strictEqual(intel.today.closed, true, JSON.stringify(intel.today));
  let r = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
  assert.strictEqual(r.body.mode, 'refusal', r.body.text);
  assert.ok(r.body.text.startsWith(gateText(profile)), r.body.text);
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.notStrictEqual(r.body.mode, 'refusal', r.body.text);
  const offered = offeredIds((await call('/api/venue/advisor/questions')).body);
  assert.ok(!offered.includes('tonight_outlook'), 'a today chip that would refuse');
  assert.ok(offered.includes('money_move'), offered.join(', '));

  // One model number on the card: the venue has a curve its profile has not
  // caught up with, so neither the week nor today is read as places like it.
  setUp({ placeId: 'ChIJforecastTodayModelA00' });
  const { week } = await cardWeek();
  setUp({ placeId: 'ChIJforecastTodayModelB00' });
  modelOnDate = week[0].date;
  for (const id of ['tonight_outlook', 'money_move']) {
    r = await call('/api/venue/advisor/ask', { intentId: id });
    assert.strictEqual(r.body.mode, 'refusal', `${id}: ${r.body.text}`);
    assert.ok(r.body.text.startsWith(gateText(profile)), r.body.text);
  }
});

test('typed, "how does today look" is answered off the card the same way, and the advice model is never handed today\'s fact', async () => {
  setUp({ placeId: 'ChIJforecastTodayTyped000', phrasing: true });
  const { intel } = await cardWeek();
  route = { mode: 'grounded', intentId: 'tonight_outlook' };
  draftFor = () => null; // the phrasing call fails: the template answers
  let r = await call('/api/venue/advisor/question', { question: 'how does today look' });
  assert.strictEqual(r.body.intentId, 'tonight_outlook');
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.strictEqual(r.body.text, `In Flock's forecast for places like yours, today peaks around 9 PM at ${intel.today.peakScore} on our 0 to 100 index.`);

  route = { mode: 'advice', intentId: 'tonight_outlook' };
  let advicePayload = null;
  draftFor = (role, p) => {
    advicePayload = p;
    return { answer: 'Put your strongest bartender on the well from the first hour, and stagger the second shift to arrive as it fills.', points: [] };
  };
  r = await call('/api/venue/advisor/question', { question: 'how should I staff tonight' });
  assert.strictEqual(r.body.mode, 'advice', r.body.text);
  assert.ok(advicePayload, 'the advice model was asked');
  assert.ok(!/category_pattern|typical_peak_/.test(advicePayload), 'today\'s fact reached the advice model');
});

// ── 10. Any day of the week, and the turn of the UTC day (2026-11-05) ──────
//
// The bakery test above was added on Wednesday 2026-11-04 and failed at 8:10
// PM on Thursday 2026-11-05 in New York, 01:10 on Friday in UTC, the clock of
// the venue this file's listing puts on UTC. The venue's day was read right:
// it was Friday there. The card's week starts tomorrow, so on a venue's
// Friday or Saturday the weekend in it holds one open day for a venue shut on
// Sundays, and one day is no week to rank: the weekend shaper stepped aside
// and the twin led with that day's own label, which names whose forecast it
// is last (advisorPhrasing shapeWeek). Pinned here: every template over every
// set of the card's days, and the week chips on every day of a week, at the
// turn of the UTC day and at midday, for a venue on UTC and one in New York,
// so the day and the hour the suite runs at cannot decide whether they pass.

const FRAMED = /^(?:Fill [A-Z][a-z]+(?: night)?\. )?In Flock's forecast for places like yours, /;

test('a template built on the card opens on whose forecast it is whatever days it holds: one day, part of a week, a named day, or an intent with no shaper', () => {
  const card = demoCard();
  let renders = 0;
  // Every set of the card's six days a plan could hand over, under each week
  // chip and an intent with no shaper of its own, asked plainly and about
  // each weekday by name.
  for (let mask = 1; mask < 1 << card.length; mask += 1) {
    const facts = card.filter((_, i) => mask & (1 << i));
    for (const intent of [...WEEK_CHIPS, 'around_you']) {
      for (const day of [null, ...Object.values(LONG)]) {
        const question = day ? `How busy will ${day} be?` : 'What does the weekend look like?';
        const first = advisorPhrasing.renderTemplate({ intent, facts }, question).text.split('\n')[0];
        const where = `${intent} over ${facts.map((f) => f.value.weekday).join(', ')}, asked "${question}"`;
        assert.match(first, FRAMED, `${where}: ${first}`);
        assert.ok(!NO_YOUR_RANKING.test(first), `${where}: ${first}`);
        renders += 1;
      }
    }
  }
  assert.strictEqual(renders, 63 * 6 * 8);
  // The answer that failed: a venue shut on Sundays, asked about the weekend
  // on its Friday, has Saturday alone. It read "Saturday projects busiest
  // around 10 PM, at 74 on our 0 to 100 index, in Flock's forecast for places
  // like yours." until 2026-11-05.
  const saturday = card.filter((f) => f.value.weekday === 'Saturday');
  assert.strictEqual(advisorPhrasing.renderTemplate({ intent: 'weekend_outlook', facts: saturday }).text,
    'In Flock\'s forecast for places like yours, Saturday peaks around 10 PM at 74 on our 0 to 100 index.');
  // A lone day of the venue's own forecast reads its own label, as it did.
  const own = advisorFacts.makeFact({
    id: 'peak_2026-11-07',
    value: { date: '2026-11-07', weekday: 'Saturday', peakHour: 22, peakScore: 74 },
    source: 'model_holdout',
    asOf: '2026-11-03T12:00:00Z',
    unit: '0-100 index',
    label: advisorFacts.weekAheadPeakLabel({ weekday: 'Saturday', hour: 22, score: 74 }),
  });
  for (const intent of ['weekend_outlook', 'peak_hours']) {
    assert.strictEqual(advisorPhrasing.renderTemplate({ intent, facts: [own] }).text,
      'Saturday projects busiest around 10 PM, at 74 on our 0 to 100 index.');
  }
});

// The bakery of the test above, open 6 AM to 2 PM and shut on `shut` (0 is
// Sunday), on a listing whose clock is `zone` (else UTC).
function bakeryAt({ placeId, zone = null, offset = 0, shut = 0 }) {
  setUp({ placeId, extra: { service_style: 'counter_order', typical_spend_per_person: 9 } });
  placeTypes = ['bakery', 'food', 'store'];
  placePrimary = 'bakery';
  placeZone = zone;
  placeOffset = offset;
  placePeriods = periodsOf(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== shut).map((d) => [d, [6, 14]])));
}

// The global clock pinned at `iso` while `fn` runs (helpers/pinnedClock.js),
// then the real one back. Every venue under a pin has a place id of its own,
// so no cache entry made at one instant is read at another.
async function pinnedAt(iso, fn) {
  const clock = pinClock(Date.parse(iso));
  try {
    return await fn();
  } finally {
    clock.restore();
  }
}

const NEW_YORK = { zone: 'America/New_York', offset: -300 };

// This weekend on a card as an owner means it (2026-11-06): the open days
// from today through the first Sunday, of Friday, Saturday and Sunday. On
// Monday to Thursday that is the coming Friday to Sunday; on a Friday,
// Saturday or Sunday it starts today; it never reaches the week after. The
// card's today and its six days are a run of seven from today.
function weekendIds(intel) {
  const run = [intel.today, ...intel.week];
  const sunday = run.findIndex((d) => d.weekday === 'Sun');
  return run.slice(0, sunday + 1)
    .filter((d) => ['Fri', 'Sat', 'Sun'].includes(d.weekday) && !d.closed && d.peakScore !== null)
    .map((d) => `typical_peak_${d.date}`);
}

test('at 01:10 UTC on a Friday, still Thursday evening in New York, each venue\'s week, today and weekend are its own', async () => {
  const seen = {};
  for (const [name, placeId, clock] of [['utc', 'ChIJforecastTurnUtc000000', {}], ['newYork', 'ChIJforecastTurnNewYork00', NEW_YORK]]) {
    await pinnedAt('2026-11-06T01:10:00Z', async () => {
      bakeryAt({ placeId, ...clock });
      const { intel } = await cardWeek();
      const weekend = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
      const today = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
      const ids = (days) => intel.week.filter((d) => days.includes(d.weekday)).map((d) => `typical_peak_${d.date}`).sort();
      seen[name] = { intel, weekend: weekend.body, today: today.body, ids };
    });
  }
  const { utc, newYork } = seen;
  // On UTC it is Friday: the card's week starts on Saturday, and the weekend
  // is today and Saturday (Sunday is shut), 66 and 74, inside the ordering
  // floor. It was Saturday alone, with today left out, until 2026-11-06.
  assert.deepStrictEqual([utc.intel.today.weekday, utc.intel.week[0].weekday], ['Fri', 'Sat']);
  assert.strictEqual(utc.weekend.mode, 'template', utc.weekend.text);
  assert.strictEqual(utc.weekend.text, 'In Flock\'s forecast for places like yours, no day stands out this weekend: every day peaks between 66 and 74 on our 0 to 100 index.');
  assert.deepStrictEqual(utc.weekend.sources.map((s) => s.id).sort(), [`typical_peak_${utc.intel.today.date}`, ...utc.ids(['Sat'])].sort());
  assert.strictEqual(utc.today.text, 'In Flock\'s forecast for places like yours, today peaks around 8 AM at 66 on our 0 to 100 index.');
  // In New York it is 8:10 PM on Thursday: the week starts on Friday, Friday
  // and Saturday are the weekend, and today is Thursday, not the UTC day.
  assert.deepStrictEqual([newYork.intel.today.weekday, newYork.intel.week[0].weekday], ['Thu', 'Fri']);
  assert.strictEqual(newYork.weekend.mode, 'template', newYork.weekend.text);
  assert.strictEqual(newYork.weekend.text, 'In Flock\'s forecast for places like yours, no day stands out this weekend: every day peaks between 66 and 74 on our 0 to 100 index.');
  assert.deepStrictEqual(newYork.weekend.sources.map((s) => s.id).sort(), newYork.ids(['Fri', 'Sat']));
  assert.strictEqual(newYork.today.text, 'In Flock\'s forecast for places like yours, today peaks around 8 AM at 64 on our 0 to 100 index.');
});

test('every week chip answers the bakery framed on every day of a week, at the turn of the UTC day and at midday, on UTC and in New York', async () => {
  let runs = 0;
  for (let d = 0; d < 7; d += 1) {
    for (const time of ['01:10', '15:00']) {
      const iso = `2026-11-${String(6 + d).padStart(2, '0')}T${time}:00Z`;
      for (const [tag, clock] of [['U', {}], ['N', NEW_YORK]]) {
        runs += 1;
        // The venue's own today, and the bakery shut on Sundays, or on
        // Mondays when today is a Sunday, so that the shut day is in the week
        // ahead and today's chip is offered (the bakery test above).
        const today = new Intl.DateTimeFormat('en-US', { timeZone: clock.zone || 'UTC', weekday: 'short' }).format(Date.parse(iso));
        const where = `${iso}, ${clock.zone || 'UTC'} (${today})`;
        await pinnedAt(iso, async () => {
          bakeryAt({ placeId: `ChIJforecastEveryDay${tag}${String(runs).padStart(2, '0')}00`, ...clock, shut: today === 'Sun' ? 1 : 0 });
          const { intel } = await cardWeek();
          assert.strictEqual(intel.today.weekday, today, `${where}: the card's today is not the venue's`);
          const offered = offeredIds((await call('/api/venue/advisor/questions')).body);
          for (const id of WEEK_CHIPS) {
            assert.ok(offered.includes(id), `${where}: ${id} not offered: ${offered.join(', ')}`);
            const a = await call('/api/venue/advisor/ask', { intentId: id });
            assert.strictEqual(a.body.mode, 'template', `${where}: ${id}: ${a.body.text}`);
            assert.match(a.body.text, FRAMED, `${where}: ${id}`);
            // The bakery test's two rules: the card's reading never says
            // "your", and the playbook's quiet-day words name the day.
            assert.ok(!NO_YOUR_RANKING.test(a.body.text.split('\n')[0]), `${where}: ${id}: ${a.body.text}`);
            assert.ok(!/\byour (?:quietest|slowest)\b/i.test(a.body.text), `${where}: ${id}: ${a.body.text}`);
            if (id === 'weekend_outlook') {
              // The weekend is this one, on the venue's own dates: its open
              // days from today through the coming Sunday (weekendIds). With a
              // day shut there are never more than two of them, and the answer
              // names both.
              assert.deepStrictEqual(a.body.sources.map((s) => s.id).sort(), weekendIds(intel).sort(), `${where}: ${a.body.text}`);
            }
          }
        });
      }
    }
  }
  assert.strictEqual(runs, 28);
});

test('on a tie at the quiet end every chip names the first of the quietest days, as the money move and the tile do: the bar on its Sunday, Monday to Wednesday level', async () => {
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJforecastQuietTie00000' });
    const { week, low } = await cardWeek();
    assert.deepStrictEqual(week.map((d) => `${d.weekday} ${d.peakScore}`), ['Mon 48', 'Tue 48', 'Wed 48', 'Thu 64', 'Fri 66', 'Sat 74']);
    assert.strictEqual(low.weekday, 'Mon');
    const money = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
    assert.match(money.body.text, /^Fill Monday\. /);
    // It named Tuesday, with "Monday is next" under it, and the week's
    // quietest line named Wednesday, until 2026-11-05.
    const quiet = await call('/api/venue/advisor/ask', { intentId: 'quiet_nights' });
    assert.deepStrictEqual(quiet.body.text.split('\n').slice(0, 2), [
      'In Flock\'s forecast for places like yours, the quietest day this week is Monday, with its peak around 9 PM at 48 on our 0 to 100 index.',
      '• Tuesday is next, around 9 PM at 48.',
    ]);
    const peaks = await call('/api/venue/advisor/ask', { intentId: 'peak_hours' });
    assert.ok(peaks.body.text.split('\n').includes('• Monday is the quietest, around 9 PM at 48.'), peaks.body.text);
  });
  // The venue's own forecast reads a tie the same way.
  const own = ['Monday', 'Tuesday'].map((weekday, i) => advisorFacts.makeFact({
    id: `peak_2026-11-${String(9 + i).padStart(2, '0')}`,
    value: { date: `2026-11-${String(9 + i).padStart(2, '0')}`, weekday, peakHour: 21, peakScore: 48 },
    source: 'model_holdout',
    asOf: '2026-11-08T12:00:00Z',
    unit: '0-100 index',
  }));
  assert.strictEqual(advisorPhrasing.renderTemplate({ intent: 'quiet_nights', facts: own }).text.split('\n')[0],
    'Your quietest day this week is Monday, with its peak around 9 PM at 48 on our 0 to 100 index.');
});

// ── 11. This weekend (2026-11-06) ───────────────────────────────────────────
//
// Left over from section 10: a venue with no crowd history is answered from
// its card, whose week starts tomorrow, while a venue's own week runs seven
// days from today. On its Saturday the demo bar heard "the busiest day this
// weekend is Friday", next Friday, with today's Saturday at 74 left out, and a
// venue's own week held next Friday on its Saturday too. Pinned here: "this
// weekend" is the one in progress or the next one (today through Sunday on a
// Friday, Saturday or Sunday; the coming Friday to Sunday on Monday to
// Thursday), the same days with history and without, and the same days for
// the template and the phrasing model.

const PLANS = advisorRouter.__INTENT_PLANS;
const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const shortOf = (date) => SHORT[new Date(`${date}T12:00:00Z`).getUTCDay()];
// The dates a phrasing payload hands the model, one per fact it was built from.
const handedDates = (payload) => [...new Set(payloadFacts(payload)
  .filter((f) => /_date(?:_[a-z]+)?$/.test(f.id)).map((f) => f.value))].sort();
const gateText = (p) => {
  const gate = advisorFacts.corpusGate(p);
  return `We can't answer that yet. ${gate.reason} ${gate.whatWouldUnlock}`;
};
// The bar's move under its week's peaks, as the chip shows it: the playbook's.
const peakMove = () => roostPlaybook.moveFor('peak_hours', { facts: [] }, roostPlaybook.venueOf({ profile })).move;

test('on the demo\'s Friday the weekend is today, Saturday and Sunday, and "When do we peak this week?" is as it was', async (t) => {
  const clock = pinClock(DEMO_FRIDAY);
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJweekendDemoFriday0000' });
  const { intel } = await cardWeek();
  assert.deepStrictEqual([intel.today.date, intel.today.weekday, intel.today.peakScore], ['2026-11-06', 'Fri', 66]);
  // Until 2026-11-06 the first line was the same and the second "Sunday is
  // next, around 9 PM at 45.", with today left out.
  const weekend = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
  assert.strictEqual(weekend.body.mode, 'template');
  assert.strictEqual(weekend.body.text, [
    'In Flock\'s forecast for places like yours, the busiest day this weekend is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.',
    '• Friday is close behind, around 9 PM at 66.',
    '• Sunday is the quietest, around 9 PM at 45.',
  ].join('\n'));
  assert.deepStrictEqual(weekend.body.sources.map((s) => s.id).sort(), ['typical_peak_2026-11-06', 'typical_peak_2026-11-07', 'typical_peak_2026-11-08']);
  // The week's peaks read the card's week, as the money move and the tiles do.
  const peaks = await call('/api/venue/advisor/ask', { intentId: 'peak_hours' });
  assert.strictEqual(peaks.body.text, [
    'In Flock\'s forecast for places like yours, the busiest day this week is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.',
    '• Thursday is next, around 9 PM at 64.',
    '• Sunday is the quietest, around 9 PM at 45.',
    `• ${peakMove()}`,
  ].join('\n'));
  assert.deepStrictEqual(peaks.body.sources.map((s) => s.id), ['typical_peak_2026-11-07', 'typical_peak_2026-11-12', 'typical_peak_2026-11-08', 'roost_playbook']);
});

test('on its Saturday the bar\'s weekend is today and Sunday, never next Friday, and the phrasing model is handed the same two days', async (t) => {
  // It read "In Flock's forecast for places like yours, the busiest day this
  // weekend is Friday, with its peak around 9 PM at 66 on our 0 to 100
  // index." and "Sunday is next, around 9 PM at 45." until 2026-11-06:
  // Friday the 13th, and today's 74 nowhere in it.
  const clock = pinClock(Date.parse('2026-11-07T16:00:00Z'));
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJweekendSaturday000000', phrasing: true });
  const { intel } = await cardWeek();
  assert.deepStrictEqual([intel.today.date, intel.today.weekday], ['2026-11-07', 'Sat']);
  assert.ok(intel.week.some((d) => d.date === '2026-11-13' && d.weekday === 'Fri'), 'next Friday is on the card');
  let payload = null;
  draftFor = (role, p) => { payload = p; return null; }; // the phrasing call fails: the template answers
  const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
  assert.strictEqual(r.body.mode, 'template');
  assert.strictEqual(r.body.text, 'In Flock\'s forecast for places like yours, the busiest day this weekend is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.\n• Sunday is next, around 9 PM at 45.');
  assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['typical_peak_2026-11-07', 'typical_peak_2026-11-08']);
  // The model is handed the same two days, so it cannot name next Friday either.
  assert.deepStrictEqual(handedDates(payload), ['2026-11-07', '2026-11-08']);
  assert.ok(!payload.includes('2026-11-13') && !payloadFacts(payload).some((f) => f.value === 'Friday'), payload);
});

test('a venue with its own crowd history reads the same weekend: never next Friday on its Saturday, its Sunday alone on its Sunday, its street held to the same days', async () => {
  setUp({ placeId: 'ChIJweekendCorpus00000000', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 }, phrasing: true });
  const realWeek = advisorFacts.buildWeekAhead;
  const realAround = advisorFacts.buildAroundYou;
  const asOf = '2026-11-06T12:00:00Z';
  // Seven days from the venue's own today, as buildWeekAhead walks them.
  const ownWeekFrom = (start) => Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    const weekday = LONG[shortOf(date)];
    const score = CARD[shortOf(date)];
    return advisorFacts.makeFact({
      id: `peak_${date}`,
      value: { date, weekday, peakHour: 21, peakScore: score },
      source: 'model_holdout',
      asOf,
      predictionMethod: 'ml',
      unit: '0-100 index',
      label: advisorFacts.weekAheadPeakLabel({ weekday, hour: 21, score }),
    });
  });
  // A weather line and a listed event on every Friday to Sunday of the next
  // eight days: only this weekend's may stay.
  const streetFrom = (start) => Array.from({ length: 8 }, (_, i) => addDays(start, i))
    .filter((date) => ['Fri', 'Sat', 'Sun'].includes(shortOf(date)))
    .flatMap((date) => [
      advisorFacts.makeFact({ id: `weather_${date}`, value: { date, weekday: LONG[shortOf(date)], conditions: 'clear', middayTempF: 60 }, source: 'weather', asOf, label: `${LONG[shortOf(date)]}: clear, around 60 F midday.` }),
      advisorFacts.makeFact({ id: `event_${date}`, value: { date, weekday: LONG[shortOf(date)], name: 'Listed event', distanceKm: 0.4, type: 'music' }, source: 'events', asOf, label: `${LONG[shortOf(date)]}: a listed event about 0.4 km away, Listed event.` }),
    ]);
  try {
    for (const [start, expected] of [
      ['2026-11-07', ['2026-11-07', '2026-11-08']],
      ['2026-11-08', ['2026-11-08']],
      ['2026-11-06', ['2026-11-06', '2026-11-07', '2026-11-08']],
      ['2026-11-09', ['2026-11-13', '2026-11-14', '2026-11-15']],
    ]) {
      advisorFacts.buildWeekAhead = async () => ownWeekFrom(start);
      advisorFacts.buildAroundYou = async () => streetFrom(start);
      let payload = null;
      draftFor = (role, p) => { payload = p; return null; };
      const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
      assert.strictEqual(r.body.mode, 'template', r.body.text);
      const cited = [...new Set(r.body.sources.map((s) => s.id.slice(-10)))].sort();
      assert.deepStrictEqual(cited, expected, `${start}: ${r.body.text}`);
      assert.deepStrictEqual(handedDates(payload), expected, `${start}: the phrasing model`);
    }
    // Its Saturday, in words: its own two days, said as its own.
    advisorFacts.buildWeekAhead = async () => ownWeekFrom('2026-11-07');
    advisorFacts.buildAroundYou = async () => [];
    draftFor = () => null;
    const sat = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.strictEqual(sat.body.text, 'Your busiest day this weekend is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.\n• Sunday is next, around 9 PM at 45.');
  } finally {
    advisorFacts.buildWeekAhead = realWeek;
    advisorFacts.buildAroundYou = realAround;
  }
});

test('this weekend is the same days with crowd history and without, on every day of a week, and never a day of the week after', async () => {
  const hourOf = venueDashboardRouter.hourOfLabel;
  // By today's weekday, the weekend it means.
  const MEANT = {
    Mon: ['Fri', 'Sat', 'Sun'], Tue: ['Fri', 'Sat', 'Sun'], Wed: ['Fri', 'Sat', 'Sun'], Thu: ['Fri', 'Sat', 'Sun'],
    Fri: ['Fri', 'Sat', 'Sun'], Sat: ['Sat', 'Sun'], Sun: ['Sun'],
  };
  const asOf = '2026-11-09T12:00:00Z';
  for (let i = 0; i < 7; i += 1) {
    const today = addDays('2026-11-09', i); // Monday to Sunday
    const run = Array.from({ length: 7 }, (_, d) => addDays(today, d));
    // Each weekday is in the run once, so a name is a date.
    const expected = run.filter((date) => MEANT[shortOf(today)].includes(shortOf(date)));
    const sunday = run.find((date) => shortOf(date) === 'Sun');
    assert.ok(expected.every((date) => date >= today && date <= sunday), `${today}: ${expected}`);
    // The venue's own week: seven days from today.
    const own = run.map((date) => advisorFacts.makeFact({
      id: `peak_${date}`, value: { date, weekday: LONG[shortOf(date)], peakHour: 21, peakScore: CARD[shortOf(date)] }, source: 'model_holdout', asOf, unit: '0-100 index',
    }));
    // The card: today on its own, and its six days from tomorrow.
    const cardDay = (date) => ({ date, weekday: shortOf(date), peakScore: CARD[shortOf(date)], peakHour: '9 PM', method: 'rule_engine_no_baseline' });
    const intel = { ...DEMO_INTEL, generatedAt: asOf, today: { ...cardDay(today), window: 'evening' }, week: run.slice(1).map(cardDay) };
    const card = advisorFacts.projectionFacts(intel, { hourOf });
    const todayFacts = advisorFacts.todayProjectionFacts(intel, { hourOf });
    assert.strictEqual(card.length, 6);
    assert.strictEqual(todayFacts.length, 1);
    // The street on every day of the run and the day after it.
    const street = [...run, addDays(today, 7)].map((date) => advisorFacts.makeFact({
      id: `weather_${date}`, value: { date, weekday: LONG[shortOf(date)], conditions: 'clear', middayTempF: 60 }, source: 'weather', asOf, label: `${LONG[shortOf(date)]}: clear.`,
    }));
    const withHistory = await PLANS.weekend_outlook({ week: async () => own, around: async () => street });
    const without = await PLANS.weekend_outlook({
      week: async () => card,
      tonight: async () => todayFacts,
      card: async () => ({ week: card, today: todayFacts, date: today }),
      around: async () => street,
    });
    const datesOf = (entries, re) => entries.filter((e) => re.test(e.id)).map((e) => e.value.date);
    assert.deepStrictEqual(datesOf(withHistory, /^peak_/), expected, `${today} with history`);
    assert.deepStrictEqual(datesOf(without, /^typical_peak_/), expected, `${today} without`);
    assert.deepStrictEqual(datesOf(withHistory, /^weather_/), expected, `${today} the street, with history`);
    assert.deepStrictEqual(datesOf(without, /^weather_/), expected, `${today} the street, without`);
    // Today is in it exactly on a Friday, Saturday or Sunday.
    assert.strictEqual(expected.includes(today), ['Fri', 'Sat', 'Sun'].includes(shortOf(today)), today);
    // A builder that cannot say which day today is on the card gets no
    // weekend, never one counted from the card's first day.
    assert.deepStrictEqual(await PLANS.weekend_outlook({ week: async () => card, around: async () => [] }), [], today);
  }
});

test('the bar on every day of a week, at the turn of the UTC day and at midday, on UTC and in New York: the weekend from its own today, and the same days for the model', async () => {
  let runs = 0;
  for (let d = 0; d < 7; d += 1) {
    for (const time of ['01:10', '15:00']) {
      const iso = `2026-11-${String(6 + d).padStart(2, '0')}T${time}:00Z`;
      for (const [tag, clock] of [['U', {}], ['N', NEW_YORK]]) {
        runs += 1;
        const today = new Intl.DateTimeFormat('en-US', { timeZone: clock.zone || 'UTC', weekday: 'short' }).format(Date.parse(iso));
        const where = `${iso}, ${clock.zone || 'UTC'} (${today})`;
        await pinnedAt(iso, async () => {
          setUp({ placeId: `ChIJweekendEveryDay${tag}${String(runs).padStart(2, '0')}000`, phrasing: true });
          placeZone = clock.zone || null;
          placeOffset = clock.offset || 0;
          const { intel } = await cardWeek();
          assert.strictEqual(intel.today.weekday, today, `${where}: the card's today is not the venue's`);
          // The weekend chip, and what the phrasing model is handed for it.
          let payload = null;
          draftFor = (role, p) => { payload = p; return null; };
          const weekend = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
          assert.strictEqual(weekend.body.mode, 'template', `${where}: ${weekend.body.text}`);
          assert.match(weekend.body.text, FRAMED, where);
          assert.ok(!NO_YOUR_RANKING.test(weekend.body.text), `${where}: ${weekend.body.text}`);
          const ids = weekendIds(intel);
          assert.deepStrictEqual(weekend.body.sources.map((s) => s.id).sort(), [...ids].sort(), `${where}: ${weekend.body.text}`);
          assert.deepStrictEqual(handedDates(payload), ids.map((id) => id.slice(-10)).sort(), `${where}: the phrasing model`);
          assert.strictEqual(ids.includes(`typical_peak_${intel.today.date}`), ['Fri', 'Sat', 'Sun'].includes(today), where);
        });
      }
    }
  }
  assert.strictEqual(runs, 28);
});

test('a bakery shut on Sundays, on its Sunday, has no open day left this weekend: no weekend chip, and asked anyway it refuses the way today does', async () => {
  // It answered about next Friday and Saturday until 2026-11-06.
  await pinnedAt('2026-11-08T15:00:00Z', async () => {
    bakeryAt({ placeId: 'ChIJweekendBakerySunday00', shut: 0 });
    const { intel } = await cardWeek();
    assert.deepStrictEqual([intel.today.weekday, intel.today.closed], ['Sun', true]);
    const offered = offeredIds((await call('/api/venue/advisor/questions')).body);
    for (const id of ['weekend_outlook', 'tonight_outlook']) assert.ok(!offered.includes(id), `${id}: ${offered.join(', ')}`);
    assert.ok(offered.includes('money_move'), offered.join(', '));
    for (const id of ['weekend_outlook', 'tonight_outlook']) {
      const r = await call('/api/venue/advisor/ask', { intentId: id });
      assert.strictEqual(r.body.mode, 'refusal', `${id}: ${r.body.text}`);
      assert.ok(r.body.text.startsWith(gateText(profile)), `${id}: ${r.body.text}`);
    }
  });
});
