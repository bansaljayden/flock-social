// Run: node --test  (from backend/)
//
// Object-authorization sweep of routes/venueDashboard.js (audit 2026-08-14).
// Threat model: venue owner A (authenticated, verified) probing venue B's data
// through every endpoint, and a plain user (no venue profile at all) probing
// any venue's owner surfaces. Every endpoint here was found correctly scoped;
// this file PINS that, so a future edit that drops an ownership predicate
// fails a named test instead of shipping an IDOR.
//
// The pg fake is deliberately adversarial: for each statement it EXTRACTS the
// ownership predicate from the SQL the route actually sent (`venue_user_id =
// $n`, `google_place_id = $n`, `vv.venue_id = $n`) and only filters the
// in-memory rows when that predicate is present. If a route ever loses its
// ownership clause, the fake stops filtering, B's row comes back to A, and the
// attack assertion fails — the fake cannot silently supply the security the
// route forgot.
//
// Matrix pinned here:
//   1. Promotions: list/edit/delete are scoped to the caller; A editing or
//      deleting B's promotion is a 404 and B's row is untouched. A hidden
//      promotion of B's answers A the same 404, never the 409 CONTENT_HIDDEN
//      that would leak B's moderation state.
//   2. Events: same matrix, same verdicts.
//   3. Reviews: the reply write is keyed to the caller's OWN verified place;
//      replying to a review of B's venue is a 404 with no write. A plain user
//      and an unverified claim are both 403 before any UPDATE exists to run.
//   4. Incoming flocks / owner reviews tab: the place id is derived
//      server-side from the caller's profile; client-supplied place ids in the
//      query string are ignored, and the WHERE clause carries the caller's own
//      place id only.
//   5. Intelligence / strip: the Google fetch is for the caller's own linked
//      place regardless of what the query string claims; a plain user gets
//      available:false without spending the shared Places budget.
//   6. Ownership is never client-supplied on the write path: venue_user_id /
//      google_place_id smuggled into a create body are discarded in favour of
//      req.user.id and the server-side profile row.
//   7. Tier gates (billing on): every mutation, the flocks feed, and both
//      model surfaces refuse a free tier with UPGRADE_REQUIRED before touching
//      the venue's data; the Free-tier surfaces (own lists, reviews tab,
//      review reply) still answer, per the VENUE-BILLING.md pricing table.
//   8. Id-type confusion: non-numeric, fractional, and beyond-int4 ids are
//      refused by the validators before any SQL runs.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-dashboard-authz-test-secret';
// Set BEFORE requiring the router: venueDashboard captures the key at load.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

let log = [];

// ── In-memory tables, reset per test ────────────────────────────────────────
let PROFILES, PROMOS, EVENTS, REVIEWS, FLOCK_ROWS;

function resetTables() {
  PROFILES = [
    { user_id: 1, id: 11, google_place_id: 'PLACE_A', verified: true, tier: 'free' },
    { user_id: 2, id: 22, google_place_id: 'PLACE_B', verified: true, tier: 'premium' },
  ];
  PROMOS = [
    { id: 401, venue_user_id: 1, google_place_id: 'PLACE_A', title: 'A happy hour', description: null, time_slot: null, days: null, is_hidden: false, owner_deleted_at: null, active: true, open_report: false },
    { id: 501, venue_user_id: 2, google_place_id: 'PLACE_B', title: 'B secret deal', description: null, time_slot: null, days: null, is_hidden: false, owner_deleted_at: null, active: true, open_report: false },
    { id: 502, venue_user_id: 2, google_place_id: 'PLACE_B', title: 'B hidden deal', description: null, time_slot: null, days: null, is_hidden: true, owner_deleted_at: null, active: true, open_report: false },
  ];
  EVENTS = [
    { id: 601, venue_user_id: 1, google_place_id: 'PLACE_A', title: 'A trivia night', event_date: null, event_time: null, capacity: 50, is_hidden: false, owner_deleted_at: null, open_report: false },
    { id: 602, venue_user_id: 2, google_place_id: 'PLACE_B', title: 'B secret gala', event_date: null, event_time: null, capacity: 50, is_hidden: false, owner_deleted_at: null, open_report: false },
  ];
  REVIEWS = [
    { id: 701, google_place_id: 'PLACE_B', user_id: 9, rating: 2, text: 'meh', is_hidden: false, venue_reply: null, venue_replied_at: null },
    { id: 702, google_place_id: 'PLACE_A', user_id: 9, rating: 5, text: 'great', is_hidden: false, venue_reply: null, venue_replied_at: null },
    { id: 703, google_place_id: 'PLACE_A', user_id: 9, rating: 1, text: 'hidden harassment', is_hidden: true, venue_reply: null, venue_replied_at: null },
  ];
  FLOCK_ROWS = [
    { id: 31, venue_id: 'PLACE_A', title: 'A crew', event_time: null, status: 'active', member_count: 4 },
    { id: 32, venue_id: 'PLACE_B', title: 'B private group', event_time: null, status: 'active', member_count: 3 },
  ];
}

