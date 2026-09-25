/**
 * WHAT A SIGN-OUT TAKES WITH IT, AND AN ALARM THAT WAS CALLED OFF.
 *
 *   1. The device's push registration goes with the request that ends the
 *      session. POST /api/auth/logout now carries this device's push token and
 *      the server deletes its row there; DELETE /api/notifications/unregister
 *      still follows as a second line. Either landing is enough.
 *   2. A sign-out that could not reach the network keeps owing the token's
 *      deletion on the device, and pays it on the next launch, focus or
 *      reconnect while nobody is signed in. Until now it was one attempt, so
 *      a sign-out on the subway left the phone registered to the account.
 *   3. An SOS alarm still in the tray after its sender stood down no longer
 *      redraws the alarm when tapped. The all-clear now replaces it in the tray
 *      (one slot per sender, server side); this covers an all-clear that
 *      arrived live while the alarm's notification stayed.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false pushSignOutAndStandDowns
 */
const fs = require('fs');
const path = require('path');

// The real @capacitor/app, the Google sign-in plugin and the purchases module
// each load @capacitor/core, which rewrites window.Capacitor.isNativePlatform
// to answer false in jsdom and turns the "native" tests below into web ones
// (lib/nativeShell.js explains the rewrite). A sign-out reaches the last two.
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: () => Promise.resolve({ remove: () => {} }),
    getLaunchUrl: () => Promise.resolve(undefined),
  },
}));
jest.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: { logout: () => Promise.resolve() },
}));
jest.mock('../services/purchases', () => ({
  endPurchasesSession: () => Promise.resolve(),
}));

// Plain functions over a state object: react-scripts sets resetMocks: true,
// which strips jest.fn() implementations between tests.
const mockFcm = {
  reset() {
    this.deletes = 0;
    this.deleteFails = false;
    this.listeners = new Map();
  },
};
mockFcm.reset();
jest.mock('@capacitor-firebase/messaging', () => ({
  FirebaseMessaging: {
    addListener: (name, cb) => {
      if (!mockFcm.listeners.has(name)) mockFcm.listeners.set(name, new Set());
      mockFcm.listeners.get(name).add(cb);
      return Promise.resolve({ remove: () => {} });
    },
    checkPermissions: () => Promise.resolve({ receive: 'prompt' }),
    removeAllDeliveredNotifications: () => Promise.resolve(),
    deleteToken: () => {
      mockFcm.deletes += 1;
      return mockFcm.deleteFails ? Promise.reject(new Error('The Internet connection appears to be offline.')) : Promise.resolve();
    },
  },
}));

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const NATIVE = () => ({ isNativePlatform: () => true, getPlatform: () => 'ios' });

beforeEach(() => {
  jest.resetModules();
  mockFcm.reset();
  localStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve(jsonRes({ message: 'ok' })));
});
afterEach(() => { delete window.Capacitor; });

const requestsTo = (fragment) => global.fetch.mock.calls
  .filter(([url]) => String(url).includes(fragment))
  .map(([, opts]) => ({
    method: opts.method,
    auth: opts.headers && opts.headers.Authorization,
    body: opts.body ? JSON.parse(opts.body) : undefined,
  }));

