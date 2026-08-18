/**
 * No unused billable Google API key may ship in the bundle.
 *
 * WHY THIS FILE EXISTS
 *
 * `REACT_APP_GOOGLE_MAPS_API_KEY` had ZERO consumers in `frontend/src` — no
 * `process.env` read, no `maps.googleapis.com/maps/api/js` script tag, no
 * `google.maps` call, no `@react-google-maps` import. The maps are MapLibre GL
 * against MapTiler tiles (`App.js`, `website/LiveDemo.js`), which read
 * `REACT_APP_MAPTILER_KEY` instead. Google Maps was never wired up.
 *
 * That did not make the key harmless. CRA's webpack config hands DefinePlugin
 * the WHOLE `process.env` object, not just the identifiers the code
 * dereferences, so every `REACT_APP_*` present in the build environment is
 * emitted verbatim into `build/static/js/*.js` whether or not a single line
 * reads it. The key was in the Vercel project env and named in `codemagic.yaml`
 * as something to add to the `flock_web` group, so a billable Google Cloud key
 * with a wide API surface was published to every visitor to fund a feature that
 * does not exist. Nothing in the app would have broken if someone had found it
 * and burned the quota; the bill would simply have arrived.
 *
 * The lesson generalises past this one variable: "is it used?" is the wrong
 * question, because an unused key ships exactly as loudly as a used one. The
 * only question that matters is "is it in the build env?". So this file guards
 * the build env, not the import graph.
 *
 * WHAT IS ASSERTED, IN ORDER OF USEFULNESS
 *
 * 1. The BUILT bundle carries no `AIza`-shaped Google API key except the short
 *    allowlist below. This is the assertion that actually catches the next one.
 * 2. The repo never re-declares `REACT_APP_GOOGLE_MAPS_API_KEY` — not in
 *    `src/`, not as a declaration line in `.env.example`, and not in
 *    `codemagic.yaml` as something to add to `flock_web`.
 *
 * ON THE BUILD NOT EXISTING (and on your local `.env`)
 *
 * `npm test` does not build, so `build/` may be absent — assertion 1 skips
 * then, and assertion 2 (source + `.env.example` + `codemagic.yaml`, which need
 * no build) carries the file. Run `CI=true npm run build` first for the real
 * check.
 *
 * There is a second, subtler skip. `frontend/.env` is untracked and personal,
 * and CRA merges it into the build env, so a developer with a stale forbidden
 * key still in their own `.env` produces a bundle the REPO cannot be held
 * responsible for. In that case assertion 1 downgrades to a loud console
 * warning naming the variable, because failing would be blaming the repo for a
 * file the repo does not contain. CI has no `.env` — there the scan is always
 * strict, which is where it needs to be, since CI is what builds what ships.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..');
const REPO = path.join(FRONTEND, '..');
const SRC = path.join(FRONTEND, 'src');
const BUILD_JS = path.join(FRONTEND, 'build', 'static', 'js');

const read = (p) => fs.readFileSync(p, 'utf8');

const FORBIDDEN = 'REACT_APP_GOOGLE_MAPS_API_KEY';

/**
 * Env var names whose value is allowed to be an `AIza`-shaped Google key in the
 * shipped bundle. Keep this list SHORT and add to it only with a one-line
 * reason, because every entry is a key handed to every visitor.
 *
 * - REACT_APP_FIREBASE_API_KEY: the Firebase Web SDK config for FCM web push.
 *   The Web SDK cannot initialise without it and it is designed to be public
 *   (Firebase security rules and the authorised-domains list, not secrecy, are
 *   what protect the project). Read by `services/firebase.js`.
 */
const ALLOWED_AIZA_VARS = ['REACT_APP_FIREBASE_API_KEY'];

// Every JS/JSX/TS file under src/, so a re-introduction anywhere is caught, not
// just in the file it originally lived in.
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return walk(full);
  return /\.(js|jsx|ts|tsx)$/.test(e.name) ? [full] : [];
});

const SRC_FILES = walk(SRC).filter((f) => f !== __filename);

