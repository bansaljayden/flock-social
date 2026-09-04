/**
 * THE DM BLAMED A WORKING SERVICE FOR A COORDINATE IT NEVER HAD.
 *
 * Two panels in screens/DmDetail.js, one tap apart, both keyed off lists that
 * are fed by the user's location and by nothing else:
 *
 *   suggestedVenues comes off popularVenues, and App.js's loadPopularVenues
 *   opens with `if (!userLocation) return;`.
 *   allVenues is only ever filled by loadVenuesAtLocation(lat, lng), which
 *   nothing calls without a coordinate.
 *
 * So on a fresh account that declined the location prompt, or had not yet been
 * asked, both lists are empty because nothing was ever requested. The vote
 * panel said "No votes yet. Be the first to suggest a venue!" over an empty
 * suggestion list, and the only other door it offered, Share a venue to chat,
 * opened a sheet reading "Venue search is unavailable right now". Two screens
 * in a row, the first naming an action with nothing to do it with, the second
 * naming a cause that was false, and a Close button as the only exit.
 *
 * screens/ChatDetail.js, which draws the same two panels for a flock, was
 * fixed on 2026-08-27 and carries the comment this file is named after:
 * "Blaming search when the app simply never had a coordinate told a fresh
 * account a working feature was broken." The DM half was never touched, and
 * could not have been: DmDetail was extracted with a scope walk of the names
 * it referenced, it referenced no coordinate, so userLocation was not among
 * its 93 props and the distinction was structurally unavailable to it.
 *
 * Rendered, not source-scanned. Which branch a person sees is the whole
 * finding, and the props are the only input that decides it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test dmVenueEmptyStates --watchAll=false
 */

const React = require('react');
const { render, screen } = require('@testing-library/react');

// The screen imports these at module scope. None is under test and both reach
// the network or the socket.
jest.mock('../services/api', () => ({
  __esModule: true,
  sendFriendRequest: jest.fn(),
  trackDmVenueVote: jest.fn(),
  getDmMessageImage: jest.fn(),
}));
jest.mock('../services/socket', () => ({
  __esModule: true,
  dmReact: jest.fn(),
  dmRemoveReact: jest.fn(),
  dmStopSharingLocation: jest.fn(),
  dmVoteVenue: jest.fn(),
  getSocket: jest.fn(() => ({ connected: true })),
}));

const DmDetail = require('../screens/DmDetail').default;

const COLORS = {
  navy: '#0d2847', navyBg: '#0d2847', navyMid: '#1b4a7a', navyMidBg: '#1b4a7a',
  steel: '#3d6b96', cream: '#f0ead8', creamDark: '#d9d0b8', red: '#b91c1c',
  redText: '#b91c1c', amber: '#f59e0b', amberText: '#92400e',
  textSecondary: '#5b6b7c', textTertiary: '#8a97a5',
};

const DM = { id: 7, userId: 7, name: 'Sam Diaz', profile_image_url: null, messages: [] };

/**
 * Every name the screen destructures, so a branch is never taken because a
 * prop arrived undefined by accident. The test below this proves the list is
 * still complete against the screen's own parameter list.
 */
function dmProps(over = {}) {
  const fn = () => jest.fn();
  return {
    // App.js module scope, shared with other screens.
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
    // FlockAppInner state, setters and handlers.
    allVenues: [],
    authUser: { id: 1, name: 'Alex' },
    chatInputHasText: false,
    colors: COLORS,
    confirmClick: fn(),
    currentScreen: 'dmDetail',
    deletedDmUserIds: [],
    dmAtTop: false,
    dmBlocked: false,
    dmChatEndRef: { current: null },
    dmNearBottomRef: { current: true },
    dmChatSearch: '',
    dmChatSearchRef: { current: null },
    dmGalleryInputRef: { current: null },
    dmIsTyping: false,
    dmMemberLocation: null,
    dmMessagesLoading: false,
    dmNavOpen: false,
    dmNotConnected: false,
    dmPendingImage: null,
    dmPinnedVenue: null,
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
    profilePic: null,
    retryFailedDm: fn(),
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
    showDmVotePanel: false,
    showToast: fn(),
    userLocation: null,
    handleUnsendDm: fn(),
    ...over,
  };
}

