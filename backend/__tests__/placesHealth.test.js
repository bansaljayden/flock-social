// Run: node --test  (from backend/)
//
// THE ALARM FOR THE OUTAGE NOBODY PAID FOR.
//
// Google Places answered 429 from 2026-09-01 to 2026-09-05. Venue pins and
// photos were dead for five days and the only thing that noticed was a human,
// by eye, on day five. Railway's log had been printing
// "[PublicDemo] Places search failed: HTTP 429" the entire time.
//
// utils/placesBudget.js could not have caught it: it counts what Flock SPENDS,
// and a refused call costs nothing, so the money watch stays quiet through a
// total outage. utils/placesHealth.js counts OUTCOMES instead, which is free.
const test = require('node:test');
const assert = require('node:assert');

const {
  recordPlacesResult,
  isPlaceNotFoundAnswer,
  placesHealthStatus,
  __resetPlacesHealth,
  FAILURE_STREAK_ALARM,
} = require('../utils/placesHealth');

test.beforeEach(() => __resetPlacesHealth());

test('a quiet app is not an alarm', () => {
  // THE WHOLE OBJECTION TO A FREE WATCHER, PINNED. Flock has almost no traffic,
  // so "no successful Places calls today" must not be read as an outage. Zero
  // calls attempted is nobody using the app, and silence is the correct answer.
  const h = placesHealthStatus();
  assert.strictEqual(h.unhealthy, false);
  assert.strictEqual(h.consecutiveFailures, 0);
  assert.strictEqual(h.failingSince, null);
  assert.strictEqual(h.failingForMs, 0);
});

test('one failure is a blip, not an outage', () => {
  // A single timeout, one transient 5xx, one aborted request on a slow night.
  recordPlacesResult(false, 'unreachable');
  assert.strictEqual(placesHealthStatus().unhealthy, false);
});

test('a RUN of failures with no success between them is the alarm', () => {
  for (let i = 0; i < FAILURE_STREAK_ALARM; i += 1) recordPlacesResult(false, 'HTTP 429');
  const h = placesHealthStatus();
  assert.strictEqual(h.unhealthy, true);
  assert.strictEqual(h.consecutiveFailures, FAILURE_STREAK_ALARM);
  assert.deepStrictEqual(h.reasons, ['HTTP 429'], 'one reason repeated is one reason');
});

test('this is exactly what September looked like, and it fires', () => {
  // The demo path logged the same line over and over for five days. Any one of
  // those was enough to arm this; there were thousands.
  for (let i = 0; i < 500; i += 1) recordPlacesResult(false, 'HTTP 429');
  assert.strictEqual(placesHealthStatus().unhealthy, true);
});

test('a success breaks the streak, because recovery must silence it', () => {
  for (let i = 0; i < FAILURE_STREAK_ALARM; i += 1) recordPlacesResult(false, 'HTTP 429');
  assert.strictEqual(placesHealthStatus().unhealthy, true);

  recordPlacesResult(true);
  const h = placesHealthStatus();
  assert.strictEqual(h.unhealthy, false);
  assert.strictEqual(h.consecutiveFailures, 0);
  assert.strictEqual(h.failingSince, null, 'the "since" clears with the streak');
});

test('an intermittent upstream never reaches the alarm', () => {
  // Fail, succeed, fail, succeed. Ugly, but not the five-day blackout this
  // exists for, and paging somebody for it teaches them to ignore the page.
  for (let i = 0; i < 20; i += 1) {
    recordPlacesResult(false, 'HTTP 500');
    recordPlacesResult(true);
  }
  const h = placesHealthStatus();
  assert.strictEqual(h.unhealthy, false);
  assert.strictEqual(h.totalFailed, 20, 'the failures are still counted');
  assert.strictEqual(h.totalOk, 20);
});

test('failingSince is when the CURRENT run began, not the first failure ever', () => {
  const t0 = 1_000_000;
  recordPlacesResult(false, 'HTTP 429');
  recordPlacesResult(true);          // clears it
  const before = placesHealthStatus(t0).failingSince;
  assert.strictEqual(before, null);

  recordPlacesResult(false, 'HTTP 429');
  const h = placesHealthStatus(t0);
  assert.ok(h.failingSince !== null, 'a new run starts a new clock');
  assert.ok(h.failingSince <= Date.now());
});

