import React, { useCallback, useEffect, useRef, useState } from 'react';
import './chat.css';

/**
 * MessageRow: one message. Text, or a photo, or a card the parent supplies.
 *
 * WHAT THIS REPLACES. The bubble in `screens/ChatDetail.js` and its twin in
 * `screens/DmDetail.js`: a 34px avatar, a name, a bullet, a timestamp and a
 * rounded rectangle with a shadow, per message, on both sides. The capture has
 * none of that. A message is a line of 14 / 19 text at the run's content edge,
 * and the only chrome it ever carries is a reply quote above it and reaction
 * pills hanging off its bottom edge.
 *
 * THE RESERVED SPACE UNDER EVERY ROW. Reactions are drawn out of flow,
 * `--chat-reaction-h` tall, bottom aligned to a row that always reserves
 * `--chat-reaction-overlap` below its content. Half of each pill sits over the
 * message and half sits in the reserved space, so the first reaction on a
 * message moves nothing: no reflow, no scroll jump, no other message stepping
 * down. That is why the reservation is unconditional, and it is also why the
 * overlap token has to stay exactly half the height token if either is ever
 * re-measured. They are 16 and 8 today.
 *
 * PHOTOS RESERVE THEIR SHAPE. A photo whose aspect ratio the row knows gets a
 * box of exactly that ratio before the bytes arrive. A photo whose ratio it
 * does not know gets a 4:5 box and is drawn `contain` inside it, so the box
 * never resizes on load. The alternative, measuring the image once it lands
 * and resizing to fit, is one jump per photo in a scrolling list, which is the
 * thing this is built to avoid. Put `image_width` and `image_height` (or
 * `image_aspect`) on the row and it gets the exact shape instead.
 *
 * GESTURES. Long press is 350ms, swipe right is a 48px threshold, and both are
 * REPORTED, not handled: this file builds no menu and inserts no quote bar. It
 * calls `onLongPress(message, detail)` and `onSwipeReply(message)` and stops.
 *
 *   The touch handlers are the real ones, because this ships inside a
 *   Capacitor WebView on a phone. The mouse pair exists so the gesture is
 *   reachable in the browser build and in a test, and it is locked out for
 *   700ms after any touch, because iOS synthesises a mouse sequence after a
 *   tap and without the lock every real long press would fire twice.
 *
 *   A LONG PRESS SWALLOWS THE CLICK BEHIND IT. The browser still dispatches a
 *   click on release, so without this a press held over a photo would open the
 *   full screen viewer underneath the menu the press just asked for, and a
 *   press held over a reaction pill would toggle the reaction. The flag is set
 *   when the press fires and cleared at the start of the next press, so a
 *   gesture that never produces a click cannot swallow a later real tap.
 *
 *   NO NESTED INTERACTIVES. An earlier draft made the whole message body a
 *   button and read the actions menu off a click with `detail === 0`, which is
 *   the keyboard-activation signature. It had to go: a row can hold a card the
 *   parent renders, cards hold buttons, and a button inside a button is
 *   invalid HTML that React will not lay out predictably. So the message body
 *   is plain markup, the photo is its own button that opens the viewer, and
 *   the actions menu has one dedicated door: `.chat-actions-key`, clipped out
 *   of sight until it takes focus. Every row gets the same door, sighted
 *   keyboard users can see it when they land on it, and nothing nests.
 *
 * PROPS
 *   message       one row in the shape mapFlockRow / mapDmRow already produce
 *   isMine        the viewer sent it
 *   colour        the sender's colour, for the reply quote rule and for the
 *                 outline on a reaction the viewer owns
 *   myId          the viewer's user id. Optional, and its absence is a real
 *                 state: a pill then says how many people reacted and claims
 *                 nothing about whether the viewer is one of them.
 *   renderCard    (message) => node. Venue cards, bills, polls, live location.
 *                 Anything this module does not own is drawn by the parent.
 *   onLongPress   (message, { source, rect }) => void
 *   onSwipeReply  (message) => void
 *   onOpenImage   (message) => void, the full screen viewer. Without it the
 *                 photo is not a control at all, so it carries its own alt
 *                 text instead of a button name promising a viewer.
 *   onQuoteTap    (replyTo) => void, jump to the quoted message. Without it
 *                 the quote is plain markup, for the same reason.
 *   onReactionTap (emoji, message) => void
 *   status        optional node rendered under this row. MessageGroup passes
 *                 one for any row that is NOT last in its run, which in
 *                 practice is a failed send: the run's own status is drawn
 *                 under the whole run so the coloured bar can stop short of
 *                 it.
 *   gapBelow      space to the next row. MessageGroup passes 0 for the last
 *                 row in a run; see the note beside it.
 */

