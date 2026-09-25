'use strict';
// ---------------------------------------------------------------------------
// ROOST ON THE WEB: the rules that decide whether a venue is charged, and
// whether a venue that paid is served.
//
//   * checkout is OFF unless venue billing is on and Stripe, the Roost price
//     and the webhook secret all exist;
//   * an UNVERIFIED venue cannot buy (VENUE-BILLING.md: a role is not proof of
//     ownership), and Stripe is never called for one;
//   * a venue already holding a live comp, or a live Roost subscription,
//     cannot start a second, paid one;
//   * a session carries kind='venue' and flock_venue_user_id in BOTH the
//     session and the subscription metadata, NEVER app_user_id (RevenueCat
//     would attribute it as a consumer purchase), plus a 14-day card-required
//     trial only the first time;
//   * the webhook routes a venue event to the venue writer, never to
//     RevenueCat, and the Pro path is untouched;
//   * the writer grants only on a recognised Roost price, never with a NULL
//     end date, and revokes on a dead status;
//   * a confirm for another account's session is refused.
//
// Stripe is a fake installed in the require cache before anything loads it.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

// ---- the fake Stripe ------------------------------------------------------
const stripeCalls = [];
const stripeState = { subscriptions: [], sessions: {}, openSessions: [], subById: {}, keepCreatedOpen: false };
let createdSessions = 0;
function FakeStripe() {
  return {
    customers: {
      create: async (args, opts) => { stripeCalls.push(['customers.create', args, opts]); return { id: 'cus_VENUE1' }; },
      del: async (id) => { stripeCalls.push(['customers.del', id]); return { id, deleted: true }; },
    },
    subscriptions: {
      list: async (args) => { stripeCalls.push(['subscriptions.list', args]); return { data: stripeState.subscriptions }; },
      retrieve: async (id) => { stripeCalls.push(['subscriptions.retrieve', id]); return stripeState.subById[id]; },
    },
    prices: {
      retrieve: async (id) => ({ id, unit_amount: id === 'price_roost_year' ? 99000 : 9900, currency: 'usd', recurring: { interval: id === 'price_roost_year' ? 'year' : 'month' } }),
    },
    checkout: {
      sessions: {
        create: async (args) => {
          stripeCalls.push(['checkout.create', args]);
          // When a test asks, a new session stays open (payable) until it is
          // expired, the way a real one does.
          if (!stripeState.keepCreatedOpen) return { id: 'cs_test_v', url: 'https://checkout.stripe.com/c/pay/cs_test_v' };
          createdSessions += 1;
          const id = `cs_test_v${createdSessions}`;
          stripeState.openSessions.push({ id });
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
        retrieve: async (id) => stripeState.sessions[id] || null,
        list: async () => { stripeCalls.push(['checkout.list']); return { data: [...stripeState.openSessions] }; },
        expire: async (id) => {
          stripeCalls.push(['checkout.expire', id]);
          stripeState.openSessions = stripeState.openSessions.filter((s) => s.id !== id);
          return { id, status: 'expired' };
        },
      },
    },
    webhooks: {
      constructEvent: (raw, sig) => {
        if (sig !== 't=1,v1=good') throw new Error('No signatures found matching the expected signature');
        return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
      },
    },
    billingPortal: {
      sessions: { create: async (args) => { stripeCalls.push(['portal.create', args]); return { url: 'https://billing.stripe.com/p/session/v' }; } },
    },
  };
}
require.cache[require.resolve('stripe')] = { id: require.resolve('stripe'), filename: require.resolve('stripe'), loaded: true, exports: FakeStripe };

// RevenueCat must never be called for a venue event.
const rcCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.revenuecat.com/')) {
    rcCalls.push(String(url));
    return new Response('{}', { status: 200 });
  }
  return realFetch(url, init);
};

const pool = require('../config/database');
const ME = { id: 42, email: 'owner@example.com', name: 'Owner', role: 'venue_owner', is_banned: false, token_version: 0 };

