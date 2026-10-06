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
// charges / refunds / invoicePayments / invoices: the money side, for the
// refund tests. A charge is paid through a PaymentIntent, which names the
// invoice it paid, which names its subscription (Stripe API 2025-03-31 basil
// and later).
const stripeState = { subscriptions: [], sessions: {}, openSessions: [], subById: {}, keepCreatedOpen: false, charges: {}, refunds: {}, invoicePayments: {}, invoices: {}, paidWith: {} };
let createdSessions = 0;
function FakeStripe() {
  return {
    customers: {
      create: async (args, opts) => { stripeCalls.push(['customers.create', args, opts]); return { id: 'cus_VENUE1' }; },
      del: async (id) => { stripeCalls.push(['customers.del', id]); return { id, deleted: true }; },
      retrieve: async (id) => { stripeCalls.push(['customers.retrieve', id]); return { id }; },
    },
    subscriptions: {
      // One page at a time, the way Stripe answers: `limit` (ten when none is
      // asked for) after `starting_after`, with has_more. A subscription that
      // names a customer is listed for that customer only.
      list: async (args) => {
        stripeCalls.push(['subscriptions.list', args]);
        const all = stripeState.subscriptions.filter((s) => !s.customer || s.customer === args.customer);
        const limit = args.limit || 10;
        const start = args.starting_after ? all.findIndex((s) => s.id === args.starting_after) + 1 : 0;
        return { data: all.slice(start, start + limit), has_more: start + limit < all.length };
      },
      retrieve: async (id) => { stripeCalls.push(['subscriptions.retrieve', id]); return stripeState.subById[id]; },
      cancel: async (id, params, opts) => {
        stripeCalls.push(['subscriptions.cancel', id, opts]);
        if (stripeState.subById[id]) stripeState.subById[id] = { ...stripeState.subById[id], status: 'canceled' };
        return { id, status: 'canceled' };
      },
    },
    charges: {
      retrieve: async (id) => { stripeCalls.push(['charges.retrieve', id]); return stripeState.charges[id] || null; },
    },
    refunds: {
      list: async (args) => { stripeCalls.push(['refunds.list', args]); return { data: stripeState.refunds[args.charge] || [], has_more: false }; },
      create: async (args, opts) => { stripeCalls.push(['refunds.create', args, opts]); return { id: 're_made', status: 'succeeded' }; },
    },
    invoicePayments: {
      // By PaymentIntent (which invoices a charge paid), or by invoice (how an
      // invoice was paid: stripeState.paidWith maps an invoice to the
      // PaymentIntent that paid it).
      list: async (args) => {
        if (args.invoice) {
          const pi = stripeState.paidWith[args.invoice];
          return { data: pi ? [{ id: `inpay_${args.invoice}`, invoice: args.invoice, status: 'paid', payment: { type: 'payment_intent', payment_intent: pi } }] : [], has_more: false };
        }
        return {
          data: (stripeState.invoicePayments[args.payment.payment_intent] || []).map((invoice, i) => ({ id: `inpay_${i}`, invoice, status: 'paid' })),
          has_more: false,
        };
      },
    },
    invoices: {
      retrieve: async (id) => stripeState.invoices[id] || null,
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
  stripeState.charges = {};
  stripeState.refunds = {};
  stripeState.invoicePayments = {};
  stripeState.invoices = {};
  stripeState.paidWith = {};
  createdSessions = 0;
  billing.__test.resetStripe();
});
test.afterEach(() => resetEnv());
test.after(() => { global.fetch = realFetch; });

// The listing this venue's claim names.
const PLACE = 'ChIJvenueWebCheckout001';

// The venue profile and grant rows, answered the way the real queries shape them.
// trialUsed: the account, or the venue under any account, already has a Roost
// subscription on record (venue_stripe_subscriptions, migration 119).
// recorded: other Stripe customers a Roost subscription of this account was
// recorded on (venue_subscriptions, venue_stripe_subscriptions), as a plan sold
// by hand on a customer of its own is.
function venueDb({ verified = true, customer = null, grant = null, cachedTier = 'free', legacy = undefined, noticeUntil = null, placeId = PLACE, trialUsed = false, recorded = [] } = {}) {
  return async (sql) => {
    if (sql.includes('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1') && sql.includes('UNION ALL')) {
      return { rows: [customer, ...recorded].filter(Boolean).map((c) => ({ stripe_customer_id: c })) };
    }
    if (sql.includes('SELECT id, verified, business_name, stripe_customer_id') && sql.includes('FROM venue_profiles')) {
      return { rows: [{ id: 9, verified, business_name: 'The Owl', stripe_customer_id: customer, google_place_id: placeId }] };
    }
    if (sql.includes('FROM venue_stripe_subscriptions') && sql.includes('AS used')) {
      return { rows: [{ used: trialUsed }] };
    }
    if (sql.includes('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1')) {
      return { rows: [{ stripe_customer_id: customer }] };
    }
    if (sql.includes('SELECT verified, stripe_customer_id') && sql.includes('FROM venue_profiles')) {
      return { rows: [{ verified, stripe_customer_id: customer, google_place_id: placeId }] };
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

test('a Roost session names the venue it is bought for, not only the account', async () => {
  // The metadata named the account alone, so a subscription bought for one
  // venue followed the claim to whichever venue it named next.
  setEnv(ON);
  const { restore } = stubPool(venueDb());
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const [, args] = stripeCalls.find(([n]) => n === 'checkout.create');
    for (const md of [args.metadata, args.subscription_data.metadata]) {
      assert.strictEqual(md.flock_venue_place_id, PLACE, 'the subscription does not say which venue it pays for');
      assert.strictEqual(md.flock_venue_profile_id, '9');
    }
  } finally { restore(); }
});

test('a verified claim with no Google listing cannot buy Roost: there is no venue to bind it to', async () => {
  setEnv(ON);
  const { restore } = stubPool(venueDb({ placeId: null }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'NO_LISTING');
    assert.ok(!stripeCalls.some(([n]) => n === 'checkout.create' || n === 'customers.create'));
  } finally { restore(); }
});

test('one trial per venue: a venue with a Roost subscription on record starts without one, on a brand new customer too', async () => {
  // The trial asked only the CURRENT Stripe customer whether it had ever
  // subscribed. A venue on a new customer (another account claiming it, or
  // the same account after its customer was deleted) was handed a second 14
  // days. Terms 9.6: 14 days free, once per venue.
  setEnv(ON);
  const { restore } = stubPool(venueDb({ trialUsed: true }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const [, args] = stripeCalls.find(([n]) => n === 'checkout.create');
    assert.ok(!('trial_period_days' in args.subscription_data), 'a venue that had its trial was given another');
    assert.ok(!('trial_end' in args.subscription_data));
    assert.doesNotMatch(args.custom_text.terms_of_service_acceptance.message, /free for 14 days/);
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.body.trialDays, 0, 'the plans offered a trial checkout would not give');
  } finally { restore(); }
});

// ---- after a plan ends, the venue can buy again ----------------------------
//
// canManage was true for any customer that had EVER had a subscription, and
// the plans control then showed Manage billing alone. Stripe's portal cannot
// start a new subscription, so a venue that cancelled and came back had no
// way to buy. Manage billing is for a plan that is still running.

const roostSub = (id, status, created) => ({ id, status, created, customer: 'cus_VENUE1', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id) } });

test('a venue whose plan has ended is offered the plans again, without a second trial', async () => {
  setEnv(ON);
  stripeState.subscriptions = [roostSub('sub_ended', 'canceled', 1700000000)];
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.status, 200, JSON.stringify(status.body));
    assert.strictEqual(status.body.canManage, false, 'a venue whose plan ended was shown only Manage billing, which cannot sell it a new one');
    assert.strictEqual(status.body.checkoutAvailable, true);
    assert.deepStrictEqual(status.body.plans.map((p) => p.id), ['monthly', 'yearly']);
    assert.strictEqual(status.body.trialDays, 0, 'the trial was used once already');
    // And checkout lets it buy.
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'yearly' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  } finally { restore(); }
});

