'use strict';
// ---------------------------------------------------------------------------
// A FAILED BESTTIME LOOKUP SAYS WHY, AND NEVER PRINTS THE KEY.
//
// A by-name forecast spends one of the month's 100 admissions whether it finds
// the venue or not, and a bare "(404)" cannot tell "BestTime has no foot
// traffic for this place" from "no venue at that address", which a better
// address would fix. So the wrapper reads the failure body's message and the
// collector logs it. The key rides in the query string, so a body that echoes
// the request must be cut before it is printed.
//
// HOW TO RUN
//   cd backend && node --test __tests__/bestTimeFailureReason.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

// Assembled at runtime, like every fake key in these suites, so no key-shaped
// literal sits in the tree for a secret scanner to stop on.
const KEY = ['pri', 'test', 'key', '0123456789'].join('_');
process.env.BESTTIME_API_KEY = KEY;
const { fetchWeeklyForecast, fetchJsonWithTimeout, redactKey } = require('../scripts/ml/bestTimeService');

const realFetch = global.fetch;
const realError = console.error;
test.afterEach(() => { global.fetch = realFetch; console.error = realError; });

function failWith(status, bodyText) {
  global.fetch = async () => ({
    ok: false,
    status,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  });
}

function captureErrors() {
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  return lines;
}

test('a 404 logs BestTime\'s own reason and is still a venue-level miss', async () => {
  failWith(404, JSON.stringify({ status: 'Error', message: 'Could not find the venue at this address' }));
  const lines = captureErrors();
  const result = await fetchWeeklyForecast('Wendy\'s', '123 Main St, Whitehall, PA', null);
  assert.strictEqual(result, null, 'a 404 must stay a miss the caller marks, not a throw');
  assert.ok(
    lines.some((l) => l.includes('Weekly forecast failed (404) for Wendy\'s: Could not find the venue at this address')),
    lines.join('\n')
  );
});

test('an echoed key is cut out of the reason before anything prints it', async () => {
  failWith(404, JSON.stringify({ message: `No data for api_key_private=${KEY}&venue_name=x` }));
  const lines = captureErrors();
  await fetchWeeklyForecast('X', 'Y', null);
  const all = lines.join('\n');
  assert.ok(!all.includes(KEY), all);
  assert.match(all, /api_key_private=\[key\]/);
});

test('a body that is not JSON is logged as text, bounded', async () => {
  failWith(404, `<html>${'x'.repeat(5000)}</html>`);
  const { reason } = await fetchJsonWithTimeout('https://example.invalid', {}, 1000);
  assert.ok(reason.startsWith('<html>'));
  assert.ok(reason.length <= 300, `reason is ${reason.length} characters`);
});

test('a body that cannot be read leaves the status to speak for itself', async () => {
  global.fetch = async () => ({ ok: false, status: 404, text: async () => { throw new Error('reset'); } });
  const lines = captureErrors();
  assert.strictEqual(await fetchWeeklyForecast('Z', 'Z', null), null);
  assert.ok(lines.some((l) => /Weekly forecast failed \(404\) for Z$/.test(l)), lines.join('\n'));
});

test('redactKey leaves text without a key alone and passes empty values through', () => {
  assert.strictEqual(redactKey('Venue not found'), 'Venue not found');
  assert.strictEqual(redactKey(null), null);
  assert.strictEqual(redactKey(''), '');
});
