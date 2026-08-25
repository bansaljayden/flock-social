// Run: node --test  (from backend/)
//
// The owner's half of venue verification (2026-08-21).
//
// TestFlight found the product telling an unverified owner in three places to
// "verify your venue" while providing no way to do it: the admin console could
// flip `verified` (routes/admin.js, since migration 020) but nothing let an
// owner ASK, and the admin queue could not tell a waiting owner from a junk
// claim. POST /api/venue-profile/request-verification is the missing action;
// venue_profiles.verification_requested_at (migration 047) is the record.
//
// Pinned here:
//   1. Authz — email verification is required to ask (accumulating rule), and
//      the ask is refused for a claim with no place id, honoured idempotently
//      (first press wins, so queue position cannot be gamed), and answered
//      plainly when the venue is already verified or the place belongs to a
//      verified rival.
//   2. The admin side — the unverified queue orders requested claims first,
//      oldest request first, and the verify decision clears the request in
//      BOTH directions, in the same single statement as the flip.
//   3. The copy — the unverified reason is a function of the pending state, it
//      names the request path, and no string violates SLOP rule 1.
//   4. The resets — moving the claim to a different google_place_id clears the
//      pending request on both write paths, exactly as it clears `verified`.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'verification-request-test-secret';

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

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const venueProfileRouter = require('../routes/venueProfile');
const adminRouter = require('../routes/admin');
const copy = require('../utils/verificationCopy');

const app = express();
app.use(express.json());
app.use('/api/venue-profile', venueProfileRouter);
app.use('/api/admin', adminRouter);

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
});

async function call(method, path2, body) {
  const res = await fetch(base + path2, {
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

const PROFILE_SELECT = /SELECT id, google_place_id, verified, verification_requested_at FROM venue_profiles/;
const REQUEST_UPDATE = /SET verification_requested_at = COALESCE\(verification_requested_at, NOW\(\)\)/;
const NO_RIVAL = [/SELECT 1 FROM venue_profiles WHERE google_place_id/, () => ({ rows: [] })];
const PLACE = 'ChIJexample1234567890abc';

// ---------------------------------------------------------------------------
// 1. The owner's request
// ---------------------------------------------------------------------------

test('an unverified email cannot request verification (accumulating rule)', async () => {
  CURRENT_USER = { id: 1, name: 'Ava', role: 'venue_owner', email_verified: false };
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ran(/venue_profiles/).length, 0, 'nothing was read or written');
});

test('no profile answers 404', async () => {
  handlers = [[PROFILE_SELECT, () => ({ rows: [] })]];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 404);
});

test('a claim with no google place id is refused with the next step named', async () => {
  handlers = [[PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: null, verified: false, verification_requested_at: null }] })]];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /Link your Google listing/);
  assert.strictEqual(ran(REQUEST_UPDATE).length, 0, 'no request was written for a claim on nothing');
});

test('an already-verified venue is told so, without an error and without a write', async () => {
  handlers = [[PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: true, verification_requested_at: null }] })]];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.verification_status, 'verified');
  assert.strictEqual(ran(REQUEST_UPDATE).length, 0);
});

test('a place another account holds verified answers 409, not a queued request', async () => {
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: null }] })],
    [/SELECT 1 FROM venue_profiles WHERE google_place_id/, () => ({ rows: [{ 1: 1 }] })],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(ran(REQUEST_UPDATE).length, 0);
});

test('the happy path records the request and says what happens next', async () => {
  const stamp = '2026-08-21T18:00:00.000Z';
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: null }] })],
    NO_RIVAL,
    [REQUEST_UPDATE, (params) => {
      assert.deepStrictEqual(params, [1], 'keyed on the caller, nothing else');
      return { rows: [{ verification_requested_at: stamp }] };
    }],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.verification_status, 'pending');
  assert.strictEqual(res.body.verification_requested_at, stamp);
  assert.match(res.body.message, /confirm ownership by hand/);
});

test('a second press is idempotent: COALESCE keeps the first timestamp, and the copy says it is already in', async () => {
  const stamp = '2026-08-20T10:00:00.000Z';
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: stamp }] })],
    NO_RIVAL,
    [REQUEST_UPDATE, () => ({ rows: [{ verification_requested_at: stamp }] })],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.verification_requested_at, stamp);
  assert.match(res.body.message, /already in/);
  // The idempotency lives in the SQL, not in a read-then-branch: first press
  // wins whatever raced it.
  const upd = ran(REQUEST_UPDATE)[0];
  assert.ok(upd, 'the update ran');
  assert.match(upd.sql, /COALESCE\(verification_requested_at, NOW\(\)\)/);
});

// ---------------------------------------------------------------------------
// 2. The admin side
// ---------------------------------------------------------------------------

test('the unverified queue serves requested claims first, oldest request first', async () => {
  CURRENT_USER = { id: 99, name: 'Root', role: 'admin' };
  handlers = [[/FROM venue_profiles vp JOIN users u/, () => ({ rows: [] })]];
  const res = await call('GET', '/api/admin/venues/unverified');
  assert.strictEqual(res.status, 200);
  const q = ran(/FROM venue_profiles vp JOIN users u/)[0];
  assert.ok(q, 'the queue query ran');
  assert.match(q.sql, /vp\.verification_requested_at/, 'the queue carries the request timestamp');
  assert.match(
    q.sql,
    /ORDER BY \(vp\.verification_requested_at IS NOT NULL\) DESC, vp\.verification_requested_at ASC, vp\.created_at DESC/,
    'requested first, oldest request first, then the old newest-first tail'
  );
  assert.match(q.sql, /LIMIT 200/, 'the queue keeps its ceiling');
});