function stubPool(handler) {
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const calls = [];
  const run = async (text, params) => {
    const sql = String(text);
    calls.push({ text: sql, params });
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [ME] };
    const r = await handler(sql, params);
    return r || { rows: [], rowCount: 0 };
  };
  pool.query = run;
  // The Roost writer takes a client of its own for the per-venue lock it reads
  // Stripe under (services/venueBilling.js syncVenueSubscription), and writes
  // on it. The transaction verbs and the lock answer nothing here; the write
  // goes to the same handler as everything else.
  pool.connect = async () => ({
    query: async (text, params) => {
      const sql = String(text);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/.test(sql) || sql.includes('pg_advisory_xact_lock')) {
        calls.push({ text: sql, params });
        return { rows: [], rowCount: 0 };
      }
      return run(text, params);
    },
    release: () => {},
  });
  return { calls, restore: () => { pool.query = realQuery; pool.connect = realConnect; } };
}

async function call(router, method, urlPath, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/venue-billing', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const token = jwt.sign({ userId: ME.id, tv: 0 }, process.env.JWT_SECRET);
  try {
    const res = await realFetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const ON = {
  VENUE_BILLING_ENABLED: 'true',
  ADMIN_USER_IDS: '1',
  // Fake values, assembled at runtime so nothing here looks like a real key.
  STRIPE_SECRET_KEY: ['sk', 'test', 'y'.repeat(24)].join('_'),
  STRIPE_WEBHOOK_SECRET: 'stripe-webhook-' + 'y'.repeat(24),
  STRIPE_PRICE_ROOST_MONTHLY: 'price_roost_month',
  STRIPE_PRICE_ROOST_YEARLY: 'price_roost_year',
  STRIPE_PRICE_ROOST_FOUNDING: undefined,
  STRIPE_PRICE_ROOST_LEGACY: undefined,
  STRIPE_AUTOMATIC_TAX: undefined,
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
const venueBilling = require('../services/venueBilling');
const venueBillingRoutes = require('../routes/venueBilling');
const stripeWebhookRoutes = require('../routes/stripeWebhook');

test.beforeEach(() => {
  stripeCalls.length = 0;
  rcCalls.length = 0;
  stripeState.subscriptions = [];
  stripeState.sessions = {};
  stripeState.openSessions = [];
  stripeState.subById = {};
  stripeState.keepCreatedOpen = false;
  createdSessions = 0;
  billing.__test.resetStripe();
});
test.afterEach(() => resetEnv());
test.after(() => { global.fetch = realFetch; });

// The venue profile and grant rows, answered the way the real queries shape them.
function venueDb({ verified = true, customer = null, grant = null, cachedTier = 'free', legacy = undefined, noticeUntil = null } = {}) {
  return async (sql) => {
    if (sql.includes('SELECT id, verified, business_name, stripe_customer_id FROM venue_profiles')) {
      return { rows: [{ id: 9, verified, business_name: 'The Owl', stripe_customer_id: customer }] };
    }
    if (sql.includes('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1')) {
      return { rows: [{ stripe_customer_id: customer }] };
    }
    if (sql.includes('SELECT verified, stripe_customer_id FROM venue_profiles')) {
      return { rows: [{ verified, stripe_customer_id: customer }] };
    }
    if (sql.startsWith('SELECT vp.tier, vs.tier AS grant_tier')) {
      return { rows: [{
        tier: cachedTier,
        ...(grant || { grant_tier: null }),
        ...(legacy === undefined ? {} : { roost_legacy: legacy, roost_notice_until: noticeUntil }),
      }] };
    }
    if (sql.includes('SELECT id, email, name FROM users')) return { rows: [{ id: ME.id, email: ME.email, name: ME.name }] };
    if (sql.includes('UPDATE venue_profiles SET stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_VENUE1' }] };
    return null;
  };
}

test('with nothing configured, venue checkout is off and says so without naming internals', async () => {
  setEnv(Object.fromEntries(Object.keys(ON).map((k) => [k, undefined])));
  const { restore } = stubPool(venueDb());
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.checkoutAvailable, false);
    assert.deepStrictEqual(status.body.plans, []);
    assert.ok(!JSON.stringify(status.body).includes('STRIPE'), 'env names are not for the client');
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, 'CHECKOUT_OFF');
    assert.strictEqual(stripeCalls.length, 0);
  } finally { restore(); }
});

