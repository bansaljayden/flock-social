// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// Resilience + cost sweep of routes/events.js (Ticketmaster-backed).
// ---------------------------------------------------------------------------
// edgeCaseSweep.test.js already covers the §O attacks on this router
// (bad coordinates, array-shaped params, prototype-chain filter names, the
// negative TTL, budget charging). This suite covers what that one does not:
//
//   * upstream FAILURE behavior: a dead host is a 503 and never a 500 or a
//     hang; an HTTP 429/5xx degrades to an empty list; the breaker needs two
//     consecutive failures and an HTTP error never counts as one;
//   * the global day ledger actually rolling over at midnight (it did not:
//     allowUpstream pre-checked the stale count and the rollover lived only
//     inside chargeGlobal, which the failed pre-check never reached — so one
//     day at the cap locked event search out FOREVER, restart aside);
//   * the /featured top-up body parse (it was the one unguarded .json() in
//     the file, and it turned a request that already held interest-matched
//     events into a 500);
//   * stampede coalescing: N concurrent identical uncached requests must be
//     ONE paid call, ONE budget unit, and at most ONE breaker failure —
//     routes/venueSearch.js round 18, which this router had been left out of;
//   * response honesty: dates are the venue's own wall clock (Ticketmaster
//     localDate/localTime), never re-derived from server UTC, and the upstream
//     URL carries only parameters this route chose — nothing client-supplied
//     passes through unlaundered.
//
// No database and no network: pool.query and global.fetch are fixtures, the
// same plumbing as edgeCaseSweep.test.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-events-resilience';
process.env.TICKETMASTER_API_KEY = 'tm-test-key'; // routes/events.js reads this at load

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Fixture plumbing ────────────────────────────────────────────────────────
const USER = {
  id: 1, email: 'ava@example.com', name: 'Ava', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};
const AUTH_SQL = /^SELECT id, email, name, role,.*FROM users WHERE id = \$1$/i;
pool.query = (text) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) return Promise.resolve({ rows: [USER], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const realFetch = global.fetch;
let tmCalls = [];  // { url, opts } for every Ticketmaster request
let tmImpl = null; // (url, nth) -> response-ish or Promise thereof

const TM_EMPTY = { ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) };

// A raw Ticketmaster event whose venue is in Denver. The UTC instant
// (2026-08-21T01:00:00Z) is the NEXT calendar day in UTC — which is exactly
// what makes it a fixture for the timezone test: a route that derived the
// display date from dateTime in server UTC would say the 21st; the venue's
// own wall clock says the evening of the 20th.
const RAW_EVENT = {
  id: 'G5vYZ9j3fV4Ay',
  name: 'Test Show',
  url: 'https://www.ticketmaster.com/x',
  dates: {
    start: { localDate: '2026-08-20', localTime: '19:00:00', dateTime: '2026-08-21T01:00:00Z' },
    status: { code: 'onsale' },
    timezone: 'America/Denver',
  },
  classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }],
  _embedded: {
    venues: [{
      name: 'Red Rocks', city: { name: 'Morrison' }, state: { stateCode: 'CO' },
      address: { line1: '18300 W Alameda Pkwy' },
      location: { latitude: '39.6654', longitude: '-105.2057' },
    }],
  },
};
const TM_ONE = { ok: true, status: 200, json: async () => ({ _embedded: { events: [RAW_EVENT] } }) };

global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://app.ticketmaster.com/')) {
    tmCalls.push({ url: u, opts: opts || {} });
    // A throw from tmImpl becomes a REJECTED promise, matching undici, which
    // never throws synchronously from fetch().
    try { return Promise.resolve(tmImpl ? tmImpl(u, tmCalls.length) : TM_EMPTY); }
    catch (e) { return Promise.reject(e); }
  }
  return realFetch(url, opts);
};

// Router required AFTER the stubs above.
const eventsRouter = require('../routes/events');

const app = express();
app.use('/api/events', eventsRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => {
  global.fetch = realFetch;
  server.close(() => r());
}));

test.beforeEach(() => {
  tmCalls = [];
  tmImpl = null;
  eventsRouter.__test.reset();
});

async function get(pathname) {
  const res = await realFetch(base + pathname, {
    headers: { Authorization: `Bearer ${signUserToken(USER)}` },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body: json };
}

function waitFor(cond, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('waitFor timed out'));
      setTimeout(poll, 5);
    })();
  });
}

