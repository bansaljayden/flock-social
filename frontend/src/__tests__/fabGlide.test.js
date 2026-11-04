/**
 * THE FLOATING BUTTONS GLIDE TO THEIR CORNER AFTER A DRAG (2026-11-04).
 *
 * The pointer down on Birdie's button or SOS wrote `transition: none` so the
 * button could follow the finger, and nothing wrote it back, so after a
 * button's first drag every release jumped it into its corner instead of
 * gliding there (and the stylesheet's corner moves jumped too). The release
 * now plays the snap from the drop point on .fab-corner's own curve and hands
 * the stylesheet its transition back when the button lands.
 *
 * jsdom lays nothing out, so this runs App.js's own three handlers, lifted from
 * the source, against a button laid out by hand on a 390x844 frame: its box is
 * its corner's resting box, moved and scaled by whatever transform its inline
 * style draws. Every forced layout (offsetWidth) records the frame the browser
 * would paint from.
 * FRONTEND test (jest via react-scripts).
 */
import { FAB_GLIDE_MS, FAB_GLIDE_EASE, glideFabHome, stopFabGlide } from '../lib/fabGlide';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8').replace(/\r\n/g, '\n');

const slice = (from, to) => {
  const at = APP.indexOf(from);
  if (at < 0) throw new Error(`not found: ${from}`);
  const end = APP.indexOf(to, at);
  if (end < 0) throw new Error(`not found after ${from}: ${to}`);
  return APP.slice(at, end);
};

// The three drag handlers exactly as App.js writes them.
const HANDLERS = slice('const handleFabPointerDown = useCallback(', '\n  // Interests.');

const FRAME = { left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 };
const SIZE = 52;
// Where a 52px button rests in each corner on the Nest: 12px from the side,
// 60px from the top or the dock's 101px from the bottom (birdieRestsClearOfSos
// measures those against App.js's own cornerStyle).
const restBox = (corner) => ({
  left: corner.includes('left') ? 12 : FRAME.width - 12 - SIZE,
  top: corner.startsWith('top') ? 60 : FRAME.height - 101 - SIZE,
  width: SIZE,
  height: SIZE,
});
// A box as an inline `translate(x, y) scale(s)` draws it, about its centre.
function drawn(box, transform) {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)(?: scale\(([\d.]+)\))?/.exec(transform || '');
  const tx = m ? Number(m[1]) : 0;
  const ty = m ? Number(m[2]) : 0;
  const s = m && m[3] ? Number(m[3]) : 1;
  const cx = box.left + box.width / 2 + tx;
  const cy = box.top + box.height / 2 + ty;
  const w = box.width * s;
  const h = box.height * s;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, right: cx + w / 2, bottom: cy + h / 2 };
}

function fakeButton(corner) {
  const listeners = {};
  const el = {
    corner,
    style: { transform: '', transition: '', willChange: '', cursor: 'grab', zIndex: '20' },
    isConnected: true,
    parentElement: { getBoundingClientRect: () => FRAME },
    setPointerCapture() {},
    getBoundingClientRect() { return drawn(restBox(el.corner), el.style.transform); },
    // A forced layout: the frame the browser would paint.
    frames: [],
    get offsetWidth() {
      el.frames.push({ transform: el.style.transform, transition: el.style.transition, corner: el.corner });
      return SIZE;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    listening: (type) => (listeners[type] || []).length,
    // An event as it reaches the button, from itself or bubbled up from the disc.
    fire(type, props) { for (const fn of [...(listeners[type] || [])]) fn({ target: el, ...props }); },
  };
  return el;
}

// The handlers wired to `el` the way FlockAppInner wires them: the corner
// state moves the button, flushSync runs its update at once.
function appHandlers(el, id = 'birdie') {
  const log = { flushed: [], saved: [], synced: [] };
  const setCorner = (c) => { el.corner = c; };
  const make = new Function(
    'useCallback', 'dragRef', 'flushSync', 'setBirdieCorner', 'setSosCorner', 'lsSet', 'queueSync', 'glideFabHome', 'stopFabGlide',
    `${HANDLERS}\nreturn { handleFabPointerDown, handleFabPointerMove, handleFabPointerUp };`,
  );
  const h = make(
    (fn) => fn,
    { current: null },
    (fn) => { log.flushed.push(el.corner); fn(); },
    setCorner,
    setCorner,
    (k, v) => log.saved.push([k, v]),
    (patch) => log.synced.push(patch),
    glideFabHome,
    stopFabGlide,
  );
  const at = (x, y) => ({ currentTarget: el, pointerId: 1, clientX: x, clientY: y });
  return {
    log,
    down: (x, y) => h.handleFabPointerDown(at(x, y), id),
    move: (x, y) => h.handleFabPointerMove(at(x, y)),
    up: (x, y) => h.handleFabPointerUp(at(x, y)),
  };
}

const centre = (b) => [b.left + b.width / 2, b.top + b.height / 2];
const GLIDE = `transform ${FAB_GLIDE_MS}ms ${FAB_GLIDE_EASE}`;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  delete window.matchMedia;
});

