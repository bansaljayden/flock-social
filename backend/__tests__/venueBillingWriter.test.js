'use strict';
// ---------------------------------------------------------------------------
// THE ROOST WRITER AGAINST A REAL DATABASE.
//
// services/venueBilling.syncVenueSubscription writes the grant, the tier cache
// and the audit row in one statement. A unit test with a scripted pool can
// only check that the statement was sent; this one runs it on the real,
// migrated schema and then asks the real entitlement resolver what the venue
// holds, which is the only answer a paying venue ever experiences.
//
// Stripe is a fake in the require cache; the subscription it returns is the
// only input, exactly as in production, where the webhook re-reads Stripe
// rather than trusting an event body.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const subs = {};
// Every read, in order: the id, the status Stripe answered with, and the
// request options the caller passed. The answer is copied at the moment of the
// call, the way a real read returns what Stripe held when it was asked, so a
// test can change the subscription while a read is out and the read still
// answers with the old state.
const reads = [];
// Runs after each read has taken its answer, so a test can change the
// subscription between two reads of it.
let afterRead = null;
// The money side, for the refund tests: charges by id, the refunds on each
// charge, which invoices each PaymentIntent paid, and each invoice's parent.
const charges = {};
const refunds = {};
const invoicePayments = {};
const invoices = {};
// How an invoice was paid (invoice id to PaymentIntent), for a refund made by
// invoice, and every refund Stripe was asked to make, in order, and the
// PaymentIntents whose next refund Stripe fails.
const paidWith = {};
const refundsMade = [];
const failNextRefund = new Set();
// Checkout sessions that completed, by id, for a confirm.
const completedSessions = {};
// Every cancel Stripe was asked for, in order, with its request options, and
// the subscriptions whose next cancel Stripe fails.
const cancels = [];
const failNextCancel = new Set();
// Every customer deleted, in order (account deletion closes them), and the
// ones Stripe refuses to delete.
const deletedCustomers = [];
const refuseDeletes = new Set();
// Checkout, for the tests that buy: customers made, sessions made, sessions
// still open (payable) and the ones expired.
let customersMade = 0;
const sessionsMade = [];
const openSessions = [];
const expiredSessions = [];
// Sessions paid in the moment before an expire reaches them: the expire
// fails, the session reads complete, and what paying it made now exists.
const paidBeforeExpire = new Map();
// One page of a Stripe list, the way Stripe answers one: `limit` items (ten
// when none is asked for) after `starting_after`, and has_more when there are
// more, newest first as given.
function page(all, limit = 10, after = null) {
  const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
  return { data: all.slice(start, start + limit), has_more: start + limit < all.length };
}
function FakeStripe() {
  return {
    customers: {
      del: async (id) => {
        if (refuseDeletes.has(id)) throw Object.assign(new Error('simulated Stripe outage'), { statusCode: 500 });
        deletedCustomers.push(id);
        for (const s of Object.values(subs)) if (s && s.customer === id) s.status = 'canceled';
        return { id, deleted: true };
      },
      create: async (args, opts) => { customersMade += 1; return { id: `cus_MADE_${customersMade}`, metadata: args.metadata, idempotencyKey: opts && opts.idempotencyKey }; },
      // A deleted customer still answers, the way Stripe's does: deleted: true.
      retrieve: async (id) => (deletedCustomers.includes(id) ? { id, deleted: true } : { id }),
    },
    prices: {
      retrieve: async (id) => ({ id, unit_amount: id === 'price_roost_year' ? 99000 : 9900, currency: 'usd', recurring: { interval: id === 'price_roost_year' ? 'year' : 'month' } }),
    },
    checkout: {
      sessions: {
        // openSessions: sessions still payable, by customer.
        list: async ({ customer, status, limit, starting_after: after }) => page(
          status === 'open' ? openSessions.filter((s) => s.customer === customer).map((s) => ({ ...s })) : [], limit, after),
        expire: async (id) => {
          const i = openSessions.findIndex((s) => s.id === id);
          if (paidBeforeExpire.has(id)) {
            const pay = paidBeforeExpire.get(id);
            paidBeforeExpire.delete(id);
            if (i >= 0) openSessions.splice(i, 1);
            pay();
            throw Object.assign(new Error('simulated: the session is no longer open'), { statusCode: 400 });
          }
          expiredSessions.push(id);
          if (i >= 0) openSessions.splice(i, 1);
          return { id, status: 'expired' };
        },
        retrieve: async (id) => completedSessions[id] || openSessions.find((s) => s.id === id) || { id, status: 'expired' },
        create: async (args) => { sessionsMade.push(args); return { id: `cs_made_${sessionsMade.length}`, url: 'https://checkout.stripe.com/c/pay/made' }; },
      },
    },
    subscriptions: {
      // A deleted customer's subscriptions went with it.
      list: async ({ customer, limit, starting_after: after }) => page(
        deletedCustomers.includes(customer) ? [] : Object.values(subs).filter((s) => s && s.customer === customer).map((s) => ({ ...s })), limit, after),
      retrieve: async (id, params, options) => {
        const answer = subs[id] ? JSON.parse(JSON.stringify(subs[id])) : subs[id];
        reads.push({ id, status: answer ? answer.status : null, options: options || null });
        if (afterRead) afterRead(id);
        return answer;
      },
      cancel: async (id, params, options) => {
        if (failNextCancel.has(id)) {
          failNextCancel.delete(id);
          throw Object.assign(new Error('simulated Stripe outage'), { statusCode: 500 });
        }
        cancels.push({ id, options: options || null });
        if (subs[id]) subs[id].status = 'canceled';
        return { id, status: 'canceled' };
      },
    },
    charges: {
      retrieve: async (id) => (charges[id] ? JSON.parse(JSON.stringify(charges[id])) : null),
    },
    refunds: {
      list: async ({ charge }) => ({ data: (refunds[charge] || []).map((r) => ({ ...r })), has_more: false }),
      create: async (args, opts) => {
        if (failNextRefund.has(args.payment_intent)) {
          failNextRefund.delete(args.payment_intent);
          throw Object.assign(new Error('simulated Stripe outage'), { statusCode: 500 });
        }
        refundsMade.push({ args, options: opts || null });
        return { id: `re_made_${refundsMade.length}`, status: 'succeeded' };
      },
    },
    invoicePayments: {
      // By PaymentIntent (which invoices a charge paid), or by invoice (how an
      // invoice was paid).
      list: async ({ payment, invoice }) => {
        if (invoice) {
          const pi = paidWith[invoice];
          return { data: pi ? [{ id: `inpay_${invoice}`, invoice, status: 'paid', payment: { type: 'payment_intent', payment_intent: pi } }] : [], has_more: false };
        }
        return {
          data: (invoicePayments[payment.payment_intent] || []).map((inv, i) => ({ id: `inpay_${i}_${inv}`, invoice: inv, status: 'paid' })),
          has_more: false,
        };
      },
    },
    invoices: {
      retrieve: async (id) => invoices[id] || null,
    },
  };
}
require.cache[require.resolve('stripe')] = { id: require.resolve('stripe'), filename: require.resolve('stripe'), loaded: true, exports: FakeStripe };

const PG_PORT = pickEmbeddedPgPort('venueBillingWriter');
let pg;
let testPool;
let dataDir;
// Before config/database is required: its Pool reads these at require time,
// and backend/.env points at the live database. The admin router mounted near
// the end of this file brings modules with timers of their own, so the pool
// must not be able to reach anything but the test database even after its
// query and connect are handed back.
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_venuebilling_test`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
const appPool = require('../config/database');
const realQuery = appPool.query;
const realConnect = appPool.connect;

// A test may hold the grant write, the one statement services/venueBilling.js
// sends (it starts `WITH old AS`), to open the window between a sync's Stripe
// read and its write. Whichever way the writer reaches the database, a pooled
// query or a checked-out client, the write stops here until it is released.
let holdWrite = null;
async function maybeHold(text) {
  if (holdWrite && /^\s*WITH old AS/.test(String(text))) {
    const h = holdWrite;
    holdWrite = null;
    h.reached();
    await h.released;
  }
}
function armWriteHold() {
  let reached;
  let release;
  const writeReached = new Promise((r) => { reached = r; });
  const released = new Promise((r) => { release = r; });
  holdWrite = { reached, released };
  return { writeReached, release };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = {
  VENUE_BILLING_ENABLED: 'true',
  ADMIN_USER_IDS: '1',
  JWT_SECRET: 'venue-billing-writer-test-secret',
  STRIPE_SECRET_KEY: ['sk', 'test', 'z'.repeat(24)].join('_'),
  STRIPE_PRICE_ROOST_MONTHLY: 'price_roost_month',
  STRIPE_PRICE_ROOST_YEARLY: 'price_roost_year',
};
const savedEnv = {};

const venueBilling = require('../services/venueBilling');
const { getVenueEntitlement, resolveGrantedTier } = require('../services/venueEntitlements');

test.before(async () => {
  for (const [k, v] of Object.entries(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  dataDir = path.join(os.tmpdir(), `flock-venuebilling-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'venueBillingWriter', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_venuebilling_test');
  testPool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_venuebilling_test` });
  const { migrate } = require('../db/migrate');
  await migrate(testPool);
  appPool.query = async (text, params) => { await maybeHold(text); return testPool.query(text, params); };
  // A client of its own per checkout, wrapping the real one rather than
  // patching it, because the pool hands the same client object out again.
  appPool.connect = async () => {
    const client = await testPool.connect();
    return {
      query: async (text, params) => { await maybeHold(text); return client.query(text, params); },
      release: (err) => client.release(err),
    };
  };
});

test.after(async () => {
  appPool.query = realQuery;
  appPool.connect = realConnect;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await testPool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let n = 0;
async function venue({ verified, placeId = null }) {
  n += 1;
  const u = await testPool.query(
    "INSERT INTO users (email, password, name, role, email_verified) VALUES ($1, 'x', 'Owner', 'venue_owner', true) RETURNING id",
    [`owner${n}@example.com`]
  );
  const id = u.rows[0].id;
  // Created after Roost had a price (Terms 9.6), so these venues are in no
  // notice window and the grant alone decides: that is what this suite tests.
  // The window itself is services/roostNotice.js's, in roostNotice.test.js.
  await testPool.query(
    "INSERT INTO venue_profiles (user_id, business_name, verified, tier, created_at, google_place_id) VALUES ($1, 'The Owl', $2, 'free', '2026-10-01T12:00:00Z', $3)",
    [id, verified, placeId]
  );
  return id;
}

function sub(id, userId, status, extra = {}) {
  subs[id] = {
    id,
    status,
    customer: 'cus_W',
    metadata: { kind: 'venue', flock_venue_user_id: String(userId) },
    items: { data: [{ price: { id: 'price_roost_month' }, current_period_end: Math.floor(Date.now() / 1000) + 14 * 86400 }] },
    cancel_at: null,
    trial_end: null,
    ...extra,
  };
  return id;
}

// The subscription's one item, on the given price, with its current period
// ending at endUnix (seconds): for a test that needs that end exactly, or a
// period a year long.
function period(priceId, endUnix) {
  return { items: { data: [{ price: { id: priceId }, current_period_end: endUnix }] } };
}

async function state(userId) {
  const g = await testPool.query('SELECT tier, source, status, stripe_subscription_id, expires_at FROM venue_subscriptions WHERE user_id = $1', [userId]);
  const p = await testPool.query('SELECT tier FROM venue_profiles WHERE user_id = $1', [userId]);
  const a = await testPool.query("SELECT moderator_id, reason FROM moderation_actions WHERE target_user_id = $1 AND action = 'tier_changed' ORDER BY id", [userId]);
  const ent = await getVenueEntitlement(userId);
  return { grant: g.rows[0], cached: p.rows[0].tier, audit: a.rows, served: ent.tier };
}

test('a trial starts Roost: grant, cache and one audit row with no moderator, and the resolver serves it', async () => {
  const id = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_t1', id, 'trialing'));
  const s = await state(id);
  assert.strictEqual(s.grant.source, 'stripe');
  assert.strictEqual(s.grant.status, 'trialing');
  assert.ok(s.grant.expires_at, 'a Stripe grant always has an end date');
  assert.strictEqual(s.cached, 'pro');
  assert.strictEqual(s.served, 'pro');
  assert.strictEqual(s.audit.length, 1);
  assert.strictEqual(s.audit[0].moderator_id, null);
  assert.match(s.audit[0].reason, /^tier free -> pro: Stripe subscription sub_t1 trialing \(until \d{4}-\d{2}-\d{2}\)$/);

  // A replay (Stripe retries, events repeat) changes nothing and audits nothing.
  await venueBilling.syncVenueSubscription('sub_t1');
  assert.strictEqual((await state(id)).audit.length, 1);
});

test('a cancellation revokes, and says so in the audit log', async () => {
  const id = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_c1', id, 'active'));
  await venueBilling.syncVenueSubscription(sub('sub_c1', id, 'canceled'));
  const s = await state(id);
  assert.strictEqual(s.grant.status, 'canceled');
  assert.strictEqual(s.cached, 'free');
  assert.strictEqual(s.served, 'free');
  assert.deepStrictEqual(s.audit.map((r) => r.reason.split(':')[0]), ['tier free -> pro', 'tier pro -> free']);
});

test('the late deleted event of an old subscription cannot revoke a newer live one', async () => {
  const id = await venue({ verified: true });
  sub('sub_old', id, 'active');
  await venueBilling.syncVenueSubscription('sub_old');
  await venueBilling.syncVenueSubscription(sub('sub_new', id, 'active'));
  // sub_old is now cancelled at Stripe, and its event arrives last.
  await venueBilling.syncVenueSubscription(sub('sub_old', id, 'canceled'));
  const s = await state(id);
  assert.strictEqual(s.grant.stripe_subscription_id, 'sub_new');
  assert.strictEqual(s.served, 'pro');
});

test('an unverified venue with a live subscription is recorded but not served', async () => {
  const id = await venue({ verified: false });
  await venueBilling.syncVenueSubscription(sub('sub_u1', id, 'active'));
  const s = await state(id);
  assert.strictEqual(s.grant.status, 'active', 'the fact from Stripe is kept');
  assert.strictEqual(s.cached, 'free');
  assert.strictEqual(s.served, 'free', 'a role is not proof of ownership');
  assert.strictEqual(s.audit.length, 0);
});

test('a past-due card keeps Roost (a failed card is not a cancellation); unpaid ends it', async () => {
  const id = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_p1', id, 'past_due'));
  assert.strictEqual((await state(id)).served, 'pro');
  await venueBilling.syncVenueSubscription(sub('sub_p1', id, 'unpaid'));
  assert.strictEqual((await state(id)).served, 'free');
});

test('a live subscription on a price this server does not recognise keeps Roost through the period Stripe is billing', async () => {
  // It used to be written as tier free with expires_at now while Stripe went
  // on charging: a Price made in the dashboard, or STRIPE_PRICE_ROOST_* left
  // stale, and a paying venue lost Roost on the next event. Refusing the event
  // instead kept the PREVIOUS period's end date, which lost it three days
  // after that period while the new one was being billed.
  const id = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_x1', id, 'active'));
  const before = await state(id);
  assert.strictEqual(before.served, 'pro');

  const periodEnd = Math.floor(Date.now() / 1000) + 40 * 86400;
  sub('sub_x1', id, 'active', { items: { data: [{ price: { id: 'price_not_configured' }, current_period_end: periodEnd }] } });
  await venueBilling.syncVenueSubscription('sub_x1');
  const after = await state(id);
  assert.strictEqual(after.served, 'pro', 'a venue Stripe is still charging lost Roost over a price id');
  assert.strictEqual(after.cached, 'pro');
  assert.strictEqual(new Date(after.grant.expires_at).getTime(), periodEnd * 1000 + venueBilling.__test.GRACE_MS,
    'Roost runs to the end of the period Stripe is billing, plus the usual grace');
  assert.strictEqual(after.audit.length, before.audit.length, 'the tier did not change, so nothing is audited');

  // Once it has ended it revokes, whatever price it was on.
  sub('sub_x1', id, 'canceled', { items: { data: [{ price: { id: 'price_not_configured' } }] } });
  await venueBilling.syncVenueSubscription('sub_x1');
  assert.strictEqual((await state(id)).served, 'free');
});

// ---------------------------------------------------------------------------
// ONE SYNC PER VENUE AT A TIME. Two syncs for one venue used to overlap: A read
// the subscription while it was active, Stripe cancelled it, B read the
// cancellation and revoked Roost, and then A wrote its older active snapshot.
// SYNC_SQL lets a subscription overwrite its own row, so that restored Roost
// through the old period end plus grace, and no later event was coming to
// correct it. A scripted pool cannot show that a lock blocks anything, so these
// run on the real one.
// ---------------------------------------------------------------------------

// The venue sync lock as pg_locks shows it: the two-int form stores the
// namespace in classid and the account id in objid, with objsubid 2.
async function venueLock(userId) {
  const r = await testPool.query(
    `SELECT granted FROM pg_locks
      WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
    [venueBilling.__test.SYNC_LOCK_NAMESPACE, userId]
  );
  return { held: r.rows.filter((x) => x.granted).length, waiting: r.rows.filter((x) => !x.granted).length };
}