test('each missing part is named, and the webhook secret is one of them', () => {
  setEnv({ ...ON, STRIPE_WEBHOOK_SECRET: undefined });
  assert.ok(venueBilling.checkoutState().missing.includes('STRIPE_WEBHOOK_SECRET'));
  setEnv({ ...ON, VENUE_BILLING_ENABLED: undefined });
  assert.ok(venueBilling.checkoutState().missing.includes('VENUE_BILLING_ENABLED'));
  setEnv({ ...ON, STRIPE_PRICE_ROOST_MONTHLY: undefined });
  assert.ok(venueBilling.checkoutState().missing.includes('STRIPE_PRICE_ROOST_MONTHLY'));
  setEnv(ON);
  assert.strictEqual(venueBilling.checkoutState().ready, true);
});

test('an unverified venue cannot buy Roost, and Stripe is never called for it', async () => {
  setEnv(ON);
  const { restore } = stubPool(venueDb({ verified: false }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'VENUE_NOT_VERIFIED');
    assert.strictEqual(stripeCalls.length, 0);
  } finally { restore(); }
});

test('a venue on a live comp is not walked into a second, paid plan', async () => {
  setEnv(ON);
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  const { restore } = stubPool(venueDb({
    cachedTier: 'pro',
    grant: { grant_tier: 'pro', grant_status: 'active', grant_source: 'comp', granted_reason: 'founding_comp', granted_at: null, expires_at: future },
  }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'PLAN_ALREADY_GRANTED');
    assert.strictEqual(stripeCalls.filter(([n]) => n === 'checkout.create').length, 0);
  } finally { restore(); }
});

test('a Roost session: venue metadata twice, never app_user_id, a first-time card-required trial, our return urls', async () => {
  setEnv(ON);
  const { restore } = stubPool(venueDb());
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'yearly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.url.startsWith('https://checkout.stripe.com/'));
    const [, args] = stripeCalls.find(([n]) => n === 'checkout.create');
    assert.strictEqual(args.mode, 'subscription');
    assert.strictEqual(args.customer, 'cus_VENUE1');
    assert.deepStrictEqual(args.line_items, [{ price: 'price_roost_year', quantity: 1 }]);
    for (const md of [args.metadata, args.subscription_data.metadata]) {
      assert.strictEqual(md.kind, 'venue');
      assert.strictEqual(md.flock_venue_user_id, String(ME.id));
      assert.ok(!('app_user_id' in md), 'RevenueCat attributes by app_user_id; a venue sale must not carry it');
    }
    // Nor the session's client_reference_id, which RevenueCat's Stripe
    // integration reads as the app user id in the same way. It was set to the
    // Flock user id here, so a Roost purchase could land on that person's
    // consumer record; the venue path reads the account from metadata alone.
    assert.ok(!('client_reference_id' in args), 'a Roost session carried the Flock user id where RevenueCat reads an app user id');
    assert.strictEqual(args.subscription_data.trial_period_days, 14);
    assert.strictEqual(args.subscription_data.trial_settings.end_behavior.missing_payment_method, 'cancel');
    assert.strictEqual(args.payment_method_collection, 'always');
    assert.strictEqual(args.consent_collection.terms_of_service, 'required');
    assert.match(args.custom_text.terms_of_service_acceptance.message, /free for 14 days, then renews at \$990\.00 every year until I cancel/);
    assert.match(args.success_url, /\/app\?venue_billing=success&session_id=\{CHECKOUT_SESSION_ID\}$/);
    const [, customerArgs] = stripeCalls.find(([n]) => n === 'customers.create');
    assert.ok(!('app_user_id' in customerArgs.metadata));
  } finally { restore(); }
});