/**
 * One pill per emoji, counting people.
 *
 * Lifted from `screens/ChatDetail.js`, which is where the shape was worked out
 * and where the long comment explaining it lives. It is duplicated here rather
 * than imported because importing it would pull a 2,400 line screen into a
 * presentational module, and that screen is the thing this module replaces.
 * When the integration pass retires ChatDetail's own list, its copy goes and
 * this one is the survivor.
 *
 * Tolerant of a bare emoji string on purpose: an older cached payload that
 * still holds strings degrades to a pill with no owner rather than handing
 * React an object child, which it refuses outright.
 */
export function groupReactions(reactions) {
  const byEmoji = new Map();
  for (const r of reactions || []) {
    const emoji = typeof r === 'string' ? r : (r && r.emoji);
    if (!emoji) continue;
    if (!byEmoji.has(emoji)) byEmoji.set(emoji, { emoji, count: 0, userIds: [] });
    const g = byEmoji.get(emoji);
    g.count += 1;
    if (typeof r === 'object' && r && r.user_id != null) g.userIds.push(r.user_id);
  }
  return [...byEmoji.values()];
}

/** The photo on this row, whichever field it arrived in. */
export function imageOf(message) {
  if (!message) return null;
  return message.thumb || message.image || message.thumb_url || message.image_url || null;
}

/** Known aspect ratio, or null. Never guessed from the bytes after they land. */
export function aspectOf(message) {
  if (!message) return null;
  if (typeof message.image_aspect === 'number' && message.image_aspect > 0) return message.image_aspect;
  const w = Number(message.image_width);
  const h = Number(message.image_height);
  if (w > 0 && h > 0) return w / h;
  return null;
}

export const LONG_PRESS_MS = 350;
export const SWIPE_THRESHOLD = 48;
const SWIPE_MAX = 64;
const SLOP = 8;
const MOUSE_LOCKOUT_MS = 700;

