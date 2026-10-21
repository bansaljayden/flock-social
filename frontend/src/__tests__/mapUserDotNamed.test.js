// THE BLUE DOT IS "YOUR LOCATION", NOT A BUTTON.
//
// MapLibre's Marker.addTo names an element that arrives unnamed "Map marker"
// and gives it role=button. The venue pins name themselves in buildMarkerEl;
// the dot for where you are did not, so VoiceOver announced "Map marker,
// button" for a dot that does nothing when pressed (the 2026-10-20 button
// sweep: "Discover :: Map marker -> no visible effect").

import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'components', 'map', 'MapLibreMapView.js'), 'utf8');

test('the dot is named and is a picture, before MapLibre sees it', () => {
  const inner = SRC.indexOf("inner.className = 'mlb-user-dot-inner';");
  const add = SRC.indexOf('userMarkerRef.current = new ml.Marker(', inner);
  expect(inner).toBeGreaterThan(-1);
  expect(add).toBeGreaterThan(inner);
  const block = SRC.slice(SRC.lastIndexOf("const el = document.createElement('div');", inner), add);
  expect(block).toContain("el.setAttribute('role', 'img');");
  expect(block).toContain("el.setAttribute('aria-label', 'Your location');");
});

test('MapLibre keeps a label and a role it is handed', () => {
  const file = path.join(__dirname, '..', '..', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl-dev.js');
  const ml = fs.readFileSync(file, 'utf8');
  expect(ml).toContain("if (!this._element.hasAttribute('aria-label')) {");
  expect(ml).toContain("if (!this._element.hasAttribute('role')) {");
});
