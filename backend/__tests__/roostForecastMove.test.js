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
// The venue's corpus row, for a test of a venue with crowd history that needs
// its clock (advisorFacts.venueToday); none otherwise.
let mlVenueRow = null;
// Its Google curve (ml_venue_baselines), for a test that runs the venue's own
// week through advisorFacts.buildWeekAhead; none otherwise.
let baselineRows = [];
pool.query = async (sql) => {
  const q = String(sql).replace(/\s+/g, ' ');
  if (/FROM venue_profiles WHERE user_id/.test(q)) return { rows: profile ? [profile] : [], rowCount: profile ? 1 : 0 };
  if (/FROM ml_venues WHERE google_place_id/.test(q)) return { rows: mlVenueRow ? [mlVenueRow] : [], rowCount: mlVenueRow ? 1 : 0 };
  if (/FROM ml_venue_baselines/.test(q)) return { rows: baselineRows, rowCount: baselineRows.length };
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
  mlVenueRow = null;
  baselineRows = [];
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

// Every way Roost reads the dashboard's card, counted: the week, today, and
// the one read a block shares (routes/advisor.js cardFor, 2026-11-06).
function countCardReads() {
  const names = ['buildWeekProjection', 'buildTodayProjection', 'buildCardProjection'];
  const real = Object.fromEntries(names.map((n) => [n, advisorFacts[n]]));
  let reads = 0;
  for (const n of names) advisorFacts[n] = async (...a) => { reads += 1; return real[n](...a); };
  return { reads: () => reads, restore: () => { for (const n of names) advisorFacts[n] = real[n]; } };
}

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
  const cardReads = countCardReads();
  try {
    const kitchen = await call('/api/venue/advisor/ask', { intentId: 'kitchen_vs_peak' });
    assert.strictEqual(kitchen.body.text, 'You told us the kitchen takes last orders at 9:30 PM.');
    assert.ok(!kitchen.body.sources.some((s) => s.source === 'category_pattern'), JSON.stringify(kitchen.body.sources));
    assert.strictEqual(cardReads.reads(), 0, 'the listing lines read the venue\'s own week only');
  } finally {
    cardReads.restore();
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
  const cardReads = countCardReads();
  advisorFacts.buildWeekAhead = async () => own;
  try {
    const r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
    assert.strictEqual(r.body.mode, 'template');
    const lines = r.body.text.split('\n');
    assert.strictEqual(lines[0], 'Fill Tuesday. It is your quietest day this week, with its peak around 6 PM at 38 on our 0 to 100 index, against 88 on Saturday.');
    // The playbook's own words for the venue's own week.
    assert.ok(lines.some((l) => l.startsWith('• Give your slowest day one recurring reason to visit')), r.body.text);
    assert.strictEqual(cardReads.reads(), 0);
  } finally {
    advisorFacts.buildWeekAhead = realWeek;
    cardReads.restore();
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
  const cardReads = countCardReads();
  try {
    const r = await call('/api/venue/advisor/questions');
    const offered = offeredIds(r.body);
    for (const id of [...WEEK_CHIPS, 'tonight_outlook']) assert.ok(offered.includes(id), `${id}: ${offered.join(', ')}`);
    assert.strictEqual(cardReads.reads(), 0);
  } finally {
    cardReads.restore();
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

test('a today closed by the listing says so, and today with nothing else to read keeps the refusal: a model number on the card', async () => {
  const gateText = (p) => {
    const gate = advisorFacts.corpusGate(p);
    return `We can't answer that yet. ${gate.reason} ${gate.whatWouldUnlock}`;
  };
  // Closed today by its listed hours, open every other day: today says so
  // plainly, and the week still answers. It refused with "We have no crowd
  // history for this venue" until 2026-11-06, the wrong reason, and the chip
  // was held back as one that would refuse; it answers now, so it is offered.
  setUp({ placeId: 'ChIJforecastTodayClosed00' });
  const todayDow = new Date().getUTCDay();
  placePeriods = periodsOf(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== todayDow).map((d) => [d, [16, 23]])));
  const { intel } = await cardWeek();
  assert.strictEqual(intel.today.closed, true, JSON.stringify(intel.today));
  let r = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.strictEqual(r.body.text, 'Your Google listing has you closed today.');
  assert.deepStrictEqual(r.body.sources.map((s) => [s.id, s.source]), [['today_closed', 'google_listing']]);
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.notStrictEqual(r.body.mode, 'refusal', r.body.text);
  const offered = offeredIds((await call('/api/venue/advisor/questions')).body);
  assert.ok(offered.includes('tonight_outlook'), offered.join(', '));
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

// ── 11. This weekend, and today asked by name (2026-11-06) ──────────────────
//
// Two answers left over from section 10, with one cause: a venue with no
// crowd history is answered from its card, whose week starts tomorrow, while
// a venue's own week runs seven days from today. On its Saturday the demo bar
// heard "the busiest day this weekend is Friday", next Friday, with today's
// Saturday at 74 left out, and a venue's own week held next Friday on its
// Saturday too. On a Monday, "How do I fill a slow Monday?" found no Monday on
// the card and had no number to lead with. Pinned here: "this weekend" is the
// one in progress or the next one (today through Sunday on a Friday, Saturday
// or Sunday; the coming Friday to Sunday on Monday to Thursday), the same days
// with history and without, and the same days for the template and the
// phrasing model; and a question about today's weekday is answered from
// today's entry on the card, said beside the week and never ranked in it.

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
  // Today is part of the weekend it asks about, so it is ranked with Sunday,
  // and carries no note setting it beside a week.
  assert.ok(payloadFacts(payload).every((f) => !kindForecast.isBesideWeek(f)), payload);
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

test('the bar on every day of a week, at the turn of the UTC day and at midday, on UTC and in New York: the weekend from its own today, the same days for the model, and today asked by name off today\'s entry', async () => {
  let runs = 0;
  for (let d = 0; d < 7; d += 1) {
    for (const time of ['01:10', '15:00']) {
      const iso = `2026-11-${String(6 + d).padStart(2, '0')}T${time}:00Z`;
      for (const [tag, clock] of [['U', {}], ['N', NEW_YORK]]) {
        runs += 1;
        const today = new Intl.DateTimeFormat('en-US', { timeZone: clock.zone || 'UTC', weekday: 'short' }).format(Date.parse(iso));
        const day = LONG[today];
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
          // Today asked by name, typed and routed to the week's peaks, the model out.
          route = { mode: 'grounded', intentId: 'peak_hours' };
          draftFor = () => null;
          const named = await call('/api/venue/advisor/question', { question: `How busy will ${day} be?` });
          assert.strictEqual(named.body.mode, 'template', `${where}: ${named.body.text}`);
          assert.deepStrictEqual(named.body.text.split('\n'), [
            `In Flock's forecast for places like yours, ${day} peaks around 9 PM at ${CARD[today]} on our 0 to 100 index.`,
            `• ${peakMove()}`,
          ], where);
          assert.deepStrictEqual(named.body.sources.map((s) => s.id), [`typical_peak_${intel.today.date}`, 'roost_playbook'], where);
          // And as advice, the model out: the playbook leads with today's
          // number and names the day in its move.
          route = { mode: 'advice', intentId: 'quiet_nights' };
          const advice = await call('/api/venue/advisor/question', { question: `How do I fill a slow ${day}?` });
          assert.strictEqual(advice.body.mode, 'advice', `${where}: ${advice.body.text}`);
          assert.ok(advice.body.text.startsWith(`In Flock's forecast for places like yours, ${day} projects busiest around 9 PM, at ${CARD[today]} on our 0 to 100 index. Give ${day} `), `${where}: ${advice.body.text}`);
          assert.ok(!/\b(?:your )?(?:quietest|slowest) day\b/i.test(advice.body.text), `${where}: ${advice.body.text}`);
          assert.ok(advice.body.sources.some((s) => s.id === `typical_peak_${intel.today.date}` && s.source === 'category_pattern'), `${where}: ${JSON.stringify(advice.body.sources)}`);
        });
      }
    }
  }
  assert.strictEqual(runs, 28);
});

test('on a Monday, "How do I fill a slow Monday?" leads with Monday off the card\'s today, and the phrasing model is handed today alone', async (t) => {
  const clock = pinClock(Date.parse('2026-11-09T16:00:00Z'));
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJweekendMonday00000000', phrasing: true });
  const { intel } = await cardWeek();
  assert.deepStrictEqual([intel.today.weekday, intel.today.peakScore], ['Mon', 48]);
  assert.ok(!intel.week.some((d) => d.weekday === 'Mon'), 'the card\'s week holds no Monday');
  // Advice, the model out. Until 2026-11-06 this led with no number at all:
  // "Give your slowest day one recurring reason to visit, ...".
  route = { mode: 'advice', intentId: 'quiet_nights' };
  draftFor = () => null;
  let r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Monday?' });
  assert.strictEqual(r.body.mode, 'advice', r.body.text);
  assert.match(r.body.text, /^In Flock's forecast for places like yours, Monday projects busiest around 9 PM, at 48 on our 0 to 100 index\. Give Monday one recurring reason to visit/);
  assert.ok(!/\byour (?:slowest|quietest) day\b/i.test(r.body.text), r.body.text);
  assert.ok(r.body.sources.some((s) => s.id === 'typical_peak_2026-11-09' && s.source === 'category_pattern'), JSON.stringify(r.body.sources));
  // The advice model is still never handed the card, today's entry included.
  let advicePayload = null;
  draftFor = (role, p) => {
    advicePayload = p;
    return { answer: 'Give people one fixed reason to come in every Monday, like a weekly industry night.', points: [] };
  };
  r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Monday?' });
  assert.strictEqual(r.body.mode, 'advice', r.body.text);
  assert.ok(advicePayload && !/category_pattern|typical_peak_/.test(advicePayload), 'the card reached the advice model');

  // Typed and grounded: the model is handed today's entry alone, the one day
  // the template answers with, every part of it carrying the note that sets
  // it beside the week; a draft built on it is served.
  route = { mode: 'grounded', intentId: 'peak_hours' };
  let payload = null;
  draftFor = (role, p) => {
    payload = p;
    const f = payloadFacts(p);
    return { answer: `Flock's forecast for places like yours has Monday peaking around {{fact:${idFor(f, 'Monday', 'hour')}}} at {{fact:${idFor(f, 'Monday', 'score')}}} on our index.`, points: [] };
  };
  r = await call('/api/venue/advisor/question', { question: 'How busy will Monday be?' });
  assert.strictEqual(r.body.mode, 'phrased', r.body.text);
  assert.strictEqual(r.body.text, 'Flock\'s forecast for places like yours has Monday peaking around 9 PM at 48 on our index.');
  const handed = payloadFacts(payload);
  assert.deepStrictEqual(handedDates(payload), ['2026-11-09']);
  assert.ok(handed.length >= 3 && handed.every((f) => f.note === kindForecast.BESIDE_WEEK_NOTE), JSON.stringify(handed));
  // The model out, the template: today's own line, then the move.
  draftFor = () => null;
  r = await call('/api/venue/advisor/question', { question: 'How busy will Monday be?' });
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.strictEqual(r.body.text, `In Flock's forecast for places like yours, Monday peaks around 9 PM at 48 on our 0 to 100 index.\n• ${peakMove()}`);
});

test('today asked by name is never ranked against the card\'s week: the bar on its Sunday, quieter than every day ahead', async (t) => {
  // Sunday's 45 is under every day on the card (Monday to Wednesday at 48).
  // Ranked with them it would be "the quietest day this week" while the money
  // move and the dashboard's tiles say Monday.
  const clock = pinClock(Date.parse('2026-11-08T16:00:00Z'));
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJweekendSundayRank0000', phrasing: true });
  const { intel, low } = await cardWeek();
  assert.deepStrictEqual([intel.today.weekday, intel.today.peakScore, low.weekday], ['Sun', 45, 'Mon']);
  draftFor = () => null;
  for (const [intentId, question] of [['peak_hours', 'How busy will Sunday be?'], ['quiet_nights', 'How quiet will Sunday be?']]) {
    route = { mode: 'grounded', intentId };
    const r = await call('/api/venue/advisor/question', { question });
    assert.strictEqual(r.body.mode, 'template', r.body.text);
    assert.strictEqual(r.body.text.split('\n')[0], 'In Flock\'s forecast for places like yours, Sunday peaks around 9 PM at 45 on our 0 to 100 index.', intentId);
    assert.ok(!/\b(?:quietest|busiest)\b/.test(r.body.text), `${intentId}: ${r.body.text}`);
    assert.ok(!NO_YOUR_RANKING.test(r.body.text), `${intentId}: ${r.body.text}`);
  }
  const money = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.match(money.body.text, /^Fill Monday\. In Flock's forecast for places like yours, it is the quietest day this week/);
  // As advice, the playbook leads with Sunday's own number.
  route = { mode: 'advice', intentId: 'quiet_nights' };
  const advice = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Sunday?' });
  assert.match(advice.body.text, /^In Flock's forecast for places like yours, Sunday projects busiest around 9 PM, at 45 on our 0 to 100 index\. Give Sunday /);
  assert.ok(!/quietest day this week/.test(advice.body.text), advice.body.text);
});

test('today beside the card\'s week, read directly: the template and the playbook\'s lead say its own line and rank the week without it', () => {
  const hourOf = venueDashboardRouter.hourOfLabel;
  const card = demoCard(); // Saturday to Thursday, Sunday the quietest at 45
  // Today, Friday, at 30: under every day on the card.
  const [today] = advisorFacts.todayProjectionFacts({
    ...DEMO_INTEL,
    today: { date: '2026-11-06', weekday: 'Fri', peakScore: 30, peakHour: '10 PM', method: 'rule_engine_no_baseline', window: 'evening' },
  }, { hourOf });
  const beside = kindForecast.besideWeek(today);
  assert.strictEqual(beside.note, kindForecast.BESIDE_WEEK_NOTE);
  assert.ok(kindForecast.isBesideWeek(beside) && !kindForecast.isBesideWeek(today) && !card.some(kindForecast.isBesideWeek));
  assert.strictEqual(beside.id, 'typical_peak_2026-11-06', 'the id the sources line names');
  for (const intent of ['peak_hours', 'quiet_nights']) {
    const out = advisorPhrasing.renderTemplate({ intent, facts: [beside, ...card] }, 'How busy will Friday be?');
    assert.strictEqual(out.text, 'In Flock\'s forecast for places like yours, Friday peaks around 10 PM at 30 on our 0 to 100 index.', intent);
    assert.deepStrictEqual(out.sources.map((s) => s.id), ['typical_peak_2026-11-06'], intent);
  }
  // A question that does not name today reads the week as it would without it.
  for (const intent of ['peak_hours', 'quiet_nights', 'money_move']) {
    assert.strictEqual(advisorPhrasing.renderTemplate({ intent, facts: [beside, ...card] }).text,
      advisorPhrasing.renderTemplate({ intent, facts: card }).text, intent);
  }
  // The playbook's lead: today's own number, never the quietest day this
  // week, though 30 is under every day of the card.
  assert.strictEqual(roostPlaybook.groundedLead('quiet_nights', [beside, ...card], 'How do I fill a slow Friday?').text,
    'In Flock\'s forecast for places like yours, Friday projects busiest around 10 PM, at 30 on our 0 to 100 index.');
  assert.strictEqual(roostPlaybook.groundedLead('money_move', [beside, ...card]).text,
    'In Flock\'s forecast for places like yours, Sunday projects as the quietest day this week.');
  // Today alone, with no week beside it, leads with its own number when
  // named, and leads with nothing when not.
  assert.strictEqual(roostPlaybook.groundedLead('quiet_nights', [beside], 'How do I fill a slow Friday?').text,
    'In Flock\'s forecast for places like yours, Friday projects busiest around 10 PM, at 30 on our 0 to 100 index.');
  assert.strictEqual(roostPlaybook.groundedLead('quiet_nights', [beside]), null);
});

test('a bakery shut on Sundays, on its Sunday, has no open day left this weekend: the weekend says so plainly and goes on to next weekend, and today says it is closed', async () => {
  // It answered about next Friday and Saturday as this weekend until
  // 2026-11-06, and then, for a day, with "We can't answer that yet. We have
  // no crowd history for this venue." (review: the wrong reason); today did
  // too.
  await pinnedAt('2026-11-08T15:00:00Z', async () => {
    bakeryAt({ placeId: 'ChIJweekendBakerySunday00', shut: 0 });
    const { intel } = await cardWeek();
    assert.deepStrictEqual([intel.today.weekday, intel.today.closed], ['Sun', true]);
    const offered = offeredIds((await call('/api/venue/advisor/questions')).body);
    assert.ok(offered.includes('weekend_outlook') && offered.includes('tonight_outlook'), offered.join(', '));
    const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.strictEqual(r.body.mode, 'template', r.body.text);
    assert.strictEqual(r.body.text, [
      'Your Google listing has you closed for the rest of this weekend. In Flock\'s forecast for places like yours, no day stands out next weekend: every day peaks between 66 and 74 on our 0 to 100 index.',
      '• Next Sunday is past the seven days the forecast covers.',
    ].join('\n'));
    assert.deepStrictEqual(r.body.sources.map((s) => [s.id, s.source]), [
      ['weekend_closed', 'google_listing'], ['typical_peak_2026-11-14', 'category_pattern'], ['typical_peak_2026-11-13', 'category_pattern'],
      ['next_weekend_past_forecast', 'category_pattern'],
    ]);
    const today = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
    assert.strictEqual(today.body.mode, 'template', today.body.text);
    assert.strictEqual(today.body.text, 'Your Google listing has you closed today.');
  });
});

// ── 12. The review of section 11 (2026-11-06) ───────────────────────────────
//
// An adversarial review of section 11 found the phrasing model, handed today
// beside the card's week, writing "Flock's forecast for places like yours has
// Sunday as the quietest day this week" on the bar's Sunday while the money
// move said to fill Monday, and that answer was served. Today is now handed to
// the model alone, the check sends any ranking of today to the template, and
// the move and what to ask next name the day the answer does. A card week too
// level to name a quiet day still answers about today, and a block reads the
// card once, so a weekend asked as the hour turns comes off one build.

const quietMove = () => roostPlaybook.moveFor('quiet_nights', { facts: [] }, roostPlaybook.venueOf({ profile })).move;

test('a phrased answer never ranks today: on the bar\'s Sunday the model\'s "Sunday as the quietest day this week" goes to the template, and the model is handed Sunday alone', async (t) => {
  // The review's draft was served for both questions until 2026-11-06: "Flock's
  // forecast for places like yours has Sunday as the quietest day this week,
  // peaking at 45 on our index."
  const clock = pinClock(Date.parse('2026-11-08T16:00:00Z'));
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJreviewRankToday000000', phrasing: true });
  const { intel, low } = await cardWeek();
  assert.deepStrictEqual([intel.today.weekday, intel.today.peakScore, low.weekday], ['Sun', 45, 'Mon']);
  for (const [intentId, question] of [['peak_hours', 'How quiet will Sunday be?'], ['quiet_nights', 'Is Sunday going to be quiet?']]) {
    route = { mode: 'grounded', intentId };
    let payload = null;
    draftFor = (role, p) => {
      payload = p;
      const f = payloadFacts(p);
      return { answer: `Flock's forecast for places like yours has Sunday as the quietest day this week, peaking at {{fact:${idFor(f, 'Sunday', 'score')}}} on our index.`, points: [] };
    };
    const r = await call('/api/venue/advisor/question', { question });
    assert.strictEqual(r.body.mode, 'template', `${intentId}: ${r.body.text}`);
    assert.strictEqual(r.body.text.split('\n')[0], 'In Flock\'s forecast for places like yours, Sunday peaks around 9 PM at 45 on our 0 to 100 index.', intentId);
    assert.ok(!/\b(?:quietest|busiest)\b/.test(r.body.text), `${intentId}: ${r.body.text}`);
    // The one day the template answers with, and nothing to rank it against.
    assert.deepStrictEqual(handedDates(payload), ['2026-11-08'], intentId);
  }
  route = null;
  draftFor = () => null;
  const money = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.match(money.body.text, /^Fill Monday\. In Flock's forecast for places like yours, it is the quietest day this week/);
});

test('the check reads a draft built on today for any ranking of the day, its day named or not, and leaves the night\'s own hours alone', () => {
  const hourOf = venueDashboardRouter.hourOfLabel;
  const [today] = advisorFacts.todayProjectionFacts({
    ...DEMO_INTEL,
    today: { date: '2026-11-08', weekday: 'Sun', peakScore: 45, peakHour: '9 PM', method: 'rule_engine_no_baseline', window: 'evening' },
  }, { hourOf });
  const block = { facts: advisorPhrasing.aliasFacts(advisorPhrasing.flattenFacts([kindForecast.besideWeek(today)])) };
  const id = (part) => block.facts.find((f) => f.id === `typical_peak_${part}`).id;
  const say = (answer, points = []) => JSON.stringify({ answer, points });
  const opening = 'Flock\'s forecast for places like yours';
  for (const [answer, points] of [
    [`${opening} has Sunday as the quietest day this week, peaking at {{fact:${id('score')}}} on our index.`, []],
    [`${opening} has Sunday peaking at {{fact:${id('score')}}} around {{fact:${id('hour')}}}.`, ['That makes it the quietest day this week.']],
    [`${opening} puts tonight at {{fact:${id('score')}}}, the busiest night of the week.`, []],
    [`${opening} has {{fact:${id('weekday')}}} at {{fact:${id('score')}}}, lower than the weekend.`, []],
    [`${opening} has Sundays at {{fact:${id('score')}}}, the slowest.`, []],
    [`${opening} has Sunday at {{fact:${id('score')}}}.`, ['This week\'s quietest is Sunday, so plan a small staff.']],
  ]) {
    const why = [];
    assert.strictEqual(advisorPhrasing.applyValve(say(answer, points), block, { reject: (r) => { why.push(r); return null; } }), null, answer);
    assert.deepStrictEqual(why, ['today, ranked against the days of the week'], answer);
  }
  // A ranking of the night's own hours, or of the staff and the menu, is not
  // a ranking of the day (second review, 2026-11-06: these went to the
  // template until then).
  for (const [answer, points] of [
    [`${opening} has Sunday peaking around {{fact:${id('hour')}}} at {{fact:${id('score')}}} on our index.`, []],
    [`${opening} has Sunday peaking at {{fact:${id('score')}}}.`, [`Have your second bartender on before {{fact:${id('hour')}}}.`]],
    [`${opening} has Sunday peaking at {{fact:${id('score')}}}.`, [`Put your best bartender on before {{fact:${id('hour')}}}.`]],
    [`${opening} has Sunday peaking at {{fact:${id('score')}}}.`, ['Most guests tonight will arrive after 8 PM, so prep the bar before then.']],
    [`${opening} has Sunday peaking at {{fact:${id('score')}}}.`, ['Keep the menu to your top sellers tonight so the bar keeps moving.']],
    [`${opening} has Sunday peaking at {{fact:${id('score')}}}.`, ['Sunday is a good night to test a small special, since the room has space before the peak.']],
  ]) {
    const out = advisorPhrasing.applyValve(say(answer, points), block);
    assert.ok(out && out.text.includes('45'), `${answer} ${points.join(' ')}`);
  }
  // The reader on its own.
  assert.ok(kindForecast.ranksToday('Sunday is the quietest day this week', 'Sunday'));
  assert.ok(kindForecast.ranksToday('Saturday is the busiest night of the week', 'Sunday'), 'a day\'s place in its week, whichever day');
  assert.ok(kindForecast.ranksToday('Tonight looks busier than usual', 'Sunday'));
  assert.ok(kindForecast.ranksToday('Tonight is busier than Friday.'));
  assert.ok(kindForecast.ranksToday('It is the peak night for places like yours.'));
  assert.ok(kindForecast.ranksToday('Monday is the second busiest.'));
  assert.ok(!kindForecast.ranksToday('Sunday peaks around 9 PM at 45 on our index', 'Sunday'));
  assert.ok(!kindForecast.ranksToday('Stagger your shifts so staff arrive as the rush builds', 'Sunday'));
  assert.ok(!kindForecast.ranksToday('The busiest stretch tonight is the hour before that, so have your second bartender on by then.'));
  assert.ok(!kindForecast.ranksToday('The 9 PM hour is busier than 8 PM, so start the second bartender at 8.'));
  assert.ok(!kindForecast.ranksToday('In Flock\'s forecast for places like yours, today peaks around 9 PM at 48 on our 0 to 100 index.'));
  // Nothing in a block without today's entry is read this way.
  assert.ok(advisorPhrasing.applyValve(say(`${opening} has Sunday as the quietest day this week, at {{fact:typical_peak_score}}.`),
    { facts: [advisorFacts.makeFact({ id: 'typical_peak_score', value: 45, source: 'category_pattern', asOf: '2026-11-03T12:00:00Z' })] }));
});

test('today asked by name on every day of a week: the answer, its move and what to ask next all name today, for the quiet days and the peaks, and a busy today is never given a fill move', async () => {
  // Until 2026-11-06 the quiet answer led with today and moved on Sunday, the
  // card's quiet day, on every day of the week: "Saturday peaks around 9 PM at
  // 74" over "Give Sunday one recurring reason to visit", under "How do I fill
  // Saturdays?". Then it moved on today whatever today was, so Saturday at 74,
  // the week's high, got "Give Saturday one recurring reason to visit"
  // (second review). Today is filled only from the quiet end of its week,
  // within the ordering floor of its quietest day: the card's Monday to
  // Wednesday (48 against Sunday's 45) and its Sunday (45 against 48), and
  // Thursday to Saturday get the peaks chip's move and question instead.
  const FILLED = new Set(['Mon', 'Tue', 'Wed', 'Sun']);
  const PEAKS_NEXT = 'How do I handle the rush without losing covers?';
  for (let d = 0; d < 7; d += 1) {
    await pinnedAt(`2026-11-${String(9 + d).padStart(2, '0')}T16:00:00Z`, async () => {
      setUp({ placeId: `ChIJreviewNamedDay${d}000000`, phrasing: true });
      draftFor = () => null;
      const { intel } = await cardWeek();
      const day = LONG[intel.today.weekday];
      const filled = FILLED.has(intel.today.weekday);
      const lead = `In Flock's forecast for places like yours, ${day} peaks around 9 PM at ${CARD[intel.today.weekday]} on our 0 to 100 index.`;
      route = { mode: 'grounded', intentId: 'quiet_nights' };
      const quiet = await call('/api/venue/advisor/question', { question: `How quiet will ${day} be?` });
      assert.deepStrictEqual(quiet.body.text.split('\n'), [lead, `• ${filled ? kindForecast.unownDays(quietMove(), day) : peakMove()}`], day);
      assert.deepStrictEqual(quiet.body.sources.map((s) => s.id), [`typical_peak_${intel.today.date}`, 'roost_playbook'], day);
      const next = filled ? `How do I fill ${day}s?` : PEAKS_NEXT;
      assert.ok(quiet.body.followUps.some((f) => f.kind === 'question' && f.text === next), `${day}: ${JSON.stringify(quiet.body.followUps)}`);
      assert.ok(!/recurring reason/.test(quiet.body.text) || filled, quiet.body.text);
      route = { mode: 'grounded', intentId: 'peak_hours' };
      const peaks = await call('/api/venue/advisor/question', { question: `How busy will ${day} be?` });
      assert.deepStrictEqual(peaks.body.text.split('\n'), [lead, `• ${peakMove()}`], day);
    });
  }
});

test('a card week too level to name a quiet day still answers a question about today from today\'s entry', async () => {
  // "How quiet will Monday be?" refused with the level week's reason until
  // 2026-11-06, though the card had Monday's number.
  const saved = { ...CARD };
  Object.assign(CARD, { Sat: 52, Sun: 45, Mon: 48, Tue: 48, Wed: 48, Thu: 50, Fri: 50 });
  try {
    await pinnedAt('2026-11-09T16:00:00Z', async () => {
      setUp({ placeId: 'ChIJreviewLevelToday00000', phrasing: true });
      draftFor = () => null;
      const { intel } = await cardWeek();
      assert.deepStrictEqual([intel.today.weekday, intel.today.peakScore], ['Mon', 48]);
      route = { mode: 'grounded', intentId: 'quiet_nights' };
      const r = await call('/api/venue/advisor/question', { question: 'How quiet will Monday be?' });
      assert.strictEqual(r.body.mode, 'template', r.body.text);
      assert.deepStrictEqual(r.body.text.split('\n'), [
        'In Flock\'s forecast for places like yours, Monday peaks around 9 PM at 48 on our 0 to 100 index.',
        `• ${kindForecast.unownDays(quietMove(), 'Monday')}`,
      ]);
      // The chip, which asks about the week, still says the week has no quiet day.
      const chip = await call('/api/venue/advisor/ask', { intentId: 'quiet_nights' });
      assert.strictEqual(chip.body.mode, 'refusal', chip.body.text);
      assert.match(chip.body.text, /no day stands out as quiet in the week ahead/);
    });
  } finally {
    Object.assign(CARD, saved);
  }
});

test('a block reads the card once: a weekend asked as the hour turns comes off one build, with one Places lookup', async () => {
  // A cold build that started before midnight and finished after it was read
  // twice until 2026-11-06, once for the week and once for today, from two
  // builds a day apart: "the busiest day this weekend is Saturday ... •
  // Saturday is close behind", Saturday's id twice, and two Places lookups.
  const realHourly = mlPredictor.predictHourlyForecast;
  mlPredictor.predictHourlyForecast = async (...args) => {
    await new Promise((resolve) => { setTimeout(resolve, 120); });
    return realHourly(...args);
  };
  try {
    await pinnedAt('2026-11-06T23:59:59.900Z', async () => {
      setUp({ placeId: 'ChIJreviewOneRead00000000' });
      const before = placesCalls;
      const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
      assert.ok(Date.now() > Date.parse('2026-11-07T00:00:00Z'), 'the build finished after midnight');
      assert.strictEqual(placesCalls - before, 1, 'one Places lookup for the block');
      const ids = r.body.sources.map((s) => s.id);
      assert.strictEqual(new Set(ids).size, ids.length, `a day named twice: ${r.body.text}`);
      // The build that started on Friday: today, Saturday and Sunday.
      assert.deepStrictEqual([...ids].sort(), ['typical_peak_2026-11-06', 'typical_peak_2026-11-07', 'typical_peak_2026-11-08']);
      assert.match(r.body.text, FRAMED);
    });
  } finally {
    mlPredictor.predictHourlyForecast = realHourly;
  }
});

// The day a question asks about, read against the venue's own today (review,
// 2026-11-06): "today" and "tonight" are today, "Sat" and "Fri" are days, and
// "next Monday" asked on a Monday is a week away, which nothing held stands for.

// A venue's own week of seven days from `start`, as buildWeekAhead walks them,
// and the corpus row that gives the venue its clock.
const ownWeekFrom = (start) => Array.from({ length: 7 }, (_, i) => {
  const date = addDays(start, i);
  const weekday = LONG[shortOf(date)];
  const score = CARD[shortOf(date)];
  return advisorFacts.makeFact({
    id: `peak_${date}`,
    value: { date, weekday, peakHour: 21, peakScore: score },
    source: 'model_holdout',
    asOf: `${start}T12:00:00Z`,
    predictionMethod: 'ml',
    unit: '0-100 index',
    label: advisorFacts.weekAheadPeakLabel({ weekday, hour: 21, score }),
  });
});
const CORPUS_ROW = Object.freeze({
  name: 'Thistle Room', latitude: 39.95, longitude: -75.16, venue_category: 'bar', google_types: ['bar'],
  price_level: 2, rating: 4.4, review_count: 320, timezone: 'UTC',
});

test('the day a question asks about, read off its words: whole day words, short forms written as days, today and tonight, tomorrow, and "next"', () => {
  const read = (q) => roostPlaybook.askedDay(q);
  // A short form is a day where it is written as one (2026-11-06); a
  // lower-case "sun" or "sat" is the word, whatever follows it.
  for (const [q, weekday] of [
    ['How busy will Sat be?', 'Saturday'], ['How\'s Fri looking?', 'Friday'], ['thurs night', 'Thursday'],
    ['is Tues slow', 'Tuesday'], ['Wed night', 'Wednesday'],
  ]) {
    assert.deepStrictEqual(read(q), { weekday, next: false }, q);
  }
  assert.strictEqual(read('sun brunch any good'), null);
  assert.deepStrictEqual(read('How busy will next Monday be?'), { weekday: 'Monday', next: true });
  // "Next week" belongs to the day beside it (second review, 2026-11-06).
  assert.deepStrictEqual(read('How busy will Monday be next week?'), { weekday: 'Monday', next: false, nextWeek: true });
  assert.deepStrictEqual(read('How do I fill wensdays?'), { weekday: 'Wednesday', next: false }, 'the owner\'s spelling put right');
  assert.deepStrictEqual(read('Saturdays are packed, how do I fill Tuesdays'), { weekday: 'Tuesday', next: false }, 'the clause that asks');
  // Two day words are both read; the route answers both (bothAnswer).
  assert.deepStrictEqual(read('How busy is Monday tonight?').several.map((w) => w.kind), ['weekday', 'today']);
  for (const q of ['Is tonight going to be slow?', 'How busy will we be today?', 'what about this evening']) {
    assert.deepStrictEqual(read(q), { today: true }, q);
  }
  assert.deepStrictEqual(read('how busy tmrw'), { tomorrow: true });
  assert.deepStrictEqual(read('How busy will the day after tomorrow be?'), { dayAfterTomorrow: true });
  for (const q of ['we sat down for an hour', 'the sun is out', 'c\'mon how busy', 'what does next weekend look like']) {
    assert.strictEqual(read(q), null, q);
    assert.strictEqual(roostPlaybook.namedWeekday(q), null, q);
  }
  assert.strictEqual(roostPlaybook.namedWeekday('How busy will Saturday be?'), 'Saturday');
  assert.strictEqual(roostPlaybook.namedWeekday('How busy will Sat be?'), 'Saturday');
});

test('the second review\'s misreadings: a name, a test, a short form written as the word, and "next week" away from the day are no days', () => {
  // Each read as a day until 2026-11-06 (the review's askedDayProbe).
  const read = (q) => roostPlaybook.askedDay(q);
  for (const q of [
    'Sun Devils fans pack the place on game days, how do I upsell them?',
    'How do I compete with the Sun Valley festival crowd?',
    'Mon Ami down the street is stealing our brunch crowd, what do I do?',
    'How do I attract students studying for the SAT?',
    'SAT prep groups come in after school, how do I keep them buying?',
    'SAT night?',
    'The Sun newspaper reviewed us, how do I use it?',
    'we got wed last month, can we do a private event?',
    'how busy will sat be',
    'Fri-yay! How do I keep the energy going?',
    'We sat down with the team, what should we change?',
  ]) {
    assert.strictEqual(read(q), null, q);
    assert.strictEqual(roostPlaybook.namedWeekday(q), null, q);
  }
  assert.deepStrictEqual(read('Sat through another slow night, how do I fill tonight?'), { today: true });
  assert.deepStrictEqual(read('Sun\'s out, should we open the patio tonight?'), { today: true });
  assert.deepStrictEqual(read('Sat down with my manager, how do I fill Tuesdays?'), { weekday: 'Tuesday', next: false });
  // Written where a day is written, a short form is that day (2026-11-06).
  for (const [q, weekday] of [['Sat?', 'Saturday'], ['MON', 'Monday'],
    ['Is it worth opening on Sun?', 'Sunday'], ['Can I get the Wed crowd back?', 'Wednesday'],
    ['C\'mon, give me something for Thurs', 'Thursday'], ['Thu night is dead, ideas?', 'Thursday'],
    ['Thanks! See you Fri.', 'Friday'], ['How busy will Sat be?', 'Saturday'], ['is Tues slow', 'Tuesday'],
    ['How\'s Fri looking?', 'Friday'], ['How busy will Sat Nov 14 be?', 'Saturday'],
  ]) {
    assert.deepStrictEqual(read(q), { weekday, next: false }, q);
  }
  // Two of them are two days, both answered.
  assert.deepStrictEqual(read('We are open Fri and Sat, how do I fill them?').several.map((w) => w.weekday), ['Friday', 'Saturday']);
  // In lower case "sat" and "sun" are the words, and "last Sat" is gone.
  for (const q of ['how busy will sat night be', 'sun brunch ideas?', 'How busy were we last Sat?']) {
    assert.strictEqual(read(q), null, q);
  }
  // "Next week" is the day beside it, and only that day.
  assert.deepStrictEqual(read('How busy will Friday be compared to next week?'), { weekday: 'Friday', next: false });
  assert.deepStrictEqual(read('Should I run the special Friday or wait until next week?'), { weekday: 'Friday', next: false });
  assert.deepStrictEqual(read('How busy will Friday next week be?'), { weekday: 'Friday', next: false, nextWeek: true });
  assert.deepStrictEqual(read('What about next week\'s Friday?'), { weekday: 'Friday', next: false, nextWeek: true });
  assert.deepStrictEqual(read('How busy will the Friday after next be?'), { weekday: 'Friday', next: false, afterNext: true });
  // Today's words are read as before; the route decides where they count.
  for (const q of ['My bartender quit this morning, what do I do?', 'Got a 1 star review today, how should I respond?']) {
    assert.deepStrictEqual(read(q), { today: true }, q);
  }
});

test('today and tonight are answered from today\'s entry, as today by name is, and Saturday is a day of the week: the bar on its Monday', async (t) => {
  const clock = pinClock(Date.parse('2026-11-09T16:00:00Z'));
  t.after(() => clock.restore());
  setUp({ placeId: 'ChIJreviewTonightBar00000', phrasing: true });
  draftFor = () => null;
  const { intel } = await cardWeek();
  assert.deepStrictEqual([intel.today.weekday, intel.today.peakScore], ['Mon', 48]);
  const lead = 'In Flock\'s forecast for places like yours, Monday peaks around 9 PM at 48 on our 0 to 100 index.';
  // Until 2026-11-06 the two typed peak questions got the week's answer
  // ("the busiest day this week is Saturday ...") and "Is tonight going to be
  // slow?" got the week's quietest day ("the quietest day this week is Sunday").
  for (const question of ['How busy will we be tonight?', 'How busy will we be today?']) {
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question });
    assert.deepStrictEqual(r.body.text.split('\n'), [lead, `• ${peakMove()}`], question);
  }
  route = { mode: 'grounded', intentId: 'quiet_nights' };
  let r = await call('/api/venue/advisor/question', { question: 'Is tonight going to be slow?' });
  assert.deepStrictEqual(r.body.text.split('\n'), [lead, `• ${kindForecast.unownDays(quietMove(), 'Monday')}`]);
  assert.ok(r.body.followUps.some((f) => f.text === 'How do I fill Mondays?'), JSON.stringify(r.body.followUps));
  // As advice, the model out. "How do I fill a slow night tonight?" led with
  // Sunday, the week's quietest day, and "How do I fill tonight?" with no
  // number at all, until 2026-11-06.
  route = { mode: 'advice', intentId: 'quiet_nights' };
  r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow night tonight?' });
  assert.ok(r.body.text.startsWith('In Flock\'s forecast for places like yours, Monday projects busiest around 9 PM, at 48 on our 0 to 100 index. Give Monday '), r.body.text);
  route = { mode: 'advice', intentId: 'tonight_outlook' };
  r = await call('/api/venue/advisor/question', { question: 'How do I fill tonight?' });
  assert.ok(r.body.text.startsWith('In Flock\'s forecast for places like yours, Monday projects busiest around 9 PM, at 48 on our 0 to 100 index. '), r.body.text);
  assert.ok(r.body.sources.some((s) => s.id === 'typical_peak_2026-11-09'), JSON.stringify(r.body.sources));
  // Today by its whole name, and a day of the card's week.
  route = { mode: 'grounded', intentId: 'peak_hours' };
  r = await call('/api/venue/advisor/question', { question: 'How busy will Monday be?' });
  assert.deepStrictEqual(r.body.text.split('\n'), [lead, `• ${peakMove()}`]);
  r = await call('/api/venue/advisor/question', { question: 'How busy will Saturday be?' });
  assert.strictEqual(r.body.text.split('\n')[0], 'In Flock\'s forecast for places like yours, Saturday peaks around 9 PM at 74 on our 0 to 100 index.');
});

test('a day past the week ahead is said to be, with or without crowd history: "next Monday" on a Monday, "Friday next week", "the Friday after next"', async () => {
  // "Next Monday" on a Monday read "Monday peaks around 9 PM at 48 on our 0
  // to 100 index." until the first review, and then the week's answer with
  // the Monday taken out; "How busy will Friday next week be?" on a Monday
  // answered with this Friday's 66 until the second (2026-11-06). Neither
  // said the day asked about is past the forecast, and a week answered with
  // a day taken out can name the wrong busiest day.
  const PAST = [
    ['How busy will next Monday be?', 'We can\'t answer that yet. Next Monday is past the seven days the forecast covers. It comes into them tomorrow.'],
    ['How busy will Friday next week be?', 'We can\'t answer that yet. Friday next week is past the seven days the forecast covers. It comes into them on Saturday.'],
    ['How busy will the Friday after next be?', 'We can\'t answer that yet. The Friday after next is past the seven days the forecast covers. It comes into them on Saturday.'],
  ];
  await pinnedAt('2026-11-09T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJreviewNextMondayBar00', phrasing: true });
    draftFor = () => null;
    for (const [question, text] of PAST) {
      for (const intentId of ['peak_hours', 'quiet_nights']) {
        route = { mode: 'grounded', intentId };
        const r = await call('/api/venue/advisor/question', { question });
        assert.deepStrictEqual([r.body.mode, r.body.text], ['refusal', text], `${intentId}: ${question}`);
      }
    }
    assert.ok(!modelCalls.some((c) => c.role === 'phrasing'), 'a refusal costs no model call');
    // As advice: no lead, rather than one about the week's quietest day
    // (it led with "Sunday projects as the quietest day this week" until
    // 2026-11-06), and no second read of the week.
    for (const intentId of ['quiet_nights', null]) {
      route = { mode: 'advice', intentId };
      const r = await call('/api/venue/advisor/question', { question: 'How do I fill next Monday?' });
      assert.strictEqual(r.body.mode, 'advice', r.body.text);
      assert.ok(!/projects/.test(r.body.text), `${intentId}: ${r.body.text}`);
      assert.ok(!r.body.sources.some((s) => /^typical_peak_/.test(s.id)), JSON.stringify(r.body.sources));
    }
    route = { mode: 'advice', intentId: 'peak_hours' };
    const staff = await call('/api/venue/advisor/question', { question: 'How should I staff next Monday?' });
    assert.ok(!/projects/.test(staff.body.text), staff.body.text);

    // A venue with crowd history: its week holds today's Monday, which is not
    // next Monday either, and the model is handed none of it. "Tonight" on
    // the same venue is today's Monday.
    setUp({ placeId: 'ChIJreviewNextMondayOwn00', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 }, phrasing: true });
    mlVenueRow = CORPUS_ROW;
    const realWeek = advisorFacts.buildWeekAhead;
    advisorFacts.buildWeekAhead = async () => ownWeekFrom('2026-11-09');
    try {
      draftFor = () => null;
      for (const [question, text] of PAST) {
        route = { mode: 'grounded', intentId: 'peak_hours' };
        const r = await call('/api/venue/advisor/question', { question });
        assert.deepStrictEqual([r.body.mode, r.body.text], ['refusal', text], question);
      }
      assert.ok(!modelCalls.some((c) => c.role === 'phrasing'), 'a refusal costs no model call');
      route = { mode: 'grounded', intentId: 'peak_hours' };
      const r = await call('/api/venue/advisor/question', { question: 'How busy will we be tonight?' });
      assert.strictEqual(r.body.text.split('\n')[0], 'Monday peaks around 9 PM at 48 on our 0 to 100 index.');
    } finally {
      advisorFacts.buildWeekAhead = realWeek;
    }
  });
  // On a Friday, Monday next week is in three days and is answered; Friday
  // next week is a week away.
  await pinnedAt('2026-11-13T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJreviewNextWeekFri0000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    let r = await call('/api/venue/advisor/question', { question: 'How busy will Monday next week be?' });
    assert.strictEqual(r.body.text.split('\n')[0], 'In Flock\'s forecast for places like yours, Monday peaks around 9 PM at 48 on our 0 to 100 index.');
    assert.ok(r.body.sources.some((s) => s.id === 'typical_peak_2026-11-16'), JSON.stringify(r.body.sources));
    r = await call('/api/venue/advisor/question', { question: 'How busy will Friday next week be?' });
    assert.strictEqual(r.body.text, 'We can\'t answer that yet. Friday next week is past the seven days the forecast covers. It comes into them tomorrow.');
    r = await call('/api/venue/advisor/question', { question: 'How busy will the Friday after next be?' });
    assert.strictEqual(r.body.text, 'We can\'t answer that yet. The Friday after next is past the seven days the forecast covers. It comes into them on Saturday next week.');
  });
});

