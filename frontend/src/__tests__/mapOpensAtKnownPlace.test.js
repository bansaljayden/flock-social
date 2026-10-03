/**
 * The Discover map opens at once where the app already knows the person is,
 * and eases to the fresh fix when it lands (app audit 2026-10-03). It used to
 * wait for a fresh high-accuracy fix before building at all (maximumAge 0, an
 * 8 s timeout, then the service's coarse retry): indoors, "Loading map" sat
 * there for about twenty seconds. FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const MAP = fs.readFileSync(path.join(__dirname, '..', 'components', 'map', 'MapLibreMapView.js'), 'utf8');
const slice = (a, b) => {
  const s = MAP.indexOf(a);
  expect(s).toBeGreaterThan(-1);
  return MAP.slice(s, MAP.indexOf(b, s));
};

test('a known location builds the map without waiting on a new fix', () => {
  const init = slice('const known = (!initialCenter && locationAllowed && userLocation', 'const userLoc =');
  expect(init).toMatch(/: \(known \|\| await getUserLocation\(\)\);/);
  expect(init).toMatch(/Number\.isFinite\(userLocation\.lat\) && Number\.isFinite\(userLocation\.lng\)/);
});

test('the fresh fix eases the map there, unless the person moved it or it is a street away', () => {
  const ease = slice('if (known) {', '// Which pins are visible where two share a spot');
  expect(ease).toContain("map.on('movestart', (e) => { if (e && e.originalEvent) personMoved = true; });");
  expect(ease).toMatch(/if \(cancelled \|\| !fix \|\| personMoved \|\| mapInstanceRef\.current !== map\) return;/);
  expect(ease).toMatch(/< 0\.0003\) return;/);
  expect(ease).toContain('mapEase(map, { center: [fix.lng, fix.lat] });');
});
