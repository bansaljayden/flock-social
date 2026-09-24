'use strict';
// ---------------------------------------------------------------------------
// FLOCK PRO ON THE WEB: the rules that decide whether money is taken, and
// whether a payer gets what they paid for.
//
//   * checkout is OFF unless every part exists (paywall on, Stripe key and
//     price, RevenueCat secret), because a sale that cannot be delivered, or a
//     sale of features everyone already has, is the worst outcome here;
//   * a Checkout Session carries app_user_id in BOTH the session and the
//     subscription metadata, which is what RevenueCat reads to attribute it;
//   * the renewal terms sit next to a required consent box;
//   * nobody who is already Pro, or already has a live web subscription, can
//     start a second one;
//   * the webhook, once RevenueCat's API is configured, writes what RevenueCat
//     says the subscriber has, not what one event's type implies;
//   * a refund (CANCELLATION / CUSTOMER_SUPPORT) revokes on the fallback path;
//   * a confirm for somebody else's checkout session is refused.
//
// Stripe is a fake installed in the require cache before the billing service
// loads it; RevenueCat is a fake global fetch. Nothing leaves the process.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

// ---- the fake Stripe ------------------------------------------------------
const stripeCalls = [];
const stripeState = { subscriptions: [], sessions: {}, openSessions: [], charges: {} };
function FakeStripe() {
  return {
    customers: {
      create: async (args, opts) => { stripeCalls.push(['customers.create', args, opts]); return { id: 'cus_TEST123' }; },
      del: async (id) => { stripeCalls.push(['customers.del', id]); return { id, deleted: true }; },
    },
    subscriptions: {
      list: async (args) => { stripeCalls.push(['subscriptions.list', args]); return { data: stripeState.subscriptions }; },
      cancel: async (id, params, opts) => { stripeCalls.push(['subscriptions.cancel', id, opts]); return { id, status: 'canceled' }; },
    },
    charges: {
      retrieve: async (id) => { stripeCalls.push(['charges.retrieve', id]); return stripeState.charges[id] || { id, customer: null }; },
    },
    prices: {
      retrieve: async (id) => ({ id, unit_amount: 399, currency: 'usd', recurring: { interval: 'month' } }),
    },
    checkout: {
      sessions: {
        create: async (args) => { stripeCalls.push(['checkout.create', args]); return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }; },
        retrieve: async (id) => stripeState.sessions[id] || null,
        list: async (args) => { stripeCalls.push(['checkout.list', args]); return { data: stripeState.openSessions }; },
        expire: async (id) => { stripeCalls.push(['checkout.expire', id]); return { id, status: 'expired' }; },
      },
    },
    webhooks: {
      // Accepts exactly one header value; anything else is a bad signature.
      constructEvent: (raw, sig) => {
        if (sig !== 't=1,v1=good') throw new Error('No signatures found matching the expected signature');
        return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
      },
    },
    billingPortal: {
      sessions: { create: async (args) => { stripeCalls.push(['portal.create', args]); return { url: 'https://billing.stripe.com/p/session/x' }; } },
    },
  };
}
require.cache[require.resolve('stripe')] = { id: require.resolve('stripe'), filename: require.resolve('stripe'), loaded: true, exports: FakeStripe };

// ---- the fake RevenueCat --------------------------------------------------
const rcCalls = [];
let rcEntitlement = null; // null = no pro entitlement
let rcSubscriptions = null; // the subscriber's subscriptions map, when a test needs one
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.revenuecat.com/')) {
    rcCalls.push([u, init && init.method, init && init.body]);
    if (u.includes('/subscribers/')) {
      return new Response(JSON.stringify({ subscriber: {
        entitlements: rcEntitlement ? { pro: rcEntitlement } : {},
        ...(rcSubscriptions ? { subscriptions: rcSubscriptions } : {}),
      } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }
  return realFetch(url, init);
};

const pool = require('../config/database');
const ME = { id: 7, email: 'me@example.com', name: 'Me', role: 'user', is_banned: false, token_version: 0 };

function stubPool(handler) {
  const realQuery = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    const sql = String(text);
    calls.push({ text: sql, params });
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [ME] };
    const r = await handler(sql, params);
    return r || { rows: [], rowCount: 0 };
  };
  return { calls, restore: () => { pool.query = realQuery; } };
}

