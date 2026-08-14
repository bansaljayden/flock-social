// Run: node --test  (from backend/)
//
// Reliability round for the route files the earlier pass did not deeply cover:
// admin.js and venueDashboard.js. Two failure classes are pinned here, both of
// which turn a 400/404 into a 500 once a real (non-numeric) id reaches Postgres:
//
//   1. admin.js — PUT /api/admin/venues/:profileId/verify and
//      POST /api/admin/venues/:userId/tier called parseInt() on the path param
//      with NO validation. A non-digit id became NaN, which node-postgres sends
//      to an integer column as 'NaN' → "invalid input syntax for type integer"
//      → 500. In the moderation surface a 500 is indistinguishable from "the
//      action failed", the one thing an admin must never be unsure about.
//   2. venueDashboard.js — DELETE /promotions/:id and DELETE /events/:id
//      DECLARED `param('id').isInt()` but never read validationResult, so the
//      validator did nothing and a string id reached Postgres as a 500 (the
//      exact bug moderation.js/blocks documented and the sibling PUT routes
//      already guard).
//
// No database: pool.query is a fixture dispatcher. The mutation queries throw a
// Postgres 22P02 the way the real column would, so a passing test proves the
// guard returned BEFORE the query ran (404), not merely that the harness
// tolerated a bad value.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'routes-reliability-test-secret';
delete process.env.VENUE_BILLING_ENABLED; // requirePremium stays a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ADMIN = { id: 1, email: 'admin@example.com', name: 'Admin', role: 'admin', email_verified: true, is_banned: false, token_version: 0 };
const OWNER = { id: 2, email: 'owner@example.com', name: 'Owner', role: 'venue_owner', email_verified: true, is_banned: false, token_version: 0 };
const USERS = { 1: ADMIN, 2: OWNER };

let issued;   // every query the route actually issued (post-auth)
let mutationRows; // rowCount the mutation should report on the happy path

const realQuery = pool.query;
const realConnect = pool.connect;

function invalidIntError() {
  const e = new Error('invalid input syntax for type integer: "NaN"');
  e.code = '22P02';
  return e;
}

pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const has = (f) => sql.includes(f);

  // middleware/auth.js user lookup — never counted as a route query.
  if (has('FROM users WHERE id = $1') && has('token_version')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  issued.push({ sql, params });

  // getVenueCtx (unused by the routes under test, modelled for completeness).
  if (has('FROM venue_profiles WHERE user_id = $1') && has('google_place_id, verified')) {
    return { rows: [{ id: 9, google_place_id: 'ChIJtest', verified: true }], rowCount: 1 };
  }

  // The mutations. If the param guards work, a bad id never reaches here; a good
  // id does and gets the modelled result. A bad id that DID reach here would
  // throw 22P02 → 500, which is exactly the regression we are pinning.
  if (has('UPDATE venue_profiles SET verified')) {
    if (!Number.isInteger(params[1])) throw invalidIntError();
    return { rows: mutationRows ? [{ id: params[1], business_name: 'V', verified: params[0] }] : [], rowCount: mutationRows };
  }
  if (has('UPDATE venue_profiles SET tier')) {
    if (!Number.isInteger(params[1])) throw invalidIntError();
    return { rows: mutationRows ? [{ id: 9, business_name: 'V', tier: params[0] }] : [], rowCount: mutationRows };
  }
  if (has('DELETE FROM venue_promotions')) {
    if (!/^\d+$/.test(String(params[0]))) throw invalidIntError();
    return { rows: [], rowCount: mutationRows };
  }
  if (has('DELETE FROM venue_events')) {
    if (!/^\d+$/.test(String(params[0]))) throw invalidIntError();
    return { rows: [], rowCount: mutationRows };
  }

  throw new Error(`Unmodelled query: ${sql}`);
};

test.after(() => { pool.query = realQuery; pool.connect = realConnect; });

// ── Test server ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/admin', require('../routes/admin'));
app.use('/api/venue-dashboard', require('../routes/venueDashboard'));
const server = http.createServer(app);
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => new Promise((r) => server.close(r)));

