// ---------------------------------------------------------------------------
// A BILL RE-READ THAT LANDS WHILE MARK AS PAID OR THE UNDO IS ON THE WIRE.
//
// Both actions flip the viewer's own row on the tap and put it back if the
// server refuses (setMyShare in ChatDetail.js). When the answer came back
// they applied the server's tallies and nothing else, on the reasoning that
// the row was already flipped. It was not always: App.js reads the bill again
// on its own (loadMoneyState, after another member's commit or a budget
// reset), and a read that lands mid-request replaces the whole bill with the
// server's copy from before the write. So the row read unpaid while the pill
// counted it paid, and stayed that way until the share_settled echo arrived,
// or never, on a socket that had dropped. Each answer now puts its own flip
// back on together with the tallies, as the code before the instant flip did.
//
// The screen is mounted the way billSheetOwedFigures.test.js mounts it, with a
// copy of its hand-built props object (chatComposerAndInviteSheet.test.js
// proves that list complete against the screen's parameters), and with the
// bill held in real state so the screen's own updaters run.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test billRowAfterReread --watchAll=false
// ---------------------------------------------------------------------------

const React = require('react');
const { render, screen, fireEvent, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  // The chat header's offline read (api.js isOffline). Online here.
  isOffline: () => false,
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
  userMessage: jest.requireActual('../services/api').userMessage,
}));
jest.mock('../services/socket', () => ({
  leaveFlock: jest.fn(),
  getSocket: jest.fn(() => ({ connected: true })),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(() => 'granted'),
  requestNotificationPermission: jest.fn(),
}));

const api = require('../services/api');
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

// A share as GET /api/billing/:flockId serves it.
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

// The bill in real state, as App.js holds it, so setMyShare's updaters and a
// re-read's plain replacement both land on the same object. `held.current`
// is the bill as last drawn and the setter a re-read would call.
function mountHeld(initial) {
  const held = { current: null };
  function Holder() {
    const [billSplit, setBillSplit] = React.useState(initial);
    held.current = { billSplit, setBillSplit };
    return React.createElement(ChatDetail, chatProps({ billSplit, setBillSplit }));
  }
  render(React.createElement(Holder));
  return held;
}

const myRow = (held) => held.current.billSplit.shares.find((s) => s.userId === ME.id);

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

const MARK_PAID = 'Mark as Paid (cash or other)';
const UNDO = 'That was a mistake, I have not paid';
const pill = () => screen.getByLabelText('Open bill split details');

afterEach(() => jest.clearAllMocks());

describe('the answer keeps the row it flipped, whatever was read meanwhile', () => {
  test('Mark as Paid: a re-read mid-request does not leave the row unpaid under a tally that counts it paid', async () => {
    const answer = deferred();
    api.settleShare.mockReturnValueOnce(answer.promise);
    const beforeTap = () => bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0, settledAt: 'then' }),
      share(9, 'Jay', 100),
      share(3, 'Cy', 100),
    ]);
    const held = mountHeld(beforeTap());

    fireEvent.click(screen.getByRole('button', { name: MARK_PAID }));
    expect(myRow(held)).toMatchObject({ settled: true, outstanding: 0 });

    // A member's commit reloads the bill while the settle is out, and the
    // server's copy was read before the write: Jay unpaid, one of three.
    act(() => { held.current.setBillSplit(beforeTap()); });
    expect(myRow(held).settled).toBe(false);

    await act(async () => { answer.resolve({ settled: true, shareCount: 3, settledCount: 2, fullySettled: false }); });

    // Fails without the fix: the tally said two of three while Jay's own row
    // read unpaid and Mark as Paid was offered again.
    expect(myRow(held)).toMatchObject({ settled: true, outstanding: 0 });
    expect(held.current.billSplit.settledCount).toBe(2);
    expect(screen.queryByRole('button', { name: MARK_PAID })).toBeNull();
    expect(screen.getByRole('button', { name: UNDO })).toBeTruthy();
    expect(pill().textContent).toContain('2/3');
    // The other rows are the re-read's, untouched.
    expect(held.current.billSplit.shares.find((s) => s.userId === 3).settled).toBe(false);
  });

  test('the undo: a re-read mid-request does not leave the row paid under a tally that counts it unpaid', async () => {
    const answer = deferred();
    api.unsettleShare.mockReturnValueOnce(answer.promise);
    const beforeTap = () => bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0, settledAt: 'then' }),
      share(9, 'Jay', 100, { settled: true, outstanding: 0, settledAt: 'now' }),
      share(3, 'Cy', 100),
    ]);
    const held = mountHeld(beforeTap());

    fireEvent.click(screen.getByRole('button', { name: UNDO }));
    expect(myRow(held)).toMatchObject({ settled: false, settledAt: null, outstanding: 100 });

    // The re-read from before the undo: Jay still paid, two of three.
    act(() => { held.current.setBillSplit(beforeTap()); });
    expect(myRow(held).settled).toBe(true);

    await act(async () => { answer.resolve({ settled: false, shareCount: 3, settledCount: 1, fullySettled: false }); });

    // Owed again in full (owedOn: the share less any credit), with the
    // timestamp cleared, the way the server writes it.
    expect(myRow(held)).toMatchObject({ settled: false, settledAt: null, outstanding: 100 });
    expect(held.current.billSplit.settledCount).toBe(1);
    expect(screen.getByRole('button', { name: MARK_PAID })).toBeTruthy();
    expect(screen.queryByRole('button', { name: UNDO })).toBeNull();
    expect(pill().textContent).toContain('1/3');
  });

  test('with no re-read in between, the answer changes nothing the tap had not already drawn', async () => {
    api.settleShare.mockResolvedValueOnce({ settled: true, shareCount: 3, settledCount: 2, fullySettled: false });
    const held = mountHeld(bill([
      share(1, 'Ava', 100, { settled: true, outstanding: 0, settledAt: 'then' }),
      share(9, 'Jay', 100),
      share(3, 'Cy', 100),
    ]));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: MARK_PAID })); });
    expect(myRow(held)).toMatchObject({ settled: true, outstanding: 0 });
    expect(held.current.billSplit.settledCount).toBe(2);
    expect(api.settleShare).toHaveBeenCalledTimes(1);
    expect(api.settleShare).toHaveBeenCalledWith(1);
  });
});
