/**
 * Flock icon system — Tier C.
 *
 * One geometry, obeyed 90-odd times:
 *   - butt caps, miter joins, zero corner radius
 *   - every straight segment at exactly 0 / 45 / 90 degrees
 *   - circular arcs on radii 11, 9, 7, 6, 5, 4, 3, 1.5, 1
 *   - EVERY CONTAINER IS DRAWN OPEN: any ring of r >= 7 is cut by a 30 degree
 *     gap centred on the upper-right diagonal; any rectangular container is
 *     missing its bottom edge. Rings under r=7 stay closed — the gap does not
 *     read at that radius and looks like damage.
 *   - stroke-width is derived from the render size and applied with
 *     vector-effect: non-scaling-stroke, so optical weight is identical at
 *     10px and at 40px.
 *
 * Stated exceptions, and only these two:
 *   1. `star` — five-fold symmetry cannot be built from 0/45/90.
 *   2. `birdie` — the punched eye is the only interior negative space here.
 *
 * Public API is unchanged: Icons.name(color, size) returns JSX. `color` is
 * honoured as a CSS `color` on a wrapper and picked up through currentColor,
 * so an icon also inherits correctly when `color` is omitted.
 */

import React from 'react';
import './icons.css';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

// Stroke weight per size band, in rendered CSS pixels.
const sw = (size) => (size <= 12 ? 1.25 : size <= 17 ? 1.5 : size <= 23 ? 1.75 : 2);

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The open ring. For radius r about (cx, cy) the arc runs from theta=60deg
 * counter-clockwise the long way round to theta=30deg, leaving a 30deg gap on
 * the upper-right diagonal.
 *   r=11 -> M17.5 2.47A11 11 0 1 0 21.53 6.5
 *   r=9  -> M16.5 4.21A9 9 0 1 0 19.79 7.5
 *   r=7  -> M15.5 5.94A7 7 0 1 0 18.06 8.5
 */
const ring = (cx, cy, r) =>
  `M${r2(cx + r * 0.5)} ${r2(cy - r * 0.866)}A${r} ${r} 0 1 0 ${r2(cx + r * 0.866)} ${r2(cy - r * 0.5)}`;

// A gull mark: the bird at distance. Two 45deg strokes meeting at a low peak.
// Capped at five glyphs across the whole set — it is a spice, not a theme.
const gull = (cx, cy, w) => `M${cx - w} ${cy + w / 2} ${cx} ${cy - w / 2} ${cx + w} ${cy + w / 2}`;

// Filled dot. Used only where the spec's own top-10 geometry calls for one.
const dot = (cx, cy, r = 1) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

const svg = (size, children, style) => (
  <svg
    className="flock-icon"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={sw(size)}
    strokeLinecap="butt"
    strokeLinejoin="miter"
    strokeMiterlimit="4"
    vectorEffect="non-scaling-stroke"
    aria-hidden="true"
    focusable="false"
    style={style}
  >
    {children}
  </svg>
);

/**
 * Build one icon. `children` is created once at module scope and reused, which
 * is what lets React keep the same DOM nodes across a star -> starFilled swap
 * so the fill can transition rather than pop.
 */
const make = (children, opts = {}) => {
  const { color: defColor = 'currentColor', size: defSize = 18, style, className } = opts;
  const wrapClass = className ? `flock-icon-wrap ${className}` : 'flock-icon-wrap';
  return (color = defColor, size = defSize) => (
    <span className={wrapClass} style={{ color, display: 'inline-flex' }}>
      {svg(size, children, style)}
    </span>
  );
};

/* ------------------------------------------------------------------ *
 * Shapes shared by more than one name
 * ------------------------------------------------------------------ */

// star / starFilled — the one radially symmetric figure, exempt from the angle
// rule. Outer r=9, inner r=3.8 (ratio 0.42, sharper than the usual 0.5).
const STAR_D =
  'M12 3 14.23 8.93 20.56 9.22 15.61 13.17 17.29 19.28 12 15.8 6.71 19.28 8.39 13.17 3.44 9.22 9.77 8.93Z';

