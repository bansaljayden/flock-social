// ---------------------------------------------------------------------------
// The venue advisor's HTTP surface. Mounted at /api/venue/advisor (server.js).
//
// Two halves share this file:
//   GET  /cards      Layer B's deterministic insight cards (services/
//                    advisorFacts.js): the four T0 MVP cards from
//                    ADVISOR-PRODUCT-SHAPE.md §5, zero LLM, refusals as data.
//                    Shape: { cards: [{ id, title, facts, status }] }.
//   POST /ask        the chip layer: one suggested-question chip in, one
//                    grounded answer out.
//   POST /question   the typed layer (2026-08-20): one free-text question in,
//                    one of three labeled answers out. See below.
//   GET  /questions  the four chips this venue's data can answer, the rest
//                    grouped behind a disclosure, and whether the typed field
//                    is on for this deploy.
//
// THE CHAT CONTRACT, as it now stands. The original build was chips ONLY, and
// that was the right first shape: with no user text anywhere, the one-way
// valve was airtight by construction. It was reopened on 2026-08-20, to this
// brief: the venue can ask any question about its business and how it can
// promote, drive, or have better business. That is the T2 tier
// ADVISOR-PRODUCT-SHAPE.md already designed, brought forward by decision, and
// it lives at POST /question with refusal as its default route.
//
// /ask DID NOT CHANGE, and its shape refusal is not legacy. It still accepts
// an intentId from the closed registry and NOTHING else, answering 400 to any
// body carrying prose before a value is read. Free text got its own door
// rather than a new field on this one, because the chip path's guarantee is
// worth keeping intact and because the typed path needs its own rate limiter,
// its own daily ceiling, and its own flag.
//
// FLAGS, BOTH DEFAULT ON since 2026-08-20. ADVISOR_PHRASING_ENABLED decides
// WORDING on the chip path: off means the deterministic template twin serves,
// carrying every number, so chips still work with zero LLM calls.
// ADVISOR_FREETEXT_ENABLED is separate, because free text is not a wording
// choice: there is no template that answers a question nobody wrote a template
// for, so with that flag off (or the model unreachable) the endpoint declines
// in plain words rather than half working, and /questions reports freeText
// false so the client can say so where the field is instead of hiding it.
// Both shipped default OFF and both stayed dark on every deploy, which is how
// a built, tested, documented feature reached its owner as an absence.
//
// GATES, in order: authenticate, then requireVenueTier('pro') (grounding doc
// section 5: Pro is the advisor's home; with VENUE_BILLING_ENABLED unset the
// gate is a no-op and every claimed venue sees it, the correct pilot
// posture). ADVISOR_PHRASING_ENABLED then decides only WORDING: off means the
// deterministic template twin serves, so this surface still works with zero
// LLM calls if the flag is ever turned back off.
//
// NO WRITE PATH, by design and by test. The advisor reads; it cannot post
// promotions, edit the profile, or touch the slider. An advisor that can act
// is a different and unapproved product (grounding doc, section 5).
// ---------------------------------------------------------------------------

const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requireVenueTier, getVenueTier, venueBillingEnabled } = require('../services/venueEntitlements');
const advisorPhrasing = require('../services/advisorPhrasing');
const advisorFreeText = require('../services/advisorFreeText');
const { followUpsFor, ANOTHER_MOVE } = require('../services/advisorFollowUps');
const advisorFollowOn = require('../services/advisorFollowOn');
const roostPlaybook = require('../services/roostPlaybook');
const roostDayReader = require('../services/roostDayReader');
const advisorMoneyMove = require('../services/advisorMoneyMove');
const { BULLET, MAX_POINTS } = require('../services/advisorAnswer');
const {
  KIND_FORECAST, isKindForecast, besideCard, besideWeek,
} = require('../services/kindForecast');

// THE TWIN GETS ONE MOVE (2026-10-28). A phrased answer makes a money move a
// point when the facts point at one (advisorPrompt, the venue's own numbers
// contract). The template twin only ever read the facts back, so on a day the
// model was out the quiet-days chip named Tuesday and stopped. For the chips
// whose facts always raise the same kind of move, the twin now ends on the
// playbook's best one for that venue, and the sources line names the
// playbook. Only when the answer has room for it, and never on a refusal.
// Which chips end on a move, and which move, live in services/roostPlaybook.js
// (moveFor), because the phrasing model is handed the same move to build on.

async function venueContextFor(userId, ctx) {
  if (ctx) return ctx;
  if (!advisorFacts || typeof advisorFacts.getVenueContext !== 'function') return null;
  try {
    return await advisorFacts.getVenueContext(userId);
  } catch (err) {
    return null;
  }
}

// The playbook move a chip answer ends on: the template twin appends it
// (withMove below) and the phrasing model is handed it (advisorPhrasing.phrase).
// Reported with the answer so the chat can send it back with a "what else",
// and that answer sets it aside (services/advisorFollowOn.js).
function chipTactics(answer, intentId, block) {
  if (!answer || answer.mode === 'refusal') return [];
  const move = roostPlaybook.moveFor(intentId, block, block && block.venue ? block.venue : null);
  if (!move) return [];
  // A template with no room left gets no move appended (withMove), and a
  // move the owner never saw must not be set aside by their "what else"
  // (2026-10-28 review). The phrasing model was handed it, so a phrased
  // answer counts it as given. Beside a no-history venue's card the move
  // was shown pointed at the day it named (moveText).
  if (answer.mode === 'template' && !String(answer.text || '').includes(moveText(move.move, block))) return [];
  return [move.id];
}

// A playbook move as a chip's template shows it: in the playbook's own words,
// or, beside a no-history venue's Week Ahead card, naming the quiet day the
// answer named instead of "your slowest day" (services/kindForecast.js
// besideCard, which the Monday email's money move reads too).
function moveText(text, block) {
  return besideCard(text, block && block.facts);
}

// What the chat sends back as `previous` with the owner's next typed
// question: the question this answer actually answered, its intent, and every
// move given so far in the run, so a second "what else" sets aside the first
// answer's move too. Null for an answer there is nothing to follow on from.
function followContext(answer, question, intentId, tactics, earlier = []) {
  if (!answer || answer.mode === 'refusal' || answer.mode === 'small_talk') return null;
  return {
    question,
    intentId: intentId || null,
    tactics: [...new Set([...earlier, ...tactics])].slice(-advisorFollowOn.MAX_PREVIOUS_TACTICS),
  };
}

async function withMove(answer, intentId, userId, ctx = null, block = null) {
  if (!answer || answer.mode !== 'template' || !roostPlaybook.MOVE_INTENTS.has(intentId)) return answer;
  const points = String(answer.text || '').split('\n').length - 1;
  if (points >= MAX_POINTS) return answer;
  // The fact bridge hands over the venue and its spend; a block from
  // anywhere else costs one lookup.
  let venue = block && block.venue ? block.venue : null;
  let spend = block && block.venue ? block.spend : null;
  let spendAsOf = block && block.spendAsOf ? block.spendAsOf : 'owner-set';
  if (!venue) {
    const venueCtx = await venueContextFor(userId, ctx);
    venue = roostPlaybook.venueOf(venueCtx);
    spend = roostPlaybook.spendOf(venueCtx);
    const p = (venueCtx && venueCtx.profile) || {};
    spendAsOf = p.updated_at ? `owner-set ${String(p.updated_at).slice(0, 10)}` : 'owner-set';
  }
  let lines;
  let sources;
  if (intentId === 'money_move') {
    // The move and what it is worth, the same two lines the Monday email
    // lists under the day (services/advisorMoneyMove.js).
    ({ lines, sources } = advisorMoneyMove.extras({ block, venue, spend, spendAsOf }));
    if (!lines.length) return answer;
  } else {
    const tactic = roostPlaybook.moveFor(intentId, block, venue);
    if (!tactic) return answer;
    lines = [tactic.move];
    sources = [{ ...roostPlaybook.PLAYBOOK_SOURCE }];
  }
  const room = MAX_POINTS - points;
  return {
    ...answer,
    text: [answer.text, ...lines.slice(0, room).map((l) => `${BULLET}${moveText(l, block)}`)].join('\n'),
    sources: [...(answer.sources || []), ...sources],
  };
}
// The measured floor below which an ordering claim is not made. Commit
// 1d1b92b established it for HOURS, on the same 0 to 100 index these day
// scores live on. Imported rather than restated: a second copy of a measured
// number is a number that will drift away from its measurement.
const { HOUR_ORDERING_MIN_GAP } = require('../services/crowdEngine');

const router = express.Router();

// The feature's user-facing name (product decision 2026-08-19). Backend
// identifiers and the route path stay 'advisor'; owner-visible copy says Roost.
const FEATURE_NAME = 'Roost';
// Every route here, /cards included, is Roost, and 'pro' is its stored name
// (VENUE-PRICING.md section 4: a free venue account and Roost, nothing
// between). The cards used to sit one rung lower, on a $35 plan retired
// before it was sold, with around_you as that plan's taste of the product.
const requirePro = requireVenueTier('pro');

// Layer B seam. The contract consumed here: a fact block
// { intent, facts: [{ id, value, source, asOf }], refusals: [] }, with
// refusing as a first-class output. Fact computation is NEVER duplicated in
// this file; the fact engine has exactly one home (services/advisorFacts.js),
// and /ask reaches it through the bridge below. Should the engine itself ever
// be absent from a build, /ask answers 503 in plain words.
let advisorFacts = null;
try {
  // eslint-disable-next-line global-require
  advisorFacts = require('../services/advisorFacts');
} catch (err) {
  advisorFacts = null;
}

// The verdict builder lives beside the fact engine rather than inside it: it is
// the one Roost answer that reads no forecast, no corpus and no model, only the
// venue's own readings, our own serve log and the recorded conditions of the
// day. Same lazy require and same fail-soft posture, so a build without it
// loses one card and one chip instead of the whole surface.
let lastNightVerdict = null;
try {
  // eslint-disable-next-line global-require
  lastNightVerdict = require('../services/lastNightVerdict');
} catch (err) {
  lastNightVerdict = null;
}

// ── The intent -> facts bridge for /ask ──────────────────────────────────────
// If the fact engine ever grows a native buildFactBlock(userId, intentId),
// it wins outright. Until then, each chat intent is a composition of the SAME
// card builders /cards serves, so the chat can never say something the cards
// would not: one fact engine, two renderings.
//
// Entries from the builders mix facts and refusals. When at least one real
// fact exists, the partial refusals are dropped and the facts answer; when
// none does, the refusals ARE the answer, reason and unlock path joined.
function refusalText(r) {
  return [r.reason, r.whatWouldUnlock].filter(Boolean).join(' ');
}

// The trailing YYYY-MM-DD every dated builder id carries (peak_, refuse_peak_,
// event_, weather_, owner_reading_, served_).
const ID_DATE = /(\d{4}-\d{2}-\d{2})$/;
function entryDate(entry) {
  const m = entry && typeof entry.id === 'string' ? entry.id.match(ID_DATE) : null;
  return m ? m[1] : null;
}
// THIS WEEKEND IS THE ONE IN PROGRESS OR THE NEXT ONE (2026-11-06): on a
// Friday, Saturday or Sunday, today through Sunday; on Monday to Thursday, the
// coming Friday to Sunday. Never a day of the week after. Every Friday,
// Saturday and Sunday in the week read used to count, and that week runs
// seven days, so on a Saturday the venue's own week held next Friday, and on
// a Sunday next Friday and Saturday. A no-history venue's card starts
// tomorrow, so on its Saturday "the busiest day this weekend is Friday" meant
// next Friday, said with today's Saturday left out. `today` is the venue's
// own today (daysFromToday below), and both are its own dates.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const addDaysTo = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// A weekend's first and last dates, counted from the venue's `today`: this
// one ('this'), or the one after it ('next', 2026-11-06: "What does next
// weekend look like?" answered about this one).
function weekendWindow(today, scope = 'this') {
  const sunday = addDaysTo(today, (7 - weekdayOf(today)) % 7);
  if (scope === 'next') return { from: addDaysTo(sunday, 5), to: addDaysTo(sunday, 7) };
  return { from: [5, 6, 0].includes(weekdayOf(today)) ? today : addDaysTo(sunday, -2), to: sunday };
}
function inWeekend(date, today, scope = 'this') {
  if (!ISO_DATE.test(String(date)) || !ISO_DATE.test(String(today))) return false;
  const { from, to } = weekendWindow(today, scope);
  return date >= from && date <= to;
}

