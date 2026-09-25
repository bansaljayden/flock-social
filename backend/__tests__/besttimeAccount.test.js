'use strict';
// ---------------------------------------------------------------------------
// services/besttimeAccount.js: the one read-only request to BestTime's key
// endpoint, shared by the admin Overview (services/moneyHub.js) and
// scripts/ml/besttimeAccountStatus.js.
//
// The endpoint takes the key in its URL and echoes both keys in its body, so
// this pins the service's contract directly: the request never throws, what it
// returns on a failure is a kind and a number or a code and nothing of the
// vendor's, and what readKeyStatus passes on carries neither key, however
// BestTime spells its answer. Zero network: global fetch is replaced for every
// call, and the keys are fakes assembled at runtime.
//
// HOW TO RUN
//   cd backend && node --test __tests__/besttimeAccount.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

const besttime = require('../services/besttimeAccount');

const KEY = ['pri', '0badc0de'.repeat(4)].join('_');
const PUBLIC_KEY = ['pub', 'c0ffee00'.repeat(4)].join('_');

async function withFetch(fake, fn) {
  const saved = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url: String(url), options }); return fake(url, options); };
  try {
    return { result: await fn(), calls };
  } finally {
    global.fetch = saved;
  }
}

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function assertNoKey(value, what) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(KEY), `the private key is in ${what}`);
  assert.ok(!text.includes(PUBLIC_KEY), `the public key is in ${what}`);
  assert.ok(!/\b(pri|pub)_[0-9a-f]{8,}/i.test(text), `something shaped like a key is in ${what}`);
}

test('one GET of the key endpoint, with the key in the path and a timeout on it', async () => {
  const { result, calls } = await withFetch(async () => jsonResponse(200, { status: 'OK', valid: true, active: true }), () => besttime.fetchKeyStatus(KEY));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, `${besttime.KEY_STATUS_URL}${KEY}`);
  assert.strictEqual(calls[0].url, `https://besttime.app/api/v1/keys/${KEY}`);
  assert.strictEqual(calls[0].options.method, 'GET');
  assert.ok(calls[0].options.signal instanceof AbortSignal, 'a request with no timeout can hold the hub open');
});

test('a failure is a kind and a number or a code, and never throws or carries the vendor\'s words', async () => {
  const cases = [
    [async () => jsonResponse(403, { message: `blocked ${KEY}` }), { ok: false, kind: 'http', httpStatus: 403 }],
    [async () => jsonResponse(500, null), { ok: false, kind: 'http', httpStatus: 500 }],
    [async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`Unexpected token in ${KEY}`); } }), { ok: false, kind: 'not_json' }],
    [async () => jsonResponse(200, [1, 2, 3]), { ok: false, kind: 'not_json' }],
    [async () => jsonResponse(200, 'OK'), { ok: false, kind: 'not_json' }],
    [async () => { const e = new TypeError(`fetch failed ${KEY}`); e.cause = { code: 'ENOTFOUND' }; throw e; }, { ok: false, kind: 'network', code: 'ENOTFOUND' }],
    [async () => { throw new DOMException('aborted', 'TimeoutError'); }, { ok: false, kind: 'network', code: 'TimeoutError' }],
    // A code that is not a plain token is not repeated: it could be anything.
    [async () => { const e = new Error('x'); e.cause = { code: `E ${KEY}` }; e.name = 'Error'; throw e; }, { ok: false, kind: 'network', code: 'unknown' }],
  ];
  for (const [fake, expected] of cases) {
    const { result } = await withFetch(fake, () => besttime.fetchKeyStatus(KEY));
    assert.deepStrictEqual(result, expected);
    assertNoKey(result, `the failure ${JSON.stringify(expected)}`);
  }
});

test('readKeyStatus passes on the health, the two counters and plan fields, and never a key', () => {
  const body = {
    api_key_private: KEY,
    api_key_public: PUBLIC_KEY,
    status: 'OK',
    active: true,
    valid: true,
    credits_forecast: 1,
    credits_query: 1,
    restricted_website_public: 'https://example.invalid',
    restricted_website_private: '',
    plan: { name: 'Pro Package 100', venues_new_used: 42 },
    cycle_reset: '2026-10-01',
    subscription_ref: `ref ${KEY}`,
    [`venue_${KEY}`]: 3,
    account_email: 'owner@example.invalid',
    session_token: 'tok',
    unrelated_field: 'x',
  };
  const s = besttime.readKeyStatus(body, { secrets: [KEY, PUBLIC_KEY] });
  assert.strictEqual(s.healthy, true);
  assert.strictEqual(s.status, 'OK');
  assert.strictEqual(s.valid, true);
  assert.strictEqual(s.active, true);
  assert.strictEqual(s.creditsForecast, 1);
  assert.strictEqual(s.creditsQuery, 1);
  assert.deepStrictEqual(s.reported, [
    { name: 'plan.name', value: 'Pro Package 100' },
    { name: 'plan.venues_new_used', value: 42 },
    { name: 'cycle_reset', value: '2026-10-01' },
    { name: 'subscription_ref', withheld: true },
  ]);
  assertNoKey(s, 'what readKeyStatus returns');
});

test('an unhealthy or oddly shaped answer is read as what it is, never guessed into health', () => {
  assert.strictEqual(besttime.readKeyStatus({ status: 'OK', valid: true, active: false }).healthy, false);
  assert.strictEqual(besttime.readKeyStatus({ status: 'OK', valid: 'true', active: true }).healthy, false, 'the string "true" is not true');
  const odd = besttime.readKeyStatus({ status: `bad ${KEY}`, credits_forecast: '7', credits_query: Infinity }, { secrets: [KEY] });
  assert.strictEqual(odd.status, '[withheld]');
  assert.strictEqual(odd.creditsForecast, null, 'a counter that is not a number is not reported as one');
  assert.strictEqual(odd.creditsQuery, null);
  const empty = besttime.readKeyStatus(null);
  assert.deepStrictEqual(empty, { healthy: false, status: null, valid: null, active: null, creditsForecast: null, creditsQuery: null, reported: [] });
});

test('the key comes from BESTTIME_API_KEY, trimmed, and a blank one is no key', () => {
  const saved = process.env.BESTTIME_API_KEY;
  try {
    process.env.BESTTIME_API_KEY = `  ${KEY}\n`;
    assert.strictEqual(besttime.configuredKey(), KEY);
    process.env.BESTTIME_API_KEY = '   ';
    assert.strictEqual(besttime.configuredKey(), null);
    delete process.env.BESTTIME_API_KEY;
    assert.strictEqual(besttime.configuredKey(), null);
  } finally {
    if (saved === undefined) delete process.env.BESTTIME_API_KEY; else process.env.BESTTIME_API_KEY = saved;
  }
});

test('the calendar month the allowance runs on, in UTC, the same dates the script prints', () => {
  assert.strictEqual(besttime.nextCalendarMonthStart(new Date('2026-09-25T13:00:00Z')), '2026-10-01');
  assert.strictEqual(besttime.calendarMonthEnd(new Date('2026-09-25T13:00:00Z')), '2026-09-30');
  assert.strictEqual(besttime.calendarMonthEnd(new Date('2028-02-01T00:00:00Z')), '2028-02-29');
  assert.strictEqual(besttime.nextCalendarMonthStart(new Date('2026-12-31T23:59:59Z')), '2027-01-01');
});
