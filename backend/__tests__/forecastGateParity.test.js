// Run: node --test  (from backend/)
//
// THE FORECAST GATE HAD THREE DOORS AND ONE LOCK.
//
// `PAYWALL_ENABLED` is unset, so none of this is live yet. That is exactly why
// it matters: PAYWALL-DECISION.md is a pending decision about whether the wall
// is worth turning on, and its own test for that is whether anybody ever hits
// the meter ("if nobody hits the 30 forecasts/month or 10 Birdie/day cap, the
// wall is invisible and pointless"). A meter with an open door beside it can
// never be hit, so the decision would have been made on a number that was not
// measuring anything.
//
// routes/crowd.js metered the forecast. Three other surfaces served the same
// best time, peak window and hourly curve and did not:
//   * routes/publicCrowd.js — the marketing demo. No auth, no account, no
//     meter, a URL anyone can curl. Strictly cheaper than the paid door.
//   * routes/ai.js — Birdie. Gated `hourly_forecast` on tier and let
//     `best_time` and `peak_hours` through unconditionally, so a user who had
//     just been shown the wall on the venue card could ask Birdie the same
//     question and be told, by us, for free.
//   * routes/badge.js — audited and DELIBERATELY LEFT OPEN. It serves one live
//     label on a pill and computes no forecast at all. Section 4 pins that it
//     stays that way, which is the only version of "ungated" that is safe: a
//     decision with a tripwire, not an omission.
//
// The shape of the previous leak in this same gate is the thing these tests are
// really written against. It blanked `bestTime` and left `bestHour`,
// `bestIndex` and `bestIsNow` sitting beside it, i.e. the gate was correct
// about the CONCEPT and wrong about the FIELD LIST. So nothing below asserts a
// named field is null. Every lock test takes the UNLOCKED response, reads the
// premium answers out of it, and then asserts that none of those values appear
// anywhere in the locked one, at any depth, under any key. A future field that
// carries the same answer under a new name fails these tests without anyone
// remembering to add it.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'forecast-gate-parity-test-secret';
// Captured at module load by crowd / publicCrowd / badge / ai / venueDashboard.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.VENUE_BILLING_ENABLED;

const BACKEND = path.join(__dirname, '..');

// --- scripted pg fake -------------------------------------------------------
const pool = require('../config/database');
let handlers = [];
let log = [];
function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Destructured at load by every router below.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, conditions: 'Clear' });
weatherService.getForecast = async () => [];

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
placesBudget.allowGlobalPlacesCall = () => true;

// The REAL monthly meter. Spending an allowance by calling recordView directly
// is the same state the tenth venue view produces, without ten round trips.
const forecastUsage = require('../services/forecastUsage');
const { FREE_MONTHLY_FORECASTS, getUsedThisMonth, recordView } = forecastUsage;

// --- Gemini, faked ----------------------------------------------------------
const genaiMod = require('@google/genai');
let sendCalls = [];
let sendImpl = null;
const fakeChat = {
  sendMessage: async (params) => {
    sendCalls.push(params);
    if (sendImpl) return sendImpl(params, sendCalls.length);
    return { candidates: [{ content: { parts: [{ text: 'oakwood, chill till 9' }] } }] };
  },
};
genaiMod.GoogleGenAI = function FakeGenAI() {
  return { chats: { create: () => fakeChat } };
};

// --- Google Places, faked ---------------------------------------------------
// utcOffsetMinutes null so the venue clock falls back to the localHour/localDay
// each request passes in, which keeps every cache key predictable.
function place(id, over = {}) {
  return {
    id,
    displayName: { text: id },
    formattedAddress: '1 Main St',
    rating: 4.2,
    userRatingCount: 300,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    types: ['bar'],
    location: { latitude: 39.74, longitude: -104.98 },
    currentOpeningHours: { openNow: true, periods: [] },
    utcOffsetMinutes: null,
    ...over,
  };
}

let NEARBY = [];
let fetched = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://places.googleapis.com/')) return realFetch(url, opts);
  fetched.push(u);
  if (u.startsWith('https://places.googleapis.com/v1/places:search')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: NEARBY }) });
  }
  const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
  return Promise.resolve({ ok: true, status: 200, json: async () => place(id || 'PLACE_X') });
};
test.after(() => { global.fetch = realFetch; });

// --- the model, faked -------------------------------------------------------
const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');

// Every venue shape that reaches the model, so section 5 can inspect what the
// feature builder was actually handed rather than what the route meant to send.
let scored = [];
mlPredictor.predictBusyness = async (venue) => {
  scored.push(venue);
  return {
    score: 30,
    label: crowdEngine.getLabel(30),
    confidence: 60,
    factors: {},
    dataSourcesUsed: ['ml_model'],
    predictionMethod: 'ml',
    modelVersion: 'test',
    eventAlert: {
      hasEvent: true,
      eventName: 'Test Show',
      estimatedAttendance: 20000,
      distance: '1.2 km away',
    },
  };
};
// A rising evening curve so the best-time sentence names a real later hour
// rather than "now": otherwise the locked/unlocked comparison would be
// comparing two nulls and would pass on a gate that did nothing.
mlPredictor.predictHourlyForecast = async (venue, _w, startHour, count) => {
  scored.push(venue);
  return Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const score = i === 0 ? 30 : 30 + i;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score, label: crowdEngine.getLabel(score) };
  });
};

const crowdRouter = require('../routes/crowd');
const publicCrowdRouter = require('../routes/publicCrowd');
const aiRouter = require('../routes/ai');
const badgeRouter = require('../routes/badge');
const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
app.use('/api/public', publicCrowdRouter);
app.use('/api/ai', aiRouter);
app.use('/api/badge', badgeRouter);
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

let nextUser = 500000;
const freshUser = () => { CURRENT_USER = { id: ++nextUser, name: 'Ava', role: 'user' }; return CURRENT_USER.id; };

test.beforeEach(() => {
  handlers = [];
  log = [];
  NEARBY = [];
  fetched = [];
  scored = [];
  sendCalls = [];
  sendImpl = null;
  freshUser();
  delete process.env.PAYWALL_ENABLED;
});