// THE DAYS FROM TODAY, AND WHICH DAY TODAY IS. The venue's own week walks
// seven days from its own today (advisorFacts.buildWeekAhead), so its first
// dated entry is today, the same contract tonight_outlook reads. A venue with
// no crowd history is answered from its dashboard card, whose week starts
// tomorrow: today is the card's own entry, read on today's hours, and the card
// dates today even when its listing has the venue shut. The week, today and
// the date all come off the block's one read of the card (b.card(),
// advisorFacts.buildCardProjection), never off two. `card` says which of the
// two kinds of week it was.
//
// TODAY IS THE NIGHT STILL RUNNING (review, 2026-11-06). At 12:30 AM on a
// Sunday, with Saturday night still going, the today chip answered Saturday
// night and the weekend said the venue's curve showed no activity for the
// rest of it. A venue's own week is read from the night in progress
// (b.tonight, buildWeekAhead's nightInProgress), the week the today chip
// reads, so its today is that night. The card dates today by the calendar,
// and says when its listing has last night still running (`nightInProgress`),
// so a shut today is said as shut after tonight (advisorFacts
// .todayClosedFact).
const gatedVenue = (b) => Boolean(b.ctx && b.ctx.profile && advisorFacts.corpusGate(b.ctx.profile));
// The days from today on the card, the dates its listed hours have the venue
// shut, whether last night is still running on them, and when the card was
// built.
const fromCard = (card, week) => ({
  days: [...card.today, ...week],
  today: card.date,
  closed: Array.isArray(card.closed) ? card.closed : [],
  nightInProgress: card.nightInProgress === true,
  asOf: card.asOf || null,
  card: true,
});
async function daysFromToday(b) {
  if (gatedVenue(b) && typeof b.card === 'function') {
    const card = await b.card();
    if (card.week.length) return fromCard(card, card.week);
    // No card to read: the venue's own week, which is the corpus refusal.
    return { days: typeof b.ownWeek === 'function' ? await b.ownWeek() : [], today: null, closed: [], asOf: null, card: false };
  }
  // A venue with crowd history: its own week from the night in progress.
  const own = Boolean(b.ctx) && typeof b.tonight === 'function';
  const week = await (own ? b.tonight() : b.week());
  if (week.some(isKindForecast)) {
    // A builder handed the card's week with no venue on it (a plan driven
    // directly): today and its date off the read it hands over. One that
    // cannot read the card's today has no today to count the weekend from,
    // and the weekend then holds nothing rather than a guess.
    return fromCard(typeof b.card === 'function' ? await b.card() : { today: [], date: null }, week);
  }
  return { days: week, today: week.map(entryDate).find(Boolean) || null, closed: [], asOf: null, card: false };
}

// Today's shut-day fact, or null: the card's listed hours have the venue shut
// on its today (off the block's one read of the card), said as shut after
// tonight while last night is still running on them, or the night ahead in
// the venue's own week, from the night in progress, is a day its curve shows
// no hours of its own on.
async function shutToday(b, tonight) {
  const asOf = (b.now || new Date()).toISOString();
  if (gatedVenue(b) && typeof b.card === 'function') {
    const card = await b.card();
    if (!ISO_DATE.test(String(card.date)) || !(card.closed || []).includes(card.date)) return null;
    return advisorFacts.todayClosedFact({
      listing: true, date: card.date, asOf: card.asOf || asOf, afterTonight: card.nightInProgress === true,
    });
  }
  const night = tonight[0];
  if (!advisorFacts.isShutDay(night)) return null;
  return advisorFacts.todayClosedFact({ listing: false, date: entryDate(night), asOf });
}

