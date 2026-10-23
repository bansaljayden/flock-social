// Run: node --test  (from backend/)
//
// TABLE HISTORY, through the real router against the modelled store.
//
// Phase 1 (sensorTables.test.js) is the floor: what each table is doing now.
// This suite is phase 2: the seatings the floor writes behind it (migration
// 131, services/sensorTables.js THE HISTORY) and everything read back out of
// them (services/tableHistory.js): likely_free_at and the seats fallback on
// the floor, the turn, wait and clear figures, the waits by party size, the
// incoming plans laid over the floor, the owner's two switches, and the public
// summary the app reads. Four things are pinned here, each by the failure it
// prevents:
//
//   * A seating is built from the CHANGE between readings, dated by the unit's
//     own timers, so a party that sat at 19:02 is a seating from 19:02 however
//     late the box first said "seated".
//   * No median is said, and no wait or likely_free_at built, from fewer than
//     twenty closed seatings: a host told "ten minutes" on six turns is worse
//     off than a host told nothing.
//   * Weekdays and hours are the venue's, where the server knows its zone,
//     and the answer says which clock it used.
//   * What leaves the public summary is counts and minutes. Never a table
//     number, a per-table state or a unit id, and a venue that hid its tables
//     reads exactly like one with none.
//   * A unit that has gone dark keeps its rows on the owner's floor and has
//     no say in what is open now, and a fit nobody can judge (no seat count,
//     no party that size seen, more than four) is said as null, never as
//     "none fits".
//
// sensorTableHistoryStatement.test.js runs the same statements against a real,
// migrated Postgres.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const crypto = require('node:crypto');

process.env.JWT_SECRET = 'sensor-table-history-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

const {
  INGEST_STATEMENT, runIngest, TABLE_STATES_STATEMENT, runTableStates, SILENT_UNIT_STATEMENT, runSilentUnit,
  TABLE_SEATINGS_STATEMENT, runTableSeatings,
} = require('./helpers/sensorStoreModel');
const {
  FLOOR_READ, MEDIANS_READ, FULL_HOURS_READ, INCOMING_READ, dispatchTableHistory,
} = require('./helpers/tableHistoryModel');
const { clockInZone, civilTime, instantForWallClock } = require('../utils/venueZone');

const TABLE_LOCK_STATEMENT = /^SELECT pg_advisory_xact_lock\(hashtext\('sensor_tables:' \|\| \$1::text\)\)$/;

let devices = [];
let readings = [];
let tableStates = [];
let seatings = [];
let venueProfiles = [];
let mlVenues = [];
let flocks = [];
let venueTiers = new Map();
let queryLog = [];
// Swapped in by a test that needs one statement to fail or to be refused.
let queryOverride = null;

pool.query = (sql, params = []) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params });
  if (queryOverride) {
    const answer = queryOverride(flat, params);
    if (answer) return answer;
  }
  if (INGEST_STATEMENT.test(flat)) return Promise.resolve(runIngest({ devices, readings, tableStates }, params));
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT history|ROLLBACK TO SAVEPOINT history)$/.test(flat)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (TABLE_LOCK_STATEMENT.test(flat)) return Promise.resolve({ rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 });
  if (TABLE_STATES_STATEMENT.test(flat)) return Promise.resolve(runTableStates({ tableStates }, params));
  if (TABLE_SEATINGS_STATEMENT.test(flat)) return Promise.resolve(runTableSeatings({ seatings }, params));
  if (SILENT_UNIT_STATEMENT.test(flat)) return Promise.resolve(runSilentUnit({ tableStates, seatings }, params));
  if (/^SELECT user_id, notification_prefs FROM venue_profiles WHERE google_place_id = \$1/.test(flat)) {
    const hit = venueProfiles.find((v) => v.google_place_id === params[0] && v.verified === true);
    const rows = hit ? [{ user_id: hit.user_id, notification_prefs: hit.notification_prefs }] : [];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/^INSERT INTO push_debounce/.test(flat)) return Promise.resolve({ rows: [{ debounce_key: params[0] }], rowCount: 1 });
  if (/^SELECT 1 FROM venue_profiles WHERE user_id = \$1 AND google_place_id = \$2 AND verified = true LIMIT 1$/.test(flat)) {
    const hit = venueProfiles.find((v) => v.user_id === params[0] && v.google_place_id === params[1] && v.verified === true);
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
    const hit = tableStates.some((r) => r.venue_place_id === params[0]);
    return Promise.resolve({ rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 });
  }
  try {
    const history = dispatchTableHistory({ tableStates, seatings, readings, venueProfiles, mlVenues, flocks }, flat, params);
    if (history) return Promise.resolve(history);
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
};

pool.connect = async () => ({
  query: (sql, params) => pool.query(sql, params),
  release() {},
});

const authMod = require('../middleware/auth');
authMod.authenticate = (req, res, next) => {
  const id = Number(req.headers['x-test-user']);
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id, name: 'Owner', role: 'user' };
  return next();
};

const sensorRouter = require('../routes/sensors');
const sensorTables = require('../services/sensorTables');
const tableHistory = require('../services/tableHistory');

const pushHelper = require('../services/pushHelper');
pushHelper.isPushConfigured = () => false;

const app = express();
app.use(express.json());
app.set('io', { to() { return { emit() {} }; } });
app.use('/api/sensors', sensorRouter);
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

function call(pathname, { apiKey, body, method = 'POST', user } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (apiKey !== undefined) headers['x-api-key'] = apiKey;
    if (user !== undefined) headers['x-test-user'] = String(user);
    const req = http.request({ agent: false, host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
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

const KEY = 'h'.repeat(64);
const OTHER_KEY = 'i'.repeat(64);
const VENUE = 'ChIJtableHistory000001';
const OTHER = 'ChIJtableHistory000002';
const ZONE = 'America/New_York';
const OWNER_ID = 51;
const STRANGER_ID = 999;
const digestOf = (key) => 'sha256:' + crypto.createHash('sha256').update(key, 'utf8').digest('hex');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function reset() {
  queryLog = [];
  queryOverride = null;
  readings = [];
  tableStates = [];
  seatings = [];
  flocks = [];
  venueProfiles = [{ user_id: OWNER_ID, google_place_id: VENUE, verified: true, notification_prefs: { bookings: true } }];
  // The venue is in the corpus with its zone; the other venue is not.
  mlVenues = [{ google_place_id: VENUE, timezone: ZONE }];
  delete process.env.VENUE_BILLING_ENABLED;
  venueTiers = new Map([[OWNER_ID, 'free']]);
  devices = [
    { id: 1, device_id: 'flux_history_01', venue_place_id: VENUE, is_active: true, api_key: digestOf(KEY), last_seen_at: null },
    { id: 2, device_id: 'flux_history_02', venue_place_id: OTHER, is_active: true, api_key: digestOf(OTHER_KEY), last_seen_at: null },
  ];
  sensorTables._resetIgnoredNotes();
}

const reading = (extra = {}) => ({ ir_beam_count: 9, thermal_headcount: 17, noise_db: 66.5, ...extra });
const settle = () => sensorTables._settled();
const ageDevice = (deviceId = 'flux_history_01') => { devices.find((d) => d.device_id === deviceId).last_seen_at = Date.now() - MIN; };
const get = (pathname, user) => call(pathname, { method: 'GET', user });
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// One live reading from the first unit, the flood guard aged first, settled.
async function push(tables, extra = {}) {
  ageDevice();
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables, ...extra }) });
  assert.strictEqual(res.status, 201, res.raw);
  await settle();
  return new Date(res.body.recorded_at).getTime();
}

const mine = () => seatings.filter((g) => g.sensor_device_id === 'flux_history_01').sort((a, b) => a.id - b.id);
const shape = (g) => `${g.table_no}:${g.party_max}:${g.waited ? 'w' : '-'}:${g.left_at ? 'closed' : 'open'}:${g.cleared_at ? 'cleared' : '-'}`;

