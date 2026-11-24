/**
 * A FRIEND'S LINK, BOTH ENDS OF IT (2026-11-23).
 *
 * The QR and the share sheet carry https://www.flockcorp.com/add/<code>. That
 * address used to be the not-found page, so a friend's code was a dead end
 * for exactly the people it was meant to bring in. This pins:
 *
 *   1. the website's page (website/FriendLink.js), rendered: the code with a
 *      Copy button and the App Store badge, the two ways into the web app that
 *      keep the code first, a browser already signed in going straight to the
 *      app, and a link with no code in it said as such. It never names anybody
 *      and sends nothing.
 *   2. Where it is registered (src/index.js), and how the host answers it
 *      (cloudflare/_redirects and _headers are pinned in cloudflarePages).
 *   3. The app's end: the sheet that says whose code it is, with one button,
 *      in each of its answers (components/FriendCodeSheet.js).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false friendLinkPage
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, fireEvent, act } from '@testing-library/react';

jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  BirdieStill: () => null,
  BirdNote: () => null,
  WARM_BIRD: {},
  BIRDIE: {},
}));

const fs = require('fs');
const path = require('path');

/* eslint-disable import/first */
import FriendLink from '../website/FriendLink';
import FriendCodeSheet from '../components/FriendCodeSheet';
import { pendingFriendCode, PENDING_FRIEND_CODE_KEY } from '../lib/friendCode';
/* eslint-enable import/first */

const realLocation = window.location;

function at(pathname) {
  const assign = jest.fn();
  const replace = jest.fn();
  delete window.location;
  window.location = {
    href: `https://www.flockcorp.com${pathname}`,
    origin: 'https://www.flockcorp.com',
    pathname,
    search: '',
    hash: '',
    assign,
    replace,
  };
  return { assign, replace };
}

afterEach(() => {
  window.location = realLocation;
  localStorage.clear();
  document.head.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
});

