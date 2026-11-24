/**
 * ADD FRIENDS, AS REBUILT ON 2026-11-23, RENDERED.
 *
 * The owner, on his iPhone: the whole Add Friends page was broken. The QR code
 * could not be scanned at night, the keyboard covered the fields, the contacts
 * tab dead-ended, and the friend requests sat above every tab. Six audits
 * measured it; the spec that came out of them decided the shape this file
 * holds the screen to:
 *
 *   - a drill-in with no tab bar, a compact navy header, and a segmented
 *     control: Search, Requests (with its count), Contacts (only where an
 *     address book can be read) and QR code;
 *   - requests on the Requests tab and nowhere else;
 *   - Search field first, sticky, with the results straight under it and
 *     People you may know (once a tab of its own) when nothing is typed;
 *   - the QR code on a white tile with the quiet zone, dark modules, in both
 *     themes, carrying what the server says (the JSON every build reads, the
 *     link once that build is out), with the scanner opened at the App root;
 *   - every field kept above the keys, Return doing something, and no
 *     success tick before the server answers;
 *   - the contacts tab's states said truthfully, with the pre-prompt's one
 *     Continue untouched (permissionPrePrompts.test.js pins its source).
 *
 * qrcode.react is stood in for, so what the screen asks it to draw (the
 * payload, the level, the margin, the colours) is what is checked.
 * skeletonPeopleSearch.test.js renders the real generator.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test addFriendsScreen --watchAll=false
 */
const React = require('react');
const { render, screen, fireEvent, within, act } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const mockQrDrawn = [];
jest.mock('qrcode.react', () => ({
  QRCodeSVG: (props) => {
    mockQrDrawn.push(props);
    return require('react').createElement('svg', { 'data-testid': 'qr', 'aria-label': props.title });
  },
}));

const AddFriends = require('../screens/AddFriends').default;

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'screens', 'AddFriends.js'), 'utf8').replace(/\r\n/g, '\n');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8').replace(/\r\n/g, '\n');

/* The props App.js hands the screen, as the rebuild's contract names them. */
const CONTRACT = [
  'DialogBehavior', 'EmailConfirmLine', 'ListSkeleton', 'SearchInputLocal',
  'addFriendsError', 'addFriendsResults', 'addFriendsSearch', 'addFriendsSearching', 'addFriendsTab',
  'colors', 'confirmClick',
  'contactsDenied', 'contactsLoading', 'contactsPermission', 'contactsResult', 'contactsRetryAt', 'contactsSupported', 'contactsUnavailable', 'contactsUsers',
  'decliningRequests', 'emailUnconfirmed', 'focusCodeFieldRequest',
  'friendCodeInput', 'friendCodeLoading', 'friendStatuses', 'friendSuggestions', 'friendSuggestionsError',
  'handleAcceptFriendRequest', 'handleAddByCode', 'handleAddFriendsSearch', 'handleCancelOutgoingRequest', 'handleDeclineFriendRequest',
  'handleInviteFriend', 'handleLookupByNumber', 'handleOpenAppSettings', 'handleSendFriendRequest', 'handleShareMyCode',
  'handleSyncContacts', 'handleTogglePhoneDiscovery', 'handleUndoDecline',
  'loadAddFriendsData',
  'myFriendCode', 'myFriendCodeFailed', 'myFriendCodeQr', 'myName', 'myPhotoUrl',
  'openEditProfile', 'openQrScanner', 'openUserProfile',
  'outgoingRequests', 'outgoingRequestsLoaded', 'pendingRequests', 'pendingRequestsError',
  'phoneDiscoverable', 'phoneLookupError', 'phoneLookupInput', 'phoneLookupLoading', 'phoneLookupUsers', 'phoneOnFile',
  'requestsTabBadge',
  'setAddFriendsResults', 'setAddFriendsSearch', 'setAddFriendsTab', 'setCurrentScreen', 'setFriendCodeInput',
  'setPhoneLookupError', 'setPhoneLookupInput', 'setPhoneLookupUsers',
  'showToast', 'startNewDmWithUser', 'styles',
];

const LIGHT = { navy: '#1e293b', navyBg: '#1e293b', navyMidBg: '#2d5a87', cream: '#f1ede0', creamDark: '#e8e0d5', borderDefault: '#e5e7eb', amber: '#F59E0B', redText: '#b91c1c' };
const DARK = { navy: '#f1ede0', navyBg: '#1e3a5c', navyMidBg: '#2d5a87', cream: '#0f172a', creamDark: '#1e3a5c', borderDefault: '#1e3a5c', amber: '#F59E0B', redText: '#fca5a5' };

function props(over = {}) {
  return {
    DialogBehavior: () => null,
    EmailConfirmLine: () => null,
    ListSkeleton: () => null,
    // The real box keeps its own state and publishes on a pause; these tests
    // need an input that takes the ref and shows what was typed.
    SearchInputLocal: ({ initialValue, onCommit, transform, inputRef, ...rest }) => React.createElement('input', { ...rest, ref: inputRef, defaultValue: initialValue }),
    addFriendsError: '',
    addFriendsResults: [],
    addFriendsSearch: '',
    addFriendsSearching: false,
    addFriendsTab: 'username',
    colors: LIGHT,
    confirmClick: jest.fn(),
    contactsDenied: false,
    contactsLoading: false,
    contactsPermission: null,
    contactsResult: null,
    contactsRetryAt: null,
    contactsSupported: true,
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
    handleAcceptFriendRequest: jest.fn(),
    handleAddByCode: jest.fn(),
    handleAddFriendsSearch: jest.fn(),
    handleCancelOutgoingRequest: jest.fn(),
    handleDeclineFriendRequest: jest.fn(),
    handleInviteFriend: jest.fn(),
    handleLookupByNumber: jest.fn(),
    handleOpenAppSettings: undefined,
    handleSendFriendRequest: jest.fn(),
    handleShareMyCode: jest.fn(),
    handleSyncContacts: jest.fn(),
    handleTogglePhoneDiscovery: jest.fn(() => Promise.resolve()),
    handleUndoDecline: jest.fn(),
    loadAddFriendsData: jest.fn(),
    myFriendCode: 'FLOCK-AB12CD34',
    myFriendCodeFailed: false,
    myFriendCodeQr: 'https://www.flockcorp.com/add/FLOCK-AB12CD34',
    myName: 'Casey Crawler',
    myPhotoUrl: null,
    openEditProfile: jest.fn(),
    openQrScanner: jest.fn(),
    openUserProfile: jest.fn(),
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
    setAddFriendsResults: jest.fn(),
    setAddFriendsSearch: jest.fn(),
    setAddFriendsTab: jest.fn(),
    setCurrentScreen: jest.fn(),
    setFriendCodeInput: jest.fn(),
    setPhoneLookupError: jest.fn(),
    setPhoneLookupInput: jest.fn(),
    setPhoneLookupUsers: jest.fn(),
    showToast: jest.fn(),
    startNewDmWithUser: jest.fn(),
    styles: { card: {} },
    ...over,
  };
}

