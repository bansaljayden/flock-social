/**
 * "Flock Paper" and "Flock Night", the Discover basemap (components/map/flockStyle).
 *
 * What this pins, and why each one matters:
 * - the two themes share every layer id and every source, so a light/dark
 *   setStyle only repaints and keeps the tiles it already has;
 * - the empty `flock-first-label` layer sits above every road and below every
 *   label, because the app inserts the crowd heat and the accuracy ring under
 *   the first symbol layer;
 * - exactly one extrusion, on the MapTiler Buildings source, whose colour reads
 *   the `crowdBand` feature state (two stacked extrusions z-fight);
 * - the adult subclasses Planet v4 files next to nightclubs are filtered out,
 *   and nightclubs stay (the app has users from 13);
 * - house numbers, one-way arrows and exit numbers are gone, and POIs fill in
 *   tier by tier as the map zooms in rather than all at once;
 * - every label colour clears 4.5:1 on its ground and every icon 3:1, with the
 *   same WCAG arithmetic the palette was designed with, and no colour is purple;
 * - only fonts MapTiler really hosts are named;
 * - the key appears nowhere but inside `?key=` values, and no key means no style.
 *
 * Nothing here touches the network: the style is a plain object.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern flockStyle
 */

const {
  buildFlockStyle,
  satelliteStyleUrl,
  FLOCK_LAYER_IDS,
  FLOCK_BUILDINGS,
  FLOCK_STYLE_VERSION,
  HIDDEN_POI_SUBCLASSES,
  LIGHT,
  DARK,
  POI,
  CROWD_TINT,
} = require('../components/map/flockStyle');

const KEY = 'test_key_123';
const light = buildFlockStyle({ dark: false, key: KEY });
const dark = buildFlockStyle({ dark: true, key: KEY });
const THEMES = [['light', light, LIGHT], ['dark', dark, DARK]];

// --- WCAG 2.x contrast, the same arithmetic as the palette's design sheet ----
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hueSat = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [(h + 360) % 360, s];
};

// --- a small evaluator for the expression subset the style uses --------------
// Enough to ask "would this feature be drawn by this layer at this zoom?"
// without a browser. It throws on anything it does not know, so a new operator
// in the style fails loudly here rather than evaluating to a quiet false.
const evaluate = (expr, f, zoom) => {
  if (!Array.isArray(expr)) return expr;
  const [op, ...a] = expr;
  const ev = (e) => evaluate(e, f, zoom);
  switch (op) {
    case 'get': return f.properties[a[0]] === undefined ? null : f.properties[a[0]];
    case 'has': return f.properties[a[0]] !== undefined;
    case 'geometry-type': return f.type;
    case 'zoom': return zoom;
    case 'all': return a.every((e) => ev(e) === true);
    case 'any': return a.some((e) => ev(e) === true);
    case '!': return !ev(a[0]);
    case '==': return ev(a[0]) === ev(a[1]);
    case '!=': return ev(a[0]) !== ev(a[1]);
    case '<=': return ev(a[0]) <= ev(a[1]);
    case 'to-number': { const n = Number(ev(a[0])); return Number.isFinite(n) ? n : 0; }
    case 'coalesce': { for (const e of a) { const v = ev(e); if (v !== null && v !== undefined) return v; } return null; }
    case 'case': {
      for (let i = 0; i < a.length - 1; i += 2) if (ev(a[i]) === true) return ev(a[i + 1]);
      return ev(a[a.length - 1]);
    }
    case 'match': {
      const input = ev(a[0]);
      for (let i = 1; i < a.length - 1; i += 2) {
        const labels = Array.isArray(a[i]) ? a[i] : [a[i]];
        if (labels.includes(input)) return ev(a[i + 1]);
      }
      return ev(a[a.length - 1]);
    }
    case 'step': {
      let out = ev(a[1]);
      for (let i = 2; i < a.length; i += 2) if (ev(a[0]) >= a[i]) out = ev(a[i + 1]);
      return out;
    }
    default: throw new Error(`evaluator does not know '${op}'`);
  }
};
const drawnBy = (style, sourceLayer, properties, zoom) => style.layers.filter((l) => (
  l['source-layer'] === sourceLayer
  && (l.minzoom ?? 0) <= zoom && zoom < (l.maxzoom ?? 24)
  && (l.layout || {}).visibility !== 'none'
  && (!l.filter || evaluate(l.filter, { type: 'Point', properties }, zoom) === true)
)).map((l) => l.id);
// The name a POI layer prints at a zoom ('' while names still lag the icon).
const nameAt = (layer, properties, zoom) => evaluate(layer.layout['text-field'], { type: 'Point', properties }, zoom);

