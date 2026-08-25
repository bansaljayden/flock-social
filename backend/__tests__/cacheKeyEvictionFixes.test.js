// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// ROUND 23 — the five OPEN rows the cache-key inventory sweep could not touch.
// ---------------------------------------------------------------------------
// backend/utils/cacheKeyInventory.js is the standing enumeration of every cache
// key and every spend counter in the backend against one question: WHICH PART
// OF THIS KEY CAN THE CALLER PICK. Five of its rows were findings it could not
// close in the change that created it, because the code lived in files that
// change was not allowed to touch. This file pins each of those five as
// refused, in the same order the inventory lists them:
//
//   1. routes/auth.js underageAttempts   — the last wholesale clear() in the
//      backend, on the map that enforces the age gate.
//   2. services/weatherService.js weatherCache — ~6.5e8 caller-chosen keys
//      against a 100-entry cache.
//   3. routes/badge.js cache             — no bound, no sweep, and the one paid
//      Places surface with no place-id shape check.
//   4. routes/venueSearch.js venueCache  — a 200-entry cap one account's
//      allowance could walk straight through.
//   5. utils/placesBudget.js dayCount    — a global money counter with no
//      caller dimension on the doors that have no caller.
//
// EACH TEST PINS THE EXPLOIT, NOT THE IMPLEMENTATION. What is asserted is the
// property an attacker would have to break (the victim's entry survives the
// flood; the junk id never reaches Postgres; a day of spending cannot evict an
// entry), plus the INEQUALITIES the sizing rests on, read from the modules'
// own exported constants rather than retyped here. A test that retypes a
// constant stops testing the code the moment somebody edits the code.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'cache-key-eviction-fixes-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.WEATHER_API_KEY = 'test-weather-key';

const BACKEND = path.join(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(BACKEND, ...p), 'utf8');

// ===========================================================================
// 1. routes/auth.js — underageAttempts.clear()
// ===========================================================================
// THE EXPLOIT. The email half of this key is chosen by an UNAUTHENTICATED
// caller: POST /signup with any address and an under-13 date of birth writes
// one entry. The memory guard ended in `underageAttempts.clear()`, so 20,001
// refused signups with distinct addresses wiped every remembered refusal at
// once — every other child's mailbox block AND every IP block, which are the
// server-side version of the cookie the FTC's COPPA FAQ asks for. Flock's
// floor is 13. The age gate was resettable on demand, by anyone, at a moment
// they chose.
//
// The flood below is aimed the way a real one would be: the attacker's own
// refusal is recorded FIRST, then they spray. Every sprayed entry therefore
// expires later than the entry they are trying to delete, which is exactly the
// property the eviction order turns against them.

const authRouter = require('../routes/auth');
const {
  recordUnderageAttempt, underageBlocked, clearUnderageAttempts,
  underageAttemptCount, UNDERAGE_MAX_KEYS, UNDERAGE_LOW_WATER,
  UNDERAGE_IP_TTL_MS, UNDERAGE_EMAIL_TTL_MS,
} = authRouter.__testing;

test('the age gate survives the flood that used to clear() it', () => {
  clearUnderageAttempts();
  const t0 = Date.now();

  // The refusal the attacker wants gone: one mailbox, one address. Recorded
  // as a PROVED refusal (round 25, R5-H1) so the mailbox half is the wide,
  // address-keyed 24-hour entry rather than the address-plus-IP one — that is
  // the entry with the most to lose and therefore the one worth flooding at.
  recordUnderageAttempt('kid@example.com', '198.51.100.7', t0, { addressProved: true });
  assert.strictEqual(underageBlocked('kid@example.com', null, t0 + 1), true);
  assert.strictEqual(underageBlocked(null, '198.51.100.7', t0 + 1), true);

  // Now spray. More than twice the ceiling, so eviction runs several times
  // rather than once — a fix that only survives the first pass is not a fix.
  const FLOOD = UNDERAGE_MAX_KEYS * 2 + 5000;
  for (let i = 0; i < FLOOD; i++) {
    recordUnderageAttempt(`flood-${i}@example.com`, null, t0 + 1000 + i, { addressProved: true });
  }
  const after = t0 + 1000 + FLOOD;

  // 1. The map is bounded — the flood cannot grow it without limit.
  assert.ok(underageAttemptCount() <= UNDERAGE_MAX_KEYS + 1,
    `map holds ${underageAttemptCount()}, ceiling is ${UNDERAGE_MAX_KEYS}`);
  // 2. And it is NOT empty, which is the whole finding. clear() left zero.
  assert.ok(underageAttemptCount() >= UNDERAGE_LOW_WATER,
    `the flood emptied the lockout map (${underageAttemptCount()} entries left); `
    + 'that is the clear() bug, back');

  // 3. The mailbox block the attacker was aiming at is still there. Every
  //    write they made expires LATER than it, so longest-remaining-first
  //    deletes their own entries before it ever reaches the target.
  assert.strictEqual(underageBlocked('kid@example.com', null, after), true,
    'a flood of refused signups displaced the under-13 refusal it was aimed at');

  // 4. And so is the IP block — the half that stops the refused child in the
  //    room from back-buttoning to a passing date. It has the SHORTEST TTL in
  //    the map, so under a soonest-to-expire order it would have gone first.
  assert.ok(t0 + UNDERAGE_IP_TTL_MS > after, 'the IP entry must still be inside its window');
  assert.strictEqual(underageBlocked(null, '198.51.100.7', after), true,
    'the flood evicted the IP blocks, which are what the age gate rests on');

  clearUnderageAttempts();
});