async function call(method, path_, body) {
  const res = await realFetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const notPremium = () => handlers.push([/SELECT is_premium\b[\s\S]*?\bFROM users\b/, () => ({ rows: [{ is_premium: false }] })]);
const isPremiumUser = () => handlers.push([/SELECT is_premium\b[\s\S]*?\bFROM users\b/, () => ({ rows: [{ is_premium: true }] })]);
const spendAllowance = (uid) => { for (let i = 0; i < FREE_MONTHLY_FORECASTS; i++) recordView(uid); };

// ---------------------------------------------------------------------------
// The reconstruction sweep.
//
// Not "is field X null". The last leak in this gate blanked the sentence and
// left the same answer in three other fields, so the only question worth asking
// is whether the ANSWER is anywhere in the payload, whatever it is called.
//
// `as_of` / `age_ms` are excluded from the numeric half and nothing else is:
// they are clock readings in the millisecond range that can land on any small
// integer by chance, so including them would make this flaky without making it
// stronger. They cannot carry a forecast; they are produced by Date.now().
// ---------------------------------------------------------------------------
const CLOCK_KEYS = new Set(['as_of', 'age_ms', 'lastUpdated', 'timestamp', 'generatedAt']);

function walk(node, key, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${key}[${i}]`, visit)); return; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, key ? `${key}.${k}` : k, visit);
    return;
  }
  visit(node, key);
}

function valuesIn(payload) {
  const strings = new Set();
  const numbers = new Set();
  walk(payload, '', (v, key) => {
    const leaf = key.split('.').pop().replace(/\[\d+\]$/, '');
    if (typeof v === 'string') strings.add(v);
    else if (typeof v === 'number' && !CLOCK_KEYS.has(leaf)) numbers.add(v);
  });
  return { strings, numbers };
}

// The premium answers, read out of a card that was NOT locked. Booleans and
// tiny indexes are excluded on purpose: `true` and `3` appear all over any
// payload, so asserting their absence would be asserting nothing. The strings
// (the best-time sentence, the named hour, the peak window, every hour label)
// and the future-hour scores are the answer, and they are unmistakable.
function premiumAnswers(openCard, { best, peak, hourly }) {
  const strings = new Set();
  const numbers = new Set();
  for (const s of [openCard[best], openCard[peak]]) {
    if (typeof s === 'string' && s.trim()) strings.add(s);
  }
  const rows = openCard[hourly] || [];
  assert.ok(rows.length > 1, 'the unlocked card carried no hourly curve; this comparison proves nothing');
  rows.forEach((h, i) => {
    if (i === 0) return; // hour 0 IS the free live score, by design
    if (typeof h.hour === 'string') strings.add(h.hour);
    if (typeof h.score === 'number') numbers.add(h.score);
  });
  assert.ok(strings.size > 0 && numbers.size > 0, 'nothing premium was found to look for');
  return { strings, numbers };
}

// The value sweep alone has one blind spot, found by sabotage in round 3 of
// this work: `best_hour` is chosen over 24 hours while the chart only draws 12,
// so when the recommendation lands past the last bar its label appears in NO
// other field, and deleting it from the locked set left no trace for the value
// comparison to find. That is the ORIGINAL LEAK EXACTLY — a field carrying the
// answer that nothing else happened to carry — so the sweep gets a second half
// that works on NAMES rather than values: any key that announces itself as
// best-time, peak or forecast data must be empty in a locked payload, whatever
// it holds and wherever it sits.
//
// These three are the lock's own vocabulary and are allowed to be truthy: they
// say the forecast is ABSENT, which is the opposite of leaking it.
const LOCK_MARKERS = new Set(['forecast_locked', 'forecast_note', 'hourly_forecast_note']);
const PREMIUM_KEY = /^(best|peak|hourly)|forecast/i;

function assertNoPremiumKeys(payload, what) {
  walk(payload, '', (v, key) => {
    const leaf = key.split('.').pop().replace(/\[\d+\]$/, '');
    if (LOCK_MARKERS.has(leaf) || !PREMIUM_KEY.test(leaf)) return;
    assert.ok(v === null || v === false || v === '',
      `${what}: locked payload still carries \`${key}\` = ${JSON.stringify(v)}`);
  });
}

function assertNoLeak(lockedPayload, answers, what) {
  assertNoPremiumKeys(lockedPayload, what);
  const seen = valuesIn(lockedPayload);
  for (const s of answers.strings) {
    assert.ok(!seen.strings.has(s),
      `${what}: the locked payload still contains the premium string ${JSON.stringify(s)} — the gate blanked a field and left the answer somewhere else`);
  }
  for (const n of answers.numbers) {
    assert.ok(!seen.numbers.has(n),
      `${what}: the locked payload still contains the future-hour score ${n} — the curve is reconstructable from what was left behind`);
  }
}

// ===========================================================================
// SECTION 0 — no fourth door
//
// A source sweep, because the failure this file exists for is not a wrong
// value, it is a WHOLE ROUTE nobody remembered. Any file that produces the
// forecast must name a gate. This is the test that catches the next
// routes/publicCrowd.js before it ships, and it cannot be satisfied by adding
// a field to a list.
// ===========================================================================

// The three calls that MAKE the paid product. Everything the meter sells comes
// out of one of them.
const FORECAST_PRODUCERS = /predictHourlyForecast|recommendBestTime|findBestTime|findPeakTime/;
// Any of these in the same file means somebody made a decision about who may
// see it. `requirePro` is the venue-side (B2B) plan check, Roost, which is a
// different wall in front of the same numbers, and is the right one for
// routes/venueDashboard.js: an owner is buying data about their own venue.
const GATES = /gateForecast|forecastAccess|gateDemoCard|requirePro\b/;

// Comments do not count, in either direction. routes/badge.js explains at
// length why it must never call the three producers, and naming them in prose
// would otherwise register as calling them; and a gate mentioned in a comment
// is not a gate.
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('every route that computes a forecast names a gate', () => {
  const dir = path.join(BACKEND, 'routes');
  const offenders = [];
  let checked = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = codeOf(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!FORECAST_PRODUCERS.test(src)) continue;
    checked++;
    if (!GATES.test(src)) offenders.push(file);
  }
  assert.ok(checked >= 4, `only ${checked} routes appear to compute a forecast; this sweep has stopped looking at anything`);
  assert.deepStrictEqual(offenders, [],
    `these routes serve the paid forecast with no gate named anywhere in the file: ${offenders.join(', ')}`);
});

test('the paywall policy is defined once and imported, not copied', () => {
  const aiSrc = fs.readFileSync(path.join(BACKEND, 'routes', 'ai.js'), 'utf8');
  assert.match(aiSrc, /require\('\.\/crowd'\)/,
    'routes/ai.js no longer imports the shared policy; a private copy of "has this user paid" is how these routes drifted apart the first time');
  assert.ok(!/FREE_MONTHLY_FORECASTS|forecastUsage/.test(aiSrc),
    'routes/ai.js is re-deriving the monthly meter itself instead of asking routes/crowd.js');
  assert.strictEqual(typeof crowdRouter.forecastAccess, 'function',
    'routes/crowd.js stopped exporting the shared policy');
});

// ===========================================================================
// SECTION 1 — routes/crowd.js, the door that always had a lock
//
// The gate's field behaviour is pinned in __tests__/presenceParity.test.js and
// is not re-litigated here. What is here is the part that changed: the policy
// is now a separate exported function, and the event alert stopped publishing
// a number that was never a headcount.
// ===========================================================================

