/**
 * A HALF-WRITTEN FLOCK MESSAGE LEAVES WITH THE ACCOUNT THAT WROTE IT.
 *
 * The flock chat keeps a sentence somebody backed out of, so it is in the box
 * on their next visit to the same plan. It was held in a Map at the top of
 * screens/ChatDetail.js, keyed by plan alone, and signing out is not a page
 * load: App.js endSession sets the account to null and api.js
 * clearLocalSession sweeps storage, and neither reached that Map. So on a
 * shared phone the next account to open a plan both of them are in found the
 * last account's sentence in its composer with Send armed, one tap from going
 * out under the wrong name.
 *
 * These drive the real chat screen and the real sign-out. The drafts live in
 * lib/flockDrafts.js now, filed under the account as well as the plan, and
 * clearLocalSession empties them.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern flockDraftSignOut
 */

const React = require('react');
const { render, screen, fireEvent, cleanup } = require('@testing-library/react');

// The chat screen's socket and push imports reach the network or the
// Capacitor bridge. api.js is the real one: its sign-out is under test.
jest.mock('../services/socket', () => ({
  leaveFlock: jest.fn(),
  getSocket: jest.fn(() => ({ connected: true })),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(() => 'granted'),
  requestNotificationPermission: jest.fn(),
}));

const ChatDetail = require('../screens/ChatDetail').default;
const { clearLocalSession } = require('../services/api');
const { clearFlockDrafts, readFlockDraft } = require('../lib/flockDrafts');

const FLOCK = {
  id: 1,
  name: 'Saturday',
  creatorId: 9,
  status: 'planning',
  members: [],
  messages: [],
  memberCount: 2,
};

const ACCOUNT_A = { id: 9, name: 'Ada' };
const ACCOUNT_B = { id: 12, name: 'Ben' };
const SENTENCE = "honestly Ben is being annoying, let's not invite him";

/* The props chatComposerAndInviteSheet.test.js hands the screen, which that
   file proves complete against the screen's parameter list. */
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
    memberCountLabel: () => '2 people',
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
    authUser: ACCOUNT_A,
    billPaidBy: null,
    billSplit: [],
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
    flockReplyingTo: null,
    setFlockReplyingTo: () => {},
    distanceKm: () => 9999,
    pinMessage: () => {},
    unpinMessage: () => {},
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
    messagesError: '',
    moneyError: '',
    reloadMoneyState: jest.fn(),
    reloadFlockMessages: jest.fn(),
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
    typingUser: '',
    updateFlockVenue: fn(),
    updateFlockVotes: fn(),
    updateTravel: fn(),
    reconfirmFlock: fn(),
    userLocation: null,
    handleUnsendFlockMessage: fn(),
    eventCrowd: null,
    eventCrowdLabel: null,
    ...over,
  };
}

const box = () => screen.getByLabelText('Message Saturday');

/** Open the plan as `account`, write the sentence, and back out. */
function writeAndLeave(account) {
  const p = chatProps({ authUser: account });
  render(React.createElement(ChatDetail, p));
  fireEvent.change(box(), { target: { value: SENTENCE } });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  cleanup();
  return p;
}

/** Open the plan as `account` and report what the box holds. */
function openAs(account) {
  const p = chatProps({ authUser: account });
  render(React.createElement(ChatDetail, p));
  const value = box().value;
  const loadedIntoComposer = p.setChatInput.mock.calls.some(([v]) => v === SENTENCE);
  cleanup();
  return { value, loadedIntoComposer };
}

beforeEach(() => clearFlockDrafts());
afterAll(() => localStorage.clear());

describe('a flock draft belongs to the account that wrote it', () => {
  test('backing out keeps it for the same account, which is what the store is for', () => {
    writeAndLeave(ACCOUNT_A);
    const back = openAs(ACCOUNT_A);
    expect(back.value).toBe(SENTENCE);
    expect(back.loadedIntoComposer).toBe(true);
  });

  test('another account opening the same plan gets an empty box', () => {
    writeAndLeave(ACCOUNT_A);
    const other = openAs(ACCOUNT_B);
    expect(other.value).toBe('');
    // Nor is it loaded into App.js's shared composer, which is what Send reads.
    expect(other.loadedIntoComposer).toBe(false);
    // And the writer still has it.
    expect(openAs(ACCOUNT_A).value).toBe(SENTENCE);
  });

  test('signing out takes it off the device', () => {
    writeAndLeave(ACCOUNT_A);
    expect(readFlockDraft(ACCOUNT_A.id, FLOCK.id)).toBe(SENTENCE);

    clearLocalSession();

    expect(readFlockDraft(ACCOUNT_A.id, FLOCK.id)).toBe('');
    const next = openAs(ACCOUNT_B);
    expect(next.value).toBe('');
    expect(next.loadedIntoComposer).toBe(false);
    // Signing back in as the writer does not bring it back either: sign-out
    // is the end of everything that session left on the phone.
    expect(openAs(ACCOUNT_A).value).toBe('');
  });
});
