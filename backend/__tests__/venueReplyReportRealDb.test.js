// Run: node --test  (from backend/)
//
// A VENUE OWNER'S REPLY, REPORTED ON ITS OWN, ON A REAL DATABASE (migration
// 114, backend audit 2026-10-03).
//
// The owner's public answer under a review could only be reported by
// reporting the review, which named the reviewer: the reviewer was told they
// could not report their own content, and a moderator's Warn, Ban and Hide all
// landed on the reviewer. 'venue_reply' reports the reply: its author is the
// owner, its takedown hides the reply and leaves the review, and the owner can
// answer again.
//
// Walked here through the real report, admin and venue routers on an embedded
// Postgres, so the widened CHECK, the new column and every statement are real.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('venueReplyReportRealDb');
const DB_NAME = 'flock_venue_reply_report_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-venue-reply-report';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

const PLACE = 'ChIJreplyReport000001';

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-venue-reply-report-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'venueReplyReportRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/venue-dashboard', require('../routes/venueDashboard'));
  app.use('/api', require('../routes/moderation'));
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

async function user(name, role = 'user') {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, role) VALUES ($1, 'x', $2, true, $3) RETURNING *`,
    [`reply${seq}.${Date.now()}@example.com`, name, role]
  );
  return { ...u, token: signUserToken(u) };
}

async function call(method, url, who, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, body: json };
}

async function publicReview(who, reviewId, place = PLACE) {
  const r = await call('GET', `/api/venue-dashboard/public-reviews/${place}`, who);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const list = Array.isArray(r.body) ? r.body : (r.body.reviews || []);
  return list.find((x) => x.id === reviewId) || null;
}

test('an owner reply is reported, taken down alone, and answered again', async () => {
  const owner = await user('Owner', 'venue_owner');
  const reviewer = await user('Reviewer');
  const stranger = await user('Stranger');
  const admin = await user('Admin', 'admin');
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'The Reply Bar', $2, true)`,
    [owner.id, PLACE]
  );
  const reviewId = (await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text) VALUES ($1, $2, 2, 'Slow service') RETURNING id`,
    [PLACE, reviewer.id]
  )).rows[0].id;

  const replied = await call('POST', `/api/venue-dashboard/reviews/${reviewId}/reply`, owner, { reply: 'You were rude to our staff' });
  assert.strictEqual(replied.status, 200, JSON.stringify(replied.body));
  assert.strictEqual((await publicReview(stranger, reviewId)).venue_reply, 'You were rude to our staff');

  // The reviewer reports the reply. Under the review's type this was refused
  // as their own content; under the reply's it reaches the owner.
  const filed = await call('POST', '/api/reports', reviewer, { content_type: 'venue_reply', content_id: reviewId, reason: 'harassment' });
  assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));
  const report = (await pool.query(
    `SELECT id, reported_user_id FROM content_reports WHERE content_type = 'venue_reply' AND content_id = $1`, [reviewId]
  )).rows[0];
  assert.ok(report, 'no report row was written');
  assert.strictEqual(report.reported_user_id, owner.id, 'the report must name the reply author, the owner');

  // The owner cannot report their own reply.
  const own = await call('POST', '/api/reports', owner, { content_type: 'venue_reply', content_id: reviewId, reason: 'spam' });
  assert.strictEqual(own.status, 400);

  // The queue shows the owner's words first, and the owner as the author.
  const queue = await call('GET', '/api/admin/reports', admin);
  assert.strictEqual(queue.status, 200, JSON.stringify(queue.body));
  const rows = Array.isArray(queue.body) ? queue.body : (queue.body.reports || []);
  const card = rows.find((r) => r.id === report.id);
  assert.ok(card, 'the report is not in the queue');
  assert.match(String(card.content_excerpt || card.content_text || card.body || JSON.stringify(card)), /Owner reply: You were rude to our staff/);

  // Hide takes the reply down and leaves the review.
  const hidden = await call('PUT', `/api/admin/reports/${report.id}`, admin, { action: 'hide' });
  assert.strictEqual(hidden.status, 200, JSON.stringify(hidden.body));
  const after = await publicReview(stranger, reviewId);
  assert.ok(after, 'the review must stay on the card');
  assert.strictEqual(after.text, 'Slow service');
  assert.strictEqual(after.venue_reply, null, 'the hidden reply is still on the public card');
  const flags = (await pool.query('SELECT is_hidden, venue_reply_hidden FROM venue_reviews WHERE id = $1', [reviewId])).rows[0];
  assert.deepStrictEqual(flags, { is_hidden: false, venue_reply_hidden: true });

  // A second report on the hidden reply is accepted and queues nothing.
  const again = await call('POST', '/api/reports', stranger, { content_type: 'venue_reply', content_id: reviewId, reason: 'spam' });
  assert.strictEqual(again.status, 201);
  assert.strictEqual(again.body.report, null);

  // The owner still reads the reply, flagged, and can answer again.
  const mine = await call('GET', '/api/venue-dashboard/reviews', owner);
  assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
  const mineRow = (mine.body.reviews || []).find((r) => r.id === reviewId);
  assert.strictEqual(mineRow.venue_reply, 'You were rude to our staff');
  assert.strictEqual(mineRow.reply_hidden_by_moderation, true);

  const fresh = await call('POST', `/api/venue-dashboard/reviews/${reviewId}/reply`, owner, { reply: 'Sorry about the wait, come back soon' });
  assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
  assert.strictEqual(fresh.body.venue_reply_hidden, false);
  assert.strictEqual((await publicReview(stranger, reviewId)).venue_reply, 'Sorry about the wait, come back soon');

});

test('the reviewer re-submitting their review gets no hidden reply back', async () => {
  const owner = await user('Owner4', 'venue_owner');
  const reviewer = await user('Reviewer4');
  const place = 'ChIJreplyReport000004';
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'Fourth Bar', $2, true)`,
    [owner.id, place]
  );
  await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at, venue_reply_user_id, venue_reply_hidden)
     VALUES ($1, $2, 3, 'Fine', 'Hidden words', NOW(), $3, true)`,
    [place, reviewer.id, owner.id]
  );
  const again = await call('POST', '/api/venue-dashboard/submit-review', reviewer, { googlePlaceId: place, rating: 3, text: 'Fine' });
  // Whatever the presence rules answer, a body never carries the reply.
  assert.ok(!JSON.stringify(again.body || {}).includes('Hidden words'), JSON.stringify(again.body));
  assert.ok(!('venue_reply_hidden' in (again.body || {})));
  assert.ok(!('venue_reply_user_id' in (again.body || {})));
});

test('a report on one owner\'s reply cannot act on the next owner\'s', async () => {
  const first = await user('FirstOwner', 'venue_owner');
  const second = await user('SecondOwner', 'venue_owner');
  const reviewer = await user('Reviewer5');
  const admin = await user('Admin5', 'admin');
  const place = 'ChIJreplyReport000005';
  const reviewId = (await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at, venue_reply_user_id)
     VALUES ($1, $2, 2, 'Meh', 'First owner words', NOW(), $3) RETURNING id`,
    [place, reviewer.id, first.id]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'Fifth Bar', $2, true)`,
    [first.id, place]
  );
  const filed = await call('POST', '/api/reports', reviewer, { content_type: 'venue_reply', content_id: reviewId, reason: 'harassment' });
  assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));
  const report = (await pool.query(
    `SELECT id, reported_user_id FROM content_reports WHERE content_type = 'venue_reply' AND content_id = $1`, [reviewId]
  )).rows[0];
  assert.strictEqual(report.reported_user_id, first.id);

  // The place changes hands and the new owner answers the same review.
  await pool.query('DELETE FROM venue_profiles WHERE user_id = $1', [first.id]);
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'Fifth Bar', $2, true)`,
    [second.id, place]
  );
  const answered = await call('POST', `/api/venue-dashboard/reviews/${reviewId}/reply`, second, { reply: 'Second owner words' });
  assert.strictEqual(answered.status, 200, JSON.stringify(answered.body));

  const content = await call('GET', `/api/admin/reports/${report.id}/content`, admin);
  assert.ok(!JSON.stringify(content.body || {}).includes('Second owner words'), 'the old report reads the new owner\'s words');
  const queue = await call('GET', '/api/admin/reports', admin);
  const rows = Array.isArray(queue.body) ? queue.body : (queue.body.reports || []);
  assert.ok(!JSON.stringify(rows.find((r) => r.id === report.id) || {}).includes('Second owner words'));

  const hide = await call('PUT', `/api/admin/reports/${report.id}`, admin, { action: 'hide' });
  assert.strictEqual(hide.status, 404, JSON.stringify(hide.body));
  const flags = (await pool.query('SELECT venue_reply, venue_reply_hidden FROM venue_reviews WHERE id = $1', [reviewId])).rows[0];
  assert.deepStrictEqual(flags, { venue_reply: 'Second owner words', venue_reply_hidden: false });
});

