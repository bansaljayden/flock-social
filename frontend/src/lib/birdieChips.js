/**
 * WHAT THE NEST OFFERS TO ASK BIRDIE (2026-11-06).
 *
 * A blank box asks a person to invent a question; a suggestion they can tap
 * is recognised instead of recalled. But each one has to be a question Birdie
 * can answer well right now, about the person's own plans where it can be, so
 * they come from the plans on the Nest and the hour, in this order:
 *
 *   1. "How busy is {venue} at {time}?"  a plan at a known place starts within
 *      12 hours: crowd reads reach about 12 hours out, so nothing further is
 *      offered
 *   2. "When should we head out?"        a plan is tonight
 *   3. "Pick a spot for {plan}"          a live plan has no place yet
 *   4. "Pick a spot for tonight"         before midnight, nothing on tonight
 *   5. "Where's poppin rn?"              4 PM to midnight
 *   6. "How do I split a bill?"          always last, and the only one from
 *                                         midnight to 4 AM: the Nest does not
 *                                         suggest going out after midnight
 *
 * One for a person with plans, two on a first run (no plans at all), none
 * while the day's messages are spent: each one sends, and a send that cannot
 * go through is a dead button.
 *
 * Pure: `now` and the plans come in, the words go out.
 */
import { localeTime } from './localeFormat';
import { nightsBetween } from './nestTime';

const CROWD_READ_HOURS = 12;
const asTime = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};
const hasPlace = (f) => !!f.venue && f.venue !== 'TBD';

export function birdieChips({ liveFlocks = [], now = new Date(), outOfChirps = false, firstRun = false } = {}) {
  if (outOfChirps) return [];
  const n = now instanceof Date ? now : new Date(now);
  const nowMs = n.getTime();
  const hour = n.getHours();
  const afterMidnight = hour < 4;
  const want = firstRun ? 2 : 1;
  const list = (Array.isArray(liveFlocks) ? liveFlocks : []).filter((f) => f && !f.timePassed);
  const out = [];
  const add = (text) => { if (text && !out.includes(text)) out.push(text); };

  if (!afterMidnight) {
    // 1. A crowd read Birdie can actually give: a plan at a known place,
    //    starting within the next 12 hours.
    const soon = list
      .filter((f) => f.venueId && hasPlace(f))
      .map((f) => ({ f, at: asTime(f.eventTime) }))
      .filter(({ at }) => at != null && at > nowMs && at - nowMs <= CROWD_READ_HOURS * 3600 * 1000)
      .sort((a, b) => a.at - b.at)[0];
    if (soon) add(`How busy is ${soon.f.venue} at ${localeTime(new Date(soon.at), [], { hour: 'numeric', minute: '2-digit' })}?`);

    // 2. A plan tonight: when to leave for it.
    const tonight = list.some((f) => asTime(f.eventTime) != null && nightsBetween(n, f.eventTime) === 0);
    if (tonight) add('When should we head out?');

    // 3. A plan still choosing its place.
    const placeless = list.find((f) => !hasPlace(f));
    if (placeless) add(`Pick a spot for ${placeless.name}`);

    // 4. Nothing on tonight, and it is not past midnight.
    if (!tonight) add('Pick a spot for tonight');

    // 5. The evening's open question.
    if (hour >= 16) add("Where's poppin rn?");
  }

  // 6. Always a question that is not about going out.
  add('How do I split a bill?');
  return out.slice(0, afterMidnight ? 1 : want);
}
