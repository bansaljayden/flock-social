'use strict';
// ---------------------------------------------------------------------------
// THE ROOST NOTICE, against a real migrated Postgres (Terms 9.6, migration
// 077, services/roostNotice.js).
//
// The promise under test: a venue account created before Roost had a price is
// emailed once, keeps everything it has today until the date that email named
// (and for as long as no email has gone out), and cannot be charged before that
// date. A venue created after the price took effect gets none of this. Nothing
// sends while VENUE_BILLING_ENABLED is off.
//
// Email is a stand-in installed before any module captures sendEmail. It asks
// the REAL suppression module whether the address may be mailed in the
// category it was handed, so the category the notice uses is tested, not
// assumed.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

// ---- the email stand-in ----------------------------------------------------
const sent = [];
let sendMode = 'ok'; // 'ok' | 'fail'
const emailService = require('../services/emailService');
const suppression = require('../services/emailSuppression');
emailService.sendEmail = async ({ to, category, subject, text }) => {
  const allowed = await suppression.checkSendAllowed(to, category);
  if (allowed.blocked) return { sent: false, suppressed: true, reason: allowed.reason, refused: true };
  if (sendMode === 'fail') return { sent: false, error: 'provider said no', refused: true };
  sent.push({ to, category, subject, text });
  return { sent: true };
};

const PG_PORT = pickEmbeddedPgPort('roostNotice');
let pg;
let testPool;
let dataDir;
const appPool = require('../config/database');
const realQuery = appPool.query;

const ENV = { VENUE_BILLING_ENABLED: 'true', ADMIN_USER_IDS: '1', DIGEST_ENABLED: undefined };
const savedEnv = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const roostNotice = require('../services/roostNotice');
const venueEntitlements = require('../services/venueEntitlements');
const { getVenueEntitlement, ROOST_PRICED_FROM, ROOST_NOTICE_DAYS } = venueEntitlements;
const venueDigest = require('../services/venueDigest');
const venueDashboardRoutes = require('../routes/venueDashboard');
const { ROOST_MONTHLY_USD, ROOST_YEARLY_USD, ROOST_TRIAL_DAYS } = require('../templates/roostNoticeEmail');

test.before(async () => {
  setEnv(ENV);
  dataDir = path.join(os.tmpdir(), `flock-roostnotice-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'roostNotice', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_roostnotice_test');
  testPool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_roostnotice_test` });
  const { migrate } = require('../db/migrate');
  await migrate(testPool);
  appPool.query = (text, params) => testPool.query(text, params);
});

