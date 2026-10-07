// The share-card signature, checked here before any request leaves for the
// renderer. Same contract as cardSignature() in api/invite-preview.js and the
// backend route: HMAC-SHA256 over "name\nwhen\ngoing" with OG_CARD_SECRET,
// base64url, first 22 characters.
const encoder = new TextEncoder();
let cachedSecret = null;
let cachedKey = null;

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
