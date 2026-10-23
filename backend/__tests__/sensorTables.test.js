// Run: node --test  (from backend/)
//
// TABLE MONITORING, through the real router against the modelled store.
//
// The Flux box counts people per table and runs a small state machine per
// table, and sends the result with each reading as one string (the contract is
// at the top of services/sensorTables.js). Three things about it are pinned
// here, each by the failure it prevents:
//
//   * A bad tables value is IGNORED, never refused. The Pi drops the whole
//     reading on a 400, 413 or 422 (flock-sensor/main.py), so a refusal would
//     throw away the reading's three counts and its occupancy estimate over
//     one malformed field.
//   * Nothing about a person leaves the Pi or this server: per-table counts and
//     states only, and the public live broadcast carries none of it.
//   * The value is never repeated back: not in the answer, not in the log.
//
// sensorIngestStatement.test.js drives the same paths against a real,
// migrated Postgres.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');

process.env.JWT_SECRET = 'sensor-tables-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// --- Fake database --------------------------------------------------------
// The same stateful model sensorIngest.test.js uses (helpers/sensorStoreModel
// .js), so the flood guard and the dedupe behave as they do in Postgres, and
// the table-state writer modelled beside it.
const {
  INGEST_STATEMENT, runIngest, TABLE_STATES_STATEMENT, runTableStates,
} = require('./helpers/sensorStoreModel');

let devices = [];
let readings = [];
let tableStates = [];
let queryLog = [];
// Swapped in by a test that needs the table-state write to fail or wait.
let tableStatesImpl = null;

pool.query = (sql, params = []) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params });
  if (INGEST_STATEMENT.test(flat)) return Promise.resolve(runIngest({ devices, readings }, params));
  if (TABLE_STATES_STATEMENT.test(flat)) {
    if (tableStatesImpl) return tableStatesImpl(params);
    return Promise.resolve(runTableStates({ tableStates }, params));
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
};

pool.connect = async () => {
  throw new Error('routes/sensors.js must not check a client out of the pool');
};

// authenticate() is replaced BEFORE the router is required, because the router
// destructures it at module load. A caller names itself in a test header; no
// header is no session.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, res, next) => {
  const id = Number(req.headers['x-test-user']);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id, name: 'Owner', role: 'user' };
  return next();
};

const sensorRouter = require('../routes/sensors');
const sensorTables = require('../services/sensorTables');

let emits = [];
const io = { to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; } };

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/sensors', sensorRouter);
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

