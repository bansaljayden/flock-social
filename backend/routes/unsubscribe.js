// ---------------------------------------------------------------------------
// The address-keyed unsubscribe link. Two verbs, and which one writes is the
// whole point, exactly as in routes/venueDigest.js.
//
//   GET  /api/unsubscribe?token=...   renders. Writes nothing.
//   POST /api/unsubscribe?token=...   adds the address to email_suppressions.
//
// A URL in an email is fetched by things that are not the recipient: Microsoft
// Defender Safe Links rewrites and follows every href in a message, Proofpoint
// URL Defense does the same, and Gmail and Outlook prefetch for previews. All
// of them issue a plain unattended GET. If the GET were the write, every one of
// those would be somebody silently removed from a list they had asked to be on,
// with no way for anyone to notice. So the GET reads and draws a page with a
// button, and the button POSTs.
//
// NO LOGIN, and that is the requirement rather than an oversight. A waitlist
// subscriber has no Flock account at all, so an unsubscribe behind a sign-in
// would be an unsubscribe nobody on this list could use. The token in the query
// string is the whole authorisation: it is an HMAC over the address under a key
// derived from JWT_SECRET (services/emailUnsubscribe.js), so one recipient's
// link cannot take another recipient off the list, and it opens nothing else.
//
// Unsubscribing twice is a success, not an error: the write is an upsert with
// no predicate on the old value.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const { query, validationResult } = require('express-validator');
const { verifyUnsubscribeToken } = require('../services/emailUnsubscribe');
const { suppress, suppressionReason } = require('../services/emailSuppression');
const { escapeHtml, maskAddress } = require('../services/emailService');

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

// `formAction` is built from the request's own path, not from the Host header
// and not from PUBLIC_API_URL, so it is correct behind any mount and any proxy
// without trusting a header to build it.
function confirmForm(formAction) {
  return `
    <form method="post" action="${escapeHtml(formAction)}" style="margin-top: 24px;">
      <button type="submit" style="font: inherit; font-size: 15px; background: #1a2b4a; color: #ffffff; border: 0; border-radius: 8px; padding: 12px 20px; cursor: pointer;">Take me off the list</button>
    </form>`;
}

const tokenValidator = [
  query('token').isString().notEmpty().withMessage('Token is required').isLength({ max: 2048 }),
];

const MISSING_TOKEN = [
  'That link is not right',
  'This unsubscribe link is missing its token. Open the link from the email again.',
];

const BAD_TOKEN = [
  'That link is not valid',
  'This unsubscribe link did not check out. Open the link from the email again, or reply to the email and we will take you off the list by hand.',
];

const DONE = [
  'You are off the list',
  'This address will not get Flock announcements again. Emails you ask for yourself, like a password reset, still work.',
];

// The page deliberately does NOT print the address. Anyone holding the link
// already knows it, so showing it buys nothing, and a page that echoes an
// address is a page that turns a forwarded email into a way to confirm one.
router.get('/', tokenValidator, async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).type('html').send(page(...MISSING_TOKEN));
    }
    const address = verifyUnsubscribeToken(req.query.token);
    if (!address) {
      return res.status(400).type('html').send(page(...BAD_TOKEN));
    }
    if (await suppressionReason(address)) {
      return res.status(200).type('html').send(page(...DONE));
    }
    const action = `${req.baseUrl}${req.path}?token=${encodeURIComponent(req.query.token)}`;
    return res.status(200).type('html').send(page(
      'Stop Flock emails to this address?',
      'This takes the address off the Flock announcement list. Nothing else changes, and messages you ask for yourself still arrive.',
      confirmForm(action)
    ));
  } catch (err) {
    console.error('Unsubscribe page error:', err.message);
    return res.status(500).type('html').send(page(
      'Something went wrong',
      'We could not load this link. Try again in a minute, or reply to the email and we will take you off the list by hand.'
    ));
  }
});

router.post('/', tokenValidator, async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).type('html').send(page(...MISSING_TOKEN));
    }
    const address = verifyUnsubscribeToken(req.query.token);
    if (!address) {
      return res.status(400).type('html').send(page(...BAD_TOKEN));
    }
    const ok = await suppress(address, 'unsubscribe', 'unsubscribe link');
    if (!ok) {
      // The write is the whole point of this verb, so a failed one must not
      // answer with the page that says it worked. The address is masked in the
      // log for the same reason it is everywhere else in this codebase.
      console.error('[unsubscribe] could not record the opt-out for', maskAddress(address));
      return res.status(500).type('html').send(page(
        'We could not save that',
        'The request did not go through. Try again in a minute, or reply to the email and we will take you off the list by hand.'
      ));
    }
    return res.status(200).type('html').send(page(...DONE));
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    return res.status(500).type('html').send(page(
      'Something went wrong',
      'We could not process this link. Try again in a minute, or reply to the email and we will take you off the list by hand.'
    ));
  }
});

module.exports = router;
