// "Flock Paper" and "Flock Night": the Discover basemap, written as Flock's own
// layer list against the MapTiler Planet v4 vector schema.
//
// WHY A LAYER LIST OF OUR OWN. The repo is public. MapTiler's hosted styles are
// their design, and a recoloured copy of one is still a copy, so nothing here is
// lifted from their style JSON. What the style USES from MapTiler (tiles,
// TileJSON, glyphs, the icon sprite) is loaded from api.maptiler.com by the
// person's own device, which is use of the service the terms allow.
//
// WHY AN OBJECT AND NOT A URL. The style ships inside the map chunk, so there is
// no style round trip and no style URL for the engine to re-poll, and a
// light/dark swap only repaints: both themes share the same source ids and URLs
// and the same layer ids, so cached tiles carry over.
//
// THE POI POLICY. Zoomed out the map stays clean: roads, water, neighbourhood
// and city names, and Flock's own pins. From street level the neighbourhood
// fills in: food and drink, nightlife, shops and entertainment first, then the
// rest, one importance tier per zoom step, with names one step after the icons.
// Each tier is a FILTER on zoom, not an opacity, so a POI that is not shown yet
// takes no collision space from one that is. Collision then thins whatever is
// left. Flock's venue pins are HTML markers drawn above the canvas, so no POI
// can cover one; the POIs stay small tinted glyphs so a pin is always the
// loudest, tappable thing.
//
// Planet v4 POIs carry no importance rank, so importance is the class: a bar or
// a restaurant outranks a vending machine because Flock is about evenings out.

import { paletteFor, poiColor, CROWD_TINT } from './palette.js';

// Bump on ANY visual change. The hosted copies pasted into MapTiler's Map
// Designer (for Static Maps) record which version they mirror.
export const FLOCK_STYLE_VERSION = 1;

export const FLOCK_LAYER_IDS = { buildings3d: 'flock-3d-buildings', firstLabel: 'flock-first-label' };
// crowdBand values: 'green' | 'amber' | 'red'. With no state set a building
// keeps the base colour; a building is tinted only where a real score exists.
export const FLOCK_BUILDINGS = { source: 'maptiler_buildings', sourceLayer: 'building', stateKey: 'crowdBand' };

// MapTiler hosts Noto Sans with real glyphs. Naming a font it does not host
// (Hanken Grotesk, until it is uploaded) silently renders Noto anyway, so the
// style names exactly what it gets.
export const FLOCK_FONTS = {
  regular: ['Noto Sans Regular'],
  medium: ['Noto Sans Medium'],
  bold: ['Noto Sans Bold'],
};

// Required on every map (MapTiler terms §5 and their attribution guide): the
// text and both links. Set on the sources explicitly so the compact control
// keeps showing it whatever the TileJSON says.
export const FLOCK_ATTRIBUTION =
  '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">© MapTiler</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

const MAPTILER = 'https://api.maptiler.com';
// The general icon sprite MapTiler's v4 maps use. Every icon in it is an SDF
// glyph, so each category takes its own colour through icon-color. It needs no
// key, so the key stays out of one more URL.
const SPRITE_URL = `${MAPTILER}/sprites/general/sprite`;

// Planet v4 hides these in poi_public class `adult` and poi_shopping class
// `beauty`. The app has users from 13, so they are filtered by SUBCLASS: the
// same `adult` class also holds nightclubs, which stay.
export const HIDDEN_POI_SUBCLASSES = ['brothel', 'stripclub', 'adult_gaming_centre', 'gambling', 'erotic'];

// --- expression helpers -----------------------------------------------------

const get = (k) => ['get', k];
const inList = (key, values) => ['match', get(key), values, true, false];
const notIn = (key, values) => ['!', inList(key, values)];
const isPoint = ['==', ['geometry-type'], 'Point'];
const isLine = ['==', ['geometry-type'], 'LineString'];
const isPolygon = ['==', ['geometry-type'], 'Polygon'];
const named = ['has', 'name'];
const notHidden = notIn('subclass', HIDDEN_POI_SUBCLASSES);
const notConstruction = ['!=', get('construction'), true];
const brunnelIs = (v) => ['==', get('brunnel'), v];
const onGround = notIn('brunnel', ['bridge', 'tunnel']);

// Zoom-stepped boolean: `tiers` is [[zoom, condition], ...], cumulative, so a
// feature that qualifies at one zoom stays in at every zoom above it.
const zoomTiers = (tiers) => {
  const expr = ['step', ['zoom'], false];
  const sofar = [];
  tiers.forEach(([z, cond]) => {
    sofar.push(cond);
    expr.push(z, sofar.length === 1 ? cond : ['any', ...sofar]);
  });
  return expr;
};

