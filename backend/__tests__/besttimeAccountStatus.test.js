'use strict';
// ---------------------------------------------------------------------------
// scripts/ml/besttimeAccountStatus.js prints the account's counters and never
// the key.
//
// The endpoint it calls, GET /api/v1/keys/<private key>, puts the key in the
// URL and echoes BOTH keys back in its body (api_key_private, api_key_public),
// so every path out of the script is a way to leak one: printing the body,
// printing a field BestTime might add later that happens to carry a key,
// logging the request URL, or logging a fetch error whose message quotes it.
// Each is pinned below against fake keys. Zero network: fetch is replaced for
// every call, and the real key never enters this process, because the fake
// ones are set before the require and dotenv never overwrites a variable that
// is already set.
//
// HOW TO RUN
//   cd backend && node --test __tests__/besttimeAccountStatus.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

const FAKE_PRIVATE = 'pri_0123456789abcdef0123456789abcdef';
const FAKE_PUBLIC = 'pub_fedcba9876543210fedcba9876543210';
process.env.BESTTIME_API_KEY = FAKE_PRIVATE;
process.env.BESTTIME_API_KEY_PUBLIC = FAKE_PUBLIC;

const { main } = require('../scripts/ml/besttimeAccountStatus');

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function runWith(fakeFetch) {
  const saved = { fetch: global.fetch, log: console.log, error: console.error, exitCode: process.exitCode };
  const lines = [];
  const requests = [];
  global.fetch = async (url, options) => { requests.push({ url: String(url), options }); return fakeFetch(url, options); };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await main();
    return { out: lines.join('\n'), exitCode: process.exitCode, requests };
  } finally {
    global.fetch = saved.fetch;
    console.log = saved.log;
    console.error = saved.error;
    process.exitCode = saved.exitCode;
  }
}

function assertNoKeyMaterial(out) {
  assert.ok(!out.includes(FAKE_PRIVATE), 'the private key was printed');
  assert.ok(!out.includes(FAKE_PUBLIC), 'the public key was printed');
  assert.ok(!out.includes(FAKE_PRIVATE.slice(4, 16)), 'part of the private key was printed');
  assert.ok(!/\b(pri|pub)_[0-9a-f]{8,}/i.test(out), 'something shaped like a key was printed');
}

test('it prints the key health and both counters, and neither key the response echoes', async () => {
  const { out, exitCode, requests } = await runWith(async () => jsonResponse(200, {
    api_key_private: FAKE_PRIVATE,
    api_key_public: FAKE_PUBLIC,
    status: 'OK',
    active: true,
    valid: true,
    credits_forecast: 73,
    credits_query: 12,
    restricted_website_public: 'https://example.invalid',
    restricted_website_private: '',
  }));
  assertNoKeyMaterial(out);
  assert.notStrictEqual(exitCode, 1);
  assert.match(out, /Key health\s+: OK \(valid, active\)/);
  assert.match(out, /credits_forecast\s+: 73/);
  assert.match(out, /credits_query\s+: 12/);
  assert.match(out, /Plan name\s+: not reported by the key endpoint/);
  // The two counters are printed as BestTime names them and never passed off
  // as the admission count, which the API does not report.
  assert.match(out, /Admissions left\s+: not reported by the API/);
  assert.match(out, /Cycle reset\s+: not reported by the key endpoint; .* next reset is \d{4}-\d{2}-01 \(derived, not read\)/);
  assert.ok(!out.includes('example.invalid'), 'the key\'s website restriction is not an account counter');
  // One read, of the key endpoint, and nothing else.
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url, `https://besttime.app/api/v1/keys/${FAKE_PRIVATE}`);
  assert.strictEqual(requests[0].options.method, 'GET');
});

test('a plan or quota field BestTime may add is printed by name, and withheld if it carries a key', async () => {
  const { out } = await runWith(async () => jsonResponse(200, {
    api_key_private: FAKE_PRIVATE,
    status: 'OK',
    active: true,
    valid: true,
    credits_forecast: 1,
    credits_query: 1,
    plan_name: 'Pro Package 100',
    venues_new_remaining: 58,
    cycle_reset: '2026-10-01',
    subscription_ref: `sub for ${FAKE_PRIVATE}`,
    account_email: 'owner@example.invalid',
  }));
  assertNoKeyMaterial(out);
  assert.match(out, /plan_name\s+: Pro Package 100/);
  assert.match(out, /venues_new_remaining\s*: 58/);
  assert.match(out, /cycle_reset\s+: 2026-10-01/);
  assert.match(out, /subscription_ref\s+: \[withheld: contains key material\]/);
  assert.ok(!out.includes('owner@example.invalid'), 'an email is not an account counter');
});

test('a network failure prints its code, never the message that could quote the URL', async () => {
  const { out, exitCode } = await runWith(async () => {
    const err = new TypeError(`fetch failed: https://besttime.app/api/v1/keys/${FAKE_PRIVATE}`);
    err.cause = { code: 'ECONNRESET' };
    throw err;
  });
  assertNoKeyMaterial(out);
  assert.match(out, /Request failed \(ECONNRESET\)/);
  assert.strictEqual(exitCode, 1);
});

test('a rejected key exits non zero with the status and nothing from the body', async () => {
  const { out, exitCode } = await runWith(async () => jsonResponse(403, { api_key_private: FAKE_PRIVATE, status: 'Error' }));
  assertNoKeyMaterial(out);
  assert.match(out, /HTTP 403 from the key endpoint/);
  assert.strictEqual(exitCode, 1);
});

test('with no key configured it says so and calls nothing', async () => {
  const saved = process.env.BESTTIME_API_KEY;
  process.env.BESTTIME_API_KEY = '';
  try {
    const { out, exitCode, requests } = await runWith(async () => { throw new Error('must not be called'); });
    assert.match(out, /BESTTIME_API_KEY is not set/);
    assert.strictEqual(requests.length, 0);
    assert.strictEqual(exitCode, 1);
  } finally {
    process.env.BESTTIME_API_KEY = saved;
  }
});
