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
// - build/landing.html, how-it-works.html, about.html, research.html,
//   flux.html and ai.html: the
//   marketing routes as real HTML, snapshotted from the build itself (see
//   prerender below). index.html stays the empty shell every app route needs.
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

// The marketing routes whose page chunk is named in src/index.js, so its
// hashed file can be found in asset-manifest.json after every build.
const ROUTE_CHUNKS = [
  { route: '/', chunk: 'landing' },
  { route: '/how-it-works', chunk: 'howitworks' },
  { route: '/flux', chunk: 'flux' },
  { route: '/ai', chunk: 'aipage' },
];

// Preload hints for those routes, appended to _headers. On a first visit the
// browser otherwise discovers the page chunk only after main.js has downloaded
// and run, and the display face only after that chunk has rendered; sent with
// the HTML, all three download alongside main.js. (Cloudflare can also send
// them early as 103 Early Hints, a zone setting that is off for flockcorp.com
// as of 2026-10-21; the Link header works without it.) Pages joins a header named by two
// matching rules with a comma, so this adds to the canonical Link the source
// _headers already sets on "/" instead of replacing it. Anything not found
// (a chunk renamed, a fixture without a manifest) is skipped, never fatal:
// a missing hint costs speed, a failed build costs the deploy.
//
// A route that was prerendered gets the face alone: its stylesheets are in
// the HTML and its scripts wait for the first paint (servableSnapshot), so a
// hint for either would be a second download or the early one the snapshot
// is built to avoid.
function routePreloads(out, prerendered = []) {
  const manifestPath = path.join(out, 'asset-manifest.json');
  if (!fs.existsSync(manifestPath)) return '';
  const { files = {} } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const urls = Object.values(files).filter((u) => typeof u === 'string');
  const find = (re) => urls.find((u) => re.test(u));
  const font = find(/\/static\/media\/Literata-Display-600\.[0-9a-f]+\.woff2$/);
  const blocks = [];
  for (const { route, chunk } of ROUTE_CHUNKS) {
    const static_ = prerendered.includes(route);
    const js = !static_ && find(new RegExp('/static/js/' + chunk + '\\.[0-9a-f]+\\.chunk\\.js$'));
    const css = !static_ && find(new RegExp('/static/css/' + chunk + '\\.[0-9a-f]+\\.chunk\\.css$'));
    const links = [];
    if (css) links.push('<' + css + '>; rel=preload; as=style');
    if (js) links.push('<' + js + '>; rel=preload; as=script');
    if (font && (links.length || static_)) links.push('<' + font + '>; rel=preload; as=font; type="font/woff2"; crossorigin');
    if (links.length) blocks.push(route + '\n  Link: ' + links.join(', '));
  }
  return blocks.length ? '\n' + blocks.join('\n\n') + '\n' : '';
}

// THE MARKETING ROUTES AS REAL HTML. A Create React App page is an empty
// <div id="root"> until about 85 KB of JavaScript has run, so the hero waited
// on main.js, then the page's chunk, then a render (the audit's lab runs put
// LCP at 2.0 to 3.0 s, almost all of it that wait), and view-source showed
// nothing. Here the build is served locally, each marketing route is loaded in
// headless Chromium with every request off the build refused (no API, no map
// tiles, no analytics) and the consent already answered, and the rendered
// document is written next to index.html: build/landing.html for "/" (the
// middleware answers "/" with it; index.html must stay the shell, because
// Pages answers every unknown path, /app and /i/<token> included, with
// index.html), and <route>.html for the rest, which Pages serves at the
// slashless path. Only this Pages build does it: the iOS build runs
// scripts/build.js alone and never sees this step.
//
// The page then boots on top of its own snapshot: src/index.js sees
// data-prerendered on #root, waits for the page's chunk, and renders once,
// replacing the HTML with the same DOM, so the Loading screen never covers it.
//
// A failure here is never fatal. Without a snapshot the route is served as
// before, client-rendered from index.html.
const PRERENDER = [
  { route: '/', file: 'landing.html' },
  { route: '/how-it-works', file: 'how-it-works.html' },
  { route: '/about', file: 'about.html' },
  { route: '/research', file: 'research.html' },
  { route: '/flux', file: 'flux.html' },
  { route: '/ai', file: 'ai.html' },
];

