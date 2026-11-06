// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A PHOTO NAME GOOGLE HAS EXPIRED SHOWS THE SAME PLACE'S CURRENT PHOTO.
// ---------------------------------------------------------------------------
// Rows keep photo URLs for as long as the row lives (flocks.venue_photo_url
// above all), every URL carries a Google photo NAME, and Google expires names.
// On 2026-11-05 the proxy logged six of them, each answered
//
//   400 INVALID_ARGUMENT "The photo resource in the request is invalid.
//   Please retrieve it from Places API endpoints."
//
// every time the chat list drew those flocks' tiles, and every tile drew the
// placeholder bird. routes/venueSearch.js healDeadPhoto now answers such a name
// with the place's current first photo. What this file pins:
//
//   1. a dead name heals to the FIRST current photo, by way of one photos-only
//      Place Details request on the free SKU;
//   2. a second request makes no Google call at all;
//   3. a heal that cannot finish keeps the 404 the app draws as the bird;
//   4. the money: what is charged, to which ledger, and that a place is looked
//      up at most once a day;
//   5. no request ever waits on itself, however Google answers;
//   6. a healed answer is kept by a browser for a day, never pinned, and a name
//      Google lists is used only if it is shaped like one;
//   7. every map involved stays bounded, holds no photo name, and the
//      photos-only answer never reaches the cache the crowd model reads.
//
// Driven through the real route over HTTP against the real Places ledger.
// Google and Postgres are stood in for: nothing leaves the process, and the
// "photo" bytes are short strings made up here.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Captured at load by routes/venueSearch.js; the details cache reads it per call.
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key-never-sent';

// The Places ledger keys its counters on the UTC day and the money tests read
// them back, so the clock is pinned to the middle of one (helpers/pinnedClock.js).
const { pinClock } = require('./helpers/pinnedClock');
const pinnedClock = pinClock(Date.UTC(2026, 6, 15, 12, 0, 0));
test.after(() => pinnedClock.restore());

// --- Postgres: the photo cache and the photo spend ledger (migration 046) ----
// Honest enough that L2 hits, charges and refunds all happen for real.
const pool = require('../config/database');
const db = { photos: new Map(), charges: 0, refunds: 0, brake: Infinity };
pool.query = (text, params = []) => {
  const sql = String(text && text.text ? text.text : text);
  if (/DELETE FROM places_photo_cache/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/FROM places_photo_cache/i.test(sql)) {
    const row = db.photos.get(params[0]);
    if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{ content_type: row.contentType, bytes: row.bytes, fetched_at: new Date(row.at) }],
      rowCount: 1,
    });
  }
  if (/INTO places_photo_cache/i.test(sql)) {
    db.photos.set(params[0], { contentType: params[1], bytes: params[2], at: Date.now() });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  // The charge statement says both INTO and FROM places_photo_spend; INTO first.
  if (/INTO places_photo_spend/i.test(sql)) {
    if (db.charges >= db.brake) return Promise.resolve({ rows: [], rowCount: 0 });
    db.charges += 1;
    return Promise.resolve({ rows: [{ fetches: db.charges, day: '2026-07-15' }], rowCount: 1 });
  }
  if (/UPDATE places_photo_spend/i.test(sql)) {
    db.refunds += 1;
    return Promise.resolve({ rows: [{ fetches: 0 }], rowCount: 1 });
  }
  if (/FROM places_photo_spend/i.test(sql)) {
    return Promise.resolve({ rows: [{ month_used: db.charges, day_used: db.charges }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// --- Google ------------------------------------------------------------------
const V1 = 'https://places.googleapis.com/v1/';
const DETAILS = `${V1}places/`;
const CDN = 'https://cdn.example/';
const calls = []; // everything that reached "Google", in order
const expired = new Set(); // names the /media leg answers 400 INVALID_ARGUMENT
const failing = new Set(); // names the /media leg answers 503
const places = new Map(); // placeId -> { status, body } | { throws }
let holdDetails = null; // a promise every details answer waits on
const holdMedia = new Map(); // name -> a promise that name's /media answer waits on

const INVALID_NAME = JSON.stringify({
  error: {
    code: 400,
    message: 'The photo resource in the request is invalid. Please retrieve it from Places API endpoints.',
    status: 'INVALID_ARGUMENT',
  },
});
const NOT_FOUND = {
  status: 404,
  body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } },
};

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(V1) && u.includes('/media?')) {
    const name = u.slice(V1.length, u.indexOf('/media?'));
    calls.push({ kind: 'media', name });
    if (holdMedia.has(name)) await holdMedia.get(name);
    if (expired.has(name)) return { ok: false, status: 400, text: async () => INVALID_NAME };
    if (failing.has(name)) return { ok: false, status: 503, text: async () => 'unavailable' };
    return { ok: true, status: 200, json: async () => ({ photoUri: CDN + encodeURIComponent(name) }) };
  }
  if (u.startsWith(DETAILS)) {
    const placeId = decodeURIComponent(u.slice(DETAILS.length));
    calls.push({ kind: 'details', placeId, mask: opts.headers && opts.headers['X-Goog-FieldMask'] });
    if (holdDetails) await holdDetails;
    const answer = places.get(placeId) || NOT_FOUND;
    if (answer.throws) throw new Error(answer.throws);
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  }
  if (u.startsWith(CDN)) {
    const name = decodeURIComponent(u.slice(CDN.length));
    calls.push({ kind: 'cdn', name });
    const bytes = Buffer.from(`pixels of ${name}`);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }
  throw new Error(`a test reached for the network: ${u}`);
};
test.after(() => { global.fetch = realFetch; });

// A place whose current photos are `names`, as Places (New) answers a Place
// Details request.
function placeWithPhotos(placeId, names) {
  places.set(placeId, {
    status: 200,
    body: { id: placeId, photos: names.map((name) => ({ name, widthPx: 1200, heightPx: 800 })) },
  });
}

// --- the real route and the real ledger ---------------------------------------
const venueSearch = require('../routes/venueSearch');
const vs = venueSearch.__test;
const placeDetailsCache = require('../services/placeDetailsCache');
const photoStore = require('../services/photoStore');
const { placesBudgetStatus, allowGlobalPlacesCall, __resetPlacesBudget } = require('../utils/placesBudget');

const app = express();
app.use('/api/venues', venueSearch);
const server = http.createServer(app);
let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(() => resolve())));