// One plan per chip: which builder outputs, filtered how. Filtering and
// ordering existing facts is composition; no plan computes a number the fact
// engine did not already construct. Builders are memoised per request because
// several plans read the same card.
const INTENT_PLANS = {
  // The week-ahead builder walks days in order from the venue's own today, so
  // its first entry (fact or refusal) IS tonight. Street facts for the same
  // date ride along.
  // ONE FACT IS NOT AN OUTLOOK. This plan used to hand over today's peak plus
  // whatever street facts carried today's exact date, and on most days that is
  // the peak alone: the weather feed starts at tomorrow, and the events fact
  // for a quiet street is `no_listed_events`, which carries no date at all and
  // so was filtered out by the very filter meant to keep other days out. The
  // owner asked how today looks and read one sentence, sitting under a screen
  // of cards that each carry three. Undated street facts are about the street
  // NOW and belong here; dated ones are still held to today.
  tonight_outlook: async (b) => {
    // In the small hours, tonight is the night still running
    // (advisorFacts.buildWeekAhead, nightInProgress).
    const week = await (b.tonight ? b.tonight() : b.week());
    const tonight = week.slice(0, 1);
    // TODAY SHUT IS SAID PLAINLY (2026-11-06; advisorFacts.todayClosedFact):
    // by the listing's hours on the card for a venue answered from it, by its
    // own curve otherwise, and nothing beside it, since a street line under a
    // shut day used to stand in for the answer.
    const shut = await shutToday(b, tonight);
    if (shut) return [shut];
    const date = tonight.length ? entryDate(tonight[0]) : null;
    const around = await b.around();
    const street = around.filter((e) => {
      const d = entryDate(e);
      return d === null || d === date;
    });
    return [...tonight, ...street];
  },
  peak_hours: (b) => b.week(),
  // A REFUSAL CARRIES NO DATE, so a date filter deletes it. An out-of-corpus
  // cafe asking how Friday looks got the generic "nothing we track at your
  // venue grounds it so far", while the same venue asking about its peaks got
  // the real corpus refusal naming what is missing and how to fill it in: the
  // corpus gate's refusal has no day attached, so this filter dropped it and
  // the block arrived empty. Undated entries are kept when they are refusals,
  // which is the only kind of undated entry the week builder emits.
  // The weekend is this one (inWeekend above), read from today: for a
  // venue with no crowd history, today's entry on its card first when today
  // is a Friday, Saturday or Sunday, then the card's days, so the template
  // and the phrasing model are handed the same days and neither can name
  // next week's Friday.
  //
  // NEXT WEEKEND, AND A WEEKEND WITH NOTHING OPEN (review, 2026-11-06). "What
  // does next weekend look like?" is next weekend: the days of it the seven
  // days of the forecast hold, each marked as next weekend's
  // (advisorFacts.nextWeekendDay), or a plain refusal when they hold none.
  // From Monday to Thursday an owner means the coming weekend by it, and the
  // one after is past the forecast, so it is answered about the coming
  // weekend, each day marked with its dates (advisorFacts.comingWeekendDay):
  // "the coming weekend, Nov 13 to 15". "The following weekend" and "the
  // weekend after this" are the one after this one on any day.
  // When every day left of this weekend is shut, by the listing's hours on
  // the card or the venue's own curve, the answer says so
  // (advisorFacts.weekendClosedFact) and goes on to next weekend if the
  // forecast holds any of it. A weekend with no open day for another reason
  // answers with its own refusals: street facts alone are not a weekend's
  // forecast, and one weather line used to hide every refusal under it.
  weekend_outlook: async (b) => {
    const { days, today, card, closed, nightInProgress, asOf } = await daysFromToday(b);
    const keep = (scope) => (e) => {
      const d = entryDate(e);
      if (d === null) return advisorFacts.isRefusal(e);
      return inWeekend(d, today, scope);
    };
    // Around-you weather facts are Fridays to Sundays already; keep dated
    // street entries that fall on the weekend asked about, plus the
    // no-events line if present.
    const street = async (scope) => (await b.around()).filter((e) => {
      const d = entryDate(e);
      return (d !== null && inWeekend(d, today, scope)) || e.id === 'no_listed_events';
    });
    const open = (entries) => entries.filter((e) => !advisorFacts.isRefusal(e));
    // Next weekend's dated entries, marked as next weekend's; an undated line
    // ("no listed events") is about the whole week and keeps its words.
    const asNext = (entries) => entries.map((e) => (advisorFacts.isRefusal(e) || entryDate(e) === null ? e : advisorFacts.nextWeekendDay(e)));
    // A card with no today to count from, or no card: its refusals, as before.
    if (!today) return days.filter(keep('this'));
    const midweek = [1, 2, 3, 4].includes(weekdayOf(today));
    const asked = b.weekendScope || 'this';
    let scope = asked;
    if (asked === 'next_words') scope = midweek ? 'coming' : 'next';
    // The weekend's dates that the seven days from today hold, and whether
    // the venue is shut on every one of them.
    const held = (s) => {
      const { from, to } = weekendWindow(today, s);
      const last = addDaysTo(today, 6);
      const out = [];
      for (let d = from; d <= to && d <= last; d = addDaysTo(d, 1)) out.push(d);
      return out;
    };
    const shut = (date) => closed.includes(date) || days.some((e) => entryDate(e) === date && advisorFacts.isShutDay(e));
    const stamp = asOf || (b.now || new Date()).toISOString();
    const named = (dates) => dates.map((d) => WEEKDAY_NAMES_LONG[weekdayOf(d)]);
    const shutFact = (s, dates, range = null) => advisorFacts.weekendClosedFact({
      listing: card,
      scope: s,
      todayIn: dates.includes(today),
      // Last night still running on the listing: open now, shut after it.
      afterTonight: nightInProgress === true && dates.includes(today),
      weekdays: named(dates),
      range,
      from: dates[0],
      through: dates[dates.length - 1],
      asOf: stamp,
    });
    // Next weekend's days the seven days do not reach, said after an answer
    // about next weekend ("Next Saturday and Sunday are past the seven days the
    // forecast covers."), so a lone next Friday is not read as the weekend.
    const pastNext = () => {
      const { from, to } = weekendWindow(today, 'next');
      const last = addDaysTo(today, 6);
      const dates = [];
      for (let d = from; d <= to; d = addDaysTo(d, 1)) if (d > last) dates.push(d);
      return dates.length
        ? [advisorFacts.pastForecastFact({ card, weekdays: named(dates), from: dates[0], through: dates[dates.length - 1], asOf: stamp })]
        : [];
    };
    // A street line on a day the venue is shut says nothing about its weekend.
    const streetOpen = async (s) => (await street(s)).filter((e) => entryDate(e) === null || !shut(entryDate(e)));
    if (scope === 'after_next' || (scope === 'next' && !held('next').length)) {
      // From Monday to Thursday "the weekend after next" is the one after the
      // coming weekend, whose Friday comes into the seven days this Saturday.
      const soon = scope === 'next' || midweek;
      return [advisorFacts.makeRefusal({
        id: 'refuse_weekend_past_forecast',
        reason: `${scope === 'next' ? 'Next weekend' : 'The weekend after next'} is past the seven days the forecast covers.`,
        whatWouldUnlock: soon ? 'Its Friday comes into them on Saturday.' : 'Its Friday comes into them the Saturday before it.',
      })];
    }
    if (scope === 'next') {
      const next = days.filter(keep('next'));
      if (open(next).length) return [...asNext(next), ...pastNext(), ...asNext(await streetOpen('next'))];
      return held('next').every(shut) ? [shutFact('next', held('next')), ...pastNext()] : next;
    }
    let week = days.filter(keep('this'));
    if (scope === 'coming') {
      // The coming weekend, asked about as next weekend: this weekend's days,
      // each marked with the weekend's dates. The weekend after it is past
      // the forecast from Monday to Thursday, so a shut one ends there.
      const { from, to } = weekendWindow(today, 'this');
      const range = advisorFacts.weekendRangeWords(from, to);
      const asComing = (entries) => entries.map((e) => (advisorFacts.isRefusal(e) || entryDate(e) === null ? e : advisorFacts.comingWeekendDay(e, range)));
      if (open(week).length) return [...asComing(week), ...(await streetOpen('this'))];
      if (held('this').length && held('this').every(shut)) return [shutFact('coming', held('this'), range)];
    } else {
      if (open(week).length) return [...week, ...(await streetOpen('this'))];
      if (held('this').length && held('this').every(shut)) {
        const next = open(days.filter(keep('next')));
        return [shutFact('this', held('this')), ...(next.length ? [...asNext(next), ...pastNext(), ...asNext(await streetOpen('next'))] : [])];
      }
    }
    // No day of this weekend to read for another reason: a card's says why
    // through the venue's own week, as today's chip does (tonightFor).
    if (card && typeof b.ownWeek === 'function') week = (await b.ownWeek()).filter(keep('this'));
    return week;
  },
  // The two quietest projected evenings: an ordering of existing peak facts,
  // lowest first. Refused days cannot be ranked and are left out unless
  // nothing at all was scored.
  // THE FACTS MUST SAY WHICH END OF THE WEEK THEY ARE. These are peak facts,
  // shaped exactly like the ones tonight_outlook and weekend_outlook hand over,
  // and the only thing that made them the QUIET days was the sort above. Asked
  // "which nights are quiet for us", the phrasing model received two ordinary
  // peak facts and wrote "the forecast estimates your busier stretches on
  // Friday and Saturday", which is the opposite of the question and reads as a
  // confident answer. A note is the block's own channel for exactly this (the
  // system prompt, section 2d: a note is a fact about the fact), so the sort
  // now travels with the facts instead of being lost the moment they leave.
  // Copied rather than mutated: the builders are memoised per request and the
  // same peak fact is served to other plans in the same breath.
  //
  // A FLAT WEEK HAS NO QUIET NIGHT, AND MUST SAY SO. Sorting always returns a
  // first element, so this chip named one whatever the spread was: a week
  // projecting 85, 88, 85, 89, 89, 90, 89 came back calling Saturday the
  // quietest at 85, which is five points off the busiest day of the same week
  // and inside the noise. Commit 3782777 refused to name a strongest DAY when
  // the Google curve was level, and 1d1b92b's HOUR_ORDERING_MIN_GAP is the
  // MEASURED floor for exactly this claim: below a ten point gap on the 0 to
  // 100 index, an ordering is not supported by the numbers underneath it.
  // Days are scored on that same index by the same model, so the same floor
  // applies. Naming one of seven near-identical days is naming noise, and it
  // reads as advice: an owner told Saturday is their quiet night may staff it
  // differently on a week where Saturday is not.
  //
  // The refusal is a REFUSAL rather than a quiet fallback to the whole week,
  // because "which days look quiet" has a real answer here and the answer is
  // none of them. It names the floor, the way every other refusal in this
  // product names what it would take.
  quiet_nights: async (b) => {
    const week = await b.week();
    const scored = week
      .filter((e) => !advisorFacts.isRefusal(e) && e.value && Number.isFinite(Number(e.value.peakScore)))
      .sort((a, z) => Number(a.value.peakScore) - Number(z.value.peakScore));
    if (!scored.length) return week;
    const spread = Number(scored[scored.length - 1].value.peakScore) - Number(scored[0].value.peakScore);
    if (spread < HOUR_ORDERING_MIN_GAP) {
      // A level week of Flock's forecast for places like this venue says
      // whose week it is, and what would give the venue a week of its own
      // (2026-11-03 review: the spread of a category prior read as the
      // venue's own).
      const card = scored.some(isKindForecast);
      return [advisorFacts.makeRefusal({
        id: 'refuse_quiet_nights_flat_week',
        reason: card
          ? `In ${KIND_FORECAST}, no day stands out as quiet in the week ahead: every day projects within ${spread} points of every other on our 0 to 100 index, and we do not name a quietest day inside ${HOUR_ORDERING_MIN_GAP} points because the ordering under that is noise.`
          : `No day stands out as quiet in the week ahead. Every day projects within ${spread} points of every other on our 0 to 100 index, and we do not name a quietest day inside ${HOUR_ORDERING_MIN_GAP} points because the ordering under that is noise.`,
        whatWouldUnlock: card
          ? ((b.ctx && advisorFacts.corpusGate(b.ctx.profile)) || {}).whatWouldUnlock
            || 'Your own slider readings build history for your venue that does not depend on the corpus.'
          : 'A week whose days actually separate. The moment one does, this names it.',
      })];
    }
    const quietest = scored.slice(0, 2);
    // Flock's forecast for places like this venue is the quiet end of that
    // forecast's week, not of the venue's own (advisorFacts.buildWeekProjection).
    const whose = (e) => (isKindForecast(e) ? 'the week Flock forecasts for places like this one' : 'this venue\'s week');
    return quietest.map((e, i) => ({
      ...e,
      note: [
        e.note,
        i === 0
          ? `This is the LOWEST projected day in the week ahead. It is the quiet end of ${whose(e)}, not a busy day.`
          : `This is the second lowest projected day in the week ahead. It is the quiet end of ${whose(e)}, not a busy day.`,
      ].filter(Boolean).join(' '),
    }));
  },
  // "What is our best money move this week?" The quiet end of the week is the
  // room with the most seats to sell, so the plan hands over the lowest
  // projected day and, for contrast, the highest. A level week is not
  // refused here the way quiet_nights refuses it: the question still has an
  // answer, which is that the money is in each check rather than in one day,
  // and advisorPhrasing's shaper says so from the same two facts. Selection
  // only, like every plan here.
  money_move: async (b) => advisorMoneyMove.pickFacts(await b.week(), advisorFacts.isRefusal),
  // "How did we just do." The most-asked question in the category, and the one
  // chip that returns a VERDICT rather than a row of numbers: the venue's own
  // highest reading yesterday, against its own recent same-weekday readings,
  // against what Flock published, with the day's recorded conditions stated
  // last and never blamed. It is its own builder rather than a composition,
  // because a verdict is arithmetic and arithmetic belongs in a fact engine,
  // not in a route plan. services/lastNightVerdict.js carries the threshold
  // and the reason it is 15 points and not 3.
  last_night_verdict: (b) => b.verdict(),
  // "Was it just us, or was everyone slow." The cohort pair, and the one
  // question class here that a single-tenant tool structurally cannot take.
  //
  // The refusal filter is the load-bearing line. /ask drops partial refusals
  // whenever any fact answered, which is right everywhere else and wrong here:
  // the same-night builder always emits the venue's OWN reading as a fact, and
  // "your highest reading was 20" is not an answer to a question about the
  // street. So when the density floor refuses, the refusal is the whole
  // answer, and the sentence that names the floor reaches the owner instead of
  // being swallowed as a partial. The card keeps both.
  cohort_same_night: async (b) => {
    const entries = await b.cohortNight();
    const refusals = entries.filter((e) => advisorFacts.isRefusal(e));
    return refusals.length ? refusals : entries;
  },
  cohort_typical: (b) => b.cohortTypical(),
  week_recap: (b) => b.readings(),
  // The why-layer's differencing shape: the venue's own reading on the slow
  // day and what was served against it, next to the street's conditions.
  // Never a cause.
  //
  // IT USED TO HAND OVER BOTH BUILDERS WHOLE, and the template twin printed
  // fourteen lines: seven daily readings, a served estimate, three weather
  // days, the anchors fact, the anchors-we-cannot-watch fact and the events
  // line. Every other template here runs two to four. Worse than the length,
  // most of it was about the wrong day. The weather feed starts at tomorrow
  // (see tonight_outlook), so a question about a slow day LAST week came back
  // carrying next weekend's forecast, and six of the seven readings were the
  // days that were not slow.
  //
  // So the plan SELECTS rather than dumps, and selecting is all it does: no
  // number is computed here, because arithmetic belongs in the fact engine and
  // not in a route plan (see last_night_verdict). The lowest reading is the
  // slow day by definition, it travels with a note saying which end of the
  // window it came from exactly as quiet_nights' facts do, and the street
  // facts are held to that same day by the filter tonight_outlook already
  // uses: undated street context is about the street itself and stays, dated
  // context for some other day goes.
  slow_night: async (b) => {
    const entries = await b.readings();
    const readings = entries.filter((e) => !advisorFacts.isRefusal(e) && e.id.startsWith('owner_reading_')
      && e.value && Number.isFinite(Number(e.value.peakReading)));
    if (!readings.length) return entries;
    const slowest = readings.reduce((lo, e) => (
      Number(e.value.peakReading) < Number(lo.value.peakReading) ? e : lo
    ));
    const date = entryDate(slowest);
    // Copied rather than mutated: the builders are memoised per request and
    // the same reading fact is served to other plans in the same breath.
    const slowDay = {
      ...slowest,
      note: [
        slowest.note,
        `This is the LOWEST of the ${readings.length} days you posted a reading on in this window. It is the slow day the question is about.`,
      ].filter(Boolean).join(' '),
    };
    const sameDay = entries.filter((e) => e !== slowest && entryDate(e) === date);
    const street = (await b.around()).filter((e) => {
      const d = entryDate(e);
      return d === null || d === date;
    });
    return [slowDay, ...sameDay, ...street];
  },
  // Days where a reading and a served estimate can actually be set side by
  // side; when none pair up, everything serves and the refusals speak.
  readings_vs_estimates: async (b) => {
    const entries = await b.readings();
    const facts = entries.filter((e) => !advisorFacts.isRefusal(e));
    const readingDates = new Set(facts.filter((e) => e.id.startsWith('owner_reading_')).map(entryDate));
    const servedDates = new Set(facts.filter((e) => e.id.startsWith('served_')).map(entryDate));
    const paired = [...readingDates].filter((d) => servedDates.has(d));
    // NO PAIRED DAY MEANS NO COMPARISON EXISTS, and returning the readings on
    // their own let the answer read like one. A live answer to "how do my
    // readings compare to what you showed people" came back as a list of six
    // readings and never mentioned that the other side of the comparison was
    // absent, which is a half answer wearing a whole answer's clothes. The
    // honest output is a refusal that names which half is missing, and the
    // unlock path is the readings themselves, which is what pairs the days.
    if (!paired.length) {
      return [advisorFacts.makeRefusal({
        id: 'refuse_readings_vs_estimates',
        reason: readingDates.size
          ? 'We have your own readings, but not one of those days is a day Flock also served a score for your venue, so there is nothing to hold them against.'
          : 'This needs both sides: your own readings for a day, and what Flock served people who looked you up that same day. We have neither yet.',
        whatWouldUnlock: 'Post a reading on a day people are looking your venue up in Flock. The comparison fills in the first time both land on the same day.',
      })];
    }
    return facts.filter((e) => paired.includes(entryDate(e)));
  },
  kitchen_vs_peak: async (b) => (await b.listing()).filter((e) => /kitchen/.test(e.id)),
  capacity_math: async (b) => (await b.listing()).filter((e) => /capacity/.test(e.id)),
  busy_nights_check: async (b) => (await b.listing()).filter((e) => /busy_/.test(e.id)),
  around_you: (b) => b.around(),
  // The table pair. tables_service answers the staffing questions ("how long
  // do tables sit on Fridays", "do we need another server Saturday") from the
  // venue's own table unit; tables_free is the record of how often a table
  // was free at an hour over past weeks. Both SELECT from one builder and
  // compute nothing here. Neither is a cause: a slow Friday is shown next to
  // its turn and wait figures, and the owner draws the conclusion.
  tables_service: async (b) => (await b.tables())
    .filter((e) => advisorFacts.isRefusal(e) || !/^tables_(rarely|usually)_free$/.test(e.id)),
  tables_free: async (b) => {
    const entries = await b.tables();
    const picked = entries.filter((e) => /^(tables_(rarely|usually)_free|refuse_table_free_forecast|refuse_no_table_history|refuse_table_read_failed)$/.test(e.id));
    return picked.length ? picked : entries;
  },
  // The corpus explainer: the gate refusal IS the honest answer for the modal
  // case, and it already names the unlock path. In the corpus, the profile's
  // own corpus columns are the fact.
  data_status: async (b) => {
    const gate = advisorFacts.corpusGate(b.ctx.profile);
    if (gate) return [gate];
    const p = b.ctx.profile;
    const rows = p.corpus_baseline_rows != null ? Number(p.corpus_baseline_rows) : null;
    const checked = p.corpus_checked_at ? String(p.corpus_checked_at).slice(0, 10) : null;
    return [advisorFacts.makeFact({
      id: 'corpus_status',
      // `status` is a column value ('baselines'), and it used to be substituted
      // into prose as one: "your Google profile's pattern is recorded as
      // baselines". advisorPhrasing's enum vocabulary now renders it, and the
      // key is named so the date part renders as a date too.
      value: { status: p.corpus_status, baselineRows: rows, checkedAt: checked },
      source: 'google_baseline',
      asOf: checked || advisorFacts.CORPUS_AS_OF,
      label: rows != null
        ? `This venue is in our measured corpus with ${rows} baseline rows${checked ? `, last checked ${checked}` : ''}. Model backed answers are on. Your own slider readings add history the corpus cannot.`
        : 'This venue is in our measured corpus, so model backed answers are on. Your own slider readings add history the corpus cannot.',
    })];
  },
};

// A VENUE WITH NO CROWD HISTORY OF ITS OWN STILL HAS A WEEK AHEAD on its
// dashboard: Flock's forecast for places like it, every number a category
// prior (advisorFacts.buildWeekProjection says why that card exists and what
// its numbers are). Roost read the corpus alone, so "What is our best money
// move this week?" refused under a card showing six numbers (2026-11-03
// demo). Where the corpus gate is the one reason the week would refuse, the
// week is that card, from the card's own function, each fact labelled as
// Flock's forecast for places like this one. With no card to read, the
// refusal stands as it was. The listing lines, which set the venue's own
// forecast beside what the owner told us, read the venue's own week only
// (`ownWeek`).
async function weekFor(ctx, ownWeek, card) {
  if (advisorFacts.corpusGate(ctx.profile)) {
    const { week } = await card();
    if (week.length) return week;
  }
  return ownWeek();
}

