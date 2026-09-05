// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// SLOP-AUDIT §O, applied literally to five routers that had not had a pass.
// ---------------------------------------------------------------------------
// "You built it, so you know the correct path and you test the correct path. A
// user opening the app for the first time has no idea what the correct path is,
// and will do things that are wrong."
//
// §O reduces to four attacks, and every test below is one of them, per
// endpoint, against routes/friends.js, routes/events.js, routes/stories.js,
// routes/waitlist.js and routes/weather.js:
//
//   WRONG THING     a value of the wrong SHAPE (a one-element array satisfies
//                   isEmail, isLength and isInt by coercion and then stays an
//                   array in req.body), a value that passes the validator and
//                   still cannot be what the route needs (`location=abc` is
//                   three characters long AND is not a coordinate), an id
//                   belonging to nobody, a value at and past every boundary.
//   TWO AT ONCE     the same request twice, two conflicting requests racing, a
//                   read-then-write with no guard on what was read.
//   NOTHING         an empty body, an empty array, an empty query parameter, an
//                   account with no data yet, and an UPSTREAM THAT RETURNED
//                   NOTHING — the empty state that claims success.
//   CONNECTION LOST a write that half-completes, a retry, a failure remembered
//                   for so long that the recovery is invisible.
//
// WHAT THESE TESTS ASSERT, and why it is not the response body alone. For every
// request that is the caller's fault, the assertion is a 400 AND that nothing
// was spent: no SQL issued, no metered upstream contacted. A route that took
// the bad value, paid Ticketmaster to ask an unanswerable question and then
// answered politely would pass a status-code-only test. That is the defect.
//
// No database and no network: pool.query and global.fetch are fixtures. Every
// statement a route issues after the auth lookup is recorded, and so is every
// Ticketmaster and OpenWeatherMap URL.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret-for-edge-case-sweep';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op
delete process.env.RESEND_API_KEY;           // waitlist sends no mail
process.env.TICKETMASTER_API_KEY = 'tm-test-key'; // routes/events.js reads this at load
process.env.WEATHER_API_KEY = 'wx-test-key';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Fixture plumbing ────────────────────────────────────────────────────────
const USER = {
  id: 1, email: 'ava@example.com', name: 'Ava', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};

// Every statement issued AFTER the auth lookup, in order.
let queries = [];
// [regexp, fn(params, sql)] — first match wins. fn may return a rejected
// promise, which is how the unique-constraint race below is reproduced.
let handlers = [];

const AUTH_SQL = /^SELECT id, email, name, role,.*FROM users WHERE id = \$1$/i;

function dispatch(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) return Promise.resolve({ rows: [USER], rowCount: 1 });
  queries.push({ sql, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], sql);
      if (out && typeof out.then === 'function') return out;
      return Promise.resolve(out || { rows: [], rowCount: 0 });
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({ query: (t, p) => dispatch(t, p), release: () => {} });

function sqlMatching(re) { return queries.filter((q) => re.test(q.sql)); }

// ── Outbound HTTP, faked ────────────────────────────────────────────────────
const realFetch = global.fetch;
let tmCalls = [];   // every Ticketmaster URL
let tmImpl = null;  // (url, nth) -> response-ish
let wxCalls = [];   // every OpenWeatherMap URL
let wxImpl = null;

const TM_EMPTY = { ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) };
const WX_OK = {
  ok: true, status: 200,
  json: async () => ({ main: { temp: 61, feels_like: 59, humidity: 40 }, wind: { speed: 3 }, weather: [{ main: 'Clear', description: 'clear sky', id: 800 }] }),
};

global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://app.ticketmaster.com/')) {
    tmCalls.push(u);
    // A throw from tmImpl has to become a REJECTED PROMISE, not a synchronous
    // throw: undici's fetch never throws synchronously, and a stub that does
    // would be testing a failure mode the runtime cannot produce (and would
    // land in a different catch than the real one).
    try { return Promise.resolve(tmImpl ? tmImpl(u, tmCalls.length) : TM_EMPTY); }
    catch (e) { return Promise.reject(e); }
  }
  if (u.startsWith('https://api.openweathermap.org/')) {
    wxCalls.push(u);
    return Promise.resolve(wxImpl ? wxImpl(u, wxCalls.length) : WX_OK);
  }
  return realFetch(url, opts);
};

// ── Collaborators patched before the routers are required ───────────────────
// stories.js calls moderation through the module object on purpose (see its
// header), which is what makes the image screen replaceable here.
const moderation = require('../utils/moderation');
let imageVerdict = { allowed: true };
let moderateImageCalls = 0;
moderation.moderateImage = async () => { moderateImageCalls += 1; return imageVerdict; };

const weatherService = require('../services/weatherService');

// ── Routers (required AFTER every stub above) ───────────────────────────────
const friendsRouter = require('../routes/friends');
const eventsRouter = require('../routes/events');
const storiesRouter = require('../routes/stories');
const waitlistRouter = require('../routes/waitlist');
const weatherRouter = require('../routes/weather');

// Enough of a Socket.io server to be one. `sockets.adapter.rooms` is not
// decoration: services/pushHelper.js reads it to decide whether the recipient
// is online, and friends.js awaits pushIfOffline INSIDE its try — so a fake
// that only implements `.to()` turns a successful friend request into a 500
// and hides whatever the test was actually asking about.
function fakeIo() {
  const sent = [];
  return {
    sent,
    sockets: { adapter: { rooms: new Map() } },
    to(room) { return { emit: (event, payload) => sent.push({ room, event, payload }) }; },
  };
}
let io = fakeIo();

const app = express();
app.use(express.json({ limit: '1mb' }));
// `io` is swapped per test, so the object handed to the routers has to read it
// lazily rather than capture it once.
app.set('io', new Proxy({}, { get: (_t, k) => io[k] }));
app.use('/api/friends', friendsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/waitlist', waitlistRouter);
app.use('/api/weather', weatherRouter);

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
  queries = [];
  handlers = [];
  tmCalls = [];
  tmImpl = null;
  wxCalls = [];
  wxImpl = null;
  io = fakeIo();
  imageVerdict = { allowed: true };
  moderateImageCalls = 0;
  friendsRouter.__resetBudgets();
  eventsRouter.__test.reset();
  waitlistRouter.__test.reset();
  weatherService.__resetWeatherState();
});

const TOKEN = () => signUserToken(USER);

