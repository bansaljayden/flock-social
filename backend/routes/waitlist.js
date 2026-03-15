const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { Resend } = require('resend');
const pool = require('../config/database');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Create waitlist table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});

// POST /api/waitlist — no auth required
router.post('/',
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  async (req, res) => {
    try {
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
        try {
          await resend.emails.send({
            from: 'Flock <hello@flockcorp.com>',
            to: email,
            subject: "You're on the Flock waitlist",
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
                <div style="text-align: center; margin-bottom: 32px;">
                  <img src="https://flockcorp.com/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
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
          });
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