// TODAY, FOR THE SAME VENUE, OFF THE SAME CARD (2026-11-04). The card's week
// starts tomorrow, and "How does today look?" refused under a dashboard that
// draws today's peak. The card's own function reads today on today's hours
// (venueIntelligence `today`), so where the corpus gate is the reason today
// would refuse, today is that one entry, framed like the week's days
// (advisorFacts.todayProjectionFacts), from the same read as the week.
// Nothing to read (no card, today closed by the listing, a model number) keeps
// the refusal.
async function tonightFor(ctx, ownTonight, card) {
  if (advisorFacts.corpusGate(ctx.profile)) {
    const { today } = await card();
    if (today.length) return today;
  }
  return ownTonight();
}

// ONE READ OF THE CARD PER BLOCK (review, 2026-11-06). The week, today, the
// weekend and a question about today's weekday all read the card, and each
// used to read it on its own: two reads either side of the turn of an hour
// came from two builds, so a weekend asked at midnight held a Saturday from
// one build as today and a Saturday from the other as tomorrow ("Saturday ...
// Saturday is close behind"), and paid a second Places lookup. Every reader
// in a block now shares this one: { week, today, date }
// (advisorFacts.buildCardProjection). Whether it held anything is kept on
// `memo.cardRead`, so the advice path's second block does not pay again for a
// lookup that just failed.
function cardFor(ctx, opts, memo) {
  if (!memo.card) {
    memo.card = advisorFacts.buildCardProjection(ctx, opts).then((c) => {
      memo.cardRead = c.week.length > 0 || c.today.length > 0;
      return c;
    });
  }
  return memo.card;
}

// A QUESTION ABOUT TODAY'S WEEKDAY IS ANSWERED FROM TODAY (2026-11-06). A
// no-history venue's week is its card's, which starts tomorrow, so on a
// Monday "How busy will Monday be?" found no Monday and was answered about the
// week, and "How do I fill a slow Monday?" had no number to lead with. When
// the question asks about today and the venue is answered from its card,
// today's entry on the card is the answer, marked as standing beside the week
// (kindForecast.besideWeek), and the week's days go: the template says today's
// own line, and the phrasing model is handed the same one day, so neither can
// rank today against the week, whose busiest and quietest stay the card's own
// days, as the money move and the dashboard's tiles name them (review: handed
// the week as well, the model called Sunday "the quietest day this week"
// while the money move said to fill Monday). The move and what to ask next
// then name the same day the answer does. A card week too level to name a
// quiet day still has today's number, so the quiet-days plan's refusal goes
// too. Only for the plans that answer a named day (advisorPhrasing
// shapeWeek); the money move ranks its week and is not about one day. A
// venue's own week holds today already. The weekend reads today on its own
// (weekend_outlook).
const NAMED_TODAY_INTENTS = new Set(['peak_hours', 'quiet_nights']);
const isDayEntry = (e) => Boolean(e && e.value && typeof e.value.weekday === 'string' && 'peakScore' in e.value);

