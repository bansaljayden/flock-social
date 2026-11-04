/**
 * A VENUE'S DEAL ON ITS VOTE OPTION AND ON BIRDIE'S CARD (2026-11-03).
 *
 * A deal used to show only on the venue's own page. The server now sends, per
 * member, the deal that member's venue page leads with, as { title, time_slot,
 * days }: on each vote row (backend routes/venues.js voteDealsFor) and on each
 * venue Birdie's search returns (backend routes/ai.js withVenueDeals). Which
 * deal, and whether a drink deal may reach this person, is the server's call
 * (backend utils/venueDeals.js); this file pins what the app does with it.
 *
 *   1. THE LINE (components/venue/VenueDealLine.js): the gift glyph labelled
 *      Deal, the title, then the time slot and days after a middle dot, as the
 *      venue page prints them. Nothing for no deal.
 *   2. normalizeVotes (App.js, run as written) keeps the deal on the row it
 *      came with, and a row the server sent no deal for has none.
 *   3. THE VOTE, RENDERED: the vote sheet row draws the line under the name and
 *      says it in the row's name; the poll card in the stream draws it under
 *      the name inside the row's 44px; the plan screen's vote rows draw it; and
 *      none of them draws it once the plan is over.
 *   4. BIRDIE'S CARD draws the same line under the venue's meta line.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venueDealOnVotes --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, within } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
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
  submitVenueFeedback: jest.fn(),
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
// BirdieBird runs a rAF loop behind an IntersectionObserver, which jsdom does
// not have. What he looks like is not what this file is about.
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, WARM_BIRD: {} };
});

const VenueDealLine = require('../components/venue/VenueDealLine').default;
const { dealOf, dealWhen, dealLineText, dealSpokenText } = require('../components/venue/VenueDealLine');
const PollCard = require('../components/chat/cards/PollCard').default;
const ChatDetail = require('../screens/ChatDetail').default;
const FlockDetail = require('../screens/FlockDetail').default;
const BirdiePanel = require('../components/birdie/BirdiePanel').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const SCREEN = read('screens', 'ChatDetail.js');

/* normalizeVotes and voteTotal, lifted out of App.js and run as written, with
   nothing else in scope (the same scan guestVoteWeight.test.js uses). */
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
const liftModuleConst = (name) => {
  const at = APP.indexOf(`\nconst ${name} = `);
  if (at === -1) throw new Error(`no module-scope const ${name}`);
  return liftFrom(APP, at + 1);
};
const { normalizeVotes, voteTotal } = (() => (
  // eslint-disable-next-line no-new-func
  new Function(`${liftModuleConst('normalizeVotes')}\n${liftModuleConst('voteTotal')}\nreturn { normalizeVotes, voteTotal };`)()
))();

const WINGS = { title: 'Half-price wings', time_slot: 'Happy Hour', days: 'Weekdays' };
const CHURROS = { title: 'Free churros with any entree', time_slot: '5 to 7pm', days: 'Tuesday to Thursday' };
const WINGS_LINE = 'Half-price wings · Happy Hour · Weekdays';
const WINGS_SAID = 'Deal: Half-price wings, Happy Hour, Weekdays';

const ME = { id: 9, name: 'Jay' };
// The vote as the server sends it on the names shape: Kome has a deal for this
// reader, Corvid Coffee has none (so it carries no deal key at all).
const WIRE = [
  { venue_name: 'Kome', venue_id: 'p1', vote_count: 2, guest_count: 0, voters: ['Ava', 'Jay'], mine: true, deal: WINGS },
  { venue_name: 'Corvid Coffee', venue_id: 'p2', vote_count: 1, guest_count: 0, voters: ['Bo'], mine: false },
];