const layer = (style, id) => style.layers.find((l) => l.id === id);
const symbolIndexes = (style) => style.layers.map((l, i) => (l.type === 'symbol' ? i : -1)).filter((i) => i >= 0);

describe('the contract other code builds on', () => {
  test('exports the agreed names and values', () => {
    expect(FLOCK_LAYER_IDS).toEqual({ buildings3d: 'flock-3d-buildings', firstLabel: 'flock-first-label' });
    expect(FLOCK_BUILDINGS).toEqual({ source: 'maptiler_buildings', sourceLayer: 'building', stateKey: 'crowdBand' });
    expect(FLOCK_STYLE_VERSION).toBe(1);
    expect(light.metadata['flock:styleVersion']).toBe(FLOCK_STYLE_VERSION);
    expect(light.name).toBe('Flock Paper');
    expect(dark.name).toBe('Flock Night');
    expect(light.version).toBe(8);
  });

  test('no key means no style and no satellite, so the keyless fallback can take over', () => {
    expect(buildFlockStyle({ dark: false, key: undefined })).toBeNull();
    expect(buildFlockStyle({ dark: true, key: '' })).toBeNull();
    expect(buildFlockStyle()).toBeNull();
    expect(satelliteStyleUrl({ dark: false, key: undefined })).toBeNull();
    expect(satelliteStyleUrl({ dark: true, key: '' })).toBeNull();
  });

  test('satellite is v4 hybrid, with its dark twin at night', () => {
    expect(satelliteStyleUrl({ dark: false, key: KEY })).toBe(`https://api.maptiler.com/maps/hybrid-v4/style.json?key=${KEY}`);
    expect(satelliteStyleUrl({ dark: true, key: KEY })).toBe(`https://api.maptiler.com/maps/hybrid-v4-dark/style.json?key=${KEY}`);
  });
});

describe('a theme swap only repaints', () => {
  test('light and dark have the same layer ids, in the same order', () => {
    expect(dark.layers.map((l) => l.id)).toEqual(light.layers.map((l) => l.id));
  });

  test('light and dark share source ids and URLs, glyphs and sprite', () => {
    expect(dark.sources).toEqual(light.sources);
    expect(Object.keys(light.sources).sort()).toEqual(['maptiler_buildings', 'maptiler_planet']);
    expect(light.sources.maptiler_planet.url).toBe(`https://api.maptiler.com/tiles/v4/tiles.json?key=${KEY}`);
    expect(light.sources.maptiler_buildings.url).toBe(`https://api.maptiler.com/tiles/buildings/tiles.json?key=${KEY}`);
    expect(dark.glyphs).toBe(light.glyphs);
    expect(dark.sprite).toBe(light.sprite);
  });

  test('every layer id is unique and is Flock\'s own', () => {
    const ids = light.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^flock-[a-z0-9-]+$/);
  });

  test('every layer reads a source the style declares, or none (the background)', () => {
    for (const l of light.layers) {
      if (l.type === 'background') continue;
      expect([l.id, Object.keys(light.sources).includes(l.source)]).toEqual([l.id, true]);
    }
  });
});

describe('layer order', () => {
  test.each(THEMES)('%s: flock-first-label is the first symbol layer and sits above every road', (name, style) => {
    const ids = style.layers.map((l) => l.id);
    const marker = ids.indexOf(FLOCK_LAYER_IDS.firstLabel);
    expect(marker).toBeGreaterThan(0);
    expect(symbolIndexes(style)[0]).toBe(marker);
    expect(layer(style, FLOCK_LAYER_IDS.firstLabel).layout.visibility).toBe('none');
    const lastRoad = Math.max(...style.layers
      .map((l, i) => (['road', 'pathway', 'railway', 'bridge'].includes(l['source-layer']) && l.type !== 'symbol' ? i : -1)));
    expect(lastRoad).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(lastRoad);
  });

  test.each(THEMES)('%s: place names sit above the POIs, so a street or neighbourhood name is placed first', (name, style) => {
    const ids = style.layers.map((l) => l.id);
    const lastPoi = Math.max(...ids.map((id, i) => (id.startsWith('flock-poi-') ? i : -1)));
    expect(ids.indexOf('flock-road-label')).toBeGreaterThan(lastPoi);
    expect(ids.indexOf('flock-place-neighbourhood')).toBeGreaterThan(lastPoi);
    expect(ids.indexOf('flock-city-label')).toBeGreaterThan(lastPoi);
  });
});

