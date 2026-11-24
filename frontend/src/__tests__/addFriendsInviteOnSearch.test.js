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
 * Since the rebuild of 2026-11-23 the header carries Invite on every tab as
 * well, so the button under an empty search is the second way in, not the
 * only one; each check below is scoped to the tab's own content.
 *
 * What is pinned, rendered rather than grepped:
 *   1. Search's empty state carries the button, on the web layout (no
 *      Contacts tab) and on the app layout alike.
 *   2. A search that found nobody carries it too, since that is the moment
 *      the person being looked for is most likely not on Flock.
 *   3. It is the same handler as the header's and the Contacts tab's, it
 *      waits for the code it sends (disabled, and inert, until myFriendCode
 *      has loaded), and it draws no success tick: a share sheet closed
 *      without sending is not a success.
 *   4. The Contacts tab keeps its own way to invite.
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
    EmailConfirmLine: () => null,
    ListSkeleton: () => null,
    SearchInputLocal: ({ initialValue, onCommit, transform, inputRef, ...rest }) => React.createElement('input', { ...rest, ref: inputRef, defaultValue: initialValue }),
    addFriendsError: '',
    addFriendsResults: [],
    addFriendsSearch: '',
    addFriendsSearching: false,
    addFriendsTab: 'username',
    colors: { navy: '#0d2847', navyBg: '#0d2847', navyMidBg: '#1a3a5c', cream: '#f4ede4', creamDark: '#e5dccd', borderDefault: '#d6d6d6', amber: '#d97706', textTertiary: '#888888', textSecondary: '#555555', redText: '#b91c1c' },
    confirmClick: jest.fn(),
    contactsDenied: false,
    contactsLoading: false,
    contactsPermission: null,
    contactsResult: null,
    contactsRetryAt: null,
    // The web layout: no address book, so no Contacts tab at all.
    contactsSupported: false,
    contactsUnavailable: false,
    contactsUsers: [],
    decliningRequests: [],
    emailUnconfirmed: false,
    focusCodeFieldRequest: 0,
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
    handleOpenAppSettings: undefined,
    handleSendFriendRequest: noop,
    handleShareMyCode: noop,
    handleSyncContacts: noop,
    handleTogglePhoneDiscovery: noop,
    handleUndoDecline: noop,
    loadAddFriendsData: noop,
    myFriendCode: 'FLOCK-AB12CD34',
    myFriendCodeFailed: false,
    myFriendCodeQr: 'https://www.flockcorp.com/add/FLOCK-AB12CD34',
    myName: 'Casey Crawler',
    myPhotoUrl: null,
    openEditProfile: noop,
    openQrScanner: noop,
    openUserProfile: noop,
    outgoingRequests: [],
    outgoingRequestsLoaded: true,
    pendingRequests: [],
    pendingRequestsError: '',
    phoneDiscoverable: null,
    phoneLookupError: '',
    phoneLookupInput: '',
    phoneLookupLoading: false,
    phoneLookupUsers: null,
    phoneOnFile: false,
    requestsTabBadge: 0,
    setAddFriendsResults: noop,
    setAddFriendsSearch: noop,
    setAddFriendsTab: noop,
    setCurrentScreen: noop,
    setFriendCodeInput: noop,
    setPhoneLookupError: noop,
    setPhoneLookupInput: noop,
    setPhoneLookupUsers: noop,
    showToast: noop,
    startNewDmWithUser: noop,
    styles: { card: {} },
    ...overrides,
  };
  render(React.createElement(AddFriends, props));
  return props;
}

// The tab's own content, so the header's Invite is not the one found.
const tab = () => within(screen.getByRole('tabpanel'));
const inviteButton = () => tab().getByRole('button', { name: /Invite a friend/ });

describe('Search, before anything is typed', () => {
  test('on the web, where there is no Contacts tab, the empty state offers the invite', () => {
    const props = renderAddFriends();
    expect(screen.queryByRole('tab', { name: /Contacts/ })).toBeNull();
    expect(screen.getByText('Find people you know')).toBeInTheDocument();
    expect(screen.getByText('Search by the name they signed up with. Not on Flock yet? Send them your code.')).toBeInTheDocument();

    fireEvent.click(inviteButton());
    expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
    // No success tick before anything has been sent.
    expect(props.confirmClick).not.toHaveBeenCalled();
  });

  test('in the app, with a Contacts tab, the tab it opens on offers it too', () => {
    const props = renderAddFriends({ contactsSupported: true });
    expect(screen.getByRole('tab', { name: /Contacts/ })).toBeInTheDocument();
    fireEvent.click(inviteButton());
    expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
  });

  test('it waits for the code it sends: disabled, and a tap sends nothing, here and in the header', () => {
    const props = renderAddFriends({ myFriendCode: '', myFriendCodeQr: '' });
    const buttons = screen.getAllByRole('button', { name: /Invite a friend/ });
    expect(buttons).toHaveLength(2);
    buttons.forEach((b) => {
      expect(b).toBeDisabled();
      fireEvent.click(b);
    });
    expect(props.handleInviteFriend).not.toHaveBeenCalled();
  });

  test('somebody to suggest takes the empty state\'s place, and the header still invites', () => {
    const props = renderAddFriends({ friendSuggestions: [{ id: 3, name: 'Sam Ortiz', mutual_count: 2 }] });
    expect(screen.getByText('People you may know')).toBeInTheDocument();
    expect(tab().queryByRole('button', { name: /Invite a friend/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Invite a friend' }));
    expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
  });
});

describe('Search, after a search that found nobody', () => {
  test('the no-results note offers the invite as well', () => {
    const props = renderAddFriends({ addFriendsSearch: 'Maya' });
    expect(screen.getByText('No one called "Maya" yet')).toBeInTheDocument();
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
    expect(tab().queryByRole('button', { name: /Invite a friend/ })).toBeNull();
  });

  test('a failed search is said as a failure, not answered with an invite', () => {
    renderAddFriends({ addFriendsSearch: 'Maya', addFriendsError: 'Search is not working right now.' });
    expect(screen.getByText('Search is not working right now.')).toBeInTheDocument();
    expect(tab().queryByRole('button', { name: /Invite a friend/ })).toBeNull();
  });
});

test('the Contacts tab keeps its own invite', () => {
  const props = renderAddFriends({ contactsSupported: true, addFriendsTab: 'contacts' });
  fireEvent.click(tab().getByRole('button', { name: 'Not on Flock yet? Invite a friend' }));
  expect(props.handleInviteFriend).toHaveBeenCalledTimes(1);
});
