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
const { render, screen, fireEvent, waitFor, within } = require('@testing-library/react');

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
    cancelFlockPlan: fn(),
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
  /* THE BAR IS A 24pt HEADER PILL NOW. Its wording and its green both moved
     with it and nothing this file is about did: these tests are here because a
     bill must not read as fully settled over a share the viewer cannot see,
     and because the tally has to come from the server rather than from the
     rows that survived the block filter.

     The pill says "$300.00 · 2/3" and "$300.00 · settled" where the bar said
     "2/3 settled" and "All settled up", so the assertions read the halves that
     carry meaning rather than a sentence that no longer exists. Its green is a
     flat backgroundColor, which is also why the gradient note above this line
     stopped mattering: jsdom dropped that gradient outright and the helper
     existed to work around it. */
  const GREEN_PILL = 'rgba(34, 197, 94, 0.22)';

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
    expect(bar.textContent).toContain('2/3');
    // The word the pill uses for a bill that IS square. Two of three is not it.
    expect(bar.textContent).not.toContain('settled');
    expect(bar.style.backgroundColor).not.toBe(GREEN_PILL);
  });

  test('and does go green when every row is settled', () => {
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { settled: true, outstanding: 0, settledAt: 'now' }),
    ]));
    const bar = screen.getByLabelText('Open bill split details');
    expect(bar.textContent).toContain('settled');
    expect(bar.style.backgroundColor).toBe(GREEN_PILL);
  });
});

// ---------------------------------------------------------------------------
// 4. A withheld figure is words
// ---------------------------------------------------------------------------
describe('a shell whose figures are withheld prints no bare dollar sign', () => {
  test('the estimate and every row say what the budget pill says', () => {
    // billing.js sends null for every money field on a shell while the
    // budget's number is not being shown. Fails without the fix: the sheet
    // read "Total: $" over two rows that read "$" beside "Owes".
    const { container } = mount(bill([
      share(9, 'Jay', null, { paidAmount: null, outstanding: null, committed: true }),
      share(3, 'Cy', null, { paidAmount: null, outstanding: null, committed: true }),
    ], { hasPayer: false, paidBy: { id: null, name: null }, totalAmount: null, totalWithTip: null }));

    expect(screen.getByText('Estimated share · no group number to show')).toBeTruthy();
    expect(screen.getAllByText('no group number to show')).toHaveLength(2);
    expect(screen.queryByText('Owes')).toBeNull();
    // No "$" anywhere that is not followed by a digit.
    expect(container.textContent).not.toMatch(/\$(?!\d)/);
    expect(container.textContent).not.toMatch(/undefined|NaN|null/);
    // And the header pill, which already guarded the figure, now has nothing
    // to count either: nobody settles a bill nobody has paid, so a shell's
    // "0/2" was a count of nothing. With no figure it is the plain door.
    const pill = screen.getByLabelText('Open bill split details').textContent;
    expect(pill).toBe('Bill');
  });
});