test('a venue that has subscribed before gets no second trial; a live subscription blocks a second checkout', async () => {
  setEnv(ON);
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1' }));
  try {
    stripeState.subscriptions = [{ id: 'sub_old', status: 'canceled' }];
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200);
    const [, args] = stripeCalls.find(([n]) => n === 'checkout.create');
    assert.ok(!('trial_period_days' in args.subscription_data));
    stripeCalls.length = 0;
    stripeState.subscriptions = [{ id: 'sub_live', status: 'trialing' }];
    const again = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'ALREADY_SUBSCRIBED');
    assert.strictEqual(stripeCalls.filter(([n]) => n === 'checkout.create').length, 0);
  } finally { restore(); }
});

test('two Roost checkouts started at once are built one after the other, so only one can be paid', async () => {
  // THE RACE THIS PINS. Expiring the open sessions, checking for a live
  // subscription and creating a session are separate Stripe calls. Two
  // requests for one venue (a double click, two tabs) each expired what was
  // open and then each created a session, leaving two payable at once. Pro
  // queued its builds per account from the start; Roost now goes through the
  // same queue, so the second build expires the session the first one made.
  setEnv(ON);
  stripeState.keepCreatedOpen = true;
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1' }));
  try {
    const owner = { id: ME.id, email: ME.email, name: ME.name };
    await Promise.all([
      venueBilling.createVenueCheckout(owner, 'monthly'),
      venueBilling.createVenueCheckout(owner, 'monthly'),
    ]);
    const order = stripeCalls.map(([n]) => n).filter((n) => n === 'checkout.list' || n === 'checkout.create');
    assert.deepStrictEqual(order, ['checkout.list', 'checkout.create', 'checkout.list', 'checkout.create'],
      'the second build looked for open sessions before the first had made its own');
    assert.deepStrictEqual(stripeCalls.filter(([n]) => n === 'checkout.expire').map(([, id]) => id), ['cs_test_v1'],
      'the second build expired the session the first one made');
    assert.deepStrictEqual(stripeState.openSessions.map((s) => s.id), ['cs_test_v2'], 'exactly one session is left payable');
  } finally { restore(); }
});

function sub(overrides = {}) {
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    id: 'sub_V1',
    status: 'active',
    customer: 'cus_VENUE1',
    metadata: { kind: 'venue', flock_venue_user_id: String(ME.id) },
    items: { data: [{ price: { id: 'price_roost_month' }, current_period_end: periodEnd }] },
    cancel_at: null,
    trial_end: null,
    ...overrides,
  };
}

test('the grant: live statuses keep Roost with an end date, dead ones revoke, an unknown price grants nothing', () => {
  setEnv(ON);
  for (const status of ['active', 'trialing', 'past_due']) {
    const g = venueBilling.grantFromSubscription(sub({ status }));
    assert.strictEqual(g.live, true, status);
    assert.strictEqual(g.cachedTier, 'pro');
    assert.ok(g.expiresAt instanceof Date, 'a Stripe grant never has a NULL end date');
  }
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'something_new']) {
    const g = venueBilling.grantFromSubscription(sub({ status }));
    assert.strictEqual(g.live, false, status);
    assert.strictEqual(g.cachedTier, 'free');
  }
  const stray = venueBilling.grantFromSubscription(sub({ items: { data: [{ price: { id: 'price_someone_else' } }] } }));
  assert.strictEqual(stray.live, false);
  assert.strictEqual(stray.grantTier, 'free');
});

