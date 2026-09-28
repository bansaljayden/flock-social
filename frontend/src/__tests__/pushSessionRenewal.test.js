/**
 * A RENEWED ACCESS TOKEN IS THE SAME PUSH SESSION.
 *
 * The push session watcher in services/firebase.js registers this device once
 * per session, and it used to tell sessions apart by the access token string.
 * The token is renewed about once a day for the same person now (services/
 * api.js, RENEWING THE SESSION), so every renewal read as a new session and the
 * next focus or return to the app sent POST /api/notifications/register again
 * for a phone already registered to that sign-in. The server's claim made the
 * repeat harmless, but it was a round trip per renewal for nothing. The watcher
 * now keys on the sign-in (lib/sessionIdentity.js signInKey): the account and
 * the moment it signed in, which a renewal keeps and an account switch does not.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false pushSessionRenewal
 */

// The same three mocks as pushSignOutAndStandDowns.test.js, for the same
// reason: each of these loads @capacitor/core, which rewrites
// window.Capacitor.isNativePlatform to answer false in jsdom and would turn the
// native path below into the web one.
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

// Plain functions, not jest.fn(impl): react-scripts sets resetMocks: true.
// Permission already granted, so the watcher registers without asking.
jest.mock('@capacitor-firebase/messaging', () => ({
  FirebaseMessaging: {
    addListener: () => Promise.resolve({ remove: () => {} }),
    checkPermissions: () => Promise.resolve({ receive: 'granted' }),
    getToken: () => Promise.resolve({ token: 'fcm-token-for-this-phone' }),
    deleteToken: () => Promise.resolve(),
    removeAllDeliveredNotifications: () => Promise.resolve(),
  },
}));

const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// For the steps that must produce a registration: wait for it rather than for
// a fixed number of turns, so a loaded machine is slower rather than red.
const waitForRegistrations = async (count) => {
  const deadline = Date.now() + 10000;
  while (registrations().length < count && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await flush(1);
  }
  await flush();
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

// The client never verifies a signature; the watcher only reads the claims.
const b64url = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwtOf = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);
const tokenFor = (userId, authTime, iat = nowS()) => jwtOf({ userId, tv: 0, auth_time: authTime, iat, exp: iat + 86400 });

const registrations = () => global.fetch.mock.calls
  .filter(([url]) => String(url).includes('/api/notifications/register'))
  .map(([, opts]) => opts.headers && opts.headers.Authorization);

beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  global.fetch = jest.fn(() => Promise.resolve(jsonRes({ ok: true })));
});
afterEach(() => { delete window.Capacitor; });

// ONE test on purpose. Every require of the push module starts a watcher that
// keeps its window listeners, so a second test's focus event would reach this
// one's instance as well and the counts below would stop meaning anything.
// The long timeout is for the first require, which transforms the push module,
// the API client and the socket client inside the test on a cold cache.
test('a renewal is not a new session, and a different sign-in is', async () => {
  const signedIn = nowS() - 3 * 86400;
  const first = tokenFor(7, signedIn, nowS() - 20 * 3600);
  localStorage.setItem('flockToken', first);
  // eslint-disable-next-line global-require
  require('../services/firebase');
  await waitForRegistrations(1);
  expect(registrations()).toEqual([`Bearer ${first}`]);

  // The same sign-in, renewed: a new token string, the same account and
  // auth_time. Coming back to the app must not register the phone again. A
  // registration it did start would be under way within these turns: nothing
  // on that path waits on a timer.
  const renewed = tokenFor(7, signedIn);
  expect(renewed).not.toBe(first);
  localStorage.setItem('flockToken', renewed);
  window.dispatchEvent(new Event('focus'));
  await flush(30);
  expect(registrations()).toHaveLength(1);

  // Somebody else signs in on the same phone: that is a new session, and the
  // phone is registered to it. The first person signs out in this page first.
  // A token for another account appearing with no sign-out here is another
  // tab's session, which this page no longer sends anything with
  // (services/api.js, WHOSE TAB THIS IS; crossTabAccountSwitch.test.js).
  // eslint-disable-next-line global-require
  require('../services/api').clearLocalSession();
  const other = tokenFor(8, nowS());
  localStorage.setItem('flockToken', other);
  window.dispatchEvent(new Event('focus'));
  await waitForRegistrations(2);
  expect(registrations()).toEqual([`Bearer ${first}`, `Bearer ${other}`]);

  // And the first account signing in again, after that, is a new sign-in too
  // (a new auth_time), even though the account is one this phone has seen.
  const again = tokenFor(7, nowS() + 1);
  localStorage.setItem('flockToken', again);
  window.dispatchEvent(new Event('focus'));
  await waitForRegistrations(3);
  expect(registrations()).toEqual([`Bearer ${first}`, `Bearer ${other}`, `Bearer ${again}`]);
}, 30000);