// The proxy logs every refusal; the tests make a lot of them on purpose.
const realError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = realError; });

test.beforeEach(() => {
  vs.clearPhotoCache();
  vs.resetPhotoBudget();
  vs.deadPhotoRefs.clear();
  vs.healedPlaces.clear();
  placeDetailsCache.__test.reset();
  __resetPlacesBudget();
  db.photos.clear();
  db.charges = 0;
  db.refunds = 0;
  db.brake = Infinity;
  calls.length = 0;
  expired.clear();
  failing.clear();
  places.clear();
  holdDetails = null;
  holdMedia.clear();
});

function get(ref, width = 400, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=${width}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

// The same GET, for the requests that once never answered: it gives up after
// `ms` and reports HUNG, so a wedged flight fails the test instead of the run.
function getWithin(ref, width = 400, ms = 10000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const req = http.get(`${base}/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=${width}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    timer = setTimeout(() => { req.destroy(); resolve({ status: 'HUNG' }); }, ms);
  });
}

// Nothing a heal starts may outlive it: no flight left in photoInflight, no key
// left marked as healing.
function assertDrained() {
  assert.equal(vs.photoInflightSize(), 0, 'a photo flight was left behind');
  assert.equal(vs.healingKeysSize(), 0, 'a key was left marked as healing');
}

// The address the route sees for this test's requests, learned from the
// per-address table rather than assumed.
async function clientAddress() {
  const probe = 'places/ChIJaddressProbe1/photos/AU_live';
  assert.equal((await get(probe)).status, 200);
  const addresses = vs.photoIpAddresses();
  assert.equal(addresses.length, 1);
  vs.resetPhotoBudget();
  calls.length = 0;
  db.charges = 0;
  __resetPlacesBudget();
  return addresses[0];
}

const seen = () => calls.map((c) => (c.kind === 'details' ? `details ${c.placeId}` : `${c.kind} ${c.name}`));
const lookups = () => calls.filter((c) => c.kind === 'details').length;

// Exactly what a dead name answered before the heal, and still answers when
// the heal cannot finish: a 404 the browser keeps for an hour, which the app
// draws as the placeholder bird.
function assertBird(res, why) {
  assert.equal(res.status, 404, why);
  assert.equal(res.headers['cache-control'], 'public, max-age=3600', why);
  assert.match(res.text, /no longer available/, why);
}

// Generous on purpose: the full suite runs files in parallel, and nothing
// asserted after the wait depends on how long it took.
async function waitFor(condition, ms = 15000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for the requests to reach Google');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Made-up place and photo names in Google's shapes.
const P = 'ChIJhealTestPlace0001';
const OLD = `places/${P}/photos/AU_expired_name_kept_by_a_flock_row`;
const OLD_TOO = `places/${P}/photos/AU_another_expired_name_for_the_place`;
const FIRST = `places/${P}/photos/AU_current_first_photo`;
const SECOND = `places/${P}/photos/AU_current_second_photo`;

// =============================================================================
// 1. The heal
// =============================================================================

test('a dead name heals to the place\'s current first photo', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST, SECOND]);

  const res = await get(OLD);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`, 'the heal must serve the FIRST current photo');
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  assert.deepEqual(seen(), [
    `media ${OLD}`, // Google refuses the stored name
    `details ${P}`, // one photos-only lookup
    `media ${FIRST}`, // the current photo's metadata leg
    `cdn ${FIRST}`, // and its bytes
  ]);
  assert.equal(calls[1].mask, 'id,photos', 'the lookup must stay on Place Details Essentials IDs Only');
});

