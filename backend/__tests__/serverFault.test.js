// Run: node --test  (from backend/)
//
// A ROUTE THAT FAILS FOR EVERYONE MUST NOT FAIL QUIETLY.
//
// Every route in this app catches its own error, logs it and answers 500
// itself, so the error handlers in server.js (Sentry's and [unhandled-error])
// never saw one, and nothing counted them. utils/serverFault.js counts every
// such response by route pattern and hands the logged Error to Sentry, and
// services/serverFaultAlert.js turns a burst, or a background job that has
// stopped succeeding, into one ops alert a day. Pinned here, against a real
// Express app rather than a description of one:
//
//   1. a caught 500 is counted under the route PATTERN, never the URL, and its
//      logged error is kept, scrubbed, as the route's last message;
//   2. deliberate 502/503/504 answers and a recovered request are not faults;
//   3. the error reaches Sentry with the route as a tag;
//   4. a job with no success for three intervals is stalled;
//   5. the alert fires at the threshold, names the routes and the jobs, and
//      goes through the shared ops sender;
//   6. server.js and the sweeps are actually wired to it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const Sentry = require('@sentry/node');

const serverFault = require('../utils/serverFault');

const {
  faultMiddleware, installConsoleHook, serverFaultStatus, jobStatus, recordJobRun,
  __resetServerFaults, SERVER_FAULT_ALERT_THRESHOLD, STALLED_INTERVALS,
} = serverFault;

const captured = [];
Sentry.captureException = (err, ctx) => { captured.push({ err, tags: ctx && ctx.tags }); };
Sentry.captureMessage = (msg, ctx) => { captured.push({ msg, tags: ctx && ctx.tags }); };

// The hook wraps whatever console.error is when it is installed. The test
// silences the output first so the suite log stays readable; the hook still
// sees every call.
const realError = console.error;
console.error = () => {};
installConsoleHook();

