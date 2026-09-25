/**
 * BILL SHARE ARITHMETIC.
 *
 * This lived at the top of screens/ChatDetail.js, and App.js imported it from
 * there as a named export. That one static named import was enough to pin the
 * entire 3,700-line chat screen into the boot chunk, because a module cannot
 * be code-split while something reads a value out of it synchronously. Five
 * lines of arithmetic were holding ~20 KB gzipped on the critical path of
 * every app launch.
 *
 * It belongs here anyway. src/lib is where the app's pure math lives, it has
 * no React in it, and both readers of this function are reducers rather than
 * anything to do with drawing a chat.
 */

/**
 * What a share still owes once its settlement is taken back: the share, less
 * the credit carried on it, never below zero.
 *
 * GET serves every settled row with `outstanding: 0`, and the socket reducers
 * that flipped the settled flag alone left that zero in place, so a $100 share
 * whose settlement was withdrawn read "Settle Up - $0.00" (adversarial audit
 * round 2, 2026-09-05). Both reducers, in ChatDetail and in App.js, now
 * recompute through this one function so they cannot drift apart again.
 *
 * A share with no numeric `amount` is not something this can compute, so it
 * hands back whatever the server said rather than inventing a number.
 */
export const owedOn = (s) => {
  if (typeof s?.amount !== 'number') return s?.outstanding;
  const paid = Number(s.paidAmount) > 0 ? Number(s.paidAmount) : 0;
  return Math.max(0, Math.round((s.amount - paid) * 100)) / 100;
};

/**
 * Whether a bill is an ESTIMATE: a ghost-commit shell that nobody has posted,
 * whose every figure is the group budget rather than anything anybody paid.
 *
 * `hasPayer: false` does not say that on its own. It is also a real bill whose
 * payer deleted their account (bill_splits.paid_by is ON DELETE SET NULL), and
 * that bill keeps its total and its rows: somebody rang it up and people may
 * already have paid on it. Reading it as an estimate put "~$40 each" off the
 * budget over a $180 dinner and "Nobody has paid yet" over rows marked paid.
 * GET /api/billing/:flockId tells the two apart with `estimate`, which is false
 * on that bill. A body without the field is read the old way, as an estimate:
 * an older server, and the stand-in the chat draws before a shell exists.
 *
 * A quarantined bill is never drawn as an estimate either (see isQuarantinedBill).
 */
export const isEstimateBill = (bill) => !!bill && bill.hasPayer === false && bill.estimate !== false
  && bill.quarantined !== true;

/**
 * Whether a bill is QUARANTINED: one from before August 27, when an early
 * version of the pre-commit could copy one person's budget answer into it.
 * The server sends its members' names and no amount, total, flag or count, and
 * refuses every change to it, so it is drawn as a bill whose amounts are no
 * longer shown, with nothing to settle, commit or edit.
 */
export const isQuarantinedBill = (bill) => !!bill && bill.quarantined === true;

/**
 * The one figure an estimate (see isEstimateBill) honestly stands for: a
 * per-person estimate. A posted bill has none, so it gets null, including one
 * whose payer has since deleted their account.
 *
 * Every share on a shell is the settled budget ceiling as it stood when that
 * person committed, and the shell's total is that times the head count at the
 * first commit. So the total is not a bill anybody rang up, the rows do not add
 * up to it, and nobody owes anything yet; the per-person estimate is the only
 * number that means something. The live settled ceiling comes first, because it
 * is what the budget sheet shows beside it and a shell row can be older than
 * it (a shell left over from before the budget was started over). The viewer's
 * own committed row is the fallback, and then nothing: a withheld figure is not
 * turned into one. The bill card and the chat header both read this, so they
 * cannot name two different amounts for one night.
 */
export const shellEstimate = (bill, viewerId, estimatedShare) => {
  if (bill && !isEstimateBill(bill)) return null;
  if (typeof estimatedShare === 'number' && Number.isFinite(estimatedShare) && estimatedShare > 0) {
    return estimatedShare;
  }
  const shares = Array.isArray(bill?.shares) ? bill.shares : [];
  const mine = viewerId == null ? null : shares.find((s) => s && String(s.userId) === String(viewerId));
  return typeof mine?.amount === 'number' && Number.isFinite(mine.amount) ? mine.amount : null;
};