test('the admin decision clears the pending request in the same statement as the flip, in both directions', async () => {
  CURRENT_USER = { id: 99, name: 'Root', role: 'admin' };
  handlers = [[/UPDATE venue_profiles SET verified/, () => ({ rows: [{ id: 7, business_name: 'Bar', verified: true, google_place_id: PLACE, conflict_user_id: null }] })]];
  const res = await call('PUT', '/api/admin/venues/7/verify', {});
  assert.strictEqual(res.status, 200);
  const q = ran(/UPDATE venue_profiles SET verified/)[0];
  assert.ok(q, 'the verify statement ran');
  assert.match(q.sql, /verification_requested_at = NULL/, 'the decision clears the request');
  // One statement: the clear cannot land without the flip or vice versa.
  assert.strictEqual(ran(/UPDATE venue_profiles/).length, 1);
});

// ---------------------------------------------------------------------------
// 3. The copy
// ---------------------------------------------------------------------------

test('the unverified reason names the request path, and switches once the request is pending', () => {
  const before = copy.unverifiedReason({ verified: false, verification_requested_at: null });
  const after = copy.unverifiedReason({ verified: false, verification_requested_at: '2026-08-21T00:00:00Z' });
  assert.match(before, /Request verification/, 'the instruction carries its path');
  assert.match(after, /Verification requested/, 'a pending owner is not told to request again');
  assert.notStrictEqual(before, after);
  // A row that never selected the column reads as "not requested", the
  // direction that still offers a path.
  assert.strictEqual(copy.unverifiedReason({ verified: false }), before);
  assert.strictEqual(copy.unverifiedReason(null), before);
});

test('no copy string breaks SLOP rule 1 or promises a turnaround nobody enforces', () => {
  for (const s of copy.__copyStrings()) {
    assert.ok(!s.includes('—'), `em dash found in: ${s}`);
    assert.ok(!/seamless|effortless|unlock/i.test(s), `class word found in: ${s}`);
    assert.ok(!/within (a|an|\d|one|two|24|48)/i.test(s), `a turnaround promise found in: ${s}`);
  }
});

test('the route copy stays consistent with the module (grep, not trust)', () => {
  // The three dashboard surfaces and the Roost chat all read
  // utils/verificationCopy.js; the sentence that pointed at nothing must not
  // survive anywhere in the backend.
  const routes = ['advisor.js', 'venueDashboard.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8'));
  for (const src of routes) {
    // Comments may quote the old sentence as history; a STRING may not carry
    // it, because a string is one refactor away from being served again.
    assert.ok(!/['"`][^'"`\n]*Verify your venue to unlock this/.test(src),
      'the dead-end sentence survives as a string literal');
    assert.ok(src.includes("require('../utils/verificationCopy')"), 'the route reads the shared copy module');
  }
});

// ---------------------------------------------------------------------------
// 4. The resets
// ---------------------------------------------------------------------------

test('re-claiming a different place clears the pending request on the PUT path, same trigger as verified', async () => {
  handlers = [
    NO_RIVAL,
    [/UPDATE venue_profiles SET/, () => ({ rows: [{ id: 7, user_id: 1, business_name: 'Bar', google_place_id: PLACE, verified: false, verification_requested_at: null, corpus_checked_at: new Date().toISOString() }] })],
  ];
  const res = await call('PUT', '/api/venue-profile', { googlePlaceId: PLACE });
  assert.strictEqual(res.status, 200);
  const upd = ran(/UPDATE venue_profiles SET/)[0];
  assert.match(upd.sql, /verification_requested_at = CASE WHEN \$9 IS NOT NULL AND \$9 IS DISTINCT FROM google_place_id THEN NULL ELSE verification_requested_at END/);
});

test('re-claiming a different place clears the pending request on the POST upsert too', async () => {
  handlers = [
    NO_RIVAL,
    [/INSERT INTO venue_profiles/, () => ({ rows: [{ id: 7, user_id: 1, business_name: 'Bar', google_place_id: PLACE, verified: false, verification_requested_at: null, corpus_checked_at: new Date().toISOString() }] })],
    [/UPDATE users SET role/, () => ({ rows: [], rowCount: 1 })],
  ];
  const res = await call('POST', '/api/venue-profile', { businessName: 'Bar', googlePlaceId: PLACE });
  assert.strictEqual(res.status, 201);
  const ins = ran(/INSERT INTO venue_profiles/)[0];
  assert.match(ins.sql, /verification_requested_at = CASE WHEN EXCLUDED\.google_place_id IS NOT NULL AND EXCLUDED\.google_place_id IS DISTINCT FROM venue_profiles\.google_place_id THEN NULL ELSE venue_profiles\.verification_requested_at END/);
});

test('profileView derives one word the dashboard can branch on', async () => {
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [] })],
    [/SELECT \* FROM venue_profiles WHERE user_id/, () => ({ rows: [{ id: 7, user_id: 1, business_name: 'Bar', verified: false, verification_requested_at: '2026-08-21T00:00:00Z', corpus_checked_at: new Date().toISOString() }] })],
    [/FROM venue_profiles vp LEFT JOIN venue_subscriptions/, () => ({ rows: [{ tier: 'free' }] })],
  ];
  const res = await call('GET', '/api/venue-profile');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.verification_status, 'pending');
});
