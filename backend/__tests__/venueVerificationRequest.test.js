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

// The request route mails an operator. Every test in this file stubs the send:
// the point under test is which claims produce a notification and what it
// carries, never Resend. Without the stub the real sender would reach for the
// suppression table through the scripted pool above and log its way out of it,
// which is noise in a file about authorization.
const emailService = require('../services/emailService');
const realSendEmail = emailService.sendEmail;

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
  emailService.sendEmail = async () => ({ sent: true, id: 'stubbed' });
});

test.after(() => { emailService.sendEmail = realSendEmail; });

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

// The route reads business_name, location and the owner's address off the same
// row it already needed, for the operator notification at the end of the
// handler. Matched on the columns the handler branches on rather than on the
// whole statement, so adding a column to the notification does not fail a test
// about authorization.
const PROFILE_SELECT = /SELECT p\.id, p\.google_place_id, p\.verified, p\.verification_requested_at/;
const REQUEST_UPDATE = /UPDATE venue_profiles\s+SET verification_requested_at = NOW\(\)/;
// The re-read the route falls back to when the UPDATE matched nothing, which
// is how it tells a request that was already in apart from a profile that has
// gone, now that the write itself is the idempotence guard.
const REQUEST_REREAD = /SELECT verification_requested_at FROM venue_profiles WHERE user_id = \$1/;
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
  // Names the step that exists: nothing on the venue side writes the listing
  // id, and "Edit Profile" is a consumer screen (venue-owner audit 2026-09-05).
  assert.match(res.body.error, /No Google listing is linked to this venue yet/);
  assert.ok(!/Edit Profile/.test(res.body.error));
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

test('a second press is idempotent: the first timestamp stands, and the copy says it is already in', async () => {
  const stamp = '2026-08-20T10:00:00.000Z';
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: stamp }] })],
    NO_RIVAL,
    // The row already carries a request, so the guarded UPDATE matches nothing.
    [REQUEST_UPDATE, () => ({ rows: [], rowCount: 0 })],
    [REQUEST_REREAD, () => ({ rows: [{ verification_requested_at: stamp }] })],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.verification_requested_at, stamp, 'the original moment, not a fresh one');
  assert.match(res.body.message, /already in/);
  // The idempotency lives in the SQL, not in a read-then-branch: first press
  // wins whatever raced it. That is the WHERE clause, and it is now the same
  // statement that decides whether an operator is mailed.
  const upd = ran(REQUEST_UPDATE)[0];
  assert.ok(upd, 'the update ran');
  assert.match(upd.sql, /WHERE user_id = \$1 AND verification_requested_at IS NULL/);
});

test('a profile that disappears between the read and the write answers 404, not a null timestamp', async () => {
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: null }] })],
    NO_RIVAL,
    [REQUEST_UPDATE, () => ({ rows: [], rowCount: 0 })],
    [REQUEST_REREAD, () => ({ rows: [], rowCount: 0 })],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 404);
});

// ---------------------------------------------------------------------------
// 1b. The request has to reach a person
//
// The owner is answered "we confirm ownership by hand". That promise was, until
// this leg existed, entirely a timestamp in a column: the admin queue route is
// real but nothing in the frontend calls it, so nobody was told a venue was
// waiting. Pinned here: the first press mails an operator with enough to decide
// the claim, a re-press mails nobody, and a send that fails changes nothing the
// owner sees.
// ---------------------------------------------------------------------------

// The notification is fire and forget, deliberately: it runs after res.json so
// it can never decide whether the owner's request succeeded. So the assertion
// waits on the stub rather than on the HTTP response.
function captureSend() {
  const calls = [];
  let resolveFirst;
  const first = new Promise((r) => { resolveFirst = r; });
  emailService.sendEmail = async (payload) => {
    calls.push(payload);
    resolveFirst(payload);
    return { sent: true, id: 'test-message-id' };
  };
  return { calls, first };
}

