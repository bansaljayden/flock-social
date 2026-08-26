// Run: node --test  (from backend/)
//
// ROUND 24 — THE LONGEST-WAITING REPORTS WERE THE ONES THAT FELL OFF.
//
// GET /api/admin/reports ordered open-first then created_at DESC and cut the
// list at a bare LIMIT 200. The moment open reports outgrew the window, the
// rows that silently vanished were the OLDEST open ones — the people who had
// been waiting longest, which is the exact population Guideline 1.2's "act
// promptly" is about, on a console that cannot be checked by hand in
// production without a signed-in admin account (ADMIN_USER_IDS names exactly
// one, confirmed set on the Railway service 2026-08-18).
//
// What this file pins:
//
//   1. ORDER. Unhandled work (open + under_review, the same pair the console's
//      UNHANDLED_STATUS names) sorts OLDEST-first, so the longest wait is row
//      one and can never fall off any window. Handled work stays newest-first
//      below it, and r.id breaks created_at ties so paging is deterministic.
//   2. PAGINATION. limit (default 200, max 1000) and offset, both digits-only
//      and range-checked BEFORE the query, both interpolated as literals — the
//      LIMIT-visibility pin in adminEvidence.test.js is the reason they are
//      not bound parameters, so the validation here is what stands between a
//      request string and the SQL text.
//   3. hasMore IS A FACT. One row past the limit is fetched and sliced off;
//      the flag cannot drift from the data the way a length==limit guess does.
//   4. THE CONSOLE AGREES. ModerationDashboard.js pages with `limit`, its
//      window ceiling does not exceed the server's, and its reason input
//      cannot compose a string PUT /reports/:id would refuse. Same
//      cross-build drift guard as moderationConsoleContract.test.js, because
//      the console is a different file in a different build and it has been
//      the last to hear about every widening so far.
//
// Harness: scripted pg fake, same shape as adminEvidence.test.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'admin-queue-pagination-test-secret';

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(String(sql).replace(/\s+/g, ' '))) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

// Patched BEFORE the router is required: admin.js destructures `authenticate`
// at require time and mounts it with router.use.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');
const { QUEUE_LIMIT_DEFAULT, QUEUE_LIMIT_MAX, QUEUE_OFFSET_MAX } = adminRouter.__test;

const app = express();
app.use(express.json());
app.set('io', { to: () => ({ emit: () => {} }), in: () => ({ disconnectSockets: () => {} }) });
app.use('/api/admin', adminRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
});

async function call(p) {
  const res = await fetch(base + p, { headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const nRows = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, status: 'open', ...over }));
const queueHandlers = (rows) => [
  [/FROM content_reports r/, () => ({ rows, rowCount: rows.length })],
  [/SELECT status, COUNT/, () => ({ rows: [{ status: 'open', count: rows.length }] })],
];

const CONSOLE_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'website', 'ModerationDashboard.js'), 'utf8'
);
const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

// ===========================================================================
// 1. The order: the longest wait can never fall off again
// ===========================================================================

test('unhandled work sorts oldest-first, handled work newest-first, ids break ties', async () => {
  handlers = queueHandlers([]);
  const res = await call('/api/admin/reports');
  assert.strictEqual(res.status, 200, res.text);

  const sql = ran(/FROM content_reports r/)[0].sql;
  const order = sql.slice(sql.indexOf('ORDER BY'));
  // The bucket is open + under_review — the console's UNHANDLED_STATUS pair —
  // not 'open' alone, so an under_review report cannot hide among the closed.
  assert.match(order, /\(r\.status IN \('open', 'under_review'\)\) DESC/,
    'the unhandled-first bucket is gone; open reports mix with closed ones');
  // Oldest-first INSIDE the bucket is the whole fix: before this, the rows
  // past the LIMIT were exactly the reports that had waited longest.
  assert.match(order, /CASE WHEN r\.status IN \('open', 'under_review'\) THEN r\.created_at END ASC/,
    'unhandled work no longer sorts oldest-first, so the longest-waiting reports fall off the window again');
  // Handled rows all tie on that CASE (NULL) and fall through to newest-first:
  // a closed report is "what did we decide recently", not a queue.
  assert.match(order, /r\.created_at DESC/, 'handled work lost its newest-first order');
  assert.match(order, /r\.id ASC/, 'no deterministic tiebreak; two same-second reports can swap across pages');
  assert.ok(order.indexOf('CASE WHEN') < order.indexOf('r.created_at DESC'),
    'the oldest-first key must outrank the newest-first fallback');
});