async function call(mount, router, method, urlPath, body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const token = jwt.sign({ userId: ME.id, tv: 0 }, process.env.JWT_SECRET);
  try {
    const res = await realFetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const ON = {
  PAYWALL_ENABLED: 'true',
  PRO_WEB_CHECKOUT_ENABLED: 'true',
  // Fake values, assembled at runtime so nothing here looks like a real key.
  STRIPE_SECRET_KEY: ['sk', 'test', 'x'.repeat(24)].join('_'),
  STRIPE_PRICE_PRO_MONTHLY: 'price_monthly_1',
  REVENUECAT_SECRET_API_KEY: 'rc-secret-' + 'x'.repeat(24),
  REVENUECAT_STRIPE_PUBLIC_KEY: 'rc-stripe-' + 'x'.repeat(24),
  REVENUECAT_WEBHOOK_SECRET: 'rc-webhook-' + 'x'.repeat(24),
  STRIPE_WEBHOOK_SECRET: 'stripe-webhook-' + 'x'.repeat(24),
};
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
const proRoutes = require('../routes/pro');
const revenuecatRoutes = require('../routes/revenuecat');

test.beforeEach(() => {
  stripeCalls.length = 0;
  rcCalls.length = 0;
  rcEntitlement = null;
  rcSubscriptions = null;
  stripeState.subscriptions = [];
  stripeState.charges = {};
  stripeState.sessions = {};
  stripeState.openSessions = [];
  billing.__test.resetStripe();
});
test.afterEach(() => resetEnv());
test.after(() => { global.fetch = realFetch; });

test('with nothing configured, checkout is off and says so without naming internals', async () => {
  setEnv(Object.fromEntries(Object.keys(ON).map((k) => [k, undefined])));
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    return null;
  });
  try {
    const status = await call('/api/pro', proRoutes, 'GET', '/api/pro/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.checkoutAvailable, false);
    assert.deepStrictEqual(status.body.plans, []);
    assert.ok(!JSON.stringify(status.body).includes('STRIPE_SECRET_KEY'), 'env names are not for the client');
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, 'CHECKOUT_OFF');
    assert.strictEqual(stripeCalls.length, 0, 'nothing reaches Stripe while checkout is off');
  } finally { restore(); }
});

test('the paywall being off keeps checkout off even with every key set', () => {
  setEnv({ ...ON, PAYWALL_ENABLED: undefined });
  const c = billing.webCheckout();
  assert.strictEqual(c.ready, false);
  assert.ok(c.missing.includes('PAYWALL_ENABLED'));
});

test('without the RevenueCat secret checkout is off: a web sale could never reach is_premium', () => {
  setEnv({ ...ON, REVENUECAT_SECRET_API_KEY: undefined });
  const c = billing.webCheckout();
  assert.strictEqual(c.ready, false);
  assert.ok(c.missing.includes('REVENUECAT_SECRET_API_KEY'));
});

