// ---------------------------------------------------------------------------
// THE MONEY HUB, RENDERED (the admin console's Overview tab).
//
// The server tests (backend/__tests__/moneyHub.test.js) prove the payload. This
// file proves what reaches the screen, because the failure this console has
// already had twice is a number computed, shipped and never drawn, and the
// failure a money screen must never have is a zero drawn for a source nobody
// read. So each state is rendered with a payload shaped like the real one:
//
//   * nothing connected: the words the server sent, no dollar figure for
//     revenue, and the cost half still standing;
//   * everything connected: counts, recurring revenue, this month's money,
//     promotion code redemptions, each price disagreement in words;
//   * the hub failing to load: no numbers at all;
//   * the expense list: add, stop and import go through the API client and
//     then re-read the hub, so what the screen shows is what the server saved;
//   * crowd data: BestTime's key report when it answered, "Not connected" or
//     "Could not load" with the server's reason when it did not, the plan and
//     its cap as stated by the code, the admissions used and left as not
//     reported, and the collector's rows beside them;
//   * the model: the version serving, the share within one crowd band with its
//     window and n, the goal and the gap, and under the minimum sample the
//     words "not enough observations yet" and no percentage at all.
//
// It also pins every price backend/services/statedPrices.js lists against the
// file that states it. The backend suite does the same, but a push that only
// touches the app runs this suite and not that one.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test moneyHubOverview --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor, within } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  saveAdminReconciled: jest.fn(),
  getAdminMoneyHub: jest.fn(),
  createAdminExpense: jest.fn(),
  updateAdminExpense: jest.fn(),
  deleteAdminExpense: jest.fn(),
  importAdminExpenses: jest.fn(),
}));

const api = require('../services/api');
const RevenueScreen = require('../screens/RevenueScreen').default;

const COLORS = { navy: '#1f2a44', navyBg: '#1f2a44', navyMid: '#34405c', creamDark: '#ddd', cream: '#eee', amber: '#d97706', steel: '#4a7ba7' };

function screenProps(over = {}) {
  const fn = () => jest.fn();
  return {
    adminTab: 'overview',
    avgSpend: 120,
    colors: COLORS,
    costsData: null,
    costsError: false,
    costsLoading: false,
    eventsPerVenue: 12,
    fetchCosts: fn(),
    fetchResearchLive: fn(),
    numVenues: 20,
    operatingCosts: 2000,
    researchDemoMode: false,
    researchError: false,
    researchLiveData: null,
    researchLoading: false,
    setAdminTab: fn(),
    setAvgSpend: fn(),
    setEventsPerVenue: fn(),
    setNumVenues: fn(),
    setOperatingCosts: fn(),
    setResearchDemoMode: fn(),
    setSubscriptionPrice: fn(),
    setTakeRate: fn(),
    styles: { gradientButton: {} },
    subscriptionPrice: 67,
    switchMode: fn(),
    takeRate: 2.5,
    ...over,
  };
}

const codeLines = [
  { id: 'railway', label: 'Railway (backend and Postgres)', cadence: 'monthly' },
  { id: 'domain', label: 'flockcorp.com', cadence: 'yearly' },
];

// The cost half is read from Postgres and the code, so it stands whatever the
// vendors say. Shared by both payloads.
const COSTS = {
  status: 'ok',
  reason: null,
  byKind: [
    { kind: 'infrastructure', label: 'Running the app', thisMonthCents: 18844, perMonthCents: 18844, lines: 7 },
    { kind: 'tooling', label: 'Building it', thisMonthCents: 2000, perMonthCents: 2000, lines: 1 },
    { kind: 'legal', label: 'Legal and company', thisMonthCents: 0, perMonthCents: 0, lines: 0 },
    { kind: 'other', label: 'Other', thisMonthCents: 0, perMonthCents: 0, lines: 0 },
  ],
  byCategory: [
    { category: 'Crowd data', thisMonthCents: 12800, perMonthCents: 12800, lines: 2 },
    { category: 'Developer tools', thisMonthCents: 2000, perMonthCents: 2000, lines: 1 },
  ],
  totals: { thisMonthCents: 20844, perMonthCents: 20844 },
  upcoming: [{ expenseId: 1, label: 'Example Tool, Team', on: '2026-10-16', estimated: true, amountCents: 2000, currency: 'USD', cadence: 'monthly' }],
  upcomingWindowDays: 60,
  possibleDoubles: [],
  replaced: [],
  nonUsd: [],
  undatedCodeYearly: 2,
  googleMeteredThisMonth: { photosBought: 12, photosUsd: 0 },
  reconciledReadError: null,
};

const EXPENSES = {
  status: 'ok',
  rows: [
    { id: 1, vendor: 'Example Tool', product: 'Team', category: 'Developer tools', kind: 'tooling', amountCents: 2000, currency: 'USD', cadence: 'monthly', lastChargedOn: '2026-09-16', renewsOn: null, active: true, verified: true, note: null, replacesLine: null },
  ],
  kinds: ['infrastructure', 'tooling', 'legal', 'other'],
  cadences: ['monthly', 'yearly', 'usage', 'one_time'],
  codeLines,
};

const HEALTH = {
  collector: { status: 'ok', state: 'fresh', latestAt: '2026-09-25T13:07:00.000Z', minutesSinceLatest: 20, rows24h: 3412, hours24h: 24, lastAlertOn: null, lateAfterMinutes: 150 },
  backups: { recorded: false },
};

// BestTime's key endpoint answered: the key's health and its two counters,
// under BestTime's names. The plan beside it is the code's, never BestTime's.
const CROWD_DATA = {
  besttime: {
    status: 'ok',
    asOf: '2026-09-25T13:26:00.000Z',
    cached: true,
    cachedAgeSeconds: 42,
    key: { healthy: true, status: 'OK', valid: true, active: true },
    counters: { creditsForecast: 1, creditsQuery: 1 },
    reported: [],
  },
  plan: {
    label: 'BestTime.app Pro, Package 100',
    name: 'Pro, Package 100',
    usdPerMonth: 119,
    checked: '2026-09-01',
    newVenuesPerMonth: 100,
    cycle: 'calendar_month',
    cycleEndsOn: '2026-09-30',
    resetsOn: '2026-10-01',
    source: 'backend/services/costModel.js',
  },
};

