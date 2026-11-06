/**
 * A VOTE OR SHARE ROW DRAWS A GOOGLE PHOTO ONLY WITH ITS DOOR TO THE SHEET
 * (2026-11-06).
 *
 * Google lets a Places photo go uncredited only as a thumbnail whose tap
 * reaches a credited, larger version (components/ui/GoogleCredit.js). A vote
 * row's own tap votes and a share row's shares, so the photo gets a button of
 * its own to the venue's sheet (ThumbToSheet), and that sheet needs a place
 * id. So a venue with a photo URL and no place id draws the tile, not the
 * photo, and no door; and a list with no Google place in it ends on no Google
 * mark.
 *
 * Rendered, in both chat screens: the flock chat's vote and share sheets
 * (screens/ChatDetail.js) and the DM's (screens/DmDetail.js). The harnesses
 * are the shapes venueDealOnVotes.test.js and dmVenueDealOnVotes.test.js use.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=googleVoteRowPhotos
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, within, act } = require('@testing-library/react');

// The screens import these at module scope. None is under test and each
// reaches the network or the socket.
jest.mock('../services/api', () => ({
  __esModule: true,
  isOffline: jest.fn(() => false),
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
  submitVenueFeedback: jest.fn(),
  trackNotificationPermission: jest.fn(),
  unsettleShare: jest.fn(),
  sendFriendRequest: jest.fn(),
  trackDmVenueVote: jest.fn(),
  getDmMessageImage: jest.fn(),
}));
jest.mock('../services/socket', () => ({
  __esModule: true,
  leaveFlock: jest.fn(),
  dmReact: jest.fn(),
  dmRemoveReact: jest.fn(),
  dmStopSharingLocation: jest.fn(),
  dmVoteVenue: jest.fn(() => true),
  getSocket: jest.fn(() => ({ connected: true })),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(() => 'granted'),
  requestNotificationPermission: jest.fn(),
}));
// BirdieBird runs a rAF loop behind an IntersectionObserver, which jsdom does
// not have. What he looks like is not what this file is about.
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote: Stub, WARM_BIRD: {} };
});

const ChatDetail = require('../screens/ChatDetail').default;
const DmDetail = require('../screens/DmDetail').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const paramsOf = (src, head) => src
  .slice(src.indexOf(head), src.indexOf('\n}) {', src.indexOf(head)))
  .split('\n')
  .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
  .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
  .map((l) => l.slice(0, -1));

const PHOTO_KOME = 'https://api.test/api/venues/photo?ref=KOME&maxwidth=400';
const PHOTO_CORVID = 'https://api.test/api/venues/photo?ref=CORVID&maxwidth=400';
// A Google place, and a venue with a photo URL but no place id behind it.
const KOME = { id: 'ChIJkome000001', place_id: 'ChIJkome000001', name: 'Kome', type: 'Restaurant', category: 'Food', photo_url: PHOTO_KOME };
const CORVID = { id: 'corvid-coffee', name: 'Corvid Coffee', type: 'Cafe', category: 'Food', photo_url: PHOTO_CORVID };

/* ═══════════════════════════════════════════════════════════════════════════
   The flock chat
   ═══════════════════════════════════════════════════════════════════════════ */