test('a refused signup cannot buy anyone else a passing date: eviction order is stated, not incidental', () => {
  clearUnderageAttempts();
  const t0 = Date.now();
  // Two blocks recorded at the same instant, one email (24h) and one IP (15m).
  recordUnderageAttempt('early@example.com', null, t0, { addressProved: true });
  recordUnderageAttempt(null, '203.0.113.5', t0);
  // Fill past the ceiling with entries that all expire later than both.
  for (let i = 0; i < UNDERAGE_MAX_KEYS + 2500; i++) {
    recordUnderageAttempt(`late-${i}@example.com`, null, t0 + 10 + i, { addressProved: true });
  }
  const now = t0 + 10 + UNDERAGE_MAX_KEYS + 2500;
  assert.strictEqual(underageBlocked(null, '203.0.113.5', now), true,
    'the shortest-lived entry must be the LAST evicted, not the first');
  assert.strictEqual(underageBlocked('early@example.com', null, now), true);
  assert.ok(UNDERAGE_EMAIL_TTL_MS > UNDERAGE_IP_TTL_MS);
  clearUnderageAttempts();
});

test('no wholesale clear() survives on the lockout map outside the test-only export', () => {
  // Comments are stripped first: the block that documents the bug quotes the
  // call it removed, and prose is not a call site.
  const src = readSrc('routes', 'auth.js').replace(/^\s*\/\/.*$/gm, '');
  const clears = src.split('\n').filter((l) => l.includes('underageAttempts.clear()'));
  assert.strictEqual(clears.length, 1,
    `underageAttempts.clear() appears ${clears.length} times; it may exist only on the `
    + '__testing export');
  assert.ok(/clearUnderageAttempts:\s*\(\)\s*=>\s*underageAttempts\.clear\(\)/.test(clears[0]),
    `the surviving clear() is not the test-only export: ${clears[0].trim()}`);
});

// ===========================================================================
// 2. services/weatherService.js — weatherCache
// ===========================================================================
// THE EXPLOIT. GET /api/weather passes the caller's own lat/lon straight
// through, so the key is entirely caller-chosen, and at the 2-decimal grid
// there are ~6.5e8 reachable keys against what was a 100-entry cache. Three
// requests' worth of fresh coordinates evicted every entry, and each evicted
// entry is a paid OpenWeatherMap call the next crowd score has to make again.
// The spend was capped; the FLUSH was not, and a flush is how you make everyone
// ELSE spend.
//
// Bucketing is the first move and it is NOT the whole answer, which is what
// these tests say out loud: the key was ALREADY on the 2dp grid that
// routes/publicCrowd.js and the crowd batch route snap to, and 2dp still leaves
// 6.5e8 buckets. What bucketing buys is that the rounding is single-sourced, so
// the cache key and the coordinate actually sent upstream cannot drift apart.
// The control is the CAP, and the cap is pinned to the daily budget.

const weatherService = require('../services/weatherService');
const wx = weatherService.__test;

