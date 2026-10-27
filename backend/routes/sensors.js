const express = require('express');
const crypto = require('crypto');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
// Shape before content — see validators/shape.js. Nothing a sensor sends is
// ever legitimately structured.
const { scalarOnly } = require('../validators/shape');
// Table monitoring: the `tables` string a reading may carry, and what is done
// with it. The contract and the reason a bad value is ignored rather than
// refused are at the top of that file.
const {
  MAX_TABLES_LENGTH, readTables, tableCounts, noteIgnoredTables, applyTableReading, applySilentReading,
} = require('../services/sensorTables');
// What the owner's table routes and the public summary read back out of the
// floor and the history: services/tableHistory.js holds every statement and
// every rule, and its header says what leaves each one.
const tableHistory = require('../services/tableHistory');
// The table camera's looks: the `camera_looks` list a reading may carry, kept
// for the owner's day of looks. Dropped, never refused, like `tables`; the
// contract is at the top of that file.
const sensorCameraLooks = require('../services/sensorCameraLooks');
// The table routes are a Roost feature, gated the way requireVenueTier gates.
const { checkVenueTier } = require('../services/venueEntitlements');

const router = express.Router();

// ---------------------------------------------------------------------------
// Ingest bounds
//
// The Pi is untrusted hardware: it sits in a bar, on someone else's wifi, and
// anyone who walks off with it owns its API key. Everything it claims is
// therefore clamped here, because these rows are the public "Live Occupancy"
// figure, and the intended ground truth for the crowd model once an exporter
// reads them. None does yet: scripts/ml/RETRAIN.md lists this table as a
// future source, and nothing in crowdEngine, mlPredictor or the export
// scripts touches it today. A wrong reading is still a wrong number shown to
// a user right now.
// ---------------------------------------------------------------------------

// One IR beam break per ~500ms is the physical ceiling of the hardware, so
// even a 60s interval cannot honestly produce more than ~120. 10k leaves an
// enormous margin while making integer overflow of the hourly SUM impossible
// (the history endpoint sums these; an unbounded INT32 used to be able to
// overflow that SUM and 500 the endpoint for a venue permanently).
const MAX_IR_PER_READING = 10000;
// A doorway sensor sees a doorway, not a stadium.
const MAX_THERMAL = 1000;
// 140 dB is a jet engine at 30m. The client clamps to the same ceiling.
const MAX_NOISE_DB = 140;
// The occupancy estimate (people inside now, and the plausible range around
// it) is worked out on the device from the doorway in/out count and the
// thermal count. Unlike thermal_headcount it is a whole-room figure, so it may
// exceed what one camera sees; 5000 is past any venue we would put one in.
const MAX_OCCUPANCY = 5000;
// Typical stay, from Little's law on the device. A day is the ceiling; the
// device sends null, not 0, when too few people arrived to say.
const MIN_DWELL_MINUTES = 1;
const MAX_DWELL_MINUTES = 1440;
// How far back a device may backfill after an outage. Its own buffer holds
// about 2h of readings; 48h covers a long outage plus a device that was
// powered off and came back, without letting genuinely stale data in.
const MAX_BACKFILL_HOURS = 48;
// Tolerance for a device clock running slightly ahead of ours.
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
// A reading older than this is a backfill (buffer flush), not a live push.
// This governs ONE thing: whether the row is broadcast to subscribers as "what
// is happening now". It is NOT the rate-limiting question — see below.
const BACKFILL_THRESHOLD_MS = 60 * 1000;
// How recent a row must be to be served as the venue's live occupancy by
// GET /:placeId/current. Declared here rather than beside that route because
// the ingest path has to know it too; see MIN_LIVE_GAP_SECONDS.
const CURRENT_READING_MAX_AGE_MINUTES = 15;
const CURRENT_READING_MAX_AGE_MS = CURRENT_READING_MAX_AGE_MINUTES * 60 * 1000;
// Minimum spacing between accepted rows from one device that could MOVE THE
// LIVE FIGURE. Live pushes are ~30s apart so this never fires in normal
// operation; it exists so a stolen key or a runaway loop cannot drive the
// number the app is showing right now.
//
// ROUND 20 — THE GUARD WAS ASKING THE WRONG QUESTION. It was applied to
// `!isBackfill`, i.e. only to rows stamped within the last 60 SECONDS, and the
// note here claimed that a holder of a stolen key "cannot move the live figure,
// because that still needs a live-stamped reading". That was false, and the two
// constants above say why: /current serves the newest row within FIFTEEN
// MINUTES. Everything between 60 seconds and 15 minutes old was therefore
// classified as backfill — no rate limit at all — while still being exactly
// what that endpoint hands back as the venue's live occupancy. A device pulled
// off a wall could stamp each forged reading 61 seconds old, vary the
// millisecond so the (device, recorded_at) dedupe never matched, and write the
// public "Live Occupancy" figure as fast as the network allowed.
//
// The rate limit now follows the visibility rule rather than the broadcast
// rule: a row is throttled when it lands inside the window /current reads.
//
// The reason the guard skipped backfill in the first place still holds and is
// still honoured. A device draining a two-hour buffer must not be told 429 —
// it reads that as "try later", backs off, and never catches up. But only the
// newest ~15 minutes of that buffer is throttled (about 30 readings, i.e. about
// a minute of extra drain); the other hour and three quarters still goes as
// fast as the round trips allow. Genuinely old backfill stays bounded by the
// 48h window, the dedupe below, and the per-IP limiter in server.js, and the
// residual risk there is unchanged: someone holding a stolen key can write
// plausible-looking HISTORY for the one venue they stole the hardware from.
// What they can no longer do is drive the number on the venue card.
const MIN_LIVE_GAP_SECONDS = 2;
// A key longer than this is not one of ours; don't hand it to the database.
const MAX_API_KEY_LENGTH = 512;

// A presented key that even LOOKS like a stored digest is never compared as a
// literal — see the note in findDeviceByApiKey. The test is the prefix rather
// than the full `sha256:` + 64 lowercase hex, and deliberately so: an operator
// who stored an uppercase digest would have a row our lowercase digest can
// never match, so that device is already broken and someone has to fix it —
// but under the narrower pattern the uppercase string would still have fallen
// through to the literal branch and replayed straight out of a database dump.
// The prefix rule has no such seam. It costs only the ability to use a
// PLAINTEXT key that begins with "sha256:", which is exactly the ambiguity
// worth refusing.
const DIGEST_FORM = /^sha256:/i;

