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
let venueProfiles = [];
// push_debounce, as key -> the ms it was last claimed.
let claims = new Map();
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
  // The alert's owner lookup. The verified clause is honoured only when the
  // statement carries it, so dropping it from the code fails a test here
  // rather than being supplied by the fake.
  if (/^SELECT user_id, notification_prefs FROM venue_profiles WHERE google_place_id = \$1/.test(flat)) {
    const needsVerified = /AND verified = true/.test(flat);
    const hit = venueProfiles.find((v) => v.google_place_id === params[0] && (!needsVerified || v.verified === true));
    const rows = hit ? [{ user_id: hit.user_id, notification_prefs: hit.notification_prefs }] : [];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  // The alert's claim: an upsert that only wins once the window has passed.
  if (/^INSERT INTO push_debounce \(debounce_key, sent_at\)/.test(flat)) {
    const [key, minutes] = params;
    const at = claims.get(key);
    if (at !== undefined && Date.now() - at < minutes * 60 * 1000) return Promise.resolve({ rows: [], rowCount: 0 });
    claims.set(key, Date.now());
    return Promise.resolve({ rows: [{ debounce_key: key }], rowCount: 1 });
  }
  // The read routes' owner gate, honouring the verified clause only when the
  // statement carries it.
  if (/^SELECT 1 FROM venue_profiles WHERE user_id = \$1 AND google_place_id = \$2/.test(flat)) {
    const needsVerified = /AND verified = true/.test(flat);
    const hit = venueProfiles.find((v) => v.user_id === params[0] && v.google_place_id === params[1]
      && (!needsVerified || v.verified === true));
    return Promise.resolve({ rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 });
  }
  if (/^WITH unit AS \( SELECT sensor_device_id FROM sensor_table_states WHERE venue_place_id = \$1/.test(flat)) {
    const rows = floorModel(params[0], params[1]);
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/AS occupied, MAX\(tables_total\) AS total FROM venue_sensor_data/.test(flat)) {
    const rows = hoursModel(params[0]);
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
};

// The floor read (routes/sensors.js TABLE_FLOOR_SQL) over the fake rows: the
// unit with the newest rows at the place, its rows at the place in number
// order, each flagged stale past the window. sensorIngestStatement.test.js
// runs the real statement.
function floorModel(placeId, minutes) {
  const atPlace = tableStates.filter((r) => r.venue_place_id === placeId);
  if (atPlace.length === 0) return [];
  const unit = atPlace.slice().sort((a, b) => (b.updated_at - a.updated_at)
    || a.sensor_device_id.localeCompare(b.sensor_device_id))[0].sensor_device_id;
  return atPlace
    .filter((r) => r.sensor_device_id === unit)
    .sort((a, b) => a.table_no - b.table_no)
    .map((r) => ({
      table_no: r.table_no, people: r.people, state: r.state, state_since: r.state_since,
      seats: r.seats ?? null, updated_at: r.updated_at,
      stale: r.updated_at.getTime() < Date.now() - minutes * 60 * 1000,
    }));
}

// The hours read (TABLE_HOURS_SQL) over the fake readings: the last 7 days,
// readings with tables only, one row per hour, occupied as the numeric string
// pg hands back.
function hoursModel(placeId) {
  const HOUR = 3600 * 1000;
  const buckets = new Map();
  for (const r of readings) {
    if (r.venue_place_id !== placeId || !(r.tables_total > 0)) continue;
    if (r.recorded_at.getTime() < Date.now() - 7 * 24 * HOUR) continue;
    const hour = Math.floor(r.recorded_at.getTime() / HOUR) * HOUR;
    const b = buckets.get(hour) || { sum: 0, n: 0, total: 0 };
    b.sum += r.tables_occupied;
    b.n += 1;
    b.total = Math.max(b.total, r.tables_total);
    buckets.set(hour, b);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([hour, b]) => ({
    hour: new Date(hour), occupied: (Math.round((b.sum / b.n) * 10) / 10).toFixed(1), total: b.total,
  }));
}

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

// The push helper is replaced on the module object, which is what
// services/sensorTables.js holds, so the alert path is measured up to the
// hand-off and no further. services/pushHelper.js has its own suites.
const pushHelper = require('../services/pushHelper');
const firebaseService = require('../services/firebaseService');
let pushConfigured = true;
let pushes = [];
let pushBehaviour = async () => ({ sent: 1, failed: 0 });
pushHelper.isPushConfigured = () => pushConfigured;
pushHelper.pushAlways = (userId, title, body, data) => {
  pushes.push({ userId, title, body, data });
  return pushBehaviour(userId, title, body, data);
};

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

const OWNER_ID = 41;

function reset() {
  queryLog = [];
  readings = [];
  tableStates = [];
  tableStatesImpl = null;
  claims = new Map();
  pushes = [];
  pushConfigured = true;
  pushBehaviour = async () => ({ sent: 1, failed: 0 });
  // The verified owner of VENUE, who never touched the table switch.
  venueProfiles = [{ user_id: OWNER_ID, google_place_id: VENUE, verified: true, notification_prefs: { bookings: true } }];
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
      { number: 1, people: 0, state: 'f', seconds: 340, seats: null },
      { number: 2, people: 3, state: 's', seconds: 845, seats: null },
      { number: 3, people: 2, state: 'w', seconds: 410, seats: null },
      { number: 4, people: 0, state: 'c', seconds: 95, seats: null },
    ],
  });
});

