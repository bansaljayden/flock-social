/**
 * A PURCHASE THAT CHARGED NEVER ENDS WITH NOTHING ON SCREEN.
 *
 * Two places let an App Store purchase finish in silence.
 *
 *   1. The store took the payment but RevenueCat's answer did not carry the
 *      `pro` entitlement. services/purchases.js answered that exactly as it
 *      answers a cancel ({ success: false }), and the sheet stays quiet on a
 *      cancel, so the person was charged and saw nothing. purchase() now says
 *      reason: 'not_granted' and the sheet says what happened and what to do.
 *
 *   2. After "Welcome to Flock Pro", App.js polls the server for about 17
 *      seconds for Pro to land, then stopped without a word if it never did,
 *      leaving a paying account metered. It now says so when it gives up,
 *      unless Pro has arrived some other way.
 *
 * The first runs the real purchases.js under a fake RevenueCat plugin (the
 * same stand-in paywallRefusesUnboundPurchase.test.js uses), so it is the
 * chain a tap takes. The second lifts the poll out of App.js as source text
 * and runs it against stand-ins, the way billReadEveryPlan.test.js lifts
 * loadMoneyState.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test paywallPaidNotOn --watchAll=false
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';

const fs = require('fs');
const path = require('path');

const KEY_BEFORE = process.env.REACT_APP_REVENUECAT_IOS_KEY;
process.env.REACT_APP_REVENUECAT_IOS_KEY = 'appl_test_key';
afterAll(() => {
  if (KEY_BEFORE === undefined) delete process.env.REACT_APP_REVENUECAT_IOS_KEY;
  else process.env.REACT_APP_REVENUECAT_IOS_KEY = KEY_BEFORE;
});

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/api', () => ({
  getProStatus: jest.fn(),
  startProCheckout: jest.fn(),
  trackPaywallShown: jest.fn(),
  trackPurchaseCompleted: jest.fn(),
}));

// Plain functions over one state object: react-scripts sets resetMocks: true.
const mockRc = {
  reset() {
    this.appUserID = '$RCAnonymousID:0000aaaa';
    this.grantsPro = true;
    this.cancels = false;
    this.charged = [];
  },
};
mockRc.reset();

const PKGS = [
  { identifier: '$rc_monthly', packageType: 'MONTHLY', product: { identifier: 'pro_monthly', priceString: '$3.99', price: 3.99, introPrice: null }, presentedOfferingContext: {} },
  { identifier: '$rc_annual', packageType: 'ANNUAL', product: { identifier: 'pro_annual', priceString: '$29.99', price: 29.99, introPrice: null }, presentedOfferingContext: {} },
];

jest.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    configure: (opts) => { if (opts && opts.appUserID) mockRc.appUserID = opts.appUserID; return Promise.resolve(); },
    isConfigured: () => Promise.resolve({ isConfigured: true }),
    getAppUserID: () => Promise.resolve({ appUserID: mockRc.appUserID }),
    logIn: ({ appUserID }) => { mockRc.appUserID = appUserID; return Promise.resolve({ customerInfo: { entitlements: { active: {} } }, created: false }); },
    logOut: () => Promise.resolve({ customerInfo: { entitlements: { active: {} } } }),
    getOfferings: () => Promise.resolve({ all: { default: { availablePackages: PKGS } }, current: null }),
    purchasePackage: () => {
      if (mockRc.cancels) return Promise.reject(Object.assign(new Error('Purchase was cancelled.'), { userCancelled: true }));
      mockRc.charged.push(mockRc.appUserID);
      const active = mockRc.grantsPro ? { pro: {} } : {};
      return Promise.resolve({ customerInfo: { entitlements: { active } } });
    },
    restorePurchases: () => Promise.resolve({ customerInfo: { entitlements: { active: {} } } }),
  },
}));

// Required, not imported: an import is hoisted above the key assignment at the
// top of this file, and purchases.js reads the key when it loads.
const PaywallSheet = require('../components/PaywallSheet').default;
const { trackPurchaseCompleted } = require('../services/api');
const { initPurchases, purchase } = require('../services/purchases');

const MONTHLY_CTA = 'Get Pro, $3.99/month';
const PAID_NOT_ON_YET = "Your payment went through, but Flock Pro isn't on yet. Tap Restore purchases or try again in a minute. If it still isn't on, write to social@flockcorp.com.";

describe('the store charged and RevenueCat did not grant Pro', () => {
  beforeEach(async () => {
    mockRc.reset();
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await initPurchases(7);
  });
  afterEach(() => { delete window.Capacitor; });

  test('purchase() tells it apart from a cancel', async () => {
    mockRc.grantsPro = false;
    expect(await purchase(PKGS[0])).toEqual({ success: false, isPro: false, reason: 'not_granted' });
    expect(mockRc.charged).toEqual(['7']);
    mockRc.cancels = true;
    expect(await purchase(PKGS[0])).toEqual({ success: false, isPro: false });
    mockRc.cancels = false;
    mockRc.grantsPro = true;
    expect(await purchase(PKGS[0])).toEqual({ success: true, isPro: true });
  });

  test('the sheet says the payment went through, what to try, and who can help, and stays open on Restore', async () => {
    mockRc.grantsPro = false;
    const onUpgraded = jest.fn();
    const onClose = jest.fn();
    const showToast = jest.fn();
    render(<PaywallSheet open trigger="birdie" onClose={onClose} onUpgraded={onUpgraded} showToast={showToast} />);
    const cta = await screen.findByRole('button', { name: MONTHLY_CTA });
    await act(async () => { cta.click(); });

    expect(await screen.findByRole('alert')).toHaveTextContent(PAID_NOT_ON_YET);
    expect(mockRc.charged).toEqual(['7']);
    expect(screen.getByRole('button', { name: 'Restore purchases' })).toBeTruthy();
    // Not a success: no welcome, no purchase event, the sheet is still up.
    expect(showToast).not.toHaveBeenCalled();
    expect(trackPurchaseCompleted).not.toHaveBeenCalled();
    expect(onUpgraded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The sentence follows the copy rules and points at no store but this one.
    expect(PAID_NOT_ON_YET).not.toMatch(/—|https?:|\/pro\b|website/);
  });

  test('a cancel still leaves the sheet quiet', async () => {
    mockRc.cancels = true;
    render(<PaywallSheet open trigger="settings" onClose={() => {}} showToast={() => {}} />);
    const cta = await screen.findByRole('button', { name: MONTHLY_CTA });
    await act(async () => { cta.click(); });
    await waitFor(() => expect(screen.getByRole('button', { name: MONTHLY_CTA }).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a purchase that grants Pro is the success it always was', async () => {
    const onUpgraded = jest.fn();
    const showToast = jest.fn();
    render(<PaywallSheet open trigger="settings" onClose={() => {}} onUpgraded={onUpgraded} showToast={showToast} />);
    const cta = await screen.findByRole('button', { name: MONTHLY_CTA });
    await act(async () => { cta.click(); });
    await waitFor(() => expect(onUpgraded).toHaveBeenCalledTimes(1));
    // Told it was a purchase, the one kind of poll that may end in the toast.
    expect(onUpgraded).toHaveBeenCalledWith('purchase');
    expect(showToast).toHaveBeenCalledWith('Welcome to Flock Pro', 'success');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The poll in App.js after "Welcome to Flock Pro".
// ---------------------------------------------------------------------------
const appSource = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// A `const <name> = useCallback(...)` declared inside the component, up to its
// closing semicolon. Same walk as billReadEveryPlan's liftCallback.
function liftCallback(source, name) {
  const marker = `  const ${name} = useCallback(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`liftCallback: no \`${name} = useCallback(\` in source`);
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`liftCallback: unterminated declaration for ${name}`);
}

const APPLY_SRC = liftCallback(appSource, 'applyEntitlements');
const CONFIRM_SRC = liftCallback(appSource, 'confirmUpgrade');
const NOT_ON_TOAST = "Your Flock Pro is paid for, but it isn't on for this account yet. In a minute, open Flock Pro in You and tap Restore purchases. If it still isn't on, write to social@flockcorp.com.";

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * The poll and the snapshot writer, lifted, with the server answering from
 * `answers` in order (an Error is a failed read) and the poll's timers held in
 * a queue the test runs, so the 17 seconds pass at once.
 */
