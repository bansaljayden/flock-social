/**
 * BIRDIE NEVER RESTS UNDER SOS (2026-11-04).
 *
 * SOS docks in a bottom corner and Birdie can be dragged to any of the four.
 * Both are 52px discs 12px in from the side, the bottom corners on the same
 * docked row, and SOS is drawn after Birdie, so Birdie in SOS's corner
 * (dropped there, remembered there, or joined there by SOS) sat exactly under
 * it. Measured on the screenshot rig at 390x844 and 390x667: 2,704 px2 of
 * overlap, the whole disc, and none of five tap points across Birdie's disc
 * reached it, whether Birdie was dropped on SOS, dropped at the right edge or
 * loaded from a corner saved there. Now it rests beside SOS, 12px toward the
 * middle, and SOS stays where it was.
 *
 * jsdom lays nothing out, so this runs App.js's own code, lifted from the
 * source (cornerStyle, Birdie's inset, the drop's corner and the stored-corner
 * reads), and lays the two buttons out on the same frames by hand, the way the
 * rig measured them: a disc's box is its px from the side and, in a bottom
 * corner, the Nest's dock bottom (the tab bar plus the 12px gap).
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

const constant = (name) => {
  const m = APP.match(new RegExp(`\\n\\s+const ${name} = (\\d+);`));
  if (!m) throw new Error(`no const ${name} in App.js`);
  return Number(m[1]);
};
const TAB_BAR_H = constant('TAB_BAR_H');
const FAB_DOCK_GAP = constant('FAB_DOCK_GAP');
const FAB_SIZE = constant('FAB_SIZE');
const FAB_EDGE = constant('FAB_EDGE');
const NEST_DOCK_BOTTOM = TAB_BAR_H + FAB_DOCK_GAP;

const between = (from, to) => {
  const at = APP.indexOf(from);
  if (at < 0) throw new Error(`not found: ${from}`);
  const end = APP.indexOf(to, at + from.length);
  if (end < 0) throw new Error(`not found after ${from}: ${to}`);
  return APP.slice(at + from.length, end);
};

// cornerStyle exactly as App.js writes it, handed the Nest's dock bottom.
const cornerStyle = new Function(
  'fabDockBottom',
  `return ${between('const cornerStyle = useCallback(', '}, [fabDockBottom]);')}};`
)(`${NEST_DOCK_BOTTOM}px`);

// Birdie's distance from its side, from App.js's own expression.
const birdieInsetExpr = APP.match(/\n\s+const birdieInset = ([^;\n]+);/);
const birdieInsetOf = new Function('safetyOn', 'birdieCorner', 'sosCorner', 'FAB_EDGE', 'FAB_SIZE', `return (${birdieInsetExpr && birdieInsetExpr[1]});`);
const birdieInset = (birdieCorner, sosCorner, safetyOn = true) => birdieInsetOf(safetyOn, birdieCorner, sosCorner, FAB_EDGE, FAB_SIZE);

// The corner a drag resolves to, from the three lines handleFabPointerUp uses.
const snapLines = between('const cy = e.clientY - rect.top;', 'if (d.id === \'birdie\')');
const dropCorner = new Function('cx', 'cy', 'rect', `${snapLines}\nreturn corner;`);

// The stored corners as the screen reads them on mount.
const storedBirdie = new Function('localStorage', `return (${between('const [birdieCorner, setBirdieCorner] = useState(', ');\n')})();`);
const storedSos = new Function('localStorage', `return (${between('const [sosCorner, setSosCorner] = useState(', ');\n  const dragRef')})();`);
const storage = (values) => ({ getItem: (k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : null) });

const px = (v) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(String(v));
  if (!m) throw new Error(`not a px length: ${v}`);
  return Number(m[1]);
};
// A button's box on a vw x vh frame. `width` is the whole button's, which
// grows away from the side it rests on (Birdie's preview pill).
const box = (style, vw, vh, width = FAB_SIZE) => {
  const x = style.left !== undefined ? px(style.left) : vw - px(style.right) - width;
  const y = style.top !== undefined ? px(style.top) : vh - px(style.bottom) - FAB_SIZE;
  return { x, y, right: x + width, bottom: y + FAB_SIZE };
};
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
const onFrame = (b, vw, vh) => b.x >= 0 && b.y >= 0 && b.right <= vw && b.bottom <= vh;

const FRAMES = [[390, 844], [390, 667]];
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const SOS_CORNERS = ['bottom-left', 'bottom-right'];
const sosBox = (sosCorner, vw, vh) => box(cornerStyle(sosCorner, FAB_EDGE), vw, vh);
const birdieBox = (birdieCorner, sosCorner, vw, vh, width) => box(cornerStyle(birdieCorner, birdieInset(birdieCorner, sosCorner)), vw, vh, width);

test('the lifted geometry is App.js\'s: SOS and Birdie both go through cornerStyle, on the Nest\'s dock', () => {
  expect(birdieInsetExpr).not.toBeNull();
  expect(APP).toContain("const chrome = TAB_BAR_H + (currentTab === 'explore' ? DISCOVER_FILTER_BAR_H : 0) + FAB_DOCK_GAP;");
  expect(cornerStyle('bottom-right', FAB_EDGE)).toEqual({ bottom: '101px', right: '12px' });
  expect(cornerStyle('top-left', FAB_EDGE)).toEqual({ top: '60px', left: '12px' });
  const sos = APP.slice(APP.indexOf('const SafetyButton = () =>'), APP.indexOf('const SafetyButton = () =>') + 1400);
  const birdie = APP.slice(APP.indexOf('const AIBubble = () =>'), APP.indexOf('const AIBubble = () =>') + 1400);
  expect(sos).toContain('...cornerStyle(sosCorner, FAB_EDGE),');
  expect(birdie).toContain('...cornerStyle(birdieCorner, birdieInset),');
  // On the Nest, Birdie is drawn first and SOS over it.
  expect(APP).toMatch(/\{AIBubble\(\)\}\n\s+\{SafetyButton\(\)\}/);
});

test('given SOS\'s own 12px, Birdie in the same corner is the whole disc under it (what this fixes)', () => {
  for (const [vw, vh] of FRAMES) {
    for (const corner of SOS_CORNERS) {
      expect(overlap(box(cornerStyle(corner, FAB_EDGE), vw, vh), sosBox(corner, vw, vh))).toBe(2704);
    }
  }
});

test('at 390x844 and 390x667, every corner Birdie can rest in keeps both discs whole, apart and on screen', () => {
  for (const [vw, vh] of FRAMES) {
    for (const sosCorner of SOS_CORNERS) {
      const sos = sosBox(sosCorner, vw, vh);
      expect(onFrame(sos, vw, vh)).toBe(true);
      for (const birdieCorner of CORNERS) {
        const b = birdieBox(birdieCorner, sosCorner, vw, vh);
        expect({ vw, vh, birdieCorner, sosCorner, overlap: overlap(b, sos) }).toEqual({ vw, vh, birdieCorner, sosCorner, overlap: 0 });
        expect(onFrame(b, vw, vh)).toBe(true);
        // On the same row, a full 12px between them.
        if (b.y === sos.y) expect(Math.max(sos.x - b.right, b.x - sos.right)).toBeGreaterThanOrEqual(FAB_EDGE);
      }
    }
  }
});

test('dropped on SOS or at its edge, Birdie rests beside SOS on the same row, and SOS does not move', () => {
  for (const [vw, vh] of FRAMES) {
    for (const sosCorner of SOS_CORNERS) {
      const sos = sosBox(sosCorner, vw, vh);
      const right = sosCorner === 'bottom-right';
      const drops = [
        { x: sos.x + FAB_SIZE / 2, y: sos.y + FAB_SIZE / 2 },         // on SOS
        { x: right ? vw - 4 : 4, y: vh - 140 },                       // at the side edge
        { x: right ? vw - 1 : 1, y: vh - 1 },                         // in the very corner
        { x: right ? vw * 0.6 : vw * 0.4, y: vh - 110 },              // on the bottom edge, toward the middle
      ];
      for (const drop of drops) {
        const corner = dropCorner(drop.x, drop.y, { width: vw, height: vh });
        expect(corner).toBe(sosCorner);
        const b = birdieBox(corner, sosCorner, vw, vh);
        expect(overlap(b, sos)).toBe(0);
        expect(b.y).toBe(sos.y);
        expect(b.bottom).toBe(sos.bottom);
        // Beside it, toward the middle, one 12px gap.
        if (right) expect(sos.x - b.right).toBe(FAB_EDGE);
        else expect(b.x - sos.right).toBe(FAB_EDGE);
        // SOS is where it is with Birdie anywhere else.
        expect(sosBox(sosCorner, vw, vh)).toEqual(sos);
      }
    }
  }
});

test('a corner saved where SOS sits loads clear of it, and the saved corner is left as it was', () => {
  const cases = [
    { name: 'Birdie saved bottom-right, SOS at its default', values: { flock_birdie_corner: 'bottom-right' }, birdie: 'bottom-right', sos: 'bottom-right' },
    { name: 'both saved bottom-left', values: { flock_birdie_corner: 'bottom-left', flock_sos_corner: 'bottom-left' }, birdie: 'bottom-left', sos: 'bottom-left' },
    { name: 'Birdie at its default, SOS saved as an old top corner', values: { flock_sos_corner: 'top-left' }, birdie: 'bottom-left', sos: 'bottom-left' },
  ];
  for (const c of cases) {
    const ls = storage(c.values);
    const birdieCorner = storedBirdie(ls);
    const sosCorner = storedSos(ls);
    expect({ name: c.name, birdieCorner, sosCorner }).toEqual({ name: c.name, birdieCorner: c.birdie, sosCorner: c.sos });
    for (const [vw, vh] of FRAMES) {
      const b = birdieBox(birdieCorner, sosCorner, vw, vh);
      const sos = sosBox(sosCorner, vw, vh);
      expect({ name: c.name, vw, vh, overlap: overlap(b, sos) }).toEqual({ name: c.name, vw, vh, overlap: 0 });
      expect(onFrame(b, vw, vh)).toBe(true);
    }
  }
  // Nothing on that path writes a corner back: the one Birdie was given stays
  // remembered, and it is a drag that saves one.
  const mount = APP.slice(APP.indexOf('const [birdieCorner, setBirdieCorner] = useState('), APP.indexOf('const dragRef = useRef(null);'));
  expect(mount).not.toMatch(/setItem|lsSet|queueSync/);
});

test('Birdie takes the corner itself when SOS is elsewhere or Safety is off', () => {
  expect(birdieInset('bottom-right', 'bottom-right', true)).toBe(FAB_EDGE + FAB_SIZE + FAB_EDGE);
  expect(birdieInset('bottom-right', 'bottom-right', false)).toBe(FAB_EDGE);
  expect(birdieInset('bottom-right', 'bottom-left', true)).toBe(FAB_EDGE);
  expect(birdieInset('top-right', 'bottom-right', true)).toBe(FAB_EDGE);
  expect(birdieInset('top-left', 'bottom-left', true)).toBe(FAB_EDGE);
});

// Birdie's preview of its last answer widens the button away from the side it
// rests on: the disc, an 8px gap and a pill of at most 180px. App.js sets
// border-box on everything, so that is the pill's whole width, and on the rig
// the button measured 240 wide. It stays clear of SOS and on the screen in
// every resting place, at both heights and at the 320 floor.
test('with its preview showing, the whole button stays on screen and clear of SOS, down to 320 wide', () => {
  expect(APP).toMatch(/\*, \*::before, \*::after \{\n\s+box-sizing: border-box;/);
  const bubble = APP.slice(APP.indexOf('const AIBubble = () =>'), APP.indexOf('// The one thing a 403 with emailVerificationRequired needs'));
  expect(bubble).toContain("gap: '8px',");
  const m = bubble.match(/maxWidth: '(\d+)px',/);
  expect(m).not.toBeNull();
  const widest = FAB_SIZE + 8 + Number(m[1]);
  expect(widest).toBe(240);
  for (const [vw, vh] of [...FRAMES, [320, 693]]) {
    for (const sosCorner of SOS_CORNERS) {
      const sos = sosBox(sosCorner, vw, vh);
      for (const birdieCorner of CORNERS) {
        const b = birdieBox(birdieCorner, sosCorner, vw, vh, widest);
        expect({ vw, birdieCorner, sosCorner, overlap: overlap(b, sos), onFrame: onFrame(b, vw, vh) })
          .toEqual({ vw, birdieCorner, sosCorner, overlap: 0, onFrame: true });
      }
    }
  }
});
