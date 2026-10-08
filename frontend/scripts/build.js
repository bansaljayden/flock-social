// `npm run build`: react-scripts build, with a client environment that holds
// exactly the variables the app reads.
//
// CRA gives webpack's DefinePlugin one `process.env` object made of every
// REACT_APP_* variable in the build environment. A read of a variable that
// object does not hold is not replaced with undefined: DefinePlugin writes the
// WHOLE object in its place and looks the property up at run time. On Vercel,
// where REACT_APP_PURCHASES and a dozen other variables the app reads are
// unset, the web bundle carried that object 84 times (194 KB raw, 26 KB
// gzipped, 2026-10-07), and it held Vercel's own REACT_APP_VERCEL_* variables:
// the commit message, its author, the repository and the deployment URLs.
//
// So, before react-scripts builds:
// - every variable read in src/ that the environment does not set is defined
//   as undefined, so each read compiles to a constant, and the minifier drops
//   the branch it guards the way REACT_APP_PURCHASES=off already does on iOS;
// - REACT_APP_* variables no code reads are left out of the bundle.
// A variable the app does read still ships to every visitor, so REACT_APP_*
// is for public values only.
//
// On Vercel and on Cloudflare Pages it also turns source maps off
// (vercelDefaults below).
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Read by a dependency rather than by src/: firebase looks for its defaults in
// process.env.__FIREBASE_DEFAULTS__.
const DEPENDENCY_READS = ['__FIREBASE_DEFAULTS__'];

// Every `process.env.NAME` the app's own source names (tests excluded).
function envReadsIn(dir, found = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') envReadsIn(full, found);
    } else if (/\.(jsx?|tsx?|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/process\.env\.([A-Za-z_$][\w$]*)/g)) found.add(m[1]);
    }
  }
  return found;
}

// CRA's { raw, stringified } with the bundler's definitions narrowed to
// `reads`. raw is left as it is: it feeds the %PUBLIC_URL% substitution in
// index.html and webpack's cache key, not the bundle.
function narrowClientEnvironment({ raw, stringified }, reads) {
  const defined = {};
  for (const [key, value] of Object.entries(stringified['process.env'])) {
    if (!key.startsWith('REACT_APP_') || reads.has(key)) defined[key] = value;
  }
  for (const key of reads) {
    if (!(key in defined)) defined[key] = undefined;
  }
  return { raw, stringified: { 'process.env': defined } };
}

// Vercel serves everything under build/, so a source map there hands anyone
// the app's whole source with its comments, and the maps were 18 of the
// ~30 MB each deployment keeps against the plan's 10 GB of deployment
// storage. Nothing on the web reads them: Sentry has no DSN there and
// PostHog's capture_exceptions is off. Cloudflare Pages (`npm run
// build:cloudflare`, which runs this script) publishes build/ the same way;
// Pages sets CF_PAGES=1 on its builds and never sets VERCEL. Other builds
// keep them, because the Codemagic purchase check reads the iOS build's maps.
// An explicit GENERATE_SOURCEMAP still wins, and build-cloudflare.js refuses
// a Pages output that holds a map whatever this returned.
function vercelDefaults(env) {
  return (env.VERCEL || env.CF_PAGES) && env.GENERATE_SOURCEMAP === undefined ? { GENERATE_SOURCEMAP: 'false' } : {};
}

module.exports = { envReadsIn, narrowClientEnvironment, vercelDefaults, DEPENDENCY_READS };

if (require.main === module) {
  // What react-scripts/scripts/build.js sets first. config/env.js throws
  // without NODE_ENV, and it is loaded here, before that script runs.
  process.env.BABEL_ENV = 'production';
  process.env.NODE_ENV = 'production';
  Object.assign(process.env, vercelDefaults(process.env));
  const envModule = require.resolve('react-scripts/config/env');
  const getClientEnvironment = require(envModule);
  const reads = new Set([...envReadsIn(SRC), ...DEPENDENCY_READS]);
  require.cache[envModule].exports = (publicUrl) => narrowClientEnvironment(getClientEnvironment(publicUrl), reads);
  require('react-scripts/scripts/build');
}
