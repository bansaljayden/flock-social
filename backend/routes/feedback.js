// ---------------------------------------------------------------------------
// Post-hangout venue feedback.
//
// This is a DATA-INTEGRITY surface, not just a form. Rows written here are read
// back by:
//   - routes/crowd.js        live calibration of the score users are shown
//   - services/mlPredictor.js per-venue error correction
//   - scripts/ml/train/export_training_data.js  training features
//   - GET /venue/:placeId below (the public per-venue numbers)
// A fabricated row therefore does not just sit in a table, it moves a number a
// user is asked to trust. Everything in this file exists to keep that honest.
//
// Trust model, stated plainly:
//   * Every authenticated user may SUBMIT. Submission is cheap on purpose —
//     refusing honest reports is how you end up with no corpus at all.
//   * Only rows we can tie to evidence of presence are marked `verified`, and
//     ONLY verified rows are allowed to move any number anyone else sees. The
//     unverified rows are kept for the submitter's own UX and for later
//     analysis; they are excluded at every read, not merely flagged.
//   * What "evidence" means is deliberately narrow — see VERIFIED_PRESENCE_SQL.
//
// KNOWN LIMIT, stated so it is not mistaken for a solved problem:
// `predicted_score` is what the CLIENT says we predicted, and it is the
// baseline the calibration error is measured against (services/mlPredictor.js
// averages `mapped(crowd_level) - predicted_score`; the training export ships
// the same figure as a feature). Nothing here can check it, because the server
// keeps no record of the score it handed that device. A verified account can
// therefore bias the correction within 0-100, bounded only by the hourly cap
// and the one-row-per-venue-per-2h rule. Closing it properly means the server
// issuing a signed prediction token that this route validates, or dropping the
// client value and re-deriving the prediction here — both of which reach into
// routes/crowd.js and services/mlPredictor.js.
// ---------------------------------------------------------------------------
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const { isPlaceIdShaped } = require('../utils/places');

const router = express.Router();
router.use(authenticate);

// flock_id lands in an INTEGER (int4) column. `isInt()` with no ceiling let
// 2147483648 through, and Postgres answered 22003 ("integer out of range"),
// which the catch below turned into a 500. A value the schema cannot hold is a
// client mistake: it must be a 400.
const INT4_MAX = 2147483647;

// Advisory-lock namespace for this route. pg_advisory_xact_lock(int4, int4) —
// users.id is a SERIAL, so it always fits.
//
// The rest of the codebase uses the one-argument hashtext('domain:id') form.
// This is a deliberate divergence, not drift: the two-int form and the
// one-bigint form occupy SEPARATE advisory-lock key spaces in Postgres, so
// there is no cross-route collision either way, and an exact (namespace, id)
// pair cannot collide with another user the way a 32-bit hash of a string can.
const FEEDBACK_LOCK_NAMESPACE = 81422;

const MAX_REPORTS_PER_HOUR = 10;

// Sentinel used to unwind the transaction for a REFUSAL (not an error), so the
// rollback and client.release() live in exactly one place. Returning a response
// from inside the try instead would work, but every future edit would have to
// remember to roll back first — this cannot be forgotten.
class Rollback extends Error {}

// ---------------------------------------------------------------------------
// Scalar guard — runs BEFORE the express-validator chain.
//
// express-validator 7 treats an ARRAY field as a list of values to validate
// individually, so an EMPTY array validates vacuously: `{ crowd_level: [] }`
// satisfies `body('crowd_level').isInt({ min: 1, max: 3 })` with no error, and
// the raw array is left in req.body untouched (sanitisers do not write back
// over arrays either). node-postgres then serialises it as the array literal
// '{}', Postgres rejects it for a SMALLINT column with 22P02, and the catch
// turns that into a 500. `{ venue_name: [] }` slips past a `min: 1` length
// check the same way, so "required" was not required.
//
// This cannot be fixed inside the chain: a .custom() link is skipped for an
// empty array for exactly the same reason. It has to be a gate in front.
//
// Every field this route reads is a single scalar, and nothing it accepts is
// ever legitimately an object or an array. The check is over EVERY key present
// in the body rather than a list of known fields on purpose: a list would have
// to be kept in step with the validator chain by hand, and the day it drifts is
// the day the hole reopens silently. Unknown fields are ignored by the route
// anyway, so refusing a structured one costs nothing.
// ---------------------------------------------------------------------------
function requireScalarFields(req, res, next) {
  const body = req.body;
  if (body === null || body === undefined) return next(); // validators will 400 on the missing required fields
  if (typeof body !== 'object') return next();
  for (const [field, value] of Object.entries(body)) {
    if (value !== null && typeof value === 'object') {
      return res.status(400).json({ error: `${field} must be a single value` });
    }
  }
  return next();
}

