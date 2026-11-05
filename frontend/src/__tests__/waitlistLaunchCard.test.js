// ---------------------------------------------------------------------------
// THE WAITLIST LAUNCH EMAIL CARD, RENDERED (the admin console's Overview).
//
// backend/__tests__/waitlistLaunchLoop.test.js proves the route: a dry run
// that only counts, batches of up to 100, each person marked before they are
// mailed, an early stop when the mail service stops answering, a 409 when the
// button would not open the App Store. This file proves the other half, the
// card that lets the owner send it from the phone:
//
//   * on open it runs the dry run and shows who will get it and who already
//     has, with the subject and the first line;
//   * nothing is sent until the app's own confirm sheet, which names the
//     number and the subject, is confirmed;
//   * a confirmed send calls the route again and again until nobody is left,
//     shows how far it has got, and ends with what happened: sent, skipped,
//     turned down, no answer with the ids, and why it stopped;
//   * an early stop, a call that moves nobody along, a timeout, a 409 and a
//     403 each end the run in plain words;
//   * a double tap starts one run, and a remount mid-run shows that run;
//   * nobody but an admin gets the card, or makes the dry run;
//   * the words on the card are the words the backend sends.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test waitlistLaunchCard --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor, within, act, configure } = require('@testing-library/react');

// The console is a heavy screen to render; the money hub's own suite gives
// its waits the same room (moneyHubOverview.test.js).
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
  getWaitlistLaunchCounts: jest.fn(),
  sendWaitlistLaunchBatch: jest.fn(),
  userMessage: jest.requireActual('../services/api').userMessage,
}));

const api = require('../services/api');
const RevenueScreen = require('../screens/RevenueScreen').default;
const {
  readWaitlistLaunch,
  resetWaitlistLaunchForTests,
  startWaitlistLaunch,
} = require('../lib/waitlistLaunch');

const COLORS = { navy: '#1f2a44', navyBg: '#1f2a44', navyMid: '#34405c', creamDark: '#ddd', cream: '#eee', amber: '#d97706', steel: '#4a7ba7' };
const ADMIN = { id: 1, role: 'admin', name: 'Admin' };

// Stands in for App.js's DialogBehavior the way the real one marks its
// parent, so the sheet can be found by its role and name.
function DialogStub({ label }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const node = ref.current && ref.current.parentElement;
    if (!node) return;
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    if (label) node.setAttribute('aria-label', label);
  }, [label]);
  return React.createElement('span', { ref, hidden: true });
}

