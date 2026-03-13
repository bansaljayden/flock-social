const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// POST /api/notifications/register — Register a device token for push notifications
router.post('/register',
  [body('token').isString().isLength({ min: 1 }).withMessage('Token is required')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { token, deviceType } = req.body;
      const safeDeviceType = ['web', 'ios', 'android'].includes(deviceType) ? deviceType : 'web';

      await pool.query(
        `INSERT INTO device_tokens (user_id, token, device_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token) DO UPDATE SET updated_at = NOW()`,
        [req.user.id, token, safeDeviceType]
      );

      res.json({ registered: true });
    } catch (err) {
      console.error('Register token error:', err);
      res.status(500).json({ error: 'Failed to register token' });
    }
  }
);

// DELETE /api/notifications/unregister — Remove a specific device token
router.delete('/unregister',
  [body('token').isString().isLength({ min: 1 }).withMessage('Token is required')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      await pool.query(
        'DELETE FROM device_tokens WHERE user_id = $1 AND token = $2',
        [req.user.id, req.body.token]
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
