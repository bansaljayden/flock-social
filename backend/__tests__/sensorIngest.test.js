// Run: node --test  (from backend/)
//
// The Raspberry Pi occupancy sensor is untrusted hardware. It sits in a bar on
// someone else's wifi, it is physically reachable by strangers, and its API key
// can be read off the SD card by anyone who walks away with the box. Whatever
// it claims becomes the "Live Occupancy" number shown to users and a ground
// truth signal for the crowd model.
//
// Every test below pins one way a wrong or forged number could reach that
// figure. The comment on each is the failure it prevents, not the assertion.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');

process.env.JWT_SECRET = 'sensor-ingest-test-secret';

const pool = require('../config/database');

// --- Fake database --------------------------------------------------------
// Modelled, not scripted: the flood guard and the duplicate check are only
// meaningful if the store actually enforces them, so the fake keeps real state.

let devices = [];
let readings = [];
let venueProfiles = [];
let queryLog = [];

function intervalToMs(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(millisecond|second|minute|hour)s?$/.exec(String(text).trim());
  if (!m) throw new Error(`fake db cannot parse interval ${text}`);
  const n = Number(m[1]);
  return n * { millisecond: 1, second: 1000, minute: 60000, hour: 3600000 }[m[2]];
}

pool.query = (sql, params = []) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queryLog.push({ sql: flat, params });

  if (/SELECT id, device_id, venue_place_id, is_active FROM sensor_devices/.test(flat)) {
    const row = devices.find((d) => d.api_key === params[0] || d.api_key === params[1]);
    return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
  }

  // Backfill: an unconditional liveness touch, no rate guard.
  if (/^UPDATE sensor_devices SET last_seen_at = NOW\(\) WHERE id = \$1$/.test(flat)) {
    const device = devices.find((d) => d.id === params[0]);
    if (device) device.last_seen_at = Date.now();
    return Promise.resolve({ rows: [], rowCount: device ? 1 : 0 });
  }

  // Live: the guarded, atomic form.
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

  // Owner gate on the fleet-health read.
  if (/SELECT 1 FROM venue_profiles WHERE user_id = \$1 AND google_place_id = \$2/.test(flat)) {
    const hit = venueProfiles.find((v) => v.user_id === params[0] && v.google_place_id === params[1]);
    return Promise.resolve({ rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 });
  }

  // The fleet-health read itself.
  if (/SELECT device_id, device_name, is_active, last_seen_at, deployed_at/.test(flat)) {
    const [placeId, windowMinutes] = params;
    const rows = devices
      .filter((d) => d.venue_place_id === placeId)
      .sort((a, b) => a.device_id.localeCompare(b.device_id))
      .map((d) => ({
        device_id: d.device_id,
        device_name: d.device_name || null,
        is_active: d.is_active,
        last_seen_at: d.last_seen_at === null ? null : new Date(d.last_seen_at),
        deployed_at: new Date(0),
        seconds_since_last_seen:
          d.last_seen_at === null ? null : Math.floor((Date.now() - d.last_seen_at) / 1000),
        online: d.last_seen_at !== null && Date.now() - d.last_seen_at < windowMinutes * 60000,
      }));
    return Promise.resolve({ rows, rowCount: rows.length });
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

// A pool client checked out and never released is how a Node service dies
// slowly. This route needs no transaction, so it must never take one.
pool.connect = async () => {
  throw new Error('routes/sensors.js must not check a client out of the pool');
};

// authenticate() is replaced BEFORE the router is required — the router
// destructures it at module load.
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

function call(path, { apiKey, body, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (apiKey !== undefined) headers['x-api-key'] = apiKey;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// --- Fixtures -------------------------------------------------------------

const PLAINTEXT_KEY = 'legacy-plaintext-key-0001';
const HASHED_KEY = 'a'.repeat(64);
const VENUE = 'ChIJfoxAndHounds00001';
const OTHER_VENUE = 'ChIJsomewhereElse0001';

const digestOf = (key) =>
  'sha256:' + crypto.createHash('sha256').update(key, 'utf8').digest('hex');

function reset() {
  queryLog = [];
  readings = [];
  emits = [];
  devices = [
    { id: 1, device_id: 'sensor_001', venue_place_id: VENUE, is_active: true,
      device_name: 'The Fox, front door',
      api_key: digestOf(HASHED_KEY), last_seen_at: null },
    { id: 2, device_id: 'sensor_legacy', venue_place_id: OTHER_VENUE, is_active: true,
      api_key: PLAINTEXT_KEY, last_seen_at: null },
    { id: 3, device_id: 'sensor_dead', venue_place_id: VENUE, is_active: false,
      api_key: digestOf('retired-key'), last_seen_at: null },
  ];
  // User 1 is the authenticated caller (see the authenticate stub) and owns
  // VENUE. Nobody owns OTHER_VENUE.
  venueProfiles = [{ user_id: 1, google_place_id: VENUE }];
}

const reading = (extra = {}) => ({
  ir_beam_count: 12, thermal_headcount: 20, noise_db: 71.5, ...extra,
});

// Let the per-device flood guard's clock run out for a device.
function ageDevice(deviceId, ms = 60000) {
  const d = devices.find((x) => x.device_id === deviceId);
  d.last_seen_at = Date.now() - ms;
}

// --- Credentials ----------------------------------------------------------

test('a key stored as a sha256 digest authenticates, so a database dump does not hand its reader the ability to forge readings for every wired venue', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(readings.length, 1);
  assert.strictEqual(readings[0].sensor_device_id, 'sensor_001');
});

test('a legacy plaintext key still authenticates, so hashing existing rows never needs a fleet re-flash', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: PLAINTEXT_KEY, body: reading() });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(readings[0].sensor_device_id, 'sensor_legacy');
});

