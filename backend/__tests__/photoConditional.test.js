'use strict';
// ---------------------------------------------------------------------------
// A PHONE THAT ALREADY HOLDS A PHOTO IS ANSWERED WITHOUT LOOKING FOR IT.
// ---------------------------------------------------------------------------
// GET /api/venues/photo used to carry Express's body-hash ETag, so a
// revalidation could only be answered 304 after the route had found the body:
// an L1 read, or after every deploy an L2 read over the network to Postgres,
// or a paid Google fetch if L2 had let the row go. routes/venueSearch.js now
// tags a photo with its cache key and the time our copy was fetched, and a
// revalidation naming a copy from inside the 30-day window is answered before
// any tier is touched. These tests drive the real route over HTTP, with helmet
// mounted the way server.js mounts it, because the header a 304 carries is the
// part a unit test of the helper would miss.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');

// Read at module load by the route; without it every photo is a 500.
process.env.GOOGLE_PLACES_API_KEY = 'test-key-never-sent-anywhere';

const pool = require('../config/database');
const photoStore = require('../services/photoStore');

// The durable tier, modelled on migration 046: the route's L2 read and write
// and the spend ledger, counted so a test can say which of them ran.
const db = { photos: new Map(), reads: 0, writes: 0, charges: 0 };
pool.query = (text, params = []) => {
  const sql = String(text);
  if (/FROM places_photo_cache/i.test(sql) && !/DELETE/i.test(sql)) {
    db.reads++;
    const row = db.photos.get(params[0]);
    if (!row || Date.now() - row.fetched_at > photoStore.PHOTO_CACHE_TTL_MS) return Promise.resolve({ rows: [] });
    return Promise.resolve({
      rows: [{ content_type: 'image/jpeg', bytes: row.bytes, fetched_at: new Date(row.fetched_at) }],
    });
  }
  if (/INTO places_photo_cache/i.test(sql)) {
    db.writes++;
    db.photos.set(params[0], { bytes: params[2], fetched_at: Date.now() });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/INTO places_photo_spend/i.test(sql)) {
    db.charges++;
    return Promise.resolve({ rows: [{ fetches: db.charges }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// Google, counted. A test that expects no call asserts the count stayed put.
const PIXELS = Buffer.from('jpeg-bytes-standing-in-for-a-venue-photo');
let googleCalls = 0;
global.fetch = async (url) => {
  googleCalls++;
  if (String(url).includes('/media')) {
    return { ok: true, json: async () => ({ photoUri: 'https://cdn.example/photo.jpg' }) };
  }
  return {
    ok: true,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => PIXELS.buffer.slice(PIXELS.byteOffset, PIXELS.byteOffset + PIXELS.length),
  };
};

const venueSearch = require('../routes/venueSearch');
const { photoCacheKey, photoEtag, heldPhotoEtag, clearPhotoCache, resetPhotoBudget, PHOTO_CACHE_TTL } = venueSearch.__test;

const app = express();
app.use(helmet());
app.use('/api/venues', venueSearch);
let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(() => resolve())));

test.beforeEach(() => {
  clearPhotoCache();
  resetPhotoBudget();
  db.photos.clear();
  db.reads = 0; db.writes = 0; db.charges = 0;
  googleCalls = 0;
});

let n = 0;
const freshRef = () => `places/PLACE_COND/photos/Photo${++n}${'q'.repeat(40)}`;
const url = (ref, width = 400) => `${base}/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=${width}`;
const get = (ref, headers = {}, width = 400) => fetchNode(url(ref, width), headers);

// node:http rather than the global fetch, which this file replaced with the
// Google stand-in above.
function fetchNode(target, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(target, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

// What a deploy does to this route: L1 is gone, Postgres is not.
function deploy() { clearPhotoCache(); }

test('a photo is tagged with its cache key and the time our copy was fetched, and cached for the window', async () => {
  const ref = freshRef();
  const before = Date.now();
  const res = await get(ref);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, PIXELS);
  const key = photoCacheKey(ref, 400);
  const m = /^W\/"p1-([0-9a-f]{32})-([0-9a-z]+)"$/.exec(res.headers.etag);
  assert.ok(m, `unexpected ETag ${res.headers.etag}`);
  assert.equal(m[1], key.slice(0, 32));
  const fetchedAt = parseInt(m[2], 36) * 1000;
  assert.ok(fetchedAt >= Math.floor(before / 1000) * 1000 && fetchedAt <= Date.now());
  assert.equal(res.headers['cache-control'], `public, max-age=${PHOTO_CACHE_TTL / 1000}, immutable`);
  assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('a revalidation after a deploy is a 304 with no database read and no Google call', async () => {
  const ref = freshRef();
  const first = await get(ref);
  assert.equal(first.status, 200);
  deploy();
  const reads = db.reads;
  const calls = googleCalls;
  const charges = db.charges;

  const again = await get(ref, { 'if-none-match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(db.reads, reads, 'the revalidation read Postgres');
  assert.equal(googleCalls, calls, 'the revalidation called Google');
  assert.equal(db.charges, charges, 'the revalidation was charged');
  // The 304 refreshes the stored copy's headers, so it must repeat them. Helmet
  // is mounted here as in server.js: a 304 that let its same-origin CORP stand
  // would re-label a stored cross-origin photo as one the app may not embed.
  assert.equal(again.headers.etag, first.headers.etag);
  assert.equal(again.headers['cache-control'], first.headers['cache-control']);
  assert.equal(again.headers['cross-origin-resource-policy'], 'cross-origin');
});

test('the same copy carries the same tag from memory and from Postgres, so a deploy does not re-send it', async () => {
  const ref = freshRef();
  const key = photoCacheKey(ref, 400);
  const boughtAt = Date.now() - 3 * 24 * 3600 * 1000;
  db.photos.set(key, { bytes: PIXELS, fetched_at: boughtAt });

  const fromPostgres = await get(ref);
  const fromMemory = await get(ref);
  assert.equal(fromPostgres.status, 200);
  assert.equal(fromMemory.status, 200);
  assert.equal(fromPostgres.headers.etag, photoEtag(key, boughtAt));
  assert.equal(fromMemory.headers.etag, fromPostgres.headers.etag);
});

test('a copy from outside the 30-day window is looked at again, not waved through', async () => {
  const ref = freshRef();
  const key = photoCacheKey(ref, 400);
  const stale = photoEtag(key, Date.now() - PHOTO_CACHE_TTL - 60 * 1000);
  const res = await get(ref, { 'if-none-match': stale });
  assert.equal(res.status, 200, 'an out-of-window copy must be re-verified, which here means re-bought');
  assert.equal(googleCalls, 2, 'the normal path runs: metadata and bytes');
  assert.notEqual(res.headers.etag, stale);
});

test('a tag for another photo, another width, the future, or nothing we minted takes the normal path', async () => {
  const ref = freshRef();
  const key = photoCacheKey(ref, 400);
  const now = Date.now();
  for (const tag of [
    photoEtag(photoCacheKey(freshRef(), 400), now),          // another photo
    photoEtag(photoCacheKey(ref, 160), now),                 // the thumbnail's tag
    photoEtag(key, now + 3600 * 1000),                       // minted in the future
    'W/"20-abcdefabcdefabcdefabcdefabc"',                    // Express's old body hash
    `W/"p1-${key.slice(0, 32)}-zzzzzzzzzzzz"`,               // not a timestamp we mint
    'x'.repeat(5000),
  ]) {
    deploy();
    const res = await get(ref, { 'if-none-match': tag });
    assert.equal(res.status, 200, `${tag.slice(0, 60)} was answered ${res.status}`);
  }
});

test('one matching tag in a list is enough', async () => {
  const ref = freshRef();
  const first = await get(ref);
  deploy();
  const res = await get(ref, { 'if-none-match': `W/"something-else", ${first.headers.etag}` });
  assert.equal(res.status, 304);
});

test('the validator itself: quoted weak or strong, window-bound, key-bound', () => {
  const key = photoCacheKey('places/P/photos/X', 400);
  const now = Date.now();
  const tag = photoEtag(key, now - 1000);
  assert.equal(heldPhotoEtag(tag, key, now), tag);
  assert.equal(heldPhotoEtag(tag.slice(2), key, now), tag, 'a strong spelling of our tag still names our copy');
  assert.equal(heldPhotoEtag(tag, photoCacheKey('places/P/photos/X', 160), now), null);
  assert.equal(heldPhotoEtag(photoEtag(key, now - PHOTO_CACHE_TTL), key, now), null);
  assert.equal(heldPhotoEtag(undefined, key, now), null);
  assert.equal(heldPhotoEtag('', key, now), null);
});

test('a missing API key is still a 500 for a conditional request, as for any other', async () => {
  // Photos are turned off, not merely unfetchable, and the 304 must not be a
  // way around that answer.
  const ref = freshRef();
  const first = await get(ref);
  const saved = process.env.GOOGLE_PLACES_API_KEY;
  delete require.cache[require.resolve('../routes/venueSearch')];
  delete process.env.GOOGLE_PLACES_API_KEY;
  const keyless = require('../routes/venueSearch');
  process.env.GOOGLE_PLACES_API_KEY = saved;
  const offApp = express();
  offApp.use('/api/venues', keyless);
  const offServer = http.createServer(offApp);
  await new Promise((r) => offServer.listen(0, '127.0.0.1', r));
  try {
    const res = await fetchNode(
      `http://127.0.0.1:${offServer.address().port}/api/venues/photo?ref=${encodeURIComponent(ref)}&maxwidth=400`,
      { 'if-none-match': first.headers.etag }
    );
    assert.equal(res.status, 500);
  } finally {
    await new Promise((r) => offServer.close(r));
  }
});
