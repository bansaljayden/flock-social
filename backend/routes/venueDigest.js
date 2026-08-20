// ---------------------------------------------------------------------------
// GET /api/venue-digest/opt-out?token=...
//
// The unsubscribe link in every Monday digest. No login: the link is clicked
// from a mail client, often on a device that has never seen the dashboard,
// and CAN-SPAM wants it to work in one click. The token is signed with
// JWT_SECRET and carries a single-purpose claim, so a session token cannot be
// replayed here and this token opens nothing else (services/venueDigest.js
// checks the purpose, not just the signature).
//
// The response is a tiny HTML page, not JSON, because a person is looking at
// it. It flips venue_profiles.notification_prefs.weekly to false, the same
// column the dashboard's "Weekly reports" switch writes, so the dashboard
// shows the truth the next time the owner opens it.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');
const { applyOptOut } = require('../services/venueDigest');

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #faf7f2; margin: 0; padding: 48px 24px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="font-size: 20px; color: #1a2b4a;">${title}</h1>
    <p style="font-size: 15px; color: #4a5568; line-height: 1.6;">${body}</p>
  </div>
</body>
</html>`;
}

router.get('/opt-out', [
  query('token').isString().notEmpty().withMessage('Token is required').isLength({ max: 2048 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).type('html').send(page(
        'That link is not right',
        'This unsubscribe link is missing its token. Open the link from the email again, or turn off Weekly reports in your venue dashboard.'
      ));
    }
    const result = await applyOptOut(req.query.token);
    if (!result.ok) {
      return res.status(400).type('html').send(page(
        'That link has expired',
        'This unsubscribe link is no longer valid. You can still turn off Weekly reports in your venue dashboard, or use the link in a newer digest email.'
      ));
    }
    return res.status(200).type('html').send(page(
      'You are unsubscribed',
      'The Monday digest for your venue is off. You can turn it back on any time with the Weekly reports switch in your venue dashboard.'
    ));
  } catch (err) {
    console.error('Digest opt-out error:', err);
    return res.status(500).type('html').send(page(
      'Something went wrong',
      'We could not process this link. Try again in a minute, or turn off Weekly reports in your venue dashboard.'
    ));
  }
});

module.exports = router;
