// Run: node --test __tests__/feedbackPlanWindowRealDb.test.js  (from backend/)
//
// THE PLAN WINDOW ON A REAL DATABASE (migration 136).
//
// feedbackPlanWindow.test.js runs the rule on a fixture database, which says
// what the route ASKS. This walks the real feedback router on an embedded,
// migrated Postgres, so what Postgres ANSWERS is checked too: the epoch of a
// naive event_time read as UTC, a naive joined_at compared with a timestamptz
// confirmed_at, the bigint member count, the served lookup's to_timestamp
// window, `flock_id = NULL::int` in the dedupe, and observed_at landing in its
// column.
//
// The plan is in October 2026, weeks before any run of this suite, so the old
// 12-hour rule (which reads the database's NOW()) says no on its own, and the
// route's clock is pinned to the morning after the plan.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('feedbackPlanWindowRealDb');
const DB_NAME = 'flock_feedback_plan_window_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-feedback-plan-window-real-db';

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let clock;
let seq = 0;

const PLACE = 'ChIJplanWindowRealDbVenue01';
// Friday 2026-10-02, 9 PM EDT.
const EVENT_ISO = '2026-10-03T01:00:00Z';
const EVENT_MS = Date.parse(EVENT_ISO);
const LOCKED_AT = '2026-10-02T18:00:00Z';

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-feedback-plan-window-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'feedbackPlanWindowRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));
  const router = require('../routes/feedback');
  ({ clock } = router.__testables);
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', router);
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
     VALUES ($1, 'Plan Window Bar', 'philly', 39.95, -75.16, 'bar', 'America/New_York')`,
    [PLACE]
  );
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'feedbackPlanWindowRealDb');
});

async function user() {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, date_of_birth)
     VALUES ($1, 'x', 'Ava Lee', true, '2000-01-01') RETURNING *`,
    [`planwindow${seq}.${Date.now()}@example.com`]
  );
  return { ...u, token: signUserToken(u) };
}

// A locked-in plan at PLACE with the given members. joined_at and the event
// time are written as naive UTC wall time, the way the app writes them.
async function plan(members, { status = 'confirmed', confirmedAt = LOCKED_AT } = {}) {
  const { rows: [f] } = await pool.query(
    `INSERT INTO flocks (name, creator_id, venue_name, venue_id, event_time, status, confirmed_at)
     VALUES ('Friday', $1, 'Plan Window Bar', $2, ($3::timestamptz AT TIME ZONE 'UTC'), $4, $5)
     RETURNING id`,
    [members[0].who.id, PLACE, EVENT_ISO, status, confirmedAt]
  );
  for (const m of members) {
    await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status, joined_at)
       VALUES ($1, $2, 'accepted', ($3::timestamptz AT TIME ZONE 'UTC'))`,
      [f.id, m.who.id, m.joinedAt || '2026-10-01T12:00:00Z']
    );
  }
  return f.id;
}

async function report(who, flockId, nowIso, extra = {}) {
  clock.now = () => Date.parse(nowIso);
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
      body: JSON.stringify({
        venue_place_id: PLACE, venue_name: 'Plan Window Bar', crowd_level: 3, flock_id: flockId, ...extra,
      }),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text };
  } finally {
    clock.now = () => Date.now();
  }
}

const rowsFor = async (who) => (await pool.query(
  `SELECT id, flock_id, verified, day_of_week, hour, observed_at, predicted_score, predicted_score_source
     FROM venue_feedback WHERE user_id = $1 ORDER BY id`,
  [who.id]
)).rows;

test('a member at lock-in answering at 10:30 AM the next day is counted, filed under 9 PM Friday', async () => {
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }]);
  const r = await report(ava, flockId, '2026-10-03T14:30:00Z'); // Sat 10:30 AM EDT
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, true);
  assert.equal(r.body.plan_window_closed, false);
  assert.equal(r.body.plan_report_closes_at, '2026-10-03T16:00:00.000Z'); // noon EDT
  const [row] = await rowsFor(ava);
  assert.equal(row.verified, true);
  assert.equal(row.day_of_week, 5);
  assert.equal(row.hour, 21);
  assert.equal(new Date(row.observed_at).toISOString(), EVENT_ISO.replace('Z', '.000Z'));
});

test('after noon the answer is kept, not counted, and says the window shut', async () => {
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }]);
  const r = await report(ava, flockId, '2026-10-03T16:00:00Z');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, false);
  assert.equal(r.body.plan_window_closed, true);
  assert.equal((await rowsFor(ava))[0].verified, false);
});

test('somebody who joined after the lock-in gets no window', async () => {
  const ava = await user();
  const ben = await user();
  const late = await user();
  const flockId = await plan([{ who: ava }, { who: ben }, { who: late, joinedAt: '2026-10-02T23:30:00Z' }]);
  const r = await report(late, flockId, '2026-10-03T14:30:00Z');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, false);
  assert.equal(r.body.plan_window_closed, undefined);
});

test('a plan that was never locked in gets no window', async () => {
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }], { status: 'completed', confirmedAt: null });
  const r = await report(ava, flockId, '2026-10-03T14:30:00Z');
  assert.equal(r.body.verified, false);
});

test('a counted answer replaces the earlier one on the same plan; a late one replaces none', async () => {
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }]);
  await report(ava, flockId, '2026-10-03T02:30:00Z'); // 10:30 PM, during the night
  await report(ava, flockId, '2026-10-03T15:30:00Z'); // 11:30 AM, a correction
  let rows = await rowsFor(ava);
  assert.equal(rows.length, 1, 'one report per member per plan');
  assert.equal(rows[0].verified, true);
  await report(ava, flockId, '2026-10-03T18:00:00Z'); // 2 PM, after the window
  rows = await rowsFor(ava);
  assert.equal(rows.length, 2, 'the late answer is kept beside the counted one');
  assert.deepEqual(rows.map((x) => x.verified), [true, false]);
});

test("the served lookup finds the card read in the plan's hour, half a day earlier", async () => {
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }]);
  await pool.query(
    `INSERT INTO served_predictions (user_id, venue_place_id, score, served_at, source, local_day, local_hour)
     VALUES ($1, $2, 83, '2026-10-03T01:20:00Z', 'detail', 5, 21)`,
    [ava.id, PLACE]
  );
  const r = await report(ava, flockId, '2026-10-03T14:30:00Z', { predicted_score: 15, local_day: 6, local_hour: 10 });
  assert.equal(r.status, 201, r.text);
  const [row] = await rowsFor(ava);
  assert.equal(row.predicted_score, 83);
  assert.equal(row.predicted_score_source, 'server');
});

test('a report naming no plan is untouched by any of this', async () => {
  const ava = await user();
  const r = await report(ava, null, '2026-10-03T14:30:00Z');
  assert.equal(r.status, 201, r.text);
  const [row] = await rowsFor(ava);
  assert.equal(row.verified, false);
  assert.equal(row.observed_at, null);
  assert.deepEqual([row.day_of_week, row.hour], [6, 10]);
});