// ── Upstream failure ────────────────────────────────────────────────────────

test('failure: every Ticketmaster call carries an abort signal (the deadline exists)', async () => {
  await get('/api/events/search?location=39.74,-104.98');
  await get('/api/events/featured?location=40.70,-74.00');
  tmImpl = () => ({ ok: true, status: 200, json: async () => RAW_EVENT });
  await get('/api/events/details?id=G5vYZ9j3fV4Ay');
  assert.ok(tmCalls.length >= 3, `expected 3+ upstream calls, got ${tmCalls.length}`);
  for (const { url, opts } of tmCalls) {
    assert.ok(opts.signal instanceof AbortSignal, `no abort signal on ${url}`);
  }
});

test('failure: an unreachable upstream is a 503 on all three endpoints, never a 500', async () => {
  tmImpl = () => { throw new TypeError('fetch failed'); };
  for (const p of [
    '/api/events/search?location=39.74,-104.98',
    '/api/events/featured?location=40.70,-74.00',
    '/api/events/details?id=G5vYZ9j3fV4Ay',
  ]) {
    eventsRouter.__test.reset(); // each endpoint sees a fresh breaker
    const res = await get(p);
    assert.strictEqual(res.status, 503, `${p} -> ${res.status} ${res.text}`);
    assert.ok(res.body && res.body.error, `${p}: no error body`);
  }
});

test('failure: one timeout does not open the breaker; two in a row do; open costs nothing', async () => {
  tmImpl = () => { throw new TypeError('fetch failed'); };
  await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(eventsRouter.__test.breakerOpen(), false,
    'a single unlucky request took event search away from everybody');

  // Second consecutive failure (different key, so it is a fresh upstream call).
  await get('/api/events/search?location=45.00,-93.00');
  assert.strictEqual(eventsRouter.__test.breakerOpen(), true, 'two in a row did not open it');

  // While open: refused up front — no fetch, no budget spent.
  const callsBefore = tmCalls.length;
  const spentBefore = eventsRouter.__test.spent();
  const refused = await get('/api/events/search?location=35.00,-80.00');
  assert.strictEqual(refused.status, 503, refused.text);
  assert.strictEqual(tmCalls.length, callsBefore, 'the open breaker still called upstream');
  assert.strictEqual(eventsRouter.__test.spent(), spentBefore, 'the open breaker still charged the budget');

  // Any answer closes it.
  eventsRouter.__test.clearBreaker();
  tmImpl = null;
  const recovered = await get('/api/events/search?location=35.00,-80.00');
  assert.strictEqual(recovered.status, 200, recovered.text);
  assert.strictEqual(eventsRouter.__test.breakerOpen(), false);
});

test('failure: an HTTP 429/500 degrades to an empty 200 and never counts as a breaker failure', async () => {
  // The host ANSWERED — that is the negative cache's problem, not the
  // breaker's. Alternate 429 and 500 across consecutive requests: the breaker
  // must stay closed however many arrive.
  tmImpl = (u, nth) => ({ ok: false, status: nth % 2 ? 429 : 500, json: async () => ({}) });
  for (const loc of ['39.74,-104.98', '45.00,-93.00', '35.00,-80.00']) {
    const res = await get(`/api/events/search?location=${loc}`);
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { events: [], total: 0, degraded: true });
  }
  assert.strictEqual(eventsRouter.__test.breakerOpen(), false,
    'an HTTP error opened the unreachable-host breaker');

  const feat = await get('/api/events/featured?location=40.70,-74.00');
  assert.strictEqual(feat.status, 200, feat.text);
  assert.deepStrictEqual(feat.body, { events: [], total: 0, degraded: true });
});

