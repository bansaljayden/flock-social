'use strict';
// ---------------------------------------------------------------------------
// ONLY THE CURRENT VERIFIED, UNBANNED OWNER OF A PLACE SPEAKS AS IT OR READS
// ITS OWNER DATA. Against a real, migrated Postgres.
// ---------------------------------------------------------------------------
//
// venue_profiles allows one VERIFIED claim per Google place (the partial
// unique index from migration 002) and any number of unverified ones, and
// verification can move: an admin un-verifies one account and verifies
// another, an owner re-points a claim, an account is deleted. Every read
// below used to key on the place alone, so whatever the place's history held
// was handed to whoever held a claim on it now:
//
//   1. a review reply stayed on the card as the business after its author
//      stopped being the owner, under the next owner's badge (migration 083
//      records the author);
//   2. an unverified co-claim read the reviews tab's replies, including a
//      retired one the public card withholds;
//   3. the new owner's "your own numbers" (the weekly summary, Roost's
//      readings card, the day's verdict) were the previous account's slider
//      posts, and the cohort counted readings under whoever now held the
//      place, a banned owner's included;
//   4. the NFC tap screen named the venue after any claim, unverified or
//      banned;
//   5. an unverified co-claim read the venue's sensor hardware and whether it
//      is online.
//
// And two things about who wrote a reply: 6. the replies migration 083 gave
// out on the day it ran, decided again by 087, and 7. a reply sent while its
// author's account is being deleted.
//
// These are properties of SQL (which rows a join keeps), so a scripted fake
// cannot prove them: it answers whatever it was told to. The routes and
// services run here unmodified against the real schema.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'venue-current-owner-test-secret';
// Billing off: every venue acts Roost, so the Roost surfaces answer and what
// is under test is ownership, not the plan.
delete process.env.VENUE_BILLING_ENABLED;

const PG_PORT = pickEmbeddedPgPort('venueCurrentOwner');
const DB_NAME = 'flock_venue_owner_test';
// Before config/database is required: its Pool reads these at require time,
// and backend/.env points at the live database. The shared pool's query and
// connect are also routed to the test database below, but this suite mounts
// the account deletion route, so the pool must not be able to reach anything
// else even through a path that skips them.
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
let pg;
let testPool;
let dataDir;
const appPool = require('../config/database');
const realQuery = appPool.query;
const realConnect = appPool.connect;

const venueDashboardRoutes = require('../routes/venueDashboard');
const checkinRoutes = require('../routes/checkin');
const sensorRoutes = require('../routes/sensors');
const userRoutes = require('../routes/users');
const advisorFacts = require('../services/advisorFacts');
const lastNightVerdict = require('../services/lastNightVerdict');
const { migrate } = require('../db/migrate');

let server;
let base;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-venueowner-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'venueCurrentOwner', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  testPool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}` });
  await migrate(testPool);
  appPool.query = (text, params) => testPool.query(text, params);
  appPool.connect = () => testPool.connect();

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/venue-dashboard', venueDashboardRoutes);
  app.use('/api/checkin', checkinRoutes);
  app.use('/api/sensors', sensorRoutes);
  app.use('/api/users', userRoutes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  appPool.query = realQuery;
  appPool.connect = realConnect;
  await testPool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) {
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* the OS will get it */ }
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

let seq = 0;
async function user(name, { banned = false } = {}) {
  seq += 1;
  const { rows } = await testPool.query(
    `INSERT INTO users (email, password, name, role, email_verified, is_banned)
     VALUES ($1, 'x', $2, 'venue_owner', true, $3) RETURNING id`,
    [`current-owner-${seq}@example.com`, name, banned]
  );
  return rows[0].id;
}

async function claim(userId, placeId, { verified, name = 'The Room' }) {
  const { rows } = await testPool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified, created_at)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '30 days') RETURNING id`,
    [userId, name, placeId, verified]
  );
  return rows[0].id;
}

// The audit row PUT /api/admin/venues/:profileId/verify writes with each
// decision, dated `ago` before now.
async function audit(userId, profileId, action, ago) {
  await testPool.query(
    `INSERT INTO moderation_actions (moderator_id, target_user_id, action, content_type, content_id, created_at)
     VALUES (NULL, $1, $2, 'venue_profile', $3, NOW() - $4::interval)`,
    [userId, action, profileId, ago]
  );
}

