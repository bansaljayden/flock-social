const express = require('express');
const crypto = require('crypto');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
// Shape before content — see validators/shape.js. Nothing a sensor sends is
// ever legitimately structured.
const { scalarOnly } = require('../validators/shape');

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
// Every parameter keeps ONE type through the statement ($4, $6 and $7 are each
// used twice, with the same cast both times): __tests__/sqlParameterTypes.test.js
// prepares this against a migrated Postgres, and a parameter deduced two ways
// is refused outright (42P08) with any input at all.
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
      (venue_place_id, ir_beam_count, thermal_headcount, noise_db, sensor_device_id, recorded_at)
    SELECT w.venue_place_id, $9::integer, $10::integer, $11::numeric, w.device_id,
           COALESCE($6::timestamptz, NOW())
      FROM writer w
     WHERE NOT EXISTS (SELECT 1 FROM dup)
       AND (NOT $7::boolean OR EXISTS (SELECT 1 FROM touch))
    RETURNING recorded_at
  )
  SELECT d.id, d.device_id, d.venue_place_id, d.is_active,
         (SELECT recorded_at FROM dup) AS duplicate_of,
         (SELECT recorded_at FROM ins) AS recorded_at
    FROM device d`;

// What the statement is told when this request must not write: nothing but the
// key. The guard interval is still a real interval so $8 always binds cleanly.
const NO_FILING = null;

function ingestParams(digest, legacy, filing) {
  const gap = `${MIN_LIVE_GAP_SECONDS} seconds`;
  if (!filing) return [digest, legacy, false, null, false, null, false, gap, null, null, null];
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
  ];
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
function broadcastReading(req, device, body, recordedAt) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    io.to(`venue:${device.venue_place_id}`).emit('venue_sensor_update', {
      venue_place_id: device.venue_place_id,
      ir_beam_count: body.ir_beam_count,
      thermal_headcount: body.thermal_headcount,
      noise_db: body.noise_db,
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
      const errors = validationResult(req);
      const claimedDeviceId = req.body.device_id;

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
      const stamp = errors.isEmpty() ? resolveRecordedAt(req.body.recorded_at, nowMs) : null;

      // Two DIFFERENT questions about the same timestamp, and conflating them
      // is what left the live figure writable (see MIN_LIVE_GAP_SECONDS):
      //   isBackfill        — do subscribers hear about it? (60 seconds)
      //   affectsLiveFigure — will GET /:placeId/current serve it? (15 minutes)
      // A server-stamped row is always both.
      let filing = NO_FILING;
      if (errors.isEmpty() && !dryRun && stamp.ok
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
      // natural key; server-stamped rows need no check, NOW() differs.
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

      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

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
      if (!filing.isBackfill) broadcastReading(req, device, req.body, device.recorded_at);
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
// One row per hour: thermal/noise are AVG, ir_beam_count is SUM. The sum is
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
           COUNT(*)::int AS sample_count
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
      // most and it is the caller's own claim on this place_id.
      const owns = await pool.query(
        'SELECT 1 FROM venue_profiles WHERE user_id = $1 AND google_place_id = $2 LIMIT 1',
        [req.user.id, placeId]
      );
      if (owns.rows.length === 0) {
        return res.status(403).json({ error: 'This is not your venue' });
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

module.exports = router;
