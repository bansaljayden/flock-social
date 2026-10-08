'use strict';
// Run: node --test __tests__/maptilerUsage.test.js  (from backend/)
//
// THE MAPTILER METER (services/maptilerUsage.js).
//
// What is pinned here:
//   1. With no token MapTiler is not asked and the answer is 'unset'.
//   2. A reading parses MapTiler's JSON timeline into the right pools: map and
//      weather sessions together, search sessions apart, requests apart, and
//      an export listed but in no pool.
//   3. A refusal, an error status, a timeout, a body that is not JSON and a
//      shape this reader does not know are each 'failed', never a zero.
//   4. Under three days into the period no pace is worked out.
//   5. The overage at the boundaries: 25,000 sessions is $0, 25,001 is
//      $0.0025 and rounds to $0.00, 26,000 is $2.50; requests the same way.
//   6. The token is in the Authorization header and nowhere else: not the URL,
//      not the answer, not a log line, not a failure's words.
//   7. The 30-minute hold, the shorter hold on a failure, and a forced refresh
//      that still waits a minute.
//
// Every fetch here is a fake passed in; nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert');
const mtu = require('../services/maptilerUsage');

const TOKEN = ['mt', 'service', 'test', 'fixture', '0123456789'].join('_');
const DAY = 86400000;

function timeline({ since = '2026-10-07', datasets, legend } = {}) {
  return {
    since,
    until: '2026-11-06',
    datasets: datasets || [
      { group_id: 'session', item_id: 'maps', data: [{ date: since, value: 300 }, { date: '2026-10-08', value: 200 }] },
      { group_id: 'session', item_id: 'weather', data: [{ date: since, value: 40 }] },
      { group_id: 'session', item_id: 'geocoding', data: [{ date: since, value: 7 }] },
      { group_id: 'request', item_id: 'tiles', data: [{ date: since, value: 9000 }, { date: '2026-10-08', value: 1000 }] },
      { group_id: 'request', item_id: 'static', data: [{ date: since, value: 450 }] },
      { group_id: 'export', item_id: 'export', data: [{ date: since, value: 3 }] },
    ],
    legend: legend || [
      { item_id: 'maps', label: 'Map sessions', description: null },
      { item_id: 'weather', label: 'Weather sessions', description: null },
      { item_id: 'geocoding', label: 'Search sessions', description: null },
      { item_id: 'tiles', label: 'Tiles', description: null },
      { item_id: 'static', label: 'Static maps', description: null },
      { item_id: 'export', label: 'Exports', description: null },
    ],
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

const savedToken = process.env.MAPTILER_SERVICE_TOKEN;
test.beforeEach(() => {
  mtu.__test.resetCache();
  process.env.MAPTILER_SERVICE_TOKEN = TOKEN;
});
test.after(() => {
  if (savedToken === undefined) delete process.env.MAPTILER_SERVICE_TOKEN;
  else process.env.MAPTILER_SERVICE_TOKEN = savedToken;
});

test('no token: MapTiler is not asked, and the answer says why with no numbers', async () => {
  delete process.env.MAPTILER_SERVICE_TOKEN;
  const f = fakeFetch(okJson(timeline()));
  const u = await mtu.readUsage({ fetchImpl: f });
  assert.strictEqual(u.status, 'unset');
  assert.strictEqual(u.reason, 'MAPTILER_SERVICE_TOKEN is not set, so MapTiler was not asked.');
  assert.strictEqual(u.sessions, undefined);
  assert.strictEqual(f.calls.length, 0);
  // Whitespace is not a token either.
  process.env.MAPTILER_SERVICE_TOKEN = '   ';
  assert.strictEqual((await mtu.readUsage({ fetchImpl: f })).status, 'unset');
  assert.strictEqual(f.calls.length, 0);
});

test('a reading: one call to the billing-period timeline, the token in the header only, the pools summed', async () => {
  const f = fakeFetch(okJson(timeline()));
  const now = new Date(Date.UTC(2026, 9, 16, 15)); // day 10 of 31
  const { result: u, lines } = await capturingLogs(() => mtu.readUsage({ fetchImpl: f, now }));
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].url, 'https://service.maptiler.com/v1/analytics/api_usage/timeline?period=current_billing_period&classifier=services&format=json');
  assert.strictEqual(f.calls[0].init.headers.Authorization, `Token ${TOKEN}`);
  assert.ok(!f.calls[0].url.includes(TOKEN));
  assert.ok(f.calls[0].init.signal, 'the read has a timeout');

  assert.strictEqual(u.status, 'read');
  assert.strictEqual(u.cached, false);
  // Map and weather sessions share the main pool; search has its own.
  assert.strictEqual(u.sessions, 540);
  assert.strictEqual(u.searchSessions, 7);
  assert.strictEqual(u.sessions3d, 0);
  assert.strictEqual(u.requests, 10450);
  // The export is listed and in no pool.
  assert.deepStrictEqual(u.byItem.find((i) => i.item === 'export'), { group: 'export', item: 'export', label: 'Exports', count: 3, pool: null });
  assert.deepStrictEqual(u.byItem.map((i) => i.count), [10000, 500, 450, 40, 7, 3], 'largest first');
  assert.deepStrictEqual(u.period, { since: '2026-10-07', until: '2026-11-06', endsOn: '2026-11-06', renewsOn: '2026-11-07', daysElapsed: 10, daysInPeriod: 31 });
  assert.deepStrictEqual(u.included, { sessions: 25000, searchSessions: 3000, sessions3d: 10000, requests: 500000 });
  // The pace: used / days so far x days in the period.
  assert.deepStrictEqual(u.projected, { sessions: 1674, searchSessions: 22, sessions3d: 0, requests: 32395 });
  assert.strictEqual(u.projectionWithheld, null);
  assert.strictEqual(u.overSoFarCents, 0);
  assert.strictEqual(u.overProjectedCents, 0);
  assert.ok(!JSON.stringify(u).includes(TOKEN), 'the token reached the answer');
  assert.ok(!lines.includes(TOKEN));
});