// ---------------------------------------------------------------------------
// Venue-local clock
//
// day_of_week / hour are BUCKET KEYS, not timestamps: routes/crowd.js looks
// feedback up with `day_of_week = $localDay AND hour BETWEEN $localHour-1 AND
// $localHour+1`, where localDay/localHour are the VENUE's wall clock.
//
// This used to be written with EXTRACT(DOW/HOUR FROM NOW()) — the database
// server's clock, which is UTC on Railway. A 9pm Friday report in Austin was
// filed as Saturday 02:00, so the Friday-night lookup never found it and the
// Saturday-small-hours lookup found a crowd level from a completely different
// part of the week. The calibration was not missing, it was wrong, which is
// worse. Same for the byDayOfWeek breakdown below.
//
// Resolution order:
//   1. ml_venues.timezone for this place id — our own curated data, so it beats
//      anything the client says.
//   2. local_day / local_hour from the request body. Client-supplied and
//      therefore spoofable within 0-6 / 0-23; accepted because the READ side
//      (routes/crowd.js) is already keyed off the same device's clock, so
//      agreeing with it is what makes calibration line up at all. The blast
//      radius is bounded by everything else in this file: only verified rows
//      are ever read, and a user gets MAX_REPORTS_PER_HOUR of them.
//   3. The server clock, as before — the honest last resort, logged as such.
//
// Rows written before this fix are still bucketed in UTC and cannot be
// corrected from here; they need a backfill keyed on created_at + timezone.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function venueLocalDayHour(timeZone, at) {
  if (!timeZone || typeof timeZone !== 'string') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      weekday: 'short',
      hour: 'numeric',
    }).formatToParts(at);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const rawHour = parts.find((p) => p.type === 'hour')?.value;

    const day = WEEKDAY_INDEX[weekday];
    let hour = parseInt(rawHour, 10);
    // Some ICU builds render midnight as "24" under hour12:false.
    if (hour === 24) hour = 0;

    if (!Number.isInteger(day) || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    return { day, hour, source: 'venue' };
  } catch {
    // An unknown/garbage zone throws RangeError. Fall through to the next
    // source rather than 500-ing a feedback submission over a timezone string.
    return null;
  }
}

