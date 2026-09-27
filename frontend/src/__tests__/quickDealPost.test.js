/**
 * THE POST A DEAL CARD POSTS ITS ONE LINE ONCE, WITHIN THE LIMIT THE SERVER
 * HOLDS IT TO.
 *
 * The card on the Analytics tab has a single box. It sent that text as both
 * the title and the description of a promotion, and that went wrong twice:
 *
 *   * POST /api/venue-dashboard/promotions caps a title at 80 characters and
 *     the box had no cap, so a deal of 81 to 300 characters came back as
 *     "Title is required (max 80 characters)", a field this card does not
 *     have.
 *   * Every deal that did post showed the same sentence twice on the venue
 *     card, once bold as the title and again as the description beneath it.
 *
 * The box is the title now: it stops at the server's own limit and the post
 * carries no description. The Promotions tab's modal, which edits these
 * deals, no longer demands a description the card never asked for.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern quickDealPost
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PromoModal } from '../App';

const fs = require('fs');
const path = require('path');

const { QUICK_DEAL_MAX, quickDealBody } = require('../screens/VenueDashboard');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const DASH = read('frontend', 'src', 'screens', 'VenueDashboard.js');
const ROUTE = read('backend', 'routes', 'venueDashboard.js');

describe('what the Post a Deal card sends', () => {
  test('the text is the title, once, with no description to repeat it', () => {
    const body = quickDealBody('2-for-1 drinks until 8pm', 'Happy Hour');
    expect(body).toEqual({ title: '2-for-1 drinks until 8pm', timeSlot: 'Happy Hour', days: 'Daily' });
    expect(body).not.toHaveProperty('description');
  });

  test('the card posts through that body, not an inline copy of the old one', () => {
    const card = DASH.slice(DASH.indexOf('Post a Deal</h3>'), DASH.indexOf('Post Deal\n'));
    expect(card).toMatch(/createVenuePromotion\(quickDealBody\(text, dealTimeSlot\)\)/);
    expect(card).not.toMatch(/description: text/);
  });

  test("the box stops at the server's title limit, so it cannot be refused for length", () => {
    const create = ROUTE.slice(ROUTE.indexOf("router.post('/promotions'"));
    const cap = /freeText\(body\('title'\), 'title'\)\.isLength\(\{ min: 1, max: (\d+) \}\)/.exec(create);
    expect(cap).not.toBeNull();
    expect(QUICK_DEAL_MAX).toBe(Number(cap[1]));

    const card = DASH.slice(DASH.indexOf('Post a Deal</h3>'), DASH.indexOf('Post Deal\n'));
    expect(card).toMatch(/<SearchInputLocal aria-label="Deal"\s+type="text"\s+maxLength=\{QUICK_DEAL_MAX\}/);
    // And says so once it is close, so a box that stops taking letters is not
    // a box that looks broken.
    expect(card).toMatch(/\{dealDescription\.length\}\/\{QUICK_DEAL_MAX\}/);
  });
});

describe('a deal the card posted before this reads once too', () => {
  // Those rows carry the title again as the description, and they are still
  // on venue cards, so the display drops a description that only repeats.
  const SHEET = read('frontend', 'src', 'components', 'overlays', 'VenueDetailSheet.js');

  test('the public venue card skips a description equal to the title', () => {
    expect(SHEET).toMatch(/\{p\.description && p\.description !== p\.title && <p /);
  });

  test("the owner's own list does the same", () => {
    expect(DASH).toMatch(/\(promo\.description \|\| promo\.desc\) && \(promo\.description \|\| promo\.desc\) !== promo\.title \?/);
  });
});

describe('a deal with no description can still be edited', () => {
  const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847' };

  test('Save Changes is live on a title-only deal, and saves it as it is', async () => {
    const onSave = jest.fn(() => Promise.resolve());
    render(
      <PromoModal
        editing={{ id: 5, title: 'Half-price wings', description: null, time_slot: 'Happy Hour', days: 'Daily' }}
        onSave={onSave}
        onCancel={() => {}}
        colors={colors}
      />
    );
    const save = screen.getByRole('button', { name: 'Save Changes' });
    expect(save).not.toBeDisabled();
    await act(async () => { fireEvent.click(save); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Half-price wings', desc: '' });
  });

  test('a blank title is still refused', () => {
    render(<PromoModal editing={null} onSave={jest.fn()} onCancel={() => {}} colors={colors} />);
    fireEvent.change(screen.getByLabelText('Deal title'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Deal description'), { target: { value: 'Something' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
