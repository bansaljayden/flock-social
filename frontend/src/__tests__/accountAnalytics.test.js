/**
 * IN THE APP, ANALYTICS FOLLOWS THE ACCOUNT'S OWN SETTING.
 *
 * The app asks no analytics question on screen. Signed-in product analytics is
 * part of the service agreed to at signup, and the account switches it off in
 * Settings (You, Share usage analytics), where the answer is kept on the
 * server (GET and PUT /api/users/me/analytics). Driven here through the real
 * index.js booted at /app, the real services/api.js and a stand-in PostHog:
 *
 *   - signed out, nothing: no read of the setting, no SDK, no event
 *   - signed in, nothing is sent before the account's answer is known; what
 *     was captured meanwhile is held, and goes only once the answer is on
 *   - on: PostHog starts with the memory config (nothing stored on the
 *     device), the account is named by its number, then the held captures
 *   - off: PostHog is never started for that account
 *   - an explicit "no" left on the device by the old question is moved onto
 *     the account once, then removed from the device, and nothing is sent
 *   - sign-out and the Settings switch stop PostHog without writing a record
 *     of the choice, and switching off clears what PostHog kept
 *   - an explicit yes from the website's bar keeps the local-storage config
 *
 * posthog-js's own storage behaviour under the memory config is pinned against
 * the real SDK in analyticsPrivacy.test.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false accountAnalytics
 */

process.env.REACT_APP_POSTHOG_KEY = 'phc_account_analytics_test';
// jsdom's origin is http://localhost, which index.js refuses to report from.
process.env.REACT_APP_POSTHOG_ALLOW_LOCAL = 'true';

jest.mock('react-dom/client', () => ({
  createRoot: () => ({ render: () => {} }),
}));

// Measured only once analytics runs for the account; stubbed so the real
// web-vitals never attaches to jsdom.
const mockReportWebVitals = jest.fn();
jest.mock('../reportWebVitals', () => ({
  __esModule: true,
  default: (...args) => mockReportWebVitals(...args),
}));

const mockPosthog = {
  init: jest.fn(),
  capture: jest.fn(),
  identify: jest.fn(),
  reset: jest.fn(),
  set_config: jest.fn(),
  opt_out_capturing: jest.fn(),
  opt_in_capturing: jest.fn(),
  has_opted_out_capturing: jest.fn(),
};
jest.mock('posthog-js', () => ({ __esModule: true, default: mockPosthog }));

const KEY = process.env.REACT_APP_POSTHOG_KEY;
const ANALYTICS = '/api/users/me/analytics';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const flushAll = async () => { for (let i = 0; i < 8; i += 1) await flush(); };

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// The server: one analytics_opt_out per account, FALSE unless set.
let serverOptOut;
let calls;
let answers;
let signingInAs;

function fetchRouter(url, opts = {}) {
  const u = new URL(url);
  const key = `${String(opts.method || 'GET').toUpperCase()} ${u.pathname}`;
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ key, body });
  if (answers[key]) return answers[key](body);
  switch (key) {
    case 'POST /api/auth/login':
      return Promise.resolve(jsonRes({ token: `tok-${signingInAs}`, user: { id: signingInAs } }));
    case 'GET /api/auth/me':
      return Promise.resolve(jsonRes({ user: { id: signingInAs } }));
    case `GET ${ANALYTICS}`:
      return Promise.resolve(jsonRes({ optOut: serverOptOut.get(signingInAs) === true }));
    case `PUT ${ANALYTICS}`:
      serverOptOut.set(signingInAs, body.optOut);
      return Promise.resolve(jsonRes({ optOut: body.optOut }));
    default:
      return Promise.resolve(jsonRes({}));
  }
}

const analyticsCalls = () => calls.filter((c) => c.key.endsWith(ANALYTICS));
const captured = () => mockPosthog.capture.mock.calls.map(([event]) => event);
const clearSdk = () => Object.values(mockPosthog).forEach((fn) => fn.mockClear());

