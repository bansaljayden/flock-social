/**
 * THE MAP IS REMOVED WHEN ITS VIEW UNMOUNTS.
 *
 * Discover never unmounts its map (it is parked behind visibility:hidden), but
 * the venue dashboard mounts components/map/MapLibreMapView.js every time its
 * Map tab opens. The init effect's cleanup used to stop only a ResizeObserver,
 * so each visit left a live map behind: a WebGL context (browsers keep about
 * sixteen and then drop the oldest, which is how the tab ended up blank), a
 * worker, a tile cache, timers and every marker. The cleanup now removes the
 * markers and the map, once.
 *
 * And a view that unmounts while its engine chunk is still downloading must
 * build nothing at all: in session billing a constructed map is a billed
 * session, and a map built into a detached node is one nobody saw.
 *
 * Mounted for real against a fake engine standing in for mapEngine.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test mapTeardown --watchAll=false
 */
const React = require('react');
const { render, waitFor, act } = require('@testing-library/react');

process.env.REACT_APP_MAPTILER_KEY = 'test-maptiler-key';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));

const mockMaps = [];
const mockMarkers = [];
const mockEngine = { gate: null };
jest.mock('../components/map/mapEngine', () => {
  class FakeSource { setData(d) { this.data = d; } }
  class FakeMap {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.onceHandlers = {};
      this.sources = {};
      this.layers = {};
      this.removeCalls = 0;
      mockMaps.push(this);
    }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    once(evt, fn) { (this.onceHandlers[evt] = this.onceHandlers[evt] || []).push(fn); return this; }
    fire(evt, e) {
      (this.handlers[evt] || []).forEach((fn) => fn(e));
      const once = this.onceHandlers[evt] || [];
      this.onceHandlers[evt] = [];
      once.forEach((fn) => fn(e));
    }
    setStyle() { this.sources = {}; this.layers = {}; }
    getStyle() { return { layers: [] }; }
    addSource(id) { this.sources[id] = new FakeSource(); }
    getSource(id) { return this.sources[id]; }
    addLayer(layer) { this.layers[layer.id] = layer; }
    getLayer(id) { return this.layers[id]; }
    addControl() {}
    getZoom() { return 12; }
    getCenter() { return { lng: 0, lat: 0 }; }
    project([lng, lat]) { return { x: lng * 1000, y: lat * 1000 }; }
    fitBounds() {}
    resize() {}
    jumpTo() {}
    flyTo() {}
    remove() { this.removeCalls += 1; }
  }
  class FakeMarker {
    constructor(opts) { this.el = opts.element; this.removed = 0; mockMarkers.push(this); }
    setLngLat(ll) { this.ll = ll; return this; }
    addTo() { return this; }
    remove() { this.removed += 1; }
    setOpacity() { return this; }
  }
  class FakeBounds { extend() { return this; } }
  const lib = { Map: FakeMap, Marker: FakeMarker, AttributionControl: class {}, LngLatBounds: FakeBounds };
  const engine = { kind: 'sdk', lib, Map: FakeMap, options: {}, locateByIp: null };
  return {
    __esModule: true,
    loadMapEngine: () => (mockEngine.gate ? mockEngine.gate.then(() => engine) : Promise.resolve(engine)),
  };
});

const MapLibreMapView = require('../components/map/MapLibreMapView').default;

const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };
const VENUES = [
  { id: 1, place_id: 'A', name: 'Oakwood', types: ['bar'], category: 'Nightlife', crowd: 80, location: { latitude: 40.0, longitude: -75.0 } },
  { id: 2, place_id: 'B', name: 'Blue Plate', types: ['restaurant'], category: 'Food', crowd: 30, location: { latitude: 40.2, longitude: -75.2 } },
];

const view = () => (
  <MapLibreMapView
    venues={VENUES}
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
    ownerPlaceId="A"
    followUser={false}
    locationAllowed={false}
  />
);

beforeEach(() => {
  mockMaps.length = 0;
  mockMarkers.length = 0;
  mockEngine.gate = null;
});

test('unmounting a loaded map removes its markers and the map, once', async () => {
  const { unmount } = render(view());
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  const map = mockMaps[0];
  act(() => { map.fire('load'); });
  expect(mockMarkers).toHaveLength(VENUES.length);
  expect(map.removeCalls).toBe(0);

  unmount();
  expect(map.removeCalls).toBe(1);
  mockMarkers.forEach((m) => expect(m.removed).toBeGreaterThanOrEqual(1));
});

test('unmounting before the map has loaded still removes it', async () => {
  const { unmount } = render(view());
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  unmount();
  expect(mockMaps[0].removeCalls).toBe(1);
});

test('an unmount before the engine arrives constructs nothing', async () => {
  let open;
  mockEngine.gate = new Promise((resolve) => { open = resolve; });
  const { unmount } = render(view());
  unmount();
  await act(async () => { open(); await mockEngine.gate; await Promise.resolve(); });
  // Give every remaining microtask in init a chance to run.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(mockMaps).toHaveLength(0);
});
