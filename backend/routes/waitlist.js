const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { Resend } = require('resend');
const pool = require('../config/database');
const { upstreamSignal } = require('../utils/upstream');
// Shape before content — see validators/shape.js. Every field this route
// accepts is a single scalar and nothing it takes is ever legitimately
// structured, so the whole-body gate is the right one here.
const { requireScalarBody } = require('../validators/shape');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Round 7 budget: 3 signups/hour per IP, 500 confirmation sends/day globally.
// In-memory is fine on the single-instance deployment.
const ipHourly = new Map(); // ip -> { count, resetAt }
let dailySends = { count: 0, resetAt: 0 };
const WAITLIST_IP_HOURLY = 3;
const WAITLIST_GLOBAL_DAILY = 500;

// Per-IP attempt budget. Charged on every request (that's the abuse signal),
// unlike the global send budget below.
//
// §O round: this used to ALSO consult the global mail budget and refuse the
// whole request once it was spent. Two different controls were wearing one
// name, and the wrong one won. The mail budget bounds outbound EMAIL — that is
// what its own comment says and what round 9 changed it to be charged for — but
// as an admission gate it threw the signup itself away: the 501st address of
// the day was never recorded, and the person was told "too many signups from
// this connection", which is not what happened, is not about their connection,
// and is not something they can act on. A mail ceiling may cost the
// confirmation email. It may not cost the signup.
function allowWaitlistSignup(req) {
  const now = Date.now();
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
//
// Consumed here rather than checked-then-charged at the call site, so that the
// check and the charge cannot drift apart. Returns false when the day's mail is
// spent; the caller records the signup either way and skips only the email.
function claimWaitlistSend() {
  const now = Date.now();
  if (now > dailySends.resetAt) {
    dailySends = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
  }
  if (dailySends.count >= WAITLIST_GLOBAL_DAILY) return false;
  dailySends.count += 1;
  return true;
}

// waitlist table lives in migrations/003 — route-owned DDL raced the
// migration runner on fresh deployments (see REVIEW-ROUND5).

// POST /api/waitlist — no auth required
router.post('/',
  // Shape first, for the whole body. `{"email": ["a@b.com"]}` satisfies
  // isEmail — express-validator expands an array field into one instance per
  // element and validates each on its own, so a one-element array of a valid
  // address passes every rule in the chain — and then STAYS an array in
  // req.body, because normalizeEmail hands a non-string back untouched. The
  // array reached node-postgres as the parameter for `waitlist.email`
  // (VARCHAR(255)) and came back a 500. On the one unauthenticated write
  // surface in the product, reachable by anyone with the marketing site open.
  requireScalarBody,
  // `.trim()` before `.isEmail()`. A trailing space is what a paste and most
  // autofills produce, isEmail refuses it, and the only thing the person is
  // told is "Valid email is required" about an address they can see is valid.
  body('email').trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
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

      // Send confirmation email for new signups. The row is already committed
      // at this point, so a spent mail budget (or a Resend outage below) costs
      // the confirmation and nothing else.
      if (isNew && resend && claimWaitlistSend()) {
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

// Test hook only. Both budgets above are process-wide in-memory state, so a
// test suite needs a way to start each case from a clean allowance and to put
// the mail budget in its exhausted state without sending 500 emails. Nothing in
// the running server calls this.
module.exports.__test = {
  reset() {
    ipHourly.clear();
    dailySends = { count: 0, resetAt: 0 };
  },
  exhaustMailBudget() {
    dailySends = { count: WAITLIST_GLOBAL_DAILY, resetAt: Date.now() + 24 * 60 * 60 * 1000 };
  },
  mailSendsToday: () => dailySends.count,
  WAITLIST_IP_HOURLY,
  WAITLIST_GLOBAL_DAILY,
};
