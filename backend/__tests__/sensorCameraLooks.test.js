// Run: node --test  (from backend/)
//
// THE TABLE CAMERA'S LOOKS (services/sensorCameraLooks.js), through the real
// router against the modelled store sensorTables.test.js uses. Pinned here:
//
//   * A bad camera_looks value is DROPPED, never refused: the Pi drops a whole
//     reading on a 400, so the reading is stored and only the field goes.
//   * A bad ENTRY drops only itself; the good looks beside it are stored,
//     since the unit sends each look once and has already forgotten it.
//   * A retried delivery (answered as a duplicate) stores nothing twice.
//   * The owner's day of looks is behind the same owner and plan gate as the
//     other table routes, and returns words and numbers only.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');

process.env.JWT_SECRET = 'sensor-camera-looks-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');
const {
  INGEST_STATEMENT, runIngest, SILENT_UNIT_STATEMENT, runSilentUnit,
} = require('./helpers/sensorStoreModel');
const { dispatchTableHistory } = require('./helpers/tableHistoryModel');

let devices = [];
let readings = [];
let tableStates = [];
let seatings = [];
let looks = [];
let venueProfiles = [];
let venueTiers = new Map();
let queryLog = [];
let insertFails = false;
const mlVenues = [];

const flatten = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const INSERT_FLAT = /^WITH gone AS \( DELETE FROM sensor_camera_looks WHERE sensor_device_id = \$1 AND received_at < NOW\(\) - make_interval\(days => \$8::int\) \) INSERT INTO sensor_camera_looks/;
const DAY_FLAT = /^WITH d AS \(SELECT COALESCE\(\$3::date, \(NOW\(\) AT TIME ZONE \$2\)::date\) AS day\)/;

pool.query = (sql, params = []) => {
  const flat = flatten(sql);
  queryLog.push({ sql: flat, params });
  if (INGEST_STATEMENT.test(flat)) return Promise.resolve(runIngest({ devices, readings, tableStates }, params));
  if (SILENT_UNIT_STATEMENT.test(flat)) return Promise.resolve(runSilentUnit({ tableStates, seatings }, params));
  if (INSERT_FLAT.test(flat)) {
    if (insertFails) return Promise.reject(new Error('connection terminated'));
    const [deviceId, placeId, ats, kinds, tables, results, founds] = params;
    const now = new Date();
    kinds.forEach((look, i) => {
      looks.push({
        id: looks.length + 1, sensor_device_id: deviceId, venue_place_id: placeId,
        at: ats[i] ? new Date(ats[i]) : null, received_at: now, look, table_no: tables[i], result: results[i], found: founds[i],
      });
    });
    return Promise.resolve({ rows: [], rowCount: kinds.length });
  }
  if (DAY_FLAT.test(flat)) {
    // The day on UTC (no venue zone here), today unless asked.
    const [placeId, zone, day, limit] = params;
    assert.equal(zone, 'UTC');
    const d = day || new Date().toISOString().slice(0, 10);
    const lo = Date.parse(`${d}T00:00:00Z`);
    const hi = lo + 86400000;
    const when = (r) => (r.at || r.received_at).getTime();
    const hits = looks.filter((r) => r.venue_place_id === placeId && when(r) >= lo && when(r) < hi)
      .sort((a, b) => when(b) - when(a) || b.id - a.id);
    const rows = hits.length === 0
      ? [{ day: d, at: null, received_at: null, look: null, table_no: null, result: null, found: null, total: '0' }]
      : hits.slice(0, limit).map((r) => ({ day: d, ...r, total: String(hits.length) }));
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/^SELECT 1 FROM venue_profiles WHERE user_id = \$1 AND google_place_id = \$2 AND verified = true/.test(flat)) {
    const hit = venueProfiles.find((v) => v.user_id === params[0] && v.google_place_id === params[1] && v.verified);
    return Promise.resolve({ rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 });
  }
  if (/FROM venue_profiles vp LEFT JOIN venue_subscriptions/.test(flat)) {
    const tier = venueTiers.get(params[0]);
    const rows = tier === undefined ? [] : [{
      tier, grant_tier: null, grant_status: null, grant_source: null, granted_reason: null, granted_at: null,
      expires_at: null, roost_legacy: false, roost_notice_until: null, grant_place_id: null, place_id: VENUE,
      current_period_end: null, cancel_at: null, trial_end: null, verified: true,
    }];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/^SELECT 1 FROM sensor_table_states WHERE venue_place_id = \$1 LIMIT 1$/.test(flat)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  const history = dispatchTableHistory({ tableStates, seatings, readings, venueProfiles, mlVenues }, flat, params);
  if (history) return Promise.resolve(history);
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, res, next) => {
  const id = Number(req.headers['x-test-user']);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id, name: 'Owner', role: 'user' };
  return next();
};

