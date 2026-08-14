const express = require('express');
const crypto = require('crypto');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Ingest bounds
//
// The Pi is untrusted hardware: it sits in a bar, on someone else's wifi, and
// anyone who walks off with it owns its API key. Everything it claims is
// therefore clamped here, because these rows are the public "Live Occupancy"
// figure and a ground-truth source for the crowd model. A wrong reading is a
// wrong number shown to a user.
// ---------------------------------------------------------------------------

// One IR beam break per ~500ms is the physical ceiling of the hardware, so
// even a 60s interval cannot honestly produce more than ~120. 10k leaves an
// enormous margin while making integer overflow of the hourly SUM impossible
// (the history endpoint sums these; an unbounded INT32 used to be able to
// overflow that SUM and 500 the endpoint for a venue permanently).
const MAX_IR_PER_READING = 10000;
// MLX90640 sees a doorway, not a stadium.
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
const BACKFILL_THRESHOLD_MS = 60 * 1000;
// Minimum spacing between accepted LIVE rows from one device. Live pushes are
// ~30s apart so this never fires in normal operation; it exists so a stolen key
// or a runaway loop cannot drive the figure the app is showing right now.
//
// It deliberately does not apply to backfill. A device draining a two-hour
// buffer sends as fast as the round trips allow, and rate-limiting that would
// stall the drain — the device reads 429 as "try later", backs off, and never
// catches up. Backfill is bounded instead by the (device, recorded_at) dedupe
// below, by the 48h window, and by the per-IP limiter in server.js. The
// residual risk is that someone holding a stolen key can write plausible-looking
// history for the one venue they stole the hardware from; they cannot move the
// live figure, because that still needs a live-stamped reading.
const MIN_LIVE_GAP_SECONDS = 2;
// A key longer than this is not one of ours; don't hand it to the database.
const MAX_API_KEY_LENGTH = 512;

/**
 * Look up a sensor device by presented API key.
 *
 * Keys may be stored either as the raw key (legacy rows) or as
 * `sha256:<hex>` of the key. The hashed form is preferred: a database dump
 * then does not hand the reader the ability to forge readings for every
 * venue we have hardware in. Both forms are accepted so keys can be migrated
 * without a fleet re-flash.
 *
 * Both candidates go into a single indexed lookup, so a bad key costs the
 * same as a good one.
 */
