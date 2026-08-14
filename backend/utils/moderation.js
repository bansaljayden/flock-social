// ---------------------------------------------------------------------------
// UGC content moderation (Apple 1.2 / Google UGC policy)
//
// TEXT: synchronous, offline, zero-cost profanity/intent filter via
//   content-checker (bad-words based). No API key required. Every user-writable
//   text field is screened before it is stored.
//
// IMAGE: synchronous, FAIL-CLOSED (build-time decision). Every image/story upload
//   is screened before it becomes visible via Google Cloud Vision SafeSearch; if
//   the provider errors, times out, or exhausts quota, the upload is REJECTED
//   rather than letting unmoderated imagery through during a degradation.
// ---------------------------------------------------------------------------
const { Filter } = require('content-checker');

// Text screening only. content-checker's hosted image endpoint pointed at
// OpenModerator, which no longer exists; images go through Cloud Vision below.
const filter = new Filter();

const TEXT_REJECTED_MESSAGE =
  "That doesn't fit our community guidelines. Rephrase and try again.";

/**
 * Screen user-supplied text before storing it. Synchronous + offline.
 * @param {string} text
 * @returns {{ allowed: boolean, flagged: boolean, reason: string|null }}
 */
function moderateText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { allowed: true, flagged: false, reason: null };
  }
  if (filter.isProfane(text)) {
    return { allowed: false, flagged: true, reason: 'profanity' };
  }
  return { allowed: true, flagged: false, reason: null };
}

/**
 * Express helper: returns true and sends a 400 if the text is rejected.
 * Usage: if (rejectIfProfane(res, req.body.content)) return;
 */
function rejectIfProfane(res, text) {
  const verdict = moderateText(text);
  if (!verdict.allowed) {
    res.status(400).json({ error: TEXT_REJECTED_MESSAGE, moderation: verdict.reason });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Image moderation — fail-closed
// ---------------------------------------------------------------------------
// Round 17: this was `=== 'true'` and nothing else, so "fail-closed" was opt-IN
// via an environment variable that lives only in the Railway dashboard. Forget
// to set it on the production service — or lose it in a service re-create, an
// env import, a new environment for a staging build — and every image upload
// path in the app silently reverts to allow-with-a-console-warning. That is a
// teen social app shipping unscreened photo UGC, and the only evidence would be
// one line in a log nobody reads.
//
// A safety default has to be the DEFAULT. In production the answer is now
// "required" unless someone explicitly writes IMAGE_MODERATION_REQUIRED=false,
// which is a deliberate, greppable act rather than an omission. Dev and test
// are unchanged: no variable, no requirement.
const IMAGE_MODERATION_REQUIRED =
  process.env.IMAGE_MODERATION_REQUIRED === 'true' ||
  (process.env.NODE_ENV === 'production' && process.env.IMAGE_MODERATION_REQUIRED !== 'false');

// Provider: Google Cloud Vision SafeSearch.
//
// This replaced OpenModerator, whose hosted service was shut down by its owner
// (the domain now serves a paused-deployment 503, so the old key path could
// never have worked). Cloud Vision runs in the Google Cloud project this app
// already uses for Places and Gemini: enable the Vision API on that project and
// set VISION_API_KEY. A separate key is supported so the browser-restricted
// Maps key is never reused server-side.
const VISION_API_KEY = process.env.VISION_API_KEY || process.env.GOOGLE_VISION_API_KEY;
const IMAGE_PROVIDER_CONFIGURED = !!VISION_API_KEY;

// Say it once, at boot, where a deploy log will show it. Previously the only
// signal that image moderation was misconfigured arrived one line at a time,
// per upload, buried in request logs — after the fact.
if (process.env.NODE_ENV === 'production' && !IMAGE_PROVIDER_CONFIGURED) {
  console.error(
    '🛡️ STARTUP: no image moderation provider is configured (VISION_API_KEY unset). ' +
    (IMAGE_MODERATION_REQUIRED
      ? 'Every image upload in the app will be REJECTED until it is set.'
      : 'IMAGE_MODERATION_REQUIRED=false is set, so images are being stored UNSCREENED. Do not ship this to the App Store.')
  );
}

// SafeSearch returns a likelihood enum per category rather than a score.
// LIKELY and VERY_LIKELY are refused. POSSIBLE is refused for the two
// categories that carry real legal and App Store risk on a teen app, and
// allowed for the softer ones so ordinary night-out photos are not eaten.
const HARD_REJECT = new Set(['LIKELY', 'VERY_LIKELY']);
const STRICT_CATEGORIES = ['adult', 'racy'];
const OTHER_CATEGORIES = ['violence', 'medical'];

/**
 * Screen an uploaded image before it becomes visible. FAIL-CLOSED.
 * @param {string} imageUrl  data: URL or publicly-fetchable https URL
 * @returns {Promise<{ allowed: boolean, reason: string|null }>}
 */
async function moderateImage(imageUrl) {
  // No provider configured: allow in dev with a loud warning; reject in prod when
  // IMAGE_MODERATION_REQUIRED is set (fail-closed for a teen app with photo UGC).
  if (!IMAGE_PROVIDER_CONFIGURED) {
    if (IMAGE_MODERATION_REQUIRED) {
      console.error('🛡️ Image moderation REQUIRED but no provider configured, rejecting upload (fail-closed).');
      return { allowed: false, reason: 'moderation_unavailable' };
    }
    console.warn('⚠️ Image moderation provider not configured, allowing upload (dev only). Set VISION_API_KEY + IMAGE_MODERATION_REQUIRED=true before store submission.');
    return { allowed: true, reason: null };
  }

  try {
    const blob = await imageToBlob(imageUrl);
    const bytes = Buffer.from(await blob.arrayBuffer());

    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(VISION_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: bytes.toString('base64') },
            features: [{ type: 'SAFE_SEARCH_DETECTION' }],
          }],
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      // Surface Google's own reason. A bare status is not actionable: 403
      // alone could be SERVICE_DISABLED (API not enabled on the project),
      // BILLING_DISABLED (no billing account, common on Firebase-created
      // projects), or API_KEY_SERVICE_BLOCKED (key restricted to other APIs).
      let detail = '';
      try {
        const body = await response.json();
        const reason = body?.error?.details?.[0]?.reason || body?.error?.status || '';
        detail = ` ${reason} ${body?.error?.message || ''}`.trimEnd();
      } catch { /* body was not JSON */ }
      throw new Error(`vision ${response.status}${detail}`);
    }
    const data = await response.json();
    const verdict = data?.responses?.[0];
    if (verdict?.error) throw new Error(verdict.error.message || 'vision error');

    const safe = verdict?.safeSearchAnnotation;
    // A 200 with no annotation means we learned nothing about the image, which
    // is not the same as it being clean.
    if (!safe) throw new Error('no safeSearch annotation');

    for (const key of STRICT_CATEGORIES) {
      if (HARD_REJECT.has(safe[key]) || safe[key] === 'POSSIBLE') {
        return { allowed: false, reason: `unsafe_${key}` };
      }
    }
    for (const key of OTHER_CATEGORIES) {
      if (HARD_REJECT.has(safe[key])) {
        return { allowed: false, reason: `unsafe_${key}` };
      }
    }
    return { allowed: true, reason: null };
  } catch (err) {
    // Provider configured but call failed → FAIL CLOSED.
    console.error('🛡️ Image moderation call failed, rejecting upload (fail-closed):', err.message);
    return { allowed: false, reason: 'moderation_error' };
  }
}