test('the status filter still rides as a bound parameter beside the pagination', async () => {
  handlers = queueHandlers([]);
  const res = await call('/api/admin/reports?status=open&limit=50');
  assert.strictEqual(res.status, 200, res.text);
  const q = ran(/FROM content_reports r/)[0];
  assert.match(q.sql, /WHERE r\.status = \$1/);
  assert.deepStrictEqual(q.params, ['open'], 'limit and offset must never join the bound params — they are validated literals');
  assert.match(q.sql, /LIMIT 51 OFFSET 0/);
});

// ===========================================================================
// 2. limit and offset: validated before the query, interpolated after
// ===========================================================================

test('the default ask is LIMIT default+1 OFFSET 0, and the response names its window', async () => {
  handlers = queueHandlers(nRows(3));
  const res = await call('/api/admin/reports');
  assert.strictEqual(res.status, 200, res.text);
  const q = ran(/FROM content_reports r/)[0];
  // One row past the window: hasMore is measured, not guessed from length.
  assert.match(q.sql, new RegExp(`LIMIT ${QUEUE_LIMIT_DEFAULT + 1} OFFSET 0`));
  assert.strictEqual(res.body.limit, QUEUE_LIMIT_DEFAULT);
  assert.strictEqual(res.body.offset, 0);
  assert.strictEqual(res.body.hasMore, false);
  assert.strictEqual(res.body.reports.length, 3);
  assert.ok(Array.isArray(res.body.counts), 'the counts stayed additive; the console shape-checks both arrays');
});

test('a caller-chosen window and offset appear as literals, exactly as validated', async () => {
  handlers = queueHandlers([]);
  const res = await call('/api/admin/reports?limit=400&offset=200');
  assert.strictEqual(res.status, 200, res.text);
  const q = ran(/FROM content_reports r/)[0];
  assert.match(q.sql, /LIMIT 401 OFFSET 200/);
  assert.strictEqual(res.body.limit, 400);
  assert.strictEqual(res.body.offset, 200);
});

