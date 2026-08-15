// Run: node --test  (from backend/)
//
// Integrity sweep of the sensor ingestion path (routes/sensors.js), companion
// to sensorIngest.test.js. That file pins the ingest contract broadly; this one
// pins the specific ways a spoofed or compromised device could fabricate crowd
// data that reaches the venue dashboard or the ML corpus:
//
//   * auth: a caller with no secret, a guessed secret, or the STORED digest
//     lifted from a database dump never writes a row;
//   * bounds: counts, loudness and timestamps outside physical reality are a
//     400 and nothing is stored;
//   * rate: forged live-window rows (the 61-seconds-old trick) are throttled;
//   * dry_run: every spelling isBoolean() admits as truthy is honoured, so an
//     installer self test can never write a fabricated zero-occupancy row;
//   * privacy: no user identity ever enters a sensor row, the broadcast, or
//     the ingest response — the only user reference in the file is the
//     aggregate COUNT over venue_checkins on the read side.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const crypto = require('node:crypto');

process.env.JWT_SECRET = 'sensor-integrity-test-secret';

const pool = require('../config/database');

// --- Fake database (same model as sensorIngest.test.js: stateful, so the
// flood guard and dedupe are actually enforced, not scripted) ---------------

let devices = [];
let readings = [];
let queryLog = [];

function intervalToMs(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(millisecond|second|minute|hour)s?$/.exec(String(text).trim());
  if (!m) throw new Error(`fake db cannot parse interval ${text}`);
  return Number(m[1]) * { millisecond: 1, second: 1000, minute: 60000, hour: 3600000 }[m[2]];
}

pool.query = (sql, params = []) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params });

  if (/SELECT id, device_id, venue_place_id, is_active FROM sensor_devices/.test(flat)) {
    const row = devices.find((d) => d.api_key === params[0] || d.api_key === params[1]);
    return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
  }
  if (/^UPDATE sensor_devices SET last_seen_at = NOW\(\) WHERE id = \$1$/.test(flat)) {
    const device = devices.find((d) => d.id === params[0]);
    if (device) device.last_seen_at = Date.now();
    return Promise.resolve({ rows: [], rowCount: device ? 1 : 0 });
  }
  if (/UPDATE sensor_devices SET last_seen_at/.test(flat)) {
    const device = devices.find((d) => d.id === params[0]);
    const gapMs = intervalToMs(params[1]);
    if (!device) return Promise.resolve({ rows: [], rowCount: 0 });
    if (device.last_seen_at !== null && Date.now() - device.last_seen_at < gapMs) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    device.last_seen_at = Date.now();
    return Promise.resolve({ rows: [{ id: device.id }], rowCount: 1 });
  }
  if (/SELECT recorded_at FROM venue_sensor_data/.test(flat)) {
    const [deviceId, at] = params;
    const hit = readings.find(
      (r) => r.sensor_device_id === deviceId && r.recorded_at.getTime() === at.getTime()
    );
    return Promise.resolve({ rows: hit ? [{ recorded_at: hit.recorded_at }] : [], rowCount: hit ? 1 : 0 });
  }
  if (/INSERT INTO venue_sensor_data/.test(flat)) {
    const row = {
      venue_place_id: params[0],
      ir_beam_count: params[1],
      thermal_headcount: params[2],
      noise_db: params[3],
      sensor_device_id: params[4],
      recorded_at: params[5] || new Date(),
    };
    readings.push(row);
    return Promise.resolve({ rows: [{ recorded_at: row.recorded_at }], rowCount: 1 });
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
};