test('weather coordinates are bucketed to the same 2dp grid the crowd routes use', () => {
  assert.strictEqual(wx.bucketCoord(40.712776), '40.71');
  assert.strictEqual(wx.bucketCoord(-74.005974), '-74.01');
  assert.strictEqual(wx.getCacheKey(40.712776, -74.005974), '40.71,-74.01');
  // Two callers a few metres apart are one key and therefore one paid call.
  assert.strictEqual(wx.getCacheKey(40.7123, -74.0061), wx.getCacheKey(40.7119, -74.0059));
});

test('the bucketing is single-sourced: the cache key and the outbound URL round identically', () => {
  const src = readSrc('services', 'weatherService.js');
  // Both request URLs must interpolate bucketCoord, not their own toFixed(2).
  const urls = src.match(/api\.openweathermap\.org[^`]*/g) || [];
  assert.ok(urls.length >= 2, 'expected both the current-conditions and forecast URLs');
  for (const u of urls) {
    assert.ok(u.includes('${bucketCoord(lat)}') && u.includes('${bucketCoord(lon)}'),
      `a weather URL rounds its own coordinates instead of using bucketCoord: ${u.slice(0, 120)}`);
  }
  // And nothing else in the file rounds a coordinate on its own.
  const strays = src.match(/Number\((lat|lon)\)\.toFixed\(/g) || [];
  assert.deepStrictEqual(strays, [],
    'a second copy of the rounding rule is a key that can stop describing what is stored under it');
});

test('a whole day of paid weather calls cannot evict one unexpired cache entry', () => {
  weatherService.__resetWeatherState();
  // THE PIN. Every cache write in weatherService follows a charged
  // allowWeatherFetch unit — nothing writes on a hit and nothing writes on a
  // refusal — so the most entries this map can be made to take in one UTC day
  // is exactly WX_DAILY. Keeping the cache larger than that ceiling makes
  // eviction unreachable inside a day.
  assert.ok(wx.WX_DAILY < wx.MAX_CACHE_ENTRIES,
    `WX_DAILY (${wx.WX_DAILY}) must stay under MAX_CACHE_ENTRIES (${wx.MAX_CACHE_ENTRIES}); `
    + 'raise the cache when you raise the budget, or the budget buys a flush');
  // The old numbers, for the record: 950 paid calls against a 100-entry cache.
  assert.ok(wx.WX_DAILY > 100, 'this pin is meaningless if the daily budget is tiny');

  const victim = wx.getCacheKey(39.74, -104.98);
  wx.setCache(victim, { temp: 61 });

  // Walk the grid with every unit the day allows.
  for (let i = 0; i < wx.WX_DAILY; i++) {
    wx.setCache(wx.getCacheKey(-89 + (i % 170) + i / 1000, (i % 359) - 179), { temp: i });
  }
  assert.ok(wx.cacheHas(victim),
    'a day of coordinate-walking flushed the shared weather cache; every evicted entry is a '
    + "paid call somebody else's crowd score now has to make");
  weatherService.__resetWeatherState();
});

test('the weather cache is still bounded when the day rolls over', () => {
  weatherService.__resetWeatherState();
  for (let i = 0; i < wx.MAX_CACHE_ENTRIES + 250; i++) {
    wx.setCache(`synthetic:${i}`, { temp: i });
  }
  assert.ok(wx.cacheSize() <= wx.MAX_CACHE_ENTRIES,
    `cache holds ${wx.cacheSize()}, ceiling is ${wx.MAX_CACHE_ENTRIES}`);
  weatherService.__resetWeatherState();
});

// ===========================================================================
// 3. routes/badge.js — the unbounded, unshaped, undimensioned public badge
// ===========================================================================
// THE EXPLOIT, in three parts. The badge is UNAUTHENTICATED and its placeId was
// validated only as a 4-300 character string, so any junk string bought one
// Postgres lookup on the 20-connection primary pool. The response cache had no
// maxEntries and no sweep at all. And of the three paid Places doors with no
// account to charge, this was the only one with no caller dimension of any
// kind — no per-IP gate, no sub-ceiling under the shared 3000-call day.

const pool = require('../config/database');
let queries = [];
let dbHandlers = [];
pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: flat, params });
  for (const [re, fn] of dbHandlers) {
    if (re.test(flat)) return Promise.resolve(fn(params || [], flat) || { rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

weatherService.getWeather = async () => ({
  temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3,
  isRaining: false, conditionId: 800, fetchedAt: Date.now(),
});

const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({
  score: 55, label: 'Moderate', confidence: 60, factors: {},
  dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'test',
});

let googleCalls = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    googleCalls.push(u);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'PLACE_BADGE', displayName: { text: 'The Bar' }, types: ['bar'],
        location: { latitude: 39.74, longitude: -104.98 },
        rating: 4.4, userRatingCount: 120, priceLevel: 'PRICE_LEVEL_MODERATE',
        currentOpeningHours: { openNow: true },
      }),
    });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

const badgeRouter = require('../routes/badge');
const badge = badgeRouter.__test;
const { __resetPlacesBudget } = require('../utils/placesBudget');

const app = express();
app.use('/api/badge', badgeRouter);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  queries = [];
  dbHandlers = [];
  googleCalls = [];
  __resetPlacesBudget();
  badge.resetBadgeBudget();
});

async function getBadgeRoute(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  return { status: res.status, body: await res.text() };
}

test('an unshaped badge id never reaches Postgres', async () => {
  dbHandlers.push([/FROM venue_profiles/, () => ({ rows: [{ x: 1 }], rowCount: 1 })]);

  // 300 characters, which the old isLength({min:4,max:300}) accepted verbatim.
  const junk = 'A'.repeat(300);
  const refused = await getBadgeRoute(`/api/badge/${junk}.svg`);
  assert.strictEqual(refused.status, 404);
  assert.deepStrictEqual(queries, [],
    'a 300-character junk id still bought an unauthenticated query on the primary pool');
  assert.deepStrictEqual(googleCalls, []);

  // Shaped-but-unknown gets the SAME answer, so the refusal is not an oracle
  // for which ids happen to be the right shape.
  dbHandlers = [];
  const unknown = await getBadgeRoute('/api/badge/PLACE_UNKNOWN_ID.svg');
  assert.strictEqual(unknown.status, 404, 'a shaped unknown id and an unshaped one must agree');
});

test('badge.js gates on the shared place-id helper rather than its own copy of the regex', () => {
  const src = readSrc('routes', 'badge.js');
  assert.ok(/require\('\.\.\/utils\/places'\)/.test(src),
    'badge.js must import isPlaceIdShaped from utils/places.js');
  assert.ok(src.includes('isPlaceIdShaped(placeId)'), 'the shape gate is not wired in');
  // A second copy of the rule is a second thing to keep in step with the first.
  assert.ok(!/\[A-Za-z0-9_-\]\{\d+,\d+\}/.test(src),
    'a place-id regex has been copied into badge.js; import PLACE_ID_RE instead');
});

test('a badge miss is metered per address, and a cache hit is free', async () => {
  dbHandlers.push([/FROM venue_profiles/, () => ({ rows: [{ x: 1 }], rowCount: 1 })]);

  const first = await getBadgeRoute('/api/badge/PLACE_BADGE_ONE.svg');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(queries.length, 1);
  assert.strictEqual(googleCalls.length, 1);

  // Second request for the same venue rides the cache: no query, no Google
  // call, and no budget unit — an embed serves its whole audience off one entry.
  const second = await getBadgeRoute('/api/badge/PLACE_BADGE_ONE.svg');
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body, first.body);
  assert.strictEqual(queries.length, 1, 'a cache hit must not reach Postgres');
  assert.strictEqual(googleCalls.length, 1, 'a cache hit must not reach Google');
});

test('one address cannot walk the badge surface without limit', () => {
  badge.resetBadgeBudget();
  const req = { ip: '198.51.100.9' };
  let allowed = 0;
  for (let i = 0; i < badge.BADGE_IP_HOURLY + 40; i++) if (badge.allowBadgeMiss(req)) allowed++;
  assert.strictEqual(allowed, badge.BADGE_IP_HOURLY,
    'the per-address hourly gate on badge misses is not holding');
  // A refusal consumes nothing, so a different address is unaffected.
  assert.strictEqual(badge.allowBadgeMiss({ ip: '203.0.113.4' }), true);
  badge.resetBadgeBudget();
});

test('the badge cache is bounded and evicts to a low-water mark', () => {
  badge.resetBadgeBudget();
  for (let i = 0; i < badge.BADGE_CACHE_MAX + 300; i++) badge.setBadge(`PLACE_BOUND_${i}`, '<svg/>');
  assert.ok(badge.cacheSize() <= badge.BADGE_CACHE_MAX,
    `badge cache holds ${badge.cacheSize()}, ceiling is ${badge.BADGE_CACHE_MAX}`);
  assert.ok(badge.cacheSize() >= badge.BADGE_CACHE_LOW_WATER,
    'evicting past the low-water mark makes every later write pay a full scan');
  badge.resetBadgeBudget();
});

// ===========================================================================
// 4. routes/venueSearch.js — venueCache, and the cap as an inequality
// ===========================================================================
// THE EXPLOIT. Authenticated, and every miss charges allowPlacesSearch, so the
// SPEND was capped. The eviction ORDER was already right. The CAP was the weak
// number: 200 entries against an ~80-character free-text key space meant a few
// hundred unique searches flushed the SHARED cache, and every flushed entry is
// a fresh paid Google call the next user makes.
//
// The fix is not "a bigger number". It is a number pinned to the only thing
// that bounds writes — the Places allowance — so the relationship survives
// someone editing either side of it.

const venueSearchRouter = require('../routes/venueSearch');
const vs = venueSearchRouter.__test;

test('one account\'s entire Places allowance cannot flush the shared venue cache', () => {
  // THE PIN: PER_USER_HOURLY x 24 < VENUE_CACHE_MAX. Every write here is one
  // charged unit, so an account's writes ARE its allowance. 30/hour spent
  // around the clock is 720 entries in a day, and the cache holds more than
  // that — so one account cannot evict the shared working set even by spending
  // everything it has, all day. Same shape as
  // EVENT_USER_DAILY(400) < EVENT_CACHE_MAX(500) in services/mlPredictor.js.
  const oneAccountPerDay = vs.PER_USER_HOURLY * 24;
  assert.ok(oneAccountPerDay < vs.VENUE_CACHE_MAX,
    `one account can write ${oneAccountPerDay} entries a day against a cache of `
    + `${vs.VENUE_CACHE_MAX}; raise VENUE_CACHE_MAX or lower PER_USER_HOURLY`);

  vs.clearVenueCache();
  const victim = 'search:oakwood bars|39.74,-104.98';
  vs.setCache(victim, { venues: [] });
  for (let i = 0; i < oneAccountPerDay; i++) vs.setCache(`search:walk-${i}|`, { venues: [] });
  assert.ok(vs.getCached(victim),
    'a single account walked the free-text key space and flushed everybody else\'s cache');
  vs.clearVenueCache();
});

test('the venue cache still evicts, to a low-water mark, once the budget could not have paid for it', () => {
  vs.clearVenueCache();
  for (let i = 0; i < vs.VENUE_CACHE_MAX + 200; i++) vs.setCache(`search:bound-${i}|`, { venues: [] });
  assert.ok(vs.venueCacheSize() <= vs.VENUE_CACHE_MAX,
    `venue cache holds ${vs.venueCacheSize()}, ceiling is ${vs.VENUE_CACHE_MAX}`);
  assert.ok(vs.venueCacheSize() >= vs.VENUE_CACHE_LOW_WATER,
    'evicting to exactly the ceiling makes a full cache sort itself on every write');
  vs.clearVenueCache();
});

// ===========================================================================
// 5. utils/placesBudget.js — a caller dimension on the doors with no caller
// ===========================================================================
// THE FINDING, restated. GLOBAL_DAILY is keyed on the UTC date and nothing
// else. A per-ACCOUNT budget cannot apply to a door with no account, so the
// honest dimension on the unauthenticated doors is the source address — and
// the per-IP gate is only half of it. The other half is a DAILY SUB-CEILING
// strictly below the ceiling it sits under, because a sub-ceiling above its
// ceiling never binds. routes/venueSearch.js's photo leg was exactly that:
// PUBLIC_PHOTO_BUDGET was 4000 against a GLOBAL_DAILY of 3000, so ten
// addresses at 300/hour could spend the whole shared Google day in an hour.
//
// THE PHOTO DOOR NO LONGER DECLARES ITS CEILING IN REQUESTS. It declares one
// annual dollar figure (services/photoStore.js PHOTO_BUDGET_USD_PER_YEAR) and
// derives a monthly fetch ceiling and a daily brake from it, in Postgres. The
// question this file asks is unchanged and the answer still has to hold: the
// most that door can spend in a day must sit under the shared day.

test('every unauthenticated Places door has a daily sub-ceiling under the shared day', () => {
  assert.ok(badge.BADGE_DAILY < badge.GLOBAL_DAILY,
    `BADGE_DAILY (${badge.BADGE_DAILY}) must sit under GLOBAL_DAILY (${badge.GLOBAL_DAILY})`);
  const PHOTO_DAILY = require('../services/photoStore').PHOTO_FETCH_BURST_PER_DAY;
  assert.ok(PHOTO_DAILY < vs.GLOBAL_DAILY,
    `the photo proxy's daily brake (${PHOTO_DAILY}) must sit under GLOBAL_DAILY `
    + `(${vs.GLOBAL_DAILY}); a sub-ceiling above its ceiling never binds`);

  // The public demo's own leg is declared inline in routes/publicCrowd.js. Read
  // it rather than retyping it, so this stays true if it moves.
  const demoSrc = readSrc('routes', 'publicCrowd.js');
  const demoLeg = demoSrc.match(/dayCount\s*>=\s*(\d+)/);
  assert.ok(demoLeg, 'routes/publicCrowd.js no longer declares a daily demo leg');
  const DEMO_DAILY = Number(demoLeg[1]);
  assert.ok(DEMO_DAILY < vs.GLOBAL_DAILY);

  // And together they cannot take the whole invoice.
  //
  // SECURITY-AUDIT-money.md M5-1 corrected what this assertion is allowed to
  // mean. The sum is 2700 against 3000, which is 90%, so "they cannot starve
  // the signed-in product" was never what it proved — it left the authenticated
  // product 300 calls a day, about 40 addresses' worth of work to reach. The
  // share the product actually keeps comes from UNAUTH_DAILY, which
  // allowGlobalPlacesCall enforces across all three doors at once; that is
  // pinned in __tests__/unauthPlacesReserve.test.js. What is checked HERE is
  // the weaker thing this file can check: the per-door ceilings still sum to
  // less than the whole day, so no door is decorative.
  const unauthenticatedTotal = badge.BADGE_DAILY + PHOTO_DAILY + DEMO_DAILY;
  assert.ok(unauthenticatedTotal < vs.GLOBAL_DAILY,
    `the three unauthenticated doors can together spend ${unauthenticatedTotal} of a `
    + `${vs.GLOBAL_DAILY}-call day, which leaves the signed-in product nothing`);
});

test('the Vision spend counter has no unauthenticated door for a per-IP budget to cover', () => {
  // The Places day counter got a per-IP dimension because it has doors with no
  // account behind them. The Vision day counter was asked the same question and
  // the answer is no: every path to allowVisionCall carries an authenticated
  // identity, so a per-IP budget there would refuse nobody the account budget
  // does not already refuse. Adding one would make the inventory row LOOK
  // closed while changing nothing, which is the failure the inventory exists to
  // prevent. This test pins the fact the reasoning rests on.
  const visionCallers = [];
  for (const dir of ['routes', 'utils', 'services', 'sockets']) {
    for (const f of fs.readdirSync(path.join(BACKEND, dir)).filter((n) => n.endsWith('.js'))) {
      const src = readSrc(dir, f);
      if (/allowVisionCall\s*\(/.test(src) && f !== 'visionBudget.js') visionCallers.push(`${dir}/${f}`);
    }
  }
  assert.deepStrictEqual(visionCallers, ['utils/moderation.js'],
    'a new caller of allowVisionCall appeared; re-ask whether it has an account behind it '
    + 'before trusting the visionBudget inventory row');

  // And every door into moderateImage is authenticated.
  const doors = [];
  for (const dir of ['routes', 'sockets']) {
    for (const f of fs.readdirSync(path.join(BACKEND, dir)).filter((n) => n.endsWith('.js'))) {
      const src = readSrc(dir, f);
      if (/moderateImage\s*\(/.test(src)) doors.push([`${dir}/${f}`, src]);
    }
  }
  assert.ok(doors.length >= 3, 'the moderateImage scan found almost nothing, so it is broken');
  for (const [name, src] of doors) {
    assert.ok(/authenticate/.test(src),
      `${name} reaches billed Cloud Vision without an authenticated identity; the visionBudget `
      + 'row\'s "no unauthenticated door" argument no longer holds');
  }
});
