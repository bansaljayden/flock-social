/**
 * The promotion editor shows the time slot a deal really has (venue audit
 * 2026-10-03). The quick-deal chips save "Weekend", which the editor's select
 * did not offer, so a quick deal opened in Edit read "Happy Hour" and choosing
 * Happy Hour changed nothing. Since the Custom choice (lib/promoChoice.js), a
 * value the lists do not name opens under Custom with its words in the box.
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { PromoModal } from '../App';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');

const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847' };

test('every time slot a quick deal can save is one the editor offers', () => {
  const chips = /\{\[('Happy Hour'[^\]]*)\]\.map\(slot =>/.exec(DASH);
  expect(chips).not.toBeNull();
  const saved = chips[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  const select = APP.slice(APP.indexOf('<select id="promo-time-slot"'), APP.indexOf('</select>', APP.indexOf('<select id="promo-time-slot"')));
  for (const slot of saved) expect(select).toContain(`<option value="${slot}">`);
  // And the card's Custom chip saves words the editor opens under its own
  // Custom choice.
  expect(DASH).toContain('onClick={() => setDealTimeSlot(PROMO_CUSTOM)}');
  expect(select).toContain('<option value={PROMO_CUSTOM}>Custom</option>');
});

test('the named options are exactly the lists the editor checks a stored value against', () => {
  const lists = /const PROMO_TIME_SLOTS = \[([^\]]*)\];/.exec(APP)[1];
  const select = APP.slice(APP.indexOf('<select id="promo-time-slot"'), APP.indexOf('</select>', APP.indexOf('<select id="promo-time-slot"')));
  const offered = [...select.matchAll(/<option value="([^"]+)">/g)].map((m) => `'${m[1]}'`).join(', ');
  expect(lists).toBe(offered);
});

test('a stored value the lists do not name opens under Custom with its words, not as the first option', () => {
  render(
    <PromoModal
      editing={{ id: 7, title: 'Half-price wings', description: null, time_slot: '5 to 7pm', days: 'Tuesday to Thursday' }}
      onSave={jest.fn()}
      onCancel={() => {}}
      colors={colors}
    />
  );
  expect(screen.getByLabelText('Time Slot').value).toBe('custom');
  expect(screen.getByLabelText('Custom time slot')).toHaveValue('5 to 7pm');
  expect(screen.getByLabelText('Days Active').value).toBe('custom');
  expect(screen.getByLabelText('Custom days')).toHaveValue('Tuesday to Thursday');
});

test('a stored value the lists name opens selected, with no Custom box', () => {
  render(
    <PromoModal
      editing={{ id: 8, title: 'Brunch', description: null, time_slot: 'Weekend', days: 'Fri-Sun' }}
      onSave={jest.fn()}
      onCancel={() => {}}
      colors={colors}
    />
  );
  expect(screen.getByLabelText('Time Slot').value).toBe('Weekend');
  expect(screen.getByLabelText('Days Active').value).toBe('Fri-Sun');
  expect(screen.queryByLabelText('Custom time slot')).toBeNull();
  expect(screen.queryByLabelText('Custom days')).toBeNull();
});