// Extract the 0-based param index bound to a predicate in the SQL the route
// actually sent. Returns null when the predicate is ABSENT — in which case the
// fake does not filter, which is exactly what a real database would do.
function pidx(sql, re) {
  const m = sql.match(re);
  return m ? parseInt(m[1], 10) - 1 : null;
}
const OWNER_RE = /venue_user_id = \$(\d+)/;
// \b keeps this from matching inside venue_user_id / google_place_id / user_id.
const ID_RE = /\bid = \$(\d+)/;

function dispatch(rawSql, params = []) {
  const sql = String(rawSql).replace(/\s+/g, ' ').trim();
  log.push({ sql, params });

  // Venue context (getVenueCtx)
  if (/SELECT id, google_place_id, verified FROM venue_profiles/.test(sql)) {
    const u = pidx(sql, /user_id = \$(\d+)/);
    const rows = PROFILES
      .filter((p) => u === null || p.user_id === params[u])
      .map(({ id, google_place_id, verified }) => ({ id, google_place_id, verified }));
    return { rows };
  }

  // Tier lookup (venueEntitlements.getVenueTier)
  if (/SELECT tier FROM venue_profiles/.test(sql)) {
    const u = pidx(sql, /user_id = \$(\d+)/);
    const p = PROFILES.find((x) => u !== null && x.user_id === params[u]);
    return { rows: p ? [{ tier: p.tier }] : [] };
  }

  // Owner list reads
  if (/^SELECT \* FROM venue_promotions/.test(sql) || /^SELECT \* FROM venue_events/.test(sql)) {
    const table = /venue_promotions/.test(sql) ? PROMOS : EVENTS;
    const o = pidx(sql, OWNER_RE);
    const rows = table.filter((r) =>
      (o === null || r.venue_user_id === params[o]) &&
      (!/owner_deleted_at IS NULL/.test(sql) || r.owner_deleted_at == null));
    return { rows: rows.map((r) => ({ ...r })) };
  }

  // PUT CTE (promotions and events share the shape)
  if (/WITH target AS/.test(sql) && /(venue_promotions|venue_events)/.test(sql)) {
    const isPromo = /FROM venue_promotions WHERE/.test(sql);
    const table = isPromo ? PROMOS : EVENTS;
    const i = pidx(sql, ID_RE);
    const o = pidx(sql, OWNER_RE);
    const row = table.find((r) =>
      i !== null && r.id === Number(params[i]) &&
      (o === null || r.venue_user_id === params[o]) &&
      (!/owner_deleted_at IS NULL/.test(sql) || r.owner_deleted_at == null));
    if (!row) return { rows: [] };
    if (row.is_hidden) return { rows: [{ target_hidden: true, id: null }] };
    if (isPromo) {
      row.title = params[0] ?? row.title;
      row.description = params[1] ?? row.description;
      row.time_slot = params[2] ?? row.time_slot;
      row.days = params[3] ?? row.days;
    } else {
      row.title = params[0] ?? row.title;
      row.event_date = params[1] ?? row.event_date;
      row.event_time = params[2] ?? row.event_time;
      row.capacity = params[3] ?? row.capacity;
    }
    return { rows: [{ target_hidden: false, ...row }] };
  }

  // DELETE with evidence guard
  if (/^DELETE FROM (venue_promotions|venue_events)/.test(sql)) {
    const table = /venue_promotions/.test(sql) ? PROMOS : EVENTS;
    const i = pidx(sql, ID_RE);
    const o = pidx(sql, OWNER_RE);
    const guarded = /NOT EXISTS/.test(sql) && /content_reports/.test(sql);
    const hits = table.filter((r) =>
      (o === null || r.venue_user_id === params[o]) &&
      ((i !== null && r.id === Number(params[i])) ||
        (/owner_deleted_at IS NOT NULL/.test(sql) && r.owner_deleted_at != null)) &&
      !(guarded && r.open_report));
    for (const r of hits) table.splice(table.indexOf(r), 1);
    return { rows: hits.map((r) => ({ id: r.id })) };
  }

  // Retire (evidence retention) UPDATE
  if (/^UPDATE (venue_promotions|venue_events) SET owner_deleted_at/.test(sql)) {
    const table = /venue_promotions/.test(sql) ? PROMOS : EVENTS;
    const i = pidx(sql, ID_RE);
    const o = pidx(sql, OWNER_RE);
    const row = table.find((r) =>
      i !== null && r.id === Number(params[i]) &&
      (o === null || r.venue_user_id === params[o]) &&
      r.owner_deleted_at == null);
    if (!row) return { rows: [] };
    row.owner_deleted_at = new Date();
    if ('active' in row) row.active = false;
    return { rows: [{ id: row.id }] };
  }

  // Creates
  if (/^INSERT INTO venue_promotions/.test(sql)) {
    const row = { id: 900 + PROMOS.length, venue_user_id: params[0], google_place_id: params[1], title: params[2], description: params[3], time_slot: params[4], days: params[5], is_hidden: false, owner_deleted_at: null, active: true, open_report: false };
    PROMOS.push(row);
    return { rows: [{ ...row }] };
  }
  if (/^INSERT INTO venue_events/.test(sql)) {
    const row = { id: 950 + EVENTS.length, venue_user_id: params[0], google_place_id: params[1], title: params[2], event_date: params[3], event_time: params[4], capacity: params[5], is_hidden: false, owner_deleted_at: null, open_report: false };
    EVENTS.push(row);
    return { rows: [{ ...row }] };
  }

  // Incoming flocks
  if (/FROM flocks f JOIN venue_votes vv/.test(sql)) {
    const v = pidx(sql, /vv\.venue_id = \$(\d+)/);
    const rows = FLOCK_ROWS
      .filter((f) => v === null || f.venue_id === params[v])
      .map(({ id, title, event_time, status, member_count }) => ({ id, title, event_time, status, member_count }));
    return { rows };
  }

  // Owner reviews tab: stats then list
  if (/FROM venue_reviews vr JOIN users u/.test(sql) && /AS total/.test(sql)) {
    const p = pidx(sql, /google_place_id = \$(\d+)/);
    const visible = REVIEWS.filter((r) => (p === null || r.google_place_id === params[p]) && !r.is_hidden);
    const n = visible.length;
    const avg = n ? visible.reduce((a, r) => a + r.rating, 0) / n : null;
    const dist = (k) => visible.filter((r) => r.rating === k).length;
    return { rows: [{ total: n, average: avg, r1: dist(1), r2: dist(2), r3: dist(3), r4: dist(4), r5: dist(5) }] };
  }
  if (/^SELECT vr\.\*, u\.name/.test(sql)) {
    const p = pidx(sql, /google_place_id = \$(\d+)/);
    const rows = REVIEWS
      .filter((r) => (p === null || r.google_place_id === params[p]) && !r.is_hidden)
      .map((r) => ({ ...r, name: 'Reviewer', profile_image_url: null }));
    return { rows };
  }

  // Owner reply write
  if (/^UPDATE venue_reviews SET venue_reply/.test(sql)) {
    const i = pidx(sql, ID_RE);
    const p = pidx(sql, /google_place_id = \$(\d+)/);
    const row = REVIEWS.find((r) =>
      i !== null && r.id === Number(params[i]) &&
      (p === null || r.google_place_id === params[p]) &&
      (!/is_hidden/.test(sql) || !r.is_hidden));
    if (!row) return { rows: [] };
    row.venue_reply = params[0];
    row.venue_replied_at = new Date();
    return { rows: [{ ...row }] };
  }

  return Promise.reject(new Error(`unscripted query: ${sql.slice(0, 160)}`));
}