async function call(method, pathname, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${TOKEN()}`;
  const res = await realFetch(base + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body: json };
}
const get = (p, o) => call('GET', p, undefined, o);
const post = (p, b, o) => call('POST', p, b, o);
const del = (p, o) => call('DELETE', p, undefined, o);

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Source assertions are about what the file DOES. A comment that quotes the
// removed line — which is how this codebase records why it was removed — must
// not read as the line coming back.
const CODE = (f) => SRC(f).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// The coerced non-scalar family, as validators/shape.js defines it. An EMPTY
// array satisfies every length and range rule vacuously; a ONE-element array
// satisfies them by being stringified; both stay non-scalars in req.body.
const NON_SCALARS = [[], ['a@b.com'], ['a', 'b'], [['a@b.com']], {}, { $ne: null }];

// ===========================================================================
// routes/waitlist.js — the only unauthenticated write surface here.
// ===========================================================================
// It takes an email from anyone on the public marketing site, so it is the one
// router in this set where the caller is guaranteed not to be running our
// client.

test('waitlist / WRONG THING: a non-scalar email is a 400 before any query', async () => {
  for (const v of NON_SCALARS) {
    waitlistRouter.__test.reset();
    queries = [];
    const res = await post('/api/waitlist', { email: v }, { auth: false });
    assert.strictEqual(res.status, 400,
      `email=${JSON.stringify(v)} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(queries.map((q) => q.sql), [],
      `email=${JSON.stringify(v)}: reached the database anyway`);
  }
});

test('waitlist / WRONG THING: a well-shaped email still reaches the INSERT, as a string', async () => {
  let inserted = null;
  handlers.push([/^INSERT INTO waitlist/i, (p) => { inserted = p; return { rows: [{ id: 1 }], rowCount: 1 }; }]);
  const res = await post('/api/waitlist', { email: 'Ava@Example.com ' }, { auth: false });
  assert.strictEqual(res.status, 201, res.text);
  assert.ok(inserted, 'the INSERT never ran');
  assert.strictEqual(typeof inserted[0], 'string', `stored ${JSON.stringify(inserted[0])}`);
});

test('waitlist / NOTHING: an empty body is a 400 with a human message, not a crash', async () => {
  for (const payload of [{}, { email: '' }, { email: null }]) {
    waitlistRouter.__test.reset();
    const res = await post('/api/waitlist', payload, { auth: false });
    assert.strictEqual(res.status, 400, `${JSON.stringify(payload)} -> ${res.status} ${res.text}`);
    assert.match(res.body.error, /email/i);
  }
});

test('waitlist / NOTHING: no body at all, and a body that is not an object', async () => {
  // The marketing site is the one caller here that is not our client, so
  // "whatever a bot posts at it" is the real input distribution.
  const cases = [
    [undefined, 400],
    ['"just a string"', 400],
    ['[]', 400],
    ['[{"email":"a@b.com"}]', 400],
    ['not json at all', 400],
  ];
  for (const [raw, want] of cases) {
    waitlistRouter.__test.reset();
    queries = [];
    const res = await realFetch(base + '/api/waitlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
    });
    assert.strictEqual(res.status, want, `body=${raw} -> ${res.status}`);
    assert.deepStrictEqual(queries.map((q) => q.sql), [], `body=${raw}: reached the database`);
  }
});

test('waitlist / TWO AT ONCE: the same address twice is a success both times', async () => {
  let n = 0;
  handlers.push([/^INSERT INTO waitlist/i, () => (++n === 1 ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 })]);
  const first = await post('/api/waitlist', { email: 'ava@example.com' }, { auth: false });
  const second = await post('/api/waitlist', { email: 'ava@example.com' }, { auth: false });
  assert.strictEqual(first.status, 201, first.text);
  assert.strictEqual(second.status, 201, second.text);
  assert.match(second.body.message, /already/i);
});

test('waitlist / the per-IP budget still bites', async () => {
  handlers.push([/^INSERT INTO waitlist/i, () => ({ rows: [{ id: 1 }], rowCount: 1 })]);
  const limit = waitlistRouter.__test.WAITLIST_IP_HOURLY;
  for (let i = 0; i < limit; i++) {
    const ok = await post('/api/waitlist', { email: `a${i}@example.com` }, { auth: false });
    assert.strictEqual(ok.status, 201, `signup ${i}: ${ok.text}`);
  }
  const refused = await post('/api/waitlist', { email: 'over@example.com' }, { auth: false });
  assert.strictEqual(refused.status, 429, refused.text);
});

test('waitlist / NOTHING: an exhausted MAIL budget must not throw the signup away', async () => {
  // The daily budget's own comment says it "exists to bound outbound MAIL", and
  // round 9 already stopped it being charged by submissions that sent none. But
  // it was still consulted as an admission gate, so the 501st signup of the day
  // was refused outright — the address never recorded, the person told "too
  // many signups from this connection", which is not what happened and not
  // something they can act on. A mail ceiling may cost the confirmation email;
  // it may not cost the signup.
  handlers.push([/^INSERT INTO waitlist/i, () => ({ rows: [{ id: 9 }], rowCount: 1 })]);
  waitlistRouter.__test.exhaustMailBudget();
  const res = await post('/api/waitlist', { email: 'late@example.com' }, { auth: false });
  assert.strictEqual(res.status, 201, `mail budget spent -> ${res.status} ${res.text}`);
  assert.strictEqual(sqlMatching(/^INSERT INTO waitlist/i).length, 1,
    'the signup was not recorded');
});

// ===========================================================================
// routes/weather.js — a metered upstream, and coordinates chosen by the caller.
// ===========================================================================

test('weather / WRONG THING: a coordinate that is not one is a 400 before any upstream call', async () => {
  const bad = [
    '?lat=abc&lon=-104.98',
    '?lat=39.74&lon=xyz',
    '?lat=90.0001&lon=0',
    '?lat=-90.0001&lon=0',
    '?lat=0&lon=180.0001',
    '?lat=0&lon=-180.0001',
    '?lat=&lon=',
    '',
    '?lat=39.74',
    '?lon=-104.98',
    '?lat=39.74&lat=40&lon=-104.98',
  ];
  for (const q of bad) {
    for (const p of ['/api/weather', '/api/weather/forecast']) {
      wxCalls = [];
      const res = await get(p + q);
      assert.strictEqual(res.status, 400, `${p}${q} -> ${res.status} ${res.text}`);
      assert.deepStrictEqual(wxCalls, [], `${p}${q}: paid for it anyway`);
    }
  }
});

test('weather / WRONG THING: the boundary coordinates are still accepted', async () => {
  for (const q of ['?lat=90&lon=180', '?lat=-90&lon=-180', '?lat=0&lon=0']) {
    weatherService.__resetWeatherState();
    const res = await get('/api/weather' + q);
    assert.strictEqual(res.status, 200, `${q} -> ${res.status} ${res.text}`);
  }
});

