// Run: node --test  (from backend/)
//
// Cost-abuse and caching-correctness sweep of the Google Places proxy
// (routes/venueSearch.js — mounted at /api/venues; routes/venues.js is the
// vote routes and has no Google code). Every miss on this surface is a real
// invoice line, so the questions here are all money questions:
//
//   1. STAMPEDE. N concurrent requests for the same uncached key must collapse
//      to ONE upstream call and ONE budget unit. Before the in-flight
//      coalescing, the cache only helped requests that arrived after the first
//      one finished — a hot venue's photo or a shared search burned N paid
//      calls in the gap.
//   2. KEY VARIATION. Casing, whitespace runs, lat/lng jitter and appended
//      junk params are the same question and must land on the same cache
//      entry. Every variant that minted its own key minted its own paid call.
//   3. HONEST KEYS. What is cached under a key must be what that key says:
//      the snapped location in the key is now also what is sent to Google,
//      and a location that parses to garbage is ignored outright instead of
//      sharing the no-location key while sending Google a locationBias of
//      nulls (a paid call spent on a guaranteed error).
//   4. PHOTO PROXY. Dimensions snap to two sizes (a 4000px ask is a 400px
//      fetch), the ref is a structural resource name so the proxy can never
//      be steered at a non-Google URL, and the per-IP table can no longer be
//      reset by flooding it past its ceiling.
//   5. FAILURE IS NOT AN ANSWER. An upstream error reaches every coalesced
//      waiter as a clean 502/500, is never written to the cache, and the next
//      request goes back upstream.
//
// The tests drive the real router against the REAL ledger
// (utils/placesBudget.js), same harness as venueSearchOffset.test.js.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'places-proxy-abuse-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.TICKETMASTER_API_KEY;
delete process.env.PAYWALL_ENABLED;

// --- the real spending ledger ----------------------------------------------
const { placesBudgetStatus, __resetPlacesBudget } = require('../utils/placesBudget');

// --- scripted pg ------------------------------------------------------------
const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

// --- stubbed collaborators (destructured at load, so patch before require) ---
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

// --- Google, faked ----------------------------------------------------------
const PLACE = {
  id: 'PLACE_A',
  displayName: { text: 'The Bar' },
  formattedAddress: '1 Main St',
  rating: 4.4,
  userRatingCount: 120,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  types: ['bar'],
  photos: [{ name: 'places/PLACE_A/photos/PHOTOREF' }],
  location: { latitude: 39.74, longitude: -104.98 },
  currentOpeningHours: { openNow: true, periods: [] },
  utcOffsetMinutes: -480,
};

let googleCalls = [];      // { url, body } — every upstream fetch the router makes
let googleImpl = null;     // per-test override; return a response or null for default
let holdUpstream = null;   // set to a Promise to park upstream responses (stampede tests)

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  googleCalls.push({ url: u, body: opts && opts.body ? String(opts.body) : null });
  if (holdUpstream) await holdUpstream;
  if (googleImpl) {
    const r = googleImpl(u, opts);
    if (r) return r;
  }
  if (u.startsWith('https://places.googleapis.com/')) {
    if (u.includes('/media')) {
      return { ok: true, status: 200, json: async () => ({ photoUri: 'https://cdn.example/photo.jpg' }) };
    }
    if (u.includes(':searchText')) {
      return { ok: true, status: 200, json: async () => ({ places: [PLACE] }) };
    }
    return { ok: true, status: 200, json: async () => PLACE };
  }
  if (u.startsWith('https://cdn.example/')) {
    return {
      ok: true, status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(4),
    };
  }
  throw new Error(`unexpected upstream fetch: ${u}`);
};
test.after(() => { global.fetch = realFetch; });

// --- the router (required AFTER every stub above) ---------------------------
const venueSearchRouter = require('../routes/venueSearch');

