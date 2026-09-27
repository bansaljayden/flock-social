/**
 * A NOTIFICATION TAP FROM ONE OPEN CHAT INTO ANOTHER CARRIES NOTHING ACROSS.
 *
 * Maya is in her DM with Alice. She picks a photo and types "don't tell Bob
 * but...", then a push from Bob arrives and she taps it. The push router set
 * the new conversation and left the screen as it was, and neither chat screen
 * was keyed, so Bob's thread opened with Alice's sentence in the box, Alice's
 * photo armed in the composer and the reply bar still quoting Alice. One tap
 * on Send delivered the photo and the sentence to Bob. The flock chats did
 * the same from plan to plan, and a Birdie card took the same path.
 *
 * Every clear lived in the screens' own exits (leaveChatScreen,
 * leaveDmScreen), which a push never runs. Three things now close it:
 *
 *   1. Both screens are keyed on their conversation, so what they hold for
 *      themselves starts over.
 *   2. App.js puts down what IT holds for the composer (leaveOpenThread)
 *      whenever the open conversation stops being the one on screen.
 *   3. The flock chat, taken away that way, still files its draft against
 *      its own plan, as its own exit would have.
 *
 * App.js cannot be imported (it is the whole app), so the callback and the
 * effect that fires it are lifted out by source and run, the way
 * chatEchoOrderAndRetraction.test.js does it. The flock chat is rendered.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern chatThreadSwitch
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, cleanup } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  isOffline: jest.fn(() => false),
  BASE_URL: 'http://test.invalid',
  leaveFlock: jest.fn(),
  createBillSplit: jest.fn(),
  createFlockInviteLink: jest.fn(),
  getPaymentLinks: jest.fn(),
  ghostCommit: jest.fn(),
  lockBudget: jest.fn(),
  sendBudgetReminder: jest.fn(),
  settleShare: jest.fn(),
  submitBudget: jest.fn(),
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
const { clearFlockDrafts, readFlockDraft } = require('../lib/flockDrafts');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

const ME = { id: 9, name: 'Maya' };
const plan = (id, name) => ({ id, name, creatorId: 9, status: 'planning', members: [], messages: [], memberCount: 2 });
const FRIDAY = plan(1, 'Friday');
const SATURDAY = plan(2, 'Saturday');
const SENTENCE = "don't tell Bob but the table is under my name";

/* The props chatComposerAndInviteSheet.test.js hands the screen, which that
   file proves complete against the screen's parameter list. */
function chatProps(flock, over = {}) {
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
    authUser: ME,
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
    getSelectedFlock: () => flock,
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
    selectedFlockId: flock.id,
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

/* One brace-matched block of source starting at the first `{` at or after
   `from`, skipping strings and comments. */
function blockFrom(source, from) {
  let i = source.indexOf('{', from);
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', from), i + 1);
    }
    i += 1;
  }
  throw new Error('blockFrom: unterminated block');
}

/** The body of `const <name> = useCallback(() => { ... }`, by name. */
function callbackBody(name) {
  const at = APP.indexOf(`  const ${name} = useCallback(() => {`);
  if (at === -1) throw new Error(`no \`${name} = useCallback(() => {\` in App.js`);
  return blockFrom(APP, at);
}

beforeEach(() => clearFlockDrafts());