test('the lookup asks for the free SKU\'s fields and nothing else', () => {
  // Google's "Place Details Essentials IDs Only" field list, read 2026-11-05,
  // which the pricing page lists at unlimited free usage. Any other field
  // bills the lookup at Pro ($17 per 1,000) or Enterprise ($20).
  const IDS_ONLY = ['attributions', 'consumerAlert', 'id', 'movedPlace', 'movedPlaceId', 'name', 'photos'];
  const fields = placeDetailsCache.PLACE_PHOTOS_FIELD_MASK.split(',');
  assert.deepEqual(fields, ['id', 'photos']);
  for (const field of fields) {
    assert.ok(IDS_ONLY.includes(field), `${field} would make the heal's lookup a paid call`);
  }
});

test('a second request makes no Google call: not for that name, not at the other width', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  assert.equal((await get(OLD)).status, 200);

  calls.length = 0;
  const again = await get(OLD);
  assert.equal(again.status, 200);
  assert.equal(again.text, `pixels of ${FIRST}`);
  // The pin size is served from the 400 already bought: a second width would
  // be a second purchase.
  const thumb = await get(OLD, 160);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.text, `pixels of ${FIRST}`);
  assert.deepEqual(seen(), [], 'a healed name went back to Google');
});

test('another dead name of a healed place costs only the ask that finds it dead', async () => {
  // Two flocks planned at one venue months apart keep two different names.
  expired.add(OLD);
  expired.add(OLD_TOO);
  placeWithPhotos(P, [FIRST]);
  assert.equal((await get(OLD)).status, 200);

  calls.length = 0;
  const other = await get(OLD_TOO);
  assert.equal(other.status, 200);
  assert.equal(other.text, `pixels of ${FIRST}`);
  assert.deepEqual(seen(), [`media ${OLD_TOO}`], 'the place was looked up again, or its photo bought again');
});