test('Manage billing is for a plan still running: active, trialing, past due or unpaid', async () => {
  setEnv(ON);
  for (const live of ['active', 'trialing', 'past_due', 'unpaid']) {
    // The newest subscription decides, whatever is older on the customer.
    stripeState.subscriptions = [roostSub('sub_old_one', 'canceled', 1600000000), roostSub('sub_now', live, 1700000000)];
    const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
    try {
      const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
      assert.strictEqual(status.body.canManage, true, `a ${live} plan was not offered Manage billing`);
      assert.strictEqual(status.body.trialDays, 0);
    } finally { restore(); }
  }
  // A plan still billing keeps Manage billing even when a newer checkout was
  // started and abandoned after it: checkout would refuse that venue as
  // already subscribed, so the plans alone would be a dead end.
  stripeState.subscriptions = [roostSub('sub_first', 'active', 1600000000), roostSub('sub_latest', 'incomplete_expired', 1700000000)];
  let db = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.body.canManage, true, 'a plan Stripe is still billing was hidden behind an abandoned newer checkout');
    assert.strictEqual(status.body.subscriptionStatus, 'active');
  } finally { db.restore(); }
  // Nothing billing at all: the plans.
  stripeState.subscriptions = [roostSub('sub_first', 'canceled', 1600000000), roostSub('sub_latest', 'incomplete_expired', 1700000000)];
  db = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.body.canManage, false);
    assert.strictEqual(status.body.subscriptionStatus, null);
  } finally { db.restore(); }
});

