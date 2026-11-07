/**
 * The chip on a Nest plan row or card (lib/nestHero.js planChip). One colour
 * means one thing: the steel tint is reserved for the reader's own ask, a
 * plan that is locked in wears blush under navy words (index.css
 * --accent-blush, the second accent, 9.63:1), and every other state sits on
 * the quiet inset well.
 */
import React from 'react';
import Icons from '../ui/Icons';

export default function NestChip({ chip, id }) {
  if (!chip) return null;
  const accent = chip.tone === 'accent';
  const locked = chip.tone === 'locked';
  const ink = accent ? 'var(--accent-purple-text)' : locked ? 'var(--on-accent-blush)' : 'var(--text-secondary)';
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
        backgroundColor: accent ? 'var(--accent-purple-bg)' : locked ? 'var(--accent-blush)' : 'var(--bg-inset)',
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
