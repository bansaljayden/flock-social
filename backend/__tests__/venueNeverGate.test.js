// Run: node --test  (from backend/)
//
// THE NEVER-GATE LIST, WITH BILLING ON AND A FREE VENUE.
//
// venueTierGate.test.js proves the Roost routes sit behind the plan. This is
// its mirror image, the assertion VENUE-BILLING.md ("What the Stripe
// integration MUST NEVER gate") and VENUE-PRICING.md section 4 ask for: with
// VENUE_BILLING_ENABLED=true and a venue whose plan resolves to free, every
// route an owner uses without paying still answers, and none of the owner
// routes so much as asks what the venue pays. A change that meters the
// slider, or moves deals, events, the groups feed, reviews or the profile
// behind a plan, fails here by name.
//
//   the 0-100 slider        GET, POST, DELETE /api/venue-dashboard/busy-now
//   presence                GET, PUT /api/venue-profile
//   reviews and replies     GET /reviews, POST /reviews/:id/reply
//   groups that chose you   GET /incoming-flocks
//   deals                   GET, POST, PUT, DELETE /promotions, and the
//                           public read a user's venue card makes
//   events                  GET, POST, PUT, DELETE /events
//
// The plan lookup is scripted to answer 'free' and every read of it is
// counted. A route that grew a gate would read the plan and then refuse, so
// both the status and the count are asserted. GET /api/venue-profile is the
// one route here that reads the plan, to tell the owner what they hold, and it
// has to answer all the same.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'venue-never-gate-test-secret';
// So the billing switch does not warn about a missing admin on every read.
process.env.ADMIN_USER_IDS = '99';

const pool = require('../config/database');

const OWNER = { id: 1, name: 'Ava', role: 'venue_owner', email_verified: true };
const PLACE = 'PLACE_NEVER_GATE';