test('a sync that read the subscription active and writes late cannot restore Roost after a later sync revoked it', async () => {
  const id = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_race', id, 'active'));
  assert.strictEqual((await state(id)).served, 'pro');

  // Sync A reads the subscription while it is live, and its write is held.
  const hold = armWriteHold();
  const a = venueBilling.syncVenueSubscription('sub_race');
  await hold.writeReached;
  const lockWhileAWrites = await venueLock(id);

  // Stripe cancels it, and sync B starts for the cancellation.
  sub('sub_race', id, 'canceled');
  const readsBeforeB = reads.length;
  const b = venueBilling.syncVenueSubscription('sub_race');
  await sleep(300);
  const readsByBWhileAHeld = reads.slice(readsBeforeB).map((r) => r.status);
  const lockWhileBWaits = await venueLock(id);

  hold.release();
  await Promise.all([a, b]);
  const s = await state(id);
  assert.strictEqual(s.grant.status, 'canceled', 'the late write of an older active read restored a cancelled subscription');
  assert.strictEqual(s.cached, 'free');
  assert.strictEqual(s.served, 'free');
  assert.deepStrictEqual(s.audit.map((r) => r.reason.split(':')[0]), ['tier free -> pro', 'tier pro -> free']);

  // How: A held the venue's lock from before its Stripe read until its write
  // committed, and B read Stripe under that lock only after A let it go.
  assert.deepStrictEqual(lockWhileAWrites, { held: 1, waiting: 0 }, 'A reached its write without holding the venue lock');
  assert.deepStrictEqual(lockWhileBWaits, { held: 1, waiting: 1 }, 'B did not wait for the venue lock');
  assert.deepStrictEqual(readsByBWhileAHeld, ['canceled'], 'B read Stripe under the lock while A still held the venue');
  assert.strictEqual(reads[reads.length - 1].status, 'canceled', 'the last read is the one written last');
  assert.deepStrictEqual(await venueLock(id), { held: 0, waiting: 0 }, 'the lock ends with the transaction');
});

test('syncs for different venues do not wait on each other', async () => {
  const x = await venue({ verified: true });
  const y = await venue({ verified: true });
  sub('sub_vx', x, 'active');
  sub('sub_vy', y, 'active');
  const hold = armWriteHold();
  const slow = venueBilling.syncVenueSubscription('sub_vx');
  await hold.writeReached;
  const fast = await venueBilling.syncVenueSubscription('sub_vy');
  assert.strictEqual(fast.tier, 'pro', 'one venue\'s sync waited on another\'s');
  assert.strictEqual((await state(y)).served, 'pro');
  hold.release();
  assert.strictEqual((await slow).tier, 'pro');
  assert.strictEqual((await state(x)).served, 'pro');
});

test('the Stripe read under the lock is bounded inside the pool statement timeout, with no retry in place', async () => {
  const id = await venue({ verified: true });
  const before = reads.length;
  await venueBilling.syncVenueSubscription(sub('sub_bound', id, 'trialing'));
  const mine = reads.slice(before);
  assert.strictEqual(mine.length, 2, 'one read to find the venue, one under its lock');
  const locked = mine[1].options;
  assert.ok(locked, 'the locked read passed no options, so it would inherit three attempts of fifteen seconds');
  assert.strictEqual(locked.maxNetworkRetries, 0, 'a retry under the lock multiplies how long every other sync waits');
  assert.ok(Number.isFinite(locked.timeout) && locked.timeout > 0, `timeout ${locked.timeout}`);
  // A sync waits for the lock inside one statement, which the pool cancels at
  // its statement_timeout (0 switches the cap off, for one-shot scripts). The
  // lock is held for one bounded read, so a sync queued behind two others
  // still gets it in time.
  const poolTimeout = appPool.options.statement_timeout;
  assert.ok(Number.isInteger(poolTimeout), 'the pool no longer sets a statement timeout');
  assert.ok(poolTimeout === 0 || 2 * locked.timeout < poolTimeout,
    `two reads of ${locked.timeout}ms do not fit inside the pool's ${poolTimeout}ms statement timeout`);
});

test('a subscription that names another venue on the second read is refused, not written under the first venue\'s lock', async () => {
  const x = await venue({ verified: true });
  const y = await venue({ verified: true });
  sub('sub_moved', x, 'active');
  afterRead = (readId) => {
    if (readId !== 'sub_moved') return;
    subs.sub_moved.metadata.flock_venue_user_id = String(y);
    afterRead = null;
  };
  try {
    await assert.rejects(venueBilling.syncVenueSubscription('sub_moved'), /sub_moved/);
  } finally {
    afterRead = null;
  }
  const grants = await testPool.query('SELECT user_id FROM venue_subscriptions WHERE user_id = ANY($1::int[])', [[x, y]]);
  assert.deepStrictEqual(grants.rows, [], 'nothing is written from a read the lock did not cover');
  // Stripe's retry then starts again from the venue the subscription names now.
  await venueBilling.syncVenueSubscription('sub_moved');
  assert.strictEqual((await state(y)).served, 'pro');
  assert.strictEqual((await testPool.query('SELECT 1 FROM venue_subscriptions WHERE user_id = $1', [x])).rows.length, 0);
});

// ---------------------------------------------------------------------------
// A COMP LAID OVER A PAYING VENUE. POST /api/admin/venues/:userId/tier writes
// the comp onto the venue's one grant row and leaves the Stripe columns as they
// were, so the row still names the subscription the venue was paying on. That
// subscription's own events used to be let through by SYNC_SQL (the same
// subscription always overwrites its row), so the venue cancelling its plan
// after being comped ended the comp months early: the cancel_at_period_end
// update cut the six months down to the Stripe period plus grace, and the
// deleted event wrote 'canceled' and the cache 'free'. These run through the
// real admin route, because the row that route leaves is the input here.
// ---------------------------------------------------------------------------

let adminServer = null;
let adminBase = null;
async function adminCall(method, urlPath, { as, body } = {}) {
  if (!adminServer) {
    const http = require('node:http');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.set('io', null);
    app.use('/api/admin', require('../routes/admin'));
    adminServer = http.createServer(app);
    await new Promise((r) => adminServer.listen(0, '127.0.0.1', r));
    adminBase = `http://127.0.0.1:${adminServer.address().port}`;
  }
  const { signUserToken } = require('../middleware/auth');
  const res = await fetch(adminBase + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken({ id: as, token_version: 0 })}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}
test.after(async () => {
  if (adminServer) await new Promise((r) => adminServer.close(r));
});

async function admin() {
  n += 1;
  const u = await testPool.query(
    "INSERT INTO users (email, password, name, role, email_verified) VALUES ($1, 'x', 'Admin', 'admin', true) RETURNING id",
    [`admin${n}@example.com`]
  );
  return u.rows[0].id;
}

test('a comp over a paying venue survives that subscription being cancelled and ending', async () => {
  const id = await venue({ verified: true });
  const adminId = await admin();
  await venueBilling.syncVenueSubscription(sub('sub_comped', id, 'active'));
  assert.strictEqual((await state(id)).grant.source, 'stripe');

  const comp = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'founding_comp', reason: 'founding cohort' },
  });
  assert.strictEqual(comp.status, 200, comp.text);
  const compEnds = new Date(comp.body.expires_at).getTime();
  assert.ok(compEnds > Date.now() + 150 * 86400000, 'the founding comp runs six months');
  const comped = await state(id);
  assert.strictEqual(comped.grant.source, 'comp');
  assert.strictEqual(comped.grant.stripe_subscription_id, 'sub_comped', 'the comp leaves the old subscription on the row, which is the case under test');

  // The venue stops paying: Stripe marks it to cancel at the period end, and
  // the update event arrives while the subscription is still active.
  const periodEnd = Math.floor(Date.now() / 1000) + 14 * 86400;
  sub('sub_comped', id, 'active', { cancel_at: periodEnd, cancel_at_period_end: true });
  const update = await venueBilling.syncVenueSubscription('sub_comped');
  assert.strictEqual(update.written, false, 'a subscription ending before the comp was written over it');
  let s = await state(id);
  assert.strictEqual(s.grant.source, 'comp');
  assert.strictEqual(new Date(s.grant.expires_at).getTime(), compEnds, 'the comp was cut down to the Stripe period');
  assert.strictEqual(s.served, 'pro');

  // Then it ends, and the deleted event arrives.
  sub('sub_comped', id, 'canceled');
  await venueBilling.syncVenueSubscription('sub_comped');
  s = await state(id);
  assert.strictEqual(s.grant.status, 'active', 'the deleted event of the old subscription revoked the comp');
  assert.strictEqual(s.grant.source, 'comp');
  assert.strictEqual(new Date(s.grant.expires_at).getTime(), compEnds);
  assert.strictEqual(s.cached, 'pro');
  assert.strictEqual(s.served, 'pro');
  assert.ok(!s.audit.some((r) => /-> free/.test(r.reason)), 'an audit row records Roost being taken away');
});

test('a subscription still being paid takes the grant back once its period runs past the comp', async () => {
  const id = await venue({ verified: true });
  const adminId = await admin();
  await venueBilling.syncVenueSubscription(sub('sub_outlasts', id, 'active'));
  // Twenty days, past the 14-day period plus grace, so the comp's own date
  // stands and the row stays ours until a renewal outruns it.
  const comp = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'admin', durationDays: 20 },
  });
  assert.strictEqual(comp.status, 200, comp.text);
  assert.strictEqual((await state(id)).grant.source, 'admin');

  // The renewal at the end of the 14-day period carries the next month: the
  // venue is paying for longer than the comp covers, so the Stripe grant is
  // the one that keeps Roost on past the comp's end.
  const nextEnd = Math.floor(Date.now() / 1000) + 44 * 86400;
  const renewal = await venueBilling.syncVenueSubscription(sub('sub_outlasts', id, 'active', period('price_roost_month', nextEnd)));
  assert.strictEqual(renewal.written, true);
  const s = await state(id);
  assert.strictEqual(s.grant.source, 'stripe');
  assert.strictEqual(new Date(s.grant.expires_at).getTime(), nextEnd * 1000 + venueBilling.__test.GRACE_MS);
  assert.strictEqual(s.served, 'pro');
});

test('a comp that has lapsed does not hold back the subscription behind it', async () => {
  const id = await venue({ verified: true });
  const adminId = await admin();
  await venueBilling.syncVenueSubscription(sub('sub_after_comp', id, 'active'));
  const comp = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'demo', durationDays: 30 },
  });
  assert.strictEqual(comp.status, 200, comp.text);
  await testPool.query("UPDATE venue_subscriptions SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1", [id]);

  sub('sub_after_comp', id, 'canceled');
  const r = await venueBilling.syncVenueSubscription('sub_after_comp');
  assert.strictEqual(r.written, true, 'a dead comp kept a Stripe event from being recorded');
  const s = await state(id);
  assert.strictEqual(s.grant.source, 'stripe');
  assert.strictEqual(s.grant.status, 'canceled');
  assert.strictEqual(s.served, 'free');
});

// ---------------------------------------------------------------------------
// A GRANT WRITTEN OVER A LIVE STRIPE GRANT NEVER ENDS BEFORE IT. A yearly plan
// sends no event between renewals, so a comp that ended inside the paid year
// left the venue on free for the rest of it while Stripe billed it, and
// checkout refused it as already subscribed. Six months of founding comp over
// eleven paid months was exactly that.
// ---------------------------------------------------------------------------

