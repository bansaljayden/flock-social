// Run: node --test  (from backend/)
//
// Round 16 security audit — routes/users.js. Three findings, all of them things
// that worked before this round:
//
//   1. BAN EVASION BY SELF-DELETION. A banned account may delete itself (Apple
//      5.1.1(v)) and nothing survived the deletion, so "get banned, delete, sign
//      up again on the same email" reset the ban. migrations/012 adds hashed
//      tombstones; routes/auth.js checks them at signup.
//   2. DELETE /api/users/me TOOK A BEARER TOKEN AND NOTHING ELSE. A stolen 24h
//      token irreversibly destroyed the account and revoked the Apple grant.
//   3. PUT /api/users/profile ACCEPTED ANY `phone`. Friend discovery resolves
//      against that column, so an attacker could claim a victim's number.
//
// Each test's comment is the attack, not the assertion. No database is touched:
// pool.query and pool.connect are stubbed the way the rest of this suite does it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');
const realQuery = pool.query;
const realConnect = pool.connect;

const usersRouter = require('../routes/users');
const {
  identityDigests,
  canonicalPhone,
  hasFreshSession,
  proofFailures,
  phoneChangeAttempts,
  REAUTH_WINDOW_MS,
  BAN_TOMBSTONE_RETENTION_DAYS,
} = usersRouter.__testing;
const { isIdentityBanned, rejectIfBannedIdentity } = usersRouter;

// ── Fixture ────────────────────────────────────────────────────────────────
// Numbers are 202-555-01xx: reserved for fiction and, unlike 555-01xx, actually
// accepted by validator's isMobilePhone (which signup uses and this file now
// matches — a fixture built on numbers the validator rejects would have tested
// nothing but the validator).
const PASSWORD = 'CorrectHorse1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // cheap rounds: this is a test

let USERS;
let tombstones;      // rows "written" to banned_identities
let sql;             // every statement the routes ran, in order
let unknown;         // statements the fixture did not model
let deletedUserIds;
let dbError;         // when set, banned_identities reads/writes throw