// A weekend with nothing open, and next weekend (review, 2026-11-06).

// The weekend's weather line, as buildAroundYou writes one.
const weatherOn = (date) => advisorFacts.makeFact({
  id: `weather_${date}`,
  value: { date, weekday: LONG[shortOf(date)], conditions: 'clear sky', middayTempF: 60 },
  source: 'weather',
  asOf: '2026-11-08T12:00:00Z',
  label: `${LONG[shortOf(date)]} ${advisorFacts.shortDate(date)}: clear sky, around 60 F midday.`,
});

test('a venue with crowd history, shut on Sundays, on its Sunday: its curve shows nothing today or for the rest of the weekend, said plainly, then next weekend, never the weather alone', async () => {
  // The review's case: "Sunday Nov 8: clear sky, around 60 F midday." and
  // nothing else, until 2026-11-06, because one weather fact kept the week's
  // refusal out. The week here is the real builder's, over a curve with no
  // Sunday hours, so the shut day is the sentence it writes.
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJreviewShutSundayOwn00', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 } });
    mlVenueRow = CORPUS_ROW;
    for (let day = 1; day < 7; day += 1) {
      for (let hour = 17; hour <= 22; hour += 1) baselineRows.push({ day_of_week: day, hour, baseline: 40 + hour, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
    }
    const realPredict = mlPredictor.predictBusyness;
    const realAround = advisorFacts.buildAroundYou;
    mlPredictor.predictBusyness = async (_venue, _weather, ts) => ({ score: CARD[SHORT[new Date(ts).getDay()]], label: 'Moderate', predictionMethod: 'ml', modelVersion: 'test' });
    advisorFacts.buildAroundYou = async () => ['2026-11-08', '2026-11-13', '2026-11-14'].map(weatherOn);
    try {
      const week = await advisorFacts.buildWeekAhead(await advisorFacts.getVenueContext(1), { userId: 1 });
      assert.ok(advisorFacts.isShutDay(week[0]), JSON.stringify(week[0]));
      assert.ok(week.slice(1).every((e) => !advisorFacts.isRefusal(e)), 'the rest of the week is scored');
      const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
      assert.strictEqual(r.body.mode, 'template', r.body.text);
      assert.deepStrictEqual(r.body.text.split('\n'), [
        'Your Google profile\'s curve shows no activity for the rest of this weekend. No day stands out next weekend: every day peaks between 66 and 74 on our 0 to 100 index.',
        '• Next Sunday is past the seven days the forecast covers.',
        '• Friday Nov 13: clear sky, around 60 F midday.',
        '• Saturday Nov 14: clear sky, around 60 F midday.',
      ]);
      assert.deepStrictEqual(r.body.sources.map((s) => [s.id, s.source]), [
        ['weekend_closed', 'google_baseline'], ['peak_2026-11-14', 'model_holdout'], ['peak_2026-11-13', 'model_holdout'],
        ['next_weekend_past_forecast', 'model_holdout'], ['weather_2026-11-13', 'weather'], ['weather_2026-11-14', 'weather'],
      ]);
      // Today, the same way. With today's weather line beside the refusal it
      // read "Sunday Nov 8: clear sky, around 60 F midday." and nothing else
      // until 2026-11-06.
      const today = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
      assert.strictEqual(today.body.mode, 'template', today.body.text);
      assert.strictEqual(today.body.text, 'Your Google profile\'s curve shows no activity today.');
      assert.deepStrictEqual(today.body.sources.map((s) => [s.id, s.source]), [['today_closed', 'google_baseline']]);
    } finally {
      mlPredictor.predictBusyness = realPredict;
      advisorFacts.buildAroundYou = realAround;
    }
  });
});

