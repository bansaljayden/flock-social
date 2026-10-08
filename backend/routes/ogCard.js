'use strict';
// ---------------------------------------------------------------------------
// GET /api/og/invite?n&w&g&s: THE INVITE SHARE CARD, DRAWN HERE
// ---------------------------------------------------------------------------
// The 1200x630 PNG an invite link's preview shows: the plan's name, when it
// is, and how many are going. The preview page (frontend/api/invite-preview.js)
// points og:image at the website's own /api/invite-og, and on Cloudflare Pages
// that URL is a cached proxy in front of this route. Drawing the card there
// does not fit the free plan (one render is 20-130 ms of CPU against a 10 ms
// limit), so it is drawn here, from the same element tree
// (frontend/api/_og-card.js, copied below) by the same renderer the website
// uses: @vercel/og 0.8.6 is satori 0.16.0 and resvg 2.4.0 with one bundled
// font, and this file calls those two directly with that font (the renderer
// section below says why). __tests__/ogCard.test.js holds the copy to that
// file and the picture to the one the library draws, byte for byte.
//
// ONLY SIGNED CARDS ARE DRAWN. The preview signs each card URL with
// OG_CARD_SECRET, which the website and this service share: HMAC-SHA256 over
// "name\nwhen\ngoing", base64url, the first 22 characters. Anything else is a
// 403 before any work is done, so nobody can have their own text drawn on a
// Flock card, and a stream of made-up cards cannot keep the only thread busy.
// With the secret unset, or shorter than 32 characters, every card is refused
// and previews fall back to the website's static banner, and production says
// so in the deploy log.
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
const { UPSTREAM_TIMEOUT_MS, upstreamSignal } = require('../utils/upstream');

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
//
// THE FLOOR IS 32 CHARACTERS, the same as NFC_TAG_SECRET's and for the same
// reason. Every invite preview publishes n, w, g and the first 132 bits of
// their MAC in its og:image URL, so one shared preview is all it takes to test
// guesses at the secret offline, as fast as the guesser's hardware allows,
// with no request to us. A short secret is a secret somebody will recover, and
// with it they can sign their own text onto a Flock card and mint as many
// distinct cards as they like. So a value under MIN_SECRET characters, not
// counting surrounding whitespace, is treated exactly like an unset one, and
// says so once per process. The documented generator gives 43 characters. A
// length is only a proxy: thirty-two copies of one letter clear it, so the
// value still has to come from a generator.
const MIN_SECRET = 32;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{22}$/;

const announced = new Set();
function announceOnce(key, message) {
  if (announced.has(key)) return;
  announced.add(key);
  console.error(message);
}

