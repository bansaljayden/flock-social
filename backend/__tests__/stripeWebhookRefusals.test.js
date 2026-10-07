'use strict';
// ---------------------------------------------------------------------------
// THE STRIPE WEBHOOK'S REFUSALS ARE HEARD, AND CANNOT BE USED TO FLOOD THE LOG
//
//   * each kind of refusal says one line that names what to fix, and no line
//     carries anything from the request: not the header, not the body;
//   * a burst says one line per kind per ten minutes, and the next line
//     carries the count since the last one;
//   * a delivery shaped like Stripe's that fails after deliveries verified
//     says so, which is how a rolled or re-pasted signing secret shows up,
//     and deliveries that keep verifying among the refusals say the secret is
//     right;
//   * a JSON body without its raw bytes is a 500 the fault counter sees (only
//     a broken server.js causes one), and a body that is not JSON stays a 400
//     it does not see;
//   * a production boot names a Stripe setup that can only refuse.
//
// The real stripe package signs and checks every request here, under secrets
// made up at run time. proWebCheckout.test.js and venueWebCheckout.test.js put
// a fake stripe in the require cache, which is why this is a file of its own.
// The event sent is one the route acknowledges without the database or
// RevenueCat, so nothing leaves the process.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const Stripe = require('stripe');

// Assembled at run time, so nothing in this file looks like a real key.
const newSigningSecret = () => ['whsec', crypto.randomBytes(24).toString('hex')].join('_');
const API_KEY = ['sk', 'test', crypto.randomBytes(12).toString('hex')].join('_');

const saved = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
function resetEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const billing = require('../services/proBilling');
const route = require('../routes/stripeWebhook');
const { faultMiddleware, serverFaultStatus, __resetServerFaults } = require('../utils/serverFault');

const {
  looksLikeStripe, noteRefusal, noteVerified, refusalStatus, resetRefusals, setupProblems, REFUSAL_LINE_EVERY_MS,
} = route.__test;

let secret;
test.beforeEach(() => {
  secret = newSigningSecret();
  setEnv({ STRIPE_SECRET_KEY: API_KEY, STRIPE_WEBHOOK_SECRET: secret });
  resetRefusals();
  __resetServerFaults();
  billing.__test.resetStripe();
});
test.afterEach(() => resetEnv());

// Every line written while it is installed, with its level.
function capture() {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const level of Object.keys(real)) {
    console[level] = (...args) => lines.push({ level, text: args.map(String).join(' ') });
  }
  return { lines, restore: () => Object.assign(console, real) };
}

// keepRawBytes: false mounts the route behind a JSON parser that keeps no
// bytes, which is what a lost row in server.js's parser table looks like.
async function post({ body, headers = {}, keepRawBytes = true }) {
  const app = express();
  app.use(faultMiddleware);
  app.use(express.json(keepRawBytes ? { verify: (req, _res, buf) => { req.rawBody = buf; } } : {}));
  app.use('/api/stripe-webhook', route);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/stripe-webhook`, { method: 'POST', headers, body });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// An event the route acknowledges as ignored, signed over its exact bytes and
// indented the way Stripe sends it.
function signedEvent(signingSecret) {
  const payload = JSON.stringify({
    id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    object: 'event',
    type: 'product.created',
    data: { object: { id: 'prod_1', object: 'product' } },
  }, null, 2);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret });
  return { body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': header } };
}

// Well formed and current, signed with nothing: what a forger who has read
// Stripe's docs sends.
const shapedForgery = () => `t=${Math.floor(Date.now() / 1000)},v1=${crypto.randomBytes(32).toString('hex')}`;

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

test('a delivery signed with the endpoint secret is accepted, and says nothing', async () => {
  const cap = capture();
  let res;
  try {
    res = await post(signedEvent(secret));
  } finally { cap.restore(); }
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body, { received: true, ignored: 'product.created' });
  assert.deepStrictEqual(cap.lines, []);
  assert.ok(refusalStatus().lastVerifiedAt);
});

test('each kind of refusal says one line that names what to fix, and nothing from the request', async () => {
  const SENTINEL = 'sentinel7f3a';
  const forgedV1 = crypto.randomBytes(32).toString('hex');
  const body = JSON.stringify({ note: SENTINEL }, null, 2);
  const json = { 'content-type': 'application/json' };
  const cap = capture();
  const statuses = [];
  try {
    setEnv({ STRIPE_WEBHOOK_SECRET: undefined });
    statuses.push((await post({ body, headers: { ...json, 'stripe-signature': `t=1,v1=${SENTINEL}` } })).status);
    setEnv({ STRIPE_WEBHOOK_SECRET: secret });
    statuses.push((await post({ body, headers: json })).status);
    const shaped = await post({ body, headers: { ...json, 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${forgedV1}` } });
    statuses.push(shaped.status);
    assert.deepStrictEqual(shaped.body, { error: 'Invalid signature' });
    statuses.push((await post({ body, headers: { ...json, 'stripe-signature': `t=1,v1=${SENTINEL}` } })).status);
  } finally { cap.restore(); }

  assert.deepStrictEqual(statuses, [503, 400, 400, 400]);
  assert.deepStrictEqual(cap.lines.map((l) => l.level), ['error', 'warn', 'error', 'warn']);
  const [unset, unsigned, shaped, junk] = cap.lines.map((l) => l.text);
  assert.match(unset, /^\[stripe-webhook\] answered 503 to 1 request .*STRIPE_WEBHOOK_SECRET is not set to a usable value/);
  assert.doesNotMatch(unset, /STRIPE_SECRET_KEY/, 'the key is set, so only the missing variable is named');
  assert.match(unsigned, /refused 1 request .* with no Stripe-Signature header/);
  assert.match(shaped, /1 delivery shaped like Stripe's .* failed the signature check/);
  assert.match(shaped, /Compare STRIPE_WEBHOOK_SECRET with the signing secret of the endpoint/);
  assert.match(junk, /not shaped like a live delivery/);
  for (const { text } of cap.lines) {
    assert.ok(!text.includes(SENTINEL), `a line carried part of the request: ${text}`);
    assert.ok(!text.includes(forgedV1), `a line carried the signature header: ${text}`);
    assert.ok(!text.includes(secret.slice(6)), `a line carried the signing secret: ${text}`);
  }
});