const sensorRouter = require('../routes/sensors');
const sensorCameraLooks = require('../services/sensorCameraLooks');
const { readCameraLooks, MAX_CAMERA_LOOKS } = sensorCameraLooks;

const io = { to() { return { emit() {} }; } };
const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/sensors', sensorRouter);
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const KEY = 'd'.repeat(64);
const VENUE = 'ChIJcameraLooks000001';
const OWNER_ID = 52;
const digestOf = (key) => 'sha256:' + crypto.createHash('sha256').update(key, 'utf8').digest('hex');

function reset() {
  readings = [];
  tableStates = [];
  seatings = [];
  looks = [];
  queryLog = [];
  insertFails = false;
  venueProfiles = [{ user_id: OWNER_ID, google_place_id: VENUE, verified: true, notification_prefs: {} }];
  delete process.env.VENUE_BILLING_ENABLED;
  venueTiers = new Map([[OWNER_ID, 'free']]);
  devices = [{ id: 1, device_id: 'flux_cam_01', venue_place_id: VENUE, is_active: true, api_key: digestOf(KEY), last_seen_at: null }];
  sensorCameraLooks._resetNotes();
}

const reading = (extra = {}) => ({ ir_beam_count: 9, thermal_headcount: 17, noise_db: 66.5, ...extra });
const settle = () => sensorCameraLooks._settled();
const recent = (msAgo = 60000) => new Date(Date.now() - msAgo).toISOString();

async function capturingLogs(fn) {
  const lines = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.warn = realWarn; console.error = realError; }
  return lines;
}

// --- The parse --------------------------------------------------------------

test('every result the unit sends parses, room and table, with an unsynced clock', () => {
  const at = recent();
  const out = readCameraLooks([
    { at, look: 'room', table: null, result: 'found', found: 12 },
    { at, look: 'room', table: null, result: 'failed' },
    { at: null, look: 'room', table: null, result: 'person' },
    { at, look: 'table', table: 3, result: 'clear' },
    { at, look: 'table', table: 4, result: 'dishes' },
    { at, look: 'table', table: 200, result: 'person' },
    { at, look: 'table', table: 1, result: 'failed' },
  ]);
  assert.equal(out.ignored, null);
  assert.equal(out.looks.length, 7);
  assert.deepStrictEqual(out.looks[0], { at: new Date(at), look: 'room', table: null, result: 'found', found: 12 });
  assert.equal(out.looks[2].at, null);
  assert.deepStrictEqual(out.looks[4], { at: new Date(at), look: 'table', table: 4, result: 'dishes', found: null });
});

test('absent or null is nothing sent; not an array, or more than 50, drops the whole field', () => {
  assert.deepStrictEqual(readCameraLooks(undefined), { looks: null, ignored: null });
  assert.deepStrictEqual(readCameraLooks(null), { looks: null, ignored: null });
  assert.equal(readCameraLooks('room:found').looks, null);
  assert.match(readCameraLooks({ look: 'room' }).ignored, /not an array/);
  const one = { at: recent(), look: 'table', table: 2, result: 'clear' };
  assert.equal(readCameraLooks(Array(MAX_CAMERA_LOOKS).fill(one)).looks.length, 50);
  const over = readCameraLooks(Array(MAX_CAMERA_LOOKS + 1).fill(one));
  assert.equal(over.looks, null);
  assert.match(over.ignored, /more than 50/);
});

