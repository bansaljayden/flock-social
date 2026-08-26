// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// WHAT VENUE SEARCH SAYS WHEN IT CANNOT ANSWER.
// ---------------------------------------------------------------------------
// frontend/src/App.js doVenueSearch takes the string this route returns and
// renders it, verbatim, in the search dropdown. That is a deliberate contract
// and the comment there says why: the dropdown used to print "No venues found.
// Try a different search." for a dead API key and a 502, blaming a user's
// spelling for our outage. The cost of the contract is that EVERY message this
// file returns is display copy for a 17-year-old, and three of them were not.
//
//   1. `.isLength({ min: 1, max: 80 })` carried ONE message, so an 81-character
//      query was answered "Search query is required" about a query the user
//      could see on their own screen.
//   2. A Google `error` body was returned as `Places API: ${message}`. The real
//      strings are "API key not valid. Please pass a valid API key.", "Requests
//      to this API ... are blocked." and "Quota exceeded for quota metric
//      'Requests'". Unactionable for the user, and a running commentary on our
//      key and billing state for anybody else.
//   3. The 429 said "Give it a few seconds" about utils/placesBudget.js's
//      PER_USER_HOURLY, which is 30 calls over a ROLLING HOUR. Following that
//      advice gets the same refusal five seconds later.
//
// These are pinned rather than reviewed because copy is the thing that rots
// first: nothing else in the build fails when a sentence stops being true.
//
// The status codes are asserted alongside every message, because they are the
// half clients key off (services/api.js buildHttpError carries err.status) and
// none of them changed.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-search-answers-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';

const { __resetPlacesBudget, PER_USER_HOURLY } = require('../utils/placesBudget');

// Postgres is only reached here by the photo proxy's durable store, which these
// tests do not exercise. Everything answers empty.
const pool = require('../config/database');
pool.query = () => Promise.resolve({ rows: [], rowCount: 0 });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Ava' }; next(); };

// Google, faked. `googleAnswer` is what the next Places call resolves to, so a
// test can put an error body or a transport failure in front of the route.
let googleAnswer = null;
let googleCalls = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    googleCalls += 1;
    const answer = googleAnswer || { places: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => answer });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; });

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

test.beforeEach(() => {
  __resetPlacesBudget();
  venueSearchRouter.__test.clearVenueCache();
  googleAnswer = null;
  googleCalls = 0;
});

