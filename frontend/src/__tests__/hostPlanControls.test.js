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
// And one more thing only the host gets, at the end of the file: the
// notification row on a plan nobody else has joined yet. A new host lands in
// this chat straight from Create, alone, and the first push their plan will
// ever send them is a friend answering the link.
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
  // The chat header's offline read (api.js isOffline). Online here.
  isOffline: () => false,
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
    // Opening the sheet fetches the ordinary link (see the Share block below);
    // nothing asks for a replacement until the confirm.
    expect(api.createFlockInviteLink).not.toHaveBeenCalledWith(1, true);
  });

  test('Keep this link backs out and sends nothing', () => {
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Keep this link' }));
    expect(screen.queryByText('Make a new link?')).toBeNull();
    expect(api.createFlockInviteLink).not.toHaveBeenCalledWith(1, true);
  });

  test('confirming asks the route to regenerate, and puts the new link on screen', async () => {
    api.createFlockInviteLink.mockResolvedValue({ token: 'new', url: 'https://flockcorp.com/i/new' });
    const { p } = openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Make a new link' }));

    const regenerations = api.createFlockInviteLink.mock.calls.filter((c) => c[1] === true);
    expect(regenerations).toEqual([[1, true]]);
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

  test('a link put on show by a copy that went through says Copied', async () => {
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    const restore = stubClipboard(() => Promise.resolve());
    try {
      const { p, rerender } = openSheet();
      await linkHeld();
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/old'));
      rerender(React.createElement(ChatDetail, { ...p, copiedInviteUrl: 'https://flockcorp.com/i/old' }));
      expect(screen.getByRole('status').textContent).toContain('Copied. Anyone with this link');
    } finally {
      restore();
    }
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
    await act(async () => {});
    expect(api.createFlockInviteLink.mock.calls.every((c) => c[1] !== true)).toBe(true);
  });

  test('after a new link is made, Share sends the new one', async () => {
    // The route's own behaviour: once a link is replaced, an ordinary ask
    // hands back the replacement, never the revoked one.
    let live = 'https://flockcorp.com/i/old';
    api.createFlockInviteLink.mockImplementation((id, regenerate) => {
      if (regenerate) live = 'https://flockcorp.com/i/new';
      return Promise.resolve({ url: live });
    });
    const restore = stubShare(() => Promise.resolve());
    try {
      const { p } = openSheet();
      await linkHeld();
      fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
      fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Make a new link' }));
      await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/new'));
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      expect(navigator.share).toHaveBeenCalledWith({ title: 'Join my flock', url: 'https://flockcorp.com/i/new' });
      await act(async () => {});
    } finally {
      restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2b. Share invite link: the tap shares a link already in hand
// ═══════════════════════════════════════════════════════════════════════════

/* The share sheet and the clipboard open only inside the tap's own
   activation, and an await on the network spends it. Share used to await
   createFlockInviteLink on every tap, so on iOS both could be refused, and the
   panel said "Copied." whatever the clipboard had done. The link is now
   fetched when the sheet opens, and the panel says Copied only when the copy
   went through. jsdom has neither navigator.share nor navigator.clipboard, so
   each test that needs one puts it there and takes it away again. */
function stubNavigator(key, impl) {
  const had = Object.prototype.hasOwnProperty.call(navigator, key);
  const before = navigator[key];
  Object.defineProperty(navigator, key, { value: impl, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(navigator, key, { value: before, configurable: true, writable: true });
    else delete navigator[key];
  };
}
function stubShare(impl) { return stubNavigator('share', jest.fn(impl)); }
function stubClipboard(impl) { return stubNavigator('clipboard', { writeText: jest.fn(impl) }); }
// The app in front, for the visibilitychange the sheet listens to.
function stubVisible() {
  const own = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  return () => {
    if (own) Object.defineProperty(document, 'visibilityState', own);
    else delete document.visibilityState;
  };
}
// Lets the fetch that opening the sheet started settle into the held link.
async function linkHeld() {
  await waitFor(() => expect(api.createFlockInviteLink).toHaveBeenCalledWith(1, false, { quiet: true }));
  await act(async () => {});
}

describe('Share invite link, in the invite sheet', () => {
  const openSheet = (over = {}) => mount({ showFlockInviteModal: true, ...over });

  test('opening the sheet asks for the ordinary link, once, quietly, before any tap', async () => {
    // quiet keeps the ask out of invite_link_created (analyticsEvents pins
    // what that option does), so opening the sheet to add app friends is
    // not counted as anyone sharing the link.
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    openSheet();
    await linkHeld();
    expect(api.createFlockInviteLink.mock.calls).toEqual([[1, false, { quiet: true }]]);
  });

  test('an ended plan asks for nothing on open, since the route would refuse it', async () => {
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    openSheet({ flock: { status: 'completed' } });
    await act(async () => {});
    expect(api.createFlockInviteLink).not.toHaveBeenCalled();
  });

  test('the tap opens the share sheet at once, with no network wait in front of it', async () => {
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    const restore = stubShare(() => Promise.resolve());
    try {
      const { p } = openSheet();
      await linkHeld();
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      // Synchronously, inside the click: the tap's activation is still there.
      expect(navigator.share).toHaveBeenCalledWith({ title: 'Join my flock', url: 'https://flockcorp.com/i/old' });
      // And nothing asked the network in front of it.
      expect(api.createFlockInviteLink).toHaveBeenCalledTimes(1);
      await act(async () => {});
      // Behind it, one counted ask: every Share tap has always made one,
      // and it checks the link just sent is still the live one.
      expect(api.createFlockInviteLink.mock.calls).toEqual([[1, false, { quiet: true }], [1, false, { quiet: false }]]);
      expect(navigator.share.mock.invocationCallOrder[0])
        .toBeLessThan(api.createFlockInviteLink.mock.invocationCallOrder[1]);
      // The same link came back, so nothing is said and nothing goes on show.
      expect(p.showToast).not.toHaveBeenCalled();
      expect(p.setCopiedInviteUrl).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('a link replaced from another phone is still shared at once, then said to be dead, and the next tap sends the new one', async () => {
    // The sheet opened on the old link; the creator then made a new one
    // elsewhere, so every later ordinary ask gets the new one.
    api.createFlockInviteLink.mockResolvedValueOnce({ url: 'https://flockcorp.com/i/old' });
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/new' });
    const restore = stubShare(() => Promise.resolve());
    try {
      const { p, rerender } = openSheet();
      await linkHeld();
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      expect(navigator.share).toHaveBeenLastCalledWith({ title: 'Join my flock', url: 'https://flockcorp.com/i/old' });
      await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/new'));
      expect(p.showToast).toHaveBeenCalledWith(
        'That link was just replaced and no longer works. Tap Share invite link to send the new one.', 'error',
      );
      rerender(React.createElement(ChatDetail, { ...p, copiedInviteUrl: 'https://flockcorp.com/i/new' }));
      const panel = screen.getByRole('status').textContent;
      expect(panel).toContain('New link made. The old one no longer works.');
      expect(panel).not.toContain('Copied.');
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      expect(navigator.share).toHaveBeenLastCalledWith({ title: 'Join my flock', url: 'https://flockcorp.com/i/new' });
      await act(async () => {});
    } finally {
      restore();
    }
  });

  test('a recheck that raced Make a new link never puts the killed link back', async () => {
    const OLD = 'https://flockcorp.com/i/old';
    const NEW = 'https://flockcorp.com/i/new';
    let answerRecheck = null;
    let live = OLD;
    api.createFlockInviteLink.mockImplementation((id, regenerate, opts) => {
      if (regenerate) { live = NEW; return Promise.resolve({ url: NEW }); }
      // The first tap's ask behind the share: held open until the
      // replacement has landed, then answered with the link the route handed
      // out before it.
      if (opts && opts.quiet === false && !answerRecheck) return new Promise((resolve) => { answerRecheck = resolve; });
      return Promise.resolve({ url: live });
    });
    const restore = stubShare(() => Promise.resolve());
    try {
      const { p } = openSheet();
      await linkHeld();
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      await waitFor(() => expect(answerRecheck).not.toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
      fireEvent.click(within(dialogTitled('Make a new link?')).getByRole('button', { name: 'Make a new link' }));
      await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith(NEW));
      await act(async () => { answerRecheck({ url: OLD }); });
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      expect(navigator.share).toHaveBeenLastCalledWith({ title: 'Join my flock', url: NEW });
      await act(async () => {});
      expect(p.setCopiedInviteUrl).not.toHaveBeenCalledWith(OLD);
      expect(p.showToast).not.toHaveBeenCalledWith(expect.stringContaining('just replaced'), 'error');
    } finally {
      restore();
    }
  });

  test('coming back to the app with the sheet open picks up a replacement before the next tap', async () => {
    api.createFlockInviteLink.mockResolvedValueOnce({ url: 'https://flockcorp.com/i/old' });
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/new' });
    const restoreShare = stubShare(() => Promise.resolve());
    const restoreVisible = stubVisible();
    try {
      // The dead link is the one on show, from an earlier copy.
      const { p } = openSheet({ copiedInviteUrl: 'https://flockcorp.com/i/old' });
      await linkHeld();
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      // Quiet: coming back to the app is not anyone sharing the link.
      expect(api.createFlockInviteLink.mock.calls).toEqual([[1, false, { quiet: true }], [1, false, { quiet: true }]]);
      await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/new'));
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      expect(navigator.share).toHaveBeenCalledWith({ title: 'Join my flock', url: 'https://flockcorp.com/i/new' });
      await act(async () => {});
    } finally {
      restoreVisible();
      restoreShare();
    }
  });

  test('coming back with no link on show swaps the held link and shows nothing', async () => {
    api.createFlockInviteLink.mockResolvedValueOnce({ url: 'https://flockcorp.com/i/old' });
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/new' });
    const restoreShare = stubShare(() => Promise.resolve());
    const restoreVisible = stubVisible();
    try {
      const { p } = openSheet();
      await linkHeld();
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await act(async () => {});
      expect(api.createFlockInviteLink).toHaveBeenCalledTimes(2);
      expect(p.setCopiedInviteUrl).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      expect(navigator.share).toHaveBeenCalledWith({ title: 'Join my flock', url: 'https://flockcorp.com/i/new' });
      await act(async () => {});
    } finally {
      restoreVisible();
      restoreShare();
    }
  });

  test('a closed sheet stops listening for the app coming back', async () => {
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    const restoreVisible = stubVisible();
    try {
      const { p, rerender } = openSheet();
      await linkHeld();
      rerender(React.createElement(ChatDetail, { ...p, showFlockInviteModal: false }));
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(api.createFlockInviteLink).toHaveBeenCalledTimes(1);
    } finally {
      restoreVisible();
    }
  });

  test('a copy the clipboard refused does not say Copied, and says where the link is', async () => {
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    const restore = stubClipboard(() => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })));
    try {
      const { p, rerender } = openSheet();
      await linkHeld();
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/old'));
      expect(p.showToast).toHaveBeenCalledWith('Link ready. Copy it below');
      rerender(React.createElement(ChatDetail, { ...p, copiedInviteUrl: 'https://flockcorp.com/i/old' }));
      const panel = screen.getByRole('status').textContent;
      expect(panel).not.toContain('Copied.');
      expect(panel).toContain('Here is the link. Anyone with it can see the plan');
      expect(panel).toContain('https://flockcorp.com/i/old');
    } finally {
      restore();
    }
  });

  test('a tap with no link in hand yet fetches it, shows it, and leaves the share for the next tap', async () => {
    // The fetch from opening the sheet was refused, so nothing is held.
    api.createFlockInviteLink.mockRejectedValueOnce(new Error('offline'));
    api.createFlockInviteLink.mockResolvedValue({ url: 'https://flockcorp.com/i/old' });
    const restore = stubShare(() => Promise.resolve());
    try {
      const { p, rerender } = openSheet();
      await linkHeld();
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      await waitFor(() => expect(p.setCopiedInviteUrl).toHaveBeenCalledWith('https://flockcorp.com/i/old'));
      expect(navigator.share).not.toHaveBeenCalled();
      expect(p.showToast).toHaveBeenCalledWith('Link ready. Tap Share invite link again.');
      rerender(React.createElement(ChatDetail, { ...p, copiedInviteUrl: 'https://flockcorp.com/i/old' }));
      expect(screen.getByRole('status').textContent).not.toContain('Copied.');
      // The next tap shares it, straight away.
      fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
      expect(navigator.share).toHaveBeenCalledWith({ title: 'Join my flock', url: 'https://flockcorp.com/i/old' });
      await act(async () => {});
    } finally {
      restore();
    }
  });

  test('a refused fetch on the tap is said, and nothing goes on show', async () => {
    api.createFlockInviteLink.mockRejectedValue(new Error('This plan is finished and cannot accept new invites'));
    const { p } = openSheet();
    await linkHeld();
    fireEvent.click(screen.getByRole('button', { name: /Share invite link/ }));
    await waitFor(() => expect(p.showToast).toHaveBeenCalledWith('This plan is finished and cannot accept new invites', 'error'));
    expect(p.setCopiedInviteUrl).not.toHaveBeenCalled();
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
  '\n    });\n    return unsub;\n  }, [showToast, refreshFlockRoster]);'
);

function runListener(data, flocks, over = {}) {
  const scope = {
    flocksRef: { current: flocks },
    meRef: { current: { id: 5 } },
    showToast: jest.fn(),
    formatEventTime: jest.fn(() => 'Fri 10:00 PM'),
    setFlocks: jest.fn(),
    resolveVenuePhoto: () => null,
    setPendingFlockInvites: jest.fn(),
    refreshFlockRoster: jest.fn(),
    ...over,
  };
  const names = ['flocksRef', 'meRef', 'showToast', 'formatEventTime', 'setFlocks', 'resolveVenuePhoto', 'setPendingFlockInvites', 'refreshFlockRoster', 'data'];
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

  // What this app holds for a plan at Kome, and what the PUT fans out when
  // the host moves it to a venue the body carried no detail for: the row's
  // whole venue block, the cleared parts as null (routes/flocks.js, A NEW
  // VENUE IS ONE BLOCK).
  const AT_KOME = {
    ...LIVE, venue: 'Kome', venueAddress: '1 Kome St', venueId: 'ChIJkome000001',
    venueLat: 40.7, venueLng: -74.0, venueRating: '4.5', venuePhoto: 'https://api.test/api/venues/photo?ref=kome',
  };
  const movedTo = (over = {}) => ({
    flockId: 1, name: 'Friday', status: 'confirmed', event_time: LIVE.eventTime, updatedBy: 'Jay',
    venue_name: "Joe's Bar", venue_address: '', venue_id: 'ChIJjoes00001',
    venue_latitude: null, venue_longitude: null, venue_rating: null, venue_photo_url: null,
    reconfirm_reset: false,
    ...over,
  });
  const photoAsSent = { resolveVenuePhoto: (u) => (u ? `https://api.test${u}` : null) };

  test('a move to another venue leaves no coordinate, photo, rating or place id of the old one', () => {
    // Read with `||`, every null fell back to Kome's, so every other member
    // had a plan called Joe's Bar with Kome's pin, photo and Directions.
    const s = runListener(movedTo(), [AT_KOME], photoAsSent);
    const [after] = s.setFlocks.mock.calls[0][0]([AT_KOME]);
    expect(after).toMatchObject({
      venue: "Joe's Bar", venueAddress: null, venueId: 'ChIJjoes00001',
      venueLat: null, venueLng: null, venueRating: null, venuePhoto: null,
    });
  });

  test('a move with no place id does not keep the old one', () => {
    const s = runListener(movedTo({ venue_id: null, venue_latitude: 40.8, venue_longitude: -73.9 }), [AT_KOME], photoAsSent);
    const [after] = s.setFlocks.mock.calls[0][0]([AT_KOME]);
    expect([after.venueId, after.venueLat, after.venueLng]).toEqual([null, 40.8, -73.9]);
  });

  test('the row\'s own detail is taken as sent, and a coordinate of 0 is a coordinate', () => {
    const s = runListener(movedTo({
      venue_name: 'Kome', venue_address: '1 Kome St', venue_id: 'ChIJkome000001',
      venue_latitude: 0, venue_longitude: -74.0, venue_rating: '4.8', venue_photo_url: '/api/venues/photo?ref=kome',
    }), [AT_KOME], photoAsSent);
    const [after] = s.setFlocks.mock.calls[0][0]([AT_KOME]);
    expect(after).toMatchObject({
      venue: 'Kome', venueAddress: '1 Kome St', venueId: 'ChIJkome000001',
      venueLat: 0, venueLng: -74.0, venueRating: '4.8', venuePhoto: 'https://api.test/api/venues/photo?ref=kome',
    });
  });

  test('an event that carries no venue block leaves the one this app holds', () => {
    // flockSweep sends { flockId, status } and nothing else.
    const s = runListener({ flockId: 1, status: 'completed' }, [AT_KOME], photoAsSent);
    const [after] = s.setFlocks.mock.calls[0][0]([AT_KOME]);
    expect(after).toMatchObject({
      venue: 'Kome', venueAddress: '1 Kome St', venueId: 'ChIJkome000001',
      venueLat: 40.7, venueLng: -74.0, venueRating: '4.5', venuePhoto: AT_KOME.venuePhoto, status: 'completed',
    });
  });
});

// The socket's confirm (select_venue) is the other writer of the venue block,
// and its event now carries the block as the row holds it.
const SELECTED_BODY = lift(
  'const unsub = onVenueSelected((data) => {',
  '\n    });\n    return unsub;\n  }, [showToast]);'
);

describe('the venue_selected listener, lifted out of App.js and executed', () => {
  function runSelected(data, flocks) {
    const setFlocks = jest.fn();
    const showToast = jest.fn();
    // eslint-disable-next-line no-new-func
    new Function('setFlocks', 'showToast', 'resolveVenuePhoto', 'data', SELECTED_BODY)(
      setFlocks, showToast, (u) => (u ? `https://api.test${u}` : null), data
    );
    return setFlocks.mock.calls[0][0](flocks);
  }
  const KOME = { id: 1, venue: 'Kome', venueLat: 40.7, venueLng: -74.0, venueRating: '4.5', venuePhoto: 'kome.jpg' };
  const by = { userId: 9, name: 'Jay' };

  test('the lift found the real listener', () => {
    expect(SELECTED_BODY).toContain('setFlocks(prev => prev.map(');
    expect(SELECTED_BODY).toContain("status: 'confirmed'");
    expect(SELECTED_BODY.length).toBeGreaterThan(400);
  });

  test('a move clears what the row cleared', () => {
    const [after] = runSelected({
      flockId: 1, venue_name: "Joe's Bar", venue_address: null, venue_id: 'ChIJjoes00001',
      venue_latitude: null, venue_longitude: null, venue_rating: null, venue_photo_url: null, selected_by: by,
    }, [KOME]);
    expect(after).toMatchObject({ venue: "Joe's Bar", venueId: 'ChIJjoes00001', venueLat: null, venueLng: null, venueRating: null, venuePhoto: null });
  });

  test('an event from a server that sends no block keeps what this app holds', () => {
    const [after] = runSelected({ flockId: 1, venue_name: 'Kome', venue_address: null, venue_id: null, selected_by: by }, [KOME]);
    expect(after).toMatchObject({ venueLat: 40.7, venueLng: -74.0, venueRating: '4.5', venuePhoto: 'kome.jpg' });
  });
});

// A plan handed on when its creator deleted their account while one member
// still owed another (routes/users.js HAND_ON_OWED_PLANS_SQL). The server
// sends everybody left in it { flockId, creator_id, creator_name }; before,
// nobody was told, so the new host had no host controls and every open app
// kept the deleted account as the host until the list was read again.
describe('a new host from an account deletion, through the same listener', () => {
  const HANDED = { ...LIVE, host: 'Robin', hostId: 9, creatorId: 9 };

  test('the new host is told the plan is theirs, and their copy gains the host id', () => {
    const s = runListener({ flockId: 1, creator_id: 5, creator_name: 'Sam' }, [HANDED]);
    expect(s.showToast).toHaveBeenCalledTimes(1);
    expect(s.showToast).toHaveBeenCalledWith("You're the host of Friday now.");
    const after = s.setFlocks.mock.calls[0][0]([HANDED]);
    expect(after[0]).toMatchObject({ creatorId: 5, hostId: 5, host: 'Sam', status: 'voting', name: 'Friday' });
  });

  test('every other member follows the new host without a toast', () => {
    const s = runListener({ flockId: 1, creator_id: 5, creator_name: 'Sam' }, [HANDED], { meRef: { current: { id: 6 } } });
    expect(s.showToast).not.toHaveBeenCalled();
    expect(s.setFlocks.mock.calls[0][0]([HANDED])[0]).toMatchObject({ creatorId: 5, hostId: 5, host: 'Sam' });
  });

  test('across a block the host is unnamed, as the flock list leaves it', () => {
    const s = runListener({ flockId: 1, creator_id: 5, creator_name: null }, [HANDED], { meRef: { current: { id: 6 } } });
    expect(s.setFlocks.mock.calls[0][0]([HANDED])[0]).toMatchObject({ creatorId: 5, host: 'Unknown' });
  });

  test("the roster is read again, since the deleted account's membership went with it", () => {
    const s = runListener({ flockId: 1, creator_id: 5, creator_name: 'Sam' }, [HANDED]);
    expect(s.refreshFlockRoster).toHaveBeenCalledWith(1);
  });

  test('an ordinary update leaves the host alone and reads no roster', () => {
    const s = runListener({ flockId: 1, name: 'Friday', status: 'planning', event_time: '2026-09-26T22:00:00', updatedBy: 'Jay' }, [HANDED]);
    expect(s.setFlocks.mock.calls[0][0]([HANDED])[0]).toMatchObject({ creatorId: 9, hostId: 9, host: 'Robin' });
    expect(s.refreshFlockRoster).not.toHaveBeenCalled();
  });

  test('a repeat of the notice to the host they already are says nothing', () => {
    const s = runListener({ flockId: 1, creator_id: 5, creator_name: 'Sam' }, [{ ...HANDED, creatorId: 5 }]);
    expect(s.showToast).not.toHaveBeenCalled();
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

// ═══════════════════════════════════════════════════════════════════════════
// 7. Lock it in carries the voted venue's own coordinates
// ═══════════════════════════════════════════════════════════════════════════

describe('locking in a venue voted from a shared card', () => {
  test('sends the coordinates the card carries in the shape the server stores', () => {
    // A card that came back through the server carries latitude/longitude
    // (backend/utils/venuePayload.js). Reading only lat/lng sent none, so the
    // plan kept pointing at whatever venue it had before.
    const card = {
      id: 104, sender: 'Bo', senderId: MEMBER, text: '', sentAt: '2026-09-25T20:00:00',
      message_type: 'venue_card',
      venue_data: { name: "Joe's Bar", place_id: 'pj1', addr: '2 Joe St', latitude: 40.72, longitude: -73.99 },
      reactions: [],
    };
    const updateFlockVenue = jest.fn(() => Promise.resolve(true));
    mount({ flock: { votes: [{ venue: "Joe's Bar", place_id: 'pj1', voters: ['Bo'] }], messages: [card] }, updateFlockVenue });
    fireEvent.click(screen.getByRole('button', { name: 'Lock it in' }));
    expect(updateFlockVenue).toHaveBeenCalledWith(1, expect.objectContaining({
      name: "Joe's Bar", place_id: 'pj1', addr: '2 Joe St', lat: 40.72, lng: -73.99, status: 'confirmed',
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The notification ask, for a host nobody has answered yet
// ═══════════════════════════════════════════════════════════════════════════
//
// CreateScreen makes the flock with memberCount 1 and every exit from its made
// step lands in this chat. The row used to need a second member, so a new
// host was never asked, and the "is in!" push routes/guest.js sends on the
// first yes from the link reached a phone with no permission to show it.

describe('a host alone on a new plan is asked about notifications', () => {
  const firebase = require('../services/firebase');
  // The OS has not answered and the row has not been waved off: the state a
  // brand-new install is in.
  const unasked = { notifStatus: 'default', notifAskDismissed: false };

  test('the host of a one-person plan sees the row, and it names the push they will get', () => {
    mount({ ...unasked, flock: { memberCount: 1 } });
    expect(screen.getByText('Know when they answer')).toBeInTheDocument();
    expect(screen.getByText("Flock can tell you when someone says they're in.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
  });

  test('a member alone on a plan is still not asked: nothing is sent to them there', () => {
    mount({ ...unasked, authUser: { id: MEMBER, name: 'Bo' }, flock: { memberCount: 1 } });
    expect(screen.queryByText('Know when they answer')).toBeNull();
  });

  test('once somebody else is on it, the host gets the line every member gets', () => {
    // RSVP pushes stop being the thing the host is waiting on, and the group
    // line names only what every member is sent.
    mount({ ...unasked, flock: { memberCount: 3 } });
    expect(screen.getByText('Flock can tell you when someone replies here, or this plan changes.')).toBeInTheDocument();
    expect(screen.queryByText("Flock can tell you when someone says they're in.")).toBeNull();
  });

  test('a plan that has ended does not ask its lone host: nobody can answer it now', () => {
    for (const status of ['cancelled', 'completed']) {
      const { unmount } = mount({ ...unasked, flock: { memberCount: 1, status } });
      expect(screen.queryByText('Know when they answer')).toBeNull();
      unmount();
    }
  });

  test('a device that has answered, or a row already waved off, is not asked again', () => {
    for (const over of [
      { notifStatus: 'granted', notifAskDismissed: false },
      { notifStatus: 'denied', notifAskDismissed: false },
      { notifStatus: 'default', notifAskDismissed: true },
    ]) {
      const { unmount } = mount({ ...over, flock: { memberCount: 1 } });
      expect(screen.queryByText('Know when they answer')).toBeNull();
      unmount();
    }
  });

  test('Turn on is the tap that asks the OS, and the row remembers it was answered', async () => {
    firebase.requestNotificationPermission.mockReset();
    firebase.requestNotificationPermission.mockResolvedValue('fcm-token');
    const { p } = mount({ ...unasked, flock: { memberCount: 1 } });
    // Nothing asks the OS until the tap.
    expect(firebase.requestNotificationPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(p.dismissNotifAsk).toHaveBeenCalledTimes(1);
    expect(firebase.requestNotificationPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(p.setNotifStatus).toHaveBeenCalledWith('granted'));
    expect(api.trackNotificationPermission).toHaveBeenCalledWith('granted', 'chat_banner');
  });
});
