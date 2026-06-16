// ---------------------------------------------------------------------------
// Sign in with Apple — server-to-server token exchange + revocation.
//
// Apple 5.1.1(v): when an app offers Sign in with Apple, account deletion MUST
// revoke the user's Apple tokens via Apple's REST API. To do that we need the
// user's refresh token, which we obtain by exchanging the one-time
// authorizationCode at sign-in.
//
// Everything here is GATED on the APPLE_* signing env being present, so it is a
// safe no-op until you configure it (Apple Developer .p8 key, key id, team id).
// Account deletion never fails just because revocation is unconfigured.
//
// Required env (set in Railway, never commit):
//   APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (.p8 contents),
//   APPLE_CLIENT_ID (the services/bundle id, defaults to com.flockcorp.flock)
// ---------------------------------------------------------------------------
const jwt = require('jsonwebtoken');

const TEAM_ID = process.env.APPLE_TEAM_ID;
const KEY_ID = process.env.APPLE_KEY_ID;
const CLIENT_ID = process.env.APPLE_CLIENT_ID || 'com.flockcorp.flock';
// Env-stored PEM often has literal "\n" — normalize to real newlines.
const PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function isConfigured() {
  return !!(TEAM_ID && KEY_ID && PRIVATE_KEY);
}

function clientSecret() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: CLIENT_ID },
    PRIVATE_KEY,
    { algorithm: 'ES256', keyid: KEY_ID }
  );
}

// Exchange the one-time authorizationCode for tokens (incl. refresh_token).
async function exchangeAppleCode(code) {
  if (!isConfigured() || !code) return null;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: clientSecret(),
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Apple code exchange failed:', data.error || res.status); return null; }
  return data; // { access_token, refresh_token, id_token, ... }
}

// Revoke a stored refresh token on account deletion.
async function revokeAppleToken(refreshToken) {
  if (!refreshToken) return false;
  if (!isConfigured()) {
    console.warn('Apple revoke skipped — APPLE_* signing env not configured.');
    return false;
  }
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: clientSecret(),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
    const res = await fetch('https://appleid.apple.com/auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) { console.error('Apple token revoke failed:', res.status); return false; }
    return true;
  } catch (e) {
    console.error('Apple token revoke error:', e.message);
    return false;
  }
}

module.exports = { isConfigured, exchangeAppleCode, revokeAppleToken };
