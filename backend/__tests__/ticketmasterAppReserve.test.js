'use strict';
// The day's Ticketmaster calls are shared with the app (scripts/ml/eventService.js,
// TM_APP_RESERVE, 2026-10-29): one key with a 5,000-a-day quota serves the
// collector and the web service, and the widened hourly sweep spent all of it
// in the first run or two after the reset, leaving the Events tab, the
// forecast's event features and Roost's event facts with 429 for the rest of
// the day. Once the remainder Ticketmaster reports is down to the reserve, the
// collector stops asking until the reset. No network: global.fetch is replaced.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const eventService = require('../scripts/ml/eventService');

const realFetch = global.fetch;
const savedKey = process.env.TICKETMASTER_API_KEY;
let calls = 0;

// One Discovery answer with the two rate-limit headers (null leaves one out).
function answer(status, available, resetAt) {
  const headers = { 'rate-limit-available': available, 'rate-limit-reset': resetAt };
  return async () => {
    calls++;
    return {
      ok: status === 200,
      status,
      headers: { get: (name) => (headers[name] == null ? null : String(headers[name])) },
      json: async () => ({ _embedded: { events: [] }, page: { totalElements: 0 } }),
    };
  };
}
const ask = () => eventService.fetchTicketmasterPage(39.95, -75.16, 2, new Date());
const inAnHour = () => Date.now() + 3600000;

test.beforeEach(() => {
  calls = 0;
  process.env.TICKETMASTER_API_KEY = 'test-key';
  eventService.__test.resetTicketmasterQuota();
});
test.after(() => {
  global.fetch = realFetch;
  if (savedKey === undefined) delete process.env.TICKETMASTER_API_KEY;
  else process.env.TICKETMASTER_API_KEY = savedKey;
});

test('above the reserve every request goes out', async () => {
  global.fetch = answer(200, eventService.TM_APP_RESERVE + 1, inAnHour());
  assert.ok(await ask());
  assert.ok(await ask());
  assert.strictEqual(calls, 2);
  assert.strictEqual(eventService.ticketmasterQuota().held, 0);
});

test('at the reserve the process stops asking until the reset, per venue too, and counts what it held', async () => {
  global.fetch = answer(200, eventService.TM_APP_RESERVE, inAnHour());
  assert.ok(await ask(), 'the answer that reports the reserve is still used');
  assert.strictEqual(await ask(), null);
  assert.strictEqual(await eventService.fetchTicketmasterEvents(39.95, -75.16), null);
  assert.strictEqual(calls, 1, 'nothing more was sent');
  const q = eventService.ticketmasterQuota();
  assert.deepStrictEqual([q.held, q.available, q.reserve], [2, eventService.TM_APP_RESERVE, 1500]);
});

test("the day's quota refused holds; the per-second limit refused does not", async () => {
  global.fetch = answer(429, 2500, inAnHour()); // a burst: the day still has calls
  assert.strictEqual(await ask(), null);
  global.fetch = answer(200, 2499, inAnHour());
  assert.ok(await ask(), 'the next request still goes out');
  global.fetch = answer(429, 0, inAnHour()); // QuotaViolation
  assert.strictEqual(await ask(), null);
  assert.strictEqual(await ask(), null);
  assert.strictEqual(calls, 3);
});

test('after the reset it asks again, and an answer without the headers holds nothing', async () => {
  global.fetch = answer(429, 0, Date.now() + 50);
  assert.strictEqual(await ask(), null);
  await new Promise((r) => setTimeout(r, 80));
  global.fetch = answer(200, null, null);
  assert.ok(await ask(), 'past the reset the day starts over');
  assert.ok(await ask());
  assert.strictEqual(calls, 3);
});

test("the collector's log says how many requests it held and why", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectRealtime.js'), 'utf8');
  assert.match(src, /const tm = typeof ticketmasterQuota === 'function' \? ticketmasterQuota\(\) : null;\s*if \(tm && tm\.held > 0\)/);
  assert.match(src, /requests not sent, leaving the app \$\{tm\.reserve\}/);
});
