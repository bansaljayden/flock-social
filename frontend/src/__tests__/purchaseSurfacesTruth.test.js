/**
 * Five small ways a purchase surface said or did something untrue.
 *
 *   - The Pro sheet's backdrop closed it while web checkout was starting, and
 *     the redirect to Stripe still happened from a sheet that was gone. Escape
 *     and the close button already refused; now the backdrop does too.
 *   - Terms, Privacy and Restore purchases were 11 and 13px text buttons with
 *     no 44px target. They carry hit44 now, which adds the target and moves no
 *     pixel of the fine print.
 *   - The You tab's Flock Pro row swallowed a failed /api/pro/status read, so a
 *     web subscriber saw "Active" with no Cancel and nothing to say why.
 *   - Roost's buy control rendered nothing while its status loaded, which took
 *     the email request off the sheet for as long as the read took.
 *   - /pro said a code from a shared link was already in the checkout price,
 *     when the server applies it only if Stripe still calls it active.
 */
import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/api', () => ({
  cancelProSubscription: jest.fn(),
  getProStatus: jest.fn(),
  getToken: jest.fn(),
  getVenueBillingStatus: jest.fn(),
  openProPortal: jest.fn(),
  openVenuePortal: jest.fn(),
  resumeProSubscription: jest.fn(),
  startProCheckout: jest.fn(),
  startVenueCheckout: jest.fn(),
  trackPaywallShown: jest.fn(),
  trackPurchaseCompleted: jest.fn(),
}));
jest.mock('../services/purchases', () => ({
  isPurchasesAvailable: jest.fn(),
  getProOffering: jest.fn(),
  purchase: jest.fn(),
  restore: jest.fn(),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));

// eslint-disable-next-line import/first
import { getProStatus, getToken, getVenueBillingStatus, startProCheckout } from '../services/api';
// eslint-disable-next-line import/first
import { isPurchasesAvailable, getProOffering, restore } from '../services/purchases';
// eslint-disable-next-line import/first
import PaywallSheet from '../components/PaywallSheet';
// eslint-disable-next-line import/first
import ProPage from '../website/ProPage';
// eslint-disable-next-line import/first
import VenueBillingControl from '../components/venue/VenueBillingControl';
// eslint-disable-next-line import/first
import { ProRow } from '../screens/ProfileSettings';

const MONTHLY = { id: 'monthly', unitAmount: 399, currency: 'USD', interval: 'month', label: '$3.99' };
const YEARLY = { id: 'yearly', unitAmount: 2999, currency: 'USD', interval: 'year', label: '$29.99' };
const ON_SALE = { isPremium: false, checkoutAvailable: true, plans: [MONTHLY, YEARLY], trialDays: 0, taxAdded: false, canManageWeb: false };
const MONTHLY_CTA = 'Get Pro, $3.99/month';
const nativeBridge = () => { window.Capacitor = { isNativePlatform: () => true }; };
const storePackages = () => [
  { packageType: 'MONTHLY', product: { priceString: '$3.99', price: 3.99, introPrice: null } },
  { packageType: 'ANNUAL', product: { priceString: '$29.99', price: 29.99, introPrice: null } },
];

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('the Pro sheet backdrop', () => {
  test('cannot close the sheet while web checkout is starting', async () => {
    getProStatus.mockResolvedValue(ON_SALE);
    startProCheckout.mockReturnValue(new Promise(() => {}));
    const onClose = jest.fn();
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={onClose} />);
    const cta = await screen.findByRole('button', { name: MONTHLY_CTA });
    await act(async () => { cta.click(); });
    expect(screen.getByRole('button', { name: 'Opening checkout…' })).toBeTruthy();
    fireEvent.click(container.firstChild);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('cannot close it while a restore is running in the app', async () => {
    nativeBridge();
    isPurchasesAvailable.mockReturnValue(true);
    getProOffering.mockResolvedValue(storePackages());
    restore.mockReturnValue(new Promise(() => {}));
    const onClose = jest.fn();
    const { container } = render(<PaywallSheet open trigger="settings" onClose={onClose} />);
    const button = await screen.findByRole('button', { name: 'Restore purchases' });
    await act(async () => { button.click(); });
    expect(screen.getByRole('button', { name: 'Restoring…' })).toBeTruthy();
    fireEvent.click(container.firstChild);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('with nothing in flight it still closes the sheet, and a tap inside does not', async () => {
    getProStatus.mockResolvedValue(ON_SALE);
    const onClose = jest.fn();
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={onClose} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.firstChild);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the fine print is reachable with a finger', () => {
  test('Terms and Privacy carry a 44px target on the web sheet', async () => {
    getProStatus.mockResolvedValue(ON_SALE);
    render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    expect(screen.getByRole('button', { name: 'Terms' }).classList.contains('hit44')).toBe(true);
    expect(screen.getByRole('button', { name: 'Privacy' }).classList.contains('hit44')).toBe(true);
  });

  test('Terms, Privacy and Restore purchases carry it in the app', async () => {
    nativeBridge();
    isPurchasesAvailable.mockReturnValue(true);
    getProOffering.mockResolvedValue(storePackages());
    render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    for (const name of ['Terms', 'Privacy', 'Restore purchases']) {
      expect(screen.getByRole('button', { name }).classList.contains('hit44')).toBe(true);
    }
  });

  test('and keep the look they had: no padding or size added to the 11px links', async () => {
    getProStatus.mockResolvedValue(ON_SALE);
    render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    const terms = screen.getByRole('button', { name: 'Terms' });
    expect(terms.style.fontSize).toBe('11px');
    expect(terms.style.padding).toBe('0px');
  });
});

describe('the You tab Flock Pro row after a failed status read', () => {
  const PERIOD_END = '2026-10-24T12:00:00.000Z';
  const WEB_SUBSCRIBER = {
    isPremium: true, checkoutAvailable: true, plans: [MONTHLY, YEARLY], trialDays: 0, taxAdded: false,
    canManageWeb: true, hasWebSubscription: true, cancelAtPeriodEnd: false, periodEnd: PERIOD_END,
  };
  const row = (props) => (
    <ProRow isPro entitlements={{ paywallEnabled: true }} colors={{ navy: '#0d2847' }} setPaywallTrigger={() => {}} showToast={() => {}} {...props} />
  );

  test('a Pro account is told the read failed and gets a retry that brings Cancel back', async () => {
    getProStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(WEB_SUBSCRIBER);
    render(row());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load your subscription just now.');
    expect(screen.getByText('Active')).toBeTruthy();
    await act(async () => { screen.getByRole('button', { name: 'Try again' }).click(); });
    expect(await screen.findByRole('button', { name: 'Cancel subscription' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Payment method and invoices' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getProStatus).toHaveBeenCalledTimes(2);
  });

  test('a later read that fails keeps the Cancel and the billing button the row already had', async () => {
    getProStatus.mockResolvedValueOnce({ ...WEB_SUBSCRIBER, isPremium: false }).mockRejectedValueOnce(new Error('offline'));
    const { rerender } = render(row({ isPro: false }));
    await screen.findByRole('button', { name: 'Cancel subscription' });
    // Pro changes (entitlements re-read after a purchase), so the row asks again.
    rerender(row({ isPro: true }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load your subscription just now.');
    expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Payment method and invoices' })).toBeTruthy();
  });

  test('an account that is not Pro and has no answer yet gets no row, as before', async () => {
    getProStatus.mockRejectedValueOnce(new Error('offline'));
    const { container } = render(row({ isPro: false }));
    await act(async () => {});
    expect(container.textContent).toBe('');
  });
});

describe('Roost while its status is loading', () => {
  const Fallback = <button type="button">Email us about Pro</button>;

  test('the email request stays, under a line saying the plans are being checked', async () => {
    let answer;
    getVenueBillingStatus.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(<VenueBillingControl fallback={Fallback} />);
    expect(screen.getByRole('status').textContent).toBe('Checking Roost plans…');
    expect(screen.getByRole('button', { name: 'Email us about Pro' })).toBeTruthy();
    await act(async () => {
      answer({ checkoutAvailable: true, plans: [{ id: 'monthly', interval: 'month', label: '$99.00' }], trialDays: 0, taxAdded: false, verified: true, canManage: false });
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Subscribe, $99.00 a month' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Email us about Pro' })).toBeNull();
  });

  test('the current plan\'s card has no request to keep, so it waits quietly', async () => {
    let answer;
    getVenueBillingStatus.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { container } = render(<VenueBillingControl current />);
    expect(container.textContent).toBe('');
    await act(async () => { answer({ checkoutAvailable: false, plans: [], verified: true, canManage: true }); });
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeTruthy();
  });
});

describe('/pro and a code from a shared link', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
    window.sessionStorage.clear();
  });

  test('says the code applies at checkout if it is still active, never that the price already has it', async () => {
    window.history.replaceState({}, '', '/pro?code=flockfriends');
    getToken.mockReturnValue('t');
    getProStatus.mockResolvedValue(ON_SALE);
    const { container } = render(<ProPage />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    expect(container.textContent).toContain('Code FLOCKFRIENDS is applied at checkout if it is still active. When it applies, the checkout page shows the lower price.');
    expect(container.textContent).not.toMatch(/already includes/);
  });
});