// THE DAY A QUESTION ASKS ABOUT, READ AGAINST THE VENUE'S OWN TODAY (review,
// 2026-11-06). "How busy will we be tonight?" named no weekday and was
// answered about the week; "Sat" and "Fri" were not read as days; "next
// Monday" asked on a Monday was answered with today's Monday, a date a week
// out. roostPlaybook.askedDay reads the words, and this reads them against the
// venue's own today: the card's, off the block's one read, for a venue with no
// crowd history, and its own week's clock otherwise (advisorFacts.venueToday,
// a field read). It answers the weekday asked about, null for a day nothing
// held stands for ("next Monday" on a Monday is a week away, past the week
// ahead), or undefined when the question names no day, or names today on a
// venue whose today cannot be read. Only for the questions about the week's
// days, whose plans have read the card already.
//
// TODAY'S WORDS ONLY WHERE THE QUESTION IS ABOUT A DAY (second review,
// 2026-11-06). "Today", "tonight" and "this morning" set the day only for the
// questions about a day's crowd: the peaks, the quiet days and today's own
// outlook. "My bartender quit this morning" and "Got a 1 star review today"
// are not asking how busy today is, and opened on today's forecast. Tonight
// is the night the today chip answers: in the small hours, the night still
// running (tonightOf). And a day more than six days off is past the week
// ahead however it is said: "next Monday" on a Monday, "Friday next week" on
// a Monday, "the Friday after next".
const DAY_INTENTS = new Set(['money_move', 'tonight_outlook', 'peak_hours', 'quiet_nights', 'weekend_outlook']);
const TODAY_WORD_INTENTS = new Set(['peak_hours', 'quiet_nights', 'tonight_outlook']);
// The words of a question about a day's crowd, which an advice question
// needs before "today" or "tonight" in it sets the day (the advice path).
const CROWD_ASKED = /\b(?:busy|busier|busiest|slow|slower|slowest|quiet|quieter|quietest|dead|packed|full|empty|fill|filling|crowds?|crowded|covers?|guests?|people|customers?|traffic|turnout|rush|staff|staffed|staffing|expect|expecting|looks?|looking|peaks?|demand|walk[\s-]?ins?)\b/i;
const WEEKDAY_NAMES_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The venue's own today by the calendar ('YYYY-MM-DD'), or null: the card's,
// or its own week's clock.
async function todayOf(b) {
  if (gatedVenue(b) && typeof b.card === 'function') {
    const card = await b.card();
    return ISO_DATE.test(String(card.date)) ? card.date : null;
  }
  const today = b.ctx ? advisorFacts.venueToday(b.ctx, { now: b.now }) : null;
  return today ? today.date : null;
}
// Tonight: in the small hours, the night still running, the night the today
// chip answers (tonight_outlook reads b.tonight). The card dates it by the
// calendar, as its own today chip does.
async function tonightOf(b) {
  if (b.ctx && !gatedVenue(b) && typeof b.tonight === 'function') {
    const date = (await b.tonight()).map(entryDate).find(Boolean);
    if (date) return date;
  }
  return todayOf(b);
}
// How many days from `today` the day asked about is (roostPlaybook.askedDay).
function daysAhead(asked, today) {
  const t = weekdayOf(today);
  const w = WEEKDAY_NAMES_LONG.indexOf(asked.weekday);
  const coming = (w - t + 7) % 7;
  if (asked.afterNext) return (coming || 7) + 7;
  // The week after this one runs from the coming Monday.
  if (asked.nextWeek) return ((8 - t) % 7 || 7) + ((w + 6) % 7);
  if (asked.next) return coming || 7;
  return coming;
}
// THE DAY A QUESTION ASKS ABOUT, READ AGAINST THE VENUE'S OWN TODAY
// (2026-11-06). roostDayReader.dayWords reads the day words where the question
// asks, by a small grammar; this puts each against the venue's own today: a
// date (today's words from tonight, the night the today chip answers; a
// weekday from the calendar's today), a day past the seven days, a weekend or
// the week. A weekday said with a weekend is that weekend's ("Saturday next
// weekend"); next weekend said beside this weekend is the one after it on any
// day; one day said twice ("Monday" and "tonight" on a Monday) is one day.
// Today's words count only on the routes about a day's crowd.
const TODAY_WORDS_AHEAD = Object.freeze({ today: 0, tomorrow: 1, dayAfterTomorrow: 2 });
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
function weekendDates(today, scope) {
  const { from, to } = weekendWindow(today, scope);
  const out = [];
  for (let d = from; d <= to; d = addDaysTo(d, 1)) out.push(d);
  return out;
}
async function targetsFor(b, question, intentId) {
  const words = roostDayReader.dayWords(question);
  if (!words.length) return [];
  const today = await todayOf(b);
  const weekends = words.filter((w) => w.kind === 'weekend');
  const contrast = weekends.some((w) => w.scope === 'this') && weekends.some((w) => w.scope === 'next_words');
  const raw = (w) => (contrast && w.scope === 'next_words' ? 'next' : w.scope);
  const scopeOf = (w) => {
    const s = raw(w);
    if (s !== 'next_words') return s;
    return today && [1, 2, 3, 4].includes(weekdayOf(today)) ? 'this' : 'next';
  };
  const out = [];
  let placedIn = null;
  for (const w of words) {
    if (Object.hasOwn(TODAY_WORDS_AHEAD, w.kind)) {
      if (!TODAY_WORD_INTENTS.has(intentId)) continue;
      const tonight = await tonightOf(b);
      if (!tonight) continue;
      const date = addDaysTo(tonight, TODAY_WORDS_AHEAD[w.kind]);
      out.push({ kind: 'day', date, weekday: WEEKDAY_NAMES_LONG[weekdayOf(date)], word: w, fromTonight: true });
    } else if (w.kind === 'weekday') {
      if (!today) {
        out.push((w.nextWeek || w.afterNext) ? { kind: 'past', weekday: w.weekday, word: w } : { kind: 'day', date: null, weekday: w.weekday, word: w });
        continue;
      }
      // Friday, Saturday or Sunday said with a weekend is that weekend's day:
      // this weekend's is the coming one (on a Sunday, "Friday this weekend"
      // is next Friday, as the peaks chip reads it); next weekend's is in it.
      const plain = !w.next && !w.nextWeek && !w.afterNext;
      const inside = plain && ['Friday', 'Saturday', 'Sunday'].includes(w.weekday)
        ? weekends.find((we) => scopeOf(we) !== 'after_next') : null;
      let date;
      if (inside && scopeOf(inside) !== 'this') {
        date = weekendDates(today, scopeOf(inside)).find((d) => WEEKDAY_NAMES_LONG[weekdayOf(d)] === w.weekday);
      } else {
        date = addDaysTo(today, daysAhead(w, today));
      }
      if (inside) placedIn = placedIn || inside;
      const ahead = daysBetween(today, date);
      out.push(ahead <= 6 ? { kind: 'day', date, weekday: w.weekday, word: w } : { kind: 'past', date, ahead, weekday: w.weekday, word: w, ofWeekend: Boolean(inside) });
    } else if (w.kind === 'weekend') {
      out.push({ kind: 'weekend', scope: scopeOf(w), raw: raw(w), word: w });
    } else {
      out.push({ kind: 'week', word: w });
    }
  }
  const seen = new Set();
  return out.filter((t) => !(t.kind === 'weekend' && placedIn && t.word === placedIn)).filter((t) => {
    const k = t.kind === 'day' || t.kind === 'past' ? `day:${t.date || t.weekday}` : `${t.kind}:${t.scope || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
// What a question's day words come to: { askedFor, target } for one day
// (askedFor the weekday, or null for a day past the seven days), {
// weekendScope } for one weekend, { targets } for two or more, and {} for
// none or the week alone, which the route answers as it always has.
async function readingFor(b, question, intentId) {
  let targets = await targetsFor(b, question, intentId);
  // Today put in or left out of the week in so many words ("Besides tonight,
  // which day is busiest this week?") names today wherever it is said, so
  // the week is ranked with it or without it (bothAnswer).
  const todayCue = roostDayReader.todayInRanking(question);
  if (todayCue && TODAY_WORD_INTENTS.has(intentId) && targets.length && !targets.some((t) => t.word && t.word.kind === 'today')) {
    const tonight = await tonightOf(b);
    if (tonight) targets = [{ kind: 'day', date: tonight, weekday: WEEKDAY_NAMES_LONG[weekdayOf(tonight)], word: { kind: 'today' }, fromTonight: true }, ...targets];
  }
  const fromTonight = targets.some((t) => t.fromTonight);
  if (targets.length > 1) return { targets, fromTonight, todayCue };
  const [t] = targets;
  if (!t || t.kind === 'week') return {};
  if (t.kind === 'weekend') return { weekendScope: t.raw };
  return { askedFor: t.kind === 'day' ? t.weekday : null, target: t, fromTonight };
}
// What a question about a day past the week ahead is answered with: that the
// day is past it, named as the question named it, and when it comes into it
// (advisorFacts.dayPastForecastRefusal).
async function pastDayRefusal(b, target) {
  const w = target.word || {};
  let day = `Next ${target.weekday}`;
  if (target.ofWeekend) day = `${target.weekday} of next weekend`;
  if (w.nextWeek) day = `${target.weekday} next week`;
  if (w.afterNext) day = `The ${target.weekday} after next`;
  const today = await todayOf(b);
  let comesIn = null;
  if (today && target.date) {
    const enters = daysBetween(today, target.date) - 6;
    const name = WEEKDAY_NAMES_LONG[weekdayOf(addDaysTo(today, enters))];
    if (enters === 1) comesIn = 'tomorrow';
    else comesIn = enters >= 7 ? `on ${name} next week` : `on ${name}`;
  }
  return advisorFacts.dayPastForecastRefusal({ day, comesIn });
}
async function withNamedToday(entries, intentId, b, named) {
  if (!named || !NAMED_TODAY_INTENTS.has(intentId) || typeof b.card !== 'function') return entries;
  if (!entries.some(isKindForecast) && !gatedVenue(b)) return entries;
  const { today, week } = await b.card();
  const day = today.find((f) => f.value && f.value.weekday === named);
  if (!day) return entries;
  // Where today sits in the week ahead, for the move under the answer
  // (kindForecast.besideWeek, roostPlaybook.moveFor): at its quiet end when
  // within the ordering floor of the week's quietest day.
  const scores = (Array.isArray(week) ? week : []).map((f) => Number(f && f.value && f.value.peakScore)).filter(Number.isFinite);
  const quietEnd = scores.length ? Number(day.value.peakScore) - Math.min(...scores) < HOUR_ORDERING_MIN_GAP : null;
  return [besideWeek(day, { quietEnd }), ...entries.filter((e) => !advisorFacts.isRefusal(e) && !isDayEntry(e))];
}

// TWO DAYS ASKED ARE BOTH ANSWERED (2026-11-06). A question whose
// words name two days ("Will tomorrow be busier than tonight?", "Is Saturday
// busier than Friday?", "Which day is busiest this week, starting today?",
// "Tonight was dead so I'm wondering if tomorrow will pick up") is not read
// down to one of them. On the routes about the week's days it is answered from
// the week ahead, ranked as the route ranks it, with each day it names said as
// well (block.askedDays, advisorPhrasing shapeWeek), and today in the ranking
// only when the question puts it there (todayInRanking, below). On
// the weekend's route it is answered about this weekend, and next weekend's
// days, when the question sets them beside it, are said beside it, never
// ranked with it (advisorFacts.besideAnswer), or said to be past the seven
// days. A weekday outside the weekend set beside it ("Will this weekend be
// busier than Thursday?", "How busy will Ruby Tuesday be this weekend?") is
// left to the weekend's answer, as before.
async function bothAnswer(intentId, b, targets, todayCue = null) {
  const { days: fromToday, today, card, asOf } = await daysFromToday(b);
  const stamp = asOf || (b.now || new Date()).toISOString();
  const named = (dates) => dates.map((d) => WEEKDAY_NAMES_LONG[weekdayOf(d)]);
  const past = (dates) => advisorFacts.pastForecastFact({ card, weekdays: named(dates), from: dates[0], through: dates[dates.length - 1], asOf: stamp });
  const dayOf = (date) => fromToday.find((e) => entryDate(e) === date && !advisorFacts.isRefusal(e)) || null;
  const pasts = targets.filter((t) => t.kind === 'past' && t.date).map((t) => past([t.date]));
  if (intentId === 'weekend_outlook') {
    const weekends = targets.filter((t) => t.kind === 'weekend');
    const primary = weekends.find((t) => t.scope === 'this') || weekends[0] || { scope: 'this', raw: 'this' };
    const main = await INTENT_PLANS.weekend_outlook({ ...b, weekendScope: primary.raw });
    const have = new Set(main.map(entryDate).filter(Boolean));
    const beside = [];
    if (today) {
      const last = addDaysTo(today, 6);
      for (const w of weekends.filter((t) => t !== primary)) {
        if (w.scope === 'after_next') continue;
        const dates = weekendDates(today, w.scope).filter((d) => !have.has(d));
        const held = dates.filter((d) => d <= last).map(dayOf).filter(Boolean);
        beside.push(...held.map((e) => advisorFacts.besideAnswer(w.scope === 'next' ? advisorFacts.nextWeekendDay(e) : e)));
        const gone = dates.filter((d) => d > last);
        if (gone.length) beside.push(past(gone));
      }
    }
    return { entries: [...main, ...beside, ...pasts], askedFor: undefined };
  }
  const days = targets.filter((t) => t.kind === 'day' && t.date);
  const isDay = (e) => Boolean(e) && !advisorFacts.isRefusal(e) && entryDate(e) !== null;
  // Today's route keeps today first, then each other day the question names,
  // then the rest of the week in date order (shapeToday says them in turn).
  // Only today's own entry may stand first, since the template calls the
  // first entry today: a today shut opens on its shut line, and a question
  // that leaves today out, or a today with no entry, is answered as the peaks
  // route answers it, under that route's template.
  if (intentId === 'tonight_outlook') {
    const tonightDate = await tonightOf(b);
    const night = await (b.tonight ? b.tonight() : b.week());
    const tonight = todayCue === 'out' ? null : (night.find((e) => isDay(e) && entryDate(e) === tonightDate) || null);
    const shut = tonight || todayCue === 'out' ? null : await shutToday(b, night);
    if (!tonight && !shut) return { ...await bothAnswer('peak_hours', b, targets, todayCue), intent: 'peak_hours' };
    const week = await b.week();
    const others = days.filter((t) => t.date !== tonightDate)
      .map((t) => week.find((e) => isDay(e) && entryDate(e) === t.date)).filter(Boolean);
    if (shut) return { entries: [shut, ...others, ...pasts], askedFor: undefined };
    const rest = week.filter((e) => isDay(e) && !others.includes(e) && entryDate(e) !== tonightDate);
    return { entries: [tonight, ...others, ...rest, ...pasts], askedFor: undefined };
  }
  // A card's week starts tomorrow: today's entry is ranked with it only when
  // the question puts today in ("including today", "Is tonight the busiest
  // night this week?"), and is otherwise said beside the ranking, never in
  // it; one that leaves today out ("besides tonight") gets the card's week
  // alone. The venue's own week holds today already, and a question that
  // leaves today out ranks it without today (roostDayReader.todayInRanking).
  let week;
  let besideToday = [];
  const todayT = days.find((t) => t.word && t.word.kind === 'today');
  if (gatedVenue(b) && typeof b.card === 'function') {
    const c = await b.card();
    const namesToday = days.some((t) => t.date === c.date);
    const rankToday = namesToday && todayCue === 'in';
    week = c.week.length ? [...(rankToday ? c.today : []), ...c.week] : await b.week();
    if (namesToday && !rankToday && todayCue !== 'out' && c.week.length) {
      besideToday = (c.today || []).filter(isDay).map((e) => besideWeek(e));
    }
  } else {
    week = await b.week();
    if (todayCue === 'out' && todayT) week = week.filter((e) => entryDate(e) !== todayT.date);
  }
  const plan = INTENT_PLANS[intentId === 'money_move' ? 'peak_hours' : intentId];
  const ranked = await plan({ ...b, week: async () => week });
  const have = new Set(ranked.map((e) => e && e.id));
  const inWeek = (date) => week.find((e) => entryDate(e) === date && !advisorFacts.isRefusal(e)) || null;
  const mentioned = days.map((t) => inWeek(t.date)).filter((e) => e && !have.has(e.id));
  const asked = days.filter((t) => !(todayCue === 'out' && todayT && t.date === todayT.date));
  return { entries: [...ranked, ...mentioned, ...besideToday, ...pasts], askedFor: undefined, askedDays: asked.map((t) => t.weekday) };
}

// The bridge's step after a plan, for a typed question (readingFor above): a
// day past the week ahead is said to be; two days are both answered
// (bothAnswer); a day the route's plan does not hold (a weekday outside the
// weekend on the weekend's route, tomorrow on today's, a day not among the
// two quietest) is answered from the week ahead, as the peaks chip answers it
// (b1dd5442, widened); today shut, asked by name or as tonight, is said
// plainly; and today on its own for a question about today (withNamedToday).
// A chip asks about no day and passes through untouched.
async function forQuestion(entries, intentId, b, question, reading = undefined) {
  if (!question || !DAY_INTENTS.has(intentId)) return { entries, askedFor: undefined };
  const r = reading || await readingFor(b, question, intentId);
  if (r.targets) return bothAnswer(intentId, b, r.targets, r.todayCue);
  const { askedFor, target } = r;
  if (askedFor === null && (NAMED_TODAY_INTENTS.has(intentId) || intentId === 'weekend_outlook')) {
    return { entries: [await pastDayRefusal(b, target)], askedFor };
  }
  if (target && target.kind === 'day' && target.date && intentId === 'weekend_outlook') {
    const { today } = await daysFromToday(b);
    if (today && !inWeekend(target.date, today, 'this')) {
      return { entries: await withNamedToday(await INTENT_PLANS.peak_hours(b), 'peak_hours', b, askedFor), askedFor };
    }
  }
  if (target && target.kind === 'day' && target.date && intentId !== 'weekend_outlook') {
    const todayDate = target.fromTonight ? await tonightOf(b) : await todayOf(b);
    if (NAMED_TODAY_INTENTS.has(intentId) && target.date === todayDate) {
      const shut = await shutToday(b, await b.week());
      if (shut) return { entries: [shut], askedFor };
    }
    const holds = (list) => list.some((e) => entryDate(e) === target.date && !advisorFacts.isRefusal(e));
    let away = false;
    if (intentId === 'tonight_outlook') away = target.date !== todayDate && !holds(entries);
    if (intentId === 'quiet_nights') {
      const card = typeof b.card === 'function' && gatedVenue(b) ? await b.card() : { today: [] };
      away = !holds(entries) && !holds(card.today || []);
    }
    if (away) {
      // Answered from the peaks plan, so said with the peaks template: today's
      // template would call the day asked about today.
      const intent = intentId === 'tonight_outlook' ? { intent: 'peak_hours' } : {};
      return { entries: await withNamedToday(await INTENT_PLANS.peak_hours(b), 'peak_hours', b, askedFor), askedFor, ...intent };
    }
  }
  return { entries: await withNamedToday(entries, intentId, b, askedFor), askedFor };
}

// `question`, when there is one, is what the owner asked: a question that
// names today's weekday is answered from today (withNamedToday above).
async function bridgeFactBlock(userId, intentId, { question = '' } = {}) {
  const ctx = await advisorFacts.getVenueContext(userId);
  if (!ctx || !ctx.profile.google_place_id) {
    return {
      intent: intentId,
      facts: [],
      refusals: [`${FEATURE_NAME} reads facts about your venue and does not know which venue is yours yet. No Google listing is linked to this venue. Write to social@flockcorp.com to link one.`],
    };
  }
  if (!ctx.profile.verified) {
    return { intent: intentId, facts: [], refusals: [unverifiedReason(ctx.profile)] };
  }

  const opts = { now: new Date(), userId };
  const memo = {};
  // "How busy will we be tonight?" about a venue's own week reads it from the
  // night in progress, the week the today chip reads, so in the small hours
  // tonight is the night still running and is in the week it is answered
  // from (review, 2026-11-06; readingFor above).
  let fromTonight = false;
  const b = {
    ctx,
    now: opts.now,
    // The owner's typed question, for the plan that reads which weekend it
    // asks about (weekend_outlook); empty for a chip.
    question: question || '',
    // The venue's own week: its corpus forecast, or the corpus refusal, which
    // is a field read and costs nothing.
    ownWeek: () => (memo.ownWeek = memo.ownWeek || advisorFacts.buildWeekAhead(ctx, opts)),
    // The week a question about the week ahead reads (weekFor above).
    week: () => (memo.week = memo.week || (fromTonight ? b.tonight() : weekFor(ctx, b.ownWeek, b.card))),
    // The same week, started from last night's evening while that night is
    // still running: what "tonight" means at 12:30 AM. For a venue with no
    // crowd history, today off its dashboard card (tonightFor above).
    tonight: () => (memo.tonight = memo.tonight || tonightFor(ctx,
      () => advisorFacts.buildWeekAhead(ctx, { ...opts, nightInProgress: true }), b.card)),
    // The card's week, today and today's date off one read (cardFor above).
    // Read only for a venue the corpus gate sends to the card.
    card: () => cardFor(ctx, opts, memo),
    around: () => (memo.around = memo.around || advisorFacts.buildAroundYou(ctx, opts)),
    readings: () => (memo.readings = memo.readings || advisorFacts.buildReadingsVsServed(ctx, opts)),
    listing: () => (memo.listing = memo.listing
      || Promise.resolve(b.ownWeek()).then((week) => advisorFacts.buildListingReadBack(ctx, week, opts))),
    verdict: () => (memo.verdict = memo.verdict
      || (lastNightVerdict
        ? lastNightVerdict.buildLastDayVerdict(ctx, opts)
        : Promise.resolve([]))),
    cohortNight: () => (memo.cohortNight = memo.cohortNight || advisorFacts.buildCohortSameNight(ctx, opts)),
    cohortTypical: () => (memo.cohortTypical = memo.cohortTypical || advisorFacts.buildCohortStanding(ctx, opts)),
    tables: () => (memo.tables = memo.tables
      || (typeof advisorFacts.buildTableFacts === 'function'
        ? advisorFacts.buildTableFacts(ctx, opts)
        : Promise.resolve([]))),
  };

  // The question's day words, read against the venue's own today before
  // the plan runs: the weekend it asks about, and whether a day word is
  // counted from tonight (readingFor).
  const reading = question && DAY_INTENTS.has(intentId) ? await readingFor(b, question, intentId) : {};
  fromTonight = Boolean(reading.fromTonight) && NAMED_TODAY_INTENTS.has(intentId) && !advisorFacts.corpusGate(ctx.profile);
  b.weekendScope = reading.weekendScope;
  const plan = INTENT_PLANS[intentId];
  const { entries, askedFor, askedDays, intent } = await forQuestion(plan ? await plan(b) : [], intentId, b, question, reading);

  const facts = entries.filter((e) => !advisorFacts.isRefusal(e));
  const refusals = entries.filter((e) => advisorFacts.isRefusal(e)).map(refusalText);
  // What kind of venue this is and its spend per head ride with the block,
  // so the move a chip ends on fits the venue and is priced in its own money
  // without a second lookup (roostPlaybook.moveFor, withMove below). Neither
  // is a fact and neither reaches a model as one.
  return {
    // The plan that answered: a day today's route does not hold is answered
    // from the peaks plan, and said with its template (forQuestion).
    intent: intent || intentId,
    facts,
    refusals: facts.length > 0 ? [] : refusals,
    venue: roostPlaybook.venueOf(ctx),
    // How the room serves, so the phrasing model speaks in the venue's own
    // terms (advisorPhrasing.buildUserPayload, `room`).
    serviceStyle: ctx.profile.service_style || null,
    spend: roostPlaybook.spendOf(ctx),
    spendAsOf: ctx.profile.updated_at ? `owner-set ${String(ctx.profile.updated_at).slice(0, 10)}` : 'owner-set',
    // Whether this block read the no-history venue's Week Ahead card and
    // found anything on it (cardFor); absent when it never needed to.
    ...(typeof memo.cardRead === 'boolean' ? { cardRead: memo.cardRead } : {}),
    // The day the question asks about, read against the venue's own today
    // (readingFor): the template and the playbook's lead answer about this
    // day, not the one the question's words alone would name. Absent when
    // the question names no day.
    ...(askedFor !== undefined ? { askedDay: askedFor } : {}),
    // The days a question names two or more of, in the order it names
    // them (bothAnswer): the template says each.
    ...(askedDays ? { askedDays } : {}),
  };
}

function factEngine() {
  if (router.__factsOverride) return router.__factsOverride;
  if (!advisorFacts) return null;
  if (typeof advisorFacts.buildFactBlock === 'function') return advisorFacts.buildFactBlock;
  if (typeof advisorFacts.getVenueContext === 'function') return bridgeFactBlock;
  return null;
}

// ─── GET /cards — the four T0 insight cards ─────────────────────────────────
//
// Deterministic composition over services/advisorFacts.js. Every fact carries
// {id, value, source, asOf}; refusals are data with a path; the modal case (a
// venue absent from the corpus) renders as refusal cards, which are a designed
// screen, not an error. Verified claims only, same soft answer /intelligence
// and /strip use. Pinned by __tests__/advisorCards.test.js.

// The same sentences /intelligence and /strip use for the same condition, from
// the one module that owns them (utils/verificationCopy.js). The old constant
// here told the owner to verify their venue and named no way to do it; the
// copy now names the request path, and says a different thing once the
// request is pending, which is why it is a function of the profile row.
const { unverifiedReason } = require('../utils/verificationCopy');

// The four MVP cards, in the order the product shape lists them.
//
// THE VERDICT IS CARD ZERO. It leads the stack because "how did we just do" is
// what operators actually open a tool to ask (Toast's own prompt telemetry
// across 125,000+ locations; explicit forecasting was one percent of prompts,
// the least asked category they measured). Every card under it is a forecast
// or a read-back; this one grades a day that already happened, from the
// venue's own numbers, and it is the only card here that works for a venue our
// corpus has never seen.
const CARDS = [
  { id: 'last_night_verdict', title: 'Yesterday, against your own numbers', tier: 'pro' },
  { id: 'week_ahead', title: 'Week ahead', tier: 'pro' },
  { id: 'around_you', title: 'Around you this week', tier: 'pro' },
  { id: 'listing_read_back', title: 'Your listing, read back', tier: 'pro' },
  { id: 'readings_vs_estimates', title: 'What you said vs what we estimated', tier: 'pro' },
  // The cohort card. Every other card on this list compares the venue to
  // itself or to a forecast; this one is the only place Flock holds something
  // no operator can get anywhere else, which is somebody else's numbers. It
  // carries both halves at once because that is how the question is actually
  // asked: the street's readings for the day (or the refusal that names the
  // floor of five reporting venues), then where the venue's own typical sits
  // in its city and category. services/advisorCohort.js holds the floors and
  // the differencing analysis.
  { id: 'cohort', title: 'You and venues like you', tier: 'pro' },
];

// getVenueTier answers 'free' or 'pro' and nothing else (a stored 'premium'
// resolves to 'pro', services/venueEntitlements.js planOf), and every card is
// 'pro', the same floor as the route. So today a venue that reaches the
// handler is covered for every card. The per-card tier stays so that a card
// can one day sit on a different plan from the route without new plumbing.
function tierCovers(tier, required) {
  return required === 'free' || tier === 'pro';
}

function finishedCard(def, facts) {
  return {
    id: def.id,
    title: def.title,
    facts,
    // 'ok' when at least one real fact rendered; 'refused' when the card is
    // all refusals — the MODAL case for a venue outside the corpus.
    status: facts.some((f) => !advisorFacts.isRefusal(f)) ? 'ok' : 'refused',
  };
}

function lockedCard(def) {
  return {
    id: def.id,
    title: def.title,
    facts: [],
    status: 'locked',
    // The same vocabulary the 403 contract uses, so the client's existing
    // UPGRADE_REQUIRED handling renders this without new plumbing.
    requiredTier: def.tier,
    code: 'UPGRADE_REQUIRED',
  };
}

router.get('/cards', authenticate, requirePro, async (req, res) => {
  try {
    if (!advisorFacts || typeof advisorFacts.getVenueContext !== 'function') {
      return res.status(503).json({ error: `${FEATURE_NAME} is not connected to its data yet. Check back soon.` });
    }
    const userId = req.user.id;
    const ctx = await advisorFacts.getVenueContext(userId);
    if (!ctx || !ctx.profile.google_place_id) {
      return res.json({ available: false, reason: `No Google listing is linked to this venue yet, so ${FEATURE_NAME} is off. Write to social@flockcorp.com to link one.`, cards: [] });
    }
    if (!ctx.profile.verified) {
      return res.json({ available: false, unverified: true, reason: unverifiedReason(ctx.profile), cards: [] });
    }

    // With billing off everyone acts pro, mirroring requireVenueTier itself.
    const tier = venueBillingEnabled() ? await getVenueTier(userId) : 'pro';
    const now = new Date();
    const opts = { now, userId };

    const [verdictDef, weekDef, aroundDef, listingDef, readingsDef, cohortDef] = CARDS;

    // Card 1 is built first because card 3's arithmetic reads its peak facts.
    // From the night still running, in the small hours, so the cards' today
    // is the night the owner is in (components/VenueInsightCards.js todayStr).
    const weekFacts = tierCovers(tier, weekDef.tier)
      ? await advisorFacts.buildWeekAhead(ctx, { ...opts, nightInProgress: true })
      : null;
    // A venue with no crowd history of its own: the dashboard's Week Ahead,
    // framed as Flock's forecast for places like it, where the card has one
    // to show (weekFor's rule, the same function and cache entry). This card
    // used to refuse under the dashboard card's six numbers. The listing card
    // below keeps the venue's own week, which is what it sets the owner's
    // answers beside.
    let shownWeek = weekFacts;
    if (weekFacts && advisorFacts.corpusGate(ctx.profile) && typeof advisorFacts.buildWeekProjection === 'function') {
      const projected = await advisorFacts.buildWeekProjection(ctx, opts);
      if (projected.length) shownWeek = projected;
    }

    const cards = [];
    if (lastNightVerdict) {
      cards.push(tierCovers(tier, verdictDef.tier)
        ? finishedCard(verdictDef, await lastNightVerdict.buildLastDayVerdict(ctx, opts))
        : lockedCard(verdictDef));
    }
    cards.push(shownWeek ? finishedCard(weekDef, shownWeek) : lockedCard(weekDef));
    cards.push(tierCovers(tier, aroundDef.tier)
      ? finishedCard(aroundDef, await advisorFacts.buildAroundYou(ctx, opts))
      : lockedCard(aroundDef));
    cards.push(tierCovers(tier, listingDef.tier)
      ? finishedCard(listingDef, await advisorFacts.buildListingReadBack(ctx, weekFacts || [], opts))
      : lockedCard(listingDef));
    cards.push(tierCovers(tier, readingsDef.tier)
      ? finishedCard(readingsDef, await advisorFacts.buildReadingsVsServed(ctx, opts))
      : lockedCard(readingsDef));
    // Both halves on one card, same-night first. A card keeps its refusals
    // inline, which is exactly what the density half needs: the floor refusal
    // is the growth loop and it has to be readable next to the half that
    // already answers.
    if (typeof advisorFacts.buildCohortSameNight === 'function') {
      cards.push(tierCovers(tier, cohortDef.tier)
        ? finishedCard(cohortDef, [
          ...await advisorFacts.buildCohortSameNight(ctx, opts),
          ...await advisorFacts.buildCohortStanding(ctx, opts),
        ])
        : lockedCard(cohortDef));
    }

    return res.json({ available: true, cards, generatedAt: now.toISOString() });
  } catch (err) {
    console.error('Advisor cards error:', err);
    return res.status(500).json({ error: 'Failed to build advisor cards' });
  }
});

// ─── Which chips this venue actually gets offered ───────────────────────────
//
// The registry has thirteen questions. A venue should not be shown thirteen
// buttons, and it should certainly not be shown nine that decline.
//
// TWO SEPARATE PROBLEMS, fixed together.
//
// 1. HOW MANY. Roost's chips are whole sentences at thirty to fifty characters,
//    so a phone fits three or four before the list becomes a wall. `lead` is
//    the four the venue sees; the rest stay grouped behind a disclosure. The
//    order comes from advisorPhrasing.CHIP_PRIORITY, which leads with today's
//    outlook and puts events and weather last despite them being the prettiest
//    card, because the questions owners actually ask are about their own room.
//
// 2. WHICH ONES. corpusGate already knows, before anything is built, that a
//    venue outside the measured corpus cannot be given a forecast, and the
//    readings questions already know they have nothing to say for a venue that
//    has not posted a reading. Offering those chips anyway is a menu of dead
//    buttons, which DESIGN-STANDARD rule 5 bans in every other surface in this repo.
//    So availability is computed DETERMINISTICALLY from the profile plus one
//    cheap EXISTS pair, not by building every card: a chip is offered when the
//    data behind it exists.
//
// Three chips are always offered and all three earn it. `around_you` needs no
// corpus and no history. `data_status` answers with the corpus gate's own
// refusal, which for the modal venue IS the honest answer to what data we hold.
// `last_night_verdict` is the third and the deliberate one: it is the only chip
// whose refusal names an action the owner can take in one tap, and hiding it
// from venues with no readings would hide the argument for posting one. It is
// also uncorpused by construction, so it is the one forecast-free answer a
// venue outside our corpus can ever get.
const ALWAYS_AVAILABLE = new Set(['around_you', 'data_status', 'last_night_verdict']);
// `cohort_typical` is a corpus question: it places the venue's own Google curve
// inside the frozen distribution of its city and category, so without a curve
// there is nothing to place. Five of these are also offered to a venue outside
// the corpus whose dashboard Week Ahead card answers them (CARD_INTENTS below).
const NEEDS_CORPUS = new Set(['money_move', 'tonight_outlook', 'peak_hours', 'weekend_outlook', 'quiet_nights', 'cohort_typical']);
// `cohort_same_night` is a history question for a reason that is about honesty
// rather than plumbing: "was it just us" needs a your-side, and a venue that
// has posted nothing has no side. Offered to venues that have their own
// readings, it always has one, and when the street is too thin to publish it
// answers with the refusal that names the floor. That refusal is not a dead
// button; it is the only sentence in the product that asks for the thing which
// makes the product work.
const NEEDS_HISTORY = new Set(['week_recap', 'slow_night', 'readings_vs_estimates', 'cohort_same_night']);
// The listing read-back questions need the corpus AND the intake field each one
// reads. An owner who never filled in a kitchen time is not shown a chip about
// their kitchen time.
const NEEDS_CORPUS_AND_INTAKE = {
  kitchen_vs_peak: 'kitchen_last_order',
  capacity_math: 'capacity',
  busy_nights_check: 'owner_busy_nights',
};

// The table questions need table history: a closed seating at this place in
// the last 28 days. A venue with no table unit is not shown two chips that
// can only decline.
const NEEDS_TABLES = new Set(['tables_service', 'tables_free']);

async function hasTableHistory(placeId) {
  if (!placeId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM sensor_table_seatings
                       WHERE venue_place_id = $1
                         AND left_at IS NOT NULL
                         AND seated_at >= NOW() - INTERVAL '28 days') AS tables`,
      [placeId]
    );
    return !!(rows[0] && rows[0].tables);
  } catch (err) {
    // Same posture as hasRecentHistory: a failed check offers the chips, and
    // the builder refuses honestly if there is nothing behind them.
    console.error('Advisor table availability check failed:', err.message);
    return true;
  }
}

