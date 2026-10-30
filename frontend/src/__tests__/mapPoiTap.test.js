/**
 * A PLACE THE MAP DRAWS OPENS WHEN TAPPED, IN ANY CITY.
 *
 * From street zoom the Discover basemap draws restaurants, cafes, bars, clubs,
 * cinemas and museums from OpenStreetMap, everywhere, not only where Flock
 * collects crowd readings. A tap on one is looked up on the server
 * (GET /api/venues/resolve-poi, one free IDs-only Google lookup) and opened in
 * the venue sheet. components/map/poiTap.js decides what a tap opens;
 * MapLibreMapView wires it to the map.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern mapPoiTap
 */
import {
  POI_TAP_MIN_ZOOM, POI_TAP_RADIUS_PX, TAPPABLE_POI_LAYER_IDS, pickTappablePoi, poiUnderTap,
} from '../components/map/poiTap';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const VIEW = read('components', 'map', 'MapLibreMapView.js');
const STYLE = read('components', 'map', 'flockStyle', 'buildFlockStyle.js');
const API = read('services', 'api.js');

const feature = (layerId, props, coords = [-122.0322, 37.3229], type = 'Point') => ({
  layer: { id: layerId }, properties: props, geometry: { type, coordinates: coords },
});

describe('what a tap opens', () => {
  test('a restaurant at street zoom opens with its name and point', () => {
    const f = [feature('flock-poi-food', { name: "Joe's Pizza", class: 'restaurant' })];
    expect(pickTappablePoi(f, 15)).toEqual({ name: "Joe's Pizza", lat: 37.3229, lng: -122.0322, layerId: 'flock-poi-food' });
  });

  test('nothing opens below street zoom', () => {
    const f = [feature('flock-poi-food', { name: "Joe's Pizza", class: 'restaurant' })];
    expect(POI_TAP_MIN_ZOOM).toBe(15);
    expect(pickTappablePoi(f, 14.9)).toBeNull();
    expect(pickTappablePoi(f, undefined)).toBeNull();
  });

  test('only places a group would go to: no casinos, churches, info boards or bus stops', () => {
    expect(pickTappablePoi([feature('flock-poi-nightlife', { name: 'Lucky 7', subclass: 'casino' })], 16)).toBeNull();
    expect(pickTappablePoi([feature('flock-poi-culture', { name: 'St Mary', class: 'place_of_worship' })], 16)).toBeNull();
    expect(pickTappablePoi([feature('flock-poi-tourism', { name: 'Trail map', class: 'information' })], 16)).toBeNull();
    expect(pickTappablePoi([feature('flock-poi-transport', { name: 'Main St', class: 'bus' })], 16)).toBeNull();
    expect(pickTappablePoi([feature('flock-poi-nightlife', { name: 'Club Nine', subclass: 'nightclub' })], 16)).not.toBeNull();
    expect(pickTappablePoi([feature('flock-poi-culture', { name: 'The Roxie', class: 'cinema' })], 16)).not.toBeNull();
    expect(pickTappablePoi([feature('flock-poi-tourism', { name: 'City Zoo', class: 'zoo' })], 16)).not.toBeNull();
  });

  test('food and drink win when a tap covers more than one place', () => {
    const f = [
      feature('flock-poi-culture', { name: 'The Roxie', class: 'cinema' }),
      feature('flock-poi-food', { name: 'Blue Door Cafe', class: 'cafe' }),
    ];
    expect(pickTappablePoi(f, 16).name).toBe('Blue Door Cafe');
  });

  test('a glyph with no name, or no point, is passed over', () => {
    expect(pickTappablePoi([feature('flock-poi-food', { class: 'cafe' })], 16)).toBeNull();
    expect(pickTappablePoi([feature('flock-poi-food', { name: '   ', class: 'cafe' })], 16)).toBeNull();
    expect(pickTappablePoi([feature('flock-poi-food', { name: 'Odd', class: 'cafe' }, [[0, 0], [1, 1]], 'LineString')], 16)).toBeNull();
    expect(pickTappablePoi([feature('flock-poi-food', { name: 'Odd', class: 'cafe' }, ['x', 2])], 16)).toBeNull();
    expect(pickTappablePoi(null, 16)).toBeNull();
  });

  test('every layer offered is one the Flock style draws', () => {
    for (const id of TAPPABLE_POI_LAYER_IDS) expect(STYLE).toContain(`id: '${id}',`);
  });
});

