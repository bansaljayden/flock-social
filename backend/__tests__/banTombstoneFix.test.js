// Run: node --test  (from backend/)
//
// Security RE-AUDIT of round-16 changes — the email-verification, account-claim
// and ban-tombstone systems interact to create three holes this file proves are
// closed:
//
//   HIGH 1  The ban tombstone branded emails the account never proved it owned.
//           deleteAccount selected the row but not email_verified/verified_email,
//           and recordBannedIdentity hashed user.email unconditionally. A
//           password account's email is UNVERIFIED, so an attacker could squat a
//           victim's address, get the squat banned, delete it, and write
//           HMAC(victim's address) with a 365-day expiry — a year-long,
//           unrecoverable, targeted block on a stranger's mailbox. Fix: only
//           tombstone an address the deleted account actually PROVED.
//   HIGH 2  The "unverified accounts cannot accumulate" gate omitted PUT
//           /api/users/profile, where phone is set. An unverified squatter could
//           claim a victim's unregistered number and redirect contact-sync
//           discovery at themselves. Fix: reject a phone change from an
//           unverified account in the changingPhone branch.
//   MEDIUM 3 banned_identities.phone_hash was written on deletion but never read.
//           Fix: consult the phone tombstone where a phone is actually set.
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
    // victim's address (PUT /profile does not reset email_verified). verified_email
    // no longer matches email, so the CURRENT address must not be tombstoned
    // either — the mismatch is not proof of the address it now holds (HIGH 1).
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
  proofFailures.clearAll();
  phoneChangeAttempts.clearAll();
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
  // deleteAccount's account fetch (now trailing email_verified, verified_email)
  if (has('apple_refresh_token, is_banned, banned_at')) {
    const u = USERS[params[0]];
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
    const u = USERS[params[params.length - 1]] || USERS[14];
    if (params.length === 6) {
      if (params[0]) u.name = params[0];
      if (params[1]) u.email = params[1];
      if (params[2]) u.phone = params[2];
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

test('a verified account that MOVED onto a victim address tombstones neither address', async () => {
  // email_verified stays true across a PUT /profile email change, so a banned
  // account can hold a verified flag for an address it never proved. The proof
  // is verified_email, and it no longer matches the current email — so the
  // current (victim's) address is not proved and must not be tombstoned. The
  // attacker's own proved address is not the one on the row, so it is not
  // hashed either.
  const res = await call('DELETE', '/api/users/me', tokenFor(12), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(deletedUserIds, [12]);
  assert.deepStrictEqual(tombstones, [], 'a mismatched verified_email must not brand the current address');
  assert.strictEqual(await isIdentityBanned({ email: 'moved-onto-victim@gmail.com' }), false);
  assert.strictEqual(await isIdentityBanned({ email: 'attacker-own@gmail.com' }), false);
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
