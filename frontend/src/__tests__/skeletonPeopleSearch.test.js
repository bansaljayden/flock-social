/**
 * PEOPLE SEARCH, THE FLOCK CODE AND TWO BUTTONS, WHILE THEY WAIT.
 *
 * Add Friends' name search and the New Message sheet waited behind a ring and
 * "Searching..."; the QR tab turned a ring in the code's square; Add (by code)
 * and Look up (by number) swapped their word for a bare "...". The searches
 * draw rows in their rows' shapes now (New Message's bare, like its list), the
 * code draws its 180px square and the 140x36 place of the code button, and the
 * two buttons show the small inline ring an action in progress gets, with the
 * word held so the button keeps its width.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonPeopleSearch
 */
const React = require('react');
const { render, screen, within } = require('@testing-library/react');

const AddFriends = require('../screens/AddFriends').default;
const NewDmModal = require('../components/NewDmModal').default;

const noop = () => {};

/** Every prop Add Friends takes, as addFriendsErrors.test.js supplies them. */
function addFriendsProps(overrides) {
  return {
    DialogBehavior: () => null,
    ListSkeleton: () => null,
    SearchInputLocal: ({ initialValue, onCommit, transform, ...rest }) => React.createElement('input', { ...rest, defaultValue: initialValue }),
    BottomNav: () => null,
    addFriendsError: '',
    addFriendsResults: [],
    addFriendsSearch: '',
    addFriendsSearching: false,
    addFriendsTab: 'username',
    colors: { navy: '#0d2847', navyBg: '#0d2847', cream: '#f4ede4', creamDark: '#e5dccd', borderDefault: '#d6d6d6', amber: '#d97706' },
    confirmClick: noop,
    contactsDenied: false,
    contactsLoading: false,
    contactsResult: null,
    contactsSupported: false,
    contactsUnavailable: false,
    contactsUsers: [],
    friendCodeInput: '',
    friendCodeLoading: false,
    friendStatuses: {},
    friendSuggestions: [],
    friendSuggestionsError: '',
    handleAcceptFriendRequest: noop,
    handleAddByCode: noop,
    handleAddFriendsSearch: noop,
    handleCancelOutgoingRequest: noop,
    handleDeclineFriendRequest: noop,
    handleInviteFriend: noop,
    handleLookupByNumber: noop,
    handleSendFriendRequest: noop,
    handleSyncContacts: noop,
    loadAddFriendsData: noop,
    myFriendCode: '',
    myFriendCodeFailed: false,
    openUserProfile: noop,
    outgoingRequests: [],
    pendingRequests: [],
    pendingRequestsError: '',
    phoneLookupError: '',
    phoneLookupInput: '',
    phoneLookupLoading: false,
    phoneLookupUsers: [],
    qrScanError: '',
    qrScannerDivId: 'qr-reader',
    setAddFriendsResults: noop,
    setAddFriendsSearch: noop,
    setAddFriendsTab: noop,
    setCurrentScreen: noop,
    setFriendCodeInput: noop,
    setPhoneLookupError: noop,
    setPhoneLookupInput: noop,
    setPhoneLookupUsers: noop,
    showQrScanner: false,
    showToast: noop,
    startNewDmWithUser: noop,
    startQrScanner: noop,
    stopQrScanner: noop,
    styles: { card: {} },
    ...overrides,
  };
}

const spinners = (root) => Array.from(root.querySelectorAll('*')).filter((el) => /spin\b/.test(el.style.animation || ''));

