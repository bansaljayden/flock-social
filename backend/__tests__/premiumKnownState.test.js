// Run: node --test  (from backend/)
//
// THE KNOWN-STATE CONTRACT, ADOPTED AT ITS TWO ROUTE CONSUMERS.
//
// services/entitlements.js getPremiumState() answers three ways: premium,
// known-not-premium, and UNKNOWN (the lookup did not happen or did not
// succeed). routes/ai.js and routes/crowd.js used to consume the bare
// fail-closed boolean, which collapses "we could not find out" into "this user
// has not paid" — so once the paywall is on, one database blip drops a PAYING
// subscriber onto the free meter and the 429/lock they then hit pitches them
// the plan they already bought.
//
// What is pinned here, per consumer:
//   * UNKNOWN answers 503 with `retryable: true`, a sentence honest about the
//     outage, never the upgrade pitch — and spends NOTHING: not a Birdie turn,
//     not a forecast view, not a Gemini call.
//   * The 503 body is EXACTLY { error, code, retryable }. This gate has
//     already once leaked the paid answer through secondary fields
//     (forecastGateParity.test.js tells that story), so the outage answer gets
//     a pinned key set rather than a pinned field-by-field blanking.
//   * Known-not-premium keeps exactly today's behavior: the meter, the lock,
//     the UPGRADE_REQUIRED pitch.
//   * THE DORMANT PATH IS THE LIVE PRODUCT. With PAYWALL_ENABLED unset the
//     tier lookup must never RUN, so an entitlement outage cannot surface on
//     these routes at all — pinned by poisoning the lookup and asserting zero
//     is_premium queries alongside a normal 200.
//
// Is the outage/refusal distinction itself a leak? No: the 503 fires on
// server-side infrastructure state, not account state, so premium and free
// accounts receive byte-identical bodies (pinned below). It does reveal that
// the paywall is on, but GET /api/entitlements already publishes
// `paywallEnabled` to any logged-in caller.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'premium-known-state-test-secret';
// Captured at module load by routes/crowd.js and routes/ai.js.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
// The preflight warning fires once per process when the paywall is on without
// the webhook secret; set it so tests that enable the paywall stay quiet.
process.env.REVENUECAT_WEBHOOK_SECRET = 'premium-known-state-test-webhook';
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
      const out = fn(params || [], flat);
      // A handler may script a FAILURE: returning an Error rejects, which is
      // what a real pool does when the database is unreachable.
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// Destructured at load by both routers.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, conditions: 'Clear' });
weatherService.getForecast = async () => [];

const placesBudget = require('../utils/placesBudget');
placesBudget.allowPlacesSearch = () => true;
placesBudget.allowGlobalPlacesCall = () => true;

// The REAL meters: what these tests protect is that an unknown tier state
// spends none of either.
const { FREE_MONTHLY_FORECASTS, getUsedThisMonth, recordView } = require('../services/forecastUsage');
const { FREE_DAILY_LIMIT, PREMIUM_DAILY_LIMIT, checkUserRateLimit, getUsedToday } = require('../services/birdieUsage');

// --- Gemini, faked ----------------------------------------------------------
const genaiMod = require('@google/genai');
let sendCalls = [];
const fakeChat = {
  sendMessage: async (params) => {
    sendCalls.push(params);
    return { candidates: [{ content: { parts: [{ text: 'oakwood, chill till 9' }] } }] };
  },
};
genaiMod.GoogleGenAI = function FakeGenAI() {
  return { chats: { create: () => fakeChat } };
};

// --- Google Places, faked ---------------------------------------------------
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://places.googleapis.com/')) return realFetch(url, opts);
  if (u.startsWith('https://places.googleapis.com/v1/places:search')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [] }) });
  }
  const id = decodeURIComponent(u.split('/places/')[1] || '').split('?')[0];
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      id: id || 'PLACE_X',
      displayName: { text: id || 'PLACE_X' },
      formattedAddress: '1 Main St',
      rating: 4.2,
      userRatingCount: 300,
      priceLevel: 'PRICE_LEVEL_MODERATE',
      types: ['bar'],
      location: { latitude: 39.74, longitude: -104.98 },
      currentOpeningHours: { openNow: true, periods: [] },
      utcOffsetMinutes: null,
    }),
  });
};
test.after(() => { global.fetch = realFetch; });