const DAY_S = 86400;
const YEAR_S = 365 * DAY_S;

// What the resolver serves from the stored rows at a moment other than now.
async function servedAt(userId, atMs) {
  const s = await state(userId);
  return resolveGrantedTier({ tier: s.cached, grant_tier: s.grant.tier, grant_status: s.grant.status, expires_at: s.grant.expires_at }, atMs);
}

test('a founding comp over a yearly subscriber runs to the end of the paid year, and the renewal takes the row back', async () => {
  const id = await venue({ verified: true });
  const adminId = await admin();
  // Eleven months left on the yearly plan.
  const yearEnds = Math.floor(Date.now() / 1000) + 335 * DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_yearly', id, 'active', period('price_roost_year', yearEnds)));
  const paidThrough = yearEnds * 1000 + venueBilling.__test.GRACE_MS;
  assert.strictEqual(new Date((await state(id)).grant.expires_at).getTime(), paidThrough);

  const comp = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'founding_comp', reason: 'founding cohort' },
  });
  assert.strictEqual(comp.status, 200, comp.text);
  assert.strictEqual(new Date(comp.body.expires_at).getTime(), paidThrough,
    'the founding comp ended six months in, inside the year the venue paid for');
  const s = await state(id);
  assert.strictEqual(s.grant.source, 'comp');
  assert.strictEqual(s.grant.stripe_subscription_id, 'sub_yearly');
  assert.strictEqual(s.served, 'pro');
  // Seven months on: the six-month comp would have lapsed, and no Stripe
  // event arrives before the renewal to take the row back.
  const sevenMonths = new Date();
  sevenMonths.setUTCMonth(sevenMonths.getUTCMonth() + 7);
  assert.strictEqual(await servedAt(id, sevenMonths.getTime()), 'pro', 'a venue Stripe billed for the year was served free from month six');

  // The annual renewal carries the next year and hands the row back.
  const nextYearEnds = yearEnds + YEAR_S;
  const renewal = await venueBilling.syncVenueSubscription(sub('sub_yearly', id, 'active', period('price_roost_year', nextYearEnds)));
  assert.strictEqual(renewal.written, true);
  const after = await state(id);
  assert.strictEqual(after.grant.source, 'stripe');
  assert.strictEqual(new Date(after.grant.expires_at).getTime(), nextYearEnds * 1000 + venueBilling.__test.GRACE_MS);
  assert.strictEqual(after.served, 'pro');
});

test('an explicit end date over a live yearly subscription never ends before the paid year, and a later one stands', async () => {
  const shorter = await venue({ verified: true });
  const longer = await venue({ verified: true });
  const adminId = await admin();
  const yearEnds = Math.floor(Date.now() / 1000) + 200 * DAY_S;
  const paidThrough = yearEnds * 1000 + venueBilling.__test.GRACE_MS;
  await venueBilling.syncVenueSubscription(sub('sub_yearly_short', shorter, 'active', period('price_roost_year', yearEnds)));
  await venueBilling.syncVenueSubscription(sub('sub_yearly_long', longer, 'active', period('price_roost_year', yearEnds)));

  const a = await adminCall('POST', `/api/admin/venues/${shorter}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'paid', durationDays: 30 },
  });
  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(new Date(a.body.expires_at).getTime(), paidThrough,
    'a 30-day grant cut a paid year down to 30 days');
  assert.strictEqual((await state(shorter)).grant.source, 'admin');
  assert.strictEqual(await servedAt(shorter, Date.now() + 60 * DAY_S * 1000), 'pro');

  // The same through expiresAt, the other explicit form.
  const b = await adminCall('POST', `/api/admin/venues/${longer}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'paid', expiresAt: new Date(Date.now() + 400 * DAY_S * 1000).toISOString() },
  });
  assert.strictEqual(b.status, 200, b.text);
  const stands = new Date(b.body.expires_at).getTime();
  assert.ok(stands > paidThrough + 150 * DAY_S * 1000, 'a date later than the paid year is the grant\'s own and stands');
});

test('a past_due subscription is not a paid period: a grant over it keeps its own end', async () => {
  // past_due is a renewal Stripe could not collect. Its period end is not a
  // date the venue paid through, so lifting a 30-day grant to it would give a
  // venue that stopped paying the rest of an unpaid year.
  const id = await venue({ verified: true });
  const adminId = await admin();
  const yearEnds = Math.floor(Date.now() / 1000) + 300 * DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_yearly_unpaid', id, 'past_due', period('price_roost_year', yearEnds)));
  const unpaidEnd = yearEnds * 1000 + venueBilling.__test.GRACE_MS;

  const before = Date.now();
  const g = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'paid', durationDays: 30 },
  });
  assert.strictEqual(g.status, 200, g.text);
  const ends = new Date(g.body.expires_at).getTime();
  assert.ok(ends < unpaidEnd, 'a grant over a past_due row was lifted to the end of a year nobody paid for');
  assert.ok(Math.abs(ends - (before + 30 * DAY_S * 1000)) < 5 * 60 * 1000, 'the grant keeps its own 30 days');
});

test('an explicit date over an admin-written row, or a subscription that has ended, is taken as sent', async () => {
  const id = await venue({ verified: true });
  const adminId = await admin();
  await venueBilling.syncVenueSubscription(sub('sub_ended', id, 'active'));
  await venueBilling.syncVenueSubscription(sub('sub_ended', id, 'canceled'));
  assert.strictEqual((await state(id)).served, 'free');

  const r = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'demo', durationDays: 7 },
  });
  assert.strictEqual(r.status, 200, r.text);
  const ends = new Date(r.body.expires_at).getTime();
  assert.ok(Math.abs(ends - (Date.now() + 7 * DAY_S * 1000)) < 60000, `a dead subscription moved the end date to ${r.body.expires_at}`);

  // Our own grant can be shortened: only a Stripe grant is protected.
  const shorter = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'demo', durationDays: 2 },
  });
  assert.strictEqual(shorter.status, 200, shorter.text);
  assert.ok(Math.abs(new Date(shorter.body.expires_at).getTime() - (Date.now() + 2 * DAY_S * 1000)) < 60000);
});

test('an explicit null over a live Stripe grant is still a grant with no end date', async () => {
  const id = await venue({ verified: true });
  const adminId = await admin();
  await venueBilling.syncVenueSubscription(sub('sub_then_permanent', id, 'active'));
  const r = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'paid', expiresAt: null },
  });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.expires_at, null, 'the Stripe period end was written in place of no end date');
  assert.strictEqual((await state(id)).grant.expires_at, null);
});

test('an event from the same paid period hands a grant lifted to that period back to the subscription', async () => {
  const id = await venue({ verified: true });
  const adminId = await admin();
  const periodEnds = Math.floor(Date.now() / 1000) + 14 * DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_same_period', id, 'active', period('price_roost_month', periodEnds)));
  const comp = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'admin', durationDays: 7 },
  });
  assert.strictEqual(comp.status, 200, comp.text);
  const paidThrough = periodEnds * 1000 + venueBilling.__test.GRACE_MS;
  assert.strictEqual(new Date(comp.body.expires_at).getTime(), paidThrough);

  // The venue cancels at the period end. The subscription covers exactly what
  // the grant does, so it owns the row again: nobody has been billed for
  // anything we gave away, and its deleted event ends Roost as usual.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  let update;
  try {
    update = await venueBilling.syncVenueSubscription(sub('sub_same_period', id, 'active', {
      ...period('price_roost_month', periodEnds), cancel_at: periodEnds, cancel_at_period_end: true,
    }));
  } finally {
    console.error = realError;
  }
  assert.strictEqual(update.written, true, 'a grant ending with the paid period held the row against its own subscription');
  assert.ok(!errors.some((e) => /refund or cancel it in Stripe/.test(e)), `a refund was asked for with nothing given away: ${errors.join(' | ')}`);
  let s = await state(id);
  assert.strictEqual(s.grant.source, 'stripe');
  assert.strictEqual(new Date(s.grant.expires_at).getTime(), paidThrough);
  assert.strictEqual(s.served, 'pro');

  await venueBilling.syncVenueSubscription(sub('sub_same_period', id, 'canceled', period('price_roost_month', periodEnds)));
  s = await state(id);
  assert.strictEqual(s.grant.status, 'canceled');
  assert.strictEqual(s.served, 'free');
});

// ---------------------------------------------------------------------------
// A FULL REFUND ENDS WHAT IT PAID FOR, AND IT STAYS ENDED.
//
// The webhook used to acknowledge every refund event as ignored, and the
// subscription stayed the authority, so a venue whose $990 for the year was
// refunded in full kept the year of Roost: Stripe still called the
// subscription active, and every later event re-read it and wrote it again.
// A full refund of the payment for the current period now revokes the grant,
// records why (migration 118) and cancels the subscription, and a later event
// that still reads the subscription as active cannot put Roost back. A partial
// refund is a credit, not an ending, and changes nothing.
// ---------------------------------------------------------------------------

// The charge for `invoiceId`, paid through a PaymentIntent the way a
// subscription invoice is paid (Stripe API 2025-03-31 basil and later).
// The invoice carries a line for what it paid: the subscription's own item for
// a period ending at periodEnd (the subscription's current period unless the
// test names another), or, with proration, an adjustment.
function paidBy(chargeId, invoiceId, subscriptionId, amount, { periodEnd = null, proration = false } = {}) {
  const pi = `pi_${chargeId}`;
  charges[chargeId] = { id: chargeId, object: 'charge', amount, customer: 'cus_W', payment_intent: pi };
  invoicePayments[pi] = [invoiceId];
  const end = periodEnd || subs[subscriptionId].items.data[0].current_period_end;
  invoices[invoiceId] = {
    id: invoiceId,
    parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
    lines: { data: [periodLine(subscriptionId, end, proration)], has_more: false },
  };
}
function periodLine(subscriptionId, end, proration = false) {
  return proration
    ? { period: { start: end - 30 * DAY_S, end }, parent: { type: 'invoice_item_details', invoice_item_details: { subscription: subscriptionId, proration: true } } }
    : { period: { start: end - YEAR_S, end }, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: subscriptionId, proration: false } } };
}

async function yearlySubscriber(subId, invoiceId) {
  const id = await venue({ verified: true });
  const yearEnds = Math.floor(Date.now() / 1000) + 335 * DAY_S;
  await venueBilling.syncVenueSubscription(sub(subId, id, 'active', { ...period('price_roost_year', yearEnds), latest_invoice: invoiceId }));
  assert.strictEqual((await state(id)).served, 'pro');
  return id;
}

test('a full refund of the payment for the current period revokes Roost, records why, and cancels the subscription', async () => {
  const id = await yearlySubscriber('sub_refund_full', 'in_refund_full');
  paidBy('ch_refund_full', 'in_refund_full', 'sub_refund_full', 99000);
  refunds.ch_refund_full = [{ id: 're_full', status: 'succeeded', amount: 99000 }];

  const result = await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_full' });
  assert.deepStrictEqual(result.revoked, ['sub_refund_full']);
  const s = await state(id);
  assert.strictEqual(s.served, 'free', 'a venue whose year was refunded in full kept the year of Roost');
  assert.strictEqual(s.cached, 'free');
  assert.strictEqual(s.grant.status, 'refunded', 'the grant says why it ended');
  assert.ok(new Date(s.grant.expires_at).getTime() <= Date.now() + 1000, 'the grant ended now, not at the end of the refunded year');
  assert.deepStrictEqual(cancels.filter((c) => c.id === 'sub_refund_full').map((c) => c.options),
    [{ idempotencyKey: 'flock-refund-cancel-sub_refund_full' }], 'the refunded subscription was left to bill again next year');
  const ending = await testPool.query("SELECT cause, source_id, stripe_invoice_id FROM stripe_subscription_endings WHERE stripe_subscription_id = 'sub_refund_full'");
  assert.deepStrictEqual(ending.rows, [{ cause: 'refund', source_id: 'ch_refund_full', stripe_invoice_id: 'in_refund_full' }]);
  assert.ok(s.audit.some((r) => /^tier pro -> free: Stripe subscription sub_refund_full refunded/.test(r.reason)), 'the audit log says the refund ended it');
});

test('a later event that still reads the refunded subscription as active cannot put Roost back', async () => {
  const id = await yearlySubscriber('sub_refund_durable', 'in_refund_durable');
  paidBy('ch_refund_durable', 'in_refund_durable', 'sub_refund_durable', 99000);
  refunds.ch_refund_durable = [{ id: 're_durable', status: 'succeeded', amount: 99000 }];
  await venueBilling.revokeRefundedSubscription({ object: 'refund', id: 're_durable', charge: 'ch_refund_durable' });
  assert.strictEqual((await state(id)).served, 'free');

  // The cancel had not landed (or was undone by hand), and an update event
  // arrives with Stripe still calling the subscription active and paid
  // through the year.
  subs.sub_refund_durable.status = 'active';
  await venueBilling.syncVenueSubscription('sub_refund_durable');
  const s = await state(id);
  assert.strictEqual(s.served, 'free', 'a subscription update after a full refund restored Roost');
  assert.strictEqual(s.grant.status, 'refunded');
  // And a replay of the refund event records nothing twice.
  await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_durable' });
  const rows = await testPool.query("SELECT 1 FROM stripe_subscription_endings WHERE stripe_subscription_id = 'sub_refund_durable'");
  assert.strictEqual(rows.rows.length, 1);
});

