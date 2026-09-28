/**
 * A SWIPE FROM THE LEFT EDGE GOES BACK, THE WAY THE ARROW DOES.
 *
 * Navigation is one state value with no history, so WKWebView's own back
 * swipe had nothing to go back to and the only way out of a chat, a DM, a
 * plan, Add Friends, Past flocks or a settings page was a small arrow in the
 * top left corner. hooks/useEdgeSwipeBack.js drags the screen with the finger
 * from a 20px band at the left edge and, past a third of the width or on a
 * flick, runs the same handler as the arrow.
 *
 * Sections:
 *   1. the gesture, driven with synthetic touches;
 *   2. the hook, mounted, using the handler from the latest render;
 *   3. the message row and the pin bar leave the band to the back swipe;
 *   4. every drill-in screen is wired, and the arrow and the swipe share one
 *      function, so the two can never leave differently;
 *   5. every sideways scroller those screens render keeps its own touches,
 *      because the passive listeners cannot stop it scrolling under a drag.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test edgeSwipeBack --watchAll=false
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';

const mockShell = { native: true };
jest.mock('../lib/nativeShell', () => ({
  isNativeShell: () => mockShell.native,
  detectNativeShell: () => mockShell.native,
}));

const fs = require('fs');
const path = require('path');
const {
  default: useEdgeSwipeBack,
  bindEdgeSwipe,
  startsInEdgeBand,
  EDGE_PX,
  SETTLE_MS,
} = require('../hooks/useEdgeSwipeBack');
const MessageRow = require('../components/chat/MessageRow').default;
const PinnedMessageBar = require('../components/chat/sheets/PinnedMessageBar').default;

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const WIDTH = 390;

/* A touch event the way the handlers read one. jsdom has no Touch
   constructor, and the gesture only reads clientX and clientY. */
const touch = (node, type, x, y = 300) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  ev.touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }];
  ev.changedTouches = [{ clientX: x, clientY: y }];
  act(() => { node.dispatchEvent(ev); });
};

const screenNode = () => {
  const node = document.createElement('div');
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: WIDTH, height: 800, right: WIDTH, bottom: 800 });
  document.body.appendChild(node);
  return node;
};

let clockNow = 0;
const clock = () => clockNow;

