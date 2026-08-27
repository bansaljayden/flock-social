// ---------------------------------------------------------------------------
// THE CHAT SCREEN'S COMPOSER, ITS EXITS AND ITS INVITE SHEET, RENDERED AND
// EXECUTED.
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
// flock chat screen left `App.js` on 2026-08-26 as a function of 146 props,
// and it mounts on its own with a hand-built props object and no App.js
// anywhere near it. So the two button facts above become things this file
// watches happen rather than things it reads about in the source. A click on
// the disabled send button is dispatched here for real, and the assertion is
// that `sendChatMessage` was not called.
//
// It arrived with no hooks at all and has two now, both added on 2026-08-26
// with the three fixes below. That changes nothing about this harness: it is
// mounted as a component, not called as a function, so hooks run normally.
//
// WHAT THE BROWSER SUITE FOUND, AND WHAT IS PINNED HERE BECAUSE OF IT.
// tools/e2e/chat.spec.js drove the real screen in a real browser and proved
// three defects. Playwright is not run in CI, so each one is pinned here too:
//
//   1. A half-written flock message followed the user into a private DM.
//      Every exit but the back arrow left `chatInputRef` and
//      `chatInputHasText` loaded, and the DM composer reads both.
//   2. Send was armed for a message of only whitespace, and the tap died in
//      silence: `!!value` armed it, `.trim()` refused to send it.
//   3. The header said "online" beside a green dot as a hardcoded literal,
//      with the socket dead, on the screen where somebody would look to find
//      out why nothing was arriving.
//
// Back to the three rows at the top of this comment. The last of them, the
// swallowed invite failure, is genuinely in `App.js`: `handleSendFlockInvites` is a
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
const { act, render, screen, fireEvent, waitFor } = require('@testing-library/react');
// Not direct dependencies of frontend/. They arrive with react-scripts, which
// is, and which cannot run without them, and `extractionEquivalence.test.js`
// already reads them the same way and says so at length. Required without a
// fallback on purpose: if an install ever moves them this suite goes red and
// somebody looks, rather than quietly scanning nothing.
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

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
// getSocket is what the header's connection dot reads. It is a jest.fn here so
// each test can decide whether the connection is up, which is the only way to
// tell a dot wired to the socket from a dot wired to nothing.
jest.mock('../services/socket', () => ({
  leaveFlock: jest.fn(),
  getSocket: jest.fn(() => ({ connected: true })),
}));
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
    //
    // The typing is not decoration. The screen now arms this button on an AND
    // of what App.js says (the box was not cleared) and what its own change
    // event saw (the box holds more than whitespace), so a message has to be
    // typed for real rather than declared in a prop.
    const p = chatProps({ chatInputHasText: true });
    render(React.createElement(ChatDetail, p));

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'on my way' } });

    const send = screen.getByLabelText('Send message');
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(p.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  test('a boxful of spaces is not a message, and the button says so', () => {
    // THE DEFECT, proved from the screen by tools/e2e/chat.spec.js ("the Send
    // button is never offered for a message with nothing in it").
    //
    // App.js computes chatInputHasText as `!!e.target.value` and sendChatMessage
    // guards on `currentInput.trim()`. Those two disagree about exactly one
    // input: a box holding only whitespace. The button lit up, took the tap,
    // and the guard dropped it without a word or a toast. A control that looks
    // available, accepts the press and does nothing is the dead control
    // SLOP-AUDIT rule C1 bans, and this is the most-pressed control in the
    // product.
    //
    // chatInputHasText is passed TRUE here on purpose. That is what App.js
    // really reports for a string of spaces, so a screen that trusts it alone
    // fails this test, which is the point.
    const p = chatProps({ chatInputHasText: true });
    render(React.createElement(ChatDetail, p));
    const send = screen.getByLabelText('Send message');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '     ' } });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(p.sendChatMessage).not.toHaveBeenCalled();

    // Tabs and newlines are whitespace too, and a paste is the way they arrive.
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '\t\n  \t' } });
    expect(send.disabled).toBe(true);
  });

  test('it disarms again when the text is rubbed out down to spaces', () => {
    // The state has to track the box, not just its first keystroke. Typing a
    // real message and then deleting it back to a space leaves App.js still
    // saying "has text", so this is the same defect arrived at from the other
    // side.
    const p = chatProps({ chatInputHasText: true });
    render(React.createElement(ChatDetail, p));
    const input = screen.getByLabelText('Message');
    const send = screen.getByLabelText('Send message');

    fireEvent.change(input, { target: { value: 'see you there' } });
    expect(send.disabled).toBe(false);
    fireEvent.change(input, { target: { value: ' ' } });
    expect(send.disabled).toBe(true);
  });

  test('a clear from App.js disarms it, whatever this screen last saw typed', () => {
    // The other half of the AND, and the only test that fails if the screen
    // stops reading chatInputHasText at all. Sending a message, sending a photo
    // with a caption and every exit on this screen clear the composer through
    // App.js, and none of those is a change event this screen can see. Without
    // chatInputHasText in the condition, the button stays lit over a box that
    // was emptied out from under it.
    const p = chatProps({ chatInputHasText: true });
    const { rerender } = render(React.createElement(ChatDetail, p));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'sent already' } });
    expect(screen.getByLabelText('Send message').disabled).toBe(false);

    rerender(React.createElement(ChatDetail, { ...p, chatInputHasText: false }));
    expect(screen.getByLabelText('Send message').disabled).toBe(true);
  });

  test('the Enter key agrees with the button about what is sendable', () => {
    // Enter is the send path on a laptop and the second one on a phone
    // keyboard. It read nothing at all before, so it walked straight into
    // sendChatMessage's silent trim guard on a boxful of spaces.
    const p = chatProps({ chatInputHasText: true });
    render(React.createElement(ChatDetail, p));
    const input = screen.getByLabelText('Message');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sendChatMessage).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'here now' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  test('every keystroke still reaches App.js', () => {
    // The screen wraps handleChatInputChange to measure the trimmed length.
    // A wrapper that forgets to call through kills the typing indicator, the
    // send guard and the draft ref in one go, and every assertion above would
    // still pass.
    const p = chatProps({ chatInputHasText: true });
    render(React.createElement(ChatDetail, p));

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'ty' } });
    expect(p.handleChatInputChange).toHaveBeenCalledTimes(1);
    expect(p.handleChatInputChange.mock.calls[0][0].target.value).toBe('ty');
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
// The Share a Venue sheet is never a blank dead end (ledger B3).
//
// When venue search is down, budgetFilteredVenues comes back empty. The sheet
// used to render its "Or select a different venue" heading over nothing, which
// is the blank panel tools/e2e/venue.spec.js forbids: a sheet that says "pick
// one below" and then lists nothing, with no reason and no exit. The empty
// state now says why and carries a real way out.
// ---------------------------------------------------------------------------
describe('the Share a Venue sheet when nothing loaded', () => {
  const openShare = (over) => chatProps({ showVenueShareModal: true, ...over });

  test('an empty venue list says why, instead of a blank panel', () => {
    render(React.createElement(ChatDetail, openShare({ budgetFilteredVenues: [] })));
    // The sentence a person can read and act on, not silence.
    expect(screen.getByText(/no venues to show here/i)).toBeTruthy();
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });

  test('the empty state offers a way out beyond the corner close', () => {
    // venue.spec.js accepts the sheet only if it offers more than one control OR
    // explains itself. The empty state does both: the sentence above and a
    // second, labelled exit here.
    render(React.createElement(ChatDetail, openShare({ budgetFilteredVenues: [] })));
    const sheet = screen.getByText(/share a venue/i).closest('.modal-content');
    const buttons = sheet.querySelectorAll('button');
    // The corner X plus the empty-state Close: more than one control.
    expect(buttons.length).toBeGreaterThan(1);
  });

  test('a non-empty list renders the venues and drops the empty sentence', () => {
    // The counter-example: a permanently-shown empty state would pass the test
    // above and hide every real venue. This is what keeps the branch honest.
    render(React.createElement(ChatDetail, openShare({
      budgetFilteredVenues: [{ id: 1, name: 'The Basement', type: 'Bar' }],
    })));
    expect(screen.getByText('The Basement')).toBeTruthy();
    expect(screen.queryByText(/no venues to show here/i)).toBeNull();
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

// ---------------------------------------------------------------------------
// THE DRAFT LEAK.
//
// The worst thing tools/e2e/chat.spec.js found ("a half-written flock message
// cannot follow you into a private thread"). The composer is an uncontrolled
// input whose text lives in `chatInputRef` in App.js, and `chatInputHasText`
// is the boolean that arms BOTH send buttons in the product, this screen's and
// the one-to-one DM thread's. Only the back arrow ever cleared them. Ada wrote
// a sentence to a flock, tapped "Add a Venue" because that is what the screen
// itself offers, opened a DM with one member, and the send button there was
// armed over a box that looked empty.
//
// Two halves, and both are needed. The clicks below prove that the exits a
// person actually presses clear the composer. The AST walk under them proves
// no OTHER exit escaped, including one added next year, which is the half a
// list of hand-written clicks can never cover.
// ---------------------------------------------------------------------------
const FLOCK_WITH_VENUE = { ...FLOCK, venue: 'Kome', venueId: 'p1', venueAddress: '1 Main St' };

/* The real VenueCard is App.js's and arrives as a prop. All this test needs of
   it is the one control on it that leaves the screen. */
const VenueCardStub = ({ onViewDetails }) =>
  React.createElement('button', { onClick: onViewDetails }, 'View details');

describe('leaving the flock chat leaves the half-written message behind', () => {
  const clicked = (label, over) => {
    const p = chatProps(over);
    render(React.createElement(ChatDetail, p));
    fireEvent.click(screen.getByRole('button', { name: label }));
    return p;
  };

  test('the back arrow, which is the one exit that always did', () => {
    const p = clicked('Back');
    expect(p.setChatInput).toHaveBeenCalledWith('');
    expect(p.setCurrentScreen).toHaveBeenCalledWith('main');
  });

  test('"Add a Venue", the exit the browser suite walked out through', () => {
    const p = clicked(/Add a Venue/);
    expect(p.setChatInput).toHaveBeenCalledWith('');
    // And it still does the thing it exists to do.
    expect(p.setPickingVenueForFlockId).toHaveBeenCalledWith(1);
    expect(p.setCurrentTab).toHaveBeenCalledWith('explore');
  });

  test('"Change", the same picker from a flock that already has a venue', () => {
    const p = clicked('Change', { getSelectedFlock: () => FLOCK_WITH_VENUE });
    expect(p.setChatInput).toHaveBeenCalledWith('');
    expect(p.setPickingVenueForCreate).toHaveBeenCalledWith(true);
  });

  test('"Map" on the pinned venue banner', () => {
    const p = clicked('Map', { getSelectedFlock: () => FLOCK_WITH_VENUE });
    expect(p.setChatInput).toHaveBeenCalledWith('');
    expect(p.setVenueDetailReturnTo).toHaveBeenCalled();
  });

  test('"View details" on a venue card somebody shared into the thread', () => {
    const p = clicked('View details', {
      VenueCard: VenueCardStub,
      getSelectedFlock: () => ({
        ...FLOCK,
        messages: [{
          id: 'm1', sender: 'Bo', time: '9:04 PM',
          message_type: 'venue_card',
          venue_data: { place_id: 'p1', name: 'Kome' },
        }],
      }),
    });
    expect(p.setChatInput).toHaveBeenCalledWith('');
    expect(p.setCurrentScreen).toHaveBeenCalledWith('main');
  });

  test('"Leave", which drops the flock the draft was written for', async () => {
    const p = clicked('Leave', { showLeaveConfirm: true });
    await waitFor(() => expect(p.setChatInput).toHaveBeenCalledWith(''));
    expect(p.setCurrentTab).toHaveBeenCalledWith('home');
  });

  // `replyingTo` is the other piece of shared state that used to survive an
  // exit: come back and the composer is quoting a message from a thread you
  // are no longer looking at, with nothing on screen saying so. One render per
  // test, because two renders in one test put two of every button in the same
  // container and getByRole then refuses on ambiguity rather than on the fact
  // under test.
  test('the reply target goes with it, out of the back arrow', () => {
    expect(clicked('Back').setReplyingTo).toHaveBeenCalledWith(null);
  });

  test('the reply target goes with it, out of a venue control too', () => {
    const p = clicked('Change', { getSelectedFlock: () => FLOCK_WITH_VENUE });
    expect(p.setReplyingTo).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// The other half: nothing navigates away without going through that one
// function. Read off the parsed screen, so a comment that says
// `setCurrentScreen` is a comment and a call is a call.
// ---------------------------------------------------------------------------
const SCREEN_AST = parser.parse(SCREEN_SOURCE, {
  sourceType: 'module',
  plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'],
});

/* The two calls that take a person off this screen. Anything that changes the
   screen or the tab is an exit, whatever the control looks like. */
const NAVIGATION_CALLS = new Set(['setCurrentScreen', 'setCurrentTab']);
const CLEAR_CALL = 'leaveChatScreen';

const { navigatingFunctions, clearingFunctions } = (() => {
  const navigating = new Map(); // function node -> { line, calls: [] }
  const clearing = new Set();   // function nodes that call leaveChatScreen
  traverse(SCREEN_AST, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== 'Identifier') return;
      const fn = p.getFunctionParent();
      if (!fn) return;
      if (NAVIGATION_CALLS.has(callee.name)) {
        const rec = navigating.get(fn.node) || { line: p.node.loc.start.line, calls: [] };
        rec.calls.push(callee.name);
        navigating.set(fn.node, rec);
      } else if (callee.name === CLEAR_CALL) {
        clearing.add(fn.node);
      }
    },
  });
  return { navigatingFunctions: navigating, clearingFunctions: clearing };
})();

/* The body of the one function every exit is required to call. */
const clearCallsMade = (() => {
  let found = null;
  traverse(SCREEN_AST, {
    VariableDeclarator(p) {
      if (p.node.id.type !== 'Identifier' || p.node.id.name !== CLEAR_CALL) return;
      const calls = [];
      p.traverse({
        CallExpression(c) {
          if (c.node.callee.type === 'Identifier') {
            calls.push({ name: c.node.callee.name, args: c.node.arguments });
          }
        },
      });
      found = calls;
    },
  });
  if (!found) throw new Error(CLEAR_CALL + ' is gone from ChatDetail.js, and it is what every exit calls');
  return found;
})();

describe('no exit from the flock chat can skip the clear', () => {
  test('the walk found the exits it is meant to be checking', () => {
    // Vacuity, and the reason this is an AST walk rather than a regex: a scan
    // that matches nothing passes every assertion under it in silence. Six
    // distinct handlers navigate away as of 2026-08-26 (back, Add a Venue,
    // Change, Map, View details, Leave) and they make eleven calls between
    // them. Losing an exit later is fine. Losing the ability to see them is not.
    expect(navigatingFunctions.size).toBeGreaterThanOrEqual(6);
    const totalCalls = [...navigatingFunctions.values()].reduce((n, r) => n + r.calls.length, 0);
    expect(totalCalls).toBeGreaterThanOrEqual(10);
    expect(clearingFunctions.size).toBeGreaterThanOrEqual(6);
  });

  test('every handler that navigates also clears', () => {
    const leaking = [...navigatingFunctions.entries()]
      .filter(([fnNode]) => !clearingFunctions.has(fnNode))
      .map(([, rec]) => 'ChatDetail.js:' + rec.line + ' calls ' + rec.calls.join(' and ') + ' without ' + CLEAR_CALL + '()');
    expect(leaking).toEqual([]);
  });

  test('and the thing they all call really does clear the shared state', () => {
    const setInput = clearCallsMade.find((c) => c.name === 'setChatInput');
    expect(setInput).toBeTruthy();
    expect(setInput.args).toHaveLength(1);
    expect(setInput.args[0].type).toBe('StringLiteral');
    // Anything but the empty string leaves chatInputHasText armed, which is
    // the half of the defect that reaches the DM composer.
    expect(setInput.args[0].value).toBe('');
    expect(clearCallsMade.map((c) => c.name)).toEqual(
      expect.arrayContaining(['setChatInput', 'setReplyingTo', 'setChatSearch']),
    );
  });
});

// ---------------------------------------------------------------------------
// THE CONNECTION DOT.
//
// It was the string 'online' beside a hardcoded green dot, wired to nothing at
// all. It said online with the socket dead, on the one screen somebody opens
// to work out why nothing is arriving, which is the "claims a state it never
// measured" failure SLOP-AUDIT H13 is about, applied to connectivity rather
// than to a number.
// ---------------------------------------------------------------------------
describe('the header says whether the connection is actually up', () => {
  const socketModule = require('../services/socket');
  const setConnection = (connected) => socketModule.getSocket.mockImplementation(() => ({ connected }));

  beforeEach(() => setConnection(true));
  afterEach(() => {
    jest.useRealTimers();
    setConnection(true);
  });

  test('a live socket reads online', () => {
    render(React.createElement(ChatDetail, chatProps()));
    expect(screen.getByText('online')).toBeTruthy();
    expect(screen.queryByText('reconnecting...')).toBeNull();
  });

  test('a dead socket with the network up reads reconnecting, because that is what socket.io is doing', () => {
    setConnection(false);
    render(React.createElement(ChatDetail, chatProps()));
    expect(screen.queryByText('online')).toBeNull();
    expect(screen.getByText('reconnecting...')).toBeTruthy();
    expect(screen.queryByText('offline')).toBeNull();
  });

  test('with the device itself offline the header says offline, not reconnecting', () => {
    // Jayden's rule: "reconnecting" only while something really is trying.
    // With navigator.onLine false the device knows no retry can succeed, and
    // printing "reconnecting" over airplane mode is the hardcoded "online"
    // lie again, wearing amber.
    setConnection(false);
    const spy = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      render(React.createElement(ChatDetail, chatProps()));
      expect(screen.getByText('offline')).toBeTruthy();
      expect(screen.queryByText('reconnecting...')).toBeNull();
      expect(screen.queryByText('online')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('no socket at all is not online either', () => {
    // getSocket() answers null before the first connect and after a sign-out
    // teardown. Reading `.connected` off that must not throw the screen away.
    socketModule.getSocket.mockImplementation(() => null);
    render(React.createElement(ChatDetail, chatProps()));
    expect(screen.queryByText('online')).toBeNull();
  });

  test('it keeps reading, so a drop while the chat is open shows up', () => {
    // The mutation this kills is the one that leaves the read in place and
    // takes the sampling out. A dot that is right once at mount and frozen
    // afterwards is the same lie with a longer fuse: the connection goes down
    // mid-conversation, which is exactly when somebody looks at it.
    jest.useFakeTimers();
    render(React.createElement(ChatDetail, chatProps()));
    expect(screen.getByText('online')).toBeTruthy();

    setConnection(false);
    act(() => { jest.advanceTimersByTime(2100); });
    expect(screen.queryByText('online')).toBeNull();

    // And back again when it recovers, or the header is a one-way trapdoor.
    setConnection(true);
    act(() => { jest.advanceTimersByTime(2100); });
    expect(screen.getByText('online')).toBeTruthy();
  });

  test('somebody typing still wins the line', () => {
    // The typing indicator shares this slot. It was there before the dot was
    // wired and it has to stay in front of it.
    render(React.createElement(ChatDetail, chatProps({ isTyping: true, typingUser: 'Bo' })));
    expect(screen.getByText('Bo is typing...')).toBeTruthy();
    expect(screen.queryByText('online')).toBeNull();
  });
});
