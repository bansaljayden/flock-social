/**
 * ADD FRIENDS: INVITE A FRIEND IS ON THE TAB THE SCREEN OPENS ON.
 *
 * The empty Nest sends a new account to Add Friends, which opens on Search.
 * On a new app most of that account's friends are not on Flock yet, so a name
 * search finds nobody, and the one Invite a friend button lived at the bottom
 * of the Contacts tab. Contacts is drawn only where an address book can be
 * read (services/contacts.js), which is never true in a browser without the
 * Contacts Picker, iPhone Safari included, and that is where people who
 * signed up from a guest link are. So the web had no way to invite anybody.
 *
 * What is pinned, rendered rather than grepped:
 *   1. Search's empty state carries the button, on the web layout (no
 *      Contacts tab) and on the app layout alike.
 *   2. A search that found nobody carries it too, since that is the moment
 *      the person being looked for is most likely not on Flock.
 *   3. It is the same handler as the Contacts card, and it waits for the code
 *      it sends: disabled, and inert, until myFriendCode has loaded.
 *   4. The Contacts card is still there, unchanged.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test addFriendsInviteOnSearch --watchAll=false
 */
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');

const AddFriends = require('../screens/AddFriends').default;

const noop = () => {};

function renderAddFriends(overrides) {
  const props = {
    DialogBehavior: () => null,
    ListSkeleton: () => null,
    SearchInputLocal: ({ initialValue, onCommit, transform, ...rest }) => React.createElement('input', { ...rest, defaultValue: initialValue }),
    BottomNav: () => null,
    addFriendsError: '',
    addFriendsResults: [],
    addFriendsSearch: '',
    addFriendsSearching: false,
    addFriendsTab: 'username',
    colors: { navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1a3a5c', cream: '#f4ede4', creamDark: '#e5dccd', borderDefault: '#d6d6d6', amber: '#d97706', textTertiary: '#888888', textSecondary: '#555555', redText: '#b91c1c' },
    confirmClick: jest.fn(),
    contactsDenied: false,
    contactsLoading: false,
    contactsResult: null,
    // The web layout: no address book, so no Contacts tab at all.
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
    handleInviteFriend: jest.fn(),
    handleLookupByNumber: noop,
    handleSendFriendRequest: noop,
    handleSyncContacts: noop,
    loadAddFriendsData: noop,
    myFriendCode: 'FLOCK-AB12CD34',
    myFriendCodeFailed: false,
    openUserProfile: noop,
    outgoingRequests: [],
    pendingRequests: [],
    pendingRequestsError: '',
    phoneLookupError: '',
    phoneLookupInput: '',
    phoneLookupLoading: false,
    phoneLookupUsers: null,
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
  render(React.createElement(AddFriends, props));
  return props;
}

const inviteButton = () => screen.getByRole('button', { name: /Invite a friend/ });

describe('Search, before anything is typed', () => {
  test('on the web, where there is no Contacts tab, the empty state offers the invite', () => {
    const props = renderAddFriends();
    expect(screen.queryByRole('button', { name: /Contacts/ })).toBeNull();
    expect(screen.getByText('Find people you know')).toBeInTheDocument();
    expect(screen.getByText('Search by the name they signed up with. Not on Flock yet? Send them your code.')).toBeInTheDocument();

    fireEvent.click(inviteButton());
    expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
    expect(props.confirmClick).toHaveBeenCalledTimes(1);
  });

  test('in the app, with a Contacts tab, the tab it opens on offers it too', () => {
    const props = renderAddFriends({ contactsSupported: true });
    expect(screen.getByRole('button', { name: /Contacts/ })).toBeInTheDocument();
    fireEvent.click(inviteButton());
    expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
  });

  test('it waits for the code it sends: disabled, and a tap sends nothing', () => {
    const props = renderAddFriends({ myFriendCode: '' });
    const button = inviteButton();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(props.handleInviteFriend).not.toHaveBeenCalled();
  });
});

describe('Search, after a search that found nobody', () => {
  test('the no-results note offers the invite as well', () => {
    const props = renderAddFriends({ addFriendsSearch: 'Maya' });
    expect(screen.getByText('No users found for "Maya"')).toBeInTheDocument();
    expect(screen.getByText('Not on Flock yet? Send them your code.')).toBeInTheDocument();
    fireEvent.click(inviteButton());
    expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
  });

  test('a search that found somebody does not push an invite at them', () => {
    renderAddFriends({
      addFriendsSearch: 'Maya',
      addFriendsResults: [{ id: 7, name: 'Maya', profile_image_url: null }],
    });
    expect(screen.getByText('Maya')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invite a friend/ })).toBeNull();
  });

  test('a failed search is said as a failure, not answered with an invite', () => {
    renderAddFriends({ addFriendsSearch: 'Maya', addFriendsError: 'Search is not working right now.' });
    expect(screen.getByText('Search is not working right now.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invite a friend/ })).toBeNull();
  });
});

test('the Contacts card keeps its own invite', () => {
  const props = renderAddFriends({ contactsSupported: true, addFriendsTab: 'contacts' });
  const card = screen.getByText('Nobody there yet?').parentElement;
  fireEvent.click(within(card).getByRole('button', { name: /Invite a friend/ }));
  expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
});
