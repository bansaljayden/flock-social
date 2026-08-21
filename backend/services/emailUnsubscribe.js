// ---------------------------------------------------------------------------
// The unsubscribe token for address-keyed mail.
// ---------------------------------------------------------------------------
// The Monday digest already had an opt-out link, because it is a recurring
// mailing to a venue owner and CAN-SPAM is explicit about those. The WAITLIST
// confirmation did not, and it is the message that says "We'll let you know as
// soon as it's ready" — an announced future mailing to a list of addresses
// collected on a public marketing page, with no way off it in the message and
// no column in the table to record that somebody wanted off. That is the
// commercial-email case CAN-SPAM §7704(a)(3) is actually about.
//
// The digest's opt-out is keyed on a venue_profiles row, so it could not be
// reused: a waitlist subscriber has no account and no row of their own worth
// pointing at. This token is keyed on the ADDRESS, and it is what the
// unsubscribe route turns into a row in email_suppressions.
//
// SCOPING. The token carries the address it is for, and the signature covers
// that address. One recipient's link cannot unsubscribe another, because
// changing the address invalidates the MAC and there is nothing else in the
// link to change. There is no id to enumerate and no sequence to walk.
//
// THE KEY IS DERIVED, not JWT_SECRET itself, exactly as services/venueDigest.js
// round 25 established: an HMAC of JWT_SECRET under a purpose label is a
// different key, so a session token cannot verify here and a token minted here
// opens nothing else, whatever claims either carries and whoever forgets a
// check later.
//
// NO EXPIRY, deliberately, and this is the one place that is right. A digest
// opt-out expires in 180 days because a newer digest always carries a fresher
// link. A waitlist confirmation is sent ONCE. A link that stops working is a
// person who can no longer unsubscribe from the message they were given, which
// is the failure the requirement exists to prevent. The token authorises
// exactly one irreversible-in-the-safe-direction act: adding an address to the
// do-not-mail list.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const PURPOSE = 'email_unsubscribe';
const KEY_LABEL = `flock:${PURPOSE}:v1`;

function unsubscribeKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', String(secret)).update(KEY_LABEL).digest();
}

// Base64url, so the token survives a query string, a mail client's line
// wrapping, and a copy-paste out of a plain-text part without escaping.
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function normalize(addr) {
  return typeof addr === 'string' ? addr.trim().toLowerCase() : '';
}

// `<base64url(address)>.<base64url(mac)>`. Not a JWT: there are no claims worth
// carrying, and a format with no algorithm field is a format with no algorithm
// confusion.
function mintUnsubscribeToken(address) {
  const key = unsubscribeKey();
  const addr = normalize(address);
  if (!key || !addr) return null;
  const body = b64url(addr);
  const mac = crypto.createHmac('sha256', key).update(`${PURPOSE}.${body}`).digest();
  return `${body}.${b64url(mac)}`;
}

// Returns the address the token is for, or null. Never throws.
function verifyUnsubscribeToken(token) {
  const key = unsubscribeKey();
  if (!key || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  let given;
  try {
    given = fromB64url(sig);
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', key).update(`${PURPOSE}.${body}`).digest();
  // Length check first: timingSafeEqual THROWS on a length mismatch, and this
  // sits behind a public route.
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;
  let addr;
  try {
    addr = fromB64url(body).toString('utf8');
  } catch {
    return null;
  }
  return normalize(addr) || null;
}

module.exports = {
  mintUnsubscribeToken,
  verifyUnsubscribeToken,
  PURPOSE,
};
