// WHICH OF A VENUE'S DEALS A PERSON SEES, decided in one place (2026-11-03).
//
// A deal is what a venue's owner posts from the venue side of Flock (POST
// /api/venue-dashboard/promotions): a title, an optional description, and a
// time slot and days, each a choice from the editor's list or, with its Custom
// choice, the owner's own words. Until now one surface showed them, the venue
// page (GET /api/venue-dashboard/public-promotions/:placeId), and its rules
// lived inside that route. A deal now also rides on a venue's option in a
// flock's vote (routes/venues.js, sockets/handlers.js) and on the venues
// Birdie's search hands the model and the cards (routes/ai.js). Three copies of
// the rules would drift, so all three read them here, and the venue page reads
// them through the same function the other two do.
//
// THE RULES. These are the venue page's, unchanged:
//   * Written by the holder of a VERIFIED claim on this same place. The join is
//     on the author's own profile, not on the place id alone, so an unverified
//     claimant's deal cannot ride someone else's verified claim, and an
//     earlier owner's deal does not ride the next owner's badge (audit
//     2026-08-12, round 4).
//   * By an author who is not banned. "Ban user" on the moderation console
//     touches users.is_banned and nothing else, so the ban is read here, the
//     way the story and profile reads already read it (venue-owner audit,
//     2026-09-05).
//   * Switched on and not taken down. `active` goes false when an owner deletes
//     a deal a report is still open on (the row is kept as evidence and must
//     answer like a deleted one), and `is_hidden` is a moderator's takedown.
//   * NO PLAN IS READ. Deals are free on every plan (VENUE-PRICING.md section
//     4), so serving one depends on who wrote it, never on what they pay; a plan
//     read here would only be a way for a lapsed card to take a venue's deal off
//     its own page.
//   * Newest first, at most DEALS_PER_VENUE a venue.
//   * A DRINK DEAL REACHES ONLY AN ACCOUNT WE KNOW IS 21 (utils/over21.js
//     promotionIsOver21, which reads the title, the description, the time slot
//     and the days; App Store Guideline 1.4.3). Left out for everyone else, an
//     account with no date of birth included, which is every account the
//     iPhone app makes. The birthday is read only when a drink deal is among
//     the deals, so a set without one costs no extra query.
//
// NO CLOCK. Nothing about a deal is a time the server can read. Its time slot
// and days are words ("Happy Hour", "Weekdays", "5 to 7pm", "Tuesday to
// Thursday") and no start or end is stored, so the venue page has always shown
// every live deal with its words beside it and never judged whether it is on
// right now. The surfaces below do the same: a deal is live from the moment its
// owner posts it until the owner deletes it or a moderator takes it down. The
// clock this file is handed (`now`) is the one the viewer's age is read on.
//
// TWO STATEMENTS, ONE SET OF RULES. One venue is read with the statement the
// venue page has always sent, its place id the only parameter. Many venues are
// read with one statement, ranked per place by the same order and cut at the
// same count. Both are built from the pieces below, so a rule added to one is
// added to both, and __tests__/venueDealsParity.test.js runs the venue page and
// the batch side by side on a real database.
const pool = require('../config/database');
const { isPlaceIdShaped } = require('./places');
const { promotionIsOver21, viewerKnownOver21, viewersKnownOver21 } = require('./over21');

const DEALS_PER_VENUE = 100;
// The most places one batch reads. A vote has a handful of options and a
// Birdie search returns eight; this only bounds a caller that passes more.
const MAX_BATCH_PLACES = 50;

// The columns a deal is served with, which are the columns the venue page has
// always answered with. Nothing about the owner: not their account id, not the
// view count, not the flags.
const DEAL_COLUMNS = 'p.id, p.title, p.description, p.time_slot, p.days';
const SERVED_DEAL_JOINS = `FROM venue_promotions p
       JOIN venue_profiles vp ON vp.user_id = p.venue_user_id
         AND vp.google_place_id = p.google_place_id
         AND vp.verified = true
       JOIN users ou ON ou.id = vp.user_id AND ou.is_banned IS NOT TRUE`;
const SERVED_DEAL_FILTER = 'p.active = true AND COALESCE(p.is_hidden, false) = false';
// Newest first. The id breaks a tie: two deals written in one transaction share
// a created_at, and without it the two statements could list them differently.
const DEAL_ORDER = 'p.created_at DESC, p.id DESC';

const ONE_VENUE_DEALS_SQL = `SELECT ${DEAL_COLUMNS} ${SERVED_DEAL_JOINS}
       WHERE p.google_place_id = $1 AND ${SERVED_DEAL_FILTER}
       ORDER BY ${DEAL_ORDER}
       LIMIT ${DEALS_PER_VENUE}`;