test('a place whose venue card is cached heals with no lookup at all', async () => {
  // A signed-in card opened the venue a minute ago, so the full payload,
  // photos included, is in the shared details cache.
  places.set(P, {
    status: 200,
    body: {
      id: P,
      displayName: { text: 'The Venue' },
      rating: 4.5,
      userRatingCount: 310,
      priceLevel: 'PRICE_LEVEL_MODERATE',
      photos: [{ name: FIRST }],
    },
  });
  assert.equal((await placeDetailsCache.fetchPlaceDetails(P)).ok, true);
  calls.length = 0;

  expired.add(OLD);
  const res = await get(OLD);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`);
  assert.deepEqual(seen(), [`media ${OLD}`, `media ${FIRST}`, `cdn ${FIRST}`], 'a cached place was looked up again');
  assert.equal(placesBudgetStatus(null).unauthUsed, 2, 'only the two photo metadata calls were charged');

  // And the card's payload is untouched: still the full answer, model inputs and all.
  const card = await placeDetailsCache.fetchPlaceDetails(P);
  assert.equal(card.place.rating, 4.5);
  assert.equal(card.place.userRatingCount, 310);
});

test('concurrent requests for a place\'s dead names share one lookup and one purchase', async () => {
  expired.add(OLD);
  expired.add(OLD_TOO);
  placeWithPhotos(P, [FIRST]);
  let release;
  holdDetails = new Promise((r) => { release = r; });

  const pending = Promise.all([get(OLD), get(OLD_TOO), get(OLD)]);
  await waitFor(() => lookups() === 1 && calls.filter((c) => c.kind === 'media').length === 2);
  await new Promise((r) => setTimeout(r, 50));
  release();
  holdDetails = null;

  for (const res of await pending) {
    assert.equal(res.status, 200);
    assert.equal(res.text, `pixels of ${FIRST}`);
  }
  assert.equal(lookups(), 1, 'one place, one lookup');
  assert.equal(calls.filter((c) => c.kind === 'media' && c.name === FIRST).length, 1, 'one purchase of the current photo');
  assert.equal(db.charges, 3, 'two refused names and one current photo');
});

test('the demo\'s photo warm never heals: it only holds names a search just returned', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  const out = await venueSearch.warmPhoto(OLD, 400, { ip: '203.0.113.7' });
  assert.equal(out.status, 404);
  assert.deepEqual(seen(), [`media ${OLD}`]);
});

// =============================================================================
// 2. A heal that cannot finish answers what a dead name always answered
// =============================================================================

test('a place with no photos keeps the 404', async () => {
  expired.add(OLD);
  placeWithPhotos(P, []);
  assertBird(await get(OLD));
  assert.deepEqual(seen(), [`media ${OLD}`, `details ${P}`]);
});

test('a place Google no longer lists keeps the 404', async () => {
  expired.add(OLD);
  assertBird(await get(OLD));
  assert.deepEqual(seen(), [`media ${OLD}`, `details ${P}`]);
});

test('a lookup that fails keeps the 404, whether Google errs or never answers', async () => {
  expired.add(OLD);
  places.set(P, { status: 503, body: { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } } });
  assertBird(await get(OLD), 'a 503 on the lookup');

  const Q = 'ChIJhealTestPlace0002';
  const qOld = `places/${Q}/photos/AU_expired`;
  expired.add(qOld);
  places.set(Q, { throws: 'The operation was aborted due to timeout' });
  assertBird(await get(qOld), 'a lookup that never came back');
});

test('a current photo Google will not serve keeps the 404, and nothing loops', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  failing.add(FIRST);
  assertBird(await get(OLD), 'the current photo\'s own metadata call failed');
  assert.deepEqual(seen(), [`media ${OLD}`, `details ${P}`, `media ${FIRST}`]);

  // A place whose only current photo is the refused name itself: nothing to
  // heal to, and no second ask for the same refused name.
  const Q = 'ChIJhealTestPlace0003';
  const qOld = `places/${Q}/photos/AU_expired`;
  expired.add(qOld);
  placeWithPhotos(Q, [qOld]);
  calls.length = 0;
  assertBird(await get(qOld));
  assert.deepEqual(seen(), [`media ${qOld}`, `details ${Q}`]);
});

test('a name whose place segment is not a place id is never looked up', async () => {
  const odd = 'places/ab/photos/AU_expired';
  expired.add(odd);
  assertBird(await get(odd));
  assert.deepEqual(seen(), [`media ${odd}`]);
});

// =============================================================================
// 3. The money
// =============================================================================

test('a heal is three units on the unauthenticated share, two photo charges, and a repeat moves nothing', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  assert.equal((await get(OLD)).status, 200);

  let s = placesBudgetStatus(null);
  assert.equal(s.unauthUsed, 3, 'the refused name, the lookup and the current photo: one unit each');
  assert.equal(s.globalUsed, 3);
  assert.equal(s.photoUsed, 3,
    'all three are the photo proxy\'s units, so the cost panel never prices the $0 lookup as Enterprise Place Details');
  assert.equal(db.charges, 2, 'the photo budget pays for the two photo metadata calls and nothing for the free lookup');
  assert.equal(db.refunds, 0);

  await get(OLD);
  await get(OLD, 160);
  s = placesBudgetStatus(null);
  assert.equal(s.unauthUsed, 3, 'a healed repeat was charged to the ledger');
  assert.equal(db.charges, 2, 'a healed repeat was charged to the photo budget');
});

test('after a deploy the current photo comes out of Postgres instead of being bought again', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  assert.equal((await get(OLD)).status, 200);

  // A deploy empties memory and leaves Postgres alone.
  vs.clearPhotoCache();
  vs.deadPhotoRefs.clear();
  vs.healedPlaces.clear();
  placeDetailsCache.__test.reset();
  calls.length = 0;

  const res = await get(OLD);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`);
  // The refused name is asked about once more, as it was before the heal
  // existed, and the place is looked up once more; the photo is not re-bought.
  assert.deepEqual(seen(), [`media ${OLD}`, `details ${P}`]);
  assert.equal(db.charges, 3);
});

