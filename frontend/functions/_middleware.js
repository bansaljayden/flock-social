// The vercel.json rules that look at the User-Agent or the query string, and
// the security headers on every response a Function builds.
//
// Runs only for the paths in cloudflare/_routes.json. Everything else (JS,
// CSS, images, fonts, every other SPA route) is served by Pages straight from
// build/: free, unmetered, with _headers applied. _redirects and _headers
// match on the path alone, which is why these rules live in code.
//
// Rule order follows vercel.json: the crawler redirect on "/" first (Vercel
// ran redirects before the filesystem), then the rewrites in their listed
// order. vercel.json's last rewrite, "/(.*)" to /index.html, is gone on
// purpose: a path that is neither a file nor a _redirects rule gets
// build/404.html, the app shell, with a 404 (scripts/build-cloudflare.js).
// Pages does not apply _redirects to "requests served by Pages Functions",
// so every path here that the app answers is a file or is answered here.
import SECURITY from '../cloudflare/security-headers.json';
import USER_AGENTS from '../cloudflare/user-agents.json';
import { marketingPage, invitePreview, demoRelay } from './_lib/handlers.js';
import { withByteRanges } from './_lib/range.js';

const PREVIEW_BOT_UA = new RegExp('(?:' + USER_AGENTS.previewBots + ')');
const AI_CRAWLER_UA = new RegExp('(?:' + USER_AGENTS.aiCrawlers + ')');

// vercel.json "/i/:token": exactly one path segment, so /i, /i/ and /i/a/b
// get the app and its "that link isn't complete" state, never a preview.
const INVITE = /^\/i\/([^/]+)$/;

// vercel.json "/relay/public/:path*": zero or more segments.
const RELAY = /^\/relay\/public(?:\/(.*))?$/;

// vercel.json "/landing" and "/:page(about|support|privacy|terms)".
const MARKETING = {
  '/landing': 'home',
  '/about': 'about',
  '/support': 'support',
  '/privacy': 'privacy',
  '/terms': 'terms',
};

// vercel.json:74-80, the "/" rule, which Vercel also put on the redirect.
const ROOT_HEADERS = {
  Link: '<https://www.flockcorp.com/>; rel="canonical", </screenshots/home-reel-v2.avif>; rel=preload; as=image; type="image/avif"; fetchpriority=high',
  'Cache-Control': 'public, max-age=0, must-revalidate',
};

// What Vercel did to a Function's response on its way out:
// - the /(.*) security headers, unless the handler set its own value;
// - X-Robots-Tag: noindex on the marketing function's own URL (vercel.json:256-261);
// - a Cache-Control carrying s-maxage went to the client as
//   "public, max-age=0, must-revalidate" (vercel.com/docs/headers/response-headers).
// Plus noindex on any *.pages.dev host, which is a duplicate of the site.
function finish(response, url) {
  const res = new Response(response.body, response);
  const headers = res.headers;
  for (const [name, value] of SECURITY.headers) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (/(?:^|[,\s])s-maxage=/i.test(headers.get('Cache-Control') || '')) {
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  if (url.pathname === '/api/marketing-page' && !headers.has('X-Robots-Tag')) {
    headers.set('X-Robots-Tag', 'noindex');
  }
  if (url.hostname.endsWith('.pages.dev') && !/noindex/i.test(headers.get('X-Robots-Tag') || '')) {
    headers.set('X-Robots-Tag', 'noindex');
  }
  return res;
}

// The guest invite page, for every path under /i/ (src/index.js routes
// p.startsWith('/i/')). Only /i itself is a file: build/i.html, the app
// shell, served under /i's own block in _headers, which is the /i/* block
// line for line (private, no-store, noindex, no-referrer). A token is a path
// no file has, and a _redirects rewrite is not applied to a request a
// Function serves, so without this every invite link would get
// build/404.html and a 404.
function inviteShell(context, request) {
  return context.env.ASSETS.fetch(new Request(new URL('/i', request.url), request));
}

// build/404.html at its own two URLs. Pages answers /404 with that file and
// a 200 (and /404.html with a 308 to /404), which would make the not-found
// page the one unknown path that says 200. Fetched fresh, without the
// visitor's conditional headers, so it always comes back with its body.
async function notFoundPage(context, url) {
  const page = await context.env.ASSETS.fetch(new Request(new URL('/404', url)));
  const res = new Response(page.body, { status: 404, statusText: 'Not Found', headers: page.headers });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.delete('ETag');
  return finish(res, url);
}

export async function onRequest(context) {
  // If anything below throws, Pages serves the static answer for this path:
  // the file there, which for "/", /i and the marketing paths is the page
  // they served before the bot rules, or for a path with no file, an invite
  // token included, the 404 page: the app shell, under a 404.
  context.passThroughOnException();

  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const ua = request.headers.get('User-Agent') || '';

  // vercel.json:265-276. "permanent": false is a 307 on Vercel.
  if (path === '/' && AI_CRAWLER_UA.test(ua)) {
    return finish(new Response(null, { status: 307, headers: { Location: '/landing' + url.search, ...ROOT_HEADERS } }), url);
  }

  // "/" for everyone else: the home page as real HTML. The Pages build writes
  // it to build/landing.html (scripts/build-cloudflare.js prerender), because
  // index.html has to stay the empty shell every app route is answered with,
  // so "/" is answered with the /landing asset under "/"'s own headers. The
  // build writes the shell there when the snapshot fails, so the file is
  // always present; if it is not, Pages answers /landing with its 404 page,
  // and "/" takes index.html instead, which is what it served before. If this
  // throws, passThroughOnException serves the shell too.
  if (path === '/') {
    let home = await context.env.ASSETS.fetch(new Request(new URL('/landing', url), request));
    if (home.status === 404) home = await context.env.ASSETS.fetch(new Request(new URL('/', url), request));
    const res = new Response(home.body, home);
    for (const [name, value] of Object.entries(ROOT_HEADERS)) res.headers.set(name, value);
    return res;
  }

  if (path === '/404' || path === '/404.html') return notFoundPage(context, url);

  // vercel.json:288-303, in that order: ?open wins over the bot check.
  const invite = INVITE.exec(path);
  if (invite && !url.searchParams.has('open') && PREVIEW_BOT_UA.test(ua)) {
    return finish(await invitePreview(context, invite[1], url.searchParams), url);
  }
  if (path.startsWith('/i/')) return inviteShell(context, request);

  // vercel.json:304-325
  if (Object.prototype.hasOwnProperty.call(MARKETING, path)) {
    if (!AI_CRAWLER_UA.test(ua)) return context.next();
    return finish(await marketingPage(request, MARKETING[path], url.searchParams), url);
  }

  // vercel.json:326-329. The raw remainder; the handler decodes and
  // allowlists it in demoPath().
  const relay = RELAY.exec(path);
  if (relay) return finish(await demoRelay(request, relay[1] || '', url.searchParams), url);

  // The background video: byte ranges for Safari (see _lib/range.js).
  if (path === '/bg-city.mp4') return withByteRanges(request, await context.next());

  // /api/* reaches its file in functions/api/ (or the 404 page, for a name
  // with no file); every other listed path reaches the static asset server,
  // which applies _headers, and finds its file there: /i, /landing and the
  // four marketing paths are all files in build/.
  const res = await context.next();
  return path.startsWith('/api/') ? finish(res, url) : res;
}
