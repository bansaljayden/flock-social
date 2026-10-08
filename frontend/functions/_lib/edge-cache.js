// Vercel's CDN cached a function's answer when it sent s-maxage. Pages runs
// Functions in front of the cache (developers.cloudflare.com/workers/reference/how-the-cache-works/),
// so nothing a Function returns is cached unless the Function stores it. This
// keeps Vercel's rule: a 200 whose Cache-Control carries s-maxage=N is kept in
// this data center's cache for N seconds under `key`; anything else, every
// private/no-store fallback included, is never stored.
//
// The stored copy carries max-age=N for the cache's own expiry, and the
// handler's original Cache-Control and Vary go back on when it is served.
//
// GET and HEAD share one copy. produce() returns the full GET answer whatever
// the method: invite-og fetches the card with GET, and the node adapter keeps
// the body a handler writes for HEAD. The runtime drops the body on the way
// out of a HEAD. So a HEAD miss fills the cache like a GET miss, and a bot
// that checks with HEAD before it fetches costs one render, not two. (An
// answer with no body at all is never stored, so a HEAD-only answer could
// not stand in for a GET.)
//
// Misses for one key that arrive while it is being produced in this isolate
// wait for that answer instead of producing their own: a link dropped into a
// group chat brings every member's preview fetch at once, and each uncached
// card is a render on the one API instance. What they share is plain data
// (status, headers, bytes), because Workers refuse to let one request touch
// another request's Response or stream; each caller gets its own Response.
const S_MAXAGE = /(?:^|[,\s])s-maxage=(\d+)/i;
const KEEP_CACHE_CONTROL = 'X-Flock-Cache-Control';
const KEEP_VARY = 'X-Flock-Vary';

// Answers being produced in this isolate, by cache key.
const inFlight = new Map();

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

// A new Response for each caller, from the shared plain-data answer.
function answer(produced) {
  return new Response(produced.body === null ? null : produced.body.slice(0), {
    status: produced.status,
    statusText: produced.statusText,
    headers: produced.headers,
  });
}

async function produceAndKeep(context, cacheKey, produce) {
  const res = await produce();
  const produced = {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
    body: res.body === null ? null : await res.arrayBuffer(),
  };
  const cacheControl = res.headers.get('Cache-Control') || '';
  const match = S_MAXAGE.exec(cacheControl);
  if (res.status === 200 && produced.body !== null && match && Number(match[1]) > 0) {
    const stored = answer(produced);
    stored.headers.set(KEEP_CACHE_CONTROL, cacheControl);
    const vary = stored.headers.get('Vary');
    if (vary) stored.headers.set(KEEP_VARY, vary);
    stored.headers.delete('Vary');
    stored.headers.set('Cache-Control', 'public, max-age=' + match[1]);
    context.waitUntil(caches.default.put(cacheKey, stored).catch(() => {}));
  }
  return produced;
}

export async function edgeCached(context, key, produce) {
  const method = context.request.method;
  if (method !== 'GET' && method !== 'HEAD') return produce();
  const cacheKey = new Request(key, { method: 'GET' });

  const hit = await caches.default.match(cacheKey);
  if (hit) return restore(hit);

  let shared = inFlight.get(key);
  if (!shared) {
    shared = produceAndKeep(context, cacheKey, produce);
    inFlight.set(key, shared);
    const done = () => {
      if (inFlight.get(key) === shared) inFlight.delete(key);
    };
    shared.then(done, done);
    // Other requests may be waiting on this answer. If this request's client
    // goes away, the runtime cancels its work unless it is in waitUntil.
    context.waitUntil(shared.catch(() => {}));
  }
  return answer(await shared);
}
