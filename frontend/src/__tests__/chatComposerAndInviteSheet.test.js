// ---------------------------------------------------------------------------
// THE COMPOSER'S SEND BUTTON AND THE INVITE SHEET, RENDERED AND EXECUTED.
//
// TEST-EFFECTIVENESS-FRONTEND.md left three rows of the chat send path green
// after the mutation audit, and said why: `chatSurface.test.js` covers the send
// path with SOURCE PINS, because `transmitFlockMessage` is a `useCallback`
// closed over eight refs and "reaching it for real means rendering the whole
// app". A pin refuses one spelling of one edit. It does not establish the
// property. The three that were left:
//
//   the send button loses `disabled={!chatInputHasText}`
//   the invite sheet fires with nothing selected
//   an invite failure is swallowed
//
// "Rendering the whole app" turns out not to be what the first two need. The
// flock chat screen left `App.js` on 2026-08-26, and what came out is a
// function with 146 props and NOT ONE HOOK: no `useState`, no `useEffect`, no
// `useRef`. It is a pure function of its props, so it mounts on its own with a
// hand-built props object and no App.js anywhere near it, and the two button
// facts above become things this file watches happen rather than things it
// reads about in the source. A click on the disabled send button is dispatched
// here for real, and the assertion is that `sendChatMessage` was not called.
//
// The third one is genuinely in `App.js`: `handleSendFlockInvites` is a
// `useCallback` inside `FlockAppInner` and arrives at the screen as a prop, so
// no amount of rendering the screen reaches it. It is not pinned here either.
// Its body is LIFTED out of App.js as source text and executed against stand-in
// collaborators, which is the same move `contentTakedownWiring` and
// `chatSurface` already use for module-scope helpers, extended to a closure by
// naming the free variables and passing them in. What that buys over a pin: the
// guard is executed, so deleting it lets a real call through to a real spy, and
// the catch is executed, so a rejected invite either reaches `showToast` or it
// does not. What it does not buy: proof that App.js passes these particular
// collaborators. The extraction is anchored on the exact dependency array, so
// an edit that changes the closure's inputs breaks the lift loudly instead of
// testing a stale copy.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test chatComposerAndInviteSheet --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent } = require('@testing-library/react');

// The screen imports these four modules at module scope. None of them is under
// test here and all four reach the network or the Capacitor bridge.
jest.mock('../services/api', () => ({
  __esModule: true,
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
jest.mock('../services/socket', () => ({ leaveFlock: jest.fn() }));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(() => 'granted'),
  requestNotificationPermission: jest.fn(),
}));

const ChatDetail = require('../screens/ChatDetail').default;

const FLOCK = {
  id: 1,
  name: 'Friday',
  creatorId: 9,
  status: 'planning',
  members: [],
  messages: [],
  memberCount: 2,
};

/**
 * A full props object for the screen. Every name below is a parameter the
 * screen destructures, and the test that follows this comment block proves the
 * list is still complete: a prop added to the screen and forgotten here would
 * otherwise arrive as undefined and quietly take a different branch.
 */
function chatProps(over = {}) {
  const fn = () => jest.fn();
  return {
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
    authUser: { id: 9, name: 'Jay' },
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
    chatSearch: '',
    chatSearchRef: { current: null },
    colors: {},
    confirmClick: fn(),
    confirmFlockPlan: fn(),
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
    handleTouchEnd: fn(),
    handleTouchMove: fn(),
    handleTouchStart: fn(),
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
    pendingImage: null,
    popularVenues: [],
    profilePic: null,
    renderFlockInviteRow: () => null,
    replyingTo: null,
    retryFailedMessage: fn(),
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
    setReplyingTo: fn(),
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
    swipeState: {},
    typingUser: '',
    updateFlockVenue: fn(),
    updateFlockVotes: fn(),
    ...over,
  };
}

const SCREEN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'screens', 'ChatDetail.js'), 'utf8',
);
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

