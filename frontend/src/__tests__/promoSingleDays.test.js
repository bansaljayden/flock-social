/**
 * THE DEAL FORM CAN SAY "EVERY MONDAY" (2026-11-03).
 *
 * Roost's answer to "How do I fill a slow Monday?" advises one fixed,
 * recurring reason to come in every Monday, and the promotion editor's Days
 * Active menu offered only Daily, Weekdays, Weekends and Fri-Sun, so a Monday
 * quiz night posted as "Weekdays" unless the owner found Custom and typed it.
 * The menu now offers each day of the week on its own, Mondays through
 * Sundays, worded like Weekdays and Weekends, between the groups and Custom.
 *
 * The server side is backend/__tests__/promotionSingleDays.test.js: the
 * routes take every one of them and the drink-deal rule reads them the way it
 * reads Daily.
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PromoModal } from '../App';
import { dealLineText } from '../components/venue/VenueDealLine';

const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847' };
const SINGLE_DAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const optionValues = (select) => [...select.querySelectorAll('option')].map((o) => o.value);

test('the Days menu offers each day of the week on its own, Monday first, after the groups and before Custom', () => {
  render(<PromoModal editing={null} onSave={jest.fn()} onCancel={() => {}} colors={colors} />);
  const values = optionValues(screen.getByLabelText('Days Active'));
  expect(values.slice(values.indexOf('Fri-Sun') + 1, values.indexOf('custom'))).toEqual(SINGLE_DAYS);
  // A new deal still starts on Daily.
  expect(screen.getByLabelText('Days Active').value).toBe('Daily');
});

test('a new deal set to Mondays saves "Mondays", the words the deal line prints', async () => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  render(<PromoModal editing={null} onSave={onSave} onCancel={() => {}} colors={colors} />);
  fireEvent.change(screen.getByLabelText('Deal title'), { target: { value: 'Monday quiz night' } });
  fireEvent.change(screen.getByLabelText('Days Active'), { target: { value: 'Mondays' } });
  // A day of the week is a choice from the list, not Custom: no box to fill.
  expect(screen.queryByLabelText('Custom days')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByText('Create')); });
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Monday quiz night', time: 'All Day', days: 'Mondays' });
  expect(dealLineText({ title: 'Monday quiz night', time_slot: 'All Day', days: 'Mondays' })).toBe('Monday quiz night · All Day · Mondays');
});

test.each(SINGLE_DAYS)('a deal stored as %s opens with it selected and saves it back unchanged', async (day) => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  render(
    <PromoModal
      editing={{ id: 5, title: 'Half-price wings', description: null, time_slot: 'Late Night', days: day }}
      onSave={onSave}
      onCancel={() => {}}
      colors={colors}
    />
  );
  expect(screen.getByLabelText('Days Active').value).toBe(day);
  expect(screen.queryByLabelText('Custom days')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByText('Save Changes')); });
  expect(onSave.mock.calls[0][0]).toMatchObject({ time: 'Late Night', days: day });
});

test('the owner\'s own words still open under Custom, a single day included', () => {
  render(
    <PromoModal
      editing={{ id: 6, title: 'Quiz night', description: null, time_slot: 'All Day', days: 'Every Monday' }}
      onSave={jest.fn()}
      onCancel={() => {}}
      colors={colors}
    />
  );
  expect(screen.getByLabelText('Days Active').value).toBe('custom');
  expect(screen.getByLabelText('Custom days')).toHaveValue('Every Monday');
});