let handlers = [];
let log = [];
let planReads = 0;

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 160)}`));
}
pool.query = (sql, params) => dispatch(sql, params);
// POST /busy-now takes its rate limits and its insert under one advisory lock
// on a client of its own.
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

// The slider's read side and its training-context capture live in services the
// router holds as module objects, so they are replaced on the object.
const ownerReports = require('../services/ownerReports');
ownerReports.getLiveOwnerReports = async () => ({});
const ownerReportContext = require('../services/ownerReportContext');
ownerReportContext.captureOwnerReportContext = async () => {};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = OWNER; next(); };

const venueDashboardRouter = require('../routes/venueDashboard');
const venueProfileRouter = require('../routes/venueProfile');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/venue-dashboard', venueDashboardRouter);
app.use('/api/venue-profile', venueProfileRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

// A verified venue on the free plan, created after Roost had a price, so no
// notice window holds anything open for it.
const PROFILE_ROW = {
  id: 11,
  user_id: OWNER.id,
  business_name: 'The Owl',
  google_place_id: PLACE,
  verified: true,
  verification_requested_at: null,
  category: 'bar',
  tier: 'free',
  corpus_status: 'absent',
  corpus_baseline_rows: 0,
  corpus_checked_at: new Date().toISOString(),
  notification_prefs: {},
};
const PROMO = { id: 401, venue_user_id: OWNER.id, google_place_id: PLACE, title: 'Half price wings', description: null, time_slot: null, days: null, active: true, is_hidden: false, views: 0 };
const EVENT = { id: 601, venue_user_id: OWNER.id, google_place_id: PLACE, title: 'Trivia night', event_date: null, event_time: null, capacity: 50, is_hidden: false };

function world() {
  planReads = 0;
  return [
    // The plan: free, read and counted.
    [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => {
      planReads += 1;
      return { rows: [{ tier: 'free', grant_tier: null, grant_status: null, grant_source: null, granted_reason: null, granted_at: null, expires_at: null, roost_legacy: false, roost_notice_until: null }] };
    }],
    [/^SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles/, () => ({
      rows: [{ id: PROFILE_ROW.id, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null }],
    })],

    // The slider.
    [/AS strikes FROM venue_owner_reports/, () => ({ rows: [{ strikes: 0 }] })],
    [/^(BEGIN|COMMIT|ROLLBACK)$/, () => ({ rows: [] })],
    [/pg_advisory_xact_lock/, () => ({ rows: [] })],
    [/AS last_minute/, () => ({ rows: [{ last_minute: 0, last_day: 0 }] })],
    [/^INSERT INTO venue_owner_reports/, () => ({ rows: [{ id: 501 }], rowCount: 1 })],
    [/^UPDATE venue_owner_reports SET retracted = true/, () => ({ rows: [], rowCount: 1 })],

    // Reviews and the owner's reply.
    [/AS total/, () => ({ rows: [{ total: 1, average: 5, r1: 0, r2: 0, r3: 0, r4: 0, r5: 1 }] })],
    [/^SELECT vr\.id, vr\.rating, vr\.text, vr\.venue_reply/, () => ({
      rows: [{ id: 702, rating: 5, text: 'Great night', venue_reply: null, venue_replied_at: null, created_at: '2026-09-20T20:00:00.000Z', user_id: 9, name: 'Reviewer', reply_needs_review: false }],
    })],
    [/^UPDATE venue_reviews/, (p) => ({ rows: [{ id: 702, rating: 5, text: 'Great night', venue_reply: p[0], venue_replied_at: new Date().toISOString() }], rowCount: 1 })],

    // The groups that have this venue in their plans.
    [/FROM flocks f JOIN venue_votes vv/, () => ({ rows: [{ id: 31, event_time: new Date(Date.now() + 86400e3).toISOString(), status: 'confirmed', member_count: 4 }] })],
    [/WHERE vv\.venue_id IS NULL/, () => ({ rows: [{ n: 0 }] })],

    // Deals.
    [/^SELECT \* FROM venue_promotions/, () => ({ rows: [{ ...PROMO }] })],
    [/^INSERT INTO venue_promotions/, (p) => ({ rows: [{ ...PROMO, id: 402, title: p[2] }], rowCount: 1 })],
    [/^WITH target AS .*FROM venue_promotions/, (p) => ({ rows: [{ target_hidden: false, ...PROMO, title: p[0] || PROMO.title }] })],
    [/^DELETE FROM venue_promotions/, (p) => ({ rows: [{ id: Number(p[0]) }], rowCount: 1 })],
    [/FROM venue_promotions p/, () => ({ rows: [{ id: PROMO.id, title: PROMO.title, description: null, time_slot: null, days: null }] })],
    [/^UPDATE venue_promotions SET views/, () => ({ rows: [], rowCount: 1 })],

    // Events.
    [/^SELECT \* FROM venue_events/, () => ({ rows: [{ ...EVENT }] })],
    [/^INSERT INTO venue_events/, (p) => ({ rows: [{ ...EVENT, id: 602, title: p[2] }], rowCount: 1 })],
    [/^WITH target AS .*FROM venue_events/, (p) => ({ rows: [{ target_hidden: false, ...EVENT, title: p[0] || EVENT.title }] })],
    [/^DELETE FROM venue_events/, (p) => ({ rows: [{ id: Number(p[0]) }], rowCount: 1 })],

    // The venue profile, read and saved.
    [/^SELECT \* FROM venue_profiles WHERE user_id = \$1/, () => ({ rows: [{ ...PROFILE_ROW }] })],
    [/^UPDATE venue_profiles SET business_name = COALESCE/, (p) => ({ rows: [{ ...PROFILE_ROW, business_name: p[0] || PROFILE_ROW.business_name }], rowCount: 1 })],
  ];
}

test.beforeEach(() => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = world();
  log = [];
});
test.after(() => { delete process.env.VENUE_BILLING_ENABLED; });

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// Every owner route a free venue uses. None of them may read the plan.
const NEVER_GATED = [
  ['the live number, read', 'GET', '/api/venue-dashboard/busy-now', undefined, 200],
  ['the live number, set', 'POST', '/api/venue-dashboard/busy-now', { percent: 70 }, 201],
  ['the live number, taken back', 'DELETE', '/api/venue-dashboard/busy-now', undefined, 200],
  ['reviews', 'GET', '/api/venue-dashboard/reviews', undefined, 200],
  ['a reply to a review', 'POST', '/api/venue-dashboard/reviews/702/reply', { reply: 'Thanks for coming in' }, 200],
  ['the groups that chose the venue', 'GET', '/api/venue-dashboard/incoming-flocks', undefined, 200],
  ['the deals list', 'GET', '/api/venue-dashboard/promotions', undefined, 200],
  ['a new deal', 'POST', '/api/venue-dashboard/promotions', { title: 'Two for one before eight' }, 201],
  ['an edited deal', 'PUT', '/api/venue-dashboard/promotions/401', { title: 'Two for one before nine' }, 200],
  ['a deleted deal', 'DELETE', '/api/venue-dashboard/promotions/401', undefined, 200],
  ['the events list', 'GET', '/api/venue-dashboard/events', undefined, 200],
  ['a new event', 'POST', '/api/venue-dashboard/events', { title: 'Quiz night' }, 201],
  ['an edited event', 'PUT', '/api/venue-dashboard/events/601', { title: 'Quiz night, round two' }, 200],
  ['a deleted event', 'DELETE', '/api/venue-dashboard/events/601', undefined, 200],
  ['the profile, saved', 'PUT', '/api/venue-profile', { businessName: 'The Owl and Anchor' }, 200],
];

for (const [what, method, route, body, expected] of NEVER_GATED) {
  test(`free plan, billing on: ${what} (${method} ${route}) answers ${expected} and never asks the plan`, async () => {
    const res = await call(method, route, body);
    assert.strictEqual(res.status, expected, `${method} ${route} -> ${res.status} ${res.text}`);
    assert.notStrictEqual(res.body?.code, 'UPGRADE_REQUIRED', `${method} ${route} was sold as an upgrade`);
    assert.strictEqual(planReads, 0, `${method} ${route} read the venue's plan, so something on it is metered`);
  });
}

