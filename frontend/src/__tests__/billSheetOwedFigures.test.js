// ---------------------------------------------------------------------------
// THE BILL SHEET AND WHAT IT SAYS IS OWED, RENDERED (2026-09-04).
//
// Commit ce06574 gave every share two more numbers: `paidAmount`, the credit
// carried across a bill edit, and `outstanding`, the share less that credit.
// /payment-links asks for the outstanding figure. The sheet kept printing the
// whole share, so Ben, who had paid $30 against a share that was raised to
// $100, read "$100.00 Owes" on his row and "Settle Up · $100.00" on the button
// while the picker that opened from it asked him for $70. Four more things
// were found beside that one, and each is rendered here with a bill that has
// the defect in it, so that the fix is watched rather than read about:
//
//   1. The row and the button say what is left, and what is owed back.
//   2. "That was a mistake, I have not paid" is not offered on a share the
//      server will refuse to unsettle (409 reason 'credit').
//   3. The bar's green ground reads the same tally as its own sentence.
//   4. A withheld figure (a shell under three sharers sends null) is words,
//      not "Total: $" and a bare "$".
//
// Two more are in App.js and FlockDetail.js, which do not mount on their own,
// and are pinned at source at the bottom.
//
// The screen is mounted the way chatComposerAndInviteSheet.test.js mounts it:
// a hand-built props object, no App.js anywhere near it. That file proves the
// props list is complete against the screen's parameter list; this one copies
// the list and overrides the money.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test billSheetOwedFigures --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  BASE_URL: 'http://test.invalid',
  leaveFlock: jest.fn(),
  createBillSplit: jest.fn(),
  createFlockInviteLink: jest.fn(),
  getBillSplit: jest.fn(),
  getFlockMessageImage: jest.fn(),
  getPaymentLinks: jest.fn(),
  ghostCommit: jest.fn(),
  lockBudget: jest.fn(),
  sendBudgetReminder: jest.fn(),
  settleShare: jest.fn(),
  submitBudget: jest.fn(),
  trackNotificationPermission: jest.fn(),
  unsettleShare: jest.fn(),
}));
jest.mock('../services/socket', () => ({
  leaveFlock: jest.fn(),
  getSocket: jest.fn(() => ({ connected: true })),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(() => 'granted'),
  requestNotificationPermission: jest.fn(),
}));

const ChatDetail = require('../screens/ChatDetail').default;

// The viewer is user 9, "Jay". Ava (1) paid the bill.
const ME = { id: 9, name: 'Jay' };
const FLOCK = {
  id: 1,
  name: 'Friday',
  creatorId: 1,
  status: 'confirmed',
  members: [],
  messages: [],
  memberCount: 3,
};

