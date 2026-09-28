/**
 * THE APP COUNTS A GUEST-LINK VOTE THE WAY THE SERVER DOES.
 *
 * The share link lets anybody who holds it mint guest RSVPs, up to fifty a
 * plan, and vote every one of them. So the server BOUNDS what they weigh
 * (routes/venues.js collectVoteRows): a venue's guest votes count for at most
 * the number of member votes cast on the whole plan, and a tie breaks toward
 * the venue the members picked (tailorVotes). What it sends each row is that
 * weighted total as vote_count, next to the raw guest_count as a headcount.
 *
 * The app threw vote_count away. normalizeVotes kept the names and the RAW
 * guest_count, and voteTotal added the two, so with three members on Kome and
 * four link RSVPs on Corvid Coffee the server said 3 to 3 with Kome on top and
 * every screen in the app said Corvid Coffee 4, Kome 3: the vote panel called
 * the link-holder's pick Leading with the flame, the poll card put it first
 * and the venue card printed 4 votes. One person with the link outvoted the
 * roster in front of the host deciding where the group goes, which is the
 * exact thing the cap was written to stop.
 *
 * What is pinned:
 *
 *   1. THE COUNT IS THE SERVER'S, on every payload shape a tally arrives in.
 *   2. IT MOVES WITH AN OPTIMISTIC TAP. A tap moves 'You' between rows before
 *      the server answers, and the count has to follow the name while the
 *      server's weighting of everything else holds still.
 *   3. THE ORDER IS THE SERVER'S. The screens rank with a stable sort on the
 *      count, so a tie stays where the server put it, members' pick first.
 *   4. THE SCREEN DRAWS IT. The vote panel, the poll card and a shared venue
 *      card, rendered with the real helpers lifted out of App.js.
 *
 * The guest page (website/GuestInvite.js) needs nothing here: it draws the
 * `votes` figure routes/guest.js weighs with the same cap and orders with the
 * same tiebreak, and its own sort is stable over that order.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test guestVoteWeight --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');

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

const ChatDetail = require('../screens/ChatDetail').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const SCREEN = read('screens', 'ChatDetail.js');

/**
 * Balanced-delimiter scan from the first `=` after `start`, stopping at the
 * `;` that closes the declaration. Skips comments and string literals, so a
 * brace inside either cannot end the lift early. Same scan nestCardTruth uses.
 */
function liftFrom(source, start) {
  let i = source.indexOf('=', start) + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
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
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
    i += 1;
  }
  throw new Error('liftFrom: unterminated declaration');
}

function liftModuleConst(name) {
  const marker = `\nconst ${name} = `;
  const at = APP.indexOf(marker);
  if (at === -1) throw new Error(`liftModuleConst: no module-scope const ${name}`);
  return liftFrom(APP, at + 1);
}

// Both run as written in App.js, and nothing else is in scope for them, so a
// body that starts reading another name fails here instead of passing.
const { normalizeVotes, voteTotal } = (() => {
  // eslint-disable-next-line no-new-func
  return new Function(`${liftModuleConst('normalizeVotes')}\n${liftModuleConst('voteTotal')}\nreturn { normalizeVotes, voteTotal };`)();
})();

const ME = { id: 9, name: 'Jay' };

/**
 * The night in the header, as the server sends it on the names shape (the
 * vote POST's reply and every new_vote event). Three members, the reader one
 * of them, on Kome; four guest RSVPs from the share link on Corvid Coffee.
 * Member turnout is 3, so the four guest votes weigh 3, the two rows are
 * level, and tailorVotes puts the members' pick first.
 */
const WIRE = [
  { venue_name: 'Kome', venue_id: 'p1', vote_count: 3, guest_count: 0, voters: ['Ava', 'Bo', 'Jay'], mine: true },
  { venue_name: 'Corvid Coffee', venue_id: 'p2', vote_count: 3, guest_count: 4, voters: [], mine: false },
];

// What the screens do to rank rows (ChatDetail's poll card and vote panel).
const ranked = (rows) => [...rows].sort((a, b) => voteTotal(b) - voteTotal(a));

describe('the lift', () => {
  test('found the real functions, not an empty slice', () => {
    expect(typeof normalizeVotes).toBe('function');
    expect(typeof voteTotal).toBe('function');
    expect(liftModuleConst('normalizeVotes').length).toBeGreaterThan(200);
  });
});