// The one reader of OG_CARD_SECRET. Read per request, trimmed the way the
// website trims it, so a value pasted with a trailing newline signs the same
// cards on both sides. The line it logs names the length, never the value.
function cardSecret() {
  const raw = process.env.OG_CARD_SECRET;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (value.length < MIN_SECRET) {
    announceOnce(
      `short-secret:${value.length}`,
      `[og-card] OG_CARD_SECRET is ${value.length} characters. Every invite preview publishes the card's three `
      + `fields and a MAC of them, so a secret under ${MIN_SECRET} characters can be worked out offline from one `
      + 'shared preview, and with it anyone can sign their own text onto a Flock card. It is treated as UNSET: '
      + 'GET /api/og/invite refuses every card and invite previews show the static banner. Generate a new value '
      + "with node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\" and set it here and "
      + 'on the website.'
    );
    return null;
  }
  return value;
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
// On the first card rather than at boot: satori and resvg carry two wasm
// binaries, about 30 MB of the process once a card has been drawn, and most
// boots never draw one. A failed load is not remembered, so the next request
// tries again; a successful one is kept for good, because resvg can be
// initialised only once per process.
//
// WHY NOT THE LIBRARY'S ImageResponse. @vercel/og's render step hands satori a
// loader of its own for text the bundled font cannot draw (emoji, other
// scripts), and in a process that lives until the next deploy that loader is
// the problem. It keeps every download in a module-level map that never
// shrinks. It keeps an error page from the emoji CDN as if it were the emoji,
// for good. When a font download fails it draws the card without the text and
// logs the text. And its downloads have no deadline. Nothing in ImageResponse's
// options replaces it. So this file calls satori and resvg itself, with the
// options, the font and the PNG step the library's render step uses, and
// passes a loader of its own (the next section). The library stays a
// dependency for its font file and because it pins the satori and resvg the
// website draws with; __tests__/ogCard.test.js holds this service's copies of
// both to those pins.
//
// THE FONT IS PARSED ONCE, which is most of the memory story. satori keeps a
// parsed font per font LIST it is handed, and the library hands it a new list
// on every render, so it parses the bundled font again each time. In Node, 200
// renders back to back took the process to about 250 MB resident that way
// while heapUsed stayed small: garbage, which V8 hands back only after a quiet
// spell. One list for every card that needs nothing else, holding the very
// file the library reads, took the same run to about 120 MB and draws the same
// bytes.
let realRenderer = null;
let rendererForTests = null;

// The one font entry the library builds for itself on every render
// (dist/index.node.js): same name, weight and style.
function fontList(data) {
  return [{ name: 'sans serif', data, weight: 700, style: 'normal' }];
}

function loadRenderer() {
  if (rendererForTests) return Promise.resolve(rendererForTests);
  if (!realRenderer) {
    realRenderer = (async () => {
      const ogDist = path.join(path.dirname(require.resolve('@vercel/og/package.json')), 'dist');
      const [satori, resvg, fontData, wasm] = await Promise.all([
        import('satori'),
        import('@resvg/resvg-wasm'),
        fs.promises.readFile(path.join(ogDist, 'noto-sans-v27-latin-regular.ttf')),
        fs.promises.readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')),
      ]);
      await resvg.initWasm(wasm);
      return { satori: satori.default, Resvg: resvg.Resvg, fontData, sharedFonts: fontList(fontData) };
    })().catch((err) => {
      realRenderer = null;
      throw err;
    });
  }
  return realRenderer;
}

// Text the bundled font draws by itself: printable ASCII, Latin-1, and the
// curly quotes, dashes, bullet and ellipsis that phones type for you. It has a
// glyph for every one of these, so satori never asks for anything else and the
// card can use the shared list. Anything outside this set, an emoji or another
// script, may need a download, so those cards get a list of their own, parsed
// for that one render and dropped after it, and the loader below.
const SHARED_FONT_TEXT = /^[\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]*$/;

function usesSharedFont(params) {
  return SHARED_FONT_TEXT.test(params.name + params.when);
}

// The shared list must never grow, so a shared card that asks for anything
// fails instead (the gate above says it cannot happen).
async function refuseFallback() {
  const err = new Error('A card on the shared font list asked for a fallback.');
  err.name = 'SharedFontFallback';
  throw err;
}

async function drawPng(params, sharedFont, signal) {
  const { satori, Resvg, fontData, sharedFonts } = await loadRenderer();
  const svg = await satori(cardTree(params), {
    width: CARD_W,
    height: CARD_H,
    debug: false,
    fonts: sharedFont ? sharedFonts : fontList(fontData),
    loadAdditionalAsset: sharedFont ? refuseFallback : fallbackAssets(signal),
  });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_W } });
  try {
    const image = resvg.render();
    try {
      return Buffer.from(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

// ── Text the bundled font cannot draw ───────────────────────────────────────
// For an emoji satori asks for a picture, and for another script a font. Both
// come from where the library gets them, with the same requests, so the card
// draws the same bytes as the website's:
//   * an emoji is Twemoji 14.0.2's SVG from cdn.jsdelivr.net, as a data URL;
//   * another script is the Noto family Google Fonts serves for it. Which
//     family draws which character comes from the unicode-range lines in the
//     family's stylesheet (fonts.googleapis.com, read once per family), and
//     the font itself is a subset Google cuts for exactly that text: a second
//     stylesheet names the file, on fonts.gstatic.com. The two User-Agent
//     strings are the library's, and they matter: Google answers each with a
//     different stylesheet, the first listing unicode ranges and the second
//     linking a TrueType file.
// What differs from the library is everything around a download:
//   * a non-2xx answer, a network error, or a stylesheet missing the piece it
//     was asked for fails the render, so a card with a hole in it is answered
//     503 and is never drawn, kept or cached anywhere;
//   * every download carries the render's deadline (FALLBACK_DEADLINE_MS) and
//     is abandoned when the render ends;
//   * nothing is kept between renders except the unicode ranges, at most one
//     entry per family in FALLBACK_FAMILIES, so memory cannot grow with card
//     text;
//   * nothing here logs, because a font URL carries card text.
const EMOJI_SVG = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/';
const FONT_CSS = 'https://fonts.googleapis.com/css2?';
const FONT_FILES = 'https://fonts.gstatic.com/';
const RANGES_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36';
const FONT_FILE_AGENT = 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1';

// The Google Fonts families for each script code satori names, the table the
// library uses. A code that is not here gets no font, as in the library: the
// character is left off the card.
const FALLBACK_FAMILIES = Object.freeze({
  'ja-JP': ['Noto+Sans+JP'],
  'ko-KR': ['Noto+Sans+KR'],
  'zh-CN': ['Noto+Sans+SC'],
  'zh-TW': ['Noto+Sans+TC'],
  'zh-HK': ['Noto+Sans+HK'],
  'th-TH': ['Noto+Sans+Thai'],
  'bn-IN': ['Noto+Sans+Bengali'],
  'ar-AR': ['Noto+Sans+Arabic'],
  'ta-IN': ['Noto+Sans+Tamil'],
  'ml-IN': ['Noto+Sans+Malayalam'],
  'he-IL': ['Noto+Sans+Hebrew'],
  'te-IN': ['Noto+Sans+Telugu'],
  devanagari: ['Noto+Sans+Devanagari'],
  kannada: ['Noto+Sans+Kannada'],
  symbol: ['Noto+Sans+Symbols', 'Noto+Sans+Symbols+2'],
  math: ['Noto+Sans+Math'],
  unknown: ['Noto+Sans'],
});

// family -> the code points it covers, from its stylesheet. Keys come only
// from FALLBACK_FAMILIES, so this holds at most one entry per family there.
const familyRanges = new Map();

// Every download goes through this. The render's own deadline rides in as
// `signal`; a caller that brings none still gets the same length on its own,
// so no download here can outlive FALLBACK_DEADLINE_MS. Swapped only by
// __tests__/ogCard.test.js.
function downloadOnce(url, { headers, signal } = {}) {
  return fetch(url, { headers, signal: signal || upstreamSignal('cardAssets') });
}
let download = downloadOnce;

function refused(message) {
  const err = new Error(message);
  err.name = 'DownloadRefused';
  return err;
}

async function fetchOk(url, init) {
  const res = await download(url, init);
  if (!res || !res.ok) {
    try { await res.body.cancel(); } catch { /* nothing to free */ }
    throw refused('A font or emoji download was not answered with its file.');
  }
  return res;
}

async function loadRanges(families, signal) {
  const missing = families.filter((f) => !familyRanges.has(f));
  if (!missing.length) return;
  const url = FONT_CSS + missing.map((f) => `family=${f}&`).join('') + 'display=swap';
  const css = await (await fetchOk(url, { headers: { 'User-Agent': RANGES_AGENT }, signal })).text();
  const found = new Map();
  for (const block of css.split('@font-face').slice(1)) {
    const family = /font-family:\s*'([^']+)'/.exec(block);
    const ranges = /unicode-range:\s*([^;]+);/.exec(block);
    if (!family || !ranges) continue;
    const name = family[1].replace(/ /g, '+');
    const list = found.get(name) || [];
    for (const part of ranges[1].split(',')) {
      const [from, to] = part.trim().replace(/U\+/g, '').split('-').map((hex) => parseInt(hex, 16));
      list.push(to === undefined || Number.isNaN(to) ? from : [from, to]);
    }
    found.set(name, list);
  }
  if (missing.some((f) => !found.has(f))) throw refused('A font stylesheet left out a family it was asked for.');
  for (const f of missing) familyRanges.set(f, found.get(f));
}

function covers(family, ch) {
  const ranges = familyRanges.get(family);
  const point = ch.codePointAt(0);
  return !!ranges && !!point && ranges.some((r) => (typeof r === 'number' ? r === point : r[0] <= point && point <= r[1]));
}

async function fontFile(family, part, signal) {
  const url = `${FONT_CSS}family=${family}&text=${encodeURIComponent(part)}`;
  const css = await (await fetchOk(url, { headers: { 'User-Agent': FONT_FILE_AGENT }, signal })).text();
  const src = /src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/.exec(css);
  // Only Google's own font host: the API makes outside calls to the three
  // hosts named above and to nothing a stylesheet could point it at.
  if (!src || !src[1].startsWith(FONT_FILES)) throw refused('A font stylesheet named no font file.');
  return (await fetchOk(src[1], { signal })).arrayBuffer();
}

// Twemoji names a picture by its code points in hex, joined by dashes, with
// the emoji presentation selector (U+FE0F) dropped unless the emoji is a
// zero-width-joiner sequence.
function twemojiName(grapheme) {
  const bare = grapheme.includes('\u200d') ? grapheme : grapheme.replace(/\ufe0f/g, '');
  return [...bare].map((ch) => ch.codePointAt(0).toString(16)).join('-');
}

// satori's loadAdditionalAsset for one render: (code, text) -> an emoji
// picture as a data URL, or the fallback fonts for that text. The font entries
// are built exactly as the library builds them, names and languages included,
// because satori reads both when it picks a font for a character.
function fallbackAssets(signal) {
  return async (code, chars) => {
    if (code === 'emoji') {
      const res = await fetchOk(`${EMOJI_SVG}${twemojiName(chars)}.svg`, { signal });
      return 'data:image/svg+xml;base64,' + btoa(await res.text());
    }
    const codes = code.split('|');
    const families = codes.flatMap((c) => (Object.hasOwn(FALLBACK_FAMILIES, c) ? FALLBACK_FAMILIES[c] : []));
    if (!families.length) return [];
    await loadRanges(families, signal);
    const partFor = new Map();
    for (const ch of chars) {
      const family = families.find((f) => covers(f, ch));
      if (family) partFor.set(family, (partFor.get(family) || '') + ch);
    }
    const files = await Promise.all([...partFor].map(([family, part]) => fontFile(family, part, signal)));
    return files.map((data, i) => ({
      name: `satori_${codes[i]}_fallback_${chars}`,
      data,
      weight: 400,
      style: 'normal',
      lang: codes[i] === 'unknown' ? undefined : codes[i],
    }));
  };
}

// Swapped only by __tests__/ogCard.test.js, to watch the lines below without
// drawing anything.
let drawCard = drawPng;

// ── A deadline for a card that downloads ────────────────────────────────────
// A shared card is CPU alone, 15 to 30 ms, and needs none. A fallback card
// waits on three outside hosts, and fetch's own timeouts run to minutes, which
// would hold the fallback line for all of them. FALLBACK_DEADLINE_MS is the
// outbound deadline utils/upstream.js records for these downloads, well inside
// the website proxy's 4 s; past it the render's downloads are aborted, the
// answer is a 503, and the line moves on at once.
const FALLBACK_DEADLINE_MS = UPSTREAM_TIMEOUT_MS.cardAssets;
let fallbackDeadlineMs = FALLBACK_DEADLINE_MS;

async function drawWithDeadline(params, shared) {
  if (shared) return drawCard(params, true);
  const controller = new AbortController();
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('The card took too long to draw.');
      err.name = 'TimeoutError';
      controller.abort(err);
      reject(err);
    }, fallbackDeadlineMs);
    timer.unref();
  });
  const drawing = drawCard(params, false, controller.signal);
  // A render cut off by the deadline settles after nobody is listening.
  drawing.catch(() => {});
  try {
    return await Promise.race([drawing, deadline]);
  } finally {
    clearTimeout(timer);
    // Whatever this render still has in flight stops now, success or not.
    controller.abort();
  }
}

