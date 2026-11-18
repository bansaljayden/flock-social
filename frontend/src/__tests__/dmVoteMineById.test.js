/**
 * "YOUR VOTE" IN A DM'S VENUE VOTE IS FOUND BY ACCOUNT, NOT BY NAME (2026-11-17).
 *
 * Each option in a DM tally lists who voted for it. The screen found your own
 * vote by looking for your display name in that list, and a name is not an
 * account: in a thread with somebody who shares your name, their vote was
 * drawn as yours (the check, "You voted for", the card's Voted state), the two
 * of you counted as one voter, and a tap on their option was taken for an
 * un-vote of your own. The server now sends `voter_ids` beside `voters`, in the
 * same order (backend sockets/handlers.js DM_VOTE_TALLY_SQL), and this screen
 * matches on the id. A tally without ids, from a server before that, is
 * matched on the name as it was.
 *
 * Pinned here, through the rendered screen:
 *   1. the vote panel's header, count and taps, with two people named Alex;
 *   2. the shared venue card's Voted state and its tap, the same;
 *   3. an old server's answer (no ids) still finds your vote by name.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test dmVoteMineById --watchAll=false
 */
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');

// The screen imports these at module scope. None is under test and both reach
// the network or the socket.
jest.mock('../services/api', () => ({
  __esModule: true,
  isOffline: jest.fn(() => false),
  sendFriendRequest: jest.fn(),
  trackDmVenueVote: jest.fn(),
  getDmMessageImage: jest.fn(),
}));
jest.mock('../services/socket', () => ({
  __esModule: true,
  dmReact: jest.fn(),
  dmRemoveReact: jest.fn(),
  dmStopSharingLocation: jest.fn(),
  // The emit left the device: the panel keeps its optimistic tally.
  dmVoteVenue: jest.fn(() => true),
  getSocket: jest.fn(() => ({ connected: true })),
}));

const DmDetail = require('../screens/DmDetail').default;
const socketMock = require('../services/socket');

const COLORS = {
  navy: '#0d2847', navyBg: '#0d2847', navyMid: '#1b4a7a', navyMidBg: '#1b4a7a',
  steel: '#3d6b96', cream: '#f0ead8', creamDark: '#d9d0b8', red: '#b91c1c',
  redText: '#b91c1c', amber: '#f59e0b', amberText: '#92400e',
  textSecondary: '#5b6b7c', textTertiary: '#8a97a5',
};

// Me: account 1, Alex. The other person: account 7, also called Alex.
const ME = { id: 1, name: 'Alex' };
const DM = { id: 7, userId: 7, name: 'Alex', profile_image_url: null, messages: [] };

/** Every name the screen destructures, the shape dmVenueDealOnVotes.test.js uses. */
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
    resolveVenuePhoto: () => null,
    allVenues: [],
    authUser: ME,
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
    showDmVotePanel: true,
    showToast: fn(),
    userLocation: null,
    handleUnsendDm: fn(),
    ...over,
  };
}

// The tally as the server now sends it: the other Alex (7) voted for Kome, I
// (1) voted for Corvid Coffee. The names cannot tell the two votes apart.
const SAME_NAMES = () => ([
  { venue_name: 'Kome', venue_id: 'p1', vote_count: 1, voters: ['Alex'], voter_ids: [7] },
  { venue_name: 'Corvid Coffee', venue_id: 'p2', vote_count: 1, voters: ['Alex'], voter_ids: [1] },
]);

const sheetOf = () => screen.getByText('Vote for a venue').closest('.modal-content');
const rowFor = (name) => within(sheetOf()).getByText(name).closest('button');
const header = () => within(sheetOf()).getByText(/votes? cast/).textContent;
// The tally the last write left. The card writes through an updater, which is
// handed the tally the screen was given, as React would.
const lastTally = (p) => {
  const next = p.setDmVenueVotes.mock.calls[p.setDmVenueVotes.mock.calls.length - 1][0];
  return typeof next === 'function' ? next(p.dmVenueVotes) : next;
};
const shape = (rows) => rows.map(({ venue_name, vote_count, voters, voter_ids }) => ({ venue_name, vote_count, voters, voter_ids }));

beforeEach(() => { socketMock.dmVoteVenue.mockReturnValue(true); });

