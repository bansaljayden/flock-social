// Run: node --test  (from backend/)
//
// THE ENTITLEMENT MACHINERY, AUDITED WHILE IT IS STILL DORMANT.
//
// PAYWALL_ENABLED and VENUE_BILLING_ENABLED are both unset, so none of this
// decides anything today. That is the whole reason to pin it now: the day
// either flag flips, every defect in here is a billing or an access incident,
// and PAYWALL-DECISION.md is an open decision about exactly that flip.
//
// Four properties are asserted, and each one is asserted as BEHAVIOUR through
// the real service or the real Express router, not by reading the source:
//
//   1. FAIL CLOSED, AND SAY WHICH KIND OF NO IT IS. A lookup that errors must
//      never grant access. It must also never be reported as "you have not
//      paid", because that is what shows an upgrade sheet to somebody who is
//      already paying. Both gates now separate the two.
//   2. THE DORMANT FLAG MEANS FREE, NOT PREMIUM AND NOT SILENTLY METERED.
//      With the paywall off Birdie is on the 150/day anti-abuse meter that
//      predates the paywall, the monthly forecast meter is never touched at
//      all, and venue_profiles.tier is never even read.
//   3. NOTHING IS CACHED. Every gate re-reads state, so a revocation bites on
//      the next request and a new subscriber is live on the next request.
//   4. THE POOL IS NOT A SIDE EFFECT. Requiring config/database.js no longer
//      opens a connection; only booting the server does.
//
// Test ids are unique per test because the Birdie and forecast meters are
// process-global in-memory maps shared with every other test in this file.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');

