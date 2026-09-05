/**
 * THE BILL, AS ONE CARD IN THE STREAM THAT UPDATES IN PLACE.
 *
 * WHAT IT REPLACES. Three separate surfaces, all of which go: the pinned bill
 * bar under the chat header, the ghost commit card that appeared above the
 * first message the moment a venue was confirmed, and the bill panel's own
 * header row. One card, posted once, rewritten every time somebody settles.
 * The header keeps a 24pt pill ("$84.50 . 2/5") and that pill is not this
 * component's business.
 *
 * THE GHOST STATE IS THE SAME COMPONENT. Before anyone has paid, `hasPayer`
 * is false and the card reads "Estimated share $40" with "Commit $40". After
 * somebody posts the real bill it becomes "Bill $84.50" with "Paid by Maya"
 * under it. Two cards for one object was the old shape and it is why a member
 * could see a commit card and a bill bar disagreeing about the same night.
 *
 * THE FIELD NAMES ARE THE SERVER'S, READ OFF backend/routes/billing.js
 * (GET /api/billing/:flockId), not invented here:
 *
 *   bill.hasPayer      false means NOBODY IS RECORDED AS HAVING PAID. It is
 *                      two states the schema cannot tell apart after the fact,
 *                      a ghost shell and a payer who deleted their account,
 *                      and the route deliberately describes both with one
 *                      sentence. This card must not offer a way to pay a
 *                      person who is not there, so every settle control is
 *                      behind hasPayer !== false.
 *   bill.totalWithTip  total * (1 + tip/100), or NULL when withheld.
 *   bill.totalAmount   the pre-tip figure, or NULL when withheld.
 *   bill.paidBy        { id, name }. `name` is null when the viewer has
 *                      blocked the payer.
 *   bill.fullySettled  computed over EVERY share, before the block filter.
 *   bill.settledCount  same.
 *   bill.shareCount    same.
 *   bill.shares[]      { userId, name, amount, paidAmount, outstanding,
 *                      committed, settled, settledAt }, with anyone the
 *                      viewer has blocked REMOVED.
 *
 * WHY THE COUNT IS NOT `shares.filter(settled).length`. The array is block
 * filtered and the three counts are not. Block one member of a three way
 * split, settle the other two, and a card that counts its own array declares
 * the bill square while a third of it is owed. The rule, which is the one
 * ChatDetail.js already reached after the same bug: the total is the larger
 * of the array and the server's shareCount, the settled figure is the larger
 * of the visible settled rows and the server's settledCount (an optimistic
 * local settle is ahead of the server, a hidden settled row is ahead of the
 * array, and the larger of the two is right in both directions), and the
 * "everything is square" claim is the array's only when nothing is hidden.
 *
 * WHY A WITHHELD FIGURE PRINTS NOTHING. routes/billing.js sends null for
 * every money field on a shell whose flock has fallen under three non-skipped
 * budget submissions, because a per-head figure derived from the budget
 * ceiling IS the ceiling, and budget.js re-asks that threshold on every read
 * so that a band around the last person left is not a band around one
 * person's budget. A card that renders "$null" or "$" or "$0.00" there has
 * reopened the door billing.js closed. formatMoney returns null and every
 * label that would have wrapped a figure disappears with it.
 *
 * WHAT THIS COMPONENT DOES NOT DO. No fetching, no sockets, no optimistic
 * writes. It draws the bill it is handed and calls back. The settle sheet,
 * the payment routes and the "I paid another way" branch stay where they are.
 */
import React from 'react';
import { CardShell, MemberAvatar, formatMoney } from './SystemRow';
import './cards.css';

// Kept out of the component so the tests can reason about it and so the
// integration pass can see it is the same rule ChatDetail.js applies today.
export const billTally = (bill) => {
  const shares = Array.isArray(bill?.shares) ? bill.shares : [];
  const visibleSettled = shares.filter((s) => !!s.settled).length;
  const total = Math.max(shares.length, Number(bill?.shareCount) || 0);
  const hidden = total - shares.length;
  const settled = Math.min(total, Math.max(visibleSettled, Number(bill?.settledCount) || 0));
  return {
    settled,
    total,
    all: total > 0 && (hidden === 0 ? visibleSettled === shares.length : !!bill?.fullySettled),
  };
};