// The app, as a fresh page load at `path`: index.js registers the account
// driver there, and api.js and the consent module are this page's own.
async function boot(path = '/app') {
  window.history.pushState({}, '', path);
  let mods;
  jest.isolateModules(() => {
    mods = {
      index: require('../index'),
      api: require('../services/api'),
      consent: require('../services/analyticsConsent'),
    };
  });
  // index.js's own deferred work runs out first; it is not under test here.
  await flushAll();
  clearSdk();
  mockReportWebVitals.mockClear();
  calls.length = 0;
  return mods;
}

async function signIn(api, id) {
  signingInAs = id;
  await api.login(`user${id}@example.com`, 'correct horse battery');
  await flushAll();
}

async function signOut(api) {
  await api.logout();
  await flushAll();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  serverOptOut = new Map();
  calls = [];
  answers = {};
  signingInAs = null;
  global.fetch = jest.fn(fetchRouter);
  process.env.REACT_APP_POSTHOG_ALLOW_LOCAL = 'true';
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('signed out, the app sends nothing', () => {
  test('no read of the setting, no SDK and no event on the sign-in screens', async () => {
    const { api, consent } = await boot();
    expect(consent.analyticsFollowsAccount()).toBe(true);

    api.trackAuthScreen('login');
    api.trackScreenView('home');
    api.trackAppOpened('web');
    await flushAll();

    expect(analyticsCalls()).toEqual([]);
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
  });
});

describe('signed in, the account\'s own setting decides', () => {
  test('nothing is sent before the answer; on, PostHog starts in memory, names the account, then sends what it held', async () => {
    const { api, index } = await boot();
    const gate = deferred();
    answers[`GET ${ANALYTICS}`] = () => gate.promise;

    await signIn(api, 42);
    api.trackScreenView('home');
    await flushAll();

    // Asked for, and nothing has gone anywhere while the answer is out.
    expect(analyticsCalls().map((c) => c.key)).toEqual([`GET ${ANALYTICS}`]);
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockReportWebVitals).not.toHaveBeenCalled();

    gate.resolve(jsonRes({ optOut: false }));
    await flushAll();

    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    expect(mockPosthog.init.mock.calls[0][0]).toBe(KEY);
    // The memory config itself: nothing stored on the device for it.
    expect(mockPosthog.init.mock.calls[0][1]).toBe(index.POSTHOG_SIGNED_IN_CONFIG);
    expect(mockPosthog.identify).toHaveBeenCalledTimes(1);
    expect(mockPosthog.identify).toHaveBeenCalledWith('42');
    // What was held, in the order it happened, after the account was named.
    expect(captured()).toEqual(['login', 'screen_viewed']);
    expect(mockPosthog.identify.mock.invocationCallOrder[0])
      .toBeLessThan(Math.min(...mockPosthog.capture.mock.invocationCallOrder));
    expect(mockReportWebVitals).toHaveBeenCalledTimes(1);

    // From then on, straight through.
    api.trackScreenView('plans');
    await flushAll();
    expect(captured()).toEqual(['login', 'screen_viewed', 'screen_viewed']);

    // And never a written record of the choice.
    expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
    expect(mockPosthog.opt_out_capturing).not.toHaveBeenCalled();
  });

  test('an account that switched it off never starts PostHog', async () => {
    const { api } = await boot();
    serverOptOut.set(42, true);

    await signIn(api, 42);
    api.trackScreenView('home');
    api.trackAppOpened('web');
    await flushAll();

    expect(analyticsCalls().map((c) => c.key)).toEqual([`GET ${ANALYTICS}`]);
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockReportWebVitals).not.toHaveBeenCalled();
  });

  test('a launch on a stored session holds its first event until the answer arrives', async () => {
    localStorage.setItem('flockToken', 'tok-42');
    signingInAs = 42;
    const { api } = await boot();

    // What index.js sends once the page has loaded, before anyone knows whose
    // session it is.
    api.trackAppOpened('web');
    await flushAll();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    await api.getCurrentUser();
    await flushAll();

    expect(analyticsCalls().map((c) => c.key)).toEqual([`GET ${ANALYTICS}`]);
    expect(mockPosthog.identify).toHaveBeenCalledWith('42');
    expect(captured()).toEqual(['app_opened']);
  });

  test('a read that fails sends nothing, and the next read decides', async () => {
    const { api } = await boot();
    answers[`GET ${ANALYTICS}`] = () => Promise.resolve(jsonRes({ error: 'down' }, 400));

    await signIn(api, 42);
    api.trackScreenView('home');
    await flushAll();
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    delete answers[`GET ${ANALYTICS}`];
    await expect(api.getAnalyticsChoice()).resolves.toEqual({ optOut: false });
    await flushAll();
    expect(mockPosthog.identify).toHaveBeenCalledWith('42');
    expect(captured()).toEqual(['login', 'screen_viewed']);
  });
});