const app = express();
app.use(express.json());
app.use('/api/venues', venueSearchRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

// The proxy must never be steerable at a non-Google host. Checked over every
// upstream URL any test in this file caused, so a regression anywhere trips it.
const allUpstreamUrls = [];
test.afterEach(() => {
  for (const c of googleCalls) allUpstreamUrls.push(c.url);
});
test.after(() => {
  for (const u of allUpstreamUrls) {
    assert.ok(
      u.startsWith('https://places.googleapis.com/') || u.startsWith('https://cdn.example/'),
      `the proxy fetched a URL outside Google: ${u}`
    );
  }
});

test.beforeEach(() => {
  __resetPlacesBudget();
  googleCalls = [];
  googleImpl = null;
  holdUpstream = null;
  venueSearchRouter.__test?.resetPhotoBudget?.();
});

async function get(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Module-level caches survive across tests, so every test uses fresh keys.
let seq = 0;
const uniq = () => `u${Date.now().toString(36)}${seq++}`;
const searchCalls = () => googleCalls.filter((c) => c.url.includes(':searchText'));
const detailCalls = () => googleCalls.filter((c) => /\/v1\/places\/[^:]/.test(c.url) && !c.url.includes('/media'));
const mediaCalls = () => googleCalls.filter((c) => c.url.includes('/media'));

// ===========================================================================
// 1. Key variation cannot mint extra paid calls
// ===========================================================================

test('casing, whitespace runs and padding are one cache entry and one paid call', async () => {
  const q = `bars downtown ${uniq()}`;
  const variants = [
    q,
    q.toUpperCase(),
    q.replace(' ', '   '),            // internal whitespace run
    ` ${q} `,                          // padding
    q.replace(' ', '\t'),              // a tab is whitespace too
  ];
  for (const v of variants) {
    const res = await get(`/api/venues/search?query=${encodeURIComponent(v)}`);
    assert.strictEqual(res.status, 200, res.text);
  }
  assert.strictEqual(searchCalls().length, 1,
    `5 spellings of one question cost ${searchCalls().length} paid calls`);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 1);
});

test('lat/lng jitter inside the coarse grid shares one cache entry', async () => {
  const q = `pizza ${uniq()}`;
  await get(`/api/venues/search?query=${encodeURIComponent(q)}&location=39.7401,-104.9799`);
  await get(`/api/venues/search?query=${encodeURIComponent(q)}&location=39.7449,-104.9751`);
  await get(`/api/venues/search?query=${encodeURIComponent(q)}&location=39.74,-104.98`);
  assert.strictEqual(searchCalls().length, 1, 'jittered coordinates re-bought the same answer');
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 1);
});

test('appended junk params change nothing', async () => {
  const q = `sushi ${uniq()}`;
  await get(`/api/venues/search?query=${encodeURIComponent(q)}`);
  await get(`/api/venues/search?query=${encodeURIComponent(q)}&foo=bar&maxresults=999&radius=999999&fields=secret`);
  assert.strictEqual(searchCalls().length, 1);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 1);

  const pid = `PLACE_JUNK_${uniq().toUpperCase()}`;
  await get(`/api/venues/details?place_id=${pid}`);
  await get(`/api/venues/details?place_id=${pid}&foo=1&fieldmask=*`);
  assert.strictEqual(detailCalls().length, 1);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 2);
});

// ===========================================================================
// 2. The cache key and the Google request always agree about location
// ===========================================================================

test('the location sent to Google is the snapped value the cache key uses', async () => {
  const q = `tacos ${uniq()}`;
  const res = await get(`/api/venues/search?query=${encodeURIComponent(q)}&location=39.7449,-104.9751`);
  assert.strictEqual(res.status, 200, res.text);
  const body = JSON.parse(searchCalls()[0].body);
  assert.deepStrictEqual(body.locationBias.circle.center, { latitude: 39.74, longitude: -104.98 },
    'raw low decimals reached Google while the cache key was coarse — the cached answer lies about its key');
});

test('a garbage location is ignored, not sent to Google as nulls', async () => {
  const q = `ramen ${uniq()}`;
  const res = await get(`/api/venues/search?query=${encodeURIComponent(q)}&location=abc,def`);
  assert.strictEqual(res.status, 200, res.text);
  const body = JSON.parse(searchCalls()[0].body);
  assert.strictEqual(body.locationBias, undefined,
    'a paid call was spent on a locationBias of NaN/null — a guaranteed upstream error');
});

test('out-of-range coordinates are ignored too', async () => {
  const q = `wings ${uniq()}`;
  const res = await get(`/api/venues/search?query=${encodeURIComponent(q)}&location=999,999`);
  assert.strictEqual(res.status, 200, res.text);
  const body = JSON.parse(searchCalls()[0].body);
  assert.strictEqual(body.locationBias, undefined, 'latitude 999 is not a place on Earth');
});

test('a repeated location param (an array) degrades to no location instead of a 500', async () => {
  const q = `coffee ${uniq()}`;
  const res = await get(`/api/venues/search?query=${encodeURIComponent(q)}&location=1,2&location=3,4`);
  assert.strictEqual(res.status, 200, res.text);
  const body = JSON.parse(searchCalls()[0].body);
  assert.strictEqual(body.locationBias, undefined);
});

test('an overlong or array-valued query is refused before it costs anything', async () => {
  const long = await get(`/api/venues/search?query=${'a'.repeat(120)}`);
  assert.strictEqual(long.status, 400);
  const arr = await get(`/api/venues/search?query=a&query=b`);
  assert.strictEqual(arr.status, 400);
  assert.strictEqual(googleCalls.length, 0);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 0);
});