// --- the model, faked -------------------------------------------------------
const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({
  score: 30,
  label: crowdEngine.getLabel(30),
  confidence: 60,
  factors: {},
  dataSourcesUsed: ['ml_model'],
  predictionMethod: 'ml',
  modelVersion: 'test',
  eventAlert: null,
});
// A rising curve so the card carries a real best-time answer to (not) leak.
mlPredictor.predictHourlyForecast = async (_venue, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const score = i === 0 ? 30 : 30 + i;
    return { hour: `${h12} ${h < 12 ? 'AM' : 'PM'}`, score, label: crowdEngine.getLabel(score) };
  });

const crowdRouter = require('../routes/crowd');
const aiRouter = require('../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/crowd', crowdRouter);
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

let nextUser = 910000;
const freshUser = () => { CURRENT_USER = { id: ++nextUser, name: 'Ava', role: 'user' }; return CURRENT_USER.id; };

test.beforeEach(() => {
  handlers = [];
  log = [];
  sendCalls = [];
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

const isPremiumQueries = () => log.filter((q) => /SELECT is_premium FROM users/.test(q.sql)).length;
const notPremium = () => handlers.push([/SELECT is_premium FROM users/, () => ({ rows: [{ is_premium: false }] })]);
const isPremiumUser = () => handlers.push([/SELECT is_premium FROM users/, () => ({ rows: [{ is_premium: true }] })]);
// The outage: the tier read itself fails, the way an unreachable database
// fails. Everything else keeps answering, which is exactly the situation in
// which the old code confidently reported "not a subscriber".
const premiumErrors = () => handlers.push([/SELECT is_premium FROM users/, () => new Error('connection terminated unexpectedly')]);

// getPremiumState logs the underlying failure (audited elsewhere); keep this
// file's output readable without asserting on it here.
async function quietly(fn) {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
}

const chatBody = { messages: [{ role: 'user', text: 'when should I go' }] };

// The whole outage contract in one assertion: three keys and not one more.
// Anything extra on this body is a field served to a caller whose tier is
// unknown, which is how the last gate leak happened.
function assertOutageBody(res, what) {
  assert.strictEqual(res.status, 503, `${what}: expected 503, got ${res.status}: ${res.text}`);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['code', 'error', 'retryable'],
    `${what}: the outage body grew or lost a field: ${res.text}`);
  assert.strictEqual(res.body.code, 'ENTITLEMENT_UNAVAILABLE', what);
  assert.strictEqual(res.body.retryable, true, `${what}: the client is not told this is worth retrying`);
  assert.strictEqual(typeof res.body.error, 'string', what);
  assert.ok(!/upgrade|flock pro|\bpro\b|subscribe|paywall/i.test(res.body.error),
    `${what}: the outage sentence pitches the plan: ${res.body.error}`);
  assert.ok(!res.body.error.includes('—'), `${what}: em dash in user-visible copy`);
}

// ===========================================================================
// SECTION 0 — the dormant path is the live product
//
// PAYWALL_ENABLED is unset in production today. Nothing in this change may
// alter behavior while it is off, and the strongest version of that is: the
// tier lookup must never even RUN, so there is no lookup to fail. Both tests
// poison the lookup first — if either route consulted it, the poison would
// either 503 the request or show in the query log.
// ===========================================================================

test('dormant: the venue card never runs the tier lookup, even with the entitlement store down', async () => {
  const uid = CURRENT_USER.id;
  premiumErrors();
  const res = await call('GET', '/api/crowd/DORMANT_CARD?localHour=20&localDay=5');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.bestTime, 'the dormant card lost its forecast');
  assert.ok(res.body.hourly.length > 0);
  assert.ok(!('forecastAccess' in res.body), 'the dormant paywall announced itself on the card');
  assert.strictEqual(isPremiumQueries(), 0,
    'the dormant path consulted the entitlement store; a lookup that does not run is the only one that cannot fail');
  assert.strictEqual(getUsedThisMonth(uid), 0, 'the dormant paywall metered a forecast view');
});

test('dormant: Birdie never runs the tier lookup, even with the entitlement store down', async () => {
  const uid = CURRENT_USER.id;
  premiumErrors();
  const res = await call('POST', '/api/ai/chat', chatBody);
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.text, 'Birdie answered nothing');
  assert.strictEqual(isPremiumQueries(), 0,
    'the dormant path consulted the entitlement store; with the flag unset an entitlement outage must be invisible here');
  assert.strictEqual(getUsedToday(uid), 1, 'the normal turn meter stopped counting');
  assert.strictEqual(res.body.remaining, PREMIUM_DAILY_LIMIT - 1,
    'the dormant tier is no longer the 150/day everyone-is-unmetered tier; behavior changed while the paywall is off');
});