// ---- every page of the customer's subscriptions is read ---------------------
//
// The status route and checkout read one page of ten subscriptions, so a plan
// still billing behind ten newer ones that ended (a failed payment leaves one
// each) was invisible: Manage billing was hidden, and checkout sold a second
// plan on top of the first.

function behindManyEnded(live) {
  const ended = Array.from({ length: 119 }, (_, i) => roostSub(`sub_ended_${i}`, 'incomplete_expired', 1700000000 - i));
  return [...ended, roostSub('sub_running', live, 1600000000)];
}

test('a plan still billing behind a hundred that ended keeps Manage billing', async () => {
  setEnv(ON);
  stripeState.subscriptions = behindManyEnded('active');
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.status, 200, JSON.stringify(status.body));
    assert.strictEqual(status.body.canManage, true, 'a plan Stripe is billing was hidden past the first page');
    assert.strictEqual(status.body.subscriptionStatus, 'active');
  } finally { restore(); }
});

test('checkout sees a live plan past the first page and does not sell a second one', async () => {
  setEnv(ON);
  stripeState.subscriptions = behindManyEnded('past_due');
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409, `a second plan was sold over one still billing: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'ALREADY_SUBSCRIBED');
    assert.ok(!stripeCalls.some(([n]) => n === 'checkout.create'));
  } finally { restore(); }
});

// ---- checkout asks every customer a plan of the account is on record with ---

test('a hand-sold plan still billing on a customer of its own blocks a second checkout, whatever the grant says', async () => {
  // Past due beyond the grant's grace, so the grant reads free. Checkout asked
  // only the customer it makes sessions on, sold a second plan, and Stripe went
  // on retrying the first: one venue billed twice.
  setEnv(ON);
  stripeState.subscriptions = [{ ...roostSub('sub_hand_sold', 'past_due', 1700000000), customer: 'cus_HAND_SOLD' }];
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', recorded: ['cus_HAND_SOLD'], trialUsed: true }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409, `a second plan was sold over a hand-sold one still billing: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'ALREADY_SUBSCRIBED');
    assert.ok(!stripeCalls.some(([n]) => n === 'checkout.create'));
    // And the plans card offers the way to it.
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.body.canManage, true);
  } finally { restore(); }
});