describe('an explicit no left on the device by the old question', () => {
  test('is moved onto the account once, removed from the device, and nothing is sent', async () => {
    localStorage.setItem('flock_analytics_consent', 'no');
    const { api } = await boot();

    await signIn(api, 42);
    api.trackScreenView('home');
    await flushAll();

    expect(analyticsCalls()).toEqual([{ key: `PUT ${ANALYTICS}`, body: { optOut: true } }]);
    expect(serverOptOut.get(42)).toBe(true);
    expect(localStorage.getItem('flock_analytics_consent')).toBeNull();
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    // The next sign-in reads the account and writes nothing.
    await signOut(api);
    calls.length = 0;
    await signIn(api, 42);
    expect(analyticsCalls().map((c) => c.key)).toEqual([`GET ${ANALYTICS}`]);
    expect(mockPosthog.init).not.toHaveBeenCalled();
  });

  test('a move that fails keeps the no on the device and sends nothing', async () => {
    localStorage.setItem('flock_analytics_consent', 'no');
    answers[`PUT ${ANALYTICS}`] = () => Promise.resolve(jsonRes({ error: 'Failed' }, 500));
    const { api } = await boot();

    await signIn(api, 42);
    api.trackScreenView('home');
    await flushAll();

    expect(localStorage.getItem('flock_analytics_consent')).toBe('no');
    expect(analyticsCalls().map((c) => c.key)).toEqual([`PUT ${ANALYTICS}`]);
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });
});

describe('stopping writes no record, and the next account starts for itself', () => {
  test('sign-out resets and switches capture off in memory; the next account is started again and named', async () => {
    const { api } = await boot();
    await signIn(api, 42);
    expect(mockPosthog.init).toHaveBeenCalledTimes(1);

    await signOut(api);
    expect(mockPosthog.reset).toHaveBeenCalledTimes(1);
    // A new device id as well: the next account on this phone is not linked.
    expect(mockPosthog.reset).toHaveBeenCalledWith(true);
    expect(mockPosthog.set_config).toHaveBeenLastCalledWith({ persistence: 'memory', opt_out_capturing_by_default: true });
    expect(mockPosthog.opt_out_capturing).not.toHaveBeenCalled();

    mockPosthog.capture.mockClear();
    api.trackScreenView('home');
    await flushAll();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    mockPosthog.identify.mockClear();
    await signIn(api, 77);
    // One init per page; the next account is switched back on in memory.
    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    expect(mockPosthog.set_config).toHaveBeenLastCalledWith({ persistence: 'memory', opt_out_capturing_by_default: false });
    expect(mockPosthog.identify).toHaveBeenCalledWith('77');
    expect(mockPosthog.identify).not.toHaveBeenCalledWith('42');
    expect(captured()).toEqual(['login']);
    expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
  });

  test('what older builds left behind is removed before the first start, and nothing unrelated is touched', async () => {
    localStorage.setItem(`__ph_opt_in_out_${KEY}`, '0');
    localStorage.setItem(`ph_${KEY}_posthog`, '{"distinct_id":"from-an-old-build"}');
    sessionStorage.setItem(`ph_${KEY}_window_id`, 'w');
    localStorage.setItem('flock-theme', 'dark');
    let atInit = null;
    mockPosthog.init.mockImplementation(() => {
      atInit = [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.includes(KEY));
    });
    const { api } = await boot();

    await signIn(api, 42);

    expect(atInit).toEqual([]);
    expect(localStorage.getItem('flock-theme')).toBe('dark');
  });
});

