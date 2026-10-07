'use strict';
// Run: node --test __tests__/webhookSignaturesEndToEnd.test.js  (from backend/)
// ===========================================================================
// THE THREE INBOUND WEBHOOKS, SIGNED FOR REAL, THROUGH server.js'S OWN WIRING
// ===========================================================================
// Stripe, Resend and RevenueCat each POST to a route that takes no JWT, and
// each route's own tests mount its router on a bare express app behind a body
// parser of the test's choosing. That proves the router. It cannot see the two
// things server.js decides for these routes, and both fail closed, with
// nothing in the app looking broken, when they go wrong:
//
//   * THE RAW BYTES. Stripe and Svix sign the payload exactly as sent, and
//     req.rawBody reaches /api/stripe-webhook and /api/email-events only
//     because their rows in SCOPED_JSON_PARSERS give them the parser that
//     keeps it. Without the row, every genuine Stripe event and every bounce
//     is refused, while a test of the bare router still passes.
//   * THE MOUNT ORDER. All three must be mounted above the bare /api
//     catch-alls, whose router.use(authenticate) answers 401 to anything
//     without a JWT before the webhook router is reached.
//
// So the request path here is the one production builds, and the signatures
// are real:
//   * Stripe is the installed SDK on both sides: generateTestHeaderString
//     signs, and services/proBilling.js verifies with constructEvent. The
//     bytes, the secret and the 300 s tolerance are all exercised, which a
//     fake SDK checks none of;
//   * Svix is computed here from its published scheme, with rotation lists
//     and stale timestamps in both directions;
//   * RevenueCat is the shared secret in Authorization, right and wrong;
//   * the signed bodies are indented JSON with non-ASCII text, which is what
//     Stripe sends, and which a verifier that re-serialises the parsed body
//     instead of hashing the bytes refuses.
//
// HOW server.js IS RUN. Requiring it boots it (migrations, a listening port),
// so this file never does. Its parser block and global error handler are
// lifted out of the source and run, by the anchors bodyLimitAudit.test.js
// uses. Its `app.use('/api...')` rows are read in file order, and each row that
// mounts one of the three webhook routers or a bare /api catch-all mounts the
// real router at the real prefix. Only the database pool and the outbound
// network are stubbed, and every event here is one these routes answer
// without the network.
//
// WHAT A LIFT CANNOT SEE is middleware above the lifted block, so a source
// check at the end pins that no body parser runs before it.
//
// Checked once against in-memory copies of the code, each of these turns this
// file red: deleting the Stripe, Resend or RevenueCat row from
// SCOPED_JSON_PARSERS, or pointing either raw-bytes row at webhookJsonParser;
// deleting any of the three mount rows, moving one below the catch-alls or
// above the parsers, or moving a catch-all above one; an express.json() above
// or inside the lifted block; verifying JSON.stringify(req.body), or a latin1
// reading of the bytes, for Stripe or Svix; a fixed Stripe secret, the API key
// used as the secret, or a ten-year tolerance; Svix reading only the first or
// only the last signature, or accepting timestamps from the future; and
// RevenueCat's secret check removed or weakened to a prefix match.
//
// Every secret is generated per run and never printed.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const express = require('express');
const Stripe = require('stripe');

