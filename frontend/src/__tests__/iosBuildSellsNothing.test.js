/**
 * THE APP STORE BUILD SELLS NOTHING, AND THE WEB IS UNCHANGED.
 *
 * codemagic.yaml builds the iOS web bundle with REACT_APP_PURCHASES=off
 * (lib/purchasesBuild.js). With it off there is no Pro sheet, no Pro row, no
 * /pro, no landing page, no venue plans sheet, no price, no checkout call and
 * no RevenueCat start-up, and a server limit is stated without an offer. With
 * it unset, which is the web, every one of those behaves as before.
 *
 * Two kinds of check. Where a surface can be mounted on its own (the Pro row,
 * the RevenueCat wrapper, the billing calls, the venue verification line) it
 * is run both ways. The rest live in App.js and the lazy screens with dozens
 * of props, so they are read as source, the way crowdDialCovered.test.js reads
 * the venue card, and what is pinned is that each gate is the literal
 * comparison: that is what lets the build drop the code and its strings, not
 * only hide them (lib/purchasesBuild.js says why a function call does not).
 * `REACT_APP_PURCHASES=off CI=true npm run build` followed by
 * `node scripts/scan-purchase-strings.js` is the check on the built output.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));

// A fake RevenueCat plugin. Plain functions, because react-scripts resets
// jest.fn() implementations before every test. The name starts with "mock"
// for jest's hoisting.
const mockRc = { calls: [], loads: 0 };
jest.mock('@revenuecat/purchases-capacitor', () => ({
  get Purchases() {
    mockRc.loads += 1;
    return {
      configure: (opts) => { mockRc.calls.push(['configure', opts]); return Promise.resolve(); },
      isConfigured: () => Promise.resolve({ isConfigured: true }),
      getAppUserID: () => Promise.resolve({ appUserID: 'x' }),
      logIn: ({ appUserID }) => { mockRc.calls.push(['logIn', appUserID]); return Promise.resolve(); },
      logOut: () => Promise.resolve(),
      getOfferings: () => Promise.resolve({ all: {} }),
    };
  },
}));

const SRC = path.join(__dirname, '..');
const REPO = path.join(SRC, '..', '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const readRepo = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');

const ON = "(process.env.REACT_APP_PURCHASES !== 'off')";
const FLAG_BEFORE = process.env.REACT_APP_PURCHASES;
const KEY_BEFORE = process.env.REACT_APP_REVENUECAT_IOS_KEY;
const setFlag = (value) => {
  if (value === undefined) delete process.env.REACT_APP_PURCHASES;
  else process.env.REACT_APP_PURCHASES = value;
};

afterEach(() => {
  setFlag(FLAG_BEFORE);
  delete window.Capacitor;
});
afterAll(() => {
  if (KEY_BEFORE === undefined) delete process.env.REACT_APP_REVENUECAT_IOS_KEY;
  else process.env.REACT_APP_REVENUECAT_IOS_KEY = KEY_BEFORE;
});

describe('the flag itself', () => {
  test('only the exact value off turns purchases off', () => {
    const { purchasesInBuild } = require('../lib/purchasesBuild');
    setFlag(undefined);
    expect(purchasesInBuild()).toBe(true);
    setFlag('');
    expect(purchasesInBuild()).toBe(true);
    setFlag('on');
    expect(purchasesInBuild()).toBe(true);
    setFlag('off');
    expect(purchasesInBuild()).toBe(false);
  });
});

describe('RevenueCat', () => {
  // Inside the native shell, with a key baked in: every condition for starting
  // RevenueCat is met except the flag.
  const loadNative = () => {
    window.Capacitor = { isNativePlatform: () => true };
    process.env.REACT_APP_REVENUECAT_IOS_KEY = 'appl_test_key';
    let mod;
    jest.isolateModules(() => { mod = require('../services/purchases'); });
    return mod;
  };
  beforeEach(() => { mockRc.calls = []; mockRc.loads = 0; });

  test('off: never available, never configured, never logged in, the store never asked', async () => {
    setFlag('off');
    const purchases = loadNative();
    expect(purchases.isPurchasesAvailable()).toBe(false);
    expect(await purchases.initPurchases(42)).toBe(false);
    expect(await purchases.getProOffering()).toBeNull();
    expect(await purchases.purchase({ identifier: 'monthly' })).toEqual({ success: false, isPro: false });
    expect(await purchases.restore()).toEqual({ success: false, isPro: false });
    expect(await purchases.endPurchasesSession()).toBe(false);
    expect(mockRc.loads).toBe(0);
    expect(mockRc.calls).toEqual([]);
  });

  test('unset: configures and logs in as before', async () => {
    setFlag(undefined);
    const purchases = loadNative();
    expect(purchases.isPurchasesAvailable()).toBe(true);
    expect(await purchases.initPurchases(42)).toBe(true);
    expect(mockRc.calls[0][0]).toBe('configure');
    expect(mockRc.calls).toContainEqual(['logIn', '42']);
  });

  test('every place that would load it is behind the literal gate', () => {
    const app = read('App.js');
    expect(app).toContain("if (process.env.REACT_APP_PURCHASES !== 'off' && authUser?.id) {\n      import('./services/purchases')");
    const api = read('services', 'api.js');
    expect(api).toContain("if (process.env.REACT_APP_PURCHASES !== 'off') {\n      if (!isNativeShell()) return;\n      import('./purchases')");
    const wrapper = read('services', 'purchases.js');
    expect(wrapper).toContain("const mod = process.env.REACT_APP_PURCHASES === 'off'\n      ? null\n      : await import('@revenuecat/purchases-capacitor');");
    expect(wrapper).toContain('export const isPurchasesAvailable = () => purchasesInBuild() && isNativeShell() && !!API_KEY;');
  });
});

describe('the Pro and Roost billing calls', () => {
  const api = jest.requireActual('../services/api');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const CALLS = [
    ['getProStatus', []],
    ['startProCheckout', ['monthly']],
    ['cancelProSubscription', []],
    ['resumeProSubscription', []],
    ['openProPortal', []],
    ['confirmProCheckout', ['cs_test_1']],
    ['getVenueBillingStatus', []],
    ['startVenueCheckout', ['monthly']],
    ['openVenuePortal', []],
    ['confirmVenueCheckout', ['cs_test_1']],
  ];

  test.each(CALLS)('off: %s refuses without asking the server', async (name, args) => {
    setFlag('off');
    global.fetch = jest.fn();
    await expect(api[name](...args)).rejects.toMatchObject({ code: 'PURCHASES_OFF' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unset: they reach the server as before', async () => {
    setFlag(undefined);
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ isPremium: false }),
      text: () => Promise.resolve('{"isPremium":false}'),
    }));
    await api.getProStatus().catch(() => {});
    expect(global.fetch).toHaveBeenCalled();
    expect(String(global.fetch.mock.calls[0][0])).toContain('/api/pro/status');
  });
});

describe('the You tab', () => {
  const COLORS = { navy: '#0d2847' };

  test('off: no Pro row, and no /status read, native or web', () => {
    setFlag('off');
    const spy = jest.spyOn(require('../services/api'), 'getProStatus');
    const { ProRow } = require('../screens/ProfileSettings');
    for (const native of [false, true]) {
      if (native) window.Capacitor = { isNativePlatform: () => true };
      const { container, unmount } = render(
        <ProRow isPro={false} entitlements={{ paywallEnabled: true }} colors={COLORS} setPaywallTrigger={() => {}} showToast={() => {}} />
      );
      expect(container.innerHTML).toBe('');
      unmount();
      const pro = render(
        <ProRow isPro entitlements={{ paywallEnabled: true }} colors={COLORS} setPaywallTrigger={() => {}} showToast={() => {}} />
      );
      expect(pro.container.innerHTML).toBe('');
      pro.unmount();
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('unset: the native row opens the sheet as before', async () => {
    setFlag(undefined);
    window.Capacitor = { isNativePlatform: () => true };
    const { ProRow } = require('../screens/ProfileSettings');
    const setPaywallTrigger = jest.fn();
    render(<ProRow isPro={false} entitlements={{ paywallEnabled: true }} colors={COLORS} setPaywallTrigger={setPaywallTrigger} showToast={() => {}} />);
    screen.getByRole('button', { name: /Flock Pro/ }).click();
    await waitFor(() => expect(setPaywallTrigger).toHaveBeenCalledWith('settings'));
  });

  test('the Pro row is gated', () => {
    const src = read('screens', 'ProfileSettings.js');
    expect(src).toContain(`{${ON} && <ProRow `);
    // Deletion itself is untouched: the sheet, its confirm word and the call.
    expect(src).toContain('Delete your account?');
    expect(src).toMatch(/deleteAccount\(/);
  });

  // The crowd alerts row: from the "Crowd alerts" label to the end of its
  // control. The backend sends that push only to Pro while the paywall is on
  // (services/crowdAlerts.js), so an account without it never gets a switch.
  const alertsRow = () => {
    const src = read('screens', 'ProfileSettings.js');
    const at = src.indexOf('>Crowd alerts</span>');
    return src.slice(at, src.indexOf('<Toggle label="Crowd alerts"', at) + 200);
  };

  test('crowd alerts, account without them: unset keeps the Pro button, off says so plainly with no switch', () => {
    const row = alertsRow();
    // The entitlement check decides first, in every build.
    expect(row).toContain(`{entitlements?.paywallEnabled && !isPro ? (\n                  ${ON} ? (\n                    <button type="button" className="hit44" aria-label="Crowd alerts come with Flock Pro" onClick={() => setPaywallTrigger('settings')}`);
    // Off, that branch renders nothing where the switch would be...
    expect(row).toContain('Pro\n                    </button>\n                  ) : null\n                ) : (\n                  <Toggle label="Crowd alerts" on={crowdAlertsOn}');
    // ...and the line under the label says the alerts are not available.
    expect(row).toContain(`{entitlements?.paywallEnabled && !isPro && process.env.REACT_APP_PURCHASES === 'off' ? "Crowd alerts aren't available on this account" : "A heads up before your flock's venue gets busy"}`);
    expect("Crowd alerts aren't available on this account").not.toMatch(/Pro|upgrade|\$\d|price|buy/i);
    // Exactly one switch, reached only when the account gets the alerts.
    expect(row.split('<Toggle ').length - 1).toBe(1);
  });

  // The deletion sheet's subscription note, from its comment to the inputs.
  const deletionNote = () => {
    const src = read('screens', 'ProfileSettings.js');
    const at = src.indexOf('{/* Only once there is a subscription to speak of;');
    return src.slice(at, src.indexOf('{/* Both inputs below close the keyboard on Return', at));
  };
  const NEUTRAL_NOTE = 'Deleting your account does not cancel a subscription paid through the App Store. Cancel it first in the Settings app: tap your name, then Subscriptions.';

  test('deletion, unset, on the web: the note is exactly as before, shown with the paywall on or to a subscriber', () => {
    const note = deletionNote();
    expect(note).toContain(`{${ON} ? (isNativeShell() ? (`);
    expect(note).toContain(`)) : ((entitlements?.paywallEnabled || isPro) && (\n                  <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>Flock Pro bought on flockcorp.com is cancelled when you delete your account. Flock Pro bought in the App Store is not: cancel it first in your Apple ID settings, under Subscriptions.</p>`);
  });

  test('deletion, unset, in the app: a warning true of both stores, to the same accounts the off build warns', () => {
    // deletionNoteInApp.test.js renders every state; this pins the shape.
    const note = deletionNote();
    expect(note).toContain(`{${ON} ? (isNativeShell() ? ((isPro || entitlementsUnknown) && (\n                  <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>Deleting your account does not cancel Flock Pro bought in the App Store. It keeps renewing until you cancel it in your Apple ID settings, under Subscriptions. If Flock bills you directly, your subscription is cancelled with the account.</p>`);
  });

  test('deletion, off: a subscriber still gets the App Store warning and how to cancel, with nothing sold', () => {
    const note = deletionNote();
    expect(note).toContain(`)) : ((isPro || entitlementsUnknown) && (\n                  <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>${NEUTRAL_NOTE}</p>\n                ))}`);
    expect(NEUTRAL_NOTE).not.toMatch(/Pro|flockcorp|\$\d|price|buy|http/i);
    expect(NEUTRAL_NOTE).toMatch(/does not cancel a subscription paid through the App Store/);
    expect(NEUTRAL_NOTE).toMatch(/Settings app: tap your name, then Subscriptions/);
  });

  test('deletion, off: an account whose entitlement read failed is warned too, since it may be paying', () => {
    const app = read('App.js');
    // Unknown means no answer from the server, which is also what a failed
    // read leaves behind: refreshEntitlements swallows the error and the
    // snapshot stays null, so isPro reads false for a real subscriber.
    expect(app).toContain("const entitlementsUnknown = typeof entitlements?.isPremium !== 'boolean';");
    expect(app).toContain('getEntitlements().then((data) => applyEntitlements(seq, data)).catch(() => {});');
    expect(app).toMatch(/\n {10}entitlements,\n {10}entitlementsUnknown,\n/);
    expect(read('screens', 'ProfileSettings.js')).toMatch(/\n {2}entitlements,\n {2}entitlementsUnknown,\n/);
    // The rule, for each state the snapshot can be in.
    const unknown = (entitlements) => typeof entitlements?.isPremium !== 'boolean';
    expect(unknown(null)).toBe(true);
    expect(unknown(undefined)).toBe(true);
    expect(unknown({ error: 'Server error' })).toBe(true);
    expect(unknown({ isPremium: false, paywallEnabled: false })).toBe(false);
    expect(unknown({ isPremium: true })).toBe(false);
    // The web keeps its own condition, unchanged.
    expect(deletionNote()).toContain(`)) : ((entitlements?.paywallEnabled || isPro) && (`);
  });

  test('deletion refused over billing: off shows neutral wording from the code, unset shows the server sentence', () => {
    const settings = read('screens', 'ProfileSettings.js');
    expect(settings).toContain("} else if (process.env.REACT_APP_PURCHASES === 'off' && DELETE_BILLING_NEUTRAL[err?.code]) {\n                          setDeleteError(DELETE_BILLING_NEUTRAL[err.code]);\n                        } else {\n                          setDeleteError(err.message || 'Could not delete account. Try again.');");
    const { DELETE_BILLING_NEUTRAL } = require('../screens/ProfileSettings');
    expect(Object.keys(DELETE_BILLING_NEUTRAL).sort()).toEqual(['SUBSCRIPTION_CANCELLED_ACCOUNT_KEPT', 'SUBSCRIPTION_NOT_CANCELLED', 'SUBSCRIPTION_PARTLY_CANCELLED']);
    for (const text of Object.values(DELETE_BILLING_NEUTRAL)) {
      expect(text).not.toMatch(/Pro\b|Roost|flockcorp|\$\d|price|buy|http|—/i);
    }
    // What each still tells the person: whether the account is gone, and
    // whether a subscription is still running.
    expect(DELETE_BILLING_NEUTRAL.SUBSCRIPTION_NOT_CANCELLED).toMatch(/account was not deleted/);
    expect(DELETE_BILLING_NEUTRAL.SUBSCRIPTION_NOT_CANCELLED).toMatch(/could not be cancelled just now and is still active/);
    expect(DELETE_BILLING_NEUTRAL.SUBSCRIPTION_CANCELLED_ACCOUNT_KEPT).toMatch(/subscription was cancelled/);
    expect(DELETE_BILLING_NEUTRAL.SUBSCRIPTION_CANCELLED_ACCOUNT_KEPT).toMatch(/account could not be deleted/);
    // Something was cancelled and something is still on: both are said.
    expect(DELETE_BILLING_NEUTRAL.SUBSCRIPTION_PARTLY_CANCELLED).toMatch(/account was not deleted/);
    expect(DELETE_BILLING_NEUTRAL.SUBSCRIPTION_PARTLY_CANCELLED).toMatch(/billing was cancelled/);
    expect(DELETE_BILLING_NEUTRAL.SUBSCRIPTION_PARTLY_CANCELLED).toMatch(/is still active/);
    // Every code the server sends has wording here, and every sentence on the
    // deletion route that names a plan carries a code.
    const users = readRepo('backend', 'routes', 'users.js');
    const codes = new Set((users.match(/code: 'SUBSCRIPTION_[A-Z_]+'/g) || []).map((m) => m.slice(7, -1)));
    expect([...codes].sort()).toEqual(Object.keys(DELETE_BILLING_NEUTRAL).sort());
    const start = users.indexOf('const stripeCustomer = await stripeCustomerIdFor(req.user.id);');
    const route = users.slice(start, users.indexOf('client.release();', start));
    const refusals = route.split('\n').filter((l) => /\.json\(\{ error: .*(Flock Pro|Roost)/.test(l));
    expect(refusals).toHaveLength(6);
    for (const line of refusals) expect(line).toMatch(/, code: 'SUBSCRIPTION_[A-Z_]+' \}\);$/);
    expect(route).toContain("? 'Your Flock Pro web subscription was cancelled, but the account could not be deleted just now. Please try again in a minute.'");
    expect(route).toContain("? 'Your Roost subscription was cancelled, but the account could not be deleted just now. Please try again in a minute.'");
    expect(route).toContain("...(!appleRevoked && (stripeClosed || roostCancelled) ? { code: 'SUBSCRIPTION_CANCELLED_ACCOUNT_KEPT' } : {}),");
  });
});

describe('the venue dashboard', () => {
  test('the verification line drops the Roost upsell only when off', () => {
    const { verificationLine } = require('../screens/VenueDashboard');
    setFlag(undefined);
    expect(verificationLine({ verified: true, onRoost: false })).toMatch(/Your own forecast comes with Roost\.$/);
    setFlag('off');
    const line = verificationLine({ verified: true, onRoost: false });
    expect(line).not.toMatch(/Roost/);
    expect(line).toBe('Replies to reviews, your live number and deals on your venue card are on.');
    // A Roost venue's line never offered anything, and is the same both ways.
    expect(verificationLine({ verified: true, onRoost: true })).toMatch(/your own forecast are on\.$/);
  });

  test('plan badge, plans sheet, upgrade buttons, prices and Subscription card are gated', () => {
    const src = read('screens', 'VenueDashboard.js');
    expect(src).toContain(`{venueBillingOn && ${ON} && (`);
    // The flag leads, so an off build drops these; `!native` keeps them out
    // of the app with purchases on (roostNotSoldInApp.test.js renders both).
    expect(src).toContain(`{showUpgradeModal && ${ON} && !native && (`);
    expect(src).toContain(`{${ON} && !native && <button className="hit44" onClick={() => setShowUpgradeModal(true)}`);
    expect(src).toContain(`{${ON} && !native ? (<>\n        <p style={{ fontSize: 'var(--t-micro)', color: 'var(--accent-purple-text)', fontWeight: '700', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Requires Roost`);
    expect(src).toContain('This is not turned on for your venue.');
    const card = src.indexOf('{Icons.creditCard(colors.navy, 14)} Subscription</h3>');
    expect(src.slice(card - 400, card)).toContain(`{${ON} && (`);
    // Four buttons open the plans sheet: the locked tab's and the events
    // feed's (both gated above) and two inside the Subscription card. A fifth
    // is a new one to gate.
    const openers = src.split('setShowUpgradeModal(true)').length - 1;
    expect(openers).toBe(4);
  });

  test('a plan refusal on the cards or a typed question names no plan when off', () => {
    // The app with purchases on says the same (roostNotSoldInApp.test.js).
    const cards = read('components', 'VenueInsightCards.js');
    expect(cards).toContain("setLockedReason(process.env.REACT_APP_PURCHASES !== 'off' && !isNativeShell()\n          ? (err?.data?.error || `${FEATURE_NAME} is the paid venue plan.`)\n          : 'Not turned on for your venue.');");
    const chat = read('components', 'VenueAdvisorChat.js');
    expect(chat).toContain("setLockedReason(process.env.REACT_APP_PURCHASES !== 'off' && !isNativeShell()\n          ? (err?.data?.error || 'This is part of Roost.')\n          : 'This is not turned on for your venue.');");
    expect(chat).toContain("const said = planRefusal && (process.env.REACT_APP_PURCHASES === 'off' || isNativeShell())\n        ? 'This is not turned on for your venue.'");
    expect(chat).toContain("err?.data?.code === 'UPGRADE_REQUIRED'");
    expect(readRepo('backend', 'services', 'venueEntitlements.js')).toContain("code: 'UPGRADE_REQUIRED',");
  });

  test('the fallback venue price is gone when off', () => {
    const app = read('App.js');
    expect(app).toContain(`${ON} && !isNativeShell() && VENUE_PLAN_PRICE[tier] ? \`$\${VENUE_PLAN_PRICE[tier]}/\${per}\` : null;`);
  });
});

describe('App.js', () => {
  const app = read('App.js');

  test('the Pro sheet is neither built nor mounted', () => {
    expect(app).toContain("const loadPaywallSheet = process.env.REACT_APP_PURCHASES === 'off'\n  ? () => Promise.resolve({ default: () => null })\n  : () => import('./components/PaywallSheet')");
    expect(app).toContain(`{paywallTrigger && ${ON} && (`);
  });

  test('UPGRADE_REQUIRED from Birdie states the limit, with no offer and no sheet, when off', () => {
    const at = app.indexOf("if (err?.code === 'UPGRADE_REQUIRED') {");
    const block = app.slice(at, app.indexOf("} else if (err?.code === 'CONVERSATION_TOO_LONG')", at));
    expect(block).toContain(`const limitText = ${ON}\n          ? \`that's my 10 free chirps for today. Flock Pro bumps me to 150 a day, or catch me \${back}.\`\n          : \`You've reached today's limit. Try again \${back}.\`;`);
    expect(block).toContain(`if (${ON}) setPaywallTrigger('birdie');`);
    // The neutral line names nothing that is sold.
    const neutral = /`You've reached today's limit\. Try again \$\{back\}\.`/.exec(block)[0];
    expect(neutral).not.toMatch(/Pro|upgrade|\$\d|price/i);
  });

  test('no trip back from a checkout is read', () => {
    expect(app).toContain(`let PRO_RETURN = ${ON} ? readProReturn() : null;`);
    expect(app).toContain(`let VENUE_BILLING_RETURN = ${ON} ? readVenueBillingReturn() : null;`);
    expect(app).toContain(`useEffect(() => {\n    if (!${ON}) return undefined;\n    const ret = PRO_RETURN;`);
    expect(app).toContain(`useEffect(() => {\n    if (!${ON}) return;\n    const ret = VENUE_BILLING_RETURN;`);
  });
});

describe('what Birdie is asked to leave out', () => {
  const api = jest.requireActual('../services/api');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const sentBody = async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ text: 'go at 9', venues: [] }),
      text: () => Promise.resolve('{"text":"go at 9","venues":[]}'),
    }));
    await api.sendAiChat([{ role: 'user', text: 'hi' }], null, null);
    const call = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/ai/chat'));
    return JSON.parse(call[1].body);
  };

  test('off: every Birdie turn says the build sells nothing', async () => {
    setFlag('off');
    expect((await sentBody()).purchases).toBe('off');
  });

  test('unset: the request is as before, with no purchases field', async () => {
    setFlag(undefined);
    expect('purchases' in (await sentBody())).toBe(false);
  });

  test('the field is set behind the literal gate', () => {
    expect(read('services', 'api.js')).toContain("if (process.env.REACT_APP_PURCHASES === 'off') body.purchases = 'off';");
  });
});

describe('Birdie and the venue card', () => {
  test('the Birdie limit keeps its sentence and loses its button', () => {
    const src = read('components', 'birdie', 'BirdiePanel.js');
    expect(src).toContain(`{${ON} && <button type="button" className="hit44 glass-btn glass-primary" onClick={() => setPaywallTrigger('birdie')}`);
    expect(src).toContain("You've used today's messages.");
  });

  test('a withheld forecast is stated as a limit, and every Pro offer is statically dead when off', () => {
    const src = read('components', 'venue', 'ConsumerVenueCard.js');
    expect(src).toContain(`{${ON} ? 'Crowd level is part of Flock Pro' : "You've reached this month's limit"}`);
    expect(src).toContain("You've reached this month's limit for hourly charts.");
    // Five offers (the covered dial, two best-time lines, the chart row and the
    // busiest-hours tile), each behind a condition that also needs the flag,
    // so the minifier can drop it: seven such conditions, because each
    // best-time line is gated twice (its row and its button). A new offer, or
    // a lost gate, changes one of the two counts.
    const offers = src.split("setPaywallTrigger('forecast'").length - 1;
    const gates = src.split(`locked && ${ON}`).length - 1 + src.split(`!venueOwnerView && ${ON} && (`).length - 1;
    expect(offers).toBe(5);
    expect(gates).toBe(7);
  });
});

describe('the router', () => {
  test('/pro and the landing page are not in an off build', () => {
    const index = read('index.js');
    expect(index).toContain("...(process.env.REACT_APP_PURCHASES === 'off' ? [] : [{\n    id: 'pro',");
    expect(index).toContain("const LANDING_PAGE = process.env.REACT_APP_PURCHASES === 'off' ? null : {");
    expect(index).toContain('const isMarketingRoot = !!LANDING_PAGE && !isNativeShell && !hasAppIntent');
  });
});

describe('the About page', () => {
  test('off points /about at the published page, unset keeps the full page, and nothing else bundles it', () => {
    const index = read('index.js');
    expect(index).toContain("load: process.env.REACT_APP_PURCHASES === 'off'\n      ? () => import('./website/LegalOnTheWeb').then((m) => ({ default: () => <m.default doc=\"about\" /> }))\n      : () => import('./website/AboutPage'),");
    expect(index.match(/import\('\.\/website\/AboutPage'\)/g)).toHaveLength(1);
    // Why it is gated: the full page describes the paid plans.
    expect(read('website', 'AboutPage.js')).toMatch(/Roost, the paid plan for venues/);
  });
});

describe('the legal pages', () => {
  test('/terms and /privacy carry no copy of either document when off, and the full page when unset', () => {
    const index = read('index.js');
    expect(index).toContain("load: process.env.REACT_APP_PURCHASES === 'off'\n      ? () => import('./website/LegalOnTheWeb').then((m) => ({ default: () => <m.default doc=\"privacy\" /> }))\n      : () => import('./website/PrivacyPolicy'),");
    expect(index).toContain("load: process.env.REACT_APP_PURCHASES === 'off'\n      ? () => import('./website/LegalOnTheWeb').then((m) => ({ default: () => <m.default doc=\"terms\" /> }))\n      : () => import('./website/TermsOfService'),");
    // Nothing else pulls either document into the bundle.
    const imports = (index.match(/import\('\.\/website\/(TermsOfService|PrivacyPolicy)'\)/g) || []);
    expect(imports).toHaveLength(2);
    // The Guidelines sell nothing and stay whole in every build.
    expect(read('website', 'CommunityGuidelines.js')).not.toMatch(/Flock Pro|Roost|\$\d|checkout|subscription/i);
  });

  test.each([['terms', 'Terms of Service'], ['privacy', 'Privacy Policy'], ['about', 'About Flock']])('off: /%s points at the published text and sells nothing', (doc, title) => {
    const LegalOnTheWeb = require('../website/LegalOnTheWeb').default;
    const { container } = render(<LegalOnTheWeb doc={doc} />);
    const link = screen.getByRole('link', { name: `flockcorp.com/${doc}` });
    expect(link.getAttribute('href')).toBe(`https://www.flockcorp.com/${doc}`);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain(title);
    expect(container.textContent).not.toMatch(/Pro|Roost|\$\d|price|buy|subscri/i);
  });

  test('the app\'s own legal links already open the published text', () => {
    const settings = read('screens', 'ProfileSettings.js');
    expect(settings).toContain("openExternal('https://www.flockcorp.com/terms')");
    expect(settings).toContain("openExternal('https://www.flockcorp.com/privacy')");
  });
});

describe('where the flag is set', () => {
  const yaml = readRepo('codemagic.yaml');
  const workflow = (id) => {
    const start = yaml.indexOf(`\n  ${id}:\n`);
    expect(start).toBeGreaterThan(-1);
    const next = yaml.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
    return next === -1 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
  };
  const buildLine = (block) => {
    const step = block.indexOf('- name: Build web app (root asset paths)');
    expect(step).toBeGreaterThan(-1);
    return /\n\s+script: (.*)\n/.exec(block.slice(step))[1];
  };

  test('the App Store workflow builds the web app with purchases off', () => {
    expect(buildLine(workflow('ios-capacitor'))).toBe('REACT_APP_PURCHASES=off npm run build');
  });

  test('right after that build, a step stops a build that sells Pro without the Apple key', () => {
    // codemagicShellSteps.test.js runs the step itself, with both builds.
    const block = workflow('ios-capacitor');
    const names = [...block.matchAll(/^ {6}- name: (.*)$/gm)].map((m) => m[1]);
    const at = names.indexOf('Check the RevenueCat key if this build sells Flock Pro');
    expect(at).toBeGreaterThan(-1);
    expect(names[at - 1]).toBe('Build web app (root asset paths)');
    expect(names[at + 1]).toBe('Capacitor sync iOS');
    // It decides from the bundle, by the SDK services/purchases.js imports
    // behind the flag, so the same step needs no edit when the line flips.
    expect(block).toContain('if any("@revenuecat/purchases-capacitor/" in s for s in sources):');
    expect(read('services', 'purchases.js')).toContain("await import('@revenuecat/purchases-capacitor');");
    expect(block).toContain('appl_?*) KEY_OK=1 ;;');
  });

  test('the review recording builds the same app the reviewer gets', () => {
    expect(buildLine(workflow('ios-review-recording'))).toMatch(/(^| )REACT_APP_PURCHASES=off .*npm run build$/);
  });

  test('nothing else sets it: not an env group line, not Vercel, not the env example', () => {
    expect(yaml.match(/script: .*REACT_APP_PURCHASES=off/g)).toHaveLength(2);
    expect(yaml).not.toMatch(/REACT_APP_PURCHASES:\s/);
    expect(read('..', 'vercel.json')).not.toContain('REACT_APP_PURCHASES');
    expect(read('..', '.env.example')).toMatch(/^REACT_APP_PURCHASES=$/m);
  });
});
