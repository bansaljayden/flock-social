// Run: node --test  (from backend/)
//
// Security RE-AUDIT of the account-deletion and profile paths. The email
// verification, account-claim and ban-tombstone systems interact, and each round
// of fixes to one of them has opened something in another — HIGH 1b below is a
// hole created by HIGH 1's own fix. Every finding this file pins:
//
//   HIGH 1  The ban tombstone branded emails the account never proved it owned.
//           deleteAccount selected the row but not email_verified/verified_email,
//           and recordBannedIdentity hashed user.email unconditionally. A
//           password account's email is UNVERIFIED, so an attacker could squat a
//           victim's address, get the squat banned, delete it, and write
//           HMAC(victim's address) with a 365-day expiry — a year-long,
//           unrecoverable, targeted block on a stranger's mailbox. Fix: only
//           tombstone an address the deleted account actually PROVED.
//   HIGH 1b (round 19) The first cut of HIGH 1 branded `email` and only when
//           verified_email matched it, so the tombstone was shed by CHANGING
//           ADDRESS before the ban landed: the row then proved nothing about the
//           address it held, the deletion recorded no email at all, and the
//           banned person signed up again on the original address. Fix: brand
//           `verified_email`, the address the account provably owned, and fall
//           back to `email` only for a grandfathered row (verified TRUE, no
//           recorded address). The poison-pill guarantee is unchanged, because
//           verified_email is only ever written by a clicked verification link or
//           a provider that vouched for the address. See the long note on the
//           'MOVED onto a victim address' test for why its expectation flipped.
//   HIGH 4  (round 19) banned_identities.email_hash was consulted on the three
//           ACCOUNT CREATION paths and nowhere else, so a banned user could sign
//           up on a throwaway address and then move that fresh row onto their
//           tombstoned address with PUT /api/users/profile — recovering the
//           identity the ban was attached to. Fix: consult the tombstone in the
//           changingEmail branch too, exactly as MEDIUM 3 does for phone.
//   HIGH 2  The "unverified accounts cannot accumulate" gate omitted PUT
//           /api/users/profile, where phone is set. An unverified squatter could
//           claim a victim's unregistered number and redirect contact-sync
//           discovery at themselves. Fix: reject a phone change from an
//           unverified account in the changingPhone branch.
//   MEDIUM 3 banned_identities.phone_hash was written on deletion but never read.
//           Fix: consult the phone tombstone where a phone is actually set.
//   HIGH 5  (round 19) The ban decision was made on the row fetched at the top of
//           deleteAccount, with a bcrypt compare and an Apple network round trip
//           between that read and the transaction. A ban committing in that
//           window was invisible, so the account deleted clean and the ban died
//           with it. Fix: re-read the row FOR UPDATE inside the transaction.
//   MEDIUM 6 (round 19) The "Email is already in use" answer on PUT /profile is
//           the same account-enumeration oracle POST /api/auth/signup is behind
//           the 10/min auth limiter for, and it sat behind the general API
//           limiter at ~200/min — the cheap way around the throttled endpoint.
//           The phone branch beside it was already metered. Fix: meter email
//           changes too, both outcomes counted.
//
// Not pinned here because it needs a socket harness: deleteAccount now calls
// revokeUserSessions() after the COMMIT. Without it a deleted account's live
// Socket.io connection stayed subscribed to `user:{id}` until the
// SESSION_RECHECK_MS sweep in sockets/handlers.js caught up.
//
// No database is touched: pool.query / pool.connect are stubbed exactly the way
// banEvasion.test.js and the rest of the suite do it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');
const realQuery = pool.query;
const realConnect = pool.connect;

const usersRouter = require('../routes/users');
const {
  proofFailures,
  phoneChangeAttempts,
  emailChangeAttempts,
  BANNED_IDENTITY_MESSAGE,
} = usersRouter.__testing;
const { isIdentityBanned } = usersRouter;
const { UNVERIFIED_MESSAGE } = require('../middleware/auth');

// ── Fixture ──────────────────────────────────────────────────────────────────
const PASSWORD = 'CorrectHorse1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // cheap rounds: this is a test