describe('Add Friends', () => {
  test('a name search waits with three rows: the 44px face, the name, the Add and Message buttons', () => {
    const { container } = render(React.createElement(AddFriends, addFriendsProps({ addFriendsSearch: 'sam', addFriendsSearching: true })));
    expect(screen.getByText('Searching people')).toBeTruthy();
    const faces = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '44px' && b.style.borderRadius === '50%');
    expect(faces).toHaveLength(3);
    expect(Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.height === '32px')).toHaveLength(6);
    expect(container.textContent).not.toMatch(/Searching\.\.\./);
    expect(screen.queryByText(/No users found/)).toBeNull();
    expect(spinners(container)).toEqual([]);
  });

  test('the Flock code waits as its 180px square and the 140x36 place of the code button, with no ring', () => {
    const { container } = render(React.createElement(AddFriends, addFriendsProps({ addFriendsTab: 'qr' })));
    expect(screen.getByText('Loading your Flock code')).toBeTruthy();
    const sizes = Array.from(container.querySelectorAll('.skeleton')).map((b) => `${b.style.width}x${b.style.height}`);
    expect(sizes).toContain('180pxx180px');
    expect(sizes).toContain('140pxx36px');
    expect(spinners(container)).toEqual([]);
    // Neither an error nor a retry, as addFriendsErrors.test.js already says.
    expect(screen.queryByText('Your code did not load.')).toBeNull();
  });

  test('a code that landed draws no skeleton', () => {
    const { container } = render(React.createElement(AddFriends, addFriendsProps({ addFriendsTab: 'qr', myFriendCode: 'FLOCK-ABCD1234' })));
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
    expect(screen.getByText('FLOCK-ABCD1234')).toBeTruthy();
  });

  test('Add, while the code is being added: the small inline ring, the button\'s width held, the words for a screen reader', () => {
    render(React.createElement(AddFriends, addFriendsProps({ addFriendsTab: 'qr', myFriendCode: 'FLOCK-ABCD1234', friendCodeInput: 'FLOCK-WXYZ9876', friendCodeLoading: true })));
    const button = screen.getByRole('button', { name: 'Adding' });
    expect(button.textContent).not.toContain('...');
    const rings = spinners(button);
    expect(rings).toHaveLength(1);
    expect(rings[0].getAttribute('aria-hidden')).toBe('true');
    expect(rings[0].style.width).toBe('16px');
    const held = within(button).getByText('Add');
    expect(held.style.visibility).toBe('hidden');
  });

  test('Look up, while the number is being looked up: the same ring', () => {
    render(React.createElement(AddFriends, addFriendsProps({ addFriendsTab: 'contacts', contactsSupported: true, phoneLookupInput: '5555550123', phoneLookupLoading: true })));
    const button = screen.getByRole('button', { name: 'Looking up' });
    expect(button.textContent).not.toContain('...');
    expect(spinners(button)).toHaveLength(1);
  });
});

describe('New Message', () => {
  const props = (over) => ({
    DialogBehavior: () => null,
    SearchInputLocal: () => null,
    colors: { navy: '#0d2847', navyBg: '#0d2847', cream: '#f4ede4', creamDark: '#e5dccd' },
    dmModalResults: [],
    dmModalSearching: false,
    dmSearchError: '',
    dmSearchText: '',
    handleDmSearch: noop,
    setDmModalResults: noop,
    setDmSearchText: noop,
    setShowNewDmModal: noop,
    showNewDmModal: true,
    startNewDmWithUser: noop,
    suggestedUsers: [],
    ...over,
  });

  test('a search waits with three bare rows, like the rows it lists: no card, the 44px face, two lines', () => {
    const { container } = render(React.createElement(NewDmModal, props({ dmSearchText: 'sa', dmModalSearching: true })));
    expect(screen.getByText('Searching people')).toBeTruthy();
    const faces = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '44px' && b.style.borderRadius === '50%');
    expect(faces).toHaveLength(3);
    // The bare row: the list row's own 10px by 8px padding and 12px gap.
    faces.forEach((f) => {
      expect(f.parentElement.style.padding).toBe('10px 8px');
      expect(f.parentElement.style.gap).toBe('12px');
    });
    expect(container.textContent).not.toMatch(/Searching\.\.\./);
    expect(spinners(container)).toEqual([]);
  });
});