function screenProps(over = {}) {
  const fn = () => jest.fn();
  return {
    DialogBehavior: DialogStub,
    adminTab: 'overview',
    authUser: ADMIN,
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
    operatingCostsSource: 'typed',
    researchDemoMode: false,
    researchError: false,
    researchLiveData: null,
    researchLoading: false,
    setAdminTab: fn(),
    setAvgSpend: fn(),
    setEventsPerVenue: fn(),
    setNumVenues: fn(),
    setOperatingCosts: fn(),
    setOperatingCostsSource: fn(),
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

const renderConsole = (over) => render(React.createElement(RevenueScreen, screenProps(over)));
// Source as text, with Windows line endings folded so a checkout that has
// them reads the same.
const readSource = (...parts) => fs.readFileSync(path.join(__dirname, ...parts), 'utf8').replace(/\r\n/g, '\n');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const counts = (over = {}) => ({ dry_run: true, total: 40, converted: 5, announced: 10, pending: 25, ...over });
const batch = (over = {}) => ({
  dry_run: false, batch: 0, sent: 0, suppressed: 0, failed: 0, unknown: 0, unknown_ids: [], stopped_early: false, remaining: 0, ...over,
});
const httpError = (status, message) => Object.assign(new Error(message), { status, userFacing: true });

async function findCard() {
  const heading = await screen.findByRole('heading', { name: 'Waitlist launch email' });
  return heading.parentElement;
}

// A HubRow's value, read beside its label.
function rowValue(card, label) {
  const labelEl = within(card).getByText(label);
  return labelEl.parentElement.lastElementChild.textContent;
}

async function openSheetAndConfirm(card, buttonName) {
  fireEvent.click(await within(card).findByRole('button', { name: buttonName }));
  const sheet = await screen.findByRole('dialog', { name: 'Send the waitlist launch email' });
  fireEvent.click(within(sheet).getByRole('button', { name: buttonName }));
  return sheet;
}

beforeEach(() => {
  resetWaitlistLaunchForTests();
  jest.resetAllMocks();
  // The hub's vendor read never answers here: the card must stand without it.
  api.getAdminMoneyHub.mockImplementation(() => new Promise(() => {}));
  api.getWaitlistLaunchCounts.mockResolvedValue(counts());
  api.sendWaitlistLaunchBatch.mockResolvedValue(batch({ batch: 25, sent: 25, remaining: 0 }));
});

describe('on open', () => {
  test('the dry run shows who will get it and who already has, with the subject and the first line', async () => {
    renderConsole();
    const card = await findCard();
    await within(card).findByText('Will get it');
    expect(rowValue(card, 'Will get it')).toBe('25 people');
    expect(rowValue(card, 'Already sent or skipped')).toBe('10 people');
    expect(within(card).getByText('Flock is on the App Store')).toBeTruthy();
    expect(within(card).getByText("You're off the waitlist.")).toBeTruthy();
    expect(within(card).getByText('Anyone who has made a Flock account is left out: 5 so far.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Send to 25 people' })).toBeTruthy();
    expect(api.getWaitlistLaunchCounts).toHaveBeenCalledTimes(1);
    expect(api.sendWaitlistLaunchBatch).not.toHaveBeenCalled();
  });

  test('one person reads as one person, and nobody waiting offers no send', async () => {
    api.getWaitlistLaunchCounts.mockResolvedValueOnce(counts({ pending: 1, announced: 1, converted: 0 }));
    const first = renderConsole();
    let card = await findCard();
    expect(await within(card).findByRole('button', { name: 'Send to 1 person' })).toBeTruthy();
    expect(rowValue(card, 'Already sent or skipped')).toBe('1 person');
    expect(within(card).queryByText(/made a Flock account/)).toBeNull();
    first.unmount();

    api.getWaitlistLaunchCounts.mockResolvedValueOnce(counts({ pending: 0, announced: 40, converted: 0 }));
    renderConsole();
    card = await findCard();
    expect(await within(card).findByText('Nobody is waiting for it.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^Send to/ })).toBeNull();
  });

  test('a dry run that fails says so, offers Check again, and offers no send', async () => {
    api.getWaitlistLaunchCounts.mockRejectedValueOnce(httpError(500, 'Something went wrong on our end. Try again.'));
    renderConsole();
    const card = await findCard();
    expect(await within(card).findByText('Something went wrong on our end. Try again.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^Send to/ })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Check again' }));
    expect(await within(card).findByRole('button', { name: 'Send to 25 people' })).toBeTruthy();
    expect(api.getWaitlistLaunchCounts).toHaveBeenCalledTimes(2);
  });

  test('a 403 on the dry run is said in plain words', async () => {
    api.getWaitlistLaunchCounts.mockRejectedValueOnce(httpError(403, 'Admin access required'));
    renderConsole();
    const card = await findCard();
    expect(await within(card).findByText(/The server says this account is not an admin, so it refused\./)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^Send to/ })).toBeNull();
  });
});

