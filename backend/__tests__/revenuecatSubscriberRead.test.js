// Run: node --test  (from backend/)
//
// THE SUBSCRIBER RE-READ, AND THE PATH TAKEN WITHOUT IT.
//
// routes/revenuecat.js has two ways to apply an event. With
// REVENUECAT_SECRET_API_KEY configured, which production has, every event is
// only a prompt to ask RevenueCat for the subscriber's whole state and write
// that. Without it, the route writes users.is_premium from what the event
// itself says. This file pins:
//   * that the second path is announced, at boot in production and again on
//     the first event applied that way;
//   * which ids the first path asks RevenueCat about: Flock accounts only, and
//     at most MAX_TRANSFER_REREADS of them for one TRANSFER.
//
// A file of its own because "once per process" can only be asserted in a
// process whose first event this file controls: billingWebhookTrust.test.js
// has applied dozens of events from their bodies before any test there could
// look. The first test below has to stay the first event this file sends.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const express = require('express');

const BACKEND = path.join(__dirname, '..');

// Generated for this run, so nothing in this file is a credential.
const WEBHOOK_SECRET = crypto.randomBytes(24).toString('hex');
const API_KEY = `rc-test-${crypto.randomBytes(16).toString('hex')}`;

delete process.env.PAYWALL_ENABLED;
delete process.env.REVENUECAT_SECRET_API_KEY;
delete process.env.REVENUECAT_SANDBOX_USER_IDS;
process.env.REVENUECAT_WEBHOOK_SECRET = WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// Scripted pg fake, the same idea as billingWebhookTrust.test.js: every
// statement is logged, and one nobody scripted answers empty.
// ---------------------------------------------------------------------------
const pool = require('../config/database');
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || null });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => dispatch(sql, params),
  release: () => {},
});

// The users table, as far as the route's existence checks can see it: the
// single-account check and the TRANSFER's one int[] lookup.
function accountsAre(ids) {
  const real = new Set(ids);
  handlers.push(
    [/^SELECT 1 FROM users WHERE id = \$1$/,
      (p) => (real.has(p[0]) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 })],
    [/^SELECT id FROM users WHERE id = ANY\(\$1::int\[\]\)$/,
      (p) => {
        const rows = p[0].filter((id) => real.has(id)).map((id) => ({ id }));
        return { rows, rowCount: rows.length };
      }],
  );
}

// ---------------------------------------------------------------------------
// Fake RevenueCat. Every subscriber read is recorded by the id it asked about,
// and every subscriber is Pro. Anything else goes to the real fetch, which is
// how the tests reach the router.
// ---------------------------------------------------------------------------
const realFetch = global.fetch;
let rcReads = [];
global.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.revenuecat.com/')) return realFetch(url, init);
  rcReads.push(decodeURIComponent(u.split('/subscribers/')[1] || ''));
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  return new Response(JSON.stringify({ subscriber: { entitlements: { pro: { expires_date: future } } } }), { status: 200 });
};

const revenuecatRouter = require('../routes/revenuecat');

const app = express();
app.use(express.json());
app.use('/api/revenuecat', revenuecatRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  global.fetch = realFetch;
  server.close(() => resolve());
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  rcReads = [];
  delete process.env.REVENUECAT_SECRET_API_KEY;
});

