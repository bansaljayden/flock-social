// ---------------------------------------------------------------------------
// The Places photo cache: routes/venueSearch.js
// ---------------------------------------------------------------------------
// Places photos are the largest line in this project's real spend, and this
// cache is the only thing between a venue card and a billed Google call. Two
// numbers in it were wrong in ways no test could see:
//
//   * a ONE HOUR TTL on bytes that are immutable by construction. A photo
//     resource name is a handle for one specific photo; Google mints a new name
//     rather than swapping the bytes behind an old one. An hour meant a venue
//     card on screen across a day was re-bought roughly 24 times.
//   * an entry cap (500) with no byte accounting, so the memory this map could
//     hold was 500 times whatever the upstream happened to return.
//
// And one behaviour that was wrong in a way that only shows up once the TTL is
// long: eviction was FIFO. With a one-hour window that barely matters; with a
// seven-day window it means the venue everybody looks at is evicted because it
// was cached first, and then bought again.
const test = require('node:test');
const assert = require('node:assert/strict');

const photoStore = require('../services/photoStore');
const venueSearch = require('../routes/venueSearch');
const {
  PHOTO_CACHE_TTL, MAX_PHOTO_CACHE_BYTES, MAX_SINGLE_PHOTO_BYTES,
  photoContentType, storePhoto, touchPhotoCache,
  photoCacheKeys, photoCacheBytes, getPhotoCached, clearPhotoCache,
} = venueSearch.__test;

const entry = (bytes, ts = Date.now()) => ({
  buffer: Buffer.alloc(bytes, 0x41), contentType: 'image/jpeg', ts,
});

test.beforeEach(() => clearPhotoCache());

// ---------------------------------------------------------------------------
// 1. The cost numbers
// ---------------------------------------------------------------------------

test('the TTL is 30 consecutive calendar days, the longest window the Places terms name', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  assert.ok(PHOTO_CACHE_TTL >= DAY,
    'an hour-scale TTL re-buys immutable bytes around 24 times a day');
  // WHAT THIS ASSERTION USED TO SAY, AND WHY IT WAS WRONG. It read "the Google
  // Maps Platform terms permit temporarily caching Places content for up to 30
  // days". That sentence is not in the terms. Read on 2026-08-20:
  //
  //   Terms of Service 3.2.3(b) (No Caching): "Customer will not cache Google
  //   Maps Content except as expressly permitted under the Maps Service
  //   Specific Terms."
  //
  //   Maps Service Specific Terms 14.3 (Places API (Legacy and New), Caching):
  //   "Customer may temporarily cache latitude and longitude values from the
  //   Places API for up to 30 consecutive calendar days, after which Customer
  //   must delete the cached latitude and longitude values."
  //
  // So 30 consecutive calendar days is a real number in the real terms, and the
  // content it is granted for is latitude and longitude, not photo bytes. There
  // is no clause that expressly permits caching a Places photo at all, which
  // means the seven days this repo ran for months was not the compliant choice
  // that comment claimed it was. 30 days is the longest window the Places
  // section names for anything, the decision is recorded in the header of
  // services/photoStore.js with the clauses quoted, and this is the ceiling.
  assert.ok(PHOTO_CACHE_TTL <= 30 * DAY,
    'past 30 days there is no window in the Places terms left to point at');
  assert.strictEqual(PHOTO_CACHE_TTL, 30 * DAY);

  // And the number is not retyped here or in the route: one constant, in the
  // file that carries the quoted clauses it was chosen against.
  assert.strictEqual(PHOTO_CACHE_TTL, photoStore.PHOTO_CACHE_TTL_MS);
});

test('the cache is bounded in BYTES, and one response cannot take a large share of it', () => {
  assert.ok(Number.isFinite(MAX_PHOTO_CACHE_BYTES) && MAX_PHOTO_CACHE_BYTES > 0);
  assert.ok(MAX_SINGLE_PHOTO_BYTES * 8 <= MAX_PHOTO_CACHE_BYTES,
    'a single entry must not be able to claim a meaningful fraction of the budget');
});

// ---------------------------------------------------------------------------
// 2. The budget actually holds
// ---------------------------------------------------------------------------