process.env.JWT_SECRET = 'entitlement-gates-test-secret';
delete process.env.PAYWALL_ENABLED;
delete process.env.VENUE_BILLING_ENABLED;
// Both switches carry a once-per-process preflight warning that fires when they
// are ON and the thing that GRANTS the entitlement is not configured. Every
// other test in this file turns the switches on, so the companion variables are
// set here and the preflight tests unset them locally: otherwise the first test
// to enable a paywall would burn the once-flag and the preflight tests would be
// asserting against a warning that had already been emitted.
process.env.REVENUECAT_WEBHOOK_SECRET = 'entitlement-gates-test-webhook-secret';
process.env.ADMIN_USER_IDS = '1';

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
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 120)}`));
}
const realPoolQuery = pool.query.bind(pool);
pool.query = (sql, params) => dispatch(sql, params);

// Stubbed BEFORE routes/entitlements.js is required: it destructures
// `authenticate` at load and mounts it with router.use().
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 4001 };
authMod.authenticate = (req, _res, next) => {
  if (CURRENT_USER) req.user = CURRENT_USER;
  next();
};

const entitlements = require('../services/entitlements');
const {
  isPremium, getPremiumState, paywallEnabled, getEntitlements,
  EntitlementUnavailableError, boolFlag,
} = entitlements;
const venueEntitlements = require('../services/venueEntitlements');
const { requireVenueTier, getVenueTier, venueBillingEnabled } = venueEntitlements;
const { PREMIUM_DAILY_LIMIT, FREE_DAILY_LIMIT, checkUserRateLimit, getUsedToday } = require('../services/birdieUsage');
const { FREE_MONTHLY_FORECASTS, getUsedThisMonth, recordView } = require('../services/forecastUsage');

const entitlementsRouter = require('../routes/entitlements');

// --- the app ----------------------------------------------------------------
let handlerRuns = 0;

const venueRouter = express.Router();
venueRouter.get('/free', requireVenueTier('free'), (_req, res) => { handlerRuns++; res.json({ ok: true }); });
venueRouter.get('/premium', requireVenueTier('premium'), (_req, res) => { handlerRuns++; res.json({ ok: true }); });
venueRouter.get('/pro', requireVenueTier('pro'), (_req, res) => { handlerRuns++; res.json({ ok: true }); });
// Deliberately NOT async: a synchronous throw is the shape that would bubble
// back into a gate whose next() sat inside its own try/catch.
venueRouter.get('/throws', requireVenueTier('premium'), function boom(_req, _res) {
  handlerRuns++;
  throw new Error('downstream handler exploded');
});
venueRouter.get('/sent-then-throws', requireVenueTier('premium'), function boom2(_req, res) {
  handlerRuns++;
  res.json({ ok: true, from: 'handler' });
  throw new Error('after the response');
});

const app = express();
app.use(express.json());
app.use('/api/entitlements', entitlementsRouter);
app.use('/venue', (req, _res, next) => { if (CURRENT_USER) req.user = CURRENT_USER; next(); }, venueRouter);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (!res.headersSent) res.status(500).json({ error: 'server', code: 'SERVER_ERROR' });
});

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  pool.query = realPoolQuery;
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  handlerRuns = 0;
  CURRENT_USER = { id: 4001 };
  delete process.env.PAYWALL_ENABLED;
  delete process.env.VENUE_BILLING_ENABLED;
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const premiumIs = (v) => handlers.push([/SELECT is_premium FROM users/, () => ({ rows: [{ is_premium: v }] })]);
const premiumErrors = (err) => handlers.push([/SELECT is_premium FROM users/, () => (err || new Error('connection terminated unexpectedly'))]);
const tierIs = (tier) => handlers.push([/SELECT tier FROM venue_profiles/, () => ({ rows: [{ tier }] })]);
const tierErrors = () => handlers.push([/SELECT tier FROM venue_profiles/, () => new Error('canceling statement due to statement timeout')]);

let nextId = 700000;
const freshId = () => ++nextId;

async function capture(method, fn) {
  const orig = console[method];
  const lines = [];
  console[method] = (...a) => { lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); };
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console[method] = orig;
  }
}

// ===========================================================================
// SECTION 1 — isPremium / getPremiumState: fail closed, and distinguishable
// ===========================================================================

test('a premium lookup that errors denies access, and never claims the user simply has not paid', async () => {
  premiumErrors();
  const { lines, result } = await capture('error', () => isPremium(freshId()));
  assert.strictEqual(result, false, 'a database error granted premium');
  assert.ok(lines.some((l) => /Entitlement lookup failed/.test(l)),
    'the failure was swallowed silently; a paid boundary that denies every subscriber must say so somewhere');

  handlers = [];
  premiumErrors();
  const state = await getPremiumState(freshId());
  assert.deepStrictEqual({ premium: state.premium, known: state.known }, { premium: false, known: false },
    'a failed lookup is reported as a known "not a subscriber"; that is the answer that shows an upgrade sheet to a paying customer');
  assert.strictEqual(state.reason, 'lookup_failed');
});

test('a real answer is marked known, in both directions', async () => {
  premiumIs(true);
  assert.deepStrictEqual(await getPremiumState(freshId()), { premium: true, known: true, reason: null });
  handlers = [];
  premiumIs(false);
  assert.deepStrictEqual(await getPremiumState(freshId()), { premium: false, known: true, reason: null });
});

test('an account that no longer exists is a known no, not an unknown', async () => {
  // A deleted user is not a subscriber, and answering 503 for one would make
  // account deletion look like an outage.
  handlers.push([/SELECT is_premium FROM users/, () => ({ rows: [] })]);
  const state = await getPremiumState(freshId());
  assert.deepStrictEqual(state, { premium: false, known: true, reason: 'no_such_user' });
});

test('a NULL is_premium column is not premium', async () => {
  premiumIs(null);
  assert.strictEqual(await isPremium(freshId()), false);
  handlers = [];
  handlers.push([/SELECT is_premium FROM users/, () => ({ rows: [{ is_premium: 'yes' }] })]);
  assert.strictEqual(await isPremium(freshId()), false,
    'a non-boolean column value was coerced into a subscription');
});

test('an id that is not a users.id never reaches SQL, and is not premium', async () => {
  // `WHERE id = 'abc'` is a Postgres 22P02. Landing that in the catch would be
  // fail-closed but indistinguishable from a real outage, and it would put a
  // caller-supplied string into a query error in the logs.
  for (const bad of [null, undefined, 0, -1, 1.5, '', 'abc', '7abc', NaN, Infinity, {}, [], true, '  ']) {
    log = [];
    handlers = [];
    assert.strictEqual(await isPremium(bad), false, `${JSON.stringify(String(bad))} was treated as premium`);
    assert.strictEqual(log.length, 0, `${JSON.stringify(String(bad))} reached the database`);
    const state = await getPremiumState(bad);
    assert.strictEqual(state.known, false, 'an unusable id was reported as a known answer');
    assert.strictEqual(state.reason, 'identity');
  }
});

test("'5' and 5 are one account", async () => {
  const id = freshId();
  handlers.push([/SELECT is_premium FROM users/, (params) => ({ rows: [{ is_premium: params[0] === id }] })]);
  assert.strictEqual(await isPremium(String(id)), true,
    'a string id was passed through unnormalised, so the same person can be two accounts to the meter');
  assert.strictEqual(log[0].params[0], id);
  assert.strictEqual(typeof log[0].params[0], 'number');
});

test('the premium read is parameterised and asks for one row by id', async () => {
  const id = freshId();
  premiumIs(true);
  await isPremium(id);
  assert.strictEqual(log.length, 1);
  assert.match(log[0].sql, /WHERE id = \$1$/);
  assert.deepStrictEqual(log[0].params, [id]);
});

// ===========================================================================
// SECTION 2 — the dormant flag means FREE
// ===========================================================================

test('with the paywall unset, everything is free and nothing is metered', async () => {
  const id = freshId();
  premiumIs(false);
  const before = { birdie: getUsedToday(id), forecast: getUsedThisMonth(id) };
  const e = await getEntitlements(id);

  assert.strictEqual(e.paywallEnabled, false);
  assert.strictEqual(e.isPremium, false);
  assert.strictEqual(e.birdie.limit, PREMIUM_DAILY_LIMIT,
    'the dormant paywall handed out the 10/day free tier');
  assert.strictEqual(e.birdie.remaining, PREMIUM_DAILY_LIMIT);
  assert.strictEqual(e.forecast.limit, null, 'the dormant paywall published a forecast limit');
  assert.strictEqual(e.forecast.remaining, null);

  assert.strictEqual(getUsedToday(id), before.birdie, 'reading the snapshot spent a Birdie turn');
  assert.strictEqual(getUsedThisMonth(id), before.forecast, 'reading the snapshot spent a forecast view');
});

test('with the paywall on, a free account gets the documented free tier', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const id = freshId();
  premiumIs(false);
  const e = await getEntitlements(id);
  assert.strictEqual(e.paywallEnabled, true);
  assert.strictEqual(e.birdie.limit, FREE_DAILY_LIMIT);
  assert.strictEqual(e.forecast.limit, FREE_MONTHLY_FORECASTS);
  assert.strictEqual(e.forecast.remaining, FREE_MONTHLY_FORECASTS);
});

test('with the paywall on, a subscriber is unmetered on the forecast and back to 150 Birdie', async () => {
  process.env.PAYWALL_ENABLED = 'true';
  const id = freshId();
  premiumIs(true);
  const e = await getEntitlements(id);
  assert.strictEqual(e.isPremium, true);
  assert.strictEqual(e.birdie.limit, PREMIUM_DAILY_LIMIT);
  assert.strictEqual(e.forecast.limit, null);
  assert.strictEqual(e.forecast.remaining, null);
});

test('the reported allowance is the one the meter actually enforces', async () => {
  // The number on the screen and the number in the meter come from two
  // different modules keyed two different ways. Spend real turns through the
  // real meter and check the snapshot agrees.
  const id = freshId();
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(checkUserRateLimit(id).allowed, true);
  }
  premiumIs(false);
  const e = await getEntitlements(id);
  assert.strictEqual(e.birdie.used, 3);
  assert.strictEqual(e.birdie.remaining, PREMIUM_DAILY_LIMIT - 3);

  handlers = [];
  premiumIs(false);
  recordView(id);
  recordView(id);
  process.env.PAYWALL_ENABLED = 'true';
  const metered = await getEntitlements(id);
  assert.strictEqual(metered.forecast.used, 2);
  assert.strictEqual(metered.forecast.remaining, FREE_MONTHLY_FORECASTS - 2);
});

test('remaining is never negative when the paywall is switched on mid-day', async () => {
  // 150 spent under the dormant flag, then the limit becomes 10. `limit - used`
  // is -N, and a negative number of chirps would render on a screen.
  const id = freshId();
  for (let i = 0; i < FREE_DAILY_LIMIT + 5; i++) checkUserRateLimit(id);
  for (let i = 0; i < FREE_MONTHLY_FORECASTS + 5; i++) recordView(id);
  process.env.PAYWALL_ENABLED = 'true';
  premiumIs(false);
  const e = await getEntitlements(id);
  assert.strictEqual(e.birdie.remaining, 0);
  assert.strictEqual(e.forecast.remaining, 0);
  assert.ok(e.birdie.used > e.birdie.limit, 'this test never produced the overspend it exists to check');
});

test('the snapshot keeps exactly the keys the client contract names', async () => {
  premiumIs(true);
  const e = await getEntitlements(freshId());
  assert.deepStrictEqual(Object.keys(e).sort(), ['birdie', 'forecast', 'isPremium', 'paywallEnabled']);
  assert.deepStrictEqual(Object.keys(e.birdie).sort(), ['limit', 'remaining', 'used']);
  assert.deepStrictEqual(Object.keys(e.forecast).sort(), ['limit', 'remaining', 'used']);
});

// ===========================================================================
// SECTION 3 — the kill switches themselves
// ===========================================================================

test('a kill switch is on for the exact string "true" and nothing else', async () => {
  for (const off of ['1', 'TRUE', 'True', 'yes', 'on', 'false', '', ' true']) {
    process.env.PAYWALL_ENABLED = off;
    await capture('warn', async () => {
      assert.strictEqual(paywallEnabled(), false, `PAYWALL_ENABLED=${JSON.stringify(off)} turned the paywall on`);
    });
    process.env.VENUE_BILLING_ENABLED = off;
    await capture('warn', async () => {
      assert.strictEqual(venueBillingEnabled(), false, `VENUE_BILLING_ENABLED=${JSON.stringify(off)} turned venue billing on`);
    });
  }
  process.env.PAYWALL_ENABLED = 'true';
  assert.strictEqual(paywallEnabled(), true);
  process.env.VENUE_BILLING_ENABLED = 'true';
  assert.strictEqual(venueBillingEnabled(), true);
});

test('a flag that is set to something meaningless is announced once, not swallowed', async () => {
  // The failure this catches is silent and expensive in the other direction:
  // somebody sets PAYWALL_ENABLED=1 in Railway, believes billing is live, and
  // nothing is metered and nothing anywhere says why.
  const name = `ENTITLEMENT_TEST_FLAG_${freshId()}`;
  process.env[name] = 'yes';
  const first = await capture('warn', async () => boolFlag(name));
  assert.strictEqual(first.result, false);
  assert.strictEqual(first.lines.length, 1, 'a meaningless flag value produced no warning at all');
  assert.match(first.lines[0], new RegExp(name));
  assert.match(first.lines[0], /"true"/);

  const second = await capture('warn', async () => boolFlag(name));
  assert.strictEqual(second.lines.length, 0, 'the warning repeats on every request');

  // "false", empty and unset are all meaningful ways to say off, and none of
  // them is a mistake worth logging about. `VAR=` with nothing after it is how a
  // variable is left blank in a dashboard, and warning about it every deploy is
  // how a warning stops being read.
  for (const meaningful of ['false', '']) {
    const other = `${name}_${meaningful || 'EMPTY'}`;
    process.env[other] = meaningful;
    const quiet = await capture('warn', async () => boolFlag(other));
    assert.strictEqual(quiet.result, false);
    assert.strictEqual(quiet.lines.length, 0, `${JSON.stringify(meaningful)} was reported as a mis-set flag`);
    delete process.env[other];
  }
  const unset = await capture('warn', async () => boolFlag(`${name}_UNSET`));
  assert.strictEqual(unset.lines.length, 0);
  delete process.env[name];
});

test('turning the consumer paywall on with no way to grant Pro is announced', async () => {
  // The worst switch-on order there is. users.is_premium has exactly one writer,
  // routes/revenuecat.js, and that route 503s everything without
  // REVENUECAT_WEBHOOK_SECRET. Flip PAYWALL_ENABLED without it and every account
  // is metered at 10 Birdie messages a day, the App Store purchase goes through,
  // the entitlement event is refused, and nobody can ever leave the free tier.
  const saved = process.env.REVENUECAT_WEBHOOK_SECRET;
  try {
    process.env.PAYWALL_ENABLED = 'true';
    // Configured correctly: silence. The value has to be a realistic length
    // now: this preflight asks routes/revenuecat.js what counts as configured
    // rather than testing the variable for truthiness, and that route refuses
    // anything under 16 characters, since it has no rate limiter and is the
    // only writer of users.is_premium. The old fixture here was 10 characters,
    // which the route would refuse, so warning about it is correct.
    process.env.REVENUECAT_WEBHOOK_SECRET = 'a'.repeat(32); // gitleaks:allow -- synthetic length fixture, not a secret
    const quiet = await capture('warn', async () => paywallEnabled());
    assert.strictEqual(quiet.result, true);
    assert.strictEqual(quiet.lines.length, 0, 'a correctly configured paywall warned anyway');

    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    const loud = await capture('warn', async () => paywallEnabled());
    assert.strictEqual(loud.result, true, 'the preflight overrode an explicit operator flag instead of warning');
    assert.strictEqual(loud.lines.length, 1,
      'a paywall that can take money and can never grant the entitlement said nothing');
    assert.match(loud.lines[0], /REVENUECAT_WEBHOOK_SECRET/);
    assert.match(loud.lines[0], /PAYWALL_ENABLED/);

    const again = await capture('warn', async () => paywallEnabled());
    assert.strictEqual(again.lines.length, 0, 'the preflight warns on every single request');
  } finally {
    process.env.REVENUECAT_WEBHOOK_SECRET = saved;
    delete process.env.PAYWALL_ENABLED;
  }
});

test('turning venue billing on with no admin able to grant a tier is announced', async () => {
  // Sharper than the consumer side: there is no venue billing integration at
  // all, so venue_profiles.tier is only ever written by
  // POST /api/admin/venues/:userId/tier, and role='admin' comes only from
  // ADMIN_USER_IDS at boot. With none set, this flag pins every venue to free
  // and the only remedy is SQL against production.
  const saved = process.env.ADMIN_USER_IDS;
  try {
    process.env.VENUE_BILLING_ENABLED = 'true';
    process.env.ADMIN_USER_IDS = '1';
    const quiet = await capture('warn', async () => venueBillingEnabled());
    assert.strictEqual(quiet.result, true);
    assert.strictEqual(quiet.lines.length, 0);

    delete process.env.ADMIN_USER_IDS;
    const loud = await capture('warn', async () => venueBillingEnabled());
    assert.strictEqual(loud.result, true, 'the preflight overrode an explicit operator flag instead of warning');
    assert.strictEqual(loud.lines.length, 1,
      'enforcing tiers nobody can grant said nothing');
    assert.match(loud.lines[0], /ADMIN_USER_IDS/);
    assert.match(loud.lines[0], /venue_profiles\.tier/);

    const again = await capture('warn', async () => venueBillingEnabled());
    assert.strictEqual(again.lines.length, 0);
  } finally {
    process.env.ADMIN_USER_IDS = saved;
    delete process.env.VENUE_BILLING_ENABLED;
  }
});

// ===========================================================================
// SECTION 4 — GET /api/entitlements
// ===========================================================================

test('the endpoint answers the contract and forbids every cache between us and the client', async () => {
  CURRENT_USER = { id: freshId() };
  premiumIs(true);
  const res = await call('GET', '/api/entitlements');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.isPremium, true);
  assert.strictEqual(res.body.paywallEnabled, false);
  assert.match(String(res.headers.get('cache-control')), /no-store/,
    'per-account subscription state is cacheable; a shared cache could hand one user another user\'s plan');
});

test('a lookup that failed is a retryable 503, not a confident "you are not a subscriber"', async () => {
  // The client fetches this once at boot and holds it for the session
  // (frontend/src/App.js), so a 200 with isPremium:false during a blip shows a
  // paying user the upgrade sheet until they restart the app.
  CURRENT_USER = { id: freshId() };
  premiumErrors();
  const res = await capture('error', () => call('GET', '/api/entitlements'));
  assert.strictEqual(res.result.status, 503, `a failed lookup answered ${res.result.status}: ${res.result.text}`);
  assert.strictEqual(res.result.body.code, 'ENTITLEMENT_UNAVAILABLE');
  assert.strictEqual(res.result.body.retryable, true);
  assert.strictEqual(res.result.headers.get('retry-after'), '5');
  assert.ok(!('isPremium' in res.result.body),
    'the refusal still states a premium answer it does not have');
  assert.ok(!res.result.body.error.includes('—'), 'em dash in user-visible copy');
});

test('an unexpected failure is still a 500, not laundered into a friendly 503', async () => {
  // A genuine bug must not be dressed up as "try again in five seconds", which
  // is a suggestion that will never work. Injected by making the ONE thing the
  // route touches before the service throw.
  CURRENT_USER = { get id() { throw new Error('programmer error'); } };
  const { result: res } = await capture('error', () => call('GET', '/api/entitlements'));
  assert.strictEqual(res.status, 500, `an ordinary bug answered ${res.status}: ${res.text}`);
  assert.notStrictEqual(res.body.code, 'ENTITLEMENT_UNAVAILABLE');
  assert.ok(!('retryable' in res.body));

  // ...and the tagged error carries what routes/entitlements.js branches on.
  const tagged = new EntitlementUnavailableError('lookup_failed');
  assert.ok(tagged instanceof Error);
  assert.strictEqual(tagged.entitlementUnavailable, true);
  assert.strictEqual(tagged.status, 503);
  assert.strictEqual(tagged.code, 'ENTITLEMENT_UNAVAILABLE');
  assert.strictEqual(new Error('plain').entitlementUnavailable, undefined);
  assert.strictEqual(typeof entitlements.getEntitlements, 'function');
});

test('the endpoint is authenticated, and never answers on a request with no user', async () => {
  CURRENT_USER = null;
  const res = await call('GET', '/api/entitlements');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(log.length, 0, 'an unauthenticated request read the database');
});

test('nothing is cached: two calls are two reads', async () => {
  // The revocation half of the caching question. There is no server-side
  // entitlement cache, so a webhook that clears is_premium takes effect on the
  // very next request; if one is ever added, this fails and whoever adds it has
  // to state the staleness window out loud.
  CURRENT_USER = { id: freshId() };
  let value = true;
  handlers.push([/SELECT is_premium FROM users/, () => ({ rows: [{ is_premium: value }] })]);
  const first = await call('GET', '/api/entitlements');
  assert.strictEqual(first.body.isPremium, true);
  value = false;
  const second = await call('GET', '/api/entitlements');
  assert.strictEqual(second.body.isPremium, false, 'a revoked subscriber kept premium from a cache');
  assert.strictEqual(ran(/SELECT is_premium/).length, 2);
});

// ===========================================================================
// SECTION 5 — requireVenueTier
// ===========================================================================

test('with billing off the gate is inert and reads no tier at all', async () => {
  for (const p of ['/venue/free', '/venue/premium', '/venue/pro']) {
    log = [];
    handlerRuns = 0;
    const res = await call('GET', p);
    assert.strictEqual(res.status, 200, `${p} -> ${res.text}`);
    assert.strictEqual(handlerRuns, 1);
    assert.strictEqual(ran(/SELECT tier FROM venue_profiles/).length, 0,
      `${p} read a tier with the kill switch off`);
  }
});

test('with billing on the tier is enforced in both directions', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  const cases = [
    ['/venue/premium', 'free', 403],
    ['/venue/premium', 'premium', 200],
    ['/venue/premium', 'pro', 200],
    ['/venue/pro', 'premium', 403],
    ['/venue/pro', 'pro', 200],
    ['/venue/free', 'free', 200],
  ];
  for (const [p, tier, expected] of cases) {
    handlers = [];
    handlerRuns = 0;
    tierIs(tier);
    const res = await call('GET', p);
    assert.strictEqual(res.status, expected, `${p} on ${tier} -> ${res.status} ${res.text}`);
    assert.strictEqual(handlerRuns, expected === 200 ? 1 : 0,
      `${p} on ${tier}: the handler ran on a refusal`);
    if (expected === 403) {
      assert.strictEqual(res.body.code, 'UPGRADE_REQUIRED');
      assert.strictEqual(res.body.requiredTier, p.split('/').pop());
    }
  }
});

test('an unrecognised tier is free, never a bypass', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  // 'constructor' / '__proto__' / 'toString' are the ones that resolve to a
  // truthy value through a normal object, and `null >= 0` is true, so both the
  // prototype and the comparison have to be handled.
  for (const tier of ['constructor', '__proto__', 'toString', 'valueOf', 'PRO', 'insights', '', null, undefined, 2, true]) {
    handlers = [];
    handlerRuns = 0;
    tierIs(tier);
    assert.strictEqual(await getVenueTier(1), 'free', `tier ${JSON.stringify(tier)} was not normalised to free`);
    handlers = [];
    tierIs(tier);
    const res = await call('GET', '/venue/premium');
    assert.strictEqual(res.status, 403, `tier ${JSON.stringify(tier)} walked through a premium gate`);
    assert.strictEqual(handlerRuns, 0);
    // ...and it is still refused by a gate whose minimum is the LOWEST tier,
    // because rank null must not compare as >= 0.
    handlers = [];
    tierIs(tier);
    const low = await call('GET', '/venue/free');
    assert.strictEqual(low.status, 200, `tier ${JSON.stringify(tier)} was denied its own free tier`);
  }
});

test('a missing venue profile is the free tier', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers.push([/SELECT tier FROM venue_profiles/, () => ({ rows: [] })]);
  assert.strictEqual(await getVenueTier(1), 'free');
});

test('an answer that is not a result set is a failure, not an empty one', async () => {
  // The difference between "this venue has no profile" and "the driver handed
  // back something that is not a result set" is the difference between the free
  // tier and no answer at all, and reading the second as the first is how a
  // broken client library silently downgrades every venue in the product.
  process.env.VENUE_BILLING_ENABLED = 'true';
  for (const shape of [{ rows: null }, { rows: undefined }, {}, { rowCount: 0 }]) {
    handlers = [];
    handlerRuns = 0;
    handlers.push([/SELECT tier FROM venue_profiles/, () => shape]);
    await assert.rejects(() => getVenueTier(1), /rows array/,
      `${JSON.stringify(shape)} was read as a venue on the free tier`);
    handlers = [];
    handlers.push([/SELECT tier FROM venue_profiles/, () => shape]);
    const res = await capture('error', () => call('GET', '/venue/free'));
    assert.strictEqual(res.result.status, 403,
      'a malformed result set opened a gate whose minimum is the bottom tier');
    assert.strictEqual(res.result.body.reason, 'ENTITLEMENT_UNAVAILABLE');
    assert.strictEqual(handlerRuns, 0);
  }
});

test('both prototype defences on the tier table are still there', () => {
  // These two are individually redundant, which is the point and is also why a
  // behaviour test cannot pin them: a null-prototype table makes `in` safe, and
  // a hasOwnProperty read makes a plain object safe, so removing EITHER changes
  // nothing. Remove both and `rankOf('constructor')` returns the Object
  // constructor, which is truthy, is not null, and compares as NaN against every
  // minimum — every gate in the venue product refuses everybody, including the
  // free one. Proven by mutation: the pair together is caught, each alone is not.
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'venueEntitlements.js'), 'utf8');
  assert.match(src, /Object\.create\(null\)/,
    'TIER_ORDER has Object.prototype back; with a bare property read a tier called "constructor" resolves to a function');
  assert.match(src, /Object\.prototype\.hasOwnProperty\.call\(TIER_ORDER, tier\)/,
    'rankOf reads TIER_ORDER without an own-property check');
  assert.match(src, /typeof tier === 'string'/,
    'rankOf no longer requires a string, so a numeric tier can index the table');
});

test('the null-rank check in front of the comparison is still there', () => {
  // `null >= 0` is true in JavaScript, so an unrecognised tier would satisfy any
  // gate whose minimum is 'free'. It cannot be reached through the middleware
  // today because getVenueTier normalises garbage to 'free' before the rank is
  // taken (the behaviour test above proves that half), so this is the only way
  // to pin the second lock: delete either one and the product still works,
  // delete both and every unknown tier is a free pass.
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'venueEntitlements.js'), 'utf8');
  assert.match(src, /if \(rank !== null && rank >= minRank\) return next\(\);/,
    'the explicit null check before the rank comparison is gone; `null >= 0` is true');
  assert.match(src, /rankOf\(rows\[0\]\?\.tier\) === null \? 'free'/,
    'getVenueTier stopped normalising an unrecognised tier to free');
});

test('a tier lookup that fails denies the feature, and says it is our fault and retryable', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  tierErrors();
  const { result: res } = await capture('error', () => call('GET', '/venue/premium'));
  assert.notStrictEqual(res.status, 200, 'a database error opened a paid feature');
  assert.strictEqual(handlerRuns, 0, 'the handler ran behind a failed tier check');
  // 403 UPGRADE_REQUIRED is kept on purpose: it is the existing client lock
  // contract, pinned by __tests__/money.test.js and __tests__/venueOwner.test.js
  // as THE fail-closed answer. What must be there is the part that tells the two
  // refusals apart.
  assert.strictEqual(res.status, 403, `a failed check answered ${res.status}`);
  assert.strictEqual(res.body.code, 'UPGRADE_REQUIRED');
  assert.strictEqual(res.body.reason, 'ENTITLEMENT_UNAVAILABLE',
    'a database blip is indistinguishable from a real plan refusal, so it pitches an upgrade at a venue that is already paying for one');
  assert.strictEqual(res.body.retryable, true, 'the one refusal that a retry can fix is not marked retryable');
  assert.ok(!('requiredTier' in res.body), 'the refusal names a tier it never managed to compare against');
  assert.ok(!res.body.error.includes('—'), 'em dash in user-visible copy');
});

test('the two refusals are distinguishable to a client', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [];
  tierIs('free');
  const upgrade = await call('GET', '/venue/premium');
  handlers = [];
  tierErrors();
  const { result: broken } = await capture('error', () => call('GET', '/venue/premium'));
  // Same status and same code, by contract. Everything else has to differ, or a
  // client has no way to tell "buy a plan" from "ask again in a second".
  assert.strictEqual(upgrade.status, broken.status);
  assert.strictEqual(upgrade.body.code, broken.body.code);
  assert.notStrictEqual(upgrade.body.error, broken.body.error,
    'the two refusals read identically to a human as well');
  assert.strictEqual(upgrade.body.retryable, undefined);
  assert.strictEqual(broken.body.retryable, true);
  assert.strictEqual(upgrade.body.reason, undefined);
  assert.strictEqual(broken.body.reason, 'ENTITLEMENT_UNAVAILABLE');
  assert.notDeepStrictEqual(Object.keys(upgrade.body).sort(), Object.keys(broken.body).sort(),
    'a permanent plan refusal and a temporary outage are the same object');
});

test('a request with no authenticated user is 401 and reads nothing', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  CURRENT_USER = null;
  const res = await call('GET', '/venue/premium');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(log.length, 0, 'an unauthenticated request read a tier');
  assert.strictEqual(handlerRuns, 0);
});

test('the tier read is parameterised, by user id, and is one row', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  CURRENT_USER = { id: 4242 };
  tierIs('pro');
  await call('GET', '/venue/premium');
  const q = ran(/SELECT tier FROM venue_profiles/);
  assert.strictEqual(q.length, 1, 'the gate issued more than one tier read for one request');
  assert.deepStrictEqual(q[0].params, [4242]);
  assert.match(q[0].sql, /WHERE user_id = \$1$/);
  assert.ok(!/LIMIT|ORDER BY/i.test(q[0].sql),
    'venue_profiles.user_id is UNIQUE; if that changed, this needs an explicit order, not a LIMIT');
});

test('the gate re-reads the tier on every request, so a downgrade bites immediately', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  let tier = 'pro';
  handlers.push([/SELECT tier FROM venue_profiles/, () => ({ rows: [{ tier }] })]);
  assert.strictEqual((await call('GET', '/venue/premium')).status, 200);
  tier = 'free';
  assert.strictEqual((await call('GET', '/venue/premium')).status, 403,
    'a downgraded venue kept the paid feature from a cache');
  tier = 'pro';
  assert.strictEqual((await call('GET', '/venue/premium')).status, 200,
    'an upgraded venue was still denied from a cache');
  assert.strictEqual(ran(/SELECT tier/).length, 3);
});

test('a typo in a call site is a boot failure, not a gate that denies everyone', () => {
  for (const bad of ['premuim', 'Pro', '', null, undefined, 'insights', 0]) {
    assert.throws(() => requireVenueTier(bad), /unknown tier/,
      `requireVenueTier(${JSON.stringify(bad)}) built a gate nobody can pass`);
  }
  for (const good of ['free', 'premium', 'pro']) {
    assert.strictEqual(typeof requireVenueTier(good), 'function');
  }
});

test('a downstream failure is never rewritten as an upgrade refusal', async () => {
  // The catch in this gate must own exactly one statement, the tier lookup. If
  // next() sits inside it, every synchronous failure downstream of the gate is
  // answered as "this feature needs a venue plan upgrade" with the real stack
  // logged under that label. Both flag positions, because the billing-off early
  // return is the one that runs today.
  for (const billing of [undefined, 'true']) {
    for (const p of ['/venue/throws', '/venue/sent-then-throws']) {
      handlers = [];
      handlerRuns = 0;
      if (billing) { process.env.VENUE_BILLING_ENABLED = billing; tierIs('pro'); }
      else delete process.env.VENUE_BILLING_ENABLED;
      const res = await call('GET', p);
      assert.strictEqual(handlerRuns, 1, `${p} (billing=${billing}): the handler never ran`);
      assert.notStrictEqual(res.body?.code, 'UPGRADE_REQUIRED',
        `${p} (billing=${billing}): a downstream bug was answered as an upgrade refusal`);
      assert.notStrictEqual(res.body?.code, 'ENTITLEMENT_UNAVAILABLE',
        `${p} (billing=${billing}): a downstream bug was answered as a failed tier check`);
      if (p === '/venue/sent-then-throws') {
        assert.strictEqual(res.status, 200, 'the gate wrote a second response over one already sent');
        assert.strictEqual(res.body.from, 'handler');
      } else {
        assert.strictEqual(res.status, 500);
      }
    }
  }
});

test('the tier check is the only thing inside the gate try/catch', () => {
  // Belt and braces for the test above: the behaviour is contained by express
  // today, so the ordering is pinned in the source as well. `next()` inside the
  // try is one express internals change away from being live again.
  const src = fs.readFileSync(path.join(BACKEND, 'services', 'venueEntitlements.js'), 'utf8');
  const body = src.slice(src.indexOf('return async (req, res, next)'));
  const tryStart = body.indexOf('try {');
  const catchStart = body.indexOf('} catch (err)');
  assert.ok(tryStart > 0 && catchStart > tryStart, 'the gate no longer has a try/catch at all');
  const guarded = body.slice(tryStart, catchStart);
  assert.ok(!/next\(/.test(guarded),
    'next() is back inside the tier-check try/catch, so this gate owns every downstream failure again');
  assert.match(guarded, /getVenueTier/);
});

test('the venue gate leaks nothing about the venue in a refusal', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  tierIs('free');
  const res = await call('GET', '/venue/pro');
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['code', 'error', 'requiredTier']);
  assert.ok(!/free/.test(JSON.stringify(res.body)),
    'the refusal tells the caller which tier they currently hold');
});

// ===========================================================================
// SECTION 6 — WHO IS ALLOWED TO GRANT
//
// "Where does is_premium get set and cleared" is a question about the whole
// backend, not about one file, and the answer today is "exactly one route
// each". Both service headers state that as a fact and neither could prove it.
// A source sweep is the only shape of test that catches the NEXT route to write
// one of these columns, which is the failure that actually happens: an admin
// tool, a support endpoint, a migration script, a "just for testing" flag.
// ===========================================================================

function backendJsFiles() {
  const skip = new Set(['node_modules', '__tests__', 'uploads', 'backups', 'coverage', '.git', 'dist', 'build']);
  const out = [];
  (function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walkDir(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.js')) {
        out.push(path.join(dir, entry.name));
      }
    }
  })(BACKEND);
  return out;
}

// Comments do not count in either direction: both service headers describe these
// writes at length in prose, and a write hidden in a comment is not a write.
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// A write is an assignment inside a SET clause, or the column appearing in an
// INSERT column list. Reading the column in a WHERE (services/crowdAlerts.js
// selects Pro members) is not a write and must not register as one.
function writersOf(column, table) {
  const set = new RegExp(`\\bSET\\b[\\s\\S]{0,200}?\\b${column}\\s*=`, 'i');
  const ins = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\([^)]{0,400}?\\b${column}\\b`, 'i');
  const found = [];
  for (const file of backendJsFiles()) {
    const code = codeOf(fs.readFileSync(file, 'utf8'));
    if (set.test(code) || ins.test(code)) found.push(path.relative(BACKEND, file).replace(/\\/g, '/'));
  }
  return found;
}

