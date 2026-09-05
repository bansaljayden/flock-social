import React from 'react';
import './chat.css';

/**
 * DayDivider: the line between one night and the next.
 *
 * WHAT THIS REPLACES. The pill both chat screens draw today, a 12px semibold
 * label on a `--bg-hover` rounded rectangle. The capture has no pill: the day
 * is centred bare type, about 9, uppercase and tracked, in the secondary
 * colour. It reads as a margin note rather than a control, which is right,
 * because there is nothing to press.
 *
 * THE UPPERCASING IS CSS, not the string. `text-transform` leaves the DOM text
 * as "Today", so VoiceOver says the word instead of spelling out a shouted
 * one, and the tracking is what keeps small caps legible at 9. Same reason the
 * system notice row and the name label do it that way.
 *
 * `role="separator"` because that is what it is, and an aria-label so the
 * announcement is a sentence rather than a bare date.
 */
export default function DayDivider({ label }) {
  if (!label) return null;
  return (
    <div
      role="separator"
      aria-label={`Messages from ${label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '10px 0 8px',
      }}
    >
      <span
        style={{
          fontSize: 'var(--chat-divider-size)',
          lineHeight: '12px',
          fontWeight: 700,
          letterSpacing: '0.9px',
          textTransform: 'uppercase',
          color: 'var(--chat-meta)',
        }}
      >
        {label}
      </span>
    </div>
  );
}