function reset() {
  USERS = {
    1: { // password account
      id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true, is_banned: false,
      banned_at: null, token_version: 0, password: PASSWORD_HASH, phone: '+12025550101',
      oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
    2: { // Google account, no password
      id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', email_verified: true, is_banned: false,
      banned_at: null, token_version: 0, password: null, phone: null,
      oauth_provider: 'google', oauth_id: 'google-sub-2', apple_refresh_token: null, interests: [],
    },
    3: { // BANNED password account
      id: 3, email: 'Mal.lory+spam@gmail.com', name: 'Mallory', role: 'user', email_verified: true, is_banned: true,
      banned_at: new Date('2026-08-01T00:00:00Z'), token_version: 0, password: PASSWORD_HASH,
      phone: '(202) 555-0177', oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
    4: { // BANNED Apple account, no password
      id: 4, email: 'relay@privaterelay.appleid.com', name: 'Nate', role: 'user', email_verified: true, is_banned: true,
      banned_at: new Date('2026-08-02T00:00:00Z'), token_version: 0, password: null, phone: null,
      oauth_provider: 'apple', oauth_id: 'apple-sub-4', apple_refresh_token: null, interests: [],
    },
    5: { // bystander who already holds a phone number
      id: 5, email: 'victim@example.com', name: 'Victim', role: 'user', email_verified: true, is_banned: false,
      banned_at: null, token_version: 0, password: PASSWORD_HASH, phone: '202-555-0199',
      oauth_provider: null, oauth_id: null, apple_refresh_token: null, interests: [],
    },
  };
  tombstones = [];
  sql = [];
  unknown = [];
  deletedUserIds = [];
  dbError = null;
  // The attempt ceilings are process-wide by design, so tests must start from a
  // clean slate or they leak into each other.
  proofFailures.clearAll();
  phoneChangeAttempts.clearAll();
}
reset();

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

function handle(text, params = []) {
  sql.push(text);
  const has = (s) => text.includes(s);

  // middleware/auth.js. Matched on the substring that file deliberately keeps
  // stable for these harnesses, so adding a column to the SELECT (round 16
  // added email_verified) does not silently turn every request into a 401.
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  // deleteAccount's account fetch
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
  // phone uniqueness (round 16)
  if (has('RIGHT(REGEXP_REPLACE(phone')) {
    const hit = Object.values(USERS).find((u) => u.id !== params[0] && u.phone && last10(u.phone) === params[1]);
    return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 };
  }
  if (has('UPDATE users')) {
    // The profile UPDATE keys its row on $6 and carries bio as a trailing $7
    // (routes/users.js keeps the id at params[5] on purpose); other UPDATEs
    // in this file still key on their last parameter.
    const idParam = params.length === 7 ? params[5] : params[params.length - 1];
    const u = USERS[idParam] || USERS[1];
    if (params.length === 6 || params.length === 7) {
      if (params[0]) u.name = params[0];
      if (params[1]) u.email = params[1];
      if (params[2]) u.phone = params[2];
      if (params.length === 7 && params[6]) u.bio = params[6];
    }
    return { rows: [{ ...u }], rowCount: 1 };
  }

  // banned_identities (migration 012)
  if (has('SELECT 1 FROM banned_identities')) {
    if (dbError) throw new Error('relation "banned_identities" does not exist');
    const [emailHash, phoneHash, oauthHash] = params;
    const hit = tombstones.find((t) => t.expires_at > new Date()
      && ((emailHash && t.email_hash === emailHash)
        || (phoneHash && t.phone_hash === phoneHash)
        || (oauthHash && t.oauth_hash === oauthHash)));
    return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
  }
  if (has('INSERT INTO banned_identities')) {
    if (dbError) throw new Error('relation "banned_identities" does not exist');
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

// ── App under test ─────────────────────────────────────────────────────────
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

// Reads the body exactly once and hands back both, so an assertion message can
// print it without consuming it.
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
// 1. Ban-evasion tombstones
// ===========================================================================

test('deleting a BANNED account leaves a tombstone; deleting a clean account leaves nothing', async () => {
  // The evasion: banned, delete (allowed, and it must stay allowed), sign up
  // again five minutes later on the same email and get a clean row. Nothing
  // outlived the DELETE, so every ban was self-serve reversible.
  const res = await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assertModelled();
  assert.deepStrictEqual(deletedUserIds, [3], 'the account itself must really be deleted');
  assert.strictEqual(tombstones.length, 1);

  // And the identity is now recognised at signup.
  assert.strictEqual(await isIdentityBanned({ email: 'Mal.lory+spam@gmail.com' }), true);

  // A user who was never banned is not fingerprinted at all.
  reset();
  const clean = await call('DELETE', '/api/users/me', tokenFor(1), { password: PASSWORD });
  assert.strictEqual(clean.status, 200, clean.text);
  assert.deepStrictEqual(tombstones, [], 'a non-banned deletion must record nothing');
});

test('the tombstone holds no plaintext of anything, and no name or user id', async () => {
  // This is a record about a 15-to-22-year-old that outlives the account they
  // asked us to erase. If it ever holds a readable email or phone number it
  // becomes the single most sensitive table in the product.
  await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });
  const row = tombstones[0];
  const blob = JSON.stringify(row).toLowerCase();
  for (const secret of ['mal.lory', 'mallory', 'gmail.com', '2025550177', '555', '@']) {
    assert.ok(!blob.includes(secret), `tombstone leaked ${secret}: ${blob}`);
  }
  assert.strictEqual(row.email_hash.length, 64);
  assert.strictEqual(row.phone_hash.length, 64);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'user_id'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'name'), false);
});

test('the digests are KEYED, so a database dump alone cannot be tested against a guess', () => {
  // A phone number is ten digits. An unkeyed SHA-256 of one is reversible with
  // a laptop and an afternoon, which is exactly why this is an HMAC and why the
  // key lives in the environment and not in the row.
  const a = identityDigests({ phone: '202-555-0177' });
  const prev = process.env.BAN_TOMBSTONE_SECRET;
  process.env.BAN_TOMBSTONE_SECRET = 'a-different-pepper';
  const b = identityDigests({ phone: '202-555-0177' });
  if (prev === undefined) delete process.env.BAN_TOMBSTONE_SECRET; else process.env.BAN_TOMBSTONE_SECRET = prev;

  assert.notStrictEqual(a.phoneHash, b.phoneHash, 'digest must depend on the pepper');
  const unkeyed = crypto.createHash('sha256').update('2025550177').digest('hex');
  assert.notStrictEqual(a.phoneHash, unkeyed, 'must not be a bare hash of the number');
});

