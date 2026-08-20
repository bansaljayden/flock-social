// Run: node --test  (from backend/)
//
// THE COMP THAT NEVER ENDED (migration 040).
//
// VENUE-PRICING.md's founding offer is Roost free for SIX MONTHS for the first
// 10-15 verified venues in one city, in exchange for a maintained slider habit.
// The only way to grant a tier is POST /api/admin/venues/:userId/tier, and
// until this round it wrote venue_profiles.tier and nothing else: no end date,
// no billing side, no periodic job. Comping fifteen venues for a six-month
// pilot therefore created fifteen PERMANENT free accounts, and the mistake was
// invisible. No error, no alert, just a tier that never stopped.
//
// What is pinned here:
//
//   1. Expiry is decided at READ time, by the same resolver every gate uses. A
//      grant that lapsed at 03:00 is refused at 03:00, not whenever a sweep
//      next runs, because there is no sweep and there must not be one.
//   2. A NULL end date still means no end date. Closing the hole must not
//      quietly put a clock on a subscriber who has none.
//   3. venue_profiles.tier is a CACHE. A stale 'premium' in that column behind
//      a dead grant buys nothing.
//   4. The Roost routes themselves — /intelligence and /strip, the two the
//      existing venueTierGate.test.js proves are paid — actually lock for an
//      expired grant.
//   5. The admin route takes a duration, defaults founding_comp to six months,
//      keeps the verified precondition VENUE-BILLING.md states three times, and
//      NEVER silently extends a grant that already has an end date.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-tier-expiry-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(String(sql).replace(/\s+/g, ' '))) {
      const out = fn(params || [], String(sql));
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 200)}`));
}
pool.query = (sql, params) => dispatch(sql, params);

const placesBudget = require('../utils/placesBudget');
let budgetCharges = [];
placesBudget.allowPlacesSearch = (userId) => { budgetCharges.push(userId); return true; };

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

const authMod = require('../middleware/auth');
const MOD = { id: 9, name: 'Mod', role: 'admin' };
const OWNER = { id: 1, name: 'Ava', role: 'venue_owner' };
let CURRENT_USER = OWNER;
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');
const adminRouter = require('../routes/admin');
const { resolveGrantedTier, getVenueTier, getVenueEntitlement } = require('../services/venueEntitlements');

const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({ score: 55, label: 'Moderate', predictionMethod: 'rule_engine', modelVersion: 'test' });
mlPredictor.predictHourlyForecast = async () => [{ hour: 20, score: 70 }, { hour: 21, score: 80 }];

const PLACE = {
  id: 'PLACE_A',
  displayName: { text: 'The Bar' },
  rating: 4.4,
  userRatingCount: 120,
  types: ['bar'],
  location: { latitude: 39.74, longitude: -104.98 },
  currentOpeningHours: { openNow: true },
  utcOffsetMinutes: -360,
};
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchNearby')) {
    return Promise.resolve({ json: async () => ({ places: [] }) });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    return Promise.resolve({ json: async () => PLACE });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);
app.use('/api/admin', adminRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  budgetCharges = [];
  CURRENT_USER = OWNER;
  delete process.env.VENUE_BILLING_ENABLED;
});

async function call(method, path, body, user) {
  const previous = CURRENT_USER;
  if (user) CURRENT_USER = user;
  try {
    const res = await realFetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, body: json, text };
  } finally {
    CURRENT_USER = previous;
  }
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const HOUR = 3600000;

// The join services/venueEntitlements.js issues. `tier` is the cached column on
// venue_profiles; everything prefixed grant_ comes from venue_subscriptions.
const grantIs = (row) => [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: row ? [row] : [] })];
const ctxIs = (row) => [/SELECT id, google_place_id, verified, category FROM venue_profiles/, () => ({ rows: row ? [row] : [] })];
const VERIFIED_CTX = { id: 9, google_place_id: 'PLACE_A', verified: true };

// ---------------------------------------------------------------------------
// 1. The rule itself, as a pure function, walked across the boundary
// ---------------------------------------------------------------------------

test('a grant that ran out is the free tier from the moment it ran out', () => {
  // 03:00 exactly. The comp is live at 02:59:59.999 and gone at 03:00:00.000,
  // and nothing has to run in between for that to be true.
  const endsAt = new Date('2026-08-20T03:00:00.000Z');
  const row = { tier: 'premium', grant_tier: 'premium', grant_status: 'active', expires_at: endsAt };

  assert.strictEqual(resolveGrantedTier(row, endsAt.getTime() - 1), 'premium',
    'the comp was cut off before its own end date');
  assert.strictEqual(resolveGrantedTier(row, endsAt.getTime()), 'free',
    'a grant is still live at the instant it expires');
  assert.strictEqual(resolveGrantedTier(row, endsAt.getTime() + HOUR), 'free',
    'a comp that expired at 3am was still serving Roost at 4am, which is the whole bug');
});

test('a permanent grant is untouched, and so is a venue with no grant at all', () => {
  const now = Date.now();
  // NULL expires_at means NO end date. Closing the comp hole must not put a
  // clock on a subscriber who does not have one.
  assert.strictEqual(
    resolveGrantedTier({ tier: 'pro', grant_tier: 'pro', grant_status: 'active', expires_at: null }, now),
    'pro');
  // Pre-040 rows, and scripts/e2e-local.js, which drives venue_profiles.tier
  // directly. No grant row means no expiry to have missed.
  assert.strictEqual(resolveGrantedTier({ tier: 'premium' }, now), 'premium');
  assert.strictEqual(resolveGrantedTier({ tier: 'premium', grant_tier: null }, now), 'premium');
  // No profile at all is still the free tier, not a crash.
  assert.strictEqual(resolveGrantedTier(undefined, now), 'free');
});

test('a stale cached column cannot outrank a dead grant, in either direction', () => {
  const now = Date.now();
  const past = new Date(now - HOUR);
  // THE STALE COLUMN. venue_profiles.tier is written next to the grant in one
  // statement, so it still says premium after the grant lapses. It buys nothing.
  assert.strictEqual(
    resolveGrantedTier({ tier: 'pro', grant_tier: 'pro', grant_status: 'active', expires_at: past }, now),
    'free', 'an expired grant kept its tier because the cached column still said so');
  // And where the two disagree without expiry involved, the lower one wins:
  // they are written together, so a disagreement is a bug, and the fail-closed
  // reading of a bug is the smaller entitlement.
  assert.strictEqual(
    resolveGrantedTier({ tier: 'pro', grant_tier: 'premium', grant_status: 'active', expires_at: null }, now),
    'premium');
  assert.strictEqual(
    resolveGrantedTier({ tier: 'premium', grant_tier: 'pro', grant_status: 'active', expires_at: null }, now),
    'premium');
});

test('the status vocabulary is Stripe\'s, and anything it has never heard of revokes', () => {
  const now = Date.now();
  const row = (status) => ({ tier: 'pro', grant_tier: 'pro', grant_status: status, expires_at: null });
  // VENUE-BILLING.md's status map: trialing and active serve, past_due keeps and
  // warns (a card that failed on Tuesday is a card, not a cancellation).
  for (const live of ['active', 'trialing', 'past_due']) {
    assert.strictEqual(resolveGrantedTier(row(live), now), 'pro', `${live} was revoked`);
  }
  for (const dead of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused',
    'constructor', '__proto__', '', null, undefined, 7, true]) {
    assert.strictEqual(resolveGrantedTier(row(dead), now), 'free',
      `status ${JSON.stringify(dead)} kept a paid tier`);
  }
});

test('an end date nobody can parse revokes rather than opens', () => {
  const now = Date.now();
  for (const junk of ['whenever', 'not-a-date', {}]) {
    assert.strictEqual(
      resolveGrantedTier({ tier: 'pro', grant_tier: 'pro', grant_status: 'active', expires_at: junk }, now),
      'free', `expires_at ${JSON.stringify(junk)} was read as "no end date"`);
  }
});

// ---------------------------------------------------------------------------
// 2. The same rule, through the real lookup
// ---------------------------------------------------------------------------

test('getVenueTier reads the grant and the cache in ONE query, by user id', async () => {
  handlers = [grantIs({ tier: 'premium', grant_tier: 'premium', grant_status: 'active', expires_at: null })];
  assert.strictEqual(await getVenueTier(4242), 'premium');
  const q = ran(/FROM venue_profiles vp LEFT JOIN venue_subscriptions/);
  assert.strictEqual(q.length, 1, 'the gate issued more than one read for one decision');
  assert.deepStrictEqual(q[0].params, [4242]);
});

test('the dashboard is told the same thing the gate enforces', async () => {
  // A venue whose comp ended must not read "Insights" on its own settings
  // screen while every Roost route answers 403. One resolver, one answer.
  const past = new Date(Date.now() - HOUR);
  handlers = [grantIs({
    tier: 'premium', grant_tier: 'premium', grant_status: 'active',
    grant_source: 'comp', granted_reason: 'founding_comp', expires_at: past,
  })];
  const ent = await getVenueEntitlement(1);
  assert.strictEqual(ent.tier, 'free');
  assert.strictEqual(ent.expired, true);
  assert.strictEqual(ent.reason, 'founding_comp');
  assert.strictEqual(ent.expiresAt, past);

  handlers = [grantIs({ tier: 'pro', grant_tier: 'pro', grant_status: 'active', expires_at: null })];
  const permanent = await getVenueEntitlement(1);
  assert.strictEqual(permanent.tier, 'pro');
  assert.strictEqual(permanent.expired, false, 'a grant with no end date was reported as expired');
  assert.strictEqual(permanent.expiresAt, null);
});

// ---------------------------------------------------------------------------
// 3. The Roost routes actually lock (the venueTierGate.test.js pairing)
// ---------------------------------------------------------------------------

for (const path of ['/api/venue-dashboard/intelligence', '/api/venue-dashboard/strip']) {
  test(`GET ${path} is refused once the comp has ended`, async () => {
    process.env.VENUE_BILLING_ENABLED = 'true';
    handlers = [grantIs({
      tier: 'premium', grant_tier: 'premium', grant_status: 'active',
      expires_at: new Date(Date.now() - HOUR),
    })];
    const res = await call('GET', path);
    assert.strictEqual(res.status, 403, `an expired comp still served ${path}`);
    assert.strictEqual(res.body.code, 'UPGRADE_REQUIRED');
    assert.strictEqual(res.body.requiredTier, 'premium');
    // Refused BEFORE the handler, so an ended comp does not keep spending the
    // shared paid Places budget either.
    assert.strictEqual(ran(/SELECT id, google_place_id, verified/).length, 0, 'the handler ran anyway');
    assert.deepStrictEqual(budgetCharges, [], 'an expired comp charged the Places budget');
  });

  test(`GET ${path} is still served while the comp is running`, async () => {
    process.env.VENUE_BILLING_ENABLED = 'true';
    handlers = [
      grantIs({
        tier: 'premium', grant_tier: 'premium', grant_status: 'active',
        expires_at: new Date(Date.now() + 30 * 24 * HOUR),
      }),
      ctxIs(VERIFIED_CTX),
    ];
    const res = await call('GET', path);
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.available, true);
  });
}

test('an expiry that passes mid-session bites on the very next request', async () => {
  // No cache anywhere in the gate, so there is no window to be wrong in.
  process.env.VENUE_BILLING_ENABLED = 'true';
  let expiresAt = new Date(Date.now() + HOUR);
  handlers = [
    [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({
      rows: [{ tier: 'premium', grant_tier: 'premium', grant_status: 'active', expires_at: expiresAt }],
    })],
    ctxIs(VERIFIED_CTX),
  ];
  assert.strictEqual((await call('GET', '/api/venue-dashboard/intelligence')).status, 200);
  expiresAt = new Date(Date.now() - 1000);
  assert.strictEqual((await call('GET', '/api/venue-dashboard/intelligence')).status, 403,
    'the tier was cached across requests, so a lapsed comp kept serving');
});

// ---------------------------------------------------------------------------
// 4. Granting: the admin route writes an end date
// ---------------------------------------------------------------------------

const GRANT_SQL = /INSERT INTO venue_subscriptions/;
const tierWrite = (row) => [/UPDATE venue_profiles SET tier/, () => ({
  rows: row ? [row] : [], rowCount: row ? 1 : 0,
})];
const GRANTED_ROW = { id: 7, business_name: 'The Bar', tier: 'premium' };

// $5 is the end date, $6 says an expiry was named, $7 says the founding default
// applied. Read by name here so a reordering of the params is a failure with a
// sentence attached rather than an off-by-one.
const grantParams = () => {
  const q = ran(GRANT_SQL)[0];
  assert.ok(q, 'the tier route wrote no grant row at all');
  return { tier: q.params[0], userId: q.params[1], expiresAt: q.params[4], explicit: q.params[5], founding: q.params[6], reason: q.params[7], source: q.params[8] };
};

test('a founding comp defaults to the six months the offer actually promises', async () => {
  handlers = [tierWrite(GRANTED_ROW)];
  const res = await call('POST', '/api/admin/venues/2/tier',
    { tier: 'premium', grantReason: 'founding_comp', reason: 'Philly cohort #3' }, MOD);
  assert.strictEqual(res.status, 200, res.text);

  const g = grantParams();
  assert.strictEqual(g.reason, 'founding_comp');
  assert.strictEqual(g.source, 'comp');
  assert.strictEqual(g.founding, true, 'the founding default did not apply');
  assert.ok(g.expiresAt instanceof Date, 'a founding comp was granted with no end date');
  // Six calendar months, give or take a day for month lengths.
  const months = (g.expiresAt.getTime() - Date.now()) / (30.44 * 24 * HOUR);
  assert.ok(months > 5.8 && months < 6.2, `founding comp ran for ${months.toFixed(2)} months, not 6`);
});

test('the whole grant is one statement: cache, grant row and audit row together', async () => {
  handlers = [tierWrite(GRANTED_ROW)];
  await call('POST', '/api/admin/venues/2/tier', { tier: 'premium', grantReason: 'founding_comp' }, MOD);
  assert.strictEqual(log.length, 1, 'the tier write, the grant and its audit row must not be separable');
  const sql = log[0].sql;
  assert.match(sql, /UPDATE venue_profiles SET tier/);
  assert.match(sql, /INSERT INTO venue_subscriptions/);
  assert.match(sql, /INSERT INTO moderation_actions/);
  assert.match(sql, /to_char\(g\.expires_at/,
    'the audit row does not say when the grant ends, so the durable record cannot answer a billing dispute');
});

test('an explicit duration and an explicit date both land on expires_at', async () => {
  handlers = [tierWrite(GRANTED_ROW)];
  await call('POST', '/api/admin/venues/2/tier', { tier: 'pro', durationDays: 30 }, MOD);
  let g = grantParams();
  assert.strictEqual(g.explicit, true);
  assert.strictEqual(g.founding, false);
  const days = (g.expiresAt.getTime() - Date.now()) / (24 * HOUR);
  assert.ok(days > 29.9 && days < 30.1, `durationDays 30 produced ${days.toFixed(2)} days`);

  handlers = [tierWrite(GRANTED_ROW)];
  log = [];
  const iso = new Date(Date.now() + 90 * 24 * HOUR).toISOString();
  await call('POST', '/api/admin/venues/2/tier', { tier: 'pro', expiresAt: iso }, MOD);
  g = grantParams();
  assert.strictEqual(g.explicit, true);
  assert.strictEqual(g.expiresAt.toISOString(), iso);
});

test('a permanent grant has to be asked for, and is still allowed', async () => {
  // expiresAt: null is the admin SAYING "no end date", which is different from
  // not mentioning it. Both are legal; only one of them is a decision.
  handlers = [tierWrite(GRANTED_ROW)];
  await call('POST', '/api/admin/venues/2/tier', { tier: 'pro', expiresAt: null, grantReason: 'paid' }, MOD);
  const g = grantParams();
  assert.strictEqual(g.explicit, true, 'an explicit null was read as "leave it alone"');
  assert.strictEqual(g.expiresAt, null);
});

test('NO GRANT IS EVER SILENTLY EXTENDED', async () => {
  // Re-granting the same tier to fix a typo in the reason must not hand the
  // venue another six months. Omitting the expiry means "leave whatever end date
  // is on file", which the upsert has to express as a CASE and not a COALESCE.
  handlers = [tierWrite(GRANTED_ROW)];
  await call('POST', '/api/admin/venues/2/tier', { tier: 'premium', reason: 'fixing the note' }, MOD);
  const g = grantParams();
  assert.strictEqual(g.explicit, false, 'an omitted expiry was treated as an instruction');
  assert.strictEqual(g.founding, false);
  assert.strictEqual(g.expiresAt, null, 'an omitted expiry sent a date anyway');

  const sql = ran(GRANT_SQL)[0].sql;
  // With $6 and $7 both false the CASE falls through to the stored value.
  assert.match(sql, /expires_at = CASE/, 'the upsert no longer chooses between keeping and replacing the end date');
  assert.match(sql, /ELSE venue_subscriptions\.expires_at END/,
    'omitting an expiry no longer preserves the end date already on file, so a re-grant wipes it to permanent');
  // A repeated founding_comp is a correction, not a renewal: it may fill in a
  // MISSING end date, never replace one.
  assert.match(sql, /WHEN \$7 THEN COALESCE\(venue_subscriptions\.expires_at, EXCLUDED\.expires_at\)/,
    'a second founding_comp grant extends the comp by another six months');
});

test('a downgrade to free clears the end date instead of leaving a lie behind', async () => {
  handlers = [tierWrite({ id: 7, business_name: 'The Bar', tier: 'free' })];
  const res = await call('POST', '/api/admin/venues/2/tier', { tier: 'free' }, MOD);
  assert.strictEqual(res.status, 200, res.text);
  const sql = ran(GRANT_SQL)[0].sql;
  assert.match(sql, /WHEN \$1 = 'free' THEN NULL/);
});

test('a bad duration, a past date, or two ways of saying it are refused before the database', async () => {
  const bad = [
    { tier: 'pro', durationDays: 0 },
    { tier: 'pro', durationDays: -5 },
    { tier: 'pro', durationDays: 1.5 },
    { tier: 'pro', durationDays: '30' },
    { tier: 'pro', durationDays: 99999 },
    { tier: 'pro', expiresAt: 'soon' },
    { tier: 'pro', expiresAt: 12345 },
    { tier: 'pro', expiresAt: new Date(Date.now() - HOUR).toISOString() },
    { tier: 'pro', expiresAt: null, durationDays: 30 },
    { tier: 'pro', grantReason: 'because' },
  ];
  for (const body of bad) {
    handlers = [tierWrite(GRANTED_ROW)];
    log = [];
    const res = await call('POST', '/api/admin/venues/2/tier', body, MOD);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} was accepted: ${res.text}`);
    assert.deepStrictEqual(log, [], `${JSON.stringify(body)} reached the database`);
    assert.ok(!res.body.error.includes('—'), 'em dash in user-visible copy');
  }
});

