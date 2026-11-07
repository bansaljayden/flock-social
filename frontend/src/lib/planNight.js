/**
 * WHETHER A LOCKED-IN PLAN'S NIGHT IS OVER.
 *
 * A plan reaches 'completed' two ways: the host slides "done" on the plan
 * screen, or services/flockSweep.js completes it 12 hours after its time. Most
 * hosts never slide, so most plans sit at 'confirmed' until the sweep, and the
 * plan screen used to ask "How was {venue}?" only once a plan was completed.
 * routes/feedback.js verifies a member's report only while the plan's time is
 * within 12 hours, which is the same 12 hours the sweep waits. So on the usual
 * path the question appeared just after the answer stopped counting, and the
 * Nest went on calling last night's plan "Locked In" all morning.
 *
 * An hour after the plan's time is the earliest a report says something about
 * the night rather than about the door. From then on the plan screen asks, and
 * the Nest says so, while a report still counts.
 *
 * Both readers use this one function (screens/FlockDetail.js and the Nest in
 * App.js) so the chip that says "How was it?" and the card it opens cannot
 * disagree about the hour. It lives in src/lib for the reason lib/billShares.js
 * gives: App.js can import it without pulling a screen into the boot chunk.
 */
import { nightsBetween } from './nestTime';

export const NIGHT_OVER_AFTER_MS = 60 * 60 * 1000;

/**
 * True for a confirmed plan whose time is at least an hour gone. Anything
 * else is false: a plan still being planned did not necessarily happen, an
 * ended plan is answered by its own status, and a plan with no readable time
 * has no night to be over.
 */
export const isNightOver = (flock, now = Date.now()) => {
  if (!flock || (flock.status !== 'confirmed' && flock.status !== 'locked')) return false;
  if (!flock.eventTime) return false;
  const at = new Date(flock.eventTime).getTime();
  if (!Number.isFinite(at)) return false;
  return now >= at + NIGHT_OVER_AFTER_MS;
};

/**
 * WHEN THE NEST ASKS "HOW WAS {VENUE}?" (2026-11-06): THE MORNING AFTER.
 *
 * The plan screen asks from an hour in (isNightOver), for whoever opens the
 * plan. The Nest is what a person sees on every open, and from an hour in
 * its biggest button asked how the night was while the reader was most
 * likely still out in it. A night is remembered by its peak and its end, so
 * the Nest leaves the peak alone and asks once the night has rolled over at
 * 4 AM (lib/nestTime.js, the hour the Tonight answer clears), all through
 * the next day, until the 4 AM after that.
 *
 * Finished plans count: the sweep completes a plan 12 hours after its time
 * (services/flockSweep.js), and the live list lets it go at that moment, so
 * for an 8:30 PM plan a row read from live plans alone would have lasted from
 * 4 AM to 8:30 AM. A plan nobody locked in, a cancelled one, and one with no
 * place never ask: there is no night, or nothing to rate.
 */
export const nestAsksHowItWas = (flock, now = new Date()) => {
  if (!flock || !flock.venueId || !flock.venue || flock.venue === 'TBD') return false;
  const n = now instanceof Date ? now : new Date(now);
  const ended = flock.status === 'completed' || isNightOver(flock, n.getTime());
  if (!ended) return false;
  return nightsBetween(flock.eventTime, n) === 1;
};