// pin / pinFilled — one closed contour including the needle, so the two names
// are one drawing and the fill can transition.
const PIN_D =
  'M8 4 16 4 16 12 20 16 13.5 16 13.5 21 10.5 21 10.5 16 4 16 8 12Z';

// chevron — one path at three angles.
const CHEVRON = <path d="M4 15 12 7 20 15" />;
const ROT = (deg) => ({ transform: `rotate(${deg}deg)` });

// birdie — the specimen's head alone: filled round head, square-cut wedge beak,
// and the punched eye cut with fill-rule evenodd so it needs no background token.
const BIRDIE_D =
  'M6.5 11A6.5 6.5 0 1 1 19.5 11A6.5 6.5 0 1 1 6.5 11Z' +
  'M6.5 11 2 13 6.5 15Z' +
  'M13.6 9A1.4 1.4 0 1 1 16.4 9A1.4 1.4 0 1 1 13.6 9Z';

// mug — beer and coffee are the same mark.
const MUG = (
  <>
    <path d="M5 20 5 8 17 8 17 20" />
    <path d="M17 11 21 11 21 15 17 15" />
    <path d="M9 5 9 2M13 5 13 2" />
  </>
);

// stemware — cocktail and wine are the same mark.
const STEM = (
  <>
    <path d="M4 6 20 6 12 14Z" />
    <path d="M12 14 12 20" />
    <path d="M8 20 16 20" />
  </>
);

// chat / messageSquare — an open-bottom container: the missing edge is the mouth.
const CHAT = (
  <>
    <path d="M4 18 4 6 20 6 20 18" />
    <path d="M8 18 8 22 12 18" />
  </>
);

// party / partyPopper
const PARTY = (
  <>
    <path d="M3 21 3 15 9 21Z" />
    <path d="M9 13 13 9M12 17 17 12M15 20 20 15" />
  </>
);

/* ------------------------------------------------------------------ *
 * The set
 * ------------------------------------------------------------------ */