describe('the vote panel, with two people named Alex', () => {
  test('my vote is the one with my account on it, and two voters are two', () => {
    render(React.createElement(DmDetail, dmProps({ dmVenueVotes: SAME_NAMES() })));
    expect(header()).toBe('2 votes cast · You voted for Corvid Coffee');
  });

  test('a tap on the other Alex\'s option is my vote for it, not an un-vote', () => {
    const p = dmProps({ dmVenueVotes: SAME_NAMES() });
    render(React.createElement(DmDetail, p));
    fireEvent.click(rowFor('Kome'));
    expect(socketMock.dmVoteVenue).toHaveBeenCalledWith(7, 'Kome', 'p1');
    // I move from Corvid Coffee to Kome; the other Alex's vote stays put.
    expect(shape(lastTally(p))).toEqual([
      { venue_name: 'Kome', vote_count: 2, voters: ['Alex', 'Alex'], voter_ids: [7, 1] },
    ]);
  });

  test('a tap on my own option takes back mine and only mine', () => {
    const p = dmProps({ dmVenueVotes: SAME_NAMES() });
    render(React.createElement(DmDetail, p));
    fireEvent.click(rowFor('Corvid Coffee'));
    expect(socketMock.dmVoteVenue).toHaveBeenCalledWith(7, 'Corvid Coffee', 'p2');
    expect(shape(lastTally(p))).toEqual([
      { venue_name: 'Kome', vote_count: 1, voters: ['Alex'], voter_ids: [7] },
    ]);
  });

  test('a vote for a place nobody has voted for yet carries my id', () => {
    const p = dmProps({
      dmVenueVotes: SAME_NAMES(),
      dmPinnedVenue: { name: 'Hollow Pines', addr: '2 Elm St', place_id: 'p3', rating: 4.4, photo_url: null },
    });
    render(React.createElement(DmDetail, p));
    fireEvent.click(rowFor('Hollow Pines'));
    expect(socketMock.dmVoteVenue).toHaveBeenCalledWith(7, 'Hollow Pines', 'p3');
    expect(shape(lastTally(p))).toEqual([
      { venue_name: 'Kome', vote_count: 1, voters: ['Alex'], voter_ids: [7] },
      { venue_name: 'Hollow Pines', vote_count: 1, voters: ['Alex'], voter_ids: [1] },
    ]);
  });
});

describe('the shared venue card, with two people named Alex', () => {
  const card = (id, name, placeId) => ({
    id, sender: 'Alex', senderId: 7, text: `Check out ${name}!`, message_type: 'venue_card',
    venue_data: { name, addr: '10 Main St', place_id: placeId }, sentAt: '2026-11-17T18:00:00Z',
  });
  // Kome's card first, then Corvid Coffee's, in the stream's order.
  const THREAD = { ...DM, messages: [card(1, 'Kome', 'p1'), card(2, 'Corvid Coffee', 'p2')] };

  test('only the card I voted for says Voted', () => {
    const { container } = render(React.createElement(DmDetail, dmProps({
      selectedDm: THREAD, dmVenueVotes: SAME_NAMES(), showDmVotePanel: false,
    })));
    const actions = [...container.querySelectorAll('.chat-venue-action')];
    expect(actions).toHaveLength(2);
    expect(actions.map((b) => [b.getAttribute('aria-label'), b.getAttribute('data-active')]))
      .toEqual([['Vote', 'false'], ['Voted', 'true']]);
  });

  test('a tap on the card for the other Alex\'s option casts my vote', () => {
    const p = dmProps({ selectedDm: THREAD, dmVenueVotes: SAME_NAMES(), showDmVotePanel: false });
    const { container } = render(React.createElement(DmDetail, p));
    const [kome] = container.querySelectorAll('.chat-venue-action');
    fireEvent.click(kome);
    expect(socketMock.dmVoteVenue).toHaveBeenCalledWith(7, 'Kome', 'p1');
    expect(shape(lastTally(p))).toEqual([
      { venue_name: 'Kome', vote_count: 2, voters: ['Alex', 'Alex'], voter_ids: [7, 1] },
    ]);
  });
});

describe('a tally from a server that sends no ids', () => {
  const OLD = () => ([
    { venue_name: 'Kome', venue_id: 'p1', vote_count: 1, voters: ['Sam Diaz'] },
    { venue_name: 'Corvid Coffee', venue_id: 'p2', vote_count: 1, voters: ['Alex'] },
  ]);
  const SAM = { ...DM, name: 'Sam Diaz' };

  test('finds my vote by my name, as before', () => {
    render(React.createElement(DmDetail, dmProps({ selectedDm: SAM, dmVenueVotes: OLD() })));
    expect(header()).toBe('2 votes cast · You voted for Corvid Coffee');
  });

  test('and a vote moves my name, adding no ids the server never sent', () => {
    const p = dmProps({ selectedDm: SAM, dmVenueVotes: OLD() });
    render(React.createElement(DmDetail, p));
    fireEvent.click(rowFor('Kome'));
    expect(socketMock.dmVoteVenue).toHaveBeenCalledWith(7, 'Kome', 'p1');
    const next = lastTally(p);
    expect(shape(next)).toEqual([
      { venue_name: 'Kome', vote_count: 2, voters: ['Sam Diaz', 'Alex'], voter_ids: undefined },
    ]);
    expect('voter_ids' in next[0]).toBe(false);
  });
});
