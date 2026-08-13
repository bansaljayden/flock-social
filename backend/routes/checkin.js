const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

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
async function tryAuth(req) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    return result.rows[0]?.id || null;
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

const anonTapCache = new Map(); // ip|place -> last anon tap ms

// ---------------------------------------------------------------------------
// GET /api/checkin/:placeId — NFC tap landing endpoint
// Open to authenticated AND anonymous users. Records check-in either way.
// ---------------------------------------------------------------------------
router.get('/:placeId', async (req, res) => {
  try {
    const { placeId } = req.params;
    if (!placeId) return res.status(400).json({ error: 'placeId required' });

    const userId = await tryAuth(req);

    // Round 3: refreshing the NFC URL (or embedding it) minted unlimited
    // anonymous check-in rows that fed straight into occupancy counts and
    // future training data. Anonymous taps dedupe per IP+venue per 30 min.
    if (!userId) {
      const ipKey = `${req.ip}|${placeId}`;
      const lastTap = anonTapCache.get(ipKey);
      if (lastTap && Date.now() - lastTap < 30 * 60 * 1000) {
        return res.json({ ok: true, deduped: true });
      }
      if (anonTapCache.size > 10000) anonTapCache.clear();
      anonTapCache.set(ipKey, Date.now());
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
    if (io) {
      io.to(`venue:${placeId}`).emit('venue_checkin', {
        venue_place_id: placeId,
        user_id: userId,
        created_at: checked_in_at,
      });
    }

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
      // flockcorp.com has no DNS pointed at the app yet, so tapping an NFC tag
      // would land on a dead domain. Overridable once DNS is live.
      redirect: process.env.PUBLIC_WEB_URL || 'https://flock-app-w65m.vercel.app',
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
    if (!placeId) return res.status(400).json({ error: 'placeId required' });

    const insert = await pool.query(
      `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
       VALUES ($1, $2, 'manual')
       RETURNING created_at`,
      [placeId, req.user.id]
    );
    const checked_in_at = insert.rows[0].created_at;

    const io = req.app.get('io');
    if (io) {
      io.to(`venue:${placeId}`).emit('venue_checkin', {
        venue_place_id: placeId,
        user_id: req.user.id,
        created_at: checked_in_at,
      });
    }

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