/* ═══════════════════════════════════════════════════════════════════════════
   1. The line
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the deal line', () => {
  test('its words: the title, then when it runs, as the venue page prints them', () => {
    expect(dealLineText(WINGS)).toBe(WINGS_LINE);
    expect(dealWhen(WINGS)).toBe('Happy Hour · Weekdays');
    expect(dealSpokenText(WINGS)).toBe(WINGS_SAID);
    // The Custom choice: the owner's own words, printed as written.
    expect(dealLineText(CHURROS)).toBe('Free churros with any entree · 5 to 7pm · Tuesday to Thursday');
    expect(dealLineText({ title: ' Wings ', time_slot: '  ', days: null })).toBe('Wings');
    expect(dealLineText({ title: 'Wings', time_slot: null, days: 'Daily' })).toBe('Wings · Daily');
    for (const none of [null, undefined, 'Wings', {}, { title: '' }, { title: '   ' }, { title: 7 }]) {
      expect(dealOf(none)).toBeNull();
      expect(dealLineText(none)).toBe('');
      expect(dealSpokenText(none)).toBe('');
    }
  });

  test('drawn: the glyph is labelled Deal, the line is one span, and no deal draws nothing', () => {
    const { container } = render(<VenueDealLine deal={WINGS} iconColor="#2d5a87" />);
    const line = container.querySelector('[data-deal-line]');
    expect(line.tagName).toBe('SPAN');
    expect(line.textContent).toBe(WINGS_LINE);
    expect(within(line).getByRole('img', { name: 'Deal' })).toBeTruthy();
    expect(within(line).getByText('Half-price wings')).toBeTruthy();
    // When it runs, in its own quieter span after the title.
    expect(within(line).getByText('· Happy Hour · Weekdays').textContent).toBe(' · Happy Hour · Weekdays');
    // One line that truncates rather than wraps.
    const words = line.lastChild;
    expect(words.style.whiteSpace).toBe('nowrap');
    expect(words.style.textOverflow).toBe('ellipsis');
    for (const none of [null, { title: '' }]) {
      const { container: empty } = render(<VenueDealLine deal={none} />);
      expect(empty.innerHTML).toBe('');
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. normalizeVotes
   ═══════════════════════════════════════════════════════════════════════════ */

