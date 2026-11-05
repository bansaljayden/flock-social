// CARTO'S KEYLESS BASEMAPS, FOR BUILDS THAT NEVER REACH THE PUBLIC.
//
// With no MapTiler key the map used to fall back to CARTO's Positron and Dark
// Matter styles in every build, a release included. Since 2026-09-29 CARTO's
// basemap terms want a CARTO-issued key for every use, so a release built
// without its MapTiler key would have drawn the map on tiles it has no licence
// for, and nothing would have said so: codemagic.yaml lists the key among the
// variables whose absence still ships a build.
//
// So the keyless fallback is for development: `npm start`, the test runner,
// and a production-mode build that asks for it by name with
// REACT_APP_KEYLESS_BASEMAP=carto, as tools/e2e/build.js does for the e2e
// stack. A release built without a MapTiler key requests no basemap at all:
// the app's map shows its could-not-load panel and the landing demo shows its
// list of venues.
//
// Both reads are written out as process.env.NAME so the build replaces them
// with constants (scripts/build.js defines every variable src/ reads). In a
// release the flag below is the constant false, and keylessBasemapStyle
// compiles to `return null`: the minifier drops the CARTO addresses with the
// dead branch, so a release bundle does not even name them.

export const CARTO_POSITRON = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
export const CARTO_DARK_MATTER = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// The rule, apart from the build it runs in, so a test can ask it about a
// release without being one.
export function keylessBasemapAllowedFor(nodeEnv, optIn) {
  return nodeEnv !== 'production' || optIn === 'carto';
}

// This build's answer. The same expression as the rule above, written inline
// so the build can fold it to a constant.
export const KEYLESS_BASEMAP_ALLOWED = process.env.NODE_ENV !== 'production'
  || process.env.REACT_APP_KEYLESS_BASEMAP === 'carto';

// CARTO's style for the theme, or null in a build that may not draw it. The
// reads are repeated here rather than going through the flag above: written
// inline, the minifier can see the branch is dead in a release. Through the
// exported flag it kept both addresses behind a false test.
export function keylessBasemapStyle(dark) {
  if (process.env.NODE_ENV === 'production' && process.env.REACT_APP_KEYLESS_BASEMAP !== 'carto') return null;
  return dark ? CARTO_DARK_MATTER : CARTO_POSITRON;
}