pool.connect = async () => {
  throw new Error('routes/sensors.js must not check a client out of the pool');
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => {
  req.user = { id: 1, name: 'Ava', role: 'user' };
  next();
};

const sensorRouter = require('../routes/sensors');

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

function call(pathname, { apiKey, body, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (apiKey !== undefined) headers['x-api-key'] = apiKey;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
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

// --- Fixtures --------------------------------------------------------------

const DEVICE_KEY = 'f'.repeat(64); // the plaintext material flashed onto the Pi
const VENUE = 'ChIJintegrityVenue001';

const digestOf = (key) =>
  'sha256:' + crypto.createHash('sha256').update(key, 'utf8').digest('hex');

function reset() {
  queryLog = [];
  readings = [];
  emits = [];
  devices = [
    { id: 1, device_id: 'sensor_int_001', venue_place_id: VENUE, is_active: true,
      api_key: digestOf(DEVICE_KEY), last_seen_at: null },
  ];
}

const reading = (extra = {}) => ({
  ir_beam_count: 8, thermal_headcount: 14, noise_db: 68.5, ...extra,
});

function ageDevice(ms = 60000) {
  devices[0].last_seen_at = Date.now() - ms;
}

// --- Device authentication -------------------------------------------------

test('a caller with no secret or a guessed secret writes nothing: 401 both ways', async () => {
  reset();
  const bare = await call('/api/sensors/data', { body: reading() });
  assert.strictEqual(bare.status, 401);
  const guess = await call('/api/sensors/data', { apiKey: 'a'.repeat(64), body: reading() });
  assert.strictEqual(guess.status, 401);
  assert.strictEqual(readings.length, 0);
});

test('the STORED digest replayed from a database dump does not authenticate: a presented sha256:... value is only ever re-hashed, never compared literally', async () => {
  reset();
  const stolenFromDump = devices[0].api_key; // sha256:<hex>, exactly as stored
  const res = await call('/api/sensors/data', { apiKey: stolenFromDump, body: reading() });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(readings.length, 0);

  // Pin the mechanism, not just the outcome: the literal digest string must
  // never appear as a lookup parameter, or the dump-replay door is back open.
  const lookup = queryLog.find((q) => /FROM sensor_devices/.test(q.sql));
  assert.ok(lookup, 'no device lookup ran');
  for (const p of lookup.params) {
    assert.notStrictEqual(p, stolenFromDump, 'stored digest was compared literally');
  }
});

test('auth costs the same for a bad key as a good one: exactly one device lookup, same statement shape, both candidates parameterized', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: DEVICE_KEY, body: reading() });
  const goodLookups = queryLog.filter((q) => /FROM sensor_devices WHERE api_key/.test(q.sql));

  queryLog = [];
  await call('/api/sensors/data', { apiKey: 'wrong-key-entirely', body: reading() });
  const badLookups = queryLog.filter((q) => /FROM sensor_devices WHERE api_key/.test(q.sql));

  assert.strictEqual(goodLookups.length, 1);
  assert.strictEqual(badLookups.length, 1);
  assert.strictEqual(goodLookups[0].sql, badLookups[0].sql);
  // Parameterized only: the presented key never appears inside the SQL text.
  assert.ok(!badLookups[0].sql.includes('wrong-key-entirely'));
});

// --- Bounds: a fabricated spike is refused, not stored ---------------------

test('counts outside physical reality are a 400 and nothing is stored', async () => {
  reset();
  const cases = [
    reading({ ir_beam_count: -1 }),
    reading({ ir_beam_count: 3.7 }),
    reading({ ir_beam_count: 10001 }),
    reading({ ir_beam_count: 1e9 }),
    reading({ thermal_headcount: -5 }),
    reading({ thermal_headcount: 1001 }),
    reading({ noise_db: -0.1 }),
    reading({ noise_db: 140.5 }),
    reading({ noise_db: 1e9 }),
    reading({ noise_db: '1e9' }),
    reading({ noise_db: 'NaN' }),
  ];
  for (const body of cases) {
    ageDevice();
    const res = await call('/api/sensors/data', { apiKey: DEVICE_KEY, body });
    assert.strictEqual(res.status, 400, `accepted ${JSON.stringify(body)}`);
  }
  assert.strictEqual(readings.length, 0);
});

test('the exact ceilings are still inside the fence: 10000 crossings, 1000 heads, 140 dB is a legal reading', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY,
    body: { ir_beam_count: 10000, thermal_headcount: 1000, noise_db: 140 },
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(readings.length, 1);
});

test('a future timestamp beyond clock skew is refused; one inside the skew window is not', async () => {
  reset();
  const forged = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY,
    body: reading({ recorded_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
  });
  assert.strictEqual(forged.status, 400);
  assert.strictEqual(readings.length, 0);

  const skewed = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY,
    body: reading({ recorded_at: new Date(Date.now() + 60 * 1000).toISOString() }),
  });
  assert.strictEqual(skewed.status, 201);
});

test('a timestamp older than the backfill window is refused, so a stale queue cannot poison history', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY,
    body: reading({ recorded_at: new Date(Date.now() - 49 * 3600 * 1000).toISOString() }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(readings.length, 0);
});

// --- Rate: the live window is throttled even for backdated stamps ----------

test('the 61-seconds-old trick is throttled: unique stamps inside the 15-minute live window cannot flood the figure /current serves', async () => {
  reset();
  const first = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY,
    body: reading({ recorded_at: new Date(Date.now() - 61 * 1000).toISOString() }),
  });
  const second = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY,
    body: reading({ recorded_at: new Date(Date.now() - 65 * 1000).toISOString() }),
  });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 429);
  assert.strictEqual(readings.length, 1);
  // Backdated past the broadcast threshold, so neither may redraw the card.
  assert.strictEqual(emits.length, 0);
});

