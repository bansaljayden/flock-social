/**
 * BIRDIE NEVER RESTS UNDER SOS.
 *
 * 2026-11-04: SOS docks in a bottom corner and Birdie's disc could be dragged
 * to any of the four. Both were 52px discs 12px in from the side, so Birdie in
 * SOS's corner sat exactly under it (2,704 px2 of overlap on the rig, no tap
 * reached Birdie), and the fix rested it beside SOS.
 *
 * 2026-11-06: Birdie's disc left the Nest. Birdie is a section of the page,
 * and its way in from anywhere down the page is an "Ask Birdie" pill in the
 * strip above the tabs (components/nest/NestDock.js), on the side OPPOSITE
 * SOS, level with it. The page's scroll ends at the strip's top, so nothing on
 * the page passes under either. What stays true, and is run here at 320, 390
 * and 430 wide with SOS on each side: SOS is whole, on screen and inside the
 * strip; the pill is whole, on screen, never under SOS, and on the other side.
 *
 * jsdom lays nothing out, so this runs App.js's own code, lifted from the
 * source (cornerStyle, the drop's corner, the stored-corner reads), and lays
 * the two out on the frames by hand, the way the rig measured them: SOS's box
 * is its px from the side and the Nest's dock bottom (the tab bar plus the
 * 12px gap); the pill's is NestDock's own numbers.
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const DOCK = fs.readFileSync(path.join(__dirname, '..', 'components', 'nest', 'NestDock.js'), 'utf8').replace(/\r\n/g, '\n');

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
const NEST_DOCK_EXTRA = Number(DOCK.match(/export const NEST_DOCK_EXTRA = (\d+);/)[1]);
const STRIP_H = FAB_DOCK_GAP + FAB_SIZE + NEST_DOCK_EXTRA;

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

// The corner a drag resolves to, from the three lines handleFabPointerUp uses.
const snapLines = between('const cy = e.clientY - rect.top;', 'if (d.id === \'birdie\')');
const dropCorner = new Function('cx', 'cy', 'rect', `${snapLines}\nreturn corner;`);

// The stored SOS corner as the screen reads it on mount.
const storedSos = new Function('localStorage', `return (${between('const [sosCorner, setSosCorner] = useState(', ');\n  const dragRef')})();`);
const storage = (values) => ({ getItem: (k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : null) });

const px = (v) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(String(v));
  if (!m) throw new Error(`not a px length: ${v}`);
  return Number(m[1]);
};
const box = (style, vw, vh, width = FAB_SIZE, height = FAB_SIZE) => {
  const x = style.left !== undefined ? px(style.left) : vw - px(style.right) - width;
  const y = style.top !== undefined ? px(style.top) : vh - px(style.bottom) - height;
  return { x, y, right: x + width, bottom: y + height };
};
const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
const onFrame = (b, vw, vh) => b.x >= 0 && b.y >= 0 && b.right <= vw && b.bottom <= vh;

const FRAMES = [[320, 693], [390, 844], [430, 932]];
const SOS_CORNERS = ['bottom-left', 'bottom-right'];
const sosBox = (sosCorner, vw, vh) => box(cornerStyle(sosCorner, FAB_EDGE), vw, vh);

// The pill, from NestDock: 44 tall, `bottom` px up from the strip's bottom
// (which sits on the tab bar), the gutter in from its side, and at most this
// wide: a 28px face, 8px, "Ask Birdie" at 15px and 8 + 16 padding measured
// 139 on the rig; 150 is the bound.
const PILL_W = 150;
const PILL_H = Number(DOCK.match(/height: '(\d+)px',\n\s+padding: '0 16px 0 8px'/)[1]);
const PILL_BOTTOM = Number(DOCK.match(/bottom: '(\d+)px',\n\s+\[left \? 'left' : 'right'\]: 'var\(--nest-gutter\)'/)[1]);
const gutter = (vw) => Math.min(20, Math.max(16, vw * 0.052));
const pillBox = (sosCorner, vw, vh) => {
  const sosSide = sosCorner.includes('left') ? 'left' : 'right';
  const left = sosSide !== 'left';
  const style = left ? { left: `${gutter(vw)}px` } : { right: `${gutter(vw)}px` };
  style.bottom = `${TAB_BAR_H + PILL_BOTTOM}px`;
  return { ...box(style, vw, vh, PILL_W, PILL_H), side: left ? 'left' : 'right' };
};

test('the lifted geometry is App.js\'s: SOS goes through cornerStyle on the Nest\'s dock', () => {
  expect(APP).toContain("const chrome = TAB_BAR_H + (currentTab === 'explore' ? DISCOVER_FILTER_BAR_H : 0) + FAB_DOCK_GAP;");
  // The tab bar measures 82 since its dot went (2026-11-06), plus the 12px gap.
  expect(cornerStyle('bottom-right', FAB_EDGE)).toEqual({ bottom: '94px', right: '12px' });
  const sos = APP.slice(APP.indexOf('const SafetyButton = () =>'), APP.indexOf('const SafetyButton = () =>') + 1600);
  expect(sos).toContain('...cornerStyle(sosCorner, FAB_EDGE),');
});

test('Birdie\'s disc is gone from the Nest, and the strip sits between the page and the tabs', () => {
  expect(APP).not.toMatch(/const AIBubble = /);
  expect(APP).not.toMatch(/AIBubble\(\)/);
  expect(APP).not.toMatch(/const birdieInset = /);
  expect(APP).toContain('const nestDockHeight = FAB_DOCK_GAP + FAB_SIZE + NEST_DOCK_EXTRA;');
  expect(APP).toMatch(/<NestDock\s+height=\{nestDockHeight\}[\s\S]*?\/>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?\{SafetyButton\(\)\}\s*\{BottomNav\(\)\}/);
});

test('at 320, 390 and 430, SOS is whole, on screen and inside the strip, on either side', () => {
  for (const [vw, vh] of FRAMES) {
    for (const sosCorner of SOS_CORNERS) {
      const sos = sosBox(sosCorner, vw, vh);
      const strip = { x: 0, y: vh - TAB_BAR_H - STRIP_H, right: vw, bottom: vh - TAB_BAR_H };
      expect({ vw, sosCorner, onFrame: onFrame(sos, vw, vh) }).toEqual({ vw, sosCorner, onFrame: true });
      // Wholly inside the strip: the page above it never reaches SOS.
      expect(overlap(sos, strip)).toBe(FAB_SIZE * FAB_SIZE);
    }
  }
});

test('the Ask Birdie pill rests on the side opposite SOS, level with it, never under it', () => {
  expect(DOCK).toMatch(/const left = sosSide !== 'left';/);
  expect(APP).toMatch(/sosSide=\{safetyOn && sosCorner\.includes\('left'\) \? 'left' : 'right'\}/);
  for (const [vw, vh] of FRAMES) {
    for (const sosCorner of SOS_CORNERS) {
      const sos = sosBox(sosCorner, vw, vh);
      const pill = pillBox(sosCorner, vw, vh);
      expect({ vw, sosCorner, side: pill.side }).toEqual({ vw, sosCorner, side: sosCorner.includes('left') ? 'right' : 'left' });
      expect({ vw, sosCorner, overlap: overlap(pill, sos), onFrame: onFrame(pill, vw, vh) })
        .toEqual({ vw, sosCorner, overlap: 0, onFrame: true });
      // Level: the same centre line.
      expect((pill.y + pill.bottom) / 2).toBe((sos.y + sos.bottom) / 2);
      // A clear gap between them even at 320 wide.
      expect(Math.max(sos.x - pill.right, pill.x - sos.right)).toBeGreaterThanOrEqual(FAB_EDGE);
    }
  }
});

test('a drop near a bottom corner docks SOS there, and an old top corner loads bottom left', () => {
  for (const [vw, vh] of FRAMES) {
    expect(dropCorner(vw - 4, vh - 140, { width: vw, height: vh })).toBe('bottom-right');
    expect(dropCorner(4, vh - 140, { width: vw, height: vh })).toBe('bottom-left');
  }
  expect(storedSos(storage({ flock_sos_corner: 'top-left' }))).toBe('bottom-left');
  expect(storedSos(storage({}))).toBe('bottom-right');
});
