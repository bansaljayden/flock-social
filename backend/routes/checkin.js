const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Round 12: GET /:placeId is UNAUTHENTICATED and inserted a venue_checkins row
// for any attacker-supplied string. There was no validator of any kind, so:
//   - ids longer than VARCHAR(255) blew up as 500s instead of 400s, and
//   - the anonymous dedupe keys on ip|placeId, so rotating fabricated ids
//     defeated it entirely — one IP could write ~288,000 rows/day (the general
//     limiter's ceiling) straight into the table the ML pipeline reads and the
//     live occupancy count sums.
// Taps must now look like a Google place id AND name a venue we actually know.
// ---------------------------------------------------------------------------
const PLACE_ID_RE = /^[A-Za-z0-9_-]{6,128}$/; // Google place ids; well under VARCHAR(255)

function validPlaceId(placeId) {
  return typeof placeId === 'string' && PLACE_ID_RE.test(placeId);
}

// "Known" = a venue that exists in our world already: a claimed venue profile,
// a deployed sensor/NFC site, a curated ML venue, or somewhere a flock has
// actually planned to meet. NFC tags are only ever programmed for venues we
// onboarded, so this costs a real tap nothing. Deliberately does NOT consult
// venue_checkins — that would let the first forged row bootstrap the rest.
async function isKnownPlace(placeId) {
  const { rows } = await pool.query(
    `SELECT (
       EXISTS (SELECT 1 FROM venue_profiles WHERE google_place_id = $1)
       OR EXISTS (SELECT 1 FROM sensor_devices WHERE venue_place_id = $1)
       OR EXISTS (SELECT 1 FROM ml_venues WHERE google_place_id = $1)
       OR EXISTS (SELECT 1 FROM flocks WHERE venue_id = $1)
     ) AS known`,
    [placeId]
  );
  return rows[0]?.known === true;
}

// Round 8: the bare GET accepted ANY place id and stored it as source 'nfc',
// which feedback verification trusts as physical presence — so visiting the
// URL in a browser minted "verified" calibration/training feedback for any
// venue. Real tags are ones WE programmed: their URL carries an HMAC of the
// place id under NFC_TAG_SECRET. A tap without a valid signature still counts
// as presence-unproven ('nfc_unverified'), which feedback does not trust.
function nfcSigValid(placeId, sig) {
  const secret = process.env.NFC_TAG_SECRET;
  if (!secret || !sig || typeof sig !== 'string') return false;
  const expected = crypto.createHmac('sha256', secret).update(String(placeId)).digest('hex').slice(0, 32);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Best-effort token decode without bouncing the request — used by the NFC GET
// route which must succeed for both authenticated and anonymous taps.
//
// Round 15: this only asked "does a user with this id still exist", which
// silently skipped the two revocation controls middleware/auth.js enforces on
// every other authenticated route:
//
//   1. token_version (migration 009). Bumping users.token_version is what makes
//      an OAuth account-claim or a password change actually evict a squatter.
//      Here a revoked token still resolved, so the evicted party kept writing
//      venue_checkins rows AS THE VICTIM and kept marking the victim's flock
//      attendance for up to the token's remaining 24h.
//   2. is_banned. A ban is supposed to bite on the next request everywhere; a
//      banned account could still mint check-ins, emit into the venue room, and
//      earn reliability credit through this route.
//
// A failing token is treated as an ANONYMOUS tap (which then takes the
// anonymous dedupe path), never as a hard 401 — a real NFC tap from a logged-out
// phone must still work.
async function tryAuth(req) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, is_banned, token_version FROM users WHERE id = $1',
      [decoded.userId]
    );
    const row = result.rows[0];
    if (!row) return null;

    // Same "missing claim reads as 0" rule as middleware/auth.js, so tokens
    // minted before migration 009 keep working until something bumps the row.
    const issued = Number.isInteger(decoded?.tv) ? decoded.tv : 0;
    const current = Number.isInteger(row.token_version) ? row.token_version : 0;
    if (issued !== current) return null;
    if (row.is_banned) return null;

    return row.id;
  } catch {
    return null;
  }
}

