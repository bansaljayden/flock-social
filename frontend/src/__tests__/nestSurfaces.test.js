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
 *   - Radii: 16 for the hero only; 12 for groups, cards, buttons and the
 *     segmented track; 10 for a segment; 999 for chips, faces and pills.
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
  const allowed = new Set(['16px', '12px', '10px', '999px']);
  for (const { f, src } of ALL) {
    const radii = [...src.matchAll(/borderRadius: '([^']+)'/g)].map((m) => m[1]);
    for (const r of radii) expect({ f, r, ok: allowed.has(r) }).toEqual({ f, r, ok: true });
  }
  // 16 is the hero's alone.
  const sixteen = ALL.filter(({ src }) => /borderRadius: '16px'/.test(src)).map(({ f }) => f);
  expect(sixteen.sort()).toEqual(['HomeScreen', 'NestHero.js'].sort());
  // The one 16 in HomeScreen is the failed read's note, which stands in the hero slot.
  expect(HOME.match(/borderRadius: '16px'/g)).toHaveLength(1);
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
  expect(HOME).toMatch(/padding: `0 var\(--nest-gutter\) /);
  const css = read('index.css');
  expect(css).toContain('--nest-gutter: clamp(16px, 5.2vw, 20px);');
});

test('a face never carries an online dot, a last-seen time or a place', () => {
  const face = read('components', 'nest', 'Face.js');
  expect(strip(face)).not.toMatch(/#22C55E|online|lastSeen|last_seen|location/i);
});