// ---------------------------------------------------------------------------
// 1. The flock chat, taken away without its own exit
// ---------------------------------------------------------------------------
describe('a flock chat taken away by a notification tap', () => {
  test("keeps its draft for its own plan, and the next plan's box is empty", () => {
    const friday = chatProps(FRIDAY);
    render(React.createElement(ChatDetail, friday));
    fireEvent.change(screen.getByLabelText('Message Friday'), { target: { value: SENTENCE } });
    // The push: the screen goes without Back or any other exit it draws.
    cleanup();
    expect(friday.setChatInput).not.toHaveBeenCalled();
    expect(readFlockDraft(ME.id, FRIDAY.id)).toBe(SENTENCE);

    // Saturday opens on its own (empty) draft, and nothing of Friday's is
    // loaded into App.js's shared composer, which is what Send reads.
    const saturday = chatProps(SATURDAY);
    render(React.createElement(ChatDetail, saturday));
    expect(screen.getByLabelText('Message Saturday').value).toBe('');
    expect(saturday.setChatInput.mock.calls.some(([v]) => v === SENTENCE)).toBe(false);
    cleanup();

    // And Friday has it back.
    const again = chatProps(FRIDAY);
    render(React.createElement(ChatDetail, again));
    expect(screen.getByLabelText('Message Friday').value).toBe(SENTENCE);
    expect(again.setChatInput).toHaveBeenCalledWith(SENTENCE);
  });

  test('a chat left through its own exit is not filed twice, or emptied', () => {
    render(React.createElement(ChatDetail, chatProps(FRIDAY)));
    fireEvent.change(screen.getByLabelText('Message Friday'), { target: { value: SENTENCE } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    cleanup();
    expect(readFlockDraft(ME.id, FRIDAY.id)).toBe(SENTENCE);
  });

  test('a chat still open when the account signs out does not put the draft back after the sweep', () => {
    render(React.createElement(ChatDetail, chatProps(FRIDAY)));
    fireEvent.change(screen.getByLabelText('Message Friday'), { target: { value: SENTENCE } });
    // Log out empties the store first; the screen goes with the account a
    // render later.
    clearFlockDrafts();
    cleanup();
    expect(readFlockDraft(ME.id, FRIDAY.id)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. What App.js holds, put down
// ---------------------------------------------------------------------------
describe("App.js puts down the composer it holds when the open conversation changes", () => {
  const NAMES = [
    'setChatInput', 'setPendingImage', 'setShowImagePreview', 'setFlockReplyingTo',
    'setShowReactionPicker', 'setShowFlockMenu', 'setShowLeaveConfirm', 'setShowChatSearch',
    'setChatSearch', 'setShowVotePanel', 'setChatNavOpen', 'setDmPendingImage',
    'setShowDmImagePreview', 'setDmReplyingTo', 'setShowDmReactionPicker', 'setShowDmMenu',
    'setShowDeleteDmConfirm', 'setShowDmChatSearch', 'setDmChatSearch', 'setShowDmVotePanel',
    'setShowDmVenueSearch', 'setDmNavOpen', 'setDmSharingLocation', 'dmStopSharingLocation',
  ];
  function leaveOpenThread({ dmSharingLocation = null } = {}) {
    const calls = {};
    const scope = {};
    NAMES.forEach((n) => { scope[n] = (v) => { calls[n] = (calls[n] || []).concat([v]); }; });
    // eslint-disable-next-line no-new-func
    const run = new Function(...NAMES, 'dmSharingLocation', `return () => ${callbackBody('leaveOpenThread')};`)(
      ...NAMES.map((n) => scope[n]), dmSharingLocation,
    );
    run();
    return calls;
  }

  test("the photo, the text, the quote and the sheets, flock and DM alike", () => {
    const calls = leaveOpenThread();
    expect(calls.setChatInput).toEqual(['']);
    // The armed photo and its preview, on both composers.
    expect(calls.setPendingImage).toEqual([null]);
    expect(calls.setShowImagePreview).toEqual([false]);
    expect(calls.setDmPendingImage).toEqual([null]);
    expect(calls.setShowDmImagePreview).toEqual([false]);
    // The reply bars. A quote of Alice's message sent into Bob's thread is
    // refused by the server, and the flock one was never cleared anywhere.
    expect(calls.setFlockReplyingTo).toEqual([null]);
    expect(calls.setDmReplyingTo).toEqual([null]);
    // The actions menus and the sheets.
    expect(calls.setShowReactionPicker).toEqual([null]);
    expect(calls.setShowDmReactionPicker).toEqual([null]);
    ['setShowFlockMenu', 'setShowLeaveConfirm', 'setShowChatSearch', 'setShowVotePanel', 'setChatNavOpen',
      'setShowDmMenu', 'setShowDeleteDmConfirm', 'setShowDmChatSearch', 'setShowDmVotePanel',
      'setShowDmVenueSearch', 'setDmNavOpen'].forEach((n) => expect(calls[n]).toEqual([false]));
    expect(calls.setChatSearch).toEqual(['']);
    expect(calls.setDmChatSearch).toEqual(['']);
    // No live share to end.
    expect(calls.dmStopSharingLocation).toBeUndefined();
  });

  test('a live DM location share with the last person ends, as leaveDmScreen ends it', () => {
    const calls = leaveOpenThread({ dmSharingLocation: 41 });
    expect(calls.dmStopSharingLocation).toEqual([41]);
    expect(calls.setDmSharingLocation).toEqual([null]);
  });

  // The layout effect that calls it, lifted and run over a sequence of screens.
  function openThreadEffect() {
    const at = APP.indexOf('  React.useLayoutEffect(() => {\n    const was = openThreadRef.current;');
    if (at === -1) throw new Error('the open-thread layout effect moved');
    const body = blockFrom(APP, at);
    const ref = { current: null };
    let left = 0;
    // eslint-disable-next-line no-new-func
    const step = new Function('openThreadRef', 'openThread', 'leaveOpenThread', body);
    return {
      show: (openThread) => step(ref, openThread, () => { left += 1; }),
      get left() { return left; },
    };
  }

  test('fires when one conversation replaces another, or the chat goes, and never on the way in', () => {
    const effect = openThreadEffect();
    effect.show(null);
    effect.show('dm:5');          // opened from the list: nothing to put down
    expect(effect.left).toBe(0);
    effect.show('dm:5');          // a re-render of the same thread
    expect(effect.left).toBe(0);
    effect.show('dm:7');          // Bob's push over Alice's thread
    expect(effect.left).toBe(1);
    effect.show('flock:2');       // a plan's push over a DM
    expect(effect.left).toBe(2);
    effect.show('flock:3');       // Birdie's vote card, plan to plan
    expect(effect.left).toBe(3);
    effect.show(null);            // a push to another tab
    expect(effect.left).toBe(4);
    effect.show('flock:3');       // back in: the screen restores its own draft
    expect(effect.left).toBe(4);
  });

  test('the open conversation is the screen and its id, and the clear runs before passive effects', () => {
    expect(APP).toMatch(/const openThread = currentScreen === 'chatDetail' && selectedFlockId != null\n\s+\? `flock:\$\{selectedFlockId\}`\n\s+: \(currentScreen === 'dmDetail' && selectedDmId != null \? `dm:\$\{selectedDmId\}` : null\);/);
    expect(APP).toMatch(/React\.useLayoutEffect\(\(\) => \{\n\s+const was = openThreadRef\.current;[\s\S]{0,200}\}, \[openThread, leaveOpenThread\]\);/);
  });

  test('both chat screens are keyed on their conversation', () => {
    expect(APP).toMatch(/<React\.Suspense key=\{`flock:\$\{selectedFlockId\}`\} fallback=\{<ScreenChunkFallback chat \/>\}>\n\s+<ChatDetail \{\.\.\.chatDetailProps\} \/>/);
    expect(APP).toMatch(/<React\.Suspense key=\{`dm:\$\{selectedDmId\}`\} fallback=\{<ScreenChunkFallback chat \/>\}>\n\s+<DmDetail \{\.\.\.dmDetailProps\} \/>/);
  });
});
