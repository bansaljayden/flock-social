/* THE WEBSITE HOLDS STILL WHEN ITS DISPLAY FACE ARRIVES.
 *
 * Fraunces loads with font-display: swap, so a first visit paints the
 * marketing pages in a metric-matched local fallback and swaps the face in
 * when the file lands (src/website/LandingPage.css, the note at the top: one
 * fallback per optical size the site sets). Wherever the two set a line
 * differently, everything under it on the first screen jumps. On 2026-11-07
 * /research's lead and paper card rose 36px at 340 to 350px wide, and the
 * card dropped 23px at 430 to 470 (layout shift 0.17 and 0.07 with the face
 * held back 1.5 s), while main's build scored 0 there.
 *
 * Two browsers open each page, one never given the Fraunces file and one with
 * it, and both are resized through every 5px from 320 to 480, every 20px from
 * 500 to 1440 and the widths real phones, tablets and laptops are. At each
 * width every box that starts on the first screen, in either, must start
 * within 3px of the same place in both. A line gained or lost moves what is
 * under it by a whole line, 22px or more here; inside a line that does not
 * change, the two faces' glyphs can sit a pixel apart (the home headline's
 * second line does, at some widths), which moves nothing, and Chromium
 * scores 0 there. A failure names the width, the box and where it moved.
 *
 * websiteDisplayFace.test.js holds the stylesheet side (each cut's face, and
 * every rule that fixes an optical size naming it).
 *
 * IN CHROMIUM, where the rest of this suite runs in WebKit as an iPhone. The
 * WebKit Playwright runs on Windows sets type with its own port's metrics,
 * not Safari's: the home headline's second line sits 3px lower in the
 * fallback than in Fraunces at every width there, and in Chromium at none,
 * so a check in it would measure the port rather than the fallbacks. The
 * fallbacks were matched, and the 0.17 shift measured, in Chromium.
 */
'use strict';

const { test, expect } = require('@playwright/test');

test.use({ browserName: 'chromium' });

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;
const FACE_FILE = /\/static\/media\/Fraunces-var\.[0-9a-f]+\.woff2(\?.*)?$/;
const ROUTES = ['/', '/tap', '/about', '/ai', '/flux', '/how-it-works', '/research'];
// Phones every 5px, the rest every 20px, and the widths real devices are,
// to the pixel: iPhones from the SE to the Pro Max, Pixels and Galaxies, iPads
// upright and sideways, and the common laptops.
const DEVICES = [360, 375, 384, 390, 393, 402, 412, 414, 428, 430, 440, 744, 768, 800, 810, 820, 834, 1024, 1080, 1180, 1194, 1280, 1366, 1440];
const WIDTHS = [];
for (let w = 320; w <= 480; w += 5) WIDTHS.push(w);
for (let w = 500; w <= 1440; w += 20) WIDTHS.push(w);
for (const w of DEVICES) if (!WIDTHS.includes(w)) WIDTHS.push(w);
WIDTHS.sort((a, b) => a - b);
const heightFor = (w) => (w < 700 ? 844 : 900);
const MOVED_PX = 3;

// Every box in the page's main column that starts within the first screen
// (and 400px past it, so a box that moves into view is seen), keyed by its
// place in the tree, which both browsers build the same.
function boxes(H) {
  const out = {};
  const root = document.querySelector('main') || document.body;
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if ((r.width === 0 && r.height === 0) || r.top >= H + 400) continue;
    const key = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      key.push(n.tagName + (n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) : 0));
    }
    const name = el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '');
    out[key.reverse().join('/')] = { name, l: r.left, t: r.top, w: r.width, h: r.height };
  }
  return out;
}

async function open(browser, route, { withFace }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  if (!withFace) await page.route(FACE_FILE, (r) => r.abort());
  await page.goto(WEB + route, { waitUntil: 'load' });
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

for (const route of ROUTES) {
  test(`${route} sets its first screen the same before and after Fraunces arrives, 320 to 1440 wide`, async ({ browser }) => {
    test.setTimeout(180_000);
    const fallback = await open(browser, route, { withFace: false });
    const face = await open(browser, route, { withFace: true });
    try {
      // The comparison is only worth something if one page is in the
      // fallback and the other in Fraunces.
      const fraunces = (page) => page.evaluate(() => [...document.fonts].filter((f) => f.family === 'Fraunces').map((f) => f.status));
      expect(await fraunces(face.page)).toContain('loaded');
      expect(await fraunces(fallback.page)).not.toContain('loaded');

      const moved = [];
      for (const W of WIDTHS) {
        const H = heightFor(W);
        await fallback.page.setViewportSize({ width: W, height: H });
        await face.page.setViewportSize({ width: W, height: H });
        await settle(fallback.page);
        await settle(face.page);
        const before = await fallback.page.evaluate(boxes, H);
        const after = await face.page.evaluate(boxes, H);
        const inView = (r) => r.t < H && r.t + r.h > 0 && r.l < W && r.l + r.w > 0;
        for (const [key, a] of Object.entries(before)) {
          const b = after[key];
          if (!b || (!inView(a) && !inView(b))) continue;
          if (Math.abs(b.t - a.t) >= MOVED_PX || Math.abs(b.l - a.l) >= MOVED_PX) {
            moved.push(`${W}px: ${a.name} ${Math.round(a.t)} -> ${Math.round(b.t)}`);
            break;
          }
        }
      }
      expect(moved, `boxes on ${route}'s first screen move when the face arrives`).toEqual([]);
    } finally {
      await fallback.context.close();
      await face.context.close();
    }
  });
}
