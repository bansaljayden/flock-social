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
//      Flock's forecast for places like this one; never a week holding a
//      model number;
//   2. the answer: the money move names the card's quietest and busiest days
//      with the card's numbers, from the same function and the same cache
//      entry (no second estimate), said as Flock's forecast for places like
//      yours, and so do the other week chips; today and the listing lines,
//      which the card does not carry, keep their refusals;
//   3. the phrasing input and the number check: the model is handed those
//      facts with their source and note, a draft that never says whose
//      forecast it is goes to the template, an invented number loses its
//      line, and advice built on the card is held to the same rule;
//   4. no history and no card: the refusal stands, word for word;
//   5. a venue with its own crowd history never reads the card.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

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
mlPredictor.predictHourlyForecast = async (_venue, _weather, startHour, count, day) => {
  if (startHour === 17) eveningCalls += 1;
  const peak = CARD[SHORT[new Date(day).getDay()]];
  const hours = [];
  for (let i = 0; i < count; i += 1) hours.push((startHour + i) % 24);
  // Each evening peaks at 9 PM, at the card's number for that weekday.
  return hours.map((h) => ({
    hour: label(h),
    score: h === 21 ? peak : Math.max(1, peak - 12 - Math.abs(21 - h)),
    baselineScore: null,
    predictionMethod: method,
  }));
};

// ── Google Places, for the card's one lookup ────────────────────────────────
let placesUp = true;
let placesCalls = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    placesCalls += 1;
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length));
    return Promise.resolve({
      status: 200,
      json: async () => (placesUp ? {
        id,
        displayName: { text: 'Thistle Room' },
        rating: 4.4,
        userRatingCount: 320,
        types: ['bar'],
        location: { latitude: 39.95, longitude: -75.16 },
        currentOpeningHours: { openNow: true },
        utcOffsetMinutes: 0,
      } : { error: { code: 503, message: 'unavailable' } }),
    });
  }
  return realFetch(url, opts);
};

const advisorFacts = require('../services/advisorFacts');
const advisorPhrasing = require('../services/advisorPhrasing');
const advisorFreeText = require('../services/advisorFreeText');
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
  placesUp = true;
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

// The card's week as the dashboard serves it, and its quietest and busiest.
async function cardWeek() {
  const r = await call('/api/venue-dashboard/intelligence');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.available, true, JSON.stringify(r.body));
  const week = r.body.week;
  const sorted = [...week].sort((a, z) => a.peakScore - z.peakScore);
  return { intel: r.body, week, low: sorted[0], top: sorted[sorted.length - 1] };
}

// The facts a payload hands the model, read back off it.
function payloadFacts(payload) {
  const line = payload.split('\n').find((l) => l.startsWith('{') && l.includes('"facts"'));
  return JSON.parse(line).facts;
}
const idFor = (facts, weekday, part) => facts.find((f) => f.id.startsWith(`typical_peak_${part}`) && facts.some(
  (g) => g.id === f.id.replace(`_${part}`, '_weekday') && g.value === weekday,
)).id;

// ── 1. The facts ────────────────────────────────────────────────────────────

test('the card\'s week becomes Roost facts with the card\'s numbers, labelled as Flock\'s forecast for places like this one', async () => {
  setUp({ placeId: 'ChIJforecastFacts000000000' });
  const { intel, week } = await cardWeek();
  // The card says what made each number; a venue with no curve is a category prior.
  assert.ok(week.every((d) => d.method === 'rule_engine_no_baseline'), JSON.stringify(week));
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
    assert.strictEqual(f.note, advisorFacts.KIND_FORECAST_NOTE);
    assert.match(f.note, /not this venue's own forecast and not its readings/);
  }
  // Nothing that reads the venue's own forecast by its peak_ id can take one.
  assert.ok(facts.every((f) => !f.id.startsWith('peak_')));
});

