/**
 * THE PIN STRIP. The one 36pt strip under the chat header.
 *
 * WHAT THIS REPLACES
 * The stack that used to sit between the header and the first message: the
 * 40pt plan bar and the 72pt pinned-venue banner in screens/ChatDetail.js, and
 * the pinned-venue block in screens/DmDetail.js. That stack cost a flock chat
 * about 112pt before a single message; the reference app spends zero. This
 * strip is the whole of what survives, and it is 36.
 *
 * EXACTLY ONE STRIP EVER RENDERS, AND THIS COMPONENT DOES NOT CHOOSE
 * It takes ONE already-decided model. The parent decides which of the three
 * states a chat is in and passes that one, or passes nothing. That is
 * deliberate: the old screens each held three separate booleans for three
 * separate bars, and two of them could be true at once, which is how a chat
 * ended up with a venue banner above a vote banner above a plan bar. A single
 * model makes the impossible state unrepresentable rather than merely
 * unlikely.
 *
 *   model = null                                   nothing renders at all
 *   { kind: 'venue', name, thumbUrl, caption }     a DM's pinned venue, or a
 *                                                  flock's locked one
 *   { kind: 'vote', votedCount, memberCount }      "Vote open, 5 of 8"
 *
 * MEASUREMENTS
 *   Strip 36 tall, hairline underneath. Thumbnail 20 square, radius 5, at the
 *   left inset. Name 15 semibold. Caption 12, secondary. Chevron 14 at the
 *   right. Content inset 14 each side, which lines the thumbnail up with the
 *   message stream's 18pt content edge once the stream's 4pt bar gutter is
 *   accounted for.
 *   The vote state has no thumbnail, so the vote glyph stands in the
 *   thumbnail's place and the rhythm does not change when a vote locks and the
 *   strip becomes a venue.
 *
 * LONG PRESS, AND THE ONE CONTROL THE CAPTURE DOES NOT HAVE
 * Press and hold the venue strip for 500ms and a small menu scales in over a
 * blur with Change place and Unpin. That is the only motion this component
 * has, and it is the one the spec allows. A long press is invisible to
 * VoiceOver and unreachable from a keyboard, so the same menu also has a real
 * button, which is in the DOM at all times and visually hidden until it takes
 * focus. Sighted touch users get the strip exactly as measured; everybody else
 * gets a control. Right click opens the menu too, for the browser build.
 *
 * PRESENTATIONAL ONLY. The only state here is whether the menu is open and
 * where it was opened from, which is view state that dies with the strip.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icons from '../../ui/Icons';
import './sheets.css';

const LONG_PRESS_MS = 500;
/* A press that travels more than this is a scroll, not a hold. */
const LONG_PRESS_SLOP_PX = 10;