test('failure: a malformed /featured top-up body keeps the events already fetched, not a 500', async () => {
  // interests=sports sets a classification filter; fewer than 5 results fires
  // the unfiltered top-up. The top-up's .json() was the one unguarded body
  // parse in the file: a truncated body threw into the outer catch, and a
  // request that ALREADY HELD interest-matched events answered 500.
  tmImpl = (u, nth) => nth === 1
    ? TM_ONE
    : { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
  const res = await get('/api/events/featured?location=40.70,-74.00&interests=sports');
  assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
  assert.strictEqual(tmCalls.length, 2, 'the top-up never ran');
  assert.strictEqual(res.body.events.length, 1,
    'the interest-matched events were thrown away with the broken top-up');
  assert.strictEqual(res.body.events[0].id, RAW_EVENT.id);
});

// ── Cost: the day ledger and the cache ──────────────────────────────────────

test('cost: the global day ledger rolls over at midnight instead of locking out forever', async () => {
  // allowUpstream pre-checked `tmDayCount + cost > TM_GLOBAL_DAILY` against
  // the STALE count; the rollover lived only inside chargeGlobal, which the
  // failed pre-check never reached. So a day that hit the 2000-call cap left
  // event search answering 429 for every user on every later day until the
  // process happened to restart.
  const { globalDaily } = eventsRouter.__test.budgetLimits;
  eventsRouter.__test.forceGlobalLedger('2000-01-01', globalDaily);
  const res = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(res.status, 200,
    `yesterday's exhausted ledger still refuses today's first request: ${res.status} ${res.text}`);
  assert.strictEqual(tmCalls.length, 1, 'the rolled-over ledger did not permit the call');
});

test('cost: an exhausted ledger for TODAY still refuses', async () => {
  const { globalDaily } = eventsRouter.__test.budgetLimits;
  eventsRouter.__test.forceGlobalLedger(new Date().toISOString().slice(0, 10), globalDaily);
  const res = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(res.status, 429, `${res.status} ${res.text}`);
  assert.deepStrictEqual(tmCalls, [], 'refused, yet still called upstream');
});

test('cost: identical queries inside the TTL are one upstream call, keys normalized', async () => {
  // Same 0.1-degree cell, same keyword up to case and whitespace: the second
  // and third requests must be answered from cache.
  const r1 = await get('/api/events/search?location=39.7412,-104.9801&query=Phish');
  assert.strictEqual(r1.status, 200, r1.text);
  const after = tmCalls.length; // keyword search = 2 calls (local + wide)
  const r2 = await get('/api/events/search?location=39.7449,-104.9777&query=%20phish%20');
  assert.strictEqual(r2.status, 200, r2.text);
  const r3 = await get('/api/events/search?location=39.70,-104.98&query=PHISH');
  assert.strictEqual(r3.status, 200, r3.text);
  assert.strictEqual(tmCalls.length, after,
    `${tmCalls.length - after} extra paid calls for the same question`);
  assert.deepStrictEqual(r2.body, r1.body);
});

test('cost: a cache hit spends nothing from any budget', async () => {
  await get('/api/events/search?location=39.74,-104.98');
  const spent = eventsRouter.__test.spent();
  await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(eventsRouter.__test.spent(), spent, 'a cache hit was charged');
});

// ── Stampede coalescing ─────────────────────────────────────────────────────

test('stampede: N concurrent identical requests are one paid call and one budget unit', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  tmImpl = () => gate.then(() => TM_ONE);

  const started = [
    get('/api/events/featured?location=40.70,-74.00'),
    get('/api/events/featured?location=40.70,-74.00'),
    get('/api/events/featured?location=40.70,-74.00'),
  ];
  // Let all three reach the route while the first call is still in flight.
  await waitFor(() => tmCalls.length >= 1);
  await new Promise((r) => setTimeout(r, 25));
  release();
  const results = await Promise.all(started);

  for (const res of results) {
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.events.length, 1, res.text);
  }
  assert.strictEqual(tmCalls.length, 1,
    `three concurrent identical requests cost ${tmCalls.length} paid Ticketmaster calls`);
  assert.strictEqual(eventsRouter.__test.spent(), 1,
    `three concurrent identical requests charged ${eventsRouter.__test.spent()} budget units`);
});

test('stampede: concurrent timeouts on one flight count as ONE breaker failure', async () => {
  // Without coalescing, one slow moment fanned out into N counted failures
  // and tripped the two-failure breaker off a single blip.
  let reject;
  const gate = new Promise((_, rj) => { reject = rj; });
  tmImpl = () => gate;

  const started = [
    get('/api/events/featured?location=40.70,-74.00'),
    get('/api/events/featured?location=40.70,-74.00'),
    get('/api/events/featured?location=40.70,-74.00'),
  ];
  await waitFor(() => tmCalls.length >= 1);
  await new Promise((r) => setTimeout(r, 25));
  reject(new TypeError('fetch failed'));
  const results = await Promise.all(started);

  for (const res of results) {
    assert.strictEqual(res.status, 503, `${res.status} ${res.text}`);
  }
  assert.strictEqual(eventsRouter.__test.breakerOpen(), false,
    'one shared failed flight opened the two-failure breaker');
  // A failed flight is not pinned: the next request goes back upstream.
  tmImpl = null;
  const next = await get('/api/events/featured?location=40.70,-74.00');
  assert.strictEqual(next.status, 200, next.text);
  assert.strictEqual(tmCalls.length, 2, 'the failed flight was pinned in the inflight map');
});

