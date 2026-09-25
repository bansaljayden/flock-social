// ---------------------------------------------------------------------------
// THE HOST'S TWO WAYS TO UNDO A PLAN'S REACH: CANCEL IT, OR KILL ITS LINK.
//
// Both were built on the server and reachable from no screen.
//
//   CANCEL. PUT /api/flocks/:id has always taken status 'cancelled' from the
//   creator (403 for any other member, 409 once a plan has ended), fanned
//   flock_updated out to every member and pushed "Plan cancelled" to the ones
//   not in the app. Nothing sent it. A host's only way out was Leave, which
//   deletes the plan for everyone, chat and all, and the completion sweep only
//   cancels a plan nobody locked in once its night is already over.
//
//   A NEW LINK. POST /api/flocks/:id/invite-link with { regenerate: true }
//   revokes every live guest link on the flock and mints one, creator only.
//   Every caller asked without it, so Share handed back the same link every
//   time, and that link is real membership: posted in the wrong group chat it
//   stayed a way in until it expired.
//
// What is pinned, each one a thing an edit can quietly undo:
//
//   1. WHO SEES EACH CONTROL. The creator of a live plan, and nobody else:
//      not a member, not the creator once the plan has ended. The server
//      refuses everyone else either way; offering them a control that exists
//      only to be refused is the dead button DESIGN-STANDARD C1 bans.
//   2. THE CONFIRM COMES FIRST, AND SAYS ONLY WHAT IS TRUE. The first tap asks;
//      nothing goes out until the second. The cancel says everyone is told,
//      the chat stays and the plan cannot be reopened; the link says the old
//      one dies at once and people already in stay in. Each clause is the
//      route's own behaviour.
//   3. THE RIGHT CALL WITH THE RIGHT ARGUMENTS. cancelFlockPlan with the
//      flock's id; createFlockInviteLink(id, true), and the ordinary Share
//      still asks without regenerate.
//   4. THE APP SAYS WHAT HAPPENED. App.js's cancelFlockPlan (lifted out and
//      executed) writes the host's own copy only once the server agreed; the
//      flock_updated listener (lifted too) tells every other member who called
//      it off, and stays quiet for the sweep, which is nobody.
//   5. AN ENDED PLAN STOPS OFFERING WHAT THE SERVER REFUSES. The vote strip,
//      the poll card's ballot and lock, the venue card's Vote, and the plus
//      sheet's vote and invite tiles, all refused once a plan has ended; and
//      the host's Change place, which the server allows but the plan screen
//      already hides then. The chat itself stays open.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test hostPlanControls --watchAll=false
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const React = require('react');
const { act, render, screen, fireEvent, waitFor, within } = require('@testing-library/react');

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

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const SCREEN = read('screens', 'ChatDetail.js');
const APP = read('App.js');

const HOST = 9;
const MEMBER = 2;

/**
 * A full props object for the screen, the same shape the other ChatDetail
 * harnesses use, with the flock overridable. The test right after it proves
 * the list is still complete, so a prop added to the screen and forgotten here
 * cannot arrive as undefined and quietly take the falsy branch.
 */
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
    // Counts voters, so a vote row has a leader and the host's Lock shows.
    voteTotal: (v) => ((v && v.voters ? v.voters.length : 0) + ((v && v.guestCount) || 0)),
    MissingFlockPanel: () => null,
    addReactionToMessage: fn(),
    allVenues: [],
    authUser: { id: HOST, name: 'Jay' },
    billPaidBy: null,
    // App.js's own starting value. An empty array is truthy and would put a
    // bill card in the stream, which hides the empty chat these tests read.
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

const mount = (over) => {
  const p = chatProps(over);
  const view = render(React.createElement(ChatDetail, p));
  return { p, ...view };
};

// The heading is the handle on each dialog: the harness's DialogBehavior is a
// stub, so the role="dialog" App.js's real one would add is not there.
const dialogTitled = (title) => screen.getByText(title).closest('.modal-content');

beforeEach(() => {
  api.createFlockInviteLink.mockReset();
});