// A review taken down on its own report is a different takedown from the
// reply's. The reply's card keeps offering Hide, and a reply hidden there stays
// hidden when the review is restored (review 2026-10-03).
test('a reply under a hidden review still offers Hide, and stays down when the review comes back', async () => {
  const owner = await user('Owner6', 'venue_owner');
  const reviewer = await user('Reviewer6');
  const stranger = await user('Stranger6');
  const admin = await user('Admin6', 'admin');
  const place = 'ChIJreplyReport000006';
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'Sixth Bar', $2, true)`,
    [owner.id, place]
  );
  const reviewId = (await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at, venue_reply_user_id)
     VALUES ($1, $2, 1, 'Rude words', 'Rude reply', NOW(), $3) RETURNING id`,
    [place, reviewer.id, owner.id]
  )).rows[0].id;
  assert.strictEqual((await call('POST', '/api/reports', stranger, { content_type: 'venue_reply', content_id: reviewId, reason: 'harassment' })).status, 201);
  assert.strictEqual((await call('POST', '/api/reports', owner, { content_type: 'venue_review', content_id: reviewId, reason: 'harassment' })).status, 201);
  const ids = Object.fromEntries((await pool.query(
    'SELECT content_type, id FROM content_reports WHERE content_id = $1', [reviewId]
  )).rows.map((r) => [r.content_type, r.id]));

  assert.strictEqual((await call('PUT', `/api/admin/reports/${ids.venue_review}`, admin, { action: 'hide' })).status, 200);
  const queue = await call('GET', '/api/admin/reports', admin);
  const rows = Array.isArray(queue.body) ? queue.body : (queue.body.reports || []);
  const replyCard = rows.find((r) => r.id === ids.venue_reply);
  assert.strictEqual(replyCard.content_is_hidden, false, 'the reply card reads as taken down when only the review was');

  assert.strictEqual((await call('PUT', `/api/admin/reports/${ids.venue_reply}`, admin, { action: 'hide' })).status, 200);
  assert.strictEqual((await call('PUT', `/api/admin/reports/${ids.venue_review}`, admin, { action: 'unhide' })).status, 200);
  const after = await publicReview(stranger, reviewId, place);
  assert.ok(after, 'the restored review is back on the card');
  assert.strictEqual(after.venue_reply, null, 'restoring the review brought the hidden reply back');
});