test('a checkout session carries app_user_id twice, the renewal consent, and our return urls', async () => {
  setEnv(ON);
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: null }] };
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: 7, email: 'me@example.com', name: 'Me' }] };
    if (sql.includes('UPDATE users SET stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const created = stripeCalls.find((c) => c[0] === 'customers.create');
    assert.deepStrictEqual(created[1].metadata, { app_user_id: '7' });
    assert.match(created[2].idempotencyKey, /^flock-customer-7-\d+$/, 'rolls over hourly so a deleted customer is never replayed for a day');
    assert.ok(calls.some((c) => c.text.includes('UPDATE users SET stripe_customer_id') && c.text.includes('stripe_customer_id IS NULL')));
    const session = stripeCalls.find((c) => c[0] === 'checkout.create')[1];
    assert.strictEqual(session.mode, 'subscription');
    assert.strictEqual(session.customer, 'cus_TEST123');
    assert.strictEqual(session.metadata.app_user_id, '7');
    assert.strictEqual(session.subscription_data.metadata.app_user_id, '7');
    assert.strictEqual(session.client_reference_id, '7');
    assert.deepStrictEqual(session.line_items, [{ price: 'price_monthly_1', quantity: 1 }]);
    assert.deepStrictEqual(session.consent_collection, { terms_of_service: 'required' });
    assert.match(session.custom_text.terms_of_service_acceptance.message, /renews every month until I cancel, at \$3\.99 or the lower price shown above if a code applies/);
    assert.strictEqual(session.allow_promotion_codes, true, 'friend codes are entered at checkout');
    assert.strictEqual(session.payment_method_collection, 'if_required', 'a 100%-off code needs no card');
    assert.strictEqual(session.automatic_tax.enabled, false, 'no tax until a registration is declared');
    assert.ok(!('trial_period_days' in session.subscription_data), 'no trial unless one is configured');
    assert.match(session.success_url, /\/app\?pro=success&session_id=\{CHECKOUT_SESSION_ID\}$/);
    assert.match(session.cancel_url, /\/pro\?checkout=cancelled$/);
  } finally { restore(); }
});

test('someone already Pro cannot start a second checkout', async () => {
  setEnv(ON);
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: true }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'ALREADY_PRO');
    assert.ok(!stripeCalls.some((c) => c[0] === 'checkout.create'));
  } finally { restore(); }
});

test('a live web subscription RevenueCat has not reported yet still blocks a second one', async () => {
  setEnv(ON);
  stripeState.subscriptions = [{ id: 'sub_1', status: 'active' }];
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: 7, email: 'me@example.com', name: 'Me' }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'ALREADY_SUBSCRIBED');
  } finally { restore(); }
});

test('an unoffered plan is refused before anything is created', async () => {
  setEnv(ON);
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: 7, email: 'me@example.com', name: 'Me' }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'yearly' });
    assert.strictEqual(res.status, 400);
    assert.ok(!stripeCalls.some((c) => c[0] === 'checkout.create'));
  } finally { restore(); }
});

test("confirm refuses another account's checkout session", async () => {
  setEnv(ON);
  stripeState.sessions.cs_test_other = { id: 'cs_test_other', status: 'complete', subscription: 'sub_9', metadata: { app_user_id: '8' } };
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/confirm', { sessionId: 'cs_test_other' });
    assert.strictEqual(res.status, 404);
    assert.ok(!calls.some((c) => c.text.includes('SET is_premium')));
    assert.strictEqual(rcCalls.length, 0);
  } finally { restore(); }
});

test('confirm hands the subscription to RevenueCat and writes what RevenueCat says', async () => {
  setEnv(ON);
  stripeState.sessions.cs_test_mine = { id: 'cs_test_mine', status: 'complete', subscription: 'sub_7', metadata: { app_user_id: '7' } };
  rcEntitlement = { expires_date: new Date(Date.now() + 30 * 864e5).toISOString() };
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/confirm', { sessionId: 'cs_test_mine' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { complete: true, isPremium: true });
    const receipt = rcCalls.find((c) => c[0].endsWith('/receipts'));
    assert.ok(receipt, 'the receipt was posted');
    assert.deepStrictEqual(JSON.parse(receipt[2]), { app_user_id: '7', fetch_token: 'sub_7' });
    const write = calls.find((c) => c.text.includes('SET is_premium'));
    assert.deepStrictEqual(write.params, [true, 7]);
  } finally { restore(); }
});

