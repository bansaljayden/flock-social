/**
 * DELIVERED AND OPENED, ON THE SCREEN.
 *
 * Commit 2bcdc55 and migration 065 built the whole server half of read
 * receipts: two timestamps on `direct_messages`, two watermarks on
 * `flock_members`, a `status` (and, in a group, an `openedBy`) on the viewer's
 * own rows, a `readers` roster on the flock history read, four socket events
 * in and three out. Nothing on the client asked for any of it, so for a day
 * the feature existed on both sides of the wire and on no screen: the ladder
 * StatusLine draws stopped at "Sending", exactly as it had before the server
 * knew anything.
 *
 * This file is about the half that can lie. A receipt is a claim made to
 * somebody else about a person, and StatusLine's own header is unusually
 * strict about it: "NEVER A STATE THE SERVER CANNOT BACK" is the rule, an
 * unknown status renders nothing rather than falling back to "Sent", and a
 * group's count and its names come off the same array so they cannot disagree.
 * So the assertions here are mostly about what is NOT drawn.
 *
 * RENDERED WHERE IT CAN BE. Which word a person sees is the entire finding, so
 * both screens are mounted for real with hand-built props, the way
 * `chatComposerAndInviteSheet` and `dmVenueEmptyStates` already mount them.
 * The receipt is a pure function of the props, so nothing has to be driven.
 *
 * SOURCE-SCANNED WHERE IT CANNOT. When an `_open` fires is a fact about two
 * `useEffect`s inside `FlockAppInner`, which is 20,000 lines of App.js and
 * reachable only by rendering the entire application. Those are pinned as
 * source, and the pins are anchored on the refs that dedupe them
 * (`openPutRef`, `dmOpenPutRef`) rather than on line numbers, because every
 * line number ever written down about App.js has been wrong within days.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test chatReadReceipts --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent } = require('@testing-library/react');

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

const ChatDetail = require('../screens/ChatDetail').default;
const { flockReceipt } = require('../screens/ChatDetail');
const DmDetail = require('../screens/DmDetail').default;

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const SOCKET_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'services', 'socket.js'), 'utf8');
const API_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');

/**
 * The file with its comments taken out, for the one assertion that is about
 * what the code may not SAY rather than what it does.
 *
 * Crude on purpose: it strips block comments and then everything from a `//`
 * to the end of its line, which would also eat the tail of a line holding a
 * URL inside a string. That is acceptable here because the only thing searched
 * for afterwards is `status: '<word>'`, which is not a thing that appears
 * after a URL. A parser would be the right tool if this ever grew a second
 * question to ask.
 */
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

