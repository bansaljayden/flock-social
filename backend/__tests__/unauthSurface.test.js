// Run: node --test  (from backend/)
//
// Round 15 security audit — the UNAUTHENTICATED attack surface (guest share
// links, NFC check-in) plus the safety-critical paths (SOS, trusted contacts,
// report/block, takedown).
//
// Every test below pins a specific exploit that worked before this round. The
// comment on each one is the attack, not the assertion.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');

// ---------------------------------------------------------------------------
// checkin.js
// ---------------------------------------------------------------------------
const { __test: checkin } = require('../routes/checkin');

// Stand in for the users row middleware/auth.js and tryAuth both read.
function stubUserRow(row) {
  const real = pool.query;
  pool.query = async () => ({ rows: row ? [row] : [] });
  return () => { pool.query = real; };
}

test('NFC tryAuth: a token revoked by a token_version bump is NOT accepted', async () => {
  // Migration 009's whole purpose: bumping users.token_version evicts a
  // squatter after the verified owner claims the account. tryAuth only asked
  // "does this id still exist", so the evicted party kept writing check-ins AS
  // THE VICTIM and kept marking the victim's flock attendance for the rest of
  // the token's 24h life.
  const token = jwt.sign({ userId: 7, tv: 1 }, process.env.JWT_SECRET);
  const restore = stubUserRow({ id: 7, is_banned: false, token_version: 2 });
  try {
    const req = { headers: { authorization: `Bearer ${token}` } };
    assert.strictEqual(await checkin.tryAuth(req), null, 'stale tv must not authenticate');
  } finally { restore(); }
});

test('NFC tryAuth: a BANNED account is not accepted', async () => {
  // A ban is supposed to bite on the next request everywhere. This route let a
  // banned account keep minting check-ins and earning reliability credit.
  const token = jwt.sign({ userId: 7, tv: 0 }, process.env.JWT_SECRET);
  const restore = stubUserRow({ id: 7, is_banned: true, token_version: 0 });
  try {
    const req = { headers: { authorization: `Bearer ${token}` } };
    assert.strictEqual(await checkin.tryAuth(req), null, 'banned users must fall back to anonymous');
  } finally { restore(); }
});

test('NFC tryAuth: a current token still works, including pre-migration tokens', async () => {
  // The fix must not log real users out. A token minted before `tv` existed
  // reads as version 0, which is the column DEFAULT.
  const restore = stubUserRow({ id: 7, is_banned: false, token_version: 0 });
  try {
    const current = jwt.sign({ userId: 7, tv: 0 }, process.env.JWT_SECRET);
    assert.strictEqual(await checkin.tryAuth({ headers: { authorization: `Bearer ${current}` } }), 7);

    const legacy = jwt.sign({ userId: 7 }, process.env.JWT_SECRET); // no tv claim
    assert.strictEqual(await checkin.tryAuth({ headers: { authorization: `Bearer ${legacy}` } }), 7);
  } finally { restore(); }
});

test('NFC tryAuth: garbage and missing tokens are anonymous, never a throw', async () => {
  assert.strictEqual(await checkin.tryAuth({ headers: {} }), null);
  assert.strictEqual(await checkin.tryAuth({ headers: { authorization: 'Bearer nonsense' } }), null);
  assert.strictEqual(await checkin.tryAuth({ headers: { authorization: 'Basic abc' } }), null);
});

test('check-in dedupe binds to the ACCOUNT, so rotating IPs buys nothing', () => {
  // Round 3 deduped anonymous taps on ip|place only; authenticated taps had no
  // ceiling at all. One logged-in account could hold down the NFC URL and write
  // unbounded venue_checkins rows while every viewer's live "recent check-ins"
  // number climbed once per request.
  checkin.tapCache.clear();
  assert.strictEqual(checkin.tapIsDuplicate(7, 'PLACE_A', '1.1.1.1'), false, 'first tap counts');
  assert.strictEqual(checkin.tapIsDuplicate(7, 'PLACE_A', '1.1.1.1'), true, 'immediate re-tap is a duplicate');
  assert.strictEqual(checkin.tapIsDuplicate(7, 'PLACE_A', '9.9.9.9'), true, 'a new IP does not reset a user');
  assert.strictEqual(checkin.tapIsDuplicate(7, 'PLACE_B', '1.1.1.1'), false, 'a different venue is its own tap');
  assert.strictEqual(checkin.tapIsDuplicate(null, 'PLACE_A', '1.1.1.1'), false, 'anon is keyed separately from user 7');
  assert.strictEqual(checkin.tapIsDuplicate(null, 'PLACE_A', '1.1.1.1'), true, 'anon still dedupes per IP');
});