// ---------------------------------------------------------------------------
// 0. The environment, the database and the network
// ---------------------------------------------------------------------------
// Assembled at runtime so no literal here looks like a key. The two API keys
// only have to clear their 16-character floors: Stripe has to count as
// configured for its webhook to answer at all, and RevenueCat's subscriber
// re-read is configured the way production has it. No event below makes a
// call that uses either.
const SECRETS = {
  STRIPE_SECRET_KEY: ['sk', 'test', crypto.randomBytes(16).toString('hex')].join('_'),
  STRIPE_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(24).toString('base64')}`,
  RESEND_WEBHOOK_SECRET: `whsec_${crypto.randomBytes(24).toString('base64')}`,
  REVENUECAT_WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex'),
  REVENUECAT_SECRET_API_KEY: ['rc', 'test', crypto.randomBytes(16).toString('hex')].join('_'),
};
Object.assign(process.env, SECRETS);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'webhook-end-to-end-test-secret';

// The real pool object with its two entry points replaced before any router
// loads, so nothing here can reach a database. The one write a verified event
// below makes is the Resend route's suppression row. It is recorded, so a
// test can tell a bounce that was acted on from one that was refused.
const pool = require('../config/database');
const suppressed = new Map(); // address -> reason
function answer(sql, params) {
  if (/^\s*INSERT INTO email_suppressions\b/i.test(String(sql))) {
    suppressed.set(params[0], params[1]);
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}
pool.query = async (sql, params) => answer(sql, params);
pool.connect = async () => ({ query: async (sql, params) => answer(sql, params), release() {} });

// RevenueCat is reached through global fetch and Stripe's API through
// https.request. Nothing here needs either, so a call is recorded and refused,
// and every test checks afterwards that none was made.
const outbound = [];
const realFetch = global.fetch;
const realHttpsRequest = https.request;
global.fetch = async (url) => {
  outbound.push(`fetch ${url}`);
  throw new Error('this test makes no outbound requests');
};
https.request = (target) => {
  const where = typeof target === 'string' || target instanceof URL
    ? String(target)
    : target && (target.hostname || target.host);
  outbound.push(`https ${where}`);
  throw new Error('this test makes no outbound requests');
};

// The real routers, keyed by the file name server.js requires them under.
const ROUTERS = {
  stripeWebhook: require('../routes/stripeWebhook'),
  emailWebhook: require('../routes/emailWebhook'),
  revenuecat: require('../routes/revenuecat'),
  // The bare /api catch-alls. Each opens with router.use(authenticate), which
  // is the 401 a webhook mounted below them gets instead of its own handler.
  moderation: require('../routes/moderation'),
  messages: require('../routes/messages'),
};
const { CHAT_IMAGE_MAX_BYTES } = require('../sockets/handlers');

// ---------------------------------------------------------------------------
// 1. server.js, lifted out of its source
// ---------------------------------------------------------------------------
// LF throughout, so the row patterns below hold on a CRLF checkout too.
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

// The anchors bodyLimitAudit.test.js lifts the same block by.
const PARSER_BLOCK_START = 'const JSON_BODY_ENVELOPE_BYTES';
const PARSER_BLOCK_END = 'app.use(express.urlencoded(';

function parserBlock(src) {
  const start = src.indexOf(PARSER_BLOCK_START);
  const endAt = src.indexOf(PARSER_BLOCK_END, start);
  assert.ok(start > 0, 'server.js must declare JSON_BODY_ENVELOPE_BYTES, where its parser block starts');
  assert.ok(endAt > start, 'server.js must mount the urlencoded parser after the JSON ones');
  const end = src.indexOf('\n', endAt);
  return { start, end, text: src.slice(start, end) };
}

// Mounts the block on `app`, and hands back the two ceilings the tests size
// their bodies against.
function liftParserBlock(src, app) {
  // eslint-disable-next-line no-new-func
  const run = new Function('express', 'CHAT_IMAGE_MAX_BYTES', 'app',
    `${parserBlock(src).text}\nreturn { DEFAULT_JSON_BODY_BYTES, WEBHOOK_JSON_BODY_BYTES };`);
  return run(express, CHAT_IMAGE_MAX_BYTES, app);
}

function liftErrorHandler(src) {
  const start = src.indexOf('const BODY_PARSER_CLIENT_ERRORS');
  assert.ok(start > 0, 'server.js must classify body-parser failures');
  const tail = "return res.status(500).json({ error: 'Internal server error' });";
  const at = src.indexOf(tail, start);
  assert.ok(at > start, 'the global error handler must still fall through to a 500');
  const end = src.indexOf('\n});', at + tail.length) + '\n});'.length;
  const marker = /const CORS_REFUSED = '([^']+)';/.exec(src);
  assert.ok(marker, 'server.js no longer declares CORS_REFUSED, which the lifted handler reads');
  let handler = null;
  // eslint-disable-next-line no-new-func
  new Function('app', 'CORS_REFUSED', src.slice(start, end))({ use: (fn) => { handler = fn; } }, marker[1]);
  assert.equal(typeof handler, 'function', 'the error handler must be an app.use');
  return handler;
}

// Every `app.use('/api...', ...)` row in server.js, in file order, with the
// router it mounts resolved to its file under routes/: an inline require, or a
// name bound by `const x = require('./routes/...');`. A row that mounts no router,
// such as a limiter on its own, resolves to null.
function apiMountRows(src) {
  const bound = new Map();
  for (const m of src.matchAll(/^const (\w+) = require\('\.\/routes\/(\w+)'\);/gm)) bound.set(m[1], m[2]);
  return [...src.matchAll(/^app\.use\('(\/api[^']*)',(.*)$/gm)].map((m) => {
    const close = m[2].indexOf(');');
    const call = close >= 0 ? m[2].slice(0, close) : m[2];
    const inline = /require\('\.\/routes\/(\w+)'\)/.exec(call);
    const named = (call.match(/\w+/g) || []).find((id) => bound.has(id));
    return { index: m.index, prefix: m[1], file: inline ? inline[1] : (named ? bound.get(named) : null) };
  });
}

// The request path production builds for these routes: the parser block, then
// each row above that mounts a router this file has, in server.js's order,
// then server.js's error handler.
function buildStack(src) {
  const app = express();
  const limits = liftParserBlock(src, app);
  for (const row of apiMountRows(src)) {
    if (row.file && Object.hasOwn(ROUTERS, row.file)) app.use(row.prefix, ROUTERS[row.file]);
  }
  app.use(liftErrorHandler(src));
  return { app, limits };
}
const { app: STACK, limits: LIMITS } = buildStack(SERVER_SRC);

// ---------------------------------------------------------------------------
// 2. One server for the file, and a client that sends exact bytes
// ---------------------------------------------------------------------------
// The local e2e stack (tools/e2e) holds these ports for its web app, API and
// Postgres; an ephemeral port that lands on one is drawn again.
const E2E_PORTS = new Set([3199, 5199, 59610]);
let server;
let port;

// The routes log suppressions and refusals. That output is kept out of the
// test run and attached to each response instead, so a failing assertion
// prints what the route said along with what it answered.
const logged = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };

test.before(async () => {
  for (const level of Object.keys(realConsole)) {
    console[level] = (...args) => logged.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
  }
  for (;;) {
    server = http.createServer(STACK);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    if (!E2E_PORTS.has(port)) break;
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(async () => {
  Object.assign(console, realConsole);
  global.fetch = realFetch;
  https.request = realHttpsRequest;
  if (server) await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  suppressed.clear();
  outbound.length = 0;
});

test.afterEach(() => {
  assert.deepEqual(outbound, [], 'nothing in this file may reach the network');
});

function post(urlPath, body, headers) {
  const mark = logged.length;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'content-length': Buffer.byteLength(body), connection: 'close', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text, said: logged.slice(mark) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The message a failing assertion carries: which case, what came back, and
// what the route logged on the way.
const why = (res, what) => [what, `${res.status} ${res.text}`, ...res.said].filter(Boolean).join('\n    ');

const now = () => Math.floor(Date.now() / 1000);
const freshId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
// Multi-byte characters, so a slip between bytes and characters anywhere
// between the socket and the HMAC changes what is hashed.
const NON_ASCII = 'Caf\u{e9} \u{1F989}';

// ===========================================================================
// 3. Stripe: the installed SDK signs, and the same SDK verifies in the route
// ===========================================================================
// An event type the route acknowledges and ignores, so a 200 needs nothing but
// a verified signature, and its `ignored` is the type the route read out of
// the verified body. Indented the way Stripe sends it.
function stripeEvent(extra = {}) {
  return JSON.stringify({
    id: freshId('evt'),
    object: 'event',
    api_version: '2025-03-31.basil',
    created: now(),
    type: 'product.created',
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: { id: 'prod_webhook_e2e', object: 'product', name: NON_ASCII, metadata: {}, ...extra } },
  }, null, 2);
}

function stripeHeader(payload, { secret = SECRETS.STRIPE_WEBHOOK_SECRET, timestamp } = {}) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) });
}

function postStripe(body, signature, urlPath = '/api/stripe-webhook') {
  return post(urlPath, body, { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': signature });
}

function assertStripeIgnored(res, what) {
  assert.equal(res.status, 200, why(res, what));
  assert.deepEqual(res.json, { received: true, ignored: 'product.created' }, why(res, what));
}

// The refusal the signature check gives. A bare 400 is not enough: with no raw
// bytes the route refuses with another message, which a status check alone
// would let through with server.js's parser row gone.
function assertStripeRefused(res, what) {
  assert.equal(res.status, 400, why(res, what));
  assert.deepEqual(res.json, { error: 'Invalid signature' }, why(res, what));
}

test('Stripe: an event signed over its exact bytes is handled, and its compact re-serialisation is refused', async () => {
  const body = stripeEvent();
  const compact = JSON.stringify(JSON.parse(body));
  assert.notEqual(compact, body, 'the body must differ from its re-serialisation, or a re-serialising verifier passes');
  const signature = stripeHeader(body);
  assertStripeIgnored(await postStripe(body, signature));
  assertStripeRefused(await postStripe(compact, signature));
});

test('Stripe: one changed byte is refused', async () => {
  const body = stripeEvent();
  const signature = stripeHeader(body);
  const tampered = body.replace('prod_webhook_e2e', 'prod_webhook_e2f');
  assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(body));
  assertStripeIgnored(await postStripe(body, signature));
  assertStripeRefused(await postStripe(tampered, signature));
});

test('Stripe: a signature older than the 300 s tolerance is refused, and one inside it is not', async () => {
  // The SDK checks age only, and age only grows between signing here and
  // verifying there: the old one cannot slip back inside the window, and the
  // fresh one has ten seconds of room.
  const body = stripeEvent();
  assertStripeIgnored(await postStripe(body, stripeHeader(body, { timestamp: now() - 290 })));
  assertStripeRefused(await postStripe(body, stripeHeader(body, { timestamp: now() - 301 })));
});

test('Stripe: a signature made with any other secret is refused', async () => {
  const body = stripeEvent();
  assertStripeIgnored(await postStripe(body, stripeHeader(body)));
  for (const [what, secret] of [
    ['another whsec_ secret', `whsec_${crypto.randomBytes(24).toString('base64')}`],
    ['a guessable constant', ['whsec', 'test'].join('_')],
    ['the Stripe API key, the likeliest wrong variable', SECRETS.STRIPE_SECRET_KEY],
  ]) {
    assertStripeRefused(await postStripe(body, stripeHeader(body, { secret })), what);
  }
});

test('Stripe: during a secret roll, a header with two v1 signatures verifies when only the second is ours', async () => {
  const body = stripeEvent();
  const t = now();
  const ours = stripeHeader(body, { timestamp: t }).split(',v1=')[1];
  const rolledOut = stripeHeader(body, { timestamp: t, secret: `whsec_${crypto.randomBytes(24).toString('base64')}` })
    .split(',v1=')[1];
  assertStripeIgnored(await postStripe(body, `t=${t},v1=${rolledOut},v1=${ours}`));
  assertStripeRefused(await postStripe(body, `t=${t},v1=${rolledOut},v1=${rolledOut}`));
});

test('Stripe: every spelling Express routes to the handler gets the raw bytes', async () => {
  const body = stripeEvent();
  for (const urlPath of ['/api/stripe-webhook/', '/API/STRIPE-WEBHOOK', '/Api/Stripe-Webhook', '/api/stripe-webhook//']) {
    assertStripeIgnored(await postStripe(body, stripeHeader(body), urlPath), urlPath);
  }
});

test('Stripe: an event past the 64 KB default still fits the webhook ceiling', async () => {
  const body = stripeEvent({ description: 'x'.repeat(LIMITS.DEFAULT_JSON_BODY_BYTES) });
  const bytes = Buffer.byteLength(body);
  assert.ok(bytes > LIMITS.DEFAULT_JSON_BODY_BYTES && bytes < LIMITS.WEBHOOK_JSON_BODY_BYTES,
    `${bytes} bytes must sit between the default and the webhook ceiling, or this proves nothing`);
  assertStripeIgnored(await postStripe(body, stripeHeader(body)));
});

// ===========================================================================
// 4. Resend: Svix's scheme, computed here
// ===========================================================================
// HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, keyed on the base64
// half of the whsec_ secret, sent as `v1,<base64 mac>`. While a secret rotates
// the header carries several, space separated.
const SVIX_KEY = Buffer.from(SECRETS.RESEND_WEBHOOK_SECRET.slice('whsec_'.length), 'base64');

// A permanent bounce, so a verified event leaves a mark: its address lands in
// email_suppressions. Indented, with the same non-ASCII text.
function bounceEvent(to) {
  return JSON.stringify({
    type: 'email.bounced',
    created_at: '2026-10-07T12:00:00.000Z',
    data: {
      email_id: freshId('em'),
      to: [to],
      subject: NON_ASCII,
      bounce: { type: 'Permanent', subType: 'General', message: 'Mailbox does not exist' },
    },
  }, null, 2);
}

function svixMac(body, id, ts, key = SVIX_KEY) {
  return crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

// A fresh message id per request, the way Svix sends them.
function svixHeaders(signedBody, { ts = now(), key = SVIX_KEY } = {}) {
  const id = freshId('msg');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${svixMac(signedBody, id, ts, key)}` };
}

