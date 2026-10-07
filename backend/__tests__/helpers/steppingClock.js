'use strict';
// ---------------------------------------------------------------------------
// A clock for code that reads the global one, in the cases where two reads of
// "now" have to land on two different days.
//
// While `fn` runs, Date.now() and `new Date()` with no argument answer from
// this clock, which starts at `startMs` and moves forward one millisecond on
// every read. `fn` gets `{ set(ms) }` to move it, typically from inside a
// faked query that answers right before the code under test reads the clock,
// so the reads after it fall where the case needs them. A Date built from an
// argument, Date.parse and Date.UTC are untouched. The real Date is put back
// when `fn` settles, whether or not it threw.
//
// helpers/virtualClock.js is the other kind: it drives code that takes `now`
// and `pause` as arguments, and leaves the global clock alone.
//
// Used by entitlementGates.test.js and premiumKnownState.test.js.
// ---------------------------------------------------------------------------

async function withSteppingClock(startMs, fn) {
  const RealDate = global.Date;
  let next = startMs;
  const read = () => {
    const v = next;
    next += 1;
    return v;
  };
  class SteppingDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(read());
      else super(...args);
    }

    static now() {
      return read();
    }
  }
  global.Date = SteppingDate;
  try {
    return await fn({ set: (ms) => { next = ms; } });
  } finally {
    global.Date = RealDate;
  }
}

module.exports = { withSteppingClock };