// ---------------------------------------------------------------------------
// THE WHOLE INGEST IS ONE STATEMENT, because every statement is a network
// round trip and the database is not on this machine.
//
// A push used to cost four sequential round trips on its common path: the key
// lookup, the duplicate check, the flood guard, the insert. Production reaches
// Postgres through Railway's public TCP proxy, and the Railway HTTP, DNS and
// network-flow logs for 2026-09-25 01:00-04:15 UTC show what four of them
// cost. Of 401 pushes, 209 finished inside 200 ms. 106 took 500-700 ms on a
// connection that was already open, which is four round trips of roughly 130
// ms each; the one such connection read out of the flow log reports 64 ms of
// latency where the fast ones report 3-8. 77 took 1.4-1.7 s, and 76 of those
// had to open that kind of connection first. The query half of every one of
// those costs is paid per round trip, so the round trips are what this
// statement removes. The rules are all still here and still decided by the
// database: the key lookup, the duplicate check before the flood guard, the
// guard's single atomic UPDATE, the unthrottled touch for old backfill, and an
// insert that happens only when all of them say so.
//
// WHAT MAY WRITE is decided in two halves and both are needed. Everything that
// depends only on the request (validation, dry_run, the timestamp rules, the
// type of a claimed device_id) is settled in JS before the statement runs and
// arrives as $3. Everything that depends on WHICH device the key belongs to
// (is it active, is the claimed device_id its own) is decided in the statement
// itself, in `writer`, because the handler only learns the device from this
// same round trip. A new refusal added to the handler must therefore be folded
// into `filing` below, or into `writer` if it needs the device row: the
// handler REPORTS refusals after the statement returns, in the order it always
// has, so a refusal that exists only in the reporting would answer 4xx for a
// row that was already stored.
//
// Parameters that are not going to be written are sent as NULL, never as what
// the caller sent. A typed parameter is parsed when it is bound, whether or not
// any row ever uses it, so `ir_beam_count: "abc"` bound as $9::integer would be
// a 22P02 and a 500 instead of the 400 validation already decided on.
//
// TWO DELIVERIES OF ONE READING AT ONCE. The duplicate check reads the snapshot
// the statement started with, so two deliveries of the same reading that start
// before either commits both find nothing. On the live figure the guard's row
// lock settles it; on backfill nothing did, and both inserted, until migration
// 082 made (sensor_device_id, recorded_at) the table's unique key. The insert
// now yields to that key (ON CONFLICT DO NOTHING waits for the other delivery
// to commit and then stores nothing), and `raced` reports that the way `dup`
// reports a re-delivery, so the handler gives both the same duplicate answer.
// `raced` restates the insert's own gate: an insert that was allowed to run and
// returned no row can only have met the key.
//
// $12-$15 are the occupancy estimate, trailing so every older parameter kept
// its number. All four are optional: a device on older firmware sends none of
// them and its row stores NULL, which is the truth for it.
//
// $16-$19 are the table counts (migration 130), trailing for the same reason:
// how many tables the unit watches, how many have a party at them (seated or
// waiting), how many are waiting, and how many need clearing. Counted in JS
// from the `tables` string (services/sensorTables.js), and NULL for a reading
// that carried none or carried one the strict parse ignored.
//
// tables_updated_at, on the answer, is when this unit last wrote its table
// rows (migration 130). It is read in this same round trip so that a live
// reading with no tables string can tell whether the unit's rows have been
// silent long enough to be forgotten (services/sensorTables.js, SILENCE)
// without a statement of its own on every reading: most units have no table
// rows at all, and this is the one place the handler already learns about
// the device. One index lookup of at most forty rows.
//
// Every parameter keeps ONE type through the statement ($4, $6 and $7 are each
// used more than once, with the same cast every time):
// __tests__/sqlParameterTypes.test.js prepares this against a migrated
// Postgres, and a parameter deduced two ways is refused outright (42P08) with
// any input at all.
const INGEST_SQL = `
  WITH device AS (
    SELECT id, device_id, venue_place_id, is_active
      FROM sensor_devices
     WHERE api_key = $1 OR api_key = $2
     LIMIT 1
  ),
  writer AS (
    SELECT id, device_id, venue_place_id
      FROM device
     WHERE is_active
       AND $3::boolean
       AND ($4::varchar IS NULL OR device_id = $4::varchar)
  ),
  dup AS (
    SELECT v.recorded_at
      FROM venue_sensor_data v, writer w
     WHERE $5::boolean
       AND v.sensor_device_id = w.device_id
       AND v.recorded_at = $6::timestamptz
     LIMIT 1
  ),
  touch AS (
    UPDATE sensor_devices s
       SET last_seen_at = NOW()
      FROM writer w
     WHERE s.id = w.id
       AND (EXISTS (SELECT 1 FROM dup)
            OR NOT $7::boolean
            OR s.last_seen_at IS NULL
            OR s.last_seen_at <= NOW() - $8::interval)
    RETURNING s.id
  ),
  ins AS (
    INSERT INTO venue_sensor_data
      (venue_place_id, ir_beam_count, thermal_headcount, noise_db, sensor_device_id, recorded_at,
       occupancy, occupancy_low, occupancy_high, dwell_minutes,
       tables_total, tables_occupied, tables_waiting, tables_to_clear)
    SELECT w.venue_place_id, $9::integer, $10::integer, $11::numeric, w.device_id,
           COALESCE($6::timestamptz, NOW()),
           $12::integer, $13::integer, $14::integer, $15::integer,
           $16::integer, $17::integer, $18::integer, $19::integer
      FROM writer w
     WHERE NOT EXISTS (SELECT 1 FROM dup)
       AND (NOT $7::boolean OR EXISTS (SELECT 1 FROM touch))
    ON CONFLICT (sensor_device_id, recorded_at) DO NOTHING
    RETURNING recorded_at
  ),
  raced AS (
    SELECT COALESCE($6::timestamptz, NOW()) AS recorded_at
      FROM writer
     WHERE NOT EXISTS (SELECT 1 FROM dup)
       AND (NOT $7::boolean OR EXISTS (SELECT 1 FROM touch))
       AND NOT EXISTS (SELECT 1 FROM ins)
  )
  SELECT d.id, d.device_id, d.venue_place_id, d.is_active,
         COALESCE((SELECT recorded_at FROM dup), (SELECT recorded_at FROM raced)) AS duplicate_of,
         (SELECT recorded_at FROM ins) AS recorded_at,
         (SELECT MAX(t.updated_at) FROM sensor_table_states t WHERE t.sensor_device_id = d.device_id) AS tables_updated_at
    FROM device d`;

// What the statement is told when this request must not write: nothing but the
// key. The guard interval is still a real interval so $8 always binds cleanly.
const NO_FILING = null;

function ingestParams(digest, legacy, filing) {
  const gap = `${MIN_LIVE_GAP_SECONDS} seconds`;
  if (!filing) {
    return [digest, legacy, false, null, false, null, false, gap, null, null, null, null, null, null, null,
      null, null, null, null];
  }
  return [
    digest, legacy, true,
    filing.claimedDeviceId,
    filing.clientSupplied,
    filing.recordedAt,
    filing.affectsLiveFigure,
    gap,
    filing.irBeamCount,
    filing.thermalHeadcount,
    filing.noiseDb,
    filing.occupancy,
    filing.occupancyLow,
    filing.occupancyHigh,
    filing.dwellMinutes,
    filing.tablesTotal,
    filing.tablesOccupied,
    filing.tablesWaiting,
    filing.tablesToClear,
  ];
}

// The `tables` field never refuses a reading (services/sensorTables.js says
// why), so an error the validator chain raises on it is taken out of the list
// that decides the 400 and handed on as "drop the field". Every other field is
// judged exactly as before. Returns the remaining errors as an array, and
// whether `tables` was among the refused.
function setTablesAside(result) {
  const all = result.array();
  const errors = all.filter((e) => !(e.location === 'body' && e.path === 'tables'));
  return { errors, tablesRefused: errors.length !== all.length };
}

// An absent optional field is null, never undefined: node-postgres binds both
// as NULL, but the parameter array is what the tests pin.
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/**
 * The occupancy estimate as it will be stored. Only ever handed a body that
 * passed validation, so each value is null or an in-range integer, or a
 * numeric string the validator admitted. Those are made numbers here, so the
 * live broadcast carries the same type /current returns and the app, which
 * tests typeof === 'number', does not fall back to the thermal count.
 *
 * A band that contradicts its own estimate (low above it, or high below it) is
 * a device bug or a forged value, and either way it is not a range anyone
 * should be shown. It is dropped rather than the reading refused: a 400 tells
 * the device the reading is malformed, the device discards it for good, and
 * the occupancy and the three counts that came with it are lost with it. A
 * band with no estimate to sit around is dropped for the same reason, because
 * the app would draw it around the thermal count instead.
 */