function postSvix(body, headers, urlPath = '/api/email-events') {
  return post(urlPath, body, { 'content-type': 'application/json', ...headers });
}

function assertBounceRecorded(res, address, what) {
  assert.equal(res.status, 200, why(res, what));
  assert.deepEqual(res.json, { ok: true }, why(res, what));
  assert.equal(suppressed.get(address), 'bounce', why(res, `${what || ''} a verified permanent bounce must suppress the address`));
}

function assertSvixRefused(res, status, error, what) {
  assert.equal(res.status, status, why(res, what));
  assert.deepEqual(res.json, { error }, why(res, what));
  assert.equal(suppressed.size, 0, why(res, `${what || ''} a refused event must suppress nobody`));
}

test('Resend: a bounce signed over its exact bytes is recorded, and its compact re-serialisation is refused', async () => {
  const body = bounceEvent('gone@example.com');
  const compact = JSON.stringify(JSON.parse(body));
  assert.notEqual(compact, body, 'the body must differ from its re-serialisation, or a re-serialising verifier passes');
  assertSvixRefused(await postSvix(compact, svixHeaders(body)), 401, 'Bad signature');
  assertBounceRecorded(await postSvix(body, svixHeaders(body)), 'gone@example.com');
});

test('Resend: one changed byte is refused, so nobody can mute an address they name', async () => {
  const body = bounceEvent('dead@example.com');
  const tampered = body.replace('dead@example.com', 'deaf@example.com');
  assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(body));
  assertSvixRefused(await postSvix(tampered, svixHeaders(body)), 401, 'Bad signature');
  assertBounceRecorded(await postSvix(body, svixHeaders(body)), 'dead@example.com');
});