// ── One render at a time ────────────────────────────────────────────────────
// A warm render is 15 to 30 ms of CPU on the only thread, nearly all of it
// synchronous, so a second render alongside buys no throughput; it only adds
// another render's garbage to the heap. Each kind of card gets its own line,
// because only a fallback render waits on the network: a slow download holds
// up other emoji and non-Latin cards, never the rest. Past MAX_WAITING the
// answer is a 503 at once, and on the fallback line a card still waiting after
// FALLBACK_WAIT_MS gives up the same way, since the website proxy stopped
// listening at 4 s and a render nobody waits for only delays the next card.
// The website shows its static banner for that one fetch and caches nothing,
// so the next fetch of the same URL can still get the card.
const MAX_WAITING = 8;
const FALLBACK_WAIT_MS = 4000;
let fallbackWaitMs = FALLBACK_WAIT_MS;

function renderLine(maxWaitMs) {
  let running = false;
  const waiting = [];
  return {
    // Resolves true once this request holds the line, or false when the line
    // is already full or the wait runs out first.
    enter() {
      if (!running) {
        running = true;
        return Promise.resolve(true);
      }
      if (waiting.length >= MAX_WAITING) return Promise.resolve(false);
      return new Promise((resolve) => {
        const turn = { resolve, timer: null };
        const limit = maxWaitMs();
        if (Number.isFinite(limit)) {
          turn.timer = setTimeout(() => {
            const at = waiting.indexOf(turn);
            if (at !== -1) waiting.splice(at, 1);
            resolve(false);
          }, limit);
          turn.timer.unref();
        }
        waiting.push(turn);
      });
    },
    // The turn passes straight to the next in line, so a newcomer can never
    // overtake somebody who was already waiting.
    leave() {
      const next = waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(true);
      } else {
        running = false;
      }
    },
    state() {
      return { running: running ? 1 : 0, waiting: waiting.length };
    },
  };
}

