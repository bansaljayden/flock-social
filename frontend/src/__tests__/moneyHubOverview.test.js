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
//     words "not enough observations yet" and no percentage at all;
//   * the operator's own steps: done and to do in the server's words, the
//     database's network and its timed round trip (words and no number when
//     it was not timed), the fix as a command, and the steps the server
//     cannot see marked Check yourself with a link out and no claim.
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
const { render, screen, fireEvent, waitFor, within, configure } = require('@testing-library/react');

// The hub is the heaviest screen in the app, and every test here starts by
// waiting for its first render (renderHub below). Testing Library gives that
// one second, which a full pre-push run on a busy machine overshoots: three
// different tests here failed that way (2026-09-30, 10-05 twice) and each
// passed alone. Five seconds is the same check with room for load; a hub
// that never renders still fails.
configure({ asyncUtilTimeout: 5000 });

jest.mock('../services/api', () => ({
  __esModule: true,
  saveAdminReconciled: jest.fn(),
  getAdminMoneyHub: jest.fn(),
  createAdminExpense: jest.fn(),
  updateAdminExpense: jest.fn(),
  deleteAdminExpense: jest.fn(),
  importAdminExpenses: jest.fn(),
  exportAdminExpenses: jest.fn(),
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
  { id: 'railway', label: 'Railway (backend and Postgres)', cadence: 'usage' },
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
  cadences: ['monthly', 'quarterly', 'yearly', 'usage', 'one_time'],
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

// 261 of 412 venue-hours within one band and 169 at the exact band, over 26
// days, out of 1,280 serves, every one of them made by the venue's own curve,
// as production serves.
const MODEL = {
  version: { status: 'ok', value: '2.6.0-starling', source: 'loaded', loaded: true },
  serving: { mode: 'curve_offset', nowcast: true },
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
    exactBand: 169,
    exactPercent: 41,
    fromCurve: 412,
    versions: ['2.6.0-starling+curve_offset+nowcast'],
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

// The operator's own steps, as the server words them: the database on the
// public proxy with a timed round trip and its fix, the v2 key and the expense
// list done, the webhook to do, error reporting optional and not set, and the
// five steps the server cannot see, which carry no state at all.
const PRIVATE_NETWORK_FIX = 'railway variables --service Flock-app- --set PGHOST=postgres.railway.internal --set PGPORT=5432';
const RC_LINK = { href: 'https://app.revenuecat.com/', text: 'RevenueCat' };
const CHECK_YOURSELF = [
  { id: 'paid_apps_agreement', label: 'Paid Apps Agreement', words: 'Apple sells no in-app purchase until the Account Holder signs it, in App Store Connect under Business, then Agreements.', link: { href: 'https://appstoreconnect.apple.com/', text: 'App Store Connect' } },
  { id: 'small_business_program', label: 'App Store Small Business Program', words: "Enrolling takes Apple's cut from 30% to 15%. The App Store break-even on this page assumes 30%, because the server cannot see whether the account is enrolled. Once it is, each App Store subscriber covers more of the burn. Apple asks for the Paid Apps Agreement first.", link: { href: 'https://developer.apple.com/app-store/small-business-program/', text: 'Small Business Program' } },
  { id: 'subscription_review_screenshot', label: 'Review screenshot on each subscription', words: 'Each subscription needs a screenshot under Review Information before Apple will review it. Without one, App Store Connect shows it as Missing Metadata. Open the app, then Monetization, then Subscriptions.', link: { href: 'https://appstoreconnect.apple.com/apps', text: 'App Store Connect apps' } },
  { id: 'apple_organization_account', label: 'Apple developer account under the company', words: "Moving the developer account to the company's organization account is a request to Apple Developer Support. Apple verifies the company through its D-U-N-S Number.", link: { href: 'https://developer.apple.com/contact/', text: 'Apple Developer Support' } },
  { id: 'besttime_admissions', label: 'BestTime new-venue admissions this month', words: "BestTime's key endpoint does not report them, so the server cannot count them. BestTime's settings page shows how many are left this month.", link: { href: 'https://besttime.app/settings', text: 'BestTime settings' } },
].map((s) => ({ ...s, checkedBy: 'you', state: null, optional: false, fix: null }));
const OWNER_ACTIONS = {
  items: [
    {
      id: 'database_private_network', label: "Database on Railway's private network", checkedBy: 'server', state: 'todo', optional: false, network: 'public', via: 'PGHOST', link: null,
      words: "PGHOST names no railway.internal address, so every query travels through Railway's public proxy. The fix is one command, and Railway redeploys the service when its variables change.",
      fix: PRIVATE_NETWORK_FIX,
      roundTrip: { status: 'ok', ms: 142.37, asOf: '2026-09-25T13:26:30.000Z', cached: true, cachedAgeSeconds: 30 },
    },
    { id: 'revenuecat_project_figures', label: 'RevenueCat project figures', checkedBy: 'server', state: 'done', optional: false, fix: null, link: RC_LINK, lastRead: 'answered', words: "REVENUECAT_V2_SECRET_API_KEY is set, so the hub reads RevenueCat's project-wide figures and the offering with it." },
    { id: 'revenuecat_webhook', label: 'RevenueCat webhook', checkedBy: 'server', state: 'todo', optional: false, fix: null, link: RC_LINK, words: "REVENUECAT_WEBHOOK_SECRET is not set to a usable value, 16 characters or more, so the server refuses every webhook RevenueCat sends. Set a long random one on the server (openssl rand -hex 32 makes one), and put the same value in the Authorization header of RevenueCat's webhook, under Integrations, then Webhooks. The server cannot see RevenueCat's side." },
    { id: 'expense_list', label: 'Company expense list', checkedBy: 'server', state: 'done', optional: false, fix: null, link: null, words: 'The expense list has bills on it, so the costs on this page count them.' },
    { id: 'error_reporting', label: 'Error reporting', checkedBy: 'server', state: 'todo', optional: true, fix: null, link: null, words: 'SENTRY_DSN is not set. Server errors still reach the Railway logs, but nothing collects them or sends an alert. Setting it needs no code change.' },
    ...CHECK_YOURSELF,
  ],
  counts: { todo: 2, optionalTodo: 1, done: 2, unknown: 0, checkYourself: 5 },
};

// People accounts, as the server counts them: fourteen New York days ending
// today, rolling weeks, a first-week share over 40 accounts, and last week's
// plans. Every figure is a count.
const PEOPLE_DAYS = [3, 0, 5, 2, 1, 0, 4, 6, 2, 3, 0, 7, 5, 2].map((n, i) => ({ day: `2026-09-${String(12 + i).padStart(2, '0')}`, n }));
const PEOPLE = {
  status: 'ok',
  asOf: '2026-09-25T13:27:00.000Z',
  signups: { days: PEOPLE_DAYS, todayYmd: '2026-09-25', last7: 25, prior7: 15 },
  activation: { cohort: 40, activated: 17, percent: 42.5, fromDays: 8, toDays: 37, windowDays: 7, minForShare: 10 },
  active: { last7: 61, prior7: 55 },
  plans: { madeLast7: 12, madePrior7: 8, passedLast7: 10, confirmedLast7: 7, confirmedPercent: 70, guestAnswersLast7: 23, guestAnswersPrior7: 15, minForShare: 10 },
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
  people: PEOPLE,
  ownerActions: OWNER_ACTIONS,
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

// Resend's meter as the hub sends it (backend/services/moneyHub.js,
// judgeResendUsage): both windows with the reset worded in New York time, and
// one alert per window at 80% of its cap or at it.
const RESEND_WINDOWS = {
  daily: { limit: 100, resetsAt: '2026-10-08T23:59:59.999Z', resetsWords: '8:00 PM today, New York time' },
  monthly: { limit: 3000, resetsAt: '2026-10-28T08:20:02.910Z', resetsWords: '4:21 AM on Oct 28, New York time' },
};
function resendRead({ daily = 12, monthly = 340, alerts = [] } = {}) {
  const w = (name, used) => ({ ...RESEND_WINDOWS[name], used, share: used / RESEND_WINDOWS[name].limit });
  return { status: 'read', reason: null, asOf: '2026-10-08T15:00:00.000Z', daily: w('daily', daily), monthly: w('monthly', monthly), included: { daily: 100, monthly: 3000 }, alerts, cached: false };
}
function resendAlert(window, level, used) {
  const { limit, resetsAt, resetsWords } = RESEND_WINDOWS[window];
  return { window, level, used, limit, pct: Math.floor((used / limit) * 100), resetsAt, resetsWords };
}

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
    // Apple's 30% is named as an estimate, with the 15% case beside it
    // (review 2026-10-03).
    expect(revenueBlock.textContent).toMatch(/plus App Store charges after Apple's 30%, an estimate: Apple takes 15% under the Small Business Program and from a subscriber's second year\. The App Store part counts current Pro accounts only: a subscriber who deleted their account is not in it\./);
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
      costs: { ...COSTS, status: 'error', reason: 'The expense list could not be read, so only the code lines and the reconciled bills are counted.' },
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
    expect(screen.getAllByText(/only the code lines and the reconciled bills are counted/).length).toBeGreaterThan(0);
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
// THE MODEL. The share is the server's, over served forecasts made from a
// venue's own data that got a live reading in the same venue-hour. Under the
// minimum sample the server sends no share, and the card must say so in words
// and print no percentage, even if a share arrives anyway.
//
// prediction_method ml is the venue's own curve and live readings in
// curve_offset mode, which production serves and where no model runs. The
// card names what made the numbers and never calls the curve's the model's.
// ---------------------------------------------------------------------------
describe('the model: what makes the numbers, and the served ones against the goal', () => {
  const modelCard = () => screen.getByRole('heading', { name: 'Model' }).parentElement;
  const percentsIn = (el) => el.textContent.match(/\d+(\.\d+)?%/g);
  const withModel = (over) => ({ ...CONNECTED, model: { ...MODEL, ...over } });
  // Any wording that hands the curve's numbers to the model.
  const MODEL_CLAIM = /model forecasts|from the model|crowd model|the model answers|Live model/i;

  test('what makes the numbers, the loaded version, the exact level beside within one with the window and n, the goal and the gap', async () => {
    await renderHub(CONNECTED);
    const card = modelCard();
    expect(card.textContent).toMatch(/What makes Flock's crowd numbers now, and how the served ones held up against what the collector measured in the same hour\./);
    const madeBy = hubRow('Made by');
    expect(within(madeBy).getByText("Venue's own curve")).toBeInTheDocument();
    expect(madeBy.textContent).toMatch(/Serve mode is curve_offset: each venue's own weekly curve plus its live offset, with no model run\. The nowcast is on: a venue read live in an earlier hour has that reading blended into its number\./);
    expect(within(hubRow('Model version')).getByText('2.6.0-starling')).toBeInTheDocument();
    expect(hubRow('Model version').textContent).toMatch(/The version this server loaded, from its model_metadata\.json\. Serve mode curve_offset does not run it\. A venue's own data answers only while it is loaded\./);
    expect(within(hubRow('Model version')).queryByText('Not loaded')).toBeNull();
    expect(within(card).getByText('Against the live reading, last 30 days')).toBeInTheDocument();
    // The exact level and within one, side by side, in the site's words.
    // Within one alone flatters a forecast that always names the same level.
    expect(within(card).getByText('41.0%').nextSibling).toHaveTextContent('named the exact crowd level of the reading');
    expect(within(card).getByText('63.3%').nextSibling).toHaveTextContent("landed within one level, the reading's or the one next to it");
    // n and its count are held together by non-breaking spaces, so a narrow
    // screen never strands "n" at the end of a line.
    expect(card.textContent).toMatch(/Of forecasts made from a venue's own data\. n = 412 venue-hours over 26 days, 169 at the exact level and 261 within one, from 1,280 forecasts served in the window\. Within one alone would flatter a forecast that always named the same level, so the exact share sits beside it\./);
    expect(card.textContent).toMatch(/Counts forecasts made from a venue's own data \(served_predictions, prediction_method ml\) on the venue card and the vote list\. Of the 412 venue-hours scored, all came from the venue's own curve and live readings\. Each is paired/);
    expect(card.textContent).not.toMatch(MODEL_CLAIM);
    expect(within(hubRow('Goal')).getByText('85%')).toBeInTheDocument();
    expect(hubRow('Goal').textContent).toMatch(/Of served forecasts within one crowd level\. Not the blended training figure/);
    const gap = hubRow('Gap to goal');
    expect(within(gap).getByText('21.7 points')).toBeInTheDocument();
    expect(gap.textContent).toMatch(/The goal less the within-one share, in percentage points\./);
    expect(card.textContent).toMatch(/scored on the crowd levels the app prints: Quiet up to 20, Not Busy up to 39, Steady up to 69, Busy up to 84, Packed above\./);
    expect(card.textContent).toMatch(/held for an hour; this answer is 17 minutes old\./);
    expect(percentsIn(card)).toEqual(['41.0%', '63.3%', '85%']);
    expect(card.textContent).not.toMatch(/85\.1|87\.3/);
    expect(card.textContent).not.toMatch(/window mixes/);
  });

  test('in model mode the trained model is named, and a window that mixes the two says how many each made', async () => {
    await renderHub(withModel({
      serving: { mode: 'model', nowcast: false },
      accuracy: { ...MODEL.accuracy, fromCurve: 300, versions: ['2.6.0-starling', '2.6.0-starling+curve_offset'] },
    }));
    // The screen paints the last load first, so wait for this one.
    expect(await screen.findByText('Trained model')).toBeInTheDocument();
    const card = modelCard();
    const madeBy = hubRow('Made by');
    expect(within(madeBy).getByText('Trained model')).toBeInTheDocument();
    expect(madeBy.textContent).toMatch(/Serve mode is model: the trained model makes each venue's number\./);
    expect(madeBy.textContent).not.toMatch(/nowcast/);
    expect(hubRow('Model version').textContent).toMatch(/The version this server loaded, from its model_metadata\.json\.$/);
    expect(card.textContent).toMatch(/Of the 412 venue-hours scored, 300 came from the venue's own curve and live readings, 112 from the trained model\./);
    expect(screen.getByText('This window mixes 2 served versions: 2.6.0-starling, 2.6.0-starling+curve_offset. A +curve_offset or +nowcast ending names a switch that changed the number.')).toBeInTheDocument();
  });

  test('a window the model made alone says so, and a serve mode the server could not read is not guessed', async () => {
    await renderHub(withModel({
      serving: { mode: null, nowcast: null },
      accuracy: { ...MODEL.accuracy, fromCurve: 0, versions: ['2.6.0-starling'] },
    }));
    expect(await screen.findByText('The server did not say which serve mode it runs.')).toBeInTheDocument();
    const card = modelCard();
    const madeBy = hubRow('Made by');
    expect(within(madeBy).getByText('Not read')).toBeInTheDocument();
    expect(madeBy.textContent).toMatch(/The server did not say which serve mode it runs\./);
    expect(card.textContent).toMatch(/Of the 412 venue-hours scored, all came from the trained model\./);
    expect(card.textContent).not.toMatch(/curve_offset does not run it/);
  });

  test('a server that sends no serve mode and no split draws no row for it and claims nothing about what made the numbers', async () => {
    const accuracy = { ...MODEL.accuracy };
    delete accuracy.fromCurve;
    await renderHub(withModel({ serving: undefined, accuracy }));
    await waitFor(() => expect(screen.queryByText('Made by')).toBeNull());
    const card = modelCard();
    expect(within(card).queryByText('Made by')).toBeNull();
    expect(card.textContent).not.toMatch(/venue-hours scored/);
    expect(card.textContent).not.toMatch(/the trained model|own curve/);
    expect(card.textContent).toMatch(/on the venue card and the vote list\. Each is paired/);
  });

  test('under the minimum it says not enough observations yet, and prints no share and no gap', async () => {
    await renderHub(withModel({
      gapPoints: null,
      accuracy: { ...MODEL.accuracy, served: 310, matched: 37, days: 3, enough: false, withinOneBand: null, percent: null, exactBand: null, exactPercent: null },
    }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText(/^37 venue-hours over 3 days so far/);
    const card = modelCard();
    expect(within(card).getByText('Not enough observations yet')).toBeInTheDocument();
    expect(card.textContent).toMatch(/37 venue-hours over 3 days so far, from 310 forecasts served\. The shares show from 100 venue-hours across at least 5 days; below that they mostly measure chance\./);
    expect(within(hubRow('Gap to goal')).getByText('Not measured yet')).toBeInTheDocument();
    expect(hubRow('Gap to goal').textContent).toMatch(/Waits for enough observations to measure the shares\./);
    // The only percentage in the card is the goal.
    expect(percentsIn(card)).toEqual(['85%']);
  });

  test('a share that arrives under the minimum is still not drawn', async () => {
    // The server withholds it; this pins the screen's own half of the rule, so
    // an older or broken server still cannot put a noisy figure on it.
    await renderHub(withModel({
      gapPoints: 72.5,
      accuracy: { ...MODEL.accuracy, served: 40, matched: 8, days: 1, enough: false, withinOneBand: 1, percent: 12.5, exactBand: 0, exactPercent: 0 },
    }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText(/^8 venue-hours over 1 day so far/);
    const card = modelCard();
    expect(within(card).getByText('Not enough observations yet')).toBeInTheDocument();
    expect(within(card).queryByText('12.5%')).toBeNull();
    expect(within(card).queryByText('0.0%')).toBeNull();
    expect(percentsIn(card)).toEqual(['85%']);
    // Nor the gap worked from it.
    expect(within(hubRow('Gap to goal')).getByText('Not measured yet')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/72\.5/);
  });

  test('a within-one share that arrives without the exact level is not shown alone, and neither is its gap', async () => {
    // Review of the public copy (2026-10-06): within one alone flatters a
    // forecast that always names the same level, so an older server that
    // sends no exact share gets no share drawn at all.
    const accuracy = { ...MODEL.accuracy };
    delete accuracy.exactBand;
    delete accuracy.exactPercent;
    await renderHub(withModel({ accuracy }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText('Not shown alone');
    const card = modelCard();
    expect(card.textContent).toMatch(/This server sent the within-one share without the exact level beside it\. Within one alone would flatter a forecast that always named the same level, so neither is shown until both arrive\./);
    expect(within(card).queryByText('63.3%')).toBeNull();
    expect(percentsIn(card)).toEqual(['85%']);
    expect(within(hubRow('Gap to goal')).getByText('Not measured yet')).toBeInTheDocument();
    expect(hubRow('Gap to goal').textContent).toMatch(/Waits for both shares above\./);
    expect(card.textContent).not.toMatch(/21\.7/);
    expect(within(card).queryByText('Not enough observations yet')).toBeNull();
  });

  test('a check that failed says could not load with the reason, and prints no share and no gap', async () => {
    await renderHub(withModel({
      gapPoints: null,
      accuracy: { status: 'error', reason: "The database did not finish the check of served forecasts against the collector's readings, so there is no figure to show.", cached: false, cachedAgeSeconds: 0 },
    }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText('Could not load');
    const card = modelCard();
    expect(within(card).getByText('Could not load')).toBeInTheDocument();
    expect(within(card).getByText(/did not finish the check of served forecasts against the collector's readings/)).toBeInTheDocument();
    expect(within(card).queryByText('Not enough observations yet')).toBeNull();
    expect(within(hubRow('Gap to goal')).getByText('Not measured yet')).toBeInTheDocument();
    expect(hubRow('Gap to goal').textContent).toMatch(/Waits for the check above to answer\./);
    expect(percentsIn(card)).toEqual(['85%']);
    // The version is its own read and still stands, and so does the serve mode.
    expect(within(hubRow('Model version')).getByText('2.6.0-starling')).toBeInTheDocument();
    expect(within(hubRow('Made by')).getByText("Venue's own curve")).toBeInTheDocument();
    // With no pairs read there is nothing to say about what made them.
    expect(card.textContent).not.toMatch(/venue-hours scored/);
  });

  test('an artifact that is not loaded is labelled so, and a window that mixes versions says which', async () => {
    await renderHub(withModel({
      version: { status: 'ok', value: '2.6.0-starling', source: 'artifact', loaded: false },
      accuracy: { ...MODEL.accuracy, versions: ['2.6.0-starling+curve_offset', '2.7.0-swift+curve_offset'] },
    }));
    // The screen paints the last load first, so wait for this one.
    expect(await screen.findByText('This window mixes 2 served versions: 2.6.0-starling+curve_offset, 2.7.0-swift+curve_offset. A +curve_offset or +nowcast ending names a switch that changed the number.')).toBeInTheDocument();
    const row = hubRow('Model version');
    expect(within(row).getByText('Not loaded')).toBeInTheDocument();
    expect(row.textContent).toMatch(/No model is loaded in this server process yet, so this is the version of the artifact on disk/);
  });

  // What answered, from the week's serves: 1,290 of the 1,310 from a venue's
  // own data the venue's curve made, the other 20 the trained model.
  const COVERAGE = {
    status: 'ok',
    asOf: '2026-09-25T13:10:00.000Z',
    cached: true,
    cachedAgeSeconds: 1020,
    windowDays: 7,
    total: 2569,
    ml: 1310,
    mlFromCurve: 1290,
    mlPercent: 51,
    byMethod: [
      { method: 'ml', served: 1310, venues: 80 },
      { method: 'rule_engine_no_baseline', served: 1204, venues: 212 },
      { method: 'owner_report', served: 40, venues: 3 },
      { method: 'rule_engine_fallback', served: 12, venues: 9 },
      { method: 'unknown', served: 3, venues: 2 },
    ],
    topFallback: { method: 'rule_engine_no_baseline', served: 1204, venues: 212 },
  };

  test('beside the share, what answered at all, with its denominator, what made the share from a venue\'s own data, and the most common fallback in words', async () => {
    await renderHub(withModel({ coverage: COVERAGE }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText('What answered, last 7 days');
    const card = modelCard();
    expect(within(card).getByText('What answered, last 7 days')).toBeInTheDocument();
    const share = hubRow("Forecasts from a venue's own data");
    expect(within(share).getByText('51% of 2,569')).toBeInTheDocument();
    expect(share.textContent).toMatch(/1,310 of 2,569 forecasts served to signed-in people, counted once per card served, from served_predictions\. Of those, 1,290 came from the venue's own curve and live readings, 20 from the trained model\. The Costs tab counts forecast hours since the last deploy instead, so the two differ\./);
    const fallback = hubRow('Most common fallback');
    expect(within(fallback).getByText('1,204')).toBeInTheDocument();
    expect(fallback.textContent).toMatch(/The venue has no baseline yet, across 212 venues\. A venue gets numbers from its own data once the collector has read it\./);
    expect(within(card).getByText("By what answered: the venue's own curve and live readings 1,290; the trained model 20; the venue has no baseline yet 1,204; the venue owner's live report 40; an error on the request 12; not recorded 3. Held for an hour with the check above.")).toBeInTheDocument();
    // The two accuracy shares and the goal are untouched; the split adds one.
    expect(percentsIn(card)).toEqual(['41.0%', '63.3%', '85%', '51%']);
    expect(card.textContent).not.toMatch(/rule_engine/);
    expect(card.textContent).not.toMatch(MODEL_CLAIM);
  });

  test('a week the curve made alone names only the curve', async () => {
    await renderHub(withModel({ coverage: { ...COVERAGE, mlFromCurve: 1310 } }));
    // The screen paints the last load first, so wait for this one.
    expect(await screen.findByText(/^By what answered: the venue's own curve and live readings 1,310; the venue has no baseline yet 1,204;/)).toBeInTheDocument();
    expect(hubRow("Forecasts from a venue's own data").textContent).toMatch(/Of those, all came from the venue's own curve and live readings\./);
    expect(modelCard().textContent).not.toMatch(/the trained model \d/);
  });

  test('a server that did not split the count names a venue\'s own data and claims nothing about what made it', async () => {
    const unsplit = { ...COVERAGE };
    delete unsplit.mlFromCurve;
    await renderHub(withModel({ coverage: unsplit }));
    expect(await screen.findByText(/^By what answered: a venue's own data 1,310; the venue has no baseline yet 1,204;/)).toBeInTheDocument();
    expect(hubRow("Forecasts from a venue's own data").textContent).not.toMatch(/Of those/);
  });

  test('the category table\'s typical level at a venue with no baseline is a fallback in words, never by its method name', async () => {
    // CROWD_NO_CURVE_FALLBACK on: a venue with no baseline and 200+ reviews
    // gets its category's typical level for the hour instead of the rule
    // engine. It is not the venue's own data, so it is a fallback.
    const typical = { method: 'rule_engine_category_table', served: 900, venues: 150 };
    await renderHub(withModel({ coverage: { ...COVERAGE, byMethod: [COVERAGE.byMethod[0], typical, ...COVERAGE.byMethod.slice(1)], topFallback: typical, total: COVERAGE.total + 900 } }));
    expect(await screen.findByText(/^By what answered: the venue's own curve and live readings 1,290; the trained model 20; the venue has no baseline yet, so its category's typical level for the hour 900; the venue has no baseline yet 1,204;/)).toBeInTheDocument();
    const fallback = hubRow('Most common fallback');
    expect(within(fallback).getByText('900')).toBeInTheDocument();
    expect(fallback.textContent).toMatch(/The venue has no baseline yet, so its category's typical level for the hour, across 150 venues\. A venue gets numbers from its own data once the collector has read it\./);
    expect(modelCard().textContent).not.toMatch(/category_curve|rule_engine/);
    expect(modelCard().textContent).not.toMatch(MODEL_CLAIM);
  });

  test('a fallback this screen has no words for is shown by its own name, and one from a venue\'s own data alone has no fallback row', async () => {
    await renderHub(withModel({ coverage: { ...COVERAGE, byMethod: [{ method: 'rule_engine_new_reason', served: 9, venues: 1 }], topFallback: { method: 'rule_engine_new_reason', served: 9, venues: 1 }, total: 9, ml: 0, mlFromCurve: 0, mlPercent: 0 } }));
    // The screen paints the last load first, so wait for this one.
    await screen.findByText('0% of 9');
    expect(within(hubRow("Forecasts from a venue's own data")).getByText('0% of 9')).toBeInTheDocument();
    expect(hubRow('Most common fallback').textContent).toMatch(/Rule_engine_new_reason, across 1 venue\./);
    // Nothing from a venue's own data, so nothing to say about what made it.
    expect(hubRow("Forecasts from a venue's own data").textContent).not.toMatch(/Of those/);
  });

  test('a week with nothing served says so, with no share and no fallback', async () => {
    await renderHub(withModel({ coverage: { ...COVERAGE, total: 0, ml: 0, mlFromCurve: 0, mlPercent: null, byMethod: [], topFallback: null } }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText('None served');
    const card = modelCard();
    expect(percentsIn(card)).toEqual(['41.0%', '63.3%', '85%']);
    expect(within(hubRow("Forecasts from a venue's own data")).getByText('None served')).toBeInTheDocument();
    expect(within(card).queryByText('Most common fallback')).toBeNull();
    expect(within(card).queryByText(/^By what answered/)).toBeNull();
  });

  test('a failed count says could not load with the reason, and the share above still stands', async () => {
    await renderHub(withModel({ coverage: { status: 'error', reason: 'The database did not finish counting what answered each forecast served, so there is no split to show.', cached: false, cachedAgeSeconds: 0 } }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText('Could not load');
    const card = modelCard();
    expect(within(card).getByText('Could not load')).toBeInTheDocument();
    expect(within(card).getByText(/did not finish counting what answered each forecast served/)).toBeInTheDocument();
    expect(within(card).queryByText("Forecasts from a venue's own data")).toBeNull();
    expect(within(card).getByText('41.0%')).toBeInTheDocument();
    expect(within(card).getByText('63.3%')).toBeInTheDocument();
  });

  test('a server from before the count draws none of it', async () => {
    await renderHub(CONNECTED);
    // The screen paints the last load first, so wait for this one.
    await waitFor(() => expect(within(modelCard()).queryByText(/What answered, last/)).toBeNull());
  });

  test('a version that could not be read says why, and a goal already met is not a negative gap', async () => {
    await renderHub(withModel({
      version: { status: 'error', value: null, source: 'artifact', loaded: false, reason: 'No model is loaded, and this server has no model_metadata.json to read a version from.' },
      gapPoints: -1.2,
      accuracy: { ...MODEL.accuracy, withinOneBand: 355, percent: 86.2 },
    }));
    // The screen paints the last load first, so wait for this one.
    await within(modelCard()).findByText('Met');
    const row = hubRow('Model version');
    expect(within(row).getByText('Not read')).toBeInTheDocument();
    expect(row.textContent).toMatch(/this server has no model_metadata\.json to read a version from\./);
    expect(within(hubRow('Gap to goal')).getByText('Met')).toBeInTheDocument();
    expect(hubRow('Gap to goal').textContent).not.toMatch(/−|-1\.2/);
  });
});

// ---------------------------------------------------------------------------
// THE COSTS TAB'S COUNTER of what answered since the last deploy
// (mlPredictor.predictionCoverage). Its ml count is the curve's in
// curve_offset mode, so the panel names what made the share from the
// predictor's own split, curveOffsetAnswers, and the serve mode under it.
// ---------------------------------------------------------------------------
describe('the Costs tab: what answered the forecasts', () => {
  const COUNTER = {
    since: Date.parse('2026-10-06T12:00:00Z'),
    total: 2569,
    ml: 1310,
    ruleEngine: 1259,
    modelShare: 1310 / 2569,
    byMethod: { ml: 1310, rule_engine_no_baseline: 1259 },
    modelVersion: '2.6.0-starling',
    modelLoaded: true,
    serveMode: 'curve_offset',
    nowcastEnabled: true,
    curveOffsetAnswers: 1310,
    nowcastAnswersByLag: { 1: 400, 2: 0, 3: 0, 4: 0 },
    inMemory: true,
  };
  const panel = () => screen.getByRole('heading', { name: 'What answered the forecasts' }).parentElement;
  const show = (p) => render(React.createElement(RevenueScreen, screenProps({ adminTab: 'costs', costsData: { predictionCoverage: p } })));

  test('in curve_offset mode the share is from a venue\'s own data, all of it the curve, and none of it is handed to the model', () => {
    show(COUNTER);
    const card = panel();
    expect(within(card).getByText("From a venue's own data")).toBeInTheDocument();
    expect(within(card).getByText('51%')).toBeInTheDocument();
    expect(card.textContent).toMatch(/1,310 of 2,569 forecasts\. The rest came from the rule engine\. Of the 1,310, all came from the venue's own curve and live readings\./);
    expect(card.textContent).toMatch(/The ONNX model is in memory\. Serve mode curve_offset does not run it\. A venue's own data answers only while it is loaded\./);
    expect(card.textContent).toMatch(/Serve mode is curve_offset: each venue's own weekly curve plus its live offset, with no model run\. The nowcast is on: a venue read live in an earlier hour has that reading blended into its number\./);
    expect(card.textContent).not.toMatch(/Answered by the model|Crowd model|the trained model/);
  });

  test('in model mode the model is named, and a count that mixes the two says how many each made', () => {
    show({ ...COUNTER, serveMode: 'model', nowcastEnabled: false, curveOffsetAnswers: 10 });
    const card = panel();
    expect(card.textContent).toMatch(/Of the 1,310, 10 came from the venue's own curve and live readings, 1,300 from the trained model\./);
    expect(card.textContent).toMatch(/The ONNX model is in memory and available to serve\./);
    expect(card.textContent).toMatch(/Serve mode is model: the trained model makes each venue's number\./);
    expect(card.textContent).not.toMatch(/nowcast/);
  });

  test('with the no-curve fallback on, its answers are named apart from the rule engine\'s, and the switch says so', () => {
    show({
      ...COUNTER,
      categoryCurve: 300,
      ruleEngine: 959,
      byMethod: { ml: 1310, rule_engine_category_table: 300, rule_engine_no_baseline: 959 },
      noCurveFallback: true,
    });
    const card = panel();
    expect(card.textContent).toMatch(/1,310 of 2,569 forecasts\. 300 came from the typical level for the venue's category at that hour, at venues with no baseline yet, and the rest from the rule engine\. Of the 1,310, all came from the venue's own curve and live readings\./);
    expect(card.textContent).toMatch(/The no-curve fallback is on: a venue with no baseline and 200 or more Google reviews gets its category's typical level for the hour instead of the rule engine\./);
  });

  test('when every answer that was not a venue\'s own data was the table\'s, no rest is handed to the rule engine', () => {
    show({ ...COUNTER, categoryCurve: 1259, ruleEngine: 0, noCurveFallback: true });
    expect(panel().textContent)
      .toMatch(/1,310 of 2,569 forecasts\. 1,259 came from the typical level for the venue's category at that hour, at venues with no baseline yet\. Of the 1,310/);
    expect(panel().textContent).not.toMatch(/rest from the rule engine|The rest came/);
  });

  test('with the no-curve fallback off, the panel reads exactly as it did', () => {
    show({ ...COUNTER, categoryCurve: 0, noCurveFallback: false });
    const card = panel();
    expect(card.textContent).toMatch(/1,310 of 2,569 forecasts\. The rest came from the rule engine\. Of the 1,310/);
    expect(card.textContent).not.toMatch(/no-curve fallback|typical level/);
  });

  // The server calls the fallback on only while the table can be served: the
  // switch, a loaded model, and the artifact the table was measured on
  // (mlPredictor noCurveFallbackState, the gate's own rule). The switch alone
  // is reported as set, with the reason nothing is being served.
  const SET_NOT_SERVED = { categoryCurve: 0, noCurveFallback: false, noCurveFallbackSwitch: true, noCurveFallbackFittedOn: '2.6.0-starling' };

  test('with the switch set and no model loaded, the panel says the table is not being served, and why', () => {
    show({ ...COUNTER, ...SET_NOT_SERVED, modelLoaded: false, ml: 0, modelShare: 0, noCurveFallbackOff: 'model_not_loaded' });
    const card = panel();
    expect(card.textContent).toMatch(/The no-curve fallback switch is set, but the category table is not being served: no model is loaded\./);
    expect(card.textContent).not.toMatch(/The no-curve fallback is on/);
  });

  test('with the switch set beside another model version, the panel names the version it found and the one the table needs', () => {
    show({ ...COUNTER, ...SET_NOT_SERVED, modelVersion: '2.7.0-candidate', noCurveFallbackOff: 'model_version' });
    const card = panel();
    expect(card.textContent).toMatch(/The no-curve fallback switch is set, but the category table is not being served: it was measured on 2\.6\.0-starling, and the loaded model is 2\.7\.0-candidate\./);
    expect(card.textContent).not.toMatch(/The no-curve fallback is on/);
  });

  test('a loaded model that names no version is said so, never printed as blank', () => {
    show({ ...COUNTER, ...SET_NOT_SERVED, modelVersion: null, noCurveFallbackOff: 'model_version' });
    expect(panel().textContent).toMatch(/it was measured on 2\.6\.0-starling, and the loaded model names no version\./);
  });

  test('a server from before the split claims nothing about what made the share, and no model loaded says so', () => {
    const older = { ...COUNTER, modelLoaded: false, ml: 0, total: 40, modelShare: 0, byMethod: { rule_engine: 40 } };
    delete older.curveOffsetAnswers;
    delete older.serveMode;
    delete older.nowcastEnabled;
    show(older);
    const card = panel();
    expect(card.textContent).toMatch(/0 of 40 forecasts\. The rest came from the rule engine\./);
    expect(card.textContent).not.toMatch(/Of the 0|Serve mode/);
    expect(card.textContent).toMatch(/Every forecast is coming from the rule engine\. That is the designed fallback and the product still works, but no forecast is made from a venue's own data\./);
  });
});

// ---------------------------------------------------------------------------
// ONLY YOU CAN DO THESE. The server checks the operator's steps it can see
// and sends each as done, to do or not read, in its own words; the ones it
// cannot see arrive with no state. The card must draw both states with their
// fix and round trip, must mark every unseen step Check yourself and claim
// nothing about it, and must link out only over https.
// ---------------------------------------------------------------------------
describe('only you can do these: the operator\'s own steps', () => {
  const stepsCard = () => screen.getByRole('heading', { name: 'Only you can do these' }).parentElement;
  const withSteps = (over) => ({ ...CONNECTED, ownerActions: { ...OWNER_ACTIONS, ...over } });
  const replaceSteps = (changes) => OWNER_ACTIONS.items.map((s) => (changes[s.id] ? { ...s, ...changes[s.id] } : s));
  const DB = "Database on Railway's private network";

  test('to do and done side by side: the public proxy with its round trip and its fix, under a summary, right after the month and its people', async () => {
    await renderHub(CONNECTED);
    const card = stepsCard();
    // Straight after the month's figures and the people behind them. Each
    // card sits in its own cell of the hub's columns, so the cells line up.
    const cell = card.parentElement;
    expect(cell.previousSibling).toBe(screen.getByRole('heading', { name: 'People' }).parentElement.parentElement);
    expect(cell.previousSibling.previousSibling.textContent).toMatch(/^September 2026/);
    expect(within(card).getByText('Checked by the server')).toBeInTheDocument();
    expect(within(card).getByText('2 to do, 1 optional step not done, 2 done.')).toBeInTheDocument();

    const db = hubRow(DB);
    expect(within(db).getByText('To do')).toBeInTheDocument();
    expect(within(db).getByText('Public proxy')).toBeInTheDocument();
    expect(db.textContent).toMatch(/PGHOST names no railway\.internal address, so every query travels through Railway's public proxy\./);
    expect(within(db).getByText(/^One SELECT 1 round trip took 142 ms, timed at .+\.$/)).toBeInTheDocument();
    // The fix, word for word, as one block to copy.
    const fix = within(db).getByText(PRIVATE_NETWORK_FIX);
    expect(fix.tagName).toBe('CODE');

    const rc = hubRow('RevenueCat project figures');
    expect(within(rc).getByText('Done')).toBeInTheDocument();
    expect(within(rc).queryByText('Refused')).toBeNull();
    const webhook = hubRow('RevenueCat webhook');
    expect(within(webhook).getByText('To do')).toBeInTheDocument();
    expect(webhook.textContent).toMatch(/The server cannot see RevenueCat's side\./);
    expect(within(webhook).getByRole('link', { name: 'Open RevenueCat' })).toHaveAttribute('href', 'https://app.revenuecat.com/');
    expect(within(hubRow('Company expense list')).getByText('Done')).toBeInTheDocument();
    const sentry = hubRow('Error reporting');
    expect(within(sentry).getByText('To do')).toBeInTheDocument();
    expect(within(sentry).getByText('Optional')).toBeInTheDocument();
    // Only the database step has a round trip and a command.
    expect(within(card).getAllByText(/round trip took/)).toHaveLength(1);
    expect(card.querySelectorAll('code')).toHaveLength(1);
    // Plain sentences, the card's own words included.
    expect(card.textContent).not.toMatch(/—/);
  });

  test('every step done: the private network with no command, a round trip not timed is words and no number, a refused key and an unread list say so', async () => {
    await renderHub(withSteps({
      items: replaceSteps({
        database_private_network: {
          state: 'done', network: 'private', fix: null,
          words: "PGHOST names a railway.internal address, so every query stays on Railway's private network.",
          roundTrip: { status: 'error', reason: 'The database did not answer SELECT 1, so there is no round trip to show.', cached: false, cachedAgeSeconds: 0 },
        },
        revenuecat_project_figures: { lastRead: 'refused', words: 'REVENUECAT_V2_SECRET_API_KEY is set, and RevenueCat refused it on the last read. It must be a secret key for API v2 with read access to charts and metrics and to project configuration.' },
        revenuecat_webhook: { state: 'done', words: "REVENUECAT_WEBHOOK_SECRET is set on the server. RevenueCat's webhook, under Integrations, then Webhooks, must send the same value as its Authorization header, with or without Bearer in front. The server cannot see RevenueCat's side, so that half is yours to check." },
        expense_list: { state: 'unknown', words: 'The expense list could not be read, so this step cannot be checked right now.' },
        error_reporting: { state: 'done', words: 'SENTRY_DSN is set, so server errors are collected in Sentry.' },
        // Anything but https is never drawn as a link.
        besttime_admissions: { link: { href: 'http://besttime.app/settings', text: 'BestTime settings' } },
      }),
      counts: { todo: 0, optionalTodo: 0, done: 4, unknown: 1, checkYourself: 5 },
    }));
    const card = stepsCard();
    expect(within(card).getByText('1 not read, 4 done.')).toBeInTheDocument();

    const db = hubRow(DB);
    expect(within(db).getByText('Done')).toBeInTheDocument();
    expect(within(db).getByText('Private network')).toBeInTheDocument();
    expect(within(db).queryByText('Public proxy')).toBeNull();
    expect(within(db).getByText('The database did not answer SELECT 1, so there is no round trip to show.')).toBeInTheDocument();
    expect(db.textContent).not.toMatch(/\d\s?ms\b/);
    expect(db.querySelector('code')).toBeNull();
    expect(within(card).queryByText(PRIVATE_NETWORK_FIX)).toBeNull();

    const rc = hubRow('RevenueCat project figures');
    expect(within(rc).getByText('Done')).toBeInTheDocument();
    expect(within(rc).getByText('Refused')).toBeInTheDocument();
    expect(rc.textContent).toMatch(/RevenueCat refused it on the last read\./);
    expect(within(hubRow('RevenueCat webhook')).getByText('Done')).toBeInTheDocument();
    const list = hubRow('Company expense list');
    expect(within(list).getByText('Not read')).toBeInTheDocument();
    expect(within(list).queryByText('Done')).toBeNull();
    expect(within(list).queryByText('To do')).toBeNull();
    const sentry = hubRow('Error reporting');
    expect(within(sentry).getByText('Done')).toBeInTheDocument();
    expect(within(sentry).getByText('Optional')).toBeInTheDocument();
    const besttime = hubRow('BestTime new-venue admissions this month');
    expect(within(besttime).queryByRole('link')).toBeNull();
  });

  test('all done reads as all done', async () => {
    await renderHub(withSteps({ counts: { todo: 0, optionalTodo: 0, done: 5, unknown: 0, checkYourself: 5 } }));
    expect(within(stepsCard()).getByText('All 5 done.')).toBeInTheDocument();
  });

  test('the five steps the server cannot see say Check yourself, claim nothing, and each links out', async () => {
    await renderHub(CONNECTED);
    const card = stepsCard();
    expect(within(card).getByText('The server cannot see these')).toBeInTheDocument();
    expect(within(card).getAllByText('Check yourself')).toHaveLength(5);
    const expected = [
      ['Paid Apps Agreement', 'https://appstoreconnect.apple.com/', 'Open App Store Connect'],
      ['App Store Small Business Program', 'https://developer.apple.com/app-store/small-business-program/', 'Open Small Business Program'],
      ['Review screenshot on each subscription', 'https://appstoreconnect.apple.com/apps', 'Open App Store Connect apps'],
      ['Apple developer account under the company', 'https://developer.apple.com/contact/', 'Open Apple Developer Support'],
      ['BestTime new-venue admissions this month', 'https://besttime.app/settings', 'Open BestTime settings'],
    ];
    for (const [label, href, name] of expected) {
      const row = hubRow(label);
      expect(within(row).getByText('Check yourself')).toBeInTheDocument();
      for (const claim of ['Done', 'To do', 'Not read']) expect(within(row).queryByText(claim)).toBeNull();
      const link = within(row).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(hubRow('Paid Apps Agreement').textContent).toMatch(/Apple sells no in-app purchase until the Account Holder signs it/);
    expect(hubRow('App Store Small Business Program').textContent).toMatch(/Enrolling takes Apple's cut from 30% to 15%\. The App Store break-even on this page assumes 30%/);
    expect(hubRow('BestTime new-venue admissions this month').textContent).toMatch(/key endpoint does not report them/);
  });

  test('a server from before this block draws no card, not an empty one', async () => {
    const { ownerActions, ...older } = CONNECTED;
    expect(ownerActions).toBeDefined();
    await renderHub(older);
    expect(screen.queryByRole('heading', { name: 'Only you can do these' })).toBeNull();
    expect(screen.queryByText('Check yourself')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PEOPLE. Signups by New York day, the share of new accounts that start or
// join a plan in their first week, how many people used Flock this week, and
// last week's plans, all counts from the server. A share under the server's
// floor arrives null and must be drawn as its two counts, never a percentage;
// a week with nothing in it says so in words.
// ---------------------------------------------------------------------------
describe('people: signups, first weeks, the active and their plans', () => {
  const peopleCard = () => screen.getByRole('heading', { name: 'People' }).parentElement;
  const withPeople = (people) => ({ ...CONNECTED, people });
  const percentsIn = (el) => el.textContent.match(/\d+(\.\d+)?%/g);

  test('right after the month, every figure with what it counts, and a bar for each New York day', async () => {
    await renderHub(CONNECTED);
    const card = peopleCard();
    expect(card.parentElement.previousSibling.textContent).toMatch(/^September 2026/);
    expect(card.textContent).toMatch(/People accounts only: not venue owners, admins or banned accounts\./);

    // Fourteen bars, the busiest one full height, a day with nobody new a
    // flat stub, today lighter; the label reads out every day's count.
    const strip = within(card).getByRole('img');
    expect(strip).toHaveAttribute('aria-label', 'Signups each day: Sep 12 3, Sep 13 0, Sep 14 5, Sep 15 2, Sep 16 1, Sep 17 0, Sep 18 4, Sep 19 6, Sep 20 2, Sep 21 3, Sep 22 0, Sep 23 7, Sep 24 5, today 2.');
    const bars = Array.from(strip.children);
    expect(bars).toHaveLength(14);
    expect(bars[11].style.height).toBe('48px');
    expect(bars[1].style.height).toBe('2px');
    expect(bars[13].style.opacity).toBe('0.55');
    expect(bars[13]).toHaveAttribute('title', 'Today so far: 2');
    expect(within(card).getByText('Busiest day 7')).toBeInTheDocument();
    expect(within(card).getByText('Today so far')).toBeInTheDocument();

    const signups = hubRow('Signups, last 7 days');
    expect(within(signups).getByText('25')).toBeInTheDocument();
    expect(signups.textContent).toMatch(/15 in the 7 days before\. Both count back from now, so a morning never reads as a drop\. The bars are New York days\./);
    const first = hubRow('Made or accepted a plan in their first week');
    expect(within(first).getByText('43%')).toBeInTheDocument();
    expect(first.textContent).toMatch(/17 of the 40 accounts made 8 to 37 days ago made a plan or accepted one within 7 days of signing up\./);
    const active = hubRow('Used Flock, last 7 days');
    expect(within(active).getByText('61')).toBeInTheDocument();
    expect(active.textContent).toMatch(/55 in the 7 days before\. Each person once, for a message or DM, a venue vote, a plan made or accepted, or a crowd forecast opened while signed in\./);
    expect(within(hubRow('Plans made, last 7 days')).getByText('12')).toBeInTheDocument();
    expect(hubRow('Plans made, last 7 days').textContent).toMatch(/8 in the 7 days before\./);
    const confirmed = hubRow('Confirmed before their time');
    expect(within(confirmed).getByText('70%')).toBeInTheDocument();
    expect(confirmed.textContent).toMatch(/Of the 10 plans whose time came in the last 7 days, 7 had been confirmed\./);
    const guests = hubRow('Guest answers from share links');
    expect(within(guests).getByText('23')).toBeInTheDocument();
    expect(guests.textContent).toMatch(/15 in the 7 days before\./);
    expect(percentsIn(card)).toEqual(['43%', '70%']);
    expect(card.textContent).not.toMatch(/—/);
  });

  test('under the floor a share is its two counts, never a percentage', async () => {
    await renderHub(withPeople({
      ...PEOPLE,
      activation: { ...PEOPLE.activation, cohort: 6, activated: 2, percent: null },
      plans: { ...PEOPLE.plans, passedLast7: 3, confirmedLast7: 1, confirmedPercent: null },
    }));
    const card = peopleCard();
    expect(within(hubRow('Made or accepted a plan in their first week')).getByText('2 of 6')).toBeInTheDocument();
    expect(hubRow('Made or accepted a plan in their first week').textContent).toMatch(/The share shows from 10 accounts\./);
    expect(within(hubRow('Confirmed before their time')).getByText('1 of 3')).toBeInTheDocument();
    expect(hubRow('Confirmed before their time').textContent).toMatch(/Of the 3 plans whose time came in the last 7 days, 1 had been confirmed\. The share shows from 10 plans\./);
    expect(percentsIn(card)).toBeNull();
  });

  test('a share that arrives under the floor anyway is still not drawn', async () => {
    // The server withholds it; this pins the screen's own half of the rule.
    await renderHub(withPeople({
      ...PEOPLE,
      activation: { ...PEOPLE.activation, cohort: 4, activated: 3, percent: 75 },
      plans: { ...PEOPLE.plans, passedLast7: 2, confirmedLast7: 2, confirmedPercent: 100 },
    }));
    const card = peopleCard();
    expect(within(hubRow('Made or accepted a plan in their first week')).getByText('3 of 4')).toBeInTheDocument();
    expect(within(hubRow('Confirmed before their time')).getByText('2 of 2')).toBeInTheDocument();
    expect(percentsIn(card)).toBeNull();
  });

  test('a quiet fortnight says so in words, with fourteen flat bars and no share', async () => {
    await renderHub(withPeople({
      ...PEOPLE,
      signups: { ...PEOPLE.signups, days: PEOPLE_DAYS.map((d) => ({ ...d, n: 0 })), last7: 0, prior7: 0 },
      activation: { ...PEOPLE.activation, cohort: 0, activated: 0, percent: null },
      active: { last7: 0, prior7: 0 },
      plans: { ...PEOPLE.plans, madeLast7: 0, madePrior7: 0, passedLast7: 0, confirmedLast7: 0, confirmedPercent: null, guestAnswersLast7: 0, guestAnswersPrior7: 0 },
    }));
    const card = peopleCard();
    expect(within(card).getByText('Nobody signed up in the last 14 days.')).toBeInTheDocument();
    expect(within(card).getByText('Nobody new')).toBeInTheDocument();
    for (const bar of within(card).getByRole('img').children) expect(bar.style.height).toBe('2px');
    expect(within(hubRow('Made or accepted a plan in their first week')).getByText('None yet')).toBeInTheDocument();
    expect(hubRow('Made or accepted a plan in their first week').textContent).toMatch(/No people account is 8 to 37 days old, so no first week has finished inside the window\./);
    expect(within(hubRow('Confirmed before their time')).getByText('None')).toBeInTheDocument();
    expect(within(hubRow('Signups, last 7 days')).getByText('0')).toBeInTheDocument();
    expect(percentsIn(card)).toBeNull();
  });

  test('a failed read says could not load with the server\'s reason and draws no figure', async () => {
    await renderHub(withPeople({ status: 'error', reason: 'The account and plan tables could not be read, so there are no people figures to show.' }));
    const card = peopleCard();
    expect(within(card).getByText('Could not load')).toBeInTheDocument();
    expect(within(card).getByText(/The account and plan tables could not be read/)).toBeInTheDocument();
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).queryByText('Signups, last 7 days')).toBeNull();
    expect(card.textContent).not.toMatch(/\d/);
  });

  test('a server from before this block draws no People card', async () => {
    const { people, ...older } = CONNECTED;
    expect(people).toBeDefined();
    await renderHub(older);
    expect(screen.queryByRole('heading', { name: 'People' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEEDS ATTENTION. The first card on the Overview gathers every live problem
// the payload carries, each linking to the card it came from, so a morning
// look finds a stopped collector or an open dispute without scrolling past
// the lot. With nothing wrong it is one line that says when it was checked.
// A source that was asked and did not answer is a row, because it checked
// nothing; one that is not connected is not.
// ---------------------------------------------------------------------------
describe('needs attention: every live problem at the top, each linking to its card', () => {
  const attentionCard = () => screen.getByRole('heading', { name: /needs? you$/ }).parentElement;
  const rowsIn = (card) => Array.from(card.children).filter((el) => el.tagName === 'DIV');
  const setItems = (state) => OWNER_ACTIONS.items.map((s) => (s.checkedBy === 'server' ? { ...s, state } : s));
  // CONNECTED with everything put right: no price disagreement, no open
  // dispute, every step the server checks done, and no bill due this week.
  const QUIET = {
    ...CONNECTED,
    revenue: { ...CONNECTED.revenue, stripe: { ...CONNECTED.revenue.stripe, disputes: { status: 'ok', open: 0, openAmountCents: 0, openOtherCurrency: 0, truncated: false } } },
    pricing: { ...CONNECTED.pricing, mismatches: 0 },
    ownerActions: { ...OWNER_ACTIONS, items: setItems('done'), counts: { todo: 0, optionalTodo: 0, done: 5, unknown: 0, checkYourself: 5 } },
  };
  const stripeWith = (over) => ({ ...QUIET.revenue.stripe, ...over });
  const withRevenue = (over) => ({ ...QUIET, revenue: { ...QUIET.revenue, ...over } });

  afterEach(() => {
    delete Element.prototype.scrollIntoView;
  });

  test('with nothing wrong it is one line, with the time it was checked, and it comes first', async () => {
    await renderHub(QUIET);
    const line = screen.getByText(/^Nothing needs you\. Checked at .+\.$/);
    // One line: no heading, no rows, no links.
    const card = line.parentElement;
    expect(card.children).toHaveLength(1);
    expect(within(card).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('heading', { name: /needs? you$/ })).toBeNull();
    // First on the page, above the month. Each card sits in its own cell of
    // the hub's grid (two columns on a wide console), so the cells are what
    // line up.
    const cell = card.parentElement;
    expect(cell.nextSibling.textContent).toMatch(/^September 2026/);
    expect(cell.parentElement.firstChild).toBe(cell);
  });

  test('each problem is a row with its own words, worst first, and each jumps to its card', async () => {
    Element.prototype.scrollIntoView = jest.fn();
    await renderHub(CONNECTED);
    const card = attentionCard();
    expect(within(card).getByText('3 things need you')).toBeInTheDocument();
    const labels = rowsIn(card).map((r) => r.firstChild.firstChild.firstChild.textContent);
    expect(labels).toEqual(['Price disagreements', 'Disputes to answer', 'Steps only you can take']);

    const prices = hubRow('Price disagreements');
    expect(within(prices).getByText('1')).toBeInTheDocument();
    expect(within(prices).getByRole('link', { name: 'Go to Prices' })).toHaveAttribute('href', '#hub-prices');
    const disputes = hubRow('Disputes to answer');
    expect(within(disputes).getByText('2')).toBeInTheDocument();
    expect(disputes.textContent).toMatch(/\$3\.99 at stake in dollars, and 1 more in another currency\. Each has a deadline in the Stripe dashboard\./);
    const steps = hubRow('Steps only you can take');
    expect(within(steps).getByText('2 to do')).toBeInTheDocument();
    // The optional step is not a problem; the two that are, are named.
    expect(steps.textContent).toMatch(/Database on Railway's private network; RevenueCat webhook\./);
    expect(steps.textContent).not.toMatch(/Error reporting/);

    // Every target exists on the page, and a jump scrolls that card into view
    // without writing a hash into the address bar.
    for (const link of within(card).getAllByRole('link')) {
      const id = link.getAttribute('href').slice(1);
      expect(document.getElementById(id)).not.toBeNull();
    }
    fireEvent.click(within(disputes).getByRole('link', { name: 'Go to Revenue' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView.mock.instances[0]).toBe(document.getElementById('hub-revenue'));
    expect(within(document.getElementById('hub-revenue')).getByRole('heading', { name: 'Revenue' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    fireEvent.click(within(steps).getByRole('link', { name: 'Go to the steps' }));
    expect(Element.prototype.scrollIntoView.mock.instances[1]).toBe(screen.getByRole('heading', { name: 'Only you can do these' }).parentElement);
    // Plain sentences.
    expect(card.textContent).not.toMatch(/—/);
  });

  // One payload per trigger: the row's label, value and a phrase of its note,
  // and the card it jumps to.
  const TRIGGERS = [
    ['a stopped collector', { ...QUIET, health: { ...HEALTH, collector: { ...HEALTH.collector, state: 'stopped', minutesSinceLatest: 3000 } } },
      'Crowd collector', 'Stopped', /No live crowd row for 2 days\. It runs every hour/, 'hub-health'],
    ['a late collector', { ...QUIET, health: { ...HEALTH, collector: { ...HEALTH.collector, state: 'late', minutesSinceLatest: 300 } } },
      'Crowd collector', 'Late', /No live crowd row for 5 hours\./, 'hub-health'],
    ['a collector that could not be read', { ...QUIET, health: { ...HEALTH, collector: { status: 'error', reason: 'The collector tables could not be read.' } } },
      'Crowd collector', 'Not read', /The collector tables could not be read\./, 'hub-health'],
    ['BestTime not answering', { ...QUIET, crowdData: { ...CROWD_DATA, besttime: { status: 'error', reason: 'BestTime answered 503, a fault on its side.' } } },
      'BestTime', 'Not read', /BestTime answered 503, a fault on its side\./, 'hub-crowd'],
    ['a BestTime key BestTime calls invalid', { ...QUIET, crowdData: { ...CROWD_DATA, besttime: { ...CROWD_DATA.besttime, key: { healthy: false, status: 'Error', valid: false, active: true } } } },
      'BestTime', 'Key not working', /BestTime says status Error, valid false, active true\./, 'hub-crowd'],
    ['a price disagreement', { ...QUIET, pricing: { ...QUIET.pricing, mismatches: 2 } },
      'Price disagreements', '2', /A store's price, the RevenueCat offering and what the code states do not all agree\./, 'hub-prices'],
    ['a failed Pro renewal', withRevenue({ stripe: stripeWith({ subscriptions: { ...CONNECTED.revenue.stripe.subscriptions, pro: summary({ live: 2, pastDue: 1 }) } }) }),
      'Past due, Flock Pro', '1', /A renewal failed and Stripe is retrying it\./, 'hub-revenue'],
    ['a Roost renewal Stripe gave up on', withRevenue({ stripe: stripeWith({ subscriptions: { ...CONNECTED.revenue.stripe.subscriptions, roost: summary({ unpaid: 1 }) } }) }),
      'Unpaid, Roost', '1', /Stripe stopped retrying a failed renewal/, 'hub-revenue'],
    ['Pro accounts RevenueCat finds nothing live for', withRevenue({ revenuecat: { ...CONNECTED.revenue.revenuecat, subscribers: { ...CONNECTED.revenue.revenuecat.subscribers, premiumWithNothingLive: 2 } } }),
      'Pro accounts with nothing live', '2', /RevenueCat shows no live subscription for them\./, 'hub-revenue'],
    ['a model that is not loaded', { ...QUIET, model: { ...MODEL, version: { status: 'ok', value: '2.6.0-starling', source: 'artifact', loaded: false } } },
      'Crowd model', 'Not loaded', /It loads on the first forecast after a deploy/, 'hub-model'],
    ['a bill that may be counted twice', { ...QUIET, costs: { ...COSTS, possibleDoubles: [{ codeLineId: 'railway', codeLabel: 'Railway (backend and Postgres)', expenseId: 4, expenseLabel: 'Railway, Pro' }] } },
      'Bills possibly counted twice', '1', /Railway, Pro on the list and Railway \(backend and Postgres\) in the code\./, 'hub-costs'],
    ['a test key while the paywall is on', withRevenue({ stripe: stripeWith({ mode: 'test' }), flags: { paywallEnabled: true, venueBillingEnabled: false, proWebCheckoutEnabled: true } }),
      'Stripe test key', 'Selling', /The paywall and web checkout are on while the Stripe key is a test key/, 'hub-revenue'],
    ['Stripe asked and not answering', withRevenue({ stripe: { status: 'error', reason: 'Stripe refused the key (401).', cached: false } }),
      'Stripe', 'Not read', /Stripe refused the key \(401\)\. Disputes, failed renewals and prices were not checked\./, 'hub-revenue'],
    ['Stripe answering for some lists', withRevenue({ stripe: stripeWith({ disputes: { status: 'error', reason: 'Stripe did not answer in time.' } }) }),
      'Stripe', 'Read in part', /Stripe answered, but its disputes could not be read, so that was not checked\./, 'hub-revenue'],
    ['RevenueCat asked and not answering', withRevenue({ revenuecat: { status: 'error', reason: 'RevenueCat answered 500.' } }),
      'RevenueCat', 'Not read', /RevenueCat answered 500\. Pro accounts with nothing live were not checked\./, 'hub-revenue'],
    ['an expense list that could not be read', { ...QUIET, expenses: { ...EXPENSES, status: 'error', rows: [] } },
      'Expenses', 'Not read', /renewals and bills counted twice were not checked\./, 'hub-expenses'],
    // Licence exposures as data (2026-10-03).
    ['a plan used outside its terms', { ...QUIET, costs: { ...COSTS, licence: { items: [{ id: 'vercel', vendor: 'Vercel', plan: 'Hobby (free)', why: 'Hobby is for non-commercial use.', fix: 'Vercel Pro', fixCentsPerMonth: 2000, source: 'https://vercel.com', checked: '2026-09-29' }], toComplyPerMonthCents: 2000, licensedPerMonthCents: 22078 } } },
      'Plans outside their terms', '1', /Vercel Hobby \(free\)\. Licensed for commercial use, the burn is \$220\.78 a month \(\$20\.00 more\)\./, 'hub-costs'],
    // A bill charged on or after the day it was set to end renewed after all
    // (migration 117): the date on the row is what is wrong. The rule is said
    // of a bill paid ahead, which a usage bill is not (second review
    // 2026-10-06). A payload from before the cadence was sent lists only
    // bills paid ahead.
    ['a bill charged after the day it was set to end', { ...QUIET, costs: { ...COSTS, chargedPastEnd: [{ expenseId: 7, label: 'Store tool, Plus', endsOn: '2026-09-20', lastChargedOn: '2026-09-20' }] } },
      'Charged after the end date', '1', /Store tool, Plus, set to end Sep 20(, 2026)? and charged Sep 20(, 2026)?\. For a bill paid ahead, a charge on or after the end date means it renewed, so it counts as running\. Clear the end date, or set the new one\. Go to the expense list$/, 'hub-expenses'],
    // A usage bill is billed after the use, so the server lists one only once
    // a charge is later than the day its last bill was expected by. The dates
    // cannot say what that charge paid for, so the row says what they show
    // and sends the owner to the invoice (review 2026-10-06).
    ['a usage bill charged after its last bill was expected', { ...QUIET, costs: { ...COSTS, chargedPastEnd: [{ expenseId: 8, label: 'MapTiler, Flex', endsOn: '2026-07-31', lastChargedOn: '2026-09-02', cadence: 'usage', lastBillBy: '2026-08-30' }] } },
      'Charged after the end date', '1', /MapTiler, Flex, set to end Jul 31(, 2026)?, its last bill expected by Aug 30(, 2026)?, and charged Sep 2(, 2026)?\. For a usage bill, a charge later than its last bill was expected counts as running\. Check it against the invoice\. If the invoice covers use after the end date, clear the end date or set the new one\. If it was the last bill, mark its row stopped\. Go to the expense list$/, 'hub-expenses'],
    // Resend's caps (2026-10-08): the server judges each window and words the
    // reset in New York time; the screen makes one row per alert.
    ['a Resend meter that was asked and did not answer', { ...QUIET, costs: { ...COSTS, resendUsage: { status: 'failed', reason: 'Resend answered 502, so there is no reading.', alerts: [] } } },
      'Email usage', 'Not read', /Resend answered 502, so there is no reading\. The daily and monthly email caps were not checked\. Go to Costs$/, 'hub-costs'],
    ['email at 80% of the daily cap', { ...QUIET, costs: { ...COSTS, resendUsage: resendRead({ alerts: [resendAlert('daily', 'near', 85)] }) } },
      'Email near its daily limit', '85%', /85 of 100 emails today\. At 100 Resend sends nothing more, signup verifications and password resets included, until 8:00 PM today, New York time\. Go to Costs$/, 'hub-costs'],
    ['email at the daily cap', { ...QUIET, costs: { ...COSTS, resendUsage: resendRead({ alerts: [resendAlert('daily', 'at', 100)] }) } },
      'Email at its daily limit', '100 of 100', /Resend has counted 100 emails today, and the plan allows 100\. No more mail goes out, signup verifications and password resets included, until 8:00 PM today, New York time\. Go to Costs$/, 'hub-costs'],
    ['email at 80% of the monthly cap', { ...QUIET, costs: { ...COSTS, resendUsage: resendRead({ alerts: [resendAlert('monthly', 'near', 2450)] }) } },
      'Email near its monthly limit', '81%', /2,450 of 3,000 emails this month\. At 3,000 Resend sends nothing more, signup verifications and password resets included, until 4:21 AM on Oct 28, New York time\. Go to Costs$/, 'hub-costs'],
    ['email at the monthly cap', { ...QUIET, costs: { ...COSTS, resendUsage: resendRead({ alerts: [resendAlert('monthly', 'at', 3000)] }) } },
      'Email at its monthly limit', '3,000 of 3,000', /Resend has counted 3,000 emails this month, and the plan allows 3,000\. No more mail goes out, signup verifications and password resets included, until 4:21 AM on Oct 28, New York time\. Go to Costs$/, 'hub-costs'],
  ];

  test.each(TRIGGERS)('%s is a row that says so', async (_why, payload, label, value, note, target) => {
    await renderHub(payload);
    const card = attentionCard();
    expect(within(card).getByText('1 thing needs you')).toBeInTheDocument();
    const row = within(card).getByText(label).parentElement.parentElement;
    expect(within(row).getByText(value)).toBeInTheDocument();
    expect(row.textContent).toMatch(note);
    expect(within(row).getByRole('link')).toHaveAttribute('href', `#${target}`);
    expect(document.getElementById(target)).not.toBeNull();
  });

  test('a source that is not connected is not a problem', async () => {
    const quietSteps = { ...OWNER_ACTIONS, items: setItems('done'), counts: { todo: 0, optionalTodo: 0, done: 5, unknown: 0, checkYourself: 5 } };
    await renderHub({ ...NOT_CONNECTED, ownerActions: quietSteps, crowdData: { ...CROWD_DATA, besttime: { status: 'not_connected', reason: 'BESTTIME_API_KEY is not set on the server, so nothing here can read BestTime.' } } });
    expect(screen.getByText(/^Nothing needs you\. Checked at .+\.$/)).toBeInTheDocument();
  });

  test('a test key with nothing on sale is not a problem', async () => {
    await renderHub(withRevenue({ stripe: stripeWith({ mode: 'test' }), flags: { paywallEnabled: false, venueBillingEnabled: false, proWebCheckoutEnabled: false } }));
    expect(screen.getByText(/^Nothing needs you\. Checked at .+\.$/)).toBeInTheDocument();
  });

  test('a bill renewing this week is listed apart and is not counted as a problem', async () => {
    const soon = { expenseId: 9, label: 'Example Host, Pro', on: '2026-09-28', estimated: false, amountCents: 2000, currency: 'USD', cadence: 'monthly' };
    await renderHub({ ...QUIET, costs: { ...COSTS, upcoming: [...COSTS.upcoming, soon] } });
    const card = attentionCard();
    expect(within(card).getByRole('heading', { name: 'Nothing needs you' })).toBeInTheDocument();
    expect(within(card).getByText('Renewing in the next 7 days')).toBeInTheDocument();
    const row = within(card).getByText('Example Host, Pro').parentElement.parentElement;
    expect(within(row).getByText('$20.00')).toBeInTheDocument();
    expect(row.textContent).toMatch(/Renews in 3 days, Sep 28\./);
    expect(within(row).getByRole('link', { name: 'Go to Costs' })).toHaveAttribute('href', '#hub-costs');
    // Oct 16 is 21 days out, past the week, and stays on the Costs card only.
    expect(within(card).queryByText('Example Tool, Team')).toBeNull();
  });

  test('a bill ending within the month is listed apart, with what the burn does, and is not counted as a problem', async () => {
    const ending = [
      // Stands in for a $119 code line, so the burn falls by $30 when it ends,
      // not by its own $149 (review 2026-10-06): the server's burnChangeCents.
      { expenseId: 7, label: 'Store tool, Plus', endsOn: '2026-10-05', amountCents: 14900, currency: 'USD', cadence: 'monthly', isCredit: false, perMonthCents: 14900, burnChangeCents: -3000, restores: ['BestTime.app Pro, Package 100'] },
      // A payload from before burnChangeCents: the bill's own share.
      { expenseId: 9, label: 'Host, Startup credit', endsOn: '2026-10-20', amountCents: 1500, currency: 'USD', cadence: 'monthly', isCredit: true, perMonthCents: -1500 },
      // Past the month: on the Costs card only.
      { expenseId: 10, label: 'Yearly tool', endsOn: '2027-01-15', amountCents: 12000, currency: 'USD', cadence: 'yearly', isCredit: false, perMonthCents: 1000 },
    ];
    await renderHub({ ...QUIET, costs: { ...COSTS, ending } });
    expect(await screen.findByText('Ending in the next 30 days')).toBeInTheDocument();
    const card = attentionCard();
    expect(within(card).getByRole('heading', { name: 'Nothing needs you' })).toBeInTheDocument();
    const row = within(card).getByText('Store tool, Plus').parentElement.parentElement;
    expect(within(row).getByText('$149.00 a month')).toBeInTheDocument();
    expect(row.textContent).toMatch(/Ends in 10 days, Oct 5(, 2026)?, and the burn falls by \$30\.00 a month\./);
    expect(within(row).getByRole('link', { name: 'Go to Costs' })).toHaveAttribute('href', '#hub-costs');
    const credit = within(card).getByText('Host, Startup credit').parentElement.parentElement;
    expect(within(credit).getByText('−$15.00 a month')).toBeInTheDocument();
    expect(credit.textContent).toMatch(/Ends in 25 days, Oct 20(, 2026)?, and the burn rises by \$15\.00 a month\./);
    expect(within(card).queryByText('Yearly tool')).toBeNull();
    expect(card.textContent).not.toMatch(/—/);
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
    expect(body).toMatchObject({ vendor: 'Registered Agent Co', kind: 'legal', cadence: 'yearly', amount: '49.00', currency: 'USD', active: true, product: null, replacesLine: null, isCredit: false });
    await waitFor(() => expect(api.getAdminMoneyHub).toHaveBeenCalledTimes(2));
  });

  test('stopping a bill sends the whole row with active false', async () => {
    await renderHub(NOT_CONNECTED);
    api.updateAdminExpense.mockResolvedValue({ success: true });
    const row = screen.getByText('Example Tool, Team').closest('div').parentElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Mark as stopped/ }));
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

  test('the import says how to paste a quarterly bill and a credit, and sends them as pasted', async () => {
    await renderHub(NOT_CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Import a list' }));
    expect(screen.getByText(/cadence \(monthly, quarterly, yearly, usage or one_time\)/)).toBeInTheDocument();
    expect(screen.getByText(/isCredit: true for a refund or credit/)).toBeInTheDocument();
    api.importAdminExpenses.mockResolvedValueOnce({ success: true, inserted: 2, updated: 0 });
    const list = [
      { vendor: 'Tool', kind: 'tooling', cadence: 'quarterly', amount: 30 },
      { vendor: 'Host', product: 'Refund', kind: 'infrastructure', cadence: 'one_time', amount: 12.5, isCredit: true },
    ];
    fireEvent.change(screen.getByLabelText('Expense list to import'), { target: { value: JSON.stringify(list) } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('2 bills added and 0 updated.')).toBeInTheDocument();
    expect(api.importAdminExpenses).toHaveBeenLastCalledWith(list);
  });
});

describe('quarterly bills and credits', () => {
  const REFUND = { id: 2, vendor: 'Example Host', product: 'Refund', category: 'Hosting', kind: 'infrastructure', amountCents: 1250, currency: 'USD', cadence: 'one_time', lastChargedOn: '2026-09-10', renewsOn: null, active: true, verified: true, note: null, replacesLine: null, isCredit: true };
  const WITH_CREDIT = {
    ...NOT_CONNECTED,
    costs: {
      ...COSTS,
      byCategory: [...COSTS.byCategory, { category: 'Refunds', thisMonthCents: -1250, perMonthCents: 0, lines: 1 }],
      nonUsd: [{ label: 'Abroad, Credit', amountCents: 900, currency: 'EUR', replacesLine: null, isCredit: true }],
    },
    expenses: { ...EXPENSES, rows: [...EXPENSES.rows, REFUND, { ...REFUND, id: 3, vendor: 'Quarterly Tool', product: null, kind: 'tooling', amountCents: 3000, cadence: 'quarterly', isCredit: false }] },
  };

  test('a credit is marked and shown with a minus sign, in the list and in the tables', async () => {
    await renderHub(WITH_CREDIT);
    const row = (await screen.findByText('Example Host, Refund')).closest('div').parentElement;
    expect(within(row).getByText('Credit')).toBeInTheDocument();
    expect(row.textContent).toMatch(/−\$12\.50 once/);
    const charge = screen.getByText('Example Tool, Team').closest('div').parentElement;
    expect(within(charge).queryByText('Credit')).toBeNull();
    expect(charge.textContent).toMatch(/\$20\.00 a month/);
    expect(charge.textContent).not.toMatch(/−/);
    expect(screen.getByText('Quarterly Tool').closest('div').parentElement.textContent).toMatch(/\$30\.00 a quarter/);
    expect(screen.getAllByText('−$12.50').length).toBeGreaterThan(0);
    expect(screen.getByText(/Abroad, Credit \(−9\.00 EUR\)/)).toBeInTheDocument();
  });

  test('adding a quarterly credit sends the flag and drops a code line it cannot stand in for', async () => {
    await renderHub(NOT_CONNECTED);
    api.createAdminExpense.mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    expect(screen.getByRole('option', { name: 'every three months' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: 'Cloud Co' } });
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: 'quarterly' } });
    fireEvent.change(screen.getByLabelText('Amount, dollars'), { target: { value: '15.00' } });
    fireEvent.change(screen.getByLabelText('Counts instead of'), { target: { value: codeLines[0].id } });
    fireEvent.click(screen.getByLabelText('Money back: a refund or credit'));
    expect(screen.getByLabelText('Counts instead of')).toBeDisabled();
    expect(screen.getByText(/taken off the totals instead of added/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createAdminExpense).toHaveBeenCalledTimes(1));
    expect(api.createAdminExpense.mock.calls[0][0]).toMatchObject({ vendor: 'Cloud Co', cadence: 'quarterly', amount: '15.00', isCredit: true, replacesLine: null });
  });

  test('editing a credit keeps it a credit', async () => {
    await renderHub(WITH_CREDIT);
    api.updateAdminExpense.mockResolvedValue({ success: true });
    const row = (await screen.findByText('Example Host, Refund')).closest('div').parentElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Mark as stopped/ }));
    await waitFor(() => expect(api.updateAdminExpense).toHaveBeenCalledTimes(1));
    expect(api.updateAdminExpense.mock.calls[0][1]).toMatchObject({ amount: '12.50', isCredit: true, active: false });
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

// An expense saved on Overview reloads the costs payload too, so the Costs
// tab's all-in figure and the Projections burn move with it (money hub audit
// 2026-10-03: the payload was read once per session and went stale).
test('saving an expense on Overview reloads the costs the other two tabs read', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'screens', 'RevenueScreen.js'), 'utf8');
  expect(src).toContain('function MoneyHub({ colors, onExpensesChanged }) {');
  expect(src).toContain('onChanged={() => { load(false); if (onExpensesChanged) onExpensesChanged(); }}');
  expect(src).toContain("<MoneyHub colors={colors} onExpensesChanged={() => fetchCosts(true)} />");
});

// What each plan leaves, and cost per active person (2026-10-03).
describe('plan nets and unit costs', () => {
  const NETS = [
    { product: 'pro', plan: 'monthly', priceCents: 399, interval: 'month', grossPerMonthCents: 399, web: { netPerMonthCents: 355, feesPerMonthCents: 44 }, appStore: { priceCents: 399, source: 'stated', standardPct: 30, netPerMonthCents: 279, smallBusinessPct: 15, netPerMonthSmallBusinessCents: 339 } },
    { product: 'roost', plan: 'founding', priceCents: 5900, interval: 'month', grossPerMonthCents: 5900, web: { netPerMonthCents: 5658, feesPerMonthCents: 242 }, appStore: null },
  ];
  test('the Prices card says what each plan leaves after fees, with both of Apple\'s rates', async () => {
    await renderHub({ ...CONNECTED, planNets: NETS, unitCosts: { status: 'ok', minPeople: 10, activeLast7: 25, plansMadeLast7: 12, perActivePersonCents: 1783, perPlanCents: 854 } });
    expect(screen.getByText('What each plan leaves you, a month')).toBeInTheDocument();
    // The code-price row carries the same label, so the row with the web net is the one.
    await screen.findByText('$3.55 web');
    const pro = screen.getAllByText('Flock Pro, monthly').map((el) => el.parentElement.parentElement).find((r) => /web/.test(r.textContent));
    expect(pro.textContent).toMatch(/\$3\.55 web/);
    expect(pro.textContent).toMatch(/\$2\.79 after Apple's 30%, or \$3\.39 at the 15%/);
    // An App Store figure from the stated price says so (review 2026-10-03).
    expect(pro.textContent).toMatch(/the price the code states, because no App Store price was read/);
    expect(hubRow('Cost per active person').textContent).toMatch(/\$17\.83\/mo/);
    expect(hubRow('Cost per active person').textContent).toMatch(/each plan costs \$8\.54/);
  });
  test('below the floor it says too few, not a figure', async () => {
    await renderHub({ ...CONNECTED, unitCosts: { status: 'ok', minPeople: 10, activeLast7: 4, plansMadeLast7: 1, perActivePersonCents: null, perPlanCents: null } });
    // The screen paints the last load first, so wait for this one.
    await screen.findByText('Too few to say');
    expect(hubRow('Cost per active person').textContent).toMatch(/Shown from 10 active people a week; 4 were active/);
  });
});

// A list past the limit (review 2026-10-03): said so on the list, and no
// partial dollar figure is quoted beside the licence exposures.
describe('a truncated expense list', () => {
  const LIC = { items: [{ id: 'vercel', vendor: 'Vercel', plan: 'Hobby (free)', why: 'Non-commercial.', fix: 'Vercel Pro', fixCentsPerMonth: 2000, source: 'https://vercel.com', checked: '2026-09-29' }], toComplyPerMonthCents: 2000, licensedPerMonthCents: 22078 };
  test('the list says it was cut short, and no partial burn is quoted for the licences', async () => {
    await renderHub({
      ...CONNECTED,
      costs: { ...CONNECTED.costs, status: 'error', reason: 'The expense list has more than 500 rows.', licence: LIC },
      expenses: { ...CONNECTED.expenses, truncated: true, limit: 500 },
    });
    await screen.findByText(/These are the first 500/);
    expect(document.body.textContent).toMatch(/Licensing them adds \$20\.00 a month\./);
    expect(document.body.textContent).not.toMatch(/\$220\.78/);
    // The cost tables are withheld too: their totals would be missing bills.
    expect(screen.getByText(/Totals withheld until the expense list fits/)).toBeInTheDocument();
  });
});

// The expense list as a CSV file (2026-10-03).
describe('downloading the expense list', () => {
  test('the button saves the CSV the server sends and says what it saved', async () => {
    const created = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => { created.push(blob); return 'blob:flock'; };
    URL.revokeObjectURL = () => {};
    api.exportAdminExpenses.mockResolvedValue({ filename: 'flock-expenses-2026-10-03.csv', rows: 2, csv: '"Vendor"\r\n"Vercel"\r\n' });
    try {
      await renderHub(CONNECTED);
      const button = await screen.findByRole('button', { name: 'Download CSV' });
      fireEvent.click(button);
      expect(await screen.findByText('Saved flock-expenses-2026-10-03.csv, 2 bills.')).toBeInTheDocument();
      expect(api.exportAdminExpenses).toHaveBeenCalledTimes(1);
      expect(created).toHaveLength(1);
      expect(created[0].type).toBe('text/csv;charset=utf-8');
    } finally {
      URL.createObjectURL = origCreate;
      // jsdom has no revokeObjectURL, and the download frees its URL a second
      // after the click, once this test has ended. Putting the missing
      // function back made that timer throw inside whichever test was running
      // a second later (2026-10-06: the first test added after this one), so
      // a stand-in stays where jsdom has none.
      URL.revokeObjectURL = origRevoke || (() => {});
    }
  });
});

describe('renewal totals', () => {
  test('the Costs card says what is due in the next week, month and quarter', async () => {
    await renderHub({ ...CONNECTED, costs: { ...CONNECTED.costs, upcomingWindowDays: 90, upcomingTotals: [{ days: 7, cents: 0, charges: 0, bills: 0 }, { days: 30, cents: 20000, charges: 1, bills: 1 }, { days: 90, cents: 69900, charges: 4, bills: 2 }] } });
    expect(await screen.findByText(/Next 7 days: \$0\.00 · Next 30 days: \$200\.00 · Next 90 days: \$699\.00\./)).toBeInTheDocument();
    expect(screen.getByText('Renewals in the next 90 days')).toBeInTheDocument();
  });
});

describe('the price sheet', () => {
  const SHEET = {
    staleAfterDays: 60,
    stale: 1,
    rows: [
      { id: 'expense-2', label: 'Mystery tool', priceCents: 500, unit: 'a month', checkedOn: null, source: null, from: 'expense', ageDays: null, stale: true },
      { id: 'code-sportsdb', label: 'TheSportsDB Single Developer', priceCents: 900, unit: 'a month', checkedOn: '2026-09-01', source: null, from: 'code', ageDays: 32, stale: false },
    ],
  };
  test('lists each price with its checked date, and an unchecked one asks to be re-checked', async () => {
    await renderHub({ ...CONNECTED, priceSheet: SHEET });
    expect(await screen.findByText('Price sheet')).toBeInTheDocument();
    expect(screen.getByText('1 price due for a check')).toBeInTheDocument();
    expect(hubRow('TheSportsDB Single Developer').textContent).toMatch(/\$9\.00 a month.*Checked 2026-09-01, 32 days ago\./);
    expect(document.body.textContent).toMatch(/Prices to re-check/);
    expect(document.body.textContent).toMatch(/Due for a check against a receipt or a pricing page: Mystery tool\./);
  });
});

describe('bills that jumped', () => {
  test('a bill well above the last one is an attention row with both figures', async () => {
    await renderHub({ ...CONNECTED, costs: { ...CONNECTED.costs, jumps: [{ id: 'railway', label: 'Railway (backend and Postgres)', fromCents: 2452, fromPeriod: 'Aug 15 to Sep 15, 2026', toCents: 4497, toAsOf: '2026-10-03', pct: 83 }] } });
    expect(await screen.findByText('Bills up on the last one')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/Railway \(backend and Postgres\): \$24\.52 for Aug 15 to Sep 15, 2026, now \$44\.97 as of 2026-10-03 \(up 83%\)\./);
  });
});

describe('a jumped bill on the Costs card', () => {
  test('the card the attention row links to shows the jump too', async () => {
    await renderHub({ ...CONNECTED, costs: { ...CONNECTED.costs, jumps: [{ id: 'railway', label: 'Railway (backend and Postgres)', fromCents: 2452, fromPeriod: 'Aug 15 to Sep 15, 2026', toCents: 4497, toAsOf: '2026-10-03', pct: 83 }] } });
    expect(await screen.findByText('Up on the last bill')).toBeInTheDocument();
    expect(screen.getByText('up 83%')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// A BILL THAT ENDS RATHER THAN RENEWS (migration 117). The server works out
// where each row stands against its end date and what leaves the burn
// (backend/services/moneyHub.js, THE END OF A BILL); the screen says it, on
// the row, on the Costs card and beside the burn, and the form sets it.
// ---------------------------------------------------------------------------
describe('a bill that ends rather than renews', () => {
  const ENDING_ROW = {
    id: 7, vendor: 'Store tool', product: 'Plus', category: 'Tools', kind: 'tooling', amountCents: 3180, currency: 'USD', cadence: 'monthly',
    lastChargedOn: '2026-09-05', renewsOn: '2026-10-05', endsOn: '2026-10-05', active: true, verified: true, note: null, replacesLine: null, isCredit: false, endState: 'ending',
  };
  const ENDED_ROW = { ...ENDING_ROW, id: 8, product: 'Old plan', lastChargedOn: '2026-08-10', renewsOn: null, endsOn: '2026-09-10', endState: 'ended' };
  const ENDING = { expenseId: 7, label: 'Store tool, Plus', endsOn: '2026-10-05', amountCents: 3180, currency: 'USD', cadence: 'monthly', isCredit: false, perMonthCents: 3180, burnChangeCents: -3180, restores: [] };
  const WITH_ENDING = {
    ...CONNECTED,
    costs: { ...COSTS, ending: [ENDING], afterEnding: { burnCents: 17664, changeCents: -3180, by: '2026-10-05', bills: 1, label: 'Store tool, Plus' } },
    expenses: { ...EXPENSES, rows: [...EXPENSES.rows, ENDING_ROW, ENDED_ROW] },
  };
  // The hub paints the last payload first, so each look waits for this one.
  const expenseRow = async (label) => (await within(document.getElementById('hub-expenses')).findByText(label)).closest('div').parentElement;

  test('the row says when it ends in place of a renewal that never comes, and an ended one says so', async () => {
    await renderHub(WITH_ENDING);
    const row = await expenseRow('Store tool, Plus');
    expect(within(row).getByText('Ending')).toBeInTheDocument();
    expect(row.textContent).toMatch(/last charged Sep 5(, 2026)?, ends Oct 5(, 2026)?\./);
    expect(row.textContent).not.toMatch(/renews/);
    const ended = await expenseRow('Store tool, Old plan');
    expect(within(ended).getByText('Ended')).toBeInTheDocument();
    expect(ended.textContent).toMatch(/ended Sep 10(, 2026)?/);
    expect(within(ended).queryByText('Stopped')).toBeNull();
  });

  test('stopping it sends the end date back with the rest of the row', async () => {
    await renderHub(WITH_ENDING);
    api.updateAdminExpense.mockResolvedValue({ success: true });
    fireEvent.click(within(await expenseRow('Store tool, Plus')).getByRole('button', { name: /^Mark as stopped/ }));
    await waitFor(() => expect(api.updateAdminExpense).toHaveBeenCalledTimes(1));
    expect(api.updateAdminExpense.mock.calls[0]).toEqual([7, expect.objectContaining({ endsOn: '2026-10-05', renewsOn: '2026-10-05', active: false })]);
  });

  test('the form sets the day a bill ends, and a one-time charge cannot carry one', async () => {
    await renderHub(NOT_CONNECTED);
    api.createAdminExpense.mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: 'Store tool' } });
    fireEvent.change(screen.getByLabelText('Amount, dollars'), { target: { value: '31.80' } });
    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '2026-10-20' } });
    expect(screen.getByText('For a bill whose renewal is turned off. Nothing is charged on or after that day and the hub stops counting it then, so leave Still being charged ticked.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createAdminExpense).toHaveBeenCalledTimes(1));
    expect(api.createAdminExpense.mock.calls[0][0]).toMatchObject({ vendor: 'Store tool', cadence: 'monthly', endsOn: '2026-10-20' });

    fireEvent.click(await screen.findByRole('button', { name: 'Add a bill' }));
    fireEvent.change(screen.getByLabelText('Vendor'), { target: { value: 'Filing' } });
    fireEvent.change(screen.getByLabelText('Amount, dollars'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: 'one_time' } });
    expect(screen.getByLabelText('Ends on')).toBeDisabled();
    expect(screen.queryByText(/For a bill whose renewal is turned off/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createAdminExpense).toHaveBeenCalledTimes(2));
    expect(api.createAdminExpense.mock.calls[1][0]).toMatchObject({ vendor: 'Filing', cadence: 'one_time', endsOn: null });
  });

  test('the form says a usage bill set to end still has a last bill to come after the day', async () => {
    // A usage bill is billed after the use, so "nothing is charged on or after
    // that day" would make its last bill, which the hub expects after the
    // end date, look like a renewal (second review 2026-10-06).
    await renderHub(NOT_CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: 'usage' } });
    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '2026-10-01' } });
    expect(screen.getByText('For a usage bill that stops on that day. Its last bill comes after, for the use up to then, and the hub stops counting it on that day, so leave Still being charged ticked.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is charged on or after that day/)).toBeNull();
  });

  test('the import says how to paste one', async () => {
    await renderHub(NOT_CONNECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Import a list' }));
    expect(screen.getByText(/renewsOn, endsOn for a bill whose renewal is turned off, verified/)).toBeInTheDocument();
  });

  test('the Costs card lists it under Set to end, and the burn says where it goes', async () => {
    await renderHub(WITH_ENDING);
    const costs = document.getElementById('hub-costs');
    expect(await within(costs).findByText('Set to end')).toBeInTheDocument();
    const row = within(costs).getByText(/^Oct 5(, 2026)?, Store tool, Plus$/).parentElement.parentElement;
    expect(within(row).getByText('$31.80 a month')).toBeInTheDocument();
    expect(row.textContent).toMatch(/No charge on or after this day\. Then the burn falls by \$31\.80 a month\./);
    expect(hubRow('Burn a month').textContent).toMatch(/One-time charges are left out\. It falls to \$176\.64 on Oct 5(, 2026)?, when Store tool, Plus ends\./);
  });

  test('several set to end, a credit among them, or one in another currency, each read right', async () => {
    const credit = { expenseId: 9, label: 'Host, Startup credit', endsOn: '2026-11-01', amountCents: 1500, currency: 'USD', cadence: 'monthly', isCredit: true, perMonthCents: -1500, burnChangeCents: 1500, restores: [] };
    const euro = { expenseId: 11, label: 'Abroad tool', endsOn: '2026-12-01', amountCents: 900, currency: 'EUR', cadence: 'monthly', isCredit: false, perMonthCents: null, burnChangeCents: null, restores: [] };
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, ending: [ENDING, credit, euro], afterEnding: { burnCents: 19164, changeCents: -1680, by: '2026-11-01', bills: 2, label: null } },
    });
    const costs = document.getElementById('hub-costs');
    const creditRow = (await within(costs).findByText(/Host, Startup credit$/)).parentElement.parentElement;
    expect(hubRow('Burn a month').textContent).toMatch(/It falls to \$191\.64 by Nov 1(, 2026)?, once the 2 bills set to end have ended\./);
    expect(within(creditRow).getByText('−$15.00 a month')).toBeInTheDocument();
    expect(creditRow.textContent).toMatch(/No credit on or after this day\. Then the burn rises by \$15\.00 a month\./);
    const euroRow = within(costs).getByText(/Abroad tool$/).parentElement.parentElement;
    expect(within(euroRow).getByText('9.00 EUR a month')).toBeInTheDocument();
    expect(euroRow.textContent).toMatch(/No charge on or after this day\.$/);
  });

  test('a usage bill set to end says its last bill comes after the day', async () => {
    // A usage bill is billed after the use, and the hub waits for that last
    // bill before it reads a later charge as a renewal (second review
    // 2026-10-06), so "no charge on or after this day" is wrong for it.
    const metered = { ...ENDING, expenseId: 18, label: 'Build service', endsOn: '2026-10-01', amountCents: 13015, cadence: 'usage', perMonthCents: 13015, burnChangeCents: -13015 };
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, ending: [ENDING, metered], afterEnding: { burnCents: 4649, changeCents: -16195, by: '2026-10-05', bills: 2, label: null } },
    });
    const costs = document.getElementById('hub-costs');
    const row = (await within(costs).findByText(/^Oct 1(, 2026)?, Build service$/)).parentElement.parentElement;
    expect(within(row).getByText('$130.15 a month, usage')).toBeInTheDocument();
    expect(row.textContent).toMatch(/Use stops on this day, and its last bill comes after\. From this day the burn falls by \$130\.15 a month\.$/);
    expect(row.textContent).not.toMatch(/No charge/);
    // A bill paid ahead keeps its words.
    const plus = within(costs).getByText(/^Oct 5(, 2026)?, Store tool, Plus$/).parentElement.parentElement;
    expect(plus.textContent).toMatch(/No charge on or after this day\. Then the burn falls by \$31\.80 a month\./);
  });

  test('a bill that stood in for a code line says the line comes back, and the burn moves by the difference', async () => {
    // $149 in place of the code's $119 BestTime line (review 2026-10-06).
    const stand = { ...ENDING, expenseId: 12, label: 'BestTime, Package 100', amountCents: 14900, perMonthCents: 14900, burnChangeCents: -3000, restores: ['BestTime.app Pro, Package 100'] };
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, ending: [stand], afterEnding: { burnCents: 17844, changeCents: -3000, by: '2026-10-05', bills: 1, label: 'BestTime, Package 100' } },
    });
    const costs = document.getElementById('hub-costs');
    const row = (await within(costs).findByText(/BestTime, Package 100$/)).parentElement.parentElement;
    expect(within(row).getByText('$149.00 a month')).toBeInTheDocument();
    expect(row.textContent).toMatch(/No charge on or after this day\. Then the burn falls by \$30\.00 a month, as the code's BestTime\.app Pro, Package 100 counts again\./);
    expect(hubRow('Burn a month').textContent).toMatch(/It falls to \$178\.44 on Oct 5(, 2026)?, when BestTime, Package 100 ends\./);
  });

  test('a row charged on or after its end date says it counts as running only while it is still charged', async () => {
    // Renewed after an "expiring" notice, then cancelled for real and marked
    // stopped with the date left on (review 2026-10-06). The server keeps a
    // stopped row out of the burn and off the charged-after-the-end list, so
    // its row must not say it counts.
    const renewed = { ...ENDING_ROW, id: 13, product: 'Renewed', lastChargedOn: '2026-09-20', renewsOn: null, endsOn: '2026-09-20', endState: 'renewed' };
    const cancelled = { ...renewed, id: 14, product: 'Cancelled', active: false };
    await renderHub({ ...CONNECTED, expenses: { ...EXPENSES, rows: [...EXPENSES.rows, renewed, cancelled] } });
    const running = await expenseRow('Store tool, Renewed');
    expect(running.textContent).toMatch(/last charged Sep 20(, 2026)?, charged on or after its end date of Sep 20(, 2026)?, so it counts as running until the date is cleared\./);
    const stopped = await expenseRow('Store tool, Cancelled');
    expect(within(stopped).getByText('Stopped')).toBeInTheDocument();
    expect(stopped.textContent).toMatch(/last charged Sep 20(, 2026)?, charged on or after its end date of Sep 20(, 2026)?\./);
    expect(stopped.textContent).not.toMatch(/counts as running/);
  });

  test('a usage bill charged after its last bill was expected is worded on its own, on its row and in the attention list', async () => {
    // Second review 2026-10-06: a usage row reaches 'renewed' only once a
    // charge is later than the day its last bill was expected by. Said as "on
    // or after its end date", the words for a bill paid ahead, the last bill
    // of an ended usage row on the same screen read as a renewal, and clearing
    // its date put a finished bill back in the burn.
    const built = { ...ENDING_ROW, id: 15, vendor: 'Build service', product: null, cadence: 'usage', amountCents: 13015, lastChargedOn: '2026-09-02', renewsOn: null, endsOn: '2026-08-31', endState: 'ended', lastBillBy: '2026-09-30' };
    const flex = { ...ENDING_ROW, id: 16, vendor: 'MapTiler', product: 'Flex', kind: 'infrastructure', cadence: 'usage', amountCents: 3000, lastChargedOn: '2026-09-02', renewsOn: null, endsOn: '2026-07-31', endState: 'renewed', lastBillBy: '2026-08-30' };
    const oldKey = { ...flex, id: 17, product: 'Old key', active: false };
    const renewed = { ...ENDING_ROW, id: 13, product: 'Renewed', lastChargedOn: '2026-09-20', renewsOn: null, endsOn: '2026-09-20', endState: 'renewed', lastBillBy: null };
    await renderHub({
      ...CONNECTED,
      costs: {
        ...COSTS,
        chargedPastEnd: [
          { expenseId: 13, label: 'Store tool, Renewed', endsOn: '2026-09-20', lastChargedOn: '2026-09-20', cadence: 'monthly', lastBillBy: null },
          { expenseId: 16, label: 'MapTiler, Flex', endsOn: '2026-07-31', lastChargedOn: '2026-09-02', cadence: 'usage', lastBillBy: '2026-08-30' },
        ],
      },
      expenses: { ...EXPENSES, rows: [...EXPENSES.rows, built, flex, oldKey, renewed] },
    });
    const flexRow = await expenseRow('MapTiler, Flex');
    expect(flexRow.textContent).toMatch(/last charged Sep 2(, 2026)?, after the last bill expected by Aug 30(, 2026)? for its end date of Jul 31(, 2026)?, so it counts as running until the charge is checked against its invoice\./);
    expect(flexRow.textContent).not.toMatch(/on or after/);
    expect(flexRow.textContent).not.toMatch(/until the date is cleared/);
    const stopped = await expenseRow('MapTiler, Old key');
    expect(stopped.textContent).toMatch(/last charged Sep 2(, 2026)?, after the last bill expected by Aug 30(, 2026)? for its end date of Jul 31(, 2026)?\./);
    expect(stopped.textContent).not.toMatch(/counts as running/);
    // The last bill of the ended usage row, after its end date, is an end.
    expect((await expenseRow('Build service')).textContent).toMatch(/last charged Sep 2(, 2026)?, ended Aug 31(, 2026)?\./);
    // A bill paid ahead keeps its words.
    expect((await expenseRow('Store tool, Renewed')).textContent).toMatch(/charged on or after its end date of Sep 20(, 2026)?, so it counts as running until the date is cleared\./);

    // Each kind is worded on its own, with its own next step, and no rule is
    // stated that the ended usage row breaks. The usage charge is sent to the
    // invoice and is never said to pay for use past the end date, which the
    // dates cannot show (review 2026-10-06).
    const attention = screen.getByText('Charged after the end date').parentElement.parentElement;
    expect(within(attention).getByText('2')).toBeInTheDocument();
    expect(attention.textContent).toMatch(/Store tool, Renewed, set to end Sep 20(, 2026)? and charged Sep 20(, 2026)?\. For a bill paid ahead, a charge on or after the end date means it renewed, so it counts as running\. Clear the end date, or set the new one\. MapTiler, Flex, set to end Jul 31(, 2026)?, its last bill expected by Aug 30(, 2026)?, and charged Sep 2(, 2026)?\. For a usage bill, a charge later than its last bill was expected counts as running\. Check it against the invoice\. If the invoice covers use after the end date, clear the end date or set the new one\. If it was the last bill, mark its row stopped\./);
    expect(attention.textContent).not.toMatch(/A charge on or after/);
    expect(attention.textContent).not.toMatch(/pays for use|use past the end date/);
  });

  test('a usage charge paid after its last bill was expected is sent to the invoice, and not called use past the end date', async () => {
    // Review 2026-10-06: set to end Sep 1, the August invoice paid on Oct 2
    // is later than the Sep 30 its last bill was expected by, with no use in
    // September. The hub holds only the day it was paid, so the screen says
    // that much and asks for the invoice. Named apart from the rows above,
    // since the hub paints the last payload before this one.
    const late = { ...ENDING_ROW, id: 18, vendor: 'Build minutes', product: null, kind: 'tooling', cadence: 'usage', amountCents: 13015, lastChargedOn: '2026-10-02', renewsOn: null, endsOn: '2026-09-01', endState: 'renewed', lastBillBy: '2026-09-30' };
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, chargedPastEnd: [{ expenseId: 18, label: 'Build minutes', endsOn: '2026-09-01', lastChargedOn: '2026-10-02', cadence: 'usage', lastBillBy: '2026-09-30' }] },
      expenses: { ...EXPENSES, rows: [...EXPENSES.rows, late] },
    });
    const row = await expenseRow('Build minutes');
    expect(row.textContent).toMatch(/last charged Oct 2(, 2026)?, after the last bill expected by Sep 30(, 2026)? for its end date of Sep 1(, 2026)?, so it counts as running until the charge is checked against its invoice\./);
    const attention = screen.getByText('Charged after the end date').parentElement.parentElement;
    expect(attention.textContent).toMatch(/Build minutes, set to end Sep 1(, 2026)?, its last bill expected by Sep 30(, 2026)?, and charged Oct 2(, 2026)?\. For a usage bill, a charge later than its last bill was expected counts as running\. Check it against the invoice\. If the invoice covers use after the end date, clear the end date or set the new one\. If it was the last bill, mark its row stopped\./);
    for (const text of [row.textContent, attention.textContent]) {
      expect(text).not.toMatch(/pays for use|use past the end date|until the date is cleared/);
    }
  });

  test('with the list cut short the end dates are listed, and no burn change worked from the partial list is quoted', async () => {
    // Review 2026-10-06: a second stand-in for the same code line, past the
    // first 500 rows, keeps the line replaced, so the $30 the partial list
    // works out is not what the burn does on the day.
    const stand = { ...ENDING, expenseId: 12, label: 'BestTime, Package 100', amountCents: 14900, perMonthCents: 14900, burnChangeCents: -3000, restores: ['BestTime.app Pro, Package 100'] };
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, status: 'error', reason: 'The expense list has more than 500 rows.', ending: [stand], afterEnding: { burnCents: 17844, changeCents: -3000, by: '2026-10-05', bills: 1, label: 'BestTime, Package 100' } },
      expenses: { ...EXPENSES, truncated: true, limit: 500 },
      // What the server sends for a list past the limit: no burn.
      net: {
        ...CONNECTED.net,
        costsThisMonthCents: null,
        costsMissing: ['expenses'],
        netThisMonthCents: null,
        netMissing: ['expenses'],
        burnCents: null,
        netBurnCents: null,
        netBurnMissing: ['expenses'],
        breakEven: { ...CONNECTED.net.breakEven, burnMissing: ['expenses'] },
      },
    });
    const costs = document.getElementById('hub-costs');
    expect(await within(costs).findByText('Set to end')).toBeInTheDocument();
    const row = within(costs).getByText(/^Oct 5(, 2026)?, BestTime, Package 100$/).parentElement.parentElement;
    expect(within(row).getByText('$149.00 a month')).toBeInTheDocument();
    expect(row.textContent).toMatch(/No charge on or after this day\.$/);
    // The attention list names the day it ends, and nothing about the burn.
    const attention = screen.getByText('Ending in the next 30 days').parentElement;
    const soon = within(attention).getByText('BestTime, Package 100').parentElement.parentElement;
    expect(soon.textContent).toMatch(/Ends in 10 days, Oct 5(, 2026)?\./);
    for (const card of [costs, attention]) {
      expect(card.textContent).not.toMatch(/(falls|rises) by/);
      expect(card.textContent).not.toMatch(/counts? again\b/);
    }
    // And the burn line, which the server's null burn already withholds.
    expect(hubRow('Burn a month').textContent).not.toMatch(/It (falls|rises) to/);
  });

  test('a server from before migration 117 draws none of it', async () => {
    await renderHub(CONNECTED);
    await waitFor(() => expect(screen.queryByText('Set to end')).toBeNull());
    expect(hubRow('Burn a month').textContent).toMatch(/One-time charges are left out\.$/);
    expect(within(document.getElementById('hub-expenses')).queryByText('Ending')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WHAT THE RENEWALS LEAVE OUT (2026-10-06). The renewal totals count the bills
// the hub can date, and the monthly bills it cannot are named beside them, so
// "next 30 days" is not read as everything going out.
// ---------------------------------------------------------------------------
describe('the monthly bills the renewals cannot date', () => {
  const UNDATED = {
    perMonthCents: 14347,
    lines: [
      { id: 'besttime-subscription', label: 'BestTime.app Pro, Package 100', cadence: 'monthly', perMonthCents: 11900 },
      { id: 'railway', label: 'Railway (backend and Postgres)', cadence: 'usage', perMonthCents: 2447 },
    ],
  };

  test('they are named beside the renewals, with what they come to', async () => {
    await renderHub({ ...CONNECTED, costs: { ...COSTS, undatedMonthly: UNDATED } });
    const costs = document.getElementById('hub-costs');
    expect(await within(costs).findByText('Monthly bills with no date')).toBeInTheDocument();
    expect(within(costs).getByText('Charged every month on a day nothing here records, so they are in none of the renewals above: $143.47 a month in all.')).toBeInTheDocument();
    const railway = hubRow('Railway (backend and Postgres)');
    expect(within(railway).getByText('$24.47 a month')).toBeInTheDocument();
    expect(railway.textContent).toMatch(/Billed by use, at its latest figure\./);
    expect(hubRow('BestTime.app Pro, Package 100').textContent).not.toMatch(/Billed by use/);
  });

  test('a list cut short withholds them with the totals', async () => {
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, status: 'error', reason: 'The expense list has more than 500 rows.', undatedMonthly: UNDATED },
      expenses: { ...EXPENSES, truncated: true, limit: 500 },
    });
    await screen.findByText(/Totals withheld until the expense list fits/);
    expect(screen.queryByText('Monthly bills with no date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WHERE THE MONEY GOES (2026-10-06): every bill in the burn ranked by size,
// with its share.
// ---------------------------------------------------------------------------
describe('the biggest bills', () => {
  const BIGGEST = {
    lines: [
      { id: 'besttime-subscription', label: 'BestTime.app Pro, Package 100', kind: 'infrastructure', cadence: 'monthly', perMonthCents: 11900, pct: 57 },
      { id: 'apple-developer', label: 'Apple Developer Program', kind: 'infrastructure', cadence: 'yearly', perMonthCents: 825, pct: 4 },
      { id: 'domain', label: 'flockcorp.com', kind: 'infrastructure', cadence: 'yearly', perMonthCents: 93, pct: 0 },
    ],
    restBills: 2,
    restPerMonthCents: 2900,
    chargesPerMonthCents: 20844,
    beforeCredits: false,
  };

  test('the biggest bills come largest first, each with its share of the burn', async () => {
    await renderHub({ ...CONNECTED, costs: { ...COSTS, biggest: BIGGEST } });
    const costs = document.getElementById('hub-costs');
    expect(await within(costs).findByText('Biggest bills')).toBeInTheDocument();
    const best = hubRow('BestTime.app Pro, Package 100');
    expect(within(best).getByText('$119.00 a month')).toBeInTheDocument();
    expect(best.textContent).toMatch(/57% of the burn\.$/);
    expect(hubRow('Apple Developer Program').textContent).toMatch(/4% of the burn\. A yearly bill, at a twelfth\./);
    // A share that rounds to nothing is not printed as a free 0%.
    expect(hubRow('flockcorp.com').textContent).toMatch(/Under 1% of the burn\./);
    expect(within(costs).getByText('2 smaller bills, $29.00 a month in all.')).toBeInTheDocument();
    expect(costs.textContent).not.toMatch(/—/);
  });

  test('with a credit in the burn, a share is of the bills before credits', async () => {
    await renderHub({ ...CONNECTED, costs: { ...COSTS, biggest: { ...BIGGEST, beforeCredits: true, restBills: 0 } } });
    expect(await screen.findByText('57% of the bills before credits.')).toBeInTheDocument();
    expect(hubRow('BestTime.app Pro, Package 100').textContent).toMatch(/57% of the bills before credits\./);
    expect(screen.queryByText(/smaller bill/)).toBeNull();
  });

  test('a list cut short withholds them with the totals', async () => {
    await renderHub({
      ...CONNECTED,
      costs: { ...COSTS, status: 'error', reason: 'The expense list has more than 500 rows.', biggest: BIGGEST },
      expenses: { ...EXPENSES, truncated: true, limit: 500 },
    });
    await screen.findByText(/Totals withheld until the expense list fits/);
    expect(screen.queryByText('Biggest bills')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RESEND'S CAPS (2026-10-08). The free plan allows 100 emails a day and 3,000
// a month, every email counted. The server reads both from Resend
// (services/resendUsage.js); the Costs card and the Costs tab's Resend row
// print the same one line, and a meter that was not read prints no number.
// ---------------------------------------------------------------------------
describe('Resend email usage', () => {
  const resendLine = () => screen.getByText(/^Resend, live: /);
  const withResend = (resendUsage) => ({ ...CONNECTED, costs: { ...COSTS, resendUsage } });

  test('the Costs card says today and this month against each cap', async () => {
    // Found by waiting: the hub paints the last payload it held first, and
    // this one replaces it when the read lands.
    await renderHub(withResend(resendRead({ daily: 12, monthly: 1340 })));
    const line = await screen.findByText('Resend, live: Email today 12 of 100 · this month 1,340 of 3,000.');
    expect(line.closest('#hub-costs')).not.toBeNull();
  });

  test('with no key, or a read that failed, it says not read yet and prints no number', async () => {
    const { unmount } = await renderHub(withResend({ status: 'unset', reason: 'RESEND_API_KEY is not set, so Resend was not asked.', included: { daily: 100, monthly: 3000 }, alerts: [] }));
    expect(await screen.findByText('Resend, live: Not read yet: needs RESEND_API_KEY.')).toBeInTheDocument();
    unmount();
    await renderHub(withResend({ status: 'failed', reason: 'Resend did not answer within 4 seconds.', included: { daily: 100, monthly: 3000 }, alerts: [] }));
    expect(await screen.findByText('Resend, live: Not read yet: Resend did not answer within 4 seconds.')).toBeInTheDocument();
    expect(resendLine().textContent).not.toMatch(/\d+ of \d/);
  });

  test('a meter with no key, or under 80% of both caps, raises no attention row', async () => {
    const quiet = { ...CONNECTED, pricing: { ...CONNECTED.pricing, mismatches: 0 } };
    const { unmount } = await renderHub({ ...quiet, costs: { ...COSTS, resendUsage: { status: 'unset', reason: 'RESEND_API_KEY is not set, so Resend was not asked.', alerts: [] } } });
    await screen.findByText('Resend, live: Not read yet: needs RESEND_API_KEY.');
    expect(screen.queryByText(/^Email (near|at) its|^Email usage$/)).toBeNull();
    unmount();
    await renderHub({ ...quiet, costs: { ...COSTS, resendUsage: resendRead({ daily: 79, monthly: 2399 }) } });
    await screen.findByText('Resend, live: Email today 79 of 100 · this month 2,399 of 3,000.');
    expect(screen.queryByText(/^Email (near|at) its|^Email usage$/)).toBeNull();
  });

  test('both caps can raise a row at once, the one at its cap first', async () => {
    await renderHub(withResend(resendRead({ daily: 100, monthly: 2500, alerts: [resendAlert('daily', 'at', 100), resendAlert('monthly', 'near', 2500)] })));
    await screen.findByText('Email near its monthly limit');
    const card = screen.getByRole('heading', { name: /needs? you$/ }).parentElement;
    const labels = Array.from(card.children).filter((el) => el.tagName === 'DIV').map((r) => r.firstChild.firstChild.firstChild.textContent);
    expect(labels.indexOf('Email at its daily limit')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Email near its monthly limit')).toBeGreaterThan(labels.indexOf('Email at its daily limit'));
    expect(card.textContent).not.toMatch(/—/);
  });

  test('the Costs tab prints the same line under the Resend row, once the hub has been read', async () => {
    const { unmount } = await renderHub(withResend(resendRead({ daily: 40, monthly: 900 })));
    await screen.findByText('Resend, live: Email today 40 of 100 · this month 900 of 3,000.');
    unmount();
    const dependencies = {
      total: 1,
      groups: [{ id: 'free', label: 'Free tiers', short: 'free', note: 'Free at this volume.', entries: [{ id: 'resend', label: 'Resend', what: 'Email.', where: 'backend/services/emailService.js', group: 'free' }] }],
    };
    render(React.createElement(RevenueScreen, screenProps({ adminTab: 'costs', costsData: { dependencies } })));
    expect(screen.getByText('Live from Resend: Email today 40 of 100 · this month 900 of 3,000.')).toBeInTheDocument();
  });
});