test('a place is looked up at most once a day, even when the lookup found nothing', async () => {
  expired.add(OLD);
  expired.add(OLD_TOO);
  placeWithPhotos(P, []);
  assertBird(await get(OLD));
  assertBird(await get(OLD));
  assertBird(await get(OLD_TOO));
  assert.equal(lookups(), 1, 'a second lookup inside the day');

  // A failed lookup counts too: it reached Google.
  const Q = 'ChIJhealTestPlace0004';
  const qOld = `places/${Q}/photos/AU_expired`;
  expired.add(qOld);
  places.set(Q, { throws: 'socket hang up' });
  assertBird(await get(qOld));
  assertBird(await get(qOld));
  assert.equal(lookups(), 2);

  // A day later the place gets one more look, and this time it has a photo.
  placeWithPhotos(P, [FIRST]);
  const entry = vs.healedPlaces.get(P);
  assert.ok(entry.until - Date.now() > vs.HEALED_PLACE_TTL_MS - 60 * 1000, 'the place was held for less than a day');
  entry.until = Date.now() - 1;
  const later = await get(OLD);
  assert.equal(later.status, 200);
  assert.equal(later.text, `pixels of ${FIRST}`);
  assert.equal(lookups(), 3);
});

test('a lookup the shared ledger refuses is never sent, and does not use up the place\'s day', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  // Leave the unauthenticated share exactly one unit: the ask that learns the
  // name is dead takes it.
  while (placesBudgetStatus(null).unauthRemaining > 1) allowGlobalPlacesCall(1);

  assertBird(await get(OLD));
  assert.deepEqual(seen(), [`media ${OLD}`], 'a refused lookup still reached Google');
  assert.equal(vs.healedPlaces.has(P), false, 'a lookup that never happened used up the place\'s day');

  // Tomorrow's ledger: the next request heals.
  __resetPlacesBudget();
  const res = await get(OLD);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`);
});

test('when the photo budget will not buy the current photo, the answer is still the 404', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  db.brake = 1; // room for the one ask that learns the name is dead
  assertBird(await get(OLD));
  assert.deepEqual(seen(), [`media ${OLD}`, `details ${P}`], 'the current photo was bought past the budget');
  assert.equal(db.charges, 1);
  // A refused purchase holds the place for an hour, not the day.
  assert.ok(vs.healedPlaces.get(P).until - Date.now() <= vs.HEAL_RETRY_TTL_MS);
});

test('a heal spends one per-address unit per Google call it makes, and a repeat spends none', async () => {
  const ip = await clientAddress();
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  assert.equal((await get(OLD)).status, 200);
  assert.equal(vs.photoIpHitCount(ip), 3, 'the refused name, the lookup and the purchase: one unit each');

  await get(OLD);
  await get(OLD, 160);
  assert.equal(vs.photoIpHitCount(ip), 3, 'a healed repeat spent a per-address unit');
});

test('a lookup the per-address gate refuses is never sent, and does not use up the place\'s day', async () => {
  const ip = await clientAddress();
  // One miss left this hour, and the ask that learns OLD is dead takes it.
  for (let i = 0; i < vs.PHOTO_MISS_PER_IP_HOURLY - 1; i++) vs.allowPhotoFetch({ ip });
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);

  assertBird(await get(OLD));
  assert.deepEqual(seen(), [`media ${OLD}`], 'a lookup went out past the address\'s hourly gate');
  assert.equal(vs.healedPlaces.has(P), false, 'a lookup that never happened used up the place\'s day');

  // The next hour (a cleared table stands in for it): the heal goes through.
  vs.resetPhotoBudget();
  const res = await get(OLD);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`);
});

