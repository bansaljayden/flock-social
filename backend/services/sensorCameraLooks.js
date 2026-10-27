/**
 * THE TABLE CAMERA'S LOOKS: the `camera_looks` field a sensor reading may
 * carry, how it is checked, stored, and read back for the owner.
 *
 * THE CONTRACT (flock-sensor/main.py CameraLooks). A JSON array of at most 50
 * entries, oldest first, each sent once:
 *
 *   { at, look, table, result, found }
 *     at      ISO UTC string ("2026-10-27T21:04:05.123Z"), or null when the
 *             unit's clock was not synced at the look
 *     look    'room' (finding the tables in the empty room) or 'table'
 *     table   the table number 1-200 on a table look; null or absent on a
 *             room look
 *     result  'found' (room looks only: the tables were found), 'clear' or
 *             'dishes' (table looks only), 'person' (someone was in the
 *             frame and the look was dropped) or 'failed'
 *     found   on a room look that found tables, how many (0-200); absent or
 *             null otherwise
 *
 * One entry per shutter opening, failures included. Nothing in it is a
 * picture or says anything about a person, and an entry with any other key
 * is dropped, so nothing else can ride in under this field.
 *
 * NEVER A REFUSAL. Exactly the rule the `tables` field keeps
 * (services/sensorTables.js): the unit drops a whole reading on a 400, so a
 * bad camera_looks value is dropped and the reading is stored without it.
 * Two levels of drop:
 *   * The field itself: not an array, or more than 50 entries. Nothing of it
 *     is stored; a unit that sends more than its own ceiling is not sending
 *     the contract, and picking 50 of them would be a guess.
 *   * One entry: only that entry is dropped and the rest are stored. The
 *     entries are independent records, each sent once, so throwing away nine
 *     good looks over one bad one would lose them for good: the unit has
 *     already forgotten them.
 * Either drop is said in the log, at most once an hour per unit, with the
 * reason and never the value.
 */
const pool = require('../config/database');

const MAX_CAMERA_LOOKS = 50;
const MAX_TABLE_NUMBER = 200;
const MAX_FOUND = 200;
// The unit keeps its record 90 days, and so does this table.
const CAMERA_LOOKS_KEEP_DAYS = 90;
// A look stamped further ahead of this server's clock than this is a unit
// whose clock is wrong, and its time would sort it into tomorrow.
const MAX_FUTURE_MS = 10 * 60 * 1000;
// The most looks one day's list returns; the count is always the whole day's.
const MAX_LOOKS_LISTED = 500;

const LOOK_KEYS = new Set(['at', 'look', 'table', 'result', 'found']);
const RESULTS = Object.freeze({
  room: new Set(['found', 'person', 'failed']),
  table: new Set(['clear', 'dishes', 'person', 'failed']),
});
// The unit's iso_utc: whole seconds, an optional fraction, always Z.
const AT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = (v) => v === undefined || v === null;

/**
 * One entry, strictly. Returns the stored shape { at: Date|null, look, table,
 * result, found } or null when the entry is dropped.
 */
function parseLook(entry, nowMs) {
  if (!isPlainObject(entry)) return null;
  for (const key of Object.keys(entry)) if (!LOOK_KEYS.has(key)) return null;

  const { look, result } = entry;
  if (look !== 'room' && look !== 'table') return null;
  if (typeof result !== 'string' || !RESULTS[look].has(result)) return null;

  let at = null;
  if (!absent(entry.at)) {
    if (typeof entry.at !== 'string' || !AT_SHAPE.test(entry.at)) return null;
    at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) return null;
    if (at.getTime() > nowMs + MAX_FUTURE_MS) return null;
    // Older than the retention would be deleted by the next write anyway.
    if (at.getTime() < nowMs - CAMERA_LOOKS_KEEP_DAYS * 86400000) return null;
  }

  let table = null;
  if (look === 'table') {
    if (!Number.isInteger(entry.table) || entry.table < 1 || entry.table > MAX_TABLE_NUMBER) return null;
    table = entry.table;
  } else if (!absent(entry.table)) {
    return null;
  }

  let found = null;
  if (look === 'room' && result === 'found') {
    if (!Number.isInteger(entry.found) || entry.found < 0 || entry.found > MAX_FOUND) return null;
    found = entry.found;
  } else if (!absent(entry.found)) {
    return null;
  }

  return { at, look, table, result, found };
}

/**
 * What the ingest makes of the field. Returns { looks, ignored }: looks is
 * the list to store (possibly empty) or null when nothing was sent, and
 * ignored is null or the reason something sent is being dropped.
 */
function readCameraLooks(value, nowMs = Date.now()) {
  if (absent(value)) return { looks: null, ignored: null };
  if (!Array.isArray(value)) return { looks: null, ignored: 'not an array' };
  if (value.length > MAX_CAMERA_LOOKS) {
    return { looks: null, ignored: `more than ${MAX_CAMERA_LOOKS} entries` };
  }
  const looks = [];
  for (const entry of value) {
    const parsed = parseLook(entry, nowMs);
    if (parsed) looks.push(parsed);
  }
  const dropped = value.length - looks.length;
  return {
    looks,
    ignored: dropped > 0 ? `${dropped} of ${value.length} entries not in the contract` : null,
  };
}

// The log throttle, the same rule as noteIgnoredTables: once an hour per
// device, oldest note evicted first past the bound, in process memory on
// purpose (a deploy costs one extra line at most).
const NOTE_INTERVAL_MS = 60 * 60 * 1000;
const NOTE_MAX_KEYS = 1000;
const notedAt = new Map();