test('venue_checkin broadcast does not reveal WHO checked in', () => {
  // `venue:{placeId}` is not a private room: sockets/handlers.js `join_venue`
  // takes any place id from any authenticated socket with no membership and no
  // block check, 25 at a time. Carrying user_id turned that into a live feed of
  // which accounts walked into which venues — a stalking primitive on a teen
  // app, and one that ignored user_blocks completely.
  const emitted = [];
  const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };

  checkin.emitVenueCheckin(io, 'PLACE_A', '2026-08-13T20:00:00.000Z');

  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].room, 'venue:PLACE_A');
  assert.strictEqual(emitted[0].event, 'venue_checkin');
  assert.ok(!('user_id' in emitted[0].payload), 'payload must not identify the person');
  assert.deepStrictEqual(Object.keys(emitted[0].payload).sort(), ['created_at', 'venue_place_id']);
});

test('NFC place ids are shape-checked before they reach a VARCHAR(255) column', () => {
  assert.strictEqual(checkin.validPlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4'), true);
  assert.strictEqual(checkin.validPlaceId('x'.repeat(300)), false);
  assert.strictEqual(checkin.validPlaceId("'; DROP TABLE users--"), false);
  assert.strictEqual(checkin.validPlaceId(''), false);
  assert.strictEqual(checkin.validPlaceId(null), false);
});

// ---------------------------------------------------------------------------
// guest.js — the only unauthenticated INSERT in the app
// ---------------------------------------------------------------------------
const guest = require('../routes/guest');

test('a share link cannot be flooded with fresh guest identities', () => {
  // Creating a guest identity is the expensive unauthenticated operation:
  // each one may cast a guest vote that routes/venues.js folds into the
  // MEMBER-facing venue tally, each "in" pushes the host a notification, and
  // each consumes one of 50 per-flock slots that a takedown deliberately never
  // frees. 50 identities was 50 requests — comfortably inside the 300/15min
  // general limiter — so one script could outvote a five-person flock 10:1 and
  // permanently brick the invite link for real guests.
  guest.newGuestLog.clear();
  // The budget is the exported constant (12 since 2026-09-04: a table on one
  // wifi), not a literal, so this pins the SHAPE of the guard.
  for (let i = 0; i < guest.NEW_GUESTS_PER_IP_PER_FLOCK; i++) {
    assert.strictEqual(guest.allowNewGuest('1.1.1.1', 42), true, `guest ${i + 1} should be allowed`);
  }
  assert.strictEqual(guest.allowNewGuest('1.1.1.1', 42), false, 'the one past the budget from one IP is refused');

  // Budgets are per flock and per IP, so the throttle never leaks across plans
  // and never punishes a genuinely different guest.
  assert.strictEqual(guest.allowNewGuest('1.1.1.1', 43), true, 'a different flock has its own budget');
  assert.strictEqual(guest.allowNewGuest('2.2.2.2', 42), true, 'a different guest has its own budget');
});

test('guest name normalization is what makes a takedown stick', () => {
  // The bypass was one request: a hidden guest simply omits their guestToken,
  // falls through to the INSERT, and gets a fresh row broadcasting the SAME
  // abusive name to every member. Case and spacing must not defeat the replay
  // guard, and profanity screening does not help here — reported guest names
  // are targeted at a person, not obscene, and pass the filter cleanly.
  const n = guest.normalizeGuestName;
  assert.strictEqual(n('  Abusive   Name '), 'abusive name');
  assert.strictEqual(n('ABUSIVE NAME'), n('abusive name'));
  assert.strictEqual(n('Abusive\tName'), n('Abusive Name'));
  assert.notStrictEqual(n('Sam'), n('Sammy'), 'must not over-match innocent guests');
  assert.strictEqual(n(null), '');
});

test('guest link tokens are not enumerable', () => {
  // ~55^24 (≈139 bits — the 2026-08-14 sweep raised it from 12 chars, which
  // was ~69). Also checks the alphabet excludes the look-alike characters,
  // since these get read aloud and retyped. The deeper entropy properties
  // (>=128-bit floor, unbiased sampling, column fit) are pinned in
  // __tests__/guestInviteHardening.test.js.
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = guest.newLinkToken();
    assert.strictEqual(t.length, 24);
    assert.match(t, /^[A-HJ-NP-Za-hjkmnp-z2-9]{24}$/, `unexpected characters in ${t}`);
    seen.add(t);
  }
  assert.strictEqual(seen.size, 500, 'tokens must not repeat');
});

// ---------------------------------------------------------------------------
// safety.js — SOS
// ---------------------------------------------------------------------------
const { __test: safety } = require('../routes/safety');

test('SOS coordinates: string coords no longer kill the alert', () => {
  // `latitude.toFixed(6)` ran on the raw body AFTER the emergency_alerts row
  // was committed. A client sending coordinates as JSON strings threw a
  // TypeError that the outer catch turned into `500 Failed to send alert` with
  // ZERO emails sent to ANY trusted contact — and the claimed row then blocked
  // the retry for another 60 seconds.
  assert.deepStrictEqual(safety.readCoords('40.7128', '-74.0060'), { lat: 40.7128, lng: -74.006 });
  assert.deepStrictEqual(safety.readCoords(40.7128, -74.006), { lat: 40.7128, lng: -74.006 });
});

