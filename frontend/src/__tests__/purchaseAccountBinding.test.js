/**
 * AN APP STORE PURCHASE LANDS ON THE ACCOUNT THAT MADE IT.
 *
 * RevenueCat records every purchase against its own app user id, which it
 * keeps on the device across launches, and the webhook grants Pro to whichever
 * of our users that id names (backend/routes/revenuecat.js). Three gaps let
 * the two drift apart:
 *
 *   1. No sign-out path called Purchases.logOut, so the last account stayed
 *      RevenueCat's user after it had gone.
 *   2. configure ran without an id.
 *   3. purchase and restore went straight to the store, so a buy made before
 *      the session's logIn landed, or after it failed, was recorded under the
 *      previous account or an anonymous id, and Pro went to the wrong person
 *      or to nobody.
 *   4. A buy or restore waiting its turn behind that logIn read the account
 *      only when its turn came, so one tapped by an account whose session
 *      ended meanwhile ran as whoever had signed in since.
 *
 * services/purchases.js and services/api.js are imported for real here, under a
 * fake RevenueCat plugin that remembers which account it holds, so every test
 * asks the one question that matters: which account was the store charged for.
 *
 * The last part pins the other agreement: purchases.js asks lib/nativeShell.js
 * whether this is the app, the answer the purchase screens act on.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const KEY_BEFORE = process.env.REACT_APP_REVENUECAT_IOS_KEY;
process.env.REACT_APP_REVENUECAT_IOS_KEY = 'appl_test_key';
afterAll(() => {
  if (KEY_BEFORE === undefined) delete process.env.REACT_APP_REVENUECAT_IOS_KEY;
  else process.env.REACT_APP_REVENUECAT_IOS_KEY = KEY_BEFORE;
});

// A fake RevenueCat. Plain functions over one state object, not jest.fn():
// react-scripts sets resetMocks: true, which strips a jest.fn() implementation
// before every test. The name has to start with "mock" for jest's hoisting.
const ANON = '$RCAnonymousID:0000aaaa';
const mockRc = {
  reset() {
    this.calls = [];
    this.appUserID = ANON;
    this.configured = false;
    this.logInFails = false;
    this.loads = 0;
    // A logIn held on the network until a test lets it through.
    this.holdLogIn = false;
    this.heldLogIns = [];
  },
  releaseLogIns() {
    this.holdLogIn = false;
    const held = this.heldLogIns;
    this.heldLogIns = [];
    held.forEach((finish) => finish());
  },
};
mockRc.reset();

jest.mock('@revenuecat/purchases-capacitor', () => ({
  get Purchases() {
    mockRc.loads += 1;
    return {
      configure: (opts) => {
        mockRc.calls.push(['configure', opts]);
        mockRc.configured = true;
        if (opts && opts.appUserID) mockRc.appUserID = opts.appUserID;
        return Promise.resolve();
      },
      isConfigured: () => Promise.resolve({ isConfigured: mockRc.configured }),
      getAppUserID: () => Promise.resolve({ appUserID: mockRc.appUserID }),
      logIn: ({ appUserID }) => {
        mockRc.calls.push(['logIn', appUserID]);
        if (mockRc.logInFails) return Promise.reject(new Error('The Internet connection appears to be offline.'));
        const land = () => {
          mockRc.appUserID = appUserID;
          return { customerInfo: { entitlements: { active: {} } }, created: false };
        };
        if (mockRc.holdLogIn) return new Promise((resolve) => { mockRc.heldLogIns.push(() => resolve(land())); });
        return Promise.resolve(land());
      },
      logOut: () => {
        mockRc.calls.push(['logOut']);
        if (mockRc.appUserID.startsWith('$RCAnonymousID')) return Promise.reject(new Error('LOGOUT_CALLED_WITH_ANONYMOUS_USER'));
        mockRc.appUserID = '$RCAnonymousID:1111bbbb';
        return Promise.resolve({ customerInfo: { entitlements: { active: {} } } });
      },
      getOfferings: () => Promise.resolve({ all: {}, current: null }),
      // Records WHO the store was charged for, which is the whole point.
      purchasePackage: () => {
        mockRc.calls.push(['purchasePackage', mockRc.appUserID]);
        return Promise.resolve({ customerInfo: { entitlements: { active: { pro: {} } } } });
      },
      restorePurchases: () => {
        mockRc.calls.push(['restorePurchases', mockRc.appUserID]);
        return Promise.resolve({ customerInfo: { entitlements: { active: { pro: {} } } } });
      },
    };
  },
}));

// clearLocalSession ends the native Google session too, on iOS. Faked so these
// tests never load the real plugin.
jest.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: { logout: () => Promise.resolve() },
}));

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const PKG = { identifier: '$rc_monthly', packageType: 'MONTHLY', product: { priceString: '$4.99' } };
const REAL_SHELL = () => ({ isNativePlatform: () => true, getPlatform: () => 'ios' });
const calls = (name) => mockRc.calls.filter(([n]) => n === name);
const charged = () => calls('purchasePackage').map(([, who]) => who);

let purchases;
beforeEach(() => {
  jest.resetModules();
  mockRc.reset();
  localStorage.clear();
  // The refusals below warn by design; the assertions are on what happened.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  window.Capacitor = REAL_SHELL();
  // eslint-disable-next-line global-require
  purchases = require('../services/purchases');
});
afterEach(() => { delete window.Capacitor; });

// ═══════════════════════════════════════════════════════════════════════════
// 1. The store is charged for the signed-in account, or not at all
// ═══════════════════════════════════════════════════════════════════════════
describe('a purchase is made as the account that is signed in', () => {
  test('after an account switch whose logIn failed, the buy still lands on the new account', async () => {
    await purchases.initPurchases(3);
    expect(mockRc.appUserID).toBe('3');
    await purchases.endPurchasesSession();
    // The next account signs in with no signal: its logIn fails.
    mockRc.logInFails = true;
    expect(await purchases.initPurchases(7)).toBe(false);
    // Signal back, the person taps Buy.
    mockRc.logInFails = false;
    const result = await purchases.purchase(PKG);
    expect(charged()).toEqual(['7']);
    expect(result).toEqual({ success: true, isPro: true });
  });

  test('while RevenueCat cannot be made the signed-in account, the store is never asked', async () => {
    await purchases.initPurchases(3);
    // Account 7 signs in; RevenueCat is still 3 and cannot be moved.
    mockRc.logInFails = true;
    await purchases.initPurchases(7);
    expect(mockRc.appUserID).toBe('3');
    const result = await purchases.purchase(PKG);
    expect(result).toEqual({ success: false, isPro: false, reason: 'account' });
    expect(charged()).toEqual([]);
  });

  test('a buy made before the session logIn has landed waits for it instead of racing it', async () => {
    // initPurchases and purchase fired back to back, the way a fast tap after
    // sign-in would: the purchase must not reach the store as the anonymous id.
    const init = purchases.initPurchases(12);
    const buy = purchases.purchase(PKG);
    await init;
    await buy;
    expect(charged()).toEqual(['12']);
  });

  test('with nobody signed in there is no purchase at all', async () => {
    const result = await purchases.purchase(PKG);
    expect(result.reason).toBe('account');
    expect(charged()).toEqual([]);
    expect(calls('logIn')).toEqual([]);
  });

  test('a restore moves purchases onto the signed-in account, so it gets the same check', async () => {
    await purchases.initPurchases(3);
    mockRc.logInFails = true;
    await purchases.initPurchases(7);
    expect(await purchases.restore()).toEqual({ success: false, isPro: false, reason: 'account' });
    expect(calls('restorePurchases')).toEqual([]);

    mockRc.logInFails = false;
    expect(await purchases.restore()).toEqual({ success: true, isPro: true });
    expect(calls('restorePurchases')).toEqual([['restorePurchases', '7']]);
  });

  test('configure starts as the account when it is already known', async () => {
    await purchases.initPurchases(9);
    expect(calls('configure')).toEqual([['configure', { apiKey: 'appl_test_key', appUserID: '9' }]]);
    // logIn(String(userId)) is still made: that is the webhook contract.
    expect(calls('logIn')).toEqual([['logIn', '9']]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. A buy or restore runs as the account that asked for it, or not at all
// ═══════════════════════════════════════════════════════════════════════════
describe('a buy or restore runs as the account that asked for it, or not at all', () => {
  // Account 3 signs in and its logIn hangs on the network. 3 taps the button,
  // and the tap queues behind that logIn. Before the logIn answers, 3's session
  // is revoked (a 401 runs clearLocalSession) and account 7 signs in.
  const askThenHandOver = async (ask, next = 7) => {
    mockRc.holdLogIn = true;
    const signIn = purchases.initPurchases(3);
    await flush();
    expect(calls('logIn')).toEqual([['logIn', '3']]);
    const asked = ask();
    await flush();
    const signOut = purchases.endPurchasesSession();
    const signInNext = purchases.initPurchases(next);
    await flush();
    mockRc.releaseLogIns();
    await Promise.all([signIn, signOut, signInNext]);
    return asked;
  };

  test('a restore tapped by one account is never run as the next one', async () => {
    const result = await askThenHandOver(() => purchases.restore());
    expect(result).toEqual({ success: false, isPro: false, reason: 'account' });
    // A restore moves the Apple ID's purchases onto whoever it runs as, so
    // this is the line that matters: it did not run as 7.
    expect(calls('restorePurchases')).toEqual([]);
    // 7 is RevenueCat's user now, and a restore 7 asks for runs as 7.
    expect(mockRc.appUserID).toBe('7');
    expect(await purchases.restore()).toEqual({ success: true, isPro: true });
    expect(calls('restorePurchases')).toEqual([['restorePurchases', '7']]);
  });

  test('nor is a buy', async () => {
    const result = await askThenHandOver(() => purchases.purchase(PKG));
    expect(result).toEqual({ success: false, isPro: false, reason: 'account' });
    expect(charged()).toEqual([]);
    expect(mockRc.appUserID).toBe('7');
    expect(await purchases.purchase(PKG)).toEqual({ success: true, isPro: true });
    expect(charged()).toEqual(['7']);
  });

  test('a request from a session that has ended is refused even when the same account signs back in', async () => {
    const result = await askThenHandOver(() => purchases.restore(), 3);
    expect(result).toEqual({ success: false, isPro: false, reason: 'account' });
    expect(calls('restorePurchases')).toEqual([]);
  });

  test('a tap from the session still signed in waits its turn and runs as that account', async () => {
    mockRc.holdLogIn = true;
    const signIn = purchases.initPurchases(3);
    await flush();
    const asked = purchases.restore();
    await flush();
    expect(calls('restorePurchases')).toEqual([]);
    mockRc.releaseLogIns();
    await signIn;
    expect(await asked).toEqual({ success: true, isPro: true });
    expect(calls('restorePurchases')).toEqual([['restorePurchases', '3']]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Every sign-out path logs RevenueCat out
// ═══════════════════════════════════════════════════════════════════════════
describe('signing out tells RevenueCat', () => {
  test('clearLocalSession, which Log out and account deletion both run, logs RevenueCat out', async () => {
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    await purchases.initPurchases(4);
    api.clearLocalSession();
    await flush();
    expect(calls('logOut')).toHaveLength(1);
    expect(mockRc.appUserID).not.toBe('4');
    // And the session is gone from the purchase side too.
    expect((await purchases.purchase(PKG)).reason).toBe('account');
    expect(charged()).toEqual([]);
  });

  test('a mid-session 401 signs RevenueCat out as well', async () => {
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    await purchases.initPurchases(4);
    localStorage.setItem('flockToken', 'tok-dead');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ error: 'Invalid token' }),
      text: async () => JSON.stringify({ error: 'Invalid token' }),
    });
    await expect(api.getBlockedUsers()).rejects.toThrow();
    await flush();
    expect(calls('logOut')).toHaveLength(1);
  });

  test('a sign-out that finishes first leaves RevenueCat anonymous for the next sign-in', async () => {
    await purchases.initPurchases(3);
    mockRc.calls = [];
    await purchases.endPurchasesSession();
    expect(mockRc.appUserID.startsWith('$RCAnonymousID')).toBe(true);
    await purchases.initPurchases(8);
    const order = mockRc.calls.map(([n, v]) => (v ? `${n}:${v}` : n));
    expect(order).toEqual(['logOut', 'logIn:8']);
  });

  test('a sign-out overtaken by the next sign-in cannot undo it', async () => {
    await purchases.initPurchases(3);
    mockRc.calls = [];
    // Both fired without waiting, as a quick hand-over of the phone would.
    const out = purchases.endPurchasesSession();
    const back = purchases.initPurchases(8);
    await out;
    await back;
    const order = mockRc.calls.map(([n, v]) => (v ? `${n}:${v}` : n));
    // Whatever ran, nothing logged RevenueCat out after it became account 8.
    expect(order.slice(order.indexOf('logIn:8'))).not.toContain('logOut');
    expect(mockRc.appUserID).toBe('8');
    await purchases.purchase(PKG);
    expect(charged()).toEqual(['8']);
  });

  test('a sign-out never waits on RevenueCat and never throws, even when logOut rejects', async () => {
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    // Anonymous already: RevenueCat rejects logOut for that.
    await purchases.initPurchases(undefined);
    expect(() => api.clearLocalSession()).not.toThrow();
    await flush();
    expect(await purchases.endPurchasesSession()).toBe(false);
  });

  test('on the web nothing loads RevenueCat, on sign-out or anywhere else', async () => {
    jest.resetModules();
    delete window.Capacitor;
    mockRc.reset();
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    // eslint-disable-next-line global-require
    const web = require('../services/purchases');
    api.clearLocalSession();
    await web.initPurchases(5);
    await flush();
    expect(mockRc.loads).toBe(0);
    expect(mockRc.calls).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The shape of it, where behaviour cannot reach
// ═══════════════════════════════════════════════════════════════════════════
const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the wiring', () => {
  const PURCHASES = read('services', 'purchases.js');
  const API = read('services', 'api.js');

  test('purchase and restore confirm the account before the store call, inside one queue', () => {
    for (const [fn, storeCall] of [['purchase', 'Purchases.purchasePackage('], ['restore', 'Purchases.restorePurchases(']]) {
      const at = PURCHASES.indexOf(`export const ${fn} = async`);
      expect(at).toBeGreaterThan(-1);
      const body = PURCHASES.slice(at, PURCHASES.indexOf('\n};', at));
      expect(body).toContain('serially(');
      expect(body.indexOf('becomeSessionAccount(Purchases, asker)')).toBeGreaterThan(-1);
      expect(body.indexOf('becomeSessionAccount(Purchases, asker)')).toBeLessThan(body.indexOf(storeCall));
      // Who asked is read before the first thing that waits, so no sign-out or
      // sign-in can land between the tap and the reading.
      expect(body.indexOf('const asker = askedBy();')).toBeGreaterThan(-1);
      expect(body.indexOf('const asker = askedBy();')).toBeLessThan(body.indexOf('await '));
    }
    // And a sign-out counts itself before it waits on anything either.
    const end = PURCHASES.slice(PURCHASES.indexOf('export const endPurchasesSession = async'));
    expect(end.indexOf('signOuts += 1;')).toBeGreaterThan(-1);
    expect(end.indexOf('signOuts += 1;')).toBeLessThan(end.indexOf('await '));
  });

  test('the sign-out hook sits in clearLocalSession, after the wipe, native only and lazily imported', () => {
    const fn = API.slice(API.indexOf('export function clearLocalSession'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body.indexOf('sweepStore(window.localStorage)')).toBeLessThan(body.indexOf('endNativePurchasesSession()'));
    expect(body).not.toContain('await');
    const hook = API.slice(API.indexOf('function endNativePurchasesSession'));
    const hookBody = hook.slice(0, hook.indexOf('\n}\n'));
    expect(hookBody).toContain('if (!isNativeShell()) return;');
    expect(hookBody).toContain("import('./purchases')");
    expect(hookBody).toContain('.catch(');
    expect(stripComments(API)).not.toMatch(/^import .*['"]\.\/purchases['"]/m);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The paywall and purchases.js agree on whether this is the app
// ═══════════════════════════════════════════════════════════════════════════
describe('purchases.js asks the detector the purchase screens ask', () => {
  const PURCHASES = read('services', 'purchases.js');

  test('it imports lib/nativeShell and keeps no check of its own', () => {
    expect(PURCHASES).toContain("import { isNativeShell } from '../lib/nativeShell';");
    expect(PURCHASES).toMatch(/export const isPurchasesAvailable = \(\) => isNativeShell\(\) && !!API_KEY;/);
    expect(stripComments(PURCHASES)).not.toMatch(/isNativePlatform/);
  });

  const loadWith = (bridgeAtBoot, bridgeLater) => {
    let mods;
    jest.isolateModules(() => {
      if (bridgeAtBoot === undefined) delete window.Capacitor;
      else window.Capacitor = bridgeAtBoot;
      mods = {
        // eslint-disable-next-line global-require
        shell: require('../lib/nativeShell'),
        // eslint-disable-next-line global-require
        store: require('../services/purchases'),
      };
      if (bridgeLater !== undefined) window.Capacitor = bridgeLater;
    });
    return mods;
  };

  test.each([
    ['the iOS shell', REAL_SHELL(), undefined, true],
    ['a browser with no bridge', undefined, undefined, false],
    ['@capacitor/core loaded in a browser', { isNativePlatform: () => false, getPlatform: () => 'web' }, undefined, false],
    ['a bridge that answers only getPlatform', { getPlatform: () => 'ios' }, undefined, true],
    ['a shell booted native whose bridge later answers web', {}, { isNativePlatform: () => false, getPlatform: () => 'web' }, true],
  ])('%s: the store and the sheet give the same answer', (_label, atBoot, later, expected) => {
    const { shell, store } = loadWith(atBoot, later);
    expect(shell.isNativeShell()).toBe(expected);
    expect(store.isPurchasesAvailable()).toBe(expected);
  });

  test('RevenueCat configures in the iOS shell and never on the web, as before', async () => {
    const shellMods = loadWith(REAL_SHELL());
    await shellMods.store.initPurchases(21);
    expect(calls('configure')).toHaveLength(1);

    mockRc.reset();
    const webMods = loadWith(undefined);
    await webMods.store.initPurchases(21);
    expect(mockRc.calls).toEqual([]);
    expect(mockRc.loads).toBe(0);
  });
});