test('every ceiling in the contract is inside the fence: forty tables, thirty people, a day', () => {
  const full = Array.from({ length: 40 }, (_, i) => `${i + 1}:30:w:86400`).join(';');
  assert.ok(full.length <= 600, `the longest honest string is ${full.length} characters`);
  const parsed = sensorTables.parseTables(full);
  assert.strictEqual(parsed.ok, true, parsed.reason);
  assert.strictEqual(parsed.tables.length, 40);
  assert.deepStrictEqual(sensorTables.parseTables('40:0:f:0').tables,
    [{ number: 40, people: 0, state: 'f', seconds: 0, seats: null }]);
});

// --- The strings the box sends (flock-sensor 1.24.0) ------------------------------
//
// Copied from the box's own code, so the parse is held to what the Pi actually
// writes and not only to what this file imagines. The box sends no seat count
// yet; that arrives with the table camera, and only when it is known.
const BOX_TWO_SEATED = '1:2:s:100;2:1:s:100;3:0:f:100';
const boxFortyFree = () => Array.from({ length: 40 }, (_, i) => `${i + 1}:0:f:86400`).join(';');

test('the box\'s strings parse: two tables seated a hundred seconds, one free; forty free tables at the cap', () => {
  assert.deepStrictEqual(sensorTables.parseTables(BOX_TWO_SEATED).tables, [
    { number: 1, people: 2, state: 's', seconds: 100, seats: null },
    { number: 2, people: 1, state: 's', seconds: 100, seats: null },
    { number: 3, people: 0, state: 'f', seconds: 100, seats: null },
  ]);
  const forty = boxFortyFree();
  assert.strictEqual(forty.length, 510, 'the box writes this one at 510 characters, under the 600 cap');
  const parsed = sensorTables.parseTables(forty);
  assert.strictEqual(parsed.ok, true, parsed.reason);
  assert.strictEqual(parsed.tables.length, 40);
  assert.ok(parsed.tables.every((t, i) => t.number === i + 1 && t.people === 0 && t.state === 'f'
    && t.seconds === 86400 && t.seats === null));
});