test('users.is_premium has exactly one writer, and it is the webhook', () => {
  assert.ok(backendJsFiles().length > 50, 'the sweep has stopped looking at the backend');
  assert.deepStrictEqual(writersOf('is_premium', 'users'), ['routes/revenuecat.js'],
    'something other than the RevenueCat webhook writes users.is_premium. Every grant and every revocation has to come from the payment processor, or a subscription can be created or destroyed by something nobody is watching.');
});

test('venue_profiles.tier has exactly one writer, and it is behind requireAdmin', () => {
  // scripts/e2e-local.js is allowed and is not a product surface: it is the
  // local end-to-end harness, and driving venue_profiles.tier through free ->
  // premium -> garbage is the only way it can prove the gate from outside.
  const writers = writersOf('tier', 'venue_profiles').filter((f) => f !== 'scripts/e2e-local.js');
  assert.deepStrictEqual(writers, ['routes/admin.js'],
    'something other than the admin tier route writes venue_profiles.tier. A venue that can set its own tier is a venue that never pays.');
  const admin = codeOf(fs.readFileSync(path.join(BACKEND, 'routes', 'admin.js'), 'utf8'));
  const stmt = admin.indexOf('UPDATE venue_profiles');
  assert.ok(stmt > 0, 'routes/admin.js no longer contains the tier UPDATE this sweep is anchored on');
  // The whitelist and the ranking table have to agree, or an admin can comp a
  // tier that getVenueTier normalises straight back to free.
  for (const tier of ['free', 'premium', 'pro']) {
    assert.ok(admin.includes(`'${tier}'`), `routes/admin.js no longer names the ${tier} tier`);
  }
});

