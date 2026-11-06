/**
 * THE MAP'S GOOGLE MARK STANDS ABOVE A LEFT-DOCKED SOS (2026-11-06).
 *
 * While Places pins show, the Discover map carries one "Google Maps" mark in
 * its bottom left corner, 40px up (MapLibreMapView.js). SOS docks on the row
 * above the Filters row, 12px from the side, and the user can drag it to the
 * left. There its 52px disc covers 12..64px above the map's bottom edge, and
 * it is drawn over the map, so the mark at 40..58px sat inside the disc's
 * height and "Google" was under the red disc: Google's attribution drawn and
 * unreadable. Now App.js hands Discover how far up the docked row reaches on
 * that side, and the mark stands 8px above it, or above the POI notice when
 * that reaches higher. With SOS on the right, or Safety off, nothing changes.
 *
 * jsdom lays nothing out, so the geometry runs App.js's own constants and
 * expression, lifted from the source, and the mark's own offset from the map
 * module's helper. The mark itself is mounted for real against a fake engine
 * standing in for mapEngine.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test mapGoogleMarkClearsSos --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, waitFor, act } = require('@testing-library/react');

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
      this.sources = {};
      this.layers = {};
      mockMaps.push(this);
    }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    once(evt, fn) { return this.on(evt, fn); }
    fire(evt, e) { (this.handlers[evt] || []).forEach((fn) => fn(e)); }
    setStyle() {}
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
  const engine = { kind: 'sdk', lib, Map: FakeMap, options: {}, locateByIp: null };
  return { __esModule: true, loadMapEngine: () => Promise.resolve(engine) };
});

const MapLibreMapView = require('../components/map/MapLibreMapView').default;
const { googleMarkBottom } = require('../components/map/MapLibreMapView');

const SRC = path.resolve(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = readSrc('App.js');
const EXPLORE = readSrc('screens', 'ExploreScreen.js');
const MAP = readSrc('components', 'map', 'MapLibreMapView.js');

const constant = (name) => {
  const m = APP.match(new RegExp(`\\n\\s+const ${name} = (\\d+);`));
  if (!m) throw new Error(`no const ${name} in App.js`);
  return Number(m[1]);
};
const FAB_DOCK_GAP = constant('FAB_DOCK_GAP');
const FAB_SIZE = constant('FAB_SIZE');
const FAB_EDGE = constant('FAB_EDGE');
const dockedRowHeight = FAB_DOCK_GAP + FAB_SIZE;

// What App.js hands Discover, from its own expression.
const clearExpr = APP.match(/\n\s+const discoverMapLeftClear = ([^;\n]+);/);
const clearOf = new Function('safetyOn', 'sosCorner', 'dockedRowHeight', `return (${clearExpr && clearExpr[1]});`);
const discoverMapLeftClear = (sosCorner, safetyOn = true) => clearOf(safetyOn, sosCorner, dockedRowHeight);

/* Boxes in the map's own frame: x from its left edge, y up from its bottom
   edge, which on Discover is the top of the Filters row. The dock's bottom is
   the tab bar, the Filters row and FAB_DOCK_GAP up from the frame, and the
   map ends at the top of the Filters row, so a docked disc starts
   FAB_DOCK_GAP above the map's bottom. */
