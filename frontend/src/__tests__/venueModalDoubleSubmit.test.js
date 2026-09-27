/**
 * A DOUBLE TAP ON CREATE POSTS ONE DEAL, NOT TWO.
 *
 * The Promotion and Event modals on the venue dashboard hand their form to an
 * onSave that awaits the network, and the dashboard closes the modal only once
 * that resolves. Create had no in-flight state, so for the whole round trip it
 * stayed live over the same form. POST /promotions and POST /events are plain
 * INSERTs with nothing unique behind them, so a double tap on iOS, or a retap
 * while the request was slow, published the same deal (or event) twice on the
 * venue card.
 *
 * These drive the real modals from App.js: a second tap while a save is in
 * flight must not reach onSave, and a save that comes back without closing
 * the modal (a refusal the dashboard shows as a toast) must give the button
 * back so the owner can fix the text and try again.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern venueModalDoubleSubmit
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PromoModal, EventModal } from '../App';

const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847' };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const MODALS = [
  {
    name: 'PromoModal',
    Modal: PromoModal,
    fill: () => {
      fireEvent.change(screen.getByLabelText('Deal title'), { target: { value: 'Half-price apps' } });
      fireEvent.change(screen.getByLabelText('Deal description'), { target: { value: '50% off every appetizer' } });
    },
  },
  {
    name: 'EventModal',
    Modal: EventModal,
    fill: () => {
      fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Live Jazz Night' } });
    },
  },
];

describe.each(MODALS)('$name', ({ Modal, fill }) => {
  test('a second tap while the first save is in flight does not save again', async () => {
    const pending = deferred();
    const onSave = jest.fn(() => pending.promise);
    render(<Modal editing={null} onSave={onSave} onCancel={() => {}} colors={colors} />);
    fill();

    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('button', { name: /Saving/ }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();

    await act(async () => { pending.resolve(); await pending.promise; });
  });

  test('a save that leaves the modal open gives the button back, with the form intact', async () => {
    // The dashboard answers a refusal (profanity screen, a taken-down row) with
    // a toast and keeps the modal open. Holding the button after that would be
    // a dead control over text the owner is about to correct.
    const first = deferred();
    const onSave = jest.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve());
    render(<Modal editing={null} onSave={onSave} onCancel={() => {}} colors={colors} />);
    fill();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await act(async () => { first.resolve(); await first.promise; });

    const again = screen.getByRole('button', { name: 'Create' });
    expect(again).not.toBeDisabled();
    await act(async () => { fireEvent.click(again); });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0]).toEqual(onSave.mock.calls[0][0]);
  });
});