let nextSeeded = 100000;
// A seating row as the writer would leave it, for the read-side tests.
function seed(placeId, tableNo, seatedAtMs, turnMin, { waited = false, clearMin = null, party = 2, device = 'flux_history_01' } = {}) {
  const row = {
    id: nextSeeded++,
    sensor_device_id: device,
    table_no: tableNo,
    venue_place_id: placeId,
    seated_at: new Date(seatedAtMs),
    left_at: turnMin === null ? null : new Date(seatedAtMs + turnMin * MIN),
    party_max: party,
    waited,
    cleared_at: turnMin !== null && clearMin !== null ? new Date(seatedAtMs + (turnMin + clearMin) * MIN) : null,
  };
  seatings.push(row);
  return row;
}

// Instants in the last few weeks at the same wall clock as `atMs` in `zone`:
// one, two and three weeks earlier, by the zone's own calendar, so they land
// in the same weekday-and-hour cell whatever the clock did in between.
function sameCellEarlier(atMs, zone, weeks) {
  const c = civilTime(atMs, zone);
  const out = [];
  for (let k = 1; k <= weeks; k += 1) {
    const d = new Date(Date.UTC(c.year, c.month - 1, c.day - 7 * k, 12));
    out.push(instantForWallClock({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: c.hour, minute: c.minute }, zone));
  }
  return out;
}

// Twenty-one closed seatings in the same weekday-and-hour cell as `atMs`
// (seven per week over three weeks), with turns of `base` to `base` + 20
// minutes: median `base` + 10, so 50 as a rule.
function seedCell(atMs, placeId = VENUE, zone = ZONE, { count = 21, tableNo = 9, base = 40 } = {}) {
  const weeks = sameCellEarlier(atMs, zone, 3);
  let n = 0;
  const turns = Array.from({ length: count }, (_, i) => base + Math.round((20 * i) / (count - 1)));
  for (let i = 0; i < count; i += 1) {
    const week = weeks[i % weeks.length];
    // Minutes apart inside the hour, so no two are the same row.
    seed(placeId, tableNo, week + (i % 7) * 7 * MIN - (civilTime(week, zone).minute) * MIN, turns[i]);
    n += 1;
  }
  return { n, median: base + 10 };
}

const SUMMARY_KEYS = ['busy_hours', 'fits_now', 'open', 'party', 'stale', 'timeZone', 'total', 'updated_at', 'wait_minutes'];

// --- The seatings, through the ingest ---------------------------------------

test('a table going from free to seated opens a seating dated from its own timer; seated to needs-clearing closes it from the clearing timer; clearing to free clears it', async () => {
  reset();
  const t1 = await push('1:0:f:300;2:0:f:300');
  assert.deepStrictEqual(mine(), [], 'a free table opens nothing');

  const t2 = await push('1:2:s:90;2:0:f:390');
  assert.deepStrictEqual(mine().map(shape), ['1:2:-:open:-']);
  assert.strictEqual(mine()[0].seated_at.getTime(), t2 - 90 * 1000, 'seated_at is the reading time minus the seated timer');
  assert.strictEqual(mine()[0].venue_place_id, VENUE);
  assert.ok(t1 <= t2);

  await push('1:3:s:150;2:0:f:450');
  assert.deepStrictEqual(mine().map(shape), ['1:3:-:open:-'], 'party_max is the most people seen');
  await push('1:2:s:210;2:0:f:510');
  assert.strictEqual(mine()[0].party_max, 3, 'a smaller count later does not lower it');

  const t5 = await push('1:0:c:40;2:0:f:570');
  assert.deepStrictEqual(mine().map(shape), ['1:3:-:closed:-']);
  assert.strictEqual(mine()[0].left_at.getTime(), t5 - 40 * 1000, 'left_at is the reading time minus the clearing timer: when the table emptied');
  assert.strictEqual(mine()[0].cleared_at, null);

  const t6 = await push('1:0:f:10;2:0:f:630');
  assert.deepStrictEqual(mine().map(shape), ['1:3:-:closed:cleared']);
  assert.strictEqual(mine()[0].cleared_at.getTime(), t6, 'the clear is the reading that first saw the table free again');
  assert.strictEqual(mine().length, 1, 'one seating for one party');
});

test('any reading in waiting marks the seating waited, and it stays marked after a visit', async () => {
  reset();
  await push('3:2:s:100');
  await push('3:2:w:400');
  assert.deepStrictEqual(mine().map(shape), ['3:2:w:open:-']);
  await push('3:2:s:430');
  assert.strictEqual(mine()[0].waited, true, 'a visit ends the wait, not the record of it');
  await push('3:0:c:20');
  assert.deepStrictEqual(mine().map(shape), ['3:2:w:closed:-']);
});

test('a table going straight from seated to free closes the seating and clears it at once, so the next needs-clearing at that table is not read as its clear', async () => {
  reset();
  await push('4:2:s:100');
  const t = await push('4:0:f:5');
  assert.deepStrictEqual(mine().map(shape), ['4:2:-:closed:cleared']);
  assert.strictEqual(mine()[0].left_at.getTime(), t);
  assert.strictEqual(mine()[0].cleared_at.getTime(), t);
  // A short visit that never seated: f -> c -> f. No seating opens, and the
  // earlier seating, already cleared, is left alone.
  await push('4:0:c:95');
  const t4 = await push('4:0:f:30');
  assert.strictEqual(mine().length, 1);
  assert.notStrictEqual(mine()[0].cleared_at.getTime(), t4, 'the old seating was given a clear it did not have');
});

test('a first reading opens a seating only for a table that is seated or waiting, dated from the timer; needs-clearing and free open nothing', async () => {
  reset();
  const t = await push('1:2:s:1200;2:3:w:900;3:0:c:50;4:0:f:10');
  assert.deepStrictEqual(mine().map(shape), ['1:2:-:open:-', '2:3:w:open:-']);
  assert.strictEqual(mine()[0].seated_at.getTime(), t - 1200 * 1000);
  assert.strictEqual(mine()[1].seated_at.getTime(), t - 900 * 1000);
  // c -> f at table 3 with no closed seating to clear: nothing to do.
  await push('1:2:s:1230;2:3:w:930;3:0:f:5;4:0:f:40');
  assert.strictEqual(mine().length, 2);
});

test('a table removed on the box, and every table of a unit whose rows go silent, close their open seatings at that moment', async () => {
  reset();
  await push('1:2:s:100;2:4:s:100');
  const t = await push('2:4:s:130');
  assert.deepStrictEqual(mine().map(shape), ['1:2:-:closed:-', '2:4:-:open:-']);
  assert.strictEqual(mine()[0].left_at.getTime(), t, 'closed when the reading without it arrived');

  // Ten minutes of silence about tables: the rows go, and so does the seating.
  for (const r of tableStates) r.updated_at = new Date(Date.now() - 11 * MIN);
  ageDevice();
  const res = await call('/api/sensors/data', { apiKey: KEY, body: reading() });
  assert.strictEqual(res.status, 201);
  await settle();
  assert.deepStrictEqual(tableStates.filter((r) => r.sensor_device_id === 'flux_history_01'), []);
  assert.deepStrictEqual(mine().map(shape), ['1:2:-:closed:-', '2:4:-:closed:-']);
  assert.strictEqual(mine()[1].left_at.getTime(), new Date(res.body.recorded_at).getTime());
});

