/**
 * Flock Pro on the web: the /pro page, the trip back from Stripe, and the
 * price arithmetic the native sheet shares with it.
 *
 * The rules pinned here are the ones a buyer is owed before paying:
 *   - no price the server did not send. ProPage.js holds no price literal, and
 *     a signed-out visitor sees no price at all;
 *   - no buy button while checkout is off, and one plain sentence saying so;
 *   - a savings figure is computed from the prices on screen, never typed;
 *   - the Stripe return (?pro=success&session_id=...) is taken off the address
 *     bar as it is read, so a refresh cannot replay it.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';

jest.mock('../services/api', () => ({
  getProStatus: jest.fn(),
  getToken: jest.fn(),
  openProPortal: jest.fn(),
  startProCheckout: jest.fn(),
  trackPaywallShown: jest.fn(),
}));

// eslint-disable-next-line import/first
import { getProStatus, getToken, startProCheckout } from '../services/api';
// eslint-disable-next-line import/first
import ProPage from '../website/ProPage';
// eslint-disable-next-line import/first
import { readProReturn, settleProCheckout } from '../lib/proReturn';
// eslint-disable-next-line import/first
import { yearlySavingsPercent, planSavingsPercent } from '../lib/proPricing';

const SRC = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const MONTHLY = { id: 'monthly', unitAmount: 399, currency: 'USD', interval: 'month', label: '$3.99' };
const YEARLY = { id: 'yearly', unitAmount: 2999, currency: 'USD', interval: 'year', label: '$29.99' };

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('ProPage never hardcodes a price', () => {
  test('no dollar amount or decimal price in the source, comments aside', () => {
    const code = stripComments(read('website/ProPage.js'));
    expect(code).not.toMatch(/\$\s?\d/);
    expect(code).not.toMatch(/\b\d+\.\d{2}\b/);
  });

  // Signed out, the page asks the PUBLIC offer route (the homepage card's),
  // so fetch is faked here: nothing in this suite may reach the network.
  const offerFetch = (body) => jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) }));
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('signed out with Pro not on sale: no price anywhere, no status call, and the button is a login link', async () => {
    global.fetch = offerFetch({ available: false, plans: [] });
    getToken.mockReturnValue(null);
    const { container } = render(<ProPage />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(getProStatus).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
    const link = screen.getByRole('link', { name: 'Log in to continue' });
    expect(link.getAttribute('href')).toBe('/app');
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).toBeNull();
  });

  test('signed out with Pro on sale: the public prices, and signing in comes back here', async () => {
    global.fetch = offerFetch({ available: true, plans: [MONTHLY, YEARLY], trialDays: 0, taxAdded: false });
    getToken.mockReturnValue(null);
    window.sessionStorage.clear();
    const { container } = render(<ProPage />);
    await waitFor(() => expect(container.textContent).toContain('$3.99 USD a month'));
    expect(container.textContent).toContain('$29.99 USD a year. 37% less than 12 months of monthly.');
    expect(getProStatus).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: 'Log in to continue' });
    link.addEventListener('click', (e) => e.preventDefault());
    act(() => { link.click(); });
    expect(JSON.parse(window.sessionStorage.getItem('flock_return_after_sign_in')).path).toBe('/pro');
  });

  test('the prices shown are the ones /api/pro/status sent', async () => {
    getToken.mockReturnValue('t');
    getProStatus.mockResolvedValue({
      isPremium: false, checkoutAvailable: true, plans: [MONTHLY, { ...YEARLY, label: '$31.50', unitAmount: 3150 }],
      trialDays: 0, taxAdded: true, canManageWeb: false,
    });
    const { container } = render(<ProPage />);
    await screen.findByRole('button', { name: 'Continue to payment' });
    expect(container.textContent).toContain('$3.99 USD plus tax today, then every month on this date until you cancel.');
    expect(container.textContent).toContain('$31.50 USD a year');
    // 31.50 against 12 x 3.99 = 47.88 is 34.2%, floored.
    expect(container.textContent).toContain('34% less than 12 months of monthly');
  });
});

describe('checkout switched off', () => {
  test('no buy button, no price, one plain sentence', async () => {
    getToken.mockReturnValue('t');
    getProStatus.mockResolvedValue({
      isPremium: false, checkoutAvailable: false, plans: [], trialDays: 0, taxAdded: false, canManageWeb: false,
    });
    const { container } = render(<ProPage />);
    await screen.findByText('Flock Pro is not on sale on the web yet.');
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });
});

describe('plan choice', () => {
  test('monthly is selected by default and the checkout asks for it', async () => {
    getToken.mockReturnValue('t');
    getProStatus.mockResolvedValue({
      isPremium: false, checkoutAvailable: true, plans: [YEARLY, MONTHLY], trialDays: 0, taxAdded: false, canManageWeb: false,
    });
    startProCheckout.mockReturnValue(new Promise(() => {}));
    render(<ProPage />);
    const monthly = await screen.findByRole('radio', { name: /Monthly/ });
    expect(monthly.checked).toBe(true);
    await act(async () => { screen.getByRole('button', { name: 'Continue to payment' }).click(); });
    expect(startProCheckout).toHaveBeenCalledWith('monthly');
  });

  test('a single plan gets no selector at all', async () => {
    getToken.mockReturnValue('t');
    getProStatus.mockResolvedValue({
      isPremium: false, checkoutAvailable: true, plans: [MONTHLY], trialDays: 0, taxAdded: false, canManageWeb: false,
    });
    render(<ProPage />);
    await screen.findByRole('button', { name: 'Continue to payment' });
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

test('inside the native app the page renders nothing', () => {
  window.Capacitor = { isNativePlatform: () => true };
  getToken.mockReturnValue('t');
  const { container } = render(<ProPage />);
  expect(container.innerHTML).toBe('');
  expect(getProStatus).not.toHaveBeenCalled();
});

describe('the return from Stripe', () => {
  const fakeWindow = (search) => {
    const win = {
      location: { pathname: '/app', search, hash: '' },
      history: { replaceState: jest.fn((_s, _t, url) => { win.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; }) },
    };
    return win;
  };

  test('success is read and the query is stripped, other params kept', () => {
    const win = fakeWindow('?pro=success&session_id=cs_test_abc123&x=1');
    expect(readProReturn(win)).toEqual({ kind: 'success', sessionId: 'cs_test_abc123' });
    expect(win.history.replaceState).toHaveBeenCalledWith({}, '', '/app?x=1');
  });

  test('manage is read and stripped', () => {
    const win = fakeWindow('?pro=manage');
    expect(readProReturn(win)).toEqual({ kind: 'manage' });
    expect(win.history.replaceState).toHaveBeenCalledWith({}, '', '/app');
  });

  test('a malformed session id is stripped and ignored', () => {
    const win = fakeWindow('?pro=success&session_id=<script>');
    expect(readProReturn(win)).toBeNull();
    expect(win.history.replaceState).toHaveBeenCalledWith({}, '', '/app');
  });

  test('no pro param leaves the address bar alone', () => {
    const win = fakeWindow('?x=1');
    expect(readProReturn(win)).toBeNull();
    expect(win.history.replaceState).not.toHaveBeenCalled();
  });

  test('confirm, then poll status until Pro shows', async () => {
    const confirm = jest.fn().mockResolvedValue({ complete: true, isPremium: false });
    const getStatus = jest.fn()
      .mockResolvedValueOnce({ isPremium: false })
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ isPremium: true });
    const wait = jest.fn().mockResolvedValue();
    await expect(settleProCheckout({ sessionId: 'cs_1', confirm, getStatus, wait })).resolves.toBe('pro');
    expect(confirm).toHaveBeenCalledWith('cs_1');
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledWith(2000);
  });

  test('gives up after about 30 seconds and says paid but pending', async () => {
    const confirm = jest.fn().mockResolvedValue({ complete: true, isPremium: false });
    const getStatus = jest.fn().mockResolvedValue({ isPremium: false });
    const wait = jest.fn().mockResolvedValue();
    await expect(settleProCheckout({ sessionId: 'cs_1', confirm, getStatus, wait })).resolves.toBe('pending');
    expect(getStatus).toHaveBeenCalledTimes(15);
  });

  test('an unfinished checkout does not poll', async () => {
    const getStatus = jest.fn();
    const out = await settleProCheckout({
      sessionId: 'cs_1', confirm: jest.fn().mockResolvedValue({ complete: false, isPremium: false }), getStatus, wait: jest.fn(),
    });
    expect(out).toBe('incomplete');
    expect(getStatus).not.toHaveBeenCalled();
  });

  test('App.js reads the return once at module scope and re-reads entitlements', () => {
    const app = read('App.js');
    expect(app).toMatch(/let PRO_RETURN = readProReturn\(\);/);
    expect(app).toMatch(/settleProCheckout\(\{/);
    expect(app).toMatch(/showToast\("You're Pro\."\)/);
    const effect = app.slice(app.indexOf('const ret = PRO_RETURN;'), app.indexOf('}, [refreshEntitlements, showToast]);'));
    expect(effect).toMatch(/refreshEntitlements\(\)/);
  });
});

describe('savings are computed, never typed', () => {
  test('arithmetic, floored so it never overstates', () => {
    expect(yearlySavingsPercent(3.99, 29.99)).toBe(37);
    expect(yearlySavingsPercent(399, 2999)).toBe(37);
    expect(yearlySavingsPercent(3.99, 47.88)).toBeNull();
    expect(yearlySavingsPercent(null, 29.99)).toBeNull();
    expect(planSavingsPercent(MONTHLY, { ...YEARLY, currency: 'EUR' })).toBeNull();
  });

  test('PaywallSheet carries no literal saving and opens on monthly', () => {
    const sheet = read('components/PaywallSheet.js');
    expect(sheet).not.toMatch(/Save \d+%/);
    expect(sheet).toMatch(/Save \{savePct\}%/);
    expect(sheet).toMatch(/useState\('monthly'\)/);
    expect(sheet).not.toMatch(/setSelected\('yearly'\);\s*\r?\n\s*setBusy/);
    expect(sheet).toMatch(/Restore purchases/);
  });
});

/* THE TWO DOORS THE SECURITY REVIEW FOUND SHUT OR TOO WIDE (2026-09-24).
   Read from source because ProRow is not exported and both rules are about
   which branch exists, not how it renders. */
