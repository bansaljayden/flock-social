/**
 * ADD FRIENDS: A FAILED READ IS NOT AN EMPTY LIST (friends audit, 2026-09-05).
 * Source pins for the error states, their retries, and the withdrawn request
 * leaving the list on a 404. The friend code joined them when it became a
 * server read (migration 079): it used to be worked out on the client from the
 * user id, which could not fail and was every account's code for anyone who
 * could count. A read can fail, so the screen has to be able to say so.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test addFriendsErrors --watchAll=false
 */
const React = require('react');
const { render, screen, fireEvent } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

const AddFriends = require('../screens/AddFriends').default;

test('the two list reads keep their own error, cleared on a landed read', () => {
  const app = read('App.js');
  expect(app).toContain("const [pendingRequestsError, setPendingRequestsError] = useState('');");
  expect(app).toContain("const [friendSuggestionsError, setFriendSuggestionsError] = useState('');");
  expect(app).toContain("setPendingRequests(d.requests || []); setPendingRequestsError('');");
  expect(app).toContain("setFriendSuggestions(d.suggestions || []); setFriendSuggestionsError('');");
  expect(app).toMatch(/setPendingRequestsError\(e\?\.message \|\| 'Your friend requests are not loading right now\.'\)/);
  expect(app).toMatch(/setFriendSuggestionsError\(e\?\.message \|\| 'Quick Add is not loading right now\.'\)/);
});

test('the screen says the error, offers a retry, and suppresses the empty state while it stands', () => {
  const screenSrc = read('screens/AddFriends.js');
  expect(screenSrc).toContain('{pendingRequestsError && (');
  expect(screenSrc).toContain('{friendSuggestionsError && (');
  expect(screenSrc).toContain('{friendSuggestionsError ? null : friendSuggestions.length === 0 ? (');
  // Three retries: the requests error, the Quick Add error, and the friend
  // code, which the server issues now and which can therefore fail to load.
  // All three reload through the same loadAddFriendsData.
  expect((screenSrc.match(/onClick=\{\(\) => loadAddFriendsData\(\)\}/g) || []).length).toBe(3);
  // Plain text for an error; the warm bird stays on the true-empty state only.
  const errBlock = screenSrc.slice(screenSrc.indexOf('{friendSuggestionsError && ('), screenSrc.indexOf('{friendSuggestionsError ? null'));
  expect(errBlock).not.toContain('BirdNote');
  expect(errBlock).not.toContain('\u2014');
});

test('a request the other person withdrew leaves the list on the 404 instead of re-toasting', () => {
  const app = read('App.js');
  const at = app.indexOf('const handleAcceptFriendRequest = useCallback(async (userId) => {');
  expect(at).toBeGreaterThan(-1);
  const handler = app.slice(at, at + 1400);
  expect(handler).toContain('if (err?.status === 404) {');
  expect(handler).toContain('setPendingRequests(prev => prev.filter(r => r.id !== userId));');
  expect(handler).toContain("showToast('That request was withdrawn.');");
});

test('the friend code is asked of the server, and a failed ask is remembered for the screen', () => {
  const app = read('App.js');
  const at = app.indexOf('const loadAddFriendsData = useCallback(async () => {');
  expect(at).toBeGreaterThan(-1);
  const load = app.slice(at, app.indexOf('\n  }, [', at));

  // Asked for, never worked out. backend friendCodeAgreement.test.js sweeps
  // every frontend file for a derivation; this pins the one read that
  // replaced it.
  expect(load).toContain('getMyFriendCode()');
  expect(load).not.toMatch(/'FLOCK-'\s*\+/);
  expect(load).not.toMatch(/toString\(36\)/);

  // Both ways the read can fail set the flag: an answer with no code in it,
  // and a request that threw.
  expect(load).toContain('if (d?.code) setMyFriendCode(d.code); else setMyFriendCodeFailed(true);');
  expect(load).toMatch(/\.catch\(\(e\) => \{[^}]*setMyFriendCodeFailed\(true\);/);

  // Both are cleared before the read goes out, so a retry is a spinner again
  // rather than the old error, and a different account never sees the last
  // account's code while its own is on the way.
  const ask = load.indexOf('getMyFriendCode()');
  expect(load.indexOf("setMyFriendCode('');")).toBeGreaterThan(-1);
  expect(load.indexOf("setMyFriendCode('');")).toBeLessThan(ask);
  expect(load.indexOf('setMyFriendCodeFailed(false);')).toBeGreaterThan(-1);
  expect(load.indexOf('setMyFriendCodeFailed(false);')).toBeLessThan(ask);

  // And the flag reaches the screen.
  expect(app).toContain('const [myFriendCodeFailed, setMyFriendCodeFailed] = useState(false);');
  const propsAt = app.indexOf('const addFriendsProps = {');
  expect(propsAt).toBeGreaterThan(-1);
  const props = app.slice(propsAt, app.indexOf('};', propsAt));
  expect(props).toMatch(/\n\s*myFriendCodeFailed,\n/);
});

// ---------------------------------------------------------------------------
// The QR tab, rendered. Every prop the screen takes is supplied, so a prop it
// reads and does not receive is a crash here rather than a blank on a phone.
// ---------------------------------------------------------------------------
const noop = () => {};

function renderQrTab(overrides) {
  const props = {
    DialogBehavior: () => null,
    ListSkeleton: () => null,
    // The real box keeps its own state and commits on a pause; the tab only
    // needs an input to be there.
    SearchInputLocal: ({ initialValue, onCommit, transform, ...rest }) => React.createElement('input', { ...rest, defaultValue: initialValue }),
    BottomNav: () => null,
    addFriendsError: '',
    addFriendsResults: [],
    addFriendsSearch: '',
    addFriendsSearching: false,
    addFriendsTab: 'qr',
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
    loadAddFriendsData: jest.fn(),
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
  render(React.createElement(AddFriends, props));
  return props;
}

test('a code that did not load is said, with a retry, instead of a spinner that never ends', () => {
  const props = renderQrTab({ myFriendCodeFailed: true });
  const said = screen.getByText('Your code did not load.');
  expect(said.closest('[role="status"]')).not.toBeNull();
  // Nothing to scan or copy while it stands.
  expect(screen.queryByText('Your Code')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(props.loadAddFriendsData).toHaveBeenCalledTimes(1);
});

test('a code still on its way is neither an error nor a retry', () => {
  renderQrTab({ myFriendCodeFailed: false });
  expect(screen.queryByText('Your code did not load.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('the box for a friend\'s code shows the shape an issued code has', () => {
  renderQrTab({});
  const box = screen.getByLabelText('Friend code');
  expect(box.getAttribute('placeholder')).toBe('FLOCK-XXXXXXXX');
  // Fourteen characters, and the box takes them all.
  expect(Number(box.getAttribute('maxLength') || box.getAttribute('maxlength'))).toBeGreaterThanOrEqual('FLOCK-XXXXXXXX'.length);
});