test('duplicated place_id / ref params are refused, never joined into a paid URL', async () => {
  // `?place_id=A&place_id=B` arrives as an array. If the shape checks ever
  // start validating each element instead of the whole value (express-validator
  // per-item semantics), the handler would interpolate "A,B" into the Google
  // URL — a paid call on a string that cannot be a real id. The refusal is
  // what keeps that impossible, so it is pinned.
  const dupId = await get('/api/venues/details?place_id=AAAAAAAA&place_id=BBBBBBBB');
  assert.strictEqual(dupId.status, 400, dupId.text);
  const ref = encodeURIComponent('places/x/photos/a');
  const dupRef = await get(`/api/venues/photo?ref=${ref}&ref=${encodeURIComponent('places/x/photos/b')}`);
  assert.strictEqual(dupRef.status, 400, dupRef.text);
  assert.strictEqual(googleCalls.length, 0);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 0);
});

// ===========================================================================
// 3. Stampede: concurrent identical misses collapse to one upstream call
// ===========================================================================

test('8 concurrent searches for one uncached query are 1 paid call and 1 unit', async () => {
  let release;
  holdUpstream = new Promise((r) => { release = r; });
  const q = `stampede ${uniq()}`;
  const reqs = Promise.all(Array.from({ length: 8 }, () =>
    get(`/api/venues/search?query=${encodeURIComponent(q)}`)));
  await waitFor(() => searchCalls().length >= 1);
  await new Promise((r) => setTimeout(r, 50)); // let the rest of the 8 latch on
  release();
  holdUpstream = null;

  const results = await reqs;
  for (const r of results) assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(searchCalls().length, 1,
    `${searchCalls().length} upstream calls for one question asked 8 times at once`);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 1, 'one call is one unit, not eight');
  const first = JSON.stringify(results[0].body);
  for (const r of results) {
    assert.strictEqual(JSON.stringify(r.body), first, 'every waiter must get the same answer');
  }
});

test('8 concurrent details for one uncached place are 1 paid call and 1 unit', async () => {
  let release;
  holdUpstream = new Promise((r) => { release = r; });
  const pid = `PLACE_STAMPEDE_${uniq().toUpperCase()}`;
  const reqs = Promise.all(Array.from({ length: 8 }, () =>
    get(`/api/venues/details?place_id=${pid}`)));
  await waitFor(() => detailCalls().length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  release();
  holdUpstream = null;

  const results = await reqs;
  for (const r of results) assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(detailCalls().length, 1);
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 1);
});

test('8 concurrent requests for one uncached photo are 1 metadata call and 1 unit', async () => {
  let release;
  holdUpstream = new Promise((r) => { release = r; });
  const ref = encodeURIComponent(`places/PLACE_A/photos/${uniq()}`);
  const reqs = Promise.all(Array.from({ length: 8 }, () =>
    get(`/api/venues/photo?ref=${ref}&maxwidth=400`)));
  await waitFor(() => mediaCalls().length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  release();
  holdUpstream = null;

  const results = await reqs;
  for (const r of results) assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(mediaCalls().length, 1,
    'a hot venue photo must not cost one metadata call per viewer');
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1);
});

// ===========================================================================
// 4. Failure reaches every waiter cleanly and is never pinned into the cache
// ===========================================================================

test('a Google error fans out as 502 to every concurrent waiter, charged once, and the next request retries', async () => {
  googleImpl = (u) => {
    if (u.includes(':searchText')) {
      return { ok: false, status: 500, json: async () => ({ error: { status: 'INTERNAL', message: 'boom' } }) };
    }
    return null;
  };
  let release;
  holdUpstream = new Promise((r) => { release = r; });
  const q = `failing ${uniq()}`;
  const reqs = Promise.all(Array.from({ length: 4 }, () =>
    get(`/api/venues/search?query=${encodeURIComponent(q)}`)));
  await waitFor(() => searchCalls().length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  release();
  holdUpstream = null;

  const results = await reqs;
  for (const r of results) assert.strictEqual(r.status, 502, r.text);
  assert.strictEqual(searchCalls().length, 1, 'four waiters, one failed upstream call');
  assert.strictEqual(placesBudgetStatus(7).globalUsed, 1);

  // The failure must not be a negative cache entry: the next request retries.
  googleImpl = null;
  const retry = await get(`/api/venues/search?query=${encodeURIComponent(q)}`);
  assert.strictEqual(retry.status, 200, 'the failure was pinned into the cache');
  assert.strictEqual(searchCalls().length, 2, 'the retry never went back upstream');
});

test('a non-JSON upstream body is a clean 500, not a crash, and is not cached', async () => {
  googleImpl = (u) => {
    if (u.includes(':searchText')) {
      return { ok: false, status: 502, json: async () => { throw new Error('<html>bad gateway</html> is not JSON'); } };
    }
    return null;
  };
  const q = `htmlerr ${uniq()}`;
  const res = await get(`/api/venues/search?query=${encodeURIComponent(q)}`);
  assert.strictEqual(res.status, 500, res.text);

  googleImpl = null;
  const retry = await get(`/api/venues/search?query=${encodeURIComponent(q)}`);
  assert.strictEqual(retry.status, 200, 'the server did not survive, or pinned the failure');
});

test('a photo metadata failure is not cached: the next request goes back upstream', async () => {
  googleImpl = (u) => {
    if (u.includes('/media')) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    return null;
  };
  const ref = encodeURIComponent(`places/PLACE_A/photos/${uniq()}`);
  const first = await get(`/api/venues/photo?ref=${ref}&maxwidth=400`);
  assert.strictEqual(first.status, 502, first.text);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 1, 'charge-before-call: the failed ask was still paid for');

  googleImpl = null;
  const second = await get(`/api/venues/photo?ref=${ref}&maxwidth=400`);
  assert.strictEqual(second.status, 200, 'the 429 was pinned as this photo forever');
  assert.strictEqual(mediaCalls().length, 2);
});