// 261 of 412 venue-hours within one band, over 26 days, out of 1,280 serves.
const MODEL = {
  version: { status: 'ok', value: '2.6.0-starling', source: 'loaded', loaded: true },
  accuracy: {
    status: 'ok',
    asOf: '2026-09-25T13:10:00.000Z',
    cached: true,
    cachedAgeSeconds: 1020,
    windowDays: 30,
    served: 1280,
    matched: 412,
    days: 26,
    enough: true,
    minSample: 100,
    minDays: 5,
    withinOneBand: 261,
    percent: 63.3,
    versions: ['2.6.0-starling'],
  },
  goal: { percent: 85, metric: 'within_one_band' },
  gapPoints: 21.7,
  bands: [
    { label: 'Quiet', upTo: 20 },
    { label: 'Not Busy', upTo: 39 },
    { label: 'Steady', upTo: 69 },
    { label: 'Busy', upTo: 84 },
    { label: 'Packed', upTo: null },
  ],
  cache: { ttlSeconds: 3600 },
};

const BASE = {
  generatedAt: '2026-09-25T13:27:00.000Z',
  month: { label: 'September 2026', startYmd: '2026-09-01', todayYmd: '2026-09-25', daysInMonth: 30, dayOfMonth: 25, tz: 'America/New_York' },
  cache: { ttlSeconds: 300, minRefreshSeconds: 60 },
  costs: COSTS,
  expenses: EXPENSES,
  crowdData: CROWD_DATA,
  model: MODEL,
  health: HEALTH,
};

const NOT_CONNECTED = {
  ...BASE,
  revenue: {
    stripe: { status: 'not_connected', reason: 'STRIPE_SECRET_KEY is not set on the server, so nothing here can read Stripe.', cached: false },
    revenuecat: { status: 'not_connected', reason: 'REVENUECAT_SECRET_API_KEY is not set on the server, so nothing here can read RevenueCat.' },
    database: { status: 'ok', proAccounts: 1, proAccountsCheckedWithRevenueCat: 1, proAccountsWithWebSubscription: null, payingVenues: 0 },
    flags: { paywallEnabled: false, venueBillingEnabled: false, proWebCheckoutEnabled: false },
  },
  net: {
    revenueThisMonthCents: null,
    revenueParts: { stripeNetCents: null, appStoreNetCents: null },
    revenueMissing: ['stripe', 'app_store'],
    appStoreFrom: 'current_pro_accounts',
    costsThisMonthCents: 20844,
    costsMissing: [],
    netThisMonthCents: null,
    netMissing: ['stripe', 'app_store'],
    burnCents: 20844,
    recurringNetCents: null,
    recurringMissing: ['stripe', 'app_store'],
    netBurnCents: null,
    netBurnMissing: ['stripe', 'app_store'],
    appleCommissionPct: 30,
    breakEven: {
      proWeb: { priceCents: 399, source: 'stated', netPerUnitCents: 355, needed: 59 },
      proAppStore: { priceCents: 399, source: 'stated', netPerUnitCents: 279, needed: 75 },
      roost: { priceCents: 9900, source: 'stated', netPerUnitCents: 9514, needed: 3 },
      burnMissing: [],
      payingPro: null,
      payingProMissing: ['stripe', 'app_store'],
      payingRoost: null,
      payingRoostMissing: ['stripe'],
    },
  },
  pricing: {
    stated: [
      { id: 'pro-monthly-paywall-doc', product: 'pro', productLabel: 'Flock Pro', plan: 'monthly', statedCents: 399, file: 'PAYWALL.md', what: 'the settled Flock Pro prices', kind: 'doc', verdict: 'unchecked', words: 'Stripe is not connected, so this price cannot be checked.' },
    ],
    internal: [],
    unreferenced: [],
    appStore: [{ productId: 'flock_pro_monthly', plan: 'monthly', statedCents: 399, listCents: null, lastChargedCents: null, verdict: 'unchecked', words: 'RevenueCat is not connected, so the App Store price cannot be read here.' }],
    offering: { status: 'unavailable', identifier: null, findings: [] },
    mismatches: 0,
    paywallNote: 'The paywall reads its prices from the store at run time: from Stripe on the web, and from the App Store through RevenueCat in the iOS app. No Pro price is typed into it.',
  },
};

const summary = (over = {}) => ({
  live: 0, pastDue: 0, trialing: 0, unpaid: 0, endingAtPeriodEnd: 0, freeViaCode: 0, notPriced: 0, mrrCents: 0, mrrNetCents: 0,
  byPlan: { monthly: { live: 0, trialing: 0, mrrCents: 0 }, yearly: { live: 0, trialing: 0, mrrCents: 0 }, founding: { live: 0, trialing: 0, mrrCents: 0 }, other: { live: 0, trialing: 0, mrrCents: 0 } },
  ...over,
});