test('a card that is not a week of category priors is no week at all', async () => {
  setUp({ placeId: 'ChIJforecastNotKind000000' });
  const { intel } = await cardWeek();
  // One model number means the venue has a curve its profile has not caught
  // up with: that week is not "typical for places like yours".
  const oneModelDay = { ...intel, week: intel.week.map((d, i) => (i === 2 ? { ...d, method: 'ml' } : d)) };
  assert.deepStrictEqual(advisorFacts.projectionFacts(oneModelDay), []);
  assert.deepStrictEqual(advisorFacts.projectionFacts({ ...intel, week: intel.week.map(({ method: _m, ...d }) => d) }), [],
    'a week that does not say what made it is not vouched for');
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

test('the money move names the card\'s quietest and busiest days, from the card\'s own function and cache entry', async () => {
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
  // The move and what it is worth at the owner's own spend, as for any venue.
  const move = roostPlaybook.moveFor('money_move', { facts: advisorFacts.projectionFacts(intel) }, roostPlaybook.venueOf({ profile }));
  assert.strictEqual(move.topic, 'fill_slow_days', 'a week with a quiet day to fill');
  assert.ok(lines.includes(`• ${move.move}`), r.body.text);
  assert.ok(lines.includes(`• At your $28 a head, every 10 extra covers on ${LONG[low.weekday]} is $280 a week, about $14,560 a year.`), r.body.text);
  assert.ok(!/\byour (?:quietest|busiest)\b/i.test(r.body.text), 'never "your quietest day" for a forecast that is not the venue\'s own');
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

test('the other week questions answer from the card the same way, and what the card does not carry still refuses', async () => {
  setUp({ placeId: 'ChIJforecastOtherChips000' });
  const { week, top } = await cardWeek();
  const sorted = [...week].sort((a, z) => a.peakScore - z.peakScore);

  const peaks = await call('/api/venue/advisor/ask', { intentId: 'peak_hours' });
  assert.strictEqual(peaks.body.mode, 'template');
  assert.strictEqual(peaks.body.text.split('\n')[0], `In Flock's forecast for places like yours, the busiest day this week is ${LONG[top.weekday]}, with its peak around 9 PM at ${top.peakScore} on our 0 to 100 index.`);

  const quiet = await call('/api/venue/advisor/ask', { intentId: 'quiet_nights' });
  assert.strictEqual(quiet.body.mode, 'template');
  assert.strictEqual(quiet.body.text.split('\n')[0], `In Flock's forecast for places like yours, the quietest day this week is ${LONG[sorted[0].weekday]}, with its peak around 9 PM at ${sorted[0].peakScore} on our 0 to 100 index.`);

  for (const r of [peaks, quiet]) {
    assert.ok(!/\byour (?:quietest|busiest)\b/i.test(r.body.text), r.body.text);
    assert.ok(r.body.sources.length > 0 && r.body.sources.every((s) => s.source === 'category_pattern' || s.source === 'roost_playbook'), JSON.stringify(r.body.sources));
  }

  // Today is not on the card: tonight keeps the corpus refusal.
  const tonight = await call('/api/venue/advisor/ask', { intentId: 'tonight_outlook' });
  assert.strictEqual(tonight.body.mode, 'refusal', tonight.body.text);
  assert.match(tonight.body.text, /no crowd history for this venue/i);
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

// ── 3. The phrasing input and the number check ──────────────────────────────

test('the model is handed the card\'s facts with their source and note, and its answer must say whose forecast it is', async () => {
  setUp({ placeId: 'ChIJforecastPhrased000000', phrasing: true });
  const { low, top } = await cardWeek();
  const quiet = LONG[low.weekday];
  const busy = LONG[top.weekday];
  let payload = null;
  const good = (p) => {
    const facts = payloadFacts(p);
    return {
      answer: `Fill {{fact:${idFor(facts, quiet, 'weekday')}}}: Flock's forecast for places like yours has it as the quietest day this week, at {{fact:${idFor(facts, quiet, 'score')}}} against {{fact:${idFor(facts, busy, 'score')}}} on {{fact:${idFor(facts, busy, 'weekday')}}}.`,
      points: ['Give people one fixed reason to come in that day, at the same time every week.'],
    };
  };
  draftFor = (role, p) => { payload = p; return good(p); };
  let r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'phrased', r.body.text);
  assert.strictEqual(r.body.text.split('\n')[0], `Fill ${quiet}: Flock's forecast for places like yours has it as the quietest day this week, at ${low.peakScore} against ${top.peakScore} on ${busy}.`);
  assert.ok(r.body.sources.every((s) => s.source === 'category_pattern'), JSON.stringify(r.body.sources));

  // What the model was given: the two days, their source and their note, the
  // ids it may write, and the playbook's move.
  const facts = payloadFacts(payload);
  assert.ok(facts.length >= 6 && facts.every((f) => f.source === 'category_pattern' && f.id.startsWith('typical_peak_')), JSON.stringify(facts));
  assert.ok(facts.every((f) => f.note.includes(advisorFacts.KIND_FORECAST_NOTE)));
  assert.ok(facts.some((f) => f.note.includes('LOWEST projected day in the week ahead')));
  assert.match(payload, /^PLACEHOLDER IDS\. .*typical_peak_score/m);
  assert.match(payload, /^PLAYBOOK MOVE\./m);
  assert.ok(!/"peak_(?:score|hour|weekday)/.test(payload), 'no id of the venue\'s own forecast');
  assert.ok(SYSTEM_PROMPT.includes('A fact whose source is category_pattern is Flock\'s forecast for places like this one'));
  assert.ok(ADVICE_SYSTEM_PROMPT.includes('A fact whose source is category_pattern is Flock\'s forecast for places like this one'));

  // The same numbers given as the venue's own: the template says it instead.
  draftFor = (role, p) => {
    const f = payloadFacts(p);
    return { answer: `{{fact:${idFor(f, quiet, 'weekday')}}} is your quietest day this week, at {{fact:${idFor(f, quiet, 'score')}}}.`, points: [] };
  };
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.match(r.body.text, /^Fill \w+\. In Flock's forecast for places like yours, it is the quietest day this week/);

  // Written as digits it is the same claim, and goes the same way.
  draftFor = () => ({ answer: `${quiet} peaks at ${low.peakScore} on our index, your quietest day this week.`, points: [] });
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'template', r.body.text);

  // A number nothing on the card supports loses its line; the rest stands.
  draftFor = (role, p) => ({ ...good(p), points: [`Expect ${quiet} to sit near 31 on the index again next week.`, 'Give people one fixed reason to come in that day.'] });
  r = await call('/api/venue/advisor/ask', { intentId: 'money_move' });
  assert.strictEqual(r.body.mode, 'phrased', r.body.text);
  assert.ok(!r.body.text.includes('31'), r.body.text);
  assert.ok(r.body.text.includes('Give people one fixed reason to come in that day.'), r.body.text);
});

test('the answer check holds a forecast for places like this one to saying so, and leaves the venue\'s own forecast alone', () => {
  const kind = [advisorFacts.makeFact({ id: 'typical_peak_score', value: 45, source: 'category_pattern', asOf: '2026-11-03T12:00:00Z' })];
  const own = [advisorFacts.makeFact({ id: 'peak_score', value: 45, source: 'model_holdout', asOf: '2026-11-03T12:00:00Z' })];
  const say = (answer) => JSON.stringify({ answer, points: [] });
  const why = [];
  const reject = (reason) => { why.push(reason); return null; };
  assert.strictEqual(advisorPhrasing.applyValve(say('Sunday is your quietest day, at {{fact:typical_peak_score}}.'), { facts: kind }, { reject }), null);
  // The card's number written as digits is the same claim.
  assert.strictEqual(advisorPhrasing.applyValve(say('Sunday peaks at 45 on our index, your quietest day.'), { facts: kind }, { reject }), null);
  assert.deepStrictEqual(why, ['a forecast for places like this one, given as the venue\'s own', 'a forecast for places like this one, given as the venue\'s own']);
  for (const fine of [
    'Flock\'s forecast for places like yours puts Sunday at {{fact:typical_peak_score}}.',
    'For a bar like yours, Sunday typically peaks at {{fact:typical_peak_score}}.',
    'In this kind of place, Sunday peaks at {{fact:typical_peak_score}}.',
    'For venues similar to yours, Sunday peaks at {{fact:typical_peak_score}}.',
  ]) {
    const out = advisorPhrasing.applyValve(say(fine), { facts: kind });
    assert.ok(out, fine);
    assert.ok(out.text.includes('45'), out.text);
  }
  // The venue's own forecast needs no such words.
  assert.ok(advisorPhrasing.applyValve(say('Sunday is your quietest day, at {{fact:peak_score}}.'), { facts: own }));
  // Advice built on the card is held to the same rule.
  assert.strictEqual(advisorFreeText.applyAdviceValve(say('Sunday is your quiet day at {{fact:typical_peak_score}}, so run a weekly reason to come in.'), kind), null);
  assert.ok(advisorFreeText.applyAdviceValve(say('Flock\'s forecast for places like yours has Sunday at {{fact:typical_peak_score}}, so run a weekly reason to come in.'), kind));
  assert.ok(kindForecast.saysWhose('venues like you') && !kindForecast.saysWhose('your quietest day'));

  // AND WITHOUT ITS PLACEHOLDER. Advice needs no source, so the card's number
  // written as a plain number, or its quiet day named as the venue's own,
  // passed with none at all until this rule.
  const card = [
    advisorFacts.makeFact({ id: 'typical_peak_score', value: 45, source: 'category_pattern', asOf: '2026-11-03T12:00:00Z' }),
    advisorFacts.makeFact({ id: 'typical_peak_weekday', value: 'Sunday', source: 'category_pattern', asOf: '2026-11-03T12:00:00Z' }),
    advisorFacts.makeFact({ id: 'intake_typical_spend_per_person', value: 28, source: 'intake', asOf: 'owner-set 2026-10-01', unit: 'usd' }),
  ];
  for (const own of [
    'Sunday is your quietest day this week, at 45, so run a weekly quiz.',
    'With Sunday at 45, give people one fixed reason to come in.',
    'Sunday is your slowest day, so run a weekly quiz.',
    'Your Sundays are the quietest, so run a weekly quiz.',
  ]) {
    assert.strictEqual(advisorFreeText.applyAdviceValve(say(own), card), null, own);
    assert.strictEqual(advisorPhrasing.applyValve(say(own), { facts: card }), null, own);
  }
  for (const fine of [
    'Flock\'s forecast for places like yours has Sunday as the quietest day at 45, so run a weekly quiz.',
    'Run a weekly quiz on Sundays at 8 PM, and give it 6 weeks.',
    'Aim for 45 more covers a month, and at $28 a head that is $1,260.',
    'Sunday is a good night for a quiz, so run one every week.',
    'Sunday is the best night to try a quiz, so run one every week.',
  ]) {
    assert.ok(advisorFreeText.applyAdviceValve(say(fine), card), fine);
  }
  // A venue whose block holds no card is never held to it.
  const ownWeek = [advisorFacts.makeFact({ id: 'peak_score', value: 45, source: 'model_holdout', asOf: 'x' })];
  assert.ok(advisorFreeText.applyAdviceValve(say('Sunday is your quietest day this week, at 45, so run a weekly quiz.'), ownWeek));
});

test('typed, the money move routes to the card; advice built on it says whose forecast it is or the playbook does', async () => {
  setUp({ placeId: 'ChIJforecastTyped00000000', phrasing: true });
  const { low } = await cardWeek();

  route = { mode: 'grounded', intentId: 'money_move' };
  draftFor = () => null; // the phrasing call fails: the template answers
  let r = await call('/api/venue/advisor/question', { question: 'What is our best money move this week?' });
  assert.strictEqual(r.body.intentId, 'money_move');
  assert.strictEqual(r.body.mode, 'template', r.body.text);
  assert.match(r.body.text, new RegExp(`^Fill ${LONG[low.weekday]}\\. In Flock's forecast for places like yours, it is the quietest day this week`));

  // "How do I fill a slow Monday?" is advice; Monday's evening on the card
  // rides with it.
  route = { mode: 'advice', intentId: 'quiet_nights' };
  let advicePayload = null;
  draftFor = (role, p) => {
    advicePayload = p;
    const f = payloadFacts(p);
    return { answer: `Monday is your quiet day at {{fact:${idFor(f, 'Monday', 'score')}}}, so give people one fixed reason to come in.`, points: [] };
  };
  r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Monday?' });
  assert.strictEqual(r.body.mode, 'advice');
  assert.ok(payloadFacts(advicePayload).some((f) => f.id.startsWith('typical_peak_weekday') && f.value === 'Monday'), 'Monday\'s card evening was in the payload');
  // The draft gave the card's number as the venue's own: the playbook answers,
  // and its lead says whose forecast it is.
  assert.ok(r.body.sources.some((s) => s.source === 'roost_playbook'), JSON.stringify(r.body.sources));
  assert.match(r.body.text, /^In Flock's forecast for places like yours, Monday projects busiest around 9 PM, at 48 on our 0 to 100 index\./);

  draftFor = (role, p) => {
    const f = payloadFacts(p);
    return { answer: `Flock's forecast for places like yours has Monday at {{fact:${idFor(f, 'Monday', 'score')}}}, so give people one fixed reason to come in.`, points: [] };
  };
  r = await call('/api/venue/advisor/question', { question: 'How do I fill a slow Monday?' });
  assert.strictEqual(r.body.mode, 'advice');
  assert.strictEqual(r.body.text, 'Flock\'s forecast for places like yours has Monday at 48, so give people one fixed reason to come in.');
  assert.ok(r.body.sources.some((s) => s.source === 'category_pattern'), JSON.stringify(r.body.sources));
});

test('the playbook\'s lead says whose forecast it is, and the venue\'s own reads as it did', () => {
  const kind = [
    advisorFacts.makeFact({ id: 'typical_peak_2026-11-08', value: { weekday: 'Sunday', peakHour: 21, peakScore: 45 }, source: 'category_pattern', asOf: 'x' }),
    advisorFacts.makeFact({ id: 'typical_peak_2026-11-07', value: { weekday: 'Saturday', peakHour: 21, peakScore: 74 }, source: 'category_pattern', asOf: 'x' }),
  ];
  assert.strictEqual(roostPlaybook.groundedLead('money_move', kind).text, 'In Flock\'s forecast for places like yours, Sunday projects as the quietest day this week.');
  assert.strictEqual(roostPlaybook.groundedLead('peak_hours', kind).text, 'In Flock\'s forecast for places like yours, Saturday projects as the busiest day this week.');
  const own = kind.map((f) => ({ ...f, id: f.id.replace('typical_', ''), source: 'model_holdout' }));
  assert.strictEqual(roostPlaybook.groundedLead('money_move', own).text, 'Sunday projects as your quietest day this week.');
});

// ── 4. No history and no card ───────────────────────────────────────────────

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

// ── 5. A venue with its own crowd history ───────────────────────────────────

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
    assert.strictEqual(r.body.text.split('\n')[0], 'Fill Tuesday. It is your quietest day this week, with its peak around 6 PM at 38 on our 0 to 100 index, against 88 on Saturday.');
    assert.strictEqual(projectionReads, 0);
  } finally {
    advisorFacts.buildWeekAhead = realWeek;
    advisorFacts.buildWeekProjection = realProjection;
  }
});
