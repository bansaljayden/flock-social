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
  // The requests read leaves out a request answered on this device whose
  // answer is still out, or written here since the read was asked for
  // (refreshFriendRequests), and clears its error.
  expect(app).toContain('.filter(r => !settling(r));');
  expect(app).toMatch(/setPendingRequests\(prev => \{\s*const kept = prev\.filter\(r => writtenSince\(r\.id\)\);\s*return kept\.length \? \[\.\.\.kept, \.\.\.rows\] : rows;\s*\}\);\s*setPendingRequestsError\(''\);/);
  expect(app).toContain("setFriendSuggestions(d.suggestions || []); setFriendSuggestionsError('');");
  // In the server's words when api.js wrote them for people (userMessage),
  // in the screen's own otherwise; never an error's raw text.
  expect(app).toContain("setPendingRequestsError(userMessage(e, 'Your friend requests are not loading right now.'))");
  expect(app).toContain("setFriendSuggestionsError(userMessage(e, 'Quick Add is not loading right now.'))");
});

test('the screen says the error, offers a retry, and suppresses the empty state while it stands', () => {
  const screenSrc = read('screens/AddFriends.js');
  expect(screenSrc).toContain('{pendingRequestsError && (');
  expect(screenSrc).toContain('{friendSuggestionsError && (');
  expect(screenSrc).toContain('{friendSuggestionsError ? null : friendSuggestions.length === 0 ? (');
  // Four retries: the requests error, the Sent list's, the Quick Add error,
  // and the friend code, which the server issues now and which can therefore
  // fail to load. All four reload through the same loadAddFriendsData.
  expect(screenSrc).toContain('{outgoingRequestsError && (');
  expect((screenSrc.match(/onClick=\{\(\) => loadAddFriendsData\(\)\}/g) || []).length).toBe(4);
  // Plain text for an error; the warm bird stays on the true-empty state only.
  const errBlock = screenSrc.slice(screenSrc.indexOf('{friendSuggestionsError && ('), screenSrc.indexOf('{friendSuggestionsError ? null'));
  expect(errBlock).not.toContain('BirdNote');
  expect(errBlock).not.toContain('\u2014');
});

test('a request the other person withdrew leaves the list on the 404 instead of re-toasting', () => {
  const app = read('App.js');
  const at = app.indexOf('const handleAcceptFriendRequest = useCallback(async (userId) => {');
  expect(at).toBeGreaterThan(-1);
  // Bounded on the handler's own closing line rather than a byte count, so a
  // comment added inside it cannot push a checked line out of the window.
  const end = app.indexOf('}, [pendingRequests, showToast, needsEmailVerification, applyRelationship]);', at);
  expect(end).toBeGreaterThan(at);
  const handler = app.slice(at, end);
  expect(handler).toContain('if (err?.status === 404) {');
  expect(handler).toContain('setPendingRequests(prev => prev.filter(r => r.id !== userId));');
  expect(handler).toContain("showToast('That request was withdrawn.');");
});

test('the friend code is asked of the server, and a failed ask is remembered for the screen', () => {
  const app = read('App.js');
  // Every load of the screen, and every Try again, asks through
  // loadMyFriendCode, which is the one read of the code.
  const loadAt = app.indexOf('const loadAddFriendsData = useCallback(async () => {');
  expect(loadAt).toBeGreaterThan(-1);
  expect(app.slice(loadAt, app.indexOf('\n  }, [', loadAt))).toContain('loadMyFriendCode();');
  const at = app.indexOf('const loadMyFriendCode = useCallback(() => {');
  expect(at).toBeGreaterThan(-1);
  const load = app.slice(at, app.indexOf('\n  }, [authUser?.id]);', at));

  // Asked for, never worked out. backend friendCodeAgreement.test.js sweeps
  // every frontend file for a derivation; this pins the one read that
  // replaced it.
  expect(load).toContain('getMyFriendCode()');
  expect(load).not.toMatch(/'FLOCK-'\s*\+/);
  expect(load).not.toMatch(/toString\(36\)/);

  // Both ways the read can fail set the flag, an answer with no code in it and
  // a request that threw, but only when there is no code on screen at all: the
  // code never changes once issued, so the one already drawn (kept on the
  // device, per account) stays drawn through a failed refresh.
  expect(load).toMatch(/if \(!code\) \{\s*if \(!myFriendCodeRef\.current\) setMyFriendCodeFailed\(true\);/);
  expect(load).toMatch(/\.catch\(\(e\) => \{[^}]*if \(!myFriendCodeRef\.current\) setMyFriendCodeFailed\(true\);/);
  // The flag is cleared before the read goes out, so a retry is a spinner
  // again rather than the old error.
  expect(load.indexOf('setMyFriendCodeFailed(false);')).toBeGreaterThan(-1);
  expect(load.indexOf('setMyFriendCodeFailed(false);')).toBeLessThan(load.indexOf('getMyFriendCode()'));
  // The code is never blanked for a read any more. What keeps a different
  // account from seeing the last one's is the copy on the device, which is
  // only read for the account it was written for.
  expect(load).not.toContain("setMyFriendCode('');");
  expect(load).toContain('localStorage.setItem(FRIEND_CODE_CACHE_KEY, JSON.stringify({ userId, code, url, qr }))');
  expect(app).toMatch(/if \(!saved \|\| !authUser\?\.id \|\| String\(saved\.userId\) !== String\(authUser\.id\)\) return null;/);

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
    EmailConfirmLine: () => null,
    ListSkeleton: () => null,
    // The real box keeps its own state and commits on a pause; the tab only
    // needs an input to be there.
    SearchInputLocal: ({ initialValue, onCommit, transform, inputRef, ...rest }) => React.createElement('input', { ...rest, ref: inputRef, defaultValue: initialValue }),
    addFriendsError: '',
    addFriendsResults: [],
    addFriendsSearch: '',
    addFriendsSearching: false,
    addFriendsTab: 'qr',
    colors: { navy: '#0d2847', navyBg: '#0d2847', cream: '#f4ede4', creamDark: '#e5dccd', borderDefault: '#d6d6d6', amber: '#d97706', redText: '#b91c1c' },
    confirmClick: noop,
    contactsDenied: false,
    contactsLoading: false,
    contactsPermission: null,
    contactsResult: null,
    contactsRetryAt: null,
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
    handleInviteFriend: noop,
    handleLookupByNumber: noop,
    handleOpenAppSettings: undefined,
    handleSendFriendRequest: noop,
    handleShareMyCode: noop,
    handleSyncContacts: noop,
    handleTogglePhoneDiscovery: noop,
    handleUndoDecline: noop,
    loadAddFriendsData: jest.fn(),
    myFriendCode: '',
    myFriendCodeFailed: false,
    myFriendCodeQr: '',
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
    phoneLookupUsers: [],
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
