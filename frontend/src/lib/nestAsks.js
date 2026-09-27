/**
 * WHAT IS WAITING ON THE PERSON READING THE NEST.
 *
 * The card at the top of the Nest is addressed to the reader, names one plan
 * and opens it. It used to know one thing, a missing vote, so an unanswered
 * budget reached a person only through the host's manual reminder and a share
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
 * The words on the card for the ask it leads with. `more` is how many other
 * asks are behind it. A card of votes alone keeps the sentence it has always
 * had, so nothing changes for somebody with no budget or bill waiting.
 */
export function nestAskLine(asks) {
  if (!asks || asks.length === 0) return '';
  const top = asks[0];
  const more = asks.length - 1;
  if (asks.every((a) => a.kind === 'vote')) {
    return more === 0 ? 'Needs your vote' : `${more} other ${more === 1 ? 'flock needs' : 'flocks need'} your vote too`;
  }
  const line = top.kind === 'owe'
    ? 'You still owe your share of the bill'
    : top.kind === 'budget'
      ? 'Add your budget'
      : 'Needs your vote';
  return more === 0 ? line : `${line} · ${more} more waiting on you`;
}

/** The chip beside it, one word or two, in the Nest card's own register. */
export const NEST_ASK_CHIP = { owe: 'Settle Up', budget: 'Budget', vote: 'Needs Votes' };

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
