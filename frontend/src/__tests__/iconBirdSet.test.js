/**
 * THE BIRD SET (2026-11-07): the tab glyphs and what the Nest asks for, held to
 * the rules they were drawn by.
 *
 * components/ui/Icons.js draws the five tabs as pairs, outline when idle and
 * filled when selected (nest, discover, plans, messages, you), plus the egg
 * (startFlock, nestEgg), the receipt (splitBill), Flock Pro's two gulls (pro)
 * and the plain marks folded in from stray inline SVGs. The rules are in the
 * Icons.js header and components/ui/icons/README.md. What a rule cannot see,
 * whether a birdhouse reads as home, was judged by eye on specimen sheets at
 * 16 to 48 px; this file holds the parts of it that are geometry.
 *
 * The drawings are rendered, then read back as geometry: every path is parsed
 * (M, L, A and Z, absolute, which is all the set uses) and sampled, so the
 * grid, the silhouette of each filled twin, the optical centre and the clear
 * gaps are measured on what the app actually paints.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test iconBirdSet --watchAll=false
 */

const { renderToStaticMarkup } = require('react-dom/server');
const Icons = require('../components/ui/Icons').default;
const { sw, EGG_D } = require('../components/ui/Icons');

const TAB_PAIRS = [
  ['nest', 'nestFilled'],
  ['discover', 'discoverFilled'],
  ['plans', 'plansFilled'],
  ['messages', 'messagesFilled'],
  ['you', 'youFilled'],
];
const TAB_KEYS = TAB_PAIRS.flat();
const SET_KEYS = [...TAB_KEYS, 'startFlock', 'nestEgg', 'splitBill', 'pro', 'helpCircle', 'locate', 'maximize', 'minimize', 'menuLines'];
// Stroke width in viewBox units at every size above 10.5 px, where sw() is
// size / 10.5 and one unit is size / 24 px.
const STROKE_UNITS = 24 / 10.5;
const HALF = STROKE_UNITS / 2;

/** Render one glyph and hand back its wrapper <span> as a DOM node. */
function draw(key, size = 24, color) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(color === undefined ? Icons[key](undefined, size) : Icons[key](color, size));
  return host.firstElementChild;
}

/* ---------------------------------------------------------------- geometry */

const num = (s) => Number(s);

/** Parse absolute M/L/A/Z path data into segments. */
function parsePath(d) {
  const toks = d.match(/[MLAZ]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const segs = [];
  const pts = [];
  let i = 0;
  let cmd = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const next = () => num(toks[i++]);
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i])) {
      cmd = toks[i++];
      if (cmd === 'Z') {
        segs.push({ type: 'L', from: [x, y], to: [sx, sy] });
        x = sx; y = sy;
        continue;
      }
    }
    if (cmd === 'M') {
      x = next(); y = next(); sx = x; sy = y;
      pts.push([x, y]);
      cmd = 'L';
    } else if (cmd === 'L') {
      const nx = next(); const ny = next();
      segs.push({ type: 'L', from: [x, y], to: [nx, ny] });
      x = nx; y = ny;
      pts.push([x, y]);
    } else if (cmd === 'A') {
      const rx = next(); const ry = next(); const rot = next(); const large = next(); const sweep = next();
      const nx = next(); const ny = next();
      segs.push({ type: 'A', from: [x, y], to: [nx, ny], rx, ry, rot, large, sweep });
      x = nx; y = ny;
      pts.push([x, y]);
    } else {
      throw new Error(`unsupported path command ${cmd} in ${d}`);
    }
  }
  return { segs, pts };
}