describe('1. the count is the server\'s', () => {
  test('four link votes against three members count as the three the server weighs them at', () => {
    const [kome, corvid] = normalizeVotes(WIRE, ME);
    expect(voteTotal(kome)).toBe(3);
    expect(voteTotal(corvid)).toBe(3);
    // The headcount is still the raw one, so "4 guests" stays true.
    expect(corvid.guestCount).toBe(4);
  });

  test('the GET shape, with { id, name } voters, counts the same', () => {
    const rows = normalizeVotes([
      { venue_name: 'Kome', venue_id: 'p1', vote_count: 3, guest_count: 0, voters: [{ id: 1, name: 'Ava' }, { id: 2, name: 'Bo' }, { id: 9, name: 'Jay' }] },
      { venue_name: 'Corvid Coffee', venue_id: 'p2', vote_count: 3, guest_count: 4, voters: [] },
    ], ME);
    expect(rows.map(voteTotal)).toEqual([3, 3]);
    expect(rows[0].voters).toEqual(['Ava', 'Bo', 'You']);
  });

  test('a vote from somebody the reader blocked is counted, though it is not named', () => {
    // tailorVotes leaves the name off for this reader and keeps the vote in
    // vote_count, because the tally is the group's, not the reader's.
    const [row] = normalizeVotes([{ venue_name: 'Kome', vote_count: 2, guest_count: 0, voters: ['Ava'], mine: false }], ME);
    expect(row.voters).toEqual(['Ava']);
    expect(voteTotal(row)).toBe(2);
  });

  test('a payload with no vote_count is a server from before the cap, and is read the way it counted', () => {
    const [row] = normalizeVotes([{ venue_name: 'Corvid Coffee', guest_count: 4, voters: ['Ava'] }], ME);
    expect(voteTotal(row)).toBe(5);
  });

  test('a row this device built and never normalized counts what it shows', () => {
    expect(voteTotal({ venue: 'Kome', voters: ['You'] })).toBe(1);
    expect(voteTotal({ venue: 'Kome', type: 'Assigned', voters: [], guestCount: 0 })).toBe(0);
    expect(voteTotal(null)).toBe(0);
  });
});

describe('2. the count follows an optimistic tap', () => {
  test('moving the reader\'s vote onto the guests\' pick lands on the server\'s figures', () => {
    // What every vote surface does on a tap: 'You' leaves one row's voters
    // and joins another's, and everything else on the row is spread across.
    // The server's answer to this vote: members 3 (turnout unchanged), Kome 2,
    // Corvid Coffee 1 member plus the four guests weighed at 3.
    const moved = normalizeVotes(WIRE, ME).map((v) => ({
      ...v,
      voters: v.venue === 'Corvid Coffee' ? [...v.voters, 'You'] : v.voters.filter((x) => x !== 'You'),
    }));
    expect(moved.map((v) => [v.venue, voteTotal(v)])).toEqual([['Kome', 2], ['Corvid Coffee', 4]]);
  });
});