// If the user has any active flock at this venue, mark them as attended
// (drives the anti-flake reliability scoring).
// Manual check-ins are self-reported: they may record presence, but they must
// not by themselves mint the "verified" evidence feedback trusts, and they
// must not credit attendance without a matching flock at that venue in its
// event window (round 6). markFlockAttendance already enforces the window.
async function markFlockAttendance(userId, placeId) {
  if (!userId || !placeId) return;
  try {
    // status stays 'accepted' (the CHECK constraint only allows invited/
    // accepted/declined — the old status='attended' write violated it and the
    // swallowed error meant check-ins NEVER fed reliability scoring, audit
    // 2026-08-12). Attendance lives in its own column, which scoring reads.
    const r = await pool.query(
      `UPDATE flock_members SET attendance = 'attended'
       WHERE user_id = $1
         AND status = 'accepted'
         AND flock_id IN (
           SELECT id FROM flocks
           -- flocks has no venue_data column — referencing it made PostgreSQL
           -- reject the whole UPDATE, so attendance was never recorded
           WHERE venue_id = $2
             AND status NOT IN ('completed', 'cancelled')
             -- Only within the event window (round 3: checking in today must
             -- not pre-credit attendance for next week's flock — reliability
             -- scores were inflatable above 100%)
             AND event_time IS NOT NULL
             AND NOW() BETWEEN event_time - INTERVAL '3 hours' AND event_time + INTERVAL '12 hours'
         )`,
      [userId, placeId]
    );
    if (r.rowCount > 0) console.log(`[Checkin] attendance recorded for user ${userId} at ${placeId} (${r.rowCount} flock[s])`);
  } catch (err) {
    // Non-fatal — never block the checkin, but the failure must be loud
    console.error('Flock attendance update FAILED:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Tap dedupe.
//
// Round 3 deduped ANONYMOUS taps only (ip|place, 30 min). Round 15: an
// authenticated tap had no ceiling at all, on either verb, and every accepted
// tap does two things that must not be repeatable at will:
//
//   - it INSERTs into venue_checkins, the table routes/sensors.js reads for
//     public occupancy and the ML pipeline exports as training data, and
//   - it emits `venue_checkin` into the venue room, where the client
//     (App.js venue screen + venue-owner dashboard) increments its displayed
//     "recent check-ins" by one PER EVENT. The REST query behind that number is
//     COUNT(DISTINCT user_id), so the database was safe, but the live number in
//     every viewer's browser was not: one logged-in account holding down the
//     NFC URL drove a venue's public busyness figure as high as it liked.
//
// POST is the worse of the two, because it deliberately skips the known-place
// requirement (a manual check-in legitimately happens at a Google Places venue
// we have never seen), so unbounded rows could be written for FABRICATED place
// ids. The window matches the client's own 2h checkin lockout on the generous
// side; it exists to bound abuse, not to police honest re-taps.
// ---------------------------------------------------------------------------
const TAP_DEDUPE_MS = 30 * 60 * 1000;
const tapCache = new Map(); // "u:<id>|place" or "ip:<addr>|place" -> last tap ms

// flockcorp.com has no DNS pointed at the app yet, so tapping an NFC tag would
// land on a dead domain. Overridable once DNS is live.
const anonRedirect = () => process.env.PUBLIC_WEB_URL || 'https://flock-app-w65m.vercel.app';

// ---------------------------------------------------------------------------
// Round 15 (location privacy): this event used to carry `user_id`.
//
// `venue:{placeId}` is not a private room. sockets/handlers.js `join_venue`
// accepts any place id string from any authenticated socket, with no
// relationship, membership or block check, up to 25 rooms at a time. So any
// logged-in account could subscribe to 25 venues of its choosing and receive a
// live feed of exactly which user ids walked into them — a stalking primitive
// on an app whose users are 15-22, and one that ignored user_blocks entirely.
//
// Nothing consumed the field: both client handlers (App.js venue screen and the
// venue-owner dashboard) only do `recent_checkins + 1`. The count is the whole
// point of the event, so the count is all it carries.
// ---------------------------------------------------------------------------
function emitVenueCheckin(io, placeId, createdAt) {
  io.to(`venue:${placeId}`).emit('venue_checkin', {
    venue_place_id: placeId,
    created_at: createdAt,
  });
}

// True when this identity already checked in at this venue inside the window.
// Identity is the user id when we have one, so rotating IPs (or sitting behind
// the same proxy as everyone else) changes nothing for a logged-in caller.
function tapIsDuplicate(userId, placeId, ip) {
  const key = userId ? `u:${userId}|${placeId}` : `ip:${ip}|${placeId}`;
  const last = tapCache.get(key);
  if (last && Date.now() - last < TAP_DEDUPE_MS) return true;
  if (tapCache.size > 10000) tapCache.clear();
  tapCache.set(key, Date.now());
  return false;
}

// ---------------------------------------------------------------------------
// GET /api/checkin/:placeId — NFC tap landing endpoint
// Open to authenticated AND anonymous users. Records check-in either way.
// ---------------------------------------------------------------------------
router.get('/:placeId', async (req, res) => {
  try {
    const { placeId } = req.params;
    if (!validPlaceId(placeId)) return res.status(400).json({ error: 'Invalid venue id' });
    if (!(await isKnownPlace(placeId))) return res.status(404).json({ error: 'Unknown venue' });

    const userId = await tryAuth(req);

    // Round 3: refreshing the NFC URL (or embedding it) minted unlimited
    // anonymous check-in rows. Round 15: the same is now true of authenticated
    // taps — see tapIsDuplicate. A duplicate is a success, not an error: the
    // tap happened, we just already know about it.
    if (tapIsDuplicate(userId, placeId, req.ip)) {
      return res.json({
        ok: true,
        success: true,
        venue_place_id: placeId,
        deduped: true,
        // An anonymous tap is a phone sitting on the landing URL, so a deduped
        // tap still has to be sent somewhere — dropping this stranded the
        // second tap of the evening on a blank page.
        ...(userId ? {} : { redirect: anonRedirect() }),
      });
    }

    const source = nfcSigValid(placeId, req.query.sig) ? 'nfc' : 'nfc_unverified';
    const insert = await pool.query(
      `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
       VALUES ($1, $2, $3)
       RETURNING created_at`,
      [placeId, userId, source]
    );
    const checked_in_at = insert.rows[0].created_at;

    const io = req.app.get('io');
    if (io) emitVenueCheckin(io, placeId, checked_in_at);

    if (userId) {
      markFlockAttendance(userId, placeId).catch(() => {});
      return res.json({
        success: true,
        venue_place_id: placeId,
        checked_in_at,
      });
    }

    return res.json({
      success: true,
      venue_place_id: placeId,
      checked_in_at,
      redirect: anonRedirect(),
    });
  } catch (err) {
    console.error('NFC checkin error:', err);
    res.status(500).json({ error: 'Failed to record checkin' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/checkin/:placeId — manual check-in from inside the app
// ---------------------------------------------------------------------------
router.post('/:placeId', authenticate, async (req, res) => {
  try {
    const { placeId } = req.params;
    // Round 12 (VARCHAR overflow): same shape check as the public tap. The
    // known-place requirement is deliberately NOT applied here — a manual
    // check-in is an authenticated, identified, rate-limited write from inside
    // the app, and it legitimately happens at venues discovered through Google
    // Places that we have never seen before.
    if (!validPlaceId(placeId)) return res.status(400).json({ error: 'Invalid venue id' });

    // Round 15: with no known-place requirement AND no dedupe, this was the
    // cheapest way to write unbounded rows for FABRICATED place ids into the
    // table the ML pipeline exports — and to drive the live occupancy figure in
    // every viewer's browser. The client already self-limits to one check-in per
    // venue per 2h in localStorage; per CLAUDE.md that gate is cosmetic until
    // the server enforces it too.
    if (tapIsDuplicate(req.user.id, placeId, req.ip)) {
      return res.json({ success: true, venue_place_id: placeId, deduped: true });
    }

    const insert = await pool.query(
      `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
       VALUES ($1, $2, 'manual')
       RETURNING created_at`,
      [placeId, req.user.id]
    );
    const checked_in_at = insert.rows[0].created_at;

    const io = req.app.get('io');
    if (io) emitVenueCheckin(io, placeId, checked_in_at);

    markFlockAttendance(req.user.id, placeId).catch(() => {});

    res.json({
      success: true,
      venue_place_id: placeId,
      checked_in_at,
    });
  } catch (err) {
    console.error('Manual checkin error:', err);
    res.status(500).json({ error: 'Failed to record checkin' });
  }
});

module.exports = router;

// Exposed for __tests__/checkinSecurity.test.js only. Properties on the router
// keep server.js's `app.use('/api/checkin', checkinRoutes)` mount unchanged —
// an express Router is a function object, so this adds nothing to the request
// path.
module.exports.__test = { tryAuth, tapIsDuplicate, emitVenueCheckin, tapCache, validPlaceId };
