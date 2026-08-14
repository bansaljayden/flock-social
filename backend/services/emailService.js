// ---------------------------------------------------------------------------
// Transactional email (round 16)
// ---------------------------------------------------------------------------
// Resend was called directly from two places (routes/safety.js and
// routes/waitlist.js), each with its own copy of the client, the null-key skip
// and the 8s abort signal. Email verification is the third caller and the first
// one that mails a SECRET, so the shared behaviour lives here instead of being
// copied a third time:
//
//   * the client is built lazily, not at require time, so a module loaded
//     before dotenv (or in a test) does not permanently capture a missing key;
//   * a missing RESEND_API_KEY is a skip with a warning, never a throw — the
//     same fail-soft the other two callers already had;
//   * every send carries upstreamSignal('email') (round 12: an undeadlined
//     fetch parks an Express connection and a pg pool slot for ~5 minutes);
//   * links are built from a PINNED production base URL, never from the
//     request. See baseWebUrl below — this is the half that matters.
// ---------------------------------------------------------------------------
const { upstreamSignal } = require('../utils/upstream');

// The hosts we are willing to put in an email. A link in an email outlives the
// request that made it and is clicked on a device that is not the one that
// triggered it, so `localhost` in a verification link is not a cosmetic bug: it
// is a link that can never work, mailed to a real person, for the one action
// that unlocks their account.
const PROD_WEB_URL = 'https://flockcorp.com';
const PROD_API_URL = 'https://flock-app-production.up.railway.app';

// True for anything that would produce a dead or downgraded link: a non-https
// scheme, a loopback / link-local / .local host, or junk that does not parse.
function isUnmailableBase(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return true;
  }
  if (u.protocol !== 'https:') return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function pickBase(envValue, fallback, label) {
  if (isUnmailableBase(envValue)) {
    if (envValue) {
      console.warn(`[email] ${label} is not a public https URL ("${envValue}") — mailing ${fallback} instead`);
    }
    return fallback;
  }
  return envValue.trim().replace(/\/+$/, '');
}

// Where a human lands. PUBLIC_WEB_URL is the same variable the invite links and
// the NFC redirect already use.
function baseWebUrl() {
  return pickBase(process.env.PUBLIC_WEB_URL, PROD_WEB_URL, 'PUBLIC_WEB_URL');
}

// Where the verification link points. It has to be the API, not the web app:
// the API is what can actually consume the token, and it redirects the browser
// back to the web app afterwards. Deliberately NOT derived from req.protocol /
// req.get('host') — the Host header is attacker-controlled, and building an
// emailed secret's URL out of it is textbook host-header injection.
function baseApiUrl() {
  return pickBase(process.env.PUBLIC_API_URL, PROD_API_URL, 'PUBLIC_API_URL');
}

let client = null;
function resendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!client) {
    const { Resend } = require('resend');
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
}

// Reset point for tests and for a key rotation that swaps the env in place.
function resetClient() {
  client = null;
}

// Never throws. Returns { sent } | { skipped } | { sent: false, error }.
async function sendEmail({ to, subject, html, from = 'Flock <hello@flockcorp.com>' }) {
  const resend = resendClient();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping email to', to);
    return { sent: false, skipped: true };
  }
  try {
    const { data, error } = await resend.emails.send(
      { from, to, subject, html },
      { signal: upstreamSignal('email') }
    );
    if (error) {
      console.error('[email] Resend error for', to, JSON.stringify(error));
      return { sent: false, error: error.message || 'send failed' };
    }
    console.log('[email] sent to', to, 'id:', data?.id);
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('[email] send failed for', to, err.message);
    return { sent: false, error: err.message };
  }
}

function verificationLink(token) {
  return `${baseApiUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Copy rules (SLOP-AUDIT.md): no em dashes, no marketing words, sounds like a
// person. The name is UGC and is HTML-escaped even though it was screened at
// signup, because this is the one place it is rendered outside our own client.
async function sendVerificationEmail({ to, name, link, hours }) {
  const safeName = escapeHtml(name || 'there');
  const safeLink = escapeHtml(link);
  return sendEmail({
    to,
    subject: 'Confirm your email for Flock',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="${baseWebUrl()}/flock-logo.png" alt="Flock" width="64" height="64" style="border-radius: 16px;" />
        </div>
        <h1 style="font-size: 24px; font-weight: 700; color: #0d2847; margin-bottom: 16px;">Confirm your email</h1>
        <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          Hi ${safeName}, someone created a Flock account with this address. Confirm it and the account is yours.
        </p>
        <p style="margin: 0 0 24px;">
          <a href="${safeLink}" style="display: inline-block; background: #0d2847; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-size: 16px; font-weight: 600;">Confirm my email</a>
        </p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          This link works once and expires in ${hours} hours. If the button does nothing, paste this into your browser:<br />
          <span style="word-break: break-all; color: #2b6cb0;">${safeLink}</span>
        </p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6; margin-bottom: 24px;">
          If you did not sign up, ignore this. Without a confirmation the account cannot add friends, join plans, or store payment handles, and it will stay that way.
        </p>
        <p style="font-size: 14px; color: #a0aec0;">The Flock Team</p>
      </div>
    `,
  });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  verificationLink,
  baseWebUrl,
  baseApiUrl,
  isUnmailableBase,
  resetClient,
  PROD_WEB_URL,
  PROD_API_URL,
};