const Icons = {
  /* --- the top ten by usage, drawn to the spec's own coordinates --- */

  // 1. mapPin. Refuses the teardrop-with-a-hole: an open ring above a chevron
  // whose arms are the ring's own 45deg diagonals continued.
  mapPin: make(
    <>
      <path d="M15 5.8A6 6 0 1 0 17.2 8" />
      <path d="M7.76 15.24 12 19.49 16.24 15.24" />
    </>
  ),

  // 2. x
  x: make(<path d="M6 6 18 18M18 6 6 18" />),

  // 3. search. The gap and the handle sit on opposite diagonals.
  search: make(
    <>
      <path d="M13.5 3.94A7 7 0 1 0 16.06 6.5" />
      <path d="M14.95 14.95 20 20" />
    </>
  ),

  // 4. users. Two heads, one shared shoulder — a flock shares a body.
  users: make(
    <>
      <circle cx="8.5" cy="7.5" r="3" />
      <circle cx="15.5" cy="7.5" r="3" />
      <path d="M4 20A8 8 0 0 1 20 20" />
    </>
  ),

  // 5. arrowLeft
  arrowLeft: make(
    <>
      <path d="M20 12 4 12" />
      <path d="M10 6 4 12 10 18" />
    </>
  ),

  // 6. check. The long rising arm rhymes with the gull mark's right wing.
  check: make(<path d="M4 12.5 9.5 18 20 7.5" />, { size: 14 }),

  // 7. plus
  plus: make(<path d="M12 4 12 20M4 12 20 12" />),

  // 8. star / starFilled — one path, two renderings.
  star: make(<path d={STAR_D} fill="transparent" stroke="currentColor" />),
  starFilled: make(<path d={STAR_D} fill="currentColor" stroke="transparent" />, {
    color: '#F59E0B',
  }),

  // 9. clock. Hands at exactly 90 and 0, so the glyph is 0/90 plus one arc.
  clock: make(
    <>
      <path d="M16.5 4.21A9 9 0 1 0 19.79 7.5" />
      <path d="M12 6.5 12 12 17 12" />
    </>
  ),

  // 10. calendar. Refuses the box-with-a-grid; the open bottom echoes the wire.
  calendar: make(
    <>
      <path d="M4 20 4 8 20 8 20 20" />
      {dot(8, 13.5)}
      {dot(12, 13.5)}
      {dot(16, 13.5)}
    </>
  ),

  /* --- birdie, and the rest --- */

  // The specimen's head. The only Tier C glyph with interior negative space,
  // and the only one with character motion.
  birdie: make(
    <path d={BIRDIE_D} fillRule="evenodd" fill="currentColor" stroke="transparent" />,
    { className: 'flock-icon--birdie' }
  ),

  activity: make(
    <>
      <path d={gull(6, 15, 3)} />
      <path d={gull(12, 12, 3)} />
      <path d={gull(18, 15, 3)} />
    </>
  ),

  alertCircle: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M12 6.5 12 13" />
      {dot(12, 16.5)}
    </>
  ),

  arrowRight: make(
    <>
      <path d="M4 12 20 12" />
      <path d="M14 6 20 12 14 18" />
    </>
  ),

  award: make(
    <>
      <path d={ring(12, 9, 7)} />
      <path d="M8 15 8 22 12 18 16 22 16 15" />
    </>
  ),

  barChart: make(<path d="M5 20 5 14M12 20 12 6M19 20 19 10" />),

  beer: make(MUG),

  bell: make(
    <>
      <path d="M6 17 6 11A6 6 0 0 1 18 11L18 17" />
      <path d="M10 20 14 20" />
    </>
  ),

  briefcase: make(
    <>
      <path d="M3 20 3 8 21 8 21 20" />
      <path d="M9 8 9 5 15 5 15 8" />
    </>
  ),

  building: make(
    <>
      <path d="M5 20 5 4 19 4 19 20" />
      <path d="M5 9 19 9M5 14 19 14" />
      <path d="M10 20 10 16 14 16 14 20" />
    </>
  ),

  camera: make(
    <>
      <path d="M3 20 3 7 21 7 21 20" />
      <circle cx="12" cy="13.5" r="5" />
      <path d="M8 7 11 4 13 4 16 7" />
    </>
  ),

  chat: make(CHAT),

  checkCircle: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M7.5 12.5 10.5 15.5 16.5 9.5" />
    </>
  ),

  checkDouble: make(
    <>
      <path d="M2 12.5 6.5 17 15 8.5" />
      <path d="M11 17 19.5 8.5" />
    </>,
    { size: 14 }
  ),

  chevronUp: make(CHEVRON, { style: ROT(0) }),
  chevronRight: make(CHEVRON, { style: ROT(90) }),
  chevronDown: make(CHEVRON, { style: ROT(180) }),

  cloud: make(<path d="M4 18 4 14A4 4 0 0 1 9 10A5 5 0 0 1 15 9A5 5 0 0 1 20 14L20 18" />, {
    color: '#9ca3af',
  }),

  cocktail: make(STEM, { color: '#1a3a5c' }),

  coffee: make(MUG),

  compass: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M7.5 16.5 16.5 7.5" />
      {dot(12, 12)}
    </>
  ),

  creditCard: make(
    <>
      <path d="M2 19 2 6 22 6 22 19" />
      <path d="M2 10 22 10" />
    </>
  ),

  crosshair: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M12 3 12 21" />
      <path d="M3 12 21 12" />
    </>
  ),

  // The S is built from horizontals and verticals only — a geometric dollar.
  dollar: make(
    <>
      <path d="M16 8 8 8 8 12 16 12 16 16 8 16" />
      <path d="M12 5.5 12 18.5" />
    </>
  ),

  doorOpen: make(
    <>
      <path d="M4 20 4 4 16 4 16 20" />
      {dot(13, 12)}
    </>
  ),

  download: make(
    <>
      <path d="M12 4 12 19" />
      <path d="M7 14 12 19 17 14" />
    </>
  ),

  edit: make(
    <>
      <path d="M4 20 4 16 16 4 20 8 8 20Z" />
      <path d="M13 7 17 11" />
    </>
  ),

  externalLink: make(
    <>
      <path d="M10 14 20 4" />
      <path d="M13 4 20 4 20 11" />
    </>
  ),

  eye: make(
    <>
      <path d="M3 12A11 11 0 0 1 21 12A11 11 0 0 1 3 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),

  fileText: make(
    <>
      <path d="M5 20 5 3 15 3 19 7 19 20" />
      <path d="M15 3 15 7 19 7" />
      <path d="M8 12 16 12" />
      <path d="M8 16 16 16" />
    </>
  ),

  filter: make(<path d="M3 5 21 5 14 12 14 20 10 20 10 12Z" />),

  flame: make(<path d="M12 2 5 9A7 7 0 0 0 19 9Z" fill="currentColor" stroke="transparent" />, {
    color: '#F59E0B',
  }),

  gamepad: make(
    <>
      <path d="M3 18 3 7 21 7 21 18" />
      <path d="M7 11 7 15M5 13 9 13" />
      <circle cx="16.5" cy="12.5" r="1.5" />
    </>
  ),

  gift: make(
    <>
      <path d="M4 20 4 10 20 10 20 20" />
      <path d="M12 10 12 20" />
      <path d="M8 6 12 10 16 6" />
    </>
  ),

  globe: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M3 12 21 12" />
      <path d="M12 3A5 9 0 0 0 12 21A5 9 0 0 0 12 3" />
    </>
  ),

  gripVertical: make(<path d="M8 8 16 8M8 12 16 12M8 16 16 16" />),

  heart: make(<path d="M12 20 4 12A5 5 0 0 1 12 7A5 5 0 0 1 20 12Z" />),

  home: make(
    <>
      <path d="M3 11 12 2 21 11" />
      <path d="M5 20 5 9M19 20 19 9" />
      <path d="M10 20 10 15 14 15 14 20" />
    </>
  ),

  image: make(
    <>
      <path d="M3 20 3 4 21 4 21 20" />
      <circle cx="8" cy="9" r="3" />
      <path d="M4 18 10 12 14 16 20 10" />
    </>
  ),

  laugh: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M8 14A5 5 0 0 0 16 14" />
      {dot(9, 10)}
      {dot(15, 10)}
    </>
  ),

  layers: make(
    <>
      <path d="M4 20 4 12 20 12 20 20" />
      <path d="M6 9 18 9" />
      <path d="M8 6 16 6" />
    </>
  ),

  lock: make(
    <>
      <path d="M5 20 5 11 19 11 19 20" />
      <path d="M8 11 8 7A4 4 0 0 1 16 7L16 11" />
    </>
  ),

  logout: make(
    <>
      <path d="M4 20 4 4 12 4 12 20" />
      <path d="M10 12 21 12" />
      <path d="M16 7 21 12 16 17" />
    </>
  ),

  mail: make(
    <>
      <path d="M4 19 4 6 20 6 20 19" />
      <path d="M4 6 12 14 20 6" />
    </>
  ),

  map: make(
    <>
      <path d="M4 20 4 6 20 6 20 20" />
      <path d="M7 17 12 12 12 9 17 9" />
    </>
  ),

  messageSquare: make(CHAT),

  mic: make(
    <>
      <path d="M9 13 9 6A3 3 0 0 1 15 6L15 13A3 3 0 0 1 9 13Z" />
      <path d="M5 13A7 7 0 0 0 19 13" />
      <path d="M12 20 12 22" />
    </>
  ),

  minus: make(<path d="M4 12 20 12" />),

  moon: make(<path d="M16 3A9 9 0 1 0 16 21A11 11 0 0 1 16 3Z" />),

  moreVertical: make(
    <>
      {dot(12, 5)}
      {dot(12, 12)}
      {dot(12, 19)}
    </>
  ),

  music: make(
    <>
      <path d="M9 17 9 5 19 5 19 15" />
      <circle cx="6" cy="17" r="3" />
      <circle cx="16" cy="15" r="3" />
    </>,
    { color: '#2d5a87' }
  ),

  palette: make(
    <>
      <path d={ring(12, 12, 9)} />
      <circle cx="9" cy="9" r="1.5" />
      <circle cx="15" cy="9" r="1.5" />
      <circle cx="9" cy="15" r="1.5" />
    </>
  ),

  party: make(PARTY),
  partyPopper: make(PARTY),

  phone: make(
    <>
      <path d="M7 20 7 3 17 3 17 20" />
      <path d="M10 6 14 6" />
    </>
  ),

  pieChart: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M12 12 12 3" />
      <path d="M12 12 18.5 18.5" />
    </>
  ),

  // pin / pinFilled — one path, two renderings.
  pin: make(<path d={PIN_D} fill="transparent" stroke="currentColor" />),
  pinFilled: make(<path d={PIN_D} fill="currentColor" stroke="transparent" />),

  pizza: make(
    <>
      <path d="M12 3 4 11A11 11 0 0 0 20 11Z" />
      {dot(12, 8)}
      {dot(9.5, 12.5)}
      {dot(14.5, 12.5)}
    </>,
    { color: '#F97316' }
  ),

  // The ring's own gap is where the loop restarts; the arrowhead sits on it.
  repeat: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M16 4 19.5 7.5 16 11" />
    </>
  ),

  reply: make(
    <>
      <path d="M9 7 4 12 9 17" />
      <path d="M4 12 20 12 20 19" />
    </>,
    { size: 16 }
  ),

  robot: make(
    <path d={BIRDIE_D} fillRule="evenodd" fill="currentColor" stroke="transparent" />,
    { className: 'flock-icon--birdie' }
  ),

  send: make(<path d="M6 4 14 12 6 20Z" fill="currentColor" stroke="transparent" />),

  settings: make(
    <>
      <path d="M4 9 20 9M4 15 20 15" />
      <circle cx="9" cy="9" r="2" />
      <circle cx="15" cy="15" r="2" />
    </>
  ),

  share: make(
    <>
      <path d="M12 19 12 5" />
      <path d="M7 10 12 5 17 10" />
      <path d="M5 15 5 21M19 15 19 21" />
    </>
  ),

  shield: make(<path d="M4 4 20 4 20 13 12 21 4 13Z" />),

  sparkles: make(
    <>
      <path d={gull(12, 15, 5)} />
      <path d={gull(13, 8, 3)} />
    </>
  ),

  sports: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d="M4.5 8 19.5 8M4.5 16 19.5 16" />
    </>,
    { color: '#22C55E' }
  ),

  sun: make(
    <>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2 12 5M19 12 22 12M12 19 12 22M2 12 5 12" />
    </>,
    { color: '#F59E0B' }
  ),

  tag: make(
    <>
      <path d="M3 3 11 3 21 13 13 21 3 11Z" />
      <circle cx="7" cy="7" r="1.5" />
    </>
  ),

  target: make(
    <>
      <path d={ring(12, 12, 9)} />
      <path d={ring(12, 12, 7)} />
      <circle cx="12" cy="12" r="3" />
    </>
  ),

  thumbsUp: make(
    <>
      <path d="M9 20 9 10 20 10 20 20" />
      <path d="M9 10 9 6 13 2 13 10" />
    </>
  ),

  trash: make(
    <>
      <path d="M3 6 21 6" />
      <path d="M9 6 9 3 15 3 15 6" />
      <path d="M6 6 6 20M18 6 18 20" />
    </>
  ),

  trendingUp: make(
    <>
      <path d="M3 18 10 11 14 15 21 8" />
      <path d="M15 8 21 8 21 14" />
    </>
  ),

  upload: make(
    <>
      <path d="M12 20 12 5" />
      <path d="M7 10 12 5 17 10" />
    </>
  ),

  user: make(
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20A8 8 0 0 1 20 20" />
    </>
  ),

  userPlus: make(
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 20A7 7 0 0 1 16 20" />
      <path d="M18 6 18 12M15 9 21 9" />
    </>
  ),

  vote: make(
    <>
      <path d="M4 20 4 11 20 11 20 20" />
      <path d="M8 15 11 18 16 13" />
    </>
  ),

  // Two birds at two distances: a greeting from across the field.
  wave: make(
    <>
      <path d={gull(8, 13, 4)} />
      <path d={gull(17, 10, 3)} />
    </>
  ),

  wine: make(STEM),

  // A lightning bolt cannot be built from 0/45/90 without collapsing on
  // itself, so zap is the same idea drawn as one 45deg zigzag.
  zap: make(<path d="M18 3 9 12 15 12 6 21" />, { color: '#F59E0B' }),
};

export default Icons;
export { Icons, sw, ring, gull };