// Sort key: the tier a feature first qualifies in. Lower is placed first.
const tierRank = (tiers) => {
  const expr = ['case'];
  tiers.forEach(([, cond], i) => expr.push(cond, i + 1));
  expr.push(tiers.length + 1);
  return expr;
};

// Names lag the icons by `lag` zoom steps.
const tieredName = (tiers, lag, nameExpr = get('name')) => {
  if (lag === 0) return nameExpr;
  const expr = ['step', ['zoom'], ''];
  const sofar = [];
  tiers.forEach(([z, cond]) => {
    sofar.push(cond);
    expr.push(z + lag, ['case', sofar.length === 1 ? cond : ['any', ...sofar], nameExpr, '']);
  });
  return expr;
};

// --- roads ------------------------------------------------------------------

const ROAD_GROUPS = {
  motorway: ['motorway'],
  major: ['trunk', 'primary'],
  mid: ['secondary', 'tertiary'],
  minor: ['minor', 'busway', 'bus_guideway'],
  service: ['service'],
};
const DRAWN_ROADS = Object.values(ROAD_GROUPS).flat();

// Fill widths in px: [zoom, motorway, major, mid, minor, service].
const ROAD_WIDTH = [
  [5, 0.6, 0, 0, 0, 0],
  [7, 1, 0.5, 0, 0, 0],
  [9, 1.4, 1, 0.5, 0, 0],
  [11, 2, 1.5, 1, 0.4, 0],
  [12, 2.4, 1.9, 1.3, 0.7, 0],
  [13, 3, 2.5, 1.8, 1.1, 0.4],
  [14, 4, 3.4, 2.6, 1.7, 0.8],
  [15, 5.6, 4.8, 3.8, 2.7, 1.3],
  [16, 8, 7, 5.6, 4, 2.2],
  [18, 18, 16, 13, 10, 5.5],
  [20, 40, 36, 30, 24, 13],
];
// Casing adds this much on top of the fill, per zoom: [motorway, major, mid,
// minor, service]. Minor and service streets get a casing only from z15, where
// a block of white streets would otherwise melt into the paper.
const CASING_EXTRA = {
  5: [0, 0, 0, 0, 0],
  7: [1, 0, 0, 0, 0],
  9: [1.2, 1, 0, 0, 0],
  11: [1.2, 1.1, 1, 0, 0],
  12: [1.3, 1.2, 1.1, 0, 0],
  13: [1.4, 1.3, 1.2, 0, 0],
  14: [1.5, 1.4, 1.3, 0, 0],
  15: [1.6, 1.5, 1.4, 1.1, 0.9],
  16: [2, 1.8, 1.6, 1.4, 1.1],
  18: [3, 2.8, 2.5, 2.2, 1.6],
  20: [4, 3.6, 3.2, 3, 2.2],
};

const byRoadGroup = (values) => [
  'match', get('class'),
  ROAD_GROUPS.motorway, values[0],
  ROAD_GROUPS.major, values[1],
  ROAD_GROUPS.mid, values[2],
  ROAD_GROUPS.minor, values[3],
  ROAD_GROUPS.service, values[4],
  0,
];

// A ramp draws a step thinner than its road. Driveways and parking aisles draw
// thinner than a service street.
const widthFactor = ['case',
  ['==', get('ramp'), true], 0.6,
  inList('service', ['driveway', 'parking_aisle', 'drive-through']), 0.6,
  1];

const roadWidth = (withCasing) => {
  const expr = ['interpolate', ['exponential', 1.5], ['zoom']];
  ROAD_WIDTH.forEach(([z, ...fill]) => {
    const extra = CASING_EXTRA[z];
    const w = fill.map((f, i) => (withCasing ? (f > 0 ? f + extra[i] : 0) : f));
    expr.push(z, ['*', widthFactor, byRoadGroup(w)]);
  });
  return expr;
};

const roadMatch = (motorway, major, mid, minor) => [
  'match', get('class'),
  ROAD_GROUPS.motorway, motorway,
  ROAD_GROUPS.major, major,
  ROAD_GROUPS.mid, mid,
  minor,
];

const roadColor = (P, casing) => {
  if (casing) return roadMatch(P.motorwayCasing, P.majorCasing, P.midCasing, P.minorCasing);
  const base = roadMatch(P.motorway, P.major, P.mid, P.minor);
  const lift = P.streetLift;
  if (!lift) return base;
  return ['interpolate', ['linear'], ['zoom'],
    14.5, base,
    16, roadMatch(lift.motorway, lift.major, lift.mid, lift.minor)];
};

// Higher classes draw over lower ones where they cross.
const roadSortKey = ['match', get('class'),
  ROAD_GROUPS.motorway, 5, ROAD_GROUPS.major, 4, ROAD_GROUPS.mid, 3, ROAD_GROUPS.minor, 2, 1];

