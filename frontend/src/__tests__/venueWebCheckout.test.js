/**
 * Roost on the web: the buy and manage control in the venue plan sheet, and the
 * trip back from Stripe.
 *
 * The rules pinned here:
 *   - inside the iOS shell the control asks the server nothing and renders only
 *     the email request it was handed (VENUE-BILLING.md finding 4, App Review
 *     3.1.1);
 *   - no price the server did not send: the control holds no price literal;
 *   - an unverified venue is never shown a buy button;
 *   - a venue with a Stripe subscription is shown Manage billing, even on its
 *     current plan, so cancelling never needs an email;
 *   - the Stripe return (?venue_billing=...) is taken off the address bar as it
 *     is read, so a refresh cannot replay it.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

jest.mock('../services/api', () => ({
  getVenueBillingStatus: jest.fn(),
  startVenueCheckout: jest.fn(),
  openVenuePortal: jest.fn(),
}));

// eslint-disable-next-line import/first
import { getVenueBillingStatus, startVenueCheckout, openVenuePortal } from '../services/api';
// eslint-disable-next-line import/first
import VenueBillingControl from '../components/venue/VenueBillingControl';
// eslint-disable-next-line import/first
import { readVenueBillingReturn, settleVenueCheckout } from '../lib/venueBillingReturn';

const SRC = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const MONTHLY = { id: 'monthly', unitAmount: 9900, currency: 'USD', interval: 'month', label: '$99.00' };
const YEARLY = { id: 'yearly', unitAmount: 99000, currency: 'USD', interval: 'year', label: '$990.00' };
const ON_SALE = { checkoutAvailable: true, plans: [MONTHLY, YEARLY], trialDays: 14, taxAdded: false, verified: true, canManage: false };
const Fallback = <button type="button">Email us about Pro</button>;

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

test('the control holds no price literal, comments aside', () => {
  const code = stripComments(read('components/venue/VenueBillingControl.js'));
  expect(code).not.toMatch(/\$\s?\d/);
  expect(code).not.toMatch(/\b\d+\.\d{2}\b/);
});

test('inside the native app: no status call, only the email request', () => {
  window.Capacitor = { isNativePlatform: () => true };
  render(<VenueBillingControl fallback={Fallback} />);
  expect(getVenueBillingStatus).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Email us about Pro' })).toBeTruthy();
  expect(screen.queryByText(/Try free/)).toBeNull();
});

test('on sale and verified: yearly first, the trial said plainly, and the chosen plan is what checkout asks for', async () => {
  getVenueBillingStatus.mockResolvedValue(ON_SALE);
  startVenueCheckout.mockResolvedValue({ url: null });
  render(<VenueBillingControl fallback={Fallback} />);
  const buttons = await screen.findAllByRole('button', { name: /Try free for 14 days/ });
  expect(buttons[0].textContent).toBe('Try free for 14 days, then $990.00 a year');
  expect(buttons[1].textContent).toBe('Try free for 14 days, then $99.00 a month');
  expect(screen.getByText(/Card required\. Renews until you cancel\./)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Email us about Pro' })).toBeNull();
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(startVenueCheckout).toHaveBeenCalledWith('monthly'));
});

test('a venue that has subscribed before is offered no trial', async () => {
  getVenueBillingStatus.mockResolvedValue({ ...ON_SALE, trialDays: 0 });
  render(<VenueBillingControl fallback={Fallback} />);
  expect(await screen.findByRole('button', { name: 'Subscribe, $990.00 a year' })).toBeTruthy();
  expect(screen.queryByText(/Card required/)).toBeNull();
});

test('unverified: no buy button, the reason, and the email route', async () => {
  getVenueBillingStatus.mockResolvedValue({ ...ON_SALE, verified: false });
  render(<VenueBillingControl fallback={Fallback} />);
  expect(await screen.findByText(/once your venue is verified/)).toBeTruthy();
  expect(screen.queryByText(/Try free/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Email us about Pro' })).toBeTruthy();
});

test('not on sale, or a failed status read: the email route, unchanged', async () => {
  getVenueBillingStatus.mockResolvedValue({ checkoutAvailable: false, plans: [], verified: true, canManage: false });
  const { unmount } = render(<VenueBillingControl fallback={Fallback} />);
  expect(await screen.findByRole('button', { name: 'Email us about Pro' })).toBeTruthy();
  unmount();
  getVenueBillingStatus.mockRejectedValue(new Error('down'));
  render(<VenueBillingControl fallback={Fallback} />);
  expect(await screen.findByRole('button', { name: 'Email us about Pro' })).toBeTruthy();
});

test('a subscriber on their current plan sees Manage billing, which opens the portal', async () => {
  getVenueBillingStatus.mockResolvedValue({ ...ON_SALE, canManage: true });
  openVenuePortal.mockResolvedValue({ url: null });
  render(<VenueBillingControl current />);
  const manage = await screen.findByRole('button', { name: 'Manage billing' });
  fireEvent.click(manage);
  await waitFor(() => expect(openVenuePortal).toHaveBeenCalled());
});

test('a comped venue on its current plan is offered nothing more', async () => {
  getVenueBillingStatus.mockResolvedValue({ ...ON_SALE, canManage: false });
  const { container } = render(<VenueBillingControl current />);
  await waitFor(() => expect(getVenueBillingStatus).toHaveBeenCalled());
  expect(container.textContent).toBe('');
});

test('a venue inside its notice window sees the plans on its current card, with the date nothing is charged before', async () => {
  getVenueBillingStatus.mockResolvedValue({
    ...ON_SALE, inNoticeWindow: true, noticeUntil: '2026-10-25T15:00:00.000Z', freeUntil: '2026-10-25T15:00:00.000Z',
  });
  startVenueCheckout.mockResolvedValue({ url: null });
  render(<VenueBillingControl current />);
  const buttons = await screen.findAllByRole('button', { name: /Free until October 25, 2026/ });
  expect(buttons[0].textContent).toBe('Free until October 25, 2026, then $990.00 a year');
  expect(buttons[1].textContent).toBe('Free until October 25, 2026, then $99.00 a month');
  expect(screen.getByText(/Your venue keeps everything until October 25, 2026\./)).toBeTruthy();
  expect(screen.getByText(/nothing is charged before then/)).toBeTruthy();
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(startVenueCheckout).toHaveBeenCalledWith('yearly'));
});

test('a venue inside its window that already subscribed sees Manage billing, not the plans', async () => {
  getVenueBillingStatus.mockResolvedValue({
    ...ON_SALE, canManage: true, inNoticeWindow: true, freeUntil: '2026-10-25T15:00:00.000Z',
  });
  render(<VenueBillingControl current />);
  expect(await screen.findByRole('button', { name: 'Manage billing' })).toBeTruthy();
  expect(screen.queryByText(/Free until/)).toBeNull();
});

describe('the return from Stripe', () => {
  const fakeWindow = (search) => {
    const win = {
      location: { pathname: '/app', search, hash: '' },
      history: { replaceState: jest.fn((_s, _t, url) => { win.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; }) },
    };
    return win;
  };

  test('success is read and stripped, other params kept', () => {
    const win = fakeWindow('?venue_billing=success&session_id=cs_test_v1&x=1');
    expect(readVenueBillingReturn(win)).toEqual({ kind: 'success', sessionId: 'cs_test_v1' });
    expect(win.history.replaceState).toHaveBeenCalledWith({}, '', '/app?x=1');
  });

  test('manage and cancelled are read and stripped', () => {
    expect(readVenueBillingReturn(fakeWindow('?venue_billing=manage'))).toEqual({ kind: 'manage' });
    expect(readVenueBillingReturn(fakeWindow('?venue_billing=cancelled'))).toEqual({ kind: 'cancelled' });
  });

  test('a malformed session id is stripped and ignored', () => {
    const win = fakeWindow('?venue_billing=success&session_id=<script>');
    expect(readVenueBillingReturn(win)).toBeNull();
    expect(win.history.replaceState).toHaveBeenCalledWith({}, '', '/app');
  });

  test('the Pro return param is not this one', () => {
    const win = fakeWindow('?pro=success&session_id=cs_test_p');
    expect(readVenueBillingReturn(win)).toBeNull();
    expect(win.history.replaceState).not.toHaveBeenCalled();
  });

  test('settle: Roost on, not finished, paid but pending, and a failed confirm', async () => {
    expect(await settleVenueCheckout({ sessionId: 'cs_1', confirm: async () => ({ complete: true, tier: 'pro' }) })).toBe('roost');
    expect(await settleVenueCheckout({ sessionId: 'cs_1', confirm: async () => ({ complete: false }) })).toBe('incomplete');
    expect(await settleVenueCheckout({ sessionId: 'cs_1', confirm: async () => ({ complete: true, tier: null }) })).toBe('pending');
    expect(await settleVenueCheckout({ sessionId: 'cs_1', confirm: async () => { throw new Error('x'); } })).toBe('unknown');
  });

  test('App.js reads the return once at module scope and reloads the venue plan', () => {
    const app = read('App.js');
    expect(app).toMatch(/let VENUE_BILLING_RETURN = readVenueBillingReturn\(\);/);
    expect(app).toMatch(/VENUE_BILLING_RETURN = null;/);
    expect(app).toMatch(/settleVenueCheckout\(\{ sessionId: ret\.sessionId, confirm: confirmVenueCheckout \}\)/);
  });
});
