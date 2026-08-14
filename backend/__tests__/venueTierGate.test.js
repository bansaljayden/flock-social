// Run: node --test  (from backend/)
//
// Paid-tier boundary round for the venue product (audit 2026-08-14). The
// previous pass proved the tier CANNOT BE WRITTEN by a venue; this one proves
// the paid features are actually BEHIND it, and that the things which cost real
// money to serve demand a proven claim rather than a claimed one.
//
// Pinned here:
//   1. /intelligence (the demand curve) and /strip (the competitive strip) sit
//      behind requireVenueTier('premium') — they were open to every venue owner,
//      free tier included, which is most of what the Insights tier sells.
//   2. Both refuse an UNVERIFIED claim, before spending a Google Places call and
//      before reading the place-id-keyed cache. An unverified claim on someone
//      else's place id bought a forecast and a competitor list on the shared
//      Places budget.
//   3. public-promotions/:placeId gates on the tier held NOW, not merely on
//      `verified` — upgrade, create promotions, downgrade used to keep the
//      benefit permanently, because `verified` never expires.
//   4. submit-review requires evidence the reviewer was there: the same trust
//      rule venue_feedback.verified uses (HMAC-signed NFC tap, or accepted
//      membership in a flock that met at the venue). ON CONFLICT stopped one
//      account repeating itself; nothing stopped it rating a competitor it had
//      never visited.
//   5. Admin verify answers 409 naming the conflicting owner when another
//      account already holds the verified claim on that place, instead of a 500
//      from the unique partial index (migration 002).
//
// Everything drives the real Express routers against a scripted pg fake, so the
// assertions are about what the routes actually send, spend and write.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-tier-gate-test-secret';
// Set BEFORE requiring the router: venueDashboard captures the key at load, and
// with no key the intelligence/strip routes short-circuit before the paid call.
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
      if (out instanceof Error) throw out;
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`));
}

pool.query = (sql, params) => dispatch(sql, params);

// The shared paid-Places budget. Destructured by venueDashboard at load, so it
// must be replaced before the require below.
const placesBudget = require('../utils/placesBudget');
let placesAllowed = true;
let budgetCharges = [];
placesBudget.allowPlacesSearch = (userId) => { budgetCharges.push(userId); return placesAllowed; };

// Weather is destructured at load too.
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');
const adminRouter = require('../routes/admin');

// Called through the module object, so they can be stubbed after the require.
const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({ score: 55, label: 'Moderate', predictionMethod: 'rule_engine', modelVersion: 'test' });
mlPredictor.predictHourlyForecast = async () => [{ hour: 20, score: 70 }, { hour: 21, score: 80 }];

// Google Places, faked. Anything that is not Places (our own test server) goes
// to the real fetch.
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
  placesAllowed = true;
  CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner' };
  delete process.env.VENUE_BILLING_ENABLED;
});

async function call(method, path, body) {
  const res = await realFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const tierIs = (tier) => [/SELECT tier FROM venue_profiles/, () => ({ rows: [{ tier }] })];
const ctxIs = (row) => [/SELECT id, google_place_id, verified FROM venue_profiles/, () => ({ rows: row ? [row] : [] })];
const VERIFIED_CTX = { id: 9, google_place_id: 'PLACE_A', verified: true };
const UNVERIFIED_CTX = { id: 10, google_place_id: 'PLACE_A', verified: false };

const SOURCE = require('fs').readFileSync(require.resolve('../routes/venueDashboard'), 'utf8');

// ---------------------------------------------------------------------------
// 1. The demand curve and the strip are paid features
// ---------------------------------------------------------------------------

for (const path of ['/api/venue-dashboard/intelligence', '/api/venue-dashboard/strip']) {
  test(`GET ${path} is refused on the free tier once billing is on`, async () => {
    process.env.VENUE_BILLING_ENABLED = 'true';
    handlers = [tierIs('free')];
    const res = await call('GET', path);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'UPGRADE_REQUIRED');
    assert.strictEqual(res.body.requiredTier, 'premium');
    // The gate runs before the handler: no profile read, no Google spend.
    assert.strictEqual(ran(/SELECT id, google_place_id, verified/).length, 0, 'the handler ran anyway');
    assert.deepStrictEqual(budgetCharges, [], 'a refused request still charged the Places budget');
  });

  test(`GET ${path} is served on the Insights tier`, async () => {
    process.env.VENUE_BILLING_ENABLED = 'true';
    handlers = [tierIs('premium'), ctxIs(VERIFIED_CTX)];
    const res = await call('GET', path);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, true);
    assert.ok(budgetCharges.length > 0, 'the paid path was never reached');
  });

  test(`GET ${path} stays open while the kill switch is off`, async () => {
    handlers = [ctxIs(VERIFIED_CTX)];
    const res = await call('GET', path);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, true);
    assert.strictEqual(ran(/SELECT tier FROM venue_profiles/).length, 0, 'it read a tier with billing disabled');
  });

  // ---------------------------------------------------------------------------
  // 2. Verified claims only — before any money is spent
  // ---------------------------------------------------------------------------

  test(`GET ${path} refuses an unverified claim and spends nothing`, async () => {
    handlers = [ctxIs(UNVERIFIED_CTX)];
    const res = await call('GET', path);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.available, false);
    assert.strictEqual(res.body.unverified, true);
    assert.deepStrictEqual(budgetCharges, [], 'an unverified claim charged the shared Places budget');
    // Nothing computed leaked into the refusal.
    assert.ok(!('you' in res.body) && !('todayHourly' in res.body) && !('competitors' in res.body));
  });
}

test('the cache cannot hand an unverified claimant the verified owner\'s forecast', async () => {
  // The cache is keyed by place id, and two profiles can name the same place
  // while only one is verified (the unique index in migration 002 is partial).
  // A verification check placed after cacheGet would be no check at all.
  handlers = [ctxIs(VERIFIED_CTX)];
  const warm = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(warm.body.available, true, 'the cache never warmed, so this proves nothing');

  CURRENT_USER = { id: 2, name: 'Squatter', role: 'venue_owner' };
  handlers = [ctxIs(UNVERIFIED_CTX)];
  const res = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(res.body.available, false, 'a cached forecast was served to an unverified claim');
  assert.strictEqual(res.body.unverified, true);

  const strip = await call('GET', '/api/venue-dashboard/strip');
  assert.strictEqual(strip.body.available, false);
});

test('both routes check verification before touching the cache', async () => {
  // Belt and braces for the test above: the ordering is load-bearing, so it is
  // asserted in the source as well as in behaviour.
  for (const marker of ['intel:', 'strip:']) {
    const body = SOURCE.slice(SOURCE.indexOf(`cacheGet(\`${marker}`) - 900, SOURCE.indexOf(`cacheGet(\`${marker}`));
    assert.ok(/ctx\.verified/.test(body), `the ${marker} route reads the cache before checking verification`);
  }
});