test('both key forms are tried in one indexed lookup, so guessing a key costs the same as presenting a real one', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  const lookups = queryLog.filter((q) => /FROM sensor_devices WHERE api_key/.test(q.sql));
  assert.strictEqual(lookups.length, 1);
  assert.deepStrictEqual(lookups[0].params, [digestOf(HASHED_KEY), HASHED_KEY]);
});

test('no key is a 401 and never reaches the database', async () => {
  reset();
  const res = await call('/api/sensors/data', { body: reading() });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(queryLog.length, 0);
});

test('an unknown key is a 401 and writes nothing', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: 'not-a-real-key', body: reading() });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(readings.length, 0);
});

test('an absurdly long key is refused before it is handed to the database', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: 'x'.repeat(5000), body: reading() });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(queryLog.length, 0);
});

test('a deactivated device is refused with 403, not 401, so the Pi treats it as permanent and goes quiet instead of retrying forever', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: 'retired-key', body: reading() });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(readings.length, 0);
});

test('no response ever echoes the presented API key back', async () => {
  reset();
  for (const key of [HASHED_KEY, 'not-a-real-key', 'retired-key']) {
    const res = await call('/api/sensors/data', { apiKey: key, body: reading() });
    assert.ok(!res.raw.includes(key), `response leaked the key for ${key}`);
  }
});

test('a bad payload from an unauthenticated caller is a 401, not a 400, so the endpoint cannot be used to probe what a reading looks like', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: 'not-a-real-key', body: { nonsense: true } });
  assert.strictEqual(res.status, 401);
});

// --- Installer self test --------------------------------------------------

test('an installer can prove the key and the network work without writing a fabricated zero-occupancy row into the venue history and the model training data', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: { ...reading({ ir_beam_count: 0, thermal_headcount: 0, noise_db: 0 }), dry_run: true },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.dry_run, true);
  assert.strictEqual(res.body.device_id, 'sensor_001');
  assert.strictEqual(readings.length, 0);
  assert.strictEqual(emits.length, 0);
});

test('a dry run still has to authenticate, or it would be a free way to check whether a stolen key is live without leaving a row behind', async () => {
  reset();
  const bad = await call('/api/sensors/data', { apiKey: 'not-a-real-key', body: { ...reading(), dry_run: true } });
  assert.strictEqual(bad.status, 401);
  const dead = await call('/api/sensors/data', { apiKey: 'retired-key', body: { ...reading(), dry_run: true } });
  assert.strictEqual(dead.status, 403);
});

