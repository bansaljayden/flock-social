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

const filter = new Filter();

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
    const result = await filter.isImageNSFW(imageUrl); // content-checker hosted NSFW model
    const nsfw = result && (result.nsfw === true);
    if (nsfw) return { allowed: false, reason: 'nsfw_image' };
    return { allowed: true, reason: null };
  } catch (err) {
    // Provider configured but call failed → FAIL CLOSED.
    console.error('🛡️ Image moderation call failed — rejecting upload (fail-closed):', err.message);
    return { allowed: false, reason: 'moderation_error' };
  }
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
