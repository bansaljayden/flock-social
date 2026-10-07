'use strict';
// ---------------------------------------------------------------------------
// GET /api/og/invite?n&w&g&s: THE INVITE SHARE CARD, DRAWN HERE
// ---------------------------------------------------------------------------
// The 1200x630 PNG an invite link's preview shows: the plan's name, when it
// is, and how many are going. The preview page (frontend/api/invite-preview.js)
// points og:image at the website's own /api/invite-og, and on Cloudflare Pages
// that URL is a cached proxy in front of this route. Drawing the card there
// does not fit the free plan (one render is 20-130 ms of CPU against a 10 ms
// limit), so it is drawn here, by the same renderer (@vercel/og, pinned to the
// website's 0.8.6) from the same element tree (frontend/api/_og-card.js, copied
// below). __tests__/ogCard.test.js holds the copy to that file and the picture
// to the one the library draws for the website, byte for byte.
//
// ONLY SIGNED CARDS ARE DRAWN. The preview signs each card URL with
// OG_CARD_SECRET, which the website and this service share: HMAC-SHA256 over
// "name\nwhen\ngoing", base64url, the first 22 characters. Anything else is a
// 403 before any work is done, so nobody can have their own text drawn on a
// Flock card, and a stream of made-up cards cannot keep the only thread busy.
// With the secret unset, or shorter than 16 characters, every card is refused
// and previews fall back to the website's static banner.
//
// WHAT IT SHOWS. The three signed fields, which the preview page already
// publishes as text (og:title, og:description, og:image:alt), and fixed copy.
// Nothing here reads a parameter but n, w, g and s, and the invite token is
// never among them.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── The card: a copy of frontend/api/_og-card.js ────────────────────────────
// Constants and functions verbatim, so the two can be compared as text. The
// website's file stays the original for as long as Vercel draws cards too.

const CARD_W = 1200;
const CARD_H = 630;

const NAVY = '#0d2847';
const CREAM = '#f7f3e8';
const CREAM_DIM = 'rgba(247, 243, 232, 0.72)';
const RULE = 'rgba(247, 243, 232, 0.28)';

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Control characters and newlines have no business in a one-line label, and
  // stripping them here means a hostile flock name cannot reshape the card.
  const flat = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/** Query object -> the three clamped display fields. */
function cardParams(query) {
  const q = query || {};
  const going = parseInt(q.g, 10);
  return {
    name: cleanText(q.n, 60) || 'A night out',
    when: cleanText(q.w, 44) || 'Time not set yet',
    going: Number.isInteger(going) && going > 0 ? Math.min(going, 999) : 0,
  };
}

function text(content, style) {
  return { type: 'div', props: { style, children: content } };
}

/** The 1200x630 element tree. Pure data in, pure structure out. */
function cardTree(params) {
  const metaBits = [params.when];
  if (params.going > 0) metaBits.push(`${params.going} going`);
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: NAVY,
        padding: '72px 80px',
        fontFamily: 'sans-serif',
      },
      children: [
        text('FLOCK', {
          display: 'flex',
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: 10,
          color: CREAM_DIM,
        }),
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column' },
            children: [
              text(params.name, {
                display: 'flex',
                fontSize: 84,
                fontWeight: 800,
                lineHeight: 1.06,
                letterSpacing: -2,
                color: CREAM,
              }),
              text(metaBits.join(' · '), {
                display: 'flex',
                marginTop: 26,
                fontSize: 36,
                fontWeight: 500,
                color: CREAM_DIM,
              }),
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderTop: `2px solid ${RULE}`,
              paddingTop: 34,
            },
            children: [
              text("You're invited. Vote on where it lands.", {
                display: 'flex',
                fontSize: 30,
                fontWeight: 600,
                color: CREAM,
              }),
              text('No app needed', {
                display: 'flex',
                fontSize: 26,
                fontWeight: 500,
                color: CREAM_DIM,
              }),
            ],
          },
        },
      ],
    },
  };
}