test('a dry run still catches a Pi flashed with the wrong venue key, which is the whole reason an installer runs one', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: { ...reading({ device_id: 'sensor_legacy' }), dry_run: true },
  });
  assert.strictEqual(res.status, 403);
});

// --- Venue binding --------------------------------------------------------

test('a device cannot report for a venue it is not installed at: the venue comes from its own row and a venue_place_id in the payload is ignored', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY,
    body: reading({ venue_place_id: OTHER_VENUE, sensor_device_id: 'sensor_legacy' }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(readings[0].venue_place_id, VENUE);
  assert.strictEqual(readings[0].sensor_device_id, 'sensor_001');
});

test('a Pi flashed with another venue key is caught at the first push instead of silently reporting one bar crowd as another for a month', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ device_id: 'sensor_legacy' }),
  });
  assert.strictEqual(res.status, 403);
  assert.match(res.body.error, /device_id/);
  assert.strictEqual(readings.length, 0);
});

test('a device that echoes its own id is accepted', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ device_id: 'sensor_001' }),
  });
  assert.strictEqual(res.status, 201);
});

// --- Value bounds ---------------------------------------------------------

test('an implausible entry count is refused, so an hourly SUM can never overflow int32 and 500 the history endpoint for a venue permanently', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ ir_beam_count: 2147483647 }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(readings.length, 0);
});

test('a negative count is refused', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ ir_beam_count: -5 }),
  });
  assert.strictEqual(res.status, 400);
});

test('a headcount larger than any doorway can see is refused', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ thermal_headcount: 5000 }),
  });
  assert.strictEqual(res.status, 400);
});

test('a physically impossible noise level is refused: 140 dB is a jet engine and the old ceiling of 200 let a device claim past it', async () => {
  reset();
  const tooLoud = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ noise_db: 190 }),
  });
  assert.strictEqual(tooLoud.status, 400);

  ageDevice('sensor_001');
  const loudButReal = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ noise_db: 118.25 }),
  });
  assert.strictEqual(loudButReal.status, 201);
});

test('a missing field is refused rather than stored as null occupancy', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: { ir_beam_count: 3, noise_db: 60 },
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(readings.length, 0);
});

// --- Timestamps -----------------------------------------------------------

test('a buffered reading keeps the time it was taken, so a two hour outage does not land the whole outage in one hourly bucket as a crowd spike that never happened', async () => {
  reset();
  const takenAt = new Date(Date.now() - 90 * 60 * 1000);
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ recorded_at: takenAt.toISOString() }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(readings[0].recorded_at.getTime(), takenAt.getTime());
});

test('a device with a wrong clock cannot file a reading in the future', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY,
    body: reading({ recorded_at: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString() }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(readings.length, 0);
});

test('a Pi that booted before NTP cannot back date a reading to 1970 and poison the venue history', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ recorded_at: '1970-01-01T00:00:00.000Z' }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(readings.length, 0);
});

test('a timestamp we cannot believe is refused, not quietly rewritten to now, or a Pi that sat powered off for three days would dump its stale queue into the current hour and invent a crowd', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY,
    body: reading({ recorded_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString() }),
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /old/);
  assert.strictEqual(readings.length, 0);
});

test('a reading with no timestamp at all is still filed on arrival, which is right for a live push', async () => {
  reset();
  const res = await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  assert.strictEqual(res.status, 201);
  assert.ok(Math.abs(readings[0].recorded_at.getTime() - Date.now()) < 5000);
});

test('a recorded_at that is not a timestamp at all is a 400, not a crash', async () => {
  reset();
  const res = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ recorded_at: 'yesterday-ish' }),
  });
  assert.strictEqual(res.status, 400);
});

test('a control character in device_id cannot forge extra server log lines', async () => {
  reset();
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const res = await call('/api/sensors/data', {
      apiKey: HASHED_KEY,
      body: reading({ device_id: 'sensor_x\nFATAL: everything is fine, ignore this' }),
    });
    assert.strictEqual(res.status, 403);
  } finally {
    console.error = realError;
  }
  assert.ok(logged.length > 0);
  assert.ok(!logged.join('\n').includes('\nFATAL'), 'a newline reached the log');
});

