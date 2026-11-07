/**
 * WHAT IS WAITING ON THE PERSON READING THE NEST.
 *
 * The Nest's asks are addressed to the reader, each names one plan and opens
 * it (the hero's button and the Needs you rows, nestRows below). The Nest
 * used to know one thing, a missing vote, so an unanswered budget reached a
 * person only through the host's manual reminder and a share
 * of a bill only through the one push sent when the bill was posted. GET
 * /api/flocks now answers the other two for the reader alone (i_budget_open and
 * i_owe in routes/flocks.js): two booleans about the caller, no amount, so the
 * budget privacy rule is untouched.
 *
 * The order is the order of what costs somebody else: money a friend fronted
 * first, then the budget answer the group's number waits on, then the vote.
 *
 * Owing reads every plan, the finished ones included, because a bill is
 * usually posted the morning after and the Nest's own list has already let
 * that plan go. The budget reads live plans only: POST /api/budget/:id/submit
 * refuses a finished one, and so does the server's flag, but a plan that
 * finished while this screen was open still holds the flag it loaded with.
 *
 * Pure, so it is run by a test rather than pinned; App.js keeps the vote half
 * (needsAction) where it always was and hands it in.
 */

const LIVE = (f) => f.status !== 'completed' && f.status !== 'cancelled';

/**
 * @param {Array} flocks     every accepted plan in the list, finished ones too
 * @param {Array} voteAsks   the plans still waiting on the reader's vote
 * @returns {Array<{ flock, kind: 'owe'|'budget'|'vote' }>} most pressing first
 */
export function nestAsks(flocks, voteAsks = []) {
  const list = Array.isArray(flocks) ? flocks : [];
  const owe = list.filter((f) => f && f.iOwe === true);
  const budget = list.filter((f) => f && f.iBudgetOpen === true && f.budgetLocked !== true && LIVE(f));
  return [
    ...owe.map((flock) => ({ flock, kind: 'owe' })),
    ...budget.map((flock) => ({ flock, kind: 'budget' })),
    ...(Array.isArray(voteAsks) ? voteAsks : []).map((flock) => ({ flock, kind: 'vote' })),
  ];
}

/**
 * NEEDS YOU: every open loop on the Nest as one row each (2026-11-06).
 *
 * The single card above the list named the top ask and counted the rest
 * ("Add your budget · 2 more waiting on you"), so the second and third ask
 * were a number nobody could tap. Now each is a row that closes in one tap,
 * worded as what to do, with no count and no blame:
 *
 *   owe     "Pay your share for {plan}"
 *   budget  "Add your budget for {plan}"
 *   vote    "Vote on {plan}"
 *   invite  "{host's first name} invited you to {plan}", or "You're invited
 *           to {plan}" when the host's name did not come through
 *   how     "How was {venue}?" for a night that is over and not rated, once
 *           the night has rolled over at 4 AM (before that the plan is the
 *           hero and asks there)
 *
 * In nestAsks()'s order (owe, budget, vote), then invites, then how-was-it.
 * A plan the hero card or its same-night rows already ask about is left out:
 * one ask, said once. Votes are only ever the ones App.js's needsMyVote has
 * read, so an unread tally is never an accusation.
 *
 * Each row carries the plan's time and place for its second line, as data;
 * the words for the time come from lib/nestTime.js whenLine.
 */
// A first name reads as a friend; the full one is on the invite card itself.
const firstName = (name) => String(name || '').trim().split(/\s+/)[0];

export const NEST_ROW_TITLE = {
  owe: (f) => `Pay your share for ${f.name}`,
  budget: (f) => `Add your budget for ${f.name}`,
  vote: (f) => `Vote on ${f.name}`,
  invite: (f) => (f.host && f.host !== 'Unknown' ? `${firstName(f.host)} invited you to ${f.name}` : `You're invited to ${f.name}`),
  how: (f) => `How was ${f.venue}?`,
};

export function nestRows({ asks = [], invites = [], howWasIt = [], excludeIds = [] } = {}) {
  const skip = new Set((excludeIds || []).map(String));
  const keep = (f) => f && !skip.has(String(f.id));
  const row = (kind, f) => ({
    key: `${kind}:${f.id}`,
    kind,
    flockId: f.id,
    title: NEST_ROW_TITLE[kind](f),
    eventTime: f.eventTime || null,
    venue: f.venue && f.venue !== 'TBD' ? f.venue : null,
  });
  const seenInvite = new Set();
  return [
    ...(Array.isArray(asks) ? asks : []).filter((a) => a && keep(a.flock)).map((a) => row(a.kind, a.flock)),
    ...(Array.isArray(invites) ? invites : []).filter((f) => keep(f) && !seenInvite.has(f.id) && seenInvite.add(f.id)).map((f) => row('invite', f)),
    ...(Array.isArray(howWasIt) ? howWasIt : []).filter((f) => keep(f) && f.askHowItWas && f.venue && f.venue !== 'TBD').map((f) => row('how', f)),
  ];
}

/** How many rows show before "Show N more". */
export const NEST_ROWS_CAP = 3;

/**
 * Whether a bill the reader has just been sent leaves them owing: a bill
 * somebody else paid, not quarantined, with the reader's own share unsettled.
 * The same test the server's i_owe makes, for the bill_created event that
 * arrives between two list reads.
 */
export function owesOnBill(bill, myId) {
  if (!bill || myId == null) return false;
  if (bill.quarantined === true || bill.hasPayer === false) return false;
  const payer = bill.paidBy && bill.paidBy.id != null ? String(bill.paidBy.id) : null;
  if (!payer || payer === String(myId)) return false;
  const mine = (bill.shares || []).find((s) => String(s.userId) === String(myId));
  return !!mine && mine.settled !== true;
}