// Settled by credit rather than by a tap. What this person paid on an earlier
// version of the bill already covers the share, so POST /unsettle answers 409
// with reason 'credit'. An Undo link that exists only to be refused is a dead
// control, so this state gets the plain sentence instead. The same comparison
// the route makes.
const coveredByCredit = (share) => Number(share?.paidAmount) >= Number(share?.amount);

const same = (a, b) => a != null && b != null && String(a) === String(b);

export default function BillCard({
  bill,
  viewerId,
  members,
  estimatedShare = null,
  canPayOnline,
  pendingAction = null,
  error = null,
  onSettle,
  onUndo,
  onCommit,
  onRetry,
  onOpen,
}) {
  if (!bill) return null;

  const shares = Array.isArray(bill.shares) ? bill.shares : [];
  const mine = shares.find((s) => same(s.userId, viewerId)) || null;
  const tally = billTally(bill);
  const isShell = bill.hasPayer === false;
  const viewerIsPayer = !isShell && same(bill.paidBy?.id, viewerId);
  const roster = members || {};

  const stop = (fn) => (e) => {
    e.stopPropagation();
    if (typeof fn === 'function') fn(e);
  };

  // ---------------------------------------------------------------- title
  // The shell prints the viewer's own estimated share, because that is the
  // only number that means anything to them before a bill exists. It comes
  // from their committed share row when they have one, and otherwise from the
  // `estimatedShare` the parent already holds (POST /ghost-commit answers with
  // it, and budgetStatus.ceiling is the same figure). Neither present means no
  // figure at all, never a total divided by a member count this response does
  // not carry.
  const shellFigure = formatMoney(
    typeof mine?.amount === 'number' ? mine.amount
      : (typeof estimatedShare === 'number' ? estimatedShare : null)
  );
  const billFigure = formatMoney(
    typeof bill.totalWithTip === 'number' ? bill.totalWithTip
      : (typeof bill.totalAmount === 'number' ? bill.totalAmount : null)
  );

  const title = isShell
    ? (shellFigure ? `Estimated share ${shellFigure}` : 'Estimated share')
    : (billFigure ? `Bill ${billFigure}` : 'Bill');

  const subtitle = isShell
    ? (shellFigure
      ? 'Nobody has paid yet. These are estimates from the group budget.'
      : 'Nobody has paid yet, and there is no group number to show.')
    : (bill.paidBy?.name ? `Paid by ${bill.paidBy.name}` : 'Paid by a member');

  // ---------------------------------------------------------------- footer
  // A SHELL HAS NO SETTLED COUNT. Nobody settles a bill nobody has paid, and
  // `shareCount` on a shell is the number of people who have PRE-COMMITTED,
  // not the size of the flock, so "0 of 1 settled" would be two wrong facts in
  // four words. The shell's footer is its action and nothing else.
  const footerLeft = isShell
    ? null
    : (tally.all
      ? 'All settled up'
      : (tally.total > 0 ? `${tally.settled} of ${tally.total} settled` : null));

  const settleFigure = formatMoney(
    typeof mine?.outstanding === 'number' ? mine.outstanding
      : (typeof mine?.amount === 'number' ? mine.amount : null)
  );

  const actionStyle = {
    minHeight: '44px',
    padding: '0 14px',
    borderRadius: '12px',
    border: 'none',
    background: 'var(--chat-accent)',
    color: 'var(--chat-on-fill)',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const linkStyle = {
    minHeight: '44px',
    padding: '0 8px',
    border: 'none',
    background: 'transparent',
    color: 'var(--chat-accent)',
    fontSize: '12px',
    fontWeight: 600,
    textDecoration: 'underline',
    cursor: 'pointer',
  };

  let footerRight = null;

  if (isShell) {
    // Committing to a figure nobody can see is not a thing this card will
    // offer. With a number in hand the chip is the commit; without one there
    // is no control at all.
    if (mine?.committed) {
      footerRight = (
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-amber-text)' }}>
          Pre-committed
        </span>
      );
    } else if (shellFigure && typeof onCommit === 'function') {
      footerRight = (
        <button
          type="button"
          className="hit44"
          onClick={stop(onCommit)}
          disabled={pendingAction === 'commit'}
          style={{ ...actionStyle, opacity: pendingAction === 'commit' ? 0.6 : 1 }}
        >
          {pendingAction === 'commit' ? 'Committing' : `Commit ${shellFigure}`}
        </button>
      );
    }
  } else if (viewerIsPayer) {
    // The payer has no action. What they have is a count of who has not paid
    // them back, and only while somebody has not.
    const waiting = Math.max(0, tally.total - tally.settled);
    footerRight = waiting > 0
      ? (
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          {`Waiting on ${waiting}`}
        </span>
      )
      : null;
  } else if (mine?.settled) {
    footerRight = coveredByCredit(mine)
      ? (
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-green-text)' }}>
          You&apos;re settled
        </span>
      )
      : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-green-text)' }}>Paid</span>
          {typeof onUndo === 'function' && (
            <button
              type="button"
              className="hit44"
              onClick={stop(onUndo)}
              disabled={pendingAction === 'undo'}
              style={{ ...linkStyle, opacity: pendingAction === 'undo' ? 0.6 : 1 }}
            >
              Undo
            </button>
          )}
        </span>
      );
  } else if (mine && typeof onSettle === 'function') {
    // "Mark as paid" is the honest label when the parent has told us there is
    // no payment route to hand off to: the payer has no Venmo, Cash App or
    // Zelle handle on file, so the only thing a tap can do is record it.
    // Undefined is not false, so an unstated capability keeps the normal
    // label and the sheet behind it does what it has always done.
    const label = canPayOnline === false
      ? 'Mark as paid'
      : (settleFigure ? `Settle up ${settleFigure}` : 'Settle up');
    footerRight = (
      <button
        type="button"
        className="hit44"
        onClick={stop(onSettle)}
        disabled={pendingAction === 'settle'}
        style={{ ...actionStyle, opacity: pendingAction === 'settle' ? 0.6 : 1 }}
      >
        {pendingAction === 'settle' ? 'Settling' : label}
      </button>
    );
  }

  return (
    <CardShell
      tone={tally.all ? 'settled' : 'default'}
      onOpen={onOpen}
      ariaLabel={onOpen ? `${title}. Open the bill.` : undefined}
      data-card="bill"
      data-bill-shell={isShell ? 'true' : 'false'}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: '20px' }}>
            {title}
          </div>
          <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)', lineHeight: '18px', marginTop: '2px' }}>
            {subtitle}
          </div>
        </div>

        {shares.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            {shares.map((s) => (
              <MemberAvatar
                key={s.userId}
                name={s.name}
                src={roster[s.userId]?.avatarUrl}
                color={roster[s.userId]?.color}
                size={28}
                badge={s.settled ? 'settled' : (s.committed ? 'committed' : null)}
              />
            ))}
          </div>
        )}

        {/* No count and no action is a card with no footer, not a 44px band of
            nothing. A shell whose figures the server is withholding lands
            here, and an empty reserved row would read as a control that failed
            to load. */}
        {(footerLeft || footerRight) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', minHeight: '44px' }}>
            {/* The count is the one thing on this card that changes under the
                reader without them touching it, so it announces itself. */}
            <span
              aria-live="polite"
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: tally.all ? 'var(--accent-green-text)' : 'var(--text-secondary)',
              }}
            >
              {footerLeft}
            </span>
            {footerRight}
          </div>
        )}

        {/* An error says what happened and offers the way forward. It is not a
            toast that vanishes: the action failed on this card, so the retry
            is on this card. */}
        {error && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--accent-red-text)' }}>{error}</span>
            {typeof onRetry === 'function' && (
              <button type="button" className="hit44" onClick={stop(onRetry)} style={linkStyle}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </CardShell>
  );
}