pool.query = (sql, params) => Promise.resolve(dispatch(sql, params));

// Stubs the router destructures at load — must be replaced before the require.
const placesBudget = require('../utils/placesBudget');
let budgetCharges = [];
placesBudget.allowPlacesSearch = (userId) => { budgetCharges.push(userId); return true; };
const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 60, condition: 'Clear' });

const authMod = require('../middleware/auth');
const OWNER_A = { id: 1, name: 'Ava', role: 'venue_owner' };
const OWNER_B = { id: 2, name: 'Bea', role: 'venue_owner' };
const PLAIN_USER = { id: 3, name: 'Cal', role: 'user' };
let CURRENT_USER = OWNER_A;
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');

const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({ score: 55, label: 'Moderate', predictionMethod: 'rule_engine', modelVersion: 'test' });
mlPredictor.predictHourlyForecast = async () => [{ hour: 20, score: 70 }, { hour: 21, score: 80 }];

// Google Places, faked; every requested URL is recorded so the tests can
// assert WHOSE place the server actually asked about.
let placesFetches = [];
const mkPlace = (id) => ({
  id,
  displayName: { text: id === 'PLACE_A' ? 'The A Bar' : 'The B Bar' },
  rating: 4.4,
  userRatingCount: 120,
  types: ['bar'],
  location: { latitude: 39.74, longitude: -104.98 },
  currentOpeningHours: { openNow: true },
  utcOffsetMinutes: -360,
});
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/v1/places:searchNearby')) {
    placesFetches.push(u);
    return Promise.resolve({ status: 200, json: async () => ({ places: [] }) });
  }
  if (u.startsWith('https://places.googleapis.com/v1/places/')) {
    placesFetches.push(u);
    const id = decodeURIComponent(u.slice('https://places.googleapis.com/v1/places/'.length));
    return Promise.resolve({ status: 200, json: async () => mkPlace(id) });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const app = express();
app.use(express.json());
app.use('/api/venue-dashboard', venueDashboardRouter);

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
  resetTables();
  log = [];
  budgetCharges = [];
  placesFetches = [];
  CURRENT_USER = OWNER_A;
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
const promo = (id) => PROMOS.find((r) => r.id === id);
const event = (id) => EVENTS.find((r) => r.id === id);
const review = (id) => REVIEWS.find((r) => r.id === id);

// ───────────────────────────────────────────────────────────────────────────
// 1. Promotions: A cannot read, edit, or delete B's
// ───────────────────────────────────────────────────────────────────────────

test('GET /promotions returns only the caller\'s rows', async () => {
  const res = await call('GET', '/api/venue-dashboard/promotions');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.promotions.map((p) => p.id), [401]);
  assert.ok(!JSON.stringify(res.body).includes('B secret deal'), "B's promotion leaked into A's list");
});