test('a purchase one address\'s gate refuses holds the place for an hour, not a day', async () => {
  const ip = await clientAddress();
  // Two misses left: the ask that finds OLD dead and the lookup. The purchase
  // of the current photo is the one refused.
  for (let i = 0; i < vs.PHOTO_MISS_PER_IP_HOURLY - 2; i++) vs.allowPhotoFetch({ ip });
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);

  assertBird(await get(OLD));
  assert.deepEqual(seen(), [`media ${OLD}`, `details ${P}`], 'the purchase went out past the address\'s hourly gate');
  const entry = vs.healedPlaces.get(P);
  assert.equal(entry.keys[400], vs.photoCacheKey(FIRST, 400));
  assert.ok(entry.until - Date.now() <= vs.HEAL_RETRY_TTL_MS,
    'one address\'s refusal held the place for every address for longer than an hour');

  // Another address inside that hour still gets the bird, and costs no Google call.
  vs.resetPhotoBudget();
  calls.length = 0;
  assertBird(await get(OLD));
  assert.deepEqual(seen(), []);

  // After the hour, any address heals it.
  entry.until = Date.now() - 1;
  const res = await get(OLD);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`);
  assert.deepEqual(seen(), [`details ${P}`, `media ${FIRST}`, `cdn ${FIRST}`]);
});

test('a card and a pin healing one dead name at the same moment buy the current photo once', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  let release;
  holdDetails = new Promise((r) => { release = r; });

  const pending = Promise.all([get(OLD, 400), get(OLD, 160)]);
  await waitFor(() => lookups() === 1);
  await new Promise((r) => setTimeout(r, 50));
  release();
  holdDetails = null;

  for (const res of await pending) {
    assert.equal(res.status, 200);
    assert.equal(res.text, `pixels of ${FIRST}`);
  }
  assert.equal(lookups(), 1);
  assert.equal(calls.filter((c) => c.kind === 'media' && c.name === FIRST).length, 1, 'two widths bought the photo twice');
  assertDrained();
});

// =============================================================================
// 4. No request ever waits on itself
// =============================================================================
// A heal runs inside the flight of the name it heals. Before the guard, a heal
// whose remembered or chosen photo was that same name, refused later, waited on
// its own flight: the request never answered and the flight never left
// photoInflight, so every later request for that photo at that width joined it.

test('a Google blip while a venue sheet is open: the sheet\'s second photo answers', async () => {
  // The sheet's payload lists two photos, and Google refuses both for a moment.
  placeWithPhotos(P, [FIRST, SECOND]);
  assert.equal((await placeDetailsCache.fetchPlaceDetails(P)).ok, true);
  expired.add(FIRST);
  expired.add(SECOND);

  assertBird(await getWithin(FIRST), 'the first photo heals to the second, which is refused too');
  assertBird(await getWithin(SECOND), 'the second photo\'s own flight is the one healing');
  assertDrained();

  // Google recovers, and once the day's memories are gone both photos load.
  expired.clear();
  vs.deadPhotoRefs.clear();
  vs.healedPlaces.clear();
  assert.equal((await getWithin(SECOND)).status, 200);
  assert.equal((await getWithin(FIRST)).status, 200);
  assertDrained();
});

test('a photo a dead name healed to, refused later the same day: its own thumbnail answers', async () => {
  placeWithPhotos(P, [FIRST]);
  assert.equal((await placeDetailsCache.fetchPlaceDetails(P)).ok, true);
  expired.add(OLD);
  const healed = await getWithin(OLD);
  assert.equal(healed.status, 200);
  assert.equal(healed.text, `pixels of ${FIRST}`);

  // Later that day Google expires FIRST, and a pin asks for it.
  expired.add(FIRST);
  assertBird(await getWithin(FIRST, 160));
  assert.equal(vs.healedPlaces.get(P).keys, null, 'the refused photo is still what the place heals to');
  // And the healed tile's own thumbnail answers rather than riding a wedged flight.
  assertBird(await getWithin(OLD, 160));
  assertDrained();
});

test('a photo the heal chose and Google refused: the next request for it answers', async () => {
  expired.add(OLD);
  expired.add(FIRST);
  placeWithPhotos(P, [FIRST]);
  assertBird(await getWithin(OLD));
  assert.equal(vs.healedPlaces.get(P).keys, null, 'the refused pick is still what the place heals to');

  assertBird(await getWithin(FIRST));
  assertDrained();

  // Once Google takes FIRST again and the day's memory of it has gone, it serves.
  expired.delete(FIRST);
  vs.deadPhotoRefs.clear();
  const later = await getWithin(FIRST);
  assert.equal(later.status, 200);
  assert.equal(later.text, `pixels of ${FIRST}`);
  assertDrained();
});

test('a heal tries one photo per request: when Google refuses its choice, the next request takes the next', async () => {
  // The card's payload lists two photos; Google has expired the stored name
  // and the first current one.
  placeWithPhotos(P, [FIRST, SECOND]);
  assert.equal((await placeDetailsCache.fetchPlaceDetails(P)).ok, true);
  calls.length = 0;
  expired.add(OLD);
  expired.add(FIRST);

  assertBird(await getWithin(OLD));
  assert.deepEqual(seen(), [`media ${OLD}`, `media ${FIRST}`], 'one try per request, and never a heal of the heal');
  assert.equal(vs.healedPlaces.get(P).keys, null);

  calls.length = 0;
  const next = await getWithin(OLD);
  assert.equal(next.status, 200);
  assert.equal(next.text, `pixels of ${SECOND}`);
  assert.deepEqual(seen(), [`media ${SECOND}`, `cdn ${SECOND}`]);
  assertDrained();
});

test('the guard: two heals can never wait on each other', async () => {
  // Two refused names of one place, and nothing current to heal either to, so
  // both requests must end on the bird. N's metadata answer is held, so its
  // flight sits in the metadata phase while X's heal starts.
  const X = `places/${P}/photos/AU_refused_x`;
  const N = `places/${P}/photos/AU_refused_n`;
  const keysOf = (name) => ({ 160: vs.photoCacheKey(name, 160), 400: vs.photoCacheKey(name, 400) });
  expired.add(X);
  expired.add(N);
  placeWithPhotos(P, []);
  let releaseN;
  holdMedia.set(N, new Promise((r) => { releaseN = r; }));

  const nRequest = getWithin(N);
  await waitFor(() => calls.some((c) => c.kind === 'media' && c.name === N));

  // The place's entry names N: X's heal waits on N's flight, which is not
  // healing yet, so that wait is allowed.
  vs.rememberHealedPlace(P, keysOf(N));
  const xRequest = getWithin(X);
  await waitFor(() => vs.healingKeysSize() === 1);

  // The entry then names X, and N's answer comes back refused: N's heal finds
  // X's flight healing and does not wait on it. Without the guard the two wait
  // on each other and neither request ever answers.
  vs.rememberHealedPlace(P, keysOf(X));
  releaseN();
  const [n, x] = await Promise.all([nRequest, xRequest]);
  assertBird(n);
  assertBird(x);
  assertDrained();
});

test('the guard holds even when the dead-name memory lets go in the middle of two heals', async () => {
  // A heal never picks a name it knows is dead, and a healing flight's name is
  // always known dead, so a purchase should never meet a healing flight. The
  // guard does not rely on that: here the memory is emptied while two heals of
  // one place wait on one lookup, so each picks the other's name. Without the
  // guard each would wait on the other's flight, forever.
  const X = `places/${P}/photos/AU_refused_x`;
  const N = `places/${P}/photos/AU_refused_n`;
  expired.add(X);
  expired.add(N);
  placeWithPhotos(P, [X, N]);
  let release;
  holdDetails = new Promise((r) => { release = r; });

  const pending = Promise.all([getWithin(X), getWithin(N)]);
  await waitFor(() => lookups() === 1 && vs.healingKeysSize() === 2);
  vs.deadPhotoRefs.clear();
  release();
  holdDetails = null;

  const [x, n] = await pending;
  assertBird(x);
  assertBird(n);
  assertDrained();
});

// =============================================================================
// 5. What a healed answer tells the browser, and what the heal will use
// =============================================================================

test('a healed answer is kept for a day, never pinned as immutable, and still revalidates', async () => {
  // Google refuses a live photo once (a blip, or a 400 misread as a dead name),
  // and the URL is answered with the place's other photo.
  placeWithPhotos(P, [FIRST, SECOND]);
  expired.add(SECOND);
  const res = await get(SECOND);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`);
  assert.equal(res.headers['cache-control'], `public, max-age=${24 * 60 * 60}`);
  assert.equal(vs.HEALED_PHOTO_MAX_AGE_S, vs.HEALED_PLACE_TTL_MS / 1000);
  assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.ok(res.headers.etag, 'a healed answer still carries a validator');
  assert.doesNotMatch(res.headers.etag, /p1-/,
    'heldPhotoEtag confirms a p1 validator for 30 days without looking, which would pin the healed photo again');

  // A day later the browser asks again with that validator: the heal runs, and
  // the same bytes come back as a 304.
  const again = await get(SECOND, 400, { 'If-None-Match': res.headers.etag });
  assert.equal(again.status, 304);

  // A photo served under its own name keeps its 30 immutable days.
  const own = await get(FIRST);
  assert.equal(own.status, 200);
  assert.match(own.headers['cache-control'], /max-age=2592000, immutable/);
});

