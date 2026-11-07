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
 * Each plan's name is a heading, and the card is still one tap: the button
 * that opens the plan holds the name inside the heading and its tap area is
 * stretched over the card (index.css .nest-stretch). As one big button the
 * card's name was a span, a button's children are presentational, and
 * VoiceOver's rotor had no heading to move from plan to plan. The cards are a
 * list, so a screen reader says how many there are.
 *
 * Flat white cards on the cream ground, no border and no shadow: depth is for
 * what floats over the page, and these do not.
 */
import React from 'react';
import { FaceRow } from './Face';
import NestChip from './NestChip';

const listReset = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' };

export function NestPlanCard({ card, level = 3 }) {
  const Heading = level === 4 ? 'h4' : 'h3';
  const base = `nest-card-${card.id}`;
  const described = [card.time || card.place ? `${base}-when` : null, card.chip ? `${base}-chip` : null, `${base}-who`].filter(Boolean).join(' ');
  return (
    <li
      data-nest-plan={card.id}
      style={{
        position: 'relative',
        isolation: 'isolate',
        padding: '14px 16px',
        borderRadius: '12px',
        backgroundColor: 'var(--bg-card-solid)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
        <Heading style={{ flex: 1, minWidth: 0, margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', lineHeight: 1.2, letterSpacing: '-0.01em', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
          <button type="button" className="nest-stretch" onClick={card.onClick} aria-describedby={described}>{card.name}</button>
        </Heading>
        <NestChip chip={card.chip} id={`${base}-chip`} />
      </div>
      <p id={`${base}-when`} style={{ margin: '4px 0 0', fontSize: 'var(--t-label)' }}>
        {card.time && <span style={{ whiteSpace: 'nowrap', fontWeight: '600', color: 'var(--text-primary)' }}>{card.time}</span>}
        {card.time && <span style={{ color: 'var(--text-secondary)' }}> · </span>}
        <span style={{ whiteSpace: 'nowrap', fontWeight: '500', color: 'var(--text-secondary)' }}>{card.place}</span>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
        <FaceRow people={card.faces} total={card.total} size={28} max={4} />
        <span id={`${base}-who`} style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>{card.total} going</span>
      </div>
    </li>
  );
}

export default function NestComingUp({ groups = [] }) {
  if (groups.length === 0) return null;
  return (
    <div data-nest-band="coming-up" style={{ marginBottom: '28px' }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>Coming up</h2>
      {groups.map((g, gi) => (
        <div key={g.label} style={{ marginTop: gi === 0 ? 0 : '18px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)' }}>{g.label}</h3>
          <ul role="list" style={listReset}>
            {g.cards.map((card) => <NestPlanCard key={card.id} card={card} level={4} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}
