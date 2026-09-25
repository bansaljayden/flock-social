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
  STRIPE_SECRET_KEY: ['sk', 'test', 'z'.repeat(24)].join('_'),
  STRIPE_PRICE_ROOST_MONTHLY: 'price_roost_month',
};
const savedEnv = {};

const venueBilling = require('../services/venueBilling');
const { getVenueEntitlement } = require('../services/venueEntitlements');

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