const roadFilter = (extra) => ['all', isLine, inList('class', DRAWN_ROADS), notConstruction, extra];

const roadLayers = (P) => {
  const lineLayout = { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': roadSortKey };
  return [
    {
      id: 'flock-road-tunnel-casing',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'road',
      minzoom: 12,
      filter: roadFilter(brunnelIs('tunnel')),
      layout: { 'line-join': 'round' },
      paint: { 'line-color': roadColor(P, true), 'line-width': roadWidth(true), 'line-dasharray': [0.6, 0.4], 'line-opacity': 0.7 },
    },
    {
      id: 'flock-road-tunnel',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'road',
      minzoom: 12,
      filter: roadFilter(brunnelIs('tunnel')),
      layout: lineLayout,
      paint: { 'line-color': roadColor(P, false), 'line-width': roadWidth(false), 'line-opacity': 0.5 },
    },
    {
      id: 'flock-path',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'pathway',
      minzoom: 14,
      filter: ['all', isLine, notIn('class', ['corridor', 'platform']), ['!=', get('indoor'), true], notConstruction,
        ['step', ['zoom'], inList('class', ['pedestrian', 'track']), 15, true]],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': P.path,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 14, 0.6, 16, 1.2, 18, 2.4, 20, 4],
        'line-dasharray': [1.5, 1],
      },
    },
    {
      id: 'flock-road-casing',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'road',
      minzoom: 5,
      filter: roadFilter(onGround),
      layout: lineLayout,
      paint: { 'line-color': roadColor(P, true), 'line-width': roadWidth(true) },
    },
    {
      id: 'flock-road',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'road',
      minzoom: 5,
      filter: roadFilter(onGround),
      layout: lineLayout,
      paint: { 'line-color': roadColor(P, false), 'line-width': roadWidth(false) },
    },
    {
      id: 'flock-aeroway',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'aviation_line',
      minzoom: 11,
      filter: isLine,
      paint: {
        'line-color': P.mid,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 1, 14, 6, 17, 24],
      },
    },
    {
      id: 'flock-rail',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'railway',
      minzoom: 9,
      filter: ['all', isLine, notIn('class', ['abandoned', 'disused', 'preserved', 'miniature', 'roller_coaster', 'turntable']),
        ['!=', get('brunnel'), 'tunnel'], notConstruction,
        ['step', ['zoom'], ['all', ['==', get('class'), 'rail'], ['!', ['has', 'service']]], 14, true]],
      paint: {
        'line-color': P.rail,
        'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 9, 0.6, 14, 1.2, 18, 2.4],
      },
    },
    {
      id: 'flock-rail-hatch',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'railway',
      minzoom: 14,
      filter: ['all', isLine, inList('class', ['rail', 'narrow_gauge', 'light_rail']), ['!=', get('brunnel'), 'tunnel'], notConstruction],
      paint: {
        'line-color': P.rail,
        'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 14, 4, 18, 8],
        'line-dasharray': [0.2, 8],
      },
    },
    {
      id: 'flock-road-bridge-casing',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'road',
      minzoom: 12,
      filter: roadFilter(brunnelIs('bridge')),
      layout: lineLayout,
      paint: { 'line-color': ['match', get('class'), ROAD_GROUPS.motorway, P.motorwayCasing, P.bridgeCasing], 'line-width': roadWidth(true) },
    },
    {
      id: 'flock-road-bridge',
      type: 'line',
      source: 'maptiler_planet',
      'source-layer': 'road',
      minzoom: 12,
      filter: roadFilter(brunnelIs('bridge')),
      layout: lineLayout,
      paint: { 'line-color': roadColor(P, false), 'line-width': roadWidth(false) },
    },
  ];
};

// --- ground -----------------------------------------------------------------

const fill = (id, sourceLayer, color, extra = {}) => ({
  id,
  type: 'fill',
  source: 'maptiler_planet',
  'source-layer': sourceLayer,
  ...extra,
  paint: { 'fill-color': color, ...(extra.paint || {}) },
});