test('through the ingest, the box\'s strings are counted onto the reading and written to the floor', async () => {
  reset();
  const first = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: BOX_TWO_SEATED }) });
  assert.strictEqual(first.status, 201, first.raw);
  await settle();
  assert.deepStrictEqual(countsOf(readings[0]), [3, 2, 0, 0]);
  assert.deepStrictEqual(floorOf(), ['1:2:s', '2:1:s', '3:0:f']);

  ageDevice();
  const second = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: boxFortyFree() }) });
  assert.strictEqual(second.status, 201, second.raw);
  await settle();
  assert.deepStrictEqual(countsOf(readings[1]), [40, 0, 0, 0]);
  assert.strictEqual(floorOf().length, 40);
  assert.ok(floorOf().every((t) => t.endsWith(':0:f')));
  assert.deepStrictEqual(pushes, [], 'seated to free is not an alert');
});

// --- The seat count: an optional fifth field ------------------------------------

test('a fifth field is the seat count, 1-30, and entries with and without it mix in one string', () => {
  assert.deepStrictEqual(sensorTables.parseTables('1:2:s:100:4;2:0:f:30;3:6:w:400:30;4:0:c:9:1').tables, [
    { number: 1, people: 2, state: 's', seconds: 100, seats: 4 },
    { number: 2, people: 0, state: 'f', seconds: 30, seats: null },
    { number: 3, people: 6, state: 'w', seconds: 400, seats: 30 },
    { number: 4, people: 0, state: 'c', seconds: 9, seats: 1 },
  ]);
});

test('a seat count out of range makes the whole value invalid, not just its entry', () => {
  for (const [raw, what] of [
    ['1:2:s:100:0', 'zero seats'],
    ['1:2:s:100:31', 'thirty-one seats'],
    ['1:2:s:100:99', 'ninety-nine seats'],
    ['1:2:s:100:100', 'a three-digit seat count'],
    ['1:2:s:100:04', 'a leading zero'],
    ['1:2:s:100:-1', 'a negative seat count'],
    ['1:2:s:100:1.5', 'half a seat'],
    ['1:2:s:100:', 'an empty fifth field'],
    ['1:2:s:100:4:2', 'a sixth field'],
    ['1:0:f:30;2:2:s:100:31;3:0:f:30', 'one bad seat count among good entries'],
  ]) {
    const parsed = sensorTables.parseTables(raw);
    assert.strictEqual(parsed.ok, false, `${what} was accepted`);
  }
  assert.match(sensorTables.parseTables('1:2:s:100:31').reason, /seat count outside 1-30/);
});

test('with a seat count on every table at every ceiling, the string passes the 600 cap and is ignored like any other', () => {
  // Pinned so that raising the cap is a decision made on purpose, with the Pi
  // side told: forty tables, each holding ten or more people at ten or more
  // seats with every state hours old, is 670 characters. No floor this was built
  // for sends it, but the contract's limit is 600 and that is what holds.
  const full = Array.from({ length: 40 }, (_, i) => `${i + 1}:30:w:86400:30`).join(';');
  assert.strictEqual(full.length, 670);
  assert.strictEqual(sensorTables.parseTables(full).ok, false);
});

// Every way a string can be wrong, each with the reason the parse gives. None
// of the reasons may quote the value back.
const INVALID = [
  ['', 'empty'],
  ['1:0:f', 'a missing part'],
  ['1:0:f:5:9:9', 'a sixth part'],
  ['1:0:f:5:0', 'zero seats'],
  ['1:0:f:5:31', 'more than 30 seats'],
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

const seatsOf = (deviceId = 'flux_tables_01') => Object.fromEntries(tableStates
  .filter((r) => r.sensor_device_id === deviceId)
  .map((r) => [r.table_no, r.seats]));

test('seat counts reach the floor; a table sent without one keeps the last, and a new count replaces it', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:100:4;2:0:f:30;3:0:f:30:6' }) });
  await settle();
  assert.deepStrictEqual(seatsOf(), { 1: 4, 2: null, 3: 6 });
  assert.deepStrictEqual(countsOf(readings[0]), [3, 1, 0, 0], 'seats change no count');

  ageDevice();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:130;2:0:f:60:2;3:0:f:60' }) });
  await settle();
  assert.deepStrictEqual(seatsOf(), { 1: 4, 2: 2, 3: 6 }, 'a reading without a count forgot the one it had');

  ageDevice();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:160:8;3:0:f:90' }) });
  await settle();
  assert.deepStrictEqual(seatsOf(), { 1: 8, 3: 6 });
});