function occupancyEstimate(b) {
  const occupancy = intOrNull(b.occupancy);
  let low = intOrNull(b.occupancy_low);
  let high = intOrNull(b.occupancy_high);
  const unusable = occupancy === null
    || (low !== null && low > occupancy)
    || (high !== null && occupancy > high);
  if (unusable) { low = null; high = null; }
  return { occupancy, occupancyLow: low, occupancyHigh: high, dwellMinutes: intOrNull(b.dwell_minutes) };
}

/**
 * Look up a sensor device by presented API key, and, when the handler passes a
 * `filing`, file that reading in the same statement (see INGEST_SQL above).
 * Resolves to the device row, or null for a key that matches nothing. With a
 * filing the row also carries `duplicate_of` (the stored stamp, when this was a
 * re-delivery) and `recorded_at` (the stamp of the row just written); both are
 * null when nothing was written.
 *
 * Keys may be stored either as the raw key (legacy rows) or as
 * `sha256:<hex>` of the key. The hashed form is preferred: a database dump
 * then does not hand the reader the ability to forge readings for every
 * venue we have hardware in. Both forms are accepted so keys can be migrated
 * without a fleet re-flash.
 *
 * Both candidates go into a single indexed lookup, so a bad key costs the
 * same as a good one.
 *
 * THE LEGACY BRANCH IS NOT UNCONDITIONAL, and that is the whole point of this
 * function. `api_key = $1 OR api_key = $2` with $2 the key exactly as presented
 * meant a caller could send the STORED DIGEST as their API key — the string
 * `sha256:<hex>` matches the stored `sha256:<hex>` on the raw comparison — and
 * be authenticated as that device. So the hashing bought nothing at all against
 * the one adversary it was introduced for: anyone holding a database dump could
 * read `sha256:…` out of sensor_devices and replay it verbatim as a header,
 * forging readings for every venue we have hardware in. That is the exact
 * property flock-sensor/README.md promises the operator ("a database dump then
 * does not hand its reader the ability to forge readings").
 *
 * A presented key in digest form is therefore only ever hashed, never compared
 * literally. A real device key is opaque random material and does not look like
 * `sha256:` + 64 lowercase hex; if one somehow did, it must be rotated rather
 * than allowed to be its own stored verifier.
 */
async function findDeviceByApiKey(apiKey, filing = NO_FILING) {
  const digest = 'sha256:' + crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
  // Same parameter twice when the legacy branch is withdrawn, so the statement
  // keeps one shape and one plan — a bad key still costs what a good one costs.
  const legacy = DIGEST_FORM.test(apiKey) ? digest : apiKey;
  const result = await pool.query(INGEST_SQL, ingestParams(digest, legacy, filing));
  return result.rows[0] || null;
}

// The live broadcast, run AFTER the response has been written. It is not part
// of storing the reading and nothing the device does depends on it, so it must
// neither delay the answer nor be able to change it: a throw here used to land
// in the handler's catch and answer 500 for a reading that was already stored,
// which the device then retried as a failure. Its own try/catch, and a log line
// that says the reading is safe.
function broadcastReading(req, device, body, filing, recordedAt) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    io.to(`venue:${device.venue_place_id}`).emit('venue_sensor_update', {
      venue_place_id: device.venue_place_id,
      ir_beam_count: body.ir_beam_count,
      thermal_headcount: body.thermal_headcount,
      noise_db: body.noise_db,
      // What was STORED, not what was sent: a band dropped as out of order
      // must not reach the venue card through the live push either.
      occupancy: filing.occupancy,
      occupancy_low: filing.occupancyLow,
      occupancy_high: filing.occupancyHigh,
      dwell_minutes: filing.dwellMinutes,
      recorded_at: recordedAt,
    });
  } catch (err) {
    console.error('Sensor broadcast failed after the reading was stored:', err.message);
  }
}

/**
 * Resolve the timestamp a reading should be filed under.
 *
 * A device sends `recorded_at` only when it believes its own clock is sane (a
 * Pi has no RTC, so a freshly booted one without NTP is somewhere in the
 * 1970s). Omitting it means "file this on arrival", which is right for a live
 * push and is what every reading used to get.
 *
 * Without a client timestamp, every payload buffered during a two-hour outage
 * was stamped with its *arrival* time, so the whole outage landed in one hourly
 * bucket and the venue's history showed a crowd spike that never happened.
 *
 * A timestamp we cannot believe is refused rather than quietly rewritten to
 * server time. Rewriting is how a device that sat powered off for three days
 * would dump its stale queue into the current hour and invent a crowd.
 *
 * Returns `{ ok: false, reason }`, or `{ ok: true, recordedAt, clientSupplied }`
 * where a null `recordedAt` means "stamp it on arrival".
 */
function resolveRecordedAt(raw, nowMs) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, recordedAt: null, clientSupplied: false };
  }
  // This is the time-forgery guard, so it settles its own input rather than
  // trusting the chain in front of it to have done so. Date.parse STRINGIFIES
  // its argument, which is how the array form slipped past every rule below,
  // and how `recorded_at: 0` became Date.parse("0") — the year 2000, a real
  // instant nobody sent. Only a string can be a timestamp.
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'recorded_at is not a usable timestamp' };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return { ok: false, reason: 'recorded_at is not a usable timestamp' };
  }
  if (parsed > nowMs + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'recorded_at is in the future; check the device clock' };
  }
  if (parsed < nowMs - MAX_BACKFILL_HOURS * 3600 * 1000) {
    return { ok: false, reason: `recorded_at is more than ${MAX_BACKFILL_HOURS}h old` };
  }
  return { ok: true, recordedAt: new Date(parsed), clientSupplied: true };
}