test.after(async () => {
  appPool.query = realQuery;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await testPool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test.beforeEach(async () => {
  sent.length = 0;
  sendMode = 'ok';
  setEnv(ENV);
  // Each test starts with no venues, so a sweep only ever sees its own.
  await testPool.query('DELETE FROM venue_roost_notices WHERE user_id > 0');
  await testPool.query('DELETE FROM venue_promotions WHERE id > 0');
  await testPool.query('DELETE FROM venue_profiles WHERE id > 0');
});

const BEFORE = '2026-09-01T12:00:00Z'; // an account from before Roost had a price
const AFTER = '2026-10-01T12:00:00Z';  // one created under the priced Terms
let n = 0;
async function venue({ createdAt = BEFORE, emailVerified = true, banned = false, name = 'The Owl', placeId = null, tier = 'free' } = {}) {
  n += 1;
  const u = await testPool.query(
    `INSERT INTO users (email, password, name, role, email_verified, is_banned)
     VALUES ($1, 'x', 'Owner', 'venue_owner', $2, $3) RETURNING id, email`,
    [`roost-owner${n}@example.com`, emailVerified, banned]
  );
  const id = u.rows[0].id;
  await testPool.query(
    `INSERT INTO venue_profiles (user_id, business_name, verified, tier, created_at, google_place_id)
     VALUES ($1, $2, true, $3, $4::timestamptz, $5)`,
    [id, name, tier, createdAt, placeId]
  );
  return { id, email: u.rows[0].email };
}

async function noticeRow(userId) {
  const r = await testPool.query('SELECT emailed_at, charge_not_before FROM venue_roost_notices WHERE user_id = $1', [userId]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------

test('with venue billing off, the sweep reads nothing and sends nothing', async () => {
  setEnv({ VENUE_BILLING_ENABLED: undefined });
  const v = await venue();
  const tally = await roostNotice.runRoostNoticeSweep();
  assert.deepStrictEqual(tally, { due: 0, sent: 0, failed: 0, skipped: 0 });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(await noticeRow(v.id), null);
});

test('a venue from before the price gets exactly one notice, naming a date 30 days out', async () => {
  const v = await venue({ name: 'The Owl' });
  const now = new Date();
  const first = await roostNotice.runRoostNoticeSweep(now);
  assert.strictEqual(first.sent, 1);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, v.email);
  assert.strictEqual(sent[0].category, 'transactional', 'notice about the venue\'s own account, not a marketing mailing');
  const row = await noticeRow(v.id);
  assert.ok(row, 'the notice was recorded');
  assert.strictEqual(new Date(row.charge_not_before).getTime() - new Date(row.emailed_at).getTime(), ROOST_NOTICE_DAYS * 864e5);
  // The date in the email is the date stored.
  const named = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(row.charge_not_before));
  assert.ok(sent[0].subject.includes(named), sent[0].subject);
  assert.ok(sent[0].text.includes(`Until ${named}, your venue keeps everything it has today and nothing is charged.`));
  assert.ok(sent[0].text.includes('Hi The Owl,'));

  const second = await roostNotice.runRoostNoticeSweep(new Date(now.getTime() + 864e5));
  assert.strictEqual(second.due, 0, 'a venue with a notice is not due again');
  assert.strictEqual(sent.length, 1, 'one notice per venue account, ever');
});

test('a venue created after the price took effect gets no notice and no window', async () => {
  const v = await venue({ createdAt: AFTER });
  await roostNotice.runRoostNoticeSweep();
  assert.strictEqual(sent.length, 0);
  const ent = await getVenueEntitlement(v.id);
  assert.strictEqual(ent.legacy, false);
  assert.strictEqual(ent.inNoticeWindow, false);
  assert.strictEqual(ent.tier, 'free', 'ordinary enforcement from the start');
});

test('a bounced address is not mailed and gets no row, and the venue stays in its window', async () => {
  const v = await venue();
  await testPool.query("INSERT INTO email_suppressions (email, reason) VALUES ($1, 'bounce')", [v.email]);
  const tally = await roostNotice.runRoostNoticeSweep();
  assert.strictEqual(tally.sent, 0);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(await noticeRow(v.id), null);
  const ent = await getVenueEntitlement(v.id);
  assert.strictEqual(ent.inNoticeWindow, true);
  assert.strictEqual(ent.noticeUntil, null, 'no email, so the window has no end yet');
  assert.strictEqual(ent.tier, 'pro', 'it keeps everything it has today');
});

test('an unsubscribe from marketing does not stop a notice about the venue\'s own account', async () => {
  const v = await venue();
  await testPool.query("INSERT INTO email_suppressions (email, reason) VALUES ($1, 'unsubscribe')", [v.email]);
  await roostNotice.runRoostNoticeSweep();
  assert.strictEqual(sent.length, 1);
  assert.ok(await noticeRow(v.id));
});

test('an unverified owner address, or a banned owner, is not mailed', async () => {
  const unverified = await venue({ emailVerified: false });
  const banned = await venue({ banned: true });
  await roostNotice.runRoostNoticeSweep();
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(await noticeRow(unverified.id), null);
  assert.strictEqual(await noticeRow(banned.id), null);
  assert.strictEqual((await getVenueEntitlement(unverified.id)).tier, 'pro', 'unreached, so nothing changes for it');
});

test('a send that fails writes no row, and the next run sends it', async () => {
  const v = await venue();
  sendMode = 'fail';
  const failed = await roostNotice.runRoostNoticeSweep();
  assert.strictEqual(failed.sent, 0);
  assert.strictEqual(await noticeRow(v.id), null, 'a failed send never starts the 30 days');
  sendMode = 'ok';
  const retried = await roostNotice.runRoostNoticeSweep();
  assert.strictEqual(retried.sent, 1);
  assert.ok(await noticeRow(v.id));
});

test('the window: everything until the named date, ordinary enforcement after it', async () => {
  const v = await venue();
  await roostNotice.runRoostNoticeSweep();
  const inside = await getVenueEntitlement(v.id);
  assert.strictEqual(inside.inNoticeWindow, true);
  assert.strictEqual(inside.tier, 'pro');
  assert.strictEqual(inside.paidTier, 'free', 'nothing is held by grant, so checkout stays open to it');
  assert.ok(inside.noticeUntil && Date.parse(inside.noticeUntil) > Date.now());

  await testPool.query(
    "UPDATE venue_roost_notices SET emailed_at = NOW() - INTERVAL '31 days', charge_not_before = NOW() - INTERVAL '1 day' WHERE user_id = $1",
    [v.id]
  );
  const after = await getVenueEntitlement(v.id);
  assert.strictEqual(after.inNoticeWindow, false);
  assert.strictEqual(after.tier, 'free');
});

test('with venue billing off, the window changes nothing: every venue acts Pro', async () => {
  setEnv({ VENUE_BILLING_ENABLED: undefined });
  const v = await venue({ createdAt: AFTER });
  const ent = await getVenueEntitlement(v.id);
  assert.strictEqual(ent.tier, 'pro');
  assert.strictEqual(ent.inNoticeWindow, false);
});

test('a checkout-time notice records once, and a racing sweep does not mail twice', async () => {
  const v = await venue();
  const named = await roostNotice.sendNoticeForCheckout(v.id);
  assert.ok(named instanceof Date);
  assert.strictEqual(sent.length, 1);
  await roostNotice.runRoostNoticeSweep();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(new Date((await noticeRow(v.id)).charge_not_before).getTime(), named.getTime());
});

test('public deals keep serving for a venue inside its window, and stop after it', async () => {
  const placeId = 'ChIJroostNoticeTest0001';
  const v = await venue({ placeId });
  await testPool.query(
    "INSERT INTO venue_promotions (venue_user_id, google_place_id, title, active) VALUES ($1, $2, 'Half price Tuesdays', true)",
    [v.id, placeId]
  );
  const reader = await testPool.query(
    "INSERT INTO users (email, password, name, email_verified) VALUES ('roost-reader@example.com', 'x', 'Reader', true) ON CONFLICT (email) DO UPDATE SET name = 'Reader' RETURNING id"
  );
  const token = jwt.sign({ userId: reader.rows[0].id, tv: 0 }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/venue-dashboard', venueDashboardRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/venue-dashboard/public-promotions/${placeId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    let res = await get();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.promotions.length, 1, 'no notice yet: the deal keeps serving');
    await roostNotice.runRoostNoticeSweep();
    res = await get();
    assert.strictEqual(res.body.promotions.length, 1, 'inside the window: the deal keeps serving');
    await testPool.query(
      "UPDATE venue_roost_notices SET emailed_at = NOW() - INTERVAL '31 days', charge_not_before = NOW() - INTERVAL '1 day' WHERE user_id = $1",
      [v.id]
    );
    res = await get();
    assert.strictEqual(res.body.promotions.length, 0, 'after the window a free venue\'s deal is a paid feature again');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the Monday digest keeps going to a venue inside its window', async () => {
  setEnv({ DIGEST_ENABLED: 'true' });
  const v = await venue({ placeId: 'ChIJroostNoticeDigest01' });
  await testPool.query("UPDATE venue_profiles SET notification_prefs = '{\"weekly\": true}'::jsonb WHERE user_id = $1", [v.id]);
  // Keep this test's sweep to this venue's own digest email.
  await testPool.query('INSERT INTO venue_roost_notices (user_id, emailed_at, charge_not_before) VALUES ($1, NOW(), NOW() + INTERVAL \'30 days\')', [v.id]);
  venueDigest._setCardLoaderForTests(async () => []);
  try {
    // A Monday at 08:00 in New York.
    const monday = new Date('2026-09-28T12:00:00Z');
    const inside = await venueDigest.runVenueDigestSweep(monday);
    assert.strictEqual(inside.sent, 1, 'the digest is something the venue has today, so it keeps it');
    await testPool.query('DELETE FROM venue_digest_sends WHERE venue_profile_id > 0');
    await testPool.query(
      "UPDATE venue_roost_notices SET emailed_at = NOW() - INTERVAL '31 days', charge_not_before = NOW() - INTERVAL '1 day' WHERE user_id = $1",
      [v.id]
    );
    const after = await venueDigest.runVenueDigestSweep(new Date('2026-10-05T12:00:00Z'));
    assert.strictEqual(after.sent, 0, 'after the window a free venue gets no digest');
  } finally {
    venueDigest._setCardLoaderForTests(null);
    setEnv({ DIGEST_ENABLED: undefined });
  }
});

test('the email\'s prices and trial are the ones Terms 9.6 publishes', () => {
  const terms = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'website', 'TermsOfService.js'), 'utf8');
  assert.ok(terms.includes(`$${ROOST_MONTHLY_USD} a month, or $${ROOST_YEARLY_USD} a year, per location`), 'the Terms price moved without the email');
  assert.ok(terms.includes(`${ROOST_TRIAL_DAYS} days free, once per venue`));
  assert.ok(terms.includes(`at least ${ROOST_NOTICE_DAYS} days after that email`));
  // The cutoff date the Terms name is the moment the code enforces.
  const cutoff = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(ROOST_PRICED_FROM));
  assert.ok(terms.includes(`before ${cutoff}`), `Terms should name ${cutoff} as the cutoff`);
});