test('the 503 line names whichever Stripe variable is missing', () => {
  const cap = capture();
  try {
    setEnv({ STRIPE_SECRET_KEY: undefined });
    noteRefusal('not_configured', T0);
    resetRefusals(T0);
    setEnv({ STRIPE_WEBHOOK_SECRET: undefined });
    noteRefusal('not_configured', T0);
    resetRefusals(T0);
    // A value too short to be a secret is the same as none.
    setEnv({ STRIPE_SECRET_KEY: API_KEY, STRIPE_WEBHOOK_SECRET: 'whsec_short' });
    noteRefusal('not_configured', T0);
  } finally { cap.restore(); }
  const [keyOnly, both, short] = cap.lines.map((l) => l.text);
  assert.match(keyOnly, /: STRIPE_SECRET_KEY is not set to a usable value/);
  assert.match(both, /: STRIPE_WEBHOOK_SECRET and STRIPE_SECRET_KEY are not set to a usable value/);
  assert.match(short, /: STRIPE_WEBHOOK_SECRET is not set to a usable value \(16 characters or more\)/);
});

test('a burst says one line per kind, and the next line, ten minutes on, carries the count', async () => {
  const cap = capture();
  try {
    for (let i = 0; i < 20; i += 1) {
      assert.strictEqual((await post({ body: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': shapedForgery() } })).status, 400);
      assert.strictEqual((await post({ body: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=x' } })).status, 400);
    }
  } finally { cap.restore(); }
  assert.strictEqual(cap.lines.length, 2, cap.lines.map((l) => l.text).join('\n'));
  const { refusals } = refusalStatus();
  assert.deepStrictEqual([refusals.bad_signature.total, refusals.bad_signature.sinceLastLine], [20, 19]);
  assert.deepStrictEqual([refusals.junk_signature.total, refusals.junk_signature.sinceLastLine], [20, 19]);

  // The same rule on a clock the test sets.
  resetRefusals(T0);
  const timed = capture();
  try {
    assert.strictEqual(noteRefusal('junk_signature', T0), true, 'the first of a kind is said at once');
    for (let i = 1; i <= 40; i += 1) assert.strictEqual(noteRefusal('junk_signature', T0 + i * 1000), false);
    assert.strictEqual(noteRefusal('no_signature', T0 + 60e3), true, 'each kind has its own ten minutes');
    assert.strictEqual(noteRefusal('junk_signature', T0 + REFUSAL_LINE_EVERY_MS - 1), false);
    assert.strictEqual(noteRefusal('junk_signature', T0 + REFUSAL_LINE_EVERY_MS), true);
  } finally { timed.restore(); }
  const texts = timed.lines.map((l) => l.text);
  assert.strictEqual(texts.length, 3);
  assert.match(texts[0], /refused 1 request \(counted since 2026-10-07T12:00:00\.000Z\)/);
  assert.match(texts[1], /refused 1 request \(counted since 2026-10-07T12:00:00\.000Z\) with no Stripe-Signature header/);
  assert.match(texts[2], /refused 42 requests \(counted since 2026-10-07T12:00:00\.000Z\)/,
    'the forty-one held back, and this one, are counted from the last line');
});

test('deliveries that verified and then stopped: the line says the signing secret changed', async () => {
  const cap = capture();
  let ok;
  let refused;
  try {
    ok = await post(signedEvent(secret));
    // The secret is rolled in Stripe and the server still holds the old one.
    refused = await post(signedEvent(newSigningSecret()));
  } finally { cap.restore(); }
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(refused.status, 400);
  assert.deepStrictEqual(refused.body, { error: 'Invalid signature' });
  assert.strictEqual(cap.lines.length, 1);
  const { level, text } = cap.lines[0];
  assert.strictEqual(level, 'error');
  assert.match(text, /1 delivery shaped like Stripe's/);
  assert.ok(text.includes(`The last delivery that verified arrived at ${refusalStatus().lastVerifiedAt}.`), text);
  assert.match(text, /a signing secret rolled in Stripe, or a changed STRIPE_WEBHOOK_SECRET/);
});

test('with nothing verified since the process started, the line says the secret does not match this deploy', async () => {
  const cap = capture();
  let refused;
  try {
    refused = await post(signedEvent(newSigningSecret()));
  } finally { cap.restore(); }
  assert.strictEqual(refused.status, 400);
  assert.strictEqual(cap.lines.length, 1);
  assert.match(cap.lines[0].text, /None has verified since this process started at /);
  assert.match(cap.lines[0].text, /If STRIPE_WEBHOOK_SECRET was set or changed with this deploy, it is not the endpoint's signing secret/);
});

test('deliveries that keep verifying among the refusals mean another sender, not a wrong secret', () => {
  resetRefusals(T0);
  const cap = capture();
  try {
    noteVerified(T0 + 1000);
    assert.strictEqual(noteRefusal('bad_signature', T0 + 2000), true);
    assert.strictEqual(noteRefusal('bad_signature', T0 + 60e3), false);
    noteVerified(T0 + 120e3);
    assert.strictEqual(noteRefusal('bad_signature', T0 + 180e3), false);
    assert.strictEqual(noteRefusal('bad_signature', T0 + 2000 + REFUSAL_LINE_EVERY_MS), true);
  } finally { cap.restore(); }
  const [first, second] = cap.lines.map((l) => l.text);
  assert.match(first, /The last delivery that verified arrived at 2026-10-07T12:00:01\.000Z\./);
  assert.match(second, /3 deliveries shaped like Stripe's/);
  assert.match(second, /1 delivery did verify among them, so STRIPE_WEBHOOK_SECRET matches the endpoint/);
  assert.doesNotMatch(second, /rolled/);
});

test('a signing secret of the wrong shape is still tried, and the refusal line says what is wrong with it', async () => {
  // A paste that kept its quotes: long enough to count as set, never a match.
  setEnv({ STRIPE_WEBHOOK_SECRET: `"${secret}"` });
  assert.strictEqual(billing.stripeWebhookConfigured(), true, '"configured" keeps its one length rule');
  const cap = capture();
  let res;
  try {
    res = await post(signedEvent(secret));
  } finally { cap.restore(); }
  assert.strictEqual(res.status, 400);
  assert.strictEqual(cap.lines.length, 1);
  assert.match(cap.lines[0].text, /STRIPE_WEBHOOK_SECRET does not start with whsec_, so it is not an endpoint signing secret/);
  assert.ok(!cap.lines[0].text.includes(secret.slice(6)), 'the line never carries the value');

  setEnv({ STRIPE_WEBHOOK_SECRET: API_KEY });
  assert.match(billing.stripeWebhookSecretProblem(), /does not start with whsec_/, 'an API key in the wrong variable');
  setEnv({ STRIPE_WEBHOOK_SECRET: `${secret.slice(0, 20)}\n${secret.slice(20)}` });
  assert.match(billing.stripeWebhookSecretProblem(), /line break/);
  setEnv({ STRIPE_WEBHOOK_SECRET: secret });
  assert.strictEqual(billing.stripeWebhookSecretProblem(), null);
  setEnv({ STRIPE_WEBHOOK_SECRET: undefined });
  assert.strictEqual(billing.stripeWebhookSecretProblem(), null, 'a missing secret is the 503 line\'s to name');
});

test('a JSON body without its raw bytes is a 500 the fault counter sees; a body that is not JSON stays a 400 it does not', async () => {
  const cap = capture();
  let lost;
  let notJson;
  let empty;
  try {
    lost = await post({ ...signedEvent(secret), keepRawBytes: false });
    notJson = await post({ body: 'x', headers: { 'content-type': 'text/plain', 'stripe-signature': shapedForgery() } });
    empty = await post({ headers: { 'content-type': 'application/json', 'stripe-signature': shapedForgery() } });
  } finally { cap.restore(); }
  assert.strictEqual(lost.status, 500);
  assert.strictEqual(notJson.status, 400);
  assert.deepStrictEqual(notJson.body, { error: 'Missing signature' });
  assert.strictEqual(empty.status, 400);
  const faults = serverFaultStatus();
  assert.strictEqual(faults.total, 1, 'only the lost parser is a fault; no outsider can make one');
  assert.match(faults.routes[0].route, /stripe-webhook/);

  const parserLost = cap.lines.find((l) => /answered 500/.test(l.text));
  assert.ok(parserLost, cap.lines.map((l) => l.text).join('\n'));
  assert.strictEqual(parserLost.level, 'error');
  assert.match(parserLost.text, /lost its raw-bytes parser \(the STRIPE_WEBHOOK_BODY_ROUTE row of SCOPED_JSON_PARSERS\)/);
  assert.ok(cap.lines.some((l) => l.level === 'warn' && /no JSON body to check one against/.test(l.text)));
});

test('a header shaped like a live delivery: a v1 signature, signed within five minutes', () => {
  const now = Date.now();
  const header = Stripe.webhooks.generateTestHeaderString({ payload: '{}', secret });
  assert.strictEqual(looksLikeStripe(header, now), true);
  // During a secret roll Stripe signs with both secrets, so two v1 entries.
  assert.strictEqual(looksLikeStripe(`${header},v1=${'0'.repeat(64)}`, now), true);
  assert.strictEqual(looksLikeStripe(header, now + 310e3), false, 'signed more than five minutes ago');
  const t = Math.floor(now / 1000);
  assert.strictEqual(looksLikeStripe(`t=${t},v0=${'a'.repeat(64)}`, now), false, 'no v1 signature');
  assert.strictEqual(looksLikeStripe(`t=${t},v1=${'A'.repeat(64)}`, now), false, 'Stripe signs in lower-case hex');
  assert.strictEqual(looksLikeStripe(`t=${t},v1=good`, now), false);
  assert.strictEqual(looksLikeStripe(`v1=${'a'.repeat(64)}`, now), false, 'no timestamp');
  assert.strictEqual(looksLikeStripe('t=1,v1=good', now), false);
  assert.strictEqual(looksLikeStripe('', now), false);
});

test('a production boot names a Stripe setup that can only refuse, and a dormant one says nothing', () => {
  setEnv({ STRIPE_WEBHOOK_SECRET: undefined });
  let problems = setupProblems();
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /^STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not set to a usable value .* answers 503 to every Stripe event/);

  setEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: secret });
  problems = setupProblems();
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /^STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is not/);

  setEnv({ STRIPE_SECRET_KEY: API_KEY, STRIPE_WEBHOOK_SECRET: API_KEY });
  problems = setupProblems();
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /^STRIPE_WEBHOOK_SECRET does not start with whsec_.*every Stripe delivery will fail its signature check/);

  setEnv({ STRIPE_WEBHOOK_SECRET: secret });
  assert.deepStrictEqual(setupProblems(), []);
  setEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined });
  assert.deepStrictEqual(setupProblems(), [], 'no Stripe at all is the dormant state, not a fault');

  // And the route says them as it loads in production.
  setEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: API_KEY, STRIPE_WEBHOOK_SECRET: undefined });
  const file = require.resolve('../routes/stripeWebhook');
  const loaded = require.cache[file];
  delete require.cache[file];
  const cap = capture();
  try {
    require('../routes/stripeWebhook');
  } finally {
    cap.restore();
    require.cache[file] = loaded;
  }
  assert.strictEqual(cap.lines.length, 1);
  assert.strictEqual(cap.lines[0].level, 'error');
  assert.match(cap.lines[0].text, /^\[stripe-webhook\] STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not/);
});
