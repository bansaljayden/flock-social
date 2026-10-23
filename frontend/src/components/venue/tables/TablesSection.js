/**
 * ONE SECTION OF THE TABLES TAB.
 *
 * The tab is a stack of these, one card each, built the way every other card
 * on the venue dashboard is: the card surface, 12px corners, the small shadow
 * and a title-sized heading. A section added later looks like it was always
 * there and needs nothing from the sections above it.
 */
import React from 'react';

export default function TablesSection({ title, colors, children }) {
  return (
    <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '14px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>{title}</h3>
      {children}
    </div>
  );
}