describe('a sign-out on a page where PostHog never started', () => {
  test('still clears what an earlier page left on the device', async () => {
    // An earlier page ran under a website yes and saved the account in
    // PostHog's record; this page reads the account as off, so PostHog never
    // starts here. Signing out must not leave that record for the next
    // anonymous visitor to load.
    localStorage.setItem('flock_analytics_consent', 'yes');
    serverOptOut.set(42, true);
    const { api } = await boot();
    await signIn(api, 42);
    expect(mockPosthog.init).not.toHaveBeenCalled();
    localStorage.setItem(`ph_${KEY}_posthog`, '{"distinct_id":"42"}');
    localStorage.setItem('unrelated_key', 'kept');

    await signOut(api);

    expect(localStorage.getItem(`ph_${KEY}_posthog`)).toBeNull();
    expect(localStorage.getItem('unrelated_key')).toBe('kept');
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });
});

describe('an explicit yes from the website\'s bar', () => {
  test('keeps the local-storage config it agreed to', async () => {
    localStorage.setItem('flock_analytics_consent', 'yes');
    const { api, index } = await boot();

    await signIn(api, 42);

    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    expect(mockPosthog.init.mock.calls[0][1]).toBe(index.POSTHOG_PRIVACY_CONFIG);
    expect(mockPosthog.identify).toHaveBeenCalledWith('42');
  });
});