/** From `from` to the next `to`, so a pin reads one block and not the file. */
const between = (source, from, to) => {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

/* Local time strings, for the reason chatCore gives: a 'Z' would put these on
   the wrong side of midnight in half the world's timezones and the day
   grouping would pass or fail by where the suite ran. */
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

/** No receipt of any kind is on the page. */
const noReceiptDrawn = () => {
  expect(screen.queryByText('Sent')).toBeNull();
  expect(screen.queryByText('Delivered')).toBeNull();
  expect(screen.queryByText(/^Opened/)).toBeNull();
};

// ---------------------------------------------------------------------------
// THE GROUP LADDER, as a function.
// ---------------------------------------------------------------------------

describe('flockReceipt: a roster and one message, in; one receipt, out', () => {
  const reader = (over) => ({
    userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 0, lastOpenedMessageId: 0, ...over,
  });

  test('an empty roster invents nothing and hands the row back', () => {
    // The roster read is allowed to fail on its own (routes/messages.js catches
    // it and answers `readers: []` rather than turning a history read into a
    // 500), and when it does, no row carries a status either. Both halves
    // silent has to stay silent: synthesising 'sent' out of an empty list would
    // manufacture a receipt out of a server error.
    expect(flockReceipt({ id: 101 }, [])).toEqual({ status: null, openedBy: null });
    expect(flockReceipt({ id: 101 }, undefined)).toEqual({ status: null, openedBy: null });
  });

  test("a roster nobody has caught up on leaves the row's own word alone", () => {
    const out = flockReceipt({ id: 101, status: 'sent' }, [reader()]);
    expect(out.status).toBe('sent');
  });

  test('a delivery watermark that reaches the message says Delivered', () => {
    const out = flockReceipt({ id: 101, status: 'sent' }, [reader({ lastDeliveredMessageId: 101 })]);
    expect(out.status).toBe('delivered');
    expect(out.openedBy).toBeNull();
  });

  test('a watermark that stops short of the message does not', () => {
    const out = flockReceipt({ id: 101, status: 'sent' }, [reader({ lastDeliveredMessageId: 100 })]);
    expect(out.status).toBe('sent');
  });

  test('ANY reader having opened it makes it opened, and the names are first names', () => {
    // Not every reader. That is what the word means in a group and what the
    // server's own comparison does; requiring all of them would leave a message
    // on Delivered because one member never opens the app.
    const out = flockReceipt({ id: 101, status: 'sent' }, [
      reader({ userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 101, lastOpenedMessageId: 101 }),
      reader({ userId: 3, name: 'Bo Nakamura', lastDeliveredMessageId: 101, lastOpenedMessageId: 0 }),
    ]);
    expect(out.status).toBe('opened');
    // The full name off `readers[].name`, cut the same way the server cuts the
    // one it puts in `openedBy`. A group that read "Opened by Ava Chen" before
    // a reload and "Opened by Ava" after one would be two products.
    expect(out.openedBy).toEqual(['Ava']);
  });

  test('opened outranks delivered on the same reader', () => {
    const out = flockReceipt({ id: 101 }, [reader({ lastDeliveredMessageId: 101, lastOpenedMessageId: 101 })]);
    expect(out.status).toBe('opened');
  });

  test('a reader whose name cannot be read is dropped from the count AND the names', () => {
    // The count and the names are the same array by the time StatusLine has
    // them, so dropping a name from one and not the other is how "Opened by 3"
    // expands to two people.
    const out = flockReceipt({ id: 101 }, [
      reader({ userId: 2, name: 'Ava Chen', lastOpenedMessageId: 101 }),
      reader({ userId: 3, name: '   ', lastOpenedMessageId: 101 }),
      reader({ userId: 4, name: null, lastOpenedMessageId: 101 }),
    ]);
    expect(out.status).toBe('opened');
    expect(out.openedBy).toEqual(['Ava']);
  });

  test('an optimistic bubble is never measured against a watermark', () => {
    // A temp id is a string, and a settled id is an int4 serial. `>=` against
    // either would be nonsense, so the roster is not consulted at all.
    const out = flockReceipt({ id: 'temp-1757100000000-ab12' }, [reader({ lastOpenedMessageId: 999999 })]);
    expect(out).toEqual({ status: null, openedBy: null });
  });

  test("a row's own openedBy is passed through and never trimmed a second time", () => {
    // The server hands these back already cut to first names. Cutting them
    // again is harmless on "Ava" and wrong on nothing, which is exactly why it
    // is the kind of thing that gets added and never noticed.
    const out = flockReceipt({ id: 101, status: 'opened', openedBy: ['Ava', 'Bo'] }, []);
    expect(out.openedBy).toEqual(['Ava', 'Bo']);
  });
});

// ---------------------------------------------------------------------------
// The flock chat screen, rendered.
// ---------------------------------------------------------------------------

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
    // null is a plain share or none; an object here means the viewer said an
    // intent and the chat draws the mode chips.
    myTravel: null,
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
    updateTravel: fn(),
    userLocation: null,
    ...over,
  };
  delete props.flock;
  return props;
}

const renderChat = (messages, readers, over = {}) => render(
  React.createElement(ChatDetail, chatProps({ flock: { messages, readers }, ...over }))
);

describe('the harness above covers the screen it renders', () => {
  test('every prop ChatDetail destructures has a value here', () => {
    // Without this, a prop added to the screen and forgotten here arrives as
    // undefined, takes the falsy branch of every conditional it touches, and
    // the suite goes green over a screen half of which was never drawn.
    const src = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8');
    const params = src
      .slice(src.indexOf('export default function ChatDetail({'), src.indexOf('\n}) {'))
      .split('\n')
      .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
      .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
      .map((l) => l.slice(0, -1));
    expect(params.length).toBeGreaterThan(100);
    const supplied = chatProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });
});