export default function PinStrip({
  model = null,
  onOpen,          // tap the strip: opens the venue, or jumps to the poll card
  onChangePlace,   // long-press menu, venue model only
  onUnpin,         // long-press menu, venue model only
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const holdTimer = useRef(null);
  const holdStart = useRef(null);
  // A long press fires pointerup and then click; without this the menu opens
  // and the strip navigates underneath it in the same gesture.
  const suppressClick = useRef(false);
  const menuRef = useRef(null);
  // The options button, which is both the toggle the outside-click handler has
  // to ignore and the place focus goes back to when the menu closes.
  const moreRef = useRef(null);

  const clearHold = useCallback(() => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    holdStart.current = null;
  }, []);

  useEffect(() => clearHold, [clearHold]);

  // Escape closes, a tap anywhere else closes, and focus moves into the menu
  // when it opens so a keyboard user is not left behind on the strip.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setMenuOpen(false);
    };
    const onDown = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      // The toggle owns its own open and close. Without this, pressing it a
      // second time ran pointerdown (close) and then click (open again), so
      // the button could open the menu and never shut it.
      if (moreRef.current && moreRef.current.contains(e.target)) return;
      setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onDown, true);
    // Where focus came from, so it can go back. Every close path here unmounts
    // the focused menu item (Escape, an outside press, choosing an item), and
    // without this the keyboard user lands on <body> at the top of the
    // document. Worse than usual on this strip: the control they came from is
    // clipped to 1x1 unless it holds focus, so it is invisible again the
    // moment it loses it.
    const returnTo = document.activeElement;
    const t = setTimeout(() => {
      const first = menuRef.current && menuRef.current.querySelector('button');
      try { first?.focus({ preventScroll: true }); } catch { /* detached */ }
    }, 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onDown, true);
      clearTimeout(t);
      // A hold that opened the menu set this and nothing on the release-outside
      // path ever clears it, so the next honest tap on the strip was swallowed.
      suppressClick.current = false;
      // Only if the close actually orphaned focus. A menu item that opens
      // something else and focuses it has already answered the question, and
      // pulling focus back here would undo it.
      const focused = document.activeElement;
      const orphaned = !focused
        || focused === document.body
        || (menuRef.current && menuRef.current.contains(focused));
      // Back where it came from, and nowhere else. A long press opens the menu
      // with focus still on <body>, so preferring the options button here sent
      // focus to a control the user never touched, and :focus unclips that
      // button from 1x1 into 32 square inside the 36pt strip.
      if (orphaned && returnTo && document.contains(returnTo) && typeof returnTo.focus === 'function') {
        try { returnTo.focus({ preventScroll: true }); } catch { /* detached */ }
      }
    };
  }, [menuOpen]);

  if (!model || (model.kind !== 'venue' && model.kind !== 'vote')) return null;

  const isVenue = model.kind === 'venue';
  const hasMenu = isVenue && (typeof onChangePlace === 'function' || typeof onUnpin === 'function');

  const caption = isVenue
    ? (model.caption || 'Pinned')
    // "Vote open, 5 of 8". Both numbers come from the caller because only the
    // caller knows whether memberCount means the roster or the people who can
    // still vote. Rendered with aria-live so the count is announced as it
    // moves rather than only when the strip first appears, which is also why
    // the figure is drawn only when both numbers actually arrived: a parent
    // that paints before the tally resolves would announce "undefined of 8".
    : (typeof model.votedCount === 'number' && typeof model.memberCount === 'number'
      ? `Vote open, ${model.votedCount} of ${model.memberCount}`
      : 'Vote open');

  const name = isVenue ? model.name : 'Pick where you are going';
  // Same rule for the menu's accessible name: never "Options for undefined".
  const menuLabel = name ? `Options for ${name}` : 'Options for this place';

  const startHold = (e) => {
    if (!hasMenu) return;
    // Primary button or touch only. A right click opens the menu through
    // onContextMenu instead.
    if (e.button != null && e.button !== 0) return;
    holdStart.current = { x: e.clientX, y: e.clientY };
    holdTimer.current = setTimeout(() => {
      suppressClick.current = true;
      setMenuOpen(true);
      clearHold();
    }, LONG_PRESS_MS);
  };

  const moveHold = (e) => {
    if (!holdStart.current) return;
    const dx = Math.abs(e.clientX - holdStart.current.x);
    const dy = Math.abs(e.clientY - holdStart.current.y);
    if (dx > LONG_PRESS_SLOP_PX || dy > LONG_PRESS_SLOP_PX) clearHold();
  };

  /* A gesture the system took away. pointercancel means there is no pointerup
     and no click, so the strip's own onClick never runs and never clears the
     flag the hold set, and the next honest tap was swallowed. clearHold cannot
     carry this, because the hold timer calls it one line after setting the
     flag.
     NOT on pointerleave. A device with no hover fires pointerout, which is
     what React synthesizes onPointerLeave from, immediately after pointerup
     and BEFORE the compatibility click, so clearing there hands every long
     press its click as well and the strip navigates under the menu it just
     opened. Releasing outside is already covered by the menu-close cleanup
     above. */
  const endWithoutClick = () => {
    clearHold();
    suppressClick.current = false;
  };

  return (
    <div className="cs-strip-wrap">
      <button
        type="button"
        className="cs-strip"
        data-chat-strip={model.kind}
        onPointerDown={startHold}
        onPointerMove={moveHold}
        onPointerUp={clearHold}
        onPointerCancel={endWithoutClick}
        onPointerLeave={clearHold}
        onContextMenu={hasMenu ? (e) => { e.preventDefault(); setMenuOpen(true); } : undefined}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onOpen?.(model);
        }}
      >
        <span className="cs-strip-thumb" aria-hidden="true">
          {isVenue && model.thumbUrl
            ? <img src={model.thumbUrl} alt="" className="cs-strip-thumb-img" />
            : (isVenue ? Icons.mapPin('currentColor', 14) : Icons.vote('currentColor', 14))}
        </span>
        <span className="cs-strip-name">{name}</span>
        <span className="cs-strip-caption" aria-live={isVenue ? undefined : 'polite'}>{caption}</span>
        <span className="cs-strip-chev" aria-hidden="true">{Icons.chevronRight('currentColor', 14)}</span>
      </button>

      {hasMenu ? (
        <button
          type="button"
          ref={moreRef}
          className="hit44 cs-strip-more"
          aria-label={menuLabel}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {Icons.moreVertical('currentColor', 15)}
        </button>
      ) : null}

      {hasMenu && menuOpen ? (
        <div className="cs-strip-menu" ref={menuRef} role="menu" aria-label={menuLabel}>
          {onChangePlace ? (
            <button type="button" role="menuitem" className="cs-menu-item" onClick={() => { setMenuOpen(false); onChangePlace(model); }}>
              <span className="cs-row-icon" aria-hidden="true">{Icons.mapPin('currentColor', 15)}</span>
              Change place
            </button>
          ) : null}
          {onUnpin ? (
            <button type="button" role="menuitem" className="cs-menu-item" onClick={() => { setMenuOpen(false); onUnpin(model); }}>
              <span className="cs-row-icon" aria-hidden="true">{Icons.pin('currentColor', 15)}</span>
              Unpin
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
