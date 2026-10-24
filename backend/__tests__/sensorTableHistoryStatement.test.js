'use strict';
// ---------------------------------------------------------------------------
// TABLE HISTORY, AGAINST A REAL POSTGRES.
// ---------------------------------------------------------------------------
// sensorTableHistory.test.js pins the contract against a modelled store; a
// model cannot say whether Postgres runs the statements the way the model
// assumes. The properties below are server behaviour, driven through the real
// router against a real, migrated schema:
//
//   * the seatings statement (services/sensorTables.js TABLE_SEATINGS_SQL)
//     opens, continues, closes and clears rows from the change each table
//     made, inside the floor's transaction, and a failure in it costs the
//     history and not the floor;
//   * the silence rule closes the seatings of the rows it forgets;
//   * the medians (percentile_cont, GROUPING SETS, AT TIME ZONE on the
//     venue's own zone), the floor's seats join, the waits, the incoming feed
//     over the real flock tables, the switches' jsonb merge, and the public
//     summary all run as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('sensorTableHistoryStatement');
const DB_NAME = 'flock_sensor_table_history_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-sensor-table-history';
delete process.env.VENUE_BILLING_ENABLED;

let pg;
let pool;
let dataDir;
let server;
let base;

const KEY = 'k'.repeat(64);
const VENUE = 'ChIJtableHistoryStatement01';
const ZONE = 'America/New_York';
const digestOf = (key) => 'sha256:' + crypto.createHash('sha256').update(key, 'utf8').digest('hex');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let ownerId;
let userId;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-sensor-table-history-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'sensorTableHistoryStatement', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const { rows: [o] } = await pool.query(
    "INSERT INTO users (name, email, password) VALUES ('History Owner', 'history.owner@example.com', 'x') RETURNING id"
  );
  ownerId = o.id;
  const { rows: [u] } = await pool.query(
    "INSERT INTO users (name, email, password) VALUES ('Any User', 'any.user@example.com', 'x') RETURNING id"
  );
  userId = u.id;
  await pool.query(
    "INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'The History Bar', $2, true)",
    [ownerId, VENUE]
  );
  // The venue is in the corpus, so the server knows its zone.
  await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
     VALUES ($1, 'The History Bar', 'historytown', 40.6, -75.4, 'bar', $2)`,
    [VENUE, ZONE]
  );

  const app = express();
  app.use(express.json());
  app.set('io', { to: () => ({ emit() {} }) });
  require('../middleware/auth').authenticate = (req, res, next) => {
    const id = Number(req.headers['x-test-user']);
    if (!id) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id, name: 'Someone', role: 'user' };
    return next();
  };
  app.use('/api/sensors', require('../routes/sensors'));
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

const settle = () => require('../services/sensorTables')._settled();

test.beforeEach(async () => {
  await settle();
  await pool.query('DELETE FROM venue_sensor_data WHERE true');
  await pool.query('DELETE FROM sensor_devices WHERE true'); // cascades to states and seatings
  await pool.query(
    `INSERT INTO sensor_devices (device_id, venue_place_id, api_key, device_name, is_active)
     VALUES ('history_unit', $1, $2, 'front room', true)`,
    [VENUE, digestOf(KEY)]
  );
  await pool.query("UPDATE venue_profiles SET tables_in_app = true, notification_prefs = '{\"bookings\": true}'::jsonb WHERE user_id = $1", [ownerId]);
});

async function push(body, key = KEY) {
  const res = await fetch(`${base}/api/sensors/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const reading = (extra = {}) => ({ ir_beam_count: 6, thermal_headcount: 11, noise_db: 70.5, ...extra });
const ageUnit = () => pool.query("UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'history_unit'");