test('a seat count out of range is ignored with the rest of the value: 201, null counts, the floor untouched', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:100:4' }) });
  await settle();
  ageDevice();
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:0:c:5:31' }) });
  assert.strictEqual(res.status, 201, res.raw);
  await settle();
  assert.strictEqual(readings.length, 2);
  assert.deepStrictEqual(countsOf(readings[1]), [null, null, null, null]);
  assert.deepStrictEqual(floorOf(), ['1:2:s']);
  assert.deepStrictEqual(seatsOf(), { 1: 4 });
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

// --- The table alert ------------------------------------------------------------
//
// One push to the venue's verified owner when a table changes INTO waiting or
// into needs-clearing, compared with its row from before the reading. Never on
// a repeat, never past the owner's switch, never to an unverified claim, at
// most once per unit, table and state in fifteen minutes, and never able to
// touch the device's answer.

// Two live readings in a row from the first unit, the flood guard aged between.
async function readings2(first, second) {
  const a = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: first }) });
  assert.strictEqual(a.status, 201, a.raw);
  await settle();
  ageDevice();
  const b = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: second }) });
  assert.strictEqual(b.status, 201, b.raw);
  await settle();
}

test('a table that starts waiting sends the verified owner one push, in exactly these words', async () => {
  reset();
  await readings2('1:0:f:30;3:2:s:200', '1:0:f:60;3:2:w:410');
  assert.strictEqual(pushes.length, 1, JSON.stringify(pushes));
  assert.deepStrictEqual(pushes[0], {
    userId: OWNER_ID,
    title: 'Table 3',
    body: 'Seated 6 min and nobody has stopped by yet.',
    data: { type: 'table_alert', table: '3', state: 'waiting' },
  });
});

test('a party that leaves an uncleared table sends the clearing words', async () => {
  reset();
  await readings2('2:4:w:500', '2:0:c:15');
  assert.strictEqual(pushes.length, 1);
  assert.deepStrictEqual(
    [pushes[0].title, pushes[0].body, pushes[0].data.state],
    ['Table 2', "The party left and the table hasn't been cleared.", 'needs_clearing']
  );
});

test('a table that stays waiting is told once, not once per reading', async () => {
  reset();
  await readings2('3:2:s:200', '3:2:w:410');
  for (let i = 0; i < 3; i += 1) {
    ageDevice();
    await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: `3:2:w:${440 + i * 30}` }) });
    await settle();
  }
  assert.strictEqual(pushes.length, 1);
});

test('a table with no row before has no change to report, whatever its state', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:w:900;2:0:c:400' }) });
  await settle();
  assert.deepStrictEqual(pushes, []);
  assert.ok(!queryLog.some((q) => /FROM venue_profiles/.test(q.sql)), 'nothing to tell, so nobody is looked up');
});

test('changes into free or seated are not alerts', async () => {
  reset();
  await readings2('1:0:c:30;2:3:w:400', '1:0:f:2;2:3:s:420');
  assert.deepStrictEqual(pushes, []);
});

test('two tables changing in one reading are two pushes, each in its own lock-screen slot', async () => {
  reset();
  await readings2('3:2:s:200;5:0:s:600', '3:2:w:400;5:0:c:5');
  assert.deepStrictEqual(pushes.map((p) => p.title), ['Table 3', 'Table 5']);
  const slots = pushes.map((p) => firebaseService.collapseId(p.data));
  assert.deepStrictEqual(slots, ['table_alert-t3', 'table_alert-t5']);
});

