// ---------------------------------------------------------------------------
// UGC content moderation (Apple 1.2 / Google UGC policy)
//
// TEXT: synchronous, offline, zero-cost profanity/intent filter via
//   content-checker (bad-words based). No API key required. Every user-writable
//   text field is screened before it is stored.
//
// IMAGE: synchronous, FAIL-CLOSED (build-time decision). Every image/story upload
//   is screened before it becomes visible. Pluggable provider; if a provider is
//   configured and errors/times out/quota-exhausts, the upload is REJECTED rather
//   than letting unmoderated imagery through during a degradation.
// ---------------------------------------------------------------------------
const { Filter } = require('content-checker');

// content-checker reads OPEN_MODERATOR_API_KEY (not our documented
// OPENMODERATOR_API_KEY) unless the key is passed explicitly — without this
// option the client is keyless and every image call throws.
const filter = new Filter({ openModeratorAPIKey: process.env.OPENMODERATOR_API_KEY });

const TEXT_REJECTED_MESSAGE =
  "That doesn't fit our community guidelines — please rephrase and try again.";

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
const IMAGE_MODERATION_REQUIRED = process.env.IMAGE_MODERATION_REQUIRED === 'true';
const OPENMODERATOR_API_KEY = process.env.OPENMODERATOR_API_KEY;
const IMAGE_PROVIDER_CONFIGURED = !!OPENMODERATOR_API_KEY; // extend with AWS Rekognition later

/**
 * Screen an uploaded image before it becomes visible. FAIL-CLOSED.
 * @param {string} imageUrl  publicly-fetchable URL of the just-uploaded image
 * @returns {Promise<{ allowed: boolean, reason: string|null }>}
 */
async function moderateImage(imageUrl) {
  // No provider configured: allow in dev with a loud warning; reject in prod when
  // IMAGE_MODERATION_REQUIRED is set (fail-closed for a teen app with photo UGC).
  if (!IMAGE_PROVIDER_CONFIGURED) {
    if (IMAGE_MODERATION_REQUIRED) {
      console.error('🛡️ Image moderation REQUIRED but no provider configured — rejecting upload (fail-closed).');
      return { allowed: false, reason: 'moderation_unavailable' };
    }
    console.warn('⚠️ Image moderation provider not configured — allowing upload (dev only). Set OPENMODERATOR_API_KEY + IMAGE_MODERATION_REQUIRED=true before store submission.');
    return { allowed: true, reason: null };
  }

  try {
    // isImageNSFW posts a multipart file and needs actual image bytes as a
    // Blob — handing it the URL string uploads the text of the URL instead.
    const blob = await imageToBlob(imageUrl);
    const result = await filter.isImageNSFW(blob); // content-checker hosted NSFW model
    const nsfw = result && (result.nsfw === true);
    if (nsfw) return { allowed: false, reason: 'nsfw_image' };
    return { allowed: true, reason: null };
  } catch (err) {
    // Provider configured but call failed → FAIL CLOSED.
    console.error('🛡️ Image moderation call failed — rejecting upload (fail-closed):', err.message);
    return { allowed: false, reason: 'moderation_error' };
  }
}

const MAX_MODERATED_IMAGE_BYTES = 8 * 1024 * 1024;

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
    const response = await fetch(imageUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`not an image: ${type}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MODERATED_IMAGE_BYTES) throw new Error('image too large');
    return new Blob([bytes], { type });
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
