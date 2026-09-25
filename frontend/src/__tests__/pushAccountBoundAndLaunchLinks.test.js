/**
 * WHAT A TAP MAY OPEN, FOR WHOM, AND WHEN IT ARRIVED BEFORE ANYONE SIGNED IN.
 *
 * Four findings against the iOS shell, pinned here:
 *
 *   1. An SOS notification delivered to one account, tapped after another had
 *      signed in on the same phone, opened that alarm (a name and a map pin,
 *      drawn from the payload with no server read) in the second account's
 *      session. Every copy now names its recipient (toUserId), the app opens a
 *      safety tap only for that account, and a sign-out clears the tray and
 *      the queue.
 *   2. A universal link (/i/<token>, /checkin/<placeId>) that opened a
 *      signed-out app said nothing on the sign-in screen, because the notes
 *      read window.location and the iOS WebView never leaves
 *      capacitor://localhost/. The notes now follow the push router's queue.
 *   3. A venue owner whose saved mode is Venue, cold-started from a deep link,
 *      was moved off the linked screen to the dashboard when the profile read
 *      came back.
 *   4. The cold-start notification tap. REJECTED: the installed plugin already
 *      holds the tap natively until the JS listener attaches. The last part
 *      pins the facts that make that true, so an upgrade that changes them
 *      goes red here instead of silently dropping taps.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */
const fs = require('fs');
const path = require('path');

// Fakes for the two native plugins. Plain functions over state objects:
// react-scripts sets resetMocks: true, which strips jest.fn() implementations.
const mockCap = {
  reset() {
    this.listeners = new Map();
    this.launchUrl = null;
  },
  fire(name, payload) {
    for (const cb of this.listeners.get(name) || []) cb(payload);
  },
};
mockCap.reset();
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: (name, cb) => {
      if (!mockCap.listeners.has(name)) mockCap.listeners.set(name, new Set());
      mockCap.listeners.get(name).add(cb);
      return Promise.resolve({ remove: () => {} });
    },
    getLaunchUrl: () => Promise.resolve(mockCap.launchUrl ? { url: mockCap.launchUrl } : undefined),
  },
}));

const mockFcm = {
  reset() {
    this.loads = 0;
    this.cleared = 0;
    this.listeners = new Map();
  },
};
mockFcm.reset();
jest.mock('@capacitor-firebase/messaging', () => ({
  get FirebaseMessaging() {
    mockFcm.loads += 1;
    return {
      addListener: (name, cb) => {
        if (!mockFcm.listeners.has(name)) mockFcm.listeners.set(name, new Set());
        mockFcm.listeners.get(name).add(cb);
        return Promise.resolve({ remove: () => {} });
      },
      removeAllDeliveredNotifications: () => { mockFcm.cleared += 1; return Promise.resolve(); },
      checkPermissions: () => Promise.resolve({ receive: 'prompt' }),
      deleteToken: () => Promise.resolve(),
    };
  },
}));

const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const NATIVE = () => ({ isNativePlatform: () => true, getPlatform: () => 'ios' });

let nav;
beforeEach(() => {
  jest.resetModules();
  mockCap.reset();
  mockFcm.reset();
  // eslint-disable-next-line global-require
  nav = require('../services/pushNavigation');
});
afterEach(() => { delete window.Capacitor; });