test('the waiting minutes are whole minutes since the party arrived, never less than one', async () => {
  reset();
  await readings2('4:2:s:10', '4:2:w:20');
  assert.strictEqual(pushes[0].body, 'Seated 1 min and nobody has stopped by yet.');
  assert.deepStrictEqual(sensorTables.tableAlertCopy({ table_no: 9, state: 'w', minutes: 0 }).body,
    'Seated 1 min and nobody has stopped by yet.');
  assert.deepStrictEqual(sensorTables.tableAlertCopy({ table_no: 9, state: 'w', minutes: 61 }),
    { title: 'Table 9', body: 'Seated 61 min and nobody has stopped by yet.' });
});

test('the owner who switched table alerts off is not pushed; a switch never touched is on', async () => {
  for (const [prefs, expected] of [
    [{ tables: false }, 0],
    [{ tables: true }, 1],
    [{ bookings: false }, 1],
    [{}, 1],
    [null, 1],
    ['legacy-garbage', 1],
  ]) {
    reset();
    venueProfiles[0].notification_prefs = prefs;
    await readings2('3:2:s:200', '3:2:w:410');
    assert.strictEqual(pushes.length, expected, `prefs ${JSON.stringify(prefs)}`);
    if (expected === 0) {
      assert.ok(!queryLog.some((q) => /INSERT INTO push_debounce/.test(q.sql)), 'a refused alert burned its claim');
    }
  }
});

test('an unverified claim on the venue is told nothing, and the lookup asks for a verified owner', async () => {
  reset();
  venueProfiles = [{ user_id: OWNER_ID, google_place_id: VENUE, verified: false, notification_prefs: {} }];
  await readings2('3:2:s:200', '3:2:w:410');
  assert.deepStrictEqual(pushes, []);
  const lookup = queryLog.find((q) => /FROM venue_profiles/.test(q.sql));
  assert.ok(lookup, 'the owner lookup ran');
  assert.match(lookup.sql, /AND verified = true/);
  assert.deepStrictEqual(lookup.params, [VENUE], 'the place comes from the device row');
});

test('a venue with no owner on record sends nothing and claims nothing', async () => {
  reset();
  venueProfiles = [];
  await readings2('3:2:s:200', '3:2:w:410');
  assert.deepStrictEqual(pushes, []);
  assert.strictEqual(claims.size, 0);
});

test('at most one push per unit, table and state in fifteen minutes, however the states move', async () => {
  reset();
  await readings2('3:2:s:200', '3:2:w:410');
  // The box lets one seating wait once, so waiting again this soon means a
  // fast turnover or a restarted unit. Either way the phone has heard it.
  for (const tables of ['3:2:s:440', '3:2:w:470', '3:2:s:500', '3:2:w:530']) {
    ageDevice();
    await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables }) });
    await settle();
  }
  assert.strictEqual(pushes.length, 1, 'the flicker rang the phone again');
  const key = 'table_alert:flux_tables_01:3:w';
  assert.ok(claims.has(key), `claimed under ${[...claims.keys()]}`);
  assert.deepStrictEqual(queryLog.find((q) => /INSERT INTO push_debounce/.test(q.sql)).params,
    [key, sensorTables.TABLE_ALERT_WINDOW_MINUTES]);
  assert.strictEqual(sensorTables.TABLE_ALERT_WINDOW_MINUTES, 15);

  // Another state of the same table is its own alert.
  ageDevice();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '3:0:c:5' }) });
  await settle();
  assert.strictEqual(pushes.length, 2);

  // And once the window has passed, the same change is news again.
  claims.set(key, Date.now() - 16 * 60 * 1000);
  for (const tables of ['3:0:f:20', '3:2:s:30', '3:2:w:400']) {
    ageDevice();
    await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables }) });
    await settle();
  }
  assert.strictEqual(pushes.length, 3);
});

test('the window is per unit: the same table number on another unit at the venue is its own alert', async () => {
  reset();
  await readings2('3:2:s:200', '3:2:w:410');
  await call('/api/sensors/data', { apiKey: OTHER_KEY, body: reading({ tables: '3:1:s:100' }) });
  await settle();
  ageDevice('flux_tables_02');
  await call('/api/sensors/data', { apiKey: OTHER_KEY, body: reading({ tables: '3:1:w:400' }) });
  await settle();
  assert.strictEqual(pushes.length, 2);
});

