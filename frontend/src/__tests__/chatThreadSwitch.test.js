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
 * leaveDmScreen), which a push never runs. Four things now close it:
 *
 *   1. Both screens are keyed on their conversation, so what they hold for
 *      themselves starts over.
 *   2. App.js puts down what IT holds for the composer (leaveOpenThread)
 *      whenever the open conversation stops being the one on screen,
 *      the in-app camera included.
 *   3. The flock chat, taken away that way, still files its draft against
 *      its own plan, as its own exit would have.
 *   4. A photo still being sized when that happens (a library pick, or a
 *      camera shot already accepted) arms nothing, and a camera stream that
 *      arrives after its viewfinder closed is stopped, not held.
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
    'closeCameraViewfinder',
  ];
  function leaveOpenThread({ dmSharingLocation = null, threadEpochRef = { current: 0 } } = {}) {
    const calls = {};
    const scope = {};
    NAMES.forEach((n) => { scope[n] = (v) => { calls[n] = (calls[n] || []).concat([v]); }; });
    // eslint-disable-next-line no-new-func
    const run = new Function(...NAMES, 'dmSharingLocation', 'threadEpochRef', `return () => ${callbackBody('leaveOpenThread')};`)(
      ...NAMES.map((n) => scope[n]), dmSharingLocation, threadEpochRef,
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

  test('the in-app camera closes, and every photo still being sized for the thread is marked as left', () => {
    const threadEpochRef = { current: 4 };
    const calls = leaveOpenThread({ threadEpochRef });
    // The viewfinder is drawn over whichever chat opened it, and a push banner
    // is tappable above it.
    expect(calls.closeCameraViewfinder).toHaveLength(1);
    expect(threadEpochRef.current).toBe(5);
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

// ---------------------------------------------------------------------------
// 3. A photo on its way into the composer when the conversation changes
// ---------------------------------------------------------------------------
//
// Maya opens the camera in her DM with Alice and takes a shot. Bob's banner
// comes down over the viewfinder and she taps it: the push router moves the
// app to Bob's thread underneath the camera, which is drawn over everything.
// She taps Use Photo, and the shot, sized a moment later, armed in Bob's
// composer. A library pick does the same while it is read and sized. The
// camera now closes with the thread, and each photo route notes the thread it
// started in (threadEpochRef) and arms nothing if that thread has been left.

/* A whole `const <name> = useCallback(...);` statement, brace-matched to the
   `;` that ends it at depth zero, skipping strings and comments. */
function callbackStatement(name) {
  const start = APP.indexOf(`  const ${name} = useCallback(`);
  if (start === -1) throw new Error(`no \`${name} = useCallback(\` in App.js`);
  let i = APP.indexOf('=', start) + 1;
  let depth = 0;
  while (i < APP.length) {
    const ch = APP[i];
    const next = APP[i + 1];
    if (ch === '/' && next === '/') { i = APP.indexOf('\n', i); if (i === -1) break; continue; }
    if (ch === '/' && next === '*') { const end = APP.indexOf('*/', i + 2); i = end === -1 ? APP.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < APP.length) {
        if (APP[i] === '\\') { i += 2; continue; }
        if (APP[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return APP.slice(start, i + 1);
    i += 1;
  }
  throw new Error(`${name}: unterminated statement`);
}

/** The callback, lifted and built over `scope`, as React would hand it out. */
function lifted(name, scope) {
  const all = { useCallback: (fn) => fn, ...scope };
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(all), `${callbackStatement(name)}\nreturn ${name};`)(...Object.values(all));
}

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const SIZED = 'data:image/jpeg;base64,U0laRUQ=';

/* The composer state a photo arms, recorded. */
function composerState() {
  const armed = {};
  const record = (key) => (v) => { armed[key] = (armed[key] || []).concat([v]); };
  return {
    armed,
    setters: {
      setPendingImage: record('pendingImage'),
      setShowImagePreview: record('showImagePreview'),
      setDmPendingImage: record('dmPendingImage'),
      setShowDmImagePreview: record('showDmImagePreview'),
    },
  };
}

/* leaveOpenThread over one shared epoch, as the layout effect runs it when a
   notification tap moves the app. */
function leaveOver(threadEpochRef, closeCameraViewfinder = () => {}) {
  const scope = { threadEpochRef, closeCameraViewfinder, setChatInput: () => {}, dmSharingLocation: null };
  [
    'setPendingImage', 'setShowImagePreview', 'setFlockReplyingTo', 'setShowReactionPicker', 'setShowFlockMenu',
    'setShowLeaveConfirm', 'setShowChatSearch', 'setChatSearch', 'setShowVotePanel', 'setChatNavOpen',
    'setDmPendingImage', 'setShowDmImagePreview', 'setDmReplyingTo', 'setShowDmReactionPicker', 'setShowDmMenu',
    'setShowDeleteDmConfirm', 'setShowDmChatSearch', 'setDmChatSearch', 'setShowDmVotePanel',
    'setShowDmVenueSearch', 'setDmNavOpen', 'setDmSharingLocation', 'dmStopSharingLocation',
  ].forEach((n) => { scope[n] = () => {}; });
  return lifted('leaveOpenThread', scope);
}

describe('a photo still being sized when the conversation changes', () => {
  function libraryPick(name) {
    const threadEpochRef = { current: 0 };
    const { armed, setters } = composerState();
    const readers = [];
    const sizing = [];
    class FakeReader {
      readAsDataURL() { this.result = 'data:image/jpeg;base64,UkFX'; readers.push(this); }
    }
    const toasts = [];
    const pick = lifted(name, {
      showToast: (m) => toasts.push(m),
      threadEpochRef,
      FileReader: FakeReader,
      prepareChatImage: () => { const d = deferred(); sizing.push(d); return d.promise; },
      ...setters,
    });
    const event = { target: { files: [{ size: 1024 }], value: 'photo.jpg' } };
    return { threadEpochRef, armed, readers, sizing, toasts, pick: () => pick(event) };
  }

  describe.each([
    ['the flock composer', 'handleChatImageSelect', 'pendingImage', 'showImagePreview'],
    ['the DM composer', 'handleDmImageSelect', 'dmPendingImage', 'showDmImagePreview'],
  ])('a library pick into %s', (_, name, imageKey, previewKey) => {
    test('arms in the thread it was picked in', async () => {
      const p = libraryPick(name);
      p.pick();
      p.readers[0].onload();
      p.sizing[0].resolve({ dataUrl: SIZED });
      await flush();
      expect(p.armed[imageKey]).toEqual([SIZED]);
      expect(p.armed[previewKey]).toEqual([true]);
    });

    test('arms nothing once the thread is left while it is being sized', async () => {
      const p = libraryPick(name);
      p.pick();
      p.readers[0].onload();
      // Bob's banner, tapped.
      leaveOver(p.threadEpochRef)();
      p.sizing[0].resolve({ dataUrl: SIZED });
      await flush();
      expect(p.armed).toEqual({});
    });

    test('is not even sized once the thread is left while the file is read', async () => {
      const p = libraryPick(name);
      p.pick();
      leaveOver(p.threadEpochRef)();
      p.readers[0].onload();
      await flush();
      expect(p.sizing).toHaveLength(0);
      expect(p.armed).toEqual({});
    });

    test("a sizing failure in a thread already left says nothing over the next one", async () => {
      const p = libraryPick(name);
      p.pick();
      p.readers[0].onload();
      leaveOver(p.threadEpochRef)();
      p.sizing[0].resolve({ error: 'That photo is too large to send.' });
      await flush();
      expect(p.toasts).toEqual([]);
    });
  });

  describe('Use Photo on a shot from the in-app camera', () => {
    function camera(source) {
      const threadEpochRef = { current: 0 };
      const { armed, setters } = composerState();
      const sizing = [];
      const closes = [];
      const busy = [];
      const accept = lifted('acceptCameraPhoto', {
        cameraReview: { dataUrl: 'data:image/jpeg;base64,RlVMTA==', source },
        cameraBusy: false,
        threadEpochRef,
        setCameraBusy: (v) => busy.push(v),
        prepareChatImage: () => { const d = deferred(); sizing.push(d); return d.promise; },
        closeCameraViewfinder: () => closes.push('close'),
        showToast: () => {},
        ...setters,
      });
      return { threadEpochRef, armed, sizing, closes, busy, accept };
    }

    test('arms the thread the shot was taken in', async () => {
      const c = camera('dm');
      c.accept();
      c.sizing[0].resolve({ dataUrl: SIZED });
      await flush();
      expect(c.closes).toEqual(['close']);
      expect(c.armed.dmPendingImage).toEqual([SIZED]);
      expect(c.armed.showDmImagePreview).toEqual([true]);
    });

    test("Alice's shot, accepted as a tap moves the app to Bob's thread, arms nothing", async () => {
      const c = camera('dm');
      c.accept();
      // The tap: the layout effect runs leaveOpenThread, which closes the
      // camera itself.
      leaveOver(c.threadEpochRef, () => c.closes.push('left'))();
      c.sizing[0].resolve({ dataUrl: SIZED });
      await flush();
      expect(c.closes).toEqual(['left']);
      expect(c.armed).toEqual({});
    });

    test('a flock shot is held to its plan the same way', async () => {
      const c = camera('flock');
      c.accept();
      leaveOver(c.threadEpochRef)();
      c.sizing[0].resolve({ dataUrl: SIZED });
      await flush();
      expect(c.armed).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// 4. A camera closed while it is still being acquired
// ---------------------------------------------------------------------------
//
// leaveOpenThread closes the camera at whatever moment the tap lands, and
// that can be inside the one-tick wait before the stream is asked for, or
// while getUserMedia is still out (the permission prompt, the first time).
// A stream that arrived after its viewfinder closed used to be held anyway:
// nothing showed it, and the camera light stayed on until the app went away.
describe('a camera closed while its stream is still on the way', () => {
  function rig() {
    const cameraSessionRef = { current: 0 };
    const cameraStreamRef = { current: null };
    const cameraVideoRef = { current: null };
    const asks = [];
    const ticks = [];
    const toasts = [];
    const shown = [];
    const navigator = {
      mediaDevices: { getUserMedia: () => { const d = deferred(); asks.push(d); return d.promise; } },
    };
    const noop = () => {};
    const stopCameraTracks = lifted('stopCameraTracks', { cameraStreamRef, cameraVideoRef });
    const startCameraStream = lifted('startCameraStream', {
      cameraSessionRef, cameraStreamRef, cameraVideoRef, stopCameraTracks, navigator,
      setCameraTorch: noop, readCameraCaps: noop, CAMERA_RES: {},
    });
    const closeCameraViewfinder = lifted('closeCameraViewfinder', {
      cameraSessionRef, stopCameraTracks,
      setShowCameraViewfinder: (v) => shown.push(v),
      setCameraCaps: noop, setCameraTorch: noop, setCameraFocusPoint: noop, setCameraReview: noop, setCameraBusy: noop,
    });
    const openCameraViewfinder = lifted('openCameraViewfinder', {
      navigator, cameraSessionRef, startCameraStream, stopCameraTracks,
      showToast: (m) => toasts.push(m),
      setShowCameraViewfinder: (v) => shown.push(v),
      setCameraFacing: noop, setCameraCaps: noop, setCameraFocusPoint: noop,
      setTimeout: (fn) => { ticks.push(fn); },
    });
    return { cameraStreamRef, asks, ticks, toasts, shown, openCameraViewfinder, closeCameraViewfinder };
  }
  const fakeStream = () => {
    const track = { stop: jest.fn() };
    return { track, getTracks: () => [track], getVideoTracks: () => [track] };
  };

  test('an open that runs its course holds the stream', async () => {
    const r = rig();
    r.openCameraViewfinder('dm');
    const tick = r.ticks[0]();
    const stream = fakeStream();
    r.asks[0].resolve(stream);
    await tick;
    expect(r.cameraStreamRef.current).toBe(stream);
    expect(stream.track.stop).not.toHaveBeenCalled();
  });

  test('closed inside the wait, the camera is never asked for', async () => {
    const r = rig();
    r.openCameraViewfinder('dm');
    r.closeCameraViewfinder();
    await r.ticks[0]();
    expect(r.asks).toHaveLength(0);
    expect(r.cameraStreamRef.current).toBe(null);
  });

  test('closed while the stream is being asked for, the stream is stopped where it lands', async () => {
    const r = rig();
    r.openCameraViewfinder('dm');
    const tick = r.ticks[0]();
    r.closeCameraViewfinder();
    const stream = fakeStream();
    r.asks[0].resolve(stream);
    await tick;
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    expect(r.cameraStreamRef.current).toBe(null);
  });

  test("a stale start leaves the viewfinder opened after it alone", async () => {
    const r = rig();
    r.openCameraViewfinder('dm');
    r.closeCameraViewfinder();
    r.openCameraViewfinder('flock');
    // The second open's stream arrives first.
    const second = r.ticks[1]();
    const stream = fakeStream();
    r.asks[0].resolve(stream);
    await second;
    // Then the first open's tick fires, late.
    await r.ticks[0]();
    expect(r.asks).toHaveLength(1);
    expect(r.cameraStreamRef.current).toBe(stream);
    expect(stream.track.stop).not.toHaveBeenCalled();
  });

  test('a refusal that lands after the close raises no error over the next screen', async () => {
    const r = rig();
    r.openCameraViewfinder('dm');
    const tick = r.ticks[0]();
    r.closeCameraViewfinder();
    const shownAtClose = r.shown.slice();
    // Every fallback startCameraStream tries is refused.
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    r.asks[0].reject(denied);
    await flush();
    r.asks[1].reject(denied);
    await flush();
    r.asks[2].reject(denied);
    await tick;
    expect(r.toasts).toEqual([]);
    expect(r.shown).toEqual(shownAtClose);
  });
});
