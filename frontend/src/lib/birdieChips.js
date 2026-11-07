/**
 * WHAT THE NEST OFFERS TO ASK BIRDIE (2026-11-06).
 *
 * A blank box asks a person to invent a question; a suggestion they can tap
 * is recognised instead of recalled. But each one has to be a question Birdie
 * can answer well right now, about the person's own plans where it can be, so
 * they come from the plans on the Nest and the hour, in this order:
 *
 *   1. "How busy is {venue} tonight?"  a plan at a known place starts
 *      within 12 hours: crowd reads reach about 12 hours out, so nothing
 *      further is offered. Said the way a person asks it, with the night
 *      ("tonight", "today", "tomorrow") and never the minute: "How busy is
 *      The Copper Finch at 11:33 PM?" read as a template filled in by a
 *      machine, and wrapped to two lines at 320 and 390. Short, so the
 *      seeded place's question fits one line at 390
 *   2. "When should we head out?"        a plan is tonight
 *   3. "Pick a spot for {plan}"          a live plan has no place yet
 *   4. "Pick a spot for tonight"         before midnight, nothing on tonight
 *   5. "Where's busy right now?"         4 PM to midnight
 *   6. "How do I split a bill?"          always last, and the only one from
 *                                         midnight to 4 AM: the Nest does not
 *                                         suggest going out after midnight
 *
 * One voice, sentence case: the evening question was "Where's poppin rn?",
 * slang beside the plain "Pick a spot for tonight" on the same page.
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
import { nightsBetween } from './nestTime';

const CROWD_READ_HOURS = 12;
const asTime = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};
const hasPlace = (f) => !!f.venue && f.venue !== 'TBD';

export const SPOT_TONIGHT = 'Pick a spot for tonight';
export const BILL = 'How do I split a bill?';
export const BUSY_NOW = "Where's busy right now?";
export const HEAD_OUT = 'When should we head out?';
const isSpot = (text) => /^Pick a spot for /.test(text);

/**
 * The night a plan within the crowd reads' 12 hours falls on, in a person's
 * words: "tonight" for the same night from 5 PM (and on past midnight),
 * "today" for earlier the same day, "tomorrow" for the next.
 */
function crowdWhen(at, now) {
  const nights = nightsBetween(now, new Date(at));
  if (nights === 1) return 'tomorrow';
  const h = new Date(at).getHours();
  return h >= 17 || h < 4 ? 'tonight' : 'today';
}

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
  const crowd = soon ? `How busy is ${soon.f.venue} ${crowdWhen(soon.at, n)}?` : null;
  add(crowd);

  // 2. A plan tonight: when to leave for it.
  const tonight = list.some((f) => asTime(f.eventTime) != null && nightsBetween(n, f.eventTime) === 0);
  if (tonight) add(HEAD_OUT);

  // 3. A plan still choosing its place.
  const placeless = list.find((f) => !hasPlace(f));
  const placelessSpot = placeless ? `Pick a spot for ${placeless.name}` : null;
  add(placelessSpot);

  // 4. Nothing on tonight.
  if (!tonight) add(SPOT_TONIGHT);

  // 5. The evening's open question.
  if (hour >= 16) add(BUSY_NOW);

  // 6. Always a question that is not about going out.
  add(BILL);

  const [first] = out;
  // After a crowd question, a spot: picking a place stays one tap away.
  if (first === crowd) return [first, placelessSpot || SPOT_TONIGHT];
  // Never a second "Pick a spot" under a first one.
  const second = out.slice(1).find((text) => !(isSpot(first) && isSpot(text)));
  return second ? [first, second] : [first];
}

/**
 * THE FULL CHAT'S SUGGESTIONS, one tap from the Nest (its Open the full chat
 * and Earlier in this chat both open it). Its four general questions, under
 * the Nest's own hour rule: from midnight to 4 AM only the bill question, so
 * the quiet the Nest keeps after midnight does not end one tap away. The
 * panel still hides them while the day's messages are spent.
 */
export function fullChatChips(now = new Date()) {
  const n = now instanceof Date ? now : new Date(now);
  if (!Number.isNaN(n.getTime()) && n.getHours() < 4) return [BILL];
  return [BUSY_NOW, SPOT_TONIGHT, HEAD_OUT, BILL];
}