// --- Replay and duplication -----------------------------------------------

test('a push that succeeded but timed out on the Pi is retried without double counting the doorway', async () => {
  reset();
  const takenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const first = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ recorded_at: takenAt }),
  });
  const second = await call('/api/sensors/data', {
    apiKey: HASHED_KEY, body: reading({ recorded_at: takenAt }),
  });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 201);
  assert.strictEqual(second.body.duplicate, true);
  assert.strictEqual(readings.length, 1);
});

test('a stolen key cannot append live rows without limit: the guard is the same statement as the write, so two concurrent pushes cannot both pass it', async () => {
  reset();
  const first = await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  const second = await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 429);
  assert.strictEqual(readings.length, 1);

  const guards = queryLog.filter((q) => /UPDATE sensor_devices SET last_seen_at/.test(q.sql));
  for (const g of guards) {
    assert.match(g.sql, /WHERE id = \$1 AND \(last_seen_at IS NULL OR last_seen_at <= NOW\(\) - \$2::interval\)/);
  }
});

test('the flood guard never fires on a device pushing at its normal cadence', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  ageDevice('sensor_001', 30000);
  const next = await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  assert.strictEqual(next.status, 201);
});

test('draining a buffer after an outage is not mistaken for a flood, or a device could never recover from one', async () => {
  reset();
  const base = Date.now() - 60 * 60 * 1000;
  for (let i = 0; i < 5; i++) {
    const res = await call('/api/sensors/data', {
      apiKey: HASHED_KEY,
      body: reading({ recorded_at: new Date(base + i * 30000).toISOString() }),
    });
    assert.strictEqual(res.status, 201, `backfilled reading ${i} was refused`);
  }
  assert.strictEqual(readings.length, 5);
});

test('a 429 says how long to wait, or the device falls back to its outage backoff and never catches up', async () => {
  // The device has no other way to know. Left to guess, flock-sensor/main.py
  // used the network backoff, which doubles to fifteen minutes, so a Pi
  // draining a buffer slept longer than it took to fill and drifted further
  // behind on every cycle until it hit its 240-entry cap and dropped readings.
  // MIN_LIVE_GAP_SECONDS is what this endpoint actually enforces, so it is what
  // this endpoint has to say.
  reset();
  await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  const second = await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });

  assert.strictEqual(second.status, 429);
  assert.strictEqual(second.headers['retry-after'], '2');
  assert.strictEqual(second.body.retry_after_seconds, 2);
  // Seconds, and small enough that honouring it is cheaper than backing off.
  assert.ok(second.body.retry_after_seconds > 0 && second.body.retry_after_seconds <= 10);
});

// --- Fleet health ---------------------------------------------------------

test('a venue owner can tell whether their sensor is alive, which last_seen_at was recorded for and nothing read', async () => {
  reset();
  ageDevice('sensor_001', 20000);
  const res = await call(`/api/sensors/${VENUE}/status`, { method: 'GET' });

  assert.strictEqual(res.status, 200);
  const online = res.body.devices.find((d) => d.device_id === 'sensor_001');
  assert.strictEqual(online.online, true);
  assert.strictEqual(online.is_active, true);
  assert.ok(online.seconds_since_last_seen >= 20 && online.seconds_since_last_seen < 40);
  assert.strictEqual(res.body.online_within_minutes, 15);
});

test('a unit that died on Friday reads as offline instead of silently vanishing from the dashboard', async () => {
  // Both sensor cards in App.js render only when /current returns a row, so a
  // dead unit does not show as broken, the whole section stops existing and the
  // owner is told nothing.
  reset();
  ageDevice('sensor_001', 3 * 24 * 60 * 60 * 1000);
  const res = await call(`/api/sensors/${VENUE}/status`, { method: 'GET' });

  const dead = res.body.devices.find((d) => d.device_id === 'sensor_001');
  assert.strictEqual(dead.online, false);
  assert.ok(dead.seconds_since_last_seen > 200000, 'the age has to be reportable, not just a flag');
});