function draw(over) {
  const p = props(over);
  const utils = render(React.createElement(AddFriends, p));
  return { p, ...utils };
}

const panel = () => screen.getByRole('tabpanel');

/* A contacts check's answer, in the shape services/contacts.js gives it. */
const result = (over) => ({ checked: 0, total: 0, throttled: false, unreadable: 0, notReached: 0, sent: 0, contactCount: 0, permission: 'granted', retryAt: null, matched: 0, ...over });

// The QR generator is a lazy chunk. Loaded once here, inside act, so a test
// that draws the QR code tab without waiting for it does not leave the chunk
// resolving after the test is over.
beforeAll(async () => {
  const { unmount } = render(React.createElement(AddFriends, props({ addFriendsTab: 'qr' })));
  await screen.findByTestId('qr');
  unmount();
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('the contract with App.js', () => {
  test('the screen takes exactly the props the rebuild names, and none of the scanner\'s or the tab bar\'s', () => {
    const ast = parser.parse(SOURCE, { sourceType: 'module', plugins: ['jsx'] });
    let params = null;
    traverse(ast, {
      ExportDefaultDeclaration(p) {
        params = p.node.declaration.params[0].properties.map((prop) => prop.key.name);
      },
    });
    expect([...params].sort()).toEqual([...CONTRACT].sort());
    ['BottomNav', 'qrScanError', 'qrScannerDivId', 'showQrScanner', 'startQrScanner', 'stopQrScanner']
      .forEach((gone) => expect(params).not.toContain(gone));
    // And every test here hands the screen every one of them.
    expect(Object.keys(props()).sort()).toEqual([...CONTRACT].sort());
  });

  test('no button on the screen draws a success tick before the server has answered', () => {
    expect(SOURCE).not.toMatch(/confirmClick\(/);
  });
});

describe('the chrome', () => {
  test('a drill-in: no tab bar under it, and the back arrow leaves', () => {
    const { p, container } = draw();
    expect(container.querySelector('nav')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Add friends' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(p.setCurrentScreen).toHaveBeenCalledWith('main');
  });

  test('the tabs are one segmented control: Search, Requests, Contacts where an address book can be read, QR code', () => {
    draw();
    const tabs = within(screen.getByRole('tablist', { name: 'Ways to add friends' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Search', 'Requests', 'Contacts', 'QR code']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    tabs.forEach((t) => expect(t).toHaveAttribute('aria-controls', 'add-friends-panel'));
    // One tab stop for the whole control.
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    expect(panel()).toHaveAttribute('aria-labelledby', 'add-friends-tab-username');
  });

  test('without an address book there is no Contacts tab, and a remembered Contacts or Quick Add opens on Search', () => {
    const p = props({ contactsSupported: false, addFriendsTab: 'contacts' });
    const { rerender } = render(React.createElement(AddFriends, p));
    expect(screen.queryByRole('tab', { name: 'Contacts' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    rerender(React.createElement(AddFriends, { ...p, contactsSupported: true, addFriendsTab: 'suggestions' }));
    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Search by name')).toBeInTheDocument();
  });

  test('Requests carries the count of requests waiting, said to a screen reader as well', () => {
    const { unmount } = draw({ requestsTabBadge: 3 });
    const tab = screen.getByRole('tab', { name: /^Requests/ });
    expect(within(tab).getByText('3')).toHaveAttribute('aria-hidden', 'true');
    expect(within(tab).getByText(', 3 new')).toHaveClass('sr-only');
    unmount();
    const { unmount: gone } = draw({ requestsTabBadge: 0 });
    expect(screen.getByRole('tab', { name: 'Requests' }).textContent).toBe('Requests');
    gone();
    draw({ requestsTabBadge: 120 });
    expect(within(screen.getByRole('tab', { name: /^Requests/ })).getByText('99+')).toBeInTheDocument();
  });

  test('the arrow keys move along the tabs', () => {
    const { p } = draw();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Search' }), { key: 'ArrowRight' });
    expect(p.setAddFriendsTab).toHaveBeenLastCalledWith('requests');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Search' }), { key: 'ArrowLeft' });
    expect(p.setAddFriendsTab).toHaveBeenLastCalledWith('qr');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Search' }), { key: 'End' });
    expect(p.setAddFriendsTab).toHaveBeenLastCalledWith('qr');
  });

  test('the chosen segment is white in light and cream in dark, with navy words, from the stylesheet', () => {
    expect(CSS).toMatch(/\.af-seg-tab\[aria-selected="true"\] \{\s*background: #ffffff;\s*color: #1e293b;\s*\}/);
    expect(CSS).toMatch(/\[data-theme="dark"\] \.af-seg-tab\[aria-selected="true"\] \{\s*background: #f1ede0;\s*\}/);
    // The keyboard ring on the navy header is near-white.
    expect(CSS).toMatch(/\.af-on-navy:focus-visible \{\s*outline-color: rgba\(255, 255, 255, 0\.9\);\s*\}/);
  });

  test('Invite, in the header on every tab, shares the code and waits for it', () => {
    const { p, unmount } = draw({ addFriendsTab: 'qr' });
    fireEvent.click(screen.getByRole('button', { name: 'Invite a friend' }));
    expect(p.handleInviteFriend).toHaveBeenCalledTimes(1);
    unmount();
    const waiting = draw({ addFriendsTab: 'qr', myFriendCode: '', myFriendCodeQr: '' });
    expect(screen.getByRole('button', { name: 'Invite a friend' })).toBeDisabled();
    expect(waiting.p.handleInviteFriend).not.toHaveBeenCalled();
  });

  test('an unconfirmed email is said once, at the top of whichever tab is open', () => {
    const Line = () => React.createElement('p', null, 'Confirm your email to start a flock or add friends.');
    ['username', 'requests', 'contacts', 'qr'].forEach((tab) => {
      const { unmount } = draw({ addFriendsTab: tab, emailUnconfirmed: true, EmailConfirmLine: Line });
      expect(screen.getAllByText('Confirm your email to start a flock or add friends.')).toHaveLength(1);
      expect(panel().firstElementChild.textContent).toBe('Confirm your email to start a flock or add friends.');
      unmount();
    });
    draw({ emailUnconfirmed: false, EmailConfirmLine: Line });
    expect(screen.queryByText('Confirm your email to start a flock or add friends.')).toBeNull();
  });

  test('a line handed over as an element is drawn as it came', () => {
    draw({ emailUnconfirmed: true, EmailConfirmLine: React.createElement('p', null, 'Bound to this session') });
    expect(screen.getByText('Bound to this session')).toBeInTheDocument();
  });
});

describe('Search', () => {
  test('requests are drawn on the Requests tab and nowhere else', () => {
    const people = { pendingRequests: [{ id: 1, name: 'Priya Shah' }], outgoingRequests: [{ id: 2, name: 'Tobias Reed' }] };
    ['username', 'contacts', 'qr'].forEach((tab) => {
      const { unmount } = draw({ ...people, addFriendsTab: tab });
      expect(screen.queryByText('Wants to add you')).toBeNull();
      expect(screen.queryByText('Priya Shah')).toBeNull();
      expect(screen.queryByText('Tobias Reed')).toBeNull();
      unmount();
    });
    draw({ ...people, addFriendsTab: 'requests' });
    expect(screen.getByRole('heading', { name: 'Wants to add you' })).toBeInTheDocument();
    expect(screen.getByText('Priya Shah')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sent' })).toBeInTheDocument();
    expect(screen.getByText('Tobias Reed')).toBeInTheDocument();
  });

  test('the field is the first thing on the tab, and it stays at the top of the scroller', () => {
    draw();
    const sticky = panel().firstElementChild.firstElementChild;
    expect(sticky).toHaveAttribute('data-kb-keep', 'top');
    expect(sticky.style.position).toBe('sticky');
    expect(['0', '0px']).toContain(sticky.style.top);
    expect(within(sticky).getByLabelText('Search by name')).toHaveAttribute('placeholder', 'Search by name');
  });

  test('while a query is typed, the results come straight under the field, with nothing between', () => {
    draw({
      addFriendsSearch: 'ma',
      addFriendsResults: [{ id: 4, name: 'Maya Brooks' }, { id: 5, name: 'Mateo Ruiz' }],
      pendingRequests: [{ id: 9, name: 'Priya Shah' }],
      friendSuggestions: [{ id: 3, name: 'Sam Ortiz', mutual_count: 1 }],
    });
    const [field, results, ...rest] = Array.from(panel().firstElementChild.children);
    expect(within(field).getByLabelText('Search by name')).toBeInTheDocument();
    expect(within(results).getByText('Maya Brooks')).toBeInTheDocument();
    expect(within(results).getByText('Mateo Ruiz')).toBeInTheDocument();
    expect(rest).toHaveLength(0);
    expect(screen.queryByText('People you may know')).toBeNull();
  });

  test('with nothing typed, the people Quick Add used to hold are here, under People you may know', () => {
    const { p } = draw({ friendSuggestions: [{ id: 3, name: 'Sam Ortiz', mutual_count: 1 }, { id: 4, name: 'Ana Lima', shared_flocks: 2 }] });
    expect(screen.getByRole('heading', { name: 'People you may know' })).toBeInTheDocument();
    expect(screen.getByText('1 mutual friend')).toBeInTheDocument();
    expect(screen.getByText('2 plans together')).toBeInTheDocument();
    expect(screen.queryByText('Find people you know')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Sam Ortiz' }));
    expect(p.handleSendFriendRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
  });

  test('a failed read of the suggestions is said with a retry, and the empty state waits', () => {
    const { p } = draw({ friendSuggestionsError: 'Quick Add is not loading right now.' });
    expect(screen.getByText('Quick Add is not loading right now.')).toBeInTheDocument();
    expect(screen.queryByText('Find people you know')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.loadAddFriendsData).toHaveBeenCalledTimes(1);
  });

  test('a failed search says so in the server\'s words, with a Try again that runs it again', () => {
    const { p } = draw({ addFriendsSearch: 'Maya', addFriendsError: 'Search is not responding. Try again in a moment.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Search is not responding. Try again in a moment.');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Try again' }));
    expect(p.handleAddFriendsSearch).toHaveBeenCalledWith('Maya');
  });

  test('a space is not a search: the tab shows what it shows before anything is typed', () => {
    draw({ addFriendsSearch: ' ' });
    expect(screen.getByText('Find people you know')).toBeInTheDocument();
  });

  test('Return puts the keys away, and the field asks for no autocorrect on a name', () => {
    draw();
    const field = screen.getByLabelText('Search by name');
    expect(field).toHaveAttribute('enterkeyhint', 'search');
    expect(field).toHaveAttribute('autocorrect', 'off');
    expect(field).toHaveAttribute('autocapitalize', 'none');
    expect(field).toHaveAttribute('spellcheck', 'false');
    act(() => { field.focus(); });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(document.activeElement).not.toBe(field);
  });

  test('an Enter that finishes a composed word is not Return', () => {
    draw();
    const field = screen.getByLabelText('Search by name');
    act(() => { field.focus(); });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(document.activeElement).toBe(field);
  });

  test('each row says who the person is to you: Accept for someone who asked, Friends, Pending, or Add', () => {
    const { p } = draw({
      addFriendsSearch: 'a',
      addFriendsResults: [{ id: 1, name: 'Ana' }, { id: 2, name: 'Bo' }, { id: 3, name: 'Cy' }, { id: 4, name: 'Di' }],
      pendingRequests: [{ id: 1, name: 'Ana' }],
      friendStatuses: { 2: 'accepted', 3: 'pending' },
    });
    fireEvent.click(screen.getByRole('button', { name: "Accept Ana's friend request" }));
    expect(p.handleAcceptFriendRequest).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('button', { name: 'Add Ana' })).toBeNull();
    expect(screen.getByText('Friends')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Di' }));
    expect(p.handleSendFriendRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Message Bo' }));
    expect(p.setCurrentScreen).toHaveBeenCalledWith('main');
    expect(p.startNewDmWithUser).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  test('the face opens the person card', () => {
    const { p } = draw({ addFriendsSearch: 'a', addFriendsResults: [{ id: 1, name: 'Ana', profile_image_url: 'data:image/png;base64,x' }] });
    fireEvent.click(screen.getByRole('button', { name: 'About Ana' }));
    expect(p.openUserProfile).toHaveBeenCalledWith({ id: 1, name: 'Ana', image: 'data:image/png;base64,x' });
  });
});

describe('Requests', () => {
  test('Accept and Decline answer on the tap', () => {
    const { p } = draw({ addFriendsTab: 'requests', pendingRequests: [{ id: 1, name: 'Priya Shah' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Accept friend request' }));
    expect(p.handleAcceptFriendRequest).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Decline friend request' }));
    expect(p.handleDeclineFriendRequest).toHaveBeenCalledWith(1);
  });

  test('a request declined in the last few seconds stays in its place, saying so, with its own Undo', () => {
    // On the row rather than a toast: the toast has one slot, and the next
    // toast took the Undo away while the decline still went out.
    const p = props({
      addFriendsTab: 'requests',
      pendingRequests: [{ id: 1, name: 'Ava' }, { id: 3, name: 'Cy' }],
      decliningRequests: [{ id: 2, name: 'Bo', profile_image_url: null, at: 1 }],
      requestsTabBadge: 2,
    });
    const { rerender } = render(React.createElement(AddFriends, p));
    const faces = within(panel()).getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    expect(faces).toEqual(['About Ava', 'About Bo', 'About Cy']);
    expect(screen.getByText('Declined.')).toBeInTheDocument();
    // Bo's row offers only the Undo; the other two keep Accept and Decline.
    expect(screen.getAllByRole('button', { name: 'Accept friend request' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Undo declining Bo' }));
    expect(p.handleUndoDecline).toHaveBeenCalledWith(2);
    // Said to a screen reader in a region that was already there.
    expect(screen.getByText("Declined Bo's request. Undo is on the row for a few seconds.")).toHaveAttribute('role', 'status');
    // Its window over, the row goes, and the region empties.
    rerender(React.createElement(AddFriends, { ...p, decliningRequests: [] }));
    expect(screen.queryByText('Declined.')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  test('several declined in a row each keep their own Undo, in their own places', () => {
    // Ava, Bo and Cy, declined in that order from the top.
    const { p } = draw({
      addFriendsTab: 'requests',
      pendingRequests: [{ id: 4, name: 'Di' }],
      decliningRequests: [{ id: 1, name: 'Ava', at: 0 }, { id: 2, name: 'Bo', at: 0 }, { id: 3, name: 'Cy', at: 0 }],
    });
    const faces = within(panel()).getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    expect(faces).toEqual(['About Ava', 'About Bo', 'About Cy', 'About Di']);
    expect(screen.getAllByText('Declined.')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Undo declining Ava' }));
    expect(p.handleUndoDecline).toHaveBeenCalledWith(1);
  });

  test('a declined row is not an empty inbox', () => {
    draw({ addFriendsTab: 'requests', decliningRequests: [{ id: 2, name: 'Bo', at: 0 }] });
    expect(screen.getByRole('heading', { name: 'Wants to add you' })).toBeInTheDocument();
    expect(screen.queryByText('No requests right now')).toBeNull();
  });

  test('a sent request reads Pending and can be cancelled', () => {
    const { p } = draw({ addFriendsTab: 'requests', outgoingRequests: [{ id: 2, name: 'Tobias Reed' }] });
    expect(screen.getByText('Pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel your request to Tobias Reed' }));
    expect(p.handleCancelOutgoingRequest).toHaveBeenCalledWith(2);
  });

  test('Sent waits in its own shape until its read answers, and is not called empty meanwhile', () => {
    draw({ addFriendsTab: 'requests', outgoingRequestsLoaded: false });
    expect(screen.getByRole('heading', { name: 'Sent' })).toBeInTheDocument();
    expect(screen.getByText('Loading the requests you sent')).toBeInTheDocument();
    expect(screen.queryByText('No requests right now')).toBeNull();
  });

  test('nothing either way is said, with the way to Search', () => {
    const { p } = draw({ addFriendsTab: 'requests' });
    expect(screen.getByText('No requests right now')).toBeInTheDocument();
    expect(screen.getByText('When someone adds you, it shows up here.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search for people' }));
    expect(p.setAddFriendsTab).toHaveBeenCalledWith('username');
  });

  test('a failed read is said here with a retry, never as no requests, and not on the other tabs', () => {
    const error = 'Your friend requests are not loading right now.';
    const { p, unmount } = draw({ addFriendsTab: 'requests', pendingRequestsError: error });
    expect(screen.getByText(error)).toBeInTheDocument();
    expect(screen.queryByText('No requests right now')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.loadAddFriendsData).toHaveBeenCalledTimes(1);
    unmount();
    draw({ pendingRequestsError: error });
    expect(screen.queryByText(error)).toBeNull();
  });
});

describe('QR code', () => {
  test('the code is drawn as the server says (here its link), on a white tile, with the quiet zone and dark modules, in both themes', async () => {
    for (const [theme, colors] of [['light', LIGHT], ['dark', DARK]]) {
      document.documentElement.setAttribute('data-theme', theme);
      mockQrDrawn.length = 0;
      const { unmount } = draw({ addFriendsTab: 'qr', colors, myFriendCode: 'FLOCK-NJQXUGUM', myFriendCodeQr: 'https://www.flockcorp.com/add/FLOCK-NJQXUGUM' });
      await screen.findByTestId('qr');
      const qr = mockQrDrawn[mockQrDrawn.length - 1];
      expect(qr.value).toBe('https://www.flockcorp.com/add/FLOCK-NJQXUGUM');
      expect(qr.level).toBe('M');
      expect(qr.marginSize).toBeGreaterThanOrEqual(4);
      // Never inverted, and never the theme's navy: the same ink on the same
      // paper in the dark theme as in the light one.
      expect(qr.bgColor).toBe('#ffffff');
      expect(qr.fgColor).toBe('#1e293b');
      expect(qr.size).toBeGreaterThanOrEqual(208);
      expect(qr.size).toBeLessThanOrEqual(240);
      expect(qr.title).toBe('QR code for FLOCK-NJQXUGUM');
      expect(screen.getByTestId('qr').parentElement.style.backgroundColor).toBe('rgb(255, 255, 255)');
      unmount();
    }
  });

  test('until the server switches to the link, the QR carries the JSON every build reads, and nobody is sent to their camera', async () => {
    // The scanner in the builds already on phones (1.0.3 and older) reads
    // JSON and nothing else, so a link would be "Not a valid Flock QR code"
    // to every friend who has not updated.
    const json = '{"type":"flock_friend","code":"FLOCK-NJQXUGUM"}';
    mockQrDrawn.length = 0;
    draw({ addFriendsTab: 'qr', myFriendCode: 'FLOCK-NJQXUGUM', myFriendCodeQr: json });
    await screen.findByTestId('qr');
    expect(mockQrDrawn[mockQrDrawn.length - 1].value).toBe(json);
    expect(screen.getByText('Friends can scan this in Flock.')).toBeInTheDocument();
    expect(screen.queryByText(/phone camera/)).toBeNull();
  });

  test('a QR text that does not read back to the code, or none at all, draws the JSON for the code on screen', async () => {
    const json = '{"type":"flock_friend","code":"FLOCK-NJQXUGUM"}';
    for (const qr of ['', 'https://www.flockcorp.com/add/FLOCK-KP5ETGZF', 'https://example.com/add/FLOCK-NJQXUGUM', '{"type":"flock_friend","code":"FLOCK-KP5ETGZF"}']) {
      mockQrDrawn.length = 0;
      const { unmount } = draw({ addFriendsTab: 'qr', myFriendCode: 'FLOCK-NJQXUGUM', myFriendCodeQr: qr });
      // eslint-disable-next-line no-await-in-loop
      await screen.findByTestId('qr');
      expect([qr, mockQrDrawn[mockQrDrawn.length - 1].value]).toEqual([qr, json]);
      unmount();
    }
  });

  test('whose code it is, and what a friend does with it', () => {
    draw({ addFriendsTab: 'qr' });
    expect(screen.getByText('Casey Crawler')).toBeInTheDocument();
    expect(screen.getByText('Friends can scan this with their phone camera.')).toBeInTheDocument();
  });

  test('the code chip copies the code, and says so once it has', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { p } = draw({ addFriendsTab: 'qr' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy your code, FLOCK-AB12CD34' }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('FLOCK-AB12CD34');
    expect(p.showToast).toHaveBeenCalledWith('Code copied.');
    delete window.navigator.clipboard;
  });

  test('Share sends the link, and Scan opens the scanner, which is not drawn inside this screen', () => {
    const { p, container } = draw({ addFriendsTab: 'qr' });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(p.handleShareMyCode).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: "Scan a friend's code" }));
    expect(p.openQrScanner).toHaveBeenCalledTimes(1);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByText(/Point your camera/)).toBeNull();
  });

  test('the code box takes a pasted link or a whole invite, and asks for capitals with no autocorrect', () => {
    draw({ addFriendsTab: 'qr' });
    const box = screen.getByLabelText('Friend code');
    expect(Number(box.getAttribute('maxlength'))).toBe(64);
    expect(box).toHaveAttribute('placeholder', 'FLOCK-XXXXXXXX');
    expect(box).toHaveAttribute('enterkeyhint', 'go');
    expect(box).toHaveAttribute('autocapitalize', 'characters');
    expect(box).toHaveAttribute('autocorrect', 'off');
    expect(box).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByRole('heading', { name: 'Have a code?' })).toBeInTheDocument();
  });

  test('Return sends what the box holds and puts the keys away', () => {
    const { p } = draw({ addFriendsTab: 'qr' });
    const box = screen.getByLabelText('Friend code');
    act(() => { box.focus(); });
    fireEvent.change(box, { target: { value: 'FLOCK-ZZ99YY88' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(p.handleAddByCode).toHaveBeenCalledWith('FLOCK-ZZ99YY88');
    expect(document.activeElement).not.toBe(box);
  });

  test('Add sends the box\'s own value, not one a keystroke old, and puts the keys away', () => {
    const { p } = draw({ addFriendsTab: 'qr', friendCodeInput: 'FLOCK-ZZ99' });
    const box = screen.getByLabelText('Friend code');
    act(() => { box.focus(); });
    fireEvent.change(box, { target: { value: 'FLOCK-ZZ99YY88' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(p.handleAddByCode).toHaveBeenCalledWith('FLOCK-ZZ99YY88');
    expect(document.activeElement).not.toBe(box);
  });

  test('the scanner\'s Type the code instead puts the caret in the code box', () => {
    const p = props({ addFriendsTab: 'qr' });
    const { rerender } = render(React.createElement(AddFriends, p));
    const box = screen.getByLabelText('Friend code');
    expect(document.activeElement).not.toBe(box);
    rerender(React.createElement(AddFriends, { ...p, focusCodeFieldRequest: 1 }));
    expect(document.activeElement).toBe(box);
  });

  test('from another tab it opens the QR code tab first', () => {
    const p = props({ addFriendsTab: 'username' });
    const { rerender } = render(React.createElement(AddFriends, p));
    rerender(React.createElement(AddFriends, { ...p, focusCodeFieldRequest: 1 }));
    expect(p.setAddFriendsTab).toHaveBeenCalledWith('qr');
    rerender(React.createElement(AddFriends, { ...p, focusCodeFieldRequest: 1, addFriendsTab: 'qr' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Friend code'));
  });

  test('arriving on the screen focuses nothing by itself', () => {
    draw({ addFriendsTab: 'qr', focusCodeFieldRequest: 4 });
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Contacts', () => {
  const contacts = (over) => draw({ addFriendsTab: 'contacts', ...over });

  test('before the tap: the explanation and one Continue, and only the tap asks', () => {
    const { p } = contacts();
    expect(p.handleSyncContacts).not.toHaveBeenCalled();
    const card = screen.getByRole('heading', { name: 'Find friends from your contacts' }).parentElement;
    expect(within(card).getAllByRole('button')).toHaveLength(1);
    expect(within(card).queryByText(/Not now|Cancel/)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Continue' }));
    expect(p.handleSyncContacts).toHaveBeenCalledTimes(1);
  });

  test('a check refused before it checked anything says only when it can go, and Continue waits for then', () => {
    // No result: nothing was checked, so "None of these numbers belong to
    // someone..." would be a claim about numbers nobody looked at.
    jest.useFakeTimers();
    try {
      const contactsRetryAt = new Date(Date.now() + 60 * 1000).toISOString();
      contacts({ contactsRetryAt });
      expect(screen.getByRole('heading', { name: 'Find friends from your contacts' })).toBeInTheDocument();
      expect(screen.queryByText(/None of these numbers/)).toBeNull();
      expect(screen.queryByText(/^Checked /)).toBeNull();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      expect(screen.getByText(/^You can check again after .+\.$/)).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(61 * 1000); });
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
      expect(screen.queryByText(/You can check again after/)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a time that has passed holds nothing back', () => {
    contacts({ contactsRetryAt: new Date(Date.now() - 1000).toISOString() });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('an unconfirmed email is asked to confirm first, and the system prompt is not offered', () => {
    contacts({ emailUnconfirmed: true });
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByText('Once your email is confirmed, you can check your contacts here.')).toBeInTheDocument();
  });

  test('refused, in the app: where the switch is, Open Settings, and Try again', () => {
    const handleOpenAppSettings = jest.fn();
    const { p } = contacts({ contactsDenied: true, contactsPermission: 'denied', handleOpenAppSettings });
    expect(screen.getByText('Contacts are off for Flock')).toBeInTheDocument();
    expect(screen.getByText(/You can turn it on in Settings, under Flock/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(handleOpenAppSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.handleSyncContacts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  test('refused, on the web: no Settings button and no Settings sentence', () => {
    contacts({ contactsPermission: 'denied' });
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
    expect(screen.queryAllByText(/under Flock/)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('a fresh reading of the permission wins over a refusal earlier in the session', () => {
    contacts({ contactsDenied: true, contactsPermission: 'granted' });
    expect(screen.queryByText('Contacts are off for Flock')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  test('in the app, when iOS will ask again, the only door is the card that explains it, never a Try again', () => {
    // A prompt that closed without an answer reads as a refusal to the check
    // that raised it, while iOS still holds the question open. Try again on
    // the refused card would raise the system dialog with nothing in front.
    const { unmount } = contacts({ contactsDenied: true, contactsPermission: 'prompt', handleOpenAppSettings: jest.fn() });
    expect(screen.queryByText('Contacts are off for Flock')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    unmount();
    contacts({ contactsUnavailable: true, contactsPermission: 'prompt', handleOpenAppSettings: jest.fn() });
    expect(screen.queryByText("Couldn't open your contacts")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  test('on the web, where the browser asks every time, a refusal stands as it was', () => {
    contacts({ contactsDenied: true, contactsPermission: 'prompt' });
    expect(screen.getByText('Contacts are off for Flock')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  test('a contacts service that cannot be reached is not a refusal, and sends nobody to Settings', () => {
    const { p } = contacts({ contactsUnavailable: true, contactsPermission: 'unavailable', handleOpenAppSettings: jest.fn() });
    expect(screen.getByText("Couldn't open your contacts")).toBeInTheDocument();
    expect(screen.queryByText('Contacts are off for Flock')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Settings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.handleSyncContacts).toHaveBeenCalledTimes(1);
  });

  test('a whole book: how many were checked, and the ones that could not be read, said apart', () => {
    contacts({ contactsResult: result({ checked: 203, total: 212, sent: 212, unreadable: 9 }), contactsUsers: [{ id: 1, name: 'Ana' }] });
    expect(screen.getByText("Checked 203 numbers. 9 couldn't be read as phone numbers.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(screen.queryAllByText(/in an hour/)).toHaveLength(0);
  });

  test('a big book: how far the checks have got, and the next batch to check', () => {
    const { p } = contacts({ contactsResult: result({ checked: 595, total: 1240, sent: 600, unreadable: 5, notReached: 640 }), contactsUsers: [{ id: 1, name: 'Ana' }] });
    expect(screen.getByText("Checked 600 of 1,240 numbers. 5 couldn't be read as phone numbers.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check the next 600' }));
    expect(p.handleSyncContacts).toHaveBeenCalledTimes(1);
  });

  test('a later run of a big book counts from the start of the book, and names what is left', () => {
    contacts({ contactsResult: result({ checked: 600, total: 1240, sent: 600, notReached: 40 }), contactsUsers: [{ id: 1, name: 'Ana' }] });
    expect(screen.getByText('Checked 1,200 of 1,240 numbers.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check the next 40' })).toBeInTheDocument();
  });

  test('counts of one take their singular', () => {
    contacts({ contactsResult: result({ checked: 1, total: 2, sent: 2, unreadable: 1 }) });
    expect(screen.getByText("Checked 1 number. 1 couldn't be read as a phone number.")).toBeInTheDocument();
  });

  test('iOS 18 limited access is said in one line, with the way to change it in the app', () => {
    const { unmount } = contacts({ contactsResult: result({ checked: 5, total: 5, sent: 5, contactCount: 5, permission: 'limited' }) });
    expect(screen.getByText('You shared 5 contacts with Flock.')).toBeInTheDocument();
    unmount();
    const one = contacts({ contactsResult: result({ checked: 1, total: 1, sent: 1, contactCount: 1, permission: 'limited' }) });
    expect(screen.getByText('You shared 1 contact with Flock.')).toBeInTheDocument();
    one.unmount();
    const handleOpenAppSettings = jest.fn();
    contacts({ contactsResult: result({ total: 0, contactCount: 0, permission: 'limited' }), handleOpenAppSettings });
    expect(screen.getByText(/You haven't shared any contacts with Flock\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change in Settings' }));
    expect(handleOpenAppSettings).toHaveBeenCalledTimes(1);
  });

  test('a spent allowance says when the next check can run, and the button waits for it', () => {
    const retryAt = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    contacts({ contactsResult: result({ checked: 595, total: 900, sent: 600, notReached: 300, throttled: true, retryAt }), contactsUsers: [{ id: 1, name: 'Ana' }] });
    expect(screen.getByText(/^You can check again after .+\.$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check the next 300' })).toBeDisabled();
  });

  test('the button wakes by itself when that time comes', () => {
    jest.useFakeTimers();
    try {
      const retryAt = new Date(Date.now() + 60 * 1000).toISOString();
      contacts({ contactsResult: result({ checked: 10, total: 10, sent: 10, throttled: true, retryAt }) });
      expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
      act(() => { jest.advanceTimersByTime(61 * 1000); });
      expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
      expect(screen.queryByText(/You can check again after/)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('nobody matched is said as what the server knows, never as "not on Flock", with the invite beside it', () => {
    const { p } = contacts({ contactsResult: result({ checked: 50, total: 50, sent: 50 }) });
    expect(screen.getByText('None of these numbers belong to someone who turned on being found by their number.')).toBeInTheDocument();
    expect(screen.getByText('Checked 50 numbers.')).toBeInTheDocument();
    expect(screen.queryAllByText(/are on Flock yet|is not on Flock yet/)).toHaveLength(0);
    fireEvent.click(within(panel()).getAllByRole('button', { name: /Invite a friend/ })[0]);
    expect(p.handleInviteFriend).toHaveBeenCalledTimes(1);
  });

  test('a book with no number Flock can read says that, whether it held none or none it could read', () => {
    const { unmount } = contacts({ contactsResult: result({ total: 0 }) });
    expect(screen.getByText('None of your contacts have a phone number Flock can check. Add someone by their number below.')).toBeInTheDocument();
    unmount();
    contacts({ contactsResult: result({ checked: 0, total: 3, sent: 3, unreadable: 3 }) });
    expect(screen.getByText('None of your contacts have a phone number Flock can check. Add someone by their number below.')).toBeInTheDocument();
    expect(screen.getByText("3 couldn't be read as phone numbers.")).toBeInTheDocument();
  });

  test('matches: Flock names in order, an honest line, and Accept for someone who already asked you', () => {
    const { p } = contacts({
      contactsResult: result({ checked: 3, total: 3, sent: 3 }),
      contactsUsers: [{ id: 2, name: 'Zed' }, { id: 1, name: 'Ana', friendship_status: 'incoming' }, { id: 3, name: 'Bo', friendship_status: 'pending' }],
    });
    const faces = within(panel()).getAllByRole('button', { name: /^About / }).map((b) => b.getAttribute('aria-label'));
    expect(faces).toEqual(['About Ana', 'About Bo', 'About Zed']);
    expect(screen.getAllByText('Uses a number from your contacts')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: "Accept Ana's friend request" }));
    expect(p.handleAcceptFriendRequest).toHaveBeenCalledWith(1);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Zed' }));
    expect(p.handleSendFriendRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  describe('Let friends find you', () => {
    test('offered while it is off; the switch moves on the tap and holds still until the server answers', async () => {
      let finish;
      const handleTogglePhoneDiscovery = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
      contacts({ phoneDiscoverable: false, phoneOnFile: true, handleTogglePhoneDiscovery });
      expect(screen.getByRole('heading', { name: 'Let friends find you' })).toBeInTheDocument();
      const toggle = screen.getByRole('switch', { name: 'Let friends find me by my phone number' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      // Opt-in only: drawing it turned nothing on.
      expect(handleTogglePhoneDiscovery).not.toHaveBeenCalled();
      fireEvent.click(toggle);
      expect(handleTogglePhoneDiscovery).toHaveBeenCalledWith(true);
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toggle).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(toggle);
      expect(handleTogglePhoneDiscovery).toHaveBeenCalledTimes(1);
      await act(async () => { finish(); });
      expect(toggle).not.toHaveAttribute('aria-busy');
    });

    test('it stays on screen once turned on, for the rest of the visit', () => {
      const p = props({ addFriendsTab: 'contacts', phoneDiscoverable: false, phoneOnFile: true });
      const { rerender } = render(React.createElement(AddFriends, p));
      rerender(React.createElement(AddFriends, { ...p, phoneDiscoverable: true }));
      expect(screen.getByRole('switch', { name: 'Let friends find me by my phone number' })).toHaveAttribute('aria-checked', 'true');
    });

    test('not offered once it is on, or before it has been read', () => {
      const { unmount } = contacts({ phoneDiscoverable: true, phoneOnFile: true });
      expect(screen.queryByText('Let friends find you')).toBeNull();
      unmount();
      contacts({ phoneDiscoverable: null });
      expect(screen.queryByText('Let friends find you')).toBeNull();
    });

    test('with no number on the profile it offers the way to add one, not a switch that would be refused', () => {
      const { p } = contacts({ phoneDiscoverable: false, phoneOnFile: false });
      expect(screen.queryByRole('switch')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Add your number' }));
      expect(p.openEditProfile).toHaveBeenCalledTimes(1);
    });
  });

  describe('by number', () => {
    test('Look up hands over the number the box shows and puts the keypad away', () => {
      const { p } = contacts({ phoneLookupInput: '484555' });
      const box = screen.getByLabelText('Phone number');
      act(() => { box.focus(); });
      fireEvent.change(box, { target: { value: '4845550102' } });
      fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
      expect(p.handleLookupByNumber).toHaveBeenCalledWith('4845550102');
      expect(document.activeElement).not.toBe(box);
    });

    test('Return on a hardware keyboard does the same', () => {
      const { p } = contacts();
      const box = screen.getByLabelText('Phone number');
      act(() => { box.focus(); });
      fireEvent.change(box, { target: { value: '4845550102' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(p.handleLookupByNumber).toHaveBeenCalledWith('4845550102');
      expect(document.activeElement).not.toBe(box);
    });

    test('the answer: Flock names, or a line that does not call anyone "not on Flock"', () => {
      const { unmount } = contacts({ phoneLookupUsers: [{ id: 5, name: 'Maya Brooks' }] });
      expect(screen.getByText('Maya Brooks')).toBeInTheDocument();
      expect(screen.getByText('Matches the number you typed')).toBeInTheDocument();
      unmount();
      contacts({ phoneLookupUsers: [] });
      expect(screen.getByText('Nobody on Flock has that number, or they have not turned on being found by it.')).toBeInTheDocument();
    });
  });
});

describe('the scroller and the keyboard', () => {
  test('the scroller is the keyboard hook\'s box, and its last child is the hook\'s room, with no style of its own', () => {
    draw();
    const box = panel();
    expect(box).toHaveAttribute('data-kb-scroll');
    const room = box.lastElementChild;
    expect(room).toHaveAttribute('aria-hidden', 'true');
    expect(room.getAttribute('style')).toBeNull();
    expect(room.children).toHaveLength(0);
  });

  test('each field has the region that rises with it', () => {
    const first = draw();
    expect(screen.getByLabelText('Search by name').closest('[data-kb-keep]')).toHaveAttribute('data-kb-keep', 'top');
    first.unmount();
    const second = draw({ addFriendsTab: 'qr' });
    const code = screen.getByLabelText('Friend code').closest('[data-kb-keep]');
    expect(code.getAttribute('data-kb-keep')).toBe('');
    expect(within(code).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    second.unmount();
    draw({ addFriendsTab: 'contacts' });
    const phone = screen.getByLabelText('Phone number').closest('[data-kb-keep]');
    expect(phone.getAttribute('data-kb-keep')).toBe('');
    expect(within(phone).getByRole('button', { name: 'Look up' })).toBeInTheDocument();
  });

  test('each tab opens at its own top', () => {
    const p = props();
    const { rerender } = render(React.createElement(AddFriends, p));
    panel().scrollTop = 300;
    rerender(React.createElement(AddFriends, { ...p, addFriendsTab: 'qr' }));
    expect(panel().scrollTop).toBe(0);
  });

  test('with the keys up, the code box and its Add come up to 12pt above them', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 852 });
    window.matchMedia = () => ({ matches: true });
    try {
      draw({ addFriendsTab: 'qr' });
      const box = panel();
      const field = screen.getByLabelText('Friend code');
      const region = field.closest('[data-kb-keep]');
      const room = box.lastElementChild;
      // An iPhone 15 Pro: the box under the 149pt header, the region at 560 to
      // 640 in a 760pt tab, the field the region's last 44pt.
      Object.defineProperty(box, 'clientHeight', { configurable: true, value: 703 });
      Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 760 + (parseFloat(room.style.height) || 0) });
      box.getBoundingClientRect = () => ({ top: 149, bottom: 852 });
      room.getBoundingClientRect = () => ({ top: 149 + 760 - box.scrollTop, bottom: 149 + 760 - box.scrollTop + (parseFloat(room.style.height) || 0) });
      region.getBoundingClientRect = () => ({ top: 149 + 560 - box.scrollTop, bottom: 149 + 640 - box.scrollTop });
      field.getBoundingClientRect = () => ({ top: 149 + 596 - box.scrollTop, bottom: 149 + 640 - box.scrollTop });
      act(() => { field.focus(); });
      act(() => {
        const ev = document.createEvent('Events');
        ev.initEvent('keyboardWillShow', false, false);
        ev.keyboardHeight = 336;
        window.dispatchEvent(ev);
      });
      expect(region.getBoundingClientRect().bottom).toBe(852 - 336 - 12);
    } finally {
      delete window.matchMedia;
    }
  });
});