// ═══════════════════════════════════════════════════════════════════════════
// 2. The token's deletion is owed until one lands
// ═══════════════════════════════════════════════════════════════════════════
// FIRST IN THE FILE ON PURPOSE. Every test re-requires the push module, and
// each instance keeps the window listeners it added, so an 'online' event
// reaches every earlier instance too. The exact count of deletions below
// holds only while this is the first instance to exist.
describe('a sign-out with no network keeps owing the token deletion', () => {
  async function signOutOffline() {
    window.Capacitor = NATIVE();
    localStorage.setItem('flockToken', 'tok-abc');
    localStorage.setItem('flock_push_token', 'fcm-token-for-this-phone');
    mockFcm.deleteFails = true;
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    // eslint-disable-next-line global-require
    const firebase = require('../services/firebase');
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    await flush();
    firebase.unregisterPushToken();
    await api.logout();
    await flush();
    return { firebase, api };
  }

  test('the debt survives the sign-out sweep and is paid on the next reconnect while signed out', async () => {
    await signOutOffline();
    expect(mockFcm.deletes).toBe(1);
    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_push_token_delete_owed')).toBe('1');

    mockFcm.deleteFails = false;
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(mockFcm.deletes).toBe(2);
    expect(localStorage.getItem('flock_push_token_delete_owed')).toBeNull();

    // Paid once: nothing is deleted on the next focus.
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(mockFcm.deletes).toBe(2);
  });

  test('it is not paid while somebody is signed in, whose session may be using the token', async () => {
    await signOutOffline();
    mockFcm.deleteFails = false;
    localStorage.setItem('flockToken', 'tok-next-person');
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(mockFcm.deletes).toBe(1);
    expect(localStorage.getItem('flock_push_token_delete_owed')).toBe('1');
  });

  test('a registration clears the debt: the token now belongs to the session that registered it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'firebase.js'), 'utf8');
    const reg = src.slice(src.indexOf('async function completeNativeRegistration('), src.indexOf('async function requestNativePermission('));
    expect(reg.indexOf('markTokenDeleteOwed(false);')).toBeGreaterThan(reg.indexOf('await registerDeviceToken(token, platform, deviceTimezone());'));
    expect(reg).toMatch(/registerDeviceToken\(event\.token, platform, deviceTimezone\(\)\)\s*\.then\(\(\) => markTokenDeleteOwed\(false\)\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The device goes with the request that ends the session
// ═══════════════════════════════════════════════════════════════════════════
describe('a sign-out names this device to the server', () => {
  test('the push token rides on POST /api/auth/logout, and the unregister still goes as a second line', async () => {
    localStorage.setItem('flockToken', 'tok-abc');
    localStorage.setItem('flock_push_token', 'fcm-token-for-this-phone');
    // eslint-disable-next-line global-require
    const firebase = require('../services/firebase');
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    await flush();

    // endSession's order: the push module first, then the one sign-out.
    firebase.unregisterPushToken();
    await api.logout();

    const [signOut] = requestsTo('/api/auth/logout');
    expect(signOut).toEqual({ method: 'POST', auth: 'Bearer tok-abc', body: { pushToken: 'fcm-token-for-this-phone' } });
    const [unregister] = requestsTo('/api/notifications/unregister');
    expect(unregister).toEqual({ method: 'DELETE', auth: 'Bearer tok-abc', body: { token: 'fcm-token-for-this-phone' } });
  });

  test('the token is handed over once: a later sign-out does not carry it again', async () => {
    localStorage.setItem('flockToken', 'tok-abc');
    localStorage.setItem('flock_push_token', 'fcm-token-for-this-phone');
    // eslint-disable-next-line global-require
    const firebase = require('../services/firebase');
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    await flush();
    firebase.unregisterPushToken();
    await api.logout();

    global.fetch.mockClear();
    localStorage.setItem('flockToken', 'tok-next');
    await api.logout();
    const [signOut] = requestsTo('/api/auth/logout');
    expect(signOut.auth).toBe('Bearer tok-next');
    expect(signOut.body).toBeUndefined();
  });

  test('a device that never registered sends no push token', async () => {
    localStorage.setItem('flockToken', 'tok-abc');
    // eslint-disable-next-line global-require
    const firebase = require('../services/firebase');
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    await flush();
    firebase.unregisterPushToken();
    await api.logout();
    const [signOut] = requestsTo('/api/auth/logout');
    expect(signOut.body).toBeUndefined();
  });

  test('the hand-over happens before the token is forgotten', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'firebase.js'), 'utf8');
    const fn = src.slice(src.indexOf('export function unregisterPushToken() {'));
    const handOver = fn.indexOf('handOverPushTokenForSignOut(token)');
    expect(handOver).toBeGreaterThan(-1);
    expect(handOver).toBeLessThan(fn.indexOf('rememberPushToken(null);'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. An alarm already called off does not open again
// ═══════════════════════════════════════════════════════════════════════════
describe('an SOS alarm tapped after its sender stood down', () => {
  const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
  const alarmAt = (at, from = '7') => ({
    type: 'safety_alert', fromUserId: from, fromUserName: 'Ava', toUserId: '42', at,
  });

  test('an alarm older than the stand-down is refused, and a new alarm from the same person still opens', () => {
    // eslint-disable-next-line global-require
    const nav = require('../services/pushNavigation');
    const alarm = nav.intentFromData(alarmAt(minutesAgo(10)));
    expect(nav.safetyAlarmWasStoodDown(alarm)).toBe(false);

    const clearAt = minutesAgo(5);
    const clear = nav.intentFromData({ type: 'safety_alert_cancelled', fromUserId: '7', fromUserName: 'Ava', toUserId: '42', at: clearAt });
    expect(clear.at).toBe(clearAt);
    nav.noteSafetyStandDown(clear.userId, clear.at);

    expect(nav.safetyAlarmWasStoodDown(alarm)).toBe(true);
    expect(nav.safetyAlarmWasStoodDown(nav.intentFromData(alarmAt(minutesAgo(1))))).toBe(false);
    // Another person's alarm is untouched, and a stand-down is never refused.
    expect(nav.safetyAlarmWasStoodDown(nav.intentFromData(alarmAt(minutesAgo(10), '8')))).toBe(false);
    expect(nav.safetyAlarmWasStoodDown(clear)).toBe(false);
  });

  test('the memory is the account\'s: a sign-out sweeps it', () => {
    // eslint-disable-next-line global-require
    const nav = require('../services/pushNavigation');
    // eslint-disable-next-line global-require
    const api = require('../services/api');
    nav.noteSafetyStandDown(7, minutesAgo(5));
    expect(localStorage.getItem('flock_sos_stand_downs')).not.toBeNull();
    api.clearLocalSession();
    expect(localStorage.getItem('flock_sos_stand_downs')).toBeNull();
  });

  test('App.js asks before it draws the alarm, and both ways a stand-down arrives write it down', () => {
    const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = APP.indexOf('useEffect(() => onPushNavigate((intent) => {');
    const handler = APP.slice(start, APP.indexOf('}), [showToast, loadFlocks, authUser?.id]);', start));
    const refused = handler.indexOf("} else if (intent.screen === 'safety' && safetyAlarmWasStoodDown(intent)) {");
    expect(refused).toBeGreaterThan(-1);
    expect(refused).toBeLessThan(handler.indexOf("} else if (intent.screen === 'safety') {"));
    const cancelled = handler.slice(handler.indexOf("intent.screen === 'safety' && intent.cancelled"), refused);
    expect(cancelled).toContain('noteSafetyStandDown(intent.userId, intent.at);');
    const live = APP.slice(APP.indexOf('onSafetyAlertCancelled((data) => {'));
    expect(live.slice(0, 600)).toContain('noteSafetyStandDown(data.fromUserId, data.at);');
  });
});