test('a name Google lists is used only if it is shaped like a photo name', async () => {
  const BS = String.fromCharCode(92);
  expired.add(OLD);
  placeWithPhotos(P, [
    `places/${P}/photos/a${BS}..${BS}..${BS}x`, // the URL parser reads \ as /
    `places/${P}/photos/%2e%2e`, // and %2e%2e as ..
    `places/${P}/photos/x?key=leak`,
    '',
    FIRST,
  ]);
  const res = await get(OLD);
  assert.equal(res.status, 200);
  assert.equal(res.text, `pixels of ${FIRST}`);
  assert.deepEqual(seen(), [`media ${OLD}`, `details ${P}`, `media ${FIRST}`, `cdn ${FIRST}`],
    'a malformed name from Google was put into a request');
});

// =============================================================================
// 6. Bounded, and no photo names kept
// =============================================================================

test('healedPlaces is bounded, oldest out first, and a refreshed place moves to the back', () => {
  const MAX = vs.MAX_HEALED_PLACES;
  const id = (i) => `ChIJbound${String(i).padStart(8, '0')}`;
  for (let i = 0; i < MAX; i++) vs.rememberHealedPlace(id(i), null);
  vs.rememberHealedPlace(id(0), null);
  for (let i = MAX; i < MAX + 50; i++) vs.rememberHealedPlace(id(i), null);

  assert.equal(vs.healedPlaces.size, MAX);
  assert.ok(vs.healedPlaces.has(id(0)), 'a refreshed entry was evicted as if it were the oldest');
  assert.ok(!vs.healedPlaces.has(id(1)) && !vs.healedPlaces.has(id(50)), 'the oldest entries go first');
  assert.ok(vs.healedPlaces.has(id(51)));

  // Every entry follows a name the photo budget paid to learn was dead, so a
  // day writes at most the budget's daily brake; the ceiling sits above two
  // days of that, the most a 24-hour TTL can hold.
  assert.ok(MAX > 2 * photoStore.PHOTO_FETCH_BURST_PER_DAY);
  assert.equal(vs.HEALED_PLACE_TTL_MS, 24 * 60 * 60 * 1000);
});