test('a bad entry drops only itself, and the reason never quotes the value', () => {
  const good = { at: recent(), look: 'table', table: 2, result: 'clear' };
  const bad = [
    'room',
    [good],
    { ...good, look: 'door' },
    { ...good, result: 'found' },                    // found is a room result
    { ...good, look: 'room', table: null, result: 'clear' },
    { ...good, table: 0 },
    { ...good, table: 201 },
    { ...good, table: '2' },
    { ...good, table: null },
    { at: recent(), look: 'room', table: 4, result: 'failed' },
    { at: recent(), look: 'room', result: 'found' },  // found count missing
    { at: recent(), look: 'room', result: 'found', found: -1 },
    { at: recent(), look: 'room', result: 'found', found: 2.5 },
    { ...good, found: 3 },                           // found on a table look
    { ...good, at: '2026-10-27 21:00:00' },
    { ...good, at: 'yesterday' },
    { ...good, at: 1730000000 },
    { ...good, at: new Date(Date.now() + 3600000).toISOString() },
    { ...good, at: new Date(Date.now() - 91 * 86400000).toISOString() },
    { ...good, image: 'data:image/jpeg;base64,AAAA' },
  ];
  const out = readCameraLooks([good, ...bad, good]);
  assert.equal(out.looks.length, 2);
  assert.equal(out.ignored, `${bad.length} of ${bad.length + 2} entries not in the contract`);
  assert.doesNotMatch(out.ignored, /base64|door|yesterday/);
});

// --- Through the ingest -------------------------------------------------------

test('the looks ride in a reading and are stored for the unit\'s venue', async () => {
  reset();
  const at = recent();
  const res = await call('/api/sensors/data', {
    apiKey: KEY,
    body: reading({ camera_looks: [
      { at, look: 'room', table: null, result: 'found', found: 9 },
      { at: null, look: 'table', table: 3, result: 'dishes' },
    ] }),
  });
  assert.equal(res.status, 201);
  await settle();
  assert.equal(readings.length, 1);
  assert.equal(looks.length, 2);
  assert.deepStrictEqual(
    looks.map((l) => [l.sensor_device_id, l.venue_place_id, l.at && l.at.toISOString(), l.look, l.table_no, l.result, l.found]),
    [['flux_cam_01', VENUE, at, 'room', null, 'found', 9], ['flux_cam_01', VENUE, null, 'table', 3, 'dishes', null]]
  );
  // The 90-day delete rides in the same statement.
  const insert = queryLog.find((q) => INSERT_FLAT.test(q.sql));
  assert.equal(insert.params[7], 90);
});

test('an oversized or malformed field is refused alone: the reading is still a 201 and stored, and the log says why once', async () => {
  reset();
  const one = { at: recent(), look: 'table', table: 2, result: 'clear' };
  let res;
  const lines = await capturingLogs(async () => {
    res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ camera_looks: Array(51).fill(one) }) });
    await settle();
  });
  assert.equal(res.status, 201);
  assert.equal(readings.length, 1);
  assert.equal(looks.length, 0);
  assert.equal(queryLog.filter((q) => INSERT_FLAT.test(q.sql)).length, 0);
  assert.equal(lines.filter((l) => /camera_looks were dropped \(more than 50 entries\)/.test(l)).length, 1);

  for (const value of ['nope', { a: 1 }, 7, true]) {
    devices[0].last_seen_at = Date.now() - 60000;
    const r = await capturingLogs(async () => {
      const out = await call('/api/sensors/data', { apiKey: KEY, body: reading({ camera_looks: value }) });
      assert.equal(out.status, 201, `camera_looks ${JSON.stringify(value)} refused the reading`);
    });
    assert.ok(r.every((l) => !l.includes('nope')));
  }
  await settle();
  assert.equal(readings.length, 5);
  assert.equal(looks.length, 0);
});

test('bad entries are dropped and the good ones beside them stored', async () => {
  reset();
  const lines = await capturingLogs(async () => {
    const res = await call('/api/sensors/data', {
      apiKey: KEY,
      body: reading({ camera_looks: [
        { at: recent(), look: 'table', table: 5, result: 'clear' },
        { at: recent(), look: 'table', table: 5, result: 'found' },
        { at: recent(), look: 'room', result: 'person' },
      ] }),
    });
    assert.equal(res.status, 201);
    await settle();
  });
  assert.deepStrictEqual(looks.map((l) => l.result), ['clear', 'person']);
  assert.ok(lines.some((l) => /1 of 3 entries not in the contract/.test(l)));
});