test('an email digest can never be matched against a phone digest', () => {
  // Without the kind prefix in the HMAC input, a value that appears as both
  // (an all-digits "email", a phone typed into the email box) would
  // cross-match and ban an unrelated identity.
  const d = identityDigests({ email: 'x@example.com', phone: '2025550101', oauthProvider: 'apple', oauthId: 'x@example.com' });
  assert.notStrictEqual(d.emailHash, d.oauthHash);
  assert.notStrictEqual(d.emailHash, d.phoneHash);
  assert.notStrictEqual(d.phoneHash, d.oauthHash);
});

test('re-signup is caught through the variants a returning user would actually use', async () => {
  // Gmail dots and +tags are free aliases of the same mailbox, and the phone
  // column is free-form text. Fingerprinting the literal string would be
  // defeated by retyping the number with dashes.
  await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });

  assert.strictEqual(await isIdentityBanned({ email: 'mallory@gmail.com' }), true, 'gmail dots/+tag alias');
  assert.strictEqual(await isIdentityBanned({ email: 'MALLORY@googlemail.com' }), true, 'googlemail alias');
  assert.strictEqual(await isIdentityBanned({ phone: '+1 202 555 0177' }), true, 'reformatted number');
  assert.strictEqual(await isIdentityBanned({ phone: '2025550177' }), true, 'bare digits');

  // Not a dragnet: unrelated people must sign up normally.
  assert.strictEqual(await isIdentityBanned({ email: 'someone.else@gmail.com' }), false);
  assert.strictEqual(await isIdentityBanned({ phone: '202-555-0144' }), false);
  assert.strictEqual(await isIdentityBanned({}), false);
  assert.strictEqual(await isIdentityBanned(null), false);
  assert.strictEqual(await isIdentityBanned({ email: '', phone: null }), false);
});

test('an OAuth identity is tombstoned by provider subject, which survives an email change', async () => {
  // Apple private-relay addresses rotate and a Google address can be changed at
  // the provider, so an email-only tombstone would be trivially shed. The `sub`
  // does not change.
  const stale = await call('DELETE', '/api/users/me', tokenFor(4, { ageSeconds: 3600 }));
  assert.strictEqual(stale.status, 401, 'stale OAuth session must be re-proven first');

  const fresh = await call('DELETE', '/api/users/me', tokenFor(4, { ageSeconds: 5 }));
  assert.strictEqual(fresh.status, 200, fresh.text);
  assert.strictEqual(await isIdentityBanned({ oauthProvider: 'apple', oauthId: 'apple-sub-4' }), true);
  assert.strictEqual(await isIdentityBanned({ email: 'brand-new-relay@privaterelay.appleid.com' }), false);
});

test('the retention window is real: the lookup filters on it and the row carries an expiry', async () => {
  // A tombstone about a minor that never expires is not defensible. Retention
  // is enforced on the READ path so an unpurged row stops mattering the moment
  // it expires.
  await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });
  const row = tombstones[0];
  const days = Math.round((row.expires_at - Date.now()) / 86400000);
  assert.strictEqual(days, BAN_TOMBSTONE_RETENTION_DAYS);
  assert.strictEqual(BAN_TOMBSTONE_RETENTION_DAYS, 365);

  await isIdentityBanned({ email: 'mallory@gmail.com' });
  const lookupSql = sql.find((s) => s.includes('SELECT 1 FROM banned_identities'));
  assert.ok(/expires_at\s*>\s*NOW\(\)/.test(lookupSql), 'lookup must exclude expired tombstones');

  // Expired rows have no effect even though they are still on disk.
  row.expires_at = new Date(Date.now() - 1000);
  assert.strictEqual(await isIdentityBanned({ email: 'mallory@gmail.com' }), false);
});

test('expired tombstones are actually deleted, not just ignored', async () => {
  // The migration promises the fingerprint is gone after twelve months. If the
  // only thing that expires is its EFFECT, that promise is false the first time
  // anyone reads the table, and there is no scheduler in this app to run a
  // purge. Signups drive it instead, at most once an hour per process.
  await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });
  tombstones[0].expires_at = new Date(Date.now() - 1000);

  usersRouter.__testing.resetPurgeClock();
  await isIdentityBanned({ email: 'someone@example.com' });
  assert.deepStrictEqual(tombstones, [], 'expired row must be removed from the table');

  // And it cannot run on every signup: that would be a DELETE per account
  // creation forever.
  assert.strictEqual(usersRouter.__testing.maybePurgeExpired(), false, 'purge must be rate limited');
  usersRouter.__testing.resetPurgeClock();
  assert.strictEqual(usersRouter.__testing.maybePurgeExpired(), true);
});

