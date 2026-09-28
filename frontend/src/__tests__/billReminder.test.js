// ---------------------------------------------------------------------------
// THE PAYER'S REMINDER, RENDERED.
//
// Whoever covered the table had no way to chase what they were owed except to
// type it into the group chat, while the budget has had a one-tap reminder for
// the host all along. POST /api/billing/:flockId/remind is payer-only, refuses
// a payerless, quarantined or settled bill, sends no amount, and allows one per
// plan an hour (backend budgetBillIntegrity.test.js runs it on a real
// Postgres). This file is the two places the payer reaches it:
//
//   1. THE BILL SHEET. "Remind the N who haven't paid", for the payer alone,
//      while somebody still owes, on a posted bill that is not quarantined.
//      One request per tap, however fast the taps, and once one has gone the
//      sheet says so instead of offering a second the server would refuse.
//   2. THE CARD IN THE STREAM. BillCard draws Remind beside "Waiting on N" for
//      the payer when it is handed onRemind, and nothing for anybody else.
//
// The screen is mounted the way billSheetOwedFigures.test.js mounts it, with a
// copy of its hand-built props object; chatComposerAndInviteSheet.test.js is
// the one that proves that list complete against the screen's parameters.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test billReminder --watchAll=false
// ---------------------------------------------------------------------------

const React = require('react');
const { render, screen, fireEvent, waitFor, act, cleanup } = require('@testing-library/react');

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
  sendBillReminder: jest.fn(),
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

const api = require('../services/api');
const ChatDetail = require('../screens/ChatDetail').default;
const BillCard = require('../components/chat/cards/BillCard').default;

