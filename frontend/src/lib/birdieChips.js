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
 * Two, the first two that apply, with two rules on the second:
 *
 *   - after a crowd question, the second asks for a spot: the plan still
 *     choosing its place, or "Pick a spot for tonight". With a plan tonight
 *     the one suggestion used to be the crowd question, so asking for a spot
 *     meant tapping the field and typing, where it had been two taps;
 *   - never a second "Pick a spot" under a first one.
 *
 * Two is the most the Nest offers at once (a person with plans used to get
 * one); only the bill question from midnight to 4 AM; none while the day's
 * messages are spent: each one sends, and a send that cannot go through is a
 * dead button.
 *
 * Pure: `now` and the plans come in, the words go out.
 */
import { clockTime, nightsBetween } from './nestTime';

const CROWD_READ_HOURS = 12;
const asTime = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};
const hasPlace = (f) => !!f.venue && f.venue !== 'TBD';

const SPOT_TONIGHT = 'Pick a spot for tonight';
const BILL = 'How do I split a bill?';
const isSpot = (text) => /^Pick a spot for /.test(text);

export function birdieChips({ liveFlocks = [], now = new Date(), outOfChirps = false } = {}) {
  if (outOfChirps) return [];
  const n = now instanceof Date ? now : new Date(now);
  const nowMs = n.getTime();
  const hour = n.getHours();
  // From midnight to 4 AM the Nest does not suggest going out.
  if (hour < 4) return [BILL];
  const list = (Array.isArray(liveFlocks) ? liveFlocks : []).filter((f) => f && !f.timePassed);
  const out = [];
  const add = (text) => { if (text && !out.includes(text)) out.push(text); };

  // 1. A crowd read Birdie can actually give: a plan at a known place,
  //    starting within the next 12 hours.
  const soon = list
    .filter((f) => f.venueId && hasPlace(f))
    .map((f) => ({ f, at: asTime(f.eventTime) }))
    .filter(({ at }) => at != null && at > nowMs && at - nowMs <= CROWD_READ_HOURS * 3600 * 1000)
    .sort((a, b) => a.at - b.at)[0];
  // clockTime keeps 11:33 and PM together: the question wrapped at 390
  // with PM alone on its second line.
  const crowd = soon ? `How busy is ${soon.f.venue} at ${clockTime(new Date(soon.at))}?` : null;
  add(crowd);

  // 2. A plan tonight: when to leave for it.
  const tonight = list.some((f) => asTime(f.eventTime) != null && nightsBetween(n, f.eventTime) === 0);
  if (tonight) add('When should we head out?');

  // 3. A plan still choosing its place.
  const placeless = list.find((f) => !hasPlace(f));
  const placelessSpot = placeless ? `Pick a spot for ${placeless.name}` : null;
  add(placelessSpot);

  // 4. Nothing on tonight.
  if (!tonight) add(SPOT_TONIGHT);

  // 5. The evening's open question.
  if (hour >= 16) add("Where's poppin rn?");

  // 6. Always a question that is not about going out.
  add(BILL);

  const [first] = out;
  // After a crowd question, a spot: picking a place stays one tap away.
  if (first === crowd) return [first, placelessSpot || SPOT_TONIGHT];
  // Never a second "Pick a spot" under a first one.
  const second = out.slice(1).find((text) => !(isSpot(first) && isSpot(text)));
  return second ? [first, second] : [first];
}