function intakeFilled(profile, column) {
  const v = profile ? profile[column] : null;
  if (v === null || v === undefined || v === '') return false;
  return !Array.isArray(v) || v.length > 0;
}

async function hasRecentHistory(placeId) {
  if (!placeId) return false;
  try {
    const { rows } = await pool.query(
      // `source = 'detail'` for migration 038's reason, which this half of the
      // check was missing (money audit round 4). POST /api/crowd/batch writes
      // served_predictions rows for a caller-named place id from caller-supplied
      // scoring inputs, so without the allowlist any authenticated account could
      // keep another venue's history chips lit up, and keep them lit after the
      // venue itself had gone quiet. Every other reader of this table already
      // takes 'detail' only. Allowlist rather than `<> 'batch'`: the pre-038
      // rows carry NULL, and NULL <> 'batch' is NULL, never true.
      `SELECT EXISTS (SELECT 1 FROM venue_owner_reports
                       WHERE google_place_id = $1 AND retracted = false
                         AND created_at >= NOW() - INTERVAL '7 days') AS readings,
              EXISTS (SELECT 1 FROM served_predictions
                       WHERE venue_place_id = $1
                         AND source = 'detail'
                         AND served_at >= NOW() - INTERVAL '7 days') AS served`,
      [placeId]
    );
    return !!(rows[0] && (rows[0].readings || rows[0].served));
  } catch (err) {
    // A chip list that cannot check offers the history questions rather than
    // hiding them: the fact engine refuses honestly on its own, so the failure
    // mode of a broken check should be a chip that declines, never a venue that
    // silently loses questions it is entitled to.
    console.error('Advisor question availability check failed:', err.message);
    return true;
  }
}

