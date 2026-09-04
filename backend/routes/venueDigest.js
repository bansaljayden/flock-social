// ---------------------------------------------------------------------------
// The Monday digest's unsubscribe link. Two verbs, and which one writes is the
// whole point of this file.
//
//   GET  /api/venue-digest/opt-out?token=...   renders. Writes nothing.
//   POST /api/venue-digest/opt-out?token=...   unsubscribes.
//
// WHY THE EMAILED LINK CANNOT BE THE WRITE. A URL in an email is fetched by
// things that are not the recipient. Microsoft Defender Safe Links rewrites
// every href in a message and follows it; Proofpoint URL Defense does the same;
// Gmail and Outlook prefetch for previews and malware scanning. All of them
// issue a plain GET, unattended, often minutes after delivery. When the GET was
// the unsubscribe, every one of those was a venue silently opted out of a
// product they had switched on, and the only trace the owner would ever see is
// a dashboard toggle that turned itself off. Safe methods stay safe: this GET
// reads one column and draws a page with a button on it.
//
// The button POSTs back to the same URL with the same token. So does a mail
// client honouring RFC 8058: services/venueDigest.js sets List-Unsubscribe and
// List-Unsubscribe-Post on the digest, so Gmail and Apple Mail show their own
// "Unsubscribe" next to the sender and POST here directly, which is both the
// one-tap path CAN-SPAM wants and the deliverability signal that keeps the mail
// out of spam. Same token, same rate limit (20/min per IP, server.js), same
// verifier either way.
//
// The token rides the query string on BOTH verbs, which is why this router
// still parses no body: the one-click POST carries a fixed
// `List-Unsubscribe=One-Click` form body that this file has no reason to read,
// and the form on the page puts its token in the action URL rather than a
// hidden field. __tests__/bodyLimitAudit.test.js records that.
//
// The token is signed with a key DERIVED from JWT_SECRET under a purpose label
// (services/venueDigest.js, round 25), so a session token cannot verify here
// and this one opens nothing else. This file does not verify anything itself.
//
// Unsubscribing twice is a success, not an error: the UPDATE has no predicate
// on the old value, so the second POST writes false over false and answers the
// same page. A venue that is already off never sees the button at all.
//
// The responses are small HTML pages, not JSON, because a person is looking at
// them. They flip venue_profiles.notification_prefs.weekly, the same column the
// dashboard's "Weekly reports" switch writes, so the dashboard shows the truth
// the next time the owner opens it.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');
const { applyOptOut, readOptOutState } = require('../services/venueDigest');
const { escapeHtml } = require('../services/emailService');

function page(title, body, action = '') {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #faf7f2; margin: 0; padding: 48px 24px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="font-size: 20px; color: #1a2b4a;">${title}</h1>
    <p style="font-size: 15px; color: #4a5568; line-height: 1.6;">${body}</p>${action}
  </div>
</body>
</html>`;
}

// The confirm step. `formAction` is built from the request's own path, not from
// the Host header and not from PUBLIC_API_URL, so it is correct behind any
// mount and any proxy without trusting a header to build it.
function confirmForm(formAction) {
  return `
    <form method="post" action="${escapeHtml(formAction)}" style="margin-top: 24px;">
      <button type="submit" style="font: inherit; font-size: 15px; background: #1a2b4a; color: #ffffff; border: 0; border-radius: 8px; padding: 12px 20px; cursor: pointer;">Turn off the Monday digest</button>
    </form>`;
}

const tokenValidator = [
  query('token').isString().notEmpty().withMessage('Token is required').isLength({ max: 2048 }),
];

const MISSING_TOKEN = [
  'That link is not right',
  'This unsubscribe link is missing its token. Open the link from the email again, or turn off Weekly reports in your venue dashboard.',
];

const BAD_TOKEN = [
  'That link has expired',
  'This unsubscribe link is no longer valid. You can still turn off Weekly reports in your venue dashboard, or use the link in a newer digest email.',
];

const DONE = [
  'You are unsubscribed',
  'The Monday digest for your venue is off. You can turn it back on any time with the Weekly reports switch in your venue dashboard.',
];

// GET: read and draw. Every branch here is a response and none of them writes.
router.get('/opt-out', tokenValidator, async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).type('html').send(page(...MISSING_TOKEN));
    }
    const state = await readOptOutState(req.query.token);
    if (!state.ok) {
      return res.status(400).type('html').send(page(...BAD_TOKEN));
    }
    if (state.alreadyOff) {
      return res.status(200).type('html').send(page(...DONE));
    }
    const action = `${req.baseUrl}${req.path}?token=${encodeURIComponent(req.query.token)}`;
    return res.status(200).type('html').send(page(
      'Turn off the Monday digest?',
      'This stops the weekly email for your venue. Nothing else about your account changes, and your dashboard keeps working the same way.',
      confirmForm(action)
    ));
  } catch (err) {
    console.error('Digest opt-out page error:', err);
    return res.status(500).type('html').send(page(
      'Something went wrong',
      'We could not load this link. Try again in a minute, or turn off Weekly reports in your venue dashboard.'
    ));
  }
});

// POST: the write. Reached from the button above and from a mail client doing
// RFC 8058 one-click.
router.post('/opt-out', tokenValidator, async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).type('html').send(page(...MISSING_TOKEN));
    }
    const result = await applyOptOut(req.query.token);
    if (!result.ok) {
      // `error` was computed by applyOptOut and read by nobody, so a database
      // failure and a dead token gave the owner the same page: "That link has
      // expired... no longer valid." The link was fine, `weekly` was still
      // true, and next Monday sent again. This path also serves RFC 8058
      // one-click, so Gmail recorded a failed unsubscribe against us. Same
      // split routes/unsubscribe.js already makes.
      if (result.error === 'server error') {
        console.error('[venueDigest] opt-out write failed for a valid token');
        return res.status(500).type('html').send(page(
          'We could not save that',
          'The link is fine. The request did not go through. Try again in a minute, or reply to the email and we will take you off the list by hand.'
        ));
      }
      return res.status(400).type('html').send(page(...BAD_TOKEN));
    }
    return res.status(200).type('html').send(page(...DONE));
  } catch (err) {
    console.error('Digest opt-out error:', err);
    return res.status(500).type('html').send(page(
      'Something went wrong',
      'We could not process this link. Try again in a minute, or turn off Weekly reports in your venue dashboard.'
    ));
  }
});

module.exports = router;