test('reasons are deduped and newest first, so the alert says WHAT broke', () => {
  recordPlacesResult(false, 'HTTP 429');
  recordPlacesResult(false, 'HTTP 429');
  recordPlacesResult(false, 'unreachable');
  assert.deepStrictEqual(placesHealthStatus().reasons, ['unreachable', 'HTTP 429']);
});

test('the status carries a `day`, or the money watch goes silent forever', () => {
  // NOT COSMETIC. server.js sayOnceToday() treats a missing day as "already
  // spoke today" — its own comment says a reader that returns no day would turn
  // the alarm into the thing that fails quietly. Every other leg's status
  // reader returns one; this one must too.
  const h = placesHealthStatus();
  assert.strictEqual(typeof h.day, 'string');
  assert.match(h.day, /^\d{4}-\d{2}-\d{2}$/);
});

test('recording never throws, whatever it is handed', () => {
  // A watchdog that can break the thing it watches is worse than no watchdog.
  // These calls sit inside live request paths.
  assert.doesNotThrow(() => {
    recordPlacesResult(false);
    recordPlacesResult(false, undefined);
    recordPlacesResult(false, null);
    recordPlacesResult(true, 'ignored on success');
    recordPlacesResult(1);
    recordPlacesResult(0, 'falsy ok is a failure');
  });
});