// ---------------------------------------------------------------------------
// 3. Serving a paid benefit follows the CURRENT tier
// ---------------------------------------------------------------------------

// Emulates the real filter so the assertion is about behaviour, not SQL text:
// verified author, and (billing off OR tier in the serving set).
const promoRows = (authors) => [/FROM venue_promotions p/, (params) => {
  const [, enforce, tiers] = params;
  return {
    rows: authors
      .filter((a) => a.verified && (enforce === false || tiers.includes(a.tier)))
      .map((a, i) => ({ id: i + 1, title: a.title, description: null, time_slot: null, days: null })),
  };
}];

test('public-promotions serves a paying venue', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [promoRows([{ verified: true, tier: 'premium', title: 'Half price Tuesdays' }]), [/UPDATE venue_promotions SET views/, () => ({ rows: [] })]];
  const res = await call('GET', '/api/venue-dashboard/public-promotions/PLACE_A');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.promotions.length, 1);
});

test('a venue that downgrades stops being promoted', async () => {
  // The exact permanent-benefit bug: `verified` is forever, so a gate on it
  // alone let upgrade -> create -> downgrade keep the placement.
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [promoRows([{ verified: true, tier: 'free', title: 'Half price Tuesdays' }])];
  const res = await call('GET', '/api/venue-dashboard/public-promotions/PLACE_A');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.promotions, []);
  assert.strictEqual(ran(/UPDATE venue_promotions SET views/).length, 0, 'a promotion nobody saw still counted a view');
});