const MANY_VENUE_DEALS_SQL = `SELECT d.id, d.title, d.description, d.time_slot, d.days, d.google_place_id FROM (
         SELECT ${DEAL_COLUMNS}, p.google_place_id,
                ROW_NUMBER() OVER (PARTITION BY p.google_place_id ORDER BY ${DEAL_ORDER}) AS deal_rank
         ${SERVED_DEAL_JOINS}
         WHERE p.google_place_id = ANY($1::text[]) AND ${SERVED_DEAL_FILTER}
       ) d
       WHERE d.deal_rank <= ${DEALS_PER_VENUE}
       ORDER BY d.google_place_id, d.deal_rank`;

// The place ids worth asking about: real place ids (the venue page refuses any
// other with a 400, so no other can have a page), each once, in the order given.
function askablePlaceIds(placeIds) {
  const out = [];
  for (const id of Array.isArray(placeIds) ? placeIds : []) {
    if (isPlaceIdShaped(id) && !out.includes(id)) out.push(id);
    if (out.length === MAX_BATCH_PLACES) break;
  }
  return out;
}

// Every deal each place serves to anyone, before the 21 rule, as a Map from
// place id to its deals in the venue page's order. A place with none is absent.
// One statement whatever the number of places, and none for an empty list. A
// failed read throws: the caller decides what a missing answer costs. The rows
// are the statement's own, the batch's without the place id it is grouped by,
// so a deal has the same five fields whichever statement read it.
async function servableDeals(placeIds, db = pool) {
  const ids = askablePlaceIds(placeIds);
  const byPlace = new Map();
  if (ids.length === 0) return byPlace;
  if (ids.length === 1) {
    const { rows } = await db.query(ONE_VENUE_DEALS_SQL, [ids[0]]);
    if (rows.length) byPlace.set(ids[0], rows);
    return byPlace;
  }
  const { rows } = await db.query(MANY_VENUE_DEALS_SQL, [ids]);
  for (const { google_place_id: placeId, ...deal } of rows) {
    if (!byPlace.has(placeId)) byPlace.set(placeId, []);
    byPlace.get(placeId).push(deal);
  }
  return byPlace;
}

const hasDrinkDeal = (byPlace) => [...byPlace.values()].some((deals) => deals.some(promotionIsOver21));

// What a viewer sees of `byPlace`: all of it when we know they are 21,
// otherwise every deal but the drink deals. A place left with nothing is
// absent, the way a place with no deals is.
function dealsSeenBy(byPlace, knownOver21) {
  if (knownOver21) return byPlace;
  const seen = new Map();
  for (const [placeId, deals] of byPlace) {
    const kept = deals.filter((d) => !promotionIsOver21(d));
    if (kept.length) seen.set(placeId, kept);
  }
  return seen;
}

// The deals each place shows ONE viewer, as a Map from place id to deals.
// `viewer` is { userId }. The venue page calls this with its one place id.
async function activeDealsForVenues(placeIds, viewer, { db = pool, now = new Date() } = {}) {
  const byPlace = await servableDeals(placeIds, db);
  if (!hasDrinkDeal(byPlace)) return byPlace;
  return dealsSeenBy(byPlace, await viewerKnownOver21(db, viewer ? viewer.userId : null, now));
}

// The same for MANY viewers at once, for a payload that goes to every member of
// a plan tailored to each: one deals statement, and one birthday read for all
// of them, only when a drink deal is among the deals. Answers a function from a
// viewer's id to that viewer's Map; an id not in `userIds` reads as not known
// to be 21.
async function activeDealsForViewers(placeIds, userIds, { db = pool, now = new Date() } = {}) {
  const byPlace = await servableDeals(placeIds, db);
  if (!hasDrinkDeal(byPlace)) return () => byPlace;
  const over21 = await viewersKnownOver21(db, userIds, now);
  const withoutDrinks = dealsSeenBy(byPlace, false);
  return (userId) => (over21.has(Number(userId)) ? byPlace : withoutDrinks);
}

// THE ONE LINE A VOTE OPTION OR A BIRDIE CARD CARRIES: the newest deal the
// viewer may see, as its title and when it runs. The description stays on the
// venue page, where there is room for it. Null for no deal.
function leadDeal(deals) {
  const d = Array.isArray(deals) ? deals[0] : null;
  if (!d || typeof d.title !== 'string' || !d.title.trim()) return null;
  const words = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { title: d.title.trim(), time_slot: words(d.time_slot), days: words(d.days) };
}

// leadDeal for every place in a Map from activeDealsForVenues or a viewer's
// answer from activeDealsForViewers. A place with no deal is absent.
function leadDeals(byPlace) {
  const out = new Map();
  for (const [placeId, deals] of byPlace instanceof Map ? byPlace : []) {
    const d = leadDeal(deals);
    if (d) out.set(placeId, d);
  }
  return out;
}

module.exports = {
  DEALS_PER_VENUE,
  MAX_BATCH_PLACES,
  ONE_VENUE_DEALS_SQL,
  MANY_VENUE_DEALS_SQL,
  activeDealsForVenues,
  activeDealsForViewers,
  leadDeal,
  leadDeals,
};