const groundLayers = (P) => [
  { id: 'flock-background', type: 'background', paint: { 'background-color': P.land } },
  fill('flock-farmland', 'farmland', P.farmland),
  fill('flock-vegetation', 'vegetation', P.scrub, { maxzoom: 9 }),
  fill('flock-scrub', 'scrub', P.scrub, { maxzoom: 9 }),
  fill('flock-forest', 'forest', P.wood, { maxzoom: 9 }),
  fill('flock-wood', 'wood', P.wood),
  fill('flock-residential', 'residential', P.residential, {
    paint: { 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 10, 1] },
  }),
  fill('flock-commercial', 'commercial', P.commercial, { minzoom: 9 }),
  fill('flock-industrial', 'industrial', P.commercial, { minzoom: 9 }),
  fill('flock-cemetery', 'cemetery', P.cemetery, { minzoom: 10 }),
  fill('flock-school', 'education', P.school, { minzoom: 10 }),
  fill('flock-hospital', 'hospital', P.hospital, { minzoom: 10 }),
  fill('flock-airport', 'aviation', P.airport, { minzoom: 9, filter: isPolygon }),
  fill('flock-grass', 'grass', P.park),
  fill('flock-leisure', 'leisure', P.park, { minzoom: 10, filter: notIn('class', ['track', 'winter_sports']) }),
  fill('flock-wetland', 'wetland', P.scrub, { minzoom: 7 }),
  fill('flock-sand', 'sand', P.sand, { minzoom: 7 }),
  fill('flock-ice', 'ice', P.ice),
  fill('flock-pedestrian', 'pedestrian', P.pedestrian, { minzoom: 13, filter: isPolygon }),
  fill('flock-water', 'water', ['case', ['==', get('intermittent'), true], P.waterIntermittent, P.water], {
    filter: ['all', isPolygon, ['!=', get('covered'), true]],
  }),
  {
    id: 'flock-waterway',
    type: 'line',
    source: 'maptiler_planet',
    'source-layer': 'waterway',
    minzoom: 9,
    filter: ['all', isLine, ['!=', get('brunnel'), 'tunnel'],
      ['step', ['zoom'], inList('class', ['river', 'canal']), 13, true]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['==', get('intermittent'), true], P.waterIntermittent, P.water],
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'],
        9, ['match', get('class'), 'river', 1, 0.5],
        14, ['match', get('class'), ['river', 'canal'], 3, 1],
        18, ['match', get('class'), ['river', 'canal'], 12, 3]],
    },
  },
  {
    id: 'flock-ferry',
    type: 'line',
    source: 'maptiler_planet',
    'source-layer': 'ferry',
    minzoom: 10,
    paint: { 'line-color': P.ferry, 'line-width': 1, 'line-dasharray': [3, 2] },
  },
  fill('flock-pier', 'pier', P.pier, { minzoom: 13, filter: isPolygon }),
  fill('flock-bridge-area', 'bridge', P.bridge, { minzoom: 13, filter: isPolygon }),
  fill('flock-building', 'building', P.building, {
    // From z14: below that a city's footprints read as noise, not blocks.
    minzoom: 14,
    filter: ['!=', get('underground'), true],
    paint: { 'fill-outline-color': P.buildingOutline, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 15, 1] },
  }),
];

const borderLayers = (P) => [
  {
    id: 'flock-border-state',
    type: 'line',
    source: 'maptiler_planet',
    'source-layer': 'sub_border',
    minzoom: 3,
    filter: ['all', ['==', get('admin_level'), 40], ['!=', get('maritime'), true]],
    layout: { 'line-join': 'round' },
    paint: { 'line-color': P.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 10, 1.2], 'line-dasharray': [3, 2] },
  },
  {
    id: 'flock-border-country',
    type: 'line',
    source: 'maptiler_planet',
    'source-layer': 'country_border',
    filter: ['!=', get('maritime'), true],
    layout: { 'line-join': 'round' },
    paint: { 'line-color': P.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.8, 10, 2] },
  },
];

const buildingsLayer = (P, dark) => {
  const tint = CROWD_TINT[dark ? 'dark' : 'light'];
  return {
    id: FLOCK_LAYER_IDS.buildings3d,
    type: 'fill-extrusion',
    source: FLOCK_BUILDINGS.source,
    'source-layer': FLOCK_BUILDINGS.sourceLayer,
    minzoom: 14,
    filter: ['!=', get('underground'), true],
    paint: {
      'fill-extrusion-color': ['match', ['feature-state', FLOCK_BUILDINGS.stateKey],
        'green', tint.green,
        'amber', tint.amber,
        'red', tint.red,
        P.building3d],
      // Grows out of the ground between z14 and z15.5 instead of popping up.
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, ['coalesce', get('height'), 8]],
      'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, ['coalesce', get('height_min'), 0]],
      'fill-extrusion-opacity': P.building3dOpacity,
    },
  };
};

// --- labels -----------------------------------------------------------------

const halo = (P) => ({ 'text-halo-color': P.halo, 'text-halo-width': P.haloWidth, 'text-halo-blur': 0 });

// Addition overlays (the heat, the accuracy ring) go in under the first symbol
// layer. This empty one guarantees that is above every road and below every
// label, whatever the label layers below it come to be.
const firstLabelMarker = () => ({
  id: FLOCK_LAYER_IDS.firstLabel,
  type: 'symbol',
  source: 'maptiler_planet',
  'source-layer': 'place_label',
  layout: { visibility: 'none' },
});