describe('the Settings switch', () => {
  test('off stops PostHog at the tap, before the server answers, and clears what it held', async () => {
    localStorage.setItem('flock_analytics_consent', 'yes');
    const { api } = await boot();
    await signIn(api, 42);
    // What PostHog keeps under an explicit yes.
    localStorage.setItem(`ph_${KEY}_posthog`, '{"distinct_id":"42"}');
    clearSdk();

    const put = deferred();
    answers[`PUT ${ANALYTICS}`] = (body) => { serverOptOut.set(42, body.optOut); return put.promise; };
    const pending = api.setAnalyticsChoice(true);
    await flushAll();

    // Before the answer: reset, capture off in memory, PostHog's keys gone.
    expect(mockPosthog.reset).toHaveBeenCalledTimes(1);
    // A new device id as well: the next account on this phone is not linked.
    expect(mockPosthog.reset).toHaveBeenCalledWith(true);
    expect(mockPosthog.set_config).toHaveBeenLastCalledWith({ persistence: 'memory', opt_out_capturing_by_default: true });
    expect(localStorage.getItem(`ph_${KEY}_posthog`)).toBeNull();
    api.trackScreenView('home');
    await flushAll();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    put.resolve(jsonRes({ optOut: true }));
    await expect(pending).resolves.toEqual({ optOut: true });
    expect(calls.filter((c) => c.key === `PUT ${ANALYTICS}`).map((c) => c.body)).toEqual([{ optOut: true }]);
    // The account holds the answer now, not the device.
    expect(localStorage.getItem('flock_analytics_consent')).toBeNull();
    expect(api.knownAnalyticsChoice()).toEqual({ optOut: true });
    expect(mockPosthog.opt_out_capturing).not.toHaveBeenCalled();
  });

  test('off while the sign-in read is still in flight: that read\'s "on" is dropped and nothing starts', async () => {
    const { api } = await boot();
    const get = deferred();
    answers[`GET ${ANALYTICS}`] = () => get.promise;
    await signIn(api, 42);
    expect(analyticsCalls().map((c) => c.key)).toEqual([`GET ${ANALYTICS}`]);

    const put = deferred();
    answers[`PUT ${ANALYTICS}`] = (body) => { serverOptOut.set(42, body.optOut); return put.promise; };
    const pending = api.setAnalyticsChoice(true);
    await flushAll();

    // The read that began before the tap answers "on" first.
    get.resolve(jsonRes({ optOut: false }));
    await flushAll();
    api.trackScreenView('home');
    await flushAll();
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(api.knownAnalyticsChoice()).toEqual({ optOut: true });

    put.resolve(jsonRes({ optOut: true }));
    await expect(pending).resolves.toEqual({ optOut: true });
    await flushAll();
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  test('an off that does not save keeps this page off, even when the switch reads on again', async () => {
    const { api } = await boot();
    await signIn(api, 42);
    expect(mockPosthog.identify).toHaveBeenCalledWith('42');
    clearSdk();

    answers[`PUT ${ANALYTICS}`] = () => Promise.resolve(jsonRes({ error: 'Failed to update the analytics setting' }, 500));
    await expect(api.setAnalyticsChoice(true)).rejects.toBeTruthy();
    await flushAll();
    // The account still says on, and the switch's own fresh read says so.
    await expect(api.getAnalyticsChoice()).resolves.toEqual({ optOut: false });
    await flushAll();
    api.trackScreenView('home');
    await flushAll();
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.identify).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    // An on the server accepts is the way back.
    delete answers[`PUT ${ANALYTICS}`];
    await expect(api.setAnalyticsChoice(false)).resolves.toEqual({ optOut: false });
    await flushAll();
    expect(mockPosthog.identify).toHaveBeenCalledWith('42');
  });

  test('on starts again once the server agrees, in memory, and names the account', async () => {
    serverOptOut.set(42, true);
    const { api } = await boot();
    await signIn(api, 42);
    expect(mockPosthog.init).not.toHaveBeenCalled();

    await expect(api.setAnalyticsChoice(false)).resolves.toEqual({ optOut: false });
    await flushAll();

    expect(calls.filter((c) => c.key === `PUT ${ANALYTICS}`).map((c) => c.body)).toEqual([{ optOut: false }]);
    expect(serverOptOut.get(42)).toBe(false);
    expect(mockPosthog.init).toHaveBeenCalledTimes(1);
    expect(mockPosthog.identify).toHaveBeenCalledWith('42');
    api.trackScreenView('home');
    await flushAll();
    expect(captured()).toEqual(['screen_viewed']);
    expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
  });

  test('on that the server refuses changes nothing', async () => {
    serverOptOut.set(42, true);
    const { api } = await boot();
    await signIn(api, 42);
    answers[`PUT ${ANALYTICS}`] = () => Promise.resolve(jsonRes({ error: 'Failed to update the analytics setting' }, 500));

    await expect(api.setAnalyticsChoice(false)).rejects.toBeTruthy();
    await flushAll();
    api.trackScreenView('home');
    await flushAll();

    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });
});

describe('where analytics cannot run at all', () => {
  test('a dev origin does not even ask the server', async () => {
    delete process.env.REACT_APP_POSTHOG_ALLOW_LOCAL;
    const { api, consent } = await boot();
    expect(consent.analyticsFollowsAccount()).toBe(true);
    expect(consent.accountAnalyticsCanRun()).toBe(false);

    await signIn(api, 42);
    api.trackScreenView('home');
    await flushAll();

    expect(analyticsCalls()).toEqual([]);
    expect(mockPosthog.init).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });
});
