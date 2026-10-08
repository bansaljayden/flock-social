/**
 * `npm run build` hands the bundler only the variables the app reads
 * (scripts/build.js).
 *
 * Before it, every read of a variable the build environment did not set
 * (REACT_APP_PURCHASES on the web, REACT_APP_API_URL, the Firebase keys) made
 * webpack's DefinePlugin write the WHOLE process.env object in its place. The
 * web bundle carried that object 84 times, and on Vercel it held Vercel's own
 * REACT_APP_VERCEL_* variables: the commit message, its author, the
 * repository and the deployment URLs (2026-10-07).
 */
const fs = require('fs');
const path = require('path');
const { envReadsIn, narrowClientEnvironment, vercelDefaults, DEPENDENCY_READS } = require('../../scripts/build');

const FRONTEND = path.join(__dirname, '..', '..');
const SRC = path.join(FRONTEND, 'src');

describe('the build environment the bundler gets', () => {
  // What react-scripts' config/env.js returns: values already JSON-encoded,
  // an unset variable as undefined.
  const cra = () => ({
    raw: { NODE_ENV: 'production', PUBLIC_URL: '' },
    stringified: {
      'process.env': {
        NODE_ENV: '"production"',
        PUBLIC_URL: '""',
        WDS_SOCKET_HOST: undefined,
        FAST_REFRESH: true,
        REACT_APP_MAPTILER_KEY: '"public-map-key"',
        REACT_APP_VERCEL_GIT_COMMIT_MESSAGE: '"a commit message"',
        REACT_APP_VERCEL_GIT_COMMIT_AUTHOR_NAME: '"an author"',
        REACT_APP_VERCEL_URL: '"a-deployment.vercel.app"',
      },
    },
  });
  const reads = new Set(['NODE_ENV', 'REACT_APP_MAPTILER_KEY', 'REACT_APP_PURCHASES', '__FIREBASE_DEFAULTS__']);

  test('a variable the app reads but the environment does not set is defined, as undefined', () => {
    const env = narrowClientEnvironment(cra(), reads).stringified['process.env'];
    // Defined (so the read compiles to a constant), with no value.
    expect(Object.keys(env)).toEqual(expect.arrayContaining(['REACT_APP_PURCHASES', '__FIREBASE_DEFAULTS__']));
    expect(env.REACT_APP_PURCHASES).toBeUndefined();
    expect(env.__FIREBASE_DEFAULTS__).toBeUndefined();
  });

  test('REACT_APP_ variables nothing reads are left out; the ones it reads keep their values', () => {
    const env = narrowClientEnvironment(cra(), reads).stringified['process.env'];
    expect(Object.keys(env).filter((k) => k.startsWith('REACT_APP_VERCEL_'))).toEqual([]);
    expect(env.REACT_APP_MAPTILER_KEY).toBe('"public-map-key"');
  });

  test("CRA's own entries stay, and raw (index.html substitution, cache key) is untouched", () => {
    const input = cra();
    const out = narrowClientEnvironment(input, reads);
    const env = out.stringified['process.env'];
    expect(env.NODE_ENV).toBe('"production"');
    expect(Object.keys(env)).toEqual(expect.arrayContaining(['PUBLIC_URL', 'WDS_SOCKET_HOST', 'FAST_REFRESH']));
    expect(out.raw).toBe(input.raw);
  });
});

describe('what the app reads', () => {
  test('the scan of src/ finds the reads, including the ones the web never sets', () => {
    const found = envReadsIn(SRC);
    for (const key of ['REACT_APP_PURCHASES', 'REACT_APP_API_URL', 'REACT_APP_SENTRY_DSN', 'REACT_APP_FIREBASE_API_KEY', 'REACT_APP_MAPTILER_KEY', 'NODE_ENV']) {
      expect(`${key} ${found.has(key)}`).toBe(`${key} true`);
    }
    expect(DEPENDENCY_READS).toContain('__FIREBASE_DEFAULTS__');
  });

  test('app code reads process.env only by name', () => {
    // A computed or whole-object read cannot be narrowed: webpack writes the
    // full environment object there whatever the build defines.
    const dynamic = /process\.env\s*\[|\.\.\.\s*process\.env\b|\bin\s+process\.env\b|Object\.\w+\(\s*process\.env\s*\)|(?:[=(,:|&?!]|\breturn)\s*process\.env\s*[;,)}|&?\n]/;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (/\.(jsx?|tsx?|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (dynamic.test(text)) offenders.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

describe('source maps', () => {
  // Vercel publishes build/ to everyone; the maps were the app's full source
  // and most of each deployment's storage. Cloudflare Pages publishes build/
  // the same way. Codemagic's purchase check reads the iOS build's maps, so
  // only the two web hosts turn them off.
  test('a Vercel build turns them off', () => {
    expect(vercelDefaults({ VERCEL: '1' })).toEqual({ GENERATE_SOURCEMAP: 'false' });
  });

  test('a Cloudflare Pages build turns them off too', () => {
    // Pages sets CF_PAGES=1 and never VERCEL. Without this default every
    // Pages build stops at build-cloudflare.js's source-map refusal.
    expect(vercelDefaults({ CF_PAGES: '1' })).toEqual({ GENERATE_SOURCEMAP: 'false' });
    expect(vercelDefaults({ CF_PAGES: '1', CI: 'true' })).toEqual({ GENERATE_SOURCEMAP: 'false' });
    expect(vercelDefaults({ CF_PAGES: '1', GENERATE_SOURCEMAP: 'true' })).toEqual({});
    expect(vercelDefaults({ CF_PAGES: '1', GENERATE_SOURCEMAP: 'false' })).toEqual({});
  });

  test('every other build keeps them, and an explicit setting wins', () => {
    expect(vercelDefaults({})).toEqual({});
    expect(vercelDefaults({ CI: 'true' })).toEqual({});
    expect(vercelDefaults({ CF_PAGES: '' })).toEqual({});
    expect(vercelDefaults({ VERCEL: '1', GENERATE_SOURCEMAP: 'true' })).toEqual({});
  });
});

test('npm run build goes through scripts/build.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));
  expect(pkg.scripts.build).toBe('node scripts/build.js');
});
