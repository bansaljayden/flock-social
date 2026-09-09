/**
 * The map pin's accessible name sits on the circle, and only on the circle.
 *
 * buildMarkerEl in App.js hand-builds each venue marker outside React: an
 * outer flex column holding the 44 px circle and, below it, a name-plus-rating
 * label that is laid out even while the zoom tier keeps it unseen. The first
 * accessibility fix named the OUTER element, so the accessible frame was the
 * whole column, about 250 px wide and 68 px tall, and anything that taps the
 * centre of an accessible frame (VoiceOver's double-tap, the recording rig)
 * landed beside the pin: build 48 tapped "The Mulberry, crowd 91" at the centre
 * of a [119,210][372,278] box and got the map, not the card. The circle is the
 * pin, so the circle carries the name and the label is hidden from the tree.
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

function region(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = APP.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return APP.slice(start, end);
}

describe('buildMarkerEl', () => {
  const fn = region('const buildMarkerEl = useCallback(', '// ---------- init map (once) ----------');

  test('the circle carries role=button and the name with the crowd number', () => {
    const inner = fn.slice(fn.indexOf("inner.className = 'mlb-marker-inner'"));
    expect(inner).toMatch(/inner\.setAttribute\('role', 'button'\)/);
    expect(inner).toMatch(/inner\.setAttribute\('aria-label', Number\.isFinite\(venue\.crowd\)\s*\?\s*`\$\{venue\.name\}, crowd \$\{Math\.round\(venue\.crowd\)\}`/);
  });

  test('the outer column carries neither, so the accessible frame is the pin', () => {
    const outer = fn.slice(0, fn.indexOf("inner.className = 'mlb-marker-inner'"));
    expect(outer).not.toMatch(/el\.setAttribute\('role'/);
    expect(outer).not.toMatch(/el\.setAttribute\('aria-label'/);
  });

  test('the label under the pin is hidden from the tree', () => {
    const label = fn.slice(fn.indexOf("label.className = 'mlb-marker-label'"));
    expect(label).toMatch(/label\.setAttribute\('aria-hidden', 'true'\)/);
  });

  test('the click handler still sits on the outer element a tap on the circle bubbles to', () => {
    const wiring = region("const el = buildMarkerEl(v, isActive);", 'markersRef.current.push(');
    expect(wiring).toMatch(/el\.addEventListener\('click'/);
  });
});
