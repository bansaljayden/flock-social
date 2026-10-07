// /api/invite-og, the per-flock share image every invite preview points at
// (api/invite-preview.js renderPage). Rendering it here does not fit the
// Workers Free plan: one satori + resvg render costs 20-130 ms of CPU against
// a 10 ms limit (developers.cloudflare.com/workers/platform/limits/). The
// backend draws it instead (route /api/og/invite, the same @vercel/og
// renderer and the same api/_og-card.js tree), and this function is a cached
// proxy in front of it at the URL previews already use.
//
// - Only signed cards go to the backend. Anything unsigned, tampered or
//   failing gets the static banner, uncached, so a later fetch of the same
//   URL can still get the real card.
// - Every input to the image is in the URL, so one copy per URL per data
//   center is always correct; it is kept for 30 days (edge-cache.js).
import { cardSignature, sameSignature } from '../_lib/card-signature.js';
import { edgeCached } from '../_lib/edge-cache.js';

const RENDERER = 'https://api.flockcorp.com/api/og/invite';
// Preview bots allow a few seconds for the image; the render plus the trip to
// the backend takes well under one.
const RENDER_TIMEOUT_MS = 4000;
const MIN_SECRET = 16;

async function staticBanner(context) {
  const banner = await context.env.ASSETS.fetch(new URL('/og-image.png', context.request.url));
  return new Response(banner.body, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function render(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const upstream = await fetch(RENDERER + '?' + query, {
      signal: controller.signal,
      headers: { Accept: 'image/png', 'User-Agent': 'FlockCardProxy/1.0 (+https://www.flockcorp.com)' },
    });
    if (upstream.status !== 200 || !(upstream.headers.get('Content-Type') || '').startsWith('image/png')) return null;
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, s-maxage=2592000',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('invite-og: static banner:', (err && err.name) || 'Error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const params = new URL(request.url).searchParams;
  const n = params.get('n') || '';
  const w = params.get('w') || '';
  const g = params.get('g') || '';
  const s = params.get('s') || '';
  const secret = typeof env.OG_CARD_SECRET === 'string' ? env.OG_CARD_SECRET.trim() : '';
  if (secret.length < MIN_SECRET || !sameSignature(s, await cardSignature(secret, n, w, g))) {
    return staticBanner(context);
  }
  const query = new URLSearchParams({ n, w, g, s }).toString();
  const key = new URL('/__edge-cache/invite-og?' + query, request.url).toString();
  return edgeCached(context, key, async () => (await render(query)) || staticBanner(context));
}