function MessageRow({
  message,
  isMine = false,
  colour = 'var(--chat-name-fallback)',
  myId = null,
  renderCard,
  onLongPress,
  onSwipeReply,
  onOpenImage,
  onQuoteTap,
  onReactionTap,
  status,
  gapBelow = 'var(--chat-row-gap)',
}) {
  const hostRef = useRef(null);
  const timerRef = useRef(null);
  const originRef = useRef(null);
  const cancelledRef = useRef(false);
  const lastTouchRef = useRef(0);
  const suppressClickRef = useRef(false);
  const dragRef = useRef(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  /* The click a finger gesture leaves behind. Spent by the first child control
     it reaches, so a long press held over a photo, a quote or a reaction does
     not also fire that control on release. The keyboard door is exempt: it is
     activated BY a click and there is no second one behind it. */
  const consumeClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  const fireLongPress = useCallback((source) => {
    if (!onLongPress) return;
    if (source !== 'keyboard') suppressClickRef.current = true;
    const node = hostRef.current;
    const rect = node && typeof node.getBoundingClientRect === 'function'
      ? node.getBoundingClientRect()
      : null;
    onLongPress(message, { source, rect });
  }, [onLongPress, message]);

  const startPress = useCallback((x, y, source) => {
    cancelledRef.current = false;
    // A new press starts clean, so an unspent suppression cannot outlive the
    // gesture that armed it and eat a genuine tap later.
    suppressClickRef.current = false;
    originRef.current = { x, y };
    clearTimer();
    if (!onLongPress) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (cancelledRef.current) return;
      fireLongPress(source);
    }, LONG_PRESS_MS);
  }, [clearTimer, fireLongPress, onLongPress]);

  const setDrag = (px) => {
    dragRef.current = px;
    setDragX(px);
  };

  const onTouchStart = (e) => {
    lastTouchRef.current = Date.now();
    const t = e.touches && e.touches[0];
    if (!t || e.touches.length > 1) return;
    startPress(t.clientX, t.clientY, 'touch');
  };

  const onTouchMove = (e) => {
    const t = e.touches && e.touches[0];
    const origin = originRef.current;
    if (!t || !origin) return;
    const dx = t.clientX - origin.x;
    const dy = t.clientY - origin.y;

    // Any real movement is a scroll or a swipe, never a press.
    if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) {
      cancelledRef.current = true;
      clearTimer();
    }
    if (!onSwipeReply) return;

    // Rightward and roughly horizontal only, so a vertical scroll always keeps
    // the gesture it started.
    if (dx > SLOP && Math.abs(dy) < 24) {
      setDragging(true);
      setDrag(Math.min(dx - SLOP, SWIPE_MAX));
    } else if (dx <= SLOP && dragRef.current !== 0) {
      setDrag(0);
    }
  };

  const endTouch = () => {
    lastTouchRef.current = Date.now();
    clearTimer();
    originRef.current = null;
    const travelled = dragRef.current;
    setDragging(false);
    setDrag(0);
    // The row starts following the finger SLOP px in, so the finger has
    // travelled SLOP further than the transform says.
    if (onSwipeReply && travelled + SLOP >= SWIPE_THRESHOLD) onSwipeReply(message);
  };

  const onMouseDown = (e) => {
    if (Date.now() - lastTouchRef.current < MOUSE_LOCKOUT_MS) return;
    startPress(e.clientX, e.clientY, 'mouse');
  };
  const endMouse = () => {
    cancelledRef.current = true;
    clearTimer();
    originRef.current = null;
  };

  const onContextMenu = (e) => {
    if (!onLongPress) return;
    e.preventDefault();
    clearTimer();
    cancelledRef.current = true;
    fireLongPress('contextmenu');
  };

  const src = imageOf(message);
  const ratio = aspectOf(message);
  const card = renderCard ? renderCard(message) : null;
  const reactions = groupReactions(message && message.reactions);
  const reply = message && message.reply_to;
  const pending = !!(message && message.pending);
  const who = isMine ? 'you' : ((message && message.sender) || 'this chat');

  /* Shared by the tappable and the plain form of each, so the two cannot drift
     apart. Whether the photo and the quote are controls at all is decided by
     the handlers: a button announced as "Open the photo from Ava" that opens
     nothing is a promise the row cannot keep, and this module already gates
     the actions door the same way. The WebView's own Save Image sheet is
     already handled and not here: chat.css turns `-webkit-touch-callout` off
     on `.chat-swipe`, the row root, and the property inherits, so the photo
     inside it needs no declaration of its own. */
  const mediaBox = {
    display: 'block',
    width: '100%',
    maxWidth: '260px',
    padding: 0,
    border: 'none',
    /* Known ratio: an exact box. Unknown: a 4:5 box the photo is drawn
       inside. Either way the box exists before the bytes do. */
    aspectRatio: ratio ? String(ratio) : '4 / 5',
    borderRadius: '10px',
    overflow: 'hidden',
    background: 'var(--chat-media-ph)',
    marginBottom: message && message.text ? '4px' : 0,
    lineHeight: 0,
  };

  const mediaImg = {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: ratio ? 'cover' : 'contain',
  };

  const quoteBox = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'var(--chat-quote-bg)',
    borderLeft: `1.5px solid ${colour}`,
    borderRadius: '0 4px 4px 0',
    padding: '3px 8px',
    marginBottom: '3px',
  };

  const quoteInner = reply ? (
    <>
      <span
        style={{
          display: 'block',
          fontSize: '10px',
          lineHeight: '12px',
          fontWeight: 700,
          letterSpacing: '0.6px',
          textTransform: 'uppercase',
          color: colour,
        }}
      >
        {reply.sender || 'Message'}
      </span>
      <span
        style={{
          display: 'block',
          fontSize: '12px',
          lineHeight: '15px',
          color: 'var(--chat-quote-ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {reply.text || 'Photo'}
      </span>
    </>
  ) : null;

  return (
    <div
      ref={hostRef}
      data-message-id={message && message.id}
      className={`chat-swipe${dragging ? ' is-dragging' : ''}`}
      style={{
        position: 'relative',
        /* The unconditional 8. See the note at the top: this is what makes a
           first reaction cost zero layout. */
        paddingBottom: 'var(--chat-reaction-overlap)',
        /* The last row in a run is handed 0 by MessageGroup: the gap to the
           next name is measured from the last BASELINE, and the reserved 8
           above already spends most of it. */
        marginBottom: gapBelow,
        transform: dragX ? `translateX(${dragX}px)` : 'none',
        opacity: pending ? 0.6 : 1,
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={endTouch}
      onTouchCancel={endTouch}
      onMouseDown={onMouseDown}
      onMouseUp={endMouse}
      onMouseLeave={endMouse}
      onContextMenu={onContextMenu}
    >
      {reply && (
        /* The quote. Name in the quoted person's colour, one line of what they
           said, ellipsised. Tapping it jumps, and that jump is the parent's,
           so with no parent to jump it this is text and not a control. */
        onQuoteTap ? (
          <button
            type="button"
            className="hit44"
            onClick={(e) => {
              e.stopPropagation();
              if (consumeClick()) return;
              onQuoteTap(reply);
            }}
            aria-label={`Replying to ${reply.sender || 'a message'}`}
            style={{ ...quoteBox, cursor: 'pointer' }}
          >
            {quoteInner}
          </button>
        ) : (
          <div style={quoteBox}>{quoteInner}</div>
        )
      )}

      {src && (
        onOpenImage ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (consumeClick()) return;
              onOpenImage(message);
            }}
            aria-label={isMine ? 'Open the photo you sent' : `Open the photo from ${who}`}
            style={{ ...mediaBox, cursor: 'pointer' }}
          >
            {/* The button carries the name, so the image stays silent. */}
            <img src={src} alt="" loading="lazy" style={mediaImg} />
          </button>
        ) : (
          <div style={mediaBox}>
            {/* No viewer to open, so no button name exists to describe this.
                The alt text is the only thing a screen reader has. */}
            <img
              src={src}
              alt={isMine ? 'Photo you sent' : `Photo from ${who}`}
              loading="lazy"
              style={mediaImg}
            />
          </div>
        )
      )}

      {card}

      {message && message.text && (
        <div
          className="chat-row-body"
          style={{
            fontSize: 'var(--chat-body-size)',
            lineHeight: 'var(--chat-body-line)',
            fontWeight: 500,
            color: 'var(--chat-ink)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            paddingRight: '16px',
          }}
        >
          {message.text}
        </div>
      )}

      {reactions.length > 0 && (
        /* Out of flow, bottom aligned to the reserved 8, 16 tall, so exactly
           half of each pill sits over the message it belongs to. */
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            display: 'flex',
            gap: '3px',
            height: 'var(--chat-reaction-h)',
            alignItems: 'center',
          }}
        >
          {reactions.map((r) => {
            /* A tap toggles, so a viewer who cannot see that one of these is
               already theirs taps it again and silently removes it. The pill
               says so in three ways, and only when it can: `userIds` is empty
               on an older cached payload that still holds bare emoji strings,
               and with no owners and no viewer id there is nothing to claim.
               Silence there is the honest answer, not a pressed of false. */
            const canTellMine = myId != null && r.userIds.length > 0;
            const mine = canTellMine && r.userIds.some((id) => String(id) === String(myId));
            const counted = r.count === 1 ? '1 reaction' : `${r.count} reactions`;
            const owned = mine ? ', including you' : '';
            let action = '';
            if (onReactionTap && canTellMine) {
              action = mine ? '. Tap to remove your reaction' : '. Tap to react';
            }
            return (
              <button
                key={r.emoji}
                type="button"
                aria-pressed={canTellMine ? mine : undefined}
                aria-label={`${r.emoji} ${counted}${owned}${action}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (consumeClick()) return;
                  if (onReactionTap) onReactionTap(r.emoji, message);
                }}
                /* A real 44 tall target rather than index.css's `.hit44`
                   overlay. That overlay is 44 WIDE, and these pills sit 3px
                   apart on a pitch of about 27, so each pill's overlay lay
                   over the pill beside it and the later one won the tap: a
                   tap on the first reaction toggled the second. The button
                   itself is the target here and flex gives each one its own
                   column, so no pill can cover its neighbour. */
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: '44px',
                  padding: 0,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  // The 44px target is for the finger, not the eye. The global
                  // focus-visible rule in index.css draws its ring on whatever
                  // takes focus, which is this button, so a keyboard ring would
                  // be 48 tall around a 16 tall pill and would overflow into the
                  // message text above and the row below. The ring is drawn on
                  // the pill itself instead, just below.
                  outline: 'none',
                }}
              >
                {/* The pill as drawn: still 16 tall, still half over the
                    message, so nothing about the layout moves. It carries the
                    focus ring, because the button around it is finger sized. */}
                <span
                  className="chat-reaction-pill"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '2px',
                    height: 'var(--chat-reaction-h)',
                    padding: '0 5px',
                    borderRadius: '8px',
                    border: `1px solid ${mine ? colour : 'var(--chat-reaction-border)'}`,
                    background: 'var(--chat-reaction-bg)',
                    color: 'var(--chat-reaction-ink)',
                    fontSize: '10px',
                    lineHeight: '10px',
                  }}
                >
                  <span aria-hidden="true">{r.emoji}</span>
                  {r.count > 1 && <span aria-hidden="true" style={{ fontWeight: 600 }}>{r.count}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {onLongPress && (
        <button
          type="button"
          className="chat-actions-key"
          onClick={() => fireLongPress('keyboard')}
        >
          {isMine ? 'Actions for your message' : `Actions for ${who}'s message`}
        </button>
      )}

      {status && (
        /* Inside the row's box, outside the row's press gestures. The status node is
           the parent's, and StatusLine's Retry and Remove do not spend the
           click a long press leaves behind the way the photo, the quote and
           the pills do. Without this, a slow tap over 350ms on Remove opens
           the actions menu AND drops the message, and a rightward drag begun
           on the failed line quotes a message that never reached the server.
           Stopping the two press events here takes the status out of the
           gesture and leaves every other control on the row untouched, and
           the context menu goes with them so a right click on Retry raises
           the browser's menu rather than the app's actions sheet. */
        <div
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          {status}
        </div>
      )}
    </div>
  );
}

/* Memoised for the same reason MessageGroup is: a chat screen re-renders on
   every socket event it holds state for, and each of those otherwise
   re-renders every row in the thread, six refs and two states apiece. The
   shallow compare holds only while the callbacks above stay stable, which is
   the caller's side of the bargain. */
export default React.memo(MessageRow);
