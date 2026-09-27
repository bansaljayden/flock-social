/**
 * THE SDK AFTER A SIGN-OUT, driven through the real index.js.
 *
 * A sign-out resets PostHog and switches it off (services/api.js
 * clearLocalSession), because the SDK records page views on its own and would
 * otherwise go on recording the next person on a shared phone before they had
 * been asked. Two things then have to turn it back on, and only those two:
 *
 *   - the next account's own yes (the bar calls startAnalytics). posthog-js
 *     ignores a second init on the same page, and the opt-out is remembered
 *     across launches, so init alone never did it.
 *   - the same account signing back in on the same page, which gets its answer
 *     back without being asked (services/analyticsConsent.js, WHOSE ANSWER IT
 *     IS). Nothing taps the bar then, so index.js listens for it.
 *
 * A different account signing in starts nothing and names nobody.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

process.env.REACT_APP_POSTHOG_KEY = 'phc_consent_restart_test';
// jsdom's origin is http://localhost, which index.js refuses to report from.
process.env.REACT_APP_POSTHOG_ALLOW_LOCAL = 'true';

// index.js boots the whole page router at import time. The render is not
// under test here, so react-dom is stubbed BEFORE the import runs.
jest.mock('react-dom/client', () => ({
  createRoot: () => ({ render: () => {} }),
}));

const mockPosthog = {
  init: jest.fn(),
  capture: jest.fn(),
  identify: jest.fn(),
  reset: jest.fn(),
  opt_out_capturing: jest.fn(),
  opt_in_capturing: jest.fn(),
  has_opted_out_capturing: jest.fn(() => false),
};
jest.mock('posthog-js', () => ({ __esModule: true, default: mockPosthog }));

let index;
let api;
let consent;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const flushAll = async () => { for (let i = 0; i < 5; i += 1) await flush(); };

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function signIn(id) {
  global.fetch.mockResolvedValueOnce(jsonRes({ token: `tok-${id}`, user: { id } }));
  await api.login(`user${id}@example.com`, 'correct horse battery');
  await flushAll();
}

async function signOut() {
  global.fetch.mockResolvedValueOnce(jsonRes({ message: 'Logged out successfully' }));
  await api.logout();
  await flushAll();
  // What the real SDK answers after opt_out_capturing.
  mockPosthog.has_opted_out_capturing.mockReturnValue(true);
}

function clearMocks() {
  Object.values(mockPosthog).forEach((fn) => fn.mockClear());
}

beforeAll(async () => {
  localStorage.clear();
  index = require('../index');
  api = require('../services/api');
  consent = require('../services/analyticsConsent');
  // Let the boot's own deferred work (the app-open event) run out first.
  await flushAll();
});

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve(jsonRes({})));
  api.clearLocalSession();
  consent.restoreConsentFor(null);
  mockPosthog.has_opted_out_capturing.mockReset();
  mockPosthog.has_opted_out_capturing.mockReturnValue(false);
  clearMocks();
});

test('a yes that comes back with the same account starts capture again and names the account', async () => {
  await signIn(42);
  consent.setConsent('yes');
  await index.startAnalytics();
  expect(mockPosthog.init).toHaveBeenCalledTimes(1);

  await signOut();
  expect(mockPosthog.reset).toHaveBeenCalledTimes(1);
  expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
  clearMocks();

  await signIn(42);

  expect(consent.readConsent()).toBe('yes');
  expect(mockPosthog.opt_in_capturing).toHaveBeenCalledTimes(1);
  // No $opt_in event: the answer is not itself something to record.
  expect(mockPosthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
  // Named after capture is back on, so the identify is not dropped.
  const lastIdentify = mockPosthog.identify.mock.invocationCallOrder.slice(-1)[0];
  expect(mockPosthog.identify).toHaveBeenLastCalledWith('42');
  expect(lastIdentify).toBeGreaterThan(mockPosthog.opt_in_capturing.mock.invocationCallOrder[0]);
});

test('a different account signing in after that yes starts nothing and names nobody', async () => {
  await signIn(42);
  consent.setConsent('yes');
  await index.startAnalytics();
  await signOut();
  clearMocks();

  await signIn(77);

  expect(consent.consentUnanswered()).toBe(true);
  expect(mockPosthog.init).not.toHaveBeenCalled();
  expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
  expect(mockPosthog.identify).not.toHaveBeenCalled();
  expect(mockPosthog.capture).not.toHaveBeenCalled();
});

test('the next account\'s own yes turns capture back on', async () => {
  await signIn(42);
  consent.setConsent('yes');
  await index.startAnalytics();
  await signOut();
  await signIn(77);
  clearMocks();

  // What the bar does with a yes.
  consent.setConsent('yes');
  await index.startAnalytics();

  expect(mockPosthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
});

test('a start that finds capture already on leaves it alone', async () => {
  consent.setConsent('yes');

  await index.startAnalytics();

  expect(mockPosthog.init).toHaveBeenCalledTimes(1);
  expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
});
