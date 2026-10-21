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
//   APPLE_CLIENT_ID (the iPhone app's bundle id, defaults to com.flockcorp.flock)
// Optional:
//   APPLE_WEB_CLIENT_ID (the website's Services ID, defaults to
//   com.flockcorp.flock.web)
//
// TWO CLIENTS, ONE KEY. Sign in with Apple runs in the iPhone app under the
// bundle id and on flockcorp.com under a Services ID grouped with it (Apple
// Developer portal, 20 Oct 2026). Apple ties every authorization code and
// every refresh token to the client that asked for it: a code the website got
// can only be exchanged as the website, and its refresh token can only be
// revoked as the website. The same .p8 key signs the client secret for both;
// only the secret's `sub` changes. So each exchange and each revocation names
// its client, and users.apple_refresh_client_id (migration 128) remembers which
// one issued the stored token. NULL there means the app, which is what every
// token stored before the website could sign in with Apple was.
// ---------------------------------------------------------------------------
const jwt = require('jsonwebtoken');

const { upstreamSignal } = require('../utils/upstream');

const TEAM_ID = process.env.APPLE_TEAM_ID;
const KEY_ID = process.env.APPLE_KEY_ID;
const CLIENT_ID = process.env.APPLE_CLIENT_ID || 'com.flockcorp.flock';
const WEB_CLIENT_ID = process.env.APPLE_WEB_CLIENT_ID || 'com.flockcorp.flock.web';
// Env-stored PEM often has literal "\n" — normalize to real newlines.
const PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function isConfigured() {
  return !!(TEAM_ID && KEY_ID && PRIVATE_KEY);
}

// Only the two clients this server knows. Anything else, a stored NULL
// included, is the app, so a typo or an old row can never send the key's
// secret out under a client id nobody registered.
function knownClientId(clientId) {
  return clientId === WEB_CLIENT_ID ? WEB_CLIENT_ID : CLIENT_ID;
}

function clientSecret(clientId = CLIENT_ID) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: knownClientId(clientId) },
    PRIVATE_KEY,
    { algorithm: 'ES256', keyid: KEY_ID }
  );
}

// Exchange the one-time authorizationCode for tokens (incl. refresh_token).
// `clientId`: the client the code was issued to (the website's Services ID for
// a sign-in on flockcorp.com); omitted, the app.
async function exchangeAppleCode(code, clientId) {
  if (!isConfigured() || !code) return null;
  const cid = knownClientId(clientId);
  const body = new URLSearchParams({
    client_id: cid,
    client_secret: clientSecret(cid),
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: upstreamSignal('oauth'), // round 12 — see utils/upstream.js
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Apple code exchange failed:', data.error || res.status); return null; }
  return data; // { access_token, refresh_token, id_token, ... }
}

// Revoke a stored refresh token on account deletion. `clientId` is the
// client that issued it (users.apple_refresh_client_id); Apple refuses a
// revocation sent as any other client, so a website token revoked as the app
// would fail and deletion would stop on it.
async function revokeAppleToken(refreshToken, clientId) {
  if (!refreshToken) return false;
  if (!isConfigured()) {
    console.warn('Apple revoke skipped — APPLE_* signing env not configured.');
    return false;
  }
  try {
    const cid = knownClientId(clientId);
    const body = new URLSearchParams({
      client_id: cid,
      client_secret: clientSecret(cid),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
    const res = await fetch('https://appleid.apple.com/auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: upstreamSignal('oauth'), // round 12 — deletion must not hang on Apple
    });
    if (!res.ok) { console.error('Apple token revoke failed:', res.status); return false; }
    return true;
  } catch (e) {
    console.error('Apple token revoke error:', e.message);
    return false;
  }
}

module.exports = { isConfigured, exchangeAppleCode, revokeAppleToken, knownClientId, CLIENT_ID, WEB_CLIENT_ID };
