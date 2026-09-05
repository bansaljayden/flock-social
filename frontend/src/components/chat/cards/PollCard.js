/**
 * THE VENUE VOTE, AS A CARD IN THE STREAM.
 *
 * WHAT IT REPLACES. The vote panel is a bottom sheet today, reached from a
 * Features drawer, and the only trace of an open vote in the chat is a banner
 * pinned above the first message. The sheet stays for browsing and suggesting.
 * What moves here is the vote itself: a card posted where the vote was opened,
 * rewritten in place as people vote, so scrolling back through a night shows
 * when the group decided rather than only what it decided.
 *
 * THE FOUR STATES, and how each one is decided:
 *
 *   open    nothing locked, the viewer has not voted.
 *   voted   one of the options carries voted: true. The card does not change
 *           shape, it just knows which row is yours.
 *   tie     two or more options share the top count and that count is above
 *           zero. Both leaders get the "Tied" chip and, for a host, both get
 *           "Lock it in", because a tie is exactly the moment the host has to
 *           break it and hiding the control until somebody else votes leaves
 *           the plan stuck. ChatDetail.js already refuses to call two equal
 *           rows "Leading" for the same reason.
 *   locked  `lockedName` is present. Rows stop taking votes, the header reads
 *           "Locked: Kome", and the counts stay visible as the record.
 *
 * The state is DERIVED from the options and `lockedName`, not passed in.
 * A caller that has to send both a list of counts and a state word will
 * eventually send two that disagree, and then the card is arguing with
 * itself in front of the group.
 *
 * WHERE THE NUMBERS COME FROM. `votedCount` and `memberCount` are the
 * footer's, and they are the parent's to supply: the flock roster and the
 * vote tally are two different reads and this card must not guess one from
 * the other. A vote total is not a voter total either, because a guest voting
 * from an invite link adds to a row's count without adding a name (see
 * `guestCount` on the vote rows in ChatDetail.js), so the row counts and the
 * footer count are deliberately independent figures.
 *
 * NO FIGURE THE PROPS DID NOT SUPPLY. A star only draws when the option
 * carries a numeric rating. The footer count only draws when both figures
 * really are numbers, so a tally the parent has not loaded yet prints nothing
 * rather than "0 of 8 voted". The deadline only draws when there is a
 * parseable one, and once that deadline has passed the rows stop taking
 * votes: a card that prints "Voting closed" over controls that still fire is
 * a card arguing with itself in front of the group.
 */
import React, { useEffect, useState } from 'react';
import { CardShell } from './SystemRow';
import Icons from '../../ui/Icons';
import './cards.css';