function call(path, { apiKey, body, method = 'POST', user } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (apiKey !== undefined) headers['x-api-key'] = apiKey;
    if (user !== undefined) headers['x-test-user'] = String(user);
    const req = http.request({ agent: false, host: '127.0.0.1', port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// --- Fixtures -------------------------------------------------------------

const KEY = 'b'.repeat(64);
const OTHER_KEY = 'c'.repeat(64);
const VENUE = 'ChIJtableMonitoring0001';
const digestOf = (key) => 'sha256:' + crypto.createHash('sha256').update(key, 'utf8').digest('hex');

const EXAMPLE = '1:0:f:340;2:3:s:845;3:2:w:410;4:0:c:95';

function reset() {
  queryLog = [];
  readings = [];
  tableStates = [];
  tableStatesImpl = null;
  emits = [];
  devices = [
    { id: 1, device_id: 'flux_tables_01', venue_place_id: VENUE, is_active: true,
      api_key: digestOf(KEY), last_seen_at: null },
    { id: 2, device_id: 'flux_tables_02', venue_place_id: VENUE, is_active: true,
      api_key: digestOf(OTHER_KEY), last_seen_at: null },
  ];
  sensorTables._resetIgnoredNotes();
}

const reading = (extra = {}) => ({ ir_beam_count: 9, thermal_headcount: 17, noise_db: 66.5, ...extra });

// Let the per-device flood guard's clock run out.
function ageDevice(deviceId = 'flux_tables_01', ms = 60000) {
  devices.find((d) => d.device_id === deviceId).last_seen_at = Date.now() - ms;
}

const countsOf = (r) => [r.tables_total, r.tables_occupied, r.tables_waiting, r.tables_to_clear];

// The floor is written after the answer; this waits for that work to finish.
const settle = () => sensorTables._settled();
const floorOf = (deviceId = 'flux_tables_01') => tableStates
  .filter((r) => r.sensor_device_id === deviceId)
  .sort((a, b) => a.table_no - b.table_no)
  .map((r) => `${r.table_no}:${r.people}:${r.state}`);
const stateWrites = () => queryLog.filter((q) => TABLE_STATES_STATEMENT.test(q.sql));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Captures console.warn and console.error for the length of fn.
async function capturingLogs(fn) {
  const lines = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
  return lines;
}

// --- The parse ---------------------------------------------------------------

test('the example from the contract parses to four tables in order, one per state', () => {
  const parsed = sensorTables.parseTables(EXAMPLE);
  assert.deepStrictEqual(parsed, {
    ok: true,
    tables: [
      { number: 1, people: 0, state: 'f', seconds: 340 },
      { number: 2, people: 3, state: 's', seconds: 845 },
      { number: 3, people: 2, state: 'w', seconds: 410 },
      { number: 4, people: 0, state: 'c', seconds: 95 },
    ],
  });
});

test('every ceiling in the contract is inside the fence: forty tables, thirty people, a day', () => {
  const full = Array.from({ length: 40 }, (_, i) => `${i + 1}:30:w:86400`).join(';');
  assert.ok(full.length <= 600, `the longest honest string is ${full.length} characters`);
  const parsed = sensorTables.parseTables(full);
  assert.strictEqual(parsed.ok, true, parsed.reason);
  assert.strictEqual(parsed.tables.length, 40);
  assert.deepStrictEqual(sensorTables.parseTables('40:0:f:0').tables, [{ number: 40, people: 0, state: 'f', seconds: 0 }]);
});

// Every way a string can be wrong, each with the reason the parse gives. None
// of the reasons may quote the value back.
const INVALID = [
  ['', 'empty'],
  ['1:0:f', 'a missing part'],
  ['1:0:f:5:9', 'an extra part'],
  ['1:0:x:5', 'a state that is not f, s, w or c'],
  ['1:0:F:5', 'an upper-case state'],
  ['0:0:f:5', 'table 0'],
  ['41:0:f:5', 'a table above 40'],
  ['100:0:f:5', 'a three-digit table'],
  ['1:31:s:5', 'more than 30 people at one table'],
  ['1:0:f:86401', 'a state older than the cap of a day'],
  ['1:0:f:999999', 'a six-digit age'],
  ['2:0:f:5;1:0:f:5', 'tables out of order'],
  ['1:0:f:5;1:0:s:5', 'the same table twice'],
  ['01:0:f:5', 'a leading zero'],
  ['1:00:f:5', 'a leading zero on the head count'],
  ['1:-1:f:5', 'a negative head count'],
  ['1:0:f:1e3', 'an exponent'],
  ['1:0:f:5.0', 'a decimal'],
  ['1:0:f:5;', 'a trailing separator'],
  [';1:0:f:5', 'a leading separator'],
  [' 1:0:f:5', 'a leading space'],
  ['1:0:f:5\n', 'a trailing newline'],
  ['1:0:f:5,2:0:f:5', 'the wrong separator'],
  [Array.from({ length: 41 }, (_, i) => `${i + 1}:0:f:5`).join(';'), 'forty-one tables'],
  ['9'.repeat(601), 'longer than 600 characters'],
];

test('the parse refuses every malformed string, and its reason never repeats the value', () => {
  for (const [raw, what] of INVALID) {
    const parsed = sensorTables.parseTables(raw);
    assert.strictEqual(parsed.ok, false, `${what} was accepted`);
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0, what);
    if (raw.length > 3) assert.ok(!parsed.reason.includes(raw), `${what}: the reason quotes the value`);
  }
  for (const v of [undefined, null, 5, true, ['1:0:f:5'], { 1: 'f' }]) {
    assert.strictEqual(sensorTables.parseTables(v).ok, false, JSON.stringify(v));
  }
});

test('the four counts: occupied is seated plus waiting, and a reading with no tables counts as unknown, not zero', () => {
  const { tables } = sensorTables.parseTables(EXAMPLE);
  assert.deepStrictEqual(sensorTables.tableCounts(tables),
    { tablesTotal: 4, tablesOccupied: 2, tablesWaiting: 1, tablesToClear: 1 });
  assert.deepStrictEqual(sensorTables.tableCounts(null),
    { tablesTotal: null, tablesOccupied: null, tablesWaiting: null, tablesToClear: null });
});

// --- Through the ingest ---------------------------------------------------------

test('a valid tables string is counted onto the reading, and the answer and the broadcast stay exactly as they were', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
  assert.strictEqual(res.status, 201, res.raw);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['recorded_at', 'success']);
  assert.strictEqual(readings.length, 1);
  assert.deepStrictEqual(countsOf(readings[0]), [4, 2, 1, 1]);
  assert.strictEqual(readings[0].ir_beam_count, 9, 'the reading itself is stored as always');

  // venue:{placeId} is a public room. Its keys are pinned in
  // sensorIngestionIntegrity.test.js, and table states are the owner's alone.
  assert.strictEqual(emits.length, 1);
  assert.deepStrictEqual(
    Object.keys(emits[0].payload).sort(),
    ['dwell_minutes', 'ir_beam_count', 'noise_db', 'occupancy', 'occupancy_high', 'occupancy_low',
      'recorded_at', 'thermal_headcount', 'venue_place_id']
  );
  assert.ok(!/tables|"f"|needs_clearing/.test(JSON.stringify(emits[0].payload)));
});