test('weather / NOTHING: an upstream that returns an empty forecast is not a successful forecast', async () => {
  // getForecast answers `[]` for a 200 whose `list` holds nothing usable, and
  // the route's guard was `if (!forecast)` — an empty array is truthy, so five
  // days of nothing were served as a 200 with `{ forecast: [] }`. The client
  // cannot tell that from "the weather is fine and there is nothing to say".
  // Worse, weatherService caches it as a SUCCESS for thirty minutes.
  wxImpl = () => ({ ok: true, status: 200, json: async () => ({ list: [] }) });
  const res = await get('/api/weather/forecast?lat=39.74&lon=-104.98');
  assert.strictEqual(res.status, 502, `empty forecast -> ${res.status} ${res.text}`);
  assert.ok(!res.body.forecast, 'an empty forecast was served as a forecast');
});

test('weather / NOTHING: an upstream that returns nothing at all is a 502, never fabricated weather', async () => {
  wxImpl = () => ({ ok: false, status: 500, json: async () => ({}) });
  const res = await get('/api/weather?lat=39.74&lon=-104.98');
  assert.strictEqual(res.status, 502, res.text);
  assert.ok(!res.body.temp, 'invented a temperature');
});

test('weather / the paid ceiling is enforced and fails CLOSED', async () => {
  // WX_DAILY = 950 sits UNDER OpenWeatherMap's free 1,000/day — decided
  // 2026-08-14, replacing the old 3000 that spent past free. What is checked
  // here is that the ceiling is real: once the
  // caller's allowance is gone the route stops paying and answers 502, rather
  // than degrading to a silent default or letting the spend run.
  const status = weatherService.weatherBudgetStatus();
  assert.strictEqual(status.limits.daily, 950,
    'WX_DAILY changed — that number is a recorded decision, see services/weatherService.js');
  const perUser = status.limits.perUserHourly;

  for (let i = 0; i < perUser; i++) {
    const res = await get(`/api/weather?lat=${(10 + i * 0.05).toFixed(2)}&lon=-104.98`);
    assert.strictEqual(res.status, 200, `call ${i}: ${res.text}`);
  }
  assert.strictEqual(wxCalls.length, perUser, 'the cache or the budget miscounted');

  const over = await get('/api/weather?lat=20.00&lon=-104.98');
  assert.strictEqual(over.status, 502, `over the ceiling -> ${over.status} ${over.text}`);
  assert.strictEqual(wxCalls.length, perUser, 'spent past the ceiling');
});

// ===========================================================================
// routes/events.js — Ticketmaster is metered, and every parameter below is
// chosen by the caller.
// ===========================================================================

test('events / WRONG THING: a location that is not a coordinate is a 400 before any upstream call', async () => {
  const bad = [
    'abc', 'null', '  ,  ', '1,', ',1', '1,2,3', '91,0', '-91,0', '0,181', '0,-181',
    'NaN,NaN', '1e400,0', '40.7,-74.0extra',
  ];
  for (const loc of bad) {
    for (const p of ['/api/events/search', '/api/events/featured']) {
      tmCalls = [];
      const res = await get(`${p}?location=${encodeURIComponent(loc)}`);
      assert.strictEqual(res.status, 400, `${p} location=${loc} -> ${res.status} ${res.text}`);
      assert.deepStrictEqual(tmCalls, [], `${p} location=${loc}: paid Ticketmaster anyway`);
    }
  }
});

test('events / WRONG THING: a non-scalar location is a 400, not a swallowed TypeError', async () => {
  // `?location=a&location=b` makes req.query.location an ARRAY. isLength({min:3})
  // passes on the joined string, and `location.split(',')` then throws. On
  // /search the blanket catch turned that into `200 {events: [], total: 0}` —
  // the client's own mistake rendered as "there is nothing happening near you".
  // On /featured it was a 500.
  for (const p of ['/api/events/search', '/api/events/featured']) {
    for (const qs of ['?location=40.7,-74.0&location=1,1', '?location[]=40.7,-74.0']) {
      tmCalls = [];
      const res = await get(p + qs);
      assert.strictEqual(res.status, 400, `${p}${qs} -> ${res.status} ${res.text}`);
      assert.deepStrictEqual(tmCalls, [], `${p}${qs}: paid Ticketmaster anyway`);
    }
  }
});

test('events / WRONG THING: a real coordinate still reaches Ticketmaster', async () => {
  const res = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(tmCalls.length, 1, 'the search never went upstream');
  assert.ok(tmCalls[0].includes('latlong=39.74%2C-104.98') || tmCalls[0].includes('latlong=39.74,-104.98'),
    `coordinate did not survive: ${tmCalls[0]}`);
});