test('Resend: a signature made with another secret is refused', async () => {
  const body = bounceEvent('other@example.com');
  assertSvixRefused(await postSvix(body, svixHeaders(body, { key: crypto.randomBytes(24) })), 401, 'Bad signature');
  assertBounceRecorded(await postSvix(body, svixHeaders(body)), 'other@example.com');
});

test('Resend: during a rotation, one valid signature anywhere in a space-separated list verifies', async () => {
  const address = 'rotating@example.com';
  const body = bounceEvent(address);
  // Both orders, so a check of only the first entry and a check of only the
  // last entry each fail one of them.
  const listed = (order) => {
    const headers = svixHeaders(body);
    const ours = headers['svix-signature'];
    const other = `v1,${svixMac(body, headers['svix-id'], headers['svix-timestamp'], crypto.randomBytes(24))}`;
    return { ...headers, 'svix-signature': order === 'ours last' ? `${other} ${ours}` : `${ours} ${other}` };
  };
  const neither = svixHeaders(body);
  const strangers = [crypto.randomBytes(24), crypto.randomBytes(24)]
    .map((key) => `v1,${svixMac(body, neither['svix-id'], neither['svix-timestamp'], key)}`);
  assertSvixRefused(await postSvix(body, { ...neither, 'svix-signature': strangers.join(' ') }), 401, 'Bad signature');
  for (const order of ['ours last', 'ours first']) {
    suppressed.clear();
    assertBounceRecorded(await postSvix(body, listed(order)), address, order);
  }
});

