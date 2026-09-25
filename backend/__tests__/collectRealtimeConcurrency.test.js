'use strict';
// ---------------------------------------------------------------------------
// The realtime sweep's scheduler, on a SIMULATED clock. No database, no network.
//
// WHY THIS EXISTS. Until 2026-09-25 the hourly collector slept a second after
// every call finished, so each call's latency was added to the pace. BestTime's
// slow answers and our own twenty second timeouts therefore stalled the whole
// sweep: production runs ended "Time budget reached after 255-277 calls" with
// about a thousand of 1,365 venues left over, every hour. The sweep now limits
// STARTS to one a second and lets up to eight calls wait on BestTime at once.
//
// What must not change is what BestTime sees at the front door, and every
// guard that made the old loop safe. So this file pins, by running the real
// scheduling code (createCallGate and sweepVenues from collectRealtime.js)
// against a fake BestTime on simulated time:
//   * starts are at least one second apart, always, including through holds;
//   * no more than the allowed number of calls is ever in flight;
//   * a burst of timeouts no longer eats the time budget one timeout at a time,
//     and a production-shaped hour now covers the whole scope;
//   * every breaker still trips, counts in completion order, stops new starts
//     at once, and cannot be renamed by a call that lands afterwards;
//   * the fifty-minute budget stops new starts and the calls in flight are
//     still counted before the sweep returns;
//   * a row carries the weather and clock of the moment its call STARTED, even
//     when the answer lands in the next hour or after the next city began.
//
// The simulated clock only moves when nothing else can: every pending promise
// chain is drained first, then time jumps to the next timer. So a fifty-minute
// sweep runs in well under a second and the numbers below are exact.
//
// HOW TO RUN
//   cd backend && node --test __tests__/collectRealtimeConcurrency.test.js
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');

// NOTHING HERE MAY REACH A REAL SERVICE. collectRealtime.js builds a pg Pool at
// load and loads backend/.env, whose PG* variables name the live database, and
// dotenv never overwrites a variable that is already set. So: a database URL
// on a port nothing listens on, and an EMPTY BestTime key (set, so dotenv leaves
// it alone; empty, so bestTimeService returns null without calling out). The
// three services are also replaced outright, so a fake that was forgotten fails
// loudly instead of calling out.
process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/none';
process.env.PGSSLMODE = 'disable';
process.env.BESTTIME_API_KEY = '';

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
const realBestTime = require('../scripts/ml/bestTimeService');
stubModule('../scripts/ml/bestTimeService', {
  ...realBestTime,
  fetchLiveBusyness: async () => { throw new Error('this suite must inject fetchLive'); },
  fetchWeeklyForecast: async () => { throw new Error('the realtime collector never fetches a week'); },
});
stubModule('../services/weatherService', {
  getWeather: async () => { throw new Error('this suite must inject weatherFor'); },
  getForecast: async () => [],
});
stubModule('../scripts/ml/eventService', {
  getNearestEvent: async () => { throw new Error('storeReading is not under test here'); },
});

const {
  createCallGate, sweepVenues, START_INTERVAL_MS, DEFAULT_MAX_IN_FLIGHT, MAX_IN_FLIGHT_CEILING,
  LABEL_LIVE, isOpenAtHour,
} = require('../scripts/ml/collectRealtime');
const { getLocalTime } = require('../scripts/ml/config');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BUDGET_MS = 50 * MINUTE; // collectRealtime's RUN_TIME_BUDGET_MS, pinned in collectRealtimeBudget.test.js
// 19:00 in Philadelphia on a Friday: an hour the open-hours filter leaves open.
const START = Date.UTC(2026, 8, 25, 23, 0, 0);

// The simulated clock: see __tests__/helpers/virtualClock.js.
const { virtualClock } = require('./helpers/virtualClock');

// Console output from the sweep, captured with the simulated time it was
// written at, and kept off the test report.
async function captured(clock, fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) {
    console[level] = (...args) => lines.push({ level, at: clock.now(), text: args.join(' ') });
  }
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// ---------------------------------------------------------------------------
// A fake BestTime and a fake write.
// ---------------------------------------------------------------------------
const LIVE = { forecastedBusyness: 40, liveBusyness: 70, liveAvailable: true, hour: null, venueOpen: true };
// The same shapes bestTimeService throws: our own AbortController, a 503, a
// key-level 403, a 5xx that is neither.
const timeoutError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const throttleError = () => Object.assign(new Error('BestTime 503 (live)'), { transient: true });
const fatalError = () => Object.assign(new Error('BestTime 403 (live) — key/credits problem, aborting run'), { fatal: true });
const upstreamError = () => Object.assign(new Error('BestTime 500 (live)'), { transient: true });