test('a broken tombstone table fails OPEN, so it can never take signup down', async () => {
  // This lookup sits in front of every account creation in the product. Failing
  // closed would turn one bad query into "nobody can sign up", which is far
  // worse than a banned user getting back in during an outage.
  dbError = true;
  assert.strictEqual(await isIdentityBanned({ email: 'mallory@gmail.com' }), false);
});

test('a tombstone that cannot be written fails the DELETION, not silently', async () => {
  // The opposite trade from the lookup: if the record of the ban cannot land,
  // the account must not vanish anyway. The client is told to retry, which is
  // the same contract the moderation-evidence de-attribution already has.
  dbError = true;
  const res = await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });
  assert.strictEqual(res.status, 503, res.text);
  assert.deepStrictEqual(deletedUserIds, [], 'the banned account must still be there to retry');
  assert.ok(ranSql('ROLLBACK'));

  // A NON-banned deletion never touches that table, so it cannot be affected.
  reset();
  dbError = true;
  const clean = await call('DELETE', '/api/users/me', tokenFor(1), { password: PASSWORD });
  assert.strictEqual(clean.status, 200, clean.text);
  assert.deepStrictEqual(deletedUserIds, [1]);
});

test('rejectIfBannedIdentity is the one-liner routes/auth.js calls, and it says nothing useful', async () => {
  // The rejection must not become an oracle: "is this phone number banned?" is
  // a question an attacker should not be able to ask about someone else.
  await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });

  const sent = [];
  const res = { status(c) { sent.push(c); return this; }, json(b) { sent.push(b); return this; } };
  assert.strictEqual(await rejectIfBannedIdentity(res, { email: 'mallory@gmail.com' }), true);
  assert.strictEqual(sent[0], 403);
  const message = sent[1].error;
  for (const leak of ['email', 'phone', 'banned', 'suspended']) {
    assert.ok(!message.toLowerCase().includes(leak), `rejection message leaks "${leak}": ${message}`);
  }

  const clean = { status() { return this; }, json() { return this; } };
  assert.strictEqual(await rejectIfBannedIdentity(clean, { email: 'nobody@example.com' }), false);
});

// ===========================================================================
// 2. Re-authentication on DELETE /api/users/me
// ===========================================================================

test('a stolen token alone can no longer destroy a password account', async () => {
  // The whole finding: 24h token, one DELETE, account and every flock the user
  // created are gone forever and the Apple grant is revoked. No proof of
  // anything beyond possession of the token was required.
  const res = await call('DELETE', '/api/users/me', tokenFor(1));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.reauthRequired, 'password');
  assert.deepStrictEqual(deletedUserIds, []);
  assert.ok(!ranSql('DELETE FROM users'), 'nothing may be deleted');
  assert.ok(!ranSql('BEGIN'), 'the deletion transaction must not even open');
  assertModelled();
});

test('a wrong password is refused, and a non-string one cannot slip past bcrypt', async () => {
  // bcrypt.compare('', hash) is false, but a `password` of the wrong TYPE must
  // not slip past the check either (a JSON body is attacker-controlled).
  for (const password of ['nope', '', null, 12345, { toString: () => PASSWORD }, ['x'], true]) {
    reset();
    const res = await call('DELETE', '/api/users/me', tokenFor(1), { password });
    assert.strictEqual(res.status, 401, `password ${JSON.stringify(password)} was accepted`);
    assert.deepStrictEqual(deletedUserIds, []);
  }
});

test('the deletion password prompt is not an unlimited guessing oracle', async () => {
  // Asking for a password creates somewhere to guess one. The API limiter is
  // 300/15min PER IP, which is no limit at all for someone with a stolen token
  // and a few cloud addresses, and every guess costs a bcrypt round of CPU.
  for (let i = 0; i < 5; i += 1) {
    const res = await call('DELETE', '/api/users/me', tokenFor(1), { password: `guess-${i}` });
    assert.strictEqual(res.status, 401, `attempt ${i} should still be a plain refusal`);
  }
  const locked = await call('DELETE', '/api/users/me', tokenFor(1), { password: 'guess-6' });
  assert.strictEqual(locked.status, 429, locked.text);

  // The lock is per account, so one victim cannot be used to lock out another.
  const other = await call('DELETE', '/api/users/me', tokenFor(5), { password: 'guess' });
  assert.strictEqual(other.status, 401);

  // And it must not brick a real deletion forever: the right password clears it
  // once the window passes. (Verified through the limiter rather than a sleep.)
  proofFailures.clear(1);
  const real = await call('DELETE', '/api/users/me', tokenFor(1), { password: PASSWORD });
  assert.strictEqual(real.status, 200, real.text);
  assert.deepStrictEqual(deletedUserIds, [1]);
});