test('A editing B\'s promotion is a 404 and B\'s row is untouched', async () => {
  const res = await call('PUT', '/api/venue-dashboard/promotions/501', { title: 'Hijacked' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(promo(501).title, 'B secret deal', "B's promotion was modified by A");
});

test('A editing B\'s HIDDEN promotion is the same 404, never the 409 moderation leak', async () => {
  // 409 CONTENT_HIDDEN is the answer for the OWNER's own taken-down row.
  // Handing it to a stranger confirms both existence and moderation state.
  const res = await call('PUT', '/api/venue-dashboard/promotions/502', { title: 'Hijacked' });
  assert.strictEqual(res.status, 404);
  assert.notStrictEqual(res.body.code, 'CONTENT_HIDDEN');
});

test('A deleting B\'s promotion is a 404 and B\'s row survives', async () => {
  const res = await call('DELETE', '/api/venue-dashboard/promotions/501');
  assert.strictEqual(res.status, 404);
  assert.ok(promo(501), "B's promotion was deleted by A");
  assert.strictEqual(promo(501).owner_deleted_at, null, "B's promotion was retired by A");
});

test('the owner\'s own promotion edit and delete still work (attack 404s are not a broken route)', async () => {
  const edit = await call('PUT', '/api/venue-dashboard/promotions/401', { title: 'A happier hour' });
  assert.strictEqual(edit.status, 200);
  assert.strictEqual(edit.body.title, 'A happier hour');
  const del = await call('DELETE', '/api/venue-dashboard/promotions/401');
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.success, true);
  assert.strictEqual(promo(401), undefined);
});

test('a smuggled venue_user_id / place id on promotion create is discarded for req.user', async () => {
  const res = await call('POST', '/api/venue-dashboard/promotions', {
    title: 'Legit title',
    venue_user_id: 2,
    venueUserId: 2,
    google_place_id: 'PLACE_B',
    googlePlaceId: 'PLACE_B',
  });
  assert.strictEqual(res.status, 201);
  const ins = ran(/^INSERT INTO venue_promotions/)[0];
  assert.strictEqual(ins.params[0], 1, 'the insert did not use req.user.id as the owner');
  assert.strictEqual(ins.params[1], 'PLACE_A', 'the insert did not use the server-side profile place id');
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Events: same matrix
// ───────────────────────────────────────────────────────────────────────────

test('GET /events returns only the caller\'s rows', async () => {
  const res = await call('GET', '/api/venue-dashboard/events');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.events.map((e) => e.id), [601]);
  assert.ok(!JSON.stringify(res.body).includes('B secret gala'), "B's event leaked into A's list");
});

test('A editing B\'s event is a 404 and B\'s row is untouched', async () => {
  const res = await call('PUT', '/api/venue-dashboard/events/602', { title: 'Hijacked' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(event(602).title, 'B secret gala', "B's event was modified by A");
});

test('A deleting B\'s event is a 404 and B\'s row survives', async () => {
  const res = await call('DELETE', '/api/venue-dashboard/events/602');
  assert.strictEqual(res.status, 404);
  assert.ok(event(602), "B's event was deleted by A");
  assert.strictEqual(event(602).owner_deleted_at, null, "B's event was retired by A");
});

test('the owner\'s own event edit still works', async () => {
  const res = await call('PUT', '/api/venue-dashboard/events/601', { title: 'A bigger trivia night' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.title, 'A bigger trivia night');
});

test('a smuggled owner on event create is discarded for req.user', async () => {
  const res = await call('POST', '/api/venue-dashboard/events', {
    title: 'Legit event',
    venue_user_id: 2,
    google_place_id: 'PLACE_B',
  });
  assert.strictEqual(res.status, 201);
  const ins = ran(/^INSERT INTO venue_events/)[0];
  assert.strictEqual(ins.params[0], 1);
  assert.strictEqual(ins.params[1], 'PLACE_A');
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Review reply: keyed to the caller's own verified place
// ───────────────────────────────────────────────────────────────────────────

test('A replying to a review of B\'s venue is a 404 with no write', async () => {
  const res = await call('POST', '/api/venue-dashboard/reviews/701/reply', { reply: 'Thanks from the wrong bar' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(review(701).venue_reply, null, "A's reply was written onto B's review");
});

test('A replying to a review of their own venue still works', async () => {
  const res = await call('POST', '/api/venue-dashboard/reviews/702/reply', { reply: 'Thanks for coming' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(review(702).venue_reply, 'Thanks for coming');
});

test('a hidden review on the caller\'s own venue answers 404, and no reply lands on it', async () => {
  const res = await call('POST', '/api/venue-dashboard/reviews/703/reply', { reply: 'Reply to removed content' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(review(703).venue_reply, null);
});

test('a plain user cannot reply to anyone\'s review', async () => {
  CURRENT_USER = PLAIN_USER;
  const res = await call('POST', '/api/venue-dashboard/reviews/701/reply', { reply: 'I am not a venue' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ran(/UPDATE venue_reviews/).length, 0, 'the reply write ran anyway');
});

test('an unverified claim cannot speak as the business', async () => {
  PROFILES[0].verified = false;
  const res = await call('POST', '/api/venue-dashboard/reviews/702/reply', { reply: 'Unverified voice' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ran(/UPDATE venue_reviews/).length, 0);
  assert.strictEqual(review(702).venue_reply, null);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Incoming flocks and the owner reviews tab: place id is server-derived
// ───────────────────────────────────────────────────────────────────────────

test('incoming-flocks is keyed to the caller\'s own place, query string ignored', async () => {
  const res = await call('GET', '/api/venue-dashboard/incoming-flocks?placeId=PLACE_B&venueId=PLACE_B&google_place_id=PLACE_B');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.flocks.map((f) => f.id), [31], "another venue's incoming flocks were served");
  const q = ran(/FROM flocks f JOIN venue_votes vv/)[0];
  assert.deepStrictEqual(q.params, ['PLACE_A'], 'the flocks query was not bound to the server-side place id');
});

test('an unverified claim gets no incoming flocks and no flocks query runs', async () => {
  PROFILES[0].verified = false;
  const res = await call('GET', '/api/venue-dashboard/incoming-flocks');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.flocks, []);
  assert.strictEqual(res.body.unverified, true);
  assert.strictEqual(ran(/FROM flocks f/).length, 0, 'the flocks query ran for an unverified claim');
});

test('a plain user gets an empty incoming-flocks feed, not someone\'s data', async () => {
  CURRENT_USER = PLAIN_USER;
  const res = await call('GET', '/api/venue-dashboard/incoming-flocks');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.flocks, []);
  assert.strictEqual(ran(/FROM flocks f/).length, 0);
});

test('the owner reviews tab reads the caller\'s own place only, query string ignored', async () => {
  const res = await call('GET', '/api/venue-dashboard/reviews?placeId=PLACE_B&googlePlaceId=PLACE_B');
  assert.strictEqual(res.status, 200);
  for (const q of ran(/FROM venue_reviews vr JOIN users u/)) {
    assert.strictEqual(q.params[0], 'PLACE_A', 'a reviews query was keyed to a client-supplied place id');
  }
  assert.deepStrictEqual(res.body.reviews.map((r) => r.id), [702], "another venue's reviews were served");
});

test('a plain user probing the owner reviews tab gets nothing and no query runs', async () => {
  CURRENT_USER = PLAIN_USER;
  const res = await call('GET', '/api/venue-dashboard/reviews');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { reviews: [], stats: null });
  assert.strictEqual(ran(/FROM venue_reviews/).length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Intelligence and strip: the model runs on the caller's own place
// ───────────────────────────────────────────────────────────────────────────

test('intelligence forecasts the caller\'s own place, whatever the query string claims', async () => {
  const res = await call('GET', '/api/venue-dashboard/intelligence?placeId=PLACE_B&googlePlaceId=PLACE_B');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.available, true);
  assert.strictEqual(res.body.venue.placeId, 'PLACE_A', "the forecast was built for a client-supplied place");
  for (const u of placesFetches) {
    assert.ok(!u.includes('PLACE_B'), 'a Google call was made for a client-supplied place id');
  }
});

test('strip is centered on the caller\'s own place, whatever the query string claims', async () => {
  const res = await call('GET', '/api/venue-dashboard/strip?placeId=PLACE_B');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.available, true);
  assert.strictEqual(res.body.you.name, 'The A Bar');
  assert.ok(placesFetches.length === 0 || placesFetches.every((u) => !u.includes('PLACE_B')));
});

test('a plain user gets available:false from intelligence and spends nothing', async () => {
  CURRENT_USER = PLAIN_USER;
  const res = await call('GET', '/api/venue-dashboard/intelligence');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.available, false);
  assert.deepStrictEqual(budgetCharges, [], 'a user with no venue charged the shared Places budget');
  assert.deepStrictEqual(placesFetches, []);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Tier gates, billing on: the paid boundary matches the dashboard UI
// ───────────────────────────────────────────────────────────────────────────

const PREMIUM_SURFACES = [
  ['POST', '/api/venue-dashboard/promotions', { title: 'x' }],
  ['PUT', '/api/venue-dashboard/promotions/401', { title: 'x' }],
  ['DELETE', '/api/venue-dashboard/promotions/401', undefined],
  ['POST', '/api/venue-dashboard/events', { title: 'x' }],
  ['PUT', '/api/venue-dashboard/events/601', { title: 'x' }],
  ['DELETE', '/api/venue-dashboard/events/601', undefined],
  ['GET', '/api/venue-dashboard/incoming-flocks', undefined],
  ['GET', '/api/venue-dashboard/intelligence', undefined],
  ['GET', '/api/venue-dashboard/strip', undefined],
];

test('every premium surface refuses a free tier before touching venue data', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  for (const [method, path, body] of PREMIUM_SURFACES) {
    log = [];
    const res = await call(method, path, body);
    assert.strictEqual(res.status, 403, `${method} ${path} was served to a free tier`);
    assert.strictEqual(res.body.code, 'UPGRADE_REQUIRED', `${method} ${path} refused with the wrong contract`);
    assert.strictEqual(res.body.requiredTier, 'premium');
    const nonTier = log.filter((q) => !/SELECT tier FROM venue_profiles/.test(q.sql));
    assert.deepStrictEqual(nonTier, [], `${method} ${path} touched data behind the refused gate`);
  }
  // And nothing changed under any of those attempts.
  assert.strictEqual(promo(401).title, 'A happy hour');
  assert.strictEqual(event(601).title, 'A trivia night');
});

test('the Insights tier passes the same gates (the gate is the tier, not the route)', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  CURRENT_USER = OWNER_B;
  const res = await call('POST', '/api/venue-dashboard/promotions', { title: 'B new deal' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(ran(/^INSERT INTO venue_promotions/)[0].params[0], 2);
});

test('the Free-tier surfaces still answer with billing on: own lists, reviews, reply', async () => {
  // VENUE-BILLING.md Free row: "Claimed profile, hours, logo, reviews + reply".
  // The list GETs return the owner's OWN rows only (creation, edits and public
  // serving are all premium-gated), so they stay free with the reviews tab.
  process.env.VENUE_BILLING_ENABLED = 'true';
  const lists = await Promise.all([
    call('GET', '/api/venue-dashboard/promotions'),
    call('GET', '/api/venue-dashboard/events'),
    call('GET', '/api/venue-dashboard/reviews'),
  ]);
  for (const r of lists) assert.strictEqual(r.status, 200);
  const reply = await call('POST', '/api/venue-dashboard/reviews/702/reply', { reply: 'Free tier can still reply' });
  assert.strictEqual(reply.status, 200);
  assert.strictEqual(ran(/SELECT tier FROM venue_profiles/).length, 0, 'a Free-tier surface consulted the tier gate');
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Id-type confusion: refused before any SQL
// ───────────────────────────────────────────────────────────────────────────

test('non-numeric, fractional and beyond-int4 ids never reach the database', async () => {
  for (const bad of ['abc', '501.5', '99999999999999999999', '-1', '0']) {
    log = [];
    const put = await call('PUT', `/api/venue-dashboard/promotions/${bad}`, { title: 'x' });
    assert.strictEqual(put.status, 400, `PUT accepted id ${bad}`);
    assert.deepStrictEqual(log, [], `PUT with id ${bad} reached the database`);

    log = [];
    const del = await call('DELETE', `/api/venue-dashboard/promotions/${bad}`);
    assert.strictEqual(del.status, 404, `DELETE accepted id ${bad}`);
    assert.deepStrictEqual(log, [], `DELETE with id ${bad} reached the database`);

    log = [];
    const reply = await call('POST', `/api/venue-dashboard/reviews/${bad}/reply`, { reply: 'x' });
    assert.strictEqual(reply.status, 400, `reply accepted id ${bad}`);
    assert.deepStrictEqual(log, [], `reply with id ${bad} reached the database`);
  }
});

test('a plain user attacking B\'s promotion by id gets the same 404 as any stranger', async () => {
  CURRENT_USER = PLAIN_USER;
  const put = await call('PUT', '/api/venue-dashboard/promotions/501', { title: 'Hijacked' });
  assert.strictEqual(put.status, 404);
  const del = await call('DELETE', '/api/venue-dashboard/promotions/501');
  assert.strictEqual(del.status, 404);
  assert.strictEqual(promo(501).title, 'B secret deal');
  assert.strictEqual(promo(501).owner_deleted_at, null);
});
