/**
 * THE MAP RUNS ON THE MAPTILER SDK, CONFIGURED TO BILL SESSIONS AND DO NOTHING
 * ELSE ON ITS OWN.
 *
 * MapTiler bills a map built on plain maplibre-gl per tile request; only maps
 * built with its SDK are billed per session (one per page load that builds a
 * map, every tile inside it free). components/map/mapEngine.js loads the SDK
 * when there is a key and plain maplibre-gl when there is not. The SDK also
 * does several things by default that this app must not let it do, and each is
 * pinned here against the options the view actually constructs its map with:
 *
 *   - its own zoom and locate buttons (Flock draws its own, sized to the room
 *     the surface has; the SDK's locate button would be a fourth door into the
 *     OS location prompt);
 *   - the right-to-left text plugin from cdn.maptiler.com, a host the CSP does
 *     not allow, so every style load would log an error;
 *   - swapping a style that failed to load for MapTiler Streets, which under
 *     the spending cap answers 403 too and is retried;
 *   - its logo, its telemetry beacon, its console banner, rewriting labels;
 *   - re-requesting expired tiles on a map that stays open for hours.
 *
 * And the session settings have to be in place BEFORE the map is built,
 * because the SDK reads them at construction.
 *
 * The SDK ships as ES modules only, which Jest under react-scripts does not
 * transform, so it is replaced here by a fake that records what it was given.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test mapEngineSdkConfig --watchAll=false
 */
const React = require('react');
const { render, waitFor, act } = require('@testing-library/react');

process.env.REACT_APP_MAPTILER_KEY = 'test-maptiler-key';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));

const mockSdkMaps = [];
jest.mock('@maptiler/sdk', () => {
  class MapStyleVariant {}
  class ReferenceMapStyle {}
  const MapStyle = { STREETS: new ReferenceMapStyle() };
  const config = { apiKey: '', session: false, caching: false, telemetry: true, primaryLanguage: 'auto' };
  class FakeSource { setData(d) { this.data = d; } }
  // Stands in for the SDK's Map, which extends MapLibre's. Like the real one
  // it calls this.setStyle from its constructor, and it records the global
  // config as it stood at that moment.
  class Map {
    constructor(opts) {
      this.opts = opts;
      this.configAtConstruction = { ...config };
      this.appliedStyles = [];
      this.handlers = {};
      this.sources = {};
      this.layers = {};
      mockSdkMaps.push(this);
      this.setStyle(opts.style);
    }
    setStyle(style) { this.appliedStyles.push(style); this.sources = {}; this.layers = {}; return this; }
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
  class Marker {
    setLngLat() { return this; }
    addTo() { return this; }
    remove() {}
    setOpacity() { return this; }
  }
  class LngLatBounds { extend() { return this; } }
  class AttributionControl {}
  return {
    __esModule: true,
    Map, Marker, LngLatBounds, AttributionControl, Popup: class {},
    MapStyle, MapStyleVariant, ReferenceMapStyle,
    Language: { STYLE: 'style', STYLE_LOCK: 'style_lock' },
    config,
  };
});

const MapLibreMapView = require('../components/map/MapLibreMapView').default;

const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };
const view = () => (
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
  />
);

async function builtMap() {
  const utils = render(view());
  await waitFor(() => expect(mockSdkMaps).toHaveLength(1));
  return { map: mockSdkMaps[0], ...utils };
}

beforeEach(() => {
  mockSdkMaps.length = 0;
});

describe('with a MapTiler key the view builds its map on the SDK', () => {
  test('session billing is on, and set before the map is built', async () => {
    const { map, unmount } = await builtMap();
    const sdk = require('@maptiler/sdk');
    expect(map).toBeInstanceOf(sdk.Map);
    expect(map.configAtConstruction).toMatchObject({
      apiKey: 'test-maptiler-key',
      session: true,
      caching: true,
      telemetry: false,
      primaryLanguage: 'style_lock',
    });
    unmount();
  });

  test('the SDK adds no controls, no logo, no globe and no right-to-left plugin', async () => {
    const { map, unmount } = await builtMap();
    expect(map.opts).toMatchObject({
      navigationControl: false,
      geolocateControl: false,
      terrainControl: false,
      scaleControl: false,
      fullscreenControl: false,
      projectionControl: false,
      maptilerLogo: false,
      forceNoAttributionControl: true,
      space: false,
      halo: false,
      projection: 'mercator',
      geolocate: false,
      rtlTextPlugin: false,
      logSDKVersion: false,
    });
    unmount();
  });

  test('expired tiles are not re-requested, and the view keeps its own options', async () => {
    const { map, unmount } = await builtMap();
    expect(map.opts.refreshExpiredTiles).toBe(false);
    expect(map.opts.attributionControl).toBe(false);
    expect(map.opts.minZoom).toBe(3);
    expect(map.opts.maxZoom).toBe(18);
    expect(map.opts.container).toBeTruthy();
    // Still the app's own style until the Flock style replaces it.
    expect(String(map.opts.style)).toMatch(/^https:\/\/api\.maptiler\.com\/maps\//);
    unmount();
  });

  test('a style that failed is never swapped for MapTiler Streets', async () => {
    const { map, unmount } = await builtMap();
    const sdk = require('@maptiler/sdk');
    const before = map.appliedStyles.length;
    // What the SDK's error handler calls when a style URL fails to load.
    map.setStyle(sdk.MapStyle.STREETS);
    map.setStyle(new sdk.MapStyleVariant());
    expect(map.appliedStyles).toHaveLength(before);
    // An ordinary style still goes through.
    map.setStyle('https://api.maptiler.com/maps/basic-v2/style.json?key=x');
    expect(map.appliedStyles).toHaveLength(before + 1);
    unmount();
  });

  test('a map that loads still has its overlays added', async () => {
    const { map, unmount } = await builtMap();
    act(() => { map.fire('load'); });
    expect(map.getSource('venue-heat')).toBeTruthy();
    unmount();
  });
});

// Last, because jest.doMock outlives resetModules and would replace the SDK
// fake above for every test after it.
describe('without a key the engine is plain maplibre-gl', () => {
  test('loadMapEngine with no key never loads the SDK', async () => {
    jest.resetModules();
    const fakeMl = { Map: class {}, Marker: class {} };
    jest.doMock('maplibre-gl', () => ({ __esModule: true, default: fakeMl }));
    const sdkLoaded = jest.fn();
    jest.doMock('@maptiler/sdk', () => { sdkLoaded(); return {}; });
    const { loadMapEngine } = require('../components/map/mapEngine');
    const engine = await loadMapEngine({ key: undefined });
    expect(engine.kind).toBe('maplibre');
    expect(engine.Map).toBe(fakeMl.Map);
    expect(engine.lib).toBe(fakeMl);
    expect(engine.options).toEqual({});
    expect(sdkLoaded).not.toHaveBeenCalled();
  });
});
