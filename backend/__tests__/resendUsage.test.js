'use strict';
// Run: node --test __tests__/resendUsage.test.js  (from backend/)
//
// THE RESEND METER (services/resendUsage.js).
//
// What is pinned here:
//   1. With no key Resend is not asked and the answer is 'unset'.
//   2. A reading is one call to /usage, and carries today's and this month's
//      used, limit, reset time and share, beside the caps the code states.
//   3. A refusal, an error status, a timeout, a body that is not JSON and a
//      shape this reader does not know are each 'failed', never a zero.
//   4. The key is in the Authorization header and nowhere else: not the URL,
//      not the answer, not a log line, not a failure's words.
//   5. The 10-minute hold, the shorter hold on a failure, and a forced
//      refresh that still waits a minute.
//
// Every fetch here is a fake passed in; nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert');
const ru = require('../services/resendUsage');

const KEY = ['re', 'test', 'fixture', 'resendmeter', '0123456789'].join('_');

// The shape Resend answered with on 2026-10-08, with counts filled in.
function usage({ dailyUsed = 12, monthlyUsed = 340, daily = {}, monthly = {} } = {}) {
  return {
    object: 'usage',
    emails: {
      daily: { used: dailyUsed, limit: 100, sent: dailyUsed, received: 0, resets_at: '2026-10-08T23:59:59.999Z', ...daily },
      monthly: { used: monthlyUsed, limit: 3000, sent: monthlyUsed, received: 0, resets_at: '2026-10-28T08:20:02.910Z', ...monthly },
    },
    contacts: { used: 0, limit: 1000 },
  };
}

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof answer === 'function' ? answer(url, init) : answer;
  };
  fn.calls = calls;
  return fn;
}
const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function capturingLogs(fn) {
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  const grab = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
  console.error = grab;
  console.warn = grab;
  console.log = grab;
  try {
    return { result: await fn(), lines: lines.join('\n') };
  } finally {
    console.error = saved.error;
    console.warn = saved.warn;
    console.log = saved.log;
  }
}

const savedKey = process.env.RESEND_API_KEY;
test.beforeEach(() => {
  ru.__test.resetCache();
  process.env.RESEND_API_KEY = KEY;
});
test.after(() => {
  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
});

test('no key: Resend is not asked, and the answer says why with no numbers', async () => {
  delete process.env.RESEND_API_KEY;
  const f = fakeFetch(okJson(usage()));
  const u = await ru.readUsage({ fetchImpl: f });
  assert.strictEqual(u.status, 'unset');
  assert.strictEqual(u.reason, 'RESEND_API_KEY is not set, so Resend was not asked.');
  assert.strictEqual(u.daily, undefined);
  assert.strictEqual(u.monthly, undefined);
  assert.deepStrictEqual(u.included, { daily: 100, monthly: 3000 });
  assert.strictEqual(f.calls.length, 0);
  // Whitespace is not a key either.
  process.env.RESEND_API_KEY = '   ';
  assert.strictEqual((await ru.readUsage({ fetchImpl: f })).status, 'unset');
  assert.strictEqual(f.calls.length, 0);
});

test('a reading: one call to /usage, the key in the header only, both windows with their share', async () => {
  const f = fakeFetch(okJson(usage({ dailyUsed: 12, monthlyUsed: 340 })));
  const now = new Date(Date.UTC(2026, 9, 8, 15));
  const { result: u, lines } = await capturingLogs(() => ru.readUsage({ fetchImpl: f, now }));
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].url, 'https://api.resend.com/usage');
  assert.strictEqual(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!f.calls[0].url.includes(KEY));
  assert.ok(f.calls[0].init.signal, 'the read has a timeout');

  assert.strictEqual(u.status, 'read');
  assert.strictEqual(u.reason, null);
  assert.strictEqual(u.cached, false);
  assert.strictEqual(u.asOf, now.toISOString());
  assert.deepStrictEqual(u.daily, { used: 12, limit: 100, resetsAt: '2026-10-08T23:59:59.999Z', share: 0.12 });
  assert.deepStrictEqual(u.monthly, { used: 340, limit: 3000, resetsAt: '2026-10-28T08:20:02.910Z', share: 340 / 3000 });
  assert.deepStrictEqual(u.included, { daily: 100, monthly: 3000 });
  assert.ok(!JSON.stringify(u).includes(KEY), 'the key reached the answer');
  assert.ok(!lines.includes(KEY));
});

test('a quiet day is a real zero, read from Resend, and the live answer of 2026-10-08 parses', () => {
  const live = {
    object: 'usage',
    emails: {
      daily: { used: 0, limit: 100, sent: 0, received: 0, resets_at: '2026-10-08T23:59:59.999Z' },
      monthly: { used: 0, limit: 3000, sent: 0, received: 0, resets_at: '2026-10-28T08:20:02.910Z' },
    },
    contacts: {},
  };
  const p = ru.parseUsage(live);
  assert.deepStrictEqual(p.daily, { used: 0, limit: 100, resetsAt: '2026-10-08T23:59:59.999Z', share: 0 });
  assert.deepStrictEqual(p.monthly, { used: 0, limit: 3000, resetsAt: '2026-10-28T08:20:02.910Z', share: 0 });
  // A window with no cap (how a plan without a daily limit would answer) has
  // no share, and is still a reading.
  const uncapped = ru.parseUsage(usage({ daily: { limit: null, resets_at: null } }));
  assert.deepStrictEqual(uncapped.daily, { used: 12, limit: null, resetsAt: null, share: null });
});