test('an absent password does not burn an attempt', async () => {
  // The shipped client sends no body at all. If that counted as a guess, the
  // first five taps of "Delete account" would lock the user out of the flow
  // before their app had even prompted them for a password.
  for (let i = 0; i < 8; i += 1) {
    const res = await call('DELETE', '/api/users/me', tokenFor(1));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.reauthRequired, 'password');
  }
  const real = await call('DELETE', '/api/users/me', tokenFor(1), { password: PASSWORD });
  assert.strictEqual(real.status, 200, real.text);
});

test('the profile password check is bounded the same way', async () => {
  // Same oracle, older endpoint: PUT /profile has always taken a current
  // password and has never counted the wrong ones.
  for (let i = 0; i < 5; i += 1) {
    const res = await call('PUT', '/api/users/profile', tokenFor(1), { name: 'x', current_password: `guess-${i}` });
    assert.strictEqual(res.status, 401);
  }
  const locked = await call('PUT', '/api/users/profile', tokenFor(1), { name: 'x', current_password: 'guess-6' });
  assert.strictEqual(locked.status, 429, locked.text);
});

test('phone changes are metered, so the uniqueness check is not a phone-book oracle', async () => {
  // The 409 answers "is this number registered with Flock?". Contact sync is
  // metered for exactly that reason; this must not be the cheap way around it.
  for (let i = 0; i < 5; i += 1) {
    const res = await call('PUT', '/api/users/profile', tokenFor(1), {
      phone: `+1202555${String(1000 + i).slice(0, 4)}`, current_password: PASSWORD,
    });
    assert.ok(res.status === 200 || res.status === 409, `unexpected ${res.status}: ${res.text}`);
  }
  const locked = await call('PUT', '/api/users/profile', tokenFor(1), {
    phone: '+12025550188', current_password: PASSWORD,
  });
  assert.strictEqual(locked.status, 429, locked.text);

  // Editing anything else is unaffected.
  const name = await call('PUT', '/api/users/profile', tokenFor(1), { name: 'Alice B', current_password: PASSWORD });
  assert.strictEqual(name.status, 200, name.text);
});

test('deletion still WORKS with the password, which is what Apple 5.1.1(v) requires', async () => {
  // The failure mode of this fix is an app that can no longer delete accounts,
  // which is a rejection. Typing the password must complete the deletion.
  const res = await call('DELETE', '/api/users/me', tokenFor(1), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { message: 'Account deleted' });
  assert.deepStrictEqual(deletedUserIds, [1]);
  assertModelled();
});

test('an OAuth account needs a session minted minutes ago, not a day-old token', async () => {
  // OAuth accounts have no password, so "retype it" is not available. The
  // equivalent proof is a token that only an actual provider sign-in could have
  // produced just now. The realistic theft is an hours-old token.
  const stale = await call('DELETE', '/api/users/me', tokenFor(2, { ageSeconds: 3600 }));
  assert.strictEqual(stale.status, 401);
  assert.strictEqual(stale.body.reauthRequired, 'reauth');
  assert.deepStrictEqual(deletedUserIds, []);

  const justOutside = await call('DELETE', '/api/users/me', tokenFor(2, { ageSeconds: REAUTH_WINDOW_MS / 1000 + 30 }));
  assert.strictEqual(justOutside.status, 401);

  const fresh = await call('DELETE', '/api/users/me', tokenFor(2, { ageSeconds: 10 }));
  assert.strictEqual(fresh.status, 200, fresh.text);
  assert.deepStrictEqual(deletedUserIds, [2]);
});

test('an OAuth account cannot buy itself deletion by sending a password', async () => {
  // The password branch is chosen by the STORED credential, never by what the
  // request contains, so "password: anything" on a passwordless row must not
  // become an alternative route around the freshness requirement.
  const res = await call('DELETE', '/api/users/me', tokenFor(2, { ageSeconds: 3600 }), { password: PASSWORD });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.reauthRequired, 'reauth');
  assert.deepStrictEqual(deletedUserIds, []);
});