describe('the harness is handed the same screen App.js hands it', () => {
  test('every prop the screen destructures has a value here', () => {
    const params = SCREEN
      .slice(SCREEN.indexOf('export default function ChatDetail({'), SCREEN.indexOf('\n}) {'))
      .split('\n')
      .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
      .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
      .map((l) => l.slice(0, -1));
    expect(params.length).toBeGreaterThan(100);
    expect(params).toContain('cancelFlockPlan');
    const supplied = chatProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Cancel plan
// ═══════════════════════════════════════════════════════════════════════════

describe('Cancel plan, in the overflow menu beside Leave', () => {
  test('the host of a live plan is offered it, next to Leave', () => {
    mount({ showFlockMenu: true });
    expect(screen.getByRole('button', { name: 'Cancel plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Leave Flock/ })).toBeInTheDocument();
  });

  test('a locked-in plan can still be called off', () => {
    mount({ showFlockMenu: true, flock: { status: 'confirmed' } });
    expect(screen.getByRole('button', { name: 'Cancel plan' })).toBeInTheDocument();
  });

  test('a member who is not the host is not offered it, and keeps Leave', () => {
    // PUT /api/flocks/:id answers 403 to them. A control that exists only to
    // be refused is not offered.
    mount({ showFlockMenu: true, authUser: { id: MEMBER, name: 'Bo' } });
    expect(screen.queryByRole('button', { name: 'Cancel plan' })).toBeNull();
    expect(screen.getByRole('button', { name: /Leave Flock/ })).toBeInTheDocument();
  });

  test('a plan that has already ended, either way, offers no cancel', () => {
    // The route answers 409 to any status on a completed or cancelled plan.
    for (const status of ['cancelled', 'completed']) {
      const { unmount } = mount({ showFlockMenu: true, flock: { status } });
      expect(screen.queryByRole('button', { name: 'Cancel plan' })).toBeNull();
      unmount();
    }
  });

  test('the first tap closes the menu and asks; nothing is sent yet', () => {
    const { p } = mount({ showFlockMenu: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
    expect(p.setShowFlockMenu).toHaveBeenCalledWith(false);
    expect(dialogTitled('Cancel this plan?')).toBeTruthy();
    expect(p.cancelFlockPlan).not.toHaveBeenCalled();
  });

  test('the confirm says what the route does: everyone told, chat kept, no reopening', () => {
    mount({ showFlockMenu: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
    const text = dialogTitled('Cancel this plan?').textContent;
    expect(text).toContain('Cancelling tells everyone in "Friday" that it\'s off.');
    expect(text).toContain('The chat stays open, but the plan can\'t be reopened.');
    // And nothing it does not do. The flock row is kept, so no word of
    // deleting; DESIGN-STANDARD rule 1, so no em dash.
    expect(text).not.toMatch(/delete/i);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  test('Keep plan backs out and sends nothing', () => {
    const { p } = mount({ showFlockMenu: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
    fireEvent.click(within(dialogTitled('Cancel this plan?')).getByRole('button', { name: 'Keep plan' }));
    expect(screen.queryByText('Cancel this plan?')).toBeNull();
    expect(p.cancelFlockPlan).not.toHaveBeenCalled();
  });

  test('confirming cancels this flock, once, and the dialog closes when the server agreed', async () => {
    const { p } = mount({ showFlockMenu: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
    fireEvent.click(within(dialogTitled('Cancel this plan?')).getByRole('button', { name: 'Cancel plan' }));
    expect(p.cancelFlockPlan).toHaveBeenCalledTimes(1);
    expect(p.cancelFlockPlan).toHaveBeenCalledWith(1);
    await waitFor(() => expect(screen.queryByText('Cancel this plan?')).toBeNull());
  });

  test('a refusal leaves the dialog up, live again, so the host can retry or back out', async () => {
    const cancelFlockPlan = jest.fn(() => Promise.resolve(false));
    mount({ showFlockMenu: true, cancelFlockPlan });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
    fireEvent.click(within(dialogTitled('Cancel this plan?')).getByRole('button', { name: 'Cancel plan' }));
    await waitFor(() => {
      const confirm = within(dialogTitled('Cancel this plan?')).getByRole('button', { name: 'Cancel plan' });
      expect(confirm.disabled).toBe(false);
    });
    expect(screen.getByText('Cancel this plan?')).toBeInTheDocument();
  });

  test('while the request is out both buttons are dead and a second tap sends nothing', async () => {
    let finish;
    const cancelFlockPlan = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    mount({ showFlockMenu: true, cancelFlockPlan });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));
    const dialog = dialogTitled('Cancel this plan?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel plan' }));

    const pending = within(dialog).getByRole('button', { name: 'Cancelling...' });
    expect(pending.disabled).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Keep plan' }).disabled).toBe(true);
    fireEvent.click(pending);
    expect(cancelFlockPlan).toHaveBeenCalledTimes(1);

    await act(async () => { finish(true); });
    expect(screen.queryByText('Cancel this plan?')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A new invite link
// ═══════════════════════════════════════════════════════════════════════════

describe('Make a new link, in the invite sheet', () => {
  const openSheet = (over = {}) => mount({ showFlockInviteModal: true, ...over });

  test('the host of a live plan is offered it, with or without a link on show', () => {
    const { unmount } = openSheet();
    expect(screen.getByRole('button', { name: 'Make a new link' })).toBeInTheDocument();
    unmount();
    openSheet({ copiedInviteUrl: 'https://flockcorp.com/i/old' });
    expect(screen.getByRole('button', { name: 'Make a new link' })).toBeInTheDocument();
  });

  test('a member who is not the host is not offered it, and can still share', () => {
    // The route: "Only the creator can replace this invite link", 403.
    openSheet({ authUser: { id: MEMBER, name: 'Bo' } });
    expect(screen.queryByRole('button', { name: 'Make a new link' })).toBeNull();
    expect(screen.getByRole('button', { name: /Share invite link/ })).toBeInTheDocument();
  });

  test('an ended plan offers no new link', () => {
    // The route answers 409 FLOCK_CLOSED before it ever reaches regenerate.
    for (const status of ['cancelled', 'completed']) {
      const { unmount } = openSheet({ flock: { status } });
      expect(screen.queryByRole('button', { name: 'Make a new link' })).toBeNull();
      unmount();
    }
  });

  test('the first tap asks, and says plainly that the old link stops working', () => {
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    const text = dialogTitled('Make a new link?').textContent;
    expect(text).toContain('The current link stops working right away, for everyone who has it.');
    expect(text).toContain('People who already joined with it stay in the plan.');
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(api.createFlockInviteLink).not.toHaveBeenCalled();
  });

  test('Keep this link backs out and sends nothing', () => {
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Keep this link' }));
    expect(screen.queryByText('Make a new link?')).toBeNull();
    expect(api.createFlockInviteLink).not.toHaveBeenCalled();
  });

  test('confirming asks the route to regenerate, and puts the new link on screen', async () => {
    api.createFlockInviteLink.mockResolvedValue({ token: 'new', url: 'https://flockcorp.com/i/new' });
    const { p } = openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Make a new link' }));

    expect(api.createFlockInviteLink).toHaveBeenCalledTimes(1);
    expect(api.createFlockInviteLink).toHaveBeenCalledWith(1, true);
    await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/new'));
    expect(p.showToast).toHaveBeenCalledWith('New link made. The old one no longer works.');
    expect(screen.queryByText('Make a new link?')).toBeNull();
  });

  test('the panel then says it is a new link, not that anything was copied', async () => {
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/new' });
    const { p, rerender } = openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Make a new link' }));
    await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/new'));

    // What App.js does with that setter: the link is now the one on show.
    rerender(React.createElement(ChatDetail, { ...p, copiedInviteUrl: 'https://flockcorp.com/i/new' }));
    const panel = screen.getByRole('status');
    expect(panel.textContent).toContain('New link made. The old one no longer works.');
    expect(panel.textContent).not.toContain('Copied.');
    expect(panel.textContent).toContain('https://flockcorp.com/i/new');
  });

  test('a link on show because it was shared still says Copied', () => {
    openSheet({ copiedInviteUrl: 'https://flockcorp.com/i/old' });
    expect(screen.getByRole('status').textContent).toContain('Copied. Anyone with this link');
  });

  test('a refusal is said, the dialog stays, and no link is put on screen', async () => {
    api.createFlockInviteLink.mockRejectedValue(new Error('This plan is finished and cannot accept new invites'));
    const { p } = openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Make a new link' }));

    await waitFor(() => expect(p.showToast).toHaveBeenCalledWith('This plan is finished and cannot accept new invites', 'error'));
    expect(p.setCopiedInviteUrl).not.toHaveBeenCalled();
    expect(screen.getByText('Make a new link?')).toBeInTheDocument();
  });

  test('the ordinary Share still asks for the existing link, never a new one', async () => {
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
    await waitFor(() => expect(api.createFlockInviteLink).toHaveBeenCalled());
    expect(api.createFlockInviteLink.mock.calls[0]).toEqual([1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. What App.js does with a cancel: the host's own copy
// ═══════════════════════════════════════════════════════════════════════════

/* Lifted out of App.js as source and executed against stand-ins, the move
   chatComposerAndInviteSheet makes for handleSendFlockInvites. Both anchors
   are exact, so an edit that changes the handler's inputs breaks the lift
   loudly instead of testing a stale copy. */
function lift(open, close) {
  const start = APP.indexOf(open);
  if (start === -1) throw new Error(`lift: "${open}" moved`);
  const end = APP.indexOf(close, start);
  if (end === -1) throw new Error(`lift: the close after "${open}" moved`);
  return APP.slice(start + open.length, end);
}

const CANCEL_BODY = lift('const cancelFlockPlan = useCallback((flockId) => (', '\n  ), [showToast]);');

function runCancel(scope, flockId) {
  // eslint-disable-next-line no-new-func
  const factory = new Function('setFlockStatus', 'setFlocks', 'showToast', 'flockId', `return (${CANCEL_BODY});`);
  return factory(scope.setFlockStatus, scope.setFlocks, scope.showToast, flockId);
}

const cancelScope = (over = {}) => ({
  setFlockStatus: jest.fn().mockResolvedValue({ flock: { id: 7, status: 'cancelled' } }),
  setFlocks: jest.fn(),
  showToast: jest.fn(),
  ...over,
});

describe('cancelFlockPlan, lifted out of App.js and executed', () => {
  test('the lift found the real handler', () => {
    expect(CANCEL_BODY).toContain("setFlockStatus(flockId, 'cancelled')");
    expect(CANCEL_BODY.length).toBeGreaterThan(200);
  });

  test('it sends the cancel for that flock, then marks only that flock called off', async () => {
    const s = cancelScope();
    await expect(runCancel(s, 7)).resolves.toBe(true);
    expect(s.setFlockStatus).toHaveBeenCalledWith(7, 'cancelled');

    const update = s.setFlocks.mock.calls[0][0];
    const before = [
      { id: 7, status: 'confirmed', reconfirm: { open: true, count: 2, total: 4 } },
      { id: 8, status: 'voting', reconfirm: null },
    ];
    const after = update(before);
    expect(after[0]).toEqual({ id: 7, status: 'cancelled', reconfirm: null });
    expect(after[1]).toBe(before[1]);
    expect(s.showToast).toHaveBeenCalledWith('Plan cancelled. Everyone in the flock has been told.');
  });

  test('nothing is painted before the server answers', async () => {
    let answer;
    const s = cancelScope({ setFlockStatus: jest.fn(() => new Promise((resolve) => { answer = resolve; })) });
    const done = runCancel(s, 7);
    expect(s.setFlocks).not.toHaveBeenCalled();
    answer({ flock: { status: 'cancelled' } });
    await done;
    expect(s.setFlocks).toHaveBeenCalledTimes(1);
  });

  test('a refusal changes nothing, says why, and resolves false', async () => {
    const s = cancelScope({
      setFlockStatus: jest.fn().mockRejectedValue(new Error('This plan is finished and cannot be reopened')),
    });
    await expect(runCancel(s, 7)).resolves.toBe(false);
    expect(s.setFlocks).not.toHaveBeenCalled();
    expect(s.showToast).toHaveBeenCalledWith('This plan is finished and cannot be reopened', 'error');
  });

  test('a dead session, which api.js has already announced, is not announced twice', async () => {
    const s = cancelScope({ setFlockStatus: jest.fn().mockRejectedValue({ sessionExpired: true }) });
    await expect(runCancel(s, 7)).resolves.toBe(false);
    expect(s.showToast).not.toHaveBeenCalled();
  });

  test('App.js hands it to the chat screen', () => {
    const props = APP.slice(APP.indexOf('const chatDetailProps = {'), APP.indexOf('<ChatDetail {...chatDetailProps} />'));
    expect(props).toMatch(/\n\s+cancelFlockPlan,\n/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. What every other member's app does with it
// ═══════════════════════════════════════════════════════════════════════════

const LISTENER_BODY = lift(
  'const unsub = onFlockUpdated((data) => {',
  '\n    });\n    return unsub;\n  }, [showToast]);'
);

function runListener(data, flocks, over = {}) {
  const scope = {
    flocksRef: { current: flocks },
    showToast: jest.fn(),
    formatEventTime: jest.fn(() => 'Fri 10:00 PM'),
    setFlocks: jest.fn(),
    resolveVenuePhoto: () => null,
    setPendingFlockInvites: jest.fn(),
    ...over,
  };
  const names = ['flocksRef', 'showToast', 'formatEventTime', 'setFlocks', 'resolveVenuePhoto', 'setPendingFlockInvites', 'data'];
  // eslint-disable-next-line no-new-func
  const listener = new Function(...names, LISTENER_BODY);
  listener(...names.map((n) => (n === 'data' ? data : scope[n])));
  return scope;
}

const LIVE = { id: 1, name: 'Friday', status: 'voting', eventTime: '2026-09-26T21:00:00', reconfirm: null };

describe('the flock_updated listener, lifted out of App.js and executed', () => {
  test('the lift found the real listener', () => {
    expect(LISTENER_BODY).toContain('setPendingFlockInvites(');
    expect(LISTENER_BODY.length).toBeGreaterThan(1000);
  });

  test('a host calling the plan off is said to every other member, by name', () => {
    // The payload the route sends: every update carries the time, so the time
    // branch must not get to describe a cancel as a move.
    const s = runListener({
      flockId: 1, name: 'Friday', status: 'cancelled', event_time: '2026-09-26T21:00:00',
      updatedBy: 'Jay', reconfirm_reset: true,
    }, [LIVE]);
    expect(s.showToast).toHaveBeenCalledTimes(1);
    expect(s.showToast).toHaveBeenCalledWith('Friday was cancelled by Jay.');
    const after = s.setFlocks.mock.calls[0][0]([LIVE]);
    expect(after[0].status).toBe('cancelled');
  });

  test('the sweep closing a night nobody locked in is not called a cancellation by anyone', () => {
    // flockSweep sends { flockId, status } and nothing else.
    const s = runListener({ flockId: 1, status: 'cancelled' }, [LIVE]);
    expect(s.showToast).not.toHaveBeenCalled();
    expect(s.setFlocks.mock.calls[0][0]([LIVE])[0].status).toBe('cancelled');
  });

  test('a plan already cancelled is not announced twice', () => {
    const s = runListener({ flockId: 1, status: 'cancelled', updatedBy: 'Jay' }, [{ ...LIVE, status: 'cancelled' }]);
    expect(s.showToast).not.toHaveBeenCalled();
  });

  test('a moved plan still says it moved', () => {
    const s = runListener({ flockId: 1, name: 'Friday', status: 'planning', event_time: '2026-09-26T22:00:00', updatedBy: 'Jay' }, [LIVE]);
    expect(s.showToast).toHaveBeenCalledWith('Friday moved to Fri 10:00 PM.');
  });

  test('an invite card for the plan leaves when it is called off', () => {
    const s = runListener({ flockId: 1, status: 'cancelled', updatedBy: 'Jay' }, []);
    const cards = s.setPendingFlockInvites.mock.calls[0][0]([{ id: 1, status: 'voting' }, { id: 2, status: 'voting' }]);
    expect(cards.map((c) => c.id)).toEqual([2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. An ended plan in the chat
// ═══════════════════════════════════════════════════════════════════════════

describe('an ended plan stops offering what the server refuses', () => {
  const votes = [{ venue: 'Kome', place_id: 'p1', voters: ['Bo'] }];

  test('the vote strip goes: "Vote open" on a closed plan is a ballot nobody takes', () => {
    const { container, unmount } = mount({ flock: { votes } });
    expect(container.querySelector('[data-chat-strip="vote"]')).not.toBeNull();
    unmount();
    const ended = mount({ flock: { votes, status: 'cancelled' } });
    expect(ended.container.querySelector('[data-chat-strip="vote"]')).toBeNull();
  });

  test('the poll card keeps the tally and loses the ballot, the lock and the panel', () => {
    const { p, container, rerender } = mount({ flock: { votes } });
    expect(screen.getByRole('button', { name: 'Lock it in' })).toBeInTheDocument();
    expect(container.querySelector('[data-card="poll"] [role="button"][aria-pressed]')).not.toBeNull();
    expect(screen.getByLabelText('Open the venue vote')).toBeInTheDocument();

    // The plan is called off while the card is on screen: the same flock with
    // a new status, which is what App.js hands down after the cancel.
    const ended = { ...p.getSelectedFlock(), status: 'cancelled' };
    rerender(React.createElement(ChatDetail, { ...p, getSelectedFlock: () => ended }));
    expect(container.querySelector('[data-card="poll"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock it in' })).toBeNull();
    expect(container.querySelector('[data-card="poll"] [role="button"][aria-pressed]')).toBeNull();
    expect(screen.queryByLabelText('Open the venue vote')).toBeNull();
  });

  test('a shared venue card loses its Vote when the plan ends under it', () => {
    const card = {
      id: 103, sender: 'Bo', senderId: MEMBER, text: '', sentAt: '2026-09-25T20:00:00',
      message_type: 'venue_card', venue_data: { name: 'Kome', place_id: 'p1' }, reactions: [],
    };
    const { p, rerender } = mount({ flock: { messages: [card] } });
    expect(screen.getByRole('button', { name: 'Vote' })).toBeInTheDocument();
    const ended = { ...p.getSelectedFlock(), status: 'cancelled' };
    rerender(React.createElement(ChatDetail, { ...p, getSelectedFlock: () => ended }));
    expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull();
  });

  test('the host loses Change place on the venue strip, as on the plan screen', () => {
    // The strip itself stays, since it is where the night was; only the edit
    // goes, because a new venue on a called-off plan pushes "now at" to all.
    const venue = { venue: 'Kome', venueId: 'p1' };
    const { unmount } = mount({ flock: venue });
    expect(screen.getByRole('button', { name: 'Options for Kome' })).toBeInTheDocument();
    unmount();
    mount({ flock: { ...venue, status: 'cancelled' } });
    expect(screen.getByRole('button', { name: /^Kome/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Options for Kome' })).toBeNull();
  });

  test('the plus sheet drops the vote and the invite, and keeps the rest', () => {
    // Scoped to the sheet: an empty chat on a live plan draws its own Invite
    // friends button in the stream as well.
    const plusSheet = () => within(screen.getByTestId('composer-plus-sheet'));
    const { unmount } = mount();
    fireEvent.click(screen.getByLabelText('More to send'));
    expect(plusSheet().getByRole('button', { name: 'Vote on a venue' })).toBeInTheDocument();
    expect(plusSheet().getByRole('button', { name: 'Invite friends' })).toBeInTheDocument();
    unmount();

    mount({ flock: { status: 'cancelled' } });
    fireEvent.click(screen.getByLabelText('More to send'));
    expect(plusSheet().queryByRole('button', { name: 'Vote on a venue' })).toBeNull();
    expect(plusSheet().queryByRole('button', { name: 'Invite friends' })).toBeNull();
    // The sheet itself still opens: a photo still sends into an ended plan.
    expect(plusSheet().getByRole('button', { name: 'Photo' })).toBeInTheDocument();
  });

  test('an empty chat on a cancelled plan says so, and offers no invite or vote', () => {
    mount({ flock: { status: 'cancelled' } });
    expect(screen.getByText('This plan was called off. You can still send messages here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invite friends/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Suggest a place/ })).toBeNull();
  });

  test('an empty chat on a live plan keeps its two openers', () => {
    mount();
    expect(screen.getByText(/gets sorted out/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invite friends/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Suggest a place/ })).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The two lists a cancelled plan is still shown in
// ═══════════════════════════════════════════════════════════════════════════

describe('a cancelled plan is called cancelled where it is still listed', () => {
  test('Messages: the chip reads Cancelled, not the Planning it fell through to', () => {
    const list = read('screens', 'ChatListScreen.js');
    const label = list.slice(list.indexOf('const statusLabel = '), list.indexOf('\n', list.indexOf('const statusLabel = ')));
    expect(label).toContain("f.status === 'cancelled' ? 'Cancelled'");
    expect(label.indexOf("'Cancelled'")).toBeLessThan(label.indexOf("'Planning'"));
  });

  test('the plan screen: the status row says Cancelled, not Done beside a check', () => {
    const detail = read('screens', 'FlockDetail.js');
    expect(detail).toContain("{flock.status === 'cancelled' ? 'Cancelled' : isCompleted ? 'Done' : isConfirmed ? 'Locked In' : 'Still Planning'}");
    expect(detail).toContain("flock.status === 'cancelled' ? Icons.x('var(--text-secondary)', 12) : isCompleted ? Icons.check(");
  });

  test('the plan screen: Invite is gone once the plan has ended, like its neighbours', () => {
    const detail = read('screens', 'FlockDetail.js');
    const invite = detail.indexOf("{Icons.userPlus('white', 12)} Invite");
    expect(invite).toBeGreaterThan(-1);
    expect(detail.slice(Math.max(0, invite - 900), invite)).toContain('{!isCompleted && (');
  });
});
