'use strict';
// ---------------------------------------------------------------------------
// A BESTTIME ANSWER WHOSE BODY NEVER FINISHES IS CUT AT THE CALL'S DEADLINE.
//
// `await fetch()` resolves when the response headers arrive, and the wrapper in
// scripts/ml/bestTimeService.js cleared its abort timer at that moment. The
// `.json()` after it had no deadline, so a body that trickled in after prompt
// headers held the call for as long as the connection stayed open. In the
// realtime sweep a call like that holds a slot the drain waits for, which could
// keep the collector alive until its three-hour watchdog.
//
// The fake fetch below answers headers at once with a body that never
// finishes, and fails the body read the way undici does once the request's
// signal aborts. That behaviour was checked against a real local server that
// trickles one byte every 200 ms: with a one second deadline, the old wrapper
// was still waiting at four seconds and the fixed one failed at one. The
// timers here are node:test's mock clock, so twenty and thirty seconds pass at
// once and nothing real is left running.
//
// HOW TO RUN
//   cd backend && node --test __tests__/bestTimeBodyDeadline.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

// A key, so the wrapper makes its call. The fake fetch is all it can reach.
process.env.BESTTIME_API_KEY = 'test-key';
const { fetchLiveBusyness, fetchWeeklyForecast, NETWORK_ERR_RE } = require('../scripts/ml/bestTimeService');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// Headers at once. The body arrives `bodyAfterMs` later on the mocked clock, or
// never when that is null; either way its read fails with the signal's reason
// as soon as the request is aborted.
function fakeBestTime({ body = { status: 'OK' }, bodyAfterMs = null } = {}) {
  const seen = { calls: 0, signal: null };
  global.fetch = async (url, options = {}) => {
    seen.calls++;
    seen.signal = options.signal;
    return {
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        const { signal } = options;
        if (signal && signal.aborted) { reject(signal.reason); return; }
        if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (bodyAfterMs !== null) setTimeout(() => resolve(body), bodyAfterMs);
      }),
    };
  };
  return seen;
}

// setImmediate is not mocked: one turn runs every promise continuation queued.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; }
  );
  return state;
}

// The caller's view of a cut call: a failure, of the kind collectRealtime
// counts as slow on our own clock, never as BestTime down or the key dead.
function assertCutOnOurClock(call) {
  assert.ok(call.error, `a cut call must fail, not answer (it answered ${JSON.stringify(call.value)})`);
  assert.match(String(call.error.message), NETWORK_ERR_RE);
  assert.ok(!call.error.transient && !call.error.fatal,
    'a timeout of ours must not read as an upstream outage or a dead key');
}

test('a live answer whose body never finishes is cut at twenty seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const seen = fakeBestTime();
  const call = track(fetchLiveBusyness('bt-venue-1'));
  await flush();
  assert.strictEqual(seen.calls, 1);

  t.mock.timers.tick(19999);
  await flush();
  assert.strictEqual(call.settled, false, 'cut before its twenty seconds were up');

  t.mock.timers.tick(1);
  await flush();
  assert.strictEqual(call.settled, true,
    'the body read outlived the deadline: the timer stopped when the headers arrived');
  assertCutOnOurClock(call);
});

test('a weekly forecast whose body never finishes is cut at thirty seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  fakeBestTime();
  const call = track(fetchWeeklyForecast('Venue', '1 Main St', 'bt-venue-1'));
  await flush();

  t.mock.timers.tick(29999);
  await flush();
  assert.strictEqual(call.settled, false, 'cut before its thirty seconds were up');

  t.mock.timers.tick(1);
  await flush();
  assert.strictEqual(call.settled, true,
    'the body read outlived the deadline: the timer stopped when the headers arrived');
  assertCutOnOurClock(call);
});

test('a slow body that finishes inside the deadline is read, and the deadline is let go', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = fakeBestTime({
    body: {
      status: 'OK',
      analysis: {
        venue_forecasted_busyness: 40,
        venue_live_busyness: 70,
        venue_live_busyness_available: true,
        hour_analysis: 21,
        venue_open: true,
      },
    },
    bodyAfterMs: 19000,
  });
  const call = track(fetchLiveBusyness('bt-venue-1'));
  await flush();
  t.mock.timers.tick(19000); // the last of the body lands
  await flush();
  t.mock.timers.tick(150); // the wrapper's pause after a good answer
  await flush();
  assert.strictEqual(call.settled, true);
  assert.ifError(call.error);
  assert.deepStrictEqual(call.value, {
    forecastedBusyness: 40, liveBusyness: 70, liveAvailable: true, hour: 21, venueOpen: true,
  });

  // Round 13's rule still holds: nothing is left armed once the call is done,
  // so a finished request is never aborted and no timer outlives it.
  t.mock.timers.tick(60000);
  await flush();
  assert.strictEqual(seen.signal.aborted, false, 'the deadline outlived a call that had already answered');
});

test('a failed status is answered from the status alone, without waiting on its body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  global.fetch = async () => ({ ok: false, status: 503, json: () => new Promise(() => {}) });
  const call = track(fetchLiveBusyness('bt-venue-1'));
  await flush();
  assert.strictEqual(call.settled, true, 'a 503 waited on a body nobody reads');
  assert.strictEqual(call.error && call.error.transient, true);
});