const waterLabelLayers = (P) => [
  {
    id: 'flock-water-label-line',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'water_label',
    minzoom: 12,
    filter: ['all', isLine, named, ['step', ['zoom'], inList('class', ['river', 'canal']), 15, true]],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 400,
      'text-field': get('name'),
      'text-font': FLOCK_FONTS.regular,
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 13],
      'text-letter-spacing': 0.1,
      'text-max-angle': 30,
    },
    paint: { 'text-color': P.waterLabel, 'text-halo-color': P.water, 'text-halo-width': 1, 'text-halo-blur': 0 },
  },
  {
    id: 'flock-water-label-point',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'water_centroid',
    minzoom: 1,
    filter: ['all', isPoint, named,
      ['step', ['zoom'], inList('class', ['ocean', 'sea']), 8, notIn('class', ['ditch', 'drain', 'stream']), 14, true]],
    layout: {
      'text-field': ['coalesce', get('name:en'), get('name')],
      'text-font': FLOCK_FONTS.regular,
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, 11, 10, 12, 16, 14],
      'text-letter-spacing': 0.1,
      'text-max-width': 7,
      'symbol-sort-key': ['coalesce', ['to-number', get('rank')], 99],
    },
    paint: { 'text-color': P.waterLabel, 'text-halo-color': P.water, 'text-halo-width': 1, 'text-halo-blur': 0 },
  },
];

const roadLabelLayers = (P) => [
  {
    id: 'flock-road-label',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'road_label',
    minzoom: 12,
    filter: ['all', isLine, named, notConstruction, zoomTiers([
      [12, inList('class', ['motorway', 'trunk', 'primary'])],
      [13, inList('class', ['secondary', 'tertiary'])],
      [14, inList('class', ['minor', 'busway'])],
      [16, ['==', get('class'), 'service']],
    ])],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 300,
      'text-field': get('name'),
      'text-font': FLOCK_FONTS.medium,
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 15, 11.5, 17, 13, 20, 15],
      'text-letter-spacing': 0.02,
      'text-max-angle': 30,
      'text-padding': 2,
    },
    paint: { 'text-color': P.road, 'text-halo-color': P.roadHalo, 'text-halo-width': P.roadHaloWidth, 'text-halo-blur': 0 },
  },
  {
    // US route shields, from the sprite's own shield shapes, recoloured.
    id: 'flock-road-shield',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'road_label',
    minzoom: 9,
    filter: ['all', isLine, ['has', 'ref'], inList('network', ['us-interstate', 'us-highway', 'us-state']),
      inList('class', ['motorway', 'trunk', 'primary']), ['<=', ['coalesce', get('ref_length'), 9], 6]],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 500,
      'symbol-avoid-edges': true,
      'icon-image': ['coalesce',
        ['image', ['concat', get('network'), '_', ['to-string', get('ref_length')]]],
        ['image', ['concat', 'road_', ['to-string', get('ref_length')]]]],
      'icon-rotation-alignment': 'viewport',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 14, 1],
      'text-field': get('ref'),
      'text-font': FLOCK_FONTS.bold,
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 8.5, 14, 10],
      'text-rotation-alignment': 'viewport',
      'text-offset': [0, 0.05],
    },
    paint: {
      'icon-color': P.shield,
      'icon-halo-color': P.shieldEdge,
      'icon-halo-width': 1,
      'text-color': P.shieldText,
    },
  },
];

