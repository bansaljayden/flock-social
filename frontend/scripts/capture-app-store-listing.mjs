#!/usr/bin/env node
/**
 * capture-app-store-listing.mjs: the picture of Flock's App Store listing on
 * the home page (src/website/AppStoreListing.js), taken from Apple's public
 * page.
 *
 * It opens https://apps.apple.com/us/app/flock-social-app/id6781442127 the
 * way any visitor can: signed out, read-only, nothing clicked. Twice, at 2x:
 * at 1440 wide, where Apple lays the page out for a desktop, and at 390 wide
 * in a phone browser, where it lays it out for a phone. (An iPhone's own
 * browser never gets the page: Apple answers it with a redirect into the App
 * Store app.)
 *
 * WHAT THE PICTURE HOLDS, AND WHAT IT MAY NOT. The crop is the listing's
 * header band and nothing else: Flock's icon, the name, the subtitle and
 * Apple's two lines under them ("Only for iPhone" and the price line).
 * Left out, by where the crop stops rather than by covering anything up:
 *   - the row of chips under the band (age rating, category, developer,
 *     language, size). The developer chip names the account holder, not the
 *     company, until Apple finishes moving the account to Flock Social LLC;
 *   - the screenshot carousel, whose screens show Google Maps photos of real
 *     venues, which the site keeps where they are;
 *   - Apple's own navigation and its App Store mark.
 * So the script reads every piece of text the browser actually paints inside
 * each crop and refuses to write anything unless it is exactly EXPECTED below.
 * A listing that changes (a new name, ratings in the band, the developer
 * moved up into it) stops the run instead of reaching the site.
 *
 * The band is measured, not guessed: Apple's first `section.shelf`. On the
 * desktop layout it runs on to the window's right edge as an empty blur, so
 * the crop ends where the words end plus the band's own left padding. Two
 * slivers come off: the shadow Apple's fixed top bar casts on the phone
 * band's first 3px, and the band's last 1-2px, which blend into the page
 * under it. Then the edges are checked against the page's light grey.
 *
 * Writes into public/marks/ (or --out=<dir>): for each layout a 1x and a 2x
 * WebP, and a 2x palette PNG for browsers without WebP.
 *
 * Run:  node scripts/capture-app-store-listing.mjs          (from frontend/)
 *       node scripts/capture-app-store-listing.mjs --out=/tmp/listing
 *
 * Needs the network (Apple's page) and the dev dependencies (playwright,
 * sharp). Look at the pictures before committing them.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? path.resolve(outArg.slice('--out='.length)) : path.join(HERE, '..', 'public', 'marks');

const LISTING_PAGE = 'https://apps.apple.com/us/app/flock-social-app/id6781442127';

// The only text the picture may show, in reading order.
const EXPECTED = [
  'Flock Social App',
  'Friends Together, Venues Alive',
  'Only for iPhone',
  'Free · Designed for iPhone. Not verified for macOS.',
];

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// Trims in CSS px. Each layout's crop is pinned in appStoreLive.test.js.
const LAYOUTS = [
  { name: 'desktop', viewport: { width: 1440, height: 1000 }, userAgent: CHROME_WINDOWS, mobile: false, trimRight: true, top: 0, bottom: 2 },
  { name: 'phone', viewport: { width: 390, height: 844 }, userAgent: CHROME_ANDROID, mobile: true, trimRight: false, top: 3, bottom: 2 },
];

// The page's own ground under the band, and how close an edge row may come to it.
const PAGE_GREY = 232;

async function measure(page, layout) {
  return page.evaluate(({ trimRight, top, bottom }) => {
    const band = document.querySelector('p.subtitle').closest('section.shelf');
    const content = band.querySelector('.content-container');
    const b = band.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const pad = c.left - b.left;
    return {
      x: Math.round(b.left),
      y: Math.round(b.top + window.scrollY) + top,
      width: trimRight ? Math.round(c.right - b.left + pad) : Math.round(b.width),
      height: Math.floor(b.height) - top - bottom,
    };
  }, layout);
}

// Every text node and image the browser paints inside `clip`. A box counts only
// where it survives each ancestor that clips: the phone layout keeps its closed
// menu's links in a 0px-tall drawer laid over the band, unpainted.
async function paintedInside(page, clip) {
  return page.evaluate((c) => {
    const cut = (a, r) => ({ left: Math.max(a.left, r.left), top: Math.max(a.top, r.top), right: Math.min(a.right, r.right), bottom: Math.min(a.bottom, r.bottom) });
    const painted = (el, rect) => {
      let r = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.display === 'none' || Number(cs.opacity) === 0) return null;
        if (a !== el && cs.overflowX !== 'visible' && cs.overflowY !== 'visible') r = cut(r, a.getBoundingClientRect());
      }
      if (getComputedStyle(el).visibility === 'hidden') return null;
      return r.right > r.left && r.bottom > r.top ? r : null;
    };
    const hit = (r) => r && r.right > c.x && r.left < c.x + c.width
      && r.bottom + window.scrollY > c.y && r.top + window.scrollY < c.y + c.height;
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      if (Array.from(range.getClientRects()).some((r) => r.width && r.height && hit(painted(n.parentElement, r)))) texts.push(t);
    }
    const images = Array.from(document.images)
      .filter((i) => hit(painted(i, i.getBoundingClientRect())))
      .map((i) => i.currentSrc || i.src);
    return { texts, images };
  }, clip);
}

async function edgeRows(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const rowMean = (y) => {
    let sum = 0;
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    return sum / info.width;
  };
  return { first: rowMean(0), second: rowMean(1), last: rowMean(info.height - 1), width: info.width, height: info.height };
}

async function capture(browser, layout) {
  const context = await browser.newContext({
    viewport: layout.viewport,
    deviceScaleFactor: 2,
    isMobile: layout.mobile,
    hasTouch: layout.mobile,
    userAgent: layout.userAgent,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const res = await page.goto(LISTING_PAGE, { waitUntil: 'networkidle', timeout: 60000 });
    if (!res || res.status() !== 200) throw new Error(`${layout.name}: the listing answered ${res && res.status()}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => {
      const band = document.querySelector('p.subtitle') && document.querySelector('p.subtitle').closest('section.shelf');
      return band && Array.from(band.querySelectorAll('img')).every((i) => i.complete && i.naturalWidth > 0);
    }, null, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const clip = await measure(page, layout);
    const inside = await paintedInside(page, clip);
    if (JSON.stringify(inside.texts) !== JSON.stringify(EXPECTED)) {
      throw new Error(`${layout.name}: the crop would show ${JSON.stringify(inside.texts)}, not ${JSON.stringify(EXPECTED)}. Nothing written.`);
    }
    const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    const edges = await edgeRows(png);
    if (edges.height !== clip.height * 2 || edges.width !== clip.width * 2) throw new Error(`${layout.name}: got ${edges.width}x${edges.height} for a ${clip.width}x${clip.height} crop`);
    if (edges.last > PAGE_GREY - 20) throw new Error(`${layout.name}: the bottom row is the page under the band (mean ${edges.last.toFixed(0)}). Nothing written.`);
    if (edges.second - edges.first > 4) throw new Error(`${layout.name}: the top row is shadowed (${edges.first.toFixed(0)} under ${edges.second.toFixed(0)}). Nothing written.`);
    return { clip, inside, png };
  } finally {
    await context.close();
  }
}

async function write(name, clip, png) {
  const stem = path.join(OUT, `app-store-listing-${name}`);
  const one = await sharp(png).resize(clip.width, clip.height, { kernel: 'lanczos3' }).toBuffer();
  const files = [
    [`${stem}-${clip.width}.webp`, await sharp(one).webp({ quality: 88, smartSubsample: true, effort: 6 }).toBuffer()],
    [`${stem}-${clip.width * 2}.webp`, await sharp(png).webp({ quality: 88, smartSubsample: true, effort: 6 }).toBuffer()],
    [`${stem}-${clip.width * 2}.png`, await sharp(png).png({ palette: true, quality: 90, colours: 256, dither: 1, effort: 10, compressionLevel: 9 }).toBuffer()],
  ];
  for (const [file, buf] of files) {
    fs.writeFileSync(file, buf);
    console.log(`  ${path.relative(process.cwd(), file)}  ${(buf.length / 1024).toFixed(1)} KB`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const shots = [];
  try {
    // Both layouts must pass before either is written.
    for (const layout of LAYOUTS) shots.push([layout.name, await capture(browser, layout)]);
  } finally {
    await browser.close();
  }
  for (const [name, { clip, inside }] of shots) {
    console.log(`${name}: ${clip.width}x${clip.height} CSS px at (${clip.x}, ${clip.y}), text ${JSON.stringify(inside.texts)}, ${inside.images.length} images (Flock's icon and Apple's blur of it)`);
  }
  for (const [name, { clip, png }] of shots) await write(name, clip, png);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