beforeEach(() => {
  mockShell.native = true;
  clockNow = 1000;
  jest.useFakeTimers();
});
afterEach(() => {
  act(() => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
  document.body.innerHTML = '';
});

describe('the gesture', () => {
  const drag = (node, points) => {
    const [first, ...rest] = points;
    touch(node, 'touchstart', first[0], first[1]);
    rest.forEach(([x, y, dt]) => {
      clockNow += dt || 16;
      touch(node, 'touchmove', x, y);
    });
  };

  test('a drag from the edge follows the finger with a transform only', () => {
    const node = screenNode();
    bindEdgeSwipe(node, { onBack: jest.fn(), clock });
    drag(node, [[8, 300], [60, 302], [120, 304]]);
    // The first 10px decide the direction and are not drawn.
    expect(node.style.transform).toBe('translate3d(102px, 0, 0)');
    expect(node.style.transition).toBe('none');
  });

  test('let go past a third of the width and it slides off, then goes back once', () => {
    const onBack = jest.fn();
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    drag(node, [[8, 300], [80, 300, 60], [200, 302, 60]]);
    clockNow += 150; // held still, so no flick: this is distance alone
    touch(node, 'touchend', 200);
    expect(node.style.transform).toBe(`translate3d(${WIDTH}px, 0, 0)`);
    expect(onBack).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('a short, slow drag springs back and does not go anywhere', () => {
    const onBack = jest.fn();
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    drag(node, [[8, 300], [40, 300, 100], [90, 300, 100]]);
    clockNow += 150;
    touch(node, 'touchend', 90);
    expect(node.style.transform).toBe('translate3d(0px, 0, 0)');
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onBack).not.toHaveBeenCalled();
    expect(node.style.transform).toBe('');
    expect(node.style.boxShadow).toBe('');
  });

  test('a quick flick goes back from a short distance', () => {
    const onBack = jest.fn();
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    // 60px in 40ms is 1.5 px/ms, three times the flick speed.
    drag(node, [[8, 300], [30, 300, 16], [90, 300, 40]]);
    clockNow += 10;
    touch(node, 'touchend', 90);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('a finger that stopped before lifting is not a flick', () => {
    const onBack = jest.fn();
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    drag(node, [[8, 300], [30, 300, 16], [90, 300, 40]]);
    clockNow += 400;
    touch(node, 'touchend', 90);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onBack).not.toHaveBeenCalled();
  });

  test('a touch that starts outside the band is not the gesture', () => {
    const onBack = jest.fn();
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    drag(node, [[EDGE_PX + 5, 300], [200, 300], [300, 300]]);
    touch(node, 'touchend', 300);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
  });

  test('a vertical scroll that starts in the band stays a scroll', () => {
    const onBack = jest.fn();
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    drag(node, [[8, 300], [12, 340], [200, 360]]);
    touch(node, 'touchend', 200);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
  });

  test('not from a sheet open over the screen', () => {
    const onBack = jest.fn();
    const node = screenNode();
    // What DialogBehavior stamps on a sheet's backdrop, which covers the
    // screen, so an edge touch lands on it.
    const backdrop = document.createElement('div');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    node.appendChild(backdrop);
    bindEdgeSwipe(node, { onBack, clock });
    touch(backdrop, 'touchstart', 8);
    touch(backdrop, 'touchmove', 200);
    touch(backdrop, 'touchmove', 300);
    touch(backdrop, 'touchend', 300);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
  });

  test('a stale aria-modal somewhere else in the page does not switch it off', () => {
    // DialogBehavior sets aria-modal and never removes it, so a surface that
    // stops being modal (Birdie going from full screen to docked) can keep it.
    const onBack = jest.fn();
    const elsewhere = document.createElement('div');
    elsewhere.setAttribute('aria-modal', 'true');
    document.body.appendChild(elsewhere);
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    drag(node, [[8, 300], [200, 300], [300, 300]]);
    touch(node, 'touchend', 300);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('a control that is its own sideways drag keeps its touches', () => {
    const onBack = jest.fn();
    const node = screenNode();
    const slider = document.createElement('div');
    slider.setAttribute('data-edge-swipe', 'off');
    const thumb = document.createElement('span');
    slider.appendChild(thumb);
    node.appendChild(slider);
    bindEdgeSwipe(node, { onBack, clock });
    touch(thumb, 'touchstart', 8);
    touch(thumb, 'touchmove', 250);
    touch(thumb, 'touchend', 250);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
  });

  test('a cancelled touch springs back', () => {
    const onBack = jest.fn();
    const node = screenNode();
    bindEdgeSwipe(node, { onBack, clock });
    drag(node, [[8, 300], [250, 300]]);
    touch(node, 'touchcancel', 250);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(onBack).not.toHaveBeenCalled();
    expect(node.style.transform).toBe('');
  });

  test('disabled means nothing moves, and unbinding removes the listeners', () => {
    const onBack = jest.fn();
    const node = screenNode();
    const unbind = bindEdgeSwipe(node, { onBack, clock, isEnabled: () => false });
    drag(node, [[8, 300], [250, 300]]);
    expect(node.style.transform).toBe('');
    unbind();
    const node2 = screenNode();
    const unbind2 = bindEdgeSwipe(node2, { onBack, clock });
    unbind2();
    drag(node2, [[8, 300], [250, 300]]);
    expect(node2.style.transform).toBe('');
  });
});

describe('the hook, mounted', () => {
  function Screen({ onBack, enabled }) {
    const ref = useEdgeSwipeBack(onBack, enabled === undefined ? undefined : { enabled });
    return <div data-testid="root" ref={ref} />;
  }
  const rootOf = (utils) => {
    const node = utils.getByTestId('root');
    node.getBoundingClientRect = () => ({ left: 0, top: 0, width: WIDTH, height: 800 });
    return node;
  };
  const swipeFully = (node) => {
    touch(node, 'touchstart', 8);
    touch(node, 'touchmove', 60);
    touch(node, 'touchmove', 300);
    touch(node, 'touchend', 300);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
  };

  test('runs the handler from the latest render, not the first', () => {
    const first = jest.fn();
    const second = jest.fn();
    const utils = render(<Screen onBack={first} />);
    utils.rerender(<Screen onBack={second} />);
    swipeFully(rootOf(utils));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('off by default outside the native shell, where the browser owns this swipe', () => {
    mockShell.native = false;
    const onBack = jest.fn();
    const utils = render(<Screen onBack={onBack} />);
    swipeFully(rootOf(utils));
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('the other swipes leave the band to the back swipe', () => {
  // A stored row (a server-issued id), since only those take a reply swipe at
  // all (canQuote in MessageRow.js).
  const row = { id: 41, sender: 'Ava', senderId: 2, text: 'hi', sentAt: '2026-09-05T20:00:00', message_type: 'text', reactions: [] };

  test('startsInEdgeBand is the band, and only in the native shell', () => {
    expect(startsInEdgeBand(EDGE_PX)).toBe(true);
    expect(startsInEdgeBand(EDGE_PX + 1)).toBe(false);
    mockShell.native = false;
    expect(startsInEdgeBand(4)).toBe(false);
  });

  test('a reply swipe that starts in the band does not quote the message', () => {
    const onSwipeReply = jest.fn();
    const { container } = render(<MessageRow message={row} onSwipeReply={onSwipeReply} />);
    const node = container.querySelector('.chat-swipe');
    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchMove(node, { touches: [{ clientX: 90, clientY: 102 }] });
    fireEvent.touchEnd(node, { changedTouches: [{ clientX: 90, clientY: 102 }] });
    expect(onSwipeReply).not.toHaveBeenCalled();

    // The same swipe from just past the band still replies.
    fireEvent.touchStart(node, { touches: [{ clientX: 30, clientY: 100 }] });
    fireEvent.touchMove(node, { touches: [{ clientX: 110, clientY: 102 }] });
    fireEvent.touchEnd(node, { changedTouches: [{ clientX: 110, clientY: 102 }] });
    expect(onSwipeReply).toHaveBeenCalledTimes(1);
  });

  test('a long press that starts in the band still opens the menu', () => {
    const onLongPress = jest.fn();
    const { container } = render(<MessageRow message={row} onLongPress={onLongPress} />);
    const node = container.querySelector('.chat-swipe');
    fireEvent.touchStart(node, { touches: [{ clientX: 10, clientY: 100 }] });
    act(() => { jest.advanceTimersByTime(400); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  test('the pin bar does not step to another pin on a swipe from the band', () => {
    const onActiveIndexChange = jest.fn();
    const { container } = render(
      <PinnedMessageBar
        pins={[{ id: 1, preview: 'Venmo @maya' }, { id: 2, preview: 'Door code 4417' }]}
        activeIndex={0}
        onActiveIndexChange={onActiveIndexChange}
        onJump={() => {}}
        onUnpin={() => {}}
      />,
    );
    const bar = container.querySelector('.cs-pinbar');
    // jsdom has no PointerEvent, so a MouseEvent carries the pointer type and
    // the x the handler reads.
    const pointer = (type, clientX) => act(() => {
      bar.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
    });
    pointer('pointerdown', 8);
    pointer('pointerup', 160);
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    pointer('pointerdown', 40);
    pointer('pointerup', 160);
    expect(onActiveIndexChange).toHaveBeenCalledTimes(1);
  });
});

describe('every drill-in screen is wired, and the arrow and the swipe share one function', () => {
  // file, the function both the arrow and the swipe call, the root's key
  const SCREENS = [
    ['screens/ChatDetail.js', 'leaveToList', 'chat-detail-screen-container'],
    ['screens/DmDetail.js', 'leaveToList', 'dm-detail-screen'],
    ['screens/FlockDetail.js', 'leaveToPlans', 'flock-detail-screen-container'],
    ['screens/AddFriends.js', 'leave', 'add-friends-container'],
    ['screens/PastFlocksScreen.js', 'leave', 'past-flocks-container'],
    ['screens/ProfileSettings.js', 'backToYou', 'profile-${profileScreen}-container'],
  ];

  test.each(SCREENS)('%s', (file, fn, key) => {
    const src = read(...file.split('/'));
    expect(src).toMatch(/^import useEdgeSwipeBack from '\.\.\/hooks\/useEdgeSwipeBack';/m);
    expect(src).toContain(`const edgeBack = useEdgeSwipeBack(${fn});`);
    // The root is the element the swipe drags, and it slides in the same way.
    const keyAttr = key.includes('${') ? `key={\`${key}\`}` : `key="${key}"`;
    expect(src).toContain(`${keyAttr} ref={edgeBack} className="screen-enter"`);
    // The arrow calls the same function, not a second copy of its body.
    const arrow = new RegExp(`aria-label="Back[^"]*"[^>]*onClick=\\{${fn}\\}|onClick=\\{${fn}\\}[^>]*aria-label="Back`);
    expect(src).toMatch(arrow);
  });

  test('the hook runs before the plan screen\'s missing-plan return', () => {
    const src = read('screens', 'FlockDetail.js');
    expect(src.indexOf('useEdgeSwipeBack(leaveToPlans)')).toBeLessThan(src.indexOf('if (!flock) return <MissingFlockPanel />;'));
  });

  test('the push has no fill mode, so the root keeps no transform after it', () => {
    const app = read('App.js');
    expect(app).toMatch(/\.screen-enter \{\s*animation: screenSlideIn 0\.3s ease-out;\s*\}/);
  });

  test('the plan\'s slide to complete keeps its own touches', () => {
    expect(read('screens', 'FlockDetail.js')).toMatch(/ref=\{slideRef\}[\s\S]{0,200}data-edge-swipe="off"/);
  });
});

describe('a sideways scroller in a drill-in screen keeps its own touches', () => {
  const parser = require('@babel/parser');
  const traverse = require('@babel/traverse').default;
  const PARSE = {
    sourceType: 'module',
    plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'],
  };

  /* The six screens, the components they import, and every chat component,
     since the chat and the DM render those inside the dragged root. */
  const chatFiles = (dir) => fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) return chatFiles(rel);
    return /\.js$/.test(d.name) ? [rel] : [];
  });
  const FILES = [
    'screens/ChatDetail.js',
    'screens/DmDetail.js',
    'screens/FlockDetail.js',
    'screens/AddFriends.js',
    'screens/PastFlocksScreen.js',
    'screens/ProfileSettings.js',
    'components/EditProfileForm.js',
    'components/ui/FormBits.js',
    ...chatFiles('components/chat'),
  ];

  const keyName = (k) => (k.type === 'Identifier' ? k.name : k.type === 'StringLiteral' ? k.value : null);

  /** Every JSX element whose inline style scrolls sideways, and whether it
   *  carries data-edge-swipe="off". */
  const sidewaysScrollers = (file) => {
    const src = read(...file.split('/'));
    const ast = parser.parse(src, PARSE);
    const found = [];
    traverse(ast, {
      JSXOpeningElement(p) {
        const attrs = p.node.attributes.filter((a) => a.type === 'JSXAttribute');
        const style = attrs.find((a) => a.name.name === 'style');
        const obj = style && style.value && style.value.type === 'JSXExpressionContainer' ? style.value.expression : null;
        if (!obj || obj.type !== 'ObjectExpression') return;
        const scrolls = obj.properties.some((prop) => prop.type === 'ObjectProperty'
          && keyName(prop.key) === 'overflowX'
          && prop.value.type === 'StringLiteral'
          && (prop.value.value === 'auto' || prop.value.value === 'scroll'));
        if (!scrolls) return;
        const marker = attrs.find((a) => a.name.name === 'data-edge-swipe');
        const off = !!(marker && marker.value && marker.value.type === 'StringLiteral' && marker.value.value === 'off');
        found.push({ line: p.node.loc.start.line, off });
      },
    });
    return found;
  };

  test('the sweep reaches the chat components', () => {
    expect(FILES).toContain('components/chat/MessageRow.js');
    expect(FILES).toContain('components/chat/sheets/PinnedMessageBar.js');
  });

  test.each(FILES)('%s', (file) => {
    const unmarked = sidewaysScrollers(file).filter((s) => !s.off).map((s) => `${file}:${s.line}`);
    expect(unmarked).toEqual([]);
  });

  test('the plan\'s row of faces is one of them, and is marked', () => {
    const rows = sidewaysScrollers('screens/FlockDetail.js');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.off)).toBe(true);
  });

  test('a touch at the edge on a marked scroller does not drag the screen', () => {
    const onBack = jest.fn();
    const node = screenNode();
    const row = document.createElement('div');
    row.setAttribute('data-edge-swipe', 'off');
    row.style.overflowX = 'auto';
    const face = document.createElement('button');
    row.appendChild(face);
    node.appendChild(row);
    bindEdgeSwipe(node, { onBack, clock });
    touch(face, 'touchstart', 6);
    touch(face, 'touchmove', 120);
    touch(face, 'touchmove', 260);
    touch(face, 'touchend', 260);
    act(() => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
  });
});