function chatProps(over = {}) {
  const fn = () => jest.fn();
  return {
    ChatSkeleton: () => null,
    DM_PAGE_SIZE: 50,
    DialogBehavior: () => null,
    ListSkeleton: () => null,
    MOMENTUM_STAGES: [],
    SearchInputLocal: () => null,
    VenueCard: () => null,
    colorsLight: {},
    crowdColorFor: () => '#000000',
    memberCountLabel: () => '3 people',
    messagePreview: () => '',
    momentumStageKey: () => 'planning',
    oldestServerId: () => null,
    onVenuePhotoError: fn(),
    paymentRoutes: () => [],
    resolveVenuePhoto: () => null,
    voteTotal: () => 0,
    MissingFlockPanel: () => null,
    addReactionToMessage: fn(),
    allVenues: [],
    authUser: ME,
    billPaidBy: null,
    billSplit: null,
    billTip: '',
    billTotal: '',
    budgetAmount: '',
    budgetCustom: '',
    budgetFilteredVenues: [],
    budgetStatus: null,
    budgetSubmitting: false,
    chatEndRef: { current: null },
    chatGalleryInputRef: { current: null },
    chatInputHasText: false,
    chatNavOpen: false,
    chatNearBottomRef: { current: true },
    chatSearch: '',
    chatSearchRef: { current: null },
    colors: {},
    confirmClick: fn(),
    confirmFlockPlan: fn(),
    copiedInviteUrl: '',
    crowdPredictions: {},
    dismissNotifAsk: fn(),
    flockAtTop: true,
    flockInviteAllFriends: [],
    flockInviteCandidates: [],
    flockInviteFriendsError: '',
    flockInviteFriendsLoading: false,
    flockInvitePulses: {},
    flockInviteRest: [],
    flockInviteResults: [],
    flockInviteSearch: '',
    flockInviteSelected: [],
    flockInviteSending: false,
    flockMemberLocations: {},
    getCategoryColor: () => '#000000',
    getMaxPriceLevel: () => 2,
    getRelativeTime: () => 'now',
    getSelectedFlock: () => FLOCK,
    handleChatImageSelect: fn(),
    handleChatInputChange: fn(),
    handleFlockInviteSearch: fn(),
    handleSendFlockInvites: fn(),
    isDark: false,
    isLoading: false,
    isTyping: false,
    loadFlockInviteFriends: fn(),
    loadOlderFlockMessages: fn(),
    loadPopularVenues: fn(),
    locationBannerDismissed: true,
    messagesLoading: false,
    notifAskDismissed: true,
    notifStatus: 'granted',
    olderLoading: false,
    openCameraViewfinder: fn(),
    openVenueDetail: fn(),
    loadFlockVotes: fn(),
    openBirdie: fn(),
    votesError: '',
    pendingImage: null,
    popularVenues: [],
    profilePic: null,
    renderFlockInviteRow: () => null,
    retryFailedMessage: fn(),
    discardFailedMessage: fn(),
    selectedFlockId: 1,
    sendChatMessage: fn(),
    setBillPaidBy: fn(),
    setBillSplit: fn(),
    setBillTip: fn(),
    setBillTotal: fn(),
    setBudgetAmount: fn(),
    setBudgetCustom: fn(),
    setBudgetStatus: fn(),
    setBudgetSubmitting: fn(),
    setChatInput: fn(),
    setChatNavOpen: fn(),
    setChatSearch: fn(),
    setCopiedInviteUrl: fn(),
    setCurrentScreen: fn(),
    setCurrentTab: fn(),
    setFlockInviteSearch: fn(),
    setFlockInviteSelected: fn(),
    setFlocks: fn(),
    setIsLoading: fn(),
    setLocationBannerDismissed: fn(),
    setModerationTarget: fn(),
    setNotifStatus: fn(),
    setPaymentOptions: fn(),
    setPendingImage: fn(),
    setPickingVenueForCreate: fn(),
    setPickingVenueForFlockId: fn(),
    setShowChatPool: fn(),
    setShowChatSearch: fn(),
    setShowCreateBill: fn(),
    setShowFlockInviteModal: fn(),
    setShowFlockMenu: fn(),
    setShowImagePreview: fn(),
    setShowLeaveConfirm: fn(),
    setShowPaymentPicker: fn(),
    setShowReactionPicker: fn(),
    setShowVenueShareModal: fn(),
    setShowVotePanel: fn(),
    setVenueDetailReturnTo: fn(),
    shareImageToChat: fn(),
    shareVenueToChat: fn(),
    sharingLocationForFlock: null,
    sharingLocationRef: { current: null },
    showChatPool: true,
    showChatSearch: false,
    showCreateBill: false,
    showFlockInviteModal: false,
    showFlockMenu: false,
    showImagePreview: false,
    showLeaveConfirm: false,
    showReactionPicker: null,
    showToast: fn(),
    showVenueShareModal: false,
    showVotePanel: false,
    startSharingLocation: fn(),
    stopLocationSharing: fn(),
    styles: {},
    typingUser: '',
    updateFlockVenue: fn(),
    updateFlockVotes: fn(),
    userLocation: null,
    handleUnsendFlockMessage: fn(),
    eventCrowd: null,
    eventCrowdLabel: null,
    ...over,
  };
}

// A share as GET /api/billing/:flockId serves it since ce06574.
const share = (userId, name, amount, over = {}) => ({
  userId,
  name,
  amount,
  paidAmount: 0,
  outstanding: amount,
  committed: false,
  settled: false,
  settledAt: null,
  ...over,
});

const bill = (shares, over = {}) => ({
  id: 7,
  flockId: 1,
  totalAmount: 300,
  tipPercent: 0,
  totalWithTip: 300,
  splitType: 'equal',
  hasPayer: true,
  paidBy: { id: 1, name: 'Ava' },
  fullySettled: shares.every((s) => s.settled),
  settledCount: shares.filter((s) => s.settled).length,
  shareCount: shares.length,
  shares,
  createdAt: 'now',
  ...over,
});

