/**
 * ChatInputBar - the composer, rebuilt to Snapchat's shape.
 *
 * WHAT THIS IS
 * The input bar for both chat surfaces in the rebuild (W3 in
 * CHAT-REBUILD-PLAN.md). Camera at the far left, then the pill holding the
 * field, then one control at the right that is a "+" until you type and the
 * send button after that.
 *
 * WHAT IT REPLACES
 * The two hand-rolled composers: the `<div>` after "Input area" in
 * `screens/ChatDetail.js` and the one after "Input bar" in
 * `screens/DmDetail.js`. Both are single-line `<input>` elements with three
 * icon buttons crowded to the left of them and a send button that is always
 * on screen and mostly disabled. Neither can hold a second line of text.
 *
 * MEASUREMENTS, and where they come from
 * Every number below was measured off a real iPhone capture at 3x and is
 * recorded in CHAT-REBUILD-PLAN.md. Bar 52 tall from the hairline down. Pill
 * 40 tall with 6 above and 6 below, radius 20. Camera a 38 circle at the far
 * left. Icons 13 in from the right edge.
 *
 * THE DECISIONS BEHIND THE SURPRISING PARTS
 *
 * 1. NO SEND BUTTON WHILE THE FIELD IS EMPTY. Not a disabled one, not a faded
 *    one: absent. Today's bar keeps a navy circle on screen at 45% opacity
 *    that does nothing for as long as the field is empty, which is a control
 *    the product cannot honour. The "+" occupies that position instead and
 *    opens the composer sheet. Type one character and the plus becomes send.
 *    The one addition to that rule: a photo waiting to go is also something to
 *    send, so a pending image arms send with no text, because otherwise a
 *    caption-free photo has no way out of the preview bar.
 *
 * 2. AUTOCORRECT AND AUTOCAPITALIZE STAY ON. They are spelled out rather than
 *    left to the default so nobody turns them off later in the name of
 *    tidiness. A chat field that does not capitalise a sentence or fix a typo
 *    is the single clearest tell that a keyboard is not the system one, and
 *    the whole point of this rebuild is that it should feel like one.
 *
 * 3. THE FIELD IS A TEXTAREA, one line tall, growing to five and then
 *    scrolling. The measurement happens inside a requestAnimationFrame because
 *    reading `scrollHeight` in the same tick as the keystroke measures the
 *    layout before the new character has been laid out, so the box lags one
 *    character behind the text on every device that has ever been tested.
 *
 * 4. ENTER SENDS, SHIFT WITH ENTER MAKES A NEWLINE. On the phone the return
 *    key is labelled by `enterKeyHint="send"`, so the two agree. A composition
 *    in progress (an IME candidate window) is left alone: Enter there is
 *    choosing a word, not sending a message.
 *
 * 5. FONT SIZE 16. WKWebView zooms the whole viewport when a focused control
 *    computes under 16px. index.css carries an app-wide floor for it and
 *    `__tests__/iosFocusZoomFontFloor.test.js` pins it.
 *
 * 6. THE HAIRLINE SITS ON THE OUTER COMPOSER, NOT ON THE BAR. The reply quote,
 *    the image preview and the location chip all stack above the bar, and a
 *    border on each of them draws four grey lines up the screen. One line, at
 *    the top of the whole thing, is what the capture shows.
 *
 * 7. NO STATE THAT THE SERVER CANNOT BACK. The location chip renders only
 *    while `sharingLocation` is true. There is no placeholder chip, no greyed
 *    "not sharing" version, and no upload progress unless the parent is
 *    actually reporting one.
 *
 * 8. THE CARET COLOUR IS A CUSTOM PROPERTY, NOT `caretColor`. The viewer's own
 *    colour goes on as `--chat-caret` and chatInput.css reads it. Written
 *    inline as `caret-color` it would outrank every class rule, and
 *    `useKeyboardComposer` hides this caret with a class for the length of
 *    every keyboard slide, so the one thing that has to beat it would lose.
 *
 * 9. `disabledReason` DOES NOT DEPEND ON `disabled`. They are two facts, and
 *    the product needs the combination the old gate made unreachable: settled
 *    decision 5 in CHAT-REBUILD-PLAN.md keeps the field LIVE for someone you
 *    are not connected to yet and puts a sentence above it, because sending is
 *    what carries the friend request. `disabled` turns the controls off;
 *    `disabledReason` says something. Either without the other is valid.
 *
 * 10. THE NOTICE'S LIVE REGION IS ALWAYS MOUNTED, the sentence inside it is
 *    not. SLOP-AUDIT.md section N: a region has to already be in the
 *    accessibility tree for a screen reader to notice text arriving in it, and
 *    a node created together with its own first message is an element
 *    insertion, which VoiceOver routinely says nothing about. The wrapper is an
 *    empty div with no padding, so it costs no height until there is something
 *    to say.
 *
 * PRESENTATIONAL ONLY. No API calls, no context, no global state. Everything
 * arrives as a prop, the way the screens this replaces already work. The one
 * import that is not a prop is the haptic on send, which is settled decision 7
 * in CHAT-REBUILD-PLAN.md and is fire-and-forget on every platform.
 */

