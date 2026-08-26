// Run: node --test  (from backend/)
//
// OBSERVABILITY. Railway deploys this service on every push with no test gate,
// and the operator is a solo founder who is at school most of the day —
// anything that fails silently fails for hours. This file pins the four
// mechanisms that decide whether the first production incident is debuggable
// from the Railway log alone:
//
//   1. the process-level failure policy: unhandled rejections are logged loudly
//      and survived, uncaught exceptions crash-and-restart with the stack on
//      the way out;
//   2. /api/health tells the truth: it probes the pg pool (with its own
//      timeout), answers 503 when the pool cannot answer, and is cached so
//      polling it can never become a load source;
//   3. the global error handler's one log line carries what a 3am debug starts
//      from — verb, URL, account — not just a bare stack;
//   4. SIGTERM (sent by Railway on EVERY deploy) drains in-flight requests and
//      closes the pool instead of dropping everything mid-transaction.
//
// HOW THIS FILE TESTS server.js. server.js calls boot() on require
// (scripts/e2e-local.js depends on that side effect), so it cannot be
// imported. Same technique as __tests__/imageSpendLimits.test.js and
// __tests__/bodyLimitAudit.test.js: the blocks under test are lifted out of
// the source and EXECUTED — the handlers below are server.js's own code, not a
// restatement of it — and the wiring around them is asserted against the text.
//
// instrument.js is likewise never require()d here — it calls
// require('dotenv').config() at module scope, which would load the developer's
// local backend/.env into this process (the exact reason sourceHealth.test.js
// keeps it on DO_NOT_REQUIRE). It is asserted textually only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
// The health probe's own deadline is an unref()'d timer (server.js), so a test
// that waits for it has to keep the loop referenced itself. See the helper.
const { withEventLoopHeldOpen } = require('./helpers/eventLoopAnchor');

const BACKEND = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
const instrumentSrc = fs.readFileSync(path.join(BACKEND, 'instrument.js'), 'utf8');
const dbConfigSrc = fs.readFileSync(path.join(BACKEND, 'config', 'database.js'), 'utf8');

function fakeConsole() {
  const logs = [];
  const errors = [];
  const warns = [];
  return {
    logs, errors, warns,
    log: (...a) => logs.push(a.map(String).join(' ')),
    error: (...a) => errors.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')),
    warn: (...a) => warns.push(a.map(String).join(' ')),
  };
}

function fakeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// 1. Process-level policy
// ---------------------------------------------------------------------------

