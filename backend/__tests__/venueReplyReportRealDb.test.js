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

async function publicReview(who, reviewId) {
  const r = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`, who);
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
