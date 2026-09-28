/**
 * A GRABBER THAT GRABS: PULL A BOTTOM SHEET DOWN TO CLOSE IT.
 *
 * Five sheets drew an iOS grabber bar with nothing behind it (the person card,
 * the report sheet, the Pro sheet, Invite friends, the time editor), so a
 * pull did nothing and the X was the only way out. DESIGN-STANDARD.md lists
 * swipe-down dismissal as convention 14. hooks/useSheetDrag.js makes the
 * grabber, and the header row next to it where there is one, a handle; the
 * chat's cash pool and vote sheets gain a grabber and the same handle.
 *
 * Sheets also rose into view with a scale and fade meant for centred dialogs,
 * and three of them named keyframes (fadeInUp) that exist nowhere, so they had
 * no entry at all. They rise from the bottom edge now (sheetRise).
 *
 * Sections:
 *   1. the hook, driven with pointer events and a controllable clock;
 *   2. the report sheet, rendered: a pull closes it, and not mid-request;
 *   3. every sheet is wired to the close its X already uses;
 *   4. the entry animation and the CSS the handle depends on.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test sheetDrag --watchAll=false
 */

import React from 'react';
import { render, act, screen } from '@testing-library/react';
import useSheetDrag, { DISMISS_PX, DRAG_START_PX, SETTLE_MS } from '../hooks/useSheetDrag';

jest.mock('../services/api', () => ({
  reportContent: jest.fn(() => new Promise(() => {})),
  blockUser: jest.fn(() => Promise.resolve({})),
}));
const ModerationSheet = require('../components/ModerationSheet').default;

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/* jsdom has no PointerEvent. React reads clientY off whatever native event
   arrives under the pointer type, so a MouseEvent carries it. */
const pointer = (el, type, clientY) => act(() => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 }));
});

let clockNow = 0;
const clock = () => clockNow;