// One live reading, the flood guard aged, settled; resolves to its time in ms.
async function live(tables, extra = {}) {
  await ageUnit();
  const res = await push(reading({ tables, ...extra }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await settle();
  return new Date(res.body.recorded_at).getTime();
}

const seatingRows = async () => (await pool.query(
  `SELECT id, table_no, venue_place_id, seated_at, left_at, party_max, waited, cleared_at
     FROM sensor_table_seatings WHERE sensor_device_id = 'history_unit' ORDER BY id`
)).rows;
const shape = (g) => `${g.table_no}:${g.party_max}:${g.waited ? 'w' : '-'}:${g.left_at ? 'closed' : 'open'}:${g.cleared_at ? 'cleared' : '-'}`;

async function api(method, p, { user, body } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const get = (p, user) => api('GET', p, { user });

// A seating row as the writer would leave it.
async function seed(tableNo, seatedAtMs, turnMin, { waited = false, clearMin = null, party = 2, device = 'history_unit', place = VENUE } = {}) {
  await pool.query(
    `INSERT INTO sensor_table_seatings (sensor_device_id, table_no, venue_place_id, seated_at, left_at, party_max, waited, cleared_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8::timestamptz)`,
    [device, tableNo, place, new Date(seatedAtMs),
      turnMin === null ? null : new Date(seatedAtMs + turnMin * MIN), party, waited,
      turnMin !== null && clearMin !== null ? new Date(seatedAtMs + (turnMin + clearMin) * MIN) : null]
  );
}

// The instant at the same New York wall-clock hour as `atMs` (and its minute,
// or the one given), `weeksBack` weeks earlier, settled by Postgres in the
// venue's zone, so a clock change in between moves nothing out of its
// weekday-and-hour cell.
async function weeksEarlier(atMs, weeksBack, minute = null) {
  const { rows: [t] } = await pool.query(
    `WITH w AS (
       SELECT ($1::timestamptz AT TIME ZONE $2::text) AS local
     ), d AS (
       SELECT (w.local - ($3::int * INTERVAL '7 days'))::date AS day, w.local FROM w
     )
     SELECT make_timestamp(EXTRACT(YEAR FROM day)::int, EXTRACT(MONTH FROM day)::int, EXTRACT(DAY FROM day)::int,
                           EXTRACT(HOUR FROM local)::int, COALESCE($4::int, EXTRACT(MINUTE FROM local)::int), 0) AT TIME ZONE $2::text AS at
       FROM d`,
    [new Date(atMs), ZONE, weeksBack, minute]
  );
  return new Date(t.at).getTime();
}

// Twenty-one closed seatings at the same New York weekday and hour as `atMs`,
// one, two and three weeks earlier (Postgres does the folding), turns 40..60.
async function seedCell(atMs, { count = 21, tableNo = 9 } = {}) {
  const { rows: [w] } = await pool.query(
    `SELECT EXTRACT(DOW FROM ($1::timestamptz AT TIME ZONE $2::text))::int AS dow,
            EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE $2::text))::int AS hour`,
    [new Date(atMs), ZONE]
  );
  for (let i = 0; i < count; i += 1) {
    // Minutes spread inside the hour, so no two are the same row.
    await seed(tableNo, await weeksEarlier(atMs, 1 + (i % 3), (i % 7) * 7), 40 + Math.round((20 * i) / (count - 1)));
  }
  return { dow: w.dow, hour: w.hour };
}

// A reading with tables, for the full hours.
const record = (at, total, occupied) => pool.query(
  `INSERT INTO venue_sensor_data (venue_place_id, sensor_device_id, recorded_at, ir_beam_count, thermal_headcount, noise_db, tables_total, tables_occupied)
   VALUES ($1, 'history_unit', $2, 1, 1, 60, $3, $4)`,
  [VENUE, new Date(at), total, occupied]
);

// --- The seatings statement ---------------------------------------------------------

test('on the real schema: a seating opens from free to seated dated by the timer, keeps the most people, closes from the clearing timer, and is cleared by the free reading after needs-clearing', async () => {
  await live('1:0:f:300;2:0:f:300');
  assert.deepEqual(await seatingRows(), []);
  const t2 = await live('1:2:s:90;2:0:f:390');
  let rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:2:-:open:-']);
  assert.equal(rows[0].seated_at.getTime(), t2 - 90 * 1000);
  assert.equal(rows[0].venue_place_id, VENUE);
  await live('1:3:s:150;2:0:f:450');
  await live('1:2:w:400;2:0:f:510');
  rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:3:w:open:-'], 'party_max is the most people seen, and the wait is remembered');
  const t5 = await live('1:0:c:40;2:0:f:570');
  rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:3:w:closed:-']);
  assert.equal(rows[0].left_at.getTime(), t5 - 40 * 1000, 'left when the table emptied, not when the box said so');
  const t6 = await live('1:0:f:10;2:0:f:630');
  rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:3:w:closed:cleared']);
  assert.equal(rows[0].cleared_at.getTime(), t6);
  assert.equal(rows.length, 1);
});

test('on the real schema: seated straight to free closes and clears at once; a first reading opens only seated or waiting tables; a removed table and a silent unit close theirs', async () => {
  const t = await live('1:2:s:1200;2:3:w:900;3:0:c:50;4:0:f:10');
  let rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:2:-:open:-', '2:3:w:open:-']);
  assert.deepEqual(rows.map((r) => t - r.seated_at.getTime()), [1200 * 1000, 900 * 1000]);

  const t2 = await live('1:0:f:5;3:0:f:5;4:0:f:40');
  rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:2:-:closed:cleared', '2:3:w:closed:-']);
  assert.equal(rows[0].left_at.getTime(), t2);
  assert.equal(rows[0].cleared_at.getTime(), t2, 'free straight away is cleared straight away');
  assert.equal(rows[1].left_at.getTime(), t2, 'table 2 left the reading, so its seating closed');
  assert.equal(rows[1].cleared_at, null);

  // The short visit that never seated: c then f at table 3 clears nothing.
  await live('1:0:f:35;3:0:c:95;4:0:f:70');
  await live('1:0:f:65;3:0:f:20;4:0:f:100');
  assert.deepEqual((await seatingRows()).map(shape), ['1:2:-:closed:cleared', '2:3:w:closed:-']);

  // A new party at 4, then ten minutes of silence about tables.
  await live('1:0:f:95;3:0:f:50;4:2:s:60');
  const { rows: [{ seen }] } = await pool.query(
    "UPDATE sensor_table_states SET updated_at = NOW() - INTERVAL '11 minutes' WHERE sensor_device_id = 'history_unit' AND table_no = 4 RETURNING updated_at AS seen"
  );
  await pool.query("UPDATE sensor_table_states SET updated_at = $1 WHERE sensor_device_id = 'history_unit'", [seen]);
  await pool.query("UPDATE sensor_table_seatings SET seated_at = $1::timestamptz - INTERVAL '30 minutes' WHERE sensor_device_id = 'history_unit' AND left_at IS NULL", [seen]);
  await ageUnit();
  const silent = await push(reading());
  assert.equal(silent.status, 201);
  await settle();
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM sensor_table_states WHERE sensor_device_id = 'history_unit'")).rows[0].n, 0);
  rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:2:-:closed:cleared', '2:3:w:closed:-', '4:2:-:closed:-']);
  assert.equal(rows[2].left_at.getTime(), seen.getTime() + 2 * MIN, 'closed when the table was last seen plus the grace, not at the reading that forgot the rows');
});

test('on the real schema: a close after an outage is dated when the table was last seen plus two minutes, never at the reading that noticed', async () => {
  const t = await live('1:2:s:600;2:3:s:300');
  // The box was off all night: its rows were last written eleven hours ago,
  // and the first reading back says every table is free.
  const { rows: [{ seen }] } = await pool.query(
    "UPDATE sensor_table_states SET updated_at = $1::timestamptz - INTERVAL '11 hours' WHERE sensor_device_id = 'history_unit' AND table_no = 1 RETURNING updated_at AS seen",
    [new Date(t)]
  );
  await pool.query("UPDATE sensor_table_states SET updated_at = $1 WHERE sensor_device_id = 'history_unit'", [seen]);
  await pool.query("UPDATE sensor_table_seatings SET seated_at = seated_at - INTERVAL '11 hours' WHERE sensor_device_id = 'history_unit'");
  await live('1:0:f:30;2:0:f:30');
  const rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:2:-:closed:cleared', '2:3:-:closed:cleared']);
  for (const r of rows) {
    assert.equal(r.left_at.getTime(), seen.getTime() + 2 * MIN);
    assert.equal(r.cleared_at.getTime(), seen.getTime() + 2 * MIN);
  }
});

test('on the real schema: a unit moved to another venue closes its open seatings at the old one and opens fresh ones at the new one', async () => {
  await live('3:2:s:600');
  await pool.query("UPDATE sensor_devices SET venue_place_id = 'ChIJvenueB' WHERE device_id = 'history_unit'");
  try {
    const t = await live('3:4:s:120');
    let rows = await seatingRows();
    assert.deepEqual(rows.map((r) => [r.venue_place_id, shape(r)]), [[VENUE, '3:2:-:closed:-'], ['ChIJvenueB', '3:4:-:open:-']]);
    assert.equal(rows[0].left_at.getTime(), t, 'the old venue\'s seating ends at the reading that came from the new one');
    assert.equal(rows[1].seated_at.getTime(), t - 120 * 1000);
    await live('3:0:c:30');
    await live('3:0:f:5');
    rows = await seatingRows();
    assert.deepEqual(rows.map((r) => [r.venue_place_id, shape(r)]), [[VENUE, '3:2:-:closed:-'], ['ChIJvenueB', '3:4:-:closed:cleared']], 'the clear lands on the new venue\'s seating only');
  } finally {
    await pool.query('UPDATE sensor_devices SET venue_place_id = $1 WHERE device_id = \'history_unit\'', [VENUE]);
  }
});

test('on the real schema: a history statement that fails is rolled back to its savepoint, the floor commits, and the next reading carries on', async () => {
  await live('1:2:s:100');
  // The table is renamed out from under the statement: 42P01 inside the
  // floor's transaction, which the savepoint has to contain.
  await pool.query('ALTER TABLE sensor_table_seatings RENAME TO sensor_table_seatings_away');
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  let t;
  try {
    t = await live('1:3:s:130');
  } finally {
    console.error = realError;
    await pool.query('ALTER TABLE sensor_table_seatings_away RENAME TO sensor_table_seatings');
  }
  const { rows: floor } = await pool.query("SELECT table_no, people, updated_at FROM sensor_table_states WHERE sensor_device_id = 'history_unit'");
  assert.deepEqual(floor.map((r) => [r.table_no, r.people, r.updated_at.getTime()]), [[1, 3, t]], 'the floor was lost with the history');
  assert.ok(logged.some((l) => /Table history for history_unit failed after the reading was stored; the floor was kept/.test(l)), logged.join('\n'));
  let rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:2:-:open:-'], 'the seating is as the last good reading left it');
  await live('1:4:s:160');
  rows = await seatingRows();
  assert.deepEqual(rows.map(shape), ['1:4:-:open:-'], 'the next reading continues the open seating');
});

test('on the real schema: an older reading arriving after a newer one writes no history', async () => {
  await live('1:2:s:100');
  const before = JSON.stringify(await seatingRows());
  await ageUnit();
  assert.equal((await push(reading({ recorded_at: new Date(Date.now() - 4 * MIN).toISOString(), tables: '1:0:c:5' }))).status, 201);
  await settle();
  assert.equal(JSON.stringify(await seatingRows()), before);
});

// --- The reads ------------------------------------------------------------------------

const FLOOR = `/api/sensors/${VENUE}/tables`;
const STATS = `/api/sensors/${VENUE}/tables/stats`;
const WAITS = `/api/sensors/${VENUE}/tables/waits`;
const INCOMING = `/api/sensors/${VENUE}/tables/incoming`;
const SETTINGS = `/api/sensors/${VENUE}/tables/settings`;
const SUMMARY = `/api/sensors/${VENUE}/tables/summary`;
const SUMMARIES = '/api/sensors/tables/summaries';

test('on the real schema: likely_free_at from the New York cell\'s median once twenty seatings exist there, the largest party in 30 days beside the seats, and the hours route says the zone', async () => {
  const t = await live('2:2:s:600;5:0:f:30');
  const since = t - 600 * 1000;
  await seedCell(since, { count: 19, tableNo: 2 });
  let res = await get(FLOOR, ownerId);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.tables[0].likely_free_at, null, 'nineteen is not a median');
  await pool.query('DELETE FROM sensor_table_seatings WHERE left_at IS NOT NULL');
  await seedCell(since, { count: 21, tableNo: 2 });
  res = await get(FLOOR, ownerId);
  assert.deepEqual(res.body.tables.map((x) => [x.number, x.seats, x.party_max, x.likely_free_at]), [
    [2, null, 2, new Date(since + 50 * MIN).toISOString()],
    [5, null, null, null],
  ], 'no unit count on either; the party sitting at 2 is the largest seen there');
  await seed(5, Date.now() - 31 * DAY, 60, { party: 8 });
  await seed(5, Date.now() - 2 * DAY, 60, { party: 0 });
  res = await get(FLOOR, ownerId);
  assert.equal(res.body.tables[1].party_max, null, 'a party outside 30 days and a party of nobody count for nothing');
  await seed(5, Date.now() - 2 * DAY, 60, { party: 5 });
  res = await get(FLOOR, ownerId);
  assert.deepEqual([res.body.tables[1].seats, res.body.tables[1].party_max], [null, 5]);

  const hours = await get(`/api/sensors/${VENUE}/tables/hours`, ownerId);
  assert.equal(hours.status, 200, hours.text);
  assert.equal(hours.body.timeZone, ZONE);
});

test('on the real schema: stats are the medians Postgres computes, folded on the venue\'s clock, with the twenty-seating floor and the full hours from the readings', async () => {
  const now = Date.now();
  const at = Math.floor((now - 3 * DAY) / HOUR) * HOUR + 5 * MIN;
  const cell = await seedCell(at, { count: 21, tableNo: 1 });
  // Flags on the twenty-one: every third waited, all but the last cleared in
  // 4..23 minutes.
  const { rows: seeded } = await pool.query('SELECT id FROM sensor_table_seatings ORDER BY id');
  for (let i = 0; i < seeded.length; i += 1) {
    await pool.query(
      `UPDATE sensor_table_seatings SET waited = $2, cleared_at = CASE WHEN $3::int IS NULL THEN NULL ELSE left_at + ($3::int * INTERVAL '1 minute') END WHERE id = $1`,
      [seeded[i].id, i % 3 === 0, i === 20 ? null : 4 + i]
    );
  }
  // Readings on the same weekday and hour over the last four weeks (the full
  // hours floor: four dates and ten readings): an hour full in 8 of 10
  // readings each week (0.8) and one in 3 of 10 (0.3); an hour full in every
  // reading but seen on three weeks only; one full in every reading on four
  // weeks but nine readings in all.
  const full = Math.floor((now - 2 * DAY) / HOUR) * HOUR + 5 * MIN;
  const weeks = [full, await weeksEarlier(full, 1), await weeksEarlier(full, 2), await weeksEarlier(full, 3)];
  for (const [w, week] of weeks.entries()) {
    for (let i = 0; i < 10; i += 1) {
      await record(week + i * MIN, 4, i < 8 ? 4 : 3);
      await record(week - 5 * HOUR + i * MIN, 4, i < 3 ? 4 : 2);
      if (w < 3) await record(week - 7 * HOUR + i * MIN, 4, 4);
    }
    for (let i = 0; i < (w === 3 ? 3 : 2); i += 1) await record(week - 9 * HOUR + i * MIN, 4, 4);
  }
  const res = await get(STATS, ownerId);
  assert.equal(res.status, 200, res.text);
  const { rows: [fullCell] } = await pool.query(
    `SELECT EXTRACT(DOW FROM ($1::timestamptz AT TIME ZONE $2::text))::int AS dow, EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE $2::text))::int AS hour`,
    [new Date(full), ZONE]
  );
  assert.deepEqual(res.body, {
    days: 28,
    seatings: 21,
    turn_minutes: { median: 50, by_hour: [{ dow: cell.dow, hour: cell.hour, median: 50, seatings: 21 }] },
    waited_share: 0.333,
    clear_minutes_median: 13.5,
    full_hours: [{ dow: fullCell.dow, hour: fullCell.hour, share: 0.8 }],
    timeZone: ZONE,
  }, 'the hour seen three weeks and the hour seen nine times are not "usually" anything');

  // In UTC the same seatings fold into a different hour, and the answer says so.
  await pool.query('DELETE FROM ml_venues WHERE google_place_id = $1', [VENUE]);
  try {
    const utc = await get(STATS, ownerId);
    assert.equal(utc.body.timeZone, null, 'null means UTC, as on /tables/hours');
    assert.notEqual(utc.body.turn_minutes.by_hour[0].hour, cell.hour, 'New York is never on UTC');
    assert.equal(utc.body.turn_minutes.median, 50);
  } finally {
    await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
       VALUES ($1, 'The History Bar', 'historytown', 40.6, -75.4, 'bar', $2)`,
      [VENUE, ZONE]
    );
  }
  // Below twenty, nothing is said.
  await pool.query('DELETE FROM sensor_table_seatings WHERE id IN (SELECT id FROM sensor_table_seatings ORDER BY id DESC LIMIT 2)');
  const few = await get(STATS, ownerId);
  assert.equal(few.body.seatings, 19);
  assert.deepEqual([few.body.turn_minutes.median, few.body.waited_share, few.body.clear_minutes_median], [null, null, null]);
  // The window asked for: a week sees none of them (the nearest are ten days
  // back), two weeks see the seven from one week before `at`.
  const week = await get(`${STATS}?days=7`, ownerId);
  assert.deepEqual([week.body.days, week.body.seatings], [7, 0]);
  const fortnight = await get(`${STATS}?days=14`, ownerId);
  assert.deepEqual([fortnight.body.days, fortnight.body.seatings], [14, 7]);
});

test('on the real schema: the waits by party, the incoming feed over the real flock tables with a suggestion and no name, and the switches', async () => {
  // Table 3 is counted at four, so six and eight are known not to fit it.
  const t = await live('1:0:f:60:2;2:2:s:600;3:0:f:30:4;4:4:s:1200:6;5:0:c:30:8');
  await seedCell(t - 1200 * 1000, { count: 21, tableNo: 4 });
  const waits = await get(WAITS, ownerId);
  assert.equal(waits.status, 200, waits.text);
  assert.deepEqual(waits.body, {
    updated_at: new Date(t).toISOString(),
    stale: false,
    by_party: [
      { party: 2, open_now: true, minutes: 0, table: 1 },
      { party: 4, open_now: true, minutes: 0, table: 3 },
      { party: 6, open_now: false, minutes: 30, table: 4 },
      { party: 8, open_now: false, minutes: null, table: null },
    ],
  });

  // Three plans on the real tables: a party of six in ten minutes, one in an
  // hour, and a party of four in two hours, each with a name that must stay
  // behind.
  const members = [];
  for (let i = 0; i < 6; i += 1) {
    const { rows: [m] } = await pool.query(
      "INSERT INTO users (name, email, password) VALUES ($1, $2, 'x') RETURNING id",
      [`Member ${i}`, `member${i}.history@example.com`]
    );
    members.push(m.id);
  }
  const flockIds = [];
  try {
    const plan = async (name, minutesAhead, size, status = 'confirmed') => {
      const { rows: [f] } = await pool.query(
        `INSERT INTO flocks (name, creator_id, venue_id, status, event_time)
         VALUES ($1, $2, $3, $4, (NOW() AT TIME ZONE 'UTC') + ($5::int * INTERVAL '1 minute')) RETURNING id`,
        [name, members[0], VENUE, status, minutesAhead]
      );
      for (const m of members.slice(0, size)) {
        await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [f.id, m]);
      }
      flockIds.push(f.id);
      return f.id;
    };
    const soonSix = await plan("Emma's 21st", 10, 6);
    const laterSix = await plan('Sarah leaving do', 60, 6, 'planning');
    const four = await plan('Dan + Priya anniversary', 120, 4);
    const res = await get(INCOMING, ownerId);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.flocks.map((f) => [f.id, f.party, f.status, f.suggestion]), [
      [soonSix, 6, 'confirmed', null],
      [laterSix, 6, 'planning', { table: 4, free_now: false, likely_free_at: new Date(t - 1200 * 1000 + 50 * MIN).toISOString() }],
      [four, 4, 'confirmed', { table: 3, free_now: true, likely_free_at: null }],
    ]);
    for (const typed of ['Emma', 'Sarah', 'Priya', 'Member', 'name', 'title']) {
      assert.ok(!res.text.includes(typed), `"${typed}" reached the owner`);
    }
    assert.ok(res.body.flocks.every((f) => typeof f.event_time === 'string'));
  } finally {
    for (const id of flockIds) await pool.query('DELETE FROM flocks WHERE id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [members]);
  }

  // The switches: jsonb merge for alerts, the column for show_in_app, the
  // verified owner only.
  assert.deepEqual((await get(SETTINGS, ownerId)).body, { show_in_app: true, alerts: true });
  let put = await api('PUT', SETTINGS, { user: ownerId, body: { alerts: false } });
  assert.deepEqual([put.status, put.body], [200, { show_in_app: true, alerts: false }]);
  const { rows: [prefs] } = await pool.query('SELECT notification_prefs, tables_in_app FROM venue_profiles WHERE user_id = $1', [ownerId]);
  assert.deepEqual(prefs.notification_prefs, { bookings: true, tables: false }, 'merged into the other switches');
  assert.equal(prefs.tables_in_app, true);
  put = await api('PUT', SETTINGS, { user: ownerId, body: { show_in_app: false } });
  assert.deepEqual(put.body, { show_in_app: false, alerts: false });
  assert.equal((await api('PUT', SETTINGS, { user: userId, body: { show_in_app: true } })).status, 403, 'a stranger wrote a switch');
  assert.equal((await get(SETTINGS, userId)).status, 403);
  // A prefs column holding something other than an object starts from empty.
  await pool.query("UPDATE venue_profiles SET notification_prefs = '\"legacy\"'::jsonb WHERE user_id = $1", [ownerId]);
  put = await api('PUT', SETTINGS, { user: ownerId, body: { alerts: true } });
  assert.deepEqual(put.body, { show_in_app: false, alerts: true });
  assert.deepEqual((await pool.query('SELECT notification_prefs FROM venue_profiles WHERE user_id = $1', [ownerId])).rows[0].notification_prefs, { tables: true });
});

test('on the real schema: the public summary is counts and minutes, absent for a hidden or dayold floor, and the batch reads every venue in one statement each', async () => {
  const now = Date.now();
  const t = await live('1:0:f:60:2;2:2:s:600;3:0:f:30:4;4:4:s:1200:6;5:0:c:30:8');
  await seedCell(t - 1200 * 1000, { count: 21, tableNo: 4 });
  // An hour full in 6 of 10 readings each week for four weeks: a busy hour.
  const full = Math.floor((now - 2 * DAY) / HOUR) * HOUR + 5 * MIN;
  for (const week of [full, await weeksEarlier(full, 1), await weeksEarlier(full, 2), await weeksEarlier(full, 3)]) {
    for (let i = 0; i < 10; i += 1) await record(week + i * MIN, 5, i < 6 ? 5 : 4);
  }
  const { rows: [fullCell] } = await pool.query(
    `SELECT EXTRACT(DOW FROM ($1::timestamptz AT TIME ZONE $2::text))::int AS dow, EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE $2::text))::int AS hour`,
    [new Date(full), ZONE]
  );
  let res = await get(`${SUMMARY}?party=6`, userId);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, {
    open: 2, total: 5, party: 6, fits_now: false, wait_minutes: 30,
    busy_hours: [{ dow: fullCell.dow, hour: fullCell.hour }], timeZone: ZONE,
    updated_at: new Date(t).toISOString(), stale: false,
  });
  assert.ok(!/"number"|"table"|history_unit|seated|waiting|needs_clearing|"since"|seats/.test(res.text), res.text);
  assert.equal((await get(SUMMARY)).status, 401);

  const batch = await api('POST', SUMMARIES, { user: userId, body: { place_ids: [VENUE, 'ChIJnobodyAtAll000001'], party: 2 } });
  assert.equal(batch.status, 200, batch.text);
  assert.deepEqual(Object.keys(batch.body.summaries), [VENUE]);
  assert.deepEqual([batch.body.summaries[VENUE].fits_now, batch.body.summaries[VENUE].wait_minutes, batch.body.summaries[VENUE].party], [true, 0, 2]);

  // Hidden by the owner: a 404, and absent from the batch.
  assert.equal((await api('PUT', SETTINGS, { user: ownerId, body: { show_in_app: false } })).status, 200);
  res = await get(SUMMARY, userId);
  assert.deepEqual([res.status, res.body], [404, { error: 'No table data for this venue.' }]);
  assert.deepEqual((await api('POST', SUMMARIES, { user: userId, body: { place_ids: [VENUE] } })).body, { summaries: {} });
  assert.equal((await get(FLOOR, ownerId)).status, 200, 'the owner still sees the floor');
  assert.equal((await api('PUT', SETTINGS, { user: ownerId, body: { show_in_app: true } })).status, 200);
  assert.equal((await get(SUMMARY, userId)).status, 200);

  // A floor older than a day is no data; one four minutes old is stale.
  await pool.query("UPDATE sensor_table_states SET updated_at = NOW() - INTERVAL '4 minutes' WHERE sensor_device_id = 'history_unit'");
  res = await get(SUMMARY, userId);
  assert.equal(res.body.stale, true);
  await pool.query("UPDATE sensor_table_states SET updated_at = NOW() - INTERVAL '25 hours' WHERE sensor_device_id = 'history_unit'");
  assert.equal((await get(SUMMARY, userId)).status, 404);
});

test('on the real schema: a seating longer than six hours is an outage, not a turn, and is left out of the medians and the count', async () => {
  const t = await live('2:2:s:600');
  const since = t - 600 * 1000;
  await seedCell(since, { count: 21, tableNo: 2 });
  // One 700-minute "turn" in the same cell, which would move its median to 50.5.
  await seed(2, await weeksEarlier(since, 1, 20), 700);
  const floor = await get(FLOOR, ownerId);
  assert.equal(floor.body.tables[0].likely_free_at, new Date(since + 50 * MIN).toISOString(), 'the cell median is still 50');
  const stats = await get(STATS, ownerId);
  assert.deepEqual([stats.body.seatings, stats.body.turn_minutes.median], [21, 50]);
});

test('on the real schema: a second unit that has gone dark stays on the owner\'s floor but counts for nothing open, and a free table nobody has counted is a fit nobody can judge above four', async () => {
  // The back room, unplugged at close ten minutes ago with every table free;
  // nothing ever removes its rows.
  await pool.query(
    `INSERT INTO sensor_devices (device_id, venue_place_id, api_key, device_name, is_active)
     VALUES ('back_room_unit', $1, $2, 'back room', true)`,
    [VENUE, digestOf('b'.repeat(64))]
  );
  await pool.query(
    `INSERT INTO sensor_table_states (sensor_device_id, table_no, venue_place_id, people, state, state_since, updated_at)
     SELECT 'back_room_unit', n, $1, 0, 'f', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '10 minutes' FROM unnest(ARRAY[11, 12, 13]) AS n`,
    [VENUE]
  );
  // The front room, live and full.
  const t = await live('1:2:s:600;2:4:s:300');
  const floor = await get(FLOOR, ownerId);
  assert.equal(floor.status, 200, floor.text);
  assert.deepEqual(floor.body.tables.map((x) => x.number), [1, 2, 11, 12, 13], 'the owner sees every unit\'s tables');
  assert.equal(floor.body.stale, false);

  let summary = await get(`${SUMMARY}?party=2`, userId);
  assert.equal(summary.status, 200, summary.text);
  const { busy_hours, ...counts } = summary.body;
  assert.ok(Array.isArray(busy_hours));
  assert.deepEqual(counts, {
    open: 0, total: 2, party: 2, fits_now: false, wait_minutes: null, timeZone: ZONE,
    updated_at: new Date(t).toISOString(), stale: false,
  }, 'the back room\'s free tables are not open now');
  let waits = await get(WAITS, ownerId);
  assert.deepEqual(waits.body.by_party, [2, 4, 6, 8].map((party) => ({ party, open_now: false, minutes: null, table: null })));

  // The back room comes back: its tables are open, and table 11, which nobody
  // has counted or sat at, fits four and might fit six.
  await pool.query("UPDATE sensor_table_states SET updated_at = NOW() WHERE sensor_device_id = 'back_room_unit'");
  summary = await get(`${SUMMARY}?party=4`, userId);
  assert.deepEqual([summary.body.open, summary.body.total, summary.body.fits_now, summary.body.wait_minutes], [3, 5, true, 0]);
  summary = await get(`${SUMMARY}?party=6`, userId);
  assert.deepEqual([summary.body.fits_now, summary.body.wait_minutes], [null, null], 'neither "fits" nor "none fits" is claimed for six');
  waits = await get(WAITS, ownerId);
  assert.deepEqual(waits.body.by_party[2], { party: 6, open_now: null, minutes: null, table: 11 });
});

test('on the real schema: the seats fallback is the venue\'s own history, so a unit\'s seatings at its old venue never stand in for its tables at the new one, in the batch or alone', async () => {
  const VENUE_B = 'ChIJtableHistoryStatement02';
  // A unit now at VENUE_B with table 3 free and uncounted, whose seatings at
  // VENUE (where it used to be) sat a party of eight at table 3.
  await pool.query(
    `INSERT INTO sensor_devices (device_id, venue_place_id, api_key, device_name, is_active)
     VALUES ('moved_unit', $1, $2, 'moved', true)`,
    [VENUE_B, digestOf('m'.repeat(64))]
  );
  await pool.query(
    `INSERT INTO sensor_table_states (sensor_device_id, table_no, venue_place_id, people, state, state_since, updated_at)
     VALUES ('moved_unit', 3, $1, 0, 'f', NOW() - INTERVAL '20 minutes', NOW())`,
    [VENUE_B]
  );
  await seed(3, Date.now() - 2 * DAY, 60, { party: 8, device: 'moved_unit', place: VENUE });
  await live('1:0:f:30');
  const batch = await api('POST', SUMMARIES, { user: userId, body: { place_ids: [VENUE, VENUE_B], party: 8 } });
  assert.equal(batch.status, 200, batch.text);
  assert.deepEqual(Object.keys(batch.body.summaries).sort(), [VENUE, VENUE_B].sort());
  assert.equal(batch.body.summaries[VENUE_B].fits_now, null, 'eight seated at VENUE say nothing about VENUE_B\'s table 3');
  const alone = await get(`/api/sensors/${VENUE_B}/tables/summary?party=8`, userId);
  assert.equal(alone.status, 200, alone.text);
  assert.equal(alone.body.fits_now, batch.body.summaries[VENUE_B].fits_now, 'the batch and the single read agree');
  assert.equal(batch.body.summaries[VENUE_B].timeZone, null, 'VENUE_B is outside the corpus: its busy hours are UTC');
  assert.equal(batch.body.summaries[VENUE].timeZone, ZONE);
});