const sharedLine = renderLine(() => Infinity);
const fallbackLine = renderLine(() => fallbackWaitMs);

// ── Recently drawn cards ────────────────────────────────────────────────────
// Every input is in the URL, so a card URL always draws the same picture. The
// website's proxy keeps each URL, but per Cloudflare data center, so one card
// can arrive here from several of them, and anybody can replay a real card URL
// straight at this service. Keeping the last CACHE_MAX makes both free. About
// 30 KB each; the oldest goes first.
const CACHE_MAX = 64;
const drawnCards = new Map();

function rememberCard(key, png) {
  drawnCards.delete(key);
  drawnCards.set(key, png);
  while (drawnCards.size > CACHE_MAX) drawnCards.delete(drawnCards.keys().next().value);
}

// ── One render per card ─────────────────────────────────────────────────────
// Requests for a card that is already being drawn wait for that render rather
// than queueing another: a preview shared into a group chat is fetched by
// several bots at once, and each would otherwise take a place in the line and
// find the card drawn when its turn came. The entry lives exactly as long as
// its render and is deleted when it settles, success or not.
const rendering = new Map();

// Resolves with the PNG, or with null when the line had no room for it.
async function drawInLine(key, params, shared) {
  const line = shared ? sharedLine : fallbackLine;
  if (!(await line.enter())) return null;
  try {
    const png = await drawWithDeadline(params, shared);
    rememberCard(key, png);
    return png;
  } finally {
    line.leave();
  }
}