describe('the harness is handed the same screen App.js hands it', () => {
  test('every prop the screen destructures has a value here', () => {
    // The screen has no hooks and no defaults, so a missing prop is `undefined`
    // and `undefined` takes the falsy branch of every conditional in the file.
    // A harness that quietly stops covering half the screen looks exactly like
    // a harness that passes, which is why the parameter list is read back out
    // of the source rather than trusted.
    const params = SCREEN_SOURCE
      .slice(
        SCREEN_SOURCE.indexOf('export default function ChatDetail({'),
        SCREEN_SOURCE.indexOf('\n}) {'),
      )
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
      .map((l) => l.slice(0, -1));

    // Vacuity: 146 names on 2026-08-26. A parse that finds a handful means the
    // slice above stopped matching, not that the screen got simpler.
    expect(params.length).toBeGreaterThan(100);

    const supplied = chatProps();
    const missing = params.filter((name) => !(name in supplied));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The most-used control in the product.
// ---------------------------------------------------------------------------
describe('the send button', () => {
  test('an empty composer cannot fire it, and the click proves it', () => {
    // The mutation that survived was deleting `disabled={!chatInputHasText}`.
    // The button keeps its dimmed look either way, because `opacity` and
    // `cursor` are separate expressions on the same element, so what ships
    // without this attribute is a control that LOOKS unavailable and is not:
    // every tap posts an empty message. This dispatches the click rather than
    // reading the attribute, so the assertion is about what happens.
    const p = chatProps({ chatInputHasText: false });
    render(React.createElement(ChatDetail, p));

    const send = screen.getByLabelText('Send message');
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(p.sendChatMessage).not.toHaveBeenCalled();
  });

  test('a composer with text fires it exactly once', () => {
    // The other half, and the one that keeps a permanently disabled button
    // from passing the test above. Without this, `disabled` hard-coded to true
    // would be green and nobody in the app could send a message.
    const p = chatProps({ chatInputHasText: true });
    render(React.createElement(ChatDetail, p));

    const send = screen.getByLabelText('Send message');
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(p.sendChatMessage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The invite sheet, first half: what the screen renders.
// ---------------------------------------------------------------------------
describe('the invite sheet offers no send until somebody is picked', () => {
  const openSheet = (over) => chatProps({ showFlockInviteModal: true, ...over });

  test('nothing selected, no send button on screen', () => {
    render(React.createElement(ChatDetail, openSheet({ flockInviteSelected: [] })));
    expect(screen.queryByRole('button', { name: /^Invite \d+ Friend/ })).toBeNull();
  });

  test('one selected, the button appears and says how many', () => {
    const p = openSheet({ flockInviteSelected: [{ id: 3, name: 'Sam' }] });
    render(React.createElement(ChatDetail, p));

    const btn = screen.getByRole('button', { name: 'Invite 1 Friend' });
    fireEvent.click(btn);
    expect(p.handleSendFlockInvites).toHaveBeenCalledTimes(1);
  });

  test('the count on the button is the count that was picked, pluralised', () => {
    // It used to be the only number the user saw, and it is still the number
    // they read before tapping. Two selected reading "Invite 1 Friend" is the
    // same class of lie as the "Invited 5 friends" toast that App.js was fixed
    // for.
    render(React.createElement(ChatDetail, openSheet({
      flockInviteSelected: [
        { id: 3, name: 'Sam Diaz' }, { id: 4, name: 'Ali Khan' }, { id: 5, name: 'Jo Reed' },
      ],
    })));
    expect(screen.getByRole('button', { name: 'Invite 3 Friends' })).toBeTruthy();
  });

  test('a send already in flight cannot be sent again', () => {
    const p = openSheet({
      flockInviteSelected: [{ id: 3, name: 'Sam' }],
      flockInviteSending: true,
    });
    render(React.createElement(ChatDetail, p));

    const btn = screen.getByRole('button', { name: 'Sending...' });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(p.handleSendFlockInvites).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The invite sheet, second half: what App.js does when the button is pressed.
//
// `handleSendFlockInvites` is a useCallback inside FlockAppInner. It is not
// reachable from the screen and not liftable as a declaration, so its BODY is
// cut out of App.js and run as a function of its free variables. The two
// anchors below (the opening line and the exact dependency array) are what
// makes that safe: either one moving throws here rather than silently testing
// an older copy of the code.
// ---------------------------------------------------------------------------
const inviteHandlerBody = (() => {
  const OPEN = 'const handleSendFlockInvites = useCallback(async () => {';
  const CLOSE = '}, [flockInviteSelected, selectedFlockId, showToast]);';
  const start = APP_SOURCE.indexOf(OPEN);
  if (start === -1) throw new Error('handleSendFlockInvites: opening line moved');
  const end = APP_SOURCE.indexOf(CLOSE, start);
  if (end === -1) throw new Error('handleSendFlockInvites: dependency array changed');
  return APP_SOURCE.slice(start + OPEN.length, end);
})();

function runInviteHandler(scope) {
  const names = [
    'flockInviteSelected', 'selectedFlockId', 'setFlockInviteSending',
    'inviteToFlock', 'showToast', 'setShowFlockInviteModal',
    'setFlockInviteSelected', 'setFlockInviteSearch',
  ];
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `return (async () => {${inviteHandlerBody}})();`);
  return factory(...names.map((n) => scope[n]));
}

const inviteScope = (over = {}) => ({
  flockInviteSelected: [{ id: 3 }, { id: 4 }],
  selectedFlockId: 1,
  setFlockInviteSending: jest.fn(),
  inviteToFlock: jest.fn().mockResolvedValue({ invited: [3, 4] }),
  showToast: jest.fn(),
  setShowFlockInviteModal: jest.fn(),
  setFlockInviteSelected: jest.fn(),
  setFlockInviteSearch: jest.fn(),
  ...over,
});

describe('handleSendFlockInvites, lifted out of App.js and executed', () => {
  test('the lift found a real function body', () => {
    // Vacuity. An empty or near-empty slice runs clean and asserts nothing.
    expect(inviteHandlerBody).toContain('inviteToFlock(');
    expect(inviteHandlerBody.length).toBeGreaterThan(400);
  });

  test('a full success closes the sheet, clears the picks, and says the number', async () => {
    const s = inviteScope();
    await runInviteHandler(s);

    expect(s.inviteToFlock).toHaveBeenCalledWith(1, [3, 4]);
    expect(s.showToast).toHaveBeenCalledWith('Invited 2 friends.', 'success');
    expect(s.setShowFlockInviteModal).toHaveBeenCalledWith(false);
    expect(s.setFlockInviteSelected).toHaveBeenCalledWith([]);
    expect(s.setFlockInviteSending).toHaveBeenLastCalledWith(false);
  });

  test('nothing selected means nothing is sent', async () => {
    // The guard the mutation audit removed. Without it the sheet POSTs an empty
    // userIds array, and the screen level check above is cosmetic: this handler
    // is also what a keyboard activation and any future caller reach.
    const s = inviteScope({ flockInviteSelected: [] });
    await runInviteHandler(s);

    expect(s.inviteToFlock).not.toHaveBeenCalled();
    // And it does not flip the sheet into a sending state it will never leave.
    expect(s.setFlockInviteSending).not.toHaveBeenCalled();
  });

  test('no flock id means nothing is sent either', async () => {
    const s = inviteScope({ selectedFlockId: null });
    await runInviteHandler(s);
    expect(s.inviteToFlock).not.toHaveBeenCalled();
  });

  test('a failure is shown, not swallowed, and the button comes back', async () => {
    // This one survived the audit. A swallowed rejection leaves the sheet open
    // with the picks still highlighted and no message: the user taps again, and
    // again, and every tap is another POST.
    const s = inviteScope({
      inviteToFlock: jest.fn().mockRejectedValue(new Error('Network request failed')),
    });
    await runInviteHandler(s);

    expect(s.showToast).toHaveBeenCalledWith('Network request failed', 'error');
    // The sheet stays open on failure, so the picks are not lost.
    expect(s.setShowFlockInviteModal).not.toHaveBeenCalled();
    expect(s.setFlockInviteSelected).not.toHaveBeenCalled();
    // And the spinner is cleared, or the button is dead until a remount.
    expect(s.setFlockInviteSending).toHaveBeenLastCalledWith(false);
  });

  test('a failure with no message still says something', async () => {
    const s = inviteScope({ inviteToFlock: jest.fn().mockRejectedValue({}) });
    await runInviteHandler(s);
    expect(s.showToast).toHaveBeenCalledWith('Failed to send invites', 'error');
  });

  test('a partial success reports what actually went out, not what was picked', async () => {
    // The server answers 200 with a shorter `invited` list when the flock is
    // full or the inviter is throttled. Reading the local selection length here
    // is what used to make it say "Invited 5 friends" after sending two.
    const s = inviteScope({
      flockInviteSelected: [{ id: 3 }, { id: 4 }, { id: 5 }],
      inviteToFlock: jest.fn().mockResolvedValue({ invited: [3], full: true }),
    });
    await runInviteHandler(s);

    const [note, tone] = s.showToast.mock.calls[0];
    expect(note).toContain('Invited 1 of 3.');
    expect(tone).toBe('warning');
  });
});