test('the writer is one statement: grant, cache and audit together, and a stale dead subscription cannot revoke a newer live one', () => {
  const sql = venueBilling.__test.SYNC_SQL;
  assert.match(sql, /INSERT INTO venue_subscriptions/);
  assert.match(sql, /UPDATE venue_profiles SET tier/);
  assert.match(sql, /INSERT INTO moderation_actions/);
  assert.match(sql, /'tier_changed'/);
  assert.match(sql, /\$12::text = 'free' OR old\.verified = true/, 'a paid tier needs a verified profile');
  assert.match(sql, /venue_subscriptions\.stripe_subscription_id = EXCLUDED\.stripe_subscription_id/);
  assert.match(sql, /venue_subscriptions\.status NOT IN \('active', 'trialing', 'past_due'\)/);
});

const stripeWebhook = async (event, sig = 't=1,v1=good') => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/stripe-webhook', stripeWebhookRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/stripe-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      body: JSON.stringify(event),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
};

test('a venue webhook event re-reads Stripe, writes the grant, and never reaches RevenueCat', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'trialing', trial_end: Math.floor(Date.now() / 1000) + 14 * 86400 });
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified: true }] };
    return null;
  });
  try {
    const res = await stripeWebhook({
      id: 'evt_1', type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', subscription: 'sub_V1', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id) } } },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(stripeCalls.some(([n, id]) => n === 'subscriptions.retrieve' && id === 'sub_V1'));
    const write = calls.find((c) => c.text.startsWith('WITH old AS'));
    assert.ok(write, 'the grant was written');
    assert.strictEqual(write.params[0], ME.id);
    assert.strictEqual(write.params[1], 'pro');
    assert.strictEqual(write.params[2], 'trialing');
    assert.ok(write.params[3] instanceof Date);
    assert.strictEqual(write.params[5], 'sub_V1');
    assert.strictEqual(write.params[10], true);
    assert.strictEqual(rcCalls.length, 0, 'RevenueCat is the Pro record, not the Roost one');
    // The write is on the transaction that holds this venue's lock, taken
    // before the read it writes (venueBillingWriter.test.js runs the race).
    const txn = calls.filter((c) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b|pg_advisory_xact_lock|^WITH old AS/.test(c.text));
    assert.deepStrictEqual(txn.map((c) => (c.text.startsWith('WITH') ? 'write' : c.text.includes('advisory') ? 'lock' : c.text.trim())),
      ['BEGIN', 'lock', 'write', 'COMMIT']);
    assert.deepStrictEqual(txn[1].params, [venueBilling.__test.SYNC_LOCK_NAMESPACE, ME.id]);
    assert.strictEqual(stripeCalls.filter(([n, id]) => n === 'subscriptions.retrieve' && id === 'sub_V1').length, 2,
      'one read to find the venue, one under its lock');
  } finally { restore(); }
});

test('a venue subscription deleted event revokes', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'canceled' });
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified: true }] };
    return null;
  });
  try {
    const res = await stripeWebhook({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: sub({ status: 'canceled' }) } });
    assert.strictEqual(res.status, 200);
    const write = calls.find((c) => c.text.startsWith('WITH old AS'));
    assert.strictEqual(write.params[2], 'canceled');
    assert.strictEqual(write.params[10], false);
    assert.strictEqual(write.params[11], 'free');
  } finally { restore(); }
});