test('a refund whose cancel failed is finished on the retry, even after the subscription renewed', async () => {
  // The ending was recorded, the cancel failed, the webhook answered 500, and
  // before Stripe sent the event again the subscription had renewed. The
  // refunded invoice no longer paid for the current period, so the retry gave
  // up, and Stripe went on billing a subscription the writer refuses to grant
  // for good. Only the recorded ending can finish it now.
  const id = await yearlySubscriber('sub_refund_retry', 'in_refund_retry');
  paidBy('ch_refund_retry', 'in_refund_retry', 'sub_refund_retry', 99000);
  refunds.ch_refund_retry = [{ id: 're_retry', status: 'succeeded', amount: 99000 }];
  failNextCancel.add('sub_refund_retry');
  await assert.rejects(venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_retry' }));
  assert.ok(!cancels.some((c) => c.id === 'sub_refund_retry'));
  // The renewal: the period moves a year on, with an invoice of its own.
  subs.sub_refund_retry.items.data[0].current_period_end += YEAR_S;
  subs.sub_refund_retry.latest_invoice = 'in_after_refund';
  const retry = await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_retry' });
  assert.deepStrictEqual(retry.revoked, ['sub_refund_retry'], `the retry gave up: ${JSON.stringify(retry)}`);
  assert.ok(cancels.some((c) => c.id === 'sub_refund_retry'), 'a recorded refund was never cancelled at Stripe');
  const s = await state(id);
  assert.strictEqual(s.grant.status, 'refunded');
  assert.strictEqual(s.served, 'free');
});

test('a partial refund is a credit, not an ending: Roost stays and nothing is cancelled', async () => {
  const id = await yearlySubscriber('sub_refund_part', 'in_refund_part');
  paidBy('ch_refund_part', 'in_refund_part', 'sub_refund_part', 99000);
  refunds.ch_refund_part = [{ id: 're_part', status: 'succeeded', amount: 20000 }];
  const result = await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_part' });
  assert.strictEqual(result.ignored, 'partial_refund');
  const s = await state(id);
  assert.strictEqual(s.served, 'pro', 'a partial refund took Roost away');
  assert.strictEqual(s.grant.status, 'active');
  assert.ok(!cancels.some((c) => c.id === 'sub_refund_part'), 'a partial refund cancelled the subscription');
  assert.strictEqual((await testPool.query("SELECT 1 FROM stripe_subscription_endings WHERE stripe_subscription_id = 'sub_refund_part'")).rows.length, 0);
});

test('only refunds that succeeded count: a full refund still pending changes nothing until it lands', async () => {
  const id = await yearlySubscriber('sub_refund_pending', 'in_refund_pending');
  paidBy('ch_refund_pending', 'in_refund_pending', 'sub_refund_pending', 99000);
  refunds.ch_refund_pending = [{ id: 're_pending', status: 'pending', amount: 99000 }];
  assert.strictEqual((await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_pending' })).ignored, 'partial_refund');
  assert.strictEqual((await state(id)).served, 'pro');
  // Two partial refunds that add up to the whole payment are a full refund.
  refunds.ch_refund_pending = [
    { id: 're_pending', status: 'succeeded', amount: 49500 },
    { id: 're_rest', status: 'succeeded', amount: 49500 },
  ];
  await venueBilling.revokeRefundedSubscription({ object: 'refund', id: 're_rest', charge: 'ch_refund_pending' });
  assert.strictEqual((await state(id)).served, 'free');
});

test('a full refund of an earlier period leaves the period being paid for now', async () => {
  // A goodwill refund of last month, after this month was paid: the money
  // that paid for today was not returned.
  const id = await yearlySubscriber('sub_refund_old', 'in_refund_now');
  const lastYearEnded = subs.sub_refund_old.items.data[0].current_period_end - YEAR_S;
  paidBy('ch_refund_old', 'in_refund_last', 'sub_refund_old', 9900, { periodEnd: lastYearEnded });
  refunds.ch_refund_old = [{ id: 're_old', status: 'succeeded', amount: 9900 }];
  const result = await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_old' });
  assert.ok(result.ignored, JSON.stringify(result));
  assert.strictEqual((await state(id)).served, 'pro');
  assert.ok(!cancels.some((c) => c.id === 'sub_refund_old'));
});

// The subscription's latest invoice is only the newest one made. A mid-period
// change makes a proration invoice that becomes the latest, so a full refund
// of a $10 adjustment cancelled a yearly plan whose $990 was still paid, and a
// full refund of the $990 itself, after a proration, left the year standing.
test('a full refund of a proration invoice is an adjustment: the paid year it came after stands', async () => {
  const id = await yearlySubscriber('sub_refund_prorate', 'in_refund_prorate_year');
  paidBy('ch_refund_prorate', 'in_refund_prorate', 'sub_refund_prorate', 1000, { proration: true });
  subs.sub_refund_prorate.latest_invoice = 'in_refund_prorate';
  refunds.ch_refund_prorate = [{ id: 're_prorate', status: 'succeeded', amount: 1000 }];
  const result = await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_prorate' });
  assert.strictEqual(result.ignored, 'not_current_roost_period', JSON.stringify(result));
  assert.strictEqual((await state(id)).served, 'pro', 'refunding a $10 adjustment took away a paid year');
  assert.ok(!cancels.some((c) => c.id === 'sub_refund_prorate'), 'a paid yearly plan was cancelled over an adjustment');
  assert.strictEqual((await testPool.query("SELECT 1 FROM stripe_subscription_endings WHERE stripe_subscription_id = 'sub_refund_prorate'")).rows.length, 0);
});

test('a full refund of the year\'s payment ends it, even after a later proration invoice', async () => {
  const id = await yearlySubscriber('sub_refund_year_then_prorate', 'in_year_then_prorate');
  paidBy('ch_year_then_prorate', 'in_year_then_prorate', 'sub_refund_year_then_prorate', 99000);
  subs.sub_refund_year_then_prorate.latest_invoice = 'in_later_proration';
  refunds.ch_year_then_prorate = [{ id: 're_year_then_prorate', status: 'succeeded', amount: 99000 }];
  const result = await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_year_then_prorate' });
  assert.deepStrictEqual(result.revoked, ['sub_refund_year_then_prorate'], `a year refunded in full stood behind an adjustment: ${JSON.stringify(result)}`);
  assert.strictEqual((await state(id)).served, 'free');
});

// ---------------------------------------------------------------------------
// A ROOST GRANT BELONGS TO ONE VENUE.
//
// venue_subscriptions is keyed on the owner's account and the subscription's
// metadata named only the account, while the venue a claim names can change:
// PUT /api/venue-profile re-points it at another listing and resets verified.
// An owner who subscribed for venue A, re-pointed the claim at venue B and got
// B verified was served the Roost A's subscription paid for. A grant is now
// bound to the listing it was bought or given for (migration 119).
// ---------------------------------------------------------------------------

// Two listings of its own for each test: one verified claim per listing is a
// unique index (migration 002), and these tests verify claims on both.
let placePairs = 0;
function placePair() {
  placePairs += 1;
  const tail = String(placePairs).padStart(4, '0');
  return [`ChIJbindingVenueA${tail}`, `ChIJbindingVenueB${tail}`];
}

// What PUT /api/venue-profile does to a claim re-pointed at another listing,
// then an admin's verify of the new one.
async function repointAndVerify(userId, placeId) {
  await testPool.query(
    'UPDATE venue_profiles SET google_place_id = $2, verified = false, verification_requested_at = NULL WHERE user_id = $1',
    [userId, placeId]
  );
  await testPool.query('UPDATE venue_profiles SET verified = true WHERE user_id = $1', [userId]);
}

function boundTo(placeId) {
  return (userId) => ({ kind: 'venue', flock_venue_user_id: String(userId), flock_venue_place_id: placeId });
}

test('a subscription bought for one venue is not served to the next venue the claim names', async () => {
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  await venueBilling.syncVenueSubscription(sub('sub_bound_a', id, 'active', { metadata: boundTo(PLACE_A)(id) }));
  assert.strictEqual((await state(id)).served, 'pro');

  await repointAndVerify(id, PLACE_B);
  assert.strictEqual((await state(id)).served, 'free', 'venue B was served the Roost venue A paid for');

  // The subscription's next event changes nothing: it still pays for A.
  await venueBilling.syncVenueSubscription('sub_bound_a');
  const s = await state(id);
  assert.strictEqual(s.served, 'free');
  const g = await testPool.query('SELECT google_place_id FROM venue_subscriptions WHERE user_id = $1', [id]);
  assert.strictEqual(g.rows[0].google_place_id, PLACE_A, 'the grant records the venue it was bought for');

  // Back on the listing it was bought for, it is served again.
  await repointAndVerify(id, PLACE_A);
  assert.strictEqual((await state(id)).served, 'pro');
});

test('a hand-made subscription with no listing in its metadata is bound to the listing the claim named when it arrived', async () => {
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  await venueBilling.syncVenueSubscription(sub('sub_bound_hand', id, 'active'));
  assert.strictEqual((await state(id)).served, 'pro');
  const rec = await testPool.query('SELECT user_id, google_place_id FROM venue_stripe_subscriptions WHERE stripe_subscription_id = $1', ['sub_bound_hand']);
  assert.deepStrictEqual(rec.rows, [{ user_id: id, google_place_id: PLACE_A }]);
  await repointAndVerify(id, PLACE_B);
  await venueBilling.syncVenueSubscription('sub_bound_hand');
  assert.strictEqual((await state(id)).served, 'free', 'the binding moved with the claim');
});

test('a hand-made subscription first seen on a claim with no listing binds to the first listing the claim names, and stays there', async () => {
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_bound_late', id, 'active'));
  // The claim gains its listing and is verified for it.
  await repointAndVerify(id, PLACE_A);
  await venueBilling.syncVenueSubscription('sub_bound_late');
  assert.strictEqual((await state(id)).served, 'pro');
  const rec = await testPool.query('SELECT google_place_id FROM venue_stripe_subscriptions WHERE stripe_subscription_id = $1', ['sub_bound_late']);
  assert.strictEqual(rec.rows[0].google_place_id, PLACE_A);
  // And it does not follow the claim on to the next one.
  await repointAndVerify(id, PLACE_B);
  await venueBilling.syncVenueSubscription('sub_bound_late');
  assert.strictEqual((await state(id)).served, 'free');
});

test('moving a plan to another listing is an explicit step: the subscription is re-bound in its metadata', async () => {
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  await venueBilling.syncVenueSubscription(sub('sub_moved_plan', id, 'active', { metadata: boundTo(PLACE_A)(id) }));
  await repointAndVerify(id, PLACE_B);
  assert.strictEqual((await state(id)).served, 'free');
  // An operator moves the plan: the subscription's metadata names B now.
  subs.sub_moved_plan.metadata = boundTo(PLACE_B)(id);
  await venueBilling.syncVenueSubscription('sub_moved_plan');
  assert.strictEqual((await state(id)).served, 'pro');
});

test('a comp is given to a venue, not to the account: it does not follow the claim to another listing', async () => {
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  const adminId = await admin();
  const comp = await adminCall('POST', `/api/admin/venues/${id}/tier`, {
    as: adminId, body: { tier: 'pro', grantReason: 'founding_comp', reason: 'founding cohort' },
  });
  assert.strictEqual(comp.status, 200, comp.text);
  assert.strictEqual((await state(id)).served, 'pro');
  await repointAndVerify(id, PLACE_B);
  assert.strictEqual((await state(id)).served, 'free', 'a founding comp given to venue A was served to venue B');
});

// The profile routes, mounted the way server.js mounts them.
let profileServer = null;
let profileBase = null;
async function profileCall(method, urlPath, { as, body } = {}) {
  if (!profileServer) {
    const http = require('node:http');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/venue-profile', require('../routes/venueProfile'));
    profileServer = http.createServer(app);
    await new Promise((r) => profileServer.listen(0, '127.0.0.1', r));
    profileBase = `http://127.0.0.1:${profileServer.address().port}`;
  }
  const { signUserToken } = require('../middleware/auth');
  const res = await fetch(profileBase + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken({ id: as, token_version: 0 })}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}
test.after(async () => {
  if (profileServer) await new Promise((r) => profileServer.close(r));
});

test('a claim paying for Roost cannot be re-pointed at another listing until the plan is ended or moved', async () => {
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  await venueBilling.syncVenueSubscription(sub('sub_listing_lock', id, 'active', { metadata: boundTo(PLACE_A)(id) }));

  const moved = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(moved.status, 409, `a paying claim was re-pointed at another listing: ${moved.text}`);
  assert.strictEqual(moved.body.code, 'ROOST_ON_LISTING');
  assert.ok(!/—/.test(moved.body.error), 'no em dash in what the owner reads');
  const p = await testPool.query('SELECT google_place_id, verified FROM venue_profiles WHERE user_id = $1', [id]);
  assert.deepStrictEqual(p.rows[0], { google_place_id: PLACE_A, verified: true }, 'the refused change still reset the claim');

  // Re-onboarding is the other door to the same column.
  const reclaimed = await profileCall('POST', '/api/venue-profile', { as: id, body: { businessName: 'The Owl', googlePlaceId: PLACE_B } });
  assert.strictEqual(reclaimed.status, 409, reclaimed.text);
  assert.strictEqual(reclaimed.body.code, 'ROOST_ON_LISTING');

  // Saving the same listing, or anything else, still works.
  const same = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_A, phone: '555 0100' } });
  assert.strictEqual(same.status, 200, same.text);

  // A plan set to end at its period end is the owner's decision made: the
  // listing can move, and the rest of the period is not carried with it.
  sub('sub_listing_lock', id, 'active', { metadata: boundTo(PLACE_A)(id), cancel_at: Math.floor(Date.now() / 1000) + 14 * 86400, cancel_at_period_end: true });
  await venueBilling.syncVenueSubscription('sub_listing_lock');
  const after = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(after.status, 200, after.text);
  await testPool.query('UPDATE venue_profiles SET verified = true WHERE user_id = $1', [id]);
  assert.strictEqual((await state(id)).served, 'free');
});

test('a plan whose cancel date is past its current period still renews, so it still holds the claim', async () => {
  // Stripe invoices every period until the cancel date, so a cancel date
  // months out (a dashboard "cancel on a date", a fixed-term founding plan)
  // has not set the plan to end. Any cancel date let the claim move, and the
  // plan went on renewing for a listing the claim had left.
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  const renews = Math.floor(Date.now() / 1000) + 20 * DAY_S;
  const cancellingOn = (cancelAt) => ({
    metadata: boundTo(PLACE_A)(id), ...period('price_roost_month', renews), cancel_at: cancelAt, cancel_at_period_end: false,
  });
  await venueBilling.syncVenueSubscription(sub('sub_cancels_later', id, 'active', cancellingOn(renews + 300 * DAY_S)));
  const moved = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(moved.status, 409, `a plan renewing in twenty days let its claim move: ${moved.text}`);
  assert.strictEqual(moved.body.code, 'ROOST_ON_LISTING');
  const reclaimed = await profileCall('POST', '/api/venue-profile', { as: id, body: { businessName: 'The Owl', googlePlaceId: PLACE_B } });
  assert.strictEqual(reclaimed.status, 409, reclaimed.text);

  // A cancel date at the period end ends the plan there, and the claim can move.
  await venueBilling.syncVenueSubscription(sub('sub_cancels_later', id, 'active', cancellingOn(renews)));
  const after = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(after.status, 200, after.text);
});