test('every Places call site records an outcome', () => {
  // THE FAILURE MODE THIS PINS: a new Places call site added later that logs
  // its own error and tells the health counter nothing. The alarm would then be
  // watching a shrinking share of the app while looking just as green.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  // THE LIST IS DISCOVERED, NOT WRITTEN DOWN. A hardcoded list is a list
  // somebody forgets to extend: the alarm would then watch a shrinking share of
  // the app while staying just as green, which is the failure this whole test
  // exists to prevent. So every server file that actually talks to Places is
  // found by scanning, and each one must report.
  //
  // scripts/ml/ is excluded on purpose. Those are hand-run CLI tools, not
  // request paths — nobody is waiting on one, and a corpus build failing is
  // not a user-visible outage.
  const PLACES_FETCHERS = [];
  for (const dir of ['routes', 'services']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (!f.endsWith('.js')) continue;
      const rel = `${dir}/${f}`;
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      // The fetch itself, not a mention in a comment.
      if (/fetch\(\s*[`'"]https:\/\/places\.googleapis\.com/.test(src)) PLACES_FETCHERS.push(rel);
    }
  }
  assert.ok(
    PLACES_FETCHERS.length >= 6,
    `expected to find the known Places callers, found ${PLACES_FETCHERS.length}: ${PLACES_FETCHERS}`,
  );

  // Three recording shapes, all correct. The route files record at each exit;
  // services/placeDetailsCache.js has six exits and one caller so it wraps its
  // worker once; crowd.js, ai.js and badge.js pass the ok expression straight
  // in. What every one of them must do is record a SUCCESS as well as a
  // failure — a file that only ever reported failures would never clear the
  // streak and the alarm would stick on forever.
  // recordPlacesResult(true), or any expression whose truth is an `.ok`.
  const SUCCESS = /recordPlacesResult\(\s*(true\b|[A-Za-z_$][\w$]*\.ok\b)/;
  const FAILURE = /recordPlacesResult\(\s*(false\b|[A-Za-z_$][\w$]*\.ok\b)/;

  for (const rel of PLACES_FETCHERS) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(
      /require\('\.\.\/utils\/placesHealth'\)/.test(src),
      `${rel} calls Google Places and must record outcomes`,
    );
    assert.ok(
      SUCCESS.test(src),
      `${rel} must record SUCCESS too, or the streak never clears and the alarm sticks on`,
    );
    assert.ok(FAILURE.test(src), `${rel} must record failures`);
  }
});

test('a cached Places answer is never recorded as health', () => {
  // THE SUBTLE WAY THIS ALARM COULD HAVE LIED. routes/crowd.js serves its
  // alternatives search from a ten-minute cache, and the cached branch fakes
  // `searchResponse = { ok: true }` so the code below it needs no change.
  // Recording that as a success would let stale answers clear the failure
  // streak for as long as the cache lasts, which is exactly the window where an
  // outage is hardest to see. The record therefore sits INSIDE the branch that
  // actually asked Google, next to the setCache call, not after the join.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crowd.js'), 'utf8');

  const setCacheAt = src.indexOf('if (searchResponse.ok && !searchData.error) setCache(searchCacheKey');
  const recordAt = src.indexOf('recordPlacesResult(searchResponse.ok');
  assert.ok(setCacheAt > 0, 'the alternatives cache write is still there');
  assert.ok(recordAt > setCacheAt, 'the record follows the real fetch, not the cache hit');

  // And it must be above the shared failure check, which both branches reach.
  const sharedCheck = src.indexOf('if (!searchResponse.ok || searchData.error) {');
  assert.ok(sharedCheck > recordAt, 'the record is inside the else branch, not after the join');
});

test('only NOT_FOUND, or an INVALID_ARGUMENT naming the place id, is read as Google answering about it', () => {
  // A retired id answers NOT_FOUND, and that is Google working. Counted as a
  // failure, one tap on a stale saved venue built the streak that mailed
  // "Google Places is down". An id that never decoded (one Birdie's model made
  // up) answers INVALID_ARGUMENT and did the same. Everything else that says no
  // keeps counting, a dead API key's INVALID_ARGUMENT above all.
  const keyInfo = (reason) => [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service: 'places.googleapis.com' } },
  ];
  for (const [httpStatus, error, want, what] of [
    [404, { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' }, true, 'Places (New) NOT_FOUND'],
    [0, { status: 'NOT_FOUND' }, true, 'NOT_FOUND with no HTTP status to hand'],
    [0, { code: 404, message: 'not found' }, true, 'a 404 code with no status word'],
    [400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Not a valid Place ID: ChIJmadeUpByTheModel' }, true, 'an id that does not decode'],
    [400, { code: 400, status: 'INVALID_ARGUMENT', message: 'The provided Place ID is no longer valid. Please refresh cached Place IDs.' }, true, 'a stale id answered as INVALID_ARGUMENT'],
    [400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid placeId.' }, true, 'the camel-cased spelling'],
    [400, { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' }, false, 'a dead API key'],
    [400, { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: keyInfo('API_KEY_INVALID') }, false, 'a dead API key, with its ErrorInfo'],
    [400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Place ID lookup refused for this key.', details: keyInfo('API_KEY_EXPIRED') }, false, 'a key reason wins even when the wording names a place id'],
    [400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid field mask: places.id is not a field of Place.' }, false, 'a field mask complaint about places.id'],
    [400, { code: 400, status: 'INVALID_ARGUMENT' }, false, 'INVALID_ARGUMENT with no message to read'],
    [403, { code: 403, status: 'PERMISSION_DENIED', message: 'Place ID requests are blocked for this project.' }, false, 'only INVALID_ARGUMENT is read by its message'],
    [429, { code: 429, status: 'RESOURCE_EXHAUSTED' }, false, 'the September quota clamp'],
    [403, { code: 403, status: 'PERMISSION_DENIED' }, false, 'billing or key restriction'],
    [503, { code: 503, status: 'UNAVAILABLE' }, false, 'Google down'],
    [404, null, false, 'no error body at all'],
    [200, undefined, false, 'a success'],
  ]) {
    assert.strictEqual(isPlaceNotFoundAnswer(httpStatus, error), want, what);
  }
});

test('every Place Details caller that reads Google\'s error body counts NOT_FOUND as health', () => {
  // routes/publicCrowd.js did this first, inline (`resp.status === 404`). The
  // others share the one predicate so they cannot drift apart again.
  const fs = require('fs');
  const path = require('path');
  for (const rel of ['services/placeDetailsCache.js', 'routes/ai.js', 'routes/badge.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(src, /isPlaceNotFoundAnswer\(/, `${rel} records a retired place id as a Places failure again`);
  }
  const demo = fs.readFileSync(path.join(__dirname, '..', 'routes', 'publicCrowd.js'), 'utf8');
  assert.match(demo, /if \(resp\.status === 404\) recordPlacesResult\(true\);/);
});

test('a missing API key is NOT an outage', () => {
  // services/placeDetailsCache.js returns kind:'unconfigured' when
  // GOOGLE_PLACES_API_KEY is unset, and deliberately does not record it. That
  // is our own missing config, not Google refusing us, and counting it would
  // fire this alarm on every dev box that never set the variable.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'placeDetailsCache.js'), 'utf8',
  );
  assert.match(src, /kind !== 'unconfigured'/);
});
