/**
 * THE STATUS BAR MATCHES WHAT IS UNDER IT.
 *
 * Nothing used to set the iOS status bar style, so it followed the phone's
 * appearance setting while the app's theme followed a clock. In the evening a
 * phone in system Light mode drew black glyphs over the dark theme, and by day
 * a phone in system Dark mode drew white ones over cream. The strip above the
 * chat, DM, plan and Add Friends headers was --bg-primary over a navy header.
 *
 * services/systemBars.js now sets the style through SystemBars (in
 * @capacitor/core 8), from the theme and from what is at the top of the screen,
 * and the shell paints the strip navy over a navy header.
 *
 * Sections:
 *   1. the service, run for real against a mocked bridge;
 *   2. which screens count as navy on top, and that each one really opens on a
 *      navy header;
 *   3. the shell and the two photo viewers wired to it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test statusBarAndNotch --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const mockBridge = { setStyle: jest.fn(() => Promise.resolve()), loads: 0, native: true };
jest.mock('@capacitor/core', () => {
  mockBridge.loads += 1;
  return { SystemBars: { setStyle: (...args) => mockBridge.setStyle(...args) } };
});
jest.mock('../lib/nativeShell', () => ({ isNativeShell: () => mockBridge.native }));

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** A fresh copy of the service, so the style it last applied does not leak
 *  from one test into the next. */
const freshService = () => {
  let mod;
  jest.isolateModules(() => { mod = require('../services/systemBars'); });
  return mod;
};
const styles = () => mockBridge.setStyle.mock.calls.map((c) => c[0].style);

beforeEach(() => {
  mockBridge.setStyle.mockClear();
  mockBridge.native = true;
  mockBridge.loads = 0;
});

describe('services/systemBars, run', () => {
  test('a light screen gets dark glyphs, a dark one light glyphs, and a repeat is not sent again', async () => {
    const bars = freshService();
    bars.setStatusBarOverDark(false);
    await flush();
    bars.setStatusBarOverDark(true);
    await flush();
    bars.setStatusBarOverDark(true);
    await flush();
    // Capacitor names the style by the background: DARK draws light glyphs.
    expect(styles()).toEqual(['LIGHT', 'DARK']);
  });

  test('a hold keeps the glyphs light until every hold is released', async () => {
    const bars = freshService();
    bars.setStatusBarOverDark(false);
    const releaseA = bars.holdStatusBarOverDark();
    const releaseB = bars.holdStatusBarOverDark();
    await flush();
    releaseA();
    await flush();
    expect(styles()).toEqual(['LIGHT', 'DARK']);
    releaseB();
    releaseB(); // a second call is harmless
    await flush();
    expect(styles()).toEqual(['LIGHT', 'DARK', 'LIGHT']);
  });

  test('a hold over a screen that is already dark sends nothing', async () => {
    const bars = freshService();
    bars.setStatusBarOverDark(true);
    await flush();
    const release = bars.holdStatusBarOverDark();
    release();
    await flush();
    expect(styles()).toEqual(['DARK']);
  });

  test('in a browser the bridge is never loaded, so window.Capacitor is never defined from here', async () => {
    mockBridge.native = false;
    const bars = freshService();
    bars.setStatusBarOverDark(false);
    bars.holdStatusBarOverDark()();
    await flush();
    expect(mockBridge.loads).toBe(0);
    expect(mockBridge.setStyle).not.toHaveBeenCalled();
  });

  test('a bridge that rejects is swallowed', async () => {
    mockBridge.setStyle.mockImplementationOnce(() => Promise.reject(new Error('no plugin')));
    const bars = freshService();
    bars.setStatusBarOverDark(false);
    await flush();
    bars.setStatusBarOverDark(true);
    await flush();
    expect(styles()).toEqual(['LIGHT', 'DARK']);
  });
});