test('another venue\'s plan, or a Flock Pro plan, on the same customer does not block a Roost checkout', async () => {
  setEnv(ON);
  stripeState.subscriptions = [
    { id: 'sub_other_venue', status: 'active', created: 1700000000, customer: 'cus_VENUE1', metadata: { kind: 'venue', flock_venue_user_id: '777' } },
    { id: 'sub_pro', status: 'active', created: 1700000001, customer: 'cus_VENUE1', metadata: { app_user_id: String(ME.id) } },
  ];
  const { restore } = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 200, `a plan that is not this venue's Roost blocked its checkout: ${JSON.stringify(res.body)}`);
  } finally { restore(); }
});

// ---- the dates the plans card names come from Stripe -----------------------

test('the status names the trial\'s charge date, the renewal date and a scheduled end', async () => {
  setEnv(ON);
  const trialEnds = Math.floor(Date.now() / 1000) + 9 * 86400;
  stripeState.subscriptions = [{
    ...roostSub('sub_dated', 'trialing', 1700000000),
    trial_end: trialEnds, cancel_at: null, cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_roost_month' }, current_period_end: trialEnds }] },
  }];
  let db = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.status, 200, JSON.stringify(status.body));
    assert.strictEqual(status.body.subscriptionStatus, 'trialing');
    assert.strictEqual(status.body.trialEnd, new Date(trialEnds * 1000).toISOString(), 'the status does not say when the trial is charged');
    assert.strictEqual(status.body.currentPeriodEnd, new Date(trialEnds * 1000).toISOString());
    assert.strictEqual(status.body.cancelAt, null);
  } finally { db.restore(); }

  // Set to end at the period end: the end date is the period end.
  const periodEnds = Math.floor(Date.now() / 1000) + 25 * 86400;
  stripeState.subscriptions = [{
    ...roostSub('sub_dated', 'active', 1700000000),
    trial_end: null, cancel_at: null, cancel_at_period_end: true,
    items: { data: [{ price: { id: 'price_roost_month' }, current_period_end: periodEnds }] },
  }];
  db = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.body.subscriptionStatus, 'active');
    assert.strictEqual(status.body.trialEnd, null);
    assert.strictEqual(status.body.cancelAt, new Date(periodEnds * 1000).toISOString());
  } finally { db.restore(); }

  // Nothing running: no dates at all.
  stripeState.subscriptions = [roostSub('sub_dated', 'canceled', 1700000000)];
  db = stubPool(venueDb({ customer: 'cus_VENUE1', trialUsed: true }));
  try {
    const status = await call(venueBillingRoutes, 'GET', '/api/venue-billing/status');
    assert.strictEqual(status.body.subscriptionStatus, null);
    assert.strictEqual(status.body.trialEnd, null);
    assert.strictEqual(status.body.currentPeriodEnd, null);
    assert.strictEqual(status.body.cancelAt, null);
  } finally { db.restore(); }
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

// The claim a completed checkout is checked against before it is fulfilled.
const verifiedClaim = (sql) => (sql.includes('SELECT id, verified, business_name, stripe_customer_id') && sql.includes('FROM venue_profiles')
  ? { rows: [{ id: 9, verified: true, business_name: 'The Owl', stripe_customer_id: 'cus_VENUE1', google_place_id: PLACE }] }
  : null);

test('a venue webhook event re-reads Stripe, writes the grant, and never reaches RevenueCat', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'trialing', trial_end: Math.floor(Date.now() / 1000) + 14 * 86400 });
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified: true }] };
    return verifiedClaim(sql);
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

// ---- a purchase completed against a claim that is no longer good ----------
//
// The claim was checked when the session was made and never again, so a
// checkout paid after the claim was revoked (or re-pointed at another listing)
// started a plan the dashboard would refuse to serve, and Stripe billed it.
// Fulfillment now checks the claim again, and a purchase against a claim that
// is not verified for the listing it was bought for is cancelled and its
// payment refunded.

function completedSession({ id = 'cs_done_1', paid = true, place = PLACE } = {}) {
  return {
    id, object: 'checkout.session', mode: 'subscription', status: 'complete',
    subscription: 'sub_V1', invoice: 'in_first', payment_status: paid ? 'paid' : 'no_payment_required',
    metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: place },
  };
}