// ---------------------------------------------------------------------------
// 4b. A shell is an estimate, not a bill anybody owes on
// ---------------------------------------------------------------------------
describe('a payerless shell shows the per-person estimate and nothing owed', () => {
  test('one commit on a $40 budget in a flock of four is "~$40.00 each", not "$160.00 · 0/1"', () => {
    // Ghost-commit writes the ceiling into the share and ceiling * members
    // into the total, so the shell served back is $160 over one $40 row.
    // Fails without the fix: the pill read "$160.00 · 0/1" and the sheet
    // "Total: $160.00" over a row reading "$40.00 Owes".
    const { container } = mount(
      bill([share(9, 'Jay', 40, { committed: true })], {
        hasPayer: false, paidBy: { id: null, name: null }, totalAmount: 160, totalWithTip: 160,
        fullySettled: false, settledCount: 0, shareCount: 1,
      }),
      { budgetStatus: { budgetEnabled: true, budgetLocked: true, ceiling: 40, submissionCount: 4, totalMembers: 4, memberCount: 4, isReady: true } }
    );
    const pill = screen.getByLabelText('Open bill split details').textContent;
    expect(pill).toBe('~$40.00 each');
    expect(pill).not.toMatch(/160|0\/1/);
    expect(screen.getByText('Estimated share: $40.00 each')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Total/);
    expect(container.textContent).not.toMatch(/160/);
    expect(screen.queryByText('Owes')).toBeNull();
    // The row still says what it is, on the sheet and on the card in the stream.
    expect(screen.getAllByText('Pre-committed').length).toBeGreaterThan(0);
  });

  test('the estimate is the live settled number when a committed row is older than it', () => {
    // A shell left from before the budget was started over can hold a row at
    // the old cap. The header, the sheet and the card all quote the number
    // the budget sheet shows beside them.
    mount(
      bill([share(9, 'Jay', 40, { committed: true })], {
        hasPayer: false, paidBy: { id: null, name: null }, totalAmount: 160, totalWithTip: 160, shareCount: 1, settledCount: 0,
      }),
      { budgetStatus: { budgetEnabled: true, budgetLocked: true, ceiling: 30, submissionCount: 4, totalMembers: 4, memberCount: 4, isReady: true } }
    );
    expect(screen.getByLabelText('Open bill split details').textContent).toBe('~$30.00 each');
    expect(screen.getByText('Estimated share: $30.00 each')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4b2. A posted bill whose payer deleted their account is a bill
// ---------------------------------------------------------------------------
describe('a posted bill whose payer deleted their account is drawn as a bill, not an estimate', () => {
  // bill_splits.paid_by is ON DELETE SET NULL, so GET /api/billing/:flockId
  // serves this bill with hasPayer false, like a shell, and with estimate
  // false, which a shell never has. Fails without the fix: the pill read
  // "~$40.00 each" off the settled budget, the sheet "Estimated share: $40.00
  // each" over "Nobody has paid yet", and Ava's paid row sat under that line.
  const payerGone = () => bill([
    share(2, 'Ava', 45, { committed: true, settled: true, outstanding: 0 }),
    share(9, 'Jay', 45, { committed: true }),
    share(3, 'Cy', 45, { committed: true }),
  ], { hasPayer: false, estimate: false, paidBy: { id: null, name: null }, totalAmount: 180, totalWithTip: 180 });
  const settledBudget = {
    budgetStatus: { budgetEnabled: true, budgetLocked: true, ceiling: 40, submissionCount: 4, totalMembers: 4, memberCount: 4, isReady: true },
  };

  test('the pill, the sheet and the card carry the real total and count, and nothing reads as an estimate', () => {
    const { container } = mount(payerGone(), settledBudget);
    expect(screen.getByLabelText('Open bill split details').textContent).toBe('$180.00 · 1/3');
    expect(screen.getByText('Total: $180.00')).toBeTruthy();
    expect(screen.getByText('Paid by someone who has deleted their account. There is nobody left to pay here.')).toBeTruthy();
    expect(screen.getAllByText('$45.00')).toHaveLength(3);
    // The card in the stream says the same.
    expect(screen.getByText('Bill $180')).toBeTruthy();
    expect(screen.getByText('Paid by someone who has deleted their account')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Estimated share|Nobody has paid yet|~\$/);
  });

  test('nobody is offered a way to pay a payer who is not there', () => {
    mount(payerGone(), settledBudget);
    expect(screen.queryByRole('button', { name: /Settle Up/ })).toBeNull();
    expect(screen.queryByText('Mark as Paid (cash or other)')).toBeNull();
    expect(screen.queryByText('Owes')).toBeNull();
  });

  test('somebody who paid before the payer left cannot take it back, because it could never be marked again', () => {
    mount(payerGone(), { ...settledBudget, authUser: { id: 2, name: 'Ava' } });
    expect(screen.queryByText('That was a mistake, I have not paid')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  test('the bill form still opens over it, which is the way out the server names', () => {
    mount(payerGone(), { ...settledBudget, showCreateBill: true });
    expect(screen.getByText('Who paid?')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4c. A real bill whose total is withheld from this viewer
// ---------------------------------------------------------------------------
test('a bill total withheld from a viewer with a hidden share says so without the budget\'s words', () => {
  // billing.js sends a null total to a viewer who has somebody's share hidden
  // by a block, because the total less the visible rows is that share.
  // "no group number to show" is the budget's sentence and is false here.
  const { container } = mount(bill([
    share(1, 'Ava', 30, { settled: true, outstanding: 0 }),
    share(9, 'Jay', 30),
  ], { totalAmount: null, totalWithTip: null, shareCount: 3, settledCount: 1 }));
  expect(screen.getByText('Total · not shown')).toBeTruthy();
  expect(container.textContent).not.toMatch(/no group number/);
  expect(container.textContent).not.toMatch(/\$(?!\d)/);
  expect(screen.getByLabelText('Open bill split details').textContent).toBe('1/3');
});

// ---------------------------------------------------------------------------
// 4c2. A quarantined bill carries its members' names and nothing else
// ---------------------------------------------------------------------------
describe('a quarantined bill shows who was on it and no figure, count or action', () => {
  // routes/billing.js quarantines a bill from before August 27 (migration
  // 089), when an early pre-commit could copy one person's budget answer into
  // it. GET sends every amount, total, settled flag and count as null, to
  // everyone, the share's own member included, and refuses to post over it,
  // settle it or take a settlement back. Jay (the viewer) is on it.
  const withheld = { paidAmount: null, outstanding: null, committed: null, settled: null };
  const frozen = (over = {}) => bill([
    share(1, 'Ava', null, withheld),
    share(9, 'Jay', null, withheld),
    share(3, 'Cy', null, withheld),
  ], {
    quarantined: true,
    estimate: false,
    totalAmount: null,
    tipPercent: null,
    totalWithTip: null,
    splitType: null,
    fullySettled: null,
    settledCount: null,
    shareCount: null,
    ...over,
  });
  const settledBudget = {
    getSelectedFlock: () => ({ ...FLOCK, budgetEnabled: true }),
    budgetStatus: { budgetEnabled: true, budgetLocked: true, ceiling: 40, submissionCount: 3, totalMembers: 3, memberCount: 3, isReady: true, userSubmitted: true },
  };

  test('every row and the total say "not shown", the pill says Bill, and the card and the sheet say why', () => {
    const { container } = mount(frozen());
    expect(screen.getAllByText('not shown')).toHaveLength(3);
    expect(screen.getByText('Total · not shown')).toBeTruthy();
    expect(screen.getByText('This bill is from before August 27. Its amounts are no longer shown, and it can no longer be settled here.')).toBeTruthy();
    expect(screen.getByText('Amounts on bills from before August 27 are no longer shown.')).toBeTruthy();
    // No "0/3": the settled flags are withheld, so there is nothing to count.
    expect(screen.getByLabelText('Open bill split details').textContent).toBe('Bill');
    expect(container.querySelector('[data-bill-quarantined="true"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\$|undefined|NaN|null|Owes|Pre-committed|All settled up|of 3 settled|no group number|Estimated share/);
  });

  test('nobody is offered a way to settle, mark paid or take a payment back, their own row included', () => {
    const { container } = mount(frozen(), settledBudget);
    expect(screen.queryByRole('button', { name: /Settle Up|Settle up/ })).toBeNull();
    expect(screen.queryByText('Mark as Paid (cash or other)')).toBeNull();
    expect(screen.queryByText('That was a mistake, I have not paid')).toBeNull();
    expect(screen.queryByRole('button', { name: /Undo|Commit|Mark as paid/ })).toBeNull();
    // Nor a Split the Bill that would open a form the server refuses.
    expect(screen.queryByRole('button', { name: 'Split the Bill' })).toBeNull();
    const card = container.querySelector('[data-card="bill"]');
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  test('the bill form does not open over it, even over a payerless copy, and the bill stays readable', () => {
    // A payerless shell is the one bill the form opens over. A quarantined
    // one is refused by POST /api/billing/create, so the form stays shut and
    // the sheet keeps showing the bill instead.
    mount(frozen({ hasPayer: false, paidBy: { id: null, name: null } }), { showCreateBill: true });
    expect(screen.queryByText('Who paid?')).toBeNull();
    expect(screen.getByText('Total · not shown')).toBeTruthy();
    expect(screen.getAllByText('not shown')).toHaveLength(3);
  });

  test('without a budget, the sheet offers no Split the Bill over it either', () => {
    mount(frozen({ hasPayer: false, paidBy: { id: null, name: null } }));
    expect(screen.queryByRole('button', { name: 'Split the Bill' })).toBeNull();
    expect(screen.queryByText('Split the bill after the night out')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4d. A flock too small to settle is judged on members, not on guests
// ---------------------------------------------------------------------------
describe('the three-amount rule, with guests on the plan', () => {
  const guestFlock = { ...FLOCK, budgetEnabled: true, status: 'planning' };
  const status = (over) => ({
    budgetEnabled: true, budgetLocked: false, ceiling: null, isReady: false, skipCount: null,
    userSubmitted: true, userAmount: 40, userSkipped: false, ...over,
  });

  test('two members and a guest who have all answered are told the flock is too small, not that a number is coming', () => {
    // Fails without the fix: totalMembers (3) counted the guest, so the sheet
    // said a number appears once three people have shared, which three had.
    const { container } = mount(null, {
      getSelectedFlock: () => guestFlock,
      budgetStatus: status({ submissionCount: 3, totalMembers: 3, memberCount: 2 }),
    });
    expect(screen.getByText('No group number for a flock this size')).toBeTruthy();
    expect(container.textContent).toMatch(/There are 2 of you in the chat\./);
    expect(container.textContent).toMatch(/Guest answers from the link do not count toward the three\./);
    expect(screen.queryByText('Waiting on more answers')).toBeNull();
    expect(container.textContent).toMatch(/No group number in a flock this size/);
  });

  test('three members and a guest are waiting, and the rule names who counts', () => {
    const { container } = mount(null, {
      getSelectedFlock: () => guestFlock,
      budgetStatus: status({ submissionCount: 2, totalMembers: 4, memberCount: 3 }),
    });
    expect(screen.getByText('Waiting on more answers')).toBeTruthy();
    expect(container.textContent).toMatch(/only if at least three people in the group chat shared an amount\. Skips and guest answers do not count towards those three\./);
    expect(container.textContent).toMatch(/Waiting on amounts · 2 of 4 answered/);
  });

  test('a server that does not send memberCount keeps the old reading rather than none', () => {
    const { container } = mount(null, {
      getSelectedFlock: () => guestFlock,
      budgetStatus: status({ submissionCount: 2, totalMembers: 2 }),
    });
    expect(screen.getByText('No group number for a flock this size')).toBeTruthy();
    expect(container.textContent).toMatch(/There are 2 of you in the chat\./);
    expect(container.textContent).not.toMatch(/Guest answers from the link do not count/);
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


// ---------------------------------------------------------------------------
// 7. Adversarial audit, round 2 (2026-09-05): the figure after a settlement
//    moves, and a header that trusts the server for the rows it cannot see.
// ---------------------------------------------------------------------------
describe('taking a settlement back restores the figure Settle Up asks for', () => {
  const api = require('../services/api');
  const UNDO = 'That was a mistake, I have not paid';

  test('the local reducer recomputes outstanding from the share and its credit', async () => {
    // GET serves a settled row with outstanding 0; flipping the flag alone
    // left that zero, so the button read "Settle Up · $0.00". Fails without
    // the fix: outstanding stays 0 and the tally is not applied.
    api.unsettleShare.mockResolvedValueOnce({ settled: false, shareCount: 2, settledCount: 1, fullySettled: false });
    const setBillSplit = jest.fn();
    const before = bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { paidAmount: 30, outstanding: 0, settled: true, settledAt: 'now' }),
    ]);
    mount(before, { setBillSplit });
    fireEvent.click(screen.getByText(UNDO));
    await waitFor(() => expect(setBillSplit).toHaveBeenCalledTimes(1));
    const after = setBillSplit.mock.calls[0][0](before);
    const jay = after.shares.find((s) => s.userId === 9);
    expect(jay.settled).toBe(false);
    expect(jay.settledAt).toBeNull();
    expect(jay.outstanding).toBe(70);
    expect(after.settledCount).toBe(1);
    expect(after.shareCount).toBe(2);
    expect(after.fullySettled).toBe(false);
  });

  test('marking paid zeroes the figure and takes the tally off the response', async () => {
    api.settleShare.mockResolvedValueOnce({ settled: true, shareCount: 2, settledCount: 2, fullySettled: true });
    const setBillSplit = jest.fn();
    const before = bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { paidAmount: 30, outstanding: 70 }),
    ]);
    mount(before, { setBillSplit });
    fireEvent.click(screen.getByText('Mark as Paid (cash or other)'));
    await waitFor(() => expect(setBillSplit).toHaveBeenCalledTimes(1));
    const after = setBillSplit.mock.calls[0][0](before);
    expect(after.shares.find((s) => s.userId === 9)).toMatchObject({ settled: true, outstanding: 0 });
    expect(after).toMatchObject({ shareCount: 2, settledCount: 2, fullySettled: true });
  });

  test('an older response with no tally leaves the counts alone', async () => {
    api.unsettleShare.mockResolvedValueOnce({ settled: false });
    const setBillSplit = jest.fn();
    const before = bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { paidAmount: 30, outstanding: 0, settled: true, settledAt: 'now' }),
    ], { shareCount: 3, settledCount: 3, fullySettled: true });
    mount(before, { setBillSplit });
    fireEvent.click(screen.getByText(UNDO));
    await waitFor(() => expect(setBillSplit).toHaveBeenCalledTimes(1));
    const after = setBillSplit.mock.calls[0][0](before);
    expect(after.shareCount).toBe(3);
    expect(after.settledCount).toBe(3);
  });

  // Leaving the chat runs setBillSplit(null) in App.js. A settle or undo that
  // answers after that used to throw "Cannot read properties of null (reading
  // 'shares')" inside the updater; both updaters now hand null straight back.
  test('a settle that lands after the chat was left leaves the cleared bill cleared', async () => {
    api.settleShare.mockResolvedValueOnce({ settled: true, shareCount: 2, settledCount: 2, fullySettled: true });
    const setBillSplit = jest.fn();
    mount(bill([share(1, 'Ava', 100), share(9, 'Jay', 100, { paidAmount: 30, outstanding: 70 })]), { setBillSplit });
    fireEvent.click(screen.getByText('Mark as Paid (cash or other)'));
    await waitFor(() => expect(setBillSplit).toHaveBeenCalledTimes(1));
    expect(() => setBillSplit.mock.calls[0][0](null)).not.toThrow();
    expect(setBillSplit.mock.calls[0][0](null)).toBeNull();
  });

  test('an undo that lands after the chat was left leaves the cleared bill cleared', async () => {
    api.unsettleShare.mockResolvedValueOnce({ settled: false, shareCount: 2, settledCount: 1, fullySettled: false });
    const setBillSplit = jest.fn();
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { paidAmount: 30, outstanding: 0, settled: true, settledAt: 'now' }),
    ]), { setBillSplit });
    fireEvent.click(screen.getByText(UNDO));
    await waitFor(() => expect(setBillSplit).toHaveBeenCalledTimes(1));
    expect(() => setBillSplit.mock.calls[0][0](null)).not.toThrow();
    expect(setBillSplit.mock.calls[0][0](null)).toBeNull();
  });
});

describe('the header counts the rows the viewer cannot see from the server\'s tally', () => {
  test('a hidden settled row is counted from the first render', () => {
    // Two visible rows, one settled; a third, blocked, settled. The header
    // used to count the visible array on its own: "1/3 settled".
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100),
    ], { shareCount: 3, settledCount: 2, fullySettled: false }));
    expect(screen.getByLabelText('Open bill split details').textContent).toContain('2/3');
  });

  test('a square bill the viewer cannot fully see is square only when the server says so', () => {
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { settled: true, outstanding: 0, settledAt: 'now' }),
    ], { shareCount: 3, settledCount: 3, fullySettled: true }));
    expect(screen.getByLabelText('Open bill split details').textContent).toContain('settled');
  });

  test('an optimistic local settle still moves the header before the server confirms it', () => {
    // The array carries a settle the tally has not caught up with yet: the
    // larger of the two sources wins.
    mount(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0 }),
      share(9, 'Jay', 100, { settled: true, outstanding: 0, settledAt: 'now' }),
    ], { shareCount: 2, settledCount: 1, fullySettled: false }));
    expect(screen.getByLabelText('Open bill split details').textContent).toContain('settled');
  });
});