test('a hand-made plan bound to no listing lets its claim name a first listing, and then holds the claim there', async () => {
  // NULL IS DISTINCT FROM the requested listing was true, so a renewing plan
  // made for a claim with no listing refused every first listing with "Your
  // Roost plan is for the Google listing your venue has now", for a venue
  // that had none, and the bind-to-first-listing rule could never run.
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_unbound_first', id, 'active'));
  const bound = async () => (await testPool.query('SELECT google_place_id FROM venue_stripe_subscriptions WHERE stripe_subscription_id = $1', ['sub_unbound_first'])).rows[0].google_place_id;
  assert.strictEqual(await bound(), null);

  const first = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_A } });
  assert.strictEqual(first.status, 200, `a renewing plan bound to nothing refused the first listing: ${first.text}`);
  // Before Stripe's next event writes the binding down, the plan already
  // holds the claim on that first listing, on both write paths.
  const moved = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(moved.status, 409, `the plan followed the claim to a second listing: ${moved.text}`);
  assert.strictEqual(moved.body.code, 'ROOST_ON_LISTING');
  const reclaimed = await profileCall('POST', '/api/venue-profile', { as: id, body: { businessName: 'The Owl', googlePlaceId: PLACE_B } });
  assert.strictEqual(reclaimed.status, 409, reclaimed.text);
  // The next event binds the record to the listing the claim named first.
  await venueBilling.syncVenueSubscription('sub_unbound_first');
  assert.strictEqual(await bound(), PLACE_A);

  // Re-onboarding is the other door to a first listing.
  const [PLACE_C] = placePair();
  const other = await venue({ verified: true });
  await venueBilling.syncVenueSubscription(sub('sub_unbound_post', other, 'active'));
  const created = await profileCall('POST', '/api/venue-profile', { as: other, body: { businessName: 'The Owl', googlePlaceId: PLACE_C } });
  assert.strictEqual(created.status, 201, created.text);
});

test('after the documented move, the listing the claim names now can buy its own plan', async () => {
  // End the plan, move the claim, get the new listing verified: the steps
  // ROOST_LISTING_MSG gives. The old plan is active at Stripe until its year
  // ends, and checkout refused the new listing as already subscribed until then.
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  const adminId = await admin();
  await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_MOVED_ON' WHERE user_id = $1", [id]);
  const yearEnds = Math.floor(Date.now() / 1000) + 300 * DAY_S;
  const plan = (extra = {}) => ({ customer: 'cus_MOVED_ON', metadata: boundTo(PLACE_A)(id), ...period('price_roost_year', yearEnds), ...extra });
  await venueBilling.syncVenueSubscription(sub('sub_moved_on', id, 'active', plan()));
  await venueBilling.syncVenueSubscription(sub('sub_moved_on', id, 'active', plan({ cancel_at: yearEnds, cancel_at_period_end: true })));
  const moved = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(moved.status, 200, moved.text);
  const verified = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: true, googlePlaceId: PLACE_B } });
  assert.strictEqual(verified.status, 200, verified.text);

  const owner = { id, email: `owner-moved-${id}@example.com`, name: 'Owner' };
  const before = sessionsMade.length;
  await venueBilling.createVenueCheckout(owner, 'monthly');
  const session = sessionsMade[before];
  assert.ok(session, 'the new listing could not buy Roost until the old plan ran out');
  assert.strictEqual(session.metadata.flock_venue_place_id, PLACE_B);
  assert.ok(!('trial_period_days' in session.subscription_data), 'the account had its trial');

  // Back on the listing the old plan is for, that plan is the claim's again.
  await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_A } });
  await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: true, googlePlaceId: PLACE_A } });
  await assert.rejects(venueBilling.createVenueCheckout(owner, 'monthly'), (err) => err.code === 'ALREADY_SUBSCRIBED');
});

test('with venue billing switched off the listing guard is off too, on both write paths', async () => {
  // Nothing is enforced while VENUE_BILLING_ENABLED is off, and a profile
  // save that answered ROOST_ON_LISTING then changed a route's behaviour for
  // a feature that is not on.
  const [PLACE_A, PLACE_B] = placePair();
  const [PLACE_C] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  await venueBilling.syncVenueSubscription(sub('sub_listing_off', id, 'active', { metadata: boundTo(PLACE_A)(id) }));
  const saved = process.env.VENUE_BILLING_ENABLED;
  delete process.env.VENUE_BILLING_ENABLED;
  try {
    const moved = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
    assert.strictEqual(moved.status, 200, `a save was refused over a plan while billing is off: ${moved.text}`);
    const reclaimed = await profileCall('POST', '/api/venue-profile', { as: id, body: { businessName: 'The Owl', googlePlaceId: PLACE_C } });
    assert.strictEqual(reclaimed.status, 201, reclaimed.text);
  } finally {
    process.env.VENUE_BILLING_ENABLED = saved;
  }
  const p = await testPool.query('SELECT google_place_id FROM venue_profiles WHERE user_id = $1', [id]);
  assert.strictEqual(p.rows[0].google_place_id, PLACE_C);
  // Switched on, the same plan holds the claim where it is now.
  const held = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_A } });
  assert.strictEqual(held.status, 200, 'a move back to the listing the plan is for is never refused');
  const refused = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(refused.status, 409, refused.text);
  assert.strictEqual(refused.body.code, 'ROOST_ON_LISTING');
});

// ---------------------------------------------------------------------------
// A PLAN SOLD BY HAND IS ON RECORD WHERE THE PORTAL AND DELETION LOOK.
//
// The founding rate is sold by hand: an operator makes the subscription in the
// Stripe dashboard, with venue metadata, on a customer of their own making.
// The writer recorded it in venue_subscriptions, but venue_profiles'
// stripe_customer_id was only ever written by checkout, and the portal and
// account deletion read nothing else. The owner could not reach billing, and
// deleting the account skipped the cancellation and left the card billed.
// ---------------------------------------------------------------------------

function foundingSub(id, userId, customer) {
  return sub(id, userId, 'active', { customer, ...period('price_roost_founding', Math.floor(Date.now() / 1000) + 30 * DAY_S) });
}

test('a hand-sold subscription records its customer on the venue, so the owner can reach billing', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const id = await venue({ verified: true });
    await venueBilling.syncVenueSubscription(foundingSub('sub_founding_1', id, 'cus_FOUNDING_1'));
    assert.strictEqual((await state(id)).served, 'pro');
    const p = await testPool.query('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1', [id]);
    assert.strictEqual(p.rows[0].stripe_customer_id, 'cus_FOUNDING_1', 'the customer behind the plan was never put where the portal looks');
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
  }
});

test('a customer already on the venue is kept, and one held by another venue is never copied over', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const mine = await venue({ verified: true });
    const other = await venue({ verified: true });
    await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_FROM_CHECKOUT' WHERE user_id = $1", [mine]);
    await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_SHARED_BY_MISTAKE' WHERE user_id = $1", [other]);
    await venueBilling.syncVenueSubscription(foundingSub('sub_founding_2', mine, 'cus_FOUNDING_2'));
    const kept = await testPool.query('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1', [mine]);
    assert.strictEqual(kept.rows[0].stripe_customer_id, 'cus_FROM_CHECKOUT');

    // An operator who made the plan on another venue's customer: the sync
    // must still write the grant, not fail on the customer's unique index.
    const third = await venue({ verified: true });
    await venueBilling.syncVenueSubscription(foundingSub('sub_founding_3', third, 'cus_SHARED_BY_MISTAKE'));
    assert.strictEqual((await state(third)).served, 'pro');
    const none = await testPool.query('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1', [third]);
    assert.strictEqual(none.rows[0].stripe_customer_id, null);
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
  }
});

test('deleting the account closes every customer a Roost plan was recorded on, not only the one checkout made', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const id = await venue({ verified: true });
    await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_CHECKOUT_4' WHERE user_id = $1", [id]);
    await venueBilling.syncVenueSubscription(foundingSub('sub_founding_4', id, 'cus_FOUNDING_4'));
    const before = deletedCustomers.length;
    await venueBilling.closeVenueCustomer(id);
    assert.deepStrictEqual(deletedCustomers.slice(before).sort(), ['cus_CHECKOUT_4', 'cus_FOUNDING_4'],
      'the hand-sold plan\'s customer was left billing after the account went');
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
  }
});

test('a deletion that fails on a second customer says which plans it had already cancelled', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const id = await venue({ verified: true });
    await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_CHECKOUT_PART' WHERE user_id = $1", [id]);
    await venueBilling.syncVenueSubscription(sub('sub_part_checkout', id, 'active', { customer: 'cus_CHECKOUT_PART' }));
    await venueBilling.syncVenueSubscription(foundingSub('sub_part_founding', id, 'cus_FOUNDING_PART'));
    refuseDeletes.add('cus_FOUNDING_PART');
    let thrown = null;
    try {
      await venueBilling.closeVenueCustomer(id);
    } catch (err) {
      thrown = err;
    } finally {
      refuseDeletes.delete('cus_FOUNDING_PART');
    }
    assert.ok(thrown, 'a customer Stripe would not close was passed over');
    assert.deepStrictEqual(thrown.cancelledBefore, ['sub_part_checkout'], 'the plan already cancelled before the failure was not reported');
    // A retry finishes it, and reports what it ended.
    const done = await venueBilling.closeVenueCustomer(id);
    assert.deepStrictEqual(done.cancelled, ['sub_part_founding']);
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
  }
});

// ---------------------------------------------------------------------------
// A CUSTOMER TWO VENUES SHARE BELONGS TO NEITHER.
//
// An operator may make two venues' plans on one Stripe customer, and the
// writer allows it. Every customer on record was then treated as one account's
// alone: deleting either account deleted the customer, which cancels the other
// venue's plan too; Manage billing opened Stripe's portal on it, which lists
// and can cancel the other venue's plan and card; a revocation expired the
// other venue's open checkout.
// ---------------------------------------------------------------------------

async function twoVenuesOneCustomer(customer, tag) {
  const holder = await venue({ verified: true });
  const other = await venue({ verified: true });
  await testPool.query('UPDATE venue_profiles SET stripe_customer_id = $2 WHERE user_id = $1', [holder, customer]);
  await venueBilling.syncVenueSubscription(foundingSub(`sub_${tag}_holder`, holder, customer));
  await venueBilling.syncVenueSubscription(foundingSub(`sub_${tag}_other`, other, customer));
  return { holder, other };
}

test('deleting either account on a shared customer cancels only that account\'s plan, and keeps the customer', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const { holder, other } = await twoVenuesOneCustomer('cus_SHARED_DELETE', 'shared_delete');
    const deletedBefore = deletedCustomers.length;
    await venueBilling.closeVenueCustomer(other);
    assert.deepStrictEqual(deletedCustomers.slice(deletedBefore), [], 'a customer another venue pays through was deleted');
    assert.strictEqual(subs.sub_shared_delete_other.status, 'canceled', 'the departing venue\'s own plan was left billing');
    assert.strictEqual(subs.sub_shared_delete_holder.status, 'active', 'the other venue\'s plan was cancelled with the account');
    // The venue whose profile holds the customer, the same way round.
    await venueBilling.closeVenueCustomer(holder);
    assert.deepStrictEqual(deletedCustomers.slice(deletedBefore), []);
    assert.strictEqual(subs.sub_shared_delete_holder.status, 'canceled');
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
  }
});

test('a customer is shared when Stripe holds a plan on it for another account, recorded or not', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const id = await venue({ verified: true });
    await venueBilling.syncVenueSubscription(foundingSub('sub_unrecorded_mine', id, 'cus_UNRECORDED_SHARE'));
    // A plan on the same customer naming an account this database has no row for.
    sub('sub_unrecorded_theirs', 999999, 'active', { customer: 'cus_UNRECORDED_SHARE' });
    const deletedBefore = deletedCustomers.length;
    await venueBilling.closeVenueCustomer(id);
    assert.deepStrictEqual(deletedCustomers.slice(deletedBefore), []);
    assert.strictEqual(subs.sub_unrecorded_mine.status, 'canceled');
    assert.strictEqual(subs.sub_unrecorded_theirs.status, 'active');
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
  }
});

test('deleting an account on a shared customer expires its own open checkouts there, and no other venue\'s', async () => {
  // The customer stays for the other venue, and so did this account's open
  // checkout on it: paid after the account was gone, it became a plan billed
  // every period with nothing in Flock pointing at it.
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const { holder, other } = await twoVenuesOneCustomer('cus_SHARED_SESSIONS', 'shared_sessions');
    openSessions.push(
      { id: 'cs_shared_departing', customer: 'cus_SHARED_SESSIONS', status: 'open', metadata: { kind: 'venue', flock_venue_user_id: String(other) } },
      { id: 'cs_shared_staying', customer: 'cus_SHARED_SESSIONS', status: 'open', metadata: { kind: 'venue', flock_venue_user_id: String(holder) } },
    );
    const deletedBefore = deletedCustomers.length;
    await venueBilling.closeVenueCustomer(other);
    assert.ok(expiredSessions.includes('cs_shared_departing'), 'the deleted account\'s checkout stayed payable on the customer kept for another venue');
    assert.ok(!expiredSessions.includes('cs_shared_staying'), 'the other venue\'s checkout was expired with the account');
    assert.deepStrictEqual(deletedCustomers.slice(deletedBefore), []);
    assert.strictEqual(subs.sub_shared_sessions_other.status, 'canceled');
    assert.strictEqual(subs.sub_shared_sessions_holder.status, 'active');
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
    for (const id of ['cs_shared_departing', 'cs_shared_staying']) {
      const i = openSessions.findIndex((s) => s.id === id);
      if (i >= 0) openSessions.splice(i, 1);
    }
  }
});

