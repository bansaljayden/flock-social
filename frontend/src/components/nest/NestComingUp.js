/**
 * COMING UP: the reader's later plans, in bands of when.
 *
 * People choose a band first ("this week"), then a plan in it, so the list is
 * grouped by when (lib/nestTime.js comingGroups) instead of being one run of
 * cards with a time pill on each. Each card says three things: the plan's
 * name in the display face, when and where on one line, and who, with the
 * head count in words beside the faces. Its chip states the reader's own
 * state (lib/nestHero.js planChip), so a plan the reader voted on says Voted,
 * not Needs Votes.
 *
 * Flat white cards on the cream ground, no border and no shadow: depth is for
 * what floats over the page, and these do not.
 */
import React from 'react';
import { FaceRow } from './Face';
import NestChip from './NestChip';

function Card({ card }) {
  return (
    <button
      type="button"
      onClick={card.onClick}
      style={{
        width: '100%',
        padding: '14px 16px',
        border: 'none',
        borderRadius: '12px',
        backgroundColor: 'var(--bg-card-solid)',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'block',
        color: 'inherit',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', lineHeight: 1.2, letterSpacing: '-0.01em', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{card.name}</span>
        <NestChip chip={card.chip} />
      </span>
      <span style={{ display: 'block', marginTop: '4px', fontSize: 'var(--t-label)' }}>
        {card.time && <span style={{ whiteSpace: 'nowrap', fontWeight: '600', color: 'var(--text-primary)' }}>{card.time}</span>}
        {card.time && <span style={{ color: 'var(--text-secondary)' }}> · </span>}
        <span style={{ whiteSpace: 'nowrap', fontWeight: '500', color: 'var(--text-secondary)' }}>{card.place}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
        <FaceRow people={card.faces} total={card.total} size={28} max={4} />
        <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>{card.total} going</span>
      </span>
    </button>
  );
}

export default function NestComingUp({ groups = [] }) {
  if (groups.length === 0) return null;
  return (
    <div data-nest-band="coming-up" style={{ marginBottom: '28px' }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>Coming up</h2>
      {groups.map((g, gi) => (
        <section key={g.label} aria-label={g.label} style={{ marginTop: gi === 0 ? 0 : '18px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)' }}>{g.label}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {g.cards.map((card) => <Card key={card.id} card={card} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
