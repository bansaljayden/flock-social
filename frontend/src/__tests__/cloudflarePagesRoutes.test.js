/**
 * WHAT THE HOST ANSWERS 200, THE APP ANSWERS WITH A PAGE.
 *
 * Pages answers a path with no file and no rewrite with the app shell and a
 * 404 (scripts/build-cloudflare.js writes build/404.html), so the status and
 * the page agree only if every path the host answers 200 is one src/index.js
 * routes, and every path it answers 404 is one the router sends to its
 * not-found page. A route file or a rewrite left behind after its route is
 * gone would be a 200 that says "There's nothing at this address": the soft
 * 404 the 404 page exists to end. The other direction, that every route the
 * router declares answers 200, is in cloudflarePagesFunctions.test.js.
 *
 * This drives the real index.js at each path, with react-dom's root stubbed
 * so the element tree it renders can be read, as analyticsBarRoutes.test.js
 * does.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false cloudflarePagesRoutes
 */
const fs = require('fs');
const path = require('path');

const mockRendered = [];
jest.mock('react-dom/client', () => ({
  createRoot: () => ({ render: (element) => { mockRendered.push(element); } }),
}));

const build = require('../../scripts/build-cloudflare.js');

const ROOT = path.join(__dirname, '..', '..');

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

// Whether index.js, booted at `at`, renders its not-found page.
function rendersNotFound(at) {
  mockRendered.length = 0;
  window.history.pushState({}, '', at);
  jest.isolateModules(() => {
    require('../index');
  });
  expect(mockRendered).toHaveLength(1);
  return elementsIn(mockRendered[0]).some((el) => typeof el.type === 'function' && el.type.name === 'NotFound');
}

beforeEach(() => {
  localStorage.clear();
  delete process.env.REACT_APP_POSTHOG_KEY;
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('every path the host answers 200 is a page of the app', () => {
  // Sign in with Apple's registered return URL for the website. The host
  // keeps it answerable, but Apple's popup never loads it and the router has
  // no page there (APP_ROUTES in scripts/build-cloudflare.js says why).
  const NOT_A_PAGE = ['/auth/apple/callback'];

  test('each route the build writes a page file for', () => {
    const routes = [...build.APP_ROUTES, ...build.PRERENDER.map((p) => p.route)];
    expect(routes).toEqual(expect.arrayContaining(['/', '/app', '/i', '/privacy', '/support']));
    for (const route of routes) {
      expect([route, rendersNotFound(route)]).toEqual([route, NOT_A_PAGE.includes(route)]);
    }
  });

  test('each rewrite in cloudflare/_redirects, at a path it covers', () => {
    const { staticRules, rules } = build.parseRedirects(fs.readFileSync(path.join(ROOT, 'cloudflare', '_redirects'), 'utf8'));
    const rewrites = [...staticRules.values(), ...rules].filter((rule) => rule.status === 200);
    expect(rewrites.map((rule) => rule.from)).toEqual(expect.arrayContaining(['/app/*', '/checkin/*']));
    for (const { from } of rewrites) {
      // The splat and any placeholder stand for one id.
      const sample = from.replace(/\*/g, '1').replace(/:[A-Za-z]\w*/g, '1');
      expect([from, sample, rendersNotFound(sample)]).toEqual([from, sample, false]);
    }
  });
});

describe('every path the host answers 404 is the not-found page', () => {
  test.each([
    '/wp-login.php', '/.env', '/xmlrpc.php', '/.git/config', '/random-junk', '/wp-admin/', '/admin', '/login',
    '/api/nonexistent', '/.well-known/security.txt', '/404', '/404.html', '/f', '/checkin', '/i.php',
  ])('%s', (probe) => {
    expect(rendersNotFound(probe)).toBe(true);
  });
});