test('under three days into the period no pace is worked out, and from the third day one is', () => {
  const parsed = mtu.parseTimeline(timeline());
  for (const [day, withheld] of [[1, true], [2, true], [3, false]]) {
    const now = new Date(Date.UTC(2026, 9, 7 + day - 1, 23, 59));
    const s = mtu.summarize(parsed, now);
    assert.strictEqual(s.period.daysElapsed, day);
    assert.strictEqual(s.projected === null, withheld, `day ${day}`);
    assert.strictEqual(s.overProjectedCents === null, withheld, `day ${day}`);
    if (withheld) assert.match(s.projectionWithheld, new RegExp(`^Day ${day} of 31 in the billing period, too early to work out a pace\\.$`));
  }
  assert.strictEqual(mtu.MIN_DAYS_FOR_PACE, 3);
});

test('the period runs a month from its first day, clamped to a short month', () => {
  const at = (since, now) => mtu.summarize(mtu.parseTimeline(timeline({ since })), now).period;
  assert.deepStrictEqual(at('2026-01-31', new Date(Date.UTC(2026, 1, 10))), {
    since: '2026-01-31', until: '2026-11-06', endsOn: '2026-02-27', renewsOn: '2026-02-28', daysElapsed: 11, daysInPeriod: 28,
  });
  // A day past the end (a late answer) never counts more days than the period has.
  assert.strictEqual(at('2026-10-07', new Date(Date.UTC(2026, 10, 20))).daysElapsed, 31);
});