test('a street line on a day the venue is shut is left out of its weekend: on its Saturday, Sunday\'s weather goes', async () => {
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJreviewShutSundaySat00', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 } });
    mlVenueRow = CORPUS_ROW;
    for (let day = 1; day < 7; day += 1) {
      for (let hour = 17; hour <= 22; hour += 1) baselineRows.push({ day_of_week: day, hour, baseline: 40 + hour, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
    }
    const realPredict = mlPredictor.predictBusyness;
    const realAround = advisorFacts.buildAroundYou;
    mlPredictor.predictBusyness = async (_venue, _weather, ts) => ({ score: CARD[SHORT[new Date(ts).getDay()]], label: 'Moderate', predictionMethod: 'ml', modelVersion: 'test' });
    advisorFacts.buildAroundYou = async () => ['2026-11-07', '2026-11-08'].map(weatherOn);
    try {
      const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
      const lines = r.body.text.split('\n');
      assert.match(lines[0], /^Saturday projects busiest around \d{1,2} [AP]M, at 74 on our 0 to 100 index\.$/, r.body.text);
      assert.deepStrictEqual(lines.slice(1), ['• Saturday Nov 7: clear sky, around 60 F midday.'], r.body.text);
      assert.ok(!r.body.sources.some((s) => s.id === 'weather_2026-11-08'), JSON.stringify(r.body.sources));
    } finally {
      mlPredictor.predictBusyness = realPredict;
      advisorFacts.buildAroundYou = realAround;
    }
  });
});

test('a weekend with no open day for another reason answers with its own refusals, not with the weather', async () => {
  // A venue whose weekend days were scored by category rules answered with
  // the weekend's weather alone until 2026-11-06.
  setUp({ placeId: 'ChIJreviewWeekendRefused0', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 } });
  mlVenueRow = CORPUS_ROW;
  const realWeek = advisorFacts.buildWeekAhead;
  const realAround = advisorFacts.buildAroundYou;
  const start = '2026-11-09';
  advisorFacts.buildWeekAhead = async () => ownWeekFrom(start).map((f) => (['Fri', 'Sat', 'Sun'].includes(shortOf(f.value.date))
    ? advisorFacts.makeRefusal({
      id: `refuse_peak_${f.value.date}`,
      reason: `${f.value.weekday} was scored by category rules, not by the model, so the number would be the same for every venue like yours. We do not present that as your forecast.`,
      whatWouldUnlock: 'A model scored day for this venue. The baseline curve exists, so this is usually transient.',
    })
    : f));
  advisorFacts.buildAroundYou = async () => ['2026-11-13', '2026-11-14', '2026-11-15'].map(weatherOn);
  try {
    const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.strictEqual(r.body.mode, 'refusal', r.body.text);
    assert.match(r.body.text, /^We can't answer that yet\. Friday was scored by category rules/);
    assert.ok(!/clear sky/.test(r.body.text), r.body.text);
  } finally {
    advisorFacts.buildWeekAhead = realWeek;
    advisorFacts.buildAroundYou = realAround;
  }
});

test('a bakery shut every weekend day, asked on a Monday: closed this weekend, and nothing after it, since next weekend is past the forecast', async () => {
  await pinnedAt('2026-11-09T15:00:00Z', async () => {
    bakeryAt({ placeId: 'ChIJreviewShutWeekend0000' });
    placePeriods = periodsOf({ 1: [6, 14], 2: [6, 14], 3: [6, 14], 4: [6, 14] });
    const r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.strictEqual(r.body.mode, 'template', r.body.text);
    assert.strictEqual(r.body.text, 'Your Google listing has you closed this weekend.');
    assert.deepStrictEqual(r.body.sources.map((s) => [s.id, s.source]), [['weekend_closed', 'google_listing']]);
  });
});

test('"next weekend" is the one after this weekend from Friday to Sunday: the days of it the forecast holds, said as next weekend\'s, or a plain refusal when it holds none', async () => {
  // It answered about this weekend until 2026-11-06.
  const question = 'What does next weekend look like?';
  route = { mode: 'grounded', intentId: 'weekend_outlook' };
  // On a Friday next weekend is past the seven days the forecast covers. From
  // Monday to Thursday it is the coming weekend (the next test).
  await pinnedAt('2026-11-13T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJreviewNextWeekendFri0', phrasing: true });
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    draftFor = () => null;
    for (const q of [question, 'How busy will the next weekend be?', 'What about the following weekend?']) {
      const r = await call('/api/venue/advisor/question', { question: q });
      assert.strictEqual(r.body.mode, 'refusal', r.body.text);
      assert.strictEqual(r.body.text, 'We can\'t answer that yet. Next weekend is past the seven days the forecast covers. Its Friday comes into them on Saturday.', q);
    }
    const after = await call('/api/venue/advisor/question', { question: 'What about the weekend after next?' });
    assert.strictEqual(after.body.text, 'We can\'t answer that yet. The weekend after next is past the seven days the forecast covers. Its Friday comes into them the Saturday before it.');
    // "This weekend" is this one, as before.
    const now = await call('/api/venue/advisor/question', { question: 'What does this weekend look like?' });
    assert.match(now.body.text, /^In Flock's forecast for places like yours, the busiest day this weekend is Saturday/);
  });
  // On a Sunday it holds next Friday and Saturday, said as next weekend's,
  // and the phrasing model is handed those two days, each marked so.
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJreviewNextWeekendSun0', phrasing: true });
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    let payload = null;
    draftFor = (role, p) => { payload = p; return null; };
    const r = await call('/api/venue/advisor/question', { question });
    assert.strictEqual(r.body.text, [
      'In Flock\'s forecast for places like yours, no day stands out next weekend: every day peaks between 66 and 74 on our 0 to 100 index.',
      '• Next Sunday is past the seven days the forecast covers.',
    ].join('\n'));
    assert.deepStrictEqual(r.body.sources.map((s) => s.id).sort(), ['next_weekend_past_forecast', 'typical_peak_2026-11-13', 'typical_peak_2026-11-14']);
    assert.deepStrictEqual(handedDates(payload), ['2026-11-13', '2026-11-14']);
    assert.ok(payloadFacts(payload).filter((f) => f.id.startsWith('typical_peak_')).every((f) => advisorFacts.isNextWeekendDay(f)), payload);
  });
  // On a Saturday it holds next Friday alone: the answer is about next
  // Friday, and then says plainly that next Saturday and Sunday are past the
  // forecast. It read "Friday peaks around 9 PM at 66" and nothing more,
  // until 2026-11-06.
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJreviewNextWeekendSat0', phrasing: true });
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    draftFor = () => null;
    const r = await call('/api/venue/advisor/question', { question });
    assert.strictEqual(r.body.text, [
      'In Flock\'s forecast for places like yours, next Friday peaks around 9 PM at 66 on our 0 to 100 index.',
      '• Next Saturday and Sunday are past the seven days the forecast covers.',
    ].join('\n'));
    assert.deepStrictEqual(r.body.sources.map((s) => [s.id, s.source]), [
      ['typical_peak_2026-11-13', 'category_pattern'], ['next_weekend_past_forecast', 'category_pattern'],
    ]);
  });
  // A venue with crowd history reads it the same way, on its Sunday and on
  // its Saturday.
  for (const [at, start, text, ids] of [
    ['2026-11-08T16:00:00Z', '2026-11-08', [
      'No day stands out next weekend: every day peaks between 66 and 74 on our 0 to 100 index.',
      '• Next Sunday is past the seven days the forecast covers.',
    ], ['next_weekend_past_forecast', 'peak_2026-11-13', 'peak_2026-11-14']],
    ['2026-11-07T16:00:00Z', '2026-11-07', [
      'Next Friday peaks around 9 PM at 66 on our 0 to 100 index.',
      '• Next Saturday and Sunday are past the seven days the forecast covers.',
    ], ['next_weekend_past_forecast', 'peak_2026-11-13']],
  ]) {
    await pinnedAt(at, async () => {
      setUp({ placeId: `ChIJreviewNextWeekendOwn${start.slice(-1)}`, extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 }, phrasing: true });
      mlVenueRow = CORPUS_ROW;
      route = { mode: 'grounded', intentId: 'weekend_outlook' };
      draftFor = () => null;
      const realWeek = advisorFacts.buildWeekAhead;
      const realAround = advisorFacts.buildAroundYou;
      advisorFacts.buildWeekAhead = async () => ownWeekFrom(start);
      advisorFacts.buildAroundYou = async () => [];
      try {
        const r = await call('/api/venue/advisor/question', { question });
        assert.strictEqual(r.body.text, text.join('\n'), at);
        assert.deepStrictEqual(r.body.sources.map((s) => s.id).sort(), ids, at);
      } finally {
        advisorFacts.buildWeekAhead = realWeek;
        advisorFacts.buildAroundYou = realAround;
      }
    });
  }
});