test('the glide runs on .fab-corner\'s own curve and duration', () => {
  const rule = CSS.match(/\.fab-corner \{\n\s+transition: ([^;]+);/);
  expect(rule).not.toBeNull();
  const legs = rule[1].split(',\n').map((s) => s.trim());
  expect(legs.map((l) => l.split(' ')[0])).toEqual(['top', 'bottom', 'left', 'right']);
  for (const leg of legs) expect(leg.slice(leg.indexOf(' ') + 1)).toBe(`${FAB_GLIDE_MS / 1000}s ${FAB_GLIDE_EASE}`);
});

test('the drag itself is as it was: transition off, the transform under the finger at 1.08, a 6px dead zone', () => {
  const el = fakeButton('bottom-left');
  const app = appHandlers(el);
  app.down(38, 717);
  expect(el.style.transition).toBe('none');
  expect(el.style.zIndex).toBe('30');
  app.move(42, 713);
  expect(el.style.transform).toBe('');
  app.move(138, 517);
  expect(el.style.transform).toBe('translate(100px, -200px) scale(1.08)');
  expect(el.style.transition).toBe('none');
});

test('a release glides from where the finger let go into the corner, on the first drag and every drag after it', () => {
  const el = fakeButton('bottom-left');
  const app = appHandlers(el);
  const drops = [
    // Bottom-left to the top-right quarter, then across to bottom-right, then
    // a short drag that lands back in the same corner.
    { from: [38, 717], to: [300, 200], corner: 'top-right', land: 'event' },
    { from: [352, 86], to: [330, 700], corner: 'bottom-right', land: 'timer' },
    { from: [352, 717], to: [310, 650], corner: 'bottom-right', land: 'event' },
  ];
  for (const d of drops) {
    el.frames.length = 0;
    app.down(...d.from);
    app.move(...d.to);
    const dropped = el.getBoundingClientRect();
    expect(app.up(...d.to)).toBe(true);
    // It rests where the drop says, committed before the glide measured it.
    expect(el.corner).toBe(d.corner);
    expect(app.log.flushed).toHaveLength(drops.indexOf(d) + 1);
    // The first painted frame of the snap is the button exactly where it was
    // dropped, the drag's 1.08 included, with the transition still off.
    expect(el.frames).toHaveLength(1);
    const start = el.frames[0];
    expect(start.transition).toBe('none');
    expect(start.corner).toBe(d.corner);
    const startBox = drawn(restBox(d.corner), start.transform);
    expect(centre(startBox)[0]).toBeCloseTo(centre(dropped)[0], 6);
    expect(centre(startBox)[1]).toBeCloseTo(centre(dropped)[1], 6);
    expect(startBox.width).toBeCloseTo(SIZE * 1.08, 6);
    // Then the offset runs out on the corner's curve.
    expect(el.style.transform).toBe('');
    expect(el.style.transition).toBe(GLIDE);
    // Landed, the stylesheet's own transition is back.
    if (d.land === 'event') {
      el.fire('transitionend', { propertyName: 'transform' });
    } else {
      jest.advanceTimersByTime(FAB_GLIDE_MS + 100);
    }
    expect(el.style.transition).toBe('');
    expect(el.listening('transitionend')).toBe(0);
  }
  expect(app.log.saved.map(([, c]) => c)).toEqual(['top-right', 'bottom-right', 'bottom-right']);
});

test('the landing waits for the button\'s own transform, not the disc\'s press or a corner move', () => {
  const el = fakeButton('bottom-left');
  const app = appHandlers(el);
  app.down(38, 717);
  app.move(300, 200);
  app.up(300, 200);
  expect(el.listening('transitionend')).toBe(1);
  // The disc inside the button has a press transition of its own.
  el.fire('transitionend', { target: {}, propertyName: 'transform' });
  el.fire('transitionend', { propertyName: 'top' });
  expect(el.style.transition).toBe(GLIDE);
  el.fire('transitionend', { propertyName: 'transform' });
  expect(el.style.transition).toBe('');
});

test('a drag that starts while the last glide is landing keeps its transition off until its own release', () => {
  const el = fakeButton('bottom-left');
  const app = appHandlers(el);
  app.down(38, 717);
  app.move(300, 200);
  app.up(300, 200);
  expect(el.style.transition).toBe(GLIDE);
  // Grabbed again mid-glide: the old landing must not fire under the finger.
  app.down(300, 200);
  expect(el.style.transition).toBe('none');
  jest.advanceTimersByTime(2000);
  expect(el.style.transition).toBe('none');
  app.move(60, 700);
  app.up(60, 700);
  expect(el.corner).toBe('bottom-left');
  expect(el.style.transition).toBe(GLIDE);
  jest.advanceTimersByTime(FAB_GLIDE_MS + 100);
  expect(el.style.transition).toBe('');
});

test('a tap moves nothing and hands the transition back at once', () => {
  const el = fakeButton('bottom-right');
  const app = appHandlers(el, 'sos');
  app.down(352, 717);
  app.move(355, 714);
  expect(app.up(355, 714)).toBe(false);
  expect(el.corner).toBe('bottom-right');
  expect(el.style.transform).toBe('');
  expect(el.style.transition).toBe('');
  expect(el.frames).toHaveLength(0);
  expect(app.log.saved).toEqual([]);
});

test('SOS glides along its row the same way, and only ever to a bottom corner', () => {
  const el = fakeButton('bottom-right');
  const app = appHandlers(el, 'sos');
  app.down(352, 717);
  app.move(60, 150);
  app.up(60, 150);
  expect(el.corner).toBe('bottom-left');
  expect(el.frames).toHaveLength(1);
  expect(el.style.transition).toBe(GLIDE);
  jest.advanceTimersByTime(FAB_GLIDE_MS + 100);
  expect(el.style.transition).toBe('');
  expect(app.log.synced).toEqual([{ sosCorner: 'bottom-left' }]);
});

test('with reduced motion on, the button is simply in its corner: no glide, and the transition back', () => {
  window.matchMedia = jest.fn((q) => ({ matches: q === '(prefers-reduced-motion: reduce)', media: q }));
  const el = fakeButton('bottom-left');
  const app = appHandlers(el);
  app.down(38, 717);
  app.move(300, 200);
  app.up(300, 200);
  expect(el.corner).toBe('top-right');
  expect(el.frames).toHaveLength(0);
  expect(el.style.transform).toBe('');
  expect(el.style.transition).toBe('');
  expect(el.listening('transitionend')).toBe(0);
});

test('nothing to glide from, or nowhere to glide: the transition comes back and nothing is drawn', () => {
  for (const [from, connected] of [[null, true], [{ left: NaN, top: 0, width: 52, height: 52 }, true], [restBox('bottom-left'), true], [{ left: 0, top: 0, width: 52, height: 52 }, false]]) {
    const el = fakeButton('bottom-left');
    el.isConnected = connected;
    el.style.transition = 'none';
    glideFabHome(el, from);
    expect(el.style.transition).toBe('');
    expect(el.style.transform).toBe('');
    expect(el.frames).toHaveLength(0);
  }
  // And stopping a button with no glide does nothing at all.
  const idle = fakeButton('top-left');
  expect(() => stopFabGlide(idle)).not.toThrow();
  expect(() => stopFabGlide(null)).not.toThrow();
});

test('App.js switches the transition off in one place only, and every release goes through the glide or hands it back', () => {
  expect(APP.match(/style\.transition = 'none'/g)).toHaveLength(1);
  const down = slice('const handleFabPointerDown = useCallback(', 'const handleFabPointerMove');
  expect(down.indexOf('stopFabGlide(el);')).toBeGreaterThan(-1);
  expect(down.indexOf('stopFabGlide(el);')).toBeLessThan(down.indexOf("el.style.transition = 'none';"));
  const up = slice('const handleFabPointerUp = useCallback(', '\n  // Interests.');
  expect(up.indexOf('const dropped = wasDrag ? d.el.getBoundingClientRect() : null;')).toBeLessThan(up.indexOf("d.el.style.transform = '';"));
  expect(up).toContain('flushSync(() => setBirdieCorner(corner));');
  expect(up).toContain('flushSync(() => setSosCorner(sos));');
  expect(up.indexOf('glideFabHome(d.el, dropped);')).toBeGreaterThan(up.indexOf('flushSync(() => setSosCorner(sos));'));
  expect(up).toMatch(/\} else \{\n[^\n]*\n\s+d\.el\.style\.transition = '';\n\s+\}/);
});