test('a device that has never reported is distinguishable from one that has gone quiet', async () => {
  reset();
  const res = await call(`/api/sensors/${VENUE}/status`, { method: 'GET' });
  const fresh = res.body.devices.find((d) => d.device_id === 'sensor_001');
  assert.strictEqual(fresh.last_seen_at, null);
  assert.strictEqual(fresh.seconds_since_last_seen, null);
  assert.strictEqual(fresh.online, false);
});

test('a deactivated unit is still listed, or revoking a device would make it look like it was never installed', async () => {
  reset();
  const res = await call(`/api/sensors/${VENUE}/status`, { method: 'GET' });
  const retired = res.body.devices.find((d) => d.device_id === 'sensor_dead');
  assert.ok(retired, 'an is_active=false row must still be visible to its owner');
  assert.strictEqual(retired.is_active, false);
});

test('fleet health is owner scoped: a user cannot enumerate hardware at a venue that is not theirs', async () => {
  reset();
  const res = await call(`/api/sensors/${OTHER_VENUE}/status`, { method: 'GET' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.devices, undefined);
});

test('no API key in either form ever leaves through the status route', async () => {
  reset();
  ageDevice('sensor_001', 1000);
  const res = await call(`/api/sensors/${VENUE}/status`, { method: 'GET' });

  // The stored digest is the verifier for a legacy plaintext row, so handing it
  // to a browser hands back the ability to post readings for this venue.
  assert.ok(!/api_key|sha256:/.test(res.raw), res.raw);
  const selects = queryLog.filter((q) => /FROM sensor_devices/.test(q.sql));
  for (const q of selects) {
    if (/^SELECT device_id, device_name/.test(q.sql)) assert.ok(!/api_key/.test(q.sql));
  }
});

// --- Live broadcast -------------------------------------------------------

test('a live reading is broadcast to the venue room', async () => {
  reset();
  await call('/api/sensors/data', { apiKey: HASHED_KEY, body: reading() });
  assert.strictEqual(emits.length, 1);
  assert.strictEqual(emits[0].room, `venue:${VENUE}`);
  assert.strictEqual(emits[0].event, 'venue_sensor_update');
});

test('a backfilled reading is not broadcast, so a two hour old count never redraws the venue card as if it were now', async () => {
  reset();
  await call('/api/sensors/data', {
    apiKey: HASHED_KEY,
    body: reading({ recorded_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }),
  });
  assert.strictEqual(readings.length, 1);
  assert.strictEqual(emits.length, 0);
});

// --- Read side ------------------------------------------------------------

test('the current reading is bounded by a staleness window, so a sensor that died on Friday is not still showing Friday crowd on Sunday', async () => {
  reset();
  pool.query = (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    queryLog.push({ sql: flat, params });
    if (/FROM venue_sensor_data/.test(flat)) return Promise.resolve({ rows: [] });
    if (/FROM venue_checkins/.test(flat)) return Promise.resolve({ rows: [{ count: 0 }] });
    return Promise.reject(new Error(`unscripted: ${flat.slice(0, 120)}`));
  };
  const res = await call(`/api/sensors/${VENUE}/current`, { method: 'GET' });
  assert.strictEqual(res.status, 200);
  const readQuery = queryLog.find((q) => /FROM venue_sensor_data/.test(q.sql));
  assert.match(readQuery.sql, /recorded_at > NOW\(\) - INTERVAL '1 minute' \* \$2/);
  assert.ok(readQuery.params[1] > 0 && readQuery.params[1] <= 60);
});

test('the hourly entry total is capped before the int cast, so one bad historical row cannot overflow the SUM and 500 the chart for a venue', async () => {
  queryLog = [];
  pool.query = (sql, params) => {
    queryLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return Promise.resolve({ rows: [] });
  };
  const res = await call(`/api/sensors/${VENUE}/history?hours=24`, { method: 'GET' });
  assert.strictEqual(res.status, 200);
  assert.match(queryLog[0].sql, /LEAST\(SUM\(ir_beam_count\), 2147483647\)::int/);
});