const CONNECTED = {
  ...BASE,
  revenue: {
    stripe: {
      status: 'ok',
      mode: 'live',
      asOf: '2026-09-25T13:26:00.000Z',
      cached: true,
      cachedAgeSeconds: 42,
      subscriptions: {
        status: 'ok',
        pro: summary({ live: 2, freeViaCode: 1, mrrCents: 399, mrrNetCents: 355, byPlan: { monthly: { live: 2, trialing: 0, mrrCents: 399 }, yearly: { live: 0, trialing: 1, mrrCents: 0 }, founding: { live: 0, trialing: 0, mrrCents: 0 }, other: { live: 0, trialing: 0, mrrCents: 0 } }, trialing: 1 }),
        roost: summary(),
        other: summary(),
        truncated: false,
        webProAccountCount: 3,
      },
      balance: { status: 'ok', grossCents: 99399, refundsCents: -399, disputesCents: -399, feesCents: 4473, otherCents: 0, otherCategories: [], charges: 2, refunds: 1, nonUsd: 0, netCents: 94128, truncated: false },
      invoices: { status: 'ok', byProduct: { pro: { paidCents: 399, invoices: 2, zeroInvoices: 1 }, roost: { paidCents: 99000, invoices: 1, zeroInvoices: 0 }, other: { paidCents: 0, invoices: 0, zeroInvoices: 0 } }, nonUsd: 0, truncated: false, lookbackDays: 70 },
      disputes: { status: 'ok', open: 1, openAmountCents: 399, openOtherCurrency: 1, truncated: false },
      promotionCodes: { status: 'ok', codes: [{ code: 'FLOCKFRIENDS', active: true, timesRedeemed: 3, maxRedemptions: null, expiresAt: null, coupon: { percentOff: 100, amountOffCents: null, currency: null, duration: 'forever', durationInMonths: null } }] },
      prices: {
        status: 'ok',
        live: [
          { id: 'price_pro_m', productName: 'Flock Pro', unitAmountCents: 399, currency: 'USD', interval: 'month', intervalCount: 1, lookupKey: null, nickname: null, active: true, env: 'STRIPE_PRICE_PRO_MONTHLY', product: 'pro', plan: 'monthly' },
          { id: 'price_old', productName: 'Flock Pro', unitAmountCents: 499, currency: 'USD', interval: 'month', intervalCount: 1, lookupKey: null, nickname: 'old', active: true, env: null, product: null, plan: null },
        ],
        envs: [],
        truncated: false,
      },
    },
    revenuecat: {
      status: 'ok',
      asOf: '2026-09-25T13:26:00.000Z',
      overview: { status: 'refused', reason: 'The key is not allowed to read this (403). REVENUECAT_V2_SECRET_API_KEY must be a RevenueCat API v2 secret key with read access to charts and metrics and to project configuration.' },
      subscribers: {
        status: 'ok', checked: 3, failed: 0, capped: false, complete: true, sandbox: 1, premiumWithNothingLive: 0,
        appStorePrices: { flock_pro_monthly: { amountCents: 399, currency: 'USD', purchasedAt: '2026-09-20T12:00:00.000Z', distinctAmountsCents: [399] } },
        stores: {
          app_store: { live: 1, trialing: 0, unpriced: 0, mrrCents: 399, monthChargedCents: 399, byPlan: { monthly: { live: 1, trialing: 0 }, yearly: { live: 0, trialing: 0 }, other: { live: 0, trialing: 0 } } },
          stripe: { live: 1, trialing: 0, unpriced: 1, mrrCents: 0, monthChargedCents: 0, byPlan: { monthly: { live: 1, trialing: 0 }, yearly: { live: 0, trialing: 0 }, other: { live: 0, trialing: 0 } } },
        },
      },
    },
    database: { status: 'ok', proAccounts: 3, proAccountsCheckedWithRevenueCat: 3, proAccountsWithWebSubscription: 2, payingVenues: 0 },
    flags: { paywallEnabled: false, venueBillingEnabled: false, proWebCheckoutEnabled: true },
  },
  net: {
    revenueThisMonthCents: 94407,
    revenueParts: { stripeNetCents: 94128, appStoreNetCents: 279 },
    revenueMissing: [],
    appStoreFrom: 'current_pro_accounts',
    costsThisMonthCents: 20844,
    costsMissing: [],
    netThisMonthCents: 73563,
    netMissing: [],
    burnCents: 20844,
    recurringNetCents: 634,
    recurringMissing: [],
    netBurnCents: 20210,
    netBurnMissing: [],
    appleCommissionPct: 30,
    breakEven: {
      proWeb: { priceCents: 399, source: 'stripe', netPerUnitCents: 355, needed: 59 },
      proAppStore: { priceCents: 399, source: 'stripe', netPerUnitCents: 279, needed: 75 },
      roost: { priceCents: 10900, source: 'stripe', netPerUnitCents: 10478, needed: 2 },
      burnMissing: [],
      payingPro: 2,
      payingProMissing: [],
      payingRoost: 0,
      payingRoostMissing: [],
    },
  },
  pricing: {
    stated: [
      { id: 'roost-monthly-terms', product: 'roost', productLabel: 'Roost', plan: 'monthly', statedCents: 9900, file: 'frontend/src/website/TermsOfService.js', what: 'Terms 9.6, the published venue price', kind: 'legal', verdict: 'mismatch', env: 'STRIPE_PRICE_ROOST_MONTHLY', liveCents: 10900, priceId: 'price_roost_m', words: 'Roost monthly: Stripe charges $109 and frontend/src/website/TermsOfService.js says $99.' },
      { id: 'pro-monthly-paywall-doc', product: 'pro', productLabel: 'Flock Pro', plan: 'monthly', statedCents: 399, file: 'PAYWALL.md', what: 'the settled Flock Pro prices', kind: 'doc', verdict: 'match', env: 'STRIPE_PRICE_PRO_MONTHLY', liveCents: 399, priceId: 'price_pro_m', words: 'Matches Stripe (STRIPE_PRICE_PRO_MONTHLY).' },
    ],
    internal: [],
    unreferenced: [{ id: 'price_old', productName: 'Flock Pro', unitAmountCents: 499, currency: 'USD', interval: 'month', lookupKey: null }],
    appStore: [{ productId: 'flock_pro_monthly', plan: 'monthly', statedCents: 399, listCents: null, lastChargedCents: 399, verdict: 'match', words: 'The last App Store purchase charged the same price.' }],
    offering: { status: 'unavailable', identifier: null, findings: [], reason: 'The key is not allowed to read this (403).' },
    mismatches: 1,
    paywallNote: 'The paywall reads its prices from the store at run time: from Stripe on the web, and from the App Store through RevenueCat in the iOS app. No Pro price is typed into it.',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

async function renderHub(payload, over) {
  api.getAdminMoneyHub.mockResolvedValue(payload);
  const utils = render(React.createElement(RevenueScreen, screenProps(over)));
  await screen.findByText('September 2026');
  return utils;
}

// One ruled row of the hub, label, value and note together, found by its label.
const hubRow = (label) => screen.getByText(label).parentElement.parentElement;

describe('the console opens on the hub', () => {
  test('four tabs, Overview first, and an unknown or old tab id lands on the hub', async () => {
    await renderHub(NOT_CONNECTED, { adminTab: 'revenue' });
    const tabs = screen.getAllByRole('button', { pressed: true });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent('Overview');
    for (const label of ['Overview', 'Costs', 'Projections', 'Research']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Revenue' })).toBeNull();
    expect(api.getAdminMoneyHub).toHaveBeenCalledTimes(1);
  });

  test('the simulator now sits under Projections, labelled as a what-if', () => {
    api.getAdminMoneyHub.mockResolvedValue(NOT_CONNECTED);
    render(React.createElement(RevenueScreen, screenProps({ adminTab: 'projections' })));
    expect(screen.getByText('What-if simulator')).toBeInTheDocument();
    expect(screen.getByLabelText('Number of Venues')).toBeInTheDocument();
    expect(screen.getByText(/Arithmetic on the numbers you typed, not measurements\./)).toBeInTheDocument();
    expect(api.getAdminMoneyHub).not.toHaveBeenCalled();
  });
});

describe('nothing connected: words, not zeros', () => {
  test('revenue says why it is missing and prints no dollar figure', async () => {
    await renderHub(NOT_CONNECTED);
    expect(screen.getAllByText(/STRIPE_SECRET_KEY is not set on the server/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/REVENUECAT_SECRET_API_KEY is not set on the server/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0);
    // Each empty figure names what it waits for: the net only on Stripe, since
    // the App Store alone never empties it; the burn after recurring revenue
    // on both stores, since subscribers pay in both.
    expect(within(hubRow('Net this month')).getByText('Needs Stripe')).toBeInTheDocument();
    expect(within(hubRow('Burn after recurring revenue')).getByText('Needs Stripe and RevenueCat')).toBeInTheDocument();
    expect(hubRow('Break-even, Flock Pro').textContent).toMatch(/Paying now: not known, waiting on Stripe and RevenueCat\./);
    expect(hubRow('Break-even, Roost').textContent).toMatch(/Paying now: not known, waiting on Stripe\./);
    // The one thing a money screen must never do: a revenue figure for a
    // source nobody read. The cost table's real zeros elsewhere are fine.
    const revenueBlock = screen.getByText('Revenue this month').parentElement;
    expect(within(revenueBlock).getByText('Not read')).toBeInTheDocument();
    expect(revenueBlock.textContent).not.toMatch(/\$/);
    expect(screen.queryByText(/FLOCKFRIENDS/)).toBeNull();
    expect(screen.queryByText('Web recurring revenue')).toBeNull();
  });

  test('the cost half stands, because it never needed a vendor', async () => {
    await renderHub(NOT_CONNECTED);
    expect(screen.getAllByText('$208.44').length).toBeGreaterThan(0);
    expect(screen.getByText('Running the app')).toBeInTheDocument();
    expect(screen.getByText('Building it')).toBeInTheDocument();
    expect(screen.getAllByText(/the price the code states, because Stripe was not read/)).toHaveLength(2);
    expect(screen.getByText('Not checked against Stripe')).toBeInTheDocument();
  });

  test('backups are named as unrecorded rather than given a status', async () => {
    await renderHub(NOT_CONNECTED);
    expect(screen.getByText('Not recorded here')).toBeInTheDocument();
    expect(screen.getByText(/Nothing in this database records a backup or a restore point/)).toBeInTheDocument();
  });
});

describe('everything connected: the numbers, each with its source', () => {
  test('this month, net, burn and break-even', async () => {
    await renderHub(CONNECTED);
    expect(screen.getByText('$944.07')).toBeInTheDocument();
    expect(screen.getByText('+$735.63')).toBeInTheDocument();
    expect(screen.getByText('59 web, 75 App Store')).toBeInTheDocument();
    expect(screen.getByText('2 venues')).toBeInTheDocument();
    expect(screen.getAllByText(/the price Stripe charges/)).toHaveLength(2);
    expect(screen.getByText(/this one is 42 seconds old/)).toBeInTheDocument();
  });

  test('Pro on the web: plans, the free code, and recurring revenue after fees', async () => {
    await renderHub(CONNECTED);
    expect(screen.getByText('Web, monthly')).toBeInTheDocument();
    expect(screen.getByText('On a free code')).toBeInTheDocument();
    expect(screen.getByText('Web recurring revenue')).toBeInTheDocument();
    expect(screen.getAllByText('$3.99 a month').length).toBeGreaterThan(0);
    expect(screen.getByText(/\$47\.88 a year as annual recurring revenue\. \$3\.55 a month after Stripe fees\./)).toBeInTheDocument();
    expect(screen.getByText(/1 more on a trial, not yet paying\./)).toBeInTheDocument();
  });

  test('the App Store comes from RevenueCat, and a key without v2 access says so', async () => {
    await renderHub(CONNECTED);
    expect(screen.getByText('App Store, monthly')).toBeInTheDocument();
    expect(screen.getByText('Sandbox')).toBeInTheDocument();
    expect(screen.getByText(/REVENUECAT_V2_SECRET_API_KEY must be a RevenueCat API v2 secret key/)).toBeInTheDocument();
    expect(screen.getAllByText('Key cannot read this').length).toBeGreaterThan(0);
  });

  test('with no v2 key, the project figures and the offering say not connected, not refused', async () => {
    const unset = "REVENUECAT_V2_SECRET_API_KEY is not set, so RevenueCat's project-wide figures and the offering are not read.";
    await renderHub({
      ...CONNECTED,
      revenue: { ...CONNECTED.revenue, revenuecat: { ...CONNECTED.revenue.revenuecat, overview: { status: 'not_connected', reason: unset } } },
      pricing: { ...CONNECTED.pricing, offering: { status: 'not_connected', identifier: null, findings: [], reason: unset } },
    });
    expect(screen.getAllByText(/REVENUECAT_V2_SECRET_API_KEY is not set/).length).toBe(2);
    expect(screen.getAllByText('Not connected').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Key cannot read this')).not.toBeInTheDocument();
  });

  test('the App Store part is labelled as current Pro accounts only, never as the whole month', async () => {
    // It is read from the accounts that are Pro now, so a subscriber who paid
    // through Apple this month and then deleted their account is not in it.
    await renderHub(CONNECTED);
    const revenueBlock = screen.getByText('Revenue this month').parentElement;
    expect(revenueBlock.textContent).toMatch(/plus App Store charges after Apple's 30%\. The App Store part counts current Pro accounts only: a subscriber who deleted their account is not in it\./);
    expect(hubRow('App Store charged this month').textContent).toMatch(/Counted from current Pro accounts only: a subscriber who deleted their account is not in it\./);
    expect(hubRow('App Store recurring revenue').textContent).toMatch(/Counted from current Pro accounts only/);
  });

  test('collected this month, disputes and promotion codes', async () => {
    await renderHub(CONNECTED);
    expect(screen.getByText('$993.99')).toBeInTheDocument();
    expect(screen.getByText('−$44.73')).toBeInTheDocument();
    expect(screen.getByText('$941.28')).toBeInTheDocument();
    // One dispute in dollars and one in another currency: both are counted,
    // only the dollar one is summed, and the row says so.
    const disputes = hubRow('Open disputes');
    expect(within(disputes).getByText('2')).toBeInTheDocument();
    expect(disputes.textContent).toMatch(/\$3\.99 at stake in dollars\. 1 more is in another currency and not added\./);
    // Paid invoices come from a list Stripe filters by the day an invoice was
    // made, so the window it reads back is stated rather than implied.
    expect(screen.getByText(/from invoices created up to 70 days before the month began/)).toBeInTheDocument();
    expect(screen.getByText('FLOCKFRIENDS')).toBeInTheDocument();
    expect(screen.getByText('3 used')).toBeInTheDocument();
    expect(screen.getByText(/100% off for as long as they subscribe\./)).toBeInTheDocument();
  });

  test('a price disagreement is a sentence with both amounts, and an unused live price is named', async () => {
    await renderHub(CONNECTED);
    expect(screen.getByText('1 disagreement to fix')).toBeInTheDocument();
    expect(screen.getByText(/Stripe charges \$109 and frontend\/src\/website\/TermsOfService\.js says \$99\./)).toBeInTheDocument();
    expect(screen.getAllByText('Disagrees').length).toBeGreaterThan(0);
    expect(screen.getByText('Unused')).toBeInTheDocument();
    expect(screen.getByText(/no price variable points at it, so the app never sells it/)).toBeInTheDocument();
  });

  test('the collector is read from its own rows', async () => {
    await renderHub(CONNECTED);
    expect(screen.getByText('Landing')).toBeInTheDocument();
    expect(screen.getByText(/3,412 rows across 24 hours of the last day/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A PARTIAL READ. The server leaves a figure null when a source behind it was
// read only in part, rather than send a smaller number that looks whole. These
// pin that the screen draws each such figure as waiting on a named source, and
// never as a total.
// ---------------------------------------------------------------------------
describe('a partial read empties the figures it would shrink', () => {
  test('an unreadable expense list leaves costs, net, burn and break-even unstated', async () => {
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, status: 'error', reason: 'The expense list could not be read, so only the code lines and the reconciled invoice are counted.' },
      expenses: { ...EXPENSES, status: 'error', rows: [] },
      net: {
        ...CONNECTED.net,
        costsThisMonthCents: null,
        costsMissing: ['expenses'],
        netThisMonthCents: null,
        netMissing: ['expenses'],
        burnCents: null,
        netBurnCents: null,
        netBurnMissing: ['expenses'],
        breakEven: {
          ...CONNECTED.net.breakEven,
          proWeb: { ...CONNECTED.net.breakEven.proWeb, needed: null },
          proAppStore: { ...CONNECTED.net.breakEven.proAppStore, needed: null },
          roost: { ...CONNECTED.net.breakEven.roost, needed: null },
          burnMissing: ['expenses'],
        },
      },
    });
    const costsBlock = screen.getByText('Costs this month').parentElement;
    expect(within(costsBlock).getByText('Not read')).toBeInTheDocument();
    expect(costsBlock.textContent).not.toMatch(/\$/);
    expect(costsBlock.textContent).toMatch(/The expense list could not be read, so costs are not totalled here\./);
    expect(within(hubRow('Net this month')).getByText('Needs the expense list')).toBeInTheDocument();
    expect(within(hubRow('Burn a month')).getByText('Not read')).toBeInTheDocument();
    expect(within(hubRow('Burn after recurring revenue')).getByText('Needs the expense list')).toBeInTheDocument();
    expect(within(hubRow('Break-even, Flock Pro')).getByText('Not read')).toBeInTheDocument();
    expect(within(hubRow('Break-even, Roost')).getByText('Not read')).toBeInTheDocument();
    expect(hubRow('Break-even, Flock Pro').textContent).toMatch(/The expense list could not be read\./);
    // Revenue never needed the list, so it still stands.
    expect(screen.getByText('$944.07')).toBeInTheDocument();
    // The Costs card says what it could read instead of passing it off as whole.
    expect(screen.getAllByText(/only the code lines and the reconciled invoice are counted/).length).toBeGreaterThan(0);
  });

  test('a Stripe balance read cut short withholds the revenue instead of showing it short', async () => {
    await renderHub({
      ...CONNECTED,
      revenue: {
        ...CONNECTED.revenue,
        stripe: { ...CONNECTED.revenue.stripe, balance: { ...CONNECTED.revenue.stripe.balance, truncated: true } },
      },
      net: {
        ...CONNECTED.net,
        revenueThisMonthCents: null,
        revenueParts: { stripeNetCents: null, appStoreNetCents: 279 },
        revenueMissing: ['stripe_partial'],
        netThisMonthCents: null,
        netMissing: ['stripe_partial'],
      },
    });
    const revenueBlock = screen.getByText('Revenue this month').parentElement;
    expect(within(revenueBlock).getByText('Withheld')).toBeInTheDocument();
    expect(revenueBlock.textContent).not.toMatch(/\$/);
    expect(revenueBlock.textContent).toMatch(/withheld rather than shown short/);
    expect(within(hubRow('Net this month')).getByText('Needs a full Stripe read')).toBeInTheDocument();
    expect(hubRow('Net this month').textContent).toMatch(/Stripe had more entries this month than the hub reads, and a missing page could move a total either way\./);
    expect(screen.getByText(/could be off in either direction\. The revenue at the top is withheld for the same reason\./)).toBeInTheDocument();
  });

  test('RevenueCat answering for only some Pro accounts keeps the App Store out of every total, and says so', async () => {
    await renderHub({
      ...CONNECTED,
      revenue: {
        ...CONNECTED.revenue,
        revenuecat: {
          ...CONNECTED.revenue.revenuecat,
          subscribers: { ...CONNECTED.revenue.revenuecat.subscribers, checked: 2, failed: 1, complete: false },
        },
      },
      net: {
        ...CONNECTED.net,
        revenueThisMonthCents: 94128,
        revenueParts: { stripeNetCents: 94128, appStoreNetCents: null },
        revenueMissing: ['app_store_partial'],
        netThisMonthCents: 73284,
        netMissing: ['app_store_partial'],
        recurringNetCents: null,
        recurringMissing: ['app_store_partial'],
        netBurnCents: null,
        netBurnMissing: ['app_store_partial'],
        breakEven: { ...CONNECTED.net.breakEven, payingPro: null, payingProMissing: ['app_store_partial'] },
      },
    });
    // Revenue and net carry Stripe alone, with the reason beside them.
    const revenueBlock = screen.getByText('Revenue this month').parentElement;
    expect(within(revenueBlock).getByText('$941.28')).toBeInTheDocument();
    expect(revenueBlock.textContent).toMatch(/Stripe, after refunds, disputes and fees\. The App Store is not in it, because RevenueCat answered for only some Pro accounts\./);
    expect(within(hubRow('Net this month')).getByText('+$732.84')).toBeInTheDocument();
    // Figures that need every subscriber in both stores wait for them.
    expect(within(hubRow('Burn after recurring revenue')).getByText('Needs every Pro account in RevenueCat')).toBeInTheDocument();
    expect(hubRow('Break-even, Flock Pro').textContent).toMatch(/Paying now: not known, waiting on every Pro account in RevenueCat\./);
    expect(hubRow('Break-even, Roost').textContent).toMatch(/Paying now: 0\./);
    expect(screen.getByText(/1 could not be read\..*These App Store figures are incomplete, so the totals at the top leave the App Store out rather than add a part of it\./)).toBeInTheDocument();
  });

  test('a live subscription with no price empties the totals it would shrink, and each figure names why', async () => {
    const rcSubs = CONNECTED.revenue.revenuecat.subscribers;
    await renderHub({
      ...CONNECTED,
      revenue: {
        ...CONNECTED.revenue,
        stripe: {
          ...CONNECTED.revenue.stripe,
          subscriptions: { ...CONNECTED.revenue.stripe.subscriptions, roost: summary({ live: 1, notPriced: 1 }) },
        },
        revenuecat: {
          ...CONNECTED.revenue.revenuecat,
          subscribers: {
            ...rcSubs,
            stores: { ...rcSubs.stores, app_store: { ...rcSubs.stores.app_store, unpriced: 1, unpricedThisMonth: 1, mrrCents: 0, monthChargedCents: 0 } },
          },
        },
      },
      net: {
        ...CONNECTED.net,
        revenueThisMonthCents: 94128,
        revenueParts: { stripeNetCents: 94128, appStoreNetCents: null },
        revenueMissing: ['app_store_unpriced'],
        netThisMonthCents: 73284,
        netMissing: ['app_store_unpriced'],
        recurringNetCents: null,
        recurringMissing: ['stripe_unpriced', 'app_store_unpriced'],
        netBurnCents: null,
        netBurnMissing: ['stripe_unpriced', 'app_store_unpriced'],
      },
    });
    // Revenue and net carry Stripe alone, with the reason beside them.
    const revenueBlock = screen.getByText('Revenue this month').parentElement;
    expect(within(revenueBlock).getByText('$941.28')).toBeInTheDocument();
    expect(revenueBlock.textContent).toMatch(/Stripe, after refunds, disputes and fees\. The App Store is not in it, because some live App Store subscriptions carry no dollar price in RevenueCat\./);
    expect(within(hubRow('Net this month')).getByText('+$732.84')).toBeInTheDocument();
    // Recurring revenue waits for a price in both stores, and says so.
    const netBurn = hubRow('Burn after recurring revenue');
    expect(within(netBurn).getByText('Needs a price for every Stripe subscription and a price for every App Store subscription')).toBeInTheDocument();
    expect(netBurn.textContent).toMatch(/Some live Stripe subscriptions carry a price or a discount this read could not work out in dollars; the App Store is not in it, because some live App Store subscriptions carry no dollar price in RevenueCat\./);
    // And the rows below say which subscriptions.
    expect(hubRow('App Store recurring revenue').textContent).toMatch(/1 subscription carries no dollar price in RevenueCat and is left out, so the recurring total at the top waits for it\./);
    expect(hubRow('App Store charged this month').textContent).toMatch(/1 of these charges has no dollar price in RevenueCat, so the revenue at the top leaves the App Store out\./);
    expect(within(hubRow('Not priced')).getByText('1')).toBeInTheDocument();
  });

  test('a bill in another currency that names a code line says the code line still counts', async () => {
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, nonUsd: [{ id: 7, label: 'Example Tool, Team', amountCents: 2000, currency: 'EUR', replacesLine: 'railway' }] },
    });
    expect(screen.getByText(/Not added, because nothing here converts currencies: Example Tool, Team \(20\.00 EUR, and the code line it names still counts\)\./)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// CROWD DATA. BestTime's key endpoint reports the key's health and two
// undocumented counters, and no plan, admission count or cycle date. So the
// card must never draw an admission count, must label the plan rows as the
// code's, and must say why it has nothing when BestTime was not read.
// ---------------------------------------------------------------------------
describe('crowd data: what BestTime says, beside the plan the code records', () => {
  const crowdCard = () => screen.getByRole('heading', { name: 'Crowd data' }).parentElement;
  const withBestTime = (besttime) => ({ ...CONNECTED, crowdData: { ...CROWD_DATA, besttime } });

  test('a working key; the plan and its cap as stated; used and left not reported; the collector beside it', async () => {
    await renderHub(CONNECTED);
    const card = crowdCard();
    expect(within(hubRow('BestTime key')).getByText('Working')).toBeInTheDocument();
    expect(hubRow('BestTime key').textContent).toMatch(/BestTime says the key is valid and active\./);
    const plan = hubRow('Plan');
    expect(within(plan).getByText('Pro, Package 100')).toBeInTheDocument();
    expect(within(plan).getByText('Stated')).toBeInTheDocument();
    expect(plan.textContent).toMatch(/does not report the plan\. This is the plan the cost model records, at \$119\.00 a month, checked Sep 1(, 2026)?\./);
    expect(within(hubRow('New venues admitted this month')).getByText('Not reported')).toBeInTheDocument();
    expect(hubRow('New venues admitted this month').textContent).toMatch(/The besttime\.app dashboard does\./);
    const cap = hubRow('Admission cap');
    expect(within(cap).getByText('100 a month')).toBeInTheDocument();
    expect(within(cap).getByText('Stated')).toBeInTheDocument();
    expect(within(hubRow('Admissions left')).getByText('Not reported')).toBeInTheDocument();
    expect(hubRow('Admissions left').textContent).toMatch(/Nothing is subtracted from a count nobody read\./);
    const cycle = hubRow('Cycle ends');
    expect(within(cycle).getByText(/Sep 30/)).toBeInTheDocument();
    expect(within(cycle).getByText('Worked out')).toBeInTheDocument();
    expect(cycle.textContent).toMatch(/starts again on Oct 1/);
    // The two counters under BestTime's names, and what they are not.
    expect(within(hubRow('Forecast credits')).getByText('1')).toBeInTheDocument();
    expect(hubRow('Forecast credits').textContent).toMatch(/credits_forecast, as BestTime reports it\..*not shown as forecasts used\./);
    expect(within(hubRow('Query credits')).getByText('1')).toBeInTheDocument();
    expect(hubRow('Query credits').textContent).toMatch(/not shown as venue searches used\./);
    // The collector's rows, the Health card's own read, beside the quota.
    const rows = hubRow('Crowd readings, last 24 hours');
    expect(within(rows).getByText('3,412')).toBeInTheDocument();
    expect(rows.textContent).toMatch(/across 24 hours\. From ml_training_data, the same read as the Health card below\./);
    expect(card.textContent).toMatch(/held for 5 minutes; this answer is 42 seconds old\. The key itself never reaches this page\./);
  });

  test('with no key it says not connected, draws no counter, and still states the plan', async () => {
    await renderHub(withBestTime({ status: 'not_connected', reason: 'BESTTIME_API_KEY is not set on the server, so nothing here can read BestTime.', cached: false, cachedAgeSeconds: 0 }));
    const card = crowdCard();
    expect(within(card).getByText('Not connected')).toBeInTheDocument();
    expect(within(card).getByText(/BESTTIME_API_KEY is not set on the server, so nothing here can read BestTime\./)).toBeInTheDocument();
    for (const label of ['BestTime key', 'Forecast credits', 'Query credits']) {
      expect(within(card).queryByText(label)).toBeNull();
    }
    expect(within(card).getByText('Pro, Package 100')).toBeInTheDocument();
    expect(within(card).getByText('100 a month')).toBeInTheDocument();
    expect(within(card).getAllByText('Not reported')).toHaveLength(2);
    expect(within(card).getByText('3,412')).toBeInTheDocument();
    expect(card.textContent).toMatch(/Nothing was read from BestTime, so no counter is shown\. The plan rows come from the code either way\./);
  });

  test('a failed read says could not load with the server\'s reason, and draws no counter', async () => {
    await renderHub(withBestTime({ status: 'error', reason: 'BestTime refused the key (403): a rejected key or account, or its guard after a burst of calls.', cached: false, cachedAgeSeconds: 0 }));
    const card = crowdCard();
    expect(within(card).getByText('Could not load')).toBeInTheDocument();
    expect(within(card).getByText(/BestTime refused the key \(403\): a rejected key or account/)).toBeInTheDocument();
    for (const text of ['BestTime key', 'Working', 'Not working', 'Forecast credits', 'Query credits']) {
      expect(within(card).queryByText(text)).toBeNull();
    }
    expect(card.textContent).toMatch(/Nothing was read from BestTime, so no counter is shown\./);
  });

  test('a key BestTime calls invalid reads as not working, and extra fields come under BestTime\'s own names', async () => {
    await renderHub(withBestTime({
      ...CROWD_DATA.besttime,
      key: { healthy: false, status: 'Error', valid: false, active: true },
      reported: [{ name: 'venues_new_remaining', value: 58 }, { name: 'subscription_ref', withheld: true }],
    }));
    const key = hubRow('BestTime key');
    expect(within(key).getByText('Not working')).toBeInTheDocument();
    expect(key.textContent).toMatch(/BestTime says status Error, valid false, active true\./);
    expect(screen.getByText('Also reported by BestTime, under its own names: venues_new_remaining 58; subscription_ref (withheld, it carried key material).')).toBeInTheDocument();
    // A count BestTime sends is shown as it sent it, and never promoted into
    // the rows above, which stay what the code can vouch for.
    expect(within(hubRow('Admissions left')).getByText('Not reported')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// THE MODEL. The share is the server's, over served model forecasts that got a
// live reading in the same venue-hour. Under the minimum sample the server
// sends no share, and the card must say so in words and print no percentage,
// even if a share arrives anyway.
// ---------------------------------------------------------------------------
describe('the model: which one is serving, and its served forecasts against the goal', () => {
  const modelCard = () => screen.getByRole('heading', { name: 'Model' }).parentElement;
  const percentsIn = (el) => el.textContent.match(/\d+(\.\d+)?%/g);
  const withModel = (over) => ({ ...CONNECTED, model: { ...MODEL, ...over } });

  test('the loaded version, the share within one band with its window and n, the goal and the gap', async () => {
    await renderHub(CONNECTED);
    const card = modelCard();
    expect(within(hubRow('Live model')).getByText('2.6.0-starling')).toBeInTheDocument();
    expect(hubRow('Live model').textContent).toMatch(/The version this server loaded, from its model_metadata\.json\./);
    expect(within(hubRow('Live model')).queryByText('Not loaded')).toBeNull();
    expect(within(card).getByText('Within one crowd band, last 30 days')).toBeInTheDocument();
    expect(within(card).getByText('63.3%')).toBeInTheDocument();
    // n and its count are held together by non-breaking spaces, so a narrow
    // screen never strands "n" at the end of a line.
    expect(card.textContent).toMatch(/of served model forecasts landed in the live reading's crowd band or the one next to it\. n = 412 venue-hours over 26 days, 261 of them within one band, from 1,280 forecasts served in the window\./);
    expect(within(hubRow('Goal')).getByText('85%')).toBeInTheDocument();
    expect(hubRow('Goal').textContent).toMatch(/Of served forecasts within one crowd band\. Not the blended training figure/);
    const gap = hubRow('Gap to goal');
    expect(within(gap).getByText('21.7 points')).toBeInTheDocument();
    expect(gap.textContent).toMatch(/The goal less the measured share, in percentage points\./);
    expect(card.textContent).toMatch(/scored on the bands the app prints: Quiet up to 20, Not Busy up to 39, Steady up to 69, Busy up to 84, Packed above\./);
    expect(card.textContent).toMatch(/held for an hour; this answer is 17 minutes old\./);
    expect(percentsIn(card)).toEqual(['63.3%', '85%']);
    expect(card.textContent).not.toMatch(/85\.1|87\.3/);
    expect(card.textContent).not.toMatch(/mixes forecasts/);
  });

  test('under the minimum it says not enough observations yet, and prints no share and no gap', async () => {
    await renderHub(withModel({
      gapPoints: null,
      accuracy: { ...MODEL.accuracy, served: 310, matched: 37, days: 3, enough: false, withinOneBand: null, percent: null },
    }));
    const card = modelCard();
    expect(within(card).getByText('Not enough observations yet')).toBeInTheDocument();
    expect(card.textContent).toMatch(/37 venue-hours over 3 days so far, from 310 forecasts served\. The share shows from 100 venue-hours across at least 5 days; below that it mostly measures chance\./);
    expect(within(hubRow('Gap to goal')).getByText('Not measured yet')).toBeInTheDocument();
    expect(hubRow('Gap to goal').textContent).toMatch(/Waits for enough observations to measure the share\./);
    // The only percentage in the card is the goal.
    expect(percentsIn(card)).toEqual(['85%']);
  });

  test('a share that arrives under the minimum is still not drawn', async () => {
    // The server withholds it; this pins the screen's own half of the rule, so
    // an older or broken server still cannot put a noisy figure on it.
    await renderHub(withModel({
      gapPoints: 72.5,
      accuracy: { ...MODEL.accuracy, served: 40, matched: 8, days: 1, enough: false, withinOneBand: 1, percent: 12.5 },
    }));
    const card = modelCard();
    expect(within(card).getByText('Not enough observations yet')).toBeInTheDocument();
    expect(within(card).queryByText('12.5%')).toBeNull();
    expect(percentsIn(card)).toEqual(['85%']);
    // Nor the gap worked from it.
    expect(within(hubRow('Gap to goal')).getByText('Not measured yet')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/72\.5/);
  });

  test('a check that failed says could not load with the reason, and prints no share and no gap', async () => {
    await renderHub(withModel({
      gapPoints: null,
      accuracy: { status: 'error', reason: "The database did not finish the check of served forecasts against the collector's readings, so there is no figure to show.", cached: false, cachedAgeSeconds: 0 },
    }));
    const card = modelCard();
    expect(within(card).getByText('Could not load')).toBeInTheDocument();
    expect(within(card).getByText(/did not finish the check of served forecasts against the collector's readings/)).toBeInTheDocument();
    expect(within(card).queryByText('Not enough observations yet')).toBeNull();
    expect(within(hubRow('Gap to goal')).getByText('Not measured yet')).toBeInTheDocument();
    expect(hubRow('Gap to goal').textContent).toMatch(/Waits for the check above to answer\./);
    expect(percentsIn(card)).toEqual(['85%']);
    // The version is its own read and still stands.
    expect(within(hubRow('Live model')).getByText('2.6.0-starling')).toBeInTheDocument();
  });

  test('an artifact that is not loaded is labelled so, and a window that mixes versions says which', async () => {
    await renderHub(withModel({
      version: { status: 'ok', value: '2.6.0-starling', source: 'artifact', loaded: false },
      accuracy: { ...MODEL.accuracy, versions: ['2.6.0-starling', '2.7.0-swift'] },
    }));
    const row = hubRow('Live model');
    expect(within(row).getByText('Not loaded')).toBeInTheDocument();
    expect(row.textContent).toMatch(/No model is loaded in this server process yet, so this is the version of the artifact on disk/);
    expect(screen.getByText('This window mixes forecasts from 2 model versions: 2.6.0-starling, 2.7.0-swift.')).toBeInTheDocument();
  });

  test('a version that could not be read says why, and a goal already met is not a negative gap', async () => {
    await renderHub(withModel({
      version: { status: 'error', value: null, source: 'artifact', loaded: false, reason: 'No model is loaded, and this server has no model_metadata.json to read a version from.' },
      gapPoints: -1.2,
      accuracy: { ...MODEL.accuracy, withinOneBand: 355, percent: 86.2 },
    }));
    const row = hubRow('Live model');
    expect(within(row).getByText('Not read')).toBeInTheDocument();
    expect(row.textContent).toMatch(/this server has no model_metadata\.json to read a version from\./);
    expect(within(hubRow('Gap to goal')).getByText('Met')).toBeInTheDocument();
    expect(hubRow('Gap to goal').textContent).not.toMatch(/−|-1\.2/);
  });
});

describe('a hub that does not load shows nothing rather than a guess', () => {
  test('no numbers, the reason, and a way to ask again', async () => {
    api.getAdminMoneyHub.mockRejectedValue(new Error('Something went wrong on our end. Try again.'));
    render(React.createElement(RevenueScreen, screenProps()));
    expect(await screen.findByText('The money hub did not load')).toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).toBeNull();
    api.getAdminMoneyHub.mockResolvedValue(NOT_CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('September 2026')).toBeInTheDocument();
  });
});

describe('the expense list writes through the API and then re-reads the hub', () => {
  test('adding a bill sends dollars and the chosen kind, then reloads', async () => {
    await renderHub(NOT_CONNECTED);
    api.createAdminExpense.mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: 'Registered Agent Co' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'legal' } });
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: 'yearly' } });
    fireEvent.change(screen.getByLabelText('Amount, dollars'), { target: { value: '49.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createAdminExpense).toHaveBeenCalledTimes(1));
    const body = api.createAdminExpense.mock.calls[0][0];
    expect(body).toMatchObject({ vendor: 'Registered Agent Co', kind: 'legal', cadence: 'yearly', amount: '49.00', currency: 'USD', active: true, product: null, replacesLine: null });
    await waitFor(() => expect(api.getAdminMoneyHub).toHaveBeenCalledTimes(2));
  });

  test('stopping a bill sends the whole row with active false', async () => {
    await renderHub(NOT_CONNECTED);
    api.updateAdminExpense.mockResolvedValue({ success: true });
    const row = screen.getByText('Example Tool, Team').closest('div').parentElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as stopped' }));
    await waitFor(() => expect(api.updateAdminExpense).toHaveBeenCalledTimes(1));
    const [id, body] = api.updateAdminExpense.mock.calls[0];
    expect(id).toBe(1);
    expect(body).toMatchObject({ vendor: 'Example Tool', product: 'Team', kind: 'tooling', amount: '20.00', cadence: 'monthly', lastChargedOn: '2026-09-16', active: false });
    await waitFor(() => expect(api.getAdminMoneyHub).toHaveBeenCalledTimes(2));
  });

  test('the import checks the paste is a list before asking the server, and shows what the server refused', async () => {
    await renderHub(NOT_CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Import a list' }));
    const box = screen.getByLabelText('Expense list to import');
    fireEvent.change(box, { target: { value: 'vendor, amount' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/That is not valid JSON/)).toBeInTheDocument();
    expect(api.importAdminExpenses).not.toHaveBeenCalled();

    const err = new Error('Row 2: vendor is required');
    err.data = { error: 'Row 2: vendor is required', errors: ['Row 2: vendor is required', 'Row 3: kind must be one of infrastructure, tooling, legal, other'] };
    api.importAdminExpenses.mockRejectedValueOnce(err);
    fireEvent.change(box, { target: { value: '[{"vendor":"A","kind":"other","cadence":"monthly","amount":1},{"kind":"other"}]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Row 2: vendor is required')).toBeInTheDocument();
    expect(screen.getByText(/Row 3: kind must be one of/)).toBeInTheDocument();

    api.importAdminExpenses.mockResolvedValueOnce({ success: true, inserted: 2, updated: 1 });
    fireEvent.change(box, { target: { value: '{"expenses":[{"vendor":"A","kind":"other","cadence":"monthly","amount":1}]}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('2 bills added and 1 updated.')).toBeInTheDocument();
    expect(api.importAdminExpenses).toHaveBeenLastCalledWith([{ vendor: 'A', kind: 'other', cadence: 'monthly', amount: 1 }]);
  });
});

describe('every price the registry lists is where it says, at the amount it says', () => {
  const REPO = path.resolve(__dirname, '..', '..', '..');
  // Pure data with no requires, written so this suite can load it directly.
  const { STATED_PRICES, STATED_TRIALS } = require(path.join(REPO, 'backend', 'services', 'statedPrices.js'));

  test.each(STATED_PRICES.map((s) => [s.id, s]))('%s', (_id, s) => {
    const file = path.join(REPO, s.file);
    // A private entry names a file the repository does not carry.
    if (s.private && !fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    const m = new RegExp(s.pattern).exec(text);
    expect(m).not.toBeNull();
    expect(Number(String(m[s.group]).replace(/,/g, ''))).toBe(s.usd);
  });

  // The Roost trial, wherever it is written down. The backend suite also holds
  // each one to the trial checkout gives (venueBilling.js TRIAL_DAYS); this
  // one catches a frontend-only push that moves one of them.
  test.each(STATED_TRIALS.map((t) => [t.id, t]))('%s', (_id, t) => {
    const text = fs.readFileSync(path.join(REPO, t.file), 'utf8');
    const m = new RegExp(t.pattern).exec(text);
    expect(m).not.toBeNull();
    expect(Number(m[t.group])).toBe(t.days);
  });

  test('every Roost trial on the list is the same length', () => {
    expect(new Set(STATED_TRIALS.map((t) => t.days)).size).toBe(1);
  });
});