test('a retried delivery of the same reading stores its looks once', async () => {
  reset();
  const body = reading({ recorded_at: recent(5000), camera_looks: [{ at: recent(), look: 'table', table: 1, result: 'failed' }] });
  const first = await call('/api/sensors/data', { apiKey: KEY, body });
  devices[0].last_seen_at = Date.now() - 60000;
  const again = await call('/api/sensors/data', { apiKey: KEY, body });
  await settle();
  assert.equal(first.status, 201);
  assert.equal(again.body.duplicate, true);
  assert.equal(looks.length, 1);
});

test('a failed write is logged and changes nothing the device was told', async () => {
  reset();
  insertFails = true;
  let res;
  const lines = await capturingLogs(async () => {
    res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ camera_looks: [{ at: null, look: 'room', result: 'failed' }] }) });
    await settle();
  });
  assert.equal(res.status, 201);
  assert.equal(readings.length, 1);
  assert.ok(lines.some((l) => /Camera looks for flux_cam_01 failed/.test(l)));
});

test('a body that fails validation stores no looks', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: KEY, body: reading({ noise_db: 'loud', camera_looks: [{ at: null, look: 'room', result: 'failed' }] }),
  });
  await settle();
  assert.equal(res.status, 400);
  assert.equal(looks.length, 0);
});

// --- The owner's day of looks --------------------------------------------------

const LOOKS_PATH = `/api/sensors/${VENUE}/tables/camera-looks`;

test('the owner reads today\'s looks, newest first, with the count and nothing else', async () => {
  reset();
  await call('/api/sensors/data', {
    apiKey: KEY,
    body: reading({ camera_looks: [
      { at: recent(120000), look: 'room', result: 'found', found: 7 },
      { at: recent(60000), look: 'table', table: 2, result: 'dishes' },
    ] }),
  });
  await settle();
  const res = await call(LOOKS_PATH, { method: 'GET', user: OWNER_ID });
  assert.equal(res.status, 200);
  assert.equal(res.body.day, new Date().toISOString().slice(0, 10));
  assert.equal(res.body.timeZone, null);
  assert.equal(res.body.count, 2);
  assert.deepStrictEqual(res.body.looks.map((l) => [l.look, l.table, l.result, l.found]), [
    ['table', 2, 'dishes', null], ['room', null, 'found', 7],
  ]);
  for (const l of res.body.looks) {
    assert.deepStrictEqual(Object.keys(l).sort(), ['at', 'found', 'look', 'received_at', 'result', 'table']);
  }
});

test('an empty day is a count of 0 and an empty list; a past day is asked by date', async () => {
  reset();
  const res = await call(`${LOOKS_PATH}?day=2026-01-02`, { method: 'GET', user: OWNER_ID });
  assert.equal(res.status, 200);
  assert.deepStrictEqual(res.body, { day: '2026-01-02', timeZone: null, count: 0, looks: [] });
});

test('the route is the owner\'s alone, behind the plan, and a bad day is a 400', async () => {
  reset();
  assert.equal((await call(LOOKS_PATH, { method: 'GET' })).status, 401);
  assert.equal((await call(LOOKS_PATH, { method: 'GET', user: 99 })).status, 403);
  assert.equal((await call(`${LOOKS_PATH}?day=tomorrow`, { method: 'GET', user: OWNER_ID })).status, 400);
  assert.equal((await call(`${LOOKS_PATH}?day=2026-02-30`, { method: 'GET', user: OWNER_ID })).status, 400);
  assert.equal((await call(`${LOOKS_PATH}?day=2026-01-01&day=2026-01-02`, { method: 'GET', user: OWNER_ID })).status, 400);
  process.env.VENUE_BILLING_ENABLED = 'true';
  try {
    const locked = await call(LOOKS_PATH, { method: 'GET', user: OWNER_ID });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.has_tables, false);
  } finally {
    delete process.env.VENUE_BILLING_ENABLED;
  }
});