test('the overage at the boundaries, rounded once', () => {
  assert.strictEqual(mtu.overageCents({ sessions: 25000 }), 0);
  assert.strictEqual(mtu.overageCents({ sessions: 25001 }), 0, '$0.0025 rounds to $0.00');
  assert.strictEqual(mtu.overageCents({ sessions: 26000 }), 250);
  assert.strictEqual(mtu.overageCents({ requests: 500000 }), 0);
  assert.strictEqual(mtu.overageCents({ requests: 501000 }), 15);
  assert.strictEqual(mtu.overageCents({ requests: 633334 }), 2000, '133,334 requests over is the $20 limit');
  assert.strictEqual(mtu.overageCents({ searchSessions: 4000 }), 250);
  assert.strictEqual(mtu.overageCents({ sessions3d: 11000 }), 600);
  // Summed unrounded: two halves of a cent make a cent, not two zeros.
  assert.strictEqual(mtu.overageCents({ sessions: 25002, searchSessions: 3002 }), 1);
  assert.strictEqual(mtu.overageCents({}), 0);
});

test('a refused token, an error status, a timeout, a body that is not JSON and an unknown shape are failed reads with no numbers', async () => {
  const cases = [
    ['refused', fakeFetch(new Response('{"detail":"Invalid token"}', { status: 401 })), /^MapTiler refused the service token \(401\)\./, /usage read refused: 401/],
    ['forbidden', fakeFetch(new Response('{}', { status: 403 })), /^MapTiler refused the service token \(403\)\./, /usage read refused: 403/],
    ['server error', fakeFetch(new Response('oops', { status: 502 })), /^MapTiler answered 502, so there is no reading\.$/, /usage read failed: HTTP 502/],
    ['timeout', fakeFetch(() => { throw Object.assign(new Error(`timed out asking with ${TOKEN}`), { name: 'TimeoutError' }); }), /^MapTiler did not answer within 4 seconds\.$/, /usage read failed: TimeoutError/],
    ['network', fakeFetch(() => { throw new TypeError(`fetch failed for Token ${TOKEN}`); }), /^MapTiler could not be reached\.$/, /usage read failed: TypeError/],
    ['not json', fakeFetch(new Response('<html>maintenance</html>', { status: 200 })), /^MapTiler answered with something that is not JSON\.$/, /not JSON/],
    ['unknown shape', fakeFetch(okJson({ rows: [] })), /^MapTiler answered in a shape this reader does not know/, /unknown shape/],
    ['negative count', fakeFetch(okJson(timeline({ datasets: [{ group_id: 'session', item_id: 'maps', data: [{ date: '2026-10-07', value: -5 }] }] }))), /shape this reader does not know/, /unknown shape/],
  ];
  for (const [name, f, words, logged] of cases) {
    mtu.__test.resetCache();
    const { result: u, lines } = await capturingLogs(() => mtu.readUsage({ fetchImpl: f }));
    assert.strictEqual(u.status, 'failed', name);
    assert.match(u.reason, words, name);
    for (const field of ['sessions', 'requests', 'projected', 'overSoFarCents']) {
      assert.strictEqual(u[field], undefined, `${name}: a failure carried ${field}`);
    }
    assert.match(lines, logged, name);
    assert.ok(!lines.includes(TOKEN), `${name}: the token reached a log line`);
    assert.ok(!JSON.stringify(u).includes(TOKEN), `${name}: the token reached the answer`);
  }
});

test('an item this reader cannot place counts against the main session pool, and 3D sessions have their own', () => {
  const parsed = mtu.parseTimeline(timeline({
    datasets: [
      { group_id: 'session', item_id: 'gs3d', data: [{ date: '2026-10-07', value: 4 }] },
      { group_id: 'session', item_id: 'something-new', data: [{ date: '2026-10-07', value: 9 }] },
    ],
    legend: [{ item_id: 'gs3d', label: '3D sessions (GeoSplats)', description: null }],
  }));
  assert.deepStrictEqual(parsed.totals, { sessions: 9, searchSessions: 0, sessions3d: 4, requests: 0 });
  assert.strictEqual(parsed.byItem.find((i) => i.item === 'something-new').label, 'something-new', 'no legend entry, so the id is the label');
  // A missing first day is not a reading.
  assert.strictEqual(mtu.parseTimeline({ datasets: [], legend: [] }), null);
  assert.strictEqual(mtu.parseTimeline(null), null);
});