async function signed(body) {
  const res = await fetch(`${base}/api/revenuecat/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WEBHOOK_SECRET}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const premiumWrites = () => log.filter((q) => /UPDATE users SET is_premium/i.test(q.sql));

function captureErrors() {
  const lines = [];
  const real = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = real; } };
}

// ===========================================================================
// 1. Without the API key, the route says it is taking events at their word
// ===========================================================================

test('without the API key, the first event applied from its body says so, once', async () => {
  // FIRST in this file on purpose: see the header.
  const cap = captureErrors();
  try {
    const purchase = await signed({ event: { type: 'INITIAL_PURCHASE', app_user_id: '4242', entitlement_ids: ['pro'] } });
    const expiry = await signed({ event: { type: 'EXPIRATION', app_user_id: '4242', entitlement_ids: ['pro'] } });
    const transfer = await signed({ event: { type: 'TRANSFER', transferred_from: ['11'], transferred_to: ['13'] } });
    for (const res of [purchase, expiry, transfer]) assert.equal(res.status, 200, res.text);

    const said = cap.lines.filter((l) => l.includes('REVENUECAT_SECRET_API_KEY is not set'));
    assert.equal(said.length, 1,
      `three events taken at their word must produce exactly one announcement: ${JSON.stringify(cap.lines)}`);
    assert.match(said[0],
      /this INITIAL_PURCHASE for \[4242\] and every event after it is applied from what the event says, with no RevenueCat re-read/);

    // An announcement, not a refusal: the fallback still writes what it wrote.
    assert.deepEqual(premiumWrites().map((q) => q.params), [[true, 4242], [false, 4242], [[11], [13]]]);
  } finally {
    cap.restore();
  }
});

// Requires the route in a fresh node, the way server.js does at boot, and
// returns what that wrote to stderr. The child inherits this process's
// environment minus anything RevenueCat, the paywall or the test runner set,
// plus `env`.
function bootStderr(env) {
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(REVENUECAT_|PAYWALL_)/i.test(k) || /^(NODE_TEST_CONTEXT|NODE_OPTIONS)$/i.test(k)) continue;
    childEnv[k] = v;
  }
  Object.assign(childEnv, env);
  const run = spawnSync(process.execPath, ['-e', "require('./routes/revenuecat')"], {
    cwd: BACKEND, env: childEnv, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(run.status, 0, `requiring the route failed: ${run.error || run.stderr}`);
  return run.stderr;
}

test('at boot in production, a live webhook without the API key is announced', () => {
  const said = /REVENUECAT_SECRET_API_KEY is not set, so POST \/api\/revenuecat\/webhook writes users\.is_premium from what each event says/;

  const missing = bootStderr({ NODE_ENV: 'production', REVENUECAT_WEBHOOK_SECRET: WEBHOOK_SECRET });
  assert.match(missing, said, 'production with the webhook secret and no API key started in silence');
  assert.ok(!missing.includes(WEBHOOK_SECRET), 'the boot line carried the webhook secret');

  assert.doesNotMatch(
    bootStderr({ NODE_ENV: 'production', REVENUECAT_WEBHOOK_SECRET: WEBHOOK_SECRET, REVENUECAT_SECRET_API_KEY: API_KEY }),
    said, 'a configured API key was announced as missing');
  assert.doesNotMatch(
    bootStderr({ NODE_ENV: 'test', REVENUECAT_WEBHOOK_SECRET: WEBHOOK_SECRET }),
    said, 'a run outside production is not a misconfiguration, and said so anyway');
  assert.doesNotMatch(
    bootStderr({ NODE_ENV: 'production' }),
    said, 'with no webhook secret every event is refused and nothing is taken at its word, yet the boot said otherwise');

  // A secret too short to count refuses everything too. It is not announced as
  // a webhook taking events at their word; it is announced for what it is.
  const short = bootStderr({ NODE_ENV: 'production', REVENUECAT_WEBHOOK_SECRET: 'tooshort' });
  assert.doesNotMatch(short, said);
  assert.match(short, /REVENUECAT_WEBHOOK_SECRET is 8 characters/);
});

// ===========================================================================
// 2. Only Flock accounts are re-read, and a TRANSFER re-reads a handful
// ===========================================================================
//
// RevenueCat's subscriber lookup is "get or create". The route used to ask it
// about any id from 1 to 2147483647, and a TRANSFER asked about every distinct
// id on both sides: up to a hundred reads one after another in one delivery,
// each creating a RevenueCat customer when the id was new to it.

test('a delivery naming an id with no Flock account is answered without asking RevenueCat', async () => {
  process.env.REVENUECAT_SECRET_API_KEY = API_KEY;
  accountsAre([4242]);

  const gone = await signed({ event: { type: 'EXPIRATION', app_user_id: '5150', entitlement_ids: ['pro'] } });
  assert.equal(gone.status, 200, gone.text);
  assert.equal(gone.body.ignored, 'no_such_account');
  assert.deepEqual(rcReads, [], 'RevenueCat was asked about an id that is no Flock account, and creates a customer for it');
  assert.deepEqual(premiumWrites(), []);
  assert.equal(log.filter((q) => q.sql === 'BEGIN').length, 0, 'a transaction was opened for an account that does not exist');

  // The control: an account that exists is still re-read and written.
  log = [];
  const real = await signed({ event: { type: 'RENEWAL', app_user_id: '4242', entitlement_ids: ['pro'] } });
  assert.equal(real.status, 200, real.text);
  assert.equal(real.body.source, 'subscriber');
  assert.deepEqual(rcReads, ['4242']);
  assert.deepEqual(premiumWrites().map((q) => q.params), [[true, 4242]]);
});

test('a TRANSFER re-reads only the ids that are Flock accounts', async () => {
  process.env.REVENUECAT_SECRET_API_KEY = API_KEY;
  accountsAre([11, 13]);

  const res = await signed({
    event: {
      type: 'TRANSFER',
      transferred_from: ['11', '12', '$RCAnonymousID:0123456789abcdef'],
      transferred_to: ['13', '14', '12'],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.source, 'subscriber');
  assert.deepEqual(rcReads, ['11', '13'], 'only real accounts are asked about, once each, in the order named');
  const lookups = log.filter((q) => /^SELECT id FROM users WHERE id = ANY/.test(q.sql));
  assert.equal(lookups.length, 1, 'the ids are checked in one query, not one each');
  assert.deepEqual(lookups[0].params, [[11, 12, 13, 14]], 'as a bound int[] of the distinct numeric ids');
  assert.deepEqual(premiumWrites().map((q) => q.params), [[true, 11], [true, 13]]);

  // None of them an account: nothing to read and nothing to write, and a 200,
  // so RevenueCat does not retry an event that could never succeed.
  log = [];
  rcReads = [];
  const none = await signed({ event: { type: 'TRANSFER', transferred_from: ['21'], transferred_to: ['22'] } });
  assert.equal(none.status, 200, none.text);
  assert.equal(none.body.ignored, 'no_such_account');
  assert.deepEqual(rcReads, []);
  assert.deepEqual(premiumWrites(), []);
});

test('a TRANSFER naming more Flock accounts than it may re-read is refused whole, before any read', async () => {
  process.env.REVENUECAT_SECRET_API_KEY = API_KEY;
  const { MAX_TRANSFER_REREADS } = revenuecatRouter.__testing;
  const range = (n, from) => Array.from({ length: n }, (_, i) => from + i);
  const cap = captureErrors();
  try {
    // At the cap, beside forty ids that are not accounts. Those are never read,
    // so they do not count toward it.
    const atCap = range(MAX_TRANSFER_REREADS, 100);
    accountsAre(atCap);
    const at = await signed({
      event: { type: 'TRANSFER', transferred_from: [...atCap, ...range(40, 500)].map(String), transferred_to: [] },
    });
    assert.equal(at.status, 200, at.text);
    assert.deepEqual(rcReads, atCap.map(String));

    // One account more, and nothing is read at all.
    handlers = [];
    log = [];
    rcReads = [];
    const over = range(MAX_TRANSFER_REREADS + 1, 100);
    accountsAre(over);
    const refused = await signed({
      event: { type: 'TRANSFER', transferred_from: over.slice(0, 1).map(String), transferred_to: over.slice(1).map(String) },
    });
    assert.equal(refused.status, 400, refused.text);
    assert.deepEqual(rcReads, [], 'refused rather than truncated, so no account may be read');
    assert.deepEqual(premiumWrites(), []);
    assert.ok(cap.lines.some((l) => /TRANSFER naming \d+ Flock accounts, more than the \d+ one transfer may re-read, refused/.test(l)),
      'a refused transfer has to be visible in the log');
  } finally {
    cap.restore();
  }
});
