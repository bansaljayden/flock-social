'use strict';
// ---------------------------------------------------------------------------
// AVATAR ART, DRAWN HERE
// ---------------------------------------------------------------------------
// The "make me an avatar" button used to save a link to DiceBear's hosted API
// (api.dicebear.com/7.x/<style>/svg?seed=<seed>), and every device that showed
// the picture fetched it from DiceBear. That API is free for non-commercial
// use only, and DiceBear asks commercial users to run it themselves; Flock
// sells subscriptions. So the same pictures are drawn by this server from the
// DiceBear packages (MIT code) and served from GET /api/avatars/<style>/svg.
//
// SAME PICTURES. The 9.x packages draw exactly the image the hosted 7.x API
// drew for the same style and seed (checked for all five styles, byte for
// byte, 2026-10-05), so rewriting a stored 7.x link to ours (migration 116)
// changes nobody's avatar.
//
// THE ARTWORK has its own licences, listed in each package's LICENSE and in
// the metadata of every SVG it draws: Adventurer (Lisa Wischofsky) and
// Personas (Draftbit) are CC BY 4.0, Avataaars and Bottts (Pablo Stanley) are
// free for personal and commercial use, Pixel Art (DiceBear) is CC0. The
// About page credits them.
//
// The packages are ES modules, so they are loaded with import(), once, the
// first time a picture is asked for.
// ---------------------------------------------------------------------------

const STYLE_PACKAGES = {
  adventurer: '@dicebear/adventurer',
  avataaars: '@dicebear/avataaars',
  bottts: '@dicebear/bottts',
  personas: '@dicebear/personas',
  'pixel-art': '@dicebear/pixel-art',
};
const STYLES = Object.keys(STYLE_PACKAGES);

// The app draws a six-character seed from [0-9a-z]; the old button drew four
// to six. 64 is room for either and keeps every stored link short, which
// matters because profile_image_url rides on every roster and push.
const SEED_RE = /^[A-Za-z0-9]{1,64}$/;

const AVATAR_PATH = '/api/avatars';

let loading = null;
function loadArt() {
  if (!loading) {
    loading = Promise.all([
      import('@dicebear/core'),
      ...STYLES.map((s) => import(STYLE_PACKAGES[s])),
    ]).then(([core, ...styles]) => ({
      createAvatar: core.createAvatar,
      styles: Object.fromEntries(STYLES.map((s, i) => [s, styles[i]])),
    })).catch((err) => {
      // A failed load is not remembered, so the next request tries again.
      loading = null;
      throw err;
    });
  }
  return loading;
}

function isAvatarStyle(style) {
  return typeof style === 'string' && Object.prototype.hasOwnProperty.call(STYLE_PACKAGES, style);
}

function isAvatarSeed(seed) {
  return typeof seed === 'string' && SEED_RE.test(seed);
}

// The SVG for one style and seed, or null for a style or seed this does not
// draw. Throws only when the packages could not be loaded.
async function renderAvatarSvg(style, seed) {
  if (!isAvatarStyle(style) || !isAvatarSeed(seed)) return null;
  const { createAvatar, styles } = await loadArt();
  return createAvatar(styles[style], { seed }).toString();
}

function avatarUrl(apiBase, style, seed) {
  return `${apiBase}${AVATAR_PATH}/${style}/svg?seed=${seed}`;
}

// The one form profile_image_url may hold for a drawn avatar, or null.
// Accepts our own path and the hosted 7.x link an older build of the app
// still sends, and answers our link for both, rebuilt from the style and the
// seed on apiBase, so nothing the client sent but those two survives: not its
// host, nor an extra path, parameter or fragment. That is why our path is
// accepted on any origin: a local build calls its API over plain http, and
// whatever origin it names, the stored link is ours.
function canonicalAvatarUrl(url, apiBase) {
  if (typeof url !== 'string' || typeof apiBase !== 'string') return null;
  let u;
  let base;
  try {
    u = new URL(url);
    base = new URL(apiBase);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.hash) return null;
  const params = [...u.searchParams.keys()];
  if (params.length !== 1 || params[0] !== 'seed') return null;
  const seed = u.searchParams.get('seed');
  if (!isAvatarSeed(seed)) return null;

  let style = null;
  if (u.host === 'api.dicebear.com') {
    const m = u.protocol === 'https:' && /^\/7\.x\/([a-z-]+)\/svg$/.exec(u.pathname);
    style = m && m[1];
  } else {
    const m = /^\/api\/avatars\/([a-z-]+)\/svg$/.exec(u.pathname);
    style = m && m[1];
  }
  if (!isAvatarStyle(style)) return null;
  return avatarUrl(base.origin, style, seed);
}

module.exports = {
  STYLES,
  AVATAR_PATH,
  isAvatarStyle,
  isAvatarSeed,
  renderAvatarSvg,
  avatarUrl,
  canonicalAvatarUrl,
};