test('the counts reach the statement as four trailing parameters, after every older one kept its number', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE, occupancy: 12 }) });
  const ingest = queryLog.find((q) => INGEST_STATEMENT.test(q.sql));
  assert.strictEqual(ingest.params.length, 19);
  assert.strictEqual(ingest.params[11], 12, '$12 is still the occupancy estimate');
  assert.deepStrictEqual(ingest.params.slice(15), [4, 2, 1, 1]);
  assert.match(ingest.sql, /tables_total, tables_occupied, tables_waiting, tables_to_clear/);
  assert.match(ingest.sql, /\$16::integer, \$17::integer, \$18::integer, \$19::integer/);
});

test('a reading without tables stores null counts and is otherwise untouched', async () => {
  reset();
  for (const body of [reading(), reading({ tables: null })]) {
    reset();
    const res = await call('/api/sensors/data', { apiKey: KEY, body });
    assert.strictEqual(res.status, 201, res.raw);
    assert.deepStrictEqual(countsOf(readings[0]), [null, null, null, null]);
  }
});

test('every kind of invalid tables value is ignored: 201, the reading and its estimate stored, the table counts null', async () => {
  const shapes = [
    ...INVALID.map(([raw, what]) => [raw, what]),
    [['1:0:f:5'], 'an array'],
    [[], 'an empty array'],
    [{ 1: 'f' }, 'an object'],
    [5, 'a number'],
    [true, 'a boolean'],
  ];
  for (const [value, what] of shapes) {
    reset();
    const res = await call('/api/sensors/data', {
      apiKey: KEY, body: reading({ tables: value, occupancy: 14, occupancy_low: 12, occupancy_high: 16 }),
    });
    assert.strictEqual(res.status, 201, `${what}: ${res.status} ${res.raw}`);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['recorded_at', 'success'], what);
    assert.strictEqual(readings.length, 1, `${what}: the reading was lost`);
    assert.deepStrictEqual(countsOf(readings[0]), [null, null, null, null], what);
    assert.strictEqual(readings[0].ir_beam_count, 9, what);
    assert.strictEqual(readings[0].occupancy, 14, `${what}: the estimate went with the bad field`);
    assert.strictEqual(emits.length, 1, `${what}: the live reading was not broadcast`);
  }
});

test('a bad tables value never rescues a reading that is wrong for another reason, and the 400 names that reason', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: KEY, body: reading({ ir_beam_count: -3, tables: ['nonsense'] }),
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /ir_beam_count/);
  assert.strictEqual(readings.length, 0);
});

test('an unauthenticated caller learns nothing about the tables field either', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: 'not-a-key', body: reading({ tables: 'garbage' }) });
  assert.strictEqual(res.status, 401);
  assert.ok(!/tables/.test(res.raw));
});