function venuesFor(city, n, firstId = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    besttime_venue_id: `bt_${city}_${firstId + i}`,
    name: `${city} venue ${firstId + i}`,
    city,
    timezone: 'America/New_York',
  }));
}

// `answer(venueId, callIndex)` returns { latencyMs, error? , result? }.
function harness({ answer, start = START, storeLatencyMs = 30, weatherFor } = {}) {
  const clock = virtualClock(start);
  const calls = [];
  const stored = [];
  let inFlight = 0;
  let peak = 0;
  const fetchLive = async (venueId) => {
    const call = { id: venueId, startAt: clock.now(), endAt: null };
    calls.push(call);
    inFlight++;
    if (inFlight > peak) peak = inFlight;
    const plan = answer(venueId, calls.length - 1);
    try {
      await clock.pause(plan.latencyMs);
      if (plan.error) throw plan.error;
      return plan.result === undefined ? LIVE : plan.result;
    } finally {
      inFlight--;
      call.endAt = clock.now();
    }
  };
  const store = async (venue, at, live) => {
    await clock.pause(storeLatencyMs);
    stored.push({ venue, at, live, storedAt: clock.now() });
    return LABEL_LIVE;
  };
  const weather = weatherFor || (async (lat, lon) => ({ lat, lon, fetchedAt: clock.now() }));
  const sweep = (cityOrder, options = {}) => captured(clock, () => clock.run(sweepVenues(cityOrder, {
    store, fetchLive, weatherFor: weather, now: clock.now, pause: clock.pause, ...options,
  })));
  return { clock, calls, stored, sweep, peak: () => peak };
}

function gaps(calls) {
  const out = [];
  for (let i = 1; i < calls.length; i++) out.push(calls[i].startAt - calls[i - 1].startAt);
  return out;
}

// ===========================================================================
// 1. The gate on its own
// ===========================================================================

test('the defaults are the ones the collector ships: one start a second, eight in flight, ten at most', () => {
  assert.strictEqual(START_INTERVAL_MS, 1000);
  assert.strictEqual(DEFAULT_MAX_IN_FLIGHT, 8);
  assert.strictEqual(MAX_IN_FLIGHT_CEILING, 10);
});

test('the gate starts no faster than one a second, however quickly calls finish', async () => {
  const clock = virtualClock(0);
  const gate = createCallGate({ maxInFlight: 10, now: clock.now, pause: clock.pause });
  const starts = [];
  await clock.run((async () => {
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(await gate.ready(), true);
      starts.push(clock.now());
      // Instant work: the only thing that can space the starts is the gate.
      gate.start(async () => {});
    }
    await gate.drain();
  })());
  assert.deepStrictEqual(starts, Array.from({ length: 12 }, (_, i) => i * 1000));
});

test('the gate never lets more than maxInFlight calls be unfinished at once', async () => {
  const clock = virtualClock(0);
  const gate = createCallGate({ maxInFlight: 3, now: clock.now, pause: clock.pause });
  let running = 0;
  let peak = 0;
  const starts = [];
  await clock.run((async () => {
    for (let i = 0; i < 20; i++) {
      await gate.ready();
      starts.push(clock.now());
      gate.start(async () => {
        running++;
        peak = Math.max(peak, running);
        await clock.pause(7500);
        running--;
      });
    }
    await gate.drain();
  })());
  assert.strictEqual(peak, 3);
  assert.strictEqual(gate.peak, 3);
  assert.ok(gaps(starts.map((s) => ({ startAt: s }))).every((g) => g >= 1000), 'two starts inside one second');
  // Three calls of 7.5 s each in flight, started a second apart: the fourth
  // waits for the first to finish at 7.5 s, not for a second after it.
  assert.deepStrictEqual(starts.slice(0, 5), [0, 1000, 2000, 7500, 8500]);
});

