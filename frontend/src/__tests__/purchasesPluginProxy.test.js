/**
 * THE REVENUECAT PLUGIN ANSWERS EVERY NAME, `then` INCLUDED.
 *
 * Capacitor's registerPlugin hands back a Proxy whose get trap returns a
 * method for whatever property is asked for. `then` is one more name to it,
 * so the plugin itself cannot be the value an async function returns, or a
 * value that is awaited: the promise machinery sees a thenable and calls
 * Purchases.then(resolve, reject), which goes to the native side as a method
 * the plugin does not have. On iOS that call never answers. loadPlugin used to
 * return the plugin from an async function, so every one of its six callers
 * (initPurchases, endPurchasesSession, getProOffering, introEligibleProducts,
 * purchase, restore) waited forever, and the Pro sheet sat on its loading
 * shapes. services/purchases.js now hands it back inside { Purchases }, an
 * object with no `then`.
 *
 * The plugin here is built the way Capacitor builds it: a Proxy that answers
 * every string property with a method. A method the store has resolves with
 * its answer; any other, `then` among them, is recorded and never settles,
 * which is what the bridge did. The older mocks in this folder are plain
 * objects with no `then`, which is why none of them could see this.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test purchasesPluginProxy --watchAll=false
 */

// Plain functions over one state object, not jest.fn(): react-scripts sets
// resetMocks: true. The name starts with "mock" for jest's hoisting.
const mockPlugin = {
  reset() {
    this.calls = [];
    this.appUserID = '$RCAnonymousID:proxy';
  },
};
mockPlugin.reset();

const customerInfo = (pro) => ({
  entitlements: { all: {}, active: pro ? { pro: { identifier: 'pro', isActive: true } } : {} },
  activeSubscriptions: pro ? ['flock_pro_monthly'] : [],
});
const MONTHLY = { identifier: '$rc_monthly', packageType: 'MONTHLY', product: { identifier: 'flock_pro_monthly', priceString: '$3.99', price: 3.99 } };
const ANNUAL = { identifier: '$rc_annual', packageType: 'ANNUAL', product: { identifier: 'flock_pro_yearly', priceString: '$29.99', price: 29.99 } };

// What the App Store answers, by method. Everything else is a method the
// plugin does not have.
const mockAnswers = {
  configure: (opts) => { if (opts && opts.appUserID) mockPlugin.appUserID = opts.appUserID; },
  isConfigured: () => ({ isConfigured: true }),
  getAppUserID: () => ({ appUserID: mockPlugin.appUserID }),
  logIn: ({ appUserID }) => { mockPlugin.appUserID = appUserID; return { customerInfo: customerInfo(false), created: false }; },
  logOut: () => { mockPlugin.appUserID = '$RCAnonymousID:proxy'; return customerInfo(false); },
  getOfferings: () => {
    const offering = { identifier: 'default', availablePackages: [MONTHLY, ANNUAL] };
    return { all: { default: offering }, current: offering };
  },
  checkTrialOrIntroductoryPriceEligibility: ({ productIdentifiers }) => Object.fromEntries(productIdentifiers.map((id) => [id, { status: 2 }])),
  purchasePackage: () => ({ customerInfo: customerInfo(true), productIdentifier: 'flock_pro_monthly' }),
  restorePurchases: () => ({ customerInfo: customerInfo(true) }),
};

jest.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        mockPlugin.calls.push(prop);
        const answer = mockAnswers[prop];
        // The bridge never answers a method the plugin does not have.
        return answer ? Promise.resolve(answer(...args)) : new Promise(() => {});
      };
    },
  }),
}));

const KEY_BEFORE = process.env.REACT_APP_REVENUECAT_IOS_KEY;
const FLAG_BEFORE = process.env.REACT_APP_PURCHASES;
afterEach(() => {
  delete window.Capacitor;
  if (FLAG_BEFORE === undefined) delete process.env.REACT_APP_PURCHASES;
  else process.env.REACT_APP_PURCHASES = FLAG_BEFORE;
});
afterAll(() => {
  if (KEY_BEFORE === undefined) delete process.env.REACT_APP_REVENUECAT_IOS_KEY;
  else process.env.REACT_APP_REVENUECAT_IOS_KEY = KEY_BEFORE;
});

// Inside the iPhone app, with the Apple key built in, in the build that sells
// Pro through the App Store: every condition for reaching the store is met.
function inTheApp() {
  mockPlugin.reset();
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  process.env.REACT_APP_REVENUECAT_IOS_KEY = 'appl_test_key';
  process.env.REACT_APP_PURCHASES = 'iap';
  let mod;
  jest.isolateModules(() => { mod = require('../services/purchases'); });
  return mod;
}

// The answer, or the fact that there was none within the window. Every call
// below settles within a few microtasks when nothing waits on the bridge.
const HUNG = Symbol('hung');
const settle = (promise, ms = 300) => Promise.race([
  promise,
  new Promise((resolve) => { setTimeout(() => resolve(HUNG), ms); }),
]);

describe('the mock is the plugin Capacitor builds', () => {
  test('it answers then like any other name, so awaiting the plugin itself never finishes', async () => {
    const { Purchases } = jest.requireMock('@revenuecat/purchases-capacitor');
    expect(typeof Purchases.then).toBe('function');
    expect(typeof Purchases.anyNameAtAll).toBe('function');
    mockPlugin.reset();
    expect(await settle(Promise.resolve(Purchases))).toBe(HUNG);
    expect(mockPlugin.calls).toEqual(['then']);
  });
});

describe('services/purchases.js never awaits the plugin itself', () => {
  test('initPurchases configures, logs in and answers true', async () => {
    const purchases = inTheApp();
    expect(await settle(purchases.initPurchases(42))).toBe(true);
    expect(mockPlugin.calls).toEqual(['configure', 'logIn']);
    expect(mockPlugin.appUserID).toBe('42');
  });

  test('getProOffering answers the two App Store plans', async () => {
    const purchases = inTheApp();
    const packages = await settle(purchases.getProOffering());
    expect(packages).not.toBe(HUNG);
    expect(packages.map((p) => p.identifier)).toEqual(['$rc_monthly', '$rc_annual']);
    expect(mockPlugin.calls).not.toContain('then');
  });

  test('introEligibleProducts answers which trials this Apple ID can take', async () => {
    const purchases = inTheApp();
    const eligible = await settle(purchases.introEligibleProducts(['flock_pro_yearly']));
    expect(eligible).not.toBe(HUNG);
    expect([...eligible]).toEqual(['flock_pro_yearly']);
    expect(mockPlugin.calls).not.toContain('then');
  });

  test('purchase buys for the signed-in account and answers Pro', async () => {
    const purchases = inTheApp();
    await settle(purchases.initPurchases(42));
    expect(await settle(purchases.purchase(MONTHLY))).toEqual({ success: true, isPro: true });
    expect(mockPlugin.calls).toContain('purchasePackage');
    expect(mockPlugin.calls).not.toContain('then');
  });

  test('restore answers what the store restored', async () => {
    const purchases = inTheApp();
    await settle(purchases.initPurchases(42));
    expect(await settle(purchases.restore())).toEqual({ success: true, isPro: true });
    expect(mockPlugin.calls).toContain('restorePurchases');
    expect(mockPlugin.calls).not.toContain('then');
  });

  test('endPurchasesSession logs RevenueCat out', async () => {
    const purchases = inTheApp();
    await settle(purchases.initPurchases(42));
    expect(await settle(purchases.endPurchasesSession())).toBe(true);
    expect(mockPlugin.calls).toContain('logOut');
    expect(mockPlugin.calls).not.toContain('then');
  });
});