// ── The signature ───────────────────────────────────────────────────────────
// Same contract as the signer in frontend/api/invite-preview.js and the
// website proxy's check. 22 base64url characters is 132 bits of the MAC.
const MIN_SECRET = 16;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{22}$/;

// Read per request, trimmed the way the website trims it, so a value pasted
// with a trailing newline signs the same cards on both sides.
function cardSecret() {
  const raw = process.env.OG_CARD_SECRET;
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.length >= MIN_SECRET ? value : null;
}

function cardSignature(secret, n, w, g) {
  return crypto.createHmac('sha256', secret).update(n + '\n' + w + '\n' + g).digest('base64url').slice(0, 22);
}

// One string per field, or nothing. A repeated parameter arrives as an array
// and a bracketed one as an object; both read as empty, which no real card is
// signed with.
function oneValue(value) {
  return typeof value === 'string' ? value : '';
}

// ── The renderer, loaded once ───────────────────────────────────────────────
// On the first card rather than at boot: the library is an ES module carrying
// two wasm binaries, about 30 MB of the process once it has drawn a card, and
// most boots never draw one. A failed load is not remembered, so the next
// request tries again.
//
// THE FONT IS PARSED ONCE, which is most of the memory story. As shipped, the
// library hands satori a new font list on every render, and satori keeps a
// parsed font per list, so it parses the bundled font again each time. In
// Node, 200 renders back to back took the process from 81 MB to 249 MB
// resident while heapUsed stayed at 12 MB: garbage, which V8 hands back only
// after a quiet spell. Handing satori one list every time, holding the very
// file the library reads for itself, took the same run to 115 MB and draws
// the same bytes.
let loading = null;

// The one font entry the library builds for itself on every render
// (dist/index.node.js): same name, weight and style.
function fontList(data) {
  return [{ name: 'sans serif', data, weight: 700, style: 'normal' }];
}

