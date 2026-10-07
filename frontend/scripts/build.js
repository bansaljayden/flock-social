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

module.exports = { envReadsIn, narrowClientEnvironment, DEPENDENCY_READS };

if (require.main === module) {
  // What react-scripts/scripts/build.js sets first. config/env.js throws
  // without NODE_ENV, and it is loaded here, before that script runs.
  process.env.BABEL_ENV = 'production';
  process.env.NODE_ENV = 'production';
  const envModule = require.resolve('react-scripts/config/env');
  const getClientEnvironment = require(envModule);
  const reads = new Set([...envReadsIn(SRC), ...DEPENDENCY_READS]);
  require.cache[envModule].exports = (publicUrl) => narrowClientEnvironment(getClientEnvironment(publicUrl), reads);
  require('react-scripts/scripts/build');
}