test('with push unconfigured nothing is read and no claim is spent', async () => {
  reset();
  pushConfigured = false;
  await readings2('3:2:s:200', '3:2:w:410');
  assert.deepStrictEqual(pushes, []);
  assert.ok(!queryLog.some((q) => /FROM venue_profiles|push_debounce/.test(q.sql)));
});

test('a push that throws never fails the ingest, and the floor is still written', async () => {
  reset();
  pushBehaviour = async () => { throw new Error('FCM unreachable'); };
  let second;
  const lines = await capturingLogs(async () => {
    await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '3:2:s:200' }) });
    await settle();
    ageDevice();
    second = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '3:2:w:410' }) });
    await settle();
  });
  assert.strictEqual(second.status, 201);
  assert.deepStrictEqual(Object.keys(second.body).sort(), ['recorded_at', 'success']);
  assert.strictEqual(pushes.length, 1, 'the push was attempted');
  assert.deepStrictEqual(floorOf(), ['3:2:w']);
  assert.strictEqual(readings.length, 2);
  assert.ok(lines.some((l) => /Table alert for flux_tables_01 table 3 failed/.test(l)), lines.join('\n'));
});

test('a push that throws synchronously, or an owner lookup that fails, is caught the same way', async () => {
  reset();
  pushBehaviour = () => { throw new Error('push client blew up'); };
  await readings2('3:2:s:200;4:0:s:100', '3:2:w:410;4:0:c:5');
  assert.strictEqual(pushes.length, 2, 'one failed push must not stop the next table');

  reset();
  const realQuery = pool.query;
  pool.query = (sql, params) => (/FROM venue_profiles/.test(String(sql))
    ? Promise.reject(new Error('connection terminated'))
    : realQuery(sql, params));
  try {
    let res;
    const lines = await capturingLogs(async () => {
      await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '3:2:s:200' }) });
      await settle();
      ageDevice();
      res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '3:2:w:410' }) });
      await settle();
    });
    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(floorOf(), ['3:2:w']);
    assert.ok(lines.some((l) => /Table alerts for flux_tables_01 failed: connection terminated/.test(l)), lines.join('\n'));
  } finally {
    pool.query = realQuery;
  }
});

test('a push that never settles cannot hold the device answer', async () => {
  reset();
  let release;
  pushBehaviour = () => new Promise((resolve) => { release = resolve; });
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '3:2:s:200' }) });
  await settle();
  ageDevice();
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '3:2:w:410' }) });
  assert.strictEqual(res.status, 201);
  // The push is reached only after the floor write, so give that its turn.
  for (let i = 0; i < 50 && typeof release !== 'function'; i += 1) await new Promise((r) => setImmediate(r));
  assert.strictEqual(typeof release, 'function', 'the push was never attempted');
  release({ sent: 1, failed: 0 });
  await settle();
});

test('the push carries a table and a state and nothing about anybody at it', async () => {
  reset();
  await readings2('3:4:s:200', '3:4:w:410');
  assert.deepStrictEqual(Object.keys(pushes[0].data).sort(), ['state', 'table', 'type']);
  assert.ok(!/4 people|people|guest/i.test(`${pushes[0].title} ${pushes[0].body}`));
});

// The lexicon pushGuideline454.test.js holds the crowd alert to: a notification
// that names an offer, a price or an upgrade is marketing under App Store 4.5.4.
const MARKETING = /\b(pro|premium|upgrade|subscribe|subscription|offer|deal|discount|sale|trial|unlock|paywall|buy|redeem|promo|exclusive|limited time|free)\b|[%$]/i;

test('the alert copy promotes nothing and carries no em or en dash', () => {
  for (const change of [{ table_no: 3, state: 'w', minutes: 6 }, { table_no: 12, state: 'c', minutes: 1 }]) {
    const { title, body } = sensorTables.tableAlertCopy(change);
    const text = `${title} ${body}`;
    assert.strictEqual(text.match(MARKETING), null, text);
    assert.ok(!/[–—]/.test(text), text);
  }
});

