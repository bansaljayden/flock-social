#!/usr/bin/env node
/**
 * make-og-image.mjs: regenerates frontend/public/og-image.png.
 *
 * This is the 1200x630 card every link preview shows: iMessage, Slack,
 * Twitter, Discord, anything that reads og:image. It carries the headline as
 * BAKED PIXELS, which is the whole reason this script exists.
 *
 * The card was previously made by hand, once, in August 2026, and nothing in
 * the repo recorded how. So when the hero headline changed on 2026-09-05 the
 * image kept rendering the retired line while index.html, marketing-page.js
 * and invite-preview.js all advertised the new one in og:image:alt. Alt text
 * that disagrees with its own image is worse than no alt text: a screen
 * reader announces a sentence that is not on the card, and every human sees
 * dead copy on the most-shared surface the product has.
 *
 * So the rule is: THE HEADLINE BELOW AND THE ONE IN LandingPage.js ARE THE
 * SAME SENTENCE, and `src/__tests__/ogImageCopy.test.js` fails if they drift.
 * Change the hero, run this, commit the PNG.
 *
 * Since 2026-10-21 the card is the headline and the address on the website's
 * off-white, beside a real crop of the app (the Friday Night Crew chat, its
 * vote half in) on a navy panel. It used to be the slogan, a three-item
 * feature line and a navy pill styled as a button that nobody can press
 * inside an image.
 *
 * Run:  node scripts/make-og-image.mjs          (from frontend/)
 *       node scripts/make-og-image.mjs --out=/tmp/preview.png
 *
 * Needs no network: both faces are the site's own files in src/fonts, inlined.
 * It still waits on document.fonts.ready and asserts both loaded, because a
 * silent fallback to Georgia would produce a plausible-looking card in the
 * wrong typeface and nobody would notice until it was public.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');

const argOut = process.argv.find((a) => a.startsWith('--out='));
const OUT = argOut
  ? path.resolve(argOut.slice('--out='.length))
  : path.join(FRONTEND_DIR, 'public', 'og-image.png');

/* The card's copy. The headline is duplicated in the page and in the meta
   tags, and the test named in the header is what keeps the three in
   agreement. The address is plain text, never a button. */
const HEADLINE = 'Flock is how a group decides where to go out.';
const SITE = 'flockcorp.com';

/* Brand tokens, read off src/website/LandingPage.css rather than sampled from
   an old PNG, so the card and the page it links to cannot drift apart. */
const PAPER = '#f9f8f4';   // --paper
const INK = '#16283d';     // --ink
const STEEL = '#2d5a87';   // --steel
const NAVY = '#0b1a2e';    // --navy

const dataUri = (rel, type) => `data:${type};base64,${fs
  .readFileSync(path.join(FRONTEND_DIR, rel))
  .toString('base64')}`;

const logo = dataUri('public/flock-logo.png', 'image/png');
const shot = dataUri('public/screenshots/chat-dark@2x.webp', 'image/webp');
const display = dataUri('src/fonts/Literata-Display-600.woff2', 'font/woff2');
const body = dataUri('src/fonts/HankenGrotesk-var.woff2', 'font/woff2');

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: 'Literata Display'; src: url(${display}) format('woff2'); font-weight: 400 700; }
  @font-face { font-family: 'Hanken Grotesk'; src: url(${body}) format('woff2'); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    background: ${PAPER};
    display: grid;
    grid-template-columns: minmax(0, 1fr) 420px;
    font-family: 'Hanken Grotesk', -apple-system, sans-serif;
  }
  .copy {
    padding: 0 40px 0 72px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  /* flock-logo.png is a cream circle inscribed in an OPAQUE WHITE square, so a
     50% radius clips exactly along the circle and the white corners go. */
  .logo { width: 92px; height: 92px; margin-bottom: 40px; }
  .logo img { width: 100%; height: 100%; display: block; border-radius: 50%; }
  /* Two lines, broken after "group" so "out." never stands alone. The guard
     below measures the lines and refuses a third. */
  h1 {
    font-family: 'Literata Display', Georgia, serif;
    font-weight: 600;
    font-size: 54px;
    line-height: 1.12;
    letter-spacing: -0.4px;
    color: ${INK};
  }
  p {
    font-size: 25px;
    font-weight: 600;
    color: ${STEEL};
    margin-top: 30px;
  }
  /* The navy panel and the real screen in it, cropped by the card's bottom
     edge the way a print crops a plate. */
  .panel { background: ${NAVY}; position: relative; overflow: hidden; }
  .panel img {
    position: absolute;
    left: 56px;
    top: 58px;
    width: 308px;
    border-radius: 30px;
    border: 1px solid rgba(244, 239, 227, 0.18);
  }
</style></head>
<body>
  <div class="copy">
    <div class="logo"><img src="${logo}" alt=""></div>
    <h1>${HEADLINE.replace(' group ', ' group<br>')}</h1>
    <p>${SITE}</p>
  </div>
  <div class="panel"><img src="${shot}" alt=""></div>
</body></html>`;

const { chromium } = await import('playwright');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  /* A missing face degrades to Georgia silently and the card still looks
     deliberate, so check rather than trust. */
  const loaded = await page.evaluate(() => ({
    display: document.fonts.check('600 54px "Literata Display"'),
    body: document.fonts.check('600 25px "Hanken Grotesk"'),
  }));
  if (!loaded.display || !loaded.body) {
    throw new Error(
      `fonts did not load (Literata Display: ${loaded.display}, Hanken Grotesk: ${loaded.body}). ` +
        'Refusing to write a card in fallback type.'
    );
  }

  /* The headline must hold to two lines inside its column, and nothing may
     spill out of the 630px card. Both are silent failures in a PNG. */
  const fits = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const range = document.createRange();
    range.selectNodeContents(h1);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1);
    return {
      // Distinct line tops, not rect count: the <br> splits the text into two
      // nodes, and each contributes its own rects.
      lines: new Set(rects.map((r) => Math.round(r.top))).size,
      textRight: Math.ceil(Math.max(...rects.map((r) => r.right))),
      columnRight: Math.floor(h1.getBoundingClientRect().right),
      bodyScrollH: document.body.scrollHeight,
      bodyScrollW: document.body.scrollWidth,
    };
  });
  if (fits.lines > 2) {
    throw new Error(`the headline must fit on TWO lines, measured ${fits.lines}. Reduce font-size.`);
  }
  if (fits.textRight > fits.columnRight) {
    throw new Error(`the headline runs past its column (${fits.textRight} > ${fits.columnRight}). Reduce font-size.`);
  }
  if (fits.bodyScrollH > 630 || fits.bodyScrollW > 1200) {
    throw new Error(`content overflows the card (${fits.bodyScrollW}x${fits.bodyScrollH}).`);
  }

  await page.screenshot({ path: OUT, type: 'png' });
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`wrote ${path.relative(FRONTEND_DIR, OUT) || OUT} (1200x630, ${kb} KB)`);
} finally {
  await browser.close();
}