test('events / WRONG THING: an event id is a format, not a free string in an upstream URL', async () => {
  // The id was interpolated raw into the Ticketmaster path. A caller could put
  // a `/`, a `..`, a `?` or a `#` in it and choose which endpoint on that host
  // we called and which query string it carried — and every one of those
  // attempts spent a call from the daily budget on a request that could never
  // return an event.
  const bad = [
    '../attractions.json', 'a/b', 'x?apikey=leak', 'x#frag', 'x y', '%2e%2e%2f',
    'G5v'.padEnd(200, 'z'), '',
  ];
  for (const id of bad) {
    tmCalls = [];
    const res = await get(`/api/events/details?id=${encodeURIComponent(id)}`);
    assert.strictEqual(res.status, 400, `id=${id} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(tmCalls, [], `id=${id}: paid Ticketmaster anyway`);
  }
});

test('events / WRONG THING: a real event id still reaches Ticketmaster, encoded', async () => {
  tmImpl = () => ({ ok: true, status: 200, json: async () => ({ id: 'G5vYZ9j3fV4Ay', name: 'Show' }) });
  const res = await get('/api/events/details?id=G5vYZ9j3fV4Ay');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(tmCalls.length, 1);
  assert.ok(tmCalls[0].includes('/events/G5vYZ9j3fV4Ay?'), tmCalls[0]);
});

test('events / WRONG THING: the event id is encoded into the upstream path, not interpolated', async () => {
  // Belt AND braces, and the braces need their own pin. The TM_EVENT_ID
  // allowlist happens to admit only URL-safe characters today, so reverting
  // the encodeURIComponent turns no behavioural test red — the two controls
  // are redundant EXACTLY until someone widens the allowlist, at which point
  // the encoding is the only thing keeping the caller out of the URL path.
  // A redundant control that can be deleted without a test noticing is a
  // control that will be deleted. Source-level pin, same style as the
  // shared-predicate assertions elsewhere in this suite.
  const src = CODE('routes/events.js');
  assert.match(src, /\/discovery\/v2\/events\/\$\{encodeURIComponent\(eventId\)\}/,
    'the details fetch must interpolate encodeURIComponent(eventId), never the raw id');
  assert.doesNotMatch(src, /\/discovery\/v2\/events\/\$\{eventId\}/,
    'the raw event id is back in the upstream URL path');
});

test('events / TWO AT ONCE: the /featured top-up is a second paid call and is charged as one', async () => {
  // The unfiltered top-up fires when an interest filter returned fewer than 5
  // events. It is a real Ticketmaster call, and it was not charged at all —
  // the global ledger ran one short on every request that took the branch.
  tmImpl = () => ({ ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) });
  const before = eventsRouter.__test.spent();
  const res = await get('/api/events/featured?location=39.74,-104.98&interests=sports');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(tmCalls.length, 2, 'the top-up never ran');
  assert.strictEqual(eventsRouter.__test.spent() - before, 2,
    'two upstream calls were charged as one');
});

test('events / TWO AT ONCE: /featured coarsens its cache key the way /search does', async () => {
  // /search keys on the coordinate rounded to 0.1 deg precisely so that two
  // phones a block apart share one paid call. /featured keyed on the raw
  // string, so every GPS jitter was a fresh Ticketmaster call for a list that
  // covers a 30-mile radius and could not possibly differ.
  await get('/api/events/featured?location=40.71280,-74.00600');
  await get('/api/events/featured?location=40.71310,-74.00590');
  assert.strictEqual(tmCalls.length, 1,
    `two nearby callers cost ${tmCalls.length} Ticketmaster calls`);
});

test('events / TWO AT ONCE: the same interests in a different order are one cache entry', async () => {
  await get('/api/events/featured?location=40.7,-74.0&interests=sports,live%20music');
  const afterFirst = tmCalls.length;
  await get('/api/events/featured?location=40.7,-74.0&interests=LIVE Music , sports');
  assert.strictEqual(tmCalls.length, afterFirst,
    `the same interests, reordered and recased, cost ${tmCalls.length - afterFirst} more Ticketmaster calls`);
});

test('events / NOTHING: an interests string of any length cannot grow the cache key', async () => {
  const huge = Array.from({ length: 400 }, (_, i) => `interest${i}`).join(',');
  const res = await get(`/api/events/featured?location=40.7,-74.0&interests=${encodeURIComponent(huge)}`);
  assert.strictEqual(res.status, 200, res.text);
  const key = eventsRouter.__test.lastCacheKey();
  assert.ok(key.length <= 160, `cache key is ${key.length} chars: ${key.slice(0, 200)}`);
});

test('events / CONNECTION LOST: a failed upstream is remembered briefly, not for an hour', async () => {
  // A Ticketmaster 429 answered `{events: [], total: 0}` and cached it under
  // the ordinary one-hour TTL. So a single throttled second blanked event
  // search for that whole area for the next hour, long after the upstream had
  // recovered, and nothing in the response said so. weatherService already
  // draws this distinction: a failure gets its own short TTL.
  tmImpl = () => ({ ok: false, status: 429, json: async () => ({}) });
  const first = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(first.status, 200, first.text);
  assert.deepStrictEqual(first.body, { events: [], total: 0, degraded: true });
  assert.strictEqual(tmCalls.length, 1);

  const { CACHE_TTL, NEGATIVE_TTL } = eventsRouter.__test;
  assert.ok(NEGATIVE_TTL < CACHE_TTL, 'a failure is remembered as long as a success');

  // Still inside the negative window: no second invoice.
  await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(tmCalls.length, 1, 're-charged inside the negative window');

  // Past it: the upstream is tried again.
  eventsRouter.__test.ageCache(NEGATIVE_TTL + 1000);
  tmImpl = null;
  const recovered = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(recovered.status, 200, recovered.text);
  assert.strictEqual(tmCalls.length, 2, 'the outage was remembered past its window');
});

test('events / CONNECTION LOST: a successful result is still cached for the full hour', async () => {
  await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(tmCalls.length, 1);
  eventsRouter.__test.ageCache(eventsRouter.__test.NEGATIVE_TTL + 1000);
  await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(tmCalls.length, 1, 'a good result was dropped on the negative TTL');
});

test('events / TWO AT ONCE: the per-user budget cannot be flushed by filling the map', async () => {
  // The hand-rolled counter did `if (tmUserHits.size > 5000) tmUserHits.clear()`
  // — the wholesale clear that utils/probeBudget.js exists to stop, because
  // anyone who can push the map over the threshold recovers their own spent
  // budget. routes/friends.js carried the same bug and was already fixed.
  const src = CODE('routes/events.js');
  assert.match(src, /require\(['"]\.\.\/utils\/probeBudget['"]\)/,
    'routes/events.js must use the shared per-user budget, not a private copy');
  assert.doesNotMatch(src, /tmUserHits/,
    'the private per-user hit map is back');
  // The only map this file may empty wholesale is its own result cache, and
  // only from the test hook. A budget keyed by user id may never be cleared:
  // whoever can push it over its ceiling is exactly who gets their spent
  // allowance back.
  const clears = src.match(/[A-Za-z_$][\w$]*\.clear\(\)/g) || [];
  assert.deepStrictEqual([...new Set(clears)], ['eventCache.clear()'], clears.join(', '));
});

test('events / TWO AT ONCE: a fresh search past the hourly allowance is refused, not served', async () => {
  const { hourly } = eventsRouter.__test.budgetLimits;
  for (let i = 0; i < hourly; i++) {
    const res = await get(`/api/events/search?location=${(10 + i).toFixed(2)},-74.00`);
    assert.strictEqual(res.status, 200, `search ${i}: ${res.text}`);
  }
  const over = await get('/api/events/search?location=45.00,-74.00');
  assert.strictEqual(over.status, 429, `over the allowance -> ${over.status} ${over.text}`);
  assert.strictEqual(tmCalls.length, hourly, 'spent past the allowance');
});

test('events / TWO AT ONCE: a keyword search costs two upstream calls and is charged for two', async () => {
  // /search fires a second, location-free query whenever a keyword is present,
  // and utils/upstream.js calls that "the only deliberate second charge in the
  // codebase". The budget counted it as one, so the global ceiling was really
  // twice what it says.
  const before = eventsRouter.__test.spent();
  const res = await get('/api/events/search?location=39.74,-104.98&query=phish');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(tmCalls.length, 2, 'the wide search did not run');
  assert.strictEqual(eventsRouter.__test.spent() - before, 2,
    'two upstream calls were charged as one');
});

test('events / WRONG THING: a repeated id is two ids, and two ids is not one', async () => {
  // Standard validators (isInt, isLength, matches) are run PER ELEMENT when a
  // query field arrives as an array, so `?id=abc&id=def` satisfies the format
  // rule twice over and the value stays an array — `${eventId}` in the upstream
  // URL then becomes "abc,def". Only the `.custom()` in scalarOnly sees the
  // array itself, which is why the shape guard has to be there and cannot be
  // inferred from the format rule passing.
  for (const qs of ['?id=abc&id=def', '?id[]=abc', '?id[a]=abc']) {
    tmCalls = [];
    const res = await get('/api/events/details' + qs);
    assert.strictEqual(res.status, 400, `${qs} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(tmCalls, [], `${qs}: paid Ticketmaster anyway`);
  }
});

test('events / NOTHING: an empty optional parameter is absent, not invalid', async () => {
  // Same defect as the story feed's page size, found by re-reading my own
  // patch: `.optional()` skips only `undefined`, so `?radius=` — an unset
  // slider serialised by a client that does not omit empty values — failed the
  // whole search over a parameter nobody chose.
  for (const qs of ['?location=39.74,-104.98&radius=', '?location=39.74,-104.98&query=&category=']) {
    tmCalls = [];
    const res = await get('/api/events/search' + qs);
    assert.strictEqual(res.status, 200, `${qs} -> ${res.status} ${res.text}`);
  }
  const featured = await get('/api/events/featured?location=39.74,-104.98&interests=');
  assert.strictEqual(featured.status, 200, featured.text);
});

test('events / WRONG THING: a filter name that is only an inherited property is not a filter', async () => {
  // `segMap[category]` and `interestToTM[interest]` are lookups in plain object
  // literals, tested for truthiness. Object literals inherit from
  // Object.prototype, so `?category=constructor` found the Object FUNCTION,
  // passed the truthiness test, and put its source text into the Ticketmaster
  // query string — a metered call spent on a filter that cannot match anything.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    tmCalls = [];
    eventsRouter.__test.reset();
    const res = await get(`/api/events/search?location=39.74,-104.98&category=${encodeURIComponent(key)}`);
    assert.strictEqual(res.status, 200, `category=${key} -> ${res.status} ${res.text}`);
    assert.strictEqual(tmCalls.length, 1);
    assert.ok(!/classificationName/.test(tmCalls[0]),
      `category=${key} put an inherited property in the upstream URL: ${tmCalls[0]}`);

    tmCalls = [];
    eventsRouter.__test.reset();
    const feat = await get(`/api/events/featured?location=39.74,-104.98&interests=${encodeURIComponent(key)}`);
    assert.strictEqual(feat.status, 200, feat.text);
    assert.ok(!/classificationName/.test(tmCalls[0]),
      `interests=${key} put an inherited property in the upstream URL: ${tmCalls[0]}`);
  }
});