function chatProps(over = {}) {
  const fn = () => jest.fn();
  const flock = { id: 1, name: 'Friday', creatorId: 9, status: 'voting', members: [], messages: [], readers: [], memberCount: 3, votes: [] };
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
    resolveVenuePhoto: (u) => u || null,
    voteTotal: (v) => (v && v.votes) || 0,
    MissingFlockPanel: () => null,
    addReactionToMessage: fn(),
    allVenues: [],
    authUser: { id: 9, name: 'Jay' },
    billPaidBy: null,
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
    colors: { steel: '#2d5a87' },
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
  return props;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The DM
   ═══════════════════════════════════════════════════════════════════════════ */

const COLORS = {
  navy: '#0d2847', navyBg: '#0d2847', navyMid: '#1b4a7a', navyMidBg: '#1b4a7a',
  steel: '#3d6b96', cream: '#f0ead8', creamDark: '#d9d0b8', red: '#b91c1c',
  redText: '#b91c1c', amber: '#f59e0b', amberText: '#92400e',
  textSecondary: '#5b6b7c', textTertiary: '#8a97a5',
};
const DM = { id: 7, userId: 7, name: 'Sam Diaz', profile_image_url: null, messages: [] };

function dmProps(over = {}) {
  const fn = () => jest.fn();
  return {
    ChatSkeleton: () => null,
    DM_PAGE_SIZE: 50,
    DialogBehavior: () => null,
    SearchInputLocal: () => null,
    VenueCard: () => null,
    colorsLight: COLORS,
    messagePreview: () => '',
    oldestServerId: () => null,
    onVenuePhotoError: fn(),
    resolveVenuePhoto: (u) => u || null,
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
    reloadDmMessages: fn(),
    dmNavOpen: false,
    dmNotConnected: false,
    dmPendingImage: null,
    dmPinnedVenue: null,
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

describe('the harnesses cover the screens they render', () => {
  test('every prop each screen destructures is supplied', () => {
    const chat = paramsOf(read('screens', 'ChatDetail.js'), 'export default function ChatDetail({');
    expect(chat.length).toBeGreaterThan(100);
    expect(chat.filter((name) => !(name in chatProps()))).toEqual([]);
    const dm = paramsOf(read('screens', 'DmDetail.js'), 'export default function DmDetail({');
    expect(dm.length).toBeGreaterThan(50);
    expect(dm.filter((name) => !(name in dmProps()))).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The rule, sheet by sheet
   ═══════════════════════════════════════════════════════════════════════════ */

// The open sheet, found by its title.
const sheetTitled = (title) => screen.getByText(title).closest('.modal-content');

// Kome draws its photo and a door to its sheet, which opens on Kome's place
// id once the chat has stepped aside; Corvid Coffee, with no place id, draws
// neither. Every row's own tap starts with confirmClick, so a door that leaked
// into its row would show there.
function expectTheRule(sheet, props) {
  expect(sheet.querySelector(`img[src="${PHOTO_KOME}"]`)).not.toBeNull();
  expect(sheet.querySelector(`img[src="${PHOTO_CORVID}"]`)).toBeNull();
  expect(within(sheet).queryByRole('button', { name: 'Open Corvid Coffee' })).toBeNull();
  const door = within(sheet).getByRole('button', { name: 'Open Kome' });
  // The door is beside the row's button, never inside it.
  expect(door.parentElement.closest('button')).toBeNull();

  jest.useFakeTimers();
  try {
    fireEvent.click(door);
    act(() => { jest.advanceTimersByTime(600); });
  } finally {
    jest.useRealTimers();
  }
  expect(props.openVenueDetail).toHaveBeenCalledTimes(1);
  expect(props.openVenueDetail.mock.calls[0][0]).toBe(KOME.place_id);
  expect(props.openVenueDetail.mock.calls[0][1]).toMatchObject({ place_id: KOME.place_id, photo_url: PHOTO_KOME });
  // The door does not do the row's job.
  expect(props.confirmClick).not.toHaveBeenCalled();
}

describe('the flock chat', () => {
  test('the vote sheet: a suggestion draws its Google photo only with a place id, beside a door to its sheet', () => {
    const p = chatProps({ showVotePanel: true, popularVenues: [KOME, CORVID] });
    render(React.createElement(ChatDetail, p));
    const sheet = sheetTitled('Vote for a Venue');
    expectTheRule(sheet, p);
    // A Google place is in the list, so it ends on the mark.
    expect(within(sheet).getByTestId('google-maps-attribution').textContent).toBe('Google Maps');
  });

  test('the vote sheet: a list with no Google place in it carries no Google mark', () => {
    render(React.createElement(ChatDetail, chatProps({ showVotePanel: true, popularVenues: [CORVID] })));
    const sheet = sheetTitled('Vote for a Venue');
    expect(within(sheet).getByText('Corvid Coffee')).toBeTruthy();
    expect(within(sheet).queryByTestId('google-maps-attribution')).toBeNull();
  });

  test('the share sheet: the same rule, and the row still shares', () => {
    const p = chatProps({ showVenueShareModal: true, budgetFilteredVenues: [KOME, CORVID] });
    render(React.createElement(ChatDetail, p));
    const sheet = sheetTitled('Share a Venue');
    expectTheRule(sheet, p);
    expect(within(sheet).getByTestId('google-maps-attribution')).toBeTruthy();
    fireEvent.click(within(sheet).getByText('Corvid Coffee').closest('button'));
    expect(p.shareVenueToChat).toHaveBeenCalledWith(1, CORVID);
  });

  test('the share sheet: no Google place, no Google mark', () => {
    render(React.createElement(ChatDetail, chatProps({ showVenueShareModal: true, budgetFilteredVenues: [CORVID] })));
    expect(within(sheetTitled('Share a Venue')).queryByTestId('google-maps-attribution')).toBeNull();
  });
});

describe('the DM', () => {
  test('the vote panel: a suggestion draws its Google photo only with a place id, beside a door to its sheet', () => {
    const p = dmProps({ showDmVotePanel: true, popularVenues: [KOME, CORVID] });
    render(React.createElement(DmDetail, p));
    const sheet = sheetTitled('Vote for a Venue');
    expectTheRule(sheet, p);
    expect(within(sheet).getByTestId('google-maps-attribution')).toBeTruthy();
  });

  test('the vote panel: a list with no Google place in it carries no Google mark', () => {
    render(React.createElement(DmDetail, dmProps({ showDmVotePanel: true, popularVenues: [CORVID] })));
    const sheet = sheetTitled('Vote for a Venue');
    expect(within(sheet).getByText('Corvid Coffee')).toBeTruthy();
    expect(within(sheet).queryByTestId('google-maps-attribution')).toBeNull();
  });

  test('the share sheet: the same rule, and the row still sends the venue', () => {
    const p = dmProps({ showDmVenueSearch: true, allVenues: [KOME, CORVID] });
    render(React.createElement(DmDetail, p));
    const sheet = sheetTitled('Share a Venue');
    expectTheRule(sheet, p);
    expect(within(sheet).getByTestId('google-maps-attribution')).toBeTruthy();
    fireEvent.click(within(sheet).getByText('Corvid Coffee').closest('button'));
    expect(p.sendDmMessage).toHaveBeenCalledTimes(1);
    expect(p.sendDmMessage.mock.calls[0][0]).toMatchObject({ message_type: 'venue_card' });
  });

  test('the share sheet: no Google place, no Google mark', () => {
    render(React.createElement(DmDetail, dmProps({ showDmVenueSearch: true, allVenues: [CORVID] })));
    expect(within(sheetTitled('Share a Venue')).queryByTestId('google-maps-attribution')).toBeNull();
  });
});