describe('which screens open on navy', () => {
  const { screenTopIsNavy, NAVY_TOP_SCREENS } = require('../services/systemBars');

  test.each([
    ['chatDetail', 'home', 'main', true],
    ['dmDetail', 'chat', 'main', true],
    ['detail', 'calendar', 'main', true],
    ['addFriends', 'home', 'main', true],
    ['venueDashboard', 'home', 'main', true],
    ['adminRevenue', 'home', 'main', true],
    ['main', 'profile', 'main', true],
    ['main', 'profile', 'safety', false],
    ['main', 'home', 'main', false],
    ['main', 'explore', 'main', false],
    ['create', 'home', 'main', false],
    ['pastFlocks', 'home', 'main', false],
  ])('%s on the %s tab (profile page %s) is navy on top: %s', (currentScreen, currentTab, profileScreen, want) => {
    expect(screenTopIsNavy({ currentScreen, currentTab, profileScreen })).toBe(want);
  });

  test('the Welcome and venue onboarding screens replace the screen, so they are not navy', () => {
    expect(screenTopIsNavy({ currentScreen: 'chatDetail', currentTab: 'home', profileScreen: 'main', takenOver: true })).toBe(false);
  });

  // The screen name, the file it renders from, and the key on its root element.
  const ROOTS = {
    chatDetail: ['screens/ChatDetail.js', 'chat-detail-screen-container'],
    dmDetail: ['screens/DmDetail.js', 'dm-detail-screen'],
    detail: ['screens/FlockDetail.js', 'flock-detail-screen-container'],
    addFriends: ['screens/AddFriends.js', 'add-friends-container'],
    venueDashboard: ['screens/VenueDashboard.js', 'venue-dashboard-container'],
    adminRevenue: ['screens/RevenueScreen.js', 'revenue-screen-container'],
  };

  test('every screen in the set is listed here with its file', () => {
    expect([...NAVY_TOP_SCREENS].sort()).toEqual(Object.keys(ROOTS).sort());
  });

  test.each(Object.entries(ROOTS).concat([['the You tab', ['screens/ProfileSettings.js', 'profile-main-container']]]))(
    '%s really opens on a navy header',
    (screen, [file, key]) => {
      const src = read(...file.split('/'));
      const root = src.indexOf(`key="${key}"`);
      expect(root).toBeGreaterThan(-1);
      // The first element inside the root is the header.
      const firstChild = src.indexOf('<div style={{', root + key.length);
      const header = src.slice(firstChild, src.indexOf('}}>', firstChild));
      expect(header).toMatch(/background: colors\.navyBg/);
    },
  );
});

describe('the shell and the photo viewers are wired to it', () => {
  const APP = read('App.js');

  test('the shell derives the answer from the screen and the theme, and restores the launch style on sign-out', () => {
    expect(APP).toMatch(/const topIsNavy = screenTopIsNavy\(\{\s*currentScreen, currentTab, profileScreen,\s*takenOver: showModeSelection \|\| showVenueOnboarding,\s*\}\);/);
    expect(APP).toMatch(/const darkOverTop = !!eventDetail \|\| aiChatMode === 'fullscreen';/);
    expect(APP).toMatch(/setStatusBarOverDark\(isDark \|\| topIsNavy \|\| darkOverTop\);\s*\}, \[isDark, topIsNavy, darkOverTop\]\);/);
    expect(APP).toMatch(/useEffect\(\(\) => \(\) => setStatusBarOverDark\(true\), \[\]\);/);
  });

  test('on the device the strip above a navy header is painted navy', () => {
    expect(APP).toMatch(/<div style=\{fullBleed && topIsNavy \? \{ \.\.\.styles\.notch, backgroundColor: colors\.navyBg \} : styles\.notch\}>/);
  });

  test.each(['ChatDetail.js', 'DmDetail.js'])('%s holds light glyphs while its photo viewer is open', (file) => {
    const src = read('screens', file);
    expect(src).toMatch(/import \{ holdStatusBarOverDark \} from '\.\.\/services\/systemBars';/);
    expect(src).toMatch(/const imageViewerOpen = !!imageViewer;\s*React\.useEffect\(\(\) => \(imageViewerOpen \? holdStatusBarOverDark\(\) : undefined\), \[imageViewerOpen\]\);/);
    // And the viewer is the full screen scrim this is for.
    expect(src).toMatch(/\{imageViewer && \(\s*<div className="modal-backdrop" style=\{\{ position: 'fixed', inset: 0, zIndex: 400, backgroundColor: 'rgba\(6,16,31,0\.92\)'/);
  });
});
