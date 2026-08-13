const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { Resend } = require('resend');
const pool = require('../config/database');
const { upstreamSignal } = require('../utils/upstream');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Round 7 budget: 3 signups/hour per IP, 500 confirmation sends/day globally.
// In-memory is fine on the single-instance deployment.
const ipHourly = new Map(); // ip -> { count, resetAt }
let dailySends = { count: 0, resetAt: 0 };
const WAITLIST_IP_HOURLY = 3;
const WAITLIST_GLOBAL_DAILY = 500;

// Per-IP attempt budget. Charged on every request (that's the abuse signal),
// unlike the global send budget below.
function allowWaitlistSignup(req) {
  const now = Date.now();
  if (now > dailySends.resetAt) {
    dailySends = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
  }
  if (dailySends.count >= WAITLIST_GLOBAL_DAILY) return false;

  const ip = req.ip || 'unknown';
  if (ipHourly.size > 5000) {
    for (const [k, v] of ipHourly) { if (now > v.resetAt) ipHourly.delete(k); }
  }
  let entry = ipHourly.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60 * 60 * 1000 };
    ipHourly.set(ip, entry);
  }
  if (entry.count >= WAITLIST_IP_HOURLY) return false;
  entry.count += 1;
  return true;
}

// The global budget exists to bound outbound MAIL, so it is spent only when an
// email is actually sent. Charging it up front let malformed or duplicate
// submissions exhaust the day's 500 and block real signups (round 9).
function chargeWaitlistSend() {
  dailySends.count += 1;
}

// waitlist table lives in migrations/003 — route-owned DDL raced the
// migration runner on fresh deployments (see REVIEW-ROUND5).

// POST /api/waitlist — no auth required
router.post('/',
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  async (req, res) => {
    try {
    // Round 7: this public route emails any address it is given — without its
    // own throttle it is an outbound-mail relay under the generous global
    // limiter. 3 signups/hour per IP, 500 confirmation emails/day globally.
    if (!allowWaitlistSignup(req)) {
      return res.status(429).json({ error: 'Too many signups from this connection. Try again later.' });
    }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { email } = req.body;

      // Insert (ignore duplicates)
      const result = await pool.query(
        `INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email]
      );

      const isNew = result.rows.length > 0;

      // Send confirmation email for new signups
      if (isNew && resend) {
        chargeWaitlistSend();
        try {
          await resend.emails.send({
            from: 'Flock <hello@flockcorp.com>',
            to: email,
            subject: "You're on the Flock waitlist",
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
                <div style="text-align: center; margin-bottom: 32px;">
                  <img src="${process.env.PUBLIC_WEB_URL || 'https://flock-app-w65m.vercel.app'}/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
                </div>
                <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">You're on the list.</h1>
                <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
                  Thanks for signing up for early access to Flock. We're building the app that replaces the broken group chat planning process with something that actually works.
                </p>
                <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
                  We'll let you know as soon as it's ready.
                </p>
                <p style="font-size: 14px; color: #a0aec0;">— The Flock Team</p>
              </div>
            `,
          }, { signal: upstreamSignal('email') }); // round 12 — see utils/upstream.js
        } catch (emailErr) {
          console.error('[Waitlist] Email send failed:', emailErr.message);
        }
      }

      res.status(201).json({ success: true, message: isNew ? "You're on the list." : "You're already on the list." });
    } catch (err) {
      console.error('[Waitlist] Error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