const placeLabelLayers = (P) => [
  {
    id: 'flock-place-neighbourhood',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'place_label',
    minzoom: 12,
    filter: ['all', isPoint, named, zoomTiers([
      [12, inList('class', ['suburb', 'quarter'])],
      [13, ['==', get('class'), 'neighbourhood']],
    ])],
    layout: {
      'text-field': get('name'),
      'text-font': FLOCK_FONTS.medium,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.08,
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 11, 16, 12.5],
      'text-max-width': 7,
      'text-padding': 4,
      'symbol-sort-key': ['coalesce', ['to-number', get('rank')], 99],
    },
    paint: { 'text-color': P.neighbourhood, ...halo(P) },
  },
  {
    id: 'flock-place-village',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'place_label',
    minzoom: 11,
    filter: ['all', isPoint, named, zoomTiers([
      [11, ['==', get('class'), 'village']],
      [14, inList('class', ['hamlet', 'isolated_dwelling'])],
    ])],
    layout: {
      'text-field': ['coalesce', get('name:en'), get('name')],
      'text-font': FLOCK_FONTS.medium,
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 16, 13],
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['to-number', get('rank')], 99],
    },
    paint: { 'text-color': P.town, ...halo(P) },
  },
  {
    id: 'flock-town-label',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'town_label',
    minzoom: 7,
    maxzoom: 15,
    filter: ['all', isPoint, named],
    layout: {
      'text-field': ['coalesce', get('name:en'), get('name')],
      'text-font': FLOCK_FONTS.medium,
      'text-size': ['interpolate', ['linear'], ['zoom'],
        7, ['case', ['<=', ['coalesce', ['to-number', get('rank')], 99], 4], 11, 10],
        11, ['case', ['<=', ['coalesce', ['to-number', get('rank')], 99], 4], 14, 12.5],
        14, ['case', ['<=', ['coalesce', ['to-number', get('rank')], 99], 4], 17, 15]],
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['to-number', get('rank')], 99],
    },
    paint: { 'text-color': P.town, ...halo(P) },
  },
  {
    id: 'flock-city-label',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'city_label',
    minzoom: 4,
    maxzoom: 15,
    filter: ['all', isPoint, named],
    layout: {
      'text-field': ['coalesce', get('name:en'), get('name')],
      'text-font': FLOCK_FONTS.bold,
      'text-size': ['interpolate', ['linear'], ['zoom'],
        4, ['case', ['<=', ['coalesce', ['to-number', get('rank')], 99], 2], 13, 11],
        8, ['case', ['<=', ['coalesce', ['to-number', get('rank')], 99], 2], 17, 14],
        12, ['case', ['<=', ['coalesce', ['to-number', get('rank')], 99], 4], 19, 16],
        14, ['case', ['<=', ['coalesce', ['to-number', get('rank')], 99], 4], 21, 17]],
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['to-number', get('rank')], 99],
    },
    paint: { 'text-color': P.city, ...halo(P) },
  },
  {
    id: 'flock-state-label',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'state_label',
    minzoom: 4,
    maxzoom: 9,
    filter: ['all', isPoint, named],
    layout: {
      'text-field': ['step', ['zoom'], ['coalesce', get('abbrev'), get('name')], 6, ['coalesce', get('name:en'), get('name')]],
      'text-font': FLOCK_FONTS.medium,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.12,
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 12],
      'text-max-width': 8,
    },
    paint: { 'text-color': P.neighbourhood, ...halo(P) },
  },
  {
    id: 'flock-country-label',
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': 'country_label',
    minzoom: 1,
    maxzoom: 7,
    filter: ['all', isPoint, named],
    layout: {
      'text-field': ['coalesce', get('name:en'), get('name')],
      'text-font': FLOCK_FONTS.medium,
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 6, 14],
      'text-max-width': 7,
      'symbol-sort-key': ['coalesce', ['to-number', get('rank')], 99],
    },
    paint: { 'text-color': P.town, ...halo(P) },
  },
];

// --- POIs -------------------------------------------------------------------

// One POI layer. `tiers` is [[zoom, condition], ...]: what appears at each zoom
// step, most important first. Names follow `nameLag` steps after their icons.
const poiLayer = (P, dark, { id, sourceLayer, category, tiers, iconImage, base = true, nameLag = 1, minzoom }) => {
  const color = poiColor(category, dark);
  const first = tiers[0][0];
  return {
    id,
    type: 'symbol',
    source: 'maptiler_planet',
    'source-layer': sourceLayer,
    minzoom: minzoom ?? first,
    filter: ['all', isPoint, named, base, zoomTiers(tiers)],
    layout: {
      'icon-image': iconImage,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 17, 1],
      'icon-padding': 1,
      'text-field': tieredName(tiers, nameLag),
      'text-font': FLOCK_FONTS.medium,
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 16, 12, 18, 13],
      'text-anchor': 'top',
      'text-offset': [0, 0.85],
      'text-max-width': 8,
      'text-padding': 2,
      'text-optional': true,
      'symbol-sort-key': tierRank(tiers),
    },
    paint: {
      'icon-color': color,
      'icon-halo-color': P.halo,
      'icon-halo-width': 1.5,
      // The first tier eases in over half a zoom step rather than switching on.
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], first, 0.55, first + 0.5, 1],
      'text-color': color,
      ...halo(P),
    },
  };
};

const FOOD_ICON = ['match', get('class'),
  ['bar', 'cafe', 'fast_food', 'ice_cream', 'restaurant'], get('class'),
  ['pub', 'biergarten'], 'beer',
  'restaurant'];

