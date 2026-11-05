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
// - build/404.html, a copy of index.html. Pages answers a path that is
//   neither a file nor a _redirects rule with the nearest 404.html and a 404,
//   so a scanner probe (/wp-login.php, /.env) or a mistyped link is a 404
//   that still boots the app, which shows its own not-found page. With no
//   top-level 404.html, Pages answered all of them with index.html and a 200:
//   page views to the analytics, soft 404s to a search engine;
// - a copy of index.html at every exact route the app answers (APP_ROUTES),
//   so each of those paths is a file and keeps its 200;
// - no _redirects rewrite over a file (checkRedirects);
// - no source maps on a Pages build (they would publish the app's source).
//   scripts/build.js already turns them off when CF_PAGES is set, so this is
//   the backstop for an explicit GENERATE_SOURCEMAP=true.
//
// - build/landing.html, how-it-works.html, about.html, research.html,
//   flux.html and ai.html: the
//   marketing routes as real HTML, snapshotted from the build itself (see
//   prerender below), or the shell where a snapshot fails. index.html stays
//   the empty shell every app route needs.
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
// as of 2026-10-21; the Link header works without it.) The hints are folded
// into the route's own block by joinHeaderBlocks below, beside the canonical
// Link the source _headers sets there. Anything not found
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

// Pages joins a header that two DIFFERENT patterns both name ("/*" and
// "/flux"), but a second block for the SAME path replaces the first one
// whole. Appended as blocks of their own, the hints above cost /how-it-works,
// /flux and /ai their canonical Link on the website-flux preview
// (2026-10-21), and canonicals are served only as that header (see the note
// in public/index.html). So each extra block is folded into the source's
// block for its path, its Link joined onto that block's Link with ", ", and
// only a path the source does not have is appended.
function joinHeaderBlocks(base, extra) {
  if (!extra.trim()) return base;
  const lines = base.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const added = [];
  for (const block of extra.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
    const [route, ...rest] = block.split('\n');
    const at = lines.indexOf(route);
    if (at === -1) { added.push(block); continue; }
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
    for (const line of rest.map((l) => l.trim())) {
      const name = line.slice(0, line.indexOf(':'));
      const value = line.slice(line.indexOf(':') + 1).trim();
      const own = lines.slice(at + 1, end).findIndex((l) => l.trim().startsWith(name + ':'));
      if (own === -1) {
        lines.splice(end, 0, '  ' + name + ': ' + value);
        end += 1;
      } else {
        lines[at + 1 + own] += ', ' + value;
      }
    }
  }
  return lines.join('\n') + '\n' + (added.length ? '\n' + added.join('\n\n') + '\n' : '');
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
// every app route is answered with it: the APP_ROUTES copies, the 200 rules
// in _redirects, /i/<token> in the middleware, and 404.html), and
// <route>.html for the rest, which Pages serves at the slashless path. Only
// this Pages build does it: the iOS build runs scripts/build.js alone and
// never sees this step.
//
// The page then boots on top of its own snapshot: src/index.js sees
// data-prerendered on #root, waits for the page's chunk, and renders once,
// replacing the HTML with the same DOM, so the Loading screen never covers it.
//
// A failure here is never fatal. Without a snapshot the route is served as
// before, client-rendered from index.html: finishOutput writes the shell
// under the snapshot's name, since the route is a file and nothing else
// answers it.
//
// Every page here but "/" writes its own link card (src/website/shareCard.js)
// from the effect that sets its title, so the snapshot is also what gives
// iMessage, LinkedIn and Slack that page's title instead of index.html's.
// marketingRouteMetadata.test.js fails if a route is added without one.
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

// THE APP'S EXACT ROUTES, AS FILES. Pages answers a path with no file and no
// _redirects rule with build/404.html and a 404, so every exact path
// src/index.js routes, beyond the prerendered ones, gets a copy of
// index.html named for it. Pages serves <route>.html at the slashless path,
// under that path's own _headers, and answers /<route>/ and /<route>.html
// with a 308 to it, as it already did for the prerendered pages.
//
// Files rather than 200 rules in _redirects: Pages does not apply
// _redirects to "requests served by Pages Functions"
// (developers.cloudflare.com/pages/configuration/redirects/), with no
// exception for one the Function hands on with next(), and /support,
// /privacy and /terms run the middleware for the AI crawler rule. A file is
// found either way. The routes that carry an id (/app/<screen>, /checkin/<place>,
// /f/<id>, /flock/<id>, /dm/<id>) are 200 rules in cloudflare/_redirects, and
// /i/<token> is answered by functions/_middleware.js. The route table these
// hold to is src/index.js; cloudflarePagesFunctions.test.js reads it and
// fails on any route that would not answer 200.
const APP_ROUTES = [
  // The help and legal pages, then the web-only pages (PAGES in src/index.js).
  '/support', '/privacy', '/terms', '/guidelines', '/delete-account',
  '/pro', '/tap',
  // The app's own entry, signup, and the two standalone pages the reset and
  // verification emails link to (APP_PATHS and their branches).
  '/app', '/signup', '/reset-password', '/verify-email',
  // The invite page with no token ("that link isn't complete"), which the
  // middleware also answers /i/<token> with, and the moderation console.
  '/i', '/admin/moderation',
  // Sign in with Apple's registered return URL for the website. Apple's
  // popup posts its answer back to the page and never loads this URL
  // (src/components/auth/AppleSignInButton.js), and src/index.js routes
  // nothing here, but the URL on the Services ID stays answerable.
  '/auth/apple/callback',
];

// HOW PAGES ANSWERS A PATH. A model of the static asset server that serves
// build/, reduced to what decides the status and the file: workers-sdk's
// pages-shared/asset-server/handler.ts (generateHandler) and the _redirects
// parser, as wrangler 4.151.3 carries them for `wrangler pages dev`. The
// build checks its rewrites with it (checkRedirects) and the tests hold the
// output to it.
// 1. _redirects comes first, before any file. An exact rule (no * and no
//    :placeholder, above every rule that has one) for the path itself wins;
//    otherwise the first other rule that matches, in file order. A 200 is a
//    rewrite: the URL stays, and the file is looked up at the rule's target.
//    Any other status is a redirect.
// 2. Only GET and HEAD get past that.
// 3. The file, with Pages' handling of .html and trailing slashes: /x serves
//    x.html; /x/ serves x/index.html, or redirects to /x when x.html is the
//    file; /x.html and /x/index redirect to the clean URL.
// 4. No file: the nearest 404.html up the path's folders, with a 404 (and
//    Pages then replaces any Cache-Control _headers gave it with no-store);
//    with no 404.html anywhere up the path, index.html with a 200, the
//    single-page-app fallback.
// Left out: the preservation cache (a file a deployment of the last week
// served at the path answers in place of the 404), rules for a named host,
// conditional requests, content negotiation and headers.
const REDIRECT_STATUSES = new Set([200, 301, 302, 303, 307, 308]);

// pages-shared generateRuleRegExp: * is the splat, :name one path segment.
function ruleRegExp(rule) {
  const source = rule.split('*').map((part) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('(?<splat>.*)')
    .replace(/:([A-Za-z]\w*)/g, '(?<$1>[^/]+)');
  return new RegExp('^' + source + '$');
}

// The rules as Pages keeps them: exact ones by path, the rest in order. A
// rule wrangler drops (a bad status, a repeated path, a folder sent to an
// index file, which loops) is dropped here too.
function parseRedirects(text) {
  const staticRules = new Map();
  const rules = [];
  const seen = new Set();
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.replace(/\s+#.*$/, '').split(/\s+/);
    if (tokens.length < 2 || tokens.length > 3) continue;
    const [from, to, code = '302'] = tokens;
    const status = Number(code);
    const relative = !/^https:\/\//.test(to);
    const loops = relative && /\/index(\.html)?$/.test(to) && (from.endsWith('/*') || from.endsWith('/'));
    if (!from.startsWith('/') || !REDIRECT_STATUSES.has(status) || loops || seen.has(from)) continue;
    seen.add(from);
    const exact = !from.includes('*') && !/:[A-Za-z]\w*/.test(from);
    if (exact && !rules.length) staticRules.set(from, { from, to, status });
    else rules.push({ from, to, status, test: ruleRegExp(from) });
  }
  return { staticRules, rules };
}

function matchRedirect({ staticRules, rules }, pathname) {
  if (staticRules.has(pathname)) return { ...staticRules.get(pathname), groups: {} };
  for (const rule of rules) {
    const match = rule.test.exec(pathname);
    if (match) return { ...rule, groups: match.groups || {} };
  }
  return null;
}

// `target` is a path with its query; `files` the set of served paths
// ("/index.html", "/static/js/main.1a2b.js"); `redirects` the _redirects text
// or parseRedirects' answer. Returns { status, file } for a file served and
// { status, location } for a redirect.
function pagesAnswer(target, { files, redirects, method = 'GET' }) {
  const url = new URL(target, 'https://pages.invalid');
  const parsed = typeof redirects === 'string' ? parseRedirects(redirects) : redirects;
  let pathname = url.pathname;
  const rule = matchRedirect(parsed, pathname);
  if (rule) {
    let to = rule.to;
    for (const [name, value] of Object.entries(rule.groups)) to = to.split(':' + name).join(value);
    const destination = new URL(to, url);
    if (rule.status !== 200) return { status: rule.status, location: destination.pathname + (destination.search || url.search) };
    pathname = destination.pathname;
  }
  if (!/^(GET|HEAD)$/i.test(method)) return { status: 405 };
  try { pathname = decodeURIComponent(pathname); } catch (err) { /* looked up as sent, as Pages does */ }
  const has = (p) => files.has(p);
  const moved = (p) => ({ status: 308, location: p + url.search });
  if (pathname.endsWith('/')) {
    if (has(pathname + 'index.html')) return { status: 200, file: pathname + 'index.html' };
    if (pathname.endsWith('/index/')) return moved(pathname.slice(0, -'index/'.length));
    if (has(pathname.slice(0, -1) + '.html')) return moved(pathname.slice(0, -1));
    return notFound(pathname, files);
  }
  if (has(pathname)) {
    if (!pathname.endsWith('.html')) return { status: 200, file: pathname };
    const clean = pathname.slice(0, -'.html'.length);
    if (clean.endsWith('/index')) return moved(clean.slice(0, -'index'.length));
    if (has(clean) || clean === '/') return { status: 200, file: pathname };
    return moved(clean);
  }
  if (pathname.endsWith('/index')) return moved(pathname.slice(0, -'index'.length));
  if (has(pathname + '.html')) return { status: 200, file: pathname + '.html' };
  if (has(pathname + '/index.html')) return moved(pathname + '/');
  return notFound(pathname, files);
}

function notFound(pathname, files) {
  for (let dir = pathname; dir;) {
    dir = dir.slice(0, dir.lastIndexOf('/'));
    if (files.has(dir + '/404.html')) return { status: 404, file: dir + '/404.html' };
  }
  return files.has('/index.html') ? { status: 200, file: '/index.html' } : { status: 404 };
}

// A 200 rule is a rewrite that Pages runs before it looks for a file, so one
// that matched a file's URL would hide the file: "/* / 200" would answer
// main.js with the HTML shell, and "/about / 200" would put the shell over
// the prerendered page. `files` are the served paths the output holds.
function checkRedirects(text, files) {
  const parsed = parseRedirects(text);
  for (const file of files) {
    const urls = [file];
    if (file.endsWith('/index.html')) urls.push(file.slice(0, -'index.html'.length));
    else if (file.endsWith('.html')) urls.push(file.slice(0, -'.html'.length));
    for (const url of urls) {
      const rule = matchRedirect(parsed, url);
      if (rule && rule.status === 200) {
        throw new Error('_redirects rewrites ' + url + ' ("' + rule.from + ' ' + rule.to + ' 200"), and the output serves ' + file + ' there');
      }
    }
  }
}

// The Pages files themselves are read at deploy time, never served.
const PAGES_CONFIG = new Set(['/_headers', '/_redirects', '/_routes.json', '/_worker.js']);

function servedFiles(out) {
  return filesUnder(out)
    .map((file) => '/' + path.relative(out, file).split(path.sep).join('/'))
    .filter((file) => !PAGES_CONFIG.has(file));
}

// Everything after react-scripts: the pages, the 404 page and the Pages files
// go into `out`, then the output is refused if Pages would serve it wrong.
// `prerendered` is the routes prerender() wrote, for routePreloads.
function finishOutput(out, { prerendered = [] } = {}) {
  const index = path.join(out, 'index.html');
  if (!fs.existsSync(index)) throw new Error(index + ' is missing');

  // The shell under every name it answers: a prerendered route whose
  // snapshot failed (a file, never a rewrite, so nothing else answers it),
  // each of APP_ROUTES, and 404.html (see the top of this file). An
  // existing snapshot is kept; the rest are written fresh each run.
  const shell = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(index, file);
  };
  for (const { file } of PRERENDER) {
    if (!fs.existsSync(path.join(out, file))) shell(path.join(out, file));
  }
  for (const route of APP_ROUTES) shell(path.join(out, route.slice(1) + '.html'));
  shell(path.join(out, '404.html'));

  const headers = joinHeaderBlocks(headersFile(), routePreloads(out, prerendered));
  checkHeaders(headers);
  fs.writeFileSync(path.join(out, '_headers'), headers);
  fs.copyFileSync(path.join(CONFIG, '_redirects'), path.join(out, '_redirects'));

  checkRoutes(JSON.parse(fs.readFileSync(path.join(CONFIG, '_routes.json'), 'utf8')));
  fs.copyFileSync(path.join(CONFIG, '_routes.json'), path.join(out, '_routes.json'));

  fs.mkdirSync(path.join(out, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(out, '.well-known', 'apple-app-site-association'), appSiteAssociation());

  const files = servedFiles(out);
  checkRedirects(fs.readFileSync(path.join(CONFIG, '_redirects'), 'utf8'), files);
  const maps = files.filter((file) => file.endsWith('.map'));
  if (process.env.CF_PAGES && maps.length) {
    throw new Error(maps.length + ' source maps in the output; leave GENERATE_SOURCEMAP unset (or false) on a Pages build');
  }
}

module.exports = {
  outputDir, checkHeaders, headersFile, checkRoutes, appSiteAssociation, finishOutput, routePreloads, joinHeaderBlocks,
  servableSnapshot, paintFirst, prerender, ROUTE_CHUNKS, PRERENDER, MAX_HEADER_RULES, MAX_HEADER_LINE,
  APP_ROUTES, parseRedirects, pagesAnswer, checkRedirects, servedFiles,
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