// Backends in this database waiting on a lock right now, polled until one
// matches. Interleavings below are made with row locks, never with timers.
async function waitForWaiter(label, match) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const { rows } = await testPool.query(
      `SELECT pid, query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    );
    const found = rows.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${label} never blocked on a lock; waiting now: ${JSON.stringify(rows)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Verification moving between accounts, the way PUT /api/admin/venues/:id/verify
// leaves it: one account un-verified, then another verified.
async function moveVerification(from, to) {
  await testPool.query('UPDATE venue_profiles SET verified = false WHERE user_id = $1', [from]);
  await testPool.query('UPDATE venue_profiles SET verified = true WHERE user_id = $1', [to]);
}

async function call(method, p, { as, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers.Authorization = `Bearer ${jwt.sign({ userId: as, tv: 0 }, process.env.JWT_SECRET)}`;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

async function reading(userId, placeId, percent, whenSql = "NOW() - INTERVAL '1 day'") {
  await testPool.query(
    `INSERT INTO venue_owner_reports (venue_user_id, google_place_id, busy_percent, created_at)
     VALUES ($1, $2, $3, ${whenSql})`,
    [userId, placeId, percent]
  );
}

// ── 1 and 2. the reply ──────────────────────────────────────────────────────

test('a reply speaks for the business only while its author is the verified, unbanned owner', async () => {
  const PLACE = 'ChIJcurrentOwnerReply01';
  const a = await user('Owner A');
  const b = await user('Owner B');
  const c = await user('Claimant C');
  const reviewer = await user('Reviewer');
  const reader = await user('Reader');
  await claim(a, PLACE, { verified: true, name: 'A Bar' });
  // B's claim sits unverified beside A's verified one, which the partial
  // unique index allows.
  await claim(b, PLACE, { verified: false, name: 'B Bar' });
  const reviewId = (await testPool.query(
    "INSERT INTO venue_reviews (google_place_id, user_id, rating, text) VALUES ($1, $2, 4, 'Good night') RETURNING id",
    [PLACE, reviewer]
  )).rows[0].id;
  const card = async () => {
    const res = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`, { as: reader });
    assert.strictEqual(res.status, 200, res.text);
    return res.body.reviews.find((r) => r.id === reviewId);
  };
  const tab = async (as) => {
    const res = await call('GET', '/api/venue-dashboard/reviews', { as });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(!res.text.includes('venue_reply_user_id'), 'the author column is read by the route, never sent');
    return { row: res.body.reviews.find((r) => r.id === reviewId), text: res.text };
  };

  let res = await call('POST', `/api/venue-dashboard/reviews/${reviewId}/reply`, { as: a, body: { reply: 'Thanks from A' } });
  assert.strictEqual(res.status, 200, res.text);
  const stored = await testPool.query('SELECT venue_reply_user_id FROM venue_reviews WHERE id = $1', [reviewId]);
  assert.strictEqual(stored.rows[0].venue_reply_user_id, a, 'the reply did not record who wrote it');
  assert.strictEqual((await card()).venue_reply, 'Thanks from A');

  // B, unverified, reads the review and no reply.
  let t = await tab(b);
  assert.ok(t.row, 'the review is public and stays on the tab');
  assert.strictEqual(t.row.venue_reply, null);
  assert.ok(!t.text.includes('Thanks from A'));

  // Verification moves from A to B.
  await moveVerification(a, b);
  let row = await card();
  assert.strictEqual(row.venue_reply, null, "A's reply is still on the card as the business, under B's badge");
  assert.strictEqual(row.venue_replied_at, null);
  t = await tab(b);
  assert.strictEqual(t.row.venue_reply, null, "B's tab reads A's words as B's reply");
  assert.strictEqual(t.row.reply_needs_review, false);
  assert.ok(!t.text.includes('Thanks from A'));

  res = await call('POST', `/api/venue-dashboard/reviews/${reviewId}/reply`, { as: b, body: { reply: 'Thanks from B' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual((await card()).venue_reply, 'Thanks from B');

  // The reviewer rewrites the review, which retires B's reply (submit-review
  // clears the timestamp and keeps the words). B keeps its own retired words
  // to reuse; C, an unverified claim on the same place, reads none of them.
  await testPool.query('UPDATE venue_reviews SET text = $2, venue_replied_at = NULL WHERE id = $1', [reviewId, 'Changed my mind']);
  await claim(c, PLACE, { verified: false, name: 'C Bar' });
  t = await tab(b);
  assert.strictEqual(t.row.venue_reply, 'Thanks from B');
  assert.strictEqual(t.row.reply_needs_review, true);
  t = await tab(c);
  assert.strictEqual(t.row.venue_reply, null, 'an unverified claim read the retired reply the public card withholds');
  assert.strictEqual(t.row.reply_needs_review, false);
  assert.ok(!t.text.includes('Thanks from B'));
  assert.strictEqual((await card()).venue_reply, null, 'a retired reply is not published');

  res = await call('POST', `/api/venue-dashboard/reviews/${reviewId}/reply`, { as: b, body: { reply: 'Sorry it went wrong' } });
  assert.strictEqual(res.status, 200, res.text);

  // A ban silences the business at once, and lifting it restores the reply.
  await testPool.query('UPDATE users SET is_banned = true WHERE id = $1', [b]);
  assert.strictEqual((await card()).venue_reply, null, "a banned owner's reply is still on the card");
  await testPool.query('UPDATE users SET is_banned = false WHERE id = $1', [b]);
  assert.strictEqual((await card()).venue_reply, 'Sorry it went wrong');

  // B's account goes: the reply loses its author and nobody publishes it,
  // including the next account to verify on the place.
  await testPool.query('DELETE FROM users WHERE id = $1', [b]);
  const after = await testPool.query('SELECT venue_reply, venue_reply_user_id FROM venue_reviews WHERE id = $1', [reviewId]);
  assert.strictEqual(after.rows[0].venue_reply_user_id, null);
  await testPool.query('UPDATE venue_profiles SET verified = true WHERE user_id = $1', [a]);
  assert.strictEqual((await card()).venue_reply, null, "a deleted account's reply came back under the next verified owner");
});

// ── 3. the owner's own numbers ──────────────────────────────────────────────

test("an owner's own numbers are the readings that account posted, not the place's", async () => {
  const PLACE = 'ChIJcurrentOwnerRead01';
  const a = await user('Reader A');
  const b = await user('Reader B');
  await claim(a, PLACE, { verified: true });
  await claim(b, PLACE, { verified: false });
  for (const pct of [80, 85, 90]) await reading(a, PLACE, pct);

  // A opens the weekly summary, which is cached for the hour.
  let res = await call('GET', '/api/venue-dashboard/this-week', { as: a });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.yourReadings.thisWeek, 3);

  await moveVerification(a, b);

  // B, inside the same hour: B's own count, not A's cached one.
  res = await call('GET', '/api/venue-dashboard/this-week', { as: b });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.yourReadings.thisWeek, 0, "B was shown A's readings as B's own live numbers");
  assert.strictEqual(res.body.yourReadings.medianPercent, null);

  const ctx = await advisorFacts.getVenueContext(b);
  let facts = await advisorFacts.buildReadingsVsServed(ctx);
  assert.ok(!facts.some((f) => /^owner_reading_/.test(f.id)), "Roost read A's readings back to B as B's own");
  assert.ok(facts.some((f) => f.id === 'refuse_no_owner_readings'));

  // Yesterday's verdict: B posted nothing, so there is nothing of B's to grade.
  const verdict = await lastNightVerdict.buildLastDayVerdict(ctx, { now: new Date() });
  assert.strictEqual(verdict.length, 1);
  assert.match(verdict[0].id, /^refuse_no_reading_/, "the verdict graded A's reading as B's day");

  // B's own reading is B's.
  await reading(b, PLACE, 40);
  facts = await advisorFacts.buildReadingsVsServed(ctx);
  const mine = facts.filter((f) => /^owner_reading_/.test(f.id));
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].value.peakReading, 40);
  assert.strictEqual(mine[0].value.readings, 1);

  // A banned owner's own card has nothing of theirs to read either.
  await testPool.query('UPDATE users SET is_banned = true WHERE id = $1', [b]);
  facts = await advisorFacts.buildReadingsVsServed(ctx);
  assert.ok(!facts.some((f) => /^owner_reading_/.test(f.id)));
  await testPool.query('UPDATE users SET is_banned = false WHERE id = $1', [b]);
});