test('a table alert in the owner\'s quiet hours is dropped, not held until morning', () => {
  assert.ok(pushHelper.DROPPED_IN_QUIET_HOURS.has('table_alert'));
  assert.ok(!pushHelper.RINGS_THROUGH_THE_NIGHT.has('table_alert'), 'only safety rings through the night');
});

// --- The owner's routes -----------------------------------------------------------
//
// GET /api/sensors/:placeId/tables and /tables/hours: the venue's verified owner
// only, the gate /status uses.

const get = (path, user) => call(path, { method: 'GET', user });
const FLOOR = `/api/sensors/${VENUE}/tables`;
const HOURS = `/api/sensors/${VENUE}/tables/hours`;

test('the table routes are for the verified owner only: 401 signed out, 403 for anyone else, and nothing read behind the gate', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: EXAMPLE }) });
  await settle();
  for (const path of [FLOOR, HOURS]) {
    const signedOut = await get(path);
    assert.strictEqual(signedOut.status, 401, path);

    queryLog = [];
    const stranger = await get(path, 999);
    assert.strictEqual(stranger.status, 403, path);
    assert.match(stranger.body.error, /verified owner/);
    assert.ok(!/table_no|needs_clearing|"tables"|"hours"/.test(stranger.raw), stranger.raw);
    assert.ok(!queryLog.some((q) => /sensor_table_states|venue_sensor_data/.test(q.sql)), `${path}: read behind a refused gate`);
    const gate = queryLog.find((q) => /FROM venue_profiles/.test(q.sql));
    assert.match(gate.sql, /AND verified = true/);
    assert.deepStrictEqual(gate.params, [999, VENUE]);
  }
  // A claim on the place that is not verified is not the owner.
  venueProfiles[0].verified = false;
  for (const path of [FLOOR, HOURS]) assert.strictEqual((await get(path, OWNER_ID)).status, 403, path);
});

test('an over-long place id is a 400 before anything is read', async () => {
  reset();
  queryLog = [];
  const res = await get(`/api/sensors/${'x'.repeat(256)}/tables`, OWNER_ID);
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(queryLog, []);
});

test('the floor: words for states, when each began, seats, in number order, fresh right after a live reading', async () => {
  reset();
  const ingest = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:0:f:340;2:3:s:845:4;3:2:w:410;4:0:c:95:6' }) });
  await settle();
  const res = await get(FLOOR, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['next_free', 'stale', 'tables', 'updated_at']);
  const at = new Date(ingest.body.recorded_at).getTime();
  assert.deepStrictEqual(res.body.tables, [
    { number: 1, people: 0, state: 'free', since: new Date(at - 340000).toISOString(), seats: null },
    { number: 2, people: 3, state: 'seated', since: new Date(at - 845000).toISOString(), seats: 4 },
    { number: 3, people: 2, state: 'waiting', since: new Date(at - 410000).toISOString(), seats: null },
    { number: 4, people: 0, state: 'needs_clearing', since: new Date(at - 95000).toISOString(), seats: 6 },
  ]);
  assert.strictEqual(res.body.updated_at, new Date(at).toISOString());
  assert.strictEqual(res.body.stale, false);
  assert.strictEqual(res.body.next_free, 2, 'table 2 has been seated longest');
  assert.ok(!/flux_tables|sensor_device|api_key|sha256/.test(res.raw), 'unit ids and keys stay on the server');
});

test('next_free is the seated or waiting table whose party has sat longest; a tie goes to the lower number; none without a party', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:300;2:3:w:900;3:0:c:5000;4:2:s:900;5:0:f:9000' }) });
  await settle();
  assert.strictEqual((await get(FLOOR, OWNER_ID)).body.next_free, 2, 'the tie between 2 and 4 goes to 2; c and f never count');

  ageDevice();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:0:f:10;2:0:c:20;3:0:c:30' }) });
  await settle();
  assert.strictEqual((await get(FLOOR, OWNER_ID)).body.next_free, null);
});

