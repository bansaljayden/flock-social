/**
 * THE VOTE SHEET AND THE PHOTO VIEWERS WAIT IN THEIR OWN SHAPES.
 *
 * The flock chat's vote sheet said "Loading the votes..." in a grey box while
 * the tally was on the wire, and its header counted the empty tally as "0
 * votes cast" over votes that existed. Both photo viewers (the flock chat's
 * and the DM thread's) said "Loading the full photo..." on the scrim while the
 * original was fetched, with the row's thumbnail already in hand. Both screens
 * are rendered here with the harnesses guestVoteWeight.test.js and
 * dmVenueEmptyStates.test.js use, each checked complete against its screen.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonChatSheets
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');

// Both screens import these at module scope; none is under test, and all of
// them reach the network, the socket or the push plugin.
jest.mock('../services/api', () => ({
  __esModule: true,
  isOffline: () => false,
  BASE_URL: 'http://test.invalid',
  leaveFlock: jest.fn(),
  createBillSplit: jest.fn(),
  createFlockInviteLink: jest.fn(),
  getBillSplit: jest.fn(),
  // Never answers: the viewers stay in their loading state for the test.
  // Plain functions, not jest.fn: the suite resets mock implementations
  // before each test (resetMocks), which would leave these answering
  // undefined.
  getFlockMessageImage: () => new Promise(() => {}),
  getDmMessageImage: () => new Promise(() => {}),
  getPaymentLinks: jest.fn(),
  ghostCommit: jest.fn(),
  lockBudget: jest.fn(),
  resetBudget: jest.fn(),
  sendBillReminder: jest.fn(),
  sendBudgetReminder: jest.fn(),
  settleShare: jest.fn(),
  submitBudget: jest.fn(),
  trackNotificationPermission: jest.fn(),
  unsettleShare: jest.fn(),
  sendFriendRequest: jest.fn(),
  trackDmVenueVote: jest.fn(),
  addDmReaction: jest.fn(),
  removeDmReaction: jest.fn(),
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
const DmDetail = require('../screens/DmDetail').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const CHAT_SRC = read('screens', 'ChatDetail.js');
const DM_SRC = read('screens', 'DmDetail.js');

/** The names a screen's default export destructures. */
const paramsOf = (src, opener) => src
  .slice(src.indexOf(opener), src.indexOf('\n}) {', src.indexOf(opener)))
  .split('\n')
  .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
  .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
  .map((l) => l.slice(0, -1));

const ME = { id: 9, name: 'Jay' };
const HOST = ME.id;
// The real one is lifted from App.js in guestVoteWeight.test.js; a vote row is
// never drawn in these tests, so the plain sum is enough here.
const voteTotal = (v) => (v.voters || []).length + (v.guestCount || 0);

const COLORS = {
  navy: '#0d2847', navyBg: '#0d2847', navyMid: '#1b4a7a', navyMidBg: '#1b4a7a',
  steel: '#3d6b96', cream: '#f0ead8', creamDark: '#d9d0b8', red: '#b91c1c',
  redText: '#b91c1c', amber: '#f59e0b', amberText: '#92400e',
  textSecondary: '#5b6b7c', textTertiary: '#8a97a5',
};

const DM = { id: 7, userId: 7, name: 'Sam Diaz', profile_image_url: null, messages: [] };

const THUMB = 'data:image/png;base64,iVBORw0KGgo=';

/** The flock chat harness from guestVoteWeight.test.js, unchanged. */
function chatProps(over = {}) {
  const fn = () => jest.fn();
  const flock = {
    id: 1,
    name: 'Friday',
    creatorId: HOST,
    status: 'voting',
    members: [],
    messages: [],
    readers: [],
    memberCount: 3,
    ...(over.flock || {}),
  };
  const props = {
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
    voteTotal,
    MissingFlockPanel: () => null,
    addReactionToMessage: fn(),
    allVenues: [],
    authUser: { id: HOST, name: ME.name },
    billPaidBy: null,
    // App.js's own starting value. An empty array is truthy and would put a
    // bill card in the stream.
    billSplit: null,
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
    flockReplyingTo: null,
    setFlockReplyingTo: () => {},
    distanceKm: () => 9999,
    pinMessage: () => {},
    unpinMessage: () => {},
    colors: {},
    confirmClick: fn(),
    confirmFlockPlan: fn(),
    cancelFlockPlan: jest.fn(() => Promise.resolve(true)),
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
    flockInvitePulses: [],
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
    messagesError: '',
    moneyError: '',
    reloadMoneyState: fn(),
    reloadFlockMessages: fn(),
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
    votesLoaded: true,
    pendingImage: null,
    popularVenues: [],
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
    updateTravel: fn(),
    reconfirmFlock: fn(),
    typingUser: '',
    updateFlockVenue: fn(),
    updateFlockVotes: fn(),
    userLocation: null,
    ...over,
  };
  delete props.flock;
  return props;
}

/** The DM thread harness from dmVenueEmptyStates.test.js, unchanged. */
function dmProps(over = {}) {
  const fn = () => jest.fn();
  return {
    // App.js module scope, shared with other screens.
    ChatSkeleton: () => null,
    DM_PAGE_SIZE: 50,
    DialogBehavior: () => null,
    SearchInputLocal: () => null,
    VenueCard: () => null,
    colorsLight: COLORS,
    messagePreview: () => '',
    oldestServerId: () => null,
    onVenuePhotoError: fn(),
    resolveVenuePhoto: () => null,
    // FlockAppInner state, setters and handlers.
    allVenues: [],
    authUser: { id: 1, name: 'Alex' },
    chatInputHasText: false,
    colors: COLORS,
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
    dmMessagesError: '',
    reloadDmMessages: jest.fn(),
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
    isDark: false,
    loadDmVenueVotes: fn(),
    loadOlderDms: fn(),
    loadPopularVenues: fn(),
    olderLoading: false,
    openCameraViewfinder: fn(),
    openUserProfile: fn(),
    openVenueDetail: fn(),
    popularVenues: [],
    // Null is "a real location produced this list"; the fallback wording is
    // exercised where the fallback lives.
    venuesFromLabel: null,
    profilePic: null,
    retryFailedDm: fn(),
  discardFailedDm: fn(),
    selectedDm: DM,
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
    handleUnsendDm: fn(),
    ...over,
  };
}