test('the cohort counts a reading only for its author, while they are the verified, unbanned owner', async () => {
  const CITY = 'ownercity';
  const TZ = 'America/New_York';
  // Yesterday at 21:30 on the cohort's wall clock: a completed night, inside
  // the 21 to 23 band.
  const LAST_NIGHT = `((date_trunc('day', NOW() AT TIME ZONE '${TZ}') - INTERVAL '1 day' + INTERVAL '21 hours 30 minutes') AT TIME ZONE '${TZ}')`;
  let n = 0;
  const venue = async (place) => {
    n += 1;
    await testPool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
       VALUES ($1, $2, $3, 40.6 + $4::float8 / 1000, -75.4, 'bar', $5)`,
      [place, `Cohort Bar ${n}`, CITY, n, TZ]
    );
  };
  const owned = async (place, { verified = true, banned = false, reads = true } = {}) => {
    await venue(place);
    const id = await user(`Cohort owner ${place}`, { banned });
    await claim(id, place, { verified });
    if (reads) await reading(id, place, 40, LAST_NIGHT);
    return id;
  };

  const asker = await owned('ChIJcohortOwnerAsk01');
  for (let i = 1; i <= 4; i += 1) await owned(`ChIJcohortOwnerHon0${i}`);
  // A place whose reading was posted by an account that no longer holds it.
  const moved = await owned('ChIJcohortOwnerMoved1');
  const heldNow = await user('Holds the moved place now');
  await claim(heldNow, 'ChIJcohortOwnerMoved1', { verified: false });
  await moveVerification(moved, heldNow);
  // A place whose verified owner is banned.
  const banned = await owned('ChIJcohortOwnerBann01', { banned: true });

  const ctx = await advisorFacts.getVenueContext(asker);
  const out = await advisorFacts.buildCohortSameNight(ctx, { now: new Date() });
  assert.ok(out.some((f) => f.id === 'owner_night_peak'), 'the asking venue has its own reading');
  assert.ok(!out.some((f) => f.id === 'cohort_night_median'),
    "the cohort published on the strength of a previous owner's reading and a banned owner's");
  assert.ok(out.some((f) => f.id === 'refuse_cohort_thin_reporters'), 'four honest other owners is under the floor of five');

  // The control: the same street with the ban lifted clears the floor, so it
  // is the exclusion that decided the answer above, not the fixture.
  await testPool.query('UPDATE users SET is_banned = false WHERE id = $1', [banned]);
  const cleared = await advisorFacts.buildCohortSameNight(ctx, { now: new Date() });
  const median = cleared.find((f) => f.id === 'cohort_night_median');
  assert.ok(median, 'five honest other owners publish');
  assert.strictEqual(median.value.medianReading, 40);

  // And the asking venue's "own" reading is its owner's. An account that
  // took over a place its predecessor reported on has no night of its own.
  const takeover = await advisorFacts.getVenueContext(heldNow);
  const theirs = await advisorFacts.buildCohortSameNight(takeover, { now: new Date() });
  assert.strictEqual(theirs.length, 1);
  assert.strictEqual(theirs[0].id, 'refuse_no_reading_of_your_own', "the previous owner's reading was called the new owner's own");
});

// ── 4. the tap screen's name ────────────────────────────────────────────────

test("the tap screen names the venue after its verified, unbanned owner, else the corpus, never another claim", async () => {
  const PLACE = 'ChIJcurrentOwnerTap001';
  await testPool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
     VALUES ($1, 'The Corpus Name', 'tapcity', 40.1, -75.1, 'bar', 'America/New_York')`,
    [PLACE]
  );
  const squatter = await user('Squatter');
  await claim(squatter, PLACE, { verified: false, name: 'Squatter Bar' });
  const tap = async () => {
    const res = await call('POST', `/api/checkin/${PLACE}/tap`);
    assert.strictEqual(res.status, 200, res.text);
    return res.body.venue_name;
  };
  assert.strictEqual(await tap(), 'The Corpus Name', "an unverified claim's name headlined the tap");

  const owner = await user('Real owner');
  await claim(owner, PLACE, { verified: true, name: 'The Real Bar' });
  assert.strictEqual(await tap(), 'The Real Bar');

  await testPool.query('UPDATE users SET is_banned = true WHERE id = $1', [owner]);
  assert.strictEqual(await tap(), 'The Corpus Name', "a banned owner's name headlined the tap");

  // A known place with neither: a null, never a failed tap.
  const LONE = 'ChIJcurrentOwnerTap002';
  await claim(await user('Lone claimant'), LONE, { verified: false, name: 'Lone Claim' });
  const res = await call('POST', `/api/checkin/${LONE}/tap`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.venue_name, null);
});