test('a checkout paid while the deletion of its account was looking is among the plans the deletion cancels', async () => {
  // Read only before the checkouts are expired, the subscriptions would miss
  // one paid in between, and that plan would bill on for an account that is
  // gone. They are read again after.
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const { holder, other } = await twoVenuesOneCustomer('cus_SHARED_RACE', 'shared_race');
    openSessions.push({ id: 'cs_paid_mid_deletion', customer: 'cus_SHARED_RACE', status: 'open', metadata: { kind: 'venue', flock_venue_user_id: String(other) } });
    paidBeforeExpire.set('cs_paid_mid_deletion', () => {
      sub('sub_paid_mid_deletion', other, 'active', { customer: 'cus_SHARED_RACE' });
      completedSessions.cs_paid_mid_deletion = { id: 'cs_paid_mid_deletion', status: 'complete', subscription: 'sub_paid_mid_deletion' };
    });
    const done = await venueBilling.closeVenueCustomer(other);
    assert.strictEqual(subs.sub_paid_mid_deletion.status, 'canceled', 'a plan paid while the deletion was looking was left billing');
    assert.ok(done.cancelled.includes('sub_paid_mid_deletion'), 'the deletion did not say it ended that plan');
    assert.strictEqual(subs.sub_shared_race_holder.status, 'active');
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
    paidBeforeExpire.delete('cs_paid_mid_deletion');
  }
});

test('Manage billing never opens the portal on a shared customer, for either venue', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const { holder, other } = await twoVenuesOneCustomer('cus_SHARED_PORTAL', 'shared_portal');
    for (const who of [other, holder]) {
      await assert.rejects(venueBilling.createVenuePortal(who), (err) => {
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.code, 'SHARED_BILLING');
        assert.match(err.message, /social@flockcorp\.com/);
        assert.ok(!/—/.test(err.message));
        return true;
      }, 'the portal opened on a customer that holds another venue\'s plan and card');
    }
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
  }
});