const MAX_MODERATED_IMAGE_BYTES = 8 * 1024 * 1024;

// SSRF guard (round 5): remote fetches must resolve to PUBLIC addresses at
// every hop — attacker-controlled redirects toward localhost / RFC1918 /
// link-local (cloud metadata) are refused.
const dns = require('dns').promises;
const net = require('net');

function isPrivateIPv4(addr) {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 127 || a === 10 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)   // link-local: cloud metadata lives at 169.254.169.254
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || a >= 224;
}

// Round 17: the IPv6 branch spot-checked THREE ::ffff: prefixes by string —
// 127., 10. and 192.168. — and every other private IPv4 range slipped through
// in mapped form. `::ffff:169.254.169.254` is the cloud metadata endpoint, and
// it was allowed; so were `::ffff:172.16.x.x` and `::ffff:100.64.x.x`. The fix
// is to stop pattern-matching prefixes and instead UNWRAP a mapped address back
// to its IPv4 form, then run the one IPv4 rule set over it. `::` (unspecified,
// which routes to localhost on several stacks) was missing too.
function isPrivateAddress(addr) {
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    // IPv4-mapped and IPv4-compatible forms, e.g. ::ffff:169.254.169.254
    const mapped = a.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80')) return true;              // link-local
    if (/^f[cd]/.test(a)) return true;                  // unique-local fc00::/7
    if (a.startsWith('ff')) return true;                // multicast
    return false;
  }
  return isPrivateIPv4(addr);
}

async function assertPublicHttpsUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('bad image URL'); }
  if (u.protocol !== 'https:') throw new Error('unsupported image URL scheme');
  if (net.isIP(u.hostname) && isPrivateAddress(u.hostname)) throw new Error('blocked address');
  if (!net.isIP(u.hostname)) {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (addrs.some(a => isPrivateAddress(a.address))) throw new Error('blocked address');
  }
  return u;
}

// Fetch with manual redirect following (each hop re-validated) and a
// STREAMING size cap — the old arrayBuffer() buffered an endless body on the
// heap before the size check ever ran.
async function fetchPublicImage(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop < 3; hop++) {
    await assertPublicHttpsUrl(url);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error('bad redirect');
      url = new URL(loc, url).href;
      continue;
    }
    if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`not an image: ${type}`);
    const declared = parseInt(response.headers.get('content-length') || '0', 10);
    if (declared > MAX_MODERATED_IMAGE_BYTES) throw new Error('image too large');

    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_MODERATED_IMAGE_BYTES) throw new Error('image too large');
      chunks.push(chunk);
    }
    return new Blob([Buffer.concat(chunks)], { type });
  }
  throw new Error('too many redirects');
}

async function imageToBlob(imageUrl) {
  if (typeof imageUrl !== 'string' || imageUrl === '') {
    throw new Error('no image data');
  }
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
    if (!match) throw new Error('unsupported data URL');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_MODERATED_IMAGE_BYTES) throw new Error('image too large');
    return new Blob([bytes], { type: match[1] });
  }
  if (/^https:\/\//.test(imageUrl)) {
    return fetchPublicImage(imageUrl);
  }
  throw new Error('unsupported image URL scheme');
}

const IMAGE_REJECTED_MESSAGE =
  "We couldn't verify that image is safe to share, so it wasn't posted.";

module.exports = {
  moderateText,
  rejectIfProfane,
  moderateImage,
  filter,
  TEXT_REJECTED_MESSAGE,
  IMAGE_REJECTED_MESSAGE,
};
// Exposed for __tests__/safetyFlow.test.js.
module.exports.__test = { isPrivateAddress, IMAGE_MODERATION_REQUIRED, IMAGE_PROVIDER_CONFIGURED };
