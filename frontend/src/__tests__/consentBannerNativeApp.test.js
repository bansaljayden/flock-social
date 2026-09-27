/**
 * The analytics question inside the native app.
 *
 * On a fresh install the bar opened over the sign-in screen and said "page
 * views" and "the site", which reads as a web page inside the app. Consent is
 * real in the app (it gates every PostHog capture), so the app still asks, but
 * in app words and only once the tab bar is on screen, so nothing on the
 * sign-in screens is ever under it. The web copy and timing are unchanged.
 */
import React from 'react';
import { act, render } from '@testing-library/react';

jest.mock('../services/analyticsConsent', () => ({
  consentUnanswered: () => true,
  setConsent: jest.fn(),
}));

const { default: ConsentBanner, APP_COPY } = require('../components/ConsentBanner');

const WEB_COPY = 'Can we count anonymous page views to see what people read? No cookies, '
  + 'no advertising, no sharing. Saying no changes nothing about the site.';

function mountNav(height) {
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.getBoundingClientRect = () => ({ height, width: 390, top: 0, left: 0, right: 390, bottom: height });
  const root = document.getElementById('root') || document.body;
  root.appendChild(nav);
  return nav;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

afterEach(() => {
  delete window.Capacitor;
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--cb-height');
});

describe('on the web', () => {
  it('shows at once with the original words', () => {
    const { container } = render(<ConsentBanner />);
    expect(container.querySelector('.cb-copy').textContent).toBe(WEB_COPY);
  });
});

describe('in the native app', () => {
  beforeEach(() => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  });

  it('renders nothing on the sign-in screens and publishes no footprint', async () => {
    const { container } = render(<ConsentBanner />);
    await settle();
    expect(container.querySelector('.cb-wrap')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--cb-height')).toBe('');
  });

  it('appears above the tab bar once somebody is signed in, in app words', async () => {
    const { container } = render(<ConsentBanner />);
    await settle();
    expect(container.querySelector('.cb-wrap')).toBeNull();

    await act(async () => { mountNav(89); });
    await settle();
    const wrap = container.querySelector('.cb-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap.style.getPropertyValue('--cb-clearance')).toBe('89px');
    const copy = container.querySelector('.cb-copy').textContent;
    expect(copy).toBe(APP_COPY);
    expect(copy).toMatch(/screens/);
    expect(copy).toMatch(/the app/);
    expect(copy).not.toMatch(/page view|site|cookie|anonymous/i);
    expect(copy).not.toMatch(/—/);
  });

  it('leaves with the tab bar on sign-out instead of floating over the sign-in screen', async () => {
    const { container } = render(<ConsentBanner />);
    let nav;
    await act(async () => { nav = mountNav(89); });
    await settle();
    expect(container.querySelector('.cb-wrap')).not.toBeNull();

    await act(async () => { nav.remove(); });
    await settle();
    expect(container.querySelector('.cb-wrap')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--cb-height')).toBe('');
  });
});
