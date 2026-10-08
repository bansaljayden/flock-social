/**
 * BUILDINGS TINTED BY CROWD.
 *
 * From street zoom, the building a scored venue stands in wears its crowd band
 * (green, amber, red) through feature state on the Flock style's
 * `flock-3d-buildings` layer, which draws MapTiler's Buildings tileset
 * (`maptiler_buildings`, source layer `building`). The view decides which
 * building gets which band; the style paints it.
 *
 * What is pinned:
 *   - only a footprint that CONTAINS the venue gets the band, never a
 *     neighbour whose wall happens to be under the pixel in a tilted view;
 *   - a venue with no score, or one the viewer cannot see, tints nothing;
 *   - a style swap brings the tint back;
 *   - below zoom 15 nothing is asked, and on a style without the layer (the
 *     current basemaps, CARTO, satellite) nothing is asked either;
 *   - the band's cut points are App.js crowdBandFor's.
 *
 * Mounted for real against a fake engine standing in for mapEngine.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test mapCrowdBuildings --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor, act } = require('@testing-library/react');

process.env.REACT_APP_MAPTILER_KEY = 'test-maptiler-key';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));

const mockMaps = [];
const mockWorld = { flockStyle: true, zoom: 16, rendered: [] };
jest.mock('../components/map/mapEngine', () => {
  class FakeSource { setData(d) { this.data = d; } }
  const BUILDINGS_LAYER = { id: 'flock-3d-buildings', type: 'fill-extrusion', source: 'maptiler_buildings', 'source-layer': 'building' };
  class FakeMap {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.onceHandlers = {};
      this.queries = 0;
      this.writes = [];
      mockMaps.push(this);
      this.installStyle();
    }
    // What a style brings: on the Flock style, the buildings source and the
    // extrusion layer that reads feature state; on any other, neither.
    installStyle() {
      this.sources = {};
      this.layers = {};
      this.state = {};
      if (mockWorld.flockStyle) {
        this.sources.maptiler_buildings = new FakeSource();
        this.layers['flock-3d-buildings'] = BUILDINGS_LAYER;
      }
    }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    once(evt, fn) { (this.onceHandlers[evt] = this.onceHandlers[evt] || []).push(fn); return this; }
    fire(evt, e) {
      (this.handlers[evt] || []).forEach((fn) => fn(e));
      const once = this.onceHandlers[evt] || [];
      this.onceHandlers[evt] = [];
      once.forEach((fn) => fn(e));
    }
    setStyle() { this.installStyle(); }
    getStyle() { return { layers: Object.values(this.layers) }; }
    addSource(id) { this.sources[id] = new FakeSource(); }
    getSource(id) { return this.sources[id]; }
    addLayer(layer) { this.layers[layer.id] = layer; }
    getLayer(id) { return this.layers[id]; }
    addControl() {}
    getZoom() { return mockWorld.zoom; }
    getCenter() { return { lng: -75, lat: 40 }; }
    project([lng, lat]) { return { x: lng * 1000, y: lat * 1000 }; }
    queryRenderedFeatures(point, opts) {
      this.queries += 1;
      if (!opts || !opts.layers || !opts.layers.every((id) => this.layers[id])) throw new Error('layer does not exist');
      return mockWorld.rendered;
    }
    key(t) {
      if (t.source !== 'maptiler_buildings' || t.sourceLayer !== 'building') throw new Error('wrong feature target');
      if (!this.sources[t.source]) throw new Error('source does not exist');
      return String(t.id);
    }
    getFeatureState(t) { return this.state[this.key(t)] || {}; }
    setFeatureState(t, s) {
      const k = this.key(t);
      this.state[k] = { ...(this.state[k] || {}), ...s };
      this.writes.push(['set', t.id, s]);
    }
    removeFeatureState(t, key) {
      const k = this.key(t);
      if (this.state[k]) delete this.state[k][key];
      this.writes.push(['remove', t.id, key]);
    }
    fitBounds() {}
    resize() {}
    jumpTo() {}
    flyTo() {}
    remove() {}
  }
  class FakeMarker {
    constructor(opts) { this.el = opts.element; }
    setLngLat() { return this; }
    addTo() { return this; }
    remove() {}
    setOpacity() { return this; }
  }
  class FakeBounds { extend() { return this; } }
  const lib = { Map: FakeMap, Marker: FakeMarker, AttributionControl: class {}, LngLatBounds: FakeBounds };
  return {
    __esModule: true,
    loadMapEngine: async () => ({ kind: 'sdk', lib, Map: FakeMap, options: {}, locateByIp: null }),
  };
});

const MapLibreMapView = require('../components/map/MapLibreMapView').default;
const { crowdBuildingBand } = require('../components/map/MapLibreMapView');

// A square footprint of half-width `r` degrees around a point.
const square = (id, lng, lat, r = 0.0002) => ({
  id,
  geometry: {
    type: 'Polygon',
    coordinates: [[[lng - r, lat - r], [lng + r, lat - r], [lng + r, lat + r], [lng - r, lat + r], [lng - r, lat - r]]],
  },
});

const BAR = { id: 1, place_id: 'BAR', name: 'Oakwood', types: ['bar'], category: 'Nightlife', crowd: 90, location: { latitude: 40.0, longitude: -75.0 } };

const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };
const view = (venues, filterCategory = 'All') => (
  <MapLibreMapView
    venues={venues}
    filterCategory={filterCategory}
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
  />
);

// Past the pass's debounce.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

async function loadedMap(venues, filterCategory) {
  const utils = render(view(venues, filterCategory));
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  const map = mockMaps[0];
  act(() => { map.fire('load'); });
  await settle();
  return { map, ...utils };
}

const bands = (map) => Object.fromEntries(
  Object.entries(map.state).filter(([, s]) => s.crowdBand).map(([id, s]) => [id, s.crowdBand]),
);

beforeEach(() => {
  mockMaps.length = 0;
  mockWorld.flockStyle = true;
  mockWorld.zoom = 16;
  mockWorld.rendered = [];
});

test('only the footprint that contains the venue takes its band, not the neighbour under the pixel', async () => {
  // The neighbour is returned FIRST, the way a tilted view puts a closer wall
  // on top of the venue's own building.
  mockWorld.rendered = [square(77, -75.001, 40.0), square(42, -75.0, 40.0)];
  const { map, unmount } = await loadedMap([BAR]);
  expect(bands(map)).toEqual({ 42: 'red' });
  unmount();
});

test('a feature with no id is never tinted, because there is no building to name', async () => {
  mockWorld.rendered = [{ ...square(null, -75.0, 40.0), id: undefined }];
  const { map, unmount } = await loadedMap([BAR]);
  expect(map.writes).toEqual([]);
  unmount();
});

test('no score, or a score the viewer cannot see, tints nothing', async () => {
  mockWorld.rendered = [square(42, -75.0, 40.0)];
  const unscored = { ...BAR, crowd: null };
  const locked = { ...BAR, crowd: 90, crowdLocked: true };
  const { map, unmount } = await loadedMap([unscored, locked]);
  expect(map.writes).toEqual([]);
  unmount();
});

test('a venue the category filter hides tints nothing', async () => {
  mockWorld.rendered = [square(42, -75.0, 40.0)];
  // Not 'Food': venueMatchesCategory counts a bar as food.
  const { map, unmount } = await loadedMap([BAR], 'Sports');
  expect(bands(map)).toEqual({});
  unmount();
});

test('the band clears when the venue loses its score', async () => {
  mockWorld.rendered = [square(42, -75.0, 40.0)];
  const { map, rerender, unmount } = await loadedMap([BAR]);
  expect(bands(map)).toEqual({ 42: 'red' });
  rerender(view([{ ...BAR, crowd: null }]));
  await settle();
  expect(bands(map)).toEqual({});
  unmount();
});

test('a settled map that is already right writes nothing, so idle does not repaint for ever', async () => {
  mockWorld.rendered = [square(42, -75.0, 40.0)];
  const { map, unmount } = await loadedMap([BAR]);
  const writes = map.writes.length;
  act(() => { map.fire('idle'); });
  await settle();
  act(() => { map.fire('idle'); });
  await settle();
  expect(map.writes.length).toBe(writes);
  unmount();
});

test('a style swap brings the tint back', async () => {
  mockWorld.rendered = [square(42, -75.0, 40.0)];
  const { map, unmount } = await loadedMap([BAR]);
  expect(bands(map)).toEqual({ 42: 'red' });
  // A swap through the view (the satellite toggle here; the theme flip takes
  // the same path). The fake's setStyle rebuilds the source, which drops the
  // state the way MapLibre does, and its new style still has the layer.
  fireEvent.click(screen.getByRole('button', { name: 'Switch to satellite view' }));
  expect(bands(map)).toEqual({});
  act(() => { map.fire('styledata'); });
  await settle();
  expect(bands(map)).toEqual({ 42: 'red' });
  unmount();
});

test('below zoom 15 nothing is asked', async () => {
  mockWorld.zoom = 14.9;
  mockWorld.rendered = [square(42, -75.0, 40.0)];
  const { map, unmount } = await loadedMap([BAR]);
  act(() => { map.fire('idle'); });
  await settle();
  expect(map.queries).toBe(0);
  expect(map.writes).toEqual([]);
  unmount();
});

test('on a style without the Flock buildings layer nothing is asked', async () => {
  mockWorld.flockStyle = false;
  mockWorld.rendered = [square(42, -75.0, 40.0)];
  const { map, unmount } = await loadedMap([BAR]);
  act(() => { map.fire('idle'); });
  await settle();
  expect(map.queries).toBe(0);
  expect(map.writes).toEqual([]);
  unmount();
});

test('the band changes exactly where App.js crowdBandFor changes', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const source = app.match(/const crowdBandFor = \(score\) => \{[\s\S]*?\n\};/);
  expect(source).not.toBeNull();
  // eslint-disable-next-line no-new-func
  const crowdBandFor = new Function(`${source[0]}\nreturn crowdBandFor;`)();
  for (let score = 0; score <= 100; score += 1) {
    expect([score, crowdBuildingBand({ crowd: score })]).toEqual([score, crowdBandFor(score)]);
  }
  expect(crowdBuildingBand({ crowd: null })).toBeNull();
  expect(crowdBuildingBand({ crowd: NaN })).toBeNull();
  expect(crowdBuildingBand({ crowd: 90, crowdLocked: true })).toBeNull();
});
