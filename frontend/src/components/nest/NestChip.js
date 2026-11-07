/**
 * The chip on a Nest plan row or card (lib/nestHero.js planChip). One colour
 * means one thing: the steel tint is reserved for the reader's own ask, and
 * every other state sits on the quiet inset well.
 */
import React from 'react';
import Icons from '../ui/Icons';

export default function NestChip({ chip, id }) {
  if (!chip) return null;
  const accent = chip.tone === 'accent';
  const ink = accent ? 'var(--accent-purple-text)' : 'var(--text-secondary)';
  return (
    <span
      id={id}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        padding: '3px 10px',
        borderRadius: '999px',
        backgroundColor: accent ? 'var(--accent-purple-bg)' : 'var(--bg-inset)',
        color: ink,
        fontSize: 'var(--t-label)',
        fontWeight: accent ? '600' : '500',
        lineHeight: '18px',
      }}
    >
      {chip.icon === 'check' && Icons.check(ink, 12)}
      {chip.icon === 'star' && Icons.star(ink, 12)}
      {chip.label}
    </span>
  );
}
