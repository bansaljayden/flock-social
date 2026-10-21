/**
 * VENUE OWNERS CAN SET A DEAL'S TIME AND DAYS IN THEIR OWN WORDS.
 *
 * The promotion editor's Time Slot and Days Active selects, and the Post a
 * Deal card's slot chips, each have a Custom choice that opens a box for the
 * owner's own words ("5 to 7pm", "Tuesday to Thursday"). The server already
 * takes free text in both fields, 60 characters at most, stripped and screened
 * (backend/routes/venueDashboard.js), so the form adds no rule except that a
 * Custom box may not be saved empty. lib/promoChoice.js holds the two helpers.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern promoCustomChoice
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PromoModal } from '../App';
import { PROMO_CUSTOM, PROMO_CUSTOM_MAX, splitPromoChoice, joinPromoChoice } from '../lib/promoChoice';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const DASH = read('frontend', 'src', 'screens', 'VenueDashboard.js');
const ROUTE = read('backend', 'routes', 'venueDashboard.js');

const { quickDealTimeSlot } = require('../screens/VenueDashboard');

const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847' };
const PRESETS = ['Happy Hour', 'Late Night', 'All Day'];

describe('the two helpers', () => {
  test('a stored value is a named choice, or Custom with its words, or the fallback when empty', () => {
    expect(splitPromoChoice('Late Night', PRESETS, 'All Day')).toEqual({ choice: 'Late Night', custom: '' });
    expect(splitPromoChoice('  5 to 7pm ', PRESETS, 'All Day')).toEqual({ choice: PROMO_CUSTOM, custom: '5 to 7pm' });
    expect(splitPromoChoice('', PRESETS, 'All Day')).toEqual({ choice: 'All Day', custom: '' });
    expect(splitPromoChoice(null, PRESETS, 'All Day')).toEqual({ choice: 'All Day', custom: '' });
    expect(splitPromoChoice('x'.repeat(80), PRESETS, 'All Day').custom).toHaveLength(PROMO_CUSTOM_MAX);
  });

  test('what is saved is the named choice, or the trimmed words, or empty for an empty Custom box', () => {
    expect(joinPromoChoice('Late Night', 'ignored')).toBe('Late Night');
    expect(joinPromoChoice(PROMO_CUSTOM, '  5 to 7pm  ')).toBe('5 to 7pm');
    expect(joinPromoChoice(PROMO_CUSTOM, '   ')).toBe('');
    expect(joinPromoChoice(PROMO_CUSTOM, undefined)).toBe('');
    expect(joinPromoChoice(PROMO_CUSTOM, 'y'.repeat(90))).toHaveLength(PROMO_CUSTOM_MAX);
  });

  test("the box's limit is the server's own limit on both fields", () => {
    for (const route of ["router.post('/promotions'", "router.put('/promotions/:id'"]) {
      const chain = ROUTE.slice(ROUTE.indexOf(route), ROUTE.indexOf('async (req, res)', ROUTE.indexOf(route)));
      expect(chain).toMatch(new RegExp(`'time slot'\\)\\.isLength\\(\\{ max: ${PROMO_CUSTOM_MAX} \\}\\)`));
      expect(chain).toMatch(new RegExp(`'days'\\)\\.isLength\\(\\{ max: ${PROMO_CUSTOM_MAX} \\}\\)`));
    }
  });
});

describe('the promotion editor', () => {
  test('Custom opens a box, an empty box does not save, and the words are what is saved', async () => {
    const onSave = jest.fn(() => Promise.resolve());
    render(<PromoModal editing={null} onSave={onSave} onCancel={() => {}} colors={colors} />);
    fireEvent.change(screen.getByLabelText('Deal title'), { target: { value: 'Half-price wings' } });
    expect(screen.queryByLabelText('Custom time slot')).toBeNull();

    fireEvent.change(screen.getByLabelText('Time Slot'), { target: { value: PROMO_CUSTOM } });
    const box = screen.getByLabelText('Custom time slot');
    expect(box).toHaveAttribute('maxLength', String(PROMO_CUSTOM_MAX));
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(box, { target: { value: '  5 to 7pm  ' } });
    fireEvent.change(screen.getByLabelText('Days Active'), { target: { value: PROMO_CUSTOM } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Custom days'), { target: { value: 'Tuesday to Thursday' } });

    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).not.toBeDisabled();
    await act(async () => { fireEvent.click(create); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Half-price wings', time: '5 to 7pm', days: 'Tuesday to Thursday' });
  });

  test('a named choice saves as itself, whatever was typed in a Custom box before', async () => {
    const onSave = jest.fn(() => Promise.resolve());
    render(<PromoModal editing={null} onSave={onSave} onCancel={() => {}} colors={colors} />);
    fireEvent.change(screen.getByLabelText('Deal title'), { target: { value: 'Brunch' } });
    fireEvent.change(screen.getByLabelText('Time Slot'), { target: { value: PROMO_CUSTOM } });
    fireEvent.change(screen.getByLabelText('Custom time slot'), { target: { value: 'Sunday mornings' } });
    fireEvent.change(screen.getByLabelText('Time Slot'), { target: { value: 'Weekend Brunch' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    expect(onSave.mock.calls[0][0]).toMatchObject({ time: 'Weekend Brunch', days: 'Daily' });
  });

  test('a stored deal with no slot opens on All Day, so saving it does not make it a drink deal', () => {
    render(
      <PromoModal
        editing={{ id: 3, title: 'Wings', description: null, time_slot: null, days: null }}
        onSave={jest.fn()}
        onCancel={() => {}}
        colors={colors}
      />
    );
    expect(screen.getByLabelText('Time Slot').value).toBe('All Day');
    expect(screen.getByLabelText('Days Active').value).toBe('Daily');
  });
});

describe('the Post a Deal card', () => {
  const card = DASH.slice(DASH.indexOf('Post a Deal</h3>'), DASH.indexOf('Post Deal\n'));

  test('has a Custom chip that opens a box for when the deal runs, capped at the server limit', () => {
    expect(card).toMatch(/aria-pressed=\{dealTimeSlot === PROMO_CUSTOM\}/);
    expect(card).toMatch(/onClick=\{\(\) => setDealTimeSlot\(PROMO_CUSTOM\)\}/);
    expect(card).toMatch(/\{dealTimeSlot === PROMO_CUSTOM && \(\s*<SearchInputLocal aria-label="When the deal runs"\s+type="text"\s+maxLength=\{PROMO_CUSTOM_MAX\}/);
    expect(card).toMatch(/initialValue=\{dealCustomTime\}\s+onCommit=\{setDealCustomTime\}/);
  });

  test('the chips wrap, so five fit a 320px screen', () => {
    expect(card).toMatch(/display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px'/);
  });

  test('Post Deal waits for words in an open Custom box, like it waits for the deal itself', () => {
    expect(card).toMatch(/disabled=\{!dealDescription\.trim\(\) \|\| !quickDealTimeSlot\(dealTimeSlot, dealCustomTime\)\}/);
    expect(quickDealTimeSlot('Late Night', 'ignored')).toBe('Late Night');
    expect(quickDealTimeSlot(PROMO_CUSTOM, ' 5 to 7pm ')).toBe('5 to 7pm');
    expect(quickDealTimeSlot(PROMO_CUSTOM, '')).toBe('');
  });

  test('its example is a food deal, not a drink deal most people would not be shown', () => {
    expect(card).toMatch(/placeholder="e\.g\., Half-price appetizers until 8pm"/);
    expect(card).not.toMatch(/drinks until/);
  });
});