// The snapshot, made servable.
//
// Scripts: the HTML is already the page, so nothing has to run before the
// first paint, and nothing should share the connection with what that paint
// needs. main.js's tag gives way to cloudflare/paint-first.js (PAINT_FIRST),
// which fetches main.js and the page's own chunks once the browser reports
// the first contentful paint. The chunks are the ones the snapshot's load
// fetched besides main.js, plus any webpack left in the DOM as data-webpack
// tags; they are named on the loader's tag, not hinted in the head, where they
// would be fetched at once. On Lighthouse's phone run of "/" (2026-10-21) a
// page that fetched main.js beside the hero put LCP at 3.3 s; with the
// scripts blocked outright it was 2.4 s, and the app's own tasks after the
// paint are each under 20 ms.
//
// Stylesheets: each one the page links from /static/css/ is written into the
// head as a <style> in the same place, so the first paint waits on the HTML
// alone, not on two more requests. It keeps the file's path as data-href,
// which is the mark webpack's CSS loader looks for before fetching a chunk's
// stylesheet, so the app does not download it again. Their url()s are all
// root-relative (/static/media/...), so they resolve the same from the page.
//
// The display face is preloaded unless the page already asked for it. #root is
// marked so the client knows the HTML is already there.
function servableSnapshot(html, { scripts = [], font = null, css = () => null, loader } = {}) {
  if (!loader) throw new Error('servableSnapshot needs the paint-first loader\'s URL');
  const chunks = [];
  const name = (src) => { if (!chunks.includes(src)) chunks.push(src); };
  let out = html.replace(/<script\b[^>]*\bdata-webpack="[^"]*"[^>]*><\/script>/g, (tag) => {
    const src = /\bsrc="([^"]+)"/.exec(tag);
    if (src) name(src[1]);
    return '';
  });
  scripts.forEach(name);

  const entry = /<script defer="defer" src="(\/static\/js\/main\.[0-9a-f]+\.js)"><\/script>/.exec(out);
  if (!entry) throw new Error('the snapshot has no main.js <script> to hand to the loader');
  out = out.replace(entry[0], () => '<script defer="defer" src="' + loader + '" data-main="' + entry[1]
    + '" data-chunks="' + chunks.join(' ') + '"></script>');

  out = out.replace(/<link\b[^>]*>/g, (tag) => {
    const href = /\bhref="(\/static\/css\/[^"]+\.css)"/.exec(tag);
    if (!href || !/\brel="stylesheet"/.test(tag)) return tag;
    const text = css(href[1]);
    if (typeof text !== 'string' || /<\/style/i.test(text)) return tag;
    return '<style data-href="' + href[1] + '">' + text + '</style>';
  });

  if (font && !out.includes('href="' + font + '"')) {
    out = out.replace('</head>', () => '<link rel="preload" as="font" type="font/woff2" href="' + font + '" crossorigin="anonymous"></head>');
  }
  out = out.replace('<div id="root">', '<div id="root" data-prerendered="">');
  if (!out.includes('<div id="root" data-prerendered="">')) throw new Error('no <div id="root"> in the snapshot');
  if (!/<h1[\s>]/.test(out)) throw new Error('the snapshot has no h1');
  return out;
}

// cloudflare/paint-first.js under a name that changes with its bytes, since
// /static/ is cached for a year as immutable.
function paintFirst() {
  const source = fs.readFileSync(path.join(CONFIG, 'paint-first.js'), 'utf8');
  const hash = require('crypto').createHash('sha256').update(source).digest('hex').slice(0, 8);
  return { source, file: path.join('static', 'js', 'paint-first.' + hash + '.js'), url: '/static/js/paint-first.' + hash + '.js' };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.avif': 'image/avif',
};