test('dormant: the shared policy never asks who is premium', async () => {
  const uid = freshUser();
  premiumErrors();
  const access = await crowdRouter.forecastAccess(uid, { count: true });
  assert.deepStrictEqual(access, { locked: false, remaining: null, limit: null });
  assert.strictEqual(isPremiumQueries(), 0);
});

// ===========================================================================
// SECTION 1 — routes/ai.js: Birdie on an unknown tier state
// ===========================================================================

test('paywall on, lookup fails: Birdie answers a retryable 503 and spends nothing at all', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  premiumErrors();
  const res = await quietly(() => call('POST', '/api/ai/chat', chatBody));
  assertOutageBody(res, 'Birdie outage');
  assert.strictEqual(isPremiumQueries(), 1, 'the lookup was never attempted, or was retried in-request');
  // Nothing was spent: not a daily turn, not a forecast view, not a paid
  // Gemini call. The 503 must land BEFORE every meter, or a subscriber pays
  // for the outage in allowance.
  assert.strictEqual(getUsedToday(uid), 0, 'the failed request still cost a Birdie turn');
  assert.strictEqual(getUsedThisMonth(uid), 0, 'the failed request still cost a forecast view');
  assert.strictEqual(sendCalls.length, 0, 'Gemini was called for a request that was refused');
});

test('the outage answer carries no account information: two users, byte-identical bodies', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  premiumErrors();
  const a = await quietly(() => call('POST', '/api/ai/chat', chatBody));
  freshUser();
  premiumErrors();
  const b = await quietly(() => call('POST', '/api/ai/chat', chatBody));
  assert.strictEqual(a.status, 503);
  assert.strictEqual(b.status, 503);
  assert.strictEqual(a.text, b.text,
    'the outage body differs between accounts; a distinguishable 503 is an oracle about the account, not the outage');
});

test('known-not-premium keeps exactly today\'s behavior: the meter runs, the lock pitches', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  notPremium();

  const ok = await call('POST', '/api/ai/chat', chatBody);
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(getUsedToday(uid), 1);

  // Spend the rest of the free day directly on the real meter.
  for (let i = 0; i < FREE_DAILY_LIMIT - 1; i++) {
    assert.strictEqual(checkUserRateLimit(uid, FREE_DAILY_LIMIT).allowed, true);
  }
  const refused = await call('POST', '/api/ai/chat', chatBody);
  assert.strictEqual(refused.status, 429, refused.text);
  assert.strictEqual(refused.body.code, 'UPGRADE_REQUIRED',
    'a KNOWN free-tier refusal is the one place the pitch belongs, and it vanished');
  assert.strictEqual(refused.body.retryable, undefined,
    'the paywall refusal now claims to be retryable; that is the outage\'s word, and a locked user retrying gets the same lock');
});

test('a subscriber whose lookup works is untouched by any of this', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  isPremiumUser();
  const res = await call('POST', '/api/ai/chat', chatBody);
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.text);
});

// ===========================================================================
// SECTION 2 — routes/crowd.js: the venue card on an unknown tier state
// ===========================================================================

test('paywall on, lookup fails: the fresh venue card is a retryable 503 that spends no view', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  premiumErrors();
  const res = await quietly(() => call('GET', '/api/crowd/KS_FRESH?localHour=20&localDay=5'));
  assertOutageBody(res, 'venue card outage (fresh)');
  assert.strictEqual(getUsedThisMonth(uid), 0,
    'a request the user got nothing for still cost one of their ten monthly forecasts');
});