function claimNow({ verified, place = PLACE }) {
  return async (sql) => {
    if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified, place_id: place }] };
    if (sql.includes('SELECT id, verified, business_name, stripe_customer_id') && sql.includes('FROM venue_profiles')) {
      return { rows: [{ id: 9, verified, business_name: 'The Owl', stripe_customer_id: 'cus_VENUE1', google_place_id: place }] };
    }
    return null;
  };
}

test('a checkout paid after the claim was revoked is cancelled and refunded, not fulfilled', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'active', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: PLACE } });
  stripeState.paidWith.in_first = 'pi_first';
  const { calls, restore } = stubPool(claimNow({ verified: false }));
  try {
    const res = await stripeWebhook({ id: 'evt_rev', type: 'checkout.session.completed', data: { object: completedSession() } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const cancelled = stripeCalls.filter(([n]) => n === 'subscriptions.cancel');
    assert.deepStrictEqual(cancelled.map(([, id, opts]) => [id, opts]), [['sub_V1', { idempotencyKey: 'flock-claim-revoked-cancel-sub_V1' }]],
      'a purchase against a revoked claim was fulfilled and left billing');
    const refunded = stripeCalls.filter(([n]) => n === 'refunds.create');
    assert.strictEqual(refunded.length, 1, 'the payment taken for a purchase we refused was kept');
    assert.strictEqual(refunded[0][1].payment_intent, 'pi_first');
    assert.deepStrictEqual(refunded[0][2], { idempotencyKey: 'flock-claim-revoked-refund-in_first' });
    const write = calls.find((c) => c.text.startsWith('WITH old AS'));
    assert.ok(write, 'the cancelled subscription was not written');
    assert.strictEqual(write.params[10], false, 'the refused purchase was written live');
  } finally { restore(); }
});

test('a checkout paid after the claim moved to another listing is refused the same way', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'active', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: PLACE } });
  stripeState.paidWith.in_first = 'pi_first';
  const { restore } = stubPool(claimNow({ verified: true, place: 'ChIJsomewhereElse00001' }));
  try {
    const res = await stripeWebhook({ id: 'evt_moved', type: 'checkout.session.completed', data: { object: completedSession() } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(stripeCalls.filter(([n]) => n === 'subscriptions.cancel').map(([, id]) => id), ['sub_V1']);
  } finally { restore(); }
});

test('a trial bought against a revoked claim is cancelled with nothing to refund', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'trialing', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: PLACE } });
  const { restore } = stubPool(claimNow({ verified: false }));
  try {
    const res = await stripeWebhook({ id: 'evt_rev_trial', type: 'checkout.session.completed', data: { object: completedSession({ paid: false }) } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(stripeCalls.filter(([n]) => n === 'subscriptions.cancel').map(([, id]) => id), ['sub_V1']);
    assert.ok(!stripeCalls.some(([n]) => n === 'refunds.create'), 'a trial took no money, so there is none to give back');
  } finally { restore(); }
});

test('the return from Stripe checks the claim too: a confirm against a revoked claim cancels, and says Roost is not on', async () => {
  setEnv(ON);
  stripeState.sessions.cs_done_1 = completedSession();
  stripeState.subById.sub_V1 = sub({ status: 'trialing', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: PLACE } });
  const { restore } = stubPool(claimNow({ verified: false }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/confirm', { sessionId: 'cs_done_1' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.tier, null, 'the owner was told Roost is on for a purchase that was refused');
    assert.strictEqual(res.body.refused, 'CLAIM_NOT_VERIFIED', 'the return cannot say why nothing was bought');
    assert.deepStrictEqual(stripeCalls.filter(([n]) => n === 'subscriptions.cancel').map(([, id]) => id), ['sub_V1']);
  } finally { restore(); }
});