test('Resend: a timestamp ten minutes off is refused in either direction', async () => {
  // Ten minutes, not 301 seconds: a second can tick between signing here and
  // checking there, and 301 in the future would then be inside the window.
  // The exact edge is pinned on a fixed clock in the next test.
  const body = bounceEvent('late@example.com');
  for (const [what, ts] of [['ten minutes ahead', now() + 600], ['ten minutes behind', now() - 600]]) {
    assertSvixRefused(await postSvix(body, svixHeaders(body, { ts })), 400, 'Stale signature', what);
  }
  assertBounceRecorded(await postSvix(body, svixHeaders(body)), 'late@example.com');
});

test('Resend: the freshness window is 300 s each way, on a fixed clock', () => {
  const { timestampFresh } = ROUTERS.emailWebhook.__testing;
  const t = 1_800_000_000;
  assert.equal(timestampFresh(String(t + 300), t), true);
  assert.equal(timestampFresh(String(t - 300), t), true);
  assert.equal(timestampFresh(String(t + 301), t), false, 'a timestamp from the future is no fresher than one from the past');
  assert.equal(timestampFresh(String(t - 301), t), false);
});

test('Resend: every spelling Express routes to the handler gets the raw bytes', async () => {
  for (const urlPath of ['/api/email-events/', '/API/EMAIL-EVENTS', '/api/email-events//']) {
    suppressed.clear();
    const address = `${freshId('spelling')}@example.com`;
    const body = bounceEvent(address);
    assertBounceRecorded(await postSvix(body, svixHeaders(body), urlPath), address, urlPath);
  }
});