describe('the flock chat draws the receipt the server can back', () => {
  test('a stored message with nobody caught up says Sent', () => {
    renderChat([theirs(), mine({ status: 'sent' })], []);
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });

  test('a member whose device has it says Delivered, over the top of Sent', () => {
    // The row still carries `status: 'sent'` from the history read. The roster
    // is newer than the row by construction, because the only thing that ever
    // updates it live is a `flock_read` event, so it wins.
    renderChat(
      [theirs(), mine({ status: 'sent' })],
      [{ userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 101, lastOpenedMessageId: 0 }],
    );
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByText('Sent')).toBeNull();
  });

  test('two openers collapse to a count that expands to their names', () => {
    renderChat(
      [theirs(), mine({ status: 'sent' })],
      [
        { userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 101, lastOpenedMessageId: 101 },
        { userId: 3, name: 'Bo Nakamura', lastDeliveredMessageId: 101, lastOpenedMessageId: 101 },
      ],
    );
    const pill = screen.getByText('Opened by 2');
    fireEvent.click(pill);
    expect(screen.getByText('Opened by Ava and Bo')).toBeInTheDocument();
  });

  test('a roster read that failed draws no word at all', () => {
    // `readers: []` with no `status` on any row is exactly what
    // routes/messages.js answers when its roster query throws. The one thing
    // that must not happen is a fallback to "Sent".
    renderChat([theirs(), mine()], []);
    noReceiptDrawn();
  });

  test("somebody else's message never carries a receipt, even holding one", () => {
    // The server only ever attaches a status to the viewer's own rows, so this
    // shape cannot come off the wire. It is asserted anyway because the failure
    // it guards against is showing a person a report on their own reading.
    renderChat([mine(), theirs({ id: 102, status: 'opened' })], []);
    noReceiptDrawn();
  });

  test('the receipt sits under the last own message and under no other', () => {
    renderChat(
      [mine({ id: 100, status: 'sent' }), mine({ id: 101, status: 'sent' })],
      [{ userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 101, lastOpenedMessageId: 0 }],
    );
    expect(screen.getAllByText('Delivered')).toHaveLength(1);
  });

  test('a send still in flight keeps its own Sending, and claims nothing else', () => {
    renderChat(
      [mine({ id: 100, status: 'sent' }), mine({ id: 'temp-1', pending: true })],
      [{ userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 100, lastOpenedMessageId: 100 }],
    );
    expect(screen.getByText('Sending')).toBeInTheDocument();
    // The settled row behind it is no longer the last own message, so its
    // receipt goes: there is a newer thing on the screen than the receipt.
    noReceiptDrawn();
  });

  test('a flock_read arriving on its own still moves the receipt on', () => {
    /* THE LAST RUNG OF THE LADDER, and what it is really pinning is that the
       renderer the stream calls is the one this render built.

       renderStatus is called by MessageGroup WHILE IT RENDERS. It used to be
       reached through useStableFn, whose ref is installed in a layout effect,
       so a render-time call ran the PREVIOUS commit's closure and read the
       PREVIOUS `readers`. That was invisible while the row array was rebuilt
       on every render, because the render after drew the receipt again with a
       current closure. The array is remembered now, so there is no render
       after: Delivered would have been the last word this flock ever said
       about a message everybody had opened. */
    const watermarks = (openedTo) => [
      { userId: 2, name: 'Ava Chen', lastDeliveredMessageId: 101, lastOpenedMessageId: openedTo },
      { userId: 3, name: 'Bo Nakamura', lastDeliveredMessageId: 101, lastOpenedMessageId: openedTo },
    ];
    /* A BARE THREAD, AND THAT IS THE ENTIRE POINT OF THE SETUP.
       This test was green before the bug was fixed, for a fixture reason, and
       it is worth naming so nobody relaxes it later. The harness defaults
       billSplit to `[]`, and an empty array is TRUTHY, so `billSplit || ...`
       put a bill row in every thread this suite builds. A spliced synthetic
       row means the stream is a NEW array on every rebuild, which is exactly
       the condition that hides this defect.

       So: billSplit null, a status that kills the nudge, no votes, nobody
       sharing a position, and plain text rows that need no dressing. Then
       `listRows` IS flock.messages by reference and the stream is that same
       array, which is the shape where a flock_read changes the plan object,
       misses the row cache, and hands the stream back a reference it already
       had. Without the copy on a miss, Delivered is the last word this flock
       ever says about a message everybody opened. */
    const bare = {
      status: 'confirmed',
      votes: [],
      messages: [theirs(), mine({ status: 'sent' })],
      readers: watermarks(0),
    };
    const p = chatProps({ flock: bare, billSplit: null, budgetStatus: null, flockMemberLocations: {} });
    const { rerender } = render(React.createElement(ChatDetail, p));
    expect(screen.getByText('Delivered')).toBeInTheDocument();

    /* What App.js does with a flock_read: it rebuilds the flock row with a new
       `readers` and touches nothing else on this screen. The messages array is
       the SAME reference across this change, which is the whole hazard. */
    const before = p.getSelectedFlock();
    const opened = { ...before, readers: watermarks(101) };
    expect(opened.messages).toBe(before.messages);
    rerender(React.createElement(ChatDetail, { ...p, getSelectedFlock: () => opened }));
    expect(screen.getByText('Opened by 2')).toBeInTheDocument();
    expect(screen.queryByText('Delivered')).toBeNull();
  });

  test('a failed send keeps its retry and its remove', () => {
    const p = chatProps({ flock: { messages: [mine({ id: 'temp-1', failed: true })], readers: [] } });
    render(React.createElement(ChatDetail, p));
    expect(screen.getByText("Didn't send")).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(p.retryFailedMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Remove this message that did not send')).toBeInTheDocument();
    noReceiptDrawn();
  });
});