const poiLayers = (P, dark) => {
  const sub = (values) => inList('subclass', values);
  const cls = (values) => inList('class', values);
  const L = (spec) => poiLayer(P, dark, spec);
  // Bottom of the list is placed LAST, so the least important layers go first.
  return [
    L({
      id: 'flock-poi-transport',
      sourceLayer: 'poi_transport',
      category: 'transport',
      base: notIn('subclass', ['parking_space', 'parking_entrance', 'bicycle_parking', 'motorcycle_parking', 'vacuum_cleaner', 'compressed_air']),
      tiers: [
        [15, sub(['fuel', 'charging_station'])],
        [16, sub(['parking', 'bicycle_rental', 'car_rental', 'car_sharing', 'taxi'])],
        [17, true],
      ],
      iconImage: ['coalesce', ['image', get('subclass')], ['image', get('class')], ['image', 'dot']],
    }),
    L({
      id: 'flock-poi-public',
      sourceLayer: 'poi_public',
      category: 'public',
      base: ['all', notHidden, notIn('class', ['adult']),
        notIn('subclass', ['park', 'events_venue', 'dance', 'escape_game', 'amusement_arcade',
          'post_box', 'parcel_locker', 'dressing_room', 'hot_tub', 'smoking_area', 'shelter', 'bbq'])],
      tiers: [
        [15, sub(['townhall', 'courthouse', 'marketplace', 'square'])],
        [16, sub(['post_office', 'bank', 'police', 'fire_station', 'social_centre', 'swimming_pool', 'dog_park', 'recreation_ground'])],
        [17, true],
      ],
      iconImage: ['match', get('subclass'),
        'townhall', 'town_hall',
        ['marketplace', 'square'], 'shop',
        ['coalesce', ['image', get('subclass')], ['image', get('class')], ['image', 'dot']]],
    }),
    L({
      id: 'flock-poi-healthcare',
      sourceLayer: 'poi_healthcare',
      category: 'healthcare',
      tiers: [
        [14, cls(['hospital'])],
        [15, cls(['pharmacy'])],
        [16, cls(['clinic', 'doctors', 'dentist'])],
        [17, true],
      ],
      iconImage: ['coalesce', ['image', get('class')], ['image', 'hospital']],
    }),
    L({
      id: 'flock-poi-education',
      sourceLayer: 'poi_education',
      category: 'education',
      tiers: [
        [14, cls(['university', 'college'])],
        [15, cls(['school'])],
        [16, true],
      ],
      iconImage: ['coalesce', ['image', get('class')], ['image', 'school']],
    }),
    L({
      id: 'flock-poi-sport',
      sourceLayer: 'poi_sport',
      category: 'sport',
      tiers: [[15, true]],
      iconImage: ['coalesce', ['image', get('class')], ['image', 'sports']],
    }),
    L({
      id: 'flock-poi-accommodation',
      sourceLayer: 'poi_accommodation',
      category: 'tourism',
      tiers: [
        [15, cls(['hotel', 'motel'])],
        [16, true],
      ],
      iconImage: ['coalesce', ['image', get('class')], ['image', 'lodging']],
    }),
    L({
      id: 'flock-poi-tourism',
      sourceLayer: 'poi_tourism',
      category: 'tourism',
      base: notIn('class', ['adit', 'mine_shaft', 'mineshaft', 'water_tower', 'water_well', 'communications_tower', 'telescope']),
      tiers: [
        [14, cls(['attraction', 'zoo', 'theme_park', 'aquarium'])],
        [15, cls(['viewpoint', 'castle', 'memorial', 'lighthouse', 'information'])],
        [16, true],
      ],
      iconImage: ['coalesce', ['image', get('class')], ['image', 'attraction']],
    }),
    L({
      id: 'flock-poi-culture',
      sourceLayer: 'poi_culture',
      category: 'culture',
      tiers: [
        [13, cls(['cinema', 'theatre', 'museum'])],
        [14, cls(['gallery', 'arts_centre', 'library', 'exhibition_centre', 'planetarium', 'studio'])],
        [15, cls(['place_of_worship', 'monastery', 'community_centre', 'monument'])],
        [16, true],
      ],
      // Places of worship show their tradition's own glyph where the sprite has
      // one; everything else shows its class.
      iconImage: ['match', get('class'),
        ['place_of_worship', 'monastery'], ['coalesce', ['image', get('subclass')], ['image', get('class')], ['image', 'place_of_worship']],
        ['coalesce', ['image', get('class')], ['image', 'landmark']]],
    }),
    L({
      id: 'flock-poi-shopping',
      sourceLayer: 'poi_shopping',
      category: 'shopping',
      base: ['all', notHidden, notIn('subclass', ['vending_machine', 'trolley_bay', 'vacant'])],
      tiers: [
        [14, sub(['department_store', 'mall', 'shopping_centre', 'supermarket'])],
        [15, cls(['foods', 'books', 'clothes', 'beauty', 'electronics', 'arts', 'discount'])],
        [16, cls(['household', 'interior', 'mixture', 'outdoors', 'vehicles'])],
        [17, true],
      ],
      iconImage: ['coalesce', ['image', get('subclass')], ['image', get('class')], ['image', 'shop']],
    }),
    L({
      id: 'flock-poi-park',
      sourceLayer: 'poi_public',
      category: 'park',
      tiers: [[14, sub(['park'])]],
      nameLag: 0,
      iconImage: 'park',
    }),
    L({
      id: 'flock-poi-food',
      sourceLayer: 'poi_food',
      category: 'food',
      tiers: [
        [15, cls(['bar', 'pub', 'biergarten', 'restaurant', 'cafe'])],
        [16, true],
      ],
      // A restaurant or a takeaway shows its cuisine where the sprite draws it
      // (pizza, burger, sushi...); everything else shows its class.
      iconImage: ['case',
        cls(['restaurant', 'fast_food']), ['coalesce', ['image', get('cuisine')], ['image', FOOD_ICON]],
        ['image', FOOD_ICON]],
    }),
    L({
      id: 'flock-poi-nightlife',
      sourceLayer: 'poi_public',
      category: 'nightlife',
      base: notHidden,
      tiers: [
        [14, sub(['nightclub', 'casino', 'events_venue'])],
        [15, sub(['dance', 'escape_game', 'amusement_arcade'])],
      ],
      iconImage: ['match', get('subclass'),
        'nightclub', 'nightclub',
        'casino', 'casino',
        'events_venue', 'ticket',
        'dance', 'music',
        'video_games'],
    }),
    L({
      id: 'flock-poi-station',
      sourceLayer: 'poi_station',
      category: 'station',
      nameLag: 0,
      base: notIn('class', ['aeroway', 'landingpad', 'launch_complex', 'spaceport']),
      minzoom: 9,
      tiers: [
        [9, ['all', cls(['aerodrome']), sub(['international', 'regional', 'public'])]],
        [12, ['all', cls(['railway']), sub(['station', 'halt'])]],
        [13, ['any', sub(['subway', 'ferry_terminal']), cls(['aerialway'])]],
        [14, sub(['bus_station'])],
        [15, sub(['tram_stop'])],
        [17, sub(['bus_stop', 'subway_entrance', 'train_station_entrance'])],
      ],
      iconImage: ['match', get('subclass'),
        ['station', 'halt'], 'railway',
        'subway', 'subway',
        'tram_stop', 'tram_stop',
        ['bus_station', 'bus_stop'], 'bus_stop',
        'ferry_terminal', 'ferry_terminal',
        ['subway_entrance', 'train_station_entrance'], 'entrance',
        ['match', get('class'), 'aerodrome', 'airport', 'aerialway', 'aerialway', 'transit']],
    }),
  ];
};

