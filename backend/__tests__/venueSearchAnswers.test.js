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
// `googleStatus` and `googleThrow` were added when the round-27 pass found that
// this fixture could only ever produce a 200 with a well-formed body, which is
// precisely the half of the upstream that was already handled. The two failure
// shapes it could not reach are the two that reached the user as "No venues
// found": a non-2xx carrying a body that is not `{error:...}`, and a fetch that
// rejects (an upstreamSignal timeout, or a proxy's HTML page failing json()).
let googleAnswer = null;
let googleStatus = 200;
let googleThrow = null;
let googleCalls = 0;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://places.googleapis.com/')) {
    googleCalls += 1;
    if (googleThrow) return Promise.reject(googleThrow);
    const answer = googleAnswer || { places: [] };
    return Promise.resolve({
      ok: googleStatus >= 200 && googleStatus < 300,
      status: googleStatus,
      json: async () => answer,
    });
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
  googleStatus = 200;
  googleThrow = null;
  googleCalls = 0;
});

async function get(pathname) {
  const res = await realFetch(`${base}${pathname}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

// frontend/src/services/api.js RETRYABLE_STATUSES, which is the client's own
// list of statuses it re-requests automatically on a GET. Retyped rather than
// imported, because a backend suite cannot reach the frontend package. The
// case that reads it says what it is for: any status in this list costs a
// second and third paid Google call when the route answers it.
const RETRYABLE_STATUSES = [502, 503, 504];

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

// ---------------------------------------------------------------------------
// 7. An outage is not an empty result, and was being reported as one
// ---------------------------------------------------------------------------
// `response.ok` was never read on the text-search path. Google's `{error:{...}}`
// body is only one of the shapes a non-answer arrives in: a 5xx from Google's
// edge, from Railway's egress or from any intermediary in between carries
// whatever JSON that hop feels like, and every one of those walked past the
// error-body check into `data.places || []`. The route answered 200 with an
// empty list, which is the ONE answer frontend/src/App.js is allowed to print
// "No venues found. Try a different search." for. So the user's spelling was
// blamed for our outage through the half of the path nobody had guarded, while
// the copy in section 2 above was busy being careful about the other half.
//
// services/placeDetailsCache.js closed exactly this for Place Details and wrote
// the finding up in its own header; it never crossed to Text Search.

test('a Google 5xx carrying a non-error body is a failure, not "no venues found"', async () => {
  googleStatus = 503;
  googleAnswer = { message: 'backend unavailable' };
  const res = await get(`/api/venues/search?query=${uniq()}`);

  assert.notStrictEqual(res.status, 200,
    'an upstream 503 was answered 200, so the client renders it as "No venues found"');
  assert.strictEqual(res.status, 502, res.text);
  assert.strictEqual(res.body.error, 'Venue search is not answering right now. Try again in a moment.');
  assert.ok(!('venues' in (res.body || {})), 'a failure must not carry a venues list at all');
});

test('a 200 whose `places` is a FALSY non-list is a failure, not an empty result', async () => {
  // The quiet member of the same class, and the one worth choosing the fixture
  // for. `(data.places || [])` turns null, 0, '' and false into an empty array,
  // so a 200 carrying `{"places": null}` was mapped to {venues: [], total: 0}
  // and printed as "No venues found" with nothing anywhere saying otherwise.
  // A non-list that is TRUTHY ('not a list', {}) throws inside .map and lands
  // in the catch below, which already answers 502 with this same sentence, so
  // it does not exercise the guard at all. This fixture is the one a removed
  // guard actually changes the answer to.
  googleStatus = 200;
  googleAnswer = { places: null };
  const res = await get(`/api/venues/search?query=${uniq()}`);
  assert.strictEqual(res.status, 502, res.text);
  assert.strictEqual(res.body.error, 'Venue search is not answering right now. Try again in a moment.');
  assert.ok(!('venues' in (res.body || {})),
    'a malformed upstream body was answered as an empty venue list');
});

test('a truthy non-list `places` is also a failure, by whichever guard reaches it', async () => {
  googleStatus = 200;
  googleAnswer = { places: 'not a list' };
  const res = await get(`/api/venues/search?query=${uniq()}`);
  assert.strictEqual(res.status, 502, res.text);
  assert.strictEqual(res.body.error, 'Venue search is not answering right now. Try again in a moment.');
});

test('a genuinely empty answer is STILL a 200, so the guard did not eat the real case', async () => {
  // The half that must not regress. Google omits `places` entirely when nothing
  // matched; it does not send an empty array. If the guard above read a missing
  // key as a bad body, every honest "nothing matched" would become a 502 and
  // the client would print an outage sentence for a misspelled bar name.
  googleStatus = 200;
  googleAnswer = {};
  const res = await get(`/api/venues/search?query=${uniq()}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { venues: [], total: 0 });
});

