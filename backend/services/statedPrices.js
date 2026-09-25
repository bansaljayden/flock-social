'use strict';
// ---------------------------------------------------------------------------
// EVERY PRICE THIS REPOSITORY WRITES DOWN, AND WHERE.
//
// The owner's money hub (services/moneyHub.js, GET /api/admin/money) reads the
// prices Stripe will actually charge and sets each one beside every place the
// code states a price, so a mismatch is a sentence on the admin screen instead
// of a customer finding it. This file is the list of those places.
//
// WHY A LIST AND NOT A LOOKUP. Most of these prices live in files the running
// server cannot read: the app bundle (VENUE_PLAN_PRICE in App.js), the Terms
// page, the crawler files, the public docs, an email template. So each entry
// carries the amount it expects AND the pattern that finds that amount in its
// file, and two suites hold the two together: backend/__tests__/moneyHub.test.js
// and frontend/src/__tests__/moneyHubOverview.test.js each read every file
// named here and fail the moment an amount moves without this list moving with
// it. The frontend one is the one that runs on a push that only touches the
// app.
//
// The one price the server CAN read, VENUE_PRICE_USD in routes/admin.js, is
// passed in by that route at request time (`runtime`), so the hub compares
// the value actually running rather than this file's copy of it.
//
// ARITHMETIC IS NOT LISTED. MONEY-MODEL.md works sums out from these prices
// (what a subscriber nets after Apple's cut, how many venues clear a target).
// Those follow the list price they start from, so a Stripe price change flags
// the doc through its list-price entry, and whoever fixes the doc redoes the
// sums.
//
// No requires, on purpose: the frontend suite loads this file directly, and a
// require here would drag the database pool into a browser test.
// ---------------------------------------------------------------------------