test('the shared policy is inert while the paywall is off', async () => {
  const uid = freshUser();
  const access = await crowdRouter.forecastAccess(uid, { count: true });
  assert.deepStrictEqual(access, { locked: false, remaining: null, limit: null });
  assert.strictEqual(getUsedThisMonth(uid), 0,
    'the dormant paywall spent a view; with PAYWALL_ENABLED unset nothing may be metered at all');
});

test('the shared policy meters, locks, and never charges a subscriber', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = freshUser();
  notPremium();

  const first = await crowdRouter.forecastAccess(uid, { count: true });
  assert.strictEqual(first.locked, false);
  assert.strictEqual(first.remaining, FREE_MONTHLY_FORECASTS - 1);

  // A read that does not count (a list preview) must not move the meter.
  const peek = await crowdRouter.forecastAccess(uid, { count: false });
  assert.strictEqual(peek.remaining, FREE_MONTHLY_FORECASTS - 1);

  spendAllowance(uid);
  const locked = await crowdRouter.forecastAccess(uid, { count: true });
  assert.deepStrictEqual(locked, { locked: true, remaining: 0, limit: FREE_MONTHLY_FORECASTS });

  const proId = freshUser();
  spendAllowance(proId);
  handlers = [];
  isPremiumUser();
  const pro = await crowdRouter.forecastAccess(proId, { count: true });
  assert.deepStrictEqual(pro, { locked: false, remaining: null, limit: null },
    'a paying subscriber was metered');

  // THE KEY CONTRACT, and it is what makes the gate's field rebuild safe.
  // gateForecast copies `locked`/`remaining`/`limit` out one at a time rather
  // than spreading the policy object, so that a field added here for internal
  // use cannot ride out to every client. Pinning the key set is the other half:
  // as long as the policy carries only these three, both spellings are correct,
  // and the day somebody adds a fourth this fails and they have to choose.
  for (const [label, obj] of [['unlocked', first], ['locked', locked], ['pro', pro]]) {
    assert.deepStrictEqual(Object.keys(obj).sort(), ['limit', 'locked', 'remaining'],
      `the ${label} policy object grew a field; it is spread into a client response in routes/crowd.js`);
  }
  // The unmetered answer is one shared object handed out by reference to every
  // caller in the process, routes/ai.js included. Unfrozen, any one of them
  // could set `locked = false` on it once and turn the paywall off for
  // everybody until the next deploy.
  assert.ok(Object.isFrozen(pro), 'the shared unmetered policy object is mutable');
});

test('a pre-resolved tier is honoured without a second is_premium query', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = freshUser();
  spendAllowance(uid);
  // No is_premium handler is scripted: reaching the database here would be the
  // duplicate query the `premium` argument exists to avoid.
  const asPro = await crowdRouter.forecastAccess(uid, { premium: true });
  assert.strictEqual(asPro.locked, false);
  assert.strictEqual(log.filter((q) => /is_premium/.test(q.sql)).length, 0,
    'the caller had already paid for the tier lookup and it was run again');
  const asFree = await crowdRouter.forecastAccess(uid, { premium: false });
  assert.strictEqual(asFree.locked, true);
});

test('the venue card does not publish an attendance figure nobody counted', async () => {
  notPremium();
  const res = await call('GET', '/api/crowd/EVT_ALERT?localHour=20&localDay=5');
  assert.strictEqual(res.status, 200, res.text);
  // The alert itself is real and still fires.
  assert.strictEqual(res.body.eventAlert.hasEvent, true);
  assert.strictEqual(res.body.eventAlert.eventName, 'Test Show');
  assert.strictEqual(res.body.eventAlert.distance, '1.2 km away');
  // The predictor produced 20000 for this event. It is a model feature derived
  // from a venue-name substring test ("arena" / "garden" / "theatre"), not a
  // headcount, so it must not reach a screen under any key.
  const seen = valuesIn(res.body);
  assert.ok(!seen.numbers.has(20000),
    'estimatedAttendance reached the client; that number is a guess from the venue NAME and this project does not show people figures that are not real');
  assert.ok(!('estimatedAttendance' in res.body.eventAlert));
});

// ===========================================================================
// SECTION 2 — routes/publicCrowd.js, the unauthenticated door
// ===========================================================================

// Every request in this file arrives from one address, and with the paywall on
// the demo remembers three venues a day per address. A test about something
// else starts as a fresh visitor so it is not reading the last test's three.
const { resetDemoRevealsForTest, resetDemoLimitsForTest, demoReveals, mayShowCrowd, REVEAL_MAX_ENTRIES } = publicCrowdRouter.__testables;

async function demoCard(id, { locked }) {
  if (locked) process.env.PAYWALL_ENABLED = 'true';
  else delete process.env.PAYWALL_ENABLED;
  const res = await call('GET', `/api/public/demo/venue/${id}?localHour=20&localDay=5`);
  assert.strictEqual(res.status, 200, res.text);
  return res.body;
}

test('the public demo shows the whole forecast while the paywall is dormant', async () => {
  const card = await demoCard('DEMO_OPEN', { locked: false });
  assert.ok(card.best_time, 'the demo lost its best-time line with the paywall off');
  assert.ok(card.peak_hours);
  assert.ok(card.hourly.length > 0);
  assert.ok(!('forecast_locked' in card), 'the dormant paywall announced itself on the marketing page');
});

test('with the paywall on, the demo serves the free tier and not a penny more', async () => {
  resetDemoRevealsForTest();
  const open = await demoCard('DEMO_GATE', { locked: false });
  const answers = premiumAnswers(open, { best: 'best_time', peak: 'peak_hours', hourly: 'hourly' });

  // Same venue, same hour: a cache HIT, which is the path that matters most.
  // The card in the cache is the full one, shared by every visitor, so a gate
  // applied at build time would have been baked into a 10 minute entry.
  const locked = await demoCard('DEMO_GATE', { locked: true });
  assert.strictEqual(locked.forecast_locked, true);
  assertNoLeak(locked, answers, 'public demo venue card');

  // ...and the demo is still a demo. Gating the live score would have left a
  // marketing page showing nothing at all.
  assert.strictEqual(locked.score, open.score);
  assert.strictEqual(locked.label, open.label);
  assert.strictEqual(locked.confidence, open.confidence);
  assert.strictEqual(locked.is_open, open.is_open);
  assert.strictEqual(locked.name, open.name);
  assert.ok(typeof locked.age_ms === 'number', 'the freshness stamp was lost to the gate');
});

test('a fresh (uncached) demo card is gated too', async () => {
  resetDemoRevealsForTest();
  process.env.PAYWALL_ENABLED = 'true';
  const res = await call('GET', '/api/public/demo/venue/DEMO_FRESH?localHour=20&localDay=5');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.forecast_locked, true);
  assert.strictEqual(res.body.best_time, null);
  assert.deepStrictEqual(res.body.hourly, []);
  assert.ok(fetched.some((u) => u.includes('DEMO_FRESH')), 'this was a cache hit; the fresh path was never exercised');
});

