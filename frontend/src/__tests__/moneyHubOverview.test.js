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
//     then re-read the hub, so what the screen shows is what the server saved.
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

const BASE = {
  generatedAt: '2026-09-25T13:27:00.000Z',
  month: { label: 'September 2026', startYmd: '2026-09-01', todayYmd: '2026-09-25', daysInMonth: 30, dayOfMonth: 25, tz: 'America/New_York' },
  cache: { ttlSeconds: 300, minRefreshSeconds: 60 },
  costs: COSTS,
  expenses: EXPENSES,
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
      overview: { status: 'refused', reason: 'The key is not allowed to read this (403). The project-wide figures need a RevenueCat API v2 secret key that can read the project and its charts.' },
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
    expect(screen.getByText(/The project-wide figures need a RevenueCat API v2 secret key/)).toBeInTheDocument();
    expect(screen.getAllByText('Key cannot read this').length).toBeGreaterThan(0);
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

  test('a bill in another currency that names a code line says the code line still counts', async () => {
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, nonUsd: [{ id: 7, label: 'Example Tool, Team', amountCents: 2000, currency: 'EUR', replacesLine: 'railway' }] },
    });
    expect(screen.getByText(/Not added, because nothing here converts currencies: Example Tool, Team \(20\.00 EUR, and the code line it names still counts\)\./)).toBeInTheDocument();
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