test('a live subscription on a price we do not recognise keeps Roost through the period Stripe is billing', async () => {
  // THE BUG THIS PINS, twice over. A subscription Stripe was still charging,
  // on a price id missing from STRIPE_PRICE_ROOST_* (a new Price made in the
  // dashboard, a typo, the founding price left unset, a price rise with the
  // old id not moved to the legacy list), was first written as tier free with
  // expires_at now. Then it was left unwritten with a 500, which kept the
  // PREVIOUS period's end date, so the venue still lost Roost three days after
  // it while Stripe billed the new period, and a webhook failing for days can
  // get the endpoint disabled. Now the billed period is written as Roost.
  setEnv(ON);
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  stripeState.subById.sub_V1 = sub({ status: 'active', items: { data: [{ price: { id: 'price_made_in_the_dashboard' }, current_period_end: periodEnd }] } });
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified: true }] };
    return null;
  });
  try {
    const res = await stripeWebhook({ id: 'evt_p1', type: 'customer.subscription.updated', data: { object: stripeState.subById.sub_V1 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const write = calls.find((c) => c.text.startsWith('WITH old AS'));
    assert.ok(write, 'the billed period was written');
    assert.strictEqual(write.params[1], 'pro', 'the grant is Roost');
    assert.strictEqual(write.params[6], 'price_made_in_the_dashboard', 'the unknown price is recorded as it is');
    assert.strictEqual(write.params[10], true, 'live');
    assert.strictEqual(write.params[11], 'pro');
    assert.strictEqual(write.params[3].getTime(), periodEnd * 1000 + venueBilling.__test.GRACE_MS,
      'Roost runs to the end of the period Stripe is billing, plus the usual grace');
  } finally { restore(); }
});

test('the unknown-price rule is only for a live subscription: called plainly, an unknown price still grants nothing', () => {
  setEnv(ON);
  const stray = venueBilling.grantFromSubscription(sub({ items: { data: [{ price: { id: 'price_someone_else' } }] } }));
  assert.strictEqual(stray.priceOk, false);
  const kept = venueBilling.grantFromSubscription(sub({ items: { data: [{ price: { id: 'price_someone_else' } }] } }), Date.now(), { unknownPriceIsRoost: true });
  assert.strictEqual(kept.live, true);
  const empty = venueBilling.grantFromSubscription(sub({ items: { data: [] } }), Date.now(), { unknownPriceIsRoost: true });
  assert.strictEqual(empty.live, false, 'a subscription with no price at all is never Roost');
});

test('a price moved to STRIPE_PRICE_ROOST_LEGACY keeps Roost for the venues still billed on it', async () => {
  // A price rise replaces STRIPE_PRICE_ROOST_MONTHLY. Venues on the old price
  // keep paying it until they are moved (Terms 9.6: 30 days' notice first), so
  // their renewals must still read as Roost, not be refused as unknown.
  setEnv({ ...ON, STRIPE_PRICE_ROOST_MONTHLY: 'price_roost_month_v2', STRIPE_PRICE_ROOST_LEGACY: ' price_roost_month , price_roost_2025 ,' });
  assert.deepStrictEqual(venueBilling.legacyRoostPrices(), ['price_roost_month', 'price_roost_2025']);
  const kept = venueBilling.grantFromSubscription(sub({ status: 'active' }));
  assert.strictEqual(kept.live, true);
  assert.strictEqual(kept.cachedTier, 'pro');
  const stray = venueBilling.grantFromSubscription(sub({ items: { data: [{ price: { id: 'price_someone_else' } }] } }));
  assert.strictEqual(stray.live, false, 'the legacy list is not a wildcard');

  stripeState.subById.sub_V1 = sub({ status: 'active' });
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified: true }] };
    return null;
  });
  try {
    const res = await stripeWebhook({ id: 'evt_p3', type: 'customer.subscription.updated', data: { object: stripeState.subById.sub_V1 } });
    assert.strictEqual(res.status, 200, `the renewal on the old price was refused: ${JSON.stringify(res.body)}`);
    const write = calls.find((c) => c.text.startsWith('WITH old AS'));
    assert.ok(write, 'the renewal was written');
    assert.strictEqual(write.params[6], 'price_roost_month');
    assert.strictEqual(write.params[10], true, 'the renewal on the old price keeps the grant live');
    assert.strictEqual(write.params[11], 'pro');
  } finally { restore(); }
});