const ADMIN_TOKEN = () => signUserToken(ADMIN);
const OWNER_TOKEN = () => signUserToken(OWNER);

async function req(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

function targetQueryIssued(frag) {
  return issued.some((q) => q.sql.includes(frag));
}

test.beforeEach(() => { issued = []; mutationRows = 1; });

// ── admin: verify ─────────────────────────────────────────────────────────────
test('PUT /admin/venues/:profileId/verify — non-numeric id is 404, never reaches the UPDATE', async () => {
  const { status } = await req('PUT', '/api/admin/venues/abc/verify', ADMIN_TOKEN(), { verified: true });
  assert.strictEqual(status, 404);
  assert.ok(!targetQueryIssued('UPDATE venue_profiles SET verified'), 'UPDATE must not run for a bad id');
});

test('PUT /admin/venues/:profileId/verify — numeric id still works (no over-blocking)', async () => {
  const { status, json } = await req('PUT', '/api/admin/venues/42/verify', ADMIN_TOKEN(), { verified: true });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.verified, true);
  assert.ok(targetQueryIssued('UPDATE venue_profiles SET verified'));
});

test('PUT /admin/venues/:profileId/verify — numeric id that matches nothing is 404', async () => {
  mutationRows = 0;
  const { status } = await req('PUT', '/api/admin/venues/999/verify', ADMIN_TOKEN(), { verified: true });
  assert.strictEqual(status, 404);
});

// ── admin: tier ───────────────────────────────────────────────────────────────
test('POST /admin/venues/:userId/tier — non-numeric id is 404, never reaches the UPDATE', async () => {
  const { status } = await req('POST', '/api/admin/venues/abc/tier', ADMIN_TOKEN(), { tier: 'pro' });
  assert.strictEqual(status, 404);
  assert.ok(!targetQueryIssued('UPDATE venue_profiles SET tier'), 'UPDATE must not run for a bad id');
});

test('POST /admin/venues/:userId/tier — invalid tier is still 400 (validation order unchanged)', async () => {
  const { status } = await req('POST', '/api/admin/venues/abc/tier', ADMIN_TOKEN(), { tier: 'platinum' });
  assert.strictEqual(status, 400);
});

test('POST /admin/venues/:userId/tier — numeric id still works', async () => {
  const { status, json } = await req('POST', '/api/admin/venues/2/tier', ADMIN_TOKEN(), { tier: 'premium' });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.tier, 'premium');
});

// ── venue dashboard: DELETE promotions/events ──────────────────────────────────
test('DELETE /venue-dashboard/promotions/:id — non-numeric id is 404, never reaches the DELETE', async () => {
  const { status } = await req('DELETE', '/api/venue-dashboard/promotions/abc', OWNER_TOKEN());
  assert.strictEqual(status, 404);
  assert.ok(!targetQueryIssued('DELETE FROM venue_promotions'), 'DELETE must not run for a bad id');
});

test('DELETE /venue-dashboard/promotions/:id — numeric id still deletes', async () => {
  const { status } = await req('DELETE', '/api/venue-dashboard/promotions/5', OWNER_TOKEN());
  assert.strictEqual(status, 200);
  assert.ok(targetQueryIssued('DELETE FROM venue_promotions'));
});

test('DELETE /venue-dashboard/events/:id — non-numeric id is 404, never reaches the DELETE', async () => {
  const { status } = await req('DELETE', '/api/venue-dashboard/events/xyz', OWNER_TOKEN());
  assert.strictEqual(status, 404);
  assert.ok(!targetQueryIssued('DELETE FROM venue_events'), 'DELETE must not run for a bad id');
});

test('DELETE /venue-dashboard/events/:id — numeric id that matches nothing is 404', async () => {
  mutationRows = 0;
  const { status } = await req('DELETE', '/api/venue-dashboard/events/7', OWNER_TOKEN());
  assert.strictEqual(status, 404);
  assert.ok(targetQueryIssued('DELETE FROM venue_events'));
});
