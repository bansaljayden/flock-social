// Run: node --test  (from backend/)
//
// THE SUBSCRIBER RE-READ, AND THE PATH TAKEN WITHOUT IT.
//
// routes/revenuecat.js has two ways to apply an event. With
// REVENUECAT_SECRET_API_KEY configured, which production has, every event is
// only a prompt to ask RevenueCat for the subscriber's whole state and write
// that. Without it, the route writes users.is_premium from what the event
// itself says. This file pins what the second path owes the operator: it is
// announced at boot in production, and again on the first event applied that
// way.
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
  server.close(() => resolve());
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
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