// The deadline is read once, as a number, and then answered twice: what the
// footer says, and whether the rows still take a vote. Those used to be two
// separate reads, one of them buried inside the formatter, which is how the
// card came to print "Voting closed" over rows that were still live.
const deadlineMs = (iso) => {
  if (!iso) return null;
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

const formatDeadline = (at, nowMs) => {
  if (at === null) return null;
  if (at <= nowMs) return 'Voting closed';
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === new Date(nowMs).toDateString();
  return sameDay
    ? `Closes ${time}`
    : `Closes ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

const countOf = (o) => (Number.isFinite(Number(o?.voteCount)) ? Number(o.voteCount) : 0);

export default function PollCard({
  title,
  options,
  votedCount,
  memberCount,
  deadlineAt = null,
  isHost = false,
  lockedName = null,
  onVote,
  onLock,
  onOpen,
}) {
  // A deadline is a moment, not a tick. One timeout armed for that moment, and
  // cleared on unmount, re-renders the card exactly once as voting closes, so a
  // poll sitting on screen stops taking votes without a per-second timer waking
  // the whole stream. Without it the clock below was only ever read on a render
  // something else asked for.
  const [, closeTick] = useState(0);
  useEffect(() => {
    const at = deadlineMs(deadlineAt);
    if (at === null) return undefined;
    const ms = at - Date.now();
    if (ms <= 0) return undefined;
    const t = setTimeout(() => closeTick((n) => n + 1), ms);
    return () => clearTimeout(t);
  }, [deadlineAt]);

  const rows = Array.isArray(options) ? options : [];

  // A poll with nothing to vote on is not a poll. The parent decides when a
  // vote is worth posting; this card refuses to draw an empty one rather than
  // inventing an empty state for it.
  if (rows.length === 0) return null;

  const locked = typeof lockedName === 'string' && lockedName.length > 0;
  const topCount = rows.reduce((m, o) => Math.max(m, countOf(o)), 0);
  const leaders = topCount > 0 ? rows.filter((o) => countOf(o) === topCount) : [];
  const tied = leaders.length > 1;
  const hasVoted = rows.some((o) => !!o.voted);
  const state = locked ? 'locked' : (tied ? 'tie' : (hasVoted ? 'voted' : 'open'));

  // A figure is a figure only when the parent sent a number. Number(null) is
  // 0 and so is Number(''), both finite, so a finite check on a coerced value
  // drew "0 of 8 voted" for a tally the server had not answered yet, under a
  // live region that reads it out. This is the rule formatMoney already uses.
  const isCount = (v) => typeof v === 'number' && Number.isFinite(v);
  const haveVoted = isCount(votedCount);
  const haveMembers = isCount(memberCount);

  // The bar reads as a share of the vote, so the denominator is the number of
  // people who have voted when we know it and the leading row's count when we
  // do not. Never zero, because a divide by zero paints a bar of NaN percent.
  const denominator = Math.max(haveVoted ? votedCount : 0, topCount, 1);

  const footerCount = (haveVoted && haveMembers)
    ? `${votedCount} of ${memberCount} voted`
    : null;

  // One read of the clock, two answers off it. A card that prints "Voting
  // closed" over rows that still fire is a card arguing with itself, so the
  // footer sentence and the rows' read-only state come from the same compare,
  // on a render the timeout above guarantees will happen at the deadline.
  const nowMs = Date.now();
  const closesAt = deadlineMs(deadlineAt);
  const deadline = formatDeadline(closesAt, nowMs);
  const closed = closesAt !== null && closesAt <= nowMs;

  const stop = (fn, arg) => (e) => {
    e.stopPropagation();
    if (typeof fn === 'function') fn(arg);
  };

  return (
    <CardShell
      onOpen={onOpen}
      ariaLabel={onOpen ? 'Open the venue vote' : undefined}
      data-card="poll"
      data-poll-state={state}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div
          className="chat-truncate"
          style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: '20px' }}
        >
          {locked ? `Locked: ${lockedName}` : (title || 'Where are we going?')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows.map((o) => {
            const count = countOf(o);
            const pct = Math.max(0, Math.min(100, Math.round((count / denominator) * 100)));
            const isLeader = !locked && topCount > 0 && count === topCount;
            const canVote = !locked && !closed && typeof onVote === 'function';
            const rating = typeof o.rating === 'number' && Number.isFinite(o.rating) ? o.rating : null;

            return (
              <div
                key={o.id ?? o.name}
                className={`chat-card-row${canVote ? ' chat-card-tappable' : ''}`}
                role={canVote ? 'button' : undefined}
                tabIndex={canVote ? 0 : undefined}
                aria-pressed={canVote ? !!o.voted : undefined}
                onClick={canVote ? stop(onVote, o) : undefined}
                onKeyDown={canVote
                  ? (e) => {
                    // Only a key pressed on the row itself votes. "Lock it in"
                    // is rendered inside this row and its keydown bubbles
                    // here, so without the guard a host reaching for the lock
                    // with the keyboard cast a vote for that option and
                    // onLock was never called. stop() covers the click path
                    // only.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onVote(o);
                    }
                  }
                  : undefined}
                style={{
                  position: 'relative',
                  overflow: 'hidden',
                  minHeight: '44px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '0 12px',
                  borderRadius: '12px',
                  boxSizing: 'border-box',
                  border: o.voted
                    ? '1.5px solid var(--chat-accent)'
                    : '1px solid var(--chat-card-border)',
                  // The track is the unfilled part of the count bar. It is a
                  // real surface rather than transparent so that the fill
                  // reads as a proportion of something instead of a stripe
                  // floating on the card.
                  backgroundColor: 'var(--chat-vote-track)',
                }}
              >
                <span
                  aria-hidden="true"
                  className="chat-poll-bar"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${pct}%`,
                    backgroundColor: 'var(--chat-vote-fill)',
                  }}
                />

                <span
                  className="chat-truncate"
                  style={{ position: 'relative', flex: 1, fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}
                >
                  {o.name}
                </span>

                {rating !== null && (
                  <span
                    style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '3px', flexShrink: 0, fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}
                  >
                    {Icons.starFilled('var(--accent-amber-text)', 12)}
                    {rating.toFixed(1)}
                  </span>
                )}

                {count > 0 && (
                  <span
                    style={{ position: 'relative', flexShrink: 0, fontSize: '13px', fontWeight: 700, color: o.voted ? 'var(--chat-accent)' : 'var(--text-secondary)' }}
                  >
                    {count}
                  </span>
                )}

                {!locked && tied && isLeader && (
                  <span
                    style={{ position: 'relative', flexShrink: 0, fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}
                  >
                    Tied
                  </span>
                )}

                {!locked && isHost && isLeader && typeof onLock === 'function' && (
                  <button
                    type="button"
                    className="hit44"
                    onClick={stop(onLock, o)}
                    style={{
                      position: 'relative',
                      flexShrink: 0,
                      padding: '5px 10px',
                      borderRadius: '10px',
                      border: 'none',
                      background: 'var(--chat-accent)',
                      color: 'var(--chat-on-fill)',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Lock it in
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {(footerCount || deadline) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <span aria-live="polite" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {footerCount}
            </span>
            <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-tertiary)' }}>
              {deadline}
            </span>
          </div>
        )}
      </div>
    </CardShell>
  );
}