test('public-promotions gates on tier, not only on verification', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [promoRows([])];
  await call('GET', '/api/venue-dashboard/public-promotions/PLACE_A');
  const q = ran(/FROM venue_promotions p/)[0];
  assert.ok(/vp\.verified = true/.test(q.sql), 'the verification join is gone');
  assert.ok(/vp\.tier = ANY\(\$3::text\[\]\)/.test(q.sql), 'there is no current-tier filter');
  assert.deepStrictEqual(q.params, ['PLACE_A', true, ['premium', 'pro']]);
});

test('the promotions tier filter is inert while the kill switch is off', async () => {
  // "Flag off => every venue owner acts Pro" has to hold on a public route too.
  handlers = [promoRows([{ verified: true, tier: 'free', title: 'Half price Tuesdays' }]), [/UPDATE venue_promotions SET views/, () => ({ rows: [] })]];
  const res = await call('GET', '/api/venue-dashboard/public-promotions/PLACE_A');
  assert.strictEqual(res.body.promotions.length, 1);
  assert.strictEqual(ran(/FROM venue_promotions p/)[0].params[1], false);
});

// ---------------------------------------------------------------------------
// 4. A review requires a visit
// ---------------------------------------------------------------------------

const visited = (yes) => [/AS visited/, () => ({ rows: [{ visited: yes }] })];
const reviewInsert = [/INSERT INTO venue_reviews/, () => ({ rows: [{ id: 1, rating: 5 }] })];
const REVIEW = { googlePlaceId: 'PLACE_A', rating: 1, text: 'Bad' };

test('a user who has never been there cannot review the venue', async () => {
  handlers = [visited(false), reviewInsert];
  const res = await call('POST', '/api/venue-dashboard/submit-review', REVIEW);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'VISIT_REQUIRED');
  assert.strictEqual(ran(/INSERT INTO venue_reviews/).length, 0, 'the rating was written anyway');
});

test('a user with a proven visit still reviews normally', async () => {
  handlers = [visited(true), reviewInsert];
  const res = await call('POST', '/api/venue-dashboard/submit-review', REVIEW);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(ran(/INSERT INTO venue_reviews/).length, 1);
});

test('a presence check that cannot answer refuses the review', async () => {
  // Fail closed: an unreadable signal is not a visit.
  handlers = [[/AS visited/, () => ({ rows: [] })], reviewInsert];
  const res = await call('POST', '/api/venue-dashboard/submit-review', REVIEW);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ran(/INSERT INTO venue_reviews/).length, 0);
});

test('the visit rule is the one venue_feedback.verified uses', async () => {
  handlers = [visited(true), reviewInsert];
  await call('POST', '/api/venue-dashboard/submit-review', REVIEW);
  const q = ran(/AS visited/)[0];
  // Signed taps only. Migration 004 records unsigned URL visits as
  // 'nfc_unverified', so an allowlist is the difference between proof of
  // presence and proof that someone opened a link.
  assert.ok(/checkin_source = 'nfc'/.test(q.sql), 'the check-in signal is not restricted to signed taps');
  assert.ok(!/<>\s*'manual'/.test(q.sql), 'a blocklist would trust unsigned taps');
  // ...or the flock the product itself created.
  assert.ok(/fm\.status = 'accepted'/.test(q.sql), 'an invitation nobody accepted counts as a visit');
  assert.ok(/f\.venue_id = \$2/.test(q.sql), 'the flock is not tied to the reviewed venue');
  // A cancelled flock is an explicit "we did not go".
  assert.ok(/f\.status IS DISTINCT FROM 'cancelled'/.test(q.sql), 'a cancelled flock counts as a visit');
  // The route is an upsert, so editing a review you already wrote must survive
  // the visit falling out of the window.
  assert.ok(/FROM venue_reviews WHERE user_id = \$1/.test(q.sql), 'you can no longer edit your own old review');
  assert.deepStrictEqual(q.params, [1, 'PLACE_A']);
});

test('validation still runs before the presence query', async () => {
  handlers = [];
  const res = await call('POST', '/api/venue-dashboard/submit-review', { googlePlaceId: 'PLACE_A', rating: 9 });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(log.length, 0, 'an invalid body reached the database');
});

// ---------------------------------------------------------------------------
// 5. Admin verify: a taken place is a 409, not a 500
// ---------------------------------------------------------------------------

