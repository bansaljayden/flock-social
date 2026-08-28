// /api/invite-og - the per-flock share image behind invite links.
//
// invite-preview.js used to point og:image at one static PNG for every flock,
// so an iMessage full of different invites showed one identical banner. This
// edge function renders the plan's own card: name, when, going count, brand
// navy. The three query fields are the SAME three facts og:title and
// og:description already publish in text, and the invite TOKEN never appears
// in this URL (invite-preview.js rule 3: image URLs outlive pages in crawler
// caches). The pure half, clamping and the element tree, lives in _og-card.js
// so the jest suite can hold it still without an edge runtime.
//
// Runs at the edge because @vercel/og's Satori build targets it and because a
// crawler fetches this once per share; s-maxage lets the CDN answer repeats.

import { ImageResponse } from '@vercel/og';
import ogCard from './_og-card.js';

export const config = { runtime: 'edge' };

export default function handler(req) {
  const { searchParams } = new URL(req.url);
  const params = ogCard.cardParams({
    n: searchParams.get('n') || '',
    w: searchParams.get('w') || '',
    g: searchParams.get('g') || '',
  });
  return new ImageResponse(ogCard.cardTree(params), {
    width: ogCard.CARD_W,
    height: ogCard.CARD_H,
    headers: {
      // A flock's name and count drift as people answer; an hour of CDN cache
      // is fresh enough for a link mid-share and cheap enough to re-render.
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
