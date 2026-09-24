'use strict';
// ---------------------------------------------------------------------------
// THE UNMETERED FIRST WEEK IS ONCE PER IDENTITY, AND ONLY FOR A PROVED ADDRESS.
//
// services/entitlements.js gives an account younger than NEW_ACCOUNT_GRACE_DAYS
// the limits Pro has. An adversarial pass on 2026-09-24 showed two ways to keep
// that week forever: delete the account and sign straight back up on the same
// address (a fresh created_at, and the old month's usage_meters rows gone with
// the old row), or never confirm the address at all. Migration 076 and the
// signup/deletion paths close both, and this suite walks the real routes
// (signup, DELETE /api/users/me) against a real migrated Postgres to prove it:
//
//   * an unverified account has no first week;
//   * a deleted account leaves keyed one-way digests of what it PROVED, and a
//     new account on that address, or on that Apple/Google identity, is created
//     with grace_forfeited set;
//   * an address a squatter only typed leaves no mark on its real owner;
//   * the digests hold no plaintext, are not the ban tombstone's values, and
//     expire.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('graceIdentity');
const DB_NAME = 'flock_grace_identity_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-grace-identity-suite';
delete process.env.BAN_TOMBSTONE_SECRET;
delete process.env.RESEND_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;
process.env.PAYWALL_ENABLED = 'true';

let pg;
let pool;
let dataDir;
let server;
let base;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-grace-identity-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'graceIdentity', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const PASSWORD = 'Gr4ceWeekPass';
const signup = (email) => call('POST', '/api/auth/signup', {
  body: { email, password: PASSWORD, name: 'Pat', date_of_birth: '2000-01-01' },
});

// What clicking the emailed link records: the address it proved.
const verify = (id) => pool.query(
  'UPDATE users SET email_verified = TRUE, verified_email = email WHERE id = $1', [id]
);

const graceOf = async (id) => require('../services/entitlements').getPremiumState(id);

const identityRows = async () => (await pool.query('SELECT * FROM grace_spent_identities')).rows;

test('an address that was never confirmed has no first week, and gets it once confirmed', async () => {
  const s = await signup('fresh.confirm@example.com');
  assert.strictEqual(s.status, 201, s.text);
  const before = await graceOf(s.body.user.id);
  assert.strictEqual(before.known, true);
  assert.strictEqual(before.inGrace, false, 'an unconfirmed throwaway address got the free week');
  assert.strictEqual(before.graceEndsAt, null);
  await verify(s.body.user.id);
  const after = await graceOf(s.body.user.id);
  assert.strictEqual(after.inGrace, true, 'a confirmed first account should have its week');
  assert.ok(Date.parse(after.graceEndsAt) > Date.now());
});

test('deleting the account and signing up again on the same address does not bring the week back', async () => {
  const first = await signup('pat.returns@gmail.com');
  assert.strictEqual(first.status, 201, first.text);
  const oldId = first.body.user.id;
  await verify(oldId);
  await pool.query("UPDATE users SET created_at = created_at - INTERVAL '40 days' WHERE id = $1", [oldId]);

  const del = await call('DELETE', '/api/users/me', { token: first.body.token, body: { password: PASSWORD } });
  assert.strictEqual(del.status, 200, del.text);
  const rows = await identityRows();
  assert.strictEqual(rows.length, 1, 'the deletion left no record of the identity it proved');
  for (const [col, v] of Object.entries(rows[0])) {
    assert.ok(!String(v).includes('@') && !/pat/i.test(String(v)), `plaintext in ${col}`);
  }

  // Back on a Gmail dot variant of the same mailbox, and confirmed again.
  const again = await signup('patreturns@gmail.com');
  assert.strictEqual(again.status, 201, again.text);
  const newId = again.body.user.id;
  await verify(newId);
  const state = await graceOf(newId);
  assert.strictEqual(state.inGrace, false, 'the week came back after delete and re-signup');
  assert.strictEqual(state.graceEndsAt, null);
  const { rows: [u] } = await pool.query('SELECT grace_forfeited FROM users WHERE id = $1', [newId]);
  assert.strictEqual(u.grace_forfeited, true);
  // Nothing was refused and nothing was said: the account exists and signs in.
  assert.ok(again.body.token);
});