test('a hold keeps new starts out for its whole length and is never shortened by a later one', async () => {
  const clock = virtualClock(0);
  const gate = createCallGate({ maxInFlight: 6, now: clock.now, pause: clock.pause });
  const starts = [];
  await clock.run((async () => {
    await gate.ready();
    starts.push(clock.now());
    gate.start(async () => {
      await clock.pause(100);
      gate.holdOff(60000); // a 503 answered at 100 ms
      gate.holdOff(2000); // a shorter hold after it must not undercut the first
    });
    await gate.ready();
    starts.push(clock.now());
    gate.start(async () => {});
    await gate.drain();
  })());
  assert.deepStrictEqual(starts, [0, 60100]);
});

test('stop() wakes a gate that is waiting out a hold, at once, and it answers false', async () => {
  const clock = virtualClock(0);
  const gate = createCallGate({ maxInFlight: 6, now: clock.now, pause: clock.pause });
  let answeredAt = null;
  let answer = null;
  await clock.run((async () => {
    await gate.ready();
    gate.start(async () => {
      await clock.pause(100);
      gate.holdOff(60000);
      await clock.pause(400);
      gate.stop(); // a breaker trips half a second in
    });
    answer = await gate.ready();
    answeredAt = clock.now();
    await gate.drain();
  })());
  assert.strictEqual(answer, false);
  assert.strictEqual(answeredAt, 500, 'the stop waited out the sixty second hold before it was noticed');
  assert.throws(() => gate.start(async () => {}), /start\(\) after stop\(\)/);
});

test('given a deadline, the gate stops waiting on a hold when it passes, says so, and starts nothing', async () => {
  const clock = virtualClock(0);
  const gate = createCallGate({ maxInFlight: 6, now: clock.now, pause: clock.pause });
  const verdicts = [];
  await clock.run((async () => {
    await gate.ready(10000);
    gate.start(async () => {
      await clock.pause(100);
      gate.holdOff(60000); // a 503 at 0.1 s asks for a minute
    });
    verdicts.push([await gate.ready(10000), clock.now()]);
    // Asked again after the deadline, it answers at once.
    verdicts.push([await gate.ready(10000), clock.now()]);
    await gate.drain();
  })());
  assert.deepStrictEqual(verdicts, [['late', 10001], ['late', 10001]]);
  assert.strictEqual(gate.peak, 1, 'a call started after the deadline');
  // With no deadline the same hold is served in full, as before.
  const clock2 = virtualClock(0);
  const gate2 = createCallGate({ maxInFlight: 6, now: clock2.now, pause: clock2.pause });
  let second = null;
  await clock2.run((async () => {
    await gate2.ready();
    gate2.start(async () => { await clock2.pause(100); gate2.holdOff(60000); });
    second = [await gate2.ready(), clock2.now()];
    await gate2.drain();
  })());
  assert.deepStrictEqual(second, [true, 60100]);
});

test('a pause that returns early cannot turn the deadline cut into a spin', async () => {
  // The stubbed sleep some suites use resolves at once and time does not move.
  // The cut is taken once; after it the wait is served as before.
  let naps = 0;
  const gate = createCallGate({ maxInFlight: 6, now: () => 0, pause: async () => { naps++; } });
  await gate.ready(500);
  gate.start(async () => {});
  assert.strictEqual(await gate.ready(500), true);
  assert.ok(naps <= 2, `${naps} naps for one wait`);
  await gate.drain();
});

test('a call that throws what it should have handled stops the gate, and drain rethrows it after the rest land', async () => {
  const clock = virtualClock(0);
  const gate = createCallGate({ maxInFlight: 6, now: clock.now, pause: clock.pause });
  let otherFinishedAt = null;
  const boom = new Error('an unknown label_source');
  const outcome = clock.run((async () => {
    await gate.ready();
    gate.start(async () => { await clock.pause(5000); otherFinishedAt = clock.now(); });
    await gate.ready();
    gate.start(async () => { await clock.pause(200); throw boom; });
    assert.strictEqual(await gate.ready(), false, 'a new call started after an unhandled failure');
    await gate.drain();
  })());
  await assert.rejects(outcome, (err) => err === boom);
  assert.strictEqual(otherFinishedAt, 5000, 'drain rethrew before the call still in flight had finished');
});

// ===========================================================================
// 2. The sweep: pace, bound, order, and what overlapping buys
// ===========================================================================