// ── 5. the venue's hardware ─────────────────────────────────────────────────

test("an unverified claim on the venue does not read its sensor hardware; the verified owner does", async () => {
  const PLACE = 'ChIJcurrentOwnerSens01';
  const owner = await user('Sensor owner');
  const claimant = await user('Sensor claimant');
  await claim(owner, PLACE, { verified: true });
  await claim(claimant, PLACE, { verified: false });
  await testPool.query(
    `INSERT INTO sensor_devices (device_id, venue_place_id, api_key, device_name, is_active, last_seen_at)
     VALUES ('sensor_current_owner_1', $1, 'sha256:0000', 'Front door', true, NOW())`,
    [PLACE]
  );

  const refused = await call('GET', `/api/sensors/${PLACE}/status`, { as: claimant });
  assert.strictEqual(refused.status, 403, refused.text);
  assert.ok(!refused.text.includes('sensor_current_owner_1'), refused.text);

  const served = await call('GET', `/api/sensors/${PLACE}/status`, { as: owner });
  assert.strictEqual(served.status, 200, served.text);
  assert.deepStrictEqual(served.body.devices.map((d) => d.device_id), ['sensor_current_owner_1']);
  assert.strictEqual(served.body.devices[0].online, true);
});

// ── 6. the replies 083 gave out, decided again by 087 ───────────────────────
//
// 083 gave each reply written before its column existed to the place's
// verified owner on the day it ran, and it ran in production with a rule that
// left an owner's own replies from before a later verification with no author
// and handed an undated reply to whoever held the place. 087 corrects what it
// wrote. It runs here the way it ran there: 083 alone over replies with no
// author, the reply route writing its own afterwards, then 087, read back
// through the card and the owner's Reviews tab.