test('the webhook writes RevenueCat state, so an Apple EXPIRATION cannot switch off a paid web subscriber', async () => {
  setEnv(ON);
  rcEntitlement = { expires_date: new Date(Date.now() + 10 * 864e5).toISOString() };
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await call('/api/revenuecat', revenuecatRoutes, 'POST', '/api/revenuecat/webhook',
      { event: { type: 'EXPIRATION', app_user_id: '7', entitlement_ids: ['pro'] } },
      { authorization: ON.REVENUECAT_WEBHOOK_SECRET });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const write = calls.find((c) => c.text.includes('SET is_premium'));
    assert.deepStrictEqual(write.params, [true, 7], 'still Pro: another store is paying');
  } finally { restore(); }
});

test('the webhook answers 500 when RevenueCat cannot be asked, so it retries instead of guessing', async () => {
  setEnv(ON);
  const prev = global.fetch;
  global.fetch = async (url, init) => (String(url).includes('revenuecat.com') ? new Response('nope', { status: 502 }) : prev(url, init));
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await call('/api/revenuecat', revenuecatRoutes, 'POST', '/api/revenuecat/webhook',
      { event: { type: 'RENEWAL', app_user_id: '7', entitlement_ids: ['pro'] } },
      { authorization: ON.REVENUECAT_WEBHOOK_SECRET });
    assert.strictEqual(res.status, 500);
    assert.ok(!calls.some((c) => c.text.includes('SET is_premium')));
  } finally { restore(); global.fetch = prev; }
});

test('on the fallback path a refund revokes Pro, and an ordinary cancellation does not', async () => {
  setEnv({ REVENUECAT_WEBHOOK_SECRET: ON.REVENUECAT_WEBHOOK_SECRET, REVENUECAT_SECRET_API_KEY: undefined });
  const { calls, restore } = stubPool(async () => null);
  try {
    let res = await call('/api/revenuecat', revenuecatRoutes, 'POST', '/api/revenuecat/webhook',
      { event: { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', app_user_id: '7', entitlement_ids: ['pro'] } },
      { authorization: ON.REVENUECAT_WEBHOOK_SECRET });
    assert.strictEqual(res.status, 200);
    assert.ok(!calls.some((c) => c.text.includes('SET is_premium')), 'auto-renew off keeps Pro to the end of the period');
    res = await call('/api/revenuecat', revenuecatRoutes, 'POST', '/api/revenuecat/webhook',
      { event: { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: '7', entitlement_ids: ['pro'] } },
      { authorization: ON.REVENUECAT_WEBHOOK_SECRET });
    assert.strictEqual(res.status, 200);
    const write = calls.find((c) => c.text.includes('SET is_premium'));
    assert.deepStrictEqual(write.params, [false, 7]);
  } finally { restore(); }
});

test('closing a Stripe customer deletes it; with no key, deletion is not blocked forever', async () => {
  setEnv(ON);
  assert.strictEqual(await billing.closeCustomer('cus_TEST123'), true);
  assert.ok(stripeCalls.some((c) => c[0] === 'customers.del' && c[1] === 'cus_TEST123'));
  assert.strictEqual(await billing.closeCustomer(null), false);
  // No key: account deletion must stay possible (App Store 5.1.1(v)), so this
  // reports "not closed" and logs, rather than refusing every deletion.
  setEnv({ STRIPE_SECRET_KEY: undefined });
  billing.__test.resetStripe();
  assert.strictEqual(await billing.closeCustomer('cus_TEST123'), false);
});

test('starting a checkout expires every open one first, so only one can ever be paid', async () => {
  setEnv(ON);
  stripeState.openSessions = [{ id: 'cs_old_a' }, { id: 'cs_old_b' }];
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: 7, email: 'me@example.com', name: 'Me' }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200);
    const expired = stripeCalls.filter((c) => c[0] === 'checkout.expire').map((c) => c[1]);
    assert.deepStrictEqual(expired, ['cs_old_a', 'cs_old_b']);
    const order = stripeCalls.map((c) => c[0]);
    assert.ok(order.lastIndexOf('checkout.expire') < order.indexOf('checkout.create'), 'expired before the new one exists');
  } finally { restore(); }
});