test('the policy is declared: rejection handler present, uncaught MONITOR present, no uncaught HANDLER', () => {
  assert.match(serverSrc, /process\.on\(\s*'unhandledRejection'/,
    'no unhandledRejection handler: one floating promise takes the whole service down');
  assert.match(serverSrc, /process\.on\(\s*'uncaughtExceptionMonitor'/,
    'no uncaughtExceptionMonitor: a crash logs a bare stack with no grep-able tag');
  // reliability.test.js pins this too; restated here because it IS the policy:
  // a monitor observes the crash, a handler would swallow it and keep serving
  // from unknown state.
  assert.doesNotMatch(serverSrc, /process\.on\(\s*['"]uncaughtException['"]/,
    'an uncaughtException handler would prevent the crash-and-restart the policy requires');
});

function loadRejectionHandler(consoleObj, sentryObj) {
  const m = /process\.on\('unhandledRejection', \(reason\) => \{[\s\S]*?\n\}\);/.exec(serverSrc);
  assert.ok(m, 'server.js must install its unhandledRejection handler with the expected shape');
  let handler = null;
  const proc = { on: (_ev, fn) => { handler = fn; } };
  // eslint-disable-next-line no-new-func
  new Function('process', 'console', 'Sentry', 'util', m[0])(proc, consoleObj, sentryObj, util);
  assert.equal(typeof handler, 'function');
  return handler;
}

test('a rejected Error is kept alive, logged with a tag and its ORIGINAL stack, and sent to Sentry', () => {
  const con = fakeConsole();
  const captured = [];
  const handler = loadRejectionHandler(con, { captureException: (e) => captured.push(e) });

  const err = new Error('pg pool checkout failed');
  handler(err); // must not throw — throwing here would itself kill the process

  assert.equal(con.errors.length, 1, 'exactly one loud line per rejection');
  assert.match(con.errors[0], /\[unhandledRejection\]/, 'the line must carry a grep-able tag');
  assert.match(con.errors[0], /pg pool checkout failed/);
  assert.match(con.errors[0], /observability\.test/,
    'the line must carry the ORIGINAL stack — the frame where the Error was made is the only pointer to the missing .catch()');
  assert.equal(captured.length, 1);
  assert.strictEqual(captured[0], err, 'Sentry must get the original Error, not a re-wrap that loses the stack');
});

test('a non-Error rejection reason is inspected, not flattened to [object Object]', () => {
  const con = fakeConsole();
  const captured = [];
  const handler = loadRejectionHandler(con, { captureException: (e) => captured.push(e) });

  // The shape a raw pg error object or a `throw {..}` produces.
  handler({ code: '42P01', table: 'flocks', hint: 'relation does not exist' });

  assert.equal(con.errors.length, 1);
  assert.match(con.errors[0], /42P01/, 'the reason\'s own fields are the only clue there is — they must survive into the log');
  assert.match(con.errors[0], /flocks/);
  assert.doesNotMatch(con.errors[0], /\[object Object\]/);
  assert.ok(captured[0] instanceof Error, 'Sentry only groups Errors — a non-Error must be wrapped');
});

test('the uncaught monitor logs a tagged line with the stack, and never prevents the exit', () => {
  const m = /process\.on\('uncaughtExceptionMonitor', \(err, origin\) => \{[\s\S]*?\n\}\);/.exec(serverSrc);
  assert.ok(m, 'server.js must install the uncaughtExceptionMonitor with the expected shape');
  let handler = null;
  const con = fakeConsole();
  // eslint-disable-next-line no-new-func
  new Function('process', 'console', 'util', m[0])({ on: (_e, fn) => { handler = fn; } }, con, util);

  const boom = new Error('cannot read properties of undefined');
  handler(boom, 'uncaughtException');

  assert.equal(con.errors.length, 1);
  assert.match(con.errors[0], /\[uncaughtException\]/);
  assert.match(con.errors[0], /cannot read properties of undefined/);
  assert.match(con.errors[0], /observability\.test/, 'the stack must be in the line');
  // 'uncaughtExceptionMonitor' by definition cannot swallow the crash — that
  // is the whole reason it was chosen over a handler. Nothing to assert at
  // runtime; the event NAME is the guarantee, and the text test above pins it.
});

// ---------------------------------------------------------------------------
// 2. /api/health — lifted out of server.js and run
// ---------------------------------------------------------------------------

// Fresh module state per call (healthCache / healthProbe / healthWasDown live
// at the lifted scope), a controllable clock, and the real probe logic.
function loadHealthBlock(queryImpl) {
  const start = serverSrc.indexOf('const HEALTH_DB_TIMEOUT_MS');
  assert.ok(start > 0, 'server.js must declare HEALTH_DB_TIMEOUT_MS');
  const end = serverSrc.indexOf("const isDev = process.env.NODE_ENV === 'development';");
  assert.ok(end > start, 'the health block must sit before the rate limiters');
  const body = serverSrc.slice(start, end);

  let handler = null;
  const app = {
    get: (route, fn) => {
      assert.equal(route, '/api/health');
      handler = fn;
    },
  };
  const con = fakeConsole();
  const queries = [];
  const pool = { query: (sql) => { queries.push(sql); return queryImpl(); } };
  const clock = { now: 1_000_000 };
  // Date.now() is faked so cache expiry is testable without sleeping;
  // new Date().toISOString() stays real, which is all the handler needs.
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  // eslint-disable-next-line no-new-func
  const constants = new Function(
    'pool', 'app', 'console', 'Date',
    `${body}\nreturn { HEALTH_DB_TIMEOUT_MS, HEALTH_CACHE_MS, probeDbHealth };`
  )(pool, app, con, FakeDate);
  assert.equal(typeof handler, 'function', 'the health route must be registered');
  return { handler, con, queries, clock, ...constants };
}

test('with the pool answering, /api/health is 200 ok — and a poll burst costs ONE query per cache window', async () => {
  const h = loadHealthBlock(() => Promise.resolve({ rows: [{ '?column?': 1 }] }));

  const res1 = fakeRes();
  await h.handler({}, res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.status, 'ok');
  assert.equal(res1.body.db, 'ok');
  assert.ok(res1.body.timestamp, 'the timestamp field is part of the existing contract');

  // Hammer it inside the cache window: public + unauthenticated means anyone
  // can, and the database must not feel it.
  for (let i = 0; i < 50; i++) {
    h.clock.now += 50;
    await h.handler({}, fakeRes());
  }
  assert.equal(h.queries.length, 1, 'polling inside the cache window must not reach the database');

  // Past the window, exactly one more probe.
  h.clock.now += h.HEALTH_CACHE_MS + 1;
  const res2 = fakeRes();
  await h.handler({}, res2);
  assert.equal(h.queries.length, 2);
  assert.equal(res2.statusCode, 200);
});

test('with the pool down, /api/health answers 503 degraded — and logs the transition ONCE, not per poll', async () => {
  let up = false;
  const h = loadHealthBlock(() => (up ? Promise.resolve({ rows: [] }) : Promise.reject(new Error('ECONNREFUSED'))));

  const res1 = fakeRes();
  await h.handler({}, res1);
  assert.equal(res1.statusCode, 503,
    'a green health check over a dead pool is how Railway keeps routing traffic to a dead app');
  assert.equal(res1.body.status, 'degraded');
  assert.equal(h.con.errors.length, 1);
  assert.match(h.con.errors[0], /\[health\]/);

  // Still down across three more cache windows: three more probes, ZERO more
  // "failed" lines — hours of a poll cadence must not bury the line that says
  // when it started.
  for (let i = 0; i < 3; i++) {
    h.clock.now += h.HEALTH_CACHE_MS + 1;
    const r = fakeRes();
    await h.handler({}, r);
    assert.equal(r.statusCode, 503);
  }
  assert.equal(h.con.errors.length, 1, 'the failure is logged on the transition, not on every poll');

  // Recovery: one 200, and one recovery line.
  up = true;
  h.clock.now += h.HEALTH_CACHE_MS + 1;
  const res2 = fakeRes();
  await h.handler({}, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(h.con.logs.filter((l) => /\[health\].*recovered/.test(l)).length, 1);
});

test('a probe that HANGS (pool saturated, not refused) still answers 503 inside its own timeout', async () => {
  // pool.connect() against a saturated pool waits connectionTimeoutMillis
  // (10s) — this is the exhausted-pool case, and it must not make the health
  // check hang with it.
  const h = loadHealthBlock(() => new Promise(() => {})); // never settles
  const started = Date.now();
  const res = fakeRes();
  // The probe's 1.5s timer is the ONLY thing that can end this await, and it is
  // unref()'d on purpose, so the loop has to be anchored while we wait for it.
  await withEventLoopHeldOpen(() => h.handler({}, res));
  const elapsed = Date.now() - started;
  assert.equal(res.statusCode, 503, 'a pool that cannot answer SELECT 1 is not serving users either');
  assert.ok(elapsed < h.HEALTH_DB_TIMEOUT_MS + 1500,
    `the probe's own timer must answer, not the pool's 10s connect timeout (took ${elapsed}ms)`);
});

test('concurrent cache misses share ONE in-flight probe', async () => {
  let release;
  const h = loadHealthBlock(() => new Promise((r) => { release = () => r({ rows: [] }); }));
  const a = fakeRes();
  const b = fakeRes();
  const pa = h.handler({}, a);
  const pb = h.handler({}, b);
  release();
  await Promise.all([pa, pb]);
  assert.equal(h.queries.length, 1, 'two simultaneous cache misses must not become two queries');
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
});

test('the health probe timeout is sized to answer BEFORE the pool timeouts it exists to detect', () => {
  const h = loadHealthBlock(() => Promise.resolve({ rows: [] }));
  const conn = /connectionTimeoutMillis:\s*(\d+)/.exec(dbConfigSrc);
  assert.ok(conn, 'config/database.js must still declare connectionTimeoutMillis (this test reads it)');
  assert.ok(h.HEALTH_DB_TIMEOUT_MS < Number(conn[1]),
    'a health timeout at or above the pool connect timeout never fires and the probe inherits the 10s hang');
  assert.ok(h.HEALTH_DB_TIMEOUT_MS <= 3000, 'a health check that takes seconds to say "down" has answered nobody');
  assert.ok(h.HEALTH_CACHE_MS >= 1000 && h.HEALTH_CACHE_MS <= 60000,
    'the cache window bounds both the probe rate (lower) and the staleness of the answer (upper)');
});

test('the health route wiring survived: exempt from the HTTPS gate, mounted before every router', () => {
  // Railway's container healthcheck reaches the process over plain HTTP with
  // no forwarding headers; the exemption is what keeps a deploy from failing
  // its own healthcheck.
  const exempt = /const HTTPS_EXEMPT_PATHS = new Set\(\[([^\]]*)\]\)/.exec(serverSrc);
  assert.ok(exempt && exempt[1].includes("'/api/health'"), '/api/health must stay exempt from the HTTPS redirect');

  assert.equal((serverSrc.match(/app\.get\('\/api\/health'/g) || []).length, 1,
    'exactly one /api/health registration');
  assert.ok(serverSrc.indexOf("app.get('/api/health'") < serverSrc.indexOf("app.use('/api/auth'"),
    'the health route must precede the routers whose auth middleware would 401 it');
});

// ---------------------------------------------------------------------------
// 3. The global error handler's log line
// ---------------------------------------------------------------------------
// Same extraction as __tests__/bodyLimitAudit.test.js (which owns the
// status-code mapping); this file owns what the 500 path LOGS.

function loadErrorHandler(consoleObj) {
  const start = serverSrc.indexOf('const BODY_PARSER_CLIENT_ERRORS');
  assert.ok(start > 0);
  const tail = "return res.status(500).json({ error: 'Internal server error' });";
  const at = serverSrc.indexOf(tail, start);
  assert.ok(at > start, 'the global error handler must still fall through to a 500');
  const end = serverSrc.indexOf('\n});', at + tail.length) + '\n});'.length;
  let captured = null;
  // eslint-disable-next-line no-new-func
  new Function('app', 'console', serverSrc.slice(start, end))({ use: (fn) => { captured = fn; } }, consoleObj);
  assert.equal(typeof captured, 'function');
  return captured;
}

test('the 500 log line names the verb, the URL and the account — the three things a 3am debug starts from', () => {
  const con = fakeConsole();
  const handler = loadErrorHandler(con);
  const res = fakeRes();

  handler(new Error('column "flock_id" does not exist'),
    { method: 'POST', originalUrl: '/api/flocks/17/messages', user: { id: 42 } }, res, () => {});

  assert.equal(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: 'Internal server error' }, 'the client-facing body stays opaque');
  assert.equal(con.errors.length, 1);
  const line = con.errors[0];
  assert.match(line, /\[unhandled-error\]/, 'grep-able tag');
  assert.match(line, /POST \/api\/flocks\/17\/messages/, 'without the route, a stack from a shared helper points at 31 routers');
  assert.match(line, /user=42/, 'without the account, "can you reproduce it" is the only tool left');
  assert.match(line, /column "flock_id" does not exist/, 'the error itself must be in the same line');
});

test('an unauthenticated failure logs user=anon rather than crashing on the missing req.user', () => {
  const con = fakeConsole();
  const handler = loadErrorHandler(con);
  const res = fakeRes();
  handler(new Error('boom'), { method: 'GET', originalUrl: '/api/waitlist' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.match(con.errors[0], /user=anon/);
});

test('a half-written response is handed to Express, never double-written', () => {
  const con = fakeConsole();
  const handler = loadErrorHandler(con);
  const res = fakeRes();
  res.headersSent = true;
  let nexted = null;
  const err = new Error('mid-stream');
  handler(err, { method: 'GET', originalUrl: '/x' }, res, (e) => { nexted = e; });
  assert.strictEqual(nexted, err);
  assert.equal(res.statusCode, null, 'no second write');
});

// ---------------------------------------------------------------------------
// 4. Graceful shutdown — lifted out of server.js and run
// ---------------------------------------------------------------------------

function loadShutdown() {
  const start = serverSrc.indexOf('const SHUTDOWN_DEADLINE_MS');
  assert.ok(start > 0, 'server.js must declare SHUTDOWN_DEADLINE_MS');
  const endAnchor = "process.on('SIGINT', () => shutdown('SIGINT'));";
  const at = serverSrc.indexOf(endAnchor, start);
  assert.ok(at > start, 'server.js must register the SIGINT handler');
  const body = serverSrc.slice(start, at + endAnchor.length);

  const calls = [];
  const con = fakeConsole();
  const signals = {};
  const proc = {
    exitCodes: [],
    exit(code) { calls.push(`exit(${code})`); this.exitCodes.push(code); },
    on: (sig, fn) => { signals[sig] = fn; },
  };
  const io = { disconnectSockets: (close) => calls.push(`io.disconnectSockets(${close})`) };
  const server = {
    closeError: null,
    close(cb) { calls.push('server.close'); setImmediate(() => cb(this.closeError)); },
    closeIdleConnections: () => calls.push('server.closeIdleConnections'),
  };
  const pool = { end: () => { calls.push('pool.end'); return Promise.resolve(); } };
  // Every background timer handle server.js declares (crowd alerts, night
  // context, the venue digest, and whatever ships next) is a free variable in
  // the shutdown body's clearInterval/clearTimeout lines. Injecting them by
  // scanning the declarations, rather than by a hand-kept name list, keeps
  // this harness from failing with a ReferenceError every time a new sweep is
  // wired in — which is exactly how it broke twice on 2026-08-19.
  const timerHandles = [...serverSrc.matchAll(/^let (\w+(?:Interval|Kickoff)) = null;/gm)].map((m) => m[1]);
  assert.ok(timerHandles.includes('crowdAlertsInterval'), 'the crowd-alert handle must still be declared');
  // eslint-disable-next-line no-new-func
  const out = new Function(
    'io', 'server', 'pool', 'console', 'process', ...timerHandles,
    `${body}\nreturn { shutdown, SHUTDOWN_DEADLINE_MS };`
  )(io, server, pool, con, proc, ...timerHandles.map(() => null));
  return { calls, con, proc, server, signals, ...out };
}

test('SIGTERM drains: sockets kicked, server closed, pool ended, THEN exit 0 — in that order', async () => {
  const s = loadShutdown();
  assert.equal(typeof s.signals.SIGTERM, 'function', 'SIGTERM must be registered');
  assert.equal(typeof s.signals.SIGINT, 'function', 'SIGINT must be registered (local dev gets the same drain)');

  s.signals.SIGTERM();
  await tick(); // server.close callback
  await tick(); // pool.end().finally

  const order = s.calls;
  assert.deepStrictEqual(order, [
    'io.disconnectSockets(true)',
    'server.close',
    'server.closeIdleConnections',
    'pool.end',
    'exit(0)',
  ], `drain order is the contract; got: ${order.join(' -> ')}`);
  assert.ok(s.con.logs.some((l) => /\[shutdown\].*SIGTERM/.test(l)), 'the drain must announce itself');
  assert.ok(s.con.logs.some((l) => /\[shutdown\].*drained cleanly/.test(l)),
    'the clean exit must say so — its absence in a deploy log is the signal something was dropped');
});

test('a second signal stops waiting and exits immediately', async () => {
  const s = loadShutdown();
  s.signals.SIGTERM();
  s.signals.SIGTERM();
  assert.ok(s.proc.exitCodes.includes(1), 'the second signal is the operator insisting — obey');
  assert.equal(s.calls.filter((c) => c === 'server.close').length, 1, 'no double drain');
});

test('SIGTERM before listen() (deploy killed during migration) still closes the pool and exits 0', async () => {
  const s = loadShutdown();
  // server.close on a server that never listened calls back with an error.
  s.server.closeError = new Error('ERR_SERVER_NOT_RUNNING');
  s.signals.SIGTERM();
  await tick();
  await tick();
  assert.ok(s.calls.includes('pool.end'), 'the pool must be closed even when there was nothing to drain');
  assert.deepStrictEqual(s.proc.exitCodes, [0]);
});

test('the drain deadline exists, is unref()d in source, and fits inside a deploy kill window', () => {
  const s = loadShutdown();
  assert.ok(s.SHUTDOWN_DEADLINE_MS >= 2000, 'a sub-2s deadline drops slow-but-legitimate requests on every deploy');
  assert.ok(s.SHUTDOWN_DEADLINE_MS < 10000,
    'past ~10s Railway SIGKILLs anyway — the deadline must fire first so the log says what happened');
  // The deadline timer must not itself keep a finished process alive.
  assert.match(serverSrc, /\}, SHUTDOWN_DEADLINE_MS\)\.unref\(\);/,
    'the deadline timer must be unref()d');
});

test('boot() keeps the crowd-alert timer handles so shutdown can clear them', () => {
  assert.match(serverSrc, /crowdAlertsInterval = setInterval\(checkCrowdAlerts/,
    'an anonymous setInterval cannot be cleared — it fires into a closing pool on every deploy');
  assert.match(serverSrc, /crowdAlertsKickoff = setTimeout\(checkCrowdAlerts/);
  assert.match(serverSrc, /if \(crowdAlertsInterval\) clearInterval\(crowdAlertsInterval\);/);
});

// ---------------------------------------------------------------------------
// 5. Preflight warnings fire once per process, not per request
// ---------------------------------------------------------------------------
// Both flag reads run on EVERY gated request (paywallEnabled in routes/ai.js
// and routes/crowd.js; venueBillingEnabled in requireVenueTier). A warning that
// fired per-request would print thousands of times an hour and train the
// operator to ignore the log — the opposite of its job.

test('the paywall/webhook and billing/admin preflight warnings each fire exactly once', () => {
  const { paywallEnabled } = require('../services/entitlements');
  const { venueBillingEnabled } = require('../services/venueEntitlements');

  const saved = {
    PAYWALL_ENABLED: process.env.PAYWALL_ENABLED,
    REVENUECAT_WEBHOOK_SECRET: process.env.REVENUECAT_WEBHOOK_SECRET,
    VENUE_BILLING_ENABLED: process.env.VENUE_BILLING_ENABLED,
    ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
  };
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    process.env.PAYWALL_ENABLED = 'true';
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    process.env.VENUE_BILLING_ENABLED = 'true';
    delete process.env.ADMIN_USER_IDS;

    for (let i = 0; i < 5; i++) {
      assert.equal(paywallEnabled(), true);
      assert.equal(venueBillingEnabled(), true);
    }

    const paywallWarns = warns.filter((w) => /REVENUECAT_WEBHOOK_SECRET/.test(w));
    const billingWarns = warns.filter((w) => /ADMIN_USER_IDS/.test(w));
    assert.equal(paywallWarns.length, 1,
      `paywall preflight fired ${paywallWarns.length} times over 5 requests — must be once per process`);
    assert.equal(billingWarns.length, 1,
      `billing preflight fired ${billingWarns.length} times over 5 requests — must be once per process`);
  } finally {
    console.warn = origWarn;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// 6. instrument.js — the Sentry human step stays exactly one line
// ---------------------------------------------------------------------------

test('instrument.js is ready for the one-line DSN step, and stays safe to exclude from require', () => {
  // The exclusion contract sourceHealth.test.js documents: instrument.js loads
  // the local .env at module scope, so tests must never require it. If the
  // dotenv call ever moves out, that exclusion (and this comment) is stale.
  assert.match(instrumentSrc, /require\('dotenv'\)\.config\(\)/,
    'instrument.js is expected to own the dotenv load — see sourceHealth DO_NOT_REQUIRE');

  // Init is gated on the DSN and reads it from env only — no default, no
  // hardcoded fallback, nothing to commit.
  assert.match(instrumentSrc, /if \(process\.env\.SENTRY_DSN\)/);
  assert.doesNotMatch(instrumentSrc, /https:\/\/[0-9a-f]+@/i, 'no DSN literal may ever be committed');

  // Everything the DSN unlocks is pre-wired: environment and release tagging
  // come from variables Railway already injects, so the human step is setting
  // SENTRY_DSN and nothing else.
  assert.match(instrumentSrc, /RAILWAY_ENVIRONMENT/,
    'environment tagging must come from the platform, not require a second variable');
  assert.match(instrumentSrc, /RAILWAY_GIT_COMMIT_SHA/,
    'release tagging is what ties an event to the push that caused it on a deploy-on-every-push service');

  // The unset state must be a stated fact in the boot log, not a silence.
  assert.match(instrumentSrc, /SENTRY_DSN is unset/,
    'without this line, "why is Sentry empty" cannot be answered from the Railway log');

  // And server.js must still load it first, before anything it instruments.
  assert.match(serverSrc, /^require\('\.\/instrument'\);/,
    'instrument.js must be the first require in server.js');
  // Sentry's Express capture must run before the custom error handler eats the error.
  assert.ok(serverSrc.indexOf('Sentry.setupExpressErrorHandler(app)') <
    serverSrc.indexOf('const BODY_PARSER_CLIENT_ERRORS'),
  'Sentry error capture must be mounted before the final error handler');
});
