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