test('the entitlement machinery itself only ever reads', () => {
  // A service that decides who has paid must never be able to change who has
  // paid. Scoped to the files this audit owns.
  for (const rel of ['services/entitlements.js', 'services/venueEntitlements.js', 'routes/entitlements.js']) {
    const code = codeOf(fs.readFileSync(path.join(BACKEND, rel), 'utf8'));
    assert.ok(!/\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER)\b/i.test(code),
      `${rel} contains a write statement; the thing that answers "has this account paid" must not also be able to decide it`);
  }
});

// ===========================================================================
// SECTION 7 — config/database.js is not a side effect
//
// Run in child processes, because the only way to observe what a module does at
// require time is to be the process that requires it. Every child is pointed at
// 127.0.0.1:1, which nothing listens on, so a probe that fires is visible as a
// connection error and a probe that does not fire is visible as silence.
// ===========================================================================

const DEAD_DB = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/nope',
  PGHOST: '127.0.0.1',
  PGPORT: '1',
  PGUSER: 'u',
  PGPASSWORD: 'p',
  PGDATABASE: 'nope',
  NODE_ENV: 'development',
  PG_STARTUP_PING: '',
};

function child(args, env, cwd) {
  const r = spawnSync(process.execPath, args, {
    cwd: cwd || BACKEND,
    env: { ...process.env, ...DEAD_DB, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

const PROBE = /PostgreSQL (connected|connection error)/;

test('requiring the pool opens no connection', () => {
  const out = child(['-e', "require('./config/database'); console.log('LOADED');"]);
  assert.match(out, /LOADED/, 'the module did not load at all; this test is looking at nothing');
  assert.ok(!PROBE.test(out),
    `importing config/database.js still fires a real connection attempt: ${out.trim().slice(0, 300)}`);
});

test('the pool still offers the check, and running it really does connect', () => {
  const out = child(['-e', "const p = require('./config/database'); console.log('FN', typeof p.verifyConnection); p.verifyConnection();"]);
  assert.match(out, /FN function/, 'pool.verifyConnection is gone; server boot has no connectivity check to call');
  assert.match(out, /PostgreSQL connection error/, 'verifyConnection did not actually try to connect');
});

test('PG_STARTUP_PING=true opts a script back in', () => {
  const out = child(['-e', "require('./config/database');"], { PG_STARTUP_PING: 'true' });
  assert.match(out, /PostgreSQL connection error/, 'the explicit opt-in did nothing');
});

test('booting server.js DOES get the startup check, and a worker does not', () => {
  // The discriminator is the process entry point, so it has to be tested by
  // giving a child process an entry point with each name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-entitlement-db-'));
  try {
    const body = `require(${JSON.stringify(path.join(BACKEND, 'config', 'database.js'))});\n`;
    const serverEntry = path.join(dir, 'server.js');
    fs.writeFileSync(serverEntry, body);

    const asServer = child([serverEntry], {}, BACKEND);
    assert.match(asServer, /PostgreSQL connection error/,
      'the API server lost its boot-time connectivity check, which is the one place it is worth having');

    // The discriminator is a whole path SEGMENT, not a substring. `my-server.js`
    // and a scripts/ file living under a directory with "server" in its name are
    // not the API server, and matching them would put the probe back into
    // exactly the processes it was taken out of.
    for (const name of ['worker.js', 'my-server.js', 'server.js.bak', 'observer.js']) {
      const entry = path.join(dir, name);
      fs.writeFileSync(entry, body);
      const out = child([entry], {}, BACKEND);
      assert.ok(!PROBE.test(out),
        `entry point ${name} still fires the startup probe: ${out.trim().slice(0, 200)}`);
    }
    const nestedDir = path.join(dir, 'server-tools');
    fs.mkdirSync(nestedDir);
    const nested = path.join(nestedDir, 'backfill.js');
    fs.writeFileSync(nested, body);
    assert.ok(!PROBE.test(child([nested], {}, BACKEND)),
      'a script under a directory with "server" in its name fires the probe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the statement timeout cap survives a garbage override, and only 0 disables it', () => {
  const read = (env) => child(['-e', "console.log('T=' + require('./config/database').options.statement_timeout);"], env)
    .match(/T=(\S+)/)[1];
  assert.strictEqual(read({ PG_STATEMENT_TIMEOUT_MS: '' }), '15000', 'the default cap is gone');
  assert.strictEqual(read({ PG_STATEMENT_TIMEOUT_MS: '0' }), '0', 'the documented escape hatch for long jobs stopped working');
  assert.strictEqual(read({ PG_STATEMENT_TIMEOUT_MS: '60000' }), '60000');
  assert.strictEqual(read({ PG_STATEMENT_TIMEOUT_MS: 'abc' }), '15000');
  // Postgres refuses a negative statement_timeout outright, so this is not a
  // longer cap, it is a pool where every checkout errors.
  assert.strictEqual(read({ PG_STATEMENT_TIMEOUT_MS: '-5' }), '15000',
    'a negative override reached the connection options and would break every checkout');
});

test('the pool still blocks the queries it exists to block', async () => {
  // Same file, unrelated to entitlements, but it is the other guard living in
  // config/database.js and it is one monkeypatch away from being lost.
  pool.query = realPoolQuery;
  try {
    delete process.env.ALLOW_DROP_TABLES;
    await assert.rejects(() => pool.query('DROP TABLE users'), /BLOCKED/);
    await assert.rejects(() => pool.query('drop   table users'), /BLOCKED/);
    await assert.rejects(() => pool.query({ text: 'TRUNCATE users' }), /BLOCKED/);
    await assert.rejects(() => pool.query('WITH x AS (SELECT 1) TRUNCATE users'), /BLOCKED/);
  } finally {
    pool.query = (sql, params) => dispatch(sql, params);
  }
});
