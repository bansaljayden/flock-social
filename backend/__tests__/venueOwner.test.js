// Run: node --test  (from backend/)
//
// Venue-owner audit (2026-08-14). The venue side is the B2B revenue path, so a
// tier a venue can grant itself is the product given away, and a claim on a
// business you do not own is a stranger speaking as that business.
//
// Everything here drives the real Express routers against a scripted pg fake,
// so the assertions are about what the route actually sends and writes.
//
// Covers:
//   1. Tier — never accepted from the client on either venue-profile route,
//      never written outside routes/admin.js, and fail-closed in the gate.
//   2. Claim — a place id another account has already had VERIFIED is a 409,
//      not a silent duplicate claim; `verified` is never client-settable.
//   3. Input bounds — the PUT's validators are actually read (they were dead
//      code), and every JSON/array column the owner writes is bounded.
//   4. Votes — the flock tally counts accepted members only, and a flock id
//      outside INTEGER range is a 400 rather than a Postgres 500.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-owner-test-secret';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).slice(0, 140)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: sql.trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const venueProfileRouter = require('../routes/venueProfile');
const venuesRouter = require('../routes/venues');
const { requireVenueTier, getVenueTier } = require('../services/venueEntitlements');

const app = express();
app.use(express.json());
app.use('/api/venue-profile', venueProfileRouter);
app.use('/api/flocks', venuesRouter);
// Gate mounted the way venueDashboard.js mounts it (after authenticate).
app.get('/gated', (req, _res, next) => { req.user = CURRENT_USER; next(); }, requireVenueTier('premium'), (_req, res) => res.json({ ok: true }));
// ...and once WITHOUT any authenticate in front of it, to prove the gate does
// not read `undefined.id` and fall through.
app.get('/gated-anon', requireVenueTier('premium'), (_req, res) => res.json({ ok: true }));
// A bottom-tier gate, which is where a null rank would slip through.
app.get('/gated-free', (req, _res, next) => { req.user = CURRENT_USER; next(); }, requireVenueTier('free'), (_req, res) => res.json({ ok: true }));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner' };
  delete process.env.VENUE_BILLING_ENABLED;
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const noClaimConflict = [/SELECT 1 FROM venue_profiles WHERE google_place_id/, () => ({ rows: [] })];
const roleUpdate = [/UPDATE users SET role/, () => ({ rows: [], rowCount: 1 })];
const profileRow = { id: 7, user_id: 1, business_name: 'Bar', tier: 'free', verified: false };

// ---------------------------------------------------------------------------
// 1. Tier is never client-writable
// ---------------------------------------------------------------------------

test('POST /venue-profile ignores a client-supplied tier', async () => {
  handlers = [
    noClaimConflict,
    roleUpdate,
    [/INSERT INTO venue_profiles/, () => ({ rows: [profileRow] })],
  ];
  const res = await call('POST', '/api/venue-profile', { businessName: 'Bar', tier: 'pro' });
  assert.strictEqual(res.status, 201);
  const insert = ran(/INSERT INTO venue_profiles/)[0];
  assert.ok(insert, 'the insert ran');
  assert.ok(!/\btier\b/.test(insert.sql), 'the insert names a tier column');
  assert.ok(!insert.params.includes('pro'), 'the client tier reached the query parameters');
});

test('PUT /venue-profile ignores a client-supplied tier', async () => {
  handlers = [noClaimConflict, [/UPDATE venue_profiles SET/, () => ({ rows: [profileRow] })]];
  const res = await call('PUT', '/api/venue-profile', { businessName: 'Bar', tier: 'pro' });
  assert.strictEqual(res.status, 200);
  const update = ran(/UPDATE venue_profiles SET/)[0];
  assert.ok(!/\btier\s*=/.test(update.sql), 'the update writes a tier column');
  assert.ok(!update.params.includes('pro'), 'the client tier reached the query parameters');
});

test('the venue-profile routes are not a writer of tier at all', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/venueProfile'), 'utf8');
  // Comments may mention it; SQL must not assign it.
  assert.ok(!/tier\s*=\s*\$/.test(src), 'venueProfile.js assigns tier in SQL');
  assert.ok(!/\btier\b/.test(src.replace(/\/\/.*$/gm, '').replace(/--.*$/gm, '')), 'venueProfile.js references tier outside comments');
});

test('requireVenueTier is a no-op while the kill switch is off', async () => {
  const res = await call('GET', '/gated');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ran(/SELECT tier FROM venue_profiles/).length, 0, 'it queried a tier with billing disabled');
});