test('the sweep starts venues in list order, one a second, and stores every answer', async () => {
  // The served-first order is decided in collectRealtime before the sweep; the
  // sweep must start venues exactly in the order it is handed them.
  const h = harness({ answer: () => ({ latencyMs: 200 }) });
  const venues = venuesFor('philly', 20);
  const { result } = await h.sweep([['philly', venues]]);
  assert.deepStrictEqual(h.calls.map((c) => c.id), venues.map((v) => v.besttime_venue_id));
  assert.ok(gaps(h.calls).every((g) => g >= 1000), 'two calls started inside one second');
  assert.strictEqual(result.called, 20);
  assert.strictEqual(result.totalRows, 20);
  assert.strictEqual(result.liveRows, 20);
  assert.strictEqual(h.stored.length, 20);
  assert.strictEqual(result.aborted, false);
  assert.strictEqual(result.budgetHit, false);
});

test('no more than the allowed number of calls is ever waiting on BestTime, and the tally reports the peak', async () => {
  for (const maxInFlight of [undefined, 3, 10]) {
    const allowed = maxInFlight || DEFAULT_MAX_IN_FLIGHT;
    const h = harness({ answer: () => ({ latencyMs: 15000 }) });
    const { result } = await h.sweep([['philly', venuesFor('philly', 40)]], { maxInFlight });
    assert.strictEqual(h.peak(), allowed, `the fake BestTime saw ${h.peak()} calls open at once, ${allowed} allowed`);
    assert.strictEqual(result.peakInFlight, allowed);
    assert.strictEqual(result.called, 40);
    assert.ok(gaps(h.calls).every((g) => g >= 1000));
  }
});

test('--max-in-flight=1 is the old serial sweep: never two calls open at once', async () => {
  const h = harness({ answer: (id, i) => ({ latencyMs: i % 3 === 0 ? 4000 : 300 }) });
  const { result } = await h.sweep([['philly', venuesFor('philly', 15)]], { maxInFlight: 1 });
  assert.strictEqual(h.peak(), 1);
  for (let i = 1; i < h.calls.length; i++) {
    assert.ok(h.calls[i].startAt >= h.calls[i - 1].endAt, 'a call started before the previous one answered');
  }
  assert.strictEqual(result.called, 15);
});

test('a burst of timeouts overlaps instead of spending the budget one timeout at a time', async () => {
  // Twenty-four venues in a row answer at our own twenty second timeout (the
  // Starbucks run of 2026-09-04 was nine), then thirty-six answer in a second.
  const plan = (id, i) => (i < 24 ? { latencyMs: 20000, error: timeoutError() } : { latencyMs: 1000 });
  const venues = venuesFor('philly', 60);

  const overlapped = harness({ answer: plan });
  const { result: fast } = await overlapped.sweep([['philly', venues]]);
  const overlappedMs = overlapped.clock.now() - START;

  const serial = harness({ answer: plan });
  const { result: slow } = await serial.sweep([['philly', venues]], { maxInFlight: 1 });
  const serialMs = serial.clock.now() - START;

  for (const r of [fast, slow]) {
    assert.strictEqual(r.called, 60);
    assert.strictEqual(r.aborted, false, 'twenty-four timeouts is under the twenty-five breaker');
    assert.strictEqual(r.totalRows, 36);
  }
  // When the burst stops holding the queue: the first venue after it starts.
  const firstAfterBurst = (h) => h.calls[24].startAt - START;
  // Serially each timeout cost its twenty seconds plus the two second hold.
  assert.ok(firstAfterBurst(serial) >= 24 * 22 * SECOND, `serial: ${firstAfterBurst(serial)} ms`);
  // Overlapped, the timeouts share their twenty second waits: a few waves of
  // eight instead of twenty-four waits in a row.
  assert.ok(firstAfterBurst(overlapped) <= 4 * 22 * SECOND, `overlapped: ${firstAfterBurst(overlapped)} ms`);
  // The thirty-six quick venues after it are then bounded by the pace alone.
  assert.ok(overlappedMs < 3 * MINUTE, `overlapped sweep took ${overlappedMs} ms`);
  assert.ok(serialMs > 9 * MINUTE, `serial reference took ${serialMs} ms`);
  assert.ok(gaps(overlapped.calls).every((g) => g >= 1000));
});

