// Run: node --test  (from backend/). Proves the server-side age-gate boundary.
// Dates are constructed with LOCAL numeric components + a fixed `now` so the
// results are deterministic regardless of timezone or the real clock.
const test = require('node:test');
const assert = require('node:assert');
const { ageFromDob, MIN_AGE } = require('../utils/age');

const NOW = new Date(2026, 5, 16); // local: June 16, 2026

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