describe('3D buildings', () => {
  test.each(THEMES)('%s: exactly one extrusion, on MapTiler Buildings, from z14', (name, style, P) => {
    const ext = style.layers.filter((l) => l.type === 'fill-extrusion');
    expect(ext).toHaveLength(1);
    const [b] = ext;
    expect(b.id).toBe(FLOCK_LAYER_IDS.buildings3d);
    expect(b.source).toBe(FLOCK_BUILDINGS.source);
    expect(b['source-layer']).toBe(FLOCK_BUILDINGS.sourceLayer);
    expect(b.minzoom).toBe(14);
    expect(JSON.stringify(b.paint['fill-extrusion-base'])).toContain('"height_min"');
    expect(JSON.stringify(b.paint['fill-extrusion-height'])).toContain('"height"');
    expect(b.paint['fill-extrusion-opacity']).toBe(P.building3dOpacity);
  });

  test.each(THEMES)('%s: colour follows the crowdBand state, base colour when unset', (name, style, P) => {
    const tint = CROWD_TINT[name];
    expect(layer(style, FLOCK_LAYER_IDS.buildings3d).paint['fill-extrusion-color']).toEqual([
      'match', ['feature-state', 'crowdBand'],
      'green', tint.green,
      'amber', tint.amber,
      'red', tint.red,
      P.building3d,
    ]);
  });

  test('the brand sheet tints are the ones painted', () => {
    expect(CROWD_TINT.light).toEqual({ green: '#87ca90', amber: '#e6b96a', red: '#e39084' });
    expect(CROWD_TINT.dark).toEqual({ green: '#307a5e', amber: '#806c34', red: '#7e4957' });
    // Light-mode buildings are tan now, not navy: the navy pin on them went
    // from 2.22:1 to 9.45:1.
    expect(contrast('#1e293b', LIGHT.building3d)).toBeCloseTo(9.45, 2);
    // Every tint still separates from its base, and a pin still reads on it.
    for (const t of Object.values(CROWD_TINT.dark)) {
      expect(contrast(t, DARK.building3d)).toBeGreaterThan(2);
      expect(contrast('#f1ede0', t)).toBeGreaterThan(4.3);
    }
  });
});