test('reporting the review still reaches the reviewer, not the owner', async () => {
  const owner = await user('Owner2', 'venue_owner');
  const reviewer = await user('Reviewer2');
  const stranger = await user('Stranger2');
  const place = 'ChIJreplyReport000002';
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'Second Bar', $2, true)`,
    [owner.id, place]
  );
  const reviewId = (await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at, venue_reply_user_id)
     VALUES ($1, $2, 1, 'Awful', 'Thanks', NOW(), $3) RETURNING id`,
    [place, reviewer.id, owner.id]
  )).rows[0].id;
  const filed = await call('POST', '/api/reports', stranger, { content_type: 'venue_review', content_id: reviewId, reason: 'spam' });
  assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));
  const row = (await pool.query(
    `SELECT reported_user_id FROM content_reports WHERE content_type = 'venue_review' AND content_id = $1`, [reviewId]
  )).rows[0];
  assert.strictEqual(row.reported_user_id, reviewer.id);
});

// The duplicate check and the insert used to be two statements with nothing
// between them, so identical reports landing together each read "no open
// report" and each inserted. A double-tap filed two rows and paged twice.
test('the same report filed five times at once is one row', async () => {
  const reviewer = await user('Reviewer7');
  const stranger = await user('Stranger7');
  const place = 'ChIJreplyReport000007';
  const reviewId = (await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text) VALUES ($1, $2, 1, 'Spam spam') RETURNING id`,
    [place, reviewer.id]
  )).rows[0].id;
  // Requests this small finish one after another, so the gap is widened on
  // purpose: every duplicate check waits 300 ms before it answers. Without a
  // lock, all five read "no open report" inside that wait and all five insert.
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const isDupeCheck = (text) => /SELECT id, status, created_at FROM content_reports/.test(String(text));
  const slowed = (run) => async (text, params) => {
    const out = await run(text, params);
    if (isDupeCheck(text)) await new Promise((r) => setTimeout(r, 300));
    return out;
  };
  pool.query = slowed((text, params) => origQuery.call(pool, text, params));
  // pg's own pool.query calls connect(callback); only the route's promise
  // form gets the slowed client.
  pool.connect = function connect(cb) {
    if (typeof cb === 'function') return origConnect.call(pool, cb);
    return origConnect.call(pool).then((client) => ({
      query: slowed((text, params) => client.query(text, params)),
      release: (err) => client.release(err),
    }));
  };
  let answers;
  try {
    answers = await Promise.all(Array.from({ length: 5 }, () =>
      call('POST', '/api/reports', stranger, { content_type: 'venue_review', content_id: reviewId, reason: 'spam' })
    ));
  } finally {
    pool.query = origQuery;
    pool.connect = origConnect;
  }
  assert.deepStrictEqual(answers.map((a) => a.status), [201, 201, 201, 201, 201], JSON.stringify(answers.map((a) => a.body)));
  const rows = (await pool.query(
    `SELECT id FROM content_reports WHERE reporter_id = $1 AND content_type = 'venue_review' AND content_id = $2`,
    [stranger.id, reviewId]
  )).rows;
  assert.strictEqual(rows.length, 1, `${rows.length} report rows for one report filed at once`);
  assert.ok(answers.every((a) => a.body.report && a.body.report.id === rows[0].id), 'every answer names the one row');
});

test('a reply retired by an edited review cannot be reported', async () => {
  const owner = await user('Owner3', 'venue_owner');
  const reviewer = await user('Reviewer3');
  const stranger = await user('Stranger3');
  const place = 'ChIJreplyReport000003';
  await pool.query(
    `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'Third Bar', $2, true)`,
    [owner.id, place]
  );
  const reviewId = (await pool.query(
    `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, venue_reply, venue_replied_at, venue_reply_user_id)
     VALUES ($1, $2, 3, 'Edited', 'Old words', NULL, $3) RETURNING id`,
    [place, reviewer.id, owner.id]
  )).rows[0].id;
  const filed = await call('POST', '/api/reports', stranger, { content_type: 'venue_reply', content_id: reviewId, reason: 'spam' });
  // The route's answer for content that is not there, the same as for any type.
  assert.strictEqual(filed.status, 400, JSON.stringify(filed.body));
  assert.match(filed.body.error, /could not be found/);
});