test('shapes this reader does not know are not readings', () => {
  const bad = [
    null,
    'usage',
    {},
    { object: 'usage' },
    { object: 'error', emails: usage().emails },
    { object: 'usage', emails: { daily: usage().emails.daily } },
    usage({ daily: { used: '12' } }),
    usage({ daily: { used: -1 } }),
    usage({ daily: { used: Number.NaN } }),
    usage({ monthly: { limit: 0 } }),
    usage({ monthly: { limit: '3000' } }),
    usage({ monthly: { limit: undefined } }),
    usage({ daily: { resets_at: 'tomorrow' } }),
    usage({ daily: { resets_at: 1760000000 } }),
  ];
  for (const body of bad) {
    assert.strictEqual(ru.parseUsage(body), null, JSON.stringify(body));
  }
});

test('a refused key, an error status, a timeout, a body that is not JSON and an unknown shape are failed reads with no numbers', async () => {
  const cases = [
    ['refused', fakeFetch(new Response('{"message":"API key is invalid"}', { status: 401 })), /^Resend refused RESEND_API_KEY \(401\) when asked for usage\./, /usage read refused: 401/],
    ['forbidden', fakeFetch(new Response('{}', { status: 403 })), /^Resend refused RESEND_API_KEY \(403\)/, /usage read refused: 403/],
    ['rate limited', fakeFetch(new Response('{}', { status: 429 })), /^Resend answered 429, so there is no reading\.$/, /usage read failed: HTTP 429/],
    ['server error', fakeFetch(new Response('oops', { status: 502 })), /^Resend answered 502, so there is no reading\.$/, /usage read failed: HTTP 502/],
    ['timeout', fakeFetch(() => { throw Object.assign(new Error(`timed out asking with ${KEY}`), { name: 'TimeoutError' }); }), /^Resend did not answer within 4 seconds\.$/, /usage read failed: TimeoutError/],
    ['network', fakeFetch(() => { throw new TypeError(`fetch failed for Bearer ${KEY}`); }), /^Resend could not be reached\.$/, /usage read failed: TypeError/],
    ['not json', fakeFetch(new Response('<html>maintenance</html>', { status: 200 })), /^Resend answered with something that is not JSON\.$/, /not JSON/],
    ['unknown shape', fakeFetch(okJson({ data: [] })), /^Resend answered in a shape this reader does not know/, /unknown shape/],
    ['negative count', fakeFetch(okJson(usage({ dailyUsed: -5 }))), /shape this reader does not know/, /unknown shape/],
  ];
  for (const [name, f, words, logged] of cases) {
    ru.__test.resetCache();
    const { result: u, lines } = await capturingLogs(() => ru.readUsage({ fetchImpl: f }));
    assert.strictEqual(u.status, 'failed', name);
    assert.match(u.reason, words, name);
    for (const field of ['daily', 'monthly']) {
      assert.strictEqual(u[field], undefined, `${name}: a failure carried ${field}`);
    }
    assert.deepStrictEqual(u.included, { daily: 100, monthly: 3000 }, name);
    assert.match(lines, logged, name);
    assert.ok(!lines.includes(KEY), `${name}: the key reached a log line`);
    assert.ok(!JSON.stringify(u).includes(KEY), `${name}: the key reached the answer`);
  }
});

test('held for 10 minutes, a failure for 5, and a forced refresh still waits a minute', async () => {
  const t0 = Date.UTC(2026, 9, 8, 15);
  const f = fakeFetch(() => okJson(usage()));
  assert.strictEqual((await ru.readUsage({ fetchImpl: f, now: new Date(t0) })).cached, false);
  assert.strictEqual((await ru.readUsage({ fetchImpl: f, now: new Date(t0 + 9 * 60000) })).cached, true);
  assert.strictEqual(f.calls.length, 1);
  // Forced within the minute: still held. Forced after it: read again.
  assert.strictEqual((await ru.readUsage({ fetchImpl: f, now: new Date(t0 + 30000), force: true })).cached, true);
  assert.strictEqual((await ru.readUsage({ fetchImpl: f, now: new Date(t0 + 2 * 60000), force: true })).cached, false);
  assert.strictEqual(f.calls.length, 2);
  // Ten minutes after that read, asked again.
  assert.strictEqual((await ru.readUsage({ fetchImpl: f, now: new Date(t0 + 12 * 60000) })).cached, false);
  assert.strictEqual(f.calls.length, 3);

  // A failure is held five minutes, not ten.
  ru.__test.resetCache();
  const bad = fakeFetch(() => new Response('', { status: 503 }));
  await capturingLogs(() => ru.readUsage({ fetchImpl: bad, now: new Date(t0) }));
  const held = await ru.readUsage({ fetchImpl: bad, now: new Date(t0 + 4 * 60000) });
  assert.strictEqual(held.cached, true);
  assert.strictEqual(held.status, 'failed');
  await capturingLogs(() => ru.readUsage({ fetchImpl: bad, now: new Date(t0 + 6 * 60000) }));
  assert.strictEqual(bad.calls.length, 2);
  assert.strictEqual(ru.READ_TTL_MS, 10 * 60000);
  assert.strictEqual(ru.FAIL_TTL_MS, 5 * 60000);
  assert.strictEqual(ru.MIN_FORCE_MS, 60000);
});

test('the meter reads RESEND_API_KEY from the environment only, and its source carries no key', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'services', 'resendUsage.js'), 'utf8');
  assert.match(src, /process\.env\.RESEND_API_KEY/);
  assert.doesNotMatch(src, /re_[A-Za-z0-9]{8,}/, 'a key-shaped string in the source');
  // No log call is handed the key variable or the headers that carry it.
  for (const m of src.matchAll(/console\.(?:error|warn|log)\(([^;]*)\);/g)) {
    assert.doesNotMatch(m[1], /\bkey\b|headers|Authorization|init/i, `a log line is handed ${m[1]}`);
  }
});
