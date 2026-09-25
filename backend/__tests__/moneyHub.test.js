'use strict';
// Run: node --test __tests__/moneyHub.test.js  (from backend/)
//
// THE OWNER'S MONEY HUB AND THE EXPENSE LIST.
//
// What is pinned here, and why each one matters:
//
//   1. The gate. Every new route answers a non-admin with 403 before a query,
//      a Stripe call or a RevenueCat call. (adminEvidence.test.js sweeps the
//      whole router too; this names the money routes and the vendor calls.)
//   2. Honest absence. With no Stripe key and no RevenueCat key the revenue
//      blocks say "not_connected" and carry no numbers, net revenue is null
//      rather than $0, and the cost half still stands.
//   3. Real numbers. Against a fake Stripe and a fake RevenueCat: counts by
//      plan, a 100% off code reading as free rather than as revenue, MRR,
//      what was collected this month less refunds, disputes and fees, the
//      App Store split from each Pro account's own record, promotion code
//      redemptions, and every price beside what the code states.
//   4. A failure names itself without echoing the key, and the vendor reads
//      are cached so a reload does not reach Stripe again.
//   5. The expense routes: validation (shape first), the upsert on import,
//      one transaction, and "Row 3:" in the error a paste gets back.
//   6. The cost arithmetic: a row that stands in for a code line counts once,
//      a lookalike is flagged, yearly bills are spread, one-time bills land
//      only in their own month.
//   7. Every price services/statedPrices.js lists is where it says, at the
//      amount it says.
//
// Stripe is a fake installed in the require cache before the billing service
// loads it, RevenueCat is a fake global fetch, and Postgres is a scripted fake.
// Nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'money-hub-test-secret';
// Fake, and assembled at runtime so nothing here looks like a real key.
const STRIPE_KEY = ['sk', 'test', `moneyhub${'0'.repeat(20)}`].join('_');
const RC_KEY = 'rc_secret_moneyhub_fake_key_000';

// ---- the fake Stripe -------------------------------------------------------
const stripeCalls = [];
let stripeState;
let stripeFailure = null;
function resetStripeState() {
  stripeState = {
    subscriptions: { active: [], trialing: [], past_due: [], unpaid: [] },
    balance: [],
    // true: every balance page says there is another, so the read runs out of
    // pages the way it would on a month with more entries than it reads.
    balanceEndless: false,
    invoices: [],
    disputes: [],
    // When set, the dispute list answers these pages in turn.
    disputePages: null,
    promotionCodes: [],
    prices: [],
    retrievable: {},
    coupons: {},
    params: { balance: [], invoices: [], disputes: [] },
  };
  stripeCalls.length = 0;
  stripeFailure = null;
}
resetStripeState();
const call = (name, fn) => async (...args) => {
  stripeCalls.push(name);
  if (stripeFailure) throw stripeFailure;
  return fn(...args);
};
function FakeStripe() {
  return {
    subscriptions: { list: call('subscriptions.list', async (p) => ({ data: stripeState.subscriptions[p.status] || [], has_more: false })) },
    balanceTransactions: {
      list: call('balanceTransactions.list', async (p) => {
        stripeState.params.balance.push(p);
        return { data: stripeState.balance, has_more: stripeState.balanceEndless };
      }),
    },
    // Honours `created`, as Stripe does, so a window too narrow to reach an
    // invoice really does miss it here.
    invoices: {
      list: call('invoices.list', async (p) => {
        stripeState.params.invoices.push(p);
        const gte = p && p.created && p.created.gte;
        const data = stripeState.invoices.filter((inv) => !Number.isFinite(gte) || !Number.isFinite(inv.created) || inv.created >= gte);
        return { data, has_more: false };
      }),
    },
    disputes: {
      list: call('disputes.list', async (p) => {
        stripeState.params.disputes.push(p);
        if (!stripeState.disputePages) return { data: stripeState.disputes, has_more: false };
        const page = p && p.starting_after
          ? stripeState.disputePages.findIndex((pg) => pg.length && pg[pg.length - 1].id === p.starting_after) + 1
          : 0;
        return { data: stripeState.disputePages[page] || [], has_more: page < stripeState.disputePages.length - 1 };
      }),
    },
    promotionCodes: { list: call('promotionCodes.list', async () => ({ data: stripeState.promotionCodes, has_more: false })) },
    prices: {
      list: call('prices.list', async () => ({ data: stripeState.prices, has_more: false })),
      retrieve: call('prices.retrieve', async (id) => {
        if (stripeState.retrievable[id]) return stripeState.retrievable[id];
        const err = new Error('No such price');
        err.statusCode = 404;
        err.code = 'resource_missing';
        throw err;
      }),
    },
    coupons: { retrieve: call('coupons.retrieve', async (id) => stripeState.coupons[id] || null) },
  };
}
require.cache[require.resolve('stripe')] = { id: require.resolve('stripe'), filename: require.resolve('stripe'), loaded: true, exports: FakeStripe };

// ---- the fake RevenueCat -----------------------------------------------------
const rcCalls = [];
let rc;
function resetRc() {
  rc = { v2: 'refuse', productsRefused: false, failIds: new Set(), subscribers: {}, projects: [], metrics: [], revenue: null, products: [], offerings: [], packages: [] };
  rcCalls.length = 0;
}
resetRc();
const realFetch = global.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
global.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.revenuecat.com/')) return realFetch(url, init);
  rcCalls.push(u);
  const auth = init && init.headers && init.headers.Authorization;
  if (auth !== `Bearer ${RC_KEY}`) return json({ message: 'bad key' }, 401);
  if (u.includes('/v1/subscribers/')) {
    const id = decodeURIComponent(u.split('/v1/subscribers/')[1]);
    if (rc.failIds.has(id)) return json({ message: 'upstream' }, 500);
    return json(rc.subscribers[id] || { subscriber: { subscriptions: {} } });
  }
  if (u.includes('/v2/')) {
    if (rc.v2 === 'refuse') return json({ message: 'forbidden' }, 403);
    if (/\/v2\/projects\?/.test(u)) return json({ items: rc.projects });
    if (u.includes('/metrics/overview')) return json({ object: 'overview_metrics', metrics: rc.metrics, currency: 'USD' });
    if (u.includes('/metrics/revenue')) return rc.revenue === null ? json({}, 404) : json({ value: rc.revenue });
    if (u.includes('/products')) return rc.productsRefused ? json({ message: 'forbidden' }, 403) : json({ items: rc.products });
    if (/\/offerings\/[^/]+\/packages/.test(u)) return json({ items: rc.packages });
    if (u.includes('/offerings')) return json({ items: rc.offerings });
  }
  return json({}, 404);
};

