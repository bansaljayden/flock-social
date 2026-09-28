/**
 * A NEW ACCOUNT'S FIRST TRIP FROM THE NEST TO ADD FRIENDS LANDS ON CONTACTS,
 * WHERE THERE IS AN ADDRESS BOOK TO READ.
 *
 * Add friends opens on Search, and on a new app a name search finds almost
 * nobody a new account knows. Where the phone's contacts can be read, the
 * Contacts tab can find them in one tap, and its invite card covers the rest.
 *
 * What is pinned:
 *   1. openAddFriendsFromNest, lifted out of App.js and executed: it picks
 *      Contacts only for a friend count that came back zero, only where the
 *      tab exists, only before a refusal this session, and only once.
 *   2. Both of the Nest's Add friends buttons go through it.
 *   3. Nothing else moved: the screen's own default is still Search, and the
 *      other ways in (Settings, Explore's See All) still open where they did.
 *
 * HomeScreen is declared inside FlockAppInner and cannot be rendered on its
 * own, so the handler is lifted by exact anchors, which break loudly if it
 * changes shape rather than testing a stale copy.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test addFriendsFirstOpenOnContacts --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');

const OPEN = 'const openAddFriendsFromNest = () => {';
const BODY = (() => {
  const start = APP.indexOf(OPEN);
  if (start === -1) throw new Error('lift: openAddFriendsFromNest moved');
  const end = APP.indexOf('\n  };', start);
  if (end === -1) throw new Error('lift: the end of openAddFriendsFromNest moved');
  return APP.slice(start + OPEN.length, end);
})();

function scope(over = {}) {
  return {
    addFriendsOpenedFromNest: { current: false },
    friendCount: 0,
    contactsSupported: true,
    contactsDenied: false,
    setAddFriendsTab: jest.fn(),
    setCurrentScreen: jest.fn(),
    ...over,
  };
}

function makeOpen(s) {
  const names = Object.keys(s);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return () => {${BODY}\n};`)(...names.map((n) => s[n]));
}

describe('openAddFriendsFromNest, lifted out of App.js and executed', () => {
  test('the lift found the real handler', () => {
    expect(BODY).toContain("setAddFriendsTab('contacts')");
    expect(BODY).toContain("setCurrentScreen('addFriends')");
  });

  test('an account with no friends, on a phone whose contacts can be read, opens on Contacts', () => {
    const s = scope();
    makeOpen(s)();
    expect(s.setAddFriendsTab).toHaveBeenCalledWith('contacts');
    expect(s.setCurrentScreen).toHaveBeenCalledWith('addFriends');
  });

  test('only the first time: after that the tab is wherever the person left it', () => {
    const s = scope();
    const open = makeOpen(s);
    open();
    open();
    expect(s.setAddFriendsTab).toHaveBeenCalledTimes(1);
    expect(s.setCurrentScreen).toHaveBeenCalledTimes(2);
  });

  test('an account with friends opens where it always did', () => {
    const s = scope({ friendCount: 3 });
    makeOpen(s)();
    expect(s.setAddFriendsTab).not.toHaveBeenCalled();
    expect(s.setCurrentScreen).toHaveBeenCalledWith('addFriends');
  });

  test('a count still loading is not zero', () => {
    const s = scope({ friendCount: null });
    makeOpen(s)();
    expect(s.setAddFriendsTab).not.toHaveBeenCalled();
    expect(s.setCurrentScreen).toHaveBeenCalledWith('addFriends');
  });

  test('where there is no Contacts tab (a browser without the Contacts Picker) it opens on Search', () => {
    const s = scope({ contactsSupported: false });
    makeOpen(s)();
    expect(s.setAddFriendsTab).not.toHaveBeenCalled();
    expect(s.setCurrentScreen).toHaveBeenCalledWith('addFriends');
  });

  test('a contacts refusal already given this session keeps it on Search', () => {
    const s = scope({ contactsDenied: true });
    makeOpen(s)();
    expect(s.setAddFriendsTab).not.toHaveBeenCalled();
  });

  test('the once is spent by any open from the Nest, so a later zero does not move the tab', () => {
    // First open while the count was still loading, second after it said zero.
    const s = scope({ friendCount: null });
    makeOpen(s)();
    const later = scope({ friendCount: 0, addFriendsOpenedFromNest: s.addFriendsOpenedFromNest });
    makeOpen(later)();
    expect(later.setAddFriendsTab).not.toHaveBeenCalled();
  });
});

describe('where it is used, and where it is not', () => {
  test('both of the Nest\'s Add friends buttons go through it', () => {
    const home = APP.slice(APP.indexOf('const HomeScreen = () => {'));
    const homeEnd = home.indexOf('\n  };\n');
    expect(homeEnd).toBeGreaterThan(0);
    const body = home.slice(0, homeEnd);
    expect(body).toContain("'No flocks yet'");
    expect(body.match(/onClick=\{openAddFriendsFromNest\}/g)).toHaveLength(2);
    expect(body).not.toContain("setCurrentScreen('addFriends')");
  });

  test('the screen\'s own default is still Search', () => {
    expect(APP).toContain("const [addFriendsTab, setAddFriendsTab] = useState('username');");
  });

  test('the other ways in are unchanged', () => {
    expect(read('screens', 'ProfileSettings.js')).toContain("onClick={() => setCurrentScreen('addFriends')}");
    expect(read('screens', 'ExploreScreen.js')).toContain("setCurrentScreen('addFriends'); }}");
  });

  test('opening the tab asks for nothing: the contacts read is still behind its own button', () => {
    expect(BODY).not.toMatch(/handleSyncContacts|syncContacts|requestPermission/);
  });
});