const HAS_LOCATION = { latitude: 40.6, longitude: -75.4 };

// ---------------------------------------------------------------------------
// The props list cannot silently fall behind the screen.
// ---------------------------------------------------------------------------

describe('the harness above covers the screen it renders', () => {
  test('every prop the screen destructures is supplied here', () => {
    const fs = require('fs');
    const path = require('path');
    const parser = require('@babel/parser');
    const traverse = require('@babel/traverse').default;

    const src = fs.readFileSync(path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8');
    const ast = parser.parse(src, {
      sourceType: 'module',
      plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'],
    });

    let declared = null;
    traverse(ast, {
      ExportDefaultDeclaration(p) {
        const params = p.node.declaration?.params || [];
        if (params[0]?.type !== 'ObjectPattern') return;
        declared = params[0].properties.map((prop) => prop.key.name);
      },
    });
    expect(Array.isArray(declared)).toBe(true);

    const supplied = new Set(Object.keys(dmProps()));
    // A prop added to the screen and forgotten here would arrive undefined and
    // quietly take the other branch, which is the exact failure this file is
    // about: userLocation was undefined in this screen for six days.
    expect(declared.filter((name) => !supplied.has(name))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The vote panel.
// ---------------------------------------------------------------------------

describe('the DM vote panel with nothing to vote on', () => {
  const openPanel = (over) => dmProps({ showDmVotePanel: true, ...over });

  test('with a location on record, the old copy is still the right copy', () => {
    // A coordinate exists and the nearby list came back empty, so nobody having
    // voted really is the whole story and suggesting one is a real next step.
    render(React.createElement(DmDetail, openPanel({ userLocation: HAS_LOCATION })));
    expect(screen.getByText(/be the first to suggest a venue/i)).toBeTruthy();
    expect(screen.queryByText(/needs your location/i)).toBeNull();
  });

  test('with no location, it names the reason instead of an action with nothing behind it', () => {
    render(React.createElement(DmDetail, openPanel()));
    expect(screen.getByText(/Flock needs your location/i)).toBeTruthy();
    expect(screen.queryByText(/be the first to suggest a venue/i)).toBeNull();
  });

  test('and offers the door that actually fills the list', () => {
    const p = openPanel();
    render(React.createElement(DmDetail, p));
    const btn = screen.getByRole('button', { name: /browse venues on discover/i });
    btn.click();
    // The same handoff the header's Add a Venue button uses, so a venue picked
    // over there pins back to THIS conversation rather than to a flock.
    expect(p.setPickingVenueForDm).toHaveBeenCalledWith(true);
    expect(p.setPickingVenueForCreate).toHaveBeenCalledWith(true);
    expect(p.setCurrentTab).toHaveBeenCalledWith('explore');
  });

  test('a failed votes read still speaks for itself, not for the location', () => {
    // dmVenueVotesError already suppresses this whole block. Adding a location
    // branch inside it must not resurrect an empty-state claim over a read that
    // never landed.
    render(React.createElement(DmDetail, openPanel({ dmVenueVotesError: 'Votes did not load.' })));
    expect(screen.queryByText(/be the first to suggest a venue/i)).toBeNull();
    expect(screen.queryByText(/Flock needs your location/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Share a Venue sheet, the only other door the panel offers.
// ---------------------------------------------------------------------------

describe('the DM Share a Venue sheet with an empty list', () => {
  const openSheet = (over) => dmProps({ showDmVenueSearch: true, ...over });

  test('with a location, an empty list does mean venue search is down', () => {
    render(React.createElement(DmDetail, openSheet({ userLocation: HAS_LOCATION })));
    expect(screen.getByText(/venue search is unavailable/i)).toBeTruthy();
  });

  test('with no location, it stops calling a working feature broken', () => {
    render(React.createElement(DmDetail, openSheet()));
    expect(screen.getByText(/doesn't have your location/i)).toBeTruthy();
    expect(screen.getByText(/Discover tab/i)).toBeTruthy();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });
});