test('an ignored value is logged once per device, names the problem and the device, and never repeats the value', async () => {
  reset();
  const secret = '7:7:z:7;SECRET-LOOKING-PAYLOAD';
  const lines = await capturingLogs(async () => {
    for (let i = 0; i < 3; i += 1) {
      ageDevice('flux_tables_01');
      const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: secret }) });
      assert.strictEqual(res.status, 201, res.raw);
    }
    // A second unit gets its own line.
    const other = await call('/api/sensors/data', { apiKey: OTHER_KEY, body: reading({ tables: ['x'] }) });
    assert.strictEqual(other.status, 201, other.raw);
  });
  const notes = lines.filter((l) => /tables value was ignored/.test(l));
  assert.strictEqual(notes.length, 2, notes.join('\n'));
  assert.match(notes[0], /flux_tables_01/);
  assert.match(notes[0], /not N:P:S:A entries/);
  assert.match(notes[1], /flux_tables_02/);
  assert.match(notes[1], /not one string/);
  assert.ok(!lines.join('\n').includes('SECRET-LOOKING-PAYLOAD'), 'the value reached the log');
  assert.strictEqual(readings.length, 4);
});

test('the note comes back after an hour, and not before', () => {
  sensorTables._resetIgnoredNotes();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const t0 = 1_800_000_000_000;
    assert.strictEqual(sensorTables.noteIgnoredTables('flux_x', 'empty', t0), true);
    assert.strictEqual(sensorTables.noteIgnoredTables('flux_x', 'empty', t0 + 59 * 60 * 1000), false);
    assert.strictEqual(sensorTables.noteIgnoredTables('flux_x', 'empty', t0 + 60 * 60 * 1000), true);
  } finally {
    console.warn = realWarn;
  }
});

test('a valid string logs nothing', async () => {
  reset();
  const lines = await capturingLogs(async () => {
    await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
  });
  assert.deepStrictEqual(lines.filter((l) => /tables/.test(l)), []);
});

test('a dry run with a bad tables value is still just a dry run', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: 'junk', dry_run: true }) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.dry_run, true);
  assert.strictEqual(readings.length, 0);
});

// --- The live floor ----------------------------------------------------------
//
// One row per table, replaced by every LIVE reading after it is stored. Live
// means what GET /current would serve (the 15 minute window), the same flag the
// flood guard reads, so the floor and the venue's live figure agree on what
// "now" is.

test('a live reading writes one row per table, each dated by its own seated or state timer', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
  assert.strictEqual(res.status, 201, res.raw);
  await settle();
  assert.deepStrictEqual(floorOf(), ['1:0:f', '2:3:s', '3:2:w', '4:0:c']);
  const at = readings[0].recorded_at.getTime();
  const seated = tableStates.find((r) => r.table_no === 2);
  assert.strictEqual(seated.venue_place_id, VENUE, 'the venue comes from the device row, as for the reading');
  assert.strictEqual(seated.updated_at.getTime(), at);
  assert.strictEqual(seated.state_since.getTime(), at - 845 * 1000, 'state_since is the reading time minus A');
});

test('a reading from five minutes ago is still live: it writes the floor, at its own time', async () => {
  reset();
  const stamp = ago(5 * 60 * 1000);
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ recorded_at: stamp, tables: '7:4:s:120' }) });
  assert.strictEqual(res.status, 201, res.raw);
  await settle();
  assert.deepStrictEqual(floorOf(), ['7:4:s']);
  assert.strictEqual(tableStates[0].updated_at.toISOString(), stamp);
  assert.strictEqual(emits.length, 0, 'old enough not to be broadcast, young enough to be the floor');
});

test('a backfilled reading never touches the floor, though its counts are stored', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: KEY, body: reading({ recorded_at: ago(30 * 60 * 1000), tables: EXAMPLE }),
  });
  assert.strictEqual(res.status, 201, res.raw);
  await settle();
  assert.deepStrictEqual(countsOf(readings[0]), [4, 2, 1, 1], 'history keeps its counts');
  assert.deepStrictEqual(tableStates, []);
  assert.strictEqual(stateWrites().length, 0, 'a backfilled reading must not even ask');
});

test('a table the owner removed on the box loses its row; the rest are replaced', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
  await settle();
  ageDevice();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:30;2:0:c:12;4:0:f:5' }) });
  await settle();
  assert.deepStrictEqual(floorOf(), ['1:2:s', '2:0:c', '4:0:f']);
});