test('a subscription that has ended on an unrecognised price still revokes', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'canceled', items: { data: [{ price: { id: 'price_made_in_the_dashboard' } }] } });
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified: true }] };
    return null;
  });
  try {
    const res = await stripeWebhook({ id: 'evt_p2', type: 'customer.subscription.deleted', data: { object: stripeState.subById.sub_V1 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const write = calls.find((c) => c.text.startsWith('WITH old AS'));
    assert.ok(write, 'a dead subscription must still be written');
    assert.strictEqual(write.params[2], 'canceled');
    assert.strictEqual(write.params[10], false);
    assert.strictEqual(write.params[11], 'free');
  } finally { restore(); }
});

test('a bad signature is refused before a venue event is read', async () => {
  setEnv(ON);
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await stripeWebhook({ type: 'customer.subscription.updated', data: { object: sub() } }, 't=1,v1=bad');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(stripeCalls.length, 0);
  } finally { restore(); }
});

test('a failed venue write answers 500 so Stripe retries', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub();
  const { restore } = stubPool(async (sql) => {
    if (sql.startsWith('WITH old AS')) throw new Error('db down');
    return null;
  });
  try {
    const res = await stripeWebhook({ type: 'customer.subscription.updated', data: { object: sub() } });
    assert.strictEqual(res.status, 500);
  } finally { restore(); }
});

test('a confirm for another account\'s session is refused', async () => {
  setEnv(ON);
  stripeState.sessions.cs_test_other = { id: 'cs_test_other', status: 'complete', subscription: 'sub_X', metadata: { kind: 'venue', flock_venue_user_id: '999' } };
  const { restore } = stubPool(venueDb());
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/confirm', { sessionId: 'cs_test_other' });
    assert.strictEqual(res.status, 404);
    assert.ok(!stripeCalls.some(([n]) => n === 'subscriptions.retrieve'));
  } finally { restore(); }
});

test('a Pro session (no kind) never reaches the venue writer', async () => {
  setEnv(ON);
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await stripeWebhook({
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', subscription: 'sub_P', metadata: { app_user_id: '5' } } },
    });
    // The Pro path answers however it answers; the point is that no venue grant was written.
    assert.ok([200, 500, 503].includes(res.status));
    assert.ok(!calls.some((c) => c.text.startsWith('WITH old AS')));
  } finally { restore(); }
});

test('the portal returns to the venue dashboard, and a venue with no customer gets a plain 404', async () => {
  setEnv(ON);
  let db = stubPool(venueDb({ customer: 'cus_VENUE1' }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/portal');
    assert.strictEqual(res.status, 200);
    const [, args] = stripeCalls.find(([n]) => n === 'portal.create');
    assert.strictEqual(args.customer, 'cus_VENUE1');
    assert.match(args.return_url, /\/app\?venue_billing=manage$/);
  } finally { db.restore(); }
  db = stubPool(venueDb());
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/portal');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'NO_WEB_SUBSCRIPTION');
  } finally { db.restore(); }
});

// ---- the notice floor (Terms 9.6): a venue account from before Roost had a
// price is never charged before the date its notice named ----------------

const roostNotice = require('../services/roostNotice');
const DAY = 864e5;

function sessionArgs() {
  const found = stripeCalls.find(([n]) => n === 'checkout.create');
  return found ? found[1] : null;
}

test('inside the window with the notice sent: the first charge is the date it named, not the end of a 14-day trial', async () => {
  setEnv(ON);
  const named = new Date(Date.now() + 20 * DAY);
  const { restore } = stubPool(venueDb({ legacy: true, noticeUntil: named.toISOString() }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const args = sessionArgs();
    assert.ok(!('trial_period_days' in args.subscription_data), 'a date, not a length');
    assert.strictEqual(args.subscription_data.trial_end, Math.ceil(named.getTime() / 1000));
    assert.strictEqual(args.subscription_data.trial_settings.end_behavior.missing_payment_method, 'cancel');
    assert.strictEqual(args.payment_method_collection, 'always');
    const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(named);
    assert.match(args.custom_text.terms_of_service_acceptance.message, new RegExp(`is free until ${date}, then renews at \\$99\\.00 every month until I cancel`));
  } finally { restore(); }
});

test('inside the window, a 14-day trial that ends later than the named date wins', async () => {
  setEnv(ON);
  const named = new Date(Date.now() + 5 * DAY);
  const { restore } = stubPool(venueDb({ legacy: true, noticeUntil: named.toISOString() }));
  try {
    const before = Date.now();
    await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    const end = sessionArgs().subscription_data.trial_end * 1000;
    assert.ok(end >= before + 14 * DAY && end <= Date.now() + 14 * DAY + 2000, 'the later of the two');
  } finally { restore(); }
});

test('inside the window, a venue that already had its trial still is not charged before the named date', async () => {
  setEnv(ON);
  stripeState.subscriptions = [{ id: 'sub_old', status: 'canceled', metadata: { kind: 'venue' } }];
  const named = new Date(Date.now() + 12 * DAY);
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', legacy: true, noticeUntil: named.toISOString() }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(sessionArgs().subscription_data.trial_end, Math.ceil(named.getTime() / 1000));
  } finally { restore(); }
});