test('a venue on a half-hour offset reads today\'s card after its own midnight, though the server\'s hour has not turned', async () => {
  // Kolkata is UTC+5:30: 18:20 UTC is 11:50 PM on Friday there, and 18:40 UTC
  // is 12:10 AM on Saturday, inside one server hour. Until 2026-11-06 the
  // second read answered with Friday's card for up to half an hour.
  let first = null;
  await pinnedAt('2026-11-06T18:20:00Z', async () => {
    setUp({ placeId: 'ChIJreviewHalfHourZone000' });
    placeZone = 'Asia/Kolkata';
    placeOffset = 330;
    first = (await cardWeek()).intel;
  });
  assert.deepStrictEqual([first.today.date, first.today.weekday], ['2026-11-06', 'Fri']);
  await pinnedAt('2026-11-06T18:40:00Z', async () => {
    const before = placesCalls;
    const { intel } = await cardWeek();
    assert.deepStrictEqual([intel.today.date, intel.today.weekday], ['2026-11-07', 'Sat']);
    assert.strictEqual(placesCalls - before, 1, 'built again, once');
    await cardWeek();
    assert.strictEqual(placesCalls - before, 1, 'and kept');
    const weekend = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.deepStrictEqual(weekend.body.sources.map((s) => s.id).sort(), ['typical_peak_2026-11-07', 'typical_peak_2026-11-08']);
  });
});

// ── 13. The second review of section 11 (2026-11-06) ────────────────────────
//
// The day a question asks about is read where a day is written, and today's
// words set it only for a question about the day's crowd; a day past the week
// ahead is said to be; in the small hours tonight is the night still running;
// the ranking check reads the day, not the night's hours; a shut weekend's
// draft may open on its listing's own line; "next weekend" from Monday to
// Thursday is the coming one; and a busy today is never given a fill move.

// A listing open 8 PM to 2 AM on `days` (0 is Sunday): each night runs into
// the small hours of the next day.
const overnight = (days) => days.map((d) => ({ open: { day: d, hour: 20, minute: 0 }, close: { day: (d + 1) % 7, hour: 2, minute: 0 } }));

// The server's clock as Railway runs it, UTC, while `fn` runs: a venue's own
// week is walked on the server's calendar (advisorFacts.buildWeekAhead).
const SYSTEM_ZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
async function onUtc(fn) {
  process.env.TZ = 'UTC';
  try {
    return await fn();
  } finally {
    process.env.TZ = SYSTEM_ZONE;
  }
}

test('words that only look like days lead with no day, and today\'s words set the day only for a question about the day\'s crowd: the bar on its Monday', async () => {
  await pinnedAt('2026-11-09T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr4MisreadMon00000000', phrasing: true });
    draftFor = () => null;
    await cardWeek();
    // Each opened on a forecast for a day nobody asked about until 2026-11-06:
    // the week's quietest Sunday, Saturday's peak, or today's, and the last
    // two read the week a second time to do it.
    for (const [intentId, question] of [
      [null, 'Sun Devils fans pack the place on game days, how do I upsell them?'],
      [null, 'How do I compete with the Sun Valley festival crowd?'],
      [null, 'Mon Ami down the street is stealing our brunch crowd, what do I do?'],
      [null, 'How do I attract students studying for the SAT?'],
      [null, 'Sat through another slow night, how do I fill tonight?'],
      ['tonight_outlook', 'My bartender quit this morning, what do I do?'],
      [null, 'Got a 1 star review today, how should I respond?'],
    ]) {
      route = { mode: 'advice', intentId };
      const reads = countCardReads();
      let r;
      try {
        r = await call('/api/venue/advisor/question', { question });
      } finally {
        reads.restore();
      }
      assert.strictEqual(r.body.mode, 'advice', r.body.text);
      assert.ok(!/projects/.test(r.body.text), `${question}: ${r.body.text}`);
      assert.ok(!r.body.sources.some((s) => /^typical_peak_/.test(s.id)), `${question}: ${JSON.stringify(r.body.sources)}`);
      assert.strictEqual(reads.reads(), intentId ? 1 : 0, `${question}: the card read ${reads.reads()} times`);
    }
    // A question about tonight's crowd, routed to a day, still leads with
    // tonight: "Sat through another slow night" opens a sentence and is no
    // Saturday.
    const lead = 'In Flock\'s forecast for places like yours, Monday projects busiest around 9 PM, at 48 on our 0 to 100 index. ';
    for (const [intentId, question] of [
      ['tonight_outlook', 'How do I fill tonight?'],
      ['quiet_nights', 'Sat through another slow night, how do I fill tonight?'],
      ['peak_hours', 'I am short staffed tonight, what do I cut?'],
    ]) {
      route = { mode: 'advice', intentId };
      const r = await call('/api/venue/advisor/question', { question });
      assert.ok(r.body.text.startsWith(lead), `${question}: ${r.body.text}`);
      assert.ok(r.body.sources.some((s) => s.id === 'typical_peak_2026-11-09'), JSON.stringify(r.body.sources));
    }
    // Typed as a question about the venue's numbers, "Sun" and "SAT" in the
    // same misreadings name no day either: the week's answer, as for any
    // question that names none.
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const week = await call('/api/venue/advisor/question', { question: 'When do we peak this week?' });
    const devils = await call('/api/venue/advisor/question', { question: 'When do the Sun Devils fans peak this week?' });
    assert.strictEqual(devils.body.text, week.body.text);
  });
});

test('"next week" belongs to the day beside it: on a Friday, "Friday compared to next week" is today', async () => {
  // Until 2026-11-06 "next week" anywhere in a question made the day a week
  // out, so this Friday was taken out of the week and the answer was the
  // week's, and the advice led with Sunday.
  await pinnedAt('2026-11-13T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr4FridayNextWeek0000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'How busy will Friday be compared to next week?' });
    assert.deepStrictEqual(r.body.text.split('\n'), ['In Flock\'s forecast for places like yours, Friday peaks around 9 PM at 66 on our 0 to 100 index.', `• ${peakMove()}`]);
    assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['typical_peak_2026-11-13', 'roost_playbook']);
    route = { mode: 'advice', intentId: 'quiet_nights' };
    const a = await call('/api/venue/advisor/question', { question: 'Should I run the special Friday or wait until next week?' });
    assert.ok(a.body.text.startsWith('In Flock\'s forecast for places like yours, Friday projects busiest around 9 PM, at 66 on our 0 to 100 index. '), a.body.text);
  });
});

test('"next weekend" from Monday to Thursday is the coming weekend, said with its dates, for venues with and without crowd history; the one after it is past the forecast', async () => {
  // It was refused from Monday to Friday until 2026-11-06: "Next weekend is
  // past the seven days the forecast covers."
  const card = [
    'In Flock\'s forecast for places like yours, the busiest day of the coming weekend, Nov 13 to 15, is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.',
    '• Friday is close behind, around 9 PM at 66.',
    '• Sunday is the quietest, around 9 PM at 45.',
  ].join('\n');
  for (let d = 0; d < 4; d += 1) {
    await pinnedAt(`2026-11-${String(9 + d).padStart(2, '0')}T16:00:00Z`, async () => {
      setUp({ placeId: `ChIJr4ComingWeekend${d}0000`, phrasing: true });
      let payload = null;
      draftFor = (role, p) => { payload = p; return null; };
      route = { mode: 'grounded', intentId: 'weekend_outlook' };
      for (const q of ['What does next weekend look like?', 'How busy will the next weekend be?']) {
        const r = await call('/api/venue/advisor/question', { question: q });
        assert.strictEqual(r.body.text, card, `${d}: ${q}`);
        assert.deepStrictEqual(r.body.sources.map((s) => s.id).sort(), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14', 'typical_peak_2026-11-15']);
        // The model is handed the same three days, each marked with the
        // weekend's dates.
        assert.deepStrictEqual(handedDates(payload), ['2026-11-13', '2026-11-14', '2026-11-15']);
        assert.ok(payloadFacts(payload).filter((f) => f.id.startsWith('typical_peak_')).every((f) => typeof f.note === 'string'
          && f.note.includes('This day is in the coming weekend, Nov 13 to 15, the weekend the question calls next weekend.')), payload);
      }
      // "This weekend" is said as before, and the weekend after the coming
      // one is past the forecast; its Friday comes in on Saturday.
      const now = await call('/api/venue/advisor/question', { question: 'What does this weekend look like?' });
      assert.match(now.body.text, /^In Flock's forecast for places like yours, the busiest day this weekend is Saturday/);
      for (const [q, reason] of [['What about the weekend after next?', 'The weekend after next'], ['What about the following weekend?', 'Next weekend']]) {
        const r = await call('/api/venue/advisor/question', { question: q });
        assert.strictEqual(r.body.text, `We can't answer that yet. ${reason} is past the seven days the forecast covers. Its Friday comes into them on Saturday.`, `${d}: ${q}`);
      }
    });
  }
  // With crowd history, on its Monday.
  await pinnedAt('2026-11-09T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr4ComingWeekendOwn000', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 }, phrasing: true });
    draftFor = () => null;
    mlVenueRow = CORPUS_ROW;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const realWeek = advisorFacts.buildWeekAhead;
    const realAround = advisorFacts.buildAroundYou;
    advisorFacts.buildWeekAhead = async () => ownWeekFrom('2026-11-09');
    advisorFacts.buildAroundYou = async () => [];
    try {
      const r = await call('/api/venue/advisor/question', { question: 'What does next weekend look like?' });
      assert.strictEqual(r.body.text, [
        'Your busiest day of the coming weekend, Nov 13 to 15, is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.',
        '• Friday is close behind, around 9 PM at 66.',
        '• Sunday is the quietest, around 9 PM at 45.',
      ].join('\n'));
    } finally {
      advisorFacts.buildWeekAhead = realWeek;
      advisorFacts.buildAroundYou = realAround;
    }
  });
  // A coming weekend with nothing open says so, with its dates.
  await pinnedAt('2026-11-09T15:00:00Z', async () => {
    bakeryAt({ placeId: 'ChIJr4ComingWeekendShut00' });
    placePeriods = periodsOf({ 1: [6, 14], 2: [6, 14], 3: [6, 14], 4: [6, 14] });
    process.env.ADVISOR_PHRASING_ENABLED = 'true';
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'What does next weekend look like?' });
    assert.strictEqual(r.body.text, 'Your Google listing has you closed over the coming weekend, Nov 13 to 15.');
    assert.deepStrictEqual(r.body.sources.map((s) => [s.id, s.source]), [['weekend_closed', 'google_listing']]);
  });
});

test('in the small hours a bar with no crowd history, listed until 2 AM, is never told it is closed while it is open', async () => {
  // No crowd history, listed Tuesday to Saturday, 8 PM to 2 AM: at 1 AM on
  // Sunday, Saturday night is still running. It was told "Your Google listing
  // has you closed today." and "closed for the rest of this weekend" until
  // 2026-11-06.
  await pinnedAt('2026-11-08T01:00:00Z', async () => {
    setUp({ placeId: 'ChIJr4NightRunningBar000' });
    placePeriods = overnight([2, 3, 4, 5, 6]);
    const { intel } = await cardWeek();
    assert.deepStrictEqual([intel.today.weekday, intel.today.closed, intel.today.nightInProgress], ['Sun', true, true]);
    const today = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
    assert.strictEqual(today.body.text, 'Your Google listing has you closed after tonight.');
    assert.deepStrictEqual(today.body.sources.map((s) => [s.id, s.source]), [['today_closed', 'google_listing']]);
    const weekend = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.ok(weekend.body.text.startsWith('Your Google listing has you closed for the rest of this weekend after tonight. In Flock\'s forecast for places like yours, '), weekend.body.text);
    assert.ok(!/closed today|closed for the rest of this weekend\./.test(`${today.body.text} ${weekend.body.text}`));
  });
  // Later that Sunday the night is over: closed today, as before.
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr4NightOverBar000000' });
    placePeriods = overnight([2, 3, 4, 5, 6]);
    const { intel } = await cardWeek();
    assert.deepStrictEqual([intel.today.closed, intel.today.nightInProgress], [true, undefined]);
    assert.strictEqual((await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' })).body.text, 'Your Google listing has you closed today.');
    assert.ok((await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' })).body.text.startsWith('Your Google listing has you closed for the rest of this weekend. '));
  });
});

test('in the small hours a venue with crowd history reads its weekend and "tonight" from the night still running, as its today chip does', async () => {
  // A venue with crowd history open to 1 AM, its Sunday evening shut, so
  // Sunday has only Saturday night's small hours. At 12:30 AM on Sunday its
  // weekend said "Your Google profile's curve shows no activity for the rest
  // of this weekend" while its today chip said Saturday at 74, and at 12:30 AM
  // on Saturday "How busy will we be tonight?" answered Saturday while the
  // chip answered Friday night (until 2026-11-06).
  await onUtc(async () => {
    for (const [iso, night, nightDate] of [
      ['2026-11-08T00:30:00Z', 'Saturday', '2026-11-07'],
      ['2026-11-07T00:30:00Z', 'Friday night', '2026-11-06'],
    ]) {
      await pinnedAt(iso, async () => {
        setUp({ placeId: `ChIJr4CorpusNight${iso.slice(8, 10)}0000000`, extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 }, phrasing: true });
        draftFor = () => null;
        mlVenueRow = CORPUS_ROW;
        for (let day = 1; day <= 6; day += 1) {
          for (let hour = 18; hour <= 23; hour += 1) baselineRows.push({ day_of_week: day, hour, baseline: 40 + hour, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
          for (const hour of [0, 1]) baselineRows.push({ day_of_week: (day + 1) % 7, hour, baseline: 60, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
        }
        const realPredict = mlPredictor.predictBusyness;
        const realAround = advisorFacts.buildAroundYou;
        mlPredictor.predictBusyness = async (_venue, _weather, ts) => ({ score: CARD[SHORT[new Date(ts).getUTCDay()]], label: 'Moderate', predictionMethod: 'ml', modelVersion: 'test' });
        advisorFacts.buildAroundYou = async () => [];
        try {
          const chip = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
          assert.ok(chip.body.text.startsWith(`${night} projects busiest around `), `${iso}: ${chip.body.text}`);
          assert.deepStrictEqual(chip.body.sources.map((s) => s.id), [`peak_${nightDate}`], iso);
          route = { mode: 'grounded', intentId: 'peak_hours' };
          const typed = await call('/api/venue/advisor/question', { question: 'How busy will we be tonight?' });
          assert.ok(typed.body.text.startsWith(`${night} peaks around `), `${iso}: ${typed.body.text}`);
          assert.strictEqual(typed.body.sources[0].id, `peak_${nightDate}`, iso);
          const weekend = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
          assert.ok(!/no activity/.test(weekend.body.text), `${iso}: ${weekend.body.text}`);
          assert.ok(weekend.body.sources.some((s) => s.id === `peak_${nightDate}`), `${iso}: ${JSON.stringify(weekend.body.sources)}`);
        } finally {
          mlPredictor.predictBusyness = realPredict;
          advisorFacts.buildAroundYou = realAround;
        }
      });
    }
  });
});

test('the ranking check passes ordinary drafts about the night itself, routed through the bar on its Monday', async () => {
  // Each went to the template until 2026-11-06 (the review's R2-C).
  await pinnedAt('2026-11-09T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr4RankCheck000000000', phrasing: true });
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const lead = (f) => `Flock's forecast for places like yours has Monday peaking around {{fact:${idFor(f, 'Monday', 'hour')}}} at {{fact:${idFor(f, 'Monday', 'score')}}} on our index.`;
    for (const point of [
      (f) => `Put your best bartender on before {{fact:${idFor(f, 'Monday', 'hour')}}}.`,
      () => 'Most guests tonight will arrive after 8 PM, so prep the bar before then.',
      () => 'Keep the menu to your top sellers tonight so the bar keeps moving.',
      () => 'Monday is a good night to test a small special, since the room has space before the peak.',
    ]) {
      draftFor = (role, p) => ({ answer: lead(payloadFacts(p)), points: [point(payloadFacts(p))] });
      const r = await call('/api/venue/advisor/question', { question: 'How busy will we be tonight?' });
      assert.strictEqual(r.body.mode, 'phrased', r.body.text);
    }
    // Ranking the day still goes, whichever day the draft names.
    draftFor = (role, p) => ({ answer: lead(payloadFacts(p)), points: ['That makes it the quietest night of the week.'] });
    const ranked = await call('/api/venue/advisor/question', { question: 'How busy will we be tonight?' });
    assert.strictEqual(ranked.body.mode, 'template', ranked.body.text);
  });
});

test('a shut weekend\'s draft may open on its listing\'s own line, and the forecast after it still opens on whose it is', async () => {
  // Every draft for it was discarded until 2026-11-06: its first sentence
  // was the listing's, and the rule read only the first sentence.
  await pinnedAt('2026-11-08T15:00:00Z', async () => {
    bakeryAt({ placeId: 'ChIJr4ListingFirst000000', shut: 0 });
    process.env.ADVISOR_PHRASING_ENABLED = 'true';
    const shutLine = 'Your Google listing has you closed for the rest of this weekend.';
    let handed = null;
    const run = async (draft) => {
      draftFor = (role, p) => { handed = payloadFacts(p); return draft(handed); };
      return call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    };
    const framed = (f) => `Flock's forecast for places like yours has next Saturday peaking around {{fact:${idFor(f, 'Saturday', 'hour')}}} at {{fact:${idFor(f, 'Saturday', 'score')}}} on our index.`;
    const r = await run((f) => ({ answer: shutLine, points: [framed(f)] }));
    assert.strictEqual(r.body.mode, 'phrased', r.body.text);
    assert.strictEqual(r.body.text.split('\n')[0], shutLine);
    assert.ok(r.body.sources.some((s) => s.id === 'weekend_closed' && s.source === 'google_listing'), JSON.stringify(r.body.sources));
    // The model is handed the listing's line and the line for next weekend's
    // days past the forecast to say, as `says`.
    assert.ok(handed.filter((f) => f.id.startsWith('weekend_closed_')).every((f) => f.says === shutLine), JSON.stringify(handed));
    assert.ok(handed.filter((f) => f.id.startsWith('next_weekend_past_forecast_')).every((f) => f.says === 'Next Sunday is past the seven days the forecast covers.'), JSON.stringify(handed));
    assert.ok(handed.filter((f) => f.id.startsWith('typical_peak_')).every((f) => !('says' in f)));
    // The template, as before, for a forecast after it that does not open on
    // whose it is, a line that is not the listing's own, and a draft that
    // cites no fact (the review's: its "Next Friday and Saturday are the next
    // days you open" is not so for a bakery open on Monday).
    for (const draft of [
      (f) => ({ answer: shutLine, points: [`Next Saturday peaks around {{fact:${idFor(f, 'Saturday', 'hour')}}} at {{fact:${idFor(f, 'Saturday', 'score')}}} on our index.`] }),
      (f) => ({ answer: 'Your Google listing shows you shut for the rest of the weekend.', points: [framed(f)] }),
      () => ({ answer: shutLine, points: ['Next Friday and Saturday are the next days you open.'] }),
    ]) {
      const t = await run(draft);
      assert.strictEqual(t.body.mode, 'template', t.body.text);
      assert.ok(t.body.text.startsWith(`${shutLine} In Flock's forecast for places like yours, `), t.body.text);
    }
  });
  // The contract teaches all of it.
  for (const taught of [
    'A fact whose source is google_listing is the venue\'s opening hours as its Google listing gives them.',
    'open the answer with its says, word for word',
    'A shut day is closed, never quiet, slow or the quietest.',
    'A day whose note says it is in next weekend belongs to next weekend',
    'call that weekend the coming weekend, with the dates its note gives',
  ]) {
    assert.ok(SYSTEM_PROMPT.includes(taught), taught);
  }
});

test('a busy today asked about on the quiet-days chip gets the busy-day move, from the template and for the phrasing model: the bar on its Saturday', async () => {
  // "How quiet will Saturday be?" on Saturday, at 74 the week's high, ended
  // on "Give Saturday one recurring reason to visit" until 2026-11-06.
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr4BusyTodayQuiet00000', phrasing: true });
    let payload = null;
    draftFor = (role, p) => { payload = p; return null; };
    route = { mode: 'grounded', intentId: 'quiet_nights' };
    const r = await call('/api/venue/advisor/question', { question: 'How quiet will Saturday be?' });
    assert.deepStrictEqual(r.body.text.split('\n'), [
      'In Flock\'s forecast for places like yours, Saturday peaks around 9 PM at 74 on our 0 to 100 index.',
      `• ${peakMove()}`,
    ]);
    assert.ok(r.body.followUps.some((f) => f.kind === 'question' && f.text === 'How do I handle the rush without losing covers?'), JSON.stringify(r.body.followUps));
    const move = payload.split('\n').slice(payload.split('\n').findIndex((l) => l.startsWith('PLAYBOOK MOVE')) + 1)[0];
    assert.strictEqual(JSON.parse(move).move, peakMove());
    assert.ok(!/recurring reason|fill/i.test(move), move);
  });
});