beforeEach(() => {
  clockNow = 1000;
  jest.useFakeTimers();
});
afterEach(() => {
  act(() => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
});

function Sheet({ onClose, enabled = true, withClock = true }) {
  const drag = useSheetDrag(onClose, withClock ? { enabled, clock } : { enabled });
  return (
    <div ref={drag.sheetRef} data-testid="sheet">
      <div className="sheet-grab" data-testid="handle" {...drag.handleProps}>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <p>Body</p>
    </div>
  );
}

const setup = (props) => {
  const onClose = jest.fn();
  render(<Sheet onClose={onClose} {...props} />);
  const handle = screen.getByTestId('handle');
  handle.setPointerCapture = jest.fn();
  return { onClose, handle, sheet: screen.getByTestId('sheet') };
};

const pull = (handle, ys) => {
  const [first, ...rest] = ys;
  pointer(handle, 'pointerdown', first[0]);
  rest.forEach(([y, dt]) => {
    clockNow += dt || 16;
    pointer(handle, 'pointermove', y);
  });
};

describe('the hook', () => {
  test('the sheet follows a pull down with a transform, and the handle takes the pointer only once it is a drag', () => {
    const { handle, sheet } = setup();
    pull(handle, [[100], [103]]);
    expect(sheet.style.transform).toBe('');
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
    pull(handle, [[100], [140], [180]]);
    expect(sheet.style.transform).toBe('translate3d(0, 80px, 0)');
    expect(handle.setPointerCapture).toHaveBeenCalledTimes(1);
  });

  test('let go past the distance and it slides off, then closes once', () => {
    const { handle, sheet, onClose } = setup();
    pull(handle, [[100], [160, 80], [100 + DISMISS_PX + 30, 80]]);
    clockNow += 200; // held still: this is distance alone
    pointer(handle, 'pointerup', 100 + DISMISS_PX + 30);
    expect(sheet.style.transform).toBe('translate3d(0, 100%, 0)');
    expect(onClose).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a short, slow pull springs back', () => {
    const { handle, sheet, onClose } = setup();
    pull(handle, [[100], [130, 100], [160, 100]]);
    clockNow += 200;
    pointer(handle, 'pointerup', 160);
    expect(sheet.style.transform).toBe('translate3d(0, 0, 0)');
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  test('a quick flick down closes from a short distance', () => {
    const { handle, onClose } = setup();
    // 40px in 20ms is 2 px/ms, four times the flick speed.
    pull(handle, [[100], [120, 16], [160, 20]]);
    clockNow += 10;
    pointer(handle, 'pointerup', 160);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a finger that stopped before it lifted is not a flick', () => {
    const { handle, onClose } = setup();
    pull(handle, [[100], [120, 16], [160, 20]]);
    clockNow += 400;
    pointer(handle, 'pointerup', 160);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('pulling up does nothing: a sheet does not open further than it is', () => {
    const { handle, sheet, onClose } = setup();
    pull(handle, [[300], [300 - DRAG_START_PX - 4], [100]]);
    pointer(handle, 'pointerup', 100);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(sheet.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a tap on a control inside the handle is still a tap', () => {
    const { handle, onClose } = setup();
    const close = screen.getByText('Close');
    pointer(close, 'pointerdown', 100);
    pointer(close, 'pointermove', 102);
    pointer(close, 'pointerup', 102);
    act(() => { close.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
  });

  test('a cancelled pointer springs back', () => {
    const { handle, sheet, onClose } = setup();
    pull(handle, [[100], [200], [400]]);
    pointer(handle, 'pointercancel', 400);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  test('disabled means the handle is inert', () => {
    const { handle, sheet, onClose } = setup({ enabled: false });
    pull(handle, [[100], [200], [400]]);
    pointer(handle, 'pointerup', 400);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(sheet.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the report sheet, rendered', () => {
  const target = { userId: 9, userName: 'Riley', contentType: 'message', contentId: 4 };

  const grabOf = (container) => container.querySelector('.sheet-grab');

  test('a long pull on its grabber closes it', () => {
    const onClose = jest.fn();
    const { container } = render(<ModerationSheet target={target} onClose={onClose} />);
    const grab = grabOf(container);
    grab.setPointerCapture = jest.fn();
    pointer(grab, 'pointerdown', 100);
    pointer(grab, 'pointermove', 200);
    pointer(grab, 'pointermove', 400);
    pointer(grab, 'pointerup', 400);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('not while a report is being sent, the same rule as its backdrop', () => {
    // A send that never answers, so the sheet stays busy for the whole test.
    // Set here because CRA's resetMocks clears the factory's version.
    require('../services/api').reportContent.mockImplementation(() => new Promise(() => {}));
    const onClose = jest.fn();
    const { container } = render(<ModerationSheet target={target} onClose={onClose} />);
    act(() => { screen.getByText(/^Report /).click(); });
    act(() => { screen.getAllByRole('button', { pressed: false })[0].click(); });
    act(() => { screen.getByText('Submit report').click(); });
    expect(screen.getByText('Submitting…')).toBeInTheDocument();
    const grab = grabOf(container);
    grab.setPointerCapture = jest.fn();
    pointer(grab, 'pointerdown', 100);
    pointer(grab, 'pointermove', 200);
    pointer(grab, 'pointermove', 400);
    pointer(grab, 'pointerup', 400);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('every sheet is wired to the close its X already uses', () => {
  // file, the hook call, the element the handle spreads onto
  const WIRED = [
    ['App.js', 'const personSheetDrag = useSheetDrag(closeUserProfile, { enabled: !profileBlocking });', '{...personSheetDrag.handleProps}', 'ref={personSheetDrag.sheetRef}'],
    ['components/ModerationSheet.js', 'useSheetDrag(onClose, { enabled: !busy, sheetRef });', '{...grabProps}', 'ref={sheetRef}'],
    ['components/PaywallSheet.js', 'useSheetDrag(onClose, { enabled: !busy && !restoring, sheetRef });', '{...grabProps}', 'ref={sheetRef}'],
    ['screens/ChatDetail.js', 'const inviteSheetDrag = useSheetDrag(() => setShowFlockInviteModal(false));', '{...inviteSheetDrag.handleProps}', 'ref={inviteSheetDrag.sheetRef}'],
    ['screens/ChatDetail.js', 'const poolSheetDrag = useSheetDrag(() => { setShowChatPool(false); setShowCreateBill(false); });', '{...poolSheetDrag.handleProps}', 'ref={poolSheetDrag.sheetRef}'],
    ['screens/ChatDetail.js', 'const voteSheetDrag = useSheetDrag(() => setShowVotePanel(false));', '{...voteSheetDrag.handleProps}', 'ref={voteSheetDrag.sheetRef}'],
    ['screens/DmDetail.js', 'const dmVoteSheetDrag = useSheetDrag(() => setShowDmVotePanel(false));', '{...dmVoteSheetDrag.handleProps}', 'ref={dmVoteSheetDrag.sheetRef}'],
    ['screens/FlockDetail.js', 'const timeSheetDrag = useSheetDrag(() => setShowTimeEditor(false));', '{...timeSheetDrag.handleProps}', 'ref={timeSheetDrag.sheetRef}'],
  ];

  test.each(WIRED)('%s: %s', (file, hookCall, spread, sheetRef) => {
    const src = read(...file.split('/'));
    expect(src).toContain(hookCall);
    // The handle carries the touch-action class, or iOS scrolls instead.
    expect(src).toMatch(new RegExp(`className="sheet-grab" ${spread.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(src).toContain(sheetRef);
  });

  test('the hook runs before each component\'s early return', () => {
    const order = (file, hook, early) => {
      const src = read(...file.split('/'));
      expect(src.indexOf(hook)).toBeGreaterThan(-1);
      expect(src.indexOf(hook)).toBeLessThan(src.indexOf(early));
    };
    order('components/ModerationSheet.js', 'useSheetDrag(', 'if (!target) return null;');
    order('components/PaywallSheet.js', 'useSheetDrag(', 'if (!open) return null;');
    order('screens/FlockDetail.js', 'useSheetDrag(', 'if (!flock) return <MissingFlockPanel />;');
  });
});

describe('the entry animation and the CSS the handle depends on', () => {
  const css = read('index.css');

  test('sheets rise from the bottom edge at full size', () => {
    expect(css).toMatch(/@keyframes sheetRise \{\s*from \{ transform: translate3d\(0, 100%, 0\); \}\s*to \{ transform: translate3d\(0, 0, 0\); \}\s*\}/);
    // Two classes deep, so it beats the .modal-content rule in App.js.
    expect(css).toMatch(/\.modal-content\.sheet-rise \{\s*animation: sheetRise/);
  });

  test('the handle turns off the browser\'s own touch panning', () => {
    expect(css).toMatch(/\.sheet-grab \{\s*touch-action: none;/);
  });

  test('nothing names the fadeInUp keyframes, which never existed', () => {
    ['App.js', 'components/ModerationSheet.js', 'components/PaywallSheet.js'].forEach((f) => {
      expect(read(...f.split('/'))).not.toMatch(/fadeInUp/);
    });
  });

  test.each([
    ['screens/ChatDetail.js', 4],
    ['screens/DmDetail.js', 2],
    ['screens/FlockDetail.js', 1],
  ])('the bottom sheets in %s use it', (file, count) => {
    const n = (read(...file.split('/')).match(/className="modal-content sheet-rise"/g) || []).length;
    expect(n).toBe(count);
  });
});
