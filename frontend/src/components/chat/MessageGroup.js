import React from 'react';
import MessageRow from './MessageRow';
import './chat.css';

/**
 * MessageGroup: one run. The name once, the coloured bar down the whole run,
 * and the rows.
 *
 * WHAT THIS REPLACES. The per-message header both screens draw: an avatar, the
 * sender's name, a bullet and a time, above every single bubble. In the
 * capture a person's name appears once per run and the only thing tying the
 * rest of the run to them is a 1.7 wide bar in their colour. That bar is the
 * whole idea, so the numbers below are not decoration.
 *
 * THE MEASUREMENTS, and how the two that look arbitrary were derived.
 * Everything is measured in points at 3x, which is CSS px on iOS. The tokens
 * live in chat.css.
 *
 *   x 9.3   bar left edge, 1.7 wide, so its right edge is 11
 *   x 18    content left edge, a 7 gutter off the bar
 *   x 22    the name label, four further in than the body
 *   7       name baseline to bar top
 *   4       bar top to the first text cap
 *   4 to 5  bar overshoot past the last baseline
 *   16      last baseline to the next run's name cap top
 *   11      bar bottom to that same cap top
 *
 * The label's own box is 12 tall around an 11.5 face, which puts its baseline
 * 8.9 below the box top and its cap top 0.9 below it. A 14 / 19 line box puts
 * its first cap 3.5 below its top and its baseline 13 below it, so the box
 * ends 6 below the last baseline.
 *
 *   label margin-bottom: 7 (baseline to bar top) + 4 (bar top to cap) minus
 *   the 3.1 of label box below its baseline and the 3.5 of line box above its
 *   cap, which is 4.4.
 *
 *   bar: top -0.5 of the rows block (0.5 above it, which is 4 above the first
 *   cap), bottom inset 9, which is the 8 every row reserves for reactions plus
 *   1, landing it 5 below the last baseline. The last two measurements agree
 *   only at that value, which is the check that this reading of them is right.
 *
 *   run gap: the next name's cap top sits 16 below the last baseline, the rows
 *   block already ends 8 + 6 below it, so the group's own bottom margin is
 *   1 and the last row in the run gives up its 5. Almost all of the visible
 *   gap between runs is the reserved reaction space, which is why the space
 *   does not read as waste.
 *
 * SYSTEM RUNS. `run.isSystem` gets no name, no bar and no gestures: centred
 * uppercase 10 on a 20 pitch, in the tertiary colour. A plan event belongs to
 * the room, and drawing it under a person's name in a person's colour would
 * be a claim about who said it that the server never made.
 *
 * PROPS
 *   run           one entry from groupRows
 *   colour        the run's colour. The viewer's own colour for an own run,
 *                 the member's for anyone else. Always passed in, never
 *                 derived here and never a literal.
 *   showName      draw the name label. Default true. A DM that wants the
 *                 stream barer can turn it off; the bar still identifies.
 *   renderStatus  (message) => node or null. Asked about EVERY message in the
 *                 run. The last one's node is drawn under the whole run; any
 *                 other row's is drawn under that row. See the note beside the
 *                 call for why the two are not the same place.
 *   myId          the viewer's user id, for the rows' own-reaction state.
 *                 Optional: without it a pill says how many reacted and makes
 *                 no claim about whether the viewer is one of them.
 *   renderCard, onLongPress, onSwipeReply, onOpenImage, onQuoteTap,
 *   onReactionTap are passed straight to each row.
 */
