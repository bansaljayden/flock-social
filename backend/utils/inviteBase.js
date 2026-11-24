// ---------------------------------------------------------------------------
// The base a shared link is minted on.
// ---------------------------------------------------------------------------
// Two links leave the app to be opened by somebody else: a plan's invite link
// (/i/<token>, routes/flocks.js) and a friend code's link (/add/<code>,
// GET /api/friends/my-code). Both are built here so they land on the same
// host, the one the iOS entitlement claims and the link preview uses, and a
// person who taps either one arrives on the origin their sign-in lives on.
//
// In production this is baseWebUrl(), which refuses anything that is not a
// public https URL and falls back to the canonical host. That is the fix this
// replaced: a raw env read whose fallback was a preview domain the iOS
// entitlement does not claim and the link preview does not use.
//
// Outside production the whole app can legitimately live on http://127.0.0.1,
// and it does (tools/e2e/stack.js). Handing that deployment a flockcorp.com
// link would point every tester at somebody else's data, so a local http
// origin is honoured there and nowhere else.
// ---------------------------------------------------------------------------
const { baseWebUrl } = require('../services/emailService');

function inviteBase() {
  const raw = (process.env.PUBLIC_WEB_URL || '').trim().replace(/\/+$/, '');
  if (process.env.NODE_ENV !== 'production' && /^https?:\/\/[^\s/]+/.test(raw)) return raw;
  return baseWebUrl();
}

module.exports = { inviteBase };
