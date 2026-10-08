// The share-card signature, checked here before any request leaves for the
// renderer. Same contract as cardSignature() in api/invite-preview.js and the
// backend route: HMAC-SHA256 over "name\nwhen\ngoing" with OG_CARD_SECRET,
// base64url, first 22 characters.
const encoder = new TextEncoder();
let cachedSecret = null;
let cachedKey = null;

// Under this many characters (after trimming) the secret counts as unset,
// as it does for the signer and the backend route: every preview publishes
// n, w, g and the signature, so a short secret could be worked out offline
// from one shared link.
export const MIN_SECRET = 32;

let shortSecretLogged = false;

// The trimmed OG_CARD_SECRET from the Function's env, or '' when it is unset
// or too short. The line it logs, once per isolate, names the length and
// never the value.
export function cardSecret(env) {
  const secret = env && typeof env.OG_CARD_SECRET === 'string' ? env.OG_CARD_SECRET.trim() : '';
  if (secret.length >= MIN_SECRET) return secret;
  if (secret && !shortSecretLogged) {
    shortSecretLogged = true;
    console.error('invite-og: OG_CARD_SECRET is ' + secret.length + ' characters; under ' + MIN_SECRET
      + ' it counts as unset, so every card is the static banner.');
  }
  return '';
}

function hmacKey(secret) {
  if (secret !== cachedSecret) {
    cachedSecret = secret;
    cachedKey = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return cachedKey;
}

export async function cardSignature(secret, name, when, going) {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(name + '\n' + when + '\n' + going)));
  let binary = '';
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

export function sameSignature(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