// ---------------------------------------------------------------------------
// The DM thread, rendered.
// ---------------------------------------------------------------------------

const DM_ME = 1;
const dmMine = (over = {}) => ({
  id: 201,
  sender: 'You',
  senderId: DM_ME,
  text: 'on my way',
  sentAt: '2026-09-05T20:00:00',
  message_type: 'text',
  reactions: [],
  ...over,
});
const dmTheirs = (over = {}) => ({
  id: 200,
  sender: 'Sam',
  senderId: 7,
  text: 'here',
  sentAt: '2026-09-05T19:59:00',
  message_type: 'text',
  reactions: [],
  ...over,
});

function dmProps(over = {}) {
  const fn = () => jest.fn();
  const colors = {
    navy: '#0d2847', navyBg: '#0d2847', navyMid: '#1b4a7a', navyMidBg: '#1b4a7a',
    steel: '#3d6b96', cream: '#f0ead8', creamDark: '#d9d0b8', red: '#b91c1c',
    redText: '#b91c1c', amber: '#f59e0b', amberText: '#92400e',
    textSecondary: '#5b6b7c', textTertiary: '#8a97a5',
  };
  const props = {
    ChatSkeleton: () => null,
    DM_PAGE_SIZE: 50,
    DialogBehavior: () => null,
    SearchInputLocal: () => null,
    VenueCard: () => null,
    colorsLight: colors,
    messagePreview: () => '',
    oldestServerId: () => null,
    onVenuePhotoError: fn(),
    resolveVenuePhoto: () => null,
    allVenues: [],
    authUser: { id: DM_ME, name: 'Alex' },
    chatInputHasText: false,
    colors,
    confirmClick: fn(),
    currentScreen: 'dmDetail',
    deletedDmUserIds: [],
    dmAtTop: false,
    dmBlocked: false,
    dmChatSearch: '',
    dmChatSearchRef: { current: null },
    dmGalleryInputRef: { current: null },
    dmIsTyping: false,
    dmMemberLocation: null,
    dmMessagesLoading: false,
    dmNavOpen: false,
    dmNotConnected: false,
    dmPendingImage: null,
    dmPinnedVenue: null,
    // Take the pin down. PinStrip draws its Unpin item only when handed a
    // callback, so this is what makes the control exist at all.
    unpinDmVenueNow: () => {},
    dmReactions: {},
    dmReplyingTo: null,
    dmRequestSending: false,
    dmSharingLocation: null,
    dmTypingUser: null,
    dmVenueVotes: [],
    dmVenueVotesError: null,
    getCategoryColor: () => '#3d6b96',
    getRelativeTime: () => 'now',
    handleDmImageSelect: fn(),
    handleDmInputChange: fn(),
    handleUnsendDm: fn(),
    isDark: false,
    loadDmVenueVotes: fn(),
    loadOlderDms: fn(),
    loadPopularVenues: fn(),
    olderLoading: false,
    openCameraViewfinder: fn(),
    openUserProfile: fn(),
    openVenueDetail: fn(),
    popularVenues: [],
    // Null means "a real location produced this list", which is the state a
    // chat harness should be in; the fallback wording is exercised where the
    // fallback itself is.
    venuesFromLabel: null,
    profilePic: null,
    retryFailedDm: fn(),
    discardFailedDm: fn(),
    selectedDm: { id: 7, userId: 7, name: 'Sam Diaz', profile_image_url: null, messages: [], ...(over.dm || {}) },
    selectedDmId: 7,
    sendDmMessage: fn(),
    setChatInput: fn(),
    setCurrentScreen: fn(),
    setCurrentTab: fn(),
    setDeletedDmUserIds: fn(),
    setDirectMessages: fn(),
    setDmChatSearch: fn(),
    setDmMemberLocation: fn(),
    setDmNavOpen: fn(),
    setDmPendingImage: fn(),
    setDmReplyingTo: fn(),
    setDmRequestSending: fn(),
    setDmSharingLocation: fn(),
    startDmLocationSharing: fn(),
    setDmVenueVotes: fn(),
    setModerationTarget: fn(),
    setPickingVenueForCreate: fn(),
    setPickingVenueForDm: fn(),
    setShowDeleteDmConfirm: fn(),
    setShowDmChatSearch: fn(),
    setShowDmImagePreview: fn(),
    setShowDmMenu: fn(),
    setShowDmReactionPicker: fn(),
    setShowDmVenueSearch: fn(),
    setShowDmVotePanel: fn(),
    setVenueDetailReturnTo: fn(),
    showDeleteDmConfirm: false,
    showDmChatSearch: false,
    showDmImagePreview: false,
    showDmMenu: false,
    showDmReactionPicker: null,
    showDmVenueSearch: false,
    showDmVotePanel: false,
    showToast: fn(),
    userLocation: null,
    ...over,
  };
  delete props.dm;
  return props;
}

