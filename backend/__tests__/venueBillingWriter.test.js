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
// Every cancel Stripe was asked for, in order, with its request options.
const cancels = [];
// Every customer deleted, in order (account deletion closes them).
const deletedCustomers = [];
// Checkout, for the tests that buy: customers made, sessions made, sessions
// still open (payable) and the ones expired.
let customersMade = 0;
const sessionsMade = [];
const openSessions = [];
const expiredSessions = [];
function FakeStripe() {
  return {
    customers: {
      del: async (id) => { deletedCustomers.push(id); return { id, deleted: true }; },
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
        list: async ({ customer, status }) => ({ data: status === 'open' ? openSessions.filter((s) => s.customer === customer).map((s) => ({ ...s })) : [] }),
        expire: async (id) => {
          expiredSessions.push(id);
          const i = openSessions.findIndex((s) => s.id === id);
          if (i >= 0) openSessions.splice(i, 1);
          return { id, status: 'expired' };
        },
        retrieve: async (id) => openSessions.find((s) => s.id === id) || { id, status: 'expired' },
        create: async (args) => { sessionsMade.push(args); return { id: `cs_made_${sessionsMade.length}`, url: 'https://checkout.stripe.com/c/pay/made' }; },
      },
    },
    subscriptions: {
      // A deleted customer's subscriptions went with it.
      list: async ({ customer }) => ({
        data: deletedCustomers.includes(customer) ? [] : Object.values(subs).filter((s) => s && s.customer === customer).map((s) => ({ ...s })),
      }),
      retrieve: async (id, params, options) => {
        const answer = subs[id] ? JSON.parse(JSON.stringify(subs[id])) : subs[id];
        reads.push({ id, status: answer ? answer.status : null, options: options || null });
        if (afterRead) afterRead(id);
        return answer;
      },
      cancel: async (id, params, options) => {
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
    },
    invoicePayments: {
      list: async ({ payment }) => ({
        data: (invoicePayments[payment.payment_intent] || []).map((invoice, i) => ({ id: `inpay_${i}_${invoice}`, invoice, status: 'paid' })),
        has_more: false,
      }),
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
function paidBy(chargeId, invoiceId, subscriptionId, amount) {
  const pi = `pi_${chargeId}`;
  charges[chargeId] = { id: chargeId, object: 'charge', amount, customer: 'cus_W', payment_intent: pi };
  invoicePayments[pi] = [invoiceId];
  invoices[invoiceId] = { id: invoiceId, parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } } };
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
  paidBy('ch_refund_old', 'in_refund_last', 'sub_refund_old', 9900);
  refunds.ch_refund_old = [{ id: 're_old', status: 'succeeded', amount: 9900 }];
  const result = await venueBilling.revokeRefundedSubscription({ object: 'charge', id: 'ch_refund_old' });
  assert.ok(result.ignored, JSON.stringify(result));
  assert.strictEqual((await state(id)).served, 'pro');
  assert.ok(!cancels.some((c) => c.id === 'sub_refund_old'));
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