test('a failed first payment (incomplete) does not block trying again', async () => {
  setEnv(ON);
  stripeState.subscriptions = [{ id: 'sub_x', status: 'incomplete' }];
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: 7, email: 'me@example.com', name: 'Me' }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  } finally { restore(); }
});

test('checkout is off until the webhook secret and RevenueCat Stripe key exist', () => {
  setEnv({ ...ON, STRIPE_WEBHOOK_SECRET: undefined });
  assert.ok(billing.webCheckout().missing.includes('STRIPE_WEBHOOK_SECRET'));
  setEnv({ ...ON, REVENUECAT_STRIPE_PUBLIC_KEY: undefined });
  assert.ok(billing.webCheckout().missing.includes('REVENUECAT_STRIPE_PUBLIC_KEY'));
});

test('a 500 never carries a Stripe or Node error code to the client', async () => {
  setEnv(ON);
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) { const e = new Error('boom'); e.code = 'ECONNRESET'; throw e; }
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: 7, email: 'me@example.com', name: 'Me' }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 500);
    assert.ok(!('code' in res.body), JSON.stringify(res.body));
  } finally { restore(); }
});

test('a TRANSFER under the subscriber re-read re-reads both sides instead of trusting the event', async () => {
  setEnv(ON);
  rcEntitlement = { expires_date: new Date(Date.now() + 5 * 864e5).toISOString() };
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await call('/api/revenuecat', revenuecatRoutes, 'POST', '/api/revenuecat/webhook',
      { event: { type: 'TRANSFER', transferred_from: ['7'], transferred_to: ['8'] } },
      { authorization: ON.REVENUECAT_WEBHOOK_SECRET });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const writes = calls.filter((c) => c.text.includes('SET is_premium')).map((c) => c.params);
    // Account 7 still has Pro (say, through Stripe), so it is NOT switched off.
    assert.deepStrictEqual(writes, [[true, 7], [true, 8]]);
    assert.strictEqual(rcCalls.filter((c) => c[0].includes('/subscribers/')).length, 2);
  } finally { restore(); }
});

// ---- the Stripe webhook ---------------------------------------------------
const stripeWebhookRoutes = require('../routes/stripeWebhook');
async function postWebhook(event, sig) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/stripe-webhook', stripeWebhookRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/stripe-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) },
      body: JSON.stringify(event),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { await new Promise((r) => server.close(r)); }
}
const completed = (userId) => ({
  type: 'checkout.session.completed',
  data: { object: { mode: 'subscription', subscription: 'sub_77', metadata: { app_user_id: userId } } },
});

test('the Stripe webhook refuses a missing or wrong signature before reading anything', async () => {
  setEnv(ON);
  const { calls, restore } = stubPool(async () => null);
  try {
    assert.strictEqual((await postWebhook(completed('7'))).status, 400);
    assert.strictEqual((await postWebhook(completed('7'), 't=1,v1=forged')).status, 400);
    assert.strictEqual(rcCalls.length, 0);
    assert.ok(!calls.some((c) => c.text.includes('SET is_premium')));
  } finally { restore(); }
});

test('the Stripe webhook answers 503 with no signing secret', async () => {
  setEnv({ ...ON, STRIPE_WEBHOOK_SECRET: undefined });
  assert.strictEqual((await postWebhook(completed('7'), 't=1,v1=good')).status, 503);
});

test('a completed checkout is handed to RevenueCat from the server, with no browser involved', async () => {
  setEnv(ON);
  rcEntitlement = { expires_date: new Date(Date.now() + 30 * 864e5).toISOString() };
  const { calls, restore } = stubPool(async (sql) => (sql.includes('SELECT 1 FROM users') ? { rows: [{ '?column?': 1 }] } : null));
  try {
    const res = await postWebhook(completed('7'), 't=1,v1=good');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const receipt = rcCalls.find((c) => c[0].endsWith('/receipts'));
    assert.deepStrictEqual(JSON.parse(receipt[2]), { app_user_id: '7', fetch_token: 'sub_77' });
    assert.deepStrictEqual(calls.find((c) => c.text.includes('SET is_premium')).params, [true, 7]);
  } finally { restore(); }
});