test('an Apple or Google identity that had an account forfeits the week under any address', async () => {
  const users = require('../routes/users');
  assert.strictEqual(await users.recordGraceSpentIdentity({
    email: 'someone@gmail.com', email_verified: true, verified_email: 'someone@gmail.com',
    oauth_provider: 'google', oauth_id: 'google-sub-123',
  }), true);
  const { rows: [nu] } = await pool.query(
    "INSERT INTO users (email, password, name, email_verified, verified_email) VALUES ('new.addr@example.com', 'x', 'N', TRUE, 'new.addr@example.com') RETURNING id"
  );
  assert.strictEqual(await users.forfeitGraceIfReturning(nu.id, {
    email: 'new.addr@example.com', oauthProvider: 'google', oauthId: 'google-sub-123',
  }), true);
  assert.strictEqual((await graceOf(nu.id)).inGrace, false);

  // The same subject at a different provider is a different identity.
  const { rows: [other] } = await pool.query(
    "INSERT INTO users (email, password, name, email_verified, verified_email) VALUES ('apple.person@example.com', 'x', 'A', TRUE, 'apple.person@example.com') RETURNING id"
  );
  assert.strictEqual(await users.forfeitGraceIfReturning(other.id, {
    email: 'apple.person@example.com', oauthProvider: 'apple', oauthId: 'google-sub-123',
  }), false);
  assert.strictEqual((await graceOf(other.id)).inGrace, true);
});

test('an address a squatter only typed leaves no mark on its real owner', async () => {
  const users = require('../routes/users');
  const before = (await identityRows()).length;
  assert.strictEqual(await users.recordGraceSpentIdentity({
    email: 'victim.owner@example.com', email_verified: false, verified_email: null,
  }), false, 'an unproved address was recorded');
  assert.strictEqual((await identityRows()).length, before);

  const s = await signup('victim.owner@example.com');
  assert.strictEqual(s.status, 201, s.text);
  await verify(s.body.user.id);
  assert.strictEqual((await graceOf(s.body.user.id)).inGrace, true);
});

test('the digests are keyed, namespaced apart from the ban tombstone, and expire', async () => {
  const users = require('../routes/users');
  const address = 'keyed.check@example.com';
  await pool.query('DELETE FROM grace_spent_identities WHERE id > 0');
  assert.strictEqual(await users.recordGraceSpentIdentity({ email: address, email_verified: true, verified_email: address }), true);
  const [row] = await identityRows();
  const pepper = process.env.JWT_SECRET;
  const plain = crypto.createHash('sha256').update(address).digest('hex');
  const banValue = crypto.createHmac('sha256', pepper).update(`email:${address}`).digest('hex');
  assert.notStrictEqual(row.email_hash, plain, 'an unkeyed hash of an address is reversible');
  assert.notStrictEqual(row.email_hash, banValue, 'shares a value with banned_identities');
  assert.strictEqual(row.oauth_hash, null);
  assert.ok(Date.parse(row.expires_at) > Date.now() + 360 * 864e5, 'kept for less than the 12 months the policy states');

  // An expired record matches nothing, whether or not the purge has run.
  await pool.query("UPDATE grace_spent_identities SET expires_at = NOW() - INTERVAL '1 day'");
  const { rows: [nu] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, verified_email) VALUES ($1, 'x', 'K', TRUE, $1) RETURNING id`,
    [address]
  );
  assert.strictEqual(await users.forfeitGraceIfReturning(nu.id, { email: address }), false);
  assert.strictEqual(await users.purgeExpiredGraceIdentities(), 1);
  assert.deepStrictEqual(await identityRows(), []);
});
