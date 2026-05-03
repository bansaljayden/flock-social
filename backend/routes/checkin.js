const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

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
async function markFlockAttendance(userId, placeId) {
  if (!userId || !placeId) return;
  try {
    await pool.query(
      `UPDATE flock_members SET status = 'attended'
       WHERE user_id = $1
         AND status IN ('accepted', 'confirmed')
         AND flock_id IN (
           SELECT id FROM flocks
           WHERE (venue_id = $2 OR venue_data->>'place_id' = $2)
             AND status NOT IN ('completed', 'cancelled')
         )`,
      [userId, placeId]
    );
  } catch (err) {
    // Non-fatal — schema may differ; never block the checkin
    console.warn('Flock attendance update failed (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// GET /api/checkin/:placeId — NFC tap landing endpoint
// Open to authenticated AND anonymous users. Records check-in either way.
// ---------------------------------------------------------------------------
router.get('/:placeId', async (req, res) => {
  try {
    const { placeId } = req.params;
    if (!placeId) return res.status(400).json({ error: 'placeId required' });

    const userId = await tryAuth(req);

    const insert = await pool.query(
      `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source)
       VALUES ($1, $2, 'nfc')
       RETURNING created_at`,
      [placeId, userId]
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
      redirect: 'https://flockcorp.com',
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