test('a level stretch whose days peak alike says the one number, and names every day as a source', () => {
  const hourOf = venueDashboardRouter.hourOfLabel;
  const intel = {
    ...DEMO_INTEL,
    week: [['2026-11-13', 'Fri', 74, '9 PM'], ['2026-11-14', 'Sat', 74, '9 PM']]
      .map(([date, weekday, peakScore, peakHour]) => ({ date, weekday, peakScore, peakHour, method: 'rule_engine_no_baseline' })),
  };
  const facts = advisorFacts.projectionFacts(intel, { hourOf });
  const out = advisorPhrasing.renderTemplate({ intent: 'weekend_outlook', facts });
  assert.strictEqual(out.text, 'In Flock\'s forecast for places like yours, no day stands out this weekend: every day peaks at 74 on our 0 to 100 index.');
  assert.deepStrictEqual(out.sources.map((s) => s.id), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14']);
});

test('a weekday the weekend\'s route is asked about that this weekend does not hold is answered from the week ahead, and one past it is said to be', async () => {
  // Until the final review (2026-11-06), on its Saturday "How busy will
  // Friday be?" routed to the weekend got "the busiest day this weekend is
  // Saturday", on its Sunday "How busy will Saturday be?" got Sunday's line,
  // and "How busy will next Saturday be?" on a Saturday got this weekend.
  const kind = 'In Flock\'s forecast for places like yours, ';
  let n = 0;
  for (const [iso, question, lead, source] of [
    ['2026-11-07T16:00:00Z', 'How busy will Friday be?', `${kind}Friday peaks around 9 PM at 66 on our 0 to 100 index.`, 'typical_peak_2026-11-13'],
    ['2026-11-08T16:00:00Z', 'How busy will Friday be this weekend?', `${kind}Friday peaks around 9 PM at 66 on our 0 to 100 index.`, 'typical_peak_2026-11-13'],
    ['2026-11-08T16:00:00Z', 'How busy will Saturday be?', `${kind}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`, 'typical_peak_2026-11-14'],
    ['2026-11-09T16:00:00Z', 'How busy will Tuesday be?', `${kind}Tuesday peaks around 9 PM at 48 on our 0 to 100 index.`, 'typical_peak_2026-11-10'],
    // A day this weekend holds is still answered from the weekend.
    ['2026-11-07T16:00:00Z', 'How busy will Sunday be?', `${kind}Sunday peaks around 9 PM at 45 on our 0 to 100 index.`, 'typical_peak_2026-11-08'],
    ['2026-11-09T16:00:00Z', 'How busy will Saturday be?', `${kind}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`, 'typical_peak_2026-11-14'],
  ]) {
    n += 1;
    await pinnedAt(iso, async () => {
      setUp({ placeId: `ChIJr5WeekendNamedDay${String(n).padStart(2, '0')}00`, phrasing: true });
      draftFor = () => null;
      route = { mode: 'grounded', intentId: 'weekend_outlook' };
      const r = await call('/api/venue/advisor/question', { question });
      assert.strictEqual(r.body.text.split('\n')[0], lead, `${iso}: ${question}: ${r.body.text}`);
      assert.strictEqual(r.body.sources[0].id, source, `${iso}: ${question}`);
    });
  }
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr5WeekendNextSatBar00', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    let r = await call('/api/venue/advisor/question', { question: 'How busy will next Saturday be?' });
    assert.deepStrictEqual([r.body.mode, r.body.text], ['refusal', 'We can\'t answer that yet. Next Saturday is past the seven days the forecast covers. It comes into them tomorrow.']);
    // A day of next weekend is that day (2026-11-06): on a Saturday, next
    // weekend's Saturday is past the seven days.
    r = await call('/api/venue/advisor/question', { question: 'How busy will Saturday be next weekend?' });
    assert.deepStrictEqual([r.body.mode, r.body.text], ['refusal', 'We can\'t answer that yet. Saturday of next weekend is past the seven days the forecast covers. It comes into them tomorrow.']);
    // The chip and a question naming no day are the weekend's, as before.
    const chip = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.ok(chip.body.text.startsWith(`${kind}the busiest day this weekend is Saturday, `), chip.body.text);
    r = await call('/api/venue/advisor/question', { question: 'What does the weekend look like?' });
    assert.strictEqual(r.body.text, chip.body.text);
  });
  // A venue with crowd history, on its Saturday: Friday is next Friday, off
  // its own week.
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr5WeekendNamedOwn0000', extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 }, phrasing: true });
    mlVenueRow = CORPUS_ROW;
    draftFor = () => null;
    const realWeek = advisorFacts.buildWeekAhead;
    advisorFacts.buildWeekAhead = async () => ownWeekFrom('2026-11-07');
    try {
      route = { mode: 'grounded', intentId: 'weekend_outlook' };
      const r = await call('/api/venue/advisor/question', { question: 'How busy will Friday be?' });
      assert.strictEqual(r.body.text.split('\n')[0], 'Friday peaks around 9 PM at 66 on our 0 to 100 index.', r.body.text);
      assert.strictEqual(r.body.sources[0].id, 'peak_2026-11-13');
    } finally {
      advisorFacts.buildWeekAhead = realWeek;
    }
  });
});

test('a block of facts that are their own sentence alone costs no model call and no charge: today shut, and a weekend shut with nothing after it', async () => {
  // Each went to the model until the final review (2026-11-06), charged to
  // the venue's daily allowance, and the draft the prompt asks for, that
  // sentence word for word, was refused as citing no fact, so the template
  // served the same sentence. A shut weekend with next weekend's days after
  // it still goes to the model (the listing's-own-line test above).
  const realQuery = pool.query;
  let charges = 0;
  pool.query = async (sql, params) => {
    if (/INSERT INTO advisor_(?:venue_)?spend/.test(String(sql))) charges += 1;
    return realQuery(sql, params);
  };
  try {
    for (const [iso, placeId, hours, intentId, text] of [
      ['2026-11-08T15:00:00Z', 'ChIJr5SaysOnlyToday000000', null, 'tonight_outlook', 'Your Google listing has you closed today.'],
      ['2026-11-09T15:00:00Z', 'ChIJr5SaysOnlyWeekend0000', { 1: [6, 14], 2: [6, 14], 3: [6, 14], 4: [6, 14] }, 'weekend_outlook', 'Your Google listing has you closed this weekend.'],
    ]) {
      await pinnedAt(iso, async () => {
        bakeryAt({ placeId, shut: 0 });
        if (hours) placePeriods = periodsOf(hours);
        process.env.ADVISOR_PHRASING_ENABLED = 'true';
        draftFor = () => ({ answer: text, points: [] });
        charges = 0;
        const r = await call('/api/venue/advisor/ask', { intentId });
        assert.deepStrictEqual([r.body.mode, r.body.text], ['template', text], intentId);
        assert.strictEqual(modelCalls.filter((c) => c.role === 'phrasing').length, 0, `${intentId}: a phrasing call was made`);
        assert.strictEqual(charges, 0, `${intentId}: the venue was charged`);
      });
    }
  } finally {
    pool.query = realQuery;
  }
});

test('after an answer that opens on the venue being shut, today or for a weekend, the week ahead is offered, and no staffing or busy-weekend question', async () => {
  // Until the final review (2026-11-06) "Your Google listing has you closed
  // today." was followed by "How should I staff today?", and a shut weekend
  // by "How do I get more out of a busy weekend?".
  const weekAhead = [{ kind: 'intent', id: 'peak_hours', label: advisorPhrasing.ADVISOR_INTENTS.peak_hours.chip }];
  await pinnedAt('2026-11-08T15:00:00Z', async () => {
    bakeryAt({ placeId: 'ChIJr5ShutFollowUpSun0000', shut: 0 });
    for (const intentId of ['tonight_outlook', 'weekend_outlook']) {
      const r = await call('/api/venue/advisor/ask', { intentId });
      assert.ok(/^Your Google listing has you closed /.test(r.body.text), r.body.text);
      assert.deepStrictEqual(r.body.followUps, weekAhead, `${intentId}: ${JSON.stringify(r.body.followUps)}`);
    }
  });
  await pinnedAt('2026-11-09T15:00:00Z', async () => {
    bakeryAt({ placeId: 'ChIJr5ShutFollowUpMon0000' });
    placePeriods = periodsOf({ 1: [6, 14], 2: [6, 14], 3: [6, 14], 4: [6, 14] });
    process.env.ADVISOR_PHRASING_ENABLED = 'true';
    draftFor = () => null;
    let r = await call('/api/venue/advisor/ask', { intentId: 'weekend_outlook' });
    assert.strictEqual(r.body.text, 'Your Google listing has you closed this weekend.');
    assert.deepStrictEqual(r.body.followUps, weekAhead, JSON.stringify(r.body.followUps));
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    r = await call('/api/venue/advisor/question', { question: 'What does next weekend look like?' });
    assert.strictEqual(r.body.text, 'Your Google listing has you closed over the coming weekend, Nov 13 to 15.');
    assert.deepStrictEqual(r.body.followUps, weekAhead, JSON.stringify(r.body.followUps));
    // An open today still offers the staffing question.
    const open = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
    assert.ok(open.body.followUps.some((f) => f.kind === 'question' && f.text === 'How should I staff today?'), JSON.stringify(open.body.followUps));
  });
});

// THE DAY WORDS, READ BY A SMALL GRAMMAR (2026-11-06). Every
// phrasing four review rounds found misread, read by roostDayReader: a short
// form only where written as a day, the clause that asks, a possessive only
// alone, and two days both kept.
test('the day words of a question are read where it asks, a short form only where written as a day, two days both kept', () => {
  const { dayWords } = require('../services/roostDayReader');
  const said = (q) => dayWords(q).map((w) => (w.kind === 'weekday'
    ? `${w.next ? 'next ' : ''}${w.weekday}${w.nextWeek ? ' next week' : ''}${w.afterNext ? ' after next' : ''}`
    : (w.kind === 'weekend' ? `weekend:${w.scope}` : w.kind))).join(', ');
  for (const [q, want] of [
    // "sat" and "sun" are words (third and fourth reviews, 2026-11-06).
    ['we sat 40 covers last night, how do I get more tonight?', 'today'],
    ['We sat dinner at 6 and then it died. How busy will tonight be?', 'today'],
    ['the sun rush on the patio was nice, how busy will tonight be?', 'today'],
    ['We sat 2nd seating at 8:30, how should I staff tonight?', 'today'],
    ['sat 1st turn by 6:30, how busy will tonight be?', 'today'],
    ['We got sun 10 minutes ago, how busy will the patio be tonight?', 'today'],
    ['we only sat 9 tables, which nights are quiet this week?', 'week'],
    ['How busy will Sat be?', 'Saturday'],
    // The sentence that asks, and the clause after a comma that asks.
    ['Happy Friday! How busy will this weekend be?', 'weekend:this'],
    ['It\'s Friday, how\'s the weekend looking?', 'weekend:this'],
    ['How busy will Saturday be? It\'s Thanksgiving weekend.', 'Saturday'],
    ['We\'re closed Mondays, how busy will this weekend be?', 'weekend:this'],
    ['Saturdays are packed, how do I fill Tuesdays?', 'Tuesday'],
    ['We\'re closed tomorrow. How busy will tonight be', 'today'],
    ['Slow tonight. Not sure if tomorrow will be any better.', 'tomorrow'],
    ['tonight was quiet, can you check if tomorrow looks busier', 'tomorrow'],
    ['Is it me or is this week dead. tonight gonna be any better', 'today'],
    ['Ruby Tuesday next door is closing, how busy will we be tonight?', 'today'],
    // Nothing where it asks: the whole question, a plural a habit.
    ['Sunday Funday is this weekend, how busy will it be?', 'Sunday, weekend:this'],
    ['Tonight we have a band. what should I expect', 'today'],
    ['we are closed mondays, what\'s our slowest open day?', ''],
    // A possessive counts alone.
    ['After tonight\'s rush, will it stay busy?', 'today'],
    ['Should I staff up tonight ahead of tomorrow\'s game?', 'today'],
    ['How\'s the rest of the weekend after Saturday\'s rush?', 'weekend:this'],
    // So does a day given as the reason or said in the past.
    ['Tonight was dead so I\'m wondering if tomorrow will pick up', 'tomorrow'],
    ['How busy will tonight be since tomorrow is a holiday?', 'today'],
    // Two days, both kept: the route answers both.
    ['Will tomorrow be busier than tonight?', 'tomorrow, today'],
    ['Is Saturday busier than Friday?', 'Saturday, Friday'],
    ['Which day is busiest this week, starting today?', 'week, today'],
    ['how does this weekend compare to next weekend?', 'weekend:this, weekend:next_words'],
    ['How busy will Saturday be next weekend?', 'Saturday, weekend:next_words'],
    // The week beside a weekday only says which one; a holiday is no weekday.
    ['How busy will Monday Night Football be this week?', 'Monday'],
    ['How busy will Black Friday be?', ''],
    ['How busy will Friday be compared to next week?', 'Friday'],
    ['How busy will the Friday after next be?', 'Friday after next'],
    ['How busy will Friday be next week?', 'Friday next week'],
    ['the day after tomorrow, how busy?', 'dayAfterTomorrow'],
  ]) {
    assert.strictEqual(said(q), want, q);
  }
});

test('two days asked are both answered, never one picked from them: the bar on the demo Friday', async () => {
  const kind = 'In Flock\'s forecast for places like yours, ';
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr5BothDaysBar00000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    // A comparison leads with the days it names, the higher first, today's
    // beside the card's week, and the week's busiest after them (recheck,
    // 2026-11-06; it led with the week's ranking before).
    let r = await call('/api/venue/advisor/question', { question: 'Is Thursday busier than Friday?' });
    assert.deepStrictEqual(r.body.text.split('\n').slice(0, 3), [
      `${kind}Friday peaks around 9 PM at 66 on our 0 to 100 index.`,
      '• Thursday peaks around 9 PM at 64.',
      '• The busiest day this week is Saturday, around 9 PM at 74.',
    ]);
    for (const id of ['typical_peak_2026-11-06', 'typical_peak_2026-11-12']) {
      assert.ok(r.body.sources.some((s) => s.id === id), `${id}: ${JSON.stringify(r.body.sources)}`);
    }
    // A day said in the past is the setup, and the question is about the
    // other day: tomorrow, Saturday.
    r = await call('/api/venue/advisor/question', { question: 'Tonight was dead so I\'m wondering if tomorrow will pick up' });
    assert.deepStrictEqual(r.body.text.split('\n').slice(0, 2), [
      `${kind}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`,
      '• That makes it the busiest day this week.',
    ]);
    assert.strictEqual(r.body.sources[0].id, 'typical_peak_2026-11-07');
    // This weekend beside next weekend on a Friday: this weekend, and next
    // weekend said to be past the seven days, never refused outright.
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    r = await call('/api/venue/advisor/question', { question: 'how does this weekend compare to next weekend?' });
    assert.strictEqual(r.body.mode !== 'refusal', true, r.body.text);
    assert.ok(r.body.text.startsWith(`${kind}the busiest day this weekend is Saturday, `), r.body.text);
    assert.ok(r.body.text.includes('Next Friday, Saturday and Sunday are past the seven days the forecast covers.'), r.body.text);
    // A weekend said in its own sentence is the weekend, with today in it.
    r = await call('/api/venue/advisor/question', { question: 'Happy Friday! How busy will this weekend be?' });
    for (const id of ['typical_peak_2026-11-06', 'typical_peak_2026-11-07', 'typical_peak_2026-11-08']) {
      assert.ok(r.body.sources.some((s) => s.id === id), `${id}: ${JSON.stringify(r.body.sources)}`);
    }
  });
});