// Ava (1) paid. Jay (9) and Cy (3) have not paid her back; Ben (2) has.
const AVA = { id: 1, name: 'Ava' };
const JAY = { id: 9, name: 'Jay' };
const FLOCK = {
  id: 1,
  name: 'Friday',
  creatorId: 1,
  status: 'confirmed',
  members: [],
  messages: [],
  memberCount: 4,
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
    memberCountLabel: () => '4 people',
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
    authUser: AVA,
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

const share = (userId, name, settled) => ({
  userId, name, amount: 30, paidAmount: 0, outstanding: settled ? 0 : 30, committed: false, settled, settledAt: null,
});

// Ava's own row is settled, as POST /create writes the payer's.
const bill = (over = {}) => {
  const shares = over.shares || [share(1, 'Ava', true), share(2, 'Ben', true), share(9, 'Jay', false), share(3, 'Cy', false)];
  return {
    id: 7,
    flockId: 1,
    totalAmount: 120,
    tipPercent: 0,
    totalWithTip: 120,
    splitType: 'equal',
    hasPayer: true,
    paidBy: { id: 1, name: 'Ava' },
    fullySettled: shares.every((s) => s.settled),
    settledCount: shares.filter((s) => s.settled).length,
    shareCount: shares.length,
    shares,
    createdAt: 'now',
    ...over,
  };
};

const REMIND = /^Remind the (one|\d+) who/;
const mount = (billSplit, over = {}) => render(React.createElement(ChatDetail, chatProps({ billSplit, ...over })));

beforeEach(() => { api.sendBillReminder.mockReset(); });
afterEach(cleanup);

describe('the bill sheet', () => {
  test('offers the payer a reminder for the people who still owe, counted off the tally', async () => {
    api.sendBillReminder.mockResolvedValue({ reminded: 2 });
    const p = chatProps({ billSplit: bill() });
    render(React.createElement(ChatDetail, p));
    const btn = screen.getByRole('button', { name: "Remind the 2 who haven't paid" });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reminder sent. You can send one an hour.'));
    expect(api.sendBillReminder).toHaveBeenCalledTimes(1);
    expect(api.sendBillReminder).toHaveBeenCalledWith(1);
    expect(p.showToast).toHaveBeenCalledWith('Reminded the 2 people who have not paid');
    // Sent, so not offered again: the server would answer 429 for an hour.
    expect(screen.queryByRole('button', { name: REMIND })).toBeNull();
  });

  test('one owing says "the one", and a tap while it sends is not a second request', async () => {
    let answer;
    api.sendBillReminder.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    mount(bill({ shares: [share(1, 'Ava', true), share(9, 'Jay', false)] }));
    const btn = screen.getByRole('button', { name: "Remind the one who hasn't paid" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(await screen.findByRole('button', { name: 'Sending the reminder…' })).toBeDisabled();
    await act(async () => { answer({ reminded: 1 }); });
    expect(api.sendBillReminder).toHaveBeenCalledTimes(1);
  });

  test('a reminder that already went out this hour reads as sent, with what the server said', async () => {
    api.sendBillReminder.mockRejectedValue(Object.assign(new Error('You already sent a reminder in the last hour. Try again later.'), { status: 429 }));
    const p = chatProps({ billSplit: bill() });
    render(React.createElement(ChatDetail, p));
    fireEvent.click(screen.getByRole('button', { name: REMIND }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reminder sent.'));
    expect(p.showToast).toHaveBeenCalledWith('You already sent a reminder in the last hour. Try again later.');
  });

  test('a reminder that failed says so and can be tried again', async () => {
    api.sendBillReminder.mockRejectedValue(Object.assign(new Error('Network down'), { status: 0 }));
    const p = chatProps({ billSplit: bill() });
    render(React.createElement(ChatDetail, p));
    fireEvent.click(screen.getByRole('button', { name: REMIND }));
    await waitFor(() => expect(p.showToast).toHaveBeenCalledWith('Network down', 'error'));
    expect(screen.getByRole('button', { name: REMIND })).not.toBeDisabled();
  });

  test('nobody but the payer is offered it', () => {
    mount(bill(), { authUser: JAY });
    expect(screen.queryByRole('button', { name: REMIND })).toBeNull();
  });

  test('not once everyone has paid, and not on a payerless or quarantined bill', () => {
    const everyonePaid = [share(1, 'Ava', true), share(9, 'Jay', true)];
    for (const b of [
      bill({ shares: everyonePaid }),
      bill({ hasPayer: false, paidBy: null, estimate: false }),
      bill({ quarantined: true }),
    ]) {
      mount(b);
      expect(screen.queryByRole('button', { name: REMIND })).toBeNull();
      cleanup();
    }
  });
});

describe('the bill card in the stream', () => {
  const card = (props) => render(React.createElement(BillCard, { bill: bill(), viewerId: 1, ...props }));

  test('the payer gets Remind beside the count, and it calls back', () => {
    const onRemind = jest.fn();
    card({ onRemind });
    expect(screen.getByText('Waiting on 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    expect(onRemind).toHaveBeenCalledTimes(1);
  });

  test('while it sends the link says so and takes no second tap', () => {
    card({ onRemind: jest.fn(), pendingAction: 'remind' });
    expect(screen.getByRole('button', { name: 'Reminding' })).toBeDisabled();
  });

  test('without onRemind, or for anybody but the payer, there is no Remind', () => {
    card({});
    expect(screen.queryByRole('button', { name: 'Remind' })).toBeNull();
    cleanup();
    card({ viewerId: 9, onRemind: jest.fn(), onSettle: jest.fn() });
    expect(screen.queryByRole('button', { name: 'Remind' })).toBeNull();
  });

  test('nothing to remind once everyone has paid, and nothing on a quarantined bill', () => {
    card({ bill: bill({ shares: [share(1, 'Ava', true), share(9, 'Jay', true)] }), onRemind: jest.fn() });
    expect(screen.queryByRole('button', { name: 'Remind' })).toBeNull();
    cleanup();
    card({ bill: bill({ quarantined: true }), onRemind: jest.fn() });
    expect(screen.queryByRole('button', { name: 'Remind' })).toBeNull();
  });
});