test('the first request mails an operator with what it takes to decide the claim', async () => {
  const sent = captureSend();
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: null, business_name: 'The Blue Heron', location: '12 Dock St', owner_email: 'ava@example.com' }] })],
    NO_RIVAL,
    [REQUEST_UPDATE, () => ({ rows: [{ verification_requested_at: '2026-08-21T18:00:00.000Z' }] })],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 200);

  const mail = await sent.first;
  assert.match(mail.subject, /The Blue Heron/);
  // Everything a person needs to check the claim without opening a database.
  for (const fact of [PLACE, 'ava@example.com', '12 Dock St']) {
    assert.ok(mail.text.includes(fact), `the mail body names ${fact}`);
  }
  // And where to act on it. The admin routes exist; no screen calls them.
  assert.match(mail.text, /PUT \/api\/admin\/venues\/7\/verify/);
  assert.strictEqual(sent.calls.length, 1, 'one claim is one notification');
});

test('a re-press mails nobody, so an anxious owner cannot page us twice', async () => {
  const sent = captureSend();
  const stamp = '2026-08-20T10:00:00.000Z';
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: stamp, business_name: 'The Blue Heron', owner_email: 'ava@example.com' }] })],
    NO_RIVAL,
    [REQUEST_UPDATE, () => ({ rows: [], rowCount: 0 })],
    [REQUEST_REREAD, () => ({ rows: [{ verification_requested_at: stamp }] })],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.calls.length, 0);
});

// THE RACE THE READ-THEN-BRANCH LOST.
//
// "First press only" was `!!profile.verification_requested_at`, read off the
// SELECT at the top of the handler. Two presses that arrive together, an owner
// on a phone and the same owner on a laptop, BOTH see NULL there: neither has
// written yet. Both then counted themselves the first press and both mailed the
// operator, so one claim arrived twice while the column recorded a single
// request. The timestamp was never at risk, because COALESCE settled that in
// SQL. The notification was, because it branched on the read instead.
//
// Modelled the way Postgres actually resolves it: both statements are issued,
// the second blocks on the row lock, and when it is released it re-evaluates
// `verification_requested_at IS NULL` against the row the first one wrote and
// matches nothing. So exactly one UPDATE returns a row, and the mail follows
// the row rather than the read.
test('two presses that race each other still reach the operator once', async () => {
  const sent = captureSend();
  const stamp = '2026-08-21T18:00:00.000Z';
  let writesThatMatched = 0;
  handlers = [
    // Both requests read the profile before either has written to it.
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: null, business_name: 'The Blue Heron', location: '12 Dock St', owner_email: 'ava@example.com' }] })],
    NO_RIVAL,
    [REQUEST_UPDATE, () => {
      writesThatMatched += 1;
      return writesThatMatched === 1
        ? { rows: [{ verification_requested_at: stamp }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }],
    [REQUEST_REREAD, () => ({ rows: [{ verification_requested_at: stamp }] })],
  ];

  const [a, b] = await Promise.all([
    call('POST', '/api/venue-profile/request-verification'),
    call('POST', '/api/venue-profile/request-verification'),
  ]);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);

  // The operator inbox first, because that is the thing the read-then-branch
  // got wrong. Two notifications here is one claim paged in twice.
  await sent.first;
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.calls.length, 1, 'one claim is one notification, even when two presses race');

  // Both owners are answered, and both are answered with the same moment.
  assert.strictEqual(a.body.verification_requested_at, stamp);
  assert.strictEqual(b.body.verification_requested_at, stamp);
  // One of them is told the request is already in, which is true of exactly one.
  const messages = [a.body.message, b.body.message].sort();
  assert.match(messages[0], /Request received/);
  assert.match(messages[1], /already in/);
});

test('a failed send does not change the answer the owner gets', async () => {
  let resolveTried;
  const tried = new Promise((r) => { resolveTried = r; });
  emailService.sendEmail = async () => { resolveTried(); throw new Error('resend is down'); };
  handlers = [
    [PROFILE_SELECT, () => ({ rows: [{ id: 7, google_place_id: PLACE, verified: false, verification_requested_at: null, business_name: 'The Blue Heron', owner_email: 'ava@example.com' }] })],
    NO_RIVAL,
    [REQUEST_UPDATE, () => ({ rows: [{ verification_requested_at: '2026-08-21T18:00:00.000Z' }] })],
  ];
  const res = await call('POST', '/api/venue-profile/request-verification');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.verification_status, 'pending');
  await tried;
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