test('the total never exceeds the byte budget, however many photos arrive', () => {
  const each = 1024 * 1024; // 1 MB apiece
  const needed = Math.ceil(MAX_PHOTO_CACHE_BYTES / each) + 12;
  for (let i = 0; i < needed; i++) storePhoto(`p${i}|400`, entry(each));

  assert.ok(photoCacheBytes() <= MAX_PHOTO_CACHE_BYTES,
    `held ${photoCacheBytes()} against a budget of ${MAX_PHOTO_CACHE_BYTES}`);
  // And the accounting agrees with what is actually in the map. A counter that
  // drifts from the contents is a budget that stops binding.
  const actual = photoCacheKeys().reduce((n, k) => n + getPhotoCached(k).buffer.length, 0);
  assert.strictEqual(photoCacheBytes(), actual);
});

test('an oversized response is served but never stored', () => {
  storePhoto('huge|400', entry(MAX_SINGLE_PHOTO_BYTES + 1));
  assert.deepStrictEqual(photoCacheKeys(), []);
  assert.strictEqual(photoCacheBytes(), 0);
});

test('re-storing the same key replaces its bytes rather than double-counting them', () => {
  storePhoto('same|400', entry(1000));
  storePhoto('same|400', entry(4000));
  assert.deepStrictEqual(photoCacheKeys(), ['same|400']);
  assert.strictEqual(photoCacheBytes(), 4000);
});

// ---------------------------------------------------------------------------
// 3. Eviction order: least recently USED, not first in
// ---------------------------------------------------------------------------

// Entry size for the eviction cases: the largest a single entry may be, so the
// budget is reached in as few stores as possible. Anything larger is refused by
// MAX_SINGLE_PHOTO_BYTES and would never enter the map at all.
const CHUNK = MAX_SINGLE_PHOTO_BYTES;
const CHUNKS_TO_FILL = Math.floor(MAX_PHOTO_CACHE_BYTES / CHUNK);

test('a hit on an entry saves it from the next eviction', () => {
  storePhoto('hot|400', entry(CHUNK));
  for (let i = 0; i < CHUNKS_TO_FILL - 1; i++) storePhoto(`f${i}|400`, entry(CHUNK));

  // 'hot' is now the oldest by insertion and the map is full. Reading it is what
  // the route does on a cache hit, and it is what makes FIFO and LRU differ.
  touchPhotoCache('hot|400', getPhotoCached('hot|400'));

  storePhoto('newcomer|400', entry(CHUNK)); // forces an eviction

  const keys = photoCacheKeys();
  assert.ok(keys.includes('hot|400'), 'FIFO evicted the entry that was just used');
  assert.ok(!keys.includes('f0|400'), 'the genuinely least recently used entry should go first');
  assert.ok(photoCacheBytes() <= MAX_PHOTO_CACHE_BYTES);
});

test('expired entries are dropped before anything live is', () => {
  storePhoto('stale|400', entry(CHUNK, Date.now() - PHOTO_CACHE_TTL - 1));
  storePhoto('live|400', entry(CHUNK));
  for (let i = 0; i < CHUNKS_TO_FILL - 2; i++) storePhoto(`f${i}|400`, entry(CHUNK));
  storePhoto('newest|400', entry(CHUNK)); // over budget: something has to go

  const keys = photoCacheKeys();
  assert.ok(!keys.includes('stale|400'), 'an expired entry is free to drop and must go first');
  assert.ok(keys.includes('live|400'), 'a live entry was evicted while an expired one was still held');
});

// ---------------------------------------------------------------------------
// 4. The Content-Type this route serves
// ---------------------------------------------------------------------------

test('the served Content-Type is clamped to an image type, never echoed', () => {
  // This response is served from the API origin and embedded cross-site. Echoing
  // an upstream header verbatim onto our own origin means a third party decides
  // what kind of document we serve.
  assert.strictEqual(photoContentType('image/webp'), 'image/webp');
  assert.strictEqual(photoContentType('image/JPEG; charset=utf-8'), 'image/jpeg');
  for (const hostile of [
    'text/html', 'image/svg+xml', 'application/javascript',
    'text/html; charset=utf-8', '', null, undefined, 'nonsense',
  ]) {
    assert.strictEqual(photoContentType(hostile), 'image/jpeg', String(hostile));
  }
  // SVG is the one image type deliberately refused: it is a script container,
  // and Places does not serve one.
  assert.notStrictEqual(photoContentType('image/svg+xml'), 'image/svg+xml');
});

test('the photo response carries nosniff', () => {
  // Helmet sets this globally, but this handler writes Content-Type itself on
  // the one response class where sniffing actually matters, so the pairing is
  // pinned next to the type rather than assumed from middleware order.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes/venueSearch.js'), 'utf8');
  const body = src.slice(src.indexOf('function sendPhoto'));
  const fn = body.slice(0, body.indexOf('\n}'));
  assert.ok(/X-Content-Type-Options.*nosniff/.test(fn), 'sendPhoto does not set nosniff');
  assert.ok(/photoContentType\(contentType\)/.test(fn), 'sendPhoto echoes the upstream type');
});