test('the card embedded in the area search is gated on both the fresh and the cached path', async () => {
  resetDemoRevealsForTest();
  NEARBY = [place('AREA_ONE'), place('AREA_TWO')];

  delete process.env.PAYWALL_ENABLED;
  const open = await call('GET', '/api/public/demo/venues?lat=11.11&lng=22.22&localHour=20&localDay=5');
  assert.strictEqual(open.status, 200, open.text);
  assert.ok(open.body.card, 'the area search stopped embedding a card; this test is looking at nothing');
  const answers = premiumAnswers(open.body.card, { best: 'best_time', peak: 'peak_hours', hourly: 'hourly' });

  // The cached branch: same bucket, same clock.
  process.env.PAYWALL_ENABLED = 'true';
  const cached = await call('GET', '/api/public/demo/venues?lat=11.11&lng=22.22&localHour=20&localDay=5');
  assert.strictEqual(cached.body.card.forecast_locked, true);
  assertNoLeak(cached.body, answers, 'area search (cached)');

  // The fresh branch: a bucket nothing has asked for yet.
  const fresh = await call('GET', '/api/public/demo/venues?lat=33.33&lng=44.44&localHour=20&localDay=5');
  assert.strictEqual(fresh.status, 200, fresh.text);
  assert.strictEqual(fresh.body.card.forecast_locked, true);
  assertNoLeak(fresh.body, answers, 'area search (fresh)');

  // The pin list is the demo. Inside a visitor's first three venues of the
  // day, and there are only two here, every venue keeps its live score.
  assert.strictEqual(fresh.body.venues.length, 2);
  for (const v of fresh.body.venues) {
    assert.strictEqual(typeof v.score, 'number');
    assert.ok(v.label);
  }
});

test('the shared cache is never poisoned with a gated card', async () => {
  resetDemoRevealsForTest();
  // Locked first, unlocked second, same key. If the gate were applied before
  // setCache, the visitor who arrived while the paywall was on would have
  // written a blanked card into the 10-minute entry and everybody after them,
  // including a Pro user on another surface, would read it.
  process.env.PAYWALL_ENABLED = 'true';
  const locked = await call('GET', '/api/public/demo/venue/DEMO_POISON?localHour=20&localDay=5');
  assert.strictEqual(locked.body.forecast_locked, true);

  delete process.env.PAYWALL_ENABLED;
  const after = await call('GET', '/api/public/demo/venue/DEMO_POISON?localHour=20&localDay=5');
  assert.ok(after.body.best_time, 'the cached card was gated in place, not per response');
  assert.ok(after.body.hourly.length > 0);
  assert.ok(!('forecast_locked' in after.body));
});

// ---------------------------------------------------------------------------
// SECTION 2b: the live level on the demo, three venues a visitor a day
//
// The app covers the live level once a free account has spent its thirty
// venues. Without a rule here the demo was the way around that: sign out and
// read the map on the homepage instead. With the paywall on, a visitor gets the
// crowd level for three distinct venues a UTC day, pins and cards together.
// ---------------------------------------------------------------------------

const CROWD_READINGS = ['score', 'label', 'confidence', 'confidence_measurement', 'confidence_basis'];

test('with the paywall on, a visitor sees the crowd level for three venues a day and the fourth is covered', async () => {
  // A fresh visitor with a fresh hourly budget: this file has spent the
  // address's 20 misses an hour long before it gets here.
  resetDemoLimitsForTest();
  process.env.PAYWALL_ENABLED = 'true';
  for (const id of ['REVEAL_ONE', 'REVEAL_TWO', 'REVEAL_THREE']) {
    const res = await call('GET', `/api/public/demo/venue/${id}?localHour=20&localDay=5`);
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(typeof res.body.score, 'number', `${id} is inside the three and lost its number`);
    assert.ok(!res.body.crowd_locked);
  }

  const fourth = await call('GET', '/api/public/demo/venue/REVEAL_FOUR?localHour=20&localDay=5');
  assert.strictEqual(fourth.status, 200, fourth.text);
  assert.strictEqual(fourth.body.crowd_locked, true, 'the fourth venue of the day was shown');
  for (const k of CROWD_READINGS) {
    assert.strictEqual(fourth.body[k], null, `a covered card still carries ${k}`);
  }
  assert.strictEqual(fourth.body.best_time, null);
  assert.deepStrictEqual(fourth.body.hourly, []);
  // Venue facts stay: the card still says what the place is.
  assert.strictEqual(fourth.body.place_id, 'REVEAL_FOUR');
  assert.ok(fourth.body.name);
  assert.ok(typeof fourth.body.age_ms === 'number');

  // Opening one of the three again costs nothing and still shows it.
  const again = await call('GET', '/api/public/demo/venue/REVEAL_TWO?localHour=20&localDay=5');
  assert.strictEqual(typeof again.body.score, 'number', 'a venue already shown today was covered on a second look');

  // A cache hit is counted too: the shared cache must not be the way around it.
  const hit = await call('GET', '/api/public/demo/venue/REVEAL_FOUR?localHour=20&localDay=5');
  assert.strictEqual(hit.body.crowd_locked, true, 'a cache hit handed out the number the miss had covered');
});

test('the pins draw on the same three, the embedded card first', async () => {
  // A fresh visitor with a fresh hourly budget: this file has spent the
  // address's 20 misses an hour long before it gets here.
  resetDemoLimitsForTest();
  process.env.PAYWALL_ENABLED = 'true';
  NEARBY = ['PIN_A', 'PIN_B', 'PIN_C', 'PIN_D', 'PIN_E'].map((id) => place(id));
  const res = await call('GET', '/api/public/demo/venues?lat=55.55&lng=66.66&localHour=20&localDay=5');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.card, 'the area search stopped embedding a card; this test is looking at nothing');
  assert.strictEqual(typeof res.body.card.score, 'number', 'the hero card was covered for a brand-new visitor');

  const shown = res.body.venues.filter((v) => typeof v.score === 'number');
  const covered = res.body.venues.filter((v) => v.crowd_locked === true);
  assert.strictEqual(res.body.venues.length, 5);
  assert.strictEqual(shown.length, 3, 'more than three pins carried a number');
  assert.strictEqual(covered.length, 2);
  assert.ok(shown.some((v) => v.place_id === res.body.card.place_id), 'the card venue and its pin were counted twice');
  for (const v of covered) {
    assert.strictEqual(v.score, null);
    assert.strictEqual(v.label, null);
    assert.ok(!('confidence' in v), 'a covered pin grew a confidence key a pin never carries');
    assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lng), 'a covered pin lost its place on the map');
  }

  // The three are spent, so a card for a venue outside them is covered.
  const other = covered[0].place_id;
  const card = await call('GET', `/api/public/demo/venue/${other}?localHour=20&localDay=5`);
  assert.strictEqual(card.body.crowd_locked, true, 'a covered pin opened into a card with the number on it');
});

