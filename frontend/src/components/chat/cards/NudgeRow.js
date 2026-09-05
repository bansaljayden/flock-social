/**
 * THE NUDGE ROW.
 *
 * WHAT IT IS. A system row with a small bird at the left and exactly one
 * action chip at the right. It is how Birdie asks for one thing inside the
 * stream: "Nobody has voted yet" with "Open the vote", "Three people are
 * waiting on a time" with "Pick a time", "Turn on notifications" with "Turn
 * on". Same tertiary notice size, pitch and grey as SystemRow, read from the
 * same --chat-notice tokens, and the same 6px and 16px padding, so a nudge
 * sits on the stream's rhythm rather than beside it. No card and no
 * background, because a nudge is a note in the record and not an object in
 * it. It is NOT uppercased the way a system notice is: a notice is the stream
 * reporting an event in the plan's own vocabulary, a nudge is Birdie saying a
 * sentence with a control next to it, and a sentence set in caps beside a
 * mixed case chip label reads as shouting.
 *
 * WHAT IT REPLACES. The 40pt momentum meter that sits pinned under the chat
 * header today, and the standalone notification prompt. The meter retires to
 * the plan page (rebuild plan, "Momentum nudges"); what is left of it is this
 * row, posted at most once per plan per stage, never while somebody is
 * typing, never more than one unresolved, and never after the plan locks.
 * None of those rules live here: this component draws a nudge the parent has
 * already decided to show, the same way every other file in this folder takes
 * its whole world as props.
 *
 * WHY IT IS DISMISSIBLE BY SWIPE. A nudge the reader cannot get rid of is not
 * a nudge, it is a banner, and banners between the header and the first
 * message are the single thing this rebuild exists to remove. There are two
 * ways out and they arrive together: drag the row sideways past 64px, or
 * press the X. The X is what makes the swipe accessible rather than a gesture
 * only a sighted finger can find, so the swipe is never offered without it.
 *
 * BOTH ROUTES ARE GATED ON onDismiss. The X used to draw unconditionally, so
 * a parent that passed no handler shipped a button that did nothing, and the
 * swipe still entered the leaving state: cards.css fades the row to zero
 * opacity and keeps its box, so the result was an invisible strip in the
 * middle of the stream still swallowing taps and still holding two focusable
 * controls in the tab order, with no way to get rid of it. A row nobody is
 * listening to is simply not dismissible, and it says so by offering
 * neither control rather than by offering one that lies.
 *
 * WHY THE DRAG IS NOT SUPPRESSED UNDER REDUCED MOTION. The row moves because
 * a finger is moving it. That is direct manipulation, not animation, and
 * suppressing it would make the gesture feel broken rather than calm. What is
 * suppressed, in cards.css, is the settle that plays by itself when a short
 * drag is released.
 */
import React, { useRef, useState } from 'react';
import { BirdieStill, WARM_BIRD } from '../../ui/BirdieBird';
import Icons from '../../ui/Icons';
import './cards.css';

// Measured against the plan's 32pt dismiss chip: far enough that a vertical
// scroll never trips it, short enough to reach with a thumb on a 390px screen.
const DISMISS_AT = 64;

