/**
 * SIGN-OUT — the server call, and the device wipe.
 *
 * Two real defects, both fixed by the code these tests pin:
 *
 *   1. Sign-out never told the server. logout() dropped the token locally and
 *      that was it, so a JWT copied off a phone before sign-out stayed valid
 *      for the rest of its 24h TTL. logout() now POSTs /api/auth/logout with
 *      the live bearer token first. That route is advisory today (tokens carry
 *      no per-session id; only /logout-all revokes, by bumping token_version,
 *      and no UI reaches it) — the client's half of the contract is to declare
 *      the session over regardless, so the day the route learns to revoke,
 *      every shipped build already asks it to.
 *
 *   2. Sign-out left the account's data on the handset. Three keys were
 *      cleared; flock_user_lat/_lng, flock_deleted_dms, flock_pinned,
 *      flock_interests, flock_order and every flock_checkin_<placeId> survived
 *      it. Flock's users are 13-22 and borrowed phones are normal, so the next
 *      person to sign in inherited the previous one's last known location and
 *      deleted-DM list.
 *
 * THE RULE THESE TESTS ENFORCE, in order of importance:
 *
 *   - The local wipe is unconditional. Offline, expired token, dead server,
 *     hung socket: the device is signed out anyway, synchronously, before any
 *     promise settles. Nobody stays logged in because the network was down.
 *   - The wipe is default-deny over the flock* namespace, so a prefix family
 *     (flock_checkin_<placeId>) and any key added later are covered without
 *     being named. Only KEEP_ON_SIGN_OUT survives, and every survivor is a
 *     device fact with nothing personal in it.
 *   - There is exactly ONE clearing path. logout(), the 401 handler and
 *     account deletion all route through clearLocalSession(); App.js's
 *     endSession() clears nothing of its own. A second half-clearing path is
 *     how the leak survived this long.
 *   - The wipe reaches the credential that is NOT in localStorage. On iOS,
 *     "Continue with Google" runs Google's own SDK and GIDSignIn keeps its
 *     session in the keychain, so a perfect storage sweep still left the
 *     previous user one tap from signing back in on a handed-over phone.
 *     clearLocalSession() now calls the plugin's logout as well - guarded to
 *     native iOS, lazily imported so the web bundle never pulls the native
 *     module in, and fire-and-forget so a plugin that is absent, disabled or
 *     rejecting cannot hold a sign-out open or undo one.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

import { logout, clearLocalSession, isLoggedIn, getBlockedUsers } from '../services/api';

// The native Google session. api.js reaches it through a dynamic import behind
// an isNativeIos() guard, so the getter below is what proves the web build
// never touches the module at all: on web it is never read.
let mockNativeModuleLoads = 0;
const mockSocialLogin = { logout: jest.fn() };
jest.mock('@capgo/capacitor-social-login', () => ({
  get SocialLogin() {
    mockNativeModuleLoads += 1;
    return mockSocialLogin;
  },
}));

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};
const asWeb = () => { delete window.Capacitor; };
// The plugin call is deliberately not awaited by anything, so a test has to
// let the microtask queue and the dynamic import settle before reading it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const fs = require('fs');
const path = require('path');

const API = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Everything the signed-in account writes to this device, as of this drop.
// Derived by grepping localStorage writes across frontend/src; the inventory
// and the per-key reasoning live in the SIGN-OUT comment in api.js.
const USER_SCOPED = {
  flockToken: 'tok-abc',
  flockUserMode: 'venue',
  flockOnboardingComplete: 'true',
  flockVenueOnboardingComplete: 'true',
  flockBirdBest: '42',
  flock_user_lat: '40.6084',
  flock_user_lng: '-75.4902',
  flock_deleted_dms: '[17,23]',
  flock_pinned: '[3]',
  flock_order: '[3,4]',
  flock_interests: '["live music"]',
  flock_loc_dismissed: '["home"]',
  flock_safety_on: 'true',
  flock_crowd_alerts: 'false',
  flock_location_enabled: 'true',
  flock_birdie_corner: 'br',
  flock_sos_corner: 'bl',
  flock_push_token: 'fcm-token-xyz',
  flock_pending_invite: '{"token":"abcdefgh12"}',
  // The prefix family. Handled by iterating keys, never by naming them: one
  // row per venue the user tapped into, i.e. where they physically were.
  'flock_checkin_ChIJ_place_id_123': '1755300000000',
  'flock_checkin_ChIJ_place_id_456': '1755386400000',
  // Same shape, from the guest-invite surface: a name attached to a link.
  flock_guest_abcdefgh12: '{"name":"Sam"}',
};

// Device facts, kept on purpose. Nothing here identifies a person, and
// pullSettings() overwrites all of them the moment the next account signs in.
const KEPT = {
  'flock-theme': 'dark',              // dropping it = a flash of the wrong theme, zero privacy gain
  'flock-theme-mode': 'system',
  flock_map_type: 'satellite',        // street vs satellite is a display choice
  flock_notif_denied: 'true',         // THIS BROWSER denied notifications; true whoever holds the phone
};

function seedDevice() {
  Object.entries(USER_SCOPED).forEach(([k, v]) => localStorage.setItem(k, v));
  Object.entries(KEPT).forEach(([k, v]) => localStorage.setItem(k, v));
}

beforeEach(() => {
  global.fetch = jest.fn();
  localStorage.clear();
  sessionStorage.clear();
  mockNativeModuleLoads = 0;
  asWeb();
});

afterEach(() => { asWeb(); });

// ═══════════════════════════════════════════════════════════════════════════
// 1. Sign-out calls the server
// ═══════════════════════════════════════════════════════════════════════════

describe('the server call', () => {
  it('POSTs /api/auth/logout carrying the bearer token', async () => {
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await logout();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(String(url)).toContain('/api/auth/logout');
    expect(String(url)).not.toContain('/logout-all'); // that one revokes EVERY device
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok-abc');
  });

  it('skips the call when there is no token to declare dead, and still wipes', async () => {
    seedDevice();
    localStorage.removeItem('flockToken');

    await logout();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem('flock_user_lat')).toBeNull();
  });

  it('is excluded from the session-expired notice: a 401 on sign-out is not an expiry', () => {
    // Announcing "your session expired" over a sign-out the user asked for is
    // a lie with a toast on it. The prefix also covers /logout-all.
    const m = API.match(/const AUTH_FLOW_PREFIXES = \[(.*?)\];/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain("'/api/auth/logout'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The wipe does not depend on the server answering
// ═══════════════════════════════════════════════════════════════════════════

describe('failure behavior', () => {
  it('wipes the device when the network call rejects, and does not reject itself', async () => {
    seedDevice();
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(logout()).resolves.toBeUndefined();

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_user_lat')).toBeNull();
    expect(localStorage.getItem('flock_deleted_dms')).toBeNull();
    expect(isLoggedIn()).toBe(false);
  });

  it('wipes the device when the server rejects the token outright (401)', async () => {
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ error: 'Invalid token' }, 401));

    await expect(logout()).resolves.toBeUndefined();

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_pinned')).toBeNull();
  });

  it('wipes the device when the device is offline and no request can be made', async () => {
    seedDevice();
    const onLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    try {
      await expect(logout()).resolves.toBeUndefined();
    } finally {
      if (onLine) Object.defineProperty(window.navigator, 'onLine', onLine);
      else delete window.navigator.onLine;
    }
    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_user_lng')).toBeNull();
  });

  it('wipes before the request settles: a hung connection cannot hold the session open', () => {
    seedDevice();
    global.fetch.mockReturnValue(new Promise(() => {})); // never settles

    const pending = logout();

    // No await. The local half is synchronous on purpose.
    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_user_lat')).toBeNull();
    expect(pending).toBeInstanceOf(Promise);
    pending.catch(() => {});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Everything the account wrote is gone
// ═══════════════════════════════════════════════════════════════════════════

describe('what leaves the device', () => {
  it('removes every user-scoped key, check-in family included', async () => {
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await logout();

    Object.keys(USER_SCOPED).forEach((key) => {
      expect([key, localStorage.getItem(key)]).toEqual([key, null]);
    });
  });

  it('removes a flock_checkin_<placeId> written after this test was authored', () => {
    // The point of iterating the namespace instead of naming keys: nobody has
    // to come back here when a new venue id shows up, or a new key ships.
    localStorage.setItem('flock_checkin_ChIJ_brand_new_place', '1755400000000');
    localStorage.setItem('flock_some_future_key', 'personal');

    clearLocalSession();

    expect(localStorage.getItem('flock_checkin_ChIJ_brand_new_place')).toBeNull();
    expect(localStorage.getItem('flock_some_future_key')).toBeNull();
  });

  it('sweeps sessionStorage on the same rule, though nothing writes it today', () => {
    // Vacuous right now (the app stores nothing per tab) and swept anyway, so
    // the first person to reach for sessionStorage is covered by default
    // rather than by remembering this file exists.
    sessionStorage.setItem('flock_draft_message', 'unsent');

    clearLocalSession();

    expect(sessionStorage.getItem('flock_draft_message')).toBeNull();
  });

  it('leaves non-Flock keys alone', () => {
    localStorage.setItem('ph_test_posthog', '{}');
    seedDevice();

    clearLocalSession();

    expect(localStorage.getItem('ph_test_posthog')).toBe('{}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. What stays, and why
// ═══════════════════════════════════════════════════════════════════════════

describe('what stays on the device', () => {
  it('keeps theme, map type and the notification-denied flag', async () => {
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await logout();

    // theme / theme-mode: a display choice with nobody's identity in it.
    expect(localStorage.getItem('flock-theme')).toBe('dark');
    expect(localStorage.getItem('flock-theme-mode')).toBe('system');
    // map type: street vs satellite, same reasoning.
    expect(localStorage.getItem('flock_map_type')).toBe('satellite');
    // notif_denied: a fact about this BROWSER's permission state, not about a
    // person. Clearing it only re-prompts a user into the same denial.
    expect(localStorage.getItem('flock_notif_denied')).toBe('true');
  });

  it('pins the keep-list to exactly those four, so a personal key cannot be added quietly', () => {
    const m = API.match(/const KEEP_ON_SIGN_OUT = new Set\(\[([\s\S]*?)\]\);/);
    expect(m).not.toBeNull();
    const kept = (m[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1)).sort();
    expect(kept).toEqual(['flock-theme', 'flock-theme-mode', 'flock_map_type', 'flock_notif_denied'].sort());
  });

  it('every kept key is one pullSettings overwrites for the next account', () => {
    const settings = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'userSettings.js'), 'utf8'
    );
    ['flock-theme', 'flock-theme-mode', 'flock_map_type'].forEach((key) => {
      expect(settings).toContain(`'${key}'`);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. One clearing path
// ═══════════════════════════════════════════════════════════════════════════

describe('convergence', () => {
  it('a mid-session 401 clears the account data too, not just the token', async () => {
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ error: 'Invalid token' }, 401));

    await expect(getBlockedUsers()).rejects.toThrow();

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_user_lat')).toBeNull();
    expect(localStorage.getItem('flock_deleted_dms')).toBeNull();
    expect(localStorage.getItem('flock-theme')).toBe('dark');
  });

  it('account deletion clears through the same function', () => {
    const del = API.slice(API.indexOf('export async function deleteAccount'));
    expect(del.slice(0, del.indexOf('\n}'))).toContain('clearLocalSession();');
  });

  it('nothing clears the token by hand any more', () => {
    // The old clearToken() dropped one key and was the reason two of the three
    // sign-out paths were partial.
    expect(API).not.toContain('function clearToken');
    expect(API).not.toContain("localStorage.removeItem('flockToken')");
  });

  it("App.js endSession delegates the whole wipe and clears nothing itself", () => {
    const start = APP.indexOf('const endSession = useCallback');
    expect(start).toBeGreaterThan(-1);
    const body = APP.slice(start, APP.indexOf('const beginSession', start));
    expect(body).toContain('logout().catch(() => {});');
    expect(body).not.toContain('localStorage.removeItem');
  });

  it('endSession is still the single teardown every session end reaches', () => {
    // The Log out button, the delete-account flow, the socket revoke and the
    // flock-session-expired event.
    expect(APP).toContain('onLogout={() => endSession(\'\')}');
    expect(APP).toContain("window.addEventListener('flock-session-expired', onExpired);");
    expect(APP).toContain('endSession(sessionEndCopy(reason)');
    const del = APP.indexOf('await deleteAccount(');
    expect(APP.indexOf('if (onLogout) onLogout();', del)).toBeGreaterThan(del);
  });
});

// ===========================================================================
// 6. The credential that is not in localStorage
//
// f3db39c cleared the whole flock* namespace and told the server, and it was
// still possible to hand the phone to someone else, tap "Continue with
// Google", and land straight back in the previous user's account with no
// password: @capgo/capacitor-social-login drives GIDSignIn, which keeps the
// authenticated Google account in the iOS keychain, and nothing called its
// logout(). That is the same shared-phone leak the sweep exists to close,
// sitting one layer below the sweep.
//
// The three properties below are the ones that make this safe to put inside
// clearLocalSession(), which is the function every session-ending path
// converges on and which must never fail.
// ===========================================================================
describe('the native Google session', () => {
  it('is ended on iOS when the user signs out', async () => {
    asNativeIos();
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await logout();
    await flush();

    expect(mockSocialLogin.logout).toHaveBeenCalledTimes(1);
    expect(mockSocialLogin.logout).toHaveBeenCalledWith({ provider: 'google' });
  });

  it('is ended on the other two paths too, because they share one function', async () => {
    // A 401 mid-session and account deletion are sign-outs the user did not
    // tap. Routing them through clearLocalSession() is what stops this from
    // becoming a second, partial teardown.
    asNativeIos();
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ error: 'Invalid token' }, 401));

    await expect(getBlockedUsers()).rejects.toThrow();
    await flush();

    expect(mockSocialLogin.logout).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('flockToken')).toBeNull();
  });

  it('is never reached on the web, and the plugin is never even imported', async () => {
    // The guard is what keeps the native module out of the web bundle. If
    // this ever fires, every web user downloads a GoogleSignIn shim they
    // cannot use, and the web build starts depending on a native plugin.
    asWeb();
    seedDevice();
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await logout();
    await flush();

    expect(mockNativeModuleLoads).toBe(0);
    expect(mockSocialLogin.logout).not.toHaveBeenCalled();
    expect(localStorage.getItem('flockToken')).toBeNull();
  });

  it('cannot stop the sign-out when it rejects', async () => {
    // The plugin rejects for real reasons: Google initialized in offline
    // mode, the GoogleSignIn dependency not linked into the build. None of
    // them is a reason to leave someone signed in on a borrowed phone.
    asNativeIos();
    seedDevice();
    mockSocialLogin.logout.mockRejectedValue(new Error('logout is not implemented when using offline mode'));
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await expect(logout()).resolves.toBeUndefined();
    await flush();

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_user_lat')).toBeNull();
    expect(isLoggedIn()).toBe(false);
  });

  it('cannot stop the sign-out when it throws synchronously', async () => {
    asNativeIos();
    seedDevice();
    mockSocialLogin.logout.mockImplementation(() => { throw new Error('bridge unavailable'); });
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await expect(logout()).resolves.toBeUndefined();
    await flush();

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(localStorage.getItem('flock_deleted_dms')).toBeNull();
  });

  it('cannot stop the sign-out when the bridge is not there to call', async () => {
    // A build where the provider is disabled in capacitor.config.ts, or where
    // the GoogleSignIn dependency is not linked, resolves to a plugin object
    // with nothing callable on it. That is a TypeError inside the promise
    // chain, and it must land in the same place a rejection does.
    asNativeIos();
    seedDevice();
    const real = mockSocialLogin.logout;
    delete mockSocialLogin.logout;
    try {
      global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));
      await expect(logout()).resolves.toBeUndefined();
      await flush();
    } finally {
      mockSocialLogin.logout = real;
    }

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(isLoggedIn()).toBe(false);
  });

  it('runs AFTER the storage sweep, so nothing it does can come first', () => {
    // Order is the reason a plugin failure is survivable at all: by the time
    // the plugin is touched, the device is already wiped.
    const fn = API.slice(API.indexOf('export function clearLocalSession'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body.indexOf('sweepStore(window.localStorage)'))
      .toBeLessThan(body.indexOf('endNativeGoogleSession()'));
    // And it is fire-and-forget: clearLocalSession stays synchronous, so no
    // caller can be held open by the native bridge.
    expect(body).not.toContain('await');
    expect(API).not.toContain('export async function clearLocalSession');
  });

  it('imports the plugin lazily, inside the guard', () => {
    const fn = API.slice(API.indexOf('function endNativeGoogleSession'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // A static import at the top of api.js would put the native module in the
    // web bundle no matter what the guard says.
    expect(API).not.toMatch(/^import .*@capgo\/capacitor-social-login/m);
    expect(body).toContain("import('@capgo/capacitor-social-login')");
    expect(body).toContain("getPlatform?.() === 'ios'");
    expect(body).toContain('.catch(');
  });
});
