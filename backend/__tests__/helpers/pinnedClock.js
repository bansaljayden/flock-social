'use strict';
// ---------------------------------------------------------------------------
// The global clock, moved to a chosen instant and left running.
//
// After pinClock(startMs), Date.now() and `new Date()` with no argument answer
// startMs plus the real time that has passed since the pin. Timers, timeouts
// and cache ages behave exactly as they do on the real clock; only the instant
// they start from is chosen. A Date built from an argument, Date.parse and
// Date.UTC are untouched, a Date made before the pin is still `instanceof
// Date`, and `restore()` puts the real Date back.
//
// WHY. The spend and quota ledgers key their counters on the UTC day
// (utils/placesBudget.js, services/birdieUsage.js, the weather and event
// budgets). A test that charges one and reads it back, run from the real
// clock, fails whenever 00:00 UTC falls between the charge and the read: the
// counter rolls to the new day and reads zero. Which test fails then depends on
// when the suite ran rather than on the code. A file pinned to the middle of a
// UTC day has no day boundary anywhere near it. The same goes for the top of
// an hour or a four-hour slot, and for an expected value that holds only at
// some hours or on some dates, such as a count of the forecast slots a route
// reads, or of a monthly bill's charges in the next 90 days.
//
// Pin before requiring the code under test, so a value a module reads from the
// clock at load (a day key, say) comes from the same clock as everything after.
//
// helpers/steppingClock.js is for the opposite need, two reads of now that
// must land on two different days; helpers/virtualClock.js drives code that
// takes `now` as an argument and leaves the global clock alone.
//
// Used by every test file that calls pinClock (grep -l pinClock __tests__),
// each with a comment at the pin saying which of its assertions needs it.
// ---------------------------------------------------------------------------

function pinClock(startMs) {
  if (!Number.isFinite(startMs)) throw new Error(`pinClock: startMs must be a number, got ${String(startMs)}`);
  const RealDate = global.Date;
  const realStart = RealDate.now();
  const read = () => startMs + (RealDate.now() - realStart);
  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(read());
      else super(...args);
    }

    static now() {
      return read();
    }

    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }
  global.Date = PinnedDate;
  return {
    restore() {
      global.Date = RealDate;
    },
  };
}

module.exports = { pinClock };
