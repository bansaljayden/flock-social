/**
 * The promotion editor shows the time slot a deal really has (venue audit
 * 2026-10-03). The quick-deal chips once saved a slot the editor's select did
 * not offer, so a quick deal opened in Edit read "Happy Hour" and choosing
 * Happy Hour changed nothing. Since the Custom choice (lib/promoChoice.js), a
 * value the lists do not name opens under Custom with its words in the box.
 *
 * 2026-10-20: "Mon-Fri" left the Days menu (it said what "Weekdays" says) and
 * "Weekend" left the Time Slot menu and the quick-deal chips. A deal saved with
 * either still opens with its own word in the box and saves it back unchanged.
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PromoModal } from '../App';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');

const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847' };

const optionValues = (select) => [...select.querySelectorAll('option')].map((o) => o.value);

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
  const dayList = /const PROMO_DAYS = \[([^\]]*)\];/.exec(APP)[1];
  const daySelect = APP.slice(APP.indexOf('<select id="promo-days-active"'), APP.indexOf('</select>', APP.indexOf('<select id="promo-days-active"')));
  const dayOffered = [...daySelect.matchAll(/<option value="([^"]+)">/g)].map((m) => `'${m[1]}'`).join(', ');
  expect(dayList).toBe(dayOffered);
});

test('the menus offer no duplicate: no Mon-Fri beside Weekdays, no Weekend slot beside Weekends', () => {
  render(<PromoModal editing={null} onSave={jest.fn()} onCancel={() => {}} colors={colors} />);
  expect(optionValues(screen.getByLabelText('Time Slot'))).toEqual(['Happy Hour', 'Late Night', 'Weekend Brunch', 'All Day', 'custom']);
  expect(optionValues(screen.getByLabelText('Days Active'))).toEqual(['Daily', 'Weekdays', 'Weekends', 'Fri-Sun', 'custom']);
  // The quick-deal chips on the dashboard dropped the slot too.
  expect(DASH).toContain("{['Happy Hour', 'Late Night', 'All Day'].map(slot =>");
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

test('a deal saved as Weekend, Mon-Fri opens with those words and saves them back unchanged', async () => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  render(
    <PromoModal
      editing={{ id: 9, title: 'Taco deal', description: null, time_slot: 'Weekend', days: 'Mon-Fri' }}
      onSave={onSave}
      onCancel={() => {}}
      colors={colors}
    />
  );
  expect(screen.getByLabelText('Time Slot').value).toBe('custom');
  expect(screen.getByLabelText('Custom time slot')).toHaveValue('Weekend');
  expect(screen.getByLabelText('Days Active').value).toBe('custom');
  expect(screen.getByLabelText('Custom days')).toHaveValue('Mon-Fri');
  await act(async () => { fireEvent.click(screen.getByText('Save Changes')); });
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Taco deal', time: 'Weekend', days: 'Mon-Fri' });
});

test('a stored value the lists name opens selected, with no Custom box', () => {
  render(
    <PromoModal
      editing={{ id: 8, title: 'Brunch', description: null, time_slot: 'Weekend Brunch', days: 'Fri-Sun' }}
      onSave={jest.fn()}
      onCancel={() => {}}
      colors={colors}
    />
  );
  expect(screen.getByLabelText('Time Slot').value).toBe('Weekend Brunch');
  expect(screen.getByLabelText('Days Active').value).toBe('Fri-Sun');
  expect(screen.queryByLabelText('Custom time slot')).toBeNull();
  expect(screen.queryByLabelText('Custom days')).toBeNull();
});
