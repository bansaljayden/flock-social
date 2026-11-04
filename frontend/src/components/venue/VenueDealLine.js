/**
 * A VENUE'S DEAL, ON ONE LINE.
 *
 * The venue page lists every live deal a venue's owner has posted under "Deals
 * & Promotions" and the gift glyph, each as a card: the title, the description,
 * then the time slot and days (components/overlays/VenueDetailSheet.js). A
 * flock's vote and Birdie's venue cards carry ONE of them, the newest the server
 * says this person may see (backend utils/venueDeals.js, the venue page's own
 * rules), as { title, time_slot, days }, and draw it here in the page's style:
 * the gift glyph in the accent, the title in the page's title tone, and when it
 * runs after a middle dot in the page's quieter tone. One line that truncates
 * rather than wraps, so a long deal never pushes a vote row's buttons around.
 *
 * NOTHING HERE DECIDES WHO SEES A DEAL. A drink deal never arrives for an
 * account the server does not know is 21, so this file draws what it is handed.
 * No deal, or a deal with no title, draws nothing.
 *
 * THE WORDS ARE THE OWNER'S. The time slot and the days are a choice from the
 * owner's editor ("Happy Hour", "Weekdays") or, with its Custom choice, their
 * own words ("5 to 7pm", "Tuesday to Thursday"), and they are printed as
 * written. Nothing stores when a deal starts or ends, so nothing here says it
 * is on right now; the venue page does not either.
 *
 * A span, not a paragraph, because two of the rows it sits in are buttons, and
 * a button holds phrasing content only.
 */
import React from 'react';
import Icons from '../ui/Icons';

const words = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// { title, time_slot, days } from whatever a payload carried, or null.
export function dealOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = words(raw.title);
  if (!title) return null;
  return { title, time_slot: words(raw.time_slot), days: words(raw.days) };
}

// When it runs, the way the venue page prints it: "Happy Hour · Weekdays".
export function dealWhen(deal) {
  const d = dealOf(deal);
  return d ? [d.time_slot, d.days].filter(Boolean).join(' · ') : '';
}

// The whole line as text: "Half-price wings · Happy Hour · Weekdays".
export function dealLineText(deal) {
  const d = dealOf(deal);
  if (!d) return '';
  const when = dealWhen(d);
  return when ? `${d.title} · ${when}` : d.title;
}

// The words for a control whose aria-label replaces its content, so a screen
// reader hears the deal there too: "Deal: Half-price wings, Happy Hour, Weekdays".
export function dealSpokenText(deal) {
  const d = dealOf(deal);
  return d ? `Deal: ${[d.title, d.time_slot, d.days].filter(Boolean).join(', ')}` : '';
}

export default function VenueDealLine({ deal, iconColor = 'currentColor', style, className }) {
  const d = dealOf(deal);
  if (!d) return null;
  const when = dealWhen(d);
  return (
    <span
      data-deal-line=""
      className={className}
      title={dealLineText(d)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        minWidth: 0,
        margin: 0,
        fontSize: 'var(--t-meta)',
        lineHeight: 1.3,
        ...style,
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{Icons.gift(iconColor, 12, 'Deal')}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{d.title}</span>
        {when && <span style={{ color: 'var(--text-tertiary)' }}>{` · ${when}`}</span>}
      </span>
    </span>
  );
}