// product: 'pro' (Flock Pro) or 'roost' (the venue plan). There is no third
// product: the $35 venue plan that sat under Roost was retired before anything
// could sell it (VENUE-PRICING.md section 4), and nothing states it any more.
// plan: 'monthly' | 'yearly' | 'founding'.
// pattern / group: how the tests find this amount in `file`. The captured
// text is compared as dollars, commas ignored. Patterns use \s+ wherever the
// file may wrap a sentence onto a new line.
const STATED_PRICES = [
  {
    id: 'pro-monthly-paywall-doc',
    product: 'pro',
    plan: 'monthly',
    usd: 3.99,
    file: 'PAYWALL.md',
    // The operator's working notes, kept out of the repository: checked
    // wherever the file exists, skipped in a checkout that does not have it.
    private: true,
    what: 'the settled Flock Pro prices',
    kind: 'doc',
    pattern: 'Prices are settled: \\$([\\d.]+) a month, \\$([\\d.]+) a year',
    group: 1,
  },
  {
    id: 'pro-yearly-paywall-doc',
    product: 'pro',
    plan: 'yearly',
    usd: 29.99,
    file: 'PAYWALL.md',
    // The operator's working notes, kept out of the repository: checked
    // wherever the file exists, skipped in a checkout that does not have it.
    private: true,
    what: 'the settled Flock Pro prices',
    kind: 'doc',
    pattern: 'Prices are settled: \\$([\\d.]+) a month, \\$([\\d.]+) a year',
    group: 2,
  },
  {
    id: 'pro-monthly-projections',
    product: 'pro',
    plan: 'monthly',
    usd: 3.99,
    file: 'frontend/src/screens/RevenueScreen.js',
    what: 'PRO_MONTHLY_USD, the break-even on the Projections tab',
    kind: 'code',
    pattern: 'const PRO_MONTHLY_USD = ([\\d.]+);',
    group: 1,
  },
  {
    id: 'roost-monthly-admin',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'backend/routes/admin.js',
    what: 'VENUE_PRICE_USD, the cost panel and the venue unit economics',
    kind: 'code',
    runtime: 'VENUE_PRICE_USD',
    pattern: 'const VENUE_PRICE_USD = (\\d+);',
    group: 1,
  },
  {
    id: 'roost-monthly-app',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'frontend/src/App.js',
    what: 'VENUE_PLAN_PRICE.pro, the Roost price the plan sheet and every lock fall back to',
    kind: 'code',
    pattern: 'const VENUE_PLAN_PRICE = \\{\\s*pro:\\s*(\\d+)\\s*\\};',
    group: 1,
  },
  {
    id: 'roost-monthly-terms',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'frontend/src/website/TermsOfService.js',
    what: 'Terms 9.6, the published venue price',
    kind: 'legal',
    pattern: '\\$(\\d+) a month, or \\$([\\d,]+) a year, per location',
    group: 1,
  },
  {
    id: 'roost-yearly-terms',
    product: 'roost',
    plan: 'yearly',
    usd: 990,
    file: 'frontend/src/website/TermsOfService.js',
    what: 'Terms 9.6, the published venue price',
    kind: 'legal',
    pattern: '\\$(\\d+) a month, or \\$([\\d,]+) a year, per location',
    group: 2,
  },
  // The same Terms text again, in the static page served to AI crawlers
  // (frontend/api/marketing-page.js). aiCrawlerSurface.test.js keeps it equal
  // to the React page; listing it here puts it on the hub beside Stripe as a
  // place the price is published in its own right.
  {
    id: 'roost-monthly-terms-served',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'frontend/api/marketing-page.js',
    what: 'Terms 9.6 in the server-rendered marketing page',
    kind: 'legal',
    pattern: '\\$(\\d+) a month, or \\$([\\d,]+) a year, per location',
    group: 1,
  },
  {
    id: 'roost-yearly-terms-served',
    product: 'roost',
    plan: 'yearly',
    usd: 990,
    file: 'frontend/api/marketing-page.js',
    what: 'Terms 9.6 in the server-rendered marketing page',
    kind: 'legal',
    pattern: '\\$(\\d+) a month, or \\$([\\d,]+) a year, per location',
    group: 2,
  },
  {
    id: 'roost-founding-env-doc',
    product: 'roost',
    plan: 'founding',
    usd: 59,
    file: 'backend/.env.example',
    what: 'STRIPE_PRICE_ROOST_FOUNDING, the founding-cohort rate sold by hand',
    kind: 'doc',
    pattern: 'The founding-cohort Roost price \\(\\$(\\d+)\\/month',
    group: 1,
  },
  // The crawler summary AI answer engines read (frontend/public/llms.txt).
  {
    id: 'roost-monthly-llms',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'frontend/public/llms.txt',
    what: 'the Roost price in the crawler summary',
    kind: 'public',
    pattern: 'Roost, the venue plan, is \\$(\\d+) a month or \\$([\\d,]+) a\\s+year per location',
    group: 1,
  },
  {
    id: 'roost-yearly-llms',
    product: 'roost',
    plan: 'yearly',
    usd: 990,
    file: 'frontend/public/llms.txt',
    what: 'the Roost price in the crawler summary',
    kind: 'public',
    pattern: 'Roost, the venue plan, is \\$(\\d+) a month or \\$([\\d,]+) a\\s+year per location',
    group: 2,
  },
  // The one email a venue account from before Roost had a price is sent
  // (backend/templates/roostNoticeEmail.js). Its prices are constants the
  // email prints; roostNotice.test.js holds them to Terms 9.6, and this puts
  // them beside Stripe as well.
  {
    id: 'roost-monthly-notice-email',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'backend/templates/roostNoticeEmail.js',
    what: 'ROOST_MONTHLY_USD, the price the Roost notice email names',
    kind: 'email',
    pattern: 'const ROOST_MONTHLY_USD = (\\d+);',
    group: 1,
  },
  {
    id: 'roost-yearly-notice-email',
    product: 'roost',
    plan: 'yearly',
    usd: 990,
    file: 'backend/templates/roostNoticeEmail.js',
    what: 'ROOST_YEARLY_USD, the price the Roost notice email names',
    kind: 'email',
    pattern: 'const ROOST_YEARLY_USD = (\\d+);',
    group: 1,
  },
  // The public docs (README.md and MONEY-MODEL.md ship to the repository).
  {
    id: 'roost-monthly-readme',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'README.md',
    what: 'the venue price in the repo docs table',
    kind: 'doc',
    pattern: 'Roost at \\$(\\d+)/month or \\$([\\d,]+)/year per location',
    group: 1,
  },
  {
    id: 'roost-yearly-readme',
    product: 'roost',
    plan: 'yearly',
    usd: 990,
    file: 'README.md',
    what: 'the venue price in the repo docs table',
    kind: 'doc',
    pattern: 'Roost at \\$(\\d+)/month or \\$([\\d,]+)/year per location',
    group: 2,
  },
  {
    id: 'pro-monthly-money-model',
    product: 'pro',
    plan: 'monthly',
    usd: 3.99,
    file: 'MONEY-MODEL.md',
    what: 'the Flock Pro price in the public money model',
    kind: 'doc',
    pattern: 'Flock Pro costs \\$([\\d.]+) a month or \\$([\\d.]+) a year',
    group: 1,
  },
  {
    id: 'pro-yearly-money-model',
    product: 'pro',
    plan: 'yearly',
    usd: 29.99,
    file: 'MONEY-MODEL.md',
    what: 'the Flock Pro price in the public money model',
    kind: 'doc',
    pattern: 'Flock Pro costs \\$([\\d.]+) a month or \\$([\\d.]+) a year',
    group: 2,
  },
  {
    id: 'roost-monthly-money-model',
    product: 'roost',
    plan: 'monthly',
    usd: 99,
    file: 'MONEY-MODEL.md',
    what: 'the Roost price in the public money model',
    kind: 'doc',
    pattern: 'Roost costs\\s+\\$(\\d+) a month or \\$([\\d,]+) a year\\s+per location',
    group: 1,
  },
  {
    id: 'roost-yearly-money-model',
    product: 'roost',
    plan: 'yearly',
    usd: 990,
    file: 'MONEY-MODEL.md',
    what: 'the Roost price in the public money model',
    kind: 'doc',
    pattern: 'Roost costs\\s+\\$(\\d+) a month or \\$([\\d,]+) a year\\s+per location',
    group: 2,
  },
];