function buildApp() {
  const app = express();
  app.use(faultMiddleware);
  const router = express.Router();
  // The shape of more than two hundred routes in this app.
  router.get('/:id', (req, res) => {
    Promise.resolve().then(() => {
      try {
        throw new Error(`lookup failed for flock ${req.params.id} owned by ava@example.com`);
      } catch (err) {
        console.error('Get thing error:', err);
        res.status(500).json({ error: 'Server error' });
      }
    });
  });
  // An upstream that is down, answered on purpose.
  router.get('/:id/upstream', (req, res) => res.status(503).json({ error: 'Busy' }));
  // Logged an error, then recovered with a fallback.
  router.get('/:id/fallback', (req, res) => {
    console.error('cache read failed, using the fallback:', new Error('cache down'));
    res.json({ ok: true });
  });
  // A synchronous throw that reaches the app's error handler via next(err).
  router.get('/:id/throws', () => { throw new Error('sync throw'); });
  // The few routes that log err.message instead of the error.
  router.get('/:id/words', (req, res) => {
    console.error('Words error:', new Error('pool timed out').message);
    res.status(500).json({ error: 'Server error' });
  });
  app.use('/api/things', router);
  app.use((err, req, res, next) => {
    console.error(`[unhandled-error] ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(async (p) => {
      const res = await fetch(base + p);
      await res.text();
      return res.status;
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// 'finish' fires after the client has its answer; give it a tick.
const settle = () => new Promise((r) => setTimeout(r, 20));

test.after(() => { console.error = realError; });

test('a caught 500 is counted under its route pattern, with no id or address anywhere', async () => {
  __resetServerFaults();
  captured.length = 0;
  await withServer(async (get) => {
    for (const id of [101, 202, 303]) assert.strictEqual(await get(`/api/things/${id}`), 500);
  });
  await settle();
  const s = serverFaultStatus();
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.routes.length, 1);
  assert.strictEqual(s.routes[0].route, 'GET /api/things/:id', 'three URLs, one route');
  assert.strictEqual(s.routes[0].count, 3);
  assert.match(s.routes[0].lastMessage, /^Error: lookup failed for flock 303 owned by \[email\]$/,
    'the last message is kept for the alert, with the address blanked');
  assert.doesNotMatch(JSON.stringify(s.routes.map((r) => r.route)), /\d{3}/);
});

test('the logged error reaches Sentry with its stack and the route as a tag', async () => {
  __resetServerFaults();
  captured.length = 0;
  await withServer(async (get) => { await get('/api/things/7'); });
  await settle();
  assert.strictEqual(captured.length, 1);
  assert.ok(captured[0].err instanceof Error, 'an exception, not a message, so the stack travels');
  assert.strictEqual(captured[0].tags.route, 'GET /api/things/:id');
  assert.strictEqual(captured[0].tags.status, '500');
});

test('deliberate 503s and a request that recovered are not faults', async () => {
  __resetServerFaults();
  captured.length = 0;
  await withServer(async (get) => {
    assert.strictEqual(await get('/api/things/1/upstream'), 503);
    assert.strictEqual(await get('/api/things/1/fallback'), 200);
  });
  await settle();
  assert.strictEqual(serverFaultStatus().total, 0);
  assert.strictEqual(captured.length, 0);
});

test('an error that escaped to the app handler is counted too, still with no id in the key', async () => {
  __resetServerFaults();
  await withServer(async (get) => { assert.strictEqual(await get('/api/things/555/throws'), 500); });
  await settle();
  const s = serverFaultStatus();
  assert.strictEqual(s.total, 1);
  assert.doesNotMatch(s.routes[0].route, /555/);
  assert.match(s.routes[0].lastMessage, /sync throw/);
});

test('a route that logs only err.message still leaves its words for the alert and Sentry', async () => {
  __resetServerFaults();
  captured.length = 0;
  await withServer(async (get) => { assert.strictEqual(await get('/api/things/9/words'), 500); });
  await settle();
  const s = serverFaultStatus();
  assert.strictEqual(s.routes[0].route, 'GET /api/things/:id/words');
  assert.strictEqual(s.routes[0].lastMessage, 'Words error: pool timed out');
  assert.strictEqual(captured.length, 1);
  assert.match(captured[0].msg, /^500 on GET \/api\/things\/:id\/words: Words error: pool timed out$/);
});

test('faults older than the window drop out', () => {
  __resetServerFaults();
  const t0 = 1_000_000_000;
  serverFault.recordFault('GET /api/x', new Error('old'), t0);
  assert.strictEqual(serverFaultStatus(t0 + 1000).total, 1);
  assert.strictEqual(serverFaultStatus(t0 + serverFault.WINDOW_MS + 1).total, 0);
});

test('502, 503 and 504 are answers, anything else from 500 up is a fault', () => {
  for (const s of [502, 503, 504, 200, 404, 429]) assert.strictEqual(serverFault.isFault(s), false, String(s));
  for (const s of [500, 501, 507]) assert.strictEqual(serverFault.isFault(s), true, String(s));
});

test('a job with no success for three of its intervals is stalled; one success clears it', () => {
  __resetServerFaults();
  const every = 30 * 60 * 1000;
  const t0 = 2_000_000_000;
  recordJobRun('flockSweep', true, null, every, t0);
  recordJobRun('flockSweep', false, new Error('column "status" does not exist'), every, t0 + every);
  let j = jobStatus(t0 + 2 * every).find((x) => x.name === 'flockSweep');
  assert.strictEqual(j.stalled, false, 'two intervals is not yet three');
  j = jobStatus(t0 + STALLED_INTERVALS * every + 1).find((x) => x.name === 'flockSweep');
  assert.strictEqual(j.stalled, true);
  assert.strictEqual(j.failuresSinceOk, 1);
  assert.match(j.lastError, /column "status" does not exist/);
  recordJobRun('flockSweep', true, null, every, t0 + 4 * every);
  j = jobStatus(t0 + 4 * every).find((x) => x.name === 'flockSweep');
  assert.strictEqual(j.stalled, false);
});

test('a job that has failed on every run since boot is stalled from its first failure', () => {
  __resetServerFaults();
  const every = 5 * 60 * 1000;
  const t0 = 3_000_000_000;
  recordJobRun('reconfirmSweep', false, new Error('boom'), every, t0);
  assert.strictEqual(jobStatus(t0 + 3 * every + 1)[0].stalled, true);
  assert.strictEqual(jobStatus(t0 + 3 * every + 1)[0].lastOkAt, null);
});

// ---------------------------------------------------------------------------
// The alert
// ---------------------------------------------------------------------------
const opsAlertModule = require('../services/opsAlert');
const alerts = [];
opsAlertModule.opsAlert = async (a) => { alerts.push(a); return { sent: true, legs: ['email'] }; };
const { runServerFaultAlert } = require('../services/serverFaultAlert');

const burst = (n) => ({
  windowMs: 15 * 60 * 1000,
  total: n,
  routes: [
    { route: 'POST /api/messages/:flockId', count: n - 2, lastMessage: 'Error: relation "messages" does not exist', lastAt: 1 },
    { route: 'POST /api/budget/:flockId/submit', count: 2, lastMessage: null, lastAt: 0 },
  ],
});

test('below the threshold, nothing is sent', async () => {
  alerts.length = 0;
  await runServerFaultAlert({ status: burst(SERVER_FAULT_ALERT_THRESHOLD - 1), jobs: [] });
  assert.strictEqual(alerts.length, 0);
});

test('at the threshold, one alert names the routes, the counts and the last error', async () => {
  alerts.length = 0;
  await runServerFaultAlert({ status: burst(SERVER_FAULT_ALERT_THRESHOLD), jobs: [] });
  assert.strictEqual(alerts.length, 1);
  const a = alerts[0];
  assert.strictEqual(a.key, 'server_errors', 'one ledger key, so one alert a day');
  assert.match(a.subject, /10 requests with an error in 15 minutes/);
  assert.match(a.text, /POST \/api\/messages\/:flockId {2}8/);
  assert.match(a.text, /last error: Error: relation "messages" does not exist/);
  assert.match(a.push.body, /most on POST \/api\/messages\/:flockId/);
  assert.doesNotMatch(`${a.subject}\n${a.text}\n${a.push.title}\n${a.push.body}`, /—/, 'no em dashes in copy a person reads');
});

test('a stalled job gets its own alert, with what stops for users', async () => {
  alerts.length = 0;
  const now = 5_000_000_000;
  await runServerFaultAlert({
    now,
    status: burst(0),
    jobs: [
      { name: 'flockSweep', everyMs: 30 * 60 * 1000, lastOkAt: now - 3 * 60 * 60 * 1000, failuresSinceOk: 6, lastError: 'Error: boom', stalled: true },
      { name: 'crowdAlerts', everyMs: 15 * 60 * 1000, lastOkAt: now, failuresSinceOk: 0, lastError: null, stalled: false },
    ],
  });
  assert.strictEqual(alerts.length, 1);
  const a = alerts[0];
  assert.strictEqual(a.key, 'job_stalled');
  assert.match(a.subject, /flockSweep job has stopped succeeding/);
  assert.match(a.text, /flockSweep \(runs every 30 minutes\): last success 3 hours ago, 6 failed runs since\./);
  assert.match(a.text, /Plans whose night is over stay listed as live/);
  assert.doesNotMatch(a.text, /crowdAlerts/, 'a healthy job is not named');
});

test('a thrown read never escapes the alert', async () => {
  await assert.doesNotReject(() => runServerFaultAlert({ status: { get total() { throw new Error('x'); } } }));
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('server.js counts faults ahead of every router and reads them on the money watch', () => {
  const src = read('server.js');
  const mount = src.indexOf('app.use(faultMiddleware);');
  assert.ok(mount > 0, 'faultMiddleware is not mounted');
  assert.ok(src.indexOf('installConsoleHook();') > 0 && src.indexOf('installConsoleHook();') < mount);
  const firstRouter = src.search(/app\.use\('\/api\//);
  assert.ok(firstRouter > mount, 'the counter has to be mounted before the first router, or that router is invisible to it');
  assert.ok(src.indexOf('app.use(globalBackstopLimiter);') > mount);
  const watch = /async function runMoneyWatch\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.match(watch, /runServerFaultAlert\(\)/);
});

test('every watched sweep reports both its outcomes', () => {
  for (const [file, name] of [
    ['services/flockSweep.js', 'flockSweep'],
    ['services/reconfirmSweep.js', 'reconfirmSweep'],
    ['services/crowdAlerts.js', 'crowdAlerts'],
    ['services/photoStore.js', 'photoPrune'],
    ['server.js', 'storyPurge'],
  ]) {
    const src = read(file);
    assert.match(src, new RegExp(`recordJobRun\\('${name}', true,`), `${file} never reports a good ${name} run`);
    assert.match(src, new RegExp(`recordJobRun\\('${name}', false, e(rr)?,`), `${file} never reports a failed ${name} run`);
  }
});