const ADMIN = { id: 99, name: 'Root', role: 'admin' };
const verifyReturns = (row) => [/UPDATE venue_profiles SET verified/, () => ({ rows: row ? [row] : [] })];

test('verifying a place another account already holds is a 409 naming the conflict', async () => {
  CURRENT_USER = ADMIN;
  handlers = [verifyReturns({ id: null, business_name: null, verified: null, google_place_id: 'PLACE_A', conflict_user_id: 42 })];
  const res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'PLACE_ALREADY_VERIFIED');
  assert.strictEqual(res.body.conflictUserId, 42);
  assert.match(res.body.error, /42/);
  assert.match(res.body.error, /PLACE_A/);
});

test('a blocked write is a 409 even when the conflicting owner has no user id', async () => {
  // venue_profiles.user_id is nullable, so reading the refusal off
  // conflict_user_id alone would have answered 200 with a row of nulls — the
  // admin told the claim was verified when the UPDATE never fired.
  CURRENT_USER = ADMIN;
  handlers = [verifyReturns({ id: null, business_name: null, verified: null, google_place_id: 'PLACE_A', conflict_user_id: null })];
  const res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'PLACE_ALREADY_VERIFIED');
  assert.strictEqual(res.body.conflictUserId, null);
  assert.match(res.body.error, /PLACE_A/);
});

test('the conflict is decided in the same statement as the write', async () => {
  // A separate pre-check would leave a window in which both claims verify and
  // the second one still 500s on the unique index.
  CURRENT_USER = ADMIN;
  handlers = [verifyReturns({ id: 7, business_name: 'V', verified: true, google_place_id: 'PLACE_A', conflict_user_id: null })];
  await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(log.length, 1, 'the route issued more than one query');
  const sql = log[0].sql;
  assert.ok(/other\.verified = true/.test(sql), 'nothing looks for a rival verified claim');
  assert.ok(/other\.id <> t\.id/.test(sql), 'the profile being verified conflicts with itself');
  assert.ok(/\$1::boolean = true/.test(sql), 'un-verifying would be blocked by its own conflict check');
  assert.ok(/t\.google_place_id IS NOT NULL/.test(sql), 'profiles with no place id conflict with each other');
});

test('losing the unique-index race is a 409 too, never a 500', async () => {
  CURRENT_USER = ADMIN;
  const dup = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
  handlers = [[/UPDATE venue_profiles SET verified/, () => dup]];
  const res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'PLACE_ALREADY_VERIFIED');
});

test('a clean verify still returns the profile, and a missing one is still 404', async () => {
  CURRENT_USER = ADMIN;
  handlers = [verifyReturns({ id: 7, business_name: 'The Bar', verified: true, google_place_id: 'PLACE_A', conflict_user_id: null })];
  let res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { id: 7, business_name: 'The Bar', verified: true });

  handlers = [verifyReturns(null)];
  res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 404);
});

test('un-verifying is never refused as a conflict', async () => {
  CURRENT_USER = ADMIN;
  handlers = [verifyReturns({ id: 7, business_name: 'The Bar', verified: false, google_place_id: 'PLACE_A', conflict_user_id: null })];
  const res = await call('PUT', '/api/admin/venues/7/verify', { verified: false });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.verified, false);
  assert.strictEqual(log[0].params[0], false);
});

test('a non-boolean `verified` is refused instead of coerced', async () => {
  // The string "false" is truthy, so it used to VERIFY the claim — the wrong
  // direction to get wrong on the route that decides who speaks as a business.
  CURRENT_USER = ADMIN;
  handlers = [verifyReturns({ id: 7, business_name: 'V', verified: true, google_place_id: 'PLACE_A', conflict_user_id: null })];
  for (const bad of ['false', 0, 'true', null]) {
    log = [];
    const res = await call('PUT', '/api/admin/venues/7/verify', { verified: bad });
    assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(bad)}`);
    assert.strictEqual(log.length, 0, 'the bad value reached the database');
  }
  // An empty body still means "verify", which is what the admin UI sends.
  const ok = await call('PUT', '/api/admin/venues/7/verify', {});
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(log[0].params[0], true);
});

test('a non-admin cannot verify anything', async () => {
  CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner' };
  handlers = [];
  const res = await call('PUT', '/api/admin/venues/7/verify', { verified: true });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(log.length, 0);
});