// A completed session can be handed back at any time: the old success link,
// a confirm sent by hand, Stripe resending the event. A purchase that was
// already delivered, or whose account is gone, is written from Stripe and
// never refused or refunded over the claim as it is now.
test('the return for a purchase already delivered refunds nothing, whatever the claim says now', async () => {
  setEnv(ON);
  stripeState.sessions.cs_done_1 = completedSession();
  stripeState.subById.sub_V1 = sub({ status: 'active', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: PLACE } });
  stripeState.paidWith.in_first = 'pi_first';
  const moved = claimNow({ verified: true, place: 'ChIJsomewhereElse00001' });
  const { restore } = stubPool(async (sql, params) => {
    if (sql.includes('SELECT served_at FROM venue_stripe_subscriptions')) return { rows: [{ served_at: new Date('2026-06-01T00:00:00Z') }] };
    return moved(sql, params);
  });
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/confirm', { sessionId: 'cs_done_1' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(!res.body.refused, 'a delivered purchase was refused on its return');
    assert.ok(!stripeCalls.some(([n]) => n === 'subscriptions.cancel'), 'a delivered plan was cancelled');
    assert.ok(!stripeCalls.some(([n]) => n === 'refunds.create'), 'a delivered plan was refunded');
  } finally { restore(); }
});

test('a checkout handed back after its account was deleted is neither cancelled nor refunded', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'canceled', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: PLACE } });
  stripeState.paidWith.in_first = 'pi_first';
  // No venue profile: the deletion took it.
  const { restore } = stubPool(async (sql) => (sql.startsWith('WITH old AS') ? { rows: [{ profiles: 0, written: 0 }] } : null));
  try {
    const res = await stripeWebhook({ id: 'evt_gone', type: 'checkout.session.completed', data: { object: completedSession() } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(!stripeCalls.some(([n]) => n === 'refunds.create'), 'a deleted account\'s first payment was refunded on a replay');
    assert.ok(!stripeCalls.some(([n]) => n === 'subscriptions.cancel'));
  } finally { restore(); }
});

