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
function FakeStripe() {
  return {
    subscriptions: {
      retrieve: async (id, params, options) => {
        const answer = subs[id] ? JSON.parse(JSON.stringify(subs[id])) : subs[id];
        reads.push({ id, status: answer ? answer.status : null, options: options || null });
        if (afterRead) afterRead(id);
        return answer;
      },
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
async function venue({ verified }) {
  n += 1;
  const u = await testPool.query(
    "INSERT INTO users (email, password, name, role) VALUES ($1, 'x', 'Owner', 'venue_owner') RETURNING id",
    [`owner${n}@example.com`]
  );
  const id = u.rows[0].id;
  // Created after Roost had a price (Terms 9.6), so these venues are in no
  // notice window and the grant alone decides: that is what this suite tests.
  // The window itself is services/roostNotice.js's, in roostNotice.test.js.
  await testPool.query(
    "INSERT INTO venue_profiles (user_id, business_name, verified, tier, created_at) VALUES ($1, 'The Owl', $2, 'free', '2026-10-01T12:00:00Z')",
    [id, verified]
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