test('the cached card answers the outage the same way, leaks nothing, and the cache survives', async () => {
  // Prime the shared cache with the FULL card (paywall off), the way a real
  // process would have: the cache stores ungated cards and the gate is applied
  // per response.
  const open = await call('GET', '/api/crowd/KS_CACHED?localHour=20&localDay=5');
  assert.strictEqual(open.status, 200, open.text);
  assert.ok(open.body.bestTime && open.body.hourly.length > 1,
    'the open card carried no forecast; the leak comparison below would prove nothing');

  // The same key, now with the paywall on and the lookup failing. The full
  // card is sitting right there in the cache; none of it may ride out on the
  // outage answer.
  process.env.PAYWALL_ENABLED = 'true';
  const uid = freshUser();
  premiumErrors();
  const outage = await quietly(() => call('GET', '/api/crowd/KS_CACHED?localHour=20&localDay=5'));
  assertOutageBody(outage, 'venue card outage (cached)');
  assert.strictEqual(getUsedThisMonth(uid), 0, 'the outage spent a view on the cached path');
  const outageText = outage.text;
  assert.ok(!outageText.includes(open.body.bestTime),
    'the cached best-time sentence rode out on the 503');
  for (const h of open.body.hourly.slice(1)) {
    assert.ok(!new RegExp(`\\b${h.score}\\b`).test(outageText),
      `a future-hour score (${h.score}) rode out on the 503`);
  }

  // The blip ends. The same user, now a KNOWN free user, gets the normal
  // metered card off the same cache entry: the outage neither poisoned the
  // cache nor left anything spent or locked behind.
  handlers = [];
  notPremium();
  const after = await call('GET', '/api/crowd/KS_CACHED?localHour=20&localDay=5');
  assert.strictEqual(after.status, 200, after.text);
  assert.ok(after.body.bestTime, 'the cache was poisoned by the outage answer');
  assert.deepStrictEqual(after.body.forecastAccess,
    { locked: false, remaining: FREE_MONTHLY_FORECASTS - 1, limit: FREE_MONTHLY_FORECASTS },
    'recovery did not resume the normal meter where the outage left it (which must be: nothing spent)');
});

test('known-not-premium over the allowance still gets today\'s lock, not a 503', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = CURRENT_USER.id;
  for (let i = 0; i < FREE_MONTHLY_FORECASTS; i++) recordView(uid);
  notPremium();
  const res = await call('GET', '/api/crowd/KS_LOCKED?localHour=20&localDay=5');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.forecastAccess.locked, true,
    'a genuinely spent allowance stopped locking; 503 is for unknown, not for no');
  assert.strictEqual(res.body.bestTime, null);
});

test('the policy itself: unknown throws before the meter, a pre-resolved tier never looks up', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const uid = freshUser();
  premiumErrors();
  await quietly(() => assert.rejects(
    () => crowdRouter.forecastAccess(uid, { count: true }),
    (e) => e.entitlementUnavailable === true && e.status === 503 && e.code === 'ENTITLEMENT_UNAVAILABLE',
    'an unknown tier state must throw the tagged, retryable error, not answer as a policy object'
  ));
  assert.strictEqual(getUsedThisMonth(uid), 0,
    'the throw landed after the meter; an unknown state charged a view');

  // The pre-resolved path is what routes/ai.js always uses (`premium:
  // !freeTier`), and it is what keeps the throw unreachable from Birdie's tool
  // loop: no lookup happens at all, so there is no lookup to fail.
  log = [];
  const pro = await crowdRouter.forecastAccess(uid, { count: false, premium: true });
  assert.deepStrictEqual(pro, { locked: false, remaining: null, limit: null });
  assert.strictEqual(isPremiumQueries(), 0, 'a pre-resolved tier ran the lookup anyway');
});

// ===========================================================================
// SECTION 3 — tripwires in the source
//
// The regression this file guards against is a one-word edit: somebody puts
// the bare boolean back at either call site. Comments do not count.
// ===========================================================================

const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('neither consumer reads the bare fail-closed boolean any more', () => {
  for (const file of ['ai.js', 'crowd.js']) {
    const src = codeOf(fs.readFileSync(path.join(BACKEND, 'routes', file), 'utf8'));
    assert.ok(!/\bisPremium\s*\(/.test(src) && !/\bisPremium\b\s*[,}]/.test(src),
      `routes/${file} consumes isPremium again; that boolean cannot say "we could not find out", which is how a database blip pitches a subscriber the plan they already bought`);
    assert.ok(/\bgetPremiumState\b/.test(src),
      `routes/${file} no longer consults the tri-state`);
    assert.ok(/\.known\b/.test(src),
      `routes/${file} reads the tri-state but never branches on .known, which is the entire point of it`);
    assert.ok(/retryable:\s*true/.test(src),
      `routes/${file} lost the retryable flag on its outage answer`);
  }
});