test('a checkout completed on a claim still verified for its listing is fulfilled as before', async () => {
  setEnv(ON);
  stripeState.subById.sub_V1 = sub({ status: 'trialing', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id), flock_venue_place_id: PLACE } });
  const { calls, restore } = stubPool(claimNow({ verified: true }));
  try {
    const res = await stripeWebhook({ id: 'evt_ok', type: 'checkout.session.completed', data: { object: completedSession({ paid: false }) } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(!stripeCalls.some(([n]) => n === 'subscriptions.cancel' || n === 'refunds.create'));
    const write = calls.find((c) => c.text.startsWith('WITH old AS'));
    assert.strictEqual(write.params[10], true);
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

// A refund event names a charge, not a subscription, and carries no venue
// metadata, so it never reached the venue branch: the webhook answered
// "ignored" and the refunded subscription kept its year of Roost.
function refundedInFull(subId, { amount = 99000, refunded = amount } = {}) {
  stripeState.subById[subId] = sub({ id: subId, status: 'active', latest_invoice: `in_${subId}` });
  stripeState.charges[`ch_${subId}`] = { id: `ch_${subId}`, object: 'charge', amount, customer: 'cus_VENUE1', payment_intent: `pi_${subId}` };
  stripeState.invoicePayments[`pi_${subId}`] = [`in_${subId}`];
  stripeState.invoices[`in_${subId}`] = { id: `in_${subId}`, parent: { type: 'subscription_details', subscription_details: { subscription: subId } } };
  stripeState.refunds[`ch_${subId}`] = [{ id: `re_${subId}`, status: 'succeeded', amount: refunded }];
}

for (const type of ['charge.refunded', 'refund.updated']) {
  test(`a full refund (${type}) reaches the Roost writer: the subscription is cancelled and the grant revoked`, async () => {
    setEnv(ON);
    refundedInFull('sub_R1');
    const { calls, restore } = stubPool(async (sql) => {
      if (sql.startsWith('WITH old AS')) return { rows: [{ profiles: 1, written: 1, verified: true }] };
      return null;
    });
    try {
      const object = type === 'charge.refunded'
        ? stripeState.charges.ch_sub_R1
        : { id: 're_sub_R1', object: 'refund', charge: 'ch_sub_R1', status: 'succeeded', amount: 99000 };
      const res = await stripeWebhook({ id: 'evt_r1', type, data: { object } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(!res.body.ignored, `the refund was acknowledged as ignored: ${JSON.stringify(res.body)}`);
      assert.deepStrictEqual(stripeCalls.filter(([n]) => n === 'subscriptions.cancel').map(([, id]) => id), ['sub_R1']);
      assert.ok(calls.some((c) => c.text.includes('INSERT INTO stripe_subscription_endings')), 'the refund was not recorded against the subscription');
      const write = calls.find((c) => c.text.startsWith('WITH old AS'));
      assert.ok(write, 'the grant was not written');
      assert.strictEqual(write.params[10], false, 'a refunded subscription was written live');
      assert.strictEqual(write.params[11], 'free');
      assert.strictEqual(rcCalls.length, 0);
    } finally { restore(); }
  });
}

test('a partial refund event is acknowledged and changes nothing', async () => {
  setEnv(ON);
  refundedInFull('sub_R2', { refunded: 1000 });
  const { calls, restore } = stubPool(async () => null);
  try {
    const res = await stripeWebhook({ id: 'evt_r2', type: 'charge.refunded', data: { object: stripeState.charges.ch_sub_R2 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ignored, 'partial_refund');
    assert.ok(!stripeCalls.some(([n]) => n === 'subscriptions.cancel'));
    assert.ok(!calls.some((c) => c.text.startsWith('WITH old AS')));
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

test('a plan sold by hand on a customer of its own still opens the portal, on that customer', async () => {
  // The portal read venue_profiles.stripe_customer_id and nothing else, and
  // only checkout ever wrote it, so a founding venue whose plan was made by
  // hand in the dashboard was told it had no subscription to manage.
  setEnv(ON);
  stripeState.subscriptions = [{ id: 'sub_founding', status: 'active', created: 1700000000, customer: 'cus_FOUNDING', metadata: { kind: 'venue', flock_venue_user_id: String(ME.id) } }];
  const db = stubPool(venueDb({ customer: null, recorded: ['cus_FOUNDING'] }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/portal');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const [, args] = stripeCalls.find(([n]) => n === 'portal.create');
    assert.strictEqual(args.customer, 'cus_FOUNDING');
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

test('inside the window when the notice cannot be sent: no chargeable checkout is made at all', async () => {
  // THE BUG THIS PINS. The checkout floored the first charge at 30 days from
  // now and went ahead. The sweep then sent the notice on a later day, and
  // that email promised no charge until 30 days after IT, while Stripe's
  // trial_end still said 30 days after the checkout: the venue was charged
  // before the date it had been told. No notice recorded, no checkout.
  setEnv(ON);
  const real = roostNotice.sendNoticeForCheckout;
  roostNotice.sendNoticeForCheckout = async () => null;
  const { restore } = stubPool(venueDb({ legacy: true, noticeUntil: null }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409, `a checkout was made with no notice on record: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'NOTICE_NOT_SENT');
    assert.ok(!/—/.test(res.body.error));
    assert.strictEqual(sessionArgs(), null, 'Stripe was handed a session whose trial end no notice had named');
  } finally { restore(); roostNotice.sendNoticeForCheckout = real; }
});

test('inside the window, a notice send that throws is the same refusal, not a 30-day guess', async () => {
  setEnv(ON);
  const real = roostNotice.sendNoticeForCheckout;
  roostNotice.sendNoticeForCheckout = async () => { throw new Error('db down after the send'); };
  const { restore } = stubPool(venueDb({ legacy: true, noticeUntil: null }));
  try {
    const res = await call(venueBillingRoutes, 'POST', '/api/venue-billing/checkout', { plan: 'monthly' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'NOTICE_NOT_SENT');
    assert.strictEqual(sessionArgs(), null);
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
