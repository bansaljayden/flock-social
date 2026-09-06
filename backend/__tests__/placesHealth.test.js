// Run: node --test  (from backend/)
//
// THE ALARM FOR THE OUTAGE NOBODY PAID FOR.
//
// Google Places answered 429 from 2026-09-01 to 2026-09-05. Venue pins and
// photos were dead for five days and the only thing that noticed was the maintainer,
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

  // Two shapes, because two shapes are correct. The route files record at each
  // exit; services/placeDetailsCache.js has SIX exits and one caller, so it
  // wraps its worker once and passes the boolean through. Both must record a
  // success as well as a failure — a file that only ever reports failures would
  // never clear the streak and the alarm would stick on forever.
  const PLACES_FETCHERS = [
    'routes/publicCrowd.js',
    'routes/venueSearch.js',
    'services/placeDetailsCache.js',
  ];
  for (const rel of PLACES_FETCHERS) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(
      /require\('\.\.\/utils\/placesHealth'\)/.test(src),
      `${rel} calls Google Places and must record outcomes`,
    );
    const recordsSuccess = src.includes('recordPlacesResult(true)')
      || /recordPlacesResult\(\s*out\.ok/.test(src);
    assert.ok(
      recordsSuccess,
      `${rel} must record SUCCESS too, or the streak never clears and the alarm sticks on`,
    );
    const recordsFailure = src.includes('recordPlacesResult(false')
      || /recordPlacesResult\(\s*out\.ok/.test(src);
    assert.ok(recordsFailure, `${rel} must record failures`);
  }
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
