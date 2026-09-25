'use strict';
// ---------------------------------------------------------------------------
// A simulated clock for code that takes `now` and `pause` as arguments.
//
// Time moves only when nothing else can: every pending promise chain is
// drained first (one setImmediate turn runs all queued microtasks), then the
// clock jumps to the earliest timer and resolves it. So an hour-long sweep
// runs in well under a second, and the times a test reads are exact rather
// than "about a second". Timers due at the same moment fire in the order they
// were set.
//
// Only code that waits on this clock's `pause` (or on promises that settle
// without real I/O) can be driven by it. Anything awaiting a real socket or a
// real timer would look like a deadlock, and `run` says so rather than hang.
//
// Used by collectRealtimeConcurrency.test.js and
// collectRealtimeEventCache.test.js.
// ---------------------------------------------------------------------------

function virtualClock(startMs) {
  let t = startMs;
  let seq = 0;
  const timers = [];
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    pause: (ms) => new Promise((resolve) => {
      timers.push({ at: t + Math.max(0, ms), seq: seq++, resolve });
    }),
    // Settles `promise`, advancing simulated time only when every pending
    // promise chain has run and something is still waiting on a timer.
    async run(promise) {
      let settled = false;
      let value;
      let error;
      promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
      for (let steps = 0; ; steps++) {
        await flush();
        if (settled) break;
        if (timers.length === 0) throw new Error('deadlock: the code under test is waiting on something that is not a timer');
        if (steps > 2e6) throw new Error('runaway simulation');
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      if (error) throw error;
      return value;
    },
  };
}

module.exports = { virtualClock };
