// ---------------------------------------------------------------------------
// The links in the "Approve a Flock admin access key" email
// (services/adminKeyMail.js). Two verbs, and which one writes is the whole
// point, exactly as in routes/unsubscribe.js:
//
//   GET  /api/key-approval?token=...&do=approve|deny   draws a page. Writes nothing.
//   POST /api/key-approval?token=...&do=approve|deny   approves the key, or revokes it.
//
// Mail scanners (Defender Safe Links, Proofpoint, Gmail and Outlook previews)
// fetch every link in a message with a plain GET. If the GET approved, a
// scanner would approve a key nobody looked at, and if it revoked, a scanner
// would kill every key the owner asked for. So the GET draws the key's name,
// when and where it was asked for and when it would expire, with one button,
// and only the button POSTs.
//
// NO SESSION, on purpose. The owner taps this in a phone's mail app, where
// there is no Flock sign-in, and that is the reason the email exists: holding
// the one-use token is the proof of the mailbox, and the mailbox is the step up
// a fresh sign-in would otherwise be. The token is 32 random bytes, stored only
// as its hash (migration 135), good once, and dead 15 minutes after the mint.
// A key that was revoked, approved, ran out of time, or whose account signed
// out everywhere since, can no longer be approved; every such case draws a
// page that says which. middleware/adminKeys.js holds the statements, each
// carrying all of its conditions in its own WHERE so a second tap or a revoke
// racing an approval changes nothing.
//
// The page sets its own Content-Security-Policy: no scripts at all, styles
// inline only, and the form may post only to this host.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const adminKeys = require('../middleware/adminKeys');
const adminKeyMail = require('../services/adminKeyMail');
const { escapeHtml } = require('../services/emailService');

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// `paragraphs` is one paragraph or a list, as HTML: constants, or text the
// caller already escaped.
function send(res, status, title, paragraphs, action = '') {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', PAGE_CSP);
  res.set('X-Robots-Tag', 'noindex');
  const list = Array.isArray(paragraphs) ? paragraphs : [paragraphs];
  const body = list.map((p) => `<p style="font-size: 16px; color: #4a5568; line-height: 1.6;">${p}</p>`).join('\n    ');
  return res.status(status).type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #faf7f2; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="font-size: 22px; color: #1a2b4a;">${escapeHtml(title)}</h1>
    ${body}${action}
  </div>
</body>
</html>`);
}

// The form posts back to the path it was drawn from, built from the request's
// own path rather than the Host header, with the token and the action in the
// query string as the link had them.
function confirmForm(req, token, action, label, danger) {
  const target = `${req.baseUrl}${req.path}?token=${encodeURIComponent(token)}&do=${action}`;
  const colour = danger ? '#9b2c2c' : '#1a2b4a';
  return `
    <form method="post" action="${escapeHtml(target)}" style="margin-top: 24px;">
      <button type="submit" style="font: inherit; font-size: 17px; font-weight: 600; background: ${colour}; color: #ffffff; border: 0; border-radius: 10px; padding: 14px 24px; width: 100%; cursor: pointer;">${escapeHtml(label)}</button>
    </form>`;
}

const fact = (label, value) => `${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong>`;

// Why a link cannot be used, in words, by approvalState().
const CANNOT = {
  invalid: ['This link does not work', 'It is not a link Flock sent, or it has been changed. Open it from the email again.'],
  used: ['This link was already used', 'Each link works once.'],
  approved: ['This key is already approved', 'It works now. Revoke it any time on the Admin dashboard under Access keys.'],
  revoked: ['This key is revoked', 'It will never work. Mint a new key if you need one.'],
  expired: ['This link has expired', 'An approval link works for 15 minutes. The key it was for was never approved, so it will never work. Mint a new key to try again.'],
  ended: ['This key can no longer be approved', 'The account signed out everywhere, changed its password, or stopped being an admin after the key was asked for, so the key will never work. Mint a new one if you need it.'],
};

function readLink(req) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const action = req.query.do === 'approve' || req.query.do === 'deny' ? req.query.do : null;
  return { token, action };
}

router.get('/', async (req, res) => {
  try {
    const { token, action } = readLink(req);
    if (!action || !adminKeys.isApprovalTokenShape(token)) return send(res, 400, ...CANNOT.invalid);
    const row = await adminKeys.findApproval(token);
    const state = adminKeys.approvalState(row);
    if (state !== 'open') return send(res, state === 'invalid' ? 404 : 410, ...CANNOT[state]);
    const facts = [
      fact('Name', row.name),
      fact('Asked for', `${adminKeyMail.when(row.created_at)} from ${row.created_ip || 'an unknown address'}`),
      fact('Works until', `${adminKeyMail.day(row.expires_at)}, if approved`),
    ].join('<br />');
    if (action === 'approve') {
      return send(res, 200, 'Approve this admin access key?', [
        'An admin access key was asked for on your Flock account. Approve it only if you asked for it: it can use the admin routes as you until it expires or you revoke it.',
        facts,
      ], confirmForm(req, token, 'approve', 'Approve the key', false)
        + `<p style="font-size: 15px; color: #4a5568; line-height: 1.6; margin-top: 20px;">Not you? <a href="${escapeHtml(`${req.baseUrl}${req.path}?token=${encodeURIComponent(token)}&do=deny`)}" style="color: #9b2c2c;">Revoke it instead</a>.</p>`);
    }
    return send(res, 200, 'Revoke this admin access key?', [
      'If you did not ask for this key, revoke it. It will never work, and you should change your password, which signs out every session.',
      facts,
    ], confirmForm(req, token, 'deny', 'Revoke the key', true));
  } catch (err) {
    console.error('[key-approval] page failed:', err.message);
    return send(res, 500, 'Something went wrong', ['This link could not be read. Try again in a minute.']);
  }
});

router.post('/', async (req, res) => {
  try {
    const { token, action } = readLink(req);
    if (!action || !adminKeys.isApprovalTokenShape(token)) return send(res, 400, ...CANNOT.invalid);
    const out = await adminKeys.settleApproval(token, action, req.ip);
    if (!out.done) return send(res, out.state === 'invalid' ? 404 : 409, ...CANNOT[out.state === 'open' ? 'used' : out.state]);
    const k = out.row;
    if (action === 'approve') {
      console.log(`[admin-key] key ${k.id} ("${k.name}") approved from its email link, from ${req.ip}`);
      await adminKeyMail.notify(adminKeyMail.sendKeyApproved, {
        to: k.owner_email, name: k.owner_name, keyName: k.name, expiresAt: k.expires_at, ip: req.ip, at: k.approved_at,
      }, 'key approved');
      return send(res, 200, 'The key is approved', [
        `"${escapeHtml(k.name)}" works now, until ${escapeHtml(adminKeyMail.day(k.expires_at))}. Revoke it any time on the Admin dashboard under Access keys.`,
      ]);
    }
    console.log(`[admin-key] key ${k.id} ("${k.name}") revoked from its email link, from ${req.ip}`);
    await adminKeyMail.notify(adminKeyMail.sendKeyRevoked, {
      to: k.owner_email, name: k.owner_name, keyName: k.name, ip: req.ip, at: k.revoked_at, via: 'email',
    }, 'key revoked');
    return send(res, 200, 'The key is revoked', [
      `"${escapeHtml(k.name)}" will never work. If you did not ask for it, someone is signed in as you: change your password, which signs out every session.`,
    ]);
  } catch (err) {
    console.error('[key-approval] action failed:', err.message);
    return send(res, 500, 'Something went wrong', ['Nothing was changed. Try again in a minute.']);
  }
});

module.exports = router;
