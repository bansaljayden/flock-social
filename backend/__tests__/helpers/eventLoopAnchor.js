'use strict';
// ---------------------------------------------------------------------------
// Hold the event loop open across an await that only an UNREF'D timer will end.
//
// THE DEFECT THIS FIXES
// Three suites awaited a promise whose only pending work was a timer the
// production code had deliberately unref()'d:
//
//   server.js            setTimeout(() => resolve(false), 1500).unref()
//   services/firebaseService.js   timer.unref()
//   utils/upstream.js    AbortSignal.timeout(ms)   <- unref'd by Node itself
//
// The unref is correct in all three: a health probe, a push deadline and an
// upstream abort must never keep a process alive. But an unref'd timer does not
// count as work, so a test that is waiting on nothing else leaves the loop with
// nothing referenced at all. Node drains it, and node:test reports
//
//   error: 'Promise resolution is still pending but the event loop has already
//           resolved'
//   failureType: 'cancelledByParent'
//
// which cancels every remaining test in the FILE, not just the one that waited.
// One such test in observability.test.js took 14 checks down with it.
//
// WHY IT LOOKED GREEN FOR MONTHS
// Node 21 and later keep a referenced handle alive for the duration of a
// running test, so the loop never drains and the await always completes. Node
// 20 does not. The developer machine runs Node 25 and the CI workflow pins
// node-version: '20', so this went from permanently passing to permanently
// failing on the first run anywhere but that one laptop. It is not a
// regression and it is not a flake: it is a test that only ever worked because
// of a property of the runtime it happened to be run on. Verified both ways,
// same machine, same file: Node 25 passes, Node 20 cancels.
//
// WHAT THIS DOES
// Holds one ordinary referenced timer for exactly as long as the awaited work
// takes, then clears it. Nothing about the assertion changes, no deadline is
// relaxed, and the timer is gone before the test returns, so it can never mask
// a later hang: the anchor keeps the loop alive, it does not keep the promise
// alive. If the work under test genuinely never settles, the run still hangs,
// which is the honest outcome and what the job timeouts in tests.yml exist for.
//
// The interval is 60 seconds because it should never actually fire; it is a
// reference, not a poll.
// ---------------------------------------------------------------------------

/**
 * Await `fn()` with the event loop held open, so an unref'd timer inside the
 * code under test can still be the thing that settles it.
 *
 * @param {() => Promise<T>|T} fn work to run
 * @returns {Promise<T>} whatever `fn` resolves to
 * @template T
 */
async function withEventLoopHeldOpen(fn) {
  const anchor = setInterval(() => {}, 60000);
  try {
    return await fn();
  } finally {
    clearInterval(anchor);
  }
}

module.exports = { withEventLoopHeldOpen };
