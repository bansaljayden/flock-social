/**
 * The profile photo, sized so the people in your plans can see it.
 *
 * Every list read on the server (plan cards, chat rows, the DM list, live
 * messages, rosters, people search) sends an avatar only when its data URL is
 * at most 12,000 characters, and sends null above that. Grep for it rather
 * than trusting a line number:
 *   grep -rn "profile_image_url) > 12000" backend
 * The ceiling is there because an avatar rides on every one of those rows, and
 * it stays exactly as it is.
 *
 * What was wrong was this side of it. The crop sheet drew a 400 px square and
 * encoded it as JPEG at 0.9, which comes out at roughly 28,000 to 55,000
 * characters for an ordinary photo. Every uploaded face passed the upload
 * ceiling (600 KB, routes/users.js) and was then nulled by every list read, so
 * everyone else saw an initial where the face should have been, and only the
 * single-person card showed it.
 *
 * 160 px is the largest avatar the app draws (80 px, the profile header) at
 * 2x. JPEG starts at 0.8 and steps down until the result fits under
 * AVATAR_TARGET_CHARS, the same step-down makeChatThumb in App.js uses. The
 * target sits below the server's ceiling on purpose: the server stores the
 * base64 of the file it received, so the stored string is never longer than
 * the one measured here, and the margin covers a browser whose encoder adds a
 * little header the measurement did not.
 */

export const AVATAR_EDGE = 160;
export const AVATAR_LIST_CEILING = 12000;
export const AVATAR_TARGET_CHARS = 11000;
// 0.5 is past the step-down the chat thumbnail takes, and it is reached only
// by a picture busy enough to miss 11,000 at 0.6 on a 160 px square. A softer
// face that everyone can see beats a sharp one nobody but its owner can.
export const AVATAR_QUALITIES = [0.8, 0.7, 0.6, 0.5];

// First quality that fits wins. When none does, the last (smallest) attempt is
// returned anyway: it is still a fraction of what the old sheet uploaded, and
// refusing the photo outright would leave the person with no way to set one.
// Null only when the canvas cannot encode at all.
export function encodeAvatar(canvas) {
  if (!canvas || typeof canvas.toDataURL !== 'function') return null;
  let out = null;
  for (const q of AVATAR_QUALITIES) {
    let next;
    try { next = canvas.toDataURL('image/jpeg', q); } catch { return out; }
    if (typeof next !== 'string' || !next.startsWith('data:image/')) return out;
    out = next;
    if (out.length <= AVATAR_TARGET_CHARS) break;
  }
  return out;
}

// The upload route is multipart (routes/users.js reads a file part), so the
// encoded string goes back to bytes for the form. Decoding the same data URL
// that was measured, rather than calling toBlob a second time, means the bytes
// sent are exactly the bytes the size check was run on.
export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) return null;
  let bin;
  try { bin = atob(m[2]); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

// Which over-ceiling avatar this account's server has already refused a
// smaller copy of, as `<userId>:<length>`. Read and written by the refit
// effect beside confirmCrop in App.js. A flock_ key, so sign-out sweeps it.
export const AVATAR_REFIT_MARKER_KEY = 'flock_avatar_refit';

// An uploaded avatar the list reads will hide. Only a data URL qualifies: a
// DiceBear URL or a legacy /uploads/ path is short, and nothing here could
// redraw it without a network read anyway.
export function needsAvatarRefit(url) {
  return typeof url === 'string' && url.startsWith('data:image/') && url.length > AVATAR_LIST_CEILING;
}

// The centred square of a picture, which is what every avatar slot shows
// (they are all circles with objectFit: cover). A picture the old crop sheet
// wrote is already square and comes back whole.
export function centreSquare(width, height) {
  const size = Math.min(width, height);
  return { sx: (width - size) / 2, sy: (height - size) / 2, size };
}

// Redraw an avatar that is already stored, for the one-time refit of pictures
// uploaded before the crop sheet sized for the ceiling. Resolves to a data URL
// or null, and never rejects: a picture that will not decode simply stays as
// it is.
export function refitAvatar(dataUrl) {
  return new Promise((resolve) => {
    try {
      if (!needsAvatarRefit(dataUrl)) { resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!w || !h) { resolve(null); return; }
          const { sx, sy, size } = centreSquare(w, h);
          const canvas = document.createElement('canvas');
          canvas.width = AVATAR_EDGE;
          canvas.height = AVATAR_EDGE;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, sx, sy, size, size, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
          const out = encodeAvatar(canvas);
          // Only worth an upload (and the screening it pays for) if it is
          // actually smaller than what is stored.
          resolve(out && out.length < dataUrl.length ? out : null);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch { resolve(null); }
  });
}

/* GOOGLE'S PHOTO HOST IS NOT AN AVATAR (2026-10-06).
   Google sign-in used to store the account's Google photo link as its avatar,
   unscreened. The server stopped (backend/routes/auth.js, NOT THE PICTURE),
   migration 120 cleared the links it had stored, and the page's policy no
   longer lets that host load (public/index.html, vercel.json). A link that
   still arrives, from a server that has not finished deploying or a reply that
   sat somewhere on the way, would draw as an empty circle. So it is read as no
   avatar at the two places data comes in, services/api.js for replies and
   services/socket.js for live events, and every surface draws the person's
   initial instead, as it does for anyone without a photo. Nothing else the
   app shows comes from that host: venue photos come through the API's own
   proxy. */
const GOOGLE_PHOTO_LINK = /^https?:\/\/([a-z0-9-]+\.)*googleusercontent\.com([/:?#]|$)/i;

export const isGooglePhotoLink = (value) => typeof value === 'string' && GOOGLE_PHOTO_LINK.test(value);

// ONLY WHERE AN AVATAR SITS. Read by value alone, the scrub blanked any text
// that began with such a link: a chat message opening with a shared Google
// Photos link, a bio, a flock name arrived as null, and a screen that read the
// text's length threw. Avatars travel as profile_image_url, image_url,
// avatarUrl, and in live events sender_image and image; the key decides.
const AVATAR_KEY = /(image|avatar|photo)(_?url)?$/i;
const isAvatarKey = (key) => typeof key === 'string' && AVATAR_KEY.test(key);

// For JSON.parse: a Google photo link in an avatar field becomes null.
export const withoutGooglePhotoLinks = (key, value) => (isAvatarKey(key) && isGooglePhotoLink(value) ? null : value);

// The same for something already parsed (a socket event), in place. A live
// event is a few levels deep, so the walk stops at six. It must not throw: it
// runs ahead of every listener, and a throw there would lose the event.
export function dropGooglePhotoLinks(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return;
  try {
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (isAvatarKey(key) && isGooglePhotoLink(v)) value[key] = null;
      else if (v && typeof v === 'object') dropGooglePhotoLinks(v, depth + 1);
    }
  } catch {
    // A frozen payload is left as it came.
  }
}