test('events / WRONG THING: a real filter name still filters', async () => {
  await get('/api/events/search?location=39.74,-104.98&category=concert');
  assert.ok(/classificationName=Music/.test(tmCalls[0]), tmCalls[0]);
  tmCalls = [];
  eventsRouter.__test.reset();
  await get('/api/events/featured?location=39.74,-104.98&interests=live%20music');
  assert.ok(/classificationName=Music/.test(tmCalls[0]), tmCalls[0]);
});

test('events / WRONG THING: an out-of-range radius is still refused, in words', async () => {
  for (const r of ['0', '101', 'abc', '-5']) {
    const res = await get(`/api/events/search?location=39.74,-104.98&radius=${r}`);
    assert.strictEqual(res.status, 400, `radius=${r} -> ${res.status} ${res.text}`);
    assert.notStrictEqual(res.body.error, 'Invalid value', `radius=${r}: default copy`);
  }
});

test('events / NOTHING: no location at all is a 400, and no id at all is a 400', async () => {
  for (const p of ['/api/events/search', '/api/events/featured']) {
    const res = await get(p);
    assert.strictEqual(res.status, 400, `${p} -> ${res.status} ${res.text}`);
  }
  const d = await get('/api/events/details');
  assert.strictEqual(d.status, 400, d.text);
  assert.deepStrictEqual(tmCalls, []);
});

test('events / CONNECTION LOST: an unreachable upstream is a 503, not a 500, on every endpoint', async () => {
  // /search already answered 503 when the fetch itself was rejected — a
  // deadline from utils/upstream.js firing is exactly that. /featured and
  // /details had no catch at all, so the same timeout fell into the outer
  // handler and came back "Failed to get featured events", 500: our fault,
  // retry-hostile, and indistinguishable in the logs from a bug in this file.
  const cases = [
    ['/api/events/search?location=39.74,-104.98', 503],
    ['/api/events/featured?location=39.74,-104.98', 503],
    ['/api/events/details?id=G5vYZ9j3fV4Ay', 503],
  ];
  for (const [p, want] of cases) {
    eventsRouter.__test.reset();
    tmCalls = [];
    tmImpl = () => { throw new Error('The operation was aborted due to timeout'); };
    const res = await get(p);
    assert.strictEqual(res.status, want, `${p} -> ${res.status} ${res.text}`);
    assert.strictEqual(tmCalls.length, 1, `${p}: did not actually try`);
  }
});

test('events / CONNECTION LOST: ONE slow request does not take event search away from everybody', async () => {
  // The breaker below is the right control and the wrong threshold would be
  // worse than the problem: the Ticketmaster deadline is 6 seconds, one bad
  // connection can exceed it, and opening on a single timeout would 503 every
  // user of the app for ninety seconds because one request was unlucky.
  const { FAILURES_TO_OPEN } = eventsRouter.__test;
  assert.ok(FAILURES_TO_OPEN >= 2, 'a single timeout must not open the breaker');

  tmImpl = () => { throw new Error('The operation was aborted due to timeout'); };
  const first = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(first.status, 503, first.text);
  assert.strictEqual(eventsRouter.__test.breakerOpen(), false,
    'one unlucky request closed the feature for everyone');

  // A different coordinate, so this cannot be a cache hit.
  const second = await get('/api/events/search?location=41.88,-87.62');
  assert.strictEqual(second.status, 503, second.text);
  assert.strictEqual(tmCalls.length, 2, 'the second attempt was never made');
  assert.ok(eventsRouter.__test.breakerOpen(), 'two failures in a row is an outage');
});

