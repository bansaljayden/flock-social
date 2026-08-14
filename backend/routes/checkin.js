const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { validPlaceId, isKnownVenue } = require('../utils/places');

const router = express.Router();

// ---------------------------------------------------------------------------
// Round 12: GET /:placeId is UNAUTHENTICATED and inserted a venue_checkins row
// for any attacker-supplied string. There was no validator of any kind, so:
//   - ids longer than VARCHAR(255) blew up as 500s instead of 400s, and
//   - the anonymous dedupe keys on ip|placeId, so rotating fabricated ids
//     defeated it entirely — one IP could write ~288,000 rows/day (the general
//     limiter's ceiling) straight into the table the ML pipeline reads and the
//     live occupancy count sums.
// Taps must look like a Google place id AND name a venue we actually know.
//
// Round 16: both rules moved to utils/places.js, which sockets/handlers.js also
// imports — the shape check and the known-venue query used to be copied in both
// files. Two deliberate deltas come with the shared version:
//   - it fails CLOSED, so a database error during the lookup answers 404
//     ("Unknown venue") instead of bubbling out as a 500. For a route whose
//     whole job is deciding whether to trust a tap, refusing is the right
//     answer to "cannot tell";
//   - it caches for five minutes in both directions, so a venue onboarded
//     seconds ago can take up to five minutes to accept taps. That is
//     acceptable here because NFC tags are programmed as part of onboarding,
//     not before it; utils/places.js exports clearKnownVenueCache() if the
//     onboarding path ever wants it immediate.
// ---------------------------------------------------------------------------

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
//
// Round 16 (checked, deliberately unchanged): middleware/auth.js now exports
// `revokeUserSessions`, but it does NOT export `issuedTokenVersion` /
// `currentTokenVersion` — its module.exports is
// { authenticate, authenticateAllowBanned, authenticateSocket, signUserToken,
//   revokeUserSessions, TOKEN_EXPIRY, TOKEN_ALGORITHMS }. The version helpers
// stay private there, so the local comparison below stays. It is a COPY, and
// the rule it copies ("a missing tv claim reads as 0") lives in two files: if
// middleware/auth.js ever changes how a missing claim is interpreted, this must
// change with it. Exporting the two helpers would remove the duplication.
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
function tapKey(userId, placeId, ip) {
  return userId ? `u:${userId}|${placeId}` : `ip:${ip}|${placeId}`;
}

const TAP_CACHE_MAX = 10000;

function tapIsDuplicate(userId, placeId, ip) {
  const key = tapKey(userId, placeId, ip);
  const now = Date.now();
  const last = tapCache.get(key);
  if (last && now - last < TAP_DEDUPE_MS) return true;

  // Round 16 (reliability audit): this was `tapCache.clear()`, which dropped
  // all ten thousand entries at once — so crossing the bound re-opened the
  // duplicate window for EVERY user simultaneously, and someone spraying
  // fabricated place ids could force that moment at will. Expire what is
  // actually stale, then evict oldest-first, matching crowd.js's crowdCache.
  // A Map iterates in insertion order, and `set` on an EXISTING key keeps its
  // original position — which would make a regular's entry look permanently
  // old and evict it first. Delete then set, so the first key really is the
  // least recently written one.
  tapCache.delete(key);
  tapCache.set(key, now);
  if (tapCache.size > TAP_CACHE_MAX) {
    for (const [k, ts] of tapCache) {
      if (now - ts >= TAP_DEDUPE_MS) tapCache.delete(k);
    }
    while (tapCache.size > TAP_CACHE_MAX) {
      tapCache.delete(tapCache.keys().next().value);
    }
  }
  return false;
}

// Round 16: the window is claimed BEFORE the INSERT (it has to be — that is
// what makes it a lock rather than a race). But nothing released it when the
// insert then failed, so a single database error locked that person out of
// checking in at that venue for the next 30 minutes and left no row behind to
// show for it. On the failure path the claim is given back.
function forgetTap(userId, placeId, ip) {
  tapCache.delete(tapKey(userId, placeId, ip));
}

// ---------------------------------------------------------------------------
// GET /api/checkin/:placeId — NFC tap landing endpoint
// Open to authenticated AND anonymous users. Records check-in either way.
// ---------------------------------------------------------------------------
router.get('/:placeId', async (req, res) => {
  try {
    const { placeId } = req.params;
    if (!validPlaceId(placeId)) return res.status(400).json({ error: 'Invalid venue id' });
    if (!(await isKnownVenue(placeId))) return res.status(404).json({ error: 'Unknown venue' });

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
    let insert;
    try {
      insert = await pool.query(
        `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
         VALUES ($1, $2, $3)
         RETURNING created_at`,
        [placeId, userId, source]
      );
    } catch (insertErr) {
      forgetTap(userId, placeId, req.ip); // see forgetTap — do not burn the window on a failure
      throw insertErr;
    }
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

    let insert;
    try {
      insert = await pool.query(
        `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
         VALUES ($1, $2, 'manual')
         RETURNING created_at`,
        [placeId, req.user.id]
      );
    } catch (insertErr) {
      forgetTap(req.user.id, placeId, req.ip); // see forgetTap
      throw insertErr;
    }
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
module.exports.__test = { tryAuth, tapIsDuplicate, forgetTap, emitVenueCheckin, tapCache, validPlaceId };