test('a production-shaped hour covers the whole 1,365 venue scope; the serial loop managed about 270', async () => {
  // The shape of a slow hour, calibrated so the SERIAL reference lands where
  // production did (255-277 calls, 2026-09-25): four in ten calls run into the
  // twenty second timeout, one in ten answers in fifteen seconds, the rest in
  // two. The overlapped sweep must reach every venue inside the same fifty
  // minutes, at the same one start a second.
  const plan = (id, i) => {
    const slot = i % 10;
    if (slot < 4) return { latencyMs: 20000, error: timeoutError() };
    if (slot === 4) return { latencyMs: 15000 };
    return { latencyMs: 2000 };
  };
  const venues = venuesFor('philly', 1365);

  const serial = harness({ answer: plan });
  const { result: slow, lines: slowLines } = await serial.sweep([['philly', venues]], { maxInFlight: 1 });
  assert.strictEqual(slow.budgetHit, true);
  assert.ok(slow.called > 250 && slow.called < 290, `serial reference made ${slow.called} calls`);
  assert.ok(slowLines.some((l) => l.text === `[ML:Realtime] Time budget reached after ${slow.called} calls; the rest of this sweep is left for the next run.`));

  const overlapped = harness({ answer: plan });
  const { result: fast } = await overlapped.sweep([['philly', venues]]);
  const minutes = (overlapped.clock.now() - START) / MINUTE;
  assert.strictEqual(fast.budgetHit, false, `the overlapped sweep ran out of budget after ${fast.called} calls`);
  assert.strictEqual(fast.called, 1365);
  assert.strictEqual(fast.leftForNextRun, 0);
  const answered = venues.filter((_, i) => i % 10 >= 4).length;
  assert.strictEqual(fast.totalRows, answered, 'every answered call is one row');
  assert.strictEqual(overlapped.stored.length, answered);
  assert.strictEqual(fast.aborted, false);
  // With room to spare, not by a whisker: a slower hour must still fit.
  assert.ok(minutes < 45, `the overlapped sweep needed ${minutes.toFixed(1)} of its 50 minutes`);
  assert.ok(gaps(overlapped.calls).every((g) => g >= 1000), 'the start pace was exceeded somewhere');
  assert.ok(overlapped.peak() <= DEFAULT_MAX_IN_FLIGHT);
});

test('a venue the open-hours filter calls shut is not called and costs no pace time', async () => {
  const venues = venuesFor('philly', 7);
  // Venue 1 and venue 7 open now; the five between are shut all day.
  const localHour = getLocalTime('America/New_York', START).hour;
  const shutAllDay = 0;
  const openNow = 1 << localHour;
  assert.strictEqual(isOpenAtHour(shutAllDay, localHour), false);
  const masks = new Map(venues.map((v) => [v.id, v.id === 1 || v.id === 7 ? openNow : shutAllDay]));
  const h = harness({ answer: () => ({ latencyMs: 100 }) });
  const { result } = await h.sweep([['philly', venues]], { openHourMasks: masks });
  assert.deepStrictEqual(h.calls.map((c) => c.id), ['bt_philly_1', 'bt_philly_7']);
  assert.deepStrictEqual(h.calls.map((c) => c.startAt - START), [0, 1000]);
  assert.strictEqual(result.closedSkips, 5);
  assert.strictEqual(result.called, 2);
});

// ===========================================================================
// 3. The breakers, in completion order
// ===========================================================================

function lineAt(lines, re) {
  const hit = lines.find((l) => re.test(l.text));
  assert.ok(hit, `no log line matched ${re}`);
  return hit.at;
}

test('twenty-five timeouts in a row stop the sweep, and nothing starts after the breaker trips', async () => {
  const h = harness({ answer: () => ({ latencyMs: 20000, error: timeoutError() }) });
  const { result, lines } = await h.sweep([['philly', venuesFor('philly', 200)]]);
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(result.abortReason, 'network');
  const trippedAt = lineAt(lines, /25 calls in a row timed out or could not connect, aborting run/);
  assert.ok(h.calls.every((c) => c.startAt <= trippedAt), 'a call started after the breaker tripped');
  // The calls already in flight when it tripped were waited for, not dropped.
  assert.ok(h.calls.every((c) => c.endAt !== null), 'the sweep returned with a call still open');
  assert.ok(result.called >= 25 && result.called <= 25 + DEFAULT_MAX_IN_FLIGHT - 1, `called ${result.called}`);
  assert.strictEqual(result.called, h.calls.length);
  // Serially twenty-five hangs took nine minutes; overlapped, about two.
  assert.ok(trippedAt - START < 3 * MINUTE, `the breaker took ${(trippedAt - START) / 1000} s to trip`);
});

