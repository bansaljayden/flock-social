/**
 * WHO SEES A DRINK DEAL, SAID ON EVERY OWNER FORM THAT WRITES ONE.
 *
 * The server serves a promotion or event about alcohol only to an account
 * whose stored date of birth makes it 21 (backend utils/over21.js, App Store
 * Guideline 1.4.3), and a deal in the Happy Hour slot counts as one. The
 * iPhone app asks nobody for a date of birth, so an owner who is not told
 * would watch a deal go quiet with no reason. This pins the sentence on the
 * Promotions tab form, the event form and the Post a Deal card, that a new deal
 * no longer starts in the Happy Hour slot, and that the interest suggestions
 * offered to every account carry no drink.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern drinkDealOwnerLine
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { PromoModal, EventModal } from '../App';
import { DRINK_DEAL_LINE, DRINK_DEAL_LINE_PROMO } from '../lib/drinkDeals';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('frontend', 'src', 'App.js');
const DASH = read('frontend', 'src', 'screens', 'VenueDashboard.js');
const OVER21 = read('backend', 'utils', 'over21.js');

const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847' };

test('the two sentences, word for word, with no em dash', () => {
  expect(DRINK_DEAL_LINE).toBe('Drink deals are shown only to people we know are 21 or older.');
  expect(DRINK_DEAL_LINE_PROMO).toBe('Drink deals, and anything set in Happy Hour, are shown only to people we know are 21 or older.');
  expect(`${DRINK_DEAL_LINE}${DRINK_DEAL_LINE_PROMO}`).not.toMatch(/—/);
});

test('the promotion form says it, and a new deal starts in All Day', () => {
  render(<PromoModal editing={null} onSave={jest.fn()} onCancel={() => {}} colors={colors} />);
  expect(screen.getByText(DRINK_DEAL_LINE_PROMO)).toBeTruthy();
  expect(screen.getByLabelText('Time Slot').value).toBe('All Day');
});

test('a deal opened to edit keeps the slot it was saved in', () => {
  render(
    <PromoModal
      editing={{ id: 5, title: 'Wings', description: null, time_slot: 'Happy Hour', days: 'Daily' }}
      onSave={jest.fn()}
      onCancel={() => {}}
      colors={colors}
    />
  );
  expect(screen.getByLabelText('Time Slot').value).toBe('Happy Hour');
  expect(screen.getByText(DRINK_DEAL_LINE_PROMO)).toBeTruthy();
});

test('the event form says it', () => {
  render(<EventModal editing={null} onSave={jest.fn()} onCancel={() => {}} colors={colors} />);
  expect(screen.getByText(DRINK_DEAL_LINE)).toBeTruthy();
});

test('the Post a Deal card says it, and its slot starts in All Day', () => {
  // The card is part of the whole dashboard, so it is read, not mounted: the
  // sentence sits between the slot chips and the Post Deal button.
  const card = DASH.slice(DASH.indexOf('Post a Deal</h3>'), DASH.indexOf('Post Deal\n'));
  expect(card).toMatch(/\{DRINK_DEAL_LINE_PROMO\}/);
  expect(card.indexOf('{DRINK_DEAL_LINE_PROMO}')).toBeGreaterThan(card.indexOf("['Happy Hour', 'Late Night', 'Weekend', 'All Day'].map"));
  expect(APP).toMatch(/const \[dealTimeSlot, setDealTimeSlot\] = useState\('All Day'\);/);
});

test('the server reads the Happy Hour slot the way the promotion forms say it does', () => {
  // The days too: the editor's Custom choice lets an owner type "happy hour"
  // into either box, and the card prints both.
  expect(OVER21).toMatch(/const shown = foldTexts\(\[p\.title, p\.description, p\.time_slot, p\.days\]\);\s+if \(hasListWord\(shown\)\) return true;/);
  expect(OVER21).toMatch(/'happy hour'/);
});

test('the interest suggestions offered to every account carry no drink', () => {
  const m = /const suggestedInterests = \[([^\]]*)\];/.exec(APP);
  expect(m).not.toBeNull();
  const chips = m[1].split(',').map((s) => s.trim().replace(/'/g, '').toLowerCase());
  for (const drink of ['wine', 'beer', 'cocktails', 'beer & brews']) expect(chips).not.toContain(drink);
  expect(chips).toContain('sports');
});
