// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — the venue tier at expiry, and the published cost arithmetic
// ─────────────────────────────────────────────────────────────────────────────
//
// Two unrelated things live here because they share one property: both are
// claims the codebase makes about itself, and both are checked against the
// constants the code actually runs on rather than against the prose.
//
// PART ONE — venue tier.
//
//   P. AN EXPIRED GRANT USED TO KEEP SELLING, AND NO LONGER DOES.
//      services/venueEntitlements.js resolves a tier from venue_subscriptions
//      (grant status + expires_at) and treats venue_profiles.tier as a cache
//      that must never be trusted over the grant. Exactly one tier decision
//      skipped that resolution: GET /api/venue-dashboard/public-promotions/
//      :placeId joined `vp.tier = ANY($3)` with no join to
//      venue_subscriptions and no expires_at anywhere. So the moment a comp
//      lapsed, every owner-facing Roost surface answered 403 while the paid
//      benefit kept being SERVED to end users, and kept incrementing the
//      promotion view counter the product is priced on. The public join now
//      applies resolveGrantedTier's three rules in SQL, with the live-status
//      vocabulary BOUND from the service rather than retyped, and the tests
//      below walk every case: lapsed, canceled, past_due, no grant at all.
//
//   Q. WHAT venueTierExpiry.test.js DOES NOT COVER. That file drove exactly
//      two routes (/intelligence and /strip); it now covers the public read
//      paths too. This keeps the case it could not see, and pins the two
//      enum-normalisation gaps it leaves open.
//
// PART TWO — utils/cacheKeyInventory.js publishes the arithmetic for starving
// production. Two sentences in it were flagged in the public-repo audit. Both
// are re-derived here from the live constants:
//
//   R. "reachable with about 40 addresses" — the 40 still holds, but the two
//      photo constants it is computed from have both changed and the clause
//      attached to it ("left the authenticated product 300 calls a day") is
//      now wrong by a factor of four. A stale published number is worse than
//      no number, in both directions.
//
//   S. "~34 cooperating accounts ... for about three dollars" — still exactly
//      true, to the account and to the cent.
//
//   T. And the cheaper attack the inventory does not name: the photo proxy
//      charges the shared Places ledger BEFORE it charges its own dollar
//      brake, so junk photo references exhaust the whole unauthenticated
//      Places share from 18 addresses without buying a single photo.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'abuse-tier-cost-test-secret';
// The gate is a no-op until this is exactly the string 'true'.
process.env.VENUE_BILLING_ENABLED = 'true';

const BACKEND = path.join(__dirname, '..');
const pool = require('../config/database');

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const OWNER = 4242;
const READER = 77;
const PLACE = 'ChIJtierexpiry000001';

// ── The semantic world ───────────────────────────────────────────────────────
let world;
function freshWorld() {
  return {
    // venue_profiles row, plus the venue_subscriptions grant joined onto it
    profile: {
      user_id: OWNER, google_place_id: PLACE, verified: true, tier: 'premium',
      grant_tier: 'premium', grant_status: 'active', grant_source: 'admin',
      granted_reason: 'founding_comp', granted_at: new Date(Date.now() - 200 * 86400e3).toISOString(),
      expires_at: new Date(Date.now() + 30 * 86400e3).toISOString(),
    },
    promotions: [{ id: 1, venue_user_id: OWNER, google_place_id: PLACE, title: 'Half price wings', description: 'Tuesdays', time_slot: 'evening', days: ['tue'], active: true, is_hidden: false, views: 0 }],
  };
}

let log = [];
let unknown = [];
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], `unmodelled queries: ${JSON.stringify(unknown.slice(0, 3))}`);
}