test('a success resets the count: twenty-four timeouts, one answer, twenty-four more is not an outage', async () => {
  // One call in flight at a time, so completion order is start order and the
  // count is exact.
  const h = harness({ answer: (id, i) => (i === 24 ? { latencyMs: 500 } : { latencyMs: 20000, error: timeoutError() }) });
  const { result } = await h.sweep([['philly', venuesFor('philly', 49)]], { maxInFlight: 1 });
  assert.strictEqual(result.aborted, false);
  assert.strictEqual(result.called, 49);
  assert.strictEqual(result.totalRows, 1);
});

test('the breakers count COMPLETIONS: a fast answer that lands inside a run of timeouts resets it', async () => {
  // In START order this is thirty timeouts with a fast answer after every
  // sixth. Overlapped, each fast answer lands before the timeouts started ahead
  // of it, so no twenty-five failures are ever consecutive as answers arrive.
  const plan = (id, i) => ((i + 1) % 7 === 0 ? { latencyMs: 800 } : { latencyMs: 20000, error: timeoutError() });
  const h = harness({ answer: plan });
  const { result } = await h.sweep([['philly', venuesFor('philly', 35)]]);
  assert.strictEqual(result.aborted, false);
  assert.strictEqual(result.called, 35);
  assert.strictEqual(result.totalRows, 5);
});

test('a 403 stops the run at once; calls still in flight land afterwards and cannot rename the abort', async () => {
  // The 403 takes 2.5 s, so two more calls start before it lands; both then
  // time out. They must be logged as failing after the stop, and the reason
  // stays 'fatal', which is what sends the reader to the subscription.
  const plan = (id, i) => (i === 0 ? { latencyMs: 2500, error: fatalError() } : { latencyMs: 20000, error: timeoutError() });
  const h = harness({ answer: plan });
  const { result, lines } = await h.sweep([['philly', venuesFor('philly', 50)]]);
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(result.abortReason, 'fatal');
  assert.strictEqual(result.called, 3);
  assert.deepStrictEqual(h.calls.map((c) => c.startAt - START), [0, 1000, 2000]);
  const trippedAt = lineAt(lines, /FATAL: BestTime 403/);
  assert.strictEqual(trippedAt - START, 2500);
  assert.strictEqual(lines.filter((l) => /failed after the run stopped/.test(l.text)).length, 2);
  assert.ok(!lines.some((l) => /Slow or unreachable/.test(l.text)), 'a trailing timeout counted toward a breaker');
});

test('forty 503s in a row stop the run, and each one holds new calls for a minute', async () => {
  const h = harness({ answer: () => ({ latencyMs: 100, error: throttleError() }) });
  const { result } = await h.sweep([['philly', venuesFor('philly', 100)]]);
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(result.abortReason, 'throttled');
  assert.strictEqual(result.called, 40);
  // A throttle wall keeps the serial rhythm: a call, its fast 503, a minute.
  assert.ok(gaps(h.calls).every((g) => g >= 60000), `gaps ${gaps(h.calls).slice(0, 3)}`);
  assert.ok(h.clock.now() - START >= 39 * MINUTE, 'a throttle wall must last forty minutes to stop a night');
});

test('ten upstream errors in a row stop the run as upstream, not as a network or key problem', async () => {
  const h = harness({ answer: () => ({ latencyMs: 300, error: upstreamError() }) });
  const { result } = await h.sweep([['philly', venuesFor('philly', 100)]]);
  assert.strictEqual(result.aborted, true);
  assert.strictEqual(result.abortReason, 'upstream');
  assert.strictEqual(result.called, 10);
  // And each failure held the next start for two seconds, as the serial loop slept.
  assert.ok(gaps(h.calls).every((g) => g >= 2000), `gaps ${gaps(h.calls).slice(0, 3)}`);
});

// ===========================================================================
// 4. The time budget
// ===========================================================================

