/**
 * The Pro sheet speaks to the limit that opened it.
 *
 * A locked forecast and Birdie's daily cap each open the sheet on their own
 * headline: what was used up, when it comes back in the reader's clock, and
 * what Pro changes. The benefit that was just hit is listed first. The yearly
 * plan's monthly figure is computed, rounded up, from the billed price. And
 * the trip to Stripe carries what opened the sheet, so the return lands on it.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';

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
import { getProStatus, startProCheckout, trackPaywallShown } from '../services/api';
// eslint-disable-next-line import/first
import { birdieBackText, forecastBackText } from '../lib/meterResets';
// eslint-disable-next-line import/first
import { perMonthLabel, storePerMonthLabel } from '../lib/proPricing';

const MONTHLY = { id: 'monthly', unitAmount: 399, currency: 'USD', interval: 'month', label: '$3.99' };
const YEARLY = { id: 'yearly', unitAmount: 2999, currency: 'USD', interval: 'year', label: '$29.99' };
const ON_SALE = { isPremium: false, checkoutAvailable: true, plans: [MONTHLY, YEARLY], trialDays: 0, taxAdded: false };

const timeOf = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

beforeEach(() => {
  getProStatus.mockResolvedValue(ON_SALE);
  startProCheckout.mockReturnValue(new Promise(() => {}));
});
afterEach(() => { jest.clearAllMocks(); });

const benefitLines = (container) => Array.from(container.querySelectorAll('[role="dialog"] svg + span')).map((s) => s.textContent);

describe('the headline follows the trigger', () => {
  test('a locked forecast: the 30 venues, when they come back, and no monthly limit with Pro', async () => {
    const { container } = render(<PaywallSheet open trigger="forecast" place="ChIJforecast1" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    expect(screen.getByRole('heading', { name: "You've checked 30 venues this month" })).toBeTruthy();
    expect(container.textContent).toContain('Crowd levels for new venues come back on ');
    expect(container.textContent).toContain('With Pro there is no monthly limit.');
    expect(benefitLines(container)).toEqual([
      'Crowd levels and forecasts for every venue',
      'A heads-up push before your spot gets packed',
      '150 Birdie messages a day, up from 10',
    ]);
  });

  test('Birdie\'s cap: today\'s 10, the reset time the server sent, and 150 a day with Pro', async () => {
    const resetsAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const { container } = render(<PaywallSheet open trigger="birdie" birdieResetsAt={resetsAt} onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    expect(screen.getByRole('heading', { name: "You've used today's 10 Birdie messages" })).toBeTruthy();
    expect(container.textContent).toContain(`They come back ${birdieBackText(resetsAt)}. Pro gives you 150 a day.`);
    expect(container.textContent).toContain(timeOf(new Date(resetsAt)));
    expect(benefitLines(container)[0]).toBe('150 Birdie messages a day, up from 10');
    expect(benefitLines(container)).toHaveLength(3);
  });

  test('from settings: the general headline and no reset line', async () => {
    const { container } = render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    expect(screen.getByRole('heading', { name: 'Get more out of every night out' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/come back/);
    expect(benefitLines(container)).toHaveLength(3);
  });

  test('no social proof, no countdown, no "Most popular"', async () => {
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    expect(container.textContent).toContain('Best value');
    expect(container.textContent).not.toMatch(/most popular|reviews?|people use|limited time|ends in|—/i);
  });
});

describe('the sheet closes on the first frame and carries its origin to Stripe', () => {
  test('Close is there before the plans load, and closes with nothing in between', async () => {
    getProStatus.mockReturnValue(new Promise(() => {}));
    const onClose = jest.fn();
    render(<PaywallSheet open trigger="forecast" onClose={onClose} />);
    act(() => { screen.getByRole('button', { name: 'Close' }).click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a forecast sends its venue, Birdie sends none, settings sends its name', async () => {
    const forecast = render(<PaywallSheet open trigger="forecast" place="ChIJforecast1" onClose={() => {}} />);
    const cta = await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    await act(async () => { cta.click(); });
    expect(startProCheckout).toHaveBeenLastCalledWith('monthly', { from: 'forecast', place: 'ChIJforecast1' });
    forecast.unmount();

    const birdie = render(<PaywallSheet open trigger="birdie" place="ChIJforecast1" onClose={() => {}} />);
    const cta2 = await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    await act(async () => { cta2.click(); });
    expect(startProCheckout).toHaveBeenLastCalledWith('monthly', { from: 'birdie', place: undefined });
    birdie.unmount();

    render(<PaywallSheet open trigger="settings" onClose={() => {}} />);
    const cta3 = await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    await act(async () => { cta3.click(); });
    expect(startProCheckout).toHaveBeenLastCalledWith('monthly', { from: 'settings', place: undefined });
  });

  test('choosing yearly changes the charge the button names', async () => {
    render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    act(() => { screen.getByRole('button', { name: /Yearly/ }).click(); });
    expect(screen.getByRole('button', { name: /Yearly/ }).getAttribute('aria-pressed')).toBe('true');
    await act(async () => { screen.getByRole('button', { name: 'Get Pro, $29.99/year' }).click(); });
    expect(startProCheckout).toHaveBeenLastCalledWith('yearly', { from: 'forecast', place: undefined });
  });

  test('paywall_shown still fires once per opening, with the trigger', async () => {
    render(<PaywallSheet open trigger="birdie" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Get Pro, $3.99/month' });
    expect(trackPaywallShown).toHaveBeenCalledTimes(1);
    expect(trackPaywallShown).toHaveBeenCalledWith('birdie');
  });
});

describe('when a free limit comes back, in the reader\'s clock', () => {
  test('Birdie: "at" today, "tomorrow at" otherwise, and the next UTC midnight with no server time', () => {
    const now = new Date(2026, 8, 24, 9, 0);
    const later = new Date(2026, 8, 24, 20, 0);
    expect(birdieBackText(later.toISOString(), now)).toBe(`at ${timeOf(later)}`);
    const nextDay = new Date(2026, 8, 25, 1, 0);
    expect(birdieBackText(nextDay.toISOString(), now)).toBe(`tomorrow at ${timeOf(nextDay)}`);
    const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    expect(birdieBackText(null, now)).toContain(timeOf(utcMidnight));
    expect(birdieBackText('not a date', now)).toBe('tomorrow');
  });

  test('crowd levels: the first of next month at UTC midnight, in local time', () => {
    const now = new Date(Date.UTC(2026, 8, 24, 15, 0));
    const at = new Date(Date.UTC(2026, 9, 1));
    expect(forecastBackText(now)).toBe(`on ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeOf(at)}`);
    // December rolls into January.
    const dec = new Date(Date.UTC(2026, 11, 31, 12, 0));
    const jan = new Date(Date.UTC(2027, 0, 1));
    expect(forecastBackText(dec)).toContain(jan.toLocaleDateString([], { month: 'short', day: 'numeric' }));
  });
});

describe('the yearly plan\'s monthly figure', () => {
  test('from the server\'s price, rounded up so it never looks cheaper than it is', () => {
    expect(perMonthLabel(YEARLY)).toBe('$2.50');
    expect(perMonthLabel({ ...YEARLY, unitAmount: 2400 })).toBe('$2.00');
    expect(perMonthLabel({ ...YEARLY, unitAmount: 2401 })).toBe('$2.01');
    expect(perMonthLabel({ ...YEARLY, currency: 'eur' })).toBe('2.50 EUR');
    expect(perMonthLabel(MONTHLY)).toBeNull();
    expect(perMonthLabel({ ...YEARLY, unitAmount: null })).toBeNull();
  });

  test('from an App Store product: RevenueCat\'s own string first, else computed', () => {
    expect(storePerMonthLabel({ pricePerMonthString: '$2.49', price: 29.99, currencyCode: 'USD' })).toBe('$2.49');
    expect(storePerMonthLabel({ price: 29.99, currencyCode: 'USD' })).toBe(
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(2.5)
    );
    expect(storePerMonthLabel({ price: 0 })).toBeNull();
    expect(storePerMonthLabel(null)).toBeNull();
  });
});
