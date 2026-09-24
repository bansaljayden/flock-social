/**
 * The Pro sheet sells in whichever store the reader is in, or says plainly
 * that it cannot.
 *
 * Found by a screenshot pass with the paywall switched on (2026-09-24): on the
 * web the sheet said "Flock Pro is available in the iOS app" under App Store
 * fine print and a 7-day trial promise, so both web limits (a locked forecast
 * and Birdie's daily cap) ended at a sheet with nothing to buy. Inside the app
 * with no App Store product it said the same thing, in the iOS app.
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/api', () => ({
  getProStatus: jest.fn(),
  startProCheckout: jest.fn(),
  trackPaywallShown: jest.fn(),
  trackPurchaseCompleted: jest.fn(),
}));
jest.mock('../services/purchases', () => ({
  isPurchasesAvailable: jest.fn(),
  getProOffering: jest.fn(),
  purchase: jest.fn(),
  restore: jest.fn(),
}));

// eslint-disable-next-line import/first
import PaywallSheet from '../components/PaywallSheet';
// eslint-disable-next-line import/first
import { getProStatus, startProCheckout } from '../services/api';
// eslint-disable-next-line import/first
import { isPurchasesAvailable, getProOffering } from '../services/purchases';

const MONTHLY = { id: 'monthly', unitAmount: 399, currency: 'USD', interval: 'month', label: '$3.99' };
const YEARLY = { id: 'yearly', unitAmount: 2999, currency: 'USD', interval: 'year', label: '$29.99' };

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

// The CTA names the charge, so its accessible name is the price.
const MONTHLY_CTA = 'Get Pro, $3.99/month';

describe('on the web, the sheet sells through Stripe', () => {
  test('the server\'s plans, the computed saving, and a CTA that states the charge on monthly', async () => {
    getProStatus.mockResolvedValue({ isPremium: false, checkoutAvailable: true, plans: [MONTHLY, YEARLY], trialDays: 0, taxAdded: false });
    startProCheckout.mockReturnValue(new Promise(() => {}));
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    const cta = await screen.findByRole('button', { name: MONTHLY_CTA });
    expect(container.textContent).toContain('$3.99/month');
    expect(container.textContent).toContain('$29.99/year');
    // 29.99 / 12 = 2.4992, rounded up to the cent.
    expect(container.textContent).toContain('$2.50/mo');
    // 29.99 against 12 x 3.99 = 47.88 is 37.4%, floored.
    expect(container.textContent).toContain('Save 37%');
    await act(async () => { cta.click(); });
    expect(startProCheckout).toHaveBeenCalledWith('monthly', { from: 'forecast', place: undefined });
  });

  test('the fine print is the web\'s, never the App Store\'s', async () => {
    getProStatus.mockResolvedValue({ isPremium: false, checkoutAvailable: true, plans: [MONTHLY, YEARLY], trialDays: 0, taxAdded: false });
    const { container } = render(<PaywallSheet open trigger="birdie" onClose={() => {}} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    const text = container.textContent;
    expect(text).toContain('It renews at $3.99 every month until you cancel. Cancel any time in You, Flock Pro.');
    expect(text).toContain('Full refund within 14 days of your first payment');
    expect(text).toContain('Under 18? A parent or guardian needs to buy it.');
    expect(text).not.toMatch(/App Store/);
    expect(text).not.toMatch(/iOS app/);
    expect(text).not.toMatch(/free trial/i);
  });

  test('checkout switched off: no price, no button, one plain sentence', async () => {
    getProStatus.mockResolvedValue({ isPremium: false, checkoutAvailable: false, plans: [], trialDays: 0, taxAdded: false });
    const { container } = render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    await screen.findByText('Flock Pro is not on sale on the web yet.');
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });

  test('a failed read offers to ask again instead of a price', async () => {
    getProStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ isPremium: false, checkoutAvailable: true, plans: [MONTHLY], trialDays: 0, taxAdded: false });
    render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await act(async () => { retry.click(); });
    await screen.findByRole('button', { name: MONTHLY_CTA });
  });
});

describe('inside the app', () => {
  beforeEach(() => { window.Capacitor = { isNativePlatform: () => true }; });

  test('with no App Store product, one plain sentence and nowhere else to go', async () => {
    isPurchasesAvailable.mockReturnValue(false);
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    await screen.findByText("Flock Pro can't be bought in the app yet.");
    expect(getProStatus).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/iOS app|website|flockcorp/i);
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull();
  });

  test('a trial is only promised when the store product carries one', async () => {
    isPurchasesAvailable.mockReturnValue(true);
    const pkg = (type, priceString, price, introPrice) => ({ packageType: type, product: { priceString, price, introPrice } });
    getProOffering.mockResolvedValue([pkg('MONTHLY', '$3.99', 3.99, null), pkg('ANNUAL', '$29.99', 29.99, null)]);
    const { container, unmount } = render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    expect(container.textContent).not.toMatch(/free trial/i);
    expect(container.textContent).toContain('$29.99/year');
    expect(container.textContent).toContain('$2.50/mo');
    expect(container.textContent).toContain('Save 37%');
    unmount();

    getProOffering.mockResolvedValue([
      pkg('MONTHLY', '$3.99', 3.99, null),
      pkg('ANNUAL', '$29.99', 29.99, { price: 0, periodNumberOfUnits: 1, periodUnit: 'WEEK' }),
    ]);
    render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('1-week free trial').length).toBeGreaterThan(0));
    // Monthly is still the plan selected, so the CTA still charges monthly.
    expect(screen.getByRole('button', { name: MONTHLY_CTA })).toBeTruthy();
    await act(async () => { screen.getByRole('button', { name: /Yearly/ }).click(); });
    expect(screen.getByRole('button', { name: 'Start 1-week free trial' })).toBeTruthy();
  });

  test('App Store fine print, Restore, and nothing that names the website', async () => {
    isPurchasesAvailable.mockReturnValue(true);
    const pkg = (type, priceString, price) => ({ packageType: type, product: { priceString, price, introPrice: null } });
    getProOffering.mockResolvedValue([pkg('MONTHLY', '$3.99', 3.99), pkg('ANNUAL', '$29.99', 29.99)]);
    const { container } = render(<PaywallSheet open trigger="birdie" onClose={() => {}} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    expect(container.textContent).toContain('Renews at $3.99 every month until you cancel in your App Store settings.');
    expect(screen.getByRole('button', { name: 'Restore purchases' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Under 18|flockcorp|website/i);
    await act(async () => { screen.getByRole('button', { name: /Yearly/ }).click(); });
    expect(screen.getByRole('button', { name: 'Get Pro, $29.99/year' })).toBeTruthy();
    expect(container.textContent).toContain('Renews at $29.99 every year until you cancel in your App Store settings.');
  });
});