function expectNoSpinnerOrLoadingText(container) {
  const spinning = Array.from(container.querySelectorAll('*')).filter((el) => /spin\b/.test(el.style.animation || ''));
  expect(spinning).toEqual([]);
  expect(container.textContent).not.toMatch(/Loading the votes…|Loading the votes\.\.\.|Loading the full photo…|Loading the full photo\.\.\./);
}

describe('the harnesses cover the screens they render', () => {
  test('every prop ChatDetail destructures is supplied', () => {
    const params = paramsOf(CHAT_SRC, 'export default function ChatDetail({');
    expect(params.length).toBeGreaterThan(100);
    const supplied = chatProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });

  test('every prop DmDetail destructures is supplied', () => {
    const params = paramsOf(DM_SRC, 'export default function DmDetail({');
    expect(params.length).toBeGreaterThan(50);
    const supplied = dmProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });
});

describe('the vote sheet', () => {
  test('while the tally is on the wire: three vote rows in the row\'s shape, and the count\'s line drawn rather than "0 votes cast"', () => {
    const { container } = render(React.createElement(ChatDetail, chatProps({ showVotePanel: true, votesLoading: true, votesLoaded: false })));
    const sheet = screen.getByText('Vote for a Venue').closest('.modal-content');
    expect(within(sheet).getByText('Loading the votes')).toBeTruthy();
    // The 36px square at radius 10, once a row.
    const squares = Array.from(sheet.querySelectorAll('.skeleton')).filter((b) => b.style.width === '36px' && b.style.height === '36px' && b.style.borderRadius === '10px');
    expect(squares).toHaveLength(3);
    // The cards at radius 14.
    const rows = Array.from(sheet.querySelectorAll('div')).filter((d) => d.style.borderRadius === '14px' && d.style.padding === '12px 14px');
    expect(rows).toHaveLength(3);
    // The header's count line is a bar, not a count of an empty tally.
    expect(within(sheet).queryByText(/votes? cast/)).toBeNull();
    expect(Array.from(sheet.querySelectorAll('.skeleton')).some((b) => b.style.width === '120px')).toBe(true);
    // Not the empty state either.
    expect(within(sheet).queryByText(/No votes yet/)).toBeNull();
    expectNoSpinnerOrLoadingText(container);
  });

  test('once the tally lands with no votes in it, the count says so and the rows go', () => {
    render(React.createElement(ChatDetail, chatProps({ showVotePanel: true, votesLoading: false, votesLoaded: true })));
    const sheet = screen.getByText('Vote for a Venue').closest('.modal-content');
    expect(within(sheet).getByText('0 votes cast')).toBeTruthy();
    expect(within(sheet).queryByText('Loading the votes')).toBeNull();
  });
});

describe('the photo viewers', () => {
  const photoRow = { id: 41, sender: 'Ava', senderId: 2, text: '', sentAt: '2026-10-30T20:00:00', message_type: 'image', thumb: THUMB, image: null, reactions: [] };

  test('the flock chat shows the row\'s thumbnail until the original lands, and says so to a screen reader', () => {
    const { container } = render(React.createElement(ChatDetail, chatProps({ flock: { messages: [photoRow] } })));
    fireEvent.click(screen.getByRole('button', { name: 'Open the photo from Ava' }));
    const viewer = container.querySelector('.modal-backdrop');
    expect(viewer).not.toBeNull();
    const shown = Array.from(viewer.querySelectorAll('img')).filter((img) => img.getAttribute('src') === THUMB);
    expect(shown).toHaveLength(1);
    expect(within(viewer).getByRole('status').textContent).toBe('Loading the full photo');
    expectNoSpinnerOrLoadingText(container);
  });

  test('the DM thread does the same with its thumb_url', () => {
    const dmPhoto = { id: 88, sender_id: 7, recipient_id: 1, sender_name: 'Sam Diaz', message_type: 'image', thumb_url: THUMB, image_url: null, content: '', created_at: '2026-10-30T20:00:00Z' };
    const { container } = render(React.createElement(DmDetail, dmProps({ selectedDm: { ...DM, messages: [dmPhoto] } })));
    fireEvent.click(screen.getByRole('button', { name: /^Open the photo/ }));
    const viewer = container.querySelector('.modal-backdrop');
    expect(viewer).not.toBeNull();
    const shown = Array.from(viewer.querySelectorAll('img')).filter((img) => img.getAttribute('src') === THUMB);
    expect(shown).toHaveLength(1);
    expect(within(viewer).getByRole('status').textContent).toBe('Loading the full photo');
    expectNoSpinnerOrLoadingText(container);
  });

  test('with no thumbnail in hand the wait is a photo-sized block in the dark tone, and a failure still says what went wrong', () => {
    // Both viewers, from their source: the block for a row with no thumbnail,
    // and the failure sentence kept as it was. Only the wait changed.
    for (const src of [CHAT_SRC, DM_SRC]) {
      expect(src).toContain('<SkeletonBlock dark width="min(80vw, 320px)" height="min(80vw, 320px)" radius={10} />');
      expect(src).toContain('{imageViewer.error}</p>');
      expect(src).not.toContain("'Loading the full photo\\u2026'");
    }
  });
});
