'use strict';
// ---------------------------------------------------------------------------
// The emails about admin access keys (middleware/adminKeys.js), to the address
// on the account the key belongs to.
// ---------------------------------------------------------------------------
// Four of them:
//
//   sendKeyApproval  a mint from a session that did not sign in within the
//                    last 15 minutes makes a PENDING key, and this is the only
//                    way it ever works: an Approve link and a "This wasn't me"
//                    link, each carrying the one-use approval token
//                    (routes/keyApproval.js). Holding the link is the proof
//                    that the mailbox owner asked for the key.
//   sendKeyMinted    a mint from a session that had just signed in, which
//                    works at once, so the owner hears of it anyway.
//   sendKeyApproved  a pending key approved from its email.
//   sendKeyRevoked   any revoke: the dashboard, the key itself, the email link.
//
// Through services/emailService.js like every other message, so the do-not-mail
// list, the per-address cap and the pinned API address apply. Held as the
// module object, not destructured, so a test that replaces sendEmail is the
// sender these use. Times are New York time, the zone the rest of the admin
// console uses. No message carries the key.
// ---------------------------------------------------------------------------

const emailService = require('./emailService');

const ZONE = 'America/New_York';

// "Nov 5, 2026, 3:04 PM EST".
function when(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'an unknown time';
  return d.toLocaleString('en-US', {
    timeZone: ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// "Feb 3, 2027".
function day(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'an unknown day';
  return d.toLocaleDateString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', year: 'numeric' });
}

// The two links in an approval email, on the API's pinned address, never one
// built from a request's Host header.
function approvalLinks(token) {
  const base = `${emailService.baseApiUrl()}/api/key-approval?token=${encodeURIComponent(token)}`;
  return { approve: `${base}&do=approve`, deny: `${base}&do=deny` };
}

const esc = (s) => emailService.escapeHtml(s);

// `paragraphs` and `after` are HTML already escaped by the caller; `after`
// goes under the buttons, in the smaller type.
function shell(title, paragraphs, buttons = [], after = []) {
  const logo = `${emailService.baseWebUrl()}/flock-logo.png`;
  const p = (html) => `<p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin: 0 0 16px;">${html}</p>`;
  const small = (html) => `<p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin: 0 0 16px;">${html}</p>`;
  const button = ({ href, label, quiet }) => `
        <p style="margin: 0 0 16px;">
          <a href="${esc(href)}" style="display: inline-block; background: ${quiet ? '#ffffff' : '#0d2847'}; color: ${quiet ? '#0d2847' : '#ffffff'}; border: 2px solid #0d2847; text-decoration: none; padding: 12px 26px; border-radius: 10px; font-size: 16px; font-weight: 600;">${esc(label)}</a>
        </p>`;
  return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="${esc(logo)}" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
        </div>
        <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">${esc(title)}</h1>
        ${paragraphs.map(p).join('\n        ')}
        ${buttons.map(button).join('')}
        ${after.map(small).join('\n        ')}
        <p style="font-size: 14px; color: #a0aec0;">The Flock Team</p>
      </div>
    `;
}

const facts = (rows) => rows.map(([k, v]) => `${esc(k)}: <strong>${esc(v)}</strong>`).join('<br />');

// What to do when a key event was not the owner. A password change signs every
// session out (routes/users.js), which also ends every key minted before it.
const NOT_YOU = 'If it was not you, someone is signed in as you: revoke the key, then change your password, which signs out every session.';

async function sendKeyApproval({ to, name, keyName, expiresAt, ip, at, token, minutes = 15 }) {
  const links = approvalLinks(token);
  const hi = `Hi ${name || 'there'}, an admin access key was asked for on your Flock account.`;
  const rows = [
    ['Name', keyName],
    ['Asked for', `${when(at)} from ${ip || 'an unknown address'}`],
    ['Works until', `${day(expiresAt)}, if approved`],
  ];
  return emailService.sendEmail({
    to,
    subject: 'Approve a Flock admin access key',
    text: [
      'Approve a Flock admin access key',
      '',
      hi,
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      '',
      `Approve it here. The link works once and expires in ${minutes} minutes:`,
      links.approve,
      '',
      'If you did not ask for this, revoke it here:',
      links.deny,
      '',
      `The key does nothing until it is approved. ${NOT_YOU}`,
      '',
      'The Flock Team',
    ].join('\n'),
    html: shell('Approve a Flock admin access key', [
      esc(hi),
      facts(rows),
      esc(`Approve it only if you asked for it. The link works once and expires in ${minutes} minutes.`),
    ], [
      { href: links.approve, label: 'Approve the key' },
      { href: links.deny, label: "This wasn't me", quiet: true },
    ], [esc(`The key does nothing until it is approved. ${NOT_YOU}`)]),
  });
}

async function sendKeyMinted({ to, name, keyName, expiresAt, ip, at }) {
  const hi = `Hi ${name || 'there'}, an admin access key was made on your Flock account from a session that had just signed in, so it works now.`;
  const rows = [['Name', keyName], ['Made', `${when(at)} from ${ip || 'an unknown address'}`], ['Works until', day(expiresAt)]];
  const tail = `If this was you, there is nothing to do. ${NOT_YOU} Keys are revoked on the Admin dashboard under Access keys.`;
  return emailService.sendEmail({
    to,
    subject: 'A Flock admin access key was made',
    text: ['A Flock admin access key was made', '', hi, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', tail, '', 'The Flock Team'].join('\n'),
    html: shell('A Flock admin access key was made', [esc(hi), facts(rows), esc(tail)]),
  });
}

async function sendKeyApproved({ to, name, keyName, expiresAt, ip, at }) {
  const hi = `Hi ${name || 'there'}, the admin access key "${keyName}" was approved from the link in its email, so it works now.`;
  const rows = [['Approved', `${when(at)} from ${ip || 'an unknown address'}`], ['Works until', day(expiresAt)]];
  const tail = `If you did not approve it, revoke it on the Admin dashboard under Access keys, then change your password, which signs out every session.`;
  return emailService.sendEmail({
    to,
    subject: 'Flock admin access key approved',
    text: ['A Flock admin access key was approved', '', hi, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', tail, '', 'The Flock Team'].join('\n'),
    html: shell('A Flock admin access key was approved', [esc(hi), facts(rows), esc(tail)]),
  });
}

const REVOKED_HOW = {
  session: 'from the Admin dashboard',
  key: 'by the key itself',
  email: "from the \"This wasn't me\" link in its email",
};

async function sendKeyRevoked({ to, name, keyName, ip, at, via }) {
  const how = REVOKED_HOW[via] || 'on the server';
  const hi = `Hi ${name || 'there'}, the admin access key "${keyName}" was revoked ${how}. It no longer works.`;
  const rows = [['Revoked', `${when(at)} from ${ip || 'an unknown address'}`]];
  const tail = via === 'email'
    ? 'If you did not ask for that key, someone is signed in as you: change your password, which signs out every session.'
    : 'If you did not revoke it, someone is signed in as you: change your password, which signs out every session and ends every key.';
  return emailService.sendEmail({
    to,
    subject: 'Flock admin access key revoked',
    text: ['A Flock admin access key was revoked', '', hi, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', tail, '', 'The Flock Team'].join('\n'),
    html: shell('A Flock admin access key was revoked', [esc(hi), facts(rows), esc(tail)]),
  });
}

// A notification that does not go out must never fail what it reports on.
async function notify(send, args, label) {
  try {
    const out = await send(args);
    if (!out || !out.sent) {
      console.warn(`[admin-key] the "${label}" email was not sent to ${emailService.maskAddress(args.to)} (${(out && (out.error || out.reason)) || 'skipped'})`);
    }
    return out;
  } catch (err) {
    console.error(`[admin-key] the "${label}" email failed: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendKeyApproval,
  sendKeyMinted,
  sendKeyApproved,
  sendKeyRevoked,
  notify,
  approvalLinks,
  when,
  day,
};