test('the fifty-minute budget stops new starts, and the calls in flight are still counted', async () => {
  // Slow but successful answers: nineteen seconds each, so eight in flight
  // manage about one call every two and a half seconds and 3,000 venues
  // cannot fit.
  const h = harness({ answer: () => ({ latencyMs: 19000 }) });
  const venues = venuesFor('philly', 3000);
  const { result, lines } = await h.sweep([['philly', venues]]);
  assert.strictEqual(result.budgetHit, true);
  const lastStart = Math.max(...h.calls.map((c) => c.startAt));
  assert.ok(lastStart - START <= BUDGET_MS, 'a call started after the budget ran out');
  // Every started call answered and was stored before the sweep returned.
  assert.strictEqual(h.stored.length, result.called);
  assert.strictEqual(result.totalRows, result.called);
  assert.strictEqual(result.leftForNextRun, venues.length - result.called);
  // The line monitoring reads, printed once, with the calls spent at that moment.
  const budgetLines = lines.filter((l) => /Time budget reached/.test(l.text));
  assert.strictEqual(budgetLines.length, 1);
  assert.strictEqual(budgetLines[0].text,
    `[ML:Realtime] Time budget reached after ${result.called} calls; the rest of this sweep is left for the next run.`);
  assert.ok(budgetLines[0].level === 'warn');
  // It ends at most one answer and one write past the budget.
  assert.ok(h.clock.now() - START <= BUDGET_MS + 19000 + 30 + 1000, `ended ${(h.clock.now() - START) / 1000} s in`);
});

test('a 503 hold that would run past the budget is cut at the budget, so the sweep still ends within a timeout of it', async () => {
  // Answers take half a second, so the sweep starts one venue a second right up
  // to the budget. The call started at 49:57 answers 503 at 49:57.5 and asks
  // for a sixty second hold. Waiting that out would keep the sweep in the gate
  // until 50:57.5 before it looked at the budget at all.
  const throttledIndex = BUDGET_MS / 1000 - 3;
  const h = harness({
    answer: (id, i) => (i === throttledIndex ? { latencyMs: 500, error: throttleError() } : { latencyMs: 500 }),
  });
  const { result, lines } = await h.sweep([['philly', venuesFor('philly', 3100)]]);
  assert.strictEqual(result.budgetHit, true);
  const noticed = lines.find((l) => /Time budget reached/.test(l.text)).at - START;
  assert.ok(noticed <= BUDGET_MS + 1000, `the budget was noticed ${(noticed - BUDGET_MS) / 1000} s after it ran out`);
  const ended = h.clock.now() - START;
  assert.ok(ended <= BUDGET_MS + 20000 + 1000, `the sweep ended ${(ended - BUDGET_MS) / 1000} s past the budget`);
  // The hold itself was honoured: nothing started between the 503 and the budget.
  const throttledAt = h.calls[throttledIndex].endAt;
  assert.ok(h.calls.every((c) => c.startAt <= throttledAt), 'a call started inside the hold');
  assert.strictEqual(result.called, throttledIndex + 1);
});

// ===========================================================================
// 4b. A sweep that throws still waits for the calls it started
// ===========================================================================

test('a venue whose clock cannot be read fails the sweep only after every call in flight has landed', async () => {
  // getLocalTime throws RangeError on a time zone Intl does not know. Four
  // venues ahead of this one are still waiting on BestTime when the sweep
  // reaches it. If the error left the sweep at once, run() would end the pg
  // pool while those four answers were still on their way back to a write.
  const venues = venuesFor('philly', 8);
  venues[4] = { ...venues[4], timezone: 'Gotham/Nowhere' };
  const h = harness({ answer: () => ({ latencyMs: 10000 }) });
  await assert.rejects(h.sweep([['philly', venues]]),
    (err) => err instanceof RangeError && /Gotham\/Nowhere/.test(err.message));
  assert.strictEqual(h.calls.length, 4, 'a call started after the sweep failed');
  assert.ok(h.calls.every((c) => c.endAt !== null), 'the sweep failed with calls still waiting on BestTime');
  assert.strictEqual(h.stored.length, 4, 'an answer that landed was not written before the failure surfaced');
  assert.ok(h.stored.every((s) => s.storedAt <= h.clock.now()));
});