test('a checkout that did not come from us (no app_user_id) is ignored, not acted on', async () => {
  setEnv(ON);
  const { calls, restore } = stubPool(async () => null);
  try {
    for (const bad of [undefined, '', 'abc', '0', '99999999999', '7; DROP']) {
      const res = await postWebhook(completed(bad), 't=1,v1=good');
      assert.strictEqual(res.status, 200);
    }
    assert.strictEqual(rcCalls.length, 0);
    assert.ok(!calls.some((c) => c.text.includes('SET is_premium')));
  } finally { restore(); }
});

test('a Stripe event RevenueCat cannot confirm answers 500 so Stripe retries', async () => {
  setEnv(ON);
  const prev = global.fetch;
  global.fetch = async (url, init) => (String(url).includes('revenuecat.com') ? new Response('no', { status: 503 }) : prev(url, init));
  const { restore } = stubPool(async (sql) => (sql.includes('SELECT 1 FROM users') ? { rows: [{ '?column?': 1 }] } : null));
  try {
    assert.strictEqual((await postWebhook(completed('7'), 't=1,v1=good')).status, 500);
  } finally { restore(); global.fetch = prev; }
});

test('a renewal or cancellation re-sends the subscription so RevenueCat reads Stripe now, then is re-read', async () => {
  setEnv(ON);
  for (const type of ['customer.subscription.updated', 'customer.subscription.deleted']) {
    rcCalls.length = 0;
    rcEntitlement = { expires_date: new Date(Date.now() + 30 * 864e5).toISOString() };
    const { calls, restore } = stubPool(async (sql) => (sql.includes('SELECT 1 FROM users') ? { rows: [{ '?column?': 1 }] } : null));
    try {
      const res = await postWebhook({ type, data: { object: { id: 'sub_77', metadata: { app_user_id: '7' } } } }, 't=1,v1=good');
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const receiptAt = rcCalls.findIndex((c) => c[0].endsWith('/receipts'));
      const readAt = rcCalls.findIndex((c) => c[0].includes('/subscribers/'));
      assert.ok(receiptAt >= 0, `${type} did not refresh the subscription at RevenueCat`);
      assert.deepStrictEqual(JSON.parse(rcCalls[receiptAt][2]), { app_user_id: '7', fetch_token: 'sub_77' });
      assert.ok(readAt > receiptAt, `${type} read RevenueCat before asking it to look at Stripe`);
      assert.ok(calls.some((c) => c.text.includes('SET is_premium')));
    } finally { restore(); }
  }
});

test('a deleted account is not looked up at RevenueCat when its Stripe customer is deleted', async () => {
  setEnv(ON);
  const { restore } = stubPool(async () => null); // SELECT 1 finds nobody
  try {
    const res = await postWebhook({ type: 'customer.subscription.deleted', data: { object: { metadata: { app_user_id: '7' } } } }, 't=1,v1=good');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ignored, 'no_such_account');
    assert.strictEqual(rcCalls.length, 0);
  } finally { restore(); }
});

test('an open checkout that will not expire blocks a second one instead of allowing two payments', async () => {
  setEnv(ON);
  stripeState.openSessions = [{ id: 'cs_paying_now' }];
  stripeState.sessions.cs_paying_now = { id: 'cs_paying_now', status: 'open' };
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: 7, email: 'me@example.com', name: 'Me' }] };
    return null;
  });
  const fake = require('stripe')();
  const realExpire = fake.checkout.sessions.expire;
  // Make expiry fail the way Stripe refuses a session mid-payment.
  const Stripe = require.cache[require.resolve('stripe')];
  const prevExports = Stripe.exports;
  Stripe.exports = function Patched() {
    const c = prevExports();
    c.checkout.sessions.expire = async () => { throw new Error('This Checkout Session is being paid'); };
    return c;
  };
  billing.__test.resetStripe();
  try {
    const res = await call('/api/pro', proRoutes, 'POST', '/api/pro/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'CHECKOUT_IN_PROGRESS');
    assert.ok(!stripeCalls.some((c) => c[0] === 'checkout.create'), 'no second payable session');
  } finally {
    restore();
    Stripe.exports = prevExports;
    billing.__test.resetStripe();
    assert.ok(realExpire);
  }
});

