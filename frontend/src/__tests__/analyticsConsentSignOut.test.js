/**
 * THE ANALYTICS ANSWER, ACROSS A SIGN-OUT, ON THE WEBSITE'S OWN PAGES.
 *
 * The answer to the website's analytics bar is stored under
 * flock_analytics_consent. Once somebody is signed in it is consent for an
 * ACCOUNT's activity (the events carry the account number), and three things
 * went wrong with it:
 *
 *   1. The sign-out sweep in services/api.js removed it, so every sign-out and
 *      every 24h token expiry asked again, including the person who had said
 *      no, against the bar's promise that declining is remembered.
 *   2. clearLocalSession swept first and then asked withPostHog for a reset,
 *      which read the consent the sweep had just deleted and returned, so the
 *      SDK kept the last account's identified id.
 *   3. The first fix for (1) kept the key across sign-out, which handed one
 *      account's yes to the next account on the same phone: B signed in, was
 *      identified to PostHog by account id on A's answer, and never saw the bar.
 *
 * The rule pinned here: an answer is good for the account that gave it and for
 * nobody else. It leaves with the session; the same account signing in again
 * on the same page gets it back without being asked, from a copy held in
 * memory only; any other account is asked, and nothing is identified or
 * captured for it until it answers. The SDK itself is reset and switched off
 * at every sign-out, because it records page views on its own.
 *
 * analyticsConsentRestart.test.js drives the other half, index.js starting the
 * SDK again for a yes that comes back.
 *
 * None of this is the app's rule any more. The app routes mount no bar: the
 * signed-in account's own setting decides there, and accountAnalytics.test.js
 * holds that. This file loads services/api.js without index.js, which is
 * exactly a page that is not the app, so the bar's rules are what it sees.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

// A key must be present for withPostHog to do anything, and posthog-js must
// never be the real one.
process.env.REACT_APP_POSTHOG_KEY = 'phc_consent_sign_out_test';

const mockCapture = jest.fn();
const mockIdentify = jest.fn();
const mockReset = jest.fn();
const mockOptOut = jest.fn();

jest.mock('posthog-js', () => ({
  __esModule: true,
  default: {
    capture: (...args) => mockCapture(...args),
    identify: (...args) => mockIdentify(...args),
    reset: (...args) => mockReset(...args),
    opt_out_capturing: (...args) => mockOptOut(...args),
  },
}));

const React = require('react');
const { act, render } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');

const api = require('../services/api');
const consent = require('../services/analyticsConsent');
const ConsentBanner = require('../components/ConsentBanner').default;

const { readConsent, consentUnanswered, setConsent } = consent;

const API = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8').replace(/\r\n/g, '\n');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

// withPostHog reaches the SDK through a dynamic import, so anything it does is
// at least one microtask behind the call that asked for it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A token shaped like the server's (backend/middleware/auth.js signUserToken):
// { userId, tv, iat, exp }. The signature is never checked on the device.
function jwtFor(userId, expSeconds) {
  const b64url = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ userId, tv: 0, iat: expSeconds - 86400, exp: expSeconds })}.sig`;
}

async function signIn(id) {
  global.fetch.mockResolvedValueOnce(jsonRes({ token: jwtFor(id, Math.floor(Date.now() / 1000) + 86400), user: { id } }));
  await api.login(`user${id}@example.com`, 'correct horse battery');
  await flush();
}

async function signOut() {
  global.fetch.mockResolvedValueOnce(jsonRes({ message: 'Logged out successfully' }));
  await api.logout();
  await flush();
}

function mountNav(height) {
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.getBoundingClientRect = () => ({ height, width: 390, top: 0, left: 0, right: 390, bottom: height });
  (document.getElementById('root') || document.body).appendChild(nav);
  return nav;
}

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve(jsonRes({})));
  // api.js and analyticsConsent.js keep who is signed in and any held answer
  // in module state. Start every case from nobody signed in and nothing held.
  api.clearLocalSession();
  consent.restoreConsentFor(null);
  mockCapture.mockClear();
  mockIdentify.mockClear();
  mockReset.mockClear();
  mockOptOut.mockClear();
});

afterEach(() => {
  delete window.Capacitor;
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--cb-height');
});

describe('an answer is the account\'s, so the next account is asked for itself', () => {
  test('A says yes and signs out; B signs in, is not identified, sends nothing, and is asked', async () => {
    await signIn(42);
    setConsent('yes');
    api.identifySignedInUser();
    await flush();
    expect(mockIdentify).toHaveBeenLastCalledWith('42');

    await signOut();
    expect(readConsent()).toBeNull();
    mockCapture.mockClear();
    mockIdentify.mockClear();

    await signIn(77);

    expect(consentUnanswered()).toBe(true);
    expect(mockIdentify).not.toHaveBeenCalled();
    // The login event, and anything else, stays on the device.
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test('a no is not handed on either: B is asked, not answered for', async () => {
    await signIn(42);
    setConsent('no');
    await signOut();

    await signIn(77);

    expect(consentUnanswered()).toBe(true);
  });

  test('the key is off the keep-list by name', () => {
    const m = API.match(/const KEEP_ON_SIGN_OUT = new Set\(\[([\s\S]*?)\]\);/);
    expect(m).not.toBeNull();
    expect(m[1]).not.toContain('flock_analytics_consent');
  });
});

describe('the same account signing back in on this page is not asked again', () => {
  test('a no comes back to the account that gave it', async () => {
    await signIn(42);
    setConsent('no');
    await signOut();
    expect(consentUnanswered()).toBe(true);

    await signIn(42);

    expect(readConsent()).toBe('no');
  });

  test('a yes comes back too, and the account is named again', async () => {
    await signIn(42);
    setConsent('yes');
    await signOut();
    mockIdentify.mockClear();

    await signIn(42);

    expect(readConsent()).toBe('yes');
    expect(mockIdentify).toHaveBeenCalledWith('42');
  });

  test('the daily expiry: a boot that finds the session dead holds the answer for the account its token names', async () => {
    // Stored by a session on an earlier launch. Nothing in this page load has
    // heard from the server about whose it is.
    localStorage.setItem('flockToken', jwtFor(42, Math.floor(Date.now() / 1000) - 3600));
    localStorage.setItem('flock_analytics_consent', 'no');
    global.fetch.mockResolvedValueOnce(jsonRes({ error: 'Token expired' }, 401));

    await expect(api.getCurrentUser()).rejects.toMatchObject({ sessionExpired: true });
    // App.js endSession answers the expiry with logout(), by which time the
    // token is gone. That second clear must not drop what the first one held.
    await api.logout();
    expect(consentUnanswered()).toBe(true);

    await signIn(42);

    expect(readConsent()).toBe('no');
  });

  test('the same dead boot, and somebody else signs in: they are asked', async () => {
    localStorage.setItem('flockToken', jwtFor(42, Math.floor(Date.now() / 1000) - 3600));
    localStorage.setItem('flock_analytics_consent', 'yes');
    global.fetch.mockResolvedValueOnce(jsonRes({ error: 'Token expired' }, 401));
    await expect(api.getCurrentUser()).rejects.toMatchObject({ sessionExpired: true });
    await api.logout();
    mockIdentify.mockClear();

    await signIn(77);

    expect(consentUnanswered()).toBe(true);
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  test('an answer given at the device after the sign-out wins over the held one', async () => {
    await signIn(42);
    setConsent('no');
    await signOut();
    // The web bar on a page of the site, answered before signing in.
    setConsent('yes');

    await signIn(42);

    expect(readConsent()).toBe('yes');
  });

  test('the hold is memory only: nothing on the device names the account that signed out', async () => {
    await signIn(42);
    setConsent('yes');
    await signOut();

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      expect(key.startsWith('flock')).toBe(false);
      expect(localStorage.getItem(key)).not.toContain('42');
    }
  });
});

describe('the SDK is reset and switched off at every sign-out after a yes', () => {
  test('clearing the session resets the SDK, then opts it out', async () => {
    setConsent('yes');

    api.clearLocalSession();
    await flush();

    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockOptOut).toHaveBeenCalledTimes(1);
    // A reset clears the SDK's opt state, so the opt-out has to come second.
    expect(mockReset.mock.invocationCallOrder[0]).toBeLessThan(mockOptOut.mock.invocationCallOrder[0]);
  });

  test('both are asked for before the sweep, so the consent gate still sees the answer', () => {
    const fn = API.slice(API.indexOf('export function clearLocalSession'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const ask = body.indexOf('withPostHog((posthog) => {');
    expect(ask).toBeGreaterThan(-1);
    // reset(true): a new device id too, so the next person is not linked.
    expect(body.slice(ask, ask + 400)).toMatch(/posthog\.reset\(true\);\s*\n\s*posthog\.opt_out_capturing\(\);/);
    expect(ask).toBeLessThan(body.indexOf('sweepStore(window.localStorage)'));
    // And the answer is held before the sweep takes it.
    expect(body.indexOf('holdConsentAtSignOut(')).toBeLessThan(body.indexOf('sweepStore(window.localStorage)'));
  });

  test('a No still downloads nothing and resets nothing', async () => {
    setConsent('no');

    api.clearLocalSession();
    await flush();

    expect(mockReset).not.toHaveBeenCalled();
    expect(mockOptOut).not.toHaveBeenCalled();
  });
});

describe('the bar opens again for the next account', () => {
  test('inside the native app it never opens, before or after an account changes', async () => {
    // The app asks no analytics question; the old in-app bar waited for the
    // tab bar and appeared above it. It renders nothing there now.
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
    await signIn(42);
    const { container } = render(React.createElement(ConsentBanner, { onAnswer: () => {} }));
    let nav;
    await act(async () => { nav = mountNav(89); });
    await settle();
    expect(consentUnanswered()).toBe(true);
    expect(container.querySelector('.cb-wrap')).toBeNull();

    await act(async () => { nav.remove(); await signOut(); });
    await act(async () => { await signIn(77); mountNav(89); });
    await settle();
    expect(container.querySelector('.cb-wrap')).toBeNull();
  });

  test('on the website: the bar is back at once after a sign-out, and leaves when the same account signs in', async () => {
    await signIn(42);
    setConsent('yes');
    const { container } = render(React.createElement(ConsentBanner, { onAnswer: () => {} }));
    expect(container.querySelector('.cb-wrap')).toBeNull();

    await act(async () => { await signOut(); });
    await settle();
    expect(container.querySelector('.cb-wrap')).not.toBeNull();

    await act(async () => { await signIn(42); });
    await settle();
    expect(container.querySelector('.cb-wrap')).toBeNull();
  });
});

describe('a yes given after sign-in names the account', () => {
  test('the sign-in identify is dropped without consent, and made once consent arrives', async () => {
    global.fetch.mockResolvedValueOnce(jsonRes({ token: 'tok-a', user: { id: 42, name: 'Sam Rivera' } }));

    // Signing in before anybody has answered the bar.
    await api.login('sam@example.com', 'correct horse battery');
    await flush();
    expect(mockIdentify).not.toHaveBeenCalled();

    // The bar is answered, and index.js calls this once init has run.
    setConsent('yes');
    api.identifySignedInUser();
    await flush();

    expect(mockIdentify).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledWith('42');
  });

  test('a boot on a stored session knows whose it is too, though it never signs in', async () => {
    localStorage.setItem('flockToken', 'tok-a');
    global.fetch.mockResolvedValueOnce(jsonRes({ user: { id: 7 } }));

    await api.getCurrentUser();
    setConsent('yes');
    api.identifySignedInUser();
    await flush();

    expect(mockIdentify).toHaveBeenCalledWith('7');
  });

  test('after a sign-out there is nobody left to name', async () => {
    localStorage.setItem('flockToken', 'tok-a');
    global.fetch.mockResolvedValueOnce(jsonRes({ user: { id: 42 } }));
    await api.getCurrentUser();
    setConsent('yes');

    api.clearLocalSession();
    setConsent('yes');
    api.identifySignedInUser();
    await flush();

    expect(mockIdentify).not.toHaveBeenCalled();
  });

  test('a yes that comes back on a website page waits for init, then identifies', () => {
    // The app mounts no bar and has no handler for one.
    expect(INDEX).not.toContain('startAnalyticsInApp');
    const fn = INDEX.slice(INDEX.indexOf('function startAnalyticsForReturningYes() {'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('if (!hasAnalyticsConsent()) return;');
    expect(body).toMatch(/started\s*\n\s*\.then\(\(\) => import\('\.\/services\/api'\)\)\s*\n\s*\.then\(\(api\) => api\.identifySignedInUser\(\)\)/);
    // Registered for every route but the app's.
    expect(INDEX).toMatch(/\} else \{\s*\n\s*onConsentChange\(startAnalyticsForReturningYes\);/);
    // And startAnalytics hands back the promise it waits on.
    expect(INDEX).toMatch(/return initPostHog\(true\)\.then\(\(posthog\) => \{/);
  });
});