function poll({ answers, purchases }) {
  const timers = [];
  const toasts = [];
  const scope = {
    useCallback: (fn) => fn,
    process: { env: purchases === undefined ? {} : { REACT_APP_PURCHASES: purchases } },
    entitlementsSentRef: { current: 0 },
    entitlementsAppliedRef: { current: 0 },
    proAppliedRef: { current: false },
    upgradePollRef: { current: null },
    setEntitlements: () => {},
    setAiRemaining: () => {},
    syncProFromStore: () => Promise.resolve({}),
    getEntitlements: jest.fn(() => {
      const next = answers.length ? answers.shift() : { isPremium: false };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
    showToast: (message, type) => toasts.push([message, type]),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  // eslint-disable-next-line no-new-func
  const lifted = new Function(...Object.keys(scope), `${APPLY_SRC}\n${CONFIRM_SRC}\nreturn { applyEntitlements, confirmUpgrade };`)(...Object.values(scope));
  const runToEnd = async (after) => {
    lifted.confirmUpgrade(after);
    await settle();
    while (timers.length) {
      timers.shift()();
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }
  };
  return { ...lifted, scope, toasts, runToEnd };
}

describe('the poll after an App Store purchase', () => {
  test('when the server never says Pro, it says so once, as an error that stays up', async () => {
    const p = poll({ answers: [] });
    await p.runToEnd('purchase');
    expect(p.scope.getEntitlements).toHaveBeenCalledTimes(5);
    expect(p.toasts).toEqual([[NOT_ON_TOAST, 'error']]);
  });

  test('when Pro lands on the third read, it stops there and says nothing', async () => {
    const p = poll({ answers: [{ isPremium: false }, new Error('offline'), { isPremium: true }] });
    await p.runToEnd('purchase');
    expect(p.scope.getEntitlements).toHaveBeenCalledTimes(3);
    expect(p.toasts).toEqual([]);
  });

  test('when another read already brought Pro, giving up is not reported as Pro missing', async () => {
    // The poll's own reads keep failing, while the foreground re-read applied
    // a newer answer that says Pro.
    const p = poll({ answers: [new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline')] });
    p.scope.entitlementsSentRef.current = 100;
    p.applyEntitlements(100, { isPremium: true });
    await p.runToEnd('purchase');
    expect(p.toasts).toEqual([]);
  });

  test('a build that sells nothing never says it', async () => {
    const p = poll({ answers: [], purchases: 'off' });
    await p.runToEnd('purchase');
    expect(p.toasts).toEqual([]);
  });

  // The sentence says a payment went through. Only a purchase took one: a
  // restore polls the same way and gives up without it, and anything that
  // does not say what happened is not a purchase.
  test.each([['a restore', 'restore'], ['a call that names nothing', undefined]])('after %s it polls and gives up without the sentence', async (_label, after) => {
    const p = poll({ answers: [] });
    await p.runToEnd(after);
    expect(p.scope.getEntitlements).toHaveBeenCalledTimes(5);
    expect(p.toasts).toEqual([]);
  });

  test('the sentence follows the copy rules and the gate is the literal flag', () => {
    expect(NOT_ON_TOAST).not.toMatch(/—|https?:|website/);
    expect(CONFIRM_SRC).toContain("if ((process.env.REACT_APP_PURCHASES !== 'off') && after === 'purchase' && !proAppliedRef.current) {");
    expect(CONFIRM_SRC).toMatch(/\}, \[applyEntitlements, showToast\]\);$/);
  });

  test('an account the sheet finds already Pro is re-read once, never polled', () => {
    // The sheet's onAlreadyPro is the plain re-read, so the purchase poll and
    // its sentence cannot follow a sheet that says the account has Pro.
    const mount = appSource.slice(appSource.indexOf('<PaywallSheet'), appSource.indexOf('/>', appSource.indexOf('<PaywallSheet')));
    expect(mount).toContain('onUpgraded={confirmUpgrade}');
    expect(mount).toContain('onAlreadyPro={refreshEntitlements}');
  });
});
