// Run: node --test  (from backend/). Proves the server-side age-gate boundary.
// Dates of birth are constructed with LOCAL numeric components, the shape a
// DATE column arrives in from node-postgres. `now` is a fixed INSTANT, because
// "today" is the UTC date of the instant (utils/age.js todayParts), so the
// results are deterministic regardless of timezone or the real clock.
const test = require('node:test');
const assert = require('node:assert');
const { ageFromDob, yearEndDob, MIN_AGE } = require('../utils/age');

const NOW = new Date(Date.UTC(2026, 5, 16, 12)); // noon UTC, June 16, 2026
// The day a full date in a signup body was found buying an older answer.
const SEP_25 = new Date(Date.UTC(2026, 8, 25, 12));

test('clearly under 13 -> below MIN_AGE', () => {
  assert.ok(ageFromDob(new Date(2015, 0, 1), NOW) < MIN_AGE); // 11
});

test('clearly over 13 -> at/above MIN_AGE', () => {
  assert.ok(ageFromDob(new Date(2000, 0, 1), NOW) >= MIN_AGE);
});

test('birthday LATER this year -> not yet had it -> 12', () => {
  assert.strictEqual(ageFromDob(new Date(2013, 11, 1), NOW), 12); // born Dec 2013
});

test('birthday EARLIER this year -> already had it -> 13', () => {
  assert.strictEqual(ageFromDob(new Date(2013, 0, 1), NOW), 13); // born Jan 2013
});

test('exactly the 13th birthday today -> 13 (allowed)', () => {
  assert.strictEqual(ageFromDob(new Date(2013, 5, 16), NOW), 13);
});

test('missing / invalid DOB returns null', () => {
  assert.strictEqual(ageFromDob(null, NOW), null);
  assert.strictEqual(ageFromDob('not-a-date', NOW), null);
  assert.strictEqual(ageFromDob(undefined, NOW), null);
});

// ---------------------------------------------------------------------------
// ACCOUNT CREATION JUDGES THE YEAR. The three creation paths in routes/auth.js
// run the gate on yearEndDob(the date in the body), so any full date is judged
// as 31 December of its year: the end that can only count someone younger.
// ---------------------------------------------------------------------------

test('yearEndDob keeps the year and moves the day to 31 December', () => {
  assert.strictEqual(yearEndDob('2013-01-01'), '2013-12-31');
  assert.strictEqual(yearEndDob('2013-12-31'), '2013-12-31');
  assert.strictEqual(yearEndDob('2012-02-29'), '2012-12-31');
  // The time tail and the padding the creation paths already tolerate.
  assert.strictEqual(yearEndDob('2004-06-16T09:30:00Z'), '2004-12-31');
  assert.strictEqual(yearEndDob(' 2004-06-16 '), '2004-12-31');
});

test('yearEndDob refuses whatever ageFromDob refuses, so junk is still "no date"', () => {
  for (const junk of [null, undefined, '', 'not-a-date', '2013', '2013-02-30', '2013-02-29', '01/01/2013', 946684800000, ['2013-01-01']]) {
    assert.strictEqual(yearEndDob(junk), null, JSON.stringify(junk));
  }
});

test('a full date that is 13 today by its day is judged by its year, and is under the floor', () => {
  // By its day, 2013-01-01 is thirteen on 2026-09-25, which is how it got an
  // account while the gate read the full date.
  assert.strictEqual(ageFromDob('2013-01-01', SEP_25), 13);
  // By its year it is twelve, and the year is all creation may judge.
  assert.strictEqual(ageFromDob(yearEndDob('2013-01-01'), SEP_25), 12);
  assert.ok(ageFromDob(yearEndDob('2013-01-01'), SEP_25) < MIN_AGE);
  // Every day of that year gets the same answer, so the day in the body buys nothing.
  for (const day of ['2013-01-01', '2013-03-15', '2013-09-25', '2013-12-31']) {
    assert.strictEqual(ageFromDob(yearEndDob(day), SEP_25), 12, day);
  }
});

test('a year passes once its own 31 December is thirteen years back, and not a day before', () => {
  assert.strictEqual(ageFromDob(yearEndDob('2012-01-01'), SEP_25), 13);
  assert.strictEqual(ageFromDob(yearEndDob('2012-12-31'), SEP_25), 13);
  // 2013 turns thirteen on 31 December 2026, the first day it can pass.
  assert.strictEqual(ageFromDob(yearEndDob('2013-06-16'), new Date(Date.UTC(2026, 11, 30, 23, 59))), 12);
  assert.strictEqual(ageFromDob(yearEndDob('2013-06-16'), new Date(Date.UTC(2026, 11, 31, 0, 0))), 13);
});