const TIER_SQL_HEAD = 'SELECT vp.tier, vs.tier AS grant_tier';

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];

  // services/venueEntitlements.js TIER_SQL — the expiry-aware resolution.
  if (flat.startsWith(TIER_SQL_HEAD)) {
    return Number(p[0]) === OWNER ? { rows: [{ ...world.profile }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  // getVenueCtx
  if (/^SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles WHERE user_id = \$1$/.test(flat)) {
    return Number(p[0]) === OWNER
      ? { rows: [{ id: 1, google_place_id: PLACE, verified: world.profile.verified, category: 'bar', verification_requested_at: null }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  // public-promotions — executed exactly as written, including which columns
  // the JOIN does and does not consult.
  if (/^SELECT p\.id, p\.title, p\.description, p\.time_slot, p\.days FROM venue_promotions p/.test(flat)) {
    const [placeId, billingOn, servingTiers, liveStatuses] = [p[0], p[1], p[2], p[3]];
    // Which rules the statement ACTUALLY carries, read off the statement. A
    // clause that goes missing takes its test down with it and names itself.
    const joinsGrant = /LEFT JOIN venue_subscriptions vs ON vs\.user_id = vp\.user_id/.test(flat);
    const readsGrantTier = /vs\.tier = ANY\(\$3::text\[\]\)/.test(flat);
    const readsStatus = /vs\.status = ANY\(\$4::text\[\]\)/.test(flat);
    const readsExpiry = /vs\.expires_at IS NULL OR vs\.expires_at > NOW\(\)/.test(flat);
    const g = world.profile;
    const rows = world.promotions.filter((pr) => {
      if (pr.google_place_id !== placeId || !pr.active || pr.is_hidden) return false;
      if (g.user_id !== pr.venue_user_id) return false;
      if (g.google_place_id !== pr.google_place_id) return false;
      if (g.verified !== true) return false;
      if (billingOn !== true) return true;
      // Rule 3 of resolveGrantedTier, expressed as "both tiers serve": the
      // CACHED column first, because it is still the lower bound.
      if (!servingTiers.includes(g.tier)) return false;
      // Rule 1: no grant row means the cached column is the whole answer.
      if (!joinsGrant || g.grant_tier === null || g.grant_tier === undefined) return true;
      // Rule 2: a dead grant is the free tier whatever the cache says.
      if (readsGrantTier && !servingTiers.includes(g.grant_tier)) return false;
      if (readsStatus && !(liveStatuses || []).includes(g.grant_status)) return false;
      if (readsExpiry && g.expires_at !== null && g.expires_at !== undefined
        && new Date(g.expires_at).getTime() <= Date.now()) return false;
      return true;
    }).map((pr) => ({ id: pr.id, title: pr.title, description: pr.description, time_slot: pr.time_slot, days: pr.days }));
    return { rows, rowCount: rows.length };
  }
  if (/^UPDATE venue_promotions SET views = views \+ 1/.test(flat)) {
    let n = 0;
    for (const pr of world.promotions) {
      if ((p[0] || []).includes(pr.id) && pr.venue_user_id !== Number(p[1])) { pr.views += 1; n += 1; }
    }
    return { rows: [], rowCount: n };
  }

  unknown.push(flat.slice(0, 160));
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

const dashRouter = require('../routes/venueDashboard');
const { getVenueTier, getVenueEntitlement, resolveGrantedTier, GRANT_LIVE_STATUS_LIST } = require('../services/venueEntitlements');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/venue-dashboard', dashRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => { world = freshWorld(); log = []; unknown = []; });

async function call(method, p) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

function expireTheComp() {
  // The grant lapsed yesterday. The admin route is the only writer of
  // venue_profiles.tier and it only runs on an explicit downgrade, so the
  // cached column keeps saying 'premium' exactly as it does in production.
  world.profile.expires_at = new Date(Date.now() - 86400e3).toISOString();
}

// ═════════════════════════════════════════════════════════════════════════════
// PART ONE — P. AN EXPIRED GRANT STILL SELLS
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED P: a lapsed comp is refused on the owner surface AND on the public one', async () => {
  expireTheComp();

  // The expiry-aware resolution says the venue is free.
  assert.strictEqual(await getVenueTier(OWNER), 'free');
  const ent = await getVenueEntitlement(OWNER);
  assert.strictEqual(ent.expired, true);
  assert.strictEqual(ent.tier, 'free');

  // Owner-facing paid surface: refused, as it always was.
  CURRENT_USER = { id: OWNER, name: 'Rick', email_verified: true, role: 'venue_owner' };
  const gated = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(gated.status, 403, gated.text);
  assert.strictEqual(gated.body.code, 'UPGRADE_REQUIRED');

  // Consumer-facing paid BENEFIT: no longer served. This is the whole finding.
  CURRENT_USER = { id: READER, name: 'Reader', email_verified: true, role: 'user' };
  const pub = await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
  assert.strictEqual(pub.status, 200, pub.text);
  assert.deepStrictEqual(pub.body.promotions, [],
    'the promotion of a venue that stopped paying yesterday is still on the consumer card');

  // And the number VENUE-BILLING.md prices the product on stops moving with it.
  assert.strictEqual(world.promotions[0].views, 0,
    'a promotion nobody was shown still counted a view');

  // The reason, stated from the SQL rather than inferred: the public join reads
  // the grant now, by the same three rules the resolver applies.
  const promoSql = log.find((q) => /FROM venue_promotions p/.test(q.sql)).sql;
  assert.match(promoSql, /vp\.tier = ANY\(\$3::text\[\]\)/, 'the cached column is still the lower bound');
  assert.match(promoSql, /LEFT JOIN venue_subscriptions vs ON vs\.user_id = vp\.user_id/,
    'no join to the grant table');
  assert.match(promoSql, /vs\.expires_at IS NULL OR vs\.expires_at > NOW\(\)/,
    'no expiry comparison of any kind');
  assert.match(promoSql, /vs\.tier IS NULL OR/,
    'a venue with no grant row on file must still be served on its cached tier');
  assertQueriesUnderstood();
});

test('FIXED P2: an explicit downgrade still bites, so nothing regressed on the path that worked', async () => {
  // The admin downgrade rewrites the cached column, which was the only thing
  // the public join used to read. It is still read, and it is still first.
  world.profile.tier = 'free';
  world.profile.grant_tier = 'free';
  world.profile.expires_at = null;

  CURRENT_USER = { id: READER, name: 'Reader', email_verified: true, role: 'user' };
  const pub = await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
  assert.strictEqual(pub.status, 200, pub.text);
  assert.deepStrictEqual(pub.body.promotions, [],
    'an explicit downgrade stops the serving immediately');
  assert.strictEqual(world.promotions[0].views, 0);
  assertQueriesUnderstood();
});

test('FIXED P3: every revoking grant STATUS closes the same hole the lapsed date did', async () => {
  // Not only expiry: any status outside the live set resolves to free, and the
  // cached column is equally untouched by it.
  for (const dead of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
    world = freshWorld();
    log = [];
    world.profile.grant_status = dead;
    assert.strictEqual(await getVenueTier(OWNER), 'free', `${dead} kept a paid tier`);

    CURRENT_USER = { id: READER, name: 'Reader', email_verified: true, role: 'user' };
    const pub = await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
    assert.deepStrictEqual(pub.body.promotions, [],
      `a ${dead} subscription is still being advertised to users`);
    assert.strictEqual(world.promotions[0].views, 0);
    assertQueriesUnderstood();
  }
});

test('FIXED P4: past_due KEEPS serving, because a card that failed on Tuesday is a card', async () => {
  // The fix must not be over-broad. VENUE-BILLING.md's status map says past_due
  // is keep-and-warn, and the public surface has to agree with the gate about
  // that too, or a venue whose payment is retrying loses its promotion for a
  // day and nobody can explain why.
  world.profile.grant_status = 'past_due';
  assert.strictEqual(await getVenueTier(OWNER), 'premium');

  CURRENT_USER = { id: READER, name: 'Reader', email_verified: true, role: 'user' };
  const pub = await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
  assert.strictEqual(pub.body.promotions.length, 1, 'a card that failed on Tuesday cancelled the venue');
  assert.strictEqual(world.promotions[0].views, 1);
  assertQueriesUnderstood();
});

test('FIXED P5: a venue with NO grant row is still served, which is rule 1 of the resolver', async () => {
  // Pre-migration-040 rows and scripts/e2e-local.js drive venue_profiles.tier
  // directly. A row with no grant has no expiry to have missed, and closing the
  // hole must not turn every one of them off.
  world.profile.grant_tier = null;
  world.profile.grant_status = null;
  world.profile.expires_at = null;
  assert.strictEqual(await getVenueTier(OWNER), 'premium');

  CURRENT_USER = { id: READER, name: 'Reader', email_verified: true, role: 'user' };
  const pub = await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
  assert.strictEqual(pub.body.promotions.length, 1,
    'a hand-granted tier with no grant row stopped being served');
  assertQueriesUnderstood();
});

test('FIXED P6: the live-status vocabulary is BOUND from the service, not retyped in the route', async () => {
  // Stripe's status map has one definition. If the route ever grows its own
  // copy the two drift, and the drift is silent until a paying venue is cut off
  // or a cancelled one keeps selling.
  CURRENT_USER = { id: READER, name: 'Reader', email_verified: true, role: 'user' };
  await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
  const q = log.find((x) => /FROM venue_promotions p/.test(x.sql));
  assert.deepStrictEqual(q.params[3], GRANT_LIVE_STATUS_LIST,
    'the route sends a status list of its own instead of the one the gate uses');
  assert.deepStrictEqual([...q.params[3]].sort(), ['active', 'past_due', 'trialing']);
  assert.deepStrictEqual(q.params.slice(0, 3), [PLACE, true, ['premium', 'pro']]);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// Q. THE GAPS venueTierExpiry.test.js LEAVES
// ═════════════════════════════════════════════════════════════════════════════

test('GAP: no client value reaches a tier decision — attacked, held', async () => {
  expireTheComp();
  CURRENT_USER = { id: OWNER, name: 'Rick', email_verified: true, role: 'venue_owner', tier: 'pro', is_premium: true };
  const gated = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(gated.status, 403,
    'a tier claim carried on the request principal is ignored; the gate reads the database');
  // And the gate re-reads it on every request rather than caching a decision.
  await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(log.filter((q) => q.sql.startsWith(TIER_SQL_HEAD)).length, 2);
  assertQueriesUnderstood();
});

test('GAP: an unrecognised tier string resolves to free on the gate and is refused on the public join', async () => {
  // venueTierExpiry.test.js walks junk STATUSES and junk DATES, never a junk
  // tier. Both halves of the system have to reject one.
  for (const junk of ['platinum', '__proto__', 'constructor', '', null, 7, true]) {
    assert.strictEqual(resolveGrantedTier({ tier: junk, grant_tier: junk, grant_status: 'active', expires_at: null }, Date.now()), 'free',
      `tier ${JSON.stringify(junk)} must not rank`);
  }
  world.profile.tier = 'platinum';
  world.profile.grant_tier = 'platinum';
  CURRENT_USER = { id: READER, name: 'Reader', email_verified: true, role: 'user' };
  const pub = await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
  assert.deepStrictEqual(pub.body.promotions, [], 'ANY() does not match an unknown tier either');
  assertQueriesUnderstood();
});

test('GAP: a cached tier with NO grant row can never expire, by design and without a test elsewhere', () => {
  // Rule 1 of resolveGrantedTier. It is deliberate (pre-migration-040 rows and
  // the e2e harness), and it means any hand-written tier is permanent.
  assert.strictEqual(resolveGrantedTier({ tier: 'pro' }, Date.now()), 'pro');
  assert.strictEqual(resolveGrantedTier({ tier: 'pro', grant_tier: null }, Date.now()), 'pro');
  assert.strictEqual(resolveGrantedTier({ tier: 'pro', grant_tier: undefined, expires_at: new Date(0).toISOString() }, Date.now()), 'pro',
    'an expires_at with no grant_tier is ignored entirely');
});

// ═════════════════════════════════════════════════════════════════════════════
// PART TWO — the published cost arithmetic
// ═════════════════════════════════════════════════════════════════════════════

const inventorySrc = fs.readFileSync(path.join(BACKEND, 'utils', 'cacheKeyInventory.js'), 'utf8');
const placesBudget = require('../utils/placesBudget');
const visionBudget = require('../utils/visionBudget');
const badge = require('../routes/badge').__test;
const photoStore = require('../services/photoStore');
const venueSearchTest = require('../routes/venueSearch').__test;

// The demo's daily leg is a literal in the route, so it is read from source
// rather than retyped.
const publicCrowdSrc = fs.readFileSync(path.join(BACKEND, 'routes', 'publicCrowd.js'), 'utf8');
const DEMO_DAILY = Number(/if \(dayCount >= (\d+)\) return false;/.exec(publicCrowdSrc)[1]);
const DEMO_IP_HOURLY = require('../routes/publicCrowd').__testables.IP_LIMIT;

test('CLAIM R: "about 40 addresses" still computes, but the sentence around it is stale', () => {
  assert.match(inventorySrc, /reachable with about 40 addresses/,
    'the published sentence is still in the file');

  // The three unauthenticated doors, as they stand today.
  const doors = [
    { name: 'public demo', daily: DEMO_DAILY, perIpHourly: DEMO_IP_HOURLY },
    { name: 'badge', daily: badge.BADGE_DAILY, perIpHourly: badge.BADGE_IP_HOURLY },
    { name: 'photo proxy', daily: photoStore.PHOTO_FETCH_BURST_PER_DAY, perIpHourly: venueSearchTest.PHOTO_MISS_PER_IP_HOURLY },
  ];
  const addresses = doors.reduce((n, d) => n + Math.ceil(d.daily / d.perIpHourly), 0);
  assert.strictEqual(addresses, 40, 'the headline number survives');

  // ...but only because the two photo constants moved together. The inventory
  // names 300/IP/hr and 1500/day for the photo proxy; both are gone.
  assert.match(inventorySrc, /the photo proxy 300\/IP\/hr under 1500\/day/,
    'the published inputs');
  assert.strictEqual(venueSearchTest.PHOTO_MISS_PER_IP_HOURLY, 100, 'the real per-IP rate is a third of that');
  assert.strictEqual(photoStore.PHOTO_FETCH_BURST_PER_DAY, 451, 'and the real daily leg is under a third');

  // And the conclusion the sentence draws is wrong by more than a factor of four.
  const doorSum = doors.reduce((n, d) => n + d.daily, 0);
  assert.strictEqual(doorSum, 1651, 'the published sum of 2700 is now 1651');
  assert.match(inventorySrc, /600 \+ 1500 \+ 600 = 2700 is 90% of 3000/, 'as published');
  assert.strictEqual(placesBudget.GLOBAL_DAILY - doorSum, 1349,
    'the published "left the authenticated product 300 calls a day" is now 1349');
  assert.strictEqual(placesBudget.GLOBAL_DAILY - placesBudget.UNAUTH_DAILY, 1200,
    'and it is hard-floored at 1200 by UNAUTH_DAILY regardless of what the doors do');
});

test('CLAIM S: "~34 cooperating accounts for about three dollars" is still exactly true', () => {
  assert.match(inventorySrc, /~34 cooperating accounts \(2000\/60\) turn off every image upload/);
  assert.strictEqual(visionBudget.VISION_GLOBAL_DAILY, 2000);
  assert.strictEqual(visionBudget.VISION_USER_DAILY, 60);
  assert.strictEqual(Math.ceil(visionBudget.VISION_GLOBAL_DAILY / visionBudget.VISION_USER_DAILY), 34);
  assert.strictEqual(
    Number((visionBudget.VISION_GLOBAL_DAILY * visionBudget.VISION_UNIT_PRICE_USD).toFixed(2)), 3.00);
  // Per account, per day: nine cents.
  assert.strictEqual(
    Number((visionBudget.VISION_USER_DAILY * visionBudget.VISION_UNIT_PRICE_USD).toFixed(2)), 0.09);
});

test('ABUSE T: the photo proxy charges the shared Places ledger before its own dollar brake, so 18 addresses exhaust the unauthenticated share', () => {
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'venueSearch.js'), 'utf8');
  const ledgerAt = src.indexOf('if (!allowGlobalPlacesCall(1)) {');
  const brakeAt = src.indexOf('const charge = await chargePhotoFetch();');
  assert.ok(ledgerAt > 0 && brakeAt > 0, 'both charges are on this path');
  assert.ok(ledgerAt < brakeAt,
    'the shared ledger is charged FIRST, so a request the photo budget will refuse has already spent a unit of it');
  // The file says so itself, and calls it the safe direction. It is safe for
  // the DOLLARS; it is not safe for the shared unauthenticated allowance.
  assert.match(src, /allowGlobalPlacesCall\s*\n?\/\/ is charged just before chargePhotoFetch|is charged just before chargePhotoFetch/);

  // A junk photo reference always misses both cache layers, so every request
  // is a "miss" and every miss spends one unit of the unauthenticated share
  // before the 451/day photo brake ever gets a say.
  const perAddressPerHour = venueSearchTest.PHOTO_MISS_PER_IP_HOURLY;
  const addressesToDrainUnauth = Math.ceil(placesBudget.UNAUTH_DAILY / perAddressPerHour);
  assert.strictEqual(addressesToDrainUnauth, 18);
  assert.ok(addressesToDrainUnauth < 40,
    'cheaper than the published 40, through a door the published arithmetic scores at 451 a day');

  // What it does NOT buy, which is the part that keeps this a nuisance rather
  // than an outage: the authenticated reserve is untouched.
  assert.strictEqual(placesBudget.GLOBAL_DAILY - placesBudget.UNAUTH_DAILY, 1200);
});

test('the inventory is self-describing about which rows are still open, so a stale row is a live claim', () => {
  // cacheKeyInventory.test.js checks structure (every Map has a row, every
  // OPEN row names a fix) and pins no numbers, which is exactly why the stale
  // arithmetic above survived. Pinned here so the next edit to those constants
  // has one place that fails.
  const openRows = (inventorySrc.match(/verdict: 'OPEN'/g) || []).length;
  assert.ok(openRows > 0, 'the file still carries open rows');
  assert.match(inventorySrc, /utils\/placesBudget\.js/);
  assert.match(inventorySrc, /utils\/visionBudget\.js/);
});