test('requireVenueTier enforces the stored tier once billing is on', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [[/SELECT tier FROM venue_profiles/, () => ({ rows: [{ tier: 'free' }] })]];
  let res = await call('GET', '/gated');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'UPGRADE_REQUIRED');

  handlers = [[/SELECT tier FROM venue_profiles/, () => ({ rows: [{ tier: 'premium' }] })]];
  res = await call('GET', '/gated');
  assert.strictEqual(res.status, 200);
});

test('a tier naming an Object.prototype member is treated as free, not as a rank', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  for (const poisoned of ['constructor', 'toString', '__proto__', 'valueOf']) {
    handlers = [[/SELECT tier FROM venue_profiles/, () => ({ rows: [{ tier: poisoned }] })]];
    const res = await call('GET', '/gated');
    assert.strictEqual(res.status, 403, `${poisoned} passed the gate`);
    assert.strictEqual(await getVenueTier(1), 'free', `${poisoned} survived getVenueTier`);
  }
});

test('a database failure on the paid boundary fails closed', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [[/SELECT tier FROM venue_profiles/, () => { throw new Error('db down'); }]];
  const res = await call('GET', '/gated');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'UPGRADE_REQUIRED');
});

test('an unauthenticated request never reaches a paid feature', async () => {
  process.env.VENUE_BILLING_ENABLED = 'true';
  const res = await call('GET', '/gated-anon');
  assert.strictEqual(res.status, 401);
});

test('an unrecognised tier does not walk through a free-minimum gate', async () => {
  // `null >= 0` is true in JavaScript, so a rank of "unknown" would have
  // satisfied any gate whose minimum is the bottom tier.
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [[/SELECT tier FROM venue_profiles/, () => ({ rows: [{ tier: 'constructor' }] })]];
  const res = await call('GET', '/gated-free');
  assert.strictEqual(res.status, 200, 'getVenueTier should have normalised this to free');
  assert.strictEqual(await getVenueTier(1), 'free');
});

test('a venue with no profile row at all is free, not undefined', async () => {
  handlers = [[/SELECT tier FROM venue_profiles/, () => ({ rows: [] })]];
  assert.strictEqual(await getVenueTier(1), 'free');
  process.env.VENUE_BILLING_ENABLED = 'true';
  handlers = [[/SELECT tier FROM venue_profiles/, () => ({ rows: [] })]];
  const res = await call('GET', '/gated');
  assert.strictEqual(res.status, 403);
});

test('requireVenueTier refuses to build a gate for an unknown tier name', () => {
  assert.throws(() => requireVenueTier('platinum'), /unknown tier/);
  assert.throws(() => requireVenueTier(undefined), /unknown tier/);
});

// ---------------------------------------------------------------------------
// 2. Claim integrity
// ---------------------------------------------------------------------------