// THE WEEK QUESTIONS A VENUE WITH NO CROWD HISTORY CAN NOW BE ANSWERED FROM
// (2026-11-03). Their answers come from the dashboard's Week Ahead card when
// there is one (weekFor), so these chips are offered to such a venue exactly
// when that is where the answer would come from, and never when it would
// refuse: no card (a failed lookup, a week holding a model number, a week not
// read on hours the venue keeps) means no chip, and a level week means no
// quiet-days chip, because that plan refuses a week with no quiet day. Each
// chip's own plan is run over the card and asked whether it finds anything.
// Street facts only ever add to the card's days, so they are not read for
// this. Today's chip (2026-11-04) reads today off the same card (tonightFor),
// so a today closed by the venue's listed hours offers no today chip.
const CARD_INTENTS = Object.freeze(['money_move', 'tonight_outlook', 'peak_hours', 'quiet_nights', 'weekend_outlook']);

async function cardAnswers(ctx, userId) {
  if (typeof advisorFacts.buildCardProjection !== 'function') return new Set();
  // The week and today off one read of the card, so a lookup that fails is
  // paid for once. The weekend reads today's entry and date off the same read.
  const projection = await advisorFacts.buildCardProjection(ctx, { userId });
  const { week: card, today } = projection;
  if (!card.length && !today.length) return new Set();
  const b = {
    ctx, week: async () => card, tonight: async () => today, card: async () => projection, around: async () => [],
  };
  const answered = new Set();
  for (const id of CARD_INTENTS) {
    const entries = await INTENT_PLANS[id](b);
    if (entries.some((e) => !advisorFacts.isRefusal(e))) answered.add(id);
  }
  return answered;
}

async function availableIntents(ctx, userId) {
  const profile = ctx ? ctx.profile : null;
  const inCorpus = !!profile && advisorFacts.corpusGate(profile) === null;
  const [history, tables, fromCard] = await Promise.all([
    hasRecentHistory(profile && profile.google_place_id),
    hasTableHistory(profile && profile.google_place_id),
    // Read only for a venue the corpus cannot answer: a corpus venue's week is
    // its own forecast, and its chips are offered as they always were.
    inCorpus || !profile ? Promise.resolve(new Set()) : cardAnswers(ctx, userId).catch(() => new Set()),
  ]);
  return advisorPhrasing.CHIP_PRIORITY.filter((id) => {
    if (!advisorPhrasing.isKnownIntent(id)) return false;
    if (ALWAYS_AVAILABLE.has(id)) return true;
    if (NEEDS_TABLES.has(id)) return tables;
    if (NEEDS_CORPUS.has(id)) return inCorpus || fromCard.has(id);
    if (NEEDS_HISTORY.has(id)) return history;
    const column = NEEDS_CORPUS_AND_INTAKE[id];
    if (column) return inCorpus && intakeFilled(profile, column);
    // An intent nobody has classified yet is OFFERED, not hidden. Hiding by
    // omission is the worse failure: a chip that declines wastes a tap and says
    // what is missing, but a chip that silently disappears because a new intent
    // landed in the registry before it landed in the table above is a feature
    // the owner never learns exists. The cohort pair (cohort_same_night,
    // cohort_typical) is the current unclassified set; classify it here in the
    // change that wires its fact builders.
    return true;
  });
}

// The number of chips shown before the disclosure. Four, because the chips are
// sentences and a phone that shows five shows a wall.
const LEAD_CHIP_COUNT = 4;

// TYPED QUESTIONS NEED THE OWNER'S OK FIRST (App Store Guideline 5.1.2(i)).
// A typed question goes to Google's Gemini with the venue's name, its numbers
// and the details the owner filled in, notes included, which is personal data
// sent to a third-party AI. The app asks before the first one, and the answer
// is users.roost_ai_consent_at (migration 127), recorded by POST
// /api/ai/roost-consent: this file has no write path. /question refuses
// without it, before any meter is charged or any byte leaves, for every
// client; /questions reports it so the app knows to ask. The chips are not
// gated: they send the venue's computed numbers and a question id, no words
// anybody typed (privacy policy, "Roost, the advisor for venue owners").
const ROOST_CONSENT_REQUIRED = 'ROOST_CONSENT_REQUIRED';
const ROOST_CONSENT_MESSAGE = `${FEATURE_NAME} needs your OK before it sends a typed question to Google's Gemini.`;

async function roostConsentAt(userId) {
  const r = await pool.query('SELECT roost_ai_consent_at FROM users WHERE id = $1', [userId]);
  return r.rows[0] ? r.rows[0].roost_ai_consent_at || null : null;
}