test('the ceilings hold: the largest legal ask works and one past it is refused', async () => {
  handlers = queueHandlers([]);
  let res = await call(`/api/admin/reports?limit=${QUEUE_LIMIT_MAX}&offset=${QUEUE_OFFSET_MAX}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.match(ran(/FROM content_reports r/)[0].sql, new RegExp(`LIMIT ${QUEUE_LIMIT_MAX + 1} OFFSET ${QUEUE_OFFSET_MAX}`));

  for (const p of [`limit=${QUEUE_LIMIT_MAX + 1}`, 'limit=0', `offset=${QUEUE_OFFSET_MAX + 1}`]) {
    handlers = [];
    log = [];
    res = await call(`/api/admin/reports?${p}`);
    assert.strictEqual(res.status, 400, `${p}: ${res.text}`);
    assert.deepStrictEqual(log, [], `${p} reached the database`);
  }
});

test('anything that is not a plain integer is a 400 before any query — these strings would otherwise reach the SQL text', async () => {
  // limit/offset are interpolated (the adminEvidence LIMIT-visibility pin is
  // why), so this refusal IS the injection boundary. Every shape here must
  // die at validation: no query, and a named refusal rather than a 500 the
  // moderator reads as "the console is broken".
  const bad = ['abc', '-1', '1.5', '1e3', '0x10', ' 1', '1%20', 'NaN', '1;DROP TABLE users', '1 OFFSET 0--'];
  for (const raw of bad) {
    for (const param of ['limit', 'offset']) {
      handlers = [];
      log = [];
      const res = await call(`/api/admin/reports?${param}=${encodeURIComponent(raw)}`);
      assert.strictEqual(res.status, 400, `${param}=${raw} answered ${res.status}: ${res.text}`);
      assert.match(res.body.error, /whole number/, `${param}=${raw} refusal must say what is wrong`);
      assert.deepStrictEqual(log, [], `${param}=${raw} reached the database`);
    }
  }
});

test('the interpolated values can only come from pageParam, and the raw request strings never do', () => {
  // Structural half of the test above: the template must interpolate the
  // validated locals, and nothing in the file may put req.query into a
  // template literal.
  assert.match(ADMIN_SRC, /LIMIT \$\{limit \+ 1\} OFFSET \$\{offset\}/,
    'the pagination interpolation moved; update this probe and re-argue the safety');
  assert.ok(!/\$\{req\.query/.test(ADMIN_SRC), 'a request value is interpolated into SQL somewhere in routes/admin.js');
});

// ===========================================================================
// 3. hasMore is a fact
// ===========================================================================

test('a full window plus one is hasMore:true, and the extra row is sliced off, not served', async () => {
  handlers = queueHandlers(nRows(QUEUE_LIMIT_DEFAULT + 1));
  const res = await call('/api/admin/reports');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.hasMore, true);
  assert.strictEqual(res.body.reports.length, QUEUE_LIMIT_DEFAULT,
    'the probe row past the window is bookkeeping, not payload');
});

test('an exactly-full window is hasMore:false — the flag cannot be a length guess', async () => {
  // A length==limit heuristic answers true here and sends the console a Load
  // more button with nothing behind it: a control that can only disappoint,
  // on the screen where every control has to be honourable.
  handlers = queueHandlers(nRows(QUEUE_LIMIT_DEFAULT));
  const res = await call('/api/admin/reports');
  assert.strictEqual(res.body.hasMore, false);
  assert.strictEqual(res.body.reports.length, QUEUE_LIMIT_DEFAULT);
});

// ===========================================================================
// 4. The console and the server agree — the drift every widening has had
// ===========================================================================

test('the console pages with limit=, and its window ceiling fits the server\'s', () => {
  assert.match(CONSOLE_SRC, /\/api\/admin\/reports\?limit=\$\{limit\}/,
    'ModerationDashboard.js no longer asks with a limit; the pagination has no consumer and the truncation is silent again');
  const winMax = /const WINDOW_MAX = (\d+)/.exec(CONSOLE_SRC);
  assert.ok(winMax, 'WINDOW_MAX left ModerationDashboard.js; find where the console caps its window and re-pin it');
  assert.ok(Number(winMax[1]) <= QUEUE_LIMIT_MAX,
    `the console will ask for ${winMax[1]} rows and the server refuses anything past ${QUEUE_LIMIT_MAX} with a 400 — Load more would read as a broken console`);
  const listLimit = /const LIST_LIMIT = (\d+)/.exec(CONSOLE_SRC);
  assert.ok(listLimit, 'LIST_LIMIT left ModerationDashboard.js');
  assert.strictEqual(Number(listLimit[1]), QUEUE_LIMIT_DEFAULT,
    'the console\'s page step and the server default drifted; the first load and the notices stop describing each other');
});

test('the console\'s reason input cannot compose a reason the route refuses', () => {
  // PUT /api/admin/reports/:id refuses reason.length > 1000 — read the bound
  // off the route rather than repeating it, so the pin follows the code.
  const cap = /reason\.length > (\d+)/.exec(ADMIN_SRC);
  assert.ok(cap, 'the reason length bound left routes/admin.js');
  const local = /maxLength=\{(\d+)\}/.exec(CONSOLE_SRC);
  assert.ok(local, 'the console\'s reason input lost its maxLength');
  assert.ok(Number(local[1]) <= Number(cap[1]),
    'the console lets a moderator type a reason the server will refuse after they have already clicked Ban');
});

test('the console sends the reason with the action and asks for evidence rows by name', () => {
  // The loop this round closes: accepted by the route, previously sent by
  // nothing and rendered by nothing.
  assert.match(CONSOLE_SRC, /JSON\.stringify\(reason \? \{ action, reason \} : \{ action \}\)/,
    'the console no longer sends the typed reason with the action');
  assert.match(CONSOLE_SRC, /include_evidence=true/,
    'the console lost its way to request evidence-access rows; ?include_evidence=true has no consumer again');
  assert.match(CONSOLE_SRC, /evidence_viewed/,
    'the console no longer distinguishes access records from decisions in the audit log');
});