test('if a call also fails while the sweep is stopping, the sweep\'s own error surfaces and the other is reported', async () => {
  const venues = venuesFor('philly', 8);
  venues[4] = { ...venues[4], timezone: 'Gotham/Nowhere' };
  const clock = virtualClock(START);
  const boom = new Error('a write threw what it should have handled');
  let writes = 0;
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(args.join(' '));
  let error = null;
  try {
    await clock.run(sweepVenues([['philly', venues]], {
      store: async () => { writes++; if (writes === 1) throw boom; return LABEL_LIVE; },
      fetchLive: async () => { await clock.pause(10000); return LIVE; },
      weatherFor: async () => ({}),
      now: clock.now,
      pause: clock.pause,
    }));
  } catch (err) {
    error = err;
  } finally {
    Object.assign(console, saved);
  }
  assert.ok(error instanceof RangeError, `the sweep surfaced ${error && error.message} instead of its own error`);
  assert.ok(lines.some((l) => l.includes(boom.message)), 'the call that failed during the stop was not reported');
  assert.strictEqual(writes, 4, 'the other answers in flight were not written');
});

// ===========================================================================
// 5. The row carries its own moment
// ===========================================================================

test('a row gets the weather current when its call STARTED, across an hour turn and a city change', async () => {
  // 21:59:50 UTC. Calls take fifteen seconds, so the first calls of the hour
  // are answered after 22:00, and philly's last calls are still in flight when
  // lehigh's block starts. Each weather reading is tagged with the city it was
  // fetched for and the simulated hour it was fetched in.
  const start = Date.UTC(2026, 8, 25, 21, 59, 50);
  let clockRef = null;
  const weatherFor = async (lat) => {
    const city = lat > 40.3 ? 'lehigh' : 'philly';
    return { city, hour: new Date(clockRef.now()).getUTCHours() };
  };
  const h = harness({ start, answer: () => ({ latencyMs: 15000 }), weatherFor });
  clockRef = h.clock;
  const philly = venuesFor('philly', 20, 1);
  const lehigh = venuesFor('lehigh', 20, 101);
  const { result } = await h.sweep([['philly', philly], ['lehigh', lehigh]]);
  assert.strictEqual(result.called, 40);
  assert.strictEqual(h.stored.length, 40);

  const startedAt = new Map(h.calls.map((c) => [c.id, c.startAt]));
  let crossedHour = 0;
  let crossedCity = 0;
  const lehighBegan = startedAt.get('bt_lehigh_101');
  for (const row of h.stored) {
    const began = startedAt.get(row.venue.besttime_venue_id);
    assert.strictEqual(row.at.weather.city, row.venue.city,
      `${row.venue.name} was stamped with ${row.at.weather.city}'s weather`);
    assert.strictEqual(row.at.weather.hour, new Date(began).getUTCHours(),
      `${row.venue.name} started in hour ${new Date(began).getUTCHours()} and was stamped with hour ${row.at.weather.hour}'s weather`);
    // The row's own clock is the start's too, not the answer's.
    assert.strictEqual(row.at.obs.hour, getLocalTime('America/New_York', began).hour);
    if (new Date(row.storedAt).getUTCHours() !== new Date(began).getUTCHours()) crossedHour++;
    if (row.venue.city === 'philly' && row.storedAt > lehighBegan) crossedCity++;
  }
  // The fixture really did exercise both races.
  assert.ok(crossedHour > 0, 'no answer landed in a later hour than its call started');
  assert.ok(crossedCity > 0, 'no philly answer landed after lehigh began');
});

test('the sweep refuses to run without a write to hand answers to', async () => {
  await assert.rejects(() => sweepVenues([['philly', venuesFor('philly', 1)]], {}), /needs a store/);
});

test('a write that throws what it should have handled fails the sweep, after the calls in flight land', async () => {
  const clock = virtualClock(START);
  const boom = new Error('[ML:Realtime] classifyReading returned an unknown label_source: echo');
  const started = [];
  const finished = [];
  const fetchLive = async (id) => { started.push(clock.now()); await clock.pause(5000); finished.push(id); return LIVE; };
  let writes = 0;
  const store = async () => { writes++; if (writes === 1) throw boom; return LABEL_LIVE; };
  const run = captured(clock, () => clock.run(sweepVenues([['philly', venuesFor('philly', 30)]], {
    store, fetchLive, weatherFor: async () => ({}), now: clock.now, pause: clock.pause,
  })));
  await assert.rejects(run, (err) => err === boom);
  // The throw landed at 5 s; calls started before it finished; none after it.
  assert.ok(started.every((s) => s - START <= 5000), 'a call started after the unhandled throw');
  assert.strictEqual(finished.length, started.length, 'the sweep rejected with calls still open');
});