export default function NudgeRow({
  text,
  actionLabel,
  onAction,
  onDismiss,
}) {
  const startX = useRef(null);
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // No text, no nudge. A bird and a chip with nothing between them is a
  // control that has not said what it is for.
  if (typeof text !== 'string' || text.trim().length === 0) return null;

  const dismiss = () => {
    // Once is once. The X keeps focus after the first press, so a second Enter
    // on it told the parent to dismiss a row that was already leaving.
    if (leaving) return;
    if (typeof onDismiss !== 'function') return;
    setLeaving(true);
    onDismiss();
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A press that starts on a control belongs to that control, not to the
    // row. Taking pointer capture on the row retargets the compatibility
    // mouse events and the click that follows them to the row, so the chip
    // and the X never received their own tap on device while every test here
    // passed: jsdom has no setPointerCapture, so the capture never happened
    // and the retarget never happened with it. It also stopped a plain button
    // press from starting a drag and toggling the settle transition.
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) return;
    startX.current = e.clientX;
    setSettling(false);
    // jsdom has no pointer capture and neither does every WebView; the drag
    // works without it, it is just less forgiving at the edges.
    if (typeof e.currentTarget.setPointerCapture === 'function' && e.pointerId != null) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    }
  };

  const onPointerMove = (e) => {
    if (startX.current === null) return;
    setDx(e.clientX - startX.current);
  };

  const endDrag = () => {
    if (startX.current === null) return;
    startX.current = null;
    // Past the threshold AND somebody is listening: the row leaves. If nobody
    // is listening it settles back instead of staying parked off to one side,
    // because a row that cannot be dismissed must not look half dismissed.
    if (Math.abs(dx) >= DISMISS_AT && typeof onDismiss === 'function') {
      dismiss();
      return;
    }
    setSettling(true);
    setDx(0);
  };

  // The leaving row is a fade, and a fade leaves a box behind. So it is out of
  // the accessibility tree from the moment it starts leaving, both of its
  // controls leave the tab order on the same flag, and cards.css takes its
  // pointer events on the same class. All three are needed: opacity and
  // pointer-events remove nothing from the tab order, so aria-hidden over a
  // button that can still be tabbed to is a plain 4.1.2 failure and a keyboard
  // user could reach an invisible chip and an invisible X.
  return (
    <div
      className={`${settling ? 'chat-nudge-settling ' : ''}${leaving ? 'chat-nudge-leaving ' : ''}`.trim()}
      data-nudge-row="true"
      aria-hidden={leaving || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 16px',
        // pan-y so a vertical flick still scrolls the stream. Without it the
        // browser claims the gesture and the row never moves.
        touchAction: 'pan-y',
        transform: dx ? `translateX(${dx}px)` : undefined,
        boxSizing: 'border-box',
      }}
    >
      <BirdieStill bird={WARM_BIRD} size={22} eager={false} style={{ flexShrink: 0 }} />

      <span
        className="chat-truncate"
        style={{
          flex: 1,
          fontSize: 'var(--chat-notice-size)',
          lineHeight: 'var(--chat-notice-line)',
          fontWeight: 500,
          color: 'var(--chat-notice)',
        }}
      >
        {text}
      </span>

      {/* One chip, and only when there is somewhere for it to go. A label with
          no handler behind it is a dead button, which SLOP-AUDIT rules out
          outright, so both have to be present for the chip to exist. The chip
          keeps its own 12px: the sentence sits at the notice size because it
          is part of the stream's grey record, and a control label is a thing
          a thumb has to read and hit. */}
      {actionLabel && typeof onAction === 'function' && (
        <button
          type="button"
          className="hit44"
          tabIndex={leaving ? -1 : undefined}
          onClick={onAction}
          style={{
            flexShrink: 0,
            padding: '5px 12px',
            borderRadius: '14px',
            border: '1px solid var(--chat-accent)',
            background: 'transparent',
            color: 'var(--chat-accent)',
            fontSize: '12px',
            fontWeight: 600,
            lineHeight: '18px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {actionLabel}
        </button>
      )}

      {/* The other half of the pair the header describes. It draws whenever
          the row is dismissible at all, which is whenever a parent is
          listening, and the swipe is gated on exactly the same thing. */}
      {typeof onDismiss === 'function' && (
        <button
          type="button"
          className="hit44"
          aria-label="Dismiss"
          tabIndex={leaving ? -1 : undefined}
          onClick={dismiss}
          style={{
            flexShrink: 0,
            width: '22px',
            height: '22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          {Icons.x('var(--text-tertiary)', 14)}
        </button>
      )}
    </div>
  );
}