// ===========================================================================
// 5. RevenueCat: the shared secret, through the same stack
// ===========================================================================
// RevenueCat signs nothing; the Authorization header is the whole boundary.
// The event is the dashboard's TEST, which the route answers without the
// database or the network. It carries enough subscriber attributes to be past
// the 64 KB default, so every request here also needs server.js's scoped
// webhook ceiling: without that row the parser answers 413 before the route.
const RC_EVENT = JSON.stringify({
  api_version: '1.0',
  event: {
    type: 'TEST',
    id: freshId('rcevt'),
    app_user_id: freshId('rcuser'),
    environment: 'SANDBOX',
    subscriber_attributes: Object.fromEntries(Array.from({ length: 160 }, (_, i) => [
      `attribute_${i}`, { value: 'v'.repeat(500), updated_at_ms: 1_759_800_000_000 },
    ])),
  },
});

function postRevenueCat(authorization, urlPath = '/api/revenuecat/webhook') {
  return post(urlPath, RC_EVENT, {
    'content-type': 'application/json',
    ...(authorization === undefined ? {} : { authorization }),
  });
}

function assertRevenueCatTest(res, what) {
  assert.equal(res.status, 200, why(res, what));
  assert.deepEqual(res.json, { ok: true, ignored: 'test' }, why(res, what));
}

test('RevenueCat: the shared secret reaches the handler, with or without the Bearer scheme', async () => {
  const bytes = Buffer.byteLength(RC_EVENT);
  assert.ok(bytes > LIMITS.DEFAULT_JSON_BODY_BYTES && bytes < LIMITS.WEBHOOK_JSON_BODY_BYTES,
    `${bytes} bytes must sit between the default and the webhook ceiling, or this proves nothing`);
  assertRevenueCatTest(await postRevenueCat(`Bearer ${SECRETS.REVENUECAT_WEBHOOK_SECRET}`), 'Bearer');
  assertRevenueCatTest(await postRevenueCat(SECRETS.REVENUECAT_WEBHOOK_SECRET), 'bare secret');
});