// ---------------------------------------------------------------------------
// 5. THE RESTART. A photo bought once must not be bought twice.
// ---------------------------------------------------------------------------
// A Railway deploy is, from this module's point of view, exactly two things:
// the L1 Map is empty, and Postgres is untouched. That is what these tests
// simulate, and the property under test is that the first request after a
// restart costs nothing at Google.

const pool = require('../config/database');
const { fetchPhotoOnce, photoCacheKey } = venueSearch.__test;

// A small honest stand-in for the two tables in migration 046, so the whole
// read path (L2 lookup, ledger charge, L2 write) runs for real against
// something that behaves the way the real statements do.
const fakeDb = { photos: new Map(), spendToday: 0, reads: 0, writes: 0 };
function resetFakeDb() {
  fakeDb.photos.clear();
  fakeDb.spendToday = 0;
  fakeDb.reads = 0;
  fakeDb.writes = 0;
}
pool.query = (text, params = []) => {
  const sql = String(text && text.text ? text.text : text);
  // The DELETE is matched FIRST, on purpose: "DELETE FROM places_photo_cache"
  // contains "FROM places_photo_cache", so a SELECT-shaped test written first
  // silently swallows the pruner and the expiry looks like it never runs.
  if (/DELETE FROM places_photo_cache/i.test(sql)) {
    let n = 0;
    for (const [k, v] of fakeDb.photos) {
      if (Date.now() - v.fetched_at >= photoStore.PHOTO_CACHE_TTL_MS) {
        fakeDb.photos.delete(k);
        n++;
      }
    }
    return Promise.resolve({ rows: [], rowCount: n });
  }
  if (/FROM places_photo_cache/i.test(sql)) {
    fakeDb.reads++;
    const row = fakeDb.photos.get(params[0]);
    // The real SELECT filters on fetched_at, so this one does too: an expired
    // row must read as a miss here for the same reason it does there.
    if (!row || Date.now() - row.fetched_at > photoStore.PHOTO_CACHE_TTL_MS) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({
      rows: [{
        content_type: row.content_type,
        bytes: row.bytes,
        fetched_at: new Date(row.fetched_at),
      }],
      rowCount: 1,
    });
  }
  if (/INTO places_photo_cache/i.test(sql)) {
    fakeDb.writes++;
    fakeDb.photos.set(params[0], {
      content_type: params[1], bytes: params[2], fetched_at: Date.now(),
    });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/INTO places_photo_spend/i.test(sql)) {
    const monthCeiling = params[0];
    const dayBrake = params[1];
    if (fakeDb.spendToday >= dayBrake || fakeDb.spendToday >= monthCeiling) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    fakeDb.spendToday++;
    return Promise.resolve({ rows: [{ fetches: fakeDb.spendToday }], rowCount: 1 });
  }
  if (/FROM places_photo_spend/i.test(sql)) {
    return Promise.resolve({
      rows: [{ month_used: fakeDb.spendToday, day_used: fakeDb.spendToday }], rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const PIXELS = Buffer.from('a-real-jpeg-would-go-here');
let googleCalls = 0;
global.fetch = async (url) => {
  googleCalls++;
  if (String(url).includes('/media')) {
    return { ok: true, json: async () => ({ photoUri: 'https://cdn.example/photo.jpg' }) };
  }
  return {
    ok: true,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => PIXELS.buffer.slice(
      PIXELS.byteOffset, PIXELS.byteOffset + PIXELS.length
    ),
  };
};

const REQ = { ip: '203.0.113.9' };
const REF = 'places/PLACE_A/photos/AbCdEf';

// What a deploy does, and the only thing it does that matters here.
function restart() {
  clearPhotoCache();
}

test('a photo bought before a restart is served after it without a second Google call', async () => {
  resetFakeDb();
  clearPhotoCache();
  googleCalls = 0;
  const key = photoCacheKey(REF, 400);

  const first = await fetchPhotoOnce(REF, 400, key, REQ);
  assert.strictEqual(first.status, 200);
  assert.ok(googleCalls > 0, 'the first request must actually buy the photo');
  assert.strictEqual(fakeDb.spendToday, 1, 'exactly one billable fetch was charged');
  assert.strictEqual(fakeDb.photos.size, 1, 'the purchase was never written down');

  const callsAfterPurchase = googleCalls;
  restart();
  assert.deepStrictEqual(photoCacheKeys(), [], 'the restart did not empty the in-memory tier');

  const second = await fetchPhotoOnce(REF, 400, key, REQ);
  assert.strictEqual(second.status, 200);
  assert.deepStrictEqual(second.buffer, first.buffer, 'the bytes came back different after a restart');
  assert.strictEqual(googleCalls, callsAfterPurchase,
    'the request after the restart went back to Google: the cache did not survive');
  assert.strictEqual(fakeDb.spendToday, 1,
    'a restart re-charged the budget for a photo that was already bought');

  // And it refilled the memory tier on the way through, so the NEXT request is
  // an L1 hit and never reaches this function at all. (fetchPhotoOnce is only
  // called on an L1 miss, which is why this is asserted on the map rather than
  // on a database round-trip count.)
  assert.ok(getPhotoCached(key),
    'the L2 hit did not populate L1, so every later request pays a database round trip');
  assert.deepStrictEqual(getPhotoCached(key).buffer, first.buffer);
});

test('fifteen deploys in one night cost one photo, not fifteen', async () => {
  // The literal night this change was written for.
  resetFakeDb();
  clearPhotoCache();
  googleCalls = 0;
  const key = photoCacheKey(REF, 160);

  for (let deploy = 0; deploy < 15; deploy++) {
    restart();
    const out = await fetchPhotoOnce(REF, 160, key, REQ);
    assert.strictEqual(out.status, 200, `deploy ${deploy} served nothing`);
  }
  assert.strictEqual(fakeDb.spendToday, 1,
    `fifteen deploys bought the same photo ${fakeDb.spendToday} times`);
});

test('an expired row is a miss and is deleted, because the window is a terms obligation', async () => {
  resetFakeDb();
  clearPhotoCache();
  const key = photoCacheKey(REF, 400);
  await fetchPhotoOnce(REF, 400, key, REQ);
  assert.strictEqual(fakeDb.photos.size, 1);

  // Age the stored row past the window.
  fakeDb.photos.get(key).fetched_at = Date.now() - photoStore.PHOTO_CACHE_TTL_MS - 1;
  restart();

  const spendBefore = fakeDb.spendToday;
  const out = await fetchPhotoOnce(REF, 400, key, REQ);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(fakeDb.spendToday, spendBefore + 1,
    'an expired row was served instead of being re-bought');

  // Read-time expiry is not deletion. The pruner is what makes the window real.
  fakeDb.photos.get(key).fetched_at = Date.now() - photoStore.PHOTO_CACHE_TTL_MS - 1;
  await photoStore.prunePhotoStore();
  assert.strictEqual(fakeDb.photos.size, 0, 'content past its caching window was left on disk');
});

// ---------------------------------------------------------------------------
// 6. THE MONEY. One annual number, and hits that never touch it.
// ---------------------------------------------------------------------------

test('every photo limit is derived from one annual dollar figure', () => {
  const cm = require('../services/costModel');
  const sku = cm.RATES.places.skus.photos;

  // The arithmetic, checked rather than restated: the annual budget over twelve
  // months, divided by the per-1,000 price, plus the free monthly allowance.
  const paid = Math.floor(
    ((photoStore.PHOTO_BUDGET_USD_PER_YEAR / 12) / sku.perThousand) * 1000
  );
  assert.strictEqual(photoStore.PHOTO_PAID_FETCHES_PER_MONTH, paid);
  assert.strictEqual(photoStore.PHOTO_FREE_FETCHES_PER_MONTH, sku.freePerMonth);
  assert.strictEqual(
    photoStore.PHOTO_FETCH_BUDGET_MONTH,
    photoStore.PHOTO_FREE_FETCHES_PER_MONTH + photoStore.PHOTO_PAID_FETCHES_PER_MONTH
  );

  // The free tier is ACCOUNTED FOR, not assumed away: a month inside it is free.
  assert.strictEqual(
    cm.priceCallsAfterFree(sku.freePerMonth, sku.perThousand, sku.freePerMonth), 0
  );

  // And a full month at the ceiling costs no more than the budget allows.
  const atCeiling = cm.priceCallsAfterFree(
    photoStore.PHOTO_FETCH_BUDGET_MONTH, sku.perThousand, sku.freePerMonth, 0
  );
  assert.ok(atCeiling <= photoStore.PHOTO_BUDGET_USD_PER_MONTH + 0.01,
    `a maxed month costs $${atCeiling} against a monthly budget of `
    + `$${photoStore.PHOTO_BUDGET_USD_PER_MONTH}`);
  assert.ok(atCeiling * 12 <= photoStore.PHOTO_BUDGET_USD_PER_YEAR + 0.12,
    'twelve maxed months exceed the annual budget');

  // The daily figure is DERIVED, never typed twice. Three hardcoded numbers
  // that can drift apart is the exact shape of bug this repo keeps finding.
  assert.strictEqual(
    photoStore.PHOTO_FETCH_BURST_PER_DAY,
    Math.ceil(
      (photoStore.PHOTO_FETCH_BUDGET_MONTH / cm.DAYS_PER_MONTH)
      * photoStore.PHOTO_DAY_BURST_MULTIPLE
    )
  );
  // A daily brake at or above the month would be decorative, and one at or below
  // the even pace would throttle an ordinary day.
  assert.ok(photoStore.PHOTO_FETCH_BURST_PER_DAY < photoStore.PHOTO_FETCH_BUDGET_MONTH);
  assert.ok(
    photoStore.PHOTO_FETCH_BURST_PER_DAY
      > photoStore.PHOTO_FETCH_BUDGET_MONTH / cm.DAYS_PER_MONTH
  );
});

test('a cache hit never charges the budget, in either tier', async () => {
  resetFakeDb();
  clearPhotoCache();
  const key = photoCacheKey(REF, 400);

  await fetchPhotoOnce(REF, 400, key, REQ);
  assert.strictEqual(fakeDb.spendToday, 1);

  // L2 hit, which is the post-restart case.
  restart();
  await fetchPhotoOnce(REF, 400, key, REQ);
  assert.strictEqual(fakeDb.spendToday, 1, 'a durable cache hit charged the budget');

  // L1 hit, which is the ordinary case. fetchPhotoOnce is only reached on an L1
  // miss, so the route-level hit is pinned by the map holding the bytes rather
  // than by a charge that never happens.
  assert.ok(getPhotoCached(key), 'the memory tier did not hold the photo it just served');
});

test('past the ceiling, cached photos still serve and only a new venue comes up empty', async () => {
  resetFakeDb();
  clearPhotoCache();
  const knownKey = photoCacheKey(REF, 400);
  await fetchPhotoOnce(REF, 400, knownKey, REQ);

  // Spend the day.
  fakeDb.spendToday = photoStore.PHOTO_FETCH_BURST_PER_DAY;

  // A venue nobody has bought yet: refused, and honestly so.
  const NEW_REF = 'places/PLACE_NEVER_SEEN/photos/ZzZz';
  const denied = await fetchPhotoOnce(NEW_REF, 400, photoCacheKey(NEW_REF, 400), REQ);
  assert.strictEqual(denied.status, 429);

  // The venue already paid for: still served, ceiling or no ceiling. This is the
  // whole reason the gates sit BELOW the two cache tiers rather than above them.
  restart();
  const stillFine = await fetchPhotoOnce(REF, 400, knownKey, REQ);
  assert.strictEqual(stillFine.status, 200,
    'a spending ceiling blanked a photo that was already bought and cost nothing to serve');
});

test('the ledger is a real count in Postgres, not an integer a deploy can zero', async () => {
  resetFakeDb();
  const status = await photoStore.photoSpendStatus();
  assert.strictEqual(status.inMemory, false,
    'the photo budget must not claim to survive a restart if it lives in the heap');
  assert.strictEqual(status.limits.fetchesPerMonth, photoStore.PHOTO_FETCH_BUDGET_MONTH);
  assert.strictEqual(status.limits.budgetUsdPerYear, photoStore.PHOTO_BUDGET_USD_PER_YEAR);
  assert.strictEqual(status.monthBillable, 0, 'a month inside the free tier bills nothing');
  assert.strictEqual(status.monthUsd, 0);
});

test('the stored key is a hash, because a photo name may not be cached', () => {
  const key = photoCacheKey(REF, 400);
  assert.match(key, /^[0-9a-f]{64}$/, 'the cache key must be a sha256 hex digest');
  assert.ok(!key.includes('places'), 'the photo resource name leaked into the stored key');
  assert.ok(!key.includes('AbCdEf'), 'the photo token leaked into the stored key');
  // Width is part of the identity: two widths are two purchases.
  assert.notStrictEqual(photoCacheKey(REF, 400), photoCacheKey(REF, 160));
});
