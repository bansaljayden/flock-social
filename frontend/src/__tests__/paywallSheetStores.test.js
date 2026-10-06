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
  getEntitlements: jest.fn(),
  getProStatus: jest.fn(),
  startProCheckout: jest.fn(),
  trackPaywallShown: jest.fn(),
  trackPurchaseCompleted: jest.fn(),
}));
jest.mock('../services/purchases', () => ({
  isPurchasesAvailable: jest.fn(),
  getProOffering: jest.fn(),
  introEligibleProducts: jest.fn(),
  purchase: jest.fn(),
  restore: jest.fn(),
}));

// eslint-disable-next-line import/first
import PaywallSheet from '../components/PaywallSheet';
// eslint-disable-next-line import/first
import { getEntitlements, getProStatus, startProCheckout } from '../services/api';
// eslint-disable-next-line import/first
import { isPurchasesAvailable, getProOffering, introEligibleProducts, restore } from '../services/purchases';

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
    introEligibleProducts.mockResolvedValue(new Set(['pro_annual', 'pro_monthly']));
    const pkg = (type, priceString, price, introPrice) => ({ packageType: type, product: { identifier: type === 'ANNUAL' ? 'pro_annual' : 'pro_monthly', priceString, price, introPrice } });
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

  test('an Apple ID that has used its trial is shown the plain price, not the trial', async () => {
    isPurchasesAvailable.mockReturnValue(true);
    introEligibleProducts.mockResolvedValue(new Set());
    getProOffering.mockResolvedValue([
      { packageType: 'MONTHLY', product: { identifier: 'pro_monthly', priceString: '$3.99', price: 3.99, introPrice: null } },
      { packageType: 'ANNUAL', product: { identifier: 'pro_annual', priceString: '$29.99', price: 29.99, introPrice: { price: 0, periodNumberOfUnits: 1, periodUnit: 'WEEK' } } },
    ]);
    const { container } = render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    await screen.findByRole('button', { name: MONTHLY_CTA });
    expect(introEligibleProducts).toHaveBeenCalledWith(['pro_annual']);
    await act(async () => { screen.getByRole('button', { name: /Yearly/ }).click(); });
    expect(screen.getByRole('button', { name: 'Get Pro, $29.99/year' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/free trial/i);
    expect(container.textContent).toContain('Renews at $29.99 every year until you cancel in your App Store settings.');
  });

  test('plans that fail to load still leave Restore, so a paid customer can get Pro back', async () => {
    isPurchasesAvailable.mockReturnValue(true);
    getProOffering.mockResolvedValue(null);
    restore.mockResolvedValue({ success: true, isPro: true });
    const onUpgraded = jest.fn();
    render(<PaywallSheet open trigger="settings" onClose={() => {}} onUpgraded={onUpgraded} showToast={() => {}} />);
    await screen.findByText("Flock Pro can't be bought in the app yet.");
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull();
    await act(async () => { screen.getByRole('button', { name: 'Restore purchases' }).click(); });
    expect(restore).toHaveBeenCalled();
    // A restore, which App.js polls for without the paid-but-not-on line.
    expect(onUpgraded).toHaveBeenCalledWith('restore');
  });

  // Monthly is the plan the sheet opens on. When the store loads the yearly
  // product alone, that left a selection with no product behind it: the button
  // read "Get Pro, /month" and was disabled. The web half already picked a plan
  // that loaded; the App Store half does the same now.
  test('with only the yearly product loaded, yearly is selected and the button charges it', async () => {
    isPurchasesAvailable.mockReturnValue(true);
    getProOffering.mockResolvedValue([
      { packageType: 'ANNUAL', product: { identifier: 'pro_annual', priceString: '$29.99', price: 29.99, introPrice: null } },
    ]);
    const { container } = render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    const cta = await screen.findByRole('button', { name: 'Get Pro, $29.99/year' });
    expect(cta.disabled).toBe(false);
    expect(screen.getByRole('button', { name: /Yearly/ }).getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Renews at $29.99 every year until you cancel in your App Store settings.');
    expect(container.textContent).not.toMatch(/\/month|Monthly/);
  });

  test('with only the monthly product loaded, monthly stays selected', async () => {
    isPurchasesAvailable.mockReturnValue(true);
    getProOffering.mockResolvedValue([
      { packageType: 'MONTHLY', product: { identifier: 'pro_monthly', priceString: '$3.99', price: 3.99, introPrice: null } },
    ]);
    render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    const cta = await screen.findByRole('button', { name: MONTHLY_CTA });
    expect(cta.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Yearly/ })).toBeNull();
  });

  // The app's own copy of Pro can be half a minute behind, so somebody who
  // had just subscribed on the web and switched back was shown the App Store
  // plans and could pay twice. The sheet asks the server as it opens.
  describe('an account the server already counts as Pro', () => {
    const bothPlans = () => [
      { packageType: 'MONTHLY', product: { identifier: 'pro_monthly', priceString: '$3.99', price: 3.99, introPrice: null } },
      { packageType: 'ANNUAL', product: { identifier: 'pro_annual', priceString: '$29.99', price: 29.99, introPrice: null } },
    ];

    test('is told it has Pro, offered nothing to buy, and the app re-reads its copy', async () => {
      isPurchasesAvailable.mockReturnValue(true);
      getProOffering.mockResolvedValue(bothPlans());
      getEntitlements.mockResolvedValue({ isPremium: true, paywallEnabled: true });
      const onUpgraded = jest.fn();
      const onAlreadyPro = jest.fn();
      const { container } = render(<PaywallSheet open trigger="birdie" onClose={() => {}} onUpgraded={onUpgraded} onAlreadyPro={onAlreadyPro} />);
      await screen.findByText('You already have Flock Pro on this account.');
      expect(screen.queryByRole('button', { name: /Get Pro|Yearly|Monthly|Restore/ })).toBeNull();
      expect(container.textContent).not.toMatch(/\$\s?\d/);
      expect(onAlreadyPro).toHaveBeenCalledTimes(1);
      // Not the purchase poll: nothing was bought, so nothing may later say a
      // payment has not switched Pro on (paywallPaidNotOn.test.js runs it).
      expect(onUpgraded).not.toHaveBeenCalled();
      // Asked of our server, not of the web's prices.
      expect(getProStatus).not.toHaveBeenCalled();
    });

    test('an account that is not Pro gets the plans as before', async () => {
      isPurchasesAvailable.mockReturnValue(true);
      getProOffering.mockResolvedValue(bothPlans());
      getEntitlements.mockResolvedValue({ isPremium: false, paywallEnabled: true });
      const onUpgraded = jest.fn();
      const onAlreadyPro = jest.fn();
      render(<PaywallSheet open trigger="birdie" onClose={() => {}} onUpgraded={onUpgraded} onAlreadyPro={onAlreadyPro} />);
      await screen.findByRole('button', { name: MONTHLY_CTA });
      expect(screen.queryByText('You already have Flock Pro on this account.')).toBeNull();
      expect(onUpgraded).not.toHaveBeenCalled();
      expect(onAlreadyPro).not.toHaveBeenCalled();
    });

    test('a read that fails shows the plans: it says nothing about Pro', async () => {
      isPurchasesAvailable.mockReturnValue(true);
      getProOffering.mockResolvedValue(bothPlans());
      getEntitlements.mockRejectedValue(Object.assign(new Error('Could not check your plan just now. Try again.'), { status: 503 }));
      render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
      await screen.findByRole('button', { name: MONTHLY_CTA });
      expect(screen.queryByText('You already have Flock Pro on this account.')).toBeNull();
    });

    test('with no App Store to buy from, nothing is asked at all', async () => {
      isPurchasesAvailable.mockReturnValue(false);
      render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
      await screen.findByText("Flock Pro can't be bought in the app yet.");
      expect(getEntitlements).not.toHaveBeenCalled();
    });
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
