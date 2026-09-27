/**
 * WHICH SIGN-IN A TOKEN BELONGS TO, read off the token itself.
 *
 * The access token used to change only when the account did: a sign-in, a
 * sign-out, a switch. So "the token moved" and "somebody else is signed in"
 * were the same fact, and several places keyed identity on the token string
 * (the Roost advisor thread and insight cards compare its tail, the socket
 * rebuilds on any change). A session is renewed now (services/api.js
 * renewSession, backend/services/refreshTokens.js): the token changes about
 * once a day for the SAME person, and every one of those places would have
 * read a renewal as an account switch, dropping an owner's advisor thread or
 * discarding the answer to the question they had just asked.
 *
 * What stays the same across a renewal is the account (userId) and the moment
 * the person signed in (auth_time, which the server carries over unchanged on
 * every renewal). Together they name one sign-in: a renewal keeps them, and a
 * sign-out, a new sign-in or an account switch changes them.
 *
 * DECODED, NEVER VERIFIED, and that is fine for what this answers. Nothing here
 * decides what anybody may do; the server verifies every token it is sent.
 * This only tells two tokens this device already holds apart.
 */

// The payload of a JWT as an object, or null for anything that is not one.
export function tokenClaims(token) {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    return claims && typeof claims === 'object' ? claims : null;
  } catch (_) {
    return null;
  }
}

// One string per sign-in, or null when the token names no account. A token
// minted before auth_time existed was minted at a sign-in and never renewed,
// so its iat stands in: each such token is its own sign-in, which is exactly
// what the token string used to mean.
export function signInKey(token) {
  const claims = tokenClaims(token);
  if (!claims || claims.userId === undefined || claims.userId === null) return null;
  const at = Number.isInteger(claims.auth_time) ? claims.auth_time : `iat${claims.iat}`;
  return `${claims.userId}:${at}`;
}

export function sameSignIn(a, b) {
  const key = signInKey(a);
  return key !== null && key === signInKey(b);
}