test('free plan, billing on: the profile read answers, and says the plan is free', async () => {
  // The one route on the list that reads the plan: to tell the owner what
  // they hold, never to refuse them.
  const res = await call('GET', '/api/venue-profile');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.tier, 'free');
  assert.strictEqual(res.body.billing_enabled, true);
  assert.strictEqual(planReads, 1);
});

test('free plan, billing on: a user opening the venue card is served its deal', async () => {
  const res = await call('GET', `/api/venue-dashboard/public-promotions/${PLACE}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.promotions.length, 1);
  // Nothing about the author's plan is part of the public read.
  const q = log.find((x) => /FROM venue_promotions p/.test(x.sql));
  assert.ok(!/venue_subscriptions|venue_roost_notices|vp\.tier/.test(q.sql), 'the public read consults a plan');
  assert.deepStrictEqual(q.params, [PLACE]);
  assert.strictEqual(planReads, 0);
});

test('the busy-now reading lands with billing on and a free plan', async () => {
  // Said separately from the table above because this is the one the product
  // most needs: the live number is the training label nobody else has, and
  // pricing it would throttle the input that makes the forecast better.
  const res = await call('POST', '/api/venue-dashboard/busy-now', { percent: 55 });
  assert.strictEqual(res.status, 201, res.text);
  const insert = log.find((x) => /^INSERT INTO venue_owner_reports/.test(x.sql));
  assert.ok(insert, 'the reading was never written');
  assert.deepStrictEqual(insert.params, [OWNER.id, PLACE, 55]);
});

// ---------------------------------------------------------------------------
// The same list, as source: no gate on any of these declarations, and the
// profile router imports no gate at all.
// ---------------------------------------------------------------------------

const DASH_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
const PROFILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueProfile.js'), 'utf8');

test('no never-gate route declaration on the dashboard router carries a plan gate', () => {
  const declared = [
    ['get', '/busy-now'], ['post', '/busy-now'], ['delete', '/busy-now'],
    ['get', '/reviews'], ['post', '/reviews/:id/reply'],
    ['get', '/incoming-flocks'],
    ['get', '/promotions'], ['post', '/promotions'], ['put', '/promotions/:id'], ['delete', '/promotions/:id'],
    ['get', '/events'], ['post', '/events'], ['put', '/events/:id'], ['delete', '/events/:id'],
    ['get', '/public-promotions/:placeId'],
  ];
  for (const [verb, route] of declared) {
    const re = new RegExp(`router\\.${verb}\\(\\s*'${route.replace(/[/:]/g, (c) => `\\${c}`)}'[^\\n]*`);
    const line = (DASH_SRC.match(re) || [])[0];
    assert.ok(line, `${verb.toUpperCase()} ${route} is no longer declared where this test looks`);
    assert.ok(!/requireVenueTier|requirePro|requirePremium/.test(line), `${verb.toUpperCase()} ${route} carries a plan gate: ${line}`);
  }
});

test('the profile router has no plan gate to mount', () => {
  const code = PROFILE_SRC.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/requireVenueTier|requirePro\b|requirePremium/.test(code), 'routes/venueProfile.js gates something on the plan');
});
