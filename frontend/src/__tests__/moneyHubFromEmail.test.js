// ---------------------------------------------------------------------------
// FROM YOUR EMAIL, RENDERED (the admin console's Overview tab).
//
// The server reads the receipts the owner's Gmail forwards and records each
// bill (backend/services/receiptInbox.js, pinned on a real database by
// backend/__tests__/receiptInboxRealDb.test.js). This file proves what
// reaches the screen:
//
//   * the card sits right above the expense list, and each receipt read is a
//     row with its vendor, amount, day and what it updated;
//   * a bill from a vendor the list has never seen waits with the one choice
//     only the owner can make, and the choice goes through the API client and
//     then re-reads the hub;
//   * a receipt the server could not read is in Needs you by its sender and
//     subject, and Done clears it;
//   * before the first receipt the card says so in one line, and a payload
//     from before the card draws no card at all.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test moneyHubFromEmail --watchAll=false
// ---------------------------------------------------------------------------

const React = require('react');
const { render, screen, fireEvent, waitFor, within, configure } = require('@testing-library/react');

// The hub is the heaviest screen in the app; see moneyHubOverview.test.js.
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
  confirmAdminEmailReceipt: jest.fn(),
  dismissAdminEmailReceipt: jest.fn(),
}));

const api = require('../services/api');
const RevenueScreen = require('../screens/RevenueScreen').default;

const COLORS = { navy: '#1f2a44', navyBg: '#1f2a44', navyMid: '#34405c', creamDark: '#ddd', cream: '#eee', amber: '#d97706', steel: '#4a7ba7' };

function screenProps(over = {}) {
  const fn = () => jest.fn();
  return {
    adminTab: 'overview', avgSpend: 120, colors: COLORS, costsData: null, costsError: false, costsLoading: false,
    eventsPerVenue: 12, fetchCosts: fn(), fetchResearchLive: fn(), numVenues: 20, operatingCosts: 2000,
    researchDemoMode: false, researchError: false, researchLiveData: null, researchLoading: false,
    setAdminTab: fn(), setAvgSpend: fn(), setEventsPerVenue: fn(), setNumVenues: fn(), setOperatingCosts: fn(),
    setResearchDemoMode: fn(), setSubscriptionPrice: fn(), setTakeRate: fn(), styles: { gradientButton: {} },
    subscriptionPrice: 67, switchMode: fn(), takeRate: 2.5, ...over,
  };
}

// A hub with nothing connected, the shape the server sends, and the
// receipts block on top.
const HUB = {
  generatedAt: '2026-11-20T15:00:00.000Z',
  month: { label: 'November 2026', startYmd: '2026-11-01', todayYmd: '2026-11-20', daysInMonth: 30, dayOfMonth: 20, tz: 'America/New_York' },
  cache: { ttlSeconds: 300, minRefreshSeconds: 60 },
  costs: {
    status: 'ok', reason: null,
    byKind: [{ kind: 'infrastructure', label: 'Running the app', thisMonthCents: 5000, perMonthCents: 5000, lines: 2 }],
    byCategory: [{ category: 'Hosting', thisMonthCents: 5000, perMonthCents: 5000, lines: 2 }],
    totals: { thisMonthCents: 5000, perMonthCents: 5000 },
    upcoming: [], upcomingWindowDays: 90, possibleDoubles: [], replaced: [], nonUsd: [], undatedCodeYearly: 0, reconciledReadError: null,
  },
  expenses: { status: 'ok', rows: [], kinds: ['infrastructure', 'tooling', 'legal', 'other'], cadences: ['monthly', 'quarterly', 'yearly', 'usage', 'one_time'], codeLines: [] },
  revenue: {
    stripe: { status: 'not_connected', reason: 'STRIPE_SECRET_KEY is not set on the server, so nothing here can read Stripe.', cached: false },
    revenuecat: { status: 'not_connected', reason: 'REVENUECAT_SECRET_API_KEY is not set on the server, so nothing here can read RevenueCat.' },
    database: { status: 'ok', proAccounts: 0, proAccountsCheckedWithRevenueCat: 0, proAccountsWithWebSubscription: null, payingVenues: 0 },
    flags: { paywallEnabled: false, venueBillingEnabled: false, proWebCheckoutEnabled: false },
  },
  net: {
    revenueThisMonthCents: null, revenueParts: { stripeNetCents: null, appStoreNetCents: null }, revenueMissing: ['stripe', 'app_store'],
    appStoreFrom: 'current_pro_accounts', costsThisMonthCents: 5000, costsMissing: [], netThisMonthCents: null, netMissing: ['stripe', 'app_store'],
    burnCents: 5000, recurringNetCents: null, recurringMissing: ['stripe', 'app_store'], netBurnCents: null, netBurnMissing: ['stripe', 'app_store'],
    appleCommissionPct: 30,
    breakEven: {
      proWeb: { priceCents: 399, source: 'stated', netPerUnitCents: 355, needed: 15 },
      proAppStore: { priceCents: 399, source: 'stated', netPerUnitCents: 279, needed: 18 },
      roost: { priceCents: 9900, source: 'stated', netPerUnitCents: 9514, needed: 1 },
      burnMissing: [], payingPro: null, payingProMissing: ['stripe', 'app_store'], payingRoost: null, payingRoostMissing: ['stripe'],
    },
  },
  pricing: { stated: [], internal: [], unreferenced: [], appStore: [], offering: { status: 'unavailable', identifier: null, findings: [] }, mismatches: 0, paywallNote: '' },
  health: { collector: { status: 'ok', state: 'fresh', latestAt: '2026-11-20T14:07:00.000Z', minutesSinceLatest: 20, rows24h: 3000, hours24h: 24, lastAlertOn: null, lateAfterMinutes: 150 }, backups: { recorded: false } },
  ownerActions: { items: [], counts: { todo: 0, optionalTodo: 0, done: 0, unknown: 0, checkYourself: 0 } },
};

