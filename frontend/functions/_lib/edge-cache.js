// Vercel's CDN cached a function's answer when it sent s-maxage. Pages runs
// Functions in front of the cache (developers.cloudflare.com/workers/reference/how-the-cache-works/),
// so nothing a Function returns is cached unless the Function stores it. This
// keeps Vercel's rule: a 200 whose Cache-Control carries s-maxage=N is kept in
// this data center's cache for N seconds under `key`; anything else, every
// private/no-store fallback included, is never stored.
//
// The stored copy carries max-age=N for the cache's own expiry, and the
// handler's original Cache-Control and Vary go back on when it is served.
const S_MAXAGE = /(?:^|[,\s])s-maxage=(\d+)/i;
const KEEP_CACHE_CONTROL = 'X-Flock-Cache-Control';
const KEEP_VARY = 'X-Flock-Vary';

function restore(stored) {
  const res = new Response(stored.body, stored);
  const cacheControl = res.headers.get(KEEP_CACHE_CONTROL);
  const vary = res.headers.get(KEEP_VARY);
  res.headers.delete(KEEP_CACHE_CONTROL);
  res.headers.delete(KEEP_VARY);
  if (cacheControl) res.headers.set('Cache-Control', cacheControl);
  if (vary) res.headers.set('Vary', vary);
  return res;
}

export async function edgeCached(context, key, produce) {
  const method = context.request.method;
  if (method !== 'GET' && method !== 'HEAD') return produce();
  const cache = caches.default;
  const cacheKey = new Request(key, { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) return restore(hit);

  const res = await produce();
  const cacheControl = res.headers.get('Cache-Control') || '';
  const match = S_MAXAGE.exec(cacheControl);
  if (method === 'GET' && res.status === 200 && match && Number(match[1]) > 0) {
    const stored = new Response(res.clone().body, res);
    stored.headers.set(KEEP_CACHE_CONTROL, cacheControl);
    const vary = stored.headers.get('Vary');
    if (vary) stored.headers.set(KEEP_VARY, vary);
    stored.headers.delete('Vary');
    stored.headers.set('Cache-Control', 'public, max-age=' + match[1]);
    context.waitUntil(cache.put(cacheKey, stored).catch(() => {}));
  }
  return res;
}
