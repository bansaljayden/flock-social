// Run: node --test __tests__/feedbackPlanWindowRealDb.test.js  (from backend/)
//
// THE PLAN WINDOW ON A REAL DATABASE (migration 136).
//
// feedbackPlanWindow.test.js runs the rule on a fixture database, which says
// what the route ASKS. This walks the real feedback router on an embedded,
// migrated Postgres, so what Postgres ANSWERS is checked too: the epoch of a
// naive event_time read as UTC, the hour after the plan began (GREATEST of two
// naive timestamps, lifted to UTC) compared with a timestamptz confirmed_at and
// with naive joined_at values, the member count as of that hour, the served
// lookup's to_timestamp window, `flock_id = NULL::int` and the boolean guard in
// the dedupe, and observed_at landing in its column.
//
// The plan is in October 2026, weeks before any run of this suite, so the old
// 12-hour rule (which reads the database's NOW()) says no on its own, and the
// route's clock is pinned to the morning after the plan. Every row this file
// writes is created at the database's real NOW(), so any two of one person's
// reports here are inside the 2-hour dedupe of each other.
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

// Made Thursday 2026-10-01, 8 AM EDT, a day and a half before the night.
const MADE_AT = '2026-10-01T12:00:00Z';

// A locked-in plan at PLACE with the given members. joined_at, created_at and
// the event time are written as naive UTC wall time, the way the app writes
// them. A member's joinedAt defaults to the moment the plan was made.
async function plan(members, {
  status = 'confirmed',
  confirmedAt = LOCKED_AT,
  eventIso = EVENT_ISO,
  createdAt = MADE_AT,
  venueId = PLACE,
  venueLongitude = -75.16,
} = {}) {
  const { rows: [f] } = await pool.query(
    `INSERT INTO flocks (name, creator_id, venue_name, venue_id, venue_longitude, event_time, status, confirmed_at, created_at)
     VALUES ('Friday', $1, 'Plan Window Bar', $2, $3, ($4::timestamptz AT TIME ZONE 'UTC'), $5, $6,
             ($7::timestamptz AT TIME ZONE 'UTC'))
     RETURNING id`,
    [members[0].who.id, venueId, venueLongitude, eventIso, status, confirmedAt, createdAt]
  );
  for (const m of members) {
    await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status, joined_at, attendance)
       VALUES ($1, $2, 'accepted', ($3::timestamptz AT TIME ZONE 'UTC'), $4)`,
      [f.id, m.who.id, m.joinedAt || createdAt, m.attendance || 'unmarked']
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

test('a member answering at 10:30 AM the next day is counted, filed under 9 PM Friday', async () => {
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
  const [row] = await rowsFor(ava);
  assert.equal(row.verified, false);
  // Outside the window: the hour it was sent (noon Saturday), no observed_at.
  assert.deepEqual([row.day_of_week, row.hour], [6, 12]);
  assert.equal(row.observed_at, null);
});

test('an invitee who said yes after the lock-in but before the night gets the window', async () => {
  // Locked in at 2 PM; Cal says yes at 7:30 PM, an hour and a half before the
  // 9 PM plan. That is the usual invite, and it counts until noon.
  const ava = await user();
  const ben = await user();
  const cal = await user();
  const flockId = await plan([{ who: ava }, { who: ben }, { who: cal, joinedAt: '2026-10-02T23:30:00Z' }]);
  const r = await report(cal, flockId, '2026-10-03T14:30:00Z');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, true);
  assert.equal(r.body.plan_window_closed, false);
  const [row] = await rowsFor(cal);
  assert.deepEqual([row.day_of_week, row.hour], [5, 21]);
});

test('somebody who joined the morning after gets no window', async () => {
  const ava = await user();
  const ben = await user();
  const late = await user();
  const flockId = await plan([{ who: ava }, { who: ben }, { who: late, joinedAt: '2026-10-03T12:00:00Z' }]);
  const r = await report(late, flockId, '2026-10-03T15:30:00Z'); // 11:30 AM
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, false);
  assert.equal(r.body.plan_window_closed, undefined);
  const [row] = await rowsFor(late);
  assert.deepEqual([row.day_of_week, row.hour], [6, 11], 'filed under the hour it was sent');
  assert.equal(row.observed_at, null);
});

test('a plan of one at its start does not become evidence when a second account joins the morning after', async () => {
  // Locked in with only its host, who is still alone at 9 PM; a second
  // account says yes at 8 AM. The plan has two accepted members now, but only
  // one had said yes by an hour after it began.
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben, joinedAt: '2026-10-03T12:00:00Z' }]);
  const r = await report(ava, flockId, '2026-10-03T15:30:00Z'); // 11:30 AM
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, false);
  assert.equal(r.body.plan_window_closed, undefined);
  const [row] = await rowsFor(ava);
  assert.equal(row.verified, false);
  assert.deepEqual([row.day_of_week, row.hour], [6, 11]);
});

test('a plan still being planned at its start and locked in the morning after gets no window', async () => {
  // The sweep cancels an unlocked plan only 12 hours after its time, so a
  // host can lock it in at 8:30 AM. Neither the host, who was in it all
  // along, nor a member who said yes at 8 AM gets the window.
  const ava = await user();
  const ben = await user();
  const dee = await user();
  const flockId = await plan(
    [{ who: ava }, { who: ben }, { who: dee, joinedAt: '2026-10-03T12:00:00Z' }],
    { confirmedAt: '2026-10-03T12:30:00Z' }
  );
  for (const who of [ava, dee]) {
    const r = await report(who, flockId, '2026-10-03T15:30:00Z'); // 11:30 AM
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.verified, false);
    assert.equal(r.body.plan_window_closed, undefined);
  }
});

test('a plan that was never locked in gets no window', async () => {
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }], { status: 'completed', confirmedAt: null });
  const r = await report(ava, flockId, '2026-10-03T14:30:00Z');
  assert.equal(r.body.verified, false);
});

test('a plan made after its own time began when it was made: its members have an hour from then', async () => {
  // Made at 7:30 PM for the 7 PM the group is already at, locked in at 7:35,
  // the second yes at 8:20 PM: past 7 PM + 1 hour, inside 7:30 PM + 1 hour.
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben, joinedAt: '2026-10-03T00:20:00Z' }], {
    eventIso: '2026-10-02T23:00:00Z',
    createdAt: '2026-10-02T23:30:00Z',
    confirmedAt: '2026-10-02T23:35:00Z',
  });
  const r = await report(ben, flockId, '2026-10-03T14:30:00Z'); // 10:30 AM
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, true);
  const [row] = await rowsFor(ben);
  assert.deepEqual([row.day_of_week, row.hour], [5, 19], 'filed under 7 PM Friday');

  // A yes at 8:45 PM is past the hour from the making as well.
  const cal = await user();
  const dan = await user();
  const later = await plan([{ who: cal }, { who: dan, joinedAt: '2026-10-03T00:45:00Z' }], {
    eventIso: '2026-10-02T23:00:00Z',
    createdAt: '2026-10-02T23:30:00Z',
    confirmedAt: '2026-10-02T23:35:00Z',
  });
  const late = await report(dan, later, '2026-10-03T14:30:00Z');
  assert.equal(late.body.verified, false);
});

test('a no-show with a signed tap today is counted by the tap and filed under today, not the old night', async () => {
  // The host marked Ben absent on a plan five weeks back. Ben taps the
  // venue's signed NFC tag today and answers the plan's card: the tap counts
  // the report, and naming the old plan must not re-date it to that Friday.
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben, attendance: 'no_show' }], { status: 'completed' });
  await pool.query(
    `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source, created_at) VALUES ($1, $2, 'nfc', NOW())`,
    [PLACE, ben.id]
  );
  const r = await report(ben, flockId, '2026-11-07T15:30:00Z'); // Sat 10:30 AM EST
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.verified, true);
  const [row] = await rowsFor(ben);
  assert.equal(row.verified, true);
  assert.deepEqual([row.day_of_week, row.hour], [6, 10], 'Saturday 10 AM, the hour it was sent');
  assert.equal(row.observed_at, null);
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

test('a "There now?" tap that names no plan cannot erase the plan answer that counted', async () => {
  // 11:30 AM: the plan's card, counted. 12:15 PM: the venue card's "There
  // now? Rate the crowd", which sends no flock_id and no longer counts. Both
  // are inside the 2-hour dedupe, which used to delete the counted answer.
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }]);
  const counted = await report(ava, flockId, '2026-10-03T15:30:00Z');
  assert.equal(counted.body.verified, true);
  const tap = await report(ava, null, '2026-10-03T16:15:00Z');
  assert.equal(tap.status, 201, tap.text);
  assert.equal(tap.body.verified, false);
  let rows = await rowsFor(ava);
  assert.deepEqual(rows.map((x) => [x.flock_id, x.verified]), [[flockId, true], [null, false]]);
  assert.deepEqual([rows[0].day_of_week, rows[0].hour], [5, 21], 'the counted answer, still filed under the night');
  assert.deepEqual([rows[1].day_of_week, rows[1].hour], [6, 12], 'the tap, under the hour it was sent');

  // A second uncounted tap replaces the first one and still not the answer.
  await report(ava, null, '2026-10-03T16:40:00Z');
  rows = await rowsFor(ava);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.verified), [true, false]);
});

test('a phone zone is checked against the plan venue longitude on a real row', async () => {
  // A venue ml_venues has no zone for: the phone names the clock, and the
  // plan's own venue_longitude (a double) decides whether it can be the
  // venue's.
  const OTHER = 'ChIJplanWindowRealDbVenue02';
  const ava = await user();
  const ben = await user();
  const flockId = await plan([{ who: ava }, { who: ben }], { venueId: OTHER });
  const send = (who, zone) => {
    clock.now = () => Date.parse('2026-10-03T14:30:00Z'); // Sat 10:30 AM EDT
    return fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
      body: JSON.stringify({
        venue_place_id: OTHER, venue_name: 'Plan Window Bar', crowd_level: 3, flock_id: flockId,
        time_zone: zone, local_day: 6, local_hour: 10,
      }),
    }).then((res) => res.json()).finally(() => { clock.now = () => Date.now(); });
  };
  const riyadh = await send(ava, 'Asia/Riyadh');
  assert.equal(riyadh.verified, false, 'Riyadh is not a clock for a bar at -75.16');
  assert.equal(riyadh.plan_report_closes_at, '2026-10-03T13:00:00.000Z', 'the old 12 hours');
  assert.deepEqual([riyadh.day_of_week, riyadh.hour], [6, 10]);
  const local = await send(ben, 'America/New_York');
  assert.equal(local.verified, true);
  assert.equal(local.plan_report_closes_at, '2026-10-03T16:00:00.000Z');
  assert.deepEqual([local.day_of_week, local.hour], [5, 21]);
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