const NOTHING_DROPPED = { since: '2026-11-20T10:00:00.000Z', total: 0, byReason: [] };

const RECEIPTS = {
  status: 'ok',
  inbox: { address: null, localPart: 'receipts' },
  pending: [],
  toCheck: [],
  recent: [
    { id: 11, vendor: 'Railway', product: 'Pro plan', amountCents: 3510, currency: 'USD', paidOn: '2026-11-15', status: 'applied', reconciledLine: 'railway', lineLabel: 'Railway (backend and Postgres)', expenseId: null, expenseLabel: null, previousCents: 3340, previousOn: '2026-11-05', reason: null, receivedAt: '2026-11-16T01:31:00.000Z' },
    { id: 10, vendor: 'Example Labs, PBC', product: 'Max plan - 20x', amountCents: 21200, currency: 'USD', paidOn: '2026-11-13', status: 'applied', reconciledLine: null, lineLabel: null, expenseId: 4, expenseLabel: 'Example Labs, Max (20x)', previousCents: 21200, previousOn: '2026-10-13', reason: null, receivedAt: '2026-11-14T04:40:00.000Z' },
    { id: 9, vendor: 'Nevercode Ltd', product: 'macOS M2 minutes', amountCents: 4123, currency: 'USD', paidOn: '2026-11-02', status: 'added', reconciledLine: null, lineLabel: null, expenseId: 7, expenseLabel: 'Codemagic, macOS M2 minutes, Oct 2 to Nov 1, 2026', previousCents: null, previousOn: null, reason: null, receivedAt: '2026-11-02T00:41:00.000Z' },
    { id: 8, vendor: 'Railway', product: 'Pro plan', amountCents: 4299, currency: 'USD', paidOn: '2026-10-15', status: 'older', reconciledLine: 'railway', lineLabel: 'Railway (backend and Postgres)', expenseId: null, expenseLabel: null, previousCents: 3340, previousOn: '2026-11-05', reason: 'The hub already holds a newer Railway figure, from Nov 5, 2026.', receivedAt: '2026-11-01T12:00:00.000Z' },
  ],
  thisMonth: 4,
  lastReceivedAt: '2026-11-16T01:31:00.000Z',
  ignored: NOTHING_DROPPED,
};

beforeEach(() => {
  jest.clearAllMocks();
});

async function renderHub(payload) {
  api.getAdminMoneyHub.mockResolvedValue(payload);
  const utils = render(React.createElement(RevenueScreen, screenProps()));
  await screen.findByText('Refresh');
  await screen.findByText('November 2026');
  return utils;
}

const cardOf = (name) => screen.getByRole('heading', { name }).closest('[data-hub-card]');
const needRow = (label) => {
  const card = document.getElementById('hub-needs');
  const el = within(card).getByText(label);
  return el.closest('details');
};

