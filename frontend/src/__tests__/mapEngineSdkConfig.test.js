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
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, waitFor, act } = require('@testing-library/react');

process.env.REACT_APP_MAPTILER_KEY = 'test-maptiler-key';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));

const mockSdkMaps = [];
const mockIpAnswers = [];
jest.mock('@maptiler/sdk', () => {
  class MapStyleVariant {}
  class ReferenceMapStyle {}
  const MapStyle = { STREETS: new ReferenceMapStyle() };
  const config = { apiKey: '', session: false, caching: false, telemetry: true, primaryLanguage: 'auto' };
  class FakeSource { setData(d) { this.data = d; } }
  // Stands in for MapLibre's Map, the class the SDK's Map extends. Only the
  // style a null clear reaches is recorded here.
  class MapLibreBase {
    setStyle(style) { (this.baseStyles = this.baseStyles || []).push(style); return this; }
  }
  // Stands in for the SDK's Map, which extends MapLibre's. Like the real one
  // it calls this.setStyle from its constructor, and it records the global
  // config as it stood at that moment.
  class Map extends MapLibreBase {
    constructor(opts) {
      super();
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
    isStyleLoaded() { return true; }
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
  const geolocation = {
    info: jest.fn(async () => {
      const next = mockIpAnswers.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return {
    __esModule: true,
    Map, Marker, LngLatBounds, AttributionControl, Popup: class {},
    MapStyle, MapStyleVariant, ReferenceMapStyle,
    Language: { STYLE: 'style', STYLE_LOCK: 'style_lock' },
    config,
    geolocation,
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
  mockIpAnswers.length = 0;
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
      primaryLanguage: 'style',
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
    // The Flock style, built in the app, rather than a hosted style URL.
    expect(map.opts.style).toMatchObject({ version: 8 });
    expect(['Flock Paper', 'Flock Night']).toContain(map.opts.style.name);
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

describe('code review of the map work (2026-10-08)', () => {
  test('remove() clearing the style with null reaches MapLibre, not the SDK, so the map releases its resources', async () => {
    const { map, unmount } = await builtMap();
    const before = map.appliedStyles.length;
    map.setStyle(null);
    // The SDK keeps its current style for a null, so the clear must skip it.
    expect(map.appliedStyles).toHaveLength(before);
    expect(map.baseStyles).toEqual([null]);
    unmount();
  });

  test('a refused key keeps the failure panel up even after the map reports load', async () => {
    const { map, unmount, findByText } = await builtMap();
    act(() => { map.fire('error', { error: { status: 403, message: 'Forbidden https://api.maptiler.com/tiles/v4/1/2/3.pbf?key=test-maptiler-key' } }); });
    act(() => { map.fire('load'); });
    await findByText('The map could not load. Search still works.', {}, { timeout: 5000 });
    unmount();
  });

  test('a map error is logged without the key', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { map, unmount } = await builtMap();
    act(() => { map.fire('error', { error: { status: 500, message: 'Failed https://api.maptiler.com/tiles/v4/1/2/3.pbf?key=test-maptiler-key' } }); });
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[Map]');
    expect(logged).not.toContain('test-maptiler-key');
    warn.mockRestore();
    unmount();
  });

  test('a tile error with no status (the device cache hides it) asks the free TileJSON once, and a refusal there shows the panel', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ status: 403 }));
    try {
      const { map, unmount, findByText } = await builtMap();
      act(() => { map.fire('load'); });
      act(() => { map.fire('error', { error: { message: 'Unimplemented type: 4' } }); });
      act(() => { map.fire('error', { error: { message: 'Unimplemented type: 4' } }); });
      await findByText('The map could not load. Search still works.', {}, { timeout: 5000 });
      const probes = global.fetch.mock.calls.filter(([u]) => String(u).includes('/tiles/v4/tiles.json'));
      expect(probes).toHaveLength(1);
      unmount();
    } finally {
      global.fetch = realFetch;
    }
  });

  test('a refusal clears after a style swap only through the free TileJSON check and a whole reload', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'map', 'MapLibreMapView.js'), 'utf8').replace(/\r\n/g, '\n');
    const body = src.slice(src.indexOf('const rehydrateAfterStyleSwap = useCallback((map) => {')).slice(0, 2800);
    expect(body).toMatch(/tiles\/v4\/tiles\.json/);
    expect(body).toMatch(/if \(r\.ok && mapInstanceRef\.current === map\) recover\(\);/);
    expect(body).toMatch(/if \(mapInstanceRef\.current !== map \|\| swap !== styleSwapRef\.current \|\| !keyRefusedRef\.current\) return;/);
    // A style still loading is waited for, not dropped.
    expect(body).toMatch(/map\.once\('idle', recover\);/);
    expect(body).toMatch(/if \(!current \|\| \(typeof map\.isStyleLoaded === 'function' && !map\.isStyleLoaded\(\)\)\) \{/);
    expect(body).toMatch(/map\.reloadStyle\(current\);/);
    // Never cleared unconditionally on the swap itself.
    expect(body).not.toMatch(/if \(keyRefusedRef\.current\) \{ keyRefusedRef\.current = false;/);
  });

  test('once the key works again, a swap reloads the style whole and the panel comes down only after it settles', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    try {
      const utils = await builtMap();
      const { map, unmount, getByRole, queryByText } = utils;
      act(() => { map.fire('load'); });
      act(() => { map.fire('error', { error: { status: 403, message: 'Forbidden' } }); });
      expect(queryByText('The map could not load. Search still works.')).toBeTruthy();
      // A style swap: the satellite toggle, whose new style fires styledata.
      act(() => { getByRole('button', { name: 'Switch to satellite view' }).click(); });
      await act(async () => { map.fire('styledata'); await Promise.resolve(); await Promise.resolve(); });
      // The free check answered OK, so the style was reloaded through MapLibre
      // with diff off, which refetches every source.
      await waitFor(() => expect((map.baseStyles || []).length).toBeGreaterThan(0), { timeout: 5000 });
      // Still covered until the reload settles.
      expect(queryByText('The map could not load. Search still works.')).toBeTruthy();
      act(() => { map.fire('idle'); });
      await waitFor(() => expect(queryByText('The map could not load. Search still works.')).toBeNull(), { timeout: 5000 });
      unmount();
    } finally {
      global.fetch = realFetch;
    }
  });

  test('an OK check while the style is still loading waits for it instead of giving up', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    try {
      const { map, unmount, getByRole } = await builtMap();
      act(() => { map.fire('load'); });
      act(() => { map.fire('error', { error: { status: 403, message: 'Forbidden' } }); });
      map.isStyleLoaded = () => false;
      act(() => { getByRole('button', { name: /Switch to (satellite|map) view/ }).click(); });
      await act(async () => { map.fire('styledata'); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      // Still loading: nothing reloaded yet, and the attempt is waiting.
      expect(map.baseStyles || []).toHaveLength(0);
      map.isStyleLoaded = () => true;
      act(() => { map.fire('idle'); });
      await waitFor(() => expect((map.baseStyles || []).length).toBeGreaterThan(0), { timeout: 5000 });
      unmount();
    } finally {
      global.fetch = realFetch;
    }
  });

  test('Sentry scrubs console breadcrumb arguments and exception values, not only messages', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const block = src.slice(src.indexOf('beforeSend(event) {'), src.indexOf('beforeSendTransaction(event) {'));
    expect(block).toMatch(/if \(b\?\.data\) scrubEventStrings\(b\.data\);/);
    expect(block).toMatch(/ex\.value = scrubUrlTokens\(ex\.value\)/);
  });
});

describe('the city the connection is in', () => {
  // A fresh module per test, so the in-memory answer of one does not leak.
  const freshEngine = () => {
    jest.resetModules();
    const sdk = require('@maptiler/sdk');
    sdk.geolocation.info.mockClear();
    const { loadMapEngine } = require('../components/map/mapEngine');
    return { sdk, loadMapEngine };
  };

  test('is asked once per launch and kept in memory', async () => {
    const { sdk, loadMapEngine } = freshEngine();
    mockIpAnswers.push({ latitude: 40.6, longitude: -75.4, city: 'Allentown' });
    const engine = await loadMapEngine({ key: 'k' });
    expect(await engine.locateByIp()).toEqual({ lat: 40.6, lng: -75.4 });
    expect(await engine.locateByIp()).toEqual({ lat: 40.6, lng: -75.4 });
    const again = await loadMapEngine({ key: 'k' });
    expect(await again.locateByIp()).toEqual({ lat: 40.6, lng: -75.4 });
    expect(sdk.geolocation.info).toHaveBeenCalledTimes(1);
    expect(sdk.geolocation.info).toHaveBeenCalledWith({ apiKey: 'k' });
  });

  test('a failure answers null and is not kept, so a later map can ask again', async () => {
    const { sdk, loadMapEngine } = freshEngine();
    mockIpAnswers.push(new Error('403'), { latitude: 'x' }, { latitude: 41, longitude: -76 });
    const engine = await loadMapEngine({ key: 'k' });
    expect(await engine.locateByIp()).toBeNull();
    expect(await engine.locateByIp()).toBeNull();
    expect(await engine.locateByIp()).toEqual({ lat: 41, lng: -76 });
    expect(sdk.geolocation.info).toHaveBeenCalledTimes(3);
  });

  test('is never written to storage', async () => {
    const { loadMapEngine } = freshEngine();
    const writes = jest.spyOn(Storage.prototype, 'setItem');
    mockIpAnswers.push({ latitude: 40.6, longitude: -75.4 });
    const engine = await loadMapEngine({ key: 'k' });
    await engine.locateByIp();
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
  });

  test('the engine module has no storage, analytics or network path of its own', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'map', 'mapEngine.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(src).not.toMatch(/posthog|capture\(|track\(|sendBeacon|fetch\(/i);
    expect(src).not.toMatch(/from '\.\.\/\.\.\/services\//);
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
    expect(engine.locateByIp).toBeNull();
    expect(sdkLoaded).not.toHaveBeenCalled();
  });
});