test('a new UTC day gives the visitor three new venues', async () => {
  // A fresh visitor with a fresh hourly budget: this file has spent the
  // address's 20 misses an hour long before it gets here.
  resetDemoLimitsForTest();
  process.env.PAYWALL_ENABLED = 'true';
  for (const id of ['DAY_ONE', 'DAY_TWO', 'DAY_THREE']) {
    await call('GET', `/api/public/demo/venue/${id}?localHour=20&localDay=5`);
  }
  const spent = await call('GET', '/api/public/demo/venue/DAY_FOUR?localHour=20&localDay=5');
  assert.strictEqual(spent.body.crowd_locked, true);

  // Yesterday, as far as the memory knows.
  for (const entry of demoReveals.values()) entry.day = '2000-01-01';
  const next = await call('GET', '/api/public/demo/venue/DAY_FOUR?localHour=20&localDay=5');
  assert.strictEqual(typeof next.body.score, 'number', 'a new day did not give the visitor their three again');
});

test('with the paywall off the demo counts nothing and covers nothing', async () => {
  // A fresh visitor with a fresh hourly budget: this file has spent the
  // address's 20 misses an hour long before it gets here.
  resetDemoLimitsForTest();
  delete process.env.PAYWALL_ENABLED;
  for (const id of ['OFF_ONE', 'OFF_TWO', 'OFF_THREE', 'OFF_FOUR', 'OFF_FIVE']) {
    const res = await call('GET', `/api/public/demo/venue/${id}?localHour=20&localDay=5`);
    assert.strictEqual(typeof res.body.score, 'number');
    assert.ok(!('crowd_locked' in res.body), 'the dormant paywall announced itself on the marketing page');
  }
  NEARBY = ['OFF_A', 'OFF_B', 'OFF_C', 'OFF_D', 'OFF_E'].map((id) => place(id));
  const area = await call('GET', '/api/public/demo/venues?lat=77.77&lng=88.88&localHour=20&localDay=5');
  assert.ok(area.body.venues.every((v) => typeof v.score === 'number' && !('crowd_locked' in v)));
  assert.strictEqual(demoReveals.size, 0, 'the paywall is off and the demo remembered a visitor anyway');
});

test('the per-visitor memory is bounded, and a spent visitor is the last to be forgotten', () => {
  resetDemoRevealsForTest();
  process.env.PAYWALL_ENABLED = 'true';
  const spender = { ip: '203.0.113.7' };
  for (const id of ['S1', 'S2', 'S3']) assert.strictEqual(mayShowCrowd(spender, id), true);
  assert.strictEqual(mayShowCrowd(spender, 'S4'), false);
  for (let i = 0; i < REVEAL_MAX_ENTRIES + 10; i += 1) mayShowCrowd({ ip: `198.51.${i >> 8}.${i & 255}` }, 'ONE');
  assert.ok(demoReveals.size <= REVEAL_MAX_ENTRIES, `the memory grew to ${demoReveals.size}`);
  assert.ok(demoReveals.has(spender.ip), 'a flood of one-venue visitors evicted the address that had spent its three');
  assert.strictEqual(mayShowCrowd(spender, 'S4'), false, 'eviction handed the spent visitor three new venues');
  resetDemoRevealsForTest();
});


// ===========================================================================
// SECTION 3 — routes/ai.js, the door with a user behind it
//
// Birdie is not the demo. This is a logged-in, identified account spending one
// of its own metered turns on a venue it named, so the answer is not "never" —
// it is "out of the same ten a month the card draws on". These tests pin both
// halves of that: the forecast is served while there is allowance, and it is
// gone when there is not.
// ===========================================================================

const crowdToolTurn = (calls) => (_p, n) => (n === 1
  ? {
    candidates: [{
      content: {
        parts: calls.map((placeId, i) => ({
          functionCall: { id: `c${i}`, name: 'get_crowd_prediction', args: { place_id: placeId } },
        })),
      },
    }],
  }
  : { candidates: [{ content: { parts: [{ text: 'go at 9' }] } }] });

function toolResultsSentToGemini() {
  const parts = [];
  for (const c of sendCalls) {
    if (!Array.isArray(c.message)) continue;
    for (const p of c.message) {
      if (p.functionResponse?.name === 'get_crowd_prediction') parts.push(p.functionResponse.response);
    }
  }
  return parts;
}

async function birdieCrowd(placeIds) {
  sendImpl = crowdToolTurn(placeIds);
  const res = await call('POST', '/api/ai/chat', { messages: [{ role: 'user', text: 'when should I go' }] });
  assert.strictEqual(res.status, 200, res.text);
  return toolResultsSentToGemini();
}

test('Birdie serves the whole forecast while the paywall is dormant', async () => {
  const [out] = await birdieCrowd(['BIRDIE_OPEN']);
  assert.ok(out.best_time, 'Birdie lost the best time with the paywall off');
  assert.ok(out.peak_hours);
  assert.ok(out.hourly_forecast.length > 0);
  assert.ok(!out.forecast_locked);
});

test('a free user with allowance left gets the full forecast through Birdie, and it costs one view', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  notPremium();
  const [out] = await birdieCrowd(['BIRDIE_ALLOWED']);
  assert.ok(out.best_time, 'a user inside their free allowance was refused the forecast they are entitled to');
  assert.ok(out.hourly_forecast.length > 0);
  assert.strictEqual(getUsedThisMonth(uid), 1, 'Birdie served a gated forecast without charging the meter');
});

test('a spent allowance closes Birdie too, and leaves nothing to rebuild the curve from', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  notPremium();
  const [open] = await birdieCrowd(['BIRDIE_CMP']);
  const answers = premiumAnswers(
    { best_time: open.best_time, peak_hours: open.peak_hours, hourly: open.hourly_forecast },
    { best: 'best_time', peak: 'peak_hours', hourly: 'hourly' },
  );

  const uid = freshUser();
  spendAllowance(uid);
  handlers = [];
  notPremium();
  sendCalls = [];
  const [locked] = await birdieCrowd(['BIRDIE_CMP']);

  assert.strictEqual(locked.forecast_locked, true);
  assert.ok(locked.forecast_note, 'the model was given no instruction not to invent the missing forecast');
  assert.match(locked.forecast_note, /no crowd reading/, 'the note must tell the model there is no level to quote');
  // Since 2026-09-24 the live level is covered too, the same as the card: no
  // score, label, source or confidence reaches the model for a locked venue.
  for (const field of ['crowd_score', 'crowd_label', 'crowd_source', 'crowd_attribution', 'confidence', 'confidence_measurement']) {
    assert.strictEqual(locked[field], undefined, `a locked Birdie lookup still carries ${field}`);
  }
  // The venue's facts stay, so Birdie can still say what it is and whether it is open.
  assert.ok(locked.venue_name);
  // Swept over what was actually put on the wire to Gemini, which is the thing
  // that reaches the user: anything in this payload can come back out in prose.
  assertNoLeak(locked, answers, 'Birdie crowd tool');
});

