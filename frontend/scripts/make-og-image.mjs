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
 * Run:  node scripts/make-og-image.mjs          (from frontend/)
 *       node scripts/make-og-image.mjs --out /tmp/preview.png
 *
 * Needs network access for the two Google Fonts faces. It waits on
 * document.fonts.ready and asserts both loaded, because a silent fallback to
 * Georgia would produce a plausible-looking card in the wrong typeface and
 * nobody would notice until it was public.
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

/* The card's copy. Both lines are duplicated in the page and in the meta tags,
   and the test named in the header is what keeps the three in agreement. */
const HEADLINE = 'Get the flock out the door.';
const SUBHEAD = 'Vote on where to go, see how busy it is, split the bill. Free.';
const URL_PILL = 'flockcorp.com';

/* Brand tokens, read off src/website/LandingPage.css rather than sampled from
   the old PNG, so the card and the page it links to cannot drift apart. */
const PAPER = '#f1ede0';   // --paper
const INK = '#16283d';     // --ink
const NAVY = '#0f172a';    // --navy
const SLATE = '#2d5a87';   // the subhead blue used across the marketing pages

const logoDataUri = `data:image/png;base64,${fs
  .readFileSync(path.join(FRONTEND_DIR, 'public', 'flock-logo.png'))
  .toString('base64')}`;

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Hanken+Grotesk:wght@500;700&display=block" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  /* STACKED, not side by side, and that is what buys the single line. The
     slogan is one sentence on one line by decision, and a 280px logo beside it
     left about 710px for 27 characters, which works out near 52px of type:
     small enough that the line stops reading as a headline at the thumbnail
     size these cards are actually seen at. Full width is 1056px and carries
     the same sentence at 76px. */
  body {
    background: ${PAPER};
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 0 72px;
    font-family: 'Hanken Grotesk', -apple-system, sans-serif;
  }

  /* flock-logo.png is a cream circle inscribed in an OPAQUE WHITE square, so
     dropping it straight onto the cream ground shows four white corners. The
     circle touches all four edges, so a 50% radius clips exactly along it and
     the plate disappears into the background. */
  .logo { width: 132px; height: 132px; margin-bottom: 38px; }
  .logo img { width: 100%; height: 100%; display: block; border-radius: 50%; }

  /* Fraunces at 600. opsz is left to the optical-size axis default for the
     rendered pixel size, which is what the landing hero does too.
     white-space: nowrap on purpose: it makes an over-long line RUN OFF the
     card, which the guard below measures and refuses, instead of quietly
     wrapping into the two lines this layout exists to avoid. */
  h1 {
    font-family: 'Fraunces', Georgia, serif;
    font-weight: 600;
    font-size: 76px;
    line-height: 1.05;
    letter-spacing: -1.8px;
    color: ${INK};
    white-space: nowrap;
  }

  p {
    font-size: 27px;
    font-weight: 500;
    color: ${SLATE};
    margin-top: 30px;
    letter-spacing: -0.2px;
  }

  .pill {
    display: inline-block;
    margin-top: 34px;
    padding: 15px 30px;
    border-radius: 12px;
    background: ${NAVY};
    color: ${PAPER};
    font-size: 25px;
    font-weight: 700;
    letter-spacing: -0.2px;
  }
</style></head>
<body>
  <div class="logo"><img src="${logoDataUri}" alt=""></div>
  <h1>${HEADLINE}</h1>
  <p>${SUBHEAD}</p>
  <div><span class="pill">${URL_PILL}</span></div>
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

  /* A missing webfont degrades to Georgia silently and the card still looks
     deliberate, so check rather than trust. */
  const loaded = await page.evaluate(() => ({
    fraunces: document.fonts.check('600 76px Fraunces'),
    hanken: document.fonts.check('700 25px "Hanken Grotesk"'),
  }));
  if (!loaded.fraunces || !loaded.hanken) {
    throw new Error(
      `webfonts did not load (Fraunces: ${loaded.fraunces}, Hanken Grotesk: ${loaded.hanken}). ` +
        'This machine needs network access to fonts.googleapis.com. Refusing to write a ' +
        'card in fallback type.'
    );
  }

  /* The headline must not wrap past the two lines written above, and nothing
     may spill out of the 630px card. Both are silent failures in a PNG. */
  const fits = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const range = document.createRange();
    range.selectNodeContents(h1);
    return {
      // The INK width, measured off a range over the text rather than off the
      // block, which is full-bleed and would always "fit".
      textWidth: Math.ceil(range.getBoundingClientRect().width),
      available: Math.floor(h1.getBoundingClientRect().width),
      lines: range.getClientRects().length,
      bodyScrollH: document.body.scrollHeight,
      bodyScrollW: document.body.scrollWidth,
    };
  });
  // nowrap means an over-long line runs OFF the card rather than wrapping, so
  // the check is the text against the space it has, plus a line count, and
  // either one failing stops the write.
  if (fits.lines !== 1) {
    throw new Error(`the headline must be ONE line, measured ${fits.lines}. Reduce font-size.`);
  }
  if (fits.textWidth > fits.available) {
    throw new Error(
      `the headline runs off the card (${fits.textWidth}px of text in ${fits.available}px). Reduce font-size.`
    );
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