test('events / CONNECTION LOST: a dead upstream is not re-paid for on every request', async () => {
  tmImpl = () => { throw new Error('The operation was aborted due to timeout'); };
  for (let i = 0; i < eventsRouter.__test.FAILURES_TO_OPEN; i++) {
    const res = await get(`/api/events/search?location=${(30 + i).toFixed(2)},-104.98`);
    assert.strictEqual(res.status, 503, res.text);
  }
  const calls = tmCalls.length;
  const spentBefore = eventsRouter.__test.spent();

  // A fresh coordinate on a different endpoint, so nothing can answer this from
  // the cache — the only thing that can stop the call is knowing nobody is home.
  const blocked = await get('/api/events/featured?location=41.88,-87.62');
  assert.strictEqual(blocked.status, 503, blocked.text);
  assert.strictEqual(tmCalls.length, calls, 'paid to ask an upstream we knew was unreachable');
  assert.strictEqual(eventsRouter.__test.spent(), spentBefore, 'charged for a call never made');

  // And a single good answer closes it again.
  eventsRouter.__test.clearBreaker();
  tmImpl = null;
  const back = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(back.status, 200, back.text);
  assert.strictEqual(eventsRouter.__test.breakerOpen(), false);
});

test('events / NOTHING: a body that will not parse is a failure, not a search with no results', async () => {
  // `await response.json()` throws on a truncated or hung body — the deadline
  // covers the body stream too — and that throw landed in the blanket catch,
  // which answers `200 {events: []}`. A broken upstream read to the user as
  // "nothing is happening near you", and because nothing was cached it
  // re-charged the paid budget on every retry.
  tmImpl = () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected end of JSON input'); } });

  const search = await get('/api/events/search?location=39.74,-104.98');
  assert.deepStrictEqual(search.body, { events: [], total: 0, degraded: true }, search.text);
  const callsAfterFirst = tmCalls.length;
  // Remembered as a FAILURE, so the retry is not a second invoice...
  await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(tmCalls.length, callsAfterFirst, 're-charged for a known-bad answer');
  // ...and it is remembered only briefly.
  eventsRouter.__test.ageCache(eventsRouter.__test.NEGATIVE_TTL + 1000);
  tmImpl = null;
  await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(tmCalls.length, callsAfterFirst + 1, 'the bad body was remembered for the full hour');

  // /details cannot answer with an event made entirely of nulls.
  eventsRouter.__test.reset();
  tmImpl = () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected end of JSON input'); } });
  const details = await get('/api/events/details?id=G5vYZ9j3fV4Ay');
  assert.strictEqual(details.status, 502, details.text);
  assert.ok(!details.body.event, 'served an event built out of nothing');
});

test('events / NOTHING: a genuinely empty area answers 200 with an empty list', async () => {
  const res = await get('/api/events/search?location=39.74,-104.98');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { events: [], total: 0 });
});

// ===========================================================================
// routes/friends.js
// ===========================================================================

const PENDING_ROW = { id: 55, status: 'pending', requester_id: 2 };

function friendFixtures({ existing = [], target = [{ id: 2, name: 'Ben' }], blocks = [] } = {}) {
  handlers.push([/^SELECT id, status, requester_id FROM friendships/i, () => ({ rows: existing, rowCount: existing.length })]);
  // `is_banned` is optional in the pattern: routes/friends.js selects it in
  // the same statement (a banned target folds into the existing miss rather
  // than costing a second query) and routes/flocks.js does not. Fixture rows
  // carry no is_banned, which reads as not banned, so these race tests stay
  // about the race.
  handlers.push([/^SELECT id, name(, is_banned)? FROM users WHERE id = \$1$/i, () => ({ rows: target, rowCount: target.length })]);
  handlers.push([/FROM user_blocks/i, () => ({ rows: blocks, rowCount: blocks.length })]);
}