function loadRenderer() {
  if (!loading) {
    loading = (async () => {
      const og = await import('@vercel/og');
      const dist = path.join(path.dirname(require.resolve('@vercel/og/package.json')), 'dist');
      const fontData = await fs.promises.readFile(path.join(dist, 'noto-sans-v27-latin-regular.ttf'));
      return { ImageResponse: og.ImageResponse, fontData, sharedFonts: fontList(fontData) };
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

// Text the bundled font draws by itself: printable ASCII, Latin-1, and the
// curly quotes, dashes, bullet and ellipsis that phones type for you. It has a
// glyph for every one of these. For anything else, an emoji or another script,
// satori asks the library for a fallback font or an emoji picture, which the
// library downloads (fonts.googleapis.com, cdn.jsdelivr.net), and adds what it
// gets to the font list it was given. On the shared list that would keep every
// fallback font ever fetched, so those cards get a list of their own, parsed
// for that one render, which is what the library does for every card anyway.
const SHARED_FONT_TEXT = /^[\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]*$/;

function usesSharedFont(params) {
  return SHARED_FONT_TEXT.test(params.name + params.when);
}

async function drawPng(params, sharedFont) {
  const { ImageResponse, fontData, sharedFonts } = await loadRenderer();
  const response = new ImageResponse(cardTree(params), {
    width: CARD_W,
    height: CARD_H,
    fonts: sharedFont ? sharedFonts : fontList(fontData),
  });
  return Buffer.from(await response.arrayBuffer());
}

// Swapped only by __tests__/ogCard.test.js, to watch the line below without
// drawing anything.
let drawCard = drawPng;

// ── One render at a time ────────────────────────────────────────────────────
// A warm render is 15 to 30 ms of CPU on the only thread, nearly all of it
// synchronous, so a second render alongside buys no throughput; it only adds
// another render's garbage to the heap. Each kind of card gets its own line,
// because only a fallback render waits on the network, and the library's
// downloads carry no timeout of their own: a stalled one holds up other
// emoji and non-Latin cards, never the rest. Past MAX_WAITING the answer is a
// 503 at once. The website shows its static banner for that one fetch and
// caches nothing, so the next fetch of the same URL can still get the card.
const MAX_WAITING = 8;

function renderLine() {
  let running = false;
  const waiting = [];
  return {
    // Resolves true once this request holds the line, or false at once when
    // the line is already full.
    enter() {
      if (!running) {
        running = true;
        return Promise.resolve(true);
      }
      if (waiting.length >= MAX_WAITING) return Promise.resolve(false);
      return new Promise((resolve) => waiting.push(resolve));
    },
    // The turn passes straight to the next in line, so a newcomer can never
    // overtake somebody who was already waiting.
    leave() {
      const next = waiting.shift();
      if (next) next(true);
      else running = false;
    },
    state() {
      return { running: running ? 1 : 0, waiting: waiting.length };
    },
  };
}

const sharedLine = renderLine();
const fallbackLine = renderLine();

// ── Recently drawn cards ────────────────────────────────────────────────────
// Every input is in the URL, so a card URL always draws the same picture. The
// website's proxy keeps each URL for 30 days, but per Cloudflare data center,
// so one card can arrive here from several of them, and anybody can replay a
// real card URL straight at this service. Keeping the last CACHE_MAX makes
// both free. About 30 KB each; the oldest goes first.
const CACHE_MAX = 64;
const drawnCards = new Map();

function rememberCard(key, png) {
  drawnCards.delete(key);
  drawnCards.set(key, png);
  while (drawnCards.size > CACHE_MAX) drawnCards.delete(drawnCards.keys().next().value);
}

const router = express.Router();

router.get('/invite', async (req, res) => {
  const refuse = (status, error) => res.status(status).set('Cache-Control', 'no-store').json({ error });
  try {
    const secret = cardSecret();
    const n = oneValue(req.query.n);
    const w = oneValue(req.query.w);
    const g = oneValue(req.query.g);
    const s = oneValue(req.query.s);
    // Checked here in the handler, the route's own authentication. The shape
    // test first, so the comparison always sees two 22-byte buffers.
    if (!secret || !SIGNATURE_RE.test(s)
      || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(cardSignature(secret, n, w, g)))) {
      return refuse(403, 'This card is not signed.');
    }

    const key = n + '\n' + w + '\n' + g;
    let png = drawnCards.get(key);
    if (!png) {
      const params = cardParams({ n, w, g });
      const shared = usesSharedFont(params);
      const line = shared ? sharedLine : fallbackLine;
      if (!(await line.enter())) {
        res.set('Retry-After', '5');
        return refuse(503, 'Too many cards are being drawn. Try again in a moment.');
      }
      try {
        // Somebody ahead in the line may have drawn this same card already.
        png = drawnCards.get(key);
        if (!png) {
          png = await drawCard(params, shared);
          rememberCard(key, png);
        }
      } finally {
        line.leave();
      }
    }

    res.set({
      'Content-Type': 'image/png',
      // Every input is in the URL, so the picture at a URL never changes, and
      // the website's proxy, Cloudflare and the preview bots may all keep it.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.send(png);
  } catch (err) {
    // The error's name only: a message from the renderer can carry card text.
    console.error('[og-card] could not draw a card:', (err && err.name) || 'Error');
    return refuse(503, 'The card could not be drawn.');
  }
});

module.exports = router;

// For __tests__/ogCard.test.js, which compares the card with the website's,
// draws real cards, and swaps the renderer to watch the line and the cache.
module.exports.__testables = {
  CARD_W,
  CARD_H,
  cleanText,
  cardParams,
  cardTree,
  cardSignature,
  usesSharedFont,
  loadRenderer,
  drawPng,
  MAX_WAITING,
  CACHE_MAX,
  lineState: () => ({ shared: sharedLine.state(), fallback: fallbackLine.state(), cards: drawnCards.size }),
  setDrawForTests: (fn) => { drawCard = fn || drawPng; },
  forgetCardsForTests: () => drawnCards.clear(),
};