// ── Input bounds and upstream URL hygiene ───────────────────────────────────

test('bounds: radius outside 1..100 (or non-integer) is a 400 before any spend', async () => {
  for (const r of ['0', '101', '-5', '12.5', 'abc', '1e3']) {
    tmCalls = [];
    const res = await get(`/api/events/search?location=39.74,-104.98&radius=${r}`);
    assert.strictEqual(res.status, 400, `radius=${r} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(tmCalls, [], `radius=${r}: paid Ticketmaster anyway`);
  }
  const ok = await get('/api/events/search?location=39.74,-104.98&radius=100');
  assert.strictEqual(ok.status, 200, ok.text);
  assert.ok(/radius=100\b/.test(tmCalls[0].url), tmCalls[0].url);
});

test('bounds: the upstream URL carries only parameters this route chose', async () => {
  // Arbitrary client params must not pass through: size, apikey, dates and
  // anything else the caller invents stay OURS.
  const res = await get('/api/events/search?location=39.74,-104.98&query=' +
    encodeURIComponent('x'.repeat(80)) +
    '&size=200&apikey=evil-key&startDateTime=1999-01-01T00:00:00Z&page=9');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(tmCalls.length, 2); // keyword search = local + wide
  const allowed = new Set(['apikey', 'latlong', 'radius', 'unit', 'size', 'sort', 'keyword', 'classificationName', 'countryCode']);
  for (const { url } of tmCalls) {
    const params = new URL(url).searchParams;
    for (const [k, v] of params) {
      assert.ok(allowed.has(k), `unexpected upstream param ${k}=${v} in ${url}`);
    }
    assert.strictEqual(params.get('apikey'), 'tm-test-key', 'the client chose our api key');
    assert.ok(Number(params.get('size')) <= 20, `client-controlled size: ${params.get('size')}`);
    assert.strictEqual(params.get('keyword').length, 40, 'keyword not capped at 40');
  }
});

// ── Response honesty ────────────────────────────────────────────────────────

test('honesty: dates are the venue\'s wall clock, not re-derived from server UTC', async () => {
  tmImpl = () => TM_ONE;
  const res = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(res.status, 200, res.text);
  const ev = res.body.events[0];
  // Ticketmaster's localDate/localTime ARE the venue's timezone. The UTC
  // instant of this fixture falls on the NEXT calendar day, so any UTC-derived
  // date would read 2026-08-21 and be wrong on every card.
  assert.strictEqual(ev.date, '2026-08-20');
  assert.strictEqual(ev.time, '19:00:00');
  assert.strictEqual(ev.datetime_utc, '2026-08-21T01:00:00Z');
  // The fields the client renders (App.js events list + detail sheet) exist
  // and are not invented.
  for (const k of ['id', 'name', 'category', 'venue_name', 'venue_address', 'location',
    'image_url', 'price_range', 'genre', 'url', 'distance_miles']) {
    assert.ok(k in ev, `client-rendered field missing from the response: ${k}`);
  }
  assert.strictEqual(ev.venue_name, 'Red Rocks');
  assert.strictEqual(ev.category, 'concert');
  assert.deepStrictEqual(ev.location, { latitude: 39.6654, longitude: -105.2057 });
  assert.strictEqual(ev.image_url, null, 'an image was invented for an event that has none');
  assert.strictEqual(ev.price_range, null, 'a price was invented for an event that has none');
});

test('honesty: /details statuses tell the truth — 404 missing, 502 broken upstream, 503 unreachable', async () => {
  tmImpl = () => ({ ok: false, status: 404, json: async () => ({}) });
  let res = await get('/api/events/details?id=NoSuchEvent1');
  assert.strictEqual(res.status, 404, res.text);

  eventsRouter.__test.reset();
  tmImpl = () => ({ ok: false, status: 500, json: async () => ({}) });
  res = await get('/api/events/details?id=NoSuchEvent2');
  assert.strictEqual(res.status, 502, res.text);

  eventsRouter.__test.reset();
  tmImpl = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad body'); } });
  res = await get('/api/events/details?id=NoSuchEvent3');
  assert.strictEqual(res.status, 502, `malformed body -> ${res.status} ${res.text}`);

  eventsRouter.__test.reset();
  tmImpl = () => { throw new TypeError('fetch failed'); };
  res = await get('/api/events/details?id=NoSuchEvent4');
  assert.strictEqual(res.status, 503, res.text);
});

test('honesty: a cached /details answer is the same answer, without a second invoice', async () => {
  tmImpl = () => ({ ok: true, status: 200, json: async () => RAW_EVENT });
  const first = await get('/api/events/details?id=G5vYZ9j3fV4Ay');
  assert.strictEqual(first.status, 200, first.text);
  const second = await get('/api/events/details?id=G5vYZ9j3fV4Ay');
  assert.strictEqual(second.status, 200, second.text);
  assert.strictEqual(tmCalls.length, 1, 'the cached detail was re-fetched');
  assert.deepStrictEqual(second.body, first.body);
  assert.strictEqual(second.body.event.timezone, 'America/Denver');
});

// ---------------------------------------------------------------------------
// WHAT THE THREE REFUSALS ON THIS ROUTER ARE ALLOWED TO SAY.
// ---------------------------------------------------------------------------
// All three said "busy right now. Try again in a bit." Two of the three legs
// behind that sentence are the CALLER'S OWN allowance, which nobody else's
// traffic touches, so "busy" named the wrong cause; and the two daily legs run
// to a boundary hours away, so "in a bit" named a window that does not exist.
// A user who follows it comes straight back to the same refusal.
// ---------------------------------------------------------------------------

test('the per-user hourly ceiling says the hour, and does not blame other people', async () => {
  eventsRouter.__test.reset();
  tmImpl = () => TM_EMPTY;
  const hourly = eventsRouter.__test.budgetLimits.hourly;
  // A distinct query each time so nothing is served from the cache.
  for (let i = 0; i < hourly; i++) {
    const ok = await get(`/api/events/search?location=39.7,-105.0&query=q${i}`);
    assert.strictEqual(ok.status, 200, `search ${i} should have been allowed`);
  }
  const refused = await get('/api/events/search?location=39.7,-105.0&query=last');
  assert.strictEqual(refused.status, 429);
  assert.match(refused.body.error, /in the last hour/);
  assert.ok(!/busy/i.test(refused.body.error),
    'a ceiling on this one account is being reported as the app being busy');
  assert.ok(!/in a bit/i.test(refused.body.error),
    '"in a bit" is not a window; it is what the old copy said about an hour');
  assert.ok(refused.body.retryAfterSeconds > 60 * 50,
    'the machine-readable window is shorter than the hour it describes');
  assert.ok(refused.body.resetsAt, 'a refusal must say when it lifts');
});

test('the shared daily ceiling names the day and is not pinned on the caller', async () => {
  eventsRouter.__test.reset();
  tmImpl = () => TM_EMPTY;
  // The global ledger full, but this account has not spent a thing.
  eventsRouter.__test.forceGlobalLedger(
    new Date().toISOString().slice(0, 10), eventsRouter.__test.budgetLimits.globalDaily
  );
  const refused = await get('/api/events/search?location=39.7,-105.0&query=anything');
  assert.strictEqual(refused.status, 429);
  assert.match(refused.body.error, /for the day/,
    'a UTC-day ceiling has to say so; it can be most of a day away');
  assert.ok(!/You have/.test(refused.body.error),
    'a caller who has spent nothing is being told they looked up too much');
  // Under a day, because the boundary is the next UTC midnight and not 24h out.
  assert.ok(refused.body.retryAfterSeconds > 0 && refused.body.retryAfterSeconds <= 86_400);
});

test('the details route refuses in its own words, on the same real window', async () => {
  eventsRouter.__test.reset();
  eventsRouter.__test.forceGlobalLedger(
    new Date().toISOString().slice(0, 10), eventsRouter.__test.budgetLimits.globalDaily
  );
  const refused = await get('/api/events/details?id=G5vYZ9abc');
  assert.strictEqual(refused.status, 429);
  assert.match(refused.body.error, /Event pages come back/);
  assert.ok(!/in a bit/i.test(refused.body.error));
});