describe('the You tab Flock Pro row', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8'
  ).replace(/\r\n/g, '\n');
  const row = src.slice(src.indexOf('function ProRow('), src.indexOf('\n}\n', src.indexOf('function ProRow(')));

  test('Manage shows for any web subscription, not only a paid-up one', () => {
    // A failed renewal is still billing, and the Terms send that person here.
    expect(row).toMatch(/if \(status\?\.canManageWeb\) \{/);
    expect(row).not.toMatch(/if \(premium && status\?\.canManageWeb\)/);
  });

  test('the native row never points at the website', () => {
    const native = row.slice(row.indexOf('if (native) {'), row.indexOf('// Manage shows whenever'));
    expect(native).not.toMatch(/flockcorp\.com/);
    expect(native).not.toMatch(/href=/);
  });

  test('an App Store subscriber can reach the Apple subscriptions screen, a web one is not sent there', () => {
    const native = row.slice(row.indexOf('if (native) {'), row.indexOf('// Manage shows whenever'));
    expect(src).toMatch(/const APPLE_SUBSCRIPTIONS_URL = 'https:\/\/apps\.apple\.com\/account\/subscriptions';/);
    expect(native).toMatch(/window\.open\(APPLE_SUBSCRIPTIONS_URL/);
    expect(native).toMatch(/const fromApple = !!status && !status\.canManageWeb;/);
  });
});