test('087: a re-verified owner gets its earlier reply back, an undated reply goes to nobody, and replies the route wrote are left alone', async () => {
  const PLACE = 'ChIJcurrentOwner087a01';
  const OTHER = 'ChIJcurrentOwner087b01';
  const owner = await user('Returning owner');
  const previous = await user('Previous owner');
  const otherOwner = await user('Other owner');
  const nextOwner = await user('Next owner');
  const reader = await user('Card reader');
  const reviewers = [];
  for (let i = 0; i < 5; i += 1) reviewers.push(await user(`Reviewer 087 ${i}`));

  // The table 083 met: the words, and no column saying whose. Dropping the
  // column takes 087's index with it, so 087 is due again once released.
  await testPool.query('ALTER TABLE venue_reviews DROP COLUMN venue_reply_user_id');
  await testPool.query(`DELETE FROM schema_migrations WHERE name = '083_venue_reply_author.sql'`);

  const ownerProfile = await claim(owner, PLACE, { verified: true, name: 'Returning Bar' });
  const previousProfile = await claim(previous, PLACE, { verified: false, name: 'Previous Bar' });
  const otherProfile = await claim(otherOwner, OTHER, { verified: true, name: 'Other Bar' });
  const nextProfile = await claim(nextOwner, OTHER, { verified: false, name: 'Next Bar' });
  // The previous owner held the place first and was un-verified.
  await audit(previous, previousProfile, 'venue_verified', '60 days');
  await audit(previous, previousProfile, 'venue_unverified', '40 days');
  // The owner was verified; its claim then moved off the place and back, which
  // clears the badge and writes no audit row (routes/venueProfile.js); an
  // admin verified it again.
  await audit(owner, ownerProfile, 'venue_verified', '20 days');
  await audit(owner, ownerProfile, 'venue_verified', '5 days');
  await audit(otherOwner, otherProfile, 'venue_verified', '30 days');

  const oldReply = async (place, by, words, ago) => (await testPool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at)
     VALUES ($1, $2, 4, 'Good night', $3, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() - ($4::text)::interval END)
     RETURNING id`,
    [place, by, words, ago]
  )).rows[0].id;
  // The owner's, between its two verifications.
  const earlier = await oldReply(PLACE, reviewers[0], 'Thanks, see you soon', '10 days');
  // The previous owner's, retired by a rewrite of its review: no date.
  const undated = await oldReply(PLACE, reviewers[1], 'Words from the previous owner', null);
  // The previous owner's, from before the owner's claim began.
  const older = await oldReply(PLACE, reviewers[2], 'Also the previous owner', '50 days');

  await migrate(testPool); // 083, as production ran it; 087 is recorded and waits

  const author = async (id) => (await testPool.query(
    'SELECT venue_reply_user_id FROM venue_reviews WHERE id = $1', [id]
  )).rows[0].venue_reply_user_id;
  const card = async (id) => {
    const res = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`, { as: reader });
    assert.strictEqual(res.status, 200, res.text);
    return res.body.reviews.find((r) => r.id === id);
  };
  const tab = async (id) => {
    const res = await call('GET', '/api/venue-dashboard/reviews', { as: owner });
    assert.strictEqual(res.status, 200, res.text);
    return res.body.reviews.find((r) => r.id === id);
  };

  // What 083 left: the owner's own reply off the card, and the previous
  // owner's undated words on the owner's tab as the owner's earlier reply.
  assert.strictEqual(await author(earlier), null);
  assert.strictEqual((await card(earlier)).venue_reply, null);
  assert.strictEqual(await author(undated), owner);
  assert.strictEqual((await tab(undated)).venue_reply, 'Words from the previous owner');
  assert.strictEqual(await author(older), null);

  // After 083 the reply route writes its own author, in the same statement.
  const answered = (await testPool.query(
    "INSERT INTO venue_reviews (google_place_id, user_id, rating, text) VALUES ($1, $2, 5, 'Lovely') RETURNING id",
    [OTHER, reviewers[3]]
  )).rows[0].id;
  let res = await call('POST', `/api/venue-dashboard/reviews/${answered}/reply`, { as: otherOwner, body: { reply: 'Thank you' } });
  assert.strictEqual(res.status, 200, res.text);
  // A newer review the owner answered, then rewritten by its reviewer, which
  // retires the reply the way submit-review does: no date, words kept.
  const retired = (await testPool.query(
    "INSERT INTO venue_reviews (google_place_id, user_id, rating, text) VALUES ($1, $2, 3, 'Fine') RETURNING id",
    [PLACE, reviewers[4]]
  )).rows[0].id;
  res = await call('POST', `/api/venue-dashboard/reviews/${retired}/reply`, { as: owner, body: { reply: 'Sorry about the wait' } });
  assert.strictEqual(res.status, 200, res.text);
  await testPool.query('UPDATE venue_reviews SET text = $2, venue_replied_at = NULL WHERE id = $1', [retired, 'Slow service']);
  // Then the other place's verification moves on, so the rule, asked today,
  // would take the route's reply away from the account that wrote it.
  await testPool.query('UPDATE venue_profiles SET verified = false WHERE id = $1', [otherProfile]);
  await audit(otherOwner, otherProfile, 'venue_unverified', '0 seconds');
  await testPool.query('UPDATE venue_profiles SET verified = true WHERE id = $1', [nextProfile]);
  await audit(nextOwner, nextProfile, 'venue_verified', '0 seconds');

  // The deploy that carries 087.
  await testPool.query(`DELETE FROM schema_migrations WHERE name = '087_venue_reply_author_repair.sql'`);
  await migrate(testPool);

  assert.strictEqual(await author(earlier), owner, "the owner's own reply from before its later verification has no author");
  assert.strictEqual((await card(earlier)).venue_reply, 'Thanks, see you soon');
  const mine = await tab(earlier);
  assert.strictEqual(mine.venue_reply, 'Thanks, see you soon');
  assert.strictEqual(mine.reply_needs_review, false);

  assert.strictEqual(await author(undated), null, 'an undated reply stayed with whoever holds the place');
  const notMine = await tab(undated);
  assert.strictEqual(notMine.venue_reply, null, "the owner's tab still reads the previous owner's words as its own");
  assert.strictEqual(notMine.reply_needs_review, false);
  assert.strictEqual(await author(older), null);

  assert.strictEqual(await author(answered), otherOwner, '087 re-decided a reply the route wrote after 083');
  assert.strictEqual(await author(retired), owner, '087 took a retired reply on a newer review from the owner who wrote it');
  const stillMine = await tab(retired);
  assert.strictEqual(stillMine.venue_reply, 'Sorry about the wait');
  assert.strictEqual(stillMine.reply_needs_review, true);

  const { rows: [index] } = await testPool.query(
    `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_venue_reviews_reply_user'`
  );
  assert.ok(index && index.indisvalid, '087 did not build the index that marks it as applied');
});