// --- the style --------------------------------------------------------------

const withKey = (url, key) => `${url}?key=${encodeURIComponent(key)}`;

export function buildFlockStyle({ dark = false, key } = {}) {
  if (!key) return null;
  const P = paletteFor(dark);
  return {
    version: 8,
    name: dark ? 'Flock Night' : 'Flock Paper',
    metadata: { 'flock:styleVersion': FLOCK_STYLE_VERSION, 'flock:theme': dark ? 'dark' : 'light' },
    sources: {
      maptiler_planet: {
        type: 'vector',
        url: withKey(`${MAPTILER}/tiles/v4/tiles.json`, key),
        attribution: FLOCK_ATTRIBUTION,
      },
      maptiler_buildings: {
        type: 'vector',
        url: withKey(`${MAPTILER}/tiles/buildings/tiles.json`, key),
        attribution: FLOCK_ATTRIBUTION,
      },
    },
    glyphs: withKey(`${MAPTILER}/fonts/{fontstack}/{range}.pbf`, key),
    sprite: SPRITE_URL,
    // The engine's default light (intensity 0.5) brightens a roof well past its
    // own colour: on the night map that lifted the blocks above the streets
    // and turned the grid inside out. A softer light keeps a roof close to the
    // palette value and still shades the walls when the map is tilted.
    light: { anchor: 'viewport', color: '#ffffff', intensity: P.lightIntensity, position: [1.15, 210, 30] },
    layers: [
      ...groundLayers(P),
      ...roadLayers(P),
      ...borderLayers(P),
      buildingsLayer(P, dark),
      firstLabelMarker(),
      ...waterLabelLayers(P),
      ...poiLayers(P, dark),
      ...roadLabelLayers(P),
      ...placeLabelLayers(P),
    ],
  };
}

// Satellite imagery cannot be recoloured, but v4 hybrid has a dark twin whose
// labels sit right on the night map.
export function satelliteStyleUrl({ dark = false, key } = {}) {
  if (!key) return null;
  return withKey(`${MAPTILER}/maps/hybrid-v4${dark ? '-dark' : ''}/style.json`, key);
}
