'use strict';
// ---------------------------------------------------------------------------
// THE ONE-STATEMENT SENSOR INGEST, AGAINST A REAL POSTGRES.
// ---------------------------------------------------------------------------
// routes/sensors.js files a reading in ONE statement (INGEST_SQL): the key
// lookup, the duplicate check, the flood guard, the liveness touch and the
// insert, each a CTE, because every statement was a network round trip to a
// database that is not on the same machine. sensorIngest.test.js and
// sensorIngestionIntegrity.test.js pin the contract against a modelled store;
// a model cannot say whether Postgres runs the statement the way the model
// assumes. The properties below are server behaviour, so they are driven
// through the real router against a real, migrated schema:
//
//   * the reading is committed BEFORE the response is written, and the live
//     broadcast happens AFTER it, where a failure cannot change the answer;
//   * one push is one statement;
//   * the guard still binds when two pushes race, because the WHERE clause,
//     the touch and the insert are one statement under one row lock;
//   * every refusal writes nothing and touches nothing, including a body that
//     failed validation, whose values must never reach a typed parameter.
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

// Before anything can reach config/database.js: backend/.env points at the
// live Railway database, and dotenv never overrides a variable already set.
const PG_PORT = pickEmbeddedPgPort('sensorIngestStatement');
const DB_NAME = 'flock_sensor_ingest_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-sensor-ingest-statement';

let pg;
let pool;
let dataDir;
let server;
let base;

// Swappable per test: the order log and the broadcast behaviour.
let events = [];
let lastEmit = null;
let emitImpl = () => {};
const io = { to: (room) => ({ emit: (event, payload) => emitImpl(room, event, payload) }) };