const mount = (billSplit, over = {}) => render(React.createElement(ChatDetail, chatProps({ billSplit, ...over })));

// The style object the component handed React for this render. jsdom's CSS
// parser drops a linear-gradient outright (el.style.background reads ""), so
// the value is read back off the fiber's props, which is what React set the
// style from.
const styleProp = (el) => {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  expect(key).toBeDefined();
  return el[key].style;
};

// ---------------------------------------------------------------------------
// 1. What is left, and what is owed back
// ---------------------------------------------------------------------------
describe('a share row says what is still owed, not the whole share', () => {
  test('a part-paid share reads "left of", and Settle Up asks for the same figure', () => {
    // Fails without the fix: the row read "$100.00" beside "Owes" and the
    // button read "Settle Up · $100.00", while the picker it opens asked $70.
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { paidAmount: 30, outstanding: 70 }),
      share(3, 'Cy', 100),
    ]));
    expect(screen.getByText('$70.00 left of $100.00')).toBeTruthy();
    expect(screen.queryByText('$100.00 left of $100.00')).toBeNull();
    expect(screen.getByRole('button', { name: /Settle Up/ }).textContent).toBe('Settle Up · $70.00');
    // Ava (settled, nothing carried) and Cy (nothing paid) are the plain
    // share; only Cy gets the plain label, and Jay's row is not labelled twice.
    expect(screen.getAllByText('$100.00')).toHaveLength(2);
    expect(screen.getAllByText('Owes')).toHaveLength(1);
  });

  test('a payment larger than the revised share is shown as owed back', () => {
    // The bill came down after Jay paid. The row is settled, the payment is
    // the record of what he is owed, and "$80.00" with a tick would have said
    // the $20 did not exist.
    mount(bill([
      share(1, 'Ava', 80, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 80, { paidAmount: 100, outstanding: 0, settled: true, settledAt: 'then' }),
      share(3, 'Cy', 80),
    ]));
    expect(screen.getByText('paid $100.00, owed back $20.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Settle Up/ })).toBeNull();
  });

  test('a share with nothing paid against it is unchanged', () => {
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100),
    ]));
    expect(screen.getAllByText('$100.00')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Settle Up/ }).textContent).toBe('Settle Up · $100.00');
  });

  test('a body from before the credit column still gets a Settle Up figure', () => {
    // `outstanding ?? amount`: an older payload, or an optimistic local row,
    // has no outstanding field, and the button must not read "Settle Up · ".
    const old = { userId: 9, name: 'Jay', amount: 45.5, committed: false, settled: false };
    mount(bill([share(1, 'Ava', 45.5, { settled: true, outstanding: 0 }), old]));
    expect(screen.getByRole('button', { name: /Settle Up/ }).textContent).toBe('Settle Up · $45.50');
  });
});

