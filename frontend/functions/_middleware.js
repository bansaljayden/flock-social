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
// order. vercel.json's last rewrite, "/(.*)" to /index.html, is Pages' own
// behaviour when the build has no top-level 404.html.
import SECURITY from '../cloudflare/security-headers.json';
import USER_AGENTS from '../cloudflare/user-agents.json';
import { marketingPage, invitePreview, demoRelay } from './_lib/handlers.js';
import { withByteRanges } from './_lib/range.js';

const PREVIEW_BOT_UA = new RegExp('(?:' + USER_AGENTS.previewBots + ')');
const AI_CRAWLER_UA = new RegExp('(?:' + USER_AGENTS.aiCrawlers + ')');

// vercel.json "/i/:token": exactly one path segment, so /i, /i/ and /i/a/b
// fall through to the SPA and its "that link isn't complete" state.
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
  Link: '<https://www.flockcorp.com/>; rel="canonical", </screenshots/nest-dark@2x.webp>; rel=preload; as=image; type="image/webp"; fetchpriority=high',
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

export async function onRequest(context) {
  // If anything below throws, Pages serves the static answer for this path:
  // the SPA shell, which is what these routes served before the bot rules.
  context.passThroughOnException();

  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const ua = request.headers.get('User-Agent') || '';

  // vercel.json:265-276. "permanent": false is a 307 on Vercel.
  if (path === '/' && AI_CRAWLER_UA.test(ua)) {
    return finish(new Response(null, { status: 307, headers: { Location: '/landing' + url.search, ...ROOT_HEADERS } }), url);
  }

  // vercel.json:288-303, in that order: ?open wins over the bot check.
  const invite = INVITE.exec(path);
  if (invite) {
    if (url.searchParams.has('open') || !PREVIEW_BOT_UA.test(ua)) return context.next();
    return finish(await invitePreview(context, invite[1], url.searchParams), url);
  }

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

  // /api/* reaches its file in functions/api/ (or the SPA, for a name with
  // no file, as on Vercel); every other listed path reaches the static asset
  // server, which applies _headers.
  const res = await context.next();
  return path.startsWith('/api/') ? finish(res, url) : res;
}
