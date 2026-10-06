/**
 * ROOST IS SOLD ON THE WEBSITE, NEVER INSIDE THE APP, WHATEVER THE BUILD SELLS.
 *
 * The App Store build is made with REACT_APP_PURCHASES=off today, which
 * compiles every Roost price and upgrade button out of it
 * (iosBuildSellsNothing.test.js). The build that sells Flock Pro through the
 * App Store turns that flag back on, and with it the venue dashboard brought
 * back "Requires Roost · $99/mo", "Upgrade to Roost", the plans sheet with its
 * price and "Email us about Roost", and the Upgrade and See plans buttons,
 * held back only by the server's VENUE_BILLING_ENABLED. A paid plan offered
 * inside the app outside in-app purchase is an App Review 3.1.1 problem.
 *
 * So inside the native shell (lib/nativeShell.js, the answer every surface
 * that sells asks) none of those render, with purchases on or off, and on the
 * web every one of them still does. What the venue holds is still said in the
 * app, and Roost is still named where it names a feature.
 *
 * The real dashboard is rendered, with a neutral value for every prop it
 * takes, read off its own signature so this cannot fall behind the screen.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test roostNotSoldInApp --watchAll=false
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
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote: Stub, WARM_BIRD: {}, BIRDIE: {} };
});

// eslint-disable-next-line import/first
import VenueDashboard from '../screens/VenueDashboard';
// eslint-disable-next-line import/first
import { getVenueBillingStatus } from '../services/api';

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const DASH = read('screens', 'VenueDashboard.js');
const APP = read('App.js');
const ON = "(process.env.REACT_APP_PURCHASES !== 'off')";

// Every parameter the dashboard takes, read off its own signature.
const PARAMS = (() => {
  const start = DASH.indexOf('export default function VenueDashboard({');
  const block = DASH.slice(start, DASH.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'EventModal', 'MapLibreMapView', 'ModerationHiddenNotice', 'PromoModal', 'SearchInputLocal']);
const FUNCTIONS = /^(set|handle|load|open|render|retry|cancel|switch|calc|get|crowd|is|member)[A-Za-z]/;

// The fallback App.js hands the dashboard on the web. Passing the web's
// answer here means the dashboard's own gates are what keep it off screen
// inside the app; App.js's function is pinned on its own below.
const WEB_PRICE = (tier) => (tier === 'pro' ? '$99/mo' : null);

function dashboard(overrides = {}) {
  const props = {};
  for (const name of PARAMS) {
    if (COMPONENTS.has(name)) props[name] = () => null;
    else if (FUNCTIONS.test(name)) props[name] = jest.fn();
    else props[name] = undefined;
  }
  return render(
    <VenueDashboard
      {...props}
      colors={new Proxy({}, { get: () => '#2d5a87' })}
      showToast={jest.fn()}
      onLogout={jest.fn()}
      venuePlanPriceLabel={WEB_PRICE}
      venueProfileToIntake={jest.fn()}
      operatingHours={[]}
      promotions={[]}
      realIncomingFlocks={[]}
      venueEventsList={[]}
      venueInfo={{ name: 'Hoppers', address: '', phone: '' }}
      venueListErrors={{}}
      venueListLoaded={{}}
      venueOnboardingData={{}}
      venueReviewsData={{ reviews: [], stats: null }}
      venueProfile={{ business_name: 'Hoppers', verification_status: 'verified' }}
      venueBillingOn
      venueTierKnown
      venueTier="free"
      showUpgradeModal={false}
      {...overrides}
    />
  );
}

// Lets the billing status read settle, so a price that would arrive with it
// is on screen before anything is asserted about prices.
const settle = () => act(async () => {});

const FLAG_BEFORE = process.env.REACT_APP_PURCHASES;
const inTheApp = () => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }; };

beforeEach(() => {
  delete process.env.REACT_APP_PURCHASES;
  getVenueBillingStatus.mockResolvedValue(null);
});
afterEach(() => {
  if (FLAG_BEFORE === undefined) delete process.env.REACT_APP_PURCHASES;
  else process.env.REACT_APP_PURCHASES = FLAG_BEFORE;
  delete window.Capacitor;
});

describe('the locked Analytics tab', () => {
  test('on the web it names Roost with its price and offers the upgrade, as before', async () => {
    dashboard({ venueTab: 'analytics' });
    await settle();
    expect(screen.getByText(/Requires Roost/).textContent).toMatch(/^Requires Roost ·\s?\$99\/mo$/);
    expect(screen.getByRole('button', { name: 'Upgrade to Roost' })).toBeTruthy();
  });

  test('inside the app it says the tab is not on, with no price and nothing to press', async () => {
    inTheApp();
    const { container } = dashboard({ venueTab: 'analytics' });
    await settle();
    expect(screen.getByText('This is not turned on for your venue.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
    expect(container.textContent).not.toMatch(/Requires Roost|Upgrade/);
    expect(screen.queryByRole('button', { name: /Upgrade|See plans/ })).toBeNull();
    // The feature is still named for what it is.
    expect(container.textContent).toContain("Roost's cards");
    // And nothing asked the server for prices that could not be shown.
    expect(getVenueBillingStatus).not.toHaveBeenCalled();
  });
});

describe('the Subscription card on the Settings tab', () => {
  test('on the web a free venue gets Upgrade, as before', async () => {
    dashboard({ venueTab: 'settings' });
    await settle();
    expect(screen.getByText('Free Plan')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeTruthy();
  });

  test('inside the app a free venue still reads its plan, with no Upgrade', async () => {
    inTheApp();
    dashboard({ venueTab: 'settings' });
    await settle();
    expect(screen.getByText('Free Plan')).toBeTruthy();
    expect(screen.getByText('No charge. Your listing, your hours, your replies.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });

  test('on the web a Roost venue gets both the email route and See plans and pricing', async () => {
    dashboard({ venueTab: 'settings', venueTier: 'pro', venueTierReason: 'paid', venueTierSource: 'admin' });
    await settle();
    expect(screen.getByText('Roost Plan')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change or cancel this plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See plans and pricing' })).toBeTruthy();
  });

  test('inside the app a Roost venue keeps the way to change or cancel and loses the plans', async () => {
    inTheApp();
    const { container } = dashboard({ venueTab: 'settings', venueTier: 'pro', venueTierReason: 'paid', venueTierSource: 'admin' });
    await settle();
    expect(screen.getByText('Roost Plan')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change or cancel this plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'See plans and pricing' })).toBeNull();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });
});

describe('the plans sheet', () => {
  test('on the web it opens with both plans, the Roost price and the email request', async () => {
    dashboard({ venueTab: 'settings', showUpgradeModal: true });
    await settle();
    expect(screen.getByText('Venue plans')).toBeTruthy();
    expect(screen.getByText('$0/mo')).toBeTruthy();
    expect(screen.getByText('$99/mo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email us about Roost' })).toBeTruthy();
  });

  test('inside the app it never opens, even when asked to', async () => {
    inTheApp();
    const { container } = dashboard({ venueTab: 'settings', showUpgradeModal: true });
    await settle();
    expect(screen.queryByText('Venue plans')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Email us about Roost' })).toBeNull();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
    expect(getVenueBillingStatus).not.toHaveBeenCalled();
  });
});

describe('a plan refusal on the groups feed', () => {
  test('says the plan does not include it in both places, and offers plans only on the web', async () => {
    dashboard({ venueTab: 'events', venueListErrors: { incomingFlocksLocked: true } });
    await settle();
    expect(screen.getByText('Your plan does not include this list.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See plans' })).toBeTruthy();
  });

  test('inside the app the sentence stays and the button does not', async () => {
    inTheApp();
    dashboard({ venueTab: 'events', venueListErrors: { incomingFlocksLocked: true } });
    await settle();
    expect(screen.getByText('Your plan does not include this list.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'See plans' })).toBeNull();
  });
});

describe('what the app keeps saying about Roost', () => {
  test('the plan badge names what the venue holds, inside the app too', async () => {
    inTheApp();
    dashboard({ venueTab: 'settings', venueTier: 'pro' });
    await settle();
    // The header's badge: a plan's name, not a price and not a way to buy one.
    expect(screen.getByText('Roost')).toBeTruthy();
  });

  test('a build that sells nothing shows the same locked tab on the web and in the app', async () => {
    process.env.REACT_APP_PURCHASES = 'off';
    for (const native of [false, true]) {
      if (native) inTheApp();
      const { container, unmount } = dashboard({ venueTab: 'analytics' });
      // eslint-disable-next-line no-await-in-loop
      await settle();
      expect(screen.getByText('This is not turned on for your venue.')).toBeTruthy();
      expect(container.textContent).not.toMatch(/\$\s?\d|Requires Roost|Upgrade/);
      unmount();
    }
  });
});

describe('the gates are in the source, where the build can see them', () => {
  test('every opener of the plans sheet and the sheet itself ask the one native check', () => {
    expect(DASH).toContain("import { isNativeShell } from '../lib/nativeShell';");
    expect(DASH).toContain('const native = isNativeShell();');
    // The purchases flag still leads each condition, so a build made with it
    // off drops the branch and its strings, not only hides them.
    expect(DASH).toContain(`{showUpgradeModal && ${ON} && !native && (`);
    expect(DASH).toContain(`{${ON} && !native ? (<>\n        <p style={{ fontSize: 'var(--t-micro)', color: 'var(--accent-purple-text)', fontWeight: '700', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Requires Roost`);
    expect(DASH).toContain(`{${ON} && !native && <button className="hit44" onClick={() => setShowUpgradeModal(true)}`);
    expect(DASH).toContain('{!onRoost && !native && (\n                    <button className="hit44" onClick={() => setShowUpgradeModal(true)}');
    expect(DASH).toContain('{!native && (\n                      <button className="hit44" onClick={() => setShowUpgradeModal(true)}');
    // Four buttons open the sheet, each pinned above. A fifth is a new one to gate.
    expect(DASH.split('setShowUpgradeModal(true)').length - 1).toBe(4);
  });

  test("App.js's fallback price is never made inside the app", () => {
    expect(APP).toContain("import { isNativeShell } from './lib/nativeShell';");
    expect(APP).toContain(`${ON} && !isNativeShell() && VENUE_PLAN_PRICE[tier] ? \`$\${VENUE_PLAN_PRICE[tier]}/\${per}\` : null;`);
  });
});