test('held for 30 minutes, a failure for 5, and a forced refresh still waits a minute', async () => {
  const t0 = Date.UTC(2026, 9, 16, 15);
  const f = fakeFetch(() => okJson(timeline()));
  assert.strictEqual((await mtu.readUsage({ fetchImpl: f, now: new Date(t0) })).cached, false);
  assert.strictEqual((await mtu.readUsage({ fetchImpl: f, now: new Date(t0 + 29 * 60000) })).cached, true);
  assert.strictEqual(f.calls.length, 1);
  // Forced within the minute: still held. Forced after it: read again.
  assert.strictEqual((await mtu.readUsage({ fetchImpl: f, now: new Date(t0 + 30000), force: true })).cached, true);
  assert.strictEqual((await mtu.readUsage({ fetchImpl: f, now: new Date(t0 + 2 * 60000), force: true })).cached, false);
  assert.strictEqual(f.calls.length, 2);
  // Thirty minutes after that read, asked again.
  assert.strictEqual((await mtu.readUsage({ fetchImpl: f, now: new Date(t0 + 32 * 60000) })).cached, false);
  assert.strictEqual(f.calls.length, 3);

  // A failure is held five minutes, not thirty.
  mtu.__test.resetCache();
  const bad = fakeFetch(() => new Response('', { status: 503 }));
  await capturingLogs(() => mtu.readUsage({ fetchImpl: bad, now: new Date(t0) }));
  const held = await mtu.readUsage({ fetchImpl: bad, now: new Date(t0 + 4 * 60000) });
  assert.strictEqual(held.cached, true);
  assert.strictEqual(held.status, 'failed');
  await capturingLogs(() => mtu.readUsage({ fetchImpl: bad, now: new Date(t0 + 6 * 60000) }));
  assert.strictEqual(bad.calls.length, 2);
  assert.strictEqual(mtu.READ_TTL_MS, 30 * 60000);
  assert.strictEqual(mtu.FAIL_TTL_MS, 5 * 60000);
  assert.ok(DAY > mtu.READ_TTL_MS);
});

test('the meter reads MAPTILER_SERVICE_TOKEN from the environment only, and its source carries no token', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'services', 'maptilerUsage.js'), 'utf8');
  assert.match(src, /process\.env\.MAPTILER_SERVICE_TOKEN/);
  // No log call is handed the token variable or the headers that carry it.
  for (const m of src.matchAll(/console\.(?:error|warn|log)\(([^;]*)\);/g)) {
    assert.doesNotMatch(m[1], /token|headers|Authorization|init/i, `a log line is handed ${m[1]}`);
  }
});

test("today's usage counts: MapTiler sends it as estimated_data, apart from the closed days", () => {
  // The shape of a live answer on the first day of a period (2026-10-08).
  const first = mtu.parseTimeline({
    since: '2026-10-08', until: '2026-11-07',
    legend: [{ item_id: 'request.tile', label: 'Tiles', description: null }],
    datasets: [{ group_id: 'request', item_id: 'request.tile', data: [], estimated_data: { date: '2026-10-08', value: 126 } }],
  });
  assert.strictEqual(first.totals.requests, 126);
  // A later day: closed days plus today's estimate, and an estimate for a day
  // already in data is not counted twice.
  const later = mtu.parseTimeline({
    since: '2026-10-08', until: '2026-11-07', legend: [],
    datasets: [
      { group_id: 'request', item_id: 'request.tile', data: [{ date: '2026-10-08', value: 100 }, { date: '2026-10-09', value: 50 }], estimated_data: { date: '2026-10-10', value: 7 } },
      { group_id: 'session', item_id: 'session.map', data: [{ date: '2026-10-09', value: 3 }], estimated_data: { date: '2026-10-09', value: 3 } },
    ],
  });
  assert.strictEqual(later.totals.requests, 157);
  assert.strictEqual(later.totals.sessions, 3);
});