test('/status still answers, without an offer, when Stripe cannot describe a price', async () => {
  setEnv(ON);
  const Stripe = require.cache[require.resolve('stripe')];
  const prevExports = Stripe.exports;
  Stripe.exports = function Patched() {
    const c = prevExports();
    c.prices.retrieve = async () => { throw new Error('Stripe is down'); };
    return c;
  };
  billing.__test.resetStripe();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: true }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: null }] };
    return null;
  });
  try {
    const res = await call('/api/pro', proRoutes, 'GET', '/api/pro/status');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.isPremium, true);
    assert.strictEqual(res.body.checkoutAvailable, false);
    assert.deepStrictEqual(res.body.plans, []);
  } finally {
    restore();
    Stripe.exports = prevExports;
    billing.__test.resetStripe();
  }
});

// ---- the 2026-09-24 attack pass: what it found, pinned shut ----

test('a chargeback cancels the live subscriptions we made for that customer, and nothing else', async () => {
  setEnv(ON);
  stripeState.charges.ch_1 = { id: 'ch_1', customer: 'cus_TEST123' };
  stripeState.subscriptions = [
    { id: 'sub_live', status: 'active', metadata: { app_user_id: '7' } },
    { id: 'sub_roost', status: 'trialing', metadata: { kind: 'venue', flock_venue_user_id: '7' } },
    { id: 'sub_old', status: 'canceled', metadata: { app_user_id: '7' } },
    { id: 'sub_by_hand', status: 'active', metadata: {} },
  ];
  const { restore } = stubPool(async () => null);
  try {
    const res = await postWebhook({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1' } } }, 't=1,v1=good');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const cancelled = stripeCalls.filter((c) => c[0] === 'subscriptions.cancel').map((c) => c[1]).sort();
    assert.deepStrictEqual(cancelled, ['sub_live', 'sub_roost']);
    for (const [, id, opts] of stripeCalls.filter((c) => c[0] === 'subscriptions.cancel')) {
      assert.deepStrictEqual(opts, { idempotencyKey: `flock-dispute-cancel-${id}` }, 'a retried dispute event cancels once');
    }
  } finally { restore(); }
});

test('a dispute with no customer behind it is acknowledged and changes nothing', async () => {
  setEnv(ON);
  const { restore } = stubPool(async () => null);
  try {
    const res = await postWebhook({ type: 'charge.dispute.created', data: { object: { id: 'dp_2', charge: 'ch_guest' } } }, 't=1,v1=good');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ignored, 'no_customer');
    assert.ok(!stripeCalls.some((c) => c[0] === 'subscriptions.cancel'));
  } finally { restore(); }
});

test('a refresh RevenueCat refuses still re-reads and writes, then answers 500 so Stripe retries', async () => {
  setEnv(ON);
  const prev = global.fetch;
  global.fetch = async (url, init) => (String(url).endsWith('/receipts') ? new Response('no', { status: 422 }) : prev(url, init));
  rcEntitlement = null; // RevenueCat already says the subscription is over
  const { calls, restore } = stubPool(async (sql) => (sql.includes('SELECT 1 FROM users') ? { rows: [{ '?column?': 1 }] } : null));
  try {
    const res = await postWebhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_77', metadata: { app_user_id: '7' } } } }, 't=1,v1=good');
    assert.strictEqual(res.status, 500);
    assert.ok(rcCalls.some((c) => c[0].includes('/subscribers/')), 'the re-read ran even though the refresh was refused');
    assert.deepStrictEqual(calls.find((c) => c.text.includes('SET is_premium')).params, [false, 7]);
  } finally { restore(); global.fetch = prev; }
});

test('a trial is for somebody who has never subscribed: a returning customer gets none, at checkout or on /status', async () => {
  setEnv({ ...ON, PRO_WEB_TRIAL_DAYS: '7' });
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT is_premium')) return { rows: [{ is_premium: false }] };
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    return null;
  });
  try {
    await billing.createCheckout(ME, 'monthly');
    let session = stripeCalls.filter((c) => c[0] === 'checkout.create').pop()[1];
    assert.strictEqual(session.subscription_data.trial_period_days, 7, 'a first-time customer gets the trial');
    assert.strictEqual(session.payment_method_collection, 'always', 'a trial takes a card');

    billing.__test.resetStripe();
    stripeState.subscriptions = [{ id: 'sub_old', status: 'canceled', metadata: { app_user_id: '7' } }];
    await billing.createCheckout(ME, 'monthly');
    session = stripeCalls.filter((c) => c[0] === 'checkout.create').pop()[1];
    assert.ok(!('trial_period_days' in session.subscription_data), 'cancel and come back is not a second trial');

    const status = await call('/api/pro', proRoutes, 'GET', '/api/pro/status');
    assert.strictEqual(status.status, 200, JSON.stringify(status.body));
    assert.strictEqual(status.body.trialDays, 0);
  } finally { restore(); }
});

