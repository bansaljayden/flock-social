/**
 * WHERE THE ANALYTICS BAR IS, AND WHERE IT IS NOT.
 *
 * The app asks no analytics question on screen. Signed-in product analytics is
 * part of the service agreed to at signup, and the account switches it off in
 * Settings (You, Share usage analytics), where the answer is kept on the
 * server. So the bar is not mounted on the app routes, on the web or in the
 * iOS shell, and the app routes hand analytics to the account's own setting
 * instead (services/analyticsConsent.js, followAccountForAnalytics).
 *
 * The website is unchanged: an anonymous visitor to the marketing site, a
 * legal page, a guest invite or a standalone page has agreed to nothing, so
 * the bar is mounted there and nothing runs without a yes.
 *
 * This drives the real index.js at each path, with react-dom's root stubbed
 * so the element tree it renders can be read, rather than scanning its text.
 * The bar component itself is in consentBannerNotInApp.test.js, which needs
 * the real react-dom this file stubs.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false analyticsBarRoutes
 */
const mockRendered = [];
jest.mock('react-dom/client', () => ({
  createRoot: () => ({ render: (element) => { mockRendered.push(element); } }),
}));

const IOS = { isNativePlatform: () => true, getPlatform: () => 'ios' };

// Every element in a tree, without rendering it.
function elementsIn(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => elementsIn(child, out));
    return out;
  }
  if (!node || typeof node !== 'object' || !node.props) return out;
  out.push(node);
  elementsIn(node.props.children, out);
  return out;
}

function boot(path, { native = false } = {}) {
  mockRendered.length = 0;
  window.history.pushState({}, '', path);
  if (native) window.Capacitor = IOS;
  let consent;
  jest.isolateModules(() => {
    require('../index');
    consent = require('../services/analyticsConsent');
  });
  expect(mockRendered).toHaveLength(1);
  const types = elementsIn(mockRendered[0]).map((el) => el.type);
  return {
    hasBar: types.some((type) => typeof type === 'function' && type.name === 'ConsentBanner'),
    followsAccount: consent.analyticsFollowsAccount(),
  };
}

beforeEach(() => {
  localStorage.clear();
  delete process.env.REACT_APP_POSTHOG_KEY;
});

afterEach(() => {
  delete window.Capacitor;
  window.history.pushState({}, '', '/');
});

describe('the app routes mount no bar and follow the account instead', () => {
  test.each([
    ['/app on the web', '/app', false],
    ['a deep link on the web', '/f/12', false],
    ['/signup on the web', '/signup', false],
    ['the iOS shell at /', '/', true],
    ['the iOS shell at /app', '/app', true],
  ])('%s', (_label, path, native) => {
    const { hasBar, followsAccount } = boot(path, { native });
    expect(hasBar).toBe(false);
    expect(followsAccount).toBe(true);
  });

  test('an unanswered device changes nothing about that', () => {
    // The old in-app bar waited for exactly this state. Nothing waits now.
    expect(localStorage.getItem('flock_analytics_consent')).toBeNull();
    expect(boot('/app').hasBar).toBe(false);
  });
});

describe('the website keeps its bar, and its own rule', () => {
  test.each([
    ['the marketing home page', '/'],
    ['the privacy policy', '/privacy'],
    ['the terms', '/terms'],
    ['a guest invite', '/i/abcdefgh123'],
    ['the standalone password reset page', '/reset-password'],
    ['a wrong URL', '/no-such-page'],
  ])('%s', (_label, path) => {
    const { hasBar, followsAccount } = boot(path);
    expect(hasBar).toBe(true);
    expect(followsAccount).toBe(false);
  });
});
