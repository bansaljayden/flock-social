/**
 * COMING UP'S BANDS AND CARDS (components/nest/NestComingUp.js).
 *
 * A band label (This week, Later) sat in the band heading's own type, 13px in
 * the secondary ink 8px under it, so Coming up over This week read as two
 * headings stacked, and Later over Still open as two bands. A label is now
 * quieter than the heading and of another kind (nestBand.js BAND_LABEL), with
 * room above it. A card's plan name is in the display face down to its
 * letters, read through the real index.css cascade.
 *
 * jsdom drops a var() it cannot parse from font-size and background, so the
 * type is read from the style objects the component spreads, and the source
 * is held to spreading them.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestComingUp --watchAll=false
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import NestComingUp from '../components/nest/NestComingUp';
import { BAND_HEAD, BAND_LABEL, BAND_LABEL_RULE, LABEL_GAP_FIRST, LABEL_GAP } from '../components/nest/nestBand';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'components', 'nest', 'NestComingUp.js'), 'utf8').replace(/\r\n/g, '\n');

const card = (id, name, extra = {}) => ({
  id, name, time: 'Sun 11:00 AM', place: 'Marigold Diner', faces: [{ key: 1, name: 'Maya' }], total: 2, chip: null, onClick: jest.fn(), ...extra,
});
const GROUPS = [
  { label: 'This week', cards: [card(1, 'Movie Night'), card(2, 'Climbing')] },
  { label: 'Later', cards: [card(3, 'Friday Night Crew')] },
];

describe('a band label is not a second band heading', () => {
  test('the heading is a section label and a band label is quieter: smaller, lighter and in the tertiary ink', () => {
    expect(BAND_HEAD).toMatchObject({ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)' });
    expect(BAND_LABEL).toMatchObject({ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' });
    // Not one property of the type shared, so the two never read as one
    // level again.
    for (const k of ['fontSize', 'fontWeight', 'color']) expect(`${k} ${BAND_LABEL[k]}`).not.toBe(`${k} ${BAND_HEAD[k]}`);
    // Coming up and Still open are band headings; This week and Later are
    // labels, each with its hairline.
    expect(SRC).toMatch(/<h2 style=\{BAND_HEAD\}>Coming up<\/h2>/);
    expect(SRC).toMatch(/<h2 style=\{BAND_HEAD\}>Still open<\/h2>/);
    expect(SRC).toMatch(/<h3 style=\{BAND_LABEL\}>\s*<span>\{g\.label\}<\/span>\s*<span aria-hidden="true" style=\{BAND_LABEL_RULE\} \/>\s*<\/h3>/);
  });

  test('a hairline runs on from each label, for the eye only, and the label says only its words', () => {
    expect(BAND_LABEL_RULE).toMatchObject({ flex: 1, height: '1px', backgroundColor: 'var(--nest-edge)' });
    expect(BAND_LABEL).toMatchObject({ display: 'flex', alignItems: 'center' });
    render(<NestComingUp groups={GROUPS} labelled />);
    for (const name of ['This week', 'Later']) {
      const label = screen.getByRole('heading', { level: 3, name });
      const rule = label.querySelector('[aria-hidden="true"]');
      expect(rule).not.toBeNull();
      expect(rule.textContent).toBe('');
      expect(rule.style.height).toBe('1px');
      expect(label.textContent).toBe(name);
    }
  });

  test('room above each label: 12px under the heading, 20px under the group before', () => {
    render(<NestComingUp groups={GROUPS} labelled />);
    const first = screen.getByRole('heading', { level: 3, name: 'This week' }).parentElement;
    const second = screen.getByRole('heading', { level: 3, name: 'Later' }).parentElement;
    expect(first.style.marginTop).toBe(LABEL_GAP_FIRST);
    expect(second.style.marginTop).toBe(LABEL_GAP);
    expect(LABEL_GAP_FIRST).toBe('12px');
    expect(LABEL_GAP).toBe('20px');
    // The heading's own 8px under it collapses into the group's margin, so
    // the first label stands further from the heading than a band's content
    // does from its heading.
    expect(BAND_HEAD.margin).toBe('0 0 8px');
    // Each label's cards are its own list, named under it as h4s.
    expect(within(first).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Movie Night', 'Climbing']);
  });

  test('a short list draws no labels at all', () => {
    render(<NestComingUp groups={GROUPS} labelled={false} />);
    expect(screen.queryByRole('heading', { level: 3, name: 'This week' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Movie Night', 'Climbing', 'Friday Night Crew']);
  });
});

describe("a card's plan name", () => {
  test('is drawn in the display face, through the real cascade', () => {
    // jsdom applies index.css but does not inherit: walk up past inherit (or
    // nothing) to the face the cascade names. The app's * rule gives every
    // element the body face, so this is the check that the name is not in it.
    const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8').replace(/\r\n/g, '\n');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    try {
      const faceOf = (el) => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const f = getComputedStyle(n).fontFamily;
          if (f && f !== 'inherit') return f;
        }
        return null;
      };
      render(<NestComingUp groups={GROUPS} labelled />);
      expect(faceOf(screen.getByRole('button', { name: 'Movie Night' }))).toBe('var(--font-display)');
      expect(faceOf(screen.getByText('This week'))).toBe('var(--font-body)');
    } finally {
      style.remove();
    }
  });
});
