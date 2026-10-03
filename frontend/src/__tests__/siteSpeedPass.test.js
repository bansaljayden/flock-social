/**
 * The marketing site's speed pass (2026-10-02), pinned.
 *
 * 1. The hero screenshot is the largest contentful paint on / (measured on
 *    Lighthouse's mobile run and a 1366px desktop), so / preloads it, from a
 *    per-route Link header in vercel.json and never from the shared
 *    index.html, which is also the response for /app, /admin and the shell.
 * 2. The section marks offer width candidates, and every candidate exists at
 *    the width its descriptor claims. A descriptor that lies makes the browser
 *    pick the wrong file, and nothing on screen would show it.
 * 3. The demo's map is built after scrolling pauses, not mid-scroll.
 *
 * This is a FRONTEND test (jest via react-scripts).
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');

// Canvas size and alpha from the WebP container header, no native dependency.
function webpInfo(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('not a RIFF/WEBP file');
  }
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    return {
      fourcc,
      width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
      height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
      alpha: (buf[20] & 0x10) !== 0,
    };
  }
  if (fourcc === 'VP8 ') {
    return {
      fourcc,
      width: ((buf[27] << 8) | buf[26]) & 0x3fff,
      height: ((buf[29] << 8) | buf[28]) & 0x3fff,
      alpha: false,
    };
  }
  throw new Error('unexpected WebP container: ' + fourcc);
}

describe('the hero screenshot preload lives on / only', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const home = vercel.headers.find((h) => h.source === '/' && !h.has);
  const link = home && home.headers.find((h) => h.key === 'Link');

  test('the / Link header keeps the canonical and adds a WebP-gated, high-priority preload', () => {
    expect(link).toBeTruthy();
    expect(link.value).toContain('<https://www.flockcorp.com/>; rel="canonical"');
    expect(link.value).toContain('</screenshots/nest-dark@2x.webp>; rel=preload; as=image; type="image/webp"; fetchpriority=high');
  });

  test('the preloaded file is the one the hero <picture> actually requests', () => {
    expect(read('src/website/LandingPage.js')).toContain('<source type="image/webp" srcSet="/screenshots/nest-dark@2x.webp" />');
    expect(fs.existsSync(path.join(FRONTEND, 'public', 'screenshots', 'nest-dark@2x.webp'))).toBe(true);
  });

  test('no other route carries it, and the shared index.html has no preload link of its own', () => {
    const others = vercel.headers.filter((h) => h !== home)
      .flatMap((h) => h.headers.filter((x) => x.key === 'Link').map((x) => x.value));
    for (const v of others) expect(v).not.toContain('nest-dark');
    // Comments may describe the link; no live <link rel="preload"> element may
    // sit in the shared head, where every route would fetch it.
    const html = read('public/index.html').replace(/<!--[\s\S]*?-->/g, '');
    expect(html).not.toMatch(/<link[^>]+rel="preload"/);
  });
});

describe('every section-mark candidate is the width it claims', () => {
  const lp = read('src/website/LandingPage.js');
  const sets = [...lp.matchAll(/srcSet="([^"]*\/marks\/mark-[^"]*)"/g)].map((m) => m[1]);

  test('the three marks each offer more than one width', () => {
    const withWidths = sets.filter((s) => / \d+w/.test(s));
    expect(withWidths.length).toBe(3);
  });

  test('each candidate file exists, has the declared pixel width, and the cutouts keep alpha', () => {
    for (const set of sets) {
      for (const entry of set.split(',').map((x) => x.trim())) {
        const [url, desc] = entry.split(/\s+/);
        const file = path.join(FRONTEND, 'public', url);
        expect(fs.existsSync(file)).toBe(true);
        const info = webpInfo(fs.readFileSync(file));
        expect(`${url} ${info.width}w`).toBe(`${url} ${desc}`);
        // crowd and steps are transparent cutouts on cream and navy; money is
        // opaque on purpose (see LandingPage.js).
        if (/mark-(crowd|steps)/.test(url)) expect(`${url} alpha=${info.alpha}`).toBe(`${url} alpha=true`);
      }
    }
  });

  test('each width set carries a sizes attribute, so the w descriptors are usable', () => {
    const blocks = [...lp.matchAll(/srcSet="[^"]*\/marks\/mark-[^"]* \d+w[^"]*"\s*sizes="([^"]+)"/g)];
    expect(blocks.length).toBe(3);
  });
});

describe('the demo map waits for the scroll to pause', () => {
  const demo = read('src/website/LiveDemo.js');

  test('initMap awaits whenScrollSettles before constructing the map', () => {
    const init = demo.slice(demo.indexOf('const initMap = useCallback'), demo.indexOf('new ml.Map('));
    expect(init).toContain('await whenScrollSettles();');
  });

  test('the wait is capped, so a visitor who never stops scrolling still gets a map', () => {
    expect(demo).toMatch(/function whenScrollSettles\(quietMs = \d+, maxMs = \d+\)/);
    expect(demo).toMatch(/const cap = setTimeout\(finish, maxMs\);/);
  });
});
