/**
 * A PLAN CHAT'S "SHOW ON MAP" PANS ON THE FIRST VISIT TO DISCOVER TOO.
 *
 * window.__flockPanToVenue is set by an effect in MapLibreMapView that closed
 * over `const map = mapInstanceRef.current`. The map is built in a separate,
 * async effect (behind the engine import), so on the first mount the API
 * effect runs first and captures null, and nothing re-runs it once the map
 * exists unless one of its dependencies changes identity. Until then every
 * pan returned at its `if (!map)`. __flockGoToMyLocation had the same defect
 * and reads the ref at call time since 9d483299; so does this now.
 *
 * Mounted for real against the fake engine mapTeardown.test.js uses.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test mapPanToVenueFirstVisit --watchAll=false
 */
const React = require('react');
const { render, waitFor, act } = require('@testing-library/react');

process.env.REACT_APP_MAPTILER_KEY = 'test-maptiler-key';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));

const mockMaps = [];
jest.mock('../components/map/mapEngine', () => {
  class FakeSource { setData(d) { this.data = d; } }
  class FakeMap {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.onceHandlers = {};
      this.sources = {};
      this.layers = {};
      this.flights = [];
      mockMaps.push(this);
    }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    once(evt, fn) { (this.onceHandlers[evt] = this.onceHandlers[evt] || []).push(fn); return this; }
    off() { return this; }
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
    jumpTo(o) { this.flights.push(o); }
    flyTo(o) { this.flights.push(o); }
    remove() {}
  }
  class FakeMarker {
    constructor(opts) { this.el = opts.element; }
    setLngLat(ll) { this.ll = ll; return this; }
    addTo() { return this; }
    remove() {}
    setOpacity() { return this; }
  }
  class FakeBounds { extend() { return this; } }
  const lib = { Map: FakeMap, Marker: FakeMarker, AttributionControl: class {}, LngLatBounds: FakeBounds };
  const engine = { kind: 'sdk', lib, Map: FakeMap, options: {}, locateByIp: null };
  return { __esModule: true, loadMapEngine: () => Promise.resolve(engine) };
});

const MapLibreMapView = require('../components/map/MapLibreMapView').default;

const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };
// Stable across renders, as Discover's are once its list has settled: the
// API effect is not re-run by anything after the first mount.
const VENUES = [
  { id: 1, place_id: 'A', name: 'Oakwood', types: ['bar'], category: 'Nightlife', crowd: 80, location: { latitude: 40.0, longitude: -75.0 } },
];
const setActiveVenue = jest.fn();
const openVenueDetail = jest.fn();

const view = () => (
  <MapLibreMapView
    venues={VENUES}
    filterCategory="All"
    userLocation={null}
    activeVenue={null}
    setActiveVenue={setActiveVenue}
    openVenueDetail={openVenueDetail}
    calcDistance={() => ''}
    colorsDark={palette}
    colorsLight={palette}
    resolveVenuePhoto={(u) => u}
    NO_LOCATION_VIEW={{ lat: 40, lng: -75, zoom: 11.5 }}
    initialCenter={{ lat: 40, lng: -75 }}
    followUser={false}
    locationAllowed={false}
  />
);

test('the plan chat\'s pan reaches a map built after the API was set', async () => {
  render(view());
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  const map = mockMaps[0];
  act(() => { map.fire('load'); });
  map.flights.length = 0;
  setActiveVenue.mockClear();

  // ChatDetail's "show on map": coordinates and a name, no pin on the map.
  act(() => { window.__flockPanToVenue({ lat: 40.5, lng: -75.5, name: 'The Vault', address: '1 Main St' }); });

  expect(map.flights).toContainEqual(expect.objectContaining({ center: [-75.5, 40.5], zoom: 17 }));
  expect(setActiveVenue).toHaveBeenCalledWith(expect.objectContaining({ name: 'The Vault' }));
});