test('an older reading arriving after a newer one writes no history, and a backfill none either', async () => {
  reset();
  await push('1:2:s:100');
  const before = JSON.stringify(seatings);
  ageDevice();
  assert.strictEqual((await call('/api/sensors/data', { apiKey: KEY, body: reading({ recorded_at: ago(4 * MIN), tables: '1:0:c:5' }) })).status, 201);
  await settle();
  assert.strictEqual(JSON.stringify(seatings), before, 'a late reading closed a newer seating');
  assert.strictEqual((await call('/api/sensors/data', { apiKey: KEY, body: reading({ recorded_at: ago(30 * MIN), tables: '7:2:s:100' }) })).status, 201);
  await settle();
  assert.strictEqual(JSON.stringify(seatings), before, 'history opened from a backfilled reading');
});

test('a history write that fails is rolled back to its savepoint and logged, and the floor still commits', async () => {
  reset();
  queryOverride = (flat) => (TABLE_SEATINGS_STATEMENT.test(flat) ? Promise.reject(new Error('seatings on fire')) : null);
  const lines = [];
  const realError = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  let res;
  try {
    ageDevice();
    res = await call('/api/sensors/data', { apiKey: KEY, body: reading({ tables: '1:2:s:100' }) });
    await settle();
  } finally {
    console.error = realError;
  }
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['recorded_at', 'success']);
  assert.deepStrictEqual(tableStates.map((r) => `${r.table_no}:${r.state}`), ['1:s'], 'the floor was lost with the history');
  const seq = queryLog.map((q) => q.sql).filter((s) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT history|ROLLBACK TO SAVEPOINT history)$/.test(s));
  assert.deepStrictEqual(seq, ['BEGIN', 'SAVEPOINT history', 'ROLLBACK TO SAVEPOINT history', 'COMMIT']);
  assert.ok(lines.some((l) => /Table history for flux_history_01 failed after the reading was stored; the floor was kept: seatings on fire/.test(l)), lines.join('\n'));
});

// --- likely_free_at and seats on the floor ----------------------------------

const FLOOR = `/api/sensors/${VENUE}/tables`;

