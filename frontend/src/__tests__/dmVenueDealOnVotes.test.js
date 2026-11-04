/**
 * A VENUE'S DEAL ON ITS OPTION IN A DM'S VOTE (2026-11-03).
 *
 * A flock's vote sheet, poll card and plan screen draw the deal the server sent
 * this member on each option (venueDealOnVotes.test.js). Two people choosing a
 * place in a DM vote on venues too, and the server now sends each of them
 * their own view of each option's deal on every DM tally (backend
 * sockets/handlers.js dmVotesFor: GET and POST /api/dm/:userId/venue-votes and
 * both copies of dm_new_vote), as { title, time_slot, days }. Which deal, and
 * whether a drink deal may reach this person, is the server's call; this file
 * pins what the DM screen does with what arrives:
 *
 *   1. THE VOTE PANEL draws the line (components/venue/VenueDealLine.js) under
 *      the venue's name and above who voted, where the flock's vote sheet draws
 *      it, and the deal is said in the row's accessible name.
 *   2. A row the server sent no deal with draws none: an option with no deal,
 *      the pinned place the tally does not hold, something that is not a deal,
 *      and a row whose next tally no longer carries one.
 *   3. A vote or an un-vote cast from the panel keeps the server's deal on the
 *      rows it rewrites until the next tally answers.
 *   4. App.js stores the server's rows as sent, from the read and from the live
 *      event, so each person's deal reaches the panel.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test dmVenueDealOnVotes --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');
const { computeAccessibleName } = require('dom-accessibility-api');

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

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');

const COLORS = {
  navy: '#0d2847', navyBg: '#0d2847', navyMid: '#1b4a7a', navyMidBg: '#1b4a7a',
  steel: '#3d6b96', cream: '#f0ead8', creamDark: '#d9d0b8', red: '#b91c1c',
  redText: '#b91c1c', amber: '#f59e0b', amberText: '#92400e',
  textSecondary: '#5b6b7c', textTertiary: '#8a97a5',
};

const DM = { id: 7, userId: 7, name: 'Sam Diaz', profile_image_url: null, messages: [] };

/** Every name the screen destructures, the shape dmVenueEmptyStates.test.js uses. */
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
    authUser: { id: 1, name: 'Alex' },
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

const WINGS = { title: 'Half-price wings', time_slot: 'Happy Hour', days: 'Weekdays' };
const WINGS_LINE = 'Half-price wings · Happy Hour · Weekdays';

// The DM tally as the server sends it to Alex: Sam voted for Kome, which has a
// deal for Alex, and Alex voted for Corvid Coffee, which has none and so
// carries no deal key at all.
const TALLY = () => ([
  { venue_name: 'Kome', venue_id: 'p1', vote_count: 1, voters: ['Sam Diaz'], deal: WINGS },
  { venue_name: 'Corvid Coffee', venue_id: 'p2', vote_count: 1, voters: ['Alex'] },
]);

const sheetOf = () => screen.getByText('Vote for a Venue').closest('.modal-content');
const rowFor = (name) => within(sheetOf()).getByText(name).closest('button');

describe('the harness above covers the screen it renders', () => {
  test('every prop the screen destructures is supplied here', () => {
    const src = read('screens', 'DmDetail.js');
    const params = src
      .slice(src.indexOf('export default function DmDetail({'), src.indexOf('\n}) {'))
      .split('\n')
      .map((l) => l.trim().replace(/\s*\/\/.*$/, ''))
      .filter((l) => /^[A-Za-z_$][\w$]*,$/.test(l))
      .map((l) => l.slice(0, -1));
    expect(params.length).toBeGreaterThan(50);
    const supplied = dmProps();
    expect(params.filter((name) => !(name in supplied))).toEqual([]);
  });
});