test('revoking one venue\'s claim leaves the other venue\'s open checkout on a shared customer payable', async () => {
  process.env.STRIPE_PRICE_ROOST_FOUNDING = 'price_roost_founding';
  try {
    const { holder, other } = await twoVenuesOneCustomer('cus_SHARED_REVOKE', 'shared_revoke');
    const adminId = await admin();
    openSessions.push({ id: 'cs_shared_holder_open', customer: 'cus_SHARED_REVOKE', status: 'open', metadata: { kind: 'venue', flock_venue_user_id: String(holder) } });
    const res = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(other)}/verify`, { as: adminId, body: { verified: false } });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(!expiredSessions.includes('cs_shared_holder_open'), 'a revocation expired another venue\'s checkout');
    assert.strictEqual(subs.sub_shared_revoke_other.status, 'canceled');
    assert.strictEqual(subs.sub_shared_revoke_holder.status, 'active');
  } finally {
    delete process.env.STRIPE_PRICE_ROOST_FOUNDING;
    const i = openSessions.findIndex((s) => s.id === 'cs_shared_holder_open');
    if (i >= 0) openSessions.splice(i, 1);
  }
});

// ---------------------------------------------------------------------------
// A DELETION THAT FAILS DOES NOT HAND THE VENUE A SECOND TRIAL.
//
// routes/users.js closes the Roost customer before its deletion transaction,
// and closeVenueCustomer cleared venue_profiles.stripe_customer_id in a write
// of its own, committed. When DELETE FROM users then rolled back, the account
// stayed with no customer on file, the next checkout made a new one, and the
// trial asked only that new customer whether it had ever subscribed: a second
// 14 days, where Terms 9.6 promise one per venue.
// ---------------------------------------------------------------------------

test('a failed account deletion keeps the customer on file, and the next checkout starts with no trial', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_TRIAL_USED' WHERE user_id = $1", [id]);
  // The trial it had, and its end.
  await venueBilling.syncVenueSubscription(sub('sub_trial_used', id, 'trialing', { customer: 'cus_TRIAL_USED', metadata: boundTo(PLACE)(id) }));
  await venueBilling.syncVenueSubscription(sub('sub_trial_used', id, 'canceled', { customer: 'cus_TRIAL_USED', metadata: boundTo(PLACE)(id) }));

  // The deletion: Stripe closes the customer, then the transaction fails and
  // the account is still here.
  await venueBilling.closeVenueCustomer(id);
  assert.ok(deletedCustomers.includes('cus_TRIAL_USED'));
  const kept = await testPool.query('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1', [id]);
  assert.strictEqual(kept.rows[0].stripe_customer_id, 'cus_TRIAL_USED',
    'the customer was cleared outside the deletion transaction, so a rollback lost the record of it');

  // The owner comes back and subscribes.
  const before = sessionsMade.length;
  await venueBilling.createVenueCheckout({ id, email: `owner-again-${id}@example.com`, name: 'Owner' }, 'monthly');
  const session = sessionsMade[before];
  assert.ok(session, 'no checkout was made');
  assert.ok(!('trial_period_days' in session.subscription_data), 'a failed deletion handed the venue a second 14-day trial');
  assert.ok(!('trial_end' in session.subscription_data));
  // On a customer Stripe can still bill: the deleted one is replaced.
  assert.notStrictEqual(session.customer, 'cus_TRIAL_USED');
  const now = await testPool.query('SELECT stripe_customer_id FROM venue_profiles WHERE user_id = $1', [id]);
  assert.strictEqual(now.rows[0].stripe_customer_id, session.customer);
});

// ONE TRIAL PER VENUE OUTLIVES THE ACCOUNT THAT USED IT. The trial was read
// from two tables keyed on the account, both ON DELETE CASCADE, so an owner
// who took the trial, deleted the account and claimed the same listing from a
// new one was handed another 14 days on every cycle.
test('a deleted account takes its trial with it no more: a new account on the same listing starts without one', async () => {
  const [PLACE] = placePair();
  const first = await venue({ verified: true, placeId: PLACE });
  await venueBilling.syncVenueSubscription(sub('sub_trial_deleted', first, 'trialing', { customer: 'cus_TRIAL_DELETED', metadata: boundTo(PLACE)(first) }));
  // The account is deleted: its Stripe customer is closed and its rows go.
  await venueBilling.closeVenueCustomer(first);
  await testPool.query('DELETE FROM users WHERE id = $1', [first]);
  // Stripe's cancel event for the closed customer arrives after the account is gone.
  subs.sub_trial_deleted.status = 'canceled';
  await venueBilling.syncVenueSubscription('sub_trial_deleted');

  const again = await venue({ verified: true, placeId: PLACE });
  assert.strictEqual(await venueBilling.venueTrialUsed(again, PLACE), true, 'the listing\'s trial went with the account that used it');
  const before = sessionsMade.length;
  await venueBilling.createVenueCheckout({ id: again, email: `owner-new-${again}@example.com`, name: 'Owner' }, 'monthly');
  const session = sessionsMade[before];
  assert.ok(session, 'no checkout was made');
  assert.ok(!('trial_period_days' in session.subscription_data), 'a deleted account handed its listing a second 14-day trial');
  assert.ok(!('trial_end' in session.subscription_data));
  // What is kept names the listing and nothing about anyone.
  const kept = await testPool.query('SELECT * FROM roost_trial_listings WHERE google_place_id = $1', [PLACE]);
  assert.deepStrictEqual(Object.keys(kept.rows[0]).sort(), ['first_seen_at', 'google_place_id']);
});

test('a trial bought a moment before the account was deleted is on the listing\'s record from the cancel event alone', async () => {
  // The deletion's own cancel event can be the first event the writer sees.
  const [PLACE] = placePair();
  const gone = await venue({ verified: true, placeId: PLACE });
  sub('sub_trial_unseen', gone, 'canceled', { customer: 'cus_TRIAL_UNSEEN', metadata: boundTo(PLACE)(gone) });
  await testPool.query('DELETE FROM users WHERE id = $1', [gone]);
  await venueBilling.syncVenueSubscription('sub_trial_unseen');
  const again = await venue({ verified: true, placeId: PLACE });
  assert.strictEqual(await venueBilling.venueTrialUsed(again, PLACE), true);
});

// ---------------------------------------------------------------------------
// A REVOKED CLAIM STOPS BEING CHARGED.
//
// Un-verifying a claim (PUT /api/admin/venues/:profileId/verify with
// verified: false) neither expired an open Roost checkout nor cancelled the
// venue's subscription. The dashboard refused Roost from that moment, the
// sync only logged the unverified profile, and Stripe went on charging. Now
// the revocation expires every open checkout and cancels the plan at once.
// ---------------------------------------------------------------------------

async function profileIdOf(userId) {
  return (await testPool.query('SELECT id FROM venue_profiles WHERE user_id = $1', [userId])).rows[0].id;
}

test('revoking a claim cancels its Roost plan now and expires any checkout still open', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const adminId = await admin();
  await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_REVOKED' WHERE user_id = $1", [id]);
  await venueBilling.syncVenueSubscription(sub('sub_revoked', id, 'active', { customer: 'cus_REVOKED', metadata: boundTo(PLACE)(id) }));
  assert.strictEqual((await state(id)).served, 'pro');
  openSessions.push({ id: 'cs_open_revoked', customer: 'cus_REVOKED', status: 'open', metadata: { kind: 'venue', flock_venue_user_id: String(id) } });

  const res = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, {
    as: adminId, body: { verified: false, reason: 'not the owner after all' },
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.verified, false);
  assert.deepStrictEqual(cancels.filter((c) => c.id === 'sub_revoked').map((c) => c.options),
    [{ idempotencyKey: 'flock-claim-revoked-cancel-sub_revoked' }], 'a revoked claim went on being billed');
  assert.ok(expiredSessions.includes('cs_open_revoked'), 'a checkout left open could still be paid after the claim was revoked');
  assert.ok(!openSessions.some((s) => s.id === 'cs_open_revoked'));
  const s = await state(id);
  assert.strictEqual(s.grant.status, 'canceled', 'the grant was not written from the cancelled subscription');
  assert.strictEqual(s.served, 'free');
  assert.deepStrictEqual(res.body.roost, { checkoutsExpired: 1, subscriptionsCancelled: ['sub_revoked'] });
});

test('a revocation whose billing Stripe will not stop says so, and sending it again finishes the job', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const adminId = await admin();
  await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_REVOKE_FAILS' WHERE user_id = $1", [id]);
  await venueBilling.syncVenueSubscription(sub('sub_revoke_fails', id, 'active', { customer: 'cus_REVOKE_FAILS', metadata: boundTo(PLACE)(id) }));
  const profileId = await profileIdOf(id);

  const realKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  let first;
  try {
    first = await adminCall('PUT', `/api/admin/venues/${profileId}/verify`, { as: adminId, body: { verified: false } });
  } finally {
    process.env.STRIPE_SECRET_KEY = realKey;
  }
  assert.strictEqual(first.status, 502, first.text);
  assert.strictEqual(first.body.code, 'ROOST_NOT_STOPPED');
  assert.ok(!/—/.test(first.body.error));
  const p = await testPool.query('SELECT verified FROM venue_profiles WHERE user_id = $1', [id]);
  assert.strictEqual(p.rows[0].verified, false, 'the badge stays down: a billing failure must not keep it up');
  assert.ok(!cancels.some((c) => c.id === 'sub_revoke_fails'));

  const again = await adminCall('PUT', `/api/admin/venues/${profileId}/verify`, { as: adminId, body: { verified: false } });
  assert.strictEqual(again.status, 200, again.text);
  assert.ok(cancels.some((c) => c.id === 'sub_revoke_fails'));
});

test('a revocation reads every page: a running plan behind a hundred that ended is still cancelled', async () => {
  // It read one page of twenty subscriptions and twenty open checkouts, so a
  // plan older than twenty failed checkouts was never seen, and the
  // revocation answered success while Stripe went on billing it.
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const adminId = await admin();
  await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_MANY_ENDED' WHERE user_id = $1", [id]);
  // Newest first, as Stripe lists them: the failed checkouts, then the plan.
  for (let i = 0; i < 119; i += 1) sub(`sub_many_ended_${i}`, id, 'incomplete_expired', { customer: 'cus_MANY_ENDED', metadata: boundTo(PLACE)(id) });
  sub('sub_many_live', id, 'active', { customer: 'cus_MANY_ENDED', metadata: boundTo(PLACE)(id) });
  for (let i = 0; i < 25; i += 1) {
    openSessions.push({ id: `cs_many_${i}`, customer: 'cus_MANY_ENDED', status: 'open', metadata: { kind: 'venue', flock_venue_user_id: String(id) } });
  }
  const res = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: false } });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(cancels.some((c) => c.id === 'sub_many_live'), 'the revocation left the running plan billing');
  assert.deepStrictEqual(res.body.roost.subscriptionsCancelled, ['sub_many_live']);
  assert.deepStrictEqual(openSessions.filter((s) => s.customer === 'cus_MANY_ENDED'), [], 'a checkout past the first page stayed payable');
});

// ---------------------------------------------------------------------------
// A PURCHASE ALREADY DELIVERED IS NEVER REFUSED AT FULFILLMENT.
//
// Fulfillment checks the claim again and refunds a purchase made against a
// claim that is no longer good. It ran again for any completed session handed
// back (the old success link, a confirm sent by hand, Stripe resending the
// event) and judged the claim as it was then, so a yearly plan used for
// months, set to end and its claim moved on, had its $990 refunded.
// ---------------------------------------------------------------------------

function completedCheckout(id, subId, userId, placeId, invoiceId) {
  completedSessions[id] = {
    id, object: 'checkout.session', mode: 'subscription', status: 'complete',
    subscription: subId, invoice: invoiceId, payment_status: 'paid', metadata: boundTo(placeId)(userId),
  };
  paidWith[invoiceId] = `pi_${invoiceId}`;
  return completedSessions[id];
}
const completedEvent = (session) => ({ type: 'checkout.session.completed', data: { object: session } });

test('a checkout handed back after the plan was used and its claim moved on is not cancelled or refunded', async () => {
  const [PLACE_A, PLACE_B] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  const yearEnds = Math.floor(Date.now() / 1000) + 300 * DAY_S;
  sub('sub_delivered', id, 'active', { metadata: boundTo(PLACE_A)(id), ...period('price_roost_year', yearEnds) });
  const session = completedCheckout('cs_delivered', 'sub_delivered', id, PLACE_A, 'in_delivered');
  const first = await venueBilling.handleVenueEvent(completedEvent(session));
  assert.strictEqual(first.tier, 'pro');
  const served = await testPool.query('SELECT served_at FROM venue_stripe_subscriptions WHERE stripe_subscription_id = $1', ['sub_delivered']);
  assert.ok(served.rows[0].served_at, 'serving the plan was not recorded');

  // Months on, the owner sets the plan to end and moves the claim, as
  // ROOST_LISTING_MSG tells them to.
  sub('sub_delivered', id, 'active', { metadata: boundTo(PLACE_A)(id), ...period('price_roost_year', yearEnds), cancel_at: yearEnds, cancel_at_period_end: true });
  await venueBilling.syncVenueSubscription('sub_delivered');
  const moved = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(moved.status, 200, moved.text);

  const cancelsBefore = cancels.length;
  const refundsBefore = refundsMade.length;
  // Stripe resends the event, and the owner reopens the old success link.
  const replay = await venueBilling.handleVenueEvent(completedEvent(session));
  assert.ok(!replay.refused, 'a delivered purchase was refused');
  const confirmed = await venueBilling.confirmVenueCheckout(id, 'cs_delivered');
  assert.deepStrictEqual(confirmed, { complete: true, tier: 'free' });
  assert.strictEqual(cancels.length, cancelsBefore, 'the rest of a plan set to end was cancelled');
  assert.deepStrictEqual(refundsMade.slice(refundsBefore), [], 'the first payment of a plan used for months was refunded');

  // Once it has ended, the same.
  sub('sub_delivered', id, 'canceled', { metadata: boundTo(PLACE_A)(id), ...period('price_roost_year', yearEnds), ended_at: Math.floor(Date.now() / 1000) });
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.deepStrictEqual(refundsMade.slice(refundsBefore), [], 'an ended plan was refunded on a replay');
});

test('after the documented move, the old plan\'s later events never take the grant from the new listing\'s plan', async () => {
  // Checkout sells the listing the claim names now a plan of its own while
  // the old one runs out its period, and the account has one grant row. Any
  // live event of the old plan (an update, a resent checkout, the old success
  // link) wrote that row back to the old listing, and the new plan, paid for,
  // served nothing until its own next event, up to a year away. The listing
  // guard read the old plan's cancel date off the row and let the claim move
  // again while the new plan renewed.
  const [PLACE_A, PLACE_B] = placePair();
  const [PLACE_C] = placePair();
  const id = await venue({ verified: true, placeId: PLACE_A });
  const adminId = await admin();
  await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_TWO_PLANS' WHERE user_id = $1", [id]);
  const yearEnds = Math.floor(Date.now() / 1000) + 300 * DAY_S;
  const oldPlan = (extra = {}) => ({ customer: 'cus_TWO_PLANS', metadata: boundTo(PLACE_A)(id), ...period('price_roost_year', yearEnds), ...extra });
  sub('sub_old_listing', id, 'active', oldPlan());
  const oldCheckout = completedCheckout('cs_old_listing', 'sub_old_listing', id, PLACE_A, 'in_old_listing');
  await venueBilling.handleVenueEvent(completedEvent(oldCheckout));
  assert.strictEqual((await state(id)).served, 'pro');

  // Set to end, the claim moved, the new listing verified.
  await venueBilling.syncVenueSubscription(sub('sub_old_listing', id, 'active', oldPlan({ cancel_at: yearEnds, cancel_at_period_end: true })));
  const moved = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_B } });
  assert.strictEqual(moved.status, 200, moved.text);
  const verified = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: true, googlePlaceId: PLACE_B } });
  assert.strictEqual(verified.status, 200, verified.text);

  // The new listing buys its own plan, and it is served.
  await venueBilling.createVenueCheckout({ id, email: `owner-two-plans-${id}@example.com`, name: 'Owner' }, 'monthly');
  await venueBilling.syncVenueSubscription(sub('sub_new_listing', id, 'active', { customer: 'cus_TWO_PLANS', metadata: boundTo(PLACE_B)(id) }));
  assert.strictEqual((await state(id)).served, 'pro');

  // The old plan, still active until its year ends: an update event, Stripe
  // resending its completed checkout, and the owner's old success link.
  const cancelsBefore = cancels.length;
  const refundsBefore = refundsMade.length;
  await venueBilling.syncVenueSubscription('sub_old_listing');
  await venueBilling.handleVenueEvent(completedEvent(oldCheckout));
  const confirmed = await venueBilling.confirmVenueCheckout(id, 'cs_old_listing');
  assert.ok(!confirmed.refused);
  let s = await state(id);
  assert.strictEqual(s.grant.stripe_subscription_id, 'sub_new_listing', 'the old listing\'s plan took the grant back');
  assert.strictEqual(s.served, 'pro', 'the new listing\'s paid plan stopped being served');
  assert.strictEqual(cancels.length, cancelsBefore);
  assert.deepStrictEqual(refundsMade.slice(refundsBefore), []);
  // The plan that renews still holds the claim where it is.
  const third = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE_C } });
  assert.strictEqual(third.status, 409, `the claim moved off a renewing plan: ${third.text}`);
  assert.strictEqual(third.body.code, 'ROOST_ON_LISTING');

  // The old plan's year runs out, and its end changes nothing either.
  sub('sub_old_listing', id, 'canceled', oldPlan({ ended_at: Math.floor(Date.now() / 1000) }));
  await venueBilling.syncVenueSubscription('sub_old_listing');
  s = await state(id);
  assert.strictEqual(s.grant.stripe_subscription_id, 'sub_new_listing');
  assert.strictEqual(s.served, 'pro');
});

test('a checkout handed back after an admin revoked the claim refunds nothing: that refund is a person\'s call', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const adminId = await admin();
  await testPool.query("UPDATE venue_profiles SET stripe_customer_id = 'cus_DELIVERED_REVOKED' WHERE user_id = $1", [id]);
  sub('sub_delivered_revoked', id, 'active', { customer: 'cus_DELIVERED_REVOKED', metadata: boundTo(PLACE)(id) });
  const session = completedCheckout('cs_delivered_revoked', 'sub_delivered_revoked', id, PLACE, 'in_delivered_revoked');
  await venueBilling.handleVenueEvent(completedEvent(session));
  const revoked = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: false } });
  assert.strictEqual(revoked.status, 200, revoked.text);
  const refundsBefore = refundsMade.length;
  const again = await venueBilling.confirmVenueCheckout(id, 'cs_delivered_revoked');
  assert.ok(!again.refused);
  assert.deepStrictEqual(refundsMade.slice(refundsBefore), [], 'a confirm after a revocation refunded what the admin left for a person to decide');
});

test('a purchase completed against a claim revoked before it was ever served is still cancelled and refunded, once', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: false, placeId: PLACE });
  sub('sub_never_served', id, 'active', { metadata: boundTo(PLACE)(id) });
  const session = completedCheckout('cs_never_served', 'sub_never_served', id, PLACE, 'in_never_served');
  // Stripe's created event arrives first and records it, unserved.
  await venueBilling.syncVenueSubscription('sub_never_served');
  const result = await venueBilling.handleVenueEvent(completedEvent(session));
  assert.strictEqual(result.refused, 'CLAIM_NOT_VERIFIED');
  assert.ok(cancels.some((c) => c.id === 'sub_never_served'), 'a purchase never delivered was left billing');
  assert.deepStrictEqual(refundsMade.filter((r) => r.args.payment_intent === 'pi_in_never_served').map((r) => r.options),
    [{ idempotencyKey: 'flock-claim-revoked-refund-in_never_served' }]);
});

// A PURCHASE FOR AN ACCOUNT THAT IS GONE. A deletion that keeps a customer
// another venue shares cancels only the plans it finds there, so a checkout
// paid in the moment after it looked became a plan naming an account that no
// longer exists. Fulfillment only wrote it from Stripe, which records nothing
// for a missing account, and Stripe renewed it every period.
test('a purchase still billing for an account that is gone is cancelled and refunded at fulfillment, once', async () => {
  const [PLACE] = placePair();
  const gone = await venue({ verified: true, placeId: PLACE });
  await testPool.query('DELETE FROM users WHERE id = $1', [gone]);
  sub('sub_paid_after_gone', gone, 'active', { customer: 'cus_KEPT_FOR_ANOTHER', metadata: boundTo(PLACE)(gone) });
  const session = completedCheckout('cs_paid_after_gone', 'sub_paid_after_gone', gone, PLACE, 'in_paid_after_gone');
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.deepStrictEqual(cancels.filter((c) => c.id === 'sub_paid_after_gone').map((c) => c.options),
    [{ idempotencyKey: 'flock-account-deleted-cancel-sub_paid_after_gone' }], 'a plan for an account that no longer exists was left billing');
  const refunded = () => refundsMade.filter((r) => r.args.payment_intent === 'pi_in_paid_after_gone');
  assert.deepStrictEqual(refunded().map((r) => [r.args.metadata, r.options]),
    [[{ flock_reason: 'account_deleted' }, { idempotencyKey: 'flock-account-deleted-refund-in_paid_after_gone' }]],
    'the payment for a plan nobody can be served was kept');
  // Stripe sends it again: the plan has ended, so nothing more happens.
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.strictEqual(cancels.filter((c) => c.id === 'sub_paid_after_gone').length, 1);
  assert.strictEqual(refunded().length, 1);

  // A plan an operator has since moved to another account is that account's.
  const keeper = await venue({ verified: true });
  sub('sub_moved_off_gone', keeper, 'active', { customer: 'cus_KEPT_FOR_ANOTHER' });
  await venueBilling.handleVenueEvent(completedEvent(completedCheckout('cs_moved_off_gone', 'sub_moved_off_gone', gone, PLACE, 'in_moved_off_gone')));
  assert.ok(!cancels.some((c) => c.id === 'sub_moved_off_gone'), 'another account\'s plan was cancelled over a deleted one');
  assert.ok(!refundsMade.some((r) => r.args.payment_intent === 'pi_in_moved_off_gone'));
});

test('a plan the deletion already ended is neither cancelled nor refunded when its checkout comes back', async () => {
  // Whether it was ever served went with the account's records, and it may
  // have been used for months.
  const [PLACE] = placePair();
  const gone = await venue({ verified: true, placeId: PLACE });
  sub('sub_ended_by_deletion', gone, 'active', { customer: 'cus_ENDED_BY_DELETION', metadata: boundTo(PLACE)(gone) });
  const session = completedCheckout('cs_ended_by_deletion', 'sub_ended_by_deletion', gone, PLACE, 'in_ended_by_deletion');
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.strictEqual((await state(gone)).served, 'pro');
  await venueBilling.closeVenueCustomer(gone);
  await testPool.query('DELETE FROM users WHERE id = $1', [gone]);
  const cancelsBefore = cancels.length;
  const refundsBefore = refundsMade.length;
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.strictEqual(cancels.length, cancelsBefore);
  assert.deepStrictEqual(refundsMade.slice(refundsBefore), [], 'a plan used before the account was deleted was refunded on a replay');
});

// A REFUSAL IS OWED UNTIL IT IS FINISHED. The cancel and the refund are two
// calls to Stripe, and a refund that failed after the cancel went through was
// never tried again: the retry found the plan cancelled, read that as nothing
// left to do, and the payment for a purchase never delivered was kept. The
// refusal is recorded before the cancel (migration 123), outlives the account,
// and every later handling of the checkout finishes it.
test('a refund that failed after a gone account\'s plan was cancelled is made when Stripe sends the checkout again', async () => {
  const [PLACE] = placePair();
  const gone = await venue({ verified: true, placeId: PLACE });
  await testPool.query('DELETE FROM users WHERE id = $1', [gone]);
  sub('sub_gone_refund_retry', gone, 'active', { customer: 'cus_KEPT_GONE_RETRY', metadata: boundTo(PLACE)(gone) });
  const session = completedCheckout('cs_gone_refund_retry', 'sub_gone_refund_retry', gone, PLACE, 'in_gone_refund_retry');
  const refunded = () => refundsMade.filter((r) => r.args.payment_intent === 'pi_in_gone_refund_retry');
  const owedRows = async () => (await testPool.query(
    'SELECT reason, stripe_invoice_id, finished_at FROM roost_refused_purchases WHERE stripe_subscription_id = $1', ['sub_gone_refund_retry'])).rows;
  // First the cancel fails: the refusal is on record before it was asked for.
  failNextCancel.add('sub_gone_refund_retry');
  await assert.rejects(venueBilling.handleVenueEvent(completedEvent(session)), /simulated Stripe outage/);
  assert.deepStrictEqual((await owedRows()).map((r) => [r.reason, r.finished_at]), [['account_deleted', null]],
    'the refusal was not recorded before the plan was cancelled');
  // Then the cancel goes through and the refund fails.
  failNextRefund.add('pi_in_gone_refund_retry');
  await assert.rejects(venueBilling.handleVenueEvent(completedEvent(session)), /simulated Stripe outage/);
  assert.strictEqual(subs.sub_gone_refund_retry.status, 'canceled', 'the case under test is a cancel that went through');
  assert.deepStrictEqual(refunded(), []);

  // Stripe sends the event again, and the plan is already cancelled.
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.deepStrictEqual(refunded().map((r) => [r.args.metadata, r.options]),
    [[{ flock_reason: 'account_deleted' }, { idempotencyKey: 'flock-account-deleted-refund-in_gone_refund_retry' }]],
    'the retry found the plan cancelled and kept the payment for a purchase nobody can be served');
  assert.strictEqual(cancels.filter((c) => c.id === 'sub_gone_refund_retry').length, 1);
  // Finished: a later replay asks Stripe for nothing more.
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.strictEqual(refunded().length, 1);
  const owed = await owedRows();
  assert.strictEqual(owed.length, 1);
  assert.strictEqual(owed[0].stripe_invoice_id, 'in_gone_refund_retry');
  assert.ok(owed[0].finished_at, 'the refusal was never marked finished');
});

test('a refused purchase whose refund failed is still refunded after its owner deletes the account', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: false, placeId: PLACE });
  sub('sub_refused_then_gone', id, 'active', { customer: 'cus_REFUSED_THEN_GONE', metadata: boundTo(PLACE)(id) });
  const session = completedCheckout('cs_refused_then_gone', 'sub_refused_then_gone', id, PLACE, 'in_refused_then_gone');
  const refunded = () => refundsMade.filter((r) => r.args.payment_intent === 'pi_in_refused_then_gone');
  failNextRefund.add('pi_in_refused_then_gone');
  await assert.rejects(venueBilling.handleVenueEvent(completedEvent(session)), /simulated Stripe outage/);
  assert.strictEqual(subs.sub_refused_then_gone.status, 'canceled');
  assert.deepStrictEqual(refunded(), []);

  // The owner deletes the account before Stripe sends the event again.
  await venueBilling.closeVenueCustomer(id);
  await testPool.query('DELETE FROM users WHERE id = $1', [id]);
  await venueBilling.handleVenueEvent(completedEvent(session));
  assert.deepStrictEqual(refunded().map((r) => [r.args.metadata, r.options]),
    [[{ flock_reason: 'claim_not_verified' }, { idempotencyKey: 'flock-claim-revoked-refund-in_refused_then_gone' }]],
    'the refund owed for a refused purchase went with the account');
});

test('a refusal recorded before the claim is verified keeps the plan undelivered, and the retry finishes it', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: false, placeId: PLACE });
  const adminId = await admin();
  sub('sub_refused_first', id, 'active', { metadata: boundTo(PLACE)(id) });
  // The created event arrives first: recorded, and not served to a claim
  // nobody has confirmed.
  await venueBilling.syncVenueSubscription('sub_refused_first');
  const session = completedCheckout('cs_refused_first', 'sub_refused_first', id, PLACE, 'in_refused_first');
  failNextCancel.add('sub_refused_first');
  await assert.rejects(venueBilling.handleVenueEvent(completedEvent(session)), /simulated Stripe outage/);

  // The claim is verified before Stripe sends the event again.
  const res = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: true, googlePlaceId: PLACE } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual((await state(id)).served, 'free', 'a purchase already refused was served once the claim was verified');
  const rec = await testPool.query('SELECT served_at FROM venue_stripe_subscriptions WHERE stripe_subscription_id = $1', ['sub_refused_first']);
  assert.strictEqual(rec.rows[0].served_at, null, 'a refused purchase was recorded as delivered');

  // The retry finishes what was decided.
  const retry = await venueBilling.handleVenueEvent(completedEvent(session));
  assert.strictEqual(retry.refused, 'CLAIM_NOT_VERIFIED');
  assert.deepStrictEqual(cancels.filter((c) => c.id === 'sub_refused_first').map((c) => c.options),
    [{ idempotencyKey: 'flock-claim-revoked-cancel-sub_refused_first' }]);
  assert.deepStrictEqual(refundsMade.filter((r) => r.args.payment_intent === 'pi_in_refused_first').map((r) => r.options),
    [{ idempotencyKey: 'flock-claim-revoked-refund-in_refused_first' }], 'a refusal decided before the verification was dropped by it');
  assert.strictEqual((await state(id)).served, 'free');
});

// ---------------------------------------------------------------------------
// THE PLAN'S DATE IS STRIPE'S DATE, NOT THE GRACE.
//
// A live grant's expires_at is the period end plus three days of grace, so a
// webhook that arrives late does not lock a paying venue out. That is the
// resolver's business. The profile handed the same column to the dashboard
// as the date the plan runs until, so a trial read "Runs until" three days
// after Stripe charges, and a renewing plan and one set to end showed the same
// three-day offset.
// ---------------------------------------------------------------------------

test('the profile names the trial\'s charge date, the renewal date and a scheduled end, never the grace', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const trialEnds = Math.floor(Date.now() / 1000) + 10 * DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_dates', id, 'trialing', {
    metadata: boundTo(PLACE)(id), trial_end: trialEnds, ...period('price_roost_month', trialEnds),
  }));
  let res = await profileCall('GET', '/api/venue-profile', { as: id });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.tier, 'pro');
  assert.strictEqual(res.body.tier_status, 'trialing');
  assert.strictEqual(res.body.tier_trial_end, new Date(trialEnds * 1000).toISOString(), 'the card cannot name the day the trial is charged');
  assert.strictEqual(new Date(res.body.tier_expires_at).getTime(), trialEnds * 1000,
    'the date shown is three days after Stripe charges at the end of the trial');
  // The grace is still there, for the resolver: Roost stays on through it.
  const stored = await testPool.query('SELECT expires_at FROM venue_subscriptions WHERE user_id = $1', [id]);
  assert.strictEqual(new Date(stored.rows[0].expires_at).getTime(), trialEnds * 1000 + venueBilling.__test.GRACE_MS);

  // Renewing: the renewal date.
  const periodEnds = Math.floor(Date.now() / 1000) + 30 * DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_dates', id, 'active', { metadata: boundTo(PLACE)(id), ...period('price_roost_month', periodEnds) }));
  res = await profileCall('GET', '/api/venue-profile', { as: id });
  assert.strictEqual(res.body.tier_status, 'active');
  assert.strictEqual(res.body.tier_current_period_end, new Date(periodEnds * 1000).toISOString());
  assert.strictEqual(res.body.tier_cancel_at, null);
  assert.strictEqual(new Date(res.body.tier_expires_at).getTime(), periodEnds * 1000);

  // Set to end: the day it ends.
  await venueBilling.syncVenueSubscription(sub('sub_dates', id, 'active', {
    metadata: boundTo(PLACE)(id), ...period('price_roost_month', periodEnds), cancel_at: periodEnds, cancel_at_period_end: true,
  }));
  res = await profileCall('GET', '/api/venue-profile', { as: id });
  assert.strictEqual(res.body.tier_cancel_at, new Date(periodEnds * 1000).toISOString());
  assert.strictEqual(new Date(res.body.tier_expires_at).getTime(), periodEnds * 1000);

  // Cancelled at once: the plan ended today, not at the period end it never
  // reached.
  await venueBilling.syncVenueSubscription(sub('sub_dates', id, 'canceled', { metadata: boundTo(PLACE)(id), ...period('price_roost_month', periodEnds) }));
  res = await profileCall('GET', '/api/venue-profile', { as: id });
  assert.strictEqual(res.body.tier, 'free');
  assert.ok(new Date(res.body.tier_expires_at).getTime() <= Date.now() + 1000, `an ended plan was said to run until ${res.body.tier_expires_at}`);
});

// AN ENDED PLAN KEEPS THE DAY IT ENDED. A plan that is not live was written as
// ending now whenever its period end was still ahead, so a yearly plan
// cancelled at once one day and replayed the next was said to have ended the
// next day, and every later event moved the date again.
test('a plan Stripe ended keeps the day it ended on every replay, and the card names that day', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const yearEnds = Math.floor(Date.now() / 1000) + 300 * DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_ended_day', id, 'active', { metadata: boundTo(PLACE)(id), ...period('price_roost_year', yearEnds) }));
  // Cancelled at once yesterday; its event is handled today, then replayed.
  const endedAt = Math.floor(Date.now() / 1000) - DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_ended_day', id, 'canceled', {
    metadata: boundTo(PLACE)(id), ...period('price_roost_year', yearEnds), ended_at: endedAt, canceled_at: endedAt,
  }));
  assert.strictEqual(new Date((await state(id)).grant.expires_at).getTime(), endedAt * 1000,
    'the plan was said to end the day its event was handled, not the day it ended');
  await venueBilling.syncVenueSubscription('sub_ended_day');
  assert.strictEqual(new Date((await state(id)).grant.expires_at).getTime(), endedAt * 1000, 'a replay moved the end date');
  const res = await profileCall('GET', '/api/venue-profile', { as: id });
  assert.strictEqual(new Date(res.body.tier_expires_at).getTime(), endedAt * 1000);
});

test('a plan that stopped with no end date from Stripe keeps the first day it was seen stopped', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const yearEnds = Math.floor(Date.now() / 1000) + 300 * DAY_S;
  await venueBilling.syncVenueSubscription(sub('sub_unpaid_day', id, 'active', { metadata: boundTo(PLACE)(id), ...period('price_roost_year', yearEnds) }));
  await venueBilling.syncVenueSubscription(sub('sub_unpaid_day', id, 'unpaid', { metadata: boundTo(PLACE)(id), ...period('price_roost_year', yearEnds) }));
  // As if that event had been handled yesterday.
  const yesterday = new Date(Date.now() - DAY_S * 1000);
  await testPool.query('UPDATE venue_subscriptions SET expires_at = $2 WHERE user_id = $1', [id, yesterday]);
  await venueBilling.syncVenueSubscription('sub_unpaid_day');
  assert.strictEqual(new Date((await state(id)).grant.expires_at).getTime(), yesterday.getTime(), 'a replay moved the day the plan stopped');
  // Paid again, it is live again, with its period end.
  await venueBilling.syncVenueSubscription(sub('sub_unpaid_day', id, 'active', { metadata: boundTo(PLACE)(id), ...period('price_roost_year', yearEnds) }));
  const s = await state(id);
  assert.strictEqual(new Date(s.grant.expires_at).getTime(), yearEnds * 1000 + venueBilling.__test.GRACE_MS);
  assert.strictEqual(s.served, 'pro');
});

test('a plan we ended over a refund keeps the day the refund was recorded', async () => {
  const id = await yearlySubscriber('sub_refund_day', 'in_refund_day');
  paidBy('ch_refund_day', 'in_refund_day', 'sub_refund_day', 99000);
  refunds.ch_refund_day = [{ id: 're_day', status: 'succeeded', amount: 99000 }];
  await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_day' });
  // Recorded two days ago; a later event still reads the subscription active.
  const recorded = new Date(Date.now() - 2 * DAY_S * 1000);
  await testPool.query("UPDATE stripe_subscription_endings SET created_at = $1 WHERE stripe_subscription_id = 'sub_refund_day'", [recorded]);
  subs.sub_refund_day.status = 'active';
  await venueBilling.syncVenueSubscription('sub_refund_day');
  const s = await state(id);
  assert.strictEqual(s.grant.status, 'refunded');
  assert.strictEqual(new Date(s.grant.expires_at).getTime(), recorded.getTime(), 'a refunded plan was said to end on the day of its latest event');
});

test('a comp keeps its own end date on the card', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  const adminId = await admin();
  const comp = await adminCall('POST', `/api/admin/venues/${id}/tier`, { as: adminId, body: { tier: 'pro', grantReason: 'admin', durationDays: 20 } });
  assert.strictEqual(comp.status, 200, comp.text);
  const res = await profileCall('GET', '/api/venue-profile', { as: id });
  assert.strictEqual(res.body.tier_expires_at, comp.body.expires_at);
  assert.strictEqual(res.body.tier_trial_end, null);
  assert.strictEqual(res.body.tier_current_period_end, null);
});

// ---------------------------------------------------------------------------
// A STRIPE GRANT IS JUDGED ON THE CLAIM AS IT IS NOW.
//
// The writer keeps the tier cache at free for a claim that is not verified
// when a subscription's event arrives, and the resolver served the lower of
// the cache and the grant. Nothing raised the cache when the claim was then
// verified, so a plan made by hand for a claim still waiting on verification
// was billed and served nothing until the subscription's next event, a year
// away on the yearly plan.
// ---------------------------------------------------------------------------

test('a Stripe plan synced while its claim waited on verification is served once the claim is verified', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: false, placeId: PLACE });
  const adminId = await admin();
  await venueBilling.syncVenueSubscription(sub('sub_verified_later', id, 'active', { metadata: boundTo(PLACE)(id) }));
  assert.strictEqual((await state(id)).served, 'free', 'an unverified claim was served');
  const before = reads.length;
  const res = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: true, googlePlaceId: PLACE } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(reads.length, before, 'serving the plan needed no Stripe call');
  assert.strictEqual((await state(id)).served, 'pro', 'a verified venue Stripe is billing was served nothing until its next event');
});

test('a hand-made plan naming a listing the claim had not linked yet is served once the claim links it and is verified', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: true });
  const adminId = await admin();
  await venueBilling.syncVenueSubscription(sub('sub_listing_later', id, 'active', { metadata: boundTo(PLACE)(id) }));
  assert.strictEqual((await state(id)).served, 'free', 'a plan for a listing the claim does not name was served');
  const linked = await profileCall('PUT', '/api/venue-profile', { as: id, body: { googlePlaceId: PLACE } });
  assert.strictEqual(linked.status, 200, linked.text);
  assert.strictEqual((await state(id)).served, 'free', 'linking a listing resets verification, and an unverified claim is served nothing');
  const res = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: true, googlePlaceId: PLACE } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual((await state(id)).served, 'pro');
});

test('a claim that stops being verified is served nothing from a live Stripe grant, whatever the cache still says', async () => {
  // Un-verifying cancels the plan at Stripe (stopRoostForRevokedClaim), and
  // when Stripe cannot be reached the grant stays live with a cache of pro.
  const [PLACE] = placePair();
  const id = await venue({ verified: true, placeId: PLACE });
  await venueBilling.syncVenueSubscription(sub('sub_unverified_later', id, 'active', { metadata: boundTo(PLACE)(id) }));
  assert.strictEqual((await state(id)).cached, 'pro');
  await testPool.query('UPDATE venue_profiles SET verified = false WHERE user_id = $1', [id]);
  const s = await state(id);
  assert.strictEqual(s.cached, 'pro', 'the case under test is a cache that still says pro');
  assert.strictEqual(s.served, 'free', 'an unverified claim was served Roost from the cache');
});

test('verifying a claim, or declining one that never paid, touches no billing', async () => {
  const [PLACE] = placePair();
  const id = await venue({ verified: false, placeId: PLACE });
  const adminId = await admin();
  const before = cancels.length;
  const declined = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: false } });
  assert.strictEqual(declined.status, 200, declined.text);
  assert.ok(!('roost' in declined.body));
  const granted = await adminCall('PUT', `/api/admin/venues/${await profileIdOf(id)}/verify`, { as: adminId, body: { verified: true, googlePlaceId: PLACE } });
  assert.strictEqual(granted.status, 200, granted.text);
  assert.strictEqual(cancels.length, before);
});
