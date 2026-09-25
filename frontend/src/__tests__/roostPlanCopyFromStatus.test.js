/**
 * THE VENUE DASHBOARD SAYS WHAT /api/venue-billing/status SAYS, ONCE ROOST IS
 * ON SALE, AND WHAT IT ALWAYS SAID UNTIL THEN.
 *
 * With venue billing on, Settings said "Billed monthly." for every paid plan
 * (Roost is sold by the year too), said there was no switch to sign up or
 * cancel with, and the plans sheet said "Plans are set up by hand right now"
 * beside live Stripe buttons, under a Pro price typed into App.js. Now:
 *
 *   - the paid line names how it is billed and not how often, because neither
 *     the profile nor the status says which plan a venue chose;
 *   - the line under Settings' buttons sends a Stripe subscriber to Manage
 *     billing, and stops saying there is nothing to sign up with once
 *     checkout is on;
 *   - the Roost card's price is Stripe's, from the status, while it is on sale;
 *   - "set up by hand" is said only while checkout is off.
 *
 * With billing off, inside the app, and until the status answers, every one of
 * those lines is today's copy. VenueDashboard.js is mounted only as a lazy
 * chunk with a hundred props from App.js, so its half is read as source, the
 * way venueOwnerFirstRun.test.js reads it; the status plumbing is rendered.
 *
 * Also here: the trip back from Roost's checkout says "Your payment went
 * through" only when Stripe called the checkout complete. A confirm that threw
 * (a 404 for a session another account started is one) used to say it too.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, act } from '@testing-library/react';

jest.mock('../services/api', () => ({
  getVenueBillingStatus: jest.fn(),
  startVenueCheckout: jest.fn(),
  openVenuePortal: jest.fn(),
}));

// eslint-disable-next-line import/first
import { getVenueBillingStatus } from '../services/api';
// eslint-disable-next-line import/first
import VenueBillingControl, { VenueBillingStatus, roostPlanPriceLabel } from '../components/venue/VenueBillingControl';
// eslint-disable-next-line import/first
import { settleVenueCheckout } from '../lib/venueBillingReturn';

const SRC = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const DASH = read('screens/VenueDashboard.js');
const APP = read('App.js');
// Comments carry the old wording on purpose; only what can render is tested.
const visible = (s) => s
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const MONTHLY = { id: 'monthly', unitAmount: 9900, currency: 'USD', interval: 'month', label: '$99.00' };
const YEARLY = { id: 'yearly', unitAmount: 99000, currency: 'USD', interval: 'year', label: '$990.00' };

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('the Roost price comes from Stripe while it is on sale', () => {
  test('the monthly price, else the yearly one, else nothing to say', () => {
    expect(roostPlanPriceLabel({ checkoutAvailable: true, plans: [YEARLY, MONTHLY] })).toBe('$99.00/mo');
    expect(roostPlanPriceLabel({ checkoutAvailable: true, plans: [YEARLY] })).toBe('$990.00/yr');
    expect(roostPlanPriceLabel({ checkoutAvailable: false, plans: [MONTHLY] })).toBeNull();
    expect(roostPlanPriceLabel({ checkoutAvailable: true, plans: [] })).toBeNull();
    expect(roostPlanPriceLabel(null)).toBeNull();
  });

  test('the Roost card prints it, and falls back to the constant in App.js', () => {
    expect(DASH).toContain("<VenueBillingStatus>{({ status }) => roostPlanPriceLabel(status) || venuePlanPriceLabel('pro')}</VenueBillingStatus>");
  });

  test('the sheet asks once for its price and its buttons together', async () => {
    getVenueBillingStatus.mockResolvedValue({ checkoutAvailable: true, plans: [MONTHLY, YEARLY], trialDays: 14, taxAdded: false, verified: true, canManage: false });
    render(
      <>
        <VenueBillingStatus>{({ status }) => <span>{roostPlanPriceLabel(status) || 'constant'}</span>}</VenueBillingStatus>
        <VenueBillingControl fallback={<button type="button">Email us about Pro</button>} />
      </>
    );
    expect(await screen.findByText('$99.00/mo')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Try free for 14 days, then $990.00 a year' })).toBeTruthy();
    expect(getVenueBillingStatus).toHaveBeenCalledTimes(1);
  });

  test('a settled answer is not reused: a later mount asks again', async () => {
    getVenueBillingStatus.mockResolvedValue({ checkoutAvailable: false, plans: [], verified: true, canManage: false });
    const first = render(<VenueBillingStatus>{({ status }) => <span>{status ? 'answered' : 'waiting'}</span>}</VenueBillingStatus>);
    await screen.findByText('answered');
    first.unmount();
    render(<VenueBillingStatus>{({ status }) => <span>{status ? 'answered' : 'waiting'}</span>}</VenueBillingStatus>);
    await screen.findByText('answered');
    expect(getVenueBillingStatus).toHaveBeenCalledTimes(2);
  });

  test('inside the app nothing is asked and every line keeps its old copy', async () => {
    window.Capacitor = { isNativePlatform: () => true };
    render(<VenueBillingStatus>{({ native, status }) => <span>{native && status === null ? 'old copy' : 'status'}</span>}</VenueBillingStatus>);
    expect(screen.getByText('old copy')).toBeTruthy();
    await act(async () => {});
    expect(getVenueBillingStatus).not.toHaveBeenCalled();
  });
});

describe('Settings says how a paid plan is billed, never a cadence nobody sent', () => {
  test('"Billed monthly." is gone from what can render', () => {
    expect(visible(DASH)).not.toContain('Billed monthly.');
  });

  test('a Stripe plan names Stripe, or its free trial; a plan sold by hand says so', () => {
    expect(DASH).toContain("status?.status === 'trialing' ? 'On the free trial. Nothing is charged until it ends.' : 'Billed through Stripe.'");
    expect(DASH).toContain(": 'Billed as agreed with us.')");
  });
});

describe('the line under Settings\' plan buttons', () => {
  const block = DASH.slice(DASH.indexOf("{venueTierSource === 'stripe' && status?.canManage"), DASH.indexOf('</VenueBillingStatus>', DASH.indexOf("{venueTierSource === 'stripe' && status?.canManage")));

  test('a Stripe subscriber is sent to Manage billing, the Terms 9.6 path', () => {
    expect(block).toMatch(/Cancel it from See plans and pricing, then Manage billing\. It takes a few clicks and needs no email\./);
  });

  test('with checkout on, a plan we set up still changes by email, and signing up is not denied', () => {
    expect(block).toMatch(/venueTierSource !== 'stripe' && status\?\.checkoutAvailable\s*\?\s*<>We set this plan up for you, so it changes by email\./);
  });

  test('otherwise, and inside the app, it is the sentence it always was', () => {
    expect(block).toMatch(/: <>There is no switch for this in the app yet, and there is no switch to sign up with either\./);
    // The mailto that sentence refers to is still there.
    expect(DASH).toContain('Change or cancel this plan');
  });
});

describe('"Plans are set up by hand" is said only while checkout is off', () => {
  test('checkout on replaces it with the address alone', () => {
    const at = DASH.indexOf('{status?.checkoutAvailable\n');
    expect(at).toBeGreaterThan(-1);
    const branch = DASH.slice(at, DASH.indexOf('</p>', at));
    expect(branch).toMatch(/\? <>Questions about a plan\? Write to \{VENUE_SALES_EMAIL\}\.<\/>/);
    expect(branch).toMatch(/: <>Plans are set up by hand right now\. Write to \{VENUE_SALES_EMAIL\} and we will get you moved over\.<\/>/);
  });

  test('billing off keeps its one sentence in Settings, untouched', () => {
    expect(DASH).toMatch(/Every feature is on while venue plans are being set up\. Nothing is charged, and we will email you before anything is\./);
  });
});

describe('the trip back from Roost\'s checkout', () => {
  test('a confirm that throws, a 404 for another account\'s session among them, is not a payment', async () => {
    const notYours = Object.assign(new Error('That checkout does not belong to this account.'), { status: 404 });
    expect(await settleVenueCheckout({ sessionId: 'cs_1', confirm: async () => { throw notYours; } })).toBe('unknown');
    expect(await settleVenueCheckout({ sessionId: 'cs_1', confirm: async () => ({ complete: true, tier: null }) })).toBe('pending');
  });

  test('App.js says the payment went through for a completed checkout only', () => {
    const effect = APP.slice(APP.indexOf('const ret = VENUE_BILLING_RETURN;'), APP.indexOf('}, [showToast]);', APP.indexOf('const ret = VENUE_BILLING_RETURN;')));
    expect(effect).toMatch(/else if \(outcome === 'pending'\) showToast\('Your payment went through\. Roost can take a minute to switch on\.', 'info'\);/);
    expect(effect.match(/Your payment went through/g)).toHaveLength(1);
    expect(effect).toMatch(/else showToast\('We could not confirm your purchase yet\. If you paid, Roost will switch on shortly\.', 'info'\);/);
  });
});