function cardFor(key, params, shared) {
  let pending = rendering.get(key);
  if (!pending) {
    pending = drawInLine(key, params, shared).finally(() => rendering.delete(key));
    rendering.set(key, pending);
  }
  return pending;
}

// What the answer tells the website's proxy, Cloudflare and the preview bots.
// Every input is in the URL, so the picture at a URL never changes, and a card
// the bundled font draws alone may be kept for a year. A card drawn with
// downloaded fonts or emoji gets an hour, the time Vercel's CDN kept a card:
// every download it used came back whole, but what Google or jsDelivr serve
// is outside this repo, and an hour bounds any surprise in it.
const SHARED_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const FALLBACK_CACHE_CONTROL = 'public, max-age=3600';

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
    const params = cardParams({ n, w, g });
    const shared = usesSharedFont(params);
    // A card already drawn is served without queueing, so a full line never
    // turns a replayed real card into a 503.
    const png = drawnCards.get(key) || await cardFor(key, params, shared);
    if (!png) {
      res.set('Retry-After', '5');
      return refuse(503, 'Too many cards are being drawn. Try again in a moment.');
    }

    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': shared ? SHARED_CACHE_CONTROL : FALLBACK_CACHE_CONTROL,
    });
    return res.send(png);
  } catch (err) {
    // The error's name only: a message from the renderer or a download can
    // carry card text.
    console.error('[og-card] could not draw a card:', (err && err.name) || 'Error');
    return refuse(503, 'The card could not be drawn.');
  }
});