test('what Birdie is told about the free tier matches what the gate does', async () => {
  // The system prompt is the only description of the paywall the user ever
  // reads, since Birdie relays it in its own words. It used to say hour-by-hour
  // was Pro outright, which stopped being true the moment Birdie started
  // drawing on the same ten-a-month allowance as the card: the model would have
  // refused, in prose, something the user was entitled to and had already been
  // given. A wrong sentence here is a worse bug than a wrong field, because
  // nothing downstream can correct it.
  process.env.PAYWALL_ENABLED = 'true';
  notPremium();
  await birdieCrowd(['BIRDIE_PROMPT']);
  const prompt = String(sendCalls[0].config.systemInstruction);
  assert.match(prompt, /free tier/, 'the free-tier line vanished from the prompt');
  assert.match(prompt, new RegExp(`first ${FREE_MONTHLY_FORECASTS} venues`),
    'Birdie is told the forecast is Pro outright, while the gate in fact gives the first FREE_MONTHLY_FORECASTS away');
  assert.ok(!/hour-by-hour crowd forecasts are a Flock Pro feature/.test(prompt),
    'the prompt still carries the pre-gate claim');
  // Scoped to the tier sentence, not the whole prompt, because that is the one
  // Birdie paraphrases straight back to the user. This used to be scoped out of
  // necessity: the app-description block above it used em dashes as structure,
  // contradicting the prompt's own instruction never to emit one. The
  // 2026-08-18 voice rewrite removed them, and __tests__/birdieVoice.test.js
  // now sweeps the WHOLE prompt for em dashes in every bracket and tier. This
  // assertion stays anyway: it is the paywall lane's own guard, and it is the
  // one that fires on the sentence that matters most.
  const tierLine = prompt.split('\n').find((l) => l.includes('free tier'));
  assert.ok(!tierLine.includes('—'), `em dash in the paywall line: ${tierLine}`);

  // ...and a subscriber is told none of it.
  sendCalls = [];
  handlers = [];
  isPremiumUser();
  await birdieCrowd(['BIRDIE_PROMPT_PRO']);
  assert.ok(!/free tier/.test(String(sendCalls[0].config.systemInstruction)),
    'a paying subscriber was pitched the free tier');
});

test('a Pro subscriber is never locked out of Birdie', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  spendAllowance(uid);
  isPremiumUser();
  const [out] = await birdieCrowd(['BIRDIE_PRO']);
  assert.ok(out.best_time, 'a paying subscriber lost the forecast');
  assert.ok(out.hourly_forecast.length > 0);
});

// PER VENUE, THE SAME AS THE CARD (2026-09-24). Birdie used to charge once per
// TURN, and an adversarial pass showed what that bought: one turn returned the
// full forecast for thirty venues while the meter moved by one, and five turns
// racing at 29 of 30 all got through. The allowance is venues, however they are
// asked for.
test('one turn spends one view per new venue the model looks at, the same as the card', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  notPremium();
  const results = await birdieCrowd(['V1', 'V2', 'V3', 'V4']);
  assert.strictEqual(results.length, 4, 'the model did not actually make four lookups');
  for (const r of results) assert.ok(r.best_time, 'a venue inside the allowance was refused');
  assert.strictEqual(getUsedThisMonth(uid), 4,
    'four venues were forecast and the meter did not count four');
});

test('thirty new venues in one turn spend all thirty, and the next one is locked without computing anything paid', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  notPremium();
  const ids = Array.from({ length: FREE_MONTHLY_FORECASTS + 1 }, (_, i) => `MANY_${String(i).padStart(3, '0')}`);
  const results = await birdieCrowd(ids);
  assert.strictEqual(results.length, ids.length, 'the model did not make every lookup');
  const open = results.filter((r) => r.best_time);
  assert.strictEqual(open.length, FREE_MONTHLY_FORECASTS,
    'one turn forecast more venues than a month allows');
  const last = results[results.length - 1];
  assert.strictEqual(last.forecast_locked, true, 'the venue past the allowance was not locked');
  assert.ok(!last.best_time && !last.peak_hours && !last.hourly_forecast,
    'the locked venue still carried part of the paid forecast');
  assert.strictEqual(getUsedThisMonth(uid), FREE_MONTHLY_FORECASTS);
  // One free score per venue, and the paid 24-hour walk for the thirty that
  // were open only: the locked one computed nothing it would throw away.
  assert.strictEqual(scored.length, ids.length + FREE_MONTHLY_FORECASTS,
    'the locked venue ran the hourly forecast and then discarded it');
});

test('a venue already opened this month is free through Birdie, even once the month is spent', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  recordView(uid, 'SEEN_BEFORE');
  for (let i = 1; i < FREE_MONTHLY_FORECASTS; i++) recordView(uid, `SPENT_${i}`);
  notPremium();
  const [seen, fresh] = await birdieCrowd(['SEEN_BEFORE', 'NEVER_SEEN']);
  assert.ok(seen.best_time, 'a venue this account already opened was locked again');
  assert.strictEqual(fresh.forecast_locked, true, 'a new venue opened past the allowance');
  assert.strictEqual(getUsedThisMonth(uid), FREE_MONTHLY_FORECASTS, 'opening a seen venue was charged again');

  // ...and the same venue twice in one reply costs once.
  const other = freshUser();
  handlers = [];
  notPremium();
  sendCalls = [];
  const twice = await birdieCrowd(['SAME_ONE', 'SAME_ONE']);
  for (const r of twice) assert.ok(r.best_time);
  assert.strictEqual(getUsedThisMonth(other), 1, 'one venue asked about twice was charged twice');
});

test('a turn that starts on the last free venue answers the first new venue and locks the rest', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  for (let i = 0; i < FREE_MONTHLY_FORECASTS - 1; i++) recordView(uid);
  notPremium();
  const results = await birdieCrowd(['EDGE_A', 'EDGE_B', 'EDGE_C']);
  assert.strictEqual(results.length, 3);
  assert.ok(results[0].best_time, 'the last free venue was refused');
  for (const r of results.slice(1)) {
    assert.strictEqual(r.forecast_locked, true, 'a venue past the allowance was answered');
    assert.ok(!r.best_time && !r.peak_hours && !r.hourly_forecast);
  }
  assert.strictEqual(getUsedThisMonth(uid), FREE_MONTHLY_FORECASTS);
});

