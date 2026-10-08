/**
 * THE HEAT KEEPS THE CATEGORY FILTER ACROSS A BASEMAP SWAP.
 *
 * setStyle throws away every source the app added, so rehydrateAfterStyleSwap
 * in components/map/MapLibreMapView.js puts the crowd heat back. It rebuilt it
 * from every scored venue and skipped the category filter the other two heat
 * feeders apply, and nothing re-runs either of those after a swap. So with
 * Nightlife chosen, tapping satellite, or the phone turning to dark mode at
 * sunset, brought back red and amber heat over restaurants whose pins were
 * hidden, and it stayed that way until the filter or the venue list changed.
 *
 * Mounted for real against a fake MapLibre engine, because the swap is an
 * ordering of effects and map events that a source scan cannot see.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test mapHeatFilterAfterStyleSwap --watchAll=false
 */
const React = require('react');
const { render, screen, fireEvent, waitFor, act } = require('@testing-library/react');

// The satellite toggle only exists when there is a MapTiler key, and the
// module reads it once at load, so it is set before the component is required.
process.env.REACT_APP_MAPTILER_KEY = 'test-maptiler-key';

let mockDark = false;
jest.mock('../context/ThemeContext', () => ({
  useTheme: () => ({ isDark: mockDark }),
}));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));

// The engine, reduced to what the view calls. setStyle drops every source and
// layer the way MapLibre does; fire() runs `on` handlers and then drains the
// `once` ones, which is how the view hears that a new style has loaded.
//
// It stands in for components/map/mapEngine.js, the one module the view loads
// its engine through. With the key set above the real one would load
// @maptiler/sdk, which ships as ES modules only and which Jest under
// react-scripts does not transform.
const mockMaps = [];
jest.mock('../components/map/mapEngine', () => {
  class FakeSource {
    constructor() { this.data = null; }
    setData(d) { this.data = d; }
  }
  class FakeMap {
    constructor(opts) {
      this.style = opts.style;
      this.handlers = {};
      this.onceHandlers = {};
      this.sources = {};
      this.layers = {};
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
    setStyle(style) { this.style = style; this.sources = {}; this.layers = {}; }
    getStyle() { return { layers: [] }; }
    addSource(id) { this.sources[id] = new FakeSource(); }
    getSource(id) { return this.sources[id]; }
    addLayer(layer) { this.layers[layer.id] = layer; }
    getLayer(id) { return this.layers[id]; }
    addControl() {}
    getZoom() { return 12; }
    getCenter() { return { lng: 0, lat: 0 }; }
    project([lng, lat]) { return { x: lng * 100000, y: lat * 100000 }; }
    fitBounds() {}
    resize() {}
    jumpTo() {}
    flyTo() {}
    setLayoutProperty() {}
    setPaintProperty() {}
    setLayerZoomRange() {}
    remove() {}
  }
  class FakeMarker {
    constructor(opts) { this.el = opts.element; }
    setLngLat(ll) { this.ll = ll; return this; }
    addTo() { return this; }
    remove() {}
    setOpacity() { return this; }
    getElement() { return this.el; }
    getLngLat() { return { lng: this.ll[0], lat: this.ll[1] }; }
  }
  class FakeBounds {
    extend() { return this; }
  }
  const lib = { Map: FakeMap, Marker: FakeMarker, AttributionControl: class {}, LngLatBounds: FakeBounds };
  return {
    __esModule: true,
    loadMapEngine: async () => ({ kind: 'sdk', lib, Map: FakeMap, options: {}, locateByIp: null }),
  };
});

const MapLibreMapView = require('../components/map/MapLibreMapView').default;

const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };
const VENUES = [
  { id: 1, place_id: 'BAR_ONE', name: 'Oakwood', types: ['bar'], category: 'Nightlife', crowd: 80, location: { latitude: 40.0, longitude: -75.0 } },
  { id: 2, place_id: 'CAFE_ONE', name: 'Morning Cup', types: ['cafe'], category: 'Food', crowd: 90, location: { latitude: 40.1, longitude: -75.1 } },
  { id: 3, place_id: 'DINER_ONE', name: 'Blue Plate', types: ['restaurant'], category: 'Food', crowd: 70, location: { latitude: 40.2, longitude: -75.2 } },
];

function mapView(filterCategory) {
  return (
    <MapLibreMapView
      venues={VENUES}
      filterCategory={filterCategory}
      userLocation={null}
      activeVenue={null}
      setActiveVenue={() => {}}
      openVenueDetail={() => {}}
      calcDistance={() => ''}
      colorsDark={palette}
      colorsLight={palette}
      resolveVenuePhoto={(u) => u}
      NO_LOCATION_VIEW={{ lat: 40, lng: -75, zoom: 12 }}
      initialCenter={{ lat: 40, lng: -75 }}
      followUser={false}
      locationAllowed={false}
    />
  );
}

// Where the heat is drawn, as the venues it stands for.
const heatAt = (map) => {
  const src = map.getSource('venue-heat');
  const features = (src && src.data && src.data.features) || [];
  return features.map((f) => f.geometry.coordinates.join(','));
};
const BAR_ONLY = ['-75,40'];

async function loadedMap(filterCategory) {
  const utils = render(mapView(filterCategory));
  await waitFor(() => expect(mockMaps.length).toBe(1));
  const map = mockMaps[0];
  act(() => { map.fire('load'); });
  expect(heatAt(map)).toEqual(BAR_ONLY);
  return { map, ...utils };
}

beforeEach(() => {
  mockMaps.length = 0;
  mockDark = false;
  try { window.localStorage.clear(); } catch { /* no storage, nothing to clear */ }
});

test('tapping satellite with Nightlife chosen brings back heat for the bars only', async () => {
  const { map, unmount } = await loadedMap('Nightlife');
  fireEvent.click(screen.getByRole('button', { name: 'Switch to satellite view' }));
  expect(map.getSource('venue-heat')).toBeUndefined();
  act(() => { map.fire('styledata'); });
  expect(heatAt(map)).toEqual(BAR_ONLY);
  unmount();
});

test('the phone turning to dark mode with Nightlife chosen brings back heat for the bars only', async () => {
  const { map, rerender, unmount } = await loadedMap('Nightlife');
  mockDark = true;
  rerender(mapView('Nightlife'));
  act(() => { map.fire('styledata'); });
  expect(heatAt(map)).toEqual(BAR_ONLY);
  unmount();
});

test('with no filter a swap still brings back every scored venue', async () => {
  const utils = render(mapView('All'));
  await waitFor(() => expect(mockMaps.length).toBe(1));
  const map = mockMaps[0];
  act(() => { map.fire('load'); });
  fireEvent.click(screen.getByRole('button', { name: 'Switch to satellite view' }));
  act(() => { map.fire('styledata'); });
  expect(heatAt(map)).toHaveLength(3);
  utils.unmount();
});