// ═══════════════════════════════════════════════════════════════════════════
// 1. A safety tap opens only for the account it was sent to
// ═══════════════════════════════════════════════════════════════════════════
describe('an alarm names its recipient, and only that account may open it', () => {
  const ALARM = {
    type: 'safety_alert', fromUserId: '7', fromUserName: 'Ava', toUserId: '42',
    latitude: '40.05', longitude: '-75.12', at: '2026-09-25T02:00:00.000Z',
  };

  test('the recipient travels on the alarm and on the stand-down', () => {
    expect(nav.intentFromData(ALARM)).toMatchObject({ screen: 'safety', userId: 7, toUserId: 42 });
    expect(nav.intentFromData({ type: 'safety_alert_cancelled', fromUserId: '7', fromUserName: 'Ava', toUserId: '42' }))
      .toMatchObject({ screen: 'safety', cancelled: true, userId: 7, toUserId: 42 });
    // A payload that names nobody keeps the exact shape it always had.
    const { toUserId, ...older } = ALARM;
    expect(nav.intentFromData(older)).not.toHaveProperty('toUserId');
  });

  test('the signed-in account it names may open it, and nobody else', () => {
    const tap = nav.intentFromData(ALARM);
    expect(nav.safetyIntentIsFor(tap, 42)).toBe(true);
    expect(nav.safetyIntentIsFor(tap, '42')).toBe(true);
    // Account 42 signed out, account 9 signed in, the old alarm is tapped.
    expect(nav.safetyIntentIsFor(tap, 9)).toBe(false);
    // Nobody signed in, or a copy that does not say who it was for.
    expect(nav.safetyIntentIsFor(tap, null)).toBe(false);
    const { toUserId, ...older } = ALARM;
    expect(nav.safetyIntentIsFor(nav.intentFromData(older), 42)).toBe(false);
    // And it answers only for safety taps.
    expect(nav.safetyIntentIsFor({ screen: 'dm', userId: 7, toUserId: 42 }, 42)).toBe(false);
  });

  test('a sign-out drops a tap still waiting in the queue', async () => {
    nav.emitPushNavigation(nav.intentFromData(ALARM));
    expect(nav.peekPendingNavigation()).toMatchObject({ screen: 'safety' });
    nav.clearPendingNavigation();
    const seen = [];
    nav.onPushNavigate((intent) => seen.push(intent));
    await flush();
    expect(seen).toEqual([]);
  });

  test('a sign-out clears the tray on the device, and the queue with it', async () => {
    window.Capacitor = NATIVE();
    // eslint-disable-next-line global-require
    const firebase = require('../services/firebase');
    await flush();
    firebase.routeNotification(ALARM);
    expect(nav.peekPendingNavigation()).toMatchObject({ screen: 'safety' });
    firebase.forgetDeliveredNotifications();
    await flush();
    expect(mockFcm.cleared).toBe(1);
    expect(nav.peekPendingNavigation()).toBeNull();
  });

  test('on the web the clear never loads the native plugin', async () => {
    delete window.Capacitor;
    // eslint-disable-next-line global-require
    const firebase = require('../services/firebase');
    await flush();
    expect(() => firebase.forgetDeliveredNotifications()).not.toThrow();
    await flush();
    expect(mockFcm.loads).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The signed-out screen can see a waiting link without taking it
// ═══════════════════════════════════════════════════════════════════════════
describe('a link waiting for a sign-in can be read without being consumed', () => {
  test('a watcher sees the waiting intent, and the signed-in app still gets it', async () => {
    const watched = [];
    const unwatch = nav.watchPendingNavigation((w) => watched.push(w));
    expect(watched).toEqual([null]);

    nav.emitPushNavigation({ screen: 'invite', token: 'tok123', type: 'link' });
    expect(watched[watched.length - 1]).toEqual({ screen: 'invite', token: 'tok123', type: 'link' });

    const seen = [];
    nav.onPushNavigate((intent) => seen.push(intent));
    await flush();
    expect(seen).toEqual([{ screen: 'invite', token: 'tok123', type: 'link' }]);
    // Handed over: nothing is waiting any more, so the note it drove goes.
    expect(watched[watched.length - 1]).toBeNull();

    unwatch();
    const before = watched.length;
    nav.clearPendingNavigation();
    nav.emitPushNavigation({ screen: 'home', type: 'link' });
    expect(watched).toHaveLength(before);
  });

  test.each([
    ['an invite link', 'https://flockcorp.com/i/tok123', { screen: 'invite', token: 'tok123', type: 'link' }],
    ['a tag tap', 'https://flockcorp.com/checkin/ChIJabc?sig=s1', { screen: 'checkin', placeId: 'ChIJabc', sig: 's1', type: 'link' }],
  ])('%s that launched a signed-out app reaches the sign-in screen through the queue', async (_label, url, intent) => {
    window.Capacitor = NATIVE();
    mockCap.launchUrl = url;
    const watched = [];
    nav.watchPendingNavigation((w) => watched.push(w));
    nav.startPushNavigation();
    await flush();
    expect(watched[watched.length - 1]).toEqual(intent);
    // Still there for whoever signs in.
    expect(nav.peekPendingNavigation()).toEqual(intent);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. App.js, where the three are wired
// ═══════════════════════════════════════════════════════════════════════════
const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read(SRC, 'App.js');

describe('App.js', () => {
  const handlerStart = APP.indexOf('useEffect(() => onPushNavigate((intent) => {');
  const handler = APP.slice(handlerStart, APP.indexOf('}), [showToast, loadFlocks, authUser?.id]);', handlerStart));

  test('the push router refuses a safety tap for another account before either safety branch', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    const gate = handler.indexOf("if (intent.screen === 'safety' && !safetyIntentIsFor(intent, authUser?.id)) return;");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(handler.indexOf('setSafetyAlert('));
    expect(gate).toBeLessThan(handler.indexOf("intent.screen === 'safety' && intent.cancelled"));
    // The check reads the account signed in now, so the subscription follows it.
    expect(APP).toContain('}), [showToast, loadFlocks, authUser?.id]);');
  });

  test('a session that ran clears the tray and the queue on the way out; a dead boot does not', () => {
    const end = APP.slice(APP.indexOf('const endSession = useCallback'), APP.indexOf('const beginSession = useCallback'));
    expect(end).toContain('if (sessionLiveRef.current) forgetDeliveredNotifications();');
    expect(end).toContain('sessionLiveRef.current = false;');
    const begin = APP.slice(APP.indexOf('const beginSession = useCallback'), APP.indexOf('pullSettings().catch'));
    expect(begin).toContain('sessionLiveRef.current = true;');
  });

  test('the sign-in notes follow the queue as well as the address bar', () => {
    const app = APP.slice(APP.indexOf('const FlockApp = () => {'));
    const watch = app.slice(app.indexOf('useEffect(() => watchPendingNavigation((waiting) => {'));
    expect(watch.length).toBeLessThan(app.length);
    const body = watch.slice(0, watch.indexOf('}), []);'));
    expect(body).toContain("setCheckinNote(screen === 'checkin' ? SIGNED_OUT_LINK_NOTES.checkin : '');");
    expect(body).toContain("setInviteNote(screen === 'invite' ? SIGNED_OUT_LINK_NOTES.invite : '');");
    // One sentence each, shared by the address-bar reading and the queue.
    expect(APP).toContain("checkin: 'Sign in and this check-in is saved to your account.',");
    expect(APP).toContain("invite: 'Sign in and you will be taken straight into the plan you were invited to.',");
    expect(app).toMatch(/\? SIGNED_OUT_LINK_NOTES\.checkin\n/);
    expect(app).toMatch(/\? SIGNED_OUT_LINK_NOTES\.invite\n/);
  });

  test('a screen a launch intent chose is not replaced by the venue boot routing', () => {
    // The push router marks it for every intent that picks a screen.
    expect(handler).toContain("if (intent.screen !== 'safety' && intent.screen !== 'admin') launchChoseScreenRef.current = true;");
    // A tag URL the app booted on counts from the start.
    expect(APP).toMatch(/const launchChoseScreenRef = useRef\(\s*typeof window !== 'undefined' && \/\^\\\/checkin\\\/\[\^\/\?#\]\+\/\.test\(window\.location\?\.pathname \|\| ''\)\s*\);/);
    // Both venue routes check it before they move anyone.
    const saved = APP.slice(APP.indexOf('const venueBootRoutedRef = useRef(false);'), APP.indexOf('}, [userMode, authUser?.role, venueLoginFlag]);'));
    expect(saved.indexOf('if (launchChoseScreenRef.current) return;')).toBeGreaterThan(-1);
    expect(saved.indexOf('if (launchChoseScreenRef.current) return;')).toBeLessThan(saved.indexOf("setCurrentScreen('venueDashboard');"));
    expect(saved).toContain('.catch(() => { if (!launchChoseScreenRef.current) setShowVenueOnboarding(true); });');
    const login = APP.slice(APP.indexOf('// If user came from venue login'), APP.indexOf('}, [venueLoginFlag]);'));
    expect(login.indexOf('if (launchChoseScreenRef.current) return;')).toBeGreaterThan(-1);
    expect(login.indexOf('if (launchChoseScreenRef.current) return;')).toBeLessThan(login.indexOf("setCurrentScreen('venueDashboard');"));
    expect(login).toContain('if (!launchChoseScreenRef.current) setShowVenueOnboarding(true);');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Why a cold-start tap is not lost, pinned where it lives
// ═══════════════════════════════════════════════════════════════════════════
describe('a notification tapped while the app is killed is held until the JS listener exists', () => {
  const FRONTEND = path.join(__dirname, '..', '..');
  const mod = (...p) => read(FRONTEND, 'node_modules', ...p);

  test('the messaging plugin retains the tap event until something listens', () => {
    const plugin = mod('@capacitor-firebase', 'messaging', 'ios', 'Plugin', 'FirebaseMessagingPlugin.swift');
    expect(plugin).toContain('notifyListeners(notificationActionPerformedEvent, data: result, retainUntilConsumed: true)');
    // And it is the handler Capacitor's notification router hands taps to.
    const impl = mod('@capacitor-firebase', 'messaging', 'ios', 'Plugin', 'FirebaseMessaging.swift');
    expect(impl).toContain('self.plugin.bridge?.notificationRouter.pushNotificationHandler = self');
  });

  test('Capacitor hands retained events to the first listener, and owns the notification delegate', () => {
    const cap = mod('@capacitor', 'ios', 'Capacitor', 'Capacitor', 'CAPPlugin.m');
    const add = cap.slice(cap.indexOf('- (void)addEventListener:'), cap.indexOf('- (void)sendRetainedArgumentsForEvent:'));
    expect(add).toContain('[self sendRetainedArgumentsForEvent:eventName];');
    const bridge = mod('@capacitor', 'ios', 'Capacitor', 'Capacitor', 'CapacitorBridge.swift');
    expect(bridge).toContain('self.notificationRouter.handleApplicationNotifications = configuration.handleApplicationNotifications');
  });

  test('nothing in the app displaces that delegate', () => {
    const config = read(FRONTEND, 'capacitor.config.ts');
    expect(config).not.toMatch(/handleApplicationNotifications\s*:\s*false/);
    const delegate = read(FRONTEND, 'ios', 'App', 'App', 'AppDelegate.swift');
    // A second UNUserNotificationCenter delegate would take taps away from
    // Capacitor's router, which is the only thing that feeds the plugin.
    expect(delegate).not.toMatch(/UNUserNotificationCenter\.current\(\)\.delegate\s*=/);
  });

  test('the JS listener attaches on native start-up, not when a screen subscribes', () => {
    const router = read(SRC, 'services', 'pushNavigation.js');
    const start = router.slice(router.indexOf('export function startPushNavigation'));
    expect(start).toContain("FirebaseMessaging.addListener('notificationActionPerformed'");
    expect(read(SRC, 'services', 'firebase.js')).toMatch(/^startPushNavigation\(\);$/m);
  });
});