// WHAT THE READER KEEPS, AND WHAT EACH ROUTE ANSWERS WITH IT (2026-11-06).
// The day words of a question as one line, for the reader's tests below.
const saidDays = (q) => require('../services/roostDayReader').dayWords(q).map((w) => (w.kind === 'weekday'
  ? `${w.next ? 'next ' : ''}${w.weekday}${w.nextWeek ? ' next week' : ''}${w.afterNext ? ' after next' : ''}`
  : (w.kind === 'weekend' ? `weekend:${w.scope}` : w.kind))).join(', ');

test('the day reader keeps the sentence that asks, drops a habit, a possessive beside another day, a day gone by and a holiday, and reads today put in or left out of the week', () => {
  for (const [q, want] of [
    // The sentence that asks, not the one around it.
    ['Will it be busy on Friday? Asking because tonight was dead.', 'Friday'],
    ['tonight was dead. friday?', 'Friday'],
    ['We\'re slammed on Saturdays. What about Thursday?', 'Thursday'],
    // A plural where nothing is asked is a habit.
    ['We do trivia on Tuesdays. Any tips for a slow night?', ''],
    // A possessive counts only alone.
    ['How\'s tomorrow\'s brunch looking?', 'tomorrow'],
    ['Will Friday\'s game bring a crowd on Saturday?', 'Saturday'],
    // A day gone by, and a holiday named for a weekday, are no coming day.
    ['How busy were we last Saturday?', ''],
    ['We were slow last Friday, how busy will Saturday be?', 'Saturday'],
    ['How busy will Cyber Monday be?', ''],
    ['Should we open on Easter Sunday?', ''],
    ['How busy will Small Business Saturday be?', ''],
    ['Is Super Bowl Sunday worth staffing up for?', ''],
  ]) {
    assert.strictEqual(saidDays(q), want, q);
  }
  const { todayInRanking } = require('../services/roostDayReader');
  for (const [q, want] of [
    ['Besides tonight, which day is busiest this week?', 'out'],
    ['How does the rest of the week look after today?', 'out'],
    ['Other than today, which nights are quiet?', 'out'],
    ['Which day is busiest this week, including today?', 'in'],
    ['Which day is busiest this week, starting today?', 'in'],
    ['Is tonight the busiest night this week?', 'in'],
    ['Will tomorrow be busier than tonight?', null],
    ['After tonight\'s rush, will it stay busy?', null],
  ]) {
    assert.strictEqual(todayInRanking(q), want, q);
  }
});

test('a day today\'s route does not hold is said with the peaks template, never as today: the bar on the demo Friday', async () => {
  // Until 2026-11-06 "Is tomorrow night going to be dead?" on today's route
  // was answered "today peaks around 9 PM at 74", Saturday's number.
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr6TomorrowNotToday00', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Is tomorrow night going to be dead?' });
    assert.strictEqual(r.body.text.split('\n')[0], 'In Flock\'s forecast for places like yours, Saturday peaks around 9 PM at 74 on our 0 to 100 index.');
    assert.strictEqual(r.body.sources[0].id, 'typical_peak_2026-11-07');
    // Whatever today's route is asked, a line that calls a day today is
    // today's own number.
    for (const question of [
      'Is tomorrow night going to be dead?', 'Will tomorrow be busier than tonight?', 'How busy will Sunday be?',
      'Is tonight the busiest night this week?', 'Besides tonight, which day is busiest this week?', 'How busy will tonight be?',
    ]) {
      const a = await call('/api/venue/advisor/question', { question });
      const today = a.body.text.split('\n').filter((l) => /^(?:• )?(?:In Flock's forecast for places like yours, )?today peaks/i.test(l));
      if (today.length) assert.strictEqual(a.body.sources[0].id, 'typical_peak_2026-11-06', `${question}: ${a.body.text}`);
    }
  });
});

// A cafe with no crowd history, open 7 AM to 3 PM on `days` (0 is Sunday).
function cafeOpenOn(placeId, days) {
  setUp({ placeId, phrasing: true });
  placeTypes = ['cafe', 'food', 'store'];
  placePrimary = 'cafe';
  placePeriods = days.map((d) => ({ open: { day: d, hour: 7, minute: 0 }, close: { day: d, hour: 15, minute: 0 } }));
  draftFor = () => null;
}

test('today shut, asked beside another day or the week on today\'s route, opens on its shut line and lends today\'s name to no other day', async () => {
  // The office cafe, open Monday to Friday, on its Saturday: this was "today
  // peaks around 8 AM at 48", Monday's number, until 2026-11-06.
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    cafeOpenOn('ChIJr6OfficeCafeSat00000', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Is tonight the busiest night this week?' });
    assert.strictEqual(r.body.text, 'Your Google listing has you closed today.');
  });
  // The cafe shut on Sundays, on its Sunday: shut today, then Monday.
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    cafeOpenOn('ChIJr6CafeShutSunday0000', [1, 2, 3, 4, 5, 6]);
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Will tomorrow be busier than tonight?' });
    assert.deepStrictEqual(r.body.text.split('\n'), [
      'Your Google listing has you closed today.',
      '• Monday projects busiest around 8 AM, at 48 on our 0 to 100 index, in Flock\'s forecast for places like yours.',
    ]);
    assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['today_closed', 'typical_peak_2026-11-09']);
  });
});

// A bar with crowd history, its curve 6 PM to 11 PM and on to 3 AM, each
// night peaking at 9 PM on the card's number for its weekday, while `fn` runs
// on the server's UTC calendar.
async function withNightCurve(placeId, fn) {
  setUp({ placeId, extra: { corpus_status: 'baselines', corpus_baseline_rows: 168 }, phrasing: true });
  draftFor = () => null;
  mlVenueRow = CORPUS_ROW;
  for (let day = 0; day <= 6; day += 1) {
    for (let hour = 18; hour <= 23; hour += 1) baselineRows.push({ day_of_week: day, hour, baseline: 40 + hour, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
    for (const hour of [0, 1, 2, 3]) baselineRows.push({ day_of_week: (day + 1) % 7, hour, baseline: 60, source: 'google', updated_at: '2026-10-01T00:00:00Z' });
  }
  const realPredict = mlPredictor.predictBusyness;
  const realAround = advisorFacts.buildAroundYou;
  mlPredictor.predictBusyness = async (_venue, _weather, ts) => {
    const d = new Date(ts);
    const h = d.getUTCHours();
    const night = new Date(d);
    if (h < 6) night.setUTCDate(night.getUTCDate() - 1);
    const off = h >= 18 ? Math.abs(21 - h) : (h < 6 ? 3 + h : 10);
    return { score: CARD[SHORT[night.getUTCDay()]] - off, label: 'Moderate', predictionMethod: 'ml', modelVersion: 'test' };
  };
  advisorFacts.buildAroundYou = async () => [];
  try {
    return await onUtc(fn);
  } finally {
    mlPredictor.predictBusyness = realPredict;
    advisorFacts.buildAroundYou = realAround;
  }
}

test('today is ranked with the week only when the question puts it in, left out when it leaves it out, and otherwise said beside the ranking: the bar on its Saturday', async () => {
  // Today is the card's high (74) on its Saturday. Until 2026-11-06 "How
  // does the rest of the week look after today?" led with today.
  const kind = 'In Flock\'s forecast for places like yours, ';
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr6TodayCueSat0000000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    let r = await call('/api/venue/advisor/question', { question: 'How does the rest of the week look after today?' });
    assert.ok(r.body.text.startsWith(`${kind}the busiest day this week is Friday, `), r.body.text);
    assert.strictEqual(r.body.sources[0].id, 'typical_peak_2026-11-13');
    assert.ok(!r.body.sources.some((s) => s.id === 'typical_peak_2026-11-07'), JSON.stringify(r.body.sources));
    r = await call('/api/venue/advisor/question', { question: 'Which day is busiest this week, including today?' });
    assert.ok(r.body.text.startsWith(`${kind}the busiest day this week is Saturday, `), r.body.text);
    assert.strictEqual(r.body.sources[0].id, 'typical_peak_2026-11-07');
    // Neither: today never ranked in the card's week, and a comparison leads
    // with the two days, today's 74 first; the card's busiest, Friday's 66,
    // is never called the busiest day this week under it (recheck,
    // 2026-11-06: it opened "the busiest day this week is Friday ... at 66"
    // and then said Saturday peaks at 74).
    r = await call('/api/venue/advisor/question', { question: 'Will tomorrow be busier than tonight?' });
    assert.deepStrictEqual(r.body.text.split('\n'), [
      `${kind}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`,
      '• Sunday peaks around 9 PM at 45, the quietest day this week.',
      `• ${peakMove()}`,
    ]);
    assert.deepStrictEqual(r.body.sources.map((s) => s.id).slice(0, 2), ['typical_peak_2026-11-07', 'typical_peak_2026-11-08']);
  });
  // With crowd history, its own week holds today and leaves it out.
  await withNightCurve('ChIJr6BesidesTonightOwn0', () => pinnedAt('2026-11-07T16:00:00Z', async () => {
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'Besides tonight, which day is busiest this week?' });
    assert.ok(r.body.text.startsWith('Your busiest day this week is Friday, '), r.body.text);
    assert.ok(!r.body.sources.some((s) => s.id === 'peak_2026-11-07'), JSON.stringify(r.body.sources));
  }));
});

test('a Sunday night still running ends the weekend: at 12:30 AM on a Monday this weekend is the coming one, and tonight is still Sunday night', async () => {
  // A venue with crowd history open to 3 AM. Its Sunday night runs on past
  // midnight, and at 12:30 AM on Monday "How busy will this weekend be?" was
  // answered with that Sunday night alone until 2026-11-06.
  await withNightCurve('ChIJr6MondaySmallHours00', () => pinnedAt('2026-11-09T00:30:00Z', async () => {
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    let r = await call('/api/venue/advisor/question', { question: 'How busy will this weekend be?' });
    assert.ok(r.body.text.startsWith('Your busiest day this weekend is Saturday, '), r.body.text);
    assert.deepStrictEqual(r.body.sources.map((s) => s.id).sort(), ['peak_2026-11-13', 'peak_2026-11-14', 'peak_2026-11-15']);
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    r = await call('/api/venue/advisor/question', { question: 'How busy will tonight be?' });
    assert.strictEqual(r.body.text, 'Sunday projects busiest around 9 PM, at 45 on our 0 to 100 index.');
    assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['peak_2026-11-08']);
  }));
  // A Saturday night still running stays in its weekend.
  await withNightCurve('ChIJr6SundaySmallHours00', () => pinnedAt('2026-11-08T00:30:00Z', async () => {
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'How busy will this weekend be?' });
    assert.deepStrictEqual(r.body.text.split('\n'), [
      'Your busiest day this weekend is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.',
      '• Sunday is next, around 9 PM at 45.',
    ]);
    assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['peak_2026-11-07', 'peak_2026-11-08']);
  }));
});

test('a day given as the reason or said in the past counts only alone, so the question is about the other day it names: the bar on its Wednesday', async () => {
  for (const [q, want] of [
    ['How busy will tonight be since tomorrow is a holiday?', 'today'],
    ['How do I fill tomorrow since tonight was dead?', 'tomorrow'],
    ['Since tomorrow is a holiday, will it be busy?', 'tomorrow'],
    ['Saturday was packed, will Sunday be too?', 'Sunday'],
    // "If" can mean "whether": both days, never one picked.
    ['How busy will tonight be if it rains tomorrow?', 'today, tomorrow'],
  ]) {
    assert.strictEqual(saidDays(q), want, q);
  }
  // Until 2026-11-06 each was answered with both days, today's first.
  const kind = 'In Flock\'s forecast for places like yours, ';
  await pinnedAt('2026-11-11T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr6GivenDayWed0000000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    let r = await call('/api/venue/advisor/question', { question: 'How busy will tonight be since tomorrow is a holiday?' });
    assert.strictEqual(r.body.text, `${kind}today peaks around 9 PM at 48 on our 0 to 100 index.`);
    assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['typical_peak_2026-11-11']);
    r = await call('/api/venue/advisor/question', { question: 'Tonight was dead so I\'m wondering if tomorrow will pick up' });
    assert.strictEqual(r.body.text.split('\n')[0], `${kind}Thursday peaks around 9 PM at 64 on our 0 to 100 index.`);
    assert.strictEqual(r.body.sources[0].id, 'typical_peak_2026-11-12');
  });
});

test('a short form is a day only where it is written as one, and never where it is the word: the bar on its Wednesday', async () => {
  for (const [q, want] of [
    // Written as a day.
    ['Fri night busy?', 'Friday'],
    ['next sat?', 'next Saturday'],
    ['Sun?', 'Sunday'],
    ['fri or sat?', 'Friday, Saturday'],
    // The word, or a test: the day the question does name.
    ['Sat at the bar for 2 hours last night, how busy will tonight be?', 'today'],
    ['Sun\'s out, should we open the patio tonight?', 'today'],
    ['Got a SAT prep group coming tonight, how busy will it be?', 'today'],
    // A range is the hours, not a day asked about.
    ['We\'re open Mon-Fri, how busy will Wed be?', 'Wednesday'],
    // The clause that asks: Monday, with Sunday said before it.
    ['we sat 40 on Sun, how do I fill Mon?', 'Monday'],
  ]) {
    assert.strictEqual(saidDays(q), want, q);
  }
  // Through the route: "Fri night" is Friday's line, and "we sat 40 covers"
  // is no Saturday.
  await pinnedAt('2026-11-11T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr6ShortFormsWed00000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    let r = await call('/api/venue/advisor/question', { question: 'Fri night busy?' });
    assert.strictEqual(r.body.text.split('\n')[0], 'In Flock\'s forecast for places like yours, Friday peaks around 9 PM at 66 on our 0 to 100 index.');
    assert.strictEqual(r.body.sources[0].id, 'typical_peak_2026-11-13');
    r = await call('/api/venue/advisor/question', { question: 'we sat 40 covers last night, how do I get more tonight?' });
    assert.ok(!r.body.sources.some((s) => s.id === 'typical_peak_2026-11-14'), JSON.stringify(r.body.sources));
    assert.strictEqual(r.body.sources[0].id, 'typical_peak_2026-11-11');
  });
});

// ── THE ACCEPTANCE ROUND (2026-11-06) ────────────────────────────────────────
// Each test below is one finding of the acceptance review of the day reader,
// read on the demo's bar (CARD) unless it says otherwise, on a pinned clock.
const sourceIds = (r) => r.body.sources.map((s) => s.id);
const KIND_OPEN = 'In Flock\'s forecast for places like yours, ';

test('two days named on the weekend\'s route are both answered on a Sunday, possessive or not, and never as that Sunday alone', async () => {
  for (const [q, want] of [
    // Two days in the possessive beside a weekend are the days asked; one
    // alone is what something belongs to.
    ['How will Friday\'s crowd compare to Saturday\'s this weekend?', 'Friday, Saturday, weekend:this'],
    ['How\'s the rest of the weekend after Saturday\'s rush?', 'weekend:this'],
  ]) {
    assert.strictEqual(saidDays(q), want, q);
  }
  // Until 2026-11-06 each was "Sunday peaks around 9 PM at 45", a day the
  // owner never named: on a Sunday this weekend is that Sunday.
  await pinnedAt('2026-11-08T20:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7TwoDaysSunday00000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    // A comparison leads with its two days, the higher first (recheck,
    // 2026-11-06).
    let r = await call('/api/venue/advisor/question', { question: 'How will Friday\'s crowd compare to Saturday\'s this weekend?' });
    assert.deepStrictEqual(r.body.text.split('\n').slice(0, 3), [
      `${KIND_OPEN}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`,
      '• That makes it the busiest day this week.',
      '• Friday peaks around 9 PM at 66.',
    ]);
    for (const id of ['typical_peak_2026-11-13', 'typical_peak_2026-11-14']) assert.ok(sourceIds(r).includes(id), `${id}: ${sourceIds(r)}`);
    assert.ok(!sourceIds(r).includes('typical_peak_2026-11-08'), JSON.stringify(sourceIds(r)));
    r = await call('/api/venue/advisor/question', { question: 'Which is busier, Saturday or Sunday?' });
    assert.deepStrictEqual(r.body.text.split('\n').slice(0, 3), [
      `${KIND_OPEN}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`,
      '• That makes it the busiest day this week.',
      '• Sunday peaks around 9 PM at 45.',
    ]);
    for (const id of ['typical_peak_2026-11-14', 'typical_peak_2026-11-08']) assert.ok(sourceIds(r).includes(id), `${id}: ${sourceIds(r)}`);
  });
  // On a Friday both days are this weekend's, and the weekend's answer says
  // the two asked, never Friday mixed in.
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7TwoDaysFriday00000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Which is busier, Saturday or Sunday?' });
    assert.deepStrictEqual(r.body.text.split('\n'), [
      `${KIND_OPEN}the busiest day this weekend is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.`,
      '• Sunday is next, around 9 PM at 45.',
    ]);
    assert.deepStrictEqual(sourceIds(r), ['typical_peak_2026-11-07', 'typical_peak_2026-11-08']);
  });
});

test('"weekends" is a habit, read from every Friday, Saturday and Sunday of the week ahead, so on a Sunday it is never that Sunday alone', async () => {
  assert.strictEqual(saidDays('Are weekends busier than weekdays for us?'), 'weekend:habit');
  await pinnedAt('2026-11-08T20:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7WeekendsHabitSun00', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Are weekends busier than weekdays for us?' });
    assert.deepStrictEqual(r.body.text.split('\n'), [
      `${KIND_OPEN}the busiest day this weekend is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.`,
      '• Friday is close behind, around 9 PM at 66.',
      '• Sunday is the quietest, around 9 PM at 45.',
    ]);
    // "This weekend" on a Sunday is still that Sunday.
    const t = await call('/api/venue/advisor/question', { question: 'How busy will this weekend be?' });
    assert.deepStrictEqual(sourceIds(t), ['typical_peak_2026-11-08']);
  });
  // With crowd history, the same three days of its own week.
  await withNightCurve('ChIJr7WeekendsHabitOwn00', () => pinnedAt('2026-11-08T20:00:00Z', async () => {
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Are weekends busier than weekdays for us?' });
    assert.ok(r.body.text.startsWith('Your busiest day this weekend is Saturday, '), r.body.text);
    assert.deepStrictEqual(sourceIds(r).sort(), ['peak_2026-11-08', 'peak_2026-11-13', 'peak_2026-11-14']);
  }));
});