describe("the website's page for a friend's link", () => {
  test('the code, a Copy button, the App Store badge, and nothing that names anybody', async () => {
    at('/add/flock-njqxugum');
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(React.createElement(FriendLink));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Add your friend on Flock');
    expect(screen.getByText('FLOCK-NJQXUGUM')).toBeTruthy();
    const badge = screen.getByRole('link', { name: 'Download on the App Store' });
    expect(badge.getAttribute('href')).toBe('https://apps.apple.com/app/id6781442127');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy the code, FLOCK-NJQXUGUM' })); });
    expect(writeText).toHaveBeenCalledWith('FLOCK-NJQXUGUM');
    expect(screen.getByRole('button', { name: 'Copy the code, FLOCK-NJQXUGUM' }).textContent).toBe('Copied');
    // Not for search engines.
    expect(document.head.querySelector('meta[name="robots"]').getAttribute('content')).toBe('noindex, noarchive');
    delete window.navigator.clipboard;
  });

  test('both ways into the web app keep the code first', () => {
    const { assign } = at('/add/FLOCK-NJQXUGUM');
    render(React.createElement(FriendLink));
    fireEvent.click(screen.getByRole('button', { name: 'Use Flock in your browser' }));
    expect(pendingFriendCode()).toBe('FLOCK-NJQXUGUM');
    expect(assign).toHaveBeenLastCalledWith('/signup');
    localStorage.removeItem(PENDING_FRIEND_CODE_KEY);
    fireEvent.click(screen.getByRole('button', { name: 'I already have an account' }));
    expect(pendingFriendCode()).toBe('FLOCK-NJQXUGUM');
    expect(assign).toHaveBeenLastCalledWith('/app');
  });

  test('a browser already signed in keeps the code and goes straight to the app, which asks', () => {
    localStorage.setItem('flockToken', 'a.b.c');
    const { replace } = at('/add/FLOCK-NJQXUGUM');
    render(React.createElement(FriendLink));
    expect(replace).toHaveBeenCalledWith('/app');
    expect(pendingFriendCode()).toBe('FLOCK-NJQXUGUM');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  test('a link with no readable code says so, and keeps nothing', () => {
    const { assign, replace } = at('/add/not-a-code');
    render(React.createElement(FriendLink));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("That link isn't complete");
    expect(pendingFriendCode()).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  test('the page looks nobody up and sends nothing', () => {
    // Code only: the header says in words what the page does not do.
    const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'FriendLink.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/fetch\(|services\/api|by-code|add-by-code|XMLHttpRequest/);
  });

  test('src/index.js serves it for /add/<code> on the web, never in the native shell', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(index).toMatch(/id: 'friend-link',\n\s*test: \(p\) => p\.startsWith\('\/add\/'\) && !isNativeShell,\n\s*load: \(\) => import\('\.\/website\/FriendLink'\),/);
  });
});

describe("the app's sheet for a friend's code", () => {
  const sheetProps = (sheet, over = {}) => ({
    DialogBehavior: () => null,
    sheet,
    isDark: false,
    onSend: jest.fn(),
    onDone: jest.fn(),
    onNotNow: jest.fn(),
    onRetry: jest.fn(),
    ...over,
  });
  const casey = { id: 5, name: 'Casey Crawler', profile_image_url: null };

  test('nothing at all when there is no code', () => {
    const { container } = render(React.createElement(FriendCodeSheet, sheetProps(null)));
    expect(container.innerHTML).toBe('');
  });

  test('a stranger: Add <name>? with Send request, and Not now', () => {
    const props = sheetProps({ code: 'FLOCK-NJQXUGUM', phase: 'ready', user: casey, status: 'none', busy: false });
    render(React.createElement(FriendCodeSheet, props));
    expect(screen.getByRole('heading').textContent).toBe('Add Casey Crawler?');
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(props.onNotNow).toHaveBeenCalledTimes(1);
  });

  test("the disc behind an initial is the theme's face disc, which is never the sheet's own colour", () => {
    // It was a fixed navy, #1e293b, which is exactly the dark sheet's
    // --bg-card-solid: in the evening the initial floated on nothing. Drawn
    // through react-dom/server, because jsdom drops a var() colour from an
    // element's style (accentBlush.test.js says the same).
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(React.createElement(FriendCodeSheet, sheetProps({ code: 'FLOCK-NJQXUGUM', phase: 'ready', user: casey, status: 'none', busy: false })));
    const face = host.querySelector('[data-testid="friend-code-face"]');
    expect(face.textContent).toBe('C');
    const style = face.getAttribute('style');
    expect(style).toMatch(/background-color:var\(--face-bg\)/);
    expect(style).toMatch(/(^|;)color:var\(--text-primary\)/);
    expect(style).not.toMatch(/#1e293b|#ffffff/i);

    // And the two never meet in index.css, light or dark, while the initial
    // reads on its disc in both.
    const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8').replace(/\r\n/g, '\n');
    const darkAt = css.indexOf('[data-theme="dark"] {');
    const themes = {
      light: css.slice(css.lastIndexOf(':root {', darkAt), darkAt),
      dark: css.slice(darkAt, css.indexOf('\n}', darkAt)),
    };
    const token = (block, name) => {
      const m = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i'));
      return m ? m[1].toLowerCase() : null;
    };
    const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    for (const [theme, block] of Object.entries(themes)) {
      const disc = token(block, 'face-bg');
      const sheet = token(block, 'bg-card-solid');
      const ink = token(block, 'text-primary');
      expect([theme, typeof disc, typeof sheet, typeof ink]).toEqual([theme, 'string', 'string', 'string']);
      expect([theme, disc]).not.toEqual([theme, sheet]);
      expect([theme, ratio(ink, disc) >= 4.5]).toEqual([theme, true]);
    }
  });

  test('somebody who asked you: Accept', () => {
    render(React.createElement(FriendCodeSheet, sheetProps({ code: 'FLOCK-NJQXUGUM', phase: 'ready', user: casey, status: 'incoming', busy: false })));
    expect(screen.getByRole('heading').textContent).toBe('Casey Crawler asked to be your friend');
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  test.each([
    ['accepted', "You're already friends"],
    ['self', "That's your own code"],
    ['outgoing', "You've already asked Casey Crawler"],
  ])('%s: says so, with Done and no second way out', (status, title) => {
    const props = sheetProps({ code: 'FLOCK-NJQXUGUM', phase: 'ready', user: casey, status, busy: false });
    render(React.createElement(FriendCodeSheet, props));
    expect(screen.getByRole('heading').textContent).toBe(title);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send request|Accept/ })).toBeNull();
  });

  test('while its request is out, nothing on it can be pressed twice or closed', () => {
    const props = sheetProps({ code: 'FLOCK-NJQXUGUM', phase: 'ready', user: casey, status: 'none', busy: true });
    render(React.createElement(FriendCodeSheet, props));
    const send = screen.getByRole('button', { name: 'Sending…' });
    expect(send.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Not now' }).disabled).toBe(true);
  });

  test('a code that names nobody, and a read that failed, are said for what they are', () => {
    const { unmount } = render(React.createElement(FriendCodeSheet, sheetProps({ code: 'FLOCK-NJQXUGUM', phase: 'missing', user: null, status: null, busy: false })));
    expect(screen.getByRole('heading').textContent).toBe("That code didn't match anyone");
    unmount();
    const props = sheetProps({ code: 'FLOCK-NJQXUGUM', phase: 'error', user: null, status: null, busy: false });
    render(React.createElement(FriendCodeSheet, props));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test('the sheet sends nothing itself; only its button reaches App.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'FriendCodeSheet.js'), 'utf8');
    expect(src).not.toMatch(/services\/api|fetch\(|useEffect/);
  });
});