// ---- the scripted Postgres ---------------------------------------------------
const pool = require('../config/database');
let handlers = [];
let log = [];
function dispatch(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: text, params });
  for (const [re, fn] of handlers) {
    if (re.test(text)) {
      const out = fn(params || [], text);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${text.slice(0, 160)}`));
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

// The photo ledger is its own module with its own SQL. Stubbed on the module
// object, which is how moneyHub reads it.
const photoStore = require('../services/photoStore');
photoStore.photoSpendStatus = async () => ({ monthUsed: 12, monthUsd: 0, dayUsed: 1, limits: {} });

// ---- the app -----------------------------------------------------------------
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 9, role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
const adminRouter = require('../routes/admin');
const moneyHub = require('../services/moneyHub');
const billing = require('../services/proBilling');
const { STATED_PRICES } = require('../services/statedPrices');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  global.fetch = realFetch;
}));

async function req(method, p, body) {
  const res = await realFetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

const ENV_KEYS = [
  'STRIPE_SECRET_KEY', 'REVENUECAT_SECRET_API_KEY', 'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_PRO_YEARLY',
  'STRIPE_PRICE_ROOST_MONTHLY', 'STRIPE_PRICE_ROOST_YEARLY', 'STRIPE_PRICE_ROOST_FOUNDING',
  'STRIPE_PRICE_ROOST_LEGACY', 'PAYWALL_ENABLED', 'VENUE_BILLING_ENABLED', 'REVENUECAT_PROJECT_ID',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const MONTH = moneyHub.monthOf(moneyHub.ymdIn(moneyHub.HUB_TZ));
const IN_MONTH_SEC = MONTH.startUnix + 3600;
const FUTURE_ISO = new Date(Date.now() + 20 * 86400000).toISOString();
const THIS_MONTH_ISO = new Date(IN_MONTH_SEC * 1000 + 60000).toISOString();

let expenseRows = [];
function dbRow(x) {
  return {
    id: x.id,
    vendor: x.vendor,
    product: x.product || null,
    category: x.category || null,
    kind: x.kind,
    amount_cents: x.amount_cents,
    currency: x.currency || 'USD',
    cadence: x.cadence,
    last_charged_on: x.last_charged_on || null,
    renews_on: x.renews_on || null,
    active: x.active !== false,
    verified: x.verified === true,
    note: x.note || null,
    replaces_line: x.replaces_line || null,
    updated_at: new Date('2026-09-20T12:00:00Z'),
  };
}

// Everything the hub asks Postgres, answered with a quiet but real database.
function hubHandlers({ collectorMinutesAgo = 20, premiumIds = [5, 7, 14] } = {}) {
  return [
    [/FROM business_expenses/, () => ({ rows: expenseRows.map(dbRow), rowCount: expenseRows.length })],
    [/FROM cost_reconciled/, () => ({ rows: [], rowCount: 0 })],
    [/SELECT id FROM users WHERE is_premium = true/, () => ({ rows: premiumIds.map((id) => ({ id })), rowCount: premiumIds.length })],
    [/SELECT COUNT\(\*\)::int AS n FROM users WHERE is_premium = true/, () => ({ rows: [{ n: premiumIds.length }], rowCount: 1 })],
    [/FROM venue_subscriptions/, () => ({ rows: [{ n: 0 }], rowCount: 1 })],
    [/ORDER BY collected_at DESC/, () => (collectorMinutesAgo === null
      ? { rows: [], rowCount: 0 }
      : { rows: [{ collected_at: new Date(Date.now() - collectorMinutesAgo * 60000) }], rowCount: 1 })],
    [/COUNT\(DISTINCT date_trunc/, () => ({ rows: [{ n: 3000, hours: 24 }], rowCount: 1 })],
    [/FROM ops_alert_ledger/, () => ({ rows: [{ last: null }], rowCount: 1 })],
  ];
}

function clearVendors() {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.REVENUECAT_SECRET_API_KEY;
  delete process.env.REVENUECAT_PROJECT_ID;
  for (const k of ENV_KEYS.filter((x) => x.startsWith('STRIPE_PRICE_'))) delete process.env[k];
}

test.beforeEach(() => {
  handlers = [];
  log = [];
  expenseRows = [];
  CURRENT_USER = { id: 9, role: 'admin' };
  resetStripeState();
  resetRc();
  clearVendors();
  moneyHub.__test.resetCache();
  billing.__test.resetStripe();
});

// A Stripe account with one paying Pro subscriber, one on a 100% off code, one
// yearly trial and one Roost venue on the yearly plan.
function seedStripe() {
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_y';
  process.env.STRIPE_PRICE_ROOST_MONTHLY = 'price_roost_m';
  process.env.STRIPE_PRICE_ROOST_YEARLY = 'price_roost_y';
  const price = (id, amount, interval) => ({ id, unit_amount: amount, currency: 'usd', recurring: { interval, interval_count: 1 } });
  stripeState.subscriptions.active = [
    { id: 'sub_paid', status: 'active', items: { data: [{ price: price('price_pro_m', 399, 'month'), quantity: 1 }] }, metadata: { app_user_id: '5' }, discounts: [] },
    {
      id: 'sub_code', status: 'active', items: { data: [{ price: price('price_pro_m', 399, 'month'), quantity: 1 }] }, metadata: { app_user_id: '14' },
      discounts: [{ id: 'di_1', source: { coupon: 'cpn_friends', type: 'coupon' }, end: null }],
    },
    { id: 'sub_venue', status: 'active', items: { data: [{ price: price('price_roost_y', 99000, 'year'), quantity: 1 }] }, metadata: { kind: 'venue', flock_venue_user_id: '3' }, discounts: [] },
  ];
  stripeState.subscriptions.trialing = [
    { id: 'sub_trial', status: 'trialing', items: { data: [{ price: price('price_pro_y', 2999, 'year'), quantity: 1 }] }, metadata: { app_user_id: '7' }, discounts: [] },
  ];
  stripeState.coupons.cpn_friends = { id: 'cpn_friends', percent_off: 100, duration: 'forever' };
  stripeState.balance = [
    { id: 'txn_1', reporting_category: 'charge', amount: 399, fee: 44, net: 355, currency: 'usd' },
    { id: 'txn_2', reporting_category: 'charge', amount: 99000, fee: 2901, net: 96099, currency: 'usd' },
    { id: 'txn_3', reporting_category: 'refund', amount: -399, fee: 0, net: -399, currency: 'usd' },
    { id: 'txn_4', reporting_category: 'dispute', amount: -399, fee: 1500, net: -1899, currency: 'usd' },
    { id: 'txn_5', reporting_category: 'fee', amount: -28, fee: 0, net: -28, currency: 'usd' },
    { id: 'txn_6', reporting_category: 'payout', amount: -50000, fee: 0, net: -50000, currency: 'usd' },
  ];
  stripeState.invoices = [
    { id: 'in_1', status: 'paid', amount_paid: 399, currency: 'usd', created: IN_MONTH_SEC, status_transitions: { paid_at: IN_MONTH_SEC }, parent: { subscription_details: { metadata: { app_user_id: '5' } } } },
    { id: 'in_2', status: 'paid', amount_paid: 0, currency: 'usd', created: IN_MONTH_SEC, status_transitions: { paid_at: IN_MONTH_SEC }, parent: { subscription_details: { metadata: { app_user_id: '14' } } } },
    { id: 'in_3', status: 'paid', amount_paid: 99000, currency: 'usd', created: IN_MONTH_SEC, status_transitions: { paid_at: IN_MONTH_SEC }, parent: { subscription_details: { metadata: { kind: 'venue' } } } },
    { id: 'in_old', status: 'paid', amount_paid: 5000, currency: 'usd', created: MONTH.startUnix - 3 * 86400, status_transitions: { paid_at: MONTH.startUnix - 86400 }, parent: null },
  ];
  stripeState.disputes = [{ id: 'dp_1', status: 'needs_response', amount: 399, currency: 'usd' }, { id: 'dp_2', status: 'won', amount: 100, currency: 'usd' }];
  stripeState.promotionCodes = [{ id: 'promo_1', code: 'FLOCKFRIENDS', active: true, times_redeemed: 3, max_redemptions: null, promotion: { coupon: 'cpn_friends', type: 'coupon' } }];
  stripeState.prices = [
    { ...price('price_pro_m', 399, 'month'), active: true, product: { name: 'Flock Pro' } },
    { ...price('price_pro_y', 2999, 'year'), active: true, product: { name: 'Flock Pro' } },
    { ...price('price_roost_m', 10900, 'month'), active: true, product: { name: 'Roost' } },
    { ...price('price_roost_y', 99000, 'year'), active: true, product: { name: 'Roost' } },
    { ...price('price_old', 499, 'month'), active: true, product: { name: 'Flock Pro' } },
  ];
}

// RevenueCat: account 5 bought monthly Pro in the App Store this month,
// account 14 is the web subscriber, account 7 is a sandbox tester.
function seedRevenueCat({ v2 = 'refuse' } = {}) {
  process.env.REVENUECAT_SECRET_API_KEY = RC_KEY;
  rc.v2 = v2;
  rc.subscribers = {
    5: { subscriber: { subscriptions: { flock_pro_monthly: { store: 'app_store', is_sandbox: false, period_type: 'normal', purchase_date: THIS_MONTH_ISO, expires_date: FUTURE_ISO, price: { amount: 3.99, currency: 'USD' } } } } },
    14: { subscriber: { subscriptions: { prod_web: { store: 'stripe', is_sandbox: false, period_type: 'normal', purchase_date: THIS_MONTH_ISO, expires_date: FUTURE_ISO } } } },
    7: { subscriber: { subscriptions: { flock_pro_yearly: { store: 'app_store', is_sandbox: true, period_type: 'normal', purchase_date: THIS_MONTH_ISO, expires_date: FUTURE_ISO } } } },
  };
  rc.projects = [{ id: 'proj1', name: 'Flock' }];
  rc.metrics = [
    { object: 'overview_metric', id: 'active_subscriptions', name: 'Active Subscriptions', value: 3, unit: '#', period: 'P0D' },
    { object: 'overview_metric', id: 'mrr', name: 'MRR', value: 7.98, unit: '$', period: 'P0D' },
  ];
  rc.revenue = 3.99;
  rc.products = [
    { id: 'prodA', store_identifier: 'flock_pro_monthly', app: { type: 'app_store' }, subscription: { duration: 'P1M' } },
    { id: 'prodB', store_identifier: 'flock_pro_yearly', app: { type: 'app_store' }, subscription: { duration: 'P1M' } },
  ];
  rc.offerings = [{ id: 'ofrng1', lookup_key: 'default', is_current: true }];
  rc.packages = [
    { lookup_key: '$rc_monthly', products: { items: [{ product_id: 'prodA' }] } },
    { lookup_key: '$rc_annual', products: { items: [{ product_id: 'prodB' }] } },
  ];
}

// ===========================================================================
// 1. THE GATE
// ===========================================================================

test('every money and expense route refuses a non-admin before a query or a vendor call', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'ok' });
  const routes = [
    ['GET', '/api/admin/money'],
    ['GET', '/api/admin/expenses'],
    ['POST', '/api/admin/expenses', { vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1 }],
    ['PUT', '/api/admin/expenses/1', { vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1 }],
    ['DELETE', '/api/admin/expenses/1'],
    ['POST', '/api/admin/expenses/import', { expenses: [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1 }] }],
  ];
  for (const role of ['user', 'venue_owner', undefined, 'ADMIN']) {
    for (const [method, p, body] of routes) {
      CURRENT_USER = { id: 42, role };
      log = [];
      stripeCalls.length = 0;
      rcCalls.length = 0;
      const r = await req(method, p, body);
      assert.strictEqual(r.status, 403, `${method} ${p} answered ${r.status} for role ${String(role)}`);
      assert.deepStrictEqual(log, [], `${method} ${p} touched the database first`);
      assert.deepStrictEqual(stripeCalls, [], `${method} ${p} called Stripe first`);
      assert.deepStrictEqual(rcCalls, [], `${method} ${p} called RevenueCat first`);
    }
  }
});

// ===========================================================================
// 2. HONEST ABSENCE
// ===========================================================================

test('with no keys, revenue says not connected and carries no numbers, and costs still stand', async () => {
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.status, 200, r.text);
  const h = r.body;
  assert.strictEqual(h.revenue.stripe.status, 'not_connected');
  assert.match(h.revenue.stripe.reason, /STRIPE_SECRET_KEY/);
  assert.strictEqual(h.revenue.stripe.subscriptions, undefined, 'an unread source must not carry a subscription count');
  assert.strictEqual(h.revenue.revenuecat.status, 'not_connected');
  assert.match(h.revenue.revenuecat.reason, /REVENUECAT_SECRET_API_KEY/);
  assert.strictEqual(h.net.revenueThisMonthCents, null, 'unread revenue is null, never $0');
  assert.strictEqual(h.net.netThisMonthCents, null);
  assert.ok(h.net.revenueMissing.includes('stripe'));
  assert.ok(h.costs.totals.perMonthCents > 0, 'the code lines and the reconciled invoice still count');
  for (const s of h.pricing.stated) {
    assert.ok(['unchecked', 'unsold'].includes(s.verdict), `${s.id} claimed ${s.verdict} with no Stripe to check against`);
  }
  assert.strictEqual(stripeCalls.length, 0);
  assert.strictEqual(rcCalls.length, 0);
  assert.strictEqual(h.health.backups.recorded, false, 'nothing in the database records a backup, so nothing is invented');
});

test('the database being down leaves the hub standing and says what could not be read', async () => {
  handlers = [[/.*/, () => Promise.reject(new Error('connection terminated'))]];
  const r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.costs.status, 'error');
  assert.strictEqual(r.body.expenses.status, 'error');
  assert.strictEqual(r.body.health.collector.status, 'error');
  assert.strictEqual(r.body.revenue.database.proAccounts, null);
  assert.ok(r.body.costs.totals.perMonthCents > 0, 'the code figures stand in when the list cannot be read');
});

// ===========================================================================
// 3. REAL NUMBERS
// ===========================================================================

test('Stripe subscriptions: counts by plan, a 100% off code is free, MRR is what is actually paid', async () => {
  seedStripe();
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.status, 200, r.text);
  const s = r.body.revenue.stripe;
  assert.strictEqual(s.status, 'ok');
  assert.strictEqual(s.mode, 'test', 'a test key is labelled test, so a test figure is never read as money');
  const pro = s.subscriptions.pro;
  assert.strictEqual(pro.live, 2);
  assert.strictEqual(pro.trialing, 1);
  assert.strictEqual(pro.freeViaCode, 1, 'FLOCKFRIENDS at 100% off is a subscriber, not revenue');
  assert.strictEqual(pro.mrrCents, 399);
  assert.strictEqual(pro.byPlan.monthly.live, 2);
  assert.strictEqual(pro.byPlan.yearly.trialing, 1);
  assert.strictEqual(pro.mrrNetCents, Math.round(399 * (1 - 0.036) - 30), 'net of Stripe card and Billing shares and the fixed fee');
  const roost = s.subscriptions.roost;
  assert.strictEqual(roost.live, 1);
  assert.strictEqual(roost.mrrCents, 8250, 'a yearly plan is recurring revenue at a twelfth a month');
  assert.strictEqual(s.subscriptions.webProAccountCount, 3, 'the paying, the free-code and the trialing account each hold a web subscription');
  assert.strictEqual(s.subscriptions._webProAccounts, undefined, 'account ids stay on the server');
});

test('this month in Stripe: gross, refunds, disputes and fees, with payouts left out', async () => {
  seedStripe();
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const b = r.body.revenue.stripe.balance;
  assert.strictEqual(b.status, 'ok');
  assert.strictEqual(b.grossCents, 99399);
  assert.strictEqual(b.refundsCents, -399);
  assert.strictEqual(b.disputesCents, -399);
  assert.strictEqual(b.feesCents, 44 + 2901 + 1500 + 28, 'card fees, the dispute fee and the separately billed fee');
  assert.strictEqual(b.netCents, 99399 - 399 - 399 - (44 + 2901 + 1500 + 28));
  const inv = r.body.revenue.stripe.invoices.byProduct;
  assert.strictEqual(inv.pro.paidCents, 399);
  assert.strictEqual(inv.pro.zeroInvoices, 1, 'the $0 invoice from the code is counted and named');
  assert.strictEqual(inv.roost.paidCents, 99000);
  assert.strictEqual(inv.other.paidCents, 0, 'last month\'s invoice is not this month\'s money');
  assert.strictEqual(r.body.revenue.stripe.disputes.open, 1);
  assert.strictEqual(r.body.revenue.stripe.disputes.openAmountCents, 399);
  const code = r.body.revenue.stripe.promotionCodes.codes[0];
  assert.strictEqual(code.code, 'FLOCKFRIENDS');
  assert.strictEqual(code.timesRedeemed, 3);
  assert.strictEqual(code.coupon.percentOff, 100);
  assert.strictEqual(code.coupon.duration, 'forever');
});

test('every live price beside every stated one, with each disagreement in words', async () => {
  seedStripe();
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const byId = Object.fromEntries(r.body.pricing.stated.map((s) => [s.id, s]));
  assert.strictEqual(byId['pro-monthly-paywall-doc'].verdict, 'match');
  assert.strictEqual(byId['pro-monthly-projections'].verdict, 'match');
  assert.strictEqual(byId['pro-yearly-paywall-doc'].verdict, 'match');
  assert.strictEqual(byId['roost-yearly-terms'].verdict, 'match');
  assert.strictEqual(byId['roost-yearly-terms-served'].verdict, 'match');
  // The crawler copy of the Terms is its own published place, so a Stripe
  // price that disagrees with it is named there too.
  for (const id of ['roost-monthly-admin', 'roost-monthly-app', 'roost-monthly-terms', 'roost-monthly-terms-served']) {
    assert.strictEqual(byId[id].verdict, 'mismatch', `${id} should disagree with a $109 Stripe price`);
    assert.match(byId[id].words, /Stripe charges \$109/);
    assert.match(byId[id].words, /\$99/);
  }
  assert.strictEqual(byId['roost-founding-env-doc'].verdict, 'unset');
  assert.match(byId['roost-founding-env-doc'].words, /STRIPE_PRICE_ROOST_FOUNDING is not set/);
  // Every other place a price is written down is checked the same way: the
  // crawler summary, the Roost notice email and the two public docs.
  for (const id of ['roost-monthly-llms', 'roost-monthly-notice-email', 'roost-monthly-readme', 'roost-monthly-money-model']) {
    assert.strictEqual(byId[id].verdict, 'mismatch', `${id} should disagree with a $109 Stripe price`);
    assert.match(byId[id].words, /Stripe charges \$109/);
  }
  for (const id of ['roost-yearly-llms', 'roost-yearly-notice-email', 'roost-yearly-readme', 'roost-yearly-money-model',
    'pro-monthly-money-model', 'pro-yearly-money-model']) {
    assert.strictEqual(byId[id].verdict, 'match', id);
  }
  // No row is a price that nothing in Stripe sells. The retired $35 venue plan
  // was the one that was, and it is gone from the app and from this list.
  assert.deepStrictEqual(r.body.pricing.stated.filter((s) => s.verdict === 'unsold').map((s) => s.id), []);
  assert.deepStrictEqual(r.body.pricing.unreferenced.map((p) => p.id), ['price_old'], 'a live price no plan points at is named');
  assert.ok(r.body.pricing.mismatches >= 3);
  assert.match(r.body.pricing.paywallNote, /No Pro price is typed into it/);
});

test('a retired Roost price in STRIPE_PRICE_ROOST_LEGACY counts as Roost and is not named as a stray', async () => {
  seedStripe();
  const retired = { id: 'price_roost_m_old', unit_amount: 7900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } };
  // Still active in Stripe, so without the legacy list it would read as a
  // price nothing in the app knows about.
  stripeState.prices.push({ ...retired, active: true, product: { name: 'Roost' } });
  stripeState.subscriptions.active.push({
    id: 'sub_venue_old', status: 'active', items: { data: [{ price: retired, quantity: 1 }] }, metadata: { kind: 'venue', flock_venue_user_id: '4' }, discounts: [],
  });
  process.env.STRIPE_PRICE_ROOST_LEGACY = 'price_roost_m_old';
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.revenue.stripe.subscriptions.roost.live, 2, 'the venue still billed on the old price is a Roost subscriber');
  assert.ok(!r.body.pricing.unreferenced.some((p) => p.id === 'price_roost_m_old'), 'a price venues are still billed on is not a stray');
});

test('an archived or unknown configured price is named, not compared as if it were live', async () => {
  seedStripe();
  stripeState.prices = stripeState.prices.filter((p) => p.id !== 'price_pro_y');
  stripeState.retrievable.price_pro_y = { id: 'price_pro_y', unit_amount: 2999, currency: 'usd', recurring: { interval: 'year', interval_count: 1 }, active: false };
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_gone';
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const byId = Object.fromEntries(r.body.pricing.stated.map((s) => [s.id, s]));
  assert.strictEqual(byId['pro-yearly-paywall-doc'].verdict, 'mismatch');
  assert.match(byId['pro-yearly-paywall-doc'].words, /archived/);
  assert.strictEqual(byId['roost-founding-env-doc'].verdict, 'missing');
  assert.match(byId['roost-founding-env-doc'].words, /price_gone/);
});

test('the code disagreeing with itself is flagged even with Stripe switched off', () => {
  const pricing = moneyHub.buildPricing({ stripe: { status: 'not_connected' }, revenuecat: { status: 'not_connected' }, venuePriceUsd: 109 });
  assert.strictEqual(pricing.internal.length, 1);
  assert.match(pricing.internal[0].words, /backend\/routes\/admin\.js says \$109/);
  assert.match(pricing.internal[0].words, /frontend\/src\/App\.js says \$99/);
});

test('RevenueCat: a key without v2 access says so, and the App Store split still comes from each Pro account', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'refuse' });
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const rcv = r.body.revenue.revenuecat;
  assert.strictEqual(rcv.status, 'ok');
  assert.strictEqual(rcv.overview.status, 'refused');
  assert.match(rcv.overview.reason, /403/);
  assert.match(rcv.overview.reason, /v2 secret key/);
  const sub = rcv.subscribers;
  assert.strictEqual(sub.status, 'ok');
  assert.strictEqual(sub.checked, 3);
  assert.strictEqual(sub.stores.app_store.live, 1);
  assert.strictEqual(sub.stores.app_store.byPlan.monthly.live, 1);
  assert.strictEqual(sub.stores.app_store.mrrCents, 399);
  assert.strictEqual(sub.stores.app_store.monthChargedCents, 399);
  assert.strictEqual(sub.stores.stripe.live, 1);
  assert.strictEqual(sub.sandbox, 1, 'a sandbox purchase is counted apart and never as money');
  // App Store money this month, after Apple's standard cut, is in the net.
  assert.strictEqual(r.body.net.revenueParts.appStoreNetCents, Math.round(399 * 0.7));
  assert.strictEqual(r.body.net.revenueThisMonthCents, r.body.revenue.stripe.balance.netCents + Math.round(399 * 0.7));
  const app = r.body.pricing.appStore.find((a) => a.productId === 'flock_pro_monthly');
  assert.strictEqual(app.verdict, 'match', 'the last App Store charge matches the stated $3.99');
});

test('RevenueCat v2: the overview, this month, and a package pointed at the wrong length', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'ok' });
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const o = r.body.revenue.revenuecat.overview;
  assert.strictEqual(o.status, 'ok');
  assert.deepStrictEqual(o.metrics.map((m) => m.id), ['active_subscriptions', 'mrr']);
  assert.strictEqual(o.monthRevenueUsd, 3.99);
  const f = r.body.pricing.offering;
  assert.strictEqual(f.status, 'ok');
  const bad = f.findings.filter((x) => !x.ok);
  assert.strictEqual(bad.length, 1);
  assert.match(bad[0].words, /flock_pro_yearly in \$rc_annual lasts P1M, not P1Y/);
});

test('a key that can read the metrics but not the products says the offering was not checked, not that it is wrong', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'ok' });
  rc.productsRefused = true;
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.body.revenue.revenuecat.overview.status, 'ok', 'the metrics still arrive');
  assert.strictEqual(r.body.pricing.offering.status, 'error');
  assert.match(r.body.pricing.offering.reason, /could not be checked/);
  assert.deepStrictEqual(r.body.pricing.offering.findings, [], 'no package is called wrong on a permission gap');
});

// ===========================================================================
// 4. FAILURE AND CACHE
// ===========================================================================

test('a refused Stripe key is a named error with no numbers and no key in it', async () => {
  seedStripe();
  const err = new Error(`Invalid API Key provided: ${STRIPE_KEY}`);
  err.type = 'StripeAuthenticationError';
  err.statusCode = 401;
  stripeFailure = err;
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.revenue.stripe.status, 'error');
  assert.match(r.body.revenue.stripe.reason, /refused the key \(401\)/);
  assert.strictEqual(r.body.revenue.stripe.subscriptions, undefined);
  assert.ok(!r.text.includes(STRIPE_KEY), 'the key must never reach the client');
  assert.ok(!r.text.includes(RC_KEY));
});

test('vendor reads are cached, and a refresh inside a minute does not reach Stripe again', async () => {
  seedStripe();
  handlers = hubHandlers();
  const first = await req('GET', '/api/admin/money');
  assert.strictEqual(first.body.revenue.stripe.cached, false);
  const calls = stripeCalls.length;
  assert.ok(calls > 0);
  const second = await req('GET', '/api/admin/money');
  assert.strictEqual(second.body.revenue.stripe.cached, true);
  const third = await req('GET', '/api/admin/money?refresh=1');
  assert.strictEqual(third.body.revenue.stripe.cached, true, 'a refresh is honoured only once the answer is a minute old');
  assert.strictEqual(stripeCalls.length, calls, 'nothing was asked of Stripe twice');
});

test('the payload carries counts and sums, never an email or an account id list', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'ok' });
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  assert.ok(!/@/.test(r.text), 'no email address in the hub');
  assert.ok(!/app_user_id/.test(r.text), 'no subscriber account ids in the hub');
});

// ===========================================================================
// 5. THE EXPENSE ROUTES
// ===========================================================================

function writeHandlers() {
  const inserted = [];
  let nextId = 100;
  return {
    inserted,
    handlers: [
      [/^INSERT INTO business_expenses/, (p) => {
        const row = { id: nextId++, vendor: p[0], product: p[1], category: p[2], kind: p[3], amount_cents: p[4], currency: p[5], cadence: p[6], last_charged_on: p[7], renews_on: p[8], active: p[9], verified: p[10], note: p[11], replaces_line: p[12] };
        inserted.push({ params: p, row });
        return { rows: [dbRow(row)], rowCount: 1 };
      }],
    ],
  };
}

test('POST /expenses validates shape first and stores cents, stamped by the admin', async () => {
  const w = writeHandlers();
  handlers = w.handlers;
  const bad = [
    [{ kind: 'tooling', cadence: 'monthly', amount: 20 }, /vendor is required/],
    [{ vendor: ['Railway'], kind: 'tooling', cadence: 'monthly', amount: 20 }, /vendor is required/],
    [{ vendor: 'X', kind: 'snacks', cadence: 'monthly', amount: 20 }, /kind must be one of/],
    [{ vendor: 'X', kind: 'other', cadence: 'weekly', amount: 20 }, /cadence must be one of/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: '12.345' }, /amount must be/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: -1 }, /amount must be/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amountCents: 1.5 }, /amount must be/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1, lastChargedOn: '2026-02-30' }, /lastChargedOn must be a date/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1, lastChargedOn: '2999-01-01' }, /cannot be in the future/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1, currency: 'dollars' }, /three-letter code/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1, replacesLine: 'constructor' }, /replacesLine must be one of/],
    [{ vendor: 'X', kind: 'other', cadence: 'monthly', amount: 1, active: 'maybe' }, /active must be true or false/],
  ];
  for (const [body, re] of bad) {
    const r = await req('POST', '/api/admin/expenses', body);
    assert.strictEqual(r.status, 400, `expected 400 for ${JSON.stringify(body)}: ${r.text}`);
    assert.match(r.body.error, re);
  }
  assert.strictEqual(w.inserted.length, 0, 'nothing invalid was written');

  const ok = await req('POST', '/api/admin/expenses', {
    vendor: '  <b>Registrar</b> ', product: 'flockcorp.com', kind: 'infrastructure', cadence: 'annual',
    amount: '$11.08', renewsOn: '2027-08-01', replacesLine: 'domain', verified: true,
  });
  assert.strictEqual(ok.status, 201, ok.text);
  assert.strictEqual(w.inserted.length, 1);
  const p = w.inserted[0].params;
  assert.strictEqual(p[0], 'Registrar', 'markup is stripped and the name trimmed');
  assert.strictEqual(p[4], 1108, 'dollars become integer cents');
  assert.strictEqual(p[5], 'USD');
  assert.strictEqual(p[6], 'yearly', '"annual" is folded onto the stored cadence');
  assert.strictEqual(p[9], true, 'a new bill is active unless it says otherwise');
  assert.strictEqual(p[12], 'domain');
  assert.strictEqual(p[13], 9, 'updated_by is the admin who wrote it');
  assert.strictEqual(ok.body.expense.amountCents, 1108);
});

test('PUT and DELETE settle the id first and answer 404 for a row that is not there', async () => {
  handlers = [
    [/^UPDATE business_expenses/, (p) => (p[0] === 5
      ? { rows: [dbRow({ id: 5, vendor: p[1], kind: p[4], amount_cents: p[5], cadence: p[7], active: p[10] })], rowCount: 1 }
      : { rows: [], rowCount: 0 })],
    [/^DELETE FROM business_expenses/, (p) => (p[0] === 5 ? { rows: [{ id: 5 }], rowCount: 1 } : { rows: [], rowCount: 0 })],
  ];
  const body = { vendor: 'Railway', kind: 'infrastructure', cadence: 'monthly', amount: 20, active: false };
  for (const bad of ['0', 'abc', '99999999999', '1.5']) {
    log = [];
    const r = await req('PUT', `/api/admin/expenses/${bad}`, body);
    assert.strictEqual(r.status, 404, `PUT ${bad}`);
    assert.deepStrictEqual(log, [], `PUT ${bad} reached the database`);
  }
  let r = await req('PUT', '/api/admin/expenses/6', body);
  assert.strictEqual(r.status, 404);
  r = await req('PUT', '/api/admin/expenses/5', body);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.expense.active, false, 'deactivating is the same write with active false');
  r = await req('DELETE', '/api/admin/expenses/6');
  assert.strictEqual(r.status, 404);
  r = await req('DELETE', '/api/admin/expenses/5');
  assert.strictEqual(r.status, 200);
});

const NO_MATCH = [/^SELECT .* FROM business_expenses WHERE lower\(vendor\)/, () => ({ rows: [], rowCount: 0 })];

test('import: a bare pasted array works, every row is checked first, and a bad row names its number', async () => {
  const w = writeHandlers();
  handlers = [NO_MATCH, ...w.handlers];
  const list = [
    { vendor: 'Railway', product: 'Pro', kind: 'infra', cadence: 'monthly', amount: 20, replaces_line: 'railway' },
    { vendor: 'Some tool', kind: 'tools', cadence: 'Monthly', amount_cents: 2000 },
  ];
  let r = await req('POST', '/api/admin/expenses/import', [...list, { vendor: '', kind: 'legal', cadence: 'one-time', amount: 50 }]);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /^Row 3: vendor is required/);
  assert.strictEqual(w.inserted.length, 0, 'one bad row writes nothing at all');
  assert.ok(!log.some((q) => q.sql === 'BEGIN'), 'validation refuses before a transaction opens');

  r = await req('POST', '/api/admin/expenses/import', list);
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.inserted, 2);
  assert.strictEqual(r.body.updated, 0);
  assert.deepStrictEqual(w.inserted.map((x) => x.params[3]), ['infrastructure', 'tooling']);
  assert.deepStrictEqual(w.inserted.map((x) => x.params[6]), ['monthly', 'monthly']);
  assert.strictEqual(w.inserted[1].params[4], 2000);
  assert.strictEqual(w.inserted[0].params[12], 'railway');
  const sqls = log.map((q) => q.sql);
  assert.strictEqual(sqls[0], 'BEGIN');
  assert.strictEqual(sqls[sqls.length - 1], 'COMMIT');
});

test('import: pasting the list again updates the matching bill, and keeps what the paste left out', async () => {
  const w = writeHandlers();
  const matches = [];
  const updates = [];
  handlers = [
    [/^SELECT .* FROM business_expenses WHERE lower\(vendor\)/, (p, sql) => {
      matches.push({ p, sql });
      return { rows: [dbRow({ id: 7, vendor: 'Railway', product: 'Pro', kind: 'infrastructure', amount_cents: 2000, cadence: 'monthly', renews_on: '2026-10-16', note: 'typed on the screen', verified: true })], rowCount: 1 };
    }],
    [/^UPDATE business_expenses SET vendor/, (p) => {
      updates.push(p);
      return { rows: [dbRow({ id: p[0], vendor: p[1], product: p[2], kind: p[4], amount_cents: p[5], cadence: p[7], renews_on: p[9], note: p[12] })], rowCount: 1 };
    }],
    ...w.handlers,
  ];
  const r = await req('POST', '/api/admin/expenses/import', { expenses: [{ vendor: 'railway', product: 'pro', kind: 'infrastructure', cadence: 'monthly', amount: 25 }] });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.updated, 1);
  assert.strictEqual(r.body.inserted, 0);
  assert.strictEqual(w.inserted.length, 0);
  assert.deepStrictEqual(matches[0].p, ['railway', 'pro', 'monthly'], 'matched on vendor, product and cadence');
  assert.match(matches[0].sql, /FOR UPDATE/, 'the row is locked between the read and the write');
  const u = updates[0];
  assert.strictEqual(u[0], 7, 'written back by id');
  assert.strictEqual(u[5], 2500, 'the pasted amount wins');
  assert.strictEqual(u[9], '2026-10-16', 'a renewal date the paste did not mention is kept');
  assert.strictEqual(u[12], 'typed on the screen', 'so is the note');
  assert.strictEqual(u[11], true, 'and the verified mark');
  assert.strictEqual(u[14], 9, 'stamped by the admin');
});

test('import: a failed write rolls the whole paste back', async () => {
  handlers = [
    NO_MATCH,
    [/^INSERT INTO business_expenses/, () => Promise.reject(new Error('disk full'))],
  ];
  const r = await req('POST', '/api/admin/expenses/import', [{ vendor: 'A', kind: 'other', cadence: 'monthly', amount: 1 }]);
  assert.strictEqual(r.status, 500);
  assert.ok(log.some((q) => q.sql === 'ROLLBACK'));
  assert.ok(!log.some((q) => q.sql === 'COMMIT'));
});

test('import refuses an empty list and one longer than the ceiling', async () => {
  handlers = [];
  let r = await req('POST', '/api/admin/expenses/import', { expenses: [] });
  assert.strictEqual(r.status, 400);
  r = await req('POST', '/api/admin/expenses/import', { expenses: Array.from({ length: 201 }, () => ({ vendor: 'A', kind: 'other', cadence: 'monthly', amount: 1 })) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /1 to 200/);
  assert.deepStrictEqual(log, []);
});

// ===========================================================================
// 6. THE COST ARITHMETIC
// ===========================================================================

const expense = (over) => ({
  id: 1, vendor: 'X', product: null, category: null, kind: 'other', amountCents: 0, currency: 'USD', cadence: 'monthly',
  lastChargedOn: null, renewsOn: null, active: true, verified: true, note: null, replacesLine: null, ...over,
});

test('a row that stands in for a code line counts once, and a lookalike is flagged rather than linked', () => {
  const base = moneyHub.buildCostPicture({ expenses: [], month: MONTH });
  const railway = base.lines.find((l) => l.id === 'railway');
  assert.strictEqual(railway.counted, true);

  const linked = moneyHub.buildCostPicture({
    expenses: [expense({ id: 1, vendor: 'Railway', kind: 'infrastructure', amountCents: 2500, replacesLine: 'railway' })],
    month: MONTH,
  });
  assert.strictEqual(linked.lines.find((l) => l.id === 'railway').counted, false);
  assert.strictEqual(linked.totals.perMonthCents, base.totals.perMonthCents - 2000 + 2500, 'the code $20 leaves and the row $25 arrives');
  assert.deepStrictEqual(linked.replaced.map((x) => x.id), ['railway']);
  assert.deepStrictEqual(linked.possibleDoubles, []);

  const unlinked = moneyHub.buildCostPicture({
    expenses: [expense({ id: 2, vendor: 'Railway', product: 'Pro plan', kind: 'infrastructure', amountCents: 2000 })],
    month: MONTH,
  });
  assert.strictEqual(unlinked.possibleDoubles.length, 1);
  assert.strictEqual(unlinked.possibleDoubles[0].codeLineId, 'railway');
  assert.strictEqual(unlinked.possibleDoubles[0].expenseId, 2);
});

test('tooling comes from the list; yearly is spread; one-time lands only in its own month; other currencies are named', () => {
  const lastMonth = moneyHub.__test.addMonthsYmd(MONTH.startYmd, -1);
  const pic = moneyHub.buildCostPicture({
    expenses: [
      expense({ id: 1, vendor: 'Tool', kind: 'tooling', amountCents: 2000, cadence: 'monthly', category: 'Developer tools' }),
      expense({ id: 2, vendor: 'State', kind: 'legal', amountCents: 12000, cadence: 'yearly', category: 'Company' }),
      expense({ id: 3, vendor: 'Filing', kind: 'legal', amountCents: 12500, cadence: 'one_time', lastChargedOn: MONTH.startYmd }),
      expense({ id: 4, vendor: 'Old filing', kind: 'legal', amountCents: 9000, cadence: 'one_time', lastChargedOn: lastMonth }),
      expense({ id: 5, vendor: 'Abroad', kind: 'other', amountCents: 1000, cadence: 'monthly', currency: 'EUR' }),
      expense({ id: 6, vendor: 'Stopped', kind: 'tooling', amountCents: 5000, cadence: 'monthly', active: false }),
    ],
    month: MONTH,
  });
  const kind = Object.fromEntries(pic.byKind.map((k) => [k.kind, k]));
  assert.strictEqual(kind.tooling.perMonthCents, 2000, 'an inactive row is kept on the list and out of the total');
  assert.strictEqual(kind.legal.perMonthCents, 1000, 'a yearly bill is a twelfth a month in the burn');
  assert.strictEqual(kind.legal.thisMonthCents, 1000 + 12500, 'a one-time bill dated this month is in this month only');
  assert.strictEqual(kind.other.perMonthCents, 0, 'a euro bill is not added into dollars');
  assert.deepStrictEqual(pic.nonUsd.map((x) => x.currency), ['EUR']);
  assert.ok(pic.byCategory.some((c) => c.category === 'Developer tools' && c.perMonthCents === 2000));
  assert.strictEqual(pic.totals.thisMonthCents - pic.totals.perMonthCents, 12500);
});

test('renewals in the next sixty days, typed or worked out from the last charge', () => {
  const soon = moneyHub.__test.addMonthsYmd(MONTH.todayYmd, 1);
  const pic = moneyHub.buildCostPicture({
    expenses: [
      expense({ id: 1, vendor: 'Typed', cadence: 'yearly', amountCents: 9900, renewsOn: soon }),
      expense({ id: 2, vendor: 'Monthly', cadence: 'monthly', amountCents: 2000, lastChargedOn: MONTH.startYmd }),
      expense({ id: 3, vendor: 'Far', cadence: 'yearly', amountCents: 1200, renewsOn: moneyHub.__test.addMonthsYmd(MONTH.todayYmd, 6) }),
      expense({ id: 4, vendor: 'Off', cadence: 'monthly', amountCents: 100, lastChargedOn: MONTH.startYmd, active: false }),
    ],
    month: MONTH,
  });
  const labels = pic.upcoming.map((u) => u.label);
  assert.ok(labels.includes('Typed'));
  assert.ok(labels.includes('Monthly'));
  assert.ok(!labels.includes('Far'), 'six months out is past the window');
  assert.ok(!labels.includes('Off'), 'an inactive bill does not renew');
  assert.strictEqual(pic.upcoming.find((u) => u.label === 'Typed').estimated, false);
  assert.strictEqual(pic.upcoming.find((u) => u.label === 'Monthly').estimated, true);
});

test('GET /costs carries the list\'s totals, so the Costs tab reads tooling from it', async () => {
  expenseRows = [{ id: 1, vendor: 'Tool', kind: 'tooling', amount_cents: 2000, cadence: 'monthly' }];
  handlers = [
    [/FROM business_expenses/, () => ({ rows: expenseRows.map(dbRow), rowCount: 1 })],
    [/FROM cost_reconciled/, () => ({ rows: [], rowCount: 0 })],
    [/.*/, () => ({ rows: [], rowCount: 0 })],
  ];
  const r = await req('GET', '/api/admin/costs');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.expenses.status, 'ok');
  assert.strictEqual(r.body.expenses.toolingMonthlyUsd, 20);
  assert.strictEqual(r.body.fixed.toolingMonthlyUsd, 0, 'no tooling bill is written into the code any more');
  assert.ok(r.body.expenses.burnMonthlyUsd > r.body.fixed.effectiveMonthlyUsd);
});

test('net and break-even: this month, the burn, and how many would cover it', async () => {
  seedStripe();
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const n = r.body.net;
  assert.strictEqual(n.revenueThisMonthCents, r.body.revenue.stripe.balance.netCents, 'with RevenueCat off, revenue is Stripe alone');
  assert.ok(n.revenueMissing.includes('app_store'), 'and it says the App Store is missing from it');
  assert.strictEqual(n.netThisMonthCents, n.revenueThisMonthCents - n.costsThisMonthCents);
  assert.deepStrictEqual(n.costsMissing, []);
  assert.strictEqual(n.burnCents, r.body.costs.totals.perMonthCents);
  const pro = n.breakEven.proWeb;
  assert.strictEqual(pro.source, 'stripe');
  assert.strictEqual(pro.priceCents, 399);
  assert.strictEqual(pro.needed, Math.ceil(n.burnCents / pro.netPerUnitCents));
  assert.strictEqual(n.breakEven.roost.priceCents, 10900, 'break-even uses what Stripe charges, even when the code disagrees');
  // Pro is sold in two stores, and one of them was not read: no count at all
  // rather than the web half passed off as the whole.
  assert.strictEqual(n.breakEven.payingPro, null, 'App Store subscribers are unknown, so paying Pro is unknown');
  assert.deepStrictEqual(n.breakEven.payingProMissing, ['app_store']);
  assert.strictEqual(n.recurringNetCents, null, 'the same for recurring revenue');
  assert.deepStrictEqual(n.recurringMissing, ['app_store']);
  assert.strictEqual(n.netBurnCents, null);
  assert.strictEqual(n.breakEven.payingRoost, 1, 'Roost is sold only on Stripe, so Stripe alone answers it');
});

test('with both stores read in full, paying Pro and recurring revenue add the App Store in', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'refuse' });
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const n = r.body.net;
  assert.strictEqual(r.body.revenue.revenuecat.subscribers.complete, true);
  assert.deepStrictEqual(n.revenueMissing, []);
  assert.strictEqual(n.breakEven.payingPro, 2, 'the paying web subscriber and the App Store one; the free code is not paying');
  const subs = r.body.revenue.stripe.subscriptions;
  const web = subs.pro.mrrNetCents + subs.roost.mrrNetCents + subs.other.mrrNetCents;
  assert.strictEqual(n.recurringNetCents, web + Math.round(399 * 0.7));
  assert.strictEqual(n.netBurnCents, n.burnCents - n.recurringNetCents);
});

// ===========================================================================
// 6b. A PARTIAL SOURCE IS NOT A WHOLE ONE
// ===========================================================================

test('a RevenueCat read that answers for some Pro accounts and not others keeps its tally out of every total', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'refuse' });
  rc.failIds.add('7');
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const sub = r.body.revenue.revenuecat.subscribers;
  assert.strictEqual(sub.status, 'ok', 'what did answer is still shown, labelled');
  assert.strictEqual(sub.failed, 1);
  assert.strictEqual(sub.complete, false);
  const n = r.body.net;
  assert.strictEqual(n.revenueParts.appStoreNetCents, null, 'a partial App Store sum is not App Store revenue');
  assert.ok(n.revenueMissing.includes('app_store_partial'));
  assert.strictEqual(n.revenueThisMonthCents, r.body.revenue.stripe.balance.netCents, 'the headline is Stripe alone, and says so');
  assert.strictEqual(n.recurringNetCents, null);
  assert.deepStrictEqual(n.recurringMissing, ['app_store_partial']);
  assert.strictEqual(n.breakEven.payingPro, null);
  assert.deepStrictEqual(n.breakEven.payingProMissing, ['app_store_partial']);
});

test('more Pro accounts than RevenueCat is asked about is a partial tally too', async () => {
  seedStripe();
  seedRevenueCat({ v2: 'refuse' });
  const cap = moneyHub.__test.RC_SUBSCRIBER_CAP;
  handlers = hubHandlers({ premiumIds: Array.from({ length: cap + 1 }, (_, i) => i + 1) });
  const r = await req('GET', '/api/admin/money');
  const sub = r.body.revenue.revenuecat.subscribers;
  assert.strictEqual(sub.checked, cap, 'only the first cap accounts are asked');
  assert.strictEqual(sub.capped, true);
  assert.strictEqual(sub.complete, false);
  assert.ok(r.body.net.revenueMissing.includes('app_store_partial'));
  assert.strictEqual(r.body.net.breakEven.payingPro, null);
});

test('an expense list that cannot be read leaves every net cost figure unread, not smaller', async () => {
  seedStripe();
  handlers = [[/FROM business_expenses/, () => Promise.reject(new Error('relation is locked'))], ...hubHandlers()];
  const r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.costs.status, 'error', 'the Costs card still says what it could read');
  assert.ok(r.body.costs.totals.perMonthCents > 0);
  const n = r.body.net;
  assert.strictEqual(n.costsThisMonthCents, null);
  assert.deepStrictEqual(n.costsMissing, ['expenses']);
  assert.strictEqual(n.burnCents, null);
  assert.strictEqual(n.netThisMonthCents, null);
  assert.ok(n.netMissing.includes('expenses'));
  assert.strictEqual(n.netBurnCents, null);
  assert.strictEqual(n.breakEven.proWeb.needed, null, 'no break-even from a burn that is missing its bills');
  assert.strictEqual(n.breakEven.roost.needed, null);
  assert.deepStrictEqual(n.breakEven.burnMissing, ['expenses']);
  assert.notStrictEqual(n.revenueThisMonthCents, null, 'revenue does not depend on the list, so it still stands');
});

test('a Stripe balance read that ran out of pages withholds the headline instead of showing it short', async () => {
  seedStripe();
  stripeState.balanceEndless = true;
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const bal = r.body.revenue.stripe.balance;
  assert.strictEqual(bal.truncated, true);
  assert.strictEqual(stripeState.params.balance.length, moneyHub.__test.BALANCE_MAX_PAGES, 'it read every page it is allowed');
  const n = r.body.net;
  assert.strictEqual(n.revenueThisMonthCents, null, 'a missing page can move the net either way, so no headline');
  assert.ok(n.revenueMissing.includes('stripe_partial'));
  assert.strictEqual(n.netThisMonthCents, null);
});

// ===========================================================================
// 6c. THE CACHE ANSWERS ONLY THE QUESTION IT WAS ASKED
// ===========================================================================

test('a new month is a new Stripe read, and last month\'s answer is dropped', async () => {
  seedStripe();
  handlers = hubHandlers();
  const lastDay = new Date('2026-09-30T23:58:00-04:00');
  const firstDay = new Date('2026-10-01T00:02:00-04:00');
  const sep = await moneyHub.buildMoneyHub({ db: pool, now: lastDay });
  const oct = await moneyHub.buildMoneyHub({ db: pool, now: firstDay });
  assert.strictEqual(sep.month.startYmd, '2026-09-01');
  assert.strictEqual(oct.month.startYmd, '2026-10-01');
  assert.strictEqual(oct.revenue.stripe.cached, false, 'four minutes later, but a different month: read again');
  const gtes = stripeState.params.balance.map((p) => p.created.gte);
  assert.deepStrictEqual(gtes, [moneyHub.monthOf('2026-09-30').startUnix, moneyHub.monthOf('2026-10-01').startUnix]);
  assert.deepStrictEqual(moneyHub.__test.cacheKeys().filter((k) => k.startsWith('stripe:')), ['stripe:2026-10-01']);
});

test('a new Pro account is a new RevenueCat read, not a cached tally that leaves them out', async () => {
  seedRevenueCat({ v2: 'refuse' });
  handlers = hubHandlers({ premiumIds: [5] });
  const first = await req('GET', '/api/admin/money');
  assert.strictEqual(first.body.revenue.revenuecat.subscribers.checked, 1);
  handlers = hubHandlers({ premiumIds: [5, 14] });
  const second = await req('GET', '/api/admin/money');
  assert.strictEqual(second.body.revenue.revenuecat.cached, false);
  assert.strictEqual(second.body.revenue.revenuecat.subscribers.checked, 2, 'the new subscriber is counted at once');
  assert.ok(rcCalls.some((u) => u.endsWith('/v1/subscribers/14')));
  assert.strictEqual(moneyHub.__test.cacheKeys().filter((k) => k.startsWith('revenuecat:')).length, 1, 'one answer held per source');
});

test('two reads in flight for different Pro accounts do not share an answer', async () => {
  seedRevenueCat({ v2: 'refuse' });
  const dbWith = (ids) => ({
    query: (sql) => {
      const text = String(sql).replace(/\s+/g, ' ');
      if (/SELECT id FROM users WHERE is_premium = true/.test(text)) return Promise.resolve({ rows: ids.map((id) => ({ id })) });
      if (/COUNT\(\*\)::int AS n FROM users WHERE is_premium = true/.test(text)) return Promise.resolve({ rows: [{ n: ids.length }] });
      return dispatch(sql);
    },
  });
  handlers = hubHandlers();
  const [a, b] = await Promise.all([
    moneyHub.buildMoneyHub({ db: dbWith([5]) }),
    moneyHub.buildMoneyHub({ db: dbWith([5, 14]) }),
  ]);
  assert.strictEqual(a.revenue.revenuecat.subscribers.checked, 1);
  assert.strictEqual(b.revenue.revenuecat.subscribers.checked, 2);
});

// ===========================================================================
// 6d. REVIEW FINDINGS, ONE TEST EACH
// ===========================================================================

test('a bill in another currency cannot take a code line out of the total', () => {
  const base = moneyHub.buildCostPicture({ expenses: [], month: MONTH });
  const pic = moneyHub.buildCostPicture({
    expenses: [expense({ id: 9, vendor: 'Railway', kind: 'infrastructure', amountCents: 1900, currency: 'EUR', replacesLine: 'railway' })],
    month: MONTH,
  });
  assert.strictEqual(pic.lines.find((l) => l.id === 'railway').counted, true, 'the $20 code line still counts');
  assert.strictEqual(pic.totals.perMonthCents, base.totals.perMonthCents, 'nothing left and nothing arrived');
  assert.deepStrictEqual(pic.replaced, []);
  assert.deepStrictEqual(pic.nonUsd, [{ label: 'Railway', amountCents: 1900, currency: 'EUR', replacesLine: 'railway' }]);
});

test('import: a bill another import inserted a moment earlier is merged into, not added twice', async () => {
  const w = writeHandlers();
  let matchCalls = 0;
  const conflictInserts = [];
  const updates = [];
  handlers = [
    // The first look finds nothing; the concurrent import commits the bill
    // before this one inserts, so the insert does nothing; the second look
    // finds the committed row.
    [/^SELECT .* FROM business_expenses WHERE lower\(vendor\)/, () => {
      matchCalls += 1;
      return matchCalls === 1
        ? { rows: [], rowCount: 0 }
        : { rows: [dbRow({ id: 31, vendor: 'Registrar', product: 'flockcorp.com', kind: 'infrastructure', amount_cents: 1108, cadence: 'yearly', renews_on: '2027-08-01' })], rowCount: 1 };
    }],
    [/^INSERT INTO business_expenses .* ON CONFLICT \(lower\(vendor\), lower\(COALESCE\(product, ''\)\), cadence\) DO NOTHING/, (p) => {
      conflictInserts.push(p);
      return { rows: [], rowCount: 0 };
    }],
    [/^UPDATE business_expenses SET vendor/, (p) => {
      updates.push(p);
      return { rows: [dbRow({ id: p[0], vendor: p[1], product: p[2], kind: p[4], amount_cents: p[5], cadence: p[7], renews_on: p[9] })], rowCount: 1 };
    }],
    ...w.handlers,
  ];
  const r = await req('POST', '/api/admin/expenses/import', [{ vendor: 'Registrar', product: 'flockcorp.com', kind: 'infrastructure', cadence: 'yearly', amount: 12.5 }]);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.inserted, 0);
  assert.strictEqual(r.body.updated, 1);
  assert.strictEqual(conflictInserts.length, 1, 'the import insert names the bill key');
  assert.strictEqual(w.inserted.length, 0, 'no plain insert that could duplicate the bill');
  assert.strictEqual(matchCalls, 2, 'the bill is read again after the insert found it taken');
  assert.strictEqual(updates[0][0], 31);
  assert.strictEqual(updates[0][5], 1250);
  assert.strictEqual(updates[0][9], '2027-08-01', 'and what the paste left out is kept');
});

test('the add and edit forms answer a duplicate bill with 409, not a server error', async () => {
  const duplicate = () => {
    const err = new Error('duplicate key value violates unique constraint "business_expenses_bill_key"');
    err.code = '23505';
    err.constraint = 'business_expenses_bill_key';
    return Promise.reject(err);
  };
  handlers = [[/^INSERT INTO business_expenses/, duplicate], [/^UPDATE business_expenses/, duplicate]];
  const bill = { vendor: 'Railway', product: 'Pro', kind: 'infrastructure', cadence: 'monthly', amount: 20 };
  let r = await req('POST', '/api/admin/expenses', bill);
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /already on the list/);
  r = await req('PUT', '/api/admin/expenses/5', bill);
  assert.strictEqual(r.status, 409, r.text);
});

test('the bill key is unique in the migration, so the database holds the rule and not only the import', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '080_business_expenses.sql'), 'utf8');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS business_expenses_bill_key\s+ON business_expenses \(lower\(vendor\), lower\(COALESCE\(product, ''\)\), cadence\)/);
});

test('a renewal retried and paid this month on an invoice from last month is in this month\'s money', async () => {
  seedStripe();
  // Created forty days before the month began, paid this month after retries.
  stripeState.invoices.push({
    id: 'in_retry', status: 'paid', amount_paid: 399, currency: 'usd', created: MONTH.startUnix - 40 * 86400,
    status_transitions: { paid_at: IN_MONTH_SEC }, parent: { subscription_details: { metadata: { app_user_id: '5' } } },
  });
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const inv = r.body.revenue.stripe.invoices;
  assert.strictEqual(inv.byProduct.pro.paidCents, 399 + 399);
  assert.strictEqual(inv.lookbackDays, moneyHub.__test.INVOICE_LOOKBACK_DAYS);
  const gte = stripeState.params.invoices[0].created.gte;
  assert.ok(gte <= MONTH.startUnix - 60 * 86400, 'the window reaches back past Stripe\'s two-month retry limit');
});

test('the App Store price is the newest full-price purchase, and two live prices for one product disagree', async () => {
  seedRevenueCat({ v2: 'refuse' });
  const older = new Date(IN_MONTH_SEC * 1000 - 20 * 86400000).toISOString();
  rc.subscribers = {
    // Lower id, NEWER purchase, higher price: the id order used to decide.
    5: { subscriber: { subscriptions: { flock_pro_monthly: { store: 'app_store', is_sandbox: false, period_type: 'normal', purchase_date: THIS_MONTH_ISO, expires_date: FUTURE_ISO, price: { amount: 4.99, currency: 'USD' } } } } },
    6: { subscriber: { subscriptions: { flock_pro_monthly: { store: 'app_store', is_sandbox: false, period_type: 'normal', purchase_date: older, expires_date: FUTURE_ISO, price: { amount: 3.99, currency: 'USD' } } } } },
    // An introductory price is a different price on purpose and is not compared.
    7: { subscriber: { subscriptions: { flock_pro_yearly: { store: 'app_store', is_sandbox: false, period_type: 'intro', purchase_date: THIS_MONTH_ISO, expires_date: FUTURE_ISO, price: { amount: 9.99, currency: 'USD' } } } } },
  };
  handlers = hubHandlers({ premiumIds: [5, 6, 7] });
  const r = await req('GET', '/api/admin/money');
  const prices = r.body.revenue.revenuecat.subscribers.appStorePrices;
  assert.strictEqual(prices.flock_pro_monthly.amountCents, 499, 'the newest purchase, not the last account in id order');
  assert.deepStrictEqual(prices.flock_pro_monthly.distinctAmountsCents, [399, 499]);
  assert.strictEqual(prices.flock_pro_yearly, undefined, 'the introductory price is not the product\'s price');
  const monthly = r.body.pricing.appStore.find((a) => a.productId === 'flock_pro_monthly');
  assert.strictEqual(monthly.verdict, 'mismatch');
  assert.match(monthly.words, /pay different full prices: \$3\.99, \$4\.99/);
});

test('a null App Store amount is unpriced, not a purchase that cost nothing', async () => {
  seedRevenueCat({ v2: 'refuse' });
  rc.subscribers = {
    5: { subscriber: { subscriptions: { flock_pro_monthly: { store: 'app_store', is_sandbox: false, period_type: 'normal', purchase_date: THIS_MONTH_ISO, expires_date: FUTURE_ISO, price: { amount: null, currency: 'USD' } } } } },
  };
  handlers = hubHandlers({ premiumIds: [5] });
  const r = await req('GET', '/api/admin/money');
  const app = r.body.revenue.revenuecat.subscribers.stores.app_store;
  assert.strictEqual(app.unpriced, 1);
  assert.strictEqual(app.mrrCents, 0);
  assert.strictEqual(r.body.revenue.revenuecat.subscribers.appStorePrices.flock_pro_monthly, undefined);
});

test('a key that can see more than one RevenueCat project is not allowed to pick one', async () => {
  seedRevenueCat({ v2: 'ok' });
  rc.projects = [{ id: 'proj1', name: 'Flock' }, { id: 'proj2', name: 'Something else' }];
  handlers = hubHandlers();
  let r = await req('GET', '/api/admin/money');
  const o = r.body.revenue.revenuecat.overview;
  assert.strictEqual(o.status, 'error');
  assert.match(o.reason, /more than one RevenueCat project/);
  assert.match(o.reason, /REVENUECAT_PROJECT_ID/);
  assert.ok(!rcCalls.some((u) => u.includes('/metrics/')), 'no figures were read from a guessed project');

  process.env.REVENUECAT_PROJECT_ID = 'proj2';
  moneyHub.__test.resetCache();
  rcCalls.length = 0;
  r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.body.revenue.revenuecat.overview.status, 'ok');
  assert.ok(rcCalls.some((u) => u.includes('/v2/projects/proj2/metrics/overview')), 'the configured project is the one read');
  assert.ok(!rcCalls.some((u) => /\/v2\/projects\?/.test(u)), 'and the project list is not consulted');
});

test('open disputes are read across every page, and only dollars are added', async () => {
  seedStripe();
  stripeState.disputePages = [
    [{ id: 'dp_a', status: 'needs_response', amount: 399, currency: 'usd' }, { id: 'dp_b', status: 'won', amount: 999, currency: 'usd' }],
    [{ id: 'dp_c', status: 'under_review', amount: 1500, currency: 'usd' }, { id: 'dp_d', status: 'needs_response', amount: 500, currency: 'eur' }],
  ];
  handlers = hubHandlers();
  const r = await req('GET', '/api/admin/money');
  const d = r.body.revenue.stripe.disputes;
  assert.strictEqual(stripeState.params.disputes.length, 2, 'the second page was read');
  assert.strictEqual(d.open, 2);
  assert.strictEqual(d.openAmountCents, 399 + 1500, 'euro cents are not added to dollar cents');
  assert.strictEqual(d.openOtherCurrency, 1);
  assert.strictEqual(d.truncated, false);
});

// ===========================================================================
// 7. EVERY STATED PRICE IS WHERE THE LIST SAYS
// ===========================================================================

test('every price in services/statedPrices.js is in its file, at its amount', () => {
  const REPO = path.join(__dirname, '..', '..');
  assert.ok(STATED_PRICES.length >= 8);
  for (const s of STATED_PRICES) {
    const file = path.join(REPO, s.file);
    // A private entry names a file the repository does not carry; only that
    // kind may be absent, and only then is it skipped.
    if (s.private && !fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const m = new RegExp(s.pattern).exec(text);
    assert.ok(m, `${s.id}: the pattern no longer finds a price in ${s.file}. Move the list and the file together.`);
    const found = Number(String(m[s.group]).replace(/,/g, ''));
    assert.strictEqual(found, s.usd, `${s.id}: ${s.file} says ${found}, the list says ${s.usd}`);
  }
  const runtime = STATED_PRICES.find((s) => s.runtime === 'VENUE_PRICE_USD');
  assert.strictEqual(adminRouter.__test.VENUE_PRICE_USD, runtime.usd);
});

test('every Roost trial the repo writes down is in its file, and is the trial checkout gives', () => {
  // A trial is not a Stripe price, so the hub cannot check it; this does.
  // venueBilling.js TRIAL_DAYS is what checkout actually sets.
  const REPO = path.join(__dirname, '..', '..');
  const { STATED_TRIALS } = require('../services/statedPrices');
  const { TRIAL_DAYS } = require('../services/venueBilling');
  assert.ok(STATED_TRIALS.length >= 5);
  for (const t of STATED_TRIALS) {
    const text = fs.readFileSync(path.join(REPO, t.file), 'utf8');
    const m = new RegExp(t.pattern).exec(text);
    assert.ok(m, `${t.id}: the pattern no longer finds a trial in ${t.file}. Move the list and the file together.`);
    assert.strictEqual(Number(m[t.group]), t.days, `${t.id}: ${t.file} says ${m[t.group]} days, the list says ${t.days}`);
    assert.strictEqual(t.days, TRIAL_DAYS, `${t.id}: the list says ${t.days} days and checkout gives ${TRIAL_DAYS}`);
  }
});

test('no stated price names a product Stripe does not sell', () => {
  // The retired $35 venue plan used to sit on this list as the one price
  // nothing could sell. Every product left on it has a Stripe price to be
  // checked against.
  const { PRICE_ENV } = require('../services/statedPrices');
  for (const s of STATED_PRICES) {
    assert.ok(PRICE_ENV[s.product] && PRICE_ENV[s.product][s.plan], `${s.id}: nothing in Stripe sells ${s.product} ${s.plan}`);
  }
});

test('the health block reads the collector from its own rows', async () => {
  handlers = hubHandlers({ collectorMinutesAgo: 20 });
  let r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.body.health.collector.state, 'fresh');
  assert.strictEqual(r.body.health.collector.rows24h, 3000);
  handlers = hubHandlers({ collectorMinutesAgo: 60 * 5 });
  r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.body.health.collector.state, 'late');
  handlers = hubHandlers({ collectorMinutesAgo: null });
  r = await req('GET', '/api/admin/money');
  assert.strictEqual(r.body.health.collector.state, 'stopped');
  assert.strictEqual(r.body.health.collector.latestAt, null);
});
