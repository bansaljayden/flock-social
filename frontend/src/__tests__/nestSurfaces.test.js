/**
 * THE NEST'S SURFACES: FLAT, ONE FAMILY OF RADII, TOKENS WITH A ROLE
 * (2026-11-06).
 *
 * Five rounded white boxes stacked before the list, each with a border AND a
 * shadow AND a fill, is the stock component-kit look, and ten different radii
 * on one screen read as nobody deciding. The rules the Nest keeps now:
 *
 *   - A card, row or group is --bg-card-solid on the cream ground: no border,
 *     no shadow. Depth is for what floats over the page.
 *   - Radii (the index.css scale since 2026-11-07): --r-lg (16) for the
 *     hero only; --r-md (12) for groups, cards, buttons and the segmented
 *     track; --r-sm (10) for a segment; --r-pill for chips, faces and pills.
 *   - The one filled button reads --btn-primary-bg / --btn-primary-fg, where
 *     four isDark ternaries picked the same pair; the dead neo-btn-primary
 *     class and its bevel go.
 *   - The side margin is --nest-gutter, 16 at 320 and 20 from 385 up.
 *   - A face has a ring only where faces overlap, and never a dot.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestSurfaces --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const APP = read('App.js');
const HOME = strip(APP.slice(APP.indexOf('const HomeScreen = () => {'), APP.indexOf('// The past flocks screen was declared here')));
const NEST_DIR = path.join(__dirname, '..', 'components', 'nest');
const PIECES = fs.readdirSync(NEST_DIR).filter((f) => f.endsWith('.js')).map((f) => ({ f, src: strip(read('components', 'nest', f)) }));
const ALL = [{ f: 'HomeScreen', src: HOME }, ...PIECES];

test('every radius the Nest draws is one of the family', () => {
  const allowed = new Set(['var(--r-lg)', 'var(--r-md)', 'var(--r-sm)', 'var(--r-pill)']);
  for (const { f, src } of ALL) {
    const radii = [...src.matchAll(/borderRadius: '([^']+)'/g)].map((m) => m[1]);
    for (const r of radii) expect({ f, r, ok: allowed.has(r) }).toEqual({ f, r, ok: true });
  }
  // 16 is the hero's alone.
  const sixteen = ALL.filter(({ src }) => /borderRadius: 'var\(--r-lg\)'/.test(src)).map(({ f }) => f);
  expect(sixteen.sort()).toEqual(['HomeScreen', 'NestHero.js'].sort());
  // The one 16 in HomeScreen is the failed read's note, which stands in the hero slot.
  expect(HOME.match(/borderRadius: 'var\(--r-lg\)'/g)).toHaveLength(1);
});

test('no card, row or group carries a border or a drop shadow', () => {
  for (const { f, src } of ALL) {
    expect({ f, border: /border: '1(\.5)?px solid/.test(src) }).toEqual({ f, border: false });
    // The only box-shadow is a face's 2px ring in its surface colour.
    const shadows = [...src.matchAll(/boxShadow: ([^,}]+(?:,[^,}]+)?)/g)].map((m) => m[1]);
    for (const sh of shadows) expect({ f, sh, ring: /0 0 0 2px/.test(sh) || /'none'/.test(sh) }).toEqual({ f, sh, ring: true });
  }
});

test('the filled button reads the --btn-primary pair, and no isDark ternary picks a colour', () => {
  expect(HOME).toMatch(/background: 'var\(--btn-primary-bg\)', color: 'var\(--btn-primary-fg\)'/);
  expect(HOME).not.toMatch(/isDark \?/);
  expect(HOME).not.toMatch(/neo-btn-primary/);
  expect(APP).not.toMatch(/inset 0 1px 0 rgba\(255,255,255,0\.55\), 0 1px 2px rgba\(0,0,0,0\.20\)/);
});

test('the side margin is the gutter token', () => {
  expect(HOME).toMatch(/padding: [`']0 var\(--nest-gutter\) /);
  const css = read('index.css');
  expect(css).toContain('--nest-gutter: clamp(16px, 5.2vw, 20px);');
});

// The two edges the page scrolls under (the top of the scroll box, and the
// strip above the tabs) were drawn in --divider, #eeeeee, which is LIGHTER than
// the #f1ede0 cream it sits on: 1.01:1, so in light mode the strip cut text
// through its letters with no line at all. They read --nest-edge now, which
// has to show on the ground in both themes.
describe('the scroll edges show on the ground', () => {
  const css = read('index.css');
  const block = (selector) => {
    const out = {};
    let from = 0;
    for (;;) {
      const open = css.indexOf(`\n${selector} {`, from);
      if (open === -1) break;
      const close = css.indexOf('}', open);
      for (const m of css.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
      from = close;
    }
    return out;
  };
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  test('both edges are drawn in --nest-edge, not --divider', () => {
    const dock = strip(read('components', 'nest', 'NestDock.js'));
    expect(dock).toMatch(/height: '1px', backgroundColor: 'var\(--nest-edge\)'/);
    expect(HOME).toMatch(/<div ref=\{headerRef\}[^\n]*backgroundColor: 'var\(--nest-edge\)'/);
    expect(dock).not.toContain('var(--divider)');
  });

  test('--nest-edge clears 1.25:1 on the ground in light and in dark, where --divider measured 1.01:1 in light', () => {
    const light = block(':root');
    const dark = block('[data-theme="dark"]');
    expect(ratio(light['--divider'], light['--bg-primary'])).toBeLessThan(1.05);
    expect(ratio(light['--nest-edge'], light['--bg-primary'])).toBeGreaterThanOrEqual(1.25);
    expect(ratio(dark['--nest-edge'], dark['--bg-primary'])).toBeGreaterThanOrEqual(1.25);
  });
});

test('a face never carries an online dot, a last-seen time or a place', () => {
  const face = read('components', 'nest', 'Face.js');
  expect(strip(face)).not.toMatch(/#22C55E|online|lastSeen|last_seen|location/i);
});
