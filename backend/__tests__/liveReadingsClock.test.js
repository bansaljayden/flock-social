// utils/liveReadingsClock.js: a cached crowd answer never lives past the next
// turn of the hour, and one made in the first minutes after a turn lives no
// further than the minute that hour's live readings are in by.
// No database, no network. Run: node --test  (from backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../utils/liveReadingsClock');

const at = (h, m, s = 0) => Date.UTC(2026, 10, 23, h, m, s);

test('the next boundary is HH:03 inside the first three minutes of an hour, else the next HH:00', () => {
  assert.equal(C.READINGS_IN_BY_MINUTE, 3);
  assert.equal(C.nextReadingsBoundary(at(6, 0, 0)), at(6, 3));
  assert.equal(C.nextReadingsBoundary(at(6, 2, 59)), at(6, 3));
  assert.equal(C.nextReadingsBoundary(at(6, 3, 0)), at(7, 0), 'at the minute itself the readings are in');
  assert.equal(C.nextReadingsBoundary(at(6, 30)), at(7, 0));
  assert.equal(C.nextReadingsBoundary(at(6, 59, 59)), at(7, 0));
  assert.equal(C.nextReadingsBoundary(at(23, 58)), Date.UTC(2026, 10, 24, 0, 0), 'across midnight');
});

test('an answer lives for its own TTL unless a boundary comes first', () => {
  const TEN = 10 * 60 * 1000;
  assert.equal(C.readingsExpiry(at(6, 10), TEN), at(6, 20), 'mid-hour: the TTL');
  assert.equal(C.readingsExpiry(at(6, 55), TEN), at(7, 0), 'never into the next hour');
  assert.equal(C.readingsExpiry(at(6, 0, 30), TEN), at(6, 3), 'made before the readings were in: until they are');
  assert.equal(C.readingsExpiry(at(6, 2), 30 * 1000), at(6, 2, 30), 'a TTL shorter than the boundary wins');
});

test('the seconds an HTTP max-age may promise end where the server copy does', () => {
  const FIFTEEN = 15 * 60 * 1000;
  assert.equal(C.secondsUntilReadingsExpiry(at(6, 10), FIFTEEN, at(6, 10)), 900);
  assert.equal(C.secondsUntilReadingsExpiry(at(6, 50), FIFTEEN, at(6, 55)), 300);
  assert.equal(C.secondsUntilReadingsExpiry(at(6, 1), FIFTEEN, at(6, 2, 30)), 30);
  assert.equal(C.secondsUntilReadingsExpiry(at(6, 50), FIFTEEN, at(7, 1)), 0, 'never negative');
});