test('freshness is read from a VERIFIED token, so `iat` cannot be forged', () => {
  // If this decoded instead of verified, an attacker holding any stolen token
  // could re-sign it with alg:none or a junk key and set iat to now.
  const forged = jwt.sign({ userId: 2, tv: 0, iat: Math.floor(Date.now() / 1000) }, 'not-the-real-secret');
  assert.strictEqual(hasFreshSession({ headers: { authorization: `Bearer ${forged}` } }), false);

  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ userId: 2, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}.`;
  assert.strictEqual(hasFreshSession({ headers: { authorization: `Bearer ${none}` } }), false, 'alg:none');

  assert.strictEqual(hasFreshSession({ headers: { authorization: 'Bearer nonsense' } }), false);
  assert.strictEqual(hasFreshSession({ headers: {} }), false);
  assert.strictEqual(hasFreshSession({ headers: { authorization: 'Bearer ' } }), false);
  assert.strictEqual(hasFreshSession({}), false);
  assert.strictEqual(hasFreshSession(null), false);
  assert.strictEqual(hasFreshSession({ headers: { authorization: 'Basic abc' } }), false);

  // A token with no iat at all must not read as fresh (and must not read as
  // "issued at the epoch" either — both are failures, one is just louder).
  const noIat = jwt.sign({ userId: 2, tv: 0 }, process.env.JWT_SECRET, { noTimestamp: true });
  assert.strictEqual(hasFreshSession({ headers: { authorization: `Bearer ${noIat}` } }), false);

  // Clock skew the other way (token stamped slightly in the future) is not an attack.
  const skewed = jwt.sign({ userId: 2, tv: 0, iat: Math.floor(Date.now() / 1000) + 30 }, process.env.JWT_SECRET);
  assert.strictEqual(hasFreshSession({ headers: { authorization: `Bearer ${skewed}` } }), true);

  // An EXPIRED token is not fresh, whatever its iat says.
  const expired = jwt.sign({ userId: 2, tv: 0 }, process.env.JWT_SECRET, { expiresIn: -10 });
  assert.strictEqual(hasFreshSession({ headers: { authorization: `Bearer ${expired}` } }), false);
});

test('a BANNED user can still delete their account, proof and all', async () => {
  // Non-negotiable: the ban-tolerant route exists because Apple 5.1.1(v) and
  // GDPR do not pause while someone is suspended. The tombstone must not turn
  // into a reason deletion starts failing for exactly the accounts it covers.
  const res = await call('DELETE', '/api/users/me', tokenFor(3), { password: PASSWORD });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(deletedUserIds, [3]);

  reset();
  const oauthBanned = await call('DELETE', '/api/users/me', tokenFor(4, { ageSeconds: 5 }));
  assert.strictEqual(oauthBanned.status, 200, oauthBanned.text);
  assert.deepStrictEqual(deletedUserIds, [4]);
});

test('a rejected deletion never reaches the Apple revocation or the transaction', async () => {
  // Ordering matters: an unproven request must not be able to disconnect
  // someone's Sign in with Apple as a side effect of being refused.
  USERS[4].apple_refresh_token = 'refresh-token';
  const res = await call('DELETE', '/api/users/me', tokenFor(4, { ageSeconds: 7200 }));
  assert.strictEqual(res.status, 401);
  assert.ok(!ranSql('BEGIN'));
  assert.ok(!ranSql('UPDATE content_reports'));
  assert.strictEqual(tombstones.length, 0);
});

test('a token for an account that is already gone is refused before any of this', async () => {
  const token = tokenFor(1);
  delete USERS[1];
  const res = await call('DELETE', '/api/users/me', token);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'User no longer exists');
});

test('DELETE with no body at all is a clean 401, not a 500', async () => {
  // The shipped client sends no body today. That has to produce the "enter your
  // password" prompt, not an unhandled TypeError on req.body.
  const res = await call('DELETE', '/api/users/me', tokenFor(1));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.reauthRequired, 'password');
});

// ===========================================================================
// 3. PUT /api/users/profile — phone
// ===========================================================================

test('the phone field is validated the way signup validates it', async () => {
  // It had no validation at all: any string went straight into the column that
  // friend discovery resolves against, and it is displayed to other users.
  for (const phone of ['not a phone', 'https://evil.example', '<script>alert(1)</script>', '1', '000']) {
    reset();
    const res = await call('PUT', '/api/users/profile', tokenFor(1), { phone, current_password: PASSWORD });
    assert.strictEqual(res.status, 400, `accepted junk phone ${phone}`);
    assert.strictEqual(res.body.error, 'Invalid phone number');
    assert.ok(!ranSql('UPDATE users'));
  }
});

test('an over-long phone number is a 400, not a database 500', async () => {
  // users.phone is VARCHAR(20). A longer string used to reach Postgres and come
  // back as error 22001, i.e. a 500 on a user typo.
  const res = await call('PUT', '/api/users/profile', tokenFor(1), {
    phone: `+1202555${'1'.repeat(40)}`, current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 400);
  assert.ok(!ranSql('UPDATE users'), 'must not reach the database');
});

test('a non-string phone cannot bypass the validator', async () => {
  // express-validator sanitizers are string operations; an object or array in
  // the field is the classic way to walk past them.
  // `["+12025550122"]` is the dangerous one: express-validator runs the chain
  // per ELEMENT, every element passes isMobilePhone, and req.body.phone is
  // still an array afterwards, so pg writes the literal {"+12025550122"} into
  // a VARCHAR(20) column that find-by-phone still matches digit for digit.
  for (const phone of [{ toString: () => '+12025550122' }, ['+12025550122'], ['+12025550122', '+12025550133'], true]) {
    reset();
    const res = await call('PUT', '/api/users/profile', tokenFor(1), { phone, current_password: PASSWORD });
    assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(phone)}`);
    assert.ok(!ranSql('UPDATE users'));
  }

  // A JSON number is coerced to a string by the sanitizer before anything sees
  // it, so it is safe to accept — but it must never reach the column as a
  // number type.
  reset();
  const numeric = await call('PUT', '/api/users/profile', tokenFor(1), { phone: 12025550122, current_password: PASSWORD });
  assert.strictEqual(numeric.status, 200, numeric.text);
  assert.strictEqual(typeof USERS[1].phone, 'string');
});

