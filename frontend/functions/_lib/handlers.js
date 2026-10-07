// The four Node handlers in api/, called unchanged. Each export builds the req
// that handler saw on Vercel: a rewrite's path parameter first, then the
// request's own query string (Vercel merged the two, which is what the
// handlers' pickOne ambiguity rules are written against), and only the
// request headers that handler reads.
import marketingPageHandler from '../../api/marketing-page.js';
import invitePreviewHandler from '../../api/invite-preview.js';
import demoRelayHandler from '../../api/demo-relay.js';
import appSiteAssociationHandler from '../../api/apple-app-site-association.js';
import { runNodeHandler } from './node-adapter.js';
import { edgeCached } from './edge-cache.js';

function mergedQuery(first, searchParams) {
  const query = {};
  const add = (key, value) => {
    if (!Object.prototype.hasOwnProperty.call(query, key)) query[key] = value;
    else query[key] = [].concat(query[key], value);
  };
  for (const [key, value] of Object.entries(first)) add(key, value);
  for (const [key, value] of searchParams) add(key, value);
  return query;
}

function mergedUrl(pathname, first, searchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(first)) params.append(key, value);
  for (const [key, value] of searchParams) params.append(key, value);
  const qs = params.toString();
  return qs ? pathname + '?' + qs : pathname;
}

function nodeRequest(request, pathname, first, searchParams, headers) {
  return {
    method: request.method,
    url: mergedUrl(pathname, first, searchParams),
    query: mergedQuery(first, searchParams),
    headers: headers || {},
  };
}

// vercel.json:304-325 (crawler rewrites) and direct hits on the function.
export function marketingPage(request, page, searchParams) {
  const first = page === undefined ? {} : { page };
  return runNodeHandler(marketingPageHandler, nodeRequest(request, '/api/marketing-page', first, searchParams));
}

// vercel.json:293-303 (preview-bot rewrite) and direct hits. A 200 the handler
// marks s-maxage=600 is kept at the edge for those ten minutes, keyed on the
// token alone (the handler reads nothing else); every fallback is no-store
// and never kept.
export function invitePreview(context, token, searchParams) {
  const first = token === undefined ? {} : { token };
  const run = () => runNodeHandler(invitePreviewHandler, nodeRequest(context.request, '/api/invite-preview', first, searchParams));
  const tokens = [...Object.values(first), ...searchParams.getAll('token')];
  if (tokens.length !== 1) return run();
  const key = new URL('/__edge-cache/invite-preview/' + encodeURIComponent(tokens[0]), context.request.url).toString();
  return edgeCached(context, key, run);
}

// vercel.json:326-329 and direct hits. The visitor address the relay signs
// comes from CF-Connecting-IP only, passed in the x-real-ip slot that
// clientAddress() reads first. Every client-writable address header is left
// out: Cloudflare appends to a client-sent X-Forwarded-For instead of
// replacing it (developers.cloudflare.com/fundamentals/reference/http-headers/),
// so its first entry is whatever the caller typed.
export function demoRelay(request, path, searchParams) {
  const headers = {};
  const accept = request.headers.get('Accept');
  if (accept) headers.accept = accept;
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers['x-real-ip'] = ip;
  const first = path === undefined ? {} : { path };
  return runNodeHandler(demoRelayHandler, nodeRequest(request, '/api/demo-relay', first, searchParams, headers));
}

// Direct hits on /api/apple-app-site-association. The file Apple fetches,
// /.well-known/apple-app-site-association, is a static file in the build.
export function appSiteAssociation(request) {
  return runNodeHandler(appSiteAssociationHandler, nodeRequest(request, '/api/apple-app-site-association', {}, new URLSearchParams()));
}