test('a named date under 48 hours away is moved just past what Stripe accepts, never earlier', async () => {
  setEnv(ON);
  stripeState.subscriptions = [{ id: 'sub_old', status: 'canceled', metadata: { kind: 'venue' } }];
  const named = new Date(Date.now() + 3600e3);
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', legacy: true, noticeUntil: named.toISOString() }));
  try {
    const before = Date.now();
    await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    const end = sessionArgs().subscription_data.trial_end * 1000;
    assert.ok(end >= before + venueBilling.__test.STRIPE_MIN_TRIAL_MS - 1000);
    assert.ok(end > named.getTime());
  } finally { restore(); }
});

test('inside the window with no notice yet: checkout sends it first and charges no earlier than the date it names', async () => {
  setEnv(ON);
  const real = roostNotice.sendNoticeForCheckout;
  const named = new Date(Date.now() + 30 * DAY);
  const asked = [];
  roostNotice.sendNoticeForCheckout = async (userId) => { asked.push(userId); return named; };
  const { restore } = stubPool(venueDb({ legacy: true, noticeUntil: null }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(asked, [ME.id]);
    assert.strictEqual(sessionArgs().subscription_data.trial_end, Math.ceil(named.getTime() / 1000));
  } finally { restore(); roostNotice.sendNoticeForCheckout = real; }
});

test('inside the window when the notice cannot be sent: the first charge is at least 30 days from now', async () => {
  setEnv(ON);
  const real = roostNotice.sendNoticeForCheckout;
  roostNotice.sendNoticeForCheckout = async () => null;
  const { restore } = stubPool(venueDb({ legacy: true, noticeUntil: null }));
  try {
    const before = Date.now();
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(sessionArgs().subscription_data.trial_end * 1000 >= before + 30 * DAY - 1000);
  } finally { restore(); roostNotice.sendNoticeForCheckout = real; }
});

test('a venue served everything by its window can still buy; a comp still cannot', async () => {
  setEnv(ON);
  const { restore } = stubPool(venueDb({ legacy: true, noticeUntil: new Date(Date.now() + 10 * DAY).toISOString() }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.tier, 'pro', 'served everything inside the window');
    assert.strictEqual(status.body.inNoticeWindow, true);
    assert.ok(Date.parse(status.body.freeUntil) >= Date.now() + 14 * DAY - 2000, 'the later of the date and a trial');
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'yearly' });
    assert.strictEqual(res.status, 200, 'the window is not a grant, so it does not block buying the plan');
  } finally { restore(); }
});

test('a venue created after the price took effect gets the ordinary 14-day trial and no window', async () => {
  setEnv(ON);
  const { restore } = stubPool(venueDb({ legacy: false }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.body.inNoticeWindow, false);
    assert.strictEqual(status.body.freeUntil, null);
    await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    const args = sessionArgs();
    assert.strictEqual(args.subscription_data.trial_period_days, 14);
    assert.ok(!('trial_end' in args.subscription_data));
  } finally { restore(); }
});