const renderDm = (messages, over = {}) => render(
  React.createElement(DmDetail, dmProps({ dm: { messages }, ...over }))
);

describe('the DM harness covers the screen it renders', () => {
  test('every prop DmDetail destructures has a value here', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8');
    const params = src
      .slice(src.indexOf('export default function DmDetail({'), src.indexOf('\n}) {'))
      .split('\n')
      .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
      .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
      .map((l) => l.slice(0, -1));
    expect(params.length).toBeGreaterThan(60);
    const supplied = dmProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });
});

describe('the DM thread draws the receipt the row carries', () => {
  test("the row's own word is what appears, with no derivation", () => {
    renderDm([dmTheirs(), dmMine({ status: 'delivered' })]);
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  test('opened is a word this surface can say too', () => {
    renderDm([dmTheirs(), dmMine({ status: 'opened' })]);
    expect(screen.getByText('Opened')).toBeInTheDocument();
    // And never with a count. A DM has one recipient, so there is no "by N" to
    // draw and the server sends no name list on this route.
    expect(screen.queryByText(/Opened by/)).toBeNull();
  });

  test('a row with no status draws nothing rather than Sent', () => {
    // Every DM stored before migration 065 is this row. 065 backfills nothing
    // on purpose, because nobody ever recorded a receipt for them.
    renderDm([dmTheirs(), dmMine()]);
    noReceiptDrawn();
  });

  test("somebody else's message never carries a receipt", () => {
    renderDm([dmMine(), dmTheirs({ id: 202, status: 'opened' })]);
    noReceiptDrawn();
  });

  test('the receipt sits under the last own message and under no other', () => {
    renderDm([dmMine({ id: 200, status: 'opened' }), dmMine({ id: 201, status: 'delivered' })]);
    expect(screen.getAllByText('Delivered')).toHaveLength(1);
    expect(screen.queryByText('Opened')).toBeNull();
  });

  test('sending and the failed pair are untouched by any of this', () => {
    const p = dmProps({ dm: { messages: [dmMine({ id: 'temp-1', failed: true }), dmMine({ id: 'temp-2', pending: true })] } });
    render(React.createElement(DmDetail, p));
    expect(screen.getByText("Didn't send")).toBeInTheDocument();
    expect(screen.getByText('Sending')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(p.retryFailedDm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Remove this message that did not send')).toBeInTheDocument();
  });

  test('the echo that replaces a pending row draws Sent in the same render', () => {
    /* The DM twin of the flock_read case above, and the same defect. The
       renderer the stream calls while it renders used to be reached through
       useStableFn, whose ref is installed in a layout effect, so the echo's
       render ran the closure of the render BEFORE it. That closure was built
       while the pending row was last, so its receipt id was null and the
       acknowledged row drew nothing. Nothing re-renders after an echo, so
       nothing was what it kept drawing. */
    const p = dmProps({ dm: { messages: [dmTheirs(), dmMine({ id: 'temp-1', pending: true })] } });
    const { rerender } = render(React.createElement(DmDetail, p));
    expect(screen.getByText('Sending')).toBeInTheDocument();
    noReceiptDrawn();

    // What the send echo does: the pending row becomes the server's row, with
    // its id and the word the server put on it, and nothing else changes.
    const echoed = { ...p.selectedDm, messages: [dmTheirs(), dmMine({ id: 201, status: 'sent' })] };
    rerender(React.createElement(DmDetail, { ...p, selectedDm: echoed }));
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText('Sending')).toBeNull();
  });
});

describe('a DM venue card that reads the screen rather than its row is still current', () => {
  test('a vote that lands after the card is drawn reaches the card', () => {
    /* The DM row array is remembered on the messages, and a tally lives in
       dmVenueVotes rather than on any message. So an optimistic vote, or the
       tally loading after the thread opened, changed nothing the memoised
       row could see, and the card kept whatever it drew first. */
    const card = dmTheirs({ id: 202, message_type: 'venue_card', text: '', venue_data: { name: 'Kome', place_id: 'p1' } });
    const p = dmProps({ dm: { messages: [dmTheirs(), card] }, dmVenueVotes: [] });
    const { rerender } = render(React.createElement(DmDetail, p));
    expect(screen.getByRole('button', { name: 'Vote' })).toBeInTheDocument();
    expect(screen.queryByText(/[0-9]+ vote/)).toBeNull();

    // What the card's own tap writes, optimistically: the viewer's name on the
    // voters list and the count up by one. The messages are untouched.
    const voted = [{ venue_name: 'Kome', venue_id: 'p1', vote_count: 1, voters: ['Alex'] }];
    rerender(React.createElement(DmDetail, { ...p, dmVenueVotes: voted }));
    expect(screen.getByRole('button', { name: 'Voted' })).toBeInTheDocument();
    expect(screen.getByText(/1 vote/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// WHEN EACH EVENT FIRES. Source pins, because the answer lives in two effects
// inside FlockAppInner.
// ---------------------------------------------------------------------------

describe('delivery is claimed by a history read and opening never is', () => {
  const flockLoader = () => between(
    APP_SOURCE,
    'const loadFlockMessages = useCallback',
    '// The DM twin of loadFlockMessages',
  );
  const dmLoader = () => between(
    APP_SOURCE,
    'const loadDmMessages = useCallback',
    '// ── Scrollback ──',
  );

  test('the flock history read sends the ack and nothing stronger', () => {
    const loader = flockLoader();
    expect(loader).toContain('sendFlockAck(');
    // THE ONE LINE THAT MATTERS IN THIS FILE. A history fetch runs on screen
    // entry, on the reconnect catch-up and on a background tab coming back.
    // Calling any of those "Opened" is precisely the lie migration 065 was
    // written to stop, and it is the shortcut anybody wiring this would reach
    // for, because the read is where the data already is.
    expect(loader).not.toContain('sendFlockOpen');
    expect(loader).not.toContain('markFlockOpened');
  });

  test('the DM history read sends the ack and nothing stronger', () => {
    const loader = dmLoader();
    expect(loader).toContain('sendDmAck(');
    expect(loader).not.toContain('sendDmOpen');
    expect(loader).not.toContain('markDmOpened');
  });

  test('the flock ack is bounded by a real server id', () => {
    // A flock watermark has no "everything" form: it is an id compared against
    // every row on the page. An optimistic bubble's id is Date.now(), well past
    // int4, so the bound is taken over rows the server actually issued.
    expect(flockLoader()).toContain('isServerId(m.id)');
  });

  test('the roster arrives with the history and is replaced, not merged', () => {
    const loader = flockLoader();
    expect(loader).toContain('Array.isArray(data.readers)');
    expect(loader).toMatch(/messages: mergeHistory\([^)]*\), readers/);
  });
});

describe('an open receipt is only ever claimed for somebody who could see it', () => {
  const flockOpen = () => between(APP_SOURCE, "const openPutRef = useRef('')", '// Load suggested users');
  const dmOpen = () => between(APP_SOURCE, "const dmOpenPutRef = useRef('')", '// Socket-sent DMs waiting');

  test('the flock effect gates on the screen, the thread and the tab being visible', () => {
    const block = flockOpen();
    expect(block).toContain("currentScreen !== 'chatDetail'");
    expect(block).toContain('!selectedFlockId');
    // docVisible is React STATE fed by visibilitychange, not a read at effect
    // time. code review found the difference on 2026-09-01 for the badge cursor: a
    // tab parked on the chat and then hidden kept claiming to be reading off
    // one stale evaluation, forever.
    expect(block).toContain('!docVisible');
    expect(block).toMatch(/\}, \[currentScreen, selectedFlockId, selectedFlock\?\.messages, docVisible\]\)/);
  });

  test('the DM effect gates on the same three things, plus the block', () => {
    const block = dmOpen();
    expect(block).toContain("currentScreen !== 'dmDetail'");
    expect(block).toContain('!selectedDmId');
    expect(block).toContain('!docVisible');
    // A receipt is a message to the other person, and the route answers 403 for
    // a block in either direction.
    expect(block).toContain('dmBlocked[String(selectedDmId)]');
  });

  test('both claim only up to the newest message from somebody else', () => {
    // A watermark is a claim about reading other people's messages. Bounding it
    // on your own would also mean re-claiming an open every time you sent
    // something, which is 30 writes per 10s away from the shared rate bucket.
    expect(flockOpen()).toContain('newestFromOthers(selectedFlock?.messages)');
    expect(dmOpen()).toContain('newestFromOthers(selectedDm?.messages)');
  });

  test('both fall back to REST only when the socket refused the emit', () => {
    expect(flockOpen()).toMatch(/if \(sendFlockOpen\([^)]*\)\) return;\s*\n\s*markFlockOpened\(/);
    expect(dmOpen()).toMatch(/if \(sendDmOpen\([^)]*\)\) return;\s*\n\s*markDmOpened\(/);
  });

  test('a failed REST fallback releases its key so the next render retries', () => {
    // The moment this call is most likely to fail is a flaky connection, which
    // is the moment a receipt matters most. The badge cursor learned the same
    // lesson the hard way and this copies its shape.
    expect(flockOpen()).toContain("if (openPutRef.current === key) openPutRef.current = ''");
    expect(dmOpen()).toContain("if (dmOpenPutRef.current === key) dmOpenPutRef.current = ''");
  });
});

describe('receipts arriving move the ladder one way only', () => {
  const block = () => between(APP_SOURCE, '── RECEIPTS ARRIVING', '// Listen for typing indicators');

  test('a late delivery never walks an opened row back', () => {
    expect(block()).toContain("if (word === 'delivered' && m.status === 'opened') return m;");
  });

  test('the flock roster is merged on userId and the name is optional', () => {
    const src = block();
    // The send-time delivery sweep has member ids and no names, so an event can
    // and does arrive with none. Keying on the name would lose every one of
    // them; overwriting the roster's name with the event's would erase the
    // names "Opened by Ava and Bo" is built from.
    expect(src).toContain('Number(r.userId) === userId');
    expect(src).toContain('cur.name || ev.name || null');
  });

  test('watermarks only ever move forward', () => {
    const src = block();
    expect(src).toContain('Math.max(curDelivered, delivered)');
    expect(src).toContain('Math.max(curOpened, opened)');
  });

  test('your own read is never merged into the roster as a reader', () => {
    // The server already excludes the reader from this fan-out. If that ever
    // changed, your own message would report that you had opened it.
    expect(block()).toContain('Number(meRef.current.id) === userId');
  });

  test('a no-op receipt returns the same state so React bails out', () => {
    // The send-time sweep emits one of these per online member per message.
    const src = block();
    expect(src).toContain('if (!touched) return prev;');
    expect(src).toMatch(/name === cur\.name\) return prev;/);
  });
});

describe('the row mappers carry the receipt and never invent one', () => {
  test('both history mappers pass status straight through', () => {
    const dm = between(APP_SOURCE, 'const mapDmRow = (m, myId)', 'const mapFlockRow');
    const flock = between(APP_SOURCE, 'const mapFlockRow = (m, myId)', '// Put an older page in front');
    expect(dm).toContain('status: m.status || null');
    expect(flock).toContain('status: m.status || null');
    expect(flock).toContain('openedBy: m.openedBy || null');
  });

  test('no mapper or echo defaults a missing status to a word', () => {
    // `status: 'sent'` written as a literal anywhere on the client would be the
    // client claiming persistence the server never confirmed. Every one of
    // these reads the echo's own field, including on the fan-out failure path
    // where the server deliberately omits it ("Message saved, but live delivery
    // is delayed").
    const code = codeOnly(APP_SOURCE);
    expect(code).not.toMatch(/status: 'sent'/);
    expect(code).not.toMatch(/status: 'delivered'/);
    expect(code).not.toMatch(/status: 'opened'/);
    expect(APP_SOURCE).toContain('status: msg.status || null');
    expect(APP_SOURCE).toContain("status: data?.message?.status || null");
    expect(APP_SOURCE).toContain('status: saved?.status || null');
  });
});

describe('the wire names on the client are the wire names on the server', () => {
  test('the four emits are the four events the server listens for', () => {
    expect(SOCKET_SOURCE).toContain("socket.emit('dm_ack'");
    expect(SOCKET_SOURCE).toContain("socket.emit('dm_open'");
    expect(SOCKET_SOURCE).toContain("socket.emit('flock_ack'");
    expect(SOCKET_SOURCE).toContain("socket.emit('flock_open'");
  });

  test('the three listeners go through the registry, not a socket instance', () => {
    // A listener bound to whatever getSocket() returned is lost the moment that
    // object is replaced, which is the coupling the registry exists to remove.
    expect(SOCKET_SOURCE).toContain("register('dm_delivered', callback)");
    expect(SOCKET_SOURCE).toContain("register('dm_opened', callback)");
    expect(SOCKET_SOURCE).toContain("register('flock_read', callback)");
  });

  test('an absent DM bound means everything, and a falsy one is not absent', () => {
    // `upToId: upToId || undefined` would turn a 0 into "the whole thread".
    expect(SOCKET_SOURCE).toContain('...(upToId == null ? {} : { upToId })');
  });

  test('a flock receipt refuses to go out without an id', () => {
    const flockAck = between(SOCKET_SOURCE, 'export function sendFlockAck', 'export function sendFlockOpen');
    expect(flockAck).toContain('if (upToId == null) return false;');
  });

  test('the REST fallbacks address the opened routes and not the read ones', () => {
    expect(API_SOURCE).toMatch(/\/api\/flocks\/\$\{flockId\}\/opened/);
    expect(API_SOURCE).toMatch(/\/api\/dm\/\$\{userId\}\/opened/);
  });
});
