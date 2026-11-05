/**
 * A RELEASE NEVER REQUESTS CARTO'S KEYLESS BASEMAP TILES.
 *
 * Since 2026-09-29 CARTO's basemap terms want a CARTO-issued key for every
 * use. The map used to fall back to CARTO's keyless styles whenever a build
 * had no MapTiler key, a release included, and codemagic.yaml lists that key
 * among the variables whose absence still ships a build. Now the fallback is
 * for development builds only (components/map/keylessBasemap.js): a release
 * without a MapTiler key builds no map, fetches no engine and no tile, and
 * shows the could-not-load panel; the landing demo shows its list.
 *
 * keylessBasemapDev.test.js holds the other half: a development build with no
 * key still draws the map on CARTO.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test keylessBasemapRelease --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, waitFor } = require('@testing-library/react');

// A release build's view of the module: the flag folded to false, no style.
jest.mock('../components/map/keylessBasemap', () => ({
  __esModule: true,
  CARTO_POSITRON: 'unused-in-a-release',
  CARTO_DARK_MATTER: 'unused-in-a-release',
  KEYLESS_BASEMAP_ALLOWED: false,
  keylessBasemapAllowedFor: () => false,
  keylessBasemapStyle: () => null,
}));
jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/userSettings', () => ({ queueSync: () => {} }));
const mockLoadMapEngine = jest.fn(() => Promise.reject(new Error('a release with no basemap must not load the engine')));
jest.mock('../components/map/mapEngine', () => ({
  __esModule: true,
  loadMapEngine: (...args) => mockLoadMapEngine(...args),
}));

// No MapTiler key in this build. The view reads it once, when it loads.
delete process.env.REACT_APP_MAPTILER_KEY;
const MapLibreMapView = require('../components/map/MapLibreMapView').default;

const SRC = path.join(__dirname, '..');
const REPO = path.join(SRC, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

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

describe('the rule', () => {
  const { keylessBasemapAllowedFor } = jest.requireActual('../components/map/keylessBasemap');

  test('development and test builds may draw CARTO keyless, a release only when asked by name', () => {
    expect(keylessBasemapAllowedFor('development', undefined)).toBe(true);
    expect(keylessBasemapAllowedFor('test', undefined)).toBe(true);
    expect(keylessBasemapAllowedFor('production', undefined)).toBe(false);
    expect(keylessBasemapAllowedFor('production', '')).toBe(false);
    expect(keylessBasemapAllowedFor('production', 'true')).toBe(false);
    expect(keylessBasemapAllowedFor('production', 'carto')).toBe(true);
  });

  test('the module itself, loaded as a release would load it, offers no CARTO style', () => {
    const was = { env: process.env.NODE_ENV, optIn: process.env.REACT_APP_KEYLESS_BASEMAP };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.REACT_APP_KEYLESS_BASEMAP;
      jest.isolateModules(() => {
        const m = jest.requireActual('../components/map/keylessBasemap');
        expect(m.KEYLESS_BASEMAP_ALLOWED).toBe(false);
        expect(m.keylessBasemapStyle(false)).toBeNull();
        expect(m.keylessBasemapStyle(true)).toBeNull();
      });
      process.env.REACT_APP_KEYLESS_BASEMAP = 'carto';
      jest.isolateModules(() => {
        const m = jest.requireActual('../components/map/keylessBasemap');
        expect(m.KEYLESS_BASEMAP_ALLOWED).toBe(true);
        expect(m.keylessBasemapStyle(false)).toBe('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json');
        expect(m.keylessBasemapStyle(true)).toBe('https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json');
      });
    } finally {
      process.env.NODE_ENV = was.env;
      if (was.optIn === undefined) delete process.env.REACT_APP_KEYLESS_BASEMAP;
      else process.env.REACT_APP_KEYLESS_BASEMAP = was.optIn;
    }
  });

  test('the flag is written as plain process.env reads, so a release folds it to a constant', () => {
    const src = read(SRC, 'components', 'map', 'keylessBasemap.js');
    expect(src).toMatch(/export const KEYLESS_BASEMAP_ALLOWED = process\.env\.NODE_ENV !== 'production'\s*\|\| process\.env\.REACT_APP_KEYLESS_BASEMAP === 'carto';/);
    // And again inside keylessBasemapStyle, the form the minifier can fold to
    // `return null`, which takes the CARTO addresses out of a release bundle.
    expect(src).toMatch(/if \(process\.env\.NODE_ENV === 'production' && process\.env\.REACT_APP_KEYLESS_BASEMAP !== 'carto'\) return null;/);
    // A whole `process.env` object in client code would ship every
    // REACT_APP_ variable to every visitor (scripts/build.js).
    expect(src).not.toMatch(/process\.env(?!\.)/);
  });
});

describe('a release with no MapTiler key', () => {
  beforeEach(() => mockLoadMapEngine.mockClear());

  test('builds no map: no engine, no style, no tile, and the could-not-load panel', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(view());
      await waitFor(() => expect(screen.getByText('The map could not load. Search still works.')).toBeTruthy());
      expect(mockLoadMapEngine).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/No MapTiler key in this build/));
    } finally {
      warn.mockRestore();
    }
  });

  test('the landing demo shows its list before it imports the engine', () => {
    const src = read(SRC, 'website', 'LiveDemo.js');
    expect(src).toMatch(/const MAP_STYLE = buildFlockStyle\(\{ dark: false, key: MAPTILER_KEY \}\) \|\| keylessBasemapStyle\(false\);/);
    const init = src.slice(src.indexOf('const initMap = useCallback(async () => {'), src.indexOf("import('maplibre-gl')"));
    expect(init).toMatch(/if \(!MAP_STYLE\) \{\s*setMapState\('failed'\);\s*return;\s*\}/);
  });

  test('the app map asks keylessBasemap.js for its fallback and bails before the engine', () => {
    const src = read(SRC, 'components', 'map', 'MapLibreMapView.js');
    expect(src).toMatch(/const BASEMAP_AVAILABLE = !!MAPTILER_KEY \|\| KEYLESS_BASEMAP_ALLOWED;/);
    expect(src).toMatch(/return keylessBasemapStyle\(isDark\);/);
    const init = src.slice(src.indexOf('const init = async () => {'), src.indexOf('engine = await loadMapEngine('));
    expect(init).toMatch(/if \(!BASEMAP_AVAILABLE\) \{/);
  });
});

describe('where keyless CARTO tiles can come from', () => {
  test('only keylessBasemap.js names a CARTO basemap address in the app source', () => {
    const named = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(jsx?|tsx?|mjs|cjs)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('basemaps.cartocdn.com')) {
          named.push(path.relative(SRC, full).split(path.sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(named).toEqual(['components/map/keylessBasemap.js']);
  });

  test('no release build asks for the keyless basemap, and the e2e stack does', () => {
    const releaseConfigs = [
      ['codemagic.yaml'],
      ['frontend', 'vercel.json'],
      ['frontend', 'wrangler.toml'],
      ['frontend', 'scripts', 'build.js'],
      ['frontend', 'scripts', 'build-cloudflare.js'],
      ['frontend', 'scripts', 'deploy-cloudflare.js'],
    ];
    for (const parts of releaseConfigs) {
      const full = path.join(REPO, ...parts);
      if (!fs.existsSync(full)) continue;
      expect([parts.join('/'), fs.readFileSync(full, 'utf8').includes('REACT_APP_KEYLESS_BASEMAP')]).toEqual([parts.join('/'), false]);
    }
    expect(read(REPO, 'tools', 'e2e', 'build.js')).toMatch(/REACT_APP_KEYLESS_BASEMAP: 'carto',/);
    // Documented as unset, for local and test builds only.
    expect(read(REPO, 'frontend', '.env.example')).toMatch(/^REACT_APP_KEYLESS_BASEMAP=$/m);
  });
});
