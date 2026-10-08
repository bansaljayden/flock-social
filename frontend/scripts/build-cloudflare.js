// `npm run build:cloudflare`: the Cloudflare Pages build command.
//
// Runs the normal build (scripts/build.js), then adds what Pages reads from
// the output directory and refuses to finish if the output would change how
// Pages serves the site:
// - build/_headers: a "/*" block from cloudflare/security-headers.json, then
//   cloudflare/_headers;
// - build/_redirects and build/_routes.json, copied from cloudflare/;
// - build/.well-known/apple-app-site-association, the body
//   api/apple-app-site-association.js returns for APPLE_TEAM_ID, as a file;
// - no top-level 404.html (with one, Pages stops answering unknown paths with
//   index.html, which is the SPA fallback vercel.json's last rewrite did);
// - no source maps on a Pages build (they would publish the app's source).
//   scripts/build.js already turns them off when CF_PAGES is set, so this is
//   the backstop for an explicit GENERATE_SOURCEMAP=true.
//
// The three Pages files are kept out of public/ on purpose: CRA copies
// public/ into every build, and Vercel would serve them as plain files.
//
// The output directory is the one react-scripts writes: build/, or BUILD_PATH
// when that is set, so a local check can build somewhere other than build/.
// `--skip-build` runs only the second half against an existing output.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'cloudflare');

// Pages default for every static response (developers.cloudflare.com/pages/configuration/serving-pages/),
// with the value vercel.json sets. Naming it in "/*" as well would join it
// onto the no-referrer rules below as "strict-origin-when-cross-origin, no-referrer".
const PAGES_DEFAULT_ONLY = new Set(['referrer-policy']);

// developers.cloudflare.com/pages/platform/limits/. Past either _headers
// limit Pages does not fail the deploy: it skips the long line, or every rule
// after the hundredth, and the site quietly loses those headers. So the build
// counts the way wrangler's parser does (workers-shared parseHeaders: lines
// trimmed, blank and # lines skipped, a rule is a line that starts with "/"
// or "<scheme>://") and stops first.
const MAX_HEADER_RULES = 100;
const MAX_HEADER_LINE = 2000;
const MAX_ROUTE_RULES = 100;
const MAX_ROUTE_LENGTH = 100;

// react-scripts/config/paths.js resolves BUILD_PATH against the app directory.
function outputDir(env) {
  return path.resolve(ROOT, env.BUILD_PATH || 'build');
}

function checkHeaders(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const rules = lines.filter((line) => /^(\S+:\/\/|\/)/.test(line));
  if (rules.length > MAX_HEADER_RULES) {
    throw new Error('_headers has ' + rules.length + ' rules; Pages reads at most ' + MAX_HEADER_RULES);
  }
  const long = lines.find((line) => line.length > MAX_HEADER_LINE);
  if (long) throw new Error('_headers has a line over ' + MAX_HEADER_LINE + ' characters: ' + long.slice(0, 60));
  return rules.length;
}

function headersFile() {
  const { headers } = JSON.parse(fs.readFileSync(path.join(CONFIG, 'security-headers.json'), 'utf8'));
  const block = ['/*'];
  for (const [name, value] of headers) {
    if (!PAGES_DEFAULT_ONLY.has(name.toLowerCase())) block.push('  ' + name + ': ' + value);
  }
  const text = block.join('\n') + '\n\n' + fs.readFileSync(path.join(CONFIG, '_headers'), 'utf8');
  checkHeaders(text);
  return text;
}

function checkRoutes(routes) {
  const include = Array.isArray(routes.include) ? routes.include : [];
  const exclude = Array.isArray(routes.exclude) ? routes.exclude : [];
  if (routes.version !== 1 || include.length < 1 || include.length + exclude.length > MAX_ROUTE_RULES) {
    throw new Error('_routes.json is outside Pages limits');
  }
  if ([...include, ...exclude].some((rule) => rule.length > MAX_ROUTE_LENGTH)) {
    throw new Error('_routes.json has a rule over ' + MAX_ROUTE_LENGTH + ' characters');
  }
}

// The handler's own body, byte for byte, so the file and the function cannot
// disagree. A missing or malformed Team ID fails the build: the previous
// deployment keeps serving instead of a file iOS would refuse.
function appSiteAssociation() {
  const handler = require(path.join(ROOT, 'api', 'apple-app-site-association.js'));
  let status = 200;
  let body = '';
  const res = {
    setHeader() {},
    status(code) { status = code; return this; },
    json(value) { body = JSON.stringify(value); return this; },
  };
  handler({ method: 'GET', headers: {} }, res);
  if (status !== 200) throw new Error('APPLE_TEAM_ID is unset or not a ten character Apple Team ID: ' + body);
  return body;
}

function filesUnder(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, found);
    else found.push(full);
  }
  return found;
}

// Everything after react-scripts: the Pages files go into `out`, then the
// output is refused if Pages would serve it differently from Vercel.
function finishOutput(out) {
  if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error(path.join(out, 'index.html') + ' is missing');

  fs.writeFileSync(path.join(out, '_headers'), headersFile());
  fs.copyFileSync(path.join(CONFIG, '_redirects'), path.join(out, '_redirects'));

  checkRoutes(JSON.parse(fs.readFileSync(path.join(CONFIG, '_routes.json'), 'utf8')));
  fs.copyFileSync(path.join(CONFIG, '_routes.json'), path.join(out, '_routes.json'));

  fs.mkdirSync(path.join(out, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(out, '.well-known', 'apple-app-site-association'), appSiteAssociation());

  if (fs.existsSync(path.join(out, '404.html'))) {
    throw new Error('404.html is in the output; Pages would stop serving index.html for unknown paths');
  }
  const maps = filesUnder(out).filter((file) => file.endsWith('.map'));
  if (process.env.CF_PAGES && maps.length) {
    throw new Error(maps.length + ' source maps in the output; leave GENERATE_SOURCEMAP unset (or false) on a Pages build');
  }
}

module.exports = {
  outputDir, checkHeaders, headersFile, checkRoutes, appSiteAssociation, finishOutput,
  MAX_HEADER_RULES, MAX_HEADER_LINE,
};

if (require.main === module) {
  try {
    if (!process.argv.includes('--skip-build')) {
      // From the app directory: react-scripts reads package.json, src/ and
      // BUILD_PATH relative to its working directory.
      const result = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], { cwd: ROOT, stdio: 'inherit', env: process.env });
      if (result.status !== 0) process.exit(result.status || 1);
    }
    const out = outputDir(process.env);
    finishOutput(out);
    console.log('build:cloudflare: _headers, _redirects, _routes.json and the app-site-association file are in ' + out);
  } catch (err) {
    console.error('build:cloudflare: ' + err.message);
    process.exit(1);
  }
}