test('likely_free_at is seated_at plus the median turn for that weekday and hour in the venue\'s zone, once twenty closed seatings exist there; the largest party seen is told apart from the seats', async () => {
  reset();
  const t = await push('2:2:s:600;5:0:f:30');
  const since = t - 600 * 1000;
  // Nineteen in the cell: not enough to say anything.
  seedCell(since, VENUE, ZONE, { count: 19, tableNo: 2 });
  let res = await get(FLOOR, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(Object.keys(res.body.tables[0]).sort(), ['likely_free_at', 'number', 'party_max', 'people', 'seats', 'since', 'state']);
  assert.strictEqual(res.body.tables[0].likely_free_at, null, 'nineteen seatings are not a median');
  assert.strictEqual(res.body.tables[1].likely_free_at, null, 'a free table has nothing to free');

  seatings = [];
  seedCell(since, VENUE, ZONE, { count: 21, tableNo: 2 });
  res = await get(FLOOR, OWNER_ID);
  assert.strictEqual(res.body.tables[0].likely_free_at, new Date(since + 50 * MIN).toISOString(), 'seated_at plus the cell median of 50');
  assert.deepStrictEqual([res.body.tables[0].seats, res.body.tables[0].party_max], [null, 2], 'no count from the unit; the party sitting there is the largest seen at the table');
  assert.deepStrictEqual([res.body.tables[1].seats, res.body.tables[1].party_max], [null, null], 'nobody has sat at table 5');
  assert.strictEqual(res.body.next_free, 2);
  // The medians were asked for in the venue's zone, over 28 days.
  const medians = queryLog.filter((q) => MEDIANS_READ.test(q.sql));
  assert.ok(medians.length >= 1);
  assert.deepStrictEqual(medians[medians.length - 1].params, [[VENUE], [ZONE], 28]);
});

test('with too few seatings in the hour the venue\'s overall median stands in; with too few overall there is no likely_free_at at all', async () => {
  reset();
  const t = await push('2:2:s:600');
  const since = t - 600 * 1000;
  // Three in this cell, and twenty-two spread over other hours with turns of
  // 70 to 90: the overall median is 80 and the cell's three do not count.
  seedCell(since, VENUE, ZONE, { count: 3, tableNo: 2 });
  for (let i = 0; i < 22; i += 1) seed(VENUE, 3, since - (2 + i) * DAY - 5 * HOUR, 70 + i);
  let res = await get(FLOOR, OWNER_ID);
  // Twenty-five turns in all: 40, 50, 60 and 70 to 91. The middle one is 79.
  assert.strictEqual(res.body.tables[0].likely_free_at, new Date(since + 79 * MIN).toISOString(), 'the overall median stands in');

  seatings = seatings.slice(0, 3 + 16); // nineteen closed in all
  res = await get(FLOOR, OWNER_ID);
  assert.strictEqual(res.body.tables[0].likely_free_at, null);
});

test('the largest party seen counts only the last 30 days and only parties of somebody, and sits beside the unit\'s own count rather than under it', async () => {
  reset();
  await push('1:0:f:30;2:0:f:30:4;3:0:f:30');
  const now = Date.now();
  seed(VENUE, 1, now - 31 * DAY, 60, { party: 8 });
  seed(VENUE, 1, now - 2 * DAY, 60, { party: 3 });
  seed(VENUE, 2, now - 2 * DAY, 60, { party: 6 });
  seed(VENUE, 3, now - 2 * DAY, 60, { party: 0 });
  const res = await get(FLOOR, OWNER_ID);
  assert.deepStrictEqual(res.body.tables.map((t) => [t.number, t.seats, t.party_max]), [[1, null, 3], [2, 4, 6], [3, null, null]],
    'table 2 seats four by the unit and has sat six; nothing is folded into one number');
  const floor = queryLog.find((q) => FLOOR_READ.test(q.sql));
  assert.deepStrictEqual(floor.params, [[VENUE], 3, 30], 'the place, the stale window and the seats window');
});

// --- GET /tables/stats -----------------------------------------------------------

const STATS = `/api/sensors/${VENUE}/tables/stats`;

test('stats: the turn median by weekday and hour on the venue\'s clock, the waited share, the clear median, the full hours, and the twenty-seating floor on each', async () => {
  reset();
  const now = Date.now();
  // Twenty-one seatings over three weeks in one cell (turns 40..60, median 50),
  // seven of them waited, twenty cleared in 4..23 minutes (median 13.5), one
  // never seen cleared.
  const at = now - 3 * DAY;
  const weeks = sameCellEarlier(at, ZONE, 3);
  for (let i = 0; i < 21; i += 1) {
    const base = weeks[i % 3] + (i % 7) * 5 * MIN - civilTime(weeks[i % 3], ZONE).minute * MIN;
    seed(VENUE, 1 + (i % 4), base, 40 + i, { waited: i % 3 === 0, clearMin: i === 20 ? null : 4 + i });
  }
  // Readings: an hour with every table in use in 8 of 10 readings, and one
  // with 3 of 10, both inside the window; one full hour outside it. Each set
  // starts five minutes into its hour, so it cannot straddle the next.
  const full = Math.floor((now - 2 * DAY) / HOUR) * HOUR + 5 * MIN;
  for (let i = 0; i < 10; i += 1) {
    readings.push({ venue_place_id: VENUE, sensor_device_id: 'flux_history_01', recorded_at: new Date(full + i * MIN), tables_total: 4, tables_occupied: i < 8 ? 4 : 3 });
    readings.push({ venue_place_id: VENUE, sensor_device_id: 'flux_history_01', recorded_at: new Date(full - 5 * HOUR + i * MIN), tables_total: 4, tables_occupied: i < 3 ? 4 : 2 });
    readings.push({ venue_place_id: VENUE, sensor_device_id: 'flux_history_01', recorded_at: new Date(now - 40 * DAY + i * MIN), tables_total: 4, tables_occupied: 4 });
  }
  const res = await get(STATS, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['clear_minutes_median', 'days', 'full_hours', 'seatings', 'timeZone', 'turn_minutes', 'waited_share']);
  assert.strictEqual(res.body.days, 28);
  assert.strictEqual(res.body.seatings, 21);
  assert.strictEqual(res.body.timeZone, ZONE);
  const cell = clockInZone(at, ZONE);
  assert.deepStrictEqual(res.body.turn_minutes, {
    median: 50,
    by_hour: [{ dow: cell.day, hour: cell.hour, median: 50, seatings: 21 }],
  });
  assert.strictEqual(res.body.waited_share, 0.333, 'seven of twenty-one waited');
  assert.strictEqual(res.body.clear_minutes_median, 13.5, 'the median of the twenty clears seen');
  const fullCell = clockInZone(full, ZONE);
  assert.deepStrictEqual(res.body.full_hours, [{ dow: fullCell.day, hour: fullCell.hour, share: 0.8 }], 'only the hour full in at least half its readings, inside the window');
  for (const q of queryLog.filter((q) => MEDIANS_READ.test(q.sql) || FULL_HOURS_READ.test(q.sql))) {
    assert.deepStrictEqual(q.params, [[VENUE], [ZONE], 28], 'both reads fold on the venue\'s zone over the window asked for');
  }

  // Twenty closed with nineteen clears seen: the clear median goes, the rest stay.
  seatings.pop();
  seatings[0].cleared_at = null;
  const fewer = await get(STATS, OWNER_ID);
  assert.strictEqual(fewer.body.seatings, 20);
  assert.strictEqual(fewer.body.clear_minutes_median, null, 'nineteen clears are not a median');
  assert.strictEqual(fewer.body.turn_minutes.median, 49.5, 'twenty turns of 40 to 59');
  assert.strictEqual(fewer.body.waited_share, 0.35);
  // Nineteen closed: nothing is said at all.
  seatings.pop();
  const few = await get(STATS, OWNER_ID);
  assert.strictEqual(few.body.seatings, 19);
  assert.deepStrictEqual([few.body.turn_minutes.median, few.body.waited_share, few.body.clear_minutes_median], [null, null, null]);
  assert.strictEqual(few.body.turn_minutes.by_hour[0].median, null, 'the cell lists its seatings and says no median');
  assert.strictEqual(few.body.turn_minutes.by_hour[0].seatings, 19);
});

test('stats: a venue the server knows no zone for is read in UTC and says so with a null zone; the same seatings land in a different hour', async () => {
  reset();
  const at = Math.floor((Date.now() - 3 * DAY) / HOUR) * HOUR + 5 * MIN;
  for (let i = 0; i < 20; i += 1) seed(VENUE, 1, at + i * MIN, 50);
  const inZone = await get(STATS, OWNER_ID);
  mlVenues = [];
  const inUtc = await get(STATS, OWNER_ID);
  assert.strictEqual(inZone.body.timeZone, ZONE);
  assert.strictEqual(inUtc.body.timeZone, null, 'null means UTC, as on /tables/hours; never the string, which reads as a clock the venue keeps');
  const ny = clockInZone(at, ZONE);
  const utc = clockInZone(at, 'UTC');
  assert.deepStrictEqual([inZone.body.turn_minutes.by_hour[0].dow, inZone.body.turn_minutes.by_hour[0].hour], [ny.day, ny.hour]);
  assert.deepStrictEqual([inUtc.body.turn_minutes.by_hour[0].dow, inUtc.body.turn_minutes.by_hour[0].hour], [utc.day, utc.hour]);
  assert.notStrictEqual(inZone.body.turn_minutes.by_hour[0].hour, inUtc.body.turn_minutes.by_hour[0].hour, 'New York is never on UTC');
  assert.deepStrictEqual(queryLog.filter((q) => MEDIANS_READ.test(q.sql)).map((q) => q.params[1]), [[ZONE], ['UTC']]);
});

test('stats: a zone Postgres refuses is read again in UTC rather than failing the route', async () => {
  reset();
  const at = Math.floor((Date.now() - 3 * DAY) / HOUR) * HOUR + 5 * MIN;
  for (let i = 0; i < 20; i += 1) seed(VENUE, 1, at + i * MIN, 50);
  queryOverride = (flat, params) => {
    if ((MEDIANS_READ.test(flat) || FULL_HOURS_READ.test(flat)) && params[1].some((z) => z !== 'UTC')) {
      const err = new Error('time zone "America/New_York" not recognized');
      err.code = '22023';
      return Promise.reject(err);
    }
    return null;
  };
  const realError = console.error;
  console.error = () => {};
  let res;
  try {
    res = await get(STATS, OWNER_ID);
  } finally {
    console.error = realError;
  }
  assert.strictEqual(res.status, 200, res.raw);
  assert.strictEqual(res.body.timeZone, null, 'the hours are UTC now, and the answer says so the one way');
  assert.strictEqual(res.body.turn_minutes.median, 50);
});

test('after Postgres refuses the venue\'s zone, likely_free_at and the summary\'s wait read the UTC cells with the UTC clock, not with the venue\'s hour', async () => {
  reset();
  const t = await push('2:2:s:600');
  const since = t - 600 * 1000;
  // Twenty-one seatings in the UTC cell the party sat in (median 50), and
  // twenty-one in the UTC cell that carries the party's NEW YORK weekday and
  // hour (median 80): the cell a lookup with the wrong clock lands in.
  seedCell(since, VENUE, 'UTC', { count: 21, tableNo: 2 });
  const ny = civilTime(since, ZONE);
  const decoy = instantForWallClock({ year: ny.year, month: ny.month, day: ny.day, hour: ny.hour, minute: ny.minute }, 'UTC');
  seedCell(decoy, VENUE, 'UTC', { count: 21, tableNo: 7, base: 70 });
  queryOverride = (flat, params) => {
    if ((MEDIANS_READ.test(flat) || FULL_HOURS_READ.test(flat)) && params[1].some((z) => z !== 'UTC')) {
      const err = new Error('time zone "America/New_York" not recognized');
      err.code = '22023';
      return Promise.reject(err);
    }
    return null;
  };
  const realError = console.error;
  console.error = () => {};
  let floor;
  let summary;
  try {
    floor = await get(FLOOR, OWNER_ID);
    summary = await get(`${SUMMARY}?party=2`, USER_ID);
  } finally {
    console.error = realError;
  }
  assert.strictEqual(floor.status, 200, floor.raw);
  assert.strictEqual(floor.body.tables[0].likely_free_at, new Date(since + 50 * MIN).toISOString(), 'the UTC cell the party sat in, not the one at New York\'s hour');
  assert.strictEqual(summary.status, 200, summary.raw);
  assert.strictEqual(summary.body.wait_minutes, 40, 'fifty minutes from a party seated ten minutes ago');
  assert.strictEqual(summary.body.timeZone, null, 'the busy hours are UTC cells too, and the summary says so');
});

test('stats: days is 7 to 90, 28 unless asked, and a corpus with no seatings is zeros and nulls', async () => {
  reset();
  for (const bad of ['6', '91', 'abc', '-1']) {
    const res = await get(`${STATS}?days=${bad}`, OWNER_ID);
    assert.strictEqual(res.status, 400, bad);
    assert.match(res.body.error, /days must be 7-90/);
  }
  const res = await get(`${STATS}?days=90`, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(res.body, {
    days: 90,
    seatings: 0,
    turn_minutes: { median: null, by_hour: [] },
    waited_share: null,
    clear_minutes_median: null,
    full_hours: [],
    timeZone: ZONE,
  });
  assert.deepStrictEqual(queryLog.filter((q) => MEDIANS_READ.test(q.sql))[0].params[2], 90);
});

// --- GET /tables/waits -----------------------------------------------------------

const WAITS = `/api/sensors/${VENUE}/tables/waits`;

test('waits: a free table known to fit is open now with its number; a free table nobody has counted fits four and might fit more, so above four nothing is claimed; otherwise the soonest likely-free fitting table and its minutes; no fit or no history is null', async () => {
  reset();
  // Table 1: free, 2 seats. Table 3: free, seats unknown. Table 2: seated,
  // party of 2 (seats unknown, so the party seen). Table 4: seated 20 minutes,
  // 6 seats. Table 5: needs clearing, 8 seats, counts as neither.
  const t = await push('1:0:f:60:2;2:2:s:600;3:0:f:30;4:4:s:1200:6;5:0:c:30:8');
  let res = await get(WAITS, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['by_party', 'stale', 'updated_at']);
  assert.strictEqual(res.body.updated_at, new Date(t).toISOString());
  assert.strictEqual(res.body.stale, false);
  assert.deepStrictEqual(res.body.by_party, [
    { party: 2, open_now: true, minutes: 0, table: 1 },
    { party: 4, open_now: true, minutes: 0, table: 3 },
    { party: 6, open_now: null, minutes: null, table: 3 },
    { party: 8, open_now: null, minutes: null, table: 3 },
  ], 'table 3 might seat six or eight: nobody has counted it or sat that many there, so neither a fit nor a wait is claimed');

  // Twenty-one closed seatings in table 4's cell: median 50, so table 4 is
  // likely free 30 minutes from the reading. Nothing is said for six while
  // table 3 might seat them now.
  seedCell(t - 1200 * 1000, VENUE, ZONE, { count: 21, tableNo: 4 });
  res = await get(WAITS, OWNER_ID);
  assert.deepStrictEqual(res.body.by_party[2], { party: 6, open_now: null, minutes: null, table: 3 });

  // Table 3 counted at four: six and eight are known not to fit it, so the
  // wait for six is table 4's and nothing seats eight.
  await push('1:0:f:90:2;2:2:s:630;3:0:f:60:4;4:4:s:1230:6;5:0:c:60:8');
  res = await get(WAITS, OWNER_ID);
  assert.deepStrictEqual(res.body.by_party[1], { party: 4, open_now: true, minutes: 0, table: 3 });
  assert.deepStrictEqual(res.body.by_party[2], { party: 6, open_now: false, minutes: 30, table: 4 });
  assert.deepStrictEqual(res.body.by_party[3], { party: 8, open_now: false, minutes: null, table: null }, 'nothing seats eight');

  // Table 4's party has outstayed the median: 0 minutes, not a negative.
  for (const r of tableStates) if (r.table_no === 4) r.state_since = new Date(Date.now() - 90 * MIN);
  seatings = [];
  seedCell(Date.now() - 90 * MIN, VENUE, ZONE, { count: 21, tableNo: 4 });
  res = await get(WAITS, OWNER_ID);
  assert.deepStrictEqual(res.body.by_party[2], { party: 6, open_now: false, minutes: 0, table: 4 });
});

test('waits with no floor: no time, stale, and every party null', async () => {
  reset();
  const res = await get(WAITS, OWNER_ID);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, {
    updated_at: null,
    stale: true,
    by_party: [2, 4, 6, 8].map((party) => ({ party, open_now: false, minutes: null, table: null })),
  });
});

// --- GET /tables/incoming --------------------------------------------------------

const INCOMING = `/api/sensors/${VENUE}/tables/incoming`;

test('incoming: the dashboard feed\'s plans with a party size and the table that fits, free now or likely free before the plan; no name reaches the owner', async () => {
  reset();
  const now = Date.now();
  const t = await push('1:0:f:60:2;2:2:s:600;3:0:f:30;4:4:s:1200:6');
  seedCell(t - 1200 * 1000, VENUE, ZONE, { count: 21, tableNo: 4 }); // table 4 free in ~30 min
  flocks = [
    { id: 501, venue_id: VENUE, name: "Emma's 21st", event_time: new Date(now + 2 * HOUR), status: 'confirmed', member_count: 4 },
    { id: 502, venue_id: VENUE, name: 'Sarah leaving do', event_time: new Date(now + 10 * MIN), status: 'planning', member_count: 6 },
    { id: 503, venue_id: VENUE, name: 'Dan + Priya', event_time: new Date(now + HOUR), status: 'confirmed', member_count: 6 },
    { id: 504, venue_id: VENUE, name: 'Big one', event_time: new Date(now + HOUR), status: 'confirmed', member_count: 8 },
    { id: 505, venue_id: VENUE, name: 'Nobody yet', event_time: new Date(now + 3 * HOUR), status: 'planning', member_count: 0 },
    { id: 506, venue_id: OTHER, name: 'Elsewhere', event_time: new Date(now + HOUR), status: 'confirmed', member_count: 2 },
    { id: 507, venue_id: VENUE, name: 'Last month', event_time: new Date(now - 30 * DAY), status: 'confirmed', member_count: 2 },
  ];
  const res = await get(INCOMING, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(Object.keys(res.body), ['flocks']);
  for (const f of res.body.flocks) {
    assert.deepStrictEqual(Object.keys(f).sort(), ['event_time', 'id', 'party', 'status', 'suggestion']);
  }
  assert.deepStrictEqual(res.body.flocks.map((f) => [f.id, f.party, f.status]), [
    [502, 6, 'planning'], [503, 6, 'confirmed'], [504, 8, 'confirmed'], [501, 4, 'confirmed'], [505, 0, 'planning'],
  ], 'the feed\'s own order and window: soonest first, this place only');
  const byId = Object.fromEntries(res.body.flocks.map((f) => [f.id, f.suggestion]));
  assert.deepStrictEqual(byId[502], null, 'in ten minutes nothing seats six: table 4 frees in thirty');
  assert.deepStrictEqual(byId[503], { table: 4, free_now: false, likely_free_at: new Date(t - 1200 * 1000 + 50 * MIN).toISOString() });
  assert.deepStrictEqual(byId[504], null, 'nothing seats eight');
  assert.deepStrictEqual(byId[501], { table: 3, free_now: true, likely_free_at: null }, 'unknown seats fit four; table 1 seats two');
  assert.deepStrictEqual(byId[505], { table: 1, free_now: true, likely_free_at: null }, 'a group of unknown size takes the first free table');
  for (const typed of ['Emma', 'Sarah', 'Priya', 'Big one', 'Nobody', 'Elsewhere', 'name', 'title']) {
    assert.ok(!res.raw.includes(typed), `"${typed}" reached the owner`);
  }
  const feed = queryLog.find((q) => INCOMING_READ.test(q.sql));
  assert.ok(feed, 'the feed statement ran');
  assert.deepStrictEqual(feed.params, [VENUE]);
  assert.doesNotMatch(feed.sql, /f\.name/, 'the column is not selected at all');
  // The very statement the dashboard feed sends, from the one module.
  assert.strictEqual(feed.sql, require('../services/incomingFlocks').INCOMING_FLOCKS_SQL.replace(/\s+/g, ' ').trim());
});

// --- The gates on the new owner routes -------------------------------------------

test('stats, waits and incoming are for the verified owner on Roost: 401 signed out, 403 for a stranger with nothing read, the plan refusal with has_tables below Roost', async () => {
  reset();
  await push('1:2:s:100');
  for (const p of [STATS, WAITS, INCOMING]) {
    assert.strictEqual((await get(p)).status, 401, p);
    queryLog = [];
    const stranger = await get(p, STRANGER_ID);
    assert.strictEqual(stranger.status, 403, p);
    assert.deepStrictEqual(stranger.body, { error: 'Table monitoring is for the verified owner of this venue.' });
    assert.ok(!queryLog.some((q) => /sensor_table_seatings|sensor_table_states s|venue_sensor_data|FROM flocks/.test(q.sql)), `${p}: read behind a refused gate`);
    assert.strictEqual((await get(`/api/sensors/${'x'.repeat(256)}${p.slice(p.indexOf('/tables'))}`, OWNER_ID)).status, 400, p);
  }
  process.env.VENUE_BILLING_ENABLED = 'true';
  if (!process.env.ADMIN_USER_IDS) process.env.ADMIN_USER_IDS = '1';
  try {
    for (const p of [STATS, WAITS, INCOMING]) {
      queryLog = [];
      const res = await get(p, OWNER_ID);
      assert.strictEqual(res.status, 403, p);
      assert.deepStrictEqual(res.body, { error: 'This feature needs a venue plan upgrade.', code: 'UPGRADE_REQUIRED', requiredTier: 'pro', has_tables: true });
      assert.ok(!queryLog.some((q) => /sensor_table_seatings|FROM flocks/.test(q.sql)), `${p}: history read below Roost`);
    }
    venueTiers.set(OWNER_ID, 'pro');
    for (const p of [STATS, WAITS, INCOMING]) assert.strictEqual((await get(p, OWNER_ID)).status, 200, p);
  } finally {
    delete process.env.VENUE_BILLING_ENABLED;
  }
});

test('a failing history read is a 500 with nothing in it but the error', async () => {
  reset();
  await push('1:2:s:100');
  queryOverride = (flat) => (MEDIANS_READ.test(flat) ? Promise.reject(new Error('connection terminated')) : null);
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    for (const [p, note] of [[FLOOR, 'Get table floor error'], [STATS, 'Get table stats error'], [WAITS, 'Get table waits error'], [INCOMING, 'Get table incoming error']]) {
      const res = await get(p, OWNER_ID);
      assert.strictEqual(res.status, 500, p);
      assert.deepStrictEqual(Object.keys(res.body), ['error']);
      assert.ok(logged.some((l) => l.includes(note)), `${p}: ${logged.join('\n')}`);
    }
  } finally {
    console.error = realError;
  }
});

// --- The owner's switches -----------------------------------------------------------

const SETTINGS = `/api/sensors/${VENUE}/tables/settings`;
const put = (pathname, body, user) => call(pathname, { method: 'PUT', body, user });

test('settings: both switches read true until the owner changes one; a PUT changes only what it names, and merges the alerts key into the other prefs', async () => {
  reset();
  let res = await get(SETTINGS, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(res.body, { show_in_app: true, alerts: true });

  res = await put(SETTINGS, { show_in_app: false }, OWNER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(res.body, { show_in_app: false, alerts: true });
  assert.strictEqual(venueProfiles[0].tables_in_app, false);
  assert.deepStrictEqual(venueProfiles[0].notification_prefs, { bookings: true }, 'the prefs were not touched');

  res = await put(SETTINGS, { alerts: false }, OWNER_ID);
  assert.deepStrictEqual(res.body, { show_in_app: false, alerts: false });
  assert.deepStrictEqual(venueProfiles[0].notification_prefs, { bookings: true, tables: false }, 'merged, not replaced');
  assert.strictEqual(sensorTables.wantsTableAlerts(venueProfiles[0].notification_prefs), false, 'the alert reads the same key');

  res = await put(SETTINGS, { alerts: true, show_in_app: true }, OWNER_ID);
  assert.deepStrictEqual(res.body, { show_in_app: true, alerts: true });
  assert.deepStrictEqual((await get(SETTINGS, OWNER_ID)).body, { show_in_app: true, alerts: true });
  const write = queryLog.find((q) => /^UPDATE venue_profiles SET tables_in_app/.test(q.sql));
  assert.deepStrictEqual(write.params, [OWNER_ID, VENUE, false, null], 'the first PUT bound its switch and left the other null');
});

test('settings: a body naming neither switch, a value that is not a boolean, an array and an object are each a 400 and write nothing', async () => {
  reset();
  // JSON booleans only: a form's "true" and a 1 are refused rather than read
  // as a guess at what the owner meant.
  for (const body of [{}, { show_in_app: 'maybe' }, { alerts: 1 }, { alerts: 'true' }, { show_in_app: [true] }, { alerts: { on: true } }, { show_in_app: null, alerts: null }]) {
    queryLog = [];
    const res = await put(SETTINGS, body, OWNER_ID);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
    assert.ok(!queryLog.some((q) => /UPDATE venue_profiles/.test(q.sql)), `${JSON.stringify(body)} reached the database`);
  }
  assert.strictEqual(venueProfiles[0].tables_in_app, undefined);
});

test('settings: the verified owner only, decided by the statement, and not behind the plan gate', async () => {
  reset();
  assert.strictEqual((await get(SETTINGS)).status, 401);
  assert.strictEqual((await put(SETTINGS, { alerts: false })).status, 401);
  for (const res of [await get(SETTINGS, STRANGER_ID), await put(SETTINGS, { alerts: false }, STRANGER_ID)]) {
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, { error: 'Table monitoring is for the verified owner of this venue.' });
  }
  venueProfiles[0].verified = false;
  assert.strictEqual((await get(SETTINGS, OWNER_ID)).status, 403, 'an unverified claim is not the owner');
  assert.strictEqual((await put(SETTINGS, { alerts: false }, OWNER_ID)).status, 403);
  assert.strictEqual(venueProfiles[0].notification_prefs.tables, undefined, 'the refused PUT wrote');
  venueProfiles[0].verified = true;
  process.env.VENUE_BILLING_ENABLED = 'true';
  if (!process.env.ADMIN_USER_IDS) process.env.ADMIN_USER_IDS = '1';
  try {
    queryLog = [];
    assert.strictEqual((await get(SETTINGS, OWNER_ID)).status, 200, 'a free venue may read its switches');
    assert.strictEqual((await put(SETTINGS, { show_in_app: false }, OWNER_ID)).status, 200, 'and hide its tables from the app');
    assert.ok(!queryLog.some((q) => /venue_subscriptions/.test(q.sql)), 'no plan was read for a switch');
  } finally {
    delete process.env.VENUE_BILLING_ENABLED;
  }
});

// --- The public summary ---------------------------------------------------------

const SUMMARY = `/api/sensors/${VENUE}/tables/summary`;
const SUMMARIES = '/api/sensors/tables/summaries';
const USER_ID = 7;

test('the public summary: counts and minutes for a party, the busy hours and their zone, a fit nobody can judge said as null, and never a table number, a state or a unit id', async () => {
  reset();
  const now = Date.now();
  // Table 3 is free, and nobody has counted it or sat at it.
  const t1 = await push('1:0:f:60:2;2:2:s:600;3:0:f:30;4:4:s:1200:6;5:0:c:30:8');
  seedCell(t1 - 1200 * 1000, VENUE, ZONE, { count: 21, tableNo: 4 });
  const full = Math.floor((now - 2 * DAY) / HOUR) * HOUR + 5 * MIN;
  for (let i = 0; i < 10; i += 1) {
    readings.push({ venue_place_id: VENUE, sensor_device_id: 'flux_history_01', recorded_at: new Date(full + i * MIN), tables_total: 5, tables_occupied: i < 6 ? 5 : 4 });
  }
  let res = await get(`${SUMMARY}?party=6`, USER_ID);
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(Object.keys(res.body).sort(), SUMMARY_KEYS);
  assert.deepStrictEqual([res.body.fits_now, res.body.wait_minutes], [null, null], 'table 3 might seat six: neither a fit nor "none fits" nor a wait is claimed');
  res = await get(`${SUMMARY}?party=4`, USER_ID);
  assert.deepStrictEqual([res.body.fits_now, res.body.wait_minutes], [true, 0], 'a table nobody has counted fits four');

  // Table 3 counted at four: six are known not to fit it, and the wait is
  // table 4's.
  const t = await push('1:0:f:90:2;2:2:s:630;3:0:f:60:4;4:4:s:1230:6;5:0:c:60:8');
  res = await get(`${SUMMARY}?party=6`, USER_ID);
  const fullCell = clockInZone(full, ZONE);
  assert.deepStrictEqual(res.body, {
    open: 2,
    total: 5,
    party: 6,
    fits_now: false,
    wait_minutes: 30,
    busy_hours: [{ dow: fullCell.day, hour: fullCell.hour }],
    timeZone: ZONE,
    updated_at: new Date(t).toISOString(),
    stale: false,
  });
  assert.ok(!/"number"|"table"|flux_history|sensor_device|seated|waiting|needs_clearing|"since"|seats|share/.test(res.raw), res.raw);

  res = await get(SUMMARY, USER_ID);
  assert.deepStrictEqual([res.body.party, res.body.fits_now, res.body.wait_minutes], [2, true, 0], 'a party of two unless asked, and table 1 seats two');
  res = await get(`${SUMMARY}?party=8`, USER_ID);
  assert.deepStrictEqual([res.body.fits_now, res.body.wait_minutes], [false, null], 'nothing seats eight, and no wait can be said');

  // Stale inside the day is served and said; the clock is the floor's.
  for (const r of tableStates) r.updated_at = new Date(now - 4 * MIN);
  res = await get(SUMMARY, USER_ID);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.stale, true);

  for (const bad of ['0', '31', 'four', '2.5']) {
    assert.strictEqual((await get(`${SUMMARY}?party=${bad}`, USER_ID)).status, 400, bad);
  }
  assert.strictEqual((await get(SUMMARY)).status, 401, 'signed in, any user');
});

test('the public summary is a 404 in the same words for a venue with no floor, one whose floor is older than a day, and one whose owner hid its tables', async () => {
  reset();
  const NO_DATA = { error: 'No table data for this venue.' };
  assert.deepStrictEqual(await get(SUMMARY, USER_ID).then((r) => [r.status, r.body]), [404, NO_DATA]);
  await push('1:0:f:60;2:2:s:600');
  assert.strictEqual((await get(SUMMARY, USER_ID)).status, 200);
  for (const r of tableStates) r.updated_at = new Date(Date.now() - 25 * HOUR);
  assert.deepStrictEqual(await get(SUMMARY, USER_ID).then((r) => [r.status, r.body]), [404, NO_DATA], 'a day-old floor is no data');
  for (const r of tableStates) r.updated_at = new Date();
  assert.strictEqual((await put(SETTINGS, { show_in_app: false }, OWNER_ID)).status, 200);
  queryLog = [];
  assert.deepStrictEqual(await get(SUMMARY, USER_ID).then((r) => [r.status, r.body]), [404, NO_DATA], 'the hidden venue reads like one with none');
  assert.ok(!queryLog.some((q) => MEDIANS_READ.test(q.sql) || FULL_HOURS_READ.test(q.sql)), 'nothing more is read about a hidden venue');
  assert.strictEqual((await put(SETTINGS, { show_in_app: true }, OWNER_ID)).status, 200);
  assert.strictEqual((await get(SUMMARY, USER_ID)).status, 200);
  // The owner's own floor is unaffected by the switch either way.
  assert.strictEqual((await put(SETTINGS, { show_in_app: false }, OWNER_ID)).status, 200);
  assert.strictEqual((await get(FLOOR, OWNER_ID)).status, 200);
});

test('the batch: one floor read and one busy-hours read for every id asked, venues without a summary simply absent, and the body held to 1-50 place id strings', async () => {
  reset();
  const t = await push('1:0:f:60:2;2:2:s:600');
  // The other venue has a floor too, but its owner hid it.
  ageDevice('flux_history_02');
  assert.strictEqual((await call('/api/sensors/data', { apiKey: OTHER_KEY, body: reading({ tables: '1:0:f:60' }) })).status, 201);
  await settle();
  venueProfiles.push({ user_id: 61, google_place_id: OTHER, verified: true, notification_prefs: {}, tables_in_app: false });
  queryLog = [];
  let res = await call(SUMMARIES, { body: { place_ids: [VENUE, OTHER, 'ChIJnobodyHere0000001', VENUE], party: 2 }, user: USER_ID });
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(Object.keys(res.body), ['summaries']);
  assert.deepStrictEqual(Object.keys(res.body.summaries), [VENUE]);
  assert.deepStrictEqual(Object.keys(res.body.summaries[VENUE]).sort(), SUMMARY_KEYS);
  assert.deepStrictEqual(res.body.summaries[VENUE], {
    open: 1, total: 2, party: 2, fits_now: true, wait_minutes: 0, busy_hours: [], timeZone: ZONE, updated_at: new Date(t).toISOString(), stale: false,
  });
  assert.strictEqual(queryLog.filter((q) => FLOOR_READ.test(q.sql)).length, 1, 'one floor read for every id');
  assert.strictEqual(queryLog.filter((q) => FULL_HOURS_READ.test(q.sql)).length, 1, 'one busy-hours read for every id');
  assert.strictEqual(queryLog.filter((q) => MEDIANS_READ.test(q.sql)).length, 1);
  assert.deepStrictEqual(queryLog.find((q) => FLOOR_READ.test(q.sql)).params[0], [VENUE, OTHER, 'ChIJnobodyHere0000001'], 'each id once');
  assert.deepStrictEqual(queryLog.find((q) => FULL_HOURS_READ.test(q.sql)).params[0], [VENUE], 'only the venues with a summary are asked about further');
  assert.ok(!/flux_history|"number"|"table"/.test(res.raw));

  res = await call(SUMMARIES, { body: { place_ids: [VENUE] }, user: USER_ID });
  assert.strictEqual(res.body.summaries[VENUE].party, 2, 'a party of two unless asked');

  for (const body of [
    {}, { place_ids: [] }, { place_ids: 'ChIJx' }, { place_ids: [1] }, { place_ids: [''] }, { place_ids: [{ id: VENUE }] },
    { place_ids: Array.from({ length: 51 }, (_, i) => `ChIJbatch${i}`) }, { place_ids: [VENUE], party: 0 },
    { place_ids: [VENUE], party: [2] }, { place_ids: [VENUE], party: 31 },
  ]) {
    queryLog = [];
    const bad = await call(SUMMARIES, { body, user: USER_ID });
    assert.strictEqual(bad.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepStrictEqual(queryLog, [], `${JSON.stringify(body).slice(0, 80)} reached the database`);
  }
  assert.strictEqual((await call(SUMMARIES, { body: { place_ids: [VENUE] } })).status, 401);
  const fifty = await call(SUMMARIES, { body: { place_ids: Array.from({ length: 50 }, (_, i) => `ChIJbatch${i}`) }, user: USER_ID });
  assert.deepStrictEqual([fifty.status, fifty.body], [200, { summaries: {} }]);
});

test('a unit that has gone dark keeps its rows on the owner\'s floor and has no say in what is open: the counts, the fits, the waits and the suggestions come from the live units alone', async () => {
  reset();
  // The front room, live and full.
  const t = await push('1:2:s:600;2:4:s:300');
  // The back room, unplugged at close ten minutes ago with every table free.
  // Nothing ever removes its rows: the silence rule runs only from the unit's
  // own readings, and it sends none.
  const dark = new Date(Date.now() - 10 * MIN);
  for (const n of [11, 12, 13]) {
    tableStates.push({ sensor_device_id: 'flux_history_03', table_no: n, venue_place_id: VENUE, people: 0, state: 'f', state_since: dark, updated_at: dark, seats: null });
  }
  const floor = await get(FLOOR, OWNER_ID);
  assert.deepStrictEqual(floor.body.tables.map((x) => x.number), [1, 2, 11, 12, 13], 'the owner still sees the dark unit\'s tables');
  assert.strictEqual(floor.body.stale, false, 'as fresh as its newest row, as phase 1 settled');

  const summary = await get(`${SUMMARY}?party=2`, USER_ID);
  assert.strictEqual(summary.status, 200, summary.raw);
  const { busy_hours, ...counts } = summary.body;
  assert.ok(Array.isArray(busy_hours));
  assert.deepStrictEqual(counts, {
    open: 0, total: 2, party: 2, fits_now: false, wait_minutes: null, timeZone: ZONE,
    updated_at: new Date(t).toISOString(), stale: false,
  }, 'the back room\'s free tables are not open now');
  const waits = await get(WAITS, OWNER_ID);
  assert.deepStrictEqual(waits.body.by_party.map((p) => [p.party, p.open_now, p.table]), [[2, false, null], [4, false, null], [6, false, null], [8, false, null]]);
  flocks = [{ id: 601, venue_id: VENUE, name: 'Two of us', event_time: new Date(Date.now() + HOUR), status: 'confirmed', member_count: 2 }];
  const incoming = await get(INCOMING, OWNER_ID);
  assert.strictEqual(incoming.body.flocks[0].suggestion, null, 'no phantom table is suggested');

  // Every unit dark: the floor is stale, and nothing is known to be open.
  for (const r of tableStates) r.updated_at = new Date(Date.now() - 4 * MIN);
  const stale = await get(`${SUMMARY}?party=2`, USER_ID);
  assert.deepStrictEqual([stale.body.open, stale.body.total, stale.body.fits_now, stale.body.stale], [0, 0, false, true]);
});

test('the seats fallback never crosses venues: a unit\'s seatings at its old venue are not the seats of its tables at the new one, in the batch or alone, and a venue outside the corpus says its hours are UTC', async () => {
  reset();
  // The second unit is at OTHER now, table 3 free and uncounted; its
  // seatings at VENUE, where it used to be, sat a party of eight at table 3.
  ageDevice('flux_history_02');
  assert.strictEqual((await call('/api/sensors/data', { apiKey: OTHER_KEY, body: reading({ tables: '3:0:f:30' }) })).status, 201);
  await settle();
  seed(VENUE, 3, Date.now() - 2 * DAY, 60, { party: 8, device: 'flux_history_02' });
  await push('1:0:f:30');
  const batch = await call(SUMMARIES, { body: { place_ids: [VENUE, OTHER], party: 8 }, user: USER_ID });
  assert.strictEqual(batch.status, 200, batch.raw);
  assert.deepStrictEqual(Object.keys(batch.body.summaries).sort(), [VENUE, OTHER].sort());
  assert.strictEqual(batch.body.summaries[OTHER].fits_now, null, 'eight seated at VENUE say nothing about OTHER\'s table 3');
  assert.strictEqual(batch.body.summaries[VENUE].fits_now, null, 'nor about VENUE\'s table 1, which is another unit\'s');
  const alone = await get(`/api/sensors/${OTHER}/tables/summary?party=8`, USER_ID);
  assert.strictEqual(alone.status, 200, alone.raw);
  assert.strictEqual(alone.body.fits_now, batch.body.summaries[OTHER].fits_now, 'the batch and the single read agree');
  assert.strictEqual(batch.body.summaries[OTHER].timeZone, null, 'OTHER is outside the corpus: its busy hours are UTC');
  assert.strictEqual(batch.body.summaries[VENUE].timeZone, ZONE);
});

test('the public summary routes have a limiter of their own in server.js, mounted ahead of the sensors router, 120 a minute', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const decl = /const tablesPublicLimiter = isDev \? \(_req, _res, next\) => next\(\) : rateLimit\(\{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(decl, 'tablesPublicLimiter is gone from server.js');
  assert.match(decl[1], /windowMs: 60 \* 1000,/);
  assert.match(decl[1], /max: 120,/);
  assert.match(decl[1], /keyGenerator: billedAccountKey,/, 'an authenticated route keys on the account');
  const batch = src.indexOf("app.use('/api/sensors/tables/summaries', tablesPublicLimiter);");
  const one = src.indexOf("app.use('/api/sensors/:placeId/tables/summary', tablesPublicLimiter);");
  const router = src.indexOf("app.use('/api/sensors', apiLimiter, sensorRoutes);");
  assert.ok(batch > 0 && one > 0 && router > 0, 'the three mounts are in server.js');
  assert.ok(batch < router && one < router, 'the limiter is mounted ahead of the sensors router, so it is charged first');
  const { LIMITERS } = require('../utils/cacheKeyInventory');
  const row = LIMITERS.find((l) => l.name === 'tablesPublicLimiter');
  assert.ok(row, 'the limiter has its inventory row');
  assert.deepStrictEqual(row.mounts.slice().sort(), ['/api/sensors/:placeId/tables/summary', '/api/sensors/tables/summaries']);
});

// --- The arithmetic, on its own -------------------------------------------------------

test('fits: unknown seats take up to four and say nothing above; known seats take their own number; only live rows count', () => {
  assert.strictEqual(tableHistory.UNKNOWN_SEATS_FIT_UP_TO, 4);
  assert.deepStrictEqual([1, 2, 4, 5, 8].map((p) => tableHistory.fits(null, p)), [true, true, true, null, null]);
  assert.deepStrictEqual([1, 2, 4, 5].map((p) => tableHistory.fits(4, p)), [true, true, true, false]);
  assert.deepStrictEqual([{ seats: 6 }, { seats: null, party_max_seen: 3 }, { seats: null, party_max_seen: null }, { seats: 2, party_max_seen: 5 }]
    .map(tableHistory.seatsOf), [6, 3, null, 2]);
  assert.deepStrictEqual(tableHistory.liveRows([{ table_no: 1, stale: false }, { table_no: 2, stale: true }, { table_no: 3 }]).map((r) => r.table_no), [1, 3]);
});

test('the twenty-seating floor and the cell-then-overall fallback, on the medians themselves', () => {
  assert.strictEqual(tableHistory.MIN_SEATINGS_FOR_MEDIAN, 20);
  const venue = {
    overall: { seatings: 25, median: 61, waited_share: 0.2, cleared: 25, clear_median: 9 },
    cells: new Map([['5:19', { dow: 5, hour: 19, seatings: 20, median: 45 }], ['5:21', { dow: 5, hour: 21, seatings: 19, median: 30 }]]),
  };
  assert.strictEqual(tableHistory.medianFor(venue, 5, 19), 45, 'the cell has enough');
  assert.strictEqual(tableHistory.medianFor(venue, 5, 21), 61, 'nineteen in the cell: the venue stands in');
  assert.strictEqual(tableHistory.medianFor(venue, 2, 12), 61, 'an empty cell: the venue stands in');
  venue.overall.seatings = 19;
  assert.strictEqual(tableHistory.medianFor(venue, 5, 21), null);
  assert.strictEqual(tableHistory.medianFor(venue, 5, 19), 45);
  assert.strictEqual(tableHistory.medianFor(null, 5, 19), null);
  const since = Date.UTC(2026, 9, 23, 23, 30); // Fri 19:30 in New York, Fri 23:30 UTC
  assert.strictEqual(tableHistory.likelyFreeAt(since, ZONE, venue).getTime(), since + 45 * MIN, 'the New York cell, Friday at 19');
  const utcVenue = { ...venue, cells: new Map([['5:23', { dow: 5, hour: 23, seatings: 20, median: 33 }]]) };
  assert.strictEqual(tableHistory.likelyFreeAt(since, null, utcVenue).getTime(), since + 33 * MIN, 'with no zone the UTC cell, Friday at 23');
  assert.strictEqual(tableHistory.likelyFreeAt('not a time', ZONE, venue), null);
});