// ---------------------------------------------------------------------------
// POST /api/sensors/data
// Pi sensor unit pushes a reading. Auth via x-api-key header (NOT JWT).
//
// The device never names its own venue — the venue is derived from the device
// row — so a device physically cannot report occupancy for somewhere it is not
// installed. If it echoes a `device_id` it must be its own; that catches a unit
// flashed with the wrong venue's key during provisioning, which otherwise
// silently attributes one bar's crowd to another forever.
// ---------------------------------------------------------------------------
// Round 20 (shape sweep). EVERY bound declared above was reachable as a
// one-element array, because express-validator coerces before it tests:
// `ir_beam_count: [10]` satisfies isInt, `noise_db: ["85.5"]` satisfies isFloat,
// `recorded_at: ["2026-…"]` satisfies isISO8601. The value then stays an array
// in req.body and node-postgres serialises it as an array literal against
// INTEGER / DECIMAL(5,2) columns — 22P02, a 500 on the one endpoint whose whole
// job is to keep answering while a Pi in a bar retries. Worse for the model:
// resolveRecordedAt's guards below all run on `raw`, and Date.parse(["…"])
// stringifies, so the clock rules were reading a shape they were never written
// for. Shape first, on every field.
//
// `dry_run` gets the same guard for a different reason. It is compared with
// `=== true`, so `dry_run: ["true"]` passed isBoolean by coercion and then read
// as FALSE — an installer's self test would silently write a fabricated "0
// people" row into the venue's live occupancy and into the model's training
// data, which is precisely what dry_run exists to prevent.
router.post('/data',
  scalarOnly(body('ir_beam_count'), 'ir_beam_count').isInt({ min: 0, max: MAX_IR_PER_READING })
    .withMessage(`ir_beam_count must be an integer 0-${MAX_IR_PER_READING}`),
  scalarOnly(body('thermal_headcount'), 'thermal_headcount').isInt({ min: 0, max: MAX_THERMAL })
    .withMessage(`thermal_headcount must be 0-${MAX_THERMAL}`),
  scalarOnly(body('noise_db'), 'noise_db').isFloat({ min: 0, max: MAX_NOISE_DB })
    .withMessage(`noise_db must be 0-${MAX_NOISE_DB}`),
  // checkFalsy, not merely nullable: main.py omits the key when the Pi's clock
  // is not yet trusted, and resolveRecordedAt has always documented `''` as
  // "stamp it on arrival" — but `optional({ nullable: true })` does not skip
  // `''`, so that documented branch was unreachable and an empty string was a
  // 400 instead. A device with no clock must never be refused; that is the
  // whole reason the field is optional.
  scalarOnly(body('recorded_at').optional({ nullable: true, checkFalsy: true }), 'recorded_at').isISO8601()
    .withMessage('recorded_at must be an ISO 8601 timestamp'),
  body('device_id').optional({ nullable: true }).isString().isLength({ min: 1, max: 100 })
    .withMessage('device_id must be 1-100 characters'),
  scalarOnly(body('dry_run').optional({ nullable: true }), 'dry_run').isBoolean().withMessage('dry_run must be a boolean'),
  // The occupancy estimate: optional and nullable, because older firmware sends
  // none of it and newer firmware sends null for what it cannot yet say. Shape
  // first, for exactly the reason every field above has it: `occupancy: [12]`
  // passes isInt by coercion and would reach an INTEGER parameter as `{12}`.
  scalarOnly(body('occupancy').optional({ nullable: true }), 'occupancy').isInt({ min: 0, max: MAX_OCCUPANCY })
    .withMessage(`occupancy must be an integer 0-${MAX_OCCUPANCY}`),
  scalarOnly(body('occupancy_low').optional({ nullable: true }), 'occupancy_low').isInt({ min: 0, max: MAX_OCCUPANCY })
    .withMessage(`occupancy_low must be an integer 0-${MAX_OCCUPANCY}`),
  scalarOnly(body('occupancy_high').optional({ nullable: true }), 'occupancy_high').isInt({ min: 0, max: MAX_OCCUPANCY })
    .withMessage(`occupancy_high must be an integer 0-${MAX_OCCUPANCY}`),
  scalarOnly(body('dwell_minutes').optional({ nullable: true }), 'dwell_minutes')
    .isInt({ min: MIN_DWELL_MINUTES, max: MAX_DWELL_MINUTES })
    .withMessage(`dwell_minutes must be an integer ${MIN_DWELL_MINUTES}-${MAX_DWELL_MINUTES}`),
  // Table monitoring: one string, shape first like every field here. Unlike
  // every field here, an error on it is NOT a 400. A 400 makes the device drop
  // the whole reading, so setTablesAside below takes this field's errors out of
  // the verdict and the reading is stored without it. The strict parse of the
  // content happens after, in readTables.
  scalarOnly(body('tables').optional({ nullable: true }), 'tables').isString()
    .isLength({ max: MAX_TABLES_LENGTH })
    .withMessage(`tables must be a string of at most ${MAX_TABLES_LENGTH} characters`),
  async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey || typeof apiKey !== 'string') {
        return res.status(401).json({ error: 'Missing x-api-key header' });
      }
      if (apiKey.length > MAX_API_KEY_LENGTH) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      // Everything below that can refuse this request WITHOUT knowing which
      // device the key belongs to is settled here, before the one statement
      // runs, so the statement knows whether it may write (see INGEST_SQL).
      // None of it is REPORTED yet: the order in which refusals are answered
      // is unchanged and starts after the statement, with authentication.
      const { errors, tablesRefused } = setTablesAside(validationResult(req));
      const claimedDeviceId = req.body.device_id;
      // Parsed only once the rest of the body has passed: a body that is about
      // to be refused stores nothing, tables included.
      const tableField = errors.length === 0
        ? readTables(req.body.tables, tablesRefused)
        : { tables: null, ignored: null };
      // The camera's looks, the same way: parsed only for a body that passed,
      // and a bad list or entry is dropped, never a 400.
      const lookField = errors.length === 0
        ? sensorCameraLooks.readCameraLooks(req.body.camera_looks, Date.now())
        : { looks: null, ignored: null };

      // An installer's self test proves the key and the network work without
      // writing a fabricated "0 people" row into the venue's live occupancy
      // figure (and, the day an exporter reads this table, the model's
      // training data). The key, the activation and the device_id are still
      // checked, so this still answers the only question the installer is
      // asking.
      //
      // Round 21: every truthy spelling isBoolean() admits, not just the JSON
      // boolean. The validator passes the STRINGS 'true' and '1' (and the
      // number 1) as readily as `true`, and a curl-driven install check sends
      // exactly those — `-d '{"dry_run":"true"}'`. Under a bare `=== true`
      // each of them validated cleanly and then read as "not a dry run", so
      // the self test wrote the fabricated zero row this branch exists to keep
      // out. Same bug as the `["true"]` array case fixed in round 20, one
      // coercion earlier.
      const dryRun = req.body.dry_run === true || req.body.dry_run === 'true'
        || req.body.dry_run === 1 || req.body.dry_run === '1';

      const nowMs = Date.now();
      // Only a body that passed validation is resolved: this is the
      // time-forgery guard and it is only ever handed a settled shape.
      const stamp = errors.length === 0 ? resolveRecordedAt(req.body.recorded_at, nowMs) : null;

      // Two DIFFERENT questions about the same timestamp, and conflating them
      // is what left the live figure writable (see MIN_LIVE_GAP_SECONDS):
      //   isBackfill        — do subscribers hear about it? (60 seconds)
      //   affectsLiveFigure — will GET /:placeId/current serve it? (15 minutes)
      // A server-stamped row is always both.
      let filing = NO_FILING;
      if (errors.length === 0 && !dryRun && stamp.ok
          // A device_id that is present but not a string can never be this
          // device's own, so it is refused below and must not write.
          && (!claimedDeviceId || typeof claimedDeviceId === 'string')) {
        const { recordedAt, clientSupplied } = stamp;
        filing = {
          claimedDeviceId: claimedDeviceId || null,
          clientSupplied,
          recordedAt,
          isBackfill: clientSupplied && recordedAt.getTime() < nowMs - BACKFILL_THRESHOLD_MS,
          affectsLiveFigure: !clientSupplied
            || recordedAt.getTime() > nowMs - CURRENT_READING_MAX_AGE_MS,
          irBeamCount: req.body.ir_beam_count,
          thermalHeadcount: req.body.thermal_headcount,
          noiseDb: req.body.noise_db,
          ...occupancyEstimate(req.body),
          tables: tableField.tables,
          ...tableCounts(tableField.tables),
        };
      }

      // Authenticate before reporting validation errors, so an unauthenticated
      // caller cannot use this endpoint to probe what shape a reading takes.
      //
      // Idempotency, the flood guard and the write all happen inside this one
      // call when `filing` allows them; INGEST_SQL carries each rule where it
      // now lives. The duplicate check still runs BEFORE the flood guard, and
      // the ORDER is still load-bearing: the guard covers the whole 15-minute
      // live window, and a row we already hold is not new data. It cannot move
      // the live figure, the hourly SUM or the training set, because nothing is
      // written for it. Charging it against the rate limit would answer an
      // honest retry 429, and a device reads 429 as "try later", so the one
      // case the check exists to serve (a push that succeeded server-side but
      // timed out on the device, retried from its buffer) would turn into a
      // back-off loop. Client-stamped timestamps make (device, recorded_at) a
      // natural key, and since migration 082 the table's unique key, so two
      // deliveries of one reading racing each other are settled by the
      // database and the second is answered as a duplicate like any other;
      // server-stamped rows need no check, NOW() differs.
      // Replaying the same stamp is useless to an attacker for the same reason:
      // no write happens either way.
      //
      // The guard is atomic because the WHERE clause, the touch and the insert
      // are the same statement, so two concurrent pushes cannot both pass it.
      // Genuinely old backfill is touched and written without the guard:
      // delivering old readings still proves the device is alive, and
      // throttling a buffer drain would stall it. A re-delivery touches too,
      // ungated, since there is no flood to guard against when nothing is
      // stored.
      const device = await findDeviceByApiKey(apiKey, filing);
      if (!device) return res.status(401).json({ error: 'Invalid API key' });
      // 403, not 401: the caller authenticated fine, it is just not allowed to
      // report. The device reads both as "I am misconfigured", backs off to one
      // attempt every half hour, and keeps its queue — so a decommissioned unit
      // goes quiet instead of hammering, and re-activating one loses nothing.
      if (!device.is_active) return res.status(403).json({ error: 'Device deactivated' });

      if (errors.length > 0) return res.status(400).json({ error: errors[0].msg });

      if (req.body.device_id && req.body.device_id !== device.device_id) {
        // Strip control characters before logging an attacker-supplied string:
        // a newline in here would let the caller forge extra log lines.
        const claimed = String(req.body.device_id).replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
        console.error(
          `Sensor device_id mismatch: key belongs to ${device.device_id}, payload claimed ${claimed}`
        );
        return res.status(403).json({ error: 'device_id does not match this API key' });
      }

      if (dryRun) {
        return res.status(200).json({ success: true, dry_run: true, device_id: device.device_id });
      }

      if (!stamp.ok) return res.status(400).json({ error: stamp.reason });

      // Every refusal above wrote nothing: each one is also a reason `filing`
      // stayed empty or `writer` matched no row. From here on the statement had
      // permission to write and says what it did.
      if (device.duplicate_of) {
        return res.status(201).json({ success: true, recorded_at: device.duplicate_of, duplicate: true });
      }

      if (!device.recorded_at) {
        // Nothing was written and it was not a duplicate, which only the flood
        // guard can cause, and only on a row the app would show as current.
        if (!filing.affectsLiveFigure) {
          throw new Error('sensor ingest wrote nothing for an unthrottled reading');
        }
        // Say HOW LONG, in the header and in the body. Without it the device
        // had to guess, and it guessed with its network backoff, which
        // escalates to fifteen minutes. See the RATE_LIMIT_STATUS branch in
        // flock-sensor/main.py. The note above MIN_LIVE_GAP_SECONDS claims a
        // throttled drain costs "about a minute of extra drain"; that is only
        // true if the device waits the gap this endpoint is actually
        // enforcing, so the endpoint has to tell it.
        res.set('Retry-After', String(MIN_LIVE_GAP_SECONDS));
        return res.status(429).json({
          error: 'Readings are arriving too fast for this device',
          retry_after_seconds: MIN_LIVE_GAP_SECONDS,
        });
      }

      // The reading is stored and committed; answer now.
      res.status(201).json({ success: true, recorded_at: device.recorded_at });

      // Only a live reading is "what is happening now". Pushing a two-hour-old
      // backfilled row to subscribers would redraw the venue card with stale
      // occupancy. After the response, and unable to change it: see
      // broadcastReading.
      if (!filing.isBackfill) broadcastReading(req, device, req.body, filing, device.recorded_at);

      // The live floor, for the venue's owner. Same window as the live figure
      // (affectsLiveFigure, not isBackfill): a reading /current would serve is
      // the newest word on the tables too, and an older one is history. Not
      // awaited, never throws: both calls log their own failures, and the
      // device already has its answer. Nothing of it reaches the public
      // broadcast above; venue:{placeId} is a room anyone can join. A live
      // reading with no tables string is a word on the floor as well: silence
      // long enough forgets the unit's rows (SILENCE in sensorTables.js). A
      // string that was sent and ignored is not silence, it is the bug the
      // log names below, and the rows stay.
      if (filing.affectsLiveFigure) {
        if (filing.tables) applyTableReading(device, filing.tables, device.recorded_at);
        else if (!tableField.ignored) applySilentReading(device, device.recorded_at);
      }

      // A tables value that was sent and dropped is said in the log, at most
      // once an hour per device, and only now: the device has its 201 and the
      // reading is stored, so nothing here can change either.
      if (tableField.ignored) {
        try {
          noteIgnoredTables(device.device_id, tableField.ignored);
        } catch (err) {
          console.error('Sensor tables note failed after the reading was stored:', err.message);
        }
      }

      // The camera's looks, for any reading newly stored (backfill included:
      // a look is history wherever it lands). Only here, past the duplicate
      // answer above, so a retried delivery never stores its looks twice.
      // Not awaited, never throws.
      if (lookField.looks) sensorCameraLooks.storeCameraLooks(device, lookField.looks);
      if (lookField.ignored) {
        try {
          sensorCameraLooks.noteIgnoredCameraLooks(device.device_id, lookField.ignored);
        } catch (err) {
          console.error('Sensor camera looks note failed after the reading was stored:', err.message);
        }
      }
    } catch (err) {
      console.error('Sensor data ingest error:', err);
      res.status(500).json({ error: 'Failed to ingest sensor data' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/current — most recent reading + recent checkins
//
// A reading is only "current" if it is recent. A device that died on Friday
// must not still be showing Friday's crowd on Sunday, so anything older than
// the staleness window reads as no sensor at all and the app hides the card.
//
// CURRENT_READING_MAX_AGE_MINUTES is declared at the top of this file, beside
// the ingest bounds, because the ingest path has to rate-limit against the same
// window this one reads. Two copies of it drifting apart is exactly how the
// live figure became writable through the backfill door.
// ---------------------------------------------------------------------------

router.get('/:placeId/current',
  authenticate,
  param('placeId').isString().isLength({ min: 1, max: 255 }).withMessage('placeId required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { placeId } = req.params;

      const reading = await pool.query(
        `SELECT venue_place_id, ir_beam_count, thermal_headcount, noise_db,
                occupancy, occupancy_low, occupancy_high, dwell_minutes,
                sensor_device_id, recorded_at
           FROM venue_sensor_data
          WHERE venue_place_id = $1
            AND recorded_at > NOW() - INTERVAL '1 minute' * $2
          ORDER BY recorded_at DESC
          LIMIT 1`,
        [placeId, CURRENT_READING_MAX_AGE_MINUTES]
      );

      // COUNT(DISTINCT user_id): one account checking in repeatedly must not
      // inflate the public "check-ins in the last hour" occupancy signal.
      const checkins = await pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS count
         FROM venue_checkins
         WHERE venue_place_id = $1 AND user_id IS NOT NULL AND created_at > NOW() - INTERVAL '1 hour'`,
        [placeId]
      );

      res.json({
        sensor_data: reading.rows[0] || null,
        recent_checkins: checkins.rows[0]?.count || 0,
      });
    } catch (err) {
      console.error('Get current sensor data error:', err);
      res.status(500).json({ error: 'Failed to fetch sensor data' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/history?hours=24 — hourly-bucketed readings for charts
// One row per hour: thermal/noise and the occupancy estimate are AVG,
// ir_beam_count is SUM. AVG skips NULLs, so an hour in which only some readings
// carried an estimate averages those, and an hour with none reads NULL (the
// app then charts thermal for it). The sum is
// beam CROSSINGS per hour, not entries: the beam fires in both directions, so
// it counts roughly two per person who comes in and leaves. Empty hours are
// omitted; frontends construct fixed-width slot arrays and treat missing
// hours as gaps.
// ---------------------------------------------------------------------------
router.get('/:placeId/history',
  authenticate,
  param('placeId').isString().isLength({ min: 1, max: 255 }).withMessage('placeId required'),
  query('hours').optional().isInt({ min: 1, max: 168 }).withMessage('hours must be 1-168'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { placeId } = req.params;
      const hours = parseInt(req.query.hours, 10) || 24;

      // LEAST(...) before the ::int cast: rows written before ir_beam_count was
      // bounded could still make an hourly SUM exceed INT32, and an overflow
      // here 500s the endpoint rather than dropping one bad bucket.
      const result = await pool.query(
        `SELECT
           date_trunc('hour', recorded_at) AS recorded_at,
           ROUND(AVG(thermal_headcount))::int AS thermal_headcount,
           LEAST(SUM(ir_beam_count), 2147483647)::int AS ir_beam_count,
           ROUND(AVG(noise_db)::numeric, 2) AS noise_db,
           ROUND(AVG(occupancy))::int AS occupancy,
           ROUND(AVG(occupancy_low))::int AS occupancy_low,
           ROUND(AVG(occupancy_high))::int AS occupancy_high,
           ROUND(AVG(dwell_minutes))::int AS dwell_minutes,
           COUNT(*)::int AS sample_count,
           -- [sum, non-null count] per averaged figure. A live reading is
           -- folded into this hour on the client (frontend/src/lib/
           -- sensorHistory.js); from the rounded average and the row count it
           -- drifted (every fold rounded away a steady change) and divided by
           -- readings that carried no value for that figure.
           json_build_object(
             'thermal_headcount', json_build_array(SUM(thermal_headcount), COUNT(thermal_headcount)),
             'noise_db', json_build_array(SUM(noise_db), COUNT(noise_db)),
             'occupancy', json_build_array(SUM(occupancy), COUNT(occupancy)),
             'occupancy_low', json_build_array(SUM(occupancy_low), COUNT(occupancy_low)),
             'occupancy_high', json_build_array(SUM(occupancy_high), COUNT(occupancy_high)),
             'dwell_minutes', json_build_array(SUM(dwell_minutes), COUNT(dwell_minutes))
           ) AS totals
         FROM venue_sensor_data
         WHERE venue_place_id = $1
           AND recorded_at >= NOW() - INTERVAL '1 hour' * $2
         GROUP BY date_trunc('hour', recorded_at)
         ORDER BY recorded_at ASC`,
        [placeId, hours]
      );

      res.json({ readings: result.rows });
    } catch (err) {
      console.error('Get sensor history error:', err);
      res.status(500).json({ error: 'Failed to fetch sensor history' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/status: is the hardware at this venue alive?
//
// `sensor_devices.last_seen_at` was written on every ingest and read by nothing.
// The only way to find out whether a deployed unit was still reporting was to
// query the production database by hand, and the app made it worse rather than
// better: both sensor cards render only when /current returns a row, so a unit
// that died on Friday does not show as offline, it silently stops existing. The
// venue owner sees an occupancy section one day and no occupancy section the
// next, with nothing anywhere saying why.
//
// Owner-scoped, not public. Whether a venue has hardware and when it last
// reported is operational detail about our fleet, and the venue's own owner is
// the person who needs it.
// ---------------------------------------------------------------------------
router.get('/:placeId/status',
  authenticate,
  param('placeId').isString().isLength({ min: 1, max: 255 }).withMessage('placeId required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { placeId } = req.params;

      // venue_profiles.user_id is UNIQUE (migration 001), so this is one row at
      // most and it is the caller's own claim on this place_id. It has to be a
      // VERIFIED claim: the partial unique index lets an unverified second claim
      // sit on a place somebody else has verified, and that claimant must not
      // learn which hardware the venue runs or whether it is online.
      const owns = await pool.query(
        'SELECT 1 FROM venue_profiles WHERE user_id = $1 AND google_place_id = $2 AND verified = true LIMIT 1',
        [req.user.id, placeId]
      );
      if (owns.rows.length === 0) {
        return res.status(403).json({ error: 'Sensor status is for the verified owner of this venue.' });
      }

      // api_key is never selected here, in either form. The digest is a
      // verifier for the legacy plaintext rows, so handing it to a browser
      // would hand back the ability to post readings for this venue.
      const devices = await pool.query(
        `SELECT device_id, device_name, is_active, last_seen_at, deployed_at,
                FLOOR(EXTRACT(EPOCH FROM (NOW() - last_seen_at)))::int AS seconds_since_last_seen,
                (last_seen_at IS NOT NULL
                  AND last_seen_at > NOW() - INTERVAL '1 minute' * $2) AS online
           FROM sensor_devices
          WHERE venue_place_id = $1
          ORDER BY device_id ASC`,
        [placeId, CURRENT_READING_MAX_AGE_MINUTES]
      );

      res.json({
        devices: devices.rows,
        // The window the app's own occupancy card uses, so a client never has
        // to hardcode a second copy of it and watch the two drift apart.
        online_within_minutes: CURRENT_READING_MAX_AGE_MINUTES,
      });
    } catch (err) {
      console.error('Get sensor status error:', err);
      res.status(500).json({ error: 'Failed to fetch sensor status' });
    }
  }
);

// ---------------------------------------------------------------------------
// TABLE MONITORING, the owner's side: the live floor, tables in use by hour,
// the turn and wait figures, the waits by party size, the incoming plans laid
// over the floor, and the owner's two switches. Then the public summary.
//
// The owner's routes are for the venue's VERIFIED owner and nobody else, the
// gate /status uses and for the same reason: what a venue's tables are doing
// is that business's own operational detail. None of them returns anything
// about a person. The floor comes from sensor_table_states (written by
// services/sensorTables.js after each live reading), the hours from the four
// counts each reading carries (migration 130), and everything with a
// "likely" or a median in it from the seatings (migration 131), all through
// services/tableHistory.js.
// ---------------------------------------------------------------------------

// The /status gate, shared by both table routes: is the caller's claim on this
// place a VERIFIED one. One row at most, as there. An unverified claim can sit
// on a place somebody else has verified, and it is told nothing.
async function isVerifiedOwner(callerId, placeId) {
  const owns = await pool.query(
    'SELECT 1 FROM venue_profiles WHERE user_id = $1 AND google_place_id = $2 AND verified = true LIMIT 1',
    [callerId, placeId]
  );
  return owns.rows.length > 0;
}

const NOT_THE_OWNER = { error: 'Table monitoring is for the verified owner of this venue.' };

// THE PLAN. The Tables tab is a Roost feature, and a gate that lives only in
// the dashboard is one any client can walk past, so these routes ask too. In
// this order: signed out is 401 (authenticate), not the verified owner is 403
// with nothing about the place in it, and only then the plan, through the
// same decision requireVenueTier makes (services/venueEntitlements.js
// checkVenueTier). So with venue billing off every verified owner is through,
// and a plan lookup that FAILED is the gate's retryable refusal, never read as
// "not on the plan".
//
// Below Roost the refusal is the gate's own body plus `has_tables`: whether
// any unit at this place has written table rows. That one bit lets the
// dashboard show the lock to a free venue that has tables, and an empty state
// to one that has none, without being sent a single table.
const HAS_TABLES_SQL = `SELECT 1 FROM sensor_table_states WHERE venue_place_id = $1 LIMIT 1`;

// Resolves to null when the caller may read tables, or to the 403 body.
async function tablesPlanRefusal(callerId, placeId) {
  const plan = await checkVenueTier(callerId, 'pro');
  if (plan.ok) return null;
  if (plan.unavailable) return plan.body;
  const has = await pool.query(HAS_TABLES_SQL, [placeId]);
  return { ...plan.body, has_tables: has.rows.length > 0 };
}

// The owner's gate for the Roost table routes, in the order the note above
// gives: a bad place id is a 400 before anything is read, a caller who is not
// the verified owner is told so and nothing else, and only then the plan.
// Resolves to true when the handler may go on; otherwise the refusal has been
// written.
async function ownerMayReadTables(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: errors.array()[0].msg });
    return false;
  }
  const { placeId } = req.params;
  if (!(await isVerifiedOwner(req.user.id, placeId))) {
    res.status(403).json(NOT_THE_OWNER);
    return false;
  }
  const refusal = await tablesPlanRefusal(req.user.id, placeId);
  if (refusal) {
    res.status(403).json(refusal);
    return false;
  }
  return true;
}

// Every owner table route names its place the same way.
const placeIdParam = () => param('placeId').isString().isLength({ min: 1, max: 255 }).withMessage('placeId required');

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/tables: what each table is doing now.
//
// { tables: [{ number, people, state, since, seats, party_max,
//   likely_free_at, updated_at, stale }], updated_at, stale, next_free }, tables in number
// order. state is a word (free, seated, waiting, needs_clearing), since is
// when that state began, seats is the unit's own count (null when it never
// sent one), party_max the largest party seen at the table in 30 days (null
// when none), kept apart so an estimate is never printed as a capacity, and
// likely_free_at is, for a seated or waiting table, when its party sat plus
// the median turn for that weekday and hour over 28 days (null without enough
// history, and for a table with no party). A floor not refreshed for
// TABLES_STALE_AFTER_MINUTES is reported stale and still shown, every unit's
// rows included. With no rows at all: no tables, no time, stale, nothing next.
// ---------------------------------------------------------------------------
router.get('/:placeId/tables',
  authenticate,
  placeIdParam(),
  async (req, res) => {
    try {
      if (!(await ownerMayReadTables(req, res))) return;
      res.json(await tableHistory.ownerFloor(req.params.placeId));
    } catch (err) {
      console.error('Get table floor error:', err);
      res.status(500).json({ error: 'Failed to fetch tables' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/tables/hours: tables in use by hour, last 7 days.
//
// { hours: [{ hour, occupied, total }], timeZone }, oldest first: one row per
// hour that has at least one reading with tables, occupied the average count
// of tables with a party at them (one decimal), total the tables watched that
// hour. The hours are absolute instants; the browser folds them into averages
// by local hour of day. timeZone is the venue's IANA zone when the server
// knows it (the corpus row, services/tableHistory.js) and null when it does
// not, so the dashboard can fold on the venue's clock where it has nothing
// better and say which clock it used. Readings with no tables (older
// firmware, an ignored string) are left out rather than counted as an empty
// floor.
//
// EACH UNIT FIRST, THEN THE UNITS ADDED. Each reading counts one unit's
// tables, so a venue with two units has two readings a minute that describe
// different rooms. Averaged together they described neither: twelve tables
// with nine in use beside six with one read as 5 of 12, when the room has 10
// of 18. So each unit's hour is averaged on its own (and its total is the
// most tables it watched), and the units' figures are added. With one unit
// the answer is exactly what it always was. Rounded once, after the sum, so
// per-unit rounding cannot add up.
// ---------------------------------------------------------------------------
const TABLE_HOURS_SQL = `
  SELECT hour,
         ROUND(SUM(occupied), 1) AS occupied,
         SUM(total) AS total
    FROM (
      SELECT date_trunc('hour', recorded_at) AS hour,
             sensor_device_id,
             AVG(tables_occupied)::numeric AS occupied,
             MAX(tables_total) AS total
        FROM venue_sensor_data
       WHERE venue_place_id = $1
         AND recorded_at >= NOW() - INTERVAL '7 days'
         AND tables_total > 0
       GROUP BY 1, 2
    ) per_unit
   GROUP BY hour
   ORDER BY hour`;

router.get('/:placeId/tables/hours',
  authenticate,
  placeIdParam(),
  async (req, res) => {
    try {
      if (!(await ownerMayReadTables(req, res))) return;
      const { placeId } = req.params;
      const [result, timeZone] = await Promise.all([
        pool.query(TABLE_HOURS_SQL, [placeId]),
        tableHistory.venueTimeZone(placeId),
      ]);
      res.json({
        hours: result.rows.map((r) => ({
          hour: new Date(r.hour).toISOString(),
          // numeric arrives from pg as a string, so the chart is handed numbers.
          occupied: Number(r.occupied),
          total: Number(r.total),
        })),
        timeZone,
      });
    } catch (err) {
      console.error('Get table hours error:', err);
      res.status(500).json({ error: 'Failed to fetch table hours' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/tables/camera-looks?day=YYYY-MM-DD: how often the
// table camera looked on one day, today unless asked.
//
// { day, timeZone, count, looks: [{ at, received_at, look, table, result,
// found }] }, newest first, at most 500 listed and count always the whole
// day's. The day is the venue's own when the server knows its zone (the same
// lookup /tables/hours uses) and UTC otherwise, timeZone saying which (null
// for UTC). at is null for a look taken while the unit's clock was unsynced,
// which is then placed by received_at. Every field is a word or a number from
// services/sensorCameraLooks.js; there is no picture to return.
// ---------------------------------------------------------------------------
router.get('/:placeId/tables/camera-looks',
  authenticate,
  placeIdParam(),
  scalarOnly(query('day').optional(), 'day').matches(/^\d{4}-\d{2}-\d{2}$/).isISO8601({ strict: true })
    .withMessage('day must be a date, YYYY-MM-DD'),
  async (req, res) => {
    try {
      if (!(await ownerMayReadTables(req, res))) return;
      const { placeId } = req.params;
      const zone = await tableHistory.venueTimeZone(placeId);
      res.json(await sensorCameraLooks.cameraLooksDay(placeId, req.query.day || null, zone));
    } catch (err) {
      console.error('Get camera looks error:', err);
      res.status(500).json({ error: 'Failed to fetch camera looks' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/tables/stats?days=28: the turn, wait and clear
// figures over the last 7 to 90 days (28 unless asked).
//
// { days, seatings, turn_minutes: { median, by_hour: [{ dow, hour, median,
//   seatings }] }, waited_share, clear_minutes_median, full_hours: [{ dow,
//   hour, share }], timeZone }. A turn is a party's time at a table, a clear
// the time from its leaving to the table cleared, waited_share the share of
// seatings whose party waited past the unit's wait limit, and full_hours the
// hours of the week when every table was in use in at least half the
// readings, counted only once an hour has readings on four dates and ten in
// all (services/tableHistory.js says why; a window under four weeks has
// none). dow is 0-6 (0 Sunday) and hour 0-23 on the venue's zone when the
// server knows it, else UTC, and timeZone is then null (the IANA name
// otherwise, as /tables/hours says it). Every median and the share are null
// under twenty closed seatings (services/tableHistory.js says why), so the
// dashboard can say "not yet known" instead of a number built on six tables.
// ---------------------------------------------------------------------------
router.get('/:placeId/tables/stats',
  authenticate,
  placeIdParam(),
  scalarOnly(query('days').optional(), 'days').isInt({ min: tableHistory.STATS_DAYS_MIN, max: tableHistory.STATS_DAYS_MAX })
    .withMessage(`days must be ${tableHistory.STATS_DAYS_MIN}-${tableHistory.STATS_DAYS_MAX}`),
  async (req, res) => {
    try {
      if (!(await ownerMayReadTables(req, res))) return;
      const days = parseInt(req.query.days, 10) || tableHistory.TURN_WINDOW_DAYS;
      res.json(await tableHistory.tableStats(req.params.placeId, days));
    } catch (err) {
      console.error('Get table stats error:', err);
      res.status(500).json({ error: 'Failed to fetch table stats' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/tables/waits: how long a party waits, by size.
//
// { updated_at, stale, by_party: [{ party, open_now, minutes, table }] } for
// parties of 2, 4, 6 and 8, over the tables of the units heard from inside
// the stale window. A table fits a party when its seats (the unit's count,
// else the largest party seen there) are at least the party; a table with
// neither fits up to four and above that nobody knows. open_now is true when
// a free table is known to fit, with minutes 0 and that table's number; null
// when tables are free but none is known to fit and one might, with minutes
// null and table the lowest such table; else false, with minutes until the
// soonest likely_free_at among the seated tables known to fit and that
// table's number, both null when no such table or no turn-time history yet.
// updated_at and stale are the floor's.
// ---------------------------------------------------------------------------
router.get('/:placeId/tables/waits',
  authenticate,
  placeIdParam(),
  async (req, res) => {
    try {
      if (!(await ownerMayReadTables(req, res))) return;
      res.json(await tableHistory.tableWaits(req.params.placeId));
    } catch (err) {
      console.error('Get table waits error:', err);
      res.status(500).json({ error: 'Failed to fetch table waits' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/tables/incoming: the plans coming to the venue,
// each with the table that best fits it.
//
// { flocks: [{ id, event_time, status, party, suggestion }] }: the flocks and
// party are exactly what GET /api/venue-dashboard/incoming-flocks computes,
// through the same statement (services/incomingFlocks.js: a plan's id, time,
// status and accepted count, never its name, a member or any user text).
// suggestion is { table, free_now, likely_free_at } for a free table that
// fits the party (the lowest number), else the fitting seated table likely
// free soonest before the plan's time, else null.
// ---------------------------------------------------------------------------
router.get('/:placeId/tables/incoming',
  authenticate,
  placeIdParam(),
  async (req, res) => {
    try {
      if (!(await ownerMayReadTables(req, res))) return;
      res.json(await tableHistory.tableIncoming(req.params.placeId));
    } catch (err) {
      console.error('Get table incoming error:', err);
      res.status(500).json({ error: 'Failed to fetch incoming plans' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET and PUT /api/sensors/:placeId/tables/settings: the owner's two switches.
//
// { show_in_app, alerts }: whether the venue's tables are shown in the Flock
// app (venue_profiles.tables_in_app, migration 131) and whether the owner is
// pushed when a table starts waiting or needs clearing (notification_prefs
// key `tables`, the switch services/sensorTables.js reads before every
// alert). Both default to true. NOT behind the plan gate, on purpose: a free
// venue with tables may hide them from the app, and may silence alerts it is
// not sent anyway. The verified owner only, decided by the statement itself:
// no row for the caller and the place is the owner refusal.
//
// The PUT takes either switch or both, each a boolean; a body naming neither
// is a 400, and a switch left out is left alone.
// ---------------------------------------------------------------------------
router.get('/:placeId/tables/settings',
  authenticate,
  placeIdParam(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      const settings = await tableHistory.readTableSettings(req.user.id, req.params.placeId);
      if (!settings) return res.status(403).json(NOT_THE_OWNER);
      res.json(settings);
    } catch (err) {
      console.error('Get table settings error:', err);
      res.status(500).json({ error: 'Failed to fetch table settings' });
    }
  }
);

// A switch the chain admitted (isBoolean strict: the JSON booleans only, so a
// form's "true" or a 1 is refused rather than guessed at) as the boolean to
// store, or null for a switch the body left out.
function switchValue(v) {
  if (v === undefined || v === null) return null;
  return v === true;
}

router.put('/:placeId/tables/settings',
  authenticate,
  placeIdParam(),
  scalarOnly(body('show_in_app').optional({ nullable: true }), 'show_in_app').isBoolean({ strict: true })
    .withMessage('show_in_app must be true or false'),
  scalarOnly(body('alerts').optional({ nullable: true }), 'alerts').isBoolean({ strict: true })
    .withMessage('alerts must be true or false'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      const showInApp = switchValue(req.body.show_in_app);
      const alerts = switchValue(req.body.alerts);
      if (showInApp === null && alerts === null) {
        return res.status(400).json({ error: 'Send show_in_app or alerts, true or false.' });
      }
      const settings = await tableHistory.writeTableSettings(req.user.id, req.params.placeId, { showInApp, alerts });
      if (!settings) return res.status(403).json(NOT_THE_OWNER);
      res.json(settings);
    } catch (err) {
      console.error('Put table settings error:', err);
      res.status(500).json({ error: 'Failed to save table settings' });
    }
  }
);

// ---------------------------------------------------------------------------
// THE PUBLIC SUMMARY: what the Flock app may know about a venue's tables.
//
// Any signed-in user. { open, total, party, fits_now, wait_minutes,
// busy_hours: [{ dow, hour }], timeZone, updated_at, stale }: how many tables
// are free of how many (the units heard from inside the stale window),
// whether a party of `party` (1-30, 2 unless asked) can sit now (true, false,
// or null when tables are free but none is known to seat the party and one
// might), how long it likely waits otherwise (null without history, and null
// whenever fits_now is not false), the hours of the week the tables are
// usually all taken (the stats route's full_hours over 28 days, dow and hour
// only) and the IANA zone those hours are on, null when they are UTC. NEVER a
// table number, a per-table state or a unit id: the app is read by everyone,
// and which table a party is at is the owner's business. A venue with no
// fresh floor (none inside 24 hours) and a venue whose owner turned "show
// tables in the Flock app" off are both a 404 in the same words, so the two
// cannot be told apart from outside. Rate limited in server.js
// (tablesPublicLimiter), like the other public venue reads.
//
// POST /api/sensors/tables/summaries takes { place_ids: [1-50], party } and
// answers { summaries: { <placeId>: <the same shape> } }, with the venues
// that have no summary simply absent: one read of the floors and one of the
// busy hours across every id, never one per venue (services/tableHistory.js).
// ---------------------------------------------------------------------------
const NO_TABLE_DATA = { error: 'No table data for this venue.' };

const partyQuery = () => scalarOnly(query('party').optional({ nullable: true }), 'party')
  .isInt({ min: 1, max: tableHistory.PUBLIC_PARTY_MAX })
  .withMessage(`party must be 1-${tableHistory.PUBLIC_PARTY_MAX}`);

router.get('/:placeId/tables/summary',
  authenticate,
  placeIdParam(),
  partyQuery(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      const { placeId } = req.params;
      const party = parseInt(req.query.party, 10) || tableHistory.PUBLIC_PARTY_DEFAULT;
      const summaries = await tableHistory.publicSummaries([placeId], party);
      if (!Object.prototype.hasOwnProperty.call(summaries, placeId)) return res.status(404).json(NO_TABLE_DATA);
      res.json(summaries[placeId]);
    } catch (err) {
      console.error('Get table summary error:', err);
      res.status(500).json({ error: 'Failed to fetch table summary' });
    }
  }
);

router.post('/tables/summaries',
  authenticate,
  body('place_ids').isArray({ min: 1, max: tableHistory.SUMMARIES_MAX_PLACES })
    .withMessage(`place_ids must be an array of 1-${tableHistory.SUMMARIES_MAX_PLACES} place ids`),
  body('place_ids.*').isString().isLength({ min: 1, max: 255 }).withMessage('each place id must be a string'),
  scalarOnly(body('party').optional({ nullable: true }), 'party')
    .isInt({ min: 1, max: tableHistory.PUBLIC_PARTY_MAX })
    .withMessage(`party must be 1-${tableHistory.PUBLIC_PARTY_MAX}`),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      const party = parseInt(req.body.party, 10) || tableHistory.PUBLIC_PARTY_DEFAULT;
      res.json({ summaries: await tableHistory.publicSummaries(req.body.place_ids, party) });
    } catch (err) {
      console.error('Post table summaries error:', err);
      res.status(500).json({ error: 'Failed to fetch table summaries' });
    }
  }
);

module.exports = router;