test('two checkouts started at once are built one after the other, so only one can be paid', async () => {
  setEnv(ON);
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_TEST123' }] };
    return null;
  });
  try {
    await Promise.all([billing.createCheckout(ME, 'monthly'), billing.createCheckout(ME, 'monthly')]);
    const order = stripeCalls.map((c) => c[0]).filter((n) => n === 'checkout.list' || n === 'checkout.create');
    assert.deepStrictEqual(order, ['checkout.list', 'checkout.create', 'checkout.list', 'checkout.create'],
      'the second request looked for open sessions only after the first had made its own');
  } finally { restore(); }
});

test('a sandbox purchase unlocks nothing unless the account is allowlisted, and a paid one still counts', async () => {
  setEnv({ ...ON, REVENUECAT_SANDBOX_USER_IDS: undefined });
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  rcEntitlement = { expires_date: future, product_identifier: 'flock_pro_monthly' };
  rcSubscriptions = { flock_pro_monthly: { expires_date: future, is_sandbox: true } };
  assert.strictEqual(await billing.fetchProActive(7), false, 'a free TestFlight purchase is not production Pro');

  rcSubscriptions = {
    flock_pro_monthly: { expires_date: future, is_sandbox: true },
    price_live: { expires_date: future, is_sandbox: false },
  };
  assert.strictEqual(await billing.fetchProActive(7), true, 'a live paid subscription beside it still counts');

  rcSubscriptions = { flock_pro_monthly: { expires_date: future, is_sandbox: true } };
  setEnv({ REVENUECAT_SANDBOX_USER_IDS: '41, 7' });
  assert.strictEqual(await billing.fetchProActive(7), true, 'App Review and the operator can still test');
  assert.strictEqual(await billing.fetchProActive(8), false);
});

test('on the fallback path a sandbox event writes nothing unless the account is allowlisted', async () => {
  setEnv({ REVENUECAT_WEBHOOK_SECRET: ON.REVENUECAT_WEBHOOK_SECRET, REVENUECAT_SECRET_API_KEY: undefined, REVENUECAT_SANDBOX_USER_IDS: undefined });
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await call('/api/revenuecat', revenuecatRoutes, 'POST', '/api/revenuecat/webhook',
      { event: { type: 'INITIAL_PURCHASE', environment: 'SANDBOX', app_user_id: '7', entitlement_ids: ['pro'] } },
      { authorization: ON.REVENUECAT_WEBHOOK_SECRET });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ignored, 'sandbox');
    assert.ok(!calls.some((c) => c.text.includes('SET is_premium')));
  } finally { restore(); }
});