describe('POIs: kept, densified, and safe for a 13-year-old', () => {
  const PUBLIC_AND_SHOPS = (style) => style.layers.filter((l) => ['poi_public', 'poi_shopping'].includes(l['source-layer']));

  test('the hidden list is the adult venues, gambling and erotic shops, and nothing else', () => {
    expect(HIDDEN_POI_SUBCLASSES.sort()).toEqual(['adult_gaming_centre', 'brothel', 'erotic', 'gambling', 'stripclub']);
  });

  test.each(THEMES)('%s: no adult subclass is drawn at any zoom, a nightclub is', (name, style) => {
    expect(PUBLIC_AND_SHOPS(style).length).toBeGreaterThan(2);
    for (const z of [12, 14, 15, 16, 17, 18, 20]) {
      for (const sub of ['brothel', 'stripclub', 'adult_gaming_centre', 'gambling']) {
        expect([sub, z, drawnBy(style, 'poi_public', { class: 'adult', subclass: sub, name: 'X' }, z)]).toEqual([sub, z, []]);
      }
      expect(['erotic', z, drawnBy(style, 'poi_shopping', { class: 'beauty', subclass: 'erotic', name: 'X' }, z)]).toEqual(['erotic', z, []]);
    }
    const club = { class: 'adult', subclass: 'nightclub', name: 'Voyeur' };
    expect(drawnBy(style, 'poi_public', club, 13)).toEqual([]);
    expect(drawnBy(style, 'poi_public', club, 14)).toEqual(['flock-poi-nightlife']);
    expect(drawnBy(style, 'poi_public', club, 18)).toEqual(['flock-poi-nightlife']);
  });

  test.each(THEMES)('%s: zoomed out stays clean; bars and restaurants fill in from z15, names a step later', (name, style) => {
    const bar = { class: 'bar', name: 'The Rusty Nail' };
    const takeaway = { class: 'fast_food', name: 'Chickie\'s' };
    expect(drawnBy(style, 'poi_food', bar, 14)).toEqual([]);
    expect(drawnBy(style, 'poi_food', bar, 15)).toEqual(['flock-poi-food']);
    expect(drawnBy(style, 'poi_food', takeaway, 15)).toEqual([]);
    expect(drawnBy(style, 'poi_food', takeaway, 16)).toEqual(['flock-poi-food']);
    const food = layer(style, 'flock-poi-food');
    expect(nameAt(food, bar, 15)).toBe('');
    expect(nameAt(food, bar, 16)).toBe('The Rusty Nail');
    expect(nameAt(food, takeaway, 16)).toBe('');
    expect(nameAt(food, takeaway, 17)).toBe('Chickie\'s');
  });

  test.each(THEMES)('%s: big shops first, then everyday shops, then the rest', (name, style) => {
    const at = (sub, cls) => [14, 15, 16, 17].find((z) => drawnBy(style, 'poi_shopping', { class: cls, subclass: sub, name: 'S' }, z).length);
    expect(at('supermarket', 'malls')).toBe(14);
    expect(at('bakery', 'foods')).toBe(15);
    expect(at('furniture', 'interior')).toBe(16);
    expect(at('plumber', 'craft')).toBe(17);
    expect(at('vending_machine', 'mixture')).toBeUndefined();
    // Nothing commercial below street level.
    expect(drawnBy(style, 'poi_shopping', { class: 'malls', subclass: 'mall', name: 'S' }, 13)).toEqual([]);
  });

  test.each(THEMES)('%s: cinemas, theatres and museums lead culture at z13', (name, style) => {
    expect(drawnBy(style, 'poi_culture', { class: 'theatre', subclass: 'theatre', name: 'T' }, 13)).toEqual(['flock-poi-culture']);
    expect(drawnBy(style, 'poi_culture', { class: 'artwork', subclass: 'mural', name: 'M' }, 15)).toEqual([]);
    expect(drawnBy(style, 'poi_culture', { class: 'artwork', subclass: 'mural', name: 'M' }, 16)).toEqual(['flock-poi-culture']);
  });

  test.each(THEMES)('%s: an unnamed POI draws nothing', (name, style) => {
    expect(drawnBy(style, 'poi_food', { class: 'bar' }, 18)).toEqual([]);
    expect(drawnBy(style, 'poi_shopping', { class: 'malls', subclass: 'supermarket' }, 18)).toEqual([]);
  });

  test.each(THEMES)('%s: house numbers, one-way arrows and exit numbers are not drawn', (name, style) => {
    const sourceLayers = style.layers.map((l) => l['source-layer']);
    expect(sourceLayers).not.toContain('building_number');
    expect(sourceLayers).not.toContain('road_exit');
    const json = JSON.stringify(style.layers);
    expect(json).not.toMatch(/"oneway"/);
  });

  test.each(THEMES)('%s: every POI icon and name share one category colour, haloed in the land colour', (name, style, P) => {
    const pois = style.layers.filter((l) => l.id.startsWith('flock-poi-'));
    expect(pois.length).toBeGreaterThanOrEqual(12);
    const allowed = new Set(Object.values(POI).map((c) => c[name]));
    for (const l of pois) {
      expect(l.paint['icon-color']).toBe(l.paint['text-color']);
      expect(allowed.has(l.paint['text-color'])).toBe(true);
      expect(l.paint['text-halo-color']).toBe(P.halo);
      expect(l.paint['text-halo-blur']).toBe(0);
      expect(l.layout['text-optional']).toBe(true);
    }
  });
});

