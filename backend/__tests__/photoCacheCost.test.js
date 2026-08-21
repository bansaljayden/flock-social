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

test('the TTL is days, not an hour, and stays inside the 30-day Places caching allowance', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  assert.ok(PHOTO_CACHE_TTL >= DAY,
    'an hour-scale TTL re-buys immutable bytes around 24 times a day');
  // The Google Maps Platform terms permit temporarily caching Places content for
  // up to 30 days. A TTL past that is a terms problem, not a cost win.
  assert.ok(PHOTO_CACHE_TTL <= 30 * DAY, 'past 30 days this stops being permitted caching');
  assert.strictEqual(PHOTO_CACHE_TTL, 7 * DAY);
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