test('friends / TWO AT ONCE: two identical requests racing must not 500 after the first notified', async () => {
  // friendships carries UNIQUE(requester_id, addressee_id). Both requests read
  // "no relationship", both INSERT, and the loser raised 23505 straight into
  // the outer catch — a 500 for a request that in fact succeeded a millisecond
  // earlier, on a row that had already been committed and already pushed a
  // notification at the other person.
  friendFixtures();
  // The loser of the race: the row is already there, so a conflict-tolerant
  // INSERT matches nothing.
  handlers.push([/^INSERT INTO friendships/i, () => ({ rows: [], rowCount: 0 })]);
  const res = await post('/api/friends/request', { user_id: 2 });

  const insert = sqlMatching(/^INSERT INTO friendships/i)[0];
  assert.ok(insert, 'no INSERT ran');
  assert.match(insert.sql, /ON CONFLICT \(requester_id, addressee_id\) DO NOTHING/i,
    'a bare INSERT against UNIQUE(requester_id, addressee_id) raises 23505 into the outer catch');

  assert.notStrictEqual(res.status, 500, `lost the race -> ${res.status} ${res.text}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.status, 'pending', res.text);
  assert.deepStrictEqual(io.sent.filter((e) => e.event === 'friend_request_received'), [],
    'the loser of the race notified the target a second time');
});

test('friends / TWO AT ONCE: the winner of the race does notify, exactly once', async () => {
  friendFixtures();
  handlers.push([/^INSERT INTO friendships/i, () => ({ rows: [{ id: 77 }], rowCount: 1 })]);
  const res = await post('/api/friends/request', { user_id: 2 });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(io.sent.filter((e) => e.event === 'friend_request_received').length, 1, res.text);
});

test('friends / TWO AT ONCE: re-requesting must not demote a friendship accepted mid-request', async () => {
  // The re-request path read a row with status 'declined' and then wrote
  // `SET status = 'pending', requester_id = ..., addressee_id = ...` keyed on
  // the row id alone. If the other person accepted in that window, the write
  // landed on an ACCEPTED row and put it back to pending — two people who are
  // friends, one of whom is told the request was merely sent. Guard the write
  // with the status it was decided on.
  // The answer after a 0-row revive comes from a re-read of the row, so the
  // fixture flips the row the way the database would; a row that is STILL
  // declined after a 0-row revive (the one-a-day cooldown) is reported to
  // the requester as pending on purpose (friends audit, 2026-09-05).
  const row = { id: 55, status: 'declined', requester_id: 1 };
  friendFixtures({ existing: [row] });
  let updateWhere = null;
  handlers.push([/^UPDATE friendships SET status = 'pending'/i, (_p, sql) => {
    updateWhere = sql;
    row.status = 'accepted'; // it turned 'accepted' underneath us
    return { rows: [], rowCount: 0 };
  }]);
  const res = await post('/api/friends/request', { user_id: 2 });
  assert.ok(updateWhere, 'the re-request never ran an UPDATE');
  assert.match(updateWhere, /status = 'declined'/,
    'the re-request UPDATE is not guarded by the status it read');
  assert.notStrictEqual(res.body.status, 'pending',
    'reported a pending request over a friendship that already exists');
  assert.strictEqual(res.body.status, 'accepted', 'the answer comes from the re-read, not the stale row');
});

test('friends / TWO AT ONCE: auto-accept is guarded by the status it read', async () => {
  friendFixtures({ existing: [PENDING_ROW] });
  let acceptSql = null;
  handlers.push([/^UPDATE friendships SET status = 'accepted'/i, (_p, sql) => {
    acceptSql = sql;
    return { rows: [{ id: 55 }], rowCount: 1 };
  }]);
  const res = await post('/api/friends/request', { user_id: 2 });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(acceptSql, 'no accept ran');
  assert.match(acceptSql, /status = 'pending'/,
    "the auto-accept overwrites whatever the row became after it was read");
});

test('friends / TWO AT ONCE: accepting collapses a crossed pair of pending requests', async () => {
  // A requests B and B requests A at the same instant: both reads find nothing,
  // both INSERTs succeed (different key pairs), and the pair now holds two
  // pending rows. Accepting one left the other pending forever — the accepter
  // sees a live outgoing request to somebody they are already friends with, and
  // no screen in the app can clear it.
  handlers.push([/FROM user_blocks/i, () => ({ rows: [] })]);
  handlers.push([/^UPDATE friendships SET status = 'accepted'/i, () => ({ rows: [{ id: 55 }], rowCount: 1 })]);
  const res = await post('/api/friends/accept', { user_id: 2 });
  assert.strictEqual(res.status, 200, res.text);
  const reverse = sqlMatching(/^DELETE FROM friendships/i);
  assert.strictEqual(reverse.length, 1,
    'the crossed reverse request was left pending');
  assert.match(reverse[0].sql, /status = 'pending'/,
    'the cleanup would delete an accepted friendship, not a crossed request');
});

test('friends / TWO AT ONCE: a crossed pair gets one answer, not whichever row came back first', async () => {
  // Two rows between the same two people is a legal state — the unique
  // constraint is on the ORDERED pair — so `rows[0]` off an unordered SELECT
  // was whichever one Postgres happened to hand over. The same tap could report
  // "friend request sent" to somebody the caller is already friends with.
  friendFixtures();
  await post('/api/friends/request', { user_id: 2 });
  const lookup = sqlMatching(/^SELECT id, status, requester_id FROM friendships/i)[0];
  assert.ok(lookup, 'the relationship lookup never ran');
  assert.match(lookup.sql, /ORDER BY CASE status WHEN 'accepted' THEN 0/,
    'the relationship lookup is not deterministic when two rows exist');
});

test('friends / CONNECTION LOST: cleanup after an accept cannot undo the accept', async () => {
  // clearCrossedPending runs after the friendship is committed. If it were
  // allowed to throw, a successful accept would answer 500 — and the retry
  // could never succeed, because the accept is status-guarded and the row is no
  // longer pending, so the user would be told "no pending request from this
  // user" about the friend they had just made.
  handlers.push([/FROM user_blocks/i, () => ({ rows: [] })]);
  handlers.push([/^UPDATE friendships SET status = 'accepted'/i, () => ({ rows: [{ id: 55 }], rowCount: 1 })]);
  handlers.push([/^DELETE FROM friendships/i, () => Promise.reject(new Error('connection terminated unexpectedly'))]);
  const res = await post('/api/friends/accept', { user_id: 2 });
  assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
  assert.match(res.body.message, /accepted/i, res.text);
});

test('friends / WRONG THING: a blocked account cannot appear in the pending list', async () => {
  // GET /api/friends already filters blocked users out. GET /pending did not,
  // so blocking somebody left their name and photo sitting at the top of your
  // requests screen — the single most visible place the block is supposed to
  // hold. POST /accept refuses them, which means the row is unactionable AND
  // undismissable.
  handlers.push([/FROM friendships f JOIN users u ON u\.id = f\.requester_id/i,
    () => ({ rows: [{ id: 2, name: 'Ben', profile_image_url: null, created_at: 'x' }] })]);
  handlers.push([/FROM user_blocks/i, () => ({ rows: [{ id: 2 }] })]);
  const res = await get('/api/friends/pending');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.requests, [], `blocked user still listed: ${res.text}`);
});

test('friends / WRONG THING: a blocked account cannot appear in the outgoing list', async () => {
  handlers.push([/FROM friendships f JOIN users u ON u\.id = f\.addressee_id/i,
    () => ({ rows: [{ id: 2, name: 'Ben', profile_image_url: null, created_at: 'x' }] })]);
  handlers.push([/FROM user_blocks/i, () => ({ rows: [{ id: 2 }] })]);
  const res = await get('/api/friends/outgoing');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.requests, [], `blocked user still listed: ${res.text}`);
});

test('friends / WRONG THING: an unblocked account is still listed', async () => {
  handlers.push([/FROM friendships f JOIN users u/i,
    () => ({ rows: [{ id: 2, name: 'Ben', profile_image_url: null, created_at: 'x' }] })]);
  handlers.push([/FROM user_blocks/i, () => ({ rows: [] })]);
  for (const p of ['/api/friends/pending', '/api/friends/outgoing']) {
    const res = await get(p);
    assert.strictEqual(res.body.requests.length, 1, `${p}: ${res.text}`);
  }
});

test('friends / NOTHING: a contact sync with nothing to look up costs no allowance', async () => {
  // The budget is 3/hour because a real person syncs contacts a handful of
  // times. It was charged BEFORE the numbers were normalised, so a phone book
  // full of entries with no usable number — every landline-free address book,
  // and every first run where the client sends what the OS gave it — spent the
  // user's whole allowance on lookups that never happened, and the fourth
  // attempt was refused.
  //
  // '12' is in the list on purpose. Under the old last-10-digits rule anything
  // 7 digits or longer was a lookup key, so a fragment was a wildcard; under
  // utils/phone.js a number resolves to one whole E.164 string or to nothing,
  // and neither of these does.
  const limit = 4;
  for (let i = 0; i < limit; i++) {
    const res = await post('/api/friends/find-by-phone', { phones: ['not a number', '12'] });
    assert.strictEqual(res.status, 200, `attempt ${i}: ${res.status} ${res.text}`);
    assert.deepStrictEqual(res.body.users, []);
    assert.strictEqual(res.body.checked, 0);
  }
  assert.deepStrictEqual(sqlMatching(/phone_hash = ANY/i), [],
    'an unusable sync reached the directory anyway');
});

test('friends / NOTHING: a BULK contact sync is still budgeted at 3 an hour', async () => {
  handlers.push([/phone_hash = ANY/i, () => ({ rows: [] })]);
  const book = ['+1 (202) 555-0122', '+1 (202) 555-0133'];
  for (let i = 0; i < 3; i++) {
    const res = await post('/api/friends/find-by-phone', { phones: book });
    assert.strictEqual(res.status, 200, `sync ${i}: ${res.text}`);
    assert.strictEqual(res.body.checked, 2);
  }
  const over = await post('/api/friends/find-by-phone', { phones: book });
  assert.strictEqual(over.status, 429, over.text);
});

test('friends / NOTHING: a ONE-number lookup is metered as a probe, not as a sync', async () => {
  // "Add this person by their number" is the friend probe's question asked with
  // a phone number, so it carries the friend probe's allowance (20/hour) rather
  // than the address-book sync's 3. Three single lookups an hour would not be a
  // feature. This is not a way around the bulk budget either: 60 single lookups
  // a day is far under the 2,000 numbers a day the bulk lane already allows.
  handlers.push([/phone_hash = ANY/i, () => ({ rows: [] })]);
  for (let i = 0; i < 20; i++) {
    const res = await post('/api/friends/find-by-phone', { phones: ['+1 (202) 555-0144'] });
    assert.strictEqual(res.status, 200, `lookup ${i}: ${res.text}`);
  }
  const over = await post('/api/friends/find-by-phone', { phones: ['+1 (202) 555-0144'] });
  assert.strictEqual(over.status, 429, over.text);
});

test('friends / NOTHING: an empty phones array is a 400, not an empty success', async () => {
  const res = await post('/api/friends/find-by-phone', { phones: [] });
  assert.strictEqual(res.status, 400, res.text);
});

test('friends / WRONG THING: the boundaries of a user id', async () => {
  friendFixtures({ target: [] });
  const cases = [
    ['/api/friends/request', { user_id: 0 }, 400],
    ['/api/friends/request', { user_id: -1 }, 400],
    ['/api/friends/request', { user_id: 2147483648 }, 400],
    ['/api/friends/request', { user_id: 1.5 }, 400],
    ['/api/friends/request', { user_id: '2' }, 404],   // string id, no such user
    ['/api/friends/request', { user_id: 1 }, 400],     // yourself
  ];
  for (const [p, body, want] of cases) {
    const res = await post(p, body);
    assert.strictEqual(res.status, want, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
  }
});

// ===========================================================================
// routes/stories.js — fully built server-side, and nothing in the client
// renders or creates a story, so nothing here has ever been exercised by a
// real user doing a real thing wrong.
// ===========================================================================

test('stories / NOTHING: an empty pagination parameter is absent, not invalid', async () => {
  // `?limit=&offset=` is what a client that builds its query string from
  // possibly-undefined state sends, and `.optional()` skips only `undefined`.
  // A feed that 400s because a parameter the caller did not set was present as
  // an empty string is a first-run failure with no explanation.
  const res = await get('/api/stories?limit=&offset=');
  assert.strictEqual(res.status, 200, `${res.status} ${res.text}`);
  assert.deepStrictEqual(res.body.story_groups, []);
});

test('stories / WRONG THING: a rejected page size says what is wrong, in words', async () => {
  for (const q of ['?limit=999', '?limit=0', '?limit=abc', '?offset=-1', '?offset=2147483648']) {
    const res = await get('/api/stories' + q);
    assert.strictEqual(res.status, 400, `${q} -> ${res.status} ${res.text}`);
    assert.notStrictEqual(res.body.error, 'Invalid value',
      `${q}: the user is shown express-validator's default copy`);
    assert.deepStrictEqual(sqlMatching(/FROM stories/i), [], `${q}: queried anyway`);
  }
});