test('the days the owner says the venue is shut on are no day of its weekend: on its Sunday, the weekend asked about is the next one', async () => {
  const { saidShut } = require('../services/roostDayReader');
  for (const [q, want] of [
    ['We\'re closed Sundays. How does this weekend look?', ['Sunday']],
    ['we are closed on mondays and tuesdays, how busy will friday be', ['Monday', 'Tuesday']],
    ['Sundays we\'re closed, so how does Saturday look?', ['Sunday']],
    ['How busy will Sunday be?', []],
    ['Close to the stadium, how does Sunday look?', []],
  ]) {
    assert.deepStrictEqual(saidShut(q), want, q);
  }
  // Until 2026-11-06, on a Sunday: "Sunday peaks around 9 PM at 45".
  await pinnedAt('2026-11-08T20:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7ClosedSundaysSun00', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'We\'re closed Sundays. How does this weekend look?' });
    assert.strictEqual(r.body.text, `${KIND_OPEN}no day stands out next weekend: every day peaks between 66 and 74 on our 0 to 100 index.`);
    assert.deepStrictEqual(sourceIds(r).sort(), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14']);
  });
  // On a Friday, this weekend without its Sunday.
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7ClosedSundaysFri00', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'We\'re closed Sundays. How does this weekend look?' });
    assert.deepStrictEqual(sourceIds(r).sort(), ['typical_peak_2026-11-06', 'typical_peak_2026-11-07']);
  });
});

test('a day of the weekend a question names that the listing has the venue shut on is said to be first, never answered with another day alone', async () => {
  // The office cafe, open Monday to Friday, on its Friday: each of these was
  // "Friday peaks around 8 AM at 66" until 2026-11-06, saying nothing of the
  // closure. On the weekend's route the weekend is answered, its shut days
  // said first (second recheck, 2026-11-06: the shut line alone lost Friday,
  // which main had said).
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    cafeOpenOn('ChIJr7OfficeFriday000000', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const weekend = `Your Google listing has you closed on Saturday and Sunday. ${KIND_OPEN}Friday peaks around 8 AM at 66 on our 0 to 100 index.`;
    for (const question of ['how busy will sunday be', 'Sunday Funday is this weekend, how busy will it be?', 'Which is busier, Saturday or Sunday?']) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.strictEqual(r.body.text, weekend, question);
      assert.deepStrictEqual(sourceIds(r), ['weekend_closed', 'typical_peak_2026-11-06'], question);
    }
  });
  // The cafe shut on Sundays: Saturday's line, after Sunday shut, and no
  // Friday mixed in ("no day stands out this weekend: every day peaks
  // between 66 and 74" until 2026-11-06).
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    cafeOpenOn('ChIJr7CafeShutSunFri0000', [1, 2, 3, 4, 5, 6]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Which is busier, Saturday or Sunday?' });
    assert.strictEqual(r.body.text, `Your Google listing has you closed on Sunday. ${KIND_OPEN}Saturday peaks around 8 AM at 74 on our 0 to 100 index.`);
    assert.deepStrictEqual(sourceIds(r), ['weekend_closed', 'typical_peak_2026-11-07']);
  });
  // On its Sunday, Saturday is next week's: the week ahead, after today shut.
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    cafeOpenOn('ChIJr7CafeShutSunSun0000', [1, 2, 3, 4, 5, 6]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Which is busier, Saturday or Sunday?' });
    assert.ok(r.body.text.startsWith(`Your Google listing has you closed today. ${KIND_OPEN}Saturday peaks around 8 AM at 74 on our 0 to 100 index.\n• That makes it the busiest day this week.`), r.body.text);
    assert.strictEqual(sourceIds(r)[0], 'today_closed');
  });
});

test('advice on two days named opens on each day\'s own peak, picking none', () => {
  const card = [
    ['2026-11-12', 'Thursday', 64], ['2026-11-13', 'Friday', 66], ['2026-11-14', 'Saturday', 74], ['2026-11-15', 'Sunday', 45],
  ].map(([date, weekday, score]) => ({ id: `typical_peak_${date}`, value: { weekday, peakHour: 21, peakScore: score }, source: 'category_pattern', asOf: '2026-11-11T16:00:00Z' }));
  let lead = roostPlaybook.groundedLead('peak_hours', card, '', ['Friday', 'Saturday']);
  assert.strictEqual(lead.text, `${KIND_OPEN}Friday projects busiest around 9 PM, at 66, and Saturday around 9 PM, at 74, on our 0 to 100 index.`);
  assert.deepStrictEqual(lead.facts.map((f) => f.id), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14']);
  // One of them with no forecast: the other said as a single day is.
  lead = roostPlaybook.groundedLead('peak_hours', card, '', ['Monday', 'Thursday']);
  assert.strictEqual(lead.text, `${KIND_OPEN}Thursday projects busiest around 9 PM, at 64 on our 0 to 100 index.`);
  assert.strictEqual(roostPlaybook.groundedLead('peak_hours', card, '', ['Monday', 'Tuesday']), null);
});

test('advice on two days named leads with both through the route, the fill move names the quieter, and advice over the week leads with its ranking: the bar on the demo Friday', async () => {
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7AdviceTwoDays00000', phrasing: true });
    draftFor = () => null;
    // Until 2026-11-06 each opened on the playbook alone, no day named.
    route = { mode: 'advice', intentId: 'peak_hours' };
    let r = await call('/api/venue/advisor/question', { question: 'how many bartenders for fri and sat' });
    assert.strictEqual(r.body.mode, 'advice', r.body.text);
    assert.ok(r.body.text.startsWith(`${KIND_OPEN}Friday projects busiest around 9 PM, at 66, and Saturday around 9 PM, at 74, on our 0 to 100 index. `), r.body.text);
    for (const id of ['typical_peak_2026-11-06', 'typical_peak_2026-11-07']) assert.ok(sourceIds(r).includes(id), `${id}: ${sourceIds(r)}`);
    r = await call('/api/venue/advisor/question', { question: 'should i do live music on thursday or friday' });
    assert.ok(r.body.text.startsWith(`${KIND_OPEN}Thursday projects busiest around 9 PM, at 64, and Friday around 9 PM, at 66, on our 0 to 100 index. Host a weekly music, comedy or open mic night on Thursday`), r.body.text);
    // Over the week, from tonight: the week's quietest, as before.
    route = { mode: 'advice', intentId: 'quiet_nights' };
    r = await call('/api/venue/advisor/question', { question: 'How do I fill the slow nights this week, starting tonight?' });
    assert.ok(r.body.text.startsWith(`${KIND_OPEN}Sunday projects as the quietest day this week. Give Sunday one recurring reason`), r.body.text);
    // Today beside another day is the setup: no lead, as before.
    route = { mode: 'advice', intentId: 'tonight_outlook' };
    r = await call('/api/venue/advisor/question', { question: 'We\'re dead tonight, trying to figure out if tomorrow is worth opening early' });
    assert.ok(!/projects (?:busiest|as)/.test(r.body.text.split('\n')[0]), r.body.text);
  });
});

test('today left out of the week, today the only day said or "not including" it, ranks the rest of the week without today', async () => {
  const { todayInRanking } = require('../services/roostDayReader');
  for (const q of ['Not including tonight, which day is busiest this week?', 'not including today what night is biggest', 'Apart from tonight, when will we be busiest?']) {
    assert.strictEqual(todayInRanking(q), 'out', q);
  }
  // The card's Friday, the demo's: until 2026-11-06 "Friday peaks around 9 PM
  // at 66", today, the day left out.
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7ApartFromTonight00', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    for (const question of ['Apart from tonight, when will we be busiest?', 'Other than tonight, what\'s our busiest night?']) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.ok(r.body.text.startsWith(`${KIND_OPEN}the busiest day this week is Saturday, `), `${question}: ${r.body.text}`);
      assert.ok(!sourceIds(r).includes('typical_peak_2026-11-06'), JSON.stringify(sourceIds(r)));
    }
    route = { mode: 'grounded', intentId: 'quiet_nights' };
    const r = await call('/api/venue/advisor/question', { question: 'Other than tonight, when will it be quiet?' });
    assert.ok(r.body.text.startsWith(`${KIND_OPEN}the quietest day this week is Sunday, `), r.body.text);
  });
  // The card's Saturday, today its high: "Saturday" (today) led until
  // 2026-11-06.
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7NotIncludingSat000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'Not including tonight, which day is busiest this week?' });
    assert.ok(r.body.text.startsWith(`${KIND_OPEN}the busiest day this week is Friday, `), r.body.text);
    assert.strictEqual(sourceIds(r)[0], 'typical_peak_2026-11-13');
  });
  // With crowd history, its own week without today.
  await withNightCurve('ChIJr7ExcludingTonightOwn', () => pinnedAt('2026-11-11T16:00:00Z', async () => {
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'Excluding tonight, when do we peak?' });
    assert.ok(r.body.text.startsWith('Your busiest day this week is Saturday, '), r.body.text);
    assert.ok(!sourceIds(r).includes('peak_2026-11-11'), JSON.stringify(sourceIds(r)));
  }));
});

test('the sentence that asks, with no question mark or with "?!", and the clause a run-on asks in', async () => {
  for (const [q, want] of [
    // No question mark: the sentence that holds a question word asks.
    ['how busy will tonight be. tomorrow is a holiday', 'today'],
    ['need to know how busy tonight will be. friday is payday', 'today'],
    ['How busy will we be tonight! Saturday we have a wedding', 'today'],
    ['how slow is monday gonna be. sunday we close early', 'Monday'],
    // An exclamation asks nothing; with no question word, the last sentence.
    ['What a dead night tonight. Tomorrow gonna be any better', 'tomorrow'],
    ['Slow tonight. Not sure if tomorrow will be any better.', 'tomorrow'],
    ['Is it me or is this week dead. tonight gonna be any better', 'today'],
    // "?!" ends a question.
    ['Is Saturday gonna be busy?! Tonight was dead.', 'Saturday'],
    // A run-on asks in its last clause.
    ['saturday got rained out so how busy will sunday be', 'Sunday'],
    ['we did 300 covers saturday what should i expect sunday', 'Sunday'],
    ['How did Saturday go and what about Sunday?', 'Sunday'],
    ['Since we\'re closed monday will tuesday be busy?', 'Tuesday'],
    ['friday we had a private party what about saturday', 'Saturday'],
    // Not where the day is what the clause is about.
    ['Not sure if tomorrow will be busy, tonight was dead', 'tomorrow'],
    ['Friday is payday will it be busy', 'Friday'],
    ['How busy will we be tonight when the Eagles play Sunday?', 'today, Sunday'],
  ]) {
    assert.strictEqual(saidDays(q), want, q);
  }
  // Through the route, the bar on its Wednesday: until 2026-11-06 the first
  // was Thursday's line and the second led with the week's busiest day.
  await pinnedAt('2026-11-11T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7AskingSentenceWed0', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    let r = await call('/api/venue/advisor/question', { question: 'how busy will tonight be. tomorrow is a holiday' });
    assert.strictEqual(r.body.text, `${KIND_OPEN}today peaks around 9 PM at 48 on our 0 to 100 index.`);
    assert.deepStrictEqual(sourceIds(r), ['typical_peak_2026-11-11']);
    route = { mode: 'grounded', intentId: 'peak_hours' };
    r = await call('/api/venue/advisor/question', { question: 'we did 300 covers saturday what should i expect sunday' });
    assert.strictEqual(r.body.text.split('\n')[0], `${KIND_OPEN}Sunday peaks around 9 PM at 45 on our 0 to 100 index.`);
    assert.strictEqual(sourceIds(r)[0], 'typical_peak_2026-11-15');
  });
});

test('a weekday in the plural is the day asked about unless it says when something happens or that the venue is shut', async () => {
  for (const [q, want] of [
    ['Our Wednesdays are slow, any ideas?', 'Wednesday'],
    ['Tuesdays are dead. Any ideas?', 'Tuesday'],
    ['Mondays are killing us. What should we do?', 'Monday'],
    ['We\'re always slow on Mondays. What should I try?', 'Monday'],
    ['Fridays are packed. How should I staff?', 'Friday'],
    ['Tuesdays kill us, how do we bring people in?', 'Tuesday'],
    // A habit, and a day the venue is shut: no day asked.
    ['We do trivia on Tuesdays. Any tips for a slow night?', ''],
    ['we are closed mondays, what\'s our slowest open day?', ''],
  ]) {
    assert.strictEqual(saidDays(q), want, q);
  }
  // Until 2026-11-06: "Sunday projects as the quietest day this week. Give
  // Sunday one recurring reason to visit".
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7PluralWednesdays00', phrasing: true });
    draftFor = () => null;
    route = { mode: 'advice', intentId: 'quiet_nights' };
    const r = await call('/api/venue/advisor/question', { question: 'Our Wednesdays are slow, any ideas?' });
    assert.ok(r.body.text.startsWith(`${KIND_OPEN}Wednesday projects busiest around 9 PM, at 48 on our 0 to 100 index. Give Wednesday one recurring reason`), r.body.text);
  });
});

test('"good", "super" and "giving" before a day, and "this sun", are ordinary words, and a weekend gone by is no weekend asked', async () => {
  for (const [q, want] of [
    ['Is this a good Friday to run a promo?', 'Friday'],
    ['Will it be a good Sunday for brunch?', 'Sunday'],
    ['Gonna be a super Sunday?', 'Sunday'],
    ['We\'re giving Tuesday another shot with trivia, how busy will it be?', 'Tuesday'],
    // The holidays, written as names.
    ['Is Good Friday going to be busy?', ''],
    ['Is Giving Tuesday worth a promo?', ''],
    ['how busy is super bowl sunday', ''],
    // The weather, not the day.
    ['How busy will the patio be with this sun?', ''],
    ['how busy will the patio get in this sun', ''],
    ['How busy will this Sun be?', 'Sunday'],
    // Last weekend, and the weekend before.
    ['Is next weekend going to beat last weekend', 'weekend:next_words'],
    ['Is next weekend going to be bigger than the weekend before?', 'weekend:next_words'],
  ]) {
    assert.strictEqual(saidDays(q), want, q);
  }
  // On a Sunday: until 2026-11-06 it opened on "Sunday peaks around 9 PM at
  // 45", today, and then next Friday and Saturday.
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr7LastWeekendSun000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    let r = await call('/api/venue/advisor/question', { question: 'Is next weekend going to beat last weekend' });
    assert.deepStrictEqual(sourceIds(r).sort(), ['next_weekend_past_forecast', 'typical_peak_2026-11-13', 'typical_peak_2026-11-14']);
    // "a good Friday" is the coming Friday.
    route = { mode: 'grounded', intentId: 'peak_hours' };
    r = await call('/api/venue/advisor/question', { question: 'Is this a good Friday to run a promo?' });
    assert.strictEqual(r.body.text.split('\n')[0], `${KIND_OPEN}Friday peaks around 9 PM at 66 on our 0 to 100 index.`);
  });
});

test('in the small hours of a night still running, this morning and this afternoon are the day ahead, and tonight and today the night still running', async () => {
  // A venue with crowd history open to 3 AM, at 12:30 AM on a Saturday with
  // Friday night still running: until 2026-11-06 a morning or an afternoon
  // was answered with Friday night, a peak already past.
  await withNightCurve('ChIJr7SmallHoursDayParts', () => pinnedAt('2026-11-07T00:30:00Z', async () => {
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    let r = await call('/api/venue/advisor/question', { question: 'How busy will this afternoon be?' });
    assert.strictEqual(r.body.text.split('\n')[0], 'Saturday peaks around 9 PM at 74 on our 0 to 100 index.');
    assert.strictEqual(sourceIds(r)[0], 'peak_2026-11-07');
    route = { mode: 'grounded', intentId: 'peak_hours' };
    r = await call('/api/venue/advisor/question', { question: 'How busy will we be this morning?' });
    assert.strictEqual(sourceIds(r)[0], 'peak_2026-11-07');
    // Tonight, and today, are the night still running, as the today chip
    // answers them.
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    for (const question of ['How busy will tonight be?', 'How does today look?']) {
      r = await call('/api/venue/advisor/question', { question });
      assert.deepStrictEqual(sourceIds(r), ['peak_2026-11-06'], question);
    }
  }));
});