test('genuinely old backfill outside the live window still drains unthrottled, so a device recovers from an outage', async () => {
  reset();
  const base = Date.now() - 40 * 60 * 1000; // older than the 15-minute window
  for (let i = 0; i < 4; i++) {
    const res = await call('/api/sensors/data', {
      apiKey: DEVICE_KEY,
      body: reading({ recorded_at: new Date(base + i * 30000).toISOString() }),
    });
    assert.strictEqual(res.status, 201, `backfill reading ${i} was refused`);
  }
  assert.strictEqual(readings.length, 4);
});

test('replaying an already-stored stamp writes nothing and reports duplicate', async () => {
  reset();
  const stamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const first = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY, body: reading({ recorded_at: stamp }),
  });
  const replay = await call('/api/sensors/data', {
    apiKey: DEVICE_KEY, body: reading({ recorded_at: stamp, ir_beam_count: 9999 }),
  });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(replay.status, 201);
  assert.strictEqual(replay.body.duplicate, true);
  assert.strictEqual(readings.length, 1);
  assert.strictEqual(readings[0].ir_beam_count, 8, 'replay overwrote the stored reading');
});

// --- dry_run: every truthy spelling isBoolean() admits ----------------------

test('an installer self test sent as the string "true" is honoured as a dry run: nothing is stored, nothing is broadcast', async () => {
  // isBoolean() passes 'true', '1', 1 and false-spellings as readily as real
  // booleans. A strict `=== true` read the string spellings as "not a dry run"
  // and wrote the fabricated zero-occupancy row this flag exists to keep out.
  for (const spelling of [true, 'true', '1', 1]) {
    reset();
    const res = await call('/api/sensors/data', {
      apiKey: DEVICE_KEY,
      body: { ir_beam_count: 0, thermal_headcount: 0, noise_db: 0, dry_run: spelling },
    });
    assert.strictEqual(res.status, 200, `dry_run: ${JSON.stringify(spelling)} was not a dry run`);
    assert.strictEqual(res.body.dry_run, true);
    assert.strictEqual(readings.length, 0, `dry_run: ${JSON.stringify(spelling)} stored a row`);
    assert.strictEqual(emits.length, 0);
  }
});

test('a falsy dry_run spelling is a real reading and is stored', async () => {
  for (const spelling of [false, 'false', '0', 0]) {
    reset();
    const res = await call('/api/sensors/data', {
      apiKey: DEVICE_KEY, body: reading({ dry_run: spelling }),
    });
    assert.strictEqual(res.status, 201, `dry_run: ${JSON.stringify(spelling)} was refused`);
    assert.strictEqual(readings.length, 1);
  }
});

// --- Privacy and downstream honesty ----------------------------------------

test('no user identity enters a sensor row, the broadcast, or the ingest response', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: DEVICE_KEY, body: reading() });
  assert.strictEqual(res.status, 201);

  const insert = queryLog.find((q) => /INSERT INTO venue_sensor_data/.test(q.sql));
  assert.ok(insert, 'no insert ran');
  assert.ok(!/user/i.test(insert.sql), 'insert statement references a user column');

  assert.strictEqual(emits.length, 1);
  assert.deepStrictEqual(
    Object.keys(emits[0].payload).sort(),
    ['ir_beam_count', 'noise_db', 'recorded_at', 'thermal_headcount', 'venue_place_id']
  );
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['recorded_at', 'success']);
});

test('source pin: the ingest path touches no user table and no ML table; the only user reference in the file is the aggregate COUNT over venue_checkins', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sensors.js'), 'utf8');

  // Fabricated readings must not have a direct road into the training corpus:
  // if this ever appears, the honesty gate has to move into the ingest bounds.
  assert.ok(!/ml_training_data|ml_venues|ml_events/.test(source),
    'routes/sensors.js writes or reads an ML table directly');

  // The ingest handler (everything before the first GET route) must be free of
  // any user reference at all.
  const ingest = source.slice(0, source.indexOf("router.get("));
  assert.ok(ingest.includes('INSERT INTO venue_sensor_data'), 'ingest section not found');
  assert.ok(!/user_id|req\.user|FROM users/.test(ingest),
    'the ingest path references user identity');

  // The read side keeps exactly the documented aggregate.
  assert.ok(source.includes('COUNT(DISTINCT user_id)'),
    'the venue_checkins aggregate changed shape');
  const userIdMentions = source.match(/user_id/g) || [];
  const checkinQuery = source.slice(source.indexOf('SELECT COUNT(DISTINCT user_id)'), source.indexOf('FROM venue_checkins'));
  const inAggregate = (checkinQuery.match(/user_id/g) || []).length
    + (source.match(/WHERE venue_place_id = \$1 AND user_id IS NOT NULL/g) || []).length
    + (source.match(/\/\/[^\n]*user_id/g) || []).length; // comments explaining the aggregate
  assert.strictEqual(userIdMentions.length, inAggregate,
    'user_id appears outside the venue_checkins aggregate and its comment');
});