/** Points along a circular arc (SVG endpoint parameterisation, F.6.5). */
function arcSamples(seg, n = 48) {
  const [x1, y1] = seg.from;
  const [x2, y2] = seg.to;
  let r = seg.rx;
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const lam = (dx * dx + dy * dy) / (r * r);
  if (lam > 1) r *= Math.sqrt(lam);
  const sign = seg.large === seg.sweep ? -1 : 1;
  const co = sign * Math.sqrt(Math.max(0, (r * r * r * r - r * r * dy * dy - r * r * dx * dx) / (r * r * dy * dy + r * r * dx * dx)));
  const cxp = co * dy;
  const cyp = -co * dx;
  const cx = cxp + (x1 + x2) / 2;
  const cy = cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (dx - cxp) / r, (dy - cyp) / r);
  let dt = ang((dx - cxp) / r, (dy - cyp) / r, (-dx - cxp) / r, (-dy - cyp) / r);
  if (!seg.sweep && dt > 0) dt -= 2 * Math.PI;
  else if (seg.sweep && dt < 0) dt += 2 * Math.PI;
  const out = [];
  for (let k = 0; k <= n; k += 1) {
    const t = t1 + (dt * k) / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

function lineSamples(seg, step = 0.1) {
  const [x1, y1] = seg.from;
  const [x2, y2] = seg.to;
  const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
  const out = [];
  for (let k = 0; k <= n; k += 1) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  return out;
}

/**
 * Every painted element of a rendered glyph, as geometry: its sampled
 * outline, the numbers its author typed, and whether it carries the stroke.
 */
function shapes(span) {
  const svg = span.querySelector('svg');
  return [...svg.querySelectorAll('path, circle')].map((el) => {
    const stroked = el.getAttribute('stroke') !== 'none';
    if (el.tagName.toLowerCase() === 'circle') {
      const cx = num(el.getAttribute('cx'));
      const cy = num(el.getAttribute('cy'));
      const r = num(el.getAttribute('r'));
      const samples = [];
      for (let k = 0; k < 96; k += 1) samples.push([cx + r * Math.cos((k / 96) * 2 * Math.PI), cy + r * Math.sin((k / 96) * 2 * Math.PI)]);
      return { el, stroked, samples, typed: [cx, cy, r], points: [[cx, cy]], filled: el.getAttribute('fill') === 'currentColor' };
    }
    const d = el.getAttribute('d');
    const { segs, pts } = parsePath(d);
    const samples = segs.flatMap((s) => (s.type === 'A' ? arcSamples(s) : lineSamples(s)));
    const typed = (d.match(/-?\d*\.?\d+/g) || []).map(num);
    return { el, stroked, samples, typed, points: pts, segs, filled: el.getAttribute('fill') === 'currentColor' };
  });
}

/** The painted box of a glyph: sampled outlines grown by half a stroke where stroked. */
function paintedBox(span) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of shapes(span)) {
    const grow = s.stroked ? HALF : 0;
    for (const [x, y] of s.samples) {
      x0 = Math.min(x0, x - grow); y0 = Math.min(y0, y - grow);
      x1 = Math.max(x1, x + grow); y1 = Math.max(y1, y + grow);
    }
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

const onQuarter = (v) => Math.abs(v * 4 - Math.round(v * 4)) < 1e-9;

/* ------------------------------------------------------------------- tests */

describe('every key of the set exists and paints in currentColor only', () => {
  test.each(SET_KEYS)('%s renders a 24-unit svg', (key) => {
    expect(typeof Icons[key]).toBe('function');
    const span = draw(key, 24);
    const svg = span.querySelector('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(span.querySelectorAll('path, circle').length).toBeGreaterThan(0);
  });

  test.each(SET_KEYS)('%s uses no colour of its own and no default colour', (key) => {
    const span = draw(key, 20);
    const paints = [...span.querySelectorAll('*')].flatMap((el) => ['fill', 'stroke', 'color', 'stop-color']
      .map((a) => el.getAttribute(a)).filter((v) => v !== null));
    paints.forEach((v) => expect(['currentColor', 'none', 'transparent']).toContain(v));
    // Called with no colour, the wrapper hands the glyph currentColor: nine
    // older keys default to a hue (starFilled amber, zap amber, ...); a key of
    // this set never does.
    const bare = draw(key, 20, undefined);
    expect(bare.getAttribute('style')).toMatch(/color:currentColor/);
    expect(span.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|gradient/i);
  });

  test.each(SET_KEYS)('%s rides the one stroke: sw(size) on the svg and nowhere else', (key) => {
    for (const size of [16, 20, 24]) {
      const span = draw(key, size);
      expect(span.querySelector('svg').getAttribute('stroke-width')).toBe(String(sw(size)));
      [...span.querySelectorAll('path, circle')].forEach((el) => expect(el.getAttribute('stroke-width')).toBeNull());
    }
  });

  test.each(SET_KEYS)('%s adds no unstroked paint except the dot helper', (key) => {
    for (const el of draw(key, 24).querySelectorAll('[stroke="none"]')) {
      // dot(): a filled circle with no stroke, and nothing else may skip it.
      expect(el.tagName.toLowerCase()).toBe('circle');
      expect(el.getAttribute('fill')).toBe('currentColor');
    }
  });

  test('the redrawn people keep their names, so every caller changes with no edit', () => {
    ['users', 'userPlus'].forEach((key) => expect(typeof Icons[key]).toBe('function'));
    // The neck gap: the head's circle stops 1.5 units (plus the stroke) above
    // the shoulders' arc.
    const users = shapes(draw('users'));
    const [head, shoulders] = users;
    expect(head.typed[1] + head.typed[2] + STROKE_UNITS + 1.5).toBeLessThanOrEqual(Math.min(...shoulders.samples.map(([, y]) => y)) + 1e-9);
  });
});

describe('the five tab glyphs come in pairs', () => {
  test.each(TAB_PAIRS)('%s has its selected twin %s', (idle, selected) => {
    expect(typeof Icons[idle]).toBe('function');
    expect(typeof Icons[selected]).toBe('function');
    // The twin is filled: at least one shape paints currentColor inside.
    expect(shapes(draw(selected)).some((s) => s.filled)).toBe(true);
  });

  test.each(TAB_PAIRS)('%s and %s share one silhouette, so the swap does not shrink', (idle, selected) => {
    const a = paintedBox(draw(idle));
    const b = paintedBox(draw(selected));
    ['x0', 'y0', 'x1', 'y1'].forEach((k) => expect(Math.abs(a[k] - b[k])).toBeLessThan(0.05));
  });

  test('a filled twin punches its inner details out instead of painting them in a background colour', () => {
    ['nestFilled', 'discoverFilled', 'plansFilled'].forEach((key) => {
      const holes = [...draw(key).querySelectorAll('path[fill-rule="evenodd"]')];
      expect(holes.length).toBeGreaterThan(0);
    });
  });
});

describe('every tab glyph sits on the 24 grid', () => {
  test.each(TAB_KEYS)('%s: every number on the quarter-unit grid, every centreline inside the live area', (key) => {
    for (const s of shapes(draw(key))) {
      s.typed.forEach((v) => expect({ key, v, onGrid: onQuarter(v) }).toEqual({ key, v, onGrid: true }));
      for (const [x, y] of s.samples) {
        expect(x).toBeGreaterThanOrEqual(2 - 1e-6);
        expect(x).toBeLessThanOrEqual(22 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(2 - 1e-6);
        expect(y).toBeLessThanOrEqual(22 + 1e-6);
      }
    }
  });

  test.each(TAB_KEYS)('%s: the paint stays inside the 24 box, stroke included', (key) => {
    const b = paintedBox(draw(key));
    expect(b.x0).toBeGreaterThanOrEqual(0);
    expect(b.y0).toBeGreaterThanOrEqual(0);
    expect(b.x1).toBeLessThanOrEqual(24);
    expect(b.y1).toBeLessThanOrEqual(24);
  });

  test.each(TAB_KEYS)('%s: centred within half a unit of 12,12', (key) => {
    const b = paintedBox(draw(key));
    expect(Math.abs(b.cx - 12)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(Math.abs(b.cy - 12)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  test.each(TAB_KEYS)('%s: straight segments run at 0, 45 or 90 degrees, arcs are circular', (key) => {
    for (const s of shapes(draw(key))) {
      for (const seg of s.segs || []) {
        if (seg.type === 'A') {
          expect(seg.rx).toBe(seg.ry);
          continue;
        }
        const [x1, y1] = seg.from;
        const [x2, y2] = seg.to;
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        const ok = dx < 1e-9 || dy < 1e-9 || Math.abs(dx - dy) < 1e-9;
        expect({ key, seg: [seg.from, seg.to], ok }).toEqual({ key, seg: [seg.from, seg.to], ok: true });
      }
    }
  });

  test.each(['nest', 'discover', 'plans', 'messages', 'you'])('%s: separate parts stay 1.5 units clear', (key) => {
    const parts = shapes(draw(key));
    const n = parts.length;
    const dist = [...Array(n)].map(() => Array(n).fill(Infinity));
    for (let a = 0; a < n; a += 1) {
      for (let b = a + 1; b < n; b += 1) {
        let d = Infinity;
        for (const p of parts[a].samples) for (const q of parts[b].samples) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1]));
        dist[a][b] = d;
        dist[b][a] = d;
      }
    }
    // Shapes that touch are one part (the walls meet the roof, the hangers
    // meet the box, the bridge meets the barrels); only parts that do not
    // touch at all are held to the gap.
    const root = [...Array(n).keys()];
    const find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
    for (let a = 0; a < n; a += 1) for (let b = a + 1; b < n; b += 1) if (dist[a][b] < 0.06) root[find(a)] = find(b);
    for (let a = 0; a < n; a += 1) {
      for (let b = a + 1; b < n; b += 1) {
        if (find(a) === find(b)) continue;
        const clear = dist[a][b] - (parts[a].stroked ? HALF : 0) - (parts[b].stroked ? HALF : 0);
        expect({ key, a, b, clear: Number(clear.toFixed(2)), ok: clear >= 1.5 - 0.06 }).toEqual({ key, a, b, clear: Number(clear.toFixed(2)), ok: true });
      }
    }
  });

  test('the cut in plansFilled shows at least 1.5 units once the stroke has eaten its edges', () => {
    const body = shapes(draw('plansFilled')).find((s) => s.filled);
    // The slit is the second sub-path: a band from y 9 to y 13.
    const ys = body.points.slice(4, 8).map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys) - STROKE_UNITS).toBeGreaterThanOrEqual(1.5);
  });
});

describe('the egg and the rest of the set', () => {
  test('startFlock and nestEgg are one egg (the EGG_D constant)', () => {
    ['startFlock', 'nestEgg'].forEach((key) => {
      expect(draw(key).querySelector('path').getAttribute('d')).toBe(EGG_D);
    });
  });

  test('the egg is a Moss egg: its arcs meet without a kink', () => {
    const { segs } = parsePath(EGG_D);
    const arcs = segs.filter((s) => s.type === 'A');
    expect(arcs).toHaveLength(4);
    // Tangent directions at each join, from the sampled arcs, agree to a degree.
    const dir = (pts, end) => {
      const [a, b] = end ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[0], pts[1]];
      return Math.atan2(b[1] - a[1], b[0] - a[0]);
    };
    for (let i = 0; i < 4; i += 1) {
      const out = dir(arcSamples(arcs[i], 400), true);
      const inn = dir(arcSamples(arcs[(i + 1) % 4], 400), false);
      const diff = Math.abs(Math.atan2(Math.sin(out - inn), Math.cos(out - inn)));
      expect(diff).toBeLessThan(Math.PI / 180);
    }
  });

  test('pro is the drawing sparkles was: two gulls, no star', () => {
    const d = [...draw('pro').querySelectorAll('path')].map((p) => p.getAttribute('d'));
    expect(d).toEqual(['M7 17.5 12 12.5 17 17.5', 'M10 9.5 13 6.5 16 9.5']);
  });

  test('the round holes the set punches are the door, the glass and the pebble, never an eye', () => {
    // An eye is Birdie's alone (the README's cue rules). The holes this set
    // does punch are the birdhouse's door, the binoculars' glass and the
    // pebble, each on a named key; a round hole anywhere else is a new face.
    const punched = SET_KEYS.filter((key) => /A[\d.]+ [\d.]+ 0 1 [01]/.test(
      [...draw(key).querySelectorAll('path[fill-rule="evenodd"]')].map((p) => p.getAttribute('d')).join(' ')
    ));
    expect(punched.sort()).toEqual(['discoverFilled', 'nestFilled', 'plansFilled']);
  });
});