test('a floor nobody has written is empty, unknown and stale', async () => {
  reset();
  const res = await get(FLOOR, OWNER_ID);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { tables: [], updated_at: null, stale: true, next_free: null });
});

test('a floor not refreshed for three minutes is stale, and still shown', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:100' }) });
  await settle();
  for (const r of tableStates) r.updated_at = new Date(Date.now() - 4 * 60 * 1000);
  const res = await get(FLOOR, OWNER_ID);
  assert.strictEqual(res.body.stale, true);
  assert.strictEqual(res.body.tables.length, 1);
  assert.ok(queryLog.some((q) => /WITH unit AS/.test(q.sql) && q.params[1] === 3), 'the window is three minutes');
});

test('hours: the owner gets one row per hour with tables, oldest first, as numbers; readings without tables are left out', async () => {
  reset();
  const HOUR = 3600 * 1000;
  const lastHour = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  const at = (h, m) => new Date(lastHour - h * HOUR + m * 60 * 1000).toISOString();
  // Backfill (older than 15 minutes, so no flood guard), across three hours.
  const sends = [
    [at(2, 5), '1:2:s:60;2:0:f:60;3:0:f:60'],
    [at(2, 35), '1:2:s:60;2:3:w:400;3:0:f:60'],
    [at(1, 10), null],
    [at(1, 20), '1:0:f:9;2:0:c:9'],
    [at(0, 15), '1:2:s:60;2:2:s:60;3:2:s:60;4:1:w:400'],
  ];
  for (const [stamp, tables] of sends) {
    const res = await call('/api/sensors/data', {
      apiKey: KEY, body: reading(tables ? { recorded_at: stamp, tables } : { recorded_at: stamp }),
    });
    assert.strictEqual(res.status, 201, res.raw);
  }
  const res = await get(HOURS, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(res.body, {
    hours: [
      { hour: new Date(lastHour - 2 * HOUR).toISOString(), occupied: 1.5, total: 3 },
      { hour: new Date(lastHour - HOUR).toISOString(), occupied: 0, total: 2 },
      { hour: new Date(lastHour).toISOString(), occupied: 4, total: 4 },
    ],
  });
});

test('hours with no table readings is an empty list, not an error', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: KEY, body: reading() });
  const res = await get(HOURS, OWNER_ID);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { hours: [] });
});

test('a failing read is a 500 with nothing in it but the error', async () => {
  reset();
  const realQuery = pool.query;
  pool.query = (sql, params) => (/sensor_table_states|tables_total > 0/.test(String(sql))
    ? Promise.reject(new Error('connection terminated'))
    : realQuery(sql, params));
  try {
    const logged = await capturingLogs(async () => {
      for (const path of [FLOOR, HOURS]) {
        const res = await get(path, OWNER_ID);
        assert.strictEqual(res.status, 500, path);
        assert.deepStrictEqual(Object.keys(res.body), ['error']);
      }
    });
    assert.ok(logged.some((l) => /Get table floor error/.test(l)));
    assert.ok(logged.some((l) => /Get table hours error/.test(l)));
  } finally {
    pool.query = realQuery;
  }
});

test('the switch is stored when the dashboard sends it: tables is one of the venue profile switches', () => {
  // routes/venueProfile.js drops every key it does not know, so a switch it
  // did not list would look saved and be forgotten.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'venueProfile.js'), 'utf8');
  assert.match(src, /const PREF_KEYS = \[[^\]]*'tables'[^\]]*\];/);
  assert.strictEqual(sensorTables.wantsTableAlerts({ tables: false }), false);
  assert.strictEqual(sensorTables.wantsTableAlerts({ tables: true }), true);
  assert.strictEqual(sensorTables.wantsTableAlerts(undefined), true);
});
