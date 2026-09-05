/**
 * THE PINNED MESSAGE BAR. One line under the pin strip.
 *
 * WHAT THIS IS
 * Decision 4 of the rebuild plan: Flock has shared pins, not the reference
 * app's private save. Up to three per chat, anyone can pin, and the pin is
 * visible to everyone in the thread. This bar is where they live so the
 * message stream does not have to carry them. Reads "Pinned: Venmo @maya $12",
 * tap jumps to the message, swipe moves to the next of up to three, and the
 * unpin control removes the one on screen.
 *
 * WHAT IT REPLACES
 * Nothing that shipped. Pinning a message is new (migration 066 adds the
 * pinned_messages table). It is listed here because the header drawer is where
 * a feature like this would otherwise have gone, and the whole point of the
 * rebuild is that it does not.
 *
 * WHY THE INDEX IS CONTROLLED
 * Which of the three is showing is passed in and changed through a callback,
 * rather than kept here. Two reasons, both real. A pin can be removed by
 * somebody else while this bar is open, and the shell is the only place that
 * sees the socket event, so it has to be able to move the index off a pin that
 * no longer exists. And the bar is inside the chat screen, which remounts on
 * every trip out to a venue and back; local state would silently reset to the
 * first pin every time. The shell already owns every other piece of chat
 * state for exactly these reasons.
 *
 * MEASUREMENTS
 *   32 tall, under the 36pt strip, so the whole stack under the header is 68
 *   at its tallest and 0 when there is nothing pinned. Text at 12, the same
 *   size as the strip's caption, so the two bars read as one group rather than
 *   two competing headers. "Pinned:" is in the secondary colour and the
 *   message itself is primary, which is what makes it scannable at that size.
 *   Content inset 14, matching the strip.
 *
 * SWIPE, AND WHAT THE DOTS ARE NOT
 * A horizontal drag of more than 40px moves one pin. There is no animation:
 * nothing in this rebuild bounces, and a bar that slides on a 32pt line is
 * noise. The dots are a DECORATIVE indicator, aria-hidden, and they are not
 * buttons. They were, for one draft, and that was wrong twice over: three 5px
 * dots four pixels apart cannot each carry a 44pt target without the three
 * targets sitting on top of each other, and a screen reader gained nothing
 * from three unlabelled positions. The reachable control is one "Next pinned
 * message" button with a real label and a real hit area, plus arrow keys on
 * the bar, and the main button's own label carries "2 of 3" so the position is
 * spoken rather than only drawn.
 *
 * That same overlapping-target trap caught the two trailing buttons anyway,
 * one level down: at 28 square with .hit44 they each grew an invisible 44px
 * overlay, so Unpin's covered the right edge of Next and a tap there removed a
 * pin instead of advancing. They are 44 wide by the bar's own 32 tall now, and
 * the reasoning is written out beside them in sheets.css.
 *
 * PRESENTATIONAL ONLY. No effects, no API, and the only two refs are gesture
 * bookkeeping that never reaches the DOM: where a drag started, and whether
 * the click the browser fires after that drag should be ignored.
 */
import React, { useRef } from 'react';
import Icons from '../../ui/Icons';
import './sheets.css';

/* Below this a drag is a tap. 40px is the same threshold the swipe-to-reply
   gesture uses in the message rows, so one hand learns one distance. */
const SWIPE_PX = 40;

export default function PinnedMessageBar({
  pins = [],            // [{ id, preview }], at most three
  activeIndex = 0,
  onActiveIndexChange,  // (nextIndex) => void
  onJump,               // (pin) => void, scrolls the stream to the message
  onUnpin,              // (pin) => void
}) {
  const startX = useRef(null);
  /* A horizontal drag that starts and ends inside the main button still ends
     in a real click on it, and `touch-action: pan-y` means the browser never
     turns the drag into a scroll and never cancels the stream. Without this
     flag every successful swipe also called onJump with the pin it had just
     swiped away from, so the stream scrolled to the wrong message. The message
     rows solve the same thing the same way. */
  const suppressClick = useRef(false);

  if (!pins || pins.length === 0) return null;

  // Clamp rather than trust. A pin removed by somebody else can leave the
  // shell one render behind, and pointing at pins[3] would blank the bar for
  // that render. Never written back during render; the shell corrects itself
  // on the socket event.
  const count = Math.min(pins.length, 3);
  const index = Math.min(Math.max(activeIndex | 0, 0), count - 1);
  const pin = pins[index];

  const move = (delta) => {
    if (count < 2) return;
    const next = (index + delta + count) % count;
    onActiveIndexChange?.(next);
  };

  return (
    <div
      className="cs-pinbar"
      data-chat-pinbar="true"
      onPointerDown={(e) => { startX.current = e.clientX; }}
      onPointerUp={(e) => {
        const from = startX.current;
        startX.current = null;
        if (from == null) return;
        const dx = e.clientX - from;
        if (Math.abs(dx) < SWIPE_PX) return;
        suppressClick.current = true;
        move(dx < 0 ? 1 : -1);
      }}
      onPointerCancel={() => { startX.current = null; suppressClick.current = false; }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
      }}
    >
      <button
        type="button"
        className="cs-pinbar-main"
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onJump?.(pin);
        }}
        aria-label={count > 1
          ? `Go to pinned message ${index + 1} of ${count}: ${pin.preview}`
          : `Go to pinned message: ${pin.preview}`}
      >
        <span className="cs-pinbar-icon" aria-hidden="true">{Icons.pinFilled('currentColor', 12)}</span>
        <span className="cs-pinbar-text" aria-live="polite">
          <span className="cs-pinbar-key">Pinned: </span>
          <span className="cs-pinbar-body">{pin.preview}</span>
        </span>
      </button>

      {/* Position, drawn. Only when there is more than one: a single dot says
          nothing and implies there are others. aria-hidden, because the count
          is already in the main button's label and the Next button below is
          the reachable control. */}
      {count > 1 ? (
        <span className="cs-pinbar-dots" aria-hidden="true">
          {pins.slice(0, count).map((p, i) => (
            <span
              key={p.id}
              className={i === index ? 'cs-pinbar-dot cs-pinbar-dot-on' : 'cs-pinbar-dot'}
            />
          ))}
        </span>
      ) : null}

      {count > 1 ? (
        <button
          type="button"
          className="hit44 cs-pinbar-next"
          aria-label="Next pinned message"
          onClick={() => move(1)}
        >
          {Icons.chevronRight('currentColor', 14)}
        </button>
      ) : null}

      {onUnpin ? (
        <button
          type="button"
          className="hit44 cs-pinbar-unpin"
          aria-label={`Unpin ${pin.preview}`}
          onClick={() => onUnpin(pin)}
        >
          {Icons.x('currentColor', 14)}
        </button>
      ) : null}
    </div>
  );
}
