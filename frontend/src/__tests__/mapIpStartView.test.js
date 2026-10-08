/**
 * A MAP WITH NO LOCATION CAN OPEN ON THE CITY THE CONNECTION IS IN.
 *
 * With location denied, or the Settings switch off, Discover opens on a fixed
 * fallback city (NO_LOCATION_VIEW). On the SDK path the view can instead open
 * on the city MapTiler's IP geolocation names, one zoom closer, with no blue
 * dot and no accuracy ring, when its caller asks for it (ipStartView). The
 * caller is told where it opened (onIpStartView), because the venues it loads
 * have to be around the same point or the map and the list name two cities.
 *
 * Pinned here: denied plus a key asks once and centres there; a failure or a
 * slow answer leaves the fallback; a known location never asks; a caller that
 * did not opt in never asks; nothing is written to storage. The engine half
 * (asked once per launch, kept in memory only) is in mapEngineSdkConfig.test.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test mapIpStartView --watchAll=false
 */
const React = require('react');
const { render, waitFor, act } = require('@testing-library/react');

process.env.REACT_APP_MAPTILER_KEY = 'test-maptiler-key';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));
// No device fix in these tests: the location prompt answers "denied".
jest.mock('../services/geolocation', () => ({
  geolocationAvailable: () => true,
  getCurrentPosition: (ok, fail) => { fail(new Error('denied')); },
  watchPosition: () => 1,
  clearWatch: () => {},
}));

const mockMaps = [];
const mockIp = { locate: null };
jest.mock('../components/map/mapEngine', () => {
  class FakeSource { setData(d) { this.data = d; } }
  class FakeMap {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.sources = {};
      this.layers = {};
      mockMaps.push(this);
    }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    once(evt, fn) { return this.on(evt, fn); }
    fire(evt, e) { (this.handlers[evt] || []).forEach((fn) => fn(e)); }
    getStyle() { return { layers: [] }; }
    addSource(id) { this.sources[id] = new FakeSource(); }
    getSource(id) { return this.sources[id]; }
    addLayer(layer) { this.layers[layer.id] = layer; }
    getLayer(id) { return this.layers[id]; }
    addControl() {}
    getZoom() { return 12; }
    project([lng, lat]) { return { x: lng * 1000, y: lat * 1000 }; }
    fitBounds() {}
    resize() {}
    remove() {}
  }
  class FakeMarker {
    setLngLat() { return this; }
    addTo() { return this; }
    remove() {}
    setOpacity() { return this; }
  }
  class FakeBounds { extend() { return this; } }
  const lib = { Map: FakeMap, Marker: FakeMarker, AttributionControl: class {}, LngLatBounds: FakeBounds };
  return {
    __esModule: true,
    loadMapEngine: async () => ({
      kind: 'sdk', lib, Map: FakeMap, options: {},
      locateByIp: (...args) => mockIp.locate(...args),
    }),
  };
});

const MapLibreMapView = require('../components/map/MapLibreMapView').default;

const NO_LOCATION_VIEW = { lat: 39.9526, lng: -75.1652, zoom: 11.5, label: 'Philadelphia' };
const ALLENTOWN = { lat: 40.6084, lng: -75.4902 };
const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };

const view = (props) => (
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
    NO_LOCATION_VIEW={NO_LOCATION_VIEW}
    locationAllowed={false}
    ipStartView
    {...props}
  />
);

async function builtMap(props, timeout = 1000) {
  const utils = render(view(props));
  await waitFor(() => expect(mockMaps).toHaveLength(1), { timeout });
  return { map: mockMaps[0], ...utils };
}

beforeEach(() => {
  mockMaps.length = 0;
  mockIp.locate = jest.fn(async () => ALLENTOWN);
});

test('location off with a key asks once and opens one zoom closer on that city', async () => {
  const onIpStartView = jest.fn();
  const { map, unmount } = await builtMap({ onIpStartView });
  expect(mockIp.locate).toHaveBeenCalledTimes(1);
  expect(map.opts.center).toEqual([ALLENTOWN.lng, ALLENTOWN.lat]);
  expect(map.opts.zoom).toBe(NO_LOCATION_VIEW.zoom + 1);
  expect(onIpStartView).toHaveBeenCalledWith(ALLENTOWN);
  // A place to look, not a claim about the person: no accuracy ring.
  act(() => { map.fire('load'); });
  const ring = map.getSource('user-accuracy');
  expect(ring && ring.data && ring.data.features.length).toBeFalsy();
  unmount();
});

test('a denied prompt (switch on, no fix) asks too', async () => {
  const { map, unmount } = await builtMap({ locationAllowed: true });
  expect(mockIp.locate).toHaveBeenCalledTimes(1);
  expect(map.opts.center).toEqual([ALLENTOWN.lng, ALLENTOWN.lat]);
  unmount();
});

test('a failed answer opens the fallback city as before', async () => {
  mockIp.locate = jest.fn(async () => null);
  const onIpStartView = jest.fn();
  const { map, unmount } = await builtMap({ onIpStartView });
  expect(mockIp.locate).toHaveBeenCalledTimes(1);
  expect(map.opts.center).toEqual([NO_LOCATION_VIEW.lng, NO_LOCATION_VIEW.lat]);
  expect(map.opts.zoom).toBe(NO_LOCATION_VIEW.zoom);
  expect(onIpStartView).not.toHaveBeenCalled();
  unmount();
});

test('an answer that never comes does not hold the map: it opens on the fallback', async () => {
  mockIp.locate = jest.fn(() => new Promise(() => {}));
  // The view waits a moment and a half for the answer, then gives up on it.
  const { map, unmount } = await builtMap({}, 4000);
  expect(map.opts.center).toEqual([NO_LOCATION_VIEW.lng, NO_LOCATION_VIEW.lat]);
  unmount();
});

test('a known location never asks', async () => {
  const { map, unmount } = await builtMap({
    locationAllowed: true,
    userLocation: { lat: 40.1, lng: -75.3, accuracy: 20 },
  });
  expect(mockIp.locate).not.toHaveBeenCalled();
  expect(map.opts.center).toEqual([-75.3, 40.1]);
  unmount();
});

test('a map that is told where to open never asks', async () => {
  const { unmount } = await builtMap({ initialCenter: { lat: 40.2, lng: -75.2 } });
  expect(mockIp.locate).not.toHaveBeenCalled();
  unmount();
});

test('a caller that did not opt in never asks', async () => {
  const { map, unmount } = await builtMap({ ipStartView: false });
  expect(mockIp.locate).not.toHaveBeenCalled();
  expect(map.opts.center).toEqual([NO_LOCATION_VIEW.lng, NO_LOCATION_VIEW.lat]);
  unmount();
});

test('the city is never written to storage', async () => {
  const writes = jest.spyOn(Storage.prototype, 'setItem');
  const { map, unmount } = await builtMap();
  act(() => { map.fire('load'); });
  const leaked = writes.mock.calls.filter(([, v]) => /40\.60|75\.49/.test(String(v)));
  expect(leaked).toEqual([]);
  writes.mockRestore();
  unmount();
});