test('the dead-name memory keeps its own ceiling', () => {
  for (let i = 0; i < vs.MAX_DEAD_PHOTO_REFS + 20; i++) {
    vs.rememberDeadPhotoRef(`places/ChIJboundPlace/photos/AU_${i}`);
  }
  assert.equal(vs.deadPhotoRefs.size, vs.MAX_DEAD_PHOTO_REFS);
});

test('what the heal keeps is hashes and a place id, and its flights drain', async () => {
  expired.add(OLD);
  placeWithPhotos(P, [FIRST]);
  assert.equal((await get(OLD)).status, 200);

  const entry = vs.healedPlaces.get(P);
  assert.match(entry.keys[400], /^[0-9a-f]{64}$/);
  assert.match(entry.keys[160], /^[0-9a-f]{64}$/);
  assert.equal(entry.keys[400], vs.photoCacheKey(FIRST, 400));
  assert.ok(!JSON.stringify([...vs.healedPlaces]).includes('/photos/'), 'a photo name was kept in memory');
  assert.ok(![...vs.deadPhotoRefs.keys()].some((k) => k.includes('/photos/')));

  assert.equal(placeDetailsCache.__test.photosInflightSize(), 0, 'the lookup flight did not drain');
  assertDrained();
  // The photos-only answer has no rating, review count or price, so it must
  // never be written where the crowd model reads venues from.
  assert.equal(placeDetailsCache.__test.size(), 0, 'a photos-only answer reached the shared details cache');
  assert.equal(placeDetailsCache.isGonePlace(P), false);
});

test('a failed lookup drains too, and is not written anywhere a card would read it', async () => {
  expired.add(OLD);
  assertBird(await get(OLD)); // NOT_FOUND
  assert.equal(placeDetailsCache.__test.photosInflightSize(), 0);
  assert.equal(placeDetailsCache.__test.size(), 0);
  assert.equal(placeDetailsCache.__test.goneSize(), 0,
    'the heal wrote gonePlaceIds, whose bound argues only the signed-in writers');
});
