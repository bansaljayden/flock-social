/**
 * THE MAP'S CONTROLS CANNOT SIT ABOVE THE MAP.
 *
 * Discover's map is the flex remainder under a search bar, whatever banners
 * happen to be up, and the filter row, and it has no floor. Measured at 390x664
 * with location denied and the analytics bar unanswered, the surface came back
 * 131 pixels tall and stayed there. The controls on it are positioned from its
 * bottom edge and the box clips what overflows, so the zoom pair and the
 * satellite toggle were drawn above their own container's top and disappeared
 * while staying in the tab order: three stops a keyboard reaches and an eye
 * cannot find.
 *
 * The fix withholds a control when its own height does not fit. What this file
 * protects is the ARITHMETIC behind that, because it is the half that rots:
 * each threshold is derived from a `bottom` offset and a height written
 * somewhere else in the same file, and moving a control without moving its
 * threshold puts the bug back with the guard still in place and still passing
 * a test that only looked for the guard.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'map', 'MapLibreMapView.js'), 'utf8'
).replace(/\r\n/g, '\n');

/** `const NAME = 80 + 44 + 8;` -> 132 */
const constant = (name) => {
  const m = SRC.match(new RegExp(`const ${name} = ([^;]+);`));
  expect(m).toBeTruthy();
  // Only sums of plain numbers, so this evaluates nothing it did not read.
  const terms = m[1].split('+').map((t) => t.trim());
  expect(terms.every((t) => /^\d+$/.test(t))).toBe(true);
  return { total: terms.reduce((a, t) => a + Number(t), 0), terms: terms.map(Number) };
};

/** The `bottom: 'NNNpx'` on the block that follows a marker. */
const bottomAfter = (marker) => {
  const at = SRC.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const m = SRC.slice(at).match(/bottom: '(\d+)px'/);
  expect(m).toBeTruthy();
  return Number(m[1]);
};

describe('every control is withheld when it would be clipped', () => {
  test('the surface height is measured, not assumed', () => {
    // A guard reading a number nobody updates is a guard that never fires.
    expect(SRC).toMatch(/const \[surfaceHeight, setSurfaceHeight\] = useState\(null\)/);
    expect(SRC).toMatch(/new ResizeObserver\(\(entries\) => \{/);
    expect(SRC).toMatch(/if \(box\) setSurfaceHeight\(box\.height\)/);
  });

  test('an unmeasured surface still draws everything', () => {
    /* The first paint happens before the observer fires, and on a platform
       with no ResizeObserver it never fires at all. Either way the controls
       have to be there: failing toward "show it" costs a clipped control for
       one frame, failing the other way loses them for good. */
    expect(SRC).toMatch(/const roomFor = \(px\) => surfaceHeight === null \|\| surfaceHeight >= px;/);
  });

  test.each([
    ['FITS_MY_LOCATION', '{/* My Location button', 44],
    ['FITS_SATELLITE', '{/* Map / Satellite toggle', 44],
    // Two 40px buttons with a 1px rule between them.
    ['FITS_ZOOM', '{/* Zoom controls */}', 81],
  ])('%s is the control\'s own offset plus its own height', (name, marker, height) => {
    const { total, terms } = constant(name);
    const bottom = bottomAfter(marker);
    expect(terms[0]).toBe(bottom);
    expect(terms[1]).toBe(height);
    // Whatever margin is chosen, the control must clear the top edge.
    expect(total).toBeGreaterThan(bottom + height);
  });

  test('each control is actually gated on its own threshold', () => {
    expect(SRC).toMatch(/\{followUser && roomFor\(FITS_MY_LOCATION\) && \(/);
    expect(SRC).toMatch(/\{SATELLITE_AVAILABLE && roomFor\(FITS_SATELLITE\) && \(/);
    expect(SRC).toMatch(/\{roomFor\(FITS_ZOOM\) && \(/);
  });

  test('the surface the agent measured would hide the two that did not fit', () => {
    // 131px, from the run that found this. My Location needs 132 and does not
    // fit either, which is the honest answer at that height: none of them do.
    const measured = 131;
    for (const name of ['FITS_MY_LOCATION', 'FITS_SATELLITE', 'FITS_ZOOM']) {
      expect(constant(name).total).toBeGreaterThan(measured);
    }
  });

  test('a normal Discover surface still shows all three', () => {
    // 390x844 less a search bar, the filter row and the tab bar leaves ~480.
    const ordinary = 480;
    for (const name of ['FITS_MY_LOCATION', 'FITS_SATELLITE', 'FITS_ZOOM']) {
      expect(constant(name).total).toBeLessThan(ordinary);
    }
  });
});