describe('normalizeVotes keeps the deal the server sent this reader', () => {
  test('on the row it came with, and no key on a row with none', () => {
    const [kome, corvid] = normalizeVotes(WIRE, ME);
    expect(kome.deal).toEqual(WINGS);
    expect('deal' in corvid).toBe(false);
    // The GET's { id, name } shape the same way.
    const [fromGet] = normalizeVotes([{ venue_name: 'Kome', venue_id: 'p1', vote_count: 1, voters: [{ id: 9, name: 'Jay' }], deal: CHURROS }], ME);
    expect(fromGet.deal).toEqual(CHURROS);
  });

  test('a deal the next tally does not carry is gone, never kept from the last one', () => {
    const before = normalizeVotes(WIRE, ME);
    const after = normalizeVotes([{ ...WIRE[0], deal: undefined }, WIRE[1]], ME, before);
    expect('deal' in after[0]).toBe(false);
  });

  test('something that is not a deal is not kept', () => {
    for (const junk of ['Half-price wings', { title: '' }, { time_slot: 'Happy Hour' }, 7, null]) {
      const [row] = normalizeVotes([{ venue_name: 'Kome', vote_count: 1, voters: ['Jay'], deal: junk }], ME);
      expect('deal' in row).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. The vote, rendered
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the poll card', () => {
  const options = () => ([
    { id: 'p1', name: 'Kome', voteCount: 2, voted: true, deal: WINGS },
    { id: 'p2', name: 'Corvid Coffee', voteCount: 1, voted: false },
  ]);

  test('an option with a deal draws the line under its name, inside its row', () => {
    const { container } = render(<PollCard options={options()} votedCount={3} memberCount={4} isHost onVote={() => {}} onLock={() => {}} />);
    const kome = screen.getByText('Kome').closest('.chat-card-row');
    const line = kome.querySelector('[data-deal-line]');
    expect(line.textContent).toBe(WINGS_LINE);
    // Stacked under the name in one column, so the count and Lock it in keep
    // their places at the row's end and the row keeps its 44px.
    expect(line.parentElement).toBe(screen.getByText('Kome').parentElement);
    expect(kome.style.minHeight).toBe('44px');
    expect(within(kome).getByRole('button', { name: 'Lock it in' })).toBeTruthy();
    expect(kome.textContent).toBe(`Kome${WINGS_LINE}2Lock it in`);
    // An option with no deal is drawn exactly as before.
    const corvid = screen.getByText('Corvid Coffee').closest('.chat-card-row');
    expect(corvid.querySelector('[data-deal-line]')).toBeNull();
    expect(corvid.textContent).toBe('Corvid Coffee1');
    expect(container.querySelectorAll('[data-deal-line]')).toHaveLength(1);
  });
});

/* A full props object for ChatDetail, the shape guestVoteWeight.test.js uses,
   with the real voteTotal. The first test below proves it is complete. */
const HOST = ME.id;
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
  delete props.flock;
  return props;
}
const mountChat = (over) => render(React.createElement(ChatDetail, chatProps(over)));

// A shared venue card, so the stream has somewhere for the poll card to sit.
const komeCard = {
  id: 103, sender: 'Ava', senderId: 1, text: '', sentAt: '2026-09-25T20:00:00',
  message_type: 'venue_card', venue_data: { name: 'Kome', place_id: 'p1' }, reactions: [],
};

describe('the vote in the chat', () => {
  test('the harness hands the screen every prop it destructures', () => {
    const params = SCREEN
      .slice(SCREEN.indexOf('export default function ChatDetail({'), SCREEN.indexOf('\n}) {'))
      .split('\n')
      .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
      .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
      .map((l) => l.slice(0, -1));
    expect(params.length).toBeGreaterThan(100);
    const supplied = chatProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });

  test('the vote sheet: the line under the venue\'s name, and said in the row\'s name', () => {
    const { container } = mountChat({ flock: { votes: normalizeVotes(WIRE, ME) }, showVotePanel: true });
    const kome = screen.getByRole('button', { name: `Kome, 2 votes, ${WINGS_SAID}` });
    expect(kome.querySelector('[data-deal-line]').textContent).toBe(WINGS_LINE);
    // Under the name, above who voted.
    const column = kome.querySelector('[data-deal-line]').parentElement;
    expect(column.firstChild.textContent).toContain('Kome');
    expect(column.lastChild.textContent).toBe('Ava, You');
    // Corvid Coffee has no deal for this reader: no line and no words.
    const corvid = screen.getByRole('button', { name: 'Corvid Coffee, 1 vote' });
    expect(corvid.querySelector('[data-deal-line]')).toBeNull();
    // The host's Confirm buttons sit beside the vote buttons, not under them.
    expect(screen.getByRole('button', { name: 'Confirm Kome' })).toBeTruthy();
    expect(container.querySelectorAll('[data-deal-line]').length).toBeGreaterThanOrEqual(1);
  });

  test('the poll card in the stream draws the same line on the same option', () => {
    const { container } = mountChat({ flock: { votes: normalizeVotes(WIRE, ME), messages: [komeCard] } });
    const poll = container.querySelector('[data-card="poll"]');
    expect(poll).not.toBeNull();
    const rows = [...poll.querySelectorAll('.chat-card-row')];
    const kome = rows.find((r) => r.textContent.startsWith('Kome'));
    const corvid = rows.find((r) => r.textContent.startsWith('Corvid Coffee'));
    expect(kome.querySelector('[data-deal-line]').textContent).toBe(WINGS_LINE);
    expect(corvid.querySelector('[data-deal-line]')).toBeNull();
  });

  test('a plan that is over draws no deal, in the sheet or the card', () => {
    const { container } = mountChat({
      flock: { votes: normalizeVotes(WIRE, ME), messages: [komeCard], status: 'completed' },
      showVotePanel: true,
    });
    expect(container.querySelector('[data-deal-line]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Kome, 2 votes' })).toBeTruthy();
  });
});

describe('the plan screen\'s vote rows', () => {
  const renderPlan = (status = 'planning') => {
    const flock = {
      id: 7, name: 'Friday', status, creatorId: 1, host: 'Me',
      members: [{ id: 1, name: 'Me', status: 'accepted' }], guests: [],
      votes: normalizeVotes(WIRE, ME),
      eventTime: '2099-01-01T20:00:00Z',
    };
    const given = {
      authUser: { id: 1, name: 'Me' },
      getSelectedFlock: () => flock,
      selectedFlockId: 7,
      colors: { steel: '#2d5a87' },
      styles: {},
      crowdPredictions: {},
      feedbackState: {},
      submittedFeedback: new Set(),
      MOMENTUM_STAGES: [],
      momentumStageKey: () => 'planning',
      voteTotal,
      resolveEventTime: (f) => (f && f.eventTime ? new Date(f.eventTime) : null),
      slideRef: { current: null },
      slideFillRef: { current: null },
      slideThumbRef: { current: null },
      slidePctRef: { current: 0 },
      slidingRef: { current: false },
      slideStage: 'idle',
      DialogBehavior: () => null,
      MissingFlockPanel: () => null,
    };
    // Every other prop is a handler these tests do not press.
    const props = new Proxy(given, { get: (t, k) => (k in t ? t[k] : () => {}), has: () => true });
    return render(<FlockDetail {...props} />);
  };

  test('a row with a deal draws the line, one without draws none', () => {
    const { container } = renderPlan();
    const lines = [...container.querySelectorAll('[data-deal-line]')];
    expect(lines.map((l) => l.textContent)).toEqual([WINGS_LINE]);
    expect(lines[0].closest('button').textContent).toContain('Kome');
  });

  test('not once the plan is over', () => {
    const { container } = renderPlan('cancelled');
    expect(container.querySelector('[data-deal-line]')).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. Birdie's card
   ═══════════════════════════════════════════════════════════════════════════ */

function panelProps(overrides = {}) {
  return {
    AI_CHAT_MAX_MESSAGES: 24,
    AI_CHAT_MAX_MESSAGE_CHARS: 4000,
    DialogBehavior: () => null,
    aiChatEndRef: React.createRef(),
    aiInputHasText: false,
    aiInputHasTextRef: { current: false },
    aiInputRef: React.createRef(),
    aiInputValueRef: { current: '' },
    aiMemoryCut: 0,
    aiMessages: [],
    aiMsgCountRef: { current: 0 },
    aiRemaining: null,
    aiResetsAt: null,
    aiShareVenue: null,
    aiSuggestedQuestions: [],
    aiTyping: false,
    answerBirdieConsent: jest.fn(() => Promise.resolve(true)),
    birdieActionBusy: false,
    birdieConsentBusy: false,
    birdieConsentError: '',
    birdieConsented: true,
    birdieCorner: 'bottom-right',
    canSendAi: true,
    closeAiChat: jest.fn(),
    colors: { navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1e3a5c', steel: '#2d5a87' },
    confirmBirdieDraft: jest.fn(),
    confirmBirdieVoteStage: jest.fn(),
    entitlements: {},
    fabDockBottom: '90px',
    fillAiInput: jest.fn(),
    flocks: [],
    formatEventTime: (t) => String(t),
    isAiFullscreen: false,
    isAiPanel: true,
    isDark: false,
    isPro: false,
    loadTrustedContacts: jest.fn(),
    memberCountLabel: () => '',
    openExternal: jest.fn(),
    openVenueDetail: jest.fn(),
    outOfChirps: false,
    sendAiMessage: jest.fn(),
    setAiInputHasText: jest.fn(),
    setAiShareVenue: jest.fn(),
    setCurrentScreen: jest.fn(),
    setCurrentTab: jest.fn(),
    setPaywallTrigger: jest.fn(),
    setProfileScreen: jest.fn(),
    setSelectedFlockId: jest.fn(),
    setSelectedVenueForCreate: jest.fn(),
    startNewAiChat: jest.fn(),
    toggleAiFullscreen: jest.fn(),
    transmitFlockMessage: jest.fn(),
    ...overrides,
  };
}

describe('Birdie\'s venue card', () => {
  const venue = (over) => ({
    place_id: 'ChIJcard', name: 'Taqueria Lupe', address: '12 Main St, Easton, PA', rating: 4.6, reviews: 210,
    price_level: 2, types: ['restaurant'], is_open: true, lat: 40.6, lng: -75.4, photo_url: null, crowd: null, crowd_label: null,
    ...over,
  });

  test('a venue with a deal shows the line under its meta line; one without shows none', () => {
    const { container } = render(<BirdiePanel {...panelProps({
      aiMessages: [{
        role: 'assistant',
        text: 'Taqueria Lupe has a deal on, or Galaxy Arcade',
        venues: [venue({ deal: CHURROS }), venue({ place_id: 'ChIJarcade', name: 'Galaxy Arcade', address: '3 Elm St' })],
      }],
    })} />);
    const lines = [...container.querySelectorAll('[data-deal-line]')];
    expect(lines.map((l) => l.textContent)).toEqual(['Free churros with any entree · 5 to 7pm · Tuesday to Thursday']);
    expect(within(lines[0]).getByRole('img', { name: 'Deal' })).toBeTruthy();
    const card = lines[0].closest('div[style*="border-radius"]');
    expect(card.textContent).toContain('Taqueria Lupe');
    expect(card.textContent).not.toContain('Galaxy Arcade');
    // Under the meta line (price, rating, street), above the card's buttons.
    expect(lines[0].previousElementSibling.textContent).toContain('12 Main St');
    expect(within(card).getByRole('button', { name: /Details/ })).toBeTruthy();
  });
});
