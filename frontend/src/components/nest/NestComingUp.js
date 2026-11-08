/**
 * COMING UP: the reader's later plans, by when. STILL OPEN: the ones whose
 * night has gone by and that are not finished.
 *
 * People choose a band first ("this week"), then a plan in it, so a long list
 * is grouped by when (lib/nestTime.js comingGroups). A short one is not: a
 * label over one card is scaffolding, and three labels each over a single
 * card made two levels of heading for three plans, so the labels show only
 * when a band holds two or more plans or there are four or more in all
 * (showComingLabels), and otherwise each card says its whole day itself.
 * A label is quieter than the band's heading and of another kind, small and
 * tertiary with a hairline after it (nestBand.js BAND_LABEL), so Coming up
 * over This week no longer reads as two headings stacked.
 *
 * Each card says three things: the plan's name in the display face, when and
 * where on one line, and who, with the head count in words beside the faces.
 * Its chip states the reader's own state (lib/nestHero.js planChip), so a
 * plan the reader voted on says Voted, not Needs Votes. A plan whose ask is
 * already a Needs you row is not a card here at all: one place per open loop
 * (App.js).
 *
 * Plans whose night has gone by were a group called Earlier under the
 * heading Coming up, with a Time passed chip: past plans under "coming up".
 * They are their own band after it, Still open, and only while there are any.
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
import { BAND_HEAD, BAND_GAP, BAND_LABEL, BAND_LABEL_RULE, LABEL_GAP_FIRST, LABEL_GAP } from './nestBand';

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
        borderRadius: 'var(--r-md)',
        backgroundColor: 'var(--bg-card-solid)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
        <Heading style={{ flex: 1, minWidth: 0, margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', lineHeight: 1.2, letterSpacing: '-0.01em', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
          <button type="button" className="nest-stretch" onClick={card.onClick} aria-describedby={described}>{card.name}</button>
        </Heading>
        <NestChip chip={card.chip} id={`${base}-chip`} />
      </div>
      {/* The dot travels with the place, so a narrow card breaks before it
          and never leaves it hanging at the end of the time. */}
      <p id={`${base}-when`} style={{ margin: '4px 0 0', fontSize: 'var(--t-label)' }}>
        {card.time && <span style={{ whiteSpace: 'nowrap', fontWeight: '600', color: 'var(--text-primary)' }}>{card.time}</span>}
        {card.time && ' '}
        <span style={{ whiteSpace: 'nowrap', fontWeight: '500', color: 'var(--text-secondary)' }}>{card.time ? '· ' : ''}{card.place}</span>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
        <FaceRow people={card.faces} total={card.total} size={28} max={4} />
        <span id={`${base}-who`} style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>{card.total} going</span>
      </div>
    </li>
  );
}

export default function NestComingUp({ groups = [], labelled = true }) {
  if (groups.length === 0) return null;
  return (
    <div data-nest-band="coming-up" style={{ marginBottom: BAND_GAP }}>
      <h2 style={BAND_HEAD}>Coming up</h2>
      {labelled ? groups.map((g, gi) => (
        <div key={g.label} style={{ marginTop: gi === 0 ? LABEL_GAP_FIRST : LABEL_GAP }}>
          <h3 style={BAND_LABEL}>
            <span>{g.label}</span>
            <span aria-hidden="true" style={BAND_LABEL_RULE} />
          </h3>
          <ul style={listReset}>
            {g.cards.map((card) => <NestPlanCard key={card.id} card={card} level={4} />)}
          </ul>
        </div>
      )) : (
        <ul style={listReset}>
          {groups.flatMap((g) => g.cards).map((card) => <NestPlanCard key={card.id} card={card} level={3} />)}
        </ul>
      )}
    </div>
  );
}

export function NestStillOpen({ cards = [] }) {
  if (cards.length === 0) return null;
  return (
    <div data-nest-band="still-open" style={{ marginBottom: BAND_GAP }}>
      <h2 style={BAND_HEAD}>Still open</h2>
      <ul style={listReset}>
        {cards.map((card) => <NestPlanCard key={card.id} card={card} level={3} />)}
      </ul>
    </div>
  );
}