let USERS;
let tombstones;      // rows "written" to banned_identities
let sql;             // every statement the routes ran, in order
let unknown;         // statements the fixture did not model
let deletedUserIds;
// Ids whose ban "commits" between deleteAccount's first row fetch and the
// locked re-read inside the transaction. Models a moderator clicking ban while
// the account holder is mid-deletion.
let lateBan;

function reset() {
  USERS = {
    // VERIFIED banned password account. verified_email matches email, so its
    // address WAS proved and must be tombstoned on deletion (the legitimate
    // HIGH 1 case). Also carries a phone so MEDIUM 3 has a number to tombstone.
    10: {
      id: 10, email: 'proved@example.com', name: 'Proved', role: 'user',
      email_verified: true, verified_email: 'proved@example.com', is_banned: true,
      banned_at: new Date('2026-08-01T00:00:00Z'), token_version: 0, password: PASSWORD_HASH,
      phone: '(202) 555-0170', oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
    // UNVERIFIED banned password account squatting a victim's address. It never
    // proved the mailbox, so deleting it must tombstone NOTHING about that
    // address — the real owner has to stay able to sign up (HIGH 1).
    11: {
      id: 11, email: 'victim-squat@gmail.com', name: 'Squatter', role: 'user',
      email_verified: false, verified_email: null, is_banned: true,
      banned_at: new Date('2026-08-03T00:00:00Z'), token_version: 0, password: PASSWORD_HASH,
      phone: null, oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
    // VERIFIED banned account that proved its OWN mailbox and then moved onto a
    // victim's address. Rows in this exact shape predate the round-18 change
    // that un-verifies a row when PUT /profile moves its address, so they are
    // live in production: email_verified TRUE, verified_email = the address the
    // account really proved, email = an address it merely typed in.
    // verified_email is the proof, so THAT is what a ban must brand; the current
    // address is not proved and must stay clean (HIGH 1 / round 19).
    12: {
      id: 12, email: 'moved-onto-victim@gmail.com', name: 'Mover', role: 'user',
      email_verified: true, verified_email: 'attacker-own@gmail.com', is_banned: true,
      banned_at: new Date('2026-08-04T00:00:00Z'), token_version: 0, password: PASSWORD_HASH,
      phone: null, oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
    // UNVERIFIED, NOT banned password account. Used to prove the phone gate
    // (HIGH 2) and that name edits stay open to unverified accounts.
    13: {
      id: 13, email: 'unverified@example.com', name: 'Unverified', role: 'user',
      email_verified: false, verified_email: null, is_banned: false,
      banned_at: null, token_version: 0, password: PASSWORD_HASH,
      phone: null, oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
    // VERIFIED, NOT banned password account. The positive control: a legit
    // verified user can still set a fresh phone.
    14: {
      id: 14, email: 'verified@example.com', name: 'Verified', role: 'user',
      email_verified: true, verified_email: 'verified@example.com', is_banned: false,
      banned_at: null, token_version: 0, password: PASSWORD_HASH,
      phone: null, oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
  };
  tombstones = [];
  sql = [];
  unknown = [];
  deletedUserIds = [];
  lateBan = new Set();
  proofFailures.clearAll();
  phoneChangeAttempts.clearAll();
  // Process-global by design, so a test that does not clear it inherits the
  // previous test's count and fails somewhere unrelated.
  emailChangeAttempts.clearAll();
}
reset();

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

function handle(text, params = []) {
  sql.push(text);
  const has = (s) => text.includes(s);

  // middleware/auth.js — the SELECT it dispatches on. Returns the full row, so
  // req.user.email_verified reflects the fixture (which HIGH 2 reads).
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  // deleteAccount's account fetch (now trailing email_verified, verified_email).
  // The same statement runs twice: once up front on the pool, then again inside
  // the deletion transaction with FOR UPDATE. `lateBan` flips is_banned only on
  // the second one, which is how a ban committing mid-deletion is simulated.
  if (has('apple_refresh_token, is_banned, banned_at')) {
    const u = USERS[params[0]];
    if (u && has('FOR UPDATE') && lateBan.has(u.id)) {
      u.is_banned = true;
      u.banned_at = new Date();
    }
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  // PUT /profile's user fetch
  if (has('SELECT * FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  // email uniqueness
  if (has('SELECT id FROM users WHERE LOWER(email)')) {
    const hit = Object.values(USERS).find(
      (u) => u.email.toLowerCase() === String(params[0]).toLowerCase() && u.id !== params[1]
    );
    return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 };
  }
  // phone uniqueness
  if (has('RIGHT(REGEXP_REPLACE(phone')) {
    const hit = Object.values(USERS).find((u) => u.id !== params[0] && u.phone && last10(u.phone) === params[1]);
    return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 };
  }
  if (has('UPDATE users')) {
    // Recognised by its SET list rather than by parameter count. Counting broke
    // the moment migration 051 appended the contact-discovery parameters, and a
    // fixture that stops recognising its own statement writes nothing and reads
    // as "the edit did not happen". The id stays at params[5] on purpose (see
    // routes/users.js); other UPDATEs here key on their last parameter.
    const isProfile = has('SET name = COALESCE');
    const idParam = isProfile ? params[5] : params[params.length - 1];
    const u = USERS[idParam] || USERS[14];
    if (isProfile || params.length === 6) {
      if (params[0]) u.name = params[0];
      if (params[1]) u.email = params[1];
      if (params[2]) u.phone = params[2];
      if (params[6]) u.bio = params[6];
    }
    return { rows: [{ ...u }], rowCount: 1 };
  }

  // banned_identities (migration 012)
  if (has('SELECT 1 FROM banned_identities')) {
    const [emailHash, phoneHash, oauthHash] = params;
    const hit = tombstones.find((t) => t.expires_at > new Date()
      && ((emailHash && t.email_hash === emailHash)
        || (phoneHash && t.phone_hash === phoneHash)
        || (oauthHash && t.oauth_hash === oauthHash)));
    return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
  }
  if (has('INSERT INTO banned_identities')) {
    const [email_hash, phone_hash, oauth_hash, banned_at, days] = params;
    tombstones.push({
      email_hash, phone_hash, oauth_hash, banned_at,
      expires_at: new Date(Date.now() + days * 86400000),
    });
    return { rows: [], rowCount: 1 };
  }
  if (has('DELETE FROM banned_identities')) {
    const before = tombstones.length;
    tombstones = tombstones.filter((t) => t.expires_at > new Date());
    return { rows: [], rowCount: before - tombstones.length };
  }

  // The flocks this deletion cancels, read BEFORE the transaction so the
  // members can be told (see the cancellation fan-out in deleteAccount). This
  // fixture is about tombstones, so it models the query and owns no flocks;
  // __tests__/accountDeletionSurface.test.js is where the fan-out is driven.
  if (has('FROM flocks f') && has('WHERE f.creator_id = $1')) return { rows: [], rowCount: 0 };

  // deletion transaction
  if (has('BEGIN') || has('COMMIT') || has('ROLLBACK')) return { rows: [], rowCount: 0 };
  if (has('UPDATE content_reports') || has('UPDATE moderation_actions')) return { rows: [], rowCount: 0 };
  if (has('DELETE FROM messages')) return { rows: [], rowCount: 0 };
  if (has('DELETE FROM users WHERE id = $1')) {
    const existed = Boolean(USERS[params[0]]);
    if (existed) { deletedUserIds.push(params[0]); delete USERS[params[0]]; }
    return { rows: existed ? [{ id: params[0] }] : [], rowCount: existed ? 1 : 0 };
  }

  unknown.push(text);
  return { rows: [], rowCount: 0 };
}

pool.query = async (text, params) => handle(typeof text === 'string' ? text : text.text, params);
pool.connect = async () => ({
  query: async (text, params) => handle(typeof text === 'string' ? text : text.text, params),
  release() {},
});

// ── App under test ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  pool.query = realQuery;
  pool.connect = realConnect;
  return pool.end().catch(() => {});
});
test.beforeEach(reset);

function tokenFor(id, { ageSeconds = 0 } = {}) {
  return jwt.sign(
    { userId: id, tv: USERS[id]?.token_version || 0, iat: Math.floor(Date.now() / 1000) - ageSeconds },
    process.env.JWT_SECRET
  );
}

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

const ranSql = (fragment) => sql.some((s) => s.includes(fragment));
const assertModelled = () => assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

// ===========================================================================
// HIGH 1 — the tombstone only brands PROVED addresses
// ===========================================================================

test('deleting a VERIFIED banned account tombstones its proven email', async () => {
  const res = await call('DELETE', '/api/users/me', tokenFor(10), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(deletedUserIds, [10]);
  assert.strictEqual(tombstones.length, 1);
  assert.ok(tombstones[0].email_hash, 'a proven address must be tombstoned');
  assert.strictEqual(await isIdentityBanned({ email: 'proved@example.com' }), true);
  assertModelled();
});

test('deleting an UNVERIFIED banned squat does NOT tombstone the victim email', async () => {
  // The whole HIGH 1 finding: an attacker squats victim-squat@gmail.com with a
  // password (unverified), provokes a ban, deletes the squat, and before this
  // fix that wrote HMAC(victim's address) for 365 days — the real owner could
  // then never sign up on any path. The squat proved nothing, so nothing about
  // that address may survive it.
  const res = await call('DELETE', '/api/users/me', tokenFor(11), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(deletedUserIds, [11], 'the banned squat itself is still deleted');

  // No email tombstone was written (no phone/oauth either, so nothing at all).
  assert.deepStrictEqual(tombstones, [], 'an unverified address must not be branded');
  assert.strictEqual(await isIdentityBanned({ email: 'victim-squat@gmail.com' }), false,
    'the real owner must still be able to sign up');
  assert.strictEqual(await isIdentityBanned({ email: 'victim-squat+tag@gmail.com' }), false, 'gmail alias too');
  assertModelled();
});

test('a verified account that MOVED onto a victim address tombstones the PROVED one, not the held one', async () => {
  // WHY THIS EXPECTATION CHANGED (round 19) — read this before filing it as a
  // regression. The first version of this test asserted that NEITHER address was
  // hashed: the fix it pinned required verified_email to MATCH the current email
  // and then branded `email`. That was half right. Refusing to brand the address
  // the row merely HOLDS is correct and still asserted below — it is the poison
  // pill, an attacker permanently locking a stranger out of a mailbox they can
  // prove nothing about. But letting the attacker's OWN proved address go
  // unbranded made the ban shakeable on purpose: move your address off the one
  // you proved, wait for the ban, delete, and the deletion recorded nothing about
  // an email at all — then sign up again on the original address with a clean
  // row. The ban blocks PUT /profile, so the move has to be made before the ban
  // lands; that narrows the window, it does not close it.
  //
  // So the rule is not "tombstone nothing when the two disagree". It is
  // "tombstone the address this account PROVED". verified_email is written only
  // by a clicked verification link or a provider that vouched for the address,
  // never by anything an attacker types, so branding it can never reach a
  // stranger's mailbox — which is the property the older assertion was really
  // protecting, and it is preserved here in the second assertion.
  const res = await call('DELETE', '/api/users/me', tokenFor(12), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(deletedUserIds, [12]);

  assert.strictEqual(tombstones.length, 1, 'the proved address must leave a tombstone');
  assert.ok(tombstones[0].email_hash, 'the proved address must be hashed');
  assert.strictEqual(await isIdentityBanned({ email: 'attacker-own@gmail.com' }), true,
    'the address this account actually proved carries the ban');
  assert.strictEqual(await isIdentityBanned({ email: 'attacker-own+tag@gmail.com' }), true, 'gmail alias too');

  // The half that has not changed, and must not: the victim's mailbox was never
  // proved by this row, so it stays free.
  assert.strictEqual(await isIdentityBanned({ email: 'moved-onto-victim@gmail.com' }), false,
    'an address the row merely held must never be branded');
  assertModelled();
});

test('a ban that commits mid-deletion is still tombstoned', async () => {
  // Round 19. The ban decision used to be made on the row fetched at the top of
  // deleteAccount, and between that fetch and the transaction sit a bcrypt
  // compare and (for Apple accounts) a network round trip to the revocation
  // endpoint. A ban committing in that window was invisible: the account deleted
  // clean, no tombstone was written, and the ban died with the row — the same
  // one-tap ban reset the tombstone exists to prevent, reachable by losing a
  // race instead of by design. The decision now reads the row again inside the
  // transaction, FOR UPDATE.
  lateBan.add(14);
  const res = await call('DELETE', '/api/users/me', tokenFor(14), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(deletedUserIds, [14]);
  assert.ok(ranSql('FOR UPDATE'), 'the ban decision must be made on a locked read');
  assert.strictEqual(tombstones.length, 1, 'the ban landed before the row did, so it must outlive it');
  assert.strictEqual(await isIdentityBanned({ email: 'verified@example.com' }), true);
  assertModelled();
});

test('a deletion with no ban in sight still records nothing', async () => {
  // The control for the test above: re-reading the row must not turn every
  // deletion into a tombstone.
  const res = await call('DELETE', '/api/users/me', tokenFor(14), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(deletedUserIds, [14]);
  assert.deepStrictEqual(tombstones, [], 'a clean account is never fingerprinted');
  assertModelled();
});

// ===========================================================================
// HIGH 2 — an unverified account cannot set a phone
// ===========================================================================

test('an unverified account cannot claim a phone number', async () => {
  // The reopened hole: PUT /profile is not on UNVERIFIED_DENY, so an unverified
  // squatter could set a victim's unregistered number and hijack their
  // contact-sync discovery. The number is free (nobody holds it), so the
  // uniqueness check would have waved it through.
  const res = await call('PUT', '/api/users/profile', tokenFor(13), {
    phone: '+12025550150', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(res.body.error, UNVERIFIED_MESSAGE);
  assert.strictEqual(res.body.emailVerificationRequired, true);
  assert.strictEqual(USERS[13].phone, null, 'the number must not be written');
  assert.ok(!ranSql('UPDATE users'), 'nothing may be persisted');
  assert.ok(!ranSql('RIGHT(REGEXP_REPLACE(phone'), 'must reject before the uniqueness probe even runs');
  assertModelled();
});

test('an unverified account can still edit its display name', async () => {
  // The gate is scoped to phone. Locking an unverified account out of renaming
  // itself would be a usability regression and is not what the finding asks for.
  const res = await call('PUT', '/api/users/profile', tokenFor(13), {
    name: 'Renamed', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(USERS[13].name, 'Renamed');
  assertModelled();
});

test('a VERIFIED account can still set a fresh phone number', async () => {
  // The positive control: the HIGH 2 fix must not break legitimate verified
  // users setting a number for the first time.
  const res = await call('PUT', '/api/users/profile', tokenFor(14), {
    phone: '+12025550151', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(USERS[14].phone, '+12025550151');
  assertModelled();
});

// ===========================================================================
// MEDIUM 3 — the phone tombstone is actually consulted
// ===========================================================================

test('a phone number tombstoned by a ban is refused at the profile route', async () => {
  // Deleting the verified banned account (id 10) writes a phone tombstone for
  // 202-555-0170. Before this fix nothing ever read phone_hash, so a banned
  // user could re-attach the same number under a fresh email. Now a verified
  // account trying to set that number is refused with the generic banned
  // identity message — even reformatted, matching find-by-phone's last-10 rule.
  const del = await call('DELETE', '/api/users/me', tokenFor(10), { password: PASSWORD });
  assert.strictEqual(del.status, 200, del.text);
  assert.ok(tombstones[0].phone_hash, 'the deletion must have left a phone tombstone');

  const res = await call('PUT', '/api/users/profile', tokenFor(14), {
    phone: '+1 (202) 555-0170', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(res.body.error, BANNED_IDENTITY_MESSAGE);
  assert.strictEqual(USERS[14].phone, null, 'the tombstoned number must not be written');
  assert.ok(!ranSql('UPDATE users'));
  assertModelled();
});

// ===========================================================================
// HIGH 4 — the email tombstone is consulted where an address is CLAIMED, not
// only where an account is created
// ===========================================================================

test('a tombstoned email cannot be re-claimed through the profile route', async () => {
  // The evasion this closes: get banned, delete (which brands the address you
  // proved), sign up again on a throwaway address — nothing about THAT is
  // tombstoned, so it succeeds — and then simply move the new row onto the old
  // address with PUT /profile. Every other guard on that branch passes: the
  // address is free because the banned row was deleted, the row has no
  // oauth_provider, and the current-password proof is your own. Only the
  // tombstone knows, and until round 19 nothing asked it here.
  const del = await call('DELETE', '/api/users/me', tokenFor(10), { password: PASSWORD });
  assert.strictEqual(del.status, 200, del.text);
  assert.ok(tombstones[0].email_hash, 'the deletion must have left an email tombstone');

  const res = await call('PUT', '/api/users/profile', tokenFor(14), {
    email: 'proved@example.com', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(res.body.error, BANNED_IDENTITY_MESSAGE);
  assert.strictEqual(USERS[14].email, 'verified@example.com', 'the address must not move');
  assert.ok(!ranSql('UPDATE users'), 'nothing may be persisted');
  assertModelled();
});

test('an un-tombstoned address is still accepted at the profile route', async () => {
  // The tombstone check must not become a blanket refusal on email edits: a
  // free address that was never banned still goes through, and the round-18
  // un-verification still happens.
  const del = await call('DELETE', '/api/users/me', tokenFor(10), { password: PASSWORD });
  assert.strictEqual(del.status, 200, del.text);

  const res = await call('PUT', '/api/users/profile', tokenFor(14), {
    email: 'somewhere-fresh@example.com', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(USERS[14].email, 'somewhere-fresh@example.com');
  assert.strictEqual(res.body.emailVerificationRequired, true, 'the moved row is unverified again');
  assertModelled();
});

test('email changes are metered, so the uniqueness check is not an address-book oracle', async () => {
  // Round 19: the "Email is already in use" 400 answers "does an account exist
  // at this address?" — the same question POST /api/auth/signup is behind the
  // 10/min auth limiter for. PUT /profile sits behind the general API limiter at
  // roughly 200/min, so it was the cheap way around the throttled endpoint. The
  // phone branch beside it was metered for exactly this reason; this one was not.
  // Both outcomes count, because both are answers.
  for (let i = 0; i < 10; i += 1) {
    const res = await call('PUT', '/api/users/profile', tokenFor(14), {
      email: `probe-${i}@example.com`, current_password: PASSWORD,
    });
    assert.ok(res.status === 200 || res.status === 400, `unexpected ${res.status}: ${res.text}`);
  }
  const locked = await call('PUT', '/api/users/profile', tokenFor(14), {
    email: 'probe-11@example.com', current_password: PASSWORD,
  });
  assert.strictEqual(locked.status, 429, locked.text);

  // Scoped to the address change: renaming yourself is not metered, and another
  // account is not locked out by this one.
  const name = await call('PUT', '/api/users/profile', tokenFor(14), { name: 'Still Me', current_password: PASSWORD });
  assert.strictEqual(name.status, 200, name.text);
  const other = await call('PUT', '/api/users/profile', tokenFor(13), { name: 'Also Fine', current_password: PASSWORD });
  assert.strictEqual(other.status, 200, other.text);
});

test('an un-tombstoned number is still accepted at the profile route', async () => {
  // The tombstone check must not become a blanket refusal: a number that was
  // never banned still goes through.
  const del = await call('DELETE', '/api/users/me', tokenFor(10), { password: PASSWORD });
  assert.strictEqual(del.status, 200, del.text);

  const res = await call('PUT', '/api/users/profile', tokenFor(14), {
    phone: '+12025550188', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(USERS[14].phone, '+12025550188');
  assertModelled();
});