test('SOS coordinates: 0,0 is a real place, and junk is refused', () => {
  // The old `!latitude || !longitude` guard rejected the equator and the prime
  // meridian, and accepted anything else truthy.
  assert.deepStrictEqual(safety.readCoords(0, 0), { lat: 0, lng: 0 });

  for (const bad of [
    ['abc', 'def'], [null, null], [undefined, undefined], ['', ''],
    [[40.7], [-74]], [{}, {}], [NaN, NaN], [Infinity, 0],
    [91, 0], [-91, 0], [0, 181], [0, -181],   // out of range
  ]) {
    assert.strictEqual(safety.readCoords(bad[0], bad[1]), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('SOS coordinates that survive validation cannot break out of the email HTML', () => {
  // They are re-emitted as numbers, so the maps.google.com href and the
  // coordinate line are structurally safe no matter what was sent.
  const c = safety.readCoords('40.7128', '-74.0060');
  assert.strictEqual(typeof c.lat, 'number');
  assert.strictEqual(typeof c.lng, 'number');
  assert.strictEqual(safety.readCoords('40.7"><script>alert(1)</script>', '-74'), null);
});

test('trusted-contact email validation rejects the shapes that would bounce', () => {
  assert.ok(safety.EMAIL_RE.test('mum@example.com'));
  assert.ok(!safety.EMAIL_RE.test('not-an-email'));
  assert.ok(!safety.EMAIL_RE.test('a@b'));
  assert.ok(!safety.EMAIL_RE.test('a b@example.com'));
  // The ceiling matters: trusted contacts are an unverified email-sending
  // surface, so the number of addresses one account can aim at is bounded.
  assert.strictEqual(safety.MAX_TRUSTED_CONTACTS, 5);
});

// ---------------------------------------------------------------------------
// moderation.js — block route, driven over real HTTP through the real
// authenticate middleware, because the bug was a validator whose result was
// never read.
// ---------------------------------------------------------------------------
const moderationRoutes = require('../routes/moderation');

const ME = { id: 7, email: 'me@example.com', name: 'Me', role: 'user', is_banned: false, token_version: 0 };

// Route the handful of statements these routes issue. Anything unexpected
// returns no rows rather than hitting a database that isn't there.
function stubModerationQueries({ targetExists = true } = {}) {
  const real = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text: String(text), params });
    const sql = String(text);
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [ME] };
    if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: targetExists ? [{ id: params[0] }] : [] };
    return { rows: [], rowCount: 0 };
  };
  return { calls, restore: () => { pool.query = real; } };
}

async function callRoute(method, path) {
  const app = express();
  app.use(express.json());
  app.use('/api', moderationRoutes);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const token = jwt.sign({ userId: ME.id, tv: 0 }, process.env.JWT_SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('blocking a non-numeric user id is a 400, not a 500', async () => {
  // `param('userId').isInt()` was declared on both block routes and its result
  // was never read, so the validator did nothing: the value reached Postgres as
  // NaN and came back "invalid input syntax for type integer" — a 500 on the
  // App Review 1.2 safety control.
  const { restore } = stubModerationQueries();
  try {
    const res = await callRoute('POST', '/api/blocks/abc');
    assert.strictEqual(res.status, 400, 'must reject the id, not crash on it');
    assert.match(res.body.error, /Invalid user id/);
  } finally { restore(); }
});

test('blocking "12abc" does not silently block user 12', async () => {
  // parseInt stops at the first non-digit, so the old code acted on a DIFFERENT
  // account than the caller named — the worst possible outcome for a block.
  const { restore, calls } = stubModerationQueries();
  try {
    const res = await callRoute('POST', '/api/blocks/12abc');
    assert.strictEqual(res.status, 400);
    assert.ok(
      !calls.some((c) => c.text.includes('INSERT INTO user_blocks')),
      'no block may be written for an id the caller did not name'
    );
  } finally { restore(); }
});

test('unblocking a non-numeric id is a 400 too', async () => {
  const { restore } = stubModerationQueries();
  try {
    const res = await callRoute('DELETE', '/api/blocks/%20');
    assert.strictEqual(res.status, 400);
  } finally { restore(); }
});

test('a well-formed block still goes through', async () => {
  // The validation fix must not break the control it protects.
  const { restore, calls } = stubModerationQueries();
  try {
    const res = await callRoute('POST', '/api/blocks/99');
    assert.strictEqual(res.status, 201);
    assert.ok(calls.some((c) => c.text.includes('INSERT INTO user_blocks')), 'the block must be recorded');
  } finally { restore(); }
});

test('you still cannot block yourself', async () => {
  const { restore } = stubModerationQueries();
  try {
    const res = await callRoute('POST', `/api/blocks/${ME.id}`);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /cannot block yourself/);
  } finally { restore(); }
});

test('the block routes are behind authentication at all', async () => {
  // router.use(authenticate) is the only thing standing between an anonymous
  // caller and the block table.
  const app = express();
  app.use(express.json());
  app.use('/api', moderationRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/blocks/99`, { method: 'POST' });
    assert.strictEqual(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