// ---------------------------------------------------------------------------
// What counts as evidence that the user was actually at the venue.
//
// Two signals, both of which the product genuinely produces:
//
//   1. An HMAC-SIGNED NFC tap. routes/checkin.js only stores checkin_source
//      'nfc' when the tap URL carries a valid signature under NFC_TAG_SECRET;
//      an unsigned URL visit is stored as 'nfc_unverified'. This is an
//      ALLOWLIST (= 'nfc'), not a blocklist: the older `<> 'manual'` shape
//      would have trusted 'nfc_unverified' and 'gps', both of which are
//      self-asserted.
//
//   2. Membership in a flock that met at this venue around now, with three
//      qualifiers that are the difference between evidence and a formality:
//        - status = 'accepted' (an ignored invite is not attendance);
//        - the flock is not 'cancelled' — a cancelled flock is an explicit
//          "we did not go", so it proves the opposite of presence;
//        - the flock has at least two accepted members. Creating a flock is
//          one free POST with a client-supplied venue_id, so a solo flock is
//          self-certification: one account could mint "verified" for any place
//          id on earth, at will. Requiring a second account to accept does not
//          make forgery impossible, but it changes the cost from one request to
//          a second real account that also has to accept, per fabricated venue.
//          Flock is a group-coordination product; a hangout of one is not the
//          thing this table is supposed to be recording anyway.
//
// Honest about the remaining hole: a determined attacker with two controlled
// accounts can still manufacture a flock at any place id and mint verified
// feedback. Closing that needs a presence signal we cannot fake for ourselves
// (NFC hardware, or attested geolocation), which almost no venue has yet.
//
// NOTE FOR THE NEXT AUDIT: routes/venueDashboard.js runs a near-identical rule
// for venue_reviews, with deliberately longer windows (a review is written the
// next morning; a crowd report is live). It does NOT yet have the
// two-accepted-members requirement, and its comment claims parity with this
// file. That parity claim is now stale and venueDashboard.js should adopt the
// same clause.
// ---------------------------------------------------------------------------
const VERIFIED_PRESENCE_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM venue_checkins
      WHERE user_id = $1
        AND venue_place_id = $2
        AND created_at > NOW() - INTERVAL '3 hours'
        AND checkin_source = 'nfc'
    )
    OR EXISTS (
      SELECT 1
      FROM flock_members fm
      JOIN flocks f ON f.id = fm.flock_id
      WHERE fm.user_id = $1
        AND fm.status = 'accepted'
        AND f.venue_id = $2
        AND f.status IS DISTINCT FROM 'cancelled'
        AND f.event_time BETWEEN NOW() - INTERVAL '12 hours'
                             AND NOW() + INTERVAL '12 hours'
        AND (
          SELECT COUNT(*) FROM flock_members m
          WHERE m.flock_id = f.id AND m.status = 'accepted'
        ) >= 2
    ) AS verified`;

// ---------------------------------------------------------------------------
// POST /api/feedback — Submit post-hangout venue feedback
// ---------------------------------------------------------------------------
router.post('/',
  requireScalarFields,
  [
    // Length caps sit below the VARCHAR(255) columns these land in, so an
    // over-long value is a 400 and never a Postgres 22001 turned into a 500.
    body('venue_place_id').trim()
      .isLength({ min: 1, max: 200 }).withMessage('venue_place_id is required').bail()
      // Same shape rule routes/checkin.js and sockets/handlers.js enforce
      // (utils/places.js). Without it any string at all became a venue in this
      // table, and the per-venue dedupe below keys on it — so fabricated ids
      // were a free way to sidestep "one report per venue per 2 hours".
      .custom((v) => isPlaceIdShaped(v)).withMessage('venue_place_id is not a valid place id'),
    body('venue_name').trim().isLength({ min: 1, max: 200 }).withMessage('venue_name is required'),
    body('crowd_level').isInt({ min: 1, max: 3 }).withMessage('crowd_level must be 1-3'),

    // `optional()` in express-validator 7 defaults to values:'undefined', so a
    // JSON `null` was NOT skipped — it fell through to isBoolean/isInt and
    // failed. The shipping client sends exactly that: the post-hangout sheet
    // posts price_worth: null and rating: null whenever the user answers only
    // the crowd question, and the inline reality-check posts
    // predicted_score: null when no prediction is on screen. So the most
    // common honest submission was answered 400 and the report was lost,
    // silently, on the client's catch. values:'null' skips null AND undefined.
    body('price_worth').optional({ values: 'null' }).isBoolean().withMessage('price_worth must be a boolean'),
    body('rating').optional({ values: 'null' }).isInt({ min: 1, max: 5 }).withMessage('rating must be 1-5'),
    body('predicted_score').optional({ values: 'null' }).isInt({ min: 0, max: 100 }).withMessage('predicted_score must be 0-100'),

    // Flock ids are integers (SERIAL) — the old UUID validator rejected every
    // legitimate post-hangout feedback submission (audit 2026-08-12). Bounds
    // are the int4 range: outside it is a 400, not a 500.
    body('flock_id').optional({ values: 'null' })
      .isInt({ min: 1, max: INT4_MAX }).withMessage('flock_id must be a valid flock id'),

    // Optional venue-local clock hint (see venueLocalDayHour above).
    body('local_day').optional({ values: 'null' }).isInt({ min: 0, max: 6 }).withMessage('local_day must be 0-6'),
    body('local_hour').optional({ values: 'null' }).isInt({ min: 0, max: 23 }).withMessage('local_hour must be 0-23'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const {
        venue_place_id,
        venue_name,
        crowd_level,
        price_worth,
        rating,
        predicted_score,
        flock_id,
        local_day,
        local_hour,
      } = req.body;

      const flockId = flock_id == null ? null : Number(flock_id);

      // Venue timezone, read BEFORE the transaction on purpose. It is static
      // reference data and no invariant depends on it, whereas inside the
      // transaction a failed statement (a missing ml_venues, a statement
      // timeout) aborts the whole thing in Postgres and the feedback would be
      // lost over a lookup that only chooses a bucket label. Out here a failure
      // degrades to the next clock source instead.
      let venueTimezone = null;
      try {
        const tzRow = await pool.query(
          `SELECT timezone FROM ml_venues WHERE google_place_id = $1 LIMIT 1`,
          [venue_place_id]
        );
        venueTimezone = tzRow.rows[0]?.timezone || null;
      } catch (tzErr) {
        console.error('[Feedback] Venue timezone lookup failed, falling back:', tzErr.message);
      }

      // Anti-forgery (audit 2026-08-12): one report per user per venue per 2h
      // window. Unlimited reports let a single account own a venue's live
      // calibration AND poison future training labels. Newest report wins
      // within the window (people can correct themselves).
      // Round 4: the dedup + hourly cap + insert run in ONE transaction under
      // a per-user advisory lock — as autocommit statements, concurrent
      // submissions could all pass the count and blow through both limits.
      //
      // Note what the cap does and does not bound. The dedupe DELETE runs
      // BEFORE the count, so re-reporting the SAME venue never consumes a slot:
      // a user can correct themselves as often as they like and still holds
      // exactly one row. The cap is therefore "10 DISTINCT venues an hour", not
      // "10 requests an hour" — request volume is the general apiLimiter's job
      // (server.js). That is the intended trade: corrections are free, breadth
      // is not, and breadth is what steering a venue's numbers requires.
      const client = await pool.connect();
      let inserted;
      let refusal = null;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [FEEDBACK_LOCK_NAMESPACE, req.user.id]);

        // A flock_id is an attribution claim, and nothing checked it: any
        // account could file feedback against a stranger's flock id, which is
        // the join key the research/analytics layer is meant to use. Require a
        // membership row. Any status is enough — the question here is "is this
        // your flock", not "were you there"; presence is decided separately by
        // VERIFIED_PRESENCE_SQL, which insists on 'accepted'.
        if (flockId !== null) {
          const membership = await client.query(
            `SELECT 1 FROM flock_members WHERE flock_id = $1 AND user_id = $2 LIMIT 1`,
            [flockId, req.user.id]
          );
          if (membership.rowCount === 0) {
            refusal = { status: 403, body: { error: 'That flock is not yours to report on.' } };
            throw new Rollback();
          }
        }

        await client.query(
          `DELETE FROM venue_feedback
           WHERE user_id = $1 AND venue_place_id = $2 AND created_at > NOW() - INTERVAL '2 hours'`,
          [req.user.id, venue_place_id]
        );
        const recentCount = await client.query(
          `SELECT COUNT(*)::int AS n FROM venue_feedback
           WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
          [req.user.id]
        );
        if ((recentCount.rows[0]?.n || 0) >= MAX_REPORTS_PER_HOUR) {
          refusal = { status: 429, body: { error: 'Too many reports in a short time. Try again later.' } };
          throw new Rollback();
        }

        // Bucket keys on the venue's clock, not the server's. See the long
        // note on venueLocalDayHour.
        const now = new Date();
        let localClock = venueLocalDayHour(venueTimezone, now);
        if (!localClock && local_day != null && local_hour != null) {
          localClock = { day: Number(local_day), hour: Number(local_hour), source: 'client' };
        }
        if (!localClock) {
          localClock = { day: now.getDay(), hour: now.getHours(), source: 'server' };
        }

        const verifiedCheck = await client.query(VERIFIED_PRESENCE_SQL, [req.user.id, venue_place_id]);
        const verified = verifiedCheck.rows[0]?.verified === true;

        const result = await client.query(
          `INSERT INTO venue_feedback
            (user_id, flock_id, venue_place_id, venue_name, crowd_level, price_worth, rating, predicted_score, day_of_week, hour, verified)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING *`,
          [
            req.user.id,
            flockId,
            venue_place_id,
            venue_name,
            crowd_level,
            price_worth ?? null,
            rating ?? null,
            predicted_score ?? null,
            localClock.day,
            localClock.hour,
            verified,
          ]
        );
        inserted = result.rows[0];

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        if (!(txErr instanceof Rollback)) throw txErr;
      } finally {
        client.release();
      }

      if (refusal) return res.status(refusal.status).json(refusal.body);

      // `verified` is returned deliberately: the submitter is told whether
      // their report will count, rather than being thanked for something that
      // was filed and ignored.
      res.status(201).json(inserted);
    } catch (err) {
      console.error('[Feedback] Submit error:', err);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/feedback/venue/:placeId — Aggregate feedback for a venue
//
// VERIFIED ROWS ONLY. This endpoint is the public-facing number for a venue,
// and it was the one reader that did not filter: routes/crowd.js,
// services/mlPredictor.js and the training export all restrict to
// verified = true, while this aggregated everything. So the flag was doing its
// job in three places out of four, and the fourth was the one a person reads.
// Any pile of accounts could move avg_crowd_level, avg_rating and
// price_worth_percent here without ever proving they had been to the venue.
//
// The excluded rows are reported as a count rather than dropped in silence, so
// "12 reports, 9 of them unverifiable" cannot be mistaken for "3 reports".
// ---------------------------------------------------------------------------
router.get('/venue/:placeId',
  param('placeId').trim()
    .isLength({ min: 1, max: 200 }).withMessage('placeId is required').bail()
    .custom((v) => isPlaceIdShaped(v)).withMessage('placeId is not a valid place id'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const placeId = req.params.placeId;

      // One scan, verified and unverified counted separately. `verified` is
      // nullable (migration 003 added it with DEFAULT false, so pre-existing
      // rows can be NULL): FILTER (WHERE verified) treats NULL as not-true,
      // which is the conservative direction, and the unverified count uses
      // COALESCE so those rows are still visible in the total.
      const overall = await pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE verified)::int AS total_feedback,
          COUNT(*) FILTER (WHERE NOT COALESCE(verified, false))::int AS unverified_excluded,
          ROUND(AVG(crowd_level) FILTER (WHERE verified)::numeric, 1) AS avg_crowd_level,
          ROUND(AVG(rating) FILTER (WHERE verified)::numeric, 1) AS avg_rating,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE verified AND price_worth = true)
            / NULLIF(COUNT(*) FILTER (WHERE verified AND price_worth IS NOT NULL), 0), 0
          ) AS price_worth_percent
        FROM venue_feedback
        WHERE venue_place_id = $1`,
        [placeId]
      );

      // Breakdown by day of week — same verified-only rule.
      const byDay = await pool.query(
        `SELECT
          day_of_week,
          ROUND(AVG(crowd_level)::numeric, 1) AS avg_crowd_level,
          COUNT(*)::int AS count
        FROM venue_feedback
        WHERE venue_place_id = $1 AND verified = true
        GROUP BY day_of_week
        ORDER BY day_of_week`,
        [placeId]
      );

      const byDayOfWeek = {};
      for (const row of byDay.rows) {
        byDayOfWeek[row.day_of_week] = {
          avgCrowdLevel: parseFloat(row.avg_crowd_level),
          count: row.count,
        };
      }

      const row = overall.rows[0];
      // `!= null` rather than truthiness: a genuine 0 (every verified reporter
      // said the price was NOT worth it) is a real answer and must not be
      // rendered as "no data". It survives today only because pg returns
      // numerics as strings and "0" happens to be truthy — one driver setting
      // away from silently reporting the worst case as unknown.
      res.json({
        placeId,
        verifiedOnly: true,
        totalFeedback: row.total_feedback,
        unverifiedExcluded: row.unverified_excluded,
        avgCrowdLevel: row.avg_crowd_level != null ? parseFloat(row.avg_crowd_level) : null,
        avgRating: row.avg_rating != null ? parseFloat(row.avg_rating) : null,
        priceWorthPercent: row.price_worth_percent != null ? parseFloat(row.price_worth_percent) : null,
        byDayOfWeek,
      });
    } catch (err) {
      console.error('[Feedback] Aggregate error:', err);
      res.status(500).json({ error: 'Failed to fetch feedback' });
    }
  }
);

module.exports = router;
module.exports.__testables = { venueLocalDayHour };