async function findDeviceByApiKey(apiKey) {
  const digest = 'sha256:' + crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
  const result = await pool.query(
    `SELECT id, device_id, venue_place_id, is_active
       FROM sensor_devices
      WHERE api_key = $1 OR api_key = $2
      LIMIT 1`,
    [digest, apiKey]
  );
  return result.rows[0] || null;
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
router.post('/data',
  body('ir_beam_count').isInt({ min: 0, max: MAX_IR_PER_READING })
    .withMessage(`ir_beam_count must be an integer 0-${MAX_IR_PER_READING}`),
  body('thermal_headcount').isInt({ min: 0, max: MAX_THERMAL })
    .withMessage(`thermal_headcount must be 0-${MAX_THERMAL}`),
  body('noise_db').isFloat({ min: 0, max: MAX_NOISE_DB })
    .withMessage(`noise_db must be 0-${MAX_NOISE_DB}`),
  body('recorded_at').optional({ nullable: true }).isISO8601()
    .withMessage('recorded_at must be an ISO 8601 timestamp'),
  body('device_id').optional({ nullable: true }).isString().isLength({ min: 1, max: 100 })
    .withMessage('device_id must be 1-100 characters'),
  body('dry_run').optional().isBoolean().withMessage('dry_run must be a boolean'),
  async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey || typeof apiKey !== 'string') {
        return res.status(401).json({ error: 'Missing x-api-key header' });
      }
      if (apiKey.length > MAX_API_KEY_LENGTH) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      // Authenticate before reporting validation errors, so an unauthenticated
      // caller cannot use this endpoint to probe what shape a reading takes.
      const device = await findDeviceByApiKey(apiKey);
      if (!device) return res.status(401).json({ error: 'Invalid API key' });
      // 403, not 401: the caller authenticated fine, it is just not allowed to
      // report. The device reads both as "I am misconfigured", backs off to one
      // attempt every half hour, and keeps its queue — so a decommissioned unit
      // goes quiet instead of hammering, and re-activating one loses nothing.
      if (!device.is_active) return res.status(403).json({ error: 'Device deactivated' });

      const errors = validationResult(req);
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

      // An installer's self test proves the key and the network work without
      // writing a fabricated "0 people" row into the venue's live occupancy and
      // the model's training data. Everything above has already run, so this
      // still answers the only question the installer is asking.
      if (req.body.dry_run === true) {
        return res.status(200).json({ success: true, dry_run: true, device_id: device.device_id });
      }

      const nowMs = Date.now();
      const stamp = resolveRecordedAt(req.body.recorded_at, nowMs);
      if (!stamp.ok) return res.status(400).json({ error: stamp.reason });
      const { recordedAt, clientSupplied } = stamp;
      const isBackfill = clientSupplied && recordedAt.getTime() < nowMs - BACKFILL_THRESHOLD_MS;

      if (isBackfill) {
        // Delivering old readings still proves the device is alive.
        await pool.query('UPDATE sensor_devices SET last_seen_at = NOW() WHERE id = $1', [device.id]);
      } else {
        // Flood guard on the live stream. Atomic: the WHERE clause and the
        // write are the same statement, so two concurrent pushes cannot both
        // pass it.
        const touch = await pool.query(
          `UPDATE sensor_devices
              SET last_seen_at = NOW()
            WHERE id = $1
              AND (last_seen_at IS NULL OR last_seen_at <= NOW() - $2::interval)
            RETURNING id`,
          [device.id, `${MIN_LIVE_GAP_SECONDS} seconds`]
        );
        if (touch.rowCount === 0) {
          return res.status(429).json({ error: 'Readings are arriving too fast for this device' });
        }
      }

      // Idempotency. A push that succeeded server-side but timed out on the
      // device gets retried from the buffer; without this the entry count is
      // silently doubled. Client-stamped timestamps make (device, recorded_at)
      // a natural key. Server-stamped rows need no check — NOW() differs.
      if (clientSupplied) {
        const dup = await pool.query(
          `SELECT recorded_at FROM venue_sensor_data
            WHERE sensor_device_id = $1 AND recorded_at = $2
            LIMIT 1`,
          [device.device_id, recordedAt]
        );
        if (dup.rows.length > 0) {
          return res.status(201).json({ success: true, recorded_at: dup.rows[0].recorded_at, duplicate: true });
        }
      }

      const { ir_beam_count, thermal_headcount, noise_db } = req.body;
      const insert = await pool.query(
        `INSERT INTO venue_sensor_data
          (venue_place_id, ir_beam_count, thermal_headcount, noise_db, sensor_device_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
         RETURNING recorded_at`,
        [device.venue_place_id, ir_beam_count, thermal_headcount, noise_db, device.device_id, recordedAt]
      );
      const recorded_at = insert.rows[0].recorded_at;

      // Only a live reading is "what is happening now". Pushing a two-hour-old
      // backfilled row to subscribers would redraw the venue card with stale
      // occupancy.
      const io = req.app.get('io');
      if (io && !isBackfill) {
        io.to(`venue:${device.venue_place_id}`).emit('venue_sensor_update', {
          venue_place_id: device.venue_place_id,
          ir_beam_count,
          thermal_headcount,
          noise_db,
          recorded_at,
        });
      }

      res.status(201).json({ success: true, recorded_at });
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
// ---------------------------------------------------------------------------
const CURRENT_READING_MAX_AGE_MINUTES = 15;

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
// One row per hour: thermal/noise are AVG, ir_beam_count is SUM (cumulative entries
// per hour). Empty hours are omitted — frontends construct fixed-width slot arrays
// and treat missing hours as gaps.
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

module.exports = router;