module.exports = router;

// For __tests__/ogCard.test.js, which compares the card with the website's,
// draws real cards, and swaps the renderer, the downloads and the timings to
// watch the lines, the cache and the loader.
module.exports.__testables = {
  CARD_W,
  CARD_H,
  cleanText,
  cardParams,
  cardTree,
  cardSignature,
  cardSecret,
  MIN_SECRET,
  usesSharedFont,
  loadRenderer,
  drawPng,
  fallbackAssets,
  FALLBACK_FAMILIES,
  MAX_WAITING,
  CACHE_MAX,
  FALLBACK_DEADLINE_MS,
  FALLBACK_WAIT_MS,
  SHARED_CACHE_CONTROL,
  FALLBACK_CACHE_CONTROL,
  lineState: () => ({
    shared: sharedLine.state(),
    fallback: fallbackLine.state(),
    cards: drawnCards.size,
    rendering: rendering.size,
    families: familyRanges.size,
  }),
  setDrawForTests: (fn) => { drawCard = fn || drawPng; },
  setRendererForTests: (renderer) => { rendererForTests = renderer || null; },
  setDownloadForTests: (fn) => { download = fn || downloadOnce; },
  setTimingForTests: (timing) => {
    fallbackDeadlineMs = (timing && timing.deadlineMs) || FALLBACK_DEADLINE_MS;
    fallbackWaitMs = (timing && timing.waitMs) || FALLBACK_WAIT_MS;
  },
  forgetCardsForTests: () => drawnCards.clear(),
  forgetRangesForTests: () => familyRanges.clear(),
};

// SAY IT AT BOOT. cardSecret() names a short secret the first time a card is
// asked for, which can be hours after a deploy, and the deploy log is where
// somebody looks when a variable has just changed. So production asks once at
// require time, the way routes/checkin.js does for NFC_TAG_SECRET, and here an
// unset secret is named too: until it is set on this service and on the
// website, every invite preview shows the static banner instead of its card,
// and nothing else would ever say why.
if (process.env.NODE_ENV === 'production') {
  const raw = process.env.OG_CARD_SECRET;
  if (typeof raw !== 'string' || !raw.trim()) {
    announceOnce(
      'unset',
      '[og-card] OG_CARD_SECRET is not set, so GET /api/og/invite refuses every card and invite previews show the '
      + 'static banner. Set the same value here and on the website (backend/.env.example says how) to draw them.'
    );
  } else {
    cardSecret();
  }
}