test('the grant path still refuses everyone but an admin', async () => {
  // The gate this route has always had. Restated because this round gave it a
  // new body shape, and a new body shape is when a gate goes missing.
  handlers = [tierWrite(GRANTED_ROW)];
  const res = await call('POST', '/api/admin/venues/2/tier',
    { tier: 'pro', grantReason: 'founding_comp' }, OWNER);
  assert.strictEqual(res.status, 403, 'a venue owner comped themselves');
  assert.deepStrictEqual(log, [], 'a refused caller reached the database');
});

test('a paid tier cannot be granted to an unverified claim', async () => {
  // VENUE-BILLING.md states this three times because it is the one that costs
  // money if missed. The precondition lives INSIDE the statement (the UPDATE's
  // own WHERE), so there is no window between checking and writing: a profile
  // row comes back with no update attached.
  handlers = [tierWrite({ id: null, business_name: null, tier: null })];
  const res = await call('POST', '/api/admin/venues/2/tier',
    { tier: 'premium', grantReason: 'founding_comp' }, MOD);
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'VENUE_NOT_VERIFIED');
  assert.ok(!res.body.error.includes('—'), 'em dash in user-visible copy');

  const sql = ran(/UPDATE venue_profiles SET tier/)[0].sql;
  assert.match(sql, /AND \(\$1 = 'free' OR old\.verified = true\)/,
    'the verified precondition is gone from the grant statement');
  assert.match(sql, /SELECT user_id, tier, verified FROM venue_profiles/,
    'the statement no longer reads verification from its own snapshot');
});

test('a user with no venue profile at all is still a 404, not a 409', async () => {
  handlers = [tierWrite(null)];
  const res = await call('POST', '/api/admin/venues/2/tier', { tier: 'premium' }, MOD);
  assert.strictEqual(res.status, 404);
});