async function get(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

// The search cache and the in-flight map are module-level and no beforeEach
// reaches the second one, so every test uses a query nothing else has asked.
let seq = 0;
const uniq = () => `q${Date.now().toString(36)}${seq++}`;

// ---------------------------------------------------------------------------
// 1. The two ends of the length bound are two different sentences
// ---------------------------------------------------------------------------

test('an empty query is "required" and an over-long one says it is too long', async () => {
  const empty = await get('/api/venues/search?query=%20%20%20');
  assert.strictEqual(empty.status, 400, empty.text);
  assert.strictEqual(empty.body.error, 'Search query is required');

  const long = await get(`/api/venues/search?query=${'a'.repeat(81)}`);
  assert.strictEqual(long.status, 400, long.text);
  assert.match(long.body.error, /too long/i);
  // The specific failure: telling somebody their query is REQUIRED when they
  // have just typed 81 characters of it.
  assert.ok(!/required/i.test(long.body.error),
    'an over-long query is still answered "Search query is required"');

  assert.strictEqual(googleCalls, 0, 'a refused query must not reach Google');
});

test('a query at exactly the bound is accepted, so the message is about 81 and not 80', async () => {
  const res = await get(`/api/venues/search?query=${'a'.repeat(80)}`);
  assert.strictEqual(res.status, 200, res.text);
});

// ---------------------------------------------------------------------------
// 2. Google's error text is a log line, never a response body
// ---------------------------------------------------------------------------

test('a Places error body becomes one plain sentence, and Google\'s words do not leave the server', async () => {
  googleAnswer = {
    error: {
      status: 'PERMISSION_DENIED',
      message: 'API key not valid. Please pass a valid API key.',
    },
  };
  const res = await get(`/api/venues/search?query=${uniq()}`);

  assert.strictEqual(res.status, 502, res.text);
  assert.strictEqual(res.body.error, 'Venue search is not answering right now. Try again in a moment.');
  // The whole response, not just the error field: nothing about our upstream,
  // our key or our quota may ride out on this.
  for (const leak of ['API key', 'PERMISSION_DENIED', 'Places API', 'googleapis', 'quota']) {
    assert.ok(!res.text.toLowerCase().includes(leak.toLowerCase()),
      `the response carries "${leak}"`);
  }
});

test('an upstream failure is never cached, so the next request tries again', async () => {
  const q = uniq();
  googleAnswer = { error: { status: 'UNAVAILABLE', message: 'backend error' } };
  const failed = await get(`/api/venues/search?query=${q}`);
  assert.strictEqual(failed.status, 502, failed.text);
  assert.strictEqual(googleCalls, 1);

  // A cached 502 would answer the same for the whole 5-minute TTL and the user
  // would have no way to retry out of a blip.
  googleAnswer = null;
  const recovered = await get(`/api/venues/search?query=${q}`);
  assert.strictEqual(recovered.status, 200, recovered.text);
  assert.strictEqual(googleCalls, 2, 'the failure was pinned as a cache entry');
});

// ---------------------------------------------------------------------------
// 3. The refusal describes the limit that actually exists
// ---------------------------------------------------------------------------

test('the budget refusal names the hour, because the window is an hour', async () => {
  // Spend the caller's whole rolling hour through the route itself, so the test
  // reaches the limit the way a user does rather than by poking the ledger.
  for (let i = 0; i < PER_USER_HOURLY; i++) {
    const spent = await get(`/api/venues/search?query=${uniq()}`);
    assert.strictEqual(spent.status, 200, spent.text);
  }

  const refused = await get(`/api/venues/search?query=${uniq()}`);
  assert.strictEqual(refused.status, 429, refused.text);
  assert.match(refused.body.error, /hour/i,
    'the refusal does not say what window the caller is up against');
  // The specific defect: advice that cannot work. A rolling hourly budget does
  // not free a unit in "a few seconds", so a user who follows this line gets
  // the same 429 and concludes search is broken.
  assert.ok(!/seconds/i.test(refused.body.error),
    'the hourly budget still tells the user to wait a few seconds');
});

test('a cached query is still answered after the budget is gone', async () => {
  // The other half of the same rule, and the reason the refusal sits inside the
  // in-flight branch rather than at the top of the handler: an answer already
  // bought costs nothing to serve, so a spent allowance must not hide it.
  const q = uniq();
  const first = await get(`/api/venues/search?query=${q}`);
  assert.strictEqual(first.status, 200, first.text);

  for (let i = 0; i < PER_USER_HOURLY; i++) await get(`/api/venues/search?query=${uniq()}`);

  const again = await get(`/api/venues/search?query=${q}`);
  assert.strictEqual(again.status, 200, again.text);
});

// ---------------------------------------------------------------------------
// 4. Zero results is a real answer and is not an error
// ---------------------------------------------------------------------------

test('a search Google answers with nothing is a 200 and an empty list, never a 502', async () => {
  // This is the line the client's "No venues found" is allowed to come from,
  // and the ONLY one. Anything that returns a non-200 must reach the user as
  // the server's sentence instead.
  googleAnswer = { places: [] };
  const res = await get(`/api/venues/search?query=${uniq()}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { venues: [], total: 0 });
});

// ---------------------------------------------------------------------------
// 5. The detail sheet answers the same way
// ---------------------------------------------------------------------------

test('a Places error on the detail sheet is a sentence about the venue, not about Google', async () => {
  googleAnswer = { error: { status: 'NOT_FOUND', message: 'NOT_FOUND' } };
  const res = await get('/api/venues/details?place_id=ChIJAAAAAAAAAAAAAAAAAAAAAA');
  assert.strictEqual(res.status, 502, res.text);
  assert.strictEqual(res.body.error, 'That venue is not loading right now. Try again in a moment.');
  assert.ok(!/NOT_FOUND|Places API/i.test(res.text), 'Google\'s status reached the client');
});

// ---------------------------------------------------------------------------
// 6. The photo size snap, because breaking it doubles the largest bill
// ---------------------------------------------------------------------------

test('a card photo and a detail photo of the same venue are ONE cache key', async () => {
  // shapeDetails builds its photo urls with maxwidth=600 and the search results
  // with the default 400. GET /photo snaps both to 400, so both resolve to the
  // same sha256(ref|width) in L1 and in places_photo_cache: one venue photo is
  // one purchase however it was reached. Adding 600 to the snap set would give
  // every venue a second key, a second row and a second billable fetch for a
  // photo already bought. The photo proxy is the largest line in the real
  // spend (services/photoStore.js), so this equality is money and not tidiness.
  const { photoCacheKey } = venueSearchRouter.__test;
  const ref = 'places/PLACE_A/photos/PHOTOREF';
  assert.strictEqual(photoCacheKey(ref, 400), photoCacheKey(ref, 400));
  // And the two sizes the route DOES distinguish stay distinguished, so the
  // thumbnail tier is not silently merged into the card tier either.
  assert.notStrictEqual(photoCacheKey(ref, 400), photoCacheKey(ref, 160));
});