describe('legibility', () => {
  test.each(THEMES)('%s: place and road labels clear 4.5:1 on the ground they print on', (name, style, P) => {
    for (const k of ['city', 'town', 'neighbourhood', 'road']) {
      expect([k, contrast(P[k], P.land) >= 4.5]).toEqual([k, true]);
      expect([k, contrast(P[k], P.residential) >= 4.5]).toEqual([k, true]);
    }
    expect(contrast(P.road, P.roadHalo)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(P.waterLabel, P.water)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(P.shieldText, P.shield)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(THEMES)('%s: every POI colour clears 4.5:1 as text and 3:1 as an icon', (name, style, P) => {
    for (const [cat, c] of Object.entries(POI)) {
      for (const ground of [P.land, P.residential, P.park]) {
        expect([cat, ground, contrast(c[name], ground) >= 4.5]).toEqual([cat, ground, true]);
      }
      expect([cat, contrast(c[name], P.commercial) >= 3]).toEqual([cat, true]);
      expect([cat, contrast(c[name], P.building) >= 3]).toEqual([cat, true]);
    }
  });

  test('the measured numbers match the palette design sheet', () => {
    expect(contrast(LIGHT.city, LIGHT.land)).toBeCloseTo(12.76, 2);
    expect(contrast(LIGHT.town, LIGHT.land)).toBeCloseTo(8.14, 2);
    expect(contrast(LIGHT.neighbourhood, LIGHT.land)).toBeCloseTo(5.14, 2);
    expect(contrast(LIGHT.waterLabel, LIGHT.water)).toBeCloseTo(5.39, 2);
    expect(contrast(POI.food.light, LIGHT.land)).toBeCloseTo(5.73, 2);
    expect(contrast(DARK.city, DARK.land)).toBeCloseTo(15.99, 2);
    expect(contrast(DARK.town, DARK.land)).toBeCloseTo(10.61, 2);
    expect(contrast(DARK.neighbourhood, DARK.land)).toBeCloseTo(7.58, 2);
    expect(contrast(DARK.road, DARK.land)).toBeCloseTo(6.08, 2);
    expect(contrast(DARK.waterLabel, DARK.water)).toBeCloseTo(5.1, 2);
    expect(contrast(POI.food.dark, DARK.land)).toBeCloseTo(9.56, 2);
  });

  test.each(THEMES)('%s: the night map keeps its streets lighter than its roofs', (name, style, P) => {
    if (!P.streetLift) return;
    for (const c of Object.values(P.streetLift)) expect(lum(c)).toBeGreaterThan(lum(P.building3d));
    expect(lum(P.minor)).toBeGreaterThan(lum(P.building3d));
  });

  test.each(THEMES)('%s: no colour anywhere in the style is purple', (name, style) => {
    const hexes = JSON.stringify(style).match(/#[0-9a-fA-F]{6}\b/g) || [];
    expect(hexes.length).toBeGreaterThan(40);
    for (const h of hexes) {
      const [hue, sat] = hueSat(h.toLowerCase());
      if (sat < 0.08) continue; // greys and near-greys carry no hue
      expect([h, hue >= 260 && hue <= 300]).toEqual([h, false]);
    }
  });

  test.each(THEMES)('%s: only fonts MapTiler hosts with real glyphs are named', (name, style) => {
    const allowed = new Set(['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Bold']);
    const stacks = style.layers.filter((l) => l.layout && l.layout['text-font']).map((l) => l.layout['text-font']);
    expect(stacks.length).toBeGreaterThan(10);
    for (const s of stacks) for (const f of s) expect(allowed.has(f)).toBe(true);
  });
});

describe('key and licence', () => {
  test.each(THEMES)('%s: the key appears only inside ?key= values', (name, style) => {
    const json = JSON.stringify(style);
    const hits = json.split(KEY).length - 1;
    expect(hits).toBe(3); // planet TileJSON, buildings TileJSON, glyphs
    expect(json.split(`?key=${KEY}`).length - 1).toBe(hits);
    expect(style.sprite).not.toContain('key');
  });

  test('a key with URL-special characters is encoded, not spliced raw', () => {
    const s = buildFlockStyle({ dark: false, key: 'a&b=c' });
    expect(s.glyphs).toContain('?key=a%26b%3Dc');
  });

  test.each(THEMES)('%s: both sources carry the required MapTiler and OpenStreetMap credit', (name, style) => {
    for (const src of Object.values(style.sources)) {
      expect(src.attribution).toContain('© MapTiler');
      expect(src.attribution).toContain('© OpenStreetMap contributors');
      expect(src.attribution).toContain('https://www.maptiler.com/copyright/');
      expect(src.attribution).toContain('https://www.openstreetmap.org/copyright');
    }
  });

  test('every host the style names is MapTiler\'s', () => {
    const hosts = new Set((JSON.stringify(light).match(/https:\/\/[a-z0-9.-]+/g) || []));
    expect([...hosts].sort()).toEqual(['https://api.maptiler.com', 'https://www.maptiler.com', 'https://www.openstreetmap.org']);
  });
});