describe('3. the order is the server\'s', () => {
  test('a tie the server broke toward the members stays broken that way', () => {
    // Raw sums put Corvid Coffee first at 4. Weighed, the rows are level, and
    // a stable sort leaves them in the order they came: Kome, the roster's.
    expect(ranked(normalizeVotes(WIRE, ME)).map((v) => v.venue)).toEqual(['Kome', 'Corvid Coffee']);
  });

  test('the screens rank with voteTotal and nothing else', () => {
    // Any second key (a name, the raw guests, the voters list) would reorder
    // the tie the server already broke.
    expect(SCREEN).toMatch(/\[\.\.\.pollRows\]\s*\.sort\(\(a, b\) => voteTotal\(b\) - voteTotal\(a\)\)/);
    expect(SCREEN).toMatch(/return voteTotal\(b\) - voteTotal\(a\);\n\s*\}\);/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. The screen, rendered
   ═══════════════════════════════════════════════════════════════════════════ */

const HOST = ME.id;

/**
 * A full props object for the screen, the same shape the other ChatDetail
 * harnesses use (hostPlanControls has the long form), with the real
 * voteTotal in place of a stand in. The first test below proves the list is
 * complete, so a prop added to the screen and forgotten here cannot arrive as
 * undefined and quietly take the falsy branch.
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

const mount = (over) => {
  const p = chatProps(over);
  const view = render(React.createElement(ChatDetail, p));
  return { p, ...view };
};

// A shared card for the guests' pick, posted by a member, so the stream has a
// venue card to draw a count on and the poll card has somewhere to sit.
const corvidCard = {
  id: 103, sender: 'Ava', senderId: 1, text: '', sentAt: '2026-09-25T20:00:00',
  message_type: 'venue_card', venue_data: { name: 'Corvid Coffee', place_id: 'p2' }, reactions: [],
};

const pollRows = (container) => [...container.querySelectorAll('[data-card="poll"] .chat-card-row')];

describe('4. the screen draws the server\'s tally', () => {
  test('the harness hands the screen every prop it destructures', () => {
    const params = SCREEN
      .slice(SCREEN.indexOf('export default function ChatDetail({'), SCREEN.indexOf('\n}) {'))
      .split('\n')
      .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
      .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
      .map((l) => l.slice(0, -1));
    expect(params.length).toBeGreaterThan(100);
    expect(params).toContain('voteTotal');
    const supplied = chatProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });

  test('the vote panel does not call the link-holder\'s pick Leading, and lists the members\' first', () => {
    mount({ flock: { votes: normalizeVotes(WIRE, ME) }, showVotePanel: true });
    const rows = screen.getAllByRole('button', { name: /^(Kome|Corvid Coffee), \d+ votes?$/ });
    expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual(['Kome, 3 votes', 'Corvid Coffee, 3 votes']);
    // The poll card in the stream behind the sheet has its own chips, so the
    // sheet is read on its own.
    const panel = within(rows[0].closest('.modal-content'));
    expect(panel.queryByText('Leading')).toBeNull();
    // Level is level: the panel's own rule for two rows at one count.
    expect(panel.getAllByText('Tied')).toHaveLength(2);
    // The guests are still named as a headcount.
    expect(panel.getByText('4 guests')).toBeInTheDocument();
  });

  test('the poll card ranks and counts the same way', () => {
    const { container } = mount({ flock: { votes: normalizeVotes(WIRE, ME), messages: [corvidCard] } });
    const rows = pollRows(container);
    expect(rows.map((r) => r.querySelector('.chat-truncate').textContent)).toEqual(['Kome', 'Corvid Coffee']);
    for (const r of rows) {
      expect(r.textContent).toContain('3');
      expect(r.textContent).not.toMatch(/4/);
    }
  });

  test('a shared venue card for the guests\' pick prints the weighed count', () => {
    mount({ flock: { votes: normalizeVotes(WIRE, ME), messages: [corvidCard] } });
    expect(screen.getByText(/3 votes/)).toBeInTheDocument();
    expect(screen.queryByText(/4 votes/)).toBeNull();
  });

  test('a tap onto the guests\' pick hands App.js rows that count what the server will answer', () => {
    const { p, container } = mount({ flock: { votes: normalizeVotes(WIRE, ME), messages: [corvidCard] } });
    const corvid = pollRows(container).find((r) => r.textContent.includes('Corvid Coffee'));
    fireEvent.click(corvid);
    expect(p.updateFlockVotes).toHaveBeenCalledTimes(1);
    const [flockId, rows] = p.updateFlockVotes.mock.calls[0];
    expect(flockId).toBe(1);
    expect(rows.map((v) => [v.venue, voteTotal(v)])).toEqual([['Kome', 2], ['Corvid Coffee', 4]]);
  });

  test('taking a vote back keeps a row a blocked member\'s vote still holds up', () => {
    // Kome: the reader and one member the reader blocked, so the server sends
    // vote_count 2 and names only the reader. After the un-vote the server
    // still has Kome at 1, and the optimistic rows have to agree.
    const votes = normalizeVotes([{ venue_name: 'Kome', venue_id: 'p1', vote_count: 2, guest_count: 0, voters: ['Jay'], mine: true }], ME);
    const kome = { ...corvidCard, venue_data: { name: 'Kome', place_id: 'p1' } };
    const { p, container } = mount({ flock: { votes, messages: [kome] } });
    const mine = pollRows(container).find((r) => r.getAttribute('aria-pressed') === 'true');
    fireEvent.click(mine);
    const [, rows] = p.updateFlockVotes.mock.calls[0];
    expect(rows.map((v) => [v.venue, v.voters, voteTotal(v)])).toEqual([['Kome', [], 1]]);
  });
});