test('turns racing at 29 of 30 open exactly one new venue between them', async () => {
  // The race the per-turn memo lost: every turn peeked at 29, every turn
  // forecast its venues, and the charge at 30 was a silent no-op. Places is
  // slowed so every turn is past its peek before any of them charges, which
  // is the window the check-and-record after delivery has to close.
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  for (let i = 0; i < FREE_MONTHLY_FORECASTS - 1; i++) recordView(uid, `RACE_SPENT_${i}`);
  notPremium();
  let turn = 0;
  sendImpl = (params) => {
    if (Array.isArray(params.message)) return { candidates: [{ content: { parts: [{ text: 'go at 9' }] } }] };
    const t = turn++;
    return {
      candidates: [{
        content: { parts: [{ functionCall: { id: `r${t}`, name: 'get_crowd_prediction', args: { place_id: `RACE_NEW_${t}` } } }] },
      }],
    };
  };
  const savedFetch = global.fetch;
  global.fetch = (url, opts) => (String(url).startsWith('https://places.googleapis.com/v1/places/')
    ? new Promise((resolve) => setTimeout(resolve, 80)).then(() => savedFetch(url, opts))
    : savedFetch(url, opts));
  let turns;
  try {
    turns = await Promise.all([0, 1, 2, 3, 4].map(() => call('POST', '/api/ai/chat', {
      messages: [{ role: 'user', text: 'when should I go' }],
    })));
  } finally {
    global.fetch = savedFetch;
  }
  for (const r of turns) assert.strictEqual(r.status, 200, r.text);
  const results = toolResultsSentToGemini();
  assert.strictEqual(results.length, 5, 'every racing turn should have looked a venue up');
  const open = results.filter((r) => r.best_time || r.peak_hours || (Array.isArray(r.hourly_forecast) && r.hourly_forecast.length));
  assert.strictEqual(open.length, 1, `${open.length} venues opened from 29 of 30`);
  for (const r of results.filter((x) => !x.best_time)) {
    assert.strictEqual(r.forecast_locked, true);
    assert.ok(r.forecast_note, 'a racing turn that lost was given no instruction not to invent the forecast');
  }
  assert.strictEqual(getUsedThisMonth(uid), FREE_MONTHLY_FORECASTS);
});

test('a lookup that failed is not charged to the allowance', async () => {
  // Round 2 of this work charged the view up front, the moment the model asked
  // for a crowd prediction. Google answering "not found" then cost the user one
  // of ten a month for an error message. The card route never had this problem
  // because it 502s before it reaches its gate.
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  notPremium();
  const savedFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://places.googleapis.com/v1/places/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ error: { status: 'NOT_FOUND' } }) });
    }
    return savedFetch(url, opts);
  };
  try {
    const [out] = await birdieCrowd(['BIRDIE_404']);
    assert.ok(out.error, 'the lookup was supposed to fail; this test proves nothing');
  } finally {
    global.fetch = savedFetch;
  }
  assert.strictEqual(getUsedThisMonth(uid), 0,
    'a venue that could not be looked up still cost the user one of their ten forecasts');
});

test('a turn that never asks about a venue never touches the forecast meter', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  notPremium();
  sendImpl = (_p, n) => (n === 1
    ? { candidates: [{ content: { parts: [{ functionCall: { id: 'n1', name: 'navigate_app', args: { tab: 'home' } } }] } }] }
    : { candidates: [{ content: { parts: [{ text: 'nest tab' }] } }] });
  const res = await call('POST', '/api/ai/chat', { messages: [{ role: 'user', text: 'where are my plans' }] });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(getUsedThisMonth(uid), 0,
    'a conversation about navigation spent a forecast');
});

test('a locked Birdie lookup does not pay to compute a forecast it throws away', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  spendAllowance(uid);
  notPremium();
  scored = [];
  await birdieCrowd(['BIRDIE_CHEAP']);
  // predictBusyness runs (that is the free score). The 24-hour walk must not.
  assert.strictEqual(scored.length, 1,
    'the locked path still ran the hourly forecast and then discarded it');
});

// ===========================================================================
// SECTION 4 — routes/badge.js stays ungated, ON PURPOSE
//
// The badge computes no forecast. It is one live label on a pill, on the
// venue's own website, for a venue that claimed and verified its listing. That
// is the free tier and a distribution surface, not a hole. What is pinned here
// is the tripwire: the day somebody adds "best time to go" to the badge, this
// fails, because at that moment it becomes an unauthenticated unmetered copy of
// the paid product.
// ===========================================================================

test('the badge computes no part of the paid forecast', () => {
  const code = codeOf(fs.readFileSync(path.join(BACKEND, 'routes', 'badge.js'), 'utf8'));
  for (const fn of ['predictHourlyForecast', 'recommendBestTime', 'findBestTime', 'findPeakTime']) {
    assert.ok(!code.includes(fn),
      `routes/badge.js now calls ${fn}. It is unauthenticated, unmetered and cached for the public, so it needs the gate routes/publicCrowd.js has.`);
  }
  assert.ok(code.includes('predictBusyness'), 'the badge stopped serving a live score at all');
});

test('the badge serves a live label and no time of day', async () => {
  handlers.push([/FROM venue_profiles/, () => ({ rows: [{ '?column?': 1 }] })]);
  process.env.PAYWALL_ENABLED = 'true'; // no effect here, and that is the point
  const res = await realFetch(`${base}/api/badge/BADGE_ONE.svg`);
  assert.strictEqual(res.status, 200);
  const svg = await res.text();
  assert.match(svg, /right now/, 'the badge stopped saying anything');
  assert.ok(!/\b\d{1,2}\s?(AM|PM)\b/i.test(svg),
    'the badge printed an hour; a time of day on an unauthenticated pill is the paid forecast');
  assert.ok(!/best time|peak/i.test(svg));
});

test('the badge scores the venue on THIS week, not next', () => {
  const { venueLocalTime } = badgeRouter.__testables;
  // A UTC Sunday. A venue far enough west is still on Saturday, and the old
  // `localDay - getDay()` arithmetic read that as "+6 days" and scored the
  // badge against a date six days out, taking the holiday, school-break,
  // special-night and Ticketmaster-window features with it.
  const utcSunday = new Date(Date.UTC(2026, 7, 16, 6, 0, 0)); // 2026-08-16
  const { scoreTime, localDay } = venueLocalTime(39.7, -150, utcSunday);
  assert.strictEqual(scoreTime.getDay(), localDay, 'the scoring date is not even on the right weekday');
  const daysApart = Math.abs(scoreTime.getTime() - utcSunday.getTime()) / 86400000;
  assert.ok(daysApart <= 3.5,
    `the badge scored a venue ${daysApart.toFixed(1)} days away from now; a weekday DIFFERENCE is not a number of days`);
});

// ===========================================================================
// SECTION 5 — what the model is actually handed
//
// Not a paywall bug, the same class as one: a field read at inference that no
// live caller populated the way training did. The strip view scores the
// neighbours an owner is compared against, and it built them without
// user_ratings_total or price_level, so services/mlPredictor.js buildFeatureMap
// fell through to `review_count = 0` and `price_level = median`. Every
// competitor on the strip was a venue nobody had ever reviewed, at the same
// price as every other. The number that came back looked fine.
// ===========================================================================

