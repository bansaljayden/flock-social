/**
 * THE ROW PIPELINE: WHAT THE STREAM IS HANDED, AND WHEN IT IS HANDED A NEW ONE.
 *
 * screens/ChatDetail.js builds the array MessageList draws, and the composer's
 * draft is state at the root of that screen, so every keystroke re-renders the
 * body. MessageList keys its grouping and all three of its scroll rules off the
 * array's IDENTITY, so a fresh array per character re-ran groupRows over the
 * whole thread, re-rendered every run behind React.memo and read the scroller
 * height back synchronously. That array is remembered between renders now.
 *
 * THIS FILE IS THE HONESTY OF THAT CACHE, which is the only thing about it that
 * can hurt anybody. An array remembered when it should have been rebuilt is a
 * row on screen describing something that is no longer true, and that is worse
 * than the waste. So every value the rows are built from, and every value the
 * card and receipt renderers read off the SCREEN rather than off the row they
 * are handed, is flipped here, and the array has to change with it.
 *
 * MessageList IS WRAPPED RATHER THAN REPLACED. The stub below records the
 * array it was handed and then renders the real component with the same props,
 * so the identity question and the drawn-on-screen question can both be asked
 * in one file. The second one matters here because a card whose figures are
 * read off the screen rather than off its row is only ever redrawn when this
 * array changes, which makes the cache and the card one mechanism.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test chatRowPipeline --watchAll=false
 */
const React = require('react');
const { render, screen } = require('@testing-library/react');

// Both screens import these at module scope. None of the three is under test
// and all of them reach the network, the socket or the Capacitor bridge.
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
  sendFriendRequest: jest.fn(),
  trackDmVenueVote: jest.fn(),
  getDmMessageImage: jest.fn(),
}));
jest.mock('../services/socket', () => ({
  __esModule: true,
  leaveFlock: jest.fn(),
  getSocket: jest.fn(() => ({ connected: true })),
  dmReact: jest.fn(),
  dmRemoveReact: jest.fn(),
  dmStopSharingLocation: jest.fn(),
  dmVoteVenue: jest.fn(),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(() => 'granted'),
  requestNotificationPermission: jest.fn(),
}));

/* Every array the stream was handed, newest last. On `global` rather than in a
   closure because jest hoists the factory below above every declaration in the
   file, so the factory cannot see a const declared here. */
jest.mock('../components/chat', () => {
  const actual = jest.requireActual('../components/chat');
  const ReactForStub = require('react');
  return {
    ...actual,
    MessageList: (listProps) => {
      global.__handedRows.push(listProps.rows);
      return ReactForStub.createElement(actual.MessageList, listProps);
    },
  };
});
global.__handedRows = [];

const ChatDetail = require('../screens/ChatDetail').default;

/** The array the stream was handed on the most recent render. */
const handed = () => global.__handedRows[global.__handedRows.length - 1];
const ME = 9;
const mine = (over = {}) => ({
  id: 101,
  sender: 'You',
  senderId: ME,
  text: 'we still on for 9',
  sentAt: '2026-09-05T20:00:00',
  message_type: 'text',
  reactions: [],
  ...over,
});
const theirs = (over = {}) => ({
  id: 100,
  sender: 'Ava',
  senderId: 2,
  text: 'yes',
  sentAt: '2026-09-05T19:59:00',
  message_type: 'text',
  reactions: [],
  ...over,
});

function chatProps(over = {}) {
  const fn = () => jest.fn();
  const flock = {
    id: 1,
    name: 'Friday',
    creatorId: ME,
    status: 'planning',
    members: [],
    messages: [],
    readers: [],
    memberCount: 2,
    ...(over.flock || {}),
  };
  const props = {
    // App.js module scope, shared with other screens.
    ChatSkeleton: () => null,
    DM_PAGE_SIZE: 50,
    DialogBehavior: () => null,
    ListSkeleton: () => null,
    MOMENTUM_STAGES: [],
    SearchInputLocal: () => null,
    VenueCard: () => null,
    colorsLight: {},
    crowdColorFor: () => '#000000',
    memberCountLabel: () => '2 people',
    messagePreview: () => '',
    momentumStageKey: () => 'planning',
    oldestServerId: () => null,
    onVenuePhotoError: fn(),
    paymentRoutes: () => [],
    resolveVenuePhoto: () => null,
    voteTotal: () => 0,
    // FlockAppInner state, setters and handlers.
    MissingFlockPanel: () => null,
    addReactionToMessage: fn(),
    allVenues: [],
    authUser: { id: ME, name: 'Jay' },
    billPaidBy: null,
    billSplit: [],
    billTip: '',
    billTotal: '',
    budgetAmount: '',
    budgetCustom: '',
    budgetFilteredVenues: [],
    budgetStatus: null,
    budgetSubmitting: false,
    chatGalleryInputRef: { current: null },
    chatInputHasText: false,
    chatNavOpen: false,
    chatSearch: '',
    chatSearchRef: { current: null },
    // Migration 066 gave the flock composer a real reply. Both are held in
    // App.js so a takedown arriving over the socket can close the quote bar.
    flockReplyingTo: null,
    setFlockReplyingTo: () => {},
    // The numeric haversine, for the who-is-here card. These harnesses carry
    // no member positions, so a large constant reads as "nobody is near" and
    // the card does not draw. A test that wants the card overrides this with
    // a real distance rather than relying on the stub.
    distanceKm: () => 9999,
    // Pin and unpin (migration 068). No-ops here: these harnesses assert
    // what the screen draws, and the pin list they hand it is empty.
    pinMessage: () => {},
    unpinMessage: () => {},
    colors: {},
    confirmClick: fn(),
    confirmFlockPlan: fn(),
    copiedInviteUrl: '',
    crowdPredictions: {},
    dismissNotifAsk: fn(),
    eventCrowd: null,
    eventCrowdLabel: null,
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
    getSelectedFlock: () => flock,
    handleChatImageSelect: fn(),
    handleChatInputChange: fn(),
    handleUnsendFlockMessage: fn(),
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
    votesLoading: false,
    pendingImage: null,
    popularVenues: [],
    // Null means "a real location produced this list", which is the state a
    // chat harness should be in; the fallback wording is exercised where the
    // fallback itself is.
    venuesFromLabel: null,
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
    showChatPool: false,
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
    ...over,
  };
  delete props.flock;
  return props;
}