const KEY = 'e'.repeat(64);
const DEAD_KEY = 'd'.repeat(64);
const VENUE = 'ChIJsensorStatementVenue01';
const digestOf = (key) => 'sha256:' + crypto.createHash('sha256').update(key, 'utf8').digest('hex');

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-sensor-ingest-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'sensorIngestStatement', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const app = express();
  app.use(express.json());
  app.set('io', io);
  // Records the moment the handler writes its answer, so the order of
  // "stored", "responded" and "broadcast" can be asserted rather than assumed.
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => { events.push(`responded ${res.statusCode}`); return json(body); };
    next();
  });
  // The read routes sit behind authenticate(), which is not what this suite
  // tests; it is stubbed BEFORE the router is required, because the router
  // destructures it at load. A test that needs a particular caller (the table
  // routes' owner gate) names it in a header; everything else is user 1.
  require('../middleware/auth').authenticate = (req, _res, next) => {
    req.user = { id: Number(req.headers['x-test-user']) || 1, name: 'Owner', role: 'user' };
    next();
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

test.beforeEach(async () => {
  // A live reading with tables writes the table floor after its answer. Let
  // the last test's writes land before the devices they name are deleted.
  await require('../services/sensorTables')._settled();
  events = [];
  emitImpl = (room, event, payload) => { events.push('broadcast'); lastEmit = { room, event, payload }; };
  lastEmit = null;
  await pool.query('DELETE FROM venue_sensor_data WHERE true');
  await pool.query('DELETE FROM sensor_devices WHERE true');
  await pool.query(
    `INSERT INTO sensor_devices (device_id, venue_place_id, api_key, device_name, is_active)
     VALUES ('sensor_live', $1, $2, 'front door', true),
            ('sensor_dead', $1, $3, 'retired', false)`,
    [VENUE, digestOf(KEY), digestOf(DEAD_KEY)]
  );
});

async function push(body, key = KEY) {
  const res = await fetch(`${base}/api/sensors/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const reading = (extra = {}) => ({ ir_beam_count: 6, thermal_headcount: 11, noise_db: 70.5, ...extra });
const rows = async () => (await pool.query(
  'SELECT sensor_device_id, venue_place_id, ir_beam_count, thermal_headcount, noise_db, recorded_at FROM venue_sensor_data ORDER BY recorded_at'
)).rows;
const lastSeen = async (deviceId) => (await pool.query(
  'SELECT last_seen_at FROM sensor_devices WHERE device_id = $1', [deviceId]
)).rows[0].last_seen_at;

// Counts every statement the route sends, and logs the moment the one that
// writes the reading has come back committed.
function spyOnPool() {
  const real = pool.query;
  const sent = [];
  pool.query = function spied(sql, params) {
    sent.push(String(sql));
    return real.call(this, sql, params).then((r) => {
      if (/INSERT INTO venue_sensor_data/.test(String(sql))) events.push('stored');
      return r;
    });
  };
  return { sent, restore: () => { pool.query = real; } };
}

test('a live push is committed before the response is written, and broadcast only after it', async () => {
  const spy = spyOnPool();
  let res;
  try {
    res = await push(reading({ recorded_at: new Date().toISOString(), device_id: 'sensor_live' }));
  } finally {
    spy.restore();
  }
  assert.equal(res.status, 201);
  assert.deepEqual(events, ['stored', 'responded 201', 'broadcast']);
  const stored = await rows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sensor_device_id, 'sensor_live');
  assert.equal(stored[0].venue_place_id, VENUE, 'the venue comes from the device row');
  assert.equal(new Date(res.body.recorded_at).getTime(), stored[0].recorded_at.getTime());
  assert.equal(lastEmit.room, `venue:${VENUE}`);
  assert.equal(spy.sent.length, 1, 'a push is one statement, one round trip');
});

test('a broadcast that throws after the write changes neither the answer nor the stored reading', async () => {
  emitImpl = () => { events.push('broadcast'); throw new Error('socket layer exploded'); };
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  let res;
  try {
    res = await push(reading());
  } finally {
    console.error = realError;
  }
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal((await rows()).length, 1, 'the reading is stored whatever the broadcast did');
  assert.deepEqual(events, ['responded 201', 'broadcast']);
  assert.ok(logged.some((l) => /broadcast failed after the reading was stored/.test(l)), logged.join('\n'));
});

test('two live pushes racing from one device: exactly one is stored, the other is told how long to wait', async () => {
  const now = Date.now();
  const [a, b] = await Promise.all([
    push(reading({ recorded_at: new Date(now - 1000).toISOString() })),
    push(reading({ recorded_at: new Date(now - 2000).toISOString() })),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 429]);
  const refused = a.status === 429 ? a : b;
  assert.equal(refused.headers.get('retry-after'), '2');
  assert.equal(refused.body.retry_after_seconds, 2);
  assert.equal((await rows()).length, 1);
});

test('a re-delivered stamp writes nothing, answers duplicate, and still counts as a sign of life', async () => {
  const stamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const first = await push(reading({ recorded_at: stamp }));
  assert.equal(first.status, 201);
  await pool.query(`UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`);

  events = [];
  const again = await push(reading({ recorded_at: stamp, ir_beam_count: 9999 }));
  assert.equal(again.status, 201);
  assert.equal(again.body.duplicate, true);
  assert.equal(new Date(again.body.recorded_at).toISOString(), stamp);
  const stored = await rows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].ir_beam_count, 6, 'the replay overwrote the stored reading');
  assert.ok(Date.now() - (await lastSeen('sensor_live')).getTime() < 60000, 'a re-delivery must touch last_seen_at');
  assert.ok(!events.includes('broadcast'), 'a duplicate is not news');
});

test('a duplicate is never charged against the flood guard, so an honest retry is not told 429', async () => {
  const stamp = new Date(Date.now() - 3000).toISOString();
  assert.equal((await push(reading({ recorded_at: stamp }))).status, 201);
  const retry = await push(reading({ recorded_at: stamp }));
  assert.equal(retry.status, 201);
  assert.equal(retry.body.duplicate, true);
});

// Waits until `n` ingest statements are blocked on a lock, so a test knows both
// have taken their snapshot before it lets either one go.
async function blockedIngests(n) {
  for (let i = 0; i < 200; i += 1) {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO venue_sensor_data%'`
    );
    if (r.n >= n) return r.n;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return 0;
}

test('two deliveries of one old reading racing each other store it once, and the second is answered as a duplicate', async () => {
  // THE RACE. A reading stamped an hour ago is backfill, so no flood guard
  // stands between two deliveries of it, and each statement's duplicate check
  // reads the snapshot it started with. Two that start before either commits
  // both see nothing, and both used to insert: the hourly sum counted the
  // doorway twice. The device row is held here so both statements start, take
  // their snapshot, and wait on the liveness touch before either may finish.
  const stamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const blocker = await pool.connect();
  let deliveries;
  let waiting = 0;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT 1 FROM sensor_devices WHERE device_id = 'sensor_live' FOR UPDATE");
    deliveries = [push(reading({ recorded_at: stamp })), push(reading({ recorded_at: stamp }))];
    waiting = await blockedIngests(2);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
  const answers = await Promise.all(deliveries);
  assert.equal(waiting, 2, 'both deliveries must be in flight at once for this to test the race');

  const stored = await rows();
  assert.equal(stored.length, 1, 'one reading, delivered twice at once, was stored twice');
  assert.deepEqual(answers.map((a) => a.status), [201, 201], 'both deliveries are successes to the device');
  const dup = answers.filter((a) => a.body.duplicate === true);
  assert.equal(dup.length, 1, `exactly one answer is the duplicate: ${JSON.stringify(answers.map((a) => a.body))}`);
  // Exactly the answer the ordinary re-delivery path gives.
  assert.deepEqual(Object.keys(dup[0].body).sort(), ['duplicate', 'recorded_at', 'success']);
  assert.equal(dup[0].body.success, true);
  assert.equal(new Date(dup[0].body.recorded_at).toISOString(), stamp);
  const kept = answers.find((a) => a.body.duplicate !== true);
  assert.deepEqual(Object.keys(kept.body).sort(), ['recorded_at', 'success']);
  assert.equal(new Date(kept.body.recorded_at).toISOString(), stamp);
  assert.ok(await lastSeen('sensor_live'), 'a re-delivery still counts as a sign of life');
  assert.ok(!events.includes('broadcast'), 'backfill is not news, and neither is a duplicate');
});

test('the database holds the rule: a second row for one device and instant is refused however it is written', async () => {
  const stamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  assert.equal((await push(reading({ recorded_at: stamp }))).status, 201);
  await assert.rejects(
    pool.query(
      `INSERT INTO venue_sensor_data (venue_place_id, ir_beam_count, thermal_headcount, noise_db, sensor_device_id, recorded_at)
       VALUES ($1, 1, 1, 1, 'sensor_live', $2::timestamptz)`,
      [VENUE, stamp]
    ),
    (err) => err.code === '23505',
  );
  assert.equal((await rows()).length, 1);
});

test('genuinely old backfill drains unthrottled, is stored, touches the device and is not broadcast', async () => {
  const fortyMinutesAgo = Date.now() - 40 * 60 * 1000;
  for (let i = 0; i < 3; i++) {
    const res = await push(reading({ recorded_at: new Date(fortyMinutesAgo + i * 30000).toISOString() }));
    assert.equal(res.status, 201, `backfilled reading ${i} was refused`);
  }
  assert.equal((await rows()).length, 3);
  assert.ok(await lastSeen('sensor_live'), 'backfill still proves the device is alive');
  assert.ok(!events.includes('broadcast'));
});

test('a reading with no timestamp is filed at the server clock and is rate limited like any live one', async () => {
  const first = await push(reading());
  const second = await push(reading());
  assert.equal(first.status, 201);
  assert.ok(Math.abs(new Date(first.body.recorded_at).getTime() - Date.now()) < 10000);
  assert.equal(second.status, 429);
  assert.equal((await rows()).length, 1);
});

test('numeric strings the validator admits are stored as numbers, exactly as the old VALUES insert stored them', async () => {
  const res = await push({ ir_beam_count: '12', thermal_headcount: '3', noise_db: '1e2' });
  assert.equal(res.status, 201);
  const [row] = await rows();
  assert.equal(row.ir_beam_count, 12);
  assert.equal(row.thermal_headcount, 3);
  assert.equal(Number(row.noise_db), 100);
});

test('a body that failed validation is a 400, never a 500: its values are not bound as typed parameters', async () => {
  for (const body of [
    reading({ ir_beam_count: 'abc' }),
    reading({ noise_db: 'loud' }),
    reading({ recorded_at: 'yesterday-ish' }),
    reading({ thermal_headcount: 1001 }),
  ]) {
    const res = await push(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.equal((await rows()).length, 0);
  assert.equal(await lastSeen('sensor_live'), null, 'a refused body must not touch the device');
});

test('every refusal writes nothing and touches nothing', async () => {
  const cases = [
    ['unknown key', () => push(reading(), 'not-a-real-key'), 401],
    ['stored digest replayed as the key', () => push(reading(), digestOf(KEY)), 401],
    ['deactivated device', () => push(reading(), DEAD_KEY), 403],
    ['another device\'s id', () => push(reading({ device_id: 'sensor_dead' })), 403],
    ['a device_id that is not a string', () => push(reading({ device_id: ['sensor_live'] })), 400],
    ['a dry run', () => push(reading({ dry_run: 'true' })), 200],
    ['a stamp from the future', () => push(reading({ recorded_at: new Date(Date.now() + 3600000).toISOString() })), 400],
    ['a stamp older than the backfill window', () => push(reading({ recorded_at: new Date(Date.now() - 49 * 3600000).toISOString() })), 400],
  ];
  for (const [name, run, expected] of cases) {
    const res = await run();
    assert.equal(res.status, expected, `${name}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.equal((await rows()).length, 0);
  assert.equal(await lastSeen('sensor_live'), null);
  assert.equal(await lastSeen('sensor_dead'), null);
  assert.ok(!events.includes('broadcast'));
});

test('a dry run still names the device, so an installer can tell which unit answered', async () => {
  const res = await push(reading({ dry_run: true, device_id: 'sensor_live' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, dry_run: true, device_id: 'sensor_live' });
});

// --- The occupancy estimate, through the real schema -------------------------
//
// Migration 095 added four nullable columns. The model suites prove the route
// hands them over; these prove Postgres stores them, /current returns them and
// /history averages them, and that an older device's row still stores cleanly.
const estimateRows = async () => (await pool.query(
  'SELECT occupancy, occupancy_low, occupancy_high, dwell_minutes FROM venue_sensor_data ORDER BY recorded_at'
)).rows;
const getJson = async (p) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
};

test('an occupancy estimate is stored, returned by /current and broadcast', async () => {
  const res = await push(reading({ occupancy: 12, occupancy_low: 10, occupancy_high: 14, dwell_minutes: 45 }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(await estimateRows(),
    [{ occupancy: 12, occupancy_low: 10, occupancy_high: 14, dwell_minutes: 45 }]);
  const current = await getJson(`/api/sensors/${VENUE}/current`);
  assert.equal(current.status, 200);
  const sd = current.body.sensor_data;
  assert.deepEqual([sd.occupancy, sd.occupancy_low, sd.occupancy_high, sd.dwell_minutes], [12, 10, 14, 45]);
  assert.equal(sd.thermal_headcount, 11, 'the thermal count is still returned beside it');
  assert.equal(lastEmit.payload.occupancy, 12);
});

test('an older device sends no estimate: the row stores null for all four and /current says so', async () => {
  const res = await push(reading());
  assert.equal(res.status, 201);
  assert.deepEqual(await estimateRows(),
    [{ occupancy: null, occupancy_low: null, occupancy_high: null, dwell_minutes: null }]);
  const sd = (await getJson(`/api/sensors/${VENUE}/current`)).body.sensor_data;
  assert.equal(sd.occupancy, null);
  assert.equal(sd.thermal_headcount, 11);
});

test('a band out of order is stored as null beside the kept estimate, and the device is answered 201', async () => {
  const res = await push(reading({ occupancy: 12, occupancy_low: 15, occupancy_high: 20, dwell_minutes: 30 }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(await estimateRows(),
    [{ occupancy: 12, occupancy_low: null, occupancy_high: null, dwell_minutes: 30 }]);
});

test('an array-shaped or out of range estimate is a 400, never a 500, and writes nothing', async () => {
  for (const body of [
    reading({ occupancy: [12] }),
    reading({ occupancy: 12, occupancy_low: ['10'] }),
    reading({ dwell_minutes: { $gt: 0 } }),
    reading({ occupancy: 5001 }),
    reading({ dwell_minutes: 0 }),
  ]) {
    const res = await push(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.equal((await rows()).length, 0);
});

test('the hourly history averages the estimate and skips the readings that had none', async () => {
  const hourStart = new Date();
  hourStart.setUTCMinutes(0, 0, 0);
  // Three backfilled readings inside one past hour: two with an estimate, one
  // from before the firmware sent it.
  const lastHour = hourStart.getTime() - 60 * 60 * 1000;
  const stamps = [5, 10, 15].map((m) => new Date(lastHour + m * 60 * 1000).toISOString());
  assert.equal((await push(reading({ recorded_at: stamps[0], occupancy: 10, occupancy_low: 8, occupancy_high: 12, dwell_minutes: 40 }))).status, 201);
  assert.equal((await push(reading({ recorded_at: stamps[1], occupancy: 20, occupancy_low: 17, occupancy_high: 23, dwell_minutes: 50 }))).status, 201);
  assert.equal((await push(reading({ recorded_at: stamps[2] }))).status, 201);
  const hist = await getJson(`/api/sensors/${VENUE}/history?hours=24`);
  assert.equal(hist.status, 200);
  assert.equal(hist.body.readings.length, 1);
  const h = hist.body.readings[0];
  assert.deepEqual([h.occupancy, h.occupancy_low, h.occupancy_high, h.dwell_minutes], [15, 13, 18, 45]);
  assert.equal(h.sample_count, 3);
  assert.equal(h.thermal_headcount, 11);
});

// --- Table monitoring, through the real schema ------------------------------
//
// Migration 130 added four nullable table counts to each reading. The model
// suite (sensorTables.test.js) proves the route hands them over; these prove
// Postgres stores them through $16-$19, and that a tables value the strict
// parse ignores still leaves the reading itself stored and answered 201.
const EXAMPLE_TABLES = '1:0:f:340;2:3:s:845;3:2:w:410;4:0:c:95';
const tableCountRows = async () => (await pool.query(
  `SELECT ir_beam_count, tables_total, tables_occupied, tables_waiting, tables_to_clear
     FROM venue_sensor_data ORDER BY recorded_at`
)).rows;

test('a tables string is counted onto the stored reading; a bad one leaves the reading stored with null counts', async () => {
  const good = await push(reading({ tables: EXAMPLE_TABLES }));
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.deepEqual(Object.keys(good.body).sort(), ['recorded_at', 'success']);
  // Backfill, so the flood guard the live push just armed does not apply.
  const bad = await push(reading({ recorded_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), tables: '3:1:s:5;2:0:f:9' }));
  assert.equal(bad.status, 201, JSON.stringify(bad.body));
  assert.deepEqual(await tableCountRows(), [
    { ir_beam_count: 6, tables_total: null, tables_occupied: null, tables_waiting: null, tables_to_clear: null },
    { ir_beam_count: 6, tables_total: 4, tables_occupied: 2, tables_waiting: 1, tables_to_clear: 1 },
  ]);
});

test('a tables value of the wrong shape is a 201 and a stored reading, never a 400 or a 500', async () => {
  const base = Date.now() - 40 * 60 * 1000;
  const shapes = [['1:0:f:5'], { $gt: '' }, 12, 'x'.repeat(801)];
  for (let i = 0; i < shapes.length; i += 1) {
    const res = await push(reading({ recorded_at: new Date(base + i * 30000).toISOString(), tables: shapes[i] }));
    assert.equal(res.status, 201, `${JSON.stringify(shapes[i]).slice(0, 40)} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  const stored = await tableCountRows();
  assert.equal(stored.length, shapes.length);
  for (const row of stored) assert.equal(row.tables_total, null);
});

// The live floor (sensor_table_states), written after the answer by the one
// statement in services/sensorTables.js. The model in helpers/sensorStoreModel
// .js has to agree with every assertion here.
const settleTables = () => require('../services/sensorTables')._settled();
const floor = async () => (await pool.query(
  `SELECT sensor_device_id, table_no, venue_place_id, people, state, state_since, updated_at, seats
     FROM sensor_table_states ORDER BY sensor_device_id, table_no`
)).rows;
const floorShape = async () => (await floor()).map((r) => `${r.table_no}:${r.people}:${r.state}`);

test('a live reading writes the floor: one row per table, dated by the reading minus each timer', async () => {
  const res = await push(reading({ tables: EXAMPLE_TABLES }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await settleTables();
  const rows = await floor();
  assert.deepEqual(rows.map((r) => `${r.table_no}:${r.people}:${r.state}`), ['1:0:f', '2:3:s', '3:2:w', '4:0:c']);
  const at = new Date(res.body.recorded_at).getTime();
  for (const r of rows) {
    assert.equal(r.sensor_device_id, 'sensor_live');
    assert.equal(r.venue_place_id, VENUE);
    assert.equal(r.updated_at.getTime(), at, 'updated_at is the time the figures were true');
  }
  assert.deepEqual(rows.map((r) => (at - r.state_since.getTime()) / 1000), [340, 845, 410, 95]);
});

test('on the real schema: a removed table is deleted, a backfill and a reading without tables change nothing', async () => {
  assert.equal((await push(reading({ tables: EXAMPLE_TABLES }))).status, 201);
  await settleTables();
  await pool.query(`UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`);
  assert.equal((await push(reading({ tables: '1:2:s:30;4:0:f:5' }))).status, 201);
  await settleTables();
  assert.deepEqual(await floorShape(), ['1:2:s', '4:0:f']);

  // History, not the floor.
  assert.equal((await push(reading({ recorded_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), tables: '9:1:s:5' }))).status, 201);
  // Live, but silent about tables.
  await pool.query(`UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`);
  assert.equal((await push(reading())).status, 201);
  await settleTables();
  assert.deepEqual(await floorShape(), ['1:2:s', '4:0:f']);
});

test('on the real schema: an older live reading arriving after a newer one changes nothing', async () => {
  assert.equal((await push(reading({ tables: '1:2:w:400;2:0:f:9' }))).status, 201);
  await settleTables();
  await pool.query(`UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`);
  const late = await push(reading({ recorded_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(), tables: '1:2:s:160;3:1:s:5' }));
  assert.equal(late.status, 201, JSON.stringify(late.body));
  await settleTables();
  assert.deepEqual(await floorShape(), ['1:2:w', '2:0:f']);
});

test('on the real schema: a clock running ahead is capped at the server clock, and a deleted unit takes its tables', async () => {
  const res = await push(reading({ recorded_at: new Date(Date.now() + 90 * 1000).toISOString(), tables: '1:2:s:0' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await settleTables();
  const [row] = await floor();
  const { rows: [{ now }] } = await pool.query('SELECT NOW() AS now');
  assert.ok(row.updated_at <= now, 'a table dated in the future');
  assert.ok(row.state_since <= now);
  await pool.query("DELETE FROM sensor_devices WHERE device_id = 'sensor_live'");
  assert.deepEqual(await floor(), [], 'the unit is gone and its tables are not');
});

test('on the real schema: a change into waiting or clearing is one push to the verified owner; a repeat, the switch off and an unverified claim are none', async () => {
  // The push helper is stubbed at the hand-off (services/sensorTables.js holds
  // it as a module object). Everything before it is real: the prior state the
  // statement reads, the minutes it works out, the owner lookup, the claim.
  const pushHelper = require('../services/pushHelper');
  const real = { configured: pushHelper.isPushConfigured, always: pushHelper.pushAlways };
  const sent = [];
  pushHelper.isPushConfigured = () => true;
  pushHelper.pushAlways = async (userId, title, body, data) => {
    sent.push({ userId, title, body, data });
    return { sent: 1, failed: 0 };
  };
  const { rows: [owner] } = await pool.query(
    "INSERT INTO users (name, email, password) VALUES ('Table Owner', 'tables.owner@example.com', 'x') RETURNING id"
  );
  const age = () => pool.query(
    `UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`
  );
  const step = async (tables) => {
    await age();
    const res = await push(reading({ tables }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await settleTables();
  };
  try {
    await pool.query(
      `INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified, notification_prefs)
       VALUES ($1, 'The Table Bar', $2, true, '{"bookings": true}'::jsonb)`,
      [owner.id, VENUE]
    );
    await pool.query("DELETE FROM push_debounce WHERE debounce_key LIKE 'table_alert:%'");

    await step('3:2:s:200;4:0:s:900;5:1:s:60;6:1:s:60');
    assert.deepEqual(sent, [], 'a first reading has no change to report');
    await step('3:2:w:410;4:0:c:20;5:1:s:90;6:1:s:90');
    await step('3:2:w:440;4:0:c:50;5:1:s:120;6:1:s:120');
    assert.deepEqual(sent.map((s) => [s.userId, s.title, s.body, s.data.state]), [
      [owner.id, 'Table 3', 'Seated 6 min and nobody has stopped by yet.', 'waiting'],
      [owner.id, 'Table 4', "The party left and the table hasn't been cleared.", 'needs_clearing'],
    ]);
    const { rows: claimRows } = await pool.query(
      "SELECT debounce_key FROM push_debounce WHERE debounce_key LIKE 'table_alert:%' ORDER BY 1"
    );
    assert.deepEqual(claimRows.map((r) => r.debounce_key), ['table_alert:sensor_live:3:w', 'table_alert:sensor_live:4:c']);

    // The owner turns table alerts off: table 5 starts waiting, nobody is told.
    await pool.query(`UPDATE venue_profiles SET notification_prefs = notification_prefs || '{"tables": false}'::jsonb WHERE user_id = $1`, [owner.id]);
    await step('3:2:w:470;4:0:c:80;5:1:w:400;6:1:s:150');
    // Back on, but the claim on the place is no longer verified: table 6 waits, nobody is told.
    await pool.query(`UPDATE venue_profiles SET notification_prefs = '{}'::jsonb, verified = false WHERE user_id = $1`, [owner.id]);
    await step('3:2:w:500;4:0:c:110;5:1:w:430;6:1:w:400');
    assert.equal(sent.length, 2, JSON.stringify(sent.slice(2)));
  } finally {
    pushHelper.isPushConfigured = real.configured;
    pushHelper.pushAlways = real.always;
    await pool.query('DELETE FROM venue_profiles WHERE user_id = $1', [owner.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id]);
    await pool.query("DELETE FROM push_debounce WHERE debounce_key LIKE 'table_alert:%'");
  }
});

// The push helper stubbed at the hand-off for the length of fn, which is
// given the pushes sent. Every table alert claim is cleared afterwards, so one
// test's window never closes another's.
async function withPushStub(fn) {
  const pushHelper = require('../services/pushHelper');
  const real = { configured: pushHelper.isPushConfigured, always: pushHelper.pushAlways };
  const sent = [];
  pushHelper.isPushConfigured = () => true;
  pushHelper.pushAlways = async (userId, title, body, data) => {
    sent.push({ userId, title, body, data });
    return { sent: 1, failed: 0 };
  };
  try {
    await pool.query("DELETE FROM push_debounce WHERE debounce_key LIKE 'table_alert:%'");
    await fn(sent);
  } finally {
    pushHelper.isPushConfigured = real.configured;
    pushHelper.pushAlways = real.always;
    await pool.query("DELETE FROM push_debounce WHERE debounce_key LIKE 'table_alert:%'");
  }
}

const ageLiveUnit = () => pool.query(
  `UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`
);

test('on the real schema: a reading seven minutes old writes the floor and alerts nobody; one a minute old alerts, with the minutes from its own timer', async () => {
  await withVenueOwner(async (ownerId) => {
    await withPushStub(async (sent) => {
      const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
      const step = async (minutesAgo, tables) => {
        await ageLiveUnit();
        const res = await push(reading({ recorded_at: at(minutesAgo), tables }));
        assert.equal(res.status, 201, JSON.stringify(res.body));
        await settleTables();
      };
      // A drain after an outage: oldest first, each inside the live window.
      await step(8, '3:2:s:200');
      await step(7, '3:2:w:410');
      assert.deepEqual(await floorShape(), ['3:2:w'], 'a buffered reading still writes the floor');
      assert.deepEqual(sent, [], 'a wait reported seven minutes late rang the phone');
      const { rows: claims } = await pool.query("SELECT 1 FROM push_debounce WHERE debounce_key LIKE 'table_alert:%'");
      assert.equal(claims.length, 0, 'a reading too old to alert spent a claim');

      await step(2, '3:2:s:30');
      await step(1, '3:2:w:410');
      assert.deepEqual(sent.map((s) => [s.userId, s.title, s.body]),
        [[ownerId, 'Table 3', 'Seated 6 min and nobody has stopped by yet.']],
        'the minute the reading waited in the box is not the party\'s');
    });
  });
});

test('on the real schema: the box\'s forty free tables at the cap are written whole, then its two-seated string replaces them', async () => {
  // Both strings are the box's own (flock-sensor 1.24.0).
  const forty = Array.from({ length: 40 }, (_, i) => `${i + 1}:0:f:86400`).join(';');
  assert.equal(forty.length, 510);
  const res = await push(reading({ tables: forty }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await settleTables();
  const rows = await floor();
  assert.equal(rows.length, 40);
  const at = new Date(res.body.recorded_at).getTime();
  for (const r of rows) {
    assert.equal(r.state, 'f');
    assert.equal(at - r.state_since.getTime(), 86400 * 1000);
    assert.equal(r.seats, null, 'the box sends no seat count yet');
  }
  await pool.query(`UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`);
  assert.equal((await push(reading({ tables: '1:2:s:100;2:1:s:100;3:0:f:100' }))).status, 201);
  await settleTables();
  assert.deepEqual(await floorShape(), ['1:2:s', '2:1:s', '3:0:f']);
  assert.deepEqual((await tableCountRows()).map((r) => [r.tables_total, r.tables_occupied, r.tables_waiting, r.tables_to_clear]),
    [[40, 0, 0, 0], [3, 2, 0, 0]]);
});

test('on the real schema: seat counts are stored, kept when an entry leaves them out, and held to 1-30', async () => {
  const seats = async () => Object.fromEntries((await floor()).map((r) => [r.table_no, r.seats]));
  assert.equal((await push(reading({ tables: '1:2:s:100:4;2:0:f:30' }))).status, 201);
  await settleTables();
  assert.deepEqual(await seats(), { 1: 4, 2: null });
  await pool.query(`UPDATE sensor_devices SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE device_id = 'sensor_live'`);
  assert.equal((await push(reading({ tables: '1:2:s:130;2:0:f:60:2' }))).status, 201);
  await settleTables();
  assert.deepEqual(await seats(), { 1: 4, 2: 2 }, 'a reading without a count forgot the one it had');
  for (const bad of [0, 31]) {
    await assert.rejects(
      pool.query("UPDATE sensor_table_states SET seats = $1 WHERE sensor_device_id = 'sensor_live' AND table_no = 1", [bad]),
      (err) => err.code === '23514',
      `${bad} seats was stored`
    );
  }
});

// --- The owner's table routes, through the real schema ---------------------------
//
// sensorTables.test.js pins the gate and the response shape against a model;
// these run routes/sensors.js TABLE_FLOOR_SQL and TABLE_HOURS_SQL for real.
const ownerGet = async (p, userId) => {
  const res = await fetch(`${base}${p}`, { headers: { 'x-test-user': String(userId) } });
  return { status: res.status, body: await res.json() };
};

async function withVenueOwner(fn, { verified = true } = {}) {
  const { rows: [owner] } = await pool.query(
    "INSERT INTO users (name, email, password) VALUES ('Floor Owner', 'floor.owner@example.com', 'x') RETURNING id"
  );
  try {
    await pool.query(
      "INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, 'The Floor Bar', $2, $3)",
      [owner.id, VENUE, verified]
    );
    await fn(owner.id);
  } finally {
    await pool.query('DELETE FROM venue_profiles WHERE user_id = $1', [owner.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id]);
  }
}

test('on the real schema: the owner reads the floor of the unit with the newest rows, with seats, staleness and next_free', async () => {
  await withVenueOwner(async (ownerId) => {
    const FLOOR = `/api/sensors/${VENUE}/tables`;
    assert.deepEqual((await ownerGet(FLOOR, ownerId)).body, { tables: [], updated_at: null, stale: true, next_free: null });
    assert.equal((await ownerGet(FLOOR, ownerId + 1000)).status, 403, 'a stranger read the floor');

    // A second unit at the venue, last heard from a minute ago.
    await pool.query(
      "INSERT INTO sensor_devices (device_id, venue_place_id, api_key, is_active) VALUES ('sensor_back_room', $1, $2, true)",
      [VENUE, digestOf('f'.repeat(64))]
    );
    await pool.query(
      `INSERT INTO sensor_table_states (sensor_device_id, table_no, venue_place_id, people, state, state_since, updated_at)
       VALUES ('sensor_back_room', 1, $1, 6, 'w', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '1 minute')`,
      [VENUE]
    );

    const live = await push(reading({ tables: '1:2:s:600:4;2:3:w:900;3:0:c:50:2' }));
    assert.equal(live.status, 201);
    await settleTables();
    let res = await ownerGet(FLOOR, ownerId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const at = new Date(live.body.recorded_at).getTime();
    assert.deepEqual(res.body, {
      tables: [
        { number: 1, people: 2, state: 'seated', since: new Date(at - 600000).toISOString(), seats: 4 },
        { number: 2, people: 3, state: 'waiting', since: new Date(at - 900000).toISOString(), seats: null },
        { number: 3, people: 0, state: 'needs_clearing', since: new Date(at - 50000).toISOString(), seats: 2 },
      ],
      updated_at: new Date(at).toISOString(),
      stale: false,
      next_free: 2,
    });

    // The front unit goes quiet: the back room's rows are now the newest.
    await pool.query(`UPDATE sensor_table_states SET updated_at = NOW() - INTERVAL '4 minutes' WHERE sensor_device_id = 'sensor_live'`);
    res = await ownerGet(FLOOR, ownerId);
    assert.deepEqual(res.body.tables.map((t) => `${t.number}:${t.people}:${t.state}`), ['1:6:waiting']);
    assert.equal(res.body.stale, false);
    assert.equal(res.body.next_free, 1);

    // Both go quiet: the newest is past three minutes, and the floor says so.
    await pool.query(`UPDATE sensor_table_states SET updated_at = NOW() - INTERVAL '10 minutes' WHERE sensor_device_id = 'sensor_back_room'`);
    res = await ownerGet(FLOOR, ownerId);
    assert.equal(res.body.tables.length, 3, 'the front unit is the newest again');
    assert.equal(res.body.stale, true);
  });
  await withVenueOwner(async (ownerId) => {
    assert.equal((await ownerGet(`/api/sensors/${VENUE}/tables`, ownerId)).status, 403, 'an unverified claim read the floor');
  }, { verified: false });
});

test('on the real schema: tables in use by hour, the last 7 days, oldest first, readings with tables only', async () => {
  const HOUR = 3600 * 1000;
  const lastHour = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  const rowsToStore = [
    // [device, place, ms, total, occupied]
    ['sensor_live', VENUE, lastHour - 2 * HOUR + 5 * 60000, 3, 1],
    ['sensor_live', VENUE, lastHour - 2 * HOUR + 35 * 60000, 3, 2],
    ['sensor_live', VENUE, lastHour - HOUR + 10 * 60000, 0, 0],
    ['sensor_live', VENUE, lastHour - HOUR + 20 * 60000, null, null],
    ['sensor_live', VENUE, lastHour + 10 * 60000, 4, 3],
    ['sensor_live', VENUE, lastHour + 20 * 60000, 5, 4],
    ['sensor_live', VENUE, lastHour + 40 * 60000, 5, 4],
    ['sensor_live', VENUE, Date.now() - 8 * 24 * HOUR, 4, 4],
    ['sensor_elsewhere', 'ChIJsomewhereElse0002', lastHour + 30 * 60000, 9, 9],
  ];
  for (const [device, place, ms, total, occupied] of rowsToStore) {
    await pool.query(
      `INSERT INTO venue_sensor_data (venue_place_id, sensor_device_id, recorded_at, ir_beam_count, thermal_headcount,
                                      noise_db, tables_total, tables_occupied)
       VALUES ($1, $2, $3, 1, 1, 60, $4, $5)`,
      [place, device, new Date(ms), total, occupied]
    );
  }
  await withVenueOwner(async (ownerId) => {
    const res = await ownerGet(`/api/sensors/${VENUE}/tables/hours`, ownerId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
      hours: [
        { hour: new Date(lastHour - 2 * HOUR).toISOString(), occupied: 1.5, total: 3 },
        { hour: new Date(lastHour).toISOString(), occupied: 3.7, total: 5 },
      ],
    });
    assert.equal((await ownerGet(`/api/sensors/${VENUE}/tables/hours`, ownerId + 1000)).status, 403);
  });
});

test('on the real schema: below Roost the table routes refuse with has_tables and no table data; on Roost they answer', async () => {
  const before = { billing: process.env.VENUE_BILLING_ENABLED, admins: process.env.ADMIN_USER_IDS };
  process.env.VENUE_BILLING_ENABLED = 'true';
  if (!process.env.ADMIN_USER_IDS) process.env.ADMIN_USER_IDS = '1';
  const UPGRADE = { error: 'This feature needs a venue plan upgrade.', code: 'UPGRADE_REQUIRED', requiredTier: 'pro' };
  try {
    await withVenueOwner(async (ownerId) => {
      const FLOOR = `/api/sensors/${VENUE}/tables`;
      const HOURS = `/api/sensors/${VENUE}/tables/hours`;
      // A claim made after Roost had a price, with no grant: the free plan.
      assert.deepEqual(await ownerGet(FLOOR, ownerId), { status: 403, body: { ...UPGRADE, has_tables: false } });

      assert.equal((await push(reading({ tables: '1:2:s:600;2:0:f:30' }))).status, 201);
      await settleTables();
      assert.deepEqual(await ownerGet(FLOOR, ownerId), { status: 403, body: { ...UPGRADE, has_tables: true } });
      assert.deepEqual(await ownerGet(HOURS, ownerId), { status: 403, body: { ...UPGRADE, has_tables: true } });

      await pool.query("UPDATE venue_profiles SET tier = 'pro' WHERE user_id = $1", [ownerId]);
      const floor = await ownerGet(FLOOR, ownerId);
      assert.equal(floor.status, 200, JSON.stringify(floor.body));
      assert.deepEqual(floor.body.tables.map((t) => t.number), [1, 2]);
      assert.equal((await ownerGet(HOURS, ownerId)).status, 200);
    });
  } finally {
    if (before.billing === undefined) delete process.env.VENUE_BILLING_ENABLED;
    else process.env.VENUE_BILLING_ENABLED = before.billing;
    if (before.admins === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = before.admins;
  }
});

test('the table rows refuse what the box can never send', async () => {
  for (const [no, people, state] of [[0, 1, 's'], [201, 1, 's'], [1, 31, 's'], [1, 1, 'x']]) {
    await assert.rejects(
      pool.query(
        `INSERT INTO sensor_table_states (sensor_device_id, table_no, venue_place_id, people, state, state_since)
         VALUES ('sensor_live', $1, $2, $3, $4, NOW())`,
        [no, VENUE, people, state]
      ),
      (err) => err.code === '23514',
      `${no}:${people}:${state} was stored`
    );
  }
});