const VERIFIED_CTX = { id: 9, google_place_id: 'STRIP_ME', verified: true };

test('the strip hands the model every feature it paid Google for', async () => {
  CURRENT_USER = { id: 4242, name: 'Owner', role: 'venue_owner' };
  handlers = [
    [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'insights' }] })],
    [/SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles/, () => ({ rows: [VERIFIED_CTX] })],
    [/[\s\S]*/, () => ({ rows: [] })],
  ];
  NEARBY = [
    place('STRIP_RIVAL', { userRatingCount: 812, priceLevel: 'PRICE_LEVEL_VERY_EXPENSIVE' }),
    // Google omits priceLevel for plenty of places. "Unknown" must reach the
    // model as null so buildFeatureMap falls back to the corpus median, NOT as
    // 0, which is a real price tier meaning free.
    place('STRIP_NOPRICE', { userRatingCount: 5, priceLevel: undefined }),
  ];
  scored = [];

  const res = await call('GET', '/api/venue-dashboard/strip');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.available, true, JSON.stringify(res.body));
  assert.strictEqual(res.body.competitors.length, 2, 'no competitor was scored; this test is looking at nothing');

  const rival = scored.find((v) => v.place_id === 'STRIP_RIVAL');
  assert.ok(rival, 'the competitor never reached the predictor');
  assert.strictEqual(rival.user_ratings_total, 812,
    'every competitor is still scored as a venue nobody has ever reviewed');
  assert.strictEqual(rival.price_level, 4,
    'every competitor is still scored at the corpus median price level');

  const unpriced = scored.find((v) => v.place_id === 'STRIP_NOPRICE');
  assert.ok(unpriced, 'the second competitor never reached the predictor');
  assert.strictEqual(unpriced.price_level, null,
    'a venue Google gave no price for was scored as FREE; unknown must stay unknown so the model falls back to the median');

  // The owner's OWN venue had the same hole, through fetchVenueBasics, and it
  // is the other half of the comparison the strip exists to draw.
  const me = scored.find((v) => v.place_id === 'STRIP_ME');
  assert.ok(me, 'the owner venue never reached the predictor');
  assert.strictEqual(me.user_ratings_total, 300);
  assert.strictEqual(me.price_level, 2,
    "the owner's own venue is still scored at the corpus median price level");
});

// ===========================================================================
// SECTION 6 — the two Birdie request-shape defects
//
// Not paywall work; same file, same class of "the server answered, and the
// answer was not true". Both were found by the body-limit audit.
// ===========================================================================

const AI_SRC = fs.readFileSync(path.join(BACKEND, 'routes', 'ai.js'), 'utf8');

test('the message cap has one spelling', () => {
  const literal = AI_SRC.match(/body\('messages'\)\.isArray\(\{\s*min:\s*\d+,\s*max:\s*(\d+)\s*\}\)/);
  assert.ok(literal, 'the messages cap chain moved; server.js sizes this route\'s body parser off that literal');
  const named = AI_SRC.match(/const AI_CHAT_MAX_MESSAGES = (\d+);/);
  assert.ok(named, 'routes/ai.js no longer names the cap');
  assert.strictEqual(named[1], literal[1],
    'the validator cap and the constant the refusal quotes have drifted apart');
});

test('a conversation that outgrew the cap is told so, not told the array is missing', async () => {
  const long = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` }));
  const res = await call('POST', '/api/ai/chat', { messages: long });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(res.body.code, 'CONVERSATION_TOO_LONG',
    'the client has no machine-readable way to know it should truncate and retry');
  assert.strictEqual(res.body.maxMessages, 24, 'the client would have to hard-code the cap a second time');
  assert.ok(!/required/i.test(res.body.error),
    `the refusal still claims the array is missing: ${res.body.error}`);
  assert.ok(!res.body.error.includes('—'), 'em dash in user-visible copy');

  // The cap itself still holds at 24. A 25th message is refused, a 24th is not.
  const ok = await call('POST', '/api/ai/chat', { messages: long.slice(0, 24) });
  assert.strictEqual(ok.status, 200, ok.text);
});

test('the location the shipping client actually sends is accepted', async () => {
  // `location: null` is what App.js sends whenever the user has not granted
  // location, and every nested currentContext field it builds with `|| null`.
  // In express-validator 7 a bare .optional() REFUSES a JSON null, so these are
  // the shapes that would have started 400ing the moment a validator was added.
  const res = await call('POST', '/api/ai/chat', {
    messages: [{ role: 'user', text: 'hey' }],
    location: null,
    currentContext: {
      screen: 'chat',
      tab: 'home',
      flock: { name: 'Friday', venue: null, status: null },
      venue: { name: 'Oakwood', place_id: null },
    },
  });
  assert.strictEqual(res.status, 200, `a null in the context 400'd Birdie: ${res.text}`);

  const withLoc = await call('POST', '/api/ai/chat', {
    messages: [{ role: 'user', text: 'hey' }],
    location: { lat: 39.74, lng: -104.98 },
  });
  assert.strictEqual(withLoc.status, 200, withLoc.text);
  assert.match(String(sendCalls[sendCalls.length - 1].message), /39\.74/,
    'the approximate location stopped reaching the prompt');
});

test('location is bounded in shape, size and range', async () => {
  const bad = [
    { location: 'here' },
    { location: [39.74, -104.98] },
    { location: { lat: 39.74, lng: -104.98, blob: 'x'.repeat(100) } },
    { location: { lat: ['39.74'], lng: -104.98 } },
    { location: { lat: 999, lng: -104.98 } },
    { location: { lat: 39.74, lng: -999 } },
  ];
  for (const body of bad) {
    const res = await call('POST', '/api/ai/chat', { messages: [{ role: 'user', text: 'hey' }], ...body });
    assert.strictEqual(res.status, 400,
      `${JSON.stringify(body)} was accepted; this is the only unbounded field on a 449KB parser`);
  }
});

test('the shape guard is the shared one, not a private copy', () => {
  assert.match(AI_SRC, /require\('\.\.\/validators\/shape'\)/,
    'routes/ai.js hand-rolled its own shape check instead of using validators/shape.js');
  assert.match(AI_SRC, /scalarOnly\(body\('location\.lat'\)/);
});

test('the strip asks Google for the review count it feeds the model', async () => {
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'venueDashboard.js'), 'utf8');
  const masks = src.match(/X-Goog-FieldMask': '([^']+)'/g) || [];
  assert.ok(masks.length >= 2, 'the field masks moved; this guard is reading nothing');
  for (const mask of masks) {
    assert.ok(/userRatingCount/i.test(mask) && /priceLevel/i.test(mask),
      `a Places field mask in venueDashboard.js no longer requests both feature fields: ${mask}. Shaping them into the venue is pointless if Google was never asked.`);
  }
});