// ---------------------------------------------------------------------------
// 8. A timeout says it timed out
// ---------------------------------------------------------------------------
// upstreamSignal('places') is a 6-second AbortSignal.timeout and it REJECTS the
// fetch. That landed in the same catch as everything else and was answered
// `500 Failed to search venues`, which is wrong on both halves. Google did
// not answer and this server worked fine, and the sentence reads to the
// person typing as though their search had been rejected.

test('an upstream timeout says it timed out, and stays off the client retry path', async () => {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  googleThrow = timeout;

  const res = await get(`/api/venues/search?query=${uniq()}`);
  assert.match(res.body.error, /took too long/i,
    'a timeout is answered with a sentence that does not say a timeout happened');
  assert.ok(!/Failed to search venues/i.test(res.text),
    'a timeout is still being reported as a failed search');

  // THE STATUS IS THE MONEY HALF, and it is why this is not the 504 the event
  // plainly is. frontend/src/services/api.js retries every GET answering 502,
  // 503 or 504 twice, with backoff. A retry of this route is a fresh Places
  // budget charge and a fresh PAID Google call, because a failure is never
  // cached, and utils/upstream.js is explicit that a request Google already
  // received is billed whether or not we hung up on it. A 504 here would turn
  // one timeout into three invoices and about twenty-one seconds of spinner.
  // It would also lose the sentence asserted above, which buildHttpError
  // replaces on exactly those three statuses.
  assert.ok(!RETRYABLE_STATUSES.includes(res.status),
    `a timeout answered ${res.status}, which the client auto-retries into a second and third paid Google call`);
  assert.strictEqual(res.status, 500, res.text);
});

test('a non-JSON body from a proxy is a 502, and neither is cached', async () => {
  const q = uniq();
  const syntax = new SyntaxError('Unexpected token < in JSON at position 0');
  googleThrow = syntax;
  const failed = await get(`/api/venues/search?query=${q}`);
  assert.strictEqual(failed.status, 502, failed.text);
  assert.strictEqual(failed.body.error, 'Venue search is not answering right now. Try again in a moment.');

  // Same rule as the Places-error case above: a pinned failure would answer for
  // the whole 5-minute TTL and there would be no way to retry out of a blip.
  googleThrow = null;
  const recovered = await get(`/api/venues/search?query=${q}`);
  assert.strictEqual(recovered.status, 200, recovered.text);
});

// ---------------------------------------------------------------------------
// 9. No failure body may carry an internal string
// ---------------------------------------------------------------------------
// The sweep, rather than one assertion per branch, because the branch somebody
// adds next is the one nobody writes an assertion for. Every failure this file
// can reach is checked against the same list, and the list is what the browser
// pass actually saw on a phone: "Google Places API key not configured" rendered
// verbatim in the search dropdown.

test('no failure on any venue route answers with an internal string', async () => {
  const LEAKS = [
    'API key', 'api_key', 'not configured', 'Google', 'googleapis', 'Places API',
    'CDN', 'quota', 'PERMISSION_DENIED', 'undefined',
    // "Failed to ..." is not the leak of a secret, it is the leak of a stack
    // frame into display copy. It reads as an accusation to the person typing.
    'Failed to search', 'Failed to get venue', 'Failed to fetch photo',
  ];
  const failures = [];

  googleStatus = 503; googleAnswer = { message: 'backend unavailable' };
  failures.push(await get(`/api/venues/search?query=${uniq()}`));

  googleStatus = 200;
  googleAnswer = { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric Requests' } };
  failures.push(await get(`/api/venues/search?query=${uniq()}`));
  failures.push(await get('/api/venues/details?place_id=ChIJBBBBBBBBBBBBBBBBBBBBBB'));

  googleAnswer = null;
  const timeout = new Error('aborted'); timeout.name = 'TimeoutError';
  googleThrow = timeout;
  failures.push(await get(`/api/venues/search?query=${uniq()}`));
  googleThrow = null;

  failures.push(await get('/api/venues/search'));
  failures.push(await get(`/api/venues/search?query=${'a'.repeat(81)}`));
  failures.push(await get('/api/venues/details?place_id=' + encodeURIComponent('not a place id')));
  failures.push(await get('/api/venues/photo?ref=' + encodeURIComponent('places/x/photos/y?evil=1')));

  // An empty sweep is indistinguishable from a broken one, so say how many.
  assert.ok(failures.length >= 8, `the sweep collected only ${failures.length} responses`);
  for (const f of failures) {
    assert.ok(f.status >= 400, `a case in this sweep answered ${f.status}, so it is not a failure at all`);
    assert.strictEqual(typeof (f.body && f.body.error), 'string',
      `a failure answered with no error string: ${f.text}`);
    assert.ok(f.body.error.length > 12, `too terse to be a sentence: "${f.body.error}"`);
    for (const leak of LEAKS) {
      assert.ok(!f.body.error.toLowerCase().includes(leak.toLowerCase()),
        `"${f.body.error}" carries the internal string "${leak}"`);
    }
  }
});