test('stories / WRONG THING: a repeated page size is two page sizes, and two is not one', async () => {
  for (const qs of ['?limit=30&limit=50', '?offset=0&offset=10', '?limit[]=30']) {
    const res = await get('/api/stories' + qs);
    assert.strictEqual(res.status, 400, `${qs} -> ${res.status} ${res.text}`);
    assert.deepStrictEqual(sqlMatching(/FROM stories/i), [], `${qs}: queried anyway`);
  }
});

test('stories / WRONG THING: the boundaries of the feed page', async () => {
  const { MAX_FEED_LIMIT } = storiesRouter.__test;
  for (const q of [`?limit=1`, `?limit=${MAX_FEED_LIMIT}`, `?offset=0`, `?offset=2147483647`]) {
    const res = await get('/api/stories' + q);
    assert.strictEqual(res.status, 200, `${q} -> ${res.status} ${res.text}`);
  }
  const over = await get(`/api/stories?limit=${MAX_FEED_LIMIT + 1}`);
  assert.strictEqual(over.status, 400, over.text);
});

test('stories / NOTHING: an account with no stories and no friends gets an honest empty feed', async () => {
  const res = await get('/api/stories');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { story_groups: [] });
});

test('stories / NOTHING: an empty body is a 400 that names the missing thing', async () => {
  for (const payload of [{}, { caption: 'hi' }, { image_url: '' }]) {
    const res = await post('/api/stories', payload);
    assert.strictEqual(res.status, 400, `${JSON.stringify(payload)} -> ${res.status} ${res.text}`);
    assert.match(res.body.error, /photo/i, res.text);
  }
  assert.strictEqual(moderateImageCalls, 0, 'paid to screen an image that was never sent');
});

test('stories / WRONG THING: the caption boundary is measured after the markup comes off', async () => {
  const { MAX_CAPTION_LENGTH } = storiesRouter.__test;
  const img = 'data:image/png;base64,' + 'A'.repeat(64);
  handlers.push([/^SELECT COUNT\(\*\) FILTER/i, () => ({ rows: [{ last_hour: 0, active: 0 }] })]);
  handlers.push([/AS last_hour/i, () => ({ rows: [{ last_hour: 0, active: 0 }] })]);
  handlers.push([/^INSERT INTO stories/i, (p) => ({ rows: [{ id: 1, user_id: 1, caption: p[2], created_at: 'x', expires_at: 'y' }], rowCount: 1 })]);

  const ok = await post('/api/stories', { image_url: img, caption: 'c'.repeat(MAX_CAPTION_LENGTH) });
  assert.strictEqual(ok.status, 201, ok.text);
  const over = await post('/api/stories', { image_url: img, caption: 'c'.repeat(MAX_CAPTION_LENGTH + 1) });
  assert.strictEqual(over.status, 400, over.text);
});

test('stories / WRONG THING: an oversized photo is refused before the paid screen runs', async () => {
  const { MAX_IMAGE_DATA_URL_BYTES } = storiesRouter.__test;
  const prefix = 'data:image/png;base64,';
  const big = prefix + 'A'.repeat(MAX_IMAGE_DATA_URL_BYTES - prefix.length + 1);
  const res = await post('/api/stories', { image_url: big });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(moderateImageCalls, 0, 'paid Cloud Vision to screen a photo we had already refused');
});