// The build over HTTP, with the fallback Pages has: a path that is not a file
// gets index.html.
function serveBuild(out) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    let file = path.join(out, pathname);
    if (!file.startsWith(out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(out, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

async function prerender(out) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    console.warn('build:cloudflare: playwright is not installed, so the marketing routes stay client-rendered');
    return [];
  }
  const server = await serveBuild(out);
  const base = 'http://127.0.0.1:' + server.address().port;
  let font = null;
  try {
    const { files = {} } = JSON.parse(fs.readFileSync(path.join(out, 'asset-manifest.json'), 'utf8'));
    font = Object.values(files).find((u) => /\/static\/media\/Literata-Display-600\.[0-9a-f]+\.woff2$/.test(u)) || null;
  } catch (err) { /* no manifest: no font hint */ }
  const loader = paintFirst();
  const css = (href) => {
    const file = path.join(out, href);
    return file.startsWith(path.join(out, 'static', 'css')) && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const snapshots = [];
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      try { window.localStorage.setItem('flock_analytics_consent', 'no'); } catch (e) { /* no storage */ }
      // Nothing comes into view: the live demo mounts on approach (WhenNear in
      // LandingPage.js), and a snapshot must hold the empty, sized holder the
      // client's first render also draws, not a map that would be torn down
      // and rebuilt the moment the page boots.
      window.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() { return []; }
      };
    });
    await context.route('**/*', (route) => (route.request().url().startsWith(base + '/') ? route.continue() : route.abort()));
    for (const { route, file } of PRERENDER) {
      const page = await context.newPage();
      try {
        await page.goto(base + route, { waitUntil: 'load' });
        await page.waitForSelector('main h1', { timeout: 20000 });
        await page.waitForTimeout(400);
        // The chunks the first render needs, read off the page's own resource
        // timeline. Nothing else asks for a script here: the live demo stays
        // unmounted (no IntersectionObserver ever fires) and analytics is off
        // on a local origin (isLocalAnalyticsOrigin in src/index.js).
        const snap = await page.evaluate(() => {
          const scripts = performance.getEntriesByType('resource')
            .map((e) => new URL(e.name).pathname)
            .filter((p) => /^\/static\/js\/.+\.js$/.test(p) && !/^\/static\/js\/main\./.test(p));
          return { html: document.documentElement.outerHTML, scripts };
        });
        snapshots.push({ route, file, html: servableSnapshot('<!DOCTYPE html>' + snap.html, { scripts: snap.scripts, font, css, loader: loader.url }) });
      } catch (err) {
        console.warn('build:cloudflare: no snapshot for ' + route + ' (' + err.message.split('\n')[0] + '); it stays client-rendered');
      } finally {
        await page.close();
      }
    }
  } catch (err) {
    console.warn('build:cloudflare: prerendering stopped (' + err.message.split('\n')[0] + '); the marketing routes stay client-rendered');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
  // Written only now, so no snapshot was taken from another one.
  if (snapshots.length) fs.writeFileSync(path.join(out, loader.file), loader.source);
  for (const { file, html } of snapshots) fs.writeFileSync(path.join(out, file), html);
  return snapshots.map((s) => s.file);
}

// Everything after react-scripts: the Pages files go into `out`, then the
// output is refused if Pages would serve it differently from Vercel.
// `prerendered` is the routes prerender() wrote, for routePreloads.
function finishOutput(out, { prerendered = [] } = {}) {
  if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error(path.join(out, 'index.html') + ' is missing');

  const headers = headersFile() + routePreloads(out, prerendered);
  checkHeaders(headers);
  fs.writeFileSync(path.join(out, '_headers'), headers);
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
  outputDir, checkHeaders, headersFile, checkRoutes, appSiteAssociation, finishOutput, routePreloads,
  servableSnapshot, paintFirst, prerender, ROUTE_CHUNKS, PRERENDER, MAX_HEADER_RULES, MAX_HEADER_LINE,
};

if (require.main === module) {
  (async () => {
    try {
      if (!process.argv.includes('--skip-build')) {
        // From the app directory: react-scripts reads package.json, src/ and
        // BUILD_PATH relative to its working directory.
        const result = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], { cwd: ROOT, stdio: 'inherit', env: process.env });
        if (result.status !== 0) process.exit(result.status || 1);
      }
      const out = outputDir(process.env);
      const written = process.argv.includes('--no-prerender') ? [] : await prerender(out);
      if (written.length) console.log('build:cloudflare: prerendered ' + written.join(', '));
      finishOutput(out, { prerendered: PRERENDER.filter((p) => written.includes(p.file)).map((p) => p.route) });
      console.log('build:cloudflare: _headers, _redirects, _routes.json and the app-site-association file are in ' + out);
    } catch (err) {
      console.error('build:cloudflare: ' + err.message);
      process.exit(1);
    }
  })();
}