describe('the DM vote panel', () => {
  test('a row with a deal draws the line under the venue\'s name and above who voted', () => {
    render(React.createElement(DmDetail, dmProps({ dmVenueVotes: TALLY() })));
    const kome = rowFor('Kome');
    const lines = kome.querySelectorAll('[data-deal-line]');
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.textContent).toBe(WINGS_LINE);
    // The gift glyph labelled Deal, and the flock sheet's 2px above it.
    expect(within(line).getByRole('img', { name: 'Deal' })).toBeTruthy();
    expect(line.style.marginTop).toBe('2px');
    // In the name column: the name row before it, who voted after it.
    expect(line.previousElementSibling.textContent).toContain('Kome');
    expect(line.nextElementSibling.textContent).toBe('Sam Diaz');
    // Corvid Coffee has no deal for this reader, so its row is drawn as before.
    const corvid = rowFor('Corvid Coffee');
    expect(corvid.querySelector('[data-deal-line]')).toBeNull();
    expect(sheetOf().querySelectorAll('[data-deal-line]')).toHaveLength(1);
  });

  test('the deal is said in the row\'s accessible name, and a row without one says none', () => {
    render(React.createElement(DmDetail, dmProps({ dmVenueVotes: TALLY() })));
    // The row's name is read off its content (it carries no aria-label), so
    // the glyph's label and the line's words are in it, after the venue.
    const komeName = computeAccessibleName(rowFor('Kome'));
    expect(komeName).toMatch(/^Kome\b/);
    expect(komeName).toContain(`Deal ${WINGS_LINE}`);
    expect(komeName.indexOf('Deal')).toBeLessThan(komeName.indexOf('Sam Diaz'));
    expect(screen.getByRole('button', { name: new RegExp(`^Kome .*Deal ${WINGS_LINE}`) })).toBe(rowFor('Kome'));
    const corvidName = computeAccessibleName(rowFor('Corvid Coffee'));
    expect(corvidName).toMatch(/^Corvid Coffee\b/);
    expect(corvidName).not.toMatch(/Deal/);
  });

  test('the pinned place the tally does not hold carries no deal, so it draws none', () => {
    render(React.createElement(DmDetail, dmProps({
      dmVenueVotes: [],
      dmPinnedVenue: { name: 'Hollow Pines', addr: '2 Elm St', place_id: 'p3', rating: 4.4, photo_url: null },
    })));
    const pinned = rowFor('Hollow Pines');
    expect(within(pinned).getByText('Current pinned venue. Tap to vote')).toBeTruthy();
    expect(pinned.querySelector('[data-deal-line]')).toBeNull();
  });

  test('a deal the next tally does not carry is gone, never kept from the last one', () => {
    const p = dmProps({ dmVenueVotes: TALLY() });
    const { rerender } = render(React.createElement(DmDetail, p));
    expect(rowFor('Kome').querySelector('[data-deal-line]')).not.toBeNull();
    const [kome, corvid] = TALLY();
    delete kome.deal;
    rerender(React.createElement(DmDetail, { ...p, dmVenueVotes: [kome, corvid] }));
    expect(rowFor('Kome').querySelector('[data-deal-line]')).toBeNull();
    expect(computeAccessibleName(rowFor('Kome'))).not.toMatch(/Deal/);
  });

  test('something that is not a deal draws nothing', () => {
    for (const junk of ['Half-price wings', { title: '' }, { title: '   ' }, { time_slot: 'Happy Hour' }, { title: 7 }, 7, null]) {
      const { unmount } = render(React.createElement(DmDetail, dmProps({
        dmVenueVotes: [{ venue_name: 'Kome', venue_id: 'p1', vote_count: 1, voters: ['Sam Diaz'], deal: junk }],
      })));
      expect(sheetOf().querySelector('[data-deal-line]')).toBeNull();
      expect(computeAccessibleName(rowFor('Kome'))).not.toMatch(/Deal/);
      unmount();
    }
  });
});

describe('a vote cast from the panel', () => {
  // The emit left the device, so the panel keeps its optimistic tally and
  // rolls nothing back. Set per test: this runner resets mock implementations.
  beforeEach(() => { socketMock.dmVoteVenue.mockReturnValue(true); });

  test('a vote keeps the server\'s deal on the row it rewrites until the next tally answers', () => {
    const p = dmProps({ dmVenueVotes: TALLY() });
    render(React.createElement(DmDetail, p));
    fireEvent.click(rowFor('Kome'));
    expect(socketMock.dmVoteVenue).toHaveBeenCalledWith(7, 'Kome', 'p1');
    // The optimistic tally: Alex moves from Corvid Coffee to Kome.
    expect(p.setDmVenueVotes).toHaveBeenCalledTimes(1);
    expect(p.showToast).not.toHaveBeenCalled();
    const optimistic = p.setDmVenueVotes.mock.calls[0][0];
    expect(optimistic.map((v) => [v.venue_name, v.vote_count])).toEqual([['Kome', 2]]);
    expect(optimistic[0].deal).toEqual(WINGS);
  });

  test('an un-vote keeps it too', () => {
    const p = dmProps({ dmVenueVotes: TALLY() });
    render(React.createElement(DmDetail, p));
    // Alex's own vote is Corvid Coffee; tapping it takes it back.
    fireEvent.click(rowFor('Corvid Coffee'));
    expect(socketMock.dmVoteVenue).toHaveBeenCalledWith(7, 'Corvid Coffee', 'p2');
    expect(p.setDmVenueVotes).toHaveBeenCalledTimes(1);
    expect(p.showToast).not.toHaveBeenCalled();
    const optimistic = p.setDmVenueVotes.mock.calls[0][0];
    expect(optimistic.map((v) => v.venue_name)).toEqual(['Kome']);
    expect(optimistic[0].deal).toEqual(WINGS);
  });
});

describe('App.js hands the panel the server\'s rows as sent', () => {
  const region = (start, end) => {
    const at = APP.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return APP.slice(at, APP.indexOf(end, at));
  };

  test('from the read, so each person\'s deal is in the list the panel draws', () => {
    const load = region('const loadDmVenueVotes = useCallback', '}, []);');
    expect(load).toMatch(/getDmVenueVotes\(dmId\)\s*\.then\(data => \{ if \(!overtaken\(\)\) setDmVenueVotes\(data\.votes \|\| \[\]\); \}\)/);
  });

  test('and from the live event, which the server addressed to this person', () => {
    const live = region('const unsub = onDmNewVote(', 'return unsub;');
    expect(live).toMatch(/if \(!isOpenDm\(data\.withUserId\)\) return;/);
    expect(live).toMatch(/setDmVenueVotes\(data\.votes \|\| \[\]\);/);
  });
});
