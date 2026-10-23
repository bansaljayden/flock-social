/**
 * ONE SECTION OF THE TABLES TAB.
 *
 * The tab is a stack of these, one card each, built the way every other card
 * on the venue dashboard is: the card surface, 12px corners, the small shadow
 * and a title-sized heading. A section added later looks like it was always
 * there and needs nothing from the sections above it.
 */
import React from 'react';

// How far the live part of a section fades while its readings have stopped
// or its last refresh failed: the board, the waits and the incoming list all
// dim by the same amount, so the tab reads as one surface in one state.
export const STALE_OPACITY = 0.55;

// The one line a section says in place of its body when its read failed and
// nothing came before it.
export function SectionLine({ children }) {
  return <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{children}</p>;
}

// The skeleton a section is while its read is out: the shape of the card in
// the global shimmer, roughly the card's height so the card arriving in its
// place barely moves the page.
export function SectionSkeleton({ height, testId }) {
  return <div aria-hidden="true" data-testid={testId} className="skeleton" style={{ height: `${height}px`, borderRadius: '12px', marginBottom: '12px' }} />;
}

// The two sentences over a section whose readings have stopped or whose
// refresh failed: the lead in the amber the tab uses for "look here", the
// detail after it.
export function SectionNotice({ lines }) {
  return (
    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.45 }}>
      <span style={{ fontWeight: '700', color: 'var(--accent-amber-text)' }}>{lines.lead}</span>
      {' '}{lines.detail}
    </p>
  );
}

export default function TablesSection({ title, colors, children }) {
  return (
    <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '14px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>{title}</h3>
      {children}
    </div>
  );
}