test('From your email sits right above the expense list, one row per receipt with what it updated', async () => {
  await renderHub({ ...HUB, emailReceipts: RECEIPTS });
  const order = Array.from(document.querySelectorAll('[data-hub-card]')).map((c) => {
    const heading = c.querySelector('h2, h3');
    return heading ? heading.textContent : '';
  });
  expect(order.indexOf('From your email')).toBe(order.indexOf('Expense list') - 1);
  const card = cardOf('From your email');
  expect(within(card).getByText('Receipts your Gmail forwards, and the bill each one updated.')).toBeInTheDocument();
  expect(within(card).getByText('4 this month')).toBeInTheDocument();
  const railway = within(card).getAllByText('Railway, Pro plan', { selector: '.hub-row-label' })[0].closest('[data-hub-fig]');
  expect(within(railway).getByText('$35.10')).toBeInTheDocument();
  expect(within(railway).getByText(/^Nov 15(, 2026)? · Railway \(backend and Postgres\) now \$35\.10, was \$33\.40$/)).toBeInTheDocument();
  expect(within(card).getByText(/^Nov 13(, 2026)? · Updated Example Labs, Max \(20x\)$/)).toBeInTheDocument();
  expect(within(card).getByText(/^Nov 2(, 2026)? · Added to the list as Codemagic, macOS M2 minutes, Oct 2 to Nov 1, 2026$/)).toBeInTheDocument();
  // An older receipt says so, and why is one tap away.
  expect(within(card).getByText(/^Oct 15(, 2026)? · Older than the figure on the hub$/)).toBeInTheDocument();
  expect(within(card).getByText('The hub already holds a newer Railway figure, from Nov 5, 2026.')).not.toBeVisible();
  // How it works is behind a tap, and says the rest of the inbox is never read.
  const why = within(card).getByText('How this works').closest('details');
  expect(why.open).toBe(false);
  expect(why.textContent).toMatch(/the rest of the inbox is never read/);
  expect(why.textContent).toMatch(/no receipt's body is ever stored/);
  // Nothing about receipts needs the owner.
  expect(document.querySelector('[data-hub-need="receipts-new"]')).toBeNull();
  expect(document.querySelector('[data-hub-need="receipts-check"]')).toBeNull();
});

test('a new bill waits, counted nowhere, with one choice: add it as a kind, or say it is not a Flock bill', async () => {
  const pending = { id: 21, vendor: 'Example Maps AG', product: 'Cloud: Flex subscription', amountCents: 3180, currency: 'USD', paidOn: '2026-11-07', cadence: null, status: 'new', reconciledLine: null, lineLabel: null, expenseId: null, expenseLabel: null, previousCents: null, previousOn: null, reason: null, receivedAt: '2026-11-08T03:11:00.000Z' };
  await renderHub({ ...HUB, emailReceipts: { ...RECEIPTS, pending: [pending], recent: [] } });
  const card = cardOf('From your email');
  expect(within(card).getByText('1 new bill')).toBeInTheDocument();
  const row = card.querySelector('[data-hub-receipt="21"]');
  expect(within(row).getByText('$31.80 a month')).toBeInTheDocument();
  expect(row.textContent).toMatch(/Paid Nov 7(, 2026)?\. Nothing on the expense list matches it, so it is in no total until you add it\./);
  // Needs you says so too, with the jump to the card.
  const need = needRow('New bill from email');
  expect(need.textContent).toMatch(/Example Maps AG \$31\.80 on Nov 7(, 2026)?\. Not counted anywhere until you add it to the expense list, or say it is not a Flock bill\./);
  expect(within(need).getByRole('link', { name: 'Go to From your email' })).toHaveAttribute('href', '#hub-from-email');

  api.confirmAdminEmailReceipt.mockResolvedValue({ success: true, expenseId: 9 });
  fireEvent.change(within(row).getByLabelText('Kind'), { target: { value: 'infrastructure' } });
  fireEvent.click(within(row).getByRole('button', { name: 'Add Example Maps AG, Cloud: Flex subscription to the list' }));
  await waitFor(() => expect(api.confirmAdminEmailReceipt).toHaveBeenCalledWith(21, { kind: 'infrastructure' }));
  // What the screen shows afterwards is what the server saved.
  await waitFor(() => expect(api.getAdminMoneyHub).toHaveBeenCalledTimes(2));
});

test('"Not a Flock bill" goes to the server and re-reads the hub', async () => {
  const pending = { id: 22, vendor: 'A Shop', product: 'Sensor board', amountCents: 3805, currency: 'USD', paidOn: '2026-11-03', cadence: 'one_time', status: 'new', receivedAt: '2026-11-04T00:00:00.000Z' };
  await renderHub({ ...HUB, emailReceipts: { ...RECEIPTS, pending: [pending], recent: [] } });
  const row = cardOf('From your email').querySelector('[data-hub-receipt="22"]');
  expect(within(row).getByText('$38.05 once')).toBeInTheDocument();
  api.dismissAdminEmailReceipt.mockResolvedValue({ success: true, status: 'dismissed' });
  fireEvent.click(within(row).getByRole('button', { name: 'Not a Flock bill: A Shop, Sensor board' }));
  await waitFor(() => expect(api.dismissAdminEmailReceipt).toHaveBeenCalledWith(22));
  await waitFor(() => expect(api.getAdminMoneyHub).toHaveBeenCalledTimes(2));
  expect(api.confirmAdminEmailReceipt).not.toHaveBeenCalled();
});

test('a receipt the server could not read is in Needs you by its sender and subject, and Done clears it', async () => {
  const check = { id: 31, vendor: 'Example Labs, PBC', product: null, amountCents: null, currency: null, paidOn: null, status: 'to_check', reason: 'The amount paid could not be found.', sender: 'invoice+statements@mail.example-labs.test', subject: 'Your receipt from Example Labs, PBC #1000-4001', receivedAt: '2026-11-14T04:40:00.000Z' };
  await renderHub({ ...HUB, emailReceipts: { ...RECEIPTS, toCheck: [check], recent: [] } });
  const need = needRow('Receipt to check');
  expect(need.textContent).toMatch(/Your receipt from Example Labs, PBC #1000-4001, from invoice\+statements@mail\.example-labs\.test\. The hub could not record it on its own: open it in Gmail and record the bill if it is Flock's\./);
  const row = cardOf('From your email').querySelector('[data-hub-receipt="31"]');
  expect(within(row).getByText('To check')).toBeInTheDocument();
  expect(row.textContent).toMatch(/From invoice\+statements@mail\.example-labs\.test, Nov 14(, 2026)?\. The amount paid could not be found\./);
  api.dismissAdminEmailReceipt.mockResolvedValue({ success: true, status: 'checked' });
  fireEvent.click(within(row).getByRole('button', { name: 'Done: Your receipt from Example Labs, PBC #1000-4001' }));
  await waitFor(() => expect(api.dismissAdminEmailReceipt).toHaveBeenCalledWith(31));
  await waitFor(() => expect(api.getAdminMoneyHub).toHaveBeenCalledTimes(2));
});

test('before the first receipt the card is one line, and the emails dropped are counted behind a tap', async () => {
  const ignored = { since: '2026-11-20T10:00:00.000Z', total: 2, byReason: [{ reason: 'not_forwarded', count: 1, words: 'not forwarded by a Gmail filter' }, { reason: 'not_a_receipt', count: 1, words: 'a notice, not a receipt' }] };
  await renderHub({ ...HUB, emailReceipts: { ...RECEIPTS, recent: [], thisMonth: 0, lastReceivedAt: null, ignored } });
  const card = cardOf('From your email');
  expect(within(card).getByText('No receipts yet. Each receipt your Gmail forwards shows here once it is read.')).toBeInTheDocument();
  expect(card.querySelector('.hub-chips')).toBeNull();
  const why = within(card).getByText('How this works').closest('details');
  expect(why.textContent).toMatch(/Dropped since the server last started, with nothing stored: 2 emails \(not forwarded by a Gmail filter: 1; a notice, not a receipt: 1\)\./);
  expect(why.textContent).toMatch(/the receipts@ address Resend receives for Flock/);
});

test('a payload from before the receipts draws no card, and a read that failed is in Needs you', async () => {
  const { unmount } = await renderHub(HUB);
  expect(screen.queryByRole('heading', { name: 'From your email' })).toBeNull();
  unmount();
  await renderHub({ ...HUB, emailReceipts: { ...RECEIPTS, status: 'error', reason: 'The receipts from email could not be read.', recent: [] } });
  const need = needRow('Receipts from email');
  expect(within(need).getByText('Not read')).toBeInTheDocument();
  expect(need.textContent).toMatch(/The receipts from email could not be read\. New bills and receipts to check were not looked at\./);
  expect(within(cardOf('From your email')).queryByText(/No receipts yet/)).toBeNull();
});