const SOS_DISC = { x0: FAB_EDGE, x1: FAB_EDGE + FAB_SIZE, y0: FAB_DOCK_GAP, y1: FAB_DOCK_GAP + FAB_SIZE };
// The mark: left 10px, a 16px line and 1px padding above and below, and
// "Google Maps" at 12px plus 6px padding a side is about 85px; 100 is
// generous, and the vertical span is what decides it.
const markBox = (bottom) => ({ x0: 10, x1: 110, y0: bottom, y1: bottom + 18 });
// The POI notice: centred, 24px up, at most the width less 128px.
const noticeBox = (width, height) => {
  const w = width - 128;
  return { x0: (width - w) / 2, x1: (width + w) / 2, y0: 24, y1: 24 + height };
};
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe('what App.js hands the map', () => {
  test('the expression was read', () => {
    expect(clearExpr).not.toBeNull();
  });

  test('SOS on the left with Safety on: the docked row\'s height; otherwise nothing', () => {
    expect(discoverMapLeftClear('bottom-left', true)).toBe(dockedRowHeight);
    expect(discoverMapLeftClear('bottom-right', true)).toBe(0);
    expect(discoverMapLeftClear('bottom-left', false)).toBe(0);
    expect(discoverMapLeftClear('bottom-right', false)).toBe(0);
  });

  test('it travels App.js -> ExploreScreen -> the map, under one name each side', () => {
    const props = APP.slice(APP.indexOf('const exploreScreenProps = {'), APP.indexOf('};', APP.indexOf('const exploreScreenProps = {')));
    expect(props).toMatch(/\n\s+discoverMapLeftClear,\n/);
    const params = EXPLORE.slice(EXPLORE.indexOf('export default function ExploreScreen({'), EXPLORE.indexOf('}) {'));
    expect(params).toMatch(/\n\s+discoverMapLeftClear,\n/);
    const mapEl = EXPLORE.slice(EXPLORE.indexOf('<MapLibreMapView'), EXPLORE.indexOf('/>', EXPLORE.indexOf('<MapLibreMapView')));
    expect(mapEl).toContain('bottomLeftClear={discoverMapLeftClear}');
    expect(MAP).toMatch(/const MapLibreMapView = React\.memo\(\(\{[^}]*\bbottomLeftClear = 0\b[^}]*\}\) =>/);
    expect(MAP).toContain('bottom: `${googleMarkBottom(poiNoticeHeight, bottomLeftClear)}px`');
  });
});

describe('where the mark stands', () => {
  test('alone: 40px up, as before', () => {
    expect(googleMarkBottom(0, 0)).toBe(40);
  });

  test('over a left-docked SOS: 8px above the docked row', () => {
    expect(googleMarkBottom(0, dockedRowHeight)).toBe(dockedRowHeight + 8);
  });

  test('over a POI notice: 8px above its top', () => {
    expect(googleMarkBottom(34, 0)).toBe(24 + 34 + 8);
  });

  test('over both: above whichever reaches higher', () => {
    expect(googleMarkBottom(34, dockedRowHeight)).toBe(dockedRowHeight + 8);
    expect(googleMarkBottom(52, dockedRowHeight)).toBe(24 + 52 + 8);
  });

  test('a left-docked SOS no longer covers it; on the right it never stood there', () => {
    // Before: 40px up, inside the disc's 12..64.
    expect(overlaps(markBox(40), SOS_DISC)).toBe(true);
    expect(overlaps(markBox(googleMarkBottom(0, discoverMapLeftClear('bottom-left'))), SOS_DISC)).toBe(false);
    // SOS on the right leaves the mark exactly where it was.
    expect(googleMarkBottom(0, discoverMapLeftClear('bottom-right'))).toBe(40);
  });

  test.each([320, 390])('at %ipx wide, clear of the disc and of a one-, two- or three-line notice', (width) => {
    for (const noticeH of [0, 34, 52, 70]) {
      const bottom = googleMarkBottom(noticeH, discoverMapLeftClear('bottom-left'));
      expect(`${width}/${noticeH}: ${overlaps(markBox(bottom), SOS_DISC)}`).toBe(`${width}/${noticeH}: false`);
      if (noticeH) expect(`${width}/${noticeH}: ${overlaps(markBox(bottom), noticeBox(width, noticeH))}`).toBe(`${width}/${noticeH}: false`);
    }
  });
});

describe('the mark on a mounted map', () => {
  const palette = { food: '#a00', nightlife: '#0a0', music: '#00a', sports: '#aa0', steel: '#555' };
  const VENUES = [
    { id: 1, place_id: 'A', name: 'Oakwood', types: ['bar'], category: 'Nightlife', crowd: 80, location: { latitude: 40.0, longitude: -75.0 } },
  ];
  const view = (props) => (
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
      followUser={false}
      locationAllowed={false}
      {...props}
    />
  );
  const markBottom = () => screen.getByTestId('google-maps-attribution').parentElement.style.bottom;

  beforeEach(() => { mockMaps.length = 0; });

  test('with nothing on its left it stands 40px up, and a left-docked SOS lifts it', async () => {
    const { rerender, unmount } = render(view());
    await waitFor(() => expect(mockMaps).toHaveLength(1));
    act(() => { mockMaps[0].fire('load'); });
    expect(markBottom()).toBe('40px');

    rerender(view({ bottomLeftClear: dockedRowHeight }));
    expect(markBottom()).toBe(`${dockedRowHeight + 8}px`);

    // SOS dragged back to the right.
    rerender(view({ bottomLeftClear: 0 }));
    expect(markBottom()).toBe('40px');
    unmount();
  });
});