describe('the confirm sheet', () => {
  test('nothing is sent until the sheet is confirmed, and the sheet names the number and the subject', async () => {
    renderConsole();
    const card = await findCard();
    fireEvent.click(await within(card).findByRole('button', { name: 'Send to 25 people' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send the waitlist launch email' });
    expect(within(sheet).getByRole('heading', { name: 'Send to 25 people?' })).toBeTruthy();
    expect(sheet.textContent).toContain('“Flock is on the App Store”');
    expect(api.sendWaitlistLaunchBatch).not.toHaveBeenCalled();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.sendWaitlistLaunchBatch).not.toHaveBeenCalled();

    await openSheetAndConfirm(card, 'Send to 25 people');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1));
  });

  test('a tap on the backdrop closes the sheet and sends nothing', async () => {
    renderConsole();
    const card = await findCard();
    fireEvent.click(await within(card).findByRole('button', { name: 'Send to 25 people' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send the waitlist launch email' });
    fireEvent.click(sheet);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.sendWaitlistLaunchBatch).not.toHaveBeenCalled();
  });

  test('the card never reaches for the browser dialogs', () => {
    const src = readSource('..', 'screens', 'RevenueScreen.js');
    const card = src.slice(src.indexOf('// THE WAITLIST LAUNCH EMAIL'), src.indexOf('function MoneyHub('));
    expect(card.length).toBeGreaterThan(2000);
    expect(card).not.toMatch(/window\.(confirm|alert|prompt)|\b(confirm|alert|prompt)\(/);
    expect(card).toContain('<DialogBehavior onClose={() => setAsking(false)} label="Send the waitlist launch email" />');
  });
});

describe('a confirmed send', () => {
  test('calls the route again until nobody is left, shows how far it has got, and ends with the result', async () => {
    const calls = [deferred(), deferred(), deferred()];
    let n = 0;
    api.sendWaitlistLaunchBatch.mockImplementation(() => calls[n++].promise);
    api.getWaitlistLaunchCounts
      .mockResolvedValueOnce(counts({ pending: 250, announced: 0, converted: 0 }))
      .mockResolvedValueOnce(counts({ pending: 0, announced: 250, converted: 0 }));
    renderConsole();
    const card = await findCard();
    await openSheetAndConfirm(card, 'Send to 250 people');

    expect(await within(card).findByText('Sending the first batch. It can take a minute.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Sending' }).disabled).toBe(true);
    expect(within(card).queryByRole('button', { name: /^Send to/ })).toBeNull();

    await act(async () => { calls[0].resolve(batch({ batch: 100, sent: 100, remaining: 150 })); });
    expect(await within(card).findByText('Sent to 100 people so far. 150 still waiting.')).toBeTruthy();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(2);

    await act(async () => { calls[1].resolve(batch({ batch: 100, sent: 98, suppressed: 2, remaining: 50 })); });
    expect(await within(card).findByText('Sent to 198 people so far. 50 still waiting.')).toBeTruthy();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(3);

    await act(async () => { calls[2].resolve(batch({ batch: 50, sent: 49, unknown: 1, unknown_ids: [233], remaining: 0 })); });
    expect(await within(card).findByText('Done')).toBeTruthy();
    expect(rowValue(card, 'Sent')).toBe('247 people');
    expect(rowValue(card, 'Skipped')).toBe('2 people');
    expect(rowValue(card, 'No answer')).toBe('1 person');
    expect(within(card).getByText(/Look them up in Resend's log by waitlist id: 233\./)).toBeTruthy();
    expect(within(card).getByText('Nobody is left waiting.')).toBeTruthy();
    expect(within(card).queryByText('Turned down')).toBeNull();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(3);

    // The counts are read again as the run ends, so the button goes.
    expect(await within(card).findByText('Nobody is waiting for it.')).toBeTruthy();
    expect(api.getWaitlistLaunchCounts).toHaveBeenCalledTimes(2);
    expect(within(card).queryByRole('button', { name: /^Send to/ })).toBeNull();
  });

  test('an early stop says so and why, with the ids to check and who is still waiting', async () => {
    api.sendWaitlistLaunchBatch.mockResolvedValueOnce(batch({ batch: 3, unknown: 3, unknown_ids: [1, 2, 3], stopped_early: true, remaining: 22 }));
    api.getWaitlistLaunchCounts
      .mockResolvedValueOnce(counts())
      .mockResolvedValueOnce(counts({ pending: 22, announced: 13 }));
    renderConsole();
    const card = await findCard();
    await openSheetAndConfirm(card, 'Send to 25 people');
    expect(await within(card).findByText('Stopped')).toBeTruthy();
    expect(rowValue(card, 'Sent')).toBe('0 people');
    expect(rowValue(card, 'No answer')).toBe('3 people');
    expect(within(card).getByText(/Look them up in Resend's log by waitlist ids: 1, 2, 3\./)).toBeTruthy();
    expect(rowValue(card, 'Still waiting')).toBe('22 people');
    expect(within(card).getByText('The mail service stopped answering, so the server stopped sending. Send again once Resend is working.')).toBeTruthy();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1);
    // The rest are offered again once the counts are read.
    expect(await within(card).findByRole('button', { name: 'Send to 22 people' })).toBeTruthy();
  });

  test('a batch the mail service turned down in full stops the run instead of asking forever', async () => {
    api.sendWaitlistLaunchBatch
      .mockResolvedValueOnce(batch({ batch: 100, sent: 95, failed: 5, remaining: 5 }))
      .mockResolvedValueOnce(batch({ batch: 5, failed: 5, remaining: 5 }));
    api.getWaitlistLaunchCounts.mockResolvedValue(counts({ pending: 100, announced: 0 }));
    renderConsole();
    const card = await findCard();
    await openSheetAndConfirm(card, 'Send to 100 people');
    expect(await within(card).findByText('Stopped')).toBeTruthy();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(2);
    expect(rowValue(card, 'Sent')).toBe('95 people');
    expect(rowValue(card, 'Turned down')).toBe('5 people');
    expect(rowValue(card, 'Still waiting')).toBe('5 people');
    expect(within(card).getByText(/The mail service turned down every email in the last batch\./)).toBeTruthy();
  });

  test('a 409 is said in plain words and nothing more is asked', async () => {
    api.sendWaitlistLaunchBatch.mockRejectedValueOnce(httpError(409, "The launch email's button would not open the App Store listing (APP_STORE_URL overrides it with something else). Fix the link and try again."));
    renderConsole();
    const card = await findCard();
    await openSheetAndConfirm(card, 'Send to 25 people');
    expect(await within(card).findByText(/The server won't send it, because the email's button would not open Flock's App Store listing\. APP_STORE_URL on Railway points somewhere else\./)).toBeTruthy();
    expect(within(card).getByText('Stopped')).toBeTruthy();
    expect(rowValue(card, 'Sent')).toBe('0 people');
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1);
  });

  test('a 403 on the send is said in plain words', async () => {
    api.sendWaitlistLaunchBatch.mockRejectedValueOnce(httpError(403, 'Admin access required'));
    renderConsole();
    const card = await findCard();
    await openSheetAndConfirm(card, 'Send to 25 people');
    expect(await within(card).findByText('The server says this account is not an admin, so it refused. Sign out and back in with the admin account, then try again.')).toBeTruthy();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1);
  });

  test('a timeout says the batch may still be finishing on the server, and is not retried', async () => {
    api.sendWaitlistLaunchBatch.mockRejectedValueOnce(Object.assign(new Error('That took too long. Check your signal and try again.'), { isTimeout: true, isNetworkError: true }));
    renderConsole();
    const card = await findCard();
    await openSheetAndConfirm(card, 'Send to 25 people');
    expect(await within(card).findByText(/Lost touch with the server during a batch, so there is no word on how that batch went\. The server finishes it on its own, and nobody gets the email twice\./)).toBeTruthy();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1);
  });
});

describe('one run at a time', () => {
  test('two taps on the confirm button before a repaint start one run', async () => {
    const first = deferred();
    api.sendWaitlistLaunchBatch.mockImplementation(() => first.promise);
    renderConsole();
    const card = await findCard();
    fireEvent.click(await within(card).findByRole('button', { name: 'Send to 25 people' }));
    const sheet = await screen.findByRole('dialog', { name: 'Send the waitlist launch email' });
    const confirm = within(sheet).getByRole('button', { name: 'Send to 25 people' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1);
    expect(within(card).getByRole('button', { name: 'Sending' }).disabled).toBe(true);
    await act(async () => { first.resolve(batch({ batch: 25, sent: 25, remaining: 0 })); });
    expect(await within(card).findByText('Done')).toBeTruthy();
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1);
  });

  test('the run refuses to start a second time while one is going', async () => {
    const first = deferred();
    const send = jest.fn(() => first.promise);
    const run = startWaitlistLaunch({ send, expected: 10 });
    expect(run).not.toBeNull();
    expect(startWaitlistLaunch({ send, expected: 10 })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve(batch({ batch: 10, sent: 10, remaining: 0 }));
    const done = await run;
    expect(done.stop).toBe('done');
    // Once it has ended, a new run may start.
    const again = startWaitlistLaunch({ send: jest.fn(async () => batch()), expected: 0 });
    expect(again).not.toBeNull();
    expect((await again).stop).toBe('done');
  });

  test('a card that unmounts mid-run leaves the run going, and a card mounted again shows it', async () => {
    const first = deferred();
    api.sendWaitlistLaunchBatch.mockImplementation(() => first.promise);
    const view = renderConsole();
    let card = await findCard();
    await openSheetAndConfirm(card, 'Send to 25 people');
    expect(await within(card).findByText('Sending the first batch. It can take a minute.')).toBeTruthy();
    view.unmount();

    renderConsole();
    card = await findCard();
    expect(within(card).getByText('Sending the first batch. It can take a minute.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Sending' }).disabled).toBe(true);
    expect(within(card).queryByRole('button', { name: /^Send to/ })).toBeNull();
    await act(async () => { first.resolve(batch({ batch: 25, sent: 25, remaining: 0 })); });
    expect(await within(card).findByText('Done')).toBeTruthy();
    expect(rowValue(card, 'Sent')).toBe('25 people');
    expect(api.sendWaitlistLaunchBatch).toHaveBeenCalledTimes(1);
  });

  test('a run that keeps moving stops at its backstop', async () => {
    const send = jest.fn(async () => batch({ batch: 1, sent: 1, remaining: 1 }));
    const done = await startWaitlistLaunch({ send, expected: 1 });
    // One call for the one person counted, and five spare.
    expect(send).toHaveBeenCalledTimes(6);
    expect(done.stop).toBe('cap');
    expect(done.sent).toBe(6);
    expect(readWaitlistLaunch()).toBe(done);
  });
});

describe('who sees it, and where', () => {
  test.each([
    ['a member', { id: 2, role: 'user' }],
    ['a venue owner', { id: 3, role: 'venue_owner' }],
    ['nobody signed in', null],
  ])('%s gets no card and no dry run', async (_who, authUser) => {
    renderConsole({ authUser });
    // The hub's own card is there, so the screen did render.
    expect(await screen.findByText('Reading Stripe, RevenueCat, BestTime and the database')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Waitlist launch email' })).toBeNull();
    expect(api.getWaitlistLaunchCounts).not.toHaveBeenCalled();
  });

  test('it is the first card on the Overview, above the money hub, and on no other tab', async () => {
    const view = renderConsole();
    const card = await findCard();
    const hub = await screen.findByText('Reading Stripe, RevenueCat, BestTime and the database');
    // eslint-disable-next-line no-bitwise
    expect(card.compareDocumentPosition(hub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.unmount();

    renderConsole({ adminTab: 'projections' });
    expect(await screen.findByText('What-if simulator')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Waitlist launch email' })).toBeNull();
  });

  test('App.js hands the console the account and the dialog helper', () => {
    const app = readSource('..', 'App.js');
    const props = app.slice(app.indexOf('const revenueScreenProps = {'), app.indexOf('<RevenueScreen {...revenueScreenProps} />'));
    expect(props).toMatch(/\n\s+DialogBehavior,\n/);
    expect(props).toMatch(/\n\s+authUser,\n/);
  });
});

describe('the words and the route', () => {
  test('the subject and the first line are the ones the backend sends', () => {
    const email = readSource('..', '..', '..', 'backend', 'services', 'emailService.js');
    const fn = email.slice(email.indexOf('async function sendWaitlistLaunchEmail'), email.indexOf('module.exports'));
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).toContain("subject: 'Flock is on the App Store',");
    expect(fn).toContain('"You\'re off the waitlist.",');
    expect(fn).toContain(">You're off the waitlist.</h1>");
    const card = readSource('..', 'screens', 'RevenueScreen.js');
    expect(card).toContain("const WAITLIST_SUBJECT = 'Flock is on the App Store';");
    expect(card).toContain('const WAITLIST_FIRST_LINE = "You\'re off the waitlist.";');
  });

  test('both calls go to the admin route through the API client, the batch with the longest deadline', () => {
    const src = readSource('..', 'services', 'api.js');
    const counts = src.slice(src.indexOf('export async function getWaitlistLaunchCounts'), src.indexOf('export async function sendWaitlistLaunchBatch'));
    expect(counts).toContain("return request('/api/admin/waitlist/announce', {");
    expect(counts).toContain("method: 'POST',");
    expect(counts).toContain('body: JSON.stringify({ dry_run: true }),');
    const send = src.slice(src.indexOf('export async function sendWaitlistLaunchBatch'));
    const body = send.slice(0, send.indexOf('\n}\n'));
    expect(body).toContain("return request('/api/admin/waitlist/announce', {");
    expect(body).toContain('body: JSON.stringify({}),');
    expect(body).toContain('timeout: MAX_REQUEST_MS,');
    expect(body).not.toContain('dry_run');
  });
});