test('the same array bypass is closed on the other string fields in this handler', async () => {
  // name and the password fields take the identical path. An array name is
  // stored as {"..."} and an array password makes bcrypt throw, which is a 500.
  for (const patch of [{ name: ['Alice'] }, { new_password: ['Passw0rdd'] }, { current_password: [PASSWORD] }, { email: ['a@b.com'] }]) {
    reset();
    const res = await call('PUT', '/api/users/profile', tokenFor(1), { current_password: PASSWORD, ...patch });
    assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(patch)}: ${res.text}`);
    assert.ok(!ranSql('UPDATE users'));
  }
});

test('an attacker cannot claim a number that already belongs to another account', async () => {
  // POST /api/friends/find-by-phone answers contact sync from this column, so
  // claiming the victim's number redirects their friend lookups at the
  // attacker. There is no SMS verification, so exclusivity is the strongest
  // guard available.
  const res = await call('PUT', '/api/users/profile', tokenFor(1), {
    phone: '+1 (202) 555-0199', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(USERS[5].phone, '202-555-0199', "the victim's number is untouched");
  assert.ok(!ranSql('UPDATE users'));
  assertModelled();
});

test('a real phone change still goes through, and reformatting your own number is free', async () => {
  // The fix must not make the profile form unusable.
  const res = await call('PUT', '/api/users/profile', tokenFor(1), {
    phone: '+12025550122', current_password: PASSWORD,
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(USERS[1].phone, '+12025550122');

  // Same digits, different punctuation: not a change, so no uniqueness probe
  // and no re-auth friction.
  reset();
  const same = await call('PUT', '/api/users/profile', tokenFor(1), {
    phone: '(202) 555-0101', current_password: PASSWORD,
  });
  assert.strictEqual(same.status, 200, same.text);
  assert.ok(!ranSql('RIGHT(REGEXP_REPLACE(phone'), 'unchanged number must not run the uniqueness probe');
});

test('a password account still cannot change its phone without the password', async () => {
  // The pre-existing gate has to keep holding: this is the "same proof as
  // changing a password" half of the finding.
  const res = await call('PUT', '/api/users/profile', tokenFor(1), { phone: '+12025550122' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(USERS[1].phone, '+12025550101');
  assert.ok(!ranSql('UPDATE users'));
});

test('an OAuth account cannot have its number rewritten by a stolen token', async () => {
  // Password accounts already had to prove themselves here (this handler
  // refuses every edit without the current password). OAuth accounts had NO
  // check whatsoever, so a lifted token could silently repoint a victim's
  // contact-sync hits.
  // Six refused attempts, because a refusal must not consume the account's
  // change quota: otherwise a stale stolen token locks the real owner out of
  // their own profile for an hour without ever passing the check.
  for (let i = 0; i < 6; i += 1) {
    const stale = await call('PUT', '/api/users/profile', tokenFor(2, { ageSeconds: 3600 }), { phone: '+12025550133' });
    assert.strictEqual(stale.status, 401, `attempt ${i}: ${stale.text}`);
    assert.strictEqual(stale.body.reauthRequired, 'reauth');
  }
  assert.strictEqual(USERS[2].phone, null);
  assert.ok(!ranSql('UPDATE users'));

  const fresh = await call('PUT', '/api/users/profile', tokenFor(2, { ageSeconds: 5 }), { phone: '+12025550133' });
  assert.strictEqual(fresh.status, 200, fresh.text);
  assert.strictEqual(USERS[2].phone, '+12025550133');
});

test('an OAuth account can still edit everything else with an ordinary session', async () => {
  // The re-auth is scoped to the phone number. Requiring a fresh sign-in to
  // change a display name would be a real usability regression.
  const res = await call('PUT', '/api/users/profile', tokenFor(2, { ageSeconds: 3600 }), { name: 'Bobby' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(USERS[2].name, 'Bobby');
});

test('an empty phone field in a submitted profile form is still accepted', async () => {
  // Clients post the whole form. An empty phone input was a no-op before this
  // round (COALESCE keeps the stored value) and must not start 400ing.
  for (const phone of ['', null, undefined, '   ']) {
    reset();
    const res = await call('PUT', '/api/users/profile', tokenFor(1), { phone, current_password: PASSWORD });
    assert.strictEqual(res.status, 200, `phone ${JSON.stringify(phone)} broke the profile form: ${res.text}`);
    assert.strictEqual(USERS[1].phone, '+12025550101', 'stored number unchanged');
  }
});

test('every new refusal message follows the copy standard', async () => {
  // SLOP-AUDIT rule 1: no em dashes in user-visible text. These strings are all
  // shown verbatim in the app, and a security round is exactly when copy rules
  // get forgotten.
  const messages = [];
  const collect = async (fn) => { const r = await fn(); if (r.body?.error) messages.push(r.body.error); };

  await collect(() => call('DELETE', '/api/users/me', tokenFor(1)));
  await collect(() => call('DELETE', '/api/users/me', tokenFor(2, { ageSeconds: 3600 })));
  await collect(() => call('PUT', '/api/users/profile', tokenFor(1), { phone: 'junk', current_password: PASSWORD }));
  await collect(() => call('PUT', '/api/users/profile', tokenFor(1), { phone: ['+12025550122'], current_password: PASSWORD }));
  await collect(() => call('PUT', '/api/users/profile', tokenFor(1), { phone: '202-555-0199', current_password: PASSWORD }));
  await collect(() => call('PUT', '/api/users/profile', tokenFor(2, { ageSeconds: 3600 }), { phone: '+12025550133' }));
  messages.push(usersRouter.__testing.BANNED_IDENTITY_MESSAGE);

  assert.ok(messages.length >= 6, `expected to collect the refusals, got ${JSON.stringify(messages)}`);
  for (const m of messages) {
    assert.ok(!m.includes('—') && !m.includes('–'), `dash in user-visible copy: ${m}`);
    assert.ok(/[.!]$/.test(m.trim()) || m.split(' ').length <= 4, `not a sentence: ${m}`);
  }
});

test('canonicalPhone matches what find-by-phone actually compares', () => {
  // If these two ever drift, a tombstone or a uniqueness check silently stops
  // covering the numbers discovery can still resolve.
  assert.strictEqual(canonicalPhone('+1 (202) 555-0177'), '2025550177');
  assert.strictEqual(canonicalPhone('2025550177'), '2025550177');
  assert.strictEqual(canonicalPhone('+44 20 7946 0958'), '2079460958');
  assert.strictEqual(canonicalPhone('123456'), '', 'too short to be a lookup key');
  assert.strictEqual(canonicalPhone(''), '');
  assert.strictEqual(canonicalPhone(null), '');
  assert.strictEqual(canonicalPhone({}), '');
});