test('RevenueCat: a wrong secret of the same length, or none, is refused by the route itself', async () => {
  const s = SECRETS.REVENUECAT_WEBHOOK_SECRET;
  const wrong = `${s.slice(0, -1)}${s.endsWith('0') ? '1' : '0'}`;
  for (const [what, authorization] of [['Bearer, wrong', `Bearer ${wrong}`], ['bare, wrong', wrong], ['none', undefined]]) {
    const res = await postRevenueCat(authorization);
    // The route's own 401. A catch-all's authenticate answers 401 too, but as
    // 'No token provided' or 'Invalid token', so the body is what shows the
    // request reached routes/revenuecat.js.
    assert.equal(res.status, 401, why(res, what));
    assert.deepEqual(res.json, { error: 'Unauthorized' }, why(res, what));
  }
});

test('RevenueCat: every spelling Express routes to the handler gets the webhook ceiling', async () => {
  for (const urlPath of ['/api/revenuecat/webhook/', '/API/REVENUECAT/WEBHOOK', '/api/revenuecat//webhook']) {
    assertRevenueCatTest(await postRevenueCat(`Bearer ${SECRETS.REVENUECAT_WEBHOOK_SECRET}`, urlPath), urlPath);
  }
});

// ===========================================================================
// 6. The wiring, read from server.js
// ===========================================================================
// Sections 3 to 5 run these rows. This says where they must be, so a row that
// moves fails with a sentence naming it rather than a 401 in another test.
const WEBHOOK_MOUNTS = [
  ['stripeWebhook', '/api/stripe-webhook'],
  ['revenuecat', '/api/revenuecat'],
  ['emailWebhook', '/api/email-events'],
];

test('server.js mounts each webhook once, below the parser block and above the bare /api catch-alls', () => {
  const rows = apiMountRows(SERVER_SRC);
  // Rows come back in file order, so this is the first catch-all.
  const catchAll = rows.find((r) => r.prefix === '/api');
  assert.ok(catchAll, 'no bare /api catch-all found in server.js; update this test');
  const { end: parsersEnd } = parserBlock(SERVER_SRC);
  for (const [file, prefix] of WEBHOOK_MOUNTS) {
    const mounts = rows.filter((r) => r.file === file);
    assert.equal(mounts.length, 1, `routes/${file}.js must be mounted exactly once, found ${mounts.length}`);
    assert.equal(mounts[0].prefix, prefix, `routes/${file}.js has moved off ${prefix}, the URL the provider posts to`);
    assert.ok(mounts[0].index > parsersEnd,
      `${prefix} is mounted above the body parsers, so its handler runs before any body is read`);
    assert.ok(mounts[0].index < catchAll.index,
      `${prefix} is mounted below a bare /api catch-all, whose router.use(authenticate) answers every delivery 401`);
  }
});

// Comments out, code kept. server.js writes its comments as `//` lines, as
// `//` after code, and now and then as a one-line `/* */`, and those are what
// this strips. It errs toward a false alarm: a comment it misses that names a
// parser fails the test below rather than passing it.
function withoutComments(src) {
  return src.split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .map((line) => line.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/.*$/, ''))
    .join('\n');
}
const BODY_PARSER_CALL = /\b(?:express|bodyParser)\s*\.\s*(?:json|raw|text|urlencoded)\s*\(|require\(\s*['"](?:body-parser|raw-body)['"]\s*\)/;

test('no body parser runs ahead of the block this file lifts', () => {
  const { start, text } = parserBlock(SERVER_SRC);
  // The pattern has to find the parsers that are there, or its silence above
  // the block means nothing.
  assert.match(withoutComments(text), BODY_PARSER_CALL);
  assert.doesNotMatch(withoutComments(SERVER_SRC.slice(0, start)), BODY_PARSER_CALL,
    'a body parser above the scoped block reads every webhook body first, and the parser that keeps '
    + 'req.rawBody then skips a body already read, so every Stripe event and every bounce is refused');
});