// The chips, plus the free-text field's own availability. Pro-gated like the
// rest of the surface so the question list cannot advertise a feature the
// caller's plan does not serve. `name` is the product name, served so a rename
// is one backend line; `freeText` is served the same way, so the client renders
// the input only when the server will actually answer it.
router.get('/questions', authenticate, requirePro, async (req, res) => {
  try {
    const chip = (id) => ({ id, label: advisorPhrasing.ADVISOR_INTENTS[id].chip });
    let offered = advisorPhrasing.CHIP_PRIORITY.filter((id) => advisorPhrasing.isKnownIntent(id));

    if (advisorFacts && typeof advisorFacts.getVenueContext === 'function') {
      const ctx = await advisorFacts.getVenueContext(req.user.id);
      if (ctx && ctx.profile && ctx.profile.google_place_id && ctx.profile.verified) {
        offered = await availableIntents(ctx, req.user.id);
      } else if (ctx && ctx.profile) {
        // Unlinked or unverified: every chip would answer the same refusal
        // (the route's own comment called that a menu of dead buttons). Say
        // the one thing once, with the unlock path, and offer nothing.
        return res.json({
          name: advisorPhrasing.ADVISOR_NAME,
          freeText: false,
          lead: [],
          groups: [],
          reason: unverifiedReason(ctx.profile),
        });
      }
    }

    const lead = offered.slice(0, LEAD_CHIP_COUNT);
    const rest = new Set(offered.slice(LEAD_CHIP_COUNT));
    const groups = advisorPhrasing.ADVISOR_GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      questions: advisorPhrasing.CHIP_PRIORITY
        .filter((id) => rest.has(id) && advisorPhrasing.ADVISOR_INTENTS[id].group === g.id)
        .map(chip),
    })).filter((g) => g.questions.length > 0);

    const freeText = advisorFreeText.freeTextAvailable();
    return res.json({
      name: advisorPhrasing.ADVISOR_NAME,
      freeText,
      // Whether the owner has said yes to typed questions going to Gemini
      // (ROOST_CONSENT_REQUIRED above). Read only when the field exists.
      aiConsent: freeText ? Boolean(await roostConsentAt(req.user.id)) : false,
      lead: lead.map(chip),
      groups,
    });
  } catch (err) {
    console.error('Advisor questions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// One chip in, one answer out.
const FREE_TEXT_REFUSAL = `${FEATURE_NAME} takes the suggested questions only. Pick one of the question chips.`;
const UNKNOWN_INTENT = `That question isn't one ${FEATURE_NAME} can take. Pick one of the question chips.`;

router.post('/ask', authenticate, requirePro, [
  body('intentId').isString().withMessage(UNKNOWN_INTENT),
], async (req, res) => {
  try {
    // Free text is rejected by SHAPE, before validation and before anything
    // reads a value: the only key this endpoint has ever heard of is
    // intentId. This is Layer A with the parsing removed — no field exists
    // for user language to arrive in.
    const keys = Object.keys(req.body || {});
    if (keys.some((k) => k !== 'intentId')) {
      return res.status(400).json({ error: FREE_TEXT_REFUSAL });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { intentId } = req.body;
    if (!advisorPhrasing.isKnownIntent(intentId)) {
      return res.status(400).json({ error: UNKNOWN_INTENT });
    }

    const buildFactBlock = factEngine();
    if (!buildFactBlock) {
      return res.status(503).json({ error: `${FEATURE_NAME} is not connected to its data yet. Check back soon.` });
    }

    const block = await buildFactBlock(req.user.id, intentId);
    // The chip's own words ride with the facts, so the answer can lead with
    // the thing the chip asks. They are ours, never the owner's.
    const answer = await withMove(await advisorPhrasing.phrase(block, {
      venueUserId: req.user.id,
      question: advisorPhrasing.ADVISOR_INTENTS[intentId].chip,
    }), intentId, req.user.id, null, block);

    return res.json({
      intentId,
      mode: answer.mode, // 'refusal' | 'template' | 'phrased'
      text: answer.text,
      sources: answer.sources,
      // What to ask next (services/advisorFollowUps.js): ours, never typed.
      followUps: followUpsFor({ intentId, block }),
      context: followContext(answer, advisorPhrasing.ADVISOR_INTENTS[intentId].chip, intentId,
        chipTactics(answer, intentId, block)),
    });
  } catch (err) {
    console.error('Advisor ask error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /question — one typed question, one of three answers ──────────────
//
// SEPARATE FROM /ask ON PURPOSE. /ask keeps its shape refusal: one intentId
// key, prose answered 400 before a value is read. That is not legacy, it is the
// chip path's guarantee, and a chip answer should not become reachable by
// typing into the endpoint that promises it cannot be. Free text gets its own
// door, its own rate limiter (server.js), its own daily ceiling (migration
// 039), and its own flag.
//
// The modes leave here labeled, because the whole design is that an owner
// always knows which one they are reading:
//   mode 'phrased' | 'template' | 'refusal'  a grounded answer, exactly what
//                                            the matching chip would have said
//   mode 'advice'                            trade knowledge plus the venue's
//                                            own facts; its sources carry
//                                            trade_practice
//   mode 'refusal'                           declined, with the reason
//   mode 'small_talk'                        a greeting, thanks or sign-off
//                                            answered in kind, no data read
// The client's allowlist (frontend/src/services/api.js ADVISOR_ANSWER_MODES)
// mirrors this list; a mode added here without adding it there is recorded
// as 'unknown' in analytics.
const FREETEXT_OFF = advisorFreeText.UNAVAILABLE_TEXT;

router.post('/question', authenticate, requirePro, async (req, res) => {
  try {
    // Same shape refusal /ask uses: one question, and a non-string is rejected
    // before anything reads it. The one other key is `previous`, the turn
    // before this one, which the chat sends so "what else" and "what about
    // Wednesdays" can be answered (services/advisorFollowOn.js). It is client
    // input like any other: checked against closed lists here, and a question
    // built from it goes through every screen below.
    const keys = Object.keys(req.body || {});
    if (!keys.includes('question') || keys.some((k) => k !== 'question' && k !== 'previous')) {
      return res.status(400).json({ error: 'Send one question, as text.' });
    }

    const clean = advisorFreeText.sanitizeQuestion(req.body.question);
    if (!clean.ok) return res.status(400).json({ error: clean.error });
    const prior = advisorFollowOn.readPrevious(req.body.previous, {
      sanitize: advisorFreeText.sanitizeQuestion,
      isIntent: (id) => advisorPhrasing.isKnownIntent(id),
    });
    if (!prior.ok) return res.status(400).json({ error: 'Send one question, as text.' });

    // The flag is checked AFTER the shape so a malformed body still gets the
    // honest 400, and BEFORE any spend so a dark feature costs nothing. Free
    // text needs the model: with it off there is no template that answers a
    // question nobody wrote a template for, so this declines in plain words
    // rather than half working.
    if (!advisorFreeText.freeTextAvailable()) {
      return res.json({ mode: 'refusal', text: FREETEXT_OFF, sources: [], question: clean.text });
    }

    // NO RECORDED YES, NOTHING LEAVES. Read before the venue lookup, the
    // meters and both model calls, so a refused question costs the owner none
    // of their daily questions and sends Google nothing. `code` is what the
    // app answers by showing the question (ROOST_CONSENT_REQUIRED above).
    if (!(await roostConsentAt(req.user.id))) {
      return res.status(403).json({ error: ROOST_CONSENT_MESSAGE, code: ROOST_CONSENT_REQUIRED });
    }

    const buildFactBlock = factEngine();
    if (!buildFactBlock) {
      return res.status(503).json({ error: `${FEATURE_NAME} is not connected to its data yet. Check back soon.` });
    }

    const userId = req.user.id;

    // ── IS THE CALLER A VENUE AT ALL ────────────────────────────────────────
    //
    // requirePro DOES NOT ANSWER THAT, and cannot, in the posture this product
    // actually deploys in. services/venueEntitlements.js returns next() outright
    // while VENUE_BILLING_ENABLED is unset, which it is on Railway and which is
    // the correct pilot posture -- every CLAIMED venue sees the advisor without
    // anyone selling them a tier first. What that leaves is a gate that reads
    // as an authorisation check at every call site and is a pass-through at
    // runtime, and this is the one route where the difference is money: the
    // very next line is a Gemini call, and the advice branch below is a second
    // one, both charged to a ledger whose unit of identity is an account.
    //
    // Signup is free and unlimited. Measured on the preview stack: an ordinary
    // consumer account with no venue_profiles row and no subscription got a
    // real two-call advice answer, and moved the GLOBAL advisor_spend row. At
    // roughly six and a half thousand tokens a question and twenty questions an
    // account, sixteen throwaway accounts drain the two million token global
    // wall and put every real venue on template answers for the rest of the
    // day, on our invoice.
    //
    // So the spend gets the check the tier gate is not making. Not a TIER check
    // -- that stays exactly as dormant as it is meant to be -- just the floor
    // underneath it: this endpoint is for a venue, and a caller with no venue
    // profile is not one. The chip path does not need this; a venue-less
    // account gets a fact block with nothing in it and advisorPhrasing renders
    // the refusal before it charges anything (advisorPhrasing.js, phrase()).
    // Free text has no such shape: the router is asked to classify the question
    // before anything has looked at whose venue it is about.
    //
    // Hoisted rather than duplicated: the advice branch below needs this same
    // context and used to fetch it again after both calls were already spent.
    // getVenueContext answers null for BOTH "no such venue" and "this build has
    // no fact engine", so the two are told apart here rather than conflated:
    // only a build that can look is allowed to conclude anything from not
    // finding one.
    const canReadVenue = !!advisorFacts && typeof advisorFacts.getVenueContext === 'function';
    const ctx = canReadVenue ? await advisorFacts.getVenueContext(userId) : null;
    // AND THE SAME GATE /questions APPLIES, before a single unit is charged.
    // /questions tells an unlinked or unverified venue that free text is off
    // and offers nothing; this route only checked that a venue_profiles row
    // existed, which a verified email and one POST with a business name is
    // enough to create. So an account that could not get a chip could still
    // spend two model calls per typed question, twenty a day, and the
    // route's own arithmetic says sixteen such accounts empty the global
    // token wall for every real venue until midnight. Verification is set by
    // an admin, so this closes throwaway accounts outright.
    if (canReadVenue && ctx && ctx.profile
        && !(ctx.profile.google_place_id && ctx.profile.verified)) {
      return res.json({
        mode: 'refusal',
        text: unverifiedReason(ctx.profile),
        sources: [],
        question: clean.text,
      });
    }
    if (canReadVenue && !(ctx && ctx.profile)) {
      return res.json({
        mode: 'refusal',
        text: `${FEATURE_NAME} answers questions about a venue you have claimed. Claim your venue first and every answer here comes from its own numbers.`,
        sources: [],
        question: clean.text,
      });
    }

    // A follow-on is read with the turn before it ("what else" is the last
    // question with its moves set aside, "what about Wednesdays" is the last
    // question about Wednesday); anything else is answered as written. The
    // question that results is what the screens, the router and the answer
    // see. `question` in every response stays the owner's own words.
    const follow = advisorFollowOn.followOn(clean.text, prior.previous, {
      maxChars: advisorFreeText.FREE_TEXT_MAX_CHARS,
      sanitize: advisorFreeText.sanitizeQuestion,
    });
    const asked = follow.question;
    let route = await advisorFreeText.classify({ userId, question: asked });
    // "What else" after a numbers answer asks for another move, not the same
    // numbers again.
    if (follow.kind === 'else' && route.mode === 'grounded') route = { ...route, mode: 'advice' };

    // SMALL TALK is its own label, not a refusal wearing a warmer sentence.
    // The chat draws a refusal in quieter ink, and a greeting drawn that way
    // read as a decline (2026-09-02). Nothing was read and nothing was spent,
    // so there are no sources and no intent.
    if (route.mode === 'small_talk') {
      return res.json({ mode: 'small_talk', text: route.text, sources: [], question: clean.text });
    }

    if (route.mode === 'refused') {
      return res.json({ mode: 'refusal', text: route.refusal, sources: [], question: clean.text });
    }

    // GROUNDED: the existing pipeline, unchanged. Free text is another way in,
    // never a second way to answer. An offline route (advisorFreeText's own
    // reading of the question when the router could not be asked) lands here
    // too, and phrase() serves the template twin while the model is out.
    if (route.mode === 'grounded') {
      const block = await buildFactBlock(userId, route.intentId, { question: asked });
      // The owner's own words go with the facts (sanitised above, and fenced
      // inside the payload), so "was Friday any good" routed to the week
      // recap is answered about Friday.
      const answer = await withMove(
        await advisorPhrasing.phrase(block, { venueUserId: userId, question: asked }),
        route.intentId, userId, ctx, block,
      );
      return res.json({
        mode: answer.mode,
        intentId: route.intentId,
        text: answer.text,
        sources: answer.sources,
        question: clean.text,
        followUps: followUpsFor({ intentId: route.intentId, block, question: asked }),
        context: followContext(answer, asked, route.intentId, chipTactics(answer, route.intentId, block), follow.exclude),
      });
    }

    // ADVICE: trade knowledge, with any number it claims about this venue
    // checked against the venue's facts. The router may attach an intent when
    // the venue's own numbers would inform the answer; those facts ride along
    // as placeholders, and a refusal in the block is simply dropped, because
    // advice does not need the venue's data to be answerable. `ctx` is the one
    // fetched above, before the router was paid for, rather than a second
    // lookup after both calls have already been spent.
    let groundedFacts = [];
    let block = null;
    if (route.intentId) {
      block = await buildFactBlock(userId, route.intentId, { question: asked });
      groundedFacts = Array.isArray(block.facts) ? block.facts : [];
    }
    // A question about a named day gets that day's forecast beside whatever
    // its route reads: the quiet-days plan carries only the 2 quietest days,
    // so "how do I fill Thursdays" had nothing about Thursday to stand on.
    // Only when the route's own facts lack that day (a second build of the
    // week costs reads), and a failure here costs the lead, never the answer
    // (2026-10-28 second review: it ran the week twice and could 500). A
    // block that already tried a no-history venue's Week Ahead card and found
    // none is not asked again: the second read is a second paid lookup that
    // fails the same way (2026-11-03 review). Today's weekday comes off the
    // card's today for a venue with no crowd history (withNamedToday).
    //
    // The day is the one a block read against the venue's own today
    // (readingFor, 2026-11-06): "tonight" is the night the today chip
    // answers, and "next Monday" on a Monday is no day held, so nothing
    // stands for it and no lead names it. A question naming a day its route
    // did not read ("How do I fill Thursdays?" routed to no week at all)
    // reads the week's peaks, which read the day as well.
    // "Today", "tonight" and "this morning" ask about a day in advice only
    // when the question is routed to a day (the peaks, the quiet days,
    // today's outlook) and asks about the day's crowd (second review,
    // 2026-11-06): "My bartender quit this morning, what do I do?" opened on
    // today's forecast, and "Got a 1 star review today, how should I
    // respond?" paid for a second read of the week to do it, while "How do I
    // fill tonight?" is about tonight.
    const reading = roostPlaybook.askedDay(asked);
    const todayWord = (r) => Boolean(r) && (r.today || r.tomorrow || r.dayAfterTomorrow);
    const words = reading && reading.several ? reading.several : [];
    const anyToday = todayWord(reading) || words.some((w) => ['today', 'tomorrow', 'dayAfterTomorrow'].includes(w.kind));
    const dayish = Boolean(reading) && (Boolean(reading.weekday) || todayWord(reading)
      || words.some((w) => w.kind !== 'weekend' && w.kind !== 'week'));
    const asksDay = dayish && (!anyToday || (TODAY_WORD_INTENTS.has(route.intentId) && CROWD_ASKED.test(asked)));
    const readDay = (blk) => Boolean(blk) && Object.prototype.hasOwnProperty.call(blk, 'askedDay');
    let named = readDay(block) ? block.askedDay : roostPlaybook.namedWeekday(asked);
    // Two days named: the answer leads with neither (bothAnswer).
    let both = Boolean(block && block.askedDays);
    if (asksDay && !both && !(block && block.cardRead === false)
        && (named ? !groundedFacts.some((f) => f && f.value && f.value.weekday === named) : !readDay(block))) {
      try {
        const week = await buildFactBlock(userId, 'peak_hours', { question: asked });
        if (!readDay(block) && readDay(week)) named = week.askedDay;
        if (!readDay(block) && week && week.askedDays) both = true;
        const have = new Set(groundedFacts.map((f) => f && f.id));
        groundedFacts = [...groundedFacts, ...(Array.isArray(week && week.facts) ? week.facts : []).filter((f) => f && !have.has(f.id))];
      } catch (err) {
        console.warn('Advisor: the week for a named day could not be read:', err.message);
      }
    }
    // `offline` and `fallback` come from an offline route: the playbook
    // answers with no model call, and `fallback` is the sentence the owner
    // reads if it has nothing for the question.
    const answer = await advisorFreeText.advise({
      userId,
      question: asked,
      ctx,
      groundedFacts,
      intentId: route.intentId || null,
      offline: route.offline === true,
      fallback: route.fallback || null,
      exclude: follow.exclude,
      unrouted: route.unrouted === true,
      // The day as read above, when the question asks about one.
      ...(asksDay ? { askedFor: both ? null : named } : {}),
    });
    return res.json({
      mode: answer.mode,
      intentId: route.intentId || null,
      text: answer.text,
      sources: answer.sources,
      question: clean.text,
      followUps: answer.mode === 'refusal'
        ? []
        : followUpsFor({
          mode: 'advice',
          intentId: route.intentId || null,
          block,
          question: asked,
          // A playbook-only answer offers "What else could we try?", which the
          // playbook can answer; a move's own follow-up needs the model.
          followUp: answer.fromPlaybook ? ANOTHER_MOVE : (answer.followUp || null),
          topic: answer.topic || null,
        }),
      context: followContext(answer, asked, route.intentId, answer.tactics || [], follow.exclude),
    });
  } catch (err) {
    console.error('Advisor question error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Tests only: inject a fact engine without a services/advisorFacts.js on disk.
router.__setFactsForTests = (fn) => {
  router.__factsOverride = fn;
};

module.exports = router;
// The route plans, for tests. A plan is a pure function from the memoised
// builder to the entries one chip answers with, and the two that SELECT rather
// than pass through (quiet_nights refusing a level week, slow_night picking the
// slow day) are the ones worth driving directly: reaching them through the
// endpoint would mean standing up a whole database fixture to test a sort.
module.exports.__INTENT_PLANS = INTENT_PLANS;
// The bridge's step after a plan, for the live eval's stand-in bridge
// (scripts/roost/roostEval.js): the day a typed question asks about, read
// against the venue's own today, and today's entry on the card for a
// question about today.
module.exports.__forQuestion = forQuestion;
// The day words of a typed question read against the venue's own today,
// which the eval's bridge reads before its plan, as bridgeFactBlock does.
module.exports.__readingFor = readingFor;