import React, { useCallback, useLayoutEffect, useRef } from 'react';
import Icons from '../ui/Icons';
import { hapticTap } from '../../services/haptics';
import './chatInput.css';

/* One line of 20px plus the pill's 10px of padding top and bottom. */
const MIN_FIELD_H = 40;
/* Five lines of 20px plus the same 20px of padding. Past this the field
   scrolls rather than growing, so the composer can never eat the thread. */
const MAX_FIELD_H = 120;

const noop = () => {};

export default function ChatInputBar({
  /* which surface, and what to call it */
  variant = 'dm',
  threadName = '',

  /* the viewer's own colour, from the palette the app hands every member.
     Used for the caret only, which is where the capture shows it. */
  ownColor,

  /* the field */
  value = '',
  onChange = noop,
  onSend = noop,
  onTyping,
  maxLength,
  autoFocus = false,

  /* the controls */
  onCamera = noop,
  onLibrary = noop,
  onPlus = noop,

  /* reply quote bar */
  replyTo = null,
  onCancelReply = noop,

  /* image preview bar */
  pendingImage = null,
  pendingImageLabel = 'Ready to send',
  imageError = '',
  onRetryImage = null,
  onRemoveImage = noop,

  /* location chip, drawn only while actually sharing */
  sharingLocation = false,
  locationLabel = '',
  onStopSharingLocation = noop,

  /* Two independent facts, per decision 9. `disabled` turns the field and the
     controls off. `disabledReason` puts a sentence above the field, with or
     without it: "You cannot message this account" comes with disabled, and
     "Not connected yet. Your first message goes with a friend request." comes
     with a live field. */
  disabled = false,
  disabledReason = '',

  /* wiring from useKeyboardComposer */
  registerBar,
  registerInput,

  onFocus = noop,
  onBlur = noop,
}) {
  const fieldRef = useRef(null);
  const frameRef = useRef(0);

  const hasText = typeof value === 'string' && value.trim().length > 0;
  const canSend = !disabled && (hasText || !!pendingImage);

  const attachField = useCallback((el) => {
    fieldRef.current = el;
    if (typeof registerInput === 'function') registerInput(el);
  }, [registerInput]);

  /* Decision 3. Height is measured one frame late, on purpose. */
  const measure = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const el = fieldRef.current;
      if (!el) return;
      el.style.height = 'auto';
      const content = el.scrollHeight;
      const next = Math.min(Math.max(content, MIN_FIELD_H), MAX_FIELD_H);
      el.style.height = `${next}px`;
      el.style.overflowY = content > MAX_FIELD_H ? 'auto' : 'hidden';
    });
  }, []);

  useLayoutEffect(() => {
    measure();
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [value, measure]);

  const handleChange = useCallback((event) => {
    onChange(event.target.value);
    if (typeof onTyping === 'function') onTyping(event.target.value);
  }, [onChange, onTyping]);

  /* One send path, so the return key and the button cannot drift apart and the
     haptic cannot fire twice or on a send that did not happen. Settled decision
     7: a light tap on send, and no sound in an open thread. */
  const handleSend = useCallback(() => {
    if (!canSend) return;
    hapticTap();
    onSend();
  }, [canSend, onSend]);

  const handleKeyDown = useCallback((event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;                                    // decision 4
    if (event.nativeEvent && event.nativeEvent.isComposing) return;
    event.preventDefault();
    handleSend();
  }, [handleSend]);

  const placeholder = variant === 'flock' && threadName
    ? `Message ${threadName}`
    : 'Send a chat';

  const iconColor = 'var(--chat-composer-icon)';

  const roundButton = {
    border: 'none',
    background: 'none',
    padding: 0,
    cursor: disabled ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  return (
    <div
      className="chat-composer"
      ref={registerBar}
      style={{
        flexShrink: 0,
        borderTop: '1px solid var(--chat-composer-hairline)',   // decision 6
        backgroundColor: 'var(--bg-nav)',
        paddingBottom: 'var(--safe-bottom)',
      }}
    >
      {/* Decisions 9 and 10. The sentence above the field: why the composer is
          off, or what sending will do when it is not. The region is mounted
          whether or not there is anything in it, and it is polite because the
          sentence appears and disappears while the reader is looking
          elsewhere. An empty div with no padding takes no height. */}
      <div aria-live="polite">
        {disabledReason ? (
          <p
            style={{
              margin: 0,
              padding: '10px 16px',
              fontSize: 'var(--t-meta)',
              lineHeight: '17px',
              color: 'var(--chat-composer-notice)',
            }}
          >
            {disabledReason}
          </p>
        ) : null}
      </div>

      {replyTo ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 13px 0 18px' }}>
          <div style={{ flex: 1, minWidth: 0, borderLeft: '1.7px solid var(--chat-send-fill)', paddingLeft: '8px' }}>
            <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              Replying to {replyTo.sender}
            </span>
            <p style={{ margin: '2px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {replyTo.preview || replyTo.text || ''}
            </p>
          </div>
          <button type="button" aria-label="Cancel reply" className="hit44" onClick={onCancelReply} style={{ ...roundButton, cursor: 'pointer', width: '28px', height: '28px' }}>
            {Icons.x(iconColor, 14)}
          </button>
        </div>
      ) : null}

      {pendingImage ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 13px 0 18px' }}>
          <img
            src={pendingImage}
            alt="The photo waiting to send"
            style={{ width: '44px', height: '44px', objectFit: 'cover', borderRadius: '10px', flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-primary)' }}>
              {imageError ? 'That photo did not send' : pendingImageLabel}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {imageError || 'Add a caption below if you want one.'}
            </p>
          </div>
          {imageError && typeof onRetryImage === 'function' ? (
            <button
              type="button"
              className="hit44"
              onClick={onRetryImage}
              style={{ border: '1px solid var(--border-default)', background: 'none', borderRadius: '12px', padding: '5px 11px', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-primary)', cursor: 'pointer', flexShrink: 0 }}
            >
              Try again
            </button>
          ) : null}
          <button type="button" aria-label="Remove photo" className="hit44" onClick={onRemoveImage} style={{ ...roundButton, cursor: 'pointer', width: '28px', height: '28px' }}>
            {Icons.x(iconColor, 14)}
          </button>
        </div>
      ) : null}

      {/* Decision 7: drawn only while sharing is actually running. */}
      {sharingLocation ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 13px 0 18px' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '26px',
              padding: '0 10px',
              borderRadius: '13px',
              border: '1.5px solid var(--accent-green-text)',
              color: 'var(--accent-green-text)',
              fontSize: 'var(--t-micro)',
              fontWeight: '700',
              letterSpacing: '0.8px',
              textTransform: 'uppercase',
            }}
          >
            {Icons.mapPin('currentColor', 12)}
            {locationLabel || 'Sharing your location'}
          </span>
          <button
            type="button"
            className="hit44"
            onClick={onStopSharingLocation}
            style={{ border: 'none', background: 'none', padding: '4px 2px', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Stop
          </button>
        </div>
      ) : null}

      <div
        className="chat-composer-bar"
        style={{
          minHeight: 'var(--chat-composer-bar-h)',
          display: 'flex',
          alignItems: 'flex-end',
          gap: '7px',
          padding: '6px 13px 6px 7px',
        }}
      >
        <button
          type="button"
          aria-label="Take a photo"
          className="hit44"
          onClick={onCamera}
          disabled={disabled}
          style={{
            ...roundButton,
            width: 'var(--chat-composer-camera)',
            height: 'var(--chat-composer-camera)',
            borderRadius: '50%',
            backgroundColor: 'var(--chat-camera-fill)',
            marginBottom: '1px',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {Icons.camera(iconColor, 18)}
        </button>

        {/* The pill. `minWidth: 0` is load-bearing: a flex item's automatic
            minimum is its intrinsic width, so without it the field refuses to
            shrink and pushes the right-hand control off a 390px screen. The
            same note is written on both of the composers this replaces. */}
        <div
          style={{
            position: 'relative',
            flex: '1 1 0%',
            minWidth: 0,
            display: 'flex',
            alignItems: 'flex-end',
            minHeight: 'var(--chat-composer-pill-h)',
            borderRadius: 'var(--chat-composer-pill-radius)',
            backgroundColor: 'var(--chat-input-fill)',
            paddingRight: hasText ? '14px' : '38px',
          }}
        >
          <textarea
            ref={attachField}
            className="chat-composer-field"
            /* The accessible name is not the placeholder. "Send a chat" is a
               prompt; a screen reader wants to know which conversation the
               field belongs to, which is the same sentence in both variants. */
            aria-label={threadName ? `Message ${threadName}` : 'Message'}
            rows={1}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder={placeholder}
            disabled={disabled}
            maxLength={maxLength}
            enterKeyHint="send"
            autoFocus={autoFocus}
            /* Decision 2. On, and spelled out so it stays on. */
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck
            autoComplete="off"
            style={{
              height: `${MIN_FIELD_H}px`,
              maxHeight: 'var(--chat-composer-pill-max-h)',
              padding: '10px 0 10px 14px',
              /* Decision 8. The colour, not the property. */
              ...(ownColor ? { '--chat-caret': ownColor } : null),
            }}
          />
          {/* The library icon lives inside the pill's right edge and steps
              aside when there is something to send, which is the swap the
              capture shows. */}
          {!hasText ? (
            <button
              type="button"
              aria-label="Choose a photo from your library"
              className="hit44 chat-composer-collapse"
              onClick={onLibrary}
              disabled={disabled}
              style={{
                ...roundButton,
                position: 'absolute',
                right: '5px',
                bottom: '5px',
                width: '30px',
                height: '30px',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {Icons.image(iconColor, 20)}
            </button>
          ) : null}
        </div>

        {/* Decision 1. One slot: plus until there is something to send, send
            after that. There is never a disabled send button here. */}
        {canSend ? (
          <button
            type="button"
            aria-label="Send message"
            className="hit44"
            onClick={handleSend}
            style={{
              ...roundButton,
              cursor: 'pointer',
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              backgroundColor: 'var(--chat-send-fill)',
              marginBottom: '2px',
            }}
          >
            {Icons.send('var(--chat-send-glyph)', 18)}
          </button>
        ) : (
          <button
            type="button"
            aria-label="More to send"
            className="hit44"
            onClick={onPlus}
            disabled={disabled}
            style={{
              ...roundButton,
              width: '36px',
              height: '36px',
              marginBottom: '2px',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {Icons.plus(iconColor, 24)}
          </button>
        )}
      </div>
    </div>
  );
}