describe('no unused billable Google API key in the source tree', () => {
  test('nothing under src/ mentions the forbidden Google Maps key', () => {
    const offenders = SRC_FILES.filter((f) => read(f).includes(FORBIDDEN))
      .map((f) => path.relative(FRONTEND, f));
    // A mention is enough to fail. Reading it is what puts it in the import
    // graph, but as the header explains, CRA ships it either way — so the
    // moment the name is back in the tree, someone is about to set it.
    expect(offenders).toEqual([]);
  });

  test('.env.example does not declare the forbidden Google Maps key', () => {
    // Declaration lines only. The file explains in prose why this key must not
    // be added, and that explanation has to be allowed to name it.
    const declarations = read(path.join(FRONTEND, '.env.example'))
      .split('\n')
      .filter((line) => new RegExp('^\\s*(export\\s+)?' + FORBIDDEN + '\\s*=').test(line));
    expect(declarations).toEqual([]);
  });

  test('codemagic.yaml does not ask for the forbidden key in the flock_web group', () => {
    // Same shape as above: the setup comment is allowed to name the variable in
    // order to forbid it, so every surviving mention must be a prohibition.
    const mentions = read(path.join(REPO, 'codemagic.yaml'))
      .split('\n')
      .filter((line) => line.includes(FORBIDDEN))
      .filter((line) => !/\bnot\b/.test(line));
    expect(mentions).toEqual([]);
  });
});

describe('no unallowlisted Google API key in the built bundle', () => {
  const bundles = fs.existsSync(BUILD_JS)
    ? fs.readdirSync(BUILD_JS).filter((f) => f.endsWith('.js')).map((f) => path.join(BUILD_JS, f))
    : [];

  // Untracked, personal, and merged into the build env by CRA. See the header.
  const localEnvPath = path.join(FRONTEND, '.env');
  const localEnv = fs.existsSync(localEnvPath) ? read(localEnvPath) : '';
  const localEnvDeclares = (name) =>
    new RegExp('^\\s*(export\\s+)?' + name + '\\s*=\\s*\\S', 'm').test(localEnv);

  test('every AIza-shaped key in build/static/js is on the allowlist', () => {
    if (bundles.length === 0) {
      // Not a silent pass: the source-side assertions above still ran, and this
      // one is meaningless without artifacts to read.
      console.warn(
        '[noUnusedGoogleApiKey] no build/ found — run `CI=true npm run build` for the full check'
      );
      return;
    }

    // CRA emits the DefinePlugin payload as `REACT_APP_X:"value"` after
    // minification and `"REACT_APP_X":"value"` before it, so accept both.
    const NAMED = /"?(REACT_APP_[A-Z0-9_]+)"?\s*:\s*"(AIza[0-9A-Za-z_-]{20,})"/g;
    const ANY = /AIza[0-9A-Za-z_-]{20,}/g;

    const named = new Map();   // env var name -> key
    const allKeys = new Set(); // every AIza literal, named or not

    for (const file of bundles) {
      const js = read(file);
      for (const m of js.matchAll(NAMED)) named.set(m[1], m[2]);
      for (const m of js.matchAll(ANY)) allKeys.add(m[0]);
    }

    // Never print a live key in test output — CI logs are not a secret store.
    const mask = (k) => k.slice(0, 10) + '…(' + k.length + ' chars)';

    const violations = [...named.entries()]
      .filter(([name]) => !ALLOWED_AIZA_VARS.includes(name))
      .map(([name, key]) => name + '=' + mask(key));

    // An AIza literal with no REACT_APP_ name in front of it was hardcoded into
    // source rather than injected from the env, which is worse, not better.
    const namedKeys = new Set(named.values());
    const orphans = [...allKeys].filter((k) => !namedKeys.has(k)).map(mask);

    const excusedByLocalEnv = violations.filter((v) => localEnvDeclares(v.split('=')[0]));
    if (excusedByLocalEnv.length > 0) {
      console.warn(
        '[noUnusedGoogleApiKey] your untracked frontend/.env still sets ' +
          excusedByLocalEnv.map((v) => v.split('=')[0]).join(', ') +
          ', so your local build ships it. The repo no longer asks for it — delete the ' +
          'line from frontend/.env, and from the Vercel project env and the Codemagic ' +
          'flock_web group, then rebuild.'
      );
    }

    const stillFailing = violations.filter((v) => !excusedByLocalEnv.includes(v));
    expect({ unallowlisted: stillFailing, hardcoded: orphans })
      .toEqual({ unallowlisted: [], hardcoded: [] });
  });
});
