/**
 * WHETHER A LOCKED-IN PLAN'S NIGHT IS OVER.
 *
 * A plan reaches 'completed' two ways: the host slides "done" on the plan
 * screen, or services/flockSweep.js completes it 12 hours after its time. Most
 * hosts never slide, so most plans sit at 'confirmed' until the sweep, and the
 * plan screen used to ask "How was {venue}?" only once a plan was completed.
 * routes/feedback.js then verified a member's report only while the plan's
 * time was within 12 hours, the same 12 hours the sweep waits. So on the usual
 * path the question appeared just after the answer stopped counting, and the
 * Nest went on calling last night's plan "Locked in" all morning.
 *
 * An hour after the plan's time is the earliest a report says something about
 * the night rather than about the door. From then on the plan screen asks, and
 * the Nest says so. Since 2026-11-06 an answer from somebody who had said yes
 * by an hour after the plan began (the plan locked in, and one other member
 * in, by then too) counts until noon the day after the plan on the venue's
 * clock, never less than 12 hours from its start (routes/feedback.js, the
 * plan window), so the morning after still counts.
 *
 * Both readers use this one function (screens/FlockDetail.js and the Nest in
 * App.js) so the chip that says "How was it?" and the card it opens cannot
 * disagree about the hour. It lives in src/lib for the reason lib/billShares.js
 * gives: App.js can import it without pulling a screen into the boot chunk.
 */
import { nightsBetween, nightKey } from './nestTime';

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
 * WHEN A PLAN MEMBER'S ANSWER STOPS COUNTING, ON THIS PHONE'S CLOCK.
 *
 * routes/feedback.js counts a member's "How was it?" answer until noon on the
 * day after the plan's night, or 12 hours after the plan's start when that is
 * later (backend utils/planReportWindow.js planReportClosesAtMs, on the
 * venue's clock). A plan between midnight and 4 AM belongs to the night
 * before, so its noon can come before its 12 hours: a 1 AM plan counts until
 * 1 PM. Read here on the phone's clock, which for somebody who was at the
 * venue is the venue's. Epoch ms, or null for a time that cannot be read.
 */
export const HOW_WAS_IT_CLOSE_HOUR = 12;
export const HOW_WAS_IT_FLOOR_MS = 12 * 60 * 60 * 1000;

export const howWasItClosesAt = (eventTime) => {
  const night = nightKey(eventTime);
  if (!night) return null;
  const [y, m, d] = night.split('-').map(Number);
  const noonAfter = new Date(y, m - 1, d + 1, HOW_WAS_IT_CLOSE_HOUR).getTime();
  return Math.max(noonAfter, new Date(eventTime).getTime() + HOW_WAS_IT_FLOOR_MS);
};

/**
 * WHEN THE NEST ASKS "HOW WAS {VENUE}?" (2026-11-06): THE MORNING AFTER,
 * UNTIL THE ANSWER STOPS COUNTING.
 *
 * The plan screen asks from an hour in (isNightOver), for whoever opens the
 * plan. The Nest is what a person sees on every open, and from an hour in
 * its biggest button asked how the night was while the reader was most
 * likely still out in it. A night is remembered by its peak and its end, so
 * the Nest leaves the peak alone and asks once the night has rolled over at
 * 4 AM (lib/nestTime.js, the hour the Tonight answer clears), and stops when
 * the answer stops counting (howWasItClosesAt): noon for an evening plan.
 * It used to ask until the 4 AM after that, so for a 9 PM plan the row stood
 * for 16 hours after noon over an answer that could only be noted, the ask
 * after the answer stopped counting that the header of this file is about.
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
  if (nightsBetween(flock.eventTime, n) !== 1) return false;
  const closesAt = howWasItClosesAt(flock.eventTime);
  return closesAt != null && n.getTime() < closesAt;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * WHEN A PLAN'S ANSWERS STOPPED COUNTING, IN WORDS.
 *
 * An answer filed after the plan window gets back plan_window_closed and the
 * moment the window shut (plan_report_closes_at, an ISO instant), and the
 * plan screen's thanks names it: "noon today", "2 PM yesterday", "noon
 * Saturday", or a date once it is a week back. Read on this phone's clock,
 * which for someone who was at the venue is the venue's. Null for a moment
 * that cannot be read, so the caller falls back to its other sentence.
 */
export const reportWindowWords = (closesAt, now = new Date()) => {
  if (closesAt == null || closesAt === '') return null;
  const t = new Date(closesAt);
  if (!Number.isFinite(t.getTime())) return null;
  const n = now instanceof Date ? now : new Date(now);
  const h = t.getHours();
  const m = t.getMinutes();
  const time = h === 12 && m === 0
    ? 'noon'
    : `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysBack = Math.round((dayStart(n) - dayStart(t)) / DAY_MS);
  let day;
  if (daysBack === 0) day = 'today';
  else if (daysBack === 1) day = 'yesterday';
  else if (daysBack > 1 && daysBack < 7) day = t.toLocaleDateString('en-US', { weekday: 'long' });
  else day = t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${time} ${day}`;
};