describe('asking the map', () => {
  const fakeMap = ({ zoom = 16, layers = TAPPABLE_POI_LAYER_IDS, features = [] } = {}) => {
    const calls = [];
    return {
      calls,
      getZoom: () => zoom,
      getLayer: (id) => (layers.includes(id) ? { id } : undefined),
      queryRenderedFeatures: (box, opts) => { calls.push({ box, opts }); return features; },
    };
  };

  test('a box around the tap, on the layers the style has', () => {
    const map = fakeMap({ layers: ['flock-poi-food', 'flock-poi-culture'], features: [feature('flock-poi-food', { name: 'Wilder', class: 'restaurant' })] });
    const poi = poiUnderTap(map, { x: 100, y: 200 });
    expect(poi.name).toBe('Wilder');
    expect(map.calls).toHaveLength(1);
    const r = POI_TAP_RADIUS_PX;
    expect(map.calls[0].box).toEqual([[100 - r, 200 - r], [100 + r, 200 + r]]);
    expect(map.calls[0].opts.layers).toEqual(['flock-poi-food', 'flock-poi-culture']);
  });

  test('no query at all below street zoom, or on a style with none of the layers', () => {
    const low = fakeMap({ zoom: 13 });
    expect(poiUnderTap(low, { x: 1, y: 1 })).toBeNull();
    expect(low.calls).toHaveLength(0);
    const satellite = fakeMap({ layers: [] });
    expect(poiUnderTap(satellite, { x: 1, y: 1 })).toBeNull();
    expect(satellite.calls).toHaveLength(0);
  });
});

describe('the map wires it', () => {
  const click = VIEW.slice(VIEW.indexOf("map.on('click', (e) => {"), VIEW.indexOf('setActiveVenue(null);', VIEW.indexOf("map.on('click', (e) => {")));

  test('a tap asks for a place before it clears the active venue, and pins keep their own taps', () => {
    expect(click).toMatch(/closest\?\.\('\.mlb-venue-marker'\)\) return;/);
    expect(click).toMatch(/poi = poiUnderTap\(map, e\.point\)/);
    expect(click).toMatch(/if \(poi && openPoiRef\.current\) \{\s*openPoiRef\.current\(poi\);\s*return;/);
  });

  test('the opener looks the place up and opens the venue sheet, one lookup at a time', () => {
    const opener = VIEW.slice(VIEW.indexOf('openPoiRef.current = (poi) => {'), VIEW.indexOf('// ---------- render ----------'));
    expect(opener).toMatch(/if \(poiBusyRef\.current\) return;/);
    expect(opener).toMatch(/resolveMapPlace\(poi\)/);
    expect(opener).toMatch(/openVenueDetail\(placeId, \{ name: poi\.name,/);
    expect(opener).toMatch(/finally\(\(\) => \{ poiBusyRef\.current = false; \}\)/);
  });

  test('why a place did not open is the server\'s sentence or plain copy, never an error\'s own text', () => {
    // It printed err.message, so a TypeError from opening the sheet read as
    // "undefined is not an object" on the map.
    const opener = VIEW.slice(VIEW.indexOf('openPoiRef.current = (poi) => {'), VIEW.indexOf('// ---------- render ----------'));
    expect(opener).toMatch(/setPoiNotice\(userMessage\(err, "That place didn't open\. Try tapping it again\."\)\);/);
    expect(opener).not.toMatch(/err\.message/);
    expect(VIEW).toMatch(/import \{ resolveMapPlace, userMessage \} from '\.\.\/\.\.\/services\/api';/);
  });

  test('what the map says while it looks, or why it did not open, is announced', () => {
    expect(VIEW).toMatch(/\{poiNotice && \(/);
    expect(VIEW).toMatch(/<p role="status" aria-live="polite"[^>]*>\{poiNotice\}<\/p>/);
  });

  test('the lookup is never retried automatically, because an uncached one spends a unit', () => {
    expect(API).toMatch(/export async function resolveMapPlace\(\{ name, lat, lng \}\) \{[\s\S]*?request\(`\/api\/venues\/resolve-poi\?\$\{qs\}`, \{ retry: false \}\)/);
  });
});