test('claiming a place another account has already had verified is a 409', async () => {
  handlers = [
    [/SELECT 1 FROM venue_profiles WHERE google_place_id/, () => ({ rows: [{ '?column?': 1 }] })],
  ];
  const res = await call('POST', '/api/venue-profile', { businessName: 'Not My Bar', googlePlaceId: 'place_taken' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(ran(/INSERT INTO venue_profiles/).length, 0, 'the duplicate claim was written anyway');
  assert.strictEqual(ran(/UPDATE users SET role/).length, 0, 'a rejected claim still promoted the caller');
});

test('re-pointing an existing profile at a verified place is a 409 too', async () => {
  handlers = [
    [/SELECT 1 FROM venue_profiles WHERE google_place_id/, () => ({ rows: [{ '?column?': 1 }] })],
  ];
  const res = await call('PUT', '/api/venue-profile', { googlePlaceId: 'place_taken' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(ran(/UPDATE venue_profiles SET/).length, 0);
});

test('the claim check excludes the caller, so re-saving your own place still works', async () => {
  handlers = [noClaimConflict, [/UPDATE venue_profiles SET/, () => ({ rows: [profileRow] })]];
  const res = await call('PUT', '/api/venue-profile', { googlePlaceId: 'place_mine' });
  assert.strictEqual(res.status, 200);
  const check = ran(/SELECT 1 FROM venue_profiles WHERE google_place_id/)[0];
  assert.ok(/verified = true/.test(check.sql), 'the check ignores verification state');
  assert.ok(/user_id <> \$2/.test(check.sql), 'the check does not exclude the caller');
  assert.deepStrictEqual(check.params, ['place_mine', 1]);
});

test('losing the unique-index race answers 409, not 500', async () => {
  const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
  handlers = [noClaimConflict, [/UPDATE venue_profiles SET/, () => { throw dup; }]];
  let res = await call('PUT', '/api/venue-profile', { googlePlaceId: 'place_x' });
  assert.strictEqual(res.status, 409);

  handlers = [noClaimConflict, roleUpdate, [/INSERT INTO venue_profiles/, () => { throw dup; }]];
  res = await call('POST', '/api/venue-profile', { businessName: 'Bar', googlePlaceId: 'place_x' });
  assert.strictEqual(res.status, 409);
});

test('verified is never settable by the client on either route', async () => {
  handlers = [noClaimConflict, [/UPDATE venue_profiles SET/, () => ({ rows: [profileRow] })]];
  const res = await call('PUT', '/api/venue-profile', { businessName: 'Bar', verified: true });
  assert.strictEqual(res.status, 200);
  const update = ran(/UPDATE venue_profiles SET/)[0];
  // The only assignment is the server's own CASE that RESETS it on a re-claim.
  assert.ok(!/verified\s*=\s*\$/.test(update.sql), 'verified is bound to a client parameter');
  assert.ok(/verified = CASE WHEN/.test(update.sql), 'the place-change reset is gone');
  assert.ok(!update.params.includes(true), 'a client boolean reached the parameters');
});

test('changing the place id resets verification on the create path as well', async () => {
  handlers = [noClaimConflict, roleUpdate, [/INSERT INTO venue_profiles/, () => ({ rows: [profileRow] })]];
  // 'place_p2', not 'p2': the write path now requires a shaped place id, and the
  // sibling tests above already use 'place_x'. Assert the status first so a
  // rejected body fails here rather than as an undefined read on the next line.
  const res = await call('POST', '/api/venue-profile', { businessName: 'Bar', googlePlaceId: 'place_p2' });
  assert.strictEqual(res.status, 201, 'the create body was rejected before the insert ran');
  const insert = ran(/INSERT INTO venue_profiles/)[0];
  assert.ok(/verified = CASE WHEN EXCLUDED\.google_place_id IS NOT NULL/.test(insert.sql));
});

test('venue onboarding never demotes an admin', async () => {
  CURRENT_USER = { id: 1, name: 'Root', role: 'admin' };
  handlers = [noClaimConflict, roleUpdate, [/INSERT INTO venue_profiles/, () => ({ rows: [profileRow] })]];
  await call('POST', '/api/venue-profile', { businessName: 'Bar' });
  const roleQ = ran(/UPDATE users SET role/)[0];
  assert.ok(/role NOT IN \('admin', 'venue_owner'\)/.test(roleQ.sql), 'the role write is unguarded');
});

// ---------------------------------------------------------------------------
// 3. Bounded, validated writes
// ---------------------------------------------------------------------------

test('PUT /venue-profile actually reads its validators', async () => {
  // Before this audit the handler never called validationResult, so every
  // validator on the route was decoration. `goals` is a TEXT[] column: a
  // string here used to be a Postgres error surfaced as a 500.
  handlers = [];
  const res = await call('PUT', '/api/venue-profile', { goals: 'free drinks' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(ran(/UPDATE venue_profiles SET/).length, 0, 'the bad value reached the database');
});

test('over-long text is a 400 on both routes, not a Postgres 22001', async () => {
  const long = 'x'.repeat(300);
  handlers = [];
  let res = await call('PUT', '/api/venue-profile', { businessName: long });
  assert.strictEqual(res.status, 400);
  res = await call('PUT', '/api/venue-profile', { googlePlaceId: long });
  assert.strictEqual(res.status, 400);
  res = await call('POST', '/api/venue-profile', { businessName: long });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(log.length, 0, 'an over-long value reached the database');
});

test('goals, operating hours and notification prefs are all bounded', async () => {
  handlers = [];
  const cases = [
    { goals: Array.from({ length: 50 }, () => 'g') },
    { goals: [{ nested: 'object' }] },
    { goals: ['x'.repeat(200)] },
    { operatingHours: 'always open' },
    { operatingHours: Array.from({ length: 40 }, () => ({ days: 'Mon', open: '9', close: '5' })) },
    { operatingHours: [{ days: 'Mon', open: '9', close: '5', payload: 'x'.repeat(100) }] },
    { operatingHours: [{ days: 'x'.repeat(200), open: '9', close: '5' }] },
    { notificationPrefs: 'yes please' },
    { notificationPrefs: ['bookings'] },
    { photoUrl: 'javascript:alert(1)' },
    { photoUrl: '//evil.example.com/logo.png' },
    { photoUrl: `data:image/png;base64,${'A'.repeat(50)}` },
    // Image-trust audit: /uploads/ died with the disk store (routes/users.js
    // round 12) and an arbitrary https host was never something this app
    // minted. Only our own photo proxy path is vouched for now.
    { photoUrl: 'https://evil.example.com/logo.png' },
    { photoUrl: '/uploads/logo.png' },
  ];
  for (const body of cases) {
    const res = await call('PUT', '/api/venue-profile', body);
    assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(body).slice(0, 60)}`);
  }
  assert.strictEqual(log.length, 0, 'a rejected body still hit the database');
});

test('notification prefs are stored as the three known booleans and nothing else', async () => {
  handlers = [noClaimConflict, [/UPDATE venue_profiles SET/, () => ({ rows: [profileRow] })]];
  const res = await call('PUT', '/api/venue-profile', {
    notificationPrefs: { bookings: true, weekly: false, junk: 'x'.repeat(5000), reviews: true },
  });
  assert.strictEqual(res.status, 200);
  const update = ran(/UPDATE venue_profiles SET/)[0];
  const stored = JSON.parse(update.params.find((p) => typeof p === 'string' && p.startsWith('{')));
  assert.deepStrictEqual(stored, { bookings: true, reviews: true, weekly: false });
});

test('a legitimate profile save still goes through untouched', async () => {
  handlers = [noClaimConflict, [/UPDATE venue_profiles SET/, () => ({ rows: [profileRow] })]];
  const res = await call('PUT', '/api/venue-profile', {
    businessName: "Joe's Bar",
    category: 'Bar',
    location: 'Denver, CO',
    description: 'A bar.',
    goals: ['more weeknights'],
    phone: '555-0100',
    operatingHours: [{ days: 'Mon-Fri', open: '17:00', close: '02:00' }],
    notificationPrefs: { bookings: true, reviews: true, weekly: false },
    photoUrl: '/api/venues/photo?ref=logo123&maxwidth=400',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(ran(/UPDATE venue_profiles SET/).length, 1);
});

// ---------------------------------------------------------------------------
// 4. Vote tallies
// ---------------------------------------------------------------------------

const isMember = () => ({ rows: [{ id: 9 }] });

test('the vote tally counts accepted members only', async () => {
  // Leaving a flock deletes the flock_members row and nothing else, so without
  // this join a departed member keeps a permanent vote in a tally they can no
  // longer retract.
  handlers = [
    [/SELECT id FROM flock_members/, isMember],
    [/FROM user_blocks WHERE blocker_id/, () => ({ rows: [] })],
    [/FROM venue_votes vv/, () => ({ rows: [] })],
    [/FROM guest_votes gv/, () => ({ rows: [] })],
    [/SELECT user_id FROM flock_members/, () => ({ rows: [] })],
  ];
  const res = await call('GET', '/api/flocks/5/votes');
  assert.strictEqual(res.status, 200);
  const tally = ran(/FROM venue_votes vv/)[0];
  assert.ok(/JOIN flock_members fm/.test(tally.sql), 'the tally does not join membership');
  assert.ok(/fm\.status = 'accepted'/.test(tally.sql), 'the tally counts non-accepted rows');
});

test('a flock id outside INTEGER range is a 400, never a query', async () => {
  handlers = [];
  for (const path of ['/api/flocks/99999999999/votes', '/api/flocks/0/votes', '/api/flocks/abc/votes']) {
    const res = await call('GET', path);
    assert.strictEqual(res.status, 400, `${path} was not rejected`);
  }
  const del = await call('DELETE', '/api/flocks/99999999999/vote');
  assert.strictEqual(del.status, 400);
  const post = await call('POST', '/api/flocks/99999999999/vote', { venue_name: 'Bar' });
  assert.strictEqual(post.status, 400);
  assert.strictEqual(log.length, 0, 'an out-of-range id reached the database');
});

test('a non-member cannot read, cast or withdraw a vote', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/flocks/5/votes', undefined],
    ['POST', '/api/flocks/5/vote', { venue_name: 'Bar' }],
    ['DELETE', '/api/flocks/5/vote', undefined],
  ]) {
    handlers = [[/SELECT id FROM flock_members/, () => ({ rows: [] })]];
    log = [];
    const res = await call(method, path, body);
    assert.strictEqual(res.status, 403, `${method} ${path}`);
    assert.strictEqual(ran(/venue_votes/).length, 0, `${method} ${path} touched venue_votes`);
  }
});
