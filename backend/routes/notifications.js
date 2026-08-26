const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// A phone, a tablet, a laptop, a couple of browsers. Twenty is already far more
// devices than anyone signs in from; it exists to bound the fan-out, not to
// ration devices. services/firebaseService.js enforces the same ceiling at send
// time so pre-existing bloat is bounded too.
const MAX_TOKENS_PER_USER = 20;

// POST /api/notifications/register — Register a device token for push notifications
router.post('/register',
  [
    // An FCM registration token is ~160-350 characters. The column is TEXT and
    // was unbounded, so an authenticated client could park megabytes in it.
    body('token').isString().trim().isLength({ min: 8, max: 1024 })
      .withMessage('Token is required'),
    body('deviceType').optional({ values: 'null' }).isIn(['web', 'ios', 'android'])
      .withMessage('Unknown device type'),
    // The device's own IANA zone name, e.g. 'America/New_York'. Optional: a
    // client that cannot resolve one must still be able to register for push.
    // Bounded and character-restricted rather than merely trimmed, because the
    // value is handed to Intl.DateTimeFormat on the send path and the longest
    // real zone name is 32 characters.
    body('timezone').optional({ values: 'falsy' }).isString().trim()
      .isLength({ min: 1, max: 64 }).matches(/^[A-Za-z0-9_+/-]+$/)
      .withMessage('Invalid timezone'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const token = String(req.body.token).trim();
      const { deviceType } = req.body;
      const safeDeviceType = ['web', 'ios', 'android'].includes(deviceType) ? deviceType : 'web';
      // WHY A TIMEZONE LIVES ON A PUSH TOKEN. It is the only clock the server
      // can read for a recipient who is, by definition, not connected. Quiet
      // hours (services/pushHelper.js) need the local hour where the phone is,
      // and Railway runs on UTC: evaluating a 02:00 to 08:00 quiet window on
      // the server's clock would mute 22:00 to 04:00 for a US east coast user,
      // which is every hour this app exists for.
      //
      // Only ever WIDENED, never cleared, by the upsert below. An older client
      // build that posts no timezone must not wipe the one a newer build on the
      // same device already stored, or quiet hours would switch themselves off
      // for anybody with two clients.
      const rawZone = typeof req.body.timezone === 'string' ? req.body.timezone.trim() : '';
      const timezone = rawZone ? rawZone.slice(0, 64) : null;

      // A device token belongs to exactly ONE account. Round 4: the old
      // delete-then-insert pair wasn't atomic — two concurrent registrations
      // could both delete, then both insert, leaving the token on two
      // accounts. UNIQUE(token) (migration 002) makes this single upsert a
      // true ownership transfer.
      await pool.query(
        `INSERT INTO device_tokens (user_id, token, device_type, timezone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             device_type = EXCLUDED.device_type,
             timezone = COALESCE(EXCLUDED.timezone, device_tokens.timezone),
             updated_at = NOW()`,
        [req.user.id, token, safeDeviceType, timezone]
      );

      // Nothing bounded how many tokens one account could accumulate. Every
      // push to a user fans out CONCURRENTLY over every row here, so an account
      // that had registered ten thousand tokens turned each of its own
      // notifications into ten thousand simultaneous requests to Google. Real
      // people have a handful of devices; the cap is far above that and evicts
      // the least recently seen. Never fatal to the registration itself — the
      // token is already stored, which is the part the caller asked for.
      await pool.query(
        `DELETE FROM device_tokens
          WHERE user_id = $1
            AND id NOT IN (
              SELECT id FROM device_tokens
               WHERE user_id = $1
               ORDER BY updated_at DESC NULLS LAST, id DESC
               LIMIT $2
            )`,
        [req.user.id, MAX_TOKENS_PER_USER]
      ).catch((e) => console.warn('Device token prune failed:', e.message));

      res.json({ registered: true });
    } catch (err) {
      console.error('Register token error:', err);
      res.status(500).json({ error: 'Failed to register token' });
    }
  }
);

// DELETE /api/notifications/unregister — Remove a specific device token
// This is the logout path. It deletes THIS device's token and leaves the
// user's other devices alone; /unregister-all is the "sign me out everywhere"
// hammer and signing out of a laptop should not kill push on a phone.
router.delete('/unregister',
  [body('token').isString().trim().isLength({ min: 1, max: 1024 }).withMessage('Token is required')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      await pool.query(
        'DELETE FROM device_tokens WHERE user_id = $1 AND token = $2',
        [req.user.id, String(req.body.token).trim()]
      );

      res.json({ unregistered: true });
    } catch (err) {
      console.error('Unregister token error:', err);
      res.status(500).json({ error: 'Failed to unregister token' });
    }
  }
);

// DELETE /api/notifications/unregister-all — Remove all tokens for this user (logout)
router.delete('/unregister-all', async (req, res) => {
  try {
    await pool.query('DELETE FROM device_tokens WHERE user_id = $1', [req.user.id]);
    res.json({ cleared: true });
  } catch (err) {
    console.error('Unregister all tokens error:', err);
    res.status(500).json({ error: 'Failed to clear tokens' });
  }
});

module.exports = router;