// ---------------------------------------------------------------------------
// 2. The way back out of "I paid", only where the server would let you
// ---------------------------------------------------------------------------
describe('"That was a mistake, I have not paid" is not offered where it would be refused', () => {
  const UNDO = 'That was a mistake, I have not paid';

  test('hidden on a share settled by carried credit', () => {
    // POST /unsettle answers 409 reason 'credit' whenever paid_amount covers
    // the share. Fails without the fix: the button rendered and every tap
    // ended in the 409 toast.
    mount(bill([
      share(1, 'Ava', 80, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 80, { paidAmount: 100, outstanding: 0, settled: true, settledAt: 'then' }),
    ]));
    expect(screen.queryByText(UNDO)).toBeNull();
  });

  test('hidden when the credit is exactly the share', () => {
    mount(bill([
      share(1, 'Ava', 80, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 80, { paidAmount: 80, outstanding: 0, settled: true, settledAt: 'then' }),
    ]));
    expect(screen.queryByText(UNDO)).toBeNull();
  });

  test('still offered on a share settled by a tap', () => {
    // The mirror image, so the gate cannot be satisfied by never rendering
    // the button at all. A $30 credit under a $100 share was cleared by Mark
    // as Paid, and that is exactly the tap the button exists to take back.
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { paidAmount: 30, outstanding: 0, settled: true, settledAt: 'now' }),
    ]));
    expect(screen.getByText(UNDO)).toBeTruthy();
  });

  test('still offered on an optimistic local row that carries no credit fields', () => {
    const local = { userId: 9, name: 'Jay', amount: 50, committed: false, settled: true };
    mount(bill([share(1, 'Ava', 50, { settled: true, outstanding: 0 }), local]));
    expect(screen.getByText(UNDO)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. The bar's ground reads the tally its sentence reads
// ---------------------------------------------------------------------------
describe('the bill bar does not turn green over a share the viewer cannot see', () => {
  const GREEN = 'linear-gradient(135deg, #ecfdf5, #d1fae5)';

  test('two settled rows of three (one blocked) is not "all settled", in colour or in words', () => {
    // The server filters `shares` for a viewer who blocked a member and sends
    // the counts over every row. Fails without the fix: the ground tested the
    // two visible rows on its own and went green under a sentence that said
    // 2/3 settled.
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { settled: true, outstanding: 0, settledAt: 'now' }),
    ], { fullySettled: false, settledCount: 2, shareCount: 3 }));
    const bar = screen.getByLabelText('Open bill split details');
    expect(bar.textContent).toContain('2/3 settled');
    expect(bar.textContent).not.toContain('All settled up');
    expect(styleProp(bar).background).not.toBe(GREEN);
  });

  test('and does go green when every row is settled', () => {
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { settled: true, outstanding: 0, settledAt: 'now' }),
    ]));
    const bar = screen.getByLabelText('Open bill split details');
    expect(bar.textContent).toContain('All settled up');
    expect(styleProp(bar).background).toBe(GREEN);
  });
});

// ---------------------------------------------------------------------------
// 4. A withheld figure is words
// ---------------------------------------------------------------------------
describe('a shell whose figures are withheld prints no bare dollar sign', () => {
  test('the total and every row say what the budget pill says', () => {
    // billing.js sends null for every money field on a shell whose flock has
    // fallen under three present sharers. Fails without the fix: the sheet
    // read "Total: $" over two rows that read "$" beside "Owes".
    const { container } = mount(bill([
      share(9, 'Jay', null, { paidAmount: null, outstanding: null, committed: true }),
      share(3, 'Cy', null, { paidAmount: null, outstanding: null, committed: true }),
    ], { hasPayer: false, paidBy: { id: null, name: null }, totalAmount: null, totalWithTip: null }));

    expect(screen.getByText('Total · no group number to show')).toBeTruthy();
    expect(screen.getAllByText('no group number to show')).toHaveLength(2);
    expect(screen.queryByText('Owes')).toBeNull();
    // No "$" anywhere that is not followed by a digit.
    expect(container.textContent).not.toMatch(/\$(?!\d)/);
    expect(container.textContent).not.toMatch(/undefined|NaN|null/);
    // And the header bar, which already guarded this, still does.
    expect(screen.getByLabelText('Open bill split details').textContent).toContain('Bill: 0/2 settled');
  });
});

// ---------------------------------------------------------------------------
// 5 and 6. Source contracts for the two files that do not mount alone
// ---------------------------------------------------------------------------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('leaving a chat closes its cash pool sheet and bill form', () => {
  // showChatPool and showCreateBill live in FlockAppInner and were never
  // reset on exit. A bill_created push tap on a plan that had since been
  // deleted ran setShowChatPool(true), MissingFlockPanel rendered, and the
  // next chat opened with the sheet over it. Fails without the fix: the exit
  // branch resets the money state and nothing else.
  const app = read('App.js');
  const from = app.indexOf("} else if (currentScreen !== 'chatDetail' && prevFlockIdRef.current) {");
  const to = app.indexOf('}, [currentScreen, selectedFlockId, loadFlockVotes', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const exit = app.slice(from, to);
  expect(exit.length).toBeLessThan(1500);
  expect(exit).toContain('setBillSplit(null);');
  expect(exit).toContain('setShowChatPool(false);');
  expect(exit).toContain('setShowCreateBill(false);');
});

test('the lock-in hint does not say "unlocks"', () => {
  const detail = read('screens/FlockDetail.js');
  expect(detail).not.toMatch(/unlocks the done step/);
  expect(detail).toContain('Locking it in tells everyone the plan is on, and the done step appears afterwards.');
});
