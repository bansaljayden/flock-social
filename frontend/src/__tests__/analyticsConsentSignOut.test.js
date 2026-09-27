/**
 * THE ANALYTICS ANSWER, ACROSS A SIGN-OUT.
 *
 * Two defects with one cause. The answer to the analytics bar is stored under
 * flock_analytics_consent, and the sign-out sweep in services/api.js removes
 * every flock* key it has not been told to keep. So:
 *
 *   1. Every sign-out, and every 24h token expiry (nothing renews the token),
 *      deleted the answer, and the bar asked again on the next launch. The
 *      banner's own promise is that declining is remembered and the bar does
 *      not come back.
 *   2. clearLocalSession swept first and then asked withPostHog for a reset.
 *      withPostHog reads consent at the moment it is called, found it gone,
 *      and returned. posthog.reset() never ran, the SDK kept the last
 *      account's identified id (ph_*_posthog is not a flock* key), and the
 *      next yes on that page initialised straight back into it. On a shared
 *      phone the next person was recorded as the last one.
 *
 * And the gap the second one hid: in the app the question is asked after
 * sign-in, so the sign-in's identify had already been dropped at the consent
 * gate, and a yes left the account anonymous until its next sign-in.
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

jest.mock('posthog-js', () => ({
  __esModule: true,
  default: {
    capture: (...args) => mockCapture(...args),
    identify: (...args) => mockIdentify(...args),
    reset: (...args) => mockReset(...args),
  },
}));

const fs = require('fs');
const path = require('path');

const api = require('../services/api');
const { readConsent, consentUnanswered, setConsent } = require('../services/analyticsConsent');

const API = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8').replace(/\r\n/g, '\n');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

// withPostHog reaches the SDK through a dynamic import, so anything it does is
// at least one microtask behind the call that asked for it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  mockCapture.mockClear();
  mockIdentify.mockClear();
  mockReset.mockClear();
  localStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve(jsonRes({})));
});

describe('the answer is the browser\'s, so a sign-out leaves it', () => {
  test('a No survives Log out, and the bar has nothing to ask', async () => {
    setConsent('no');
    localStorage.setItem('flockToken', 'tok-a');
    global.fetch.mockResolvedValue(jsonRes({ message: 'Logged out successfully' }));

    await api.logout();

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(readConsent()).toBe('no');
    expect(consentUnanswered()).toBe(false);
  });

  test('a Yes survives the daily token expiry', async () => {
    setConsent('yes');
    localStorage.setItem('flockToken', 'tok-a');
    global.fetch.mockResolvedValue(jsonRes({ error: 'Token expired' }, 401));

    await expect(api.getBlockedUsers()).rejects.toMatchObject({ sessionExpired: true });

    expect(localStorage.getItem('flockToken')).toBeNull();
    expect(readConsent()).toBe('yes');
  });

  test('it is on the keep-list by name, not kept by accident', () => {
    const m = API.match(/const KEEP_ON_SIGN_OUT = new Set\(\[([\s\S]*?)\]\);/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain("'flock_analytics_consent'");
  });
});

describe('the PostHog reset runs on every sign-out after a yes', () => {
  test('clearing the session resets the SDK', async () => {
    setConsent('yes');

    api.clearLocalSession();
    await flush();

    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  test('the reset is asked for before the sweep, so it cannot depend on what the sweep keeps', () => {
    const fn = API.slice(API.indexOf('export function clearLocalSession'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const reset = body.indexOf('withPostHog((posthog) => posthog.reset());');
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(body.indexOf('sweepStore(window.localStorage)'));
  });

  test('a No still downloads nothing and resets nothing', async () => {
    setConsent('no');

    api.clearLocalSession();
    await flush();

    expect(mockReset).not.toHaveBeenCalled();
  });
});

describe('a yes given after sign-in names the account', () => {
  test('the sign-in identify is dropped without consent, and made once consent arrives', async () => {
    global.fetch.mockResolvedValue(jsonRes({ token: 'tok-a', user: { id: 42, name: 'Sam Rivera' } }));

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
    global.fetch.mockResolvedValue(jsonRes({ user: { id: 7 } }));

    await api.getCurrentUser();
    setConsent('yes');
    api.identifySignedInUser();
    await flush();

    expect(mockIdentify).toHaveBeenCalledWith('7');
  });

  test('after a sign-out there is nobody left to name', async () => {
    localStorage.setItem('flockToken', 'tok-a');
    global.fetch.mockResolvedValue(jsonRes({ user: { id: 42 } }));
    await api.getCurrentUser();
    setConsent('yes');

    api.clearLocalSession();
    api.identifySignedInUser();
    await flush();

    expect(mockIdentify).not.toHaveBeenCalled();
  });

  test('the app entry waits for init, then identifies, and only on a yes', () => {
    expect(INDEX).toContain('<ConsentBanner onAnswer={startAnalyticsInApp} />');
    const fn = INDEX.slice(INDEX.indexOf('function startAnalyticsInApp(answer) {'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("if (answer !== 'yes' || !started) return;");
    expect(body).toMatch(/started\s*\n\s*\.then\(\(\) => import\('\.\/services\/api'\)\)\s*\n\s*\.then\(\(api\) => api\.identifySignedInUser\(\)\)/);
    // And startAnalytics hands back the promise it waits on.
    expect(INDEX).toMatch(/return import\('posthog-js'\)\.then\(\(\{ default: posthog \}\) => \{/);
  });
});
