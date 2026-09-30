/**
 * The analytics bar is the website's, and inside the native app it renders
 * nothing.
 *
 * index.js no longer mounts it on the app routes (analyticsBarRoutes.test.js
 * drives that). The one way it can still be mounted inside the iOS shell is a
 * page such as /privacy that the WebView happens to be sitting on, and there
 * it renders nothing, whatever the answer and whatever is on screen: the app
 * asks no analytics question. On the web it is the bar it always was, shown at
 * once in the website's own words.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false consentBannerNotInApp
 */
import React from 'react';
import { act, render } from '@testing-library/react';

jest.mock('../services/analyticsConsent', () => ({
  consentUnanswered: () => true,
  setConsent: jest.fn(),
  onConsentChange: () => () => {},
}));

const WEB_COPY = 'Can we count anonymous page views to see what people read? No cookies, '
  + 'no advertising, no sharing. Saying no changes nothing about the site.';

function mountNav(height) {
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.getBoundingClientRect = () => ({ height, width: 390, top: 0, left: 0, right: 390, bottom: height });
  (document.getElementById('root') || document.body).appendChild(nav);
  return nav;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

// Loaded once, on the web. Whether it is inside the native shell is read when
// each bar mounts (lib/nativeShell.js reads window.Capacitor live), so the
// cases below set the bridge before they render.
const BannerModule = require('../components/ConsentBanner');
const loadBanner = () => BannerModule;

afterEach(() => {
  delete window.Capacitor;
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--cb-height');
});

describe('on the web', () => {
  test('it shows at once, with the website\'s words', () => {
    const { default: ConsentBanner } = loadBanner();
    const { container } = render(<ConsentBanner />);
    expect(container.querySelector('.cb-copy').textContent).toBe(WEB_COPY);
    expect(container.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('Analytics choice');
  });
});

describe('inside the native app', () => {
  beforeEach(() => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  });

  test('it renders nothing and publishes no footprint, before sign-in', async () => {
    const { default: ConsentBanner } = loadBanner();
    const { container } = render(<ConsentBanner />);
    await settle();
    expect(container.querySelector('.cb-wrap')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--cb-height')).toBe('');
  });

  test('and still nothing once a tab bar is on screen, which is where the old app question appeared', async () => {
    const { default: ConsentBanner } = loadBanner();
    const { container } = render(<ConsentBanner />);
    await act(async () => { mountNav(89); });
    await settle();
    expect(container.querySelector('.cb-wrap')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--cb-height')).toBe('');
  });

  test('there is no app copy left to show', () => {
    expect(loadBanner().APP_COPY).toBeUndefined();
  });
});