test('a live reading without tables leaves the floor exactly as it was', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
  await settle();
  const before = JSON.stringify(tableStates);
  for (const extra of [{}, { tables: null }, { tables: 'not-a-table-string' }]) {
    ageDevice();
    const res = await call('/api/sensors/data', { apiKey: KEY, body: reading(extra) });
    assert.strictEqual(res.status, 201, res.raw);
    await settle();
  }
  assert.strictEqual(JSON.stringify(tableStates), before);
  assert.strictEqual(stateWrites().length, 1, 'only the reading that carried tables wrote the floor');
});

test('a re-delivered reading and a throttled one write nothing to the floor', async () => {
  reset();
  const stamp = ago(3 * 60 * 1000);
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ recorded_at: stamp, tables: '1:2:s:60' }) });
  await settle();
  const dup = await call('/api/sensors/data', { apiKey: KEY, body: reading({ recorded_at: stamp, tables: '1:0:c:5' }) });
  assert.strictEqual(dup.body.duplicate, true);
  const throttled = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:0:c:5' }) });
  assert.strictEqual(throttled.status, 429);
  await settle();
  assert.deepStrictEqual(floorOf(), ['1:2:s']);
  assert.strictEqual(stateWrites().length, 1);
});

test('an older live reading that arrives after a newer one changes nothing', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:w:400;2:0:f:9' }) });
  await settle();
  ageDevice();
  const late = await call('/api/sensors/data', {
    apiKey: KEY, body: reading({ recorded_at: ago(4 * 60 * 1000), tables: '1:2:s:160;3:1:s:5' }),
  });
  assert.strictEqual(late.status, 201, late.raw);
  await settle();
  assert.deepStrictEqual(floorOf(), ['1:2:w', '2:0:f'], 'the late reading rewrote a newer floor');
});

test('a device clock running ahead cannot date a table in the future', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: KEY, body: reading({ recorded_at: new Date(Date.now() + 90 * 1000).toISOString(), tables: '1:2:s:0' }),
  });
  assert.strictEqual(res.status, 201, res.raw);
  await settle();
  assert.ok(tableStates[0].updated_at.getTime() <= Date.now(), 'updated_at is in the future');
  assert.ok(tableStates[0].state_since.getTime() <= Date.now(), 'state_since is in the future');
});

test('each device keeps its own floor', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:30' }) });
  await call('/api/sensors/data', { apiKey: OTHER_KEY, body: reading({ tables: '1:0:c:30;2:4:w:400' }) });
  await settle();
  assert.deepStrictEqual(floorOf('flux_tables_01'), ['1:2:s']);
  assert.deepStrictEqual(floorOf('flux_tables_02'), ['1:0:c', '2:4:w']);
});

test('the floor is written after the answer, and a write that never finishes cannot hold the answer', async () => {
  reset();
  let release;
  tableStatesImpl = () => new Promise((resolve) => { release = () => resolve({ rows: [], rowCount: 0 }); });
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
  assert.strictEqual(res.status, 201, 'the answer waited for the floor');
  assert.ok(typeof release === 'function', 'the floor write did start');
  const order = queryLog.map((q) => (INGEST_STATEMENT.test(q.sql) ? 'reading' : 'floor'));
  assert.deepStrictEqual(order, ['reading', 'floor']);
  release();
  await settle();
});

test('a floor write that fails is logged and changes neither the answer nor the stored reading', async () => {
  reset();
  tableStatesImpl = () => Promise.reject(new Error('relation "sensor_table_states" is on fire'));
  let res;
  const lines = await capturingLogs(async () => {
    res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
    await settle();
  });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['recorded_at', 'success']);
  assert.strictEqual(readings.length, 1);
  assert.deepStrictEqual(countsOf(readings[0]), [4, 2, 1, 1]);
  assert.ok(lines.some((l) => /Table states for flux_tables_01 failed after the reading was stored/.test(l)), lines.join('\n'));
});

test('a floor write that throws before it ever returns a promise is caught the same way', async () => {
  reset();
  tableStatesImpl = () => { throw new Error('driver blew up synchronously'); };
  let res;
  const lines = await capturingLogs(async () => {
    res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
    await settle();
  });
  assert.strictEqual(res.status, 201);
  assert.ok(lines.some((l) => /driver blew up synchronously/.test(l)), lines.join('\n'));
});
