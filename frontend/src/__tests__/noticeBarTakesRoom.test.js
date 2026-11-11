/**
 * THE NOTICE AT THE TOP OF THE APP TAKES ROOM INSTEAD OF COVERING THE SCREEN.
 *
 * App.js shows one sentence in a bar fixed across the top: what happened to a
 * confirmation link ("Your email is confirmed.", "That confirmation link has
 * expired..."), why a session ended, what a venue tap or an invitation link
 * needs first. The bar was `position: fixed; top: 0` with nothing under it
 * making room, so it lay over the top of whatever screen was showing.
 *
 * Clicking through the app in a 390 x 664 browser measured it. One line of
 * notice is 45px tall and two lines are 67px. Signed out, the bird mark on the
 * sign-in screen sits at 22 to 68px: half covered by one line, all of it by
 * two. Signed in, the Nest's heading sits at 33 to 56px with the profile
 * button beside it: both under the bar. A toast lands at 50px and lost its top
 * 17px. In the iOS app the bar is taller by the status bar, and the screens
 * only allowed for the status bar.
 *
 * The fix is one number. components/NoticeBar.js publishes the bar's measured
 * height on <html> as --notice-h while it is up, and index.css makes
 * --safe-top, the inset every screen already pads its top by, the larger of
 * the device's inset and that height. So the shell's top spacer, the sign-in
 * screens and the full-screen overlays all start below the bar, and move back
 * when it is dismissed.
 *
 * WHAT IS PINNED HERE
 *
 *   - Rendered, in jsdom: the bar publishes its height at mount, again when
 *     its sentence changes, again when the window changes; it removes the
 *     variable when it goes, and a measurement still waiting for a frame at
 *     that moment is dropped rather than published for a bar that is gone.
 *   - In source: the bar pads its own top by --device-top and never by
 *     --safe-top. --safe-top contains the bar's height, so padding by it adds
 *     the bar's height to itself on every measurement. That mistake is one
 *     word long and looks like following the stylesheet's own rule 2.
 *   - In source: the definitions in index.css, the two places the sign-in
 *     screen pads by the inset, the shell's spacer, the toast, and that App.js
 *     renders the bar through the component.
 *
 * jsdom lays nothing out, so the heights here are stood in for the bar's own
 * element and every other element measures 0. What the numbers do to a real
 * page is the browser's half, and nothing here stands in for it: the positions
 * quoted above were measured in a real browser against the local stack.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import NoticeBar, { NOTICE_HEIGHT_VAR } from '../components/NoticeBar';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8');
const BAR = fs.readFileSync(path.join(SRC, 'components', 'NoticeBar.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(SRC, 'components', 'auth', 'AuthShell.js'), 'utf8');
const INDEX_CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

// Comments are prose, not behaviour. Every source slice below runs through
// this first, so a sentence describing the fix can never stand in for it. The
// same two rules as firstRunPath.test.js, and no rule for JSX comment nodes.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const published = () => document.documentElement.style.getPropertyValue(NOTICE_HEIGHT_VAR);
// Long enough for the animation frame a resize schedules.
const aFrame = () => new Promise((resolve) => setTimeout(resolve, 40));

// The bar's height as a browser would report it. 44.4 and not 45: the real
// figure is fractional, and which way it is rounded is one of the assertions.
let barHeight = 44.4;
let rects;

beforeEach(() => {
  barHeight = 44.4;
  rects = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    const height = this.hasAttribute('data-notice-bar') ? barHeight : 0;
    return { height, width: 390, top: 0, left: 0, right: 390, bottom: height, x: 0, y: 0 };
  });
});

afterEach(() => {
  rects.mockRestore();
  document.documentElement.style.removeProperty(NOTICE_HEIGHT_VAR);
});

describe('the bar publishes its height while it is up, and takes it back', () => {
  test('mounted, its height is on the document, rounded up to a whole pixel', () => {
    expect(published()).toBe('');
    render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    // Up, not to nearest: 44px of room under a 44.4px bar leaves a hairline of
    // the heading showing below the bar's border.
    expect(published()).toBe('45px');
  });

  test('a longer sentence that wraps to a second line is measured in the same commit', () => {
    const { rerender } = render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    expect(published()).toBe('45px');
    barHeight = 66.6;
    rerender(<NoticeBar onDismiss={() => {}}>That confirmation link has expired. Sign in and ask Flock for a new one.</NoticeBar>);
    // No frame waited for: the screen under the bar moves with the sentence.
    expect(published()).toBe('67px');
  });

  test('a window that changes width is measured on the next frame', async () => {
    render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    barHeight = 88.2;
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await aFrame();
    });
    expect(published()).toBe('89px');
  });

  test('gone from the screen, it leaves no room behind', () => {
    const { unmount } = render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    expect(published()).toBe('45px');
    unmount();
    // Removed, not set to 0px: var(--notice-h, 0px) falls back by itself, and
    // a stale value is an empty band at the top of the app until a reload.
    expect(published()).toBe('');
  });

  test('a measurement still waiting for its frame when the bar goes is dropped', async () => {
    const { unmount } = render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    barHeight = 66.6;
    window.dispatchEvent(new Event('resize'));
    unmount();
    await act(async () => { await aFrame(); });
    expect(published()).toBe('');
  });

  test('after it has gone, a resize publishes nothing', async () => {
    const { unmount } = render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await aFrame();
    });
    expect(published()).toBe('');
  });

  test('a bar with no box yet publishes nothing, rather than 0px', () => {
    barHeight = 0;
    render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    expect(published()).toBe('');
  });

  test('it is still published after the second mount React makes in development', () => {
    // StrictMode, which index.js wraps the app in, runs every effect, its
    // cleanup, and the effect again on the first mount. The cleanup removes the
    // variable, so a bar that remembered "already published" would be on
    // screen with no room made for it, in development only.
    render(
      <React.StrictMode>
        <NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>
      </React.StrictMode>,
    );
    expect(published()).toBe('45px');
  });
});

describe('what the bar is', () => {
  test('the sentence is announced, and Dismiss is a real button with the 44pt hit area', () => {
    const onDismiss = jest.fn();
    const { container, getByRole } = render(
      <NoticeBar onDismiss={onDismiss}>That confirmation link did not work.</NoticeBar>,
    );
    const bar = container.querySelector('[data-notice-bar]');
    expect(bar.getAttribute('role')).toBe('status');
    expect(bar.textContent).toBe('That confirmation link did not work.Dismiss');
    const button = getByRole('button', { name: 'Dismiss' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toBe('hit44');
    act(() => { button.click(); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('it stays fixed at the top, above the screens and under the modal sheets', () => {
    const { container } = render(<NoticeBar onDismiss={() => {}}>Your email is confirmed.</NoticeBar>);
    const { style } = container.querySelector('[data-notice-bar]');
    expect([style.position, style.top, style.left, style.right, style.zIndex]).toEqual(['fixed', '0px', '0px', '0px', '9000']);
  });

  test('it pads its own top by the device inset, never by the inset that contains its own height', () => {
    const bar = codeOnly(BAR);
    expect(bar).toContain("padding: 'calc(var(--device-top, 0px) + 10px) 14px 12px'");
    expect(bar).not.toContain('safe-top');
  });

  test('the cleanup is in the source as well as in behaviour', () => {
    const bar = codeOnly(BAR);
    expect(bar).toMatch(/style\.setProperty\(NOTICE_HEIGHT_VAR, value\)/);
    expect(bar).toMatch(/document\.documentElement\.style\.removeProperty\(NOTICE_HEIGHT_VAR\)/);
    expect(bar).toMatch(/window\.cancelAnimationFrame\(frame\)/);
    expect(bar).toMatch(/window\.removeEventListener\('resize', schedule\)/);
    // jsdom and an old WebView have no ResizeObserver; the bar must not need one.
    expect(bar).toMatch(/typeof ResizeObserver === 'function'/);
  });
});

describe('every screen that pads by the top inset now clears the bar', () => {
  const css = INDEX_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const app = codeOnly(APP);
  const shell = codeOnly(SHELL);

  test('the name the bar publishes is the name the stylesheets read', () => {
    expect(NOTICE_HEIGHT_VAR).toBe('--notice-h');
  });

  test('the top inset is the larger of the device inset and the bar, defined once', () => {
    expect(css).toContain('--device-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));');
    // max(), not a sum: the bar's height already contains the device inset.
    expect(css).toContain('--safe-top: max(var(--device-top), var(--notice-h, 0px));');
    expect(css.match(/--safe-top:/g)).toHaveLength(1);
    expect(css.match(/--device-top:/g)).toHaveLength(1);
  });

  test('App.js renders the bar through the component, with the sentence as its child', () => {
    expect(app).toMatch(/const notice = noticeText \? \(\s*<NoticeBar onDismiss=\{/);
    expect(app).toMatch(/<NoticeBar [^\n]*>\s*\{withSupportAddress\(noticeText\)\}\s*<\/NoticeBar>/);
    // Dismiss clears every source, or the next one in line shows up in its place.
    expect(app).toContain("onDismiss={() => { setLinkNote(''); setSessionNote(''); setCheckinNote(''); setInviteNote(''); }}");
    // No fixed bar of its own left behind beside the component.
    expect(app).not.toContain('zIndex: 9000');
    expect(app).toContain("import NoticeBar from './components/NoticeBar';");
  });

  test('the shell has one spacer at its top and it is the inset', () => {
    expect(app).toMatch(/notch: fullBleed \? \{\s*height: 'var\(--safe-top\)',/);
  });

  test('a toast lands under the bar instead of half behind it', () => {
    expect(app).toContain("top: 'max(50px, calc(var(--notice-h, 0px) + 8px))',");
    expect(app).not.toContain("top: '50px'");
  });

  test('the sign-in screens pad their top by the inset at both heights', () => {
    expect(shell).toContain('padding: calc(var(--safe-top) + 36px) 24px 30px;');
    expect(shell).toContain('.auth-hero { min-height: 0; padding-top: calc(var(--safe-top) + 22px); padding-bottom: 22px; }');
  });

  test('an error the sign-in screen scrolls to stops below the bar', () => {
    const at = shell.indexOf('.auth-root {');
    expect(at).toBeGreaterThan(-1);
    const rule = shell.slice(at, at + shell.slice(at).search(/\}\r?\n/));
    expect(rule).toContain('scroll-padding-top: var(--notice-h, 0px);');
    expect(rule).toContain('overflow-y: auto;');
  });
});