function MessageGroup({
  run,
  colour = 'var(--chat-name-fallback)',
  showName = true,
  myId = null,
  renderCard,
  renderStatus,
  onLongPress,
  onSwipeReply,
  onOpenImage,
  onQuoteTap,
  onReactionTap,
}) {
  if (!run || !Array.isArray(run.messages) || run.messages.length === 0) return null;

  if (run.isSystem) {
    /* A system row gets the same `renderCard` door every other row gets, so
       the ones that are really cards (an SOS notice, a location that is still
       running, a budget that just locked) can be drawn by whoever owns them.
       What is left over is a sentence, and a sentence is drawn here. */
    return (
      <div style={{ padding: '4px var(--chat-content-x) 8px' }}>
        {run.messages.map((m) => {
          const node = renderCard ? renderCard(m) : null;
          if (node) return <div key={m.id}>{node}</div>;
          return (
          <p
            key={m.id}
            style={{
              margin: 0,
              textAlign: 'center',
              fontSize: 'var(--chat-notice-size)',
              lineHeight: 'var(--chat-notice-line)',
              fontWeight: 600,
              letterSpacing: '0.7px',
              textTransform: 'uppercase',
              color: 'var(--chat-notice)',
            }}
          >
            {m.text}
          </p>
          );
        })}
      </div>
    );
  }

  const last = run.messages.length - 1;

  /* THE STATUS BELONGS UNDER THE RUN, NOT INSIDE IT. Two reasons, and the
     second is the one that decided it. It lines up at 22 with the name label,
     which it cannot do from inside the content block that starts at 18. And
     the coloured bar has to stop at the last message: a bar spanning a
     "Delivered" underneath it would be claiming the receipt is something the
     sender said. So the status is drawn after the block the bar spans.

     A FAILED SEND IS NOT A RECEIPT, and it is why the other rows are asked as
     well. The receipt does sit under the newest own message, which is always
     last. "Didn't send", with its Retry and Remove, sits under the message
     that did not send, and that one need not be last: send while offline so it
     fails, reconnect, send again, and both rows are yours on the same day, so
     they are one run with the failed one in the middle. Asking about the last
     row only would leave it dimmed with no way to retry it and no way to drop
     it. Those rows carry their status inside the block, pulled back to the
     name's x 22 by the negative inset below, so it lines up with the run's own
     status word underneath. */
  const statusNode = renderStatus ? renderStatus(run.messages[last]) : null;

  const rowStatus = (m) => {
    const node = renderStatus ? renderStatus(m) : null;
    if (!node) return null;
    return <div style={{ marginLeft: 'calc(-1 * var(--chat-content-x))' }}>{node}</div>;
  };

  return (
    <div
      data-run-sender={run.senderId == null ? '' : String(run.senderId)}
      style={{ marginBottom: 'calc(var(--chat-run-gap) - var(--chat-reaction-overlap))' }}
    >
      {showName && (
        <div
          style={{
            paddingLeft: 'var(--chat-name-x)',
            marginBottom: '4.4px',
            fontSize: 'var(--chat-name-size)',
            lineHeight: 'var(--chat-name-line)',
            fontWeight: 600,
            letterSpacing: 'var(--chat-name-track)',
            textTransform: 'uppercase',
            color: colour,
          }}
        >
          {run.senderName}
        </div>
      )}

      <div style={{ position: 'relative', paddingLeft: 'var(--chat-content-x)' }}>
        {/* The bar. Decorative: the name above it already says whose run this
            is, so a screen reader hearing "line" here would be noise. */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 'var(--chat-bar-x)',
            top: '-0.5px',
            bottom: 'calc(var(--chat-reaction-overlap) + 1px)',
            width: 'var(--chat-bar-w)',
            borderRadius: '1px',
            background: colour,
          }}
        />
        {run.messages.map((m, i) => (
          <MessageRow
            key={m.id}
            message={m}
            isMine={!!run.isMine}
            colour={colour}
            myId={myId}
            renderCard={renderCard}
            onLongPress={onLongPress}
            onSwipeReply={onSwipeReply}
            onOpenImage={onOpenImage}
            onQuoteTap={onQuoteTap}
            onReactionTap={onReactionTap}
            status={i === last ? null : rowStatus(m)}
            gapBelow={i === last ? '0px' : 'var(--chat-row-gap)'}
          />
        ))}
      </div>
      {statusNode}
    </div>
  );
}

/* Memoised because the screen above this one re-renders on every socket event
   it holds state for, and one person typing fires several of them. groupRows
   rebuilds a fresh run object on each, so the shallow compare only starts
   paying once the caller memoises the run array and passes stable callbacks.
   Until it does, this costs one comparison per run and changes nothing. */
export default React.memo(MessageGroup);