// ── 7. an owner deleting their account while replying ───────────────────────
//
// deleteAccount erases the account's replies and then deletes the account
// row, in one transaction. A reply to a review the erase had not touched could
// commit between the two, and the row's SET NULL then emptied its author and
// kept its words. The account row is now locked before the erase, so a reply
// that has not committed by then waits on the lock and fails when the account
// is gone. The interleaving is made with a row lock the test holds: the
// deletion is parked on the erase, the reply is sent, and the lock is let go
// only once the reply is seen waiting.

// Assembled at runtime so the secret scanners do not read a test fixture as a
// credential.
const DELETION_PASSWORD = ['Leaving', 'Owner', '1'].join('-');
const DELETION_PASSWORD_HASH = bcrypt.hashSync(DELETION_PASSWORD, 4);

test("an owner's reply cannot land between their account deletion's erase and the account's delete", async () => {
  const PLACE = 'ChIJcurrentOwnerGone001';
  const owner = await user('Leaving owner');
  await testPool.query('UPDATE users SET password = $2 WHERE id = $1', [owner, DELETION_PASSWORD_HASH]);
  const reviewerA = await user('Reviewer of the old reply');
  const reviewerB = await user('Reviewer of the new one');
  await claim(owner, PLACE, { verified: true, name: 'Leaving Bar' });
  const answered = (await testPool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at, venue_reply_user_id)
     VALUES ($1, $2, 5, 'Lovely', 'Thanks for coming', NOW(), $3) RETURNING id`,
    [PLACE, reviewerA, owner]
  )).rows[0].id;
  const unanswered = (await testPool.query(
    "INSERT INTO venue_reviews (google_place_id, user_id, rating, text) VALUES ($1, $2, 4, 'Good night') RETURNING id",
    [PLACE, reviewerB]
  )).rows[0].id;

  // Holding the answered review's row parks the deletion on its erase.
  const holder = await testPool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM venue_reviews WHERE id = $1 FOR UPDATE', [answered]);
  let holding = true;
  const release = async () => {
    if (!holding) return;
    holding = false;
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
  };
  try {
    const deletion = call('DELETE', '/api/users/me', { as: owner, body: { password: DELETION_PASSWORD } });
    await waitForWaiter('the account deletion', (w) => /SET venue_reply = NULL/.test(w.query));

    // The owner's other session answers the other review now.
    const reply = call('POST', `/api/venue-dashboard/reviews/${unanswered}/reply`, {
      as: owner, body: { reply: 'Written on the way out' },
    });
    const first = await Promise.race([
      reply.then((r) => ({ finished: r })),
      waitForWaiter('the reply', (w) => /SET venue_reply = \$1/.test(w.query))
        .then(() => ({ waiting: true }), () => ({ waiting: false })),
    ]);
    assert.ok(first.waiting,
      `the reply committed while the deletion was between its erase and the account's delete (${first.finished && first.finished.status})`);

    await release();
    const [del, rep] = await Promise.all([deletion, reply]);
    assert.strictEqual(del.status, 200, del.text);
    assert.notStrictEqual(rep.status, 200, 'a reply from an account that no longer exists was stored');
  } finally {
    await release();
  }

  const { rows } = await testPool.query(
    'SELECT id, venue_reply, venue_reply_user_id FROM venue_reviews WHERE id = ANY($1::int[]) ORDER BY id',
    [[answered, unanswered]]
  );
  assert.strictEqual(rows.length, 2, "the reviewers' reviews stay");
  for (const r of rows) {
    assert.strictEqual(r.venue_reply, null, `review ${r.id} still carries the words of a deleted account`);
    assert.strictEqual(r.venue_reply_user_id, null);
  }
});