// ===========================================================================
// 5. Photo proxy: dimensions, ref structure, per-IP table hygiene
// ===========================================================================

test('a 4000px ask is snapped: at most two sizes per ref ever reach Google', async () => {
  const raw = `places/PLACE_A/photos/${uniq()}`;
  const ref = encodeURIComponent(raw);
  const big = await get(`/api/venues/photo?ref=${ref}&maxwidth=4000`);
  assert.strictEqual(big.status, 200, big.text);
  assert.match(mediaCalls()[0].url, /maxWidthPx=400&/,
    'the requested 4000px must be snapped before it reaches Google');
  assert.ok(!mediaCalls()[0].url.includes('4000'));

  // 763 snaps to the same 400 bucket: cache hit, no new call, no new charge.
  await get(`/api/venues/photo?ref=${ref}&maxwidth=763`);
  assert.strictEqual(mediaCalls().length, 1);

  // The thumbnail bucket is the only other size this ref can ever cost.
  await get(`/api/venues/photo?ref=${ref}&maxwidth=160`);
  await get(`/api/venues/photo?ref=${ref}&maxwidth=-5`);
  await get(`/api/venues/photo?ref=${ref}&maxwidth=1`);
  assert.strictEqual(mediaCalls().length, 2, 'one ref must cap out at two cache entries');
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 2);
});

test('the photo proxy cannot be steered at a non-Google URL', async () => {
  const PROBES = [
    'https://evil.example/steal',
    '//evil.example/x',
    'places/PLACE_A/photos/ok?photoUri=https://evil.example',
    'places/../../v1/anything',
    'places/PLACE_A/photos/a/../b',
  ];
  for (const probe of PROBES) {
    const res = await get(`/api/venues/photo?ref=${encodeURIComponent(probe)}`);
    assert.strictEqual(res.status, 400, `${probe}: ${res.text}`);
  }
  assert.strictEqual(googleCalls.length, 0, 'a probe reached the network');
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 0);
  // The catch-all upstream assertion in test.after() covers the whole file.
});

test('photo responses carry cache headers so clients and CDNs stop re-asking', async () => {
  const ref = encodeURIComponent(`places/PLACE_A/photos/${uniq()}`);
  const res = await realFetch(`${base}/api/venues/photo?ref=${ref}&maxwidth=400`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /max-age=\d+/);
  await res.arrayBuffer();
});

test('flooding the per-IP photo table cannot reset an exhausted counter', () => {
  const t = venueSearchRouter.__test;
  assert.ok(t && t.allowPhotoFetch, 'venueSearch must export its photo gate for this pin');
  t.resetPhotoBudget();

  // Spend the attacker's whole hourly allowance.
  for (let i = 0; i < 300; i++) {
    assert.strictEqual(t.allowPhotoFetch({ ip: 'attacker' }), true, `hit ${i} refused early`);
  }
  assert.strictEqual(t.allowPhotoFetch({ ip: 'attacker' }), false);

  // Flood the table past its ceiling with fresh addresses. The daily photo
  // budget refuses along the way; rolling the day (what a UTC midnight does —
  // the IP table survives it) lets the flood continue, exactly as a multi-day
  // accumulation would.
  let n = 0;
  let guard = 0;
  while (n < 5200) {
    if (++guard > 20000) throw new Error('flood loop stuck');
    if (t.allowPhotoFetch({ ip: `flood-${n}` })) n++;
    else t.resetPhotoBudget({ clearIps: false });
  }

  // Fresh day, so the only thing that can refuse the attacker now is their own
  // per-IP history — which a wholesale clear() would have wiped.
  t.resetPhotoBudget({ clearIps: false });
  assert.strictEqual(t.allowPhotoFetch({ ip: 'attacker' }), false,
    'a flood of fresh addresses handed every throttled address a new allowance');
});