// EVERY ROOST TRIAL LENGTH WRITTEN DOWN, AND WHERE. A trial is not a Stripe
// price, so the hub has nothing in Stripe to set these beside: checkout takes
// its trial from TRIAL_DAYS in backend/services/venueBilling.js. The two suites
// that read STATED_PRICES read this list too, and the backend one also holds
// every entry to TRIAL_DAYS, so a trial that changes in one place and not the
// others fails a test instead of reaching a venue. Flock Pro has no trial
// (proBilling.js trialDays() is 0 unless PRO_WEB_TRIAL_DAYS is set, and the App
// Store products carry no introductory offer), so nothing lists one.
const STATED_TRIALS = [
  {
    id: 'roost-trial-notice-email',
    product: 'roost',
    days: 14,
    file: 'backend/templates/roostNoticeEmail.js',
    what: 'ROOST_TRIAL_DAYS, the trial the Roost notice email names',
    pattern: 'const ROOST_TRIAL_DAYS = (\\d+);',
    group: 1,
  },
  {
    id: 'roost-trial-llms',
    product: 'roost',
    days: 14,
    file: 'frontend/public/llms.txt',
    what: 'the Roost trial in the crawler summary',
    pattern: 'with a (\\d+)-day free trial',
    group: 1,
  },
  {
    id: 'roost-trial-terms-served',
    product: 'roost',
    days: 14,
    file: 'frontend/api/marketing-page.js',
    what: 'Terms 9.6 in the server-rendered marketing page',
    pattern: 'New subscribers get (\\d+) days free, once per venue',
    group: 1,
  },
  {
    id: 'roost-trial-readme',
    product: 'roost',
    days: 14,
    file: 'README.md',
    what: 'the venue trial in the repo docs table',
    pattern: 'per location with a (\\d+)-day trial',
    group: 1,
  },
  {
    id: 'roost-trial-money-model',
    product: 'roost',
    days: 14,
    file: 'MONEY-MODEL.md',
    what: 'the Roost trial in the public money model',
    pattern: 'per location, with a (\\d+)-day free trial',
    group: 1,
  },
];

// Which environment variable names the Stripe price for each product and
// plan, so the hub can say "STRIPE_PRICE_PRO_YEARLY points at a monthly
// price" rather than only "the amounts differ". A stated price whose product
// and plan have no entry here reads as "nothing in Stripe sells it".
const PRICE_ENV = {
  pro: { monthly: 'STRIPE_PRICE_PRO_MONTHLY', yearly: 'STRIPE_PRICE_PRO_YEARLY' },
  roost: {
    monthly: 'STRIPE_PRICE_ROOST_MONTHLY',
    yearly: 'STRIPE_PRICE_ROOST_YEARLY',
    founding: 'STRIPE_PRICE_ROOST_FOUNDING',
  },
};

// The App Store product ids the RevenueCat offering is meant to carry
// (PAYWALL.md, "flock_pro_monthly" and "flock_pro_yearly"), and the package
// each belongs in. Used to read an App Store purchase's plan and to check the
// current offering points each package at the right product.
const APP_STORE_PRODUCTS = {
  flock_pro_monthly: { plan: 'monthly', packageKey: '$rc_monthly', duration: 'P1M' },
  flock_pro_yearly: { plan: 'yearly', packageKey: '$rc_annual', duration: 'P1Y' },
};

const PRODUCT_LABEL = {
  pro: 'Flock Pro',
  roost: 'Roost',
};

// How often each plan bills, for comparing a stated price with a Stripe
// price's own interval.
const PLAN_INTERVAL = { monthly: 'month', yearly: 'year', founding: 'month' };

module.exports = {
  STATED_PRICES,
  STATED_TRIALS,
  PRICE_ENV,
  APP_STORE_PRODUCTS,
  PRODUCT_LABEL,
  PLAN_INTERVAL,
};
