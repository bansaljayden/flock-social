/**
 * A DEVELOPMENT BUILD WITH NO MAPTILER KEY STILL DRAWS THE MAP, ON CARTO.
 *
 * The other half of keylessBasemapRelease.test.js. Keyless CARTO tiles are
 * kept out of releases, and contributors, the test runner and the e2e stack
 * keep the map they had: the view is built on plain maplibre-gl against
 * CARTO's Positron style, or Dark Matter in dark mode.
 *
 * Mounted for real against a fake engine standing in for mapEngine.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test keylessBasemapDev --watchAll=false
 */
const React = require('react');
const { render, waitFor } = require('@testing-library/react');

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));

const mockMaps = [];
const mockEngineCalls = [];
jest.mock('../components/map/mapEngine', () => {
  class FakeMap {
    constructor(opts) { this.opts = opts; this.handlers = {}; mockMaps.push(this); }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    once() { return this; }
    setStyle() {}
    getStyle() { return { layers: [] }; }
    addSource() {}
    getSource() { return null; }
    addLayer() {}
    getLayer() { return null; }
    addControl() {}
    getZoom() { return 12; }
    getCenter() { return { lng: 0, lat: 0 }; }
    project([lng, lat]) { return { x: lng, y: lat }; }
    fitBounds() {}
    resize() {}
    jumpTo() {}
    flyTo() {}
    remove() {}
  }
  const lib = { Map: FakeMap, Marker: class { setLngLat() { return this; } addTo() { return this; } remove() {} setOpacity() { return this; } }, AttributionControl: class {}, LngLatBounds: class { extend() { return this; } } };
  const engine = { kind: 'maplibre', lib, Map: FakeMap, options: {}, locateByIp: null };
  return {
    __esModule: true,
    loadMapEngine: (args) => { mockEngineCalls.push(args); return Promise.resolve(engine); },
  };
});

delete process.env.REACT_APP_MAPTILER_KEY;
delete process.env.REACT_APP_KEYLESS_BASEMAP;
const MapLibreMapView = require('../components/map/MapLibreMapView').default;
const { CARTO_POSITRON, KEYLESS_BASEMAP_ALLOWED } = require('../components/map/keylessBasemap');

const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };

test('with no key, the test runner is a build that may draw CARTO keyless', () => {
  expect(process.env.NODE_ENV).not.toBe('production');
  expect(KEYLESS_BASEMAP_ALLOWED).toBe(true);
});

test('the map is built on CARTO Positron, on the keyless engine', async () => {
  render(
    <MapLibreMapView
      venues={[]}
      filterCategory="All"
      userLocation={null}
      activeVenue={null}
      setActiveVenue={() => {}}
      openVenueDetail={() => {}}
      calcDistance={() => ''}
      colorsDark={palette}
      colorsLight={palette}
      resolveVenuePhoto={(u) => u}
      NO_LOCATION_VIEW={{ lat: 40, lng: -75, zoom: 11.5 }}
      initialCenter={{ lat: 40, lng: -75 }}
      followUser={false}
      locationAllowed={false}
    />,
  );
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  expect(mockEngineCalls).toEqual([{ key: undefined }]);
  expect(mockMaps[0].opts.style).toBe(CARTO_POSITRON);
});