/* A flock with something in every lane: a thread, a roster that has delivered
   but not opened, an open vote, and members. So a flip of any input below has
   a row or a card that actually depends on it. */
const fullFlock = () => ({
  messages: [theirs(), mine()],
  readers: [{ userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 101, lastOpenedMessageId: 0 }],
  votes: [{ venue: 'Kome', voters: [] }],
  status: 'planning',
  memberCount: 3,
  members: [{ id: 2, name: 'Ava' }],
});

describe('the array is held still while nothing it is made of has moved', () => {
  test('a keystroke in the composer hands the stream the same array', () => {
    /* The whole point. A keystroke changes the draft, which is state inside
       the screen, and nothing else: the props arrive identical. */
    global.__handedRows.length = 0;
    const p = chatProps({ flock: fullFlock() });
    const { rerender } = render(React.createElement(ChatDetail, p));
    const first = handed();
    expect(Array.isArray(first)).toBe(true);
    expect(first.length).toBeGreaterThan(2);
    rerender(React.createElement(ChatDetail, { ...p }));
    expect(handed()).toBe(first);
    /* And a prop no row and no renderer reads does not rebuild it either.
       chatInputHasText moves on the first character typed and the last one
       deleted, which is the same render a keystroke produces. */
    rerender(React.createElement(ChatDetail, { ...p, chatInputHasText: true }));
    expect(handed()).toBe(first);
  });
});

/* ONE ENTRY PER CACHE INPUT. The value named is the one the rows or the two
   renderers read; the flip is what App.js does to it in the session. */
const FLIPS = {
  'the flock: the messages, the votes, the status, the venue, the roster, the readers': (p) => {
    const next = { ...p.getSelectedFlock(), messages: [theirs(), mine(), theirs({ id: 102 })] };
    return { getSelectedFlock: () => next };
  },
  'the search box opening, which drops all four cards': () => ({ showChatSearch: true }),
  'what the search box says, which rewrites the rows it keeps': () => ({ chatSearch: 'yes' }),
  'the bill, which is the bill card': () => ({ billSplit: { shares: [], hasPayer: true, createdAt: '2026-09-05T20:30:00' } }),
  'the budget, which is the estimate on a bill that does not exist yet': () => ({ budgetStatus: { ceiling: 40 } }),
  'a position, which is every count on the who-is-here row': () => ({
    flockMemberLocations: { 2: { lat: 40, lng: -75, timestamp: Date.now(), flockId: 1, name: 'Ava' } },
  }),
  'the viewer, who is left out of those counts and owns a share of the bill': () => ({
    authUser: { id: ME, name: 'Jay' },
  }),
  'somebody typing, which is what takes the nudge away': () => ({ isTyping: true }),
  'which flock this is, because every write a card carries goes against it': () => ({ selectedFlockId: 2 }),
  'the nearby pins, which are the place-id fallback behind the vote lock': () => ({ allVenues: [{ name: 'Kome', place_id: 'p1' }] }),
};

describe('and it is rebuilt the moment one of them does', () => {
  for (const [what, flip] of Object.entries(FLIPS)) {
    test(what, () => {
      global.__handedRows.length = 0;
      const p = chatProps({ flock: fullFlock() });
      const { rerender } = render(React.createElement(ChatDetail, p));
      const first = handed();
      rerender(React.createElement(ChatDetail, { ...p, ...flip(p) }));
      expect(handed()).not.toBe(first);
    });
  }
});

describe('a card that reads the screen rather than its row is still current', () => {
  test('an optimistic vote lands on the venue card that raised it', () => {
    /* THE SECOND HALF of what a remembered array could have frozen, and the
       half that is not a receipt. A venue card reads flock.votes for its
       active state and its count, because the row it rides on is a real
       message and carries neither.

       The optimistic write is the only render in the local path: App.js puts
       the new votes into state and the server answer lands much later. So
       there is no second render to redraw the card, and a renderer one commit
       behind would have drawn the count from before the tap and held it. */
    const card = theirs({ id: 103, message_type: 'venue_card', text: '', venue_data: { name: 'Kome', place_id: 'p1' } });
    const p = chatProps({
      flock: { ...fullFlock(), messages: [theirs(), card], votes: [] },
      voteTotal: (v) => ((v && v.voters ? v.voters.length : 0) + ((v && v.guestCount) || 0)),
    });
    const { rerender } = render(React.createElement(ChatDetail, p));
    expect(screen.getByRole('button', { name: 'Vote' })).toBeInTheDocument();
    expect(screen.queryByText(/[0-9]+ vote/)).toBeNull();

    // What updateFlockVotes does, optimistically, on the tap.
    const voted = { ...p.getSelectedFlock(), votes: [{ venue: 'Kome', voters: ['You'] }] };
    rerender(React.createElement(ChatDetail, { ...p, getSelectedFlock: () => voted }));
    expect(screen.getByRole('button', { name: 'Voted' })).toBeInTheDocument();
    expect(screen.getByText(/1 vote/)).toBeInTheDocument();
  });
});