test('a question reads advisorFacts once, never a path per fact on every payload', async () => {
  // Each require() resolved its path again, and read for every fact the
  // phrasing payload carried it was most of a question's time (acceptance,
  // 2026-11-06: a sweep ran three times as long as on main).
  const Module = require('node:module');
  await pinnedAt('2026-11-08T16:00:00Z', async () => {
    cafeOpenOn('ChIJr7RequireOnceSun0000', [1, 2, 3, 4, 5, 6]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const q = { question: 'How does this weekend look?' };
    await call('/api/venue/advisor/question', q);
    const resolve = Module._resolveFilename;
    let n = 0;
    Module._resolveFilename = function counted(request, ...rest) {
      if (/advisorFacts$/.test(String(request))) n += 1;
      return resolve.call(this, request, ...rest);
    };
    try {
      const r = await call('/api/venue/advisor/question', q);
      assert.ok(r.body.text.startsWith('Your Google listing has you closed'), r.body.text);
    } finally {
      Module._resolveFilename = resolve;
    }
    assert.strictEqual(n, 0);
  });
});

// ── THE RECHECK (2026-11-06) ─────────────────────────────────────────────────
// Each test below is one finding of the independent recheck of the day
// reader, on a pinned clock.

// A bar listed 5 PM to 2 AM, Tuesday to Saturday: shut on Sundays and Mondays.
function barShutSundayMonday(placeId) {
  setUp({ placeId, phrasing: true });
  draftFor = () => null;
  placePeriods = [2, 3, 4, 5, 6].map((d) => ({ open: { day: d, hour: 17, minute: 0 }, close: { day: (d + 1) % 7, hour: 2, minute: 0 } }));
}

test('a weekend question that names one day the venue is shut on says it is shut and answers the weekend\'s open days', async () => {
  // The cafe shut on Sundays, on its Wednesday: each of these was "Your
  // Google listing has you closed on Sunday." alone, and Friday and Saturday
  // were lost (main said both).
  await pinnedAt('2026-11-11T15:00:00Z', async () => {
    cafeOpenOn('ChIJr8WeekendShutSunWed00', [1, 2, 3, 4, 5, 6]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    for (const question of [
      'Sunday Funday is this weekend, how busy will it be?',
      'How busy is this weekend, especially Sunday?',
      'How busy will the weekend be, Sunday included?',
      'Will Sunday brunch be busy this weekend?',
    ]) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.strictEqual(r.body.text, `Your Google listing has you closed on Sunday. ${KIND_OPEN}no day stands out this weekend: every day peaks between 66 and 74 on our 0 to 100 index.`, question);
      assert.deepStrictEqual(sourceIds(r).sort(), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14', 'weekend_closed'], question);
    }
  });
  // The office cafe, open Monday to Friday: Saturday asked, and both shut
  // days said, then Friday ("closed on Saturday." alone before).
  await pinnedAt('2026-11-11T15:00:00Z', async () => {
    cafeOpenOn('ChIJr8WeekendOfficeWed000', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'Is this weekend going to be busy, especially Saturday?' });
    assert.strictEqual(r.body.text, `Your Google listing has you closed on Saturday and Sunday. ${KIND_OPEN}Friday peaks around 8 AM at 66 on our 0 to 100 index.`);
    assert.deepStrictEqual(sourceIds(r), ['weekend_closed', 'typical_peak_2026-11-13']);
  });
});

test('in the small hours, a tomorrow the venue is shut on is said to be, with the coming daytime when it is open, and a shut day asked is followed by the next day it opens', async () => {
  // A bar shut on Sundays and Mondays, at 12:30 AM on a Saturday with Friday
  // night still running: "How busy will tomorrow be?" on today's route ranked
  // the week from Friday 66, leaving out today and saying nothing of Sunday
  // (main said today, Saturday, 74).
  await pinnedAt('2026-11-07T00:30:00Z', async () => {
    barShutSundayMonday('ChIJr8SmallHoursBarShut00');
    for (const intentId of ['tonight_outlook', 'peak_hours']) {
      route = { mode: 'grounded', intentId };
      const r = await call('/api/venue/advisor/question', { question: 'How busy will tomorrow be?' });
      // The peaks' route adds its move under the answer.
      assert.strictEqual(r.body.text.split('\n')[0], `Your Google listing has you closed on Sunday. ${KIND_OPEN}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`, intentId);
      assert.deepStrictEqual(sourceIds(r).slice(0, 2), ['weekend_closed', 'typical_peak_2026-11-07'], intentId);
    }
  });
  // The cafe shut on Sundays at 3:30 AM on its Saturday: the same.
  await pinnedAt('2026-11-07T03:30:00Z', async () => {
    cafeOpenOn('ChIJr8SmallHoursCafeSun00', [1, 2, 3, 4, 5, 6]);
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'How busy will tomorrow be?' });
    assert.strictEqual(r.body.text, `Your Google listing has you closed on Sunday. ${KIND_OPEN}Saturday peaks around 8 AM at 74 on our 0 to 100 index.`);
  });
  // The office cafe at 12:30 AM on its Saturday: the coming daytime is shut
  // too, so both are said, and the next day it opens follows.
  await pinnedAt('2026-11-07T00:30:00Z', async () => {
    cafeOpenOn('ChIJr8SmallHoursOffice000', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'How busy will tomorrow be?' });
    assert.strictEqual(r.body.text, `Your Google listing has you closed today and on Sunday. ${KIND_OPEN}Monday peaks around 8 AM at 48 on our 0 to 100 index.`);
  });
  // Past the small hours tomorrow is the calendar's: the office cafe on its
  // Friday afternoon, shut the whole weekend, then Monday.
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    cafeOpenOn('ChIJr8TomorrowOfficeFri00', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'tonight_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'How busy will tomorrow be?' });
    assert.strictEqual(r.body.text, `Your Google listing has you closed on Saturday and Sunday. ${KIND_OPEN}Monday peaks around 8 AM at 48 on our 0 to 100 index.`);
    assert.deepStrictEqual(sourceIds(r), ['weekend_closed', 'typical_peak_2026-11-09']);
  });
  // A weekday asked on the peaks' route that the bar is shut on, on its
  // Wednesday: "the busiest day this week is Saturday" before.
  await pinnedAt('2026-11-11T16:00:00Z', async () => {
    barShutSundayMonday('ChIJr8ShutSundayPeaksWed0');
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'How busy will Sunday be?' });
    assert.strictEqual(r.body.text.split('\n')[0], `Your Google listing has you closed on Sunday and Monday. ${KIND_OPEN}Tuesday peaks around 9 PM at 48 on our 0 to 100 index.`);
    // Advice about a shut day claims no busiest day from the one day after it.
    route = { mode: 'advice', intentId: 'peak_hours' };
    const a = await call('/api/venue/advisor/question', { question: 'how many croissants should i bake for sunday morning' });
    assert.ok(!/busiest day this week/.test(a.body.text), a.body.text);
  });
});

// The numbers an answer's lines give, and those it calls the week's busiest.
const busiestClaims = (text) => {
  const lines = text.split('\n');
  const all = lines.map((l) => (/ at (\d+)\b/.exec(l) || [])[1]).filter(Boolean).map(Number);
  const busiest = lines.filter((l) => /busiest day this week/.test(l)).map((l) => {
    const m = /busiest day this week is \w+(?: night)?, (?:with its peak )?around [^,]+? at (\d+)/.exec(l) || / at (\d+)\b/.exec(l);
    return m ? Number(m[1]) : null;
  }).filter((n) => n !== null);
  return { all, busiest };
};

test('a comparison leads with the days compared, the higher first, and never under a busiest day that a number it says beats', async () => {
  // The card's Saturday, today 74 beside its week, whose busiest is Friday
  // 66: each of these opened "the busiest day this week is Friday, with its
  // peak around 9 PM at 66" and then said Saturday peaks at 74.
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr8CompareCardSat0000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    for (const [question, second] of [
      ['Is Saturday busier than Friday?', '• Friday peaks around 9 PM at 66.'],
      ['Fri or Sat?', '• Friday peaks around 9 PM at 66.'],
      ['Is tomorrow busier than today?', '• Sunday peaks around 9 PM at 45, the quietest day this week.'],
      ['Which is busier, Saturday or Sunday?', '• Sunday peaks around 9 PM at 45, the quietest day this week.'],
    ]) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.deepStrictEqual(r.body.text.split('\n').slice(0, 2), [`${KIND_OPEN}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`, second], question);
      assert.strictEqual(sourceIds(r)[0], 'typical_peak_2026-11-07', question);
      const { all, busiest } = busiestClaims(r.body.text);
      for (const n of busiest) assert.ok(all.every((x) => x <= n), `${question}: ${r.body.text}`);
    }
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    const r = await call('/api/venue/advisor/question', { question: 'How will Friday\'s crowd compare to Saturday\'s this weekend?' });
    assert.strictEqual(r.body.text.split('\n')[0], `${KIND_OPEN}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`);
    assert.ok(!/busiest day this week is Friday/.test(r.body.text), r.body.text);
  });
  // The office cafe on its Friday: tomorrow shut, and today's 66 led after
  // "the busiest day this week is Thursday ... at 64" before.
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    cafeOpenOn('ChIJr8CompareOfficeFri000', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'Will tomorrow be busier than tonight?' });
    assert.strictEqual(r.body.text.split('\n')[0], `Your Google listing has you closed on Saturday. ${KIND_OPEN}Friday peaks around 8 AM at 66 on our 0 to 100 index.`);
    assert.ok(!/busiest day this week is Thursday/.test(r.body.text), r.body.text);
  });
  // Two days that peak alike: the week's busiest of them leads and is called
  // that, never the other first with the busiest said under it.
  const day = (date, weekday, score, hour, night = false) => ({
    id: `peak_${date}`, value: { weekday, peakHour: hour, peakScore: score, ...(night ? { afterMidnight: true } : {}) }, source: 'model_holdout', asOf: '2026-11-06T16:00:00Z', label: `${weekday} projects busiest.`,
  });
  const facts = [
    day('2026-11-06', 'Friday', 74, 0, true), day('2026-11-07', 'Saturday', 74, 18), day('2026-11-08', 'Sunday', 48, 0, true),
    day('2026-11-09', 'Monday', 50, 20), day('2026-11-10', 'Tuesday', 55, 20), day('2026-11-11', 'Wednesday', 58, 20), day('2026-11-12', 'Thursday', 64, 20),
  ];
  assert.deepStrictEqual(advisorPhrasing.renderTemplate({ intent: 'peak_hours', facts, refusals: [], askedDays: ['Saturday', 'Friday'] }, 'Will tomorrow be busier than tonight?').text.split('\n').slice(0, 3), [
    'Friday night peaks around midnight at 74 on our 0 to 100 index.',
    '• That makes it your busiest day this week.',
    '• Saturday peaks around 6 PM at 74.',
  ]);
  // Two days named with no comparison and no number beating the ranking keep
  // the week's ranking, as main and the catalog's 802 have it.
  await pinnedAt('2026-11-11T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr8IfItRainsWed000000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'How busy will tonight be if it rains tomorrow?' });
    assert.strictEqual(r.body.text.split('\n')[0], `${KIND_OPEN}the busiest day this week is Saturday, with its peak around 9 PM at 74 on our 0 to 100 index.`);
  });
});

test('only the owner\'s own venue said shut takes a day out, never another venue, a negation or the past, and a day said shut is no day asked', async () => {
  const { saidShut } = require('../services/roostDayReader');
  for (const [q, want] of [
    ['The bar next door is closed Sundays, how busy will we be this weekend?', []],
    ['We\'re not closed Sundays anymore. How does this weekend look?', []],
    ['We are no longer closed on Sundays, how busy will this weekend be?', []],
    ['Since they\'re closed Sundays, will our weekend be busier?', []],
    ['We used to be closed Sundays. How busy will this weekend be?', []],
    ['we close at 3 on sundays, how busy will saturday be', []],
    ['We close on Sundays, how busy is the weekend?', ['Sunday']],
    ['Closed on Sundays, how does this weekend look?', ['Sunday']],
    ['saturday we are closed, how does the weekend look?', ['Saturday']],
    ['how busy will friday be, saturday we are closed', ['Saturday']],
    ['We\'re closed Sundays. How does this weekend look?', ['Sunday']],
  ]) {
    assert.deepStrictEqual(saidShut(q), want, q);
  }
  assert.strictEqual(saidDays('how busy will friday be, saturday we are closed'), 'Friday');
  // The bar on its Wednesday: the first two dropped Sunday from the weekend,
  // and the last led with Saturday as the week's busiest.
  await pinnedAt('2026-11-11T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr8SaidShutWed0000000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    for (const question of ['The bar next door is closed Sundays, how busy will we be this weekend?', 'We\'re not closed Sundays anymore. How does this weekend look?']) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.deepStrictEqual(sourceIds(r).sort(), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14', 'typical_peak_2026-11-15'], question);
    }
    let r = await call('/api/venue/advisor/question', { question: 'We close on Sundays, how busy is the weekend?' });
    assert.deepStrictEqual(sourceIds(r).sort(), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14']);
    route = { mode: 'grounded', intentId: 'peak_hours' };
    r = await call('/api/venue/advisor/question', { question: 'how busy will friday be, saturday we are closed' });
    assert.strictEqual(r.body.text.split('\n')[0], `${KIND_OPEN}Friday peaks around 9 PM at 66 on our 0 to 100 index.`);
  });
});

// ── The second recheck of the day reader (2026-11-06) ─────────────────────
// Each test below is one finding of the second recheck, on a pinned clock.

test('on the weekend\'s route, a weekend day the venue is shut on is said with the weekend\'s open days, whatever the owner calls the weekend', async () => {
  // The cafe shut on Sundays, on its Wednesday: each of these was "Your
  // Google listing has you closed on Sunday." alone, where main said Friday
  // and Saturday. The route decides, not the word: "wknd", "wkend", "on the
  // weekend", "at the weekend", "weekends", a day named in a sentence of its
  // own, and no weekend word at all.
  await pinnedAt('2026-11-11T15:00:00Z', async () => {
    cafeOpenOn('ChIJr9WeekendRouteCafe000', [1, 2, 3, 4, 5, 6]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    for (const question of [
      'how busy this wknd esp sunday',
      'hows the wkend looking? sunday esp',
      'Will we be busy on the weekend, esp. Sunday?',
      'At the weekend, will Sunday be busy?',
      'How busy are weekends for us, esp. Sundays?',
      'this wkend? sunday?',
      'how busy will sunday be',
      'Weekend outlook? Particularly Sunday.',
    ]) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.strictEqual(r.body.text, `Your Google listing has you closed on Sunday. ${KIND_OPEN}no day stands out this weekend: every day peaks between 66 and 74 on our 0 to 100 index.`, question);
      assert.deepStrictEqual(sourceIds(r).sort(), ['typical_peak_2026-11-13', 'typical_peak_2026-11-14', 'weekend_closed'], question);
    }
    // A day named that the weekend holds open is said by name under the
    // range, as main said it; a day another venue closes on says nothing of
    // this one.
    let r = await call('/api/venue/advisor/question', { question: 'How busy will the wkend be? Especially Saturday' });
    assert.strictEqual(r.body.text, `${KIND_OPEN}no day stands out this weekend: every day peaks between 66 and 74 on our 0 to 100 index.\n• Saturday peaks around 8 AM at 74 on our 0 to 100 index.`);
    r = await call('/api/venue/advisor/question', { question: 'Our competitor closes Sundays; how busy is this weekend?' });
    assert.strictEqual(r.body.text, `${KIND_OPEN}no day stands out this weekend: every day peaks between 66 and 74 on our 0 to 100 index.`);
  });
  // The office cafe, shut Saturday and Sunday: a shut Saturday asked about
  // is said beside a shut Sunday, then Friday ("closed on Saturday." or
  // "closed on Sunday." alone before, and Friday lost).
  await pinnedAt('2026-11-11T15:00:00Z', async () => {
    cafeOpenOn('ChIJr9WeekendRouteOffice0', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'weekend_outlook' };
    for (const question of [
      'How busy will the wkend be? Especially Saturday',
      'how busy this wknd esp sunday',
      'Weekend outlook? Particularly Saturday night.',
      'Will this weekend\'s Saturday be packed?',
      'Sat & Sun this wknd: how busy?',
    ]) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.strictEqual(r.body.text, `Your Google listing has you closed on Saturday and Sunday. ${KIND_OPEN}Friday peaks around 8 AM at 66 on our 0 to 100 index.`, question);
      assert.deepStrictEqual(sourceIds(r), ['weekend_closed', 'typical_peak_2026-11-13'], question);
    }
  });
  const { dayWords, weekdaysNamed } = require('../services/roostDayReader');
  assert.deepStrictEqual(dayWords('how busy this wknd'), [{ kind: 'weekend', scope: 'this' }]);
  assert.deepStrictEqual(dayWords('how busy next wkend'), [{ kind: 'weekend', scope: 'next_words' }]);
  assert.deepStrictEqual(weekdaysNamed('Weekend outlook? Particularly Saturday night.'), ['Saturday']);
  assert.deepStrictEqual(weekdaysNamed('Our competitor closes Sundays; how busy is this weekend?'), []);
});

test('"the day after" where the question says tomorrow is the day after tomorrow, and nowhere else', () => {
  const { dayWords } = require('../services/roostDayReader');
  for (const q of ['Is tomorrow busier than the day after?', 'Will tomorrow or the day after be busier?', 'tmrw or the day after?', 'How busy will tomorrow be, and the day after?', 'Is tomorrow slower than the day after at our place?', 'Will tomorrow be dead, or the day after?']) {
    assert.deepStrictEqual(dayWords(q), [{ kind: 'tomorrow' }, { kind: 'dayAfterTomorrow' }], q);
  }
  assert.deepStrictEqual(dayWords('Tomorrow looks slow. What about the day after?'), [{ kind: 'dayAfterTomorrow' }]);
  // Not a day: with no tomorrow said, or the day after something else.
  assert.deepStrictEqual(dayWords('and the day after?'), []);
  assert.deepStrictEqual(dayWords('Is tomorrow busier than the day after the game?'), [{ kind: 'tomorrow' }]);
  assert.deepStrictEqual(dayWords('Is tomorrow busier than the day after that?'), [{ kind: 'tomorrow' }]);
  assert.deepStrictEqual(dayWords('tomorrow or the day after we reopen?'), [{ kind: 'tomorrow' }]);
  assert.deepStrictEqual(dayWords('Is the day after a holiday? How busy will tomorrow be?'), [{ kind: 'tomorrow' }]);
});

test('tomorrow against the day after is answered with both days, the higher first', async () => {
  // The bar on its Thursday: tomorrow Friday 66, the day after Saturday 74.
  // This was "Friday peaks around 9 PM at 66" alone, where main's ranking
  // held both.
  await pinnedAt('2026-11-12T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr9DayAfterCardThu000', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    for (const question of ['Is tomorrow busier than the day after?', 'Will tomorrow or the day after be busier?']) {
      const r = await call('/api/venue/advisor/question', { question });
      assert.deepStrictEqual(r.body.text.split('\n').slice(0, 3), [
        `${KIND_OPEN}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`,
        '• That makes it the busiest day this week.',
        '• Friday peaks around 9 PM at 66.',
      ], question);
      assert.deepStrictEqual(sourceIds(r).slice(0, 2), ['typical_peak_2026-11-14', 'typical_peak_2026-11-13'], question);
    }
  });
  // The office cafe on its Friday: both days shut, and said so first.
  await pinnedAt('2026-11-06T16:00:00Z', async () => {
    cafeOpenOn('ChIJr9DayAfterOfficeFri00', [1, 2, 3, 4, 5]);
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'Is tomorrow busier than the day after?' });
    assert.ok(r.body.text.startsWith('Your Google listing has you closed on Saturday and Sunday.'), r.body.text);
  });
});

test('one day against the same weekday past the seven days leads with the day the forecast holds and claims no busiest day it beats', async () => {
  // The card's Saturday, today 74 beside its week, whose busiest is Friday
  // 66: "the busiest day this week is Friday, with its peak around 9 PM at
  // 66 ... Saturday peaks around 9 PM at 74" before.
  await pinnedAt('2026-11-07T16:00:00Z', async () => {
    setUp({ placeId: 'ChIJr9SameWeekdayCardSat', phrasing: true });
    draftFor = () => null;
    route = { mode: 'grounded', intentId: 'peak_hours' };
    const r = await call('/api/venue/advisor/question', { question: 'Is this Saturday busier than next Saturday?' });
    assert.deepStrictEqual(r.body.text.split('\n').slice(0, 2), [
      `${KIND_OPEN}Saturday peaks around 9 PM at 74 on our 0 to 100 index.`,
      '• Next Saturday is past the seven days the forecast covers.',
    ]);
    assert.ok(!/busiest day this week is Friday/.test(r.body.text), r.body.text);
    const { all, busiest } = busiestClaims(r.body.text);
    for (const n of busiest) assert.ok(all.every((x) => x <= n), r.body.text);
  });
});