function noteIgnoredCameraLooks(deviceId, reason, now = Date.now()) {
  const last = notedAt.get(deviceId);
  if (last !== undefined && now - last < NOTE_INTERVAL_MS) return false;
  notedAt.delete(deviceId);
  while (notedAt.size >= NOTE_MAX_KEYS) notedAt.delete(notedAt.keys().next().value);
  notedAt.set(deviceId, now);
  console.warn(
    `Sensor ${deviceId}: a reading's camera_looks were dropped (${reason}). The reading was stored; `
    + 'the good entries were kept. Logged at most once an hour per device.'
  );
  return true;
}

// The insert and the unit's 90-day delete in one statement. Arrays in, one
// row per look; at is null where the unit's clock was not synced.
const CAMERA_LOOKS_INSERT_SQL = `
  WITH gone AS (
    DELETE FROM sensor_camera_looks
     WHERE sensor_device_id = $1
       AND received_at < NOW() - make_interval(days => $8::int)
  )
  INSERT INTO sensor_camera_looks (sensor_device_id, venue_place_id, at, look, table_no, result, found)
  SELECT $1, $2, l.at, l.look, l.table_no, l.result, l.found
    FROM unnest($3::timestamptz[], $4::text[], $5::smallint[], $6::text[], $7::smallint[])
      AS l(at, look, table_no, result, found)`;

const inFlight = new Set();

/**
 * Store a reading's looks. Called after the answer and not awaited there; it
 * never throws and never rejects, and a failure is logged. The looks of one
 * failed write are lost, which the unit's own 90-day record still holds.
 */
function storeCameraLooks(device, looks) {
  if (!looks || looks.length === 0) return Promise.resolve();
  const run = pool.query(CAMERA_LOOKS_INSERT_SQL, [
    device.device_id,
    device.venue_place_id,
    looks.map((l) => (l.at ? l.at.toISOString() : null)),
    looks.map((l) => l.look),
    looks.map((l) => l.table),
    looks.map((l) => l.result),
    looks.map((l) => l.found),
    CAMERA_LOOKS_KEEP_DAYS,
  ]).then(() => {}, (err) => {
    console.error(`Camera looks for ${device.device_id} failed after the reading was stored:`, err.message);
  });
  inFlight.add(run);
  run.then(() => inFlight.delete(run));
  return run;
}

// One day of a venue's looks, the day on the venue's clock ($2, an IANA zone
// or 'UTC'): $3 a YYYY-MM-DD or null for today there. A look with no time of
// its own is placed by when it arrived. Newest first, at most $4 rows, each
// carrying the whole day's count (the window counts before the limit). With
// no looks, one row of nulls and a count of 0, so the day is still said.
const CAMERA_LOOKS_DAY_SQL = `
  WITH d AS (SELECT COALESCE($3::date, (NOW() AT TIME ZONE $2)::date) AS day),
  w AS (SELECT day, (day::timestamp AT TIME ZONE $2) AS lo, ((day + 1)::timestamp AT TIME ZONE $2) AS hi FROM d)
  SELECT w.day::text AS day, c.at, c.received_at, c.look, c.table_no, c.result, c.found,
         COUNT(c.id) OVER () AS total
    FROM w
    LEFT JOIN sensor_camera_looks c
      ON c.venue_place_id = $1
     AND COALESCE(c.at, c.received_at) >= w.lo
     AND COALESCE(c.at, c.received_at) < w.hi
   ORDER BY COALESCE(c.at, c.received_at) DESC NULLS LAST, c.id DESC
   LIMIT $4`;

const iso = (v) => (v ? new Date(v).toISOString() : null);

/**
 * { day, timeZone, count, looks: [{ at, received_at, look, table, result,
 * found }] }. timeZone is the zone the day was read on, null when that was
 * UTC for want of the venue's own. Never anything image-like: the table has
 * nothing of the kind to return.
 */
async function cameraLooksDay(placeId, day, zone) {
  let usedZone = zone || null;
  let rows;
  try {
    ({ rows } = await pool.query(CAMERA_LOOKS_DAY_SQL, [placeId, usedZone || 'UTC', day || null, MAX_LOOKS_LISTED]));
  } catch (err) {
    // A zone Postgres will not take is read in UTC, as tableHistory does.
    if (err.code !== '22023' || !usedZone) throw err;
    console.error('Postgres refused a venue time zone; camera looks are read in UTC:', err.message);
    usedZone = null;
    ({ rows } = await pool.query(CAMERA_LOOKS_DAY_SQL, [placeId, 'UTC', day || null, MAX_LOOKS_LISTED]));
  }
  const first = rows[0] || {};
  const looks = rows.filter((r) => r.look).map((r) => ({
    at: iso(r.at),
    received_at: iso(r.received_at),
    look: r.look,
    table: r.table_no === null || r.table_no === undefined ? null : Number(r.table_no),
    result: r.result,
    found: r.found === null || r.found === undefined ? null : Number(r.found),
  }));
  return { day: first.day || day || null, timeZone: usedZone, count: looks.length ? Number(first.total) : 0, looks };
}

module.exports = {
  MAX_CAMERA_LOOKS,
  CAMERA_LOOKS_KEEP_DAYS,
  MAX_LOOKS_LISTED,
  CAMERA_LOOKS_INSERT_SQL,
  CAMERA_LOOKS_DAY_SQL,
  parseLook,
  readCameraLooks,
  noteIgnoredCameraLooks,
  storeCameraLooks,
  cameraLooksDay,
  // Test seams: the throttle is process-global, and the write is after the answer.
  _resetNotes: () => notedAt.clear(),
  _settled: () => Promise.allSettled([...inFlight]),
};
