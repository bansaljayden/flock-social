import React, { useState } from 'react';
import './chat.css';

/**
 * StatusLine: the one small word under your own last message.
 *
 * WHAT THIS REPLACES. Two things. The per-message "Sending" that both screens
 * print beside every own bubble's timestamp, and the failed-send pair of
 * buttons ChatDetail draws inline ("Didn't send. Tap to retry" plus "Remove").
 * The new stream carries no per-message meta at all, so this is the only
 * receipt on the page and it appears exactly once, under the viewer's last own
 * message. It disappears when the other person's next message arrives, because
 * the parent stops rendering it there.
 *
 * WHO DECIDES WHERE IT GOES. Not this component. It draws whatever status it
 * is handed, and the parent renders it under one row and no other. That is
 * deliberate: "the last own message" is a fact about the whole thread, and a
 * component that could see only its own message would have to guess.
 *
 * NEVER A STATE THE SERVER CANNOT BACK. An unknown or missing status renders
 * nothing at all rather than falling back to "Sent". W1 supplies 'sending'
 * (local, in flight), 'sent' (the send echo), 'delivered' and 'opened' (the
 * dm_delivered / dm_opened receipts and the flock read cursor), and 'failed'
 * is the client's own knowledge that the send never left. There is no sixth.
 *
 * GROUPS. "Opened by 3" expands to the names on tap. The count and the names
 * are the same array, so the expanded form can never disagree with the
 * collapsed one. If a group hands us an empty `openedBy`, the word is plain
 * "Opened": a "0" is not a receipt.
 *
 * THE FAILED STATE'S RED is `--accent-red-text`, and nothing else. ChatDetail
 * writes that same var with a literal fallback beside it, which was only ever
 * insurance: index.css defines the token in BOTH themes, and the dark value
 * was picked to clear 4.5:1 on the surfaces it lands on. A literal in here
 * would be a light mode colour shipped into dark mode the day the fallback
 * ever fired, so this file names the token and never its value. The module's
 * own scan reads this comment too, which is the point: a colour cannot reach
 * src/ through prose either.
 *
 * THE LIVE REGION IS ALWAYS MOUNTED, even with no word in it. A screen reader
 * only notices text arriving inside a region that was already in the
 * accessibility tree; a region created together with its first word is a fresh
 * element insertion, which VoiceOver routinely says nothing about. That is
 * SLOP-AUDIT section N, and it is why an unknown status renders an empty
 * region with no padding rather than nothing at all. It has no height, draws
 * no word, and claims no receipt. The failed state is the one exception: it
 * leaves this region for a `role="alert"` node, which is the pattern screen
 * readers do handle on insertion, and it is the only status with no ladder
 * behind it to sit inside.
 *
 * PROPS
 *   status     'sending' | 'sent' | 'delivered' | 'opened' | 'failed'
 *   openedBy   array of first names, groups only. Ignored unless opened.
 *   onExpand   called when the reader taps "Opened by N". Optional, for
 *              analytics or for a parent that wants to own the disclosure.
 *   expanded   optional controlled disclosure. Left out, the row owns it.
 *   onRetry    failed state only. Sends the message again.
 *   onRemove   failed state only. Drops the row that can never succeed.
 */

const WORDS = {
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  opened: 'Opened',
};

/** "Ava", "Ava and Bo", "Ava, Bo and Cal". */
export function nameList(names) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The status word sits at x 22, lining up with the name label above the run
 * rather than with the body text at 18. MessageGroup renders it BELOW the
 * run's content block and below the end of the coloured bar, which is where
 * the capture has it, so this is a plain indent from the stream's own edge.
 */
const STATUS_INDENT = 'var(--chat-name-x)';

const SMALL = {
  fontSize: 'var(--chat-notice-size)',
  lineHeight: '14px',
  fontWeight: 600,
  letterSpacing: '0.8px',
  textTransform: 'uppercase',
  color: 'var(--chat-notice)',
};

export default function StatusLine({
  status,
  openedBy,
  onExpand,
  expanded,
  onRetry,
  onRemove,
}) {
  const [openLocal, setOpenLocal] = useState(false);
  const isControlled = expanded !== undefined;
  const isOpen = isControlled ? expanded : openLocal;

  if (status === 'failed') {
    return (
      /* role="alert" on the wrapper, not on either button: a button that
         claims the alert role stops announcing as a button. A send that
         fails does it on a timeout with no keypress behind it, so without a
         live region a screen reader user is left believing it went. */
      <div
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '3px 0 0',
          paddingLeft: STATUS_INDENT,
        }}
      >
        <span style={{ ...SMALL, color: 'var(--accent-red-text)' }}>
          Didn&apos;t send
        </span>
        {onRetry && (
          <button
            type="button"
            className="hit44"
            onClick={onRetry}
            style={{
              ...SMALL,
              color: 'var(--accent-red-text)',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="hit44"
            aria-label="Remove this message that did not send"
            onClick={onRemove}
            style={{
              ...SMALL,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            Remove
          </button>
        )}
      </div>
    );
  }

  const word = WORDS[status];
  const readers = (openedBy || []).filter(Boolean);
  const isGroupOpen = status === 'opened' && readers.length > 0;

  let inner = null;
  if (word && !isGroupOpen) {
    inner = <span style={SMALL}>{word}</span>;
  } else if (word) {
    inner = (
      <button
        type="button"
        className="hit44"
        aria-expanded={!!isOpen}
        onClick={() => {
          if (!isControlled) setOpenLocal((v) => !v);
          if (onExpand) onExpand(!isOpen);
        }}
        style={{
          ...SMALL,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {isOpen ? `Opened by ${nameList(readers)}` : `Opened by ${readers.length}`}
      </button>
    );
  }

  return (
    /* Polite, not assertive: a receipt changing under your own message is
       worth hearing, and worth hearing after whatever the reader is doing.
       Rendered whether or not there is a word, so the ladder's first word
       lands in a region that was already there. With no word it has no top
       padding and no child, so it occupies nothing. */
    <div
      aria-live="polite"
      style={{
        paddingTop: word ? '3px' : 0,
        paddingLeft: STATUS_INDENT,
      }}
    >
      {inner}
    </div>
  );
}
